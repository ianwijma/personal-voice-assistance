// The session dispatcher (SessionDispatcher.ts) and the output lease (OutputLease.ts): docs/ASSISTANTS.md §3.3, WP-4a.
// Recorder fakes check the exact inputs each conversation gets; real `Conversation`s (scripted Llm, marker Tts) behind
// the lease check what is played and committed. Every test asserts that no two plays overlap on the shared output.
import { assert, describe, it } from "@effect/vitest"
import {
  AudioError,
  AudioOutput,
  type Conversation,
  type ConversationEvent,
  type ConversationInput,
  Llm,
  makeConversationWithSetup,
  makeRouteGate,
  makeToolRegistry,
  makeTurnTrace,
  type Message,
  type RouteConfig,
  type RouteGate,
  type SttEvent,
  type TurnOutcome,
  Tts,
  TurnTrace
} from "@pva/core"
import {
  eagerEndOfTurn,
  endOfTurn,
  interim,
  type LlmScript,
  makeMarkerTts,
  makeScriptedLlm,
  markerText,
  sleep,
  speechStarted,
  textDelta,
  turnResumed
} from "@pva/core/testing"
import { Clock, Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { makeEngine } from "../src/serve/Engine.ts"
import { isSuperseded, type LeasePlayEnd, makeOutputLease, SUPERSEDED } from "../src/serve/OutputLease.ts"
import { makeSessionConversation, type SessionConversation } from "../src/serve/SessionConversation.ts"
import {
  type DecideResult,
  type DecideRoute,
  type DispatchHooks,
  type DispatchTarget,
  makeSessionDispatcher,
  type SessionDispatcherOptions
} from "../src/serve/SessionDispatcher.ts"
import { controlledStt, fakeBuild, scriptedLlm } from "./support/serveHarness.ts"
import { ConfigProvider } from "effect"

// ---------------------------------------------------------------------------
// Shared pieces

/** The shared output: records chunks with their time and counts plays running at once (the invariant). */
const overlapOutput = (chunkMillis = 100) => {
  const probe = { active: 0, maxActive: 0, plays: 0, chunks: [] as Array<{ readonly text: string; readonly at: number }> }
  const output = AudioOutput.of({
    play: <E>(audio: Stream.Stream<Uint8Array, E>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          probe.plays++
          probe.active++
          probe.maxActive = Math.max(probe.maxActive, probe.active)
        }),
        () =>
          Stream.runForEach(audio, (chunk) =>
            Effect.flatMap(Clock.currentTimeMillis, (at) => {
              probe.chunks.push({ text: markerText(chunk), at })
              return Effect.sleep(chunkMillis)
            })),
        () => Effect.sync(() => void probe.active--)
      )
  })
  return { output, probe }
}

const assertNoOverlap = (probe: { readonly maxActive: number }) =>
  assert.isAtMost(probe.maxActive, 1, "two plays ran on the shared output at once")

/** `TestClock.adjust` waits one scheduler hop; let forked fibers run first (as Conversation.test.ts). */
const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))
const advanceBy = (millis: number, step = 25) =>
  Effect.gen(function*() {
    for (let t = 0; t < millis; t += step) yield* advance(step)
  })

const phrases = [{ phrase: "hey alpha", assistant: "alpha" }, { phrase: "hey bravo", assistant: "bravo" }]
const routeConfig = (over: Partial<RouteConfig> = {}): RouteConfig => ({
  phrases,
  match: "exact",
  withoutPhrase: "assistant",
  defaultAssistant: "alpha",
  off: new Set(),
  ...over
})

const show = (input: ConversationInput): string => {
  switch (input._tag) {
    case "Interim":
    case "EagerEndOfTurn":
    case "EndOfTurn":
    case "TextInput":
    case "Say":
      return `${input._tag}(${input.text})`
    default:
      return input._tag
  }
}

// ---------------------------------------------------------------------------
// Recorder fakes: what each conversation is handed

const recorder = (options: Omit<SessionDispatcherOptions<DispatchTarget>, "make"> = {}) => {
  const log: Array<string> = []
  const made: Array<string> = []
  const hooks = new Map<string, DispatchHooks>()
  const dispatcher = makeSessionDispatcher({
    ...options,
    make: (assistant, h) =>
      Effect.sync(() => {
        made.push(assistant)
        hooks.set(assistant, h)
        return {
          push: (input) => void log.push(`${assistant} ${show(input)}`),
          send: (input) => {
            log.push(`${assistant} send ${show(input)}`)
            return "accepted" as const
          }
        }
      })
  })
  let turnId = 100
  /** Report a turn of `assistant` as its conversation would (`TurnStarted` … `TurnEnded`). */
  const turn = (assistant: string, speculative = false) => {
    const id = turnId++
    const emit = (event: ConversationEvent) => hooks.get(assistant)!.onEvent(event)
    emit({ _tag: "TurnStarted", turnId: id, source: "voice", text: "x", speculative, spoken: true })
    return {
      id,
      promote: () => emit({ _tag: "TurnPromoted", turnId: id }),
      end: (outcome: TurnOutcome = "completed") =>
        emit({ _tag: "TurnEnded", turnId: id, outcome, trace: { id, mode: "voice", speculative, startedAt: 0, marks: {}, tools: [], voices: [] } })
    }
  }
  return { log, made, dispatcher, turn }
}

/** Feed recogniser events through a route gate into the dispatcher, one ms apart. */
const feedVia = (gate: RouteGate, dispatcher: { readonly dispatch: (r: ReturnType<RouteGate["filter"]>) => Effect.Effect<void> }) => {
  let t = 0
  return (events: ReadonlyArray<SttEvent>) => Effect.forEach(events, (e) => dispatcher.dispatch(gate.filter(e, t++)), { discard: true })
}

