import type { Page } from "@playwright/test"
import { appUrl, expect, loginAdmin, MOCK, mock, test } from "./fixtures.ts"

// Generated forms and modules on the admin settings screen; the voice front end's echo test and settings sheet.

/** Open an admin settings page by its deep link (logging in on the way). */
const openPage = async (page: Page, baseURL: string | undefined, path: string) => {
  await loginAdmin(page, baseURL, `#settings/${path}`)
  await expect(page.getByTestId(`page-${path.replace("/", "-")}`)).toBeVisible()
}
const footer = (page: Page) => page.getByTestId("page-footer")

test.beforeEach(async () => {
  await mock.scenario("modules")
})

test("a module whose instance fails shows its error, and a working token fixes it (there is no switch to retry)", async ({ page, baseURL }) => {
  await fetch(`${MOCK}/mock/module-error`, { method: "POST", body: JSON.stringify({ module: "home-assistant", message: "Home Assistant rejected the token (HTTP 401)." }) })
  await openPage(page, baseURL, "shared/modules")
  const card = page.getByTestId("module-home-assistant")
  await expect(card.getByRole("switch")).toHaveCount(0)
  await expect(card).toHaveAttribute("data-state", "error")
  await expect(card.getByTestId("instance-error")).toContainText("rejected the token (HTTP 401)")
  await expect(page.getByTestId("nav-shared-modules").locator("[data-mark=error]")).toBeVisible()
  // Every field type renders from the server's description.
  const form = page.getByTestId("form-m-home-assistant")
  await expect(form.locator("[data-field-type=text]")).toBeVisible()
  await expect(form.locator("[data-field-type=secret]")).toContainText("Set (saved here)")
  await expect(form.locator("[data-field-type=multichoice] input[type=checkbox]")).toHaveCount(4)
  await form.getByText("Advanced").click()
  await expect(form.locator("[data-field-type=boolean]").getByRole("switch")).toBeVisible()
  // Replace the secret; saving restarts the module's instances (the mock accepts tokens containing "good").
  await form.getByRole("button", { name: "Replace" }).click()
  await form.getByPlaceholder("Paste the new value").fill("good-token")
  await footer(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(card).toHaveAttribute("data-state", "running", { timeout: 4000 })
  await expect(card).toContainText("Connected to Home · 42 devices")
  const configure = (await mock.log()).messages.find((m) => m.type === "module.configure")!
  expect(configure.patch).toEqual({ values: {}, secrets: { token: "good-token" } })
})

test("validation errors from the server appear under their field; a valid value saves", async ({ page, baseURL }) => {
  await openPage(page, baseURL, "shared/modules")
  const form = page.getByTestId("form-m-weather")
  const place = form.getByLabel("Home location")
  await place.fill("Atlantis")
  await form.getByRole("radio", { name: "Fahrenheit, mph" }).click()
  await footer(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(form.locator("[data-field=defaultPlace]")).toContainText("Open-Meteo does not know this place.")
  await expect(place).toHaveAttribute("aria-invalid", "true")
  await place.fill("Utrecht")
  await footer(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(footer(page).getByText("Saved")).toBeVisible()
  await expect(footer(page).getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  const patches = (await mock.log()).messages.filter((m) => m.type === "module.configure").map((m) => m.patch)
  expect(patches.at(-1)).toEqual({ values: { defaultPlace: "Utrecht", units: "fahrenheit" }, secrets: {} })
  // A number field below its minimum is caught before sending.
  await form.getByText("Advanced").click()
  await form.getByLabel("Timeout").fill("100")
  await expect(form.locator("[data-field=timeoutMs]")).toContainText("At least 500 ms.")
  await expect(footer(page).getByRole("button", { name: "Save", exact: true })).toBeDisabled()
})

test("a capability has no switch (the assistants switch it on); a choice with more than four options is a select; locked fields are read-only", async ({ page, baseURL }) => {
  await openPage(page, baseURL, "shared/modules")
  const notes = page.getByTestId("module-notes")
  await expect(notes.getByRole("switch")).toHaveCount(0)
  await expect(notes).toHaveAttribute("data-state", "running") // T3 and Keuken have it on
  await expect(notes).toContainText("12 notes in Inbox")
  const settings = page.getByTestId("settings")
  await expect(page.getByTestId("form-m-notes").locator("select")).toHaveValue("inbox")
  await expect(settings.getByText("Everything lands here first.")).toBeVisible()
  await expect(settings.getByText("READ-ONLY", { exact: false }).first()).toBeVisible()
  const clock = page.getByTestId("form-m-clock")
  await expect(clock.locator("[data-field=timeZone]")).toContainText("Set by CLOCK_TIME_ZONE in the environment")
  await expect(clock.locator("[data-field=timeZone] input")).toHaveCount(0)
})

test("a shared setting that needs a reload marks one pending (named in the global bar); Reload now applies it", async ({ page, baseURL }) => {
  await openPage(page, baseURL, "overview/overview")
  await page.getByTestId("nav-shared").click()
  await page.getByTestId("nav-shared-accounts").click()
  const address = page.locator("[data-field=ANTHROPIC_BASE_URL]")
  await address.getByRole("textbox").fill("https://proxy.example/anthropic")
  await expect(footer(page)).toContainText("Applies after an engine reload")
  await footer(page).getByRole("button", { name: "Save", exact: true }).click()
  const bar = page.getByTestId("reload-pending")
  await expect(bar).toContainText("Shared settings › Language model accounts")
  // The bar is global: it stays on every page until the engines reload.
  await page.getByTestId("nav-shared-limits").click()
  await expect(bar).toBeVisible()
  await bar.getByRole("button", { name: "Reload now" }).click()
  await expect(bar).toBeHidden({ timeout: 5000 })
  const types = (await mock.log()).messages.map((m) => m.type)
  expect(types).toContain("settings.update")
  expect(types).toContain("engine.reload")
  await page.getByTestId("nav-shared-accounts").click()
  await expect(page.getByTestId("page-shared-accounts")).toContainText("Set by ANTHROPIC_API_KEY in .env (not protected)")
})

test("a change from another tab updates a clean form and is flagged on a dirty one", async ({ page, baseURL }) => {
  await openPage(page, baseURL, "shared/modules")
  const form = page.getByTestId("form-m-weather")
  const module = (place: string, revision: number) => ({
    type: "module.changed",
    module: {
      id: "weather", name: "Weather", description: "Current weather and today's forecast from Open-Meteo.", enabled: true, state: "running",
      tools: [], revision, group: "modules",
      settings: {
        fields: [{ type: "text", key: "defaultPlace", label: "Home location", apply: "live", default: "" }],
        values: { defaultPlace: place }, secrets: {}, errors: []
      }
    }
  })
  await mock.send([module("Rotterdam", 10)])
  await expect(form.getByLabel("Home location")).toHaveValue("Rotterdam")
  await form.getByLabel("Home location").fill("my edit")
  await mock.send([module("Leiden", 11)])
  await expect(form.getByText("Changed in another tab")).toBeVisible()
  await expect(form.getByLabel("Home location")).toHaveValue("my edit")
  await form.getByRole("button", { name: "Load latest" }).click()
  await expect(form.getByLabel("Home location")).toHaveValue("Leiden")
})

test("the voice sheet: Esc closes it and returns focus; S opens it again", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  const toggle = page.getByTestId("settings-toggle")
  await toggle.click()
  const sheet = page.getByTestId("voice-sheet")
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole("heading", { name: "Settings" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(sheet).toBeHidden()
  await expect(toggle).toBeFocused()
  await page.keyboard.press("s")
  await expect(sheet).toBeVisible()
})

test("the echo test (voice sheet › More) plays through the player, reports nothing to the server, and stores a result", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expect(page.getByTestId("stage")).toHaveAttribute("data-visual-state", "listening")
  await page.getByTestId("settings-toggle").click()
  await page.getByTestId("sheet-more").getByText("More").click()
  const before = (await mock.log()).mic.find((x) => x.owner)!.frames
  await page.getByRole("button", { name: "Test echo" }).click()
  await expect(page.getByRole("button", { name: /Listening for echo/ })).toBeVisible()
  await page.waitForTimeout(1500)
  const during = (await mock.log()).mic.find((x) => x.owner)!.frames
  expect(during - before).toBeLessThan(5) // the microphone is held back during the test
  await expect(page.getByTestId("echo-result")).toContainText(/Echo is (not )?removed/, { timeout: 10_000 })
  const log = await mock.log()
  expect(log.messages.filter((m) => m.type.startsWith("playback."))).toEqual([])
})
