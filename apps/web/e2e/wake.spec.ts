import { appUrl, expect, expectVisualState, mock, test } from "./fixtures.ts"

// The voice front end with protocol 5: the settings sheet (activation, follow-up from the device profile),
// the device identity in hello, and the asleep / woke display.

test("hello carries a stable device id and a name from the user agent; the profile comes from the server", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("start")).toBeVisible()
  const id = await page.evaluate(() => localStorage.getItem("pva.deviceId"))
  expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
  await page.reload()
  await expect(page.getByTestId("start")).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("pva.deviceId"))).toBe(id)
})

test("the sheet: the wake phrase goes to the server; the phrases are read-only; follow-up; no voice of its own", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.getByTestId("settings-toggle").click()
  const sheet = page.getByTestId("voice-sheet")
  // The voice is the assistant's, chosen in admin (docs/VOICE-PROVIDERS.md §1): the sheet has no voice choice.
  await expect(sheet.getByTestId("voice-choices")).toHaveCount(0)
  await expect(sheet.getByRole("heading", { name: "Voice", exact: true })).toHaveCount(0)

  await expect(sheet).toContainText("reacts to everything it hears")
  await sheet.getByRole("radio", { name: "Wake phrase" }).click()
  const phrases = sheet.getByTestId("wake-phrases")
  await expect(phrases).toContainText("Hey Jeff")
  await expect(phrases.getByRole("textbox")).toHaveCount(0) // changed in admin only
  await expect(phrases.getByRole("link", { name: "admin" })).toHaveAttribute("href", /\/admin\//)
  await sheet.getByLabel("Keep listening after a reply").selectOption("15")
  await expect.poll(async () => (await mock.log()).messages.filter((m) => m.type === "device.update").map((m) => m.patch)).toEqual([
    { activation: "wake-phrase" },
    { followUpSeconds: 15 }
  ])
  // The server is the source of truth: after a reload the sheet shows what it stored.
  await page.reload()
  await page.getByTestId("settings-toggle").click()
  await expect(page.getByTestId("voice-sheet").getByRole("radio", { name: "Wake phrase" })).toHaveAttribute("aria-checked", "true")
  await expect(page.getByTestId("voice-sheet").getByLabel("Keep listening after a reply")).toHaveValue("15")
  // Microphone and speaker stay in this browser.
  await expect(page.getByTestId("voice-sheet").locator("#pref-mic")).toBeVisible()
})

test("asleep: the label asks for the phrase; the phrase alone shows Listening… and the turn follows", async ({ page, baseURL }) => {
  await mock.scenario("wake")
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "asleep")
  const label = page.getByTestId("state-label")
  await expect(label).toHaveText("Say “Hey Jeff”")
  // The visible label is not live; one polite region announces asleep / woke (not hearing, thinking, speaking).
  await expect(page.getByTestId("state-announcer")).toHaveAttribute("aria-live", "polite")
  await expect(page.getByTestId("state-announcer")).toHaveText("Asleep. Say “Hey Jeff”")
  const box = await label.boundingBox()
  await expectVisualState(page, "listening", 8000) // "hey jeff" (the mock's script)
  await expect(label).toHaveText("Listening…")
  const after = await label.boundingBox()
  expect(after!.y).toBe(box!.y) // no layout shift
  expect(after!.height).toBe(box!.height)
  await expectVisualState(page, "speaking", 10_000)
})

test("the wake cue plays through the player only for the phrase alone, and is never reported", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await mock.send([{ type: "state", state: "asleep" }])
  await expectVisualState(page, "asleep")
  await mock.wake("hey jeff", false) // phrase + request in one sentence: no cue, no "Listening…"
  await expectVisualState(page, "asleep")
  await mock.wake("hey jeff", true)
  await expect(page.getByTestId("state-label")).toHaveText("Listening…")
  await page.waitForTimeout(400)
  const log = await mock.log()
  expect(log.messages.filter((m) => m.type.startsWith("playback."))).toEqual([]) // the cue is local
})
