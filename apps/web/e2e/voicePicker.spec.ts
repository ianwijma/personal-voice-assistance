import type { Locator, Page } from "@playwright/test"
import { expect, gotoAdmin, loginAdmin, MOCK, mock, test } from "./fixtures.ts"

// The voice picker (docs/VOICE-PROVIDERS.md §4, §5; the mock's /api/): Assistants › Jeff › Voice shows the assistant's voice
// as a picker in place of the ASSISTANT_VOICE text field. Mock data: On this machine (Lessac and Heart installed,
// Alba and Pim not), Cartesia (no key), ElevenLabs (key set); favourites Charlotte, Heart, Skylar, Daniel, Lessac.

const PAGE = "#settings/assistants/jeff/voice"
const picker = (page: Page) => page.getByTestId("voice-picker")
const popup = (page: Page) => page.getByTestId("voice-popup")
const rows = (page: Page) => popup(page).getByTestId("voice-row")
const row = (page: Page, key: string) => popup(page).locator(`[data-testid=voice-row][data-voice="${key}"]`)
const rowNames = (page: Page) => rows(page).locator("[data-row-main] > span:nth-of-type(2)").allInnerTexts()
const tab = (page: Page, id: string) => page.getByTestId("voice-rail").locator(`[data-tab="${id}"]`)
const open = async (page: Page) => {
  await picker(page).click()
  await expect(popup(page)).toBeVisible()
  await expect(popup(page).getByTestId("voice-list")).not.toHaveAttribute("data-mode", /^$/)
  await expect(rows(page).first()).toBeVisible()
}
const action = (r: Locator, name: string) => r.locator(`[data-action=${name}]`)

test.beforeEach(async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await loginAdmin(page, baseURL, PAGE)
  await expect(picker(page)).toContainText("Lessac")
})

test("the closed button shows the provider's mark and the voice; it opens a popover and closes on Esc and outside", async ({ page }) => {
  await expect(picker(page).locator("[data-provider-mark=sherpa]")).toBeVisible()
  await expect(picker(page)).toHaveAttribute("aria-expanded", "false")
  await open(page)
  await expect(picker(page)).toHaveAttribute("aria-expanded", "true")
  await expect(popup(page)).toHaveAttribute("data-layout", "popover")
  await expect(popup(page)).toHaveAccessibleName("Choose the assistant's voice")
  // Focus is in the search; Esc closes and gives focus back to the button.
  await expect(popup(page).getByTestId("voice-search")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(popup(page)).toBeHidden()
  await expect(picker(page)).toBeFocused()
  // A press outside closes it.
  await open(page)
  await page.getByTestId("page-title").click()
  await expect(popup(page)).toBeHidden()
  // It is under the button and fully on screen.
  await open(page)
  const b = (await picker(page).boundingBox())!
  const p = (await popup(page).boundingBox())!
  expect(p.y).toBeGreaterThan(b.y + b.height - 1)
  expect(p.y + p.height).toBeLessThanOrEqual(800)
  expect(p.x + p.width).toBeLessThanOrEqual(1280)
})

test("flips above the button when there is no room below", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 })
  await page.evaluate(() => {
    const el = document.querySelector("[data-testid=voice-picker]") as HTMLElement
    el.style.marginTop = "300px"
  })
  await open(page)
  const b = (await picker(page).boundingBox())!
  const p = (await popup(page).boundingBox())!
  expect(p.y + p.height).toBeLessThanOrEqual(b.y + 1)
  expect(p.y).toBeGreaterThanOrEqual(0)
})

