/**
 * The "Proxy for Claude Code" secret never leaks (seventh review, unconfirmed point): `safeErrorText` dropped only
 * the SDK's stderr tail and shortened the rest, so a proxy URL (with its user name and password) anywhere else in an
 * SDK error reached the owner's status line and the turn's error. Now every error text, status line and cause the
 * adapter produces is redacted with the proxy value and its user-info, user name and password on their own
 * (`proxySecrets`, `src/redact.ts`). Planted here in an SDK error's message, its cause, and a thrown defect, in plain
 * and percent-encoded forms, at module start and in a turn; checked in the whole serialised error (cause chain,
 * stacks, enumerable fields) with `test/leaks.ts`, the helpers every adapter shares.
 */
import { describe, expect, it } from "@effect/vitest"
import { type AgentEvent, type AgentTurnInput, makeTool, makeToolRegistry, ToolError, type Trace } from "@pva/core"
import { Effect, Exit, Schema, Stream } from "effect"
import { readFileSync } from "node:fs"
import { claudeSubscriptionAgentModule, makeClaudeAgent } from "../src/index.ts"
import { proxySecrets, safeErrorText } from "../src/session.ts"
import { makeFakeSdk } from "./fakeSdk.ts"
import { ADDRESS_SECRETS, KEYS, leaksOf, loadedError, partsOf, serialise } from "./leaks.ts"

/** Two proxies: plain credentials, and a password whose punctuation changes under every encoding (percent-encoded in the URL). */
const PROXIES = [
  { user: ADDRESS_SECRETS.user, password: ADDRESS_SECRETS.password, url: `http://${ADDRESS_SECRETS.user}:${ADDRESS_SECRETS.password}@proxy.example:8080` },
  { user: "bob", password: KEYS[0], url: `http://bob:${encodeURIComponent(KEYS[0])}@proxy.example:3128/` }
] as const

/** Everything that must not appear, in any form `leaksOf` knows (as is, percent-encoded, JSON-escaped, base64). */
const leaks = (proxy: (typeof PROXIES)[number], text: string): ReadonlyArray<string> => {
  const userInfo = proxy.url.slice(proxy.url.indexOf("//") + 2, proxy.url.indexOf("@"))
  return [proxy.url, userInfo, proxy.password, encodeURIComponent(proxy.password)].flatMap((secret) => leaksOf(secret, text))
}

/** The proxy as an upstream could echo it: plain, percent-encoded, and in a sentence. */
const plantedIn = (url: string) => `proxy ${url} refused (CONNECT ${encodeURIComponent(url)}) via ${url.replace("http://", "")}`

const settings = (proxy: string) => ({
  optIn: true,
  model: "claude-haiku-5-5",
  systemPrompt: "",
  speculate: false,
  tools: true,
  sessionIdleMinutes: 60,
  claudePath: "",
  debugLogs: false,
  proxy
})

const startModule = (sdk: ReturnType<typeof makeFakeSdk>["sdk"], proxy: string) =>
  Effect.gen(function*() {
    const statuses: Array<string> = []
    const module = claudeSubscriptionAgentModule({ sdk, env: {} })
    const exit = yield* Effect.exit(Effect.scoped(module.start({ settings: settings(proxy), setStatus: (s) => void (s !== undefined && statuses.push(s.text)) })))
    expect(Exit.isFailure(exit)).toBe(true)
    return `${serialise(exit)}\n${String(exit)}\n${statuses.join("\n")}`
  })

const input = (): AgentTurnInput => {
  const trace: Trace = { id: 1, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] }
  return {
    turnId: 1,
    text: "Hello",
    utterance: "Hey Claude, hello",
    source: "voice",
    spoken: true,
    routedBy: "trigger",
    history: [],
    system: "Speak briefly.",
    context: undefined,
    tools: makeToolRegistry([]),
    actions: [],
    deciders: new Map(),
    promoted: Effect.void,
    speculative: false,
    mark: () => undefined,
    trace,
    maxToolRounds: 4
  }
}

/** A turn that fails as the fake SDK is told to; the whole serialised error. */
const failedTurn = (fake: ReturnType<typeof makeFakeSdk>, proxy: string) =>
  Effect.gen(function*() {
    const agent = yield* Effect.promise(() =>
      makeClaudeAgent({ model: "claude-haiku-5-5", tools: true, speculate: false, sessionIdleMinutes: 60, env: { PATH: "/usr/bin" }, proxy, sdk: fake.sdk })
    )
    const error = yield* Effect.flip(Stream.runCollect(agent.turn(input()) as Stream.Stream<AgentEvent, unknown>))
    agent.shutdown()
    return serialise(error)
  })

