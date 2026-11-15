/**
 * Screenshots of every screen and important state of both front ends, for the README and design review:
 *   pnpm --filter @pva/web screenshots        (builds the export, writes apps/web/screenshots/)
 * Real renders of the built app (the static export) against the mock. Not part of the normal e2e run.
 *
 * Names: `voice-…` (the voice front end, `/`) and `admin-…` (`/admin/`), then `desktop` (1280 × 800) or `phone`
 * (390 × 844 at 2×), then `light` where the light theme is shown (dark is the default).
 */
import { join } from "node:path"
import type { Browser, BrowserContextOptions, Page } from "@playwright/test"
import { ADMIN_PASSWORD, adminUrl, appUrl, expect, expectVisualState, gotoAdmin, here, loginAdmin, MOCK, mock, test } from "./fixtures.ts"

const dir = process.env.SCREENSHOT_DIR ?? join(here, "..", "screenshots")
const shot = (page: Page, name: string) => page.screenshot({ path: join(dir, `${name}.png`) })
const settle = (page: Page, ms = 350) => page.waitForTimeout(ms)
const captionHas = (page: Page, text: string) =>
  page.waitForFunction((t) => document.querySelector("[data-testid=captions]")?.textContent?.includes(t) ?? false, text, { timeout: 10_000 })

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } }
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

/** The next activation change from this page is rewritten to a field a device may not change itself: refused. */
const refusedChange = (page: Page) =>
  page.evaluate(() => {
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function(this: WebSocket, data) {
      if (typeof data === "string" && data.includes("\"device.update\"")) data = data.replace(/"activation":"[a-z-]+"/, "\"captions\":false")
      return send.call(this, data)
    }
  })

const start = async (page: Page, baseURL: string | undefined) => {
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
}

/** A second page in its own context (another browser), e.g. an observer or a denied microphone. */
const otherPage = async (browser: Browser, options: BrowserContextOptions, scheme: "dark" | "light" = "dark") => {
  const ctx = await browser.newContext({ ...options, colorScheme: scheme, permissions: ["microphone"] })
  return { ctx, page: await ctx.newPage() }
}

// ---------------------------------------------------------------------------------------------------------------
// Voice front end
// ---------------------------------------------------------------------------------------------------------------

