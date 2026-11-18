/**
 * Running a pure, CPU-heavy function off the main thread, with a real time limit (docs/MODULES.md §15).
 *
 * The main thread plays and listens to audio for every device, so nothing may hold it for more than about 10 ms.
 * Parsing text from outside with a synchronous library (a web page, a feed, a calendar, a PDF, a dictionary) takes
 * far longer, and cannot be sliced from outside the parser. `offThread` runs such a function in a **fresh worker
 * thread** started for the call and ended after it.
 *
 * The task code is trusted (a module's own task file and the libraries it imports, compiled in); the **input** is not:
 * it may be huge, deeply nested, or built to make a parser loop or allocate. So:
 *
 * - the input has one narrow, bounded shape (`OffThreadInput`), checked and measured before anything is cloned, and
 *   every byte view is copied onto a buffer of its own before it crosses (nothing shared, no neighbouring bytes);
 * - the answer is serialised once, in the worker, into one exactly sized buffer that is checked against
 *   `maxResultBytes`, transferred, checked again and deserialised here; the task's value itself is never posted;
 * - the answer comes back on a private channel of the worker's bootstrap: what a task or a library posts on the
 *   worker's public port is not read, and nothing a thrown value carries reaches the error or the log except a name
 *   or a code from a fixed list;
 * - the time limit is one monotonic deadline taken when the call begins (waiting for a slot included); pure
 *   JavaScript is stopped at it (loops, regular expressions, `Atomics.wait`), a synchronous native call is not (it
 *   holds its slot until it returns);
 * - at most `OFF_THREAD_CONCURRENCY` workers run at once and at most `OFF_THREAD_MAX_WAITING` calls wait; one more is
 *   refused at once (`busy`). Only the main thread may call (tasks do not nest).
 *
 * The time limit uses the real clock, not Effect's `Clock`, so it holds under the test kit's `TestClock` too.
 *
 * A **task module** is an ES module (`.ts`, `.mts` or `.mjs`) that default-exports one function `(input) => output`
 * (or a promise of it). A TypeScript task is loaded through tsx's loader inside the worker (the worker is a plain Node
 * thread under tsx, vitest and node alike), which with the task's own imports is the start-up cost of every call
 * (docs/MODULES.md gives the numbers).
 *
 * Nothing is started or imported until the first call: `node:worker_threads` and `node:v8` are loaded then.
 */
import { Effect, Schema } from "effect"
import type { MessagePort, Worker, WorkerOptions } from "node:worker_threads"

/** Workers running at once in the process; further calls wait (with their own time limit running). */
export const OFF_THREAD_CONCURRENCY = 2
/** Calls waiting for a slot at most; one more fails at once with `busy`. */
export const OFF_THREAD_MAX_WAITING = 32
/** The longest time limit a call may ask for. */
export const OFF_THREAD_MAX_TIMEOUT_MS = 60_000
/** The memory limit of a worker's heap when the call names none (`maxMemoryMb`). */
export const OFF_THREAD_DEFAULT_MEMORY_MB = 128
/** The largest memory limit a call may ask for. */
export const OFF_THREAD_MAX_MEMORY_MB = 1_024
/** The result limit when the call names none (`maxResultBytes`): the answer's size as it is serialised. */
export const OFF_THREAD_DEFAULT_RESULT_BYTES = 1024 * 1024
/** The largest result limit a call may ask for. */
export const OFF_THREAD_MAX_RESULT_BYTES = 4 * 1024 * 1024
/** The input limit, the default and the most a call may ask for (`maxInputBytes`): string code units × 2 + bytes. */
export const OFF_THREAD_MAX_INPUT_BYTES = 4 * 1024 * 1024
/** The most entries an input object or array may have. */
export const OFF_THREAD_MAX_INPUT_ENTRIES = 32
/** A worker's stack (`resourceLimits.stackSizeMb`). */
export const OFF_THREAD_STACK_MB = 4
/** A worker's young generation (`resourceLimits.maxYoungGenerationSizeMb`) for its heap limit: an eighth, 8 to 32. */
export const offThreadYoungGenerationMb = (memoryMb: number): number => Math.min(32, Math.max(8, Math.floor(memoryMb / 8)))
/** How long a terminated worker is waited for before it is left behind (only native code that ignores termination). */
const TERMINATE_WAIT_MS = 2_000

