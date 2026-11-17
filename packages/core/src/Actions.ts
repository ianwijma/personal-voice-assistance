import { Effect, Schema } from "effect"
import { ToolError } from "./Errors.ts"
import { makeTool, type RiskByInput, type Tool, type ToolMetadata } from "./Module.ts"
import { editDistance, normalizePhrase, phoneticKey } from "./TextMatching.ts"
import { parseDuration } from "./ValueParsing.ts"

/**
 * Actions: programmatic commands a module offers to the typed-intent path
 * (docs/AGENTS-AND-INTENTS.md §3). An action has an identity, a description
 * written for a decision model, typed parameters from a closed set of kinds,
 * the function to run, and what to say.
 *
 * Parameters are filled either by the decision model (it can only *choose*:
 * from a fixed list, from a list the module supplies at run time, or yes/no)
 * or by local code (numbers, durations, free text taken from the sentence),
 * because the decision model does not extract free values.
 *
 * Every action is also offered to conversational agents as a tool unless
 * `offerAsTool: false` (`actionTool` generates it; the module host adds it to
 * the snapshot), so "turn on the living room lights" works through Jev and
 * through Claude alike.
 */

/** One value a choice parameter can take. */
export interface ParamOption {
  /** Stable id, passed to `run` ("area:living_room", "light.desk_lamp"). */
  readonly value: string
  /** Display name, also shown to the decision model ("Living room"). */
  readonly label: string
  /** Other names the owner uses, any language ("lounge", "woonkamer"). */
  readonly aliases?: ReadonlyArray<string>
  /** Extra meaning for the decision model when labels alone are ambiguous. */
  readonly description?: string
}

interface ParamCommon<O extends boolean> {
  /** "Room or light". */
  readonly label: string
  /**
   * How the decision model is asked for this parameter, about meaning, not the
   * parameter name. Default: `Which <label> does the utterance refer to?`.
   */
  readonly question?: string
  /** Spoken when the value is missing or uncertain. Default: `Which <label>?`. */
  readonly ask?: string
  /**
   * Optional parameters left unsaid get `default` (or `undefined`); the decision
   * model is also asked whether the sentence states the value at all, so an
   * unstated value is never guessed.
   */
  readonly optional?: O
}

export interface ChoiceParam<V extends string = string, O extends boolean = boolean> extends ParamCommon<O> {
  readonly kind: "choice"
  readonly options: ReadonlyArray<ParamOption & { readonly value: V }>
  readonly default?: NoInfer<V>
}

/** A choice from a list the module knows at run time (rooms, devices). Read synchronously from the module's own cache. */
export interface DynamicParam<O extends boolean = boolean> extends ParamCommon<O> {
  readonly kind: "dynamic"
  readonly options: () => ReadonlyArray<ParamOption>
  readonly default?: string
}

/** A number said in the sentence ("forty percent", "21 degrees"), parsed locally. */
export interface NumberParam<O extends boolean = boolean> extends ParamCommon<O> {
  readonly kind: "number"
  readonly min?: number
  readonly max?: number
  readonly integer?: boolean
  /** Shown in the UI and used to prefer candidates followed by it ("percent", "degrees"). */
  readonly unit?: string
}

/** A duration said in the sentence ("ten minutes", "anderhalf uur"), parsed locally, in milliseconds. */
export interface DurationParam<O extends boolean = boolean> extends ParamCommon<O> {
  readonly kind: "duration"
  readonly minMs?: number
  readonly maxMs?: number
}

/** A yes/no property of the request ("Does the speaker want it dimmed rather than off?"), asked as a yes/no question. */
export interface BooleanParam extends ParamCommon<false> {
  readonly kind: "boolean"
  readonly question: string
}

/**
 * Free text taken from the sentence by local code: the words after the first
 * of `after` ("in", "for": "what's the weather in Paris" → "Paris"), or the
 * whole request when `after` is empty. Never asked of the decision model.
 */
export interface TextParam<O extends boolean = boolean> extends ParamCommon<O> {
  readonly kind: "text"
  readonly after: ReadonlyArray<string>
  /**
   * Words that, right before a marker, mean it is not one: `["wat"]` keeps the
   * Dutch idiom "wat voor weer" ("what kind of weather") from reading as "for <place>".
   */
  readonly notAfter?: ReadonlyArray<string>
  /** Longest value kept, in words. Default 8. */
  readonly maxWords?: number
}

export type ActionParam =
  | ChoiceParam<string, boolean>
  | DynamicParam<boolean>
  | NumberParam<boolean>
  | DurationParam<boolean>
  | BooleanParam
  | TextParam<boolean>

export type ActionParams = { readonly [name: string]: ActionParam }

