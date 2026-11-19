// The routines the owner defines, as data: the settings fields, the validation that refuses a bad routine when it is
// saved (with a sentence), and the parsed form the module runs. Pure code: nothing here touches the host.
import { PHRASE_LIMITS, phraseProblems, phraseWords, Setting } from "@pva/core"
import { isLine } from "@pva/module-contracts"
import { Exit, Schema } from "effect"

/** The most routines: one phrase-command action each, and an instance may have at most 16 actions with phrases. */
export const MAX_ROUTINES = PHRASE_LIMITS.actionsPerModule
/** Phrases of one routine in one language: the host's bound for one action. */
export const MAX_PHRASES = PHRASE_LIMITS.phrasesPerAction
/** Steps of one routine. */
export const MAX_STEPS = 20
/** Characters of a routine's name. */
export const NAME_CHARS = 40
/** Characters of the steps as JSON (one records text field). */
export const STEPS_CHARS = 2_000
/** Characters of a `say` step: an announcement's bound (docs/NOTIFICATIONS.md, `MAX_SPEECH_CHARS`). */
export const SAY_CHARS = 300
/** Parameters of one `call` step, and the characters of one text value. */
export const MAX_PARAMS = 8
export const PARAM_TEXT_CHARS = 200

/** `<moduleId>.<actionId>`, as an action's identity is written (docs/MODULES.md §10). */
const CALL_ID = /^([a-z0-9][a-z0-9-]{0,63})\.([a-z][a-z0-9_]{0,39})$/
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

// ---------------------------------------------------------------------------------------------------------------------
// Steps

const line = (max: number, what: string) => Schema.String.check(Schema.makeFilter((t: string) => (isLine(t, max) && t.trim() !== "") || `${what}: one line of 1 to ${max} characters`))

const SayStep = Schema.Struct({ say: line(SAY_CHARS, "say") })
const ParamValue = Schema.Union([line(PARAM_TEXT_CHARS, "a text value"), Schema.Finite, Schema.Boolean])
const CallStep = Schema.Struct({
  call: Schema.String.check(Schema.makeFilter((t: string) => CALL_ID.test(t) || "call: an action written module.action, such as lamp.switch")),
  params: Schema.optionalKey(
    Schema.Record(Schema.String.check(Schema.makeFilter((k: string) => PARAM_NAME.test(k) || "a parameter name is a letter, then letters, digits or _")), ParamValue).check(
      Schema.makeFilter((r: Readonly<Record<string, unknown>>) => Object.keys(r).length <= MAX_PARAMS || `params: at most ${MAX_PARAMS}`)
    )
  )
})
const StopStep = Schema.Struct({ stop_if_failed: Schema.Literal(true) })

const decodeSay = Schema.decodeUnknownExit(SayStep)
const decodeCall = Schema.decodeUnknownExit(CallStep)
const decodeStop = Schema.decodeUnknownExit(StopStep)

/** A text in both languages (the template's), or the owner's own text, said as written. */
export type StepText = string | { readonly en: string; readonly nl: string }

/** One step as the module runs it. */
export type Step =
  | { readonly kind: "say"; readonly text: StepText }
  | { readonly kind: "call"; readonly moduleId: string; readonly actionId: string; readonly params: Readonly<Record<string, string | number | boolean>> }
  | { readonly kind: "stop_if_failed" }

const KEYS = ["say", "call", "stop_if_failed"] as const

/** What a step of each kind must look like: said when one does not decode (the value itself is never quoted). */
const HINT = {
  say: `"say" is one line of 1 to ${SAY_CHARS} characters`,
  call: `"call" is an action written module.action (such as lamp.switch), and "params" at most ${MAX_PARAMS} values named with letters, digits or _, each one line of text up to ${PARAM_TEXT_CHARS} characters, a number, or true or false`
} as const

