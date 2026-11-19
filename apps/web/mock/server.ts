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
 *                   (weather "Home location" = "Atlantis"). Capability modules run while an assistant has them on
 *                   (`instances` per effective settings; `module.enable` is `not_allowed`); POST /mock/module-error
 *                   {module, message?} makes a module's instances fail, and a saved token with "good" in it fixes them.
 *   latency         like typed, with Diagnostics › Latency seeded: turns of every route kind with configuration
 *                   snapshots (some differ from the assistants now), and a few devices.
 * Settings in every scenario are placed like the real server's (group/page/order, visibleWhen, option tags), with
 * its cross-field checks (final silence > early guess: error; a hosted provider without its key: warning, "Save
 * anyway" with confirmWarnings), reloadPendingFor, and the Claude subscription agent (starts once opted in).
 *   engine-failed   the engines failed (problems listed); typed messages are refused.
 *   drop-mid-reply  like voice, but every socket is dropped 0.8 s into the reply's playback.
 *   takeover        like voice without a turn; 1.5 s after a claim, "another tab" takes the audio.
 *   outdated        every hello is answered with close 4400 (page out of date).
 *   vault           like modules; protected items (Home Assistant, Language model, Speech engine, Claude subscription) can be changed by any page until a
 *                   password is set (vault.setup), then only by pages that typed it. Lock / unlock / change password work.
 *   keys-locked     a vault exists (password "correct horse battery") and is locked, so the engines failed;
 *                   unlocking reloads them.
 *   wake            like voice, but the web-voice default is the wake phrase: after a claim the assistant is asleep;
 *                   "hey go …" is ignored (a tester line), then "hey jeff" alone wakes it (`wake`, armed) and the voice
 *                   turn follows; after the reply the follow-up window, then asleep again. Devices are seeded.
 *   devices         like typed, with two remembered devices (the Kitchen iPad has its own assistant list) besides the ones that connect.
 *   long-phrase     like typed, with a six-word wake phrase ("hello my personal voice assistant please") as the
 *                   web-voice default (asleep after a claim) and a third device that has it among three phrases.
 *   admin-disabled  no admin password: `admin.state.enabled` is false and every login is refused.
 *   admin-backoff   every wrong admin password refuses logins for 30 s.
 *   health          like typed (protocol 9): Diagnostics › Health lists a module error and a module warning for one
 *                   device (the kitchen speaker); the Music module is unavailable (yt-dlp is missing) and suggests a
 *                   DJ template; Check again takes 1 s and clears the speaker warning. Every other scenario has an
 *                   empty, checked registry.
 * In every scenario the vault starts as "none" (no vault yet) unless the scenario says otherwise.
 *
 * Protocol 5 (docs/FRONTENDS-AND-ACTIVATION.md): pages say `frontend: "voice" | "admin"` in hello. The admin
 * password is ADMIN_PASSWORD below ("admin password"); a login returns a token that a later hello may carry. The
 * admin part (settings, modules, engine status, vault, env, models, jobs, traces, assistants, devices) goes to
 * admin connections only, and every change needs one (`admin_required` otherwise). Voice pages get the voice part,
 * `engine.summary`, their device setup (`device.setup`, live, protocol 7), and `wake`. Admin pages that switched the
 * tester on get `wake.heard`.
 *
 * Every scenario also has settings from a fake .env (Diagnostics › Settings from outside: Move works, keys are refused
 * while the vault is locked) and model downloads (Speech recognition › Models, Voices › Models: a download takes
 * MOCK_DOWNLOAD_TICKS × 250 ms, then 1.5 s to "unpack"; Cancel and Delete work; the models in use cannot be deleted).
 *
 * Control endpoints (for tests): GET /mock/log (client messages and microphone stats), POST /mock/reset,
 * POST /mock/turn (run the scripted voice turn now), POST /mock/send {"messages": [ServerMessage…]} (broadcast),
 * POST /mock/notify {"title", "ring"?, "deviceId"?, "actions"?, "handlerDown"?} (P9: a notification card, delivered as the
 * server does, again after each hello while open), POST /mock/notify/resolve {"id"}, POST /mock/volume {"deviceId",
 * "direction" | "to"} (P7: the device's reply volume as a spoken "louder"/"quieter" changes it, `output.volume` to its
 * voice pages now and after each welcome while it is not the default),
 * POST /mock/present {"presentation", "options"? (lifetime, expiresInMs), "id"?, "deviceId"?, "handlerDown"?} (P10: a
 * presentation shown as the server does: the shared checks, bounds, decision and selection, again after each hello while
 * live; household content only and no `key`: refused with a 400 that says the mock does not model them),
 * POST /mock/present/dismiss {"id"},
 * POST /mock/drop (terminate every socket), POST /mock/offline {"ms": 3000} (drop and refuse connections for a while),
 * POST /mock/admin/end {"reason": "idle" | "expired"} (end every admin session), POST /mock/wake {"phrase", "armed"}
 * (the owner said the wake phrase), POST /mock/heard {"text", "matched"?, "accepted"?, "source"?} (a tester line; `accepted: null` or `source: null` leaves that field out), POST /mock/state
 * {"state"} (set the assistant state, e.g. "asleep"), POST /mock/defaults {"patch"} (change the web-voice defaults).
 *
 * Protocol 6 (docs/VOICE-SESSIONS.md): one voice session per device (`hello.device.id`; a voice page without one has
 * its own), each with its own audio owner, state, conversation (starting with the example history) and reply.
 * Turn traffic, `state`, `session`, `wake` and `conversation` go to that device's tabs only; admin connections get
 * `sessions` (and `admin.snapshot.sessions`) and no turn traffic. A claim on one device never touches another; within
 * a device the last claim wins. `conversation.new` restarts the device's conversation; a turn after more than the
 * device's `conversationIdleMinutes` without one starts with `conversation { reason: "idle" }`. More started sessions
 * than MAX_VOICE_SESSIONS (Language model › Conversations, default 4) are refused with `sessions_full` unless a
 * session whose device left can make room (the least recently active one is dropped); a session
 * without a connection for SESSION_DISCARD_MINUTES is dropped. `wake.test.deviceId` picks whose lines the tester gets.
 * The endpoints that act on a session (/mock/turn, /mock/wake, /mock/state, /mock/heard) take an optional
 * "deviceId" (default: the most recently active session that has an owner); POST /mock/idle {"deviceId"?, "now"?}
 * makes the device's conversation old enough for the idle reset at its next turn (`now`: at once);
 * POST /mock/max-sessions {"n"} sets MAX_VOICE_SESSIONS. POST /mock/typesafe {"on"?} sets TypeSafe up (a running decision module, so
 * the server's `canAuto` is true) or off.
 *
 * Protocol 7, the voice connection (docs/ASSISTANTS.md §5.3, mock/voiceAssistants.ts): `snapshot.setup` / `device.setup` from
 * the device's effective settings (what admin saved, so a pick shows in the admin state), one conversation per assistant
 * (`snapshot.conversations`, `conversation.read` → `conversation.history`, `conversation.new { assistantId }`), turns,
 * `wake` and `reply.start` that name their assistant, `device.pick` (`not_allowed` unless the setup says `canPick`).
 * The first conversation of a session is the one that has the example history. The wake and long-phrase scenarios sleep
 * until the phrase (saved on the web-voice type). POST /mock/turn {"assistantId"?, "phrase"?} runs the scripted turn for an assistant (woken
 * by the phrase), POST /mock/wake takes "assistantId"?, POST /mock/typesafe {"on"?} sets up "Whichever fits",
 * POST /mock/device {"deviceId"?, "settings"} saves a device's (default: the type's) settings as admin would.
 *
 * The voice picker's HTTP API (docs/VOICE-PROVIDERS.md §5) is under /api/ on the same port (admin token from a login,
 * CORS for the page's origin): the providers of mock/voices.ts (On this machine; Cartesia without a key, `vault_locked`
 * while the vault is locked; ElevenLabs with one), favourites, previews (WAV tones, one at a time: `superseded`; `busy`
 * for a voice on this machine while a device is in a turn), downloads (the Models page's jobs) and the assistant's voice
 * (ASSISTANT_VOICE, with the server's checks). POST /mock/voices/fail {"provider", "on"?} makes a provider's key
 * refused; POST /mock/voices/hold {"ms"} delays previews.
 *
 * The model pickers' API (docs/MODEL-PICKERS.md §4) is under /api/models/ (mock/modelPickers.ts: every provider state,
 * recogniser downloads as the Models page's jobs); POST /mock/models/state {"provider", "state"} forces a state.
 */
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  hearerOf,
  phraseKey,
  type AdminState,
  type ClientMessage,
  CloseCode,
  type AssistantState,
  type ConversationInfo,
  DEFAULT_CONVERSATION_IDLE_MINUTES,
  DEFAULT_MAX_VOICE_SESSIONS,
  DEFAULT_SESSION_DISCARD_MINUTES,
  type DeclaredCapabilities,
  type DeviceListInfo,
  BUILT_IN_WEB_VOICE_SETTINGS,
  WAKE_ARMED_MS,
  WAKE_TEST_MAX_MS,
  WEB_VOICE_KIND,
  decodeClientMessage,
  decodeMicFrame,
  encodeReplyFrame,
  encodeServerMessage,
  engineSummary,
  type EngineStatus,
  type EnvInfo,
  type HistoryItem,
  type JobInfo,
  type ModelSet,
  type HealthInfo,
  type ModuleInfo,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionInfo,
  type SettingsForm,
  type SettingsPatch,
  type SettingsSection,
  type SettingValue,
  type ToolId,
  type TraceInfo,
  type Favourite,
  MAX_FAVOURITES,
  MAX_PREVIEW_CHARS,
  type ProviderInfo,
  type ProviderVoices,
  type VoiceEntry,
  voiceFor
} from "@pva/protocol"
import { answerHealthCheck } from "./health.ts"
import { exampleEngineStatus, exampleHealth, exampleSnapshot, exampleUnavailableModule, exampleVoiceSection, exampleWeatherModule } from "@pva/protocol/examples"
import { type WebSocket, WebSocketServer } from "ws"
import { createAssistantsMock, SAM_ID } from "./assistants.ts"
import { type CapabilityParts, reconcileCapability } from "./capabilities.ts"
import { fieldValueError } from "./fieldChecks.ts"
import { seedTraces } from "./traces.ts"
import { createVoiceAssistants, scenarioSettings, scriptedTurn } from "./voiceAssistants.ts"
import { encodeWav, MOCK_PROVIDERS } from "./voices.ts"
import { createModelPickersMock } from "./modelPickers.ts"
import { createModuleRoutesMock, DEMO_DEFINITION_ACTIONS, demoHomeAction, demoHomeModule, TokenRefusal } from "./demoHome.ts"
import { createScheduledJobsMock, MockSchedulerError } from "./scheduledJobs.ts"
import { decideRisk, decodeRiskPolicy, DEFAULT_RISK_POLICY, FIXED_REASON, FIXED_RISK_CLASSES, RISK_POLICY_KEYS, riskLanguageOf, riskPageTexts, riskPolicyPatchProblems, riskSpoken } from "@pva/protocol"
import { boundaryKey, changeReplyVolume, checkDietList, checkMembersValue, cleanDeviceName, type Condition, decideDelivery, decidePresentation, type DeviceCapabilities, deviceOutputsFrom, devicePresentFrom, type FieldError, MAX_LIVE_PER_MODULE, MAX_LIVE_TOTAL, MAX_PINNED_PER_DEVICE, NO_REPLY_VOLUMES, PRESENT_KIND_VERSIONS, type Presentation, PRESENTATION_ID, PresentationWire, presentationProblem, type PresentKindName, presentLifetime, presentWireContent, type ReplyVolumes, selectPresentations, type ShowOptions, showOptionsProblem, speakerAllowedFrom } from "@pva/protocol"

const PORT = Number(process.env.MOCK_PORT ?? 8787)
const HOST = process.env.MOCK_HOST ?? "127.0.0.1"
const SCENARIOS = [
  "voice",
  "typed",
  "modules",
  "engine-failed",
  "drop-mid-reply",
  "takeover",
  "outdated",
  "vault",
  "keys-locked",
  "wake",
  "devices",
  "long-phrase",
  "latency",
  "admin-disabled",
  "admin-backoff",
  "health"
] as const
/** The admin password of the mock (`PVA_ADMIN_PASSWORD` on the real server). */
const ADMIN_PASSWORD = "admin password"
const VAULT_PASSWORD = "correct horse battery"
const VAULT_LOCATION = "/home/owner/.config/pva/vault.enc"
const KEYS_LOCKED = "Keys are locked — unlock them in admin → Keys & vault"
const ENV_FILE = "/home/owner/personal-voice-assistance/.env"
const MODELS_DIR = "/home/owner/personal-voice-assistance/models"
/** Simulated download speed: ticks of 250 ms (MOCK_DOWNLOAD_TICKS, default 16 for the download and 6 to unpack). */
const DOWNLOAD_TICKS = Number(process.env.MOCK_DOWNLOAD_TICKS ?? 16)
type Scenario = typeof SCENARIOS[number]
const REPLY_RATE = 22_050

const isScenario = (s: unknown): s is Scenario => typeof s === "string" && (SCENARIOS as ReadonlyArray<string>).includes(s)
let scenario: Scenario = isScenario(process.env.MOCK_SCENARIO) ? process.env.MOCK_SCENARIO : "voice"
/** The scenarios with remembered devices (and, protocol 11, Sam and Robin in Members). */
const seededDeviceScenario = () => scenario === "devices" || scenario === "wake" || scenario === "long-phrase" || scenario === "latency"

const log = (...args: Array<unknown>) => {
  if (process.env.MOCK_QUIET !== "1") console.log("[mock]", ...args)
}

// ---------------------------------------------------------------------------
// Catalog: modules and settings sections covering every field type.
// ---------------------------------------------------------------------------

const clone = <T>(x: T): T => structuredClone(x)

/** A capability module whose fields `keys` an assistant may own (`overridable`), as the server marks them. */
const withOverridable = (m: ModuleInfo, keys: ReadonlyArray<string>): ModuleInfo => ({
  ...m,
  kind: "capability",
  group: "modules",
  settings: { ...m.settings, fields: m.settings.fields.map((f) => (keys.includes(f.key) ? { ...f, overridable: true } : f)) }
})

const initialModules = (): Array<ModuleInfo> => [
  {
    id: "clock",
    name: "Clock",
    description: "Tells the model the local date and time, and the time anywhere else.",
    enabled: true,
    state: "running",
    status: { text: "Europe/Amsterdam · 13 November 2026", tone: "neutral" },
    tools: [{ name: "current_time", description: "The current time in a time zone.", speculative: true }, { name: "time_in", description: "The time in another place.", speculative: true }],
    settings: {
      fields: [
        { type: "text", key: "timeZone", label: "Time zone", description: "IANA name, e.g. Europe/Amsterdam. Empty: this machine's zone.", apply: "live", default: "", placeholder: "Europe/Amsterdam", locked: { reason: "Set by CLOCK_TIME_ZONE in the environment" }, overridable: true },
        {
          type: "choice",
          key: "locale",
          label: "Date format",
          apply: "live",
          default: "en-GB",
          overridable: true,
          options: [{ value: "en-GB", label: "13 November 2026" }, { value: "en-US", label: "November 13, 2026" }, { value: "nl-NL", label: "13 november 2026" }]
        }
      ],
      values: { timeZone: "Europe/Amsterdam", locale: "en-GB" },
      secrets: {},
      errors: []
    },
    revision: 1,
    kind: "capability",
    group: "modules"
  },
  withOverridable(clone(exampleWeatherModule), ["defaultPlace", "units"]),
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
          overridable: true,
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
    protected: true,
    kind: "capability",
    group: "modules"
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
    revision: 1,
    kind: "capability",
    group: "modules"
  },
  {
    id: "claude-subscription",
    name: "Claude subscription",
    description: "Claude through your Claude subscription (Claude Code). Off unless you opt in: the terms for this use are unclear.",
    enabled: false,
    state: "disabled",
    tools: [],
    settings: {
      fields: [
        {
          type: "boolean",
          key: "optIn",
          label: "Use my Claude subscription",
          description: "Anthropic does not clearly allow other software to drive Claude Code with a subscription login; usage counts against your plan's limits. Off by default.",
          apply: "live",
          default: false,
          source: "default"
        },
        { type: "text", key: "model", label: "Model", description: "claude-haiku-5-5 (fastest), claude-sonnet-5-5 or claude-opus-5-5.", apply: "live", default: "claude-haiku-5-5", maxLength: 100, source: "default" },
        { type: "boolean", key: "speculate", label: "Start before I finish speaking", apply: "live", default: false, advanced: true, source: "default" }
      ],
      values: { optIn: false, model: "claude-haiku-5-5", speculate: false },
      secrets: {},
      errors: []
    },
    revision: 1,
    protected: true,
    kind: "agent",
    group: "agents"
  },
  ...(scenario === "health" ? [clone(exampleUnavailableModule)] : []),
  // Protocol 10: records, text lists, a combo, an info value, buttons and module routes.
  demoHomeModule()
]

/** Protocol 9: the issue registry (`health`). */
const initialHealth = (): HealthInfo =>
  scenario === "health" ? { ...clone(exampleHealth), checkedAt: Date.now() - 120_000 } : { issues: [], checkedAt: Date.now(), checking: false }

const sherpa = { key: "STT_PROVIDER", in: ["sherpa"] }
const deepgram = { key: "STT_PROVIDER", in: ["deepgram"] }
const anthropic = { key: "LLM_PROVIDER", in: ["anthropic"] }

