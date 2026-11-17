/**
 * Screenshots of voice nodes in admin (docs/VOICE-NODES.md §7, §14 N4) for the pull request, against the mock and the
 * static export (or dev:mock):
 *
 *   pnpm --filter @pva/web build
 *   MOCK_PORT=8797 pnpm --filter @pva/web exec tsx mock/server.ts &
 *   pnpm --filter @pva/web exec node scripts/serve-static.mjs out 3297 &
 *   NODES_WEB=http://127.0.0.1:3297 NODES_MOCK=http://127.0.0.1:8797 pnpm --filter @pva/web exec tsx e2e/nodesEvidence.ts
 *
 * Writes docs/nodes-evidence/<name>-<theme>-<size>.png, light and dark, desktop (1280 wide) and phone (320 wide). It
 * switches the mock to the `nodes` scenario (and changes its pairing settings) and resets it at the end.
 * `NODES_ONLY=<prefix>` takes only the matching pictures.
 */
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "@playwright/test"
import { exampleNodePairing } from "@pva/protocol/examples"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "..", "..", "..", "docs", "nodes-evidence")
const WEB = process.env.NODES_WEB ?? "http://127.0.0.1:3297"
const MOCK = process.env.NODES_MOCK ?? "http://127.0.0.1:8797"
const WS = `${MOCK.replace(/^http/, "ws")}/ws`
const ONLY = process.env.NODES_ONLY

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${MOCK}${path}`, { method: "POST", body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
}

const go = async (page: Page, hash: string) => {
  await page.goto(`${WEB}/admin/?ws=${encodeURIComponent(WS)}${hash}`)
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
  { name: "phone", viewport: { width: 320, height: 640 }, scale: 2 }
] as const
const themes = ["dark", "light"] as const

const LIVING = "vn-living-room-nuc2"
const KITCHEN = "vn-kitchen-speaker01"

const main = async () => {
  mkdirSync(out, { recursive: true })
  const browser = await chromium.launch()
  try {
    for (const theme of themes) {
      for (const size of sizes) {
        await post("/mock/scenario", { name: "nodes" })
        const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: size.scale, colorScheme: theme, reducedMotion: "reduce" })
        const page = await ctx.newPage()
        const want = (name: string) => ONLY === undefined || name.startsWith(ONLY)
        const file = (name: string) => join(out, `${name}-${theme}-${size.name}.png`)
        const shot = async (name: string) => {
          if (!want(name)) return
          await page.waitForTimeout(300)
          await page.screenshot({ path: file(name) })
          console.log(`wrote ${name}-${theme}-${size.name}.png`)
        }
        const tall = async (name: string, testId: string) => {
          if (!want(name)) return
          await page.setViewportSize({ width: size.viewport.width, height: Math.min(7000, await contentHeight(page, testId)) })
          await page.waitForTimeout(500)
          await page.screenshot({ path: file(name) })
          console.log(`wrote ${name}-${theme}-${size.name}.png`)
          await page.setViewportSize(size.viewport)
        }
        const top = async (testId: string) => {
          await page.getByTestId(testId).first().evaluate((el) => el.scrollIntoView({ block: "start" }))
          await page.waitForTimeout(200)
        }

        // The list: Browsers, then Voice nodes with Every voice node and the three nodes.
        await go(page, "#settings/devices")
        await page.getByTestId("device-type-voice-node").waitFor()
        await tall("devices-with-nodes", "device-list")

        // A node's page: Status and Actions (the living room: Update pending, Unencrypted, a last error).
        await go(page, `#settings/devices/${LIVING}`)
        await page.getByTestId("node-status").waitFor()
        await shot("node-page-status")
        if (want("node-page-full")) await tall("node-page-full", "device-editor")
        // Sound and Sound devices (its microphone is not connected now).
        await go(page, `#settings/devices/${LIVING}`)
        await page.getByTestId("section-sound").waitFor()
        await top("section-sound")
        await shot("node-page-sound")

        // The kitchen speaker's Assistants: follow-up "Off: one answer per phrase (voice nodes)".
        await go(page, `#settings/devices/${KITCHEN}`)
        await page.getByTestId("section-assign").waitFor()
        await top("section-assign")
        await shot("node-page-assistants")

        // Answers without a phrase on a node: the note, and Save asks first.
        await page.locator("#without-phrase").selectOption("jeff")
        await page.getByTestId("answers-everything-note").waitFor()
        await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
        await page.getByTestId("warnings-dialog").waitFor()
        await shot("node-answers-everything")
        await page.getByTestId("warnings-dialog").getByRole("button", { name: "Go back" }).click()
        await page.getByTestId("page-footer").getByRole("button", { name: "Cancel" }).click()

        // Remove, with its confirmation.
        await top("forget")
        await page.getByTestId("forget").click()
        await page.getByTestId("forget-dialog").waitFor()
        await shot("node-remove")
        await page.getByRole("button", { name: "Keep it" }).click()

        // Every voice node: the defaults page, without the browser sections.
        await go(page, "#settings/devices/type.voice-node")
        await page.getByTestId("section-sound").waitFor()
        await tall("every-voice-node", "device-editor")

        // Add voice node: the address (here the mock's own, a loopback address), the code with a pinned https command,
        // the server without the node program, and paired.
        await go(page, "#settings/devices")
        await page.getByTestId("add-node-button").first().click()
        await page.getByTestId("add-node-address").waitFor()
        await page.locator("#node-name").fill("Study")
        await shot("add-node-address")
        await post("/mock/nodes", { tls: true, tlsPin: exampleNodePairing.tlsPin, redeemAfterMs: 0 })
        await page.locator("#node-server").fill("https://assistant.home:8443")
        await page.getByTestId("get-code").click()
        await page.getByTestId("install-command").waitFor()
        await page.waitForTimeout(2200)
        await shot("add-node-code")
        await post("/mock/node/redeem", {})
        await page.getByTestId("add-node-paired").waitFor()
        await shot("add-node-paired")
        await page.getByTestId("add-another").click()
        await post("/mock/nodes", { built: false })
        await page.getByTestId("get-code").click()
        await page.getByTestId("pair-not-built").waitFor()
        await shot("add-node-not-built")
        await page.getByTestId("cancel-pairing").click()
        await ctx.close()
      }
    }
  } finally {
    await browser.close()
    await post("/mock/scenario", { name: "voice" }).catch(() => undefined)
  }
}

await main()
