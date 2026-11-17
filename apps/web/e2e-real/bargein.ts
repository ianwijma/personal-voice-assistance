// §6.3 step 3: barge-in over a playing reply, in `instant` and in `confirm` mode.
// The fake microphone asks for an octopus fact, waits until the reply is playing,
// then says "Hello, can you hear me?". The headless browser cannot hear its own
// output, so this tests the interruption logic and history, not echo handling.
import { join } from "node:path"
import {
  type Assistant,
  chromiumArgsFor,
  expect,
  expectVisualState,
  here,
  messages,
  micWav,
  missingPrerequisite,
  question,
  serverHistory,
  setDeviceDefaults,
  silence,
  startAssistant,
  test,
  turnEnds,
  waitForMessage
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

/** One file per mode (Chromium's fake microphone file is fixed per browser launch). */
export const bargeIn = (mode: "instant" | "confirm", gapMs: number, port: number) => {
  const wav = missing === undefined ? micWav(`barge-in-${gapMs}`, [silence(1500), question(3), silence(gapMs), question(1), silence(15_000)]) : ""
  test.use({ launchOptions: { args: chromiumArgsFor(wav) } })
  let assistant: Assistant
  test.beforeAll(async () => {
    assistant = await startAssistant({ port, dataDir: join(here, `../test-results/real/data-bargein-${mode}`) })
  })
  test.afterAll(async () => {
    await assistant?.stop()
  })
  {

    test(`speaking over the reply interrupts it (${mode}); history keeps only what played; the new question is answered`, async ({ page }) => {
      // The interrupt mode is a device setting (here: the web-voice defaults, set in admin).
      await setDeviceDefaults(assistant.url, { interruptMode: mode })
      await page.goto(assistant.url)
      await page.getByTestId("start").click()
      await expectVisualState(page, "listening")
      const welcome = await waitForMessage(page, (m) => m.msg.type === "welcome")
      expect((welcome.msg as unknown as { snapshot: { setup: { interruptMode: string } } }).snapshot.setup.interruptMode).toBe(mode)
      const claim = await waitForMessage(page, (m) => m.msg.type === "audio.claim")
      expect(claim.msg.interruptMode).toBeUndefined()

      await waitForMessage(page, (m) => m.msg.type === "turn.end" && m.msg.turnId === 2, { timeout: 40_000 })
      const ends = await turnEnds(page)
      const first = ends.find((e) => e.turnId === 1)!
      const second = ends.find((e) => e.turnId === 2)!
      expect(first.outcome).toBe("interrupted")
      expect(second.outcome).toBe("completed")

      const log = await messages(page)
      const starts = log.filter((m) => m.msg.type === "turn.start").map((m) => m.msg as unknown as { turnId: number; userText: string })
      expect(starts[0]!.userText).toMatch(/octop/i)
      expect(starts[1]!.userText).toMatch(/hello.*hear/i)
      // The browser stopped: reply.stop for turn 1, answered with playback.stopped (never finished).
      const stop = log.find((m) => m.msg.type === "reply.stop" && m.msg.turnId === 1)
      expect(stop).toBeDefined()
      const stopped = log.filter((m) => m.msg.type === "playback.stopped" && m.msg.turnId === 1)
      expect(stopped.length).toBeGreaterThanOrEqual(1)
      expect(log.some((m) => m.msg.type === "playback.finished" && m.msg.turnId === 1)).toBe(false)
      expect(stopped[0]!.at - stop!.at).toBeLessThan(100)
      expect(log.some((m) => m.msg.type === "error")).toBe(false)

      // History: the interrupted reply holds exactly the clauses that had started playing.
      const clauses = log.filter((m) => m.msg.type === "assistant.text" && m.msg.turnId === 1).map((m) => m.msg as unknown as { clause: number; text: string })
      const playedUpTo = Math.max(...log.filter((m) => m.msg.type === "assistant.playing" && m.msg.turnId === 1).map((m) => m.msg.clause as number))
      const heard = clauses.filter((c) => c.clause <= playedUpTo).map((c) => c.text).join(" ")
      const history = await serverHistory(assistant.url, page)
      const reply1 = history[1]!
      expect(history[0]).toMatchObject({ role: "user" })
      expect(reply1).toMatchObject({ role: "assistant", interrupted: true })
      expect(reply1.text.replace(/\s+/g, " ").trim()).toBe(heard.replace(/\s+/g, " ").trim())
      // Instant mode cuts during the first clause, so history drops the second one. Confirm mode waits
      // for two words (~0.6 s), which lands in the second clause here: both clauses started, but the
      // reply was still cut short of its end.
      if (mode === "instant") expect(playedUpTo).toBeLessThan(clauses.length - 1)
      const turn2Played = (log.find((m) => m.msg.type === "playback.finished" && m.msg.turnId === 2)!.msg.playedSamples as number)
      expect(stopped[0]!.msg.playedSamples as number).toBeLessThan(turn2Played * 1.2) // turn 1's full reply is ~1.4× turn 2's
      expect(history[3]).toMatchObject({ role: "assistant", interrupted: false })

      // The chat shows the cut reply as interrupted, with only the played clauses marked.
      await page.getByTestId("chat-toggle").click()
      const turn1 = page.locator("[data-testid=turn][data-turn-id='1']")
      await expect(turn1).toHaveAttribute("data-outcome", "interrupted")
      await expect(turn1.getByTestId("interrupted-tag")).toBeVisible()
      await expect(turn1.locator("[data-played]")).toHaveCount(playedUpTo + 1)
    })
  }
}

