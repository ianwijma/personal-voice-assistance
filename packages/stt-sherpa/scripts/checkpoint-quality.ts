/**
 * Does the streaming checkpoint (src/recognizerCore.mjs, SEGMENT_LIMITS) cost accuracy? Each clip runs through the
 * worker's logic and the TurnDetector exactly as in production (real model, real VAD, AGC on), twice: with the
 * checkpoints as configured, and with them off (the whole segment decoded in one stream, as before 2026-11-14).
 * Prints the word error rate of both and, for every checkpoint, the words on either side of the join next to
 * the reference and the uncut decode, so a split, dropped or duplicated word can be read off.
 * `tsx scripts/checkpoint-quality.ts [preset...] [--limits '{"checkpointMs":...}']`
 */
import { createRequire } from "node:module"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { makeAgc } from "../src/agc.mjs"
import { makeRecognizerCore } from "../src/recognizerCore.mjs"
import { defaultModelDir, missingFile, modelFiles, type PresetName, presets } from "../src/presets.ts"
import { fixedSilence, TurnDetector } from "../src/TurnDetector.ts"
import { normalize, readWav, wavDir, wordErrors } from "../test/fixtures.ts"

const sherpa = createRequire(import.meta.url)("sherpa-onnx-node")
const RATE = 16_000
const argv = process.argv.slice(2)
const limitsAt = argv.indexOf("--limits")
const limits = limitsAt >= 0 ? JSON.parse(argv[limitsAt + 1]!) : undefined
const condition = argv.includes("--noisy") ? "noise15" : "clean"
const wanted = argv.filter((a, i) => !a.startsWith("--") && (limitsAt < 0 || i !== limitsAt + 1)) as Array<PresetName>

const items = JSON.parse(readFileSync(join(wavDir, "stt-quality", "items.json"), "utf8")) as Record<string, { text: string; lang: string; dur: number }>
const pcm16 = (bytes: Uint8Array) => new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
const clips: Array<{ name: string; pcm: Int16Array; ref: string }> = []
for (const [name, item] of Object.entries(items)) {
  const file = join(wavDir, "stt-quality", "cond", condition, `${name}.wav`)
  if (item.lang === "en" && item.dur > 7 && existsSync(file)) clips.push({ name, pcm: pcm16(readWav(file)), ref: item.text })
}
// Continuous speech (150 ms gaps, under every pause threshold): the hard checkpoint's own case.
const refs = JSON.parse(readFileSync(join(wavDir, "refs.json"), "utf8")) as Record<string, string>
const joined = (names: ReadonlyArray<string>) => {
  const parts = names.flatMap((n) => [pcm16(readWav(join(wavDir, n))), new Int16Array(2400)])
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return { pcm: out, ref: names.map((n) => refs[n]!).join(" ") }
}
clips.push({ name: "0+1 (24 s, no pause)", ...joined(["0.wav", "1.wav"]) })
clips.push({ name: "1+0+1 (41 s, no pause)", ...joined(["1.wav", "0.wav", "1.wav"]) })

const recognizers = new Map<PresetName, any>()
const run = (preset: PresetName, pcm: Int16Array, segmentLimits: Record<string, number> | undefined) => {
  const p = presets[preset] as any
  const files = modelFiles(p, defaultModelDir)
  let online = recognizers.get(preset)
  if (online === undefined) {
    online = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: RATE, featureDim: p.model.featureDim },
      modelConfig: { transducer: { encoder: files.streaming!.encoder, decoder: files.streaming!.decoder, joiner: files.streaming!.joiner }, tokens: files.streaming!.tokens, numThreads: p.threads, provider: "cpu", debug: 0 },
      decodingMethod: "greedy_search",
      enableEndpoint: 0
    })
    recognizers.set(preset, online)
  }
  const vad = new sherpa.Vad({ sileroVad: { model: files.vad, threshold: 0.5, minSpeechDuration: 0.01, minSilenceDuration: 0.01, windowSize: 512 }, sampleRate: RATE, numThreads: 1, debug: false }, 60)
  const detector = new TurnDetector({ policy: fixedSilence(250, 600), minSpeechMs: 100 })
  const turns: Array<string> = []
  const checkpoints: Array<string> = []
  const inbox: Array<any> = []
  const core = makeRecognizerCore({
    config: { kind: "streaming", prerollMs: 400, agc: true, streaming: { tailPaddingMs: p.model.tailPaddingMs, language: p.model.multilingual ? "en" : undefined } },
    online,
    vad,
    agc: makeAgc({}),
    post: (m) => inbox.push(m),
    onCheckpoint: (text) => checkpoints.push(text),
    ...(segmentLimits ? { segmentLimits } : {})
  })
  const deliver = () => {
    while (inbox.length > 0) {
      const m = inbox.shift()
      const inputs = m.type === "frames" ? m.speech.map((s: number) => ({ _tag: "Frame", speech: s === 1 }))
        : m.type === "partial" ? [{ _tag: "Partial", text: m.text }]
        : m.type === "segment" ? [{ _tag: "Segment", text: m.text }]
        : m.type === "cancelled" ? [{ _tag: "SegmentCancelled" }]
        : m.type === "flushed" ? [{ _tag: "End" }]
        : []
      for (const input of inputs) {
        for (const out of detector.step(input)) {
          if (out._tag === "Finalize") core.onMessage({ type: "finalize", session: 1, frame: out.frame, ...(out.through ? { through: true } : {}) })
          else if (out._tag === "Commit") core.onMessage({ type: "commit", session: 1, frame: out.frame })
          else if (out._tag === "EndOfTurn" && out.text) turns.push(out.text)
        }
      }
    }
  }
  core.onMessage({ type: "reset", session: 1 })
  const all = new Int16Array(pcm.length + RATE * 2) // 2 s of silence after the clip
  all.set(pcm)
  for (let o = 0; o < all.length; o += 320) {
    core.onMessage({ type: "audio", session: 1, buffer: all.slice(o, o + 320).buffer })
    deliver()
  }
  core.onMessage({ type: "flush", session: 1 })
  deliver()
  const st = core.inspect().stats as any
  return { text: turns.join(" "), turns: turns.length, checkpoints, unmatched: st.unmatchedJoins as number, overlapS: st.overlapFrames / 50 }
}

