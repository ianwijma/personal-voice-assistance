import {
  type ExecutionGateway,
  type HouseholdStore,
  type Issue,
  type IssueRegistry,
  type JobView,
  jobs,
  makeSchedulerEngine,
  MAX_JOB_PAGE,
  type ModuleDefinition,
  oneLine,
  type Row,
  SCHEDULER_OWNER,
  type SchedulerEngine,
  schedulerStorage,
  type StoredJob
} from "@pva/core"
import type { ScheduledJob } from "@pva/protocol"
import { householdDbPath, makeSqliteStore } from "@pva/store-sqlite"
import { Effect, type Scope } from "effect"
import { existsSync } from "node:fs"

/**
 * The scheduler in the app (docs/SCHEDULING.md): serve mode runs the engine on the household store it writes, and the
 * module host gives every version 2 module its `ctx.scheduler` from it (`ModuleHostOptions.scheduler`). The CLI modes
 * have none (their store is read-only: `ctx.scheduler` fails `unavailable` there). `doctor` reads the failed jobs
 * read-only.
 */

/**
 * Serve mode: the engine on the household store (prepared with `schedulerStorage`), its issues in `issues` (the
 * registry the module host is then given). The gateway and the page boundary are the module host's, made after it.
 */
export const openServeScheduler = (options: {
  readonly store: HouseholdStore
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  readonly issues: IssueRegistry
  /** `HOME_TIME_ZONE`. */
  readonly timeZone: () => string | undefined
  readonly gateway: () => ExecutionGateway | undefined
  readonly pageText: (moduleId: string, text: unknown, max: number) => string
  readonly log: (line: string) => void
}): Effect.Effect<SchedulerEngine, never, Scope.Scope> => {
  const names = options.catalog.map((d) => ({ id: d.id, name: d.name }))
  return makeSchedulerEngine({
    store: options.store,
    issues: options.issues,
    timeZone: options.timeZone,
    modules: () => names,
    gateway: options.gateway,
    pageText: options.pageText,
    log: options.log
  })
}

/** One job as the admin page sees it (`GET /api/scheduler/jobs`). No payload. */
export const scheduledJobOnWire = (view: JobView): ScheduledJob => {
  const j = view.job
  return {
    id: j.id,
    module: j.module,
    moduleName: oneLine(view.moduleName, 200),
    handler: j.handler,
    ...(j.key !== undefined ? { key: j.key } : {}),
    state: j.state,
    dueAt: j.dueAt,
    ...(j.cron !== undefined ? { cron: j.cron } : {}),
    ...(j.timeZone !== undefined ? { timeZone: j.timeZone } : {}),
    late: j.late,
    origin: {
      ...(j.origin.assistantId !== undefined ? { assistantId: j.origin.assistantId } : {}),
      ...(j.origin.deviceId !== undefined ? { deviceId: j.origin.deviceId } : {}),
      ...(j.origin.person !== undefined ? { personId: j.origin.person.id } : {})
    },
    attempt: j.attempt,
    ...(j.lastError !== undefined ? { lastError: j.lastError } : {}),
    ...(j.failedAt !== undefined ? { failedAt: j.failedAt } : {}),
    ...(j.finishedAt !== undefined ? { finishedAt: j.finishedAt } : {}),
    orphaned: view.orphaned,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt
  }
}

/** The failed jobs `doctor` lists at most (newest failures first); one more line says when there are more. */
const DOCTOR_JOBS = 2 * MAX_JOB_PAGE

/**
 * `pnpm start doctor`: the failed jobs (read-only from the database; the engine runs only in the server), the newest
 * failures first, at most `DOCTOR_JOBS` (read a page at a time), one line each. Their texts passed the page boundary
 * when they were stored. No database, or no scheduler data yet: nothing.
 */
export const schedulerDoctorIssues = (dataDir: string, catalog: ReadonlyArray<ModuleDefinition<any>>): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.scoped(Effect.gen(function*() {
    const file = householdDbPath(dataDir)
    if (!existsSync(file)) return []
    const store = yield* makeSqliteStore({ filename: file, readOnly: true })
    yield* store.prepare(catalog.map((d) => ({ id: d.id, storage: d.storage })), [schedulerStorage])
    const c = store.forCore(SCHEDULER_OWNER).collection(jobs)
    const read: Array<Row<StoredJob>> = []
    let after: Row<StoredJob> | undefined
    for (;;) {
      const page = yield* c.list({ where: { issue: true }, orderBy: { field: "failedAt", direction: "desc" }, limit: MAX_JOB_PAGE, ...(after !== undefined ? { after } : {}) })
      read.push(...page)
      if (page.length < MAX_JOB_PAGE || read.length > DOCTOR_JOBS) break
      after = page[page.length - 1]
    }
    const names = new Map(catalog.map((d) => [d.id, d.name] as const))
    const out: Array<Issue> = read.slice(0, DOCTOR_JOBS).map((row) => ({
      id: `core.scheduler.failed.${row.id}`,
      severity: "warning" as const,
      title: `A scheduled job of ${names.get(row.value.module) ?? row.value.module} failed: ${row.value.handler}${row.value.key !== undefined ? ` (${row.value.key})` : ""}`.slice(0, 200),
      detail: (row.value.lastError ?? "").replace(/\s+/g, " ").slice(0, 300)
    }))
    if (read.length > DOCTOR_JOBS) out.push({ id: "core.scheduler.failed.more", severity: "warning", title: `More than ${DOCTOR_JOBS} scheduled jobs failed`, detail: "The Scheduled jobs page has them all." })
    return out
  })).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<Issue>))
