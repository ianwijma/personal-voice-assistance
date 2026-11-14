import { type Page } from "@playwright/test"
import { ADMIN_PASSWORD, adminUrl, appUrl, expect, expectVisualState, gotoAdmin, loginAdmin, mock, test } from "./fixtures.ts"

// Review round 4 (docs/FRONTENDS-AND-ACTIVATION.md, Status): the device rename and a failed Log out in the leave check,
// the phrase tester's Add, 16 px editable controls on phones, the tester's note about a device's own settings.

/** Every visible input, textarea and select that takes text or a choice: [description, computed font size]. */
const editableSizes = (page: Page) =>
  page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), textarea, select")]
    return controls
      .filter((el) => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none"
      })
      .map((el) => ({ what: `${el.tagName.toLowerCase()}#${el.id || "(no id)"}`, px: parseFloat(getComputedStyle(el).fontSize) }))
  })

const expectAtLeast16 = async (page: Page, where: string, minimum = 1) => {
  const sizes = await editableSizes(page)
  expect(sizes.length, `${where}: found editable controls`).toBeGreaterThanOrEqual(minimum)
  expect(sizes.filter((s) => s.px < 16), `${where}: controls under 16 px`).toEqual([])
}
const noOverflow = (page: Page, where: string) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth).then((n) => expect(n, `${where}: horizontal overflow`).toBe(0))

test.describe("unsaved work", () => {
  test("a typed device name is an unsaved edit: marker, leave check on navigation and Log out", async ({ page, baseURL }) => {
    await mock.scenario("devices")
    await loginAdmin(page, baseURL, "#settings/devices/d-kitchen-ipad-0001")
    const rename = page.getByTestId("rename")
    await expect(rename.getByTestId("unsaved-marker")).toHaveCount(0)
    await page.getByLabel("Name", { exact: true }).fill("Kitchen")
    await expect(rename.getByTestId("unsaved-marker")).toHaveText("Unsaved")
    await expect(page.getByTestId("footer-note")).toHaveText("Unsaved name")

    // Navigation asks; Stay keeps the typed name.
    await page.getByTestId("page-up").click()
    const dialog = page.getByTestId("leave-dialog")
    await expect(dialog).toContainText("Leave without saving?")
    await dialog.getByRole("button", { name: "Stay" }).click()
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Kitchen")
    // Log out asks too.
    await page.getByTestId("logout").click()
    await expect(page.getByTestId("leave-dialog")).toContainText("Leave without saving?")
    await page.getByTestId("leave-dialog").getByRole("button", { name: "Stay" }).click()

    // Renaming saves it: no marker, no check.
    await page.getByRole("button", { name: "Rename" }).click()
    await expect(rename).toContainText("Renamed")
    await expect(rename.getByTestId("unsaved-marker")).toHaveCount(0)
    await page.getByTestId("logout").click()
    await expect(page.getByTestId("login-form")).toBeVisible()
  })

  test("a failed Log out keeps the draft and the guard in agreement, and says it failed", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await loginAdmin(page, baseURL, "#settings/speech/turn-timing")
    const input = page.getByTestId("settings-page").locator("input[type=number]").first()
    await input.fill("700")
    await mock.logoutFails(true)
    await page.getByTestId("logout").click()
    await page.getByTestId("leave-dialog").getByRole("button", { name: "Discard and log out" }).click()
    await expect(page.getByTestId("toasts")).toContainText("could not log you out")
    await expect(page.getByTestId("settings")).toBeVisible()
    // The edit is still shown ...
    await expect(input).toHaveValue("700")
    // ... and the guard is still on: Log out asks again, the page warns on unload.
    await page.getByTestId("logout").click()
    await expect(page.getByTestId("leave-dialog")).toContainText("Leave without saving?")
    await page.getByTestId("leave-dialog").getByRole("button", { name: "Stay" }).click()
    await mock.logoutFails(false)
    await page.getByTestId("logout").click()
    await page.getByTestId("leave-dialog").getByRole("button", { name: "Discard and log out" }).click()
    await expect(page.getByTestId("login-form")).toBeVisible()
  })
})