describe("SessionDispatcher: routing (recorder fakes)", () => {
  it.effect("the default assistant gets the utterance as is; its conversation is made on first use", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig()), r.dispatcher)
      assert.deepStrictEqual(r.made, [])
      yield* feed([speechStarted, interim("what time"), eagerEndOfTurn("what time is it"), turnResumed, endOfTurn("what time is it now")])
      assert.deepStrictEqual(r.log, [
        "alpha SpeechStarted",
        "alpha Interim(what time)",
        "alpha EagerEndOfTurn(what time is it)",
        "alpha TurnResumed",
        "alpha EndOfTurn(what time is it now)"
      ])
      assert.deepStrictEqual(r.made, ["alpha"])
      assert.deepStrictEqual(r.dispatcher.routeOf("alpha"), { assistant: "alpha", by: "default" })
    }))

  it.effect("asleep: only the phrase's assistant is made; it gets SpeechStarted and the text without the phrase", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig({ withoutPhrase: "nobody" })), r.dispatcher)
      yield* feed([speechStarted, interim("hey bravo what"), endOfTurn("hey bravo what time is it")])
      assert.deepStrictEqual(r.log, ["bravo SpeechStarted", "bravo Interim(what)", "bravo EndOfTurn(what time is it)"])
      assert.deepStrictEqual(r.made, ["bravo"])
      assert.deepStrictEqual(r.dispatcher.routeOf("bravo"), { assistant: "bravo", by: "phrase", phrase: "hey bravo" })
    }))

  it.effect("a phrase of another assistant moves the utterance at the first text that carries it", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig()), r.dispatcher)
      yield* feed([speechStarted, interim("hey bravo what"), endOfTurn("hey bravo what time is it")])
      assert.deepStrictEqual(r.log, [
        "alpha SpeechStarted", // the base target, at once
        "alpha EndOfTurn()", // closes it there: starts nothing
        "bravo SpeechStarted",
        "bravo Interim(what)",
        "bravo EndOfTurn(what time is it)"
      ])
    }))

  it.effect("hand-over mid-speculation: eager went to alpha, the final carries bravo's phrase", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig()), r.dispatcher)
      yield* feed([speechStarted, eagerEndOfTurn("turn on the lights")])
      const speculative = r.turn("alpha", true)
      yield* feed([endOfTurn("hey bravo turn on the lights")])
      speculative.end("discarded")
      assert.deepStrictEqual(r.log, [
        "alpha SpeechStarted",
        "alpha EagerEndOfTurn(turn on the lights)",
        "alpha EndOfTurn()", // discards alpha's speculative turn; no Interrupt (nothing committed runs there)
        "bravo SpeechStarted",
        "bravo EndOfTurn(turn on the lights)"
      ])
    }))

  it.effect("barge-in into the other assistant: SpeechStarted goes to the one replying, the words to the one named", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig()), r.dispatcher)
      yield* r.dispatcher.send("bravo", { _tag: "TextInput", text: "tell me a story", speak: true })
      const story = r.turn("bravo")
      assert.strictEqual(r.dispatcher.owner(), "bravo")
      yield* feed([speechStarted])
      assert.deepStrictEqual(r.log.slice(-1), ["bravo SpeechStarted"], "barge-in at once, before any words")
      yield* feed([interim("hey alpha lights"), endOfTurn("hey alpha lights off")])
      story.end("interrupted")
      assert.deepStrictEqual(r.log, [
        "bravo send TextInput(tell me a story)",
        "bravo SpeechStarted",
        "bravo EndOfTurn()",
        "bravo Interrupt", // its committed turn still counted as running
        "alpha SpeechStarted",
        "alpha Interim(lights)",
        "alpha EndOfTurn(lights off)"
      ])
      assert.deepStrictEqual(r.dispatcher.routeOf("alpha"), { assistant: "alpha", by: "phrase", phrase: "hey alpha" })
    }))

  it.effect("the owner is the one that was just handed a final, before its turn is reported", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig()), r.dispatcher)
      yield* feed([speechStarted, endOfTurn("hey bravo what time is it")])
      // bravo has not reported TurnStarted yet; the owner speaks again, to alpha.
      assert.strictEqual(r.dispatcher.owner(), "bravo")
      yield* feed([speechStarted, endOfTurn("hey alpha never mind")])
      assert.deepStrictEqual(r.log.slice(-5), [
        "bravo SpeechStarted",
        "bravo EndOfTurn()",
        "bravo Interrupt", // queued after the final: stops the turn that final starts
        "alpha SpeechStarted",
        "alpha EndOfTurn(never mind)"
      ])
      assert.strictEqual(r.dispatcher.owner(), "alpha")
    }))

  it.effect("start replying early off: no EagerEndOfTurn or TurnResumed for that assistant", () =>
    Effect.gen(function*() {
      const r = recorder({ replyEarly: (a) => a !== "bravo" })
      const feed = feedVia(makeRouteGate(routeConfig({ withoutPhrase: "nobody" })), r.dispatcher)
      yield* feed([speechStarted, eagerEndOfTurn("hey bravo lights"), turnResumed, endOfTurn("hey bravo lights on")])
      assert.deepStrictEqual(r.log, ["bravo SpeechStarted", "bravo EndOfTurn(lights on)"])
      yield* feed([speechStarted, eagerEndOfTurn("hey alpha lights"), turnResumed, endOfTurn("hey alpha lights on")])
      assert.deepStrictEqual(r.log.slice(2), [
        // bravo was just handed a final (the recorder never reports its turn): it is the barge-in owner
        "bravo SpeechStarted",
        "bravo EndOfTurn()",
        "bravo Interrupt",
        "alpha SpeechStarted",
        "alpha EagerEndOfTurn(lights)",
        "alpha TurnResumed",
        "alpha EndOfTurn(lights on)"
      ])
    }))

  it.effect("decide: the fallback answers (the WP-14 seam), asked at the eager point and reused for the same text", () =>
    Effect.gen(function*() {
      const asked: Array<string> = []
      const decide: DecideRoute = (request) =>
        Effect.sync(() => {
          asked.push(`${request.final ? "final" : "eager"}:${request.text}`)
          return { assistant: request.fallback, fallback: true }
        })
      const r = recorder({ decide })
      const feed = feedVia(makeRouteGate(routeConfig({ withoutPhrase: "decide", fallback: "bravo" })), r.dispatcher)
      yield* feed([speechStarted, interim("lights")])
      assert.deepStrictEqual(r.log, [], "nothing is delivered before the decision")
      yield* feed([eagerEndOfTurn("lights on"), endOfTurn("lights on.")])
      assert.deepStrictEqual(asked, ["eager:lights on"], "the final is the same utterance: the decision is reused")
      assert.deepStrictEqual(r.log, ["bravo SpeechStarted", "bravo EagerEndOfTurn(lights on)", "bravo EndOfTurn(lights on.)"])
      assert.deepStrictEqual(r.dispatcher.routeOf("bravo"), { by: "decide", assistant: "bravo", fallback: true })
      yield* feed([speechStarted, eagerEndOfTurn("lights"), turnResumed, endOfTurn("lights off")])
      assert.deepStrictEqual(asked.slice(1), ["eager:lights", "final:lights off"], "asked again when the text changed")
    }))

  it.effect("decide: a decider that changes its mind between eager and final hands the utterance over", () =>
    Effect.gen(function*() {
      const decide: DecideRoute = (request) => Effect.succeed({ assistant: request.final ? "bravo" : "alpha", fallback: false })
      const r = recorder({ decide })
      const feed = feedVia(makeRouteGate(routeConfig({ withoutPhrase: "decide", fallback: null })), r.dispatcher)
      yield* feed([speechStarted, eagerEndOfTurn("play music"), endOfTurn("play music loud")])
      assert.deepStrictEqual(r.log, [
        "alpha SpeechStarted",
        "alpha EagerEndOfTurn(play music)",
        "alpha EndOfTurn()",
        "bravo SpeechStarted",
        "bravo EndOfTurn(play music loud)"
      ])
    }))

  it.effect("decide with no fallback: nobody answers and no conversation is made", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig({ withoutPhrase: "decide", fallback: null })), r.dispatcher)
      yield* feed([speechStarted, eagerEndOfTurn("lights"), endOfTurn("lights")])
      assert.deepStrictEqual(r.log, [])
      assert.deepStrictEqual(r.made, [])
      // A phrase still reaches its assistant.
      yield* feed([speechStarted, endOfTurn("hey alpha lights")])
      assert.deepStrictEqual(r.log, ["alpha SpeechStarted", "alpha EndOfTurn(lights)"])
    }))

  it.effect("an off assistant's phrase closes the utterance where it was (the gate forwards \"\")", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig({ off: new Set(["bravo"]) })), r.dispatcher)
      yield* feed([speechStarted, interim("hey bravo lights"), endOfTurn("hey bravo lights")])
      assert.deepStrictEqual(r.log, ["alpha SpeechStarted", "alpha EndOfTurn()"])
      assert.deepStrictEqual(r.made, ["alpha"])
    }))

  it.effect("Stop: every active conversation gets it, and the rest of the utterance is not handed over", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig()), r.dispatcher)
      yield* r.dispatcher.send("alpha", { _tag: "TextInput", text: "story", speak: true })
      const story = r.turn("alpha")
      yield* r.dispatcher.send("bravo", { _tag: "TextInput", text: "x", speak: false })
      r.turn("bravo").end()
      yield* feed([speechStarted])
      assert.strictEqual(r.dispatcher.stop(), "accepted")
      story.end("interrupted")
      yield* feed([interim("hey bravo lights"), endOfTurn("hey bravo lights")])
      assert.deepStrictEqual(r.log.slice(3), [
        "alpha SpeechStarted",
        "alpha send Interrupt", // bravo is idle: not stopped
        "alpha Interim(lights)", // the gate strips bravo's phrase, but the stopped utterance stays with alpha
        "alpha EndOfTurn(lights)" // alpha's conversation swallows the rest of the stopped utterance
      ])
    }))

  it.effect("Stop while the route is being decided: the decided assistant never gets the stopped utterance", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const asked: Array<string> = []
      const decide: DecideRoute = (request) =>
        Effect.sync(() => void asked.push(request.text)).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as({ assistant: "bravo", fallback: false })
        )
      const r = recorder({ decide })
      const feed = feedVia(makeRouteGate(routeConfig({ withoutPhrase: "decide", fallback: null })), r.dispatcher)
      yield* r.dispatcher.send("alpha", { _tag: "TextInput", text: "story", speak: true })
      const story = r.turn("alpha")
      yield* feed([speechStarted]) // to alpha, the barge-in owner
      const deciding = yield* Effect.forkChild(feed([endOfTurn("lights on")]))
      yield* Effect.repeat(Effect.yieldNow, { times: 50 })
      assert.deepStrictEqual(asked, ["lights on"], "the final is being decided")
      assert.strictEqual(r.dispatcher.stop(), "accepted")
      story.end("interrupted")
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(deciding)
      assert.deepStrictEqual(r.log.slice(1), [
        "alpha SpeechStarted",
        "alpha send Interrupt",
        "alpha EndOfTurn(lights on)" // swallowed by alpha's stopped conversation; not handed to bravo
      ])
      assert.deepStrictEqual(r.made, ["alpha"], "bravo's conversation is not even made")
    }))

  it.effect("Stop while an undelivered utterance is decided: nobody gets it", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const decide: DecideRoute = () => Effect.as(Deferred.await(gate), { assistant: "bravo", fallback: false })
      const r = recorder({ decide })
      const feed = feedVia(makeRouteGate(routeConfig({ withoutPhrase: "decide", fallback: null })), r.dispatcher)
      const deciding = yield* Effect.forkChild(feed([speechStarted, endOfTurn("lights on")]))
      yield* Effect.repeat(Effect.yieldNow, { times: 50 })
      assert.strictEqual(r.dispatcher.stop(), "accepted")
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(deciding)
      assert.deepStrictEqual(r.log, [])
      assert.deepStrictEqual(r.made, [])
    }))

  it.effect("New conversation cancels the open utterance: its rest is not handed to another assistant", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig()), r.dispatcher)
      yield* feed([speechStarted])
      r.dispatcher.cancelUtterance("bravo") // not bravo's utterance: nothing changes
      r.dispatcher.cancelUtterance("alpha")
      yield* feed([endOfTurn("hey bravo turn on the lights")])
      assert.deepStrictEqual(r.log, [
        "alpha SpeechStarted",
        "alpha EndOfTurn(turn on the lights)" // alpha's reset conversation swallows it
      ])
      assert.deepStrictEqual(r.made, ["alpha"])
    }))

  it.effect("typed text interrupts another conversation's reply, but not one the owner is speaking to", () =>
    Effect.gen(function*() {
      const r = recorder()
      const feed = feedVia(makeRouteGate(routeConfig()), r.dispatcher)
      yield* r.dispatcher.send("alpha", { _tag: "TextInput", text: "story", speak: true })
      r.turn("alpha")
      yield* r.dispatcher.send("bravo", { _tag: "TextInput", text: "weather", speak: false })
      assert.deepStrictEqual(r.log.slice(-2), ["bravo send TextInput(weather)", "alpha Interrupt"])
      // While the owner speaks to alpha, typed text to bravo leaves alpha alone…
      yield* feed([speechStarted, interim("lights")])
      r.log.length = 0
      yield* r.dispatcher.send("bravo", { _tag: "TextInput", text: "again", speak: false })
      assert.deepStrictEqual(r.log, ["bravo send TextInput(again)"])
      // …and the final to alpha interrupts bravo's reply that started during the utterance.
      r.turn("bravo")
      yield* feed([endOfTurn("lights on")])
      assert.deepStrictEqual(r.log.slice(1), ["alpha EndOfTurn(lights on)", "bravo Interrupt"])
    }))

  it.effect("Stop while TypeSafe decides: the late answer moves nothing, and no conversation gets the final", () =>
    Effect.gen(function*() {
      const asked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<DecideResult>()
      const decide: DecideRoute = () => Effect.andThen(Deferred.succeed(asked, undefined), Deferred.await(answer))
      const r = recorder({ decide })
      const feed = feedVia(makeRouteGate(routeConfig({ withoutPhrase: "decide", fallback: null })), r.dispatcher)
      yield* feed([speechStarted])
      const final = yield* Effect.forkChild(feed([endOfTurn("lights on")]))
      yield* Deferred.await(asked)
      assert.strictEqual(r.dispatcher.stop(), "accepted")
      yield* Deferred.succeed(answer, { assistant: "bravo", fallback: false })
      yield* Fiber.join(final)
      assert.deepStrictEqual(r.log, [], "bravo never got an Interrupt, so it must not get the utterance")
      assert.deepStrictEqual(r.made, [])
      assert.strictEqual(r.dispatcher.delivering(), undefined)
    }))

  it.effect("decide: an answer naming an assistant the device no longer has goes to the fallback the device has now", () =>
    Effect.gen(function*() {
      const device: { candidates: ReadonlyArray<string>; fallback: string | null } = { candidates: ["alpha", "bravo"], fallback: "alpha" }
      const asked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<DecideResult>()
      const decide: DecideRoute = () => Effect.andThen(Deferred.succeed(asked, undefined), Deferred.await(answer))
      const r = recorder({ decide, decideNow: () => device })
      const feed = feedVia(makeRouteGate(routeConfig({ withoutPhrase: "decide", fallback: "alpha" })), r.dispatcher)
      yield* feed([speechStarted])
      const eager = yield* Effect.forkChild(feed([eagerEndOfTurn("play music")]))
      yield* Deferred.await(asked)
      device.candidates = ["alpha"] // bravo is taken off this device while TypeSafe is asked
      yield* Deferred.succeed(answer, { assistant: "bravo", fallback: false })
      yield* Fiber.join(eager)
      assert.deepStrictEqual(r.log, ["alpha SpeechStarted", "alpha EagerEndOfTurn(play music)"])
      assert.deepStrictEqual(r.made, ["alpha"])
      assert.deepStrictEqual(r.dispatcher.routeOf("alpha"), { by: "decide", assistant: "alpha", fallback: true })
      // The fallback is taken off too before the final, which reuses the eager answer: checked again, nobody answers.
      device.fallback = null
      yield* feed([endOfTurn("play music.")])
      assert.deepStrictEqual(r.log.slice(2), ["alpha EndOfTurn()"])
    }))

  it.effect("decide: an eager answer reused at the final is checked against the device again", () =>
    Effect.gen(function*() {
      const device: { candidates: ReadonlyArray<string>; fallback: string | null } = { candidates: ["alpha", "bravo"], fallback: "alpha" }
      const asked: Array<string> = []
      const decide: DecideRoute = (request) =>
        Effect.sync(() => {
          asked.push(request.text)
          return { assistant: "bravo", fallback: false }
        })
      const r = recorder({ decide, decideNow: () => device })
      const feed = feedVia(makeRouteGate(routeConfig({ withoutPhrase: "decide", fallback: "alpha" })), r.dispatcher)
      yield* feed([speechStarted, eagerEndOfTurn("play music")])
      device.candidates = ["alpha"]
      yield* feed([endOfTurn("play music.")])
      assert.deepStrictEqual(asked, ["play music"], "the final reused the eager answer")
      assert.deepStrictEqual(r.log, [
        "bravo SpeechStarted",
        "bravo EagerEndOfTurn(play music)",
        "bravo EndOfTurn()", // closes it there: discards bravo's speculative turn
        "alpha SpeechStarted",
        "alpha EndOfTurn(play music.)"
      ])
      assert.deepStrictEqual(r.dispatcher.routeOf("alpha"), { by: "decide", assistant: "alpha", fallback: true })
    }))
})

