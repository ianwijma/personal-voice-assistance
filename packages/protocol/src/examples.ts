/**
 * One valid example of every message, for tests, mock servers and scripted
 * clients (`import { clientExamples, serverExamples } from "@pva/protocol/examples"`).
 * The protocol tests check that every message type has an example here.
 */
import type { AssistantsClientMessage, AssistantsClientMessageType, ClientMessage, ClientMessageType } from "./client.ts"
import { PROTOCOL_VERSION } from "./constants.ts"
import type { AssistantsServerMessage, AssistantsServerMessageType, ServerMessage, ServerMessageType } from "./server.ts"
import type { Assistant } from "./assistants.ts"
import { BUILT_IN_WEB_VOICE_SETTINGS, type AssistantInfo, type DeviceListInfo, type DeviceRecordInfo, type DeviceSettings, type DeviceTypeInfo, deviceSetupFrom } from "./devices.ts"
import type { EnvInfo } from "./env.ts"
import type { JobInfo, ModelSet } from "./jobs.ts"
import { WEB_VOICE_KIND } from "./frontends.ts"
import type { DeviceCapabilities } from "./capabilities.ts"
import {
  type AdminSnapshot,
  engineSummary,
  type EngineStatus,
  type ModuleInfo,
  type SettingsSection,
  type Snapshot,
  type TraceInfo
} from "./snapshot.ts"
import type { ConversationInfo, SessionInfo } from "./sessions.ts"
import type { HealthInfo } from "./health.ts"

export const exampleWeatherModule: ModuleInfo = {
  id: "weather",
  name: "Weather",
  description: "Current weather and today's forecast from Open-Meteo.",
  enabled: true,
  state: "running",
  status: { text: "Home: Amsterdam", tone: "neutral" },
  tools: [{ name: "weather", description: "Current weather and today's forecast for a place.", speculative: true }],
  settings: {
    fields: [
      {
        type: "text",
        key: "defaultPlace",
        label: "Home location",
        description: "Used when you don't name a place.",
        apply: "live",
        default: "",
        placeholder: "Amsterdam, Netherlands"
      },
      {
        type: "choice",
        key: "units",
        label: "Units",
        apply: "live",
        default: "celsius",
        options: [{ value: "celsius", label: "Celsius, km/h" }, { value: "fahrenheit", label: "Fahrenheit, mph" }]
      },
      {
        type: "number",
        key: "timeoutMs",
        label: "Timeout",
        apply: "live",
        advanced: true,
        default: 3000,
        integer: true,
        min: 500,
        max: 10_000,
        step: 100,
        unit: "ms"
      }
    ],
    values: { defaultPlace: "Amsterdam", units: "celsius", timeoutMs: 3000 },
    secrets: {},
    errors: []
  },
  revision: 3
}

export const exampleHomeAssistantModule: ModuleInfo = {
  id: "home-assistant",
  name: "Home Assistant",
  description: "Reads the state of lights, sensors and climate from your Home Assistant.",
  enabled: true,
  state: "error",
  error: "Home Assistant rejected the token (HTTP 401). Create a long-lived token in your profile and paste it here.",
  tools: [{ name: "home_state", description: "Current state of devices in an area or by name.", speculative: true }],
  settings: {
    fields: [
      { type: "text", key: "baseUrl", label: "Address", apply: "live", default: "http://homeassistant.local:8123" },
      { type: "secret", key: "token", label: "Access token", apply: "live", env: "HOME_ASSISTANT_TOKEN" },
      {
        type: "multichoice",
        key: "domains",
        label: "Devices it may read",
        apply: "live",
        default: ["light", "sensor", "climate"],
        options: [
          { value: "light", label: "Lights" },
          { value: "sensor", label: "Sensors" },
          { value: "climate", label: "Climate" },
          { value: "lock", label: "Locks", description: "Read only: whether a lock is locked." }
        ]
      },
      { type: "boolean", key: "includeAttributes", label: "Include details", apply: "live", default: false, advanced: true }
    ],
    values: { baseUrl: "http://homeassistant.local:8123", domains: ["light", "sensor", "climate"], includeAttributes: false },
    secrets: { token: { set: true, source: "store" } },
    errors: []
  },
  revision: 7,
  protected: true,
  kind: "capability",
  group: "modules"
}

