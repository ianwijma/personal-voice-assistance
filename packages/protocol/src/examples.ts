/**
 * One valid example of every message, for tests, mock servers and scripted
 * clients (`import { clientExamples, serverExamples } from "@pva/protocol/examples"`).
 * The protocol tests check that every message type has an example here.
 */
import type { ClientMessage, ClientMessageType } from "./client.ts"
import { PROTOCOL_VERSION } from "./constants.ts"
import type { ServerMessage, ServerMessageType } from "./server.ts"
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
  revision: 7
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
  revision: 1
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

export const exampleSnapshot: Snapshot = {
  state: "listening",
  role: "owner",
  ownerPresent: true,
  engine: {
    state: "ready",
    problems: [],
    reloadPending: false,
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
  sections: [exampleVoiceSection],
  history: [
    { role: "user", text: "What's the weather like?" },
    { role: "assistant", text: "Light rain in Amsterdam, 7 degrees.", interrupted: false, tools: [{ name: "weather", ok: true }] },
    { role: "user", text: "Tell me a long story" },
    { role: "assistant", text: "Once upon a time,", interrupted: true, tools: [] }
  ],
  traces: [exampleTrace]
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
    sectionId: "voices",
    patch: { values: { DEFAULT_VOICE: "natural", VOICES: ["standard", "natural"] }, secrets: {} }
  },
  "engine.reload": { type: "engine.reload", requestId: "r6" },
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
  "section.changed": { type: "section.changed", section: exampleVoiceSection },
  "engine": { type: "engine", engine: { ...exampleSnapshot.engine, state: "reloading" } },
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