test.describe("voice, desktop, dark", () => {
  test.use({ colorScheme: "dark", ...DESKTOP })

  test("conversation states", async ({ page, baseURL }) => {
    await mock.scenario("voice")
    await page.goto(appUrl(baseURL))
    await settle(page, 600)
    await shot(page, "voice-desktop-01-not-started")
    await page.getByTestId("start").click()
    await expectVisualState(page, "listening")
    await settle(page, 250)
    await shot(page, "voice-desktop-02-listening")
    await expectVisualState(page, "hearing")
    await captionHas(page, "weather in")
    await shot(page, "voice-desktop-03-hearing")
    await expectVisualState(page, "speaking", 10_000)
    await captionHas(page, "eighteen")
    await settle(page, 300)
    await shot(page, "voice-desktop-05-speaking")
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
    await shot(page, "voice-desktop-04-thinking")
    await mock.send([{ type: "tool.end", turnId: 77, callId: "c77", ok: true, ms: 88 }, { type: "state", state: "listening" }])
    await page.keyboard.press("m")
    await expectVisualState(page, "muted")
    await settle(page, 400)
    await shot(page, "voice-desktop-06-muted")
  })

  test("wake phrase: asleep, then the phrase alone", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await mock.defaults({ activation: "wake-phrase" })
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").click()
    await expectVisualState(page, "asleep")
    await page.waitForTimeout(7500) // the start hint fades
    await shot(page, "voice-desktop-07-asleep")
    await mock.wake("hey jeff", true)
    await expect(page.getByTestId("state-label")).toHaveText("Listening…")
    await settle(page, 500)
    await shot(page, "voice-desktop-08-woke")
  })

  test("chat and the settings sheet", async ({ page, baseURL }) => {
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
    await page.locator("#chat-input").fill("Tell me a long story")
    await page.keyboard.press("Enter")
    await expectVisualState(page, "speaking", 8000)
    await page.waitForTimeout(1800)
    await shot(page, "voice-desktop-09-chat")
    await expectVisualState(page, "listening", 20_000)
    await page.getByRole("button", { name: "Close conversation" }).click()
    await page.getByTestId("settings-toggle").click()
    await expect(page.getByTestId("voice-sheet")).toBeVisible()
    await settle(page, 500)
    await shot(page, "voice-desktop-10-settings-sheet")
    await page.getByTestId("voice-sheet").getByRole("radio", { name: "Wake phrase" }).click()
    await expect(page.getByTestId("wake-phrases")).toBeVisible()
    await settle(page, 400)
    await shot(page, "voice-desktop-11-settings-sheet-wake-phrase")
    // A refused change: the message stays next to the control, in the sheet.
    await refusedChange(page)
    await page.getByTestId("voice-sheet").getByRole("radio", { name: "Always listening" }).click()
    await expect(page.getByTestId("sheet-error")).toBeVisible()
    await settle(page, 400)
    await shot(page, "voice-desktop-18-settings-sheet-error")
  })

  test("new conversation: the button, the divider, after a quiet while, too many devices", async ({ page, browser, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await page.keyboard.press("c")
    await page.locator("#chat-input").fill("What time is it in Tokyo?")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("turn").last()).toHaveAttribute("data-outcome", "completed", { timeout: 15_000 })
    await page.getByTestId("new-conversation").hover()
    await settle(page, 400)
    await shot(page, "voice-desktop-20-chat-new-conversation-button")
    await page.getByTestId("new-conversation").click()
    await expect(page.getByTestId("conversation-divider")).toBeVisible()
    await page.locator("#chat-input").fill("Hello again")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("turn").last()).toHaveAttribute("data-outcome", "completed", { timeout: 15_000 })
    await page.mouse.move(0, 0)
    await settle(page, 400)
    await shot(page, "voice-desktop-21-new-conversation")
    await mock.idle(undefined, true)
    await expect(page.getByTestId("conversation-divider")).toHaveAttribute("data-reason", "idle")
    await settle(page, 400)
    await shot(page, "voice-desktop-22-new-conversation-idle")
    await mock.maxSessions(1)
    const other = await otherPage(browser, DESKTOP)
    await other.page.goto(appUrl(baseURL))
    await other.page.getByTestId("start").click()
    await expect(other.page.getByTestId("audio-error")).toBeVisible()
    await settle(other.page, 500)
    await shot(other.page, "voice-desktop-23-sessions-full")
    await other.ctx.close()
  })

  test("connection and errors", async ({ page, browser, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await mock.offline(5000)
    await expect(page.getByTestId("state-label")).toHaveText(/reconnecting · attempt [2-9]/i, { timeout: 4000 })
    await settle(page, 300)
    await shot(page, "voice-desktop-12-reconnecting")
    await expectVisualState(page, "listening", 10_000)
    // End this tab's session first, so the denied page is not also "audio on another device".
    await page.getByTestId("end-session").click()
    await expect(page.getByTestId("start")).toBeVisible()

    const denied = await otherPage(browser, DESKTOP)
    await denied.page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"))
    })
    await denied.page.goto(appUrl(baseURL))
    await denied.page.getByTestId("start").click()
    await expect(denied.page.getByTestId("audio-error")).toBeVisible()
    await settle(denied.page)
    await shot(denied.page, "voice-desktop-13-microphone-error")
    await denied.ctx.close()
    await page.getByTestId("start").click()
    await expectVisualState(page, "listening")

    // Another tab of the same device (protocol 6: another device would have its own session).
    const observer = { page: await page.context().newPage() }
    await observer.page.goto(appUrl(baseURL))
    await expect(observer.page.getByTestId("observer-banner")).toBeVisible()
    await settle(observer.page, 500)
    await shot(observer.page, "voice-desktop-15-observer")
    await observer.page.close()

    await mock.scenario("engine-failed")
    await page.reload()
    await expect(page.getByTestId("engine-banner")).toBeVisible()
    await settle(page, 500)
    await shot(page, "voice-desktop-14-not-ready")

    await mock.scenario("outdated")
    await page.reload()
    await expect(page.getByText("This page is older than the assistant.")).toBeVisible()
    await settle(page)
    await shot(page, "voice-desktop-16-outdated")
  })

  test("help: keyboard shortcuts with their switch, and the audio report", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await page.waitForTimeout(7500) // the start hint fades
    await page.keyboard.press("?")
    await expect(page.getByTestId("help-dialog")).toBeVisible()
    await settle(page, 400)
    await shot(page, "voice-desktop-17-help")
  })
})

