import { Deferred, Effect, type Exit, type Fiber, type Scope } from "effect"
import type { Issue } from "./ModuleApi.ts"

/**
 * Slots (docs/UI-AND-MODULES.md §1.7, §1.11): module code that a caller waits for but that may outlive the wait (a
 * route handler, a field action's press) runs in a **slot** of its module. `run` is the one way to start such code:
 *
 * - it takes a slot of the module, starts the code in a fiber of its own and installs an observer on that fiber, all
 *   in one synchronous step; the observer gives the slot back when the fiber has really ended (its interruption and
 *   finalizers included), exactly once, whatever ended the wait for it. A fiber can never be counted twice or not at
 *   all;
 * - at the module's cap (`cap` slots taken) nothing starts: the answer is `full`, the module is reported (`report`,
 *   for a Health issue) until one of its slots is free again;
 * - the answer is the first of: the code's result (`done`), its deadline (`timeout`), the stop signal (`stopped`),
 *   the caller being interrupted (no answer). In the last three the fiber is interrupted and **not** waited for; its
 *   slot stays taken until it ends. Nothing here waits for cleanup.
 *
 * Code that never ends keeps its slot until the process stops (docs/MODULES-PLAN.md §3.5): there is no abandonment.
 */
export type SlotOutcome<A, E> =
  | { readonly _tag: "full" }
  | { readonly _tag: "done"; readonly exit: Exit.Exit<A, E> }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "stopped" }

export interface SlotRunOptions<A, E> {
  /** When the answer is due at the latest (`timeout`). */
  readonly timeoutMs: number
  /** Completes when the caller must be answered `stopped` (the host's stop signal after the grace period). */
  readonly stopped?: Effect.Effect<void>
  /** Start the fiber in this scope (`Effect.forkIn`; it is interrupted when the scope closes). Default: detached. */
  readonly scope?: Scope.Scope
  /**
   * Called synchronously with the fiber right after it is started, before anything can end it and before the slot's
   * own observer is installed (observers it adds run before the slot is given back and the answer is decided).
   */
  readonly started?: (fiber: Fiber.Fiber<A, E>) => void
}

export interface ModuleSlots {
  /** Run `work` of module `moduleId` in a slot (see above). */
  readonly run: <A, E>(moduleId: string, work: Effect.Effect<A, E>, options: SlotRunOptions<A, E>) => Effect.Effect<SlotOutcome<A, E>>
  /** The slots of the module taken now. */
  readonly taken: (moduleId: string) => number
}

/** Route handlers of one module that may run at once (`ModuleSlots`); at the cap a request is answered 503. */
export const MAX_ROUTE_SLOTS = 16
/** "Test" presses (field actions) of one module that may run at once, across all its owners; at the cap: `busy`. */
export const MAX_PRESS_SLOTS = 4

export const makeModuleSlots = (options: {
  readonly cap: number
  /** The module refused work at its cap (`full: true`), or has a free slot again after it did (`full: false`). */
  readonly report?: (moduleId: string, full: boolean) => void
}): ModuleSlots => {
  const counts = new Map<string, number>()
  /** Modules that refused something at their cap and have had no free slot since. */
  const refused = new Set<string>()

  const giveBack = (moduleId: string) => {
    const n = (counts.get(moduleId) ?? 1) - 1
    if (n <= 0) counts.delete(moduleId)
    else counts.set(moduleId, n)
    if (refused.delete(moduleId)) options.report?.(moduleId, false)
  }

  const run: ModuleSlots["run"] = <A, E>(moduleId: string, work: Effect.Effect<A, E>, o: SlotRunOptions<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend((): Effect.Effect<SlotOutcome<A, E>> => {
        const n = counts.get(moduleId) ?? 0
        if (n >= options.cap) {
          if (!refused.has(moduleId)) {
            refused.add(moduleId)
            options.report?.(moduleId, true)
          }
          return Effect.succeed({ _tag: "full" })
        }
        counts.set(moduleId, n + 1)
        const decided = Deferred.makeUnsafe<SlotOutcome<A, E>>()
        // Uninterruptible from here to the observer: the slot is taken, the fiber started and observed in one step.
        return (o.scope !== undefined ? Effect.forkIn(work, o.scope) : Effect.forkDetach(work)).pipe(
          Effect.onError(() => Effect.sync(() => giveBack(moduleId))),
          Effect.flatMap((fiber) => {
            // The caller's own observers first: what it frees at the fiber's end (a busy key) is free before the
            // answer resumes anyone.
            o.started?.(fiber)
            let given = false
            fiber.addObserver((exit) => {
              if (given) return
              given = true
              giveBack(moduleId)
              Deferred.doneUnsafe(decided, Effect.succeed({ _tag: "done", exit }))
            })
            const settle = (outcome: SlotOutcome<A, E>) => Effect.sync(() => void Deferred.doneUnsafe(decided, Effect.succeed(outcome)))
            return Effect.gen(function*() {
              // Watchers of the deadline and of the stop signal: each only completes the answer; neither waits for the fiber.
              const deadline = yield* Effect.forkDetach(Effect.andThen(Effect.sleep(o.timeoutMs), settle({ _tag: "timeout" })))
              // Started at once: the stop signal is read as the work starts (a part already withdrawn answers `stopped`).
              const stop = o.stopped === undefined ? undefined : yield* Effect.forkDetach(Effect.andThen(o.stopped, settle({ _tag: "stopped" })), { startImmediately: true })
              const outcome = yield* restore(Deferred.await(decided)).pipe(
                // The caller went away: the work is asked to stop, not waited for.
                Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe())),
                Effect.ensuring(Effect.sync(() => {
                  deadline.interruptUnsafe()
                  stop?.interruptUnsafe()
                }))
              )
              if (outcome._tag !== "done") fiber.interruptUnsafe()
              return outcome
            })
          })
        )
      })
    )

  return { run, taken: (moduleId) => counts.get(moduleId) ?? 0 }
}

/** The Health issue of a module whose slots of `kind` were all taken when it refused work: id `<module>.<kind>-busy`. */
export const slotIssues = (moduleId: string, name: string, kind: "presses" | "routes", cap: number): ReadonlyArray<Issue> => [{
  id: `${moduleId}.${kind}-busy`,
  module: moduleId,
  severity: "warning",
  title: kind === "presses" ? `${name}: too many button presses at once` : `${name}: too many web requests at once`,
  detail: kind === "presses"
    ? `${cap} presses of its buttons are still running (some may be cleaning up after they were stopped), so a further press was refused. This clears when one ends; restarting the assistant ends them.`
    : `${cap} of its web requests are still running (some may be cleaning up after they were answered), so further requests are answered 503. This clears when one ends; restarting the assistant ends them.`
}]

