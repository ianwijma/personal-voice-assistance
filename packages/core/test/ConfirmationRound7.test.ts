// Review round 7: the confirmation core conducts (round 6) made sound.
//
// 1. Eligibility is a property of the answering utterance, fixed when it begins: only an utterance
//    that began after the question had been played to its end (typed: submitted after arming) can
//    answer it. An earlier one drops the confirmation; core says so.
// 2. The question states every value that will be executed, or the proposal is refused.
// 3. Validation, consumption and the start of the action are one step at promotion; nothing claims
//    success before it happened; an interrupted turn does not cancel or lose the action.
// 5. The single-model API consumes its own confirmations.
// 6. Every answered confirmation leaves a spoken acknowledgement and an explicit outcome in history.
// 8. An authoritative final playback count decides what history records, whatever the outcome.
import { assert, describe, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { actionTool, ActionError, type ActionOutcome, defineAction, Param, type ParamOption, registerActions, type RegisteredAction } from "../src/Actions.ts"
import type { Agent, AgentEvent } from "../src/Agent.ts"
import { Conversation, DEFAULT_CONFIRM_TEXTS } from "../src/Conversation.ts"
import type { AgentTurnSetup, ConversationEvent, ConversationInput, PlaybackObserver } from "../src/ConversationEvents.ts"
import { confirmationQuestion } from "../src/Decision.ts"
import type { LlmEvent, LlmRequest, Message, ToolResult } from "../src/Domain.ts"
import { makeModelAgent } from "../src/ModelAgent.ts"
import { PROPOSED_RESULT } from "../src/PendingIntents.ts"
import { AudioOutput, Llm } from "../src/Services.ts"
import { makeToolRegistry, ToolRegistry } from "../src/ToolRegistry.ts"
import { traceTimeline } from "../src/TurnTrace.ts"
import {
  eagerEndOfTurn,
  endOfTurn,
  makeAgentSetup,
  makeMarkerTts,
  makeRecordingAudioOutput,
  scripted,
  sleep,
  speechStarted,
  testTurnTraceLayer
} from "../src/testing.ts"

const T = DEFAULT_CONFIRM_TEXTS
const rooms: Array<ParamOption> = [{ value: "area:kitchen", label: "Kitchen" }, { value: "area:bedroom", label: "Bedroom" }]
const roomLabel = (v: unknown) => rooms.find((r) => r.value === v)?.label ?? String(v)

interface HouseOptions {
  /** `all_off`'s run: default records "all_off". */
  readonly allOffRun?: (runs: Array<string>) => Effect.Effect<ActionOutcome | void, ActionError>
  readonly allOffAnnounce?: string | null
}

/** `all_off` (no values), `wipe` (a room; its own question names it), `mute` (no announcement, says nothing), `lights_on` (no confirmation). */
const house = (options: HouseOptions = {}) => {
  const runs: Array<string> = []
  const announce = options.allOffAnnounce === undefined ? "Everything is off." : options.allOffAnnounce
  const register = () =>
    registerActions("home", [
      defineAction({
        id: "all_off",
        label: "Switch everything off",
        description: "Switch off every light in the house at once.",
        params: {},
        confirm: true,
        ...(announce !== null ? { announce: () => announce } : {}),
        run: () => options.allOffRun?.(runs) ?? Effect.sync(() => void runs.push("all_off"))
      }),
      defineAction({
        id: "wipe",
        label: "Reset the room",
        description: "Reset every device in a room.",
        params: { target: Param.dynamic({ label: "Room", options: () => rooms }) },
        confirm: (p) => `Reset the ${roomLabel(p.target).toLowerCase()}? Every device goes back to its defaults.`,
        run: (p) => Effect.sync(() => void runs.push(`wipe ${String(p.target)}`))
      }),
      defineAction({
        id: "mute",
        label: "Mute the doorbell",
        description: "Silence the doorbell.",
        params: {},
        confirm: true,
        run: () => Effect.sync(() => void runs.push("mute"))
      }),
      defineAction({
        id: "lights_on",
        label: "Turn lights on",
        description: "Switch on the lights in a room.",
        params: { target: Param.dynamic({ label: "Room", options: () => rooms }) },
        run: (p) => Effect.sync(() => void runs.push(`lights_on ${String(p.target)}`))
      })
    ])
  return { runs, register }
}

const call = (name: string, input: unknown = {}, id = "c1"): LlmEvent => ({ _tag: "ToolCall", id, name, input })

/** A scripted `Llm`: on a user message the events `plan(text)` gives (none: says "ok"); after tool results it keeps talking (discarded by core). */
const scriptedLlm = (plan: (text: string) => ReadonlyArray<LlmEvent>) => {
  const results: Array<ToolResult> = []
  const requests: Array<LlmRequest> = []
  const users: Array<string> = []
  const llm = {
    stream: (request: LlmRequest) =>
      Stream.suspend(() => {
        requests.push(request)
        const last = request.messages[request.messages.length - 1]!
        if (last.role === "tool") {
          results.push(...last.results)
          return Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: "Done, all switched off!" }, { _tag: "Done", stopReason: "end" }])
        }
        if (last.role === "user") users.push(last.content)
        const events = last.role === "user" ? plan(last.content) : []
        const calls = events.some((e) => e._tag === "ToolCall")
        return Stream.fromIterable<LlmEvent>(
          events.length > 0 ? [...events, { _tag: "Done", stopReason: calls ? "tool_use" : "end" }] : [{ _tag: "TextDelta", text: "ok" }, { _tag: "Done", stopReason: "end" }]
        )
      })
  }
  return { llm, results, requests, users }
}
const scriptedModel = (plan: (text: string) => ReadonlyArray<LlmEvent>) => {
  const s = scriptedLlm(plan)
  const agent: Agent = { id: "main", name: "Main", kind: "model", speculate: true, firstEventTimeoutMs: 5_000, ...makeModelAgent({ llm: s.llm }) }
  return { ...s, agent }
}

