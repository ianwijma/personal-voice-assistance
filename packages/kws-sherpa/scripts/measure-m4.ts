/**
 * M4 (docs/VOICE-NODES.md §9): the keyword spotter's cost, fire delay, misses and false fires. Run from the
 * package directory (models under <repo>/models or KWS_MODEL_DIR):
 *
 *   tsx scripts/measure-m4.ts --model gigaspeech-bpe --phrases "hey jeff,hey jev" --threshold 0.25,0.35 \
 *     [--score 1.0] [--threads 1] [--samples <synth dir with manifest.json>] [--positives <dir of wake WAVs>] \
 *     [--negatives <dir of WAVs, searched recursively>] [--json out.json]
 *   tsx scripts/measure-m4.ts --model gigaspeech-bpe --realtime-minutes 10 --negatives <dir>
 *
 * Everything is fed as 20 ms frames (320 samples at 16 kHz), as the node would.
 *
 * - load: ms to build the spotter (model load + keyword graph) — the cost of changing phrases at runtime.
 * - cost: the negatives concatenated and fed as fast as possible; CPU ms (process.cpuUsage, user + system) and
 *   wall ms over audio ms; `accept()` time per 20 ms frame (p50 / p99 / max — most frames only buffer features,
 *   one in every chunk runs the model).
 * - positives (--samples: synthetic, phrase end known from the manifest; --positives: recordings, phrase end = the
 *   last 10 ms window within 25 dB of the clip's peak, so record the phrase alone): each clip on a fresh stream; a
 *   hit is a fire between 0.5 s before and 1.5 s after the phrase end; delay = audio time of the frame whose
 *   `accept()` returned the fire minus the phrase end (add the frame's compute time, `accept` p99, for wall time).
 * - near misses (--samples, kind near-miss): fires per clip, each clip on a fresh stream.
 * - continuous negatives (--negatives): all files back to back on one stream (no resets but the spotter's own
 *   after 1.5 s of trailing blanks), fires per hour.
 * - --realtime-minutes: paces the negatives at real time for that long and reports CPU % (process.cpuUsage), so
 *   `pidstat -u -r -p <pid> 1` can be run next to it (scripts/pi-m4.sh does both).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { isKwsModelName, kwsModels } from "../src/models.ts"
import { createSpotter, type Fire, type Spotter } from "../src/spotter.ts"
import { readWav16k } from "./wav.ts"

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "gigaspeech-bpe" },
    phrases: { type: "string", default: "hey jeff,hey jev" },
    threshold: { type: "string", default: "0.25" },
    score: { type: "string", default: "1.0" },
    "trailing-blanks": { type: "string", default: "1" },
    threads: { type: "string", default: "1" },
    samples: { type: "string" },
    positives: { type: "string" },
    negatives: { type: "string" },
    "realtime-minutes": { type: "string" },
    json: { type: "string" }
  }
})

if (!isKwsModelName(values.model)) throw new Error(`--model: one of ${Object.keys(kwsModels).join(", ")}`)
const model = kwsModels[values.model]
const phrases = values.phrases.split(",").map((t) => ({ text: t.trim() })).filter((p) => p.text !== "")
const FRAME = 320

const pct = (xs: ReadonlyArray<number>, p: number): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const r1 = (x: number) => Math.round(x * 10) / 10
const r3 = (x: number) => Math.round(x * 1000) / 1000

const wavsIn = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? wavsIn(p) : n.toLowerCase().endsWith(".wav") ? [p] : []
  }).sort()

/** Feed one clip in 20 ms frames; fires with the audio time at the end of the frame that produced them. */
const run = (s: Spotter, x: Float32Array, frameMs?: Array<number>): Array<Fire & { readonly t: number }> => {
  const fires: Array<Fire & { readonly t: number }> = []
  for (let i = 0; i < x.length; i += FRAME) {
    const t0 = performance.now()
    const f = s.accept(x.subarray(i, Math.min(x.length, i + FRAME)))
    frameMs?.push(performance.now() - t0)
    for (const fire of f) fires.push({ ...fire, t: Math.min(x.length, i + FRAME) / 16000 })
  }
  return fires
}

/** End of the last 10 ms window within 25 dB of the peak. */
const lastLoud = (x: Float32Array): number => {
  const w = 160
  const env: Array<number> = []
  for (let i = 0; i < x.length; i += w) {
    let e = 0
    for (let j = i; j < Math.min(x.length, i + w); j++) e += x[j]! * x[j]!
    env.push(Math.sqrt(e / w))
  }
  const peak = Math.max(...env)
  let last = 0
  env.forEach((e, i) => {
    if (e > peak * 10 ** (-25 / 20)) last = i
  })
  return ((last + 1) * w) / 16000
}

interface Positive {
  readonly file: string
  readonly phraseEnd: number
  readonly group: string
  readonly x: Float32Array
}
interface ManifestItem {
  readonly file: string
  readonly kind: string
  readonly text: string
  readonly condition: string
  readonly phraseEnd?: number
}

const positives: Array<Positive> = []
const nearMisses: Array<{ readonly file: string; readonly x: Float32Array }> = []
if (values.samples !== undefined) {
  const manifest = JSON.parse(readFileSync(join(values.samples, "manifest.json"), "utf8")) as ReadonlyArray<ManifestItem>
  for (const m of manifest) {
    const x = readWav16k(join(values.samples, m.file))
    if (m.kind === "near-miss") nearMisses.push({ file: m.file, x })
    else positives.push({ file: m.file, phraseEnd: m.phraseEnd!, group: `${m.text.toLowerCase()} / ${m.kind} / ${m.condition}`, x })
  }
}
if (values.positives !== undefined) {
  for (const f of wavsIn(values.positives)) {
    const x = readWav16k(f)
    positives.push({ file: f, phraseEnd: lastLoud(x), group: "recorded", x })
  }
}
const negatives = values.negatives === undefined ? [] : wavsIn(values.negatives).map((f) => ({ file: f, x: readWav16k(f) }))
const negSeconds = negatives.reduce((s, n) => s + n.x.length, 0) / 16000

