// What the module tests share: the offline network (no test reaches the network).
import { makeOfflineNet } from "@pva/core/testing"

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