type ValueOf<P> = P extends ChoiceParam<infer V, any> ? V
  : P extends DynamicParam<any> | TextParam<any> ? string
  : P extends NumberParam<any> | DurationParam<any> ? number
  : P extends BooleanParam ? boolean
  : never

/** The values `run` receives: optional parameters may be `undefined`. */
export type ParamValues<P extends ActionParams> = {
  readonly [K in keyof P]: P[K] extends { readonly optional?: infer O } ? (true extends O ? ValueOf<P[K]> | undefined : ValueOf<P[K]>)
    : ValueOf<P[K]>
}

/** Constructors that keep the literal types of option values and `optional`. */
// `NoInfer` on the result: inside `defineAction({ params: { … } })` the
// contextual type (`ActionParam`, whose `optional` is `boolean`) must not infer
// `O`, or every parameter would look optional to `run`.
export const Param = {
  choice: <const V extends string, const O extends boolean = false>(p: Omit<ChoiceParam<V, O>, "kind">): ChoiceParam<NoInfer<V>, NoInfer<O>> => ({ kind: "choice", ...p }),
  dynamic: <const O extends boolean = false>(p: Omit<DynamicParam<O>, "kind">): DynamicParam<NoInfer<O>> => ({ kind: "dynamic", ...p }),
  number: <const O extends boolean = false>(p: Omit<NumberParam<O>, "kind">): NumberParam<NoInfer<O>> => ({ kind: "number", ...p }),
  duration: <const O extends boolean = false>(p: Omit<DurationParam<O>, "kind">): DurationParam<NoInfer<O>> => ({ kind: "duration", ...p }),
  boolean: (p: Omit<BooleanParam, "kind">): BooleanParam => ({ kind: "boolean", ...p }),
  text: <const O extends boolean = false>(p: Omit<TextParam<O>, "kind">): TextParam<NoInfer<O>> => ({ kind: "text", ...p })
}

/** An action failed; `message` is spoken to the owner ("Home Assistant did not answer."). */
export class ActionError extends Schema.TaggedError<ActionError>()("ActionError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export interface ActionOutcome {
  /** Spoken after the action ran (a query's answer: "It's 14:32."). */
  readonly say?: string
}

export interface ActionDefinition<P extends ActionParams = ActionParams> extends ToolMetadata<ParamValues<P>> {
  /** Unique within the module: `/^[a-z][a-z0-9_]{0,39}$/`. The global id is `<moduleId>.<id>`. */
  readonly id: string
  /** Short imperative label for the UI and default confirmations: "Turn lights on". */
  readonly label: string
  /**
   * When the action applies, for the decision model: meaning, not keywords.
   * Say what it covers and what belongs to a neighbouring action
   * ("Switch lights on. Not for dimming: that is set_brightness.").
   */
  readonly description: string
  /** Example requests, English and Dutch welcome; sent to the decision model and used by the offline keyword decider. */
  readonly examples?: ReadonlyArray<string>
  readonly params: P
  /** Read-only and safe to run before the turn is committed. Default false: `run` waits for the end of the turn. */
  readonly speculative?: boolean
  /**
   * Ask for a spoken yes first (core conducts it, and only when the conversation's `confirmActions`
   * is "on"). Core always words the question itself from the label and the values; a function is
   * accepted for compatibility but never called (the module host logs a warning). Default false.
   */
  readonly confirm?: boolean | ((params: ParamValues<P>) => string)
  /** Also offered to conversational agents as a tool. Default true. */
  readonly offerAsTool?: boolean
  /**
   * Said as soon as the action is decided, while `run` works ("Living room lights on.").
   * It can be synthesised during a speculative turn, so it plays the moment the turn
   * is committed. Leave it out for queries, whose answer comes from `run`.
   */
  readonly announce?: (params: ParamValues<P>) => string
  /**
   * Do it. Must finish well within 5 s (the intent agent's limit); it is not interrupted once started. Read the turn
   * it runs in with `yield* CurrentTurn` (`undefined` when run outside a turn: a routine from a job, a test).
   */
  readonly run: (params: ParamValues<P>) => Effect.Effect<ActionOutcome | void, ActionError>
}

/** Declare an action. Infers the parameter value types from `params`. */
export const defineAction = <const P extends ActionParams = {}>(definition: ActionDefinition<P>): ActionDefinition<P> => {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(definition.id)) {
    throw new Error(`Action id "${definition.id}" must match /^[a-z][a-z0-9_]{0,39}$/`)
  }
  return definition
}

/** An action of a running module, as the intent agent sees it in the turn's snapshot. */
export interface RegisteredAction {
  readonly moduleId: string
  /** `<moduleId>.<actionId>`. */
  readonly id: string
  readonly definition: ActionDefinition<any>
}

