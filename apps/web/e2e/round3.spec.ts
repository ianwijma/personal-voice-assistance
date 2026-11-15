import { type Page } from "@playwright/test"
import { ADMIN_PASSWORD, appUrl, expect, expectVisualState, gotoAdmin, loginAdmin, mock, test } from "./fixtures.ts"

// Review round 3 (docs/FRONTENDS-AND-ACTIVATION.md, Status): focus in dialogs and after Start / End, the login after a
// wrong password, long wake phrases, the admin title on phones, the Log out check, the tester, markers, nav marks.

const LONG = "hello my personal voice assistant please"

const stageClearOfDock = (page: Page) =>
  page.evaluate(() => {
    const dock = document.querySelector("[role=toolbar][aria-label=Controls]")!.getBoundingClientRect()
    const parts = [...document.querySelectorAll("[data-testid=state-label-box], [data-testid=captions] p, [data-testid=stage-below] > *")]
    const boxes = parts.map((e) => e.getBoundingClientRect()).filter((b) => b.height > 0 && b.width > 0)
    return { bottom: Math.max(...boxes.map((b) => b.bottom)), dockTop: dock.top }
  })

test.describe("focus", () => {
  test("the chat while the assistant is not ready: focus goes into the dialog and Esc closes it", async ({ page, baseURL }) => {
    await mock.scenario("engine-failed")
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("engine-banner")).toBeVisible()
    await page.getByTestId("chat-toggle").click()
    const chat = page.getByTestId("chat-panel")
    await expect(chat).toBeVisible()
    await expect(page.locator("#chat-input")).toBeDisabled()
    expect(await page.evaluate(() => document.querySelector("[data-testid=chat-panel]")!.contains(document.activeElement))).toBe(true)
    await page.keyboard.press("Escape")
    await expect(chat).toBeHidden()
  })

  test("Start by keyboard puts focus on the microphone button and says Listening once; End session puts it on Start and says Session ended", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await page.goto(appUrl(baseURL))
    const start = page.getByTestId("start")
    await expect(start).toBeVisible()
    await start.focus()
    await page.keyboard.press("Enter")
    await expectVisualState(page, "listening")
    await expect(page.getByTestId("mic-toggle")).toBeFocused()
    const announcer = page.getByTestId("state-announcer")
    await expect(announcer).toHaveText("Listening")
    // A later hearing / listening round trip does not say it again.
    await mock.state("hearing")
    await expect(announcer).toHaveText("")
    await mock.state("listening")
    await expectVisualState(page, "listening")
    await expect(announcer).toHaveText("")
    await page.getByTestId("end-session").focus()
    await page.keyboard.press("Enter")
    await expect(start).toBeVisible()
    await expect(start).toBeFocused()
    await expect(announcer).toHaveText("Session ended")
  })

  test("admin login: after a wrong password the field keeps focus and typing works without a click", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await page.goto(appUrl(baseURL, "", "/admin/"))
    const input = page.locator("#admin-password")
    await input.fill("wrong one")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("login-error")).toContainText("not right")
    await expect(input).toBeFocused()
    await page.keyboard.type(ADMIN_PASSWORD)
    await expect(input).toHaveValue(ADMIN_PASSWORD)
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("settings")).toBeVisible()
  })

  test("the Forget dialog: the background is inert, focus stays inside, Esc closes", async ({ page, baseURL }) => {
    await mock.scenario("devices")
    await loginAdmin(page, baseURL, "#settings/devices/d-kitchen-ipad-0001")
    await page.getByTestId("forget").click()
    const dialog = page.getByTestId("forget-dialog")
    await expect(dialog).toBeVisible()
    expect(await page.getByTestId("admin-header").evaluate((el) => (el as HTMLElement).inert)).toBe(true)
    expect(await page.getByTestId("rename").evaluate((el) => el.closest("[inert]") !== null)).toBe(true)
    expect(await dialog.evaluate((el) => el.closest("[inert]") !== null)).toBe(false)
    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab")
    expect(await page.evaluate(() => document.querySelector("[data-testid=forget-dialog]")!.contains(document.activeElement))).toBe(true)
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    expect(await page.getByTestId("admin-header").evaluate((el) => (el as HTMLElement).inert)).toBe(false)
  })
})

