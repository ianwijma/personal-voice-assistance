// WP-13a (docs/ASSISTANTS.md §4.1, §3.3): several assistants on the Claude subscription account, each conversation
// with its assistant's own model and options, the account's shared settings shared, and the `maxSessions` bound
// (`MAX_VOICE_SESSIONS` × the switched-on assistants on the account). No real subscription: the Agent SDK is the
// scripted fake of packages/agent-claude-code/test.
import { claudeSubscriptionAgentModule } from "@pva/agent-claude-code"
import type { Assistant, ServerMessage, ServerMessageOf, TraceInfo } from "@pva/protocol"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type FakeQuery, makeFakeSdk } from "../../../packages/agent-claude-code/test/fakeSdk.ts"
import type { LlmBuilder } from "../src/serve/Resources.ts"
import { SUBSCRIPTION_AGENT_ID, subscriptionAssistantOf, subscriptionSessionLimit } from "../src/subscription.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

type Json = Record<string, any>

/**
 * Alpha (Sonnet, high effort, the assistant's tools, a fresh session after 60 min) and Bravo (Opus, low effort, no
 * tools, never a fresh session), both on the Claude subscription, both on the browser defaults ("hey alpha" / "hey
 * bravo"); the agent module opted in and switched on.
 */
const dataDir = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "pva-subscription-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir: dir })
  await first.close()
  const path = join(dir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const llm = { ...base.llm, account: "claude-subscription", thinking: "off" }
  const alpha = {
    ...base,
    id: "alpha",
    rev: 0,
    name: "Alpha",
    prompt: "You are Alpha.",
    replyEarly: false,
    // A longest reply other than the stand-in's 1024: the subscription does not use it (the snapshot records 1024).
    llm: { ...llm, model: "claude-sonnet-5-5", effort: "high", maxTokens: 2048, useModules: true, freshSessionAfterMinutes: 60 }
  }
  const bravo = {
    ...base,
    id: "bravo",
    rev: 0,
    name: "Bravo",
    prompt: "You are Bravo.",
    replyEarly: false,
    llm: { ...llm, model: "claude-opus-5-5", effort: "low", useModules: false, freshSessionAfterMinutes: 0 }
  }
  file.assistants = { order: ["alpha", "bravo"], byId: { alpha, bravo } }
  file.modules = { ...file.modules, [SUBSCRIPTION_AGENT_ID]: { enabled: true, settings: { optIn: true } } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: "bravo", phrases: ["hey bravo"] }],
    withoutPhrase: { mode: "nobody" }
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dir
}

const start = async (env: Record<string, string> = {}) => {
  const fake = makeFakeSdk({ respond: (ctx) => {
    ctx.delta(`Claude heard: ${ctx.text.split("\n").at(-1)}`)
    ctx.result()
  } })
  server = await startTestServer({
    catalog: [claudeSubscriptionAgentModule({ sdk: fake.sdk, env: { PATH: "/usr/bin" } })],
    env,
    build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm((t) => `Stand-in: ${t}.`).llm }),
    dataDir: await dataDir()
  })
  const admin = await connect()
  await admin.admin(TEST_ADMIN_PASSWORD)
  await until("the agent module running", () => server!.handle.host.modules().find((m) => m.id === SUBSCRIPTION_AGENT_ID)?.state === "running")
  return { fake, admin }
}

const connect = async (deviceId?: string) => {
  const client = await ScriptedClient.connect({ url: server!.url, ...(deviceId !== undefined ? { deviceId } : {}) })
  clients.push(client)
  return client
}

const until = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 500 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

/** Type `text` to `assistantId`: the reply's text once the turn has ended. */
const typed = async (client: ScriptedClient, assistantId: string, text: string, id: string) => {
  const from = client.messages.length
  client.send({ type: "text.send", requestId: id, text, speak: false, assistantId })
  expect((await client.waitFor("result", (m) => m.requestId === id, { from })).ok).toBe(true)
  const begun = await client.waitFor("turn.start", (m) => m.assistantId === assistantId, { from, timeoutMs: 10_000 })
  const end = await client.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
  return client.messages
    .slice(from)
    .filter((m): m is ServerMessageOf<"assistant.text"> => m.type === "assistant.text" && m.turnId === end.turnId)
    .map((m) => m.text)
    .join("")
}

