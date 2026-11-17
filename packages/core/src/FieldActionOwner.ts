import { Deferred, Effect, type Exit, Fiber } from "effect"
import type { ModuleSlots } from "./ModuleSlots.ts"

/**
 * Who a field action's press belongs to (docs/UI-AND-MODULES.md §1.7): the host for a definition's handler, the
 * running instance for an instance's handler or a generated Test button. One owner ties together the press's
 * lifetime, its button's busy state and its cleanup:
 *
 * - `start` runs a press in a slot of its module (`ModuleSlots.run`, shared by every owner of the host, so at most
 *   `MAX_PRESS_SLOTS` presses of a module run at once whatever restarts happen), at most one per key: the key is busy
 *   from the start of the press until its fiber has really ended, whatever its deadline or its cleanup take. Only
 *   the press's own end frees its key, so an old press can never free a newer one's. The answer never waits for the
 *   press's cleanup: it is the first of its result, its deadline, the owner being stopped, the caller going away.
 * - `inFlight` says what still runs; `settled` waits, without asking anything to stop, until it has all ended.
 * - `stop` refuses new presses, answers those in flight `stopped` at once, interrupts them and waits until each has
 *   ended (the host bounds that wait: it is part of closing the part).
 *
 * The owners belong to the module host's parts (ModuleHost.ts): every instance part is made with its own owner. When
 * its module stops (after it is withdrawn, so no new press reaches it), the host gives the presses in flight the
 * grace period (`settled`), then `closePart` stops the owner before it closes the part's scope, both within the
 * host's time limit for closing a part (instances before their shared part, consumers before providers), so a press
 * has ended before anything it may use is released. The host's own owner (definition handlers) is made with
 * the host and stopped first when the host closes; from then on no press is admitted.
 */
/** How a press went (`FieldActionOwner.start`). */
export type PressOutcome<A, E> =
  | { readonly _tag: "busy" }
  /** Every press slot of the module is taken (`MAX_PRESS_SLOTS`): no new press until one ends. */
  | { readonly _tag: "full" }
  /** The owner is being stopped (its instance is going): refused, or answered at once while it ran. */
  | { readonly _tag: "stopped" }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "done"; readonly exit: Exit.Exit<A, E> }

export interface FieldActionOwner {
  /**
   * Run `press` under `key`, answering at `timeoutMs` at the latest. `busy`: that key's earlier press still runs;
   * `full`: the module's press slots are all taken; `stopped`: the owner is being stopped. At the deadline (or the
   * stop) the press is asked to stop and not waited for; its key and its slot stay taken until it has ended.
   * Interrupting the caller asks the press to stop too, the same way. `started` is called with the press's fiber as
   * soon as it is started.
   */
  readonly start: <A, E>(
    key: string,
    press: Effect.Effect<A, E>,
    timeoutMs: number,
    started?: (fiber: Fiber.Fiber<A, E>) => void
  ) => Effect.Effect<PressOutcome<A, E>>
  /** The keys whose presses still run. */
  readonly inFlight: () => ReadonlyArray<string>
  /** Completes once every press in flight now has ended (it asks none to stop; the caller bounds the wait). */
  readonly settled: Effect.Effect<void>
  readonly stop: Effect.Effect<void>
}

export const makeFieldActionOwner = (options: {
  /** A press ended (its key is free): the page may need the module again (`info` values). */
  readonly released?: (key: string) => void
  /** The press slots, per module, shared by every owner of the host, and the module a key belongs to. */
  readonly slots: ModuleSlots
  readonly moduleOf: (key: string) => string
}): FieldActionOwner => {
  const running = new Map<string, Fiber.Fiber<unknown, unknown>>()
  let stopped = false
  /** Completed when `stop` begins: every press still waited for is answered `stopped`. */
  const stopping = Deferred.makeUnsafe<void>()

  const start: FieldActionOwner["start"] = <A, E>(key: string, press: Effect.Effect<A, E>, timeoutMs: number, started?: (fiber: Fiber.Fiber<A, E>) => void) =>
    Effect.suspend((): Effect.Effect<PressOutcome<A, E>> => {
      if (stopped) return Effect.succeed({ _tag: "stopped" } as const)
      if (running.has(key)) return Effect.succeed({ _tag: "busy" } as const)
      return options.slots.run(options.moduleOf(key), press, {
        timeoutMs,
        stopped: Deferred.await(stopping),
        started: (fiber) => {
          running.set(key, fiber)
          fiber.addObserver(() => {
            // This press's own end frees its key; a newer press under the same key is never touched.
            if (running.get(key) !== fiber) return
            running.delete(key)
            options.released?.(key)
          })
          started?.(fiber)
        }
      })
    })

  const stop = Effect.suspend(() => {
    stopped = true
    Deferred.doneUnsafe(stopping, Effect.void)
    const fibers = [...running.values()]
    for (const fiber of fibers) fiber.interruptUnsafe()
    return Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { concurrency: "unbounded", discard: true })
  })

  const settled = Effect.suspend(() => Effect.forEach([...running.values()], (fiber) => Fiber.await(fiber), { concurrency: "unbounded", discard: true }))

  return { start, inFlight: () => [...running.keys()], settled, stop }
}
