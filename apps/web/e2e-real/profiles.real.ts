// Front-end kinds, devices and profiles against the real assistant (docs/FRONTENDS-AND-ACTIVATION.md §2, §5): the
// voice page's device in admin › Devices, a kind default and a device override reaching the open voice page live,
// and the voice sheet's own fields (activation, follow-up) showing in admin. A device has no voice of its own any more
// (docs/VOICE-PROVIDERS.md §1): the sheet offers none and admin's device form shows none.
import type { Page } from "@playwright/test"
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
  saveLog,
  silence,
  startAssistant,
  test,
  waitForMessage
} from "./fixtures.ts"

const missing = missingPrerequisite()
test.skip(missing !== undefined, missing)

const wav = missing === undefined ? micWav("silence", [silence(10_000)]) : ""
test.use({ launchOptions: { args: chromiumArgsFor(wav) } })

let assistant: Assistant
test.beforeAll(async () => {
  assistant = await startAssistant({ port: 8790, dataDir: join(here, "../test-results/real/data-profiles") })
})
test.afterAll(async () => {
  await assistant?.stop()
})

const save = (page: Page) => page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true })
const saved = (page: Page) => expect(page.getByTestId("footer-note")).toContainText("Saved")
const deviceId = (page: Page) => page.evaluate(() => localStorage.getItem("pva.deviceId"))
const lastProfile = async (page: Page) =>
  ((await messages(page)).filter((m) => m.dir === "in" && m.msg.type === "device.profile").at(-1)?.msg as { profile: Record<string, unknown> } | undefined)?.profile

test("the voice page's device in Devices; a kind default and a device override reach the open voice page live", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 800 } })
  const voice = await ctx.newPage()
  const admin = await ctx.newPage()
  await instrument(voice, " voice")
  await instrument(admin, " admin")
  try {
    await voice.goto(assistant.url)
    await voice.getByTestId("start").click()
    await expectVisualState(voice, "listening")
    await expect(voice.getByTestId("captions")).toHaveCount(1)
    const id = await deviceId(voice)
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)

    // Devices: this browser, connected, talking now (it owns its session's audio), always listening.
    await loginAdmin(admin, assistant.url, "#settings/devices")
    const row = admin.getByTestId("device-list").locator(`[data-device="${id}"]`)
    await expect(row).toContainText("Chrome")
    await expect(row).toContainText("Connected now")
    await expect(row.getByTestId("talking-now")).toHaveText("Talking now")
    await expect(row).toContainText("Always listening")
    await expect(admin.getByTestId("assistant-line")).toContainText(/listening/i)
    // One browser, two tabs: each has its own client id; the admin tab never took the audio from the voice tab.
    const hello = async (p: Page) => (await messages(p)).find((m) => m.dir === "out" && m.msg.type === "hello")!.msg
    expect((await hello(admin)).clientId).not.toBe((await hello(voice)).clientId)
    expect((await hello(admin)).frontend).toBe("admin")
    expect((await messages(admin)).some((m) => m.dir === "out" && String(m.msg.type).startsWith("audio."))).toBe(false)
    await expect(voice.getByTestId("stage")).toHaveAttribute("data-visual-state", "listening")

    // A kind default (Front ends › Voice assistant in a browser): captions off reaches the voice page at once.
    await admin.getByTestId("nav-frontends").click()
    const kind = admin.getByTestId("profile-frontend-web-voice")
    await kind.locator("[data-field=captions]").getByRole("switch").click()
    await save(admin).click()
    await saved(admin)
    await expect(voice.getByTestId("captions")).toHaveCount(0)
    expect((await lastProfile(voice))?.captions).toBe(false)

    // A device override on top: captions back on for this device only; the device page marks it, the list counts it.
    await admin.goto(`${assistant.url}/admin/#settings/devices/${id}`)
    const form = admin.getByTestId(`profile-device-${id}`)
    await expect(form.locator("[data-field=captions]").getByTestId("inherited")).toHaveText("Default (Off)")
    await form.locator("[data-field=captions]").getByRole("switch").click()
    await save(admin).click()
    await saved(admin)
    await expect(form.locator("[data-field=captions]")).toHaveAttribute("data-overridden", "true")
    await expect(voice.getByTestId("captions")).toHaveCount(1)

    // Wake phrase for this device, from admin: the voice page goes asleep live and says the phrase.
    await form.getByRole("radio", { name: "Wake phrase" }).click()
    await save(admin).click()
    await saved(admin)
    await expectVisualState(voice, "asleep")
    await expect(voice.getByTestId("state-label")).toHaveText("Say “Hey Jeff”")

    // Reset both overrides (sent as null): back to the kind's defaults on the voice page.
    await form.locator("[data-field=activation]").getByTestId("reset").click()
    await form.locator("[data-field=captions]").getByTestId("reset").click()
    await save(admin).click()
    await saved(admin)
    await expectVisualState(voice, "listening")
    await expect(voice.getByTestId("captions")).toHaveCount(0)
    const updates = (await messages(admin)).filter((m) => m.dir === "out" && m.msg.type === "device.admin.update").map((m) => m.msg.patch)
    expect(updates).toEqual([{ captions: true }, { activation: "wake-phrase" }, { activation: null, captions: null }])
    expect(await alerts(voice)).toEqual([])
    expect(await alerts(admin)).toEqual([])
  } finally {
    await saveLog(voice, testInfo.outputPath("socket-log-voice.json"))
    await saveLog(admin, testInfo.outputPath("socket-log-admin.json"))
    await ctx.close()
  }
})

