/**
 * Running a pure, CPU-heavy function off the main thread, with a real time limit (docs/MODULES.md §15).
 *
 * The main thread plays and listens to audio for every device, so nothing may hold it for more than about 10 ms.
 * Parsing text from outside with a synchronous library (a web page, a feed, a calendar, a PDF, a dictionary) takes
 * far longer, and cannot be sliced from outside the parser. `offThread` runs such a function in a **fresh worker
 * thread** started for the call and ended after it:
 *
 * - a parser fed hostile input cannot poison a later call (nothing is shared between calls);
 * - the time limit is real: at the limit, or when the caller is interrupted (barge-in, a module stopping), the worker
 *   is terminated whatever it is doing; the limit counts from the call, also while it waits for a slot;
 * - a worker that runs out of its memory, throws, exits, or answers more than its result limit fails the call with
 *   an `OffThreadError`; nothing a task does can crash or stall the server;
 * - at most `OFF_THREAD_CONCURRENCY` workers run at once in the process; later calls wait in order.
 *
 * The time limit uses the real clock, not Effect's `Clock`, so it holds under the test kit's `TestClock` too.
 *
 * A **task module** default-exports one function `(input) => output` (or a promise of it). Input and output are
 * plain data the structured clone carries. A TypeScript task is loaded through tsx's loader inside the worker (the
 * worker is a plain Node thread under tsx, vitest and node alike), which with the task's own imports is the start-up
 * cost of every call (docs/MODULES.md gives the numbers).
 *
 * Nothing is started or imported until the first call: `node:worker_threads` is loaded then.
 */
import { Effect, Schema } from "effect"
import type { Worker, WorkerOptions } from "node:worker_threads"

/** Workers running at once in the process; further calls wait (with their own time limit running). */
export const OFF_THREAD_CONCURRENCY = 2
/** The longest time limit a call may ask for. */
export const OFF_THREAD_MAX_TIMEOUT_MS = 60_000
/** The memory limit of a worker's heap when the call names none (`maxMemoryMb`). */
export const OFF_THREAD_DEFAULT_MEMORY_MB = 128
/** The largest memory limit a call may ask for. */
export const OFF_THREAD_MAX_MEMORY_MB = 1_024
/** The result limit when the call names none (`maxResultBytes`): the answer's size as the structured clone writes it. */
export const OFF_THREAD_DEFAULT_RESULT_BYTES = 1024 * 1024
/** The largest result limit a call may ask for. */
export const OFF_THREAD_MAX_RESULT_BYTES = 16 * 1024 * 1024
/** How long a terminated worker is waited for before it is left behind (only native code that ignores termination). */
const TERMINATE_WAIT_MS = 2_000

/**
 * Why a call failed:
 * - `timeout`: the time limit passed (waiting for a slot included); the worker, if it had started, was terminated;
 * - `memory`: the worker ran out of its heap (`maxMemoryMb`);
 * - `too-large`: the answer was over `maxResultBytes`;
 * - `failed`: the task threw or rejected (a stack overflow too), or its answer cannot be cloned;
 * - `exited`: the worker ended without answering (the task called `process.exit`, or the thread could not start);
 * - `load`: the task module could not be loaded, or has no default-exported function.
 */
export const OffThreadReason = Schema.Literals(["timeout", "memory", "too-large", "failed", "exited", "load"])
export type OffThreadReason = typeof OffThreadReason.Type

/**
 * A call to `offThread` failed. `message` is one bounded line for the log: the task's file name and what happened
 * (an error's name and code, never its message, and never the input).
 */
export class OffThreadError extends Schema.TaggedError<OffThreadError>()("OffThreadError", {
  reason: OffThreadReason,
  /** The task module's file name. */
  task: Schema.String,
  message: Schema.String
}) {}

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
  /** The worker's heap limit in MB (`resourceLimits.maxOldGenerationSizeMb`); default 128, at most 1,024. */
  readonly maxMemoryMb?: number
  /** The largest answer in bytes (as the structured clone writes it); default 1 MiB, at most 16 MiB. */
  readonly maxResultBytes?: number
}

// ---- The process-wide slots

interface Job {
  readonly start: () => void
}

const queue: Array<Job> = []
const state = { running: 0, started: 0, peak: 0, leftBehind: 0 }

