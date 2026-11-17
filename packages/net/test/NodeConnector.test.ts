import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { fetchOwnerConfiguredLan, nodeConnector } from "../src/SafeFetch.ts"

const serve = async (handler: http.RequestListener) => {
  const server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe("nodeConnector (a real socket on this machine)", () => {
  it("dials the given address and sends the URL's host as the Host header", async () => {
    let host: string | undefined
    const s = await serve((req, res) => { host = req.headers.host; res.setHeader("X-A", "1"); res.end("hi") })
    try {
      // The name never resolves; the connector connects to the address it is given.
      const res = await Effect.runPromise(fetchOwnerConfiguredLan(`http://pretend.example:${s.port}/p?q=1`, {
        resolver: async () => ["192.168.0.1"],
        connector: (r) => nodeConnector({ ...r, address: "127.0.0.1" })
      }))
      expect(res.text()).toBe("hi")
      expect(res.headers["x-a"]).toBe("1")
      expect(host).toBe(`pretend.example:${s.port}`)
    } finally { await s.close() }
  })
  it("an abort tears down a body that is still arriving", async () => {
    const s = await serve((_req, res) => { res.write("a") })
    try {
      const controller = new AbortController()
      const res = await nodeConnector({ url: new URL(`http://127.0.0.1:${s.port}/`), address: "127.0.0.1", method: "GET", headers: {}, signal: controller.signal })
      setTimeout(() => controller.abort(new Error("stop")), 20)
      await expect((async () => { for await (const _ of res.body) { /* wait */ } })()).rejects.toBeDefined()
    } finally { await s.close() }
  })
})