/** A harness agent calling the assistant's tools in-process, then talking on. */
const scriptedHarness = (plan: (text: string) => { readonly name: string; readonly input: unknown } | undefined) => {
  const results: Array<ToolResult> = []
  const histories: Array<ReadonlyArray<Message>> = []
  const agent: Agent = {
    id: "main",
    name: "Harness",
    kind: "harness",
    speculate: false,
    firstEventTimeoutMs: 5_000,
    turn: (input) =>
      Stream.suspend(() => {
        histories.push(input.history)
        const c = plan(input.text)
        if (c === undefined) return Stream.make({ _tag: "TextDelta", text: "ok" } as AgentEvent)
        const tc = { id: `h${input.turnId}`, name: c.name, input: c.input }
        return Stream.make({ _tag: "ToolStarted", call: tc } as AgentEvent).pipe(
          Stream.concat(Stream.unwrap(Effect.map(input.tools.run(tc), (r): Stream.Stream<AgentEvent> => {
            results.push(r)
            return Stream.make({ _tag: "ToolFinished", result: r, ms: 1 } as AgentEvent)
          }))),
          Stream.concat(Stream.make({ _tag: "TextDelta", text: "Done!" } as AgentEvent))
        )
      })
  }
  return { agent, results, histories }
}

const setupFor = (agents: ReadonlyArray<Agent>, actions: () => ReadonlyArray<RegisteredAction>): Effect.Effect<AgentTurnSetup> => {
  let current: AgentTurnSetup | undefined
  let built: ReadonlyArray<RegisteredAction> | undefined
  return Effect.sync(() => {
    const acts = actions()
    if (current !== undefined && built === acts) return current
    built = acts
    current = makeAgentSetup({
      agents,
      routing: { defaultAgent: "main" },
      registry: makeToolRegistry([{ name: "home", tools: acts.map(actionTool) }]),
      extra: { actions: acts }
    })
    return current
  })
}

const conversation = (setup: Effect.Effect<AgentTurnSetup>, events?: Array<ConversationEvent>, extra: Record<string, unknown> = {}) =>
  Conversation.layerWithAgents({ setup, confirmActions: "on", ...(events !== undefined ? { onEvent: (e) => void events.push(e) } : {}), ...extra }).pipe(
    Layer.provideMerge(testTurnTraceLayer)
  )
const typed = (text: string) =>
  Effect.flatMap(Effect.service(Conversation), (c) => Stream.runCollect(c.textTurn(text)).pipe(Effect.map((chunks) => Array.from(chunks).join(""))))
const historyOf = Effect.flatMap(Effect.service(Conversation), (c) => c.history)
const show = (h: ReadonlyArray<Message>) =>
  h.map((m) => (m.role === "tool" ? `tool: ${m.results.map((r) => r.content).join()}` : `${m.role}: ${m.content}${m.role === "assistant" && m.interrupted === true ? " (interrupted)" : ""}`))
const notes = (h: ReadonlyArray<Message>) => h.flatMap((m) => (m.role === "assistant" && m.content.startsWith("[") ? [m.content] : []))

// ---------------------------------------------------------------------------
// Spoken runs.

interface VoiceOptions {
  readonly output?: Layer.Layer<AudioOutput>
  readonly ttsDelay?: number
  readonly bargeIn?: boolean
  readonly window?: number
  readonly house?: HouseOptions
  /** What the model says before calling the tool. */
  readonly before?: string
}

/** Runs `script` through `voice` with a model proposing `all_off` on "switch everything off" and `wipe` on "reset the kitchen". */
const voiceRun = (script: ReadonlyArray<ConversationInput | ReturnType<typeof sleep>>, options: VoiceOptions = {}) => {
  const h = house(options.house)
  const acts = h.register()
  const lead = (events: Array<LlmEvent>): Array<LlmEvent> => (options.before !== undefined ? [{ _tag: "TextDelta", text: `${options.before} ` }, ...events] : events)
  const model = scriptedModel((text) =>
    text === "switch everything off" ? lead([call("home_all_off")]) : text === "reset the kitchen" ? lead([call("home_wipe", { target: "kitchen" })]) : []
  )
  const events: Array<ConversationEvent> = []
  const extra: Record<string, unknown> = {}
  if (options.window !== undefined) extra.confirmWindowMs = options.window
  if (options.bargeIn !== undefined) extra.bargeIn = options.bargeIn
  const layer = conversation(setupFor([model.agent], () => acts), events, extra).pipe(
    Layer.provideMerge(Layer.mergeAll(makeMarkerTts({ delayMillis: options.ttsDelay ?? 0 }).layer, options.output ?? makeRecordingAudioOutput({ chunkMillis: 100 }).layer))
  )
  return Effect.gen(function*() {
    const c = yield* Conversation
    const fiber = yield* Effect.forkChild(c.voice(scripted(script)))
    for (let i = 0; i < 400; i++) {
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      yield* TestClock.adjust(100)
    }
    yield* Fiber.join(fiber)
    const spoken = events.flatMap((e) => (e._tag === "ClauseQueued" ? [e.text] : []))
    return { runs: h.runs, model, events, spoken, said: spoken.join(" "), history: yield* c.history }
  }).pipe(Effect.provide(layer))
}

