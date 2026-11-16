// SessionConversation (SessionConversation.ts): an assistant whose account changes between `claude-subscription` and a
// single-model account is answered the new way from its next turn on, on the same engines (no reload), with the
// conversation's history and id carried over (PR #32 review, round 1).
import { assert, describe, it } from "@effect/vitest"
import { AudioOutput, type ConversationInput, makeToolRegistry, makeTurnTrace, type Message } from "@pva/core"
import { agentText, endOfTurn, makeScriptedAgent, speechStarted } from "@pva/core/testing"
import { ConfigProvider, Effect, Queue, Stream } from "effect"
import { makeEngine } from "../src/serve/Engine.ts"
import { makeSessionConversation } from "../src/serve/SessionConversation.ts"
import { makeSubscriptionAgents, SUBSCRIPTION_AGENT_ID } from "../src/subscription.ts"
import { controlledStt, fakeBuild, scriptedLlm } from "./support/serveHarness.ts"

const contents = (history: ReadonlyArray<Message>) => history.map((m) => (m.role === "tool" ? "" : m.content))

describe("SessionConversation: the account's kind is read at every turn", () => {
  it.live("subscription → model → subscription: each turn answered by the account in force, one history", () =>
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
      const toAgents = makeSubscriptionAgents({
        fallbackLlm: llm.llm,
        agents: () => new Map([[SUBSCRIPTION_AGENT_ID, claude.agent]]),
        module: () => undefined
      })
      const setup = Effect.succeed({ system: "I am alpha", registry: makeToolRegistry([]) })
      let subscription = false
      const speech = yield* Queue.unbounded<ConversationInput>()
      const output = AudioOutput.of({ play: <E>(audio: Stream.Stream<Uint8Array, E>) => Stream.runDrain(audio) })
      const conversation = yield* makeSessionConversation({
        engine,
        output,
        turnTrace: makeTurnTrace(),
        setup,
        agentSetup: () => (subscription ? Effect.map(setup, toAgents) : undefined),
        onEvent: () => {},
        speech: () => Stream.fromQueue(speech)
      })
      conversation.start()
      const until = (check: () => boolean) =>
        Effect.gen(function*() {
          for (let i = 0; i < 300 && !check(); i++) yield* Effect.sleep(10)
        })
      const history = () => Effect.runSync(conversation.history)
      const id = conversation.conversation().id
      const type = (text: string) => assert.strictEqual(conversation.send({ _tag: "TextInput", text, speak: false }), "accepted")

      yield* until(() => conversation.running())
      type("one")
      yield* until(() => history().length === 2)
      subscription = true
      type("two")
      yield* until(() => history().length === 4)
      subscription = false
      type("three")
      yield* until(() => history().length === 6)
      // Speech after the account changed again: the next utterance goes to Claude.
      subscription = true
      Queue.offerUnsafe(speech, speechStarted)
      Queue.offerUnsafe(speech, endOfTurn("four"))
      yield* until(() => history().length === 8)

      assert.deepStrictEqual(contents(history()), ["one", "Model: one.", "two", "Claude: two.", "three", "Model: three.", "four", "Claude: four."])
      // The model saw the whole conversation, Claude's turn included; Claude got both of its turns with the history.
      assert.strictEqual(llm.requests.length, 2)
      assert.deepStrictEqual(contents(llm.requests[1]!.messages as ReadonlyArray<Message>), ["one", "Model: one.", "two", "Claude: two.", "three"])
      assert.deepStrictEqual(claude.probe.inputs.map((i) => i.text), ["two", "four"])
      assert.strictEqual(claude.probe.inputs[1]!.history.length, 6)
      assert.strictEqual(conversation.conversation().id, id)
      yield* conversation.end
    }).pipe(Effect.scoped))
})
