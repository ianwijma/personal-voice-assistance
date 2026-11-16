// The admin front end against the real assistant (docs/FRONTENDS-AND-ACTIVATION.md §1, §5): the `/admin` redirect,
// login with a wrong password and the server's back-off, a reload staying logged in, logout, a session the server no
// longer knows after a restart, and `admin_required` never surfacing as a broken screen.
import { join } from "node:path"
import { PROTOCOL_VERSION } from "@pva/protocol"
import {
  alerts,
  type Assistant,
  E2E_ADMIN_PASSWORD,
  expect,
  here,
  instrument,
  loginAdmin,
  messages,
  missingPrerequisite,
  saveLog,
  startAssistant,
  test
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

const port = 8789
const dataDir = join(here, "../test-results/real/data-admin")
let assistant: Assistant
test.beforeAll(async () => {
  assistant = await startAssistant({ port, dataDir })
})
test.afterAll(async () => {
  await assistant?.stop()
})

const restart = async () => {
  await assistant.stop()
  assistant = await startAssistant({ port, dataDir, fresh: false })
}

/** One `admin.login` on a fresh admin connection; resolves with its `result`. */
const rawLogin = (url: string, password: string) =>
  new Promise<{ ok: boolean; error?: { code: string; message: string } }>((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`)
    const timer = setTimeout(() => reject(new Error("no answer")), 5000)
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, clientId: `raw-${Date.now()}`, resumeOwner: false, frontend: "admin" }))
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; requestId?: string; ok: boolean; error?: { code: string; message: string } }
      if (m.type === "welcome") ws.send(JSON.stringify({ type: "admin.login", requestId: "raw", password }))
      if (m.type === "result" && m.requestId === "raw") {
        clearTimeout(timer)
        ws.close()
        resolve(m)
      }
    }
  })

/** `result` messages the page received that were refused with `code`. */
const refused = async (page: Parameters<typeof messages>[0], code: string) =>
  (await messages(page)).filter((m) => m.dir === "in" && m.msg.type === "result" && (m.msg as { error?: { code?: string } }).error?.code === code)

test("/admin answers 308 to /admin/ with the page's headers; a browser lands on the login", async ({ page }) => {
  const r = await fetch(`${assistant.url}/admin?x=1`, { redirect: "manual" })
  expect(r.status).toBe(308)
  expect(r.headers.get("location")).toBe("/admin/?x=1")
  expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin")
  await page.goto(`${assistant.url}/admin`)
  expect(new URL(page.url()).pathname).toBe("/admin/")
  await expect(page.getByTestId("login-form")).toBeVisible()
})

test("a wrong password is refused; five in a row back off 30 s, counted down; then the right one logs in", async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto(`${assistant.url}/admin/`)
  const form = page.getByTestId("login-form")
  const password = page.locator("#admin-password")
  for (let i = 1; i <= 5; i++) {
    await password.fill(`wrong ${i}`)
    await form.getByRole("button", { name: "Log in" }).click()
    if (i < 5) await expect(page.getByTestId("login-error")).toHaveText("That password is not right.")
    else await expect(page.getByTestId("login-wait")).toContainText(/Try again in (29|30) s/)
    await expect(form.getByRole("button", { name: /Log in|Wait/ })).toBeEnabled({ timeout: i < 5 ? 5000 : 1 }).catch(() => undefined)
  }
  const wait = form.getByRole("button", { name: /Wait \d+ s/ })
  await expect(wait).toBeDisabled()
  const states = (await messages(page)).filter((m) => m.msg.type === "admin.state").map((m) => (m.msg as unknown as { admin: { retryAfterMs?: number } }).admin)
  expect(states.at(-1)?.retryAfterMs).toBeGreaterThan(25_000)
  // The server refuses even the right password while it backs off (from another connection: the back-off is the server's).
  const early = await rawLogin(assistant.url, E2E_ADMIN_PASSWORD)
  expect(early).toMatchObject({ ok: false, error: { code: "bad_password" } })
  expect(early.error?.message).toMatch(/try again in \d+ s/i)
  // After the wait the right password works.
  await expect(form.getByRole("button", { name: "Log in" })).toBeEnabled({ timeout: 35_000 })
  await password.fill(E2E_ADMIN_PASSWORD)
  await form.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByTestId("settings")).toBeVisible()
  await expect(page.getByTestId("page-overview-overview")).toBeVisible()
  expect(await alerts(page)).toEqual([])
})

test("a reload stays logged in; Log out ends it, also for a second tab of the same session", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const a = await ctx.newPage()
  const b = await ctx.newPage()
  await instrument(a, " A")
  await instrument(b, " B")
  try {
    await loginAdmin(a, assistant.url, "#settings/overview")
    await a.reload()
    await expect(a.getByTestId("settings")).toBeVisible()
    await expect(a.getByTestId("login-form")).toHaveCount(0)
    // B: the same session (the token copied, as a duplicated tab copies sessionStorage).
    const token = await a.evaluate(() => sessionStorage.getItem("pva.adminToken"))
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await b.addInitScript({ content: `sessionStorage.setItem("pva.adminToken", ${JSON.stringify(token)})` })
    await b.goto(`${assistant.url}/admin/#settings/devices/type-web-voice`)
    await expect(b.getByTestId("settings")).toBeVisible()
    // B listens with the phrase tester; A logs out: both land on the login, B with "ended elsewhere", no error shown.
    await b.getByTestId("tester-listen").click()
    await expect(b.getByTestId("phrase-tester")).toHaveAttribute("data-on", "true")
    await a.getByTestId("logout").click()
    await expect(a.getByTestId("login-reason")).toHaveText("You logged out.")
    await expect(b.getByTestId("login-form")).toBeVisible()
    await expect(b.getByTestId("login-reason")).toBeVisible()
    expect(await a.evaluate(() => sessionStorage.getItem("pva.adminToken"))).toBeNull()
    expect(await b.evaluate(() => sessionStorage.getItem("pva.adminToken"))).toBeNull()
    await a.waitForTimeout(500)
    expect(await alerts(a)).toEqual([])
    expect(await alerts(b)).toEqual([])
    await a.reload()
    await expect(a.getByTestId("login-form")).toBeVisible()
  } finally {
    await saveLog(a, testInfo.outputPath("socket-log-a.json"))
    await saveLog(b, testInfo.outputPath("socket-log-b.json"))
    await ctx.close()
  }
})

