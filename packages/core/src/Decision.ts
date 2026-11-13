import { Duration, Effect, Schema } from "effect"
import { type ActionParam, type ActionParams, MAX_CHOICE_OPTIONS, type ParamOption, paramOptions, type RegisteredAction } from "./Actions.ts"
import { normalizeWord, words } from "./TextMatching.ts"

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
  | { readonly kind: "fits" }
  | { readonly kind: "compound" }
  | { readonly kind: "param"; readonly action: string; readonly param: string }
  | { readonly kind: "stated"; readonly action: string; readonly param: string }
  | { readonly kind: "flag"; readonly action: string; readonly param: string }
  /** A question is pending: does the utterance answer it? */
  | { readonly kind: "answers" }
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
  /** The value (durations in milliseconds). */
  readonly value: number
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

interface PlanOption {
  readonly value: unknown
  /** Display text (UI, details). */
  readonly label: string
  /** What the decision model reads: label, aliases, description. */
  readonly criterion: string
}

/** How one parameter of one action gets its value. */
export type ParamPlan =
  /** Known without asking (the only option, the only number found, text taken from the sentence). */
  | { readonly kind: "fixed"; readonly value: unknown; readonly label: string }
  /** Nothing to choose from: no number found, no text after the marker words, an empty dynamic list. */
  | { readonly kind: "missing" }
  /** Asked as a choice; `stated` names the yes/no question "does it say which?" for optional parameters. */
  | { readonly kind: "choice"; readonly question: string; readonly options: ReadonlyMap<string, PlanOption>; readonly stated?: string }
  /** Asked as a yes/no question. */
  | { readonly kind: "flag"; readonly question: string }