/** Protocol 9: a module that cannot run here (a program it needs is missing), with its manifest fields. */
export const exampleUnavailableModule: ModuleInfo = {
  id: "music",
  name: "Music",
  description: "Plays music on the device you talk to.",
  enabled: true,
  state: "unavailable",
  unavailable: { reason: "yt-dlp is missing", fix: { kind: "command", label: "Install yt-dlp", value: "sudo apt install yt-dlp" } },
  tools: [],
  settings: { fields: [], values: {}, secrets: {}, errors: [] },
  revision: 2,
  kind: "capability",
  group: "modules",
  version: "0.3.0",
  apiVersion: 2,
  templates: [{
    id: "music.dj",
    name: "DJ",
    prompt: "You pick and play music. Keep spoken answers to one sentence.",
    purpose: "Plays music",
    modules: ["music"],
    suggestedPhrases: ["hey dj"]
  }]
}

/** Protocol 9: the issue registry after a check. */
export const exampleHealth: HealthInfo = {
  issues: [
    {
      id: "music.requires.yt-dlp",
      module: "music",
      severity: "error",
      title: "yt-dlp is missing",
      detail: "Music needs it: Resolves stream URLs.",
      fix: { kind: "command", label: "Install yt-dlp", value: "sudo apt install yt-dlp" }
    },
    {
      id: "music.speaker.kitchen",
      module: "music",
      device: "d-kitchen-0001",
      severity: "warning",
      title: "The speaker did not answer",
      detail: "Music could not reach it at the last check.",
      fix: { kind: "link", label: "Open Music", value: "#settings/shared/modules/music" }
    }
  ],
  checkedAt: 1_763_100_000_000,
  checking: false
}

/** A section with the settings-screen placement and field semantics (protocol 3). */
export const exampleSpeechEngineSection: SettingsSection = {
  id: "stt-engine",
  title: "Engine",
  group: "speech",
  page: { id: "engine", title: "Engine", description: "How your speech is turned into text." },
  order: 10,
  protected: true,
  form: {
    fields: [
      {
        type: "choice",
        key: "STT_PROVIDER",
        label: "Speech to text",
        apply: "reload",
        default: "sherpa",
        source: "saved",
        options: [
          { value: "sherpa", label: "On this machine", tags: ["local"], implication: "Your voice never leaves this machine." },
          {
            value: "deepgram",
            label: "Deepgram",
            tags: ["hosted", "needs-key"],
            implication: "What you say is sent to Deepgram.",
            description: "Deepgram Flux over the internet."
          }
        ]
      },
      {
        type: "choice",
        key: "STT_SHERPA_MODEL",
        label: "Speech recognition model",
        apply: "reload",
        default: "parakeet-v2",
        source: "default",
        visibleWhen: { key: "STT_PROVIDER", in: ["sherpa"] },
        options: [
          { value: "parakeet-v2", label: "Parakeet v2" },
          { value: "whisper-turbo", label: "Whisper turbo", tags: ["not-downloaded"] }
        ]
      },
      {
        type: "number",
        key: "STT_SHERPA_THREADS",
        label: "Decoder threads",
        apply: "reload",
        default: 2,
        integer: true,
        min: 1,
        max: 8,
        advanced: true,
        source: "env-file",
        locked: { reason: "Set by STT_SHERPA_THREADS in .env" },
        visibleWhen: { all: [{ key: "STT_PROVIDER", in: ["sherpa"] }] }
      }
    ],
    values: { STT_PROVIDER: "deepgram", STT_SHERPA_MODEL: "parakeet-v2", STT_SHERPA_THREADS: 2 },
    secrets: {},
    errors: [],
    warnings: [{ key: "STT_PROVIDER", message: "Deepgram is chosen but there is no Deepgram key: speech recognition fails until you add it." }]
  },
  revision: 2
}

/** Voices › Voices (docs/VOICE-PROVIDERS.md §6.1): the assistant's one voice, a voice key. */
export const exampleVoiceSection: SettingsSection = {
  id: "voices",
  title: "Voices",
  description: "The voice the assistant speaks every reply with.",
  form: {
    fields: [
      {
        type: "text",
        key: "ASSISTANT_VOICE",
        label: "Assistant voice",
        description: "A voice of one of the voice providers (provider:voice). Applies after reloading the engines. Empty: the voice of the earlier voice settings, else the voice on this machine.",
        apply: "reload",
        default: "",
        placeholder: "sherpa:en_US-lessac-medium",
        maxLength: 200
      }
    ],
    values: { ASSISTANT_VOICE: "sherpa:en_US-lessac-medium" },
    secrets: {},
    errors: []
  },
  revision: 1,
  group: "voices",
  page: { id: "overview", title: "Voices" }
}

