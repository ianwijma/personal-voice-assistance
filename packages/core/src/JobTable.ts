import { Effect } from "effect"
import type { CoreSql, HouseholdStore, StoreError } from "./HouseholdStore.ts"
import type { JobKind, JobRow, JobState } from "./Scheduler.ts"

/**
 * Where the scheduler keeps its jobs: one row per job, compare-and-set on `rev`, joined to the household store's
 * transactions. `sqlJobTable` is the real one (`core_scheduler__jobs`, through `store.core("scheduler")`);
 * `memoryJobTable` is the test double's, on the in-memory household store. Both are driven by the same engine
 * (`SchedulerEngine.ts`), so the semantics are the same by construction and the contract tests check both.
 *
 * Every call is one indexed statement: a schedule from a tool is at most two single-row writes.
 */
export interface JobTable {
  /** Bring the table to this version (serve mode, at start). */
  readonly migrate: Effect.Effect<void, StoreError>
  /** The household store's transaction (a module's `ctx.store.transaction` joins the same one). */
  readonly transaction: <X, E, R>(work: Effect.Effect<X, E, R>) => Effect.Effect<X, E | StoreError, R>
  readonly get: (id: string) => Effect.Effect<JobRow | undefined, StoreError>
  /** The live (`scheduled`, `paused`, `running`) job of a module with this key. */
  readonly liveByKey: (module: string, key: string) => Effect.Effect<JobRow | undefined, StoreError>
  readonly insert: (row: JobRow) => Effect.Effect<void, StoreError>
  /** Replace the row whose rev is `row.rev - 1`. False: it moved on (or is gone). */
  readonly replace: (row: JobRow) => Effect.Effect<boolean, StoreError>
  /** Jobs by module and state, live first by due time, newest finished after them. */
  readonly query: (q: {
    readonly module?: string
    readonly states?: ReadonlyArray<JobState>
    readonly kind?: JobKind
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<JobRow>, StoreError>
  /** `scheduled`, not waiting, not a task, due at or before `now`; earliest first (then by id). */
  readonly due: (now: number, limit: number) => Effect.Effect<ReadonlyArray<JobRow>, StoreError>
  /** The earliest due time of the jobs `due` would return later. */
  readonly nextDueAt: Effect.Effect<number | undefined, StoreError>
  /** Delete finished jobs (`done`, `cancelled`, `missed`, `failed`) last changed before `before`. */
  readonly prune: (before: number) => Effect.Effect<number, StoreError>
}

const FINISHED: ReadonlyArray<JobState> = ["done", "cancelled", "missed", "failed"]
const LIVE = "('scheduled', 'paused', 'running')"

/** The table's migrations (`CoreSql.migrate`). */
export const JOB_MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE core_scheduler__jobs (
    id TEXT PRIMARY KEY,
    module TEXT NOT NULL,
    kind TEXT NOT NULL,
    job_key TEXT,
    state TEXT NOT NULL,
    due_at INTEGER,
    waiting INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX core_scheduler__jobs_key ON core_scheduler__jobs (module, job_key)
    WHERE job_key IS NOT NULL AND state IN ${LIVE};
  CREATE INDEX core_scheduler__jobs_due ON core_scheduler__jobs (due_at)
    WHERE state = 'scheduled' AND waiting = 0 AND kind IS NOT 'task';
  CREATE INDEX core_scheduler__jobs_module ON core_scheduler__jobs (module, state, updated_at)`
]

const TABLE = "core_scheduler__jobs"

const columns = (r: JobRow) => [r.id, r.module, r.kind, r.key ?? null, r.state, r.dueAt ?? null, r.waiting ? 1 : 0, r.rev, r.updatedAt, JSON.stringify(r)] as const

const decode = (rows: ReadonlyArray<{ readonly data: string }>): ReadonlyArray<JobRow> => rows.map((r) => JSON.parse(r.data) as JobRow)

/** The real table, in the household database. */
export const sqlJobTable = (store: HouseholdStore, sql: CoreSql = store.core("scheduler")): JobTable => ({
  migrate: sql.migrate(JOB_MIGRATIONS),
  transaction: store.transaction,
  get: (id) => Effect.map(sql.query<{ data: string }>(`SELECT data FROM ${TABLE} WHERE id = ?`, [id]), (r) => decode(r)[0]),
  liveByKey: (module, key) =>
    Effect.map(sql.query<{ data: string }>(`SELECT data FROM ${TABLE} WHERE module = ? AND job_key = ? AND state IN ${LIVE}`, [module, key]), (r) => decode(r)[0]),
  insert: (row) =>
    Effect.asVoid(sql.run(
      `INSERT INTO ${TABLE} (id, module, kind, job_key, state, due_at, waiting, rev, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...columns(row)]
    )),
  replace: (row) => {
    const [id, module, kind, key, state, dueAt, waiting, rev, updatedAt, data] = columns(row)
    return Effect.map(
      sql.run(
        `UPDATE ${TABLE} SET module = ?, kind = ?, job_key = ?, state = ?, due_at = ?, waiting = ?, rev = ?, updated_at = ?, data = ? WHERE id = ? AND rev = ?`,
        [module, kind, key, state, dueAt, waiting, rev, updatedAt, data, id, rev - 1]
      ),
      (r) => r.changes === 1
    )
  },
  query: (q) => {
    const where: Array<string> = []
    const params: Array<string | number> = []
    if (q.module !== undefined) {
      where.push("module = ?")
      params.push(q.module)
    }
    if (q.states !== undefined) {
      where.push(`state IN (${q.states.map(() => "?").join(", ")})`)
      params.push(...q.states)
    }
    if (q.kind !== undefined) {
      where.push("kind = ?")
      params.push(q.kind)
    }
    params.push(q.limit)
    return Effect.map(
      sql.query<{ data: string }>(
        `SELECT data FROM ${TABLE} ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY (state IN ${LIVE}) DESC, CASE WHEN state IN ${LIVE} THEN coalesce(due_at, 9e15) ELSE -updated_at END, id LIMIT ?`,
        params
      ),
      decode
    )
  },
  due: (now, limit) =>
    Effect.map(
      sql.query<{ data: string }>(
        `SELECT data FROM ${TABLE} WHERE state = 'scheduled' AND waiting = 0 AND kind IS NOT 'task' AND due_at <= ? ORDER BY due_at, id LIMIT ?`,
        [now, limit]
      ),
      decode
    ),
  nextDueAt: Effect.map(
    sql.query<{ due_at: number }>(`SELECT due_at FROM ${TABLE} WHERE state = 'scheduled' AND waiting = 0 AND kind IS NOT 'task' ORDER BY due_at LIMIT 1`),
    (r) => (r[0] === undefined ? undefined : Number(r[0].due_at))
  ),
  prune: (before) =>
    Effect.map(
      sql.run(`DELETE FROM ${TABLE} WHERE id IN (SELECT id FROM ${TABLE} WHERE state IN ('done', 'cancelled', 'missed', 'failed') AND updated_at < ? LIMIT 500)`, [before]),
      (r) => r.changes
    )
})

