import { appUrl, expect, expectVisualState, mock, test } from "./fixtures.ts"

test("keyboard: ? shows shortcuts, C toggles the chat, O the settings; single keys are ignored while typing", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.keyboard.press("?")
  await expect(page.getByRole("dialog", { name: "Keyboard" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Keyboard" })).toBeHidden()
  await page.keyboard.press("c")
  await expect(page.getByTestId("chat-panel")).toBeVisible()
  await page.locator("#chat-input").fill("")
  await page.locator("#chat-input").press("o") // typing, not a shortcut
  await expect(page.getByTestId("settings")).toBeHidden()
  await expect(page.locator("#chat-input")).toHaveValue("o")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("chat-panel")).toBeHidden()
  await page.keyboard.press("o")
  await expect(page.getByTestId("settings")).toBeVisible()
  // Tab stays inside the settings screen.
  for (let i = 0; i < 20; i++) await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.querySelector("[data-testid=settings]")!.contains(document.activeElement))).toBe(true)
  await page.keyboard.press("o") // focus is on a button, not typing: O closes it again
  await expect(page.getByTestId("settings")).toBeHidden()
})

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("start, 56 px controls, the chat as a bottom sheet and full-screen settings", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").tap()
    await expectVisualState(page, "listening")
    const mic = await page.getByTestId("mic-toggle").boundingBox()
    expect(Math.round(mic!.width)).toBe(56)
    await page.getByTestId("chat-toggle").tap()
    const panel = page.getByTestId("chat-panel")
    await expect.poll(async () => {
      const b = await panel.boundingBox()
      return b === null ? null : [b.x, Math.round(b.width), Math.round(b.y + b.height)]
    }).toEqual([0, 390, 844]) // after the slide-up animation
    await page.getByRole("button", { name: "Close conversation" }).tap()
    await page.getByRole("button", { name: "Settings (O)" }).tap()
    const settings = await page.getByTestId("settings").boundingBox()
    expect([Math.round(settings!.width), Math.round(settings!.height)]).toEqual([390, 844])
  })

  test("no horizontal scrolling at 320 px", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await mock.scenario("typed")
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("start")).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBe(0)
    for (const hash of ["#settings/device/microphone", "#settings/speech/engine", "#settings/language-model/provider", "#settings/keys/keys"]) {
      await page.goto(appUrl(baseURL, hash))
      await expect(page.getByTestId("settings-page")).toBeVisible()
      const inner = await page.evaluate(() => {
        const panel = document.querySelector("[data-testid=settings-page]")!
        return [panel.scrollWidth - panel.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth]
      })
      expect(inner, hash).toEqual([0, 0])
    }
  })
})

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" })

  test("states still change and are labelled", async ({ page, baseURL }) => {
    await mock.scenario("voice")
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").click()
    await expectVisualState(page, "speaking", 10_000)
    await expect(page.getByTestId("state-label")).toHaveText(/speaking/i)
  })
})