test("Favourites is one flat list, voices of a provider together; a favourite without its provider's key stays", async ({ page }) => {
  await open(page)
  await expect(tab(page, "favourites")).toHaveAttribute("aria-selected", "true")
  await expect(popup(page).getByTestId("voice-list")).toHaveAttribute("data-mode", "favourites")
  // No provider headers, providers in rail order, each in the order added.
  await expect(popup(page).locator("li[aria-hidden=true]")).toHaveCount(0)
  expect(await rowNames(page)).toEqual(["Heart", "Lessac", "Skylar", "Charlotte", "Daniel"])
  await expect(row(page, "cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4")).toContainText("Needs a Cartesia key")
  await expect(row(page, "sherpa:en_US-lessac-medium").getByTestId("voice-selected")).toBeVisible()
  await expect(row(page, "sherpa:en_US-lessac-medium").locator("[data-row-main]")).toHaveAttribute("aria-current", "true")
  // The unavailable one cannot be chosen, but the arrow keys still pass through it.
  const skylar = row(page, "cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4").locator("[data-row-main]")
  await expect(skylar).toHaveAttribute("aria-disabled", "true")
  await row(page, "sherpa:en_US-lessac-medium").locator("[data-row-main]").focus()
  await page.keyboard.press("ArrowDown")
  await expect(skylar).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(popup(page)).toBeVisible()
  await page.keyboard.press("ArrowDown")
  await expect(row(page, "elevenlabs:mk2Ls1fsHW4xr9Ic3Bb2").locator("[data-row-main]")).toBeFocused()
})

test("the rail lists one provider's voices; the provider that needs a key explains and links to its settings", async ({ page }) => {
  await open(page)
  await tab(page, "sherpa").click()
  await expect(tab(page, "sherpa")).toHaveAttribute("aria-selected", "true")
  expect(await rowNames(page)).toEqual(["Lessac", "Alba", "Pim", "Heart"])
  await expect(row(page, "sherpa:en_GB-alba-medium")).toHaveAttribute("data-local", "not_installed")
  await tab(page, "elevenlabs").click()
  await expect(rows(page)).toHaveCount(10)
  await expect(rows(page).first()).toContainText("Sarah")
  await expect(rows(page).first()).toContainText("English · female · american · young")
  // Cartesia: a marker on its icon, an explanation instead of the list, and the way to its key.
  await expect(tab(page, "cartesia")).toHaveAttribute("data-trouble", "needs_key")
  await expect(tab(page, "cartesia")).toHaveAccessibleName("Cartesia (needs a key)")
  await tab(page, "cartesia").click()
  const needs = popup(page).getByTestId("provider-needs-key")
  await expect(needs).toContainText("No Cartesia key yet")
  await expect(needs).toContainText("Replies are sent to Cartesia to be spoken.")
  await needs.getByTestId("open-provider-settings").click()
  await expect(popup(page)).toBeHidden()
  await expect(page.getByTestId("page-shared-providers")).toBeVisible()
  await expect(page.getByTestId("page-title")).toHaveText("Voice providers")
})

test("with the keys locked, hosted providers say so", async ({ page, baseURL }) => {
  await mock.scenario("keys-locked")
  await loginAdmin(page, baseURL, PAGE)
  await open(page)
  await expect(tab(page, "elevenlabs")).toHaveAccessibleName("ElevenLabs (keys locked)")
  await tab(page, "elevenlabs").click()
  await expect(popup(page).getByTestId("provider-needs-key")).toHaveAttribute("data-reason", "vault_locked")
  await expect(popup(page).getByTestId("provider-needs-key")).toContainText("The keys are locked")
})

test("a provider whose key is refused shows why, above its older voices", async ({ page }) => {
  await fetch(`${MOCK}/mock/voices/fail`, { method: "POST", body: JSON.stringify({ provider: "elevenlabs" }) })
  await page.reload()
  await expect(picker(page)).toContainText("Lessac")
  await open(page)
  await expect(tab(page, "elevenlabs")).toHaveAttribute("data-trouble", "error")
  await tab(page, "elevenlabs").click()
  await expect(popup(page).getByTestId("provider-error")).toContainText("ElevenLabs refused the API key")
  await expect(rows(page)).toHaveCount(10)
  await expect(action(rows(page).first(), "preview")).toBeDisabled()
})

