// The model picker's source of an account (`accountModelSource`, docs/MODEL-PICKERS.md §3) and the OpenRouter list
// fields it shows (context, price, description), against local servers only.
import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect } from "effect"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { accountModelSource, type AccountId } from "../src/account.ts"
import { parseModelList } from "../src/models.ts"
import { profiles } from "../src/profiles.ts"

const read = (account: AccountId, env: Record<string, string>) =>
  Effect.runPromise(Effect.provideService(accountModelSource(account), ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)))

describe("OpenRouter list fields", () => {
  it("keeps the context window, the price per million tokens and a short description", () => {
    const [a, b, c] = parseModelList(profiles.openrouter, {
      data: [
        { id: "x/a", name: "A", context_length: 131072, pricing: { prompt: "0.0000025", completion: "0.00001" }, description: "d".repeat(400), supported_parameters: ["tools"] },
        { id: "x/free", name: "Free", context_length: 8192, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
        // A router's variable price (-1) and a missing context are not shown.
        { id: "openrouter/auto", name: "Auto", pricing: { prompt: "-1", completion: "-1" }, supported_parameters: ["tools"] }
      ]
    })!
    expect(a).toMatchObject({ contextTokens: 131072, pricing: { inputPerMTok: 2.5, outputPerMTok: 10 } })
    expect([...a!.description!].length).toBe(300)
    expect(b!.pricing).toEqual({ inputPerMTok: 0, outputPerMTok: 0 })
    expect(c!.pricing).toBeUndefined()
    expect(c!.contextTokens).toBeUndefined()
  })
})

describe("accountModelSource", () => {
  it("says what is missing: OpenRouter's key, the home model's address; a refused address", async () => {
    expect(await read("openrouter", {})).toMatchObject({ state: "not_set_up", missing: "key" })
    expect(await read("home-model", {})).toMatchObject({ state: "not_set_up", missing: "address" })
    const bad = await read("home-model", { HOME_MODEL_BASE_URL: "http://me:hunter2@10.0.0.2:11434" })
    expect(bad.state).toBe("invalid")
    expect(JSON.stringify(bad)).not.toContain("hunter2")
  })

  it("lists a home server's models at its address (with /v1 added), with the key when there is one", async () => {
    const seen: Array<{ path: string; auth: string | undefined }> = []
    const server = Http.createServer((req, res) => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "llama3.1:8b" }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const source = await read("home-model", { HOME_MODEL_BASE_URL: url, HOME_MODEL_API_KEY: "home-key-123456" })
      if (source.state !== "ready") throw new Error(source.state)
      expect(source.address).toBe(`${url}/v1`)
      expect(await Effect.runPromise(source.list({ timeoutMs: 2000 }))).toEqual([{ id: "llama3.1:8b", label: "llama3.1:8b" }])
      expect(seen).toEqual([{ path: "/v1/models", auth: "Bearer home-key-123456" }])
      const other = await read("home-model", { HOME_MODEL_BASE_URL: url })
      if (other.state !== "ready") throw new Error(other.state)
      expect(other.identity).not.toBe(source.identity)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
