// The scaffold's test (docs/MODULES.md, "Testing"): the real module host accepts every module of the package, it is
// off for an installation that has not switched it on, and it passes the conformance check.
import { describe, it } from "@effect/vitest"
import { checkModule, expectOffByDefault } from "@pva/core/testing"
import { Effect } from "effect"
import { catalog } from "../src/index.ts"

describe("@pva/module-lists", () => {
  it.effect("lists: accepted by the host, off by default, conformant", () =>
    Effect.gen(function*() {
      yield* expectOffByDefault(catalog)
      for (const definition of catalog) yield* checkModule(definition)
    }))
})