/** An output that reports progress when a chunk is handed over, takes 100 ms per chunk, and on its end (after `cleanupMs`) reports `finalAt(sizes)`. */
const reportingOutput = (finalAt: (sizes: ReadonlyArray<number>) => number, cleanupMs = 0) =>
  Layer.succeed(
    AudioOutput,
    AudioOutput.of({
      reportsPlayback: true,
      play: <E>(audio: Stream.Stream<Uint8Array, E>, _rate: number, observer?: PlaybackObserver) =>
        Effect.suspend(() => {
          let played = 0
          const sizes: Array<number> = []
          return audio.pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function*() {
                if (sizes.length === 0) observer?.started()
                sizes.push(chunk.length >> 1)
                played += chunk.length >> 1
                observer?.progress(played)
                yield* Effect.sleep(100)
              })
            ),
            Effect.onExit(() => (cleanupMs > 0 ? Effect.sleep(cleanupMs) : Effect.void).pipe(Effect.andThen(Effect.sync(() => observer?.final?.(finalAt(sizes))))))
          )
        })
    })
  )
const total = (sizes: ReadonlyArray<number>) => sizes.reduce((a, b) => a + b, 0)

// "Reset the kitchen?" plays [0, 100) ms, "Every device goes back to its defaults." [100, 200); armed at 200.
const yesAt = (start: number, finalAt = start + 50): Array<ConversationInput | ReturnType<typeof sleep>> => [
  speechStarted,
  endOfTurn("reset the kitchen"),
  sleep(start),
  speechStarted,
  sleep(finalAt - start),
  endOfTurn("yes")
]

