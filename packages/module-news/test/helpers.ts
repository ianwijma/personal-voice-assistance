// Shared by the tests: feed documents, the starter feeds' addresses, the module started on the offline network, and
// waiting (in real time) for the work the test clock does not drive: a parse in a worker thread.
import { makeOfflineNet, startTestModule, type StartTestModuleOptions } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { newsModule, type NewsDeps } from "../src/index.ts"

// Each refresh, subscription and article starts real worker threads (a quarter of a second each): more than vitest's
// default five seconds for a test that does several.
vi.setConfig({ testTimeout: 30_000 })

export const BBC = "https://feeds.bbci.co.uk/news/rss.xml"
export const GUARDIAN = "https://www.theguardian.com/world/rss"
export const ARS = "https://feeds.arstechnica.com/arstechnica/index"
export const NOS = "https://feeds.nos.nl/nosnieuwsalgemeen"
export const NU = "https://www.nu.nl/rss/Algemeen"

export interface Story {
  readonly title: string
  /** Absent: no `<link>` element. */
  readonly link?: string
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
        `<item><title>${s.title}</title>${s.link !== undefined ? `<link>${s.link}</link>` : ""}<guid isPermaLink="false">${s.guid ?? s.link ?? s.title}</guid><pubDate>${new Date(NOW - (s.ago ?? 10) * 60_000).toUTCString()}</pubDate><description>${s.description ?? ""}</description></item>`
    )
    .join("")}</channel></rss>`

export const xml = (body: string, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/rss+xml; charset=utf-8", ...extra }, body })

export type Kit = Effect.Success<ReturnType<typeof startTestModule>>

/** The module on the offline network: `fixtures` by URL. Answers the kit and the network (its recorded requests). */
export const startNews = (fixtures: Parameters<typeof makeOfflineNet>[0], options: StartTestModuleOptions = {}, extra: Omit<NewsDeps, "resolver" | "connector"> = {}) => {
  const net = makeOfflineNet(fixtures)
  return Effect.map(startTestModule(newsModule({ resolver: net.resolver, connector: net.connector, ...extra }), options), (kit) => ({ kit, net }))
}

const realSleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

/**
 * Until no job of the module is running: a refresh waits on parses in worker threads, which run in real time, so the
 * test clock alone does not finish it. Fails after 20 s.
 */
export const idle = (kit: Kit) =>
  Effect.gen(function*() {
    for (let i = 0; i < 800; i++) {
      yield* kit.advance(0)
      const jobs = yield* kit.jobs
      if (!jobs.some((j) => j.state === "running")) return
      yield* realSleep(25)
    }
    return yield* Effect.die(new Error("a job of the module was still running after 20 s"))
  })

/**
 * Moves the clock by `ms`, one due job at a time, and waits after each for what it started: the clock never jumps
 * over a job while an earlier one is still parsing in real time (which a real clock could not do either).
 */
export const advanceIdle = (kit: Kit, ms: number) =>
  Effect.gen(function*() {
    const end = (yield* kit.now) + ms
    for (;;) {
      const now = yield* kit.now
      const due = (yield* kit.jobs).filter((j) => j.state === "scheduled" && j.dueAt > now && j.dueAt < end).map((j) => j.dueAt)
      const target = due.length === 0 ? end : Math.min(...due)
      yield* kit.advance(target - now)
      yield* idle(kit)
      if (target >= end) return
    }
  })

/** The start job's refresh, done. */
export const refreshed = (kit: Kit) => advanceIdle(kit, 5_000)

export const value = (r: { readonly value: unknown }) => r.value as Record<string, any>
