import type { Browser, Page } from "@playwright/test"
import { appUrl, deviceIdOf, expect, expectVisualState, loginAdmin, mock, test } from "./fixtures.ts"

// Protocol 6 (docs/VOICE-SESSIONS.md §5): one conversation per device, New conversation and its divider, the quiet
// reset, too many devices, and the sessions in admin. A browser context is one device (its own `pva.deviceId`).

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

/** A second device: its own browser context. */
const device = async (browser: Browser, baseURL: string | undefined, userAgent?: string) => {
  const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 800 }, ...(userAgent === undefined ? {} : { userAgent }) })
  const page = await ctx.newPage()
  await page.goto(appUrl(baseURL))
  return { ctx, page }
}

const openChat = async (page: Page) => {
  if (!(await page.getByTestId("chat-panel").isVisible())) await page.getByTestId("chat-toggle").click()
  await expect(page.getByTestId("chat-panel")).toBeVisible()
}

const say = async (page: Page, text: string) => {
  await openChat(page)
  await page.locator("#chat-input").fill(text)
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("turn").last()).toHaveAttribute("data-outcome", "completed", { timeout: 15_000 })
}

test("New conversation in the chat's header asks nothing: the chat empties, shows the divider, and every tab of the device follows", async ({ page, baseURL, context }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  const other = await context.newPage() // the same device
  await other.goto(appUrl(baseURL))
  await openChat(page)
  await openChat(other)
  await expect(page.getByTestId("turn")).toHaveCount(2) // the example history
  await say(page, "What time is it in Tokyo?")
  await expect(other.getByTestId("turn")).toHaveCount(3)

  const button = page.getByTestId("new-conversation")
  await expect(button).toHaveAccessibleName("New conversation with Jeff (T3 keeps its own)")
  await expect(button).toHaveAttribute("title", "New conversation with Jeff (T3 keeps its own)") // an icon now: the title is long with several assistants
  await button.click()
  for (const p of [page, other]) {
    await expect(p.getByTestId("turn")).toHaveCount(0)
    await expect(p.getByTestId("conversation-divider")).toHaveText("New conversation")
    await expect(p.getByTestId("conversation-divider")).toHaveAttribute("data-reason", "new")
  }
  await expect(page.getByRole("dialog")).toHaveCount(1) // no confirmation: only the chat panel
  expect((await mock.log()).messages.filter((m) => m.type === "conversation.new")).toHaveLength(1)

  // The next turn comes after the divider; a reload shows the new conversation without one.
  await say(page, "Hello again")
  await expect(page.getByTestId("turn")).toHaveCount(1)
  await expect(page.getByTestId("conversation-divider")).toBeVisible()
  await page.reload()
  await openChat(page)
  await expect(page.getByTestId("turn")).toHaveCount(1)
  await expect(page.getByTestId("conversation-divider")).toHaveCount(0)
  await other.close()
})

test("two devices talk at the same time, each in its own conversation, and neither takes the audio from the other", async ({ page, baseURL, browser }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  const b = await device(browser, baseURL)
  expect(await deviceIdOf(b.page)).not.toBe(await deviceIdOf(page))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await b.page.getByTestId("start").click()
  await expectVisualState(b.page, "listening")
  // Both own their own audio: nobody was taken over.
  await expect(page.getByTestId("mic-toggle")).toBeVisible()
  await expect(page.getByTestId("observer-banner")).toBeHidden()
  await expect(b.page.getByTestId("mic-toggle")).toBeVisible()

  await say(page, "What time is it in Tokyo?")
  await say(b.page, "Hello from the kitchen")
  await expect(page.getByTestId("messages")).toContainText("Tokyo")
  await expect(page.getByTestId("messages")).not.toContainText("kitchen")
  await expect(b.page.getByTestId("messages")).toContainText("kitchen")
  await expect(b.page.getByTestId("messages")).not.toContainText("Tokyo")

  // A new conversation on one device leaves the other alone.
  await page.getByTestId("new-conversation").click()
  await expect(page.getByTestId("turn")).toHaveCount(0)
  await expect(b.page.getByTestId("turn")).toHaveCount(3)
  await expect(b.page.getByTestId("conversation-divider")).toHaveCount(0)
  await b.ctx.close()
})

