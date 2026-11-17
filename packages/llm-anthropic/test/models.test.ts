// The model list for the admin's picker (`listModels`, `modelSource`): the SDK's `models.list` against a local server
// that answers in the SDK's page shape (no call to the real API). Pages, the fields kept, retired models dropped,
// errors without the key (401 that echoes it, 429 with Retry-After, a server that does not answer), the settings.
import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Redacted } from "effect"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { knownModels, listModels, modelSource } from "../src/index.ts"

const KEY = "sk-ant-api03-SECRET-models-0123456789"

const serve = async (handler: (req: Http.IncomingMessage, res: Http.ServerResponse) => void) => {
  const server = Http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.closeAllConnections()
      server.close()
    }
  }
}

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "model",
  id,
  display_name: id.toUpperCase(),
  created_at: "2026-10-01T00:00:00Z",
  max_input_tokens: 200000,
  max_tokens: 64000,
  lifecycle: "active",
  capabilities: null,
  deprecated_at: null,
  retires_at: null,
  line: null,
  ...extra
})

describe("listModels", () => {
  it("reads every page and keeps id, name, context, output limit, lifecycle and release date", async () => {
    const all = [...Array.from({ length: 120 }, (_, i) => model(`m-${i}`)), model("old", { lifecycle: "deprecated" }), model("gone", { lifecycle: "retired" })]
    const seen: Array<string> = []
    const api = await serve((req, res) => {
      const url = new URL(req.url ?? "/", "http://x")
      seen.push(url.pathname + url.search)
      const after = url.searchParams.get("after_id")
      const from = after === null ? 0 : all.findIndex((m) => m.id === after) + 1
      const page = all.slice(from, from + Number(url.searchParams.get("limit")))
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: page, has_more: from + page.length < all.length, first_id: page[0]?.id, last_id: page.at(-1)?.id }))
    })
    try {
      const models = await Effect.runPromise(listModels({ apiKey: Redacted.make(KEY), baseURL: api.url }))
      expect(models).toHaveLength(121)
      expect(models[0]).toEqual({ id: "m-0", label: "M-0", contextTokens: 200000, maxOutputTokens: 64000, lifecycle: "active", releasedAt: Date.parse("2026-10-01T00:00:00Z") })
      expect(models.at(-1)).toMatchObject({ id: "old", lifecycle: "deprecated" })
      expect(seen).toEqual(["/v1/models?limit=100", "/v1/models?limit=100&after_id=m-99"])
    } finally {
      api.close()
    }
  })

  it("a refused key, a rate limit and a server that does not answer are errors without the key", async () => {
    let mode: "401" | "429" | "hang" = "401"
    const api = await serve((_req, res) => {
      if (mode === "hang") return
      res.writeHead(Number(mode), { "content-type": "application/json", ...(mode === "429" ? { "retry-after": "7" } : {}) })
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${KEY}` } }))
    })
    try {
      const options = { apiKey: Redacted.make(KEY), baseURL: api.url }
      const refused = await Effect.runPromise(Effect.flip(listModels(options)))
      expect(refused.reason).toBe("unauthorized")
      expect(refused.message).toMatch(/^Anthropic rejected the API key \(401\)/)
      mode = "429"
      const limited = await Effect.runPromise(Effect.flip(listModels(options)))
      expect([limited.reason, limited.retryAfterMs]).toEqual(["rate_limited", 7000])
      mode = "hang"
      const slow = await Effect.runPromise(Effect.flip(listModels({ ...options, timeoutMs: 200 })))
      expect(slow.reason).toBe("timeout")
      for (const e of [refused, limited, slow]) expect(JSON.stringify({ m: e.message, c: String(e.cause) })).not.toContain(KEY)
    } finally {
      api.close()
    }
  })

  it("refuses an address with credentials without calling it", async () => {
    const e = await Effect.runPromise(Effect.flip(listModels({ apiKey: Redacted.make(KEY), baseURL: "https://user:pass@example.test" })))
    expect(e.reason).toBe("invalid")
    expect(e.message).not.toContain("pass")
  })
})

describe("modelSource", () => {
  const read = (env: Record<string, string>) => Effect.runPromise(Effect.provideService(modelSource, ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)))

  it("is not set up without a key; with one, its identity follows key and address and shows neither", async () => {
    expect((await read({})).state).toBe("not_set_up")
    expect((await read({ ANTHROPIC_API_KEY: "  " })).state).toBe("not_set_up")
    const a = await read({ ANTHROPIC_API_KEY: KEY })
    const b = await read({ ANTHROPIC_API_KEY: `${KEY}x` })
    const c = await read({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "http://127.0.0.1:1" })
    if (a.state !== "ready" || b.state !== "ready" || c.state !== "ready") throw new Error("not ready")
    expect(new Set([a.identity, b.identity, c.identity]).size).toBe(3)
    expect(a.identity).not.toContain(KEY.slice(0, 8))
  })

  it("the known models are the ones the code names", () => {
    expect(knownModels.map((m) => m.id)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"])
  })
})
