// Engine builds and reloads (Engine.ts): the rebuild guard and the build's completion.
import { assert, describe, it } from "@effect/vitest"
import { AudioOutput, type ConversationEvent, makeTurnTrace } from "@pva/core"
import type { HostResult } from "@pva/core"
import { ConfigProvider, Deferred, Effect, Fiber, Stream } from "effect"
import { EngineBuildProblems, type EngineProviders, makeEngine, type ProviderBuilder, retryWhenPreviousModelGone } from "../src/serve/Engine.ts"
import { controlledStt, fakeBuild, scriptedLlm } from "./support/serveHarness.ts"

const base = fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm })

/** Each build runs `steps[n]` (the n-th build), then the normal fake build. */
const scriptedBuild = (steps: ReadonlyArray<Effect.Effect<void> | undefined>) => {
  let n = 0
  const build: ProviderBuilder = Effect.suspend(() => {
    const step = steps[n++]
    return step === undefined ? base : Effect.andThen(step, base)
  })
  return { build, builds: () => n }
}

const engineWith = (
  build: ProviderBuilder,
  preflight?: Effect.Effect<void, never>,
  output?: AudioOutput["Service"],
  onEvent: (event: ConversationEvent) => void = () => {}
) =>
  makeEngine({
    build,
    ...(preflight === undefined ? {} : { preflight }),
    configProvider: () => ConfigProvider.fromEnvRecord({}),
    input: { stream: Stream.never },
    output: output ?? AudioOutput.of({ play: (audio) => Stream.runDrain(audio) }),
    turnTrace: makeTurnTrace(),
    setup: Effect.succeed({ system: "", registry: { tools: [], find: () => undefined } as never }),
    onEvent,
    gate: (events) => events,
    defaultVoice: () => "standard",
    onStatus: () => {}
  })

const busy = (r: HostResult) => !r.ok && r.error.code === "busy"

describe("Engine: reload guard", () => {
  it.live("a refused reload does not release the running reload's guard; the running reload completes", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const { build, builds } = scriptedBuild([undefined, Deferred.await(gate)])
      const engine = yield* engineWith(build)
      assert.isTrue((yield* engine.start).ok)

      const a = yield* Effect.forkChild(engine.reload)
      yield* Effect.sleep(20) // A is building
      const b = yield* engine.reload
      const c = yield* engine.reload
      assert.isTrue(busy(b), "B is refused")
      assert.isTrue(busy(c), "C is refused too: B must not have released A's guard")
      assert.strictEqual(builds(), 2, "C did not start (and interrupt) another build")

      yield* Deferred.succeed(gate, undefined)
      const resultA = yield* Fiber.join(a).pipe(Effect.timeout(2_000))
      assert.isTrue(resultA.ok)
      assert.strictEqual(engine.status().state, "ready")
    }).pipe(Effect.scoped))

  it.live("two reloads during a slow preflight: one runs, the other is refused", () =>
    Effect.gen(function*() {
      const { build, builds } = scriptedBuild([])
      const engine = yield* engineWith(build, Effect.sleep(50))
      assert.isTrue((yield* engine.start).ok)
      const [x, y] = yield* Effect.all([engine.reload, engine.reload], { concurrency: 2 }).pipe(Effect.timeout(2_000))
      assert.deepStrictEqual([x.ok, y.ok].sort(), [false, true])
      assert.isTrue(busy(x.ok ? y : x))
      assert.strictEqual(builds(), 2, "the start and one reload")
      assert.strictEqual(engine.status().state, "ready")
    }).pipe(Effect.scoped))

  it.live("a build that dies (a defect) answers the reload instead of leaving it pending, and frees the guard", () =>
    Effect.gen(function*() {
      const { build } = scriptedBuild([undefined, Effect.die(new Error("native crash"))])
      const engine = yield* engineWith(build)
      assert.isTrue((yield* engine.start).ok)
      const result = yield* engine.reload.pipe(Effect.timeout(2_000))
      assert.isFalse(result.ok)
      assert.isFalse(busy(result))
      // The guard was released: the next reload builds again.
      assert.isTrue((yield* engine.reload.pipe(Effect.timeout(2_000))).ok)
    }).pipe(Effect.scoped))
})

/** Accepted by `Engine.send` (an older engine answered `true` for everything). */
const accepted = (r: unknown) => r === true || r === "accepted"

describe("Engine: startIfStopped (seventh review)", () => {
  it.live("after a busy answer, the retry does not rebuild engines that the running reload brought up", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const { build, builds } = scriptedBuild([undefined, Deferred.await(gate)])
      const engine = yield* engineWith(build)
      assert.isTrue((yield* engine.start).ok)
      const reload = yield* Effect.forkChild(engine.reload)
      yield* Effect.sleep(20) // the reload is building
      assert.isTrue(busy(yield* engine.startIfStopped), "busy while the reload holds the guard")
      yield* Deferred.succeed(gate, undefined)
      assert.isTrue((yield* Fiber.join(reload).pipe(Effect.timeout(2_000))).ok)
      // The retry: the engines are running, so nothing is rebuilt. `start` here would build a third time.
      assert.isTrue((yield* engine.startIfStopped).ok)
      assert.strictEqual(builds(), 2)
      assert.strictEqual(engine.status().state, "ready")
    }))

  it.live("it starts engines that are not running", () =>
    Effect.gen(function*() {
      const { build, builds } = scriptedBuild([])
      const engine = yield* engineWith(build)
      assert.isTrue((yield* engine.startIfStopped).ok)
      assert.strictEqual(builds(), 1)
      assert.strictEqual(engine.status().state, "ready")
    }))
})

