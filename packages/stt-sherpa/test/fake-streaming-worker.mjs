// Stand-in for src/worker.mjs in the streaming kind: the production logic (src/recognizerCore.mjs: segments,
// checkpoints, boundary cuts) with the fake models of fakeModels.mjs, so SherpaStt's main-thread logic and the
// worker's boundary logic are tested together without a model.
// Messages are handled in order on a chain (`workerData.frameDelayMs` per frame of audio, `workerData.decodeMs`
// before each finalisation), like a busy real worker. `workerData.partials` (default true) passes partials on.
// `workerData.segmentLimits` overrides the core's retention limits (to reach them with short test audio).
import { parentPort, workerData } from "node:worker_threads"
import { makeRecognizerCore } from "../src/recognizerCore.mjs"
import { fakeOnline, fakeVad } from "./fakeModels.mjs"

const frameDelayMs = workerData.frameDelayMs ?? 0
const decodeMs = workerData.decodeMs ?? 0
const partials = workerData.partials !== false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const post = (m) => {
  if (m.type === "partial" && !partials) return
  parentPort.postMessage(m)
}
const core = makeRecognizerCore({
  config: { ...workerData, agc: false },
  online: fakeOnline(),
  vad: fakeVad(),
  makeVad: fakeVad,
  post,
  ...(workerData.segmentLimits ? { segmentLimits: workerData.segmentLimits } : {})
})
let chain = Promise.resolve()
parentPort.on("message", (m) => {
  chain = chain.then(async () => {
    if (m.type === "audio" && frameDelayMs > 0) await sleep(frameDelayMs * Math.floor(m.buffer.byteLength / 640))
    if (m.type === "finalize" && decodeMs > 0) await sleep(decodeMs)
    core.onMessage(m)
  })
})
parentPort.postMessage({ type: "ready", loadMs: 0 })
