// The worker side of `offThread` (OffThread.ts): one fresh thread per call. Before anything else is loaded it makes
// a private channel for its answer (its other end is the first and only thing posted on the public port, which is
// then closed to the task), and silences console and the output streams. Then it loads the task module (through tsx's
// loader when the task is TypeScript, so it loads the same under tsx, vitest and plain node), runs its default export
// once on the input, walks the answer once (no arrays with holes, a bounded number of values; no getter is called),
// serialises it once into one exactly sized buffer, checks its size (a structured answer against the smaller
// structured limit, from the tag of what it serialised), and transfers that buffer on the private channel. An
// uncaught exception or an unhandled rejection is answered on that channel too, as a name and code only: Node's own
// error transport, which would carry the thrown value to the main thread whatever its size, is never used. The main thread terminates the worker once the answer has arrived, or at the time
// limit.
//
// Nothing here ever posts the input or a thrown error's message back (either may quote the input): only an error's
// name and code, and only when they are on the lists the main thread passed.
import { serialize } from "node:v8"
import { MessageChannel, parentPort, workerData } from "node:worker_threads"

const { task, input, maxResultBytes, maxStructuredBytes, maxNodes, markers, names, codes } = workerData

// The private answer channel. The worker stays alive on it until the main thread terminates it, so the answer is
// never raced by the thread's exit.
const { port1: answers, port2 } = new MessageChannel()
parentPort.postMessage({ answerPort: port2 }, [port2])
answers.on("message", () => undefined)
// The one answer: the first sent counts, anything after it is dropped.
let sent = false
const send = (answer) => {
  if (sent) return
  sent = true
  answers.postMessage(answer, answer.kind === "ok" ? [answer.wire] : [])
}
// What a task or a library posts on the public port goes nowhere (the main thread does not read it either).
parentPort.postMessage = () => undefined

// Ordinary output costs the main thread nothing: console and the streams write nowhere. (Writes to the raw
// descriptors, fs.writeSync(1, …), are not caught: trusted task code does not make them.)
const quiet = () => undefined
for (const key of Object.keys(console)) if (typeof console[key] === "function") console[key] = quiet
const swallow = (_chunk, encoding, callback) => {
  const done = typeof encoding === "function" ? encoding : callback
  if (typeof done === "function") process.nextTick(done)
  return true
}
process.stdout.write = swallow
process.stderr.write = swallow

const describe = (e) => {
  let name = "other error"
  let code
  try {
    if (e instanceof Error && typeof e.name === "string" && names.includes(e.name)) name = e.name
  } catch {
    // a getter that throws: the constant
  }
  try {
    const c = typeof e === "object" && e !== null ? e.code : undefined
    if (typeof c === "string" && codes.includes(c)) code = c
  } catch {
    // the same
  }
  return code === undefined ? { name } : { name, code }
}

// What the serialised answer is, from its first tag (as wireShape in OffThread.ts): one string, one Uint8Array or
// Buffer, or a structure, which may not be larger than maxStructuredBytes whatever maxResultBytes says.
const isFlat = (wire) => {
  if (wire[0] !== 0xff) return false
  let i = 1
  while (i < wire.length && (wire[i] & 0x80) !== 0) i++
  i++
  while (i < wire.length && wire[i] === 0x00) i++
  if (i >= wire.length) return false
  if (markers.text.includes(wire[i])) return true
  return wire[i] === 0x5c && i + 1 < wire.length && markers.bytes.includes(wire[i + 1])
}

// A failure outside the task's own promise (a throw from a timer, a rejection nobody handles) is answered as one, with
// the same fixed metadata; nothing of the thrown value is sent. Installed before the task is loaded.
process.on("uncaughtException", (e) => send({ kind: "failed", ...describe(e) }))
process.on("unhandledRejection", (e) => send({ kind: "failed", ...describe(e) }))

const isIndex = (key) => {
  if (typeof key !== "string") return false
  const n = Number(key)
  return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === key
}

// The answer's structure, walked once from its own keys and array lengths (no getter is called): an array with holes
// (it is allocated whole on the main thread, however small its serialised form) or more than maxNodes values in all is
// refused. Bytes and buffers are one value each.
const shapeProblem = (root) => {
  if (typeof root !== "object" || root === null) return undefined
  const seen = new Set()
  const stack = [root]
  let nodes = 0
  while (stack.length > 0) {
    const v = stack.pop()
    if (typeof v !== "object" || v === null || seen.has(v)) continue
    seen.add(v)
    if (++nodes > maxNodes) return "nodes"
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue
    if (Array.isArray(v) && v.length > maxNodes) return "nodes"
    if (v instanceof Map || v instanceof Set) {
      nodes += v instanceof Map ? 2 * v.size : v.size
      if (nodes > maxNodes) return "nodes"
      for (const entry of v instanceof Map ? v.entries() : v.values()) {
        if (v instanceof Map) stack.push(entry[0], entry[1])
        else stack.push(entry)
      }
      continue
    }
    const keys = Reflect.ownKeys(v)
    nodes += keys.length
    if (nodes > maxNodes) return "nodes"
    let elements = 0
    for (const key of keys) {
      if (isIndex(key)) elements++
      const d = Object.getOwnPropertyDescriptor(v, key)
      if (d !== undefined && "value" in d) stack.push(d.value)
    }
    if (Array.isArray(v) && v.length > elements) return "sparse"
  }
  return undefined
}

const load = async () => {
  if (/\.m?ts$/.test(new URL(task).pathname)) {
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
    return { kind: "load", ...describe(e) }
  }
  let value
  try {
    value = await run(input)
  } catch (e) {
    return { kind: "failed", ...describe(e) }
  }
  let problem
  try {
    problem = shapeProblem(value)
  } catch (e) {
    return { kind: "failed", ...describe(e) }
  }
  if (problem !== undefined) return { kind: "too-large", shape: problem }
  let wire
  try {
    wire = serialize(value)
  } catch (e) {
    return { kind: "failed", ...describe(e) }
  }
  if (wire.byteLength > maxResultBytes) return { kind: "too-large", size: wire.byteLength }
  if (wire.byteLength > maxStructuredBytes && !isFlat(wire)) return { kind: "too-large", size: wire.byteLength, structured: true }
  // One exactly sized buffer of its own: that is what crosses, by transfer.
  if (wire.byteOffset === 0 && wire.buffer.byteLength === wire.byteLength) return { kind: "ok", wire: wire.buffer }
  const own = new ArrayBuffer(wire.byteLength)
  new Uint8Array(own).set(wire)
  return { kind: "ok", wire: own }
}

send(await main())
