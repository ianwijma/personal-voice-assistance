// Fixtures for the end-to-end tests against the REAL assistant (`pnpm start serve`
// with the local speech models and the fake language model), in headless
// Chromium with a fake microphone fed from WAV files. docs/UI-AND-MODULES.md §6.3.
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, expect, type Page, test as base } from "@playwright/test"

export const here = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(here, "../../..")
const assistantDir = join(repoRoot, "apps/assistant")
/** The UI the tests serve: `pnpm e2e:real` builds it to `out-e2e/` (`PVA_WEB_EXPORT_DIR`), never over `out/`. */
export const webOut = join(repoRoot, "apps/web", process.env.PVA_WEB_EXPORT_DIR ?? "out")
const fixturesDir = join(here, ".fixtures")
const benchAudio = join(repoRoot, "bench-audio")

// ---------------------------------------------------------------------------
// What must be installed; the tests skip (with the reason) when something is missing.

const requiredModels = [
  "models/silero_vad.onnx",
  "models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/encoder.int8.onnx", // the default speech model (parakeet-v2)
  "models/vits-piper-en_US-lessac-medium/en_US-lessac-medium.onnx"
]

export const missingPrerequisite = (): string | undefined => {
  for (const m of requiredModels) if (!existsSync(join(repoRoot, m))) return `${m} is missing (pnpm download-models)`
  if (!existsSync(join(benchAudio, "01-hello-can-you-hear-me.wav"))) return "bench-audio/ is missing (pnpm start bench --make-wavs)"
  if (!existsSync(join(webOut, "index.html"))) return `${webOut} is missing (pnpm e2e:real builds it)`
  // Headless runs use Chrome Headless Shell, which sits next to the full Chromium build of the same revision.
  const notInstalled = "Playwright's Chromium is not installed (pnpm --filter @pva/web e2e:install)"
  try {
    const full = chromium.executablePath()
    const revision = /chromium-(\d+)/.exec(full)?.[1]
    const cache = full.slice(0, full.indexOf(`chromium-${revision}`))
    if (!existsSync(full) && !existsSync(join(cache, `chromium_headless_shell-${revision}`, "INSTALLATION_COMPLETE"))) return notInstalled
  } catch {
    return notInstalled
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 48 kHz input files for Chromium's fake microphone (it loops the file).

const readWav16k = (file: string): Int16Array => {
  const b = readFileSync(file)
  const at = b.indexOf("data")
  const n = b.readUInt32LE(at + 4)
  const out = new Int16Array(n / 2)
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(at + 8 + i * 2)
  return out
}

/** 16 → 48 kHz: zero-stuffing and a windowed-sinc low-pass at 7.6 kHz (the speech is 16 kHz anyway). */
const upsample3 = (input: Int16Array): Float64Array => {
  const taps = 97
  const half = (taps - 1) / 2
  const fc = 7600 / 48_000
  const h = new Float64Array(taps)
  for (let i = 0; i < taps; i++) {
    const m = i - half
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m)
    h[i] = 3 * sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1)))
  }
  const out = new Float64Array(input.length * 3)
  for (let n = 0; n < out.length; n++) {
    let acc = 0
    for (let k = 0; k < taps; k++) {
      const j = n - k + half
      if (j >= 0 && j % 3 === 0 && j / 3 < input.length) acc += h[k]! * input[j / 3]!
    }
    out[n] = acc
  }
  return out
}

export type Segment = { readonly speech: string } | { readonly silenceMs: number }

/** The bench question files, by number (1–5). */
export const question = (n: 1 | 2 | 3 | 4 | 5): Segment => ({
  speech: [
    "01-hello-can-you-hear-me.wav",
    "02-what-time-is-it-in-tokyo-right-n.wav",
    "03-give-me-one-fun-fact-about-octop.wav",
    "04-what-s-the-weather-like-in-amste.wav",
    "05-thanks-that-s-all-for-now.wav"
  ][n - 1]!
})
export const silence = (ms: number): Segment => ({ silenceMs: ms })

/** Writes (once) a 48 kHz mono WAV of the segments; "silence" is a −75 dBFS noise floor. Returns its path. */
export const micWav = (name: string, segments: ReadonlyArray<Segment>): string => {
  const path = join(fixturesDir, `${name}.wav`)
  if (existsSync(path)) return path
  const parts: Array<Float64Array> = []
  let seed = 1
  for (const s of segments) {
    if ("speech" in s) parts.push(upsample3(readWav16k(join(benchAudio, s.speech))))
    else {
      const n = Math.round((s.silenceMs * 48_000) / 1000)
      const noise = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff
        noise[i] = ((seed / 0x7fffffff) * 2 - 1) * 6 // about −75 dBFS
      }
      parts.push(noise)
    }
  }
  const total = parts.reduce((a, p) => a + p.length, 0)
  const data = Buffer.alloc(total * 2)
  let o = 0
  for (const p of parts) for (const v of p) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), (o++) * 2)
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(48_000, 24)
  header.writeUInt32LE(96_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  mkdirSync(fixturesDir, { recursive: true })
  writeFileSync(path, Buffer.concat([header, data]))
  return path
}

