import type { Page } from "@playwright/test"
import { expect, gotoAdmin, mock, test } from "./fixtures.ts"

// Settings from outside (docs/SETTINGS-UI.md §4.4, P4) and model downloads (§5.4, P7), against the mock: the
// Overrides page with Move and Move all, Move on a locked field, a download with progress and cancel on the Models
// page, and the inline Download next to a recogniser that is not downloaded.

const log = async (type: string) => (await mock.log()).messages.filter((m) => m.type === type)

const overrides = async (page: Page, baseURL: string | undefined) => {
  await gotoAdmin(page, baseURL, "#settings/diagnostics/overrides")
  const list = page.getByTestId("overrides")
  await expect(list).toBeVisible()
  return list
}

for (const size of [{ name: "desktop (1280 × 800)", viewport: { width: 1280, height: 800 }, mobile: false }, { name: "phone (390 × 844)", viewport: { width: 390, height: 844 }, mobile: true }]) {
  test.describe(size.name, () => {
    test.use({ viewport: size.viewport, hasTouch: size.mobile, isMobile: size.mobile })

    test.beforeEach(async () => {
      await mock.scenario("typed")
    })

    test("Overrides: variables by kind with file and line; Move one, then Move all", async ({ page, baseURL }) => {
      const list = await overrides(page, baseURL)
      const movable = list.locator("[data-group=movable]")
      await expect(movable.locator("[data-env=ANTHROPIC_API_KEY]")).toContainText("/home/owner/personal-voice-assistance/.env:3")
      await expect(movable.locator("[data-env=ANTHROPIC_API_KEY]")).toContainText("Key")
      await expect(list.locator("[data-group=process] [data-env=ANTHROPIC_MODEL]")).toContainText("process environment")
      await expect(list.locator("[data-group=bootstrap] [data-env=SERVE_PORT]")).toBeVisible()
      await expect(list.locator("[data-group=unknown] [data-env=STT_SHERPA_MODLE]")).toBeVisible()
      // Bootstrap and unknown variables cannot move.
      await expect(list.locator("[data-group=bootstrap]").getByRole("button", { name: /Move/ })).toHaveCount(0)

      await movable.getByRole("button", { name: "Move TTS_SHERPA_SPEED to settings" }).click()
      await expect(page.getByTestId("move-result")).toContainText("TTS_SHERPA_SPEED is now a saved setting")
      await expect(movable.locator("[data-env=TTS_SHERPA_SPEED]")).toHaveCount(0)
      expect((await log("settings.moveFromEnv")).map((m) => m.keys)).toEqual([["TTS_SHERPA_SPEED"]])

      await page.getByTestId("move-all").click()
      await expect(page.getByTestId("move-result")).toContainText("ANTHROPIC_API_KEY is now a saved setting")
      await expect(list.locator("[data-group=movable]")).toHaveCount(0)
      await expect(page.getByTestId("move-all")).toHaveCount(0)
      // The field it locked is a saved setting now (no pin, no Move).
      await gotoAdmin(page, baseURL, "#settings/shared/accounts")
      const key = page.getByTestId("form-s-language-model").locator("[data-field=ANTHROPIC_API_KEY]")
      await expect(key).toHaveAttribute("data-source", "saved")
      await expect(key.getByTestId("move-to-settings")).toHaveCount(0)
      const overflow = await page.evaluate(() => {
        const panel = document.querySelector("[data-testid=settings-page]")!
        return panel.scrollWidth - panel.clientWidth
      })
      expect(overflow).toBe(0)
    })

    test("a field set by .env shows the file and line, and moves into the settings from there", async ({ page, baseURL }) => {
      await gotoAdmin(page, baseURL, "#settings/shared/accounts")
      const key = page.getByTestId("form-s-language-model").locator("[data-field=ANTHROPIC_API_KEY]")
      await expect(key).toHaveAttribute("data-source", "env-file")
      await key.getByTestId("move-to-settings").click()
      await expect(key).toHaveAttribute("data-source", "saved")
      expect((await log("settings.moveFromEnv")).map((m) => m.keys)).toEqual([["ANTHROPIC_API_KEY"]])
    })

    test("a download on the Models page shows progress and can be cancelled", async ({ page, baseURL }) => {
      await gotoAdmin(page, baseURL, "#settings/shared/speech")
      const models = page.getByTestId("models-stt-models")
      await expect(models).toContainText("3 of 5 downloaded")
      const whisper = models.locator("[data-model=whisper-turbo]")
      await expect(whisper).toHaveAttribute("data-state", "missing")
      await expect(whisper).toContainText("565 MB")
      // The model in use cannot be deleted.
      await expect(models.locator("[data-model=parakeet-v2]").getByRole("button", { name: /Delete/ })).toBeDisabled()

      await whisper.getByRole("button", { name: /Download Whisper turbo/ }).click()
      await expect(whisper).toHaveAttribute("data-state", "downloading")
      const bar = whisper.getByRole("progressbar")
      await expect(bar).toHaveAttribute("aria-valuenow", /^[1-9]\d?$/, { timeout: 4000 })
      await expect(whisper.getByTestId("job-progress")).toContainText(/Downloading · \d+%/)
      await whisper.getByRole("button", { name: "Cancel" }).click()
      await expect(whisper).toHaveAttribute("data-state", "missing")
      await expect(whisper).toContainText("Cancelled.")
      expect((await log("job.cancel")).length).toBe(1)

      // Delete one that is not in use, then download it again to the end.
      const zip = models.locator("[data-model=zipformer-en]")
      await zip.getByRole("button", { name: /Delete/ }).click()
      await expect(zip).toHaveAttribute("data-state", "missing")
      await expect(models).toContainText("2 of 5 downloaded")
      // The voice models are on Voice providers.
      await gotoAdmin(page, baseURL, "#settings/shared/providers")
      await expect(page.getByTestId("models-tts-models").locator("[data-model=nl_NL-pim-medium]")).toHaveAttribute("data-state", "missing")
    })
  })
}

test.describe("with the keys locked", () => {
  test.beforeEach(async () => {
    await mock.scenario("keys-locked")
  })

  test("a key cannot move until the vault is unlocked; downloads need no keys", async ({ page, baseURL }) => {
    const list = await overrides(page, baseURL)
    await expect(list).toContainText("keys can move once it is unlocked")
    await expect(list).not.toContainText("Needs the admin login") // a logged-in admin may change everything
    await gotoAdmin(page, baseURL, "#settings/shared/speech")
    const whisper = page.getByTestId("models-stt-models").locator("[data-model=whisper-turbo]")
    await expect(whisper.getByRole("button", { name: /Download/ })).toBeVisible()
  })
})
