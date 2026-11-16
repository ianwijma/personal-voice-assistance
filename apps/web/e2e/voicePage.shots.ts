/**
 * Screenshots of the voice page with assistants (docs/ASSISTANTS.md §7.2, docs/mockups/assistants/voice.html), named
 * like the others in `screenshots.shots.ts` and numbered on from them:
 *   pnpm --filter @pva/web screenshots        (builds the export, writes apps/web/screenshots/)
 */
import { join } from "node:path"
import type { Browser, BrowserContextOptions, Page } from "@playwright/test"
import { appUrl, expect, expectVisualState, here, mock, test } from "./fixtures.ts"

const dir = process.env.SCREENSHOT_DIR ?? join(here, "..", "screenshots")
const shot = (page: Page, name: string) => page.screenshot({ path: join(dir, `${name}.png`) })
const settle = (page: Page, ms = 350) => page.waitForTimeout(ms)

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } }
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

const menuButton = (page: Page) => page.getByTestId("assistant-menu-button")
const label = (page: Page) => page.getByTestId("state-label")
const start = async (page: Page, baseURL: string | undefined, tap = false) => {
  await page.goto(appUrl(baseURL))
  await (tap ? page.getByTestId("start").tap() : page.getByTestId("start").click())
  await expectVisualState(page, "listening")
}
/** T3 answers a sentence that began with its phrase; resolves once it speaks. */
const t3Speaks = async (page: Page) => {
  await mock.turn({ assistantId: "t3", phrase: "hey t3" })
  await expect(label(page)).toHaveText("Speaking · T3", { timeout: 10_000 })
  await settle(page, 1200)
}
const openMenu = async (page: Page, tap = false) => {
  await (tap ? menuButton(page).tap() : menuButton(page).click())
  await expect(page.getByTestId("assistant-menu-button-menu")).toBeVisible()
  await settle(page, 300)
}
const openSwitcher = async (page: Page, tap = false) => {
  await (tap ? page.getByTestId("conversation-switcher").tap() : page.getByTestId("conversation-switcher").click())
  await expect(page.getByTestId("conversation-switcher-menu")).toBeVisible()
  await settle(page, 300)
}
const otherPage = async (browser: Browser, options: BrowserContextOptions, scheme: "dark" | "light" = "dark") => {
  const ctx = await browser.newContext({ ...options, colorScheme: scheme, permissions: ["microphone"] })
  return { ctx, page: await ctx.newPage() }
}