const results: Array<unknown> = []
for (const threshold of values.threshold.split(",").map(Number)) {
  const opts = {
    model,
    phrases,
    threads: Number(values.threads),
    keywordsThreshold: threshold,
    keywordsScore: Number(values.score),
    numTrailingBlanks: Number(values["trailing-blanks"])
  }
  const tl = performance.now()
  const s = createSpotter(opts)
  const loadMs = performance.now() - tl
  const rssMb = process.memoryUsage().rss / 1e6
  const res: Record<string, unknown> = {
    model: model.name,
    threshold,
    score: opts.keywordsScore,
    threads: opts.threads,
    keywords: s.keywords,
    loadMs: r1(loadMs),
    rssMbAfterLoad: r1(rssMb)
  }

  if (values["realtime-minutes"] !== undefined) {
    if (negatives.length === 0) throw new Error("--realtime-minutes needs --negatives")
    const all = new Float32Array(negatives.reduce((k, n) => k + n.x.length, 0))
    negatives.reduce((off, n) => (all.set(n.x, off), off + n.x.length), 0)
    const endAt = performance.now() + Number(values["realtime-minutes"]) * 60_000
    const c0 = process.cpuUsage()
    const w0 = performance.now()
    let i = 0
    let frames = 0
    let fires = 0
    console.log(`pid ${process.pid}: streaming at real time for ${values["realtime-minutes"]} min`)
    await new Promise<void>((resolve) => {
      const tick = () => {
        const now = performance.now()
        // catch up on every frame that is due (setTimeout drifts)
        while (frames * 20 <= now - w0) {
          if (i + FRAME > all.length) i = 0
          fires += s.accept(all.subarray(i, i + FRAME)).length
          i += FRAME
          frames++
        }
        if (now >= endAt) resolve()
        else setTimeout(tick, 20 - ((now - w0) % 20))
      }
      tick()
    })
    const c = process.cpuUsage(c0)
    const wall = performance.now() - w0
    res["realtime"] = {
      minutes: r1(wall / 60000),
      cpuPercentOfOneCore: r1(((c.user + c.system) / 1000 / wall) * 100),
      fires,
      rssMb: r1(process.memoryUsage().rss / 1e6)
    }
    console.log(JSON.stringify(res, null, 1))
    results.push(res)
    continue
  }

  if (negatives.length > 0) {
    s.reset()
    const frameMs: Array<number> = []
    const c0 = process.cpuUsage()
    const w0 = performance.now()
    const fires: Array<{ file: string; keyword: string; t: number }> = []
    for (const n of negatives) for (const f of run(s, n.x, frameMs)) fires.push({ file: n.file, keyword: f.keyword, t: r3(f.t) })
    const wall = performance.now() - w0
    const c = process.cpuUsage(c0)
    const cpuMs = (c.user + c.system) / 1000
    res["cost"] = {
      audioMinutes: r1(negSeconds / 60),
      rtfWall: r3(wall / (negSeconds * 1000)),
      cpuPercentOfOneCoreAtRealTime: r1((cpuMs / (negSeconds * 1000)) * 100),
      acceptMsPerFrame: { p50: r3(pct(frameMs, 50)), p99: r3(pct(frameMs, 99)), max: r3(Math.max(...frameMs)) }
    }
    res["continuousNegatives"] = {
      files: negatives.length,
      hours: r3(negSeconds / 3600),
      fires: fires.length,
      firesPerHour: r1(fires.length / (negSeconds / 3600)),
      list: fires.slice(0, 40)
    }
  }

  if (positives.length > 0) {
    const delays: Array<number> = []
    const misses: Array<string> = []
    const byGroup = new Map<string, { n: number; hit: number }>()
    let extraFires = 0
    for (const p of positives) {
      s.reset()
      const fires = run(s, p.x)
      const hit = fires.find((f) => f.t >= p.phraseEnd - 0.5 && f.t <= p.phraseEnd + 1.5)
      extraFires += fires.filter((f) => f !== hit).length
      const g = byGroup.get(p.group) ?? { n: 0, hit: 0 }
      g.n++
      if (hit !== undefined) {
        g.hit++
        delays.push((hit.t - p.phraseEnd) * 1000)
      } else misses.push(p.file)
      byGroup.set(p.group, g)
    }
    res["positives"] = {
      clips: positives.length,
      misses: misses.length,
      missRate: r3(misses.length / positives.length),
      fireDelayMsAfterPhraseEnd: { p50: Math.round(pct(delays, 50)), p95: Math.round(pct(delays, 95)), max: Math.round(Math.max(...delays)), min: Math.round(Math.min(...delays)) },
      extraFiresOutsideWindow: extraFires,
      byGroup: Object.fromEntries([...byGroup].sort().map(([k, v]) => [k, `${v.hit}/${v.n}`])),
      missed: misses.slice(0, 30)
    }
  }

  if (nearMisses.length > 0) {
    const fired: Array<string> = []
    for (const n of nearMisses) {
      s.reset()
      const f = run(s, n.x)
      if (f.length > 0) fired.push(`${n.file} → ${f.map((x) => x.keyword).join(",")}`)
    }
    res["nearMisses"] = { clips: nearMisses.length, clipsWithFire: fired.length, list: fired.slice(0, 40) }
  }

  console.log(JSON.stringify(res, null, 1))
  results.push(res)
}
if (values.json !== undefined) writeFileSync(values.json, JSON.stringify(results, null, 1))