describe("round 7 finding 1: an answer is eligible only if it began after the question had been played to its end", () => {
  // The reviewer's sequences first.
  it.effect("reviewer, barge-in off: SpeechStarted at 100 ms, before the question's audio (500 ms), yes after arming: not run", () =>
    Effect.gen(function*() {
      // TTS takes 500 ms for the first clause: "Switch everything off?" plays [500, 600), armed at 600.
      const r = yield* voiceRun([speechStarted, endOfTurn("switch everything off"), sleep(100), speechStarted, sleep(1_000), endOfTurn("yes")], { bargeIn: false, ttsDelay: 500 })
      assert.deepStrictEqual(r.runs, [])
      assert.include(r.said, T.tooEarly)
    }))

  it.effect("reviewer, barge-in: SpeechStarted during the first clause, cleanup 100 ms, final count reaching the second clause: not run", () =>
    Effect.gen(function*() {
      const output = reportingOutput((sizes) => total(sizes), 100)
      const r = yield* voiceRun(yesAt(50, 400), { output })
      assert.deepStrictEqual(r.runs, [])
      assert.include(r.said, T.tooEarly)
    }))

  it.effect("reviewer: speech before the proposal (\"Shall I read the news?\"), yes during the action question's opening: not run; the question stands apart", () =>
    Effect.gen(function*() {
      // "Shall I read the news?" [0, 100), "To confirm:" [100, 200), "Switch everything off?" [200, 300).
      const on = yield* voiceRun([speechStarted, endOfTurn("switch everything off"), sleep(150), speechStarted, sleep(50), endOfTurn("yes")], { before: "Shall I read the news?" })
      assert.deepStrictEqual(on.runs, [])
      assert.deepStrictEqual(on.spoken.slice(0, 3), ["Shall I read the news?", T.leadIn, "Switch everything off?"])
      assert.include(on.said, T.tooEarly)
      const off = yield* voiceRun([speechStarted, endOfTurn("switch everything off"), sleep(150), speechStarted, sleep(650), endOfTurn("yes")], { before: "Shall I read the news?", bargeIn: false })
      assert.deepStrictEqual(off.runs, [])
      assert.include(off.said, T.tooEarly)
      const after = yield* voiceRun([speechStarted, endOfTurn("switch everything off"), sleep(400), speechStarted, sleep(50), endOfTurn("yes")], { before: "Shall I read the news?" })
      assert.deepStrictEqual(after.runs, ["all_off"])
    }))

  // The table: start of the answering utterance against the question's playback.
  const table: ReadonlyArray<{ readonly name: string; readonly start: number; readonly options?: VoiceOptions; readonly run: boolean; readonly says?: string; readonly before?: string }> = [
    { name: "before any audio (TTS slow: first audio at 300 ms)", start: 100, options: { ttsDelay: 300 }, run: false, says: T.tooEarly },
    { name: "during the earlier speech of the turn", start: 50, options: { before: "Sure." }, run: false, says: T.tooEarly },
    { name: "during the lead-in", start: 150, options: { before: "Sure." }, run: false, says: T.tooEarly },
    { name: "during the first clause", start: 50, run: false, says: T.tooEarly },
    { name: "during the last clause", start: 150, run: false, says: T.tooEarly },
    { name: "exactly at the end (the speech event is handled before playback reports its end)", start: 200, run: false, says: T.tooEarly },
    { name: "after the end", start: 300, run: true },
    { name: "after the end of a question with a lead-in", start: 450, options: { before: "Sure." }, run: true },
    { name: "after the window", start: 200 + 15_000 + 100, run: false, says: T.lapsed }
  ]
  for (const bargeIn of [true, false]) {
    for (const row of table) {
      it.effect(`spoken, barge-in ${bargeIn ? "on" : "off"}: ${row.name} → ${row.run ? "run" : "not run"}`, () =>
        Effect.gen(function*() {
          // With barge-in off the final transcript must arrive after the question's turn ended (else it is ignored).
          const finalAt = bargeIn ? row.start + 50 : Math.max(row.start + 50, 1_000)
          const r = yield* voiceRun(yesAt(row.start, finalAt), { ...row.options, bargeIn })
          assert.deepStrictEqual(r.runs, row.run ? ["wipe area:kitchen"] : [])
          if (row.says !== undefined) assert.include(r.said, row.says)
        }))
    }
  }

  for (const row of [{ at: 150, run: false }, { at: 200, run: false }, { at: 300, run: true }]) {
    it.effect(`typed: submitted at ${row.at} ms → ${row.run ? "run" : "not run"}`, () =>
      Effect.gen(function*() {
        const r = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(row.at), { _tag: "TextInput", text: "yes", speak: false }])
        assert.deepStrictEqual(r.runs, row.run ? ["wipe area:kitchen"] : [])
      }))
  }

  it.effect("final count lower than the progress known at the utterance's start: the question was not played to its end, not armed", () =>
    Effect.gen(function*() {
      // Progress reaches both clauses, then playback returns with a final count inside the first clause.
      const output = reportingOutput((sizes) => (sizes[0] ?? 0) - 1)
      const r = yield* voiceRun(yesAt(300), { output })
      assert.deepStrictEqual(r.runs, [])
      assert.include(r.said, T.tooEarly)
    }))

  it.effect("final count higher than the progress known at the utterance's start: still not eligible", () =>
    Effect.gen(function*() {
      const output = reportingOutput((sizes) => total(sizes) * 10, 100)
      const r = yield* voiceRun(yesAt(150, 400), { output })
      assert.deepStrictEqual(r.runs, [])
    }))

  it.effect("final count equal to the whole question: armed at the end; an answer after it runs", () =>
    Effect.gen(function*() {
      const output = reportingOutput((sizes) => total(sizes))
      const r = yield* voiceRun(yesAt(300), { output })
      assert.deepStrictEqual(r.runs, ["wipe area:kitchen"])
    }))

  it.effect("a no that began too early cancels (nothing runs either way) and says so", () =>
    Effect.gen(function*() {
      const r = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(150), speechStarted, sleep(50), endOfTurn("no")])
      assert.deepStrictEqual(r.runs, [])
      assert.include(r.said, T.cancelled)
    }))

  it.effect("eager yes inside the window, final after it closed: the window is read at promotion; core says it came too late", () =>
    Effect.gen(function*() {
      const r = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(14_000), speechStarted, eagerEndOfTurn("yes"), sleep(2_000), endOfTurn("yes")])
      assert.deepStrictEqual(r.runs, [])
      assert.include(r.said, T.lapsed)
    }))

  it.effect("a too-early answer leaves an explicit note in history", () =>
    Effect.gen(function*() {
      const r = yield* voiceRun(yesAt(150))
      assert.isTrue(notes(r.history).some((n) => n.includes("Reset the room") && n.includes("before the confirmation question had finished")), show(r.history).join("\n"))
    }))
})

// ---------------------------------------------------------------------------