// ---------------------------------------------------------------------------
// Output lease on its own

describe("OutputLease", () => {
  it.effect("a play that starts while another runs supersedes it: the older one fails, and ends before the newer starts", () =>
    Effect.gen(function*() {
      const shared = overlapOutput(100)
      const order: Array<string> = []
      const lease = makeOutputLease(shared.output, {
        onStart: (h) => void order.push(`start ${h}`),
        onEnd: (h, how: LeasePlayEnd) => void order.push(`end ${h} ${how}`)
      })
      const audio = (label: string, n: number) => Stream.fromIterable(Array.from({ length: n }, (_, i) => new TextEncoder().encode(`${label}${i}`)))
      const a = yield* Effect.forkChild(Effect.exit(lease.output("a").play(audio("a", 10), 22_050)))
      yield* advance(250)
      assert.strictEqual(lease.holder(), "a")
      const b = yield* Effect.forkChild(Effect.exit(lease.output("b").play(audio("b", 2), 24_000)))
      yield* advance(1)
      const exitA = yield* Fiber.join(a)
      assert.isTrue(Exit.isFailure(exitA))
      if (Exit.isFailure(exitA)) {
        const error = exitA.cause.reasons.find((r) => r._tag === "Fail")
        assert.isTrue(error !== undefined && isSuperseded((error as { error: unknown }).error), "AudioError(superseded)")
      }
      yield* advanceBy(400)
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(b)))
      assert.deepStrictEqual(order, ["start a", "end a superseded", "start b", "end b completed"])
      assert.deepStrictEqual(shared.probe.chunks.map((c) => c.text), ["a0", "a1", "a2", "b0", "b1"])
      assert.strictEqual(lease.holder(), undefined)
      assertNoOverlap(shared.probe)
    }))

  it.effect("a play its own conversation interrupts is interrupted (not superseded); the next waits for nothing", () =>
    Effect.gen(function*() {
      const shared = overlapOutput(100)
      const ends: Array<string> = []
      const lease = makeOutputLease(shared.output, { onEnd: (h, how) => void ends.push(`${h} ${how}`) })
      const audio = Stream.fromIterable([new Uint8Array(2), new Uint8Array(2), new Uint8Array(2)])
      const a = yield* Effect.forkChild(lease.output("a").play(audio, 16_000))
      yield* advance(150)
      yield* Fiber.interrupt(a)
      assert.deepStrictEqual(ends, ["a interrupted"])
      assert.strictEqual(lease.holder(), undefined)
      const start = yield* Clock.currentTimeMillis
      const b = yield* Effect.forkChild(lease.output("b").play(audio, 16_000))
      yield* advance(1)
      assert.strictEqual(shared.probe.chunks.at(-1)!.at, start, "b started at once")
      yield* advanceBy(400)
      yield* Fiber.join(b)
      assertNoOverlap(shared.probe)
    }))

  it.effect("passes the sample rate, the observer and reportsPlayback through; a play failure stays a failure", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      const shared = AudioOutput.of({
        reportsPlayback: true,
        play: (_audio, sampleRate, observer) =>
          Effect.suspend(() => {
            seen.push(sampleRate, observer !== undefined)
            return sampleRate === 1 ? Effect.fail(new AudioError({ message: "audio client disconnected" })) : Effect.void
          })
      })
      const lease = makeOutputLease(shared)
      const out = lease.output("a")
      assert.isTrue(out.reportsPlayback)
      yield* out.play(Stream.empty, 22_050, { started: () => {}, progress: () => {} })
      const failed = yield* Effect.flip(out.play(Stream.empty, 1))
      assert.strictEqual(failed.message, "audio client disconnected")
      assert.notStrictEqual(failed.message, SUPERSEDED)
      assert.deepStrictEqual(seen, [22_050, true, 1, false])
    }))
})

