/**
 * The contact sheets of one character, for its pull request:
 *   CHARACTER=<id> pnpm --filter @pva/web shots:character
 * writes screenshots/characters/<id>-dark.png and <id>-light.png: IDLE, LISTENING, HEARING, THINKING, SPEAKING, each a
 * screenshot of the real voice page's stage canvas area (desktop size) against the mock, composed into one image in
 * the browser. Not a Playwright test: it starts its own mock and static server on free ports, so several checkouts
 * can run it at once. See src/characters/README.md.
 *
 * Environment: CHARACTER (required), SKIP_BUILD=1 (reuse an existing export), PVA_WEB_EXPORT_DIR (the export, default
 * `out`), SHOTS_MOCK_PORT / SHOTS_WEB_PORT (fixed ports instead of free ones).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "@playwright/test"
import { fakeMicPath, writeFakeMic } from "./fakeMic.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const id = process.env.CHARACTER ?? ""
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error("Set CHARACTER=<id> (the file name in src/characters/library/, without .ts).")
  process.exit(2)
}
const exportDir = process.env.PVA_WEB_EXPORT_DIR ?? "out"
const outDir = join(root, "screenshots", "characters")
const started = Date.now()

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const children: Array<ChildProcess> = []
const stopAll = () => children.forEach((c) => c.kill())
process.on("exit", stopAll)
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130))

const waitFor = async (url: string, what: string) => {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch { /* not up yet */ }
    await wait(100)
  }
  throw new Error(`${what} did not start (${url})`)
}

const VIEWPORT = { width: 1280, height: 800 }
type Theme = "dark" | "light"
interface State {
  readonly label: string
  readonly visual: string
  readonly caption: string
}
const STATES: ReadonlyArray<State> = [
  { label: "IDLE", visual: "idle", caption: "no audio: microphone quiet" },
  { label: "LISTENING", visual: "listening", caption: "no audio: microphone quiet" },
  { label: "HEARING", visual: "hearing", caption: "fake microphone: speech-like tone" },
  { label: "THINKING", visual: "thinking", caption: "no audio: microphone quiet" },
  { label: "SPEAKING", visual: "speaking", caption: "scripted reply audio (mock /mock/turn)" }
]
/** Chromium loops the fake microphone file: 4 s of speech-like tone, then 2 s of near silence (e2e/fakeMic.ts). */
const MIC_TONE_AT = 1800
const MIC_QUIET_AT = 4800

