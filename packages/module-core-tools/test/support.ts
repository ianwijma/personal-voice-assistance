// What the module tests share: the offline network (no test reaches the network).
import { makeOfflineNet } from "@pva/core/testing"
import { CurrentTurnCommit, type TurnCommit } from "@pva/core"
import { Effect } from "effect"

export const netWith = (fixtures: Parameters<typeof makeOfflineNet>[0]) => {
  const net = makeOfflineNet(fixtures)
  return { net, deps: { resolver: net.resolver, connector: net.connector } }
}

/** A connector that never answers until its request is aborted: a service that is slow. */
export const hangingNet = () => {
  const net = makeOfflineNet({ "https://nl.wikipedia.org/w/api.php": { body: {} }, "https://en.wikipedia.org/w/api.php": { body: {} }, "https://en.wiktionary.org/api/rest_v1/page/definition/x": { body: {} } })
  const connector: typeof net.connector = (request) =>
    new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
    })
  return { net, deps: { resolver: net.resolver, connector } }
}

/**
 * A kit whose tool results read as they did before a result could carry a presentation: the model's text is the result
 * with its trailing "[Screen: …]" note taken off, and `value` is that text parsed (what the tool returned as `forModel`).
 */
export const unchanged = <K extends { readonly tool: (...args: Array<any>) => Effect.Effect<any, any, any> }>(kit: K): K => ({
  ...kit,
  tool: (...args: Array<unknown>) =>
    Effect.map(kit.tool(...args), (r: { readonly content: string; readonly value: unknown }) => {
      const text = r.content.replace(/\n\[Screen: [\s\S]*\]$/, "")
      try {
        return { ...r, content: text, value: JSON.parse(text) as unknown }
      } catch {
        return r
      }
    })
}) as K

/**
 * The module with every call of its tools' real `execute` counted by name: a test that says "both calls ran" observes
 * executions here, not identical output (a second answer replayed from the first would look the same).
 */
export const counting = <M extends { readonly start: (...args: Array<any>) => any }>(definition: M) => {
  const counts = new Map<string, number>()
  const wrapped = {
    ...definition,
    start: (...args: Array<unknown>) =>
      Effect.map(definition.start(...args) as Effect.Effect<{ readonly tools?: ReadonlyArray<any> }>, (parts) => ({
        ...parts,
        tools: (parts.tools ?? []).map((t) => ({ ...t, execute: (...a: Array<unknown>) => (counts.set(t.name, (counts.get(t.name) ?? 0) + 1), t.execute(...a)) }))
      }))
  } as M
  return { module: wrapped, executions: (name: string) => counts.get(name) ?? 0 }
}

/**
 * A turn that is not committed yet (a speculative one): calls made inside `within` are in it. `promote` runs what was
 * held for the commit; a discarded turn simply never calls it. (`Conversation` provides this for a turn's calls.)
 */
export const speculativeTurn = () => {
  let committed = false
  const held: Array<() => void> = []
  const commit: TurnCommit = {
    committed: () => committed,
    whenCommitted: (f) => (committed ? f() : void held.push(f))
  }
  return {
    within: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, CurrentTurnCommit, commit),
    promote: Effect.sync(() => {
      committed = true
      for (const f of held.splice(0)) f()
    })
  }
}
