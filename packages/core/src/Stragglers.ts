import { Effect, Fiber, Option } from "effect"
import type { Issue } from "./ModuleApi.ts"

/**
 * Work of a module that was asked to stop and did not (docs/UI-AND-MODULES.md §1.7, §1.11): a field action's press or
 * a route's handler past its deadline whose interruption and finalizers have still not ended `cleanupMs` later. Such a
 * fiber is a **straggler** of its module until it really ends. The number per module is capped: at the cap the module
 * takes no new work of that kind (a press is answered `busy`, a request 503) until some end, so stuck work cannot pile
 * up without bound, and Health says so (`changed` gets the new count, for the issue).
 */
export interface Stragglers {
  /**
   * `fiber` (of module `moduleId`) was asked to stop: after `cleanupMs`, if it has not ended, it counts as a
   * straggler until it ends (`overdue` runs then, once: the log line). Returns at once.
   */
  readonly watch: (moduleId: string, fiber: Fiber.Fiber<unknown, unknown>, overdue: Effect.Effect<void>) => Effect.Effect<void>
  /** The module has `cap` stragglers: refuse its new work. */
  readonly full: (moduleId: string) => boolean
  readonly count: (moduleId: string) => number
}

export const makeStragglers = (options: {
  readonly cap: number
  readonly cleanupMs: number
  /** The module's count changed. */
  readonly changed?: (moduleId: string, count: number) => void
}): Stragglers => {
  const counts = new Map<string, number>()
  const set = (moduleId: string, n: number) => {
    if (n === 0) counts.delete(moduleId)
    else counts.set(moduleId, n)
    options.changed?.(moduleId, n)
  }
  const watch: Stragglers["watch"] = (moduleId, fiber, overdue) =>
    Effect.asVoid(Effect.forkDetach(
      Fiber.await(fiber).pipe(
        Effect.timeoutOption(options.cleanupMs),
        Effect.flatMap((done) =>
          Option.isSome(done) ? Effect.void : Effect.andThen(overdue, Effect.sync(() => {
            set(moduleId, (counts.get(moduleId) ?? 0) + 1)
            // Called at once if it has ended meanwhile.
            fiber.addObserver(() => set(moduleId, Math.max(0, (counts.get(moduleId) ?? 1) - 1)))
          }))
        )
      )
    ))
  return {
    watch,
    full: (moduleId) => (counts.get(moduleId) ?? 0) >= options.cap,
    count: (moduleId) => counts.get(moduleId) ?? 0
  }
}

/** The Health issue of a module with stragglers (none at 0): its id `<module>.<kind>-stuck`. */
export const stragglerIssues = (
  moduleId: string,
  name: string,
  kind: "presses" | "routes",
  count: number,
  cap: number
): ReadonlyArray<Issue> =>
  count === 0 ? [] : [{
    id: `${moduleId}.${kind}-stuck`,
    module: moduleId,
    severity: count >= cap ? "error" : "warning",
    title: kind === "presses" ? `${name}: buttons that did not stop` : `${name}: web requests that did not stop`,
    detail: `${count} ${kind === "presses" ? (count === 1 ? "button press is" : "button presses are") : count === 1 ? "request is" : "requests are"} still running after being stopped${
      count >= cap ? `; until some end, ${kind === "presses" ? "its buttons are refused" : "its web addresses answer 503"}` : ""
    }. Restarting the assistant ends them.`
  }]
