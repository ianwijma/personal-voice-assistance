// Recogniser + VAD host, run in a worker thread: sherpa-onnx decode calls are
// synchronous (~55 ms each for Nemotron) and would stall the main event loop.
//
// Plain JavaScript on purpose: worker threads do not inherit the TypeScript
// loaders of tsx or vitest, and this Node build has no type stripping.
//
// Protocol (every message carries the session id; the main thread ignores stale ones):
//   in : { type: "reset", session }                 new session: clear all state
//        { type: "audio", session, buffer }          s16le mono 16 kHz, any length (transferred)
//        { type: "finalize", session, frame }        finalise the open segment unless speech came after `frame`
//   out: { type: "ready", loadMs }
//        { type: "frames", session, speech }         one 0/1 VAD decision per 20 ms frame processed
//        { type: "partial", session, text }          partial transcript of the open segment changed
//        { type: "segment", session, text, ms }      final text of the segment; stream reset
//        { type: "cancelled", session }
//        { type: "error", session, message }
import { parentPort, workerData } from "node:worker_threads"
import sherpa from "sherpa-onnx-node"

const RATE = 16000
const FRAME = 320 // 20 ms

const config = workerData
const t0 = performance.now()
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: RATE, featureDim: config.featureDim },
  modelConfig: {
    transducer: { encoder: config.files.encoder, decoder: config.files.decoder, joiner: config.files.joiner },
    tokens: config.files.tokens,
    numThreads: config.threads,
    provider: "cpu",
    debug: 0
  },
  decodingMethod: "greedy_search",
  enableEndpoint: 0 // turns are detected from the VAD; the recogniser's endpointing is much slower
})
// One stream for the worker's lifetime, reset between segments: creating a
// stream per utterance leaks memory in sherpa-onnx-node 2.0.1.
const stream = recognizer.createStream()
if (config.language) stream.setOption("language", config.language)
const vad = new sherpa.Vad({
  sileroVad: {
    model: config.files.vad,
    threshold: config.vadThreshold,
    // Near-raw decisions; all timing (minimum speech, silence thresholds) lives in the TurnDetector.
    minSpeechDuration: 0.01,
    minSilenceDuration: 0.01,
    windowSize: 512
  },
  sampleRate: RATE,
  numThreads: 1,
  debug: false
}, 60)
const padding = new Float32Array(Math.round(config.tailPaddingMs * RATE / 1000))

const decodeAll = () => {
  while (recognizer.isReady(stream)) recognizer.decode(stream)
}

// Warm up: the first decodes are much slower than the rest.
stream.acceptWaveform({ sampleRate: RATE, samples: new Float32Array(RATE) })
stream.inputFinished()
decodeAll()
recognizer.reset(stream)

// Session state
let session = 0
let frameIndex = 0
let lastSpeechFrame = -1
let feeding = false
let partial = ""
const frame = new Float32Array(FRAME)
let fill = 0
let carry = -1 // low byte of a sample split across two chunks
// Recent frames, fed to the recogniser when speech starts (covers the VAD's onset lag).
const ring = Array.from({ length: Math.max(1, Math.round(config.prerollMs / 20)) }, () => new Float32Array(FRAME))
let ringPos = 0
let ringCount = 0
let speechFlags = []

const post = (message) => parentPort.postMessage(message)

const flushFrames = () => {
  if (speechFlags.length === 0) return
  post({ type: "frames", session, speech: speechFlags })
  speechFlags = []
}

const feed = (samples) => {
  stream.acceptWaveform({ sampleRate: RATE, samples })
  if (!recognizer.isReady(stream)) return
  decodeAll()
  const text = recognizer.getResult(stream).text
  if (text !== partial) {
    partial = text
    flushFrames() // keep partials in order with the frames they came from
    post({ type: "partial", session, text })
  }
}

const processFrame = () => {
  vad.acceptWaveform(frame)
  const speech = vad.isDetected()
  while (!vad.isEmpty()) vad.pop() // only the detection flag is used; drop buffered segments
  frameIndex++
  if (speech) lastSpeechFrame = frameIndex
  speechFlags.push(speech ? 1 : 0)
  ring[ringPos].set(frame)
  ringPos = (ringPos + 1) % ring.length
  ringCount = Math.min(ringCount + 1, ring.length)
  if (feeding) {
    feed(frame)
  } else if (speech) {
    feeding = true
    for (let k = ringCount; k > 0; k--) feed(ring[(ringPos - k + ring.length) % ring.length])
  }
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
  const start = performance.now()
  let text = ""
  if (feeding) {
    stream.acceptWaveform({ sampleRate: RATE, samples: padding })
    stream.inputFinished()
    decodeAll()
    text = recognizer.getResult(stream).text
    recognizer.reset(stream)
    feeding = false
    partial = ""
  }
  post({ type: "segment", session, text, ms: performance.now() - start })
}

const onReset = (id) => {
  session = id
  recognizer.reset(stream)
  vad.reset()
  frameIndex = 0
  lastSpeechFrame = -1
  feeding = false
  partial = ""
  fill = 0
  carry = -1
  ringPos = 0
  ringCount = 0
  speechFlags = []
}

parentPort.on("message", (message) => {
  try {
    if (message.type === "reset") return onReset(message.session)
    if (message.session !== session) return
    if (message.type === "audio") onAudio(message.buffer)
    else if (message.type === "finalize") onFinalize(message.frame)
  } catch (error) {
    post({ type: "error", session, message: String(error?.stack ?? error) })
  }
})

post({ type: "ready", loadMs: performance.now() - t0 })
