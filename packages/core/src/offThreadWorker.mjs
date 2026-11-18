// The worker side of `offThread` (OffThread.ts): one fresh thread per call. Before anything else is loaded it makes
// a private channel for its answer (its other end is the first and only thing posted on the public port, which is
// then closed to the task), and silences console and the output streams. Then it loads the task module (through tsx's
// loader when the task is TypeScript, so it loads the same under tsx, vitest and plain node), runs its default export
// once on the input, serialises the answer once into one exactly sized buffer, checks its size (a structured answer
// against the smaller structured limit, from the tag of what it serialised), and transfers that
// buffer on the private channel. The main thread terminates the worker once the answer has arrived, or at the time
// limit.
//
// Nothing here ever posts the input or a thrown error's message back (either may quote the input): only an error's
// name and code, and only when they are on the lists the main thread passed.
import { serialize } from "node:v8"
import { MessageChannel, parentPort, workerData } from "node:worker_threads"

const { task, input, maxResultBytes, maxStructuredBytes, markers, names, codes } = workerData

// The private answer channel. The worker stays alive on it until the main thread terminates it, so the answer is
// never raced by the thread's exit.
const { port1: answers, port2 } = new MessageChannel()
parentPort.postMessage({ answerPort: port2 }, [port2])
answers.on("message", () => undefined)
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

const answer = await main()
answers.postMessage(answer, answer.kind === "ok" ? [answer.wire] : [])
