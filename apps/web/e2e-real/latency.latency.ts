// §6.3 step 6: latency through the browser path. Ten spoken turns (the five bench questions twice)
// with the fake model simulated at 300 ms to first token, as `bench --live` measures the CLI.
//
// Per turn, on the page's own clock (performance.now):
//   speech end   = send time of the last loud microphone frame of the question
//   play         = when the page sent playback.started (its player handed the first sample to the device)
//   audible      = play + the outputLatency the browser reports
// plus the server's trace (endOfTurn → playbackStart). Results: test-results/real/latency.json.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type Assistant,
  chromiumArgsFor,
  expect,
  expectVisualState,
  here,
  messages,
  micStats,
  micWav,
  missingPrerequisite,
  question,
  type Segment,
  silence,
  startAssistant,
  test,
  turnEnds,
  waitForMessage
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

const TURNS = 10
const segments: Array<Segment> = [silence(1500)]
for (let i = 0; i < TURNS; i++) segments.push(question(((i % 5) + 1) as 1 | 2 | 3 | 4 | 5), silence(7000))
const wav = missing === undefined ? micWav("latency-10", segments) : ""
test.use({ launchOptions: { args: chromiumArgsFor(wav) } })

let assistant: Assistant
test.beforeAll(async () => {
  assistant = await startAssistant({
    port: 8797,
    dataDir: join(here, "../test-results/real/data-latency"),
    env: { BENCH_LLM_FIRST_TOKEN_MS: process.env.BENCH_LLM_FIRST_TOKEN_MS ?? "300" }
  })
})
test.afterAll(async () => {
  await assistant?.stop()
})

const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

test(`${TURNS} spoken turns through the browser: end of speech → playback started / audible`, async ({ page }) => {
  await page.goto(assistant.url)
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await waitForMessage(page, (m) => m.msg.type === "turn.end" && m.msg.turnId === TURNS, { timeout: TURNS * 12_000 })

  const log = await messages(page)
  const { speechEnds } = await micStats(page)
  const ends = await turnEnds(page)
  const rows = ends.map((end) => {
    const started = log.find((m) => m.msg.type === "playback.started" && m.msg.turnId === end.turnId)!
    const turnStart = log.find((m) => m.msg.type === "turn.start" && m.msg.turnId === end.turnId)!
    const replyStart = log.find((m) => m.msg.type === "reply.start" && m.msg.turnId === end.turnId)!
    const speechEnd = Math.max(...speechEnds.filter((t) => t < turnStart.at))
    const outputLatencyMs = started.msg.outputLatencyMs as number
    return {
      turn: end.turnId,
      text: turnStart.msg.userText as string,
      outcome: end.outcome,
      speculative: end.trace.speculative,
      tools: (end.trace as unknown as { tools: Array<{ name: string }> }).tools.map((t) => t.name).join(","),
      // From the end of the user's speech (page clock):
      turnStart: Math.round(turnStart.at - speechEnd),
      replyStart: Math.round(replyStart.at - speechEnd),
      play: Math.round(started.at - speechEnd),
      audible: Math.round(started.at - speechEnd + outputLatencyMs),
      // Inside the page: reply.start received → playback.started sent.
      pageStart: Math.round(started.at - replyStart.at),
      outputLatencyMs,
      startDelayMs: started.msg.startDelayMs as number,
      // Server trace, relative to endOfTurn:
      traceFirstToken: end.trace.marks.llmFirstToken,
      traceTtsAudio: end.trace.marks.ttsFirstAudio,
      tracePlaybackStart: end.trace.marks.playbackStart
    }
  })
  console.table(rows.map(({ text, ...r }) => ({ ...r, text: text.slice(0, 28) })))
  const summary = {
    turns: rows.length,
    play: { median: median(rows.map((r) => r.play)), worst: Math.max(...rows.map((r) => r.play)) },
    audible: { median: median(rows.map((r) => r.audible)), worst: Math.max(...rows.map((r) => r.audible)) },
    turnStart: { median: median(rows.map((r) => r.turnStart)), worst: Math.max(...rows.map((r) => r.turnStart)) },
    pageStart: { median: median(rows.map((r) => r.pageStart)), worst: Math.max(...rows.map((r) => r.pageStart)) },
    outputLatencyMs: { median: median(rows.map((r) => r.outputLatencyMs)), worst: Math.max(...rows.map((r) => r.outputLatencyMs)) },
    tracePlaybackStart: { median: median(rows.map((r) => r.tracePlaybackStart ?? NaN)), worst: Math.max(...rows.map((r) => r.tracePlaybackStart ?? NaN)) }
  }
  console.log(JSON.stringify(summary, null, 1))
  writeFileSync(join(here, "../test-results/real/latency.json"), JSON.stringify({ summary, rows }, null, 1))

  expect(rows.length).toBe(TURNS)
  expect(rows.every((r) => r.outcome === "completed")).toBe(true)
  expect(log.filter((m) => m.msg.type === "error")).toEqual([])
})
