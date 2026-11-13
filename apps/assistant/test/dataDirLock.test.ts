// One writer per data directory (DataDirLock.ts, SettingsStore.ts): a second server, a stale lock, recovery
// while another process is mid-save, and the read-only command-line modes beside a running server.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { type ChildProcess, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  acquireDataDirLock,
  acquireDataDirLockSync,
  HOLDER_FILE,
  LOCK_FILE,
  releaseDataDirLock,
  setFlockProgramForTests
} from "../src/serve/DataDirLock.ts"
import { loadSettingsStore } from "../src/serve/SettingsStore.ts"
import { openStore } from "./support/store.ts"

const fresh = () => mkdtempSync(join(tmpdir(), "pva-lock-"))
const onDisk = (dir: string, file: string) => existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), "utf8")) : undefined
const mode = (path: string) => statSync(path).mode & 0o777

const app = fileURLToPath(new URL("../", import.meta.url))
const holder = fileURLToPath(new URL("./support/holdLock.ts", import.meta.url))

/** A child running holdLock.ts; resolves with it once a line matching `ready` was printed. */
const child = (dir: string, args: ReadonlyArray<string>, ready: string) =>
  new Promise<{ proc: ChildProcess; lines: Array<string>; next: () => Promise<string> }>((resolve, reject) => {
    // Node itself (not the tsx wrapper), so the pid is the lock holder's and SIGKILL reaches it.
    const proc = spawn(process.execPath, ["--import", "tsx", holder, dir, ...args], { cwd: app, stdio: ["pipe", "pipe", "inherit"] })
    const lines: Array<string> = []
    const waiting: Array<(line: string) => void> = []
    let buffer = ""
    let started = false
    proc.stdout!.on("data", (d: Buffer) => {
      buffer += d.toString()
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (!started) {
          lines.push(line)
          if (line.startsWith(ready)) {
            started = true
            resolve({ proc, lines, next: () => new Promise((r) => waiting.push(r)) })
          }
        } else {
          const w = waiting.shift()
          if (w !== undefined) w(line)
          else lines.push(line)
        }
      }
    })
    proc.once("exit", (code) => {
      if (!started) reject(new Error(`lock child exited with ${code}`))
    })
  })

/** Another process that takes the lock on `dir` and holds it until killed. */
const otherProcess = (dir: string, args: ReadonlyArray<string> = []) => child(dir, args, "locked").then((c) => c.proc)
const exited = (proc: ChildProcess) => new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r(undefined) : proc.once("exit", r)))

