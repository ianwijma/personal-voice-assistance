/**
 * Accuracy, latency, eager/final agreement, event-loop delay and memory of the
 * local Stt through the real adapter. Run from the package directory:
 *
 *   tsx scripts/measure.ts [--model parakeet-v2] [--rounds 3] [--soak-minutes 5] [--soak-speed 3]
 *   tsx scripts/measure.ts --model parakeet-v2 --set [--conditions clean,tel,...] [--lang en] [--speed 1]
 *
 * Clean phase (default): the five clean test clips (two English, three Dutch for
 * multilingual models) `--rounds` times, separated by 1.5 s of background noise.
 * `--set`: the degraded test set of docs/research/stt-quality.md (34 English and
 * 13 Dutch clips × 7 conditions, in models/test-wavs/stt-quality), one timeline
 * per condition, clips at their own level, WER normalised as in the study.
 *
 * For each utterance: ms from its last loud frame (within 25 dB of its loudest;
 * taken from the clean version of the clip) being handed to `transcribe` to the
 * last `EagerEndOfTurn` before its `EndOfTurn`, and to the `EndOfTurn`; from its
 * first loud frame to the first `SpeechStarted`. Turns are assigned to clips by
 * time, so a clip split into several turns (or none) is scored as such.
 * Soak phase: the clean audio looped at `--soak-speed` × real time; RSS each minute.
 */
import { Stt } from "@pva/core"
import type { SttEvent } from "@pva/core"
import { Effect, Layer, Stream } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { parseArgs } from "node:util"
import { defaultModelDir, presets, resolvePresetName, takesLanguage } from "../src/presets.ts"
import { layer } from "../src/SherpaStt.ts"
import {
  normalize,
  pacedAudio,
  references,
  studyWordErrors,
  timeline,
  type Utterance,
  wordErrors
} from "../test/fixtures.ts"

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "parakeet-v2" },
    rounds: { type: "string", default: "3" },
    "soak-minutes": { type: "string", default: "0" },
    "soak-speed": { type: "string", default: "3" },
    speed: { type: "string", default: "1" },
    eager: { type: "string", default: "250" },
    final: { type: "string", default: "600" },
    language: { type: "string" },
    padding: { type: "string" },
    vad: { type: "string" },
    agc: { type: "string", default: "on" },
    set: { type: "boolean", default: false },
    conditions: { type: "string", default: "clean,tel,lp7k,quiet,noise15,reverb,combo" },
    lang: { type: "string" },
    json: { type: "string" },
    // The adapter as it was before whole-turn decoding (a copy of the old src/ in src/baseline.tmp, model nemotron-3.5).
    baseline: { type: "boolean", default: false }
  }
})
const model = resolvePresetName(values.model)
if (model === undefined) throw new Error(`unknown model ${values.model}`)
const preset = presets[model]
const multilingual = model === "parakeet-ultra" || model === "whisper-turbo" || (preset.kind === "streaming" && takesLanguage(preset))
const speed = Number(values.speed)

