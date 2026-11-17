// Recogniser + VAD host, run in a worker thread: sherpa-onnx decode calls are
// synchronous (~55 ms per chunk for Nemotron) or long (a whole-turn decode is
// 0.1–3 s), and would stall the main event loop.
//
// Plain JavaScript on purpose: worker threads do not inherit the TypeScript
// loaders of tsx or vitest, and this Node build has no type stripping.
//
// This file only loads the models; everything else is recognizerCore.mjs, which the
// test stand-ins in test/ run too, with fake models.
//
// Per 20 ms frame: s16 → f32, optional AGC (agc.mjs), Silero VAD, then the
// recogniser side of the preset's kind:
// - streaming: an online stream fed from the VAD onset (with pre-roll) until the
//   segment is finalised; a fresh stream per segment.
// - offline: the turn's audio is collected (turnAudio.mjs); every `finalize`
//   decodes all of it from the turn's start, off this thread (`decodeAsync`), so
//   VAD decisions keep flowing during the decode. The answer is cumulative: it
//   replaces the turn's text instead of being appended to it.
// - hybrid: offline as above, plus an online stream per turn for live words only.
//
// Sessions: several voice sessions can be open at once (docs/VOICE-SESSIONS.md §3), also of several hearers with
// different microphone settings (docs/ASSISTANTS.md §3.2). The model is loaded once and shared; each session has
// its own VAD with its own threshold (the one loaded below serves the first with the default threshold; more are
// created only when more sessions are open at once), AGC with its own options, pre-roll and turn state. Whole-turn
// decodes of every session go through one queue.
//
// Protocol (every message carries the session id; the main thread ignores stale ones):
//   in : { type: "open", session, options? }         a new session with fresh state (others keep running);
//                                                    `options` (per stream, docs/ASSISTANTS.md §3.2): { vadThreshold,
//                                                    agc: false | AgcOptions, prerollMs }; absent = the worker's
//                                                    configuration
//        { type: "end", session }                   the session is over: its state and queued decodes are dropped
//        { type: "reset", session }                 one session only: end every open session, open this one
//        { type: "audio", session, buffer }          s16le mono 16 kHz, any length (transferred)
//        { type: "finalize", session, frame, through? }
//                                                    finalise unless speech came after `frame`; with `through`,
//                                                    finalise regardless (offline: the turn's audio up to `frame`;
//                                                    streaming: the segment cut at `frame`, decoded again, and the
//                                                    frames after it start the next segment)
//        { type: "commit", session, frame }          the turn ended at `frame` (offline: drop its audio)
//        { type: "flush", session }                  answered with `flushed` once every earlier message is handled
//        { type: "close" }                           take no more work; answered with `closed` once no native
//                                                    decode is running (terminating the thread during one aborts
//                                                    the whole process)
//   out: { type: "ready", loadMs }
//        { type: "frames", session, speech }         one 0/1 VAD decision per 20 ms frame processed
//        { type: "partial", session, text }          live transcript changed (streaming: of the open
//                                                    segment; hybrid: of the whole turn)
//        { type: "segment", session, text, ms, cumulative, audioMs, gainDb }
//                                                    final text (streaming: of the segment; offline:
//                                                    of the whole turn so far)
//        { type: "cancelled", session }
//        { type: "flushed", session }                every frame of the audio sent before the flush was reported
//        { type: "closed" }                          the thread may be terminated now
//        { type: "error", session, message }
//        { type: "overload", session, message }       whole-turn: decoding is so far behind (a decode that does not
//                                                    return) that the turn's audio could not be queued: it was dropped
//        { type: "warning", session, message }       a boundary could not be honoured exactly (see recognizerCore.mjs)
import v8 from "node:v8"
import vm from "node:vm"
import { parentPort, workerData } from "node:worker_threads"
import sherpa from "sherpa-onnx-node"
import { makeAgc } from "./agc.mjs"
import { makeRecognizerCore, RATE } from "./recognizerCore.mjs"

const config = workerData
const t0 = performance.now()
const post = (message) => parentPort.postMessage(message)

// A recogniser stream's native memory (hundreds of KB to MB) is freed only when its JS wrapper is collected,
// and this thread allocates so little JS that V8 rarely collects: with a stream per segment or per decode,
// RSS climbed by 270–530 MB before levelling off (stt-quality.md §1.3). So collect once per turn, here, off
// the main thread (a few ms on this small heap).
const collect = (() => {
  if (config.collectGarbage === false) return () => {}
  try {
    v8.setFlagsFromString("--expose-gc")
    const gc = vm.runInNewContext("gc")
    return typeof gc === "function" ? () => gc() : () => {}
  } catch {
    return () => {}
  }
})()

// ---- Models ----

const onlineRecognizer = (streaming) =>
  new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: streaming.featureDim },
    modelConfig: {
      transducer: { encoder: streaming.files.encoder, decoder: streaming.files.decoder, joiner: streaming.files.joiner },
      tokens: streaming.files.tokens,
      numThreads: streaming.threads,
      provider: "cpu",
      debug: 0
    },
    decodingMethod: "greedy_search",
    enableEndpoint: 0 // turns are detected from the VAD; the recogniser's endpointing is much slower
  })

const offlineRecognizer = (offline) => {
  const f = offline.files
  const modelConfig = f.type === "whisper"
    ? {
      whisper: { encoder: f.encoder, decoder: f.decoder, language: offline.language ?? "", task: "transcribe", tailPaddings: -1 },
      tokens: f.tokens
    }
    : {
      transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner },
      tokens: f.tokens,
      modelType: "nemo_transducer"
    }
  return new sherpa.OfflineRecognizer({
    // The feature dimension of these models is read from their metadata.
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: { ...modelConfig, numThreads: offline.threads, provider: "cpu", debug: 0 },
    decodingMethod: "greedy_search"
  })
}

const online = config.streaming ? onlineRecognizer(config.streaming) : undefined
const offline = config.offline ? offlineRecognizer(config.offline) : undefined

const makeVad = (threshold = config.vad.threshold) => new sherpa.Vad({
  sileroVad: {
    model: config.vad.file,
    threshold,
    // Near-raw decisions; all timing (minimum speech, silence thresholds) lives in the TurnDetector.
    minSpeechDuration: 0.01,
    minSilenceDuration: 0.01,
    windowSize: 512
  },
  sampleRate: RATE,
  numThreads: 1,
  debug: false
}, 60)
// The first session's VAD, loaded with the model; later concurrent sessions get their own (`makeVad`).
const vad = makeVad()

// Warm up: the first decodes are much slower than the rest.
if (online) {
  const s = online.createStream()
  s.acceptWaveform({ sampleRate: RATE, samples: new Float32Array(RATE) })
  s.inputFinished()
  while (online.isReady(s)) online.decode(s)
}
if (offline) {
  for (let i = 0; i < 2; i++) {
    const s = offline.createStream()
    s.acceptWaveform({ sampleRate: RATE, samples: new Float32Array(RATE) })
    offline.decode(s)
  }
}

const core = makeRecognizerCore({
  config,
  online,
  offline,
  vad,
  makeVad,
  // Per session: a session may ask for gain control (with its own options) even when the worker's default has none.
  makeAgc: (options) => makeAgc(options),
  post,
  collect
})
parentPort.on("message", (message) => core.onMessage(message))

post({ type: "ready", loadMs: performance.now() - t0 })
