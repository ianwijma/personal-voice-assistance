import {
  describeCounts,
  type HouseholdStore,
  type Issue,
  type IssueRegistry,
  type JobRow,
  type JobView,
  LIVE_STATES,
  logDelivery,
  makeIssueRegistry,
  makeSchedulerEngine,
  type ModuleDefinition,
  type SchedulerEngine,
  schedulerIssues,
  sqlJobTable,
  type StoreError
} from "@pva/core"
import type { ScheduledJob } from "@pva/protocol"
import { householdDbPath, makeSqliteStore } from "@pva/store-sqlite"
import { Effect, type Scope } from "effect"
import { existsSync } from "node:fs"

/**
 * The scheduler in the app (docs/SCHEDULING.md): serve mode runs the engine on the household store it writes; the CLI
 * modes have none (their store is read-only, and `ctx.scheduler` fails `unavailable` there). `doctor` reads the job
 * table read-only.
 */

const catalogNames = (catalog: ReadonlyArray<ModuleDefinition<any>>) => {
  const list = catalog.map((d) => ({ id: d.id, name: d.name }))
  return () => list
}

/**
 * Serve mode: the engine on the household store, delivery by log until P9 (`scheduler.setDelivery`), and the issue
 * registry its issues go to, which the module host is then given (`ModuleHostOptions.issues`).
 */
export const openServeScheduler = (options: {
  readonly store: HouseholdStore
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  /** `HOME_TIME_ZONE`. */
  readonly timeZone: () => string | undefined
  readonly log: (line: string) => void
}): Effect.Effect<{ readonly scheduler: SchedulerEngine; readonly issues: IssueRegistry }, StoreError, Scope.Scope> =>
  Effect.gen(function*() {
    const issues = makeIssueRegistry()
    const scheduler = yield* makeSchedulerEngine({
      table: sqlJobTable(options.store),
      delivery: logDelivery(options.log),
      issues,
      timeZone: options.timeZone,
      modules: catalogNames(options.catalog),
      log: options.log
    })
    return { scheduler, issues }
  })

/** One job as the admin page sees it (`GET /api/scheduler/jobs`). */
export const scheduledJobOnWire = (view: JobView): ScheduledJob => {
  const j = view.job
  const onDue = j.onDue
  return {
    id: j.id,
    module: j.module,
    moduleName: view.moduleName,
    kind: j.kind,
    ...(j.key !== undefined ? { key: j.key } : {}),
    ...(j.label !== undefined ? { label: j.label } : {}),
    state: j.state,
    ...(j.dueAt !== undefined ? { dueAt: j.dueAt } : {}),
    ...(j.remainingMs !== undefined ? { remainingMs: j.remainingMs } : {}),
    ...(j.cron !== undefined ? { cron: j.cron } : {}),
    ...(j.timeZone !== undefined ? { timeZone: j.timeZone } : {}),
    action: onDue === undefined ? "task" : "notify" in onDue ? "notify" : "handler",
    ...(onDue !== undefined && "handler" in onDue ? { handler: onDue.handler } : {}),
    scope: j.scope,
    origin: j.origin,
    waiting: j.waiting,
    orphaned: view.orphaned,
    ...(j.lastRunAt !== undefined ? { lastRunAt: j.lastRunAt } : {}),
    ...(j.lastError !== undefined ? { lastError: j.lastError } : {}),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt
  }
}

/**
 * `pnpm start doctor`: the scheduler's issues read from the database (read-only; the engine does not run), and one
 * line with the counts. No database, or no job table yet: nothing.
 */
export const schedulerDoctorIssues = (dataDir: string, catalog: ReadonlyArray<ModuleDefinition<any>>): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.scoped(Effect.gen(function*() {
    const file = householdDbPath(dataDir)
    if (!existsSync(file)) return []
    const store = yield* makeSqliteStore({ filename: file, readOnly: true })
    const table = sqlJobTable(store)
    const live = yield* table.query({ states: LIVE_STATES, limit: 10_000 })
    const failed = yield* table.query({ states: ["failed"], limit: 10_000 })
    const names = catalogNames(catalog)
    const moduleName = (id: string) => names().find((m) => m.id === id)?.name ?? id
    const isOrphan = (id: string) => !names().some((m) => m.id === id)
    const failing = (j: JobRow) => j.lastFailedAt !== undefined
    const counts = {
      live: live.length,
      failed: failed.length + live.filter(failing).length,
      waiting: live.filter((j) => j.waiting).length,
      orphaned: live.filter((j) => isOrphan(j.module)).length,
      // The engine does not run here: a task row in `running` is one the server runs now (or ran when it stopped).
      tasksRunning: live.filter((j) => j.kind === "task" && j.state === "running").length
    }
    const summary: Issue = { id: "core.scheduler.count", severity: "info", title: `Scheduled jobs: ${describeCounts(counts)}`, detail: "" }
    return [summary, ...schedulerIssues({ live, failed: failed.slice(0, 50), moduleName, isOrphan })]
  })).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<Issue>))
