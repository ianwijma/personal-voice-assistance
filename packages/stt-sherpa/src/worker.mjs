// Recogniser + VAD host, run in a worker thread: sherpa-onnx decode calls are
// synchronous (~55 ms per chunk for Nemotron) or long (a whole-turn decode is
// 0.1–3 s), and would stall the main event loop.
//
// Plain JavaScript on purpose: worker threads do not inherit the TypeScript
// loaders of tsx or vitest, and this Node build has no type stripping.
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
// Protocol (every message carries the session id; the main thread ignores stale ones):
//   in : { type: "reset", session }                 new session: clear all state
//        { type: "audio", session, buffer }          s16le mono 16 kHz, any length (transferred)
//        { type: "finalize", session, frame }        finalise unless speech came after `frame`
//        { type: "commit", session, frame }          the turn ended at `frame` (offline: drop its audio)
//   out: { type: "ready", loadMs }
//        { type: "frames", session, speech }         one 0/1 VAD decision per 20 ms frame processed
//        { type: "partial", session, text }          live transcript changed (streaming: of the open
//                                                    segment; hybrid: of the whole turn)
//        { type: "segment", session, text, ms, cumulative, audioMs, gainDb }
//                                                    final text (streaming: of the segment; offline:
//                                                    of the whole turn so far)
//        { type: "cancelled", session }
//        { type: "error", session, message }
import v8 from "node:v8"
import vm from "node:vm"
import { parentPort, workerData } from "node:worker_threads"
import sherpa from "sherpa-onnx-node"
import { makeAgc } from "./agc.mjs"
import { TurnAudio } from "./turnAudio.mjs"

const RATE = 16000
const FRAME = 320 // 20 ms
const FRAME_MS = 20

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
const language = config.streaming?.language

const newOnlineStream = () => {
  const s = online.createStream()
  if (language && config.kind === "streaming") s.setOption("language", language)
  if (config.kind === "hybrid") s.setOption("language", "en")
  return s
}

const decodeReady = (stream) => {
  while (online.isReady(stream)) online.decode(stream)
}

const vad = new sherpa.Vad({
  sileroVad: {
    model: config.vad.file,
    threshold: config.vad.threshold,
    // Near-raw decisions; all timing (minimum speech, silence thresholds) lives in the TurnDetector.
    minSpeechDuration: 0.01,
    minSilenceDuration: 0.01,
    windowSize: 512
  },
  sampleRate: RATE,
  numThreads: 1,
  debug: false
}, 60)

const agc = config.agc ? makeAgc(config.agc) : undefined

// Warm up: the first decodes are much slower than the rest.
if (online) {
  const s = newOnlineStream()
  s.acceptWaveform({ sampleRate: RATE, samples: new Float32Array(RATE) })
  s.inputFinished()
  decodeReady(s)
}
if (offline) {
  for (let i = 0; i < 2; i++) {
    const s = offline.createStream()
    s.acceptWaveform({ sampleRate: RATE, samples: new Float32Array(RATE) })
    offline.decode(s)
  }
}

// ---- Session state ----

let session = 0
let frameIndex = 0
let lastSpeechFrame = -1
const frame = new Float32Array(FRAME)
let fill = 0
let carry = -1 // low byte of a sample split across two chunks
// Recent frames (after the AGC), fed to the recogniser when speech starts (covers the VAD's onset lag).
const prerollFrames = Math.max(1, Math.round(config.prerollMs / FRAME_MS))
const ring = Array.from({ length: prerollFrames }, () => ({ frame: new Float32Array(FRAME), index: -1, speech: false }))
let ringPos = 0
let ringCount = 0
let speechFlags = []

/** The pre-roll ring, oldest first (ends with the current frame). */
const preroll = () => {
  const out = []
  for (let k = ringCount; k > 0; k--) out.push(ring[(ringPos - k + ring.length) % ring.length])
  return out
}

const flushFrames = () => {
  if (speechFlags.length === 0) return
  post({ type: "frames", session, speech: speechFlags })
  speechFlags = []
}

// ---- Streaming kind: one segment at a time, fresh stream per segment ----

const streamingPadding = config.streaming ? new Float32Array(Math.round(config.streaming.tailPaddingMs * RATE / 1000)) : undefined
let segStream = null
let feeding = false
let partial = ""

