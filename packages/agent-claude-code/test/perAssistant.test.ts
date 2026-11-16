// WP-13a (docs/ASSISTANTS.md §4.1): several assistants on the one Claude subscription account, each conversation
// with its assistant's own model and options. Fake SDK only: no Claude Code process is started.
import { describe, expect, it } from "@effect/vitest"
import { type Agent, type AgentEvent, type AgentTurnInput, makeTool, makeToolRegistry, type Message, type Trace } from "@pva/core"
import { Effect, Fiber, Schema, Stream } from "effect"
import { type ClaudeConversationOptions, conversationOptionsOf, launchKeyOf, makeClaudeAgent, withConversationOptions } from "../src/index.ts"
import { makeFakeSdk } from "./fakeSdk.ts"

const lightsTool = makeTool({
  name: "lights_on",
  description: "Turn lights on",
  parameters: Schema.Struct({ room: Schema.String }),
  execute: ({ room }) => Effect.succeed(`${room} lights on`)
})

const input = (conversationId: string, text: string, history: ReadonlyArray<Message> = []): AgentTurnInput => {
  const trace: Trace = { id: 1, mode: "text", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] }
  return {
    turnId: 1,
    text,
    utterance: text,
    conversationId,
    source: "text",
    spoken: false,
    routedBy: "default",
    history,
    system: "Speak briefly.",
    context: undefined,
    tools: makeToolRegistry([{ name: "test", tools: [lightsTool] }]),
    actions: [],
    deciders: new Map(),
    promoted: Effect.void,
    speculative: false,
    mark: () => {},
    trace,
    maxToolRounds: 4
  }
}

const collect = (stream: Stream.Stream<AgentEvent, unknown>) => Effect.map(Stream.runCollect(stream), (c) => Array.from(c))

const moduleSettings = { model: "claude-haiku-5-5", tools: true, speculate: false, sessionIdleMinutes: 60, env: { PATH: "/usr/bin" } }

const alpha: ClaudeConversationOptions = { model: "claude-sonnet-5-5", effort: "high", thinking: "adaptive", tools: true, sessionIdleMinutes: 60 }
const bravo: ClaudeConversationOptions = { model: "claude-opus-5-5", effort: "low", thinking: "off", tools: false, sessionIdleMinutes: 0 }

/** The agent as the app sees it (an `Agent` from the module host), answering with one assistant's options. */
const asAgent = (handle: Awaited<ReturnType<typeof makeClaudeAgent>>): Agent => ({
  id: "claude-subscription",
  name: "Claude subscription",
  kind: "harness",
  speculate: false,
  firstEventTimeoutMs: 8000,
  turn: handle.turn,
  endConversation: handle.endConversation
})

