import { type ModuleDefinition, parseVoiceKey, resolveSettings, type Setting, type SettingsSpec } from "@pva/core"
import {
  type Assignment,
  type Assistant,
  type AssistantHearing,
  type AssistantLlm,
  BUILT_IN_WEB_VOICE_SETTINGS,
  CONVERSATION_IDLE_MINUTES_LIMITS,
  DEFAULT_CONVERSATION_IDLE_MINUTES,
  DEFAULT_DEVICE_PROFILE,
  type DeviceOwn,
  type DeviceProfile,
  type DeviceRecord,
  type DeviceSettings,
  deviceTypeOf,
  effectiveDeviceSettings,
  effectiveProfile,
  FOLLOW_UP_SECONDS_MAX,
  hearerOf,
  type LlmAccountId,
  type ModuleChoice,
  PROFILE_FIELDS,
  type ProfileField,
  type ProfileOverrides,
  type QuietSpell,
  WAKE_PHRASES_MAX,
  WEB_VOICE_KIND
} from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import { defaultSystemPrompt } from "../config.ts"
import { isTtsProvider } from "../providers.ts"
import { DEFAULT_ASSISTANT_VOICE, resolveAssistantVoice } from "../voiceSelection.ts"
import { sectionDefinitions } from "./sectionDefinitions.ts"

/**
 * Settings version 3 → 4: first-class assistants and merged devices (docs/ASSISTANTS.md §2.5, §6, §1.2).
 *
 * Pure: everything here maps data; `SettingsStore.ts` reads, writes and backs up the files.
 *
 * - `migrateToV4`: one assistant (`MIGRATED_ASSISTANT_ID`) from today's effective settings (environment > saved >
 *   default), the front-end kind defaults as device-type defaults, every device's overrides as its own sections,
 *   and the notes of what changed or was lost.
 * - The **legacy view** (`legacyV3FrontendData`, `applyLegacyChange`): until the server reads assistants and devices
 *   itself (WP-4b, WP-5), it keeps reading front-end kind defaults and device profile overrides
 *   (`serve/frontends.ts`). Those are derived from the version-4 data, and a change made through them is written
 *   back into it, field by field, so data the old pages cannot see is kept.
 * - **Flat keys that became per assistant** (`ASSISTANT_KEYS`: SYSTEM_PROMPT, ANTHROPIC_MODEL, STT_*, …): today's
 *   pages and engines still use the flat keys, so a save of one is mirrored into the migrated assistant
 *   (`mirrorFlatKeys`) and nothing changed there is lost when the engines switch to the assistant. Their environment
 *   values apply to, and lock, that field of the migrated assistant only (`withEnvironment`, §1.2).
 */

/** The id of the assistant the migration makes. Environment values of per-assistant keys apply to it only. */
export const MIGRATED_ASSISTANT_ID = "assistant"
export const MIGRATED_ASSISTANT_NAME = "Assistant"

// -- File shapes -----------------------------------------------------------------------------------------------------

type ModulesSection = Readonly<Record<string, { readonly enabled?: boolean; readonly settings?: Readonly<Record<string, unknown>> }>>

/** A remembered device as a version 3 file stores it: profile overrides (read by the migration only). */
export interface V3DeviceRecord {
  readonly kind: string
  readonly name: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly overrides: ProfileOverrides
}

/** The front-end part of a version-3 `settings.json`. */
export interface V3FrontendData {
  /** Kind id → its default profile overrides. */
  readonly frontends: Readonly<Record<string, ProfileOverrides>>
  /** Device id → its record. */
  readonly devices: Readonly<Record<string, V3DeviceRecord>>
}

/** A version-3 `settings.json` (a version-2 or -1 file is read as this first). */
export interface SettingsFileV3 extends V3FrontendData {
  readonly version: 3
  readonly revision?: number
  readonly modules: ModulesSection
  readonly assistant: Readonly<Record<string, unknown>>
}

/** A device type's defaults: complete settings, and the entity's save counter. */
export type StoredDeviceType = DeviceSettings & { readonly rev: number }
/** A remembered device with the entity's save counter. */
export type StoredDevice = DeviceRecord & { readonly rev: number }

export interface AssistantList {
  /** The admin's order; every id is in `byId`. */
  readonly order: ReadonlyArray<string>
  readonly byId: Readonly<Record<string, Assistant>>
}

export interface MigrationRecord {
  readonly from: number
  /** Epoch milliseconds. */
  readonly at: number
  readonly notes: ReadonlyArray<string>
}

/** The entities of version 4 (docs/ASSISTANTS.md §2.5). */
export interface AssistantsData {
  readonly assistants: AssistantList
  readonly deviceTypes: Readonly<Record<string, StoredDeviceType>>
  readonly devices: Readonly<Record<string, StoredDevice>>
}

export interface SettingsFile extends AssistantsData {
  readonly version: 4
  /** The save that wrote this file (see `SettingsStore.ts`, "Revisions"). */
  readonly revision?: number
  /** Module shared settings; `enabled` is mirrored into the migrated assistant and read by today's module host. */
  readonly modules: ModulesSection
  /** Shared settings by key; keys that became per assistant stay too (today's engines read them). */
  readonly assistant: Readonly<Record<string, unknown>>
  readonly migration?: MigrationRecord
}

