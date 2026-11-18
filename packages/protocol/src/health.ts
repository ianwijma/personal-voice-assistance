import { Schema } from "effect"
import { ASSISTANT_HANDLES_CHARS, ASSISTANT_NAME_CHARS, ASSISTANT_PROMPT_CHARS, ASSISTANT_PURPOSE_CHARS } from "./assistants.ts"
import { ModuleId, NonNegativeFinite } from "./common.ts"

/**
 * Protocol 9: health, requirements and module manifests (docs/MODULES-PLAN.md §4 P1,
 * docs/research/module-investigation/module-definition-config-and-dependencies.md §C.3–C.5).
 *
 * An **issue** (`HealthIssue`; core calls it `Issue`) is one thing that is wrong or worth knowing, with what fixes it: a missing program a module needs, a
 * module's own `health()` finding. The server keeps them in one issue registry
 * and sends them to admin pages (`health`); the Health page shows them with "Check again" (`health.check`).
 */

/**
 * Bounds of the lists protocol 9 added, so that no message exceeds the frame limit (`MAX_TEXT_FRAME_BYTES`, 1 MiB).
 * The server enforces them when it builds a list and says what it left out ("and 12 more"); a list over its bound
 * is refused by the codec.
 */
export const MAX_HEALTH_ISSUES = 100
export const MAX_MODULE_TEMPLATES = 8
export const MAX_TEMPLATE_MODULES = 32
export const MAX_TEMPLATE_PHRASES = 8
export const MAX_TOOL_RISKS = 5
/**
 * The most a `HealthInfo` may take, serialised as JSON (UTF-8 bytes, escapes counted): the per-field and count maxima
 * alone allow an escaped list of over 2 MB, so the whole is bounded too, with room for the rest of an admin snapshot
 * under the frame limit (`MAX_TEXT_FRAME_BYTES`, 1 MiB). The server's issue registry stays under it.
 */
export const MAX_HEALTH_BYTES = 256 * 1024

/** UTF-8 length of a string (the protocol package has no DOM or Node types, so no `TextEncoder`). */
const utf8Length = (text: string): number => {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** How bad an issue is: `error` stops something working (doctor exits non-zero), `warning` may, `info` is a fact. */
export const IssueSeverity = Schema.Literals(["error", "warning", "info"])
export type IssueSeverity = typeof IssueSeverity.Type

/**
 * What fixes an issue: a `command` the owner runs (shown, never run by the server: `value` is the command line), a
 * `link` to open (`value`: a URL or an admin path such as `#settings/shared/modules`), or a `job` the server can run
 * (`value`: the job's tool id; no fix in protocol 9 is a job yet).
 */
export const IssueFix = Schema.Struct({
  kind: Schema.Literals(["command", "link", "job"]),
  /** One short line: "Install ffmpeg". */
  label: Schema.String.check(Schema.isMaxLength(200)),
  value: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000)))
})
export type IssueFix = typeof IssueFix.Type

export const HealthIssue = Schema.Struct({
  /** Stable within its source ("music.requires.yt-dlp", "core.node"): the same problem keeps its id across checks. */
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** The module it is about; absent for an issue the app reports itself. */
  module: Schema.optionalKey(ModuleId),
  /** The device it is about, when it is one device's problem. */
  device: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  severity: IssueSeverity,
  /** One line: "yt-dlp is missing". */
  title: Schema.String.check(Schema.isMaxLength(200)),
  /** What it means and why: "Music needs it to resolve stream addresses." May be empty. */
  detail: Schema.String.check(Schema.isMaxLength(2000)),
  fix: Schema.optionalKey(IssueFix)
})
export type HealthIssue = typeof HealthIssue.Type

/** The issue registry as admin pages see it: every current issue, and when the last check finished. */
export const HealthInfo = Schema.Struct({
  /** At most `MAX_HEALTH_ISSUES`; the server's last one says how many more there are. */
  issues: Schema.Array(HealthIssue).check(Schema.isMaxLength(MAX_HEALTH_ISSUES)),
  /** Epoch ms of the last completed check (probes and every module's `health()`); absent before the first. */
  checkedAt: Schema.optionalKey(NonNegativeFinite),
  /** A check ("Check again", or the one at start) is running. */
  checking: Schema.Boolean
}).check(Schema.makeFilter((h) => utf8Length(JSON.stringify(h)) <= MAX_HEALTH_BYTES || `the issues take more than ${MAX_HEALTH_BYTES} bytes`))
export type HealthInfo = typeof HealthInfo.Type

/**
 * Why a module cannot run on this server (`ModuleState` `unavailable`): a program or a platform it needs is missing,
 * or it was written for a module API this server does not support. Distinct from `error` (it tried to start and
 * failed): an unavailable module is never started.
 */
export const ModuleUnavailable = Schema.Struct({
  /** One sentence: "yt-dlp is missing", "Written for module API 3; this server supports 1–2". */
  reason: Schema.String.check(Schema.isMaxLength(500)),
  fix: Schema.optionalKey(IssueFix)
})
export type ModuleUnavailable = typeof ModuleUnavailable.Type

/** Template ids: `<moduleId>.<id>` on the wire (unique across modules). */
export const TemplateId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9_-]{0,39}$/))
export type TemplateId = typeof TemplateId.Type

/**
 * A suggested assistant a module ships (module-definition §A.1): plain data the new-assistant flow offers. The owner
 * instantiates it; a template never becomes an assistant by itself, and a module update never changes an assistant
 * made from one.
 */
export const AssistantTemplate = Schema.Struct({
  /** `<moduleId>.<id>`. */
  id: TemplateId,
  /** The assistant's name (the limits are the assistant's own, so a template always makes a valid assistant). */
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ASSISTANT_NAME_CHARS)),
  prompt: Schema.String.check(Schema.isMaxLength(ASSISTANT_PROMPT_CHARS)),
  /** What it is for, one line (`Assistant.purpose`). */
  purpose: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(ASSISTANT_PURPOSE_CHARS))),
  /** What it handles, for routing by TypeSafe (`Assistant.handles`). */
  handles: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(ASSISTANT_HANDLES_CHARS))),
  /** The modules it has on (the shipping module first). */
  modules: Schema.Array(ModuleId).check(Schema.isMaxLength(MAX_TEMPLATE_MODULES)),
  /** Wake phrases it suggests; the owner accepts them per device. */
  suggestedPhrases: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(60))).check(Schema.isMaxLength(MAX_TEMPLATE_PHRASES)))
})
export type AssistantTemplate = typeof AssistantTemplate.Type