export const exampleTrace: TraceInfo = {
  turnId: 12,
  mode: "voice",
  speculative: true,
  outcome: "completed",
  marks: { llmRequestSent: -232, llmFirstToken: -231, firstClause: -216, ttsFirstAudio: -184, playbackStart: 31 },
  totalMs: 1925,
  tools: [{ name: "weather", ms: 241 }],
  voices: ["sherpa:en_US-lessac-medium"],
  client: { outputLatencyMs: 21.3, startDelayMs: 0 }
}

export const exampleEnv: EnvInfo = {
  files: ["/home/owner/personal-voice-assistance/.env"],
  entries: [
    {
      key: "ANTHROPIC_API_KEY",
      origin: "file",
      file: "/home/owner/personal-voice-assistance/.env",
      line: 3,
      kind: "setting",
      secret: true,
      page: { path: ["language-model", "provider"], title: "Language model › Provider" },
      movable: true
    },
    { key: "SERVE_PORT", origin: "file", file: "/home/owner/personal-voice-assistance/.env", line: 7, kind: "bootstrap", secret: false, movable: false },
    { key: "STT_SHERPA_MODLE", origin: "file", file: "/home/owner/personal-voice-assistance/.env", line: 9, kind: "unknown", secret: false, movable: false },
    { key: "STT_SHERPA_THREADS", origin: "process", kind: "setting", secret: false, movable: false }
  ]
}

export const exampleModels: ReadonlyArray<ModelSet> = [
  {
    tool: "stt-models",
    title: "Speech recognition models",
    directory: "/home/owner/personal-voice-assistance/models",
    freeMb: 41_200,
    items: [
      { id: "parakeet-v2", label: "Parakeet v2 — accurate, English", sizeMb: 483, diskMb: 663, installed: true, inUse: true },
      { id: "whisper-turbo", label: "Whisper turbo — robust, 99 languages, slow", sizeMb: 565, diskMb: 1039, installed: false, inUse: false }
    ]
  }
]

export const exampleJob: JobInfo = {
  id: "job-3",
  tool: "stt-models",
  action: "download",
  target: "whisper-turbo",
  label: "Whisper turbo — robust, 99 languages, slow",
  state: "running",
  phase: "download",
  progress: { done: 120_000_000, total: 563_790_207, unit: "bytes" },
  log: ["Needs about 1.6 GB; 41.2 GB free", "Downloading sherpa-onnx-whisper-turbo.tar.bz2"],
  startedAt: 1_763_100_000_000
}

export const exampleEngineStatus: EngineStatus = {
  state: "ready",
  problems: [],
  reloadPending: false,
  reloadPendingFor: [],
  engines: [
    { stage: "llm", provider: "anthropic", detail: "claude-haiku-5-5", location: "hosted" },
    { stage: "stt", provider: "sherpa", detail: "nemotron-3.5", location: "local" },
    { stage: "tts", provider: "sherpa", detail: "Piper en_US-lessac-medium", location: "local" }
  ],
  // One voice: `name` is its key, `description` its name (docs/VOICE-PROVIDERS.md §8).
  voices: [
    {
      name: "sherpa:en_US-lessac-medium",
      description: "Lessac",
      enabled: true,
      isDefault: true,
      engine: "Piper en_US-lessac-medium",
      location: "local"
    }
  ]
}

// -- Protocol 7 examples (docs/ASSISTANTS.md §2, §5) -------------------------------------------------------------------

export const exampleAssistant: Assistant = {
  id: "jeff",
  rev: 3,
  name: "Jeff",
  purpose: "General questions and the house",
  handles: "Weather, time, timers, lights and heating, anything general.",
  on: true,
  prompt: "You are Jeff, a calm voice assistant. Answer in one or two short sentences.",
  toolRounds: 3,
  followUpSeconds: 8,
  newConversationAfter: 10,
  replyEarly: true,
  confirmActions: "off",
  llm: {
    account: "anthropic",
    model: "claude-haiku-5-5",
    effort: "low",
    thinking: "off",
    maxTokens: 1024,
    giveUpMs: 15_000,
    warmUp: true,
    useModules: false,
    freshSessionAfterMinutes: 0
  },
  hearing: {
    engine: "sherpa",
    model: "nemotron-3.5",
    language: "auto",
    eagerSilenceMs: 250,
    finalSilenceMs: 600,
    minSpeechMs: 120,
    agc: true,
    agcMaxGainDb: 20,
    vadThreshold: 0.5,
    deepgram: { eotThreshold: 0.7, eagerEotThreshold: 0.4, eotTimeoutMs: 5000 }
  },
  voice: { provider: "piper", voiceId: "en_US-lessac-medium" },
  modules: {
    weather: { on: true, offTools: [], own: { units: "fahrenheit" } },
    clock: { on: true, offTools: ["set_timer"] }
  }
}