/** What the migration and the per-assistant keys need beyond the file. */
export interface AssistantContext {
  /** The environment (read live: a key released by "Move to settings" stops counting at once). */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The module catalog (which modules are on by default, the Claude subscription agent's settings). */
  readonly catalog?: ReadonlyArray<ModuleDefinition<any>>
}

// -- Small helpers ---------------------------------------------------------------------------------------------------

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}
const clampNum = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : fallback
const oneOf = <A extends string>(v: unknown, options: ReadonlyArray<A>, fallback: A): A =>
  typeof v === "string" && (options as ReadonlyArray<string>).includes(v) ? (v as A) : fallback
const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v === "" ? undefined : v)

/** Minutes without a turn → the assistant's quiet spell (0 = never). */
export const quietSpellOf = (minutes: unknown): QuietSpell => {
  const n = clampInt(minutes, 0, 1440, DEFAULT_CONVERSATION_IDLE_MINUTES)
  return n === 0 ? "never" : n
}
/** The quiet spell as today's `conversationIdleMinutes` (0..240; "never" = 0). */
const idleMinutesOf = (spell: QuietSpell): number => (spell === "never" ? 0 : Math.min(CONVERSATION_IDLE_MINUTES_LIMITS.max, spell))

const accountOf = (provider: unknown): LlmAccountId =>
  provider === "anthropic" ? "anthropic" : provider === "claude-subscription" ? "claude-subscription" : "offline"

const sherpaModel = (v: unknown): string => {
  if (typeof v !== "string" || v === "") return SherpaStt.DEFAULT_PRESET
  return SherpaStt.isPresetName(v) ? v : SherpaStt.resolvePresetName(v) ?? v
}

/** Read a dotted path ("llm.model"). */
export const getPath = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined), value)

