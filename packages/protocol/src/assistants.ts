import { Schema } from "effect"
import { FieldKey, ModuleId, NonNegativeInt } from "./common.ts"
import { SettingValue } from "./settings.ts"
import { VoiceRefSchema } from "./voices.ts"

/**
 * Assistants (docs/ASSISTANTS.md §2.1, §2.2, §2.6, protocol 7 schemas). Browser-safe and pure: the server, the admin
 * pages and the voice page share the bounds, the validation and the resolution rules.
 *
 * An **assistant** is a created configuration (prompt, language model, hearing, one voice, modules). It has no wake
 * phrase: devices assign assistants and give each assignment its phrases (`devices.ts`).
 */

// -- Limits (§2.1) ---------------------------------------------------------------------------------------------------

export const MAX_ASSISTANTS = 16
/** Assistants on one device or one type-defaults entry. */
export const MAX_ASSIGNMENTS = 8
export const MAX_PHRASES_PER_DEVICE = 32
export const ASSISTANT_NAME_CHARS = 32
export const ASSISTANT_PURPOSE_CHARS = 80
export const ASSISTANT_HANDLES_CHARS = 240
export const ASSISTANT_PROMPT_CHARS = 4000
/** Tools switched off, per module choice. */
export const MAX_OFF_TOOLS = 64
export const TOOL_NAME_CHARS = 64

// -- Ids -------------------------------------------------------------------------------------------------------------

/** Made from the name at creation ("jeff", "t3", "keuken-2"), never changed. */
export const AssistantId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/))
export type AssistantId = typeof AssistantId.Type

export const ToolName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(TOOL_NAME_CHARS))
export type ToolName = typeof ToolName.Type

// -- Schemas (§2.2) --------------------------------------------------------------------------------------------------

export const LlmAccountId = Schema.Literals(["offline", "anthropic", "claude-subscription", "openrouter", "home-model"])
export type LlmAccountId = typeof LlmAccountId.Type

/** Minutes without a committed turn before a new conversation starts, or `"never"`. */
export const QuietSpell = Schema.Union([
  Schema.Literal("never"),
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 }))
])
export type QuietSpell = typeof QuietSpell.Type

export const AssistantLlm = Schema.Struct({
  account: LlmAccountId,
  /** Empty only for `offline`. */
  model: Schema.String.check(Schema.isMaxLength(100)),
  effort: Schema.Literals(["low", "medium", "high"]),
  thinking: Schema.Literals(["off", "adaptive"]),
  maxTokens: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 8192 })),
  giveUpMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 60_000 })),
  warmUp: Schema.Boolean,
  /** `claude-subscription` only. */
  useModules: Schema.Boolean,
  /** `claude-subscription` only; 0 = never. */
  freshSessionAfterMinutes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1440 }))
})
export type AssistantLlm = typeof AssistantLlm.Type

export const HearingEngine = Schema.Literals(["sherpa", "deepgram"])
export const HearingLanguage = Schema.Literals(["auto", "en", "nl", "de", "fr", "es", "it", "pt"])

export const AssistantHearing = Schema.Struct({
  engine: HearingEngine,
  /** A stt-sherpa preset name; ignored for deepgram. */
  model: Schema.String,
  language: HearingLanguage,
  eagerSilenceMs: Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 2000 })),
  finalSilenceMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 3000 })),
  minSpeechMs: Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 1000 })),
  agc: Schema.Boolean,
  agcMaxGainDb: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 40 })),
  vadThreshold: Schema.Finite.check(Schema.isBetween({ minimum: 0.05, maximum: 0.95 })),
  deepgram: Schema.Struct({
    eotThreshold: Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 1 })),
    eagerEotThreshold: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.9 })),
    eotTimeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 10_000 }))
  })
})
export type AssistantHearing = typeof AssistantHearing.Type

export const ModuleChoice = Schema.Struct({
  on: Schema.Boolean,
  /** Tools of this module the assistant may not use. */
  offTools: Schema.Array(ToolName).check(Schema.isMaxLength(MAX_OFF_TOOLS)),
  /** Own values of `overridable` fields only; absent = shared. */
  own: Schema.optionalKey(Schema.Record(FieldKey, SettingValue))
})
export type ModuleChoice = typeof ModuleChoice.Type

