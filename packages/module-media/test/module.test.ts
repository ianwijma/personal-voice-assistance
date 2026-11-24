// The scaffold's test (docs/MODULES.md, "Testing"): the real module host accepts every module of the package, it is
// off for an installation that has not switched it on, and it passes the conformance check, with a secret given.
import { assert, describe, it } from "@effect/vitest"
import { checkModule, expectOffByDefault } from "@pva/core/testing"
import { Effect } from "effect"
import { CALLBACK_PATH, catalog, mediaModule, redirectUriOf, SPOTIFY_REDIRECT_COPY, SPOTIFY_SETUP_STEPS, texts } from "../src/index.ts"

describe("@pva/module-media", () => {
  it.effect("media: accepted by the host, off by default, conformant", () =>
    Effect.gen(function*() {
      yield* expectOffByDefault(catalog)
      for (const definition of catalog) yield* checkModule(definition, { texts })
    }))

  it.effect("conformant with its settings and secret given, and the web search stub away", () =>
    checkModule(mediaModule(), { texts, settings: { spotifyClientId: "client1234" }, secrets: { spotifyClientSecret: "client-secret-s3cret" } }))

  it("the Spotify guide is the first Spotify setting, its redirect value is the sign-in's callback path, and the server builds the same address", () => {
    const guide = mediaModule().settings.spotifySetup.describe("spotifySetup")
    assert.strictEqual(guide.type, "info")
    assert.strictEqual(guide.type === "info" ? guide.steps?.length : 0, 7)
    const keys = Object.keys(mediaModule().settings)
    assert.isBelow(keys.indexOf("spotifySetup"), keys.indexOf("spotifyClientId"))
    const redirect = SPOTIFY_SETUP_STEPS.flatMap((s) => s.copy ?? []).find((c) => c.label === "Redirect URI")
    assert.strictEqual(redirect?.value, `{origin}${CALLBACK_PATH}`)
    assert.strictEqual(SPOTIFY_REDIRECT_COPY, redirect?.value)
    // What the page shows for https://home.example is exactly what the server sends Spotify.
    assert.strictEqual(redirect?.value.replace("{origin}", "https://home.example"), redirectUriOf({ scheme: "https", host: "home.example" }))
    assert.strictEqual(redirectUriOf({ scheme: "https", host: "home.example" }), `https://home.example${CALLBACK_PATH}`)
  })
})
