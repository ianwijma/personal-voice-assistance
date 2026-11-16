import { CloseCode, decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION, type ServerMessage } from "@pva/protocol"
import type { Page } from "@playwright/test"
import WebSocket from "ws"
import { adminUrl, appUrl, expect, gotoAdmin, loginAdmin, mock, test, WS } from "./fixtures.ts"

// Keys & vault on the admin page, against the mock (scenarios "vault" and "keys-locked"). Since protocol 5 the admin
// login decides who may change things; the vault only keeps the keys, and a protected page waits for them to be
// unlocked.

const PASSWORD = "correct horse battery"

const openKeys = async (page: Page, baseURL: string | undefined) => {
  await gotoAdmin(page, baseURL, "#settings/keys/access")
  await expect(page.getByTestId("page-keys-access")).toBeVisible()
}

/** Go to a settings page through the category list (desktop: list + page). */
const go = async (page: Page, group: string, id?: string) => {
  await page.getByTestId(`nav-${group}`).click()
  if (id !== undefined) await page.getByTestId(`nav-${group}-${id}`).click()
}

/** A client that is not logged in asks the mock to change a section, as a voice page (or anyone) could try. */
const updateFromAVoiceClient = () =>
  new Promise<ServerMessage>((resolve, reject) => {
    const ws = new WebSocket(WS)
    const timer = setTimeout(() => reject(new Error("no result")), 5000)
    ws.on("open", () => ws.send(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "c-e2e-raw-client", resumeOwner: false, frontend: "voice" })))
    ws.on("message", (data: Buffer) => {
      const decoded = decodeServerMessage(data.toString("utf8"))
      if (decoded._tag !== "Ok") return
      if (decoded.message.type === "admin.snapshot") reject(new Error("a voice connection got the admin snapshot"))
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

test.beforeEach(async () => {
  await mock.scenario("vault")
})

test("set a password → lock → protected pages wait for the keys → unlock inline → change → lock", async ({ page, baseURL }) => {
  await openKeys(page, baseURL)
  const panel = page.getByTestId("keys-panel")
  await expect(panel).toHaveAttribute("data-view", "setup")
  await expect(panel).toContainText("Protect your keys")

  // A logged-in admin may change everything: no padlocks while there are no locked keys.
  await go(page, "shared", "accounts")
  await expect(page.getByTestId("page-shared-accounts")).not.toHaveAttribute("data-locked", "true")
  await expect(page.getByTestId("settings-nav").locator("[data-mark=lock]")).toHaveCount(0)
  await go(page, "keys", "access")

  // Set the password (a mismatch is caught on the page first).
  await panel.getByLabel("New password").fill(PASSWORD)
  await panel.getByLabel("Type it again").fill("correct horse batter")
  await panel.getByRole("button", { name: "Set password" }).click()
  await expect(panel.getByRole("alert")).toContainText("not the same")
  await panel.getByLabel("Type it again").fill(PASSWORD)
  await panel.getByRole("button", { name: "Set password" }).click()
  await expect(panel).toHaveAttribute("data-view", "unlocked")
  await expect(panel).toContainText("Keys are unlocked")

  // Lock: protected pages turn read-only until the keys are unlocked; the list shows padlocks and keys.
  await panel.getByRole("button", { name: "Lock now" }).click()
  await expect(panel).toHaveAttribute("data-view", "unlock")
  await expect(panel.getByTestId("locked-explanation")).toContainText("locked from a page (Lock now)")
  await expect(page.getByTestId("nav-shared").locator("[data-mark=lock]").first()).toBeVisible()
  await go(page, "shared", "modules")
  const haPage = page.getByTestId("page-shared-modules")
  await expect(haPage).toHaveAttribute("data-locked", "true")
  await expect(page.getByTestId("module-home-assistant").getByRole("switch")).toBeDisabled()
  await expect(page.getByTestId("nav-shared-modules").locator("[data-mark=lock]")).toBeVisible()
  // The page is read-only for its protected module only: the Weather module's switch still works.
  await expect(page.getByTestId("module-weather").getByRole("switch")).toBeEnabled()

  // The vault password can be typed on the protected page itself: a wrong one is refused, the right one unlocks.
  await go(page, "shared", "modules")
  const inline = page.getByTestId("unlock-form-page")
  await expect(page.getByTestId("keys-locked")).toContainText("The keys are locked")
  await inline.getByLabel("Vault password").fill("wrong horse battery")
  await inline.getByRole("button", { name: "Unlock" }).click()
  await expect(inline.getByRole("alert")).toContainText("Wrong password")
  await inline.getByLabel("Vault password").fill(PASSWORD)
  await inline.getByRole("button", { name: "Unlock" }).click()
  await expect(haPage).not.toHaveAttribute("data-locked", "true")
  await expect(page.getByTestId("module-home-assistant").getByRole("switch")).toBeEnabled()

  // Change a protected setting.
  await go(page, "shared", "accounts")
  const provider = page.getByTestId("page-shared-accounts")
  await provider.locator("[data-field=ANTHROPIC_BASE_URL]").getByRole("textbox").fill("https://proxy.example/anthropic")
  await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByTestId("page-footer").getByText("Saved")).toBeVisible()
  const results = (await mock.log()).messages.filter((m) => m.type === "settings.update")
  expect(results.at(-1)).toMatchObject({ sectionId: "language-model", patch: { values: { ANTHROPIC_BASE_URL: "https://proxy.example/anthropic" } } })

  // A connection that is not logged in is refused, whatever the vault's state.
  expect(await updateFromAVoiceClient()).toMatchObject({ type: "result", ok: false, error: { code: "admin_required" } })

  // Lock again: the page is read-only, with the inline unlock form; open pages stay editable.
  await go(page, "keys", "access")
  await panel.getByRole("button", { name: "Lock now" }).click()
  await expect(panel).toHaveAttribute("data-view", "unlock")
  await go(page, "shared", "accounts")
  await expect(provider).toHaveAttribute("data-locked", "true")
  await expect(provider.getByTestId("keys-locked")).toBeVisible()
  await expect(provider.locator("[data-field=ANTHROPIC_BASE_URL]").getByRole("textbox")).toBeDisabled()
  await go(page, "shared", "limits")
  await expect(page.locator("[data-field=MAX_VOICE_SESSIONS]").getByRole("spinbutton")).toBeEnabled()

  // The keys list: every key, its state, and what uses it.
  await go(page, "keys", "keys")
  const keys = page.getByTestId("keys-list")
  await expect(keys.locator("[data-key=DEEPGRAM_API_KEY]")).toContainText("Shared settings › Speech recognition models")
  await expect(keys.locator("[data-key=ANTHROPIC_API_KEY]")).toContainText("Set by ANTHROPIC_API_KEY in .env (not protected)")
  await keys.locator("[data-key=HOME_ASSISTANT_TOKEN]").getByRole("button", { name: "Shared settings › Modules" }).click()
  await expect(haPage).toBeVisible()
})

test("the old 'type the vault password for edit access' is gone; another tab needs its own admin login", async ({ page, baseURL, context }) => {
  await openKeys(page, baseURL)
  const panel = page.getByTestId("keys-panel")
  await panel.getByLabel("New password").fill(PASSWORD)
  await panel.getByLabel("Type it again").fill(PASSWORD)
  await panel.getByRole("button", { name: "Set password" }).click()
  await expect(panel).toHaveAttribute("data-view", "unlocked")
  await expect(page.getByText("Get edit access")).toHaveCount(0)

  const second = await context.newPage()
  await second.goto(adminUrl(baseURL, "#settings/shared/modules"))
  await expect(second.getByTestId("login-form")).toBeVisible() // the token is per tab (sessionStorage)
  await loginAdmin(second, baseURL, "#settings/shared/modules")
  await expect(second.getByTestId("page-shared-modules")).not.toHaveAttribute("data-locked", "true")
  await expect(second.getByTestId("edit-access")).toHaveCount(0)
  await second.close()
})

test("engines that failed because the keys are locked: the voice page says it is not ready and links to admin", async ({ page, baseURL }) => {
  await mock.scenario("keys-locked")
  await page.goto(appUrl(baseURL))
  const banner = page.getByTestId("engine-banner")
  await expect(banner).toContainText("could not start")
  await expect(banner.getByRole("link", { name: "See why in admin" })).toHaveAttribute("href", /\/admin\/\?ws=/)
  await expect(page.getByTestId("unlock-form-banner")).toHaveCount(0)
  // In admin, the Overview offers the unlock; unlocking reloads the engines.
  await loginAdmin(page, baseURL, "#settings/keys/access")
  const panel = page.getByTestId("keys-panel")
  await panel.getByLabel("Password").fill(PASSWORD)
  await panel.getByRole("button", { name: "Unlock" }).click()
  await expect(panel).toHaveAttribute("data-view", "unlocked")
  await page.goto(appUrl(baseURL))
  await expect(page.getByTestId("engine-banner")).toBeHidden({ timeout: 5000 })
})

test("the locked view says why: after a restart (not 'Lock now')", async ({ page, baseURL }) => {
  await mock.scenario("keys-locked")
  await loginAdmin(page, baseURL, "#settings/keys/access")
  await expect(page.getByTestId("locked-explanation")).toContainText("The assistant was restarted")
  await expect(page.getByTestId("nav-overview").locator("[data-mark=error]")).toBeVisible()
})
