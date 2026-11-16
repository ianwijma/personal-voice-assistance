// Screenshots of the REAL system (real assistant, local speech, fake model), saved as
// screenshots/real-voice-*.png and real-admin-*.png next to the mock ones. Run with `pnpm --filter @pva/web screenshots:real`.
import { join } from "node:path"
import type { Browser, Page } from "@playwright/test"
import {
  type Assistant,
  chromiumArgsFor,
  E2E_ADMIN_PASSWORD,
  expectVisualState,
  here,
  instrument,
  micWav,
  missingPrerequisite,
  question,
  silence,
  startAssistant,
  test,
  waitForMessage
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

const wav = missing === undefined ? micWav("screenshots", [silence(1500), question(2), silence(7000), question(4), silence(30_000)]) : ""
test.use({ launchOptions: { args: chromiumArgsFor(wav) } })

const shots = join(here, "../screenshots")
let assistant: Assistant
test.beforeEach(async () => {
  assistant = await startAssistant({ port: 8798, dataDir: join(here, "../test-results/real/data-shots") })
})
test.afterEach(async () => {
  await assistant?.stop()
})

const run = async (browser: Browser, size: "desktop" | "phone") => {
  const ctx = await browser.newContext(
    size === "desktop"
      ? { permissions: ["microphone"], viewport: { width: 1280, height: 800 }, colorScheme: "dark" }
      : { permissions: ["microphone"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" }
  )
  const page: Page = await ctx.newPage()
  await instrument(page)
  const shot = (front: "voice" | "admin", name: string) => page.screenshot({ path: join(shots, `real-${front}-${size}-${name}.png`) })
  try {
    await page.goto(assistant.url)
    await page.getByTestId("start").click()
    await expectVisualState(page, "listening")

    // A spoken turn in progress: "What time is it in Tokyo right now?", answered through the clock tool.
    await waitForMessage(page, (m) => m.msg.type === "playback.started" && m.msg.turnId === 1, { timeout: 30_000 })
    await page.waitForTimeout(900)
    await shot("voice", "01-speaking")

    // The chat after a real exchange: two spoken turns and a typed one.
    await waitForMessage(page, (m) => m.msg.type === "turn.end" && m.msg.turnId === 2, { timeout: 30_000 })
    await page.getByTestId("chat-toggle").click()
    await page.locator("#chat-input").fill("Give me one fun fact about octopuses.")
    await page.locator("#chat-input").press("Enter")
    await waitForMessage(page, (m) => m.msg.type === "turn.end" && m.msg.turnId === 3, { timeout: 30_000 })
    await page.waitForTimeout(400)
    await shot("voice", "02-chat")
    await page.getByTestId("chat-panel").getByRole("button", { name: /close/i }).click()
    await page.getByTestId("settings-toggle").click()
    await page.getByTestId("voice-sheet").waitFor()
    await page.waitForTimeout(400)
    await shot("voice", "03-settings-sheet")

    // Admin, logged in with the test password: the shared Modules page (a capability module runs for the assistants that
    // have it on), the Overview, the assistant's Voice tab, and the browsers' device defaults.
    await page.goto(`${assistant.url}/admin/`)
    await page.locator("#admin-password").fill(E2E_ADMIN_PASSWORD)
    await page.getByRole("button", { name: "Log in" }).click()
    await page.getByTestId("settings").waitFor()
    const open = async (hash: string) => {
      await page.evaluate((h) => { location.hash = h }, hash)
      await page.waitForTimeout(300)
    }
    await open("#settings/shared/modules")
    await page.getByTestId("module-clock").waitFor()
    await shot("admin", "01-module")
    await open("#settings/overview")
    await shot("admin", "02-overview")
    await open("#settings/assistants/assistant/voice")
    await page.getByTestId("assistant-page").waitFor()
    await shot("admin", "03-voices")
    await open("#settings/devices/type-web-voice")
    await shot("admin", "04-front-end")
  } finally {
    await ctx.close()
  }
}

test("real system, desktop", async ({ browser }) => {
  await run(browser, "desktop")
})

test("real system, phone", async ({ browser }) => {
  await run(browser, "phone")
})