test.describe("voice, assistants, desktop, dark", () => {
  test.use({ colorScheme: "dark", ...DESKTOP })

  test("the assistant menu, with and without Whichever fits", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await page.waitForTimeout(7500) // the start hint fades
    await openMenu(page)
    await shot(page, "voice-desktop-24-assistant-menu")
    await page.keyboard.press("Escape")
    await mock.typesafe(true)
    await openMenu(page)
    await shot(page, "voice-desktop-25-assistant-menu-whichever-fits")
  })

  test("the strip names who has the turn: hearing, thinking, speaking, the follow-up", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await page.waitForTimeout(7500)
    await mock.wake("hey t3", true)
    await expect(label(page)).toHaveText("Listening… · T3")
    await settle(page, 500)
    await shot(page, "voice-desktop-26-listening-t3")
    await mock.state("hearing")
    await expect(label(page)).toHaveText("Hearing you · T3")
    await settle(page, 400)
    await shot(page, "voice-desktop-27-hearing-t3")
    await mock.state("thinking")
    await expect(label(page)).toHaveText("Thinking · T3")
    await settle(page, 400)
    await shot(page, "voice-desktop-28-thinking-t3")
    await mock.state("listening")
    await t3Speaks(page)
    await shot(page, "voice-desktop-29-speaking-t3")
    await expectVisualState(page, "listening", 20_000)
    await expect(label(page)).toHaveText("Listening… · T3")
    await settle(page, 500)
    await shot(page, "voice-desktop-30-follow-up-t3")
  })

  test("asleep: one phrase, two phrases, a phrase for each of three", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await mock.device({ withoutPhrase: { mode: "nobody" } }) // Jeff has no phrase here, T3 has two
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").click()
    await expectVisualState(page, "asleep")
    await page.waitForTimeout(7500)
    await expect(label(page)).toHaveText("Say “Hey T3”")
    await shot(page, "voice-desktop-31-asleep-one-phrase")
    await mock.device({ assistants: [{ assistant: "jeff", phrases: ["Hey Jeff"] }, { assistant: "t3", phrases: ["Hey T3", "Hey tee three"] }] })
    await expect(label(page)).toHaveText("Say “Hey Jeff” or “Hey T3”")
    await settle(page, 400)
    await shot(page, "voice-desktop-32-asleep-two-phrases")
    await mock.device({ assistants: [{ assistant: "jeff", phrases: ["Hey Jeff"] }, { assistant: "t3", phrases: ["Hey T3"] }, { assistant: "keuken", phrases: ["Hé keuken"] }] })
    await expect(label(page)).toHaveText("Say a wake phrase")
    await expect(page.getByTestId("asleep-hint")).toBeVisible()
    await settle(page, 400)
    await shot(page, "voice-desktop-33-asleep-many-phrases")
  })

  test("Whichever fits (Auto): listening, then the assistant it chose", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await mock.typesafe(true)
    await mock.device({
      assistants: [{ assistant: "jeff", phrases: ["Hey Jeff"] }, { assistant: "keuken", phrases: ["Hé keuken", "Hey keuken"], followUpSeconds: 15 }],
      withoutPhrase: { mode: "typesafe", fallback: "jeff", giveUpMs: 400 }
    })
    await start(page, baseURL)
    await page.waitForTimeout(7500)
    await expect(menuButton(page)).toHaveText("Auto")
    await shot(page, "voice-desktop-34-auto-listening")
    await mock.turn({ assistantId: "keuken" })
    await expect(label(page)).toHaveText("Speaking · Keuken", { timeout: 10_000 })
    await settle(page, 1200)
    await shot(page, "voice-desktop-35-auto-chose-keuken")
  })

  test("the settings sheet: Assistant as a choice, as a list, and with Whichever fits", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await page.waitForTimeout(7500)
    await page.getByTestId("settings-toggle").click()
    await expect(page.getByTestId("assistant-choices")).toBeVisible()
    await settle(page, 500)
    await shot(page, "voice-desktop-36-settings-sheet-assistant")
    await page.getByTestId("sheet-assistant-t3").click()
    await expect(page.getByTestId("assistant-saved")).toBeVisible()
    await settle(page, 400)
    await shot(page, "voice-desktop-37-settings-sheet-picked")
    await page.keyboard.press("Escape")
    await mock.device({ voicePage: { pick: false } })
    await page.getByTestId("settings-toggle").click()
    await expect(page.getByTestId("assistant-list")).toBeVisible()
    await settle(page, 500)
    await shot(page, "voice-desktop-38-settings-sheet-no-pick")
  })

  test("the chat: the switcher open, another assistant's conversation, one assistant only", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await page.keyboard.press("c")
    await expect(page.getByTestId("conversation-switcher")).toHaveText("Conversation with Jeff")
    await settle(page, 400)
    await openSwitcher(page)
    await shot(page, "voice-desktop-39-chat-switcher")
    await page.getByTestId("conversation-switcher-menu").getByRole("menuitemradio", { name: /^T3/ }).click()
    await expect(page.getByTestId("conversation-switcher")).toHaveText("Conversation with T3")
    await page.locator("#chat-input").fill("Tell it to merge when the checks are green.")
    await settle(page, 500)
    await shot(page, "voice-desktop-40-chat-other-conversation")
    await page.keyboard.press("Escape")
    await mock.device({ assistants: [{ assistant: "jeff", phrases: [] }] })
    await expect(page.getByTestId("assistant-name")).toHaveText("Jeff")
    await page.keyboard.press("c")
    await settle(page, 600)
    await shot(page, "voice-desktop-41-single-assistant-chat")
  })
})