const median = (xs: Array<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN
const pct = (xs: Array<number>, q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? NaN
const fmt = (xs: Array<number>) =>
  xs.length === 0 ? "n/a" : `median ${median(xs).toFixed(0)}, p90 ${pct(xs, 0.9).toFixed(0)}, min ${Math.min(...xs).toFixed(0)}, max ${Math.max(...xs).toFixed(0)}`
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`

interface Clip {
  readonly name: string
  readonly text: string
  readonly lang: string
}

interface Scored {
  readonly name: string
  readonly lang: string
  readonly text: string
  readonly turns: number
  readonly errors: number
  readonly words: number
  readonly eagerMs: number | undefined
  readonly finalMs: number | undefined
  readonly startedMs: number | undefined
  readonly same: boolean | undefined
  readonly resumed: number
}

/**
 * Assigns each turn to an utterance by the time the turn started (its `SpeechStarted`, or for a turn without
 * one its first event): the last utterance whose speech started (minus 300 ms) before it. So a slow
 * `EndOfTurn` that arrives after the next clip has begun still counts for its own clip.
 */
const score = (
  events: ReadonlyArray<{ at: number; event: SttEvent }>,
  utterances: ReadonlyArray<Utterance>,
  clips: ReadonlyMap<string, Clip>,
  t0: number,
  study: boolean
): Array<Scored> => {
  const owner = (at: number) => {
    let u = -1
    for (let i = 0; i < utterances.length; i++) if (at >= t0 + (utterances[i]!.speechStartMs - 300) / speed) u = i
    return u
  }
  const per = utterances.map(() => ({ texts: [] as Array<string>, eager: undefined as number | undefined, final: undefined as number | undefined, started: undefined as number | undefined, same: undefined as boolean | undefined, resumed: 0 }))
  let lastEager: { at: number; text: string } | undefined
  let turnStart: number | undefined
  for (const { at, event } of events) {
    // The detector sends one SpeechStarted per turn, so each one starts a new turn.
    if (event._tag === "SpeechStarted" || turnStart === undefined || turnStart === -1) turnStart = at
    const u = owner(turnStart)
    if (u < 0) continue
    const p = per[u]!
    const end = t0 + utterances[u]!.speechEndMs / speed
    if (event._tag === "SpeechStarted" && p.started === undefined) p.started = at - (t0 + utterances[u]!.speechStartMs / speed)
    if (event._tag === "TurnResumed") p.resumed++
    if (event._tag === "EagerEndOfTurn") lastEager = { at, text: event.text }
    if (event._tag !== "EndOfTurn") continue
    p.texts.push(event.text)
    p.final = at - end
    p.eager = lastEager ? lastEager.at - end : undefined
    p.same = lastEager !== undefined && normalize(lastEager.text) === normalize(event.text)
    lastEager = undefined
    turnStart = -1
  }
  return utterances.map((utterance, i) => {
    const p = per[i]!
    const clip = clips.get(utterance.name)!
    const text = p.texts.join(" ")
    const wer = study ? studyWordErrors(clip.text, text, clip.lang) : wordErrors(clip.text, text)
    return {
      name: utterance.name,
      lang: clip.lang,
      text,
      turns: p.texts.length,
      ...wer,
      eagerMs: p.eager,
      finalMs: p.final,
      startedMs: p.started,
      same: p.texts.length === 1 ? p.same : false,
      resumed: p.resumed
    }
  })
}

const summary = (label: string, rows: ReadonlyArray<Scored>) => {
  const words = rows.reduce((n, r) => n + r.words, 0)
  const errors = rows.reduce((n, r) => n + r.errors, 0)
  const finals = rows.filter((r) => r.finalMs !== undefined)
  const eager = rows.flatMap((r) => (r.eagerMs !== undefined ? [r.eagerMs] : []))
  const result = {
    label,
    clips: rows.length,
    wer: +(100 * errors / Math.max(1, words)).toFixed(1),
    errors,
    words,
    split: rows.filter((r) => r.turns > 1).length,
    missed: rows.filter((r) => r.turns === 0).length,
    resumed: rows.reduce((n, r) => n + r.resumed, 0),
    eagerEqualsFinal: `${rows.filter((r) => r.same === true).length}/${finals.length}`,
    eagerMs: { median: median(eager), p90: pct(eager, 0.9), max: Math.max(...eager) },
    finalMs: { median: median(finals.map((r) => r.finalMs!)), p90: pct(finals.map((r) => r.finalMs!), 0.9), max: Math.max(...finals.map((r) => r.finalMs!)) }
  }
  console.log(
    `${label.padEnd(14)} WER ${String(result.wer).padStart(5)} % (${errors}/${words}), ${result.split} split, ${result.missed} missed, ` +
      `${result.resumed} resumed, eager==final ${result.eagerEqualsFinal}, ` +
      `eager ${fmt(eager)} ms; final ${fmt(finals.map((r) => r.finalMs!))} ms`
  )
  return result
}

const program = Effect.gen(function*() {
  const stt = yield* Stt
  console.log(`model ${model}; speed ${speed}x; rss after load ${mb(process.memoryUsage().rss)}`)
  const loop = monitorEventLoopDelay({ resolution: 10 })
  const results: Array<unknown> = []

  const runTimeline = (pcm: Uint8Array) =>
    Effect.gen(function*() {
      let t0 = 0
      const events: Array<{ at: number; event: SttEvent }> = []
      yield* stt.transcribe(pacedAudio(pcm, { speed, t0: (t) => (t0 = t) })).pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push({ at: performance.now(), event })))
      )
      return { events, t0 }
    })

  loop.enable()
  if (values.set) {
    const setDir = join(defaultModelDir, "test-wavs", "stt-quality")
    if (!existsSync(join(setDir, "items.json"))) throw new Error(`${setDir}/items.json is missing (see README: the degraded test set)`)
    const items = JSON.parse(readFileSync(join(setDir, "items.json"), "utf8")) as Record<string, { text: string; lang: string }>
    const langs = values.lang ? values.lang.split(",") : multilingual ? ["en", "nl"] : ["en"]
    const clips = new Map<string, Clip>()
    for (const [name, item] of Object.entries(items)) if (langs.includes(item.lang)) clips.set(`${name}.wav`, { name, ...item })
    const all: Array<Scored> = []
    for (const condition of values.conditions.split(",")) {
      const parts: Array<string | number> = [1000]
      for (const name of clips.keys()) parts.push(name, 1500)
      const { pcm, utterances } = timeline(parts, { dir: join(setDir, "cond", condition), spanDir: join(setDir, "cond", "clean") })
      const { events, t0 } = yield* runTimeline(pcm)
      const rows = score(events, utterances, clips, t0, true)
      all.push(...rows)
      for (const lang of langs) results.push({ condition, lang, ...summary(`${condition}/${lang}`, rows.filter((r) => r.lang === lang)) })
      if (values.json) results.push({ condition, rows, events: events.map((e) => ({ at: e.at - t0, ...e.event })) })
    }
    for (const lang of langs) {
      const rows = all.filter((r) => r.lang === lang)
      results.push({ condition: "all", lang, ...summary(`all/${lang}`, rows) })
    }
  } else {
    const wavs = multilingual || preset.kind === "streaming" && takesLanguage(preset)
      ? ["0.wav", "1.wav", "nl0.wav", "nl1.wav", "nl2.wav"]
      : ["0.wav", "1.wav"]
    const refs = references()
    const clips = new Map(wavs.map((w) => [w, { name: w, text: refs[w] ?? "", lang: w.startsWith("nl") ? "nl" : "en" }]))
    const parts: Array<string | number> = [1000]
    for (let r = 0; r < Number(values.rounds); r++) for (const wav of wavs) parts.push(wav, 1500)
    const { pcm, utterances } = timeline(parts)
    const { events, t0 } = yield* runTimeline(pcm)
    const rows = score(events, utterances, clips, t0, false)
    for (const row of rows) {
      console.log(
        `  ${row.name.padEnd(8)} started ${row.startedMs?.toFixed(0).padStart(4)} ms, eager ${row.eagerMs?.toFixed(0).padStart(4) ?? "   -"} ms, ` +
          `final ${row.finalMs?.toFixed(0).padStart(4)} ms, ${row.errors}/${row.words} word errors: ${row.text}`
      )
    }
    const started = rows.flatMap((r) => (r.startedMs !== undefined ? [r.startedMs] : []))
    console.log(`speech onset → SpeechStarted: ${fmt(started)} ms`)
    results.push(summary("clean", rows))
  }
  loop.disable()
  const loopStats = {
    p50: +(loop.percentile(50) / 1e6 - 10).toFixed(1),
    p99: +(loop.percentile(99) / 1e6 - 10).toFixed(1),
    max: +(loop.max / 1e6 - 10).toFixed(1)
  }
  console.log(`main event-loop delay (10 ms timer): p50 ${loopStats.p50} ms, p99 ${loopStats.p99} ms, max ${loopStats.max} ms`)
  console.log(`rss after the latency phase ${mb(process.memoryUsage().rss)}`)

  // Soak phase
  const soakMinutes = Number(values["soak-minutes"])
  const soak: Array<{ minute: number; rssMb: number; turns: number }> = []
  if (soakMinutes > 0) {
    const soakSpeed = Number(values["soak-speed"])
    const wavs = ["0.wav", "1.wav", "nl0.wav", "nl1.wav", "nl2.wav"]
    const parts: Array<string | number> = [1000]
    for (const wav of wavs) parts.push(wav, 1500)
    const { pcm } = timeline(parts)
    const audioMs = pcm.length / 32
    const loops = Math.ceil(soakMinutes * 60_000 / audioMs)
    const looped = new Uint8Array(pcm.length * loops)
    for (let i = 0; i < loops; i++) looped.set(pcm, i * pcm.length)
    let turns = 0
    let nextReport = 60_000
    let start = 0
    yield* stt.transcribe(pacedAudio(looped, { speed: soakSpeed, t0: (t) => (start = t) })).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event._tag === "EndOfTurn") turns++
          const audioAt = (performance.now() - start) * soakSpeed
          if (audioAt >= nextReport) {
            const rss = process.memoryUsage().rss
            soak.push({ minute: Math.round(audioAt / 60_000), rssMb: Math.round(rss / 1e6), turns })
            console.log(`  soak: ${(audioAt / 60_000).toFixed(1)} min of audio, ${turns} turns, rss ${mb(rss)}`)
            nextReport += 60_000
          }
        })
      )
    )
    console.log(`soak done: ${(loops * audioMs / 60_000).toFixed(1)} min of audio at ${soakSpeed}x, ${turns} turns, rss ${mb(process.memoryUsage().rss)}`)
  }
  if (values.json) {
    const { writeFileSync } = yield* Effect.promise(() => import("node:fs"))
    writeFileSync(values.json, JSON.stringify({ model, speed, results, loop: loopStats, soak }, null, 1))
  }
})

const options = {
  model,
  eagerSilenceMs: Number(values.eager),
  finalSilenceMs: Number(values.final),
  maxBacklogMs: 10_000,
  agc: values.agc !== "off",
  ...(values.vad ? { vadThreshold: Number(values.vad) } : {}),
  ...(values.language ? { language: values.language } : {}),
  ...(values.padding ? { tailPaddingMs: Number(values.padding) } : {})
}
const sttLayer = values.baseline
  ? Layer.unwrap(Effect.promise(async () => {
    const path = "../src/baseline.tmp/SherpaStt.ts"
    const old = await import(path)
    const { agc: _agc, model: _model, ...rest } = options
    return old.layer({ ...rest, model: "nemotron-3.5" }) as Layer.Layer<Stt, unknown>
  }))
  : layer(options)
Effect.runPromise(program.pipe(Effect.provide(sttLayer))).catch((error) => {
  console.error(error)
  process.exit(1)
})