/**
 * Why a call failed:
 * - `timeout`: the time limit passed (waiting for a slot included); the worker, if it had started, was terminated;
 * - `memory`: the worker ran out of its heap (`maxMemoryMb`);
 * - `too-large`: the answer was over `maxResultBytes`;
 * - `failed`: the task threw or rejected (a stack overflow too), or its answer cannot be serialised;
 * - `exited`: the worker ended without answering (the task called `process.exit`, or the thread could not start);
 * - `load`: the task module could not be loaded, has no default-exported function, or is not a supported form;
 * - `input`: the input is not of the allowed shape, or is over `maxInputBytes`; refused before a worker is started;
 * - `busy`: `OFF_THREAD_MAX_WAITING` calls were already waiting for a slot; refused at once;
 * - `nested`: called from a worker thread (from a task); only the main thread may call.
 */
export const OffThreadReason = Schema.Literals(["timeout", "memory", "too-large", "failed", "exited", "load", "input", "busy", "nested"])
export type OffThreadReason = typeof OffThreadReason.Type

/**
 * A call to `offThread` failed. `message` is one bounded line for the log: the task's file name and what happened
 * (an error's name and code only from a fixed list, never its message, and never the input).
 */
export class OffThreadError extends Schema.TaggedError<OffThreadError>()("OffThreadError", {
  reason: OffThreadReason,
  /** The task module's file name. */
  task: Schema.String,
  message: Schema.String
}) {}

/** A value inside an input object or array. */
export type OffThreadValue = string | Uint8Array | number | boolean | null

/**
 * What a task may be given: a string, a `Uint8Array`, or one plain object or array (one level, at most
 * `OFF_THREAD_MAX_INPUT_ENTRIES` entries) of strings, `Uint8Array`s, finite numbers, booleans or `null`. Checked when
 * the call is made (an interface type is fine here; the shape is what counts).
 */
export type OffThreadInput = string | Uint8Array | { readonly [key: string]: OffThreadValue } | ReadonlyArray<OffThreadValue>

/** A task module, named once: its URL and the types of its default export's input and output. */
export interface OffThreadTask<I, O> {
  readonly url: URL
  /** The file name, for messages. */
  readonly name: string
  /** Types only: never set. */
  readonly types?: (input: I) => O
}

/**
 * Names a task module. Give its default export's type so calls are typed, without importing it on the main thread:
 * `offThreadTask<typeof import("./pageText.task.ts").default>(new URL("./pageText.task.ts", import.meta.url))`.
 */
export const offThreadTask = <F extends (input: never) => unknown>(url: URL): OffThreadTask<Parameters<F>[0], Awaited<ReturnType<F>>> => {
  if (url.protocol !== "file:") throw new TypeError(`An off-thread task is a file: URL, not ${url.protocol}`)
  return { url, name: url.pathname.split("/").pop() ?? url.pathname }
}

export interface OffThreadOptions {
  /** The time limit in ms, from the call (waiting for a slot included); 1 to `OFF_THREAD_MAX_TIMEOUT_MS`. */
  readonly timeoutMs: number
  /** The worker's heap limit in MB (`resourceLimits.maxOldGenerationSizeMb`); default 128, 16 to 1,024. */
  readonly maxMemoryMb?: number
  /** The largest answer in bytes, as serialised; default 1 MiB, at most 4 MiB. */
  readonly maxResultBytes?: number
  /** The largest input (string code units × 2 + bytes); default and at most 4 MiB. */
  readonly maxInputBytes?: number
}

// ---- What may cross from a thrown value: names and codes from fixed lists

/** The error names an `OffThreadError` may quote: the built-in ones. Any other name is `OTHER_ERROR`. */
export const OFF_THREAD_ERROR_NAMES: ReadonlyArray<string> = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "DataCloneError",
  "TimeoutError"
]
/** The error codes an `OffThreadError` may quote: Node's codes a task, its loading or its thread can fail with. */
export const OFF_THREAD_ERROR_CODES: ReadonlyArray<string> = [
  "ERR_NO_DEFAULT_FUNCTION",
  "ERR_MODULE_NOT_FOUND",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_PACKAGE_IMPORT_NOT_DEFINED",
  "ERR_INVALID_PACKAGE_CONFIG",
  "ERR_UNKNOWN_BUILTIN_MODULE",
  "ERR_REQUIRE_ESM",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_URL",
  "ERR_OUT_OF_RANGE",
  "ERR_INVALID_STATE",
  "ERR_INVALID_THIS",
  "ERR_INVALID_CHAR",
  "ERR_STRING_TOO_LONG",
  "ERR_BUFFER_TOO_LARGE",
  "ERR_ENCODING_NOT_SUPPORTED",
  "ERR_ENCODING_INVALID_ENCODED_DATA",
  "ERR_WORKER_INIT_FAILED",
  "ERR_WORKER_PATH",
  "ERR_WORKER_INVALID_EXEC_ARGV",
  "ERR_WORKER_UNSERIALIZABLE_ERROR",
  "ABORT_ERR",
  "ENOENT",
  "EACCES",
  "EMFILE",
  "ENOMEM"
]
const OTHER_ERROR = "other error"