test.describe("long wake phrases", () => {
  for (const [width, height] of [[320, 568], [390, 844]] as const) {
    test.describe(`voice ${width} × ${height}`, () => {
      test.use({ viewport: { width, height }, hasTouch: true, isMobile: true })
      test("asleep: the whole phrase wraps, the layout does not jump and stays above the dock", async ({ page, baseURL }) => {
        await mock.scenario("long-phrase")
        await page.goto(appUrl(baseURL))
        await page.getByTestId("start").tap()
        await expectVisualState(page, "asleep")
        const label = page.getByTestId("state-label")
        await expect(label).toHaveText("Say “Hello My Personal Voice Assistant Please”")
        const fits = await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis")
        expect(fits).toBe(true)
        const below = async () => Math.round((await page.getByTestId("state-label-box").boundingBox())!.y + (await page.getByTestId("state-label-box").boundingBox())!.height)
        const asleepBottom = await below()
        const r = await stageClearOfDock(page)
        expect(r.bottom).toBeLessThanOrEqual(r.dockTop)
        // Woke: the box keeps its height, so what is under the label does not move.
        await mock.wake("hello my personal voice assistant please", true)
        await expect(label).toHaveText("Listening…")
        expect(await below()).toBe(asleepBottom)
      })
    })
  }

  test.describe("admin devices at 320 px", () => {
    test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true })
    test("the row wraps the phrase, keeps its last word with “+2”, has no dangling separator and drops the kind", async ({ page, baseURL }) => {
      await mock.scenario("long-phrase")
      await gotoAdmin(page, baseURL, "#settings/devices")
      const row = page.getByTestId("device-list").locator("[data-device=d-living-room-0003]")
      await expect(row).toBeVisible()
      const phrase = row.getByTestId("device-phrase")
      await expect(phrase).toHaveText(`“${LONG}” +2`)
      const box = (await phrase.boundingBox())!
      expect(box.height).toBeGreaterThan(20) // more than one line
      const rowBox = (await row.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width)
      // The last word and the count are one unit.
      expect(await phrase.locator("span").innerText()).toBe("please” +2")
      // No separators on a phone (they exist from 640 px), and the kind is not shown.
      const contents = await row.getByTestId("device-meta").locator("> span").evaluateAll((els) => els.map((e) => getComputedStyle(e, "::before").content))
      for (const c of contents) expect(["none", "normal", '""']).toContain(c)
      await expect(row.getByTestId("device-meta").locator("> span").last()).toBeHidden()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })

    test("the phrase editor shows every phrase whole", async ({ page, baseURL }) => {
      await mock.scenario("long-phrase")
      await gotoAdmin(page, baseURL, "#settings/frontends/web-voice")
      const text = page.getByTestId("phrase-list").getByTestId("phrase-text").first()
      await expect(text).toHaveText("Hello My Personal Voice Assistant Please")
      expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis")).toBe(true)
    })

    test("the page title is shown in full on a phone", async ({ page, baseURL }) => {
      await mock.scenario("devices")
      await gotoAdmin(page, baseURL, "#settings/frontends/web-voice")
      const title = page.getByTestId("page-title")
      await expect(title).toBeVisible()
      await expect(title).toHaveText("Voice assistant in a browser")
      expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    })
  })
})