/** The assistant settings, placed on the settings screen like the real server's (`sectionDefinitions.ts`). */
const initialSections = (): Array<SettingsSection> => [
  {
    id: "language-model",
    title: "Provider",
    group: "agents",
    page: { id: "provider", title: "Provider", description: "Who answers you." },
    order: 10,
    protected: true,
    form: {
      fields: [
        {
          type: "choice",
          key: "LLM_PROVIDER",
          label: "Language model",
          apply: "reload",
          default: "fake",
          source: "saved",
          options: [
            { value: "fake", label: "Offline stand-in", description: "Echoes what you say and answers time questions.", tags: ["local"], implication: "No language model: the replies are canned." },
            { value: "anthropic", label: "Claude API", description: "The Anthropic API with your own API key, billed per use.", tags: ["hosted", "needs-key"], implication: "What you say is sent to Anthropic." },
            {
              value: "claude-subscription",
              label: "Claude subscription",
              description: "Claude Code with your own Claude login on this machine; replies count against your plan's limits.",
              tags: ["hosted", "experimental"],
              implication: "What you say is sent to Anthropic through Claude Code.",
              module: { id: "claude-subscription", optIn: "optIn" }
            }
          ]
        },
        { type: "secret", key: "ANTHROPIC_API_KEY", label: "Anthropic API key", apply: "reload", env: "ANTHROPIC_API_KEY", source: "env-file", locked: { reason: `Set by ANTHROPIC_API_KEY in ${ENV_FILE}, line 3`, file: ENV_FILE, line: 3 }, visibleWhen: anthropic },
        { type: "text", key: "ANTHROPIC_MODEL", label: "Model", apply: "reload", default: "claude-haiku-5-5", source: "env-process", locked: { reason: "Set by ANTHROPIC_MODEL in the environment" }, visibleWhen: anthropic },
        {
          type: "choice",
          key: "ANTHROPIC_EFFORT",
          label: "Effort",
          apply: "reload",
          default: "low",
          advanced: true,
          source: "default",
          visibleWhen: anthropic,
          options: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium", tags: ["slow-start"] }, { value: "high", label: "High", tags: ["slow-start"] }]
        },
        { type: "text", key: "ANTHROPIC_BASE_URL", label: "API address", description: "Only for a proxy or gateway in front of the Anthropic API.", apply: "reload", default: "https://api.anthropic.com", maxLength: 300, advanced: true, source: "default", visibleWhen: anthropic }
      ],
      values: { LLM_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-haiku-5-5", ANTHROPIC_EFFORT: "low", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      secrets: { ANTHROPIC_API_KEY: { set: true, source: "env" } },
      errors: []
    },
    revision: 1
  },
  {
    id: "llm-behaviour",
    title: "Behaviour",
    group: "agents",
    page: { id: "behaviour", title: "Behaviour", description: "How the language model talks." },
    order: 20,
    form: {
      fields: [
        { type: "text", key: "SYSTEM_PROMPT", label: "System prompt", description: "How the assistant behaves. Applies from the next turn.", apply: "live", default: "You are a concise, friendly voice assistant.", multiline: true, maxLength: 4000, source: "default" },
        { type: "number", key: "MAX_TOOL_ROUNDS", label: "Tool rounds per turn", apply: "reload", default: 4, integer: true, min: 1, max: 10, step: 1, advanced: true, source: "default" }
      ],
      values: { SYSTEM_PROMPT: "You are a concise, friendly voice assistant.", MAX_TOOL_ROUNDS: 4 },
      secrets: {},
      errors: []
    },
    revision: 1
  },
  {
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
          source: "default",
          options: [
            { value: "sherpa", label: "On this machine", tags: ["local"], implication: "Your voice never leaves this machine." },
            { value: "deepgram", label: "Deepgram", description: "Deepgram Flux over the internet. Its key is on the Deepgram page.", tags: ["hosted", "needs-key"], implication: "What you say is sent to Deepgram." }
          ]
        },
        {
          type: "choice",
          key: "STT_SHERPA_MODEL",
          label: "Speech recognition model",
          description: "Accurate models read the whole sentence once you pause; streaming models show words while you talk.",
          apply: "reload",
          default: "parakeet-v2",
          source: "default",
          visibleWhen: sherpa,
          options: [
            { value: "parakeet-v2", label: "Parakeet v2 — English, most accurate", tags: ["local"], description: "Reads the whole sentence once you pause; no live words.", download: { tool: "stt-models", target: "parakeet-v2", sizeMb: 484 } },
            { value: "nemotron-320", label: "Nemotron 320 ms — live words", tags: ["local"], download: { tool: "stt-models", target: "nemotron-320", sizeMb: 477 } },
            { value: "whisper-turbo", label: "Whisper turbo — 99 languages", tags: ["local", "not-downloaded"], description: "Robust in noise, slower. Not downloaded yet (565 MB).", download: { tool: "stt-models", target: "whisper-turbo", sizeMb: 565 } },
            { value: "parakeet-ultra", label: "Parakeet Ultra — multilingual", tags: ["local", "not-downloaded"], download: { tool: "stt-models", target: "parakeet-ultra", sizeMb: 489 } },
            { value: "zipformer-en", label: "Zipformer — small, fast", tags: ["local"], download: { tool: "stt-models", target: "zipformer-en", sizeMb: 312 } }
          ]
        },
        {
          type: "choice",
          key: "STT_SHERPA_LANGUAGE",
          label: "Language",
          apply: "reload",
          default: "auto",
          source: "default",
          visibleWhen: { all: [sherpa, { key: "STT_SHERPA_MODEL", in: ["whisper-turbo", "nemotron-320"] }] },
          options: [{ value: "auto", label: "Automatic" }, { value: "en", label: "English" }, { value: "nl", label: "Dutch" }]
        }
      ],
      values: { STT_PROVIDER: "sherpa", STT_SHERPA_MODEL: "parakeet-v2", STT_SHERPA_LANGUAGE: "auto" },
      secrets: {},
      errors: []
    },
    revision: 1
  },
  {
    id: "stt-timing",
    title: "Turn timing",
    group: "speech",
    page: { id: "turn-timing", title: "Turn timing", description: "When your turn ends and a reply may start." },
    order: 20,
    visibleWhen: sherpa,
    form: {
      fields: [
        { type: "number", key: "STT_SHERPA_EAGER_SILENCE_MS", label: "Early guess after", apply: "reload", default: 250, integer: true, min: 50, max: 2000, step: 10, unit: "ms", source: "default" },
        { type: "number", key: "STT_SHERPA_FINAL_SILENCE_MS", label: "End of turn after", apply: "reload", default: 600, integer: true, min: 100, max: 3000, step: 10, unit: "ms", source: "default" },
        { type: "number", key: "STT_SHERPA_VAD_THRESHOLD", label: "Voice threshold", apply: "reload", default: 0.5, integer: false, min: 0.05, max: 0.95, step: 0.05, advanced: true, source: "default" }
      ],
      values: { STT_SHERPA_EAGER_SILENCE_MS: 250, STT_SHERPA_FINAL_SILENCE_MS: 600, STT_SHERPA_VAD_THRESHOLD: 0.5 },
      secrets: {},
      errors: []
    },
    revision: 1
  },
  {
    id: "stt-deepgram",
    title: "Deepgram",
    group: "speech",
    page: { id: "deepgram", title: "Deepgram", description: "Hosted speech recognition (Deepgram Flux)." },
    order: 40,
    visibleWhen: deepgram,
    protected: true,
    form: {
      fields: [
        { type: "secret", key: "DEEPGRAM_API_KEY", label: "Deepgram API key", apply: "reload", env: "DEEPGRAM_API_KEY", source: "default" },
        { type: "number", key: "DEEPGRAM_EOT_THRESHOLD", label: "End-of-turn confidence", apply: "reload", default: 0.7, integer: false, min: 0.5, max: 1, step: 0.05, source: "default" }
      ],
      values: { DEEPGRAM_EOT_THRESHOLD: 0.7 },
      secrets: { DEEPGRAM_API_KEY: { set: false, source: "none" } },
      errors: []
    },
    revision: 1
  },
  { ...clone(exampleVoiceSection), group: "voices", page: { id: "overview", title: "Voices", description: "Which voice the assistant speaks with." }, order: 10 },
  {
    // docs/VOICE-PROVIDERS.md §6.1 (was "voice-engines"; TTS_PROVIDER is gone: the provider follows from the voice).
    id: "voice-providers",
    title: "Voice providers",
    group: "voices",
    page: { id: "providers", title: "Voice providers", description: "Where the voices come from: this machine, and the hosted voice services." },
    order: 20,
    protected: true,
    form: {
      fields: [
        { type: "secret", key: "CARTESIA_API_KEY", label: "Cartesia API key", description: "For Cartesia voices: listing them, previews, and speaking with one.", apply: "reload", env: "CARTESIA_API_KEY", source: "default" },
        { type: "secret", key: "ELEVENLABS_API_KEY", label: "ElevenLabs API key", description: "For ElevenLabs voices: listing them, previews, and speaking with one.", apply: "reload", env: "ELEVENLABS_API_KEY", source: "saved" }
      ],
      values: {},
      secrets: { CARTESIA_API_KEY: { set: false, source: "none" }, ELEVENLABS_API_KEY: { set: true, source: "store" } },
      errors: []
    },
    revision: 1
  },
  {
    // Protocol 6 (docs/VOICE-SESSIONS.md): voice sessions and conversations.
    id: "conversations",
    title: "Conversations",
    group: "agents",
    page: { id: "conversations", title: "Conversations", description: "How long a conversation lasts, and how many devices may talk at once." },
    order: 30,
    form: {
      fields: [
        { type: "number", key: "CONVERSATION_IDLE_MINUTES", label: "Start a new conversation after", description: "Minutes without a turn after which the next thing said starts a fresh conversation. 0 = never. An assistant's own setting wins.", apply: "live", default: DEFAULT_CONVERSATION_IDLE_MINUTES, integer: true, min: 0, max: 240, step: 1, unit: "min", source: "default" },
        { type: "number", key: "MAX_VOICE_SESSIONS", label: "Devices talking at once", description: "One more device is refused until one of them is done.", apply: "live", default: DEFAULT_MAX_VOICE_SESSIONS, integer: true, min: 1, max: 16, step: 1, source: "default" },
        { type: "number", key: "SESSION_DISCARD_MINUTES", label: "Forget a device's conversation after", description: "Minutes without any open page on that device.", apply: "live", default: DEFAULT_SESSION_DISCARD_MINUTES, integer: true, min: 1, max: 1440, step: 1, unit: "min", advanced: true, source: "default" }
      ],
      values: { CONVERSATION_IDLE_MINUTES: DEFAULT_CONVERSATION_IDLE_MINUTES, MAX_VOICE_SESSIONS: DEFAULT_MAX_VOICE_SESSIONS, SESSION_DISCARD_MINUTES: DEFAULT_SESSION_DISCARD_MINUTES },
      secrets: {},
      errors: []
    },
    revision: 1
  },
  {
    // Protocol 7 (docs/ASSISTANTS.md §2.4, WP-12a): where the house is. Modules and every assistant's prompt use it.
    id: "home",
    title: "Home",
    group: "modules",
    page: { id: "home", title: "Home", description: "Where the house is. Modules and every assistant's prompt use these." },
    order: 5,
    form: {
      fields: [
        { type: "text", key: "HOME_LOCATION", label: "Location", description: "Town and country, e.g. \"Amsterdam, Netherlands\". Every assistant is told; the weather uses it when you name no place.", apply: "live", default: "", placeholder: "Amsterdam, Netherlands", maxLength: 200, source: "default" },
        { type: "text", key: "HOME_TIME_ZONE", label: "Time zone", description: "IANA name, e.g. Europe/Amsterdam (not an offset such as +01:00). Empty: this machine's zone.", apply: "live", default: "", placeholder: "Europe/Amsterdam", maxLength: 64, source: "default" },
        {
          type: "choice",
          key: "HOME_LANGUAGE",
          label: "Language",
          description: "The household's language, told to every assistant.",
          apply: "live",
          default: "en-GB",
          options: [{ value: "en-GB", label: "English (United Kingdom)" }, { value: "en-US", label: "English (United States)" }, { value: "nl-NL", label: "Dutch (Netherlands)" }, { value: "de-DE", label: "German (Germany)" }],
          source: "default"
        },
        {
          type: "choice",
          key: "HOME_UNITS",
          label: "Units",
          description: "The default of modules that measure (the weather), unless they or an assistant say otherwise.",
          apply: "live",
          default: "metric",
          options: [{ value: "metric", label: "Metric (°C, km/h)" }, { value: "imperial", label: "Imperial (°F, mph)" }],
          source: "default"
        },
        {
          type: "choice",
          key: "HOME_DATE_FORMAT",
          label: "Date format",
          description: "The default of modules that say dates (the clock), unless they or an assistant say otherwise.",
          apply: "live",
          default: "en-GB",
          options: [{ value: "en-GB", label: "13 November 2026" }, { value: "en-US", label: "November 13, 2026" }, { value: "nl-NL", label: "13 november 2026" }],
          source: "default"
        },
        { type: "text", key: "HOME_CURRENCY", label: "Currency", description: "Three-letter code of the household's money, e.g. EUR, USD, GBP (any three capital letters are accepted; use the ISO 4217 code). The default of modules that handle prices.", apply: "live", default: "EUR", placeholder: "EUR", maxLength: 3, source: "default" },
        {
          type: "choice",
          key: "HOME_CUP_SIZE",
          label: "Cup size",
          description: "How big \"a cup\" is in recipes and shopping lists.",
          apply: "live",
          default: "metric",
          options: [{ value: "metric", label: "Metric cup (250 ml)" }, { value: "us", label: "US cup (236.6 ml)" }],
          source: "default"
        },
        { type: "text", key: "HOME_API_CONTACT", label: "API contact", description: "An email address or web address put in the User-Agent of requests to public web services that ask who is calling. Empty: none is sent.", apply: "live", default: "", placeholder: "you@example.com", maxLength: 200, source: "default" }
      ],
      values: { HOME_LOCATION: "", HOME_TIME_ZONE: "", HOME_LANGUAGE: "en-GB", HOME_UNITS: "metric", HOME_DATE_FORMAT: "en-GB", HOME_CURRENCY: "EUR", HOME_CUP_SIZE: "metric", HOME_API_CONTACT: "" },
      secrets: {},
      errors: []
    },
    revision: 1
  },
  {
    // Protocol 11 (docs/MODULES-PLAN.md §4 P5): the household's people and diets. A person's id is made by the server
    // when the person is added (hidden in the record); removing someone clears every device's default person there.
    id: "members",
    title: "Members",
    group: "modules",
    page: { id: "members", title: "Members", description: "The people who live here, and what they eat. A device's default person (Devices › a device › Place) says whose data a turn there means." },
    order: 6,
    form: {
      fields: [
        {
          type: "records",
          key: "HOUSEHOLD_MEMBERS",
          label: "People",
          description: "Each person's name, other names, and diet. A device points at one of them as its default person; removing someone clears that, and ends the session on every device (its pages reconnect and start a new conversation). Their stored data stays in the household database but is shown and told nowhere any more.",
          apply: "live",
          default: [],
          itemFields: [
            { type: "text", key: "id", label: "Id", default: "", maxLength: 40, hidden: true },
            { type: "text", key: "name", label: "Name", description: "As the household says it: \"Sam\".", default: "", maxLength: 60, placeholder: "Sam" },
            { type: "textList", key: "aliases", label: "Also called", description: "Other names people use for them: \"Sammie\", \"Mum\".", default: [], maxItems: 10, itemMaxLength: 40 },
            { type: "text", key: "pronunciation", label: "Pronunciation", description: "How the voice should say the name, spelled as it sounds (\"Shiv-awn\"). Empty: as written.", default: "", maxLength: 60 },
            { type: "textList", key: "allergies", label: "Allergies", description: "Never in their food: \"nuts\", \"shellfish\". Empty: the household's.", default: [], maxItems: 30, itemMaxLength: 60, placeholder: "nuts" },
            { type: "textList", key: "diets", label: "Diets", description: "\"vegetarian\", \"halal\". Empty: the household's.", default: [], maxItems: 30, itemMaxLength: 60, placeholder: "vegetarian" },
            { type: "textList", key: "dislikes", label: "Dislikes", description: "Left out where possible: \"coriander\". Empty: the household's.", default: [], maxItems: 30, itemMaxLength: 60, placeholder: "coriander" }
          ],
          itemLabel: "person",
          titleKey: "name",
          maxItems: 24,
          orderable: false,
          source: "default"
        },
        { type: "textList", key: "HOUSEHOLD_DIET_ALLERGIES", label: "Household allergies", description: "For everyone who has none of their own: what the kitchen never suggests.", apply: "live", default: [], maxItems: 30, itemMaxLength: 60, placeholder: "nuts", source: "default" },
        { type: "textList", key: "HOUSEHOLD_DIET_DIETS", label: "Household diets", description: "For everyone who has none of their own.", apply: "live", default: [], maxItems: 30, itemMaxLength: 60, placeholder: "vegetarian", source: "default" },
        { type: "textList", key: "HOUSEHOLD_DIET_DISLIKES", label: "Household dislikes", description: "For everyone who has none of their own.", apply: "live", default: [], maxItems: 30, itemMaxLength: 60, placeholder: "coriander", source: "default" }
      ],
      values: {
        HOUSEHOLD_MEMBERS: seededDeviceScenario()
          ? [
            { id: SAM_ID, name: "Sam", aliases: ["Sammie"], pronunciation: "", allergies: ["nuts"], diets: [], dislikes: ["coriander"] },
            { id: "p-robin0002", name: "Robin", aliases: [], pronunciation: "", allergies: [], diets: ["vegetarian"], dislikes: [] }
          ]
          : [],
        HOUSEHOLD_DIET_ALLERGIES: [],
        HOUSEHOLD_DIET_DIETS: [],
        HOUSEHOLD_DIET_DISLIKES: []
      },
      secrets: {},
      errors: []
    },
    revision: 1
  },
  {
    // P8: the household's risk policy, as the server declares it (`riskSection` in sectionDefinitions.ts): money and
    // security fixed at Refuse (locked with the reason). Saves are checked with the server's own `riskPolicyValueProblem`.
    id: "risk",
    title: "Risk policy",
    group: "modules",
    page: { id: "risk", title: "Risk policy", description: "What the assistant may do on its own, for every assistant on every device. A refused call is not run; the assistant says why." },
    order: 7,
    protected: true,
    form: {
      fields: [
        ...(["read", "change", "message"] as const).map((cls) => ({
          type: "choice" as const,
          key: RISK_POLICY_KEYS[cls],
          label: riskPageTexts("en").classes[cls],
          description: cls === "read"
            ? "Lookups that change nothing: the weather, what is on a list, the time."
            : cls === "change"
            ? "Lights, timers, lists, reminders, speaking or ringing on the house's own devices."
            : "Mail, chat or a call to people outside the house, or anything in your name on an outside channel. No module sends one yet.",
          apply: "live" as const,
          default: DEFAULT_RISK_POLICY[cls],
          options: [
            { value: "allow", label: riskPageTexts("en").outcomes.allow, description: "The assistant does it." },
            { value: "confirm", label: riskPageTexts("en").outcomes.confirm, description: "Refused, saying it needs your confirmation: the assistant cannot ask for it yet." },
            { value: "deny", label: riskPageTexts("en").outcomes.deny, description: "Refused, saying this household does not allow it." }
          ],
          source: "default" as const
        })),
        ...FIXED_RISK_CLASSES.map((cls) => ({
          type: "choice" as const,
          key: RISK_POLICY_KEYS[cls],
          label: riskPageTexts("en").classes[cls],
          description: cls === "money" ? "Purchases and payments." : "Unlocking, disarming, opening a garage door or a gate.",
          apply: "live" as const,
          default: "deny",
          options: [{ value: "deny", label: riskPageTexts("en").outcomes.deny }],
          locked: { reason: FIXED_REASON },
          source: "default" as const
        }))
      ],
      values: { RISK_READ: "allow", RISK_CHANGE: "allow", RISK_MESSAGE: "confirm", RISK_MONEY: "deny", RISK_SECURITY: "deny" },
      secrets: {},
      errors: []
    },
    revision: 1
  },
  {
    // Protocol 7 (WP-14): TypeSafe routes a sentence without a wake phrase. Off by default; hosted.
    id: "routing",
    title: "TypeSafe",
    description: "TypeSafe's Jev model picks which assistant on a device a sentence without a wake phrase is for, from each assistant's Handles line.",
    group: "agents",
    page: { id: "routing", title: "Routing", description: "Who a sentence is for, when no wake phrase was said. Used only on devices that let TypeSafe decide." },
    order: 40,
    protected: true,
    form: {
      fields: [
        {
          type: "boolean",
          key: "TYPESAFE_ROUTING",
          label: "Let TypeSafe choose the assistant",
          description: "Hosted and optional. What is sent: the sentence as text and the Handles line of each assistant on that device. A wake phrase always wins and skips TypeSafe; so does the next sentence within an assistant's follow-up time. It adds a delay before the reply starts, only for sentences without a phrase (see Diagnostics › Latency, Routing).",
          apply: "live",
          default: false,
          source: "default"
        },
        { type: "secret", key: "TYPESAFE_API_KEY", label: "TypeSafe API key", description: "From console.typesafe.ai/keys. Kept in the vault. Without it, devices set to \"The one that fits\" answer nobody without a phrase.", apply: "live", env: "TYPESAFE_API_KEY" },
        { type: "text", key: "TYPESAFE_MODEL", label: "Model", description: "A pinned version: the decision thresholds are tuned for one version, and jev-latest moves.", apply: "live", default: "jev-1.14.0", maxLength: 100, source: "default" },
        { type: "text", key: "TYPESAFE_BASE_URL", label: "Server address", description: "Any server that speaks /v1/systemone.", apply: "live", default: "https://api.typesafe.ai", advanced: true, source: "default" }
      ],
      values: { TYPESAFE_ROUTING: false, TYPESAFE_MODEL: "jev-1.14.0", TYPESAFE_BASE_URL: "https://api.typesafe.ai" },
      secrets: { TYPESAFE_API_KEY: { set: false, source: "none" } },
      errors: []
    },
    revision: 1
  },
  {
    // Protocol 7 (WP-13b): the OpenRouter key and the home model's address, as the real server's section has them.
    id: "llm-openai-accounts",
    title: "OpenRouter and home model",
    description: "Language models over the OpenAI-compatible API: OpenRouter with your key, or a server on your own network.",
    group: "agents",
    page: { id: "openai-accounts", title: "OpenRouter and home model", description: "The OpenRouter key and the address of a model server on your network." },
    order: 15,
    protected: true,
    form: {
      fields: [
        { type: "secret", key: "OPENROUTER_API_KEY", label: "OpenRouter API key", description: "From openrouter.ai/keys. Kept in the vault. What you say is sent to OpenRouter and the model's provider.", apply: "live", env: "OPENROUTER_API_KEY" },
        { type: "boolean", key: "OPENROUTER_SORT_BY_LATENCY", label: "Prefer the fastest provider", description: "Ask OpenRouter to route to the provider with the lowest latency for the model.", apply: "live", default: true, advanced: true, source: "default" },
        { type: "text", key: "OPENROUTER_BASE_URL", label: "OpenRouter address", description: "Only for a proxy or gateway in front of OpenRouter. Empty: https://openrouter.ai/api/v1.", apply: "live", default: "", placeholder: "https://openrouter.ai/api/v1", advanced: true, source: "default" },
        { type: "text", key: "HOME_MODEL_BASE_URL", label: "Home model server address", description: "Ollama, llama.cpp, LM Studio, vLLM or any server with the OpenAI-compatible API. http://host:port is enough; /v1 is added. What you say stays on your network.", apply: "live", default: "", placeholder: "http://192.168.1.20:11434", source: "default" },
        { type: "secret", key: "HOME_MODEL_API_KEY", label: "Home model API key", description: "Only if the server was started with a key (llama.cpp --api-key, vLLM --api-key). Kept in the vault.", apply: "live", env: "HOME_MODEL_API_KEY" }
      ],
      values: { OPENROUTER_SORT_BY_LATENCY: true, OPENROUTER_BASE_URL: "", HOME_MODEL_BASE_URL: "" },
      secrets: { OPENROUTER_API_KEY: { set: false, source: "none" }, HOME_MODEL_API_KEY: { set: false, source: "none" } },
      errors: []
    },
    revision: 1
  },
  {
    id: "recordings",
    title: "Recordings",
    group: "diagnostics",
    page: { id: "recordings", title: "Recordings", description: "Save what the assistant hears, to find out why it mishears." },
    order: 10,
    form: {
      fields: [
        { type: "boolean", key: "RECORD_HEARD_AUDIO", label: "Save what the assistant hears", apply: "live", default: false, source: "default" },
        { type: "number", key: "RECORD_HEARD_AUDIO_MAX_FILES", label: "Recordings kept", apply: "live", default: 50, integer: true, min: 1, max: 500, advanced: true, source: "default", visibleWhen: { key: "RECORD_HEARD_AUDIO", in: [true] } }
      ],
      values: { RECORD_HEARD_AUDIO: false, RECORD_HEARD_AUDIO_MAX_FILES: 50 },
      secrets: {},
      errors: []
    },
    revision: 1
  }
]

/** Every section's value of `key` (keys are global), and whether a secret is set. */
/**
 * P8, as the real gateway decides a press (a notification's action, a presentation's tick or button): the saved policy
 * through the shared decoder, `decideRisk` with the handler's class (the mock's handlers declare none: `change`), and on
 * a refusal the policy's spoken sentence in the household's language. `undefined`: allowed.
 */
const mockPressRefusal = (): string | undefined =>
  riskSpoken(riskLanguageOf(valueOf("HOME_LANGUAGE")), decideRisk(decodeRiskPolicy((key) => valueOf(key)), ["change"], "change"))

const valueOf = (key: string, list: ReadonlyArray<SettingsSection> = sections): unknown => {
  for (const x of list) if (Object.hasOwn(x.form.values, key)) return x.form.values[key]
  return undefined
}
const secretSet = (key: string, list: ReadonlyArray<SettingsSection> = sections) => list.some((x) => x.form.secrets[key]?.set === true)
const holds = (c: Condition | undefined, lookup: (key: string) => unknown) =>
  c === undefined || ("all" in c ? c.all.every((x) => x.in.includes(lookup(x.key) as never)) : "any" in c ? c.any.some((x) => x.in.includes(lookup(x.key) as never)) : c.in.includes(lookup(c.key) as never))

/** The cross-field checks of the real server, per section (an error refuses a save; a warning asks first). */
const checks = (list: ReadonlyArray<SettingsSection>): { errors: Array<FieldError & { section: string }>; warnings: Array<FieldError & { section: string }> } => {
  const v = (key: string) => valueOf(key, list)
  const errors: Array<FieldError & { section: string }> = []
  const warnings: Array<FieldError & { section: string }> = []
  if (Number(v("STT_SHERPA_FINAL_SILENCE_MS")) <= Number(v("STT_SHERPA_EAGER_SILENCE_MS"))) {
    errors.push({ section: "stt-timing", key: "STT_SHERPA_FINAL_SILENCE_MS", message: `Must be longer than the early guess (${String(v("STT_SHERPA_EAGER_SILENCE_MS"))} ms).` })
  }
  if (v("STT_PROVIDER") === "deepgram" && !secretSet("DEEPGRAM_API_KEY", list)) {
    warnings.push({ section: "stt-engine", key: "STT_PROVIDER", message: "Deepgram is chosen but there is no Deepgram key: speech recognition fails until you add it on the Deepgram page." })
  }
  if (v("LLM_PROVIDER") === "anthropic" && !secretSet("ANTHROPIC_API_KEY", list)) {
    warnings.push({ section: "language-model", key: "ANTHROPIC_API_KEY", message: "The Claude API is chosen but there is no API key: replies fail until you add it here." })
  }
  if (v("TYPESAFE_ROUTING") === true && !secretSet("TYPESAFE_API_KEY", list)) {
    warnings.push({ section: "routing", key: "TYPESAFE_API_KEY", message: "TypeSafe is switched on but there is no API key: devices set to \"The one that fits\" answer nobody without a phrase until you add it." })
  }
  // ASSISTANT_VOICE (docs/VOICE-PROVIDERS.md §6.1): a hosted voice without its key warns; a voice on this machine
  // that is not downloaded refuses the save.
  const voice = parseVoiceKey(String(v("ASSISTANT_VOICE") ?? ""))
  const provider = voice === undefined ? undefined : MOCK_PROVIDERS.find((p) => p.id === voice.provider)
  if (voice !== undefined && provider?.keyField !== undefined && !secretSet(provider.keyField, list)) {
    warnings.push({ section: "voices", key: "ASSISTANT_VOICE", message: `This voice speaks through ${provider.label}, but there is no ${provider.label} key: add it on the Voice providers page.` })
  }
  if (voice !== undefined && provider?.location === "local" && !presetInstalled(voice.voiceId)) {
    const name = provider.voices.find((x) => x.voiceId === voice.voiceId)?.name ?? voice.voiceId
    errors.push({ section: "voices", key: "ASSISTANT_VOICE", message: `${name} is not downloaded: download it first, or choose a voice that is.` })
  }
  return { errors, warnings }
}

/**
 * The real server's voice check on `assistant.create` (docs/LOOKS-AND-VOICES.md §5.0), its warning half: a hosted
 * voice whose provider has no key asks for `saveAnyway` (a copy of an assistant with such a voice too). The mock's
 * `assistant.save` does not check the voice.
 */
const assistantVoiceWarning = (voice: { readonly provider: string; readonly voiceId: string }, saveAnyway: boolean) => {
  if (saveAnyway) return undefined
  const provider = MOCK_PROVIDERS.find((p) => p.id === voice.provider)
  if (provider?.keyField === undefined || secretSet(provider.keyField)) return undefined
  const message = `${provider.label} has no API key yet, so this voice cannot speak.`
  return { code: "invalid_settings" as const, message: `${message} Save anyway to keep it.`, warnings: [{ key: "voice", message }] }
}

/** The sections with their forms' warnings for the saved values. */
const withWarnings = (list: Array<SettingsSection>): Array<SettingsSection> => {
  const { warnings } = checks(list)
  return list.map((x) => {
    const mine = warnings.filter((w) => w.section === x.id).map(({ key, message }) => ({ key, message }))
    const { warnings: _old, ...form } = x.form
    return { ...x, form: mine.length > 0 ? { ...form, warnings: mine } : form }
  })
}

