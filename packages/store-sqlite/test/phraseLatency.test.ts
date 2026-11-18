// What phrase commands add to the path of an utterance (docs/PHRASES.md "Latency"), measured, at the stated maximum:
// one assistant's set at its bound (256 module phrases in a language, every one 8 words with 2 slots: a dynamic list of
// 255 options, each with an alias, and a duration; plus the host's controls), utterances of 24 words and up to 300
// characters. (1) The matcher alone: near misses (every phrase aligns its first words), matches, and a sentence built to
// align everywhere, which costs the full `slotReads` readings; the longest main-thread stop of each run asserted with the
// shared `bound(10)`. (2) The same scripted turn that is not a command (the real Conversation, zero-delay synthesis and
// output, the model's first token at 5 ms) with and without the one decision at its final, with something ringing on
// the device (the window is checked too) and the full set: TurnTrace end of turn -> playbackStart, and the recogniser's
// final (before the decision) -> playbackStart. Runs are counterbalanced; the medians are printed and compared.
import {
  buildCommandSet,
  Conversation,
  type ConversationEvent,
  decideUtterance,
  defineAction,
  makeToolRegistry,
  matchCommand,
  Param,
  PHRASE_LIMITS,
  registerActions,
  type SttEvent,
  type Trace,
  TurnTrace
} from "@pva/core"
import { makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, sleep, speechStarted, textDelta } from "@pva/core/testing"
import { Effect, Layer, Queue, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { bound } from "./latencyBound.ts"

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!
const ms = (x: number) => `${x.toFixed(3)} ms`

/** The longest gap between ticks of a 1 ms timer while `work` runs (what audio framing would see). */
const longestStop = async (work: () => void | Promise<void>) => {
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

/** 255 rooms, each with an alias: the largest dynamic list a slot reads (`MAX_CHOICE_OPTIONS`). */
const rooms = Array.from({ length: 255 }, (_, i) => ({ value: `room-${i}`, label: `Room number ${i}`, aliases: [`area ${i}`] }))

/** The set at its bound: 32 modules × 8 phrases, each `please set the {room} timer to {length} now<n>` (8 words, 2 slots). */
const maxSet = () => {
  const actions = Array.from({ length: 32 }, (_, m) =>
    registerActions(`module-${m}`, [defineAction({
      id: "set",
      label: "Set",
      description: "Sets.",
      params: { room: Param.dynamic({ label: "Room", options: () => rooms }), length: Param.duration({ label: "Length" }) },
      phrases: { en: Array.from({ length: 8 }, (_, i) => `please set the {room} timer to {length} now${m * 8 + i}`) },
      run: () => Effect.void
    })])
  ).flat()
  const set = buildCommandSet("en", actions)
  expect(set.phrases.filter((p) => p.owner.kind === "action")).toHaveLength(PHRASE_LIMITS.phrasesPerAssistant)
  expect(set.conflicts).toEqual([])
  return set
}

/** A near miss of 24 words: every phrase aligns "please set the …" and then fails on its last word. */
const nearMiss = (i: number) => `please set the room number ${i % 255} and the area ${(i + 7) % 255} timer to ten minutes and thirty seconds then tell me when it is ready`
/** A match of 24 words at most. */
const match = (i: number) => `please set the room number ${i % 255} timer to ten minutes now${i % 256}`
/** A sentence that aligns everywhere: the alternating words make every alignment of a two-slot phrase possible. */
const adversarial = Array.from({ length: 12 }, () => "set").join(" timer ")

describe("phrase commands on the path of an utterance", () => {
  it(`the matcher at the stated maximum: per utterance and the longest main-thread stop (bound(10))`, async () => {
    const set = maxSet()
    // An adversarial set for the alternating sentence: every two-slot shape over "set" and "timer" (the budget's case).
    const shapes = new Set<string>()
    for (let n = 3; n <= 8; n++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        for (let i = 0; i < n; i++) {
          for (let j = i + 2; j < n; j++) shapes.add(Array.from({ length: n }, (_, k) => (k === i ? "{room}" : k === j ? "{length}" : (mask >> k) & 1 ? "timer" : "set")).join(" "))
        }
      }
    }
    const list = [...shapes].slice(0, 256)
    const hostile = buildCommandSet("en", Array.from({ length: 32 }, (_, m) =>
      registerActions(`h-${m}`, [defineAction({ id: "x", label: "X", description: "X.", params: { room: Param.dynamic({ label: "Room", options: () => rooms }), length: Param.duration({ label: "Length" }) }, phrases: { en: list.slice(m * 8, m * 8 + 8) }, run: () => Effect.void })])
    ).flat())
    for (const s of [nearMiss(1), match(1), adversarial]) expect(s.split(" ").length).toBeLessThanOrEqual(PHRASE_LIMITS.utteranceWords)
    expect(matchCommand(set, match(3))).toMatchObject({ kind: "command", values: { room: "room-3", length: 600_000 } })
    expect(matchCommand(set, nearMiss(3))).toBeUndefined()
    expect(matchCommand(hostile, adversarial)).toBeUndefined()
    /** `n` utterances, each one decided as a final is (one synchronous call), with the event loop free between them. */
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
    // Warm.
    await timed(() => matchCommand(set, nearMiss(0)), 200)
    let near: Array<number> = []
    let hit: Array<number> = []
    let worst: Array<number> = []
    const nearStop = await longestStop(async () => void (near = await timed(() => matchCommand(set, nearMiss(Math.floor(Math.random() * 1000))), 500)))
    const hitStop = await longestStop(async () => void (hit = await timed(() => matchCommand(set, match(Math.floor(Math.random() * 1000))), 500)))
    const worstStop = await longestStop(async () => void (worst = await timed(() => matchCommand(hostile, adversarial), 200)))
    console.log(
      `matcher, ${set.phrases.length} phrases (256 module phrases of 8 words with 2 slots, 255-option lists): ` +
        `near miss (24 words) median ${ms(median(near))}, p95 ${ms(p95(near))}, worst ${ms(Math.max(...near))}; longest stop ${ms(nearStop)}. ` +
        `match median ${ms(median(hit))}, p95 ${ms(p95(hit))}, worst ${ms(Math.max(...hit))}; longest stop ${ms(hitStop)}. ` +
        `aligns everywhere (${PHRASE_LIMITS.slotReads} readings) median ${ms(median(worst))}, p95 ${ms(p95(worst))}, worst ${ms(Math.max(...worst))}; longest stop ${ms(worstStop)}`
    )
    for (const stop of [nearStop, hitStop, worstStop]) expect(stop).toBeLessThan(bound(10))
  }, 120_000)

  it("a turn that is not a command has the same timings with and without the decision (TurnTrace, counterbalanced)", async () => {
    const set = maxSet()
    const TURNS = 120
    const WARM = 20
    const ringing = [{ id: "n-1", actions: [{ id: "snooze", label: "Snooze" }, { id: "extend", label: "Five more minutes" }] }]
    const sentence = (i: number) => `what will the weather be like in the north of the country tomorrow afternoon and evening when we go out walking ${i}`
    const measure = (withDecision: boolean) =>
      Effect.scoped(Effect.gen(function*() {
        const ended = yield* Queue.unbounded<Trace>()
        const onEvent = (e: ConversationEvent) => {
          if (e._tag === "TurnEnded") Queue.offerUnsafe(ended, e.trace)
        }
        const finals: Array<number> = []
        const fromEnd: Array<number> = []
        const fromFinal: Array<number> = []
        /** The final as the recogniser sends it, through the one decision (or not), on to the conversation. */
        const decide = (final: Extract<SttEvent, { _tag: "EndOfTurn" }>): ReadonlyArray<SttEvent> => {
          finals.push(performance.now())
          if (!withDecision) return [final]
          const d = decideUtterance({
            final,
            language: "en",
            ringing,
            wakeAtStart: () => false,
            gates: (e) => [{ events: [e], target: { assistant: "jeff", by: "default" } }],
            commandsFor: () => set
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
          finalP95: p95(fromFinal.slice(WARM))
        }
      }))
    const without: Array<Awaited<ReturnType<typeof Effect.runPromise<{ end: number; endP95: number; final: number; finalP95: number }, never>>>> = []
    const withIt: typeof without = []
    for (const order of [[false, true], [true, false], [false, true], [true, false]] as const) {
      for (const w of order) (w ? withIt : without).push(await Effect.runPromise(measure(w)))
    }
    const m = (xs: typeof without, k: "end" | "endP95" | "final" | "finalP95") => median(xs.map((x) => x[k]))
    console.log(
      `TurnTrace, median of ${TURNS - WARM} turns x 4 counterbalanced runs (24-word sentence, model's first token at 5 ms): ` +
        `end of turn -> playbackStart without the decision ${ms(m(without, "end"))} (p95 ${ms(m(without, "endP95"))}), with it ${ms(m(withIt, "end"))} (p95 ${ms(m(withIt, "endP95"))}); ` +
        `recogniser's final -> playbackStart without ${ms(m(without, "final"))} (p95 ${ms(m(without, "finalP95"))}), with ${ms(m(withIt, "final"))} (p95 ${ms(m(withIt, "finalP95"))})`
    )
    expect(m(withIt, "final")).toBeLessThan(m(without, "final") + bound(1))
    expect(m(withIt, "end")).toBeLessThan(m(without, "end") + bound(1))
  }, 240_000)
})