export const exampleAssistantT3: Assistant = {
  ...exampleAssistant,
  id: "t3",
  rev: 0,
  name: "T3",
  purpose: "Coding questions",
  handles: "Programming, the repository, builds.",
  followUpSeconds: 0,
  newConversationAfter: "never",
  modules: {}
}

export const exampleDeviceSettings: DeviceSettings = {
  ...BUILT_IN_WEB_VOICE_SETTINGS,
  assistants: [
    { assistant: "jeff", phrases: ["hey jeff", "hey jev"] },
    { assistant: "t3", phrases: ["hey t3"], followUpSeconds: 20 }
  ],
  withoutPhrase: { mode: "typesafe", fallback: "jeff", giveUpMs: 400 },
  voicePage: { pick: true }
}

export const exampleAssistantInfo: AssistantInfo = {
  ...exampleAssistant,
  usedOn: [
    { target: { kind: "type", type: "web-voice" }, hears: false, reach: "phrase" },
    { target: { kind: "device", id: "d-5c1e0b7a42" }, hears: true, reach: "without-phrase" }
  ],
  resources: { llm: "ready", voice: "starting" },
  problems: []
}

export const exampleDeviceType: DeviceTypeInfo = {
  kind: "web-voice",
  title: "Browsers",
  one: "browser",
  many: "browsers",
  description: "The voice page on a phone, tablet or computer.",
  keys: ["assistants", "withoutPhrase", "matching", "voicePage", "interruptMode", "audio", "captions", "look", "voice", "place", "capabilities"],
  settings: exampleDeviceSettings,
  rev: 2
}

export const exampleDeviceRecord: DeviceRecordInfo = {
  id: "d-5c1e0b7a42",
  kind: "web-voice",
  name: "iPhone · Safari",
  firstSeen: 1_763_000_000_000,
  lastSeen: 1_763_100_000_000,
  own: { interruptMode: "instant", withoutPhrase: { mode: "assistant", assistant: "jeff" } },
  settings: { ...exampleDeviceSettings, interruptMode: "instant", withoutPhrase: { mode: "assistant", assistant: "jeff" } },
  hearer: "jeff",
  rev: 1,
  connections: 1,
  audioOwner: true
}

export const exampleDeviceSetup = deviceSetupFrom(
  exampleDeviceSettings,
  new Map([exampleAssistant, exampleAssistantT3].map((a) => [a.id, a])),
  { deviceId: "d-5c1e0b7a42", canAuto: true }
)

const { id: _id, rev: _rev, ...exampleAssistantBody } = exampleAssistant


/** What a tablet's voice page declares (protocol 11). */
export const exampleCapabilities: DeviceCapabilities = {
  v: 1,
  display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 2, touch: "coarse", colour: true },
  present: { kinds: {} },
  speaker: { media: ["speech", "audio"] },
  microphone: { farField: false }
}

export const exampleDevice: DeviceListInfo = {
  id: "d-5c1e0b7a42",
  kind: WEB_VOICE_KIND,
  name: "iPhone · Safari",
  firstSeen: 1_763_000_000_000,
  lastSeen: 1_763_100_000_000,
  own: { interruptMode: "instant", withoutPhrase: { mode: "assistant", assistant: "jeff" } },
  settings: { ...exampleDeviceSettings, interruptMode: "instant", withoutPhrase: { mode: "assistant", assistant: "jeff" } },
  hearer: "jeff",
  rev: 1,
  connections: 1,
  audioOwner: true,
  declared: { capabilities: exampleCapabilities, seenAt: 1_763_100_000_000 },
  live: { visible: true }
}

export const exampleConversation: ConversationInfo = { id: "5b0f6a0e-3c1d-4c7e-9a52-1f0e8d2b7c44", startedAt: 1_763_099_400_000 }

/** One voice session (protocol 6), as admin sees it. */
export const exampleSession: SessionInfo = {
  key: exampleDevice.id,
  deviceId: exampleDevice.id,
  name: exampleDevice.name,
  state: "listening",
  ownerPresent: true,
  conversationId: exampleConversation.id,
  turns: 2,
  lastTurnAt: 1_763_100_000_000
}

