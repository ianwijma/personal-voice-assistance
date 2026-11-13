import { Duration, Effect, Schema } from "effect"
import { type ActionParam, type ActionParams, MAX_CHOICE_OPTIONS, type ParamOption, paramOptions, type RegisteredAction } from "./Actions.ts"
import {
  account,
  type AccountResult,
  actionWords,
  allOptionMentions,
  type AmbiguousSpan,
  assignRoles,
  shadowingOptions,
  TIME_BEFORE_DURATION,
  TIME_BEFORE_NUMBER,
  type CharSpan,
  type Mention,
  mentionChars,
  NUMBER_ROLE,
  type RoleCandidate,
  spanOfText,
  stemWord,
  type WordSpan,
  wordsIn
} from "./Accounting.ts"
import { defaultIntentWords, type IntentWords, isConfirmation, isNegated, isProhibited, replyWords } from "./IntentWords.ts"
import { normalizeWord, type Word, words } from "./TextMatching.ts"
import { type Mark, readUtterance } from "./Utterance.ts"
import { numericSpans, paramUnit, unitFits } from "./ValueParsing.ts"

/**
 * The typed-intent decision (docs/AGENTS-AND-INTENTS.md §3).
 *
 * A `DecisionProvider` answers typed questions about an utterance: a choice
 * among named options, or a yes/no probability. That is exactly what TypeSafe's
 * Jev does (its System One API; a local Nimble model behind Ollama speaks the
 * same shape), and what an offline keyword matcher or a small local classifier
 * can do too, so the provider is swappable.
 *
 * `buildDecisionPlan` assembles ONE request per utterance from the running
 * modules' actions: which action, does any action fit at all (the companion
 * yes/no question, since a choice always picks something), is it several
 * actions at once, and for every action every parameter the model can choose
 * (asked for all actions at once and read only for the chosen one: one round
 * trip). Numbers, durations and free text are found by local code first.
 * `interpretDecision` turns the answers into an outcome with thresholds. Both
 * are pure. The intent agent (build plan piece C) calls the provider between them.
 */

// ---------------------------------------------------------------------------
// Provider interface

/** Why a question is asked, for providers that cannot read instructions (the offline keyword decider). Jev ignores it. */
export type QuestionRole =
  | { readonly kind: "action" }
  /**
   * `unexplained`: for each action, the words of the utterance nothing explains
   * when that action is meant with any of its values (core's accounting rule,
   * "Review fixes, third round"); a provider that cannot read meaning (the
   * keyword decider) uses it: an action with unexplained words does not fit.
   */
  | { readonly kind: "fits"; readonly unexplained?: Readonly<Record<string, ReadonlyArray<string>>> }
  | { readonly kind: "compound" }
  | { readonly kind: "param"; readonly action: string; readonly param: string }
  | { readonly kind: "stated"; readonly action: string; readonly param: string }
  | { readonly kind: "flag"; readonly action: string; readonly param: string }
  /**
   * A question is pending: does the utterance answer it? `reading`: core's own
   * reading of the reply (`ReplyReading`), for providers that cannot read meaning;
   * whatever a provider answers, only a reply core reads as an answer can be one.
   */
  | { readonly kind: "answers"; readonly reading?: ReplyReading["kind"] }
  /** A confirmation is pending: does the utterance say yes? */
  | { readonly kind: "yes" }

export type DecisionQuestion =
  | {
    readonly type: "choice"
    readonly instructions: string
    /** Option id → description of when it applies (or `null`: the id says it all). At most 255. */
    readonly options: Readonly<Record<string, string | null>>
    readonly role: QuestionRole
  }
  | { readonly type: "noul"; readonly instructions: string; readonly role: QuestionRole }

export interface DecisionRequest {
  /** Sent to the provider as its `state`. Only the utterance and the action labels: nothing else about the owner. */
  readonly state: {
    readonly utterance: string
    readonly available_actions: Readonly<Record<string, string>>
    readonly question_asked?: string
  }
  readonly questions: Readonly<Record<string, DecisionQuestion>>
}

export type DecisionAnswer =
  | { readonly type: "choice"; readonly choice: string; readonly probabilities: Readonly<Record<string, number>> }
  | { readonly type: "noul"; readonly value: number }

export interface DecisionResponse {
  /** By question name. A missing answer counts as probability 0. */
  readonly answers: Readonly<Record<string, DecisionAnswer>>
  /** The model version that answered, when the provider reports it. */
  readonly model?: string
}

export class DecisionError extends Schema.TaggedError<DecisionError>()("DecisionError", {
  message: Schema.String,
  reason: Schema.Literals(["timeout", "unavailable", "rejected", "invalid"]),
  cause: Schema.optional(Schema.Defect())
}) {}

export interface DecisionProvider {
  /** Module id ("jev-typesafe", "keywords"). */
  readonly id: string
  readonly name: string
  readonly location: "local" | "hosted"
  /** One round trip. Must respect its own timeout (no retries on the voice path) and be interruptible. */
  readonly decide: (request: DecisionRequest) => Effect.Effect<DecisionResponse, DecisionError>
}

/** A provider that answers from a function, for tests and the build plan's stand-ins. */
export const makeScriptedDecider = (
  respond: (request: DecisionRequest) => DecisionResponse | DecisionError,
  options: { readonly id?: string; readonly latency?: Duration.Input } = {}
): DecisionProvider & { readonly requests: ReadonlyArray<DecisionRequest> } => {
  const requests: Array<DecisionRequest> = []
  return {
    id: options.id ?? "scripted",
    name: "Scripted",
    location: "local",
    requests,
    decide: (request) =>
      Effect.suspend(() => {
        requests.push(request)
        const answer = respond(request)
        const result = answer instanceof DecisionError ? Effect.fail(answer) : Effect.succeed(answer)
        return options.latency === undefined ? result : Effect.delay(result, options.latency)
      })
  }
}

/** A choice answer whose `choice` is the most probable option. */
export const choiceAnswer = (probabilities: Readonly<Record<string, number>>): DecisionAnswer => {
  let choice = ""
  let best = -1
  for (const [option, p] of Object.entries(probabilities)) {
    if (p > best) {
      best = p
      choice = option
    }
  }
  return { type: "choice", choice, probabilities }
}

// ---------------------------------------------------------------------------
// Plan

/** A number or duration found in the utterance by local code (build plan piece C writes the English + Dutch parser). */
export interface ValueCandidate {
  /** As said ("forty percent", "tien minuten"). */
  readonly text: string
  /** The value (durations in milliseconds). NaN: said as a number, but not readable as exactly one (never accepted). */
  readonly value: number
  /** Character offsets of `text` in the utterance, when the parser knows them (else the first occurrence of `text` is used). */
  readonly start?: number
  readonly end?: number
  /**
   * The number unit said with it ("percent", "degree"), when the parser read one. Core reads the
   * unit of every span itself as well (`numericSpans`); a number is a value of a parameter only
   * with no unit or the parameter's own unit (`unitFits`).
   */
  readonly unit?: string
}

export type ValueParser = (kind: "number" | "duration", utterance: string) => ReadonlyArray<ValueCandidate>

/** Finds nothing: number and duration parameters are then always missing. */
export const noValueParser: ValueParser = () => []

/** An action waiting for an answer from the owner (a missing parameter, or a yes). Held by the intent agent between turns. */
export interface PendingIntent {
  readonly action: RegisteredAction
  /** Values decided so far. */
  readonly params: Readonly<Record<string, unknown>>
  /** Required parameters still missing, in declaration order; the first is the one asked about. */
  readonly missing: ReadonlyArray<string>
  readonly awaiting:
    | { readonly kind: "param"; readonly param: string; readonly question: string }
    | { readonly kind: "confirm"; readonly question: string }
  /** The probability the action rests on so far. */
  readonly probability: number
}

/** A duration in milliseconds as spoken words ("1 hour 30 minutes", "45 seconds"). */
const spokenDuration = (ms: number): string => {
  const parts: Array<string> = []
  let rest = Math.round(ms / 1000)
  for (const [unit, size] of [["hour", 3600], ["minute", 60], ["second", 1]] as const) {
    const n = Math.floor(rest / size)
    rest -= n * size
    if (n > 0) parts.push(`${n} ${unit}${n === 1 ? "" : "s"}`)
  }
  return parts.length === 0 ? "0 seconds" : parts.join(" ")
}

/**
 * How a value is SAID in a confirmation question (review round 7): an option's label, a number
 * with its unit, a duration in words, yes/no, the text itself. Undefined when it cannot be said
 * (an option no longer offered), so nothing is asked about it.
 */
