// Voice sessions (docs/VOICE-SESSIONS.md step 4): two devices talking to the REAL assistant (local speech models, the
// fake language model) at the same time. Each device is its own headless Chromium, so each has its own fake
// microphone (Chromium's fake capture file is per browser process) and its own `pva.deviceId`.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Browser, chromium, type Page } from "@playwright/test"
import { PROTOCOL_VERSION } from "@pva/protocol"
import {
  type Assistant,
  chromiumArgsFor,
  expect,
  expectVisualState,
  here,
  instrument,
  loginAdmin,
  messages,
  micWav,
  missingPrerequisite,
  question,
  type Recorded,
  repoRoot,
  saveLog,
  setAssistant,
  silence,
  startAssistant,
  test,
  waitForMessage
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

/** One minute of the idle and discard settings, for this server (PVA_TEST_MINUTE_MS, a test hook). */
const MINUTE_MS = 3000

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

/** Milliseconds of a bench file (16 kHz mono s16). */
const lengthMs = (file: string) => {
  const b = readFileSync(join(repoRoot, "bench-audio", file))
  return (b.readUInt32LE(b.indexOf("data") + 4) / 2 / 16_000) * 1000
}

/**
 * Device A says question 1, device B question 3; the shorter one gets more silence in front, so both stop talking at
 * the same moment (both microphones open within a few ms: Start is pressed on both at once). Long silence after, so
 * the looping fake microphone does not speak again during the test.
 */
const wavs = (() => {
  if (missing !== undefined) return { a: "", b: "" }
  const a = "01-hello-can-you-hear-me.wav"
  const b = "03-give-me-one-fun-fact-about-octop.wav"
  const longest = Math.max(lengthMs(a), lengthMs(b))
  const lead = (f: string) => Math.round(1500 + longest - lengthMs(f))
  return {
    a: micWav("sessions-a-hello", [silence(lead(a)), question(1), silence(120_000)]),
    b: micWav("sessions-b-octopus", [silence(lead(b)), question(3), silence(120_000)])
  }
})()

let assistant: Assistant
let browserA: Browser
let browserB: Browser
test.beforeAll(async () => {
  assistant = await startAssistant({
    port: 8805,
    dataDir: join(here, "../test-results/real/data-sessions"),
    env: { PVA_TEST_MINUTE_MS: String(MINUTE_MS) }
  })
  browserA = await chromium.launch({ args: chromiumArgsFor(wavs.a) })
  browserB = await chromium.launch({ args: chromiumArgsFor(wavs.b) })
})
test.afterAll(async () => {
  await browserA?.close()
  await browserB?.close()
  await assistant?.stop()
})

const voicePage = async (browser: Browser, userAgent: string, label: string) => {
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 800 }, userAgent })
  const page = await context.newPage()
  await instrument(page, label)
  await page.goto(assistant.url)
  return { context, page }
}

const received = (log: ReadonlyArray<Recorded>, type: string) => log.filter((m) => m.dir === "in" && m.msg.type === type).map((m) => m.msg)
const sent = (log: ReadonlyArray<Recorded>, type: string) => log.filter((m) => m.dir === "out" && m.msg.type === type).map((m) => m.msg)
const deviceIdOf = (page: Page) => page.evaluate(() => localStorage.getItem("pva.deviceId") ?? "")

