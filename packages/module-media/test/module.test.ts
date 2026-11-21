// The scaffold's test (docs/MODULES.md, "Testing"): the real module host accepts every module of the package, it is
// off for an installation that has not switched it on, and it passes the conformance check, with a secret given.
import { describe, it } from "@effect/vitest"
import { checkModule, expectOffByDefault } from "@pva/core/testing"
import { Effect } from "effect"
import { catalog, mediaModule, texts } from "../src/index.ts"

describe("@pva/module-media", () => {
  it.effect("media: accepted by the host, off by default, conformant", () =>
    Effect.gen(function*() {
      yield* expectOffByDefault(catalog)
      for (const definition of catalog) yield* checkModule(definition, { texts })
    }))

  it.effect("conformant with its settings and secret given, and the web search stub away", () =>
    checkModule(mediaModule(), { texts, settings: { spotifyClientId: "client1234" }, secrets: { spotifyClientSecret: "client-secret-s3cret" } }))
})