describe("DataDirLock: one writer", () => {
  it.effect("a second writer on the same directory is refused while the first holds it (the stale-snapshot case)", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const a = yield* openStore(dir)
      yield* a.saveModule("one", { enabled: true, settings: {}, secrets: { token: "t1" } })
      yield* a.saveModule("two", { enabled: true, settings: {}, secrets: { token: "t2" } })
      // A removes a credential. B, loaded earlier, would save its stale copy of both files and bring it back.
      const second = yield* Effect.exit(Effect.scoped(acquireDataDirLock(dir)))
      assert.isTrue(Exit.isFailure(second))
      if (Exit.isFailure(second)) assert.include(String(second.cause), `another assistant is using it (process ${process.pid}`)
      yield* a.saveModule("one", { enabled: true, settings: {}, secrets: {} })
      assert.deepStrictEqual(Object.keys(onDisk(dir, "secrets.json").modules), ["two"])
      // A writable load without the lock is refused outright.
      const unlocked = yield* Effect.result(loadSettingsStore(dir))
      assert.strictEqual(unlocked._tag, "Failure")
    }))

  it.effect("a store whose lock was released cannot save; writer.lock itself stays, the holder file goes", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const scope = yield* Scope.make()
      const lock = yield* acquireDataDirLock(dir).pipe(Scope.provide(scope))
      assert.strictEqual(onDisk(dir, HOLDER_FILE).pid, process.pid)
      const store = yield* loadSettingsStore(dir, { lock })
      yield* Scope.close(scope, Exit.void)
      assert.isTrue(existsSync(join(dir, LOCK_FILE)), "never removed: the lock lives on this inode")
      assert.isFalse(existsSync(join(dir, HOLDER_FILE)))
      const result = yield* Effect.result(store.saveModule("one", { enabled: true, settings: {}, secrets: {} }))
      assert.strictEqual(result._tag, "Failure")
      assert.isUndefined(onDisk(dir, "settings.json"))
    }))

  it.live("another process holding the lock refuses this one, naming it; once it is killed (SIGKILL), the lock is free at once", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const proc = yield* Effect.promise(() => otherProcess(dir))
      try {
        const refused = yield* Effect.exit(Effect.scoped(acquireDataDirLock(dir)))
        assert.isTrue(Exit.isFailure(refused))
        if (Exit.isFailure(refused)) {
          assert.include(String(refused.cause), `process ${proc.pid}`)
          assert.include(String(refused.cause), "PVA_DATA_DIR")
        }
      } finally {
        proc.kill("SIGKILL")
      }
      yield* Effect.promise(() => exited(proc))
      assert.strictEqual(onDisk(dir, HOLDER_FILE).pid, proc.pid, "a killed process leaves its holder file behind")
      const { lock, previous } = acquireDataDirLockSync(dir)
      assert.strictEqual(previous?.pid, proc.pid, "reported as a holder that did not stop cleanly")
      assert.strictEqual(onDisk(dir, HOLDER_FILE).pid, process.pid, "overwritten by the new holder")
      releaseDataDirLock(lock)
      assert.deepStrictEqual(readdirSync(dir), [LOCK_FILE], "nothing else left")
    }), { timeout: 20_000 })

  it.live("a program the holder started (that outlives it) does not keep the lock: the descriptor is close-on-exec", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const started = yield* Effect.promise(() => child(dir, ["--grandchild"], "locked"))
      const grandchild = Number(started.lines.find((l) => l.startsWith("grandchild "))!.split(" ")[1])
      try {
        started.proc.kill("SIGKILL")
        yield* Effect.promise(() => exited(started.proc))
        process.kill(grandchild, 0) // still running
        const { lock } = acquireDataDirLockSync(dir)
        releaseDataDirLock(lock)
      } finally {
        try {
          process.kill(grandchild, "SIGKILL")
        } catch {
          // gone
        }
      }
    }), { timeout: 20_000 })

  it.live("processes racing for the lock at the same instant: exactly one wins, 50 rounds; after the winner is killed (SIGKILL), exactly one of the rest, 30 rounds (the previous lock let 2–3 win in 19 of 30)", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const N = 8
      const workers = yield* Effect.promise(() => Promise.all(Array.from({ length: N }, () => child(dir, ["--race"], "ready"))))
      try {
        const round = async (pool: typeof workers) => {
          const answers = pool.map((w) => w.next())
          for (const w of pool) w.proc.stdin!.write("go\n") // as close to the same instant as the pipes allow
          const results = await Promise.all(answers)
          const winners = pool.filter((_, i) => results[i] === "won")
          for (const r of results) if (r !== "won") assert.include(r, "another assistant is using it")
          return winners
        }
        for (let i = 0; i < 50; i++) {
          const winners = yield* Effect.promise(() => round(workers))
          assert.strictEqual(winners.length, 1, `round ${i}: exactly one winner`)
          const done = winners[0]!.next()
          winners[0]!.proc.stdin!.write("release\n")
          assert.strictEqual(yield* Effect.promise(() => done), "released")
        }
        // The holder dies by SIGKILL; the others start at once.
        for (let i = 0; i < 30; i++) {
          const [winner] = yield* Effect.promise(() => round(workers))
          assert.isDefined(winner)
          winner!.proc.kill("SIGKILL")
          yield* Effect.promise(() => exited(winner!.proc))
          workers.splice(workers.indexOf(winner!), 1)
          const winners = yield* Effect.promise(() => round(workers))
          assert.strictEqual(winners.length, 1, `after kill ${i}: exactly one winner`)
          const done = winners[0]!.next()
          winners[0]!.proc.stdin!.write("release\n")
          yield* Effect.promise(() => done)
          workers.push(yield* Effect.promise(() => child(dir, ["--race"], "ready")))
        }
      } finally {
        for (const w of workers) w.proc.kill("SIGKILL")
      }
    }), { timeout: 120_000 })

  it.live("freshly started processes racing: exactly one wins (5 rounds of 8)", () =>
    Effect.gen(function*() {
      for (let i = 0; i < 5; i++) {
        const dir = fresh()
        const workers = yield* Effect.promise(() => Promise.all(Array.from({ length: 8 }, () => child(dir, ["--race"], "ready"))))
        try {
          const answers = workers.map((w) => w.next())
          for (const w of workers) w.proc.stdin!.write("go\n")
          const results = yield* Effect.promise(() => Promise.all(answers))
          assert.strictEqual(results.filter((r) => r === "won").length, 1, results.join("; "))
        } finally {
          for (const w of workers) w.proc.kill("SIGKILL")
        }
      }
    }), { timeout: 120_000 })

  it("a holder file left by a dead process is never a reason to refuse, and never one to take over", () => {
    const dir = fresh()
    // A dead process on this host (a pid that cannot exist), and one from before a reboot of this host.
    for (const left of [{ pid: 2 ** 22 + 7, host: hostname(), bootId: "old", since: "yesterday" }, { pid: 1, host: hostname(), bootId: null, since: "x" }]) {
      writeFileSync(join(dir, HOLDER_FILE), JSON.stringify(left))
      const { lock, previous } = acquireDataDirLockSync(dir)
      assert.strictEqual(previous?.pid, left.pid)
      // Whatever the file says, a second taker is refused while the lock is held.
      writeFileSync(join(dir, HOLDER_FILE), JSON.stringify({ pid: 2 ** 22 + 9, host: hostname(), bootId: null, since: "never" }))
      assert.throws(() => acquireDataDirLockSync(dir), /another assistant is using it \(process 4194313/)
      releaseDataDirLock(lock)
    }
  })

  it("a holder file from another machine stops the start (a lock there may not be visible here) until it is deleted", () => {
    const dir = fresh()
    writeFileSync(join(dir, HOLDER_FILE), JSON.stringify({ pid: 1, host: "some-other-host", bootId: "another-kernel", since: "now" }))
    assert.throws(() => acquireDataDirLockSync(dir), /another machine \(process 1 on some-other-host[^]*delete .*writer\.holder/)
    rmSync(join(dir, HOLDER_FILE))
    releaseDataDirLock(acquireDataDirLockSync(dir).lock)
    // Another host name on the same kernel (a container sharing the directory): the lock covers it.
    writeFileSync(join(dir, HOLDER_FILE), JSON.stringify({ pid: 1, host: "a-container", bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), since: "now" }))
    releaseDataDirLock(acquireDataDirLockSync(dir).lock)
  })

  it("without the flock program the start fails, saying what is missing; nothing falls back to a weaker lock", () => {
    const dir = fresh()
    setFlockProgramForTests("/nonexistent/flock")
    try {
      assert.throws(() => acquireDataDirLockSync(dir), /"flock" program \(util-linux\) was not found/)
    } finally {
      setFlockProgramForTests("flock")
    }
    releaseDataDirLock(acquireDataDirLockSync(dir).lock)
  })

  it("if writer.lock is deleted while held, the holder stops writing (a server started after that locks the new file)", () => {
    const dir = fresh()
    const first = acquireDataDirLockSync(dir).lock
    rmSync(join(dir, LOCK_FILE))
    assert.isFalse(first.held())
    const second = acquireDataDirLockSync(dir).lock
    assert.isTrue(second.held())
    assert.isFalse(first.held())
    releaseDataDirLock(first)
    releaseDataDirLock(second)
  })

  it.effect("a server starting while another process is in the middle of a save neither recovers nor touches the files", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const seen: Array<string> = []
      const a = yield* openStore(dir, {
        beforeStep: (step) => {
          if (step !== "settings" || !existsSync(join(dir, "transaction.json"))) return
          // The journal and the new secrets are on disk, the settings not yet: what a concurrent start would find.
          const before = { journal: readFileSync(join(dir, "transaction.json"), "utf8"), secrets: readFileSync(join(dir, "secrets.json"), "utf8") }
          try {
            acquireDataDirLockSync(dir)
            seen.push("acquired")
          } catch (error) {
            seen.push((error as Error).message.includes("another assistant") ? "refused" : String(error))
          }
          assert.strictEqual(readFileSync(join(dir, "transaction.json"), "utf8"), before.journal)
          assert.strictEqual(readFileSync(join(dir, "secrets.json"), "utf8"), before.secrets)
        }
      })
      yield* a.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" })
      yield* a.saveSection("language-model", { LLM_PROVIDER: "fake" }, {})
      assert.deepStrictEqual(seen, ["refused", "refused"])
      assert.isFalse(existsSync(join(dir, "transaction.json")))
    }))

  it.effect("the command-line modes (read-only) load beside a running server, mid-save too, and write nothing", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const a = yield* openStore(dir)
      yield* a.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" })
      const before = readdirSync(dir).sort()
      const reader = yield* loadSettingsStore(dir, { readOnly: true })
      assert.deepStrictEqual(reader.secrets().sections["language-model"], { ANTHROPIC_API_KEY: "k1" })
      assert.deepStrictEqual(readdirSync(dir).sort(), before)
      // A journal left mid-save: the reader uses the state it resolves to, and leaves the journal for the writer.
      const journal = { version: 1, prior: { settings: readFileSync(join(dir, "settings.json"), "utf8"), secrets: readFileSync(join(dir, "secrets.json"), "utf8") }, next: { settings: "{\"version\":1,\"modules\":{},\"sections\":{}}\n", secrets: "{\"version\":1,\"modules\":{},\"sections\":{}}\n" } }
      writeFileSync(join(dir, "transaction.json"), JSON.stringify(journal), { mode: 0o600 })
      const midSave = yield* loadSettingsStore(dir, { readOnly: true })
      assert.deepStrictEqual(midSave.secrets().sections["language-model"], { ANTHROPIC_API_KEY: "k1" })
      assert.isTrue(existsSync(join(dir, "transaction.json")))
      // ... and its saves are ignored.
      yield* midSave.saveSection("language-model", { LLM_PROVIDER: "fake" }, {})
      assert.deepStrictEqual(onDisk(dir, "settings.json").sections["language-model"], { LLM_PROVIDER: "anthropic" })
    }))
})