test("after a quiet while the next turn starts a new conversation, with its own divider", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await say(page, "What time is it in Tokyo?")
  await mock.idle(await deviceIdOf(page))
  await page.locator("#chat-input").fill("Good morning")
  await page.keyboard.press("Enter")
  const divider = page.getByTestId("conversation-divider")
  await expect(divider).toHaveText("New conversation — it had been quiet for a while")
  await expect(divider).toHaveAttribute("data-reason", "idle")
  await expect(page.getByTestId("turn")).toHaveCount(1)
  await expect(page.getByTestId("turn")).toContainText("Good morning")
})

test("one device too many: Start and typing say so in plain words, and the microphone is closed again", async ({ page, baseURL, browser }) => {
  await mock.scenario("typed")
  await mock.maxSessions(1)
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  const b = await device(browser, baseURL)
  await b.page.getByTestId("start").click()
  const error = b.page.getByTestId("audio-error")
  await expect(error).toContainText("The assistant is already talking on another device. Try again when it is done.")
  await expect(b.page.getByTestId("mic-toggle")).toBeHidden()
  await expect(b.page.getByTestId("toasts")).not.toContainText("already talking")
  // Typing on that device is refused the same way, under the message box.
  await openChat(b.page)
  await b.page.locator("#chat-input").fill("Anyone there?")
  await b.page.keyboard.press("Enter")
  await expect(b.page.getByTestId("chat-panel").getByRole("alert")).toContainText("already talking on another device")
  // The first device goes on.
  await expect(page.getByTestId("mic-toggle")).toBeVisible()
  await b.ctx.close()
})

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("New conversation is in the dock's More menu, and says it started", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("dock-more")).toBeVisible()
    await page.getByTestId("dock-more").click()
    await expect(page.getByTestId("dock-menu")).toBeVisible()
    await expect(page.getByTestId("dock-new-conversation")).toBeFocused()
    const box = await page.getByTestId("dock-new-conversation").boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    await page.getByTestId("dock-new-conversation").click()
    await expect(page.getByTestId("dock-menu")).toBeHidden()
    await expect(page.getByTestId("toasts")).toContainText("New conversation with Jeff. T3 keeps its own.")
    await page.getByTestId("chat-toggle").click()
    await expect(page.getByTestId("conversation-divider")).toHaveText("New conversation")
    await expect(page.getByTestId("turn")).toHaveCount(0)
    // The header button is there too, as an icon whose name says which assistant's conversation it starts.
    await expect(page.getByTestId("new-conversation")).toHaveAccessibleName("New conversation with Jeff (T3 keeps its own)")
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })

  test("Esc closes the More menu and gives focus back", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await page.goto(appUrl(baseURL))
    await page.getByTestId("dock-more").click()
    await expect(page.getByTestId("dock-menu")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("dock-menu")).toBeHidden()
    await expect(page.getByTestId("dock-more")).toBeFocused()
  })
})

test("desktop: the dock has no More button (the chat's header has New conversation)", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("chat-toggle")).toBeVisible()
  await expect(page.getByTestId("dock-more")).toBeHidden()
})