/** The voice part, as a voice connection that owns the audio gets it. */
export const exampleSnapshot: Snapshot = {
  state: "listening",
  role: "owner",
  ownerPresent: true,
  engine: engineSummary(exampleEngineStatus),
  history: [
    { role: "user", text: "What's the weather like?" },
    { role: "assistant", text: "Light rain in Amsterdam, 7 degrees.", interrupted: false, tools: [{ name: "weather", ok: true }] },
    { role: "user", text: "Tell me a long story" },
    { role: "assistant", text: "Once upon a time,", interrupted: true, tools: [] }
  ],
  admin: { enabled: true, loggedIn: false },
  conversations: [{ assistantId: "jeff", id: exampleConversation.id, startedAt: exampleConversation.startedAt, turns: 2 }],
  setup: exampleDeviceSetup
}

/** The admin part, as `admin.snapshot` carries it. */
export const exampleAdminSnapshot: AdminSnapshot = {
  engine: exampleEngineStatus,
  modules: [exampleWeatherModule, exampleHomeAssistantModule],
  sections: [exampleVoiceSection, exampleSpeechEngineSection],
  traces: [exampleTrace],
  vault: { state: "unlocked", admin: true, location: "/home/owner/.config/pva/vault.enc" },
  env: exampleEnv,
  models: exampleModels,
  jobs: [exampleJob],
  devices: [exampleDevice],
  sessions: [
    exampleSession,
    { key: "c-a0d1e2f3", name: "Browser without a device id", state: "idle", ownerPresent: false, conversationId: "9d4c2a71-0b5e-4f3a-8e61-7c2d9b0a5f13", turns: 0, lastTurnAt: null }
  ],
  health: exampleHealth
}

const audio = { contextSampleRate: 48_000, baseLatencyMs: 10, outputLatencyMs: 21.3, echoCancellation: true, outputPath: "direct" } as const

export const assistantsClientExamples: { readonly [T in AssistantsClientMessageType]: Extract<AssistantsClientMessage, { readonly type: T }> } = {
  "assistant.create": {
    type: "assistant.create",
    requestId: "a1",
    assistant: exampleAssistantBody,
    copyOf: "jeff",
    placements: [{ target: { kind: "type", type: "web-voice" }, phrase: "hey kitchen" }, { target: { kind: "device", id: "d-5c1e0b7a42" } }]
  },
  "assistant.save": { type: "assistant.save", requestId: "a2", assistant: exampleAssistant, saveAnyway: true },
  "assistant.delete": { type: "assistant.delete", requestId: "a3", id: "t3", rev: 0 },
  "device.save": {
    type: "device.save",
    requestId: "a4",
    target: { kind: "device", id: "d-5c1e0b7a42" },
    rev: 1,
    name: "Kitchen iPad",
    settings: { interruptMode: "instant", captions: null, withoutPhrase: { mode: "assistant", assistant: "jeff" } }
  },
  "conversation.read": { type: "conversation.read", requestId: "a5", assistantId: "t3" },
  "device.pick": { type: "device.pick", requestId: "a6", withoutPhrase: "typesafe" }
}


export const assistantsServerExamples: { readonly [T in AssistantsServerMessageType]: Extract<AssistantsServerMessage, { readonly type: T }> } = {
  "device.setup": { type: "device.setup", ...exampleDeviceSetup },
  "conversation.history": {
    type: "conversation.history",
    requestId: "a5",
    assistantId: "t3",
    id: "5b0f6a0e-3c1d-4c7e-9a52-1f0e8d2b7c44",
    history: [
      { role: "user", text: "How do I rebase?" },
      { role: "assistant", text: "Use git rebase main.", interrupted: false, tools: [] }
    ]
  },
  "assistants": { type: "assistants", assistants: [exampleAssistantInfo] },
  "device.types": { type: "device.types", types: [exampleDeviceType] },
}

/** A refused `device.save` (protocol 7 error codes ride on the one `result`). */
export const exampleDuplicatePhraseResult: Extract<ServerMessage, { readonly type: "result" }> = {
  type: "result",
  requestId: "a1",
  ok: false,
  error: { code: "duplicate_phrase", message: "The phrase \"hey jeff\" is used twice on this device." }
}

/** The successful result of `assistant.create`. */
export const exampleCreateResult: Extract<ServerMessage, { readonly type: "result" }> = {
  type: "result",
  requestId: "a1",
  ok: true,
  assistantId: "keuken-2"
}