export const chromiumArgsFor = (wav: string) => [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  `--use-file-for-fake-audio-capture=${wav}`,
  "--autoplay-policy=no-user-gesture-required"
]

// ---------------------------------------------------------------------------
// The real assistant, one process per test file (or per test when it must be killed).

export interface Assistant {
  readonly url: string
  readonly port: number
  readonly dataDir: string
  readonly log: () => string
  /** SIGINT to the process group, wait for exit; SIGKILL after 10 s. */
  readonly stop: (signal?: NodeJS.Signals) => Promise<number | null>
  readonly process: ChildProcess
}

export const startAssistant = async (options: {
  readonly port: number
  readonly dataDir: string
  readonly env?: Record<string, string>
  readonly fresh?: boolean
}): Promise<Assistant> => {
  if (options.fresh !== false) rmSync(options.dataDir, { recursive: true, force: true })
  mkdirSync(options.dataDir, { recursive: true })
  const tsx = join(assistantDir, "node_modules/tsx/dist/cli.mjs")
  let output = ""
  const child = spawn(process.execPath, [tsx, "src/main.ts", "serve"], {
    cwd: assistantDir,
    detached: true, // its own process group, so stop() reaches the engine processes too
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LLM_PROVIDER: "fake", // everything else at its defaults (local speech, the standard voice)
      SERVE_HOST: "127.0.0.1",
      SERVE_PORT: String(options.port),
      PVA_DATA_DIR: options.dataDir,
      PVA_WEB_DIR: webOut,
      ...options.env
    }
  })
  const logFile = `${options.dataDir}.log` // the assistant's output, kept for debugging
  const append = (d: Buffer) => {
    output += d.toString()
    try {
      writeFileSync(logFile, output)
    } catch {}
  }
  child.stdout!.on("data", append)
  child.stderr!.on("data", append)
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)))
  const url = `http://127.0.0.1:${options.port}`
  const deadline = Date.now() + 60_000
  while (!output.includes("Engines ready")) {
    if (child.exitCode !== null) throw new Error(`assistant exited (${child.exitCode}):\n${output}`)
    if (Date.now() > deadline) {
      process.kill(-child.pid!, "SIGKILL")
      throw new Error(`assistant did not become ready in 60 s:\n${output}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    url,
    port: options.port,
    dataDir: options.dataDir,
    process: child,
    log: () => output,
    stop: async (signal = "SIGINT") => {
      if (child.exitCode !== null) return child.exitCode
      try {
        process.kill(-child.pid!, signal)
      } catch {
        return child.exitCode
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL")
        } catch {}
      }, 10_000)
      const code = await exited
      clearTimeout(timer)
      return code
    }
  }
}

// ---------------------------------------------------------------------------
// What the page sent and received, recorded inside the page with its own clock
// (performance.now), so latency numbers are not skewed by Playwright's transport.

export interface Recorded {
  readonly at: number
  readonly dir: "in" | "out"
  readonly msg: Record<string, unknown> & { type: string }
}
export interface MicStats {
  /** Microphone frames sent. */
  readonly frames: number
  /** Send times (performance.now) of the last loud frame of each loud stretch. */
  readonly speechEnds: ReadonlyArray<number>
}

const recorder = () => {
  type W = { __pvaRec: { log: Array<unknown>; frames: number; speechEnds: Array<number>; loud: boolean; lastLoud: number; quiet: number; states: Array<string> } }
  const w = window as unknown as W
  w.__pvaRec = { log: [], frames: 0, speechEnds: [], loud: false, lastLoud: 0, quiet: 0, states: [] }
  const r = w.__pvaRec
  const send = WebSocket.prototype.send
  WebSocket.prototype.send = function(this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    const at = performance.now()
    if (typeof data === "string") {
      try {
        r.log.push({ at, dir: "out", msg: JSON.parse(data) })
      } catch {}
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      if (bytes[0] === 1 && bytes.byteLength > 8) {
        r.frames++
        const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset + 8, bytes.byteOffset + bytes.byteLength))
        let e = 0
        for (let i = 0; i < pcm.length; i++) e += pcm[i]! * pcm[i]!
        const rms = Math.sqrt(e / pcm.length)
        if (rms > 300) {
          r.loud = true
          r.lastLoud = at
          r.quiet = 0
        } else if (r.loud && ++r.quiet >= 25) { // 500 ms of quiet closes a loud stretch
          r.speechEnds.push(r.lastLoud)
          r.loud = false
        }
      }
    }
    return send.call(this, data as never)
  }
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | Array<string>) {
      super(url, protocols)
      this.addEventListener("message", (e: MessageEvent) => {
        if (typeof e.data === "string") {
          try {
            r.log.push({ at: performance.now(), dir: "in", msg: JSON.parse(e.data) })
          } catch {}
        }
      })
    }
  } as typeof WebSocket
  const watch = () => {
    const stage = document.querySelector("[data-testid=stage]")
    if (stage === null) return void requestAnimationFrame(watch)
    const record = () => {
      const v = stage.getAttribute("data-visual-state") ?? ""
      if (r.states.at(-1) !== v) r.states.push(v)
    }
    record()
    new MutationObserver(record).observe(stage, { attributes: true, attributeFilter: ["data-visual-state"] })
  }
  document.addEventListener("DOMContentLoaded", watch)
}

export const messages = (page: Page): Promise<ReadonlyArray<Recorded>> =>
  page.evaluate(() => (window as unknown as { __pvaRec: { log: Array<Recorded> } }).__pvaRec.log)
export const micStats = (page: Page): Promise<MicStats> =>
  page.evaluate(() => {
    const r = (window as unknown as { __pvaRec: { frames: number; speechEnds: Array<number> } }).__pvaRec
    return { frames: r.frames, speechEnds: r.speechEnds }
  })
export const visualHistory = (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() => (window as unknown as { __pvaRec: { states: Array<string> } }).__pvaRec.states)

/** Waits until the page has received a message matching `pred` (after index `from` of the log). */
export const waitForMessage = async (
  page: Page,
  pred: (r: Recorded) => boolean,
  options: { timeout?: number; from?: number } = {}
): Promise<Recorded> => {
  const deadline = Date.now() + (options.timeout ?? 20_000)
  for (;;) {
    const log = await messages(page)
    const hit = log.slice(options.from ?? 0).find(pred)
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error(`no matching message within ${options.timeout ?? 20_000} ms; last: ${JSON.stringify(log.slice(-8).map((m) => m.msg.type))}`)
    await page.waitForTimeout(100)
  }
}

export const turnEnds = async (page: Page) =>
  (await messages(page)).filter((m) => m.dir === "in" && m.msg.type === "turn.end").map((m) => m.msg as unknown as TurnEnd & { type: string })

export interface TurnEnd {
  readonly turnId: number
  readonly outcome: string
  readonly trace: {
    readonly speculative: boolean
    readonly marks: Record<string, number | undefined>
    readonly client?: { readonly outputLatencyMs: number; readonly startDelayMs: number }
    readonly totalMs?: number
  }
}

export const expectVisualState = (page: Page, state: string, timeout = 15_000) =>
  expect(page.getByTestId("stage")).toHaveAttribute("data-visual-state", state, { timeout })

/** Records the page's socket traffic and visual states (see `recorder`); logs page errors. */
export const instrument = async (page: Page, label = "") => {
  page.on("pageerror", (e) => console.log(`[page${label} error] ${e.message}`))
  page.on("console", (m) => {
    if (m.text().includes("ERR_CONNECTION_REFUSED")) return // expected while the assistant restarts
    if (m.type() === "error" || m.type() === "warning") console.log(`[page${label} ${m.type()}] ${m.text()}`)
  })
  // As source text: the test runner's TypeScript transform adds `__name(...)` calls, absent in the page.
  await page.addInitScript({ content: `var __name = (f) => f; (${recorder.toString()})()` })
}

/** Keeps what the page saw, for debugging (test-results/real/<test>/<name>.json). */
export const saveLog = async (page: Page, file: string) => {
  try {
    writeFileSync(file, JSON.stringify(await messages(page), null, 1))
  } catch {}
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await instrument(page)
    await use(page)
    await saveLog(page, testInfo.outputPath("socket-log.json"))
  }
})
export { expect }

/** Per-device preferences (localStorage) to apply before the page loads. */
export const setPrefs = (page: Page, prefs: Record<string, unknown>) =>
  page.addInitScript({ content: `localStorage.setItem("pva.prefs.v1", ${JSON.stringify(JSON.stringify(prefs))})` })

export type History = ReadonlyArray<{ role: "user" | "assistant"; text: string; interrupted?: boolean; tools?: ReadonlyArray<{ name: string; ok: boolean }> }>

/** The server's conversation history, as a newly connecting tab receives it (`welcome.snapshot.history`). */
export const serverHistory = async (url: string): Promise<History> => {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no welcome")), 5000)
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", protocol: 1, clientId: `probe-${Date.now()}`, resumeOwner: false }))
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; snapshot?: { history: History } }
      if (m.type === "welcome") {
        clearTimeout(timer)
        ws.close()
        resolve(m.snapshot!.history)
      }
    }
    ws.onerror = () => reject(new Error("socket error"))
  })
}
