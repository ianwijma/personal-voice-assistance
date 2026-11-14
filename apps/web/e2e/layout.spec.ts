import { appUrl, expect, expectVisualState, gotoAdmin, mock, test } from "./fixtures.ts"

test("keyboard: ? shows shortcuts, C toggles the chat, S the settings sheet; single keys are ignored while typing", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.keyboard.press("?")
  await expect(page.getByRole("dialog", { name: "Help" })).toBeVisible()
  await expect(page.getByRole("dialog", { name: "Help" })).not.toContainText("Latency")
  await expect(page.getByRole("dialog", { name: "Help" }).getByTestId("audio-report")).toContainText("No replies played yet.")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Help" })).toBeHidden()
  await page.keyboard.press("c")
  await expect(page.getByTestId("chat-panel")).toBeVisible()
  await page.locator("#chat-input").fill("")
  await page.locator("#chat-input").press("s") // typing, not a shortcut
  await expect(page.getByTestId("voice-sheet")).toBeHidden()
  await expect(page.locator("#chat-input")).toHaveValue("s")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("chat-panel")).toBeHidden()
  await page.keyboard.press("s")
  await expect(page.getByTestId("voice-sheet")).toBeVisible()
  // Tab stays inside the sheet.
  for (let i = 0; i < 25; i++) await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.querySelector("[data-testid=voice-sheet]")!.contains(document.activeElement))).toBe(true)
  // The old settings shortcut does nothing on the voice page.
  await page.keyboard.press("Escape")
  await page.keyboard.press("o")
  await expect(page.getByTestId("settings")).toHaveCount(0)
})

test("single-key shortcuts can be switched off in the help dialog (WCAG 2.1.4), kept after a reload; Esc still works", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.keyboard.press("?")
  const help = page.getByTestId("help-dialog")
  const toggle = help.getByRole("switch", { name: "Keyboard shortcuts" })
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", "false")
  await expect(help).toContainText("Off: only Esc works")
  await page.keyboard.press("Escape")
  await expect(help).toBeHidden()
  await page.keyboard.press("c")
  await page.keyboard.press("s")
  await page.keyboard.press("?")
  await expect(page.getByTestId("chat-panel")).toBeHidden()
  await expect(page.getByTestId("voice-sheet")).toBeHidden()
  await expect(help).toBeHidden()
  await page.reload()
  await expect(page.getByTestId("start")).toBeVisible()
  await page.keyboard.press("c")
  await expect(page.getByTestId("chat-panel")).toBeHidden()
  // Without the shortcut, help opens from the sheet's More group; switch them back on there.
  await page.getByTestId("settings-toggle").click()
  await page.getByTestId("sheet-more").getByText("More").click()
  await page.getByTestId("open-help").click()
  await expect(help).toBeVisible()
  await help.getByRole("switch", { name: "Keyboard shortcuts" }).click()
  await page.keyboard.press("Escape")
  await page.keyboard.press("c")
  await expect(page.getByTestId("chat-panel")).toBeVisible()
})