// ---------------------------------------------------------------------------
// Real conversations behind the dispatcher and the lease

interface RealTarget extends DispatchTarget {
  readonly conversation: Conversation["Service"]
  readonly loop: Fiber.Fiber<void, unknown>
}

/** A sentence per clause: the reply to `text` for `assistant`. */
type Replies = (assistant: string, text: string) => ReadonlyArray<string>

const real = (options: {
  readonly replies?: Replies
  readonly config?: Partial<RouteConfig>
  readonly replyEarly?: (assistant: string) => boolean
  readonly llmDelayMs?: number
} = {}) =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const shared = overlapOutput(100)
    const gate = makeRouteGate(routeConfig(options.config))
    const lease = makeOutputLease(shared.output, {
      onStart: (holder) => gate.replyStarted(holder, Effect.runSync(Clock.currentTimeMillis)),
      onEnd: (holder) => gate.replyEnded(holder, Effect.runSync(Clock.currentTimeMillis))
    })
    // One trace service for the session: turn ids are unique across its conversations.
    const trace = yield* Effect.clockWith((clock) => Effect.succeed(makeTurnTrace({ now: () => clock.currentTimeMillisUnsafe() })))
    const replies: Replies = options.replies ?? ((assistant, text) => [`${assistant} heard ${text}.`])
    const events: Array<{ readonly assistant: string; readonly event: ConversationEvent }> = []
    const llms = new Map<string, ReturnType<typeof makeScriptedLlm>>()
    const dispatcher = makeSessionDispatcher<RealTarget>({
      ...(options.replyEarly !== undefined ? { replyEarly: options.replyEarly } : {}),
      make: (assistant, hooks) =>
        Effect.gen(function*() {
          const inbox = yield* Queue.unbounded<ConversationInput>()
          const llm = makeScriptedLlm((request): LlmScript => {
            const last = request.messages.at(-1)
            const text = last?.role === "user" ? last.content : ""
            return [...(options.llmDelayMs ? [sleep(options.llmDelayMs)] : []), ...replies(assistant, text).map((s, i) => textDelta(i === 0 ? s : ` ${s}`))]
          })
          llms.set(assistant, llm)
          const conversation = yield* makeConversationWithSetup({
            setup: Effect.succeed({ system: assistant, registry: makeToolRegistry([]) }),
            bargeIn: true,
            onEvent: (event) => {
              hooks.onEvent(event)
              events.push({ assistant, event })
            }
          }).pipe(Effect.provide(llm.layer), Effect.provideService(TurnTrace, trace))
          const tts = makeMarkerTts({ label: assistant })
          const loop = yield* Effect.forkIn(
            conversation.voice(Stream.fromQueue(inbox)).pipe(
              Effect.provideService(Tts, tts.service),
              Effect.provideService(AudioOutput, lease.output(assistant))
            ),
            scope
          )
          const offer = (input: ConversationInput) => void Queue.offerUnsafe(inbox, input)
          return { push: offer, send: (input) => (offer(input), "accepted"), conversation, loop }
        })
    })
    const speak = (steps: ReadonlyArray<SttEvent | { readonly _tag: "Sleep"; readonly millis: number }>) =>
      Effect.forEach(steps, (step) =>
        step._tag === "Sleep"
          ? Effect.sleep(step.millis)
          : Effect.flatMap(Clock.currentTimeMillis, (t) => dispatcher.dispatch(gate.filter(step, t))), { discard: true })
    const history = (assistant: string): Effect.Effect<ReadonlyArray<Message>> =>
      dispatcher.get(assistant)?.conversation.history ?? Effect.succeed([])
    const ended = (assistant: string) =>
      events.flatMap((e) => (e.assistant === assistant && e.event._tag === "TurnEnded" ? [e.event.outcome] : []))
    const played = (assistant: string) => shared.probe.chunks.filter((c) => c.text.startsWith(`<${assistant}:`)).map((c) => c.text)
    /** Every started turn ended, and no voice loop died. */
    const settled = () => {
      const started = events.filter((e) => e.event._tag === "TurnStarted").length
      const finished = events.filter((e) => e.event._tag === "TurnEnded").length
      assert.strictEqual(finished, started, "every turn ended")
      for (const [name, target] of dispatcher.conversations()) {
        assert.isUndefined(target.loop.pollUnsafe(), `${name}'s voice loop still runs`)
      }
    }
    return { dispatcher, gate, lease, shared, speak, history, ended, played, llms, events, settled }
  })

