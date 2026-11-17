import { Schema } from "effect"
import { Assistant, AssistantId, MAX_ASSIGNMENTS, MAX_PHRASES_PER_DEVICE } from "./assistants.ts"
import type { AssistantHearing, Issue } from "./assistants.ts"
import { DeviceLook, DeviceVoice, FOLLOW_ASSISTANT, Look, lookFor } from "./looks.ts"
import { InterruptMode, NonNegativeFinite, OutputPath } from "./common.ts"
import { DeviceId, DeviceInfo, DeviceName, FrontendKindId, PrebufferMs, WAKE_PHRASES_MAX, WakeMatch, WakePhrase, wakeWords, WEB_VOICE_KIND } from "./frontends.ts"
import { BUILT_IN_PLACE, CapabilityOverrides, DeclaredCapabilities, DeviceLiveState, DevicePlace, NO_OVERRIDES } from "./capabilities.ts"

/**
 * Devices, device types and assignments (docs/ASSISTANTS.md §2.3, §2.6, protocol 7 schemas). Pure and browser-safe.
 *
 * Front-end kinds and devices are merged: each **device type** has a defaults entry (`DeviceSettings`, complete);
 * a **device** follows it unless it has its own value for a settings **section** (a key of `DeviceSettings`).
 * Each entry holds an ordered list of **assignments**: which assistants answer, and their wake phrases.
 *
 * This file is additive next to `frontends.ts` (protocol 5/6), which stays until the old messages are removed:
 * names here that would clash carry another name (`DeviceRecordInfo`, not `DeviceInfo`).
 */

/** The kind of a device (`web-voice` today; `voice-node` is added by the voice-node work). */
export const DeviceKind = FrontendKindId
export type DeviceKind = typeof DeviceKind.Type

export const MAX_ASSIGNMENT_FOLLOW_UP_SECONDS = 120
export const TYPESAFE_GIVE_UP_MS = { min: 100, max: 2000, default: 400 } as const

// -- Schemas (§2.3) --------------------------------------------------------------------------------------------------

export const Assignment = Schema.Struct({
  assistant: AssistantId,
  phrases: Schema.Array(WakePhrase).check(Schema.isMaxLength(WAKE_PHRASES_MAX)),
  /** Absent: the assistant's own. The device's value wins over the assistant's. */
  followUpSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ASSIGNMENT_FOLLOW_UP_SECONDS })))
})
export type Assignment = typeof Assignment.Type

/** Who answers an utterance that has no wake phrase and no open window. */
export const WithoutPhrase = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("nobody") }),
  Schema.Struct({ mode: Schema.Literal("assistant"), assistant: AssistantId }),
  Schema.Struct({
    mode: Schema.Literal("typesafe"),
    fallback: Schema.NullOr(AssistantId),
    giveUpMs: Schema.Int.check(Schema.isBetween({ minimum: TYPESAFE_GIVE_UP_MS.min, maximum: TYPESAFE_GIVE_UP_MS.max }))
  })
])
export type WithoutPhrase = typeof WithoutPhrase.Type

const DeviceAudio = Schema.Struct({
  echoCancellation: Schema.Boolean,
  noiseSuppression: Schema.Boolean,
  autoGainControl: Schema.Boolean,
  /** Off = replies are shown, never spoken. */
  speakAloud: Schema.Boolean,
  /** The last two: web-voice only (advanced). */
  outputPath: OutputPath,
  prebufferMs: PrebufferMs
})

const DeviceCaptions = Schema.Struct({
  captions: Schema.Boolean,
  /** Was `speakReplies`. */
  speakTyped: Schema.Boolean
})

const AssignmentList = Schema.Array(Assignment).check(Schema.isMaxLength(MAX_ASSIGNMENTS))
const VoicePage = Schema.Struct({ pick: Schema.Boolean })

