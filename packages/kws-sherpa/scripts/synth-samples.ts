/**
 * Synthesises the M4 test set with the repo's local Kokoro model (28 English voices, `kokoro-multi-lang-v1_0`).
 * Run from the package directory:
 *
 *   tsx scripts/synth-samples.ts --out <dir> [--tts-model-dir <repo>/models] [--voices 28]
 *
 * Writes <out>/pos/*.wav (a wake phrase alone, or followed by a request after 150 ms) and <out>/neg/*.wav
 * (near-miss sentences: "hey chef", "hey Jess", …), each 16 kHz mono with 0.5 s of lead-in and 1.2 s of tail,
 * in one of three conditions (clean; pink noise at 15 dB SNR; quiet speech babble at −10 dB from another voice),
 * and <out>/manifest.json with the exact end of the phrase in each positive (measured on the clean phrase).
 *
 * Synthetic voices are not the owner's: the miss rate measured on these is a lower bound on the real one only in
 * the sense that it shows whether the model can work at all. The real M4 needs ≥ 50 recorded wakes (FINDINGS.md).
 */
import { presetFiles, presets } from "@pva/tts-sherpa"
import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { resample, writeWav16k } from "./wav.ts"

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "tts-model-dir": { type: "string", default: fileURLToPath(new URL("../../../models", import.meta.url)) },
    voices: { type: "string", default: "28" }
  }
})
if (values.out === undefined) throw new Error("--out <dir> is required")
const out = values.out
mkdirSync(join(out, "pos"), { recursive: true })
mkdirSync(join(out, "neg"), { recursive: true })

const preset = presets["kokoro-af_heart"]
if (preset === undefined) throw new Error("no kokoro preset")
const f = presetFiles(preset, values["tts-model-dir"])
// Kokoro skips words that are not in its lexicon ("Jev", "Geoff", "what's"), so add them (comma-separated list).
const extraLexicon = join(out, "extra-lexicon.txt")
writeFileSync(extraLexicon, ["jev ʤ ˈ ɛ v", "geoff ʤ ˈ ɛ f", "what's w ˈ ʌ t s", "jess ʤ ˈ ɛ s", "steph s t ˈ ɛ f", ""].join("\n"))
// as tts-sherpa's engineConfig for Kokoro
const config = {
  model: {
    kokoro: { model: f["model"], voices: f["voices"], tokens: f["tokens"], dataDir: f["dataDir"], lexicon: `${extraLexicon},${f["lexicon"]}`, lang: "en-us" },
    numThreads: 8,
    provider: "cpu",
    debug: false
  },
  maxNumSentences: 1,
  silenceScale: 0.2
}
const require = createRequire(import.meta.url)
const sherpa = require("sherpa-onnx-node") as {
  OfflineTts: new(c: unknown) => { generate(o: { text: string; sid: number; speed: number }): { samples: Float32Array; sampleRate: number } }
}
const tts = new sherpa.OfflineTts(config)

const say = (text: string, sid: number, speed: number): Float32Array => {
  const r = tts.generate({ text, sid, speed })
  return trim(resample(r.samples, r.sampleRate, 16000))
}

/** Cut leading/trailing audio quieter than 40 dB below the peak (10 ms windows). */
const trim = (x: Float32Array): Float32Array => {
  const w = 160
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  const floor = peak * 0.01
  const loud = (i: number) => {
    let m = 0
    for (let j = i; j < Math.min(x.length, i + w); j++) m = Math.max(m, Math.abs(x[j]!))
    return m > floor
  }
  let a = 0
  while (a < x.length && !loud(a)) a += w
  let b = x.length - w
  while (b > a && !loud(b)) b -= w
  return x.slice(a, Math.min(x.length, b + w))
}

const concat = (...parts: ReadonlyArray<Float32Array>): Float32Array => {
  const o = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    o.set(p, i)
    i += p.length
  }
  return o
}
const silence = (s: number) => new Float32Array(Math.round(s * 16000))

