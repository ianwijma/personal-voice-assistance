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
 *   devices         like typed, with two remembered devices (one with overrides) besides the ones that connect.
 *   long-phrase     like typed, with a six-word wake phrase ("hello my personal voice assistant please") as the
 *                   web-voice default (asleep after a claim) and a third device that has it among three phrases.
 *   admin-disabled  no admin password: `admin.state.enabled` is false and every login is refused.
 *   admin-backoff   every wrong admin password refuses logins for 30 s.
 * In every scenario the vault starts as "none" (no vault yet) unless the scenario says otherwise.
 *
 * Protocol 5 (docs/FRONTENDS-AND-ACTIVATION.md): pages say `frontend: "voice" | "admin"` in hello. The admin
 * password is ADMIN_PASSWORD below ("admin password"); a login returns a token that a later hello may carry. The
 * admin part (settings, modules, engine status, vault, env, models, jobs, traces, front ends, devices) goes to
 * admin connections only, and every change needs one (`admin_required` otherwise). Voice pages get the voice part,
 * `engine.summary`, their device profile (`device.profile`, live), and `wake`. Admin pages that switched the
 * tester on get `wake.heard`.
 *
 * Every scenario also has settings from a fake .env (Diagnostics › Settings from outside: Move works, keys are refused
 * while the vault is locked) and model downloads (Speech recognition › Models, Voices › Models: a download takes
 * MOCK_DOWNLOAD_TICKS × 250 ms, then 1.5 s to "unpack"; Cancel and Delete work; the models in use cannot be deleted).
 *
 * Control endpoints (for tests): GET /mock/log (client messages and microphone stats), POST /mock/reset,
 * POST /mock/turn (run the scripted voice turn now), POST /mock/send {"messages": [ServerMessage…]} (broadcast),
 * POST /mock/drop (terminate every socket), POST /mock/offline {"ms": 3000} (drop and refuse connections for a while),
 * POST /mock/admin/end {"reason": "idle" | "expired"} (end every admin session), POST /mock/wake {"phrase", "armed"}
 * (the owner said the wake phrase), POST /mock/heard {"text", "matched"?, "accepted"?} (a tester line; `accepted: null` leaves the field out), POST /mock/state
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
 * POST /mock/max-sessions {"n"} sets MAX_VOICE_SESSIONS.
 *
 * The voice picker's HTTP API (docs/VOICE-PROVIDERS.md §5) is under /api/ on the same port (admin token from a login,
 * CORS for the page's origin): the providers of mock/voices.ts (On this machine; Cartesia without a key, `vault_locked`
 * while the vault is locked; ElevenLabs with one), favourites, previews (WAV tones, one at a time: `superseded`; `busy`
 * for a voice on this machine while a device is in a turn), downloads (the Models page's jobs) and the assistant's voice
 * (ASSISTANT_VOICE, with the server's checks). POST /mock/voices/fail {"provider", "on"?} makes a provider's key
 * refused; POST /mock/voices/hold {"ms"} delays previews.
 */
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  type AdminState,
  type ClientMessage,
  CloseCode,
  type AssistantState,
  type ConversationInfo,
  DEFAULT_CONVERSATION_IDLE_MINUTES,
  DEFAULT_MAX_VOICE_SESSIONS,
  DEFAULT_SESSION_DISCARD_MINUTES,
  DEVICE_EDITABLE_FIELDS,
  type DeviceListInfo,
  type DeviceProfile,
  type DeviceProfileInfo,
  type FrontendKindInfo,
  applyProfilePatch,
  BUILT_IN_WEB_VOICE_SETTINGS,
  effectiveProfile,
  PROFILE_FIELDS,
  type ProfileOverrides,
  type ProfilePatch,
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
  type VoiceEntry
} from "@pva/protocol"
import { exampleEngineStatus, exampleSnapshot, exampleVoiceSection, exampleWeatherModule } from "@pva/protocol/examples"
import { type WebSocket, WebSocketServer } from "ws"
import { encodeWav, MOCK_PROVIDERS } from "./voices.ts"
import type { Condition, FieldError } from "@pva/protocol"

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
  "admin-disabled",
  "admin-backoff"
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
    revision: 1,
    kind: "capability",
    group: "modules"
  },
  { ...clone(exampleWeatherModule), kind: "capability", group: "modules" },
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
  }
]

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
        }
      ],
      values: { LLM_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-haiku-5-5", ANTHROPIC_EFFORT: "low" },
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
        { type: "number", key: "CONVERSATION_IDLE_MINUTES", label: "Start a new conversation after", description: "Minutes without a turn after which the next thing said starts a fresh conversation. 0 = never. A device's profile can say otherwise.", apply: "live", default: DEFAULT_CONVERSATION_IDLE_MINUTES, integer: true, min: 0, max: 240, step: 1, unit: "min", source: "default" },
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
  awakeTimer: ReturnType<typeof setTimeout> | undefined
  discardTimer: ReturnType<typeof setTimeout> | undefined
}

