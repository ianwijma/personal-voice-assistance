// The catalogue after the module scaffold (docs/MODULES-PLAN.md §4 P11): every module id the app lists, each new one
// off by default, with its page under docs/modules/; and with every new module off, an existing installation runs
// exactly the modules it ran before (the serve tests show the rest of its behaviour unchanged).
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { makeModuleHost, readOnlyPersistence } from "@pva/core"
import { expectOffByDefault } from "@pva/core/testing"
import { Effect } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { moduleCatalog } from "../src/modules.ts"

const BEFORE = ["clock", "weather", "home-assistant", "claude-subscription"]
const NEW = [
  "assistant-controls",
  "timers",
  "alarms",
  "calculator",
  "knowledge",
  "system-status",
  "web-search",
  "lists",
  "notifications",
  "kitchen",
  "music",
  "reminders",
  "images",
  "calendar",
  "memory",
  "broadcast",
  "briefing",
  "bin-day",
  "presence",
  "news",
  "routines"
]
const docs = join(import.meta.dirname, "..", "..", "..", "docs")

describe("the module catalogue", () => {
  it("lists the modules of before and the scaffold's, once each", () => {
    const ids = moduleCatalog.map((m) => m.id)
    assert.deepStrictEqual([...ids].sort(), [...BEFORE, ...NEW].sort())
    assert.strictEqual(new Set(ids).size, ids.length)
  })

  it.effect("every new module is off by default, in serve mode and in the CLI modes", () => expectOffByDefault(moduleCatalog.filter((m) => NEW.includes(m.id))))

  it.effect("an installation that chose nothing new runs what it ran before", () =>
    Effect.gen(function*() {
      // Nothing saved (a first run, or settings from before the scaffold): the modules that are on by default.
      const host = yield* makeModuleHost({ catalog: moduleCatalog, persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      const on = host.modules().filter((m) => m.enabled).map((m) => m.id)
      assert.deepStrictEqual(on, ["clock", "weather"])
      assert.deepStrictEqual(host.snapshot().parts.map((p) => p.moduleId), ["clock", "weather"])
      // A saved settings file from before: its switches load unchanged, and none of the new modules starts.
      const saved = yield* makeModuleHost({
        catalog: moduleCatalog,
        persistence: readOnlyPersistence({ modules: { clock: { enabled: true }, weather: { enabled: false }, "home-assistant": { enabled: false } }, secrets: {} }),
        env: {}
      })
      yield* saved.startEnabled
      assert.deepStrictEqual(saved.snapshot().parts.map((p) => p.moduleId), ["clock"])
    }))

  it("every module has its page under docs/modules/, linked from docs/MODULES.md", () => {
    const guide = readFileSync(join(docs, "MODULES.md"), "utf8")
    for (const m of moduleCatalog) {
      if (m.id === "claude-subscription") continue
      assert.isTrue(existsSync(join(docs, "modules", `${m.id}.md`)), `docs/modules/${m.id}.md`)
      assert.include(guide, `(modules/${m.id}.md)`, `docs/MODULES.md links docs/modules/${m.id}.md`)
    }
  })
})
