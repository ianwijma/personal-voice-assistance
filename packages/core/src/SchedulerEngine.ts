import { Cause, Clock, Cron, Deferred, Effect, Exit, Result, Schema, Scope } from "effect"
import { asPrincipal, type ExecutionGateway } from "./Gateway.ts"
import {
  type Actor,
  BULK_STEP_ROWS,
  CORE_OWNER,
  type CoreOwner,
  type HouseholdStore,
  isStoreFailure,
  maxListRows,
  type Row,
  SAFE_ID,
  StoreError,
  type StoreFailure,
  type StoreTx,
  type TxCollection
} from "./HouseholdStore.ts"
import type { IssueRegistry } from "./Issues.ts"
import { oneLine } from "./Issues.ts"
import { type Issue, isModuleStopped } from "./ModuleApi.ts"
import type { PartHandle, Registration } from "./ModuleRegistrations.ts"
import {
  DEFAULT_HANDLER_TIMEOUT_MS,
  DEFAULT_RETRIES,
  type DueInfo,
  HANDLER_NAME,
  JOB_KEY,
  type JobHandler,
  type JobListQuery,
  type JobPage,
  type JobRow,
  type JobView,
  KEEP_FINISHED_MS,
  type LatePolicy,
  MAX_CRON_CHARS,
  MAX_ERROR_CHARS,
  MAX_HANDLER_TIMEOUT_MS,
  MAX_LIVE_JOBS,
  MAX_PAYLOAD_CHARS,
  MAX_RETRIES,
  MAX_TIME,
  type ModuleScheduler,
  ORIGIN_ID,
  type PartRunner,
  type PreparedJob,
  type RescheduleWhen,
  SCHEDULER_OWNER,
  type ScheduleOrigin,
  type ScheduleRequest,
  SchedulerError,
  type SchedulerHook
} from "./Scheduler.ts"
import { MAX_CHECKED_LENGTH } from "./PageBoundary.ts"
import {
  type JobCount,
  jobCounts,
  type JobFields,
  jobRowOf,
  jobs,
  fieldsOf,
  isLive,
  MAX_JOB_PAGE,
  storedError,
  type StoredJob,
  withIndexes
} from "./SchedulerJobs.ts"
import { CurrentJob, CurrentTurn, type JobOrigin, type TurnPerson } from "./TurnContext.ts"

/**
 * The scheduler's engine (docs/SCHEDULING.md): one fiber over the household store's `jobs` collection of
 * `core.scheduler`. Serve mode runs it on the SQLite store; `makeTestScheduler` (`@pva/core/testing`) on the in-memory
 * store and the test clock. The contract tests (`@pva/core/scheduler-contract`) run on both.
 *
 * - **The loop** sleeps until the earliest due time among jobs whose handler is published (per published handler one
 *   indexed read of its earliest job), or until its maintenance is due; it is woken by a schedule, a reschedule, a
 *   cancel, a handler being published, a run ending, and a jump of the wall clock. A job whose handler is not published
 *   is never read by it and stays `scheduled`.
 * - **A run**: claimed in one transaction (`running`, attempt + 1, the claim's `rev` kept), run in a fiber of its own
 *   as a call in flight of its module (`PartRunner.inFlight`) with the job's origin as its principal (`CurrentJob`,
 *   admitted by the execution gateway), within the handler's time limit; its outcome written in a second transaction
 *   with `expectRev` of the claim. A conflict there means the job was rescheduled or cancelled meanwhile: the outcome
 *   is dropped.
 * - **The recovery rule**: a row `running` with no run alive in this process failed without telling. It is applied to
 *   a handler's rows when the handler is published (so at start, as each handler first appears) and to every published
 *   handler's rows by the maintenance pass.
 * - **Maintenance**, every `maintenanceMs` and also when nothing is due: finished rows older than `keepFinishedMs` are
 *   removed (at most `RETENTION_ROWS_PER_PASS` a pass, `RETENTION_STEP_ROWS` a transaction), the recovery rule, the
 *   recount of each module's live jobs (a counter that disagrees with the rows is repaired), the Health issues.
 * - **Fairness**: a pass is one round: at most one due job per published handler (as published when the pass starts),
 *   starting at the handler after the one whose job it last started. A pass that moved a job on is followed at once by
 *   the next, so one handler with many due jobs cannot keep another's waiting, nor a handler published, a job become
 *   due, maintenance or the Health issues.
 */

export interface SchedulerEngineOptions {
  /** The household store, prepared with `schedulerStorage` (`SchedulerJobs.ts`). */
  readonly store: HouseholdStore
  /** Where failed jobs show (source `scheduler`). */
  readonly issues?: IssueRegistry
  /** `HOME_TIME_ZONE`, read each time a cron job without a zone is planned. Absent or empty: the server's zone. */
  readonly timeZone?: () => string | undefined
  /** The module catalogue (ids and names), for the admin list's names. Absent: ids. */
  readonly modules?: () => ReadonlyArray<{ readonly id: string; readonly name: string }>
  /** The execution gateway that admits a job's principal before its handler runs (late-bound). Absent: not checked. */
  readonly gateway?: () => ExecutionGateway | undefined
  /** The page boundary (`ModuleHost.pageText`): module text on its way to the admin page and Health. Default: one line. */
  readonly pageText?: (moduleId: string, text: unknown, max: number) => string
  readonly log?: (line: string) => void
  /** The first retry delay of an idempotent handler (doubling, at most 10 min). Default 5 s. */
  readonly retryBaseMs?: number
  /** Longest single sleep, and so how soon a jump of the wall clock is noticed. Default 10 s. */
  readonly jumpCheckMs?: number
  /** How often the maintenance pass runs. Default 10 min. */
  readonly maintenanceMs?: number
  /** Finished jobs are kept this long. Default `KEEP_FINISHED_MS` (7 days). */
  readonly keepFinishedMs?: number
  /** Runs at once; at the cap the loop claims nothing more until one ends. Default 32. */
  readonly maxRuns?: number
  /** Pauses before the attempts to write an outcome again when the store is busy or failing. Default 250 ms, 1 s, 4 s. */
  readonly outcomeRetryMs?: ReadonlyArray<number>
  /** Job ids (tests). Default random. */
  readonly newId?: () => string
  /**
   * Measurements (the latency test): a loop pass's wall time and the jobs it claimed, a retention step's time (one
   * transaction). Must not throw.
   */
  readonly observe?: (event: { readonly kind: "pass"; readonly ms: number; readonly handlers: number; readonly claimed: number } | { readonly kind: "retention-step"; readonly ms: number; readonly removed: number }) => void
}

/** A core service's scheduler (P9): the module calls, and handlers registered for a scope (the server's life). */
export interface CoreScheduler extends Omit<ModuleScheduler, "handle"> {
  readonly handle: <P, I>(name: string, handler: JobHandler<P, I>) => Effect.Effect<void, SchedulerError, Scope.Scope>
}

export interface SchedulerEngine extends SchedulerHook {
  /** The scheduler of a core service `core.<name>`: its jobs are its own, its handlers live while the scope does. */
  readonly forCore: (owner: CoreOwner) => CoreScheduler
  /** The admin list, a page at a time: live jobs by due time, then finished ones newest first. */
  readonly listAll: (options?: { readonly cursor?: string; readonly limit?: number }) => Effect.Effect<JobPage, SchedulerError>
  /** The admin page's cancel (any owner's job). False: no such job, or it had finished. */
  readonly cancelAny: (id: string) => Effect.Effect<boolean, SchedulerError>
  /** Wake the loop now. */
  readonly wake: () => void
  /** Recompute the Health issues now. */
  readonly refreshIssues: Effect.Effect<void>
  /** Run the maintenance pass at the loop's next turn (retention, the recovery rule, the issues). */
  readonly maintainSoon: () => void
  /** Runs in flight in this process. */
  readonly runsInFlight: () => number
  /** Tests: completes once the loop is waiting again (after at most a few thousand yields). */
  readonly settled: Effect.Effect<void>
}

/** Finished rows removed by one maintenance pass at most (more: the next pass follows a second later). */
export const RETENTION_ROWS_PER_PASS = 200
/** Finished rows removed by one transaction of retention: `BULK_STEP_ROWS`, at most one list of `jobs`. */
export const RETENTION_STEP_ROWS = Math.min(BULK_STEP_ROWS, MAX_JOB_PAGE)
/** Failed jobs shown as Health issues at most (the newest failures; one more issue, without a number, says there are more). */
export const MAX_JOB_ISSUES = 48
/** The most jobs one page of the admin list holds (`listAll`): two reads of `MAX_JOB_PAGE`, with a yield between. */
export const MAX_ADMIN_JOB_PAGE = 2 * MAX_JOB_PAGE