describe("round 7 finding 2: the question states every value that will be executed", () => {
  const levels = () =>
    registerActions("home", [
      defineAction({
        id: "reset",
        label: "Reset the room",
        description: "Reset every device in a room.",
        params: { room: Param.dynamic({ label: "Room", options: () => rooms }) },
        confirm: true,
        run: () => Effect.void
      }),
      defineAction({
        id: "reset_vague",
        label: "Reset the room",
        description: "Reset every device in a room.",
        params: { room: Param.dynamic({ label: "Room", options: () => rooms }) },
        confirm: () => "Reset the room?",
        run: () => Effect.void
      }),
      defineAction({
        id: "reset_wrong",
        label: "Reset the room",
        description: "Reset every device in a room.",
        params: { room: Param.dynamic({ label: "Room", options: () => rooms }) },
        confirm: () => "Reset the kitchen?",
        run: () => Effect.void
      }),
      defineAction({
        id: "reset_throws",
        label: "Reset the room",
        description: "Reset every device in a room.",
        params: { room: Param.dynamic({ label: "Room", options: () => rooms }) },
        confirm: () => {
          throw new Error("broken")
        },
        run: () => Effect.void
      }),
      defineAction({
        id: "reset_empty",
        label: "Reset the room",
        description: "Reset every device in a room.",
        params: { room: Param.dynamic({ label: "Room", options: () => rooms }) },
        confirm: () => "  ",
        run: () => Effect.void
      }),
      defineAction({
        id: "level",
        label: "Set the level",
        description: "Set a level in percent.",
        params: { room: Param.dynamic({ label: "Room", options: () => rooms }), level: Param.number({ label: "Level", min: 0, max: 100, unit: "percent" }) },
        confirm: (p) => `Set the ${roomLabel(p.room).toLowerCase()} to ${String(p.level)} percent?`,
        run: () => Effect.void
      }),
      defineAction({
        id: "level_vague",
        label: "Set the level",
        description: "Set a level in percent.",
        params: { room: Param.dynamic({ label: "Room", options: () => rooms }), level: Param.number({ label: "Level", min: 0, max: 100, unit: "percent" }) },
        confirm: (p) => `Set the ${roomLabel(p.room).toLowerCase()} level?`,
        run: () => Effect.void
      }),
      defineAction({
        id: "level_generated",
        label: "Set the level",
        description: "Set a level in percent.",
        params: { room: Param.dynamic({ label: "Room", options: () => rooms }), level: Param.number({ label: "Level", min: 0, max: 100, unit: "percent" }) },
        confirm: true,
        run: () => Effect.void
      }),
      defineAction({
        id: "everything",
        label: "Switch everything off",
        description: "Everything off.",
        params: {},
        confirm: true,
        run: () => Effect.void
      })
    ])
  const acts = levels()
  const byId = (id: string) => acts.find((a) => a.definition.id === id)!

  it("generated: the label followed by each parameter's label and spoken value", () => {
    const q = confirmationQuestion(byId("reset"), { room: "area:bedroom" })
    assert.deepStrictEqual(q, { question: "Reset the room: room Bedroom?" })
    assert.deepStrictEqual(confirmationQuestion(byId("level_generated"), { room: "area:kitchen", level: 40 }), { question: "Set the level: room Kitchen, level 40 percent?" })
    assert.deepStrictEqual(confirmationQuestion(byId("everything"), {}), { question: "Switch everything off?" })
  })

  it("a module's own text is never used (after the final review): core's question, whatever the function returns or does", () => {
    for (const id of ["reset_vague", "reset_wrong", "reset_throws", "reset_empty"]) {
      assert.deepStrictEqual(confirmationQuestion(byId(id), { room: "area:bedroom" }), { question: "Reset the room: room Bedroom?" }, id)
    }
    for (const id of ["level", "level_vague"]) {
      assert.deepStrictEqual(confirmationQuestion(byId(id), { room: "area:kitchen", level: 40 }), { question: "Set the level: room Kitchen, level 40 percent?" }, id)
    }
  })

  it.effect("reviewer: \"reset the kitchen\", the model proposes bedroom: the owner hears Bedroom, and yes runs what was heard", () => {
    const ran: Array<string> = []
    const a = registerActions("home", [defineAction({
      id: "reset",
      label: "Reset the room",
      description: "Reset every device in a room.",
      params: { room: Param.dynamic({ label: "Room", options: () => rooms }) },
      confirm: true,
      run: (p) => Effect.sync(() => void ran.push(String(p.room)))
    })])
    const model = scriptedModel((text) => (text === "reset the kitchen" ? [call("home_reset", { room: "bedroom" })] : []))
    return Effect.gen(function*() {
      const said = yield* typed("reset the kitchen")
      assert.include(said, "Bedroom")
      assert.notInclude(said, "Kitchen")
      yield* typed("yes")
      assert.deepStrictEqual(ran, ["area:bedroom"])
    }).pipe(Effect.provide(conversation(setupFor([model.agent], () => a))))
  })
})

// ---------------------------------------------------------------------------