const conns = new Set<Conn>()
let connSeq = 0
const voiceSessions = new Map<string, VSession>()
let conversationSeq = 0
let modules = initialModules()
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
let traces: Array<TraceInfo> = []
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
  overrides: ProfileOverrides
}
const HOUR = 3_600_000
const seededDevices = (): Map<string, DeviceRecord> => {
  if (scenario !== "devices" && scenario !== "wake" && scenario !== "long-phrase") return new Map()
  const now = Date.now()
  return new Map([
    ...(scenario === "long-phrase"
      ? [["d-living-room-0003", { id: "d-living-room-0003", kind: WEB_VOICE_KIND, name: "Living room tablet", firstSeen: now - 20 * 24 * HOUR, lastSeen: now - 5 * 60_000, overrides: { activation: "wake-phrase", wakePhrases: [LONG_PHRASE, "hey computer", "ok house"] } }] as [string, DeviceRecord]]
      : []),
    ["d-kitchen-ipad-0001", { id: "d-kitchen-ipad-0001", kind: WEB_VOICE_KIND, name: "Kitchen iPad", firstSeen: now - 40 * 24 * HOUR, lastSeen: now - 2 * HOUR, overrides: { activation: "wake-phrase", followUpSeconds: 15, voice: "natural" } }],
    ["d-pixel-phone-0002", { id: "d-pixel-phone-0002", kind: WEB_VOICE_KIND, name: "Android phone · Chrome", firstSeen: now - 9 * 24 * HOUR, lastSeen: now - 3 * 24 * HOUR, overrides: {} }]
  ])
}
/** Six words: wake phrases may be this long (the UI must not cut or jump on them). */
const LONG_PHRASE = "hello my personal voice assistant please"
const initialKindDefaults = (): ProfileOverrides =>
  scenario === "wake" ? { activation: "wake-phrase" } : scenario === "long-phrase" ? { activation: "wake-phrase", wakePhrases: [LONG_PHRASE] } : {}
let devices = seededDevices()
let kindDefaults: ProfileOverrides = initialKindDefaults()

const KIND_INFO = {
  id: WEB_VOICE_KIND,
  title: "Voice assistant in a browser",
  description: "The voice front end opened in a browser: a phone, a tablet or a computer.",
  fields: [...PROFILE_FIELDS]
}
const frontendInfos = (): Array<FrontendKindInfo> => [{ ...KIND_INFO, defaults: kindDefaults, profile: effectiveProfile(kindDefaults) }]
const deviceProfile = (id: string | undefined): DeviceProfile => effectiveProfile(kindDefaults, id === undefined ? {} : devices.get(id)?.overrides ?? {})
const deviceInfos = (): Array<DeviceListInfo> => {
  const now = Date.now()
  return [...devices.values()]
    .map((d) => {
      const connections = [...conns].filter((c) => c.welcomed && c.deviceId === d.id).length
      // Protocol 7 fields: the mock has no assistants yet (the UI packages add them).
      return { ...d, lastSeen: connections > 0 ? now : d.lastSeen, profile: deviceProfile(d.id), connections, audioOwner: voiceSessions.get(d.id)?.owner !== undefined, own: {}, settings: BUILT_IN_WEB_VOICE_SETTINGS, hearer: null, rev: 0 }
    })
    .sort((a, b) => b.lastSeen - a.lastSeen)
}
const profileInfo = (c: Conn): DeviceProfileInfo =>
  c.deviceId === undefined
    ? { profile: effectiveProfile(kindDefaults), editable: [] }
    : { deviceId: c.deviceId, profile: deviceProfile(c.deviceId), editable: [...DEVICE_EDITABLE_FIELDS] }
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
    snapshot: { engine, modules, sections, traces: traces.slice(-20), vault: vaultInfo(c), env, models, jobs, frontends: frontendInfos(), devices: deviceInfos(), sessions: sessionInfos() }
  })
