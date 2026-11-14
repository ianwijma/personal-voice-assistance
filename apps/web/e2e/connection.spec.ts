import { appUrl, expect, expectVisualState, mock, test, visualHistory } from "./fixtures.ts"

test("reconnecting: dashed line and banner, then ownership resumes without a new Start", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await mock.drop()
  await expect.poll(() => visualHistory(page), { timeout: 3000 }).toContain("disconnected")
  await expectVisualState(page, "listening", 5000) // resumed as owner (resumeOwner)
  await expect(page.getByTestId("mic-toggle")).toBeVisible()
  const log = await mock.log()
  // After the resume the page told the server its audio setup and microphone state.
  const types = log.messages.map((m) => m.type)
  expect(types).toContain("audio.config")
  expect(types).toContain("mic.state")
  await expect.poll(async () => (await mock.log()).mic.find((x) => x.owner)?.frames ?? 0).toBeGreaterThan(10)
})

test("while the assistant is unreachable: reconnecting with a count, dock and composer disabled, history kept", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await page.keyboard.press("c")
  await expect(page.getByTestId("turn")).toHaveCount(2)
  await mock.offline(3000)
  await expectVisualState(page, "disconnected", 3000)
  await expect(page.getByTestId("connection-status")).toHaveText(/reconnecting \([2-9]\)/i, { timeout: 3000 })
  await expect(page.getByTestId("state-label")).toHaveText(/reconnecting · \d/i)
  await expect(page.locator("#chat-input")).toBeDisabled()
  await expect(page.getByTestId("mic-toggle")).toBeDisabled()
  await expect(page.getByTestId("turn")).toHaveCount(2)
  await expectVisualState(page, "listening", 10_000)
  await expect(page.locator("#chat-input")).toBeEnabled()
})

test("dropped mid-reply: the player is flushed, nothing is reported on the dead socket, and the page recovers", async ({ page, baseURL }) => {
  await mock.scenario("drop-mid-reply")
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "speaking", 10_000)
  await expect.poll(() => visualHistory(page), { timeout: 4000 }).toContain("disconnected")
  await expectVisualState(page, "listening", 6000)
  const history = await visualHistory(page)
  expect(history.slice(history.indexOf("speaking"))).toEqual(["speaking", "disconnected", "listening"])
  const log = await mock.log()
  expect(log.messages.some((m) => m.type === "playback.finished")).toBe(false)
  expect(log.messages.some((m) => m.type === "playback.stopped")).toBe(false)
})

test("page out of date (close 4400): asks for a reload and stops retrying", async ({ page, baseURL }) => {
  await mock.scenario("outdated")
  await page.goto(appUrl(baseURL))
  await expect(page.getByText("This page is older than the assistant.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible()
  await expectVisualState(page, "error")
  await expect(page.getByTestId("connection-status")).toHaveText(/out of date/i)
})

test("engines failed: a banner explains, typed messages are blocked, Open settings goes to the Overview", async ({ page, baseURL }) => {
  await mock.scenario("engine-failed")
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("engine-banner")).toContainText("DEEPGRAM_API_KEY is not set")
  await page.keyboard.press("c")
  await expect(page.locator("#chat-input")).toBeDisabled()
  await expect(page.getByTestId("chat-panel")).toContainText("engines are not running")
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Open settings" }).click()
  await expect(page.getByTestId("page-overview-overview")).toBeVisible()
  await expect(page.getByTestId("engine-problems")).toContainText("The engines could not start")
  await expect(page.getByTestId("nav-overview").locator("[data-mark=error]")).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#settings/overview/overview")
})

test("taken over by another tab: the microphone closes and Use this tab takes it back", async ({ page, baseURL }) => {
  await mock.scenario("takeover")
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await expect(page.getByTestId("observer-banner")).toBeVisible({ timeout: 4000 })
  await expect(page.getByTestId("mic-toggle")).toBeHidden()
  await page.getByRole("button", { name: /Use this tab/i }).click()
  await expect(page.getByTestId("mic-toggle")).toBeVisible()
  await expect(page.getByTestId("observer-banner")).toBeHidden()
})

test("two tabs: the second observes (mirrors the state, plays nothing) and can take the audio", async ({ browser, baseURL }) => {
  await mock.scenario("voice")
  const ctx = await browser.newContext({ permissions: ["microphone"] })
  const a = await ctx.newPage()
  const b = await ctx.newPage()
  await a.goto(appUrl(baseURL))
  await a.getByTestId("start").click()
  await b.goto(appUrl(baseURL))
  await expect(b.getByTestId("observer-banner")).toBeVisible()
  await expectVisualState(b, "speaking", 10_000) // from the server's state
  await expect(b.getByTestId("mic-toggle")).toBeHidden()
  // Stop from the observer goes through the server: the owner gets reply.stop.
  await b.getByTestId("chat-toggle").click()
  await b.keyboard.press("Escape") // closes chat
  await b.keyboard.press("Escape") // stops the reply
  await expectVisualState(a, "listening", 4000)
  const log = await mock.log()
  const interruptFrom = log.messages.find((m) => m.type === "interrupt")!.conn
  const stoppedFrom = log.messages.find((m) => m.type === "playback.stopped")!.conn
  expect(interruptFrom).not.toBe(stoppedFrom) // observer interrupted, owner reported the stop
  await b.getByRole("button", { name: /Use this tab/i }).click()
  await expect(b.getByTestId("mic-toggle")).toBeVisible()
  await expect(a.getByTestId("observer-banner")).toBeVisible()
  await ctx.close()
})
