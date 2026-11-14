// Stand-in for src/worker.mjs in the whole-turn kind: the production logic (src/recognizerCore.mjs: turn audio,
// the bounded decode queue) with the fake models of fakeModels.mjs. Every message is handled in order on a chain
// (`workerData.frameDelayMs` per frame), like a busy real worker. A decode takes `workerData.decodeMs` and answers
// `workerData.text`. `close` waits `workerData.closeDelayMs` first (a native decode settling).
// `workerData.exitOnAudio`: the thread dies (a native crash) on the first audio; `workerData.exitOnAudioOf`: on the
// first audio of that session id. `workerData.wordsOfAudio`: decodes answer the words of the audio (fakeModels.mjs)
// instead of `text`, so concurrent sessions can tell their turns apart.
// `workerData.stallMs`: decodes hang (a stalled native decode) for that long after the first audio, then return;
// `workerData.maxQueuedDecodeMs` sets the core's bound on queued decode audio.
import { parentPort, workerData } from "node:worker_threads"
import { makeRecognizerCore } from "../src/recognizerCore.mjs"
import { fakeOffline, fakeVad } from "./fakeModels.mjs"

const frameDelayMs = workerData.frameDelayMs ?? 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const config = { ...workerData, agc: false, offline: { ...workerData.offline, interimMs: workerData.interimMs ?? 0 } }
const hang = { on: workerData.stallMs !== undefined }
const core = makeRecognizerCore({
  config,
  offline: fakeOffline({ ...(workerData.wordsOfAudio ? {} : { text: workerData.text ?? "hello" }), decodeMs: workerData.decodeMs ?? 0, hang }),
  vad: fakeVad(),
  makeVad: fakeVad,
  post: (m) => parentPort.postMessage(m),
  ...(workerData.maxQueuedDecodeMs !== undefined ? { maxQueuedDecodeMs: workerData.maxQueuedDecodeMs } : {})
})
let stallStarted = false
let chain = Promise.resolve()
parentPort.on("message", (m) => {
  if (m.type === "audio" && workerData.exitOnAudio) process.exit(3)
  if (m.type === "audio" && workerData.exitOnAudioOf === m.session) process.exit(3)
  if (m.type === "audio" && hang.on && !stallStarted) {
    stallStarted = true
    setTimeout(() => {
      hang.on = false
      hang.release()
    }, workerData.stallMs)
  }
  chain = chain.then(async () => {
    if (m.type === "audio" && frameDelayMs > 0) await sleep(frameDelayMs * Math.floor(m.buffer.byteLength / 640))
    if (m.type === "close" && workerData.closeDelayMs) await sleep(workerData.closeDelayMs)
    core.onMessage(m)
  })
})
parentPort.postMessage({ type: "ready", loadMs: 0 })
