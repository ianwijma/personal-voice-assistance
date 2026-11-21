// SessionConversation (SessionConversation.ts): an assistant whose binding changes between `claude-subscription` and a
// single-model account is answered the new way once the binding is published (`bindingChanged`): that conversation's
// loop restarts with the other kind on the same engines (no reload), its history and id carried over, and the agents
// the ended loop used are told the conversation ended (PR #32 review, rounds 1 and 2). Typed input is admitted and
// checked against Stop where the conversation takes it, as before (round 2, finding 1).
import { assert, describe, it } from "@effect/vitest"
import { type Agent, AudioOutput, type ConversationEvent, type ConversationInput, makeToolRegistry, makeTurnTrace, type Message } from "@pva/core"
import { agentText, endOfTurn, makeScriptedAgent, speechStarted } from "@pva/core/testing"
import { ConfigProvider, Deferred, Effect, Queue, Stream } from "effect"
import { makeEngine } from "../src/serve/Engine.ts"
import { makeSessionConversation, type SessionConversationOptions } from "../src/serve/SessionConversation.ts"
import { makeSubscriptionAgents, SUBSCRIPTION_AGENT_ID } from "../src/subscription.ts"
import { controlledStt, fakeBuild, scriptedLlm } from "./support/serveHarness.ts"

const contents = (history: ReadonlyArray<Message>) => history.map((m) => (m.role === "tool" ? "" : m.content))

const until = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let i = 0; i < 300 && !check(); i++) yield* Effect.sleep(10)
    assert.isTrue(check(), "timed out")
  })

const output = AudioOutput.of({ play: <E>(audio: Stream.Stream<Uint8Array, E>) => Stream.runDrain(audio) })

/**
 * A running conversation on fake engines whose kind is `binding.subscription` (what `agentSetup` reads), with a
 * scripted Claude agent that records the conversations it was told have ended. `runs` counts the loop's
 * conversations (the speech stream is made at each one's start, after the previous one has ended).
 */
const setUp = (extra: Partial<SessionConversationOptions> = {}) =>
  Effect.gen(function*() {
    const llm = scriptedLlm((text) => `Model: ${text}.`)
    const engine = yield* makeEngine({
      build: fakeBuild({ stt: controlledStt().stt, llm: llm.llm }),
      configProvider: () => ConfigProvider.fromEnvRecord({}),
      onStatus: () => {}
    })
    assert.isTrue((yield* engine.start).ok)
    const claude = makeScriptedAgent(
      { id: SUBSCRIPTION_AGENT_ID, name: "Claude subscription", kind: "harness" },
      (input) => [agentText(`Claude: ${input.text}.`)]
    )
    const ended: Array<string> = []
    const claudeAgent: Agent = { ...claude.agent, endConversation: (id) => Effect.sync(() => void ended.push(id)) }
    const toAgents = makeSubscriptionAgents({
      fallbackLlm: llm.llm,
      agents: () => new Map([[SUBSCRIPTION_AGENT_ID, claudeAgent]]),
      module: () => undefined
    })
    const setup = Effect.succeed({ system: "I am alpha", registry: makeToolRegistry([]) })
    const binding = { subscription: false }
    const speech = yield* Queue.unbounded<ConversationInput>()
    let runs = 0
    const events: Array<ConversationEvent> = []
    const conversation = yield* makeSessionConversation({
      engine,
      output,
      turnTrace: makeTurnTrace(),
      setup,
      agentSetup: () => (binding.subscription ? Effect.map(setup, toAgents) : undefined),
      onEvent: (event) => void events.push(event),
      speech: () => {
        runs++
        return Stream.fromQueue(speech)
      },
      ...extra
    })
    conversation.start()
    yield* until(() => runs === 1)
    const history = () => Effect.runSync(conversation.history)
    const type = (text: string) => assert.strictEqual(conversation.send({ _tag: "TextInput", text, speak: false }), "accepted")
    /** The binding in use changes: published to the conversation, which restarts with the other kind. */
    const publish = (subscription: boolean) =>
      Effect.gen(function*() {
        const before = runs
        binding.subscription = subscription
        conversation.bindingChanged()
        yield* until(() => runs > before)
      })
    return { llm, claude, ended, binding, speech, events, conversation, history, type, publish, runs: () => runs }
  })

