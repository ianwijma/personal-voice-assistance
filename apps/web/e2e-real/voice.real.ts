// §6.3 step 2: a whole spoken turn through the real assistant.
import { join } from "node:path"
import {
  type Assistant,
  chromiumArgsFor,
  expect,
  expectVisualState,
  here,
  loginAdmin,
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

test("a spoken turn: listening → hearing → thinking → speaking → listening, transcript and reply in the chat, latency in admin", async ({ page }) => {
  // What the page asked the microphone for, and what the browser then reports (echo cancellation).
  await page.addInitScript(() => {
    const w = window as unknown as { __gum: Array<{ asked: unknown; got: unknown }> }
    w.__gum = []
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (c) => {
      const stream = await original(c)
      const asked = typeof c?.audio === "object" ? (c.audio as MediaTrackConstraints).echoCancellation : undefined
      w.__gum.push({ asked: typeof asked === "object" && asked !== null && "exact" in asked ? asked.exact : asked, got: stream.getAudioTracks()[0]?.getSettings().echoCancellation })
      return stream
    }
  })
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
  expect((await turnEnds(page)).length).toBe(1)

  // This device's audio report (the help dialog, `?`): the reply that just played, counted.
  await page.keyboard.press("Escape")
  await page.keyboard.press("?")
  const help = page.getByTestId("help-dialog")
  await expect(help.getByTestId("audio-report")).toContainText("1 reply played")
  await page.keyboard.press("Escape")

  // The latency of that turn: in admin › Diagnostics › Latency (the voice page no longer shows it).
  const admin = await page.context().newPage()
  await loginAdmin(admin, assistant.url, "#settings/diagnostics/latency")
  const latency = admin.getByTestId("page-diagnostics-latency")
  await expect(latency).toContainText(/median \d+ ms/)
  await expect(latency.locator("tbody tr")).toHaveCount(1)
  await expect(latency.locator("tbody tr").first()).toContainText("completed")

  // Echo cancellation is a device setting: switched off in admin (Devices › Every browser), the open voice page
  // re-opens its microphone with it off, as the browser then reports.
  await admin.evaluate(() => { location.hash = "#settings/devices/type-web-voice" })
  await admin.getByTestId("group-audio").locator("summary").click()
  await admin.getByRole("switch", { name: "Echo cancellation" }).click()
  await admin.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
  await expect(admin.getByTestId("footer-note")).toContainText("Saved")
  await expect.poll(() => page.evaluate(() => (window as unknown as { __gum: Array<{ asked: unknown; got: unknown }> }).__gum.at(-1)), { timeout: 10_000 })
    .toEqual({ asked: false, got: false })
  const gum = await page.evaluate(() => (window as unknown as { __gum: Array<{ asked: unknown; got: unknown }> }).__gum)
  expect(gum.length).toBe(2) // Start, then the re-open
  expect(gum[0]).toEqual({ asked: true, got: true })
  await expectVisualState(page, "listening")
  await admin.close()
})
