/**
 * A scripted mock of the assistant's `serve` mode, for developing and testing
 * the web UI without the real server. Speaks the protocol from @pva/protocol.
 *
 *   pnpm --filter @pva/web mock                  (ws://localhost:8787/ws)
 *   MOCK_SCENARIO=voice pnpm --filter @pva/web mock
 *
 * Scenarios (MOCK_SCENARIO, or POST /mock/scenario {"name": …}; switching resets the mock and drops connections):
 *   voice           after a claim: listening → hearing (interim transcripts) → a turn with a tool and three
 *                   clauses → reply audio (an amplitude-modulated tone at 22 050 Hz), honouring playback reports
 *                   and reply.stop. Typed messages work in every scenario.
 *   typed           no automatic voice turn; typed messages get replies (spoken for the owner if asked).
 *   modules         like typed; the module catalog covers every field type, an invalid value
 *                   (weather "Home location" = "Atlantis") and a module that fails to start (home-assistant).
 *   engine-failed   the engines failed (problems listed); typed messages are refused.
 *   drop-mid-reply  like voice, but every socket is dropped 0.8 s into the reply's playback.
 *   takeover        like voice without a turn; 1.5 s after a claim, "another tab" takes the audio.
 *   outdated        every hello is answered with close 4400 (page out of date).
 *   vault           like modules; protected items (Home Assistant, Language model) can be changed by any page until a
 *                   password is set (vault.setup), then only by pages that typed it. Lock / unlock / change password work.
 *   keys-locked     a vault exists (password "correct horse battery") and is locked, so the engines failed;
 *                   unlocking reloads them.
 * In every scenario the vault starts as "none" (everyone may change everything) unless the scenario says otherwise.
 *
 * Control endpoints (for tests): GET /mock/log (client messages and microphone stats), POST /mock/reset,
 * POST /mock/turn (run the scripted voice turn now), POST /mock/send {"messages": [ServerMessage…]} (broadcast),
 * POST /mock/drop (terminate every socket), POST /mock/offline {"ms": 3000} (drop and refuse connections for a while).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  type ClientMessage,
  CloseCode,
  decodeClientMessage,
  decodeMicFrame,
  encodeReplyFrame,
  encodeServerMessage,
  type EngineStatus,
  type HistoryItem,
  type ModuleInfo,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SettingsForm,
  type SettingsPatch,
  type SettingsSection,
  type SettingValue,
  type TraceInfo
} from "@pva/protocol"
import { exampleSnapshot, exampleVoiceSection, exampleWeatherModule } from "@pva/protocol/examples"
import { type WebSocket, WebSocketServer } from "ws"

const PORT = Number(process.env.MOCK_PORT ?? 8787)
const HOST = process.env.MOCK_HOST ?? "127.0.0.1"
const SCENARIOS = ["voice", "typed", "modules", "engine-failed", "drop-mid-reply", "takeover", "outdated", "vault", "keys-locked"] as const
const VAULT_PASSWORD = "correct horse battery"
const VAULT_LOCATION = "/home/owner/.config/pva/vault.enc"
const KEYS_LOCKED = "Keys are locked — unlock them in Options"
type Scenario = typeof SCENARIOS[number]
const REPLY_RATE = 22_050

const isScenario = (s: unknown): s is Scenario => typeof s === "string" && (SCENARIOS as ReadonlyArray<string>).includes(s)
let scenario: Scenario = isScenario(process.env.MOCK_SCENARIO) ? process.env.MOCK_SCENARIO : "voice"

const log = (...args: Array<unknown>) => {
  if (process.env.MOCK_QUIET !== "1") console.log("[mock]", ...args)
}

// ---------------------------------------------------------------------------
// Catalog: modules and settings sections covering every field type.
// ---------------------------------------------------------------------------

const clone = <T>(x: T): T => structuredClone(x)

const initialModules = (): Array<ModuleInfo> => [
  {
    id: "clock",
    name: "Clock",
    description: "Tells the model the local date and time, and the time anywhere else.",
    enabled: true,
    state: "running",
    status: { text: "Europe/Amsterdam · 13 November 2026", tone: "neutral" },
    tools: [{ name: "current_time", description: "The current time in a time zone.", speculative: true }],
    settings: {
      fields: [
        { type: "text", key: "timeZone", label: "Time zone", description: "IANA name, e.g. Europe/Amsterdam. Empty: this machine's zone.", apply: "live", default: "", placeholder: "Europe/Amsterdam", locked: { reason: "Set by CLOCK_TIME_ZONE in the environment" } },
        {
          type: "choice",
          key: "locale",
          label: "Date format",
          apply: "live",
          default: "en-GB",
          options: [{ value: "en-GB", label: "13 November 2026" }, { value: "en-US", label: "November 13, 2026" }, { value: "nl-NL", label: "13 november 2026" }]
        }
      ],
      values: { timeZone: "Europe/Amsterdam", locale: "en-GB" },
      secrets: {},
      errors: []
    },
    revision: 1
  },
  clone(exampleWeatherModule),
  {
    id: "home-assistant",
    name: "Home Assistant",
    description: "Reads the state of lights, sensors and climate from your Home Assistant.",
    enabled: false,
    state: "disabled",
    tools: [],
    settings: {
      fields: [
        { type: "text", key: "baseUrl", label: "Address", apply: "live", default: "http://homeassistant.local:8123" },
        { type: "secret", key: "token", label: "Access token", description: "A long-lived access token (your Home Assistant profile → Security).", apply: "live", env: "HOME_ASSISTANT_TOKEN" },
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
        { type: "boolean", key: "includeAttributes", label: "Include details", description: "Brightness, colour and other attributes.", apply: "live", default: false, advanced: true }
      ],
      values: { baseUrl: "http://homeassistant.local:8123", domains: ["light", "sensor", "climate"], includeAttributes: false },
      secrets: { token: { set: true, source: "store" } },
      errors: []
    },
    revision: 1,
    protected: true
  },
  {
    id: "notes",
    name: "Notes",
    description: "Keeps short notes you dictate and reads them back.",
    enabled: false,
    state: "disabled",
    tools: [],
    settings: {
      fields: [
        {
          type: "choice",
          key: "folder",
          label: "Folder",
          apply: "live",
          default: "inbox",
          options: [
            { value: "inbox", label: "Inbox", description: "Everything lands here first." },
            { value: "work", label: "Work" },
            { value: "home", label: "Home" },
            { value: "ideas", label: "Ideas" },
            { value: "shopping", label: "Shopping list", description: "Read back as a list." }
          ]
        },
        { type: "text", key: "signature", label: "Note prefix", apply: "live", default: "", maxLength: 40, placeholder: "e.g. [voice]" },
        { type: "number", key: "maxNotes", label: "Notes to keep", apply: "live", default: 200, integer: true, min: 10, max: 5000, step: 10, unit: "notes" }
      ],
      values: { folder: "inbox", signature: "", maxNotes: 200 },
      secrets: {},
      errors: []
    },
    revision: 1
  }
]

const initialSections = (): Array<SettingsSection> => [
  {
    id: "conversation",
    title: "Conversation",
    form: {
      fields: [
        { type: "text", key: "SYSTEM_PROMPT", label: "System prompt", description: "How the assistant behaves. Applies from the next turn.", apply: "live", default: "You are a concise, friendly voice assistant.", multiline: true, maxLength: 4000 },
        { type: "number", key: "MAX_TOOL_ROUNDS", label: "Tool rounds per turn", apply: "reload", default: 4, integer: true, min: 1, max: 10, step: 1 }
      ],
      values: { SYSTEM_PROMPT: "You are a concise, friendly voice assistant.", MAX_TOOL_ROUNDS: 4 },
      secrets: {},
      errors: []
    },
    revision: 1
  },
  clone(exampleVoiceSection),
  {
    id: "listening",
    title: "Listening",
    description: "Turn detection for the local recogniser (sherpa).",
    form: {
      fields: [
        { type: "number", key: "STT_SHERPA_EAGER_SILENCE_MS", label: "Early guess after", apply: "reload", default: 250, integer: true, min: 100, max: 2000, step: 10, unit: "ms" },
        { type: "number", key: "STT_SHERPA_FINAL_SILENCE_MS", label: "End of turn after", apply: "reload", default: 600, integer: true, min: 200, max: 3000, step: 10, unit: "ms" },
        { type: "number", key: "STT_SHERPA_VAD_THRESHOLD", label: "Voice threshold", apply: "reload", default: 0.5, integer: false, min: 0.05, max: 0.95, step: 0.05, advanced: true }
      ],
      values: { STT_SHERPA_EAGER_SILENCE_MS: 250, STT_SHERPA_FINAL_SILENCE_MS: 600, STT_SHERPA_VAD_THRESHOLD: 0.5 },
      secrets: {},
      errors: []
    },
    revision: 1
  },
  {
    id: "language-model",
    title: "Language model",
    form: {
      fields: [
        { type: "choice", key: "LLM_PROVIDER", label: "Provider", apply: "reload", default: "anthropic", options: [{ value: "anthropic", label: "Anthropic" }, { value: "fake", label: "Fake (testing)" }] },
        { type: "text", key: "ANTHROPIC_MODEL", label: "Model", apply: "reload", default: "claude-haiku-5-5", locked: { reason: "Set by ANTHROPIC_MODEL in the environment" } },
        { type: "secret", key: "ANTHROPIC_API_KEY", label: "API key", apply: "reload", env: "ANTHROPIC_API_KEY" }
      ],
      values: { LLM_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-haiku-5-5" },
      secrets: { ANTHROPIC_API_KEY: { set: true, source: "env" } },
      errors: []
    },
    revision: 1,
    protected: true
  }
]

const readyEngine = (): EngineStatus => clone(exampleSnapshot.engine)
const keysLockedEngine = (): EngineStatus => ({
  ...readyEngine(),
  state: "failed",
  engines: [],
  problems: [{ stage: "language model (LLM_PROVIDER)", message: KEYS_LOCKED }]
})
const initialEngine = (): EngineStatus => (scenario === "engine-failed" ? failedEngine() : scenario === "keys-locked" ? keysLockedEngine() : readyEngine())
const failedEngine = (): EngineStatus => ({
  ...readyEngine(),
  state: "failed",
  engines: [],
  problems: [{ stage: "speech-to-text (STT_PROVIDER)", message: "DEEPGRAM_API_KEY is not set" }]
})

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Conn {
  readonly ws: WebSocket
  readonly id: string
  clientId?: string
  welcomed: boolean
  micFrames: number
  micGaps: number
  lastSeq: number | undefined
  /** Typed the vault password on this connection. */
  admin: boolean
}