export const spokenValue = (param: ActionParam, value: unknown): string | undefined => {
  switch (param.kind) {
    case "choice":
    case "dynamic":
      return paramOptions(param).find((o) => o.value === value)?.label
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined
      const unit = param.unit === undefined ? undefined : paramUnit(param.unit) === "percent" ? "percent" : param.unit
      return unit === undefined ? String(value) : `${String(value)} ${unit}`
    }
    case "duration":
      return typeof value === "number" && Number.isFinite(value) ? spokenDuration(value) : undefined
    case "boolean":
      return value === true ? "yes" : value === false ? "no" : undefined
    case "text":
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
  }
}

/** The values that will be executed, as `[param, spoken]` in declaration order (unset optional values left out). */
const stated = (action: RegisteredAction, params: Readonly<Record<string, unknown>>): Array<{ readonly name: string; readonly param: ActionParam; readonly value: unknown; readonly spoken: string | undefined }> =>
  Object.entries(action.definition.params as ActionParams).flatMap(([name, param]) => {
    const value = params[name]
    return value === undefined ? [] : [{ name, param, value, spoken: spokenValue(param, value) }]
  })

/** "Reset the room (room: Bedroom)": the action and its values, for history notes. */
export const describeProposal = (action: RegisteredAction, params: Readonly<Record<string, unknown>>): string => {
  const values = stated(action, params).map((v) => `${lowerFirst(v.param.label)}: ${v.spoken ?? String(v.value)}`)
  return values.length === 0 ? action.definition.label : `${action.definition.label} (${values.join(", ")})`
}
const lowerFirst = (s: string) => (s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s)

/**
 * The question that asks the owner to confirm `action` with `params`, always core's own (after the
 * final review): the label followed by each parameter's label and spoken value, a number with its
 * unit ("Set the level: room Kitchen, level 40 percent?"); with no values, the label with "?". A
 * module's own confirmation text (`confirm` as a function) is never called: free text cannot be
 * verified to state the values (a negation, swapped values or a wrong unit passed every check).
 * A value that cannot be said REFUSES the proposal (`refused` says why).
 */
export const confirmationQuestion = (
  action: RegisteredAction,
  params: Readonly<Record<string, unknown>>
): { readonly question: string } | { readonly refused: string } => {
  const def = action.definition
  const values = stated(action, params)
  const unsaid = values.find((v) => v.spoken === undefined)
  if (unsaid !== undefined) return { refused: `the value of ${unsaid.name} cannot be stated.` }
  if (values.length === 0) return { question: `${def.label}?` }
  return { question: `${def.label}: ${values.map((v) => `${lowerFirst(v.param.label)} ${v.spoken}`).join(", ")}?` }
}

/** `confirmationQuestion`'s text, or "" when the proposal would be refused (informational: core asks its own). */
export const confirmQuestion = (action: RegisteredAction, params: Readonly<Record<string, unknown>>): string => {
  const q = confirmationQuestion(action, params)
  return "question" in q ? q.question : ""
}

/**
 * Whether a pending intent may still be used in a turn offering `actions`: its
 * action must be the very registration offered now (a disabled or reconfigured
 * module registers new ones, so an old confirmation never carries over to a new
 * implementation), and every dynamic value chosen so far must still be offered.
 */
export const pendingStillValid = (intent: PendingIntent, actions: ReadonlyArray<RegisteredAction>): boolean => {
  if (!actions.includes(intent.action)) return false
  try {
    for (const [name, value] of Object.entries(intent.params)) {
      const param = intent.action.definition.params[name] as ActionParam | undefined
      if (param?.kind === "dynamic" && value !== undefined && !paramOptions(param).some((o) => o.value === value)) return false
    }
  } catch {
    return false // the module's option list failed: do not act on a value it cannot vouch for
  }
  return true
}

interface PlanOption {
  readonly value: unknown
  /** Display text (UI, details). */
  readonly label: string
  /** What the decision model reads: label, aliases, description. */
  readonly criterion: string
  /** A number said in the utterance that the parameter does not accept (out of range): if chosen, it is asked for again. */
  readonly invalid?: true
  /** The parameter value it stands for (choice and dynamic parameters). */
  readonly option?: ParamOption
  /** Where a number candidate was said (character offsets). */
  readonly start?: number
  readonly end?: number
}

/** How one parameter of one action gets its value. */
export type ParamPlan =
  /** Known without asking (the only number found, text taken from the sentence); `start`/`end`: where it was said. */
  | { readonly kind: "fixed"; readonly value: unknown; readonly label: string; readonly start?: number; readonly end?: number }
  /**
   * Nothing to choose from: no number found, no text after the marker words, an
   * empty dynamic list. `invalid`: the only number said, which the parameter does
   * not accept ("140 percent"); it is asked for again, even for an optional parameter.
   */
  | { readonly kind: "missing"; readonly invalid?: string; readonly start?: number; readonly end?: number }
  /**
   * Asked as a choice, always with a "none of these" option (`none`): a value the
   * utterance names that is not offered must not become the closest one offered.
   * `stated` names the yes/no question "does it say which?", asked for optional
   * parameters and for a required one with a single value (`only`): when the
   * utterance does not say which, the default or that single value is used;
   * when it does, the choice must pick it.
   */
  | {
    readonly kind: "choice"
    readonly question: string
    readonly options: ReadonlyMap<string, PlanOption>
    readonly stated?: string
    readonly only?: { readonly value: unknown; readonly label: string }
  }
  /** Asked as a yes/no question. */
  | { readonly kind: "flag"; readonly question: string }

export interface DecisionPlan {
  readonly request: DecisionRequest
  /** As given (sent to the provider). */
  readonly utterance: string
  /** Its canonical text (`canonicalUtterance`): what core's parser and accounting read; offsets refer to it. */
  readonly text: string
  /** The actions offered, in request order (at most 255). */
  readonly actions: ReadonlyArray<RegisteredAction>
  /** Action id → parameter name → plan. */
  readonly params: ReadonlyMap<string, ReadonlyMap<string, ParamPlan>>
  readonly pending?: {
    readonly intent: PendingIntent
    readonly answer: ParamPlan | undefined
    /** Core's reading of the reply, from the reply text and the pending question alone (whatever the provider says). */
    readonly reading: ReplyReading
  }
  /** Per offered action: what core's accounting rule needs to check a request for it. */
  readonly accounting: ReadonlyMap<string, ActionAccounting>
  /**
   * Per offered action: the accounting if it were meant with any of its values (the `fits` role;
   * compared between actions), and how many required parameters it would still have to ask for.
   */
  readonly explained: ReadonlyMap<string, AccountResult & { readonly missing: number }>
  /** Things the owner should know (shown in the agent's status line): truncated lists, empty dynamic lists. */
  readonly warnings: ReadonlyArray<string>
  /** Actions left out of this request because a module's option list failed (the rest are still offered). */
  readonly unavailable: ReadonlyArray<{ readonly actionId: string; readonly message: string }>
}

/**
 * Core's reading of a reply to a pending question or confirmation. A reply is an
 * answer only if it is nothing but an answer: the value (one number span, or one
 * option's name or alias), optionally the question's own words (the parameter's
 * label and unit, the action's own words, the spoken question) and fillers.
 */
export type ReplyReading =
  /** Nothing but the value. `option`: the option named (choice and dynamic parameters). */
  | { readonly kind: "answer"; readonly value: unknown; readonly label: string; readonly option?: string }
  /** Nothing but a number the parameter does not take ("140 percent"): asked again. */
  | { readonly kind: "invalid"; readonly said: string }
  /** A confirmation by core's phrase grammar ("yes please", "ja, doe maar", "go ahead"). */
  | { readonly kind: "confirmation" }
  /** Anything else: planned as a fresh request, with no memory of the pending one. */
  | { readonly kind: "other"; readonly unexplained: ReadonlyArray<string> }

/** A number span of the utterance: words, characters (sign, decimal mark and "%"/"°" included) and the unit said with it. */
export interface NumberSpanRole extends WordSpan {
  readonly start: number
  readonly end: number
  readonly unit?: string
}

/** What core's accounting rule needs about one offered action in this utterance (review rounds 3 and 4). */
export interface ActionAccounting {
  /** The canonical text (`canonicalUtterance`), its words and its significant marks. */
  readonly text: string
  readonly ws: ReadonlyArray<Word>
  readonly marks: ReadonlyArray<Mark>
  /** The action's own words (stems). */
  readonly vocabulary: ReadonlySet<string>
  /** The action's verbs (stems): a request says them before any other content word. */
  readonly verbs: ReadonlySet<string>
  /** Names of its choice and dynamic parameters' values said in the utterance, by parameter: only those that keep that role. */
  readonly mentions: ReadonlyMap<string, ReadonlyArray<Mention>>
  /** Every number span of the utterance (core's scanner and the plan's parser). */
  readonly numbers: ReadonlyArray<NumberSpanRole>
  /** The number spans that keep the number role (not inside a longer option name, not ambiguous). */
  readonly values: ReadonlyArray<NumberSpanRole>
  /** Spans with two possible roles: never a value; covered only when a parameter they could fill is asked about. */
  readonly ambiguous: ReadonlyArray<AmbiguousSpan>
  /** Every span explained only as a value: names said, number spans, ambiguous spans. */
  readonly reserved: ReadonlyArray<WordSpan>
}

