// What phrase commands add to the path of an utterance (docs/PHRASES.md "Latency"; review round 1, a1, E2, E3), at the
// stated maximum, counting the work it claims (the matcher's `MatchStats`: words, phrases aligned, slot readings):
// (1) the matcher alone on one assistant's set at its bound (256 module phrases of 8 words with 2 slots each: a choice of
//     32 options with an alias each, and a duration; plus the host's 37 English controls): 24-word near misses, matches,
//     and the reviewers' aligned worst case (256 two-slot shapes over two words, with number and duration slots, which
//     spends the whole `slotReads` budget and is then not taken); each run's longest main-thread stop under `bound(10)`;
// (2) a set prepared ahead, step by step, for 32 modules × 16 actions × 8 phrases (4,096 declarations): its longest stop;
//     and the maximum choice-bearing module (review round 2, a2: 16 actions × 8 phrases, each phrase two slots that are
//     32-option choices with the full name budget, 96 names of 40 characters, each action its own two choices, fresh
//     objects every time as after a start): its declaration check (one synchronous step) and its preparation;
// (3) the same scripted 24-word turn that is no command (the real Conversation, zero-delay synthesis and output, the
//     model's first token at 5 ms) without and with the one decision at its final, the decision reading a set that was
//     invalidated just before (the preparation running in the background while the turn runs): TurnTrace end of turn ->
//     playbackStart, and the recogniser's final (before the decision) -> playbackStart. Counterbalanced; medians compared.
import {
  buildCommandSet,
  Conversation,
  type ConversationEvent,
  decideUtterance,
  defineAction,
  hostCommandSet,
  macrotask,
  makePhraseSets,
  makeToolRegistry,
  matchCommand,
  type MatchStats,
  Param,
  PHRASE_LIMITS,
  phraseProblems,
  registerActions,
  type SttEvent,
  type Trace,
  TurnTrace
} from "@pva/core"
import { makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, sleep, speechStarted, textDelta } from "@pva/core/testing"
import { Effect, Exit, Layer, Queue, Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { bound } from "./latencyBound.ts"

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!
const ms = (x: number) => `${x.toFixed(3)} ms`
const words = (s: string) => s.trim().split(/\s+/).length

/** The longest gap between ticks of a 1 ms timer while `work` runs (what audio framing would see). */
const longestStop = async (work: () => Promise<void>) => {
  let last = performance.now()
  let worst = 0
  const timer = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 1)
  try {
    await work()
    return Math.max(worst, performance.now() - last)
  } finally {
    clearInterval(timer)
  }
}

/** 32 rooms, each with an alias: the largest choice a slot reads (`PHRASE_LIMITS.choiceOptions`). */
const rooms = Array.from({ length: PHRASE_LIMITS.choiceOptions }, (_, i) => ({ value: `room-${i}`, label: `Room number ${i}`, aliases: [`area ${i}`] }))

/** The set at its bound: 32 modules × 8 phrases, each `please set the {room} timer to {length} now<n>` (8 words, 2 slots). */
const maxSet = () => {
  const actions = Array.from({ length: 32 }, (_, m) =>
    registerActions(`module-${m}`, [defineAction({
      id: "set",
      label: "Set",
      description: "Sets.",
      params: { room: Param.choice({ label: "Room", options: rooms }), length: Param.duration({ label: "Length" }) },
      phrases: { en: Array.from({ length: 8 }, (_, i) => `please set the {room} timer to {length} now${m * 8 + i}`) },
      run: () => Effect.void
    })])
  ).flat()
  const set = buildCommandSet("en", actions)
  expect(set.phrases.filter((p) => p.owner.kind === "action")).toHaveLength(PHRASE_LIMITS.phrasesPerAssistant)
  expect(set.conflicts).toEqual([])
  return set
}