export const DeviceSettings = Schema.Struct({
  /** Ordered; the first is the hearer unless `withoutPhrase` names one. */
  assistants: AssignmentList,
  withoutPhrase: WithoutPhrase,
  matching: WakeMatch,
  /** web-voice only: "Let people pick the assistant on the device". */
  voicePage: VoicePage,
  interruptMode: InterruptMode,
  audio: DeviceAudio,
  /** web-voice only. */
  captions: DeviceCaptions,
  /** The character on the voice stage for every assistant on the device, or each assistant's (docs/LOOKS-AND-VOICES.md). */
  look: DeviceLook,
  /** The voice of every assistant on the device, or each assistant's own. */
  voice: DeviceVoice,
  /** Protocol 11 (P5): its room, how private it is, whose it is by default (`capabilities.ts`). */
  place: DevicePlace,
  /** Protocol 11 (P5): what the owner took away from what it declares (`effectiveCapabilities`). */
  capabilities: CapabilityOverrides
})
export type DeviceSettings = typeof DeviceSettings.Type

/** The name of one settings section (the unit of "own value · reset"). */
export const DeviceSettingsKey = Schema.Literals([
  "assistants",
  "withoutPhrase",
  "matching",
  "voicePage",
  "interruptMode",
  "audio",
  "captions",
  "look",
  "voice",
  "place",
  "capabilities"
])
export type DeviceSettingsKey = typeof DeviceSettingsKey.Type
export const DEVICE_SETTINGS_KEYS: ReadonlyArray<DeviceSettingsKey> = DeviceSettingsKey.literals

/** A device's own sections: each key present is an own value, absent follows the type defaults. */
export const DeviceOwn = Schema.Struct({
  assistants: Schema.optionalKey(AssignmentList),
  withoutPhrase: Schema.optionalKey(WithoutPhrase),
  matching: Schema.optionalKey(WakeMatch),
  voicePage: Schema.optionalKey(VoicePage),
  interruptMode: Schema.optionalKey(InterruptMode),
  audio: Schema.optionalKey(DeviceAudio),
  captions: Schema.optionalKey(DeviceCaptions),
  look: Schema.optionalKey(DeviceLook),
  voice: Schema.optionalKey(DeviceVoice),
  place: Schema.optionalKey(DevicePlace),
  capabilities: Schema.optionalKey(CapabilityOverrides)
})
export type DeviceOwn = typeof DeviceOwn.Type

/** `device.save` settings: a value sets the own section, `null` returns it to the type defaults (devices only). */
export const DeviceSettingsPatch = Schema.Struct({
  assistants: Schema.optionalKey(Schema.NullOr(AssignmentList)),
  withoutPhrase: Schema.optionalKey(Schema.NullOr(WithoutPhrase)),
  matching: Schema.optionalKey(Schema.NullOr(WakeMatch)),
  voicePage: Schema.optionalKey(Schema.NullOr(VoicePage)),
  interruptMode: Schema.optionalKey(Schema.NullOr(InterruptMode)),
  audio: Schema.optionalKey(Schema.NullOr(DeviceAudio)),
  captions: Schema.optionalKey(Schema.NullOr(DeviceCaptions)),
  look: Schema.optionalKey(Schema.NullOr(DeviceLook)),
  voice: Schema.optionalKey(Schema.NullOr(DeviceVoice)),
  place: Schema.optionalKey(Schema.NullOr(DevicePlace)),
  capabilities: Schema.optionalKey(Schema.NullOr(CapabilityOverrides))
})
export type DeviceSettingsPatch = typeof DeviceSettingsPatch.Type

/** A device as stored (`data/settings.json` `devices[id]`, without the id key). */
export const DeviceRecord = Schema.Struct({
  kind: DeviceKind,
  name: DeviceName,
  firstSeen: NonNegativeFinite,
  lastSeen: NonNegativeFinite,
  own: DeviceOwn,
  /** Protocol 11 (P5): what it declared last (`hello.device.capabilities`, `device.caps`), kept while it is offline. */
  declared: Schema.optionalKey(DeclaredCapabilities)
})
export type DeviceRecord = typeof DeviceRecord.Type

