// Review round 5 of the net package: each finding's case, failing on the code before the fix (finding 2 pins the README's narrowed
// promise instead).
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, References } from "effect"
import zlib from "node:zlib"
import { makeCachedJson } from "../src/CachedJson.ts"
import { NetFailure } from "../src/Errors.ts"
import { contentTypes, safeFetch, type ConnectRequest, type SafeResponse } from "../src/SafeFetch.ts"
import { bytes, chunks, fakeConnector, fakeResolver, reply } from "./helpers.ts"

const resolver = fakeResolver({ "a.example": ["8.8.8.8"] })
const response = (body: string): SafeResponse => ({
  url: "http://a.example/x", status: 200, headers: {}, body: bytes(body), redirects: [], text: () => body, encoding: "identity", contentType: "application/json"
})
/** `n` operations before `effect`, so that the runtime's yield (every 2048 operations by default) falls at a chosen point after it. */
const after = <A, E>(n: number, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    for (let k = 0; k < n; k++) yield* Effect.sync(() => undefined)
    return yield* effect
  })

describe("finding 1: a flight is published before its refresh can run, and its waiter is registered uninterruptibly", () => {
  // The reviewer's first sequence: a refresh that completes before the caller goes on must not leave its slot behind, or every later
  // miss reuses the finished answer whatever the TTL. The default runtime with every prefix that puts its yield around the fork
  // reproduces it (2042 operations did on the code before the fix); runtimes that yield after every few operations are checked too.
  const settledSlot = async (run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>) => {
    let n = 0
    const api = makeCachedJson({ fetch: () => Effect.sync(() => response(String(++n))) })
    const first = await run(api.getJson<number>("http://a.example/x", { ttlMs: 0 }))
    const second = await run(api.getJson<number>("http://a.example/x", { ttlMs: 0 }))
    return { first: first.value, second: second.value, fetches: n }
  }
  it("with a runtime that yields after every 1–8 operations", async () => {
    for (let ops = 1; ops <= 8; ops++) for (let prefix = 0; prefix < 8; prefix++) {
      const got = await settledSlot((e) => Effect.runPromise(after(prefix, e).pipe(Effect.provideService(References.MaxOpsBeforeYield, ops))))
      expect(got, `${ops} operations per slice, ${prefix} before`).toEqual({ first: 1, second: 2, fetches: 2 })
    }
  })
  it("with the default runtime and every prefix from 1980 to 2060 operations", async () => {
    for (let prefix = 1980; prefix <= 2060; prefix++) {
      const got = await settledSlot((e) => Effect.runPromise(after(prefix, e)))
      expect(got, `${prefix} before`).toEqual({ first: 1, second: 2, fetches: 2 })
    }
  })

  // The reviewer's second sequence: interrupting the only caller right after it was started cancels the refresh, also when the
  // runtime yields at the fork. The connector waits for its signal; it must not be started and left until the deadline.
  it("interrupting the only caller at the fork boundary cancels the refresh", async () => {
    const run = async (prefix: number, ops: number | undefined) => {
      const connector = fakeConnector((r: ConnectRequest) => new Promise((_, reject) => r.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })))
      const api = makeCachedJson({ fetch: (u, o) => safeFetch(u, { ...o, resolver, connector, timeoutMs: 20_000 }) })
      const program = after(prefix, api.getJson("http://a.example/x", { ttlMs: 0 }))
      const fiber = Effect.runFork(ops === undefined ? program : program.pipe(Effect.provideService(References.MaxOpsBeforeYield, ops)))
      fiber.interruptUnsafe()
      const exit = await Effect.runPromise(Fiber.await(fiber))
      expect(Exit.isFailure(exit)).toBe(true)
      // Give a detached refresh that escaped time to reach the connector.
      await new Promise((r) => setTimeout(r, 30))
      return connector.requests.map((r) => r.signal.aborted)
    }
    for (const prefix of [0, 1, 2, 3, 2040, 2042, 2044, 2046, 2047, 2048]) {
      const signals = await run(prefix, undefined)
      expect(signals.every((aborted) => aborted), `${prefix} before: ${signals}`).toBe(true)
    }
    for (let ops = 1; ops <= 6; ops++) for (let prefix = 0; prefix < 6; prefix++) {
      const signals = await run(prefix, ops)
      expect(signals.every((aborted) => aborted), `${ops} operations per slice, ${prefix} before: ${signals}`).toBe(true)
    }
  })
  it("a waiter that joins a running flight and leaves does not cancel it for the one that started it", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let n = 0
    const api = makeCachedJson({ fetch: () => Effect.promise(() => gate.then(() => response(String(++n)))) })
    const starter = Effect.runPromise(api.getJson<number>("http://a.example/x", { ttlMs: 0 }))
    const joiner = Effect.runFork(api.getJson<number>("http://a.example/x", { ttlMs: 0 }))
    await new Promise((r) => setTimeout(r, 5))
    joiner.interruptUnsafe()
    release()
    expect(await starter).toMatchObject({ value: 1, source: "network" })
    expect(n).toBe(1)
  })
})

describe("finding 2: after the last gzip member, bytes from a zero byte on are ignored (the README's narrowed promise)", () => {
  const gzip = new Uint8Array(zlib.gzipSync("hello"))
  const cat = (...parts: Array<Uint8Array>) => new Uint8Array(Buffer.concat(parts))
  const fetchGzip = (...parts: Array<Uint8Array>) =>
    safeFetch("http://a.example/", { accept: contentTypes.webPage, resolver, connector: fakeConnector(() => reply(200, chunks(...parts), { "content-encoding": "gzip" })) })
  const text = async (...parts: Array<Uint8Array>) => (await Effect.runPromise(fetchGzip(...parts))).text()
  const zero = new Uint8Array([0])
  const zeroAB = new Uint8Array([0, 65, 66])
  it("a zero byte alone, or a zero byte and other bytes, in the same chunk or a later one", async () => {
    expect(await text(cat(gzip, zero))).toBe("hello")
    expect(await text(cat(gzip, zeroAB))).toBe("hello")
    expect(await text(gzip, zero)).toBe("hello")
    expect(await text(gzip, zeroAB)).toBe("hello")
    expect(await text(gzip, zero, bytes("AB"))).toBe("hello")
    expect(await text(cat(gzip, gzip), zeroAB)).toBe("hellohello")
  })
  it("anything else after the last member that is not another member is still a NetFailure", async () => {
    const exit = await Effect.runPromiseExit(fetchGzip(gzip, bytes("AB")))
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((r) => r._tag === "Fail" && r.error instanceof NetFailure)).toBe(true)
    const same = await Effect.runPromiseExit(fetchGzip(cat(gzip, bytes("AB\u0000"))))
    expect(Exit.isFailure(same) && same.cause.reasons.some((r) => r._tag === "Fail" && r.error instanceof NetFailure)).toBe(true)
  })
  it("the decoded-size limit still applies to the members before the padding", async () => {
    const big = new Uint8Array(zlib.gzipSync("x".repeat(5000)))
    const exit = await Effect.runPromiseExit(safeFetch("http://a.example/", {
      accept: contentTypes.webPage, resolver, maxBytes: 1000, connector: fakeConnector(() => reply(200, chunks(big, zeroAB), { "content-encoding": "gzip" }))
    }))
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((r) => r._tag === "Fail" && r.error._tag === "NetTooLarge")).toBe(true)
  })
})
