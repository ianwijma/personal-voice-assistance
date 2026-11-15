import type { Page } from "@playwright/test"
import { adminUrl, expect, loginAdmin, mock, test } from "./fixtures.ts"

// The admin settings screen (docs/SETTINGS-UI.md §3, docs/FRONTENDS-AND-ACTIVATION.md §5): the page itself after the
// login: list + page from 1024 px, drill-down on a phone, hash deep links under /admin/,
// back, "Leave without saving?", the global reload bar, draft-driven visibility, warnings with "Save anyway",
// Reset to default, and the Claude subscription set up from one page.

const footer = (page: Page) => page.getByTestId("page-footer")
const save = (page: Page) => footer(page).getByRole("button", { name: "Save", exact: true })
const hash = (page: Page) => new URL(page.url()).hash

test.beforeEach(async () => {
  await mock.scenario("modules")
})

test.describe("desktop (1280 × 800)", () => {
  test("list + page: navigate, the hash follows, browser back goes to the previous page, a deep link opens a page", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL)
    await expect(page.getByTestId("page-overview-overview")).toBeVisible()
    await expect(page.getByTestId("settings-nav")).toBeVisible()
    await page.getByTestId("nav-speech").click()
    await expect(page.getByTestId("page-speech-engine")).toBeVisible()
    expect(hash(page)).toBe("#settings/speech")
    // The current category is expanded to its pages; Deepgram is listed under "Not in use".
    await expect(page.getByTestId("nav-speech-deepgram")).toHaveText(/Set up Deepgram/)
    await page.getByTestId("nav-speech-turn-timing").click()
    await expect(page.getByTestId("page-speech-turn-timing")).toBeVisible()
    expect(hash(page)).toBe("#settings/speech/turn-timing")
    await page.goBack()
    await expect(page.getByTestId("page-speech-engine")).toBeVisible()
    await page.goBack()
    await expect(page.getByTestId("page-overview-overview")).toBeVisible()

    await page.goto(adminUrl(baseURL, "#settings/voices/providers")) // the session token survives the navigation
    await expect(page.getByTestId("page-voices-providers")).toBeVisible()
    await expect(page.getByTestId("nav-voices-providers")).toHaveAttribute("aria-current", "page")
    await expect(page.getByTestId("page-title")).toHaveText("Voice providers")
  })

  test("Leave without saving? Stay keeps the edit; Discard leaves", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/speech/engine")
    await page.getByTestId("nav-speech-turn-timing").click()
    const field = page.getByTestId("form-s-stt-timing").getByLabel("End of turn after")
    await field.fill("900")
    await expect(page.getByTestId("nav-speech-turn-timing").locator("[data-mark=dirty]")).toBeVisible()
    await page.getByTestId("nav-voices").click()
    const dialog = page.getByTestId("leave-dialog")
    await expect(dialog).toContainText("Leave without saving?")
    await dialog.getByRole("button", { name: "Stay" }).click()
    await expect(dialog).toBeHidden()
    await expect(field).toHaveValue("900")
    // Browser back is held too, and Stay puts the page back.
    await page.goBack()
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Stay" }).click()
    await expect(page.getByTestId("page-speech-turn-timing")).toBeVisible()
    expect(hash(page)).toBe("#settings/speech/turn-timing")
    await page.getByTestId("nav-voices").click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Discard changes" }).click()
    await expect(page.getByTestId("page-voices-overview")).toBeVisible()
    expect((await mock.log()).messages.filter((m) => m.type === "settings.update")).toEqual([])
  })

  test("draft-driven visibility: choosing Deepgram shows its implication and hides the local model before saving; warnings ask first", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/speech/engine")
    const form = page.getByTestId("form-s-stt-engine")
    await expect(form.locator("[data-field=STT_SHERPA_MODEL]")).toBeVisible()
    await expect(form.locator("[data-field=STT_SHERPA_LANGUAGE]")).toHaveCount(0) // only for Whisper / Nemotron
    await form.locator("[data-field=STT_SHERPA_MODEL] select").selectOption("whisper-turbo")
    await expect(form.locator("[data-field=STT_SHERPA_LANGUAGE]")).toBeVisible()
    await expect(form.locator("[data-field=STT_SHERPA_MODEL] [data-tag=not-downloaded]")).toBeVisible()
    await form.locator("[data-field=STT_SHERPA_MODEL] select").selectOption("parakeet-v2")
    await form.getByRole("radio", { name: /Deepgram/ }).click()
    await expect(form.locator("[data-field=STT_SHERPA_MODEL]")).toHaveCount(0)
    await expect(form.getByTestId("implication")).toHaveText("What you say is sent to Deepgram.")
    await save(page).click()
    const warnings = page.getByTestId("save-warnings")
    await expect(warnings).toContainText("Deepgram is chosen but there is no Deepgram key")
    await warnings.getByRole("button", { name: "Save anyway" }).click()
    await expect(footer(page).getByText("Saved")).toBeVisible()
    const updates = (await mock.log()).messages.filter((m) => m.type === "settings.update")
    expect(updates.map((m) => [m.patch, m.confirmWarnings])).toEqual([
      [{ values: { STT_PROVIDER: "deepgram" }, secrets: {} }, undefined],
      [{ values: { STT_PROVIDER: "deepgram" }, secrets: {} }, true]
    ])
    // The saved warning stays on the form; the Deepgram page is now in use, turn timing is not.
    await expect(form.locator("[data-field=STT_PROVIDER] [data-testid=field-warning]")).toContainText("no Deepgram key")
    await expect(page.getByTestId("nav-speech-deepgram")).toHaveText(/^Deepgram/)
    await expect(page.getByTestId("nav-speech-turn-timing")).toHaveText(/Set up Turn timing/)
    await expect(page.getByTestId("reload-pending")).toContainText("Speech recognition › Engine")
  })

  test("a cross-field error appears under its field; Reset to default sends null", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/speech/turn-timing")
    const form = page.getByTestId("form-s-stt-timing")
    await form.getByLabel("Early guess after").fill("800")
    await form.getByLabel("End of turn after").fill("600")
    await save(page).click()
    await expect(form.locator("[data-field=STT_SHERPA_FINAL_SILENCE_MS]")).toContainText("Must be longer than the early guess (800 ms).")
    await form.getByLabel("Early guess after").fill("300")
    await save(page).click()
    await expect(footer(page).getByText("Saved")).toBeVisible()
    const early = form.locator("[data-field=STT_SHERPA_EAGER_SILENCE_MS]")
    await expect(early).toHaveAttribute("data-source", "saved")
    // Saved and not the default: "Custom", without "Unsaved"; an edit adds "Unsaved".
    await expect(early.getByTestId("custom-marker")).toHaveText("Custom")
    await expect(early.getByTestId("unsaved-marker")).toHaveCount(0)
    await form.getByLabel("Early guess after", { exact: true }).fill("310")
    await expect(early.getByTestId("unsaved-marker")).toHaveText("Unsaved")
    await form.getByLabel("Early guess after", { exact: true }).fill("300")
    await expect(early.getByTestId("unsaved-marker")).toHaveCount(0)
    await early.getByRole("button", { name: /Reset/ }).click()
    await expect(form.getByLabel("Early guess after", { exact: true })).toHaveValue("250")
    await save(page).click()
    await expect(early).toHaveAttribute("data-source", "default")
    const updates = (await mock.log()).messages.filter((m) => m.type === "settings.update")
    expect(updates.at(-1)!.patch).toEqual({ values: { STT_SHERPA_EAGER_SILENCE_MS: null }, secrets: {} })
  })

  test("Claude subscription from one page: the Anthropic fields hide, the agent's state shows, one button sets it all up", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/language-model/provider")
    const form = page.getByTestId("form-s-language-model")
    await expect(form.locator("[data-field=ANTHROPIC_MODEL]")).toBeVisible()
    await form.getByRole("radio", { name: /Claude subscription/ }).click()
    await expect(form.locator("[data-field=ANTHROPIC_MODEL]")).toHaveCount(0)
    await expect(form.locator("[data-field=ANTHROPIC_API_KEY]")).toHaveCount(0)
    const card = page.getByTestId("option-module")
    await expect(card.getByTestId("option-module-state")).toHaveText("Off")
    // One action does every step; the separate opt-in and module switch are folded away until needed.
    await expect(card.locator("[data-field=optIn]")).toBeHidden()
    await expect(card.locator("[data-step]")).toHaveCount(4)
    await expect(card.locator("[data-step=next]")).toHaveCount(1)
    await card.getByTestId("option-module-steps").getByText("Do the steps one by one").click()
    await expect(card.locator("[data-field=optIn]")).toBeVisible()
    await expect(card.getByRole("switch", { name: "Use my Claude subscription" })).toBeVisible()
    // One way to commit: the footer has no Save (nothing disabled that reads as broken), only the note pointing at the card.
    await expect(save(page)).toHaveCount(0)
    await expect(page.getByTestId("footer-note")).toContainText("use “Use Claude subscription” above")
    await card.getByRole("button", { name: "Use Claude subscription" }).click()
    await expect(card).toHaveAttribute("data-complete", "true", { timeout: 8000 })
    await expect(card.getByTestId("option-module-state")).toHaveText("Ready · claude-haiku-5-5 · max plan")
    await expect(card.getByRole("button", { name: "Use Claude subscription" })).toHaveCount(0)
    await expect(card.locator("[data-step=done]")).toHaveCount(4)
    // In use: the switches show (to switch it off again), each labelled in full.
    await expect(card.getByText("Claude subscription module: on")).toBeVisible()
    const log = (await mock.log()).messages
    expect(log.filter((m) => m.type === "settings.update").map((m) => m.patch)).toEqual([{ values: { LLM_PROVIDER: "claude-subscription" }, secrets: {} }])
    expect(log.filter((m) => m.type === "module.configure").map((m) => [m.moduleId, m.patch])).toEqual([["claude-subscription", { values: { optIn: true }, secrets: {} }]])
    expect(log.map((m) => m.type)).toEqual(expect.arrayContaining(["module.enable", "engine.reload"]))
    // The Overview says who answers.
    await page.getByTestId("nav-overview").click()
    await expect(page.getByTestId("checklist")).toContainText("Language model: Claude subscription (claude-haiku-5-5)")
  })

  test("the subscription agent refuses to start without the opt-in (the server's check stays)", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/language-model/claude-subscription")
    const header = page.getByTestId("module-claude-subscription")
    await header.getByRole("switch").click()
    await expect(header).toHaveAttribute("data-state", "error")
    await expect(header.getByRole("alert")).toContainText("Use my Claude subscription")
  })
})

