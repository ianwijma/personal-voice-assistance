import { CloseCode, decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION, type ServerMessage } from "@pva/protocol"
import type { Page } from "@playwright/test"
import WebSocket from "ws"
import { appUrl, expect, mock, test, WS } from "./fixtures.ts"

// Keys & access: the key vault and per-page admin access, against the mock (scenarios "vault" and "keys-locked").

const PASSWORD = "correct horse battery"

const openKeys = async (page: Page) => {
  await page.keyboard.press("o")
  await expect(page.getByTestId("settings")).toBeVisible()
  await page.getByTestId("nav-keys").click()
  await expect(page.getByTestId("page-keys-access")).toBeVisible()
}

/** Go to a settings page through the category list (desktop: list + page). */
const go = async (page: Page, group: string, id?: string) => {
  await page.getByTestId(`nav-${group}`).click()
  if (id !== undefined) await page.getByTestId(`nav-${group}-${id}`).click()
}

/** A page-less client that asks the mock to change a protected section, as a page without admin access would. */
const protectedUpdateFromAnotherClient = () =>
  new Promise<ServerMessage>((resolve, reject) => {
    const ws = new WebSocket(WS)
    const timer = setTimeout(() => reject(new Error("no result")), 5000)
    ws.on("open", () => ws.send(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "c-e2e-raw-client", resumeOwner: false })))
    ws.on("message", (data: Buffer) => {
      const decoded = decodeServerMessage(data.toString("utf8"))
      if (decoded._tag !== "Ok") return
      if (decoded.message.type === "welcome") {
        ws.send(encodeClientMessage({
          type: "settings.update",
          requestId: "raw-1",
          sectionId: "language-model",
          patch: { values: { LLM_PROVIDER: "fake" }, secrets: {} }
        }))
      }
      if (decoded.message.type === "result") {
        clearTimeout(timer)
        ws.close(CloseCode.serverShutdown)
        resolve(decoded.message)
      }
    })
  })

test.beforeEach(async ({ page, baseURL }) => {
  await mock.scenario("vault")
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("stage")).toHaveAttribute("data-visual-state", "not-started")
})

test("set a password → lock → unlock → change a protected setting → lock → changes refused", async ({ page }) => {
  await openKeys(page)
  const panel = page.getByTestId("keys-panel")
  await expect(panel).toHaveAttribute("data-view", "setup")
  await expect(panel).toContainText("Protect your keys")

  // Before a password exists every page may change everything (no padlocks).
  await go(page, "language-model", "provider")
  await expect(page.getByTestId("page-language-model-provider")).not.toHaveAttribute("data-locked", "true")
  await expect(page.getByTestId("settings-nav").locator("[data-mark=lock]")).toHaveCount(0)
  await go(page, "keys", "access")

  // Set the password (a mismatch is caught on the page first).
  await panel.getByLabel("New password").fill(PASSWORD)
  await panel.getByLabel("Type it again").fill("correct horse batter")
  await panel.getByRole("button", { name: "Set password" }).click()
  await expect(panel.getByRole("alert")).toContainText("not the same")
  await panel.getByLabel("Type it again").fill(PASSWORD)
  await panel.getByRole("button", { name: "Set password" }).click()
  await expect(panel).toHaveAttribute("data-view", "admin")
  await expect(panel).toContainText("Keys are unlocked")

  // Lock: this page loses edit access, protected pages turn read-only, the list shows padlocks and keys.
  await panel.getByRole("button", { name: "Lock now" }).click()
  await expect(panel).toHaveAttribute("data-view", "unlock")
  await expect(panel.getByTestId("locked-explanation")).toContainText("locked from a page (Lock now)")
  await expect(panel.getByTestId("locked-explanation")).not.toContainText("restarted")
  await expect(page.getByTestId("nav-language-model").locator("[data-mark=lock]")).toBeVisible()
  await go(page, "modules", "home-assistant")
  const haPage = page.getByTestId("page-modules-home-assistant")
  await expect(haPage).toHaveAttribute("data-locked", "true")
  await expect(page.getByTestId("module-home-assistant").getByRole("switch")).toBeDisabled()
  await expect(page.getByTestId("nav-modules-home-assistant").locator("[data-mark=key]")).toBeVisible()
  await expect(page.getByTestId("page-footer")).toHaveCount(0)
  await go(page, "modules", "weather")
  await expect(page.getByTestId("page-modules-weather")).not.toHaveAttribute("data-locked", "true")

  // The password can be typed on the protected page itself: a wrong one is refused, the right one unlocks.
  await go(page, "modules", "home-assistant")
  const inline = page.getByTestId("unlock-form-page")
  await inline.getByLabel("Vault password").fill("wrong horse battery")
  await inline.getByRole("button", { name: "Unlock" }).click()
  await expect(inline.getByRole("alert")).toContainText("Wrong password")
  await inline.getByLabel("Vault password").fill(PASSWORD)
  await inline.getByRole("button", { name: "Unlock" }).click()
  await expect(haPage).not.toHaveAttribute("data-locked", "true")
  await expect(page.getByTestId("module-home-assistant").getByRole("switch")).toBeEnabled()

  // Change a protected setting.
  await go(page, "language-model", "provider")
  const provider = page.getByTestId("page-language-model-provider")
  await expect(provider).not.toHaveAttribute("data-locked", "true")
  await provider.getByRole("radio", { name: /Offline stand-in/ }).click()
  await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByTestId("page-footer").getByText("Saved")).toBeVisible()
  const results = (await mock.log()).messages.filter((m) => m.type === "settings.update")
  expect(results.at(-1)).toMatchObject({ sectionId: "language-model", patch: { values: { LLM_PROVIDER: "fake" } } })

  // Admin access is per page: another client is refused by the server even now.
  const other = await protectedUpdateFromAnotherClient()
  expect(other).toMatchObject({ type: "result", ok: false, error: { code: "locked" } })

  // Lock again: the page is read-only (no Save), with the inline password form.
  await go(page, "keys", "access")
  await panel.getByRole("button", { name: "Lock now" }).click()
  await expect(panel).toHaveAttribute("data-view", "unlock")
  await go(page, "language-model", "provider")
  await expect(provider).toHaveAttribute("data-locked", "true")
  await expect(provider.getByTestId("edit-access")).toBeVisible()
  await expect(page.getByTestId("page-footer")).toHaveCount(0)
  await expect(provider.getByRole("radio", { name: /Claude API/ })).toBeDisabled()
  // Open pages stay editable for everyone.
  await go(page, "speech", "turn-timing")
  await expect(page.getByTestId("form-s-stt-timing").getByLabel("End of turn after")).toBeEnabled()
  const refused = await protectedUpdateFromAnotherClient()
  expect(refused).toMatchObject({ ok: false, error: { code: "locked" } })

  // The keys list: every key, its state, and what uses it.
  await go(page, "keys", "keys")
  const keys = page.getByTestId("keys-list")
  await expect(keys.locator("[data-key=DEEPGRAM_API_KEY]")).toContainText("Speech recognition › Deepgram")
  await expect(keys.locator("[data-key=ANTHROPIC_API_KEY]")).toContainText("Set by ANTHROPIC_API_KEY in .env (not protected)")
  await keys.locator("[data-key=HOME_ASSISTANT_TOKEN]").getByRole("button", { name: "Modules › Home Assistant" }).click()
  await expect(haPage).toBeVisible()
})