/** Question names. Ids contain only `[a-z0-9_.-]`, so `/` and `?` cannot clash. */
export const Q = {
  action: "action",
  fits: "fits",
  compound: "compound",
  param: (actionId: string, param: string) => `${actionId}/${param}`,
  stated: (actionId: string, param: string) => `${actionId}/${param}?`,
  pendingAnswer: "pending/answer",
  pendingAnswers: "pending/answers",
  pendingYes: "pending/yes"
} as const

const NONE = "none"

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

/** Criterion for an action option: label, description, examples. */
const actionCriterion = (action: RegisteredAction): string => {
  const d = action.definition
  const examples = (d.examples ?? []).slice(0, 4)
  return `${sentence(d.label)} ${d.description}` +
    (examples.length === 0 ? "" : ` For example: ${examples.map((e) => `"${e}"`).join("; ")}.`)
}

/** Criterion for a parameter value: label, aliases, description. */
const optionCriterion = (option: ParamOption): string =>
  option.label +
  (option.aliases !== undefined && option.aliases.length > 0 ? ` (also called: ${option.aliases.join(", ")})` : "") +
  (option.description !== undefined ? `: ${option.description}` : "")

const lower = (s: string) => s.toLowerCase()

const defaultQuestion = (param: ActionParam): string =>
  param.question ?? (param.kind === "number" || param.kind === "duration"
    ? `Which number in the utterance gives the ${lower(param.label)}?`
    : `Which ${lower(param.label)} does the utterance refer to?`)

/** The spoken question for a missing value. */
export const askFor = (param: ActionParam): string =>
  param.ask ?? (param.kind === "choice" || param.kind === "dynamic" ? `Which ${lower(param.label)}?` : `What ${lower(param.label)}?`)

/**
 * The words after the first marker word, up to `maxWords`, as said; or the whole
 * utterance when there are no markers. A marker right after one of `notAfter`
 * is not one ("wat voor weer").
 */
export const extractText = (utterance: string, after: ReadonlyArray<string>, maxWords = 8, notAfter: ReadonlyArray<string> = []): string | undefined => {
  const ws = words(utterance)
  let from = 0
  if (after.length > 0) {
    const markers = new Set(after.map(normalizeWord))
    const not = new Set(notAfter.map(normalizeWord))
    const at = ws.findIndex((w, i) => markers.has(w.norm) && !(i > 0 && not.has(ws[i - 1]!.norm)))
    if (at < 0) return undefined
    from = at + 1
  }
  const taken = ws.slice(from, from + maxWords)
  if (taken.length === 0) return undefined
  return utterance.slice(taken[0]!.start, taken[taken.length - 1]!.end)
}

/** Offset of the text `extractText` took. */
const textStart = (utterance: string, after: ReadonlyArray<string>, notAfter: ReadonlyArray<string> = [], value: string): number => {
  const ws = words(utterance)
  const markers = new Set(after.map(normalizeWord))
  const not = new Set(notAfter.map(normalizeWord))
  const at = after.length === 0 ? -1 : ws.findIndex((w, i) => markers.has(w.norm) && !(i > 0 && not.has(ws[i - 1]!.norm)))
  return utterance.indexOf(value, at < 0 ? 0 : ws[at]!.end)
}

const inRange = (param: ActionParam, value: number): boolean => {
  // A signed zero ("-0", "minus zero") is a sign flip of 0, never a value (round 5).
  if (!Number.isFinite(value) || Object.is(value, -0)) return false
  if (param.kind === "number") {
    if (param.integer === true && !Number.isInteger(value)) return false
    return (param.min === undefined || value >= param.min) && (param.max === undefined || value <= param.max)
  }
  if (param.kind === "duration") {
    if (value < 0) return false
    return (param.minMs === undefined || value >= param.minMs) && (param.maxMs === undefined || value <= param.maxMs)
  }
  return true
}

/** The "none of these" option of every choice question. */
const noneOption: PlanOption = { value: undefined, label: "none of these", criterion: "None of these: the utterance names something else, or nothing" }

const planParam = (
  name: string,
  param: ActionParam,
  utterance: string,
  /** The number or duration candidates this parameter may take (one role per span, a fitting unit). */
  candidatesFor: (param: ActionParam) => ReadonlyArray<ValueCandidate>,
  warn: (message: string) => void,
  actionId: string,
  /** The parameter's values, read once per plan (a module's list may be slow, change, or throw). */
  optionsOf: (param: ActionParam) => ReadonlyArray<ParamOption>,
  /** Planned as if required (the answer to a pending question). */
  asRequired = false
): ParamPlan => {
  const optional = param.optional === true && !asRequired
  switch (param.kind) {
    case "choice":
    case "dynamic": {
      const all = optionsOf(param)
      const room = MAX_CHOICE_OPTIONS - 1 // one place is the "none of these" option
      if (all.length > room) warn(`${actionId}: ${param.label} has ${all.length} values; only the first ${room} are offered`)
      const opts = all.slice(0, room)
      if (opts.length === 0) {
        warn(`${actionId}: ${param.label} has no values to choose from`)
        return { kind: "missing" }
      }
      const options = new Map<string, PlanOption>(opts.map((o) => [o.value, { value: o.value, label: o.label, criterion: optionCriterion(o), option: o }] as const))
      if (!options.has(NONE)) options.set(NONE, noneOption)
      // A single value is used only when the utterance names none: "only available" is not "requested".
      if (opts.length === 1 && !optional) {
        return { kind: "choice", question: defaultQuestion(param), options, stated: Q.stated(actionId, name), only: { value: opts[0]!.value, label: opts[0]!.label } }
      }
      return optional
        ? { kind: "choice", question: defaultQuestion(param), options, stated: Q.stated(actionId, name) }
        : { kind: "choice", question: defaultQuestion(param), options }
    }
    case "number":
    case "duration": {
      // Which number gives the value is decided before its range is checked: a value
      // out of range is asked for again, never replaced by another number of the sentence.
      const candidates = candidatesFor(param)
      if (candidates.length === 0) return { kind: "missing" }
      if (candidates.length === 1) {
        const only = candidates[0]!
        const at = only.start !== undefined && only.end !== undefined ? { start: only.start, end: only.end } : {}
        return inRange(param, only.value) ? { kind: "fixed", value: only.value, label: only.text, ...at } : { kind: "missing", invalid: only.text, ...at }
      }
      const options = new Map<string, PlanOption>(candidates.map((c, i) =>
        [`c${i}`, {
          value: c.value,
          label: c.text,
          criterion: c.text,
          ...(inRange(param, c.value) ? {} : { invalid: true as const }),
          ...(c.start !== undefined && c.end !== undefined ? { start: c.start, end: c.end } : {})
        }] as const
      ))
      options.set(NONE, { value: undefined, label: "none of these", criterion: "None of these" })
      return { kind: "choice", question: defaultQuestion(param), options }
    }
    case "boolean":
      return { kind: "flag", question: param.question }
    case "text": {
      const value = extractText(utterance, param.after, param.maxWords, param.notAfter)
      if (value === undefined) return { kind: "missing" }
      // extractText takes the words after the first marker: the first occurrence of the value at or after it.
      const start = textStart(utterance, param.after, param.notAfter, value)
      return { kind: "fixed", value, label: value, ...(start >= 0 ? { start, end: start + value.length } : {}) }
    }
  }
}

const choiceQuestion = (plan: Extract<ParamPlan, { kind: "choice" }>, role: QuestionRole): DecisionQuestion => {
  const options: Record<string, string | null> = {}
  for (const [id, option] of plan.options) options[id] = option.criterion
  return { type: "choice", instructions: plan.question, options, role }
}

/** A parameter's value list, read once per plan; a failure is remembered too, so a list is never read twice. */
type OptionsRead = { readonly ok: ReadonlyArray<ParamOption> } | { readonly error: unknown }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Where a candidate was said, as words (by its offsets, else the first occurrence of its text). */
const candidateSpan = (text: string, ws: ReadonlyArray<Word>, c: ValueCandidate): WordSpan | undefined =>
  c.start !== undefined && c.end !== undefined ? wordsIn(ws, c.start, c.end) : spanOfText(text, ws, c.text)

