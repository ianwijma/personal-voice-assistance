import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, type Page, test as base } from "@playwright/test"

export { fakeMicPath, writeFakeMic } from "./fakeMic.ts"
export const here = dirname(fileURLToPath(import.meta.url))
/** The mock's port: 8787, or `E2E_MOCK_PORT` when something else (a running assistant) already has 8787. */
export const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 8787)
export const MOCK = `http://127.0.0.1:${MOCK_PORT}`
export const WS = `ws://127.0.0.1:${MOCK_PORT}/ws`

export type Scenario =
  | "voice"
  | "typed"
  | "modules"
  | "engine-failed"
  | "drop-mid-reply"
  | "takeover"
  | "outdated"
  | "vault"
  | "keys-locked"
  | "wake"
  | "devices"
  | "long-phrase"
  | "latency"
  | "admin-disabled"
  | "admin-backoff"

/** The mock's admin password (`ADMIN_PASSWORD` in mock/server.ts). */
export const ADMIN_PASSWORD = "admin password"

export interface MockLog {
  readonly scenario: string
  readonly messages: ReadonlyArray<Record<string, unknown> & { type: string; at: number; conn: string }>
  readonly mic: ReadonlyArray<{ conn: string; frames: number; gaps: number; owner: boolean }>
  readonly state: string
  readonly connections: number
  readonly sessions: ReadonlyArray<{ key: string; deviceId?: string; name: string; state: string; ownerPresent: boolean; turns: number }>
}

export const mock = {
  scenario: async (name: Scenario) => {
    const r = await fetch(`${MOCK}/mock/scenario`, { method: "POST", body: JSON.stringify({ name }) })
    expect(r.ok).toBe(true)
  },
  log: async (): Promise<MockLog> => (await (await fetch(`${MOCK}/mock/log`)).json()) as MockLog,
  /** The scripted voice turn. Protocol 7: `assistantId` answers (default: who has the turn, else who answers without a phrase); `phrase`: it was woken by that phrase. */
  turn: async (opts: { assistantId?: string; phrase?: string } = {}) => {
    await fetch(`${MOCK}/mock/turn`, { method: "POST", body: JSON.stringify(opts) })
  },
  /** Protocol 7: "Whichever fits" is set up (the voice menu offers it). */
  typesafe: async (on = true) => {
    await fetch(`${MOCK}/mock/typesafe`, { method: "POST", body: JSON.stringify({ on }) })
  },
  /**
   * Protocol 7: the web-voice devices sleep until a phrase and Jeff is the only assistant, woken by `phrase` (what
   * `mock.defaults({ activation: "wake-phrase" })` did for the voice page before protocol 7).
   */
  sleeps: async (phrase = "hey jeff") => {
    const settings = { assistants: [{ assistant: "jeff", phrases: [phrase] }], withoutPhrase: { mode: "nobody" } }
    const r = await fetch(`${MOCK}/mock/device`, { method: "POST", body: JSON.stringify({ settings }) })
    expect(r.ok).toBe(true)
  },
  /** Protocol 7: a device's settings (without `deviceId`: the web-voice type's), saved as admin would; the setups follow. */
  device: async (settings: Record<string, unknown>, deviceId?: string) => {
    const r = await fetch(`${MOCK}/mock/device`, { method: "POST", body: JSON.stringify({ settings, ...(deviceId === undefined ? {} : { deviceId }) }) })
    expect(r.ok).toBe(true)
  },
  offline: async (ms: number) => {
    await fetch(`${MOCK}/mock/offline`, { method: "POST", body: JSON.stringify({ ms }) })
  },
  drop: async () => {
    await fetch(`${MOCK}/mock/drop`, { method: "POST" })
  },
  send: async (messages: ReadonlyArray<unknown>) => {
    await fetch(`${MOCK}/mock/send`, { method: "POST", body: JSON.stringify({ messages }) })
  },
  /** End every admin session (`idle` or `expired`). */
  endAdmin: async (reason: "idle" | "expired") => {
    await fetch(`${MOCK}/mock/admin/end`, { method: "POST", body: JSON.stringify({ reason }) })
  },
  /** The owner said the wake phrase (`armed`: the phrase alone). */
  wake: async (phrase = "hey jeff", armed = true) => {
    await fetch(`${MOCK}/mock/wake`, { method: "POST", body: JSON.stringify({ phrase, armed }) })
  },
  /**
   * A line for the phrase tester. `accepted`: whether the gate took it (default: what the mock's gate would say;
   * `null`: left out, as from an older server).
   */
  heard: async (text: string, matched?: string, accepted?: boolean | null, deviceId?: string) => {
    await fetch(`${MOCK}/mock/heard`, {
      method: "POST",
      body: JSON.stringify({ text, ...(matched === undefined ? {} : { matched }), ...(accepted === undefined ? {} : { accepted }), ...(deviceId === undefined ? {} : { deviceId }) })
    })
  },
  /** Change the web-voice defaults (as admin › Front ends would). */
  defaults: async (patch: Record<string, unknown>) => {
    await fetch(`${MOCK}/mock/defaults`, { method: "POST", body: JSON.stringify({ patch }) })
  },
  /** Make `admin.logout` fail (or work again). */
  logoutFails: async (on = true) => {
    await fetch(`${MOCK}/mock/logout-fails`, { method: "POST", body: JSON.stringify({ on }) })
  },
  state: async (state: string) => {
    await fetch(`${MOCK}/mock/state`, { method: "POST", body: JSON.stringify({ state }) })
  },
  /** Protocol 6: the device's conversation has been quiet too long; its next turn starts a new one (`now`: at once). */
  idle: async (deviceId?: string, now = false) => {
    await fetch(`${MOCK}/mock/idle`, { method: "POST", body: JSON.stringify({ ...(deviceId === undefined ? {} : { deviceId }), now }) })
  },
  /** Protocol 6: MAX_VOICE_SESSIONS. */
  maxSessions: async (n: number) => {
    await fetch(`${MOCK}/mock/max-sessions`, { method: "POST", body: JSON.stringify({ n }) })
  }
}

