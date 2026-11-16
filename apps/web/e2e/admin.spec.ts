import { ADMIN_PASSWORD, adminUrl, appUrl, expect, loginAdmin, mock, test } from "./fixtures.ts"

// The admin front end's login (docs/FRONTENDS-AND-ACTIVATION.md §5): wrong password, back-off, admin switched off,
// logout and session ends with their reason, a reload staying logged in, and never touching the audio.

test.beforeEach(async () => {
  await mock.scenario("typed")
})

test("a wrong password is refused and said so; the right one opens the settings; the admin part arrives only then", async ({ page, baseURL }) => {
  await page.goto(adminUrl(baseURL))
  const form = page.getByTestId("login-form")
  await expect(form).toBeVisible()
  await expect(page.locator("#admin-password")).toBeFocused()
  await form.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByTestId("login-error")).toHaveText("Type the admin password.")
  await page.locator("#admin-password").fill("not it")
  await form.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByTestId("login-error")).toHaveText("That password is not right.")
  await expect(page.locator("#admin-password")).toHaveAttribute("aria-invalid", "true")
  await page.locator("#admin-password").fill(ADMIN_PASSWORD)
  await form.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByTestId("settings")).toBeVisible()
  await expect(page.getByTestId("page-overview-overview")).toBeVisible()
  await expect(page.getByTestId("admin-header")).toContainText("Log out")
  // Categories in the designed order.
  const order = await page.getByTestId("settings-nav").locator(":scope > div > button").allTextContents()
  expect(order.map((t) => t.replace(/\(.*\)/, "").trim())).toEqual(["Overview", "Assistants", "Devices", "Shared settings", "Keys & vault", "Diagnostics", "About"])
  const logins = (await mock.log()).messages.filter((m) => m.type === "admin.login")
  expect(logins).toHaveLength(3 - 1) // the empty one never left the page
})

test("too many wrong passwords: the button counts down from retryAfterMs", async ({ page, baseURL }) => {
  await mock.scenario("admin-backoff")
  await page.goto(adminUrl(baseURL))
  await page.locator("#admin-password").fill("wrong")
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByTestId("login-wait")).toContainText(/Try again in (29|30) s/)
  const button = page.getByTestId("login-form").getByRole("button", { name: /Wait \d+ s/ })
  await expect(button).toBeDisabled()
  const first = Number((await button.textContent())!.match(/\d+/)![0])
  await page.waitForTimeout(2100)
  const later = Number((await button.textContent())!.match(/\d+/)![0])
  expect(first - later).toBeGreaterThanOrEqual(2)
  // Screen readers hear the full wait once; the ticking number is not in a live region.
  await expect(page.getByTestId("login-announcer")).toHaveText(/try again in (29|30) seconds/)
  await expect(page.getByTestId("login-wait")).not.toHaveAttribute("role")
  await expect(page.getByTestId("login-wait")).not.toHaveAttribute("aria-live")
})

test("admin switched off: the page says how to switch it on, and offers no password field", async ({ page, baseURL }) => {
  await mock.scenario("admin-disabled")
  await page.goto(adminUrl(baseURL))
  const disabled = page.getByTestId("admin-disabled")
  await expect(disabled).toContainText("Admin is switched off")
  await expect(disabled).toContainText("PVA_ADMIN_PASSWORD")
  await expect(disabled).toContainText(".env")
  await expect(page.locator("#admin-password")).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Back to the voice assistant" })).toHaveAttribute("href", /^\/\?ws=/)
})

test("log out returns to the login with the reason; a reload stays logged in; an ended session says why", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/shared/providers")
  await page.reload()
  await expect(page.getByTestId("settings")).toBeVisible() // the token in sessionStorage logs in again
  await expect(page.getByTestId("page-shared-providers")).toBeVisible()
  await page.getByTestId("logout").click()
  await expect(page.getByTestId("login-reason")).toHaveText("You logged out.")
  expect(await page.evaluate(() => sessionStorage.getItem("pva.adminToken"))).toBeNull()
  await page.reload()
  await expect(page.getByTestId("login-form")).toBeVisible()

  await loginAdmin(page, baseURL)
  await mock.endAdmin("idle")
  await expect(page.getByTestId("login-reason")).toContainText("30 minutes without changes")
  await loginAdmin(page, baseURL)
  await mock.endAdmin("expired")
  await expect(page.getByTestId("login-reason")).toContainText("12 hours")
})

test("a token the server no longer knows (it restarted) lands on the login with that reason", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL)
  await mock.scenario("typed") // a reset: sessions end, sockets drop
  await expect(page.getByTestId("login-reason")).toContainText("restarted", { timeout: 10_000 })
})

test("the admin page never asks for the microphone and never claims the audio", async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { __gum: number }).__gum = 0
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = (c) => {
      ;(window as unknown as { __gum: number }).__gum++
      return original(c)
    }
  })
  await loginAdmin(page, baseURL, "#settings/devices/type-web-voice")
  await page.getByTestId("tester-listen").click()
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => (window as unknown as { __gum: number }).__gum)).toBe(0)
  const log = await mock.log()
  expect(log.messages.filter((m) => m.type.startsWith("audio.") || m.type === "mic.state")).toEqual([])
})

test("the header links to the voice front end and shows what the assistant is doing", async ({ page, baseURL, context }) => {
  await loginAdmin(page, baseURL)
  await expect(page.getByTestId("assistant-line")).toContainText("no device is listening")
  const voice = await context.newPage()
  await voice.goto(appUrl(baseURL))
  await voice.getByTestId("start").click()
  await expect(page.getByTestId("assistant-line")).toContainText(/listening on /)
  await expect(page.getByTestId("voice-link")).toHaveAttribute("href", /^\/\?ws=/)
  await voice.close()
})