/** The engines as the saved settings would build them (the language model follows LLM_PROVIDER). */
const readyEngine = (): EngineStatus => {
  const base = clone(exampleEngineStatus)
  const provider = String(valueOf("LLM_PROVIDER") ?? "anthropic")
  const sub = modules.find((m) => m.id === "claude-subscription")
  const model = String(sub?.settings.values.model ?? "claude-haiku-5-5")
  const detail = provider === "anthropic"
    ? String(valueOf("ANTHROPIC_MODEL") ?? "claude-haiku-5-5")
    : provider === "claude-subscription"
    ? sub?.state === "running" ? model : `${model} · module ${sub?.enabled === true ? sub.state : "off"}: the offline stand-in answers`
    : "offline stand-in"
  // The voice stage follows ASSISTANT_VOICE: one voice, `name` its key, `description` its name.
  const key = assistantVoiceKey()
  const ref = parseVoiceKey(key) ?? { provider: "sherpa", voiceId: "en_US-lessac-medium" }
  const p = MOCK_PROVIDERS.find((x) => x.id === ref.provider) ?? MOCK_PROVIDERS[0]!
  const location = p.location
  return {
    ...base,
    reloadPendingFor: [],
    engines: base.engines.map((e) =>
      e.stage === "llm" ? { ...e, provider, detail, location: provider === "fake" ? "local" : "hosted" }
      : e.stage === "tts" ? { ...e, provider: ref.provider, detail: ref.voiceId, location }
      : e
    ),
    voices: [{ name: key, description: p.voices.find((x) => x.voiceId === ref.voiceId)?.name ?? ref.voiceId, enabled: true, isDefault: true, engine: p.engine(ref.voiceId), location }]
  }
}
/** The assistant's voice as saved (ASSISTANT_VOICE), else the voice on this machine. */
const assistantVoiceKey = (): string => {
  const saved = String(valueOf("ASSISTANT_VOICE") ?? "").trim()
  return parseVoiceKey(saved) !== undefined ? saved : "sherpa:en_US-lessac-medium"
}
/** The voice the running engines speak with. */
const runningVoiceKey = (): string => engine.voices[0]?.name ?? assistantVoiceKey()
/** A voice key → its parts (split at the first colon). */
function parseVoiceKey(key: string): { provider: string; voiceId: string } | undefined {
  const i = key.indexOf(":")
  if (i <= 0) return undefined
  const provider = key.slice(0, i)
  const voiceId = key.slice(i + 1)
  return /^[a-z][a-z0-9-]{0,31}$/.test(provider) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(voiceId) ? { provider, voiceId } : undefined
}
/** Whether a voice model on this machine is downloaded (Voices › Models). */
function presetInstalled(id: string): boolean {
  return models.find((m) => m.tool === "tts-models")?.items.find((i) => i.id === id)?.installed === true
}
/** The Claude subscription module changed: the running engines say so when it is the language model. */
const refreshEngine = () => {
  if (engine.state !== "ready" || !engine.engines.some((e) => e.stage === "llm" && e.provider === "claude-subscription")) return
  const llm = readyEngine().engines.find((e) => e.stage === "llm")!
  engine = { ...engine, engines: engine.engines.map((e) => (e.stage === "llm" ? llm : e)) }
  broadcast({ type: "engine", engine })
}

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
  /** Protocol 5: what the page said it is in hello. */
  frontend: "voice" | "admin"
  /** The admin session this connection is logged in with. */
  session?: string | undefined
  /** The device this voice connection belongs to. */
  deviceId?: string
  /** The phrase tester is on until then (epoch ms). */
  testerUntil?: number | undefined
  /** Protocol 6: the device the tester follows; undefined = the most recently active session. */
  testerDevice?: string | undefined
  /** P10: what this connection's own page declared last (its hello, then `device.caps`): it is sent only those kinds. */
  ownCaps?: DeviceCapabilities | undefined
  /** Protocol 11: the page's live state (`device.caps.live`). */
  visible?: boolean
  lastInteractionAt?: number
}

interface Reply {
  readonly turnId: number
  readonly clauses: ReadonlyArray<{ readonly text: string; readonly startSample: number }>
  readonly endOfTurn: number
  readonly spoken: boolean
  readonly tools: Array<{ name: string; ms: number }>
  readonly source: "voice" | "text"
  readonly owner: Conn | undefined
  /** The voice session (device) the turn belongs to, and its conversation then. */
  readonly session: VSession
  readonly conversationId: string
  /** Protocol 7: the assistant answering, whose conversation the turn belongs to. */
  readonly assistantId: string | undefined
  playedClause: number
  started?: { at: number; outputLatencyMs: number; startDelayMs: number }
  lastReport: number
  timers: Array<ReturnType<typeof setTimeout>>
  stallTimer?: ReturnType<typeof setInterval>
  ended: boolean
  dropScheduled?: boolean
  /** Sent reply.stop and waiting (≤ 300 ms) for playback.stopped. */
  awaitingStop?: boolean
  /** The first `playback.stopped { exact: false }`: used only if no exact count comes within the stop's 300 ms. */
  provisional?: number
}

/**
 * Protocol 6 (docs/VOICE-SESSIONS.md): one voice session per device (the device id, or the client id of a voice page
 * without one): its own audio owner, state, conversation and reply. A record exists from the device's first
 * connection (its conversation is what the page shows), but it is *started* (counts against MAX_VOICE_SESSIONS, is
 * listed to admin) only at its first claim or typed message. Each starts with the example history.
 */
interface VSession {
  readonly key: string
  readonly deviceId: string | undefined
  started: boolean
  owner: Conn | undefined
  lastOwnerClientId: string | undefined
  state: AssistantState
  micLive: boolean
  history: Array<HistoryItem>
  conversation: ConversationInfo
  reply: Reply | undefined
  /** Committed turns in this conversation, and when the last one ended (epoch ms). */
  turns: number
  lastTurnAt: number | null
  lastActive: number
  /** Wake-phrase windows: the armed window after the phrase alone, the follow-up window after a reply. */
  awakeUntil: number
  /** The assistant the utterance being heard goes to (`runVoiceTurn`), and the `holder` the last `state` said. */
  hearingFor: string | undefined
  /** The timer that turns the utterance being heard into its turn (cleared when Stop or a new conversation cancels it). */
  hearingEnd: ReturnType<typeof setTimeout> | undefined
  holderSent: string | null
  awakeTimer: ReturnType<typeof setTimeout> | undefined
  discardTimer: ReturnType<typeof setTimeout> | undefined
}

const conns = new Set<Conn>()
let connSeq = 0
const voiceSessions = new Map<string, VSession>()
let conversationSeq = 0
let modules = initialModules()
// Reads the mock's vault each time (declared below): locked, tokens are neither listed nor changed.
const moduleRoutesMock = createModuleRoutesMock(() => vault.state === "locked")
/** P6: the scheduled jobs (as the real server's /api/scheduler/jobs). */
let scheduledJobsMock = createScheduledJobsMock()
/** Buttons whose press is running (`<module>/<key>`): a second press is `busy`, as on the host. */
const pressing = new Set<string>()
/** Protocol 7: assistants, device types and the devices' own sections (mock/assistants.ts). */
const assistantsMock = createAssistantsMock({
  modules: () => modules,
  toolNames: (id) => runningTools(id).map((t) => t.name),
  checkOwn: (id, own) => checkOwn(id, own),
  accountProblem: (account) => accountProblem(account),
  // Read when a device is saved: `sections` is set before any request arrives.
  isPerson: (id) => memberIds().has(id)
})
/** Protocol 7, the voice connection's side: the device's setup, a conversation per assistant, who has the turn (mock/voiceAssistants.ts). */
const voice = createVoiceAssistants(assistantsMock, () => newConversationInfo(), (deviceId) => speakerAllowedOf(deviceId))
/**
 * Protocol 11, as the server: reply audio is sent to a device only while its effective settings and its latest
 * declaration allow speech (`speakerAllowedFrom`, shared with the server); its setup's speaking flags follow it.
 */
const speakerAllowedOf = (deviceId: string | undefined): boolean =>
  speakerAllowedFrom(assistantsMock.deviceFields(deviceId ?? "").settings, deviceId === undefined ? undefined : devices.get(deviceId)?.declared?.capabilities)
/**
 * Protocol 11, as the server (`boundaryKey`, shared): what decides what each voice connection's device may be told or
 * sent, by session key. Taken before a save and compared after it: a session whose key changed is ended with its
 * connections (`CloseCode.settingsChanged`); every one when a person left Members.
 */
const boundaries = (): Map<string, string> => {
  const members = memberIds()
  const out = new Map<string, string>()
  const keys = new Set<string>([...voiceSessions.keys(), ...[...conns].flatMap((c) => (c.frontend === "voice" && keyOf(c) !== undefined ? [keyOf(c)!] : []))])
  for (const key of keys) {
    const deviceId = voiceSessions.get(key)?.deviceId ?? [...conns].find((c) => keyOf(c) === key)?.deviceId
    const known = deviceId !== undefined && devices.has(deviceId)
    const settings = assistantsMock.deviceFields(known ? deviceId! : "").settings
    out.set(key, known ? boundaryKey(settings, (id) => members.has(id)) : `unknown|${boundaryKey({ ...settings, place: { ...settings.place, defaultPerson: null } }, () => false)}`)
  }
  return out
}
/** End the sessions whose boundary changed since `before` (all of them: `everyone`). */
const endChangedSessions = (before: ReadonlyMap<string, string>, everyone = false) => {
  const after = boundaries()
  for (const [key, was] of before) {
    const now = after.get(key)
    if (!everyone && now === was) continue
    // A device not known before and known now (its first registration) is not a boundary.
    if (!everyone && was.startsWith("unknown|") && now !== undefined && !now.startsWith("unknown|")) continue
    const v = voiceSessions.get(key)
    if (v !== undefined) dropSession(v)
    for (const c of [...conns]) {
      if (c.frontend !== "voice" || keyOf(c) !== key) continue
      // Nothing more is sent on it from here on.
      c.welcomed = false
      conns.delete(c)
      mockHeld.delete(c.id)
      mockPresentHeld.delete(c.id)
      c.ws.close(CloseCode.settingsChanged, "settings changed")
    }
  }
}
/** The `wake` and `long-phrase` scenarios sleep until the phrase: saved on the web-voice type, as admin would. */
const seedVoiceScenario = () => {
  const patch = scenarioSettings(scenario, LONG_PHRASE)
  if (patch !== undefined) voice.saveSettings(undefined, patch)
}
// Before the sections: their checks look at which voice models are downloaded.
let models: Array<ModelSet> = initialModels()
let sections = withWarnings(initialSections())
let engine: EngineStatus = initialEngine()
let vault: { state: "none" | "locked" | "unlocked"; password?: string; lockReason?: "start" | "manual" } = scenario === "keys-locked"
  ? { state: "locked", password: VAULT_PASSWORD, lockReason: "start" }
  : { state: "none" }
let env: EnvInfo = initialEnv()
let jobs: Array<JobInfo> = []
let jobSeq = 0
const jobTimers = new Map<string, ReturnType<typeof setInterval>>()
let traces: Array<TraceInfo> = scenario === "latency" ? seedTraces() : []
let health: HealthInfo = initialHealth()
let turnSeq = 20
let scriptTimers: Array<ReturnType<typeof setTimeout>> = []
const clientLog: Array<Record<string, unknown>> = []

// ---- Admin sessions, front ends and devices (protocol 5)

const sessions = new Map<string, { expiresAt: number }>()
let loginFailures = 0
let loginRefusedUntil = 0
/** POST /mock/logout-fails {"on"}: the next admin.logout requests are refused (a failed log out). */
let logoutFails = false
const adminEnabled = () => scenario !== "admin-disabled"

interface DeviceRecord {
  id: string
  kind: string
  name: string
  firstSeen: number
  lastSeen: number
  /** Protocol 11: what it declared last (hello, `device.caps`). */
  declared?: DeclaredCapabilities
}
const HOUR = 3_600_000
/** The people of Members now (their ids). */
const memberIds = (): ReadonlySet<string> => {
  const value = sections.find((x) => x.id === "members")?.form.values.HOUSEHOLD_MEMBERS
  const ids: Array<string> = []
  for (const r of Array.isArray(value) ? value : []) {
    const id = typeof r === "object" && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>).id : undefined
    if (typeof id === "string") ids.push(id)
  }
  return new Set(ids)
}
/** The ids of people removed from Members since the scenario started (the server's `HOUSEHOLD_MEMBERS_RETIRED`). */
let retiredMemberIds = new Set<string>()
/**
 * Protocol 11, as the server (`withPersonIds`): an incoming id is kept only when it is a committed member's and not
 * retired, for the first row that carries it; every other row (a new person, a copied row, a stale tab's row of someone
 * removed, a made-up id) gets a fresh id, never a committed, retired or supplied one. In the patch itself.
 */
const withPersonIds = (patch: SettingsPatch) => {
  const list = patch.values.HOUSEHOLD_MEMBERS
  if (!Array.isArray(list)) return
  const committed = memberIds()
  const supplied = new Set(list.flatMap((r) => (typeof r === "object" && r !== null && !Array.isArray(r) && typeof (r as Record<string, unknown>).id === "string" ? [(r as Record<string, unknown>).id as string] : [])))
  const used = new Set<string>()
  const fresh = () => {
    for (;;) {
      const id = `p-${randomBytes(4).toString("hex")}`
      if (!committed.has(id) && !retiredMemberIds.has(id) && !supplied.has(id) && !used.has(id)) return id
    }
  }
  ;(patch.values as Record<string, SettingValue | null>).HOUSEHOLD_MEMBERS = list.map((r) => {
    if (typeof r !== "object" || r === null || Array.isArray(r)) return r
    const record = r as Record<string, unknown>
    const given = typeof record.id === "string" ? record.id : undefined
    const id = given !== undefined && committed.has(given) && !retiredMemberIds.has(given) && !used.has(given) ? given : fresh()
    used.add(id)
    return { ...record, id }
  }) as unknown as SettingValue
}
const seededDevices = (): Map<string, DeviceRecord> => {
  if (!seededDeviceScenario()) return new Map()
  const now = Date.now()
  return new Map([
    ...(scenario === "long-phrase"
      ? [["d-living-room-0003", { id: "d-living-room-0003", kind: WEB_VOICE_KIND, name: "Living room tablet", firstSeen: now - 20 * 24 * HOUR, lastSeen: now - 5 * 60_000 }] as [string, DeviceRecord]]
      : []),
    ["d-kitchen-ipad-0001", {
      id: "d-kitchen-ipad-0001",
      kind: WEB_VOICE_KIND,
      name: "Kitchen iPad",
      firstSeen: now - 40 * 24 * HOUR,
      lastSeen: now - 2 * HOUR,
      declared: {
        capabilities: { v: 1, display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 2, touch: "coarse", colour: true }, present: { kinds: {} }, speaker: { media: ["speech", "audio"] }, microphone: { farField: false } },
        seenAt: now - 2 * HOUR
      }
    }],
    ["d-pixel-phone-0002", {
      id: "d-pixel-phone-0002",
      kind: WEB_VOICE_KIND,
      name: "Android phone · Chrome",
      firstSeen: now - 9 * 24 * HOUR,
      lastSeen: now - 3 * 24 * HOUR,
      declared: {
        capabilities: { v: 1, display: { class: "compact", widthPx: 412, heightPx: 915, dpr: 2.63, touch: "coarse", colour: true }, present: { kinds: {} }, speaker: { media: ["speech", "audio"] }, microphone: { farField: false }, openUrl: true },
        seenAt: now - 3 * 24 * HOUR
      }
    }]
  ])
}
/** Six words: wake phrases may be this long (the UI must not cut or jump on them). */
const LONG_PHRASE = "hello my personal voice assistant please"
let devices = seededDevices()
seedVoiceScenario()

const deviceInfos = (): Array<DeviceListInfo> => {
  const now = Date.now()
  return [...devices.values()]
    .map((d) => {
      const open = [...conns].filter((c) => c.welcomed && c.deviceId === d.id)
      const connections = open.length
      const live = connections === 0 ? undefined : { visible: open.some((c) => c.visible !== false), ...(open.some((c) => c.lastInteractionAt !== undefined) ? { lastInteractionAt: Math.max(...open.map((c) => c.lastInteractionAt ?? 0)) } : {}) }
      return { ...d, lastSeen: connections > 0 ? now : d.lastSeen, connections, audioOwner: voiceSessions.get(d.id)?.owner !== undefined, ...assistantsMock.deviceFields(d.id), ...(live !== undefined ? { live } : {}) }
    })
    .sort((a, b) => b.lastSeen - a.lastSeen)
}
const isAdminConn = (c: Conn) => c.session !== undefined && sessions.has(c.session)
const adminState = (c: Conn, extra: Partial<AdminState> = {}): AdminState => {
  const wait = loginRefusedUntil - Date.now()
  return {
    enabled: adminEnabled(),
    loggedIn: isAdminConn(c),
    ...(wait > 0 ? { retryAfterMs: wait } : {}),
    ...(isAdminConn(c) ? { expiresAt: sessions.get(c.session!)!.expiresAt } : {}),
    ...extra
  }
}
const sendAdminSnapshot = (c: Conn) =>
  sendTo(c, {
    type: "admin.snapshot",
    snapshot: { engine, modules, sections, traces: traces.slice(-20), vault: vaultInfo(c), env, models, jobs, devices: deviceInfos(), sessions: sessionInfos(), assistants: assistantInfos(), deviceTypes: assistantsMock.deviceTypes(), health }
  })
const devicesChanged = () => broadcast({ type: "devices", devices: deviceInfos() })
const assistantInfos = () => assistantsMock.infos([...devices.values()].map((d) => ({ id: d.id, name: d.name })))
/** After an assistant or device save: the whole lists, as the real server pushes them (admin connections only). */
/** The routing section changed: "Whichever fits" is offered when it is on and has a key (the server's `canAuto`). */
/** As the real server: an account whose key or address is not set is a failed resource with this problem. */
const accountProblem = (account: string): string | undefined => {
  const x = sections.find((y) => y.id === "llm-openai-accounts")
  if (account === "openrouter" && x?.form.secrets.OPENROUTER_API_KEY?.set !== true) return "OpenRouter is not set up: add its API key in Shared settings › Language model accounts."
  const address = x?.form.values.HOME_MODEL_BASE_URL
  if (account === "home-model" && (typeof address !== "string" || address.trim() === "")) return "Home model is not set up: add the server address in Shared settings › Language model accounts."
  return undefined
}
const routingChanged = () => {
  const x = sections.find((y) => y.id === "routing")
  voice.setCanAuto(x?.form.values.TYPESAFE_ROUTING === true && x.form.secrets.TYPESAFE_API_KEY?.set === true)
  pushSetups()
}
const assistantsChanged = () => {
  syncCapabilities()
  broadcast({ type: "assistants", assistants: assistantInfos() })
  broadcast({ type: "device.types", types: assistantsMock.deviceTypes() })
  devicesChanged()
  pushSetups()
}
/** Each voice connection's setup, when it changed (never to admin connections); a session that is not in a turn settles. */
const lastSetup = new WeakMap<Conn, string>()
const pushSetups = () => {
  for (const c of conns) {
    if (!c.welcomed || c.frontend !== "voice") continue
    const setup = voice.setupFor(c.deviceId)
    const text = JSON.stringify(setup)
    if (lastSetup.get(c) === text) continue
    lastSetup.set(c, text)
    sendTo(c, { type: "device.setup", ...setup })
  }
  settleAll()
}
// ---- Voice sessions (protocol 6)

/** A voice connection's session key: its device, or its own client id; admin connections have none. */
const keyOf = (c: Conn): string | undefined => (c.frontend !== "voice" ? undefined : c.deviceId ?? c.clientId)
const newConversationInfo = (): ConversationInfo => ({ id: `conv-${++conversationSeq}-${Date.now().toString(36)}`, startedAt: Date.now() })
/** The session record of a voice connection, made on first use (not started yet). */
const sessionFor = (c: Conn): VSession | undefined => {
  const key = keyOf(c)
  if (key === undefined) return undefined
  let v = voiceSessions.get(key)
  if (v === undefined) {
    const now = Date.now()
    v = {
      key,
      deviceId: c.deviceId,
      started: false,
      owner: undefined,
      lastOwnerClientId: undefined,
      state: "idle",
      micLive: true,
      history: clone([...exampleSnapshot.history]),
      conversation: { id: `conv-${++conversationSeq}-${now.toString(36)}`, startedAt: now - 6 * 60_000 },
      reply: undefined,
      turns: exampleSnapshot.history.filter((h) => h.role === "user").length,
      lastTurnAt: now - 5 * 60_000,
      lastActive: now,
      awakeUntil: 0,
      hearingFor: undefined,
      hearingEnd: undefined,
      holderSent: null,
      awakeTimer: undefined,
      discardTimer: undefined
    }
    voiceSessions.set(key, v)
  }
  return v
}
const sessionName = (v: VSession) => (v.deviceId === undefined ? "A browser tab without a device id" : devices.get(v.deviceId)?.name ?? "A device")
const connsOf = (v: VSession) => [...conns].filter((c) => c.welcomed && keyOf(c) === v.key)
/**
 * Review round 3: the session is still the device's (not dropped). A delayed callback of a dropped session (a boundary
 * change, a discard) sends nothing, also not to its successor, which has the same key.
 */
const alive = (v: VSession) => voiceSessions.get(v.key) === v
/** A message about a session's turns: only to that device's connections, and only while it is the device's session. */
const toSession = (v: VSession, m: ServerMessage) => {
  if (!alive(v)) return
  for (const c of connsOf(v)) sendTo(c, m)
}
const startedSessions = () => [...voiceSessions.values()].filter((v) => v.started).sort((a, b) => b.lastActive - a.lastActive)
const ownerPresentIn = (v: VSession) => v.owner !== undefined || v.lastOwnerClientId === "c-another-tab"
const answeringOf = (v: VSession): string | undefined => {
  const settings = v.deviceId === undefined ? assistantsMock.deviceTypes()[0]?.settings : assistantsMock.deviceFields(v.deviceId).settings
  return settings === undefined ? undefined : hearerOf(settings) ?? undefined
}
const sessionInfos = (): Array<SessionInfo> =>
  startedSessions().map((v) => ({
    key: v.key,
    ...(v.deviceId === undefined ? {} : { deviceId: v.deviceId }),
    name: sessionName(v),
    state: v.state,
    ownerPresent: ownerPresentIn(v),
    conversationId: v.conversation.id,
    turns: v.turns,
    lastTurnAt: v.lastTurnAt,
    // Protocol 7: who answers on that device now, and one conversation per assistant on it.
    ...(answeringOf(v) === undefined ? {} : { answering: answeringOf(v)!, conversations: [{ assistantId: answeringOf(v)!, conversationId: v.conversation.id, turns: v.turns, lastTurnAt: v.lastTurnAt }] })
  }))
let lastSessions = ""
/** Admin connections get the list when it changed. */
const sessionsChanged = () => {
  const list = sessionInfos()
  const key = JSON.stringify(list)
  if (key === lastSessions) return
  lastSessions = key
  broadcast({ type: "sessions", sessions: list })
}
const numberSetting = (key: string, fallback: number) => {
  const v = valueOf(key)
  return typeof v === "number" ? v : fallback
}
/** Start a session at its first claim or typed message; `false`: refused, MAX_VOICE_SESSIONS are talking already. */
const startSession = (v: VSession): boolean => {
  v.lastActive = Date.now()
  if (v.started) return true
  const max = numberSetting("MAX_VOICE_SESSIONS", DEFAULT_MAX_VOICE_SESSIONS)
  // At the limit, the least recently active session whose device left makes room (as the server does).
  while (startedSessions().length >= max) {
    const gone = startedSessions().filter((x) => connsOf(x).length === 0).at(-1)
    if (gone === undefined) return false
    dropSession(gone)
  }
  v.started = true
  return true
}
const sessionsFull = () => ({ code: "sessions_full" as const, message: `The assistant is already talking on ${startedSessions().length} devices.` })
/** The session a test endpoint means: `deviceId`, else the most recently active one that talks, else any started. */
const targetSession = (deviceId?: unknown): VSession | undefined => {
  if (typeof deviceId === "string") return voiceSessions.get(deviceId)
  const started = startedSessions()
  return started.find((v) => v.owner !== undefined) ?? started[0]
}
/** Per conversation (`voice.convFor`): the turn whose exchange ends its history (`conversation.history.lastTurnId`). */
const lastTurnOf = new WeakMap<object, number>()
/** A new conversation on the session: the running turn stops, the history goes, every tab of the device is told. */
const newConversation = (v: VSession, reason: "new" | "idle", assistantId: string | undefined = voice.answeringOf(v, v.deviceId)) => {
  // Only the turn of this assistant's conversation stops; the other assistants keep theirs.
  if (v.reply !== undefined && v.reply.assistantId === assistantId) interruptReply(v.reply)
  if (reason === "new") cancelHearing(v, assistantId)
  const conv = voice.convFor(v, assistantId)
  conv.history = []
  lastTurnOf.delete(conv)
  conv.conversation = newConversationInfo()
  conv.turns = 0
  conv.lastTurnAt = null
  toSession(v, { type: "conversation", id: conv.conversation.id, reason, startedAt: conv.conversation.startedAt, ...(assistantId !== undefined ? { assistantId } : {}) })
  sessionsChanged()
}
/**
 * As the server: Stop, or a new conversation for the assistant (`undefined`: any) whose sentence is being heard,
 * cancels that sentence. No turn follows, and its assistant holds the turn no longer.
 */