/** Where a fixed value was said: a number's offsets, or the text taken (with the marker word before it). */
const fixedSpans = (utterance: string, ws: ReadonlyArray<Word>, plan: { readonly label: string; readonly start?: number; readonly end?: number }, param: ActionParam): Array<WordSpan> => {
  if (plan.start !== undefined && plan.end !== undefined) {
    const span = wordsIn(ws, plan.start, plan.end)
    if (span === undefined) return []
    // A text value: its marker word ("in", "voor") is part of it.
    return param.kind === "text" && span.from > 0 ? [{ from: span.from - 1, to: span.to }] : [span]
  }
  const span = spanOfText(utterance, ws, plan.label)
  return span === undefined ? [] : [span]
}

const UNIT_WORDS = new Set(["percent", "procent", "pct", "degree", "degrees", "graad", "graden"])

const containsSpan = (outer: WordSpan, inner: WordSpan) => outer.from <= inner.from && inner.to <= outer.to
const overlapping = (a: WordSpan, b: WordSpan) => a.from < b.to && b.from < a.to

/** One utterance read for planning: its canonical text (the shared normalisation), words, marks and every number span. */
interface PlanText {
  readonly text: string
  readonly ws: ReadonlyArray<Word>
  readonly marks: ReadonlyArray<Mark>
  /** Every number span: core's scanner, and the parser's candidates where core found none. */
  readonly numbers: ReadonlyArray<NumberSpanRole>
  readonly numberCandidates: ReadonlyArray<ValueCandidate>
  readonly durationCandidates: ReadonlyArray<ValueCandidate>
}

const readPlanText = (utterance: string, parse: ValueParser): PlanText => {
  const { text, words: ws, marks } = readUtterance(utterance)
  const numberCandidates = parse("number", text)
  const durationCandidates = parse("duration", text)
  const numbers: Array<NumberSpanRole> = numericSpans(text, ws).map((s) => ({ from: s.from, to: s.to, start: s.start, end: s.end, ...(s.unit !== undefined ? { unit: s.unit } : {}) }))
  for (const c of [...numberCandidates, ...durationCandidates]) {
    const span = candidateSpan(text, ws, c)
    if (span === undefined || numbers.some((n) => overlapping(n, span))) continue
    numbers.push({ ...span, start: c.start ?? ws[span.from]!.start, end: c.end ?? ws[span.to - 1]!.end, ...(c.unit !== undefined ? { unit: c.unit } : {}) })
  }
  return { text, ws, marks, numbers, numberCandidates, durationCandidates }
}

/**
 * Assign the roles of one action's spans (`assignRoles`): its parameters' option names
 * and every number span, the longest first, ambiguity kept.
 */
const accountingFor = (
  t: PlanText,
  action: RegisteredAction,
  optionsOf: (param: ActionParam) => ReadonlyArray<ParamOption>,
  lists: IntentWords
): ActionAccounting => {
  const candidates: Array<RoleCandidate> = []
  const raw: Array<WordSpan> = []
  for (const [name, param] of Object.entries(action.definition.params as ActionParams)) {
    if (param.kind !== "choice" && param.kind !== "dynamic") continue
    const offered = optionsOf(param).slice(0, MAX_CHOICE_OPTIONS - 1)
    for (const m of allOptionMentions(t.ws, offered)) {
      candidates.push({ from: m.from, to: m.to, role: name, option: m.option, ...(m.possessive === true ? { possessive: true as const } : {}) })
      raw.push(m)
      // A broken longer name containing this one: the same words could mean it (asked, never the shorter one).
      for (const other of shadowingOptions(t.ws, m, offered, lists.filler)) candidates.push({ from: m.from, to: m.to, role: name, option: other })
    }
  }
  for (const n of t.numbers) candidates.push({ from: n.from, to: n.to, role: NUMBER_ROLE })
  const roles = assignRoles(candidates)
  const mentions = new Map<string, Array<Mention>>()
  for (const [name, param] of Object.entries(action.definition.params as ActionParams)) {
    if (param.kind === "choice" || param.kind === "dynamic") mentions.set(name, [])
  }
  const values: Array<NumberSpanRole> = []
  for (const r of roles.taken) {
    if (r.role === NUMBER_ROLE) values.push(t.numbers.find((n) => n.from === r.from && n.to === r.to)!)
    else mentions.get(r.role)!.push({ from: r.from, to: r.to, option: r.option!, ...(r.possessive === true ? { possessive: true as const } : {}) })
  }
  const { vocabulary, verbs } = actionWords(action, optionsOf, lists)
  return {
    text: t.text,
    ws: t.ws,
    marks: t.marks,
    vocabulary,
    verbs,
    mentions,
    numbers: t.numbers,
    values,
    ambiguous: roles.ambiguous,
    reserved: [...t.numbers, ...raw, ...roles.ambiguous]
  }
}

/**
 * The candidates a number or duration parameter of this action may take: each must be a
 * number span that keeps the number role (not inside a longer option name, not
 * ambiguous), read whole (a parser's "40" of "one hundred 40" is not), with no unit or
 * the parameter's own unit ("40 degrees" is no brightness in percent). Offsets are
 * widened to the whole span, unit included.
 */
const candidatesOf = (t: PlanText, a: ActionAccounting) => (param: ActionParam): ReadonlyArray<ValueCandidate> => {
  if (param.kind !== "number" && param.kind !== "duration") return []
  const out: Array<ValueCandidate> = []
  for (const c of param.kind === "number" ? t.numberCandidates : t.durationCandidates) {
    const span = candidateSpan(t.text, t.ws, c)
    if (span === undefined) continue
    const value = a.values.find((v) => containsSpan(v, span) && t.ws.slice(v.from, v.to).every((w, k) => (v.from + k >= span.from && v.from + k < span.to) || UNIT_WORDS.has(w.norm)))
    if (value === undefined) continue
    if (param.kind === "number" && !unitFits(param.unit, value.unit ?? c.unit)) continue
    // A number after "at", "by", "until", "om", … is a time or a condition, not this value (round 5).
    // Only "at" with the parameter's own unit said stays a value ("at 50 percent"); "by 10 percent" is a change, not a level.
    const before = t.ws[value.from - 1]?.norm
    const unitSaid = param.kind === "number" && param.unit !== undefined && (value.unit ?? c.unit) !== undefined
    if (before !== undefined && (param.kind === "number" ? TIME_BEFORE_NUMBER : TIME_BEFORE_DURATION).has(before) && !(before === "at" && unitSaid)) continue
    out.push({ ...c, start: value.start, end: value.end })
  }
  return out
}

