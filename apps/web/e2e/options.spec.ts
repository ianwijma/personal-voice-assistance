import type { Page } from "@playwright/test"
import { appUrl, expect, mock, test } from "./fixtures.ts"

// Generated forms, modules and this device's settings, on the settings screen (was the options drawer).

/** Open a settings page by its deep link (the page loads with the settings already open). */
const openPage = async (page: Page, baseURL: string | undefined, path: string) => {
  await page.goto(appUrl(baseURL, `#settings/${path}`))
  await expect(page.getByTestId("settings")).toBeVisible()
  await expect(page.getByTestId(`page-${path.replace("/", "-")}`)).toBeVisible()
}
const footer = (page: Page) => page.getByTestId("page-footer")

test.beforeEach(async () => {
  await mock.scenario("modules")
})

test("a module that fails to start shows its error, and Retry after fixing the token starts it", async ({ page, baseURL }) => {
  await openPage(page, baseURL, "modules/home-assistant")
  const card = page.getByTestId("module-home-assistant")
  await card.getByRole("switch").click()
  await expect(card).toHaveAttribute("data-state", "starting")
  await expect(card).toHaveAttribute("data-state", "error")
  await expect(card.getByRole("alert")).toContainText("rejected the token (HTTP 401)")
  await expect(page.getByRole("alert").filter({ hasText: "Home Assistant: Home Assistant rejected" })).toBeVisible() // toast
  await expect(page.getByTestId("nav-modules-home-assistant").locator("[data-mark=error]")).toBeVisible()
  // Every field type renders from the server's description.
  const form = page.getByTestId("form-m-home-assistant")
  await expect(form.locator("[data-field-type=text]")).toBeVisible()
  await expect(form.locator("[data-field-type=secret]")).toContainText("Set (saved here)")
  await expect(form.locator("[data-field-type=multichoice] input[type=checkbox]")).toHaveCount(4)
  await form.getByText("Advanced").click()
  await expect(form.locator("[data-field-type=boolean]").getByRole("switch")).toBeVisible()
  // Replace the secret; saving retries the module (the mock accepts tokens containing "good").
  await form.getByRole("button", { name: "Replace" }).click()
  await form.getByPlaceholder("Paste the new value").fill("good-token")
  await footer(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(card).toHaveAttribute("data-state", "running", { timeout: 4000 })
  await expect(card).toContainText("Connected to Home · 42 devices")
  const configure = (await mock.log()).messages.find((m) => m.type === "module.configure")!
  expect(configure.patch).toEqual({ values: {}, secrets: { token: "good-token" } })
})

test("validation errors from the server appear under their field; a valid value saves", async ({ page, baseURL }) => {
  await openPage(page, baseURL, "modules/weather")
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

test("enabling and disabling a module; a choice with more than four options is a select; locked fields are read-only", async ({ page, baseURL }) => {
  await openPage(page, baseURL, "modules/notes")
  const notes = page.getByTestId("module-notes")
  await notes.getByRole("switch").click()
  await expect(notes).toHaveAttribute("data-state", "running")
  await expect(notes).toContainText("12 notes in Inbox")
  const settings = page.getByTestId("settings")
  await expect(settings.locator("select")).toHaveValue("inbox")
  await expect(settings.getByText("Everything lands here first.")).toBeVisible()
  await expect(settings.getByText("READ-ONLY", { exact: false }).first()).toBeVisible()
  await notes.getByRole("switch").first().click()
  await expect(notes).toHaveAttribute("data-state", "disabled")
  await page.getByTestId("nav-modules-clock").click()
  const clock = page.getByTestId("form-m-clock")
  await expect(clock.locator("[data-field=timeZone]")).toContainText("Set by CLOCK_TIME_ZONE in the environment")
  await expect(clock.locator("[data-field=timeZone] input")).toHaveCount(0)
})

test("assistant settings: a reload field marks a reload pending (named in the global bar); Reload now applies it", async ({ page, baseURL }) => {
  await openPage(page, baseURL, "overview/overview")
  await expect(page.getByText("claude-haiku-5-5").first()).toBeVisible() // engines list
  await page.getByTestId("nav-speech").click()
  await page.getByTestId("nav-speech-turn-timing").click()
  const form = page.getByTestId("form-s-stt-timing")
  await form.getByLabel("End of turn after").fill("700")
  await expect(footer(page)).toContainText("Applies after an engine reload")
  await footer(page).getByRole("button", { name: "Save", exact: true }).click()
  const bar = page.getByTestId("reload-pending")
  await expect(bar).toContainText("Speech recognition › Turn timing")
  // The bar is global: it stays on every page until the engines reload.
  await page.getByTestId("nav-voices").click()
  await expect(bar).toBeVisible()
  await bar.getByRole("button", { name: "Reload now" }).click()
  await expect(bar).toBeHidden({ timeout: 5000 })
  const types = (await mock.log()).messages.map((m) => m.type)
  expect(types).toContain("settings.update")
  expect(types).toContain("engine.reload")
  // The voices section uses the same generated form (choice + multichoice).
  await expect(page.getByTestId("form-s-voices").getByRole("radio", { name: "natural" })).toBeVisible()
  await page.getByTestId("nav-language-model").click()
  await expect(page.getByTestId("page-language-model-provider")).toContainText("Set by ANTHROPIC_API_KEY in .env (not protected)")
})

test("a change from another tab updates a clean form and is flagged on a dirty one", async ({ page, baseURL }) => {
  await openPage(page, baseURL, "modules/weather")
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

test("this device: interrupt mode is sent to the server while owning the audio, and remembered", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expect(page.getByTestId("stage")).toHaveAttribute("data-visual-state", "listening")
  await page.keyboard.press("o")
  await page.getByTestId("nav-device").click()
  await page.getByRole("radio", { name: /Headphones/ }).click()
  await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "audio.config").map((m) => m.interruptMode)).toEqual(["instant"])
  await page.reload()
  await expect(page.getByTestId("page-device-microphone")).toBeVisible() // the hash kept the page
  await expect(page.getByRole("radio", { name: /Headphones/ })).toHaveAttribute("aria-checked", "true")
})

test("Esc closes the settings and returns focus; O reopens them where they were", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await page.getByRole("button", { name: "Settings (O)" }).click()
  await expect(page.getByTestId("settings")).toBeVisible()
  await page.getByTestId("nav-voices").click()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("settings")).toBeHidden()
  await expect(page.getByRole("button", { name: "Settings (O)" })).toBeFocused()
  expect(new URL(page.url()).hash).toBe("")
  await page.keyboard.press("o")
  await expect(page.getByTestId("page-voices-overview")).toBeVisible()
})

test("the echo test plays through the player, reports nothing to the server, and stores a result", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expect(page.getByTestId("stage")).toHaveAttribute("data-visual-state", "listening")
  await page.keyboard.press("o")
  await page.getByTestId("nav-device").click()
  const before = (await mock.log()).mic.find((x) => x.owner)!.frames
  await page.getByRole("button", { name: "Test echo" }).click()
  await expect(page.getByRole("button", { name: /Listening for echo/ })).toBeVisible()
  await page.waitForTimeout(1500)
  const during = (await mock.log()).mic.find((x) => x.owner)!.frames
  expect(during - before).toBeLessThan(5) // the microphone is held back during the test
  await expect(page.getByTestId("echo-result")).toContainText(/Echo is (not )?cancelled/, { timeout: 10_000 })
  const log = await mock.log()
  expect(log.messages.filter((m) => m.type.startsWith("playback."))).toEqual([])
})