const cancelHearing = (v: VSession, assistantId: string | undefined) => {
  if (v.hearingFor === undefined || (assistantId !== undefined && v.hearingFor !== assistantId)) return
  if (v.hearingEnd !== undefined) clearTimeout(v.hearingEnd)
  v.hearingEnd = undefined
  v.hearingFor = undefined
  setState(v, v.state === "hearing" && v.reply === undefined ? restingState(v) : v.state)
}
/** The session and its conversation go (discarded, or its place taken at the limit). */
const dropSession = (v: VSession) => {
  if (v.discardTimer !== undefined) clearTimeout(v.discardTimer)
  v.discardTimer = undefined
  if (v.reply !== undefined) clearReply(v.reply)
  if (v.awakeTimer !== undefined) clearTimeout(v.awakeTimer)
  // Its sentence being heard goes too (the scripted turn it would start).
  if (v.hearingEnd !== undefined) clearTimeout(v.hearingEnd)
  v.hearingEnd = undefined
  v.hearingFor = undefined
  voiceSessions.delete(v.key)
  sessionsChanged()
}
/** No connection left on the device: drop its session after SESSION_DISCARD_MINUTES. */
const scheduleDiscard = (v: VSession) => {
  if (v.discardTimer !== undefined) clearTimeout(v.discardTimer)
  v.discardTimer = setTimeout(() => {
    v.discardTimer = undefined
    if (connsOf(v).length > 0) return
    dropSession(v)
  }, numberSetting("SESSION_DISCARD_MINUTES", DEFAULT_SESSION_DISCARD_MINUTES) * 60_000)
}

/** Minutes of quiet after which the assistant's next turn starts a new conversation (its `newConversationAfter`; 0 = never). */
const idleMinutesOf = (assistantId: string | undefined): number => {
  const spell = assistantsMock.assistants().find((a) => a.id === assistantId)?.newConversationAfter
  return spell === undefined || spell === "never" ? 0 : spell
}
/**
 * The device sleeps until a phrase: nobody answers without one (protocol 7 `withoutPhrase: nobody`).
 */
const wakeMode = (v: VSession) => v.owner !== undefined && voice.sleeps(v.deviceId)
/** Keep the session awake (no phrase needed) for `ms`; then asleep again unless something is going on. */
const stayAwake = (v: VSession, ms: number) => {
  v.awakeUntil = Date.now() + ms
  if (v.awakeTimer !== undefined) clearTimeout(v.awakeTimer)
  v.awakeTimer = setTimeout(() => {
    v.awakeTimer = undefined
    // The window closed: nobody keeps the turn (a reply in flight keeps it; its end opens a window of its own).
    voice.setHolder(v, undefined)
    if (v.reply === undefined) setState(v, v.state === "listening" || v.state === "asleep" ? restingState(v) : v.state)
  }, ms + 20)
}
/**
 * A tester line from session `v` to admin connections that switched the tester on and follow that session (a device
 * id, or the most recently active session); without a session, to every tester. `accepted` defaults to what the
 * server's wake gate would say: matched a phrase, always listening, or inside an armed / follow-up window; `null`
 * leaves it out (an older server). `source`, as the real server sends it: the session's device and the assistant the
 * matched phrase belongs to there (its saved assignments); left out without a session, or with `source: null`
 * (an older server).
 */
const sendHeard = (v: VSession | undefined, text: string, matched?: string, accepted?: boolean | null, withSource = true) => {
  const now = Date.now()
  const taken = accepted === undefined ? matched !== undefined || v === undefined || !wakeMode(v) || v.awakeUntil > now : accepted
  const auto = targetSession()
  const source = v === undefined || !withSource ? undefined : heardSource(v, matched)
  for (const c of conns) {
    if (!c.welcomed || !isAdminConn(c) || c.testerUntil === undefined || c.testerUntil < now) continue
    if (v !== undefined && (c.testerDevice === undefined ? auto !== v : c.testerDevice !== v.deviceId)) continue
    sendTo(c, {
      type: "wake.heard",
      text,
      ...(matched === undefined ? {} : { matched }),
      ...(taken === null ? {} : { accepted: taken }),
      ...(source === undefined ? {} : { source }),
      at: now
    })
  }
}
/** Where a tester line was heard: the session's device, and whose phrase it matched there (like `RouteGate`'s `heard`). */
const heardSource = (v: VSession, matched: string | undefined): { deviceId?: string; assistantId?: string } => {
  const settings = v.deviceId === undefined ? assistantsMock.deviceTypes()[0]?.settings : assistantsMock.deviceFields(v.deviceId).settings
  const key = matched === undefined ? "" : phraseKey(matched)
  const who = key === "" || settings === undefined ? undefined : settings.assistants.find((a) => a.phrases.some((p) => phraseKey(p) === key))?.assistant
  return { ...(v.deviceId === undefined ? {} : { deviceId: v.deviceId }), ...(who === undefined ? {} : { assistantId: who }) }
}
/** The session's owner said the wake phrase. */
const wakeUp = (v: VSession, phrase: string, armed: boolean, assistantId: string | undefined = voice.phraseOwner(v.deviceId, phrase)) => {
  toSession(v, { type: "wake", phrase, armed, ...(assistantId !== undefined ? { assistantId } : {}) })
  if (!armed) return // the request came in the same sentence: a turn follows
  if (assistantId !== undefined) voice.setHolder(v, assistantId)
  stayAwake(v, WAKE_ARMED_MS)
  if (v.reply === undefined) setState(v, "listening")
}
const endSessions = (reason: "logout" | "expired" | "idle", token?: string) => {
  for (const [t] of sessions) if (token === undefined || t === token) sessions.delete(t)
  for (const c of conns) {
    if (!c.welcomed || c.session === undefined || sessions.has(c.session)) continue
    c.session = undefined
    c.testerUntil = undefined
    c.testerDevice = undefined
    sendTo(c, { type: "admin.state", admin: adminState(c, { endReason: reason }) })
  }
}
/** Admin-only request from a page that is not logged in: refused (true = refused). */
const requireAdmin = (c: Conn, requestId: string): boolean => {
  if (isAdminConn(c)) return false
  result(c, requestId, false, { code: "admin_required", message: adminEnabled() ? "Log in to admin to change this." : "Admin is switched off: set PVA_ADMIN_PASSWORD in .env and restart." })
  return true
}

type NotificationCardWire = Extract<ServerMessage, { type: "notification.ring" }>["notification"]
/** Open notifications: the card, its device (absent: everywhere), whether its module's handler is down. */
const mockNotifications = new Map<string, { readonly card: Omit<NotificationCardWire, "show" | "sound" | "texts">; readonly deviceId?: string; readonly handlerDown: boolean }>()
/** What each voice connection holds (by connection id), as the server keeps it per connection; gone with the connection. */
const mockHeld = new Map<string, Set<string>>()
/** Ids are never reused: every id ever issued or named (kept across resets), and a counter that skips them. */
let mockNotifySeq = 0
const mockNotifyIds = new Set<string>()
/**
 * The service's own words on the card and in its answers, in the saved household language (as `NotifyTexts` in
 * packages/core: the test compares the two).
 */
const MOCK_NOTIFY_TEXTS = {
  en: { cantNow: "I can't do that right now.", done: "Done.", region: "Notifications", startAudio: "Start audio to hear it." },
  nl: { cantNow: "Dat kan ik nu niet doen.", done: "Klaar.", region: "Meldingen", startAudio: "Zet het geluid aan om het te horen." }
} as const
const mockNotifyTexts = () => (String(valueOf("HOME_LANGUAGE") ?? "").toLowerCase().startsWith("nl") ? MOCK_NOTIFY_TEXTS.nl : MOCK_NOTIFY_TEXTS.en)
/** The reply volumes, in the server's one state machine (`changeReplyVolume`, `@pva/protocol`): the same steps, cap and drops. */
let mockVolumes: ReplyVolumes = NO_REPLY_VOLUMES
const resetState = () => {
  mockVolumes = NO_REPLY_VOLUMES
  mockNotifications.clear()
  mockHeld.clear()
  for (const p of mockPresentations.values()) clearTimeout(p.timer)
  mockPresentations.clear()
  mockPresentHeld.clear()
  mockMediaTokens.clear()
  for (const t of scriptTimers) clearTimeout(t)
  scriptTimers = []
  for (const v of voiceSessions.values()) {
    if (v.reply !== undefined) clearReply(v.reply)
    if (v.awakeTimer !== undefined) clearTimeout(v.awakeTimer)
    if (v.discardTimer !== undefined) clearTimeout(v.discardTimer)
  }
  voiceSessions.clear()
  lastSessions = ""
  modules = initialModules()
  moduleRoutesMock.reset()
  scheduledJobsMock = createScheduledJobsMock()
  pressing.clear()
  forcedErrors.clear()
  models = initialModels()
  sections = withWarnings(initialSections())
  engine = initialEngine()
  vault = scenario === "keys-locked" ? { state: "locked", password: VAULT_PASSWORD, lockReason: "start" } : { state: "none" }
  // A reset is a restart: admin sessions end (a page that sends its old token gets endReason "token").
  sessions.clear()
  loginFailures = 0
  loginRefusedUntil = 0
  logoutFails = false
  devices = seededDevices()
  retiredMemberIds = new Set()
  assistantsMock.reset(scenario === "long-phrase")
  syncCapabilities()
  voice.reset()
  seedVoiceScenario()
  env = initialEnv()
  favourites = initialFavourites()
  modelPickers.reset()
  providerFailures.clear()
  previewHold = 0
  for (const t of jobTimers.values()) clearInterval(t)
  jobTimers.clear()
  jobs = []
  traces = scenario === "latency" ? seedTraces() : []
  health = initialHealth()
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

// ---- P9: notifications, as the real server delivers them (docs/NOTIFICATIONS.md)

const notifyConns = (deviceId: string | undefined) => [...conns].filter((c) => c.welcomed && c.frontend === "voice" && c.deviceId !== undefined && (deviceId === undefined || c.deviceId === deviceId))
/**
 * The server's reconciliation, for one connection: every open notification of its device decided with the shared
 * decision function (`decideDelivery`) over the device's effective outputs (`deviceOutputsFrom`), sent per device; a
 * card the connection holds and may not any more is withdrawn. (The mock has no do not disturb and no personal content.)
 */
/** The shared decision for one notification on a device now. */
const decideMock = (deviceId: string, n: { readonly card: { readonly priority: "normal" | "ring" } }) => {
  const outputs = deviceOutputsFrom(assistantsMock.deviceFields(deviceId).settings, devices.get(deviceId)?.declared?.capabilities)
  return decideDelivery({ kind: "notification", priority: n.card.priority, personal: false, mayReveal: true, dnd: false, device: { connected: true, canSpeak: outputs.speak, canShow: outputs.show } })
}
const reconcileMock = (c: Conn) => {
  if (c.frontend !== "voice" || c.deviceId === undefined || !c.welcomed || !conns.has(c)) return
  const deviceId = c.deviceId
  const held = mockHeld.get(c.id) ?? new Set<string>()
  mockHeld.set(c.id, held)
  const texts = mockNotifyTexts()
  for (const [id, n] of mockNotifications) {
    if (n.deviceId !== undefined && n.deviceId !== deviceId) continue
    const d = decideMock(deviceId, n)
    if (d.deliver) {
      sendTo(c, { type: "notification.ring", notification: { ...n.card, show: d.show, sound: d.sound, texts: { region: texts.region, startAudio: texts.startAudio } } })
      held.add(id)
    } else if (held.delete(id)) sendTo(c, { type: "notification.resolved", id, outcome: "withdrawn" })
  }
}
/** After a hello (which may have changed the device's declaration): every connection of the device, as the server. */
const notificationsAfterWelcome = (c: Conn) => {
  if (c.deviceId === undefined) return reconcileMock(c)
  for (const x of notifyConns(c.deviceId)) reconcileMock(x)
}

// ---- P7: the reply volume, as the real server keeps it (docs/PHRASES.md "Louder and quieter")

/** After a voice page's welcome: its device's level when it is not the default (the page went back to the default). */
const volumeAfterWelcome = (c: Conn) => {
  if (c.frontend !== "voice" || c.deviceId === undefined) return
  const level = mockVolumes.get(c.deviceId)
  if (level !== undefined) sendTo(c, { type: "output.volume", volume: level })
}
/** One "louder" / "quieter" or a level for a device, as the server changes it: every send of the transition goes out in this step. */
const changeMockVolume = (deviceId: string, change: "louder" | "quieter" | { readonly to: number }) => {
  const t = changeReplyVolume(mockVolumes, deviceId, change)
  mockVolumes = t.volumes
  for (const send of t.sends) for (const c of notifyConns(send.deviceId)) sendTo(c, { type: "output.volume", volume: send.volume })
  return t.change
}
const resolveMockNotification = (id: string, outcome: string) => {
  const n = mockNotifications.get(id)
  if (n === undefined) return false
  mockNotifications.delete(id)
  for (const c of conns) if (mockHeld.get(c.id)?.delete(id) === true) sendTo(c, { type: "notification.resolved", id, outcome })
  return true
}
// ---- P10: presentations, as the real server shows them (docs/PRESENTING.md)

/** Live presentations: what the module showed (checked by the shared checks), its device (absent: every device), its lifetime. */
const mockPresentations = new Map<string, {
  presentation: Presentation
  readonly deviceId?: string
  readonly lifetime: "transient" | "pinned"
  readonly shownAt: number
  readonly endsAt: number
  readonly handlerDown: boolean
  readonly timer: ReturnType<typeof setTimeout>
}>()
/** What each voice connection holds of them, per connection as the server keeps it (with its image addresses); gone with it. */
const mockPresentHeld = new Map<string, Map<string, { readonly fp: string; readonly token: string | undefined }>>()
/** Image addresses: token → the connection and presentation it was made for (as the server's `mediaFor`). */
const mockMediaTokens = new Map<string, { readonly connId: string; readonly id: string }>()
let mockPresentSeq = 0
const mockPresentIds = new Set<string>()
/** The mock's one image (a 1 × 1 PNG): every image presentation shows it, built in, bounded. */
const MOCK_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
/** The Presenter's own words, in the saved household language (as `PresentTexts` in packages/core: the test compares the two). */
const MOCK_PRESENT_TEXTS = {
  en: { region: "On screen", loading: "Loading the image…", imageMissing: "The image is not available.", timerDone: "Done", credit: "Image:", high: "High", low: "Low", done: "Done.", cantNow: "I can't do that right now." },
  nl: { region: "Op het scherm", loading: "De afbeelding wordt geladen…", imageMissing: "De afbeelding is niet beschikbaar.", timerDone: "Klaar", credit: "Afbeelding:", high: "Hoog", low: "Laag", done: "Klaar.", cantNow: "Dat kan ik nu niet doen." }
} as const
const mockPresentTexts = () => (String(valueOf("HOME_LANGUAGE") ?? "").toLowerCase().startsWith("nl") ? MOCK_PRESENT_TEXTS.nl : MOCK_PRESENT_TEXTS.en)
/** The shared decision for one presentation for one connection now, with the kinds its own page declared (as the server). */
const decidePresentMock = (c: Conn, kind: PresentKindName) => {
  const record = devices.get(c.deviceId!)?.declared?.capabilities
  const caps = record === undefined ? undefined : { ...record, present: { kinds: c.ownCaps?.present?.kinds ?? {} } }
  const outputs = devicePresentFrom(assistantsMock.deviceFields(c.deviceId!).settings, caps)
  return decidePresentation({ kind, personal: false, mayReveal: true, device: { connected: true, ...outputs } })
}
/** What a page is sent of a presentation (without `serverNow`), as the server's `wireOf`. */
const mockWire = (id: string, p: { readonly presentation: Presentation; readonly lifetime: "transient" | "pinned"; readonly shownAt: number }, token: string | undefined, interactive: boolean) => {
  const texts = mockPresentTexts()
  return {
    id,
    lifetime: p.lifetime,
    shownAt: p.shownAt,
    v: PRESENT_KIND_VERSIONS[p.presentation.kind],
    content: presentWireContent(p.presentation, token === undefined ? undefined : { state: "ready", token }),
    buttons: (p.presentation.buttons ?? []).map((b) => ({ id: b.id, label: b.label })),
    interactive: interactive && p.presentation.handler !== undefined,
    texts: { region: texts.region, loading: texts.loading, imageMissing: texts.imageMissing, timerDone: texts.timerDone, credit: texts.credit, high: texts.high, low: texts.low }
  }
}
const isPresentationWire = Schema.is(PresentationWire)
/** The request fields of `POST /mock/present`; anything else is refused. */
const MOCK_PRESENT_FIELDS: ReadonlyArray<string> = ["id", "presentation", "options", "deviceId", "handlerDown"]
/**
 * What the mock does not model, refused with a 400 rather than done differently (review round 2, R7; docs/PRESENTING.md
 * "The web mock"): it has no privacy model, so only household presentations; it has no keyed replacement, so no `key`.
 */
const MOCK_PRESENT_NO_PRIVACY = "the mock shows household presentations only (it has no privacy model): leave sensitivity out or say household"
const MOCK_PRESENT_NO_KEY = "the mock does not replace by key: leave options.key out (dismiss and show again)"
/** A presentation's end, as the server's: gone at its end, its pages reconciled. */
const endMockPresentation = (id: string) => {
  const p = mockPresentations.get(id)
  if (p === undefined) return false
  clearTimeout(p.timer)
  mockPresentations.delete(id)
  reconcilePresentEverywhere()
  return true
}
const pruneEndedMock = () => {
  const now = Date.now()
  for (const [id, p] of [...mockPresentations]) if (p.endsAt <= now) endMockPresentation(id)
}
const newMockToken = () => randomBytes(24).toString("base64url")
/**
 * The server's reconciliation for one connection: what applies to its device now, decided with the shared function and
 * that connection's own kinds, what it shows of it (`selectPresentations`), withdrawals first.
 */
const reconcilePresentMock = (c: Conn) => {
  if (c.frontend !== "voice" || c.deviceId === undefined || !c.welcomed || !conns.has(c)) return
  const deviceId = c.deviceId
  const held = mockPresentHeld.get(c.id) ?? new Map<string, { readonly fp: string; readonly token: string | undefined }>()
  mockPresentHeld.set(c.id, held)
  const now = Date.now()
  const chosen = selectPresentations([...mockPresentations].filter(([, p]) => p.endsAt > now && (p.deviceId === undefined || p.deviceId === deviceId)).map(([id, p]) => ({
    id,
    lifetime: p.lifetime,
    shownAt: p.shownAt,
    decision: decidePresentMock(c, p.presentation.kind)
  })))
  const want = new Set(chosen.map((x) => x.id))
  for (const [id, h] of [...held]) {
    if (want.has(id)) continue
    held.delete(id)
    if (h.token !== undefined) mockMediaTokens.delete(h.token)
    sendTo(c, { type: "present.dismiss", id })
  }
  for (const x of chosen) {
    const p = mockPresentations.get(x.id)!
    const before = held.get(x.id)
    const token = p.presentation.kind === "image" ? before?.token ?? newMockToken() : undefined
    if (token !== undefined) mockMediaTokens.set(token, { connId: c.id, id: x.id })
    const wire = mockWire(x.id, p, token, x.decision.interactive)
    const fp = JSON.stringify(wire)
    if (before?.fp === fp) continue
    sendTo(c, { type: before === undefined ? "present.show" : "present.update", presentation: { ...wire, serverNow: Date.now() } })
    held.set(x.id, { fp, token })
  }
}
const reconcilePresentEverywhere = () => {
  for (const c of notifyConns(undefined)) reconcilePresentMock(c)
}
/** `GET /media/<token>`, as the server's: only a token made for an open connection that holds that image; the same headers. */
const serveMockMedia = (path: string, res: ServerResponse) => {
  const t = mockMediaTokens.get(path.slice("/media/".length))
  const c = t === undefined ? undefined : [...conns].find((x) => x.id === t.connId)
  if (t === undefined || c === undefined || mockPresentHeld.get(c.id)?.has(t.id) !== true) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" })
    return res.end("Not found")
  }
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": String(MOCK_IMAGE.length),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline; filename=\"image.png\"",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store"
  })
  return res.end(MOCK_IMAGE)
}

/** Messages that carry admin data: only admin connections get them (protocol 5). */
const ADMIN_ONLY: ReadonlySet<ServerMessage["type"]> = new Set(["engine", "module.changed", "section.changed", "vault", "env", "job", "models", "devices", "assistants", "device.types", "sessions", "trace", "wake.heard", "admin.snapshot", "health"])
let lastSummary = ""
const broadcast = (m: ServerMessage) => {
  const adminOnly = ADMIN_ONLY.has(m.type)
  for (const c of conns) if (c.welcomed && (!adminOnly || isAdminConn(c))) sendTo(c, m)
  if (m.type === "engine") {
    // Everyone gets the summary when it changes.
    const summary = engineSummary(m.engine)
    const key = JSON.stringify(summary)
    if (key !== lastSummary) {
      lastSummary = key
      broadcast({ type: "engine.summary", engine: summary })
    }
  }
}

/**
 * Who has the turn, as the server says it (`state.holder`, `snapshot.holder`): the reply's assistant, else the
 * assistant of the utterance being heard, else the one whose armed or follow-up window is open, else nobody.
 */
const holderNow = (v: VSession): string | null => {
  if (v.reply !== undefined) return v.reply.assistantId ?? null
  if (v.state === "hearing" && v.hearingFor !== undefined) return v.hearingFor
  return Date.now() < v.awakeUntil ? voice.holderOf(v) ?? null : null
}

/** The state, with who has the turn; sent again with the same state when only the holder changed (as the server does). */
const setState = (v: VSession, state: AssistantState, turnId?: number) => {
  const was = v.state
  v.state = state
  const holder = holderNow(v)
  if (state === was && turnId === undefined && holder === v.holderSent) return
  v.holderSent = holder
  toSession(v, turnId === undefined ? { type: "state", state, holder } : { type: "state", state, turnId, holder })
  sessionsChanged()
}

// ---- Settings from outside (.env) and model downloads

function initialEnv(): EnvInfo {
  return {
    files: [ENV_FILE],
    entries: [
      { key: "ANTHROPIC_API_KEY", origin: "file", file: ENV_FILE, line: 3, kind: "setting", secret: true, page: { path: ["language-model", "provider"], title: "Language model › Provider" }, movable: true },
      { key: "ANTHROPIC_MODEL", origin: "process", kind: "setting", secret: false, page: { path: ["language-model", "provider"], title: "Language model › Provider" }, movable: false },
      { key: "PVA_VAULT_PASSWORD", origin: "file", file: ENV_FILE, line: 1, kind: "bootstrap", secret: true, movable: false },
      { key: "SERVE_PORT", origin: "file", file: ENV_FILE, line: 2, kind: "bootstrap", secret: false, movable: false },
      { key: "STT_SHERPA_MODLE", origin: "file", file: ENV_FILE, line: 6, kind: "unknown", secret: false, movable: false },
      { key: "TTS_SHERPA_SPEED", origin: "file", file: ENV_FILE, line: 5, kind: "setting", secret: false, page: { path: ["voices", "providers"], title: "Voices › Voice providers" }, movable: true }
    ]
  }
}

