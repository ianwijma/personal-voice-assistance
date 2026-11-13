// The safety property of the intent path (docs/AGENTS-AND-INTENTS.md, "Review fixes, fifth round"),
// with an oracle that cannot share bugs with the code under test.
//
// VALID COMMANDS ARE DEFINED BY CONSTRUCTION, NOT BY PARSING. Every valid sentence is built from an
// explicit template — an optional opener, the action's verb phrase, one target written exactly as
// an option's name, an optional value with its unit, an optional closer — and what it means is
// recorded while it is built. Every list below is literal data written out in this file; nothing is
// imported from `IntentWords.ts`, `NumberWords.ts` or any other production word list. The only
// production code used is the system under test (`buildDecisionPlan`, `interpretDecision`,
// `sameUtterance`) and the action declarations of this test's own house.
//
// THE PROPERTY, checked against EVERY confident answer a decision provider could give:
//   1. a template instance (up to `key`, the closed ignorable set written out below) acts, and
//      only with exactly the recorded action and values;
//   2. any other sentence — every mutation of an instance (insertion, deletion, substitution,
//      transposition, duplication, truncation, at word and at character level) — does not act,
//      unless it is itself an instance (found by looking it up in the full set of instances,
//      never by parsing it);
//   3. the same for replies: after a question ("dim the kitchen" → "What brightness?") or a
//      confirmation ("switch everything off" → "Switch everything off?"), a reply acts only if it
//      is an instance of a reply template (or a full command instance of its own);
//   4. promotion: an eager transcript and a final one that differs by one mutation are promoted
//      as the same turn (`sameUtterance`, the comparison `Conversation` uses for every promotion)
//      only if they are the same instance up to `key`.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { defineAction, Param, type ParamOption, registerActions, type RegisteredAction } from "../src/Actions.ts"
import { buildDecisionPlan, type DecisionPlan, interpretDecision, type PendingIntent } from "../src/Decision.ts"
import { sameUtterance } from "../src/Utterance.ts"
import { parseValues } from "../src/ValueParsing.ts"
import { everyAnswer, summary, yesMan } from "./support/house.ts"

// ---------------------------------------------------------------------------
// The house: option names with number words, digits, fillers, yes-words, units and prefixes of other names.

const options: Array<ParamOption> = [
  { value: "area:kitchen", label: "Kitchen", aliases: ["keuken"] },
  { value: "area:living_room", label: "Living room", aliases: ["woonkamer"] },
  { value: "area:bedroom", label: "Bedroom", aliases: ["slaapkamer"] },
  { value: "area:two", label: "Room two", aliases: ["kamer twee"] },
  { value: "area:three", label: "Room 3" },
  { value: "light:hall_lamp", label: "Lamp in the hall" },
  { value: "area:hall", label: "Hall" },
  { value: "light:ok", label: "OK lamp" },
  { value: "light:forty", label: "Forty degrees lamp" },
  { value: "light:desk", label: "Desk" },
  { value: "light:desk_lamp", label: "Desk lamp" }
]
const target = Param.dynamic({ label: "Room or light", options: () => options })
const areaOptions = options.filter((o) => String(o.value).startsWith("area:"))
const area = Param.dynamic({ label: "Room", options: () => areaOptions })
const actions: ReadonlyArray<RegisteredAction> = registerActions("home", [
  defineAction({
    id: "lights_on",
    label: "Turn lights on",
    description: "Switch on the lights in a room or one lamp. Not for dimming: that is set_brightness.",
    examples: ["turn on the kitchen lights", "switch on the desk lamp", "doe het licht aan in de woonkamer"],
    params: { target },
    run: () => Effect.void
  }),
  defineAction({
    id: "lights_off",
    label: "Turn lights off",
    description: "Switch off the lights in a room or one lamp.",
    examples: ["turn off the kitchen lights", "switch off the desk lamp", "doe het licht uit in de keuken"],
    params: { target },
    run: () => Effect.void
  }),
  defineAction({
    id: "set_brightness",
    label: "Set brightness",
    description: "Dim or brighten the lights in a room or one lamp to a level in percent.",
    examples: ["dim the living room to 40 percent", "zet de woonkamer op veertig procent"],
    params: { target, level: Param.number({ label: "Brightness", min: 0, max: 100, integer: true, unit: "percent" }) },
    run: () => Effect.void
  }),
  defineAction({
    id: "set_heating",
    label: "Set the heating",
    description: "Set the heating in a room to a temperature in degrees.",
    examples: ["set the heating in the kitchen to 20 degrees"],
    params: { target: area, temp: Param.number({ label: "Temperature", min: 5, max: 30, unit: "degrees" }) },
    run: () => Effect.void
  }),
  defineAction({
    id: "timer",
    label: "Start a timer",
    description: "Start a countdown timer.",
    examples: ["start a timer for 10 minutes"],
    params: { duration: Param.duration({ label: "Duration", minMs: 1_000, maxMs: 86_400_000 }) },
    run: () => Effect.void
  }),
  defineAction({
    id: "all_off",
    label: "Switch everything off",
    description: "Switch off every light in the house at once.",
    examples: ["switch everything off"],
    params: {},
    confirm: true,
    run: () => Effect.void
  }),
  defineAction({
    id: "time_now",
    label: "Tell the time",
    description: "Say what time it is now.",
    examples: ["what time is it"],
    params: {},
    speculative: true,
    run: () => Effect.succeed({ say: "It's 14:32." })
  })
])

// ---------------------------------------------------------------------------
// Templates (literal data). A sentence is built as TOKENS, each with the role it was given when it
// was built; the meaning is recorded at the same time. Roles let the generator say, by
// construction, which edits leave the meaning intact (`benign`), without reading the result.

type Role = "open" | "verb" | "part" | "art" | "prep" | "name" | "num" | "unit" | "noun" | "close" | "q" | "word"
interface Token {
  readonly text: string
  readonly role: Role
  /** Tokens of one multi-word value share a group (a name, a number): an edit inside it breaks the value. */
  readonly group?: number
}
interface Instance {
  readonly tokens: ReadonlyArray<Token>
  readonly meaning: string
}
let groups = 0
const t = (text: string, role: Role): Array<Token> => text.split(" ").filter((x) => x.length > 0).map((x) => ({ text: x, role }))
const value = (text: string, role: "name" | "num"): Array<Token> => {
  const g = ++groups
  return text.split(" ").map((x) => ({ text: x, role, group: g }))
}
const sentenceOf = (tokens: ReadonlyArray<Token>): string => tokens.map((x) => x.text).join(" ").replace(/ \?$/, "?")

/** Openers (`ask`: allows one final "?") and closers. */
const OPENERS: ReadonlyArray<{ readonly text: string; readonly ask: boolean }> = [
  { text: "", ask: false }, { text: "hey", ask: false }, { text: "ok", ask: false }, { text: "please", ask: false },
  { text: "can you", ask: true }, { text: "could you", ask: true }, { text: "would you", ask: true }, { text: "will you", ask: true },
  { text: "I want you to", ask: false }, { text: "I'd like you to", ask: false }, { text: "I'd like to", ask: false }, { text: "I'd like", ask: false }, { text: "I want", ask: false }
]
/** Manner words and openings that may also come first (with an opener after them). */
const LEADS: ReadonlyArray<string> = ["quickly", "now", "right now", "hey", "ok", "please", "just", "um", "uh"]
const CLOSERS: ReadonlyArray<string> = ["", "please", "thanks", "thank you", "now", "for me", "quickly", "right now"]
const NL_OPENERS: ReadonlyArray<{ readonly text: string; readonly ask: boolean }> = [{ text: "", ask: false }, { text: "kun je", ask: true }]
const NL_CLOSERS: ReadonlyArray<string> = ["", "alsjeblieft", "graag", "nu"]

/** Names by option value, written exactly as the option's names (English, then Dutch). */
const EN_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["area:kitchen", "kitchen"], ["area:living_room", "living room"], ["area:bedroom", "bedroom"], ["area:two", "room two"],
  ["area:three", "room 3"], ["light:hall_lamp", "lamp in the hall"], ["area:hall", "hall"], ["light:ok", "OK lamp"],
  ["light:forty", "forty degrees lamp"], ["light:desk", "desk"], ["light:desk_lamp", "desk lamp"]
]
const NL_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["area:kitchen", "keuken"], ["area:living_room", "woonkamer"], ["area:bedroom", "slaapkamer"], ["area:two", "kamer twee"]
]
const AREAS = new Set(["area:kitchen", "area:living_room", "area:bedroom", "area:two", "area:three", "area:hall"])

