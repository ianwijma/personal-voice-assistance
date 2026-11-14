// §6.3 step 5: the assistant dies in the middle of a reply and comes back.
import { join } from "node:path"
import {
  type Assistant,
  chromiumArgsFor,
  expect,
  expectVisualState,
  here,
  messages,
  micStats,
  micWav,
  missingPrerequisite,
  silence,
  startAssistant,
  test,
  waitForMessage
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

const wav = missing === undefined ? micWav("silence", [silence(10_000)]) : ""
test.use({ launchOptions: { args: chromiumArgsFor(wav) } })

const port = 8795
const dataDir = join(here, "../test-results/real/data-restart")
let assistant: Assistant | undefined
test.afterAll(async () => {
  await assistant?.stop()
})

const LONG = "Please read this back to me slowly, because it is a long sentence with several parts, and it should take a while to say out loud."

for (const signal of ["SIGKILL", "SIGINT"] as const) {
  test(`server stopped mid-reply (${signal}): the page shows reconnecting and flushes playback; after a restart the audio resumes without a new Start`, async ({ page }) => {
    assistant = await startAssistant({ port, dataDir })
    await page.goto(assistant.url)
    await page.getByTestId("start").click()
    await expectVisualState(page, "listening")
    await page.getByTestId("chat-toggle").click()
    await page.locator("#chat-input").fill(LONG)
    await page.locator("#chat-input").press("Enter")
    await waitForMessage(page, (m) => m.msg.type === "playback.started")
    await expectVisualState(page, "speaking")
    await page.waitForTimeout(500)

    await assistant.stop(signal)
    const deadAt = (await messages(page)).length
    await expectVisualState(page, "disconnected", 5000)
    await expect(page.getByTestId("state-label")).toContainText(/reconnecting/i)
    // The player was flushed (not playing audio the server will never count), and nothing went out on the dead socket.
    const playing = await page.evaluate(() => (window as unknown as { __pva: { store: { get: () => { audio: { playing?: unknown; phase: string } } } } }).__pva.store.get().audio)
    expect(playing.playing).toBeUndefined()
    expect(playing.phase).not.toBe("off") // the microphone and AudioContext stay open for the reconnect
    const framesWhileDown = (await micStats(page)).frames
    await page.waitForTimeout(1500)
    expect((await micStats(page)).frames - framesWhileDown).toBeLessThan(3)

    // Back up (same data directory): the page reconnects and owns the audio again by itself.
    assistant = await startAssistant({ port, dataDir, fresh: false })
    const welcome = await waitForMessage(page, (m) => m.msg.type === "welcome", { from: deadAt, timeout: 15_000 })
    const hello = (await messages(page)).slice(deadAt).find((m) => m.msg.type === "hello")!
    expect(hello.msg.resumeOwner).toBe(true)
    void welcome
    await waitForMessage(page, (m) => m.msg.type === "session" && m.msg.role === "owner", { from: deadAt, timeout: 5000 })
    await expectVisualState(page, "listening")
    await expect(page.getByTestId("mic-toggle")).toBeVisible()
    // It works: a typed message is answered and played.
    const from = (await messages(page)).length
    await page.locator("#chat-input").fill("Are you back?")
    await page.locator("#chat-input").press("Enter")
    await waitForMessage(page, (m) => m.msg.type === "playback.finished", { from })
    // The microphone sequence restarted at 0 after the reconnect, with audio.config and mic.state first.
    const after = (await messages(page)).slice(deadAt)
    const types = after.filter((m) => m.dir === "out").map((m) => m.msg.type)
    expect(types.indexOf("audio.config")).toBeGreaterThan(types.indexOf("hello"))
    expect(after.some((m) => m.msg.type === "error")).toBe(false)
    await assistant.stop()
    assistant = undefined
  })
}