describe("Claude subscription per assistant (WP-13a)", () => {
  it.live("two assistants with different models open sessions with their own model, effort, thinking and tools", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const handle = yield* Effect.promise(() => makeClaudeAgent({ ...moduleSettings, sdk: fake.sdk }))
      const agent = asAgent(handle)
      yield* collect(withConversationOptions(agent, bravo).turn(input("desk/bravo", "Hi Bravo")))
      yield* collect(withConversationOptions(agent, alpha).turn(input("desk/alpha", "Hi Alpha")))
      const qa = fake.queries.find((q) => q.received.some((r) => r.endsWith("Hi Alpha")))!
      const qb = fake.queries.find((q) => q.received.some((r) => r.endsWith("Hi Bravo")))!
      expect(qa).not.toBe(qb)
      // Bravo took the warm spare (launched with the module's model, no effort, no thinking), retuned before its first
      // message: no process start on its first turn.
      expect(qb).toBe(fake.queries[0])
      expect(qb.options).toMatchObject({ model: "claude-haiku-5-5", thinking: { type: "disabled" } })
      expect(qb.retunes).toEqual([{ model: "claude-opus-5-5" }, { effortLevel: "low" }])
      expect(handle.session("desk/bravo")!.launch).toBe("claude-opus-5-5|low|off")
      // Alpha (adaptive thinking, which a running session cannot change to) was launched with its own settings.
      expect(qa.options).toMatchObject({ model: "claude-sonnet-5-5", effort: "high", thinking: { type: "adaptive" } })
      expect(qa.retunes).toEqual([])
      expect(handle.session("desk/alpha")!.launch).toBe("claude-sonnet-5-5|high|adaptive")
      // Alpha may use the tools; Bravo (useModules off) gets none.
      expect(Object.keys(qa.options.mcpServers ?? {})).toEqual(["assistant"])
      expect(qb.registered).toEqual([])
      handle.shutdown()
    }))

  it.live("a turn without options uses the module's settings and takes the warm spare as it is", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const handle = yield* Effect.promise(() => makeClaudeAgent({ ...moduleSettings, sdk: fake.sdk }))
      yield* collect(handle.turn(input("c1", "Hello")))
      expect(fake.queries).toHaveLength(1)
      expect(fake.queries[0]!.options.model).toBe("claude-haiku-5-5")
      expect(fake.queries[0]!.options).not.toHaveProperty("effort")
      expect(fake.queries[0]!.retunes).toEqual([])
      expect(conversationOptionsOf(input("c1", "x"))).toBeUndefined()
      handle.shutdown()
    }))

  it.live("an assistant's model or effort change applies from its next turn on its own session; the other's is untouched", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const handle = yield* Effect.promise(() => makeClaudeAgent({ ...moduleSettings, sdk: fake.sdk }))
      const agent = asAgent(handle)
      yield* collect(withConversationOptions(agent, alpha).turn(input("a", "One")))
      yield* collect(withConversationOptions(agent, bravo).turn(input("b", "Two")))
      const a = handle.session("a")!
      const b = handle.session("b")!
      const qa = fake.queries.find((q) => q.received.some((r) => r.endsWith("One")))!
      const qb = fake.queries.find((q) => q.received.some((r) => r.endsWith("Two")))!
      const bRetunes = qb.retunes.length
      // Alpha's model and effort change between turns: the same session answers with them from the next message on.
      yield* collect(withConversationOptions(agent, { ...alpha, model: "claude-haiku-5-5", effort: "medium" }).turn(input("a", "One again")))
      expect(handle.session("a")).toBe(a)
      expect(a.dead).toBeUndefined()
      expect(qa.retunes).toEqual([{ model: "claude-haiku-5-5" }, { effortLevel: "medium" }])
      expect(a.launch).toBe("claude-haiku-5-5|medium|adaptive")
      expect(qa.received.at(-1)).toBe("One again") // nothing to catch up: it is the same session
      // Bravo's session, model and process are as they were.
      expect(handle.session("b")).toBe(b)
      expect(b.dead).toBeUndefined()
      expect(qb.retunes).toHaveLength(bRetunes)
      // Unchanged options: no retune.
      yield* collect(withConversationOptions(agent, { ...alpha, model: "claude-haiku-5-5", effort: "medium" }).turn(input("a", "Once more")))
      expect(qa.retunes).toHaveLength(2)
      handle.shutdown()
    }))

  it.live("a thinking change, or a retune Claude Code refuses, opens a new session told what was said", () =>
    Effect.gen(function*() {
      const history: Array<Message> = [{ role: "user", content: "One" }, { role: "assistant", content: "Hello there.", agentId: "claude-subscription" } as Message]
      const fake = makeFakeSdk()
      const handle = yield* Effect.promise(() => makeClaudeAgent({ ...moduleSettings, sdk: fake.sdk }))
      const agent = asAgent(handle)
      yield* collect(withConversationOptions(agent, bravo).turn(input("a", "One")))
      const before = handle.session("a")!
      yield* collect(withConversationOptions(agent, { ...bravo, thinking: "adaptive" }).turn(input("a", "One again", history)))
      expect(before.dead).toBe("replaced")
      expect(handle.session("a")!.launch).toBe("claude-opus-5-5|low|adaptive")
      expect(fake.queries.at(-1)!.options.thinking).toEqual({ type: "adaptive" })
      expect(fake.queries.at(-1)!.received[0]).toBe("<earlier>\nUser: One\nYou: Hello there.\n</earlier>\n\nOne again")
      handle.shutdown()

      const refusing = makeFakeSdk({ refuseRetune: true })
      const other = yield* Effect.promise(() => makeClaudeAgent({ ...moduleSettings, sdk: refusing.sdk }))
      // The spare cannot be retuned: it is closed and a session is launched with the assistant's settings.
      yield* collect(withConversationOptions(asAgent(other), bravo).turn(input("b", "Two")))
      expect(refusing.queries[0]!.closed).toBe(true)
      expect(refusing.queries[1]!.options).toMatchObject({ model: "claude-opus-5-5", effort: "low" })
      expect(other.session("b")!.launch).toBe("claude-opus-5-5|low|off")
      other.shutdown()
    }))

  it.live("the account's maxSessions (read per turn) bounds the open sessions: the least recently used one is closed", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const handle = yield* Effect.promise(() => makeClaudeAgent({ ...moduleSettings, sdk: fake.sdk }))
      const agent = asAgent(handle)
      expect(handle.sessionLimit()).toBe(4)
      const a = withConversationOptions(agent, { ...alpha, maxSessions: 2 })
      const b = withConversationOptions(agent, { ...bravo, maxSessions: 2 })
      yield* collect(a.turn(input("desk/alpha", "One")))
      yield* collect(b.turn(input("desk/bravo", "Two")))
      expect(handle.sessionLimit()).toBe(2)
      yield* collect(a.turn(input("desk/alpha", "One again")))
      const bravoSession = handle.session("desk/bravo")!
      // A third conversation (another device): Bravo's is the least recently used and is closed.
      yield* collect(a.turn(input("kitchen/alpha", "Three")))
      expect(bravoSession.dead).toBe("closed for another conversation")
      expect(handle.conversations()).toEqual(["desk/alpha", "kitchen/alpha"])
      expect(fake.queries.filter((q) => !q.closed)).toHaveLength(2)
      // The bound grows (another assistant switched on): nothing is closed for the next conversation.
      const wide = withConversationOptions(agent, { ...bravo, maxSessions: 3 })
      yield* collect(wide.turn(input("desk/bravo", "Back")))
      expect(handle.conversations()).toEqual(["desk/alpha", "kitchen/alpha", "desk/bravo"])
      expect(fake.queries.filter((q) => !q.closed)).toHaveLength(3)
      handle.shutdown()
    }))

  it.live("the fresh-session time is per conversation: 0 never restarts, a short one restarts after it", () =>
    Effect.gen(function*() {
      let clock = 1_000_000
      const fake = makeFakeSdk()
      const handle = yield* Effect.promise(() => makeClaudeAgent({ ...moduleSettings, sdk: fake.sdk, now: () => clock }))
      const agent = asAgent(handle)
      const never = withConversationOptions(agent, { ...bravo, sessionIdleMinutes: 0 })
      const short = withConversationOptions(agent, { ...bravo, sessionIdleMinutes: 5 })
      yield* collect(never.turn(input("n", "Hi")))
      yield* collect(short.turn(input("s", "Hi")))
      const n = handle.session("n")!
      const s = handle.session("s")!
      clock += 6 * 60_000
      yield* collect(never.turn(input("n", "Still there?")))
      yield* collect(short.turn(input("s", "Still there?")))
      expect(handle.session("n")).toBe(n)
      expect(s.dead).toBe("replaced")
      expect(handle.session("s")).not.toBe(s)
      handle.shutdown()
    }))

  it.live("withConversationOptions keeps the agent's identity and endConversation", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const handle = yield* Effect.promise(() => makeClaudeAgent({ ...moduleSettings, sdk: fake.sdk }))
      const wrapped = withConversationOptions(asAgent(handle), alpha)
      expect(wrapped.id).toBe("claude-subscription")
      yield* collect(wrapped.turn(input("x", "Hi")))
      const session = handle.session("x")!
      yield* wrapped.endConversation!("x")
      expect(session.dead).toBe("the conversation ended")
      handle.shutdown()
    }))
  // Fourth review of #41: a cancelled turn's retune must be finished (or the session dropped) before the next turn of the
  // conversation compares its options with the session; the session records only what Claude Code acknowledged.
  describe("a turn cancelled while its retune is pending", () => {
    const haiku: ClaudeConversationOptions = { model: "claude-haiku-5-5", tools: false, sessionIdleMinutes: 60 }
    const sonnet: ClaudeConversationOptions = { ...haiku, model: "claude-sonnet-5-5" }
    /** Answers with the model the fake session uses at the moment the message arrives. */
    const answerWithModel = (fake: ReturnType<typeof makeFakeSdk>) =>
      fake.setRespond((ctx) => {
        ctx.delta(`answered with ${ctx.query.model ?? "?"}`)
        ctx.result()
      })
    const textOf = (events: ReadonlyArray<AgentEvent>) =>
      events.flatMap((e) => (e._tag === "TextDelta" ? [e.text] : [])).join("")

    it.live("the next turn waits for it, then retunes back to the model it asks for", () =>
      Effect.gen(function*() {
        const fake = makeFakeSdk()
        answerWithModel(fake)
        const handle = yield* Effect.promise(() => makeClaudeAgent({ ...moduleSettings, sdk: fake.sdk }))
        const agent = asAgent(handle)
        // An established Haiku session.
        const one = yield* collect(withConversationOptions(agent, haiku).turn(input("c", "One")))
        expect(textOf(one)).toBe("answered with claude-haiku-5-5")
        const session = handle.session("c")!
        const q = fake.queries.find((x) => x.received.some((r) => r.endsWith("One")))!
        const haikuLaunch = session.launch
        // Sonnet is saved; its turn's setModel applies at once but its acknowledgement is held back.
        const release = fake.holdRetunes()
        const two = yield* Effect.forkChild(collect(withConversationOptions(agent, sonnet).turn(input("c", "Two"))))
        yield* Effect.sleep("30 millis")
        expect(q.retunes).toEqual([{ model: "claude-sonnet-5-5" }])
        expect(q.model).toBe("claude-sonnet-5-5")
        // Requested, not acknowledged: the session still records Haiku.
        expect(session.launch).toBe(haikuLaunch)
        // Haiku is saved again and another turn comes in, which cancels the Sonnet turn.
        yield* Fiber.interrupt(two)
        const three = yield* Effect.forkChild(collect(withConversationOptions(agent, haiku).turn(input("c", "Three"))))
        yield* Effect.sleep("30 millis")
        // It waits for the pending retune instead of comparing with the session's old options and sending.
        expect(q.received.some((r) => r.endsWith("Three"))).toBe(false)
        release()
        const events = yield* Fiber.join(three)
        // After the Sonnet acknowledgement the session is retuned back to Haiku before the message goes out.
        expect(textOf(events)).toBe("answered with claude-haiku-5-5")
        expect(q.retunes).toEqual([{ model: "claude-sonnet-5-5" }, { model: "claude-haiku-5-5" }])
        expect(handle.session("c")).toBe(session)
        expect(session.dead).toBeUndefined()
        expect(session.launch).toBe(haikuLaunch)
        // The cancelled turn's message was never sent.
        expect(q.received.some((r) => r.endsWith("Two"))).toBe(false)
        handle.shutdown()
      }))

    it.live("a retune that is never acknowledged drops the session; the next turn gets a new one with its model", () =>
      Effect.gen(function*() {
        const fake = makeFakeSdk()
        answerWithModel(fake)
        const handle = yield* Effect.promise(() => makeClaudeAgent({ ...moduleSettings, sdk: fake.sdk }))
        const agent = asAgent(handle)
        yield* collect(withConversationOptions(agent, haiku).turn(input("c", "One")))
        const session = handle.session("c")!
        const release = fake.holdRetunes()
        const two = yield* Effect.forkChild(collect(withConversationOptions(agent, sonnet).turn(input("c", "Two"))))
        yield* Effect.sleep("30 millis")
        yield* Fiber.interrupt(two)
        const three = yield* Effect.forkChild(collect(withConversationOptions(agent, haiku).turn(input("c", "Three"))))
        // The Sonnet change times out (3 s): the session, which may answer with Sonnet, is killed, and the cancelled
        // turn starts no session of its own.
        const events = yield* Fiber.join(three)
        expect(session.dead).toMatch(/could not change the model or effort/)
        expect(textOf(events)).toBe("answered with claude-haiku-5-5")
        const fresh = handle.session("c")!
        expect(fresh).not.toBe(session)
        expect(fresh.launch).toBe(launchKeyOf({ model: "claude-haiku-5-5" }))
        expect(fake.queries.filter((x) => x.options.model === "claude-sonnet-5-5")).toEqual([])
        release()
        handle.shutdown()
      }), 10_000)
  })
})