const story = (assistant: string, text: string) =>
  text.includes("story") ? ["One.", "Two.", "Three.", "Four.", "Five.", "Six."] : [`${assistant} heard ${text}.`]

describe("SessionDispatcher with real conversations", () => {
  it.effect("hand-over mid-speculation: alpha's speculative turn is discarded, bravo answers from its own history", () =>
    Effect.gen(function*() {
      const h = yield* real({ llmDelayMs: 50 })
      const talk = yield* Effect.forkChild(h.speak([
        speechStarted,
        sleep(200),
        eagerEndOfTurn("turn on the lights"),
        sleep(300), // alpha's speculative reply is ready (buffered, not played)
        endOfTurn("hey bravo turn on the lights")
      ]))
      yield* advanceBy(2_000)
      yield* Fiber.join(talk)
      assert.deepStrictEqual(h.ended("alpha"), ["discarded"])
      assert.deepStrictEqual(h.ended("bravo"), ["completed"])
      assert.strictEqual(h.llms.get("alpha")!.probe.requests.length, 1, "alpha did speculate")
      assert.deepStrictEqual(yield* h.history("alpha"), [])
      assert.deepStrictEqual(yield* h.history("bravo"), [
        { role: "user", content: "turn on the lights" },
        { role: "assistant", content: "bravo heard turn on the lights." }
      ])
      assert.deepStrictEqual(h.played("alpha"), [])
      assert.deepStrictEqual(h.played("bravo"), ["<bravo:bravo heard turn on the lights.>"])
      assertNoOverlap(h.shared.probe)
      h.settled()
    }).pipe(Effect.scoped))

  it.effect("barge-in into the other assistant: alpha's reply stops at SpeechStarted, bravo answers", () =>
    Effect.gen(function*() {
      const h = yield* real({ replies: story })
      yield* h.dispatcher.send("alpha", { _tag: "TextInput", text: "tell me a story", speak: true })
      yield* advanceBy(250) // "One.", "Two." and "Three." have started playing
      const heardBefore = h.played("alpha").length
      const talk = yield* Effect.forkChild(h.speak([speechStarted, sleep(400), endOfTurn("hey bravo what time is it")]))
      yield* advanceBy(1_500)
      yield* Fiber.join(talk)
      assert.strictEqual(h.played("alpha").length, heardBefore, "nothing more of alpha after the owner began speaking")
      assert.deepStrictEqual(h.ended("alpha"), ["interrupted"])
      const alpha = yield* h.history("alpha")
      assert.strictEqual(alpha.length, 2)
      const reply = alpha[1] as Extract<Message, { role: "assistant" }>
      assert.isTrue(reply.interrupted === true && reply.content.startsWith("One.") && !reply.content.includes("Six."))
      assert.deepStrictEqual(h.played("bravo"), ["<bravo:bravo heard what time is it.>"])
      assert.deepStrictEqual(h.ended("bravo"), ["completed"])
      assertNoOverlap(h.shared.probe)
      h.settled()
    }).pipe(Effect.scoped))

  it.effect("typed text racing speech: the final to alpha and typed text to bravo in the same instant, either order", () =>
    Effect.gen(function*() {
      for (const typedFirst of [false, true]) {
        yield* Effect.scoped(Effect.gen(function*() {
          const h = yield* real({ replies: story, llmDelayMs: 50 })
          const typed = h.dispatcher.send("bravo", { _tag: "TextInput", text: "tell me a story", speak: true })
          yield* h.speak([speechStarted, interim("lights")])
          if (typedFirst) yield* typed
          yield* h.speak([endOfTurn("lights on")])
          if (!typedFirst) yield* typed
          yield* advanceBy(2_000)
          const winner = typedFirst ? "alpha" : "bravo"
          const loser = typedFirst ? "bravo" : "alpha"
          assert.deepStrictEqual(h.ended(winner), ["completed"], `${winner} (the later one) completes`)
          assert.deepStrictEqual(h.ended(loser), ["interrupted"], `${loser} gives way`)
          assert.deepStrictEqual(h.played(loser), [], `${loser} never started playing`)
          assertNoOverlap(h.shared.probe)
          h.settled()
        }))
      }
    }))

  it.effect("a superseded play: the older turn is committed with only the clauses heard, and fails with superseded", () =>
    Effect.gen(function*() {
      const h = yield* real({ replies: story })
      yield* h.dispatcher.send("bravo", { _tag: "TextInput", text: "hello", speak: true })
      yield* advanceBy(500)
      yield* h.dispatcher.send("alpha", { _tag: "TextInput", text: "tell me a story", speak: true })
      yield* advanceBy(250)
      // bravo's conversation acts without the dispatcher's interruption (as when its turn started in a lag the
      // dispatcher could not see): only the lease stands between the two replies.
      h.dispatcher.get("bravo")!.push({ _tag: "TextInput", text: "what time is it", speak: true })
      yield* advanceBy(1_500)
      assert.deepStrictEqual(h.ended("alpha"), ["failed"], "playback failed: superseded")
      const alpha = yield* h.history("alpha")
      const reply = alpha[1] as Extract<Message, { role: "assistant" }>
      assert.isTrue(reply.interrupted === true, "committed like an interrupted turn")
      assert.isTrue(reply.content.startsWith("One.") && !reply.content.includes("Six."), reply.content)
      const heard = h.played("alpha").map((t) => t.replace(/^<alpha:|>$/g, ""))
      assert.strictEqual(reply.content, heard.join(" "), "exactly the clauses that started playing")
      assert.deepStrictEqual(h.ended("bravo"), ["completed", "completed"])
      assert.deepStrictEqual(h.played("bravo").at(-1), "<bravo:bravo heard what time is it.>")
      // The superseded reply ended before the next began.
      const lastAlpha = h.shared.probe.chunks.filter((c) => c.text.startsWith("<alpha:")).at(-1)!.at
      const firstBravo = h.shared.probe.chunks.filter((c) => c.text === "<bravo:bravo heard what time is it.>")[0]!.at
      assert.isAbove(firstBravo, lastAlpha)
      assertNoOverlap(h.shared.probe)
      h.settled()
    }).pipe(Effect.scoped))

  it.effect("follow-up: after bravo's reply has played, the next sentence without a phrase stays with bravo", () =>
    Effect.gen(function*() {
      const h = yield* real({ config: { followUpMs: { alpha: 5_000, bravo: 5_000 } } })
      yield* Effect.forkChild(h.speak([speechStarted, sleep(100), endOfTurn("hey bravo hello"), sleep(1_000), speechStarted, sleep(100), endOfTurn("and then")]))
      yield* advanceBy(2_500)
      assert.deepStrictEqual(h.played("bravo"), ["<bravo:bravo heard hello.>", "<bravo:bravo heard and then.>"])
      assert.deepStrictEqual(h.dispatcher.routeOf("bravo"), { assistant: "bravo", by: "follow-up" })
      assertNoOverlap(h.shared.probe)
      h.settled()
    }).pipe(Effect.scoped))
})