export const registerActions = (moduleId: string, actions: ReadonlyArray<ActionDefinition<any>>): Array<RegisteredAction> =>
  actions.map((definition) => ({ moduleId, id: `${moduleId}.${definition.id}`, definition }))

/** Name of the generated tool for an action (Anthropic and OpenAI allow `[a-zA-Z0-9_-]{1,64}`). */
export const actionToolName = (moduleId: string, actionId: string): string => `${moduleId}_${actionId}`.slice(0, 64)

/** Choice and dynamic parameters capped at 255 values, the decision model's limit for one choice. */
export const MAX_CHOICE_OPTIONS = 255

/** The values a choice or dynamic parameter offers now (empty for other kinds). */
export const paramOptions = (param: ActionParam): ReadonlyArray<ParamOption> =>
  param.kind === "choice" ? param.options.slice(0, MAX_CHOICE_OPTIONS)
  : param.kind === "dynamic" ? param.options().slice(0, MAX_CHOICE_OPTIONS)
  : []

// ---------------------------------------------------------------------------
// Actions as tools (docs/AGENTS-AND-INTENTS.md §3.2)

/** Longest an action may run (the intent agent's limit, and the generated tool's). */
export const ACTION_TIMEOUT_MS = 5_000

const LEADING_ARTICLE = /^(the|de|het|het|a|an|een) /

const matchKey = (s: string) => normalizePhrase(s).replace(LEADING_ARTICLE, "")

/**
 * Find the option a spoken or written name refers to: by value, label or
 * alias, ignoring case, punctuation and a leading article; then by phonetic
 * key; then one edit away on a phonetic key of four letters or more, if unambiguous.
 */
export const resolveOption = (options: ReadonlyArray<ParamOption>, name: string): ParamOption | undefined => {
  const key = matchKey(name)
  if (key.length === 0) return undefined
  const names = (o: ParamOption) => [o.value, o.label, ...(o.aliases ?? [])]
  const exact = options.find((o) => names(o).some((n) => matchKey(n) === key))
  if (exact !== undefined) return exact
  const phon = phoneticKey(key)
  if (phon.length === 0) return undefined
  const keyed = options.map((o) => ({ o, keys: names(o).map((n) => phoneticKey(matchKey(n))) }))
  const sounds = keyed.find(({ keys }) => keys.includes(phon))
  if (sounds !== undefined) return sounds.o
  // One edit apart on keys of at least 4 letters ("kitchin" ≈ "kitchen"), when only one option is that close.
  if (phon.length < 4) return undefined
  const near = keyed.filter(({ keys }) => keys.some((k) => k.length >= 4 && editDistance(k, phon, 1) <= 1))
  return near.length === 1 ? near[0]!.o : undefined
}

const paramSchema = (param: ActionParam): Schema.Codec<unknown, unknown> => {
  switch (param.kind) {
    case "choice": {
      const values = param.options.map((o) => o.value)
      const description = `${param.label}: ${param.options.map((o) => `${o.value} (${o.label})`).join(", ")}`
      return values.length === 0
        ? Schema.String.annotate({ description })
        : Schema.Literals(values as [string, ...Array<string>]).annotate({ description })
    }
    case "dynamic":
      return Schema.String.annotate({ description: `The name the owner uses for the ${param.label.toLowerCase()}` })
    case "number":
      return Schema.Finite.annotate({
        description: param.label + (param.unit !== undefined ? ` in ${param.unit}` : "") +
          (param.min !== undefined || param.max !== undefined ? ` (${param.min ?? "any"} to ${param.max ?? "any"})` : "")
      })
    case "duration":
      return Schema.String.annotate({ description: `${param.label}, e.g. "10 minutes" or "1 hour 30 minutes"` })
    case "boolean":
      return Schema.Boolean.annotate({ description: param.question })
    case "text":
      return Schema.String.annotate({ description: param.label })
  }
}

/** Check and convert one tool input value to what `run` expects. */
const toParamValue = (name: string, param: ActionParam, value: unknown): unknown => {
  if (value === undefined) return param.kind === "boolean" ? false : "default" in param ? param.default : undefined
  switch (param.kind) {
    case "choice":
      return value
    case "dynamic": {
      const options = paramOptions(param)
      const option = resolveOption(options, String(value))
      if (option === undefined) {
        throw new ToolError({
          message: `Unknown ${param.label.toLowerCase()} "${String(value)}". Valid names: ${options.map((o) => o.label).join(", ") || "(none)"}`
        })
      }
      return option.value
    }
    case "number": {
      const n = value as number
      if ((param.integer === true && !Number.isInteger(n)) || (param.min !== undefined && n < param.min) || (param.max !== undefined && n > param.max)) {
        throw new ToolError({ message: `${name} must be ${param.integer === true ? "a whole number " : ""}from ${param.min ?? "any"} to ${param.max ?? "any"}` })
      }
      return n
    }
    case "duration": {
      const ms = parseDuration(String(value))
      if (ms === undefined || (param.minMs !== undefined && ms < param.minMs) || (param.maxMs !== undefined && ms > param.maxMs)) {
        throw new ToolError({ message: `Could not use "${String(value)}" as the ${param.label.toLowerCase()}` })
      }
      return ms
    }
    case "boolean":
    case "text":
      return value
  }
}

