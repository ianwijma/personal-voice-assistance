// Saving settings (SettingsStore.ts, sections.ts): failed writes, retries, partial writes, concurrent saves.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSections } from "../src/serve/sections.ts"
import { loadSettingsStore, type SaveStep } from "../src/serve/SettingsStore.ts"
import { openStore } from "./support/store.ts"

const fresh = () => mkdtempSync(join(tmpdir(), "pva-store-"))
/** Makes the next writes of `file` fail (its temporary file's path is taken by a directory). */
const block = (dir: string, file: string) => mkdirSync(join(dir, `${file}.tmp`))
const unblock = (dir: string, file: string) => rmdirSync(join(dir, `${file}.tmp`))
const onDisk = (dir: string, file: string) => existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), "utf8")) : undefined

describe("SettingsStore: failed writes", () => {
  it.effect("a failed save changes nothing in memory; retrying the same secret writes it (it survives a restart)", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const store = yield* openStore(dir)
      block(dir, "settings.json")
      const failed = yield* Effect.result(store.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" }))
      assert.strictEqual(failed._tag, "Failure")
      assert.deepStrictEqual(store.secrets().sections, {}, "the key is not live after a failed save")
      assert.deepStrictEqual(store.settings().sections, {}, "nor are the values")
      assert.isUndefined(onDisk(dir, "secrets.json")?.sections?.["language-model"], "the secrets written before the failure were rolled back")

      unblock(dir, "settings.json")
      yield* store.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" })
      assert.deepStrictEqual(store.secrets().sections["language-model"], { ANTHROPIC_API_KEY: "k1" })
      const restarted = yield* openStore(dir)
      assert.deepStrictEqual(restarted.secrets().sections["language-model"], { ANTHROPIC_API_KEY: "k1" })
      assert.deepStrictEqual(restarted.settings().sections["language-model"], { LLM_PROVIDER: "anthropic" })
    }))

  it.effect("a failed secrets write leaves both files and memory as they were; the retry writes both", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const store = yield* openStore(dir)
      yield* store.saveSection("language-model", { LLM_PROVIDER: "fake" }, {})
      block(dir, "secrets.json")
      const failed = yield* Effect.result(store.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" }))
      assert.strictEqual(failed._tag, "Failure")
      assert.deepStrictEqual(onDisk(dir, "settings.json").sections["language-model"], { LLM_PROVIDER: "fake" })
      assert.deepStrictEqual(store.settings().sections["language-model"], { LLM_PROVIDER: "fake" })
      unblock(dir, "secrets.json")
      yield* store.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" })
      const restarted = yield* openStore(dir)
      assert.deepStrictEqual(restarted.secrets().sections["language-model"], { ANTHROPIC_API_KEY: "k1" })
      assert.deepStrictEqual(restarted.settings().sections["language-model"], { LLM_PROVIDER: "anthropic" })
    }))

  it.effect("a module secret that failed to save is written by the retry", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const store = yield* openStore(dir)
      block(dir, "settings.json")
      const record = { enabled: true, settings: { greeting: "hoi" }, secrets: { token: "t1" } }
      assert.strictEqual((yield* Effect.result(store.saveModule("greeter", record)))._tag, "Failure")
      unblock(dir, "settings.json")
      yield* store.saveModule("greeter", record)
      assert.deepStrictEqual((yield* openStore(dir)).secrets().modules.greeter, { token: "t1" })
    }))
})

describe("Sections: concurrent saves", () => {
  it.effect("two concurrent updates of one section both survive (read, modify and save are serialised)", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const store = yield* openStore(dir)
      const sections = makeSections(store, {})
      const results = yield* Effect.all([
        sections.update("listening", { values: { STT_SHERPA_FINAL_SILENCE_MS: 700 }, secrets: {} }),
        sections.update("listening", { values: { STT_SHERPA_EAGER_SILENCE_MS: 300 }, secrets: {} })
      ], { concurrency: 2 })
      assert.isTrue(results.every((r) => r.result.ok))
      const saved = onDisk(dir, "settings.json").sections.listening
      assert.deepStrictEqual(saved, { STT_SHERPA_FINAL_SILENCE_MS: 700, STT_SHERPA_EAGER_SILENCE_MS: 300 })
    }))
})

