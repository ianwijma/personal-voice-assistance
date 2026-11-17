import { Clock, Effect } from "effect"
import type { Collection, HouseholdStore, Row, ScopeRef } from "./HouseholdStore.ts"
import type { ContextProvider } from "./Module.ts"
import type { ToolRegistry } from "./ToolRegistry.ts"
import { CurrentTurn, type TurnContext } from "./TurnContext.ts"

/**
 * Ambient facts (shared-state-jobs-and-notifications.md §7.2; docs/MODULES-PLAN.md §4 P4): one host context provider
 * that puts the collections' `ambient` lines for the turn's device and person into `LlmRequest.context`, so "how long
 * is left on the pasta?" works for an assistant without the timers module. It is outside the cached prefix.
 *
 * Budget: at most 600 characters (whole lines, in catalog order; a module's lines are its own order), and only bounded
 * reads: per collection one index read per visible scope of at most `ambientRows` rows, newest first (the store's
 * `list` cannot do more, by construction). The 50 ms timeout cannot stop a synchronous read; it only drops a slow
 * turn's lines. Behind the household switch `HOME_AMBIENT_FACTS`: `off` (the default, until its effect on a hosted
 * model's first token is measured: docs/STORING-DATA.md "Ambient facts"), `all`, `module-on` (only from modules the
 * turn's assistant has on).
 */

export type AmbientMode = "all" | "module-on" | "off"

export const AMBIENT_MAX_CHARS = 600
export const AMBIENT_TIMEOUT_MS = 50

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
  readonly maxChars?: number
  readonly timeoutMs?: number
}

/** The scopes a turn sees: the household, its device, its person, its assistant, its conversation. */
const scopesFor = (collection: Collection<any>, turn: TurnContext | undefined): ReadonlyArray<ScopeRef> => {
  switch (collection.scope) {
    case "household":
      return [{ kind: "household" }]
    case "device":
      return turn?.deviceId !== undefined ? [{ kind: "device", id: turn.deviceId }] : []
    case "person":
      return turn?.person !== undefined ? [{ kind: "person", id: turn.person.id }] : []
    case "assistant":
      return turn?.assistantId !== undefined ? [{ kind: "assistant", id: turn.assistantId }] : []
    case "conversation":
      return turn !== undefined ? [{ kind: "conversation", id: turn.conversationId }] : []
  }
}

/** The lines of one turn, capped (no timeout: `makeAmbientFacts` adds it). */
export const ambientLines = (options: AmbientOptions): Effect.Effect<string> =>
  Effect.gen(function*() {
    const mode = options.mode()
    if (mode === "off") return ""
    const turn = yield* CurrentTurn
    const now = yield* Clock.currentTimeMillis
    const max = options.maxChars ?? AMBIENT_MAX_CHARS
    const lines: Array<string> = []
    let used = 0
    for (const m of options.modules) {
      if (options.usable !== undefined && !options.usable(m.moduleId)) continue
      if (mode === "module-on" && (turn?.assistantId === undefined || options.moduleOn?.(turn.assistantId, m.moduleId) !== true)) continue
      const store = options.store.forModule(m.moduleId)
      for (const c of m.collections) {
        if (c.ambient === undefined) continue
        const rows: Array<Row<unknown>> = []
        for (const scope of scopesFor(c, turn)) {
          const got = yield* store.collection(c).list({ scope, limit: c.ambientRows }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<Row<unknown>>))
          rows.push(...got)
        }
        if (rows.length === 0) continue
        let out: string | ReadonlyArray<string> | undefined
        try {
          out = c.ambient(rows, { now, turn })
        } catch {
          out = undefined
        }
        for (const line of out === undefined ? [] : typeof out === "string" ? [out] : out) {
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

/** The provider (named `Household`): the lines within the time budget, or nothing that turn. */
export const makeAmbientFacts = (options: AmbientOptions): ContextProvider => ({
  name: "Household",
  get: ambientLines(options).pipe(
    Effect.timeoutOption(options.timeoutMs ?? AMBIENT_TIMEOUT_MS),
    Effect.map((o) => (o._tag === "Some" ? o.value : "")),
    Effect.catchCause(() => Effect.succeed(""))
  )
})

/** A registry whose per-turn context also has `provider`'s output (after the modules' sections). */
export const withContextProvider = (registry: ToolRegistry["Service"], provider: ContextProvider): ToolRegistry["Service"] => ({
  ...registry,
  context: Effect.map(
    Effect.all([registry.context, Effect.map(provider.get, (text) => (text.length === 0 ? "" : `## ${provider.name}\n${text}`))], { concurrency: "unbounded" }),
    ([modules, mine]) => [modules, mine].filter((s) => s.length > 0).join("\n\n")
  )
})