function initialModels(): Array<ModelSet> {
  return [
    {
      tool: "stt-models",
      title: "Speech recognition models",
      directory: MODELS_DIR,
      freeMb: 41_200,
      items: [
        { id: "parakeet-v2", label: "Parakeet v2 — English, most accurate", description: "Best English accuracy.", sizeMb: 484, diskMb: 663, installed: true, inUse: true },
        { id: "parakeet-ultra", label: "Parakeet Ultra — multilingual", description: "English, Dutch and 23 more languages.", sizeMb: 489, diskMb: 673, installed: false, inUse: false },
        { id: "whisper-turbo", label: "Whisper turbo — 99 languages", description: "Robust in noise, slower.", sizeMb: 565, diskMb: 1039, installed: false, inUse: false },
        { id: "nemotron-320", label: "Nemotron 320 ms — live words", description: "Live words, multilingual.", sizeMb: 477, diskMb: 686, installed: true, inUse: false },
        { id: "zipformer-en", label: "Zipformer — small, fast", description: "Small and light, least accurate.", sizeMb: 312, diskMb: 331, installed: true, inUse: false }
      ]
    },
    {
      tool: "tts-models",
      title: "Voice models",
      directory: MODELS_DIR,
      freeMb: 41_200,
      items: [
        { id: "en_US-lessac-medium", label: "Piper en_US-lessac-medium", description: "Fast · 22050 Hz", sizeMb: 68, diskMb: 83, installed: true, inUse: true },
        { id: "en_GB-alba-medium", label: "Piper en_GB-alba-medium", description: "Fast · 22050 Hz", sizeMb: 68, diskMb: 83, installed: false, inUse: false },
        { id: "nl_NL-pim-medium", label: "Piper nl_NL-pim-medium", description: "Fast · 22050 Hz", sizeMb: 68, diskMb: 83, installed: false, inUse: false },
        { id: "kokoro-af_heart", label: "Kokoro kokoro-af_heart", description: "Higher quality, slower first audio · 24000 Hz", sizeMb: 350, diskMb: 403, installed: true, inUse: false }
      ]
    }
  ]
}

const setInstalled = (tool: ToolId, target: string, installed: boolean) => {
  models = models.map((m) => (m.tool !== tool ? m : { ...m, items: m.items.map((i) => (i.id === target ? { ...i, installed } : i)) }))
  broadcast({ type: "models", models })
  // The recogniser choice drops or gains its `not-downloaded` tag.
  if (tool !== "stt-models") return
  sections = sections.map((x) => {
    if (!x.form.fields.some((f) => f.key === "STT_SHERPA_MODEL")) return x
    const fields = x.form.fields.map((f) =>
      f.key !== "STT_SHERPA_MODEL" || f.type !== "choice"
        ? f
        : {
          ...f,
          options: f.options.map((o) =>
            o.value !== target ? o : { ...o, tags: installed ? (o.tags ?? []).filter((t) => t !== "not-downloaded") : [...(o.tags ?? []), "not-downloaded" as const] }
          )
        }
    )
    const next = { ...x, form: { ...x.form, fields }, revision: x.revision + 1 }
    broadcast({ type: "section.changed", section: next })
    return next
  })
}

const updateJob = (job: JobInfo) => {
  jobs = [...jobs.filter((j) => j.id !== job.id), job].slice(-20)
  broadcast({ type: "job", job })
}

const startDownload = (c: Conn, requestId: string, tool: ToolId, target: string) => {
  const started = startJob(tool, target)
  if (!started.ok) return result(c, requestId, false, { code: started.code === "unknown" ? "invalid_settings" : "busy", message: started.message })
  result(c, requestId, true)
}

/** A model download job (the Models pages and the voice picker's downloads are the same job). */
const startJob = (tool: ToolId, target: string): { ok: true; job: JobInfo } | { ok: false; code: "unknown" | "installed" | "running"; message: string } => {
  const item = models.find((m) => m.tool === tool)?.items.find((i) => i.id === target)
  if (item === undefined) return { ok: false, code: "unknown", message: `There is no model "${target}"` }
  if (item.installed) return { ok: false, code: "installed", message: `${item.label} is already downloaded` }
  if (jobs.some((j) => j.state === "running" && j.tool === tool && j.target === target)) {
    return { ok: false, code: "running", message: `${item.label} is already being downloaded` }
  }
  const total = item.sizeMb * 1e6
  let job: JobInfo = {
    id: `job-${++jobSeq}`,
    tool,
    action: "download",
    target,
    label: item.label,
    state: "running",
    phase: "check",
    log: [`Needs about ${((item.sizeMb + item.diskMb) / 1000).toFixed(1)} GB; 41.2 GB free`],
    startedAt: Date.now()
  }
  updateJob(job)
  const first = job
  let tick = 0
  const unpackTicks = 6
  const timer = setInterval(() => {
    tick++
    if (tick <= DOWNLOAD_TICKS) {
      job = { ...job, phase: "download", progress: { done: Math.round((total * tick) / DOWNLOAD_TICKS), total, unit: "bytes" }, log: tick === 1 ? [...job.log, `Downloading ${target}`] : job.log }
    } else if (tick <= DOWNLOAD_TICKS + unpackTicks) {
      job = { ...job, phase: "unpack", progress: { done: Math.round((total * (tick - DOWNLOAD_TICKS)) / unpackTicks), total, unit: "bytes" } }
    } else {
      clearInterval(timer)
      jobTimers.delete(job.id)
      job = { ...job, state: "succeeded", endedAt: Date.now(), log: [...job.log, `${target}: ready`] }
      updateJob(job)
      setInstalled(tool, target, true)
      return
    }
    updateJob(job)
  }, 250)
  jobTimers.set(job.id, timer)
  return { ok: true, job: first }
}

const cancelJob = (c: Conn, requestId: string, jobId: string) => {
  const cancelled = stopJob(jobId)
  if (cancelled === undefined) return result(c, requestId, false, { code: "invalid_settings", message: "That job is not running" })
  result(c, requestId, true)
}
const stopJob = (jobId: string): JobInfo | undefined => {
  const job = jobs.find((j) => j.id === jobId && j.state === "running")
  const timer = jobTimers.get(jobId)
  if (job === undefined || timer === undefined) return undefined
  clearInterval(timer)
  jobTimers.delete(jobId)
  const cancelled: JobInfo = { ...job, state: "cancelled", endedAt: Date.now() }
  updateJob(cancelled)
  return cancelled
}

const deleteModel = (c: Conn, requestId: string, tool: ToolId, target: string) => {
  const item = models.find((m) => m.tool === tool)?.items.find((i) => i.id === target)
  if (item === undefined) return result(c, requestId, false, { code: "invalid_settings", message: `There is no model "${target}"` })
  if (item.inUse) return result(c, requestId, false, { code: "busy", message: `${item.label} is in use by the running engines; choose another model and reload first` })
  if (!item.installed) return result(c, requestId, false, { code: "invalid_settings", message: `${item.label} is not downloaded` })
  setInstalled(tool, target, false)
  result(c, requestId, true)
}

const moveFromEnv = (c: Conn, requestId: string, keys: ReadonlyArray<string>) => {
  const entries = keys.map((k) => env.entries.find((e) => e.key === k))
  const bad = keys.filter((_, i) => entries[i]?.movable !== true)
  if (bad.length > 0) return result(c, requestId, false, { code: "invalid_settings", message: `${bad.join(", ")} cannot be moved` })
  if (vault.state === "locked" && entries.some((e) => e?.secret === true)) {
    return result(c, requestId, false, { code: "locked", message: "Unlock the key vault first (Settings → Keys & access)" })
  }
  env = { ...env, entries: env.entries.filter((e) => !keys.includes(e.key)) }
  // The fields those variables locked are saved settings now.
  sections = sections.map((x) => {
    if (!x.form.fields.some((f) => keys.includes(f.key) && f.locked !== undefined)) return x
    const fields = x.form.fields.map((f) => {
      if (!keys.includes(f.key)) return f
      const { locked: _locked, ...rest } = f
      return { ...rest, source: "saved" as const }
    })
    const secrets = Object.fromEntries(Object.entries(x.form.secrets).map(([k, v]) => [k, keys.includes(k) ? { set: true, source: "store" as const } : v]))
    const next = { ...x, form: { ...x.form, fields, secrets }, revision: x.revision + 1 }
    broadcast({ type: "section.changed", section: next })
    return next
  })
  result(c, requestId, true)
  broadcast({ type: "env", env })
}

// ---- Key vault and admin access (per connection)

const vaultInfo = (c: Conn) => ({
  state: vault.state,
  // Since protocol 5: this connection is admin (the login), whatever the vault's state.
  admin: isAdminConn(c),
  location: VAULT_LOCATION,
  ...(vault.state === "locked" && vault.lockReason !== undefined ? { lockReason: vault.lockReason } : {})
})
const sendVault = (c: Conn) => sendTo(c, { type: "vault", vault: vaultInfo(c) })
const vaultChanged = () => {
  for (const c of conns) if (c.welcomed && isAdminConn(c)) sendVault(c)
}
/**
 * Every change needs admin (`admin_required`); a protected item (keys, providers, agents) also needs the keys
 * unlocked (`locked`).
 */
const refuseLocked = (c: Conn, requestId: string, isProtected: boolean | undefined): boolean => {
  if (requireAdmin(c, requestId)) return true
  if (isProtected !== true || vault.state !== "locked") return false
  result(c, requestId, false, { code: "locked", message: "The keys are locked: unlock them in Keys & vault to change this." })
  return true
}
const grantAdmin = (c: Conn) => sendVault(c)
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

const restingState = (v: VSession): AssistantState =>
  v.owner === undefined || !v.micLive ? "idle" : wakeMode(v) && Date.now() >= v.awakeUntil ? "asleep" : "listening"

const sessionUpdate = (v: VSession, reason: "claimed" | "released" | "taken_over" | "owner_disconnected" | "resumed") => {
  for (const c of connsOf(v)) sendTo(c, { type: "session", role: c === v.owner ? "owner" : "observer", ownerPresent: ownerPresentIn(v), reason })
  devicesChanged()
  sessionsChanged()
}
/** After a change of devices or assistants: every session that is not in a turn settles in its resting state. */
const settleAll = () => {
  for (const v of voiceSessions.values()) if (v.reply === undefined) setState(v, restingState(v))
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
    voices: r.spoken ? [runningVoiceKey()] : [],
    ...(r.started !== undefined ? { client: { outputLatencyMs: r.started.outputLatencyMs, startDelayMs: r.started.startDelayMs } } : {})
  }
  return trace
}

/** Protocol 7: who answered, on which device, chosen how, and what the assistant was set to (`TraceInfo.config`). */
const adminTraceFields = (r: Reply, v: VSession): Partial<TraceInfo> => {
  const a = assistantsMock.assistants().find((x) => x.id === (r.assistantId ?? voice.setupFor(v.deviceId).assistants[0]?.id))
  if (a === undefined) return {}
  const chosen = a.modules
  const onModules = modules.filter((m) => m.kind === "capability" && chosen[m.id]?.on === true)
  const config: NonNullable<TraceInfo["config"]> = {
    llm: { account: a.llm.account, model: a.llm.model, effort: a.llm.effort, thinking: a.llm.thinking, maxTokens: a.llm.maxTokens },
    hearing: { hearer: a.id, engine: a.hearing.engine, model: a.hearing.model, language: a.hearing.language, eagerSilenceMs: a.hearing.eagerSilenceMs, finalSilenceMs: a.hearing.finalSilenceMs },
    // docs/LOOKS-AND-VOICES.md §3: the device's own voice, else the assistant's.
    voice: (() => {
      const spoken = voiceFor(voice.settingsOf(v.deviceId).voice, a)
      return `${spoken.provider}:${spoken.voiceId}`
    })(),
    modules: onModules.length,
    tools: onModules.reduce((n, m) => n + m.tools.filter((t) => !(chosen[m.id]?.offTools ?? []).includes(t.name)).length, 0),
    replyEarly: a.replyEarly,
    toolRounds: a.toolRounds
  }
  return {
    assistant: { id: a.id, name: a.name },
    ...(v.deviceId === undefined ? {} : { deviceId: v.deviceId, device: sessionName(v).slice(0, 64) }),
    route: r.source === "text" ? { by: "typed" } : { by: "default" },
    config
  }
}

const endTurn = (r: Reply, outcome: "completed" | "interrupted" | "failed") => {
  if (r.ended) return
  const v = r.session
  clearReply(r)
  if (v.reply === r) v.reply = undefined
  const trace = makeTrace(r, outcome)
  // Admin's traces carry the session (the device's name) and arrive live as `trace`; the device's tabs get turn.end.
  const forAdmin: TraceInfo = { ...trace, session: sessionName(v).slice(0, 64), ...adminTraceFields(r, v) }
  traces = [...traces, forAdmin].slice(-20)
  broadcast({ type: "trace", key: v.key, ...(v.deviceId === undefined ? {} : { deviceId: v.deviceId }), trace: forAdmin })
  // A turn of a conversation that was replaced (New conversation) is never committed to the new one.
  const conv = voice.convFor(v, r.assistantId)
  if (conv.conversation.id === r.conversationId) {
    const heard = r.spoken ? r.clauses.filter((_, i) => i <= r.playedClause || outcome === "completed").map((c) => c.text).join(" ") : r.clauses.map((c) => c.text).join("")
    conv.history.push({ role: "assistant", text: heard, interrupted: outcome !== "completed", tools: r.tools.map((t) => ({ name: t.name, ok: true })) })
    conv.turns++
    conv.lastTurnAt = Date.now()
  }
  toSession(v, { type: "turn.end", turnId: r.turnId, outcome, trace })
  // The reply's assistant keeps the turn for its follow-up window, in every mode (as the server's route gate).
  const followUp = voice.followUpMs(v.deviceId, r.assistantId)
  if (followUp > 0) {
    voice.setHolder(v, r.assistantId)
    stayAwake(v, followUp)
  } else {
    v.awakeUntil = 0
    voice.setHolder(v, undefined)
  }
  setState(v, restingState(v))
  sessionsChanged()
}

/** Clauses up to `samples` started playing: tell every tab. */
const playedTo = (r: Reply, samples: number) => {
  let k = r.playedClause
  while (k + 1 < r.clauses.length && r.clauses[k + 1]!.startSample < samples) k++
  if (k > r.playedClause) {
    r.playedClause = k
    toSession(r.session, { type: "assistant.playing", turnId: r.turnId, clause: k })
  }
}

/** The stop's wait ran out: a provisional count is better than nothing. */
const endStopped = (r: Reply) => {
  if (r.ended) return
  if (r.provisional !== undefined) playedTo(r, r.provisional)
  endTurn(r, "interrupted")
}

/** Interrupt the running reply: reply.stop to the owner, wait ≤ 300 ms for playback.stopped. */
const interruptReply = (r: Reply) => {
  if (r.ended) return
  if (r.spoken && r.owner !== undefined && r.started !== undefined) {
    sendTo(r.owner, { type: "reply.stop", turnId: r.turnId })
    r.timers.push(setTimeout(() => endStopped(r), 300))
    r.awaitingStop = true
  } else {
    if (r.spoken && r.owner !== undefined) sendTo(r.owner, { type: "reply.stop", turnId: r.turnId })
    endTurn(r, "interrupted")
  }
}

const runReply = (v: VSession, opts: {
  source: "voice" | "text"
  userText: string
  clauses: ReadonlyArray<string>
  spoken: boolean
  tool?: { name: string; moduleId: string; input: unknown; ms: number; ok?: boolean; error?: string }
  /** Protocol 7: the assistant that answers; absent: the one with the turn, else the one that answers without a phrase. */
  assistantId?: string | undefined
}) => {
  if (v.reply !== undefined) interruptReply(v.reply)
  // As the server: never spoken where no reply audio is sent (the override, or a declaration without speech).
  opts = { ...opts, spoken: opts.spoken && speakerAllowedOf(v.deviceId) }
  const assistantId = opts.assistantId ?? voice.answeringOf(v, v.deviceId)
  const conv = voice.convFor(v, assistantId)
  const withId = assistantId === undefined ? {} : { assistantId }
  // The idle reset, decided at the start of the turn: quiet for longer than the device's conversationIdleMinutes.
  const idleMinutes = idleMinutesOf(assistantId)
  if (idleMinutes > 0 && conv.lastTurnAt !== null && Date.now() - conv.lastTurnAt > idleMinutes * 60_000) newConversation(v, "idle", assistantId)
  const turnId = ++turnSeq
  const endOfTurn = Date.now()
  v.lastActive = endOfTurn
  conv.history.push({ role: "user", text: opts.userText })
  lastTurnOf.set(conv, turnId)
  voice.setHolder(v, assistantId)
  v.hearingFor = undefined
  toSession(v, { type: "transcript", text: "" })
  toSession(v, { type: "turn.start", turnId, source: opts.source, userText: opts.userText, spoken: opts.spoken, ...withId })
  let startSample = 0
  const pcms = opts.clauses.map((text, i) => synthesize(text, i * 1.7 + turnId))
  const clauses = opts.clauses.map((text, i) => {
    const c = { text, startSample }
    startSample += pcms[i]!.length
    return c
  })
  const r: Reply = { turnId, clauses, endOfTurn, spoken: opts.spoken, tools: [], source: opts.source, owner: v.owner, session: v, conversationId: conv.conversation.id, assistantId, playedClause: -1, lastReport: Date.now(), timers: [], ended: false }
  v.reply = r
  // After the reply is recorded: the state names its assistant as the holder (the turn in flight), as the server does.
  setState(v, "thinking", turnId)
  let t = 120
  if (opts.tool !== undefined) {
    const tool = opts.tool
    r.timers.push(setTimeout(() => toSession(v, { type: "tool.start", turnId, callId: `toolu_${turnId}`, tool: tool.name, moduleId: tool.moduleId, input: tool.input as never, ...withId }), t))
    t += tool.ms
    r.timers.push(setTimeout(() => {
      r.tools.push({ name: tool.name, ms: tool.ms })
      toSession(v, { type: "tool.end", turnId, callId: `toolu_${turnId}`, ok: tool.ok ?? true, ms: tool.ms, ...(tool.error !== undefined ? { error: tool.error } : {}), ...withId })
    }, t))
    t += 40
  }
  if (!opts.spoken) {
    // Unspoken: stream raw text deltas, then end.
    const words = opts.clauses.join(" ").split(/(?<= )/)
    words.forEach((w, i) => r.timers.push(setTimeout(() => toSession(v, { type: "assistant.text", turnId, clause: null, text: w, ...withId }), t + 280 + i * 45)))
    r.timers.push(setTimeout(() => endTurn(r, "completed"), t + 300 + words.length * 45))
    return
  }
  const c = v.owner
  // Review round 3: speech is decided again where audio would leave (a declaration may have taken it away since the
  // turn started): the play stops there, as the server stops it.
  const mayStillSpeak = () => {
    if (speakerAllowedOf(v.deviceId)) return true
    interruptReply(r)
    return false
  }
  r.timers.push(setTimeout(() => {
    if (!alive(v) || r.ended || r.awaitingStop === true || !mayStillSpeak()) return
    if (c === undefined || c.ws.readyState !== c.ws.OPEN) {
      toSession(v, { type: "error", error: { code: "turn_failed", message: "No audio client: the reply could not be played.", turnId } })
      endTurn(r, "failed")
      return
    }
    sendTo(c, { type: "reply.start", turnId, sampleRate: REPLY_RATE, ...withId })
    r.lastReport = Date.now()
    // Watch for stalls: no report for 2 s while waiting → reply.stop + playback_timeout.
    r.stallTimer = setInterval(() => {
      if (r.ended) return
      if (Date.now() - r.lastReport > 2000) {
        sendTo(c, { type: "reply.stop", turnId })
        toSession(v, { type: "error", error: { code: "playback_timeout", message: "The browser stopped reporting playback; the reply was stopped.", turnId } })
        endTurn(r, "failed")
      }
    }, 250)
  }, t))
  // Clauses go to TTS one after another, faster than real time.
  opts.clauses.forEach((text, i) => {
    r.timers.push(setTimeout(() => {
      if (!alive(v) || r.ended || r.awaitingStop === true || !mayStillSpeak()) return
      toSession(v, { type: "assistant.text", turnId, clause: i, text, voice: runningVoiceKey(), ...withId })
      if (c !== undefined) sendReplyAudio(c, turnId, pcms[i]!)
      if (i === opts.clauses.length - 1 && c !== undefined) sendTo(c, { type: "reply.end", turnId })
    }, t + 30 + i * 380))
  })
}

const VOICE_CLAUSES = ["It's sunny in Paris,", "eighteen degrees with a light wind from the west,", "and it stays dry until the evening."]

const WEATHER_TURN = {
  userText: "What's the weather in Paris?",
  clauses: VOICE_CLAUSES,
  tool: { name: "weather", moduleId: "weather", input: { place: "Paris, France" }, ms: 241 }
}

/**
 * The scripted voice turn. `assistantId` (protocol 7): the assistant that answers; absent: the one with the turn, else
 * the one that answers without a phrase. `phrase`: it was woken by that phrase in the same sentence (a `wake` with
 * `armed: false` names the assistant first).
 */
const runVoiceTurn = (v: VSession | undefined, opts: { assistantId?: string | undefined; phrase?: string | undefined } = {}) => {
  if (v === undefined || v.owner === undefined || !alive(v)) return
  const assistantId = opts.assistantId ?? voice.answeringOf(v, v.deviceId)
  const script = scriptedTurn(assistantId, WEATHER_TURN)
  v.hearingFor = assistantId
  setState(v, "hearing")
  if (opts.phrase !== undefined) wakeUp(v, opts.phrase, false, assistantId)
  if (v.hearingEnd !== undefined) clearTimeout(v.hearingEnd)
  const spoken = (script.userText.charAt(0).toLowerCase() + script.userText.slice(1)).replace(/[?]/g, "").split(" ")
  const words = spoken.map((_, i) => spoken.slice(0, i + 1).join(" "))
  words.forEach((w, i) => after(250 + i * 260, () => toSession(v, { type: "transcript", text: w })))
  v.hearingEnd = after(250 + words.length * 260 + 350, () => {
    v.hearingEnd = undefined
    if (!alive(v)) return
    sendHeard(v, script.userText, opts.phrase, true)
    runReply(v, { source: "voice", userText: script.userText, clauses: script.clauses, spoken: true, tool: script.tool, assistantId })
  })
}

/** The wake scenario after a claim: asleep; a line it ignores; the phrase alone; then the voice turn. */
const runWakeScript = (v: VSession) => {
  after(2500, () => sendHeard(v, "Hey go, what's the weather?"))
  after(4000, () => {
    sendHeard(v, "Hey Jeff", "hey jeff")
    wakeUp(v, "hey jeff", true)
  })
  after(5500, () => runVoiceTurn(v))
}

// ---------------------------------------------------------------------------
// Client messages
// ---------------------------------------------------------------------------

const result = (c: Conn, requestId: string, ok: boolean, error?: Extract<ServerMessage, { type: "result" }>["error"]) =>
  sendTo(c, error === undefined ? { type: "result", requestId, ok } : { type: "result", requestId, ok, error })

const applyPatch = (form: SettingsForm, patch: SettingsPatch): SettingsForm => {
  const values: Record<string, SettingValue> = { ...form.values }
  const secrets = { ...form.secrets }
  const sources: Record<string, "default" | "saved"> = {}
  for (const [k, v] of Object.entries(patch.values)) {
    const field = form.fields.find((f) => f.key === k)
    if (field === undefined || field.type === "secret") continue
    if (field.type === "action" || field.type === "info") continue
    values[k] = v === null ? (field.default as SettingValue) : v
    sources[k] = v === null ? "default" : "saved"
  }
  for (const [k, v] of Object.entries(patch.secrets)) {
    secrets[k] = v === null ? { set: false, source: "none" } : { set: true, source: "store" }
    sources[k] = v === null ? "default" : "saved"
  }
  // Fields set by the environment keep their source; the others say where their value now comes from.
  const fields = form.fields.map((f) => (sources[f.key] !== undefined && f.locked === undefined ? { ...f, source: sources[f.key]! } : f))
  return { ...form, fields, values, secrets, errors: [] }
}

