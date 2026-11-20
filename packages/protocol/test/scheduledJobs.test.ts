// The admin list's wire schema carries the scheduler's bounds (docs/SCHEDULING.md "Health and the admin page"): a page
// of at most MAX_SCHEDULED_JOBS_PAGE jobs, texts no longer than the scheduler keeps them, whole non-negative times and
// attempts, a short cursor.
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { MAX_SCHEDULED_JOBS_PAGE, type ScheduledJob, ScheduledJobsResponse } from "../src/index.ts"

const job = (over: Partial<Record<keyof ScheduledJob, unknown>> = {}): Record<string, unknown> => ({
  id: "j".repeat(200),
  module: "m".repeat(40),
  moduleName: "n".repeat(200),
  handler: "h".repeat(64),
  key: "k".repeat(100),
  state: "failed",
  dueAt: 8.64e15,
  cron: "c".repeat(100),
  timeZone: "z".repeat(48),
  late: { withinMs: 8.64e15 },
  origin: { assistantId: "a".repeat(64), deviceId: "d".repeat(64), personId: "p".repeat(64) },
  attempt: 11,
  lastError: "e".repeat(200),
  failedAt: 8.64e15,
  finishedAt: 8.64e15,
  orphaned: false,
  createdAt: 0,
  updatedAt: 8.64e15,
  ...over
})

const decodes = (u: unknown) => Schema.decodeUnknownExit(ScheduledJobsResponse)(u)._tag === "Success"

describe("the scheduled jobs response", () => {
  it("decodes a full page of jobs at every bound, and refuses one past any bound", () => {
    const page = (jobs: ReadonlyArray<unknown>, next: unknown = `live.${"f".repeat(32)}`) => ({ jobs, available: true, next })
    expect(decodes(page(Array.from({ length: MAX_SCHEDULED_JOBS_PAGE }, () => job())))).toBe(true)
    expect(decodes(page(Array.from({ length: MAX_SCHEDULED_JOBS_PAGE + 1 }, () => job())))).toBe(false)
    expect(decodes(page([job()], "x".repeat(65)))).toBe(false)
    for (
      const [field, value] of [
        ["id", "j".repeat(201)],
        ["module", "m".repeat(41)],
        ["moduleName", "n".repeat(201)],
        ["handler", "h".repeat(65)],
        ["key", "k".repeat(101)],
        ["cron", "c".repeat(101)],
        ["timeZone", "z".repeat(49)],
        ["lastError", "e".repeat(201)],
        ["attempt", 1.5],
        ["attempt", -1],
        ["attempt", 12],
        ["dueAt", -1],
        ["dueAt", 0.5],
        ["late", { withinMs: -1 }],
        ["origin", { deviceId: "d".repeat(65) }],
        ["finishedAt", 8.64e15 + 1]
      ] as const
    ) {
      expect(decodes(page([job({ [field]: value })])), `${field} ${JSON.stringify(value).slice(0, 20)}`).toBe(false)
    }
  })
})
