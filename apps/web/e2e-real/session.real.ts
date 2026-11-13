// §6.3: a typed message with a spoken reply, two pages with takeover (also in the
// middle of a reply), and modules changed from the options drawer, against the
// real assistant. The fake microphone is silent (a −75 dBFS noise floor).
import { join } from "node:path"
import type { Page } from "@playwright/test"
import {
  type Assistant,
  chromiumArgsFor,
  expect,
  expectVisualState,
  here,
  instrument,
  messages,
  micStats,
  micWav,
  missingPrerequisite,
  saveLog,
  serverHistory,
  silence,
  startAssistant,
  test,
  visualHistory,
  waitForMessage
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

const wav = missing === undefined ? micWav("silence", [silence(10_000)]) : ""
test.use({ launchOptions: { args: chromiumArgsFor(wav) } })

let assistant: Assistant
test.beforeAll(async () => {
  assistant = await startAssistant({ port: 8794, dataDir: join(here, "../test-results/real/data-session") })
})
test.afterAll(async () => {
  await assistant?.stop()
})

const LONG = "Please read this back to me slowly, because it is a long sentence with several parts, and it should take a while to say out loud, long enough to interrupt it."

const type = async (page: Page, text: string) => {
  if (!(await page.locator("#chat-input").isVisible())) await page.getByTestId("chat-toggle").click()
  await page.locator("#chat-input").fill(text)
  await page.locator("#chat-input").press("Enter")
}

test("a typed message gets a spoken reply, shown in the chat", async ({ page }) => {
  await page.goto(assistant.url)
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await page.getByTestId("chat-toggle").click()
  const before = (await messages(page)).length
  await type(page, "Give me one fun fact about octopuses.")
  const end = await waitForMessage(page, (m) => m.msg.type === "turn.end", { from: before })
  expect(end.msg.outcome).toBe("completed")
  const log = (await messages(page)).slice(before)
  const send = log.find((m) => m.msg.type === "text.send")!.msg
  expect(send).toMatchObject({ speak: true })
  expect(log.find((m) => m.msg.type === "result" && m.msg.requestId === send.requestId)!.msg.ok).toBe(true)
  expect(log.find((m) => m.msg.type === "turn.start")!.msg).toMatchObject({ source: "text", spoken: true })
  expect(log.some((m) => m.msg.type === "playback.started")).toBe(true)
  expect(log.some((m) => m.msg.type === "playback.finished")).toBe(true)
  const turn = page.getByTestId("turn").last()
  await expect(turn).toContainText("Give me one fun fact about octopuses.")
  await expect(turn.getByTestId("assistant-message")).toContainText("You said: Give me one fun fact about octopuses.")
  await expect(turn.locator("[data-played]")).toHaveCount(2)
  await expectVisualState(page, "listening")
})

test("Stop: the page stops at once, sends interrupt then playback.stopped, answers reply.stop with the same count; no stall error", async ({ page }) => {
  await page.goto(assistant.url)
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  const from = (await messages(page)).length
  await type(page, LONG)
  await waitForMessage(page, (m) => m.msg.type === "playback.started", { from })
  await page.waitForTimeout(700)
  await page.getByTestId("stop").click()
  const end = await waitForMessage(page, (m) => m.msg.type === "turn.end", { from })
  expect(end.msg.outcome).toBe("interrupted")
  await expectVisualState(page, "listening")
  await page.waitForTimeout(2500) // longer than the server's 2 s stall timer
  const log = (await messages(page)).slice(from)
  const interrupt = log.find((m) => m.msg.type === "interrupt")!
  const stopped = log.filter((m) => m.msg.type === "playback.stopped")
  const replyStop = log.find((m) => m.msg.type === "reply.stop")
  expect(interrupt.msg.turnId).toBe(end.msg.turnId)
  expect(stopped.length).toBeGreaterThanOrEqual(1)
  expect(stopped[0]!.at).toBeGreaterThanOrEqual(interrupt.at)
  expect(stopped[0]!.at - interrupt.at).toBeLessThan(50)
  // The server's own reply.stop is answered again with the same count if the player is already idle; if it
  // arrives during the 4 ms fade (the headless device renders in ~10 ms blocks), the one report covers both.
  expect(replyStop).toBeDefined()
  expect(stopped.length).toBeLessThanOrEqual(2)
  expect(new Set(stopped.map((m) => m.msg.playedSamples)).size).toBe(1)
  // speaking → listening, with no flash of "thinking" between the stop and the end of the turn.
  const states = await visualHistory(page)
  expect(states.slice(states.lastIndexOf("speaking")), states.join(" → ")).toEqual(["speaking", "listening"])
  // The turn ended well inside the server's 300 ms wait, and no stall or other error followed.
  expect(end.at - interrupt.at).toBeLessThan(300)
  expect(log.filter((m) => m.msg.type === "error").map((m) => JSON.stringify(m.msg))).toEqual([])
  expect(log.some((m) => m.msg.type === "playback.finished")).toBe(false)
  const history = await serverHistory(assistant.url)
  expect(history.at(-1)).toMatchObject({ role: "assistant", interrupted: true })
  expect(history.at(-1)!.text.length).toBeLessThan(LONG.length)
  expect(history.at(-1)!.text.length).toBeGreaterThan(0)
})

test("two pages: the second observes, takes the audio mid-reply, and the first becomes an observer with its audio closed", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 800 } })
  const a = await ctx.newPage()
  const b = await ctx.newPage()
  await instrument(a, " A")
  await instrument(b, " B")
  try {
    await a.goto(assistant.url)
    await a.getByTestId("start").click()
    await expectVisualState(a, "listening")
    await b.goto(assistant.url)
    await expect(b.getByTestId("observer-banner")).toBeVisible()
    await expect(b.getByTestId("mic-toggle")).toBeHidden()
    await expectVisualState(b, "listening") // an observer mirrors the server's state

    // A long typed reply; while A plays it, B takes the audio.
    await a.getByTestId("chat-toggle").click()
    await type(a, LONG)
    await expectVisualState(a, "speaking")
    await a.waitForTimeout(800)
    const framesBefore = (await micStats(a)).frames
    const bFrom = (await messages(b)).length
    await b.getByRole("button", { name: /Use this tab/i }).click()

    await expect(a.getByTestId("observer-banner")).toBeVisible()
    await expect(b.getByTestId("mic-toggle")).toBeVisible()
    await expect(b.getByTestId("observer-banner")).toBeHidden()
    await expectVisualState(b, "listening")

    // A: reply.stop, then session observer/taken_over; its microphone stops sending.
    const aLog = await messages(a)
    const stopAt = aLog.findIndex((m) => m.msg.type === "reply.stop")
    const sessionAt = aLog.findIndex((m) => m.msg.type === "session" && m.msg.reason === "taken_over")
    expect(stopAt).toBeGreaterThan(-1)
    expect(sessionAt).toBeGreaterThan(stopAt)
    await a.waitForTimeout(500)
    const framesAfter = (await micStats(a)).frames
    await a.waitForTimeout(1000)
    expect((await micStats(a)).frames).toBe(framesAfter) // nothing more from A
    expect(framesAfter - framesBefore).toBeLessThan(80)

    // B: the interrupted turn ended (in whichever order turn.end and its own session arrived).
    const bLog = (await messages(b)).slice(bFrom)
    const end = bLog.find((m) => m.msg.type === "turn.end")!
    expect(["interrupted", "failed"]).toContain(end.msg.outcome)
    expect(bLog.some((m) => m.msg.type === "session" && m.msg.role === "owner" && m.msg.reason === "claimed")).toBe(true)
    await b.getByTestId("chat-toggle").click()
    await expect(b.locator(`[data-testid=turn][data-turn-id='${end.msg.turnId as number}']`)).toHaveAttribute("data-outcome", /interrupted|failed/)
    // No turn is left "running" in either page.
    await expect(a.locator("[data-testid=turn][data-outcome=running]")).toHaveCount(0)
    await expect(b.locator("[data-testid=turn][data-outcome=running]")).toHaveCount(0)
    // History holds only the part that A played.
    const history = await serverHistory(assistant.url)
    const reply = history.at(-1)!
    expect(reply.role).toBe("assistant")
    expect(reply.text.length).toBeLessThan(LONG.length)

    // B speaks now: a typed message plays in B.
    const bFrom2 = (await messages(b)).length
    await type(b, "Hello again.")
    await waitForMessage(b, (m) => m.msg.type === "playback.finished", { from: bFrom2 })
    expect((await messages(a)).some((m) => m.msg.type.startsWith("playback.") && m.at > 0 && m.msg.turnId === (end.msg.turnId as number) + 1)).toBe(false)
    await expect(a.getByTestId("turn").last()).toContainText("Hello again.") // A still sees the conversation
  } finally {
    await saveLog(a, testInfo.outputPath("socket-log-a.json"))
    await saveLog(b, testInfo.outputPath("socket-log-b.json"))
    await ctx.close()
  }
})