const validate = (form: SettingsForm, patch: SettingsPatch) => {
  const errors: Array<{ key: string | null; message: string }> = []
  for (const [k, v] of Object.entries(patch.values)) {
    const field = form.fields.find((f) => f.key === k)
    if (field === undefined) errors.push({ key: null, message: `Unknown setting ${k}.` })
    else if (field.locked !== undefined) errors.push({ key: k, message: `${field.locked.reason}; change it there.` })
    else if (fieldValueError(field, v) !== undefined) errors.push({ key: k, message: fieldValueError(field, v)! })
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

// ---- Capability modules follow the assistants (docs/ASSISTANTS.md §2.6, WP-12b)

const HA_TOOLS = [{ name: "home_state", description: "Current state of devices, by area or by name.", speculative: true }]
const NOTES_TOOLS = [{ name: "add_note", description: "Save a short note.", speculative: false }, { name: "read_notes", description: "Read recent notes.", speculative: true }]
/** What a running capability module offers, whether or not an assistant has it on right now. */
const runningTools = (id: string): ModuleInfo["tools"] =>
  id === "home-assistant" ? HA_TOOLS : id === "notes" ? NOTES_TOOLS : initialModules().find((x) => x.id === id)?.tools ?? []
/** An instance's status: the clock says today's date in the instance's own date format. */
const instanceStatus = (id: string, m: ModuleInfo, own: Readonly<Record<string, SettingValue>> | undefined) => {
  const status = runningStatus(id, m)
  if (id !== "clock" || status === undefined) return status
  const locale = String(own?.locale ?? m.settings.values.locale ?? "en-GB")
  const zone = String(own?.timeZone ?? m.settings.values.timeZone ?? "Europe/Amsterdam")
  return { ...status, text: `${zone} · ${new Date(Date.UTC(2026, 10, 13)).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}` }
}
const runningStatus = (id: string, m: ModuleInfo) =>
  id === "home-assistant" ? { text: "Connected to Home · 42 devices", tone: "ok" as const }
  : id === "notes" ? { text: "12 notes in Inbox", tone: "neutral" as const }
  : m.status
/** A failure injected into a capability module's instances (tests: `/mock/module-error`); a saved token with "good" in it clears it. */
const forcedErrors = new Map<string, string>()
/** The field errors the module's own checks give an assistant's own values (`ModuleHost.checkOwn`). */
const checkOwn = (moduleId: string, own: Readonly<Record<string, unknown>>) => {
  const m = modules.find((x) => x.id === moduleId)
  if (m === undefined) return []
  const values = Object.fromEntries(Object.entries(own)) as Record<string, SettingValue>
  return validate(m.settings, { values, secrets: {} }).flatMap((e) => (e.key === null ? [] : [{ field: e.key, message: e.message }]))
}
/**
 * Every capability module follows the assistants (`reconcileCapability`, mock/capabilities.ts: an unavailable one
 * stays unavailable). Module infos are updated (and pushed) only when they change.
 */
const capabilityParts: CapabilityParts = { forced: (id) => forcedErrors.get(id), runningStatus, runningTools, instanceStatus }
const syncCapabilities = () => {
  const list = assistantsMock.assistants()
  for (const m of [...modules]) {
    if (m.kind !== "capability") continue
    const next = reconcileCapability(m, list, capabilityParts)
    const same = (a: ModuleInfo, b: ModuleInfo) => JSON.stringify({ ...a, revision: 0 }) === JSON.stringify({ ...b, revision: 0 })
    if (!same(m, next)) setModule(m.id, () => next)
  }
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
    if (id === "claude-subscription" && m.settings.values.optIn !== true) {
      const message = "Switch on \"Use my Claude subscription\" first: you accept that this use of your subscription is not clearly allowed."
      setModule(id, (x) => ({ ...x, state: "error", error: message, tools: [] }))
      result(c, requestId, false, { code: "module_start_failed", message, moduleId: id })
      return
    }
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
    const status = id === "home-assistant"
      ? { text: "Connected to Home · 42 devices", tone: "ok" as const }
      : id === "notes"
      ? { text: "12 notes in Inbox", tone: "neutral" as const }
      : id === "claude-subscription"
      ? { text: `Ready · ${String(m.settings.values.model)} · max plan`, tone: "ok" as const }
      : m.status
    // Its declared routes are published again with the start.
    const routes = initialModules().find((x) => x.id === id)?.routes
    setModule(id, (x) => ({ ...x, state: "running", tools, ...(status !== undefined ? { status } : {}), ...(routes !== undefined ? { routes } : {}) }))
    result(c, requestId, true)
    if (id === "claude-subscription") refreshEngine()
  })
}

const onClientMessage = (c: Conn, m: ClientMessage) => {
  if (m.type !== "ping" && m.type !== "playback.progress") log(c.id, "←", m.type)
  if (m.type !== "ping" && m.type !== "hello") clientLog.push({ at: Date.now(), conn: c.id, ...m })
  switch (m.type) {
    case "hello":
      return
    case "audio.claim": {
      const v = sessionFor(c)
      if (v === undefined) return sendTo(c, { type: "error", error: { code: "bad_message", message: "The admin page cannot use the audio." } })
      // Protocol 6: a claim that would start one more session than MAX_VOICE_SESSIONS is refused.
      if (!startSession(v)) return sendTo(c, { type: "error", error: sessionsFull() })
      // Within the device, the last claim wins (another device is never touched).
      const previous = v.owner
      if (previous !== undefined && previous !== c && v.reply !== undefined) {
        if (v.reply.owner === previous) sendTo(previous, { type: "reply.stop", turnId: v.reply.turnId })
        interruptReply(v.reply)
      }
      v.owner = c
      v.lastOwnerClientId = c.clientId
      v.micLive = true
      c.lastSeq = undefined
      for (const x of connsOf(v)) sendTo(x, { type: "session", role: x === c ? "owner" : "observer", ownerPresent: true, reason: x === previous ? "taken_over" : "claimed" })
      v.awakeUntil = 0
      voice.setHolder(v, undefined)
      setState(v, restingState(v))
      devicesChanged()
      sessionsChanged()
      if (scenario === "voice" || scenario === "drop-mid-reply") after(900, () => runVoiceTurn(v))
      if (scenario === "wake") runWakeScript(v)
      if (scenario === "takeover") {
        after(1500, () => {
          if (v.owner !== c) return
          v.owner = undefined
          v.lastOwnerClientId = "c-another-tab"
          sendTo(c, { type: "session", role: "observer", ownerPresent: true, reason: "taken_over" })
          for (const x of connsOf(v)) if (x !== c) sendTo(x, { type: "session", role: "observer", ownerPresent: true, reason: "claimed" })
          setState(v, "listening")
        })
      }
      return
    }
    case "audio.release": {
      const v = sessionFor(c)
      if (v === undefined || v.owner !== c) return
      v.owner = undefined
      if (v.reply !== undefined) interruptReply(v.reply)
      sessionUpdate(v, "released")
      setState(v, "idle")
      return
    }
    case "audio.config":
      return
    case "mic.state": {
      const v = sessionFor(c)
      if (v === undefined || v.owner !== c) return sendTo(c, { type: "error", error: { code: "not_owner", message: "Only the audio owner can do that." } })
      v.micLive = m.live
      c.lastSeq = undefined
      if (v.reply === undefined) setState(v, restingState(v))
      return
    }
    case "playback.started": {
      const r = sessionFor(c)?.reply
      if (r === undefined || r.turnId !== m.turnId || r.started !== undefined) return
      r.started = { at: Date.now(), outputLatencyMs: m.outputLatencyMs, startDelayMs: m.startDelayMs }
      r.lastReport = Date.now()
      r.playedClause = 0
      setState(r.session, "speaking", r.turnId)
      toSession(r.session, { type: "assistant.playing", turnId: r.turnId, clause: 0 })
      if (scenario === "drop-mid-reply" && r.dropScheduled !== true) {
        r.dropScheduled = true
        r.timers.push(setTimeout(() => dropAll(), 800))
      }
      return
    }
    case "playback.progress":
    case "playback.finished":
    case "playback.stopped": {
      const r = sessionFor(c)?.reply
      if (r === undefined || r.turnId !== m.turnId) return
      r.lastReport = Date.now()
      if (m.type === "playback.stopped" && m.exact === false) {
        // As the real server: a provisional count is kept, not used, while an exact one may still come within the
        // stop's 300 ms (interruptReply's timer; or one started here when the page stopped on its own), and used if
        // none does. A second provisional count is ignored.
        if (r.provisional !== undefined) return
        r.provisional = m.playedSamples
        if (r.awaitingStop !== true) r.timers.push(setTimeout(() => endStopped(r), 300))
        return
      }
      playedTo(r, m.playedSamples)
      if (m.type === "playback.finished") endTurn(r, "completed")
      if (m.type === "playback.stopped") endTurn(r, "interrupted")
      return
    }
    case "interrupt": {
      const v = sessionFor(c)
      const r = v?.reply
      if (m.turnId !== undefined && m.turnId !== r?.turnId) return
      if (r !== undefined) interruptReply(r)
      // As the server: Stop also cancels the sentence being heard.
      if (v !== undefined) cancelHearing(v, undefined)
      return
    }
    case "text.send": {
      if (engine.state !== "ready") return result(c, m.requestId, false, { code: "engine_failed", message: "The assistant's engines are not running; see Settings → Overview." })
      const v = sessionFor(c)
      if (v === undefined) return result(c, m.requestId, false, { code: "bad_message", message: "The admin page has no conversation." })
      // Protocol 7: the assistant named (the voice page names the conversation it shows) must be on the device.
      if (m.assistantId !== undefined && !voice.setupFor(c.deviceId).assistants.some((a) => a.id === m.assistantId)) {
        return result(c, m.requestId, false, { code: "unknown_assistant", message: `${m.assistantId} is not one of the assistants on this device.` })
      }
      if (!startSession(v)) return result(c, m.requestId, false, sessionsFull())
      result(c, m.requestId, true)
      const spoken = c === v.owner && m.speak
      const lower = m.text.toLowerCase()
      const clauses = lower.includes("time")
        ? ["It's twenty past four in the afternoon in Tokyo."]
        : lower.includes("long") || lower.includes("story")
        ? ["Once upon a time, in a city of canals,", "a small boat carried letters from door to door,", "and every evening the boatman sang the names of the streets,", "so that the houses would remember them."]
        : ["You said: " + m.text.slice(0, 80) + ".", "This is the mock assistant, so that is all I can say."]
      const tool = lower.includes("time") ? { name: "current_time", moduleId: "clock", input: { zone: "Asia/Tokyo" }, ms: 3 } : lower.includes("fail") ? { name: "weather", moduleId: "weather", input: { place: "Atlantis" }, ms: 3000, ok: false, error: "Weather service did not answer within 3000 ms" } : undefined
      runReply(v, { source: "text", userText: m.text, clauses, spoken, assistantId: m.assistantId, ...(tool !== undefined ? { tool } : {}) })
      sessionsChanged()
      return
    }
    case "module.enable":
    case "module.disable": {
      const mod = modules.find((x) => x.id === m.moduleId)
      if (mod === undefined) return result(c, m.requestId, false, { code: "unknown_module", message: `No module ${m.moduleId}.` })
      if (refuseLocked(c, m.requestId, mod.protected)) return
      // A capability runs while an assistant has it on (WP-12b): the switch is the assistant's.
      if (mod.kind === "capability") return result(c, m.requestId, false, { code: "not_allowed", message: `${mod.name} is switched on and off per assistant: change it on the assistant's Modules tab.` })
      if (m.type === "module.enable") {
        startModule(c, m.requestId, m.moduleId)
        return
      }
      // As the real host: its routes are withdrawn when it starts stopping (its tokens are kept).
      setModule(m.moduleId, (x) => {
        const { error: _e, status: _s, routes: _r, ...rest } = x
        return { ...rest, enabled: false, state: "stopping", tools: [] }
      })
      result(c, m.requestId, true)
      after(400, () => {
        setModule(m.moduleId, (x) => ({ ...x, state: "disabled" }))
        if (m.moduleId === "claude-subscription") refreshEngine()
      })
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
      if (mod.kind === "capability") {
        // The instances follow the new shared values; a token that works clears an injected failure.
        if (tokenGood === true) forcedErrors.delete(m.moduleId)
        syncCapabilities()
        result(c, m.requestId, true)
      } else if (mod.state === "error" && mod.enabled) startModule(c, m.requestId, m.moduleId)
      else result(c, m.requestId, true)
      return
    }
    case "settings.update": {
      const i = sections.findIndex((s) => s.id === m.sectionId)
      if (i === -1) return result(c, m.requestId, false, { code: "unknown_section", message: `No section ${m.sectionId}.` })
      const section = sections[i]!
      if (refuseLocked(c, m.requestId, section.protected)) return
      // P8: the risk policy as the server checks it (`riskPolicyValueProblem`, the same function): a settable class takes
      // one of the three outcomes, money and security only Refuse (or back to the default), and those two are never
      // written.
      if (section.id === "risk") {
        const problems = riskPolicyPatchProblems(m.patch.values)
        if (problems.length > 0) return result(c, m.requestId, false, { code: "invalid_settings", message: problems[0]!.message, fieldErrors: problems })
      }
      const fixedKey = (k: string) => section.id === "risk" && FIXED_RISK_CLASSES.some((cls) => RISK_POLICY_KEYS[cls] === k)
      // Fields hidden after the patch (visibleWhen) are neither validated nor saved, as on the real server.
      const after = (key: string) => (Object.hasOwn(m.patch.values, key) && m.patch.values[key] !== null ? m.patch.values[key] : valueOf(key))
      const shown = (key: string) => holds(section.form.fields.find((f) => f.key === key)?.visibleWhen, after)
      const patch: SettingsPatch = {
        values: Object.fromEntries(Object.entries(m.patch.values).filter(([k]) => shown(k) && !fixedKey(k))),
        secrets: Object.fromEntries(Object.entries(m.patch.secrets).filter(([k]) => shown(k)))
      }
      const errors = validate(section.form, patch)
      if (errors.length > 0) return result(c, m.requestId, false, { code: "invalid_settings", message: "Some settings are not valid.", fieldErrors: errors })
      // Protocol 11: Members is checked as the server checks it (`checkMembersValue` and `checkDietList`, the same
      // functions), and every new person gets an id.
      if (section.id === "members") {
        const problems: Array<{ key: string; message: string }> = []
        const list = patch.values.HOUSEHOLD_MEMBERS
        if (list !== undefined && list !== null) {
          const problem = checkMembersValue(list)
          if (problem !== undefined) problems.push({ key: "HOUSEHOLD_MEMBERS", message: problem })
        }
        for (const key of ["HOUSEHOLD_DIET_ALLERGIES", "HOUSEHOLD_DIET_DIETS", "HOUSEHOLD_DIET_DISLIKES"]) {
          const value = patch.values[key]
          const problem = value === null ? undefined : checkDietList(section.form.fields.find((f) => f.key === key)?.label ?? key, value)
          if (problem !== undefined) problems.push({ key, message: problem })
        }
        if (problems.length > 0) return result(c, m.requestId, false, { code: "invalid_settings", message: problems[0]!.message, fieldErrors: problems })
        withPersonIds(patch)
      }
      const candidate = sections.map((x, j) => (j === i ? { ...x, form: applyPatch(x.form, patch) } : x))
      const fresh = <E extends FieldError>(a: ReadonlyArray<E>, b: ReadonlyArray<E>) => b.filter((e) => !a.some((x) => x.key === e.key && x.message === e.message))
      const before = checks(sections)
      const later = checks(candidate)
      const newErrors = fresh(before.errors, later.errors).map(({ key, message }) => ({ key, message }))
      if (newErrors.length > 0) return result(c, m.requestId, false, { code: "invalid_settings", message: newErrors[0]!.message, fieldErrors: newErrors })
      const newWarnings = fresh(before.warnings, later.warnings).map(({ key, message }) => ({ key, message }))
      if (newWarnings.length > 0 && m.confirmWarnings !== true) {
        return result(c, m.requestId, false, { code: "invalid_settings", message: "Check the warnings below, then save anyway or change the settings", warnings: newWarnings })
      }
      const membersBefore = memberIds()
      const boundariesBefore = boundaries()
      const committed = withWarnings(candidate)
      const changed = new Set(committed.filter((x, j) => j === i || JSON.stringify(x.form) !== JSON.stringify(sections[j]!.form)).map((x) => x.id))
      sections = committed.map((x) => (changed.has(x.id) ? { ...x, revision: x.revision + 1 } : x))
      for (const x of sections) if (changed.has(x.id)) broadcast({ type: "section.changed", section: x })
      if (changed.has("routing")) routingChanged()
      if (changed.has("llm-openai-accounts")) assistantsChanged()
      if (changed.has("members")) {
        const removed = [...membersBefore].some((id) => !memberIds().has(id))
        // As the server: a removed person's id is retired, never issued or kept again.
        for (const id of membersBefore) if (!memberIds().has(id)) retiredMemberIds.add(id)
        if (assistantsMock.clearDefaultPeople(memberIds())) assistantsChanged()
        // As the server: a person leaving Members ends every device's session.
        if (removed) endChangedSessions(boundariesBefore, true)
      }
      result(c, m.requestId, true)
      // P10, as the server: every saved settings change decides every device's presentations again (the language too).
      reconcilePresentEverywhere()
      const needsReload = Object.keys({ ...patch.values, ...patch.secrets }).some((k) => section.form.fields.find((f) => f.key === k)?.apply === "reload")
      const path = `${section.group ?? "general"}/${section.page?.id ?? section.id}`
      if (needsReload && (!engine.reloadPending || !(engine.reloadPendingFor ?? []).includes(path))) {
        engine = { ...engine, reloadPending: true, reloadPendingFor: [...(engine.reloadPendingFor ?? []).filter((p) => p !== path), path] }
        broadcast({ type: "engine", engine })
      }
      return
    }
    case "module.action": {
      if (requireAdmin(c, m.requestId)) return
      const mod = modules.find((x) => x.id === m.moduleId)
      if (mod === undefined) return result(c, m.requestId, false, { code: "unknown_module", message: `No module ${m.moduleId}.` })
      const field = mod.settings.fields.find((f) => f.key === m.key)
      if (field?.type !== "action") return result(c, m.requestId, false, { code: "unknown_action", message: `${mod.name} has no action "${m.key}"` })
      // As the host: an instance's button needs its module running; one press per button at a time.
      if (mod.state !== "running" && !DEMO_DEFINITION_ACTIONS.has(`${mod.id}/${m.key}`)) {
        return result(c, m.requestId, false, { code: "not_running", message: `${mod.name} is not running` })
      }
      const pressKey = `${mod.id}/${m.key}`
      if (pressing.has(pressKey)) return result(c, m.requestId, false, { code: "busy", message: "That button is still running" })
      pressing.add(pressKey)
      const values = !field.requiresSaved && m.values !== undefined ? { ...mod.settings.values, ...m.values } : mod.settings.values
      const action = demoHomeAction(m.key, values) ?? { ok: true, text: "Done.", tone: "ok" as const }
      after(500, () => {
        pressing.delete(pressKey)
        sendTo(c, { type: "result", requestId: m.requestId, ok: true, action })
      })
      return
    }
    case "health.check": {
      if (requireAdmin(c, m.requestId)) return
      // As the server: the current health first, then the result; the outcome follows as `health`. A check already
      // running is joined, not started again (one completion for any number of requests).
      const state = { health }
      answerHealthCheck(state, {
        send: (message) => sendTo(c, message),
        broadcast: (message) => {
          health = state.health
          broadcast(message)
        },
        result: () => result(c, m.requestId, true),
        after,
        finished: (h) => ({ ...h, issues: h.issues.filter((i) => i.id !== "music.speaker.kitchen"), checkedAt: Date.now() })
      })
      health = state.health
      return
    }
    case "engine.reload": {
      if (requireAdmin(c, m.requestId)) return
      if (engine.state === "reloading") return result(c, m.requestId, false, { code: "busy", message: "A reload is already running." })
      for (const v of voiceSessions.values()) if (v.reply !== undefined) interruptReply(v.reply)
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
      if (requireAdmin(c, m.requestId)) return
      if (vault.state !== "none") return result(c, m.requestId, false, { code: "busy", message: `A vault already exists at ${VAULT_LOCATION}` })
      if (m.password.length < 8) return result(c, m.requestId, false, { code: "bad_password", message: "The password must be at least 8 characters" })
      vault = { state: "unlocked", password: m.password }
      result(c, m.requestId, true)
      vaultChanged()
      return
    }
    case "vault.unlock": {
      if (requireAdmin(c, m.requestId)) return
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
      if (requireAdmin(c, m.requestId)) return
      if (vault.state === "none") return result(c, m.requestId, false, { code: "locked", message: "There is no key vault yet: set a password first" })
      vault = { ...vault, state: "locked", lockReason: "manual" }
      result(c, m.requestId, true)
      vaultChanged()
      return
    }
    case "vault.changePassword": {
      if (requireAdmin(c, m.requestId)) return
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
    case "settings.moveFromEnv":
      if (requireAdmin(c, m.requestId)) return
      return moveFromEnv(c, m.requestId, m.keys)
    case "job.start":
      if (requireAdmin(c, m.requestId)) return
      return startDownload(c, m.requestId, m.tool, m.target)
    case "job.cancel":
      if (requireAdmin(c, m.requestId)) return
      return cancelJob(c, m.requestId, m.jobId)
    case "model.delete":
      if (requireAdmin(c, m.requestId)) return
      return deleteModel(c, m.requestId, m.tool, m.target)
    case "admin.login": {
      if (!adminEnabled()) return result(c, m.requestId, false, { code: "admin_required", message: "Admin is switched off: set PVA_ADMIN_PASSWORD in .env and restart." })
      const wait = loginRefusedUntil - Date.now()
      if (wait > 0) {
        result(c, m.requestId, false, { code: "bad_password", message: `Too many wrong passwords: try again in ${Math.ceil(wait / 1000)} s.` })
        return sendTo(c, { type: "admin.state", admin: adminState(c) })
      }
      if (m.password !== ADMIN_PASSWORD) {
        loginFailures++
        // The same back-off as vault unlocks: free tries, then a growing wait (admin-backoff: 30 s at once).
        const refuse = scenario === "admin-backoff" ? 30_000 : loginFailures >= 3 ? Math.min(60_000, 5_000 * 2 ** (loginFailures - 3)) : 0
        if (refuse > 0) loginRefusedUntil = Date.now() + refuse
        result(c, m.requestId, false, { code: "bad_password", message: "Wrong password." })
        return sendTo(c, { type: "admin.state", admin: adminState(c) })
      }
      loginFailures = 0
      const token = randomBytes(32).toString("base64url")
      const expiresAt = Date.now() + 12 * HOUR
      sessions.set(token, { expiresAt })
      c.session = token
      sendTo(c, { type: "result", requestId: m.requestId, ok: true, admin: { token, expiresAt } })
      sendTo(c, { type: "admin.state", admin: adminState(c) })
      sendAdminSnapshot(c)
      return
    }
    case "admin.logout": {
      if (logoutFails) return result(c, m.requestId, false, { code: "internal", message: "The assistant could not log you out." })
      result(c, m.requestId, true)
      if (c.session !== undefined) endSessions("logout", c.session)
      return
    }
    case "device.forget": {
      if (requireAdmin(c, m.requestId)) return
      const record = devices.get(m.id)
      if (record === undefined) return result(c, m.requestId, false, { code: "unknown_device", message: "This device is not known (any more)." })
      const before = boundaries()
      devices.delete(m.id)
      assistantsMock.forgetDevice(m.id)
      // As the server: a connected device's session ends (known → not known); its pages say hello again as a new device.
      endChangedSessions(before)
      pushSetups()
      result(c, m.requestId, true)
      devicesChanged()
      return
    }
    case "assistant.create": {
      if (requireAdmin(c, m.requestId)) return
      const warned = assistantVoiceWarning(m.assistant.voice, m.saveAnyway === true)
      if (warned !== undefined) return result(c, m.requestId, false, warned)
      const r = assistantsMock.create(m, [...devices.values()].map((d) => ({ id: d.id, name: d.name })))
      sendTo(c, r.ok ? { type: "result", requestId: m.requestId, ok: true, ...(r.assistantId !== undefined ? { assistantId: r.assistantId } : {}) } : { type: "result", requestId: m.requestId, ok: false, ...(r.error !== undefined ? { error: r.error } : {}) })
      if (r.ok) assistantsChanged()
      return
    }
    case "assistant.save": {
      if (requireAdmin(c, m.requestId)) return
      const r = assistantsMock.save(m)
      sendTo(c, r.ok ? { type: "result", requestId: m.requestId, ok: true } : { type: "result", requestId: m.requestId, ok: false, ...(r.error !== undefined ? { error: r.error } : {}) })
      if (r.ok) assistantsChanged()
      return
    }
    case "assistant.delete": {
      if (requireAdmin(c, m.requestId)) return
      const r = assistantsMock.remove(m, [...devices.values()].map((d) => ({ id: d.id, name: d.name })))
      sendTo(c, r.ok ? { type: "result", requestId: m.requestId, ok: true } : { type: "result", requestId: m.requestId, ok: false, ...(r.error !== undefined ? { error: r.error } : {}) })
      if (r.ok) assistantsChanged()
      return
    }
    case "device.save": {
      if (requireAdmin(c, m.requestId)) return
      if (m.target.kind === "device" && !devices.has(m.target.id)) return result(c, m.requestId, false, { code: "unknown_device", message: "That device is not known." })
      // The name went through the protocol's `SavedDeviceName` (one line, no control characters) when it was decoded.
      const name = m.name === undefined ? undefined : m.name.trim()
      if (name !== undefined && m.target.kind === "device" && name === "") return result(c, m.requestId, false, { code: "invalid_settings", message: "A device needs a name.", fieldErrors: [{ key: "name", message: "A device needs a name." }] })
      const before = boundaries()
      const r = assistantsMock.saveDevice(m)
      if (r.ok && name !== undefined && m.target.kind === "device") {
        const record = devices.get(m.target.id)
        if (record !== undefined) record.name = name
      }
      sendTo(c, r.ok ? { type: "result", requestId: m.requestId, ok: true } : { type: "result", requestId: m.requestId, ok: false, ...(r.error !== undefined ? { error: r.error } : {}) })
      if (r.ok) {
        // As the server: privacy, the default person or an output override changed: those devices' sessions end.
        endChangedSessions(before)
        assistantsChanged()
      }
      return
    }
    case "wake.test": {
      if (requireAdmin(c, m.requestId)) return
      if (m.deviceId !== undefined && !devices.has(m.deviceId)) return result(c, m.requestId, false, { code: "unknown_device", message: "This device is not known (any more)." })
      if (m.on) {
        c.testerUntil = Date.now() + WAKE_TEST_MAX_MS
        c.testerDevice = m.deviceId
      } else {
        c.testerUntil = undefined
        c.testerDevice = undefined
      }
      result(c, m.requestId, true)
      return
    }
    case "conversation.new": {
      // Protocol 6: this device's conversation only; the running turn stops, the history goes, its tabs are told.
      const v = sessionFor(c)
      if (v === undefined) return result(c, m.requestId, false, { code: "bad_message", message: "The admin page has no conversation." })
      if (m.assistantId !== undefined && !voice.setupFor(c.deviceId).assistants.some((a) => a.id === m.assistantId)) {
        return result(c, m.requestId, false, { code: "unknown_assistant", message: `${m.assistantId} is not one of the assistants on this device.` })
      }
      result(c, m.requestId, true)
      newConversation(v, "new", m.assistantId)
      return
    }
    case "device.pick": {
      // Protocol 7: who answers without a phrase on this device; written to the device's own settings (admin sees it).
      if (c.frontend !== "voice" || c.deviceId === undefined) return result(c, m.requestId, false, { code: "bad_message", message: "This page did not say which device it is; reload it." })
      const r = voice.pick(c.deviceId, m.withoutPhrase)
      sendTo(c, r.ok ? { type: "result", requestId: m.requestId, ok: true } : { type: "result", requestId: m.requestId, ok: false, ...(r.error !== undefined ? { error: r.error } : {}) })
      if (!r.ok) return
      // As the server: an accepted pick closes the device's armed and follow-up windows (a reply in flight keeps its
      // turn), and the state that follows names who has the turn; the page does not guess.
      const v = sessionFor(c)
      if (v !== undefined) {
        voice.setHolder(v, undefined)
        v.awakeUntil = 0
        if (v.awakeTimer !== undefined) clearTimeout(v.awakeTimer)
        v.awakeTimer = undefined
      }
      assistantsChanged()
      if (v !== undefined) setState(v, v.reply === undefined && (v.state === "listening" || v.state === "asleep") ? restingState(v) : v.state)
      return
    }
    case "conversation.read": {
      // Protocol 7: another assistant's conversation on this device; answered to the requester, nothing else changes.
      const v = sessionFor(c)
      if (c.frontend !== "voice" || v === undefined) return result(c, m.requestId, false, { code: "bad_message", message: "Conversations are read on a voice page." })
      if (!voice.setupFor(c.deviceId).assistants.some((a) => a.id === m.assistantId)) {
        return result(c, m.requestId, false, { code: "unknown_assistant", message: `${m.assistantId} is not one of the assistants on this device.` })
      }
      const conv = voice.convFor(v, m.assistantId)
      // As the server: the turn whose exchange ends the history (here its user message is noted when the turn starts).
      const lastTurnId = lastTurnOf.get(conv)
      sendTo(c, { type: "conversation.history", requestId: m.requestId, assistantId: m.assistantId, id: conv.conversation.id, history: clone(conv.history.slice(-200)), ...(lastTurnId !== undefined ? { lastTurnId } : {}) })
      return
    }
    case "ping":
      sendTo(c, { type: "pong", id: m.id })
      return
    case "notification.action": {
      // P9, as the real server: from a voice page of the card's device; `stop` always works; another action needs its
      // module's handler (POST /mock/notify with "handlerDown": true makes it answer "I can't do that right now").
      if (c.frontend !== "voice" || c.deviceId === undefined) return result(c, m.requestId, false, { code: "bad_message", message: "A notification is answered from a voice page of its device" })
      const n = mockNotifications.get(m.id)
      const texts = mockNotifyTexts()
      const cant = { type: "result" as const, requestId: m.requestId, ok: false, error: { code: "not_running" as const, message: texts.cantNow }, say: texts.cantNow }
      // As the server: only a connection that holds the card may press it (Stop too), and only while the decision
      // still allows it on the device (a page whose card should have gone is reconciled, and refused).
      if (mockHeld.get(c.id)?.has(m.id) !== true || n === undefined) return sendTo(c, { ...cant, error: { code: "bad_message", message: cant.say } })
      if (!decideMock(c.deviceId, n).deliver) {
        for (const x of notifyConns(c.deviceId)) reconcileMock(x)
        return sendTo(c, { ...cant, error: { code: "bad_message", message: cant.say } })
      }
      if (m.actionId !== "stop" && !n.card.actions.some((a) => a.id === m.actionId)) return sendTo(c, { ...cant, error: { code: "bad_message", message: cant.say } })
      if (m.actionId !== "stop" && n.handlerDown) return sendTo(c, cant)
      // P8, as the real gateway: a module's action is decided by the saved policy (its class: change); `stop` is the host's.
      const refusedN = m.actionId === "stop" ? undefined : mockPressRefusal()
      if (refusedN !== undefined) return sendTo(c, { type: "result", requestId: m.requestId, ok: false, error: { code: "bad_message", message: refusedN }, say: refusedN })
      resolveMockNotification(m.id, m.actionId)
      return sendTo(c, { type: "result", requestId: m.requestId, ok: true, say: texts.done })
    }
    case "present.action": {
      // P10, as the real server: only from a connection that holds it, while the decision (with its own kinds) lets it be
      // pressed there; a tick of an item it has (the mock acts as the module: it ticks the item and shows the change); a
      // button it has; its handler down ("handlerDown": true) answers "I can't do that right now".
      if (c.frontend !== "voice" || c.deviceId === undefined) return result(c, m.requestId, false, { code: "bad_message", message: "A presentation is answered from a voice page of its device" })
      pruneEndedMock()
      const p = mockPresentations.get(m.id)
      const texts = mockPresentTexts()
      const cant = (code: "bad_message" | "not_running") => sendTo(c, { type: "result", requestId: m.requestId, ok: false, error: { code, message: texts.cantNow }, say: texts.cantNow })
      if (mockPresentHeld.get(c.id)?.has(m.id) !== true || p === undefined) return cant("bad_message")
      const d = decidePresentMock(c, p.presentation.kind)
      if (!d.show || !d.interactive || p.presentation.handler === undefined) {
        reconcilePresentMock(c)
        return cant("bad_message")
      }
      if (m.action === "tick") {
        const list = p.presentation
        if (list.kind !== "list" || list.style !== "checklist" || m.done === undefined || !list.items.some((i) => i.id === m.item)) return cant("bad_message")
        if (p.handlerDown) return cant("not_running")
        const refusedTick = mockPressRefusal()
        if (refusedTick !== undefined) return sendTo(c, { type: "result", requestId: m.requestId, ok: false, error: { code: "bad_message", message: refusedTick }, say: refusedTick })
        p.presentation = { ...list, items: list.items.map((i) => (i.id === m.item ? { ...i, done: m.done! } : i)) }
        reconcilePresentEverywhere()
        return sendTo(c, { type: "result", requestId: m.requestId, ok: true, say: texts.done })
      }
      if (!(p.presentation.buttons ?? []).some((b) => b.id === m.action)) return cant("bad_message")
      if (p.handlerDown) return cant("not_running")
      const refusedButton = mockPressRefusal()
      if (refusedButton !== undefined) return sendTo(c, { type: "result", requestId: m.requestId, ok: false, error: { code: "bad_message", message: refusedButton }, say: refusedButton })
      return sendTo(c, { type: "result", requestId: m.requestId, ok: true, say: texts.done })
    }
    case "device.caps": {
      // Protocol 11: what the device can do changed, or its live state; admin's device list follows.
      if (c.frontend !== "voice" || c.deviceId === undefined) return
      const record = devices.get(c.deviceId)
      if (m.capabilities !== undefined && record !== undefined) devices.set(c.deviceId, { ...record, declared: { capabilities: m.capabilities, seenAt: Date.now() } })
      if (m.capabilities !== undefined) {
        c.ownCaps = m.capabilities
        for (const x of notifyConns(c.deviceId)) reconcilePresentMock(x)
      }
      if (m.live !== undefined) {
        c.visible = m.live.visible
        if (m.live.lastInteractionAt !== undefined) c.lastInteractionAt = m.live.lastInteractionAt
      }
      devicesChanged()
      // Whether replies are spoken here follows what it declared (the setup says so); so do its notification cards.
      if (m.capabilities !== undefined) {
        pushSetups()
        for (const x of notifyConns(c.deviceId)) reconcileMock(x)
      }
      return
    }
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
  const c: Conn = { ws, id: `conn-${++connSeq}`, welcomed: false, micFrames: 0, micGaps: 0, lastSeq: undefined, frontend: "voice" }
  conns.add(c)
  log(c.id, "connected")
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (!c.welcomed) return ws.close(CloseCode.badMessage)
      const frame = decodeMicFrame(data)
      if (!frame.ok || c !== sessionFor(c)?.owner) return
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
      c.frontend = m.frontend
      const tokenSent = m.frontend === "admin" ? m.adminToken : undefined
      if (tokenSent !== undefined && sessions.has(tokenSent)) c.session = tokenSent
      if (m.frontend === "voice" && m.device !== undefined) {
        const now = Date.now()
        const known = devices.get(m.device.id)
        const declared = m.device.capabilities !== undefined ? { declared: { capabilities: m.device.capabilities, seenAt: now } } : {}
        devices.set(m.device.id, known === undefined
          ? { id: m.device.id, kind: m.device.kind, name: cleanDeviceName(m.device.name), firstSeen: now, lastSeen: now, ...declared }
          : { ...known, lastSeen: now, ...declared })
        c.deviceId = m.device.id
        c.ownCaps = m.device.capabilities
      }
      c.welcomed = true
      const v = sessionFor(c)
      if (v?.discardTimer !== undefined) {
        clearTimeout(v.discardTimer)
        v.discardTimer = undefined
      }
      const resumed = v !== undefined && m.resumeOwner && v.owner === undefined && v.lastOwnerClientId === m.clientId
      if (resumed) {
        v.owner = c
        c.lastSeq = undefined
      }
      // Protocol 7: the voice page learns its device's setup and has one conversation per assistant; the snapshot's
      // history is the answering assistant's.
      const setup = m.frontend === "voice" ? voice.setupFor(c.deviceId) : undefined
      if (setup !== undefined) lastSetup.set(c, JSON.stringify(setup))
      const answering = v === undefined ? undefined : voice.convFor(v, voice.answeringOf(v, c.deviceId))
      sendTo(c, {
        type: "welcome",
        protocol: PROTOCOL_VERSION,
        server: { name: "pva-mock", version: "0.0.0" },
        connectionId: c.id,
        snapshot: {
          // Protocol 6: about the device's own session; an admin connection has none.
          state: v === undefined ? "idle" : resumed ? restingState(v) : v.state,
          role: v !== undefined && c === v.owner ? "owner" : "observer",
          ownerPresent: v !== undefined && ownerPresentIn(v),
          engine: engineSummary(engine),
          // Who has the turn now (an armed assistant too), apart from whose history this is.
          ...(v !== undefined && m.frontend === "voice" ? { holder: holderNow(v) } : {}),
          history: answering === undefined ? [] : answering.history.slice(-200),
          admin: adminState(c, tokenSent !== undefined && c.session === undefined ? { endReason: "token" } : {}),
          ...(setup !== undefined ? { setup, conversations: voice.conversationsOf(v, setup) } : { conversations: [] })
        }
      })
      if (isAdminConn(c)) sendAdminSnapshot(c)
      volumeAfterWelcome(c)
      notificationsAfterWelcome(c)
      // P10: every page of the device, as the server (a hello may have changed what it declared).
      if (c.deviceId === undefined) reconcilePresentMock(c)
      else for (const x of notifyConns(c.deviceId)) reconcilePresentMock(x)
      if (c.deviceId !== undefined) devicesChanged()
      if (resumed) {
        sessionUpdate(v, "resumed")
        setState(v, restingState(v))
      }
      return
    }
    onClientMessage(c, m)
  })
  ws.on("close", () => {
    conns.delete(c)
    mockHeld.delete(c.id)
    for (const h of mockPresentHeld.get(c.id)?.values() ?? []) if (h.token !== undefined) mockMediaTokens.delete(h.token)
    mockPresentHeld.delete(c.id)
    log(c.id, "closed")
    if (c.deviceId !== undefined) for (const x of notifyConns(c.deviceId)) reconcilePresentMock(x)
    if (c.deviceId !== undefined) {
      const record = devices.get(c.deviceId)
      if (record !== undefined) record.lastSeen = Date.now()
    }
    const v = keyOf(c) === undefined ? undefined : voiceSessions.get(keyOf(c)!)
    if (v !== undefined && v.owner === c) {
      v.owner = undefined
      if (v.reply !== undefined && v.reply.owner === c) {
        toSession(v, { type: "error", error: { code: "turn_failed", message: "The audio client disconnected during the reply.", turnId: v.reply.turnId } })
        endTurn(v.reply, "failed")
      }
      sessionUpdate(v, "owner_disconnected")
      setState(v, "idle")
    }
    if (v !== undefined && connsOf(v).length === 0) scheduleDiscard(v)
    if (c.deviceId !== undefined) devicesChanged()
  })
})


