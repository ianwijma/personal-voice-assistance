import type { Issue, ModuleDefinition, ModuleHost } from "@pva/core"
import type { HealthInfo } from "@pva/protocol"
import { Deferred, Effect } from "effect"
import type { RequirementChecker } from "../requirements.ts"

/**
 * The Health page's service (module-definition-config-and-dependencies.md §C.5): the issue registry as admin pages
 * see it, and one check at a time ("Check again", and once at start): probe every program the modules need again,
 * re-judge which modules are available (the host starts those that now are), run every module's `health()`, and the
 * core checks. Never on a turn.
 */
export interface HealthService {
  readonly info: () => HealthInfo
  /** Run a check; a check already running is joined, not repeated. Never fails. */
  readonly check: Effect.Effect<void>
  /** Called after every change of `info`. Returns an unsubscribe function. */
  readonly subscribe: (listener: (info: HealthInfo) => void) => () => void
}

export interface HealthServiceOptions {
  readonly host: ModuleHost
  readonly checker: RequirementChecker
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  /** The core checks (serve mode: without the port). */
  readonly core: Effect.Effect<ReadonlyArray<Issue>>
  readonly now?: () => number
}

export const makeHealthService = (options: HealthServiceOptions): HealthService => {
  const listeners = new Set<(info: HealthInfo) => void>()
  let checking: Deferred.Deferred<void> | undefined
  let checkedAt: number | undefined
  let cached: HealthInfo | undefined
  const now = options.now ?? Date.now

  const info = (): HealthInfo => {
    cached ??= { issues: [...options.host.issues.all()], checking: checking !== undefined, ...(checkedAt !== undefined ? { checkedAt } : {}) }
    return cached
  }
  // Coalesced: the registry changes several times during one check; admin pages get one message per tick.
  let scheduled = false
  const changed = () => {
    cached = undefined
    if (scheduled || listeners.size === 0) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      const current = info()
      for (const listener of listeners) {
        try {
          listener(current)
        } catch {
          // A listener must not break the service.
        }
      }
    })
  }
  options.host.issues.subscribe(changed)

  const run = Effect.gen(function*() {
    yield* options.checker.probeCatalog(options.catalog, { force: true })
    yield* options.host.recheck
    yield* options.host.checkHealth
    const core = yield* options.core
    options.host.issues.set("core", core)
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("The health check failed", cause)))

  const check = Effect.suspend(() => {
    if (checking !== undefined) return Deferred.await(checking)
    return Effect.gen(function*() {
      const done = yield* Deferred.make<void>()
      checking = done
      changed()
      yield* run.pipe(Effect.ensuring(Effect.sync(() => {
        checking = undefined
        checkedAt = now()
        changed()
        Deferred.doneUnsafe(done, Effect.void)
      })))
    })
  })

  return {
    info,
    check,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
