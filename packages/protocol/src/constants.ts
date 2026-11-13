/**
 * Protocol version. Sent by the client in `hello` and by the server in
 * `welcome`; a mismatch ends the connection (close code 4400).
 *
 * Bump it on any change that an older peer could misread: a removed or renamed
 * message or field, a changed meaning, a new required field, a new member of a
 * closed literal set (states, outcomes, error codes, field types), or a change
 * to the binary framing. Optional fields that a peer may ignore do not need a
 * bump. Production serves the web UI from the assistant itself, so in practice
 * a mismatch means a stale tab or a dev server against an older assistant.
 *
 * 2: the key vault and admin access (`vault.*` messages, `vault`, `snapshot.vault`, `protected` on modules and
 * sections; error codes `locked` and `bad_password`, which are new members of a closed set).
 *
 * 3: the settings screen (docs/SETTINGS-UI.md): placement of sections and modules (`group`, `page`, `order`,
 * `visibleWhen`; `ModuleInfo.kind`), field `visibleWhen` and `source`, choice option `tags` / `implication` / `module`,
 * form `warnings` with `ErrorInfo.warnings` and `settings.update.confirmWarnings` ("Save anyway"), `reloadPendingFor`,
 * `vault.lockReason`. All optional fields, but a save may now be answered with warnings first, which a v2 page
 * cannot confirm, and the section ids changed (settings are stored by key).
 *
 * 4: settings from outside and model downloads (docs/SETTINGS-UI.md P4, P7): `settings.moveFromEnv`, `env` and
 * `snapshot.env`; jobs (`job.start`, `job.cancel`, `model.delete`, `job`, `models`, `snapshot.jobs`,
 * `snapshot.models`, closed sets `ToolId` / `JobState` / `JobPhase`); `locked.file` / `locked.line`;
 * `ChoiceOption.download`.
 */
export const PROTOCOL_VERSION = 4

/** Path of the WebSocket endpoint, on the same origin as the UI in production. */
export const WS_PATH = "/ws"

/** Microphone audio sent by the browser: PCM s16le, mono, this rate. */
export const MIC_SAMPLE_RATE = 16_000
/** Samples per microphone frame (20 ms). Frames of another even length are accepted. */
export const MIC_FRAME_SAMPLES = 320

/** Size of the header in front of every binary frame. */
export const FRAME_HEADER_BYTES = 8
/** Largest PCM payload accepted in one binary frame (about 5 s at 24 kHz). */
export const MAX_FRAME_PAYLOAD_BYTES = 262_144

/** Largest text frame either side accepts (the welcome snapshot is the biggest message). */
export const MAX_TEXT_FRAME_BYTES = 1_048_576
/** Longest typed message. */
export const MAX_TEXT_INPUT_CHARS = 4000

/** WebSocket close codes used by the server (4000-4999 is the application range). */
export const CloseCode = {
  /** Normal shutdown of the assistant. */
  serverShutdown: 1001,
  /** `hello` carried another protocol version. */
  protocolMismatch: 4400,
  /** No `hello` within the deadline, or the first message was not `hello`. */
  helloTimeout: 4401,
  /** A message failed validation in a way that makes the connection unusable (e.g. binary frame before `hello`). */
  badMessage: 4402,
  /** The connection fell too far behind (send buffer over the limit); reconnect to get a fresh snapshot. */
  tooSlow: 4408,
  /** Connection limit reached. */
  tooManyConnections: 4429
} as const
