// The reading task's answer: one string of JSON lines, read on the main thread in batches with a real yield between
// them. A line it cannot read fails the whole answer; nothing of it is used.
import { assert, describe, it } from "@effect/vitest"
import { offThread, offThreadTask } from "@pva/core"
import { Effect, Exit } from "effect"
import { encodeAnswer, readAnswer, taskInput } from "../src/answer.ts"
import type { Occ } from "../src/expand.ts"
import { LIMITS } from "../src/provider.ts"
import { instantOf } from "../src/time.ts"
import { AMS, ics } from "./fixtures.ts"

const occ = (i: number, over: Partial<Occ> = {}): Occ => ({
  key: i.toString(16).padStart(24, "0"),
  start: 1_795_000_000_000 + i * 60_000,
  end: 1_795_000_000_000 + i * 60_000 + 1_800_000,
  allDay: false,
  first: 20261119,
  last: 20261119,
  beyond: false,
  // Two-byte text at the bounds: the largest a line can be.
  title: "ŝ".repeat(LIMITS.titleChars),
  location: "ĝ".repeat(LIMITS.placeChars),
  busy: true,
  ...over
})

const WINDOW = { from: instantOf({ year: 2026, month: 11, day: 17 }, AMS), to: instantOf({ year: 2027, month: 1, day: 20 }, AMS) }

describe("calendar: the reading task's answer", () => {
  it.effect("an answer with a line it cannot read, a wrong count, a field out of bounds or anything after the last line is refused whole", () =>
    Effect.gen(function*() {
      const good = encodeAnswer({ ok: true, occurrences: [occ(1), occ(2)], unreadable: 0 })
      assert.isTrue(Exit.isSuccess(yield* Effect.exit(readAnswer(good, LIMITS))))
      const lines = good.split("\n")
      const bad = [
        [...lines.slice(0, 2), lines[2]!.slice(0, -3)].join("\n"),
        lines.slice(0, 2).join("\n"),
        `${good}\n${lines[2]}`,
        good.replace("\"busy\":true", "\"busy\":\"yes\""),
        good.replace(/"key":"0+1"/, "\"key\":\"not a key\""),
        [lines[0], JSON.stringify({ ...occ(1), title: "x".repeat(LIMITS.titleChars + 1) }), lines[2]].join("\n"),
        [lines[0], JSON.stringify({ ...occ(1), extra: 1 }), lines[2]].join("\n"),
        JSON.stringify({ ok: true, count: LIMITS.occurrences + 1, unreadable: 0 }),
        JSON.stringify({ ok: false, reason: "something else" }),
        "not json"
      ]
      for (const text of bad) assert.isTrue(Exit.isFailure(yield* Effect.exit(readAnswer(text, LIMITS))), text.slice(0, 80))
      assert.deepStrictEqual(yield* readAnswer(encodeAnswer({ ok: false, reason: "too-many" }), LIMITS), { ok: false, reason: "too-many" })
    }))

  it.effect("through a real worker: the input is one flat record, the answer one string, larger than a structure may be", () =>
    Effect.gen(function*() {
      const task = offThreadTask<typeof import("../src/ics.task.ts").default>(new URL("../src/ics.task.ts", import.meta.url))
      const text = ics(Array.from({ length: 46 }, (_, i) => ({ uid: `s${i}`, summary: `${"ŝ".repeat(110)} ${i}`, location: "ĝ".repeat(80), start: "20261118T100000", end: "20261118T103000", tz: AMS, rrule: "FREQ=DAILY" })))
      const input = taskInput({ text, ...WINDOW, zone: AMS, forbidden: ["private-token-0123456789"], limits: LIMITS })
      for (const v of Object.values(input)) assert.include(["string", "number"], typeof v)
      const answer = yield* offThread(task, input, { timeoutMs: 10_000, maxResultBytes: 4 * 1024 * 1024 })
      assert.strictEqual(typeof answer, "string")
      // Well over the 128 KiB a structured answer may be.
      assert.isAbove(answer.length * 2, 128 * 1024)
      const read = yield* readAnswer(answer, LIMITS)
      assert.isTrue(read.ok)
      // From 18 November to the window's last day, 19 January: 63 days of each series.
      if (read.ok) assert.strictEqual(read.occurrences.length, 46 * 63)
    }), 60_000)
})