/** What a device save or a push addresses: a type's defaults entry or one device. */
export const DeviceTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("type"), type: DeviceKind }),
  Schema.Struct({ kind: Schema.Literal("device"), id: DeviceId })
])
export type DeviceTarget = typeof DeviceTarget.Type

/** Code registry entry (replaces `FRONTEND_KINDS`). */
export interface DeviceTypeDefinition {
  readonly kind: string
  /** "Browsers". */
  readonly title: string
  /** "browser". */
  readonly one: string
  readonly many: string
  readonly description: string
  /** The sections that apply to the kind; the others are ignored. */
  readonly keys: ReadonlyArray<DeviceSettingsKey>
  readonly builtIn: DeviceSettings
}

/** Built-in defaults of a browser. No assistant is assigned: nothing is heard until the admin (or the migration) assigns one. */
export const BUILT_IN_WEB_VOICE_SETTINGS: DeviceSettings = {
  assistants: [],
  withoutPhrase: { mode: "nobody" },
  matching: "close",
  voicePage: { pick: false },
  interruptMode: "confirm",
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, speakAloud: true, outputPath: "direct", prebufferMs: 60 },
  captions: { captions: true, speakTyped: true },
  look: FOLLOW_ASSISTANT,
  voice: FOLLOW_ASSISTANT,
  place: BUILT_IN_PLACE,
  capabilities: NO_OVERRIDES
}

export const WEB_VOICE_DEVICE_TYPE: DeviceTypeDefinition = {
  kind: WEB_VOICE_KIND,
  title: "Browsers",
  one: "browser",
  many: "browsers",
  description: "The voice page on a phone, tablet or computer.",
  keys: DEVICE_SETTINGS_KEYS,
  builtIn: BUILT_IN_WEB_VOICE_SETTINGS
}

export const DEVICE_TYPES: ReadonlyArray<DeviceTypeDefinition> = [WEB_VOICE_DEVICE_TYPE]

export const deviceTypeOf = (kind: string): DeviceTypeDefinition | undefined => DEVICE_TYPES.find((t) => t.kind === kind)

// -- Resolution (§2.6) -----------------------------------------------------------------------------------------------

/**
 * Effective device settings, per section: the device's own value, else the type defaults, else the built-in.
 * A section is taken whole (no merging inside it). Sections that do not apply to the kind are still returned and
 * are ignored by whoever reads them (see `applicableKeys`).
 */
export const effectiveDeviceSettings = (
  builtIn: DeviceSettings,
  typeDefaults: DeviceOwn | undefined,
  own: DeviceOwn | undefined
): DeviceSettings => {
  const out: Record<string, unknown> = {}
  for (const key of DEVICE_SETTINGS_KEYS) {
    out[key] = own?.[key] ?? typeDefaults?.[key] ?? builtIn[key]
  }
  return out as DeviceSettings
}

/** The sections of `own` that apply to a device of this type (the rest are ignored). */
export const applicableOwn = (type: Pick<DeviceTypeDefinition, "keys">, own: DeviceOwn): DeviceOwn => {
  const out: Record<string, unknown> = {}
  for (const key of type.keys) if (own[key] !== undefined) out[key] = own[key]
  return out as DeviceOwn
}

/**
 * The device's recogniser owner (its *hearer*): the assistant that answers without a phrase, else the first
 * assignment, else `null` (no assistant: no recogniser runs). Whether it is switched on does not matter.
 */
export const hearerOf = (settings: Pick<DeviceSettings, "assistants" | "withoutPhrase">): string | null =>
  settings.withoutPhrase.mode === "assistant" ? settings.withoutPhrase.assistant : settings.assistants[0]?.assistant ?? null

/** The hearing settings the device uses: the hearer's own. `undefined` when there is no hearer or it is unknown. */
export const hearingFor = (
  settings: Pick<DeviceSettings, "assistants" | "withoutPhrase">,
  assistants: ReadonlyMap<string, Pick<Assistant, "hearing">>
): AssistantHearing | undefined => {
  const hearer = hearerOf(settings)
  return hearer === null ? undefined : assistants.get(hearer)?.hearing
}