/** The fields an admin edits; what `assistant.create` carries. */
export const AssistantBody = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ASSISTANT_NAME_CHARS)),
  purpose: Schema.String.check(Schema.isMaxLength(ASSISTANT_PURPOSE_CHARS)),
  handles: Schema.String.check(Schema.isMaxLength(ASSISTANT_HANDLES_CHARS)),
  on: Schema.Boolean,
  prompt: Schema.String.check(Schema.isMaxLength(ASSISTANT_PROMPT_CHARS)),
  toolRounds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  /** "Keep listening after a reply"; 0 = one answer per phrase. */
  followUpSeconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 120 })),
  newConversationAfter: QuietSpell,
  /** "Start replying before I finish speaking". */
  replyEarly: Schema.Boolean,
  /** "Ask before acting": reserved, shown disabled. */
  confirmActions: Schema.Literal("off"),
  llm: AssistantLlm,
  hearing: AssistantHearing,
  voice: VoiceRefSchema,
  /** A module missing here is off. */
  modules: Schema.Record(ModuleId, ModuleChoice)
})
export type AssistantBody = typeof AssistantBody.Type

export const Assistant = Schema.Struct({
  id: AssistantId,
  /** +1 on every save; a save naming an older rev is refused `stale`. */
  rev: NonNegativeInt,
  ...AssistantBody.fields
})
export type Assistant = typeof Assistant.Type

/** Error codes of protocol 7 (`not_allowed` is `device.pick`'s refusal, §5.3; kept apart from `ErrorCode` until the version bump; see `AssistantResultMessage`). */
export const AssistantErrorCode = Schema.Literals(["stale", "duplicate_phrase", "unknown_assistant", "limit_reached", "not_allowed"])
export type AssistantErrorCode = typeof AssistantErrorCode.Type

// -- Pure helpers ----------------------------------------------------------------------------------------------------

/** One problem found by a validation: `code` for the machine, `path` for the field, `message` for the person. */
export interface Issue {
  readonly code: string
  readonly path: string
  readonly message: string
}

/** The ids of `assistants` in a lookup. */
export const assistantsById = (assistants: ReadonlyArray<Assistant>): ReadonlyMap<string, Assistant> =>
  new Map(assistants.map((a) => [a.id, a]))

/** Name comparison key: trimmed, case-insensitive. */
export const nameKey = (name: string): string => name.trim().toLowerCase()

/** Ids the admin pages use as addresses (`#settings/assistants/all`, `/new`); never given to an assistant. */
export const RESERVED_ASSISTANT_IDS: ReadonlyArray<string> = ["all", "new"]

/**
 * An id from a name ("Keuken" → "keuken"; a taken id gets "-2", "-3"…). Diacritics are dropped, other characters
 * become dashes, the id starts with a letter ("a" is put in front otherwise) and has at most 32 characters.
 */
