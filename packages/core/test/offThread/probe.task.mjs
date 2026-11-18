// Tasks that probe the helper's edges (several of them after the review's probes), in plain JavaScript so they start
// fast. `input.kind` picks one.
import { parentPort, resourceLimits } from "node:worker_threads"

export default async (input) => {
  switch (input.kind) {
    case "echo":
      return input.value
    case "name": {
      const error = new Error("hidden message")
      error.name = input.secret
      throw error
    }
    case "code":
      throw Object.assign(new RangeError("hidden message"), { code: input.secret })
    case "uncaught":
      // Thrown outside the task's own promise: the worker's error event.
      setTimeout(() => {
        throw Object.assign(new Error(input.secret), { name: input.secret, code: input.secret })
      }, 1)
      return new Promise(() => undefined)
    case "view": {
      // One byte of a large buffer.
      const bytes = new Uint8Array(new ArrayBuffer(input.bytes), 0, 1)
      bytes[0] = 42
      return bytes
    }
    case "getter": {
      let reads = 0
      return {
        get text() {
          return ++reads === 1 ? "x" : "y".repeat(input.bytes)
        }
      }
    }
    case "backing": {
      // What the task can see of its input's buffer: its own bytes, and anything beside them.
      const value = input.value
      return { length: value.byteLength, backing: value.buffer.byteLength, all: Buffer.from(value.buffer).toString("latin1") }
    }
    case "write":
      input.value[0] = 99
      return input.value[0]
    case "limits":
      return { ...resourceLimits }
    case "logs": {
      const text = input.secret.repeat(input.count)
      console.log(text)
      console.error(text)
      process.stdout.write(text)
      process.stderr.write(text, () => undefined)
      return text.length
    }
    case "message":
      // A library's progress messages on the public port: never the answer.
      parentPort.postMessage({ kind: "ok", value: "partial answer" })
      parentPort.postMessage(null)
      await new Promise((resolve) => setTimeout(resolve, 50))
      return "real answer"
    case "string":
      return "a".repeat(input.chars)
    case "objects":
      return Array.from({ length: input.count }, (_, i) => ({ i }))
    default:
      throw new Error("unknown case")
  }
}