/** Follow-up window, seconds: the assignment's own value if set, else the assistant's; 0 = no window. */
export const effectiveFollowUpSeconds = (
  assignment: Pick<Assignment, "followUpSeconds">,
  assistant: Pick<Assistant, "followUpSeconds">
): number => assignment.followUpSeconds ?? assistant.followUpSeconds

/** The follow-up window of `assistantId` on this device in ms (0 for an unknown or unassigned assistant). */
export const followUpMsFor = (
  settings: Pick<DeviceSettings, "assistants">,
  assistants: ReadonlyMap<string, Pick<Assistant, "followUpSeconds">>,
  assistantId: string
): number => {
  const assignment = settings.assistants.find((a) => a.assistant === assistantId)
  const assistant = assistants.get(assistantId)
  return assignment === undefined || assistant === undefined ? 0 : effectiveFollowUpSeconds(assignment, assistant) * 1000
}

/**
 * What the route gate is built from (docs/ASSISTANTS.md §3.4 `RouteConfig`). A plain structural type: the gate in
 * `@pva/core` accepts a value of this shape without importing it from here.
 */
export interface RouteConfigShape {
  readonly phrases: ReadonlyArray<{ readonly phrase: string; readonly assistant: string }>
  readonly match: WakeMatch
  /** `decide` = TypeSafe (the dispatcher asks). */
  readonly withoutPhrase: "nobody" | "assistant" | "decide"
  /** With `assistant`. */
  readonly defaultAssistant?: string
  /** With `decide`: who answers when TypeSafe does not choose; `null` = nobody (also when the fallback is off). */
  readonly fallback?: string | null
  /** Per assigned assistant, its follow-up window on this device in ms (the device's own value wins). */
  readonly followUpMs: Readonly<Record<string, number>>
  /** Switched-off assistants (and assistants that do not exist: they are never routed). */
  readonly off: ReadonlySet<string>
  readonly armedMs?: number
}

type RouteAssistant = Pick<Assistant, "id" | "on" | "followUpSeconds">

/**
 * The gate's configuration from a device's effective settings and the assistants: every assignment's phrases in
 * list order, the matching, the without-phrase mode, and the set of assistants never routed.
 */
export const routeConfigFrom = (
  settings: Pick<DeviceSettings, "assistants" | "withoutPhrase" | "matching">,
  assistants: ReadonlyArray<RouteAssistant> | ReadonlyMap<string, RouteAssistant>
): RouteConfigShape => {
  const byId = assistants instanceof Map ? assistants : new Map((assistants as ReadonlyArray<RouteAssistant>).map((a) => [a.id, a]))
  const phrases: Array<{ phrase: string; assistant: string }> = []
  const off = new Set<string>()
  const followUpMs: Record<string, number> = {}
  for (const assignment of settings.assistants) {
    for (const phrase of assignment.phrases) phrases.push({ phrase, assistant: assignment.assistant })
    const known = byId.get(assignment.assistant)
    if (known !== undefined) followUpMs[assignment.assistant] = effectiveFollowUpSeconds(assignment, known) * 1000
    if (known === undefined || !known.on) off.add(assignment.assistant)
  }
  const wp = settings.withoutPhrase
  if (wp.mode === "assistant") {
    const known = byId.get(wp.assistant)
    if (known === undefined || !known.on) off.add(wp.assistant)
  }
  return {
    phrases,
    match: settings.matching,
    withoutPhrase: wp.mode === "typesafe" ? "decide" : wp.mode,
    ...(wp.mode === "assistant" ? { defaultAssistant: wp.assistant } : {}),
    ...(wp.mode === "typesafe" ? { fallback: typesafeFallback(settings, byId) } : {}),
    followUpMs,
    off
  }
}

/** Assistants TypeSafe may choose between: the device's assigned assistants that are switched on, in list order. */
export const typesafeCandidates = (
  settings: Pick<DeviceSettings, "assistants">,
  assistants: ReadonlyMap<string, Pick<Assistant, "on">>
): ReadonlyArray<string> =>
  settings.assistants.map((a) => a.assistant).filter((id) => assistants.get(id)?.on === true)