/** The device's conversation as a newly connecting tab of that device gets it (`welcome.snapshot.history`). */
const historyOf = (deviceId: string): Promise<ReadonlyArray<{ role: string; text: string }>> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${assistant.url.replace(/^http/, "ws")}/ws`)
    const timer = setTimeout(() => reject(new Error("no welcome")), 5000)
    ws.onopen = () =>
      ws.send(JSON.stringify({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        clientId: `probe-${Date.now()}-${Math.random()}`,
        resumeOwner: false,
        frontend: "voice",
        device: { id: deviceId, kind: "web-voice", name: "probe" }
      }))
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; snapshot?: { history: ReadonlyArray<{ role: string; text: string }> } }
      if (m.type === "welcome") {
        clearTimeout(timer)
        ws.close()
        resolve(m.snapshot!.history)
      }
    }
    ws.onerror = () => reject(new Error("socket error"))
  })

const openChat = async (page: Page) => {
  if (!(await page.getByTestId("chat-panel").isVisible())) await page.getByTestId("chat-toggle").click()
  await expect(page.getByTestId("chat-panel")).toBeVisible()
}

test("two devices at once: each hears and sees only its own turn; claims, New conversation and the quiet reset stay on their device; admin sees both", async ({ page: admin }, testInfo) => {
  test.setTimeout(180_000)
  // Admin first, on the latency page: it must grow live (admin `trace`), without a reload.
  await loginAdmin(admin, assistant.url, "#settings/diagnostics/latency")
  const latencyRows = admin.getByTestId("latency-table").locator("tbody tr")

  const a = await voicePage(browserA, MAC, " A")
  const b = await voicePage(browserB, WINDOWS, " B")
  try {
    // Both talk at the same time: Start together, the microphones' speech ends at the same moment.
    await Promise.all([a.page.getByTestId("start").click(), b.page.getByTestId("start").click()])
    await Promise.all([expectVisualState(a.page, "listening"), expectVisualState(b.page, "listening")])
    const [endA, endB] = await Promise.all([
      waitForMessage(a.page, (m) => m.dir === "in" && m.msg.type === "turn.end", { timeout: 45_000 }),
      waitForMessage(b.page, (m) => m.dir === "in" && m.msg.type === "turn.end", { timeout: 45_000 })
    ])
    expect(endA.msg.outcome).toBe("completed")
    expect(endB.msg.outcome).toBe("completed")
    // Both turn ends really were close together (the server's EndOfTurn is not visible here; the page's turn.start is).
    const startedAt = async (p: Page) => (await messages(p)).find((m) => m.dir === "in" && m.msg.type === "turn.start")!.at
    const [startA, startB] = [await startedAt(a.page), await startedAt(b.page)]
    testInfo.annotations.push({ type: "turn.start A/B (page clocks, ms since load)", description: `${Math.round(startA)} / ${Math.round(startB)}` })

    const logA = await messages(a.page)
    const logB = await messages(b.page)
    const userText = (log: ReadonlyArray<Recorded>) => received(log, "turn.start").map((m) => String(m.userText))
    expect(userText(logA)).toHaveLength(1)
    expect(userText(logB)).toHaveLength(1)
    expect(userText(logA)[0]).toMatch(/hello.*hear me/i)
    expect(userText(logB)[0]).toMatch(/octopus/i)
    // Nothing of the other device's turn arrived: no transcript, no reply text, no reply audio.
    const everything = (log: ReadonlyArray<Recorded>) => JSON.stringify(log.filter((m) => m.dir === "in").map((m) => m.msg))
    expect(everything(logA)).not.toMatch(/octopus/i)
    expect(everything(logB)).not.toMatch(/hear me/i)
    for (const log of [logA, logB]) {
      expect(received(log, "reply.start")).toHaveLength(1)
      // The page played exactly its own reply, and said so.
      expect(sent(log, "playback.started")).toHaveLength(1)
      expect(sent(log, "playback.finished").length).toBeGreaterThanOrEqual(1)
      expect(received(log, "error")).toEqual([])
    }
    expect(String(received(logA, "assistant.text").map((m) => m.text).join(" "))).toMatch(/hear me/i)
    expect(String(received(logB, "assistant.text").map((m) => m.text).join(" "))).toMatch(/octopus/i)

    // Each chat and each server-side history has only its own turn.
    await openChat(a.page)
    await openChat(b.page)
    await expect(a.page.getByTestId("turn")).toHaveCount(1)
    await expect(a.page.getByTestId("turn").first()).toContainText(/hear me/i)
    await expect(b.page.getByTestId("turn")).toHaveCount(1)
    await expect(b.page.getByTestId("turn").first()).toContainText(/octopus/i)
    const idA = await deviceIdOf(a.page)
    const idB = await deviceIdOf(b.page)
    expect(idA).not.toBe(idB)
    const usersOf = async (id: string) => (await historyOf(id)).filter((h) => h.role === "user").map((h) => h.text)
    expect(await usersOf(idA)).toEqual([expect.stringMatching(/hear me/i)])
    expect(await usersOf(idB)).toEqual([expect.stringMatching(/octopus/i)])

    // Admin's latency page got both turns live, each naming its device.
    await expect(latencyRows).toHaveCount(2)
    await expect.poll(async () => (await admin.getByTestId("trace-device").allTextContents()).sort()).toEqual(["Mac · Chrome", "Windows · Chrome"])

    // A claim on device B (its second tab presses Start) takes the audio from B's first tab only; A keeps it.
    const b2 = await b.context.newPage()
    await instrument(b2, " B2")
    await b2.goto(assistant.url)
    await b2.getByTestId("start").click()
    await expect(b.page.getByTestId("observer-banner")).toBeVisible()
    await expectVisualState(b2, "listening")
    await expect(a.page.getByTestId("observer-banner")).toBeHidden()
    await expect(a.page.getByTestId("stage")).not.toHaveAttribute("data-visual-state", "not-started")
    // A's tab was never told it lost the audio.
    expect(received(await messages(a.page), "session").map((m) => m.reason)).not.toContain("taken_over")
    expect(received(await messages(a.page), "session").at(-1)?.role).toBe("owner")

    // Admin: Devices and Overview list both sessions as talking.
    await admin.getByTestId("nav-devices").click()
    const list = admin.getByTestId("device-list")
    await expect(list.locator(`[data-device="${idA}"]`).getByTestId("talking-now")).toHaveText("Talking now")
    await expect(list.locator(`[data-device="${idB}"]`).getByTestId("talking-now")).toHaveText("Talking now")
    await admin.goto(admin.url().replace(/#.*$/, "#settings/overview"))
    const sessions = admin.getByTestId("sessions")
    await expect(sessions.locator("[data-session]")).toHaveCount(2)
    await expect(sessions.locator('[data-talking="true"]')).toHaveCount(2)
    await expect(sessions).toContainText("Mac · Chrome")
    await expect(sessions).toContainText("Windows · Chrome")

    // New conversation on A empties A only.
    const turnsB = await b.page.getByTestId("turn").count()
    await a.page.getByTestId("new-conversation").click()
    await expect(a.page.getByTestId("turn")).toHaveCount(0)
    await expect(a.page.getByTestId("conversation-divider")).toHaveAttribute("data-reason", "new")
    await expect(b.page.getByTestId("conversation-divider")).toHaveCount(0)
    await expect(b.page.getByTestId("turn")).toHaveCount(turnsB)
    expect(await usersOf(idA)).toEqual([])
    expect((await usersOf(idB)).length).toBeGreaterThanOrEqual(1)

    // The quiet reset: one "minute" (MINUTE_MS here) without a committed turn, and A's next turn starts a new
    // conversation; nothing of it reaches B.
    await setAssistant(assistant.url, { newConversationAfter: 1 })
    const type = async (text: string) => {
      const before = await a.page.getByTestId("turn").count()
      await a.page.locator("#chat-input").fill(text)
      await a.page.keyboard.press("Enter")
      await expect(a.page.getByTestId("turn")).toHaveCount(before + 1)
      await expect(a.page.getByTestId("turn").last()).toHaveAttribute("data-outcome", "completed", { timeout: 15_000 })
    }
    await type("First thing after the new conversation.")
    expect(await usersOf(idA)).toEqual(["First thing after the new conversation."])
    await a.page.waitForTimeout(MINUTE_MS + 1500)
    const fromA = (await messages(a.page)).length
    await a.page.locator("#chat-input").fill("Back after a quiet while.")
    await a.page.keyboard.press("Enter")
    const idle = await waitForMessage(a.page, (m) => m.dir === "in" && m.msg.type === "conversation", { from: fromA, timeout: 10_000 })
    expect(idle.msg.reason).toBe("idle")
    await expect(a.page.getByTestId("conversation-divider")).toHaveAttribute("data-reason", "idle")
    await expect(a.page.getByTestId("turn")).toHaveCount(1)
    await expect(a.page.getByTestId("turn").last()).toHaveAttribute("data-outcome", "completed", { timeout: 15_000 })
    expect(await usersOf(idA)).toEqual(["Back after a quiet while."])
    // B never got A's new conversation. B's second tab's microphone says B's question again (the fake microphone
    // starts its file when that tab opens it), so B may have reset itself: then only right before a turn of its own.
    const logB2 = await messages(b.page)
    const inB = logB2.filter((m) => m.dir === "in")
    for (const [i, m] of inB.entries()) {
      if (m.msg.type !== "conversation") continue
      expect(m.msg.reason).toBe("idle")
      expect(inB.slice(i + 1).find((n) => n.msg.type === "turn.start")?.msg.userText).toMatch(/octopus/i)
    }
    expect(everything(logB2)).not.toMatch(/quiet while|after the new conversation/i)
    expect((await usersOf(idB)).length).toBeGreaterThanOrEqual(1)
    await b2.close()
  } finally {
    await saveLog(a.page, testInfo.outputPath("socket-log-a.json"))
    await saveLog(b.page, testInfo.outputPath("socket-log-b.json"))
    await a.context.close()
    await b.context.close()
  }
})