const COUNTER_PAGE = maxListRows(jobCounts)
const JUMP_MS = 2_000
const MAX_BACKOFF_MS = 10 * 60_000
const ZONE = /^[A-Za-z0-9_/+-]{1,48}$/
const CRON_TEXT = /^[0-9A-Za-z*/,?#LW -]+$/

/**
 * Why the scheduler would refuse `expr` as a job's cron schedule (in `timeZone`, default the server's), or `undefined`
 * when it accepts it: the same checks `schedule` and `prepare` make (docs/SCHEDULING.md, "Cron"). For a module's own
 * checks of a schedule it builds, and for `checkModule`.
 */
export const isSchedulerCron = (expr: unknown, timeZone?: string): string | undefined => {
  if (typeof expr !== "string" || expr.length > MAX_CRON_CHARS || !CRON_TEXT.test(expr)) return `cron must be a cron expression of at most ${MAX_CRON_CHARS} characters`
  // Checked before it is parsed or planned: a day of month or a month can make `Cron.next` search for years.
  const segments = expr.trim().split(/\s+/)
  if ((segments.length !== 5 && segments.length !== 6) || segments[segments.length - 3] !== "*" || segments[segments.length - 2] !== "*") {
    return `"${expr}": cron is for system jobs, with minute, hour and day-of-week fields (and seconds first, if you like); day of month and month must be *. For a date, schedule a one-off job (at) and schedule the next one from its handler`
  }
  if (timeZone !== undefined && (typeof timeZone !== "string" || !ZONE.test(timeZone))) return "timeZone must be a time zone name (Europe/Amsterdam)"
  const parsed = Cron.parse(expr, timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  if (Result.isFailure(parsed)) return `"${expr}"${timeZone !== undefined ? ` in ${timeZone}` : ""} is not a cron schedule: ${parsed.failure.message}`
  try {
    if (!Number.isFinite(Cron.next(parsed.success, new Date()).getTime())) return `"${expr}" never fires (there is no time it matches)`
  } catch {
    return `"${expr}" never fires (there is no time it matches)`
  }
  return undefined
}
const SYSTEM: Actor = { kind: "system", name: "scheduler" }
const ADMIN: Actor = { kind: "admin" }

/** Why a run ended, as its outcome sees it. */
type Verdict =
  | { readonly _tag: "done" }
  | { readonly _tag: "failed"; readonly message: string; readonly retriable: boolean }
  | { readonly _tag: "stopped"; readonly why: string }

class RunRefused extends Schema.TaggedError<RunRefused>()("RunRefused", { reason: Schema.String }) {}
class PayloadInvalid extends Schema.TaggedError<PayloadInvalid>()("PayloadInvalid", { message: Schema.String }) {}
class RunTimeout extends Schema.TaggedError<RunTimeout>()("RunTimeout", { ms: Schema.Number }) {}

/** The scheduler's collections inside one transaction (its own, or a module's it joined). */
type TxParts = { readonly jobs: TxCollection<StoredJob>; readonly counts: TxCollection<typeof JobCount.Type>; readonly tx: StoreTx }

/** A handler as the engine keeps it while it is published. */
interface Published {
  readonly owner: string
  readonly name: string
  /** `<owner>/<name>`. */
  readonly key: string
  readonly idempotent: boolean
  readonly retries: number
  readonly timeoutMs: number
  readonly decode: (u: unknown) => Effect.Effect<unknown, Schema.SchemaError>
  /** Why a stored payload does not decode with the handler's schema, or `undefined` (checked when a job is scheduled). */
  readonly payloadProblem: (u: unknown) => string | undefined
  readonly run: (payload: any, due: DueInfo) => Effect.Effect<void, unknown>
  /** A module part's: how it runs as a call in flight. Absent for a core handler. */
  readonly runner?: PartRunner
  /**
   * Where a core handler's runs are forked: a scope of the engine's run scope that its registration's scope also
   * closes, so either lifetime ending interrupts them. Absent (a module part's): the run scope itself.
   */
  readonly scope?: Scope.Scope
}

/** What an error says, in full (a handler's failure: the page boundary sees all of it before it is shortened). */
const textOf = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : String(error)
  } catch {
    return "(an error that cannot be shown as text)"
  }
}
/** An error for a log line or a refusal: one line, shortened. */
const messageOf = (error: unknown): string => oneLine(textOf(error), 300)

const failedWith = (reason: SchedulerError["reason"], message: string) => new SchedulerError({ reason, message })
const invalid = (message: string) => failedWith("invalid", message)
const fromStore = (e: StoreFailure): SchedulerError =>
  e._tag === "StoreError"
    ? failedWith(e.reason === "read-only" || e.reason === "unavailable" ? "unavailable" : e.reason === "busy" ? "busy" : e.reason === "invalid" ? "invalid" : "failed", e.message)
    : failedWith("failed", e.message)

/** A payload as it is stored: `JSON.stringify`'s form, at most `MAX_PAYLOAD_CHARS`. */
const payloadOf = (payload: unknown): { readonly ok: true; readonly value: Schema.Json } | { readonly ok: false; readonly message: string } => {
  // An absent payload is the empty object, so a handler whose payload is `Schema.Struct({})` takes it.
  if (payload === undefined) return { ok: true, value: {} }
  let text: string | undefined
  try {
    text = JSON.stringify(payload)
  } catch (error) {
    return { ok: false, message: `payload is not JSON: ${messageOf(error)}` }
  }
  if (text === undefined) return { ok: false, message: "payload is not JSON" }
  if (text.length > MAX_PAYLOAD_CHARS) return { ok: false, message: `payload has ${text.length} characters of JSON (at most ${MAX_PAYLOAD_CHARS}); keep large data in the module's own collection and schedule its id` }
  return { ok: true, value: JSON.parse(text) as Schema.Json }
}

const personProblem = (p: unknown): string | undefined => {
  if (typeof p !== "object" || p === null) return "origin.person must be { id, how }"
  const { confidence, how, id } = p as Partial<TurnPerson>
  if (typeof id !== "string" || !ORIGIN_ID.test(id)) return "origin.person.id must be 1–64 letters, digits and _ . : -"
  if (how !== "device-default" && how !== "voice" && how !== "chosen") return "origin.person.how must be device-default, voice or chosen"
  if (confidence !== undefined && !Number.isFinite(confidence)) return "origin.person.confidence must be a number"
  return undefined
}

/** A given origin, checked and copied (only the known fields). */
const checkedOrigin = (o: unknown): ScheduleOrigin | string => {
  if (typeof o !== "object" || o === null) return "origin must be an object"
  const { assistantId, deviceId, person } = o as ScheduleOrigin
  for (const [name, v] of [["assistantId", assistantId], ["deviceId", deviceId]] as const) {
    if (v !== undefined && (typeof v !== "string" || !ORIGIN_ID.test(v))) return `origin.${name} must be 1–64 letters, digits and _ . : -`
  }
  if (person !== undefined) {
    const problem = personProblem(person)
    if (problem !== undefined) return problem
  }
  return {
    ...(assistantId !== undefined ? { assistantId } : {}),
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(person !== undefined ? { person: { id: person.id, how: person.how, ...(person.confidence !== undefined ? { confidence: person.confidence } : {}) } } : {})
  }
}

/** The origin of the call now: the job's (inside a handler), else the turn's, else none. Ids that do not fit are left out. */
const originNow: Effect.Effect<ScheduleOrigin> = Effect.gen(function*() {
  const job = yield* CurrentJob
  const turn = yield* CurrentTurn
  const from = job ?? turn
  if (from === undefined) return {}
  const checked = checkedOrigin({
    ...(from.assistantId !== undefined && ORIGIN_ID.test(from.assistantId) ? { assistantId: from.assistantId } : {}),
    ...(from.deviceId !== undefined && ORIGIN_ID.test(from.deviceId) ? { deviceId: from.deviceId } : {}),
    ...(from.person !== undefined && personProblem(from.person) === undefined ? { person: from.person } : {})
  })
  return typeof checked === "string" ? {} : checked
})

/** A time in epoch ms, as a job keeps it: a whole number from 0 to `MAX_TIME`. */
const isTime = (t: number) => Number.isFinite(t) && t >= 0 && t <= MAX_TIME

const lateProblem = (late: unknown): string | undefined =>
  late === undefined || late === "run" || (typeof late === "object" && late !== null && isTime((late as { withinMs: number }).withinMs) && Object.keys(late).length === 1)
    ? undefined
    : 'late must be "run" or { withinMs } (0 to 8.64e15)'