/** A name and code from the fixed lists, else the constant; nothing else of a thrown value is read. */
export const describeThrown = (e: unknown): string => {
  let name = OTHER_ERROR
  let code: string | undefined
  try {
    const n: unknown = (e as { name?: unknown } | null)?.name
    if (e instanceof Error && typeof n === "string" && OFF_THREAD_ERROR_NAMES.includes(n)) name = n
  } catch {
    // a getter that throws: the constant
  }
  try {
    const c: unknown = (e as { code?: unknown } | null)?.code
    if (typeof c === "string" && OFF_THREAD_ERROR_CODES.includes(c)) code = c
  } catch {
    // the same
  }
  return code === undefined ? name : `${name}, ${code}`
}

// ---- The input: one narrow shape, measured before it is cloned, byte views copied

/** The input as it crosses: byte views copied onto buffers of their own, which are transferred. */
interface Crossing {
  readonly value: unknown
  readonly transfer: Array<ArrayBuffer>
}

const isShared = (bytes: Uint8Array) => Object.prototype.toString.call(bytes.buffer) === "[object SharedArrayBuffer]"
const isPlainObject = (v: object) => {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** The size a leaf counts for (string code units × 2, bytes, 8 for the rest), or why it is refused. */
const leafSize = (v: unknown): number | string => {
  if (typeof v === "string") return v.length * 2
  if (v instanceof Uint8Array) return isShared(v) ? "holds shared memory" : v.byteLength
  if (typeof v === "number") return Number.isFinite(v) ? 8 : "holds a number that is not finite"
  if (typeof v === "boolean" || v === null) return 8
  if (v === undefined) return "holds undefined"
  if (typeof v === "object") return Array.isArray(v) || isPlainObject(v) ? "nests an object or array" : "holds a value that is not plain data"
  return "holds a value that is not plain data"
}

const copyBytes = (bytes: Uint8Array, transfer: Array<ArrayBuffer>): Uint8Array => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  transfer.push(copy.buffer)
  return copy
}
const crossLeaf = (v: unknown, transfer: Array<ArrayBuffer>): unknown => (v instanceof Uint8Array ? copyBytes(v, transfer) : v)

/**
 * Checks the input's shape and size (without copying anything), then makes what crosses. A string why it is refused
 * (fixed wording: never a key or a value of the input).
 */
export const offThreadInput = (input: unknown, maxBytes: number): Crossing | string => {
  const tooLarge = () => `is over its limit of ${maxBytes} bytes`
  if (typeof input === "string" || input instanceof Uint8Array) {
    const size = leafSize(input)
    if (typeof size === "string") return size
    if (size > maxBytes) return tooLarge()
    const transfer: Array<ArrayBuffer> = []
    return { value: crossLeaf(input, transfer), transfer }
  }
  if (typeof input !== "object" || input === null) return "is not a string, bytes, or one plain object or array"
  const entries: Array<readonly [string, unknown]> = []
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype) return "is not a string, bytes, or one plain object or array"
    if (input.length > OFF_THREAD_MAX_INPUT_ENTRIES) return `has more than ${OFF_THREAD_MAX_INPUT_ENTRIES} entries`
    for (let i = 0; i < input.length; i++) {
      const d = Object.getOwnPropertyDescriptor(input, i)
      if (d === undefined) return "has a hole"
      if (!("value" in d)) return "has an accessor"
      entries.push([String(i), d.value])
    }
  } else {
    if (!isPlainObject(input)) return "is not a string, bytes, or one plain object or array"
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue
      if (entries.length === OFF_THREAD_MAX_INPUT_ENTRIES) return `has more than ${OFF_THREAD_MAX_INPUT_ENTRIES} entries`
      const d = Object.getOwnPropertyDescriptor(input, key)!
      if (!("value" in d)) return "has an accessor"
      entries.push([key, d.value])
    }
  }
  let total = 0
  for (const [key, value] of entries) {
    const size = leafSize(value)
    if (typeof size === "string") return size
    total += size + (Array.isArray(input) ? 0 : key.length * 2)
    if (total > maxBytes) return tooLarge()
  }
  const transfer: Array<ArrayBuffer> = []
  if (Array.isArray(input)) return { value: entries.map(([, v]) => crossLeaf(v, transfer)), transfer }
  const value: Record<string, unknown> = {}
  for (const [key, v] of entries) value[key] = crossLeaf(v, transfer)
  return { value, transfer }
}

