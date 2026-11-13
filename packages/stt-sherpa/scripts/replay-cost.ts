/**
 * Streaming boundary cuts with the real models: how long a cut blocks the worker thread, and how long the next
 * turn's first frames wait behind it. Runs src/recognizerCore.mjs (the worker's logic) on this thread with the
 * real recognisers and VAD. `tsx scripts/replay-cost.ts [preset...]` (default: every installed streaming preset).
 *
 * Input: the test WAVs concatenated (with 150 ms gaps, under the 250 ms eager silence) into one ~45 s segment,
 * then 700 ms of silence (the turn boundary), then 1 s of the next sentence already processed, then the cut.
 */
import { createRequire } from "node:module"
import { join } from "node:path"
import { makeRecognizerCore } from "../src/recognizerCore.mjs"
import { defaultModelDir, missingFile, modelFiles, type PresetName, presets } from "../src/presets.ts"
import { readWav, wavDir } from "../test/fixtures.ts"

const sherpa = createRequire(import.meta.url)("sherpa-onnx-node")
const RATE = 16_000

const speech = (() => {
  const parts: Array<Int16Array> = []
  for (const name of ["0.wav", "1.wav"]) {
    const pcm = readWav(join(wavDir, name))
    parts.push(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2))
  }
  return parts
})()
const silence = (ms: number) => new Int16Array((ms / 1000) * RATE)
const concat = (parts: ReadonlyArray<Int16Array>) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const segment = (seconds: number) => {
  const parts: Array<Int16Array> = []
  let n = 0
  for (let i = 0; n < seconds * RATE; i++) {
    const s = speech[i % speech.length]!
    parts.push(s, silence(150))
    n += s.length + 2400
  }
  return concat(parts)
}

const run = (preset: PresetName, limits: Record<string, number> | undefined, seconds: number, aheadS = 1) => {
  const p = presets[preset] as any
  const files = modelFiles(p, defaultModelDir)
  const online = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: p.model.featureDim },
    modelConfig: { transducer: { encoder: files.streaming!.encoder, decoder: files.streaming!.decoder, joiner: files.streaming!.joiner }, tokens: files.streaming!.tokens, numThreads: p.threads, provider: "cpu", debug: 0 },
    decodingMethod: "greedy_search",
    enableEndpoint: 0
  })
  const vad = new sherpa.Vad({ sileroVad: { model: files.vad, threshold: 0.5, minSpeechDuration: 0.01, minSilenceDuration: 0.01, windowSize: 512 }, sampleRate: RATE, numThreads: 1, debug: false }, 60)
  const posted: Array<{ at: number; m: any }> = []
  const core = makeRecognizerCore({
    config: { kind: "streaming", prerollMs: 400, agc: false, streaming: { tailPaddingMs: p.model.tailPaddingMs, language: p.model.multilingual ? "en" : undefined } },
    online,
    vad,
    post: (m) => posted.push({ at: performance.now(), m }),
    ...(limits ? { segmentLimits: limits } : {})
  })
  core.onMessage({ type: "reset", session: 1 })
  const send = (pcm: Int16Array) => {
    for (let o = 0; o < pcm.length; o += 320 * 10) {
      const chunk = pcm.slice(o, o + 320 * 10)
      core.onMessage({ type: "audio", session: 1, buffer: chunk.buffer })
    }
  }
  send(segment(seconds))
  send(silence(700))
  const frames = () => posted.filter((x) => x.m.type === "frames").reduce((n, x) => n + x.m.speech.length, 0)
  const boundary = frames()
  send(segment(aheadS).slice(0, aheadS * RATE)) // the next sentence, processed before the finalise arrives
  const t0 = performance.now()
  core.onMessage({ type: "finalize", session: 1, frame: boundary, through: true })
  const blocked = performance.now() - t0
  // The next turn's audio waiting in the worker's queue behind the cut: when are its first frames reported?
  const before = posted.length
  core.onMessage({ type: "audio", session: 1, buffer: silence(20).buffer })
  const nextFrames = posted.slice(before).find((x) => x.m.type === "frames")!.at - t0
  const st = core.inspect().stats
  return { blocked, nextFrames, replayedS: st.replayedFrames / 50, refedS: st.refedFrames / 50, cutMs: st.cutMs, checkpoints: st.checkpoints }
}

const wanted = (process.argv.slice(2) as Array<PresetName>)
const streaming = (Object.keys(presets) as Array<PresetName>).filter((n) => (presets[n] as any).kind === "streaming")
for (const preset of wanted.length > 0 ? wanted : streaming) {
  const missing = missingFile(modelFiles(presets[preset], defaultModelDir))
  if (missing) {
    console.log(`${preset}: skipped (${missing} missing)`)
    continue
  }
  // Before: the whole retained segment (up to 30 s) replayed. Simulated with checkpoints off and 30 s kept.
  const before = run(preset, { checkpointMs: 1e9, hardCheckpointMs: 1e9, keepMs: 30_000 }, 28)
  const after = run(preset, undefined, 45)
  // Worst case now: no pause long enough for a checkpoint, so the open piece nears the 8 s hard limit; the
  // boundary falls at its end.
  const worst = run(preset, { pauseMs: 1e9 }, 6.6)
  // The next turn already 3 s along when the finalise arrives (a burst; past the 1 s backlog bound of the main thread).
  const late = (() => { const r = run(preset, { pauseMs: 1e9 }, 6.6, 3); return r })()
  const f = (r: ReturnType<typeof run>) =>
    `blocked ${r.blocked.toFixed(0)} ms (all of the cut, refeeding included: ${r.cutMs.toFixed(0)} ms), next frames after ${r.nextFrames.toFixed(0)} ms, replayed ${r.replayedS.toFixed(1)} s + fed again ${r.refedS.toFixed(1)} s, checkpoints ${r.checkpoints}`
  console.log(`${preset}\n  before (whole segment kept, 28 s): ${f(before)}\n  now (checkpoints, 45 s segment):    ${f(after)}\n  now, worst case (no pause):         ${f(worst)}\n  same, next turn 3 s along:          ${f(late)}`)
}
