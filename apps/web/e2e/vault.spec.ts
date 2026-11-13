import { CloseCode, decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION, type ServerMessage } from "@pva/protocol"
import type { Page } from "@playwright/test"
import WebSocket from "ws"
import { appUrl, expect, mock, test, WS } from "./fixtures.ts"

// Keys & access: the key vault and per-page admin access, against the mock (scenarios "vault" and "keys-locked").

const PASSWORD = "correct horse battery"

const openKeys = async (page: Page) => {
  await page.keyboard.press("o")
  await expect(page.getByTestId("options")).toBeVisible()
  await page.getByRole("tab", { name: "Keys & access" }).click()
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

  // Before a password exists every page may change everything (no lock badges).
  await page.getByRole("tab", { name: "Assistant" }).click()
  await expect(page.getByTestId("section-language-model")).not.toHaveAttribute("data-locked", "true")
  await page.getByRole("tab", { name: "Keys & access" }).click()

  // Set the password (a mismatch is caught on the page first).
  await panel.getByLabel("New password").fill(PASSWORD)
  await panel.getByLabel("Type it again").fill("correct horse batter")
  await panel.getByRole("button", { name: "Set password" }).click()
  await expect(panel.getByRole("alert")).toContainText("not the same")
  await panel.getByLabel("Type it again").fill(PASSWORD)
  await panel.getByRole("button", { name: "Set password" }).click()
  await expect(panel).toHaveAttribute("data-view", "admin")
  await expect(panel).toContainText("Keys are unlocked")

  // Lock: this page loses edit access, protected items turn read-only.
  await panel.getByRole("button", { name: "Lock now" }).click()
  await expect(panel).toHaveAttribute("data-view", "unlock")
  await page.getByRole("tab", { name: "Modules" }).click()
  const ha = page.getByTestId("module-home-assistant")
  await expect(ha).toHaveAttribute("data-locked", "true")
  await expect(ha.getByRole("switch")).toBeDisabled()
  await expect(page.getByTestId("module-weather")).not.toHaveAttribute("data-locked", "true")

  // "Unlock to change" leads to Keys & access; a wrong password is refused, the right one unlocks.
  await ha.getByRole("button", { name: "Unlock to change Home Assistant" }).click()
  await expect(panel).toHaveAttribute("data-view", "unlock")
  await panel.getByLabel("Password").fill("wrong horse battery")
  await panel.getByRole("button", { name: "Unlock" }).click()
  await expect(panel.getByRole("alert")).toContainText("Wrong password")
  await panel.getByLabel("Password").fill(PASSWORD)
  await panel.getByRole("button", { name: "Unlock" }).click()
  await expect(panel).toHaveAttribute("data-view", "admin")

  // Change a protected setting.
  await page.getByRole("tab", { name: "Assistant" }).click()
  const section = page.getByTestId("section-language-model")
  await expect(section).not.toHaveAttribute("data-locked", "true")
  await section.getByRole("radio", { name: "Fake (testing)" }).click()
  await section.getByRole("button", { name: "Save" }).click()
  await expect(section.getByText("Saved")).toBeVisible()
  const results = (await mock.log()).messages.filter((m) => m.type === "settings.update")
  expect(results.at(-1)).toMatchObject({ sectionId: "language-model", patch: { values: { LLM_PROVIDER: "fake" } } })

  // Admin access is per page: another client is refused by the server even now.
  const other = await protectedUpdateFromAnotherClient()
  expect(other).toMatchObject({ type: "result", ok: false, error: { code: "locked" } })

  // Lock again: the section is read-only (no Save), with the lock badge.
  await page.getByRole("tab", { name: "Keys & access" }).click()
  await panel.getByRole("button", { name: "Lock now" }).click()
  await expect(panel).toHaveAttribute("data-view", "unlock")
  await page.getByRole("tab", { name: "Assistant" }).click()
  await expect(section).toHaveAttribute("data-locked", "true")
  await expect(section.getByTestId("locked-badge")).toBeVisible()
  await expect(section.getByRole("button", { name: "Save" })).toHaveCount(0)
  await expect(section.getByRole("radio", { name: "Anthropic" })).toBeDisabled()
  // Open sections stay editable for everyone.
  await expect(page.getByTestId("section-listening").getByLabel("End of turn after")).toBeEnabled()
  const refused = await protectedUpdateFromAnotherClient()
  expect(refused).toMatchObject({ ok: false, error: { code: "locked" } })
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
  await second.getByRole("tab", { name: "Modules" }).click()
  await expect(second.getByTestId("module-home-assistant")).toHaveAttribute("data-locked", "true")
  await second.getByRole("tab", { name: "Keys & access" }).click()
  await panel2.getByLabel("Password").fill(PASSWORD)
  await panel2.getByRole("button", { name: "Get edit access" }).click()
  await expect(panel2).toHaveAttribute("data-view", "admin")
  await second.getByRole("tab", { name: "Modules" }).click()
  await expect(second.getByTestId("module-home-assistant")).not.toHaveAttribute("data-locked", "true")
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
