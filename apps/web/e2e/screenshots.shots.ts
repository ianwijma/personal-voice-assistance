/**
 * Screenshots of every visual state and surface, for the README and design review:
 *   pnpm --filter @pva/web screenshots        (writes apps/web/screenshots/)
 * Not part of the normal e2e run.
 */
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appUrl, expect, expectVisualState, here, mock, test } from "./fixtures.ts"

const dir = process.env.SCREENSHOT_DIR ?? join(here, "..", "screenshots")
const shot = (page: Page, name: string) => page.screenshot({ path: join(dir, `${name}.png`) })
const settle = (page: Page, ms = 350) => page.waitForTimeout(ms)
const captionHas = (page: Page, text: string) =>
  page.waitForFunction((t) => document.querySelector("[data-testid=captions]")?.textContent?.includes(t) ?? false, text, { timeout: 10_000 })

const start = async (page: Page, baseURL: string | undefined) => {
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
}

test.describe("desktop, dark", () => {
  test.use({ colorScheme: "dark", viewport: { width: 1280, height: 800 } })

  test("voice states", async ({ page, baseURL }) => {
    await mock.scenario("voice")
    await page.goto(appUrl(baseURL))
    await settle(page, 600)
    await shot(page, "desktop-01-not-started")
    await page.getByTestId("start").click()
    await expectVisualState(page, "listening")
    await settle(page, 250)
    await shot(page, "desktop-02-listening")
    await expectVisualState(page, "hearing")
    await captionHas(page, "weather in")
    await shot(page, "desktop-03-hearing")
    await expectVisualState(page, "speaking", 10_000)
    await captionHas(page, "eighteen")
    await settle(page, 300)
    await shot(page, "desktop-05-speaking")
    await expectVisualState(page, "listening", 15_000)
  })

  test("thinking, muted", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await mock.send([
      { type: "turn.start", turnId: 77, source: "voice", userText: "What's on my calendar tomorrow?", spoken: true },
      { type: "state", state: "thinking", turnId: 77 },
      { type: "tool.start", turnId: 77, callId: "c77", tool: "calendar", moduleId: "notes", input: { day: "tomorrow" } }
    ])
    await expectVisualState(page, "thinking")
    await settle(page, 700)
    await shot(page, "desktop-04-thinking")
    await mock.send([{ type: "tool.end", turnId: 77, callId: "c77", ok: true, ms: 88 }, { type: "state", state: "listening" }])
    await page.keyboard.press("m")
    await expectVisualState(page, "muted")
    await settle(page, 400)
    await shot(page, "desktop-06-muted")
  })

  test("connection and errors", async ({ page, browser, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await mock.offline(5000)
    await expect(page.getByTestId("connection-status")).toHaveText(/reconnecting \([2-9]\)/i, { timeout: 4000 })
    await settle(page, 300)
    await shot(page, "desktop-07-reconnecting")
    await expectVisualState(page, "listening", 10_000)

    const denied = await browser.newPage({ colorScheme: "dark", viewport: { width: 1280, height: 800 } })
    await denied.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"))
    })
    await denied.goto(appUrl(baseURL))
    await denied.getByTestId("start").click()
    await expect(denied.getByTestId("audio-error")).toBeVisible()
    await settle(denied)
    await shot(denied, "desktop-08-microphone-error")
    await denied.close()

    const observer = await browser.newPage({ colorScheme: "dark", viewport: { width: 1280, height: 800 } })
    await observer.goto(appUrl(baseURL))
    await expect(observer.getByTestId("observer-banner")).toBeVisible()
    await settle(observer, 500)
    await shot(observer, "desktop-09-observer")
    await observer.close()

    await mock.scenario("engine-failed")
    await page.reload()
    await expect(page.getByTestId("engine-banner")).toBeVisible()
    await settle(page, 500)
    await shot(page, "desktop-10-engine-failed")

    await mock.scenario("outdated")
    await page.reload()
    await expect(page.getByText("This page is older than the assistant.")).toBeVisible()
    await settle(page)
    await shot(page, "desktop-11-outdated")
  })

  test("chat and latency", async ({ page, baseURL }) => {
    await mock.scenario("voice")
    await start(page, baseURL)
    await expectVisualState(page, "speaking", 10_000)
    await page.waitForTimeout(1500)
    await page.getByTestId("stop").click() // an interrupted reply
    await expectVisualState(page, "listening")
    await page.keyboard.press("c")
    await page.locator("#chat-input").fill("What time is it in Tokyo?")
    await page.keyboard.press("Enter")
    await expectVisualState(page, "speaking", 8000)
    await expectVisualState(page, "listening", 10_000)
    await page.locator("#chat-input").fill("And the weather in Atlantis? (this one fails)")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("tool-chip").last()).toHaveAttribute("data-status", "error", { timeout: 6000 })
    await expectVisualState(page, "listening", 15_000)
    await page.locator("#chat-input").fill("Tell me a long story")
    await page.keyboard.press("Enter")
    await expectVisualState(page, "speaking", 8000)
    await page.waitForTimeout(1800)
    await shot(page, "desktop-12-chat-speaking")
    await expectVisualState(page, "listening", 20_000)
    await page.getByTestId("latency-readout").click()
    await settle(page)
    await shot(page, "desktop-13-latency")
  })

  test("options", async ({ page, baseURL }) => {
    await mock.scenario("modules")
    await start(page, baseURL)
    await page.keyboard.press("o")
    const ha = page.getByTestId("module-home-assistant")
    await ha.getByRole("switch").click()
    await expect(ha).toHaveAttribute("data-state", "error")
    await page.waitForTimeout(6200) // let the toast go
    await page.getByTestId("module-notes").getByRole("switch").first().click()
    await expect(page.getByTestId("module-notes")).toHaveAttribute("data-state", "running")
    await page.getByRole("tabpanel").evaluate((el) => el.scrollTo(0, 0))
    await settle(page)
    await shot(page, "desktop-14-options-modules")
    await ha.getByRole("button", { name: /Home Assistant/ }).click() // collapse
    const weather = page.getByTestId("module-weather")
    await weather.getByRole("button", { name: /Weather/ }).click()
    await weather.getByLabel("Home location").fill("Atlantis")
    await weather.getByRole("button", { name: "Save" }).click()
    await expect(weather.getByText("Open-Meteo does not know this place.")).toBeVisible()
    await weather.getByText("Advanced").click()
    await settle(page)
    await shot(page, "desktop-15-options-form-error")
    await page.getByRole("tab", { name: "Assistant" }).click()
    const listening = page.getByTestId("section-listening")
    await listening.getByLabel("End of turn after").fill("700")
    await listening.getByRole("button", { name: "Save" }).click()
    await expect(page.getByTestId("reload-pending")).toBeVisible()
    await settle(page)
    await shot(page, "desktop-16-options-assistant")
    await page.getByRole("tab", { name: "This device" }).click()
    await page.getByText("Advanced").click()
    await settle(page)
    await shot(page, "desktop-17-options-device")
    await page.keyboard.press("Escape")
    await page.keyboard.press("?")
    await settle(page)
    await shot(page, "desktop-18-shortcuts")
  })
})