test("search looks across every provider at once, under provider headers", async ({ page }) => {
  await open(page)
  await tab(page, "sherpa").click()
  await popup(page).getByTestId("voice-search").fill("gb")
  await expect(popup(page).getByTestId("voice-list")).toHaveAttribute("data-mode", "search")
  await expect(popup(page).locator("li[aria-hidden=true]")).toHaveText(["On this machine", "ElevenLabs"])
  expect(await rowNames(page)).toEqual(["Alba", "Charlotte", "Daniel", "Lily"])
  // While searching no tab is chosen; every word must match, case and accents aside.
  await expect(tab(page, "sherpa")).toHaveAttribute("aria-selected", "false")
  await popup(page).getByTestId("voice-search").fill("BRITISH news")
  expect(await rowNames(page)).toEqual(["Daniel"])
  await popup(page).getByTestId("voice-search").fill("nobody here")
  await expect(popup(page).getByTestId("voice-list-empty")).toContainText("No voices match")
  // A rail tab clears the search.
  await tab(page, "elevenlabs").click()
  await expect(popup(page).getByTestId("voice-search")).toHaveValue("")
  await expect(rows(page)).toHaveCount(10)
})

test("a star adds and removes a favourite, on the server", async ({ page, baseURL }) => {
  await open(page)
  await tab(page, "elevenlabs").click()
  const sarah = row(page, "elevenlabs:EXAVITQu4vr4xnSDxMaL")
  const star = action(sarah, "favourite")
  // Hidden until hover or focus, while off.
  expect(await star.evaluate((el) => getComputedStyle(el).opacity)).toBe("0")
  await sarah.hover()
  await expect.poll(() => star.evaluate((el) => getComputedStyle(el).opacity)).toBe("1")
  await expect(star).toHaveAttribute("aria-pressed", "false")
  await star.click()
  await expect(star).toHaveAttribute("aria-pressed", "true")
  await tab(page, "favourites").click()
  expect(await rowNames(page)).toEqual(["Heart", "Lessac", "Skylar", "Charlotte", "Daniel", "Sarah"])
  await action(row(page, "elevenlabs:mk2Ls1fsHW4xr9Ic3Bb2"), "favourite").click()
  await expect(row(page, "elevenlabs:mk2Ls1fsHW4xr9Ic3Bb2")).toHaveCount(0)
  // Kept on the server: another tab (another device) sees the same list.
  const other = await page.context().browser()!.newPage()
  await gotoAdmin(other, baseURL, PAGE)
  await other.getByTestId("voice-picker").click()
  await expect(other.getByTestId("voice-row").first()).toBeVisible()
  expect(await other.getByTestId("voice-row").locator("[data-row-main] > span:nth-of-type(2)").allInnerTexts()).toEqual(["Heart", "Lessac", "Skylar", "Daniel", "Sarah"])
  await other.close()
})