describe("SettingsStore: journals that cannot be used", () => {
  const committed = (dir: string) =>
    Effect.gen(function*() {
      const s = yield* openStore(dir)
      yield* s.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" })
    })

  it.effect("a journal from a newer version stops the start with what to do, and is left alone", () =>
    Effect.gen(function*() {
      const dir = fresh()
      yield* committed(dir)
      writeFileSync(join(dir, "transaction.json"), JSON.stringify({ version: 2, whatever: true }), { mode: 0o600 })
      const result = yield* Effect.result(openStore(dir))
      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.include(result.failure.message, "newer version")
        assert.include(result.failure.message, "delete")
      }
      assert.isTrue(existsSync(join(dir, "transaction.json")))
    }))

  it.effect("a damaged journal, or one whose contents are not valid files, is set aside 0600 and never written back", () =>
    Effect.gen(function*() {
      for (const journal of ["{not json", JSON.stringify({ version: 1, prior: { settings: "garbage", secrets: "{}" }, next: { settings: "x", secrets: "y" } })]) {
        for (const halfApplied of [false, true]) {
          const dir = fresh()
          yield* committed(dir)
          if (halfApplied) {
            // The finding's case: a save replaced secrets.json, crashed before settings.json, and its journal is damaged.
            const s = yield* openStore(dir, { beforeStep: (step) => { if (step === "settings" || step === "rollback") throw new Error("crash") } })
            yield* Effect.result(s.saveSection("language-model", { LLM_PROVIDER: "fake" }, { ANTHROPIC_API_KEY: "k2" }))
            assert.strictEqual(onDisk(dir, "secrets.json").sections["language-model"].ANTHROPIC_API_KEY, "k2", "new secrets, old settings")
            assert.strictEqual(onDisk(dir, "settings.json").sections["language-model"].LLM_PROVIDER, "anthropic")
          }
          const files = { settings: readFileSync(join(dir, "settings.json"), "utf8"), secrets: readFileSync(join(dir, "secrets.json"), "utf8") }
          writeFileSync(join(dir, "transaction.json"), journal, { mode: 0o644 })
          const store = yield* openStore(dir)
          assert.strictEqual(readFileSync(join(dir, "settings.json"), "utf8"), files.settings, "nothing from the journal was written")
          assert.strictEqual(readFileSync(join(dir, "secrets.json"), "utf8"), files.secrets)
          if (halfApplied) {
            assert.isTrue(store.problems.some((p) => p.includes("may come from two different saves")), store.problems.join("; "))
            assert.include(store.blocked() ?? "", "were not started")
          } else {
            // The revisions prove the two files are one save: nothing is held back.
            assert.isTrue(store.problems.some((p) => p.includes("belong to one save")), store.problems.join("; "))
            assert.isUndefined(store.blocked())
          }
          const asides = readdirSync(dir).filter((n) => n.startsWith("transaction.json.corrupt-"))
          assert.strictEqual(asides.length, 1)
          assert.strictEqual(mode(join(dir, asides[0]!)), 0o600)
          if (halfApplied) {
            // Restarting without saving keeps it held back (the set-aside journal and the revisions say why).
            const again = yield* openStore(dir)
            assert.include(again.blocked() ?? "", "nothing was saved since")
            let unblocked = 0
            again.onUnblocked(() => unblocked++)
            // Saving without a change is the owner's word that the settings are right.
            yield* again.saveSection("language-model", again.settings().sections["language-model"] as any, again.secrets().sections["language-model"] ?? {})
            assert.isUndefined(again.blocked())
            assert.strictEqual(unblocked, 1)
            assert.isUndefined((yield* openStore(dir)).blocked())
          } else {
            // The next successful save removes it: the state on disk is then one the owner saved since.
            yield* store.saveSection("language-model", { LLM_PROVIDER: "fake" }, {})
          }
          assert.deepStrictEqual(readdirSync(dir).filter((n) => n.startsWith("transaction.json")), [])
        }
      }
    }))

  it.effect("a recovery whose write fails stops the start, says what to do, and keeps the journal; a later start finishes it", () =>
    Effect.gen(function*() {
      const dir = fresh()
      yield* committed(dir)
      const prior = { settings: readFileSync(join(dir, "settings.json"), "utf8"), secrets: readFileSync(join(dir, "secrets.json"), "utf8") }
      const empty = "{\"version\":1,\"modules\":{},\"sections\":{}}\n"
      writeFileSync(join(dir, "transaction.json"), JSON.stringify({ version: 1, prior, next: { settings: empty, secrets: empty } }), { mode: 0o600 })
      // A crash between the two writes: the new secrets, the old settings.
      writeFileSync(join(dir, "secrets.json"), empty, { mode: 0o600 })
      const result = yield* Effect.result(openStore(dir, { beforeRecoveryWrite: () => { throw new Error("ENOSPC: no space left on device") } }))
      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.include(result.failure.message, "is writable and the disk is not full")
        assert.include(result.failure.message, "nothing is lost")
      }
      assert.isTrue(existsSync(join(dir, "transaction.json")), "kept, so a later start can finish it")
      const later = yield* openStore(dir)
      assert.deepStrictEqual(later.secrets().sections["language-model"], { ANTHROPIC_API_KEY: "k1" }, "the state before the save")
      assert.isFalse(existsSync(join(dir, "transaction.json")))
    }))

  it.effect("leftovers that may hold secrets are made 0600, counted at startup; temporary files are removed", () =>
    Effect.gen(function*() {
      const dir = fresh()
      yield* committed(dir)
      for (const name of ["secrets.json.tmp", "transaction.json.corrupt-2026", "secrets.json.corrupt-2026"]) {
        writeFileSync(join(dir, name), "{}", { mode: 0o644 })
        chmodSync(join(dir, name), 0o644)
      }
      const store = yield* openStore(dir)
      assert.isFalse(existsSync(join(dir, "secrets.json.tmp")))
      assert.strictEqual(mode(join(dir, "transaction.json.corrupt-2026")), 0o600)
      assert.strictEqual(mode(join(dir, "secrets.json.corrupt-2026")), 0o600)
      assert.isTrue(store.problems.some((p) => p.startsWith("2 set-aside files")), store.problems.join("; "))
    }))
})

describe("serve: one server per data directory", () => {
  it.live("a second server on the same data directory refuses to start, saying why; after the first stops it starts", () =>
    Effect.gen(function*() {
      const { controlledStt, fakeBuild, scriptedLlm, startTestServer } = yield* Effect.promise(() => import("./support/serveHarness.ts"))
      const dataDir = fresh()
      const build = () => fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm })
      const first = yield* Effect.promise(() => startTestServer({ build: build(), dataDir }))
      const second = yield* Effect.promise(() => startTestServer({ build: build(), dataDir }).then(() => "started", (e: unknown) => String(e)))
      assert.include(second, "another assistant is using it")
      yield* Effect.promise(() => first.close())
      const third = yield* Effect.promise(() => startTestServer({ build: build(), dataDir }))
      yield* Effect.promise(() => third.close())
      assert.isFalse(existsSync(join(dataDir, HOLDER_FILE)))
    }))
})