test.describe("voice, phone, dark", () => {
  test.use({ colorScheme: "dark", ...PHONE })

  test("phone: states, chat, sheet", async ({ page, baseURL }) => {
    await mock.scenario("voice")
    await page.goto(appUrl(baseURL))
    await settle(page, 500)
    await shot(page, "voice-phone-01-not-started")
    await page.getByTestId("start").tap()
    await expectVisualState(page, "speaking", 10_000)
    await captionHas(page, "eighteen")
    await shot(page, "voice-phone-02-speaking")
    await expectVisualState(page, "listening", 15_000)
    await page.waitForTimeout(7500) // the start hint fades
    await expect(page.getByTestId("end-session")).toBeVisible()
    await shot(page, "voice-phone-09-listening-end-session")
    await page.getByTestId("chat-toggle").tap()
    await settle(page, 500)
    await shot(page, "voice-phone-05-chat")
    await page.getByRole("button", { name: "Close conversation" }).tap()
    await page.getByTestId("settings-toggle").tap()
    await settle(page, 500)
    await shot(page, "voice-phone-06-settings-sheet")
    const sheet = page.getByTestId("voice-sheet")
    await sheet.getByRole("radio", { name: "Wake phrase" }).tap()
    await sheet.getByTestId("sheet-more").getByText("More").tap()
    await sheet.getByTestId("admin-link").scrollIntoViewIfNeeded()
    await settle(page, 400)
    await shot(page, "voice-phone-07-settings-sheet-more")
  })

  test("phone: New conversation in the dock's More menu, the divider", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await page.waitForTimeout(7500) // the start hint fades
    await page.getByTestId("dock-more").tap()
    await expect(page.getByTestId("dock-menu")).toBeVisible()
    await settle(page, 400)
    await shot(page, "voice-phone-10-dock-more")
    await page.getByTestId("dock-new-conversation").tap()
    await expect(page.getByTestId("toasts")).toContainText("Started a new conversation.")
    await settle(page, 300)
    await shot(page, "voice-phone-11-new-conversation-toast")
    await page.getByTestId("chat-toggle").tap()
    await page.locator("#chat-input").fill("Hello again")
    await page.getByTestId("send").tap()
    await expect(page.getByTestId("turn").last()).toHaveAttribute("data-outcome", "completed", { timeout: 15_000 })
    await page.locator("#chat-input").blur()
    await settle(page, 500)
    await shot(page, "voice-phone-12-chat-new-conversation")
  })

  test("phone: asleep and woke, microphone error", async ({ page, browser, baseURL }) => {
    await mock.scenario("typed")
    await mock.defaults({ activation: "wake-phrase" })
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").tap()
    await expectVisualState(page, "asleep")
    await page.waitForTimeout(7500)
    await shot(page, "voice-phone-03-asleep")
    await mock.wake("hey jeff", true)
    await expect(page.getByTestId("state-label")).toHaveText("Listening…")
    await settle(page, 500)
    await shot(page, "voice-phone-04-woke")
    await page.getByTestId("end-session").tap()
    await expect(page.getByTestId("start")).toBeVisible()

    const denied = await otherPage(browser, PHONE)
    await denied.page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"))
    })
    await denied.page.goto(appUrl(baseURL))
    await denied.page.getByTestId("start").tap()
    await expect(denied.page.getByTestId("audio-error")).toBeVisible()
    await settle(denied.page)
    await shot(denied.page, "voice-phone-08-microphone-error")
    await denied.ctx.close()
  })
})

/** Small and landscape phones: every main state, the stage clear of the dock (e2e/layout.spec.ts checks it). */
for (const [width, height] of [[320, 568], [360, 640], [375, 667], [667, 375]] as const) {
  test.describe(`voice, small ${width} × ${height}`, () => {
    const SMALL: BrowserContextOptions = { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    test.use({ colorScheme: "dark", ...SMALL })

    test(`small ${width} × ${height}: not started, listening, muted, observer, speaking, microphone error`, async ({ page, browser, baseURL }) => {
      const name = (n: string) => `voice-small-${width}x${height}-${n}`
      await mock.scenario("typed")
      await page.goto(appUrl(baseURL))
      await settle(page, 600)
      await shot(page, name("01-not-started"))
      await page.getByTestId("start").tap()
      await expectVisualState(page, "listening")
      await settle(page, 400)
      await shot(page, name("02-listening"))
      await page.getByTestId("mic-toggle").tap()
      await expectVisualState(page, "muted")
      await settle(page, 400)
      await shot(page, name("03-muted"))
      await page.getByTestId("mic-toggle").tap()
      // Another tab of the same device (protocol 6: another device would have its own session).
      const observer = { page: await page.context().newPage() }
      await observer.page.goto(appUrl(baseURL))
      await expect(observer.page.getByTestId("observer-banner")).toBeVisible()
      await settle(observer.page, 500)
      await shot(observer.page, name("05-observer"))
      await observer.page.close()
      await page.getByTestId("end-session").tap()

      await mock.scenario("voice")
      await page.goto(appUrl(baseURL))
      await page.getByTestId("start").tap()
      await expectVisualState(page, "speaking", 10_000)
      await captionHas(page, "eighteen")
      await shot(page, name("04-speaking"))
      await page.getByTestId("end-session").tap()

      const denied = await otherPage(browser, SMALL)
      await denied.page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"))
      })
      await denied.page.goto(appUrl(baseURL))
      await denied.page.getByTestId("start").tap()
      await expect(denied.page.getByTestId("audio-error")).toBeVisible()
      await settle(denied.page)
      await shot(denied.page, name("06-microphone-error"))
      await denied.ctx.close()
    })
  })
}

