import type {
  Assistant,
  AssistantBody,
  AssistantInfo,
  DeviceListInfo,
  DeviceTarget,
  DeviceTypeInfo,
  FieldError,
  LlmAccountId,
  ModuleInfo,
  SettingsSection
} from "@pva/protocol"
import type { ResultMessage } from "./connection.ts"

/**
 * The admin pages of assistants (docs/ASSISTANTS.md §2.2, §7): pure helpers shared by the list, the assistant page,
 * and the pages of later packages (wizard, devices, voice page). No React, no network.
 */

// ---- Tabs

export const ASSISTANT_TABS = [
  ["basics", "Basics"],
  ["behaviour", "Behaviour"],
  ["model", "Language model"],
  ["hearing", "Hearing"],
  ["voice", "Voice"],
  ["modules", "Modules"],
  ["used", "Used on"]
] as const
export type AssistantTab = (typeof ASSISTANT_TABS)[number][0]

export const isAssistantTab = (s: string | undefined): s is AssistantTab => ASSISTANT_TABS.some(([k]) => k === s)

/** The fields (dotted paths, as the server's `fieldErrors` name them) that each tab edits; a prefix covers its children. */
export const TAB_PATHS: Readonly<Record<AssistantTab, ReadonlyArray<string>>> = {
  basics: ["name", "purpose", "handles", "on"],
  behaviour: ["prompt", "toolRounds", "followUpSeconds", "newConversationAfter", "replyEarly", "confirmActions"],
  model: ["llm"],
  hearing: ["hearing"],
  voice: ["voice"],
  modules: ["modules"],
  used: []
}

export const tabOfPath = (path: string): AssistantTab | undefined =>
  ASSISTANT_TABS.map(([k]) => k).find((k) => TAB_PATHS[k].some((p) => path === p || path.startsWith(`${p}.`)))

// ---- Plain-data paths

export const getPath = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((x, k) => (x === null || typeof x !== "object" ? undefined : (x as Record<string, unknown>)[k]), o)

/** A copy of `o` with `path` set (objects along the way are copied, never changed). */
export const setPath = <T>(o: T, path: string, value: unknown): T => {
  const go = (x: unknown, keys: ReadonlyArray<string>): unknown => {
    const [head, ...rest] = keys
    const base = x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {}
    return { ...base, [head!]: rest.length === 0 ? value : go(base[head!], rest) }
  }
  return go(o, path.split(".")) as T
}

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** The assistant as the server stores and expects it (an `assistants` entry also carries `usedOn`, `resources`, `problems`). */
export const toAssistant = (a: Assistant | AssistantInfo): Assistant => {
  const { usedOn: _u, resources: _r, problems: _p, ...rest } = a as AssistantInfo
  return rest
}

export const toBody = (a: Assistant | AssistantInfo): AssistantBody => {
  const { id: _i, rev: _v, ...body } = toAssistant(a)
  return body
}

// ---- Results of the assistant messages

export type Outcome =
  | { readonly kind: "ok"; readonly assistantId?: string | undefined }
  /** The entity changed since the page read it: reload it and tell the user. */
  | { readonly kind: "stale"; readonly message: string }
  /** `invalid_settings` (and its specific codes) with the dotted paths of the fields that refused. */
  | { readonly kind: "invalid"; readonly message: string; readonly fieldErrors: ReadonlyArray<FieldError> }
  /** Would work, looks like a mistake: nothing saved; send again with `saveAnyway`. */
  | { readonly kind: "warnings"; readonly message: string; readonly warnings: ReadonlyArray<FieldError> }
  | { readonly kind: "refused"; readonly code: string; readonly message: string }

export const outcomeOf = (r: ResultMessage): Outcome => {
  if (r.ok) return { kind: "ok", assistantId: r.assistantId }
  const e = r.error
  if (e === undefined) return { kind: "refused", code: "internal", message: "The assistant did not say why." }
  if (e.code === "stale") return { kind: "stale", message: e.message }
  if ((e.warnings?.length ?? 0) > 0 && (e.fieldErrors?.length ?? 0) === 0) return { kind: "warnings", message: e.message, warnings: e.warnings ?? [] }
  if ((e.fieldErrors?.length ?? 0) > 0) return { kind: "invalid", message: e.message, fieldErrors: e.fieldErrors ?? [] }
  return { kind: "refused", code: e.code, message: e.message }
}

/** The messages of the errors for one field (`path`) or any field below it. */
export const errorsFor = (errors: ReadonlyArray<FieldError>, path: string): ReadonlyArray<string> =>
  errors.filter((e) => e.key === path || (e.key?.startsWith(`${path}.`) ?? false)).map((e) => e.message)

