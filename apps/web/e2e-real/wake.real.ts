// Wake-phrase activation with real speech through the real recogniser (docs/FRONTENDS-AND-ACTIVATION.md §3, §5).
// The fake microphone plays sentences the assistant synthesised itself (`spoken`): an unrelated sentence, "Hey Jeff,
// what time is it?", "Hey Jeff." alone. Each block has its own audio (one browser per block) and its own assistant.
import { type Browser, chromium, type Page } from "@playwright/test"
import { join } from "node:path"
import {
  alerts,
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
  type Recorded,
  saveLog,
  setFrontendDefaults,
  silence,
  spoken,
  startAssistant,
  test,
  turnEnds,
  visualHistory,
  waitForMessage
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

/** One port per block (8800–8803): each block's browser, and so its assistant, is its own. */
const ports = { request: 8800, alone: 8801, "latency-always": 8802, "latency-wake-phrase": 8803 } as const
const UNRELATED = "I think the tomatoes in the garden need more water."
const wavOf = (name: string, segments: Parameters<typeof micWav>[1]) => (missing === undefined ? micWav(name, segments) : "")

const turnStarts = async (page: Page, from = 0) =>
  (await messages(page)).slice(from).filter((m) => m.dir === "in" && m.msg.type === "turn.start").map((m) => m.msg as unknown as { userText: string; source: string })
const ofType = (log: ReadonlyArray<Recorded>, type: string) => log.filter((m) => m.dir === "in" && m.msg.type === type).map((m) => m.msg)
/** The assistant's `turn #…` trace lines (from its log) since `from` characters. */
const traceLines = (a: Assistant, from = 0) => a.log().slice(from).split("\n").filter((l) => /^turn #\d+ /.test(l))

/** A Chromium whose fake microphone plays `wav` (the launch flag is per browser, so each block launches its own). */
const launch = (wav: string): Promise<Browser> => chromium.launch({ args: chromiumArgsFor(wav) })
const newPage = async (browser: Browser, label: string) => {
  const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await instrument(page, label)
  return page
}

const withAssistant = (name: keyof typeof ports, env?: Record<string, string>) => {
  const port = ports[name]
  const box: { a?: Assistant } = {}
  test.beforeAll(async () => {
    box.a = await startAssistant({ port, dataDir: join(here, `../test-results/real/data-wake-${name}`), ...(env === undefined ? {} : { env }) })
  })
  test.afterAll(async () => {
    await box.a?.stop()
  })
  return () => box.a!
}

test.describe("asleep: unrelated talk is ignored; the phrase with a request is answered without the phrase; the tester", () => {
  const wav = wavOf("wake-ignored-then-request", [silence(2000), spoken(UNRELATED), silence(3000), spoken("Hey Jeff, what time is it?"), silence(16_000)])
  const assistant = withAssistant("request")

  test("ignored talk makes no caption, no transcript and no turn; Add as phrase on it makes it a phrase that wakes", async ({}, testInfo) => {
    test.setTimeout(150_000)
    await setFrontendDefaults(assistant().url, { activation: "wake-phrase" })
    const browser = await launch(wav)
    const admin = await newPage(browser, " admin")
    const voice = await admin.context().newPage()
    await instrument(voice, " voice")
    try {
      // The admin's phrase tester listens before the device starts, so it sees every line.
      await loginAdmin(admin, assistant().url, "#settings/frontends/web-voice")
      const tester = admin.getByTestId("phrase-tester")
      await tester.getByTestId("tester-listen").click()
      await expect(tester).toHaveAttribute("data-on", "true")

      await voice.goto(assistant().url)
      await voice.getByTestId("start").click()
      await expectVisualState(voice, "asleep")
      await expect(voice.getByTestId("state-label")).toHaveText("Say “Hey Jeff”")
      await expect(tester).toContainText(/Testing .*Chrome with its saved settings/)

      // The request after the phrase: answered, the phrase removed.
      await waitForMessage(voice, (m) => m.msg.type === "turn.start", { timeout: 40_000 })
      const before = await messages(voice)
      const start = ofType(before, "turn.start")[0] as unknown as { userText: string }
      console.log(`[wake] turn.start userText: ${JSON.stringify(start.userText)}`)
      expect(start.userText).toMatch(/^what time is it\??$/i)
      expect(ofType(before, "wake")).toEqual([{ type: "wake", phrase: "hey jeff", armed: false }])
      // Nothing of the unrelated sentence reached the voice page: no transcript, no caption, no "hearing".
      const transcripts = ofType(before, "transcript").map((m) => String(m.text))
      expect(transcripts.join(" ")).not.toMatch(/tomato/i)
      const states = await visualHistory(voice)
      expect(states.slice(0, states.indexOf("listening") === -1 ? states.length : states.indexOf("listening"))).not.toContain("hearing")
      await waitForMessage(voice, (m) => m.msg.type === "turn.end", { timeout: 30_000 })
      expect((await turnEnds(voice))[0]!.outcome).toBe("completed")

      // The tester: the unrelated line ignored, the request matched with its phrase.
      const lines = tester.getByTestId("heard-lines")
      const ignored = lines.locator("[data-outcome=ignored]").filter({ hasText: /tomatoes/i })
      await expect(ignored).toHaveCount(1)
      await expect(ignored).toContainText("Ignored")
      const matched = lines.locator("[data-matched=true]").filter({ hasText: /what time/i })
      await expect(matched).toContainText(/Matched .*Hey Jeff/i)
      for (const t of await lines.locator("li").allTextContents()) console.log(`[wake] tester line: ${t}`)

      // After the reply: the follow-up window (listening), then asleep again.
      await expectVisualState(voice, "listening", 10_000)
      await expectVisualState(voice, "asleep", 15_000)

      // Add as phrase on the ignored line ("i think"), save: the same sentence wakes the assistant on the next loop.
      await ignored.getByRole("button", { name: /Add “i think” as a wake phrase/ }).click()
      await expect(admin.getByTestId("phrase-list").locator("[data-phrase='i think']")).toBeVisible()
      await admin.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
      await expect(admin.getByTestId("footer-note")).toContainText("Saved")
      const from = (await messages(voice)).length
      const next = await waitForMessage(voice, (m) => m.msg.type === "turn.start", { from, timeout: 45_000 })
      console.log(`[wake] after Add as phrase, turn.start userText: ${JSON.stringify(next.msg.userText)}`)
      expect(String(next.msg.userText)).toMatch(/^the tomatoes in the garden need more water\.?$/i)
      expect(ofType((await messages(voice)).slice(from), "wake")[0]).toMatchObject({ phrase: "i think", armed: false })
      expect(await alerts(voice)).toEqual([])
      expect(await alerts(admin)).toEqual([])
    } finally {
      await saveLog(voice, testInfo.outputPath("socket-log-voice.json"))
      await saveLog(admin, testInfo.outputPath("socket-log-admin.json"))
      await browser.close()
      testInfo.attachments.push({ name: "assistant.log", contentType: "text/plain", body: Buffer.from(assistant().log()) })
    }
  })
})

test.describe("the phrase alone, then the request; the follow-up window; asleep again", () => {
  const wav = wavOf("wake-phrase-alone", [
        silence(2000),
        spoken("Hey Jeff.", { voice: "natural" }),
        silence(1500),
        spoken("What time is it?", { voice: "natural" }),
        silence(7000),
        spoken(UNRELATED, { voice: "natural" }),
        silence(25_000)
      ])
  const assistant = withAssistant("alone")

  test("Hey Jeff. → Listening…, the next sentence is answered; within the follow-up window no phrase is needed; then asleep", async ({}, testInfo) => {
    test.setTimeout(150_000)
    await setFrontendDefaults(assistant().url, { activation: "wake-phrase", followUpSeconds: 8 })
    const browser = await launch(wav)
    const page = await newPage(browser, "")
    try {
    await page.goto(assistant().url)
    await page.getByTestId("start").click()
    await expectVisualState(page, "asleep")
    const wake = await waitForMessage(page, (m) => m.msg.type === "wake", { timeout: 20_000 })
    expect(wake.msg).toEqual({ type: "wake", phrase: "hey jeff", armed: true })
    await expect(page.getByTestId("state-label")).toHaveText("Listening…")
    await waitForMessage(page, (m) => m.msg.type === "turn.start", { timeout: 20_000 })
    await waitForMessage(page, (m) => m.msg.type === "turn.end", { timeout: 30_000 })
    // The unrelated sentence comes inside the follow-up window: answered without the phrase.
    await expect.poll(async () => (await turnStarts(page)).length, { timeout: 30_000 }).toBe(2)
    const starts = await turnStarts(page)
    console.log(`[wake alone] userTexts: ${JSON.stringify(starts.map((s) => s.userText))}`)
    expect(starts[0]!.userText).toMatch(/^what time is it\??$/i)
    expect(starts[1]!.userText).toMatch(/tomatoes in the garden/i)
    await expect.poll(async () => (await turnEnds(page)).length, { timeout: 30_000 }).toBe(2)
    // Nothing more is said for 25 s: after the window the stage is asleep again.
    await expectVisualState(page, "listening", 5000)
    await expectVisualState(page, "asleep", 15_000)
    await expect(page.getByTestId("state-label")).toHaveText("Say “Hey Jeff”")
    expect(await alerts(page)).toEqual([])
    } finally {
      await saveLog(page, testInfo.outputPath("socket-log.json"))
      await browser.close()
    }
  })
})

// Latency: the same request in `always` mode and in wake mode (with the phrase in front), three turns each.
const LATENCY_TURNS = 3
for (const mode of ["always", "wake-phrase"] as const) {
  test.describe(`latency, ${mode}`, () => {
    const sentence = mode === "always" ? "What time is it?" : "Hey Jeff, what time is it?"
    const wav = wavOf(`wake-latency-${mode}`, [silence(2000), spoken(sentence), silence(9000)])
    const assistant = withAssistant(`latency-${mode}`)

    test(`${LATENCY_TURNS} spoken turns in ${mode} mode: the TurnTrace lines`, async ({}, testInfo) => {
      test.setTimeout(120_000)
      // Follow-up off, so each turn in wake mode really goes through the asleep gate.
      await setFrontendDefaults(assistant().url, { activation: mode, followUpSeconds: 0 })
      const logFrom = assistant().log().length
      const browser = await launch(wav)
      const page = await newPage(browser, "")
      try {
      await page.goto(assistant().url)
      await page.getByTestId("start").click()
      await expect.poll(async () => (await turnEnds(page)).length, { timeout: 90_000 }).toBeGreaterThanOrEqual(LATENCY_TURNS)
      const starts = await turnStarts(page)
      for (const s of starts.slice(0, LATENCY_TURNS)) expect(s.userText).toMatch(/^what time is it\??$/i)
      const ends = (await turnEnds(page)).slice(0, LATENCY_TURNS)
      for (const e of ends) expect(e.outcome).toBe("completed")
      for (const l of traceLines(assistant(), logFrom).slice(0, LATENCY_TURNS)) console.log(`[latency ${mode}] ${l}`)
      } finally {
        await saveLog(page, testInfo.outputPath("socket-log.json"))
        await browser.close()
      }
    })
  })
}
