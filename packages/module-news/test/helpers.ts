// Shared by the tests: feed documents, the starter feeds' addresses, and the module started on the offline network.
import { makeOfflineNet, startTestModule, type StartTestModuleOptions } from "@pva/core/testing"
import { Effect } from "effect"
import { newsModule } from "../src/index.ts"

export const BBC = "https://feeds.bbci.co.uk/news/rss.xml"
export const GUARDIAN = "https://www.theguardian.com/world/rss"
export const ARS = "https://feeds.arstechnica.com/arstechnica/index"
export const NOS = "https://feeds.nos.nl/nosnieuwsalgemeen"
export const NU = "https://www.nu.nl/rss/Algemeen"
export const TWEAKERS = "https://feeds.tweakers.net/mixed.xml"

export interface Story {
  readonly title: string
  readonly link: string
  readonly guid?: string
  readonly description?: string
  /** Minutes before the test clock's start (10:00 Amsterdam). */
  readonly ago?: number
}

export const NOW = Date.UTC(2026, 10, 18, 9, 0, 0)

export const rss = (title: string, stories: ReadonlyArray<Story>): string =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title><link>https://example.org</link>${stories
    .map(
      (s) =>
        `<item><title>${s.title}</title><link>${s.link}</link><guid isPermaLink="false">${s.guid ?? s.link}</guid><pubDate>${new Date(NOW - (s.ago ?? 10) * 60_000).toUTCString()}</pubDate><description>${s.description ?? ""}</description></item>`
    )
    .join("")}</channel></rss>`

export const xml = (body: string, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/rss+xml; charset=utf-8", ...extra }, body })

/** The module on the offline network: `fixtures` by URL. Answers the kit and the network (its recorded requests). */
export const startNews = (fixtures: Parameters<typeof makeOfflineNet>[0], options: StartTestModuleOptions = {}, lan: Record<string, string> = {}) => {
  const net = makeOfflineNet(fixtures, { lan })
  return Effect.map(startTestModule(newsModule({ resolver: net.resolver, connector: net.connector }), options), (kit) => ({ kit, net }))
}