test.describe("phrase tester", () => {
  const open = async (page: Page, baseURL: string | undefined) => {
    await mock.scenario("typed")
    await loginAdmin(page, baseURL, "#settings/frontends/web-voice")
    await page.getByTestId("wake-settings-folded").locator("summary").click()
    const tester = page.getByTestId("phrase-tester")
    await tester.getByRole("button", { name: "Listen" }).click()
    await expect(tester).toHaveAttribute("data-on", "true")
    return tester
  }

  test("Add keeps focus, announces, and says Added, not saved yet, then Saved", async ({ page, baseURL }) => {
    const tester = await open(page, baseURL)
    await mock.heard("Hey go, what's the time?", undefined, false)
    const line = tester.getByTestId("heard-lines").locator("[data-outcome=ignored]")
    const add = line.getByTestId("add-heard")
    await add.focus()
    await add.press("Enter")
    const status = line.getByTestId("added-status")
    await expect(status).toHaveText("Added “hey go”, not saved yet")
    await expect(status).toBeFocused()
    await expect(tester.getByTestId("tester-announcer")).toContainText("Added “hey go” as a wake phrase. Save to keep it.")
    await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    await expect(status).toHaveText("Saved “hey go”")
    // Removing it from the list again brings the Add control back.
    await page.getByTestId("phrase-list").locator("[data-phrase='hey go']").getByRole("button").click()
    await expect(line.getByTestId("add-heard")).toBeVisible()
  })

  test("a refused Add is announced and keeps the control for a retry", async ({ page, baseURL }) => {
    const tester = await open(page, baseURL)
    await mock.heard("Hey Jeff", undefined, false)
    const line = tester.getByTestId("heard-lines").locator("[data-outcome=ignored]")
    await line.getByTestId("add-heard").click()
    await expect(line.getByTestId("add-error")).toHaveText("That phrase is already in the list.")
    await expect(tester.getByTestId("tester-announcer")).toContainText("Not added: That phrase is already in the list.")
    await expect(line.getByTestId("add-heard")).toBeVisible()
    await expect(line.getByTestId("added-status")).toHaveCount(0)
  })

  test("a device with some settings of its own: the note names them and says the rest comes from the defaults", async ({ page, baseURL, context }) => {
    await mock.scenario("devices")
    await mock.defaults({ activation: "wake-phrase" })
    const voice = await context.newPage()
    await voice.goto(appUrl(baseURL))
    await voice.getByTestId("start").click()
    await expectVisualState(voice, "asleep")
    await voice.getByTestId("settings-toggle").click()
    await voice.getByLabel("Keep listening after a reply").selectOption("15")
    await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "device.update").map((m) => m.patch)).toContainEqual({ followUpSeconds: 15 })
    await loginAdmin(page, baseURL, "#settings/frontends/web-voice")
    const note = page.getByTestId("tester-own-settings")
    await expect(note).toContainText("overrides follow-up time; its activation, phrases and matching use these defaults.")
    await expect(note).not.toContainText("do not decide")
    await voice.close()
  })
})

for (const width of [320, 390]) {
  test.describe(`phone ${width} px`, () => {
    test.use({ viewport: { width, height: 700 }, hasTouch: true, isMobile: true })

    test("every editable control is at least 16 px (no zoom on focus) and the layouts still fit", async ({ page, baseURL }) => {
      await mock.scenario("devices")
      await mock.defaults({ activation: "wake-phrase" })
      // Admin login.
      await page.goto(adminUrl(baseURL))
      await expect(page.getByTestId("login-form")).toBeVisible()
      await expectAtLeast16(page, "login")
      await noOverflow(page, "login")
      await page.locator("#admin-password").fill(ADMIN_PASSWORD)
      await page.getByRole("button", { name: "Log in" }).click()
      await expect(page.getByTestId("settings")).toBeVisible()
      // Settings pages: front-end defaults with the phrase editor, a device with the rename, a number, a choice, a text.
      for (const hash of ["#settings/frontends/web-voice", "#settings/devices/d-kitchen-ipad-0001", "#settings/speech/turn-timing", "#settings/language-model/provider"]) {
        await gotoAdmin(page, baseURL, hash)
        await expect(page.getByTestId("settings-page")).toBeVisible()
        await expectAtLeast16(page, hash, hash.endsWith("/provider") ? 0 : 1)
        await noOverflow(page, hash)
      }
      await gotoAdmin(page, baseURL, "#settings/frontends/web-voice")
      await expect(page.locator("[id$=-phrases-new]")).toBeVisible()
      expect((await editableSizes(page)).some((s) => s.what.endsWith("-phrases-new"))).toBe(true)
      // The voice page: the sheet and the chat.
      await page.goto(appUrl(baseURL))
      await page.getByTestId("settings-toggle").tap()
      await expect(page.getByTestId("voice-sheet")).toBeVisible()
      await expectAtLeast16(page, "voice sheet", 2)
      await noOverflow(page, "voice sheet")
      await page.keyboard.press("Escape")
      await page.getByTestId("chat-toggle").tap()
      await expect(page.locator("#chat-input")).toBeVisible()
      await expectAtLeast16(page, "chat")
      expect((await editableSizes(page)).some((s) => s.what === "textarea#chat-input")).toBe(true)
      await noOverflow(page, "chat")
    })
  })
}