describe("round 7 finding 3: consumption and the start of the action are one step; nothing claims what has not happened", () => {
  it.effect("reviewer probe 1: the answer stream paused after its first chunk; the action removed and the window expired meanwhile: it ran once, at consumption", () => {
    const h = house()
    let acts: ReadonlyArray<RegisteredAction> = h.register()
    const model = scriptedModel((text) => (text === "switch everything off" ? [call("home_all_off")] : []))
    return Effect.gen(function*() {
      const c = yield* Conversation
      yield* typed("switch everything off")
      yield* TestClock.adjust(1_000)
      const gate = yield* Deferred.make<void>()
      const first = yield* Deferred.make<string>()
      let n = 0
      const fiber = yield* c.textTurn("yes").pipe(
        Stream.tap((chunk) => (n++ === 0 ? Deferred.succeed(first, chunk).pipe(Effect.andThen(Deferred.await(gate))) : Effect.void)),
        Stream.runCollect,
        Effect.forkChild
      )
      const chunk = yield* Deferred.await(first)
      assert.strictEqual(chunk, "Everything is off.")
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      assert.deepStrictEqual(h.runs, ["all_off"], "started at consumption, before anything was said")
      acts = [] // the module is disabled while the output is delivered
      yield* TestClock.adjust(20_000)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(h.runs, ["all_off"], "ran once")
      const history = yield* historyOf
      assert.isTrue(notes(history).some((x) => x.includes("ran and succeeded")), show(history).join("\n"))
    }).pipe(Effect.provide(conversation(setupFor([model.agent], () => acts))))
  })

  it.effect("reviewer probe 2: the consumer stops after the first announcement chunk: the action ran, history records its real outcome, nothing is lost", () => {
    const h = house()
    const acts = h.register()
    const model = scriptedModel((text) => (text === "switch everything off" ? [call("home_all_off")] : []))
    return Effect.gen(function*() {
      const c = yield* Conversation
      yield* typed("switch everything off")
      const firstOnly = yield* c.textTurn("yes").pipe(Stream.take(1), Stream.runCollect)
      assert.deepStrictEqual(Array.from(firstOnly), ["Everything is off."])
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      assert.deepStrictEqual(h.runs, ["all_off"])
      const history = yield* historyOf
      assert.isTrue(notes(history).some((x) => x.includes("Switch everything off") && x.includes("ran and succeeded")), show(history).join("\n"))
      yield* typed("yes")
      assert.deepStrictEqual(h.runs, ["all_off"], "used once")
    }).pipe(Effect.provide(conversation(setupFor([model.agent], () => acts))))
  })

  // Stages of a spoken answer turn with a slow action (300 ms) that says something when done:
  // "Switch everything off?" [0, 100), armed at 100; "yes" at 350: the action starts at 350 and ends
  // at 650; "Switching everything off." plays [350, 450); the result "All lights are off." [650, 750).
  const slowHouse = (fail = false): HouseOptions => ({
    allOffAnnounce: "Switching everything off.",
    allOffRun: (runs) =>
      Effect.sync(() => void runs.push("start")).pipe(
        Effect.andThen(Effect.sleep(300)),
        Effect.andThen(fail ? Effect.fail(new ActionError({ message: "The hub did not answer." })) : Effect.sync((): ActionOutcome => {
          runs.push("end")
          return { say: "All lights are off." }
        }))
      )
  })
  const staged = (stopAt: number | undefined, fail = false) => {
    const h = house(slowHouse(fail))
    const acts = h.register()
    const model = scriptedModel((text) => (text === "switch everything off" ? [call("home_all_off")] : []))
    const events: Array<ConversationEvent> = []
    const layer = conversation(setupFor([model.agent], () => acts), events).pipe(
      Layer.provideMerge(Layer.mergeAll(makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 100 }).layer))
    )
    const script: Array<ConversationInput | ReturnType<typeof sleep>> = [speechStarted, endOfTurn("switch everything off"), sleep(300), speechStarted, sleep(50), endOfTurn("yes")]
    if (stopAt !== undefined) script.push(sleep(stopAt - 350), { _tag: "Interrupt" })
    return Effect.gen(function*() {
      const c = yield* Conversation
      const fiber = yield* Effect.forkChild(c.voice(scripted(script)))
      const snapshots = new Map<number, { readonly runs: ReadonlyArray<string>; readonly history: ReadonlyArray<string> }>()
      for (let t = 0; t < 3_000; t += 10) {
        yield* Effect.repeat(Effect.yieldNow, { times: 20 })
        const now = yield* Clock.currentTimeMillis
        if (now % 50 === 0) snapshots.set(now, { runs: h.runs.slice(), history: show(yield* c.history) })
        yield* TestClock.adjust(10)
      }
      yield* Fiber.join(fiber)
      return { h, events, snapshots, history: yield* c.history }
    }).pipe(Effect.provide(layer))
  }

  it.effect("not interrupted: the announcement after the start, the result only after the action succeeded, and the outcome recorded", () =>
    Effect.gen(function*() {
      const r = yield* staged(undefined)
      assert.deepStrictEqual(r.h.runs, ["start", "end"])
      const order = r.events.flatMap((e) => (e._tag === "ActionStarted" ? ["started"] : e._tag === "ActionFinished" ? ["finished"] : e._tag === "ClauseQueued" ? [e.text] : []))
      assert.deepStrictEqual(order.slice(-4), ["started", "Switching everything off.", "finished", "All lights are off."])
      assert.deepStrictEqual(show(r.history).slice(-4), [
        "assistant: Switch everything off?",
        "user: yes",
        "assistant: Switching everything off. All lights are off.",
        "assistant: [Switch everything off: the owner confirmed; it ran and succeeded.]"
      ])
    }))

  it.effect("stopped during the announcement: the action still completes; history first says it is running, then its real outcome", () =>
    Effect.gen(function*() {
      const r = yield* staged(400)
      assert.deepStrictEqual(r.h.runs, ["start", "end"])
      const mid = r.snapshots.get(500)!
      assert.deepStrictEqual(mid.runs, ["start"])
      assert.include(mid.history.at(-1)!, "outcome was not known yet")
      assert.deepStrictEqual(show(r.history).slice(-3), [
        "user: yes",
        "assistant: Switching everything off. (interrupted)",
        "assistant: [Switch everything off: the owner confirmed; it ran and succeeded.]"
      ])
    }))

  it.effect("time line: the action is an entry from its start; stopped before it finished, it stays a started entry without a duration", () =>
    Effect.gen(function*() {
      const actionOf = (r: { readonly events: ReadonlyArray<ConversationEvent> }) => {
        const ended = r.events.flatMap((e) => (e._tag === "TurnEnded" && e.trace.events?.some((x) => x.name === "action") === true ? [e] : []))
        assert.strictEqual(ended.length, 1)
        const line = traceTimeline(ended[0]!.trace)
        return { action: line.filter((x) => x.name === "action"), turnEnded: line.find((x) => x.name === "turnEnded")! }
      }
      // Stopped at 400, the action runs [350, 650): on the time line when the turn ended, and never changed after.
      const stopped = actionOf(yield* staged(400))
      assert.strictEqual(stopped.action.length, 1)
      assert.strictEqual(stopped.action[0]!.ms, undefined)
      assert.strictEqual(stopped.action[0]!.detail, "home_all_off")
      assert.isBelow(stopped.action[0]!.at, stopped.turnEnded.at)
      // Not stopped: the same entry, given its duration when the action finished.
      const whole = actionOf(yield* staged(undefined))
      assert.strictEqual(whole.action.length, 1)
      assert.strictEqual(whole.action[0]!.ms, 300)
    }))

  it.effect("stopped while waiting for the action (nothing playing): nothing claims success; the outcome arrives in history", () =>
    Effect.gen(function*() {
      const r = yield* staged(500)
      assert.deepStrictEqual(r.h.runs, ["start", "end"])
      assert.notInclude(r.events.flatMap((e) => (e._tag === "ClauseQueued" ? [e.text] : [])), "All lights are off.")
      assert.deepStrictEqual(show(r.history).slice(-1), ["assistant: [Switch everything off: the owner confirmed; it ran and succeeded.]"])
    }))

  it.effect("stopped during the result: what was heard and the outcome", () =>
    Effect.gen(function*() {
      const r = yield* staged(700)
      assert.deepStrictEqual(show(r.history).slice(-2), [
        "assistant: Switching everything off. All lights are off. (interrupted)",
        "assistant: [Switch everything off: the owner confirmed; it ran and succeeded.]"
      ])
    }))

  it.effect("a failing action, stopped while running: recorded as failed with its reason; success is never claimed", () =>
    Effect.gen(function*() {
      const r = yield* staged(500, true)
      assert.deepStrictEqual(r.h.runs, ["start"])
      assert.deepStrictEqual(show(r.history).slice(-1), ["assistant: [Switch everything off: the owner confirmed; it ran and failed: The hub did not answer.]"])
    }))

  it.effect("a failing action, not interrupted: the failure is spoken", () =>
    Effect.gen(function*() {
      const r = yield* staged(undefined, true)
      const spoken = r.events.flatMap((e) => (e._tag === "ClauseQueued" ? [e.text] : []))
      assert.include(spoken, "Sorry, The hub did not answer.")
      assert.notInclude(spoken, "All lights are off.")
    }))
})