describe("SettingsStore: a save interrupted at any step is undone or completed on restart", () => {
  const committed = { values: { LLM_PROVIDER: "anthropic" }, secrets: { ANTHROPIC_API_KEY: "k-old" } }
  /** Clears the secret and changes a non-secret value (the reviewer's case). */
  const next = { values: { LLM_PROVIDER: "fake" }, secrets: {} }
  const restartSees = (dir: string) =>
    Effect.map(openStore(dir), (s) => ({ values: s.settings().sections["language-model"], secrets: s.secrets().sections["language-model"] ?? {} }))
  const copy = (from: string) => {
    const to = fresh()
    cpSync(from, to, { recursive: true })
    // The copy is what a crashed process leaves (its writer.lock is a new file nobody has locked).
    rmSync(join(to, "writer.lock"), { force: true })
    return to
  }

  const failAt = (steps: ReadonlyArray<SaveStep>) =>
    Effect.gen(function*() {
      const dir = fresh()
      const first = yield* openStore(dir)
      yield* first.saveSection("language-model", committed.values, committed.secrets)
      const store = yield* openStore(dir, {
        beforeStep: (step) => {
          if (steps.includes(step)) throw new Error(`injected failure at ${step}`)
        }
      })
      const result = yield* Effect.result(store.saveSection("language-model", next.values, next.secrets))
      return { dir, store, result }
    })

  for (const steps of [["journal"], ["secrets"], ["settings"], ["settings", "rollback"]] as const) {
    it.effect(`failure at ${steps.join(" + ")}: the save fails, memory and a restart both keep the committed state`, () =>
      Effect.gen(function*() {
        const { dir, result, store } = yield* failAt(steps)
        assert.strictEqual(result._tag, "Failure")
        assert.deepStrictEqual(store.secrets().sections["language-model"], committed.secrets)
        assert.deepStrictEqual(yield* restartSees(dir), committed)
        // ... and the restart cleaned up: a second restart sees the same.
        assert.deepStrictEqual(yield* restartSees(dir), committed)
      }))
  }

  it.effect("after a failed rollback, a later save that changes only one file still survives a restart", () =>
    Effect.gen(function*() {
      const failing = { on: true }
      const dir = fresh()
      yield* (yield* openStore(dir)).saveSection("language-model", committed.values, committed.secrets)
      const store = yield* openStore(dir, {
        beforeStep: (step) => {
          if (failing.on && (step === "settings" || step === "rollback")) throw new Error(`injected failure at ${step}`)
        }
      })
      assert.strictEqual((yield* Effect.result(store.saveSection("language-model", next.values, next.secrets)))._tag, "Failure")
      failing.on = false
      // The secrets file already holds this save's secrets (the failed rollback): only the settings file differs.
      yield* store.saveSection("language-model", { LLM_PROVIDER: "openai-compatible" }, next.secrets)
      assert.deepStrictEqual(yield* restartSees(dir), { values: { LLM_PROVIDER: "openai-compatible" }, secrets: {} })
    }))

  it.effect("failure removing the journal after both files were written: the save succeeded, and a restart keeps it", () =>
    Effect.gen(function*() {
      const { dir, result, store } = yield* failAt(["journal-remove"])
      assert.strictEqual(result._tag, "Success")
      assert.deepStrictEqual(store.secrets().sections["language-model"], undefined)
      assert.deepStrictEqual(yield* restartSees(dir), next)
    }))

  it.effect("a crash between any two steps: a restart loads either the committed state or the new one, never a mix", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const first = yield* openStore(dir)
      yield* first.saveSection("language-model", committed.values, committed.secrets)
      const crashes: Array<{ step: SaveStep; dir: string }> = []
      const store = yield* openStore(dir, { beforeStep: (step) => void crashes.push({ step, dir: copy(dir) }) })
      yield* store.saveSection("language-model", next.values, next.secrets)
      assert.deepStrictEqual(crashes.map((c) => c.step), ["journal", "secrets", "settings", "journal-remove"])
      for (const crash of crashes) {
        const seen = yield* restartSees(crash.dir)
        assert.deepStrictEqual(seen, crash.step === "journal-remove" ? next : committed, `crash before ${crash.step}`)
      }
    }))

  it.effect("every file holding a secret is created 0600, even over a stale world-readable temporary file", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const seen: Array<string> = []
      writeFileSync(join(dir, "secrets.json.tmp"), "stale", { mode: 0o644 })
      chmodSync(join(dir, "secrets.json.tmp"), 0o644)
      const store = yield* openStore(dir, {
        beforeStep: () => {
          for (const name of readdirSync(dir)) if (/secret|journal/.test(name)) seen.push(`${name} ${(statSync(join(dir, name)).mode & 0o777).toString(8)}`)
        }
      })
      yield* store.saveSection("language-model", committed.values, committed.secrets)
      for (const name of readdirSync(dir)) if (/secret|journal/.test(name)) seen.push(`${name} ${(statSync(join(dir, name)).mode & 0o777).toString(8)}`)
      assert.isTrue(seen.length > 0)
      assert.deepStrictEqual(seen.filter((entry) => !entry.endsWith(" 600") && !entry.startsWith("secrets.json.tmp ")), [], seen.join(", "))
      assert.isFalse(existsSync(join(dir, "secrets.json.tmp")), "no temporary file left behind")
      assert.strictEqual(statSync(join(dir, "secrets.json")).mode & 0o777, 0o600)
    }))
})