interface Reply {
  readonly turnId: number
  readonly clauses: ReadonlyArray<{ readonly text: string; readonly startSample: number }>
  readonly endOfTurn: number
  readonly spoken: boolean
  readonly tools: Array<{ name: string; ms: number }>
  readonly source: "voice" | "text"
  readonly owner: Conn | undefined
  playedClause: number
  started?: { at: number; outputLatencyMs: number; startDelayMs: number }
  lastReport: number
  timers: Array<ReturnType<typeof setTimeout>>
  stallTimer?: ReturnType<typeof setInterval>
  ended: boolean
  dropScheduled?: boolean
}

const conns = new Set<Conn>()
let connSeq = 0
let owner: Conn | undefined
let lastOwnerClientId: string | undefined
let claimedSince = false
let assistantState: "idle" | "listening" | "hearing" | "thinking" | "speaking" = "idle"
let micLive = true
let modules = initialModules()
let sections = initialSections()
let engine: EngineStatus = initialEngine()
let vault: { state: "none" | "locked" | "unlocked"; password?: string } = scenario === "keys-locked" ? { state: "locked", password: VAULT_PASSWORD } : { state: "none" }
let history: Array<HistoryItem> = clone([...exampleSnapshot.history])
let traces: Array<TraceInfo> = []
let turnSeq = 20
let reply: Reply | undefined
let scriptTimers: Array<ReturnType<typeof setTimeout>> = []
const clientLog: Array<Record<string, unknown>> = []