export const clientExamples: { readonly [T in ClientMessageType]: Extract<ClientMessage, { readonly type: T }> } = {
  "hello": {
    type: "hello",
    protocol: PROTOCOL_VERSION,
    clientId: "c-7f3a9b21",
    resumeOwner: false,
    frontend: "voice",
    device: { id: "d-5c1e0b7a42", kind: WEB_VOICE_KIND, name: "iPhone · Safari", capabilities: exampleCapabilities }
  },
  "audio.claim": { type: "audio.claim", audio },
  "audio.release": { type: "audio.release" },
  "audio.config": { type: "audio.config", audio: { ...audio, outputPath: "element" } },
  "mic.state": { type: "mic.state", live: false },
  "playback.started": { type: "playback.started", turnId: 12, outputLatencyMs: 21.3, startDelayMs: 0 },
  "playback.progress": { type: "playback.progress", turnId: 12, playedSamples: 11_025, underruns: 0 },
  "playback.finished": { type: "playback.finished", turnId: 12, playedSamples: 52_920 },
  "playback.stopped": { type: "playback.stopped", turnId: 12, playedSamples: 17_640, exact: true },
  "interrupt": { type: "interrupt", turnId: 12 },
  "text.send": { type: "text.send", requestId: "r1", text: "What time is it in Tokyo?", speak: true },
  "module.enable": { type: "module.enable", requestId: "r2", moduleId: "weather" },
  "module.disable": { type: "module.disable", requestId: "r3", moduleId: "weather" },
  "module.configure": {
    type: "module.configure",
    requestId: "r4",
    moduleId: "home-assistant",
    patch: { values: { baseUrl: "http://192.168.1.20:8123", includeAttributes: null }, secrets: { token: "eyJhbGciOi..." } }
  },
  "settings.update": {
    type: "settings.update",
    requestId: "r5",
    sectionId: "stt-engine",
    patch: { values: { STT_PROVIDER: "deepgram", STT_SHERPA_MODEL: null }, secrets: {} },
    confirmWarnings: true
  },
  "engine.reload": { type: "engine.reload", requestId: "r6" },
  "vault.setup": { type: "vault.setup", requestId: "r7", password: "correct horse battery" },
  "vault.unlock": { type: "vault.unlock", requestId: "r8", password: "correct horse battery" },
  "vault.lock": { type: "vault.lock", requestId: "r9" },
  "vault.changePassword": { type: "vault.changePassword", requestId: "r10", oldPassword: "correct horse battery", newPassword: "staple gun lamp post" },
  "settings.moveFromEnv": { type: "settings.moveFromEnv", requestId: "r11", keys: ["ANTHROPIC_API_KEY", "STT_SHERPA_MODEL"] },
  "job.start": { type: "job.start", requestId: "r12", tool: "stt-models", action: "download", target: "whisper-turbo" },
  "job.cancel": { type: "job.cancel", requestId: "r13", jobId: "job-3" },
  "model.delete": { type: "model.delete", requestId: "r14", tool: "tts-models", target: "nl_NL-pim-medium" },
  "admin.login": { type: "admin.login", requestId: "r15", password: "correct horse battery" },
  "admin.logout": { type: "admin.logout", requestId: "r16" },
  "device.forget": { type: "device.forget", requestId: "r20", id: "d-5c1e0b7a42" },
  "wake.test": { type: "wake.test", requestId: "r21", on: true, deviceId: "d-5c1e0b7a42" },
  "conversation.new": { type: "conversation.new", requestId: "r22" },
  "ping": { type: "ping", id: 41 },
  "health.check": { type: "health.check", requestId: "h1" },
  "module.action": { type: "module.action", requestId: "a1", moduleId: "home-assistant", key: "test", values: { baseUrl: "http://homeassistant.local:8123" } },
  "device.caps": {
    type: "device.caps",
    capabilities: exampleCapabilities,
    live: { visible: true, lastInteractionAt: 1_763_100_000_000 }
  },
  // P9 (additive within 11): a press on a ring card's button.
  "notification.action": { type: "notification.action", requestId: "n1", id: "n-4f2a", actionId: "stop" },
  // P10 (additive within 11): a tick on a checklist item.
  "present.action": { type: "present.action", requestId: "p1", id: "p-7c1d", revision: "show-1:1", action: "tick", item: "milk", done: true },
  ...assistantsClientExamples
}

