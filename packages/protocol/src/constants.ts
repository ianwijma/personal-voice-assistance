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
 *
 * 5: front ends, admin and activation (docs/FRONTENDS-AND-ACTIVATION.md §4): `hello.frontend` (required),
 * `hello.device`, `hello.adminToken`; the welcome snapshot is role-shaped (the voice part for everyone: state, role,
 * history, `EngineSummary`, `device`, `admin`) and the admin part is its own message `admin.snapshot`, sent only to
 * admin connections (after login, so logging in needs no reconnect); `engine` (full status) goes to admin
 * connections and `engine.summary` to everyone; `admin.login` (its `result` carries `admin: AdminSession`),
 * `admin.logout`, `admin.state`, error codes `admin_required` and `unknown_device`; every settings, module, vault,
 * job, model and `.env` request is admin only; device profiles (`frontends.ts`): `device.profile`, `device.update`,
 * `frontend.update`, `device.admin.update`, `device.forget`, `frontends`, `devices`; activation: `AssistantState`
 * `asleep`, `wake`, the phrase tester `wake.test` / `wake.heard`; `audio.claim` / `audio.config` lose
 * `interruptMode` (it is a profile field now). `EngineSummary.state` (the engines' state without the problems) was
 * added during integration, within version 5 (server and web ship together). `wake.heard.accepted` (whether the
 * utterance was taken, so the tester can tell "answered without a phrase" from "ignored") was added in UI review
 * round 2, also within version 5 and optional: a page that gets a message without it says only "No phrase matched".
 *
 * 6: voice sessions (docs/VOICE-SESSIONS.md §4): one session and one conversation per device, several devices at
 * once. Server `conversation` (a new conversation started: `new`, `idle`, or `resumed`), `snapshot.conversation`
 * (required); client `conversation.new` (any voice connection; answered with `result`); error code `sessions_full`
 * (`audio.claim`, `text.send`); admin `sessions` and `admin.snapshot.sessions` (required); `wake.test.deviceId`;
 * profile field `conversationIdleMinutes` (a new member of the closed set `ProfileField`, required in a profile).
 * `snapshot.history`, `snapshot.ownerPresent`, `session` and `state` are about the device's own session. Admin `trace`
 * (every finished turn of every session, with `TraceInfo.session`; added in integration, before 6 was released).
 *
 * 7: assistants and devices (docs/ASSISTANTS.md §5). Client `assistant.create`, `assistant.save`, `assistant.delete`,
 * `device.save` (admin), `device.pick` and `conversation.read` (voice); server `assistants`, `device.types`
 * (admin), `device.setup` and `conversation.history` (voice, to the requester); `result.assistantId`; error codes
 * `stale`, `duplicate_phrase`, `unknown_assistant`, `limit_reached`, `not_allowed`; `FieldError.key` may be a dotted
 * path; `devices` entries carry `own`, `settings`, `hearer` and `rev` next to the protocol 5 fields;
 * `assistantId` on turn, reply, wake and conversation messages, `snapshot.setup`/`conversations`,
 * `admin.snapshot.assistants`/`deviceTypes`, `SessionInfo.answering`/`conversations`. Removed in the same version
 * (the pages above replaced them): client `device.update`, `frontend.update`, `device.admin.update`; server
 * `device.profile`, `frontends`; `snapshot.device`, `snapshot.conversation` (`snapshot.conversations` is required),
 * `admin.snapshot.frontends`; `profile` and `overrides` on a device entry. The profile fields of protocols 5 and 6 are
 * kept only for reading a version 3 settings file (`DeviceProfile`, `ProfileOverrides`).
 *
 * 8: looks and voices (docs/LOOKS-AND-VOICES.md §2). `DeviceSettingsKey` gains `look` and `voice` (a closed set), and
 * `DeviceSettings` requires both (`DeviceLook`, `DeviceVoice`), so a version 7 peer would refuse a version 8 device
 * entry or `device.save` and a version 8 page could not read a version 7 server's devices. Additive, within 8:
 * `Assistant.look`, `DeviceOwn`/`DeviceSettingsPatch` `look` and `voice`, `DeviceSetup.look` and `DeviceSetup.assistants[].look`,
 * `assistant.create.saveAnyway`, `TraceConfig.voiceFrom`, `usedByDevices` on voices and resource status.
 *
 * 9: module API v2 (docs/MODULES-PLAN.md §4 P1). `ModuleState` gains `unavailable` (a new member of a closed set:
 * a version 8 page would refuse a module in that state), with `ModuleInfo.unavailable` (reason and fix). Additive,
 * within 9: `ModuleInfo.version` / `apiVersion` / `templates`, `ToolInfo.risk` / `sensitivity` / `latency`, the
 * issue registry (`health`, `admin.snapshot.health`) and "Check again" (`health.check`, admin only).
 *
 * 10: extended settings fields and module routes (docs/MODULES-PLAN.md §4 P3). `SettingField` gains `textList`,
 * `records`, `combo`, `action` and `info` and `SettingValue` a list of records (new members of closed sets: a
 * version 9 page would refuse a form that uses them); `ErrorCode` gains `unknown_action` and `not_running`.
 * Additive, within 10: `module.action` (admin only) and `Result.action`, `ModuleInfo.routes`, `ModuleInfo.toolsLeft`,
 * `ModuleInfo.details` (a light snapshot entry whose complete entry follows in `module.changed`), and the module route
 * API (`moduleRoutes.ts`); the household messages to voice pages (§4 P4: `household.snapshot`, `household.event`,
 * `household.gap`, `household.ts`), which a page that does not show household data ignores.
 *
 * 11: people, rooms and device capabilities (docs/MODULES-PLAN.md §4 P5). `DeviceSettingsKey` gains `place` and
 * `capabilities` and `DeviceSettings` requires both (`DevicePlace`, `CapabilityOverrides`), so a version 10 peer would
 * refuse a version 11 device entry. Additive, within 11: `hello.device.capabilities` and `device.caps`
 * (`DeviceCapabilities`, `DeviceLiveState`), `DeviceRecord.declared`, `DeviceListInfo.declared` / `live`, and
 * `RecordItemField.hidden` (a record field kept but not drawn: a person's id in Members), `EnvEntry.refused` (a known
 * variable that is not read, with why: `HOUSEHOLD_MEMBERS`). `DevicePlace.room` is one line of text.
 * P9, additive within 11 (docs/NOTIFICATIONS.md): `notification.ring` and `notification.resolved` (server → voice
 * pages; a page that does not know them ignores them), `notification.action` (a request a newer page sends; an older
 * page never sends it, and the server needs nothing from a page that does not) and `Result.say`. No closed set
 * gains a member: a press of an action whose handler is not running is answered with the existing `not_running`.
 * P7, additive within 11 (docs/PHRASES.md): `TraceInfo.phrase` (an optional key: a taken utterance's execution trace),
 * `output.volume` (server → the voice connections of one device: the reply
 * output's gain; a page that does not know it ignores it and the server needs nothing from it) and the optional
 * `DevicePlace.ringingWithoutWake` (absent means on; an older peer ignores the key, a newer one accepts its absence). No
 * closed set gains a member, so the version stays 11.
 * P10, additive within 11 (docs/PRESENTING.md): `present.show`, `present.update` and `present.dismiss` (server → voice
 * pages; a page that does not know them ignores them, and it is sent none, because it declares no presentation kinds)
 * and `present.action` (a request only a newer page sends). No closed set the decoder checks gains a member: the kinds
 * live inside the new messages, and `present.kinds` in a declaration was always an open record. So the version stays.
 *
 * 12: voice nodes (docs/VOICE-NODES.md §5). Device type `voice-node`; `DeviceSettingsKey` gains `sound` and
 * `soundDevices` (a closed set; required in `DeviceSettings`), `DeviceTypeDefinition`/`DeviceTypeInfo.followUpUnset`;
 * `hello.node` (required for a node; a node declares speaker and microphone in `hello.device.capabilities`); client `node.status`, `node.level` (node only),
 * `node.command.send`, `node.pair.create`, `node.pair.cancel` (admin); server `node.command` (to the node),
 * `node.paired`, `node.meter` (admin only); `result.pairing`; `devices` entries carry `node` and `capabilities`;
 * `device.setup` carries `sound` and `soundDevices` for a node; close code 4403 (`unauthorized`). HTTP: `/node/*`
 * (not part of the WebSocket protocol, but its schemas are here).
 */
export const PROTOCOL_VERSION = 12

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
  /**
   * P5: a setting that decides what the device may be told or sent changed (its privacy, its default person, its
   * speaker or display overrides, or a person left Members). The device's session ended with its connections; the
   * page reconnects at once and starts a fresh session ("Settings changed; the conversation started again").
   */
  settingsChanged: 4205,
  /** The connection fell too far behind (send buffer over the limit); reconnect to get a fresh snapshot. */
  tooSlow: 4408,
  /** Connection limit reached. */
  tooManyConnections: 4429,
  /** Protocol 12: a node hello without a valid credential; an unpaired id posing as a node; a browser hello naming a paired node's id; a node removed while connected. */
  unauthorized: 4403
} as const