/** The TypeSafe fallback: the named assistant when it is assigned and on; a fallback that is off means nobody (`null`). */
export const typesafeFallback = (
  settings: Pick<DeviceSettings, "assistants" | "withoutPhrase">,
  assistants: ReadonlyMap<string, Pick<Assistant, "on">>
): string | null => {
  const wp = settings.withoutPhrase
  if (wp.mode !== "typesafe" || wp.fallback === null) return null
  const fallback = wp.fallback
  return assistants.get(fallback)?.on === true && settings.assistants.some((a) => a.assistant === fallback) ? fallback : null
}

/** What a typed message goes to; `dropped`: the target is switched off, or there is none. */
export type TypedTarget = { readonly assistant: string } | { readonly dropped: "off" | "none" }

/**
 * Typed text (§2.6): the named assistant (the voice page names the conversation shown), else the one holding a
 * follow-up window, else the `withoutPhrase` assistant, else the TypeSafe fallback, else the first in the list.
 * Never asks TypeSafe. A switched-off target (or an unknown one) drops the text, as for speech.
 * `named` that does not exist, or is not assigned to this device, is ignored.
 */
export const typedTextTarget = (
  settings: Pick<DeviceSettings, "assistants" | "withoutPhrase">,
  assistants: ReadonlyMap<string, Pick<Assistant, "on">>,
  input: { readonly named?: string | undefined; readonly followUpHolder?: string | undefined } = {}
): TypedTarget => {
  const wp = settings.withoutPhrase
  const named = input.named
  const assigned = named !== undefined && assistants.has(named) && settings.assistants.some((a) => a.assistant === named)
  const chosen = (assigned ? named : undefined) ??
    input.followUpHolder ??
    (wp.mode === "assistant" ? wp.assistant : undefined) ??
    (wp.mode === "typesafe" && wp.fallback !== null ? wp.fallback : undefined) ??
    settings.assistants[0]?.assistant
  if (chosen === undefined) return { dropped: "none" }
  return assistants.get(chosen)?.on === true ? { assistant: chosen } : { dropped: "off" }
}

export type Reach = "phrase" | "without-phrase" | "typesafe" | "unreachable"

/**
 * How an assigned assistant can be reached on a device (`AssistantInfo.usedOn[].reach`): named by `withoutPhrase`
 * ("without-phrase"), else with at least one phrase ("phrase"), else on a TypeSafe device ("typesafe"), else
 * "unreachable". Not assigned: `undefined`.
 */
export const reachOf = (
  settings: Pick<DeviceSettings, "assistants" | "withoutPhrase">,
  assistantId: string
): Reach | undefined => {
  const assignment = settings.assistants.find((a) => a.assistant === assistantId)
  if (assignment === undefined) return undefined
  if (settings.withoutPhrase.mode === "assistant" && settings.withoutPhrase.assistant === assistantId) return "without-phrase"
  if (assignment.phrases.length > 0) return "phrase"
  if (settings.withoutPhrase.mode === "typesafe") return "typesafe"
  return "unreachable"
}

export interface UsedOn {
  readonly target: DeviceTarget
  readonly hears: boolean
  readonly reach: Reach
}

/** Where an assistant is assigned, over the given effective settings (the delete dialog names these). */
export const assistantUsedOn = (
  assistantId: string,
  entries: ReadonlyArray<{ readonly target: DeviceTarget; readonly settings: Pick<DeviceSettings, "assistants" | "withoutPhrase"> }>
): ReadonlyArray<UsedOn> => {
  const out: Array<UsedOn> = []
  for (const { target, settings } of entries) {
    const reach = reachOf(settings, assistantId)
    if (reach !== undefined) out.push({ target, hears: hearerOf(settings) === assistantId, reach })
  }
  return out
}

// -- Validation (§2.3) -----------------------------------------------------------------------------------------------

export const phraseKey = (phrase: string): string => wakeWords(phrase).join(" ")

