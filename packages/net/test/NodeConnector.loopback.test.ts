// These tests bind a server on this machine's loopback interface (127.0.0.1) and nothing else: no request leaves the machine,
// so they are not network tests (packages/net/README.md). They check what only a real socket shows.
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import http from "node:http"
import zlib from "node:zlib"
import type { AddressInfo } from "node:net"
import { contentTypes, fetchOwnerConfiguredLan, nodeConnector } from "../src/SafeFetch.ts"

const serve = async (handler: http.RequestListener) => {
  const server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe("nodeConnector (a real socket on this machine)", () => {
  it("dials the given address and sends the URL's host as the Host header", async () => {
    let host: string | undefined
    const s = await serve((req, res) => { host = req.headers.host; res.setHeader("X-A", "1"); res.setHeader("Content-Type", "text/plain"); res.end("hi") })
    try {
      // The name never resolves; the connector connects to the address it is given.
      const res = await Effect.runPromise(fetchOwnerConfiguredLan(`http://pretend.example:${s.port}/p?q=1`, {
        accept: contentTypes.webPage,
        resolver: async () => ["192.168.0.1"],
        connector: (r) => nodeConnector({ ...r, address: "127.0.0.1" })
      }))
      expect(res.text()).toBe("hi")
      expect(res.headers["x-a"]).toBe("1")
      expect(host).toBe(`pretend.example:${s.port}`)
    } finally { await s.close() }
  })
  it("the Host header and the encoding come from the connector, whatever headers it is handed", async () => {
    let seen: http.IncomingHttpHeaders | undefined
    const s = await serve((req, res) => { seen = req.headers; res.end("ok") })
    try {
      const url = new URL(`http://pretend.example:${s.port}/`)
      const res = await nodeConnector({ url, address: "127.0.0.1", method: "GET", headers: { host: "metadata.google.internal", "accept-encoding": "gzip", "x-a": "1" }, signal: new AbortController().signal })
      for await (const _ of res.body) { /* drain */ }
      expect(seen?.host).toBe(`pretend.example:${s.port}`)
      expect(seen?.["accept-encoding"]).toBe("identity")
      expect(seen?.["x-a"]).toBe("1")
    } finally { await s.close() }
  })
  it("a server that compresses anyway is decompressed and limited", async () => {
    const big = "x".repeat(3 * 1024 * 1024)
    const s = await serve((req, res) => {
      res.setHeader("Content-Type", "text/plain")
      res.setHeader("Content-Encoding", "gzip")
      res.end(zlib.gzipSync(req.url === "/big" ? big : "hello"))
    })
    try {
      const options = { accept: contentTypes.webPage, resolver: async () => ["192.168.0.1"], connector: (r: Parameters<typeof nodeConnector>[0]) => nodeConnector({ ...r, address: "127.0.0.1" }) }
      expect((await Effect.runPromise(fetchOwnerConfiguredLan(`http://pretend.example:${s.port}/small`, options))).text()).toBe("hello")
      const exit = await Effect.runPromiseExit(fetchOwnerConfiguredLan(`http://pretend.example:${s.port}/big`, options))
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("NetTooLarge")
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