const OFF = { checkpointMs: 1e9, hardCheckpointMs: 1e9, keepMs: 1e9 }
/** The checkpoints of the third review: at a 200 ms pause after 5 s, at 8 s regardless. */
const HARD_8S = { checkpointMs: 5_000, pauseMs: 200, hardCheckpointMs: 8_000, overlapMs: 0 }
const configs: Array<[string, Record<string, number> | undefined]> = [["hard 8 s (third review)", HARD_8S], [limits ? "given" : "now (overlap)", limits], ["off (whole segment)", OFF]]
const streaming = (Object.keys(presets) as Array<PresetName>).filter((n) => (presets[n] as any).kind === "streaming")
for (const preset of wanted.length > 0 ? wanted : streaming) {
  const missing = missingFile(modelFiles(presets[preset], defaultModelDir))
  if (missing) {
    console.log(`${preset}: skipped (${missing} missing)`)
    continue
  }
  const totals = configs.map(() => ({ errors: 0, words: 0, joins: 0, unmatched: 0, overlapS: 0, audioS: 0 }))
  console.log(`\n=== ${preset} (${condition}) ===`)
  for (const clip of clips) {
    const results = configs.map(([, l]) => run(preset, clip.pcm, l))
    const rates = results.map((r, i) => {
      const e = wordErrors(clip.ref, r.text)
      totals[i]!.errors += e.errors
      totals[i]!.words += e.words
      totals[i]!.joins += r.checkpoints.length
      totals[i]!.unmatched += r.unmatched
      totals[i]!.overlapS += r.overlapS
      totals[i]!.audioS += clip.pcm.length / RATE
      return `${configs[i]![0]} ${(100 * e.errors / e.words).toFixed(1)} % (${r.checkpoints.length} cp)`
    })
    console.log(`${clip.name}: ${rates.join(", ")}`)
    for (const [i, r] of results.entries()) {
      if (r.checkpoints.length === 0) continue
      // Each join: the last words of the checkpointed piece | the words after it.
      let pos = 0
      const hyp = normalize(r.text).split(" ")
      const joins: Array<string> = []
      for (const piece of r.checkpoints) {
        const words = normalize(piece).split(" ").filter(Boolean)
        if (words.length === 0) continue
        const start = hyp.indexOf(words[0]!, pos)
        const end = start < 0 ? pos + words.length : start + words.length
        joins.push(`…${hyp.slice(Math.max(0, end - 3), end).join(" ")} | ${hyp.slice(end, end + 3).join(" ")}…`)
        pos = end
      }
      console.log(`   ${configs[i]![0]} joins: ${joins.join("  ")}`)
    }
    if (new Set(results.map((r) => normalize(r.text))).size > 1) {
      for (const [i, r] of results.entries()) console.log(`   ${configs[i]![0].padEnd(24)}: ${normalize(r.text)}`)
      console.log(`   ${"reference".padEnd(24)}: ${normalize(clip.ref)}`)
    }
  }
  console.log(`${preset} total (${totals[0]!.words} words): ` + totals.map((t, i) => `${configs[i]![0]} ${(100 * t.errors / t.words).toFixed(2)} % (${t.joins} joins, ${t.unmatched} unmatched, ${t.overlapS.toFixed(1)} s decoded twice of ${t.audioS.toFixed(0)} s)`).join(", "))
}
