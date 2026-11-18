// ics.task.ts: one calendar file read into its occurrences, off the main thread (docs/MODULES.md §15, `offThread`).
// One pure function, plain data in and out; nothing shared between calls, no network, no store. It runs in a fresh
// worker thread for each call (`provider.ts`), with a real time limit, a memory limit and a bounded answer.
import ICAL from "ical.js"
import { type ExpandInput, type ExpandOutput, expandCalendar } from "./expand.ts"

export default (input: ExpandInput): ExpandOutput => expandCalendar(ICAL, input)