test.describe("voice, light", () => {
  test.use({ colorScheme: "light", ...DESKTOP })

  test("light theme", async ({ page, browser, baseURL }) => {
    await mock.scenario("voice")
    await start(page, baseURL)
    await expectVisualState(page, "hearing")
    await captionHas(page, "weather in")
    await shot(page, "voice-desktop-light-01-hearing")
    await expectVisualState(page, "speaking", 10_000)
    await page.keyboard.press("c")
    await page.waitForTimeout(1200)
    await shot(page, "voice-desktop-light-02-speaking-chat")
    await expectVisualState(page, "listening", 15_000)
    await page.keyboard.press("Escape")
    await page.getByTestId("settings-toggle").click()
    await settle(page, 500)
    await shot(page, "voice-desktop-light-03-settings-sheet")

    await mock.scenario("typed")
    await mock.defaults({ activation: "wake-phrase" })
    const phone = await otherPage(browser, PHONE, "light")
    await phone.page.goto(appUrl(baseURL))
    await phone.page.getByTestId("start").tap()
    await expectVisualState(phone.page, "asleep")
    await phone.page.waitForTimeout(7500)
    await shot(phone.page, "voice-phone-light-01-asleep")
    await phone.page.getByTestId("end-session").tap()
    await phone.ctx.close()

    const denied = await otherPage(browser, DESKTOP, "light")
    await denied.page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"))
    })
    await denied.page.goto(appUrl(baseURL))
    await denied.page.getByTestId("start").click()
    await expect(denied.page.getByTestId("audio-error")).toBeVisible()
    await settle(denied.page)
    await shot(denied.page, "voice-desktop-light-04-microphone-error")
    await denied.ctx.close()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Admin front end
// ---------------------------------------------------------------------------------------------------------------

/** Run a few typed turns from a voice page, so the latency page and the device list have something to show. */
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

/** A voice page with a few turns, and (protocol 6) a second device, an iPhone, talking at the same time. */
const someTurns = async (browser: Browser, baseURL: string | undefined) => {
  const phone = await otherPage(browser, { ...PHONE, userAgent: IPHONE_UA })
  await phone.page.goto(appUrl(baseURL))
  await phone.page.getByTestId("start").tap()
  await expectVisualState(phone.page, "listening")
  const voice = await otherPage(browser, DESKTOP)
  const close = voice.ctx.close.bind(voice.ctx)
  voice.ctx.close = async () => {
    await phone.ctx.close()
    await close()
  }
  await voice.page.goto(appUrl(baseURL))
  await voice.page.getByTestId("start").click()
  await expectVisualState(voice.page, "listening")
  await voice.page.keyboard.press("c")
  for (const text of ["What time is it in Tokyo?", "Tell me a long story"]) {
    await voice.page.locator("#chat-input").fill(text)
    await voice.page.keyboard.press("Enter")
    await expectVisualState(voice.page, "speaking", 8000)
    await expectVisualState(voice.page, "listening", 20_000)
  }
  return voice
}

test.describe("admin, desktop, dark", () => {
  test.use({ colorScheme: "dark", ...DESKTOP })

  test("login: the form, a wrong password, the back-off, switched off, a session that ended", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await page.goto(adminUrl(baseURL))
    await expect(page.getByTestId("login-form")).toBeVisible()
    await settle(page, 400)
    await shot(page, "admin-desktop-01-login")
    await page.locator("#admin-password").fill("wrong password")
    await page.getByRole("button", { name: "Log in" }).click()
    await expect(page.getByTestId("login-error")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-02-login-error")

    await mock.scenario("admin-backoff")
    await page.reload()
    await page.locator("#admin-password").fill("wrong again")
    await page.getByRole("button", { name: "Log in" }).click()
    await expect(page.getByTestId("login-wait")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-03-login-backoff")

    await mock.scenario("admin-disabled")
    await page.reload()
    await expect(page.getByTestId("admin-disabled")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-04-disabled")

    await mock.scenario("typed")
    await loginAdmin(page, baseURL)
    await mock.endAdmin("idle")
    await expect(page.getByTestId("login-reason")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-05-session-ended")
  })

  test("overview, front end with the tester, devices, a device with overrides", async ({ page, browser, baseURL }) => {
    await mock.scenario("devices")
    const voice = await someTurns(browser, baseURL)
    await loginAdmin(page, baseURL)
    await expect(page.getByTestId("page-overview-overview")).toBeVisible()
    await settle(page, 500)
    await shot(page, "admin-desktop-06-overview")
    await page.getByTestId("sessions").scrollIntoViewIfNeeded()
    await settle(page)
    await shot(page, "admin-desktop-06b-overview-sessions")

    await page.getByTestId("nav-frontends").click()
    await expect(page.getByTestId("page-frontends-frontend")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-07-front-end")
    const form = page.getByTestId("profile-frontend-web-voice")
    await form.getByRole("radio", { name: "Wake phrase" }).click()
    // Idle: "Ready to test …" (it says "Testing …" only while listening).
    await expect(page.getByTestId("tester-scope")).toContainText("Ready to test")
    await page.getByTestId("phrase-tester").scrollIntoViewIfNeeded()
    await settle(page)
    await shot(page, "admin-desktop-07b-tester-ready")
    await page.getByTestId("tester-listen").click()
    // All three outcomes: matched, accepted without a phrase (the device was listening), ignored.
    await mock.heard("Hey Jeff", "hey jeff", true)
    await mock.heard("And what about tomorrow?", undefined, true)
    await mock.heard("Hey go, what's the weather?", undefined, false)
    await mock.heard("Hey Jeff, set a timer for ten minutes", "hey jeff", true)
    await expect(page.getByTestId("heard-lines").locator("li")).toHaveCount(4)
    await page.getByTestId("phrase-tester").scrollIntoViewIfNeeded()
    await page.getByTestId("settings-page").evaluate((el) => el.scrollBy(0, 120))
    await settle(page)
    await shot(page, "admin-desktop-08-front-end-tester")
    await page.getByTestId("add-heard").click()
    await expect(page.getByTestId("tester-unsaved")).toBeVisible()
    await page.getByTestId("phrase-tester").scrollIntoViewIfNeeded()
    await settle(page)
    await shot(page, "admin-desktop-08b-tester-unsaved-changes")
    await page.getByTestId("page-footer").getByRole("button", { name: "Cancel" }).click()

    // "Custom" (saved, not the default) and "Unsaved" (an edit), on one page.
    await form.locator("[data-field=captions]").getByRole("switch").click()
    await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    await form.locator("[data-field=speakReplies]").getByRole("switch").click()
    await form.locator("[data-field=captions]").getByRole("switch").click()
    await form.locator("[data-group=display]").scrollIntoViewIfNeeded()
    await settle(page)
    await shot(page, "admin-desktop-19-unsaved-and-custom")
    await page.getByTestId("page-footer").getByRole("button", { name: "Cancel" }).click()
    await form.locator("[data-field=captions]").getByTestId("reset").click()
    await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")

    await page.getByTestId("nav-devices").click()
    await expect(page.getByTestId("device-list")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-09-devices")
    await page.getByTestId("device-list").locator("[data-device=d-kitchen-ipad-0001]").click()
    await expect(page.getByTestId("page-devices-device")).toBeVisible()
    await page.getByTestId("settings-page").evaluate((el) => el.scrollBy(0, 230))
    await settle(page)
    await shot(page, "admin-desktop-10-device")
    await page.getByTestId("forget").click()
    await settle(page)
    await shot(page, "admin-desktop-11-device-forget")
    await page.getByRole("button", { name: "Keep it" }).click()

    await page.getByTestId("nav-diagnostics").click()
    await page.getByTestId("nav-diagnostics-latency").click()
    await settle(page)
    await shot(page, "admin-desktop-16-diagnostics-latency")
    await voice.ctx.close()
  })

  test("language model, speech, a module in error", async ({ page, baseURL }) => {
    await mock.scenario("modules")
    await loginAdmin(page, baseURL, "#settings/language-model/provider")
    await page.getByTestId("form-s-language-model").getByRole("radio", { name: /Claude subscription/ }).click()
    await expect(page.getByTestId("option-module")).toBeVisible()
    await page.getByTestId("option-module").scrollIntoViewIfNeeded()
    await settle(page)
    await shot(page, "admin-desktop-12-language-model")
    await page.getByTestId("page-footer").getByRole("button", { name: "Cancel" }).click()
    await page.getByTestId("nav-speech").click()
    await page.getByTestId("nav-speech-engine").click()
    await page.getByTestId("form-s-stt-engine").getByRole("radio", { name: /Deepgram/ }).click()
    await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByTestId("save-warnings")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-13-speech-warnings")
    await page.getByTestId("page-footer").getByRole("button", { name: "Go back" }).click()
    await page.getByTestId("page-footer").getByRole("button", { name: "Cancel" }).click()
    await page.getByTestId("nav-modules").click()
    await page.getByTestId("nav-modules-home-assistant").click()
    const ha = page.getByTestId("module-home-assistant")
    await ha.getByRole("switch").click()
    await expect(ha).toHaveAttribute("data-state", "error")
    await page.waitForTimeout(6200) // let the toast go
    await shot(page, "admin-desktop-17-module-error")
  })

  test("keys & vault: locked, a protected page while locked, unlocked; settings from outside", async ({ page, baseURL }) => {
    await mock.scenario("keys-locked")
    await loginAdmin(page, baseURL, "#settings/keys/access")
    await expect(page.getByTestId("keys-panel")).toHaveAttribute("data-view", "unlock")
    await settle(page)
    await shot(page, "admin-desktop-14-keys-locked")
    await gotoAdmin(page, baseURL, "#settings/language-model/provider")
    await expect(page.getByTestId("keys-locked")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-15-protected-page-locked")
    // Every mark in the list at once, each in the legend: unsaved (an edit), to set up, a problem, padlock.
    await gotoAdmin(page, baseURL, "#settings/speech/turn-timing")
    await page.evaluate(() => {
      const c = (window as unknown as { __pva: { store: { get: () => { engine: Record<string, unknown> }; dispatch: (a: unknown) => void } } }).__pva
      c.store.dispatch({ type: "engine", engine: { ...c.store.get().engine, problems: [{ stage: "tts", message: "Piper: the voice file is missing." }] } })
    })
    await page.getByTestId("settings-page").locator("input[type=number]").first().fill("700")
    await expect(page.getByTestId("marks-legend").locator("[data-legend]")).toHaveCount(4)
    await settle(page)
    await shot(page, "admin-desktop-20-nav-legend")
    await page.getByTestId("page-footer").getByRole("button", { name: "Cancel" }).click()
    await gotoAdmin(page, baseURL, "#settings/language-model/provider")
    await page.getByTestId("unlock-form-page").getByLabel("Vault password").fill("correct horse battery")
    await page.getByTestId("unlock-form-page").getByRole("button", { name: "Unlock" }).click()
    await expect(page.getByTestId("keys-locked")).toHaveCount(0)
    await page.getByTestId("nav-keys").click()
    await expect(page.getByTestId("keys-panel")).toHaveAttribute("data-view", "unlocked")
    await settle(page, 1200)
    await shot(page, "admin-desktop-14b-keys-unlocked")
    await gotoAdmin(page, baseURL, "#settings/diagnostics/overrides")
    await expect(page.getByTestId("overrides")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-18-settings-from-outside")
  })
})

test.describe("admin, phone, dark", () => {
  test.use({ colorScheme: "dark", ...PHONE })

  test("phone: login, the drill-down levels, front end, devices, device", async ({ page, browser, baseURL }) => {
    await mock.scenario("devices")
    const voice = await someTurns(browser, baseURL)
    await page.goto(adminUrl(baseURL))
    await expect(page.getByTestId("login-form")).toBeVisible()
    await settle(page)
    await shot(page, "admin-phone-01-login")
    await page.locator("#admin-password").fill(ADMIN_PASSWORD)
    await page.getByRole("button", { name: "Log in" }).tap()
    const settings = page.getByTestId("settings")
    await expect(settings).toHaveAttribute("data-level", "list")
    await settle(page)
    await shot(page, "admin-phone-02-categories")
    await page.getByTestId("nav-speech").tap()
    await expect(settings).toHaveAttribute("data-level", "pages")
    await settle(page)
    await shot(page, "admin-phone-03-category-pages")
    await page.getByTestId("nav-speech-engine").tap()
    await page.getByTestId("form-s-stt-engine").getByRole("radio", { name: /Deepgram/ }).tap()
    await settle(page)
    await shot(page, "admin-phone-04-page")
    await page.getByTestId("page-footer").getByRole("button", { name: "Cancel" }).tap()

    await gotoAdmin(page, baseURL, "#settings/frontends/web-voice")
    await settle(page)
    await shot(page, "admin-phone-05-front-end")
    await page.getByTestId("profile-frontend-web-voice").getByRole("radio", { name: "Wake phrase" }).tap()
    await page.getByTestId("tester-listen").tap()
    await mock.heard("Hey Jeff", "hey jeff", true)
    await mock.heard("And tomorrow?", undefined, true)
    await mock.heard("Hey go, what's the weather?", undefined, false)
    await expect(page.getByTestId("heard-lines").locator("li")).toHaveCount(3)
    await page.getByTestId("phrase-tester").scrollIntoViewIfNeeded()
    await settle(page)
    await shot(page, "admin-phone-06-front-end-tester")
    await page.getByTestId("page-footer").getByRole("button", { name: "Cancel" }).tap()

    await gotoAdmin(page, baseURL, "#settings/devices")
    await expect(page.getByTestId("device-list")).toBeVisible()
    await settle(page)
    await shot(page, "admin-phone-07-devices")
    await page.getByTestId("device-list").locator("[data-device=d-kitchen-ipad-0001]").tap()
    await expect(page.getByTestId("page-devices-device")).toBeVisible()
    await page.getByTestId("settings-page").evaluate((el) => el.scrollBy(0, 420))
    await settle(page)
    await shot(page, "admin-phone-08-device")
    await voice.ctx.close()
  })

  test("320 px: the header (status wraps, the Voice link), devices list", async ({ page, browser, baseURL }) => {
    await mock.scenario("devices")
    const voice = await someTurns(browser, baseURL)
    await page.setViewportSize({ width: 320, height: 640 })
    await loginAdmin(page, baseURL, "#settings/devices")
    await expect(page.getByTestId("device-list")).toBeVisible()
    await settle(page)
    await shot(page, "admin-phone-320-01-devices")
    await gotoAdmin(page, baseURL, "#settings/frontends/web-voice")
    await settle(page)
    await shot(page, "admin-phone-320-02-front-end")
    await voice.ctx.close()
  })

  test("phone: admin switched off", async ({ page, baseURL }) => {
    await mock.scenario("admin-disabled")
    await page.goto(adminUrl(baseURL))
    await expect(page.getByTestId("admin-disabled")).toBeVisible()
    await settle(page)
    await shot(page, "admin-phone-09-disabled")
  })
})

test.describe("admin, light", () => {
  test.use({ colorScheme: "light", ...DESKTOP })

  test("light theme", async ({ page, browser, baseURL }) => {
    await mock.scenario("devices")
    await page.goto(adminUrl(baseURL))
    await expect(page.getByTestId("login-form")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-light-01-login")
    await loginAdmin(page, baseURL, "#settings/frontends/web-voice")
    await settle(page)
    await shot(page, "admin-desktop-light-02-front-end")
    await page.getByTestId("nav-devices").click()
    await expect(page.getByTestId("device-list")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-light-03-devices")

    // The tester with matched and ignored lines, then saved.
    await page.getByTestId("nav-frontends").click()
    await page.getByTestId("profile-frontend-web-voice").getByRole("radio", { name: "Wake phrase" }).click()
    await page.getByTestId("tester-listen").click()
    await mock.heard("Hey Jeff", "hey jeff", true)
    await mock.heard("And tomorrow?", undefined, true)
    await mock.heard("Hey go, what's the weather?", undefined, false)
    await expect(page.getByTestId("heard-lines").locator("li")).toHaveCount(3)
    await page.getByTestId("phrase-tester").scrollIntoViewIfNeeded()
    await settle(page)
    await shot(page, "admin-desktop-light-04-tester-matched")
    await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    await settle(page)
    await shot(page, "admin-desktop-light-05-saved")

    // A save with a warning: only "Save anyway" and "Go back".
    await page.getByTestId("nav-speech").click()
    await page.getByTestId("nav-speech-engine").click()
    await page.getByTestId("form-s-stt-engine").getByRole("radio", { name: /Deepgram/ }).click()
    await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByTestId("save-warnings")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-light-06-speech-warnings")
    await page.getByTestId("page-footer").getByRole("button", { name: "Go back" }).click()
    await page.getByTestId("page-footer").getByRole("button", { name: "Cancel" }).click()

    // The login back-off.
    await mock.scenario("admin-backoff")
    await page.goto(adminUrl(baseURL))
    await page.locator("#admin-password").fill("wrong again")
    await page.getByRole("button", { name: "Log in" }).click()
    await expect(page.getByTestId("login-wait")).toBeVisible()
    await settle(page)
    await shot(page, "admin-desktop-light-07-login-backoff")
    await mock.scenario("devices")

    const phone = await otherPage(browser, PHONE, "light")
    await phone.page.goto(adminUrl(baseURL))
    await phone.page.locator("#admin-password").fill(ADMIN_PASSWORD)
    await phone.page.getByRole("button", { name: "Log in" }).tap()
    await expect(phone.page.getByTestId("settings")).toHaveAttribute("data-level", "list")
    await settle(phone.page)
    await shot(phone.page, "admin-phone-light-01-categories")
    await phone.ctx.close()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Long wake phrases (six words, 60 characters) at the smallest widths
// ---------------------------------------------------------------------------------------------------------------

for (const [width, height] of [[320, 568], [390, 844]] as const) {
  test.describe(`voice, long wake phrase, ${width} × ${height}`, () => {
    test.use({ colorScheme: "dark", viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    test("asleep with “hello my personal voice assistant please”", async ({ page, baseURL }) => {
      await mock.scenario("long-phrase")
      await page.goto(appUrl(baseURL))
      await page.getByTestId("start").tap()
      await expectVisualState(page, "asleep")
      await settle(page, 600)
      await shot(page, `voice-long-phrase-${width}x${height}-01-asleep`)
    })
  })
}

test.describe("admin, long wake phrase, 320 px", () => {
  test.use({ colorScheme: "dark", viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  test("device list, phrase editor, the page title in full", async ({ page, baseURL }) => {
    await mock.scenario("long-phrase")
    await loginAdmin(page, baseURL, "#settings/devices")
    await expect(page.getByTestId("device-list").locator("[data-device=d-living-room-0003]")).toBeVisible()
    await settle(page)
    await shot(page, "admin-phone-320-03-long-phrase-devices")
    await gotoAdmin(page, baseURL, "#settings/frontends/web-voice")
    await expect(page.getByTestId("page-title")).toHaveText("Voice assistant in a browser")
    await settle(page)
    await shot(page, "admin-phone-320-04-full-title")
    await page.getByTestId("phrase-list").evaluate((el) => el.scrollIntoView({ block: "center" }))
    await settle(page)
    await shot(page, "admin-phone-320-05-long-phrase-editor")
  })
})

/**
 * The voice picker (docs/VOICE-PROVIDERS.md §4) on Voices › Voices: the closed button, then the popup with
 * Favourites, one provider, a download in progress, a preview playing, a search across providers, and a provider
 * that needs a key. `names`: the file name of each, in that order.
 */
const pickerShots = async (page: Page, baseURL: string | undefined, names: {
  readonly closed: string
  readonly favourites: string
  readonly provider: string
  readonly download: string
  readonly preview?: string
  readonly search: string
  readonly needsKey: string
}, phone = false) => {
  await mock.scenario("typed")
  await loginAdmin(page, baseURL, "#settings/voices/overview")
  const picker = page.getByTestId("voice-picker")
  const popup = page.getByTestId("voice-popup")
  const press = (l: ReturnType<Page["locator"]>) => (phone ? l.tap() : l.click())
  const tab = (id: string) => page.getByTestId("voice-rail").locator(`[data-tab="${id}"]`)
  await expect(picker).toContainText("Lessac")
  await settle(page)
  await shot(page, names.closed)
  await press(picker)
  await expect(popup.getByTestId("voice-row").first()).toBeVisible()
  await settle(page, 400)
  await shot(page, names.favourites)
  await press(tab("sherpa"))
  await settle(page)
  await shot(page, names.provider)
  const alba = popup.locator("[data-voice='sherpa:en_GB-alba-medium']")
  await press(alba.locator("[data-action=download]"))
  await expect.poll(async () => Number(await alba.getByRole("progressbar").getAttribute("aria-valuenow") ?? 0)).toBeGreaterThanOrEqual(30)
  await shot(page, names.download)
  await press(alba.locator("[data-action=cancel]"))
  if (names.preview !== undefined) {
    const heart = popup.locator("[data-voice='sherpa:kokoro-af_heart']")
    await press(heart.locator("[data-action=preview]"))
    await expect(heart).toHaveAttribute("data-preview", "playing")
    await settle(page, 300)
    await shot(page, names.preview)
    await press(heart.locator("[data-action=stop]"))
  }
  await popup.getByTestId("voice-search").fill("gb")
  await expect(popup.getByTestId("voice-list")).toHaveAttribute("data-mode", "search")
  await settle(page)
  await shot(page, names.search)
  await press(tab("cartesia"))
  await expect(popup.getByTestId("provider-needs-key")).toBeVisible()
  await settle(page)
  await shot(page, names.needsKey)
}

test.describe("voice picker, desktop, dark", () => {
  test.use({ colorScheme: "dark", ...DESKTOP })
  test("closed, favourites, a provider, a download, a preview, search, needs a key", async ({ page, baseURL }) => {
    await fetch(`${MOCK}/mock/voices/hold`, { method: "POST", body: JSON.stringify({ ms: 0 }) })
    await pickerShots(page, baseURL, {
      closed: "admin-desktop-21-voice-picker-closed",
      favourites: "admin-desktop-22-voice-picker-favourites",
      provider: "admin-desktop-23-voice-picker-provider",
      download: "admin-desktop-24-voice-picker-download",
      preview: "admin-desktop-25-voice-picker-preview",
      search: "admin-desktop-26-voice-picker-search",
      needsKey: "admin-desktop-27-voice-picker-needs-key"
    })
  })
})

test.describe("voice picker, desktop, light", () => {
  test.use({ colorScheme: "light", ...DESKTOP })
  test("closed, favourites, a provider, a download, search, needs a key", async ({ page, baseURL }) => {
    await pickerShots(page, baseURL, {
      closed: "admin-desktop-light-08-voice-picker-closed",
      favourites: "admin-desktop-light-09-voice-picker-favourites",
      provider: "admin-desktop-light-10-voice-picker-provider",
      download: "admin-desktop-light-11-voice-picker-download",
      preview: "admin-desktop-light-12-voice-picker-preview",
      search: "admin-desktop-light-13-voice-picker-search",
      needsKey: "admin-desktop-light-14-voice-picker-needs-key"
    })
  })
})

test.describe("voice picker, phone, dark", () => {
  test.use({ colorScheme: "dark", ...PHONE })
  test("the bottom sheet: closed, favourites, a provider, a download, search, needs a key", async ({ page, baseURL }) => {
    await pickerShots(page, baseURL, {
      closed: "admin-phone-10-voice-picker-closed",
      favourites: "admin-phone-11-voice-picker-favourites",
      provider: "admin-phone-12-voice-picker-provider",
      download: "admin-phone-13-voice-picker-download",
      search: "admin-phone-14-voice-picker-search",
      needsKey: "admin-phone-15-voice-picker-needs-key"
    }, true)
  })
})