// ---- The process-wide slots

interface Job {
  readonly deadline: number
  readonly start: () => void
  readonly expire: () => void
}

const queue: Array<Job> = []
const state = { running: 0, started: 0, peak: 0, leftBehind: 0, outputBytes: 0 }

const pump = () => {
  while (state.running < OFF_THREAD_CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!
    // A job whose deadline has passed is never started (its timer may not have run yet).
    if (performance.now() >= job.deadline) {
      job.expire()
      continue
    }
    state.running++
    state.peak = Math.max(state.peak, state.running)
    job.start()
  }
}

const release = () => {
  state.running--
  pump()
}

/**
 * The workers of this process (tests): running now (a slot is held until its thread has exited), waiting for a slot,
 * started in all, the most at once, left behind after a termination that did not finish in time, and the bytes of
 * output that reached the main thread from the workers' stdout and stderr.
 */
export const offThreadWorkers = (): {
  readonly running: number
  readonly queued: number
  readonly started: number
  readonly peak: number
  readonly leftBehind: number
  readonly outputBytes: number
} => ({ ...state, queued: queue.length })

// ---- One call

interface Runtime {
  readonly threads: typeof import("node:worker_threads")
  readonly v8: typeof import("node:v8")
}
let runtime: Runtime | undefined
const loadRuntime = Effect.suspend(() =>
  runtime !== undefined
    ? Effect.succeed(runtime)
    : Effect.promise(() => Promise.all([import("node:worker_threads"), import("node:v8")])).pipe(
      Effect.map(([threads, v8]) => (runtime = { threads, v8 }))
    )
)

const WORKER_URL = new URL("./offThreadWorker.mjs", import.meta.url)
const TASK_FORM = /\.(?:ts|mts|mjs)$/

/**
 * The worker's environment: none of the server's (its keys and passwords stay out of the thread), only what Node,
 * tsx and the libraries need to behave the same.
 */
const workerEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key === "NODE_ENV" || key === "TMPDIR" || key === "TMP" || key === "TEMP" || key === "TZ" || key.startsWith("TSX_"))) env[key] = value
  }
  return env
}

