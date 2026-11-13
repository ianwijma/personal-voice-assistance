import { Schema } from "effect"
import { NonNegativeFinite } from "./common.ts"

/**
 * Long-running work on the server (docs/SETTINGS-UI.md §4.6, §5): downloads of speech models now, the installers
 * and logins of piece P6 later. A job runs on the server, so closing the tab does not stop it; every page sees its
 * progress (`job`), and only a page with admin access may start or cancel one. The server accepts only targets from
 * its own tables (preset names), never a URL or a path from a page.
 */

/** What a job works on. A closed set (the allowlist): adding a tool is a protocol change. */
export const ToolId = Schema.Literals(["stt-models", "tts-models"])
export type ToolId = typeof ToolId.Type

export const JobAction = Schema.Literals(["download"])
export type JobAction = typeof JobAction.Type

export const JobState = Schema.Literals(["running", "succeeded", "failed", "cancelled"])
export type JobState = typeof JobState.Type

/** `check`: free disk space; `download`: bytes from the network; `unpack`: decompressing (bytes of the archive read). */
export const JobPhase = Schema.Literals(["check", "download", "unpack"])
export type JobPhase = typeof JobPhase.Type

export const JobInfo = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  tool: ToolId,
  action: JobAction,
  /** A preset name of the tool's table. */
  target: Schema.String,
  /** What it is, for people ("Parakeet v2 — accurate, English"). */
  label: Schema.String,
  state: JobState,
  phase: Schema.optionalKey(JobPhase),
  progress: Schema.optionalKey(Schema.Struct({
    done: NonNegativeFinite,
    /** Absent: not known (no Content-Length). */
    total: Schema.optionalKey(NonNegativeFinite),
    unit: Schema.Literals(["bytes"])
  })),
  /** The last lines of what the job did (at most 50), for the details view. */
  log: Schema.Array(Schema.String),
  /** Why it failed (`failed`), one sentence. */
  error: Schema.optionalKey(Schema.String),
  /** Epoch milliseconds. */
  startedAt: NonNegativeFinite,
  endedAt: Schema.optionalKey(NonNegativeFinite)
})
export type JobInfo = typeof JobInfo.Type

/** One downloadable model. */
export const ModelItem = Schema.Struct({
  /** The preset name (the `target` of a job). */
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** Download size in MB (10^6 bytes). */
  sizeMb: NonNegativeFinite,
  /** Space it takes once unpacked, in MB. */
  diskMb: NonNegativeFinite,
  installed: Schema.Boolean,
  /** The running engines use it: it cannot be deleted. */
  inUse: Schema.Boolean
})
export type ModelItem = typeof ModelItem.Type

/** The models of one tool (the recogniser's, the voices'), for the Models pages. */
export const ModelSet = Schema.Struct({
  tool: ToolId,
  title: Schema.String,
  /** The models folder on the server (read-only). */
  directory: Schema.String,
  /** Free space in that folder, MB. Absent: not known. */
  freeMb: Schema.optionalKey(NonNegativeFinite),
  items: Schema.Array(ModelItem)
})
export type ModelSet = typeof ModelSet.Type

/** At most this many finished jobs are kept (the running ones are always kept). */
export const MAX_FINISHED_JOBS = 10
export const JOB_LOG_LINES = 50
