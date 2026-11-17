// LLM_PROVIDER=claude-subscription: the claude-subscription agent module answers through the agent conversation;
// while it is not running the offline stand-in answers with a notice. No real subscription: the Agent SDK is the
// scripted fake from packages/agent-claude-code/test.
import { assert, it as effectIt } from "@effect/vitest"
import { claudeSubscriptionAgentModule } from "@pva/agent-claude-code"
import { Conversation, makeToolRegistry, TurnTrace } from "@pva/core"
import { agentText, makeScriptedAgent } from "@pva/core/testing"
import type { ServerMessageOf } from "@pva/protocol"
import { Effect, Layer, Stream } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeFakeSdk } from "../../../packages/agent-claude-code/test/fakeSdk.ts"
import { FakeLlm } from "../src/FakeLlm.ts"
import { makeSubscriptionAgents, OFFLINE_AGENT_ID, SUBSCRIPTION_AGENT_ID, subscriptionNotice } from "../src/subscription.ts"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, type TestServer, TEST_ADMIN_PASSWORD } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 20_000 })

const OFF = "Claude subscription is off — switch it on in Settings, Language model."

describe("claude-subscription agent set (pure)", () => {
  let running = false
  const claude = makeScriptedAgent({ id: SUBSCRIPTION_AGENT_ID, name: "Claude subscription", kind: "harness" }, [[agentText("Hi from Claude.")]])
  const toAgents = makeSubscriptionAgents({
    fallbackLlm: FakeLlm.make({ tokensPerSecond: 0 }),
    agents: () => (running ? new Map([[SUBSCRIPTION_AGENT_ID, claude.agent]]) : new Map()),
    module: () => undefined
  })
  const ConversationLive = Conversation.layerWithAgents({
    setup: Effect.sync(() => toAgents({ system: "test", registry: makeToolRegistry([]) }))
  }).pipe(Layer.provide(TurnTrace.layer()))

  effectIt.live("module off: the stand-in answers after the notice; running (read per turn): the agent gets the text", () =>
    Effect.gen(function*() {
      const conversation = yield* Conversation
      const off = (yield* Stream.runCollect(conversation.textTurn("hello"))).join("")
      assert.strictEqual(off, `${OFF}\nYou said: hello`)
      running = true
      const on = (yield* Stream.runCollect(conversation.textTurn("what's a goldfish name"))).join("")
      assert.strictEqual(on, "Hi from Claude.")
      assert.strictEqual(claude.probe.inputs[0]!.text, "what's a goldfish name")
      const history = yield* conversation.history
      assert.deepStrictEqual(
        history.filter((m) => m.role === "assistant").map((m) => (m as { agentId?: string }).agentId),
        [OFFLINE_AGENT_ID, SUBSCRIPTION_AGENT_ID]
      )
    }).pipe(Effect.provide(ConversationLive)))

  it("the notice says why", () => {
    const info = (enabled: boolean, state: "disabled" | "starting" | "running" | "error") =>
      ({ id: SUBSCRIPTION_AGENT_ID, enabled, state }) as never
    expect(subscriptionNotice(undefined)).toBe(OFF)
    expect(subscriptionNotice(info(false, "disabled"))).toBe(OFF)
    expect(subscriptionNotice(info(true, "starting"))).toMatch(/still starting/)
    expect(subscriptionNotice(info(true, "error"))).toMatch(/could not start — see Settings, Language model/)
  })
})

