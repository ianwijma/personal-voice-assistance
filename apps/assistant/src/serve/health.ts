import type { ModuleDefinition, ModuleHost } from "@pva/core"
import type { HealthInfo } from "@pva/protocol"
import { Deferred, Effect } from "effect"
import type { RequirementChecker } from "../requirements.ts"

/**
 * The Health page's service (module-definition-config-and-dependencies.md §C.5): the issue registry as admin pages
 * see it, and one check at a time ("Check again", and once at start): probe every program the modules need again,
 * re-judge which modules are available and try again every module that is down after a failed start (`recheck`),
 * then run every module's `health()`. Never on a turn. Checks of the machine itself (disk, TLS files, the port,
 * speech models) are not part of this version (docs/MODULES-PLAN.md §7).
 */
export interface HealthService {
  readonly info: () => HealthInfo
  /** Run a check; a check already running is joined, not repeated. Never fails. */
  readonly check: Effect.Effect<void>
  /**
   * Start a check in the background ("Check again") and return at once: `info()` says `checking` from this moment,
   * and the outcome reaches admin pages as `health`. A check can take longer than a page waits for an answer (a slow
   * probe, a module that now starts), so the request is answered when it has started, not when it ends.
   */
  readonly begin: () => void
  /** Called after every change of `info`. Returns an unsubscribe function. */
  readonly subscribe: (listener: (info: HealthInfo) => void) => () => void
}

export interface HealthServiceOptions {
  readonly host: ModuleHost
  readonly checker: RequirementChecker
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  readonly now?: () => number
  /** Runs a background effect (serve mode's request runner); `begin` uses it. */
  readonly fork: (effect: Effect.Effect<void>) => void
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
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("The health check failed", cause)))

  /** Mark a check as running (synchronously), and the work that ends it. */
  const open = (): Effect.Effect<void> => {
    const done = Deferred.makeUnsafe<void>()
    checking = done
    changed()
    return run.pipe(Effect.ensuring(Effect.sync(() => {
      checking = undefined
      checkedAt = now()
      changed()
      Deferred.doneUnsafe(done, Effect.void)
    })))
  }

  const check = Effect.suspend(() => (checking !== undefined ? Deferred.await(checking) : open()))

  const begin = () => {
    if (checking !== undefined) return
    options.fork(open())
  }

  return {
    info,
    check,
    begin,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