export const makeAssistantId = (name: string, taken: Iterable<string> = []): string => {
  const used = new Set([...taken, ...RESERVED_ASSISTANT_IDS])
  let base = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (base === "") base = "assistant"
  if (!/^[a-z]/.test(base)) base = `a${base}`
  base = base.slice(0, 32).replace(/-+$/, "")
  if (!used.has(base)) return base
  for (let n = 2;; n++) {
    const suffix = `-${n}`
    const id = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`
    if (!used.has(id)) return id
  }
}

/** What a module offers, for validating and resolving an assistant's choice. Supplied by the server. */
export interface ModuleOffer {
  /** Fields an assistant may override (never secrets or addresses). */
  readonly overridable: ReadonlyArray<string>
  /** Tool names the module has. */
  readonly tools: ReadonlyArray<string>
}

export interface AssistantValidationContext {
  /** The other assistants (the one being saved excluded), for the unique name. */
  readonly others: ReadonlyArray<Pick<Assistant, "id" | "name">>
  /** The module catalog; without it the module checks are skipped. */
  readonly modules?: Readonly<Record<string, ModuleOffer>>
}

/**
 * The errors of §2.2 that need no outside state beyond the other assistants and the module catalog: a blank or
 * duplicate name, `finalSilenceMs` not above `eagerSilenceMs`, Deepgram thresholds, an `own` key that is not
 * overridable, an `offTools` name the module lacks. (A value an `own` field refuses, and a voice or model that is
 * not downloaded, need the module's field definitions and the disk: the server checks those.)
 */
export const validateAssistant = (
  assistant: AssistantBody & { readonly id?: string },
  context: AssistantValidationContext
): ReadonlyArray<Issue> => {
  const issues: Array<Issue> = []
  const key = nameKey(assistant.name)
  if (key === "") issues.push({ code: "invalid", path: "name", message: "An assistant needs a name." })
  else if (context.others.some((o) => o.id !== assistant.id && nameKey(o.name) === key)) {
    issues.push({ code: "invalid", path: "name", message: "Another assistant already has this name." })
  }
  const h = assistant.hearing
  if (h.finalSilenceMs <= h.eagerSilenceMs) {
    issues.push({ code: "invalid", path: "hearing.finalSilenceMs", message: "The final pause must be longer than the early pause." })
  }
  const dg = h.deepgram
  if (dg.eagerEotThreshold > 0 && dg.eagerEotThreshold >= dg.eotThreshold) {
    issues.push({
      code: "invalid",
      path: "hearing.deepgram.eagerEotThreshold",
      message: "The early end-of-turn threshold must be below the end-of-turn threshold (or 0 to switch it off)."
    })
  }
  if (assistant.llm.account !== "offline" && assistant.llm.model.trim() === "") {
    issues.push({ code: "invalid", path: "llm.model", message: "Choose a model." })
  }
  if (context.modules !== undefined) {
    for (const [moduleId, choice] of Object.entries(assistant.modules)) {
      const offer = context.modules[moduleId]
      if (offer === undefined) continue
      for (const field of Object.keys(choice.own ?? {})) {
        if (!offer.overridable.includes(field)) {
          issues.push({ code: "invalid", path: `modules.${moduleId}.own.${field}`, message: `${field} cannot be set per assistant.` })
        }
      }
      for (const tool of choice.offTools) {
        if (!offer.tools.includes(tool)) {
          issues.push({ code: "invalid", path: `modules.${moduleId}.offTools`, message: `The module has no tool called ${tool}.` })
        }
      }
    }
  }
  return issues
}

// -- Module settings (§2.6) ------------------------------------------------------------------------------------------

/**
 * Module settings for an assistant, per field: its own value (only for an `overridable` field), else the shared
 * value (saved or environment), else the module default (for linked fields, already computed from Home: see
 * `linkedModuleDefaults`).
 */
export const resolveModuleSettings = (input: {
  readonly choice: Pick<ModuleChoice, "own"> | undefined
  readonly overridable: ReadonlyArray<string>
  readonly shared: Readonly<Record<string, SettingValue>>
  readonly defaults: Readonly<Record<string, SettingValue>>
}): Record<string, SettingValue> => {
  const out: Record<string, SettingValue> = {}
  const own = input.choice?.own ?? {}
  const keys = new Set([...Object.keys(input.defaults), ...Object.keys(input.shared), ...Object.keys(own)])
  for (const k of keys) {
    if (Object.hasOwn(own, k) && input.overridable.includes(k)) out[k] = own[k] as SettingValue
    else if (Object.hasOwn(input.shared, k)) out[k] = input.shared[k] as SettingValue
    else if (Object.hasOwn(input.defaults, k)) out[k] = input.defaults[k] as SettingValue
  }
  return out
}

/** The Home values that linked module defaults come from. */
export interface HomeValues {
  /** `HOME_LOCATION`; absent or `""` = not set. */
  readonly location?: string
  readonly units: "metric" | "imperial"
  /** `""` = this machine's. */
  readonly timeZone: string
  readonly dateFormat: "en-GB" | "en-US" | "nl-NL" | (string & {})
}

/**
 * Module defaults computed from Home (§2.6): Weather `defaultPlace` ← `HOME_LOCATION`, Weather `units` ← `HOME_UNITS`,
 * Clock `timeZone` ← `HOME_TIME_ZONE`, Clock `locale` ← `HOME_DATE_FORMAT`. A saved or environment value of the
 * module, or an assistant's own value, wins over them.
 */
export const linkedModuleDefaults = (home: HomeValues): Record<string, Record<string, SettingValue>> => ({
  weather: { defaultPlace: home.location ?? "", units: home.units === "imperial" ? "fahrenheit" : "celsius" },
  clock: { timeZone: home.timeZone, locale: home.dateFormat }
})

/** The tools of `moduleId` this assistant may use: the module is on and the tool is not switched off. */
export const toolAllowed = (assistant: Pick<Assistant, "modules">, moduleId: string, tool: string): boolean => {
  const choice = assistant.modules[moduleId]
  return choice !== undefined && choice.on && !choice.offTools.includes(tool)
}

/** A stable key of an effective settings object: equal settings give equal keys, whatever the key order. */
export const settingsKey = (settings: Readonly<Record<string, SettingValue>>): string =>
  JSON.stringify(Object.keys(settings).sort().map((k) => [k, settings[k]]))

export interface ModuleInstance {
  readonly moduleId: string
  readonly settings: Record<string, SettingValue>
  readonly key: string
  /** The switched-on assistants that use this instance. */
  readonly assistants: ReadonlyArray<string>
}

/**
 * Which module instances should run (§2.6): a module runs while at least one switched-on assistant has it on (and
 * `isConfigured` accepts its settings: the required ones are set); one instance per distinct set of effective
 * settings, shared by every assistant whose settings are equal.
 */
export const moduleInstances = (input: {
  readonly assistants: ReadonlyArray<Assistant>
  readonly modules: Readonly<Record<string, ModuleOffer>>
  readonly shared: Readonly<Record<string, Readonly<Record<string, SettingValue>>>>
  readonly defaults: Readonly<Record<string, Readonly<Record<string, SettingValue>>>>
  readonly isConfigured?: (moduleId: string, settings: Readonly<Record<string, SettingValue>>) => boolean
}): ReadonlyArray<ModuleInstance> => {
  const out = new Map<string, { moduleId: string; settings: Record<string, SettingValue>; key: string; assistants: Array<string> }>()
  for (const assistant of input.assistants) {
    if (!assistant.on) continue
    for (const [moduleId, choice] of Object.entries(assistant.modules)) {
      const offer = input.modules[moduleId]
      if (!choice.on || offer === undefined) continue
      const settings = resolveModuleSettings({
        choice,
        overridable: offer.overridable,
        shared: input.shared[moduleId] ?? {},
        defaults: input.defaults[moduleId] ?? {}
      })
      if (input.isConfigured !== undefined && !input.isConfigured(moduleId, settings)) continue
      const key = `${moduleId}:${settingsKey(settings)}`
      const existing = out.get(key)
      if (existing) existing.assistants.push(assistant.id)
      else out.set(key, { moduleId, settings, key, assistants: [assistant.id] })
    }
  }
  return [...out.values()]
}

/** What the Home line of a prompt says (§2.4): the owner's `HOME_*` values. */
export interface HomeLineValues {
  /** `""` = not set. */
  readonly location: string
  /** IANA zone; `""` = this machine's (`machineTimeZone`). */
  readonly timeZone: string
  /** BCP 47, e.g. "en-GB". */
  readonly language: string
  /** This machine's zone, said when `timeZone` is empty. */
  readonly machineTimeZone?: string
}

/**
 * The Home line of every assistant's stable prompt (§2.4: location, time zone, language), e.g. "Home: Amsterdam,
 * Netherlands; time zone Europe/Amsterdam; language en-GB." `""` when there is nothing to say. Stable while Home
 * does not change (it is part of the cached prompt prefix).
 */
export const homeLineOf = (home: HomeLineValues): string => {
  const zone = home.timeZone.trim() !== "" ? home.timeZone.trim() : home.machineTimeZone ?? ""
  const parts = [
    ...(home.location.trim() !== "" ? [home.location.trim()] : []),
    ...(zone !== "" ? [`time zone ${zone}`] : []),
    ...(home.language.trim() !== "" ? [`language ${home.language.trim()}`] : [])
  ]
  return parts.length === 0 ? "" : `Home: ${parts.join("; ")}.`
}