/** The phrases of a settings value, normalised, as (assistant, key) pairs. */
const phraseEntries = (assignments: ReadonlyArray<Assignment>) =>
  assignments.flatMap((a) => a.phrases.map((p) => ({ assistant: a.assistant, key: phraseKey(p), phrase: p })))

export interface DeviceValidation {
  /** Refuse the save. `code` is one of `duplicate_phrase`, `unknown_assistant`, `limit_reached`, `invalid`. */
  readonly errors: ReadonlyArray<Issue>
  /** Ask "Save anyway": assistants that cannot be reached; on a TypeSafe device, switched-on assistants without Handles. */
  readonly warnings: ReadonlyArray<Issue>
}

/**
 * A device's (or type's) effective settings against the known assistant ids: every assignment's assistant exists
 * and appears once; `withoutPhrase` and `fallback` name only assigned assistants; one phrase (after `wakeWords`)
 * belongs to one assignment only (`duplicate_phrase`); at most `MAX_ASSIGNMENTS` assignments and
 * `MAX_PHRASES_PER_DEVICE` phrases. A warning for each assigned assistant that cannot be reached. With `assistants`
 * (their records): on a TypeSafe device, a warning (`no_handles`) for each switched-on assigned assistant whose Handles
 * is empty (§2.2: TypeSafe then goes by its name and purpose only).
 */
export const validateDeviceSettings = (
  settings: Pick<DeviceSettings, "assistants" | "withoutPhrase">,
  knownAssistants: ReadonlySet<string>,
  options: { readonly assistants?: ReadonlyMap<string, Pick<Assistant, "name" | "on" | "handles">> } = {}
): DeviceValidation => {
  const errors: Array<Issue> = []
  const warnings: Array<Issue> = []
  const assigned = new Set<string>()
  if (settings.assistants.length > MAX_ASSIGNMENTS) {
    errors.push({ code: "limit_reached", path: "assistants", message: `At most ${MAX_ASSIGNMENTS} assistants on one device.` })
  }
  settings.assistants.forEach((a, i) => {
    if (!knownAssistants.has(a.assistant)) {
      errors.push({ code: "unknown_assistant", path: `assistants.${i}`, message: `There is no assistant ${a.assistant}.` })
    }
    if (assigned.has(a.assistant)) {
      errors.push({ code: "invalid", path: `assistants.${i}`, message: `${a.assistant} is in the list twice.` })
    }
    assigned.add(a.assistant)
  })
  const phrases = phraseEntries(settings.assistants)
  if (phrases.length > MAX_PHRASES_PER_DEVICE) {
    errors.push({ code: "limit_reached", path: "assistants", message: `At most ${MAX_PHRASES_PER_DEVICE} wake phrases on one device.` })
  }
  const seen = new Set<string>()
  for (const p of phrases) {
    if (seen.has(p.key)) {
      errors.push({ code: "duplicate_phrase", path: "assistants", message: `The phrase "${p.phrase}" is used twice on this device.` })
    }
    seen.add(p.key)
  }
  const wp = settings.withoutPhrase
  if (wp.mode === "assistant") {
    if (!knownAssistants.has(wp.assistant)) {
      errors.push({ code: "unknown_assistant", path: "withoutPhrase.assistant", message: `There is no assistant ${wp.assistant}.` })
    } else if (!assigned.has(wp.assistant)) {
      errors.push({ code: "invalid", path: "withoutPhrase.assistant", message: `${wp.assistant} is not in the list of this device.` })
    }
  } else if (wp.mode === "typesafe" && wp.fallback !== null) {
    if (!knownAssistants.has(wp.fallback)) {
      errors.push({ code: "unknown_assistant", path: "withoutPhrase.fallback", message: `There is no assistant ${wp.fallback}.` })
    } else if (!assigned.has(wp.fallback)) {
      errors.push({ code: "invalid", path: "withoutPhrase.fallback", message: `${wp.fallback} is not in the list of this device.` })
    }
  }
  for (const a of settings.assistants) {
    if (reachOf(settings, a.assistant) === "unreachable") {
      warnings.push({
        code: "unreachable",
        path: `assistants.${a.assistant}`,
        message: `${a.assistant} cannot be reached: no wake phrase, not the one that answers without a phrase, and no TypeSafe.`
      })
    }
    const record = options.assistants?.get(a.assistant)
    if (wp.mode === "typesafe" && record !== undefined && record.on && record.handles.trim() === "") {
      warnings.push({
        code: "no_handles",
        path: `assistants.${a.assistant}.handles`,
        message: `${record.name} has no Handles text, so TypeSafe can only go by its name and purpose.`
      })
    }
  }
  return { errors, warnings }
}