/** A copy of `value` with `path` set. */
export const setPath = <A>(value: A, path: string, next: unknown): A => {
  const [head, ...rest] = path.split(".")
  const record = value as Record<string, unknown>
  return { ...record, [head!]: rest.length === 0 ? next : setPath(record[head!] ?? {}, rest.join("."), next) } as A
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// -- The assistant settings' fields ----------------------------------------------------------------------------------

let settingsByKey: ReadonlyMap<string, Setting<unknown>> | undefined
/** Every flat setting by key (the sections' specs). */
const flatSettings = (): ReadonlyMap<string, Setting<unknown>> => {
  if (settingsByKey === undefined) {
    const map = new Map<string, Setting<unknown>>()
    for (const d of sectionDefinitions()) for (const [key, setting] of Object.entries(d.spec as SettingsSpec)) map.set(key, setting)
    settingsByKey = map
  }
  return settingsByKey
}

const SUBSCRIPTION_ID = "claude-subscription"
const SUBSCRIPTION_DEFAULTS = { model: "claude-haiku-5-5", systemPrompt: "", speculate: false, tools: true, sessionIdleMinutes: 60 }

/**
 * A key that became a field of the assistant (docs/ASSISTANTS.md §4.3). `apply` sets the field from the key's
 * decoded value; it returns the assistant unchanged when the key does not apply to it (an Anthropic model on an
 * assistant of another account).
 */
interface AssistantKey {
  readonly key: string
  /** The field it sets (a dotted path of `Assistant`). */
  readonly field: string
  /** Whether the key speaks about this assistant (ANTHROPIC_MODEL only for an Anthropic account). */
  readonly applies: (assistant: Assistant) => boolean
  readonly apply: (assistant: Assistant, value: unknown) => Assistant
}

const always = () => true
const field = (key: string, path: string, convert: (value: unknown, assistant: Assistant) => unknown, when: (a: Assistant) => boolean = always): AssistantKey => ({
  key,
  field: path,
  applies: when,
  apply: (a, v) => (when(a) ? setPath(a, path, convert(v, a)) : a)
})
const ms = (min: number, max: number, path: string) => (v: unknown, a: Assistant) => clampInt(v, min, max, getPath(a, path) as number)

/** In this order (the account first: the model keys depend on it). */
export const ASSISTANT_KEYS: ReadonlyArray<AssistantKey> = [
  field("LLM_PROVIDER", "llm.account", accountOf),
  field("SYSTEM_PROMPT", "prompt", (v) => String(v ?? "").slice(0, 4000)),
  field("MAX_TOOL_ROUNDS", "toolRounds", (v, a) => clampInt(v, 0, 10, a.toolRounds)),
  field("CONVERSATION_IDLE_MINUTES", "newConversationAfter", quietSpellOf),
  field("ANTHROPIC_MODEL", "llm.model", (v) => String(v ?? "").slice(0, 100), (a) => a.llm.account === "anthropic"),
  field("CLAUDE_SUBSCRIPTION_MODEL", "llm.model", (v) => String(v ?? "").slice(0, 100), (a) => a.llm.account === "claude-subscription"),
  field("ANTHROPIC_MAX_TOKENS", "llm.maxTokens", (v, a) => clampInt(v, 64, 8192, a.llm.maxTokens)),
  field("ANTHROPIC_EFFORT", "llm.effort", (v, a) => oneOf(v, ["low", "medium", "high"], a.llm.effort)),
  field("ANTHROPIC_THINKING", "llm.thinking", (v) => (v === "adaptive" ? "adaptive" : "off")),
  field("ANTHROPIC_TIMEOUT_MS", "llm.giveUpMs", ms(1000, 60_000, "llm.giveUpMs")),
  field("ANTHROPIC_WARM_UP", "llm.warmUp", (v, a) => bool(v, a.llm.warmUp)),
  field("STT_PROVIDER", "hearing.engine", (v) => (v === "deepgram" ? "deepgram" : "sherpa")),
  field("STT_SHERPA_MODEL", "hearing.model", sherpaModel),
  field("STT_SHERPA_LANGUAGE", "hearing.language", (v, a) => oneOf(v, ["auto", "en", "nl", "de", "fr", "es", "it", "pt"], a.hearing.language)),
  field("STT_SHERPA_EAGER_SILENCE_MS", "hearing.eagerSilenceMs", ms(50, 2000, "hearing.eagerSilenceMs")),
  field("STT_SHERPA_FINAL_SILENCE_MS", "hearing.finalSilenceMs", ms(100, 3000, "hearing.finalSilenceMs")),
  field("STT_SHERPA_MIN_SPEECH_MS", "hearing.minSpeechMs", ms(20, 1000, "hearing.minSpeechMs")),
  field("STT_SHERPA_AGC", "hearing.agc", (v, a) => bool(v, a.hearing.agc)),
  field("STT_SHERPA_AGC_MAX_GAIN_DB", "hearing.agcMaxGainDb", (v, a) => clampNum(v, 0, 40, a.hearing.agcMaxGainDb)),
  field("STT_SHERPA_VAD_THRESHOLD", "hearing.vadThreshold", (v, a) => clampNum(v, 0.05, 0.95, a.hearing.vadThreshold)),
  field("DEEPGRAM_EOT_THRESHOLD", "hearing.deepgram.eotThreshold", (v, a) => clampNum(v, 0.5, 1, a.hearing.deepgram.eotThreshold)),
  field("DEEPGRAM_EAGER_EOT_THRESHOLD", "hearing.deepgram.eagerEotThreshold", (v, a) => clampNum(v, 0, 0.9, a.hearing.deepgram.eagerEotThreshold)),
  field("DEEPGRAM_EOT_TIMEOUT_MS", "hearing.deepgram.eotTimeoutMs", ms(500, 10_000, "hearing.deepgram.eotTimeoutMs")),
  {
    key: "ASSISTANT_VOICE",
    field: "voice",
    applies: always,
    apply: (a, v) => {
      const ref = typeof v === "string" ? parseVoiceKey(v.trim()) : undefined
      return ref !== undefined && isTtsProvider(ref.provider) ? { ...a, voice: ref } : a
    }
  }
]
const assistantKeyByName = new Map(ASSISTANT_KEYS.map((k) => [k.key, k]))

/** Whether `key` became a field of the assistant (its environment value locks that field of the migrated one). */
export const isAssistantKey = (key: string): boolean => assistantKeyByName.has(key)
/** The field a per-assistant key sets (a dotted path of `Assistant`). */
export const assistantFieldOf = (key: string): string | undefined => assistantKeyByName.get(key)?.field

/** The Setting that decodes a per-assistant key (a section's, or the Claude subscription agent's model). */
const settingOf = (key: string, catalog: ReadonlyArray<ModuleDefinition<any>> | undefined): Setting<unknown> | undefined => {
  const flat = flatSettings().get(key)
  if (flat !== undefined) return flat
  if (key === "CLAUDE_SUBSCRIPTION_MODEL") {
    const spec = catalog?.find((d) => d.id === SUBSCRIPTION_ID)?.settings as SettingsSpec | undefined
    return spec?.model
  }
  return undefined
}

/** A field set by the environment: it wins over the saved value and cannot be changed by a save. */
export interface EnvironmentLock {
  readonly key: string
  readonly field: string
}

/**
 * The assistant as it is in effect: for the migrated assistant only, each per-assistant key set in the environment
 * (non-empty, valid) overrides and locks its field (docs/ASSISTANTS.md §1.2). Other assistants are returned as they
 * are, with no locks.
 */
export const withEnvironment = (
  assistant: Assistant,
  context: AssistantContext
): { readonly assistant: Assistant; readonly locks: ReadonlyArray<EnvironmentLock> } => {
  const env = context.env ?? {}
  if (assistant.id !== MIGRATED_ASSISTANT_ID) return { assistant, locks: [] }
  let out = assistant
  const locks: Array<EnvironmentLock> = []
  for (const k of ASSISTANT_KEYS) {
    const text = nonEmpty(env[k.key])
    if (text === undefined) continue
    const setting = settingOf(k.key, context.catalog)
    const decoded = setting === undefined ? { ok: true as const, value: text } : setting.fromEnv(text)
    if (!decoded.ok || !k.applies(out)) continue
    out = k.apply(out, decoded.value)
    locks.push({ key: k.key, field: k.field })
  }
  return { assistant: out, locks }
}

/**
 * Mirror a save of flat keys (`SettingsStore.saveAssistant`) into the migrated assistant: each per-assistant key in
 * `keys` sets its field from its new saved value, or from its default when it was removed. Keys set in the
 * environment are skipped (the environment value is in effect and locks the field). A changed account also takes
 * that account's model.
 */
export const mirrorFlatKeys = (
  assistant: Assistant,
  keys: ReadonlyArray<string>,
  saved: Readonly<Record<string, unknown>>,
  modules: ModulesSection,
  context: AssistantContext
): Assistant => {
  const env = context.env ?? {}
  const touched = new Set(keys)
  let out = assistant
  for (const k of ASSISTANT_KEYS) {
    if (!touched.has(k.key) || nonEmpty(env[k.key]) !== undefined) continue
    const setting = settingOf(k.key, context.catalog)
    let value: unknown
    if (Object.hasOwn(saved, k.key)) {
      const decoded = setting?.decode(saved[k.key]) ?? { ok: true as const, value: saved[k.key] }
      if (!decoded.ok) continue
      value = decoded.value
    } else {
      if (k.key === "ASSISTANT_VOICE") continue // empty: the earlier voice settings decide (unchanged here)
      value = setting?.defaultValue ?? (k.key === "SYSTEM_PROMPT" ? defaultSystemPrompt : undefined)
      if (value === undefined) continue
    }
    const before = out.llm.account
    out = k.apply(out, value)
    if (k.key === "LLM_PROVIDER" && out.llm.account !== before) {
      out = { ...out, llm: { ...out.llm, model: modelFor(out.llm.account, (key) => effectiveFlat(saved, {}, env).get(key), modules, context) } }
    }
  }
  return out
}

/** Mirror a module's enable switch (`SettingsStore.saveModule`) into the migrated assistant's module choice. */
export const mirrorModuleSwitch = (assistant: Assistant, moduleId: string, enabled: boolean, context: AssistantContext): Assistant => {
  const def = context.catalog?.find((d) => d.id === moduleId)
  if (def !== undefined && !isCapability(def)) return assistant
  const choice = assistant.modules[moduleId]
  if (choice === undefined && !enabled) return assistant
  if (choice !== undefined && choice.on === enabled) return assistant
  const next: ModuleChoice = choice === undefined ? { on: enabled, offTools: [] } : { ...choice, on: enabled }
  return { ...assistant, modules: { ...assistant.modules, [moduleId]: next } }
}

const isCapability = (def: ModuleDefinition<any>) => def.kind === undefined || def.kind === "capability"

/**
 * Mirror a save of the Claude subscription agent's settings (`SettingsStore.saveModule`) into the migrated assistant,
 * when it is on that account (docs/ASSISTANTS.md §4.1: those settings became the assistant's, WP-13a). Only the
 * settings the save changed: `model` → `llm.model` (unless `CLAUDE_SUBSCRIPTION_MODEL` is set in the environment,
 * which locks it), `tools` → `llm.useModules`, `sessionIdleMinutes` → `llm.freshSessionAfterMinutes`, `speculate` →
 * `replyEarly`, a non-empty `systemPrompt` → `prompt`. The shared settings (opt-in, program, proxy, debug logs) stay
 * the module's.
 */
export const mirrorSubscriptionSettings = (
  assistant: Assistant,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  context: AssistantContext
): Assistant => {
  if (assistant.llm.account !== "claude-subscription") return assistant
  const was = subscriptionSettings({ [SUBSCRIPTION_ID]: { settings: before } }, { ...context, env: {} })
  const now = subscriptionSettings({ [SUBSCRIPTION_ID]: { settings: after } }, { ...context, env: {} })
  let out = assistant
  if (now.model !== was.model && nonEmpty(context.env?.CLAUDE_SUBSCRIPTION_MODEL) === undefined) {
    out = { ...out, llm: { ...out.llm, model: now.model.slice(0, 100) } }
  }
  if (now.tools !== was.tools) out = { ...out, llm: { ...out.llm, useModules: now.tools } }
  if (now.sessionIdleMinutes !== was.sessionIdleMinutes) out = { ...out, llm: { ...out.llm, freshSessionAfterMinutes: now.sessionIdleMinutes } }
  if (now.speculate !== was.speculate) out = { ...out, replyEarly: now.speculate }
  if (now.systemPrompt !== was.systemPrompt && now.systemPrompt.trim() !== "") out = { ...out, prompt: now.systemPrompt.slice(0, 4000) }
  return out
}

// -- Effective v3 values ---------------------------------------------------------------------------------------------

/** Saved values from earlier versions: renamed recogniser presets (as `sections.ts` reads them). */
const migrateSaved = (values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const model = values.STT_SHERPA_MODEL
  if (typeof model !== "string" || SherpaStt.isPresetName(model)) return values
  const renamed = SherpaStt.resolvePresetName(model)
  return renamed === undefined ? values : { ...values, STT_SHERPA_MODEL: renamed }
}

/** Every flat field's effective value: environment > saved > default (what `sections.ts` computes). */
const effectiveFlat = (
  stored: Readonly<Record<string, unknown>>,
  secrets: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>
): ReadonlyMap<string, unknown> => {
  const values = new Map<string, unknown>()
  const migrated = migrateSaved(stored)
  for (const d of sectionDefinitions()) {
    for (const [key, value] of Object.entries(resolveSettings(d.spec, { stored: migrated, secrets, env }).form.values)) values.set(key, value)
  }
  return values
}

/** The Claude subscription agent's settings (environment > saved > default). */
const subscriptionSettings = (modules: ModulesSection, context: AssistantContext): typeof SUBSCRIPTION_DEFAULTS => {
  const env = context.env ?? {}
  const def = context.catalog?.find((d) => d.id === SUBSCRIPTION_ID)
  const stored = modules[SUBSCRIPTION_ID]?.settings ?? {}
  const values: Record<string, unknown> = def !== undefined
    ? resolveSettings(def.settings, { stored, secrets: {}, env }).form.values
    : { ...stored, ...(nonEmpty(env.CLAUDE_SUBSCRIPTION_MODEL) !== undefined ? { model: env.CLAUDE_SUBSCRIPTION_MODEL } : {}) }
  return {
    model: typeof values.model === "string" && values.model.trim() !== "" ? values.model.trim() : SUBSCRIPTION_DEFAULTS.model,
    systemPrompt: typeof values.systemPrompt === "string" ? values.systemPrompt : "",
    speculate: bool(values.speculate, SUBSCRIPTION_DEFAULTS.speculate),
    tools: bool(values.tools, SUBSCRIPTION_DEFAULTS.tools),
    sessionIdleMinutes: clampInt(values.sessionIdleMinutes, 0, 1440, SUBSCRIPTION_DEFAULTS.sessionIdleMinutes)
  }
}

const modelFor = (account: LlmAccountId, get: (key: string) => unknown, modules: ModulesSection, context: AssistantContext): string =>
  account === "anthropic"
    ? String(get("ANTHROPIC_MODEL") ?? "claude-haiku-5-5").slice(0, 100)
    : account === "claude-subscription"
    ? subscriptionSettings(modules, context).model.slice(0, 100)
    : ""

/** Whether a module was on in version 3: saved, else its default (on by default, or once its key is set). */
const wasEnabled = (
  def: ModuleDefinition<any>,
  modules: ModulesSection,
  secrets: Readonly<Record<string, Readonly<Record<string, string>>>>,
  env: Readonly<Record<string, string | undefined>>
): boolean => {
  const saved = modules[def.id]?.enabled
  if (saved !== undefined) return saved
  if (def.enabledByDefault || def.enabledWhenSet === undefined) return def.enabledByDefault
  const form = resolveSettings(def.settings, { stored: modules[def.id]?.settings ?? {}, secrets: secrets[def.id] ?? {}, env }).form
  return form.secrets[def.enabledWhenSet]?.set === true
}

// -- Device profiles ↔ device settings ------------------------------------------------------------------------------

const AUDIO_FIELDS = ["echoCancellation", "noiseSuppression", "autoGainControl", "outputPath", "prebufferMs"] as const
const CAPTION_FIELDS = ["captions", "speakReplies"] as const

/** The built-in profile under the kind defaults: `DEFAULT_DEVICE_PROFILE` with today's CONVERSATION_IDLE_MINUTES. */
const builtInProfile = (idleMinutes: number): DeviceProfile => ({ ...DEFAULT_DEVICE_PROFILE, conversationIdleMinutes: idleMinutes })

const withoutPhraseOf = (activation: DeviceProfile["activation"], assistantId: string | undefined): DeviceSettings["withoutPhrase"] =>
  activation === "always" && assistantId !== undefined ? { mode: "assistant", assistant: assistantId } : { mode: "nobody" }

const phrasesOf = (settings: Pick<DeviceSettings, "assistants">, assistantId: string | undefined): ReadonlyArray<string> =>
  settings.assistants.find((a) => a.assistant === assistantId)?.phrases ?? settings.assistants[0]?.phrases ?? []

/** `list` with `assistantId`'s assignment replaced (or put first): its phrases and, when given, its follow-up. */
const withAssignment = (
  list: ReadonlyArray<Assignment>,
  assistantId: string,
  phrases: ReadonlyArray<string>,
  followUpSeconds: number | undefined | "keep"
): ReadonlyArray<Assignment> => {
  const index = list.findIndex((a) => a.assistant === assistantId)
  const before = index >= 0 ? list[index] : undefined
  const follow = followUpSeconds === "keep" ? before?.followUpSeconds : followUpSeconds
  const next: Assignment = { assistant: assistantId, phrases: [...phrases], ...(follow !== undefined ? { followUpSeconds: follow } : {}) }
  return index >= 0 ? list.map((a, i) => (i === index ? next : a)) : [next, ...list]
}

/** Complete device settings from an effective profile (one assignment: `assistantId` with the profile's phrases). */
const settingsFromProfile = (p: DeviceProfile, assistantId: string): DeviceSettings => ({
  assistants: [{ assistant: assistantId, phrases: [...p.wakePhrases] }],
  withoutPhrase: withoutPhraseOf(p.activation, assistantId),
  matching: p.wakeMatch,
  voicePage: { pick: false },
  interruptMode: p.interruptMode,
  audio: {
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
    speakAloud: true,
    outputPath: p.outputPath,
    prebufferMs: p.prebufferMs
  },
  captions: { captions: p.captions, speakTyped: p.speakReplies }
})

/** The fields present in `overrides`. */
const presentFields = (overrides: ProfileOverrides): ReadonlySet<ProfileField> =>
  new Set(PROFILE_FIELDS.filter((f) => overrides[f] !== undefined))

/**
 * A device's own sections after a change of its profile overrides: each section touched by a field in `changed`
 * becomes own when any of its fields is overridden (the others filled from `inherited`, what the device would get
 * without own values), and follows the type defaults again when none is. Untouched sections are kept. `voice` and
 * `conversationIdleMinutes` have no device section (dropped: docs/ASSISTANTS.md §6).
 */
const ownFromOverrides = (
  own: DeviceOwn,
  changed: ReadonlySet<ProfileField>,
  overrides: ProfileOverrides,
  inherited: DeviceSettings,
  assistantId: string | undefined
): DeviceOwn => {
  const out: Record<string, unknown> = { ...own }
  const touches = (fields: ReadonlyArray<ProfileField>) => fields.some((f) => changed.has(f))
  const set = (key: keyof DeviceOwn, value: unknown | undefined) => {
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  if (touches(["activation"])) set("withoutPhrase", overrides.activation === undefined ? undefined : withoutPhraseOf(overrides.activation, assistantId))
  if (touches(["wakePhrases", "followUpSeconds"]) && assistantId !== undefined) {
    const any = overrides.wakePhrases !== undefined || overrides.followUpSeconds !== undefined
    set(
      "assistants",
      any
        ? withAssignment(own.assistants ?? inherited.assistants, assistantId, overrides.wakePhrases ?? phrasesOf(inherited, assistantId), overrides.followUpSeconds)
        : undefined
    )
  }
  if (touches(["wakeMatch"])) set("matching", overrides.wakeMatch)
  if (touches(["interruptMode"])) set("interruptMode", overrides.interruptMode)
  if (touches(AUDIO_FIELDS)) {
    const any = AUDIO_FIELDS.some((f) => overrides[f] !== undefined)
    const base = inherited.audio
    set("audio", any
      ? {
        echoCancellation: overrides.echoCancellation ?? base.echoCancellation,
        noiseSuppression: overrides.noiseSuppression ?? base.noiseSuppression,
        autoGainControl: overrides.autoGainControl ?? base.autoGainControl,
        speakAloud: own.audio?.speakAloud ?? base.speakAloud,
        outputPath: overrides.outputPath ?? base.outputPath,
        prebufferMs: overrides.prebufferMs ?? base.prebufferMs
      }
      : undefined)
  }
  if (touches(CAPTION_FIELDS)) {
    const any = CAPTION_FIELDS.some((f) => overrides[f] !== undefined)
    set("captions", any
      ? { captions: overrides.captions ?? inherited.captions.captions, speakTyped: overrides.speakReplies ?? inherited.captions.speakTyped }
      : undefined)
  }
  return out as DeviceOwn
}

const builtInOf = (kind: string): DeviceSettings => deviceTypeOf(kind)?.builtIn ?? BUILT_IN_WEB_VOICE_SETTINGS
const stripRev = <A extends { readonly rev: number }>(a: A): Omit<A, "rev"> => {
  const { rev: _, ...rest } = a
  return rest
}

// -- The migration ---------------------------------------------------------------------------------------------------

export interface MigrationInput {
  readonly file: SettingsFileV3
  /** The version the file was read from (1, 2 or 3; 0: there was no file). */
  readonly from: number
  /** Saved secrets (flat and per module): only whether a module's key is set is read. */
  readonly secrets?: { readonly assistant: Readonly<Record<string, string>>; readonly modules: Readonly<Record<string, Readonly<Record<string, string>>>> }
  readonly context: AssistantContext
  readonly now: number
}

/**
 * Version 3 → 4 (docs/ASSISTANTS.md §6): one assistant from the effective settings, the kind defaults as type
 * defaults, each device's overrides as own sections, and the notes. Flat keys and module records stay as they are
 * (today's engines and module host read them). A missing file (`from: 0`) gives the default install, without a
 * migration record.
 */
export const migrateToV4 = (input: MigrationInput): SettingsFile => {
  const { file, context } = input
  const env = context.env ?? {}
  const notes: Array<string> = []
  const secrets = input.secrets ?? { assistant: {}, modules: {} }
  const flat = effectiveFlat(file.assistant, secrets.assistant, env)
  const get = (key: string) => flat.get(key)
  const webKind = file.frontends[WEB_VOICE_KIND] ?? {}
  const idleBuiltIn = clampInt(get("CONVERSATION_IDLE_MINUTES"), 0, CONVERSATION_IDLE_MINUTES_LIMITS.max, DEFAULT_CONVERSATION_IDLE_MINUTES)

  // 1. The assistant.
  const account = accountOf(get("LLM_PROVIDER"))
  const subscription = account === "claude-subscription" ? subscriptionSettings(file.modules, context) : undefined
  const llm: AssistantLlm = {
    account,
    model: modelFor(account, get, file.modules, context),
    effort: oneOf(get("ANTHROPIC_EFFORT"), ["low", "medium", "high"], "low"),
    thinking: get("ANTHROPIC_THINKING") === "adaptive" ? "adaptive" : "off",
    maxTokens: clampInt(get("ANTHROPIC_MAX_TOKENS"), 64, 8192, 1024),
    giveUpMs: clampInt(get("ANTHROPIC_TIMEOUT_MS"), 1000, 60_000, 5000),
    warmUp: bool(get("ANTHROPIC_WARM_UP"), true),
    useModules: subscription?.tools ?? SUBSCRIPTION_DEFAULTS.tools,
    freshSessionAfterMinutes: subscription?.sessionIdleMinutes ?? SUBSCRIPTION_DEFAULTS.sessionIdleMinutes
  }
  if (get("LLM_PROVIDER") !== undefined && !["fake", "anthropic", "claude-subscription"].includes(String(get("LLM_PROVIDER")))) {
    notes.push(`The language model "${String(get("LLM_PROVIDER")).slice(0, 40)}" is not an account; the assistant uses the offline stand-in.`)
  }
  const hearing: AssistantHearing = {
    engine: get("STT_PROVIDER") === "deepgram" ? "deepgram" : "sherpa",
    model: sherpaModel(get("STT_SHERPA_MODEL")),
    language: oneOf(get("STT_SHERPA_LANGUAGE"), ["auto", "en", "nl", "de", "fr", "es", "it", "pt"], "auto"),
    eagerSilenceMs: clampInt(get("STT_SHERPA_EAGER_SILENCE_MS"), 50, 2000, 250),
    finalSilenceMs: clampInt(get("STT_SHERPA_FINAL_SILENCE_MS"), 100, 3000, 600),
    minSpeechMs: clampInt(get("STT_SHERPA_MIN_SPEECH_MS"), 20, 1000, 100),
    agc: bool(get("STT_SHERPA_AGC"), true),
    agcMaxGainDb: clampNum(get("STT_SHERPA_AGC_MAX_GAIN_DB"), 0, 40, 30),
    vadThreshold: clampNum(get("STT_SHERPA_VAD_THRESHOLD"), 0.05, 0.95, SherpaStt.DEFAULT_VAD_THRESHOLD),
    deepgram: {
      eotThreshold: clampNum(get("DEEPGRAM_EOT_THRESHOLD"), 0.5, 1, 0.7),
      eagerEotThreshold: clampNum(get("DEEPGRAM_EAGER_EOT_THRESHOLD"), 0, 0.9, 0.5),
      eotTimeoutMs: clampInt(get("DEEPGRAM_EOT_TIMEOUT_MS"), 500, 10_000, 5000)
    }
  }
  // The voice: the voice providers' resolution, over environment > saved (it also reads keys without a field).
  const voiceValue = (key: string): string | undefined => {
    const fromEnv = nonEmpty(env[key])
    if (fromEnv !== undefined) return fromEnv
    const saved = file.assistant[key]
    return saved === undefined || saved === null ? undefined : String(saved)
  }
  const resolved = resolveAssistantVoice(voiceValue)
  let voice = DEFAULT_ASSISTANT_VOICE
  if ("problem" in resolved) {
    notes.push(`${resolved.problem}; the assistant speaks with the voice on this machine.`)
  } else {
    voice = resolved.ref
    if (input.from > 0 && resolved.source === "migrated") notes.push(...resolved.notes)
  }
  const modules: Record<string, ModuleChoice> = {}
  if (context.catalog !== undefined) {
    for (const def of context.catalog) {
      if (isCapability(def) && wasEnabled(def, file.modules, secrets.modules, env)) modules[def.id] = { on: true, offTools: [] }
    }
  } else {
    for (const [id, record] of Object.entries(file.modules)) if (record.enabled === true) modules[id] = { on: true, offTools: [] }
  }
  let prompt = String(get("SYSTEM_PROMPT") ?? defaultSystemPrompt).slice(0, 4000)
  if (subscription !== undefined && subscription.systemPrompt.trim() !== "") {
    prompt = subscription.systemPrompt.slice(0, 4000)
    notes.push("The Claude subscription agent's own system prompt is now the assistant's prompt (it replaced the global one).")
  }
  const kindIdle = webKind.conversationIdleMinutes
  const assistant: Assistant = {
    id: MIGRATED_ASSISTANT_ID,
    rev: 0,
    name: MIGRATED_ASSISTANT_NAME,
    purpose: "",
    handles: "",
    on: true,
    prompt,
    toolRounds: clampInt(get("MAX_TOOL_ROUNDS"), 0, 10, 5),
    followUpSeconds: clampInt(webKind.followUpSeconds, 0, 120, DEFAULT_DEVICE_PROFILE.followUpSeconds),
    newConversationAfter: quietSpellOf(kindIdle ?? idleBuiltIn),
    replyEarly: subscription?.speculate ?? true,
    confirmActions: "off",
    llm,
    hearing,
    voice: { provider: voice.provider, voiceId: voice.voiceId },
    modules
  }
  const id = assistant.id

  // 2. Type defaults (every kind with defaults, and always the browsers).
  const kinds = new Set([WEB_VOICE_KIND, ...Object.keys(file.frontends)])
  const deviceTypes: Record<string, StoredDeviceType> = {}
  for (const kind of kinds) {
    const profile = effectiveProfile(file.frontends[kind] ?? {}, {}, builtInProfile(idleBuiltIn))
    deviceTypes[kind] = { ...settingsFromProfile(profile, id), rev: 0 }
  }

  // 3. Devices.
  const devices: Record<string, StoredDevice> = {}
  let droppedIdle = 0
  let droppedVoice = 0
  let ownSections = 0
  for (const [deviceId, record] of Object.entries(file.devices)) {
    const inherited = deviceTypes[record.kind] !== undefined ? (stripRev(deviceTypes[record.kind]!) as DeviceSettings) : builtInOf(record.kind)
    const own = ownFromOverrides({}, presentFields(record.overrides), record.overrides, inherited, id)
    if (record.overrides.conversationIdleMinutes !== undefined) droppedIdle++
    if (record.overrides.voice !== undefined && record.overrides.voice !== "") droppedVoice++
    if (own.audio !== undefined || own.captions !== undefined || own.assistants !== undefined) ownSections++
    devices[deviceId] = { kind: record.kind, name: record.name, firstSeen: record.firstSeen, lastSeen: record.lastSeen, own, rev: 0 }
  }

  // Notes (docs/ASSISTANTS.md §6, "Behaviour changes and losses").
  if (input.from > 0) {
    if (droppedIdle > 0) {
      notes.push(`${droppedIdle} device${droppedIdle === 1 ? "'s" : "s'"} own "new conversation after" setting was dropped: the reset time is now the assistant's.`)
    }
    if (droppedVoice > 0) notes.push(`${droppedVoice} device${droppedVoice === 1 ? "'s" : "s'"} own voice was dropped: the assistant's voice is used (as it already was).`)
    const always = Object.values(deviceTypes).some((t) => t.withoutPhrase.mode === "assistant") ||
      Object.values(devices).some((d) => d.own.withoutPhrase?.mode === "assistant")
    if (always) {
      notes.push('Devices that answer everything now remove a wake phrase said at the start: "Hey Jeff, what time is it?" reaches the model as "what time is it?".')
    }
    if (ownSections > 0) {
      notes.push(
        `${ownSections} device${ownSections === 1 ? " has" : "s have"} own values that now cover a whole section (assistants and phrases, audio or captions), ` +
          "frozen at their values now: later changes to the browser defaults of that section no longer reach them."
      )
    }
    const savedKeys = ASSISTANT_KEYS.map((k) => k.key).filter((k) => Object.hasOwn(file.assistant, k))
    if (savedKeys.length > 0) {
      notes.push(`Copied into the assistant: ${savedKeys.join(", ")}. The saved values stay in the file; they will no longer be read once the engines use the assistant.`)
    }
    const flags = Object.entries(file.modules).filter(([, r]) => r.enabled !== undefined).map(([m]) => m)
    if (flags.length > 0) notes.push(`Module switches (${flags.join(", ")}) are now the assistant's module choices; the old switches stay in the file.`)
    const locked = withEnvironment(assistant, context).locks.map((l) => l.key)
    if (locked.length > 0) notes.push(`Set in the environment and locked on the assistant: ${locked.join(", ")}.`)
  }

  return {
    version: 4,
    ...(file.revision !== undefined ? { revision: file.revision } : {}),
    modules: file.modules,
    assistant: file.assistant,
    assistants: { order: [id], byId: { [id]: assistant } },
    deviceTypes,
    devices,
    ...(input.from > 0 ? { migration: { from: input.from, at: input.now, notes } } : {})
  }
}

// -- Migration helpers -----------------------------------------------------------------------------------------------

/** Today's CONVERSATION_IDLE_MINUTES (environment > saved > default): the built-in under every kind's defaults. */
export const idleBuiltInOf = (flat: Readonly<Record<string, unknown>>, context: AssistantContext): number => {
  const fromEnv = nonEmpty(context.env?.CONVERSATION_IDLE_MINUTES)
  return clampInt(fromEnv ?? flat.CONVERSATION_IDLE_MINUTES, 0, CONVERSATION_IDLE_MINUTES_LIMITS.max, DEFAULT_CONVERSATION_IDLE_MINUTES)
}