test.describe("phone (390 × 844)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("drill-down: categories → pages → page, the back button names the parent, the footer sits at the bottom", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL)
    const settings = page.getByTestId("settings")
    await expect(settings).toHaveAttribute("data-level", "list")
    await page.getByTestId("nav-speech").tap()
    await expect(settings).toHaveAttribute("data-level", "pages")
    await expect(page.getByTestId("settings-back")).toHaveText("Admin")
    await expect(page.getByTestId("settings-pages")).toContainText("Set up Deepgram")
    await page.getByTestId("nav-speech-turn-timing").tap()
    await expect(settings).toHaveAttribute("data-level", "page")
    await expect(page.getByTestId("settings-back")).toHaveText("Speech recognition")
    const row = await page.getByTestId("nav-overview").count()
    expect(row).toBe(0)
    // Edit: the sticky footer is on screen, at the bottom.
    await page.getByTestId("form-s-stt-timing").getByLabel("End of turn after").fill("650")
    const box = await footer(page).boundingBox()
    expect(Math.round(box!.y + box!.height)).toBeLessThanOrEqual(844)
    expect(Math.round(box!.y + box!.height)).toBeGreaterThan(780)
    await save(page).tap()
    await expect(footer(page).getByText("Saved")).toBeVisible()
    await page.getByTestId("settings-back").tap()
    await expect(settings).toHaveAttribute("data-level", "pages")
    await page.getByTestId("settings-back").tap()
    await expect(settings).toHaveAttribute("data-level", "list")
    // The browser's own back gesture goes through the hash history too.
    await page.getByTestId("nav-voices").tap()
    await page.getByTestId("nav-voices-overview").tap()
    await page.goBack()
    await expect(settings).toHaveAttribute("data-level", "pages")
  })

  test("a deep link opens the page; a one-page category opens it directly; Overview is reachable", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/modules/weather")
    await expect(page.getByTestId("page-modules-weather")).toBeVisible()
    await expect(page.getByTestId("settings-back")).toHaveText("Modules")
    await page.goto(adminUrl(baseURL, "#settings/about"))
    await expect(page.getByTestId("page-about-about")).toBeVisible()
    await expect(page.getByTestId("settings-back")).toHaveText("Admin")
    await page.getByTestId("settings-back").tap()
    await page.getByTestId("nav-overview").tap()
    await expect(page.getByTestId("checklist")).toBeVisible()
  })

  test("Claude subscription from one page on the phone", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/language-model/provider")
    await page.getByTestId("form-s-language-model").getByRole("radio", { name: /Claude subscription/ }).tap()
    const card = page.getByTestId("option-module")
    await card.getByRole("button", { name: "Use Claude subscription" }).tap()
    await expect(card).toHaveAttribute("data-complete", "true", { timeout: 8000 })
    const overflow = await page.evaluate(() => {
      const panel = document.querySelector("[data-testid=settings-page]")!
      return panel.scrollWidth - panel.clientWidth
    })
    expect(overflow).toBe(0)
  })
})