export interface DecisionPlan {
  readonly request: DecisionRequest
  readonly utterance: string
  /** The actions offered, in request order (at most 255). */
  readonly actions: ReadonlyArray<RegisteredAction>
  /** Action id → parameter name → plan. */
  readonly params: ReadonlyMap<string, ReadonlyMap<string, ParamPlan>>
  readonly pending?: { readonly intent: PendingIntent; readonly answer: ParamPlan | undefined }
  /** Things the owner should know (shown in the agent's status line): truncated lists, empty dynamic lists. */
  readonly warnings: ReadonlyArray<string>
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

/** The words after the first marker word, up to `maxWords`, as said; or the whole utterance when there are no markers. */
export const extractText = (utterance: string, after: ReadonlyArray<string>, maxWords = 8): string | undefined => {
  const ws = words(utterance)
  let from = 0
  if (after.length > 0) {
    const markers = new Set(after.map(normalizeWord))
    const at = ws.findIndex((w) => markers.has(w.norm))
    if (at < 0) return undefined
    from = at + 1
  }
  const taken = ws.slice(from, from + maxWords)
  if (taken.length === 0) return undefined
  return utterance.slice(taken[0]!.start, taken[taken.length - 1]!.end)
}

const inRange = (param: ActionParam, value: number): boolean => {
  if (param.kind === "number") {
    if (param.integer === true && !Number.isInteger(value)) return false
    return (param.min === undefined || value >= param.min) && (param.max === undefined || value <= param.max)
  }
  if (param.kind === "duration") {
    return (param.minMs === undefined || value >= param.minMs) && (param.maxMs === undefined || value <= param.maxMs)
  }
  return true
}

const planParam = (
  name: string,
  param: ActionParam,
  utterance: string,
  parse: ValueParser,
  warn: (message: string) => void,
  actionId: string
): ParamPlan => {
  switch (param.kind) {
    case "choice":
    case "dynamic": {
      const all = param.kind === "dynamic" ? param.options() : param.options
      if (all.length > MAX_CHOICE_OPTIONS) warn(`${actionId}: ${param.label} has ${all.length} values; only the first ${MAX_CHOICE_OPTIONS} are offered`)
      const opts = paramOptions(param)
      if (opts.length === 0) {
        warn(`${actionId}: ${param.label} has no values to choose from`)
        return { kind: "missing" }
      }
      if (opts.length === 1 && param.optional !== true) return { kind: "fixed", value: opts[0]!.value, label: opts[0]!.label }
      const options = new Map(opts.map((o) => [o.value, { value: o.value, label: o.label, criterion: optionCriterion(o) }] as const))
      return param.optional === true
        ? { kind: "choice", question: defaultQuestion(param), options, stated: Q.stated(actionId, name) }
        : { kind: "choice", question: defaultQuestion(param), options }
    }
    case "number":
    case "duration": {
      const candidates = parse(param.kind, utterance).filter((c) => inRange(param, c.value))
      if (candidates.length === 0) return { kind: "missing" }
      if (candidates.length === 1) return { kind: "fixed", value: candidates[0]!.value, label: candidates[0]!.text }
      const options = new Map<string, PlanOption>(candidates.map((c, i) => [`c${i}`, { value: c.value, label: c.text, criterion: c.text }] as const))
      options.set(NONE, { value: undefined, label: "none of these", criterion: "None of these" })
      return { kind: "choice", question: defaultQuestion(param), options }
    }
    case "boolean":
      return { kind: "flag", question: param.question }
    case "text": {
      const value = extractText(utterance, param.after, param.maxWords)
      return value === undefined ? { kind: "missing" } : { kind: "fixed", value, label: value }
    }
  }
}

const choiceQuestion = (plan: Extract<ParamPlan, { kind: "choice" }>, role: QuestionRole): DecisionQuestion => {
  const options: Record<string, string | null> = {}
  for (const [id, option] of plan.options) options[id] = option.criterion
  return { type: "choice", instructions: plan.question, options, role }
}

/** Assemble the one request for this utterance. Pure; cost grows with actions × parameters, not with the history. */
export const buildDecisionPlan = (input: {
  readonly utterance: string
  readonly actions: ReadonlyArray<RegisteredAction>
  readonly pending?: PendingIntent | undefined
  readonly parse?: ValueParser
}): DecisionPlan => {
  const parse = input.parse ?? noValueParser
  const warnings: Array<string> = []
  const warn = (message: string) => warnings.push(message)
  if (input.actions.length > MAX_CHOICE_OPTIONS) {
    warn(`${input.actions.length} actions are enabled; only the first ${MAX_CHOICE_OPTIONS} are offered`)
  }
  const actions = input.actions.slice(0, MAX_CHOICE_OPTIONS)
  const questions: Record<string, DecisionQuestion> = {}
  const params = new Map<string, Map<string, ParamPlan>>()

  if (actions.length > 0) {
    const options: Record<string, string> = {}
    for (const action of actions) options[action.id] = actionCriterion(action)
    questions[Q.action] = {
      type: "choice",
      instructions: "Which of the available actions does the utterance ask the assistant to do?",
      options,
      role: { kind: "action" }
    }
    questions[Q.fits] = {
      type: "noul",
      instructions: "Does the utterance ask the assistant to do one of the available_actions?",
      role: { kind: "fits" }
    }
    questions[Q.compound] = {
      type: "noul",
      instructions: "Does the utterance ask for two or more different actions at once?",
      role: { kind: "compound" }
    }
  }

  for (const action of actions) {
    const plans = new Map<string, ParamPlan>()
    for (const [name, param] of Object.entries(action.definition.params as ActionParams)) {
      const plan = planParam(name, param, input.utterance, parse, warn, action.id)
      plans.set(name, plan)
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
    params.set(action.id, plans)
  }

  let pending: DecisionPlan["pending"]
  if (input.pending !== undefined) {
    const intent = input.pending
    const asked = intent.awaiting.question
    questions[Q.pendingAnswers] = {
      type: "noul",
      instructions: `The assistant just asked the speaker: "${asked}" Does the utterance answer that question?`,
      role: { kind: "answers" }
    }
    let answer: ParamPlan | undefined
    if (intent.awaiting.kind === "confirm") {
      questions[Q.pendingYes] = {
        type: "noul",
        instructions: `The assistant just asked the speaker: "${asked}" Does the utterance say yes?`,
        role: { kind: "yes" }
      }
    } else {
      const param = intent.action.definition.params[intent.awaiting.param]
      if (param !== undefined) {
        // The answer is a fresh utterance, so the parameter is planned against it as if it were required.
        answer = planParam(intent.awaiting.param, { ...param, optional: false } as ActionParam, input.utterance, parse, warn, intent.action.id)
        if (answer.kind === "choice") questions[Q.pendingAnswer] = choiceQuestion(answer, { kind: "param", action: intent.action.id, param: intent.awaiting.param })
        else if (answer.kind === "flag") questions[Q.pendingAnswer] = { type: "noul", instructions: answer.question, role: { kind: "flag", action: intent.action.id, param: intent.awaiting.param } }
      }
    }
    pending = { intent, answer }
  }

  const available: Record<string, string> = {}
  for (const action of actions) available[action.id] = action.definition.label
  return {
    request: {
      state: {
        utterance: input.utterance,
        available_actions: available,
        ...(input.pending !== undefined ? { question_asked: input.pending.awaiting.question } : {})
      },
      questions
    },
    utterance: input.utterance,
    actions,
    params,
    ...(pending !== undefined ? { pending } : {}),
    warnings
  }
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
   * `compound` (several actions at once). The conversational agent takes the turn.
   */
  | { readonly _tag: "Fallback"; readonly reason: "no_match" | "uncertain" | "compound"; readonly probability?: number }

const display = (value: unknown): string => (value === undefined ? "(not said)" : typeof value === "string" ? value : String(value))

export const interpretDecision = (
  plan: DecisionPlan,
  response: DecisionResponse,
  thresholds: IntentThresholds = defaultIntentThresholds
): IntentOutcome => {
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
    probability: number
  ): IntentOutcome => {
    const def = action.definition
    if (missing.length > 0) {
      const name = missing[0]!
      const question = askFor(def.params[name]!)
      return { _tag: "Ask", question, details, pending: { action, params, missing, awaiting: { kind: "param", param: name, question }, probability } }
    }
    if (def.confirm !== undefined && def.confirm !== false) {
      const question = typeof def.confirm === "function" ? def.confirm(params as never) : `${def.label}?`
      return { _tag: "Confirm", question, details, pending: { action, params, missing: [], awaiting: { kind: "confirm", question }, probability } }
    }
    return { _tag: "Act", action, params, details, probability }
  }

  // A reply to a pending question or confirmation.
  if (plan.pending !== undefined && noul(Q.pendingAnswers) >= thresholds.answers) {
    const { answer, intent } = plan.pending
    const action = intent.action
    const def = action.definition
    const priorDetails = Object.entries(intent.params).map(([name, value]): ParamDetail => ({
      name,
      label: def.params[name]?.label ?? name,
      value: display(value)
    }))
    if (intent.awaiting.kind === "confirm") {
      return noul(Q.pendingYes) >= thresholds.yes
        ? { _tag: "Act", action, params: intent.params, details: priorDetails, probability: intent.probability }
        : { _tag: "Cancelled", action }
    }
    const name = intent.awaiting.param
    const label = def.params[name]?.label ?? name
    let value: unknown
    let found = false
    let p = 1
    if (answer?.kind === "fixed") {
      value = answer.value
      found = true
    } else if (answer?.kind === "choice") {
      const c = choice(Q.pendingAnswer)
      if (c !== undefined && c.id !== NONE && c.p >= thresholds.param && answer.options.has(c.id)) {
        value = answer.options.get(c.id)!.value
        found = true
        p = c.p
      }
    } else if (answer?.kind === "flag") {
      value = noul(Q.pendingAnswer) >= 0.5
      found = true
    }
    if (!found) return { _tag: "Fallback", reason: "uncertain", probability: intent.probability }
    const shown = answer?.kind === "choice" ? answer.options.get(choice(Q.pendingAnswer)!.id)!.label : display(value)
    return proceed(
      action,
      { ...intent.params, [name]: value },
      intent.missing.filter((m) => m !== name),
      [...priorDetails, { name, label, value: shown, ...(answer?.kind === "choice" ? { probability: p } : {}) }],
      Math.min(intent.probability, p)
    )
  }

  // A new request.
  if (plan.actions.length === 0) return { _tag: "Fallback", reason: "no_match" }
  const fits = noul(Q.fits)
  if (noul(Q.compound) >= thresholds.compound) return { _tag: "Fallback", reason: "compound", probability: fits }
  if (fits < thresholds.fitsReject) return { _tag: "Fallback", reason: "no_match", probability: fits }
  const chosen = choice(Q.action)
  const action = chosen === undefined ? undefined : plan.actions.find((a) => a.id === chosen.id)
  if (chosen === undefined || action === undefined || fits < thresholds.fitsAccept || chosen.p < thresholds.action) {
    return { _tag: "Fallback", reason: "uncertain", probability: Math.min(fits, chosen?.p ?? 0) }
  }

  const def = action.definition
  const params: Record<string, unknown> = {}
  const missing: Array<string> = []
  const details: Array<ParamDetail> = []
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
  for (const [name, plan_] of plan.params.get(action.id) ?? new Map<string, ParamPlan>()) {
    const param = def.params[name] as ActionParam
    switch (plan_.kind) {
      case "fixed":
        params[name] = plan_.value
        details.push({ name, label: param.label, value: plan_.label })
        break
      case "missing":
        absent(name, param)
        break
      case "flag": {
        const v = noul(Q.param(action.id, name))
        params[name] = v >= 0.5
        details.push({ name, label: param.label, value: v >= 0.5 ? "yes" : "no", probability: Math.max(v, 1 - v) })
        break
      }
      case "choice": {
        if (plan_.stated !== undefined && noul(plan_.stated) < thresholds.stated) {
          absent(name, param)
          break
        }
        const c = choice(Q.param(action.id, name))
        const option = c === undefined || c.id === NONE ? undefined : plan_.options.get(c.id)
        if (c !== undefined && option !== undefined && c.p >= thresholds.param) {
          params[name] = option.value
          details.push({ name, label: param.label, value: option.label, probability: c.p })
          probability = Math.min(probability, c.p)
        } else {
          missing.push(name) // said (or required) but unclear: ask rather than guess
        }
        break
      }
    }
  }
  return proceed(action, params, missing, details, probability)
}
