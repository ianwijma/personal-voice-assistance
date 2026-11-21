// The scaffold's test (docs/MODULES.md, "Testing"): the real module host accepts the module, it is off for an
// installation that has not switched it on, and it passes the conformance check, with and without a token and with
// sending at once.
import { describe, it } from "@effect/vitest"
import { checkModule, expectOffByDefault } from "@pva/core/testing"
import { Effect } from "effect"
import { catalog, reportModule, texts } from "../src/index.ts"

describe("@pva/module-report", () => {
  it.effect("report: accepted by the host, off by default, conformant", () =>
    Effect.gen(function*() {
      yield* expectOffByDefault(catalog)
      yield* checkModule(reportModule, { texts })
      yield* checkModule(reportModule, { texts, secrets: { githubToken: "github_pat_conformance_test_token_0001" }, settings: { sendImmediately: true } })
    }))
})