test("after a restart the server no longer knows the session: the login says so; logging in again works", async ({ page }) => {
  await loginAdmin(page, assistant.url, "#settings/devices/type-web-voice")
  // An unsaved edit and a running tester when the server goes away.
  await page.getByTestId("group-audio").locator("summary").click()
  await page.getByRole("switch", { name: "Echo cancellation" }).click()
  await page.getByTestId("tester-listen").click()
  await restart()
  await expect(page.getByTestId("login-reason")).toContainText("restarted", { timeout: 20_000 })
  expect(await alerts(page)).toEqual([])
  expect(await refused(page, "admin_required")).toEqual([])
  await page.locator("#admin-password").fill(E2E_ADMIN_PASSWORD)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByTestId("settings")).toBeVisible()
  await expect(page.getByTestId("page-devices-device-type")).toBeVisible()
  expect(await alerts(page)).toEqual([])
})

test("admin_required: a logged-out admin page and a voice page asking for admin things get a refusal, never a broken screen", async ({ page, context }) => {
  // The admin page before login: its socket asks for an admin change (as a stale form would).
  await page.goto(`${assistant.url}/admin/`)
  await expect(page.getByTestId("login-form")).toBeVisible()
  const voice = await context.newPage()
  await instrument(voice, " voice")
  await voice.goto(assistant.url)
  await expect(voice.getByTestId("start")).toBeVisible()
  for (const p of [page, voice]) {
    await p.evaluate(() => {
      // The recorder wraps WebSocket; the page's one socket is the last one made. Find it through a fresh send hook.
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function(this: WebSocket, data) {
        WebSocket.prototype.send = send
        send.call(this, data)
        send.call(this, JSON.stringify({ type: "wake.test", requestId: "stale-1", on: false }))
      }
    })
  }
  // Something that makes each page send: the admin page a wrong login, the voice page a typed message.
  await page.locator("#admin-password").fill("not the password")
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByTestId("login-error")).toBeVisible()
  await voice.getByTestId("chat-toggle").click()
  await voice.locator("#chat-input").fill("Hello there.")
  await voice.locator("#chat-input").press("Enter")
  await expect(voice.getByTestId("turn").last()).toContainText("Hello there.")
  for (const p of [page, voice]) {
    await expect.poll(async () => (await refused(p, "admin_required")).length).toBe(1)
    expect(await alerts(p)).not.toContainEqual(expect.stringMatching(/admin|unexpected|wrong/i))
  }
  await expect(voice.getByTestId("stage")).toBeVisible()
  await expect(page.getByTestId("login-form")).toBeVisible()
  await voice.close()
})
