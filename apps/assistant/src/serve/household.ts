import {
  type AmbientMode,
  connectStoreToBus,
  type EventBus,
  type HouseholdFeed,
  type HouseholdStore,
  makeAmbientFacts,
  makeEventBus,
  makeHouseholdFeed,
  type ContextProvider,
  type ModuleDefinition,
  StoreError
} from "@pva/core"
import { householdDbPath, makeSqliteStore, type SqliteHouseholdStore } from "@pva/store-sqlite"
import { Effect, type Scope } from "effect"
import { existsSync } from "node:fs"

/**
 * The household store and the event bus in the app (docs/STORING-DATA.md): serve mode opens `data/household.db`
 * read-write (it holds the writer lock), the CLI modes read-only.
 */

export interface Household {
  readonly store: HouseholdStore
  readonly sqlite: SqliteHouseholdStore | undefined
  readonly bus: EventBus
  readonly feed: HouseholdFeed
  /** The per-turn ambient facts (`HOME_AMBIENT_FACTS`). */
  readonly ambient: (options: { readonly mode: () => AmbientMode; readonly moduleOn: (assistantId: string, moduleId: string) => boolean }) => ContextProvider
}

const declared = (catalog: ReadonlyArray<ModuleDefinition<any>>) => catalog.map((d) => ({ id: d.id, storage: d.storage }))

const assemble = (
  store: HouseholdStore,
  sqlite: SqliteHouseholdStore | undefined,
  catalog: ReadonlyArray<ModuleDefinition<any>>,
  log: (line: string) => void,
  people?: () => ReadonlyArray<string>
) =>
  Effect.gen(function*() {
    yield* store.prepare(declared(catalog))
    for (const d of catalog) {
      const verdict = store.availability(d.id)
      if (verdict !== undefined && d.storage !== undefined) log(`Module ${d.name}: ${verdict.reason}`)
    }
    const bus = makeEventBus({ log })
    const disconnect = connectStoreToBus(store, bus)
    yield* Effect.addFinalizer(() => Effect.sync(disconnect))
    const feed = makeHouseholdFeed({
      store,
      modules: catalog.map((d) => ({ moduleId: d.id, collections: d.storage?.collections ?? [], events: d.events ?? [] })),
      ...(people !== undefined ? { people } : {})
    })
    const ambientModules = catalog.flatMap((d) => {
      const collections = (d.storage?.collections ?? []).filter((c) => c.ambient !== undefined)
      return collections.length === 0 ? [] : [{ moduleId: d.id, collections }]
    })
    const household: Household = {
      store,
      sqlite,
      bus,
      feed,
      ambient: ({ mode, moduleOn }) =>
        makeAmbientFacts({ store, modules: ambientModules, mode, moduleOn, usable: (id) => store.availability(id) === undefined })
    }
    return household
  })

/** Serve mode: the one writer. A database from a newer assistant fails the start (the message says what to do). */
export const openServeHousehold = (options: {
  readonly dataDir: string
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  readonly backupCopyDir?: string | undefined
  readonly log: (line: string) => void
  /** P5: the household's person ids now, for the person-scoped rows of a page's snapshot. */
  readonly people?: () => ReadonlyArray<string>
}): Effect.Effect<Household, StoreError, Scope.Scope> =>
  Effect.gen(function*() {
    const sqlite = yield* makeSqliteStore({
      filename: householdDbPath(options.dataDir),
      ...(options.backupCopyDir !== undefined && options.backupCopyDir !== "" ? { backupCopyDir: options.backupCopyDir } : {}),
      log: options.log
    })
    return yield* assemble(sqlite, sqlite, options.catalog, options.log, options.people)
  })

/**
 * The CLI modes (`text`, `voice`, `bench`, …): the store read-only, beside a server that may be running; version 2
 * modules read their data and every write is refused (`read-only`, "changes are made by the server"). No file yet,
 * or one that cannot be opened here (a newer assistant's): an empty in-memory store, read-only too, with a warning.
 */
export const openCliHousehold = (options: {
  readonly dataDir: string
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  readonly log: (line: string) => void
}): Effect.Effect<Household, never, Scope.Scope> =>
  Effect.gen(function*() {
    const file = householdDbPath(options.dataDir)
    const onFile = existsSync(file)
      ? yield* Effect.result(makeSqliteStore({ filename: file, readOnly: true }))
      : undefined
    if (onFile?._tag === "Failure") options.log(`The household data is not available here: ${onFile.failure.message}`)
    const sqlite = onFile?._tag === "Success" ? onFile.success : yield* makeSqliteStore({ filename: ":memory:", readOnly: true })
    return yield* assemble(sqlite, sqlite, options.catalog, options.log)
  }).pipe(Effect.catchTag("StoreError", (e) => Effect.die(e)))

export { StoreError }
