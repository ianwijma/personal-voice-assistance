/**
 * `compare-models [--models a,b] [--speed 1] [--agc on|off|both] [--ref "text"] <wav files or directories>`
 *
 * Is it the audio or the model? Runs each recording (16 kHz mono WAV, e.g. the
 * ones saved by "Save what the assistant hears" in data/recordings) through
 * every installed local recogniser preset, one model loaded at a time, through
 * the same adapter as live use (VAD, turn detection, gain control), and prints
 * the level statistics of each file, then per model: the transcript, how many
 * turns it became, and when the speculative and final transcripts arrived
 * after the last speech in the file (at `--speed` × real time; only 1 gives
 * live latencies). With `--ref`, the word error rate against that text.
 */
import { loadInputPcm } from "@pva/audio-file"
import { Stt, type SttEvent } from "@pva/core"
import * as SherpaStt from "@pva/stt-sherpa"
import { Context, Effect, Layer, Queue, Stream } from "effect"
import { readdirSync, statSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"
import { userCwd } from "./env.ts"
import { formatLevelStats, levelStats } from "./levels.ts"
import { StartupError } from "./startup.ts"

const usage = "Usage: compare-models [--models a,b] [--speed 1] [--agc on|off|both] [--ref \"text\"] <wav files or directories>"

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter(Boolean)
const wordErrorRate = (reference: string, hypothesis: string) => {
  const r = words(reference)
  const h = words(hypothesis)
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j)
  for (let i = 1; i <= r.length; i++) {
    const row = [i]
    for (let j = 1; j <= h.length; j++) row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1)))
    prev = row
  }
  return r.length === 0 ? 0 : prev[h.length]! / r.length
}

/** End of the last 20 ms frame within 25 dB of the loudest frame, in ms. */
const speechEndMs = (pcm: Int16Array) => {
  const energy: Array<number> = []
  for (let f = 0; (f + 1) * 320 <= pcm.length; f++) {
    let sum = 0
    for (let i = f * 320; i < (f + 1) * 320; i++) sum += pcm[i]! ** 2
    energy.push(sum)
  }
  const peak = Math.max(...energy)
  return (energy.findLastIndex((e) => e >= peak / 10 ** 2.5) + 1) * 20
}

/** Low white noise (about -75 dBFS), as the server feeds when nobody speaks. */
const noise = (ms: number) => {
  const samples = new Int16Array(ms * 16)
  let seed = 0x2545f491
  for (let i = 0; i < samples.length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    samples[i] = ((seed >>> 0) % 21) - 10
  }
  return new Uint8Array(samples.buffer)
}

/** The bytes as 20 ms chunks at `speed` × real time; `t0` gets the time of position 0. */
const paced = (pcm: Uint8Array, speed: number, t0: (t: number) => void) =>
  Stream.callback<Uint8Array>((queue) =>
    Effect.promise(async () => {
      const start = performance.now()
      t0(start)
      for (let k = 0; k * 640 < pcm.length; k++) {
        const wait = start + (k * 20) / speed - performance.now()
        if (wait > 1) await sleep(wait)
        Queue.offerUnsafe(queue, pcm.subarray(k * 640, (k + 1) * 640))
      }
      Queue.endUnsafe(queue)
    })
  )

const wavFiles = (paths: ReadonlyArray<string>) =>
  paths.flatMap((p) => {
    const path = resolve(userCwd, p)
    return statSync(path).isDirectory()
      ? readdirSync(path).filter((n) => n.toLowerCase().endsWith(".wav")).sort().map((n) => join(path, n))
      : [path]
  })

