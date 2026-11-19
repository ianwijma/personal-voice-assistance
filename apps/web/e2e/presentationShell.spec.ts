import { serverExamples } from "@pva/protocol/examples"
import type { Page } from "@playwright/test"
import type { AssistantClient } from "../src/lib/client.ts"
import { appUrl, expect, mock, test } from "./fixtures.ts"

const ui = (page: Page, patch: { sheetOpen?: boolean; shortcutsOpen?: boolean; chatOpen?: boolean }) => page.evaluate((patch) => {
  const client = (window as unknown as { __pva: AssistantClient }).__pva
  client.store.dispatch({ type: "local/ui", patch })
}, patch)

const pins = () => Array.from({ length: 4 }, (_, i) => ({ type: "present.show", presentation: {
  id: `p-shell-${i}`, revision: "r1", lifetime: "pinned", shownAt: i, serverNow: Date.now(), v: 1,
  content: { kind: "card", title: `Shopping ${i}`, text: "Buy some apples.", facts: [] }, buttons: [], interactive: false,
  texts: serverExamples["present.show"].presentation.texts
} }))

test.beforeEach(async () => { await mock.scenario("voice") })

for (const modal of ["sheetOpen", "shortcutsOpen"] as const) {
  test(`r4 b1: phone ${modal} is visible over four held pins, which return on close`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width: 390, height: 700 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    await mock.send(pins())
    await expect(page.getByTestId("presentation")).toHaveCount(4)
    await ui(page, { [modal]: true })
    const dialog = page.getByTestId(modal === "sheetOpen" ? "voice-sheet" : "help-dialog")
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId("present-stage")).toBeHidden()
    await expect(dialog.getByText(modal === "sheetOpen" ? "Microphone" : "Keyboard shortcuts", { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: info.outputPath(`${modal}-four-pins.png`) })
    // Hiding the already hidden stage must not change any dialog pixels.
    const before = await dialog.screenshot({ animations: "disabled" })
    await page.getByTestId("present-stage").evaluate((el) => { el.style.display = "none" })
    expect((await dialog.screenshot({ animations: "disabled" })).equals(before)).toBe(true)
    await page.getByTestId("present-stage").evaluate((el) => { el.style.removeProperty("display") })
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId("present-stage")).toBeVisible()
    await expect(page.getByTestId("presentation")).toHaveCount(4)
  })
}

for (const wide of [false, true]) {
  test(`r4 b2: Tab reaches ringing Stop and Enter sends one request with chat open (wide=${wide})`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width: wide ? 1280 : 390, height: 700 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    await mock.send(pins())
    await expect(page.getByTestId("presentation")).toHaveCount(4)
    await ui(page, { chatOpen: true })
    await expect(page.getByTestId("chat-panel")).toBeVisible()
    // A ring arrives after focus has already moved into chat.
    await mock.send([serverExamples["notification.ring"]])
    const stop = page.getByRole("button", { name: "Stop", exact: true })
    await expect(stop).toHaveCount(1)
    await expect(stop).toBeVisible()
    if (wide) await expect(page.getByTestId("presentations")).toBeVisible()
    else await expect(page.getByTestId("presentations")).toBeHidden()
    for (let i = 0; i < 20 && !(await stop.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab")
    await expect(stop).toBeFocused()
    await page.screenshot({ path: info.outputPath(`stop-focused-${wide ? "desktop" : "phone"}.png`) })
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "notification.action" && m.actionId === "stop").length).toBe(1)
    await expect(page.getByTestId("chat-panel")).toBeVisible()
  })
}

for (const keyboard of [false, true]) {
  test(`r5 b2: Send and Stop stay tappable with a six-line draft and an incoming ring (keyboard=${keyboard})`, async ({ page, baseURL }, info) => {
    await page.setViewportSize(keyboard ? { width: 375, height: 667 } : { width: 700, height: 320 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    await ui(page, { chatOpen: true })
    const draft = ["One", "Two", "Three", "Four", "Five", "Six"].join("\n")
    await page.locator("#chat-input").fill(draft)
    if (keyboard) await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 350 })
      window.visualViewport!.dispatchEvent(new Event("resize"))
    })
    const send = page.getByTestId("send")
    await expect(send).toBeEnabled()
    await send.click({ trial: true })
    await mock.send([serverExamples["notification.ring"]])
    const stop = page.getByRole("button", { name: "Stop", exact: true })
    await expect(stop).toBeVisible()
    // Wait out the notification's entrance animation and the textarea's resize layout.
    await page.getByTestId("notification-card").evaluate(async (el) => { await Promise.all(el.getAnimations().map((a) => a.finished)) })
    await expect.poll(async () => send.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const panel = el.closest("[data-testid=chat-panel]")!.getBoundingClientRect()
      const visibleBottom = window.visualViewport!.height + window.visualViewport!.offsetTop
      return r.top >= panel.top && r.bottom <= Math.min(panel.bottom, visibleBottom) && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })).toBe(true)
    await page.screenshot({ path: info.outputPath(`ring-draft-${keyboard ? "keyboard" : "landscape"}.png`) })
    await send.click()
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "text.send" && m.text === draft).length).toBe(1)
    await expect(page.locator("#chat-input")).toHaveValue("")
    await stop.scrollIntoViewIfNeeded()
    await stop.click()
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "notification.action" && m.actionId === "stop").length).toBe(1)
  })
}

for (const settleInChat of [false, true]) {
  test(`r5 b1: pending Snooze and its answer survive opening and closing phone chat (settleInChat=${settleInChat})`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 700 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    await page.evaluate(() => {
      const client = (window as unknown as { __pva: AssistantClient }).__pva
      const request = client.request
      let resolve!: (r: Awaited<ReturnType<typeof request>>) => void
      const requests: unknown[] = []
      Object.assign(client, { request: (m: Parameters<typeof request>[0]) => {
        if (m.type !== "notification.action") return request(m)
        requests.push(m)
        return new Promise<Awaited<ReturnType<typeof request>>>((done) => { resolve = done })
      } })
      Object.assign(window, { notificationPending: { requests, reply: () => resolve({ type: "result", requestId: "test-reply", ok: true, say: "Snoozed for ten minutes." }) } })
    })
    await mock.send([serverExamples["notification.ring"]])
    const snooze = page.getByRole("button", { name: "Snooze", exact: true })
    await snooze.click()
    await expect(snooze).toBeDisabled()
    await ui(page, { chatOpen: true })
    await expect(page.getByTestId("chat-panel")).toBeVisible()
    await expect(snooze).toBeDisabled()
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled()
    // A second physical click on the disabled action sends nothing.
    await snooze.dispatchEvent("click")
    expect(await page.evaluate("window.notificationPending.requests.length")).toBe(1)
    if (!settleInChat) await ui(page, { chatOpen: false })
    await page.evaluate("window.notificationPending.reply()")
    await expect(page.getByText("Snoozed for ten minutes.", { exact: true })).toBeVisible()
    await ui(page, { chatOpen: !settleInChat })
    await expect(page.getByText("Snoozed for ten minutes.", { exact: true })).toBeVisible()
    await expect(snooze).toBeEnabled()
    expect(await page.evaluate("window.notificationPending.requests.length")).toBe(1)
  })
}