/** One step of the owner's JSON, or why it is not one (without quoting the value). */
const stepOf = (raw: unknown, n: number): Step | string => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `step ${n} is not an object such as { "say": "…" }`
  const keys = Object.keys(raw)
  const kinds = keys.filter((k): k is (typeof KEYS)[number] => (KEYS as ReadonlyArray<string>).includes(k))
  if (kinds.length !== 1) return `step ${n} has exactly one of "say", "call" or "stop_if_failed"`
  const kind = kinds[0]!
  const allowed = kind === "call" ? ["call", "params"] : [kind]
  const extra = keys.find((k) => !allowed.includes(k))
  if (extra !== undefined) return `step ${n} has a key it does not use (only ${allowed.map((k) => `"${k}"`).join(" and ")})`
  if (kind === "say") {
    const exit = decodeSay(raw)
    return Exit.isSuccess(exit) ? { kind: "say", text: exit.value.say } : `step ${n}: ${HINT.say}`
  }
  if (kind === "stop_if_failed") {
    const exit = decodeStop(raw)
    if (Exit.isFailure(exit)) return `step ${n}: "stop_if_failed" is true`
    return n === 1 ? `step 1 cannot be "stop_if_failed": it stops after a step that did not work` : { kind: "stop_if_failed" }
  }
  const exit = decodeCall(raw)
  if (Exit.isFailure(exit)) return `step ${n}: ${HINT.call}`
  const [, moduleId, actionId] = CALL_ID.exec(exit.value.call)!
  if (moduleId === "routines") return `step ${n}: a routine does not start other routines`
  return { kind: "call", moduleId: moduleId!, actionId: actionId!, params: exit.value.params ?? {} }
}

/** The steps written as JSON, or why they cannot be run: what the owner reads under the field when a save is refused. */
export const parseSteps = (text: string): ReadonlyArray<Step> | string => {
  if (text.trim() === "") return "Write at least one step, such as [{ \"say\": \"Good night.\" }]"
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return "Steps are JSON: a list such as [{ \"say\": \"Good night.\" }, { \"call\": \"lamp.switch\", \"params\": { \"to\": \"off\" } }]"
  }
  if (!Array.isArray(raw) || raw.length === 0) return "Steps are a list of 1 to 20 steps"
  if (raw.length > MAX_STEPS) return `At most ${MAX_STEPS} steps`
  const steps: Array<Step> = []
  for (const [i, s] of raw.entries()) {
    const step = stepOf(s, i + 1)
    if (typeof step === "string") return step[0]!.toUpperCase() + step.slice(1)
    steps.push(step)
  }
  return steps
}

// ---------------------------------------------------------------------------------------------------------------------
// Names and phrases

/** A name or a phrase as the matcher hears it: its words, normalised (case, accents, punctuation do not count). */
export const wordsKey = (text: string): string => phraseWords(text).map((w) => w.norm).join(" ")

/** Words dropped before a spoken name is matched ("run the bedtime routine" → "bedtime"). */
const FILLERS = new Set(["the", "a", "an", "my", "our", "routine", "de", "het", "een", "mijn", "onze", "routine", "please", "graag"])

/** A name's words without fillers, for matching what someone said. */
export const nameWords = (text: string): ReadonlyArray<string> => phraseWords(text).map((w) => w.norm).filter((w) => !FILLERS.has(w))

/** The action id of a routine (`routines.<id>`): `r_` and its name's words, ASCII only. */
const slugOf = (key: string): string => {
  const slug = key.replace(/[^a-z0-9 ]/g, "").trim().replace(/\s+/g, "_").slice(0, 38).replace(/_+$/, "")
  return slug === "" ? "r_routine" : `r_${slug}`
}

// ---------------------------------------------------------------------------------------------------------------------
// The settings

/** One routine as the owner saved it (the records field's item). */
export interface SavedRoutine {
  readonly name: string
  readonly phrasesEn: ReadonlyArray<string>
  readonly phrasesNl: ReadonlyArray<string>
  readonly steps: string
}

/** Why a phrase may not start a routine, as the host would refuse it at the start (empty: it may). */
const phraseProblem = (language: "en" | "nl", phrase: string): string | undefined => {
  const [problem] = phraseProblems("routines", [{ id: "check", params: {}, phrases: { [language]: [phrase] } }])
  if (problem === undefined) return undefined
  const at = problem.indexOf(`(${language}): `)
  return at < 0 ? problem : problem.slice(at + language.length + 4)
}