test.describe("admin wording and states", () => {
  test("Log out with unsaved changes asks first; Stay keeps the page, Discard and log out leaves", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await loginAdmin(page, baseURL, "#settings/speech/turn-timing")
    await page.getByTestId("settings-page").locator("input[type=number]").first().fill("700")
    await page.getByTestId("logout").click()
    const dialog = page.getByTestId("leave-dialog")
    await expect(dialog).toContainText("Leave without saving?")
    await dialog.getByRole("button", { name: "Stay" }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId("settings")).toBeVisible()
    await page.getByTestId("logout").click()
    await page.getByTestId("leave-dialog").getByRole("button", { name: "Discard and log out" }).click()
    await expect(page.getByTestId("login-form")).toBeVisible()
  })

  test("Log out without changes goes straight to the login", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await loginAdmin(page, baseURL, "#settings/overview")
    await page.getByTestId("logout").click()
    await expect(page.getByTestId("login-form")).toBeVisible()
  })

  test("the phrase tester says Ready to test while idle and Testing while listening; its settings note covers the follow-up time", async ({ page, baseURL, context }) => {
    await mock.scenario("devices")
    const voice = await context.newPage()
    await voice.goto(appUrl(baseURL))
    await voice.getByTestId("start").click()
    await expectVisualState(voice, "listening")
    await mock.defaults({ activation: "wake-phrase" })
    await loginAdmin(page, baseURL, "#settings/frontends/web-voice")
    const tester = page.getByTestId("phrase-tester")
    const scope = tester.getByTestId("tester-scope")
    await expect(scope).toContainText("Ready to test")
    await expect(scope).not.toContainText("Testing")
    await tester.getByTestId("tester-listen").click()
    await expect(scope).toContainText("Testing")
    await expect(scope).not.toContainText("Ready to test")
    await tester.getByTestId("tester-stop").click()
    await expect(scope).toContainText("Ready to test")
    await voice.close()
  })

  test("a device override equal to the default is still marked Override, and says so for assistive technology", async ({ page, baseURL }) => {
    await mock.scenario("devices")
    await mock.defaults({ followUpSeconds: 15 })
    await loginAdmin(page, baseURL, "#settings/devices/d-kitchen-ipad-0001")
    const followUp = page.locator("[data-field=followUpSeconds]")
    await expect(followUp.getByTestId("custom-marker")).toHaveText(/Override/)
    await expect(followUp.getByTestId("custom-marker")).toContainText("same as the default now")
    await expect(followUp.getByTestId("inherited")).toHaveCount(0)
  })

  test("what Custom and Override mean is one visible line on the pages that show them", async ({ page, baseURL }) => {
    await mock.scenario("devices")
    await loginAdmin(page, baseURL, "#settings/devices/d-kitchen-ipad-0001")
    await expect(page.getByTestId("marker-legend")).toHaveText("Override: set for this device only. Reset returns to the front-end default.")
    await gotoAdmin(page, baseURL, "#settings/frontends/web-voice")
    await expect(page.getByTestId("marker-legend")).toHaveText("Custom: differs from the built-in default. Reset returns to it.")
    await gotoAdmin(page, baseURL, "#settings/speech/turn-timing")
    await expect(page.getByTestId("marker-legend")).toContainText("Custom:")
  })

  test("when a field's label is its group's heading, the markers sit on the heading's row", async ({ page, baseURL }) => {
    await mock.scenario("devices")
    await loginAdmin(page, baseURL, "#settings/devices/d-kitchen-ipad-0001")
    // Activation's first field is "Activation" (the Voice group, the other such case, was retired).
    const field = page.locator("[data-field=activation]")
    const heading = field.locator("h4")
    await expect(heading).toHaveText("Activation")
    const markers = field.getByTestId("field-markers")
    await expect(markers).toBeVisible()
    const h = (await heading.boundingBox())!
    const m = (await markers.boundingBox())!
    expect(Math.abs(h.y + h.height / 2 - (m.y + m.height / 2))).toBeLessThan(12)
  })

  test("nav marks: one padlock mark, and the legend is never cut off", async ({ page, baseURL }) => {
    await mock.scenario("keys-locked")
    await loginAdmin(page, baseURL, "#settings/speech/turn-timing")
    await page.evaluate(() => {
      const c = (window as unknown as { __pva: { store: { get: () => { engine: Record<string, unknown> }; dispatch: (a: unknown) => void } } }).__pva
      c.store.dispatch({ type: "engine", engine: { ...c.store.get().engine, problems: [{ stage: "tts", message: "Piper: the voice file is missing." }] } })
    })
    await page.getByTestId("settings-page").locator("input[type=number]").first().fill("700")
    const legend = page.getByTestId("marks-legend")
    await expect(legend.locator("[data-legend=lock]")).toContainText("Locked: unlock the keys to change")
    await expect(page.locator("[data-mark=key]")).toHaveCount(0)
    for (const height of [800, 600]) {
      await page.setViewportSize({ width: 1280, height })
      const box = (await legend.boundingBox())!
      expect(box.y + box.height, `legend bottom at ${height} px`).toBeLessThanOrEqual(height)
      expect(await legend.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    }
  })

  test("Language model › Provider with the subscription card chosen: the footer has no Save, only its note", async ({ page, baseURL }) => {
    await mock.scenario("modules")
    await loginAdmin(page, baseURL, "#settings/language-model/provider")
    await page.getByRole("radio", { name: /Claude subscription/ }).click()
    await expect(page.getByTestId("footer-note")).toContainText("Use Claude subscription")
    await expect(page.getByTestId("page-footer").getByRole("button", { name: /^Save/ })).toHaveCount(0)
  })
})

test.describe("voice small things", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("“or type instead” is 44 px tall on a phone", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await page.goto(appUrl(baseURL))
    const box = (await page.getByTestId("type-instead").boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(box.width).toBeGreaterThanOrEqual(44)
  })

  test("the Advanced and folded summaries are 44 px tall on a phone", async ({ page, baseURL }) => {
    await mock.scenario("devices")
    await gotoAdmin(page, baseURL, "#settings/frontends/web-voice")
    const summaries = page.locator("[data-testid=profile-frontend-web-voice] summary, [data-testid^=profile-] summary")
    const count = await summaries.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) expect((await summaries.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44)
  })
})

test("failed engines: Start is muted with its reason and the top bar repeats nothing", async ({ page, baseURL }) => {
  await mock.scenario("engine-failed")
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("engine-banner")).toHaveAttribute("data-state", "failed")
  const start = page.getByTestId("start")
  await expect(start).toBeDisabled()
  await expect(start).toHaveAccessibleDescription(/Not available/)
  await expect(page.getByTestId("start-unavailable")).toBeVisible()
  // Only a visually hidden word for assistive technology; nothing visible next to the banner.
  expect((await page.getByTestId("connection-status").boundingBox())!.width).toBeLessThanOrEqual(1)
})

test.describe("1024 px with the chat popover", () => {
  test.use({ viewport: { width: 1024, height: 768 } })
  test("a toast does not lie over the popover", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await page.goto(appUrl(baseURL))
    await page.getByTestId("chat-toggle").click()
    await expect(page.getByTestId("chat-panel")).toBeVisible()
    await page.evaluate(() => {
      const c = (window as unknown as { __pva: { store: { dispatch: (a: unknown) => void } } }).__pva
      c.store.dispatch({ type: "local/toast", message: "A toast that is long enough to reach across a good part of the stage, as real ones do.", tone: "info" })
    })
    const toast = page.getByTestId("toasts").locator("[role=status]").first()
    await expect(toast).toBeVisible()
    await page.waitForTimeout(500) // the shift is animated
    const t = (await toast.boundingBox())!
    const chat = (await page.getByTestId("chat-panel").boundingBox())!
    expect(t.x + t.width).toBeLessThanOrEqual(chat.x)
  })
})