/** Assemble the one request for this utterance. Pure; cost grows with actions × parameters, not with the history. */
export const buildDecisionPlan = (input: {
  readonly utterance: string
  readonly actions: ReadonlyArray<RegisteredAction>
  readonly pending?: PendingIntent | undefined
  readonly parse?: ValueParser
  readonly words?: IntentWords
}): DecisionPlan => {
  const parse = input.parse ?? noValueParser
  const lists = input.words ?? defaultIntentWords
  const warnings: Array<string> = []
  const warn = (message: string) => warnings.push(message)
  const unavailable: Array<{ readonly actionId: string; readonly message: string }> = []
  // Each option list is read once per plan, however many actions (and the pending
  // question) share the parameter; keyed by the parameter's own identity.
  const cache = new Map<ActionParam, OptionsRead>()
  const optionsOf = (param: ActionParam): ReadonlyArray<ParamOption> => {
    let found = cache.get(param)
    if (found === undefined) {
      try {
        found = { ok: param.kind === "choice" ? param.options : param.kind === "dynamic" ? param.options() : [] }
      } catch (error) {
        found = { error }
      }
      cache.set(param, found)
    }
    if ("error" in found) throw found.error
    return found.ok
  }
  if (input.actions.length > MAX_CHOICE_OPTIONS) {
    warn(`${input.actions.length} actions are enabled; only the first ${MAX_CHOICE_OPTIONS} are offered`)
  }
  const questions: Record<string, DecisionQuestion> = {}
  const params = new Map<string, Map<string, ParamPlan>>()
  // Everything local reads the canonical text: the same normalisation as the parser and the promotion comparison.
  const t = readPlanText(input.utterance, parse)
  const text = t.text

  // Plan every action's parameters first: an action whose module cannot list its values
  // right now is left out (and reported), the others are still offered.
  const actions: Array<RegisteredAction> = []
  const accounting = new Map<string, ActionAccounting>()
  for (const action of input.actions.slice(0, MAX_CHOICE_OPTIONS)) {
    const plans = new Map<string, ParamPlan>()
    try {
      const a = accountingFor(t, action, optionsOf, lists)
      const candidatesFor = candidatesOf(t, a)
      for (const [name, param] of Object.entries(action.definition.params as ActionParams)) {
        plans.set(name, planParam(name, param, text, candidatesFor, warn, action.id, optionsOf))
      }
      accounting.set(action.id, a)
    } catch (error) {
      const message = `${action.id}: its values could not be read (${messageOf(error)}); not offered`
      unavailable.push({ actionId: action.id, message })
      warn(message)
      continue
    }
    actions.push(action)
    params.set(action.id, plans)
  }

  const explained = new Map<string, AccountResult & { readonly missing: number }>()
  if (actions.length > 0) {
    const options: Record<string, string> = {}
    const unexplained: Record<string, ReadonlyArray<string>> = {}
    for (const action of actions) {
      options[action.id] = actionCriterion(action)
      const result = explainedWithAnyValue(action, params.get(action.id)!, accounting.get(action.id)!, lists)
      explained.set(action.id, result)
      unexplained[action.id] = result.unexplained
    }
    questions[Q.action] = {
      type: "choice",
      instructions: "Which of the available actions does the utterance ask the assistant to do?",
      options,
      role: { kind: "action" }
    }
    questions[Q.fits] = {
      type: "noul",
      instructions: "Does the utterance ask the assistant to do one of the available_actions?",
      role: { kind: "fits", unexplained }
    }
    questions[Q.compound] = {
      type: "noul",
      instructions: "Does the utterance ask for two or more different actions at once?",
      role: { kind: "compound" }
    }
  }

  for (const action of actions) {
    for (const [name, plan] of params.get(action.id)!) {
      const param = (action.definition.params as ActionParams)[name]!
      if (plan.kind === "choice") {
        questions[Q.param(action.id, name)] = choiceQuestion(plan, { kind: "param", action: action.id, param: name })
        if (plan.stated !== undefined) {
          questions[plan.stated] = {
            type: "noul",
            instructions: `Does the utterance say which ${lower(param.label)} it means?`,
            role: { kind: "stated", action: action.id, param: name }
          }
        }
      } else if (plan.kind === "flag") {
        questions[Q.param(action.id, name)] = { type: "noul", instructions: plan.question, role: { kind: "flag", action: action.id, param: name } }
      }
    }
  }

  let pending: DecisionPlan["pending"]
  let pendingIntent = input.pending
  let answer: ParamPlan | undefined
  let reading: ReplyReading | undefined
  if (pendingIntent !== undefined) {
    const intent = pendingIntent
    const drop = (why: string) => {
      warn(`${intent.action.id}: ${why}; the pending question is dropped`)
      pendingIntent = undefined
    }
    // Membership in what this plan OFFERS (at most 255 actions, those whose lists could be read), not in what was enabled.
    if (unavailable.some((u) => u.actionId === intent.action.id)) drop("its values could not be read")
    else if (!actions.includes(intent.action)) drop("its action is no longer offered")
    else {
      // Everything about the pending question is read once, here, from the same snapshot of
      // option lists as the rest of the plan; a list that fails drops the question.
      try {
        for (const [name, value] of Object.entries(intent.params)) {
          const param = intent.action.definition.params[name] as ActionParam | undefined
          if (param?.kind === "dynamic" && value !== undefined && !optionsOf(param).some((o) => o.value === value)) {
            throw new Error(`the ${lower(param.label)} chosen before is no longer offered`)
          }
        }
        const a = accounting.get(intent.action.id)!
        if (intent.awaiting.kind === "param") {
          const param = intent.action.definition.params[intent.awaiting.param] as ActionParam | undefined
          // The answer is a fresh utterance, so the parameter is planned against it as if it were required.
          answer = param === undefined ? undefined : planParam(intent.awaiting.param, param, text, candidatesOf(t, a), warn, intent.action.id, optionsOf, true)
        }
        reading = readReply(text, intent, a, candidatesOf(t, a), lists)
      } catch (error) {
        drop(messageOf(error))
        answer = undefined
      }
    }
  }
  if (pendingIntent !== undefined && reading !== undefined) {
    const intent = pendingIntent
    const asked = intent.awaiting.question
    questions[Q.pendingAnswers] = {
      type: "noul",
      instructions: `The assistant just asked the speaker: "${asked}" Does the utterance answer that question?`,
      role: { kind: "answers", reading: reading.kind }
    }
    if (intent.awaiting.kind === "confirm") {
      questions[Q.pendingYes] = {
        type: "noul",
        instructions: `The assistant just asked the speaker: "${asked}" Does the utterance say yes?`,
        role: { kind: "yes" }
      }
    } else if (answer?.kind === "choice") {
      questions[Q.pendingAnswer] = choiceQuestion(answer, { kind: "param", action: intent.action.id, param: intent.awaiting.param })
    } else if (answer?.kind === "flag") {
      questions[Q.pendingAnswer] = { type: "noul", instructions: answer.question, role: { kind: "flag", action: intent.action.id, param: intent.awaiting.param } }
    }
    pending = { intent, answer, reading }
  }

  const available: Record<string, string> = {}
  for (const action of actions) available[action.id] = action.definition.label
  return {
    request: {
      state: {
        utterance: input.utterance,
        available_actions: available,
        ...(pending !== undefined ? { question_asked: pending.intent.awaiting.question } : {})
      },
      questions
    },
    utterance: input.utterance,
    text,
    actions,
    params,
    ...(pending !== undefined ? { pending } : {}),
    accounting,
    explained,
    warnings,
    unavailable
  }
}

/** Mentions of parameter `name` that keep their role, of `value` when given. */
const mentionsOf = (a: ActionAccounting, name: string, value?: unknown): Array<Mention> =>
  [...(a.mentions.get(name) ?? [])].filter((m) => value === undefined || m.option.value === value)

/**
 * The number spans whose characters are theirs (review round 5): only a span that WON the
 * number role (`values`) or is part of an ambiguous span the question is about, and that is in
 * use (covered). A number absorbed into an option's name ("room two" in "room -two", "forty" in
 * "the forty° degrees lamp") lost its role and gives back its sign, decimal mark and unit: they
 * must then be part of the option's own name or stay unexplained.
 */
const ownedNumbers = (a: ActionAccounting, covered: ReadonlyArray<WordSpan>): ReadonlyArray<NumberSpanRole> =>
  a.numbers.filter((n) =>
    (a.values.includes(n) || a.ambiguous.some((amb) => overlapping(amb, n))) && covered.some((c) => containsSpan(c, n))
  )

/** Core's accounting with this action's words, roles and marks; `covered`: the value spans in use, `chars`: where marks are consumed besides number spans. */
const accountWith = (
  a: ActionAccounting,
  covered: ReadonlyArray<WordSpan>,
  chars: ReadonlyArray<CharSpan>,
  mode: "request" | "reply" | "question",
  lists: IntentWords,
  vocabulary: ReadonlySet<string> = a.vocabulary
): AccountResult =>
  account({
    ws: a.ws,
    text: a.text,
    marks: a.marks,
    vocabulary,
    verbs: a.verbs,
    covered,
    reserved: a.reserved,
    consumed: [...ownedNumbers(a, covered).map((n) => ({ start: n.start, end: n.end })), ...chars],
    mode,
    lists
  })

/** The characters of a text value (the marker word's, too): marks inside free text belong to it. */
const textChars = (a: ActionAccounting, spans: ReadonlyArray<WordSpan>): Array<CharSpan> =>
  spans.map((s) => ({ start: a.ws[s.from]!.start, end: a.ws[s.to - 1]!.end }))

/**
 * What the accounting says if `action` were meant with any of its values (for the
 * provider's `fits` role, and to compare actions): every option named and every
 * number its parameters could take count as values; text taken counts too.
 */
const explainedWithAnyValue = (
  action: RegisteredAction,
  plans: ReadonlyMap<string, ParamPlan>,
  a: ActionAccounting,
  lists: IntentWords
): AccountResult & { readonly missing: number } => {
  const covered: Array<WordSpan> = [...a.mentions.values()].flat()
  let missing = 0
  const chars: Array<CharSpan> = covered.map((m) => mentionChars(a.ws, m as Mention))
  for (const [name, plan] of plans) {
    const param = (action.definition.params as ActionParams)[name]!
    if (param.optional !== true) {
      // A number said but out of range is no missing value here (round 5): which action is meant is decided
      // before any range is checked, so "set the kitchen to 35" is heating-or-brightness, never brightness by range.
      if (plan.kind === "missing" && plan.invalid === undefined) missing++
      else if (plan.kind === "choice" && (param.kind === "choice" || param.kind === "dynamic") && plan.only === undefined && mentionsOf(a, name).length === 0) missing++
    }
    if (plan.kind === "fixed") {
      const spans = fixedSpans(a.text, a.ws, plan, param)
      covered.push(...spans)
      if (param.kind === "text") chars.push(...textChars(a, spans))
    }
    if (plan.kind === "missing" && plan.invalid !== undefined) covered.push(...fixedSpans(a.text, a.ws, { label: plan.invalid, ...plan }, param))
    if (plan.kind === "choice" && (param.kind === "number" || param.kind === "duration")) {
      for (const option of plan.options.values()) {
        if (option.value === undefined) continue
        const span = option.start !== undefined && option.end !== undefined ? wordsIn(a.ws, option.start, option.end) : spanOfText(a.text, a.ws, option.label)
        if (span !== undefined) covered.push(span)
      }
    }
  }
  return { ...accountWith(a, covered, chars, action.definition.speculative === true ? "question" : "request", lists), missing }
}

