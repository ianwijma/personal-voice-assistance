// What the module tests share: the offline network (no test reaches the network) and its fixtures.
import { makeOfflineNet } from "@pva/core/testing"

export const FRANKFURTER = "https://api.frankfurter.dev/v2/rates"

/** The rates answer as the service gives it: a list of { date, base, quote, rate } (crypto included, which the module drops). */
export const ratesAnswer = (date = "2026-11-18") => [
  { date, base: "EUR", quote: "USD", rate: 1.08 },
  { date, base: "EUR", quote: "GBP", rate: 0.86 },
  { date, base: "EUR", quote: "JPY", rate: 160 },
  { date: "2026-11-17", base: "EUR", quote: "BTC", rate: 0.00001 }
]

export const netWith = (fixtures: Parameters<typeof makeOfflineNet>[0]) => {
  const net = makeOfflineNet(fixtures)
  return { net, deps: { resolver: net.resolver, connector: net.connector } }
}

/** A connector that never answers until its request is aborted: a service that is slow. */
export const hangingNet = () => {
  const net = makeOfflineNet({ "https://api.frankfurter.dev/v2/rates": { body: [] }, "https://nl.wikipedia.org/w/api.php": { body: {} }, "https://en.wikipedia.org/w/api.php": { body: {} }, "https://www.wikidata.org/w/api.php": { body: {} }, "https://en.wiktionary.org/api/rest_v1/page/definition/x": { body: {} } })
  const connector: typeof net.connector = (request) =>
    new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
    })
  return { net, deps: { resolver: net.resolver, connector } }
}