test("the composer shows a focus ring", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("start")).toBeVisible()
  await page.keyboard.press("c")
  await expect(page.locator("#chat-input")).toBeEnabled()
  await page.locator("#chat-input").focus()
  await expect(page.locator("#chat-input")).toBeFocused()
  const outline = await page.locator("#chat-input").evaluate((el) => getComputedStyle(el.parentElement!).outlineStyle)
  expect(outline).toBe("solid")
})

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("start, 56 px controls, the chat and the settings as bottom sheets, 44 px targets in the sheet", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").tap()
    await expectVisualState(page, "listening")
    const mic = await page.getByTestId("mic-toggle").boundingBox()
    expect(Math.round(mic!.width)).toBe(56)
    const gear = await page.getByTestId("settings-toggle").boundingBox()
    expect(Math.round(gear!.width)).toBeGreaterThanOrEqual(44)
    await page.getByTestId("chat-toggle").tap()
    const panel = page.getByTestId("chat-panel")
    await expect.poll(async () => {
      const b = await panel.boundingBox()
      return b === null ? null : [b.x, Math.round(b.width), Math.round(b.y + b.height)]
    }).toEqual([0, 390, 844]) // after the slide-up animation
    await page.getByRole("button", { name: "Close conversation" }).tap()
    await page.getByTestId("settings-toggle").tap()
    const sheet = page.getByTestId("voice-sheet")
    await expect.poll(async () => {
      const b = await sheet.boundingBox()
      return b === null ? null : [b.x, Math.round(b.width), Math.round(b.y + b.height)]
    }).toEqual([0, 390, 844])
    for (const target of [sheet.getByRole("radio", { name: "Always listening" }), sheet.locator("#pref-mic"), sheet.getByTestId("admin-link"), sheet.getByRole("button", { name: "Close settings" })]) {
      const b = await target.boundingBox()
      expect(Math.round(b!.height)).toBeGreaterThanOrEqual(44)
    }
  })

  test("a phone can end the session: End session is visible, 44 px, apart from mute and stop", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").tap()
    await expectVisualState(page, "listening")
    const end = page.getByTestId("end-session")
    await expect(end).toBeVisible()
    await expect(end).toHaveText("End session")
    expect(Math.round((await end.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
    // Touch hint: what to tap, not which key.
    await expect(page.getByTestId("start-hint")).toContainText("Tap the microphone to mute")
    await end.tap()
    await expect(page.getByTestId("start")).toBeVisible()
    await expect(end).toHaveCount(0)
  })

  test("switches have a 44 px hit area around their compact track", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await page.evaluate(() => (window as unknown as { __pva: { store: { dispatch: (a: unknown) => void } } }).__pva.store.dispatch({ type: "local/ui", patch: { shortcutsOpen: true } }))
    const sw = page.getByTestId("help-dialog").getByRole("switch")
    await expect(sw).toBeVisible()
    await page.waitForTimeout(400) // the dialog's rise animation
    const b = (await sw.boundingBox())!
    const hits = await page.evaluate(([x, y, h]) => {
      const at = (yy: number) => document.elementFromPoint(x!, yy)?.closest("[role=switch]") !== null
      // 44 px tall: 10 px beyond the 24 px track on each side.
      return [at(y! - h! / 2 - 9.5), at(y! + h! / 2 + 9.5)]
    }, [b.x + b.width / 2, b.y + b.height / 2, b.height])
    expect(hits).toEqual([true, true])
  })

  test("no horizontal scrolling at 320 px, on the voice page, its sheet and the admin pages", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await mock.scenario("devices")
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(await overflow()).toBe(0)
    await page.getByTestId("settings-toggle").tap()
    await expect(page.getByTestId("voice-sheet")).toBeVisible()
    expect(await overflow()).toBe(0)
    for (const hash of ["#settings/frontends/web-voice", "#settings/devices/d-kitchen-ipad-0001", "#settings/speech/engine", "#settings/language-model/provider", "#settings/keys/keys"]) {
      await gotoAdmin(page, baseURL, hash)
      await expect(page.getByTestId("settings-page")).toBeVisible()
      const inner = await page.evaluate(() => {
        const panel = document.querySelector("[data-testid=settings-page]")!
        return [panel.scrollWidth - panel.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth]
      })
      expect(inner, hash).toEqual([0, 0])
    }
  })
})

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" })

  test("states still change and are labelled", async ({ page, baseURL }) => {
    await mock.scenario("voice")
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").click()
    await expectVisualState(page, "speaking", 10_000)
    await expect(page.getByTestId("state-label")).toHaveText(/speaking/i)
  })
})

/**
 * The stage and the dock never overlap on small and landscape phones, in every main state: the lowest thing on the
 * stage (the label, the captions, what is under them) ends above the dock's top.
 */
const stageClearOfDock = async (page: import("@playwright/test").Page, what: string) => {
  const r = await page.evaluate(() => {
    const dock = document.querySelector("[role=toolbar][aria-label=Controls]")!.getBoundingClientRect()
    const parts = [...document.querySelectorAll("[data-testid=state-label-box], [data-testid=captions] p, [data-testid=stage-below] > *")]
    const boxes = parts.map((e) => e.getBoundingClientRect()).filter((b) => b.height > 0 && b.width > 0)
    return { bottom: Math.max(...boxes.map((b) => b.bottom)), dockTop: dock.top }
  })
  expect(r.bottom, `${what}: stage content ends at ${r.bottom}, the dock starts at ${r.dockTop}`).toBeLessThanOrEqual(r.dockTop)
}