// ---- Language model accounts

export interface AccountInfo {
  readonly id: LlmAccountId
  readonly title: string
  readonly tags: ReadonlyArray<"local" | "hosted" | "needs-key" | "experimental">
  readonly description: string
  readonly implication: string
}

export const ACCOUNTS: ReadonlyArray<AccountInfo> = [
  {
    id: "anthropic",
    title: "Anthropic API",
    tags: ["hosted", "needs-key"],
    description: "Your own API key, billed per use.",
    implication: "What you say is sent to Anthropic."
  },
  {
    id: "claude-subscription",
    title: "Claude subscription",
    tags: ["hosted", "experimental"],
    description: "Claude Code with your own Claude login on this machine; replies count against your plan's limits.",
    implication: "What you say is sent to Anthropic through Claude Code."
  },
  {
    id: "openrouter",
    title: "OpenRouter",
    tags: ["hosted", "needs-key"],
    description: "Many models through one key, billed per use.",
    implication: "What you say is sent to OpenRouter and the model's provider."
  },
  {
    id: "home-model",
    title: "Home model",
    tags: ["local"],
    description: "A model on your own network (OpenAI-compatible).",
    implication: "What you say stays on your network."
  },
  {
    id: "offline",
    title: "Offline stand-in",
    tags: ["local"],
    description: "Echoes what you say and answers time questions. No language model.",
    implication: "No language model: the replies are canned."
  }
]

export const accountInfo = (id: LlmAccountId): AccountInfo => ACCOUNTS.find((a) => a.id === id) ?? ACCOUNTS[0]!

/** Accounts whose model is one of a list. */
export const CLAUDE_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const

export const modelChoices = (account: LlmAccountId): ReadonlyArray<string> | undefined =>
  account === "anthropic" || account === "claude-subscription" ? CLAUDE_MODELS : undefined

/** The model to show after the account changes: kept when it is valid for the new account, else the account's first. */
export const modelAfterAccountChange = (account: LlmAccountId, model: string): string => {
  const choices = modelChoices(account)
  if (account === "offline") return ""
  if (choices !== undefined) return choices.includes(model) ? model : choices[0]!
  return (CLAUDE_MODELS as ReadonlyArray<string>).includes(model) ? "" : model
}

/** Whether the accounts the server has no builder for yet are chosen (docs/ASSISTANTS.md WP-13b). */
export const accountNotAvailableYet = (account: LlmAccountId): boolean => account === "openrouter" || account === "home-model"

export type AccountState = { readonly tone: "ok" | "todo" | "muted"; readonly text: string; readonly setUp?: ReadonlyArray<string> }

/**
 * What the admin knows of an account, from the sections and agent modules: the Anthropic key, the subscription
 * module's state. The accounts the server cannot build yet say so.
 */
export const accountState = (
  id: LlmAccountId,
  sections: ReadonlyArray<SettingsSection>,
  modules: ReadonlyArray<ModuleInfo>
): AccountState => {
  switch (id) {
    case "offline":
      return { tone: "ok", text: "Always ready" }
    case "anthropic": {
      const set = sections.some((s) => s.form.secrets.ANTHROPIC_API_KEY?.set === true)
      return set ? { tone: "ok", text: "Key set" } : { tone: "todo", text: "Set up…", setUp: ["language-model", "provider"] }
    }
    case "claude-subscription": {
      const m = modules.find((x) => x.id === "claude-subscription")
      if (m?.enabled === true && m.state === "running") return { tone: "ok", text: "Logged in" }
      return { tone: "todo", text: "Set up…", setUp: ["language-model", "claude-subscription"] }
    }
    default:
      return { tone: "muted", text: "Not available yet" }
  }
}

// ---- Naming

/** "Every browser" for a type's defaults, the device's name for a device. */
export const targetName = (t: DeviceTarget, devices: ReadonlyArray<Pick<DeviceListInfo, "id" | "name">>, types: ReadonlyArray<DeviceTypeInfo>): string => {
  if (t.kind === "device") return devices.find((d) => d.id === t.id)?.name ?? t.id
  const type = types.find((x) => x.kind === t.type)
  return type === undefined ? t.type : `Every ${type.one}`
}