/**
 * Core's reading of a reply to a pending question (docs/AGENTS-AND-INTENTS.md,
 * "Review fixes", third and fourth rounds): an answer only if it is nothing but one.
 *
 * - the value: for a number or duration, exactly one number span that keeps the
 *   number role (not inside an option's name: "room two" names a room, it does
 *   not answer "What brightness?" with 2) and fits the parameter's unit, read by
 *   the parser (out of range or unreadable: `invalid`, asked again); for a
 *   choice, the names of exactly one option; for text, the words after a marker word;
 * - the question's own words: the parameter's label and unit, the spoken
 *   question, the action's own words (`actionVocabulary`), the names of values
 *   already decided (repeating them agrees with them);
 * - the request construction and fillers (`IntentWords`; `replyFiller` too: "make it 40").
 *
 * Any other word or mark — an unknown place, another option, a different verb,
 * another number, a negation, a "?" — makes it `other`. Pure; reads nothing but its arguments.
 */
const readReply = (
  text: string,
  intent: PendingIntent,
  a: ActionAccounting,
  candidatesFor: (param: ActionParam) => ReadonlyArray<ValueCandidate>,
  lists: IntentWords
): ReplyReading => {
  if (intent.awaiting.kind === "confirm") {
    return isConfirmation(text, lists) ? { kind: "confirmation" } : { kind: "other", unexplained: [] }
  }
  const name = intent.awaiting.param
  const def = intent.action.definition
  const param = def.params[name] as ActionParam | undefined
  if (param === undefined) return { kind: "other", unexplained: [] }
  const ws = a.ws
  const vocabulary = new Set(a.vocabulary)
  for (const w of words(askFor(param))) vocabulary.add(stemWord(w.norm))
  for (const w of words(param.label)) vocabulary.add(stemWord(w.norm))
  const covered: Array<WordSpan> = []
  const chars: Array<CharSpan> = []
  // Values already decided may be repeated ("the kitchen, 40 percent" after "What brightness?" for the kitchen).
  for (const [other, value] of Object.entries(intent.params)) {
    if (other === name || value === undefined) continue
    for (const m of mentionsOf(a, other, value)) {
      covered.push(m)
      chars.push(mentionChars(ws, m))
    }
  }
  const check = (reading: ReplyReading, value: ReadonlyArray<WordSpan>, valueChars: ReadonlyArray<CharSpan> = []): ReplyReading => {
    const { unexplained } = accountWith(a, [...covered, ...value], [...chars, ...valueChars], "reply", lists, vocabulary)
    return unexplained.length === 0 ? reading : { kind: "other", unexplained }
  }
  switch (param.kind) {
    case "number":
    case "duration": {
      // Exactly one number span in the reply keeps the number role, and it is a candidate of this kind and unit.
      // Numbers inside an option's name ("room two") are that name's: the accounting below decides about them.
      const candidates = candidatesFor(param)
      if (a.values.length !== 1 || candidates.length !== 1) {
        return { kind: "other", unexplained: a.numbers.length === 0 ? [] : ["(not one number)"] }
      }
      const c = candidates[0]!
      const at = candidateSpan(text, ws, c)
      if (at === undefined) return { kind: "other", unexplained: [] }
      const reading: ReplyReading = inRange(param, c.value) ? { kind: "answer", value: c.value, label: c.text } : { kind: "invalid", said: c.text }
      return check(reading, [at])
    }
    case "choice":
    case "dynamic": {
      const named = mentionsOf(a, name)
      const distinct = new Set(named.map((m) => m.option.value))
      if (distinct.size !== 1) return { kind: "other", unexplained: [] }
      const option = named[0]!.option
      return check({ kind: "answer", value: option.value, label: option.label, option: option.value }, named, named.map((m) => mentionChars(ws, m)))
    }
    case "text": {
      const value = extractText(text, param.after, param.maxWords, param.notAfter)
      const span = value === undefined ? undefined : spanOfText(text, ws, value)
      if (value === undefined || span === undefined) return { kind: "other", unexplained: [] }
      const spans = [{ from: Math.max(0, span.from - (param.after.length > 0 ? 1 : 0)), to: span.to }]
      return check({ kind: "answer", value, label: value }, spans, textChars(a, spans))
    }
    case "boolean":
      return { kind: "other", unexplained: [] }
  }
}

/** The spans each parameter's value was taken from (for the one-role check and the accounting). */
const usedSpans = (
  plan: DecisionPlan,
  action: RegisteredAction,
  a: ActionAccounting,
  name: string,
  value: unknown,
  chosenSpan: WordSpan | undefined
): { readonly spans: ReadonlyArray<WordSpan>; readonly chars: ReadonlyArray<CharSpan> } => {
  const p = plan.params.get(action.id)?.get(name)
  const param = (action.definition.params as ActionParams)[name]!
  if (p === undefined) return { spans: [], chars: [] }
  if (p.kind === "fixed") {
    const spans = fixedSpans(a.text, a.ws, p, param)
    return { spans, chars: param.kind === "text" ? textChars(a, spans) : [] }
  }
  if (p.kind === "choice" && (param.kind === "number" || param.kind === "duration")) return { spans: chosenSpan === undefined ? [] : [chosenSpan], chars: [] }
  if (p.kind === "choice") {
    const ms = mentionsOf(a, name, value)
    return { spans: ms, chars: ms.map((m) => mentionChars(a.ws, m)) }
  }
  return { spans: [], chars: [] }
}

/**
 * Core's accounting rule for a request: what nothing explains when `action` is
 * run with exactly these values. Explained: the request construction, the
 * action's own words (its verb first), free fillers, the option chosen for each
 * parameter where it is named, the number or text used, and the value being
 * asked about (a parameter still missing, a number that cannot be used, a span
 * that could fill it but is ambiguous). Every other option named, every other
 * number span and every unconsumed mark is unexplained ("turn on the kitchen and
 * the bedroom lights", "dim 3 lights to 40", "dim the kitchen to .5 percent"
 * read without its point).
 */
export const unexplainedForRequest = (
  plan: DecisionPlan,
  action: RegisteredAction,
  used: {
    readonly params: Readonly<Record<string, unknown>>
    /** Parameters asked about next: whatever names a value of theirs is what the question is about. */
    readonly missing: ReadonlyArray<string>
    /** Numbers said that the parameter does not take, by parameter (asked again). */
    readonly rejected: Readonly<Record<string, string>>
    /** Number candidates chosen (choice among several), by parameter. */
    readonly chosenSpans?: Readonly<Record<string, WordSpan | undefined>>
    /** Spans whose role was ambiguous between parameters now asked about (one number for two parameters). */
    readonly asked?: ReadonlyArray<WordSpan>
  },
  lists: IntentWords = defaultIntentWords
): Array<string> => {
  const a = plan.accounting.get(action.id)
  if (a === undefined) return []
  const plans = plan.params.get(action.id) ?? new Map<string, ParamPlan>()
  const covered: Array<WordSpan> = [...(used.asked ?? [])]
  const chars: Array<CharSpan> = []
  for (const [name, p] of plans) {
    const param = (action.definition.params as ActionParams)[name]!
    const numeric = param.kind === "number" || param.kind === "duration"
    if (used.missing.includes(name)) {
      for (const m of mentionsOf(a, name)) {
        covered.push(m)
        chars.push(mentionChars(a.ws, m))
      }
      // A span that could fill it but has two roles: the question is about it.
      for (const amb of a.ambiguous) if (amb.roles.has(numeric ? NUMBER_ROLE : name)) covered.push(amb)
      if (numeric) {
        // A number it may not take as said (inside a name, ambiguous) is asked about too; so is one out of range.
        const said = used.rejected[name]
        if (said !== undefined) {
          const option = p.kind === "choice" ? [...p.options.values()].find((o) => o.label === said && o.start !== undefined) : undefined
          const where = p.kind === "missing" && p.start !== undefined ? p : option
          covered.push(...fixedSpans(a.text, a.ws, { label: said, ...(where?.start !== undefined && where.end !== undefined ? { start: where.start, end: where.end } : {}) }, param))
        }
      }
      continue
    }
    const u = usedSpans(plan, action, a, name, used.params[name], used.chosenSpans?.[name])
    covered.push(...u.spans)
    chars.push(...u.chars)
  }
  return [...accountWith(a, covered, chars, "request", lists).unexplained]
}