export const compareModelsCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            models: { type: "string" },
            speed: { type: "string", default: "1" },
            agc: { type: "string", default: "on" },
            ref: { type: "string" }
          },
          allowPositionals: true
        }),
      catch: (e) => new StartupError({ message: `${e instanceof Error ? e.message : String(e)}. ${usage}` })
    })
    const files = yield* Effect.try({
      try: () => wavFiles(parsed.positionals),
      catch: (e) => new StartupError({ message: `${e instanceof Error ? e.message : String(e)}. ${usage}` })
    })
    if (files.length === 0) return yield* new StartupError({ message: usage })
    const speed = Number(parsed.values.speed)
    const installed = SherpaStt.installedPresets()
    const wanted = parsed.values.models?.split(",").map((m) => m.trim()) ?? installed
    const models = wanted.filter((m): m is SherpaStt.PresetName => installed.includes(m as SherpaStt.PresetName))
    for (const m of wanted) if (!models.includes(m as SherpaStt.PresetName)) console.log(`skipping ${m}: not installed (${SherpaStt.DOWNLOAD_COMMAND} ${m})`)
    const agcModes = parsed.values.agc === "both" ? [true, false] : [parsed.values.agc !== "off"]

    // The recordings, with 1.5 s of noise after each so the last turn can end.
    const inputs = yield* Effect.forEach(files, (file) =>
      loadInputPcm(file).pipe(
        Effect.map((bytes) => {
          const pcm = new Int16Array(bytes.slice().buffer)
          return { file, bytes, pcm, endMs: speechEndMs(pcm) }
        }),
        Effect.mapError((e) => new StartupError({ message: `${file}: ${e.message}` }))
      ))
    for (const input of inputs) console.log(`${basename(input.file)}: ${formatLevelStats(levelStats(input.pcm))}`)
    console.log("")

    const rows: Array<{ file: string; model: string; text: string; turns: number; eager?: number; final?: number; wer?: number }> = []
    for (const model of models) {
      for (const agc of agcModes) {
        const label = agcModes.length > 1 ? `${model} (gain control ${agc ? "on" : "off"})` : model
        const loadStart = performance.now()
        yield* Effect.scoped(Effect.gen(function*() {
          const stt = yield* Layer.build(SherpaStt.layer({ model, agc, maxBacklogMs: 30_000 })).pipe(
            Effect.map((context) => Context.get(context, Stt))
          )
          console.log(`${label}: loaded in ${Math.round(performance.now() - loadStart)} ms`)
          for (const input of inputs) {
            const audio = new Uint8Array(input.bytes.length + 1500 * 32)
            audio.set(input.bytes)
            audio.set(noise(1500), input.bytes.length)
            let t0 = 0
            const events: Array<{ at: number; event: SttEvent }> = []
            yield* stt.transcribe(paced(audio, speed, (t) => (t0 = t))).pipe(
              Stream.runForEach((event) => Effect.sync(() => events.push({ at: performance.now(), event })))
            )
            const end = t0 + input.endMs / speed
            const finals = events.filter((e) => e.event._tag === "EndOfTurn")
            const lastFinal = finals.at(-1)
            const lastEager = events.filter((e) => e.event._tag === "EagerEndOfTurn").at(-1)
            const text = finals.map((e) => ("text" in e.event ? e.event.text : "")).join(" ")
            const row = {
              file: basename(input.file),
              model: label,
              text,
              turns: finals.length,
              ...(lastEager !== undefined ? { eager: lastEager.at - end } : {}),
              ...(lastFinal !== undefined ? { final: lastFinal.at - end } : {}),
              ...(parsed.values.ref !== undefined ? { wer: wordErrorRate(parsed.values.ref, text) } : {})
            }
            rows.push(row)
            const timing = `speculative ${row.eager === undefined ? "-" : `${Math.round(row.eager)} ms`}, final ${row.final === undefined ? "-" : `${Math.round(row.final)} ms`}`
            console.log(
              `  ${row.file}: ${timing} after the speech, ${row.turns} turn(s)` +
                (row.wer !== undefined ? `, ${(100 * row.wer).toFixed(0)} % word errors` : "") +
                `\n    "${text || "(nothing recognised)"}"`
            )
          }
        }))
      }
    }
    if (speed !== 1) console.log(`\n(at ${speed}× real time: the timings are not live latencies)`)
    return rows
  })