export const targetKey = (t: DeviceTarget): string => (t.kind === "type" ? `type:${t.type}` : `device:${t.id}`)

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const listJoin = (a: ReadonlyArray<string>): string =>
  a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`

/** "Hey Jeff" → "“Hey Jeff”". */
export const quoted = (s: string) => `“${s}”`

// ---- The summary strip (list, page, Diagnostics)

export interface ModelNames {
  /** A hearing model's label by its preset name (from the speech section). */
  readonly hearing: (preset: string) => string
}

/** "en_US-lessac-medium" → "Lessac", "kokoro-af_heart" → "Heart": a voice's own words, when the catalog has not named it. */
const prettyVoice = (voiceId: string) => {
  const kokoro = /^kokoro-[a-z]{2}_(.+)$/.exec(voiceId)
  const last = kokoro?.[1] ?? voiceId.replace(/^[a-z]{2}_[A-Z]{2}-/, "").split("-")[0] ?? voiceId
  return last.charAt(0).toUpperCase() + last.slice(1)
}

/** `{ voiceName }` lets the page pass the catalog's name; else the id's own words. */
export const voiceWords = (a: Pick<Assistant, "voice">, name?: string): string =>
  `${name ?? prettyVoice(a.voice.voiceId)} · ${a.voice.provider === "sherpa" ? "on this machine" : a.voice.provider}`

/** Tools an assistant has: the tools of its switched-on modules minus those it switched off (modules that do not run list none). */
export const toolCount = (a: Pick<Assistant, "modules">, modules: ReadonlyArray<ModuleInfo>): number =>
  Object.entries(a.modules).reduce((n, [id, c]) => {
    if (!c.on) return n
    const m = modules.find((x) => x.id === id)
    return n + (m === undefined ? 0 : m.tools.filter((t) => !c.offTools.includes(t.name)).length)
  }, 0)

/** The mono summary lines: model and effort | hearing | voice | modules and tools. */
export const summaryParts = (a: Assistant, modules: ReadonlyArray<ModuleInfo>, names: ModelNames, voiceName?: string): ReadonlyArray<string> => {
  const model = a.llm.account === "offline" ? "offline stand-in" : a.llm.model
  const hearing = a.hearing.engine === "deepgram" ? "Deepgram" : names.hearing(a.hearing.model)
  const on = Object.values(a.modules).filter((c) => c.on).length
  return [
    `${model} · effort ${a.llm.effort}`,
    `${hearing} · end pause ${a.hearing.finalSilenceMs} ms`,
    voiceWords(a, voiceName),
    `${plural(on, "module")} · ${plural(toolCount(a, modules), "tool")}`
  ]
}

/** The label of a hearing preset: the speech section's option label (before " — "), else the preset name. */
export const hearingModelNames = (sections: ReadonlyArray<SettingsSection>): ModelNames => {
  const field = sections.flatMap((s) => s.form.fields).find((f) => f.key === "STT_SHERPA_MODEL")
  return {
    hearing: (preset) => {
      const label = field?.type === "choice" ? field.options.find((o) => o.value === preset)?.label : undefined
      return label === undefined ? preset : label.split(" — ")[0]!
    }
  }
}

// ---- A new assistant

/** What a blank assistant starts as: a short prompt, the Claude API, the local recogniser and the default voice, nothing on. */
export const blankAssistantBody = (name: string, from?: Assistant | AssistantInfo): AssistantBody => {
  const base = from === undefined ? undefined : toBody(from)
  return {
    name,
    purpose: "",
    handles: "",
    on: true,
    prompt: base?.prompt ?? "You are a concise, friendly voice assistant. Your replies are spoken: answer in one or two short sentences.",
    toolRounds: base?.toolRounds ?? 5,
    followUpSeconds: base?.followUpSeconds ?? 8,
    newConversationAfter: base?.newConversationAfter ?? 10,
    replyEarly: base?.replyEarly ?? true,
    confirmActions: "off",
    llm: base?.llm ?? {
      account: "anthropic",
      model: "claude-haiku-5-5",
      effort: "low",
      thinking: "off",
      maxTokens: 1024,
      giveUpMs: 5000,
      warmUp: true,
      useModules: true,
      freshSessionAfterMinutes: 30
    },
    hearing: base?.hearing ?? {
      engine: "sherpa",
      model: "parakeet-v2",
      language: "auto",
      eagerSilenceMs: 250,
      finalSilenceMs: 600,
      minSpeechMs: 100,
      agc: true,
      agcMaxGainDb: 30,
      vadThreshold: 0.5,
      deepgram: { eotThreshold: 0.7, eagerEotThreshold: 0.5, eotTimeoutMs: 5000 }
    },
    voice: base?.voice ?? { provider: "sherpa", voiceId: "en_US-lessac-medium" },
    modules: base?.modules ?? {}
  }
}

/** "Jeff copy", "Jeff copy 2", … the first name no other assistant has (names are unique, case-insensitively). */
export const copyName = (name: string, taken: ReadonlyArray<string>): string => {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()))
  for (let n = 1; ; n++) {
    const candidate = `${name} copy${n === 1 ? "" : ` ${n}`}`.slice(0, 32)
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}
