// offThread: a pure function in a fresh worker thread, with a real time limit, typed failures, a few at once, a
// narrow input, one serialised answer, and a small cost on the main thread. The measured numbers are printed
// (docs/MODULES.md §15 quotes them).
import { assert, describe, it } from "@effect/vitest"
import {
  OFF_THREAD_CONCURRENCY,
  OFF_THREAD_DEFAULT_RESULT_BYTES,
  OFF_THREAD_MAX_ANSWER_NODES,
  OFF_THREAD_MAX_INPUT_BYTES,
  OFF_THREAD_MAX_RESULT_BYTES,
  OFF_THREAD_MAX_WAITING,
  OFF_THREAD_STACK_MB,
  offThread,
  OffThreadError,
  offThreadTask
} from "@pva/core"
import { offThreadWorkers } from "@pva/core/testing"
import { Effect, Exit, Fiber } from "effect"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessagePort, Worker } from "node:worker_threads"
import { vi } from "vitest"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { syncBuiltinESMExports } from "node:module"
import * as v8 from "node:v8"
import v8Default from "node:v8"
import { describeThrown, markersOf, offThreadYoungGenerationMb, wireShape } from "../src/OffThread.ts"

// Every call here starts a real worker (about a quarter of a second each on a fast machine): the tests that make
// twenty of them need more than the default five seconds on a slow CI runner.
vi.setConfig({ testTimeout: 60_000 })

const task = <F extends (input: never) => unknown>(file: string) => offThreadTask<F>(new URL(`./offThread/${file}`, import.meta.url))

const shout = task<typeof import("./offThread/shout.task.ts").default>("shout.task.ts")
const loop = task<typeof import("./offThread/loop.task.ts").default>("loop.task.ts")
const allocate = task<typeof import("./offThread/allocate.task.ts").default>("allocate.task.ts")
const throws = task<typeof import("./offThread/throws.task.ts").default>("throws.task.ts")
const big = task<typeof import("./offThread/big.task.ts").default>("big.task.ts")
const echo = task<typeof import("./offThread/echo.task.ts").default>("echo.task.ts")
const nap = task<typeof import("./offThread/nap.task.ts").default>("nap.task.ts")
const exits = task<typeof import("./offThread/exits.task.ts").default>("exits.task.ts")
const nested = task<typeof import("./offThread/nested.task.ts").default>("nested.task.ts")
const noDefault = task<(input: string) => never>("noDefault.task.ts")
const missing = task<(input: string) => never>("missing.task.ts")
const pageText = task<typeof import("./offThread/pageText.task.ts").default>("pageText.task.ts")
const feedTitles = task<typeof import("./offThread/feedTitles.task.ts").default>("feedTitles.task.ts")
const plain = task<(input: unknown) => unknown>("plain.task.mjs")
const plainJs = task<(input: string) => string>("plain.task.js")
const plainCjs = task<(input: string) => string>("plain.task.cjs")
const bare = task<typeof import("./offThread/bare.task.ts").default>("bare.task.ts")
// The probes (plain JavaScript, so they start fast): `kind` picks what the task does.
const probe = task<(input: { readonly kind: string; readonly [key: string]: unknown }) => any>("probe.task.mjs")

const results: Array<string> = []
const ms = (n: number) => `${n.toFixed(1)} ms`
const MiB = 1024 * 1024

/** The longest gap between ticks of a 1 ms timer while `effect` runs (what audio framing would see). */
const longestStop = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    let last = performance.now()
    let worst = 0
    const timer = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 1)
    try {
      const value = yield* effect
      return { value, worst: Math.max(worst, performance.now() - last) }
    } finally {
      clearInterval(timer)
    }
  })

const timed = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const t0 = performance.now()
    const exit = yield* Effect.exit(effect)
    return { exit, ms: performance.now() - t0 }
  })

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (error === undefined || error._tag !== "Fail") throw new Error("expected a typed failure")
  return error.error
}

/** Waits (real time) until `check` holds, at most `ms`. */
const until = (check: () => boolean, waitMs = 5_000) =>
  Effect.gen(function*() {
    const t0 = performance.now()
    while (!check()) {
      if (performance.now() - t0 > waitMs) throw new Error("timed out waiting")
      yield* Effect.sleep(5)
    }
  })

const workerResources = () => process.getActiveResourcesInfo().filter((r) => /worker|messageport/i.test(r)).length

/** Runs `effect` with `hook` called on every worker this process starts meanwhile. */
const onWorkers = <A, E>(hook: (worker: Worker) => void, effect: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => process.on("worker", hook)),
    () => effect,
    () => Effect.sync(() => process.off("worker", hook))
  )

/** What arrived on the bootstrap's private answer port, seen before the helper reads it (`edit` may change it). */
interface Arrival {
  readonly keys: ReadonlyArray<string>
  readonly wireBytes: number | undefined
}
const observeAnswers = <A, E>(effect: Effect.Effect<A, E>, edit?: (message: Record<string, unknown>) => void) =>
  Effect.gen(function*() {
    const arrivals: Array<Arrival> = []
    const workerErrors: Array<unknown> = []
    const hook = (worker: Worker) => {
      worker.on("error", (e) => workerErrors.push(e))
      worker.prependOnceListener("message", (first: { answerPort?: MessagePort }) =>
        first.answerPort?.once("message", (message: Record<string, unknown>) => {
          arrivals.push({ keys: Object.keys(message).sort(), wireBytes: message.wire instanceof ArrayBuffer ? message.wire.byteLength : undefined })
          edit?.(message)
        }))
    }
    const value = yield* onWorkers(hook, effect)
    return { value, arrivals, workerErrors }
  })

/** A refusal that came as bounded metadata: no buffer, a few fixed fields. */
const assertMetadataOnly = (arrivals: ReadonlyArray<Arrival>) => {
  assert.strictEqual(arrivals.length, 1)
  assert.strictEqual(arrivals[0]!.wireBytes, undefined)
  for (const key of arrivals[0]!.keys) assert.include(["kind", "size", "structured", "shape", "name", "code"], key)
}