const resetState = () => {
  for (const t of scriptTimers) clearTimeout(t)
  scriptTimers = []
  if (reply !== undefined) clearReply(reply)
  reply = undefined
  owner = undefined
  lastOwnerClientId = undefined
  claimedSince = false
  assistantState = "idle"
  micLive = true
  modules = initialModules()
  sections = initialSections()
  engine = initialEngine()
  vault = scenario === "keys-locked" ? { state: "locked", password: VAULT_PASSWORD } : { state: "none" }
  for (const c of conns) c.admin = false
  history = clone([...exampleSnapshot.history])
  traces = []
  turnSeq = 20
  clientLog.length = 0
}

const after = (ms: number, f: () => void) => {
  const t = setTimeout(f, ms)
  scriptTimers.push(t)
  return t
}

const sendTo = (c: Conn, m: ServerMessage) => {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(encodeServerMessage(m))
}
const broadcast = (m: ServerMessage) => {
  for (const c of conns) if (c.welcomed) sendTo(c, m)
}

const setState = (state: typeof assistantState, turnId?: number) => {
  if (state === assistantState && turnId === undefined) return
  assistantState = state
  broadcast(turnId === undefined ? { type: "state", state } : { type: "state", state, turnId })
}

// ---- Key vault and admin access (per connection)

const isAdmin = (c: Conn) => vault.state === "none" || (c.admin && vault.state === "unlocked")
const vaultInfo = (c: Conn) => ({ state: vault.state, admin: isAdmin(c), location: VAULT_LOCATION })
const sendVault = (c: Conn) => sendTo(c, { type: "vault", vault: vaultInfo(c) })
const vaultChanged = () => {
  if (vault.state !== "unlocked") for (const c of conns) c.admin = false
  for (const c of conns) if (c.welcomed) sendVault(c)
}
/** A protected change from a page without admin access is refused with `locked`. */
const refuseLocked = (c: Conn, requestId: string, isProtected: boolean | undefined): boolean => {
  if (isProtected !== true || isAdmin(c)) return false
  result(c, requestId, false, {
    code: "locked",
    message: vault.state === "locked"
      ? "The keys are locked: unlock them with the password in Options → Keys & access to change this."
      : "Protected: type the password in Options → Keys & access to change this."
  })
  return true
}
const grantAdmin = (c: Conn) => {
  c.admin = true
  sendVault(c)
}
const afterUnlock = () => {
  vaultChanged()
  if (engine.state === "failed" && engine.problems.some((p) => p.message === KEYS_LOCKED)) {
    engine = { ...engine, state: "reloading" }
    broadcast({ type: "engine", engine })
    after(600, () => {
      engine = { ...readyEngine(), reloadPending: false }
      broadcast({ type: "engine", engine })
    })
  }
}

const restingState = () => (owner !== undefined && micLive ? "listening" : "idle")

const sessionUpdate = (reason: "claimed" | "released" | "taken_over" | "owner_disconnected" | "resumed", ownerPresentOverride?: boolean) => {
  for (const c of conns) {
    if (!c.welcomed) continue
    sendTo(c, { type: "session", role: c === owner ? "owner" : "observer", ownerPresent: ownerPresentOverride ?? owner !== undefined, reason })
  }
}

// ---------------------------------------------------------------------------
// Reply audio: an amplitude-modulated tone that sounds (and looks) like speech rhythm.
// ---------------------------------------------------------------------------

const synthesize = (text: string, seed: number): Int16Array => {
  const seconds = Math.max(0.6, text.length * 0.055)
  const n = Math.round(seconds * REPLY_RATE)
  const out = new Int16Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / REPLY_RATE
    const pitch = 165 + 25 * Math.sin(2 * Math.PI * 0.7 * t + seed) + 10 * Math.sin(2 * Math.PI * 3.1 * t)
    phase += (2 * Math.PI * pitch) / REPLY_RATE
    const syllable = Math.max(0, Math.sin(2 * Math.PI * (3.6 + 0.4 * Math.sin(seed)) * t + seed)) ** 0.6
    const edge = Math.min(1, t / 0.03, (seconds - t) / 0.05)
    const s = Math.sin(phase) + 0.45 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase) + 0.12 * Math.sin(5 * phase)
    out[i] = Math.round(7000 * syllable * edge * s)
  }
  return out
}

