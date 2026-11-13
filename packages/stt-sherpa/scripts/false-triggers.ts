/**
 * False triggers: how often constructed noise (and the assistant's own voice,
 * quietly, as an echo would arrive) makes the local Stt report speech, for
 * several VAD thresholds with the gain control on and off. Through the real
 * adapter. Run from the package directory:
 *
 *   tsx scripts/false-triggers.ts [--model parakeet-v2] [--seconds 60] [--speed 6] [--vad 0.5,0.35,0.3]
 *
 * Per noise and setting: `SpeechStarted` per minute (each one would interrupt a
 * reply in "Headphones: instant" mode) and turns with words per minute (each
 * one would be answered). The echo rows use the five `bench-audio` questions
 * (the assistant's Piper voice) at a low level, with pauses, over the server's
 * noise floor: they are speech, so detections there show how much louder the
 * gain control makes a quiet echo, not a VAD fault.
 */
import { Stt } from "@pva/core"
import { Effect, Layer, Stream } from "effect"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { resolvePresetName } from "../src/presets.ts"
import { layer } from "../src/SherpaStt.ts"
import { pacedAudio, readWav } from "../test/fixtures.ts"

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "parakeet-v2" },
    seconds: { type: "string", default: "60" },
    speed: { type: "string", default: "6" },
    vad: { type: "string", default: "0.5,0.35,0.3" }
  }
})
const model = resolvePresetName(values.model)
if (model === undefined) throw new Error(`unknown model ${values.model}`)
const seconds = Number(values.seconds)
const N = seconds * 16000

let seed = 12345
const random = () => {
  seed = (seed * 1103515245 + 12345) >>> 0
  return (seed / 2 ** 32) * 2 - 1
}
const amp = (dbfs: number) => 10 ** (dbfs / 20)
const rmsOf = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length)
const toPcm = (x: Float32Array) => {
  const s = new Int16Array(x.length)
  for (let i = 0; i < x.length; i++) s[i] = Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32768)))
  return new Uint8Array(s.buffer)
}
const atRms = (x: Float32Array, dbfs: number) => {
  const g = amp(dbfs) / rmsOf(x)
  return x.map((v) => v * g)
}
const floor = () => Float32Array.from({ length: N }, () => random() * amp(-75) * Math.sqrt(3))
const white = (dbfs: number) => atRms(Float32Array.from({ length: N }, random), dbfs)
const pink = (dbfs: number) => {
  // Paul Kellet's economy pink filter.
  let b0 = 0, b1 = 0, b2 = 0
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const w = random()
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    x[i] = b0 + b1 + b2 + w * 0.1848
  }
  return atRms(x, dbfs)
}
const hum = (peakDbfs: number) => {
  const x = floor()
  for (let i = 0; i < N; i++) {
    const t = i / 16000
    x[i]! += amp(peakDbfs) * (0.6 * Math.sin(2 * Math.PI * 50 * t) + 0.3 * Math.sin(2 * Math.PI * 150 * t) + 0.1 * Math.sin(2 * Math.PI * 250 * t))
  }
  return x
}
const clicks = (peakDbfs: number) => {
  const x = white(-65)
  for (let start = 8000; start + 80 < N; start += 11_200) {
    for (let k = 0; k < 80; k++) x[start + k]! += amp(peakDbfs) * Math.exp(-k / 15) * (k % 2 === 0 ? 1 : -1)
  }
  return x
}
const benchDir = join(import.meta.dirname, "..", "..", "..", "bench-audio")
const benchClips = () =>
  readdirSync(benchDir).filter((f) => f.endsWith(".wav")).sort().map((f) => {
    const s = new Int16Array(readWav(join(benchDir, f)).slice().buffer)
    return Float32Array.from(s, (v) => v / 32768)
  })
/** The assistant's voice, at `peakDbfs`, every ~3 s, over the server's floor. */
const echo = (peakDbfs: number) => {
  const x = floor()
  const clips = benchClips()
  let at = 8000
  for (let k = 0; at < N; k++) {
    const clip = clips[k % clips.length]!
    const peak = clip.reduce((p, v) => Math.max(p, Math.abs(v)), 0)
    const g = amp(peakDbfs) / peak
    for (let i = 0; i < clip.length && at + i < N; i++) x[at + i]! += clip[i]! * g
    at += clip.length + 3 * 16000
  }
  return x
}
/** Six overlapping voices (TV in the next room), at `dbfs` RMS. */
const babble = (dbfs: number) => {
  const x = new Float32Array(N)
  const clips = benchClips()
  for (let v = 0; v < 6; v++) {
    let at = Math.floor(v * 7919) % 16000
    for (let k = v; at < N; k++) {
      const clip = clips[k % clips.length]!
      for (let i = 0; i < clip.length && at + i < N; i++) x[at + i]! += clip[i]!
      at += clip.length + 2000
    }
  }
  return atRms(x, dbfs)
}

const noises: Array<[string, () => Float32Array]> = [
  ["server floor -75 dBFS", floor],
  ["white -55 dBFS", () => white(-55)],
  ["white -45 dBFS", () => white(-45)],
  ["pink -50 dBFS (fan)", () => pink(-50)],
  ["pink -40 dBFS", () => pink(-40)],
  ["pink -30 dBFS", () => pink(-30)],
  ["hum 50 Hz peak -35 dBFS", () => hum(-35)],
  ["clicks peak -20 dBFS", () => clicks(-20)],
  ["babble -45 dBFS (TV)", () => babble(-45)],
  ["echo: own voice peak -50 dBFS", () => echo(-50)],
  ["echo: own voice peak -40 dBFS", () => echo(-40)]
]

const thresholds = values.vad.split(",").map(Number)
const speed = Number(values.speed)
const rows: Array<string> = []

const run = (vad: number, agc: boolean) =>
  Effect.gen(function*() {
    const stt = yield* Stt
    for (const [name, make] of noises) {
      seed = 12345
      const pcm = toPcm(make())
      const events = yield* stt.transcribe(pacedAudio(pcm, { speed })).pipe(Stream.runCollect)
      const started = events.filter((e) => e._tag === "SpeechStarted").length
      const turns = events.filter((e) => e._tag === "EndOfTurn")
      const perMin = (n: number) => ((n * 60) / seconds).toFixed(1)
      const texts = turns.map((t) => ("text" in t ? t.text : "")).slice(0, 3).join(" | ")
      const row = `${name.padEnd(32)} vad ${vad.toFixed(2)} agc ${agc ? "on " : "off"}  SpeechStarted ${perMin(started).padStart(5)}/min, turns ${perMin(turns.length).padStart(5)}/min${texts ? `  "${texts.slice(0, 80)}"` : ""}`
      rows.push(row)
      console.log(row)
    }
  }).pipe(Effect.provide(Layer.fresh(layer({ model, vadThreshold: vad, agc, maxBacklogMs: 60_000 }))))

const program = Effect.gen(function*() {
  for (const vad of thresholds) for (const agc of [false, true]) yield* run(vad, agc)
  console.log("\nsorted by noise:")
  for (const row of [...rows].sort()) console.log(row)
})
Effect.runPromise(program).catch((error) => {
  console.error(error)
  process.exit(1)
})
