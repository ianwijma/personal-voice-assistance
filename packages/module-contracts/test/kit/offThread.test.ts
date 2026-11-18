// Parsing text from outside off the main thread in a module and in its test (docs/MODULES.md §15): `offThread` from
// `@pva/core` with a task module of the module's own package. The kit's tests start real workers. The `#region`
// blocks are quoted in docs/MODULES.md.
import { assert, describe, it } from "@effect/vitest"
import { defineModule, makeTool, offThread, type OffThreadError, offThreadTask } from "@pva/core"
import { makeOfflineNet, offThreadWorkers, startTestModule } from "@pva/core/testing"
import { type Connector, contentTypes, type Resolver, safeFetch } from "@pva/net"
import { Effect, Schema } from "effect"
import { vi } from "vitest"
// A latency test (vitest.latency.ts): its workers spin and its time limit is real time, so CI runs it alone.
import "../../../store-sqlite/test/latencyBound.ts"
import { defineTexts, homeLanguage, say } from "../../src/index.ts"

// Real workers start here (a quarter of a second each, several times that on a slow CI runner).
vi.setConfig({ testTimeout: 60_000 })

interface NetDeps {
  readonly resolver?: Resolver
  readonly connector?: Connector
}

// #region offthread-module
/** The task, named once: its file beside this one, and its default export's type (no import on the main thread). */
const pageText = offThreadTask<typeof import("./pageText.task.ts").default>(new URL("./pageText.task.ts", import.meta.url))

const pageTexts = defineTexts({
  en: { slow: "That page took too long to read.", unreadable: "I couldn't read that page." },
  nl: { slow: "Het lezen van die pagina duurde te lang.", unreadable: "Ik kon die pagina niet lezen." }
})

/** What the person hears when the parse failed: a page too slow to read, or one that cannot be read at all. */
const pageFailure = (lang: "en" | "nl", e: OffThreadError) => say(pageTexts, lang, e.reason === "timeout" ? "slow" : "unreadable")

export const readerModule = (deps: NetDeps) =>
  defineModule({
    apiVersion: 2,
    id: "reader",
    name: "Reader",
    description: "Reads a web page.",
    enabledByDefault: false,
    requires: [{ network: "internet", why: "fetches the page asked for" }],
    start: (ctx) =>
      Effect.succeed({
        tools: [makeTool({
          name: "reader_read_page",
          description: "Read the text of a web page.",
          parameters: Schema.Struct({ url: Schema.String }),
          risk: "read",
          latency: "slow",
          execute: ({ url }) => {
            const lang = homeLanguage(ctx.host.view())
            return safeFetch(url, { accept: contentTypes.webPage, maxBytes: 2 * 1024 * 1024, timeoutMs: 6_000, ...deps }).pipe(
              // The parse runs in a worker: the main thread only posts the page and receives the text.
              Effect.flatMap((response) => offThread(pageText, response.text(), { timeoutMs: 3_000, maxResultBytes: 128 * 1024 })),
              Effect.map((text) => `Untrusted page text: ${text}`),
              Effect.catchTag("OffThreadError", (e) => Effect.succeed(pageFailure(lang, e))),
              // The fetch's own failures (refused, too large, too slow, a bad status): the page could not be read.
              Effect.catch(() => Effect.succeed(say(pageTexts, lang, "unreadable")))
            )
          }
        })]
      })
  })
// #endregion offthread-module

const spin = offThreadTask<typeof import("./spin.task.ts").default>(new URL("./spin.task.ts", import.meta.url))

describe("a module that parses off the main thread", () => {
  it.effect("reads a page through a worker in the test too, and says so when the page cannot be read", () =>
    Effect.gen(function*() {
      // #region offthread-test
      const page = "<html><head><script>track()</script></head><body>\n<h1>Bins</h1>\n<p>Paper goes out on Tuesday.</p></body></html>"
      const net = makeOfflineNet({
        "https://example.org/bins": { body: page, headers: { "content-type": "text/html" } },
        "https://example.org/huge": { body: `<html><body><p>${"word ".repeat(100_000)}</p></body></html>`, headers: { "content-type": "text/html" } }
      })
      const on = yield* startTestModule(readerModule({ resolver: net.resolver, connector: net.connector }))
      // A real worker runs the task, in tests as in the app (its time limit is real time, not the kit's clock).
      assert.strictEqual((yield* on.tool("reader_read_page", { url: "https://example.org/bins" })).value, "Untrusted page text: Bins Paper goes out on Tuesday.")
      // Text over the result limit is a typed failure (`too-large`), which the module words itself.
      assert.strictEqual((yield* on.tool("reader_read_page", { url: "https://example.org/huge" })).value, "I couldn't read that page.")
      // Every worker has ended.
      assert.strictEqual(offThreadWorkers().running, 0)
      // #endregion offthread-test
      // The time limit is real time, not the kit's clock: a task that never ends is stopped at its limit although
      // this test's clock never moves, and the module words it as a page too slow to read.
      const t0 = performance.now()
      const slow = yield* Effect.flip(offThread(spin, "", { timeoutMs: 500 }))
      assert.strictEqual(slow.reason, "timeout")
      assert.isBelow(performance.now() - t0, 10_000)
      assert.strictEqual(pageFailure("en", slow), "That page took too long to read.")
      assert.strictEqual(offThreadWorkers().running, 0)
    }))
})
