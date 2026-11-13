/**
 * Latency, eager/final agreement, event-loop delay and memory of the local Stt
 * on the test WAVs. Run from the package directory:
 *
 *   tsx scripts/measure.ts [--model nemotron-3.5] [--rounds 3] [--soak-minutes 5] [--soak-speed 3]
 *
 * Latency phase (real time): utterances separated by 1.5 s of silence. For each
 * utterance: ms from its last loud frame (within 25 dB of its loudest) being handed
 * to `transcribe` to the `EagerEndOfTurn` that preceded its `EndOfTurn`, and to the
 * `EndOfTurn`; and from its first loud frame (within 15 dB) to `SpeechStarted` (barge-in).
 * Soak phase: the same audio looped at `--soak-speed` × real time; RSS each minute.
 */
import { Stt } from "@pva/core"
import type { SttEvent } from "@pva/core"
import { Effect, Stream } from "effect"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { parseArgs } from "node:util"
import { isPresetName, presets } from "../src/presets.ts"
import { layer } from "../src/SherpaStt.ts"
import { normalize, pacedAudio, references, timeline, wordErrors } from "../test/fixtures.ts"

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "nemotron-3.5" },
    rounds: { type: "string", default: "3" },
    "soak-minutes": { type: "string", default: "0" },
    "soak-speed": { type: "string", default: "3" },
    eager: { type: "string", default: "250" },
    final: { type: "string", default: "600" },
    language: { type: "string" },
    padding: { type: "string" }
  }
})
const model = values.model
if (!isPresetName(model)) throw new Error(`unknown model ${model}`)
const multilingual = "language" in presets[model]
const wavs = multilingual ? ["0.wav", "1.wav", "nl0.wav", "nl1.wav", "nl2.wav"] : ["0.wav", "1.wav"]
const parts: Array<string | number> = [1000]
for (let r = 0; r < Number(values.rounds); r++) for (const wav of wavs) parts.push(wav, 1500)
const { pcm, utterances } = timeline(parts)
const refs = references()

const median = (xs: Array<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN
const fmt = (xs: Array<number>) => `median ${median(xs).toFixed(0)}, min ${Math.min(...xs).toFixed(0)}, max ${Math.max(...xs).toFixed(0)}`
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`

const program = Effect.gen(function*() {
  const stt = yield* Stt
  console.log(`model ${model}; rss after load ${mb(process.memoryUsage().rss)}`)

  // Latency phase
  let t0 = 0
  const events: Array<{ at: number; event: SttEvent }> = []
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  yield* stt.transcribe(pacedAudio(pcm, { t0: (t) => (t0 = t) })).pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push({ at: performance.now(), event })))
  )
  loop.disable()

  const startedMs: Array<number> = []
  const eagerMs: Array<number> = []
  const finalMs: Array<number> = []
  let same = 0
  let finals = 0
  let errors = 0
  let words = 0
  let lastEager: { at: number; text: string } | undefined
  let started: number | undefined
  let resumed = 0
  let u = 0
  let startedFor = -1
  for (const { at, event } of events) {
    if (event._tag === "SpeechStarted" && utterances[u] && startedFor !== u) {
      startedFor = u // the first SpeechStarted of each utterance
      started = at - (t0 + utterances[u]!.speechStartMs)
      startedMs.push(started)
    }
    if (event._tag === "TurnResumed") resumed++
    if (event._tag === "EagerEndOfTurn") lastEager = { at, text: event.text }
    if (event._tag !== "EndOfTurn") continue
    const utterance = utterances[u++]
    if (!utterance) throw new Error(`unexpected EndOfTurn: ${event.text}`)
    const end = t0 + utterance.speechEndMs
    finals++
    finalMs.push(at - end)
    if (lastEager) eagerMs.push(lastEager.at - end)
    if (lastEager && normalize(lastEager.text) === normalize(event.text)) same++
    const wer = wordErrors(refs[utterance.name] ?? "", event.text)
    errors += wer.errors
    words += wer.words
    console.log(
      `  ${utterance.name.padEnd(8)} started ${started?.toFixed(0).padStart(4)} ms, eager ${lastEager ? (lastEager.at - end).toFixed(0).padStart(4) : "   -"} ms, ` +
        `final ${(at - end).toFixed(0).padStart(4)} ms, ${wer.errors}/${wer.words} word errors: ${event.text}`
    )
    lastEager = undefined
  }
  console.log(`turns: ${finals} EndOfTurn for ${utterances.length} utterances, ${resumed} TurnResumed`)
  console.log(`speech onset → SpeechStarted:  ${fmt(startedMs)} ms`)
  console.log(`last speech → EagerEndOfTurn: ${fmt(eagerMs)} ms`)
  console.log(`last speech → EndOfTurn:      ${fmt(finalMs)} ms`)
  console.log(`eager text == final text (normalised): ${same}/${finals}`)
  console.log(`word error rate: ${errors}/${words} = ${(100 * errors / words).toFixed(1)}%`)
  console.log(
    `main event-loop delay (10 ms timer): p50 ${(loop.percentile(50) / 1e6 - 10).toFixed(1)} ms, ` +
      `p99 ${(loop.percentile(99) / 1e6 - 10).toFixed(1)} ms, max ${(loop.max / 1e6 - 10).toFixed(1)} ms`
  )
  console.log(`rss after latency phase ${mb(process.memoryUsage().rss)}`)

  // Soak phase
  const soakMinutes = Number(values["soak-minutes"])
  if (soakMinutes > 0) {
    const speed = Number(values["soak-speed"])
    const audioMs = pcm.length / 32
    const loops = Math.ceil(soakMinutes * 60_000 / audioMs)
    const looped = new Uint8Array(pcm.length * loops)
    for (let i = 0; i < loops; i++) looped.set(pcm, i * pcm.length)
    let turns = 0
    let nextReport = 60_000
    let start = 0
    yield* stt.transcribe(pacedAudio(looped, { speed, t0: (t) => (start = t) })).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event._tag === "EndOfTurn") turns++
          const audioAt = (performance.now() - start) * speed
          if (audioAt >= nextReport) {
            console.log(`  soak: ${(audioAt / 60_000).toFixed(1)} min of audio, ${turns} turns, rss ${mb(process.memoryUsage().rss)}`)
            nextReport += 60_000
          }
        })
      )
    )
    console.log(`soak done: ${(loops * audioMs / 60_000).toFixed(1)} min of audio at ${speed}x, ${turns} turns, rss ${mb(process.memoryUsage().rss)}`)
  }
})

const sttLayer = layer({
  model,
  eagerSilenceMs: Number(values.eager),
  finalSilenceMs: Number(values.final),
  maxBacklogMs: 5000,
  ...(values.language ? { language: values.language } : {}),
  ...(values.padding ? { tailPaddingMs: Number(values.padding) } : {})
})
Effect.runPromise(program.pipe(Effect.provide(sttLayer))).catch((error) => {
  console.error(error)
  process.exit(1)
})