// deterministic PRNG so the set is reproducible
let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length))
const pink = (n: number): Float32Array => {
  // Paul Kellet's economy pink filter
  let b0 = 0, b1 = 0, b2 = 0
  const o = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    o[i] = b0 + b1 + b2 + w * 0.1848
  }
  return o
}
const mix = (x: Float32Array, noise: Float32Array, snrDb: number): Float32Array => {
  const g = rms(x) / Math.max(1e-9, rms(noise)) / 10 ** (snrDb / 20)
  return x.map((v, i) => v + g * (noise[i % noise.length] ?? 0))
}

const conditions = ["clean", "pink15", "babble10"] as const
type Condition = typeof conditions[number]
const babbleText = "So I told her the train was late again and we ended up walking the whole way home in the rain."
const babbleCache = new Map<number, Float32Array>()
const applyCondition = (x: Float32Array, c: Condition, sid: number): Float32Array => {
  if (c === "clean") return x
  if (c === "pink15") return mix(x, pink(x.length), 15)
  const other = (sid + 7) % 28
  let b = babbleCache.get(other)
  if (b === undefined) babbleCache.set(other, b = say(babbleText, other, 1))
  return mix(x, b, 10)
}

const voices = Number(values.voices)
const wakes = ["Hey Jeff", "Hey Jev", "Hey Geoff"]
const requests = ["what time is it?", "turn on the kitchen lights.", "what's the weather like tomorrow?"]
const nearMisses = [
  "Hey chef, is dinner ready?",
  "Hey Jess, come over here.",
  "Hey, Jen, did you call?",
  "Hey Steph, how was your day?",
  "A jet flew over the house.",
  "The chef left early today.",
  "He is deaf in one ear.",
  "Hey there, nice to meet you.",
  "They left the jam on the shelf.",
  "Hey, check this out.",
  "Hey Siri, set a timer.",
  "The ref gave him a yellow card.",
  "Heavy rain is expected tonight.",
  "Jeffrey is a common name.",
  "I said hey to the neighbours."
]

interface Item {
  readonly file: string
  readonly kind: "alone" | "with-request" | "near-miss"
  readonly text: string
  readonly sid: number
  readonly speed: number
  readonly condition: Condition
  /** seconds from the start of the file to the end of the wake phrase (positives only) */
  readonly phraseEnd?: number
  readonly duration: number
}
const manifest: Array<Item> = []
const lead = 0.5
const tail = 1.2
let n = 0
const t0 = Date.now()
for (let sid = 0; sid < voices; sid++) {
  for (const speed of [0.9, 1.15]) {
    for (const [wi, wake] of wakes.entries()) {
      const phrase = say(wake, sid, speed)
      for (const kind of ["alone", "with-request"] as const) {
        const condition = conditions[n++ % conditions.length]!
        const body = kind === "alone"
          ? phrase
          : concat(phrase, silence(0.15), say(requests[(sid + wi) % requests.length]!, sid, speed))
        const x = applyCondition(concat(silence(lead), body, silence(tail)), condition, sid)
        const file = `pos/v${sid}-s${speed}-w${wi}-${kind}-${condition}.wav`
        writeWav16k(join(out, file), x)
        manifest.push({ file, kind, text: wake, sid, speed, condition, phraseEnd: lead + phrase.length / 16000, duration: x.length / 16000 })
      }
    }
  }
  for (const [mi, text] of nearMisses.entries()) {
    const condition = conditions[n++ % conditions.length]!
    const x = applyCondition(concat(silence(lead), say(text, sid, 1), silence(tail)), condition, sid)
    const file = `neg/v${sid}-m${mi}-${condition}.wav`
    writeWav16k(join(out, file), x)
    manifest.push({ file, kind: "near-miss", text, sid, speed: 1, condition, duration: x.length / 16000 })
  }
  console.log(`voice ${sid + 1}/${voices} done (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1))
const sum = (k: Item["kind"]) => manifest.filter((m) => m.kind === k).reduce((s, m) => s + m.duration, 0)
console.log(`${manifest.length} files: positives ${manifest.filter((m) => m.kind !== "near-miss").length} (${((sum("alone") + sum("with-request")) / 60).toFixed(1)} min), near-misses ${manifest.filter((m) => m.kind === "near-miss").length} (${(sum("near-miss") / 60).toFixed(1)} min)`)