const pump = () => {
  while (state.running < OFF_THREAD_CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!
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
 * started in all, the most at once, and left behind after a termination that did not finish in time.
 */
export const offThreadWorkers = (): {
  readonly running: number
  readonly queued: number
  readonly started: number
  readonly peak: number
  readonly leftBehind: number
} => ({ ...state, queued: queue.length })

// ---- One call

let threads: typeof import("node:worker_threads") | undefined
const loadThreads = Effect.suspend(() =>
  threads !== undefined ? Effect.succeed(threads) : Effect.promise(() => import("node:worker_threads")).pipe(Effect.tap((m) => Effect.sync(() => (threads = m))))
)

const WORKER_URL = new URL("./offThreadWorker.mjs", import.meta.url)

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

type Answer =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "load" | "failed"; readonly name: string; readonly code?: string }
  | { readonly ok: false; readonly reason: "too-large"; readonly size: number }

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MiB`

const checkOptions = (options: OffThreadOptions) => {
  const memoryMb = options.maxMemoryMb ?? OFF_THREAD_DEFAULT_MEMORY_MB
  const resultBytes = options.maxResultBytes ?? OFF_THREAD_DEFAULT_RESULT_BYTES
  const whole = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi
  if (!whole(options.timeoutMs, 1, OFF_THREAD_MAX_TIMEOUT_MS)) return new RangeError(`offThread: timeoutMs must be a whole number from 1 to ${OFF_THREAD_MAX_TIMEOUT_MS}`)
  if (!whole(memoryMb, 16, OFF_THREAD_MAX_MEMORY_MB)) return new RangeError(`offThread: maxMemoryMb must be a whole number from 16 to ${OFF_THREAD_MAX_MEMORY_MB}`)
  if (!whole(resultBytes, 1, OFF_THREAD_MAX_RESULT_BYTES)) return new RangeError(`offThread: maxResultBytes must be a whole number from 1 to ${OFF_THREAD_MAX_RESULT_BYTES}`)
  return { timeoutMs: options.timeoutMs, memoryMb, resultBytes }
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
    return Effect.flatMap(loadThreads, ({ Worker }) => run(Worker, task, input, limits))
  })

const run = <I, O>(
  WorkerClass: typeof Worker,
  task: OffThreadTask<I, O>,
  input: I,
  limits: { readonly timeoutMs: number; readonly memoryMb: number; readonly resultBytes: number }
): Effect.Effect<O, OffThreadError> =>
  Effect.callback<O, OffThreadError>((resume) => {
    const fail = (reason: OffThreadReason, what: string) => new OffThreadError({ reason, task: task.name, message: `${task.name}: ${what}` })
    let worker: Worker | undefined
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
      if (queued) leaveQueue()
      if (worker === undefined || exited) settle(effect)
      else void worker.terminate().catch(() => undefined)
    }

    const job: Job = {
      start: () => {
        queued = false
        state.started++
        const workerOptions: WorkerOptions = {
          workerData: { task: task.url.href, input, maxResultBytes: limits.resultBytes },
          resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb },
          env: workerEnv(),
          execArgv: [],
          stdout: true,
          stderr: true
        }
        try {
          worker = new WorkerClass(WORKER_URL, workerOptions)
        } catch (e) {
          release()
          decide(Effect.fail(fail("exited", `the worker could not start (${e instanceof Error ? e.name : "error"})`)))
          return
        }
        // What a task or its libraries print could quote the input: it is not passed to the server's output.
        worker.stdout.resume()
        worker.stderr.resume()
        worker.on("message", (answer: Answer) => {
          if (answer.ok) decide(Effect.succeed(answer.value as O))
          else if (answer.reason === "too-large") decide(Effect.fail(fail("too-large", `answered ${mb(answer.size)}, over its limit of ${mb(limits.resultBytes)}`)))
          else {
            const detail = `${answer.name}${answer.code !== undefined ? `, ${answer.code}` : ""}`
            decide(Effect.fail(answer.reason === "load" ? fail("load", `could not be loaded (${detail})`) : fail("failed", `failed (${detail})`)))
          }
        })
        worker.on("error", (e: Error & { code?: string }) => {
          decide(Effect.fail(e.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? fail("memory", `ran out of its ${limits.memoryMb} MB of memory`)
            : fail("failed", `failed (${e.name}${typeof e.code === "string" ? `, ${e.code.slice(0, 60)}` : ""})`)))
        })
        worker.once("exit", (code: number) => {
          exited = true
          release()
          decide(Effect.fail(fail("exited", `stopped without an answer (exit code ${code})`)))
          settle(outcome!)
          for (const f of onExited.splice(0)) f()
        })
      }
    }

    const timer = setTimeout(() => decide(Effect.fail(fail("timeout", `took longer than ${limits.timeoutMs} ms`))), limits.timeoutMs)
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
          void worker.terminate().catch(() => undefined)
        }
      })
    )
  })
