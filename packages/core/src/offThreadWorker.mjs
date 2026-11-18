// The worker side of `offThread` (OffThread.ts): one fresh thread per call. It loads the task module (through tsx's
// loader when the task is TypeScript, so it loads the same under tsx, vitest and plain node), runs its default
// export once on the input, measures the answer, and posts exactly one message. The main thread terminates the worker
// as soon as that message arrives, or at the time limit, whatever it is doing.
//
// Nothing here ever posts the input or a thrown error's message back (either may quote the input): only an error's
// name and code.
import { serialize } from "node:v8"
import { parentPort, workerData } from "node:worker_threads"

const { task, input, maxResultBytes } = workerData

const describe = (e) => ({
  name: e instanceof Error ? e.name : typeof e,
  ...(typeof e === "object" && e !== null && typeof e.code === "string" ? { code: e.code.slice(0, 60) } : {})
})

const load = async () => {
  if (/\.[cm]?ts$/.test(new URL(task).pathname)) {
    const { register } = await import("tsx/esm/api")
    register()
  }
  const mod = await import(task)
  if (typeof mod.default !== "function") throw Object.assign(new TypeError("no default function"), { code: "ERR_NO_DEFAULT_FUNCTION" })
  return mod.default
}

const main = async () => {
  let run
  try {
    run = await load()
  } catch (e) {
    return { ok: false, reason: "load", ...describe(e) }
  }
  let value
  try {
    value = await run(input)
  } catch (e) {
    return { ok: false, reason: "failed", ...describe(e) }
  }
  let size
  try {
    size = serialize(value).byteLength
  } catch (e) {
    return { ok: false, reason: "failed", ...describe(e) }
  }
  if (size > maxResultBytes) return { ok: false, reason: "too-large", size }
  return { ok: true, value }
}

const answer = await main()
try {
  parentPort.postMessage(answer)
} catch (e) {
  parentPort.postMessage({ ok: false, reason: "failed", ...describe(e) })
}
