import { Clock, Effect } from "effect"
import { type Collection, type HouseholdStore, MAX_AMBIENT_ROWS, type Row, type ScopeRef } from "./HouseholdStore.ts"
import type { ContextProvider } from "./Module.ts"
import type { ToolRegistry } from "./ToolRegistry.ts"
import { CurrentTurn, type TurnContext } from "./TurnContext.ts"

/**
 * Ambient facts (docs/MODULES-PLAN.md §4 P4; docs/STORING-DATA.md "Ambient facts"): one host context provider that puts
 * the collections' `ambient` lines for the turn's device and person into `LlmRequest.context`, so "how long is left
 * on the pasta?" works for an assistant without the timers module. It is outside the cached prefix.
 *
 * Budget: it returns within it by doing **bounded synchronous work only**, not by racing a timeout it could not win
 * (a synchronous read cannot be preempted). Per collection with `ambient` lines it makes one index read per visible
 * scope of at most `ambientRows` rows (never more than `MAX_AMBIENT_ROWS`), newest first, and runs the module's
 * `ambient` function once; it stops reading when `AMBIENT_BUDGET_MS` has passed (it checks the time before each
 * collection, so the stretch is the budget plus one bounded read and one call at most) or the text reaches
 * `AMBIENT_MAX_CHARS` (whole lines, in catalog order; a module's lines are its own order). Behind the household switch
 * `HOME_AMBIENT_FACTS`: `off` (the default, until its effect on a hosted model's first token is measured),
 * `all`, `module-on` (only from modules the turn's assistant has on).
 */

export type AmbientMode = "all" | "module-on" | "off"

export const AMBIENT_MAX_CHARS = 600
export const AMBIENT_BUDGET_MS = 50

export interface AmbientModule {
  readonly moduleId: string
  readonly collections: ReadonlyArray<Collection<any>>
}

export interface AmbientOptions {
  readonly store: HouseholdStore
  /** The modules with ambient collections, in catalog order. */
  readonly modules: ReadonlyArray<AmbientModule>
  /** Read at every turn. */
  readonly mode: () => AmbientMode
  /** Whether the assistant has the module on (`module-on`), and whether the module may run here (not unavailable). */
  readonly moduleOn?: (assistantId: string, moduleId: string) => boolean
  readonly usable?: (moduleId: string) => boolean
  /**
   * P5: may personal content of `owner` reach this turn's model (`Privacy.mayReveal(owner, turn)`: the privacy rule
   * on the turn's device)? Person-scoped rows are read only when it says yes. Absent: never.
   */
  readonly mayRevealPerson?: (owner: string, turn: TurnContext) => boolean
  readonly maxChars?: number
  readonly budgetMs?: number
  /** A monotonic clock in ms (tests). Default `performance.now`. */
  readonly clock?: () => number
}

/**
 * The scopes a turn sees: the household, its device, its person (only when the privacy rule lets the turn's device
 * hear that person's things: a turn's person is selected by the device's default person and grants nothing), its
 * assistant, its conversation.
 */
const scopesFor = (collection: Collection<any>, turn: TurnContext | undefined, options: AmbientOptions): ReadonlyArray<ScopeRef> => {
  switch (collection.scope) {
    case "household":
      return [{ kind: "household" }]
    case "device":
      return turn?.deviceId !== undefined ? [{ kind: "device", id: turn.deviceId }] : []
    case "person":
      return turn?.person !== undefined && mayRevealPersonTo(options, turn.person.id, turn) ? [{ kind: "person", id: turn.person.id }] : []
    case "assistant":
      return turn?.assistantId !== undefined ? [{ kind: "assistant", id: turn.assistantId }] : []
    case "conversation":
      return turn !== undefined ? [{ kind: "conversation", id: turn.conversationId }] : []
  }
}

const mayRevealPersonTo = (options: AmbientOptions, owner: string, turn: TurnContext): boolean => {
  if (options.mayRevealPerson === undefined) return false
  try {
    return options.mayRevealPerson(owner, turn) === true
  } catch {
    return false
  }
}

/** The lines of one turn: bounded synchronous reads, capped in characters and time. */
export const ambientLines = (options: AmbientOptions): Effect.Effect<string> =>
  Effect.gen(function*() {
    const mode = options.mode()
    if (mode === "off") return ""
    const turn = yield* CurrentTurn
    const now = yield* Clock.currentTimeMillis
    const clock = options.clock ?? (() => performance.now())
    const deadline = clock() + (options.budgetMs ?? AMBIENT_BUDGET_MS)
    const max = options.maxChars ?? AMBIENT_MAX_CHARS
    const lines: Array<string> = []
    let used = 0
    for (const m of options.modules) {
      if (options.usable !== undefined && !options.usable(m.moduleId)) continue
      if (mode === "module-on" && (turn?.assistantId === undefined || options.moduleOn?.(turn.assistantId, m.moduleId) !== true)) continue
      for (const c of m.collections) {
        if (c.ambient === undefined) continue
        if (clock() >= deadline) return lines.join("\n")
        const reader = options.store.reader(m.moduleId, c)
        if (reader === undefined) continue
        const rows: Array<Row<unknown>> = []
        for (const scope of scopesFor(c, turn, options)) {
          try {
            rows.push(...reader.list({ scope, limit: Math.min(c.ambientRows, MAX_AMBIENT_ROWS) }))
          } catch {
            // A collection that cannot be read gives no lines this turn.
          }
        }
        if (rows.length === 0) continue
        let out: string | ReadonlyArray<string> | undefined
        try {
          out = c.ambient(rows, { now, turn })
        } catch {
          out = undefined
        }
        for (const line of out === undefined ? [] : typeof out === "string" ? [out] : out) {
          if (typeof line !== "string") continue
          const clean = line.replace(/\s+/g, " ").trim()
          if (clean.length === 0) continue
          const cost = clean.length + (lines.length > 0 ? 1 : 0)
          if (used + cost > max) return lines.join("\n")
          lines.push(clean)
          used += cost
        }
      }
    }
    return lines.join("\n")
  })

/** The provider (named `Household`): the lines, or nothing that turn when something fails. */
export const makeAmbientFacts = (options: AmbientOptions): ContextProvider => ({
  name: "Household",
  get: ambientLines(options).pipe(Effect.catchCause(() => Effect.succeed("")))
})

/** A registry whose per-turn context also has `provider`'s output (after the modules' sections). */
export const withContextProvider = (registry: ToolRegistry["Service"], provider: ContextProvider): ToolRegistry["Service"] => ({
  ...registry,
  context: Effect.map(
    Effect.all([registry.context, Effect.map(provider.get, (text) => (text.length === 0 ? "" : `## ${provider.name}\n${text}`))], { concurrency: "unbounded" }),
    ([modules, mine]) => [modules, mine].filter((s) => s.length > 0).join("\n\n")
  )
})
