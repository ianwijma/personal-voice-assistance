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
    const name = page.locator("[data-field=name]")
    await expect(name.getByTestId("unsaved-marker")).toHaveCount(0)
    await page.getByLabel("Name", { exact: true }).fill("Kitchen")
    await expect(name.getByTestId("unsaved-marker")).toHaveText("Unsaved")
    await expect(page.getByTestId("footer-note")).toHaveText("Unsaved changes")

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

    // Saving it: no marker, no check.
    await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    await expect(name.getByTestId("unsaved-marker")).toHaveCount(0)
    await page.getByTestId("logout").click()
    await expect(page.getByTestId("login-form")).toBeVisible()
  })

  test("a failed Log out keeps the draft and the guard in agreement, and says it failed", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await loginAdmin(page, baseURL, "#settings/shared/limits")
    const input = page.getByTestId("settings-page").locator("input[type=number]").first()
    await input.fill("3")
    await mock.logoutFails(true)
    await page.getByTestId("logout").click()
    await page.getByTestId("leave-dialog").getByRole("button", { name: "Discard and log out" }).click()
    await expect(page.getByTestId("toasts")).toContainText("could not log you out")
    await expect(page.getByTestId("settings")).toBeVisible()
    // The edit is still shown ...
    await expect(input).toHaveValue("3")
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

for (const width of [320, 390]) {
  test.describe(`phone ${width} px`, () => {
    test.use({ viewport: { width, height: 700 }, hasTouch: true, isMobile: true })

    test("every editable control is at least 16 px (no zoom on focus) and the layouts still fit", async ({ page, baseURL }) => {
      await mock.scenario("devices")
      await mock.sleeps()
      // Admin login.
      await page.goto(adminUrl(baseURL))
      await expect(page.getByTestId("login-form")).toBeVisible()
      await expectAtLeast16(page, "login")
      await noOverflow(page, "login")
      await page.locator("#admin-password").fill(ADMIN_PASSWORD)
      await page.getByRole("button", { name: "Log in" }).click()
      await expect(page.getByTestId("settings")).toBeVisible()
      // Settings pages: front-end defaults with the phrase editor, a device with the rename, a number, a choice, a text.
      for (const hash of ["#settings/devices/type-web-voice", "#settings/devices/d-kitchen-ipad-0001", "#settings/shared/limits", "#settings/shared/accounts"]) {
        await gotoAdmin(page, baseURL, hash)
        await expect(page.getByTestId("settings-page")).toBeVisible()
        await expectAtLeast16(page, hash, hash.endsWith("/accounts") ? 0 : 1)
        await noOverflow(page, hash)
      }
      await gotoAdmin(page, baseURL, "#settings/devices/d-kitchen-ipad-0001")
      await expect(page.getByTestId("phrase-input").first()).toBeVisible()
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