test("the speaker previews the text on the right without selecting; stop, and another preview replaces it", async ({ page }) => {
  await fetch(`${MOCK}/mock/voices/hold`, { method: "POST", body: JSON.stringify({ ms: 500 }) })
  await open(page)
  await tab(page, "sherpa").click()
  const text = popup(page).getByTestId("preview-text")
  await expect(text).toHaveValue(/^Hi, I'm your assistant\./)
  await text.fill("Good morning. It is eight degrees and dry.")
  const heart = row(page, "sherpa:kokoro-af_heart")
  await action(heart, "preview").click()
  await expect(heart).toHaveAttribute("data-preview", "loading")
  await expect(action(heart, "stop")).toHaveAccessibleName("Stop the preview of Heart")
  await expect(heart).toHaveAttribute("data-preview", "playing")
  await expect(popup(page).getByTestId("preview-status")).toContainText("Reading in Heart · On this machine")
  // Previewing did not select it.
  await expect(picker(page)).toContainText("Lessac")
  await expect(heart.getByTestId("voice-selected")).toHaveCount(0)
  const previews = async () => (await mock.log()).messages.filter((m) => m.type === "api.preview")
  expect((await previews()).at(-1)).toMatchObject({ voice: "sherpa:kokoro-af_heart", text: "Good morning. It is eight degrees and dry." })
  // Stop.
  await action(heart, "stop").click()
  await expect(heart).not.toHaveAttribute("data-preview", /./)
  await expect(action(heart, "preview")).toBeVisible()
  // Another preview replaces the running one.
  await action(heart, "preview").click()
  await expect(heart).toHaveAttribute("data-preview", "playing")
  const lessac = row(page, "sherpa:en_US-lessac-medium")
  await action(lessac, "preview").click()
  await expect(heart).not.toHaveAttribute("data-preview", /./)
  await expect(lessac).toHaveAttribute("data-preview", /loading|playing/)
  await expect(lessac).toHaveAttribute("data-preview", "playing")
  // Reset brings the default text back; closing stops the preview.
  await popup(page).getByTestId("preview-reset").click()
  await expect(text).toHaveValue(/^Hi, I'm your assistant\./)
  // Reset is now disabled, so focus fell out of the popup: Esc still closes it.
  await expect(popup(page).getByTestId("preview-reset")).toBeDisabled()
  await page.keyboard.press("Escape")
  await expect(popup(page)).toBeHidden()
  await open(page)
  await tab(page, "sherpa").click()
  await expect(popup(page).locator("[data-preview]")).toHaveCount(0)
})

test("a local voice that is not downloaded downloads, with progress and cancel; then it can be previewed", async ({ page }) => {
  await open(page)
  await tab(page, "sherpa").click()
  const alba = row(page, "sherpa:en_GB-alba-medium")
  await expect(action(alba, "download")).toHaveAccessibleName("Download Alba (68 MB)")
  await action(alba, "download").click()
  await expect(alba).toHaveAttribute("data-local", "downloading")
  const progress = alba.getByRole("progressbar", { name: "Downloading Alba" })
  await expect(progress).toBeVisible()
  await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow") ?? 0)).toBeGreaterThan(0)
  await expect(alba.getByTestId("voice-download-progress")).toContainText(/\d+%/)
  await action(alba, "cancel").click()
  await expect(alba).toHaveAttribute("data-local", "not_installed")
  await expect(action(alba, "download")).toBeVisible()
  // Pressing the row of a voice that is not downloaded downloads it (it does not select it).
  const pim = row(page, "sherpa:nl_NL-pim-medium")
  await pim.locator("[data-row-main]").click()
  await expect(pim).toHaveAttribute("data-local", "downloading")
  await expect(picker(page)).toContainText("Lessac")
  await expect(pim).toHaveAttribute("data-local", "installed", { timeout: 15_000 })
  await expect(action(pim, "preview")).toBeEnabled()
})

test("choosing a voice is a draft on the assistant: Save sends assistant.save with the voice; no reload is asked for", async ({ page }) => {
  await open(page)
  await tab(page, "elevenlabs").click()
  await row(page, "elevenlabs:mk3Mt2gtIX5ys0Jd4Cc3").locator("[data-row-main]").click()
  await expect(popup(page)).toBeHidden()
  await expect(picker(page)).toContainText("Daniel")
  await expect(picker(page).locator("[data-provider-mark=elevenlabs]")).toBeVisible()
  await expect(picker(page)).toBeFocused()
  await expect(page.locator("[data-field=voice]").getByTestId("unsaved-marker")).toBeVisible()
  expect((await mock.log()).messages.filter((m) => m.type === "assistant.save")).toEqual([])
  await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  const saves = (await mock.log()).messages.filter((m) => m.type === "assistant.save")
  expect(saves).toHaveLength(1)
  expect((saves[0] as unknown as { assistant: { id: string; voice: unknown } }).assistant).toMatchObject({ id: "jeff", voice: { provider: "elevenlabs", voiceId: "mk3Mt2gtIX5ys0Jd4Cc3" } })
  expect((await mock.log()).messages.filter((m) => m.type === "engine.reload")).toEqual([])
  await expect(page.getByTestId("reload-pending")).toHaveCount(0)
})

test("keyboard: open, arrows through the rail and the rows, Tab to a row's buttons, Enter selects", async ({ page }) => {
  await picker(page).focus()
  await page.keyboard.press("Enter")
  await expect(popup(page).getByTestId("voice-search")).toBeFocused()
  await expect(rows(page).first()).toBeVisible()
  await page.keyboard.press("ArrowDown")
  const main = (key: string) => row(page, key).locator("[data-row-main]")
  await expect(main("sherpa:kokoro-af_heart")).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(main("sherpa:en_US-lessac-medium")).toBeFocused()
  // Only the active row's controls are in the Tab order: its speaker, then its star.
  await page.keyboard.press("Tab")
  await expect(action(row(page, "sherpa:en_US-lessac-medium"), "preview")).toBeFocused()
  await page.keyboard.press("Tab")
  const star = action(row(page, "sherpa:en_US-lessac-medium"), "favourite")
  await expect(star).toBeFocused()
  expect(await star.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid")
  await page.keyboard.press("Tab")
  await expect(popup(page).getByTestId("preview-text")).toBeFocused()
  // Up from the first row goes back to the search.
  await main("sherpa:kokoro-af_heart").focus()
  await page.keyboard.press("ArrowUp")
  await expect(popup(page).getByTestId("voice-search")).toBeFocused()
  // The rail: one Tab stop, arrows move and choose.
  await tab(page, "favourites").focus()
  await page.keyboard.press("ArrowDown")
  await expect(tab(page, "sherpa")).toBeFocused()
  await expect(tab(page, "sherpa")).toHaveAttribute("aria-selected", "true")
  await expect(tab(page, "elevenlabs")).toHaveAttribute("tabindex", "-1")
  // Into the list and choose with Enter: the popup closes and focus is on the button again.
  await popup(page).getByTestId("voice-search").focus()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await expect(main("sherpa:en_GB-alba-medium")).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await expect(main("sherpa:kokoro-af_heart")).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(popup(page)).toBeHidden()
  await expect(picker(page)).toContainText("Heart")
  await expect(picker(page)).toBeFocused()
})

test("every control in the popup has a name", async ({ page }) => {
  await open(page)
  await tab(page, "sherpa").click()
  const unnamed = await popup(page).locator("button, input, textarea, [role=tab]").evaluateAll((els) =>
    els.filter((el) => {
      const label = el.getAttribute("aria-label") ?? (el.id !== "" ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null) ?? el.textContent
      return (label ?? "").trim() === ""
    }).map((el) => el.outerHTML.slice(0, 120)))
  expect(unnamed).toEqual([])
})

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("a bottom sheet: the rail is a row of tabs, the preview text folds away, stars are always shown", async ({ page }) => {
    await open(page)
    await expect(popup(page)).toHaveAttribute("data-layout", "sheet")
    // At the bottom, full width (once it has slid up).
    await expect.poll(async () => {
      const p = (await popup(page).boundingBox())!
      return [Math.round(p.width), Math.round(p.y + p.height)]
    }).toEqual([390, 844])
    await expect(page.getByTestId("voice-rail")).toHaveAttribute("aria-orientation", "horizontal")
    await expect(popup(page).getByTestId("preview-text")).toBeHidden()
    await tab(page, "elevenlabs").tap()
    const first = rows(page).first()
    expect(await action(first, "favourite").evaluate((el) => getComputedStyle(el).opacity)).toBe("1")
    for (const el of [first.locator("[data-row-main]"), action(first, "preview"), tab(page, "sherpa")]) {
      const b = (await el.boundingBox())!
      expect(Math.round(b.height)).toBeGreaterThanOrEqual(40)
    }
    await popup(page).getByTestId("preview-side").locator("summary").tap()
    await expect(popup(page).getByTestId("preview-text")).toBeVisible()
    await popup(page).getByRole("button", { name: "Close" }).tap()
    await expect(popup(page)).toBeHidden()
  })
})
