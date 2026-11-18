import { Schema } from "effect"
import { type CoreStorage, defineCollection, maxListRows, type Row } from "./HouseholdStore.ts"
import { type JobRow, type JobState, MAX_JOB_PAGE, SCHEDULER_OWNER } from "./Scheduler.ts"

/**
 * The scheduler's data in the household store (docs/SCHEDULING.md "How it is stored"): the collection `jobs` of the
 * core owner `core.scheduler`, and a counter per module (`job_counts`) for the live-job limit. Both are prepared with
 * the modules' collections (`store.prepare(modules, [schedulerStorage])`) in serve mode, the CLI modes and
 * `makeTestHousehold`, and reached through `store.forCore("core.scheduler")`, which no module is given.
 *
 * A row holds what a job is (module, handler, key, payload, due time, cron, zone, late policy, origin, state, attempt,
 * last error, finishing time) and **index fields derived from it on every write** (`withIndexes`), so they can never
 * disagree with it:
 *
 * | field | value | present | index | read by |
 * |---|---|---|---|---|
 * | `ready` | `"<module>/<handler>"` | only while `scheduled` | `[ready, at]` | the loop: per published handler, its earliest job |
 * | `liveKey` | `"<module>/<key>"` | only while live | `liveKey` | one live job per key; `cancel({ key })`, `list({ key })` |
 * | `liveModule` | the module | only while live | `[liveModule, at]` | a module's `list` |
 * | `list` | `"live"` / `"finished"` | always | `[list, at]` | the admin list; retention (finished, oldest first) |
 * | `at` | live: `dueAt`; finished: `finishedAt` | always | (the order of the four pairs) | |
 * | `state` | the state | always | `[state, at]` | the recovery rule (`running` rows) |
 * | `issue` | `true` | a failed job, or a live one whose last occurrence failed | `issue` | the Health issues |
 */

const Person = Schema.Struct({
  id: Schema.String,
  how: Schema.Literals(["device-default", "voice", "chosen"]),
  confidence: Schema.optionalKey(Schema.Finite)
})

const Late = Schema.Union([Schema.Literal("run"), Schema.Struct({ withinMs: Schema.Finite })])

const State = Schema.Literals(["scheduled", "running", "done", "failed", "cancelled", "missed"])

/** A job's stored value (its own fields and the derived index fields). */
export const StoredJob = Schema.Struct({
  module: Schema.String,
  handler: Schema.String,
  key: Schema.optionalKey(Schema.String),
  payload: Schema.Json,
  state: State,
  dueAt: Schema.Finite,
  cron: Schema.optionalKey(Schema.String),
  timeZone: Schema.optionalKey(Schema.String),
  late: Late,
  origin: Schema.Struct({
    assistantId: Schema.optionalKey(Schema.String),
    deviceId: Schema.optionalKey(Schema.String),
    person: Schema.optionalKey(Person)
  }),
  attempt: Schema.Finite,
  /** The occurrence the attempts so far were for (set at the first claim, cleared when the occurrence ends). */
  occurrenceAt: Schema.optionalKey(Schema.Finite),
  lastError: Schema.optionalKey(Schema.String),
  failedAt: Schema.optionalKey(Schema.Finite),
  finishedAt: Schema.optionalKey(Schema.Finite),
  // Index fields (derived: `withIndexes`).
  ready: Schema.optionalKey(Schema.String),
  liveKey: Schema.optionalKey(Schema.String),
  liveModule: Schema.optionalKey(Schema.String),
  list: Schema.Literals(["live", "finished"]),
  at: Schema.Finite,
  issue: Schema.optionalKey(Schema.Literal(true))
})
export type StoredJob = typeof StoredJob.Type

/** A job's own fields (without the derived index fields). */
export type JobFields = Omit<StoredJob, "ready" | "liveKey" | "liveModule" | "list" | "at" | "issue">

/**
 * The most characters of a row's JSON. The worst legal row is about 4,400 characters: a payload of 2,000, a key of 200
 * (twice: `key`, `liveKey`), a module id of 40 (three times), a handler of 64 (twice), a cron of 120, a zone of 64, three
 * origin ids of 200, a last error of 300 that JSON may double, the numbers and the field names
 * (`SchedulerJobs.test.ts` builds it). So one list returns at most `floor(120,000 / 5,000)` = 24 rows (`MAX_JOB_PAGE`).
 */
export const JOB_MAX_CHARS = 5_000

export const jobs = defineCollection({
  name: "jobs",
  scope: "household",
  schema: StoredJob,
  maxChars: JOB_MAX_CHARS,
  indexes: [["ready", "at"], "liveKey", ["liveModule", "at"], ["list", "at"], ["state", "at"], "issue"]
})

/** Live jobs per module (the row's id is the module id): the `MAX_LIVE_JOBS` check is one read. */
export const JobCount = Schema.Struct({ live: Schema.Finite })
export const jobCounts = defineCollection({ name: "job_counts", scope: "household", schema: JobCount, maxChars: 100 })

/** What `prepare` declares for the scheduler (data version 1). */
export const schedulerStorage: CoreStorage = { owner: SCHEDULER_OWNER, storage: { version: 1, collections: [jobs, jobCounts] } }

if (maxListRows(jobs) !== MAX_JOB_PAGE) throw new Error(`MAX_JOB_PAGE must be maxListRows(jobs) = ${maxListRows(jobs)}`)

export const isLive = (state: JobState): boolean => state === "scheduled" || state === "running"

/** The stored value of `fields`, with its index fields derived (every write goes through this). */
export const withIndexes = (fields: JobFields): StoredJob => {
  const live = isLive(fields.state)
  const v: Record<string, unknown> = { ...fields }
  for (const k of ["ready", "liveKey", "liveModule", "issue"]) delete v[k]
  if (fields.state === "scheduled") v.ready = `${fields.module}/${fields.handler}`
  if (live && fields.key !== undefined) v.liveKey = `${fields.module}/${fields.key}`
  if (live) v.liveModule = fields.module
  v.list = live ? "live" : "finished"
  v.at = live ? fields.dueAt : fields.finishedAt ?? fields.dueAt
  if (fields.state === "failed" || (live && fields.failedAt !== undefined)) v.issue = true
  return v as StoredJob
}

/** The own fields of a stored value (a fresh object). */
export const fieldsOf = (v: StoredJob): JobFields => {
  const { at: _a, issue: _i, list: _l, liveKey: _k, liveModule: _m, ready: _r, ...fields } = v
  return fields
}

/** A row as the contract shows it. */
export const jobRowOf = (row: Row<StoredJob>): JobRow => {
  const v = row.value
  return {
    id: row.id,
    module: v.module,
    handler: v.handler,
    ...(v.key !== undefined ? { key: v.key } : {}),
    payload: v.payload,
    state: v.state,
    dueAt: v.dueAt,
    ...(v.cron !== undefined ? { cron: v.cron } : {}),
    ...(v.timeZone !== undefined ? { timeZone: v.timeZone } : {}),
    late: v.late,
    origin: v.origin,
    attempt: v.attempt,
    ...(v.lastError !== undefined ? { lastError: v.lastError } : {}),
    ...(v.failedAt !== undefined ? { failedAt: v.failedAt } : {}),
    ...(v.finishedAt !== undefined ? { finishedAt: v.finishedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rev: row.rev
  }
}
