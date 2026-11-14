import { appUrl, expect, expectVisualState, mock, test } from "./fixtures.ts"

test.beforeEach(async () => {
  await mock.scenario("voice")
})

test("start, then a whole spoken exchange: listening → hearing → thinking → speaking → listening", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await expectVisualState(page, "not-started")
  await expect(page.getByTestId("state-label")).toHaveText(/not started/i)
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await expect(page.getByTestId("mic-toggle")).toBeVisible()

  await expectVisualState(page, "hearing")
  await expect(page.getByTestId("captions")).toContainText("what's the weather")
  await expectVisualState(page, "thinking")
  await expectVisualState(page, "speaking")
  await expect(page.getByTestId("state-label")).toHaveText(/speaking/i)
  await expect(page.getByTestId("captions")).toContainText("sunny in Paris")
  await expectVisualState(page, "listening", 15_000)

  // The mock heard the microphone and the player's reports (the player worklet really ran).
  const log = await mock.log()
  const types = log.messages.map((m) => m.type)
  expect(types).toContain("audio.claim")
  expect(types).toContain("playback.started")
  expect(types).toContain("playback.finished")
  expect(types.filter((t) => t === "playback.progress").length).toBeGreaterThan(5)
  const started = log.messages.find((m) => m.type === "playback.started")!
  const finished = log.messages.find((m) => m.type === "playback.finished")!
  expect(finished.playedSamples).toBeGreaterThan(22_050 * 4)
  expect(started.startDelayMs).toBeGreaterThanOrEqual(0)
  const mic = log.mic.find((x) => x.owner)!
  expect(mic.frames).toBeGreaterThan(100) // 20 ms frames for several seconds
  expect(mic.gaps).toBe(0)
  expect(log.messages.some((m) => m.type === "mic.bad-size")).toBe(false)

  // The voice front end has no latency readout (that is admin › Diagnostics).
  await expect(page.getByTestId("latency-readout")).toHaveCount(0)
})

test("Stop silences the reply at once and the chat shows the interrupted reply", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "speaking", 10_000)
  await page.waitForTimeout(400)
  await page.getByTestId("stop").click()
  await expect(page.getByTestId("stage")).not.toHaveAttribute("data-visual-state", "speaking", { timeout: 2000 })
  await expectVisualState(page, "listening")
  const log = await mock.log()
  const interrupt = log.messages.find((m) => m.type === "interrupt")
  const stopped = log.messages.filter((m) => m.type === "playback.stopped")
  expect(interrupt?.turnId).toBeGreaterThan(0)
  expect(stopped.length).toBeGreaterThanOrEqual(1)
  expect(stopped[0]!.turnId).toBe(interrupt!.turnId)
  expect(stopped[0]!.playedSamples).toBeGreaterThan(0)
  // Every stopped report carries the same final count (the late reply.stop is answered again).
  expect(new Set(stopped.map((m) => m.playedSamples)).size).toBe(1)
  expect(log.messages.some((m) => m.type === "playback.finished")).toBe(false)

  await page.getByTestId("chat-toggle").click()
  const reply = page.getByTestId("turn").last()
  await expect(reply).toHaveAttribute("data-outcome", "interrupted")
  await expect(reply.getByTestId("interrupted-tag")).toBeVisible()
  await expect(reply.locator("[data-played]")).toHaveCount(1) // only the first clause had started playing
})

test("Esc stops the reply too", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "speaking", 10_000)
  await page.keyboard.press("Escape")
  await expectVisualState(page, "listening")
  expect((await mock.log()).messages.some((m) => m.type === "interrupt")).toBe(true)
})

test("M mutes and unmutes the microphone", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await page.keyboard.press("m")
  await expectVisualState(page, "muted")
  await expect(page.getByTestId("state-label")).toHaveText(/mic off/i)
  await expect(page.getByTestId("mic-toggle")).toHaveAttribute("aria-pressed", "false")
  const framesMuted = (await mock.log()).mic.find((x) => x.owner)!.frames
  await page.waitForTimeout(300)
  expect((await mock.log()).mic.find((x) => x.owner)!.frames).toBe(framesMuted) // nothing sent while muted
  await page.keyboard.press("m")
  await expectVisualState(page, "listening")
  const log = await mock.log()
  expect(log.messages.filter((m) => m.type === "mic.state").map((m) => m.live)).toEqual([false, true])
  await expect.poll(async () => (await mock.log()).mic.find((x) => x.owner)!.frames).toBeGreaterThan(framesMuted)
  expect((await mock.log()).mic.find((x) => x.owner)!.gaps).toBe(0) // sequence restarted at 0 after unmuting
})

test("End releases the audio and returns to not started", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await page.getByRole("button", { name: "End" }).click()
  await expectVisualState(page, "not-started")
  await expect(page.getByTestId("start")).toBeVisible()
  expect((await mock.log()).messages.some((m) => m.type === "audio.release")).toBe(true)
})

test("a denied microphone shows the reason and Try again", async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"))
  })
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("start")).toBeVisible()
  const labelY = async () => Math.round((await page.getByTestId("state-label").boundingBox())!.y)
  const before = await labelY()
  await page.getByTestId("start").click()
  await expectVisualState(page, "error")
  await expect(page.getByTestId("audio-error")).toContainText("Microphone permission was denied")
  await expect(page.getByTestId("audio-error")).toContainText("then press Try again")
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()
  // No layout shift between states: the line and its label stay where they were.
  expect(await labelY()).toBe(before)
  await expect(page.getByTestId("state-label")).toHaveText("Audio error")
  await expect(page.getByTestId("connection-status")).toHaveText("")
  expect((await mock.log()).messages.some((m) => m.type === "audio.claim")).toBe(false)
})

test("the media-element output path also plays the reply and reports it", async ({ page, baseURL }) => {
  await mock.defaults({ outputPath: "element" }) // a device-profile field since protocol 5
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "speaking", 10_000)
  await expectVisualState(page, "listening", 15_000)
  const log = await mock.log()
  expect(log.messages.find((m) => m.type === "audio.claim")!.audio).toMatchObject({ outputPath: "element" })
  expect(log.messages.some((m) => m.type === "playback.finished")).toBe(true)
})