/**
 * The values an action's tool input stands for (a dynamic name resolved against the current
 * options, a duration parsed): what `run` receives. Throws `ToolError` for a value it cannot use.
 */
export const actionValues = (registered: RegisteredAction, input: Readonly<Record<string, unknown>>): Record<string, any> => {
  const values: Record<string, any> = {}
  for (const [name, param] of Object.entries(registered.definition.params as ActionParams)) values[name] = toParamValue(name, param, input[name])
  return values
}

/**
 * `actionValues` for input that has NOT been through the tool's schema (core's confirmation
 * proposal reads the raw tool input, review round 6): every required parameter present, a
 * choice one of its values, a number a finite number, a boolean a boolean, text and names
 * strings. Throws `ToolError` otherwise, so only complete, valid values are ever proposed.
 */
export const checkedActionValues = (registered: RegisteredAction, input: Readonly<Record<string, unknown>>): Record<string, any> => {
  for (const [name, param] of Object.entries(registered.definition.params as ActionParams)) {
    const value = input[name]
    if (value === undefined || value === null) {
      if (param.optional === true || param.kind === "boolean") continue
      throw new ToolError({ message: `${name} is required` })
    }
    const ok = param.kind === "choice"
      ? typeof value === "string" && param.options.some((o) => o.value === value)
      : param.kind === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : param.kind === "boolean"
      ? typeof value === "boolean"
      : typeof value === "string"
    if (!ok) throw new ToolError({ message: `${name} has an invalid value` })
  }
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) if (v !== null) clean[k] = v
  return actionValues(registered, clean)
}

/**
 * The tool a conversational agent uses for an action: name `actionToolName`,
 * input from the parameters (a `dynamic` value is a name resolved against the
 * current options when the tool runs, so a changing room list never changes the
 * schema), same `speculative` flag, the action's 5 s limit. Returns what the
 * action says (its `say`, else its `announce`, else "ok").
 */
export const actionTool = (registered: RegisteredAction): Tool => {
  const def = registered.definition
  const params = def.params as ActionParams
  const fields: Record<string, Schema.Codec<unknown, unknown>> = {}
  for (const [name, param] of Object.entries(params)) {
    const schema = paramSchema(param)
    fields[name] = param.optional === true ? Schema.optional(schema) as unknown as Schema.Codec<unknown, unknown> : schema
  }
  // Enforced by core (`proposingTools` and `Conversation`, review round 6): calling it makes the assistant ask.
  const needsYes = def.confirm !== undefined && def.confirm !== false
  const confirm = needsYes
    ? " Needs the owner's confirmation: calling this does not run it; the assistant then asks the owner to confirm and runs it only if they do. Do not ask the owner yourself, and say nothing further after calling it."
    : ""
  const tool = makeTool({
    name: actionToolName(registered.moduleId, def.id),
    description: `${sentenceOf(def.label)} ${def.description}${confirm}`,
    parameters: Schema.Struct(fields) as unknown as Schema.Codec<Readonly<Record<string, unknown>>, unknown>,
    speculative: def.speculative === true,
    // A risk that depends on the values is judged on what `run` would receive (a dynamic name resolved, a duration
    // parsed); the gateway judges a call of this tool on the action's values directly (`Gateway.ts`).
    ...(def.risk !== undefined ? { risk: typeof def.risk === "string" ? def.risk : riskOfValues(registered, def.risk) } : {}),
    ...(def.sensitivity !== undefined ? { sensitivity: def.sensitivity } : {}),
    ...(def.latency !== undefined ? { latency: def.latency } : {}),
    // Only the execution gateway runs it (`Gateway.ts`): it turns the input into the action's values once, admits
    // the call and runs the action. Called directly, it refuses.
    execute: () => Effect.fail(new ToolError({ message: "Not run: an action's tool runs only through the execution gateway." }))
  })
  return { ...tool, action: registered }
}

const riskOfValues = (registered: RegisteredAction, risk: RiskByInput): RiskByInput<Readonly<Record<string, unknown>>> => ({
  classes: risk.classes,
  of: (input) => risk.of(actionValues(registered, input))
})

const sentenceOf = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)