// ---------------------------------------------------------------------------
// Interpretation

/**
 * Thresholds (settings of the intent agent; starting points from TypeSafe's
 * guidance, to be tuned on the owner's own utterances). The probability of the
 * chosen option is compared, never Jev's `confidence`.
 */
export interface IntentThresholds {
  /** "Does any action fit?" at or above this: may act. */
  readonly fitsAccept: number
  /** Below this: not a command at all (no match). Between the two: uncertain. */
  readonly fitsReject: number
  /** Probability of the chosen action needed to act. */
  readonly action: number
  /** Probability of a chosen parameter value needed to use it; below it the value is asked for. */
  readonly param: number
  /** "Several actions at once?" at or above this: passed on to the conversational agent. */
  readonly compound: number
  /** "Does it say which …?" below this: an optional parameter takes its default. */
  readonly stated: number
  /** A pending confirmation needs "yes" at or above this. */
  readonly yes: number
  /** "Does it answer the question just asked?" at or above this: treated as the answer. */
  readonly answers: number
}

export const defaultIntentThresholds: IntentThresholds = {
  fitsAccept: 0.7,
  fitsReject: 0.3,
  action: 0.7,
  param: 0.6,
  compound: 0.5,
  stated: 0.5,
  yes: 0.8,
  answers: 0.5
}

export interface ParamDetail {
  readonly name: string
  readonly label: string
  /** Display text of the value. */
  readonly value: string
  /** The decision model's probability, when it chose the value. */
  readonly probability?: number
}

export type IntentOutcome =
  /** Run the action with these values. */
  | {
    readonly _tag: "Act"
    readonly action: RegisteredAction
    readonly params: Readonly<Record<string, unknown>>
    readonly details: ReadonlyArray<ParamDetail>
    readonly probability: number
  }
  /** Ask the owner for a value (speak `question`, keep `pending`, arm the agent for the reply). */
  | { readonly _tag: "Ask"; readonly question: string; readonly pending: PendingIntent; readonly details: ReadonlyArray<ParamDetail> }
  /** Ask for a spoken yes before running a `confirm` action. */
  | { readonly _tag: "Confirm"; readonly question: string; readonly pending: PendingIntent; readonly details: ReadonlyArray<ParamDetail> }
  /** The owner said no to a pending confirmation. */
  | { readonly _tag: "Cancelled"; readonly action: RegisteredAction }
  /**
   * Not for the intent path: `no_match` (no action fits), `uncertain` (an action
   * might fit but not surely enough, or a value stayed unclear after asking),
   * `compound` (several actions at once), `negated` (the request for an action
   * with side effects contains a negation or prohibition), `unexplained` (it
   * contains words nothing explains): core's rules, whatever the decision
   * provider said. The conversational agent takes the turn.
   */
  | { readonly _tag: "Fallback"; readonly reason: "no_match" | "uncertain" | "compound" | "negated" | "unexplained"; readonly probability?: number }

const display = (value: unknown): string => (value === undefined ? "(not said)" : typeof value === "string" ? value : String(value))

/**
 * Turn a provider's answers into an outcome. Besides the thresholds, core's rule
 * holds whatever the provider answered ("Act only on what is fully accounted
 * for", docs/AGENTS-AND-INTENTS.md, "Review fixes, third round"; word lists
 * `lists`, English and Dutch by default):
 *
 * - a request for an action with side effects (not `speculative`) is acted on,
 *   asked about or confirmed only when every word of it is explained by the
 *   action, the values it is given and fillers (`unexplainedForRequest`); else
 *   `Fallback` `unexplained`, so the conversational agent answers;
 * - such a request containing a negation or a prohibition ("don't", "wouldn't",
 *   "stop turning on …", "niet", "hou op met") is `Fallback` `negated`;
 * - a reply to a pending question is the answer only when core reads it as
 *   nothing but an answer (`ReplyReading`); the provider can confirm that
 *   reading, never replace it. Anything else is decided as a new request, with
 *   no memory of the pending one;
 * - a pending confirmation is accepted only on a phrase of core's confirmation
 *   grammar (`isConfirmation`); a provider's no still cancels.
 */
