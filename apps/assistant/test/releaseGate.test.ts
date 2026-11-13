// The data directory lock's release gate (DataDirLock.ts, "Release gate"; fifth review): the lock is not released
// while any operation that can write into the directory is still running. For each write path, the operation is
// paused inside its file operation while the scope that holds the lock is interrupted; another process must not be
// able to take the lock until the operation has settled.
import { Effect, Exit, Fiber, Logger, Scope } from "effect"
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { acquireDataDirLock, type DataDirLock } from "../src/serve/DataDirLock.ts"
import { makeHeardAudio } from "../src/serve/HeardAudio.ts"
import { loadSettingsStore, type LoadOptions, type SaveStep, type StartupStep } from "../src/serve/SettingsStore.ts"

vi.setConfig({ testTimeout: 20_000 })

const app = fileURLToPath(new URL("../", import.meta.url))
const holder = fileURLToPath(new URL("./support/holdLock.ts", import.meta.url))
const fresh = () => mkdtempSync(join(tmpdir(), "pva-gate-"))

/** Another process (holdLock.ts --race) that tries to take the lock when asked: `try()` says whether it won. */
const otherProcess = (dir: string) =>
  new Promise<{ readonly attempt: () => Promise<boolean>; readonly release: () => Promise<void>; readonly proc: ChildProcess }>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", holder, dir, "--race"], { cwd: app, stdio: ["pipe", "pipe", "inherit"] })
    const waiting: Array<(line: string) => void> = []
    let buffer = ""
    let ready = false
    proc.stdout!.on("data", (d: Buffer) => {
      buffer += d.toString()
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (!ready && line === "ready") {
          ready = true
          const ask = (command: string) =>
            new Promise<string>((r) => {
              waiting.push(r)
              proc.stdin!.write(`${command}\n`)
            })
          resolve({ proc, attempt: () => ask("go").then((l) => l === "won"), release: () => ask("release").then(() => {}) })
        } else waiting.shift()?.(line)
      }
    })
    proc.once("exit", (code) => {
      if (!ready) reject(new Error(`lock child exited with ${code}`))
    })
  })

const children: Array<ChildProcess> = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL")
})

/** A point where an operation stops until `resume()`. */
const pauser = () => {
  let reachedResolve: () => void = () => {}
  let resumeResolve: () => void = () => {}
  const reached = new Promise<void>((r) => (reachedResolve = r))
  const resumed = new Promise<void>((r) => (resumeResolve = r))
  return {
    reached,
    resume: () => resumeResolve(),
    pause: () => {
      reachedResolve()
      return resumed
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settledWithin = async (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)])

/**
 * Runs `body` in a scope that holds the lock on `dir`; once `paused.reached`, interrupts that scope's fiber and
 * checks that another process cannot take the lock until `paused.resume()` lets the operation settle.
 */
const interruptWhilePaused = async (
  dir: string,
  paused: ReturnType<typeof pauser>,
  body: (lock: DataDirLock) => Effect.Effect<unknown, unknown, Scope.Scope>
) => {
  const other = await otherProcess(dir)
  children.push(other.proc)
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function*() {
    const lock = yield* acquireDataDirLock(dir)
    yield* body(lock)
    yield* Effect.never
  })))
  await paused.reached
  const interrupting = Effect.runPromise(Fiber.interrupt(fiber))
  expect(await settledWithin(interrupting, 100), "the scope's release waits for the operation").toBe(false)
  expect(await other.attempt(), "another process cannot take the lock while the operation runs").toBe(false)
  paused.resume()
  await interrupting
  expect(await other.attempt(), "once it has settled, the lock is released").toBe(true)
  await other.release()
}