/** The `result` of a `notification.action` whose handler is not running (P9, additive within 11). */
export const exampleNotificationActionResult: Extract<ServerMessage, { readonly type: "result" }> = {
  type: "result",
  requestId: "n1",
  ok: false,
  error: { code: "not_running", message: "I can't do that right now." },
  say: "I can't do that right now."
}

/** The `result` of a `module.action` that ran (protocol 10). */
export const exampleActionResult: Extract<ServerMessage, { readonly type: "result" }> = {
  type: "result",
  requestId: "a1",
  ok: true,
  action: { ok: true, text: "Connected to Home in 84 ms: 4 areas, 9 lights.", tone: "ok" }
}

/** The `result` of a successful `admin.login`. */
export const exampleLoginResult: Extract<ServerMessage, { readonly type: "result" }> = {
  type: "result",
  requestId: "r15",
  ok: true,
  admin: { token: "q2Vx8m0rJ3cW5yT1bN7dK9fH4gL6pZ2aS8eU0iO3wQk", expiresAt: 1_763_143_200_000 }
}

/** An admin front end's `hello` with a session token from an earlier login. */
export const exampleAdminHello: Extract<ClientMessage, { readonly type: "hello" }> = {
  type: "hello",
  protocol: PROTOCOL_VERSION,
  clientId: "c-a0d1e2f3",
  resumeOwner: false,
  frontend: "admin",
  adminToken: "q2Vx8m0rJ3cW5yT1bN7dK9fH4gL6pZ2aS8eU0iO3wQk"
}

/** The final part after `serverExamples["household.snapshot"]`: no rows, the collections cut short named. */
export const exampleHouseholdSnapshotFinal: Extract<ServerMessage, { readonly type: "household.snapshot" }> = {
  type: "household.snapshot",
  seq: 42,
  part: 1,
  final: true,
  collections: [],
  truncated: [{ module: "shopping", collection: "items" }]
}

/** P10: a pinned checklist as a voice connection holds it. */
export const examplePresentation = {
  id: "p-7c1d",
  revision: "show-1:1",
  lifetime: "pinned",
  shownAt: 1_763_100_600_000,
  serverNow: 1_763_100_600_000,
  v: 1,
  content: { kind: "list", title: "Shopping", style: "checklist", items: [{ id: "milk", text: "Milk", done: false }, { id: "eggs", text: "Eggs", done: false }] },
  buttons: [{ id: "clear", label: "Clear ticked" }],
  interactive: true,
  texts: { region: "On screen", loading: "Loading the image…", imageMissing: "The image is not available.", timerDone: "Done", credit: "Image:", high: "High", low: "Low" }
} as const