const sendReplyAudio = (c: Conn, turnId: number, pcm: Int16Array) => {
  const chunk = Math.round(REPLY_RATE * 0.04) // ~40 ms, like Piper
  for (let off = 0; off < pcm.length; off += chunk) {
    const part = pcm.subarray(off, Math.min(pcm.length, off + chunk))
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(encodeReplyFrame(turnId, new Uint8Array(part.buffer, part.byteOffset, part.byteLength)))
  }
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

const clearReply = (r: Reply) => {
  for (const t of r.timers) clearTimeout(t)
  if (r.stallTimer !== undefined) clearInterval(r.stallTimer)
  r.ended = true
}

const makeTrace = (r: Reply, outcome: TraceInfo["outcome"]): TraceInfo => {
  const marks: { -readonly [K in keyof TraceInfo["marks"]]: number } = r.source === "voice"
    ? { llmRequestSent: -232, llmFirstToken: -231, firstClause: -216, ttsFirstAudio: -184 }
    : { llmRequestSent: 2, llmFirstToken: 296, firstClause: 340, ttsFirstAudio: 372 }
  if (r.started !== undefined) marks.playbackStart = r.started.at - r.endOfTurn
  const trace: TraceInfo = {
    turnId: r.turnId,
    mode: r.source,
    speculative: r.source === "voice",
    outcome,
    marks,
    totalMs: Date.now() - r.endOfTurn,
    tools: r.tools,
    voices: r.spoken ? ["standard"] : [],
    ...(r.started !== undefined ? { client: { outputLatencyMs: r.started.outputLatencyMs, startDelayMs: r.started.startDelayMs } } : {})
  }
  return trace
}

const endTurn = (r: Reply, outcome: "completed" | "interrupted" | "failed") => {
  if (r.ended) return
  clearReply(r)
  if (reply === r) reply = undefined
  const trace = makeTrace(r, outcome)
  traces = [...traces, trace].slice(-20)
  const heard = r.spoken ? r.clauses.filter((_, i) => i <= r.playedClause || outcome === "completed").map((c) => c.text).join(" ") : r.clauses.map((c) => c.text).join("")
  history.push({ role: "assistant", text: heard, interrupted: outcome !== "completed", tools: r.tools.map((t) => ({ name: t.name, ok: true })) })
  broadcast({ type: "turn.end", turnId: r.turnId, outcome, trace })
  setState(restingState())
}

/** Interrupt the running reply: reply.stop to the owner, wait ≤ 300 ms for playback.stopped. */
const interruptReply = (r: Reply) => {
  if (r.ended) return
  if (r.spoken && r.owner !== undefined && r.started !== undefined) {
    sendTo(r.owner, { type: "reply.stop", turnId: r.turnId })
    r.timers.push(setTimeout(() => endTurn(r, "interrupted"), 300))
    ;(r as { awaitingStop?: boolean }).awaitingStop = true
  } else {
    if (r.spoken && r.owner !== undefined) sendTo(r.owner, { type: "reply.stop", turnId: r.turnId })
    endTurn(r, "interrupted")
  }
}

const runReply = (opts: {
  source: "voice" | "text"
  userText: string
  clauses: ReadonlyArray<string>
  spoken: boolean
  tool?: { name: string; moduleId: string; input: unknown; ms: number; ok?: boolean; error?: string }
}) => {
  if (reply !== undefined) interruptReply(reply)
  const turnId = ++turnSeq
  const endOfTurn = Date.now()
  history.push({ role: "user", text: opts.userText })
  broadcast({ type: "transcript", text: "" })
  broadcast({ type: "turn.start", turnId, source: opts.source, userText: opts.userText, spoken: opts.spoken })
  setState("thinking", turnId)
  let startSample = 0
  const pcms = opts.clauses.map((text, i) => synthesize(text, i * 1.7 + turnId))
  const clauses = opts.clauses.map((text, i) => {
    const c = { text, startSample }
    startSample += pcms[i]!.length
    return c
  })
  const r: Reply = { turnId, clauses, endOfTurn, spoken: opts.spoken, tools: [], source: opts.source, owner, playedClause: -1, lastReport: Date.now(), timers: [], ended: false }
  reply = r
  let t = 120
  if (opts.tool !== undefined) {
    const tool = opts.tool
    r.timers.push(setTimeout(() => broadcast({ type: "tool.start", turnId, callId: `toolu_${turnId}`, tool: tool.name, moduleId: tool.moduleId, input: tool.input as never }), t))
    t += tool.ms
    r.timers.push(setTimeout(() => {
      r.tools.push({ name: tool.name, ms: tool.ms })
      broadcast({ type: "tool.end", turnId, callId: `toolu_${turnId}`, ok: tool.ok ?? true, ms: tool.ms, ...(tool.error !== undefined ? { error: tool.error } : {}) })
    }, t))
    t += 40
  }
  if (!opts.spoken) {
    // Unspoken: stream raw text deltas, then end.
    const words = opts.clauses.join(" ").split(/(?<= )/)
    words.forEach((w, i) => r.timers.push(setTimeout(() => broadcast({ type: "assistant.text", turnId, clause: null, text: w }), t + 280 + i * 45)))
    r.timers.push(setTimeout(() => endTurn(r, "completed"), t + 300 + words.length * 45))
    return
  }
  const c = owner
  r.timers.push(setTimeout(() => {
    if (c === undefined || c.ws.readyState !== c.ws.OPEN) {
      broadcast({ type: "error", error: { code: "turn_failed", message: "No audio client: the reply could not be played.", turnId } })
      endTurn(r, "failed")
      return
    }
    sendTo(c, { type: "reply.start", turnId, sampleRate: REPLY_RATE })
    r.lastReport = Date.now()
    // Watch for stalls: no report for 2 s while waiting → reply.stop + playback_timeout.
    r.stallTimer = setInterval(() => {
      if (r.ended) return
      if (Date.now() - r.lastReport > 2000) {
        sendTo(c, { type: "reply.stop", turnId })
        broadcast({ type: "error", error: { code: "playback_timeout", message: "The browser stopped reporting playback; the reply was stopped.", turnId } })
        endTurn(r, "failed")
      }
    }, 250)
  }, t))
  // Clauses go to TTS one after another, faster than real time.
  opts.clauses.forEach((text, i) => {
    r.timers.push(setTimeout(() => {
      broadcast({ type: "assistant.text", turnId, clause: i, text, voice: "standard" })
      if (c !== undefined) sendReplyAudio(c, turnId, pcms[i]!)
      if (i === opts.clauses.length - 1 && c !== undefined) sendTo(c, { type: "reply.end", turnId })
    }, t + 30 + i * 380))
  })
}

const VOICE_CLAUSES = ["It's sunny in Paris,", "eighteen degrees with a light wind from the west,", "and it stays dry until the evening."]

const runVoiceTurn = () => {
  if (owner === undefined) return
  setState("hearing")
  const words = ["what's", "what's the", "what's the weather", "what's the weather in", "what's the weather in Paris"]
  words.forEach((w, i) => after(250 + i * 260, () => broadcast({ type: "transcript", text: w })))
  after(250 + words.length * 260 + 350, () =>
    runReply({
      source: "voice",
      userText: "What's the weather in Paris?",
      clauses: VOICE_CLAUSES,
      spoken: true,
      tool: { name: "weather", moduleId: "weather", input: { place: "Paris, France" }, ms: 241 }
    }))
}

// ---------------------------------------------------------------------------
// Client messages
// ---------------------------------------------------------------------------

const result = (c: Conn, requestId: string, ok: boolean, error?: Extract<ServerMessage, { type: "result" }>["error"]) =>
  sendTo(c, error === undefined ? { type: "result", requestId, ok } : { type: "result", requestId, ok, error })

const applyPatch = (form: SettingsForm, patch: SettingsPatch): SettingsForm => {
  const values: Record<string, SettingValue> = { ...form.values }
  const secrets = { ...form.secrets }
  for (const [k, v] of Object.entries(patch.values)) {
    const field = form.fields.find((f) => f.key === k)
    if (field === undefined || field.type === "secret") continue
    values[k] = v === null ? (field.default as SettingValue) : v
  }
  for (const [k, v] of Object.entries(patch.secrets)) secrets[k] = v === null ? { set: false, source: "none" } : { set: true, source: "store" }
  return { ...form, values, secrets, errors: [] }
}

const validate = (form: SettingsForm, patch: SettingsPatch) => {
  const errors: Array<{ key: string | null; message: string }> = []
  for (const [k, v] of Object.entries(patch.values)) {
    const field = form.fields.find((f) => f.key === k)
    if (field === undefined) errors.push({ key: null, message: `Unknown setting ${k}.` })
    else if (field.locked !== undefined) errors.push({ key: k, message: `${field.locked.reason}; change it there.` })
    else if (field.type === "number" && typeof v === "number" && ((field.min !== undefined && v < field.min) || (field.max !== undefined && v > field.max))) {
      errors.push({ key: k, message: `Must be between ${field.min} and ${field.max}.` })
    } else if (k === "defaultPlace" && typeof v === "string" && /atlantis/i.test(v)) errors.push({ key: k, message: "Open-Meteo does not know this place." })
    else if (k === "baseUrl" && typeof v === "string" && !/^https?:\/\//.test(v)) errors.push({ key: k, message: "Must start with http:// or https://" })
  }
  return errors
}

const setModule = (id: string, f: (m: ModuleInfo) => ModuleInfo) => {
  const i = modules.findIndex((m) => m.id === id)
  if (i === -1) return undefined
  const next = { ...f(modules[i]!), revision: modules[i]!.revision + 1 }
  modules[i] = next
  broadcast({ type: "module.changed", module: next })
  return next
}

/** Start a module (600 ms). home-assistant fails unless its token was replaced with one containing "good". */
const startModule = (c: Conn, requestId: string, id: string) => {
  setModule(id, (m) => {
    const { error: _e, status: _s, ...rest } = m
    return { ...rest, enabled: true, state: "starting" }
  })
  after(600, () => {
    const m = modules.find((x) => x.id === id)!
    const goodToken = (m as ModuleInfo & { tokenGood?: boolean }).tokenGood === true
    if (id === "home-assistant" && !goodToken) {
      const message = "Home Assistant rejected the token (HTTP 401). Create a new long-lived token and paste it here."
      setModule(id, (x) => ({ ...x, state: "error", error: message, tools: [] }))
      result(c, requestId, false, { code: "module_start_failed", message, moduleId: id })
      return
    }
    const tools = id === "home-assistant"
      ? [{ name: "home_state", description: "Current state of devices, by area or by name.", speculative: true }]
      : id === "notes"
      ? [{ name: "add_note", description: "Save a short note.", speculative: false }, { name: "read_notes", description: "Read recent notes.", speculative: true }]
      : m.tools.length > 0 ? m.tools : initialModules().find((x) => x.id === id)?.tools ?? []
    const status = id === "home-assistant" ? { text: "Connected to Home · 42 devices", tone: "ok" as const } : id === "notes" ? { text: "12 notes in Inbox", tone: "neutral" as const } : m.status
    setModule(id, (x) => ({ ...x, state: "running", tools, ...(status !== undefined ? { status } : {}) }))
    result(c, requestId, true)
  })
}

const onClientMessage = (c: Conn, m: ClientMessage) => {
  if (m.type !== "ping" && m.type !== "playback.progress") log(c.id, "←", m.type)
  if (m.type !== "ping" && m.type !== "hello") clientLog.push({ at: Date.now(), conn: c.id, ...m })
  switch (m.type) {
    case "hello":
      return
    case "audio.claim": {
      const previous = owner
      if (previous !== undefined && previous !== c) {
        if (reply !== undefined && reply.owner === previous) sendTo(previous, { type: "reply.stop", turnId: reply.turnId })
        if (reply !== undefined) interruptReply(reply)
      }
      owner = c
      lastOwnerClientId = c.clientId
      claimedSince = true
      micLive = true
      c.lastSeq = undefined
      for (const x of conns) {
        if (!x.welcomed) continue
        sendTo(x, { type: "session", role: x === c ? "owner" : "observer", ownerPresent: true, reason: x === previous ? "taken_over" : "claimed" })
      }
      setState("listening")
      if (scenario === "voice" || scenario === "drop-mid-reply") after(900, runVoiceTurn)
      if (scenario === "takeover") {
        after(1500, () => {
          if (owner !== c) return
          owner = undefined
          lastOwnerClientId = "c-another-tab"
          sendTo(c, { type: "session", role: "observer", ownerPresent: true, reason: "taken_over" })
          for (const x of conns) if (x !== c && x.welcomed) sendTo(x, { type: "session", role: "observer", ownerPresent: true, reason: "claimed" })
          setState("listening")
        })
      }
      return
    }
    case "audio.release":
      if (owner !== c) return
      owner = undefined
      if (reply !== undefined) interruptReply(reply)
      sessionUpdate("released")
      setState("idle")
      return
    case "audio.config":
      return
    case "mic.state":
      if (owner !== c) return sendTo(c, { type: "error", error: { code: "not_owner", message: "Only the audio owner can do that." } })
      micLive = m.live
      c.lastSeq = undefined
      if (reply === undefined) setState(restingState())
      return
    case "playback.started": {
      const r = reply
      if (r === undefined || r.turnId !== m.turnId || r.started !== undefined) return
      r.started = { at: Date.now(), outputLatencyMs: m.outputLatencyMs, startDelayMs: m.startDelayMs }
      r.lastReport = Date.now()
      r.playedClause = 0
      setState("speaking", r.turnId)
      broadcast({ type: "assistant.playing", turnId: r.turnId, clause: 0 })
      if (scenario === "drop-mid-reply" && r.dropScheduled !== true) {
        r.dropScheduled = true
        r.timers.push(setTimeout(() => dropAll(), 800))
      }
      return
    }
    case "playback.progress":
    case "playback.finished":
    case "playback.stopped": {
      const r = reply
      if (r === undefined || r.turnId !== m.turnId) return
      r.lastReport = Date.now()
      let k = r.playedClause
      while (k + 1 < r.clauses.length && r.clauses[k + 1]!.startSample < m.playedSamples) k++
      if (k > r.playedClause) {
        r.playedClause = k
        broadcast({ type: "assistant.playing", turnId: r.turnId, clause: k })
      }
      if (m.type === "playback.finished") endTurn(r, "completed")
      if (m.type === "playback.stopped") endTurn(r, "interrupted")
      return
    }
    case "interrupt": {
      const r = reply
      if (r === undefined || (m.turnId !== undefined && m.turnId !== r.turnId)) return
      interruptReply(r)
      return
    }
    case "text.send": {
      if (engine.state !== "ready") return result(c, m.requestId, false, { code: "engine_failed", message: "The assistant's engines are not running; see Options → Assistant." })
      result(c, m.requestId, true)
      const spoken = c === owner && m.speak
      const lower = m.text.toLowerCase()
      const clauses = lower.includes("time")
        ? ["It's twenty past four in the afternoon in Tokyo."]
        : lower.includes("long") || lower.includes("story")
        ? ["Once upon a time, in a city of canals,", "a small boat carried letters from door to door,", "and every evening the boatman sang the names of the streets,", "so that the houses would remember them."]
        : ["You said: " + m.text.slice(0, 80) + ".", "This is the mock assistant, so that is all I can say."]
      const tool = lower.includes("time") ? { name: "current_time", moduleId: "clock", input: { zone: "Asia/Tokyo" }, ms: 3 } : lower.includes("fail") ? { name: "weather", moduleId: "weather", input: { place: "Atlantis" }, ms: 3000, ok: false, error: "Weather service did not answer within 3000 ms" } : undefined
      runReply({ source: "text", userText: m.text, clauses, spoken, ...(tool !== undefined ? { tool } : {}) })
      return
    }
    case "module.enable": {
      const mod = modules.find((x) => x.id === m.moduleId)
      if (mod === undefined) return result(c, m.requestId, false, { code: "unknown_module", message: `No module ${m.moduleId}.` })
      if (refuseLocked(c, m.requestId, mod.protected)) return
      startModule(c, m.requestId, m.moduleId)
      return
    }
    case "module.disable": {
      const mod = modules.find((x) => x.id === m.moduleId)
      if (mod === undefined) return result(c, m.requestId, false, { code: "unknown_module", message: `No module ${m.moduleId}.` })
      if (refuseLocked(c, m.requestId, mod.protected)) return
      setModule(m.moduleId, (x) => {
        const { error: _e, status: _s, ...rest } = x
        return { ...rest, enabled: false, state: "stopping", tools: [] }
      })
      result(c, m.requestId, true)
      after(400, () => setModule(m.moduleId, (x) => ({ ...x, state: "disabled" })))
      return
    }
    case "module.configure": {
      const mod = modules.find((x) => x.id === m.moduleId)
      if (mod === undefined) return result(c, m.requestId, false, { code: "unknown_module", message: `No module ${m.moduleId}.` })
      if (refuseLocked(c, m.requestId, mod.protected)) return
      const errors = validate(mod.settings, m.patch)
      if (errors.length > 0) return result(c, m.requestId, false, { code: "invalid_settings", message: "Some settings are not valid.", moduleId: m.moduleId, fieldErrors: errors })
      const tokenGood = typeof m.patch.secrets.token === "string" ? m.patch.secrets.token.includes("good") : (mod as ModuleInfo & { tokenGood?: boolean }).tokenGood
      setModule(m.moduleId, (x) => ({ ...x, settings: applyPatch(x.settings, m.patch), ...(tokenGood !== undefined ? { tokenGood } : {}) }) as ModuleInfo)
      if (mod.state === "error" && mod.enabled) startModule(c, m.requestId, m.moduleId)
      else result(c, m.requestId, true)
      return
    }
    case "settings.update": {
      const i = sections.findIndex((s) => s.id === m.sectionId)
      if (i === -1) return result(c, m.requestId, false, { code: "unknown_section", message: `No section ${m.sectionId}.` })
      const section = sections[i]!
      if (refuseLocked(c, m.requestId, section.protected)) return
      const errors = validate(section.form, m.patch)
      if (errors.length > 0) return result(c, m.requestId, false, { code: "invalid_settings", message: "Some settings are not valid.", fieldErrors: errors })
      const next: SettingsSection = { ...section, form: applyPatch(section.form, m.patch), revision: section.revision + 1 }
      sections[i] = next
      result(c, m.requestId, true)
      broadcast({ type: "section.changed", section: next })
      const needsReload = Object.keys({ ...m.patch.values, ...m.patch.secrets }).some((k) => section.form.fields.find((f) => f.key === k)?.apply === "reload")
      if (needsReload && !engine.reloadPending) {
        engine = { ...engine, reloadPending: true }
        broadcast({ type: "engine", engine })
      }
      return
    }
    case "engine.reload": {
      if (engine.state === "reloading") return result(c, m.requestId, false, { code: "busy", message: "A reload is already running." })
      if (reply !== undefined) interruptReply(reply)
      engine = { ...engine, state: "reloading" }
      broadcast({ type: "engine", engine })
      after(1200, () => {
        engine = { ...readyEngine(), reloadPending: false }
        broadcast({ type: "engine", engine })
        result(c, m.requestId, true)
      })
      return
    }
    case "vault.setup": {
      if (vault.state !== "none") return result(c, m.requestId, false, { code: "busy", message: `A vault already exists at ${VAULT_LOCATION}` })
      if (m.password.length < 8) return result(c, m.requestId, false, { code: "bad_password", message: "The password must be at least 8 characters" })
      vault = { state: "unlocked", password: m.password }
      c.admin = true
      result(c, m.requestId, true)
      vaultChanged()
      return
    }
    case "vault.unlock": {
      if (vault.state === "none") return result(c, m.requestId, false, { code: "locked", message: "There is no vault yet" })
      if (m.password !== vault.password) return result(c, m.requestId, false, { code: "bad_password", message: "Wrong password (or the vault file was changed)" })
      const wasLocked = vault.state === "locked"
      vault = { ...vault, state: "unlocked" }
      result(c, m.requestId, true)
      grantAdmin(c)
      if (wasLocked) afterUnlock()
      return
    }
    case "vault.lock": {
      if (vault.state === "none") return result(c, m.requestId, false, { code: "locked", message: "There is no key vault yet: set a password first" })
      if (!isAdmin(c)) return result(c, m.requestId, false, { code: "locked", message: "Protected: type the password in Options → Keys & access to change this." })
      vault = { ...vault, state: "locked" }
      result(c, m.requestId, true)
      vaultChanged()
      return
    }
    case "vault.changePassword": {
      if (vault.state === "none") return result(c, m.requestId, false, { code: "locked", message: "There is no vault yet" })
      if (m.oldPassword !== vault.password) return result(c, m.requestId, false, { code: "bad_password", message: "Wrong password (or the vault file was changed)" })
      if (m.newPassword.length < 8) return result(c, m.requestId, false, { code: "bad_password", message: "The password must be at least 8 characters" })
      const wasLocked = vault.state === "locked"
      vault = { state: "unlocked", password: m.newPassword }
      result(c, m.requestId, true)
      grantAdmin(c)
      if (wasLocked) afterUnlock()
      return
    }
    case "ping":
      sendTo(c, { type: "pong", id: m.id })
      return
  }
}

const dropAll = () => {
  log("dropping every connection")
  for (const c of conns) c.ws.terminate()
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

wss.on("connection", (ws: WebSocket) => {
  const c: Conn = { ws, id: `conn-${++connSeq}`, welcomed: false, micFrames: 0, micGaps: 0, lastSeq: undefined, admin: false }
  conns.add(c)
  log(c.id, "connected")
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (!c.welcomed) return ws.close(CloseCode.badMessage)
      const frame = decodeMicFrame(data)
      if (!frame.ok || c !== owner) return
      c.micFrames++
      if (frame.frame.pcm.byteLength !== 640) clientLog.push({ at: Date.now(), conn: c.id, type: "mic.bad-size", bytes: frame.frame.pcm.byteLength })
      if (c.lastSeq !== undefined && frame.frame.seq !== ((c.lastSeq + 1) >>> 0)) c.micGaps++
      c.lastSeq = frame.frame.seq
      return
    }
    const decoded = decodeClientMessage(data.toString("utf8"))
    if (decoded._tag !== "Ok") {
      if (decoded._tag === "Invalid") sendTo(c, { type: "error", error: { code: "bad_message", message: decoded.reason } })
      return
    }
    const m = decoded.message
    if (!c.welcomed) {
      if (m.type !== "hello") return ws.close(CloseCode.helloTimeout)
      if (scenario === "outdated" || m.protocol !== PROTOCOL_VERSION) {
        sendTo(c, { type: "error", error: { code: "bad_message", message: "This page is out of date; reload it." } })
        return ws.close(CloseCode.protocolMismatch)
      }
      c.clientId = m.clientId
      c.welcomed = true
      const resumed = m.resumeOwner && owner === undefined && lastOwnerClientId === m.clientId
      if (resumed) {
        owner = c
        c.lastSeq = undefined
      }
      sendTo(c, {
        type: "welcome",
        protocol: PROTOCOL_VERSION,
        server: { name: "pva-mock", version: "0.0.0" },
        connectionId: c.id,
        snapshot: {
          state: resumed ? "listening" : assistantState,
          role: c === owner ? "owner" : "observer",
          ownerPresent: owner !== undefined || lastOwnerClientId === "c-another-tab",
          engine,
          modules,
          sections,
          history: history.slice(-200),
          traces: traces.slice(-20),
          vault: vaultInfo(c)
        }
      })
      if (resumed) {
        sessionUpdate("resumed")
        setState("listening")
      }
      return
    }
    onClientMessage(c, m)
  })
  ws.on("close", () => {
    conns.delete(c)
    log(c.id, "closed")
    if (owner === c) {
      owner = undefined
      if (reply !== undefined && reply.owner === c) {
        broadcast({ type: "error", error: { code: "turn_failed", message: "The audio client disconnected during the reply.", turnId: reply.turnId } })
        endTurn(reply, "failed")
      }
      sessionUpdate("owner_disconnected")
      setState("idle")
    }
  })
})

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = ""
    req.on("data", (d: Buffer) => (body += d.toString("utf8")))
    req.on("end", () => resolve(body))
  })

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
  res.end(JSON.stringify(body))
}

