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
    await expect(page.getByTestId("presentations")).toBeHidden()
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
    const panelBefore = await page.getByTestId("chat-panel").boundingBox()
    const sendBefore = await send.boundingBox()
    await mock.send([serverExamples["notification.ring"]])
    const stop = page.getByRole("button", { name: "Stop", exact: true })
    await expect(stop).toBeVisible()
    expect(await page.getByTestId("chat-panel").boundingBox()).toEqual(panelBefore)
    expect(await send.boundingBox()).toEqual(sendBefore)
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

const shopping = () => ({ type: "present.show", presentation: {
  ...serverExamples["present.show"].presentation,
  id: "p-menu-shopping", revision: "shopping:1", lifetime: "pinned", interactive: true,
  content: { kind: "list", title: "Shopping", style: "checklist", items: [{ id: "milk", text: "Milk", done: false }] },
  buttons: []
} })

/** A complete button inside every clipping ancestor, with an unobstructed pointer target. */
const tappable = (el: Element) => {
  const r = el.getBoundingClientRect()
  if (r.height < 44 || r.top < 0 || r.bottom > window.visualViewport!.height) return false
  for (let p = el.parentElement; p !== null && p !== document.body; p = p.parentElement) {
    if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowY)) {
      const box = p.getBoundingClientRect()
      if (r.top < box.top || r.bottom > box.bottom) return false
    }
  }
  return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
}

test("r6 b1: an arriving checklist cannot take the open More menu's tap", async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(appUrl(baseURL))
  const item = page.getByTestId("dock-new-conversation")
  await page.getByTestId("dock-more").click()
  await expect(item).toBeVisible()
  const point = await item.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  await mock.send([shopping()])
  await expect(page.getByTestId("presentation")).toHaveCount(1)
  await page.screenshot({ path: info.outputPath("more-over-checklist.png") })
  await page.mouse.click(point.x, point.y)
  await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "conversation.new").length).toBe(1)
  expect((await mock.log()).messages.filter((m) => m.type === "present.action")).toHaveLength(0)
})

for (const keyboard of [false, true]) {
  test(`r6 b2: Stop precedes Send without losing a six-line draft at 300px (keyboard=${keyboard})`, async ({ page, baseURL }, info) => {
    await mock.device({ assistants: [{ assistant: "jeff", phrases: [] }, { assistant: "t3", phrases: ["hey t3"] }], withoutPhrase: { mode: "assistant", assistant: "jeff" } })
    await page.setViewportSize({ width: 375, height: 667 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    await ui(page, { chatOpen: true })
    await expect(page.getByTestId("conversation-note")).toBeVisible()
    const draft = "One\nTwo\nThree\nFour\nFive\nSix"
    await page.locator("#chat-input").fill(draft)
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 300 })
      window.visualViewport!.dispatchEvent(new Event("resize"))
    })
    await mock.send([serverExamples["notification.ring"]])
    const stop = page.getByRole("button", { name: "Stop", exact: true })
    await expect(stop).toHaveCount(1)
    await expect.poll(() => stop.evaluate(tappable)).toBe(true)
    await page.screenshot({ path: info.outputPath(`stop-before-send-${keyboard}.png`) })
    if (keyboard) {
      for (let i = 0; i < 20 && !(await stop.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab")
      await expect(stop).toBeFocused()
      await page.keyboard.press("Enter")
    } else await stop.click()
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "notification.action" && m.actionId === "stop").length).toBe(1)
    await expect(page.locator("#chat-input")).toHaveValue(draft)
    expect((await mock.log()).messages.filter((m) => m.type === "text.send")).toHaveLength(0)
    await page.getByTestId("send").click()
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "text.send" && m.text === draft).length).toBe(1)
  })
}