describe("release gate: startup (recovery and clean-up)", () => {
  /** A journal from a save that replaced secrets.json and stopped before settings.json: recovery restores `prior`. */
  const halfSaved = (dir: string) => {
    const file = (revision: number, greeting: string) => `${JSON.stringify({ version: 1, revision, modules: { m: { enabled: true, settings: { greeting } } }, sections: {} }, null, 2)}\n`
    const keys = (revision: number, token: string) => `${JSON.stringify({ version: 1, revision, modules: { m: { token } }, sections: {} }, null, 2)}\n`
    const prior = { settings: file(1, "hello"), secrets: keys(1, "old") }
    const next = { settings: file(2, "hoi"), secrets: keys(2, "new") }
    writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ version: 1, revision: 1, modules: { m: { enabled: true, settings: { greeting: "other" } } }, sections: {} }, null, 2)}\n`)
    writeFileSync(join(dir, "secrets.json"), next.secrets, { mode: 0o600 })
    writeFileSync(join(dir, "transaction.json"), `${JSON.stringify({ version: 1, prior, next })}\n`, { mode: 0o600 })
    return prior
  }

  const cases: ReadonlyArray<readonly [StartupStep, (dir: string) => void, (dir: string) => void]> = [
    ["remove-temporary", (dir) => writeFileSync(join(dir, "settings.json.tmp"), "x"), () => {}],
    ["set-aside-journal", (dir) => writeFileSync(join(dir, "transaction.json"), "{damaged"), (dir) => {
      expect(readdirSync(dir).some((n) => n.startsWith("transaction.json.corrupt-")), "the rename ran before the release").toBe(true)
    }],
    ["recover-secrets", halfSaved, (dir) => {
      // The reviewer's probe: recovery paused at its secrets write. That write completes under the lock; the next
      // step (settings) does not start, because the release had begun: the journal stays for the next start.
      expect(existsSync(join(dir, "transaction.json")), "the journal is kept").toBe(true)
    }],
    ["recover-settings", halfSaved, (dir) => expect(existsSync(join(dir, "transaction.json"))).toBe(true)],
    ["recover-journal-remove", halfSaved, (dir) => expect(existsSync(join(dir, "transaction.json"))).toBe(false)],
    ["set-aside-file", (dir) => writeFileSync(join(dir, "settings.json"), "{corrupt"), () => {}]
  ]

  for (const [step, prepare, after] of cases) {
    it(`${step}: the lock is held until it settles`, async () => {
      const dir = fresh()
      prepare(dir)
      const paused = pauser()
      const options = (lock: DataDirLock): LoadOptions => ({ lock, beforeStartupStep: (s) => (s === step ? paused.pause() : undefined) })
      await interruptWhilePaused(dir, paused, (lock) => loadSettingsStore(dir, options(lock)))
      after(dir)
    })
  }

  it("after an interrupted recovery, the next start finishes it", async () => {
    const dir = fresh()
    const prior = halfSaved(dir)
    const paused = pauser()
    await interruptWhilePaused(dir, paused, (lock) =>
      loadSettingsStore(dir, { lock, beforeStartupStep: (s) => (s === "recover-secrets" ? paused.pause() : undefined) }))
    const store = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const lock = yield* acquireDataDirLock(dir)
      return yield* loadSettingsStore(dir, { lock })
    })))
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(prior.settings)
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).toBe(prior.secrets)
    expect(existsSync(join(dir, "transaction.json"))).toBe(false)
    expect(store.settings().modules.m?.settings?.greeting).toBe("hello")
  })
})

describe("release gate: saves", () => {
  const steps: ReadonlyArray<SaveStep> = ["journal", "secrets", "settings", "rollback", "journal-remove"]
  for (const step of steps) {
    it(`a save paused at ${step}: the lock is held until it settles`, async () => {
      const dir = fresh()
      const paused = pauser()
      await interruptWhilePaused(dir, paused, (lock) =>
        Effect.gen(function*() {
          const store = yield* loadSettingsStore(dir, {
            lock,
            beforeStep: (s) => {
              if (step === "rollback" && s === "settings") throw new Error("disk full")
              return s === step ? paused.pause() : undefined
            }
          })
          // Not awaited: the save runs on while the scope is interrupted.
          void Effect.runPromise(Effect.result(store.saveModule("m", { enabled: true, settings: { greeting: "hoi" }, secrets: { token: "t" } })))
        }))
    })
  }

  it("a save asked for while the release is under way is refused (nothing is written)", async () => {
    const dir = fresh()
    const paused = pauser()
    let store: Awaited<ReturnType<typeof Effect.runPromise<import("../src/serve/SettingsStore.ts").SettingsStore, unknown>>> | undefined
    let late: Promise<unknown> | undefined
    await interruptWhilePaused(dir, paused, (lock) =>
      Effect.gen(function*() {
        store = yield* loadSettingsStore(dir, { lock, beforeStep: (s) => (s === "secrets" ? paused.pause() : undefined) })
        void Effect.runPromise(Effect.result(store.saveModule("m", { enabled: true, settings: {}, secrets: { token: "t" } })))
        // A second save waits for the first one's permit, which is released only after the lock's release began.
        late = Effect.runPromise(Effect.exit(store.saveSection("conversation", { SYSTEM_PROMPT: "x" }, {})))
      }))
    const exit = (await late) as Exit.Exit<void, unknown>
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).sections.conversation).toBeUndefined()
  })
})

describe("release gate: recordings", () => {
  for (const op of ["writeFile", "rm"] as const) {
    it(`a recording ${op === "rm" ? "rotation" : "write"} paused inside the file operation: the lock is held until it settles`, async () => {
      const dir = fresh()
      const paused = pauser()
      const recordings = join(dir, "recordings")
      let finished = false
      await interruptWhilePaused(dir, paused, (lock) =>
        Effect.gen(function*() {
          const heard = makeHeardAudio({
            dir: recordings,
            enabled: () => true,
            maxFiles: () => 1,
            model: () => "test",
            log: () => {},
            writable: () => lock.held(),
            begin: lock.begin,
            closeTimeoutMs: 20,
            defer: (task) => task(),
            io: {
              mkdir: () => undefined,
              readdir: () => ["a.wav", "b.wav", "c.wav"],
              writeFile: () => (op === "writeFile" ? paused.pause().then(() => void (finished = true)) : undefined),
              rm: () => (op === "rm" ? paused.pause().then(() => void (finished = true)) : undefined)
            }
          })
          // As serveMode: the recorder's close runs before the lock's release, and gives up after `closeTimeoutMs`.
          yield* Effect.addFinalizer(() => Effect.promise(() => heard.close()))
          heard.event({ _tag: "SpeechStarted" } as never)
          heard.audio(new Uint8Array(3200))
          heard.event({ _tag: "EndOfTurn", text: "hi" } as never)
        }))
      expect(finished).toBe(true)
    })
  }
})

describe("release gate: the drain bound", () => {
  it("an operation that does not settle in time: the release logs it and keeps the lock; it is released when it settles", async () => {
    const dir = fresh()
    const other = await otherProcess(dir)
    children.push(other.proc)
    const logs: Array<string> = []
    const logger = Logger.layer([Logger.make((o) => void logs.push(String(o.message)))])
    const scope = Effect.runSync(Scope.make())
    const lock = await Effect.runPromise(acquireDataDirLock(dir, { drainTimeoutMs: 100 }).pipe(Scope.provide(scope)))
    const end = lock.begin("a stuck write")!
    const endAnother = lock.begin("another")!
    await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.provide(logger)))
    expect(logs.join("\n")).toContain("a stuck write")
    expect(logs.join("\n")).toContain("another")
    expect(lock.held()).toBe(false)
    expect(lock.begin("late"), "no new operation starts").toBeUndefined()
    expect(await other.attempt(), "still locked after the bound").toBe(false)
    end()
    expect(await other.attempt(), "one still running").toBe(false)
    endAnother()
    expect(await other.attempt(), "released once the last one settled").toBe(true)
    await other.release()
  })
})