test.describe("phone, dark", () => {
  test.use({ colorScheme: "dark", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

  test("phone", async ({ page, baseURL }) => {
    await mock.scenario("voice")
    await page.goto(appUrl(baseURL))
    await settle(page, 500)
    await shot(page, "phone-01-not-started")
    await page.getByTestId("start").tap()
    await expectVisualState(page, "speaking", 10_000)
    await captionHas(page, "eighteen")
    await shot(page, "phone-02-speaking")
    await expectVisualState(page, "listening", 15_000)
    await page.getByTestId("chat-toggle").tap()
    await settle(page, 500)
    await shot(page, "phone-03-chat")
    await page.getByRole("button", { name: "Close conversation" }).tap()
    await page.getByRole("button", { name: "Options (O)" }).tap()
    await page.getByTestId("module-weather").getByRole("button", { name: /Weather/ }).tap()
    await settle(page, 500)
    await shot(page, "phone-04-options")
  })
})

test.describe("light", () => {
  test.use({ colorScheme: "light", viewport: { width: 1280, height: 800 } })

  test("light theme", async ({ page, baseURL }) => {
    await mock.scenario("voice")
    await start(page, baseURL)
    await expectVisualState(page, "hearing")
    await captionHas(page, "weather in")
    await shot(page, "light-01-hearing")
    await expectVisualState(page, "speaking", 10_000)
    await page.keyboard.press("c")
    await page.waitForTimeout(1200)
    await shot(page, "light-02-speaking-chat")
  })
})