for (const width of [375, 1280]) for (const surface of ["more", "assistant", "conversation", "settings", "help", "chat"] as const) {
  if (surface === "more" && width === 1280) continue
  test(`r6: ${surface} keeps arriving presentations inert and a ring's Stop usable (width=${width})`, async ({ page, baseURL }, info) => {
    await mock.device({ assistants: [{ assistant: "jeff", phrases: [] }, { assistant: "t3", phrases: ["hey t3"] }], withoutPhrase: { mode: "assistant", assistant: "jeff" } })
    await page.setViewportSize({ width, height: 700 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    if (surface === "more") await page.getByTestId("dock-more").click()
    if (surface === "assistant") await page.getByTestId("assistant-menu-button").click()
    if (surface === "settings") await ui(page, { sheetOpen: true })
    if (surface === "help") await ui(page, { shortcutsOpen: true })
    if (surface === "chat" || surface === "conversation") await ui(page, { chatOpen: true })
    if (surface === "conversation") await page.getByTestId("conversation-switcher").click()
    await mock.send([shopping()])
    const stage = page.getByTestId("present-stage")
    await expect(stage).toBeHidden()
    expect(await stage.evaluate((el) => el.closest("[inert]") !== null)).toBe(true)
    await mock.send([serverExamples["notification.ring"]])
    const stop = page.getByRole("button", { name: "Stop", exact: true })
    await expect(stop).toHaveCount(1)
    await expect.poll(() => stop.evaluate(tappable)).toBe(true)
    expect(await stop.evaluate((el) => el.closest("[inert]") !== null)).toBe(false)
    await page.screenshot({ path: info.outputPath(`${surface}-${width}-ring.png`) })
    for (let i = 0; i < 25 && !(await stop.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab")
    await expect(stop).toBeFocused()
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "notification.action" && m.actionId === "stop").length).toBe(1)
    expect((await mock.log()).messages.filter((m) => m.type === "present.action")).toHaveLength(0)
  })
}

for (const target of ["settings", "help", "chat"] as const) {
  test(`r6: ${target} takes notification controls from an already open More menu`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    await page.getByTestId("dock-more").click()
    await page.keyboard.press(target === "settings" ? "s" : target === "help" ? "?" : "c")
    await expect(page.getByTestId("dock-menu")).toHaveCount(0)
    await mock.send([serverExamples["notification.ring"]])
    const stop = page.getByRole("button", { name: "Stop", exact: true })
    await expect(stop).toHaveCount(1)
    await expect.poll(() => stop.evaluate(tappable)).toBe(true)
    expect(await stop.evaluate((el) => el.closest("[inert]") !== null)).toBe(false)
    for (let i = 0; i < 25 && !(await stop.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab")
    await expect(stop).toBeFocused()
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "notification.action" && m.actionId === "stop").length).toBe(1)
  })
}

test("r6: the conversation menu keeps Stop above a phone keyboard without clearing the draft", async ({ page, baseURL }) => {
  await mock.device({ assistants: [{ assistant: "jeff", phrases: [] }, { assistant: "t3", phrases: ["hey t3"] }], withoutPhrase: { mode: "assistant", assistant: "jeff" } })
  await page.setViewportSize({ width: 375, height: 667 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("start")).toBeVisible()
  await ui(page, { chatOpen: true })
  const draft = "One\nTwo\nThree\nFour\nFive\nSix"
  await page.locator("#chat-input").fill(draft)
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 300 })
    window.visualViewport!.dispatchEvent(new Event("resize"))
  })
  await page.getByTestId("conversation-switcher").click()
  await mock.send([serverExamples["notification.ring"]])
  const stop = page.getByRole("button", { name: "Stop", exact: true })
  await expect(stop).toHaveCount(1)
  await expect.poll(() => stop.evaluate(tappable)).toBe(true)
  for (let i = 0; i < 25 && !(await stop.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab")
  await expect(stop).toBeFocused()
  await expect.poll(() => stop.evaluate(tappable)).toBe(true)
  await page.keyboard.press("Enter")
  await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "notification.action" && m.actionId === "stop").length).toBe(1)
  await expect(page.locator("#chat-input")).toHaveValue(draft)
  expect((await mock.log()).messages.filter((m) => m.type === "text.send")).toHaveLength(0)
})

test("r6: resizing past the phone More menu keeps Stop in the fixed notification region", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("start")).toBeVisible()
  await page.getByTestId("dock-more").click()
  await mock.send([serverExamples["notification.ring"]])
  await expect(page.getByTestId("voice-notifications").getByRole("button", { name: "Stop", exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 700 })
  await expect(page.getByTestId("dock-menu")).toHaveCount(0)
  const stop = page.getByRole("button", { name: "Stop", exact: true })
  await expect(stop).toHaveCount(1)
  await expect.poll(() => stop.evaluate(tappable)).toBe(true)
  await stop.click()
  await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "notification.action" && m.actionId === "stop").length).toBe(1)
})