// -- Deleting an assistant (§2.6) ------------------------------------------------------------------------------------

/**
 * Remove a deleted assistant from one settings value (a type's complete defaults or a device's own sections):
 * out of the assignment list; a `withoutPhrase` naming it becomes `nobody`; a TypeSafe `fallback` naming it becomes
 * the first remaining assistant of the list, else `null`. Only sections present are changed. `inheritedAssistants`
 * is the list in force when `settings` has none of its own (a device's own `withoutPhrase` over the type's list).
 */
export const removeAssistantFromSettings = <S extends DeviceOwn>(
  settings: S,
  assistantId: string,
  inheritedAssistants: ReadonlyArray<Assignment> = []
): S => {
  const out: Record<string, unknown> = { ...settings }
  const list = (settings.assistants ?? inheritedAssistants).filter((a) => a.assistant !== assistantId)
  if (settings.assistants !== undefined) out.assistants = list
  const wp = settings.withoutPhrase
  if (wp !== undefined) {
    if (wp.mode === "assistant" && wp.assistant === assistantId) out.withoutPhrase = { mode: "nobody" }
    else if (wp.mode === "typesafe" && wp.fallback === assistantId) {
      out.withoutPhrase = { ...wp, fallback: list[0]?.assistant ?? null }
    }
  }
  return out as S
}

// -- Pushes and what a voice connection learns (§5.3, §5.4) ----------------------------------------------------------

/** What a resource (language model, voice) is doing, for the admin pages. */
export const ResourceState = Schema.Literals(["unused", "starting", "ready", "failed"])
export type ResourceState = typeof ResourceState.Type

export const AssistantUsedOn = Schema.Struct({
  target: DeviceTarget,
  hears: Schema.Boolean,
  reach: Schema.Literals(["phrase", "without-phrase", "typesafe", "unreachable"])
})

/** `assistants` push: the assistant, where it is used, how its resources are doing, and its problems. */
export const AssistantInfo = Schema.Struct({
  ...Assistant.fields,
  usedOn: Schema.Array(AssistantUsedOn),
  resources: Schema.Struct({ llm: ResourceState, voice: ResourceState }),
  problems: Schema.Array(Schema.String)
})
export type AssistantInfo = typeof AssistantInfo.Type

