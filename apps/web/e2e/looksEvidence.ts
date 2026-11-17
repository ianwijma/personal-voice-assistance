/**
 * Screenshots of looks and voices (docs/LOOKS-AND-VOICES.md §5) for the pull request, against a running dev:mock:
 *
 *   MOCK_PORT=8917 NEXT_PUBLIC_PVA_WS_URL=ws://localhost:8917/ws PORT=3917 pnpm --filter @pva/web dev:mock
 *   LOOKS_WEB=http://localhost:3917 LOOKS_MOCK=http://127.0.0.1:8917 pnpm --filter @pva/web exec tsx e2e/looksEvidence.ts
 *
 * Writes docs/looks-evidence/<page>-<theme>-<size>.png, light and dark, desktop (1280 wide) and phone (390 wide):
 * the assistant's Look tab (the window, and the whole tab), a device with its own look and voice (the whole page), the
 * device list, and the voice page showing a configured look. It changes the mock's data (an assistant's look, a
 * device's look and voice) and resets the mock at the end. `LOOKS_ONLY=<prefix>` takes only the matching pictures.
 */
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "@playwright/test"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "..", "..", "..", "docs", "looks-evidence")
const WEB = process.env.LOOKS_WEB ?? "http://localhost:3917"
const MOCK = process.env.LOOKS_MOCK ?? "http://127.0.0.1:8917"
const ONLY = process.env.LOOKS_ONLY

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${MOCK}${path}`, { method: "POST", body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
}

const login = async (page: Page, hash: string) => {
  await page.goto(`${WEB}/admin/${hash}`)
  await page.locator("[data-testid=settings], [data-testid=login-form]").first().waitFor()
  if (await page.getByTestId("login-form").isVisible()) {
    await page.locator("#admin-password").fill("admin password")
    await page.getByRole("button", { name: "Log in" }).click()
  }
  await page.getByTestId("settings").waitFor()
}

/** The admin's content scrolls inside a box: a "whole page" picture is a window as tall as that content. */
const contentHeight = (page: Page, testId: string) =>
  page.evaluate((id) => {
    let el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
    while (el !== null && getComputedStyle(el).overflowY !== "auto") el = el.parentElement
    return el === null ? document.documentElement.scrollHeight : window.innerHeight - el.clientHeight + el.scrollHeight
  }, testId)

const sizes = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, scale: 1 },
  { name: "phone", viewport: { width: 390, height: 844 }, scale: 2 }
] as const
const themes = ["dark", "light"] as const

const main = async () => {
  mkdirSync(out, { recursive: true })
  await post("/mock/scenario", { name: "devices" })
  // Jeff has a look of his own (flame, tuned); the kitchen iPad shows one look and one voice for every assistant.
  await post("/mock/assistant", { id: "jeff", patch: { look: { character: "flame", version: "1.1.1", options: { size: 0.8, sparks: false, $sensitivity: 1.3 } } } })
  await post("/mock/device", { deviceId: "d-kitchen-ipad-0001", settings: { look: { from: "device", look: { character: "robot-eyes", version: "1.1.1", options: { $voice: "#4f8fe0" } } }, voice: { from: "device", voice: { provider: "sherpa", voiceId: "nl_NL-pim-medium" } } } })
  const browser = await chromium.launch()
  try {
    for (const theme of themes) {
      for (const size of sizes) {
        const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: size.scale, colorScheme: theme, reducedMotion: "no-preference" })
        const page = await ctx.newPage()
        const want = (name: string) => ONLY === undefined || name.startsWith(ONLY)
        const shot = async (name: string) => {
          if (!want(name)) return
          await page.screenshot({ path: join(out, `${name}-${theme}-${size.name}.png`) })
          console.log(`wrote ${name}-${theme}-${size.name}.png`)
        }
        const tall = async (name: string, testId: string) => {
          if (!want(name)) return
          await page.setViewportSize({ width: size.viewport.width, height: Math.min(7000, await contentHeight(page, testId)) })
          await page.waitForTimeout(1500)
          await page.screenshot({ path: join(out, `${name}-${theme}-${size.name}.png`) })
          console.log(`wrote ${name}-${theme}-${size.name}.png`)
          await page.setViewportSize(size.viewport)
        }
        // The assistant's Look tab.
        await login(page, "#settings/assistants/jeff/look")
        await page.getByTestId("look-editor").waitFor()
        await page.waitForFunction(() => document.querySelector("[data-testid=look-preview]")?.getAttribute("data-on-stage") === "flame", undefined, { timeout: 15_000 })
        await page.waitForTimeout(2500)
        await shot("assistant-look")
        await tall("assistant-look-full", "assistant-page")
        // A device with its own look and voice.
        await page.evaluate(() => { location.hash = "#settings/devices/d-kitchen-ipad-0001" })
        await page.getByTestId("section-look").waitFor()
        await page.waitForTimeout(1000)
        await tall("device-look-voice-full", "device-editor")
        await page.getByTestId("section-look").evaluate((el) => el.scrollIntoView({ block: "start" }))
        await page.waitForTimeout(2000)
        await shot("device-look")
        // The device list.
        await page.evaluate(() => { location.hash = "#settings/devices" })
        await page.getByTestId("device-list").waitFor()
        await page.waitForTimeout(800)
        await shot("device-list")
        await ctx.close()
        // The voice page: Jeff answers, with his look (flame).
        if (!want("voice-page")) continue
        const vctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: size.scale, colorScheme: theme })
        const voice = await vctx.newPage()
        await voice.goto(`${WEB}/`)
        await voice.waitForFunction(() => (window as unknown as { __pvaStage?: { debug: () => { id: string } } }).__pvaStage?.debug().id === "flame", undefined, { timeout: 15_000 })
        await post("/mock/state", { state: "speaking" })
        await voice.waitForTimeout(2500)
        await voice.screenshot({ path: join(out, `voice-page-${theme}-${size.name}.png`) })
        console.log(`wrote voice-page-${theme}-${size.name}.png`)
        await post("/mock/state", { state: "idle" })
        await vctx.close()
      }
    }
  } finally {
    await browser.close()
    await post("/mock/reset", {})
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})