describe("SettingsStore: a read-only load sees one save, never a mix (the CLI beside a running server)", () => {
  const sectionOf = (store: { settings: () => any; secrets: () => any }) => ({
    provider: store.settings().sections["language-model"]?.LLM_PROVIDER,
    key: store.secrets().sections["language-model"]?.ANTHROPIC_API_KEY
  })
  const states = [{ provider: "anthropic", key: "k1" }, { provider: "openai-compatible", key: "k2" }, { provider: "fake", key: "k3" }]

  it.effect("a complete save between the reader's settings read and its secrets read: the reader reads again and gets one save", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const writer = yield* openStore(dir)
      yield* writer.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" })
      const reads: Array<string> = []
      const reader = yield* loadSettingsStore(dir, {
        readOnly: true,
        afterRead: async (file, attempt) => {
          reads.push(`${attempt}:${file}`)
          if (file === "settings" && attempt === 0) {
            // The reviewer's case: old settings read; the writer completes a whole transaction; then secrets.
            await Effect.runPromise(writer.saveSection("language-model", { LLM_PROVIDER: "openai-compatible" }, { ANTHROPIC_API_KEY: "k2" }))
          }
        }
      })
      assert.deepStrictEqual(sectionOf(reader), { provider: "openai-compatible", key: "k2" })
      assert.include(reads, "1:settings", "it read again")
    }))

  it.effect("saves at every point of the read, many times: every result is one committed save", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const writer = yield* openStore(dir)
      yield* writer.saveSection("language-model", { LLM_PROVIDER: states[0]!.provider }, { ANTHROPIC_API_KEY: states[0]!.key })
      let n = 0
      for (const point of ["journal", "settings", "secrets", "journal-again"] as const) {
        for (let i = 0; i < 6; i++) {
          const reader = yield* loadSettingsStore(dir, {
            readOnly: true,
            afterRead: async (file, attempt) => {
              if (file !== point || attempt > 1) return
              const s = states[++n % states.length]!
              await Effect.runPromise(writer.saveSection("language-model", { LLM_PROVIDER: s.provider }, { ANTHROPIC_API_KEY: s.key }))
            }
          })
          // A save that ends before the reader has read both files is what it returns; one that ends after, the one before.
          const expected = point === "journal" || point === "settings" ? states[n % states.length] : states[(n - 1) % states.length]
          assert.deepStrictEqual(sectionOf(reader), expected, `${point} #${i}`)
        }
      }
    }))

  it.effect("a save half done (journal, new secrets, old settings) while the reader reads: it gets the state before the save", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const writer = yield* openStore(dir)
      yield* writer.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" })
      // A crash in the middle of the second save: copy the directory as it is before the settings write.
      let midSave: string | undefined
      const writer2 = yield* openStore(dir, {
        beforeStep: (step) => {
          if (step === "settings" && midSave === undefined) {
            midSave = fresh()
            cpSync(dir, midSave, { recursive: true })
          }
        }
      })
      yield* writer2.saveSection("language-model", { LLM_PROVIDER: "fake" }, { ANTHROPIC_API_KEY: "k3" })
      const seen = yield* loadSettingsStore(midSave!, { readOnly: true })
      assert.deepStrictEqual(sectionOf(seen), { provider: "anthropic", key: "k1" })
      assert.isTrue(existsSync(join(midSave!, "transaction.json")), "left for the writer")
    }))

  it.effect("a journal that appears or disappears during the read makes it read again", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const writer = yield* openStore(dir)
      yield* writer.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" })
      const journal = JSON.stringify({ version: 1, prior: { settings: readFileSync(join(dir, "settings.json"), "utf8"), secrets: readFileSync(join(dir, "secrets.json"), "utf8") }, next: { settings: readFileSync(join(dir, "settings.json"), "utf8"), secrets: readFileSync(join(dir, "secrets.json"), "utf8") } })
      const attempts: Array<number> = []
      yield* loadSettingsStore(dir, {
        readOnly: true,
        afterRead: (file, attempt) => {
          if (file !== "journal") return
          attempts.push(attempt)
          if (attempt === 0) writeFileSync(join(dir, "transaction.json"), journal)
          if (attempt === 1) rmSync(join(dir, "transaction.json"))
        }
      })
      assert.deepStrictEqual(attempts, [0, 1, 2])
    }))

  it.effect("files that stay from two saves, or that never stop changing: the reader fails (bounded), never returns a mix", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const writer = yield* openStore(dir)
      yield* writer.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k1" })
      const oldSettings = readFileSync(join(dir, "settings.json"), "utf8")
      yield* writer.saveSection("language-model", { LLM_PROVIDER: "fake" }, { ANTHROPIC_API_KEY: "k2" })
      writeFileSync(join(dir, "settings.json"), oldSettings) // two saves, no journal (what a damaged journal leaves)
      const stuck = yield* Effect.result(loadSettingsStore(dir, { readOnly: true, snapshotAttempts: 3 }))
      assert.strictEqual(stuck._tag, "Failure")
      if (stuck._tag === "Failure") assert.include(stuck.failure.message, "come from two different saves")
      let n = 0
      const busy = yield* Effect.result(loadSettingsStore(dir, {
        readOnly: true,
        snapshotAttempts: 3,
        afterRead: async (file) => {
          if (file === "settings") {
            const s = states[++n % states.length]!
            await Effect.runPromise(writer.saveSection("language-model", { LLM_PROVIDER: s.provider }, { ANTHROPIC_API_KEY: s.key }))
          }
        }
      }))
      assert.strictEqual(busy._tag, "Failure")
      if (busy._tag === "Failure") assert.include(busy.failure.message, "kept changing")
    }))

  it.effect("every save writes both files with one new revision; a save that changes nothing writes nothing", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const writer = yield* openStore(dir)
      yield* writer.saveSection("language-model", { LLM_PROVIDER: "anthropic" }, {})
      const r1 = onDisk(dir, "settings.json").revision
      assert.isNumber(r1)
      assert.strictEqual(onDisk(dir, "secrets.json").revision, r1)
      yield* writer.saveSection("language-model", { LLM_PROVIDER: "fake" }, {})
      const r2 = onDisk(dir, "settings.json").revision
      assert.isAbove(r2, r1)
      assert.strictEqual(onDisk(dir, "secrets.json").revision, r2)
      const before = statSync(join(dir, "settings.json")).ino
      yield* writer.saveSection("language-model", { LLM_PROVIDER: "fake" }, {})
      assert.strictEqual(statSync(join(dir, "settings.json")).ino, before, "not rewritten")
    }))
})