/** Number words, written out here. */
const EN_UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
const EN_TENS: ReadonlyArray<readonly [string, number]> = [["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90]]
const NL_UNITS = ["nul", "", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen", "tien", "elf", "twaalf", "dertien", "veertien", "vijftien", "zestien", "zeventien", "achttien", "negentien"]
const NL_TENS: ReadonlyArray<readonly [string, number]> = [["twintig", 20], ["dertig", 30], ["veertig", 40], ["vijftig", 50], ["zestig", 60], ["zeventig", 70], ["tachtig", 80], ["negentig", 90]]
/** Every way this test writes the integers lo..hi: digits (and one leading zero below 10), English words, Dutch words. */
const integers = (lo: number, hi: number, dutch: boolean): Array<readonly [string, number]> => {
  const out: Array<readonly [string, number]> = []
  for (let n = lo; n <= hi; n++) {
    out.push([String(n), n], [`${n}.0`, n], [`${n},0`, n], [`${n}.00`, n], [`${n},00`, n])
    if (n < 10) out.push([`0${n}`, n])
    if (!dutch) {
      if (n < 20) out.push([EN_UNITS[n]!, n])
      else if (n < 100) {
        const [tw] = EN_TENS.find(([, v]) => v === n - (n % 10))!
        out.push([n % 10 === 0 ? tw : `${tw} ${EN_UNITS[n % 10]}`, n])
        if (n % 10 !== 0) out.push([`${tw}-${EN_UNITS[n % 10]}`, n])
      } else if (n === 100) out.push(["one hundred", 100], ["a hundred", 100], ["hundred", 100])
    } else {
      if (n < 20 && NL_UNITS[n] !== "") out.push([NL_UNITS[n]!, n])
      else if (n >= 20 && n < 100 && n % 10 === 0) out.push([NL_TENS.find(([, v]) => v === n)![0], n])
      else if (n === 100) out.push(["honderd", 100])
    }
  }
  return out
}
const LEVELS = integers(0, 100, false)
const NL_LEVELS = integers(0, 100, true)
const LEVEL_UNITS: ReadonlyArray<string> = ["percent", "%", " %", ""]
const TEMPS: ReadonlyArray<readonly [string, number]> = [...integers(5, 30, false), ["18.5", 18.5], ["20.5", 20.5], ["5.5", 5.5]]
const TEMP_UNITS: ReadonlyArray<string> = ["degrees", "degree", "°", ""]
const DURATIONS: Array<readonly [string, number]> = [
  ...[...integers(2, 59, false).filter(([w]) => !w.startsWith("0") && !/[.,]/.test(w)), ...Array.from({ length: 940 }, (_, i) => [String(i + 60), i + 60] as const)]
    .flatMap(([w, n]) => [[`${w} minutes`, n * 60_000], [`${w} seconds`, n * 1_000]] as const),
  ["1 minute", 60_000], ["one minute", 60_000], ["a minute", 60_000], ["an hour", 3_600_000], ["one hour", 3_600_000], ["2 hours", 7_200_000]
]
for (const [w, ms] of [...DURATIONS]) {
  const [n, unit] = [w.slice(0, w.lastIndexOf(" ")), w.slice(w.lastIndexOf(" ") + 1)]
  const abbreviation: Readonly<Record<string, ReadonlyArray<string>>> = { minutes: ["min", "mins"], seconds: ["sec", "secs"] }
  for (const short of abbreviation[unit] ?? []) {
    DURATIONS.push([`${n} ${short}`, ms])
    if (!/^\d+$/.test(n)) DURATIONS.push([`${n} ${unit.replace(/s$/, "")}`, ms])
  if (/^\d+$/.test(n)) DURATIONS.push([`${n}.0 ${short}`, ms], [`${n}.00 ${short}`, ms])
  }
  if (!/^\d+$/.test(n)) DURATIONS.push([`${n} ${unit.replace(/s$/, "")}`, ms])
  if (/^\d+$/.test(n)) DURATIONS.push([`${n}.0 ${unit}`, ms], [`${n}.00 ${unit}`, ms], [`${n} ${unit.replace(/s$/, "")}`, ms], [`${n}.0 ${unit.replace(/s$/, "")}`, ms], [`${n}.00 ${unit.replace(/s$/, "")}`, ms])
}

const act = (action: string, values: Record<string, string | number>) =>
  [`Act ${action}`, ...Object.entries(values).map(([k, v]) => `${k}=${String(v)}`)].join(" ")
const withUnit = (n: string, unit: string): Array<Token> => {
  if (unit === "") return value(n, "num")
  if (unit === "%" || unit === "°") {
    if (!/\d$/.test(n)) return []
    const tokens = value(n, "num")
    const last = tokens[tokens.length - 1]!
    return [...tokens.slice(0, -1), { ...last, text: `${last.text}${unit}` }]
  }
  return [...value(n, "num"), ...t(unit.trim(), "unit")]
}

/** The bodies of commands: verb phrase, target, value. */
const commandBodies = (): Array<Instance & { readonly dutch: boolean }> => {
  const out: Array<Instance & { readonly dutch: boolean }> = []
  const push = (tokens: Array<Token> | undefined, meaning: string, dutch = false) => tokens !== undefined && out.push({ tokens, meaning, dutch })
  /** The tokens, or undefined when the value cannot be written so ("forty%"). */
  const v = (...parts: ReadonlyArray<Array<Token>>): Array<Token> | undefined => (parts.some((x) => x.length === 0) ? undefined : parts.flat())
  for (const [value_, name] of EN_NAMES) {
    for (const [verb, part, action] of [["turn", "on", "lights_on"], ["switch", "on", "lights_on"], ["turn", "off", "lights_off"], ["switch", "off", "lights_off"]] as const) {
      const meaning = act(action, { target: value_ })
      push([...t(verb, "verb"), ...t(part, "part"), ...t("the", "art"), ...value(name, "name")], meaning)
      push([...t(verb, "verb"), ...t("the", "art"), ...value(name, "name"), ...t(part, "part")], meaning)
      if (verb === "turn") {
        // Without a verb: "kitchen lights on", "the desk lamp off", "keuken aan".
        push([...t("the", "art"), ...value(name, "name"), ...t(part, "part")], meaning)
        push([...value(name, "name"), ...t(part, "part")], meaning)
        push([...t(part, "part"), ...t("the", "art"), ...value(name, "name")], meaning)
        if (AREAS.has(value_)) push([...value(name, "name"), ...t("lights", "noun"), ...t(part, "part")], meaning)
      }
      if (AREAS.has(value_)) {
        for (const noun of ["lights", "light"]) {
          push([...t(verb, "verb"), ...t(part, "part"), ...t("the", "art"), ...value(name, "name"), ...t(noun, "noun")], meaning)
          push([...t(verb, "verb"), ...t("the", "art"), ...value(name, "name"), ...t(noun, "noun"), ...t(part, "part")], meaning)
        }
      }
    }
    for (const [n, level] of LEVELS) {
      for (const unit of LEVEL_UNITS) {
        for (const verb of ["dim", "set"]) {
          if (verb === "set" && unit === "" && AREAS.has(value_)) continue // "set the kitchen to 20": brightness or heating? (a lamp has no heating)
          push(v(t(verb, "verb"), t("the", "art"), value(name, "name"), t("to", "prep"), withUnit(n, unit)), act("set_brightness", { target: value_, level }))
        }
      }
    }
    if (AREAS.has(value_)) {
      for (const [n, temp] of TEMPS) {
        for (const unit of TEMP_UNITS) {
          push(v(t("set", "verb"), t("the", "art"), t("heating", "noun"), t("in", "prep"), t("the", "art"), value(name, "name"), t("to", "prep"), withUnit(n, unit)), act("set_heating", { target: value_, temp }))
          // Without "heating": the unit says which ("set the kitchen to 20 degrees").
          if (unit !== "") push(v(t("set", "verb"), t("the", "art"), value(name, "name"), t("to", "prep"), withUnit(n, unit)), act("set_heating", { target: value_, temp }))
        }
      }
    }
  }
  for (const [value_, name] of NL_NAMES) {
    for (const [part, action] of [["aan", "lights_on"], ["uit", "lights_off"]] as const) {
      push([...t("doe", "verb"), ...t("het", "art"), ...t("licht", "noun"), ...t(part, "part"), ...t("in", "prep"), ...t("de", "art"), ...value(name, "name")], act(action, { target: value_ }), true)
    }
    for (const [n, level] of NL_LEVELS) {
      for (const unit of ["procent", "%", ""]) push(v(t("zet", "verb"), t("de", "art"), value(name, "name"), t("op", "prep"), withUnit(n, unit)), act("set_brightness", { target: value_, level }), true)
    }
  }
  for (const [d, ms] of DURATIONS) {
    const [n, unit] = [d.slice(0, d.lastIndexOf(" ")), d.slice(d.lastIndexOf(" ") + 1)]
    push([...t("start", "verb"), ...t("a", "art"), ...t("timer", "noun"), ...t("for", "prep"), ...value(n, "num"), ...t(unit, "unit")], act("timer", { duration: ms }))
  }
  push([...t("switch", "verb"), ...t("everything", "noun"), ...t("off", "part")], "Confirm all_off")
  return out
}

/** Replies to "What brightness?" for the kitchen: bodies, then closers. */
const BRIGHTNESS_SHAPES: ReadonlyArray<(n: Array<Token>) => Array<Token>> = [
  (n) => n,
  (n) => [...t("to", "prep"), ...n],
  (n) => [...t("set", "verb"), ...t("it", "word"), ...t("to", "prep"), ...n],
  (n) => [...t("make", "verb"), ...t("it", "word"), ...n],
  (n) => [...t("the", "art"), ...value("kitchen", "name"), ...n],
  (n) => [...t("the", "art"), ...value("kitchen", "name"), ...t("to", "prep"), ...n],
  (n) => [...t("dim", "verb"), ...t("the", "art"), ...value("kitchen", "name"), ...t("to", "prep"), ...n],
  (n) => [...t("set", "verb"), ...t("the", "art"), ...value("kitchen", "name"), ...t("to", "prep"), ...n],
  (n) => [...t("make", "verb"), ...t("the", "art"), ...value("kitchen", "name"), ...n],
  (n) => [...value("kitchen", "name"), ...n],
  (n) => [...value("kitchen", "name"), ...t("to", "prep"), ...n]
]
const brightnessReplies = (): Array<Instance> => {
  const out: Array<Instance> = []
  for (const [n, level] of LEVELS) {
    for (const unit of LEVEL_UNITS) {
      const v = withUnit(n, unit)
      if (v.length === 0) continue
      for (const shape of BRIGHTNESS_SHAPES) out.push({ tokens: shape(v), meaning: act("set_brightness", { target: "area:kitchen", level }) })
      if (unit !== "") out.push({ tokens: [...t("the", "art"), ...value("kitchen", "name"), ...t("at", "prep"), ...v], meaning: act("set_brightness", { target: "area:kitchen", level }) })
    }
  }
  for (const [n, level] of NL_LEVELS) {
    for (const unit of ["procent", ""]) out.push({ tokens: [...t("op", "prep"), ...withUnit(n, unit)], meaning: act("set_brightness", { target: "area:kitchen", level }) })
    out.push({ tokens: value(n, "num"), meaning: act("set_brightness", { target: "area:kitchen", level }) })
  }
  return out
}
const REPLY_CLOSERS: ReadonlyArray<string> = ["", "please", "thanks", "graag", "quickly", "now"]

/** Replies that confirm "Switch everything off?": [yes-filler] affirmative (affirmative | yes-filler){0,2}. */
const AFFIRMATIVES: ReadonlyArray<string> = [
  "yes", "yeah", "yea", "yep", "yup", "sure", "ok", "okay", "alright", "go ahead", "do it", "please do", "that's right", "correct", "fine", "absolutely", "of course",
  "ja", "doe maar", "prima", "ga je gang", "graag", "ja graag", "zeker", "klopt", "akkoord", "doe het", "ga maar", "doen"
]
const YES_FILLERS: ReadonlyArray<string> = ["please", "thanks", "thank you", "now", "then", "well", "oh", "hey", "um", "alsjeblieft", "graag", "nou", "nu", "dan"]
const confirmReplies = (): Array<Instance> => {
  const out: Array<Instance> = []
  const more = ["", ...AFFIRMATIVES, ...YES_FILLERS]
  for (const before of ["", ...YES_FILLERS]) {
    for (const a of AFFIRMATIVES) {
      for (const m1 of more) out.push({ tokens: [...t(before, "close"), ...t(a, "word"), ...t(m1, "word")], meaning: "Act all_off" })
    }
  }
  return out
}
/**
 * The confirmation instances are the grammar written out from this file's lists: any sequence of
 * these phrases with at least one affirmative (a regular language over literal phrases; sampled
 * above, recognised here).
 */
const CONFIRM_LANGUAGE = new RegExp(`^(?:(?:${[...AFFIRMATIVES, ...YES_FILLERS].map((p) => p.replace(/'/g, "")).sort((a, b) => b.length - a.length).join("|")}) ?)+$`)
const AFFIRMATIVE_IN = new RegExp(`(?:^| )(?:${AFFIRMATIVES.map((p) => p.replace(/'/g, "")).join("|")})(?: |$)`)
const isConfirmInstance = (sentence: string): boolean => {
  const k = key(sentence)
  return CONFIRM_LANGUAGE.test(k) && AFFIRMATIVE_IN.test(k)
}

// ---------------------------------------------------------------------------
// `key`: the closed ignorable set, written out here from the specification (not imported):
// case; whitespace (any Unicode space); quotes and apostrophes; ".", "!", "…", ";", ":" before a
// space or the end; a comma before a space away from numbers; a dash between two letters.

const NUMBER_WORDS_LITERAL = new Set([...EN_UNITS, ...EN_TENS.map(([w]) => w), ...NL_UNITS.filter((w) => w !== ""), ...NL_TENS.map(([w]) => w), "hundred", "honderd", "een", "a", "an", "and", "en", "point", "komma", "minus", "min", "negative", "negatief", "half"])
const key = (sentence: string): string => {
  let s = sentence.normalize("NFC").toLowerCase()
  s = s.replace(/(?<=\p{L})[-‐‑‒–—―−﹘﹣－](?=\p{L})/gu, " ")
  s = s.replace(/["“”„«»‘’‚`']/g, "")
  s = s.replace(/[.!…;:]+(?=\s|$)/g, "")
  const tokens = s.split(/\s+/u).filter((x) => x.length > 0)
  const numeric = (x: string | undefined) => x !== undefined && (/\p{N}/u.test(x) || NUMBER_WORDS_LITERAL.has(x.replace(/,$/, "")))
  // A comma before a space is significant only between two numeric words ("forty, five"); elsewhere it is punctuation.
  return tokens.map((x, i) => (x.endsWith(",") && !(numeric(x) && numeric(tokens[i + 1])) ? x.slice(0, -1) : x)).filter((x) => x.length > 0).join(" ")
}

/** Durations by `key`, for looking them up in an edited sentence. */
const DURATION_KEYS = new Map<string, number>()
for (const [w, ms] of [...DURATIONS, ["a second", 1_000], ["a sec", 1_000], ["a secs", 1_000]] as const) DURATION_KEYS.set(key(w), ms)

/** The full set of instances, looked up by key: every opener and closer around every body (and "?" after an asking opener). */
class Instances {
  private readonly bodies = new Map<string, Array<{ readonly meaning: string; readonly dutch: boolean }>>()
  private readonly openers: ReadonlyArray<{ readonly text: string; readonly ask: boolean }>
  private readonly closers: ReadonlyArray<string>
  private readonly nlOpeners: ReadonlyArray<{ readonly text: string; readonly ask: boolean }>
  private readonly nlClosers: ReadonlyArray<string>
  constructor(
    bodies: ReadonlyArray<Instance & { readonly dutch?: boolean }>,
    openers: ReadonlyArray<{ readonly text: string; readonly ask: boolean }>,
    closers: ReadonlyArray<string>,
    nlOpeners = openers,
    nlClosers = closers
  ) {
    this.openers = openers
    this.closers = closers
    this.nlOpeners = nlOpeners
    this.nlClosers = nlClosers
    for (const b of bodies) {
      const k = key(sentenceOf(b.tokens))
      const list = this.bodies.get(k) ?? []
      list.push({ meaning: b.meaning, dutch: b.dutch === true })
      this.bodies.set(k, list)
    }
  }
  meaning(sentence: string): string | undefined {
    const k0 = key(sentence)
    for (const question of [false, true]) {
      if (question && !k0.endsWith("?")) continue
      const k = question ? k0.slice(0, -1).trim() : k0
      for (const dutch of [false, true]) {
        for (const o of dutch ? this.nlOpeners : this.openers) {
          if (question && !o.ask) continue
          const ko = key(o.text)
          if (ko !== "" && !k.startsWith(`${ko} `)) continue
          for (const c of dutch ? this.nlClosers : this.closers) {
            const kc = key(c)
            if (kc !== "" && !k.endsWith(` ${kc}`)) continue
            const body = k.slice(ko === "" ? 0 : ko.length + 1, kc === "" ? k.length : k.length - kc.length - 1)
            const hit = this.bodies.get(body)?.find((b) => b.dutch === dutch)
            if (hit !== undefined) return hit.meaning
          }
        }
      }
    }
    return undefined
  }
  has(sentence: string): boolean {
    return this.meaning(sentence) !== undefined
  }
}

// ---------------------------------------------------------------------------
// Running the system under test.

const plan = (utterance: string, pending?: PendingIntent): DecisionPlan => buildDecisionPlan({ utterance, actions, pending, parse: parseValues })
/** Runs an action (not the read-only `time_now`). */
const runs = (o: string) => o.startsWith("Act") && !o.startsWith("Act time_now")
/** The outcomes over every confident answer. */
const outcomesOf = (utterance: string, pending?: PendingIntent): Array<string> => {
  const p = plan(utterance, pending)
  return [...new Set(everyAnswer(p).map((r) => summary(interpretDecision(p, r))))]
}
const pendingFrom = (utterance: string, action: string, values: Record<string, string>, tag: "Ask" | "Confirm"): PendingIntent => {
  const p = plan(utterance)
  const o = interpretDecision(p, yesMan(action, values)(p))
  if (o._tag !== tag) throw new Error(`${utterance}: expected ${tag}, got ${summary(o)}`)
  return o.pending
}

// ---------------------------------------------------------------------------
// The generator (literal data).

const prng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6D2B79F5) | 0
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}

/** Punctuation and symbols: every Unicode dash and minus, decimal marks, symbols, brackets, quotes, invisible and non-breaking spaces, other digits. */
const SYMBOLS: ReadonlyArray<string> = [
  "-", "‐", "‑", "‒", "–", "—", "―", "−", "﹘", "﹣", "－", "⁻", "₋", "⸺", "⸻", "〜", "~",
  ".", ",", "·", "٫", "٬", "'", "’",
  "%", "°", "?", "!", "&", "/", "@", "#", "+", "=", "*", "^", "|", "\\", "$", "€", "½", "²", "‰", "℃",
  "(", ")", "[", "]", "{", "}", "<", ">",
  "\"", "“", "”", "„", "«", "»", "‘", "‚", "`",
  "​", "‌", "‍", "﻿", " ", " ", " ",
  "０", "１", "４", "٠", "١", "٤", "۴", "५"
]
const NEGATIONS = ["not", "don't", "dont", "never", "no", "can't", "won't", "without", "except", "niet", "nooit", "geen", "nergens"]
const PROHIBITIONS = ["stop", "cancel", "forget", "skip", "abort", "avoid", "annuleer", "vergeet", "stoppen"]
const TIMES = ["at 7", "by 7", "until 7", "after 7", "before 7", "in 5 minutes", "at midnight", "tomorrow", "later", "om 7", "tot 7", "na 7", "morgen", "at seven", "by 10 percent"]
const CONDITIONS = ["if it is dark", "when I leave", "unless", "if", "when", "als het donker is", "wanneer"]
const WORDS: ReadonlyArray<string> = [
  "the", "a", "my", "to", "in", "at", "for", "of", "op", "de", "het", "voor", "please", "now", "just", "thanks", "quickly",
  "yes", "ok", "sure", "ja", "and", "or", "then", "too", "also", "it", "i", "you", "he said", "will", "did", "is",
  "lights", "lamp", "light", "on", "off", "aan", "uit", "turn", "switch", "dim", "set", "zet", "doe",
  "kitchen", "bedroom", "room", "two", "three", "3", "hall", "desk", "forty", "degrees", "percent", "procent", "%", "minutes",
  "40", "50", "five", "one hundred", "minus", "negative", "point five", "and a half", "veertig", "vijftig", "graden",
  "everything", "heating", "timer", "attic", "colour", "mother", "me", "bit", "up", "down"
]
const SECOND_NUMBERS = ["40", "50 percent", "and 5", "five", "or 60", "40%"]
const UNIT_SWAPS: ReadonlyArray<readonly [string, string]> = [["percent", "degrees"], ["%", "°"], ["degrees", "percent"], ["procent", "graden"], ["minutes", "percent"], ["°", "%"]]
const SIGN_FLIPS: ReadonlyArray<string> = ["-", "−", "–", "minus ", "negative ", "min ", "+"]

/**
 * BENIGN RESULTS, by construction (`benignMeanings`): the base instance's content — its verb,
 * particle, nouns, number (whole), unit and one option name (whole) — is still all there, the
 * opener still opens and the closer still closes, and what was added is only the test's own free
 * words: an article, a value preposition (not "at") or a neutral word, each followed by more
 * content (so nothing dangles at the end, finding 3). The verb, if said, comes first; the nouns
 * "lights"/"light"/"lamp" may be dropped or swapped, a particle or noun repeated, the unit word
 * placed anywhere (it is the action's own word). Not allowed (review round 6): a broken longer
 * name that leaves a shorter option's name whole ("lamp in the to hall" names "hall"), and a time
 * or condition word right before the number ("dim the kitchen in 40 percent"). Such a
 * result may act with the base meaning (or that option), but need not. It is decided from the
 * roles the tokens were built with, never by reading the sentence.
 */
const FREE_LITERAL = new Set([
  "the", "a", "an", "de", "het", "t", "my", "our", "mijn", "onze", "to", "in", "into", "for", "of", "op", "voor", "naar", "van", "bij", "te",
  "please", "just", "kindly", "um", "uh", "now", "graag", "alsjeblieft", "even", "eens", "nu"
])
const DEPENDENT_LITERAL = new Set(["the", "a", "an", "de", "het", "t", "my", "our", "mijn", "onze", "to", "in", "into", "for", "of", "op", "voor", "naar", "van", "bij", "te"])
const NOUNS_LITERAL = new Set(["lights", "light", "lamp"])
/** Words that make the number after them a time or a condition (written out here, not imported). */
const TIME_WORDS_LITERAL = new Set([
  "by", "until", "till", "til", "after", "before", "around", "since", "from", "past", "in", "within",
  "om", "tot", "na", "voor", "vanaf", "rond", "omstreeks", "sinds", "tegen", "uiterlijk", "over", "binnen"
])
/** Of those, the words that introduce a duration ("in 10 minutes", "binnen 5 minuten"). */
const DURATION_INTRO_LITERAL = new Set(["in", "within", "over", "binnen", "voor"])
const UNIT_KINDS: ReadonlyArray<ReadonlySet<string>> = [new Set(["percent", "procent", "%"]), new Set(["degrees", "degree", "°", "graden"])]
const ALL_NAMES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [...EN_NAMES, ...NL_NAMES].map(([v, n]) => [v, n.toLowerCase().split(" ")])
/** A recogniser's spelling of a name word: a run of one letter counts as one ("deesk", "bedrom", "sllaapkamer"). */
const runs1 = (w: string) => w.replace(/(\p{L})\1+/gu, "$1")
const numericLiteral = (x: string) => /\p{N}/u.test(x) || NUMBER_WORDS_LITERAL.has(x)
/** A word that is a number by itself (not "a", "and", "point": those are numeric only next to one). */
const numericCore = (x: string) => /\p{N}/u.test(x) || (NUMBER_WORDS_LITERAL.has(x) && !["a", "an", "and", "en", "een", "point", "komma", "half", "min", "minus", "negative", "negatief"].includes(x))
/** Words of the action itself, by action (from this file's declarations above): explained anywhere in its body. */
const ACTION_WORDS_LITERAL: Readonly<Record<string, ReadonlyArray<string>>> = {
  lights_on: ["lights", "light", "lamp", "room"], lights_off: ["lights", "light", "lamp", "room"],
  set_brightness: ["percent", "procent", "%", "brightness", "lights", "light", "lamp", "room"],
  set_heating: ["degrees", "degree", "°", "heating", "temperature", "room"], timer: ["timer", "duration"]
}
/** Every spelling of a value this file writes, by action and parameter (to find a whole number in an edited sentence). */
const SPELLINGS: Readonly<Record<string, readonly [string, ReadonlyArray<readonly [string, number]>]>> = {
  set_brightness: ["level", [...LEVELS, ...NL_LEVELS]],
  set_heating: ["temp", TEMPS]
}
const benignMeanings = (base: Instance, xs: ReadonlyArray<Token>, reply?: { readonly target: string; readonly words: ReadonlyArray<string> }): ReadonlyArray<string> => {
  const lower = (x: Token) => x.text.toLowerCase()
  const texts = (r: Role) => base.tokens.filter((x) => x.role === r).map(lower)
  // The edited sentence as words of `key` (case, quotes, apostrophes, any space, ignorable punctuation); then stutters count once.
  let m = key(sentenceOf(xs)).split(" ").filter((x) => x.length > 0)
  m = m.filter((x, i, all) => i === 0 || x !== all[i - 1] || numericCore(x))
  const question = m[m.length - 1]?.endsWith("?") === true
  if (question) m[m.length - 1] = m[m.length - 1]!.slice(0, -1)
  m = m.filter((x) => x.length > 0)
  // Any one opener and any one closer of this file's lists (a "?" only after an asking opener).
  let asked = false
  for (const lead of [...LEADS].sort((x, y) => y.length - x.length)) {
    const lw = key(lead).split(" ")
    if (lw.every((w, i) => m[i] === w) && m.length > lw.length) {
      m = m.slice(lw.length)
      break
    }
  }
  for (const o of [...OPENERS, ...NL_OPENERS].sort((x, y) => y.text.length - x.text.length)) {
    const ow = key(o.text).split(" ").filter((x) => x.length > 0)
    if (ow.length > 0 && ow.every((w, i) => m[i] === w)) {
      m = m.slice(ow.length)
      asked = o.ask
      break
    }
  }
  if (question && !asked) return []
  // Closers at the end (at most a few), and neutral words after them ("thanks just"), which are as free there as anywhere.
  const closers = [...CLOSERS, ...REPLY_CLOSERS, ...NL_CLOSERS].filter((c) => c !== "").sort((x, y) => y.length - x.length)
  for (let round = 0; round < 4; round++) {
    const c = closers.find((c) => {
      const cw = key(c).split(" ")
      return cw.length < m.length && cw.every((w, i) => m[m.length - cw.length + i] === w)
    })
    if (c !== undefined) m = m.slice(0, m.length - key(c).split(" ").length)
    else if (m.length > 1 && FREE_LITERAL.has(m[m.length - 1]!) && !DEPENDENT_LITERAL.has(m[m.length - 1]!)) m = m.slice(0, -1)
    else break
  }
  // One option name whole (said with or without an article where the name has one).
  const whole: Array<{ readonly value: string; readonly from: number; readonly to: number }> = []
  for (const [v, full] of ALL_NAMES) {
    for (const ws of [full, full.filter((w) => !["the", "de", "het"].includes(w))]) {
      for (let i = 0; i + ws.length <= m.length; i++) if (ws.every((w, k) => runs1(m[i + k]!) === runs1(w))) whole.push({ value: v, from: i, to: i + ws.length })
    }
  }
  const maximal = whole.filter((x) => !whole.some((y) => y !== x && y.from <= x.from && x.to <= y.to && y.to - y.from > x.to - x.from))
  // Review round 6: a broken longer name never falls back to a shorter name inside it. If a longer
  // name contains the matched words and its other content words are all said too ("the lamp in the
  // to hall": lamp, hall), the result is NOT an allowed variation (it must ask or hand on).
  const brokenLonger = maximal.some((x) => {
    const inner = m.slice(x.from, x.to).map(runs1)
    return ALL_NAMES.some(([, full]) => {
      const fw = full.map(runs1)
      if (fw.length <= inner.length) return false
      const at = fw.findIndex((_, i) => inner.every((w, k) => fw[i + k] === w))
      if (at < 0) return false
      const rest = fw.filter((_, i) => i < at || i >= at + inner.length).filter((w) => !["the", "de", "het", "in", "a", "an"].includes(w))
      return rest.length > 0 && rest.every((w) => m.some((y, i) => (i < x.from || i >= x.to) && runs1(y) === w))
    })
  })
  if (brokenLonger) return []
  const targets = new Set(maximal.map((x) => x.value))
  const inWhole = (i: number) => maximal.some((y) => i >= y.from && i < y.to)
  const action = /^Act (\S+)/.exec(base.meaning)?.[1] ?? ""
  // One whole number, spelled as this file spells them (a glued "%" or "°" set apart).
  const spelled = SPELLINGS[action]
  let numAt = -1
  let numLen = 0
  let numValue: number | undefined
  if (spelled !== undefined) {
    // Zeros that do not change a written number count as nothing: "001", "53,0000", "00.00" (the parser reads them so).
    const bare = m.map((x) => x.replace(/[%°]$/, "").replace(/^0+(?=\d)/, "").replace(/([.,]\d*?)0+$/, "$1").replace(/[.,]$/, ""))
    const hits: Array<{ readonly at: number; readonly len: number; readonly value: number }> = []
    for (const [w, v] of spelled[1]) {
      const ws = key(w).split(" ").map((x) => x.replace(/^0+(?=\d)/, "").replace(/([.,]\d*?)0+$/, "$1").replace(/[.,]$/, ""))
      for (let i = 0; i + ws.length <= bare.length; i++) {
        if (ws.every((x, k) => bare[i + k] === x && !inWhole(i + k)) && !hits.some((h) => h.at === i && h.len === ws.length)) hits.push({ at: i, len: ws.length, value: v })
      }
    }
    const longest = hits.filter((h) => !hits.some((g) => g !== h && g.at <= h.at && h.at + h.len <= g.at + g.len && g.len > h.len))
    const numberish = m.filter((x, i) => !inWhole(i) && numericCore(x.replace(/[%°]$/, ""))).length
    if (longest.length !== 1 || numberish !== longest[0]!.len) return []
    numAt = longest[0]!.at
    numLen = longest[0]!.len
    numValue = longest[0]!.value
  } else if (action === "timer") {
    // Any digits with a unit of this file's table, or one of the durations written out above.
    const UNIT_MS: Readonly<Record<string, number>> = { second: 1_000, seconds: 1_000, sec: 1_000, secs: 1_000, minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000, hour: 3_600_000, hours: 3_600_000 }
    const hits: Array<{ readonly at: number; readonly len: number; readonly value: number }> = []
    m.forEach((x, i) => {
      const u = UNIT_MS[m[i + 1] ?? ""]
      if (u !== undefined && /^\d+(?:[.,]0+)?$/.test(x)) hits.push({ at: i, len: 2, value: Number(x.replace(/[.,]0+$/, "")) * u })
    })
    for (let i = 0; i < m.length; i++) {
      for (let len = 4; len >= 2; len--) {
        const ms = DURATION_KEYS.get(m.slice(i, i + len).join(" "))
        if (ms !== undefined && !hits.some((h) => h.at <= i && i < h.at + h.len)) {
          hits.push({ at: i, len, value: ms })
          break
        }
      }
    }
    const numberish = m.filter((x, i) => !inWhole(i) && numericCore(x)).length
    const h = hits[0]
    if (h === undefined || hits.length !== 1 || numberish > h.len - 1 || h.value < 1_000 || h.value > 86_400_000) return []
    numAt = h.at
    numLen = h.len
    numValue = h.value
  } else if (texts("num").length > 0) {
    const num = key(texts("num").join(" ")).split(" ")
    numAt = m.findIndex((_, i) => num.every((n, k) => m[i + k] === n))
    numLen = num.length
    if (numAt < 0 || m.filter((x, i) => !inWhole(i) && numericCore(x)).length !== numLen) return []
  } else if (m.some((x, i) => !inWhole(i) && numericCore(x))) return []
  const named = base.tokens.some((x) => x.role === "name")
  if (reply !== undefined ? targets.size > 1 || (targets.size === 1 && !targets.has(reply.target)) : named ? targets.size !== 1 : targets.size !== 0) return []
  const unitKind = UNIT_KINDS.find((k) => [...texts("unit"), ...texts("num")].some((u) => k.has(u) || [...k].some((c) => u.endsWith(c))))
  const verbs = texts("verb")
  const known = new Set([...texts("part"), ...texts("noun"), ...texts("unit"), ...(unitKind ?? []), ...(ACTION_WORDS_LITERAL[action] ?? []), ...(action === "set_brightness" ? [...UNIT_KINDS[1]!, "heating"] : [])])
  const actionVerbs: Readonly<Record<string, ReadonlyArray<string>>> = { set_brightness: ["dim", "set", "zet"], lights_on: ["turn", "switch", "doe"], lights_off: ["turn", "switch", "doe"], set_heating: ["set", "zet"], timer: ["start", "zet"] }
  verbs.push(...(actionVerbs[action] ?? []).filter((v) => !verbs.includes(v)))
  const free = new Set([...FREE_LITERAL, ...texts("prep"), ...texts("art"), ...texts("word"), ...(reply?.words ?? [])])
  const dependent = new Set([...DEPENDENT_LITERAL, ...texts("prep"), ...texts("art")])
  const replyVerbs = ["dim", "set", "zet", "make"]
  let contentSeen = false
  let dangling = false
  for (let i = 0; i < m.length; i++) {
    const x = m[i]!
    const value = maximal.some((y) => i >= y.from && i < y.to) || (numAt >= 0 && i >= numAt && i < numAt + numLen)
    if (value || known.has(x)) {
      contentSeen = true
      dangling = false
    } else if (reply !== undefined && (verbs.includes(x) || replyVerbs.includes(x))) {
      contentSeen = true // a reply's verbs have no place (core reads a reply as its value and the question's words)
    } else if (verbs.includes(x)) {
      if (contentSeen || dangling) return [] // a verb after other content, or after a word that places something: not a request
      contentSeen = true
    } else if (TIME_WORDS_LITERAL.has(x) && i + 1 === numAt && !(action === "timer" && DURATION_INTRO_LITERAL.has(x))) {
      // Review round 6: a time or condition word right before the number ("dim the kitchen in 40
      // percent", "… by 40") is never an allowed variation (except "at" with the unit, below).
      return []
    } else if (x === "at") {
      // "at" right before a number is a time unless the number carries the parameter's unit ("at 50 percent").
      if (i + 1 === numAt && !(/[%°]$/.test(m[numAt + numLen - 1]!) || (unitKind?.has(m[numAt + numLen] ?? "") ?? false))) return []
      dangling = true
    } else if (free.has(x)) {
      if (dependent.has(x)) dangling = true
    } else return []
  }
  if (dangling) return []
  if (texts("part").some((p) => !m.includes(p))) return []
  if (reply === undefined && m.filter((x) => verbs.includes(x)).length > verbs.length) return []
  let meaning = base.meaning
  // A unit word of the other number action, said apart from the number, makes it that action (it is that action's own word).
  if (action === "set_brightness" && m.some((x, i) => !inWhole(i) && (UNIT_KINDS[1]!.has(x) || x === "heating")) && !m.some((x) => UNIT_KINDS[0]!.has(x) || /%$/.test(x)) && numValue !== undefined) {
    const tg = /target=(\S+)/.exec(base.meaning)?.[1] ?? reply?.target
    return tg !== undefined && tg.startsWith("area:") && numValue >= 5 && numValue <= 30 ? [`Act set_heating target=${tg} temp=${numValue}`] : []
  }
  if (numValue !== undefined && action === "timer") meaning = `Act timer duration=${numValue}`
  if (numValue !== undefined && spelled !== undefined) meaning = meaning.replace(new RegExp(`${spelled[0]}=\\S+`), `${spelled[0]}=${numValue}`)
  if (reply !== undefined) return [meaning]
  const baseTarget = /target=(\S+)/.exec(base.meaning)?.[1]
  return named && baseTarget !== undefined ? [...targets].map((tg) => meaning.replace(`target=${baseTarget}`, `target=${tg}`)) : [meaning]
}

/** Words the generator inserts as neutral (its own labels; whether a result is benign is decided by `benignMeanings`). */
const NEUTRAL = ["please", "just", "kindly", "um", "uh"]
const ARTICLES_LITERAL = ["the", "a", "de", "het"]
const VALUE_PREPS = ["to", "op", "in", "for", "of", "voor", "naar"]

type Rand = () => number
const pick = <T>(r: Rand, xs: ReadonlyArray<T>): T => xs[Math.floor(r() * xs.length)]!
interface Mutated {
  readonly tokens: ReadonlyArray<Token>
  readonly label: string
  readonly benign: boolean
}
const word = (text: string): Array<Token> => t(text, "word")
const placesValue = (x: Token | undefined) => x !== undefined && (x.role === "name" || x.role === "num" || x.role === "noun")
const firstOfGroup = (xs: ReadonlyArray<Token>, i: number) => xs[i]?.group === undefined || xs[i - 1]?.group !== xs[i]!.group

/** One random edit, at word or character level. */
const mutate = (r: Rand, xs: ReadonlyArray<Token>): Mutated => {
  const n = xs.length
  if (n === 0) return { tokens: word(pick(r, WORDS)), label: "insert word", benign: false }
  const at = Math.floor(r() * (n + 1))
  const w = Math.min(at, n - 1)
  const insert = (tokens: Array<Token>, label: string, benign = false): Mutated => ({ tokens: [...xs.slice(0, at), ...tokens, ...xs.slice(at)], label, benign })
  const kind = Math.floor(r() * 22)
  switch (kind) {
    case 0: {
      const x = pick(r, WORDS)
      const benign = NEUTRAL.includes(x) || ((ARTICLES_LITERAL.includes(x) || VALUE_PREPS.includes(x)) && placesValue(xs[at]) && firstOfGroup(xs, at))
      return insert(word(x), "insert word", benign)
    }
    case 1: {
      const gone = xs[w]!
      const benign = gone.role === "verb" || gone.role === "noun" || NEUTRAL.includes(gone.text) ||
        ((gone.role === "art" || gone.role === "prep") && placesValue(xs[w + 1]) && gone.text !== "at")
      return { tokens: xs.filter((_, i) => i !== w), label: "delete word", benign }
    }
    case 2: {
      const x = pick(r, WORDS)
      const was = xs[w]!
      const benign = was.role === "noun" && ["lights", "light", "lamp"].includes(was.text) && ["lights", "light", "lamp"].includes(x)
      return { tokens: xs.map((y, i) => (i === w ? { text: x, role: "word" as const } : y)), label: "substitute word", benign }
    }
    case 3: {
      if (w + 1 >= n) return { tokens: xs.slice(0, -1), label: "truncate word", benign: false }
      const [a, b] = [xs[w]!, xs[w + 1]!]
      const benign = (a.role === "part" && (b.role === "art" || b.role === "name" || b.role === "noun") && b.group === undefined) ||
        (a.role === "part" && b.role === "name" && xs[w + 2]?.group !== b.group)
      return { tokens: xs.map((y, i) => (i === w ? b : i === w + 1 ? a : y)), label: "transpose words", benign }
    }
    case 4: {
      const x = xs[w]!
      return { tokens: [...xs.slice(0, w + 1), { text: x.text, role: x.role }, ...xs.slice(w + 1)], label: "duplicate word", benign: x.role !== "num" && x.role !== "unit" && x.group === undefined }
    }
    case 5: return { tokens: xs.slice(0, Math.max(1, w)), label: "truncate words", benign: false }
    case 6: case 7: case 8: case 9: case 10: case 11: {
      // A character edit inside one token (a symbol inserted, a character deleted, doubled or swapped, the token cut).
      const x = xs[w]!
      const c = Math.floor(r() * (x.text.length + 1))
      const edit = kind <= 8 ? x.text.slice(0, c) + pick(r, SYMBOLS) + x.text.slice(c)
        : kind === 9 ? x.text.slice(0, c) + x.text.slice(c + 1)
        : kind === 10 ? x.text.slice(0, c) + x.text.slice(c, c + 1) + x.text.slice(c)
        : x.text.slice(0, Math.max(1, c))
      const labels = ["insert symbol", "insert symbol", "insert symbol", "delete char", "duplicate char", "truncate chars"]
      return { tokens: xs.map((y, i) => (i === w ? { ...y, text: edit, role: "word" as const } : y)), label: labels[kind - 6]!, benign: false }
    }
    case 12: return insert(word(pick(r, SYMBOLS)), "insert symbol between words")
    case 13: return insert(word(pick(r, NEGATIONS)), "negation")
    case 14: return insert(word(pick(r, PROHIBITIONS)), "prohibition")
    case 15: return insert(word(pick(r, TIMES)), "time")
    case 16: return insert(word(pick(r, CONDITIONS)), "condition")
    case 17: {
      const k = xs.findIndex((y) => y.role === "num")
      const where = k < 0 ? at : xs.findIndex((y, i) => i > k && y.role !== "num" && y.role !== "unit") + 0
      const pos = k < 0 ? at : where < 0 ? n : where
      return { tokens: [...xs.slice(0, pos), ...word(pick(r, SECOND_NUMBERS)), ...xs.slice(pos)], label: "second number", benign: false }
    }
    case 18: {
      const [from, to] = pick(r, UNIT_SWAPS)
      const k = xs.findIndex((y) => y.text === from || y.text.endsWith(from))
      if (k < 0) return insert(word(pick(r, ["percent", "degrees", "%", "°"])), "unit added")
      return { tokens: xs.map((y, i) => (i === k ? { ...y, text: y.text.slice(0, y.text.length - from.length) + to, role: "word" as const } : y)), label: "unit swap", benign: false }
    }
    case 19: {
      const k = xs.findIndex((y) => y.role === "num" && firstOfGroup(xs, xs.indexOf(y)))
      const where = k < 0 ? w : k
      return { tokens: xs.map((y, i) => (i === where ? { ...y, text: `${pick(r, SIGN_FLIPS)}${y.text}`, role: "word" as const } : y)), label: "sign flip", benign: false }
    }
    default: {
      // Truncation in characters of the whole sentence.
      const s = sentenceOf(xs)
      const c = Math.floor(r() * s.length)
      return { tokens: word(s.slice(0, Math.max(1, c))), label: "truncate sentence", benign: false }
    }
  }
}

// ---------------------------------------------------------------------------
// The property.

const SEED = Number(process.env.PROPERTY_SEED ?? 20261114)
/** Instances, with openers and closers placed (for sampling). */
const adorned = (bodies: ReadonlyArray<Instance & { readonly dutch?: boolean }>, r: Rand, closers: ReadonlyArray<string>, openers = OPENERS): Instance => {
  const b = pick(r, bodies)
  const dutch = b.dutch === true
  const o = pick(r, dutch ? NL_OPENERS : openers)
  const c = pick(r, dutch ? NL_CLOSERS : closers)
  const q = o.ask && r() < 0.5 ? [{ text: "?", role: "q" as const }] : []
  return { tokens: [...t(o.text, "open"), ...b.tokens, ...t(c, "close"), ...q], meaning: b.meaning }
}

const BODIES = commandBodies()
/** The bodies checked one by one: every form, with a few values (the full set is only looked up). */
const FEW = /(?:level|temp)=(?:0|5|40|75|100|18\.5|20)(?: |$)|^(?!Act (?:set_brightness|set_heating))/
const CORE_BODIES = BODIES.filter((b) => FEW.test(b.meaning) && !/(?:^|\s)0\d|\.0|,0/.test(sentenceOf(b.tokens)) && (!b.meaning.startsWith("Act timer") || /duration=(?:600000|60000|3600000) ?/.test(b.meaning)))
const COMMANDS = new Instances(BODIES, OPENERS, CLOSERS, NL_OPENERS, NL_CLOSERS)
const BRIGHTNESS_BODIES = brightnessReplies()
const BRIGHTNESS = new Instances(BRIGHTNESS_BODIES, [{ text: "", ask: false }], REPLY_CLOSERS)
const CONFIRM_BODIES = confirmReplies()
const CONFIRM = new (class extends Instances {
  override meaning(sentence: string): string | undefined {
    return isConfirmInstance(sentence) ? "Act all_off" : undefined
  }
})(CONFIRM_BODIES, [{ text: "", ask: false }], [""])

interface Context {
  readonly name: "fresh" | "brightness" | "confirm"
  readonly pending?: PendingIntent
  readonly replies?: Instances
  readonly sample: (r: Rand) => Instance
}
const contexts = (): ReadonlyArray<Context> => [
  { name: "fresh", sample: (r) => adorned(BODIES, r, CLOSERS) },
  {
    name: "brightness",
    pending: pendingFrom("dim the kitchen", "set_brightness", { target: "area:kitchen" }, "Ask"),
    replies: BRIGHTNESS,
    sample: (r) => adorned(BRIGHTNESS_BODIES, r, REPLY_CLOSERS, [{ text: "", ask: false }])
  },
  { name: "confirm", pending: pendingFrom("switch everything off", "all_off", {}, "Confirm"), replies: CONFIRM, sample: (r) => pick(r, CONFIRM_BODIES) }
]

/** What a sentence must mean in a context, found in the set of instances (never by parsing it). */
const instanceMeaning = (sentence: string, ctx: Context): string | undefined => ctx.replies?.meaning(sentence) ?? COMMANDS.meaning(sentence)

/** Asking to confirm is no side effect: the action then runs only on a reply in the closed grammar (property 3). */
const counts = { confirmsOnNonInstances: [] as Array<string> }

/** Check one sentence; returns a violation message or undefined. `allowed`: the base meaning a benign edit may keep. */
const check = (sentence: string, ctx: Context, must: boolean, allowedList: ReadonlyArray<string> = []): string | undefined => {
  const allowed = allowedList.length > 0 ? allowedList.join(" or ") : undefined
  const want = instanceMeaning(sentence, ctx)
  const got = outcomesOf(sentence, ctx.pending)
  const acted = got.filter(runs)
  const confirms = got.filter((o) => o.startsWith("Confirm"))
  if (want === undefined && confirms.length > 0 && allowed === undefined) counts.confirmsOnNonInstances.push(`[${ctx.name}] ${JSON.stringify(sentence)}`)
  const ok = (o: string) => o === want || allowedList.includes(o)
  if (acted.some((o) => !ok(o))) return `[${ctx.name}] ${JSON.stringify(sentence)} acted: ${acted.join(", ")} (instance: ${want ?? "none"}${allowed !== undefined ? `, benign edit of: ${allowed}` : ""})`
  if (want !== undefined && must && !got.includes(want)) return `[${ctx.name}] ${JSON.stringify(sentence)} did not ${want.split(" ")[0]!.toLowerCase()} (instance: ${want}; got ${got.join(" | ")})`
  return undefined
}

/**
 * Every input quoted in the review findings of rounds 1–5 (docs/AGENTS-AND-INTENTS.md), adapted to
 * this house where they name a room it lacks. Each is checked fresh, as the answer to "What
 * brightness?" (for the kitchen) and as the answer to "Switch everything off?".
 */
const REGRESSIONS: ReadonlyArray<string> = [
  // rounds 1–2
  "dim the kitchen to -5 percent", "dim the kitchen to − 5 percent", "dim the kitchen to - 5 percent", "set the heating in the kitchen to 1.5 degrees",
  "zet de keuken op 1,5 procent", "dim the kitchen to 3-5 percent", "dim the kitchen to 40%", "dim the kitchen to 1,000 percent", "not the kitchen",
  "yes please", "ja, doe maar", "go ahead", "minus five", "negative 5", "min vijf", "negatief tien", "please", "do", "right", "go",
  "turn on the kitchen lights please do", "stop the timer",
  // round 3
  "turn on the kitchen lights quickly", "turn on the kitchen lights for my mother", "dim 3 lights in the kitchen to 40 percent",
  "dim 3 lights in the kitchen to 140 percent", "turn on the attic lights", "turn on rooms 3 and 5", "dim the kitchen to 3 - 5 percent",
  "40 percent quickly", "the kitchen at 40 percent", "dim the kitchen to one hundred 40 percent", "dim the kitchen to one point twenty five percent",
  "dim the kitchen to 1.234,5 percent", "dim the kitchen to forty 5", "dim the kitchen to five five", "dim the kitchen to 3 and 5",
  "dim the kitchen to five minus three", "the attic 40", "the kitchen 40", "set it to 40", "op veertig graag", "is that right", "is that okay",
  "do you", "shall I", "zal ik", "klopt dat", "that's right", "nimmer turn on the kitchen", "ne'er turn on the kitchen", "don t turn on the kitchen",
  "dim the kitchen to one hundred forty percent", "dim the kitchen to two hundred percent", "dim the kitchen to twenty-one percent",
  // round 4
  "yes?", "Yes.", "dim the kitchen to .5 percent", "dim the kitchen to –5 percent", "dim room two", "room two", "40 degrees",
  "dim the kitchen to 40 degrees", "I like the kitchen lights on", "will the kitchen lights turn on", "dim the kitchen to +40",
  "dim the kitchen to 4:30", "turn on room #2", "turn on the kitchen & the hall", "dim the kitchen to 5. percent", "dim the kitchen to 5.percent",
  "dim the kitchen to 5,percent", "dim the kitchen to 40,5", "turn on the kitchen lights?", "I want you to turn on the kitchen lights?", "turn it on",
  "make the kitchen 40 percent", "also turn on the kitchen", "turn on the kitchen too", "then turn on the kitchen", "the kitchen",
  "the bedroom 40", "turn the kitchen lights", "kitchen lights", "lights", "switch everything off", "set the kitchen to 20",
  "in de keuken doe het licht aan", "doe snel het licht aan in de keuken", "turning on the kitchen lights", "the kitchen lights turned on",
  "he said turn on the kitchen", "if it gets dark turn on the kitchen", "did you turn on the kitchen lights", "turn on quickly the kitchen",
  "the kitchen lights turn on", "turn on the kitchen lights for my", "turn on the forty degrees lamp", "the forty degrees lamp", "room two 40",
  "kamer twee", "can you turn on the kitchen lights?", "dim the kitchen to – 5 percent", "dim the kitchen to ‐5 percent",
  // round 5 (the review, and what this property found)
  "turn on room -two", "turn on room –two", "turn on room two%", "turn on room two°", "turn on the kitchen lights at",
  "turn on the kitchen lights to", "turn on the kitchen lights for", "turn on the kitchen lights for my please", "dim the kitchen at 7",
  "hey jev switch everything off", "yes", "five", "five?", "set it to five?", "turn on the kitch", "dim the room t٠wo to 40 percent",
  "dim the room, two to 40 percent", ",dim the room two to 40 percent", "dim forty the degrees lamp to 100 percent", "dim the kitchen to 4²",
  "dim the kitchen to ４０ percent", "seventy‑ five", "dim the kitchen to seventy‑ five percent", "dim the kitchen to seventy -five percent",
  "set the kitchen to 35", "set the kitchen to 3", "-0", "minus zero", "dim the kitchen to -0 percent", ",0", ".0", "the kitchen to ,0 thanks",
  "at set the kitchen to 74 percent", "the dim the kitchen to 40 percent", "ok the dim OK lamp to 81 percent", "the kitchen a`t 82",
  ",nu correct yeah", "yes,ok", "dim the lamp in in the hall to 40 percent", "dim the desk to lamp 40 percent", "dim the lamp desk to 40 percent",
  "start a timer for t eight seconds", "dim the kitchen to t 40 percent", "turn on the kitchen lights for my now", "dim the kitchen at seven",
  // round 6 (the review)
  "dim the lamp in the to hall to 40 percent", "dim the kitchen in 40 percent", "turn on the bedroom's please", "turn on the living room's",
  "turn on the bedroom's", "turn on the kitchen's", "turn on the kitchen's now", "dim the bedroom's to 40 percent", "turn on the kitchens"
]

describe("property: the intent path acts if and only if the sentence is a template instance", { timeout: 60_000 }, () => {
  it("every unadorned instance, and a sample of adorned ones, acts with exactly its recorded meaning", () => {
    const r = prng(SEED)
    const failures: Array<string> = []
    const [fresh, brightness, confirm] = contexts()
    for (const b of CORE_BODIES) {
      const v = check(sentenceOf(b.tokens), fresh!, true)
      if (v !== undefined) failures.push(v)
    }
    for (let n = 0; n < 400; n++) {
      const i = fresh!.sample(r)
      const v = check(sentenceOf(i.tokens), fresh!, true)
      if (v !== undefined) failures.push(v)
    }
    for (let n = 0; n < 300; n++) {
      for (const ctx of [brightness!, confirm!]) {
        const v = check(sentenceOf(ctx.sample(r).tokens), ctx, true)
        if (v !== undefined) failures.push(v)
      }
    }
    assert.deepStrictEqual(failures.slice(0, 40), [], `seed ${SEED}; ${failures.length} failures`)
  })

  it("every regression input of rounds 1–5, in all three contexts", () => {
    const failures: Array<string> = []
    for (const c of contexts()) {
      for (const s of REGRESSIONS) {
        const v = check(s, c, false)
        if (v !== undefined) failures.push(v)
      }
    }
    assert.deepStrictEqual(failures, [])
  })

  it("truncation after every word and at every character never acts unless the prefix is itself an instance", () => {
    const failures: Array<string> = []
    const r = prng(SEED + 1)
    for (const ctx of contexts()) {
      const sample = ctx.name === "fresh" ? [...CORE_BODIES.filter((_, i) => i % 4 === 0), ...Array.from({ length: 100 }, () => ctx.sample(r))] : Array.from({ length: 40 }, () => ctx.sample(r))
      for (const i of sample) {
        const s = sentenceOf(i.tokens)
        const ws = s.split(" ")
        for (let k = 1; k < ws.length; k++) {
          const v = check(ws.slice(0, k).join(" "), ctx, false)
          if (v !== undefined) failures.push(v)
        }
      }
      for (const i of sample.filter((_, k) => k % 12 === 0)) {
        const s = sentenceOf(i.tokens)
        for (let k = 1; k < s.length; k++) {
          // A cut that only drops a doubled letter ("hal" for "hall") is the documented spelling tolerance.
          const end = s.indexOf(" ", k) < 0 ? s.length : s.indexOf(" ", k)
          const whole = instanceMeaning(s.slice(0, end), ctx)
          const same = whole !== undefined && runs1(key(s.slice(0, k))) === runs1(key(s.slice(0, end))) ? [whole] : []
          const v = check(s.slice(0, k), ctx, false, same)
          if (v !== undefined) failures.push(v)
        }
      }
    }
    assert.deepStrictEqual([...new Set(failures)].slice(0, 40), [])
  })

  it("every symbol at every character position of sentences with number words, digits, units and names with them", () => {
    const failures: Array<string> = []
    const [fresh, brightness] = contexts()
    const probes: ReadonlyArray<readonly [string, Context]> = [
      ["dim the room two to 40 percent", fresh!], ["turn on the room 3", fresh!], ["dim the forty degrees lamp to 5%", fresh!],
      ["set the heating in the kitchen to 18.5 degrees", fresh!], ["turn on the lamp in the hall", fresh!],
      ["seventy five percent", brightness!]
    ]
    for (const [s, ctx] of probes) {
      for (let c = 0; c <= s.length; c++) {
        for (const sym of SYMBOLS) {
          const v = check(s.slice(0, c) + sym + s.slice(c), ctx, false)
          if (v !== undefined) failures.push(v)
        }
      }
    }
    assert.deepStrictEqual([...new Set(failures)].slice(0, 40), [])
  })

  it("random edits (1–3 each) of instances, fresh and as replies; eager/final promotion", () => {
    const CASES = Number(process.env.PROPERTY_CASES ?? 3_000)
    const r = prng(SEED + 2)
    const cs = contexts()
    const failures: Array<string> = []
    let acted = 0
    let instances = 0
    let benignCount = 0
    const otherName: Array<string> = []
    const start = performance.now()
    for (let n = 0; n < CASES; n++) {
      const ctx = cs[n % 3]!
      const base = ctx.sample(r)
      let tokens = base.tokens
      const labels: Array<string> = []
      let benign = true
      const edits = 1 + Math.floor(r() * 3)
      for (let e = 0; e < edits; e++) {
        const m = mutate(r, tokens)
        tokens = m.tokens
        labels.push(m.label)
        benign &&= m.benign
      }
      const text = sentenceOf(tokens)
      if (text.trim().length === 0) continue
      if (instanceMeaning(text, ctx) !== undefined) instances++
      if (outcomesOf(text, ctx.pending).some(runs)) acted++
      const allowed = ctx.name === "confirm" ? [] : benignMeanings(base, tokens, ctx.name === "brightness" ? { target: "area:kitchen", words: ["it", "make", "maak"] } : undefined)
      if (allowed.length > 0) benignCount++
      if (allowed.some((a) => a !== base.meaning)) otherName.push(text)
      const v = check(text, ctx, false, allowed)
      if (v !== undefined) failures.push(`${v} [${labels.join(", ")} of ${JSON.stringify(sentenceOf(base.tokens))}]`)
      // Promotion: eager = the instance, final = one edit of it. Promoted (`sameUtterance`) ⇒ the same instance.
      const one = sentenceOf(mutate(r, base.tokens).tokens)
      const eager = sentenceOf(base.tokens)
      if (sameUtterance(eager, one) && key(eager) !== key(one)) failures.push(`promoted: eager ${JSON.stringify(eager)} final ${JSON.stringify(one)}`)
    }
    const ms = performance.now() - start
    console.log(`property round 5 (seed ${SEED}): ${CASES} edited sentences in ${ms.toFixed(0)} ms; ${instances} are instances, ${benignCount} benign edits, ${acted} acted on, ${failures.length} violations; ${counts.confirmsOnNonInstances.length} confirmation questions on non-instances; benign results that may act on another whole name: ${otherName.length} (${otherName.slice(0, 3).map((x) => JSON.stringify(x)).join(", ")})`)
    assert.deepStrictEqual(failures.slice(0, 40), [], `seed ${SEED}`)
  })
})
