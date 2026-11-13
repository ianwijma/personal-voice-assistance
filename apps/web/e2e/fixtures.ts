import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, type Page, test as base } from "@playwright/test"

export const here = dirname(fileURLToPath(import.meta.url))
export const MOCK = "http://127.0.0.1:8787"
export const WS = "ws://127.0.0.1:8787/ws"
export const fakeMicPath = join(here, ".fixtures", "speech.wav")

/**
 * A 48 kHz mono WAV for Chromium's fake microphone: 4 s of a speech-like
 * amplitude-modulated tone (≈ −16 dBFS) then 2 s of near-silence, looped by Chromium.
 */
export const writeFakeMic = () => {
  const rate = 48_000
  const seconds = 6
  const n = rate * seconds
  const data = Buffer.alloc(n * 2)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / rate
    let s = 0
    if (t < 4) {
      const pitch = 140 + 30 * Math.sin(2 * Math.PI * 0.5 * t)
      phase += (2 * Math.PI * pitch) / rate
      const env = Math.max(0, Math.sin(2 * Math.PI * 3.3 * t)) ** 0.7
      s = 0.16 * env * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase))
    } else {
      s = 0.0005 * Math.sin(2 * Math.PI * 50 * t)
    }
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  mkdirSync(dirname(fakeMicPath), { recursive: true })
  writeFileSync(fakeMicPath, Buffer.concat([header, data]))
}

export type Scenario = "voice" | "typed" | "modules" | "engine-failed" | "drop-mid-reply" | "takeover" | "outdated"

export interface MockLog {
  readonly scenario: string
  readonly messages: ReadonlyArray<Record<string, unknown> & { type: string; at: number; conn: string }>
  readonly mic: ReadonlyArray<{ conn: string; frames: number; gaps: number; owner: boolean }>
  readonly state: string
  readonly connections: number
}

export const mock = {
  scenario: async (name: Scenario) => {
    const r = await fetch(`${MOCK}/mock/scenario`, { method: "POST", body: JSON.stringify({ name }) })
    expect(r.ok).toBe(true)
  },
  log: async (): Promise<MockLog> => (await (await fetch(`${MOCK}/mock/log`)).json()) as MockLog,
  turn: async () => {
    await fetch(`${MOCK}/mock/turn`, { method: "POST" })
  },
  offline: async (ms: number) => {
    await fetch(`${MOCK}/mock/offline`, { method: "POST", body: JSON.stringify({ ms }) })
  },
  drop: async () => {
    await fetch(`${MOCK}/mock/drop`, { method: "POST" })
  },
  send: async (messages: ReadonlyArray<unknown>) => {
    await fetch(`${MOCK}/mock/send`, { method: "POST", body: JSON.stringify({ messages }) })
  }
}

/** The page URL: the static export needs the mock's address (`?ws=`); next dev derives it. */
export const appUrl = (baseURL: string | undefined, extra = "") => {
  const url = new URL(baseURL ?? "http://127.0.0.1:3200")
  url.searchParams.set("ws", WS)
  return `${url.toString()}${extra}`
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