// ---------------------------------------------------------------------------
// Randomised: whatever is said, typed and stopped, no two plays overlap and nothing is left running

/** A small deterministic generator (mulberry32). */
const rng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe("SessionDispatcher: randomised", () => {
  it.effect("random speech, typed text and Stop over two assistants: never two plays at once", () =>
    Effect.gen(function*() {
      const stats = { plays: 0, superseded: 0, turns: 0 }
      for (let seed = 1; seed <= 25; seed++) {
        yield* Effect.scoped(Effect.gen(function*() {
          const random = rng(seed)
          const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(random() * xs.length)]!
          const ms = (max: number) => Math.floor(random() * max)
          const h = yield* real({
            replies: (assistant, text) => (random() < 0.5 ? story(assistant, "story") : [`${assistant} heard ${text}.`]),
            replyEarly: () => random() < 0.7,
            config: { followUpMs: { alpha: 2_000, bravo: 0 }, withoutPhrase: pick(["assistant", "decide", "nobody"] as const), fallback: "bravo" },
            llmDelayMs: 30
          })
          const actions = Effect.gen(function*() {
            for (let i = 0; i < 8; i++) {
              const kind = random()
              if (kind < 0.6) {
                const phrase = pick(["", "hey alpha ", "hey bravo "])
                const late = pick(["", "hey alpha ", "hey bravo "])
                const words = pick(["lights on", "what time is it", "tell me a story"])
                const steps: Array<SttEvent | ReturnType<typeof sleep>> = [speechStarted, sleep(ms(200))]
                if (random() < 0.5) steps.push(interim(`${phrase}${words}`.split(" ").slice(0, 2).join(" ")), sleep(ms(100)))
                if (random() < 0.7) steps.push(eagerEndOfTurn(`${phrase}${words}`), sleep(ms(400)))
                if (random() < 0.3) steps.push(turnResumed, sleep(ms(200)))
                steps.push(endOfTurn(random() < 0.3 ? `${late}${words}` : `${phrase}${words}`))
                yield* h.speak(steps)
              } else if (kind < 0.85) {
                yield* h.dispatcher.send(pick(["alpha", "bravo"]), { _tag: "TextInput", text: pick(["hello", "tell me a story"]), speak: random() < 0.8 })
              } else {
                h.dispatcher.stop(random() < 0.5 ? undefined : pick(["alpha", "bravo"]))
              }
              yield* Effect.sleep(ms(700))
            }
          })
          const driver = yield* Effect.forkChild(actions)
          yield* advanceBy(15_000, 50)
          assert.isDefined(driver.pollUnsafe(), `seed ${seed}: the script finished`)
          stats.plays += h.shared.probe.plays
          stats.superseded += h.events.filter((e) => e.event._tag === "TurnEnded" && e.event.outcome === "failed").length
          stats.turns += h.events.filter((e) => e.event._tag === "TurnStarted").length
          assertNoOverlap(h.shared.probe)
          assert.strictEqual(h.shared.probe.active, 0, `seed ${seed}: nothing plays at the end`)
          h.settled()
        }))
      }
      // The script does exercise the shared output (not a vacuous pass).
      assert.isAbove(stats.plays, 25)
      assert.isAbove(stats.turns, stats.plays)
      if (process.env.PVA_DISPATCH_STATS) console.log(stats)
    }), { timeout: 60_000 })
})

