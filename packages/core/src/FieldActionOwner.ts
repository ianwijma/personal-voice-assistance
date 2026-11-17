import { Effect, type Exit, Fiber, Option } from "effect"
import type { Stragglers } from "./Stragglers.ts"

/**
 * Who a field action's press belongs to (docs/UI-AND-MODULES.md §1.7): the host for a definition's handler, the
 * running instance for an instance's handler or a generated Test button. One owner ties together the press's
 * lifetime, its button's busy state and its cleanup:
 *
 * - `start` runs a press in its own fiber, at most one per key: the key is busy from the start of the press until its
 *   fiber has really ended, whatever its deadline or its cleanup take. Only the press's own end frees its key, so an
 *   old press can never free a newer one's.
 * - `inFlight` says what still runs; `settled` waits, without asking anything to stop, until it has all ended.
 * - `stop` refuses new presses, interrupts those in flight and waits until each has ended (logging one whose cleanup
 *   overruns `cleanupMs`, still waiting).
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
  /** Too many earlier presses of the module have not stopped (`Stragglers`): no new one until some end. */
  | { readonly _tag: "stuck" }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "done"; readonly exit: Exit.Exit<A, E> }

export interface FieldActionOwner {
  /**
   * Run `press` under `key`, answering at `timeoutMs` at the latest. `busy`: that key's earlier press still runs;
   * `stopped`: the owner is being stopped (its instance is going). At the deadline the press is asked to stop and the
   * answer is `timeout`; its key stays busy until it has ended. Interrupting the caller asks the press to stop too.
   */
  readonly start: <A, E>(key: string, press: Effect.Effect<A, E>, timeoutMs: number) => Effect.Effect<PressOutcome<A, E>>
  /** The keys whose presses still run. */
  readonly inFlight: () => ReadonlyArray<string>
  /** Completes once every press in flight now has ended (it asks none to stop; the caller bounds the wait). */
  readonly settled: Effect.Effect<void>
  readonly stop: Effect.Effect<void>
}

export const makeFieldActionOwner = (options: {
  /** For the log: what the press of `key` is called ("field action <module>.<key>"). */
  readonly label: (key: string) => string
  /** How long a stopped press's cleanup may take before it is logged (it is still waited for). */
  readonly cleanupMs: number
  /** A press ended (its key is free): the page may need the module again (`info` values). */
  readonly released?: (key: string) => void
  /**
   * The presses that did not stop within `cleanupMs` of being asked to, counted per module (shared by every owner of
   * the host), and the module a key belongs to. At the module's cap, `start` answers `stuck`.
   */
  readonly stragglers: Stragglers
  readonly moduleOf: (key: string) => string
}): FieldActionOwner => {
  const running = new Map<string, Fiber.Fiber<unknown, unknown>>()
  let stopped = false

  /** `fiber` was asked to stop: logged and counted as a straggler if it has not ended within the cleanup limit. Never frees its key. */
  const watch = (key: string, fiber: Fiber.Fiber<unknown, unknown>, why: string) =>
    options.stragglers.watch(
      options.moduleOf(key),
      fiber,
      Effect.logWarning(`${options.label(key)}: still cleaning up ${options.cleanupMs} ms after it was ${why}; its button stays busy until it ends`)
    )

  const start: FieldActionOwner["start"] = (key, press, timeoutMs) =>
    Effect.suspend((): Effect.Effect<PressOutcome<any, any>> => {
      if (stopped) return Effect.succeed({ _tag: "stopped" } as const)
      if (running.has(key)) return Effect.succeed({ _tag: "busy" } as const)
      if (options.stragglers.full(options.moduleOf(key))) return Effect.succeed({ _tag: "stuck" } as const)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const fiber = yield* Effect.forkDetach(press)
          running.set(key, fiber)
          fiber.addObserver(() => {
            // This press's own end frees its key; a newer press under the same key is never touched.
            if (running.get(key) !== fiber) return
            running.delete(key)
            options.released?.(key)
          })
          const exit = yield* restore(Fiber.await(fiber).pipe(Effect.timeoutOption(timeoutMs))).pipe(
            Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe()))
          )
          if (Option.isSome(exit)) return { _tag: "done", exit: exit.value } as const
          // The answer is due now; the interruption and the press's finalizers run on in the background.
          fiber.interruptUnsafe()
          yield* watch(key, fiber, "timed out")
          return { _tag: "timeout" } as const
        })
      )
    })

  const stop = Effect.suspend(() => {
    stopped = true
    const fibers = [...running.entries()]
    return Effect.forEach(
      fibers,
      ([key, fiber]) =>
        Effect.sync(() => fiber.interruptUnsafe()).pipe(
          Effect.andThen(watch(key, fiber, "stopped")),
          Effect.andThen(Fiber.await(fiber))
        ),
      { concurrency: "unbounded", discard: true }
    )
  })

  const settled = Effect.suspend(() => Effect.forEach([...running.values()], (fiber) => Fiber.await(fiber), { concurrency: "unbounded", discard: true }))

  return { start, inFlight: () => [...running.keys()], settled, stop }
}