const pushProfiles = () => {
  for (const c of conns) if (c.welcomed && c.frontend === "voice") sendTo(c, { type: "device.profile", ...profileInfo(c) })
}
const devicesChanged = () => broadcast({ type: "devices", devices: deviceInfos() })
const frontendsChanged = () => broadcast({ type: "frontends", frontends: frontendInfos() })
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
      awakeTimer: undefined,
      discardTimer: undefined
    }
    voiceSessions.set(key, v)
  }
  return v
}
const sessionName = (v: VSession) => (v.deviceId === undefined ? "A browser tab without a device id" : devices.get(v.deviceId)?.name ?? "A device")
const connsOf = (v: VSession) => [...conns].filter((c) => c.welcomed && keyOf(c) === v.key)
/** A message about a session's turns: only to that device's connections. */
const toSession = (v: VSession, m: ServerMessage) => {
  for (const c of connsOf(v)) sendTo(c, m)
}
const startedSessions = () => [...voiceSessions.values()].filter((v) => v.started).sort((a, b) => b.lastActive - a.lastActive)
const ownerPresentIn = (v: VSession) => v.owner !== undefined || v.lastOwnerClientId === "c-another-tab"
const sessionInfos = (): Array<SessionInfo> =>
  startedSessions().map((v) => ({
    key: v.key,
    ...(v.deviceId === undefined ? {} : { deviceId: v.deviceId }),
    name: sessionName(v),
    state: v.state,
    ownerPresent: ownerPresentIn(v),
    conversationId: v.conversation.id,
    turns: v.turns,
    lastTurnAt: v.lastTurnAt
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
/** A new conversation on the session: the running turn stops, the history goes, every tab of the device is told. */
const newConversation = (v: VSession, reason: "new" | "idle") => {
  if (v.reply !== undefined) interruptReply(v.reply)
  v.history = []
  v.conversation = newConversationInfo()
  v.turns = 0
  v.lastTurnAt = null
  toSession(v, { type: "conversation", id: v.conversation.id, reason, startedAt: v.conversation.startedAt })
  sessionsChanged()
}
/** The session and its conversation go (discarded, or its place taken at the limit). */
const dropSession = (v: VSession) => {
  if (v.discardTimer !== undefined) clearTimeout(v.discardTimer)
  v.discardTimer = undefined
  if (v.reply !== undefined) clearReply(v.reply)
  if (v.awakeTimer !== undefined) clearTimeout(v.awakeTimer)
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

const sessionProfile = (v: VSession): DeviceProfile => (v.deviceId === undefined ? effectiveProfile(kindDefaults) : deviceProfile(v.deviceId))
const wakeMode = (v: VSession) => v.owner !== undefined && sessionProfile(v).activation === "wake-phrase"
/** Keep the session awake (no phrase needed) for `ms`; then asleep again unless something is going on. */
const stayAwake = (v: VSession, ms: number) => {
  v.awakeUntil = Date.now() + ms
  if (v.awakeTimer !== undefined) clearTimeout(v.awakeTimer)
  v.awakeTimer = setTimeout(() => {
    v.awakeTimer = undefined
    if (v.reply === undefined && (v.state === "listening" || v.state === "asleep")) setState(v, restingState(v))
  }, ms + 20)
}
/**
 * A tester line from session `v` to admin connections that switched the tester on and follow that session (a device
 * id, or the most recently active session); without a session, to every tester. `accepted` defaults to what the
 * server's wake gate would say: matched a phrase, always listening, or inside an armed / follow-up window; `null`
 * leaves it out (an older server).
 */
const sendHeard = (v: VSession | undefined, text: string, matched?: string, accepted?: boolean | null) => {
  const now = Date.now()
  const taken = accepted === undefined ? matched !== undefined || v === undefined || !wakeMode(v) || v.awakeUntil > now : accepted
  const auto = targetSession()
  for (const c of conns) {
    if (!c.welcomed || !isAdminConn(c) || c.testerUntil === undefined || c.testerUntil < now) continue
    if (v !== undefined && (c.testerDevice === undefined ? auto !== v : c.testerDevice !== v.deviceId)) continue
    sendTo(c, {
      type: "wake.heard",
      text,
      ...(matched === undefined ? {} : { matched }),
      ...(taken === null ? {} : { accepted: taken }),
      at: now
    })
  }
}
/** The session's owner said the wake phrase. */
const wakeUp = (v: VSession, phrase: string, armed: boolean) => {
  toSession(v, { type: "wake", phrase, armed })
  if (!armed) return // the request came in the same sentence: a turn follows
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
/** As the server: a device's own voice is retired (docs/VOICE-PROVIDERS.md §1); any other value than "" becomes "". */
const cleanPatch = (patch: ProfilePatch): ProfilePatch =>
  typeof patch.voice !== "string" || patch.voice === "" ? patch : { ...patch, voice: "" }

const resetState = () => {
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
  kindDefaults = initialKindDefaults()
  env = initialEnv()
  favourites = initialFavourites()
  providerFailures.clear()
  previewHold = 0
  for (const t of jobTimers.values()) clearInterval(t)
  jobTimers.clear()
  jobs = []
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
/** Messages that carry admin data: only admin connections get them (protocol 5). */
const ADMIN_ONLY: ReadonlySet<ServerMessage["type"]> = new Set(["engine", "module.changed", "section.changed", "vault", "env", "job", "models", "frontends", "devices", "sessions", "trace", "wake.heard", "admin.snapshot"])
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

const setState = (v: VSession, state: AssistantState, turnId?: number) => {
  if (state === v.state && turnId === undefined) return
  v.state = state
  toSession(v, turnId === undefined ? { type: "state", state } : { type: "state", state, turnId })
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
/** After a change of profiles: every session that is not in a turn settles in its resting state. */
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

const endTurn = (r: Reply, outcome: "completed" | "interrupted" | "failed") => {
  if (r.ended) return
  const v = r.session
  clearReply(r)
  if (v.reply === r) v.reply = undefined
  const trace = makeTrace(r, outcome)
  // Admin's traces carry the session (the device's name) and arrive live as `trace`; the device's tabs get turn.end.
  const forAdmin: TraceInfo = { ...trace, session: sessionName(v).slice(0, 64) }
  traces = [...traces, forAdmin].slice(-20)
  broadcast({ type: "trace", key: v.key, ...(v.deviceId === undefined ? {} : { deviceId: v.deviceId }), trace: forAdmin })
  // A turn of a conversation that was replaced (New conversation) is never committed to the new one.
  if (v.conversation.id === r.conversationId) {
    const heard = r.spoken ? r.clauses.filter((_, i) => i <= r.playedClause || outcome === "completed").map((c) => c.text).join(" ") : r.clauses.map((c) => c.text).join("")
    v.history.push({ role: "assistant", text: heard, interrupted: outcome !== "completed", tools: r.tools.map((t) => ({ name: t.name, ok: true })) })
    v.turns++
    v.lastTurnAt = Date.now()
  }
  toSession(v, { type: "turn.end", turnId: r.turnId, outcome, trace })
  if (wakeMode(v)) {
    const followUp = sessionProfile(v).followUpSeconds * 1000
    if (followUp > 0) stayAwake(v, followUp)
    else v.awakeUntil = 0
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
}) => {
  if (v.reply !== undefined) interruptReply(v.reply)
  // The idle reset, decided at the start of the turn: quiet for longer than the device's conversationIdleMinutes.
  const idleMinutes = sessionProfile(v).conversationIdleMinutes
  if (idleMinutes > 0 && v.lastTurnAt !== null && Date.now() - v.lastTurnAt > idleMinutes * 60_000) newConversation(v, "idle")
  const turnId = ++turnSeq
  const endOfTurn = Date.now()
  v.lastActive = endOfTurn
  v.history.push({ role: "user", text: opts.userText })
  toSession(v, { type: "transcript", text: "" })
  toSession(v, { type: "turn.start", turnId, source: opts.source, userText: opts.userText, spoken: opts.spoken })
  setState(v, "thinking", turnId)
  let startSample = 0
  const pcms = opts.clauses.map((text, i) => synthesize(text, i * 1.7 + turnId))
  const clauses = opts.clauses.map((text, i) => {
    const c = { text, startSample }
    startSample += pcms[i]!.length
    return c
  })
  const r: Reply = { turnId, clauses, endOfTurn, spoken: opts.spoken, tools: [], source: opts.source, owner: v.owner, session: v, conversationId: v.conversation.id, playedClause: -1, lastReport: Date.now(), timers: [], ended: false }
  v.reply = r
  let t = 120
  if (opts.tool !== undefined) {
    const tool = opts.tool
    r.timers.push(setTimeout(() => toSession(v, { type: "tool.start", turnId, callId: `toolu_${turnId}`, tool: tool.name, moduleId: tool.moduleId, input: tool.input as never }), t))
    t += tool.ms
    r.timers.push(setTimeout(() => {
      r.tools.push({ name: tool.name, ms: tool.ms })
      toSession(v, { type: "tool.end", turnId, callId: `toolu_${turnId}`, ok: tool.ok ?? true, ms: tool.ms, ...(tool.error !== undefined ? { error: tool.error } : {}) })
    }, t))
    t += 40
  }
  if (!opts.spoken) {
    // Unspoken: stream raw text deltas, then end.
    const words = opts.clauses.join(" ").split(/(?<= )/)
    words.forEach((w, i) => r.timers.push(setTimeout(() => toSession(v, { type: "assistant.text", turnId, clause: null, text: w }), t + 280 + i * 45)))
    r.timers.push(setTimeout(() => endTurn(r, "completed"), t + 300 + words.length * 45))
    return
  }
  const c = v.owner
  r.timers.push(setTimeout(() => {
    if (c === undefined || c.ws.readyState !== c.ws.OPEN) {
      toSession(v, { type: "error", error: { code: "turn_failed", message: "No audio client: the reply could not be played.", turnId } })
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
        toSession(v, { type: "error", error: { code: "playback_timeout", message: "The browser stopped reporting playback; the reply was stopped.", turnId } })
        endTurn(r, "failed")
      }
    }, 250)
  }, t))
  // Clauses go to TTS one after another, faster than real time.
  opts.clauses.forEach((text, i) => {
    r.timers.push(setTimeout(() => {
      toSession(v, { type: "assistant.text", turnId, clause: i, text, voice: runningVoiceKey() })
      if (c !== undefined) sendReplyAudio(c, turnId, pcms[i]!)
      if (i === opts.clauses.length - 1 && c !== undefined) sendTo(c, { type: "reply.end", turnId })
    }, t + 30 + i * 380))
  })
}

const VOICE_CLAUSES = ["It's sunny in Paris,", "eighteen degrees with a light wind from the west,", "and it stays dry until the evening."]

const runVoiceTurn = (v: VSession | undefined) => {
  if (v === undefined || v.owner === undefined) return
  setState(v, "hearing")
  const words = ["what's", "what's the", "what's the weather", "what's the weather in", "what's the weather in Paris"]
  words.forEach((w, i) => after(250 + i * 260, () => toSession(v, { type: "transcript", text: w })))
  after(250 + words.length * 260 + 350, () => {
    sendHeard(v, "What's the weather in Paris?", undefined, true)
    runReply(v, {
      source: "voice",
      userText: "What's the weather in Paris?",
      clauses: VOICE_CLAUSES,
      spoken: true,
      tool: { name: "weather", moduleId: "weather", input: { place: "Paris, France" }, ms: 241 }
    })
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
    setModule(id, (x) => ({ ...x, state: "running", tools, ...(status !== undefined ? { status } : {}) }))
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
      const r = sessionFor(c)?.reply
      if (r === undefined || (m.turnId !== undefined && m.turnId !== r.turnId)) return
      interruptReply(r)
      return
    }
    case "text.send": {
      if (engine.state !== "ready") return result(c, m.requestId, false, { code: "engine_failed", message: "The assistant's engines are not running; see Settings → Overview." })
      const v = sessionFor(c)
      if (v === undefined) return result(c, m.requestId, false, { code: "bad_message", message: "The admin page has no conversation." })
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
      runReply(v, { source: "text", userText: m.text, clauses, spoken, ...(tool !== undefined ? { tool } : {}) })
      sessionsChanged()
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
      if (mod.state === "error" && mod.enabled) startModule(c, m.requestId, m.moduleId)
      else result(c, m.requestId, true)
      return
    }
    case "settings.update": {
      const i = sections.findIndex((s) => s.id === m.sectionId)
      if (i === -1) return result(c, m.requestId, false, { code: "unknown_section", message: `No section ${m.sectionId}.` })
      const section = sections[i]!
      if (refuseLocked(c, m.requestId, section.protected)) return
      // Fields hidden after the patch (visibleWhen) are neither validated nor saved, as on the real server.
      const after = (key: string) => (Object.hasOwn(m.patch.values, key) && m.patch.values[key] !== null ? m.patch.values[key] : valueOf(key))
      const shown = (key: string) => holds(section.form.fields.find((f) => f.key === key)?.visibleWhen, after)
      const patch: SettingsPatch = {
        values: Object.fromEntries(Object.entries(m.patch.values).filter(([k]) => shown(k))),
        secrets: Object.fromEntries(Object.entries(m.patch.secrets).filter(([k]) => shown(k)))
      }
      const errors = validate(section.form, patch)
      if (errors.length > 0) return result(c, m.requestId, false, { code: "invalid_settings", message: "Some settings are not valid.", fieldErrors: errors })
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
      const committed = withWarnings(candidate)
      const changed = new Set(committed.filter((x, j) => j === i || JSON.stringify(x.form) !== JSON.stringify(sections[j]!.form)).map((x) => x.id))
      sections = committed.map((x) => (changed.has(x.id) ? { ...x, revision: x.revision + 1 } : x))
      for (const x of sections) if (changed.has(x.id)) broadcast({ type: "section.changed", section: x })
      result(c, m.requestId, true)
      const needsReload = Object.keys({ ...patch.values, ...patch.secrets }).some((k) => section.form.fields.find((f) => f.key === k)?.apply === "reload")
      const path = `${section.group ?? "general"}/${section.page?.id ?? section.id}`
      if (needsReload && (!engine.reloadPending || !(engine.reloadPendingFor ?? []).includes(path))) {
        engine = { ...engine, reloadPending: true, reloadPendingFor: [...(engine.reloadPendingFor ?? []).filter((p) => p !== path), path] }
        broadcast({ type: "engine", engine })
      }
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
    case "device.update": {
      if (c.frontend !== "voice" || c.deviceId === undefined) return result(c, m.requestId, false, { code: "bad_message", message: "This page has no device." })
      const fields = Object.keys(m.patch)
      if (fields.some((f) => !(DEVICE_EDITABLE_FIELDS as ReadonlyArray<string>).includes(f))) {
        return result(c, m.requestId, false, { code: "admin_required", message: "Only admin can change that." })
      }
      const record = devices.get(c.deviceId)
      if (record === undefined) return result(c, m.requestId, false, { code: "unknown_device", message: "This device is not known." })
      record.overrides = applyProfilePatch(record.overrides, cleanPatch(m.patch))
      pushProfiles()
      result(c, m.requestId, true)
      devicesChanged()
      settleAll()
      return
    }
    case "frontend.update": {
      if (requireAdmin(c, m.requestId)) return
      if (m.kind !== WEB_VOICE_KIND) return result(c, m.requestId, false, { code: "unknown_device", message: `No front-end kind ${m.kind}.` })
      kindDefaults = applyProfilePatch(kindDefaults, cleanPatch(m.patch))
      pushProfiles()
      result(c, m.requestId, true)
      frontendsChanged()
      devicesChanged()
      settleAll()
      return
    }
    case "device.admin.update": {
      if (requireAdmin(c, m.requestId)) return
      const record = devices.get(m.id)
      if (record === undefined) return result(c, m.requestId, false, { code: "unknown_device", message: "This device is not known (any more)." })
      if (m.name !== undefined) record.name = m.name.trim()
      if (m.patch !== undefined) record.overrides = applyProfilePatch(record.overrides, cleanPatch(m.patch))
      pushProfiles()
      result(c, m.requestId, true)
      devicesChanged()
      sessionsChanged()
      settleAll()
      return
    }
    case "device.forget": {
      if (requireAdmin(c, m.requestId)) return
      const record = devices.get(m.id)
      if (record === undefined) return result(c, m.requestId, false, { code: "unknown_device", message: "This device is not known (any more)." })
      devices.delete(m.id)
      // A device that is connected now is recorded again as new.
      const now = Date.now()
      if ([...conns].some((x) => x.welcomed && x.deviceId === m.id)) devices.set(m.id, { ...record, firstSeen: now, lastSeen: now, overrides: {} })
      pushProfiles()
      result(c, m.requestId, true)
      devicesChanged()
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
      result(c, m.requestId, true)
      newConversation(v, "new")
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
        devices.set(m.device.id, known === undefined
          ? { id: m.device.id, kind: m.device.kind, name: m.device.name, firstSeen: now, lastSeen: now, overrides: {} }
          : { ...known, lastSeen: now })
        c.deviceId = m.device.id
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
          history: v === undefined ? [] : v.history.slice(-200),
          ...(m.frontend === "voice" ? { device: profileInfo(c) } : {}),
          admin: adminState(c, tokenSent !== undefined && c.session === undefined ? { endReason: "token" } : {}),
          conversation: v === undefined ? { id: "no-session", startedAt: Date.now() } : v.conversation
        }
      })
      if (isAdminConn(c)) sendAdminSnapshot(c)
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
    log(c.id, "closed")
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
      selected: key === selected,
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
        runVoiceTurn(targetSession(payload.deviceId))
        return json(res, 200, { ok: true })
      case "/mock/idle": {
        // Protocol 6: the device's conversation has been quiet for longer than its conversationIdleMinutes: the next
        // turn starts a new one (reason "idle"); `now: true` starts it at once.
        const v = targetSession(payload.deviceId)
        if (v === undefined) return json(res, 400, { error: "no session" })
        if (payload.now === true) newConversation(v, "idle")
        else v.lastTurnAt = Date.now() - (Math.max(1, sessionProfile(v).conversationIdleMinutes) + 1) * 60_000
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
        if (v !== undefined) wakeUp(v, typeof payload.phrase === "string" ? payload.phrase : "hey jeff", payload.armed !== false)
        return json(res, 200, { ok: true })
      }
      case "/mock/heard": {
        sendHeard(
          typeof payload.deviceId === "string" ? voiceSessions.get(payload.deviceId) : undefined,
          String(payload.text ?? ""),
          typeof payload.matched === "string" ? payload.matched : undefined,
          typeof payload.accepted === "boolean" ? payload.accepted : payload.accepted === null ? null : undefined
        )
        return json(res, 200, { ok: true })
      }
      case "/mock/defaults": {
        // The web-voice defaults, as admin › Front ends would set them (tests).
        kindDefaults = applyProfilePatch(kindDefaults, (payload.patch ?? {}) as ProfilePatch)
        pushProfiles()
        frontendsChanged()
        settleAll()
        return json(res, 200, { ok: true })
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