// ---------------------------------------------------------------------------

describe("round 7 finding 5: the single-model API consumes its own confirmations", () => {
  const legacy = (actions: () => ReadonlyArray<RegisteredAction>, plan: (text: string) => ReadonlyArray<LlmEvent>) => {
    const s = scriptedLlm(plan)
    let registry: ToolRegistry["Service"] | undefined
    let built: ReadonlyArray<RegisteredAction> | undefined
    const layer = Conversation.layerWithSetup({
      confirmActions: "on",
      setup: Effect.sync(() => {
        const acts = actions()
        if (registry === undefined || built !== acts) {
          built = acts
          registry = makeToolRegistry([{ name: "home", tools: acts.map(actionTool) }])
        }
        return { system: "s", registry }
      })
    }).pipe(Layer.provideMerge(testTurnTraceLayer), Layer.provide(Layer.succeed(Llm, Llm.of({ stream: s.llm.stream }))))
    return { s, layer }
  }

  it.effect("Conversation.layer: the model calls the tool, core asks, yes runs it", () => {
    const h = house()
    const acts = h.register()
    const s = scriptedLlm((text) => (text === "switch everything off" ? [call("home_all_off")] : []))
    const layer = Conversation.layer({ systemPrompt: "s", confirmActions: "on" }).pipe(
      Layer.provideMerge(testTurnTraceLayer),
      Layer.provide(Layer.succeed(ToolRegistry, makeToolRegistry([{ name: "home", tools: acts.map(actionTool) }]))),
      Layer.provide(Layer.succeed(Llm, Llm.of({ stream: s.llm.stream })))
    )
    return Effect.gen(function*() {
      const asked = yield* typed("switch everything off")
      assert.include(asked, "Switch everything off?")
      const done = yield* typed("yes")
      assert.deepStrictEqual(h.runs, ["all_off"])
      assert.include(done, "Everything is off.")
      assert.strictEqual(s.users.length, 1, "the model did not answer the yes")
    }).pipe(Effect.provide(layer))
  })

  it.effect("layerWithSetup with the registry replaced between question and answer: not run", () => {
    const h = house()
    let acts: ReadonlyArray<RegisteredAction> = h.register()
    const { layer } = legacy(() => acts, (text) => (text === "switch everything off" ? [call("home_all_off")] : []))
    return Effect.gen(function*() {
      yield* typed("switch everything off")
      acts = h.register() // a reconfigured module: new registrations
      const said = yield* typed("yes")
      assert.deepStrictEqual(h.runs, [])
      assert.include(said, T.unavailable)
    }).pipe(Effect.provide(layer))
  })
})

// ---------------------------------------------------------------------------

