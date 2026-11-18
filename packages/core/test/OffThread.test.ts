// offThread: a pure function in a fresh worker thread, with a real time limit, typed failures, a few at once, and a
// small cost on the main thread. The measured numbers are printed (docs/MODULES.md §15 quotes them).
import { assert, describe, it } from "@effect/vitest"
import { OFF_THREAD_CONCURRENCY, offThread, offThreadTask } from "@pva/core"
import { offThreadWorkers } from "@pva/core/testing"
import { Effect, Exit, Fiber } from "effect"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bound } from "../../store-sqlite/test/latencyBound.ts"

const task = <F extends (input: never) => unknown>(file: string) => offThreadTask<F>(new URL(`./offThread/${file}`, import.meta.url))

const shout = task<typeof import("./offThread/shout.task.ts").default>("shout.task.ts")
const loop = task<typeof import("./offThread/loop.task.ts").default>("loop.task.ts")
const allocate = task<typeof import("./offThread/allocate.task.ts").default>("allocate.task.ts")
const throws = task<typeof import("./offThread/throws.task.ts").default>("throws.task.ts")
const big = task<typeof import("./offThread/big.task.ts").default>("big.task.ts")
const echo = task<typeof import("./offThread/echo.task.ts").default>("echo.task.ts")
const nap = task<typeof import("./offThread/nap.task.ts").default>("nap.task.ts")
const exits = task<typeof import("./offThread/exits.task.ts").default>("exits.task.ts")
const noDefault = task<(input: null) => never>("noDefault.task.ts")
const missing = task<(input: null) => never>("missing.task.ts")
const pageText = task<typeof import("./offThread/pageText.task.ts").default>("pageText.task.ts")
const feedTitles = task<typeof import("./offThread/feedTitles.task.ts").default>("feedTitles.task.ts")
const plain = task<(input: string) => string>("plain.task.mjs")
const bare = task<typeof import("./offThread/bare.task.ts").default>("bare.task.ts")

const results: Array<string> = []
const ms = (n: number) => `${n.toFixed(1)} ms`

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

