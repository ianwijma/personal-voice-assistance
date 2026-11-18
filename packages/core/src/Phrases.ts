import { type ActionParam, type ActionParams, paramOptions, type RegisteredAction, resolveOption } from "./Actions.ts"
import { type Word, words } from "./TextMatching.ts"
import { readUtterance } from "./Utterance.ts"
import { numericSpans, parseValues, unitFits } from "./ValueParsing.ts"

/**
 * Phrase commands (docs/MODULES-PLAN.md §4 P7, first version; docs/PHRASES.md): a closed set of phrases per language,
 * with optional typed slots, that run without the language model. This file is the pure part: the host's essential
 * controls and their reserved phrases, the declaration check (`phraseProblems`, run when a module starts), the
 * per-assistant set (`buildCommandSet`) and the matcher (`matchCommand`, `matchRinging`). No Effect, no I/O, no clock:
 * synchronous and bounded (every bound is in `PHRASE_LIMITS`), so it can sit on the path of every final transcript.
 *
 * **Matching is exact on words.** A phrase and an utterance are compared as their normalised words (`words` in
 * `TextMatching.ts`, the normalisation wake phrases use: case, accents, apostrophes and punctuation do not count;
 * `@pva/language` exports no normaliser of its own, its tokenizer is internal). There is no fuzzy matching of a
 * phrase's words in this version: no edit distance, no sounds-alike, no skipped fillers, no stemming. A slot is read by
 * the existing parser of its `Param` kind (`resolveOption` for a choice or a dynamic list, which tolerates what it
 * always did; core's number and duration reader; the words as said for text), and a slot that does not read means the
 * phrase does not match. The longest phrase (most literal words) wins.
 */

/** The two languages a phrase is declared in (the household's language, `HOME_LANGUAGE`, picks which set is matched). */
export type PhraseLanguage = "en" | "nl"

export const PHRASE_LANGUAGES: ReadonlyArray<PhraseLanguage> = ["en", "nl"]

/** A module's phrases, per language (`ActionDefinition.phrases`). */
export type ActionPhrases = { readonly [L in PhraseLanguage]?: ReadonlyArray<string> }

/**
 * Every bound of a phrase command. At each one a declaration is refused when the module starts (the module is down,
 * the Health page names it and why); `phrasesPerAssistant` is judged per assistant (the modules past it are left out
 * of that assistant's set, whole, and named on the Health page). Nothing is dropped silently.
 */
export const PHRASE_LIMITS = {
  /** Phrases of one action in one language. */
  phrasesPerAction: 8,
  /** Actions with phrases in one module instance. */
  actionsPerModule: 16,
  /** Words of a phrase, a slot counting as one. */
  wordsPerPhrase: 8,
  /** Characters of a phrase as declared. */
  charsPerPhrase: 80,
  /** Slots of a phrase. */
  slotsPerPhrase: 2,
  /** Module phrases in one assistant's set, per language (the host's controls come on top). */
  phrasesPerAssistant: 256,
  /** An utterance longer than this (in words) is never matched. */
  utteranceWords: 24,
  /** An utterance longer than this (in characters) is never matched. */
  utteranceChars: 300,
  /** Words one slot may take (a text slot: its `maxWords`, at most this). */
  slotWords: 8,
  /**
   * Slot readings one utterance may cost over every phrase of the set (a reading runs a slot's parser on words whose
   * alignment already covers the whole utterance). Ordinary sentences need a few; once spent, no further phrase can
   * match that utterance (it goes on as not taken), so a sentence built to make many alignments costs a bounded time.
   */
  slotReads: 64
} as const

/** The longest spoken answer of a phrase command, in UTF-16 units, cut at the module's page boundary. */
export const PHRASE_ANSWER_CHARS = 300

/** The host's essential controls (§2 row 17): every assistant on every device has them, and no module may register them. */
export type HostControl = "stop" | "never-mind" | "repeat" | "louder" | "quieter"

export const HOST_CONTROLS: ReadonlyArray<HostControl> = ["stop", "never-mind", "repeat", "louder", "quieter"]

/**
 * The host's phrases, with their common variants, per language. Reserved: a module phrase made of the same words (in
 * that language) is refused when the module starts. While something rings, the `stop` phrases are also accepted
 * without the wake phrase (the ringing window).
 */