test("a second page is not an admin until it types the password", async ({ page, baseURL, context }) => {
  await openKeys(page)
  const panel = page.getByTestId("keys-panel")
  await panel.getByLabel("New password").fill(PASSWORD)
  await panel.getByLabel("Type it again").fill(PASSWORD)
  await panel.getByRole("button", { name: "Set password" }).click()
  await expect(panel).toHaveAttribute("data-view", "admin")

  const second = await context.newPage()
  await second.goto(appUrl(baseURL))
  await openKeys(second)
  const panel2 = second.getByTestId("keys-panel")
  await expect(panel2).toHaveAttribute("data-view", "elevate")
  await go(second, "modules", "home-assistant")
  await expect(second.getByTestId("page-modules-home-assistant")).toHaveAttribute("data-locked", "true")
  await expect(second.getByTestId("edit-access")).toContainText("only a page where the password was typed")
  await go(second, "keys", "access")
  await panel2.getByLabel("Password").fill(PASSWORD)
  await panel2.getByRole("button", { name: "Get edit access" }).click()
  await expect(panel2).toHaveAttribute("data-view", "admin")
  await go(second, "modules", "home-assistant")
  await expect(second.getByTestId("page-modules-home-assistant")).not.toHaveAttribute("data-locked", "true")
  await second.close()
})

test("engines that failed because the keys are locked: the banner unlocks them inline", async ({ page, baseURL }) => {
  await mock.scenario("keys-locked")
  await page.goto(appUrl(baseURL))
  const banner = page.getByTestId("engine-banner")
  await expect(banner).toContainText("Keys are locked")
  const form = banner.getByTestId("unlock-form-banner")
  await form.getByLabel("Vault password").fill("nope nope nope")
  await form.getByRole("button", { name: "Unlock" }).click()
  await expect(form.getByRole("alert")).toContainText("Wrong password")
  await form.getByLabel("Vault password").fill(PASSWORD)
  await form.getByRole("button", { name: "Unlock" }).click()
  await expect(banner).toBeHidden({ timeout: 5000 })
})

test("the locked view says why: after a restart (not 'Lock now')", async ({ page, baseURL }) => {
  await mock.scenario("keys-locked")
  await page.goto(appUrl(baseURL, "#settings/keys/access"))
  await expect(page.getByTestId("locked-explanation")).toContainText("The assistant was restarted")
  await expect(page.getByTestId("nav-overview").locator("[data-mark=error]")).toBeVisible()
})