describe("round 7 finding 6: a confirmed action always leaves a spoken acknowledgement and an explicit outcome", () => {
  it.effect("reviewer: no announcement, run returns nothing: a fixed acknowledgement is spoken, the outcome recorded; a harness reads it in its catch-up", () => {
    const h = house()
    const acts = h.register()
    const harness = scriptedHarness((text) => (text === "mute the doorbell" ? { name: "home_mute", input: {} } : undefined))
    return Effect.gen(function*() {
      yield* typed("mute the doorbell")
      assert.deepStrictEqual(harness.results.map((r) => r.content), [PROPOSED_RESULT])
      const said = yield* typed("yes")
      assert.deepStrictEqual(h.runs, ["mute"])
      assert.include(said, T.done)
      yield* typed("thanks")
      // What the harness catch-up formats: non-tool messages with text.
      const seen = harness.histories.at(-1)!.flatMap((m) => (m.role !== "tool" && m.content.trim() !== "" ? [`${m.role}: ${m.content}`] : []))
      assert.deepStrictEqual(seen.slice(-3), [
        "user: yes",
        `assistant: ${T.done}`,
        "assistant: [Mute the doorbell: the owner confirmed; it ran and succeeded.]"
      ])
    }).pipe(Effect.provide(conversation(setupFor([harness.agent], () => acts))))
  })

  it.effect("cancelled, too early, window closed, no longer available: each spoken and recorded", () => {
    const h = house()
    let acts: ReadonlyArray<RegisteredAction> = h.register()
    const model = scriptedModel((text) => (text === "switch everything off" ? [call("home_all_off")] : []))
    return Effect.gen(function*() {
      yield* typed("switch everything off")
      assert.include(yield* typed("no"), T.cancelled)
      yield* typed("switch everything off")
      yield* TestClock.adjust(16_000)
      assert.include(yield* typed("yes"), T.lapsed)
      yield* typed("switch everything off")
      acts = h.register()
      assert.include(yield* typed("yes"), T.unavailable)
      assert.deepStrictEqual(h.runs, [])
      const n = notes(yield* historyOf)
      assert.deepStrictEqual(n, [
        "[Switch everything off: the owner said no; it was not run.]",
        "[Switch everything off: not run — the owner's answer came after the confirmation window had closed.]",
        "[Switch everything off: not run — the action is no longer available.]"
      ])
    }).pipe(Effect.provide(conversation(setupFor([model.agent], () => acts))))
  })

  it.effect("a model sees the outcome after the proposing call's tool result", () => {
    const h = house()
    const acts = h.register()
    const model = scriptedModel((text) => (text === "switch everything off" ? [call("home_all_off")] : []))
    return Effect.gen(function*() {
      yield* typed("switch everything off")
      yield* typed("yes")
      yield* typed("is it dark now")
      const seen = show(model.requests.at(-1)!.messages)
      assert.deepStrictEqual(seen, [
        "user: switch everything off",
        "assistant: ",
        `tool: ${PROPOSED_RESULT}`,
        "assistant: Switch everything off?",
        "user: yes",
        "assistant: Everything is off.",
        "assistant: [Switch everything off: the owner confirmed; it ran and succeeded.]",
        "user: is it dark now"
      ])
    }).pipe(Effect.provide(conversation(setupFor([model.agent], () => acts))))
  })
})

// ---------------------------------------------------------------------------

describe("round 7 finding 8: the authoritative final count decides what history records, whatever the outcome", () => {
  it.effect("reviewer: progress into the question, final(0), play returns successfully: not armed, nothing recorded as heard", () =>
    Effect.gen(function*() {
      const r = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(1_000), speechStarted, endOfTurn("yes")], { output: reportingOutput(() => 0) })
      assert.deepStrictEqual(r.runs, [])
      assert.isFalse(show(r.history).some((m) => m.includes("Reset the kitchen?")), show(r.history).join("\n"))
    }))

  it.effect("an ordinary reply that completes with a final count inside it is recorded like an interrupted one", () =>
    Effect.gen(function*() {
      const llm = { stream: () => Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: "The first sentence is here. And the second one follows. " }, { _tag: "Done", stopReason: "end" }]) }
      const agent: Agent = { id: "main", name: "Main", kind: "model", speculate: true, firstEventTimeoutMs: 5_000, ...makeModelAgent({ llm }) }
      const layer = conversation(Effect.sync(() => makeAgentSetup({ agents: [agent], routing: { defaultAgent: "main" } }))).pipe(
        Layer.provideMerge(Layer.mergeAll(makeMarkerTts().layer, reportingOutput((sizes) => sizes[0] ?? 0)))
      )
      const history = yield* Effect.gen(function*() {
        const c = yield* Conversation
        const fiber = yield* Effect.forkChild(c.voice(scripted([speechStarted, endOfTurn("talk")])))
        for (let i = 0; i < 20; i++) {
          yield* Effect.repeat(Effect.yieldNow, { times: 20 })
          yield* TestClock.adjust(100)
        }
        yield* Fiber.join(fiber)
        return yield* c.history
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(show(history), ["user: talk", "assistant: The first sentence is here. (interrupted)"])
    }))

  it.effect("a final count covering everything: recorded as completed", () =>
    Effect.gen(function*() {
      const r = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(1_000)], { output: reportingOutput((sizes) => total(sizes)) })
      assert.include(show(r.history), "assistant: Reset the room: room Kitchen?")
    }))
})