test.describe("voice, assistants, phone, dark", () => {
  test.use({ colorScheme: "dark", ...PHONE })

  test("phone: the menu, T3 speaking, the sheet, the switcher, one assistant", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL, true)
    await page.waitForTimeout(7500)
    await openMenu(page, true)
    await shot(page, "voice-phone-13-assistant-menu")
    await page.keyboard.press("Escape")
    await t3Speaks(page)
    await shot(page, "voice-phone-14-speaking-t3")
    await expectVisualState(page, "listening", 20_000)
    await page.getByTestId("settings-toggle").tap()
    await expect(page.getByTestId("assistant-choices")).toBeVisible()
    await settle(page, 500)
    await shot(page, "voice-phone-15-settings-sheet-assistant")
    await page.getByRole("button", { name: "Close settings" }).tap()
    await page.getByTestId("chat-toggle").tap()
    await expect(page.getByTestId("conversation-switcher")).toBeVisible()
    await settle(page, 500)
    await openSwitcher(page, true)
    await shot(page, "voice-phone-16-chat-switcher")
    await page.getByTestId("conversation-switcher-menu").getByRole("menuitemradio", { name: /^Jeff/ }).tap()
    await page.getByRole("button", { name: "Close conversation" }).tap()
    await mock.device({ assistants: [{ assistant: "jeff", phrases: [] }] })
    await expect(page.getByTestId("assistant-name")).toHaveText("Jeff")
    await settle(page, 500)
    await shot(page, "voice-phone-17-single-assistant")
  })
})

test.describe("voice, assistants, light", () => {
  test.use({ colorScheme: "light", ...DESKTOP })

  test("light theme: the menu, and the chat with the switcher", async ({ page, baseURL }) => {
    await mock.scenario("typed")
    await start(page, baseURL)
    await page.waitForTimeout(7500)
    await openMenu(page)
    await shot(page, "voice-desktop-light-05-assistant-menu")
    await page.keyboard.press("Escape")
    await page.keyboard.press("c")
    await expect(page.getByTestId("conversation-switcher")).toBeVisible()
    await openSwitcher(page)
    await shot(page, "voice-desktop-light-06-chat-switcher")
  })
})

for (const [width, height] of [[320, 568], [360, 640], [375, 667]] as const) {
  test.describe(`voice, assistants, small ${width} × ${height}`, () => {
    const SMALL: BrowserContextOptions = { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    test.use({ colorScheme: "dark", ...SMALL })

    test(`small ${width} × ${height}: the menu, T3 speaking, the chat switcher`, async ({ page, baseURL }) => {
      const name = (n: string) => `voice-small-${width}x${height}-${n}`
      await mock.scenario("typed")
      await start(page, baseURL, true)
      await settle(page, 400)
      await openMenu(page, true)
      await shot(page, name("07-assistant-menu"))
      await page.keyboard.press("Escape")
      await t3Speaks(page)
      await shot(page, name("08-speaking-t3"))
      await page.getByTestId("chat-toggle").tap()
      await expect(page.getByTestId("conversation-switcher")).toBeVisible()
      await settle(page, 500)
      await openSwitcher(page, true)
      await shot(page, name("09-chat-switcher"))
    })
  })
}

// A second device with its own assistants, next to the first: one more shot of the page opened fresh on a phone.
test.describe("voice, assistants, a device that cannot pick", () => {
  test.use({ colorScheme: "dark", ...PHONE })

  test("phone: the name without a menu, the sheet's list", async ({ browser, baseURL }) => {
    await mock.scenario("typed")
    await mock.device({ voicePage: { pick: false } })
    const phone = await otherPage(browser, PHONE)
    await start(phone.page, baseURL, true)
    await phone.page.waitForTimeout(7500)
    await expect(phone.page.getByTestId("assistant-name")).toHaveText("Jeff")
    await shot(phone.page, "voice-phone-18-name-without-menu")
    await phone.page.getByTestId("settings-toggle").tap()
    await expect(phone.page.getByTestId("assistant-list")).toBeVisible()
    await settle(phone.page, 500)
    await shot(phone.page, "voice-phone-19-settings-sheet-list")
    await phone.ctx.close()
  })
})
