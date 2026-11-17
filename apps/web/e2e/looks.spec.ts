import { type Page } from "@playwright/test"
import { appUrl, expect, loginAdmin, mock, test } from "./fixtures.ts"

// Looks and voices (docs/LOOKS-AND-VOICES.md): an assistant's look on its Look tab (character picker, options from the
// manifest, saved with `assistant.save`, shown on the voice page); a device's own look and voice (Own value · Reset,
// saved with `device.save` as `{ from: "device", … }`, reset as null). Mock data: Jeff answers without a phrase on every
// browser; the Kitchen iPad has its own assistant list.

const KITCHEN = "d-kitchen-ipad-0001"
const save = (page: Page) => page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true })
const card = (page: Page, id: string) => page.locator(`[role=radio][data-character="${id}"]`)
type Logged = Record<string, any>
const sent = async (type: string): Promise<ReadonlyArray<Logged>> => (await mock.log()).messages.filter((m) => m.type === type) as ReadonlyArray<Logged>

test.beforeEach(async () => {
  await mock.scenario("devices")
})

test("an assistant's look: pick a character, change an option, save; the voice page shows it", async ({ page, baseURL, context }) => {
  await loginAdmin(page, baseURL, "#settings/assistants/jeff/look")
  const editor = page.getByTestId("look-editor")
  // No look yet: the baseline, with nothing to tune changed.
  await expect(editor).toHaveAttribute("data-character", "sine-lines")
  await expect(card(page, "sine-lines")).toHaveAttribute("aria-checked", "true")
  await expect(page.getByTestId("look-preview")).toHaveAttribute("data-on-stage", "sine-lines")

  await card(page, "flame").click()
  await expect(editor).toHaveAttribute("data-character", "flame")
  await expect(card(page, "flame")).toHaveAttribute("aria-checked", "true")
  await expect(page.getByTestId("look-title")).toHaveText("Jeff's look: Flame")
  await expect(page.getByTestId("look-preview")).toHaveAttribute("data-on-stage", "flame")
  await expect(page.locator("#tab-look [data-mark=dirty]")).toBeVisible()

  // Options come from the manifest: a slider with its value, a switch, a segmented choice.
  const size = page.getByLabel("Size", { exact: true })
  await size.fill("0.8")
  await expect(page.locator("[data-option=size] [data-testid=option-value]")).toHaveText("0.80×")
  await page.getByRole("switch", { name: "Sparks" }).click()
  await expect(page.getByTestId("reset-all")).toHaveText("Reset all (2)")
  // Reset one, then set it again.
  await page.locator("[data-option=sparks]").getByTestId("option-reset").click()
  await expect(page.getByRole("switch", { name: "Sparks" })).toHaveAttribute("aria-checked", "true")
  await page.getByRole("switch", { name: "Sparks" }).click()
  // Pinning a mode holds the preview on it.
  await page.getByTestId("preview-modes").getByRole("radio", { name: "Speaking" }).click()
  await expect(page.getByTestId("look-preview")).toHaveAttribute("data-mode", "speaking")

  await save(page).click()
  await expect(page.getByTestId("page-footer")).toContainText("Saved")
  const saves = await sent("assistant.save")
  expect(saves.at(-1)!.assistant.look).toEqual({ character: "flame", version: expect.stringMatching(/^\d+\.\d+\.\d+$/), options: { size: 0.8, sparks: false } })
  await expect(page.locator("#tab-look [data-mark=dirty]")).toHaveCount(0)

  // The voice page: Jeff answers here, so the stage shows his look with its options.
  const voice = await context.newPage()
  await voice.goto(appUrl(baseURL))
  await voice.waitForFunction(() => (window as any).__pvaStage?.debug().id === "flame")
  expect(await voice.evaluate(() => (window as any).__pvaStage.debug().options)).toMatchObject({ size: 0.8, sparks: false })
  // Back to the baseline from admin: the stage follows without a reload.
  await card(page, "sine-lines").click()
  await expect(page.locator("[data-option=size]")).toHaveCount(0)
  await save(page).click()
  await expect(page.getByTestId("page-footer")).toContainText("Saved")
  expect((await sent("assistant.save")).at(-1)!.assistant.look).toBeUndefined()
  await voice.waitForFunction(() => (window as any).__pvaStage.debug().id === "sine-lines")
  // A try-out from the address bar wins for this page load only.
  await voice.goto(appUrl(baseURL, "&character=lips"))
  await voice.waitForFunction(() => (window as any).__pvaStage?.debug().id === "lips")
  expect(new URL(voice.url()).searchParams.has("character")).toBe(false)
  await voice.reload()
  await voice.waitForFunction(() => (window as any).__pvaStage?.debug().id === "sine-lines")
  await voice.close()
})

test("a device's own look and voice: set both, saved as the device's own; Reset follows the assistant again", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
  const look = page.getByTestId("section-look")
  const voice = page.getByTestId("section-voice")
  await expect(look).toHaveAttribute("data-from", "assistant")
  await expect(page.getByTestId("marks-Look")).toHaveAttribute("data-own", "false")
  // Following: each assistant here, with its look and where to change it.
  await expect(look.getByTestId("look-per-assistant").locator("[data-assistant=jeff]")).toContainText("Change on Jeff › Look")

  await look.locator("[role=radio][data-value=device]").click()
  await expect(look).toHaveAttribute("data-from", "device")
  await expect(page.getByTestId("marks-Look")).toHaveAttribute("data-own", "true")
  await expect(look.getByTestId("look-title")).toHaveText("Kitchen iPad's own look: Sine lines")
  await look.getByTestId("picker-fold").locator("summary").click()
  await card(page, "lips").click()
  await expect(look.getByTestId("look-title")).toHaveText("Kitchen iPad's own look: Lips")

  await voice.locator("[role=radio][data-value=device]").click()
  await expect(voice).toHaveAttribute("data-from", "device")
  await expect(page.getByTestId("marks-Voice")).toHaveAttribute("data-own", "true")

  await save(page).click()
  await expect(page.getByTestId("page-footer")).toContainText("Saved")
  const patch = (await sent("device.save")).at(-1)!.settings
  expect(patch.look).toEqual({ from: "device", look: { character: "lips", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) } })
  expect(patch.voice).toEqual({ from: "device", voice: { provider: "sherpa", voiceId: "en_US-lessac-medium" } }) // the first assistant's (Jeff's) voice to start from

  // The list says so.
  await page.evaluate(() => { location.hash = "#settings/devices" })
  const row = page.locator(`[data-device=${KITCHEN}]`)
  await expect(row.getByTestId("device-own-look")).toHaveText("Own look: Lips")
  await expect(row.getByTestId("device-own-voice")).toContainText("Own voice:")
  await expect(page.locator("[data-device='type:web-voice']").getByTestId("device-look-voice")).toHaveCount(0)

  // Reset both: they follow the defaults (each assistant's own) again, saved as null.
  await row.click()
  await page.getByTestId("marks-Look").getByTestId("reset").click()
  await page.getByTestId("marks-Voice").getByTestId("reset").click()
  await expect(look).toHaveAttribute("data-from", "assistant")
  await expect(voice).toHaveAttribute("data-from", "assistant")
  await save(page).click()
  await expect(page.getByTestId("page-footer")).toContainText("Saved")
  const reset = (await sent("device.save")).at(-1)!.settings
  expect(reset).toEqual({ look: null, voice: null })
  await expect(page.getByTestId("marks-Look")).toHaveAttribute("data-own", "false")
})