/**
 * Everything wrong with the routines as a whole, or `undefined`: names that are empty or the same, phrases the host
 * would refuse (reserved for its own controls, too long, a slot), and a phrase that two routines share (the host would
 * leave both out). Said to the owner when the save is refused; the module never starts with such a list.
 */
export const routinesProblem = (list: ReadonlyArray<SavedRoutine>): string | undefined => {
  const names = new Map<string, string>()
  const phrases = new Map<string, string>()
  for (const [i, r] of list.entries()) {
    const key = wordsKey(r.name)
    if (key === "") return `Routine ${i + 1} needs a name`
    const same = names.get(key)
    if (same !== undefined) return `Two routines are called "${same}"; give each its own name`
    names.set(key, r.name)
    for (const [language, own] of [["en", r.phrasesEn], ["nl", r.phrasesNl]] as const) {
      for (const phrase of own) {
        const problem = phraseProblem(language, phrase)
        const which = language === "en" ? "English" : "Dutch"
        if (problem !== undefined) return `Routine "${r.name}", ${which} phrase "${phrase}": ${problem}`
        const shape = `${language}:${wordsKey(phrase)}`
        const owner = phrases.get(shape)
        if (owner !== undefined) {
          return owner === r.name
            ? `Routine "${r.name}" has the ${which} phrase "${phrase}" twice`
            : `The ${which} phrase "${phrase}" is in "${owner}" and "${r.name}"; a phrase starts one routine`
        }
        phrases.set(shape, r.name)
      }
    }
    const steps = parseSteps(r.steps)
    if (typeof steps === "string") return `Routine "${r.name}": ${steps}`
  }
  return undefined
}

const explainSteps = (text: string): string | undefined => {
  const steps = parseSteps(text)
  return typeof steps === "string" ? steps : undefined
}