for (const surface of ["assistant", "more", "conversation"] as const) {
  test(`r7 b1: a ring never replaces the aimed-at ${surface} menu item`, async ({ page, baseURL }, info) => {
    await mock.device({ assistants: [{ assistant: "jeff", phrases: [] }, { assistant: "t3", phrases: ["hey t3"] }], withoutPhrase: { mode: "assistant", assistant: "jeff" } })
    await page.setViewportSize({ width: 375, height: 667 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    if (surface === "conversation") await ui(page, { chatOpen: true })
    await page.getByTestId(surface === "assistant" ? "assistant-menu-button" : surface === "more" ? "dock-more" : "conversation-switcher").click()
    const menu = page.getByTestId(surface === "assistant" ? "assistant-menu-button-menu" : surface === "more" ? "dock-menu" : "conversation-switcher-menu")
    const item = surface === "more" ? page.getByTestId("dock-new-conversation") : surface === "assistant" ? page.getByTestId("assistant-jeff") : menu.getByRole("menuitemradio").last()
    // Save the stable target after the menu (and its containing chat sheet) has finished opening.
    await menu.evaluate(async (el) => { await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)) })
    if (surface === "conversation") await page.getByTestId("chat-panel").evaluate(async (el) => { await Promise.all(el.getAnimations().map((a) => a.finished)) })
    const before = await item.boundingBox()
    const menuBefore = await menu.boundingBox()
    const labels = await menu.getByRole(surface === "more" ? "menuitem" : "menuitemradio").allTextContents()
    const request = surface === "assistant" ? "device.pick" : surface === "more" ? "conversation.new" : "conversation.read"
    const countBefore = (await mock.log()).messages.filter((m) => m.type === request).length
    if (before === null) throw new Error("Menu item has no box")
    await page.screenshot({ path: info.outputPath(`${surface}-before-ring.png`) })
    await mock.send([serverExamples["notification.ring"]])
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(1)
    await expect(menu).toBeVisible()
    expect(await menu.boundingBox()).toEqual(menuBefore)
    expect(await item.boundingBox()).toEqual(before)
    expect(await menu.getByRole(surface === "more" ? "menuitem" : "menuitemradio").allTextContents()).toEqual(labels)
    await expect(menu.getByTestId("notification-cards")).toHaveCount(0)
    await expect.poll(() => page.getByRole("button", { name: "Stop", exact: true }).evaluate(tappable)).toBe(true)
    await page.screenshot({ path: info.outputPath(`${surface}-after-ring.png`) })
    // Removing and re-showing a ring must preserve the same menu and tap target too.
    await mock.send([{ type: "notification.resolved", id: serverExamples["notification.ring"].notification.id, outcome: "stop" }])
    await expect(page.getByTestId("notification-card")).toHaveCount(0)
    expect(await item.boundingBox()).toEqual(before)
    await mock.send([serverExamples["notification.ring"]])
    await expect(page.getByTestId("notification-card")).toHaveCount(1)
    expect(await menu.boundingBox()).toEqual(menuBefore)
    expect(await item.boundingBox()).toEqual(before)
    // Press the originally aimed-at coordinates, not a locator that follows a moved item.
    await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2)
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === request).length).toBe(countBefore + 1)
    expect((await mock.log()).messages.filter((m) => m.type === "notification.action")).toHaveLength(0)
  })
}


for (const modal of ["sheetOpen", "shortcutsOpen"] as const) {
  test(`r7 b1: ${modal} includes the fixed ring in its keyboard scope while chat is covered`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    await ui(page, { chatOpen: true })
    await page.locator("#chat-input").fill("Keep this draft")
    await ui(page, { [modal]: true })
    const dialog = page.getByTestId(modal === "sheetOpen" ? "voice-sheet" : "help-dialog")
    await expect(dialog).toBeVisible()
    await dialog.evaluate(async (el) => { await Promise.all(el.getAnimations().map((a) => a.finished)) })
    const before = await dialog.boundingBox()
    await mock.send([serverExamples["notification.ring"]])
    const stop = page.getByRole("button", { name: "Stop", exact: true })
    await expect(stop).toHaveCount(1)
    expect(await dialog.boundingBox()).toEqual(before)
    for (let i = 0; i < 25 && !(await stop.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab")
    await expect(stop).toBeFocused()
    await expect.poll(() => stop.evaluate(tappable)).toBe(true)
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "notification.action" && m.actionId === "stop").length).toBe(1)
    await expect(dialog).toBeVisible()
    await expect(page.locator("#chat-input")).toHaveValue("Keep this draft")
  })
}

