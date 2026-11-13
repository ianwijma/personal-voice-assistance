/**
 * One valid example of every message, for tests, mock servers and scripted
 * clients (`import { clientExamples, serverExamples } from "@pva/protocol/examples"`).
 * The protocol tests check that every message type has an example here.
 */
import type { ClientMessage, ClientMessageType } from "./client.ts"
import { PROTOCOL_VERSION } from "./constants.ts"
import type { ServerMessage, ServerMessageType } from "./server.ts"
import type { EnvInfo } from "./env.ts"
import type { JobInfo, ModelSet } from "./jobs.ts"
import type { ModuleInfo, SettingsSection, Snapshot, TraceInfo } from "./snapshot.ts"

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

export const exampleVoiceSection: SettingsSection = {
  id: "voices",
  title: "Voices",
  form: {
    fields: [
      {
        type: "choice",
        key: "DEFAULT_VOICE",
        label: "Default voice",
        description: "Speaks every reply unless the model picks another voice.",
        apply: "live",
        default: "standard",
        options: [
          { value: "standard", label: "standard", description: "Everyday answers: quick and clear." },
          { value: "natural", label: "natural", description: "Longer replies where warmth matters." }
        ]
      },
      {
        type: "multichoice",
        key: "VOICES",
        label: "Enabled voices",
        apply: "reload",
        default: ["standard"],
        options: [
          { value: "standard", label: "standard" },
          { value: "natural", label: "natural" },
          { value: "expressive", label: "expressive" }
        ]
      }
    ],
    values: { DEFAULT_VOICE: "standard", VOICES: ["standard", "natural"] },
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
  voices: ["standard"],
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

export const exampleSnapshot: Snapshot = {
  state: "listening",
  role: "owner",
  ownerPresent: true,
  engine: {
    state: "ready",
    problems: [],
    reloadPending: false,
    reloadPendingFor: [],
    engines: [
      { stage: "llm", provider: "anthropic", detail: "claude-haiku-5-5", location: "hosted" },
      { stage: "stt", provider: "sherpa", detail: "nemotron-3.5", location: "local" },
      { stage: "tts", provider: "sherpa", detail: "Piper en_US-lessac-medium", location: "local" }
    ],
    voices: [
      {
        name: "standard",
        description: "Everyday answers: quick and clear.",
        enabled: true,
        isDefault: true,
        engine: "Piper en_US-lessac-medium",
        location: "local"
      },
      {
        name: "natural",
        description: "Longer replies where warmth matters.",
        enabled: true,
        isDefault: false,
        engine: "Kokoro af_heart",
        location: "local"
      }
    ]
  },
  modules: [exampleWeatherModule, exampleHomeAssistantModule],
  sections: [exampleVoiceSection, exampleSpeechEngineSection],
  history: [
    { role: "user", text: "What's the weather like?" },
    { role: "assistant", text: "Light rain in Amsterdam, 7 degrees.", interrupted: false, tools: [{ name: "weather", ok: true }] },
    { role: "user", text: "Tell me a long story" },
    { role: "assistant", text: "Once upon a time,", interrupted: true, tools: [] }
  ],
  traces: [exampleTrace],
  vault: { state: "unlocked", admin: true, location: "/home/owner/.config/pva/vault.enc" },
  env: exampleEnv,
  models: exampleModels,
  jobs: [exampleJob]
}

const audio = { contextSampleRate: 48_000, baseLatencyMs: 10, outputLatencyMs: 21.3, echoCancellation: true, outputPath: "direct" } as const

export const clientExamples: { readonly [T in ClientMessageType]: Extract<ClientMessage, { readonly type: T }> } = {
  "hello": { type: "hello", protocol: PROTOCOL_VERSION, clientId: "c-7f3a9b21", resumeOwner: false },
  "audio.claim": { type: "audio.claim", interruptMode: "confirm", audio },
  "audio.release": { type: "audio.release" },
  "audio.config": { type: "audio.config", interruptMode: "instant", audio },
  "mic.state": { type: "mic.state", live: false },
  "playback.started": { type: "playback.started", turnId: 12, outputLatencyMs: 21.3, startDelayMs: 0 },
  "playback.progress": { type: "playback.progress", turnId: 12, playedSamples: 11_025, underruns: 0 },
  "playback.finished": { type: "playback.finished", turnId: 12, playedSamples: 52_920 },
  "playback.stopped": { type: "playback.stopped", turnId: 12, playedSamples: 17_640 },
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
  "ping": { type: "ping", id: 41 }
}

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
  "assistant.text": { type: "assistant.text", turnId: 12, clause: 0, text: "It's sunny in Paris,", voice: "standard" },
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
  "engine": { type: "engine", engine: { ...exampleSnapshot.engine, state: "ready", reloadPending: true, reloadPendingFor: ["speech/engine"] } },
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
  "pong": { type: "pong", id: 41 }
}