/** One device type for admin: the registry entry with its (complete) defaults and rev. */
export const DeviceTypeInfo = Schema.Struct({
  kind: DeviceKind,
  title: Schema.String,
  one: Schema.String,
  many: Schema.String,
  description: Schema.String,
  keys: Schema.Array(DeviceSettingsKey),
  settings: DeviceSettings,
  rev: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export type DeviceTypeInfo = typeof DeviceTypeInfo.Type

/** One remembered device for admin (protocol 7 `devices`; named apart from the protocol 5 `DeviceInfo`). */
export const DeviceRecordInfo = Schema.Struct({
  id: DeviceId,
  kind: DeviceKind,
  name: DeviceName,
  firstSeen: NonNegativeFinite,
  lastSeen: NonNegativeFinite,
  own: DeviceOwn,
  /** Effective settings (type defaults ← own). */
  settings: DeviceSettings,
  /** The hearer's assistant id; `null`: none. */
  hearer: Schema.NullOr(AssistantId),
  rev: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  connections: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  audioOwner: Schema.Boolean,
  /** Protocol 11: what it declared last, and when. */
  declared: Schema.optionalKey(DeclaredCapabilities),
  /** Protocol 11: whether it is visible now and when it was last used (connected devices). */
  live: Schema.optionalKey(DeviceLiveState)
})
export type DeviceRecordInfo = typeof DeviceRecordInfo.Type

/**
 * One remembered device for admin, as `devices` and `admin.snapshot.devices` carry it in protocol 7: the protocol 5
 * `DeviceInfo` (kept until the UI packages stop reading `overrides` and `profile`) with the protocol 7 fields added.
 */
export const DeviceListInfo = Schema.Struct({
  ...DeviceInfo.fields,
  own: DeviceOwn,
  settings: DeviceSettings,
  hearer: Schema.NullOr(AssistantId),
  rev: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Protocol 11 (P5): what it declared last, and when ("What it can do" in admin). */
  declared: Schema.optionalKey(DeclaredCapabilities),
  /** Protocol 11: whether a tab of it is visible now and when it was last used (while connected). */
  live: Schema.optionalKey(DeviceLiveState)
})
export type DeviceListInfo = typeof DeviceListInfo.Type

/**
 * What a voice connection learns about its own device (`device.setup`, `snapshot.setup`): never another device's
 * setup, and never a prompt, model, key or Handles.
 */
export const DeviceSetup = Schema.Struct({
  deviceId: Schema.optionalKey(DeviceId),
  /** List order. */
  assistants: Schema.Array(Schema.Struct({
    id: AssistantId,
    name: Schema.String,
    purpose: Schema.String,
    on: Schema.Boolean,
    phrases: Schema.Array(Schema.String),
    /** The stage's character while this assistant answers here: the device's look, else the assistant's; absent = the baseline. */
    look: Schema.optionalKey(Look)
  })),
  /** The device's own look, when it has one: shown when no assistant is listed. Absent = follow the assistant (or the baseline). */
  look: Schema.optionalKey(Look),
  withoutPhrase: Schema.Union([
    Schema.Struct({ mode: Schema.Literal("nobody") }),
    Schema.Struct({ mode: Schema.Literal("assistant"), assistant: AssistantId }),
    Schema.Struct({ mode: Schema.Literal("typesafe"), fallback: Schema.NullOr(AssistantId) })
  ]),
  /** `voicePage.pick`, and more than one assistant. */
  canPick: Schema.Boolean,
  /** TypeSafe is set up ("Whichever fits" in the menu). */
  canAuto: Schema.Boolean,
  interruptMode: InterruptMode,
  audio: DeviceAudio,
  captions: DeviceCaptions
})
export type DeviceSetup = typeof DeviceSetup.Type

/** A voice connection's setup from the device's effective settings. Assignments of unknown assistants are left out. */
export const deviceSetupFrom = (
  settings: DeviceSettings,
  assistants: ReadonlyMap<string, Pick<Assistant, "id" | "name" | "purpose" | "on" | "look">>,
  options: { readonly deviceId?: string | undefined; readonly canAuto: boolean }
): DeviceSetup => {
  const listed = settings.assistants.flatMap((a) => {
    const known = assistants.get(a.assistant)
    if (known === undefined) return []
    const look = lookFor(settings.look, known)
    return [{ id: known.id, name: known.name, purpose: known.purpose, on: known.on, phrases: [...a.phrases], ...(look !== undefined ? { look } : {}) }]
  })
  const wp = settings.withoutPhrase
  return {
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    assistants: listed,
    withoutPhrase: wp.mode === "typesafe" ? { mode: "typesafe", fallback: wp.fallback } : wp,
    canPick: settings.voicePage.pick && listed.length > 1,
    canAuto: options.canAuto,
    interruptMode: settings.interruptMode,
    // P5: "Don't use its speaker" (the `capabilities` section) means nothing is spoken here, typed replies included.
    audio: settings.capabilities.noSpeaker ? { ...settings.audio, speakAloud: false } : settings.audio,
    captions: settings.capabilities.noSpeaker ? { ...settings.captions, speakTyped: false } : settings.captions,
    ...(settings.look.from === "device" ? { look: settings.look.look } : {})
  }
}