for (const width of [375, 768]) {
  test(`r8 b1: a timer ringing over a silent reminder owns the visible Stop (width=${width})`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: width === 375 ? 667 : 1024 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    await page.evaluate(() => {
      const client = (window as unknown as { __pva: AssistantClient }).__pva
      client.store.dispatch({ type: "local/audio", phase: "running" })
    })
    const timer = serverExamples["notification.ring"]
    const reminder = { ...timer, notification: { ...timer.notification, id: "n-reminder", title: "Laundry reminder", priority: "normal", sound: false, actions: [{ id: "stop", label: "Stop" }], sentAt: timer.notification.sentAt - 60_000 } }
    await mock.send([reminder])
    const strip = page.getByTestId("voice-notifications")
    const region = strip.getByTestId("notification-cards")
    await expect(strip.getByTestId("notification-card")).toHaveCount(1)
    const before = await strip.boundingBox()
    const settingsBefore = await page.getByTestId("settings-toggle").boundingBox()
    await strip.screenshot({ path: info.outputPath("silent-reminder.png"), animations: "disabled" })
    await mock.send([timer])
    await expect(strip.getByTestId("notification-card")).toHaveCount(2)
    const timerCard = strip.getByTestId("notification-card").filter({ has: page.getByRole("heading", { name: timer.notification.title, exact: true }) })
    const stop = timerCard.getByRole("button", { name: "Stop", exact: true })
    // Check the full target before clicking: Playwright must not scroll a hidden timer into view for us.
    await expect.poll(() => stop.evaluate(tappable)).toBe(true)
    await expect(region.getByTestId("notification-card").first()).toHaveAttribute("data-ringing", "true")
    await expect(timerCard.getByTestId("notification-more")).toHaveText(`+1 ${timer.notification.texts.region}`)
    expect(await timerCard.evaluate((card) => ["h2", "[data-testid=notification-more]"].every((selector) => {
      const el = card.querySelector(selector)!
      const r = el.getBoundingClientRect()
      const bounds = card.closest("[data-testid=notification-cards]")!.getBoundingClientRect()
      return r.top >= bounds.top && r.bottom <= bounds.bottom && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    }))).toBe(true)
    expect(await region.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    expect(await strip.boundingBox()).toEqual(before)
    expect(await page.getByTestId("settings-toggle").boundingBox()).toEqual(settingsBefore)
    await strip.screenshot({ path: info.outputPath("timer-over-reminder.png"), animations: "disabled" })
    const point = await stop.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    await page.mouse.click(point.x, point.y)
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "notification.action").map((m) => ({ id: m.id, actionId: m.actionId }))).toEqual([{ id: timer.notification.id, actionId: "stop" }])
    await mock.send([{ type: "notification.resolved", id: timer.notification.id, outcome: "stop" }])
    await expect(strip.getByTestId("notification-card")).toHaveCount(1)
    await expect(strip.getByRole("heading", { name: "Laundry reminder", exact: true })).toBeVisible()
    await expect.poll(() => strip.getByRole("button", { name: "Stop", exact: true }).evaluate(tappable)).toBe(true)
  })
}

test("r9 b1: focus follows the leading ring so Enter stops the timer, not the hidden reminder", async ({ page, baseURL }, info) => {
  for (const width of [375, 768]) {
    await mock.scenario("voice")
    await page.setViewportSize({ width, height: width === 375 ? 667 : 1024 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    await page.evaluate(() => {
      const client = (window as unknown as { __pva: AssistantClient }).__pva
      client.store.dispatch({ type: "local/audio", phase: "running" })
    })
    const timer = serverExamples["notification.ring"]
    const reminder = { ...timer, notification: { ...timer.notification, id: "n-reminder", title: "Laundry reminder", priority: "normal", sound: false, actions: [{ id: "stop", label: "Stop" }], sentAt: timer.notification.sentAt - 60_000 } }
    await mock.send([reminder])
    const strip = page.getByTestId("voice-notifications")
    const reminderCard = strip.getByTestId("notification-card").filter({ has: page.getByRole("heading", { name: "Laundry reminder", exact: true }) })
    const reminderStop = reminderCard.getByRole("button", { name: "Stop", exact: true })
    await expect(reminderStop).toBeVisible()
    for (let i = 0; i < 45 && !(await reminderStop.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab")
    await expect(reminderStop).toBeFocused()
    await expect.poll(() => reminderStop.evaluate(tappable)).toBe(true)
    const before = await strip.boundingBox()
    await strip.screenshot({ path: info.outputPath(`r9-${width}-before-ring.png`), animations: "disabled" })
    await mock.send([timer])
    const timerCard = strip.getByTestId("notification-card").filter({ has: page.getByRole("heading", { name: timer.notification.title, exact: true }) })
    const timerStop = timerCard.getByRole("button", { name: "Stop", exact: true })
    await expect.poll(() => timerStop.evaluate(tappable)).toBe(true)
    const timerHasFocus = await timerStop.evaluate((el) => el === document.activeElement)
    expect(await reminderStop.evaluate(tappable)).toBe(false)
    expect(await strip.boundingBox()).toEqual(before)
    await strip.screenshot({ path: info.outputPath(`r9-${width}-after-ring.png`), animations: "disabled" })
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "notification.action").map((m) => ({ id: m.id, actionId: m.actionId }))).toEqual([{ id: timer.notification.id, actionId: "stop" }])
    expect(timerHasFocus).toBe(true)
    await mock.send([{ type: "notification.resolved", id: timer.notification.id, outcome: "stop" }])
    await expect(strip.getByTestId("notification-card")).toHaveCount(1)
    await expect(reminderCard).toBeVisible()
    await expect.poll(() => reminderStop.evaluate(tappable)).toBe(true)
  }
})
