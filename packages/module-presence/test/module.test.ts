// The scaffold's test (docs/MODULES.md, "Testing"): the real module host accepts every module of the package, it is
// off for an installation that has not switched it on, and it passes the conformance check. Presence `uses`
// home-assistant, so the check is given a stand-in of it (the kit's `provide`) with a stub of the contract: its stream
// starts with a snapshot, as every subscription's does, and then waits.
import { describe, it } from "@effect/vitest"
import { checkModule, expectOffByDefault, provide, stubService } from "@pva/core/testing"
import { HomeAssistant, type HomeAssistantService } from "@pva/module-contracts"
import { Effect, Stream } from "effect"
import { catalog, texts } from "../src/index.ts"

describe("@pva/module-presence", () => {
  it.effect("presence: accepted by the host, off by default, conformant", () =>
    Effect.gen(function*() {
      const ha = stubService<HomeAssistantService>("home-assistant", {
        connection: () => "connected",
        entities: () => [],
        entity: () => undefined,
        areas: () => [],
        people: () => [],
        changes: () => Stream.concat(Stream.make({ _tag: "snapshot" as const, reason: "subscribed" as const, connection: "connected" as const, entities: [], areas: [] }), Stream.never)
      })
      yield* expectOffByDefault(catalog)
      for (const definition of catalog) yield* checkModule(definition, { texts, provide: [provide("home-assistant", { services: [HomeAssistant.of(ha.service)] })] })
    }))
})