export const settings = {
  routines: Setting.records({
    label: "Routines",
    description:
      `At most ${MAX_ROUTINES}. Each has a name, up to ${MAX_PHRASES} phrases per language that start it after the wake phrase with no model, and its steps as JSON: ` +
      "{ \"say\": \"text\" } speaks on the device that started it, { \"call\": \"module.action\", \"params\": { … } } runs an action of that assistant, " +
      "{ \"stop_if_failed\": true } stops when the step before did not work. A routine with a step the assistant may not do is refused as a whole.",
    itemLabel: "routine",
    titleKey: "name",
    maxItems: MAX_ROUTINES,
    orderable: true,
    item: {
      name: Setting.text({ label: "Name", maxLength: NAME_CHARS, check: (t) => (isLine(t, NAME_CHARS) && t.trim() !== "" ? undefined : "One line of 1 to 40 characters") }),
      phrasesEn: Setting.textList({ label: "English phrases", description: "Said after the wake phrase, word for word.", maxItems: MAX_PHRASES, itemMaxLength: PHRASE_LIMITS.charsPerPhrase }),
      phrasesNl: Setting.textList({ label: "Dutch phrases", description: "Used when the household's language is Dutch.", maxItems: MAX_PHRASES, itemMaxLength: PHRASE_LIMITS.charsPerPhrase }),
      steps: Setting.text({ label: "Steps (JSON)", multiline: true, maxLength: STEPS_CHARS, check: explainSteps })
    },
    check: routinesProblem
  }),
  goodMorning: Setting.boolean({
    label: "Good morning routine",
    description:
      "Adds the template \"Good morning\" (\"goedemorgen\"): a greeting, the time (clock) and the weather. Left out while 16 routines of yours are set, or one of yours has its name or phrase.",
    default: false
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// The routines the module runs

export interface Routine {
  /** Its name's words: unique among the routines. */
  readonly key: string
  /** Its action's id (`routines.<actionId>`). */
  readonly actionId: string
  readonly name: StepText
  readonly phrases: { readonly en: ReadonlyArray<string>; readonly nl: ReadonlyArray<string> }
  readonly steps: ReadonlyArray<Step>
  readonly template: boolean
}

/** The template the owner can add (settings › Good morning routine). Copy its steps into a routine of your own to change it. */
export const GOOD_MORNING = {
  name: { en: "Good morning", nl: "Goedemorgen" },
  phrases: { en: ["good morning"], nl: ["goedemorgen"] },
  steps: [
    { kind: "say", text: { en: "Good morning!", nl: "Goedemorgen!" } },
    { kind: "call", moduleId: "clock", actionId: "time_now", params: {} },
    { kind: "call", moduleId: "weather", actionId: "today", params: {} }
  ] satisfies ReadonlyArray<Step>
} as const

/** A name in the household's language. */
export const nameIn = (name: StepText, language: "en" | "nl"): string => (typeof name === "string" ? name : name[language])

/** The routines of saved settings, in their order, with the template last when it is on and fits. Saved values were checked. */
export const routinesOf = (values: { readonly routines: ReadonlyArray<SavedRoutine>; readonly goodMorning: boolean }): ReadonlyArray<Routine> => {
  const ids = new Set<string>()
  const out: Array<Routine> = []
  const idFor = (key: string) => {
    const base = slugOf(key)
    let id = base
    for (let n = 2; ids.has(id); n++) id = `${base.slice(0, 36)}_${n}`
    ids.add(id)
    return id
  }
  for (const r of values.routines) {
    const steps = parseSteps(r.steps)
    // A saved list was checked when it was saved; one that does not parse is never run.
    if (typeof steps === "string") continue
    const key = wordsKey(r.name)
    out.push({ key, actionId: idFor(key), name: r.name, phrases: { en: r.phrasesEn, nl: r.phrasesNl }, steps, template: false })
  }
  if (values.goodMorning && out.length < MAX_ROUTINES) {
    const keys = new Set(out.map((r) => r.key))
    const shapes = new Set(out.flatMap((r) => [...r.phrases.en.map((p) => `en:${wordsKey(p)}`), ...r.phrases.nl.map((p) => `nl:${wordsKey(p)}`)]))
    const clash = [GOOD_MORNING.name.en, GOOD_MORNING.name.nl].some((n) => keys.has(wordsKey(n))) ||
      GOOD_MORNING.phrases.en.some((p) => shapes.has(`en:${wordsKey(p)}`)) || GOOD_MORNING.phrases.nl.some((p) => shapes.has(`nl:${wordsKey(p)}`))
    if (!clash) {
      out.push({ key: wordsKey(GOOD_MORNING.name.en), actionId: idFor(wordsKey(GOOD_MORNING.name.en)), name: GOOD_MORNING.name, phrases: GOOD_MORNING.phrases, steps: GOOD_MORNING.steps, template: true })
    }
  }
  return out
}

/** Which routines a spoken name means: one, several (ask), or none. Whole words, fillers dropped; an exact name wins. */
export const findRoutine = (routines: ReadonlyArray<Routine>, spoken: string, language: "en" | "nl"): { readonly kind: "found"; readonly routine: Routine } | { readonly kind: "ambiguous"; readonly routines: ReadonlyArray<Routine> } | { readonly kind: "none" } => {
  const said = nameWords(spoken)
  if (said.length === 0) return { kind: "none" }
  const namesOf = (r: Routine) => (typeof r.name === "string" ? [r.name] : [r.name.en, r.name.nl])
  const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((w, i) => w === b[i])
  const exact = routines.filter((r) =>
    namesOf(r).some((n) => same(nameWords(n), said)) || r.phrases[language].some((p) => same(nameWords(p), said))
  )
  if (exact.length === 1) return { kind: "found", routine: exact[0]! }
  if (exact.length > 1) return { kind: "ambiguous", routines: exact }
  const contains = (whole: ReadonlyArray<string>, part: ReadonlyArray<string>) => part.length > 0 && part.every((w) => whole.includes(w))
  const partial = routines.filter((r) => namesOf(r).some((n) => contains(nameWords(n), said) || contains(said, nameWords(n))))
  if (partial.length === 1) return { kind: "found", routine: partial[0]! }
  if (partial.length > 1) return { kind: "ambiguous", routines: partial }
  return { kind: "none" }
}