const feedSegment = (samples) => {
  segStream ??= newOnlineStream()
  segStream.acceptWaveform({ sampleRate: RATE, samples })
  if (!online.isReady(segStream)) return
  decodeReady(segStream)
  const text = online.getResult(segStream).text
  if (text !== partial) {
    partial = text
    flushFrames() // keep partials in order with the frames they came from
    post({ type: "partial", session, text })
  }
}

const streamingFrame = (speech) => {
  if (feeding) {
    feedSegment(frame)
  } else if (speech) {
    feeding = true
    for (const p of preroll()) feedSegment(p.frame)
  }
}

const streamingFinalize = () => {
  const start = performance.now()
  let text = ""
  if (feeding) {
    segStream.acceptWaveform({ sampleRate: RATE, samples: streamingPadding })
    segStream.inputFinished()
    decodeReady(segStream)
    text = online.getResult(segStream).text
    // A fresh stream per segment: `reset()` loses accuracy in sherpa-onnx 2.0.1 (stt-quality.md §1.3), and
    // nothing of this segment can leak into the next one.
    segStream = null
    feeding = false
    partial = ""
  }
  post({ type: "segment", session, text, ms: performance.now() - start, cumulative: false })
  collect()
}

// ---- Offline kind: whole-turn decoding ----

const turn = config.offline
  ? new TurnAudio({ frameSamples: FRAME, maxFrames: Math.round(config.offline.maxTurnMs / FRAME_MS), prerollFrames })
  : undefined
/** Texts of the pieces of an over-long turn decoded so far. */
let prefix = []
/** Bumped when a turn ends or the session resets: results of older decodes are dropped. */
let generation = 0
let chain = Promise.resolve()
/** Decodes queued or running. */
let pending = 0
const enqueue = (task) => {
  const forSession = session
  pending++
  chain = chain.then(task).catch((error) => post({ type: "error", session: forSession, message: String(error?.stack ?? error) }))
    .finally(() => pending--)
}

// Interim text for whole-turn models (no streaming model): while the user is speaking, the turn so far is
// decoded again every `interimMs` of new audio, so live words appear and the "say a few words" barge-in
// (which needs words) works. Bounded so it rarely delays the end-of-turn decode: only while the VAD says
// speech right now (the eager point is then >= 260 ms away), only when no other decode is queued, and only
// for the first `interimMaxMs` of a turn (a decode of 10 s of audio takes about 0.25 s with Parakeet).
const interimFrames = config.offline?.interimMs > 0 && !config.streaming ? Math.round(config.offline.interimMs / FRAME_MS) : 0
const interimMaxFrames = Math.round((config.offline?.interimMaxMs ?? 10_000) / FRAME_MS)
let interimAt = 0
let interimText = ""

const decodeOffline = async (samples) => {
  const s = offline.createStream()
  s.acceptWaveform({ sampleRate: RATE, samples })
  await offline.decodeAsync(s)
  return offline.getResult(s).text.trim()
}

// Hybrid: live words of the whole turn from an online stream per turn.
let live = null
let liveText = ""
let liveMuted = false

const feedLive = (samples) => {
  live ??= newOnlineStream()
  live.acceptWaveform({ sampleRate: RATE, samples })
  if (!online.isReady(live)) return
  decodeReady(live)
  const text = online.getResult(live).text.trim()
  if (text !== liveText) {
    liveText = text
    if (liveMuted) return
    flushFrames()
    post({ type: "partial", session, text })
  }
}

const dropLive = () => {
  live = null
  liveText = ""
  liveMuted = false
}

const offlineFrame = (speech) => {
  const wasCollecting = turn.collecting
  const piece = turn.push(frame, frameIndex, speech, preroll)
  if (piece) {
    const gen = generation
    enqueue(async () => {
      const text = await decodeOffline(piece)
      if (gen === generation && text) prefix.push(text)
    })
  }
  if (interimFrames > 0 && speech && turn.collecting && pending === 0 && prefix.length === 0 &&
    turn.length - interimAt >= interimFrames && turn.length <= interimMaxFrames) {
    interimAt = turn.length
    const gen = generation
    const forSession = session
    const audio = turn.audio()
    enqueue(async () => {
      const text = await decodeOffline(audio)
      if (gen !== generation || forSession !== session || !text || text === interimText) return
      interimText = text
      flushFrames() // in order with the frames it came from
      post({ type: "partial", session: forSession, text })
    })
  }
  if (online && turn.collecting) {
    if (speech) liveMuted = false
    if (!wasCollecting) for (const p of preroll()) feedLive(p.frame)
    else feedLive(frame)
  }
  // Safety net: a turn that is never committed (a lost message) does not grow for ever.
  if (turn.collecting && frameIndex - lastSpeechFrame > 15_000 / FRAME_MS) {
    turn.clear()
    prefix = []
    generation++
    dropLive()
  }
}

