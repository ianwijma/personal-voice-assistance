// What the module tests share: the offline network (no test reaches the network).
import { makeOfflineNet } from "@pva/core/testing"
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