test("admin: Devices says which devices are talking now and what they do; Overview lists the sessions; the header counts them", async ({ page, baseURL, browser }) => {
  await mock.scenario("devices")
  const phone = await device(browser, baseURL, IPHONE)
  const desk = await device(browser, baseURL, MAC)
  await phone.page.getByTestId("start").click()
  await desk.page.getByTestId("start").click()
  await expectVisualState(phone.page, "listening")
  await expectVisualState(desk.page, "listening")
  await say(desk.page, "What time is it in Tokyo?")

  await loginAdmin(page, baseURL, "#settings/devices")
  const list = page.getByTestId("device-list")
  const phoneRow = list.locator(`[data-device="${await deviceIdOf(phone.page)}"]`)
  const deskRow = list.locator(`[data-device="${await deviceIdOf(desk.page)}"]`)
  await expect(phoneRow.getByTestId("talking-now")).toHaveText("Talking now")
  await expect(phoneRow.getByTestId("session-state")).toHaveText("listening")
  await expect(deskRow.getByTestId("talking-now")).toBeVisible()
  await expect(list.locator("[data-device=d-kitchen-ipad-0001]").getByTestId("talking-now")).toHaveCount(0)
  await expect(page.getByTestId("assistant-line")).toContainText("talking on 2 devices")

  // State changes reach the list live.
  await mock.state("thinking")
  await expect(list.getByTestId("session-state").filter({ hasText: "thinking" })).toHaveCount(1)
  await mock.state("listening")

  // The device page has its conversation.
  await deskRow.click()
  await expect(page.getByTestId("device-status")).toContainText("talking now, listening")
  await expect(page.getByTestId("device-conversation")).toContainText("3 turns") // the example history's two, and one more

  // Overview: both sessions, most recently active first, with the limit.
  await page.goto(page.url().replace(/#.*$/, "#settings/overview"))
  const sessions = page.getByTestId("sessions")
  await expect(sessions.locator("[data-session]")).toHaveCount(2)
  await expect(sessions.getByTestId("sessions-count")).toHaveText("2 talking · 2 of 4")
  await expect(sessions.locator("[data-session]").first()).toContainText("Mac · Chrome")
  await expect(sessions).toContainText("iPhone · Safari")

  // One device ends: it is no longer talking.
  await phone.page.getByTestId("end-session").click()
  await expect(sessions.locator('[data-talking="true"]')).toHaveCount(1)
  await expect(page.getByTestId("assistant-line")).toContainText("listening on Mac · Chrome")
  await phone.ctx.close()
  await desk.ctx.close()
})

test("admin: Diagnostics › Latency grows live with every device's turns, each row naming its device", async ({ page, baseURL, browser }) => {
  await mock.scenario("typed")
  await loginAdmin(page, baseURL, "#settings/diagnostics/latency")
  const rows = page.getByTestId("latency-table").locator("tbody tr")
  const before = await rows.count()
  const phone = await device(browser, baseURL, IPHONE)
  const desk = await device(browser, baseURL, MAC)
  await say(phone.page, "What time is it in Tokyo?")
  await say(desk.page, "Hello")
  // No reload, no new snapshot: the two turns arrive as admin `trace` messages.
  await expect(rows).toHaveCount(before + 2)
  await expect(rows.nth(0).getByTestId("trace-device")).toHaveText("Mac · Chrome")
  await expect(rows.nth(1).getByTestId("trace-device")).toHaveText("iPhone · Safari")
  // Turn ids repeat across sessions; every finished turn is its own row.
  await say(phone.page, "And now?")
  await expect(rows).toHaveCount(before + 3)
  await expect(rows.nth(0).getByTestId("trace-device")).toHaveText("iPhone · Safari")
  await phone.ctx.close()
  await desk.ctx.close()
})

test("admin: the phrase tester can follow one device's session", async ({ page, baseURL, browser }) => {
  await mock.scenario("devices")
  const phone = await device(browser, baseURL, IPHONE)
  const desk = await device(browser, baseURL, MAC)
  await phone.page.getByTestId("start").click()
  await desk.page.getByTestId("start").click()
  await expectVisualState(desk.page, "listening")
  await loginAdmin(page, baseURL, "#settings/devices/type-web-voice")
  const tester = page.getByTestId("phrase-tester")
  const picker = tester.getByTestId("tester-device")
  await expect(picker).toBeVisible()
  await expect(tester.getByTestId("tester-scope")).toContainText("Mac · Chrome") // the most recently active
  const phoneId = await deviceIdOf(phone.page)
  await picker.selectOption(phoneId)
  await expect(tester.getByTestId("tester-scope")).toContainText("iPhone · Safari")
  await tester.getByTestId("tester-listen").click()
  await expect(tester).toHaveAttribute("data-on", "true")
  const sent = (await mock.log()).messages.filter((m) => m.type === "wake.test")
  expect(sent.at(-1)).toMatchObject({ on: true, deviceId: phoneId })
  // Lines from the other device do not show; the followed one's do.
  await mock.heard("from the desk", undefined, undefined, await deviceIdOf(desk.page))
  await mock.heard("from the phone", undefined, undefined, phoneId)
  await expect(tester.getByTestId("heard-lines")).toContainText("from the phone")
  await expect(tester.getByTestId("heard-lines")).not.toContainText("from the desk")
  await tester.getByTestId("tester-stop").click()
  await phone.ctx.close()
  await desk.ctx.close()
})

test("admin: the quiet time is set on each assistant; the device page says so; the limit is a shared setting", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await loginAdmin(page, baseURL, "#settings/devices/type-web-voice")
  const help = page.getByTestId("conversation-help")
  await expect(help).toContainText("Each assistant keeps its own conversation on these browsers")
  await expect(help).toContainText("Jeff after 10 min quiet")
  await expect(help).toContainText("T3 never")
  await page.goto(page.url().replace(/#.*$/, "#settings/shared/limits"))
  await expect(page.getByRole("spinbutton", { name: "Devices talking at once" })).toHaveValue("4")
})