// ---------------------------------------------------------------------------
// The voice picker's HTTP API (docs/VOICE-PROVIDERS.md §5), under /api/
// ---------------------------------------------------------------------------

/** Favourites, as `data/voice-favourites.json` would hold them: one Cartesia voice (no key yet) among them. */
function initialFavourites(): Array<Favourite> {
  const at = Date.UTC(2026, 10, 10)
  const fav = (provider: string, voiceId: string, name: string, i: number): Favourite => ({ voice: { provider, voiceId }, key: `${provider}:${voiceId}`, name, addedAt: at + i * 60_000 })
  return [
    fav("elevenlabs", "mk2Ls1fsHW4xr9Ic3Bb2", "Charlotte", 0),
    fav("sherpa", "kokoro-af_heart", "Heart", 1),
    fav("cartesia", "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", "Skylar", 2),
    fav("elevenlabs", "mk3Mt2gtIX5ys0Jd4Cc3", "Daniel", 3),
    fav("sherpa", "en_US-lessac-medium", "Lessac", 4)
  ]
}
let favourites: Array<Favourite> = initialFavourites()
/** The model pickers (mock/modelPickers.ts), on the mock's own sections, modules, assistants and jobs. */
const modelPickers = createModelPickersMock({
  secretSet: (key) => secretSet(key),
  valueOf: (key) => valueOf(key),
  vaultLocked: () => vault.state === "locked",
  subscriptionRunning: () => modules.some((m) => m.id === "claude-subscription" && m.enabled && m.state === "running"),
  assistants: () => assistantsMock.assistants(),
  sttItems: () => models.find((m) => m.tool === "stt-models")?.items ?? [],
  runningJob: (target) => jobs.find((j) => j.tool === "stt-models" && j.target === target && j.state === "running"),
  startJob: (target) => startJob("stt-models", target),
  stopJob: (id) => stopJob(id)
})
/** POST /mock/voices/fail {"provider", "on"}: a hosted provider whose key is refused (status `error`). */
const providerFailures = new Set<string>()
/** POST /mock/voices/hold {"ms"}: previews answer after this long (default 300 ms). */
let previewHold = 0
let pendingPreview: { readonly res: ServerResponse; readonly timer: ReturnType<typeof setTimeout> } | undefined

class ApiFail {
  readonly status: number
  readonly code: string
  readonly message: string
  readonly retryAfterMs: number | undefined
  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    this.status = status
    this.code = code
    this.message = message
    this.retryAfterMs = retryAfterMs
  }
}

const providerStatus = (p: (typeof MOCK_PROVIDERS)[number]): ProviderInfo => {
  const base = {
    id: p.id,
    label: p.label,
    location: p.location,
    settingsPath: "voices/providers",
    ...(p.keyField !== undefined ? { keyField: p.keyField } : {}),
    ...(p.implication !== undefined ? { implication: p.implication } : {}),
    inUse: parseVoiceKey(assistantVoiceKey())?.provider === p.id
  }
  if (p.keyField === undefined) return { ...base, status: "ready", voiceCount: p.voices.length }
  if (vault.state === "locked") return { ...base, status: "needs_key", reason: "vault_locked", message: `The keys are locked: unlock them to use ${p.label} voices.` }
  if (!secretSet(p.keyField)) return { ...base, status: "needs_key", reason: "missing", message: `Add a ${p.label} API key to use its voices.` }
  if (providerFailures.has(p.id)) return { ...base, status: "error", message: `${p.label} refused the API key (401): check it on the Voice providers page.`, voiceCount: p.voices.length }
  return { ...base, status: "ready", voiceCount: p.voices.length }
}

const providerVoices = (p: (typeof MOCK_PROVIDERS)[number]): ProviderVoices => {
  const info = providerStatus(p)
  const selected = assistantVoiceKey()
  const deviceUsers = assistantsMock.voiceUsers([...devices.values()].map((d) => ({ id: d.id, name: d.name })))
  const listed = info.status === "needs_key" ? [] : p.voices
  const voices: Array<VoiceEntry> = listed.map((v) => {
    const key = `${p.id}:${v.voiceId}`
    const item = p.location === "local" ? models.find((m) => m.tool === "tts-models")?.items.find((i) => i.id === v.voiceId) : undefined
    const job = item === undefined ? undefined : jobs.find((j) => j.tool === "tts-models" && j.target === v.voiceId && j.state === "running")
    const local = item === undefined ? undefined : { state: job !== undefined ? "downloading" as const : item.installed ? "installed" as const : "not_installed" as const, sizeMb: item.sizeMb, diskMb: item.diskMb, ...(job !== undefined ? { job } : {}) }
    return {
      voice: { provider: p.id, voiceId: v.voiceId },
      key,
      name: v.name,
      ...(v.description !== undefined ? { description: v.description } : {}),
      ...(v.language !== undefined ? { language: v.language } : {}),
      ...(v.gender !== undefined ? { gender: v.gender } : {}),
      tags: [...v.tags],
      ...(local !== undefined ? { local } : {}),
      previewable: info.status === "ready" && (local === undefined || local.state === "installed"),
      usedBy: key === selected ? ["jeff"] : [],
      usedByDevices: deviceUsers.get(key) ?? [],
      favourite: favourites.some((f) => f.key === key)
    }
  })
  return {
    provider: info,
    voices,
    ...(p.location === "hosted" && info.status !== "needs_key" ? { fetchedAt: Date.now() - 20 * 60_000 } : {}),
    stale: false,
    truncated: false,
    ...(info.status === "error" ? { error: { code: "provider_error", message: info.message ?? "The provider refused." } } : {})
  }
}

const findVoice = (ref: unknown): { provider: (typeof MOCK_PROVIDERS)[number]; voice: (typeof MOCK_PROVIDERS)[number]["voices"][number] } => {
  const r = ref as { provider?: unknown; voiceId?: unknown } | undefined
  if (typeof r?.provider !== "string" || typeof r.voiceId !== "string") throw new ApiFail(400, "invalid_request", "The request is not valid: voice")
  const provider = MOCK_PROVIDERS.find((p) => p.id === r.provider)
  if (provider === undefined) throw new ApiFail(404, "unknown_provider", `There is no voice provider "${r.provider}"`)
  const voice = provider.voices.find((v) => v.voiceId === r.voiceId)
  if (voice === undefined) throw new ApiFail(404, "unknown_voice", `${provider.label} has no voice "${r.voiceId}"`)
  return { provider, voice }
}

const needKey = (p: (typeof MOCK_PROVIDERS)[number]) => {
  const info = providerStatus(p)
  if (info.status === "needs_key") throw new ApiFail(409, "needs_key", info.message ?? `There is no ${p.label} key: add it on the Voice providers page.`)
  return info
}

const defaultVoiceInfo = () => {
  const saved = String(valueOf("ASSISTANT_VOICE") ?? "").trim()
  const key = assistantVoiceKey()
  const ref = parseVoiceKey(key)!
  const name = MOCK_PROVIDERS.find((p) => p.id === ref.provider)?.voices.find((v) => v.voiceId === ref.voiceId)?.name
  return {
    voice: ref,
    key,
    ...(name !== undefined ? { name } : {}),
    source: saved !== "" ? "saved" as const : "default" as const,
    locked: false,
    ...(engine.state === "ready" ? { running: runningVoiceKey() } : {}),
    reloadPending: (engine.reloadPendingFor ?? []).includes("voices/overview"),
    notes: [] as Array<string>
  }
}

/** Save ASSISTANT_VOICE as settings.update would (a new revision, section.changed, the reload pending). */
const saveAssistantVoice = (key: string) => {
  sections = withWarnings(sections.map((x) => (x.id === "voices" ? { ...x, form: { ...x.form, values: { ...x.form.values, ASSISTANT_VOICE: key } }, revision: x.revision + 1 } : x)))
  const section = sections.find((x) => x.id === "voices")
  if (section !== undefined) broadcast({ type: "section.changed", section })
  if (!(engine.reloadPendingFor ?? []).includes("voices/overview")) {
    engine = { ...engine, reloadPending: true, reloadPendingFor: [...(engine.reloadPendingFor ?? []), "voices/overview"] }
    broadcast({ type: "engine", engine })
  }
}

