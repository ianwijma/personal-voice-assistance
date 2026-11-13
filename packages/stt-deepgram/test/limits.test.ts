/**
 * Every truncation and inspection limit found in the adapters, with the credential straddling it
 * (fourth review, finding 1; the cases are in `leaks.ts`, `limitCases`), against this adapter's own
 * `src/redact.ts`. The adapter-level leak tests capture logs at every level, debug included
 * (`captureLogs`).
 */
import { describe, expect, it } from "vitest"
import { KEYS, leaksOf, limitCases, partsOf } from "./leaks.ts"

/** 40 characters no generic pattern knows: only the configured-secret match can catch it. */
const PLAIN = "Qk7vR2mX9pL4wT8nB3cZ6hJ1fD5sG0yUeAiOoPxW"

describe("every limit, with the credential straddling it (stt-deepgram)", () => {
  for (const key of [PLAIN, KEYS[0]]) {
    it(`no part of the key survives any limit: ${JSON.stringify(key.slice(0, 6))}…`, async () => {
      const cases = await limitCases(key)
      expect(cases.length).toBeGreaterThan(100)
      for (const [what, text] of cases) {
        expect(leaksOf(key, text), what).toEqual([])
        expect(partsOf(key, text), what).toEqual([])
      }
    })
  }
})