/** The Claude Code session (fake query) that received `text`. */
const queryOf = (queries: ReadonlyArray<FakeQuery>, text: string): FakeQuery => {
  const q = queries.find((x) => x.received.some((r) => r.endsWith(text)))
  if (q === undefined) throw new Error(`no session received ${text}`)
  return q
}
/** The model a session answers with now: launched with, or changed to (`setModel`). */
const modelOf = (q: FakeQuery): string | undefined =>
  q.retunes.flatMap((r) => ("model" in r ? [r.model] : [])).at(-1) ?? q.options.model
const effortOf = (q: FakeQuery): string | null | undefined =>
  q.retunes.flatMap((r) => ("effortLevel" in r ? [r.effortLevel] : [])).at(-1) ?? q.options.effort

const traces = (client: ScriptedClient): Array<TraceInfo> =>
  client.messages.flatMap((m: ServerMessage): Array<TraceInfo> => (m.type === "trace" ? [m.trace] : []))

const assistantOf = (id: string): Assistant => server!.handle.store.assistants().find((a) => a.id === id)!
const save = (assistant: Assistant) => Effect.runPromise(server!.handle.store.saveAssistantRecord(assistant))

describe("Claude subscription per assistant (WP-13a)", () => {
  it("pure: the bound is MAX_VOICE_SESSIONS × the switched-on assistants on the account; the options are the assistant's", () => {
    const a = (on: boolean, account: string) => ({ on, llm: { account } }) as Pick<Assistant, "on" | "llm">
    expect(subscriptionSessionLimit(4, [a(true, "claude-subscription"), a(true, "claude-subscription"), a(false, "claude-subscription"), a(true, "anthropic")])).toBe(8)
    expect(subscriptionSessionLimit(3, [])).toBe(3)
    const llm = { account: "claude-subscription", model: " ", effort: "medium", thinking: "adaptive", useModules: false, freshSessionAfterMinutes: 0 } as Assistant["llm"]
    expect(subscriptionAssistantOf({ llm, replyEarly: true }, 6)).toEqual({
      options: { model: "claude-haiku-5-5", effort: "medium", thinking: "adaptive", tools: false, sessionIdleMinutes: 0, maxSessions: 6 },
      replyEarly: true
    })
  })

  it("two assistants on the account answer from sessions with their own model and options; the traces say which", async () => {
    const { fake, admin } = await start()
    const page = await connect("device-desk")
    await page.hello()
    expect(await typed(page, "alpha", "hello alpha", "t1")).toBe("Claude heard: hello alpha")
    expect(await typed(page, "bravo", "hello bravo", "t2")).toBe("Claude heard: hello bravo")
    const qa = queryOf(fake.queries, "hello alpha")
    const qb = queryOf(fake.queries, "hello bravo")
    expect(qa).not.toBe(qb)
    expect([modelOf(qa), effortOf(qa)]).toEqual(["claude-sonnet-5-5", "high"])
    expect([modelOf(qb), effortOf(qb)]).toEqual(["claude-opus-5-5", "low"])
    // Each with its own prompt: Alpha's first session was the warm spare (its prompt in the first message), Bravo's
    // was launched with its prompt. Bravo has no tools (useModules off).
    expect(qa.received[0]).toContain("You are Alpha.")
    expect(qb.options.systemPrompt ?? qb.received[0]).toContain("You are Bravo.")
    expect(qb.registered).toEqual([])
    await until("two traces", () => traces(admin).length === 2)
    // No token limit is passed to Claude Code: the snapshot records the stand-in's 1024, not Alpha's saved 2048.
    expect(assistantOf("alpha").llm.maxTokens).toBe(2048)
    expect(traces(admin).map((t) => [t.assistant?.id, t.config?.llm])).toEqual([
      ["alpha", { account: "claude-subscription", model: "claude-sonnet-5-5", effort: "high", thinking: "off", maxTokens: 1024 }],
      ["bravo", { account: "claude-subscription", model: "claude-opus-5-5", effort: "low", thinking: "off", maxTokens: 1024 }]
    ])
    expect(traces(admin)[1]!.config?.tools).toBe(0)
  })

  it("an assistant's model change applies at its next turn, on its own session; the other assistant is not touched", async () => {
    const { fake, admin } = await start()
    const page = await connect("device-desk")
    await page.hello()
    await typed(page, "alpha", "one", "t1")
    await typed(page, "bravo", "two", "t2")
    const qa = queryOf(fake.queries, "one")
    const qb = queryOf(fake.queries, "two")
    const bravoRetunes = qb.retunes.length
    const sessions = fake.queries.length
    await save({ ...assistantOf("alpha"), llm: { ...assistantOf("alpha").llm, model: "claude-haiku-5-5" } })
    await typed(page, "alpha", "one again", "t3")
    await typed(page, "bravo", "two again", "t4")
    // Alpha's session answers with the new model from this turn on (no new Claude Code process); Bravo's is as it was.
    // Each turn's text comes after its per-turn context (P5: the device line), as for every agent turn.
    expect(qa.received.at(-1)).toMatch(/<\/context>\n\none again$/)
    expect(modelOf(qa)).toBe("claude-haiku-5-5")
    expect(qb.received.at(-1)).toMatch(/<\/context>\n\ntwo again$/)
    expect(qb.retunes).toHaveLength(bravoRetunes)
    expect(modelOf(qb)).toBe("claude-opus-5-5")
    expect(fake.queries).toHaveLength(sessions)
    await until("four traces", () => traces(admin).length === 4)
    expect(traces(admin).map((t) => t.config?.llm.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-opus-5-5"])
  })

  it("the account's shared settings are shared: a changed Claude Code program is used by both assistants' sessions", async () => {
    const { fake, admin } = await start()
    const page = await connect("device-desk")
    await page.hello()
    await typed(page, "alpha", "first", "t1")
    await typed(page, "bravo", "second", "t2")
    expect(fake.queries.every((q) => q.options.pathToClaudeCodeExecutable === undefined)).toBe(true)
    const before = fake.queries.length
    const from = admin.messages.length
    admin.send({ type: "module.configure", requestId: "c1", moduleId: SUBSCRIPTION_AGENT_ID, patch: { values: { claudePath: "/opt/claude/bin/claude" }, secrets: {} } })
    expect((await admin.waitFor("result", (m) => m.requestId === "c1", { from })).ok).toBe(true)
    await until("the agent module running again", () => server!.handle.host.modules().find((m) => m.id === SUBSCRIPTION_AGENT_ID)?.state === "running")
    await typed(page, "alpha", "third", "t3")
    await typed(page, "bravo", "fourth", "t4")
    const qa = queryOf(fake.queries, "third")
    const qb = queryOf(fake.queries, "fourth")
    expect(fake.queries.indexOf(qa)).toBeGreaterThanOrEqual(before)
    expect(fake.queries.indexOf(qb)).toBeGreaterThanOrEqual(before)
    expect([qa.options.pathToClaudeCodeExecutable, qb.options.pathToClaudeCodeExecutable]).toEqual(["/opt/claude/bin/claude", "/opt/claude/bin/claude"])
    // Each still with its own model.
    expect([modelOf(qa), modelOf(qb)]).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"])
    // The old agent's sessions get nothing more (the module host closes the old instance after its grace period).
    expect(fake.queries.slice(0, before).map((q) => q.received.length)).toEqual([1, 1])
  })

  it("a turn while a changed account is still being built is snapshotted as the binding that answers it, both ways", async () => {
    // Gated builds: the Claude API instance, and (once re-armed) the subscription's stand-in, are ready when the test says.
    let openApi = () => {}
    const api = new Promise<void>((resolve) => {
      openApi = () => resolve()
    })
    let openStandIn = () => {}
    let standIn: Promise<void> = Promise.resolve()
    const apiLlm = scriptedLlm((t) => `API: ${t}.`).llm
    const standInLlm = scriptedLlm((t) => `Stand-in: ${t}.`).llm
    const buildLlm: LlmBuilder = (spec) =>
      spec.account === "anthropic" ? Effect.as(Effect.promise(() => api), apiLlm) : Effect.as(Effect.promise(() => standIn), standInLlm)
    // Alpha on the subscription with Opus, high effort, adaptive thinking, no tools for Claude (useModules off), and the
    // greeter module (one tool for a single model). Bravo is off, so nothing else holds the subscription's stand-in.
    const dir = await dataDir()
    const path = join(dir, "settings.json")
    const file = JSON.parse(readFileSync(path, "utf8")) as Json
    file.assistants.byId.alpha.llm = { ...file.assistants.byId.alpha.llm, model: "claude-opus-5-5", effort: "high", thinking: "adaptive", maxTokens: 2048, useModules: false }
    file.assistants.byId.alpha.modules = { greeter: { on: true, offTools: [] } }
    file.assistants.byId.bravo.on = false
    file.modules = { ...file.modules, greeter: { enabled: true, settings: { greeting: "hello" } } }
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
    const fake = makeFakeSdk({ respond: (ctx) => {
      ctx.delta(`Claude heard: ${ctx.text.split("\n").at(-1)}`)
      ctx.result()
    } })
    server = await startTestServer({
      catalog: [claudeSubscriptionAgentModule({ sdk: fake.sdk, env: { PATH: "/usr/bin" } }), greeterModule],
      build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm((t) => `Build: ${t}.`).llm }),
      buildLlm,
      resourceGraceMs: 100,
      dataDir: dir
    })
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    await until("the agent module running", () => server!.handle.host.modules().find((m) => m.id === SUBSCRIPTION_AGENT_ID)?.state === "running")
    const page = await connect("device-desk")
    await page.hello()
    const llmStatus = () => server!.handle.resources.status().filter((r) => r.kind === "llm")
    // The API uses the saved longest reply; the subscription none (the stand-in's 1024 is recorded).
    const onSubscription = { account: "claude-subscription", model: "claude-opus-5-5", effort: "high", thinking: "adaptive", maxTokens: 1024 }
    const onApi = { account: "anthropic", model: "claude-opus-5-5", effort: "high", thinking: "adaptive", maxTokens: 2048 }

    expect(await typed(page, "alpha", "one", "t1")).toBe("Claude heard: one")
    // To the Claude API, keeping the fields, with warm-up: while that instance is built the subscription binding answers.
    await save({ ...assistantOf("alpha"), llm: { ...assistantOf("alpha").llm, account: "anthropic", warmUp: true } })
    await until("the API instance starting", () => llmStatus().some((r) => r.key.startsWith("anthropic|") && r.state === "starting"))
    expect(server!.handle.resources.keyFor("alpha")).toBe("claude-subscription")
    expect(await typed(page, "alpha", "two", "t2")).toBe("Claude heard: two")
    expect(modelOf(queryOf(fake.queries, "two"))).toBe("claude-opus-5-5")
    openApi()
    await until("Alpha on the API", () => server!.handle.resources.keyFor("alpha")?.startsWith("anthropic|") === true)
    expect(await typed(page, "alpha", "three", "t3")).toBe("API: three.")

    // And back: while the subscription's stand-in (released meanwhile) is built again, the API binding answers.
    await until("the stand-in released", () => !llmStatus().some((r) => r.key === "claude-subscription"))
    standIn = new Promise<void>((resolve) => {
      openStandIn = () => resolve()
    })
    await save({ ...assistantOf("alpha"), llm: { ...assistantOf("alpha").llm, account: "claude-subscription" } })
    await until("the stand-in starting", () => llmStatus().some((r) => r.key === "claude-subscription" && r.state === "starting"))
    expect(server!.handle.resources.keyFor("alpha")?.startsWith("anthropic|")).toBe(true)
    expect(await typed(page, "alpha", "four", "t4")).toBe("API: four.")
    openStandIn()
    await until("Alpha on the subscription", () => server!.handle.resources.keyFor("alpha") === "claude-subscription")
    expect(await typed(page, "alpha", "five", "t5")).toBe("Claude heard: five")

    await until("five traces", () => traces(admin).length === 5)
    expect(traces(admin).map((t) => [t.config?.llm, t.config?.tools])).toEqual([
      [onSubscription, 0],
      [onSubscription, 0],
      [onApi, 1],
      [onApi, 1],
      [onSubscription, 0]
    ])
  })

  it("maxSessions: MAX_VOICE_SESSIONS × the switched-on assistants; past the bound the least recently used session closes", async () => {
    const { fake } = await start({ MAX_VOICE_SESSIONS: "1" })
    const page = await connect("device-desk")
    await page.hello()
    // One device, two assistants on the account: a bound of 2, both sessions open.
    await typed(page, "alpha", "one", "t1")
    await typed(page, "bravo", "two", "t2")
    const qa = queryOf(fake.queries, "one")
    const qb = queryOf(fake.queries, "two")
    expect([qa.closed, qb.closed]).toEqual([false, false])
    // Bravo is switched off: the bound is 1. Alpha starts a new conversation and needs a session: Bravo's, the least
    // recently used, is closed for it.
    await save({ ...assistantOf("bravo"), on: false })
    const from = page.messages.length
    page.send({ type: "conversation.new", requestId: "n1", assistantId: "alpha" })
    await page.waitFor("conversation", (m) => m.assistantId === "alpha", { from })
    await until("Alpha's old session closed", () => qa.closed)
    await typed(page, "alpha", "fresh start", "t3")
    await until("Bravo's session closed", () => qb.closed)
    expect(fake.queries.filter((q) => !q.closed)).toHaveLength(1)
    expect(modelOf(queryOf(fake.queries, "fresh start"))).toBe("claude-sonnet-5-5")
  })
})