// ---------------------------------------------------------------------------
// The SessionConversation seam (`speech`), on fake engines

describe("SessionConversation: the dispatcher's speech seam", () => {
  it.live("two session conversations fed by the dispatcher answer from their own setup and history", () =>
    Effect.gen(function*() {
      const llm = scriptedLlm((text) => `Got ${text}.`)
      const engine = yield* makeEngine({
        build: fakeBuild({ stt: controlledStt().stt, llm: llm.llm }),
        configProvider: () => ConfigProvider.fromEnvRecord({}),
        onStatus: () => {}
      })
      assert.isTrue((yield* engine.start).ok)
      const shared = overlapOutput(5)
      const lease = makeOutputLease(shared.output)
      const conversations = new Map<string, SessionConversation>()
      const dispatcher = makeSessionDispatcher({
        make: (assistant, hooks) =>
          Effect.gen(function*() {
            const inbox = yield* Queue.unbounded<ConversationInput>()
            const conversation = yield* makeSessionConversation({
              engine,
              output: lease.output(assistant),
              turnTrace: makeTurnTrace(),
              setup: Effect.succeed({ system: `I am ${assistant}`, registry: makeToolRegistry([]) }),
              onEvent: hooks.onEvent,
              speech: () => Stream.fromQueue(inbox)
            })
            conversation.start()
            conversations.set(assistant, conversation)
            return { push: (input) => void Queue.offerUnsafe(inbox, input), send: conversation.send }
          })
      })
      const gate = makeRouteGate(routeConfig())
      const say = (events: ReadonlyArray<SttEvent>) => Effect.forEach(events, (e) => dispatcher.dispatch(gate.filter(e, performance.now())), { discard: true })
      yield* say([speechStarted, endOfTurn("hey bravo hello")])
      const until = (check: () => boolean) =>
        Effect.gen(function*() {
          for (let i = 0; i < 200 && !check(); i++) yield* Effect.sleep(10)
        })
      const historyOf = (a: string) => Effect.runSync(conversations.get(a)?.history ?? Effect.succeed([]))
      yield* until(() => historyOf("bravo").length === 2)
      yield* say([speechStarted, endOfTurn("good morning")])
      yield* until(() => historyOf("alpha").length === 2)
      assert.deepStrictEqual(historyOf("bravo").map((m) => m.role === "tool" ? "" : m.content), ["hello", "Got hello."])
      assert.deepStrictEqual(historyOf("alpha").map((m) => m.role === "tool" ? "" : m.content), ["good morning", "Got good morning."])
      assert.deepStrictEqual(llm.requests.map((r) => r.system), ["I am bravo", "I am alpha"])
      // Typed text goes through the conversation's own admission.
      assert.strictEqual(yield* dispatcher.send("alpha", { _tag: "TextInput", text: "typed", speak: false }), "accepted")
      yield* until(() => historyOf("alpha").length === 4)
      assertNoOverlap(shared.probe)
      for (const c of conversations.values()) yield* c.end
    }).pipe(Effect.scoped))
})
