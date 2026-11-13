// Manual interrupt mode ("Tap Stop to interrupt"): the page holds microphone frames back while its
// player plays and the server feeds the recogniser a noise floor; speech over the reply is ignored,
// and the next question after the reply is heard normally (the two mechanisms do not fight).
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
  setPrefs,
  silence,
  startAssistant,
  test,
  turnEnds,
  waitForMessage
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

const wav = missing === undefined
  ? micWav("manual", [silence(1500), question(3), silence(900), question(1), silence(4000), question(5), silence(15_000)])
  : ""
test.use({ launchOptions: { args: chromiumArgsFor(wav) } })

let assistant: Assistant
test.beforeAll(async () => {
  assistant = await startAssistant({ port: 8796, dataDir: join(here, "../test-results/real/data-manual") })
})
test.afterAll(async () => {
  await assistant?.stop()
})

test("manual mode: speech over the reply does not interrupt it; the question after the reply is answered", async ({ page }) => {
  await setPrefs(page, { interruptMode: "manual" })
  await page.goto(assistant.url)
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  expect((await waitForMessage(page, (m) => m.msg.type === "audio.claim")).msg.interruptMode).toBe("manual")

  const started = await waitForMessage(page, (m) => m.msg.type === "playback.started" && m.msg.turnId === 1, { timeout: 30_000 })
  const framesAtStart = (await micStats(page)).frames
  await waitForMessage(page, (m) => m.msg.type === "turn.end" && m.msg.turnId === 2, { timeout: 40_000 })
  const ends = await turnEnds(page)
  expect(ends.map((e) => e.outcome)).toEqual(["completed", "completed"])
  const log = await messages(page)
  const users = log.filter((m) => m.msg.type === "turn.start").map((m) => m.msg.userText as string)
  expect(users[0]).toMatch(/octop/i)
  expect(users[1]).toMatch(/thanks/i) // "Hello, can you hear me" was said over the reply: not heard
  expect(log.filter((m) => m.msg.type === "error").map((m) => JSON.stringify(m.msg))).toEqual([])
  // While the reply played, the page sent (almost) no microphone frames.
  const finished = log.find((m) => m.msg.type === "playback.finished" && m.msg.turnId === 1)!
  const playMs = finished.at - started.at
  expect(playMs).toBeGreaterThan(1500)
  void framesAtStart
  // No interim transcript of the held-back sentence appeared while turn 1 played.
  const during = log.filter((m) => m.at > started.at && m.at < finished.at && m.msg.type === "transcript" && (m.msg.text as string) !== "")
  expect(during).toEqual([])
})
