import type { Page } from "@playwright/test"
import { appUrl, expect, expectVisualState, loginAdmin, mock, test } from "./fixtures.ts"

// Admin › Front ends › Voice assistant in a browser: the kind's defaults with the phrase list and the phrase tester;
// a saved change reaches a running voice page at once.

const updates = async () => (await mock.log()).messages.filter((m) => m.type === "frontend.update").map((m) => m.patch)
const save = (page: Page) => page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true })

test.beforeEach(async () => {
  await mock.scenario("typed")
})

test("groups, the phrase list with validation, and Save sends only what changed; the voice page follows live", async ({ page, baseURL, context }) => {
  const voice = await context.newPage()
  await voice.goto(appUrl(baseURL))
  await voice.getByTestId("start").click()
  await expectVisualState(voice, "listening")

  await loginAdmin(page, baseURL, "#settings/frontends")
  const form = page.getByTestId("profile-frontend-web-voice")
  await expect(page.getByTestId("page-frontends-frontend")).toBeVisible()
  for (const group of ["Activation", "Interrupting", "Audio processing", "Display"]) await expect(form.getByRole("heading", { name: group })).toBeVisible()
  // A device has no voice of its own any more (docs/VOICE-PROVIDERS.md §1).
  await expect(form.getByRole("heading", { name: "Voice", exact: true })).toHaveCount(0)
  await expect(form.locator("[data-field=voice]")).toHaveCount(0)
  await expect(form.locator("[data-group=advanced] summary")).toHaveText(/Advanced/)

  await form.getByRole("radio", { name: "Wake phrase" }).click()
  const list = form.getByTestId("phrase-list")
  await expect(list.locator("[data-phrase]")).toHaveCount(3)
  const input = list.getByLabel("New wake phrase")
  await input.fill("Hey, Jeff!")
  await list.getByRole("button", { name: "Add" }).click()
  await expect(list.getByRole("alert")).toHaveText("That phrase is already in the list.")
  await input.fill("one two three four five six seven")
  await input.press("Enter")
  await expect(list.getByRole("alert")).toHaveText("Use at most 6 words.")
  await input.fill("Hey Geoffrey")
  await input.press("Enter")
  await expect(list.locator("[data-phrase='hey geoffrey']")).toBeVisible()
  await list.getByRole("button", { name: "Remove “hey jev”" }).click()
  const phrasesField = form.locator("[data-field=wakePhrases]")
  await expect(phrasesField).toHaveAttribute("data-overridden", "true")
  // An edit is "Unsaved"; once saved it is "Custom" (it differs from the built-in default), never both for one reason.
  await expect(phrasesField.getByTestId("unsaved-marker")).toHaveText("Unsaved")
  await expect(phrasesField.getByTestId("custom-marker")).toHaveCount(0)
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  await expect(phrasesField.getByTestId("unsaved-marker")).toHaveCount(0)
  await expect(phrasesField.getByTestId("custom-marker")).toHaveText("Custom")
  await expect(phrasesField.getByTestId("reset")).toHaveAccessibleName(/^Reset Wake phrases to the built-in default/)
  // A field named like its group keeps its label for assistive technology only.
  await expect(form.locator("#frontend-web-voice-activation-label")).toHaveClass(/sr-only/)
  await expect(form.locator("#frontend-web-voice-activation-label")).toHaveText("Activation")
  expect(await updates()).toEqual([{ activation: "wake-phrase", wakePhrases: ["hey jeff", "hey geoff", "hey geoffrey"] }])

  // The running voice page got the new profile: it is asleep now, waiting for the first phrase.
  await expectVisualState(voice, "asleep")
  await expect(voice.getByTestId("state-label")).toHaveText("Say “Hey Jeff”")

  // Reset a field to the built-in value: saved as null.
  await form.locator("[data-field=activation]").getByTestId("reset").click()
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  expect((await updates()).at(-1)).toEqual({ activation: null })
  await expectVisualState(voice, "listening")
  await voice.close()
})

test("the phrase tester: Listen, lines marked matched, answered or ignored, Add as phrase, off when the page is left", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/frontends/web-voice")
  // Always listening: the wake settings are folded away; they open on demand.
  await expect(page.getByTestId("phrase-tester")).toBeHidden()
  await page.getByTestId("wake-settings-folded").locator("summary").click()
  const tester = page.getByTestId("phrase-tester")
  await expect(tester).toContainText("Say your phrase to a device")
  await tester.getByRole("button", { name: "Listen" }).click()
  await expect(tester).toHaveAttribute("data-on", "true")
  await expect(tester).toContainText("no device has the audio")
  await expect(tester).toContainText("Nothing heard yet.")
  await mock.heard("Hey Jeff", "hey jeff", true)
  await mock.heard("And tomorrow?", undefined, true)
  await expect(tester.getByTestId("tester-announcer")).toContainText("accepted without a phrase")
  await mock.heard("Hey go, what's the time?", undefined, false)
  const lines = tester.getByTestId("heard-lines")
  await expect(lines.locator("li")).toHaveCount(3)
  await expect(lines.locator("[data-outcome=matched]")).toContainText("Matched Hey Jeff")
  // Accepted without a phrase (the device was already listening): answered, nothing to add.
  const answered = lines.locator("[data-outcome=accepted]")
  await expect(answered).toContainText("Accepted without a phrase")
  await expect(answered.getByTestId("add-heard")).toHaveCount(0)
  const ignored = lines.locator("[data-outcome=ignored]")
  await expect(ignored).toContainText("Ignored")
  await expect(ignored.getByTestId("add-heard")).toHaveText("Add “hey go”")
  await expect(tester.getByTestId("tester-announcer")).toContainText("ignored")
  await ignored.getByRole("button", { name: /Add “hey go” as a wake phrase/ }).click()
  await expect(ignored).toContainText("Added “hey go”, not saved yet")
  await expect(page.getByTestId("phrase-list").locator("[data-phrase='hey go']")).toBeVisible()
  // The tester judges with saved settings: an unsaved edit is said not to be tested yet.
  await expect(tester.getByTestId("tester-unsaved")).toContainText("not tested until you save")
  // A server that does not say whether a line was accepted: only that no phrase matched.
  await mock.heard("Something else", undefined, null)
  await expect(lines.locator("[data-outcome=no-match]")).toContainText("No phrase matched")
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  await expect(tester.getByTestId("tester-unsaved")).toHaveCount(0)
  expect((await updates()).at(-1)).toEqual({ wakePhrases: ["hey jeff", "hey jev", "hey geoff", "hey go"] })
  // Leaving the page switches the tester off.
  await page.getByTestId("nav-voices").click()
  await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "wake.test").map((m) => m.on)).toEqual([true, false])
})

test("Cancel puts the saved values back; a number out of range blocks Save", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/frontends/web-voice")
  const form = page.getByTestId("profile-frontend-web-voice")
  await form.getByRole("radio", { name: "Wake phrase" }).click()
  await expect(page.getByTestId("wake-settings-folded")).toHaveCount(0)
  // By id: after Cancel the field is folded away again (always listening), so it has no accessible role then.
  const followUp = form.locator("#frontend-web-voice-followUpSeconds")
  await followUp.fill("90")
  await expect(form.locator("[data-field=followUpSeconds]").getByRole("alert")).toHaveText("A whole number from 0 to 60.")
  await expect(save(page)).toBeDisabled()
  await followUp.fill("20")
  await expect(save(page)).toBeEnabled()
  await page.getByTestId("page-footer").getByRole("button", { name: "Cancel" }).click()
  await expect(followUp).toHaveValue("8")
  expect(await updates()).toEqual([])
})