export const interpretDecision = (
  plan: DecisionPlan,
  response: DecisionResponse,
  thresholds: IntentThresholds = defaultIntentThresholds,
  lists: IntentWords = defaultIntentWords
): IntentOutcome => {
  const said = replyWords(plan.text)
  const negated = isNegated(said, lists)
  /** Core's veto: an action with side effects is never acted on from a negated or prohibited request. */
  const vetoed = (action: RegisteredAction) => {
    if (action.definition.speculative === true) return false
    if (negated) return true
    const own = plan.accounting.get(action.id)?.vocabulary
    return isProhibited(said, new Set([...said].filter((w) => own?.has(stemWord(w)) === true)), lists)
  }
  const negatedFallback = (): IntentOutcome => ({ _tag: "Fallback", reason: "negated" })
  const noul = (name: string): number => {
    const a = response.answers[name]
    return a?.type === "noul" ? a.value : 0
  }
  const choice = (name: string): { readonly id: string; readonly p: number } | undefined => {
    const a = response.answers[name]
    if (a?.type !== "choice") return undefined
    return { id: a.choice, p: a.probabilities[a.choice] ?? 0 }
  }

  /** With all values known so far: ask for the next missing one, confirm, or act. */
  const proceed = (
    action: RegisteredAction,
    params: Readonly<Record<string, unknown>>,
    missing: ReadonlyArray<string>,
    details: ReadonlyArray<ParamDetail>,
    probability: number,
    rejected: Readonly<Record<string, string>> = {}
  ): IntentOutcome => {
    const def = action.definition
    if (missing.length > 0) {
      const name = missing[0]!
      const said = rejected[name]
      const question = (said !== undefined ? `${sentence(`I can't use ${said}`)} ` : "") + askFor(def.params[name]!)
      return { _tag: "Ask", question, details, pending: { action, params, missing, awaiting: { kind: "param", param: name, question }, probability } }
    }
    if (def.confirm !== undefined && def.confirm !== false) {
      const question = confirmQuestion(action, params)
      return { _tag: "Confirm", question, details, pending: { action, params, missing: [], awaiting: { kind: "confirm", question }, probability } }
    }
    return { _tag: "Act", action, params, details, probability }
  }

  // A reply to a pending question or confirmation.
  const replyToPending = (): IntentOutcome | undefined => {
    if (plan.pending === undefined) return undefined
    const { intent, reading } = plan.pending
    const action = intent.action
    const def = action.definition
    const confirmed = noul(Q.pendingAnswers) >= thresholds.answers
    const priorDetails = Object.entries(intent.params).map(([name, value]): ParamDetail => ({
      name,
      label: def.params[name]?.label ?? name,
      value: display(value)
    }))
    if (intent.awaiting.kind === "confirm") {
      if (!confirmed) return undefined
      if (noul(Q.pendingYes) < thresholds.yes) return { _tag: "Cancelled", action }
      // The provider heard a yes: act only on core's confirmation grammar; anything else is a new request.
      return reading.kind === "confirmation"
        ? { _tag: "Act", action, params: intent.params, details: priorDetails, probability: intent.probability }
        : undefined
    }
    // "not the kitchen", "stop, the kitchen": never an answer for an action with side effects.
    if (vetoed(action)) return negatedFallback()
    // Not purely an answer: a new request, planned from the reply alone. The provider cannot rescue it.
    if (reading.kind === "other" || reading.kind === "confirmation" || !confirmed) return undefined
    const name = intent.awaiting.param
    const label = def.params[name]?.label ?? name
    // A number it cannot take: ask again (the action stays pending), never use another number.
    if (reading.kind === "invalid") return proceed(action, intent.params, intent.missing, priorDetails, intent.probability, { [name]: reading.said })
    let p = 1
    if (reading.option !== undefined) {
      // The provider confirms core's reading of the option named; a different choice is not an answer.
      const c = choice(Q.pendingAnswer)
      if (c === undefined || c.id !== reading.option || c.p < thresholds.param) return undefined
      p = c.p
    }
    return proceed(
      action,
      { ...intent.params, [name]: reading.value },
      intent.missing.filter((m) => m !== name),
      [...priorDetails, { name, label, value: reading.label, ...(reading.option !== undefined ? { probability: p } : {}) }],
      Math.min(intent.probability, p)
    )
  }
  const replied = replyToPending()
  if (replied !== undefined) return replied

  // A new request (also a reply that is not purely an answer: no memory of the pending one).
  if (plan.actions.length === 0) return { _tag: "Fallback", reason: "no_match" }
  const fits = noul(Q.fits)
  if (noul(Q.compound) >= thresholds.compound) return { _tag: "Fallback", reason: "compound", probability: fits }
  if (fits < thresholds.fitsReject) return { _tag: "Fallback", reason: "no_match", probability: fits }
  const chosen = choice(Q.action)
  const action = chosen === undefined ? undefined : plan.actions.find((a) => a.id === chosen.id)
  if (chosen === undefined || action === undefined || fits < thresholds.fitsAccept || chosen.p < thresholds.action) {
    return { _tag: "Fallback", reason: "uncertain", probability: Math.min(fits, chosen?.p ?? 0) }
  }
  if (vetoed(action)) return negatedFallback()

  const def = action.definition
  const params: Record<string, unknown> = {}
  const missing: Array<string> = []
  const details: Array<ParamDetail> = []
  const rejected: Record<string, string> = {}
  const chosenSpans: Record<string, WordSpan | undefined> = {}
  let probability = Math.min(fits, chosen.p)
  const absent = (name: string, param: ActionParam) => {
    if (param.optional === true) {
      const fallback = "default" in param ? param.default : undefined
      params[name] = fallback
      if (fallback !== undefined) details.push({ name, label: param.label, value: display(fallback) })
    } else {
      missing.push(name)
    }
  }
  const accountingOf_ = plan.accounting.get(action.id)
  const ws = accountingOf_?.ws ?? []
  for (const [name, plan_] of plan.params.get(action.id) ?? new Map<string, ParamPlan>()) {
    const param = def.params[name] as ActionParam
    switch (plan_.kind) {
      case "fixed":
        params[name] = plan_.value
        details.push({ name, label: param.label, value: plan_.label })
        break
      case "missing":
        if (plan_.invalid !== undefined) {
          rejected[name] = plan_.invalid
          missing.push(name) // said, but not a value it accepts: ask, do not take the default
        } else {
          absent(name, param)
        }
        break
      case "flag": {
        const v = noul(Q.param(action.id, name))
        params[name] = v >= 0.5
        details.push({ name, label: param.label, value: v >= 0.5 ? "yes" : "no", probability: Math.max(v, 1 - v) })
        break
      }
      case "choice": {
        if (plan_.stated !== undefined && noul(plan_.stated) < thresholds.stated) {
          if (plan_.only !== undefined) {
            // A single value, and the utterance names none: that one.
            params[name] = plan_.only.value
            details.push({ name, label: param.label, value: plan_.only.label })
          } else {
            absent(name, param)
          }
          break
        }
        const c = choice(Q.param(action.id, name))
        const option = c === undefined || c.id === NONE ? undefined : plan_.options.get(c.id)
        if (c !== undefined && option !== undefined && c.p >= thresholds.param && option.invalid === true) {
          rejected[name] = option.label
          missing.push(name)
        } else if (
          c !== undefined && option !== undefined && c.p >= thresholds.param &&
          // A value is one that was said: an option chosen for a choice the utterance does not name is a guess (asked about).
          (param.kind === "number" || param.kind === "duration" || (accountingOf_ !== undefined && mentionsOf(accountingOf_, name, option.value).length > 0))
        ) {
          params[name] = option.value
          details.push({ name, label: param.label, value: option.label, probability: c.p })
          probability = Math.min(probability, c.p)
          if (option.start !== undefined && option.end !== undefined) chosenSpans[name] = wordsIn(ws, option.start, option.end)
          else if (param.kind === "number" || param.kind === "duration") chosenSpans[name] = spanOfText(plan.text, ws, option.label)
        } else {
          missing.push(name) // said (or required) but unclear: ask rather than guess
        }
        break
      }
    }
  }
  const asked: Array<WordSpan> = []
  if (def.speculative !== true && accountingOf_ !== undefined) {
    // One role per span: a parameter filled from words another parameter's value already
    // uses ("a number cannot fill two parameters"; text taken over an option's name) is ambiguous: ask.
    const taken: Array<{ readonly name: string; readonly spans: ReadonlyArray<WordSpan> }> = []
    for (const name of Object.keys(def.params)) {
      if (missing.includes(name) || params[name] === undefined) continue
      taken.push({ name, spans: usedSpans(plan, action, accountingOf_, name, params[name], chosenSpans[name]).spans })
    }
    const clash = new Set<string>()
    for (let i = 0; i < taken.length; i++) {
      for (let j = i + 1; j < taken.length; j++) {
        if (taken[i]!.spans.some((x) => taken[j]!.spans.some((y) => x.from < y.to && y.from < x.to))) {
          clash.add(taken[i]!.name)
          clash.add(taken[j]!.name)
        }
      }
    }
    // Two numbers for two parameters that each could take either ("set the colour to 40 at 60"):
    // each number has two possible roles, so neither is decided by the words. Ask.
    const plans = plan.params.get(action.id)
    const spansOf = (name: string): ReadonlyArray<WordSpan> => {
      const p = plans?.get(name)
      if (p?.kind === "fixed") return fixedSpans(accountingOf_.text, accountingOf_.ws, p, def.params[name]!)
      if (p?.kind !== "choice") return []
      return [...p.options.values()].flatMap((o) => (o.value !== undefined && o.invalid !== true && o.start !== undefined && o.end !== undefined ? [wordsIn(ws, o.start, o.end)!] : []))
    }
    const numericTaken = taken.filter((t) => def.params[t.name]?.kind === "number" || def.params[t.name]?.kind === "duration")
    const same = (x: WordSpan, y: WordSpan) => x.from === y.from && x.to === y.to
    for (let i = 0; i < numericTaken.length; i++) {
      for (let j = i + 1; j < numericTaken.length; j++) {
        const p = numericTaken[i]!
        const q = numericTaken[j]!
        const swap = p.spans.some((x) => spansOf(q.name).some((y) => same(x, y))) && q.spans.some((x) => spansOf(p.name).some((y) => same(x, y)))
        if (swap) {
          clash.add(p.name)
          clash.add(q.name)
        }
      }
    }
    if (clash.size > 0) {
      for (const t of taken) if (clash.has(t.name)) asked.push(...t.spans)
      for (const name of clash) {
        delete params[name]
        const at = details.findIndex((d) => d.name === name)
        if (at >= 0) details.splice(at, 1)
      }
      const order = Object.keys(def.params)
      missing.push(...clash)
      missing.sort((x, y) => order.indexOf(x) - order.indexOf(y))
    }
  }
  // Core's accounting rule: every word and mark of a request for a side effect is explained.
  if (def.speculative !== true && unexplainedForRequest(plan, action, { params, missing, rejected, chosenSpans, asked }, lists).length > 0) {
    return { _tag: "Fallback", reason: "unexplained", probability }
  }
  // One action: a request that another offered action (of a different kind) explains as fully
  // and as specifically ("turn the kitchen lights": on or off?) does not say which is meant.
  if (def.speculative !== true && competing(plan, action)) return { _tag: "Fallback", reason: "uncertain", probability }
  return proceed(action, params, missing, details, probability, rejected)
}

/** The stems of an action's label: two actions with the same label stems are the same kind (one per module). */
const labelKind = (action: RegisteredAction): string =>
  [...new Set(words(action.definition.label).map((w) => stemWord(w.norm)))].sort().join(" ")

/**
 * Whether another offered action of a different kind explains the utterance fully
 * (with any of its values), needs no more questions and uses at least as many of
 * its own words as `action`: then the words do not say which action is meant
 * ("turn the kitchen lights": on or off; "set the kitchen to 20": brightness or
 * heating). The same kind of action in another module (two homes' "Turn lights
 * on") does not compete: its values decide; nor does a read-only action.
 */
const competing = (plan: DecisionPlan, action: RegisteredAction): boolean => {
  const mine = plan.explained.get(action.id)
  if (mine === undefined) return false
  const kind = labelKind(action)
  return plan.actions.some((other) => {
    // A read-only action does not compete: question forms already fail the request grammar of a side effect.
    if (other === action || other.definition.speculative === true) return false
    const theirs = plan.explained.get(other.id)
    return theirs !== undefined && theirs.unexplained.length === 0 && theirs.missing <= mine.missing && theirs.vocabulary >= mine.vocabulary &&
      labelKind(other) !== kind
  })
}
