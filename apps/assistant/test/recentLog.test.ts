// The recent warnings and errors a report attaches (apps/assistant/src/recentLog.ts): only warning level and above, one
// line each, cut to a length, the newest `MAX_LINES` kept.
import { Effect, Logger } from "effect"
import { describe, expect, it } from "vitest"
import { MAX_LINE_CHARS, MAX_LINES, recentWarnings, recentWarningsLogger } from "../src/recentLog.ts"

describe("the recent warnings", () => {
  it("keeps warnings and errors, not information, one line each, bounded", async () => {
    const before = recentWarnings().length
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logInfo("not kept")
        yield* Effect.logWarning("a warning\non two lines")
        yield* Effect.logError("an error", "x".repeat(2 * MAX_LINE_CHARS))
      }).pipe(Effect.provide(Logger.layer([recentWarningsLogger])))
    )
    const kept = recentWarnings().slice(before)
    expect(kept.map((l) => l.level)).toEqual(["warning", "error"])
    expect(kept[0]?.text).toBe("a warning on two lines")
    expect(kept[1]!.text.length).toBeLessThanOrEqual(MAX_LINE_CHARS)
    await Effect.runPromise(
      Effect.forEach(Array.from({ length: MAX_LINES + 10 }, (_, i) => i), (i) => Effect.logWarning(`line ${i}`)).pipe(Effect.provide(Logger.layer([recentWarningsLogger])))
    )
    const all = recentWarnings()
    expect(all).toHaveLength(MAX_LINES)
    expect(all.at(-1)?.text).toBe(`line ${MAX_LINES + 9}`)
  })
})