const REQUEST_KEYS = new Set(["handler", "payload", "key", "late", "origin", "at", "inMs", "cron", "timeZone"])

export const makeSchedulerEngine = (options: SchedulerEngineOptions): Effect.Effect<SchedulerEngine, never, Scope.Scope> =>
  Effect.gen(function*() {
    const { store } = options
    const log = options.log ?? (() => {})
    const retryBaseMs = options.retryBaseMs ?? 5_000
    const jumpCheckMs = options.jumpCheckMs ?? 10_000
    const maintenanceMs = options.maintenanceMs ?? 10 * 60_000
    const keepFinishedMs = options.keepFinishedMs ?? KEEP_FINISHED_MS
    const maxRuns = options.maxRuns ?? 32
    const outcomeRetryMs = options.outcomeRetryMs ?? [250, 1_000, 4_000]
    const newId = options.newId ?? (() => `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`)
    const pageText = options.pageText ?? ((_m: string, text: unknown, max: number) => oneLine(text, max))
    /** A failure text of `owner`'s handler as it is stored: through the page boundary in full, then `storedError`. */
    const errorText = (owner: string, text: string): string => storedError(pageText(owner, text, MAX_CHECKED_LENGTH))
    const engineScope = yield* Effect.scope
    // Runs and the loop use the engine's context, never a caller's: no turn, no transaction of someone else.
    const engineContext = yield* Effect.context<never>()
    const clock = yield* Clock.Clock
    const now = () => clock.currentTimeMillisUnsafe()
    const monotonicMs = Effect.map(Clock.monotonicTimeNanos, (n) => Number(n / 1_000_000n))
    const core = store.forCore(SCHEDULER_OWNER)
    const jobsOut = core.collection(jobs)
    const countsOut = core.collection(jobCounts)

    // ---- State of this process

    /** Published handlers by `<owner>/<name>`. */
    const published = new Map<string, Published>()
    /** Handlers registered during a start and not yet published, by owner (two of one name refuse the start). */
    const staged = new Map<string, Set<{ readonly name: string; readonly part: PartHandle; readonly payloadProblem: (u: unknown) => string | undefined }>>()
    /** The claim revs of the runs alive in this process (a running row whose rev is here is not recovered). */
    const alive = new Set<number>()
    /** Handlers published since the loop last applied the recovery rule to them. */
    const pendingRecovery = new Set<string>()
    let runCount = 0
    /** The handler whose job the loop started last: the next pass starts at the one after it (fairness). */
    let lastClaimed: string | undefined
    /** The Health issues are to be read again (set by every committed change of a row with an issue, kept by a failed read). */
    let issuesDirty = true
    let nextMaintenance = 0
    let closing = false
    let waiting = false
    /** Counts what the engine did (passes, runs, outcomes): `settled` waits until it stops moving. */
    let progress = 0
    /**
     * Admin list cursors: an unguessable token of this engine for the last row of a page. The store continues a list
     * only after a row object one of its lists returned (`ListQuery.after`), not after a row read by `get`, so a cursor
     * cannot be the row's id; a token from another engine (before a restart) is unknown here: 400, start again.
     */
    const cursors = new Map<string, { readonly phase: "live" | "finished"; readonly row: Row<StoredJob> }>()
    /** The store's rows behind the `JobRow`s `list` returned (`after`). */
    const listedRows = new WeakMap<JobRow, { readonly owner: string; readonly key: string | undefined; readonly row: Row<StoredJob> }>()

    // The runs' scope closes before the engine's: `closing` is set first (finalizers run last added, first run), so a run
    // interrupted by the shutdown is told apart from one that interrupted itself.
    const runScope = yield* Scope.fork(engineScope)
    yield* Effect.addFinalizer(() => Effect.sync(() => void (closing = true)))

    // ---- Wake-ups

    let signal = Deferred.makeUnsafe<void>()
    const wake = () => void Deferred.doneUnsafe(signal, Effect.void)

    // ---- Cron

    const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    let badZoneLogged = ""
    const householdZone = (): string => {
      const z = options.timeZone?.()?.trim()
      if (z === undefined || z === "") return serverZone
      if (Result.isSuccess(Cron.parse("* * * * *", z))) return z
      if (badZoneLogged !== z) {
        badZoneLogged = z
        log(`Scheduler: the household's time zone "${z}" is not known; cron jobs without a zone use the server's (${serverZone})`)
      }
      return serverZone
    }
    const parsedCrons = new Map<string, Cron.Cron>()
    const cronIn = (expr: string, zone: string): Cron.Cron | string => {
      const k = `${expr}\u0000${zone}`
      const known = parsedCrons.get(k)
      if (known !== undefined) return known
      const parsed = Cron.parse(expr, zone)
      if (Result.isFailure(parsed)) return parsed.failure.message
      if (parsedCrons.size > 500) parsedCrons.clear()
      parsedCrons.set(k, parsed.success)
      return parsed.success
    }
    const zoneOf = (f: { readonly timeZone?: string | undefined }) => f.timeZone ?? householdZone()
    /** The first occurrence strictly after `after`, or `undefined` when there is none. */
    const nextOccurrence = (f: { readonly cron?: string | undefined; readonly timeZone?: string | undefined }, after: number): number | undefined => {
      const cron = cronIn(f.cron!, zoneOf(f))
      if (typeof cron === "string") return undefined
      try {
        const t = Cron.next(cron, new Date(after)).getTime()
        return Number.isFinite(t) ? t : undefined
      } catch {
        return undefined
      }
    }
    /** The latest occurrence at or before `at`, or `undefined`. */
    const lastOccurrence = (f: JobFields, at: number): number | undefined => {
      const cron = cronIn(f.cron!, zoneOf(f))
      if (typeof cron === "string") return undefined
      try {
        const t = Cron.prev(cron, new Date(at + 1)).getTime()
        return Number.isFinite(t) ? t : undefined
      } catch {
        return undefined
      }
    }

    // ---- Writes: every write of a job goes through `put`, which keeps the per-module live counter

    const counterOf = (counts: TxCollection<typeof JobCount.Type>, owner: string) => counts.get(owner)
    const adjust = (counts: TxCollection<typeof JobCount.Type>, owner: string, delta: number, actor: Actor) => {
      if (delta === 0) return
      const row = counterOf(counts, owner)
      const live = Math.max(0, (row?.value.live ?? 0) + delta)
      if (row === undefined) counts.insert({ live }, { id: owner, actor })
      else counts.update(owner, () => ({ live }), { actor })
    }
    /** After the commit of `t`: when `before` or `after` had an issue, the Health issues are read again after the pass. */
    const noteIssue = (t: TxParts, before: boolean, after: boolean) => {
      if (before || after) t.tx.afterCommit(() => void (issuesDirty = true))
    }
    /** Replace `before` with `next` (with `expectRev` of `before`), and keep the counter. */
    const put = (t: TxParts, before: Row<StoredJob>, next: JobFields, actor: Actor): Row<StoredJob> => {
      const row = t.jobs.update(before.id, () => withIndexes(next), { expectRev: before.rev, actor })
      adjust(t.counts, next.module, (isLive(next.state) ? 1 : 0) - (isLive(before.value.state) ? 1 : 0), actor)
      noteIssue(t, before.value.issue === true, row.value.issue === true)
      return row
    }
    const clean = (f: { readonly [K in keyof JobFields]?: JobFields[K] | undefined }): JobFields => {
      const out: Record<string, unknown> = { ...f }
      for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
      return out as JobFields
    }

    /** One transaction on the scheduler's collections. */
    const tx = <X>(f: (t: TxParts) => X) =>
      store.transaction((htx) => {
        const own = htx.forCore(SCHEDULER_OWNER)
        return f({ jobs: own.collection(jobs), counts: own.collection(jobCounts), tx: own }) as never
      }) as Effect.Effect<X, StoreFailure>

    const backoff = (attempt: number) => Math.min(MAX_BACKOFF_MS, retryBaseMs * 2 ** Math.max(0, attempt - 1))

    /**
     * A repeating job after an occurrence: its next one (from the first after `from`), or failed when it has none. How
     * the occurrence ended: it succeeded (`"done"`: an earlier failure is cleared), it failed (its text), or it was
     * missed (`"missed"`: an earlier failure stays, with its issue, until an occurrence succeeds).
     */
    const movedOn = (f: JobFields, from: number, at: number, ended: "done" | "missed" | { readonly failure: string }): JobFields => {
      const failure = typeof ended === "object" ? ended.failure : undefined
      const next = nextOccurrence(f, from)
      if (next === undefined) {
        return clean({ ...f, state: "failed", finishedAt: at, failedAt: at, occurrenceAt: undefined, lastError: failure ?? `Its cron schedule "${f.cron}" has no next time` })
      }
      return clean({
        ...f,
        state: "scheduled",
        dueAt: next,
        attempt: 0,
        occurrenceAt: undefined,
        ...(ended === "done" ? { lastError: undefined, failedAt: undefined } : failure !== undefined ? { lastError: failure, failedAt: at } : {})
      })
    }

    // ---- Scheduling

    /** Check a request and decide what to store (everything but the id). */
    const planOf = (owner: string, request: ScheduleRequest, at: number, origin: ScheduleOrigin): JobFields | string => {
      if (typeof request !== "object" || request === null) return "a schedule request is an object"
      const unknown = Object.keys(request).find((k) => !REQUEST_KEYS.has(k))
      if (unknown !== undefined) return `unknown field "${unknown}" (handler, payload, key, late, origin, and at, inMs or cron with timeZone)`
      if (typeof request.handler !== "string" || !HANDLER_NAME.test(request.handler)) return `handler must match ${HANDLER_NAME}`
      if (request.key !== undefined && (typeof request.key !== "string" || !JOB_KEY.test(request.key))) return `key must match ${JOB_KEY}`
      const late = lateProblem(request.late)
      if (late !== undefined) return late
      const payload = payloadOf(request.payload)
      if (!payload.ok) return payload.message
      const whens = (["at", "inMs", "cron"] as const).filter((k) => request[k] !== undefined)
      if (whens.length !== 1) return "give exactly one of at, inMs or cron"
      if (request.timeZone !== undefined && request.cron === undefined) return "timeZone goes with cron"
      const base = {
        module: owner,
        handler: request.handler,
        ...(request.key !== undefined ? { key: request.key } : {}),
        payload: payload.value,
        state: "scheduled" as const,
        late: request.late === undefined || request.late === "run" ? "run" as const : { withinMs: Math.round(request.late.withinMs) },
        origin,
        attempt: 0
      }
      if (request.at !== undefined) {
        if (typeof request.at !== "number" || !isTime(request.at)) return "at must be a time in epoch milliseconds (0 to 8.64e15)"
        return { ...base, dueAt: Math.round(request.at) }
      }
      if (request.inMs !== undefined) {
        if (typeof request.inMs !== "number" || !isTime(at + request.inMs) || request.inMs < 0) return "inMs must be 0 or more (and end before 8.64e15)"
        return { ...base, dueAt: at + Math.round(request.inMs) }
      }
      const expr = request.cron
      const tz = request.timeZone
      // The text, its fields and the zone (`isSchedulerCron`, which modules and checkModule use too).
      const problem = isSchedulerCron(expr, tz)
      if (problem !== undefined) return problem
      if (typeof expr !== "string") return "cron must be a cron expression"
      const parsed = cronIn(expr, tz ?? householdZone())
      if (typeof parsed === "string") return `"${expr}"${tz !== undefined ? ` in ${tz}` : ""} is not a cron schedule: ${parsed}`
      const fields = { ...base, cron: expr, ...(tz !== undefined ? { timeZone: tz } : {}) }
      const first = nextOccurrence(fields, at)
      if (first === undefined) return `"${expr}" never fires (there is no time it matches)`
      return { ...fields, dueAt: first }
    }

    type Written = { readonly _tag: "ok"; readonly row: Row<StoredJob> } | { readonly _tag: "limit" } | { readonly _tag: "used" }

    /**
     * Write a new job in a transaction of the scheduler's collections (the caller's own, or joined). Everything that can
     * refuse is decided before the first write (the live-job limit, the key's live job, an id in use; the values are
     * made, and fit `jobs`, by construction), so a refusal leaves the transaction untouched, and what follows can fail
     * only as the store itself fails. The writes: the counter first (always written, so its rev changes whenever a
     * module's live jobs do: the recount relies on it), then the key's old job cancelled, then the new one: cut short by
     * a store failure, the counter is at worst too high, which refuses early and is repaired by the recount.
     */
    const writeJob = (t: TxParts, id: string, fields: JobFields, actor: Actor): Written => {
      const at = now()
      const old = fields.key === undefined ? undefined : t.jobs.list({ where: { liveKey: `${fields.module}/${fields.key}` }, limit: 1 })[0]
      const counter = counterOf(t.counts, fields.module)
      const live = counter?.value.live ?? 0
      if (old === undefined && live >= MAX_LIVE_JOBS) return { _tag: "limit" }
      if (t.jobs.get(id) !== undefined) return { _tag: "used" }
      const value = withIndexes(fields)
      const cancelled = old === undefined ? undefined : withIndexes(clean({ ...fieldsOf(old.value), state: "cancelled", finishedAt: at }))
      // Writes from here on.
      const count = { live: old === undefined ? live + 1 : live }
      if (counter === undefined) t.counts.insert(count, { id: fields.module, actor })
      else t.counts.update(fields.module, () => count, { actor })
      if (old !== undefined) {
        t.jobs.update(old.id, () => cancelled!, { expectRev: old.rev, actor })
        noteIssue(t, old.value.issue === true, false)
      }
      return { _tag: "ok", row: t.jobs.insert(value, { id, actor }) }
    }

    const limitMessage = (owner: string) => `${owner} has ${MAX_LIVE_JOBS} live jobs already (the most); cancel one first`

    const viewOf = (owner: string, key: string | undefined, row: Row<StoredJob>): JobRow => {
      const view = jobRowOf(row)
      listedRows.set(view, { owner, key, row })
      return view
    }

    /**
     * Why `payload` does not fit the handler `name` of `owner` as it is published now, or as it was registered by the
     * start being published (a module that schedules in `shared` right after `handle`); `undefined` when it fits or no
     * such handler is there now (a job may be scheduled before its handler appears: it is checked when it runs).
     */
    const payloadProblemOf = (owner: string, name: string, payload: unknown): string | undefined => {
      const check = published.get(`${owner}/${name}`)?.payloadProblem ?? [...(staged.get(owner) ?? [])].findLast((t) => t.name === name)?.payloadProblem
      const problem = check?.(payload)
      return problem === undefined ? undefined : `the payload does not fit the handler "${name}": ${problem}`
    }

    /** The module calls of one owner (a module, or a core service). */
    const callsFor = (owner: string, actor: Actor): Omit<ModuleScheduler, "handle"> => {
      const prepare = (request: ScheduleRequest): Effect.Effect<PreparedJob & { readonly fields: JobFields }, SchedulerError> =>
        Effect.gen(function*() {
          const given = request?.origin
          const origin = given !== undefined ? checkedOrigin(given) : yield* originNow
          if (typeof origin === "string") return yield* invalid(origin)
          const fields = planOf(owner, request, now(), origin)
          if (typeof fields === "string") return yield* invalid(fields)
          const payloadWrong = payloadProblemOf(owner, fields.handler, fields.payload)
          if (payloadWrong !== undefined) return yield* invalid(payloadWrong)
          const id = newId()
          let written = false
          return {
            id,
            dueAt: fields.dueAt,
            fields,
            writeIn: (moduleTx: StoreTx): JobRow => {
              // Refused (a `StoreError`) when the handle is not live: the job joins only a running transaction.
              moduleTx.afterCommit(wake)
              if (written) throw new StoreError({ reason: "invalid", message: "This prepared job was written already; prepare another" })
              // Joins the module's transaction (the store's transactions are flat). A refusal comes before any write. A
              // store failure in the middle of the writes is thrown too; the store has no way for joined code to make
              // the transaction fail whatever its caller catches, so the module must not catch that one and go on.
              const exit = Effect.runSyncExitWith(engineContext)(tx((t) => writeJob(t, id, fields, actor)))
              if (Exit.isFailure(exit)) {
                const error = Cause.squash(exit.cause)
                throw isStoreFailure(error) ? error : new StoreError({ reason: "failed", message: `The job could not be written: ${messageOf(error)}` })
              }
              if (exit.value._tag === "limit") throw new StoreError({ reason: "invalid", message: limitMessage(owner) })
              if (exit.value._tag === "used") throw new StoreError({ reason: "invalid", message: "This prepared job was written already; prepare another" })
              written = true
              return viewOf(owner, undefined, exit.value.row)
            }
          }
        })

      const schedule = (request: ScheduleRequest): Effect.Effect<JobRow, SchedulerError> =>
        Effect.gen(function*() {
          const job = yield* prepare(request)
          const written = yield* tx((t) => {
            t.tx.afterCommit(wake)
            return writeJob(t, job.id, job.fields, actor)
          }).pipe(Effect.mapError(fromStore))
          if (written._tag === "limit") return yield* failedWith("limit", limitMessage(owner))
          if (written._tag === "used") return yield* failedWith("failed", `The job id ${job.id} is in use`)
          return viewOf(owner, undefined, written.row)
        })

      const cancel = (target: string | { readonly key: string }): Effect.Effect<boolean, SchedulerError> =>
        Effect.suspend(() => {
          const byKey = typeof target === "object" && target !== null
          if (byKey && (typeof target.key !== "string" || !JOB_KEY.test(target.key))) return Effect.fail(invalid(`key must match ${JOB_KEY}`))
          if (!byKey && (typeof target !== "string" || !SAFE_ID.test(target))) return Effect.succeed(false)
          return cancelWhere(owner, byKey ? { key: target.key } : { id: target as string }, actor)
        })

      const reschedule = (id: string, when: RescheduleWhen): Effect.Effect<JobRow | undefined, SchedulerError> =>
        Effect.gen(function*() {
          if (typeof id !== "string" || !SAFE_ID.test(id)) return undefined
          const at = now()
          const hasAt = typeof when === "object" && when !== null && when.at !== undefined
          const hasIn = typeof when === "object" && when !== null && when.inMs !== undefined
          if (hasAt === hasIn) return yield* invalid("give exactly one of at or inMs")
          const dueAt = hasAt ? when.at! : at + (when.inMs ?? NaN)
          if (!isTime(dueAt) || (hasIn && when.inMs! < 0)) return yield* invalid(hasAt ? "at must be a time in epoch milliseconds (0 to 8.64e15)" : "inMs must be 0 or more (and end before 8.64e15)")
          const out = yield* tx((t) => {
            const row = t.jobs.get(id)
            if (row === undefined || row.value.module !== owner) return { _tag: "none" as const }
            if (!isLive(row.value.state)) return { _tag: "finished" as const, state: row.value.state }
            const payloadWrong = payloadProblemOf(owner, row.value.handler, row.value.payload)
            if (payloadWrong !== undefined) return { _tag: "invalid" as const, message: payloadWrong }
            t.tx.afterCommit(wake)
            return { _tag: "ok" as const, row: put(t, row, clean({ ...fieldsOf(row.value), state: "scheduled", dueAt: Math.round(dueAt), attempt: 0, occurrenceAt: undefined }), actor) }
          }).pipe(Effect.mapError(fromStore))
          if (out._tag === "none") return undefined
          if (out._tag === "finished") return yield* failedWith("state", `The job is ${out.state}; schedule a new one instead`)
          if (out._tag === "invalid") return yield* invalid(out.message)
          return viewOf(owner, undefined, out.row)
        })

      const get = (id: string): Effect.Effect<JobRow | undefined, SchedulerError> =>
        typeof id !== "string" || !SAFE_ID.test(id)
          ? Effect.succeed(undefined)
          : jobsOut.get(id).pipe(
            Effect.mapError(fromStore),
            Effect.map((row) => (row === undefined || row.value.module !== owner ? undefined : viewOf(owner, undefined, row)))
          )

      const list = (query: JobListQuery = {}): Effect.Effect<ReadonlyArray<JobRow>, SchedulerError> =>
        Effect.suspend(() => {
          const limit = query.limit ?? MAX_JOB_PAGE
          if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOB_PAGE) return Effect.fail(invalid(`limit must be 1 to ${MAX_JOB_PAGE}`))
          if (query.key !== undefined && (typeof query.key !== "string" || !JOB_KEY.test(query.key))) return Effect.fail(invalid(`key must match ${JOB_KEY}`))
          let after: Row<StoredJob> | undefined
          if (query.after !== undefined) {
            const from = listedRows.get(query.after)
            if (from === undefined || from.owner !== owner || from.key !== query.key) return Effect.fail(invalid("after must be a row a list of the same query returned"))
            after = from.row
          }
          const read = query.key !== undefined
            ? jobsOut.list({ where: { liveKey: `${owner}/${query.key}` }, limit, ...(after !== undefined ? { after } : {}) })
            : jobsOut.list({ where: { liveModule: owner }, orderBy: { field: "at" }, limit, ...(after !== undefined ? { after } : {}) })
          return read.pipe(
            Effect.mapError(fromStore),
            Effect.map((rows) => rows.map((row) => viewOf(owner, query.key, row)))
          )
        })

      return { schedule, prepare, cancel, reschedule, get, list }
    }

    const cancelWhere = (owner: string | undefined, target: { readonly id: string } | { readonly key: string }, actor: Actor): Effect.Effect<boolean, SchedulerError> =>
      tx((t) => {
        const row = "id" in target ? t.jobs.get(target.id) : t.jobs.list({ where: { liveKey: `${owner}/${target.key}` }, limit: 1 })[0]
        if (row === undefined || (owner !== undefined && row.value.module !== owner)) return false
        const state = row.value.state
        if (state !== "scheduled" && state !== "running" && state !== "failed") return false
        put(t, row, clean({ ...fieldsOf(row.value), state: "cancelled", finishedAt: now() }), actor)
        t.tx.afterCommit(wake)
        return true
      }).pipe(Effect.mapError(fromStore))

    // ---- Handlers

    const checkedHandler = (owner: string, name: string, handler: JobHandler<any, any>): Omit<Published, "runner" | "scope"> | string => {
      if (typeof name !== "string" || !HANDLER_NAME.test(name)) return `A job handler's name must match ${HANDLER_NAME}`
      if (typeof handler !== "object" || handler === null || typeof handler.run !== "function" || !Schema.isSchema(handler.payload)) {
        return `The job handler "${name}" needs a payload schema and a run function`
      }
      const retries = handler.retries ?? DEFAULT_RETRIES
      if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) return `The job handler "${name}": retries must be 0 to ${MAX_RETRIES}`
      const timeoutMs = handler.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS
      if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_HANDLER_TIMEOUT_MS) return `The job handler "${name}": timeoutMs must be 100 to ${MAX_HANDLER_TIMEOUT_MS}`
      let decode: Published["decode"]
      let payloadProblem: Published["payloadProblem"]
      try {
        const codec = Schema.toCodecJson(handler.payload)
        decode = Schema.decodeUnknownEffect(codec) as Published["decode"]
        const decodeNow = Schema.decodeUnknownExit(codec)
        // A decoding that fails at once is a refusal, and so is a decoder that throws (a defect): the payload cannot be
        // shown to fit. Only one that cannot be decided synchronously (a schema with asynchronous decoding) is left to
        // the run, which decodes it then.
        payloadProblem = (u) => {
          try {
            const exit = decodeNow(u)
            if (Exit.isSuccess(exit)) return undefined
            const failed = exit.cause.reasons.find(Cause.isFailReason)
            if (failed !== undefined) return messageOf(failed.error)
            const died = exit.cause.reasons.find(Cause.isDieReason)
            if (died === undefined || Cause.isAsyncFiberError(died.defect)) return undefined
            return `its payload schema's decoder failed (${messageOf(died.defect)})`
          } catch (error) {
            return `its payload schema's decoder failed (${messageOf(error)})`
          }
        }
      } catch (error) {
        return `The job handler "${name}": its payload schema has no JSON form (${messageOf(error)})`
      }
      return { owner, name, key: `${owner}/${name}`, idempotent: handler.idempotent === true, retries, timeoutMs, decode, payloadProblem, run: handler.run }
    }

    const forPart = (part: PartHandle, runner: PartRunner): ModuleScheduler => ({
      ...callsFor(part.moduleId, { kind: "module", moduleId: part.moduleId }),
      handle: (name, handler) =>
        Effect.suspend(() => {
          const checked = checkedHandler(part.moduleId, name, handler)
          if (typeof checked === "string") return Effect.fail(invalid(checked))
          const entry: Published = { ...checked, runner }
          const token = { name, part, payloadProblem: checked.payloadProblem }
          const mine = staged.get(part.moduleId) ?? new Set()
          staged.set(part.moduleId, mine)
          const unstage = () => {
            mine.delete(token)
            if (mine.size === 0 && staged.get(part.moduleId) === mine) staged.delete(part.moduleId)
          }
          // Its callbacks only touch the scheduler's own tables; `validate` reads the sibling handles' state (only the
          // parts of the start being published are `starting`).
          const registration: Registration = {
            kind: "job-handler",
            validate: () =>
              [...mine].filter((s) => s.name === name && s.part.state() === "starting").length > 1
                ? `Two job handlers of ${part.moduleName} are named "${name}"; a handler's name is unique within its module`
                : undefined,
            publish: () => {
              unstage()
              published.set(entry.key, entry)
              pendingRecovery.add(entry.key)
              wake()
            },
            withdraw: () => {
              if (published.get(entry.key) === entry) published.delete(entry.key)
            }
          }
          mine.add(token)
          const registered = part.register(registration)
          if (!registered.ok) {
            unstage()
            return Effect.fail(failedWith("state", registered.reason))
          }
          return Scope.addFinalizer(part.scope, Effect.sync(unstage))
        })
    })

    const forCore = (owner: CoreOwner): CoreScheduler => {
      if (!CORE_OWNER.test(owner) || owner === SCHEDULER_OWNER) throw new Error(`A core scheduler owner is core.<name> (not core.scheduler): "${owner}"`)
      return {
        ...callsFor(owner, { kind: "system", name: owner }),
        handle: (name, handler) =>
          Effect.gen(function*() {
            const checked = checkedHandler(owner, name, handler)
            if (typeof checked === "string") return yield* invalid(checked)
            if (published.has(checked.key)) return yield* failedWith("state", `${owner} has a job handler named "${name}" already`)
            // Its runs: in a scope of the engine's run scope (closing the engine interrupts them), which the
            // registration's scope closes too, after the handler is withdrawn (finalizers run last added first).
            const runs = yield* Scope.fork(runScope)
            yield* Effect.addFinalizer(() => Scope.close(runs, Exit.void))
            const entry: Published = { ...checked, scope: runs }
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                published.set(entry.key, entry)
                pendingRecovery.add(entry.key)
                wake()
              }),
              () => Effect.sync(() => void (published.get(entry.key) === entry && published.delete(entry.key)))
            )
          })
      }
    }

    // ---- Runs

    const classify = (entry: Published, exit: Exit.Exit<void, unknown>): Verdict => {
      if (Exit.isSuccess(exit)) return { _tag: "done" }
      const cause = exit.cause
      // Withdrawn (its module stopped, its core service closed) or the server shuts down: not the handler's failure.
      const withdrawn = closing || published.get(entry.key) !== entry
      const stopSignal = Cause.hasInterruptsOnly(cause) ||
        cause.reasons.some((r) => (Cause.isFailReason(r) && isModuleStopped(r.error)) || (Cause.isDieReason(r) && isModuleStopped(r.defect)))
      if (withdrawn && stopSignal) return { _tag: "stopped", why: closing ? "the server is stopping" : "its module stopped" }
      if (Cause.hasInterruptsOnly(cause)) return { _tag: "failed", message: "It was interrupted", retriable: true }
      const error = Cause.findErrorOption(cause)
      if (error._tag === "Some") {
        const e = error.value
        if (e instanceof RunRefused) return { _tag: "failed", message: errorText(entry.owner, `Not run: ${e.reason}`), retriable: false }
        if (e instanceof PayloadInvalid) return { _tag: "failed", message: errorText(entry.owner, `Its payload does not fit the handler: ${e.message}`), retriable: false }
        if (e instanceof RunTimeout) return { _tag: "failed", message: `It did not finish within ${Math.round(e.ms / 100) / 10} s`, retriable: true }
        return { _tag: "failed", message: errorText(entry.owner, textOf(e)), retriable: true }
      }
      return { _tag: "failed", message: errorText(entry.owner, `It crashed: ${textOf(Cause.squash(cause))}`), retriable: true }
    }

    /** What a claimed occurrence becomes. */
    const outcomeOf = (entry: Published, f: JobFields, verdict: Exclude<Verdict, { _tag: "stopped" }>, at: number): JobFields => {
      const occurrence = f.occurrenceAt ?? f.dueAt
      if (verdict._tag === "done") {
        return f.cron !== undefined ? movedOn(f, Math.max(at, occurrence), at, "done") : clean({ ...f, state: "done", finishedAt: at, occurrenceAt: undefined })
      }
      if (verdict.retriable && entry.idempotent && f.attempt <= entry.retries) {
        return clean({ ...f, state: "scheduled", dueAt: at + backoff(f.attempt), lastError: verdict.message })
      }
      return f.cron !== undefined
        ? movedOn(f, Math.max(at, occurrence), at, { failure: verdict.message })
        : clean({ ...f, state: "failed", finishedAt: at, failedAt: at, occurrenceAt: undefined, lastError: verdict.message })
    }

    /** Write a run's outcome with `expectRev` of its claim; tried again while the store is busy or failing, then left `running`. */
    const writeOutcome = (entry: Published, claimed: Row<StoredJob>, verdict: Exclude<Verdict, { _tag: "stopped" }>): Effect.Effect<void> =>
      Effect.gen(function*() {
        for (let attempt = 0;; attempt++) {
          const exit = yield* Effect.exit(tx((t) => {
            put(t, claimed, outcomeOf(entry, fieldsOf(claimed.value), verdict, now()), SYSTEM)
          }))
          if (Exit.isSuccess(exit)) return
          const error = Cause.findErrorOption(exit.cause)
          if (error._tag === "Some" && (error.value._tag === "StoreConflict" || error.value._tag === "StoreNotFound")) {
            log(`Scheduler: job ${claimed.id} was rescheduled or cancelled while it ran; that run's outcome is dropped`)
            return
          }
          const pause = outcomeRetryMs[attempt]
          if (pause === undefined || error._tag !== "Some") {
            log(`Scheduler: the outcome of job ${claimed.id} could not be saved (${messageOf(error._tag === "Some" ? error.value : Cause.squash(exit.cause))}); it stays running and the recovery rule decides`)
            return
          }
          yield* Effect.sleep(pause)
        }
      })

    const runJob = (entry: Published, claimed: Row<StoredJob>, due: DueInfo): Effect.Effect<void> =>
      Effect.gen(function*() {
        const f = claimed.value
        const job: JobOrigin = {
          jobId: claimed.id,
          moduleId: f.module,
          ...(f.origin.assistantId !== undefined ? { assistantId: f.origin.assistantId } : {}),
          ...(f.origin.deviceId !== undefined ? { deviceId: f.origin.deviceId } : {}),
          ...(f.origin.person !== undefined ? { person: f.origin.person } : {})
        }
        const body: Effect.Effect<void, unknown> = asPrincipal(
          { _tag: "job", job },
          Effect.gen(function*() {
            const gateway = options.gateway?.()
            if (gateway !== undefined) {
              const principal = yield* gateway.principal
              if ("refused" in principal) return yield* new RunRefused({ reason: principal.refused })
            }
            const payload = yield* entry.decode(f.payload).pipe(Effect.mapError((e) => new PayloadInvalid({ message: e.message })))
            yield* Effect.suspend(() => entry.run(payload, due))
          })
        ).pipe(Effect.timeoutOrElse({ duration: entry.timeoutMs, orElse: () => Effect.fail(new RunTimeout({ ms: entry.timeoutMs })) }))
        const exit = yield* Effect.exit(entry.runner !== undefined ? entry.runner.inFlight(() => body) : body)
        const verdict = classify(entry, exit)
        if (verdict._tag === "stopped") {
          log(`Scheduler: job ${claimed.id} (${entry.key}) was interrupted because ${verdict.why}; it stays running and the recovery rule decides when its handler is published again`)
          // Its module may have been published again before this run had ended: the rule applies at the next pass.
          if (!closing && published.has(entry.key)) pendingRecovery.add(entry.key)
          return
        }
        if (verdict._tag === "failed") log(`Scheduler: job ${claimed.id} (${entry.key}) failed: ${verdict.message}`)
        yield* writeOutcome(entry, claimed, verdict)
      })

    const startRun = (entry: Published, claimed: Row<StoredJob>, due: DueInfo) => {
      alive.add(claimed.rev)
      runCount++
      progress++
      const done = Effect.sync(() => {
        alive.delete(claimed.rev)
        runCount--
        progress++
        wake()
      })
      return Effect.forkIn(runJob(entry, claimed, due).pipe(Effect.ensuring(done), Effect.provideContext(engineContext)), entry.scope ?? runScope).pipe(
        Effect.onError(() => done),
        Effect.asVoid
      )
    }

    type Step =
      | { readonly _tag: "none" }
      | { readonly _tag: "later"; readonly at: number }
      | { readonly _tag: "missed" }
      | { readonly _tag: "claimed"; readonly row: Row<StoredJob>; readonly due: DueInfo }

    /** The handler's earliest job: claimed when it is due (or found missed), in one transaction. */
    const claimNext = (entry: Published): Effect.Effect<Step, StoreFailure> =>
      tx((t): Step => {
        const row = t.jobs.list({ where: { ready: entry.key }, orderBy: { field: "at" }, limit: 1 })[0]
        if (row === undefined) return { _tag: "none" }
        const at = now()
        if (row.value.at > at) return { _tag: "later", at: row.value.at }
        const f = fieldsOf(row.value)
        // The occurrence: a retry's own; a repeating job found late: the latest one at or before now.
        const occurrence = f.occurrenceAt ?? (f.cron !== undefined ? Math.max(f.dueAt, lastOccurrence(f, at) ?? f.dueAt) : f.dueAt)
        const lateMs = Math.max(0, at - occurrence)
        const late: LatePolicy = f.late
        if (typeof late === "object" && lateMs > late.withinMs) {
          put(t, row, f.cron !== undefined ? movedOn(clean({ ...f, occurrenceAt: undefined }), at, at, "missed") : clean({ ...f, state: "missed", finishedAt: at, occurrenceAt: undefined }), SYSTEM)
          return { _tag: "missed" }
        }
        const claimed = put(t, row, { ...f, state: "running", attempt: f.attempt + 1, occurrenceAt: occurrence, dueAt: occurrence }, SYSTEM)
        return { _tag: "claimed", row: claimed, due: { jobId: row.id, ...(f.key !== undefined ? { key: f.key } : {}), dueAt: occurrence, lateMs, attempt: f.attempt + 1 } }
      })

    // ---- The recovery rule

    /** Rows `running` with no run alive here, of `keys` (or of every published handler): retried or failed. */
    const recover = (keys: ReadonlySet<string> | undefined): Effect.Effect<number, StoreFailure> =>
      Effect.gen(function*() {
        let after: Row<StoredJob> | undefined
        let n = 0
        for (;;) {
          const page = yield* jobsOut.list({ where: { state: "running" }, orderBy: { field: "at" }, limit: MAX_JOB_PAGE, ...(after !== undefined ? { after } : {}) })
          for (const row of page) {
            const key = `${row.value.module}/${row.value.handler}`
            if (keys !== undefined && !keys.has(key)) continue
            const entry = published.get(key)
            if (entry === undefined || alive.has(row.rev)) continue
            const done = yield* Effect.exit(tx((t) => {
              const f = fieldsOf(row.value)
              const at = now()
              const why = "Its run ended without telling (the server or its module stopped while it ran, or its outcome could not be saved)"
              const next = entry.idempotent && f.attempt <= entry.retries
                ? clean({ ...f, state: "scheduled", dueAt: at, lastError: `${why}; it runs again` })
                : f.cron !== undefined
                ? movedOn(f, Math.max(at, f.occurrenceAt ?? f.dueAt), at, { failure: `${why}; it is not run again for that time` })
                : clean({ ...f, state: "failed", finishedAt: at, failedAt: at, occurrenceAt: undefined, lastError: `${why}; it is not run again (its handler is not idempotent)` })
              put(t, row, next, SYSTEM)
            }))
            if (Exit.isSuccess(done)) n++
          }
          if (page.length < MAX_JOB_PAGE) break
          after = page[page.length - 1]
          yield* Effect.yieldNow
        }
        if (n > 0) log(`Scheduler: ${n} job(s) left running without a run were recovered`)
        return n
      })

    // ---- Maintenance: retention, the recovery rule, the issues

    /** Remove finished rows older than `keepFinishedMs`, oldest first; the number removed. */
    const retention: Effect.Effect<number, StoreFailure> = Effect.gen(function*() {
      const cutoff = now() - keepFinishedMs
      let removed = 0
      while (removed < RETENTION_ROWS_PER_PASS) {
        const began = performance.now()
        const step = yield* tx((t) => {
          const page = t.jobs.list({ where: { list: "finished" }, orderBy: { field: "at" }, limit: RETENTION_STEP_ROWS })
          let n = 0
          for (const row of page) {
            if (row.value.at >= cutoff) break
            t.jobs.remove(row.id, { expectRev: row.rev, actor: SYSTEM })
            noteIssue(t, row.value.issue === true, false)
            n++
          }
          return { n, more: n === RETENTION_STEP_ROWS }
        })
        removed += step.n
        options.observe?.({ kind: "retention-step", ms: performance.now() - began, removed: step.n })
        if (!step.more) break
        yield* Effect.yieldNow
      }
      return removed
    })

    const moduleNames = () => new Map((options.modules?.() ?? []).map((m) => [m.id, m.name] as const))

    const issueOf = (row: Row<StoredJob>, names: ReadonlyMap<string, string>): Issue => {
      const v = row.value
      const name = names.get(v.module) ?? v.module
      const what = `${v.handler}${v.key !== undefined ? ` (${v.key})` : ""}`
      const reason = pageText(v.module, v.lastError ?? "", MAX_ERROR_CHARS)
      const live = isLive(v.state)
      return {
        id: `core.scheduler.failed.${row.id}`,
        ...(names.has(v.module) ? { module: v.module } : {}),
        severity: "warning",
        title: oneLine(live ? `The last run of a repeating job of ${name} failed: ${what}` : `A scheduled job of ${name} failed: ${what}`, 200),
        detail: oneLine(`${reason}${live ? " It runs again at its next time." : " It is not run again; cancel it on the Scheduled jobs page to dismiss this."}`, 1_900),
        fix: { kind: "link", label: "Open Scheduled jobs", value: "#settings/diagnostics/scheduled" }
      }
    }

    /**
     * The Health issues: the `MAX_JOB_ISSUES` newest failures (the issue index is ordered by failure time), and, only when
     * there are more, one issue that says so (without a number: `MAX_JOB_ISSUES + 1` rows by the index are enough to
     * know, and the Scheduled jobs page has them all). Read a page at a time, with a yield between pages. A read that
     * fails leaves the issues to be read again (`issuesDirty`) and fails: the loop's pass fails with it and is tried
     * again after the loop's back-off.
     */
    const refresh: Effect.Effect<void, StoreFailure> = Effect.suspend(() => {
      if (options.issues === undefined) return Effect.sync(() => void (issuesDirty = false))
      const issues = options.issues
      return Effect.gen(function*() {
        issuesDirty = false
        const rows: Array<Row<StoredJob>> = []
        let last: Row<StoredJob> | undefined
        while (rows.length <= MAX_JOB_ISSUES) {
          if (last !== undefined) yield* Effect.yieldNow
          const want = Math.min(MAX_JOB_PAGE, MAX_JOB_ISSUES + 1 - rows.length)
          const page = yield* jobsOut.list({ where: { issue: true }, orderBy: { field: "failedAt", direction: "desc" }, limit: want, ...(last !== undefined ? { after: last } : {}) })
          rows.push(...page)
          if (page.length < want) break
          last = page[page.length - 1]
        }
        const names = moduleNames()
        const list = rows.slice(0, MAX_JOB_ISSUES).map((r) => issueOf(r, names))
        if (rows.length > MAX_JOB_ISSUES) {
          list.push({
            id: "core.scheduler.failed.more",
            severity: "warning",
            title: "More scheduled jobs have failed than are listed here",
            detail: "The newest failures are listed here; see the Scheduled jobs page for the others.",
            fix: { kind: "link", label: "Open Scheduled jobs", value: "#settings/diagnostics/scheduled" }
          })
        }
        issues.set("scheduler", list)
      }).pipe(Effect.onError(() => Effect.sync(() => void (issuesDirty = true))))
    })
    const refreshIssues: Effect.Effect<void> = refresh.pipe(Effect.catch((e) => Effect.sync(() => log(`Scheduler: the Health issues were not refreshed: ${e.message}`))))

    /**
     * The recount of every module's live jobs: a counter that disagrees with the rows (left so by a module that caught
     * a store failure in the middle of `writeIn` and committed the rest) is set to what the rows say. A module's live
     * rows are read a page at a time in `createdAt` order (a job that becomes live meanwhile comes last); the counter is
     * written only if its rev is still the one read before counting, since every change of a module's live jobs writes
     * its counter. Paged, with a yield between pages.
     */
    const recount: Effect.Effect<number, StoreFailure> = Effect.gen(function*() {
      let repaired = 0
      let afterCounter: Row<typeof JobCount.Type> | undefined
      for (;;) {
        const counters = yield* countsOut.list({ orderBy: { field: "createdAt", direction: "asc" }, limit: COUNTER_PAGE, ...(afterCounter !== undefined ? { after: afterCounter } : {}) })
        for (const counter of counters) {
          let n = 0
          let after: Row<StoredJob> | undefined
          for (;;) {
            const page = yield* jobsOut.list({ where: { liveModule: counter.id }, orderBy: { field: "createdAt", direction: "asc" }, limit: MAX_JOB_PAGE, ...(after !== undefined ? { after } : {}) })
            n += page.length
            if (page.length < MAX_JOB_PAGE) break
            after = page[page.length - 1]
            yield* Effect.yieldNow
          }
          if (n === counter.value.live) continue
          const fixed = yield* tx((t) => {
            if (t.counts.get(counter.id)?.rev !== counter.rev) return false
            t.counts.update(counter.id, () => ({ live: n }), { expectRev: counter.rev, actor: SYSTEM })
            return true
          })
          if (fixed) {
            repaired++
            log(`Scheduler: the live-job count of ${counter.id} was ${counter.value.live}; its rows say ${n}, so it is ${n} now`)
          }
          yield* Effect.yieldNow
        }
        if (counters.length < COUNTER_PAGE) break
        afterCounter = counters[counters.length - 1]
      }
      return repaired
    })

    const maintain: Effect.Effect<void, StoreFailure> = Effect.gen(function*() {
      const removed = yield* retention
      yield* recover(undefined)
      yield* recount
      yield* refresh
      // A backlog of old rows drains a pass a second (each pass bounded).
      nextMaintenance = now() + (removed >= RETENTION_ROWS_PER_PASS ? 1_000 : maintenanceMs)
    })

    // ---- The loop

    /**
     * One pass, one round: the recovery rule for new handlers, maintenance when due, then the published handlers as they
     * are when the round starts, at most one due job each (claimed, or found missed), starting at the handler after the
     * one whose job it started last, until `maxRuns` run; then the Health issues when they changed. `again`: it moved a
     * job on, so the loop starts the next pass at once (a handler published, a job become due, maintenance and the
     * issues are all considered again before any handler gets a second job); else the loop sleeps until `next` or a wake.
     * Stopped by the cap with nothing moved, it waits for a wake too: a run that ends wakes it.
     */
    const pass: Effect.Effect<{ readonly next: number; readonly again: boolean }, StoreFailure> = Effect.gen(function*() {
      progress++
      if (pendingRecovery.size > 0) {
        const keys = new Set(pendingRecovery)
        pendingRecovery.clear()
        yield* recover(keys)
      }
      if (now() >= nextMaintenance) yield* maintain
      let next = nextMaintenance
      const began = performance.now()
      let claimed = 0
      let moved = 0
      const entries = [...published.values()]
      const first = entries.findIndex((e) => e.key === lastClaimed) + 1
      for (const entry of [...entries.slice(first), ...entries.slice(0, first)]) {
        if (runCount >= maxRuns) break
        if (published.get(entry.key) !== entry) continue
        const step = yield* claimNext(entry)
        if (step._tag === "later") next = Math.min(next, step.at)
        else if (step._tag === "missed") moved++
        else if (step._tag === "claimed") {
          claimed++
          lastClaimed = entry.key
          yield* startRun(entry, step.row, step.due)
        }
        yield* Effect.yieldNow
      }
      options.observe?.({ kind: "pass", ms: performance.now() - began, handlers: entries.length, claimed })
      if (issuesDirty) yield* refresh
      return { next, again: claimed + moved > 0 }
    })

    /** Sleep until `at`, woken early by `woken`, by a jump of the wall clock, and at least every `jumpCheckMs`. */
    const waitUntil = (at: number, woken: Deferred.Deferred<void>) =>
      Effect.gen(function*() {
        for (;;) {
          const w0 = now()
          if (w0 >= at) return
          const m0 = yield* monotonicMs
          const chunk = Math.max(1, Math.min(at - w0, jumpCheckMs))
          const how = yield* Effect.raceFirst(Effect.as(Deferred.await(woken), "woken" as const), Effect.as(Effect.sleep(chunk), "slept" as const))
          if (how === "woken") return
          const jump = (now() - w0) - ((yield* monotonicMs) - m0)
          if (Math.abs(jump) > JUMP_MS) {
            log(`Scheduler: the wall clock jumped ${jump > 0 ? "forward" : "back"} by ${Math.round(Math.abs(jump) / 1000)} s; checking the jobs again`)
            return
          }
        }
      })

    const loop: Effect.Effect<never> = Effect.gen(function*() {
      for (;;) {
        const woken = Deferred.makeUnsafe<void>()
        signal = woken
        const step = yield* Effect.exit(pass)
        if (Exit.isFailure(step)) {
          if (Cause.hasInterruptsOnly(step.cause)) return yield* Effect.interrupt
          log(`Scheduler: ${messageOf(Cause.squash(step.cause))}; trying again in 5 s`)
          waiting = true
          yield* Effect.raceFirst(Deferred.await(woken), Effect.sleep(5_000))
          waiting = false
          continue
        }
        if (step.value.again) {
          yield* Effect.yieldNow
          continue
        }
        waiting = true
        yield* waitUntil(step.value.next, woken)
        waiting = false
      }
    })
    yield* Effect.forkIn(loop, engineScope)

    // ---- The admin view

    const viewFor = (row: Row<StoredJob>, names: ReadonlyMap<string, string>): JobView => {
      const job = jobRowOf(row)
      const isCore = job.module.startsWith("core.")
      return {
        job: job.lastError === undefined ? job : { ...job, lastError: pageText(job.module, job.lastError, MAX_ERROR_CHARS) },
        moduleName: names.get(job.module) ?? job.module,
        orphaned: !isCore && options.modules !== undefined && !names.has(job.module)
      }
    }

    const remember = (phase: "live" | "finished", row: Row<StoredJob>) => {
      const token = `${phase}.${crypto.randomUUID().replace(/-/g, "")}`
      cursors.set(token, { phase, row })
      // The newest 256 cursors are kept: an older one asks the page to start again.
      if (cursors.size > 256) cursors.delete(cursors.keys().next().value!)
      return token
    }

    const listAll: SchedulerEngine["listAll"] = (o = {}) =>
      Effect.gen(function*() {
        const limit = o.limit ?? MAX_ADMIN_JOB_PAGE
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ADMIN_JOB_PAGE) return yield* invalid(`limit must be 1 to ${MAX_ADMIN_JOB_PAGE}`)
        let phase: "live" | "finished" = "live"
        let after: Row<StoredJob> | undefined
        if (o.cursor !== undefined && o.cursor !== "") {
          if (o.cursor === "finished") phase = "finished"
          else {
            const known = cursors.get(o.cursor)
            if (known === undefined) return yield* invalid("That page of the list is no longer known; start again from the top")
            phase = known.phase
            after = known.row
          }
        }
        const names = moduleNames()
        const out: Array<JobView> = []
        // Reads of at most one list each (`MAX_JOB_PAGE`), with a yield between them.
        for (let reads = 0;; reads++) {
          if (reads > 0) yield* Effect.yieldNow
          const want = Math.min(limit - out.length, MAX_JOB_PAGE)
          const rows = yield* jobsOut.list({
            where: { list: phase },
            orderBy: { field: "at", direction: phase === "live" ? "asc" : "desc" },
            limit: want,
            ...(after !== undefined ? { after } : {})
          }).pipe(Effect.mapError(fromStore))
          out.push(...rows.map((r) => viewFor(r, names)))
          if (rows.length === want) {
            if (out.length === limit) return { jobs: out, next: remember(phase, rows[rows.length - 1]!) }
            after = rows[rows.length - 1]
            continue
          }
          if (phase === "finished") return { jobs: out }
          phase = "finished"
          after = undefined
          if (out.length === limit) return { jobs: out, next: "finished" }
        }
      })

    const cancelAny: SchedulerEngine["cancelAny"] = (id) =>
      typeof id !== "string" || !SAFE_ID.test(id) ? Effect.succeed(false) : cancelWhere(undefined, { id }, ADMIN)

    // Quiet: the loop waits, nothing woke it, and nothing moved for 20 turns of the scheduler (a run that sleeps on the
    // clock does not move).
    const settled: Effect.Effect<void> = Effect.gen(function*() {
      let seen = -1
      let still = 0
      for (let i = 0; i < 20_000; i++) {
        yield* Effect.yieldNow
        if (waiting && !Deferred.isDoneUnsafe(signal) && progress === seen) {
          if (++still >= 20) return
        } else {
          still = 0
          seen = progress
        }
      }
    })

    return {
      forPart,
      forCore,
      listAll,
      cancelAny,
      wake,
      refreshIssues,
      maintainSoon: () => {
        nextMaintenance = 0
        wake()
      },
      runsInFlight: () => runCount,
      settled
    } satisfies SchedulerEngine
  })