describe.each(PROXIES)("the proxy secret never leaks ($url)", (proxy) => {
  it.live("module start: an SDK error carrying it in its message, name, fields and cause", () =>
    Effect.gen(function*() {
      const text = yield* startModule(makeFakeSdk({ initError: loadedError(proxy.url) }).sdk, proxy.url)
      expect(text).toMatch(/Claude Code could not start/)
      expect(leaks(proxy, text)).toEqual([])
    }))

  it.live("module start: an SDK error with it in every form, before the stderr tail", () =>
    Effect.gen(function*() {
      const error = new Error(`spawn failed: ${plantedIn(proxy.url)}. stderr: ${proxy.url}`, { cause: new Error(plantedIn(proxy.url)) })
      const text = yield* startModule(makeFakeSdk({ initError: error }).sdk, proxy.url)
      expect(text).toMatch(/spawn failed: proxy \[redacted\]/)
      expect(leaks(proxy, text)).toEqual([])
    }))

  it.live("module start: a thrown defect that is not an Error (an object, a string)", () =>
    Effect.gen(function*() {
      for (const thrown of [{ proxy: proxy.url, encoded: encodeURIComponent(proxy.url) }, plantedIn(proxy.url)]) {
        const fake = makeFakeSdk()
        const sdk = { ...fake.sdk, query: () => { throw thrown } }
        const text = yield* startModule(sdk, proxy.url)
        expect(leaks(proxy, text)).toEqual([])
      }
    }))

  it.live("a turn: the process dies with an error carrying it in its message, name, fields and cause", () =>
    Effect.gen(function*() {
      const text = yield* failedTurn(makeFakeSdk({ respond: (ctx) => ctx.query.crash(loadedError(proxy.url)) }), proxy.url)
      expect(text).toMatch(/AgentError/)
      expect(leaks(proxy, text)).toEqual([])
    }))

  it.live("a turn: percent-encoded and straddling the 200-character cut (redacted before it is shortened)", () =>
    Effect.gen(function*() {
      for (const at of [0, 60, 120, 150, 170, 180, 190, 199]) {
        const message = `${"y".repeat(at)}${encodeURIComponent(proxy.url)} ${proxy.url}`
        const text = yield* failedTurn(makeFakeSdk({ respond: (ctx) => ctx.query.crash(message) }), proxy.url)
        expect(leaks(proxy, text)).toEqual([])
        expect(partsOf(proxy.password, text, 6)).toEqual([])
      }
    }))

  it.live("a turn: a failed result whose text carries it, also across the cut", () =>
    Effect.gen(function*() {
      for (const at of [0, 100, 150, 170, 185]) {
        const fake = makeFakeSdk({ respond: (ctx) => ctx.result("success", true, `${"r".repeat(at)}${proxy.url}`) })
        const text = yield* failedTurn(fake, proxy.url)
        expect(leaks(proxy, text)).toEqual([])
        expect(partsOf(proxy.password, text, 6)).toEqual([])
      }
    }))

  it("safeErrorText: redacted with the proxy's secrets, the user-info and password on their own too", () => {
    const secrets = proxySecrets(proxy.url)
    const userInfo = proxy.url.slice(proxy.url.indexOf("//") + 2, proxy.url.indexOf("@"))
    const text = safeErrorText(new Error(`${plantedIn(proxy.url)} user-info ${userInfo} password ${proxy.password} ${encodeURIComponent(proxy.password)}`), secrets)
    expect(leaks(proxy, text)).toEqual([])
  })
})

describe.each(PROXIES)("a tool's error result never carries the proxy secret to the SDK or the event (after the final review; $url)", (proxy) => {
  /** One tool that fails with the proxy in its message (plain and percent-encoded), one that succeeds with the same text. */
  const toolInput = (): AgentTurnInput => ({
    ...input(),
    tools: makeToolRegistry([{
      name: "test",
      tools: [
        makeTool({ name: "fetch_page", description: "Fetch", parameters: Schema.Struct({}), execute: () => Effect.fail(new ToolError({ message: plantedIn(proxy.url) })) }),
        makeTool({ name: "echo", description: "Echo", parameters: Schema.Struct({}), execute: () => Effect.succeed(plantedIn(proxy.url)) })
      ]
    }])
  })

  it.live("the error result is redacted in the ToolFinished event and in what the SDK receives; a successful result is untouched", () =>
    Effect.gen(function*() {
      const handed: Array<{ content: string; isError: boolean }> = []
      const fake = makeFakeSdk({
        respond: async (ctx) => {
          handed.push(await ctx.callTool("fetch_page", {}))
          handed.push(await ctx.callTool("echo", {}))
          ctx.result()
        }
      })
      const agent = yield* Effect.promise(() =>
        makeClaudeAgent({ model: "claude-haiku-5-5", tools: true, speculate: false, sessionIdleMinutes: 60, env: { PATH: "/usr/bin" }, proxy: proxy.url, sdk: fake.sdk })
      )
      const events = Array.from(yield* Stream.runCollect(agent.turn(toolInput())))
      agent.shutdown()
      const finished = events.filter((e): e is Extract<AgentEvent, { _tag: "ToolFinished" }> => e._tag === "ToolFinished")
      expect(finished.map((e) => [e.result.name, e.result.isError])).toEqual([["fetch_page", true], ["echo", false]])
      expect(handed.map((h) => h.isError)).toEqual([true, false])
      // The error: redacted in both places.
      expect(finished[0]!.result.content).toMatch(/^proxy \[redacted\] refused/)
      expect(leaks(proxy, finished[0]!.result.content)).toEqual([])
      expect(leaks(proxy, handed[0]!.content)).toEqual([])
      expect(handed[0]!.content).toBe(finished[0]!.result.content)
      // A successful result is content, not a diagnostic: passed through unchanged.
      expect(finished[1]!.result.content).toBe(plantedIn(proxy.url))
      expect(handed[1]!.content).toBe(plantedIn(proxy.url))
    }))
})

describe("the redaction helpers are the shared ones", () => {
  it("src/redact.ts and test/leaks.ts are identical to the other adapters' copies", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
    expect(read("../src/redact.ts")).toBe(read("../../llm-openai-compatible/src/redact.ts"))
    expect(read("./leaks.ts")).toBe(read("../../llm-openai-compatible/test/leaks.ts"))
  })
})