const isLive = (s: JobState) => s === "scheduled" || s === "paused" || s === "running"

/**
 * The test double's table: a map on the in-memory household store, joined to its transactions (a write rolled back
 * with the module's is undone with it). Every call runs inside the store's lock, as SQLite's one connection would.
 */
export const memoryJobTable = (store: HouseholdStore & { readonly onRollback: (undo: () => void) => Effect.Effect<void> }): JobTable => {
  const rows = new Map<string, JobRow>()
  const inTx = <A>(f: () => A): Effect.Effect<A, StoreError> => store.transaction(Effect.sync(f))
  const write = (row: JobRow) =>
    store.transaction(Effect.suspend(() => {
      const before = rows.get(row.id)
      rows.set(row.id, row)
      return store.onRollback(() => {
        if (before === undefined) rows.delete(row.id)
        else rows.set(row.id, before)
      })
    }))
  const sortLiveFirst = (a: JobRow, b: JobRow) => {
    const la = isLive(a.state)
    const lb = isLive(b.state)
    if (la !== lb) return la ? -1 : 1
    const ka = la ? (a.dueAt ?? 9e15) : -a.updatedAt
    const kb = lb ? (b.dueAt ?? 9e15) : -b.updatedAt
    return ka - kb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  }
  const dueRows = () =>
    [...rows.values()]
      .filter((r) => r.state === "scheduled" && !r.waiting && r.kind !== "task" && r.dueAt !== undefined)
      .sort((a, b) => a.dueAt! - b.dueAt! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    migrate: Effect.void,
    transaction: store.transaction,
    get: (id) => inTx(() => rows.get(id)),
    liveByKey: (module, key) => inTx(() => [...rows.values()].find((r) => r.module === module && r.key === key && isLive(r.state))),
    insert: (row) =>
      Effect.flatMap(inTx(() => rows.has(row.id)), (taken) => (taken ? Effect.die(new Error(`Job ${row.id} exists`)) : write(row))),
    replace: (row) =>
      store.transaction(Effect.suspend(() => (rows.get(row.id)?.rev === row.rev - 1 ? Effect.as(write(row), true) : Effect.succeed(false)))),
    query: (q) =>
      inTx(() =>
        [...rows.values()]
          .filter((r) => (q.module === undefined || r.module === q.module) && (q.states === undefined || q.states.includes(r.state)) && (q.kind === undefined || r.kind === q.kind))
          .sort(sortLiveFirst)
          .slice(0, q.limit)
      ),
    due: (now, limit) => inTx(() => dueRows().filter((r) => r.dueAt! <= now).slice(0, limit)),
    nextDueAt: inTx(() => dueRows()[0]?.dueAt),
    prune: (before) =>
      inTx(() => {
        let n = 0
        for (const [id, r] of rows) {
          if (FINISHED.includes(r.state) && r.updatedAt < before) {
            rows.delete(id)
            n++
          }
        }
        return n
      })
  }
}