describe("Engine: typed input admission", () => {
  /**
   * A reply that plays until interrupted, whose interruption then waits for `release` (as the real output waits
   * for the browser's final playback report): while it waits, the conversation takes no input.
   */
  const heldUp = () =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const llm = scriptedLlm((text) => `You said ${text}.`)
      /** The user text of every turn started. */
      const turns: Array<string> = []
      const onEvent = (e: ConversationEvent) => {
        if (e._tag === "TurnStarted") turns.push(e.text)
      }
      let plays = 0
      const output = AudioOutput.of({
        play: (audio) =>
          Effect.gen(function*() {
            plays++
            yield* Stream.runDrain(audio)
            return yield* Effect.never
          }).pipe(Effect.onInterrupt(() => Deferred.await(release)))
      })
      const engine = yield* engineWith(fakeBuild({ stt: controlledStt().stt, llm: llm.llm }), undefined, output, onEvent)
      // Never leave the scope's close waiting on the held-up interruption when an assertion fails.
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      assert.isTrue((yield* engine.start).ok)
      assert.isTrue(accepted(engine.send({ _tag: "TextInput", text: "first", speak: true })))
      for (let i = 0; i < 200 && plays === 0; i++) yield* Effect.sleep(5)
      assert.strictEqual(plays, 1, "the first reply is playing")
      return { engine, turns, release }
    })

  it.live("a flood of text inputs while the interruption is held up is bounded; the rest are refused busy", () =>
    Effect.gen(function*() {
      const { engine, release, turns } = yield* heldUp()
      const results = Array.from({ length: 1_000 }, (_, i) => engine.send({ _tag: "TextInput", text: `flood ${i}`, speak: true }))
      const taken = results.filter(accepted).length
      assert.isAtMost(taken, 5, `accepted ${taken} of 1000`)
      assert.isTrue(results.slice(taken).every((r) => r === "busy"), "the refused ones say busy")
      yield* Deferred.succeed(release, undefined)
      yield* Effect.sleep(300)
      assert.isAtMost(turns.length, 1 + taken, "no more turns than inputs accepted")
      // Once the backlog is gone, input is accepted again.
      assert.isTrue(accepted(engine.send({ _tag: "TextInput", text: "later", speak: false })))
    }).pipe(Effect.scoped))

  it.live("Stop is not queued behind a text backlog: the waiting texts are dropped and never start a turn", () =>
    Effect.gen(function*() {
      const { engine, release, turns } = yield* heldUp()
      for (let i = 0; i < 1_000; i++) engine.send({ _tag: "TextInput", text: `flood ${i}`, speak: true })
      // Repeated Stop presses are coalesced: every one is accepted, none of them queues.
      for (let i = 0; i < 1_000; i++) assert.isTrue(accepted(engine.send({ _tag: "Interrupt" })))
      yield* Deferred.succeed(release, undefined)
      yield* Effect.sleep(300)
      // The first reply, plus at most the one text the conversation had already taken when Stop was pressed.
      assert.isAtMost(turns.length, 2, `turns started: ${turns.length}`)
      const before = turns.length
      assert.isTrue(accepted(engine.send({ _tag: "TextInput", text: "after stop", speak: false })))
      for (let i = 0; i < 100 && turns.length === before; i++) yield* Effect.sleep(5)
      assert.deepStrictEqual(turns.slice(before), ["after stop"])
    }).pipe(Effect.scoped))
})

void (undefined as unknown as EngineProviders)

describe("Engine: a build refused because the previous recogniser is still shutting down", () => {
  it.live("is retried by itself once that recogniser has gone, and says so meanwhile", () =>
    Effect.gen(function*() {
      const gone = yield* Deferred.make<void>()
      const orphaned = "The previous local speech model has not shut down: a native decode has not finished"
      let n = 0
      const build: ProviderBuilder = Effect.suspend(() =>
        n++ === 1 ? Effect.fail(new EngineBuildProblems({ problems: [{ stage: "speech-to-text (STT_PROVIDER)", message: orphaned }] })) : base
      )
      const statuses: Array<string> = []
      const engine = yield* makeEngine({
        build,
        configProvider: () => ConfigProvider.fromEnvRecord({}),
        input: { stream: Stream.never },
        output: AudioOutput.of({ play: (audio) => Stream.runDrain(audio) }),
        turnTrace: makeTurnTrace(),
        setup: Effect.succeed({ system: "", registry: { tools: [], find: () => undefined } as never }),
        onEvent: () => {},
        gate: (events) => events,
        defaultVoice: () => "standard",
        onStatus: (s) => statuses.push(s.state),
        retryAfter: (problems) => problems.some((p) => p.message.startsWith(orphaned)) ? Deferred.await(gone) : undefined
      })
      assert.isTrue((yield* engine.start).ok)
      const reload = yield* engine.reload
      assert.isFalse(reload.ok)
      assert.strictEqual(engine.status().state, "failed")
      assert.isTrue(engine.status().problems.some((p) => p.message.includes("will start by themselves")))
      yield* Deferred.succeed(gone, undefined)
      for (let i = 0; i < 100 && engine.status().state !== "ready"; i++) yield* Effect.sleep(10)
      assert.strictEqual(engine.status().state, "ready")
      assert.strictEqual(n, 3)
    }))

  it("the default retry recognises the recogniser's message", () => {
    assert.isDefined(retryWhenPreviousModelGone([{ stage: "stt", message: "x The previous local speech model has not shut down: a native decode has not finished, and it still holds its memory. No second model is loaded beside it; try again once it finishes, or restart the assistant." }]))
    assert.isUndefined(retryWhenPreviousModelGone([{ stage: "stt", message: "model files missing" }]))
  })
})