describe("offThread", () => {
  it.live("returns its input transformed, from a TypeScript task with a workspace import, and ends the worker", () =>
    Effect.gen(function*() {
      const out = yield* offThread(shout, { text: "Hello, Wörld", bytes: new Uint8Array([1, 2, 3]) }, { timeoutMs: 10_000 })
      assert.deepStrictEqual(out, { loud: "HELLO, WÖRLD", folded: "hello world", sum: 6 })
      assert.strictEqual(offThreadWorkers().running, 0)
    }))

  it.live("a task that loops forever is terminated at its time limit, promptly", () =>
    Effect.gen(function*() {
      const limit = 300
      const { exit, ms: took } = yield* timed(offThread(loop, null, { timeoutMs: limit }))
      const e = failure(exit)
      assert.strictEqual(e.reason, "timeout")
      assert.strictEqual(e.message, "loop.task.ts: took longer than 300 ms")
      results.push(`loop terminated: call took ${ms(took)} for a limit of ${limit} ms (${ms(took - limit)} to terminate)`)
      assert.isAtLeast(took, limit - 1)
      assert.isBelow(took, limit + bound(150))
      assert.strictEqual(offThreadWorkers().running, 0)
    }))

  it.live("a task that allocates until it dies fails with `memory`; the next call works", () =>
    Effect.gen(function*() {
      const e = failure(yield* Effect.exit(offThread(allocate, null, { timeoutMs: 20_000, maxMemoryMb: 32 })))
      assert.strictEqual(e.reason, "memory")
      assert.strictEqual(e.message, "allocate.task.ts: ran out of its 32 MB of memory")
      assert.deepStrictEqual(yield* offThread(big, 3, { timeoutMs: 10_000 }), "xxx")
    }))

  it.live("a task that throws fails with `failed`, naming the error but never quoting the input", () =>
    Effect.gen(function*() {
      const e = failure(yield* Effect.exit(offThread(throws, "SECRET-INPUT", { timeoutMs: 10_000 })))
      assert.strictEqual(e.reason, "failed")
      assert.strictEqual(e.message, "throws.task.ts: failed (SyntaxError)")
      assert.notInclude(JSON.stringify(e), "SECRET-INPUT")
    }))

  it.live("an answer over the result limit fails with `too-large`", () =>
    Effect.gen(function*() {
      const e = failure(yield* Effect.exit(offThread(big, 200_000, { timeoutMs: 10_000, maxResultBytes: 100_000 })))
      assert.strictEqual(e.reason, "too-large")
      assert.match(e.message, /^big\.task\.ts: answered 0\.19 MiB, over its limit of 0\.10 MiB$/)
      // Within the limit it is answered.
      assert.strictEqual((yield* offThread(big, 50_000, { timeoutMs: 10_000, maxResultBytes: 100_000 })).length, 50_000)
    }))

  it.live("a task that exits without answering fails with `exited`", () =>
    Effect.gen(function*() {
      const e = failure(yield* Effect.exit(offThread(exits, null, { timeoutMs: 10_000 })))
      assert.strictEqual(e.reason, "exited")
      assert.strictEqual(e.message, "exits.task.ts: stopped without an answer (exit code 3)")
    }))

  it.live("a task module that does not exist, or has no default export, fails with `load`", () =>
    Effect.gen(function*() {
      const gone = failure(yield* Effect.exit(offThread(missing, null, { timeoutMs: 10_000 })))
      assert.strictEqual(gone.reason, "load")
      assert.strictEqual(gone.message, "missing.task.ts: could not be loaded (Error, ERR_MODULE_NOT_FOUND)")
      const none = failure(yield* Effect.exit(offThread(noDefault, null, { timeoutMs: 10_000 })))
      assert.strictEqual(none.reason, "load")
      assert.strictEqual(none.message, "noDefault.task.ts: could not be loaded (TypeError, ERR_NO_DEFAULT_FUNCTION)")
    }))

  it.live("options out of range are a defect; a task that is not a file is refused when it is named", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(offThread(big, 1, { timeoutMs: 0 }))
      assert.isTrue(Exit.isFailure(exit) && exit.cause.reasons.some((r) => r._tag === "Die"))
      assert.throws(() => offThreadTask(new URL("https://example.org/task.js")))
      assert.strictEqual(offThreadWorkers().running, 0)
    }))

  it.live("the caller interrupted mid-run: the worker is terminated, and gone once the interruption completes", () =>
    Effect.gen(function*() {
      const before = offThreadWorkers().started
      const fiber = yield* Effect.forkChild(offThread(loop, null, { timeoutMs: 30_000 }))
      yield* until(() => offThreadWorkers().started === before + 1 && offThreadWorkers().running === 1)
      yield* Effect.sleep(200) // well into its loop
      const t0 = performance.now()
      yield* Fiber.interrupt(fiber)
      results.push(`interrupted mid-run: worker gone ${ms(performance.now() - t0)} after the interruption`)
      assert.strictEqual(offThreadWorkers().running, 0)
      assert.strictEqual(offThreadWorkers().leftBehind, 0)
      yield* until(() => workerResources() === 0, 1_000)
    }))

  it.live(`more calls than the limit of ${OFF_THREAD_CONCURRENCY}: they wait their turn, at most ${OFF_THREAD_CONCURRENCY} run, and a waiting call's limit counts from the call`, () =>
    Effect.gen(function*() {
      const before = offThreadWorkers().started
      const calls = Array.from({ length: 5 }, () => offThread(nap, 300, { timeoutMs: 10_000 }))
      const both = yield* Effect.all([
        Effect.all(calls, { concurrency: "unbounded" }),
        // Called with the others, behind two of them: its 200 ms run out before a slot is free; it never starts.
        Effect.andThen(Effect.sleep(20), timed(offThread(nap, 1, { timeoutMs: 200 })))
      ], { concurrency: "unbounded" })
      const [runs, queued] = both
      // At no moment did more than two run.
      for (const r of runs) {
        const overlapping = runs.filter((o) => o.start < r.end && r.start < o.end).length
        assert.isAtMost(overlapping, OFF_THREAD_CONCURRENCY)
      }
      assert.strictEqual(offThreadWorkers().peak, OFF_THREAD_CONCURRENCY)
      assert.strictEqual(failure(queued.exit).reason, "timeout")
      assert.isBelow(queued.ms, 200 + bound(100))
      assert.strictEqual(offThreadWorkers().started, before + 5)
      assert.deepStrictEqual({ running: offThreadWorkers().running, queued: offThreadWorkers().queued }, { running: 0, queued: 0 })
    }))

  it.live("the main thread's cost: starting a worker, posting 1 MiB in and receiving 100 KiB holds the event loop under 10 ms", () =>
    Effect.gen(function*() {
      const text = "abcdefghijklmnopqrstuvwxyz012345".repeat(32 * 1024) // 1 MiB
      yield* offThread(echo, { text: "warm", keep: 1 }, { timeoutMs: 10_000 }) // first load of the files
      let worst = 0
      for (let i = 0; i < 5; i++) {
        const { value, worst: stop } = yield* longestStop(offThread(echo, { text, keep: 100 * 1024 }, { timeoutMs: 10_000 }))
        assert.strictEqual(value.length, 100 * 1024)
        worst = Math.max(worst, stop)
      }
      results.push(`main thread, 1 MiB in and 100 KiB out: longest stop ${ms(worst)} over 5 calls`)
      assert.isBelow(worst, bound(10))
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
        yield* offThread(big, 1, { timeoutMs: 10_000 })
        yield* Effect.exit(offThread(throws, "x", { timeoutMs: 10_000 }))
        const files = filesIn(own)
        const handles = process.getActiveResourcesInfo().length
        for (let i = 0; i < 20; i++) {
          const exit = yield* Effect.exit(i % 4 === 3 ? offThread(throws, "x", { timeoutMs: 10_000 }) : offThread(big, 10, { timeoutMs: 10_000 }))
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
      }
      console.log(`offThread:\n  ${results.join("\n  ")}`)
  }))
})