/** A folder of the test's own, for barrier files. */
const scratch = mkdtempSync(join(tmpdir(), "pva-offthread-barrier-"))
let barriers = 0
const barrier = () => join(scratch, `entered-${++barriers}`)

/** The number of intervals open at once at most: a sweep of their starts and ends, an end before an equal start. */
const peakOverlap = (intervals: ReadonlyArray<{ readonly start: number; readonly end: number }>) => {
  const events = intervals.flatMap((i) => [{ at: i.start, d: 1 }, { at: i.end, d: -1 }]).sort((a, b) => a.at - b.at || a.d - b.d)
  let open = 0
  let peak = 0
  for (const e of events) peak = Math.max(peak, (open += e.d))
  return peak
}

describe("offThread", () => {
  it.live("returns its input transformed, from a TypeScript task with a workspace import, and ends the worker", () =>
    Effect.gen(function*() {
      const out = yield* offThread(shout, { text: "Hello, Wörld", bytes: new Uint8Array([1, 2, 3]) }, { timeoutMs: 10_000 })
      assert.deepStrictEqual(out, { loud: "HELLO, WÖRLD", folded: "hello world", sum: 6 })
      assert.strictEqual(offThreadWorkers().running, 0)
    }))

  it.live("a running loop is terminated at its time limit, promptly; a limit start-up used up is a correct timeout", () =>
    Effect.gen(function*() {
      // Every run is a correct timeout. Only a run whose barrier file was written (the task entered its loop before
      // the limit) proves a running loop terminated, and only there is the time to terminate measured. When start-up
      // used up the short limit (a slow runner), the proof is tried again with a longer one, inside the file's 60 s.
      for (const limit of [bound(1_000), 10_000, 30_000]) {
        const entered = barrier()
        const { exit, ms: took } = yield* timed(offThread(loop, { entered }, { timeoutMs: limit }))
        const e = failure(exit)
        assert.strictEqual(e.reason, "timeout")
        assert.strictEqual(e.message, `loop.task.ts: took longer than ${limit} ms`)
        assert.isAtLeast(took, limit - 1)
        assert.strictEqual(offThreadWorkers().running, 0)
        if (!existsSync(entered)) {
          results.push(`loop: start-up used the whole ${limit} ms limit (a correct timeout); tried again with a longer one`)
          continue
        }
        results.push(`loop terminated: call took ${ms(took)} for a limit of ${limit} ms (${ms(took - limit)} to terminate)`)
        assert.isBelow(took, limit + bound(150))
        return
      }
      results.push("loop: start-up used every limit; each was a correct timeout, the loop's termination was not measured")
    }))

  it.live("a task that allocates until it dies fails with `memory`; the next call works", () =>
    Effect.gen(function*() {
      const e = failure(yield* Effect.exit(offThread(allocate, "", { timeoutMs: 20_000, maxMemoryMb: 32 })))
      assert.strictEqual(e.reason, "memory")
      assert.strictEqual(e.message, "allocate.task.ts: ran out of its 32 MB of memory")
      assert.deepStrictEqual(yield* offThread(big, { chars: 3 }, { timeoutMs: 10_000 }), "xxx")
    }))

  it.live("the worker's heap, young generation and stack are limited", () =>
    Effect.gen(function*() {
      const limits = yield* offThread(probe, { kind: "limits" }, { timeoutMs: 10_000, maxMemoryMb: 64 })
      assert.strictEqual(limits.maxOldGenerationSizeMb, 64)
      assert.strictEqual(limits.maxYoungGenerationSizeMb, offThreadYoungGenerationMb(64))
      assert.strictEqual(limits.maxYoungGenerationSizeMb, 8)
      assert.strictEqual(limits.stackSizeMb, OFF_THREAD_STACK_MB)
      assert.strictEqual((yield* offThread(probe, { kind: "limits" }, { timeoutMs: 10_000 })).maxYoungGenerationSizeMb, 16)
    }))

  it.live("a task that throws fails with `failed`, naming the error but never quoting the input", () =>
    Effect.gen(function*() {
      const e = failure(yield* Effect.exit(offThread(throws, "SECRET-INPUT", { timeoutMs: 10_000 })))
      assert.strictEqual(e.reason, "failed")
      assert.strictEqual(e.message, "throws.task.ts: failed (SyntaxError)")
      assert.notInclude(JSON.stringify(e), "SECRET-INPUT")
    }))

  it.live("an error's own name or code never reaches the error: only built-in names and listed codes, else a constant", () =>
    Effect.gen(function*() {
      const secret = "SECRET-INPUT\nsecond log line"
      const cases = [
        // A name set from the input.
        [{ kind: "name", secret }, "probe.task.mjs: failed (other error)"],
        // A code set from the input, on a built-in error: the name only.
        [{ kind: "code", secret }, "probe.task.mjs: failed (RangeError)"],
        // Thrown outside the task's promise (the worker's error event): the same.
        [{ kind: "uncaught", secret }, "probe.task.mjs: failed (other error)"]
      ] as const
      for (const [input, message] of cases) {
        const e = failure(yield* Effect.exit(offThread(probe, input, { timeoutMs: 10_000 })))
        assert.strictEqual(e.reason, "failed")
        assert.strictEqual(e.message, message)
        assert.notInclude(JSON.stringify(e), "SECRET")
        assert.notInclude(e.message, "\n")
      }
      // What the constructor-failure path and the error event use: the fixed lists, a constant otherwise.
      assert.strictEqual(describeThrown(Object.assign(new TypeError("x"), { code: "ERR_WORKER_PATH" })), "TypeError, ERR_WORKER_PATH")
      assert.strictEqual(describeThrown(Object.assign(new Error("x"), { name: secret, code: secret })), "other error")
      assert.strictEqual(describeThrown(Object.assign(new Error("x"), { code: "ERR_SECRET_INPUT" })), "Error")
      assert.strictEqual(describeThrown({ name: "TypeError", code: "ENOENT" }), "other error, ENOENT")
      assert.strictEqual(describeThrown(secret), "other error")
      const hostile = new Error("x")
      Object.defineProperty(hostile, "name", { get: () => { throw new Error(secret) } })
      assert.strictEqual(describeThrown(hostile), "other error")
    }))

  it.live("an answer over the result limit fails with `too-large`", () =>
    Effect.gen(function*() {
      // Refused in the worker: what arrives is the size, not the buffer.
      const { value: exit, arrivals } = yield* observeAnswers(Effect.exit(offThread(big, { chars: 200_000 }, { timeoutMs: 10_000, maxResultBytes: 100_000 })))
      const e = failure(exit)
      assert.strictEqual(e.reason, "too-large")
      assert.match(e.message, /^big\.task\.ts: answered 195\.3 KiB, over its limit of 97\.7 KiB$/)
      assertMetadataOnly(arrivals)
      // Within the limit it is answered.
      assert.strictEqual((yield* offThread(big, { chars: 50_000 }, { timeoutMs: 10_000, maxResultBytes: 100_000 })).length, 50_000)
    }))

  it.live("the answer is serialised once: what is measured is what arrives (a view's buffer, a getter read twice)", () =>
    Effect.gen(function*() {
      // One byte of a 64 MiB buffer: only the byte crosses, within a 32-byte limit.
      const view = yield* longestStop(offThread(probe, { kind: "view", bytes: 64 * MiB }, { timeoutMs: 10_000, maxResultBytes: 32 }))
      assert.instanceOf(view.value, Uint8Array)
      assert.deepStrictEqual([...view.value], [42])
      assert.isAtMost(view.value.buffer.byteLength, 32)
      assert.isBelow(view.worst, bound(10))
      // A getter that answers one character when it is first read and 32 MiB after: read once.
      const got = yield* offThread(probe, { kind: "getter", bytes: 32 * MiB }, { timeoutMs: 10_000, maxResultBytes: 32 })
      assert.deepStrictEqual(got, { text: "x" })
    }))

  it.live("messages a task or a library posts on the worker's own port are not the answer, and break nothing", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* offThread(probe, { kind: "message" }, { timeoutMs: 10_000 }), "real answer")
    }))

  it.live("the input has one narrow shape: anything else is refused with `input` before a worker is started", () =>
    Effect.gen(function*() {
      class Words {
        readonly text = "x"
      }
      const accessor = Object.defineProperty({}, "text", { get: () => "x", enumerable: true })
      const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]))
      const refused: ReadonlyArray<readonly [unknown, string]> = [
        [null, "is not a string, bytes, or one plain object or array"],
        [5, "is not a string, bytes, or one plain object or array"],
        [undefined, "is not a string, bytes, or one plain object or array"],
        [new Words(), "is not a string, bytes, or one plain object or array"],
        [new Map(), "is not a string, bytes, or one plain object or array"],
        [new Float32Array(2), "is not a string, bytes, or one plain object or array"],
        [new DataView(new ArrayBuffer(2)), "is not a string, bytes, or one plain object or array"],
        [{ inner: { text: "x" } }, "nests an object or array"],
        [[["x"]], "nests an object or array"],
        [{ when: new Date(0) }, "holds a value that is not plain data"],
        [{ n: 1n }, "holds a value that is not plain data"],
        [{ f: () => 1 }, "holds a value that is not plain data"],
        [{ missing: undefined }, "holds undefined"],
        [{ n: Number.NaN }, "holds a number that is not finite"],
        [{ n: Number.POSITIVE_INFINITY }, "holds a number that is not finite"],
        [{ bytes: new Uint16Array(2) }, "holds a value that is not plain data"],
        [accessor, "has an accessor"],
        [[1, , 3], "has a hole"],
        [many, "has more than 32 entries"],
        [Array.from({ length: 33 }, () => 1), "has more than 32 entries"],
        ["x".repeat(OFF_THREAD_MAX_INPUT_BYTES / 2 + 1), "is over its limit of 4194304 bytes"],
        [{ a: "x".repeat(MiB), b: "y".repeat(MiB), c: new Uint8Array(1) }, "is over its limit of 4194304 bytes"]
      ]
      const before = offThreadWorkers().started
      for (const [input, why] of refused) {
        const e = failure(yield* Effect.exit(offThread(plain, input, { timeoutMs: 10_000 })))
        assert.strictEqual(e.reason, "input", why)
        assert.strictEqual(e.message, `plain.task.mjs: input refused: it ${why}`)
      }
      // A smaller limit of the call's own counts every key and value: 2 per code unit, the bytes, 8 per number.
      const text = "x".repeat(1_000)
      const exact = 2 * "text".length + 2 * text.length + 2 * "n".length + 8
      assert.strictEqual(yield* offThread(plain, { text, n: 1 }, { timeoutMs: 10_000, maxInputBytes: exact }).pipe(Effect.map((v) => (v as { text: string }).text.length)), 1_000)
      assert.strictEqual(failure(yield* Effect.exit(offThread(plain, { text, n: 1 }, { timeoutMs: 10_000, maxInputBytes: exact - 1 }))).reason, "input")
      assert.strictEqual(offThreadWorkers().started, before + 1)
      // What is allowed: a string up to the limit, bytes (a Buffer too), one object or array of the allowed values.
      assert.strictEqual(yield* offThread(plain, "x".repeat(OFF_THREAD_MAX_INPUT_BYTES / 2), { timeoutMs: 10_000, maxResultBytes: OFF_THREAD_MAX_RESULT_BYTES }).pipe(Effect.map((v) => (v as string).length)), 2 * MiB)
      assert.deepStrictEqual([...(yield* offThread(plain, Buffer.from("ab"), { timeoutMs: 10_000 })) as Uint8Array], [97, 98])
      assert.deepStrictEqual(yield* offThread(plain, { s: "x", b: new Uint8Array([1]), n: -0.5, t: true, z: null }, { timeoutMs: 10_000 }), { s: "x", b: new Uint8Array([1]), n: -0.5, t: true, z: null })
      assert.deepStrictEqual(yield* offThread(plain, ["x", 1, null], { timeoutMs: 10_000 }), ["x", 1, null])
    }))

  it.live("bytes cross on a buffer of their own: a pooled Buffer's neighbours stay behind, shared memory is refused", () =>
    Effect.gen(function*() {
      // Two small Buffers share Node's pool slab: the input's view must cross alone.
      const secret = Buffer.from("UNRELATED-MAIN-SECRET-9165")
      const value = Buffer.from("internet-bytes")
      assert.strictEqual(secret.buffer, value.buffer, "the two Buffers share a slab")
      const seen = yield* offThread(probe, { kind: "backing", value }, { timeoutMs: 10_000 })
      assert.deepStrictEqual(seen, { length: 14, backing: 14, all: "internet-bytes" })
      // Shared memory is never handed to a worker; the caller's bytes are unchanged.
      const shared = new Uint8Array(new SharedArrayBuffer(4))
      for (const input of [{ kind: "write", value: shared }, shared]) {
        const e = failure(yield* Effect.exit(offThread(probe, input as never, { timeoutMs: 10_000 })))
        assert.strictEqual(e.reason, "input")
        assert.strictEqual(e.message, "probe.task.mjs: input refused: it holds shared memory")
      }
      assert.deepStrictEqual([...shared], [0, 0, 0, 0])
      // The caller's own bytes are copied, not moved: they stay readable, and what the task writes stays in the worker.
      const own = new Uint8Array([1, 2, 3])
      assert.strictEqual(yield* offThread(probe, { kind: "write", value: own }, { timeoutMs: 10_000 }), 99)
      assert.deepStrictEqual([...own], [1, 2, 3])
    }))

  it.live("a task that exits without answering fails with `exited`", () =>
    Effect.gen(function*() {
      const e = failure(yield* Effect.exit(offThread(exits, "", { timeoutMs: 10_000 })))
      assert.strictEqual(e.reason, "exited")
      assert.strictEqual(e.message, "exits.task.ts: stopped without an answer (exit code 3)")
    }))

  it.live("a task module that does not exist, has no default export, or is not a supported form fails with `load`", () =>
    Effect.gen(function*() {
      const gone = failure(yield* Effect.exit(offThread(missing, "", { timeoutMs: 10_000 })))
      assert.strictEqual(gone.reason, "load")
      assert.strictEqual(gone.message, "missing.task.ts: could not be loaded (Error, ERR_MODULE_NOT_FOUND)")
      const none = failure(yield* Effect.exit(offThread(noDefault, "", { timeoutMs: 10_000 })))
      assert.strictEqual(none.reason, "load")
      assert.strictEqual(none.message, "noDefault.task.ts: could not be loaded (TypeError, ERR_NO_DEFAULT_FUNCTION)")
      // .js and .cjs (and anything but .ts, .mts, .mjs) are refused before a worker starts.
      const before = offThreadWorkers().started
      for (const [t, name] of [[plainJs, "plain.task.js"], [plainCjs, "plain.task.cjs"]] as const) {
        const e = failure(yield* Effect.exit(offThread(t, "x", { timeoutMs: 10_000 })))
        assert.strictEqual(e.reason, "load")
        assert.strictEqual(e.message, `${name}: is not a supported task module (an ES module .ts, .mts or .mjs file)`)
      }
      assert.strictEqual(offThreadWorkers().started, before)
    }))

  it.live("options out of range are a defect; a task that is not a file is refused when it is named", () =>
    Effect.gen(function*() {
      for (const options of [{ timeoutMs: 0 }, { timeoutMs: 60_001 }, { timeoutMs: 1_000, maxMemoryMb: 8 }, { timeoutMs: 1_000, maxResultBytes: OFF_THREAD_MAX_RESULT_BYTES + 1 }, { timeoutMs: 1_000, maxInputBytes: OFF_THREAD_MAX_INPUT_BYTES + 1 }]) {
        const exit = yield* Effect.exit(offThread(big, { chars: 1 }, options))
        assert.isTrue(Exit.isFailure(exit) && exit.cause.reasons.some((r) => r._tag === "Die"), JSON.stringify(options))
      }
      assert.throws(() => offThreadTask(new URL("https://example.org/task.js")))
      assert.strictEqual(offThreadWorkers().running, 0)
    }))

  it.live("the caller interrupted mid-run: the worker is terminated, and gone once the interruption completes", () =>
    Effect.gen(function*() {
      const entered = barrier()
      const fiber = yield* Effect.forkChild(offThread(loop, { entered }, { timeoutMs: 30_000 }))
      // The task has written its barrier: it is in its loop, not loading.
      yield* until(() => existsSync(entered), 20_000)
      const t0 = performance.now()
      yield* Fiber.interrupt(fiber)
      results.push(`interrupted mid-run: worker gone ${ms(performance.now() - t0)} after the interruption`)
      assert.strictEqual(offThreadWorkers().running, 0)
      assert.strictEqual(offThreadWorkers().leftBehind, 0)
      yield* until(() => workerResources() === 0, 1_000)
    }))

  it.live(`more calls than the limit of ${OFF_THREAD_CONCURRENCY}: at most ${OFF_THREAD_CONCURRENCY} run, and a waiting call's limit counts from the call`, () =>
    Effect.gen(function*() {
      const before = offThreadWorkers().started
      const calls = Array.from({ length: 5 }, (_, id) => offThread(nap, { ms: 300, id }, { timeoutMs: 10_000 }))
      const both = yield* Effect.all([
        Effect.all(calls, { concurrency: "unbounded" }),
        // Called with the others, behind two of them: its 200 ms run out before a slot is free; it never starts.
        Effect.andThen(Effect.sleep(20), timed(offThread(nap, { ms: 1, id: 9 }, { timeoutMs: 200 })))
      ], { concurrency: "unbounded" })
      const [runs, queued] = both
      // At no instant did more than two run.
      assert.isAtMost(peakOverlap(runs), OFF_THREAD_CONCURRENCY)
      assert.strictEqual(offThreadWorkers().peak, OFF_THREAD_CONCURRENCY)
      assert.strictEqual(failure(queued.exit).reason, "timeout")
      assert.isBelow(queued.ms, 200 + bound(100))
      assert.strictEqual(offThreadWorkers().started, before + 5)
      assert.deepStrictEqual({ running: offThreadWorkers().running, queued: offThreadWorkers().queued }, { running: 0, queued: 0 })
    }))

  it("the sweep counts what is open at one instant (a legal two-worker schedule is two)", () => {
    assert.strictEqual(peakOverlap([{ start: 0, end: 1000 }, { start: 1, end: 300 }, { start: 301, end: 601 }]), 2)
    assert.strictEqual(peakOverlap([{ start: 0, end: 10 }, { start: 10, end: 20 }]), 1)
    assert.strictEqual(peakOverlap([{ start: 0, end: 10 }, { start: 5, end: 20 }, { start: 6, end: 7 }]), 3)
  })

  it.live("waiting calls start first in, first out", () =>
    Effect.gen(function*() {
      // One slot is held by a loop; the five calls then run one after another in the other slot, in the order made.
      const holder = yield* Effect.forkChild(offThread(loop, { entered: "" }, { timeoutMs: 30_000 }))
      yield* until(() => offThreadWorkers().running === 1)
      const before = offThreadWorkers().started
      const order: Array<number> = []
      const fibers: Array<Fiber.Fiber<unknown, OffThreadError>> = []
      for (let id = 0; id < 5; id++) {
        fibers.push(yield* Effect.forkChild(offThread(nap, { ms: 1, id }, { timeoutMs: 30_000 }).pipe(Effect.tap((r) => Effect.sync(() => order.push(r.id))))))
        // Each has started or is waiting before the next is made.
        yield* until(() => offThreadWorkers().started - before + offThreadWorkers().queued === id + 1)
      }
      for (const f of fibers) yield* Fiber.join(f)
      yield* Fiber.interrupt(holder)
      assert.deepStrictEqual(order, [0, 1, 2, 3, 4])
      assert.deepStrictEqual({ running: offThreadWorkers().running, queued: offThreadWorkers().queued }, { running: 0, queued: 0 })
    }))

  it.live(`at most ${OFF_THREAD_MAX_WAITING} calls wait: one more fails at once with \`busy\``, () =>
    Effect.gen(function*() {
      const holders = [
        yield* Effect.forkChild(offThread(loop, { entered: "" }, { timeoutMs: 30_000 })),
        yield* Effect.forkChild(offThread(loop, { entered: "" }, { timeoutMs: 30_000 }))
      ]
      yield* until(() => offThreadWorkers().running === 2)
      const waiting: Array<Fiber.Fiber<unknown, OffThreadError>> = []
      for (let i = 0; i < OFF_THREAD_MAX_WAITING; i++) waiting.push(yield* Effect.forkChild(offThread(plain, "x", { timeoutMs: 30_000 })))
      yield* until(() => offThreadWorkers().queued === OFF_THREAD_MAX_WAITING)
      const { exit, ms: took } = yield* timed(offThread(plain, "x".repeat(MiB), { timeoutMs: 30_000 }))
      const e = failure(exit)
      assert.strictEqual(e.reason, "busy")
      assert.strictEqual(e.message, `plain.task.mjs: refused: ${OFF_THREAD_MAX_WAITING} calls are already waiting`)
      assert.isBelow(took, bound(50))
      // Nothing of it was kept.
      assert.strictEqual(offThreadWorkers().queued, OFF_THREAD_MAX_WAITING)
      for (const f of [...waiting, ...holders]) yield* Fiber.interrupt(f)
      assert.deepStrictEqual({ running: offThreadWorkers().running, queued: offThreadWorkers().queued }, { running: 0, queued: 0 })
    }))

  it.live("a task that calls offThread itself is refused with `nested`: only the main thread may call", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* offThread(nested, "", { timeoutMs: 20_000 }), "nested")
    }))

  it.live("a waiting call whose deadline passed is never started, even when a slot frees before its timer runs", () =>
    Effect.gen(function*() {
      // As the review's probe: the first exit of a running worker is dispatched late (the main thread is held until
      // the waiting call's deadline is past); the slot it frees must not start the expired call.
      let queuedAt = 0
      let held = false
      const hook = (worker: Worker) =>
        worker.prependOnceListener("exit", () => {
          if (held || queuedAt === 0) return
          held = true
          while (performance.now() - queuedAt < 350) {
            // hold the main thread past the waiting call's deadline
          }
        })
      const before = offThreadWorkers().started
      const exit = yield* onWorkers(hook, Effect.gen(function*() {
        const first = yield* Effect.forkChild(offThread(nap, { ms: 30, id: 1 }, { timeoutMs: 10_000 }))
        const second = yield* Effect.forkChild(offThread(nap, { ms: 30, id: 2 }, { timeoutMs: 10_000 }))
        yield* until(() => offThreadWorkers().running === 2)
        queuedAt = performance.now()
        const queued = yield* Effect.exit(offThread(plain, "x", { timeoutMs: 200 }))
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        return queued
      }))
      assert.isTrue(held, "an exit was dispatched late")
      assert.strictEqual(failure(exit).reason, "timeout")
      assert.strictEqual(offThreadWorkers().started, before + 2)
    }))

  it.live("an answer that arrives after the deadline is a timeout", () =>
    Effect.gen(function*() {
      // The answer is held on its way in until the deadline has passed (the test listens on the bootstrap's answer
      // port before the helper does, so its listener runs first).
      const limit = bound(1_000)
      let t0 = 0
      const hook = (worker: Worker) =>
        worker.prependOnceListener("message", (first: { answerPort?: MessagePort }) => {
          first.answerPort?.once("message", () => {
            while (performance.now() - t0 < limit + 50) {
              // hold the answer past the deadline
            }
          })
        })
      const exit = yield* onWorkers(hook, Effect.suspend(() => {
        t0 = performance.now()
        return Effect.exit(offThread(plain, "x", { timeoutMs: limit }))
      }))
      assert.strictEqual(failure(exit).reason, "timeout")
      assert.strictEqual(offThreadWorkers().running, 0)
    }))

  it.live("ordinary output of a task (console, the streams) never reaches the main thread", () =>
    Effect.gen(function*() {
      const before = offThreadWorkers().outputBytes
      const { value, worst } = yield* longestStop(offThread(probe, { kind: "logs", secret: "SECRET-LOG", count: 2_000_000 }, { timeoutMs: 20_000 }))
      assert.strictEqual(value, 20_000_000)
      assert.strictEqual(offThreadWorkers().outputBytes, before)
      results.push(`main thread, a task writing 4 × 20 MB of output: longest stop ${ms(worst)}`)
      assert.isBelow(worst, bound(10))
    }))

  it.live("the main thread's cost: the largest legal input, and a 1 MiB input with a 100 KiB answer, hold it under 10 ms", () =>
    Effect.gen(function*() {
      const flat = (s: string) => JSON.parse(JSON.stringify(s)) as string
      const text = "abcdefghijklmnopqrstuvwxyz012345".repeat(32 * 1024) // 1 MiB
      yield* offThread(echo, { text: "warm", keep: 1 }, { timeoutMs: 10_000 }) // first load of the files
      const worstOf = <O>(make: () => Effect.Effect<O, OffThreadError>) =>
        Effect.gen(function*() {
          let worst = 0
          for (let i = 0; i < 5; i++) worst = Math.max(worst, (yield* longestStop(make())).worst)
          return worst
        })
      const usual = yield* worstOf(() => offThread(echo, { text, keep: 100 * 1024 }, { timeoutMs: 10_000 }))
      results.push(`main thread, 1 MiB in and 100 KiB out: longest stop ${ms(usual)} over 5 calls`)
      // The largest legal inputs (4 MiB as counted): a string of two-byte characters, bytes, an object of strings.
      const wide = flat("ж".repeat(OFF_THREAD_MAX_INPUT_BYTES / 2 - 64))
      const bytes = new Uint8Array(OFF_THREAD_MAX_INPUT_BYTES - 64)
      const parts = Array.from({ length: 30 }, (_, k) => flat(String.fromCharCode(0x430 + k).repeat(Math.floor((OFF_THREAD_MAX_INPUT_BYTES - 512) / 2 / 30))))
      const largest = {
        "a 4 MiB string": yield* worstOf(() => offThread(probe, { kind: "echo", value: 1, wide }, { timeoutMs: 10_000 })),
        "4 MiB of bytes": yield* worstOf(() => offThread(probe, { kind: "echo", value: 1, bytes }, { timeoutMs: 10_000 })),
        "an object of 30 strings, 4 MiB": yield* worstOf(() => offThread(probe, { kind: "echo", value: 1, ...Object.fromEntries(parts.map((p, k) => [`k${k}`, p])) }, { timeoutMs: 10_000 }))
      }
      for (const [what, worst] of Object.entries(largest)) results.push(`main thread, the largest legal input (${what}): longest stop ${ms(worst)} over 5 calls`)
      for (const worst of [usual, ...Object.values(largest)]) assert.isBelow(worst, bound(10))
    }))

  it.live("a structured answer is small: over 128 KiB it is refused whatever the limit says; only text or bytes may be larger", () =>
    Effect.gen(function*() {
      // 14,100 small objects serialise to 129.6 KiB: refused with a limit of 4 MiB, and over the default limit.
      const observed = yield* observeAnswers(Effect.exit(offThread(probe, { kind: "objects", count: 14_100 }, { timeoutMs: 10_000, maxResultBytes: OFF_THREAD_MAX_RESULT_BYTES })))
      const raised = failure(observed.value)
      assert.strictEqual(raised.reason, "too-large")
      // Refused in the worker, from what it serialised: no buffer arrived.
      assertMetadataOnly(observed.arrivals)
      assert.strictEqual(raised.message, "probe.task.mjs: answered 129.6 KiB of structured data, over its limit of 128.0 KiB (only a string or bytes may be larger)")
      const observedUsual = yield* observeAnswers(Effect.exit(offThread(probe, { kind: "objects", count: 14_100 }, { timeoutMs: 10_000 })))
      const usual = failure(observedUsual.value)
      assert.strictEqual(usual.reason, "too-large")
      assertMetadataOnly(observedUsual.arrivals)
      assert.strictEqual(usual.message, "probe.task.mjs: answered 129.6 KiB, over its limit of 128.0 KiB")
      // A string or bytes of 4 MiB pass with a limit of 4 MiB.
      const text = yield* offThread(probe, { kind: "string", chars: OFF_THREAD_MAX_RESULT_BYTES - 16 }, { timeoutMs: 10_000, maxResultBytes: OFF_THREAD_MAX_RESULT_BYTES })
      assert.strictEqual(text.length, OFF_THREAD_MAX_RESULT_BYTES - 16)
      const bytes = yield* offThread(probe, { kind: "bytes", length: OFF_THREAD_MAX_RESULT_BYTES - 16 }, { timeoutMs: 10_000, maxResultBytes: OFF_THREAD_MAX_RESULT_BYTES })
      assert.instanceOf(bytes, Uint8Array)
      assert.strictEqual(bytes.byteLength, OFF_THREAD_MAX_RESULT_BYTES - 16)
      assert.strictEqual(bytes[OFF_THREAD_MAX_RESULT_BYTES - 17], 7)
      // The default limit is 128 KiB, for text too.
      assert.strictEqual(OFF_THREAD_DEFAULT_RESULT_BYTES, 128 * 1024)
      assert.strictEqual(failure(yield* Effect.exit(offThread(big, { chars: 128 * 1024 + 1 }, { timeoutMs: 10_000 }))).reason, "too-large")
    }))

  it.live("the main thread refuses an oversized buffer without reading it (a buffer injected past the worker's checks)", () =>
    Effect.gen(function*() {
      // The test's listener on the answer port runs before the helper's and swaps the answer's buffer.
      const original = v8Default.deserialize
      let reads = 0
      v8Default.deserialize = (buffer: Parameters<typeof original>[0]) => {
        reads++
        return original(buffer)
      }
      syncBuiltinESMExports()
      try {
        // The spy sees an ordinary answer read.
        assert.strictEqual(yield* offThread(plain, "x", { timeoutMs: 10_000 }), "x")
        assert.strictEqual(reads, 1)
        // A structured buffer of 200 KiB, with a raised limit: refused unread.
        const structured = v8.serialize(Array.from({ length: 20_000 }, (_, i) => ({ i })))
        const swapIn = (bytes: Uint8Array) => (message: Record<string, unknown>) => {
          if (message.kind === "ok") message.wire = bytes.slice().buffer
        }
        const one = yield* observeAnswers(Effect.exit(offThread(plain, "x", { timeoutMs: 10_000, maxResultBytes: OFF_THREAD_MAX_RESULT_BYTES })), swapIn(structured))
        assert.strictEqual(failure(one.value).message, `plain.task.mjs: answered ${(structured.byteLength / 1024).toFixed(1)} KiB of structured data, over its limit of 128.0 KiB (only a string or bytes may be larger)`)
        // Text over the call's limit: refused unread.
        const text = v8.serialize("x".repeat(200_000))
        const two = yield* observeAnswers(Effect.exit(offThread(plain, "x", { timeoutMs: 10_000 })), swapIn(text))
        assert.strictEqual(failure(two.value).reason, "too-large")
        assert.strictEqual(reads, 1)
      } finally {
        v8Default.deserialize = original
        syncBuiltinESMExports()
      }
    }))

  it.live("an answer with an array with holes is refused in the worker, however small its serialised form (no sparse arrays)", () =>
    Effect.gen(function*() {
      // 20 bytes serialised, ten million entries when read: it never reaches the main thread.
      const { value, worst } = yield* longestStop(observeAnswers(Effect.exit(offThread(probe, { kind: "sparse", count: 10_000_000, nested: false }, { timeoutMs: 10_000, maxResultBytes: 32 }))))
      const e = failure(value.value)
      assert.strictEqual(e.reason, "too-large")
      assert.strictEqual(e.message, "probe.task.mjs: answered more than 131072 values")
      assertMetadataOnly(value.arrivals)
      results.push(`main thread, a sparse answer of ten million entries (20 bytes serialised): refused, longest stop ${ms(worst)}`)
      assert.isBelow(worst, bound(10))
      // Nested, and short: an array with any hole is refused.
      for (const input of [{ kind: "sparse", count: 1_000, nested: true }, { kind: "holey" }]) {
        const observed = yield* observeAnswers(Effect.exit(offThread(probe, input, { timeoutMs: 10_000 })))
        assert.strictEqual(failure(observed.value).message, "probe.task.mjs: answered an array with holes (no sparse arrays)")
        assertMetadataOnly(observed.arrivals)
      }
    }))

  it.live(`an answer of more than ${OFF_THREAD_MAX_ANSWER_NODES} values is refused in the worker; one of fewer is answered`, () =>
    Effect.gen(function*() {
      for (const input of [{ kind: "values", count: OFF_THREAD_MAX_ANSWER_NODES, map: false }, { kind: "values", count: 140_000, map: true }]) {
        const observed = yield* observeAnswers(Effect.exit(offThread(probe, input, { timeoutMs: 10_000, maxResultBytes: OFF_THREAD_MAX_RESULT_BYTES })))
        assert.strictEqual(failure(observed.value).message, `probe.task.mjs: answered more than ${OFF_THREAD_MAX_ANSWER_NODES} values`)
        assertMetadataOnly(observed.arrivals)
      }
      // 131,000 booleans fit in 128 KiB, and in the bound.
      assert.strictEqual((yield* offThread(probe, { kind: "values", count: 131_000, map: false }, { timeoutMs: 10_000 })).length, 131_000)
    }))

  it.live("an uncaught failure (a throw from a timer, an unhandled rejection) arrives as a name only, never as the thrown value", () =>
    Effect.gen(function*() {
      const bytes = 32 * MiB
      for (const [kind, message] of [["uncaughtBig", "probe.task.mjs: failed (Error)"], ["uncaughtObject", "probe.task.mjs: failed (other error)"], ["unhandled", "probe.task.mjs: failed (Error)"]] as const) {
        const { value, worst } = yield* longestStop(observeAnswers(Effect.exit(offThread(probe, { kind, bytes }, { timeoutMs: 10_000, maxResultBytes: 32 }))))
        const e = failure(value.value)
        assert.strictEqual(e.reason, "failed", kind)
        assert.strictEqual(e.message, message)
        assert.isBelow(JSON.stringify(e).length, 300)
        // It came on the private channel, as fixed metadata; Node's own error transport carried nothing.
        assertMetadataOnly(value.arrivals)
        assert.deepStrictEqual(value.workerErrors, [])
        results.push(`main thread, an uncaught 32 MiB failure (${kind}): longest stop ${ms(worst)}`)
        assert.isBelow(worst, bound(10))
      }
      assert.strictEqual(offThreadWorkers().running, 0)
    }))

  it.live("an own `__proto__` key of a legal input arrives as an own field, and comes back as one", () =>
    Effect.gen(function*() {
      for (const [json, expected] of [['{"kind":"keys","__proto__":null}', null], ['{"kind":"keys","__proto__":"text"}', "text"]] as const) {
        const input = JSON.parse(json) as { readonly kind: string }
        assert.deepStrictEqual(yield* offThread(probe, input, { timeoutMs: 10_000 }), { keys: ["kind", "__proto__"], proto: expected })
      }
      const withBytes: Record<string, unknown> = JSON.parse('{"kind":"keys"}')
      Object.defineProperty(withBytes, "__proto__", { value: new Uint8Array([1, 2]), enumerable: true, writable: true, configurable: true })
      const seen = yield* offThread(probe, withBytes as { readonly kind: string }, { timeoutMs: 10_000 })
      assert.deepStrictEqual(seen.keys, ["kind", "__proto__"])
      assert.deepStrictEqual([...seen.proto], [1, 2])
      // The answer side: an own `__proto__` field of the answer stays one.
      const back = (yield* offThread(plain, JSON.parse('{"__proto__":"x","a":1}'), { timeoutMs: 10_000 })) as object
      assert.deepStrictEqual(Object.getOwnPropertyDescriptor(back, "__proto__")?.value, "x")
      assert.strictEqual(Object.getPrototypeOf(back), Object.prototype)
    }))

  it("the main thread tells text and bytes from a structure by the serialised tag, before it reads the buffer", () => {
    const markers = markersOf(v8)
    const shape = (value: unknown) => wireShape(v8.serialize(value), markers)
    assert.strictEqual(shape("abc"), "text")
    assert.strictEqual(shape("жж"), "text")
    assert.strictEqual(shape("a\u{1F600}"), "text")
    assert.strictEqual(shape(""), "text")
    assert.strictEqual(shape(new Uint8Array([1, 2])), "bytes")
    assert.strictEqual(shape(Buffer.from("ab")), "bytes")
    assert.strictEqual(shape(new Uint8Array(new ArrayBuffer(8), 3, 2)), "bytes")
    for (const value of [{ a: "x" }, ["x"], [new Uint8Array(1)], new Float32Array(1), new Uint8ClampedArray(1), new DataView(new ArrayBuffer(1)), 1, null, true, new Map()]) {
      assert.strictEqual(shape(value), "structured", String(value))
    }
    assert.strictEqual(wireShape(new Uint8Array([0x22, 0, 0]), markers), "structured")
    assert.strictEqual(wireShape(new Uint8Array([]), markers), "structured")
  })

  it.live("the main thread's cost of the largest legal answers: a 4 MiB string, 4 MiB of bytes, 128 KiB of small objects", () =>
    Effect.gen(function*() {
      const worstOf = <O>(make: () => Effect.Effect<O, OffThreadError>, n: number) =>
        Effect.gen(function*() {
          let worst = 0
          for (let i = 0; i < n; i++) worst = Math.max(worst, (yield* longestStop(make())).worst)
          return worst
        })
      const big4 = { timeoutMs: 10_000, maxResultBytes: OFF_THREAD_MAX_RESULT_BYTES }
      const string = yield* worstOf(() => offThread(probe, { kind: "string", chars: OFF_THREAD_MAX_RESULT_BYTES - 16 }, big4), 5)
      const bytes = yield* worstOf(() => offThread(probe, { kind: "bytes", length: OFF_THREAD_MAX_RESULT_BYTES - 16 }, big4), 5)
      // 13,931 small objects: 131,063 bytes serialised, the largest structured answer allowed.
      const objects = yield* worstOf(() => offThread(probe, { kind: "objects", count: 13_931 }, { timeoutMs: 10_000 }), 5)
      results.push(`main thread, a 4 MiB string answer: longest stop ${ms(string)} over 5 calls`)
      results.push(`main thread, a 4 MiB bytes answer: longest stop ${ms(bytes)} over 5 calls`)
      results.push(`main thread, the largest structured answer (13,931 small objects, 128 KiB): longest stop ${ms(objects)} over 5 calls`)
      assert.isBelow(string, bound(15))
      assert.isBelow(bytes, bound(15))
      assert.isBelow(objects, bound(10))
    }))

  it.live("start-up cost per call: a bare thread, tsx's loader, linkedom, feedsmith", () =>
    Effect.gen(function*() {
      const page = `<html><body>${"<div><p>Hello <b>there</b></p></div>".repeat(50)}</body></html>`
      const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>One</title></item><item><title>Two</title></item></channel></rss>`
      assert.strictEqual((yield* offThread(pageText, page, { timeoutMs: 20_000 })).slice(0, 11), "Hello there")
      assert.deepStrictEqual(yield* offThread(feedTitles, feed, { timeoutMs: 20_000 }), ["One", "Two"])
      const median = <I, O>(t: Parameters<typeof offThread<I, O>>[0], input: I) =>
        Effect.gen(function*() {
          const times: Array<number> = []
          for (let i = 0; i < 5; i++) {
            const t0 = performance.now()
            yield* offThread(t, input, { timeoutMs: 20_000 })
            times.push(performance.now() - t0)
          }
          return times.sort((a, b) => a - b)[2]!
        })
      const costs = {
        "plain .mjs task (the thread alone)": yield* median(plain, "x"),
        ".ts task, no imports (thread + tsx)": yield* median(bare, "x"),
        ".ts task importing linkedom": yield* median(pageText, page),
        ".ts task importing feedsmith": yield* median(feedTitles, feed)
      }
      for (const [what, cost] of Object.entries(costs)) results.push(`start-up, ${what}: ${ms(cost)} (median of 5 calls)`)
      for (const cost of Object.values(costs)) assert.isBelow(cost, bound(2_000))
    }))

  it.live("many calls in a row leave no workers, handles or temporary files behind", () =>
    Effect.gen(function*() {
      // A temporary folder of this test's own (the workers get TMPDIR): after a first call of each task has filled
      // tsx's cache of transformed files there (one file per source, kept for later runs), twenty calls add nothing.
      const own = mkdtempSync(join(tmpdir(), "pva-offthread-"))
      const before = process.env.TMPDIR
      process.env.TMPDIR = own
      const filesIn = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort()
      try {
        yield* offThread(big, { chars: 1 }, { timeoutMs: 10_000 })
        yield* Effect.exit(offThread(throws, "x", { timeoutMs: 10_000 }))
        const files = filesIn(own)
        const handles = process.getActiveResourcesInfo().length
        for (let i = 0; i < 20; i++) {
          const exit = yield* Effect.exit(i % 4 === 3 ? offThread(throws, "x", { timeoutMs: 10_000 }) : offThread(big, { chars: 10 }, { timeoutMs: 10_000 }))
          assert.strictEqual(Exit.isSuccess(exit), i % 4 !== 3)
        }
        yield* until(() => workerResources() === 0, 1_000)
        assert.deepStrictEqual({ running: offThreadWorkers().running, queued: offThreadWorkers().queued, leftBehind: offThreadWorkers().leftBehind }, { running: 0, queued: 0, leftBehind: 0 })
        assert.isAtMost(process.getActiveResourcesInfo().length, handles)
        assert.deepStrictEqual(filesIn(own), files)
      } finally {
        if (before === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = before
        rmSync(own, { recursive: true, force: true })
        rmSync(scratch, { recursive: true, force: true })
      }
      console.log(`offThread:\n  ${results.join("\n  ")}`)
    }))
})