/** The device id this browser context's voice page uses (`pva.deviceId` in `localStorage`). */
export const deviceIdOf = (page: Page): Promise<string> => page.evaluate(() => localStorage.getItem("pva.deviceId") ?? "")

/** The voice page's URL: the static export needs the mock's address (`?ws=`); next dev derives it. `extra`: a hash. */
export const appUrl = (baseURL: string | undefined, extra = "", path = "/") => {
  const url = new URL(path, baseURL ?? "http://127.0.0.1:3200")
  url.searchParams.set("ws", WS)
  return `${url.toString()}${extra}`
}

/** The admin page's URL (`/admin/`), with an optional hash (`#settings/speech/engine`). */
export const adminUrl = (baseURL: string | undefined, hash = "") => appUrl(baseURL, hash, "/admin/")

/** Open admin at `hash`, logging in only if this tab is not logged in yet (the token is per tab). */
export const gotoAdmin = async (page: Page, baseURL: string | undefined, hash = "") => {
  await page.goto(adminUrl(baseURL, hash))
  await page.locator("[data-testid=settings], [data-testid=login-form]").first().waitFor()
  if (await page.getByTestId("login-form").isVisible()) {
    await page.locator("#admin-password").fill(ADMIN_PASSWORD)
    await page.getByRole("button", { name: "Log in" }).click()
  }
  await expect(page.getByTestId("settings")).toBeVisible()
}

/** Open admin (at `hash`) and log in with the mock's password; resolves when the settings screen is on. */
export const loginAdmin = async (page: Page, baseURL: string | undefined, hash = "") => {
  await page.goto(adminUrl(baseURL, hash))
  await page.locator("#admin-password").fill(ADMIN_PASSWORD)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByTestId("settings")).toBeVisible()
}

export const visualState = (page: Page) => page.getByTestId("stage").getAttribute("data-visual-state")

export const expectVisualState = async (page: Page, state: string, timeout = 8000) =>
  expect(page.getByTestId("stage")).toHaveAttribute("data-visual-state", state, { timeout })

/** Every visual state the stage went through (recorded in the page, so brief ones are not missed). */
export const visualHistory = (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() => (window as unknown as { __visualStates?: Array<string> }).__visualStates ?? [])

export const test = base.extend<{ scenario: Scenario }>({
  scenario: ["voice", { option: true }],
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      const states: Array<string> = []
      ;(window as unknown as { __visualStates: Array<string> }).__visualStates = states
      const watch = () => {
        const stage = document.querySelector("[data-testid=stage]")
        if (stage === null) return void requestAnimationFrame(watch)
        const record = () => {
          const v = stage.getAttribute("data-visual-state") ?? ""
          if (states.at(-1) !== v) states.push(v)
        }
        record()
        new MutationObserver(record).observe(stage, { attributes: true, attributeFilter: ["data-visual-state"] })
      }
      document.addEventListener("DOMContentLoaded", watch)
    })
    await use(page)
  }
})
export { expect }
