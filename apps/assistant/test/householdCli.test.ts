// The CLI modes' household (docs/STORING-DATA.md "CLI modes"): read-only, and a warning when there is no file yet and
// a module keeps data (it reads an empty store then); no warning when no module keeps data.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection, defineModule } from "@pva/core"
import { Effect, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCliHousehold } from "../src/serve/household.ts"

const notes = defineCollection({ name: "notes", scope: "household", schema: Schema.Struct({ text: Schema.String }) })
const keeper = defineModule({ apiVersion: 2, id: "keeper", name: "Keeper", description: "", storage: { collections: [notes] }, start: () => Effect.succeed({}) })
const plain = defineModule({ apiVersion: 2, id: "plain", name: "Plain", description: "", start: () => Effect.succeed({}) })

describe("the CLI modes' household", () => {
  it.effect("no file yet: a warning when a module keeps data, an empty read-only store", () =>
    Effect.gen(function*() {
      const lines: Array<string> = []
      const household = yield* openCliHousehold({ dataDir: mkdtempSync(join(tmpdir(), "pva-cli-")), catalog: [keeper], log: (l) => lines.push(l) })
      assert.isTrue(lines.some((l) => l.includes("There is no household data yet")), lines.join("\n"))
      assert.deepStrictEqual(yield* household.store.forModule("keeper").collection(notes).list(), [])
      const write = yield* Effect.exit(household.store.forModule("keeper").collection(notes).insert({ text: "x" }))
      assert.isTrue(write._tag === "Failure")
      const quiet: Array<string> = []
      yield* openCliHousehold({ dataDir: mkdtempSync(join(tmpdir(), "pva-cli-")), catalog: [plain], log: (l) => quiet.push(l) })
      assert.deepStrictEqual(quiet, [])
    }).pipe(Effect.scoped))
})