const offlineFinalize = () => {
  const gen = generation
  const forSession = session
  const audio = turn.audio()
  const requested = performance.now()
  if (online) liveMuted = true // the live text may still catch up with the last words: not a resumption
  const gainDb = agc?.gainDb()
  enqueue(async () => {
    const started = performance.now()
    const text = audio.length > 0 ? await decodeOffline(audio) : ""
    if (forSession !== session) return
    // The detector waits for this answer, so it always gets one; a turn dropped meanwhile has no text.
    const full = gen === generation ? [...prefix, text].filter(Boolean).join(" ") : ""
    post({
      type: "segment",
      session: forSession,
      text: full,
      cumulative: true,
      ms: performance.now() - requested,
      decodeMs: performance.now() - started,
      audioMs: (audio.length / RATE) * 1000,
      ...(gainDb !== undefined ? { gainDb } : {})
    })
  })
}

const offlineCommit = (atFrame) => {
  generation++
  prefix = []
  interimAt = 0
  interimText = ""
  turn.commit(atFrame)
  if (online) {
    dropLive()
    if (turn.collecting) feedLive(turn.audio()) // a new turn already started
  }
}

// ---- Frames ----

const processFrame = () => {
  agc?.process(frame)
  vad.acceptWaveform(frame)
  const speech = vad.isDetected()
  while (!vad.isEmpty()) vad.pop() // only the detection flag is used; drop buffered segments
  frameIndex++
  if (speech) lastSpeechFrame = frameIndex
  speechFlags.push(speech ? 1 : 0)
  const slot = ring[ringPos]
  slot.frame.set(frame)
  slot.index = frameIndex
  slot.speech = speech
  ringPos = (ringPos + 1) % ring.length
  ringCount = Math.min(ringCount + 1, ring.length)
  if (turn) offlineFrame(speech)
  else streamingFrame(speech)
}

const pushSample = (lo, hi) => {
  frame[fill++] = (((hi << 8) | lo) << 16 >> 16) / 32768
  if (fill === FRAME) {
    fill = 0
    processFrame()
  }
}

const onAudio = (buffer) => {
  const bytes = new Uint8Array(buffer)
  let i = 0
  if (carry >= 0 && bytes.length > 0) {
    pushSample(carry, bytes[0])
    carry = -1
    i = 1
  }
  for (; i + 1 < bytes.length; i += 2) pushSample(bytes[i], bytes[i + 1])
  if (i < bytes.length) carry = bytes[i]
  flushFrames()
}

const onFinalize = (atFrame) => {
  if (lastSpeechFrame > atFrame) return post({ type: "cancelled", session })
  if (turn) offlineFinalize()
  else streamingFinalize()
}

const onCommit = (atFrame) => {
  if (turn) offlineCommit(atFrame)
  collect()
}

const onReset = (id) => {
  session = id
  vad.reset()
  agc?.reset()
  frameIndex = 0
  lastSpeechFrame = -1
  fill = 0
  carry = -1
  ringPos = 0
  ringCount = 0
  speechFlags = []
  segStream = null
  feeding = false
  partial = ""
  turn?.clear()
  prefix = []
  generation++
  interimAt = 0
  interimText = ""
  dropLive()
}

parentPort.on("message", (message) => {
  try {
    if (message.type === "reset") return onReset(message.session)
    if (message.session !== session) return
    if (message.type === "audio") onAudio(message.buffer)
    else if (message.type === "finalize") onFinalize(message.frame)
    else if (message.type === "commit") onCommit(message.frame)
  } catch (error) {
    post({ type: "error", session, message: String(error?.stack ?? error) })
  }
})

post({ type: "ready", loadMs: performance.now() - t0 })
