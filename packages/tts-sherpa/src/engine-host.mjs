// Engine host: runs one sherpa-onnx OfflineTts in its own child process.
// Plain JavaScript (no TypeScript) so it can be forked without a loader under tsx or vitest.
//
// Protocol over the IPC channel (advanced serialisation, so typed arrays travel as-is):
//   in:  { type: "init", module, config, speaker, speed }   once, first message
//        { type: "speak", id, text }                         one at a time (the parent queues)
//        { type: "exit" }
//   out: { type: "ready", sampleRate } | { type: "error", message }   reply to init
//        { type: "audio", id, samples: Float32Array }               reply to speak
//        { type: "failed", id, message }                            reply to speak
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
let tts
let speaker = 0
let speed = 1

// The parent went away (crash, kill): never outlive it.
process.on("disconnect", () => process.exit(0))
// Ctrl+C in a terminal signals the whole process group. The parent shuts this
// process down in order (an "exit" message, or the IPC channel closing); dying on
// the signal instead would look like a crash and make the parent start a new one.
process.on("SIGINT", () => {})

process.on("message", async (msg) => {
  switch (msg.type) {
    case "init": {
      try {
        // "sherpa-onnx-node-v1" (1.13.8, Piper) or "sherpa-onnx-node" (2.x, Kokoro). Only one is ever loaded per process.
        const sherpa = require(msg.module)
        tts = await sherpa.OfflineTts.createAsync(msg.config)
        speaker = msg.speaker
        speed = msg.speed
        process.send({ type: "ready", sampleRate: tts.sampleRate })
      } catch (error) {
        process.send({ type: "error", message: String(error?.message ?? error) })
      }
      return
    }
    case "speak": {
      try {
        // generateAsync runs on the libuv pool, so this process keeps answering IPC while it synthesises.
        const result = await tts.generateAsync({ text: msg.text, sid: speaker, speed })
        process.send({ type: "audio", id: msg.id, samples: result.samples })
      } catch (error) {
        process.send({ type: "failed", id: msg.id, message: String(error?.message ?? error) })
      }
      return
    }
    case "exit":
      process.exit(0)
  }
})