export const serverExamples: { readonly [T in ServerMessageType]: Extract<ServerMessage, { readonly type: T }> } = {
  "welcome": {
    type: "welcome",
    protocol: PROTOCOL_VERSION,
    server: { name: "pva", version: "0.0.0" },
    connectionId: "conn-3",
    snapshot: exampleSnapshot
  },
  "session": { type: "session", role: "observer", ownerPresent: true, reason: "taken_over" },
  "state": { type: "state", state: "speaking", turnId: 12 },
  "transcript": { type: "transcript", text: "what's the weather in" },
  "turn.start": { type: "turn.start", turnId: 12, source: "voice", userText: "What's the weather in Paris?", spoken: true },
  "assistant.text": { type: "assistant.text", turnId: 12, clause: 0, text: "It's sunny in Paris,", voice: "sherpa:en_US-lessac-medium" },
  "assistant.playing": { type: "assistant.playing", turnId: 12, clause: 0 },
  "tool.start": {
    type: "tool.start",
    turnId: 12,
    callId: "toolu_01",
    tool: "weather",
    moduleId: "weather",
    input: { place: "Paris, France" }
  },
  "tool.end": { type: "tool.end", turnId: 12, callId: "toolu_01", ok: true, ms: 241 },
  "turn.end": { type: "turn.end", turnId: 12, outcome: "completed", trace: exampleTrace },
  "reply.start": { type: "reply.start", turnId: 12, sampleRate: 22_050 },
  "reply.end": { type: "reply.end", turnId: 12 },
  "reply.stop": { type: "reply.stop", turnId: 12 },
  "module.changed": { type: "module.changed", module: exampleHomeAssistantModule },
  "section.changed": { type: "section.changed", section: exampleSpeechEngineSection },
  "engine": { type: "engine", engine: { ...exampleEngineStatus, state: "ready", reloadPending: true, reloadPendingFor: ["speech/engine"] } },
  "vault": {
    type: "vault",
    vault: { state: "locked", admin: false, location: "/home/owner/.config/pva/vault.enc", retryAfterMs: 30_000, lockReason: "manual" }
  },
  "env": { type: "env", env: exampleEnv },
  "job": { type: "job", job: { ...exampleJob, state: "succeeded", progress: { done: 563_790_207, total: 563_790_207, unit: "bytes" }, endedAt: 1_763_100_090_000 } },
  "models": { type: "models", models: exampleModels },
  "result": {
    type: "result",
    requestId: "r4",
    ok: false,
    error: {
      code: "invalid_settings",
      message: "Some settings are not valid.",
      moduleId: "home-assistant",
      fieldErrors: [{ key: "baseUrl", message: "Must start with http:// or https://" }]
    }
  },
  "error": { type: "error", error: { code: "turn_failed", message: "The language model did not answer in time.", turnId: 12 } },
  "engine.summary": { type: "engine.summary", engine: engineSummary(exampleEngineStatus) },
  "admin.state": { type: "admin.state", admin: { enabled: true, loggedIn: true, expiresAt: 1_763_143_200_000 } },
  "admin.snapshot": { type: "admin.snapshot", snapshot: exampleAdminSnapshot },
  "devices": { type: "devices", devices: [exampleDevice] },
  "wake": { type: "wake", phrase: "hey jeff", armed: true },
  "wake.heard": {
    type: "wake.heard",
    text: "Hey Jeff, what time is it?",
    matched: "hey jeff",
    accepted: true,
    source: { deviceId: exampleDevice.id, assistantId: exampleAssistant.id },
    at: 1_763_100_001_000
  },
  "conversation": { type: "conversation", id: "e1a7c3f9-2b4d-4e6a-8c0f-3d5b7a9e1c02", reason: "idle", startedAt: 1_763_100_600_000 },
  "sessions": { type: "sessions", sessions: [exampleSession] },
  "trace": { type: "trace", key: exampleDevice.id, deviceId: exampleDevice.id, trace: { ...exampleTrace, session: exampleDevice.name } },
  "pong": { type: "pong", id: 41 },
  "health": { type: "health", health: exampleHealth },
  // A snapshot's parts: rows in the parts before the last (this one), then the empty final part
  // (`exampleHouseholdSnapshotFinal`), which names the collections whose rows were not all sent.
  "household.snapshot": {
    type: "household.snapshot",
    seq: 42,
    part: 0,
    final: false,
    collections: [{
      module: "timers",
      collection: "timers",
      rows: [{ id: "t1", rev: 40, scope: { kind: "household" }, value: { label: "pasta", dueAt: 1_763_100_600_000 }, updatedAt: 1_763_100_000_000 }]
    }],
    truncated: []
  },
  "household.event": {
    type: "household.event",
    event: {
      seq: 43,
      at: 1_763_100_010_000,
      module: "timers",
      type: "timers.timers.changed",
      scope: { kind: "household" },
      data: { collection: "timers", id: "t1", op: "put", rev: 43, value: { label: "pasta", dueAt: 1_763_100_900_000 } }
    }
  },
  "household.gap": { type: "household.gap", reason: "overflow" },
  // P9 (additive within 11): a timer's ring card, and its end.
  "notification.ring": {
    type: "notification.ring",
    notification: {
      id: "n-4f2a",
      title: "Pasta timer",
      text: "Ten minutes are up.",
      priority: "ring",
      show: true,
      sound: true,
      actions: [{ id: "stop", label: "Stop" }, { id: "snooze", label: "Snooze" }],
      sentAt: 1_763_100_600_000,
      texts: { region: "Notifications", startAudio: "Start audio to hear it." }
    }
  },
  "notification.resolved": { type: "notification.resolved", id: "n-4f2a", outcome: "stop" },
  // P7 (additive within 11): the reply output's gain on one device.
  "output.volume": { type: "output.volume", volume: 0.6 },
  // P10 (additive within 11): a checklist on the stage, a tick taken in, and its end.
  "present.show": { type: "present.show", presentation: examplePresentation },
  "present.update": {
    type: "present.update",
    presentation: {
      ...examplePresentation,
      serverNow: 1_763_100_660_000,
      content: { kind: "list", title: "Shopping", style: "checklist", items: [{ id: "milk", text: "Milk", done: true }, { id: "eggs", text: "Eggs", done: false }] }
    }
  },
  "present.dismiss": { type: "present.dismiss", id: "p-7c1d" },
  ...assistantsServerExamples
}