/** A name of exactly `choiceNameChars` characters. */
const fullName = (s: string) => `${s} ${"x".repeat(PHRASE_LIMITS.choiceNameChars)}`.slice(0, PHRASE_LIMITS.choiceNameChars)
/** A choice at its bound: 32 options, each a value, a label and an alias of 40 characters (96 names, `choiceNames`). */
const fullChoice = (tag: string) =>
  Param.choice({
    label: "C",
    options: Array.from({ length: PHRASE_LIMITS.choiceOptions }, (_, i) => ({ value: fullName(`${tag} value ${i}`), label: fullName(`${tag} label ${i}`), aliases: [fullName(`${tag} alias ${i}`)] }))
  })
/** The maximum choice-bearing module, new objects each call (a start): 16 actions × 8 phrases, two full choices per action. */
const choiceModule = (round: number) =>
  Array.from({ length: PHRASE_LIMITS.actionsPerModule }, (_, a) =>
    defineAction({
      id: `action_${a}`,
      label: "A",
      description: "A.",
      params: { r: fullChoice(`r${round}.${a}`), s: fullChoice(`s${round}.${a}`) },
      phrases: { en: Array.from({ length: PHRASE_LIMITS.phrasesPerAction }, (_, v) => `please action${a} variant${v} in {r} at {s}`) },
      run: () => Effect.void
    })
  )

/** A near miss of exactly 24 words: every phrase aligns "please set the …" and then fails on its last word. */
const nearMiss = (i: number) => `please set the room number ${i % 32} and the area ${(i + 7) % 32} timer to ten minutes and thirty seconds then tell me when it is ready`
/** A match of 11 words (6 literal words, the room 3 words, the duration 2). */
const match = (i: number) => `please set the room number ${i % 32} timer to ten minutes now${i % 256}`
/** The reviewers' aligned worst case: 9 alternating words that every two-slot shape over "set" and "timer" aligns with. */
const aligned = "set timer set timer set timer set timer set"