test("the voice sheet changes activation and follow-up; admin shows them as the device's own; no voice of its own", async ({ browser }, testInfo) => {
  const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 800 } })
  const voice = await ctx.newPage()
  const admin = await ctx.newPage()
  await instrument(voice, " voice")
  await instrument(admin, " admin")
  try {
    await voice.goto(assistant.url)
    await voice.getByTestId("start").click()
    await expectVisualState(voice, "listening")
    const id = await deviceId(voice)
    await loginAdmin(admin, assistant.url, `#settings/devices/${id}`)
    const form = admin.getByTestId(`profile-device-${id}`)
    await expect(form.locator("[data-field=voice]")).toHaveCount(0)

    await voice.getByTestId("settings-toggle").click()
    const sheet = voice.getByTestId("voice-sheet")
    await expect(sheet.getByTestId("voice-choices")).toHaveCount(0)
    await sheet.getByRole("radio", { name: "Wake phrase" }).click()
    await expect(sheet.getByTestId("wake-phrases")).toContainText("Hey Jeff")
    await sheet.getByLabel("Keep listening after a reply").selectOption("15")
    await expect.poll(async () => (await lastProfile(voice))?.followUpSeconds).toBe(15)
    const profile = (await lastProfile(voice))!
    expect(profile).toMatchObject({ voice: "", activation: "wake-phrase", followUpSeconds: 15 })
    await expectVisualState(voice, "asleep")

    // Admin's device page shows the two as overrides, live; the list says how it activates.
    for (const f of ["activation", "followUpSeconds"]) await expect(form.locator(`[data-field=${f}]`)).toHaveAttribute("data-overridden", "true")
    await expect(form.locator("[data-field=followUpSeconds]").getByRole("spinbutton")).toHaveValue("15")
    await admin.getByTestId("page-up").click()
    await expect(admin.getByTestId("device-list").locator(`[data-device="${id}"]`)).toContainText("Wake phrase")
    await expect(admin.getByTestId("device-list").locator(`[data-device="${id}"]`)).toContainText("2 own settings")

    // A typed message is answered in the assistant's one voice (its key).
    await voice.keyboard.press("Escape")
    await voice.getByTestId("chat-toggle").click()
    const from = (await messages(voice)).length
    await voice.locator("#chat-input").fill("Hello there.")
    await voice.locator("#chat-input").press("Enter")
    const end = await waitForMessage(voice, (m) => m.msg.type === "turn.end", { from, timeout: 30_000 })
    expect((end.msg as unknown as { trace: { voices: Array<string> } }).trace.voices).toEqual(["sherpa:en_US-lessac-medium"])
  } finally {
    await saveLog(voice, testInfo.outputPath("socket-log-voice.json"))
    await saveLog(admin, testInfo.outputPath("socket-log-admin.json"))
    await ctx.close()
  }
})