for (const [width, height] of [[320, 568], [360, 640], [375, 667], [667, 375]] as const) {
  test.describe(`small screen ${width} × ${height}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true })

    test("the stage never runs under the dock: not started, listening, muted, observer, speaking, microphone error", async ({ page, browser, baseURL }) => {
      await mock.scenario("typed")
      await page.goto(appUrl(baseURL))
      await expect(page.getByTestId("start")).toBeVisible()
      await page.waitForTimeout(400)
      await stageClearOfDock(page, "not started")
      // Short screens: the dock's chat button is right there, so "or type instead" goes.
      if (height <= 600) await expect(page.getByTestId("type-instead")).toBeHidden()
      else await expect(page.getByTestId("type-instead")).toBeVisible()
      await page.getByTestId("start").tap()
      await expectVisualState(page, "listening")
      await expect(page.getByTestId("start-hint")).toBeVisible()
      await stageClearOfDock(page, "listening, with the start hint")
      await page.getByTestId("mic-toggle").tap()
      await expectVisualState(page, "muted")
      await stageClearOfDock(page, "muted")

      const observer = await page.context().newPage()
      await observer.goto(appUrl(baseURL))
      await expect(observer.getByTestId("observer-banner")).toBeVisible()
      await stageClearOfDock(observer, "observer")
      await observer.close()
      await page.getByTestId("end-session").tap()
      await expect(page.getByTestId("start")).toBeVisible()

      await mock.scenario("voice")
      await page.goto(appUrl(baseURL))
      await page.getByTestId("start").tap()
      await expectVisualState(page, "speaking", 10_000)
      await page.waitForFunction(() => (document.querySelector("[data-testid=captions]")?.textContent ?? "").length > 20)
      await stageClearOfDock(page, "speaking, with captions")
      await page.getByTestId("end-session").tap()

      const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, permissions: ["microphone"] })
      const denied = await ctx.newPage()
      await denied.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"))
      })
      await denied.goto(appUrl(baseURL))
      await denied.getByTestId("start").tap()
      await expect(denied.getByTestId("audio-error")).toBeVisible()
      await stageClearOfDock(denied, "microphone error")
      await ctx.close()
    })
  })
}

test("a modal panel owns the keyboard: with Help or the sheet open, C, / and S do nothing and the page behind is inert", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("start")).toBeVisible()
  await page.keyboard.press("?")
  const help = page.getByTestId("help-dialog")
  await expect(help).toBeVisible()
  for (const key of ["c", "/", "s"]) await page.keyboard.press(key)
  await expect(page.getByTestId("chat-panel")).toBeHidden()
  await expect(page.getByTestId("voice-sheet")).toBeHidden()
  expect(await page.evaluate(() => document.querySelector("[data-testid=help-dialog]")!.contains(document.activeElement))).toBe(true)
  expect(await page.getByTestId("page-behind").evaluate((el) => (el as HTMLElement).inert)).toBe(true)
  await page.keyboard.press("Escape")
  await expect(help).toBeHidden()
  expect(await page.getByTestId("page-behind").evaluate((el) => (el as HTMLElement).inert)).toBe(false)
  // The sheet's button into Help: one modal at a time; closing Help returns focus to the gear.
  await page.getByTestId("settings-toggle").click()
  await page.getByTestId("sheet-more").getByText("More").click()
  await page.getByTestId("open-help").click()
  await expect(help).toBeVisible()
  await expect(page.getByTestId("voice-sheet")).toBeHidden()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("settings-toggle")).toBeFocused()
})

test("the chat popover on a wide screen is not modal: Tab leaves it for the page", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await page.keyboard.press("c")
  const panel = page.getByTestId("chat-panel")
  await expect(panel).not.toHaveAttribute("aria-modal", "true")
  await expect(page.locator("#chat-input")).toBeFocused()
  let left = false
  for (let i = 0; i < 6 && !left; i++) {
    await page.keyboard.press("Tab")
    left = await page.evaluate(() => !document.querySelector("[data-testid=chat-panel]")!.contains(document.activeElement))
  }
  expect(left).toBe(true)
  await expect(page.getByRole("heading", { level: 1, name: "Voice assistant" })).toBeAttached()
})

test("a refused sheet change is shown in the sheet, next to its control, until dismissed; a voice choice is confirmed", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("start")).toBeVisible()
  await page.getByTestId("settings-toggle").click()
  const sheet = page.getByTestId("voice-sheet")
  await sheet.locator("[data-voice]").nth(1).click()
  await expect(sheet.getByTestId("voice-note")).toHaveText("Used from the next reply.")
  // A stale list: a voice the assistant no longer has.
  await page.evaluate(() => {
    const c = (window as unknown as { __pva: { store: { get: () => { summary: { voices: ReadonlyArray<unknown> } }; dispatch: (a: unknown) => void } } }).__pva
    const s = c.store.get().summary
    c.store.dispatch({ type: "engine.summary", engine: { ...s, voices: [...s.voices, { name: "expressive", description: "Lively, through Cartesia.", isDefault: false }] } })
  })
  await sheet.locator("[data-voice=expressive]").click()
  const error = sheet.getByTestId("sheet-error")
  await expect(error).toHaveText(/Not changed: Expressive is switched off in admin\./)
  await expect(error).toHaveAttribute("role", "alert")
  await expect(page.getByTestId("toasts").locator("[role=alert]")).toHaveCount(0)
  await page.waitForTimeout(6500) // longer than a toast lives
  await expect(error).toBeVisible()
  await error.getByRole("button", { name: "Dismiss this message" }).click()
  await expect(error).toHaveCount(0)
})
