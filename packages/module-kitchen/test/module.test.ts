// The scaffold's test (docs/MODULES.md, "Testing"): the real module host accepts every module of the package, it is
// off for an installation that has not switched it on, and it passes the conformance check, alone and with a stub of
// the lists module's service published beside it (as the kitchen finds it in serve mode).
import { describe, it } from "@effect/vitest"
import { checkModule, expectOffByDefault, provide, stubService } from "@pva/core/testing"
import { Lists, type ListsService } from "@pva/module-contracts"
import { Effect } from "effect"
import { catalog, kitchenModule, texts } from "../src/index.ts"

describe("@pva/module-kitchen", () => {
  it.effect("kitchen: accepted by the host, off by default, conformant", () =>
    Effect.gen(function*() {
      yield* expectOffByDefault(catalog)
      for (const definition of catalog) yield* checkModule(definition)
    }))

  it.effect("kitchen: conformant with its texts in both languages", () => checkModule(kitchenModule, { texts }))

  it.effect("kitchen: conformant with the lists module's service published beside it", () =>
    // The start calls no list method, so the stub has no answers programmed: any call while starting fails the test.
    checkModule(kitchenModule, { texts, provide: [provide("lists", { services: [Lists.of(stubService<ListsService>("lists", {}).service)] })] }))
})