const http = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST", "access-control-allow-headers": "content-type" })
      return res.end()
    }
    if (url.pathname === "/mock/log" && req.method === "GET") {
      return json(res, 200, {
        scenario,
        messages: clientLog,
        mic: [...conns].map((c) => ({ conn: c.id, frames: c.micFrames, gaps: c.micGaps, owner: c === owner })),
        state: assistantState,
        connections: conns.size
      })
    }
    if (req.method !== "POST") return json(res, 404, { error: "not found" })
    const body = await readBody(req)
    const payload = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>)
    switch (url.pathname) {
      case "/mock/scenario":
        if (!isScenario(payload.name)) return json(res, 400, { error: `scenario must be one of ${SCENARIOS.join(", ")}` })
        scenario = payload.name
        resetState()
        dropAll()
        log("scenario", scenario)
        return json(res, 200, { scenario })
      case "/mock/reset":
        resetState()
        dropAll()
        return json(res, 200, { ok: true })
      case "/mock/turn":
        runVoiceTurn()
        return json(res, 200, { ok: true })
      case "/mock/drop":
        dropAll()
        return json(res, 200, { ok: true })
      case "/mock/offline": {
        // Drop every socket and refuse new ones for `ms` (default 3 s): the UI shows reconnecting.
        offlineUntil = Date.now() + (typeof payload.ms === "number" ? payload.ms : 3000)
        dropAll()
        return json(res, 200, { ok: true })
      }
      case "/mock/send": {
        const messages = Array.isArray(payload.messages) ? payload.messages : []
        for (const m of messages) for (const c of conns) if (c.welcomed && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m))
        return json(res, 200, { sent: messages.length })
      }
      default:
        return json(res, 404, { error: "not found" })
    }
  })().catch((e: unknown) => json(res, 500, { error: String(e) }))
})

let offlineUntil = 0

http.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname !== "/ws" || Date.now() < offlineUntil) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
})

http.listen(PORT, HOST, () => console.log(`[mock] assistant mock on ws://${HOST}:${PORT}/ws · scenario ${scenario}`))

const shutdown = () => {
  for (const c of conns) c.ws.close(CloseCode.serverShutdown)
  http.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
