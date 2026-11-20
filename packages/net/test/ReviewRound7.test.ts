// Review round 7 of the net package: one Content-Type parser instead of patterns.
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { NetRefused } from "../src/Errors.ts"
import { contentTypes, fetchOwnerConfiguredLan, mediaTypeOf, nodeConnector, parseContentType, safeFetch } from "../src/SafeFetch.ts"
import { fakeConnector, fakeResolver, reply } from "./helpers.ts"

const resolver = fakeResolver({ "a.example": ["8.8.8.8"] })
const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)))
const utf8 = new TextEncoder().encode("café")
const isoCafe = Uint8Array.from([0x63, 0x61, 0x66, 0xe9])

type Case = { readonly name: string; readonly lines: ReadonlyArray<string>; readonly body?: Uint8Array } & (
  { readonly refused: true } | { readonly refused?: false; readonly type: string; readonly text: string }
)
const cases: ReadonlyArray<Case> = [
  { name: "finding 1: unclosed quote on the first of two lines", lines: ['text/plain; title="', "application/octet-stream"], refused: true },
  { name: "finding 1: unclosed quote then a comma in one value", lines: ['text/plain; title="unterminated, application/octet-stream'], refused: true },
  { name: "finding 1: first line ends in a backslash inside a quote", lines: ['text/plain; title="abc\\', "application/octet-stream"], refused: true },
  { name: "two well-formed lines", lines: ["text/plain", "text/plain"], refused: true },
  { name: "two lines, the second empty", lines: ["text/plain", ""], refused: true },
  { name: "finding 2: charset-like text inside a quoted parameter", lines: ['text/plain; title="menu;charset=iso-8859-1"; charset=utf-8'], body: utf8, type: "text/plain", text: "café" },
  { name: "finding 2: charset-like text in another parameter, no real charset: UTF-8", lines: ['text/plain; title="menu;charset=iso-8859-1"'], body: utf8, type: "text/plain", text: "café" },
  { name: "finding 2: quoted-pair in a quoted charset", lines: ['text/plain; charset="iso\\-8859-1"'], body: isoCafe, type: "text/plain", text: "café" },
  { name: "no space, upper-case parameter value", lines: ["text/html;charset=UTF-8"], body: utf8, type: "text/html", text: "café" },
  { name: "upper case, spaces, quoted charset, upper-case name", lines: ['Text/HTML ; Charset="utf-8"'], body: utf8, type: "text/html", text: "café" },
  { name: "first occurrence of a name wins", lines: ["text/plain; charset=iso-8859-1; charset=utf-8"], body: isoCafe, type: "text/plain", text: "café" },
  { name: "a trailing semicolon", lines: ["text/plain; charset=utf-8;"], body: utf8, type: "text/plain", text: "café" },
  { name: "a doubled semicolon", lines: ["text/plain;; "], refused: true },
  { name: "a quoted parameter containing a comma", lines: ['text/plain; title="a, b"; charset=utf-8'], body: utf8, type: "text/plain", text: "café" },
  { name: "a quoted parameter containing an escaped quote", lines: ['text/plain; title="say \\"hi\\""; charset=utf-8'], body: utf8, type: "text/plain", text: "café" },
  { name: "an unknown charset: UTF-8", lines: ["text/plain; charset=nonsense"], body: utf8, type: "text/plain", text: "café" },
  { name: "a combined value listing two types", lines: ["text/plain, application/octet-stream"], refused: true },
  { name: "a comma after a parameter", lines: ["text/plain; charset=utf-8, application/octet-stream"], refused: true },
  { name: "a parameter without =", lines: ["text/plain; charset"], refused: true },
  { name: "a parameter with an empty value", lines: ["text/plain; charset="], refused: true },
  { name: "an empty value", lines: [""], refused: true },
  { name: "an empty type", lines: ["/plain"], refused: true },
  { name: "no subtype", lines: ["text"], refused: true },
  { name: "text after the media type", lines: ["text/plain charset=utf-8"], refused: true },
  { name: "a control character", lines: ["text/plain; charset=utf-8\u0001"], refused: true },
  { name: "a missing header (README: refused before the body is read)", lines: [], refused: true }
]

const errorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return undefined
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason?._tag === "Fail" ? reason.error : undefined
}

describe("Content-Type table through safeFetch (fake connector)", () => {
  for (const c of cases) {
    it(c.name, async () => {
      let read = false
      async function* body() { read = true; yield c.body ?? new TextEncoder().encode("PAYLOAD") }
      const connector = fakeConnector(() => ({ ...reply(200, body(), { "content-type": c.lines.join(", ") }), contentTypeLines: c.lines }))
      const effect = safeFetch("http://a.example/x", { accept: contentTypes.webPage, resolver, connector })
      if (c.refused) {
        const error = await errorOf(effect)
        expect(error).toBeInstanceOf(NetRefused)
        expect((error as NetRefused).rule).toBe("content-type")
        expect(read).toBe(false)
      } else {
        const res = await Effect.runPromise(effect)
        expect(res.contentType).toBe(c.type)
        expect(res.text()).toBe(c.text)
      }
    })
  }
  it("a single header value from a connector without field lines is read as one line", async () => {
    const res = await Effect.runPromise(safeFetch("http://a.example/x", {
      accept: contentTypes.webPage, resolver, connector: fakeConnector(() => reply(200, "ok", { "content-type": "text/plain; charset=utf-8" }))
    }))
    expect(res.contentType).toBe("text/plain")
    const refused = await errorOf(safeFetch("http://a.example/x", {
      accept: contentTypes.webPage, resolver, connector: fakeConnector(() => reply(200, "ok", { "content-type": "text/plain, application/octet-stream" }))
    }))
    expect(refused).toBeInstanceOf(NetRefused)
  })
})

describe("Content-Type lines through the real loopback connector", () => {
  const serve = async (lines: ReadonlyArray<string>) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, lines.map((l) => ["Content-Type", l] as [string, string]))
      res.end("PAYLOAD")
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    try {
      const port = (server.address() as AddressInfo).port
      return await errorOf(fetchOwnerConfiguredLan(`http://pretend.example:${port}/`, {
        accept: contentTypes.webPage, resolver: async () => ["192.168.0.1"], connector: (r) => nodeConnector({ ...r, address: "127.0.0.1" })
      }))
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())) }
  }
  for (const lines of [['text/plain; title="', "application/octet-stream"], ['text/plain; title="abc\\', 'x"'], ["text/plain", "text/plain"], ["application/octet-stream", "text/plain"]]) {
    it(`two lines ${JSON.stringify(lines)} are refused`, async () => {
      const error = await serve(lines)
      expect(error).toBeInstanceOf(NetRefused)
      expect((error as NetRefused).rule).toBe("content-type")
    })
  }
  it("one well-formed line passes", async () => {
    expect(await serve(["text/plain; charset=utf-8"])).toBeUndefined()
  })
})

describe("parseContentType", () => {
  it("returns the lower-cased type and the parameters, first of a name winning", () => {
    const r = parseContentType(['Text/HTML; Charset="UTF-8"; charset=x; Title="a\\"b"'])
    expect(r).toEqual({ type: "text/html", parameters: new Map([["charset", "UTF-8"], ["title", 'a"b']]) })
  })
  it("mediaTypeOf is a wrapper", () => {
    expect(mediaTypeOf("Text/HTML; charset=UTF-8")).toBe("text/html")
    expect(mediaTypeOf(undefined)).toBe("")
    expect(mediaTypeOf("text/plain, a/b")).toBe("")
  })
})