describe("SessionConversation: the conversation's kind follows the published binding", () => {
  it.live("model → subscription → model → subscription: each turn answered by the binding in force, one history", () =>
    Effect.gen(function*() {
      const t = yield* setUp()
      const id = t.conversation.conversation().id

      t.type("one")
      yield* until(() => t.history().length === 2)
      // Saved, not yet published (the new binding is still being built): the old kind keeps answering.
      t.binding.subscription = true
      t.type("two")
      yield* until(() => t.history().length === 4)
      yield* t.publish(true)
      t.type("three")
      yield* until(() => t.history().length === 6)
      yield* t.publish(false)
      // Leaving the agents: Claude's session of this conversation was closed, before the model's turn.
      assert.deepStrictEqual(t.ended, [id])
      t.type("four")
      yield* until(() => t.history().length === 8)
      // Speech after the binding changed again: the next utterance goes to Claude.
      yield* t.publish(true)
      Queue.offerUnsafe(t.speech, speechStarted)
      Queue.offerUnsafe(t.speech, endOfTurn("five"))
      yield* until(() => t.history().length === 10)

      assert.deepStrictEqual(contents(t.history()), [
        "one",
        "Model: one.",
        "two",
        "Model: two.",
        "three",
        "Claude: three.",
        "four",
        "Model: four.",
        "five",
        "Claude: five."
      ])
      // The model saw the whole conversation, Claude's turn included; Claude got both of its turns with the history.
      assert.strictEqual(t.llm.requests.length, 3)
      assert.deepStrictEqual(contents(t.llm.requests[2]!.messages as ReadonlyArray<Message>), ["one", "Model: one.", "two", "Model: two.", "three", "Claude: three.", "four"])
      assert.deepStrictEqual(t.claude.probe.inputs.map((i) => i.text), ["three", "five"])
      assert.strictEqual(t.claude.probe.inputs[1]!.history.length, 8)
      assert.strictEqual(t.conversation.conversation().id, id)

      // A binding change that keeps the kind restarts nothing.
      const runs = t.runs()
      t.conversation.bindingChanged()
      yield* Effect.sleep(50)
      assert.strictEqual(t.runs(), runs)

      // Discarded: the agents the last run used are told, once.
      yield* t.conversation.end
      assert.deepStrictEqual(t.ended, [id, id])
    }).pipe(Effect.scoped))

  it.live("the agents used before an account change are told when the conversation is reset or discarded", () =>
    Effect.gen(function*() {
      const t = yield* setUp()
      yield* t.publish(true)
      const first = t.conversation.conversation().id
      t.type("one")
      yield* until(() => t.history().length === 2)
      // Reset while Claude answers: its session of the old conversation ends.
      const second = (yield* t.conversation.newConversation).id
      assert.notStrictEqual(second, first)
      assert.deepStrictEqual(t.ended, [first])
      t.type("two")
      yield* until(() => t.history().length === 2 && t.claude.probe.inputs.length === 2)
      // Moved to a single model: the agents that run used end the conversation they were in.
      yield* t.publish(false)
      assert.deepStrictEqual(t.ended, [first, second])
      t.type("three")
      yield* until(() => t.history().length === 4)
      // Discarded later: nothing left to tell (the agents are not resolved from the account now in force).
      yield* t.conversation.end
      assert.deepStrictEqual(t.ended, [first, second])
    }).pipe(Effect.scoped))
})

describe("SessionConversation: typed input is admitted where the conversation takes it", () => {
  it.live("while the conversation is busy, waiting inputs count against the limit and Stop drops them", () =>
    Effect.gen(function*() {
      // Each turn's setup waits for `gate`: the conversation is held at the first turn's start, taking nothing more.
      const gate = Deferred.makeUnsafe<void>()
      let setupReads = 0
      const base = { system: "I am alpha", registry: makeToolRegistry([]) }
      const t = yield* setUp({
        setup: Effect.suspend(() => {
          setupReads++
          return Effect.as(Deferred.await(gate), base)
        }),
        maxPendingInputs: 2
      })
      const before = setupReads
      t.type("one")
      yield* until(() => setupReads > before)
      // "one" is taken; "two" and "three" wait, and fill the limit.
      t.type("two")
      t.type("three")
      assert.strictEqual(t.conversation.send({ _tag: "TextInput", text: "four", speak: false }), "busy")
      assert.strictEqual(t.conversation.send({ _tag: "Interrupt" }), "accepted")
      Deferred.doneUnsafe(gate, Effect.void)
      const ended = () => t.events.filter((e) => e._tag === "TurnEnded").length
      // "one" starts and is stopped; "two" and "three", accepted before Stop, never start.
      yield* until(() => ended() === 1)
      t.type("five")
      yield* until(() => ended() === 2)
      const started = t.events.flatMap((e) => (e._tag === "TurnStarted" ? [e.text] : []))
      assert.deepStrictEqual(started, ["one", "five"])
      yield* t.conversation.end
    }).pipe(Effect.scoped))
})

describe("SessionConversation: an ended conversation is handed on with its history (docs/REPORTS.md)", () => {
  it.live("the idle reset, a new conversation and the end each hand on the history and why it ended", () =>
    Effect.gen(function*() {
      const ended: Array<{ readonly id: string; readonly history: ReadonlyArray<string>; readonly reason: string }> = []
      let idleMs: number | undefined
      const t = yield* setUp({
        idleResetMs: () => idleMs,
        keepsEndedHistory: () => true,
        onConversationEnded: (id, history, reason) => void ended.push({ id, history: contents(history), reason })
      })
      const first = t.conversation.conversation().id
      t.type("one")
      yield* until(() => t.history().length === 2)
      // The quiet spell passes: the next turn starts a new conversation, whose history is empty by the time it says so.
      idleMs = 30
      yield* Effect.sleep(80)
      t.type("two")
      yield* until(() => ended.length === 1 && t.history().length === 2)
      assert.deepStrictEqual(ended[0], { id: first, history: ["one", "Model: one."], reason: "idle" })
      idleMs = undefined
      // `conversation.new` hands on the second one.
      const second = t.conversation.conversation().id
      yield* t.conversation.newConversation
      yield* until(() => ended.length === 2)
      assert.deepStrictEqual(ended[1], { id: second, history: ["two", "Model: two."], reason: "new" })
      // The end hands on the last one (empty: nothing was said in it).
      const third = t.conversation.conversation().id
      yield* t.conversation.end
      assert.deepStrictEqual(ended[2], { id: third, history: [], reason: "end" })
    }))

  it.live("while nothing keeps an ended conversation, no history is copied or handed on", () =>
    Effect.gen(function*() {
      const ended: Array<ReadonlyArray<string>> = []
      let idleMs: number | undefined
      const t = yield* setUp({ idleResetMs: () => idleMs, keepsEndedHistory: () => false, onConversationEnded: (_id, history) => void ended.push(contents(history)) })
      t.type("one")
      yield* until(() => t.history().length === 2)
      idleMs = 30
      yield* Effect.sleep(80)
      t.type("two")
      yield* until(() => ended.length === 1)
      assert.deepStrictEqual(ended[0], [])
      yield* t.conversation.end
    }))
})
