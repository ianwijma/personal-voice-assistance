// §6.3 step 2: a whole spoken turn through the real assistant.
import { join } from "node:path"
import {
  type Assistant,
  chromiumArgsFor,
  expect,
  expectVisualState,
  here,
  messages,
  micWav,
  missingPrerequisite,
  question,
  silence,
  startAssistant,
  test,
  turnEnds,
  visualHistory,
  waitForMessage
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

const wav = missing === undefined ? micWav("hello-then-silence", [silence(1500), question(1), silence(12_000)]) : ""
test.use({ launchOptions: { args: chromiumArgsFor(wav) } })

let assistant: Assistant
test.beforeAll(async () => {
  assistant = await startAssistant({ port: 8791, dataDir: join(here, "../test-results/real/data-voice") })
})
test.afterAll(async () => {
  await assistant?.stop()
})

test("a spoken turn: listening → hearing → thinking → speaking → listening, transcript and reply in the chat, latency shown", async ({ page }) => {
  await page.goto(assistant.url)
  await expectVisualState(page, "not-started")
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")

  const end = await waitForMessage(page, (m) => m.dir === "in" && m.msg.type === "turn.end", { timeout: 30_000 })
  await expectVisualState(page, "listening")

  const states = await visualHistory(page)
  const order = ["listening", "hearing", "thinking", "speaking", "listening"]
  let i = 0
  for (const s of states) if (s === order[i]) i++
  expect(i, `visual states seen: ${states.join(" → ")}`).toBe(order.length)

  const log = await messages(page)
  const types = log.map((m) => `${m.dir}:${m.msg.type}`)
  const start = log.find((m) => m.msg.type === "turn.start")!.msg as unknown as { userText: string; source: string; spoken: boolean }
  expect(start).toMatchObject({ source: "voice", spoken: true })
  expect(start.userText).toMatch(/hello.*hear me/i)
  const trace = (end.msg as unknown as { outcome: string; trace: { marks: Record<string, number>; client?: { outputLatencyMs: number } } })
  expect(trace.outcome).toBe("completed")
  expect(trace.trace.marks.playbackStart).toBeDefined()
  expect(trace.trace.client?.outputLatencyMs).toBeGreaterThanOrEqual(0)
  // The headless player really played: started, progress every ~250 ms, finished.
  expect(types).toContain("out:playback.started")
  expect(types).toContain("out:playback.finished")
  const progress = log.filter((m) => m.msg.type === "playback.progress").map((m) => m.at)
  expect(progress.length).toBeGreaterThan(3)
  const gaps = progress.slice(1).map((t, k) => t - progress[k]!)
  expect(Math.max(...gaps)).toBeLessThan(400)
  expect(log.some((m) => m.msg.type === "error")).toBe(false)

  // Chat: the user's words and the reply text.
  await page.getByTestId("chat-toggle").click()
  const turn = page.getByTestId("turn").last()
  await expect(turn).toHaveAttribute("data-outcome", "completed")
  await expect(turn).toContainText(/hello/i)
  await expect(turn.getByTestId("assistant-message")).toContainText(/You said/i)
  await expect(page.getByTestId("latency-readout")).toHaveText(/\d+ ms/)
  expect((await turnEnds(page)).length).toBe(1)

  // This device: the microphone as the browser reports it, and the reply that just played, counted.
  await page.keyboard.press("Escape")
  await page.keyboard.press("o")
  await page.getByRole("tab", { name: "This device" }).click()
  const diagnostics = page.getByTestId("audio-diagnostics")
  await expect(diagnostics.getByTestId("playback-replies")).toHaveText("1")
  await expect(diagnostics.getByTestId("mic-rate")).toContainText("audio context")
  // Turning echo cancellation off re-opens the microphone with it off, as the browser then reports.
  await page.getByTestId("mic-processing").getByRole("switch", { name: "Echo cancellation" }).click()
  await expect(diagnostics).toContainText(/Echo cancellation\s*off \(asked off\)/)
})