test("modules from the options drawer: a rejected value, reconfigure and disable, seen in a second page and used on the next turn", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 800 } })
  const a = await ctx.newPage()
  const b = await ctx.newPage()
  await instrument(a, " A")
  await instrument(b, " B")
  try {
    await a.goto(assistant.url)
    await b.goto(assistant.url)
    await a.getByTestId("chat-toggle").click()
    await b.getByTestId("chat-toggle").click()

    // Before: the time question goes through the clock's current_time tool, date in en-GB.
    let from = (await messages(a)).length
    await type(a, "What time is it?")
    let end = await waitForMessage(a, (m) => m.msg.type === "turn.end", { from })
    let log = (await messages(a)).slice(from)
    expect(log.some((m) => m.msg.type === "tool.start" && m.msg.tool === "current_time")).toBe(true)
    const gb = log.filter((m) => m.msg.type === "assistant.text").map((m) => m.msg.text).join("")
    expect(gb).toMatch(/\d{1,2} [A-Z][a-z]+ \d{4}/) // "13 November 2026"
    expect(end.msg.outcome).toBe("completed")

    await a.keyboard.press("Escape")
    await a.getByRole("button", { name: "Options (O)" }).click()
    await expect(a.getByTestId("options")).toBeVisible()
    const card = a.getByTestId("module-clock")
    await expect(card).toHaveAttribute("data-state", "running")
    await card.getByRole("button", { name: /Clock/ }).click()
    const form = card.getByTestId("form-m-clock")

    // A value the server rejects: shown under its field, nothing saved.
    await form.getByLabel("Time zone").fill("Mars/Olympus_Mons")
    await form.getByRole("button", { name: "Save" }).click()
    await expect(form.locator("[data-field=timeZone]")).toContainText("Unknown time zone")
    await expect(form.getByLabel("Time zone")).toHaveAttribute("aria-invalid", "true")

    // A valid change: zone and date format.
    await form.getByLabel("Time zone").fill("Asia/Tokyo")
    await form.getByRole("radio", { name: "November 13, 2026" }).click()
    await form.getByRole("button", { name: "Save" }).click()
    await expect(form.getByText("Saved")).toBeVisible()

    // The second page shows the change.
    await b.keyboard.press("Escape")
    await b.getByRole("button", { name: "Options (O)" }).click()
    const cardB = b.getByTestId("module-clock")
    await cardB.getByRole("button", { name: /Clock/ }).click()
    await expect(cardB.getByTestId("form-m-clock").getByLabel("Time zone")).toHaveValue("Asia/Tokyo")
    await expect(cardB.getByTestId("form-m-clock").getByRole("radio", { name: "November 13, 2026" })).toHaveAttribute("aria-checked", "true")

    // The next turn uses it: the date in en-US.
    await a.keyboard.press("Escape")
    from = (await messages(a)).length
    await type(a, "What time is it?")
    end = await waitForMessage(a, (m) => m.msg.type === "turn.end", { from })
    log = (await messages(a)).slice(from)
    const us = log.filter((m) => m.msg.type === "assistant.text").map((m) => m.msg.text).join("")
    expect(us).toMatch(/[A-Z][a-z]+ \d{1,2}, \d{4}/) // "November 13, 2026"

    // Disable the clock (from page B): page A sees it, and the time question is no longer a tool call.
    // The server keeps the old instance 10 s ("stopping", out of the snapshot already); the card shows it as off.
    await cardB.getByRole("switch").first().click()
    await expect(cardB).toHaveAttribute("data-state", /stopping|disabled/)
    await expect(cardB.getByRole("switch").first()).toHaveAttribute("aria-checked", "false")
    await expect(cardB.getByRole("switch").first()).not.toHaveAttribute("aria-busy", "true")
    await expect(cardB).not.toContainText(/stopping/i)
    await a.getByRole("button", { name: "Options (O)" }).click()
    await expect(a.getByTestId("module-clock")).toHaveAttribute("data-state", /stopping|disabled/)
    await a.keyboard.press("Escape")
    from = (await messages(a)).length
    await type(a, "What time is it?")
    end = await waitForMessage(a, (m) => m.msg.type === "turn.end", { from })
    log = (await messages(a)).slice(from)
    expect(log.some((m) => m.msg.type === "tool.start")).toBe(false)
    expect(log.filter((m) => m.msg.type === "assistant.text").map((m) => m.msg.text).join("")).toMatch(/You said: What time is it\?/)
    await expect(a.getByTestId("turn").last().getByTestId("tool-chip")).toHaveCount(0)

    // Enable it again: back to the tool.
    await cardB.getByRole("switch").first().click()
    await expect(cardB).toHaveAttribute("data-state", "running")
    from = (await messages(a)).length
    await type(a, "What time is it?")
    await waitForMessage(a, (m) => m.msg.type === "turn.end", { from })
    log = (await messages(a)).slice(from)
    expect(log.some((m) => m.msg.type === "tool.start" && m.msg.tool === "current_time")).toBe(true)
  } finally {
    await saveLog(a, testInfo.outputPath("socket-log-a.json"))
    await saveLog(b, testInfo.outputPath("socket-log-b.json"))
    await ctx.close()
  }
})