describe("phrase commands on the path of an utterance", () => {
  it("the matcher at the stated maximum, counting its work: per utterance and the longest main-thread stop (bound(10))", async () => {
    const set = maxSet()
    const shapes = new Set<string>()
    for (let n = 3; n <= 8; n++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        for (let i = 0; i < n; i++) {
          for (let j = i + 2; j < n; j++) shapes.add(Array.from({ length: n }, (_, k) => (k === i ? "{a}" : k === j ? "{b}" : (mask >> k) & 1 ? "timer" : "set")).join(" "))
        }
      }
    }
    const list = [...shapes].slice(0, 256)
    const hostile = buildCommandSet("en", Array.from({ length: 32 }, (_, m) =>
      registerActions(`h-${m}`, [defineAction({ id: "x", label: "X", description: "X.", params: { a: Param.number({ label: "A" }), b: Param.duration({ label: "B" }) }, phrases: { en: list.slice(m * 8, m * 8 + 8) }, run: () => Effect.void })])
    ).flat())
    expect(hostile.phrases.filter((p) => p.owner.kind === "action")).toHaveLength(256)
    expect(words(nearMiss(1))).toBe(24)
    expect(words(match(1))).toBe(11)
    const one = (s: ReturnType<typeof maxSet>, text: string) => {
      const stats: MatchStats = { words: 0, phrases: 0, reads: 0, exhausted: false }
      const m = matchCommand(s, text, stats)
      return { m, stats }
    }
    expect(one(set, match(3)).m).toMatchObject({ kind: "command", values: { room: "room-3", length: 600_000 } })
    const near = one(set, nearMiss(3))
    // The 256 module phrases and the host's "please stop" align their first word.
    expect([near.m, near.stats.words, near.stats.phrases, near.stats.reads]).toEqual([undefined, 24, 257, 0])
    const hit = one(set, match(3))
    expect(hit.stats).toMatchObject({ words: 11, reads: 2, exhausted: false })
    const worst = one(hostile, aligned)
    expect([worst.m, worst.stats.reads, worst.stats.exhausted]).toEqual([undefined, PHRASE_LIMITS.slotReads, true])
    /** `n` utterances, each decided as a final is (one synchronous call), with the event loop free between them. */
    const timed = async (f: () => unknown, n: number) => {
      const out: Array<number> = []
      for (let i = 0; i < n; i++) {
        const t = performance.now()
        f()
        out.push(performance.now() - t)
        await new Promise((r) => setImmediate(r))
      }
      return out
    }
    await timed(() => matchCommand(set, nearMiss(0)), 200)
    let nearTimes: Array<number> = []
    let hitTimes: Array<number> = []
    let worstTimes: Array<number> = []
    const nearStop = await longestStop(async () => void (nearTimes = await timed(() => matchCommand(set, nearMiss(Math.floor(Math.random() * 1000))), 500)))
    const hitStop = await longestStop(async () => void (hitTimes = await timed(() => matchCommand(set, match(Math.floor(Math.random() * 1000))), 500)))
    const worstStop = await longestStop(async () => void (worstTimes = await timed(() => matchCommand(hostile, aligned), 200)))
    console.log(
      `matcher, ${set.phrases.length} phrases (256 module phrases of 8 words with 2 slots: a 32-option choice, a duration): ` +
        `near miss (24 words, 257 phrases aligned, 0 readings) median ${ms(median(nearTimes))}, p95 ${ms(p95(nearTimes))}, worst ${ms(Math.max(...nearTimes))}; longest stop ${ms(nearStop)}. ` +
        `match (11 words, 2 readings) median ${ms(median(hitTimes))}, p95 ${ms(p95(hitTimes))}, worst ${ms(Math.max(...hitTimes))}; longest stop ${ms(hitStop)}. ` +
        `aligned worst case (9 words, 256 two-slot phrases, ${worst.stats.phrases} aligned, ${PHRASE_LIMITS.slotReads} number and duration readings, not taken) median ${ms(median(worstTimes))}, p95 ${ms(p95(worstTimes))}, worst ${ms(Math.max(...worstTimes))}; longest stop ${ms(worstStop)}`
    )
    for (const stop of [nearStop, hitStop, worstStop]) expect(stop).toBeLessThan(bound(10))
  }, 120_000)

  it("a set prepared ahead for 4,096 declarations, in steps: the longest main-thread stop (bound(10))", async () => {
    const actions = Array.from({ length: 32 }, (_, m) =>
      registerActions(`module-${m}`, Array.from({ length: 16 }, (_, a) =>
        defineAction({ id: `action_${a}`, label: "A", description: "A.", params: { length: Param.duration({ label: "L", optional: true }) }, phrases: { en: Array.from({ length: 8 }, (_, v) => `please module${m} action${a} variant${v} for {length}`) }, run: () => Effect.void })))
    ).flat()
    let version = 0
    const scope = Effect.runSync(Scope.make())
    const sets = await Effect.runPromise(makePhraseSets({ language: () => "en", assistants: () => [{ id: "a", name: "A" }], inputKey: () => `${version}`, actionsOf: () => actions.slice(version % 2) }).pipe(Scope.provide(scope)))
    const passes: Array<number> = []
    const stop = await longestStop(async () => {
      for (let i = 0; i < 10; i++) {
        version++
        const t = performance.now()
        await Effect.runPromise(sets.settled)
        passes.push(performance.now() - t)
      }
    })
    await Effect.runPromise(Scope.close(scope, Exit.void))
    console.log(`preparing one assistant's set from 4,096 declarations (256 kept, the rest named past the bound): ${sets.stats().compiled} preparations, median ${ms(median(passes))} of wall time each; longest stop ${ms(stop)}`)
    expect(sets.stats().compiled).toBeGreaterThanOrEqual(10)
    expect(stop).toBeLessThan(bound(10))
  }, 120_000)

  it("the maximum choice-bearing module: its declaration check (one synchronous step) and its preparation in steps (bound(10))", async () => {
    const first = choiceModule(0)
    const names = first[0]!.params.r.options.flatMap((o) => [o.value, o.label, ...(o.aliases ?? [])])
    expect([first.length, first[0]!.phrases!.en!.length, names.length, Math.max(...names.map((n) => n.length))]).toEqual([16, 8, PHRASE_LIMITS.choiceNames, PHRASE_LIMITS.choiceNameChars])
    const checks: Array<number> = []
    for (let r = 0; r < 30; r++) {
      const declared = choiceModule(1000 + r)
      const t = performance.now()
      const problems = phraseProblems("choices", declared)
      checks.push(performance.now() - t)
      expect(problems).toEqual([])
    }
    let round = 0
    const scope = Effect.runSync(Scope.make())
    const steps: Array<number> = []
    let stepStart = performance.now()
    const yieldStep = Effect.sync(() => void steps.push(performance.now() - stepStart)).pipe(Effect.andThen(macrotask), Effect.andThen(Effect.sync(() => void (stepStart = performance.now()))))
    let actions = registerActions("choices", choiceModule(round))
    const sets = await Effect.runPromise(makePhraseSets({ language: () => "en", assistants: () => [{ id: "a", name: "A" }], inputKey: () => `${round}`, actionsOf: () => actions }, { yieldStep }).pipe(Scope.provide(scope)))
    await Effect.runPromise(sets.settled)
    steps.length = 0
    const passes: Array<number> = []
    const stop = await longestStop(async () => {
      for (let i = 0; i < 10; i++) {
        round++
        actions = registerActions("choices", choiceModule(round))
        const t = performance.now()
        await Effect.runPromise(sets.settled)
        passes.push(performance.now() - t)
      }
    })
    const set = sets.ready("a")
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(set?.phrases.filter((p) => p.owner.kind === "action")).toHaveLength(128)
    // Prepared keys, read: a label and an alias of the newest start's choices.
    expect(matchCommand(set!, `please action3 variant5 in ${fullName(`r${round}.3 label 7`)} at ${fullName(`s${round}.3 alias 9`)}`)).toMatchObject({
      kind: "command",
      values: { r: fullName(`r${round}.3 value 7`), s: fullName(`s${round}.3 value 9`) }
    })
    console.log(
      `the maximum choice-bearing module (16 actions × 8 phrases, 2 slots each, 32 distinct choices of 96 names of 40 characters): ` +
        `declaration check median ${ms(median(checks))}, worst ${ms(Math.max(...checks))} (one synchronous step); ` +
        `preparation median ${ms(median(passes))} of wall time, ${steps.length} steps, longest step ${ms(Math.max(...steps))}; longest stop ${ms(stop)}`
    )
    expect(Math.max(...checks)).toBeLessThan(bound(10))
    expect(stop).toBeLessThan(bound(10))
    expect(Math.max(...steps)).toBeLessThan(bound(10))
  }, 120_000)

  it("a turn that is no command has the same timings with and without the decision, through an invalidated set (TurnTrace, counterbalanced)", async () => {
    const set = maxSet()
    const TURNS = 120
    const WARM = 20
    const ringing = [{ id: "n-1", actions: [{ id: "snooze", label: "Snooze" }, { id: "extend", label: "Five more minutes" }] }]
    const sentence = (i: number) => `what will the weather be like in the north of the country tomorrow afternoon and evening when we all go out walking together ${i}`
    expect(words(sentence(7))).toBe(24)
    const measure = (withDecision: boolean) =>
      Effect.scoped(Effect.gen(function*() {
        const ended = yield* Queue.unbounded<Trace>()
        const onEvent = (e: ConversationEvent) => {
          if (e._tag === "TurnEnded") Queue.offerUnsafe(ended, e.trace)
        }
        // The sets of a real `makePhraseSets`, invalidated before every final: the final reads the host's controls while the
        // set is prepared again in the background (the full set's 256 phrases, every turn).
        let version = 0
        const sets = yield* makePhraseSets({ language: () => "en", assistants: () => [{ id: "jeff", name: "Jeff" }], inputKey: () => `${version}`, actionsOf: () => set.phrases.flatMap((p) => (p.owner.kind === "action" ? [p.owner.action] : [])).filter((a, i, all) => all.indexOf(a) === i) })
        const finals: Array<number> = []
        const fromEnd: Array<number> = []
        const fromFinal: Array<number> = []
        let notReady = 0
        const decide = (final: Extract<SttEvent, { _tag: "EndOfTurn" }>): ReadonlyArray<SttEvent> => {
          finals.push(performance.now())
          if (!withDecision) return [final]
          version++
          const d = decideUtterance({
            final,
            language: "en",
            ringing,
            wakeAtStart: () => false,
            gates: (e) => [{ events: [e], target: { assistant: "jeff", by: "default" } }],
            commandsFor: (a) => {
              const ready = a === undefined ? undefined : sets.ready(a)
              if (ready === undefined) notReady++
              return ready ?? hostCommandSet("en")
            }
          })
          if (d.taken !== undefined) throw new Error("a sentence that is no command was taken")
          return d.results.flatMap((r) => r.events)
        }
        const events = Stream.range(1, TURNS).pipe(
          Stream.flatMap((i) =>
            Stream.make(speechStarted).pipe(
              Stream.concat(Stream.fromIterableEffect(Effect.sync(() => decide({ _tag: "EndOfTurn", text: sentence(i) })))),
              Stream.concat(Stream.fromEffectDrain(Effect.gen(function*() {
                const t = yield* Queue.take(ended)
                fromEnd.push(t.marks.playbackStart! - t.marks.endOfTurn!)
                fromFinal.push(t.marks.playbackStart! - finals[finals.length - 1]!)
              })))
            ), { concurrency: 1 })
        )
        const llm = makeScriptedLlm(() => [sleep(5), textDelta("It will be dry and mild.")])
        const layer = Conversation.layerWithSetup({
          onEvent,
          setup: Effect.succeed({ system: "Benchmark.", registry: makeToolRegistry([]), turnContext: { deviceId: "kitchen", assistantId: "jeff" } })
        }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, TurnTrace.layer())))
        yield* Effect.gen(function*() {
          const c = yield* Conversation
          yield* c.voice(events)
        }).pipe(Effect.provide(Layer.mergeAll(layer, makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 0 }).layer)))
        return {
          end: median(fromEnd.slice(WARM)),
          endP95: p95(fromEnd.slice(WARM)),
          final: median(fromFinal.slice(WARM)),
          finalP95: p95(fromFinal.slice(WARM)),
          notReady,
          compiled: sets.stats().compiled,
          passes: sets.stats().passes
        }
      }))
    type Run = { end: number; endP95: number; final: number; finalP95: number; notReady: number; compiled: number; passes: number }
    const without: Array<Run> = []
    const withIt: Array<Run> = []
    for (const order of [[false, true], [true, false], [false, true], [true, false]] as const) {
      for (const w of order) (w ? withIt : without).push(await Effect.runPromise(measure(w)))
    }
    const m = (xs: ReadonlyArray<Run>, k: "end" | "endP95" | "final" | "finalP95") => median(xs.map((x) => x[k]))
    console.log(
      `TurnTrace, median of ${TURNS - WARM} turns x 4 counterbalanced runs (a 24-word sentence that is no command, something ringing, the set invalidated before every final: ` +
        `${withIt[0]!.notReady} of ${TURNS} finals read a set that was not ready; ${withIt[0]!.passes} preparation passes ran meanwhile, ${withIt[0]!.compiled} compiled the set and the rest reused it; model's first token at 5 ms): ` +
        `end of turn -> playbackStart without the decision ${ms(m(without, "end"))} (p95 ${ms(m(without, "endP95"))}), with it ${ms(m(withIt, "end"))} (p95 ${ms(m(withIt, "endP95"))}); ` +
        `recogniser's final -> playbackStart without ${ms(m(without, "final"))} (p95 ${ms(m(without, "finalP95"))}), with ${ms(m(withIt, "final"))} (p95 ${ms(m(withIt, "finalP95"))})`
    )
    expect(withIt[0]!.notReady).toBeGreaterThan(0)
    expect(m(withIt, "final")).toBeLessThan(m(without, "final") + bound(1))
    expect(m(withIt, "end")).toBeLessThan(m(without, "end") + bound(1))
  }, 240_000)
})