/** A size for a message: bytes, KiB or MiB. */
const sized = (bytes: number) =>
  bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`

interface Limits {
  readonly timeoutMs: number
  readonly memoryMb: number
  readonly resultBytes: number
  readonly inputBytes: number
}

const checkOptions = (options: OffThreadOptions): Limits | RangeError => {
  const memoryMb = options.maxMemoryMb ?? OFF_THREAD_DEFAULT_MEMORY_MB
  const resultBytes = options.maxResultBytes ?? OFF_THREAD_DEFAULT_RESULT_BYTES
  const inputBytes = options.maxInputBytes ?? OFF_THREAD_MAX_INPUT_BYTES
  const whole = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi
  if (!whole(options.timeoutMs, 1, OFF_THREAD_MAX_TIMEOUT_MS)) return new RangeError(`offThread: timeoutMs must be a whole number from 1 to ${OFF_THREAD_MAX_TIMEOUT_MS}`)
  if (!whole(memoryMb, 16, OFF_THREAD_MAX_MEMORY_MB)) return new RangeError(`offThread: maxMemoryMb must be a whole number from 16 to ${OFF_THREAD_MAX_MEMORY_MB}`)
  if (!whole(resultBytes, 1, OFF_THREAD_MAX_RESULT_BYTES)) return new RangeError(`offThread: maxResultBytes must be a whole number from 1 to ${OFF_THREAD_MAX_RESULT_BYTES}`)
  if (!whole(inputBytes, 1, OFF_THREAD_MAX_INPUT_BYTES)) return new RangeError(`offThread: maxInputBytes must be a whole number from 1 to ${OFF_THREAD_MAX_INPUT_BYTES}`)
  return { timeoutMs: options.timeoutMs, memoryMb, resultBytes, inputBytes }
}

/**
 * Runs the task's default export on `input` in a fresh worker thread and succeeds with its answer; see the file's
 * documentation. Interruptible: interrupting the call terminates the worker, and the interruption completes once
 * the thread has exited. Options out of range are a defect (a programming error), not an `OffThreadError`.
 */
export const offThread = <I, O>(task: OffThreadTask<I, O>, input: I, options: OffThreadOptions): Effect.Effect<O, OffThreadError> =>
  Effect.suspend(() => {
    const limits = checkOptions(options)
    if (limits instanceof RangeError) return Effect.die(limits)
    // The one deadline of the call, before anything is loaded or waited for.
    const deadline = performance.now() + limits.timeoutMs
    const fail = (reason: OffThreadReason, what: string) => new OffThreadError({ reason, task: task.name, message: `${task.name}: ${what}` })
    if (!TASK_FORM.test(task.url.pathname)) return Effect.fail(fail("load", "is not a supported task module (an ES module .ts, .mts or .mjs file)"))
    const crossing = offThreadInput(input, limits.inputBytes)
    if (typeof crossing === "string") return Effect.fail(fail("input", `input refused: it ${crossing}`))
    return Effect.flatMap(loadRuntime, (rt) => {
      if (!rt.threads.isMainThread) return Effect.fail(fail("nested", "called from a worker thread: only the main thread may call offThread"))
      if (performance.now() >= deadline) return Effect.fail(fail("timeout", `took longer than ${limits.timeoutMs} ms`))
      if (queue.length >= OFF_THREAD_MAX_WAITING) return Effect.fail(fail("busy", `refused: ${OFF_THREAD_MAX_WAITING} calls are already waiting`))
      return run<O>(rt, task.url, crossing, limits, deadline, fail)
    })
  })

type Fail = (reason: OffThreadReason, what: string) => OffThreadError

const run = <O>(rt: Runtime, url: URL, crossing: Crossing, limits: Limits, deadline: number, fail: Fail): Effect.Effect<O, OffThreadError> =>
  Effect.callback<O, OffThreadError>((resume) => {
    const timedOut = () => fail("timeout", `took longer than ${limits.timeoutMs} ms`)
    let worker: Worker | undefined
    let answers: MessagePort | undefined
    let queued = true
    let outcome: Effect.Effect<O, OffThreadError> | undefined
    let exited = false
    let resumed = false
    const onExited: Array<() => void> = []

    const leaveQueue = () => {
      const at = queue.indexOf(job)
      if (at >= 0) queue.splice(at, 1)
    }
    const settle = (effect: Effect.Effect<O, OffThreadError>) => {
      if (resumed) return
      resumed = true
      clearTimeout(timer)
      resume(effect)
    }
    // The first outcome counts (the answer, the time limit, an error); the call resumes once the thread is gone.
    const decide = (effect: Effect.Effect<O, OffThreadError>) => {
      if (outcome !== undefined) return
      outcome = effect
      answers?.close()
      if (queued) leaveQueue()
      if (worker === undefined || exited) settle(effect)
      else void worker.terminate().catch(() => undefined)
    }

    // The answer envelope, validated before any field is read further; the answer itself is the one buffer the
    // worker serialised, checked again here and deserialised.
    const onAnswer = (m: unknown) => {
      if (outcome !== undefined) return
      if (performance.now() > deadline) return decide(Effect.fail(timedOut()))
      if (typeof m !== "object" || m === null) return decide(Effect.fail(fail("failed", "answered something unreadable")))
      const kind: unknown = (m as { kind?: unknown }).kind
      if (kind === "ok") {
        const wire: unknown = (m as { wire?: unknown }).wire
        if (!(wire instanceof ArrayBuffer)) return decide(Effect.fail(fail("failed", "answered something unreadable")))
        if (wire.byteLength > limits.resultBytes) return decide(Effect.fail(fail("too-large", `answered ${sized(wire.byteLength)}, over its limit of ${sized(limits.resultBytes)}`)))
        let value: O
        try {
          value = rt.v8.deserialize(new Uint8Array(wire)) as O
        } catch {
          return decide(Effect.fail(fail("failed", "answered something unreadable")))
        }
        return decide(Effect.succeed(value))
      }
      if (kind === "too-large") {
        const size: unknown = (m as { size?: unknown }).size
        const shown = typeof size === "number" && Number.isSafeInteger(size) && size > limits.resultBytes ? `answered ${sized(size)}` : "answered too much"
        return decide(Effect.fail(fail("too-large", `${shown}, over its limit of ${sized(limits.resultBytes)}`)))
      }
      if (kind === "load" || kind === "failed") {
        const detail = describeAnswered((m as { name?: unknown }).name, (m as { code?: unknown }).code)
        return decide(Effect.fail(kind === "load" ? fail("load", `could not be loaded (${detail})`) : fail("failed", `failed (${detail})`)))
      }
      return decide(Effect.fail(fail("failed", "answered something unreadable")))
    }

    const job: Job = {
      deadline,
      expire: () => decide(Effect.fail(timedOut())),
      start: () => {
        queued = false
        state.started++
        const workerOptions: WorkerOptions = {
          workerData: { task: url.href, input: crossing.value, maxResultBytes: limits.resultBytes, names: OFF_THREAD_ERROR_NAMES, codes: OFF_THREAD_ERROR_CODES },
          transferList: crossing.transfer,
          resourceLimits: {
            maxOldGenerationSizeMb: limits.memoryMb,
            maxYoungGenerationSizeMb: offThreadYoungGenerationMb(limits.memoryMb),
            stackSizeMb: OFF_THREAD_STACK_MB
          },
          env: workerEnv(),
          execArgv: [],
          stdout: true,
          stderr: true
        }
        try {
          worker = new rt.threads.Worker(WORKER_URL, workerOptions)
        } catch (e) {
          release()
          decide(Effect.fail(fail("exited", `the worker could not start (${describeThrown(e)})`)))
          return
        }
        // The bootstrap silences console and the streams before the task is loaded; what still comes is counted
        // and dropped (it could quote the input).
        worker.stdout.on("data", (chunk: Uint8Array) => (state.outputBytes += chunk.byteLength))
        worker.stderr.on("data", (chunk: Uint8Array) => (state.outputBytes += chunk.byteLength))
        // The bootstrap's first message, posted before anything else is loaded, is its private answer port. Nothing
        // after it on the public port is read.
        worker.once("message", (first: unknown) => {
          const port: unknown = typeof first === "object" && first !== null ? (first as { answerPort?: unknown }).answerPort : undefined
          if (!(port instanceof rt.threads.MessagePort)) return decide(Effect.fail(fail("failed", "did not set up its answer channel")))
          if (outcome !== undefined) return port.close()
          answers = port
          port.once("message", onAnswer)
        })
        worker.on("error", (e: unknown) => {
          let oom = false
          try {
            oom = (e as { code?: unknown } | null)?.code === "ERR_WORKER_OUT_OF_MEMORY"
          } catch {
            // not readable: not the memory limit
          }
          decide(Effect.fail(oom ? fail("memory", `ran out of its ${limits.memoryMb} MB of memory`) : fail("failed", `failed (${describeThrown(e)})`)))
        })
        worker.once("exit", (code: number) => {
          exited = true
          answers?.close()
          release()
          decide(Effect.fail(fail("exited", `stopped without an answer (exit code ${code})`)))
          settle(outcome!)
          for (const f of onExited.splice(0)) f()
        })
      }
    }

    const timer = setTimeout(() => decide(Effect.fail(timedOut())), Math.max(0, deadline - performance.now()))
    timer.unref()
    queue.push(job)
    pump()

    // Interrupted (barge-in, the module stopping, an outer limit): leave the queue, or terminate the worker and
    // wait for its thread to exit, at most TERMINATE_WAIT_MS (only native code ignores termination).
    return Effect.promise(() =>
      new Promise<void>((done) => {
        resumed = true
        clearTimeout(timer)
        if (queued) {
          leaveQueue()
          return done()
        }
        if (worker === undefined || exited) return done()
        const giveUp = setTimeout(() => {
          state.leftBehind++
          worker?.unref()
          done()
        }, TERMINATE_WAIT_MS)
        giveUp.unref()
        onExited.push(() => {
          clearTimeout(giveUp)
          done()
        })
        if (outcome === undefined) {
          outcome = Effect.interrupt
          answers?.close()
          void worker.terminate().catch(() => undefined)
        }
      })
    )
  })

/** A name and code the worker answered, kept only when they are on the fixed lists. */
const describeAnswered = (name: unknown, code: unknown): string => {
  const n = typeof name === "string" && OFF_THREAD_ERROR_NAMES.includes(name) ? name : OTHER_ERROR
  return typeof code === "string" && OFF_THREAD_ERROR_CODES.includes(code) ? `${n}, ${code}` : n
}