const apiRoute = async (req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<{ status: number; body: unknown } | undefined> => {
  const method = req.method ?? "GET"
  const only = (...allowed: Array<string>) => {
    if (!allowed.includes(method)) throw new ApiFail(405, "method_not_allowed", `Use ${allowed.join(", ")}`)
  }
  const body = async (): Promise<Record<string, unknown>> => {
    const text = await readBody(req)
    if (text === "") return {}
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new ApiFail(400, "invalid_request", "The request body is not valid JSON")
    }
  }
  /** A refused token operation, answered as the real server does (status and code). */
  const refusedAs = <A>(f: () => A): A => {
    try {
      return f()
    } catch (error) {
      if (error instanceof TokenRefusal) throw new ApiFail(error.status, error.code, error.message)
      throw error
    }
  }
  // P6: the scheduled jobs, a page at a time (as the real server's /api/scheduler/jobs).
  if (path === "scheduler/jobs") {
    only("GET")
    const limit = query.get("limit")
    try {
      return { status: 200, body: scheduledJobsMock.list(query.get("cursor") ?? undefined, limit === null ? undefined : Number(limit)) }
    } catch (e) {
      if (e instanceof MockSchedulerError) throw new ApiFail(e.status, e.code, e.message)
      throw e
    }
  }
  const cancelJob = /^scheduler\/jobs\/([A-Za-z0-9_.:-]{1,200})\/cancel$/.exec(path)
  if (cancelJob !== null) {
    only("POST")
    if (!scheduledJobsMock.cancel(cancelJob[1]!)) throw new ApiFail(404, "not_found", "There is no such live or failed job (it may have finished or been removed)")
    return { status: 200, body: { cancelled: true } }
  }
  // Protocol 10: the admin view of module routes and their tokens (as the real server's /api/module-routes).
  const routesMatch = /^module-routes(?:\/([a-z][a-z0-9-]{0,39})\/tokens(?:\/([a-f0-9]{8,32}))?)?$/.exec(path)
  if (routesMatch !== null) {
    const [, moduleId, tokenId] = routesMatch
    if (moduleId === undefined) {
      only("GET")
      const id = query.get("module")
      return { status: 200, body: moduleRoutesMock.view(modules.filter((x) => id === null || x.id === id)) }
    }
    // As the server: tokens only for an installed module (running or not).
    if (!modules.some((x) => x.id === moduleId)) throw new ApiFail(404, "not_found", `There is no module "${moduleId}"`)
    if (tokenId === undefined) {
      only("POST")
      const b = await body()
      if (typeof b.name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(b.name) || typeof b.label !== "string" || b.label.trim() === "") {
        throw new ApiFail(400, "invalid_request", "A token needs a name and a label")
      }
      const name = b.name
      const label = b.label
      return { status: 201, body: refusedAs(() => moduleRoutesMock.mint(moduleId, name, label)) }
    }
    only("DELETE")
    if (!refusedAs(() => moduleRoutesMock.revoke(moduleId, tokenId))) throw new ApiFail(404, "not_found", "There is no such token (it may have been revoked already)")
    return { status: 200, body: { revoked: true } }
  }
  if (path === "voice-providers") {
    only("GET")
    return { status: 200, body: { providers: MOCK_PROVIDERS.map(providerStatus) } }
  }
  if (path === "voices") {
    only("GET")
    const id = query.get("provider")
    if (id !== null && !MOCK_PROVIDERS.some((p) => p.id === id)) throw new ApiFail(404, "unknown_provider", `There is no voice provider "${id}"`)
    // Hosted lists take a moment (a refresh longer: the providers are asked again).
    await new Promise((r) => setTimeout(r, query.get("refresh") === "1" ? 500 : 120))
    const providers = MOCK_PROVIDERS.filter((p) => id === null || p.id === id).map(providerVoices)
    return { status: 200, body: { providers, selected: assistantVoiceKey() } }
  }
  if (path === "voices/preview") {
    only("POST")
    const b = await body()
    const { provider, voice } = findVoice(b.voice)
    const text = typeof b.text === "string" ? b.text.trim() : ""
    if (text.length === 0 || text.length > MAX_PREVIEW_CHARS) throw new ApiFail(400, "invalid_request", "The preview text must be 1–300 characters", undefined)
    const info = needKey(provider)
    if (info.status === "error") throw new ApiFail(502, "provider_error", info.message ?? "The provider refused.")
    if (provider.location === "local") {
      if (!presetInstalled(voice.voiceId)) throw new ApiFail(409, "not_installed", `${voice.name} is not downloaded: download it first`)
      if ([...voiceSessions.values()].some((v) => v.state === "hearing" || v.state === "thinking" || v.state === "speaking")) {
        throw new ApiFail(409, "busy", "The assistant is talking; try again in a moment", 1000)
      }
    }
    clientLog.push({ type: "api.preview", conn: "http", at: Date.now(), voice: `${provider.id}:${voice.voiceId}`, text })
    // One preview at a time: a new one supersedes the one still waiting.
    if (pendingPreview !== undefined) {
      clearTimeout(pendingPreview.timer)
      apiAnswer(req, pendingPreview.res, 409, { error: { code: "superseded", message: "A newer preview replaced this one" } })
      pendingPreview = undefined
    }
    const pcm = synthesize(text, voice.name.length)
    const wav = encodeWav(pcm, REPLY_RATE)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingPreview?.res === res) pendingPreview = undefined
        resolve()
      }, previewHold > 0 ? previewHold : 300)
      pendingPreview = { res, timer }
      res.on("close", () => {
        if (pendingPreview?.res === res) {
          clearTimeout(timer)
          pendingPreview = undefined
        }
        resolve()
      })
    })
    if (res.writableEnded || res.destroyed) return undefined
    res.writeHead(200, { ...corsHeaders(req), "content-type": "audio/wav", "content-length": String(wav.length), "x-voice-sample-rate": String(REPLY_RATE), "x-preview-cache": "miss", "cache-control": "no-store" })
    res.end(wav)
    return undefined
  }
  if (path === "voices/download" || path === "voices/download/cancel") {
    only("POST")
    const { provider, voice } = findVoice((await body()).voice)
    if (provider.location !== "local") throw new ApiFail(400, "invalid_request", "Only voices on this machine are downloaded")
    if (path === "voices/download/cancel") {
      const job = jobs.find((j) => j.tool === "tts-models" && j.target === voice.voiceId && j.state === "running")
      const cancelled = job === undefined ? undefined : stopJob(job.id)
      if (cancelled === undefined) throw new ApiFail(404, "not_found", `${voice.name} is not being downloaded`)
      return { status: 200, body: { cancelled: true, job: cancelled } }
    }
    const started = startJob("tts-models", voice.voiceId)
    if (!started.ok) {
      throw started.code === "installed" ? new ApiFail(409, "already_installed", started.message)
        : started.code === "running" ? new ApiFail(409, "busy", started.message)
        : new ApiFail(404, "unknown_voice", started.message)
    }
    return { status: 202, body: { job: started.job } }
  }
  const jobMatch = /^jobs\/([^/]+)$/.exec(path)
  if (jobMatch !== null) {
    only("GET")
    const job = jobs.find((j) => j.id === decodeURIComponent(jobMatch[1]!))
    if (job === undefined) throw new ApiFail(404, "not_found", "There is no such job")
    return { status: 200, body: { job } }
  }
  if (path === "voices/favourites") {
    only("GET")
    return { status: 200, body: { favourites } }
  }
  const favMatch = /^voices\/favourites\/([^/]+)$/.exec(path)
  if (favMatch !== null) {
    only("PUT", "DELETE")
    let key: string
    try {
      key = decodeURIComponent(favMatch[1]!)
    } catch {
      throw new ApiFail(400, "invalid_request", "The voice in the address is not valid")
    }
    const ref = parseVoiceKey(key)
    if (ref === undefined) throw new ApiFail(400, "invalid_request", `"${key.slice(0, 80)}" is not a voice (provider:voice)`)
    if (!MOCK_PROVIDERS.some((p) => p.id === ref.provider)) throw new ApiFail(404, "unknown_provider", `There is no voice provider "${ref.provider}"`)
    if (method === "DELETE") {
      if (!favourites.some((f) => f.key === key)) throw new ApiFail(404, "not_found", "That voice is not a favourite")
      favourites = favourites.filter((f) => f.key !== key)
      return { status: 200, body: { favourites } }
    }
    const b = await body()
    const listed = MOCK_PROVIDERS.find((p) => p.id === ref.provider)?.voices.find((v) => v.voiceId === ref.voiceId)?.name
    const name = typeof b.name === "string" && b.name.length > 0 ? b.name.slice(0, 100) : listed ?? ref.voiceId
    const existing = favourites.find((f) => f.key === key)
    if (existing === undefined && favourites.length >= MAX_FAVOURITES) throw new ApiFail(409, "limit_reached", `At most ${MAX_FAVOURITES} favourites`)
    const favourite: Favourite = existing !== undefined ? { ...existing, name } : { voice: ref, key, name, addedAt: Date.now() }
    favourites = existing !== undefined ? favourites.map((f) => (f.key === key ? favourite : f)) : [...favourites, favourite]
    return { status: 200, body: { favourite, favourites } }
  }
  if (path === "voices/default") {
    only("GET", "PUT")
    if (method === "GET") return { status: 200, body: { default: defaultVoiceInfo() } }
    const b = await body()
    const { provider, voice } = findVoice(b.voice)
    needKey(provider)
    if (provider.location === "local" && !presetInstalled(voice.voiceId)) throw new ApiFail(409, "not_installed", `${voice.name} is not downloaded: download it first`)
    saveAssistantVoice(`${provider.id}:${voice.voiceId}`)
    if (b.reload === true) {
      engine = { ...readyEngine(), reloadPending: false }
      broadcast({ type: "engine", engine })
      return { status: 200, body: { default: defaultVoiceInfo(), reload: { ok: true } } }
    }
    return { status: 200, body: { default: defaultVoiceInfo() } }
  }
  const picked = await modelPickers.route(method, path, query, body)
  if (picked !== undefined) return picked
  throw new ApiFail(404, "not_found", `There is nothing at /api/${path}`)
}

/** CORS for the page's origin (the static export and the mock are on different ports). */
const corsHeaders = (req: IncomingMessage): Record<string, string> => {
  const origin = req.headers.origin
  return origin === undefined ? {} : { "access-control-allow-origin": origin, vary: "Origin", "access-control-expose-headers": "X-Voice-Sample-Rate, X-Preview-Cache" }
}

function apiAnswer(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { ...corsHeaders(req), "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" })
  res.end(JSON.stringify(body))
}

const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...corsHeaders(req), "access-control-allow-methods": "GET, POST, PUT, DELETE", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600" })
    return res.end()
  }
  try {
    const token = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "")?.[1]
    if (!adminEnabled()) throw new ApiFail(401, "admin_required", "Admin is disabled: set PVA_ADMIN_PASSWORD (at least 8 characters) in .env and restart.")
    if (token === undefined || !sessions.has(token)) throw new ApiFail(401, "admin_required", "Log in to admin first (the session may have ended)")
    const answer = await apiRoute(req, res, url.pathname.slice("/api/".length).replace(/\/+$/, ""), url.searchParams)
    if (answer !== undefined) apiAnswer(req, res, answer.status, answer.body)
  } catch (e) {
    if (e instanceof ApiFail) {
      return apiAnswer(req, res, e.status, { error: { code: e.code, message: e.message, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) } })
    }
    apiAnswer(req, res, 500, { error: { code: "internal", message: String(e) } })
  }
}

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
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url)
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST", "access-control-allow-headers": "content-type" })
      return res.end()
    }
    if (url.pathname === "/mock/log" && req.method === "GET") {
      return json(res, 200, {
        scenario,
        messages: clientLog,
        mic: [...conns].map((c) => ({ conn: c.id, frames: c.micFrames, gaps: c.micGaps, owner: c === sessionFor(c)?.owner })),
        state: targetSession()?.state ?? "idle",
        sessions: sessionInfos(),
        connections: conns.size
      })
    }
    if (url.pathname.startsWith("/media/") && (req.method === "GET" || req.method === "HEAD")) return serveMockMedia(url.pathname, res)
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
      case "/mock/models/state": {
        const answer = modelPickers.control(payload)
        return json(res, answer.status, answer.body)
      }
      case "/mock/reset":
        resetState()
        dropAll()
        return json(res, 200, { ok: true })
      case "/mock/turn":
        // Protocol 7: `assistantId` answers (default: who has the turn, else who answers without a phrase); `phrase`: it was
        // woken by that phrase in the same sentence.
        runVoiceTurn(targetSession(payload.deviceId), {
          assistantId: typeof payload.assistantId === "string" ? payload.assistantId : undefined,
          phrase: typeof payload.phrase === "string" ? payload.phrase : undefined
        })
        return json(res, 200, { ok: true })
      case "/mock/device": {
        // A device's (without `deviceId`: the web-voice type's) settings, saved as admin would (tests): the setups follow.
        const r = voice.saveSettings(typeof payload.deviceId === "string" ? payload.deviceId : undefined, (payload.settings ?? {}) as Parameters<typeof voice.saveSettings>[1])
        if (r.ok) assistantsChanged()
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { ok: false, error: r.error })
      }
      case "/mock/idle": {
        // Protocol 6: the device's conversation has been quiet for longer than its conversationIdleMinutes: the next
        // turn starts a new one (reason "idle"); `now: true` starts it at once.
        const v = targetSession(payload.deviceId)
        if (v === undefined) return json(res, 400, { error: "no session" })
        if (payload.now === true) newConversation(v, "idle")
        else v.lastTurnAt = Date.now() - (Math.max(1, idleMinutesOf(voice.answeringOf(v, v.deviceId))) + 1) * 60_000
        return json(res, 200, { ok: true })
      }
      case "/mock/max-sessions": {
        // MAX_VOICE_SESSIONS, as admin › Language model › Conversations would set it.
        const n = typeof payload.n === "number" ? payload.n : DEFAULT_MAX_VOICE_SESSIONS
        sections = sections.map((x) => (x.id === "conversations" ? { ...x, form: { ...x.form, values: { ...x.form.values, MAX_VOICE_SESSIONS: n } }, revision: x.revision + 1 } : x))
        const section = sections.find((x) => x.id === "conversations")
        if (section !== undefined) broadcast({ type: "section.changed", section })
        return json(res, 200, { ok: true })
      }
      case "/mock/drop":
        dropAll()
        return json(res, 200, { ok: true })
      case "/mock/offline": {
        // Drop every socket and refuse new ones for `ms` (default 3 s): the UI shows reconnecting.
        offlineUntil = Date.now() + (typeof payload.ms === "number" ? payload.ms : 3000)
        dropAll()
        return json(res, 200, { ok: true })
      }
      case "/mock/admin/end": {
        const reason = payload.reason === "expired" ? "expired" : payload.reason === "logout" ? "logout" : "idle"
        endSessions(reason)
        return json(res, 200, { ok: true })
      }
      case "/mock/wake": {
        const v = targetSession(payload.deviceId)
        if (v !== undefined) wakeUp(v, typeof payload.phrase === "string" ? payload.phrase : "hey jeff", payload.armed !== false, typeof payload.assistantId === "string" ? payload.assistantId : undefined)
        return json(res, 200, { ok: true })
      }
      case "/mock/heard": {
        sendHeard(
          typeof payload.deviceId === "string" ? voiceSessions.get(payload.deviceId) : undefined,
          String(payload.text ?? ""),
          typeof payload.matched === "string" ? payload.matched : undefined,
          typeof payload.accepted === "boolean" ? payload.accepted : payload.accepted === null ? null : undefined,
          payload.source !== null
        )
        return json(res, 200, { ok: true })
      }
      case "/mock/typesafe": {
        // TypeSafe set up or not (tests): the routing section switched on with a key, as `canAuto` reads it.
        const on = payload.on !== false
        sections = withWarnings(sections.map((x) => {
          if (x.id !== "routing") return x
          const form = on
            ? { ...x.form, values: { ...x.form.values, TYPESAFE_ROUTING: true }, secrets: { ...x.form.secrets, TYPESAFE_API_KEY: { set: true, source: "store" as const } } }
            : { ...x.form, values: { ...x.form.values, TYPESAFE_ROUTING: false }, secrets: { ...x.form.secrets, TYPESAFE_API_KEY: { set: false, source: "none" as const } } }
          return { ...x, form, revision: x.revision + 1 }
        }))
        const routing = sections.find((x) => x.id === "routing")
        if (routing !== undefined) broadcast({ type: "section.changed", section: routing })
        routingChanged()
        return json(res, 200, { ok: true })
      }
      case "/mock/module-error": {
        // A capability module's instances fail (tests); `message` absent: they run again.
        const id = String(payload.module ?? "")
        if (typeof payload.message === "string") forcedErrors.set(id, payload.message)
        else forcedErrors.delete(id)
        syncCapabilities()
        return json(res, 200, { ok: true })
      }
      case "/mock/assistant": {
        // Another admin changed an assistant (tests): `patch` is set on it and its rev goes up; the lists are pushed.
        const ok = assistantsMock.touch(String(payload.id ?? ""), (payload.patch ?? {}) as Parameters<typeof assistantsMock.touch>[1])
        if (ok) assistantsChanged()
        return json(res, ok ? 200 : 404, { ok })
      }
      case "/mock/voices/fail": {
        // A hosted provider whose key is refused (`on: false` makes it work again).
        const id = String(payload.provider ?? "")
        if (payload.on === false) providerFailures.delete(id)
        else providerFailures.add(id)
        return json(res, 200, { ok: true })
      }
      case "/mock/voices/hold":
        previewHold = typeof payload.ms === "number" ? payload.ms : 0
        return json(res, 200, { ok: true })
      case "/mock/logout-fails":
        logoutFails = payload.on !== false
        return json(res, 200, { ok: true })
      case "/mock/state": {
        const state = payload.state
        if (state !== "idle" && state !== "asleep" && state !== "listening" && state !== "hearing" && state !== "thinking" && state !== "speaking") return json(res, 400, { error: "state?" })
        const v = targetSession(payload.deviceId)
        for (const x of v !== undefined ? [v] : [...voiceSessions.values()]) setState(x, state)
        return json(res, 200, { ok: true })
      }
      case "/mock/volume": {
        // P7: {"deviceId", "direction": "louder" | "quieter"} or {"deviceId", "to": 0..1}: the device's reply volume,
        // as the server changes it for a spoken "louder" or "quieter" (the mock has no recogniser), sent to its voice pages.
        if (typeof payload.deviceId !== "string") return json(res, 400, { error: "deviceId is required" })
        const change = payload.direction === "louder" || payload.direction === "quieter"
          ? payload.direction
          : typeof payload.to === "number" ? { to: payload.to } : undefined
        if (change === undefined) return json(res, 400, { error: "direction (louder, quieter) or to (0..1) is required" })
        return json(res, 200, changeMockVolume(payload.deviceId, change))
      }
      case "/mock/notify": {
        // P9: a notification delivered as the server would: {"id"?, "title", "text"?, "ring"?, "silent"?, "deviceId"?
        // (absent: everywhere), "actions"? [{ id, label }], "handlerDown"?}. Sent to the voice pages of its device now
        // and to each that says hello while it is open.
        // An id is never used twice: a named one already issued or named is refused; a generated one skips them all.
        if (typeof payload.id === "string" && mockNotifyIds.has(payload.id)) return json(res, 409, { error: "that id was used already" })
        let id = typeof payload.id === "string" ? payload.id : `n-mock-${++mockNotifySeq}`
        while (typeof payload.id !== "string" && mockNotifyIds.has(id)) id = `n-mock-${++mockNotifySeq}`
        mockNotifyIds.add(id)
        const title = typeof payload.title === "string" ? payload.title.slice(0, 60) : "Notification"
        const ring = payload.ring === true
        const card: Omit<NotificationCardWire, "show" | "sound" | "texts"> = {
          id,
          title,
          ...(typeof payload.text === "string" ? { text: payload.text.slice(0, 200) } : {}),
          priority: ring ? "ring" : "normal",
          actions: [{ id: "stop", label: "Stop" }, ...(Array.isArray(payload.actions) ? (payload.actions as Array<{ id: string; label: string }>).slice(0, 2) : [])],
          sentAt: Date.now()
        }
        const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : undefined
        mockNotifications.set(id, { card, ...(deviceId !== undefined ? { deviceId } : {}), handlerDown: payload.handlerDown === true })
        for (const c of notifyConns(deviceId)) reconcileMock(c)
        return json(res, 200, { id })
      }
      case "/mock/present": {
        // P10: a presentation shown as the server would: {"id"?, "presentation": what a module passes to show, "options"?
        // { lifetime?, expiresInMs?, key? }, "deviceId"? (absent: every device), "handlerDown"?}. Checked by the shared
        // checks before anything changes (a refused one consumes no id and replaces nothing); its lifetime and end by the
        // shared helper; at its end it is removed. A transient one ends the earlier transient ones of the same devices;
        // an id is never used twice; an image shows the mock's built-in picture, through `/media/<token>`.
        // Review round 2 (R7): the whole request is checked before any id is consumed or anything changes; what the mock
        // does not model is refused; admission uses the server's own live bounds (the mock is one module).
        pruneEndedMock()
        const now = Date.now()
        const extra = Object.keys(payload).find((k) => !MOCK_PRESENT_FIELDS.includes(k))
        if (extra !== undefined) return json(res, 400, { error: `unknown field ${extra}` })
        if (payload.id !== undefined && (typeof payload.id !== "string" || !PRESENTATION_ID.test(payload.id))) return json(res, 400, { error: `id must match ${PRESENTATION_ID}` })
        if (payload.deviceId !== undefined && (typeof payload.deviceId !== "string" || !devices.has(payload.deviceId))) return json(res, 400, { error: "deviceId names no device the mock knows" })
        if (payload.handlerDown !== undefined && typeof payload.handlerDown !== "boolean") return json(res, 400, { error: "handlerDown is true or false" })
        const presentation = payload.presentation as Presentation | undefined
        const options = payload.options as ShowOptions | undefined
        const problem = presentationProblem(presentation, now) ?? showOptionsProblem(options, (presentation as { kind?: PresentKindName } | undefined)?.kind)
        if (problem !== undefined) return json(res, 400, { error: problem })
        if (presentation!.sensitivity !== undefined && presentation!.sensitivity !== "household") return json(res, 400, { error: MOCK_PRESENT_NO_PRIVACY })
        if (options?.key !== undefined) return json(res, 400, { error: MOCK_PRESENT_NO_KEY })
        if (typeof payload.id === "string" && mockPresentIds.has(payload.id)) return json(res, 409, { error: "that id was used already" })
        const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : undefined
        const { lifetime, expiresAt } = presentLifetime(presentation!, options, now)
        const overlaps = (other: { readonly deviceId?: string }) => deviceId === undefined || other.deviceId === undefined || other.deviceId === deviceId
        // As the server: the transients this one would end do not count against it.
        const counted = [...mockPresentations.values()].filter((p) => p.endsAt > now && !(lifetime === "transient" && p.lifetime === "transient" && overlaps(p)))
        if (counted.length >= MAX_LIVE_PER_MODULE || counted.length >= MAX_LIVE_TOTAL) return json(res, 409, { error: "limit" })
        if (lifetime === "pinned" && counted.filter((p) => p.lifetime === "pinned" && overlaps(p)).length >= MAX_PINNED_PER_DEVICE) return json(res, 409, { error: "limit" })
        // What a page would be sent of it decodes as the protocol says (an image with a token of the right form).
        const sampleId = typeof payload.id === "string" ? payload.id : "p-mock-check"
        const sample = { ...mockWire(sampleId, { presentation: presentation!, lifetime, shownAt: now }, presentation!.kind === "image" ? "t".repeat(32) : undefined, true), serverNow: now }
        if (!isPresentationWire(sample)) return json(res, 400, { error: "the presentation does not make a valid page message" })
        let id = typeof payload.id === "string" ? payload.id : `p-mock-${++mockPresentSeq}`
        while (typeof payload.id !== "string" && mockPresentIds.has(id)) id = `p-mock-${++mockPresentSeq}`
        mockPresentIds.add(id)
        if (lifetime === "transient") for (const [other, p] of [...mockPresentations]) if (p.lifetime === "transient" && overlaps(p)) endMockPresentation(other)
        mockPresentations.set(id, {
          presentation: presentation!,
          ...(deviceId !== undefined ? { deviceId } : {}),
          lifetime,
          shownAt: now,
          endsAt: expiresAt,
          handlerDown: payload.handlerDown === true,
          timer: setTimeout(() => endMockPresentation(id), Math.max(0, expiresAt - now))
        })
        reconcilePresentEverywhere()
        return json(res, 200, { id, lifetime, expiresAt })
      }
      case "/mock/present/dismiss": {
        const id = typeof payload.id === "string" ? payload.id : ""
        return json(res, 200, { dismissed: endMockPresentation(id) })
      }
      case "/mock/notify/held": {
        // The bookkeeping (tests): how many connections the mock keeps what they hold for, and how many are open.
        return json(res, 200, { held: mockHeld.size, voiceConnections: notifyConns(undefined).length })
      }
      case "/mock/notify/resolve": {
        const id = typeof payload.id === "string" ? payload.id : ""
        return json(res, 200, { resolved: resolveMockNotification(id, typeof payload.outcome === "string" ? payload.outcome : "resolved") })
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

syncCapabilities()
http.listen(PORT, HOST, () => console.log(`[mock] assistant mock on ws://${HOST}:${PORT}/ws · scenario ${scenario}`))

const shutdown = () => {
  for (const c of conns) c.ws.close(CloseCode.serverShutdown)
  http.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