const run = async () => {
  if (process.env.SKIP_BUILD !== "1") {
    console.log("building the static export (SKIP_BUILD=1 reuses an existing one)")
    const r = spawnSync("pnpm", ["exec", "next", "build"], { cwd: root, stdio: "inherit" })
    if (r.status !== 0) throw new Error("next build failed")
  }
  writeFakeMic()
  const mockPort = Number(process.env.SHOTS_MOCK_PORT ?? 0) || (await freePort())
  const webPort = Number(process.env.SHOTS_WEB_PORT ?? 0) || (await freePort())
  const MOCK = `http://127.0.0.1:${mockPort}`
  children.push(
    spawn("pnpm", ["exec", "tsx", "mock/server.ts"], { cwd: root, stdio: "ignore", env: { ...process.env, MOCK_QUIET: "1", MOCK_PORT: String(mockPort), MOCK_SCENARIO: "typed" } }),
    spawn("node", ["scripts/serve-static.mjs", exportDir, String(webPort)], { cwd: root, stdio: "ignore" })
  )
  await waitFor(`${MOCK}/mock/log`, "the mock")
  await waitFor(`http://127.0.0.1:${webPort}/`, "the static server (is the export built?)")
  const post = (path: string, body?: unknown) => fetch(`${MOCK}${path}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const url = `http://127.0.0.1:${webPort}/?ws=${encodeURIComponent(`ws://127.0.0.1:${mockPort}/ws`)}&character=${id}`

  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${fakeMicPath}`]
  })
  const visualIs = (page: Page, state: string, timeout = 10_000) =>
    page.waitForFunction((s) => document.querySelector("[data-testid=stage]")?.getAttribute("data-visual-state") === s, state, { timeout })

  /** One panel: a fresh page (so the microphone loop starts at Start), the state held, the stage area captured. */
  const capture = async (theme: Theme, state: State): Promise<string> => {
    const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: theme, permissions: ["microphone"] })
    const page = await ctx.newPage()
    try {
      await post("/mock/scenario", { name: "typed" })
      await page.goto(url)
      await page.getByTestId("start").click()
      const t0 = Date.now()
      await visualIs(page, "listening")
      // The requested character is on stage, not a fallback.
      await page.waitForFunction(() => (window as any).__pvaStage !== undefined, undefined, { timeout: 10_000 })
      await page.evaluate(() => (window as any).__pvaStage.ready())
      const dbg = await page.evaluate(() => (window as any).__pvaStage.debug())
      if (dbg.id !== id || dbg.fallback !== null) {
        throw new Error(`character "${id}" is not on stage (on stage: "${dbg.id}"${dbg.fallback ? `; fell back: ${dbg.fallback.reason}: ${dbg.fallback.message}` : ""})`)
      }
      if (state.visual === "speaking") {
        await post("/mock/turn")
        await visualIs(page, "speaking", 15_000)
        await page.waitForTimeout(1200)
      } else {
        if (state.visual !== "listening") await post("/mock/state", { state: state.visual })
        await visualIs(page, state.visual)
        const at = state.visual === "hearing" ? MIC_TONE_AT : MIC_QUIET_AT
        await page.waitForTimeout(Math.max(1500, at - (Date.now() - t0)))
      }
      await page.waitForFunction((n) => (window as any).__pvaStage.debug().frames > n, 30)
      if ((await page.evaluate(() => (window as any).__pvaStage.debug())).id !== id) throw new Error(`character "${id}" left the stage`)
      const png = await page.locator(".stage-vis").screenshot()
      return `data:image/png;base64,${png.toString("base64")}`
    } finally {
      await ctx.close()
    }
  }

  mkdirSync(outDir, { recursive: true })
  for (const theme of ["dark", "light"] as const) {
    const panels: Array<{ state: State; src: string }> = []
    for (const state of STATES) {
      console.log(`${theme} ${state.label}`)
      panels.push({ state, src: await capture(theme, state) })
    }
    const ctx = await browser.newContext({ colorScheme: theme, viewport: { width: 800, height: 400 } })
    const page = await ctx.newPage()
    const dark = theme === "dark"
    const cells = panels
      .map(
        (p) => `<figure><div class="l">${p.state.label}</div><img src="${p.src}"><figcaption>${p.state.caption}</figcaption></figure>`
      )
      .join("")
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:24px;background:${dark ? "#0b0d10" : "#ffffff"};color:${dark ? "#e8eaed" : "#14171a"};font:14px/1.3 system-ui,sans-serif;width:max-content}
      h1{font:600 18px system-ui,sans-serif;margin:0 0 16px}h1 span{font-weight:400;opacity:.65}
      .row{display:flex;gap:16px}figure{margin:0}
      .l{font:700 16px system-ui,sans-serif;letter-spacing:.12em;margin-bottom:8px}
      img{display:block;outline:1px solid ${dark ? "#2a2f36" : "#d5d9de"}}
      figcaption{margin-top:6px;font-size:13px;opacity:.7}</style>
      <h1>${id} <span>${theme} theme, desktop stage</span></h1><div class="row">${cells}</div>`)
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0))
    const sheet = await page.screenshot({ fullPage: true })
    writeFileSync(join(outDir, `${id}-${theme}.png`), sheet)
    await ctx.close()
  }
  await browser.close()
  console.log(`wrote screenshots/characters/${id}-dark.png and ${id}-light.png in ${Math.round((Date.now() - started) / 1000)} s`)
}

run().then(
  () => process.exit(0),
  (e) => {
    console.error(`shots:character failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
)
