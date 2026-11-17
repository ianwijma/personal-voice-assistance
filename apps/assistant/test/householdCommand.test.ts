// `pnpm start household restore`: it swaps in a checked copy under the writer lock, and an interrupted restore keeps
// the lock until its last file operation has settled, so a server cannot open the database in between.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection } from "@pva/core"
import { makeSqliteStore } from "@pva/store-sqlite"
import { ConfigProvider, Effect, Fiber, Schema } from "effect"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { householdCommand } from "../src/household.ts"
import { acquireDataDirLockSync, HOLDER_FILE, releaseDataDirLock } from "../src/serve/DataDirLock.ts"

const items = defineCollection({ name: "items", scope: "household", schema: Schema.Struct({ text: Schema.String }) })
const inDir = (dir: string) => <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.provideService(effect, ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ PVA_DATA_DIR: dir }))
const texts = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  const out = (db.prepare("SELECT value FROM pva_docs ORDER BY value").all() as Array<{ value: string }>).map((r) => (JSON.parse(r.value) as { text: string }).text)
  db.close()
  return out
}

/** A data directory with a database and a backup of it, then one more row only in the database. */
const setUp = (rows: number) =>
  Effect.scoped(Effect.gen(function*() {
    const dir = mkdtempSync(join(tmpdir(), "pva-restore-"))
    const store = yield* makeSqliteStore({ filename: join(dir, "household.db") })
    yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
    const c = store.forModule("shop").collection(items)
    yield* store.transaction(Effect.forEach(Array.from({ length: rows }, (_, i) => i), (i) => c.insert({ text: `saved ${String(i).padStart(5, "0")} ${"p".repeat(400)}` }), { discard: true }))
    const backup = yield* store.backup()
    yield* c.insert({ text: "after the backup" })
    return { dir, backup: backup.path, file: join(dir, "household.db") }
  }))

describe("household restore", () => {
  it.effect("restores a backup as the database and sets the previous one aside", () =>
    Effect.gen(function*() {
      const { dir, backup, file } = yield* setUp(3)
      yield* householdCommand(["restore", backup]).pipe(inDir(dir))
      assert.isFalse(texts(file).includes("after the backup"))
      assert.strictEqual(texts(file).length, 3)
      const aside = readdirSync(dir).find((n) => n.startsWith("household.db.before-restore-"))
      assert.isDefined(aside)
      assert.isTrue(texts(join(dir, aside!)).includes("after the backup"))
      assert.deepStrictEqual(readdirSync(dir).filter((n) => n.includes(".restore-")), [], readdirSync(dir).join(" "))
    }))

  it.live("an interrupted restore finishes before the lock is released: no server can open the database in between", () =>
    Effect.gen(function*() {
      const { dir, backup, file } = yield* setUp(4000)
      const fiber = yield* Effect.forkChild(householdCommand(["restore", backup]).pipe(inDir(dir)))
      // Once the command holds the lock, interrupt it and, at the same moment, try to take the lock as a server would.
      for (let i = 0; i < 2000 && !existsSync(join(dir, HOLDER_FILE)); i++) yield* Effect.sleep(1)
      const interrupted = yield* Effect.forkChild(Fiber.interrupt(fiber))
      const competing = (() => {
        try {
          releaseDataDirLock(acquireDataDirLockSync(dir).lock)
          return "acquired"
        } catch {
          return "refused"
        }
      })()
      assert.strictEqual(competing, "refused")
      yield* Fiber.join(interrupted)
      yield* Fiber.await(fiber)
      // The restore ran to its end: the backup is the database, whole, and the lock is free again.
      assert.strictEqual(texts(file).length, 4000)
      const { lock } = acquireDataDirLockSync(dir)
      releaseDataDirLock(lock)
      assert.deepStrictEqual(readdirSync(dir).filter((n) => n.includes(".restore-")), [])
    }), { timeout: 30_000 })
})
