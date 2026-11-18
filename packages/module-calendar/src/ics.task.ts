// ics.task.ts: one calendar file read into its occurrences, off the main thread (docs/MODULES.md §15, `offThread`).
// One pure function, plain data in and out; nothing shared between calls, no network, no store. It runs in a fresh
// worker thread for each call (`provider.ts`), with a real time limit, a memory limit and a bounded answer. Its input
// is one flat record, and its answer one string of JSON lines (`answer.ts`), which crosses at the cost of its bytes.
import ICAL from "ical.js"
import { encodeAnswer, fromTaskInput, type TaskInput } from "./answer.ts"
import { expandCalendar } from "./expand.ts"

export default (input: TaskInput): string => encodeAnswer(expandCalendar(ICAL, fromTaskInput(input)))