export const HOST_CONTROL_PHRASES: Readonly<Record<PhraseLanguage, Readonly<Record<HostControl, ReadonlyArray<string>>>>> = {
  en: {
    stop: ["stop", "stop it", "stop that", "stop talking", "please stop", "stop please", "be quiet", "quiet", "silence", "shush", "hush"],
    "never-mind": ["never mind", "nevermind", "forget it", "forget about it", "cancel", "cancel that"],
    repeat: ["repeat", "repeat that", "say that again", "say again", "say it again", "come again", "pardon", "what did you say"],
    louder: ["louder", "louder please", "a bit louder", "speak up", "volume up", "turn it up"],
    quieter: ["quieter", "quieter please", "a bit quieter", "softer", "volume down", "turn it down"]
  },
  nl: {
    stop: ["stop", "stoppen", "stop maar", "hou op", "houd op", "stil", "wees stil", "stil maar", "sst"],
    "never-mind": ["laat maar", "laat maar zitten", "laat ook maar", "vergeet het", "annuleer", "annuleren"],
    repeat: ["herhaal", "herhaal dat", "herhaal dat nog eens", "zeg het nog eens", "nog een keer", "wat zei je", "pardon"],
    louder: ["harder", "harder graag", "wat harder", "luider", "volume omhoog", "zet het harder"],
    quieter: ["zachter", "zachter graag", "wat zachter", "stiller", "volume omlaag", "zet het zachter"]
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Declarations

const SLOT = /^\{([A-Za-z][A-Za-z0-9_]{0,39})\}$/

/** One part of a phrase: a word (normalised), or a slot naming a parameter of the action. */
export type PhrasePart = string | { readonly slot: string; readonly param: ActionParam }

/** Whose a compiled phrase is. */
export type PhraseOwner =
  | { readonly kind: "control"; readonly control: HostControl }
  | { readonly kind: "action"; readonly action: RegisteredAction }

export interface CompiledPhrase {
  readonly owner: PhraseOwner
  /** As declared. */
  readonly text: string
  /** Its words with `{}` for each slot ("set a timer for {}"): two phrases of one shape are a duplicate. */
  readonly shape: string
  readonly parts: ReadonlyArray<PhrasePart>
  /** Literal words: the longer phrase wins. */
  readonly literals: number
}

/** The words of a phrase as written, or why it is not a phrase. */
const parsePhrase = (text: string, params: ActionParams | undefined): { readonly parts: ReadonlyArray<PhrasePart> } | { readonly problem: string } => {
  if (typeof text !== "string") return { problem: "a phrase is text" }
  if (text.trim().length === 0) return { problem: "a phrase is empty" }
  if (text.length > PHRASE_LIMITS.charsPerPhrase) return { problem: `a phrase has at most ${PHRASE_LIMITS.charsPerPhrase} characters` }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) return { problem: "a phrase is one line, without control characters" }
  const parts: Array<PhrasePart> = []
  for (const token of text.trim().split(/\s+/)) {
    const slot = SLOT.exec(token)
    if (slot !== null) {
      const name = slot[1]!
      const param = params === undefined ? undefined : Object.hasOwn(params, name) ? params[name] : undefined
      if (param === undefined) return { problem: `the slot {${name}} names no parameter of the action` }
      if (param.kind === "boolean") return { problem: `the slot {${name}} is a yes/no parameter, which a phrase cannot fill` }
      parts.push({ slot: name, param })
      continue
    }
    if (token.includes("{") || token.includes("}")) return { problem: `"${token}": a slot is a whole word, written {name}` }
    for (const w of words(token)) parts.push(w.norm)
  }
  return { parts }
}

const shapeOf = (parts: ReadonlyArray<PhrasePart>) => parts.map((p) => (typeof p === "string" ? p : "{}")).join(" ")

/** The reserved shapes per language: the host's phrases, normalised. */
const RESERVED: Readonly<Record<PhraseLanguage, ReadonlyMap<string, HostControl>>> = {
  en: new Map(HOST_CONTROLS.flatMap((c) => HOST_CONTROL_PHRASES.en[c].map((p) => [words(p).map((w) => w.norm).join(" "), c] as const))),
  nl: new Map(HOST_CONTROLS.flatMap((c) => HOST_CONTROL_PHRASES.nl[c].map((p) => [words(p).map((w) => w.norm).join(" "), c] as const)))
}

/** The host control a phrase's words are reserved for in `language`, if any. */
export const reservedFor = (language: PhraseLanguage, phrase: string): HostControl | undefined =>
  RESERVED[language].get(words(phrase).map((w) => w.norm).join(" "))

/** Why one phrase of an action may not be declared, or `undefined`. */
const phraseProblem = (language: PhraseLanguage, text: string, params: ActionParams): string | undefined => {
  const parsed = parsePhrase(text, params)
  if ("problem" in parsed) return parsed.problem
  const { parts } = parsed
  if (parts.length > PHRASE_LIMITS.wordsPerPhrase) return `a phrase has at most ${PHRASE_LIMITS.wordsPerPhrase} words (a slot is one)`
  const slots = parts.filter((p): p is Exclude<PhrasePart, string> => typeof p !== "string")
  if (slots.length === parts.length) return "a phrase needs at least one word that is not a slot"
  if (slots.length > PHRASE_LIMITS.slotsPerPhrase) return `a phrase has at most ${PHRASE_LIMITS.slotsPerPhrase} slots`
  if (new Set(slots.map((s) => s.slot)).size !== slots.length) return "a slot appears twice in one phrase"
  for (let i = 1; i < parts.length; i++) if (typeof parts[i] !== "string" && typeof parts[i - 1] !== "string") return "two slots need a word between them"
  for (const [name, param] of Object.entries(params)) {
    if (param.kind !== "boolean" && param.optional !== true && !slots.some((s) => s.slot === name)) return `the required parameter ${name} has no slot in it`
  }
  const reserved = RESERVED[language].get(shapeOf(parts))
  if (reserved !== undefined) return `it is one of the assistant's own "${HOST_CONTROL_PHRASES[language][reserved][0]}" phrases, which no module may use`
  return undefined
}

/**
 * Everything wrong with the phrases of a module instance's actions (empty: they may be declared). Run when the module
 * starts (a registration's check, `ModuleHost.ts`): any problem refuses the start, the module is down, and the Health
 * page names the action, the phrase and the bound.
 */
export const phraseProblems = (moduleId: string, actions: ReadonlyArray<{ readonly id: string; readonly params: ActionParams; readonly phrases?: ActionPhrases }>): ReadonlyArray<string> => {
  const out: Array<string> = []
  const withPhrases = actions.filter((a) => a.phrases !== undefined)
  if (withPhrases.length > PHRASE_LIMITS.actionsPerModule) {
    out.push(`${moduleId}: ${withPhrases.length} actions have phrases; at most ${PHRASE_LIMITS.actionsPerModule}`)
  }
  for (const a of withPhrases) {
    const phrases = a.phrases as unknown
    if (typeof phrases !== "object" || phrases === null || Array.isArray(phrases)) {
      out.push(`${moduleId}.${a.id}: phrases are given per language ({ en: [...], nl: [...] })`)
      continue
    }
    for (const [language, list] of Object.entries(phrases)) {
      if (language !== "en" && language !== "nl") {
        out.push(`${moduleId}.${a.id}: phrases in "${language}": only en and nl`)
        continue
      }
      if (!Array.isArray(list)) {
        out.push(`${moduleId}.${a.id}: the ${language} phrases are a list`)
        continue
      }
      if (list.length > PHRASE_LIMITS.phrasesPerAction) out.push(`${moduleId}.${a.id}: ${list.length} ${language} phrases; at most ${PHRASE_LIMITS.phrasesPerAction}`)
      const shapes = new Set<string>()
      for (const text of list.slice(0, PHRASE_LIMITS.phrasesPerAction + 1)) {
        const problem = phraseProblem(language, text, a.params)
        if (problem !== undefined) {
          out.push(`${moduleId}.${a.id}: "${String(text).slice(0, PHRASE_LIMITS.charsPerPhrase)}" (${language}): ${problem}`)
          continue
        }
        const parsed = parsePhrase(text, a.params) as { readonly parts: ReadonlyArray<PhrasePart> }
        const shape = shapeOf(parsed.parts)
        if (shapes.has(shape)) out.push(`${moduleId}.${a.id}: "${text}" (${language}) is given twice`)
        shapes.add(shape)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// One assistant's set

/** Two commands that cannot both be in one assistant's set, or modules past the bound: named on the Health page. */
export type PhraseConflict =
  | { readonly kind: "duplicate"; readonly language: PhraseLanguage; readonly shape: string; readonly actions: ReadonlyArray<string> }
  | { readonly kind: "over-bound"; readonly language: PhraseLanguage; readonly modules: ReadonlyArray<string> }

/** One assistant's phrase commands in one language: the host's controls, then the modules' phrases that may be matched. */
export interface CommandSet {
  readonly language: PhraseLanguage
  readonly phrases: ReadonlyArray<CompiledPhrase>
  /** What was left out of it, and why (for the Health page). */
  readonly conflicts: ReadonlyArray<PhraseConflict>
}

const hostPhrases: Readonly<Record<PhraseLanguage, ReadonlyArray<CompiledPhrase>>> = {
  en: compileControls("en"),
  nl: compileControls("nl")
}

function compileControls(language: PhraseLanguage): ReadonlyArray<CompiledPhrase> {
  return HOST_CONTROLS.flatMap((control) =>
    HOST_CONTROL_PHRASES[language][control].map((text): CompiledPhrase => {
      const parts = words(text).map((w) => w.norm)
      return { owner: { kind: "control", control }, text, shape: parts.join(" "), parts, literals: parts.length }
    })
  )
}

/** The host's controls alone (a `decide` target, whose assistant is not known yet; a device that answers nobody). */
export const hostCommandSet = (language: PhraseLanguage): CommandSet => ({ language, phrases: hostPhrases[language], conflicts: [] })

const actionName = (a: RegisteredAction) => a.id

/**
 * One assistant's set: the host's controls, then the phrases in `language` of `actions` (its modules' actions, in
 * catalog order, as its parts in the module snapshot hold them). Two phrases of one shape from different actions are
 * both left out (a conflict); a phrase of a host control's shape is left out (a module start refuses it already);
 * once `phrasesPerAssistant` module phrases are in, every further module is left out whole (a conflict naming them).
 * A declaration that is not valid (it would have refused the start) is skipped.
 */
export const buildCommandSet = (language: PhraseLanguage, actions: ReadonlyArray<RegisteredAction>): CommandSet => {
  const byModule = new Map<string, Array<CompiledPhrase>>()
  for (const action of actions) {
    const list = (action.definition.phrases as ActionPhrases | undefined)?.[language]
    if (!Array.isArray(list)) continue
    for (const text of list.slice(0, PHRASE_LIMITS.phrasesPerAction)) {
      if (phraseProblem(language, text, action.definition.params as ActionParams) !== undefined) continue
      const parsed = parsePhrase(text, action.definition.params as ActionParams) as { readonly parts: ReadonlyArray<PhrasePart> }
      const parts = parsed.parts
      const own = byModule.get(action.moduleId) ?? []
      byModule.set(action.moduleId, own)
      own.push({ owner: { kind: "action", action }, text, shape: shapeOf(parts), parts, literals: parts.filter((p) => typeof p === "string").length })
    }
  }
  const kept: Array<CompiledPhrase> = []
  const over: Array<string> = []
  for (const [moduleId, list] of byModule) {
    if (over.length > 0 || kept.length + list.length > PHRASE_LIMITS.phrasesPerAssistant) over.push(moduleId)
    else kept.push(...list)
  }
  const byShape = new Map<string, Array<CompiledPhrase>>()
  for (const p of kept) byShape.set(p.shape, [...(byShape.get(p.shape) ?? []), p])
  const conflicts: Array<PhraseConflict> = []
  const phrases: Array<CompiledPhrase> = [...hostPhrases[language]]
  for (const [shape, list] of byShape) {
    const owners = [...new Set(list.map((p) => (p.owner.kind === "action" ? actionName(p.owner.action) : "")))]
    if (RESERVED[language].has(shape)) continue
    if (owners.length > 1) {
      conflicts.push({ kind: "duplicate", language, shape, actions: owners })
      continue
    }
    phrases.push(list[0]!)
  }
  if (over.length > 0) conflicts.push({ kind: "over-bound", language, modules: over })
  return { language, phrases, conflicts }
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching

/** What an utterance matched in a set. */
export type PhraseMatch =
  | { readonly kind: "control"; readonly control: HostControl; readonly phrase: string }
  | { readonly kind: "command"; readonly action: RegisteredAction; readonly values: Readonly<Record<string, unknown>>; readonly phrase: string }

/** A slot's words, read by its parameter kind's parser; `undefined`: they do not read as a value of it. */
const readSlot = (param: ActionParam, text: string, count: number): unknown => {
  switch (param.kind) {
    case "choice":
    case "dynamic": {
      let options
      try {
        // A dynamic list is the module's own synchronous cache; one that throws matches nothing.
        options = paramOptions(param)
      } catch {
        return undefined
      }
      return resolveOption(options, text)?.value
    }
    case "number":
    case "duration": {
      const { text: canonical, words: ws } = readUtterance(text)
      const spans = numericSpans(canonical, ws)
      // One expression, and the whole slot: "ten" is a number, "ten past" is not.
      if (spans.length !== 1 || spans[0]!.from !== 0 || spans[0]!.to !== ws.length) return undefined
      const found = parseValues(param.kind, text)
      if (found.length !== 1 || !Number.isFinite(found[0]!.value)) return undefined
      const value = found[0]!.value
      if (param.kind === "number") {
        if (!unitFits(param.unit, found[0]!.unit)) return undefined
        if (param.integer === true && !Number.isInteger(value)) return undefined
        if ((param.min !== undefined && value < param.min) || (param.max !== undefined && value > param.max)) return undefined
        return value
      }
      if (value < 0 || (param.minMs !== undefined && value < param.minMs) || (param.maxMs !== undefined && value > param.maxMs)) return undefined
      return value
    }
    case "text":
      return count <= Math.min(param.maxWords ?? 8, PHRASE_LIMITS.slotWords) ? text : undefined
    case "boolean":
      return undefined
  }
}

/** How many slot readings one utterance may cost in all (see `matchCommand`); one read is one parser call. */
interface Budget {
  reads: number
}

/**
 * The values of `phrase`'s slots if it matches the whole utterance, else `undefined`. The words are aligned first
 * (string comparisons only); the slots are read only for an alignment that covers every word, leftmost first, each
 * read counted against `budget` (none is made once it is spent).
 */
const align = (phrase: CompiledPhrase, text: string, ws: ReadonlyArray<Word>, budget: Budget): Record<string, unknown> | undefined => {
  const parts = phrase.parts
  const spans: Array<readonly [number, number]> = []
  let found: Record<string, unknown> | undefined
  const readAll = (): boolean => {
    const values: Record<string, unknown> = {}
    let s = 0
    for (const part of parts) {
      if (typeof part === "string") continue
      const [from, to] = spans[s++]!
      if (budget.reads <= 0) return false
      budget.reads--
      const value = readSlot(part.param, text.slice(ws[from]!.start, ws[to - 1]!.end), to - from)
      if (value === undefined) return false
      values[part.slot] = value
    }
    found = values
    return true
  }
  const step = (pi: number, wi: number): boolean => {
    if (pi === parts.length) return wi === ws.length && readAll()
    const part = parts[pi]!
    if (typeof part === "string") return wi < ws.length && ws[wi]!.norm === part && step(pi + 1, wi + 1)
    const next = parts[pi + 1]
    const last = Math.min(ws.length, wi + PHRASE_LIMITS.slotWords)
    for (let k = wi + 1; k <= last; k++) {
      if (next === undefined ? k !== ws.length : k >= ws.length || ws[k]!.norm !== next) continue
      spans.push([wi, k])
      if (step(pi + 1, k)) return true
      spans.pop()
    }
    return false
  }
  return step(0, 0) ? found : undefined
}

const ownerKey = (o: PhraseOwner) => (o.kind === "control" ? `control:${o.control}` : `action:${o.action.id}`)

/**
 * What the whole utterance matches in `set`: the phrase with the most literal words. Ties between phrases of one
 * owner take the first; a host control beats a module's phrase of the same length; a tie between two modules' commands
 * matches nothing (the utterance goes on as if no phrase had matched). An utterance over `utteranceWords` or
 * `utteranceChars` matches nothing. A slot's values: the leftmost reading that parses. At most `slotReads` slot readings
 * are made for one utterance over every phrase; past them nothing more can match it.
 */
export const matchCommand = (set: CommandSet, text: string): PhraseMatch | undefined => {
  if (text.length > PHRASE_LIMITS.utteranceChars) return undefined
  const ws = words(text)
  if (ws.length === 0 || ws.length > PHRASE_LIMITS.utteranceWords) return undefined
  let best: Array<{ readonly phrase: CompiledPhrase; readonly values: Readonly<Record<string, unknown>> }> = []
  let bestLiterals = 0
  const budget: Budget = { reads: PHRASE_LIMITS.slotReads }
  for (const phrase of set.phrases) {
    // Cheap rejections first: a phrase longer than the utterance, or whose first word cannot be where it must be.
    if (phrase.parts.length > ws.length || phrase.literals < bestLiterals) continue
    const first = phrase.parts[0]
    if (typeof first === "string" && ws[0]!.norm !== first) continue
    const values = align(phrase, text, ws, budget)
    if (values === undefined) continue
    if (phrase.literals > bestLiterals) {
      best = [{ phrase, values }]
      bestLiterals = phrase.literals
    } else best.push({ phrase, values })
  }
  if (best.length === 0) return undefined
  const distinct = (list: typeof best) => new Set(list.map((b) => ownerKey(b.phrase.owner))).size
  const controls = best.filter((b) => b.phrase.owner.kind === "control")
  const chosen = distinct(best) === 1 ? best[0]! : controls.length > 0 && distinct(controls) === 1 ? controls[0]! : undefined
  if (chosen === undefined) return undefined
  const owner = chosen.phrase.owner
  return owner.kind === "control"
    ? { kind: "control", control: owner.control, phrase: chosen.phrase.text }
    : { kind: "command", action: owner.action, values: chosen.values, phrase: chosen.phrase.text }
}

/** A notification ringing on the device, as the ringing window sees it (`RingingNotification`, oldest first). */
export interface RingingCard {
  readonly id: string
  readonly actions: ReadonlyArray<{ readonly id: string; readonly label: string }>
}

/** What an utterance in the ringing window matched: the host's "stop", or a button of a ringing notification. */
export type RingingMatch =
  | { readonly kind: "stop"; readonly phrase: string }
  | { readonly kind: "action"; readonly notificationId: string; readonly actionId: string; readonly label: string }

const normal = (text: string) => words(text).map((w) => w.norm).join(" ")

/**
 * The ringing window's phrases (§4 P7: "stop" and the ringing notification's action phrases): the whole utterance is
 * one of the household language's `stop` phrases, or the label of a button of a notification ringing there (its
 * words, exact; P9's actions carry a label and no phrases of their own). A label of more than one ringing notification
 * goes to the newest of them. Labels that are a stop phrase are "stop" (the host's wins).
 */
export const matchRinging = (language: PhraseLanguage, text: string, ringing: ReadonlyArray<RingingCard>): RingingMatch | undefined => {
  if (ringing.length === 0 || text.length > PHRASE_LIMITS.utteranceChars) return undefined
  const said = normal(text)
  if (said.length === 0 || said.split(" ").length > PHRASE_LIMITS.utteranceWords) return undefined
  const stop = HOST_CONTROL_PHRASES[language].stop.find((p) => normal(p) === said)
  if (stop !== undefined) return { kind: "stop", phrase: stop }
  for (let i = ringing.length - 1; i >= 0; i--) {
    const card = ringing[i]!
    for (const action of card.actions) {
      if (normal(action.label) === said) return { kind: "action", notificationId: card.id, actionId: action.id, label: action.label }
    }
  }
  return undefined
}

/** The language a `HOME_LANGUAGE` value means: Dutch for `nl…`, otherwise English. */
export const phraseLanguageOf = (value: unknown): PhraseLanguage =>
  typeof value === "string" && value.toLowerCase().startsWith("nl") ? "nl" : "en"

/**
 * The Health page's issues for one assistant's set (source `phrases`): each duplicate (both commands left out) and each
 * module past the bound (left out whole), naming the module, so nothing is left out silently. Warnings: the rest of the
 * assistant works, and the phrases go on to the language model as before.
 */
export const phraseConflictIssues = (assistant: { readonly id: string; readonly name: string }, set: CommandSet): ReadonlyArray<{
  readonly id: string
  readonly module?: string
  readonly severity: "warning"
  readonly title: string
  readonly detail: string
}> =>
  set.conflicts.map((c) => {
    if (c.kind === "duplicate") {
      const module = c.actions[0]?.split(".")[0]
      return {
        id: `phrases.${assistant.id}.duplicate.${c.language}.${c.shape}`.slice(0, 200),
        ...(module !== undefined && module !== "" ? { module } : {}),
        severity: "warning" as const,
        title: `${assistant.name}: the phrase "${c.shape}" is used by ${c.actions.join(" and ")}`,
        detail: `Both are left out for ${assistant.name} (${c.language === "nl" ? "Dutch" : "English"}): saying it goes to the language model instead. Switch one of the modules off for this assistant, or change one of the phrases.`
      }
    }
    return {
      id: `phrases.${assistant.id}.over-bound.${c.language}`,
      ...(c.modules[0] !== undefined ? { module: c.modules[0] } : {}),
      severity: "warning" as const,
      title: `${assistant.name}: more than ${PHRASE_LIMITS.phrasesPerAssistant} phrase commands`,
      detail: `The phrases of ${c.modules.join(", ")} are left out for ${assistant.name} (${c.language === "nl" ? "Dutch" : "English"}): an assistant has at most ${PHRASE_LIMITS.phrasesPerAssistant} module phrases per language. Switch modules it does not need off.`
    }
  })