describe("serve: LLM_PROVIDER=claude-subscription", () => {
  let server: TestServer | undefined
  const clients: Array<ScriptedClient> = []
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close()
    await server?.close()
    server = undefined
  })

  const reply = async (client: ScriptedClient, text: string, id: string) => {
    const from = client.messages.length
    client.send({ type: "text.send", requestId: id, text, speak: false })
    expect((await client.waitFor("result", (m) => m.requestId === id, { from })).ok).toBe(true)
    const end = await client.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
    return client.messages
      .slice(from)
      .filter((m): m is ServerMessageOf<"assistant.text"> => m.type === "assistant.text" && m.turnId === end.turnId)
      .map((m) => m.text)
      .join("")
  }

  it("off → the stand-in answers with the notice; switched on (no reload) → Claude answers; the engine line shows the model", async () => {
    const fake = makeFakeSdk({ respond: (ctx) => {
      ctx.delta(`Claude heard: ${ctx.text.split("\n").at(-1)}`)
      ctx.result()
    } })
    const stt = controlledStt()
    const llm = scriptedLlm((t) => `You said: ${t}.`)
    server = await startTestServer({
      catalog: [claudeSubscriptionAgentModule({ sdk: fake.sdk, env: { PATH: "/usr/bin" } })],
      // The migrated assistant's account (an install started from `.env`).
      env: { LLM_PROVIDER: "claude-subscription" },
      build: fakeBuild({
        stt: stt.stt,
        llm: llm.llm,
        engines: [{ stage: "llm", provider: "claude-subscription", detail: "Claude Code login", location: "hosted" }]
      })
    })
    const client = await ScriptedClient.connect({ url: server.url })
    clients.push(client)
    const welcome = await client.admin(TEST_ADMIN_PASSWORD)
    expect(welcome.snapshot.engine.engines[0]).toEqual({
      stage: "llm",
      provider: "claude-subscription",
      detail: "claude-haiku-5-5 · module off: the offline stand-in answers",
      location: "hosted"
    })
    expect(welcome.snapshot.modules.find((m) => m.id === SUBSCRIPTION_AGENT_ID)).toMatchObject({ enabled: false, protected: true })
    // Typed on voice pages of two devices (admin connections have no voice session since protocol 6).
    const voice = await ScriptedClient.connect({ url: server.url, deviceId: "device-a" })
    clients.push(voice)
    await voice.hello()

    const off = await reply(voice, "what time is it", "t1")
    expect(off).toBe(`${OFF}\nYou said: what time is it.`)
    expect(fake.queries).toHaveLength(0)

    // Switch the module on from the UI: opt in, then enable. No engine reload.
    let from = client.messages.length
    client.send({ type: "module.configure", requestId: "c1", moduleId: SUBSCRIPTION_AGENT_ID, patch: { values: { optIn: true }, secrets: {} } })
    expect((await client.waitFor("result", (m) => m.requestId === "c1", { from })).ok).toBe(true)
    from = client.messages.length
    client.send({ type: "module.enable", requestId: "e1", moduleId: SUBSCRIPTION_AGENT_ID })
    expect((await client.waitFor("result", (m) => m.requestId === "e1", { from })).ok).toBe(true)
    const engine = await client.waitFor("engine", (m) => m.engine.engines[0]?.detail === "claude-haiku-5-5", { from: 0 })
    expect(engine.engine.engines[0]).toMatchObject({ provider: "claude-subscription", location: "hosted" })

    const on = await reply(voice, "tell me a joke", "t2")
    expect(on).toBe("Claude heard: tell me a joke")
    expect(fake.queries).toHaveLength(1)
    expect(fake.queries[0]!.received.at(-1)).toContain("tell me a joke")
    // The harness got only allowlisted variables.
    expect(Object.keys(fake.queries[0]!.options.env ?? {}).sort()).toEqual(["CLAUDE_AGENT_SDK_CLIENT_APP", "ENABLE_CLAUDEAI_MCP_SERVERS", "PATH"])
    expect(llm.requests).toHaveLength(1) // the stand-in was used once, for the first turn only

    // A second device at the same time: its own conversation, its own Claude Code session, the same login.
    const other = await ScriptedClient.connect({ url: server.url, deviceId: "device-b" })
    clients.push(other)
    await other.hello()
    const [onA, onB] = await Promise.all([reply(voice, "and another", "t2a"), reply(other, "hello from b", "t2b")])
    expect(onA).toBe("Claude heard: and another")
    expect(onB).toBe("Claude heard: hello from b")
    expect(fake.queries).toHaveLength(2)
    expect(fake.queries[1]!.received.join("\n")).not.toContain("tell me a joke")

    // Off again: the next turn falls back, without a reload.
    from = client.messages.length
    client.send({ type: "module.disable", requestId: "d1", moduleId: SUBSCRIPTION_AGENT_ID })
    expect((await client.waitFor("result", (m) => m.requestId === "d1", { from })).ok).toBe(true)
    expect(await reply(voice, "still there", "t3")).toBe(`${OFF}\nYou said: still there.`)
  })
})

