import { type Page } from "@playwright/test"
import { appUrl, deviceIdOf, expect, expectVisualState, loginAdmin, MOCK, mock, test } from "./fixtures.ts"

// Admin › Devices (docs/ASSISTANTS.md §2.3, §7.1, mock-up `pDevices`/`pDevice`): the list by type with its defaults first,
// a device page whose sections follow the type's defaults until they have their own value (Own value · Reset), the ordered
// assistant list with phrases, "Answers without a phrase", the hearer mark, the unreachable warning, rename and forget, and
// the defaults page ("Every browser"). Mock data: the type's defaults list Jeff (answers without a phrase) and T3 ("Hey T3",
// "Hey tee three"); the Kitchen iPad has its own list (Jeff "Hey Jeff", Keuken "Hé keuken" and "Hey keuken", follow-up 15 s)
// and its own captions; the Android phone follows the defaults.

const KITCHEN = "d-kitchen-ipad-0001"
const PHONE = "d-pixel-phone-0002"
const saves = async () => (await mock.log()).messages.filter((m) => m.type === "device.save") as unknown as Array<{ target: Record<string, string>; rev: number; name?: string; saveAnyway?: boolean; settings: Record<string, any> }>
const row = (page: Page, id: string) => page.locator(`[data-assignment=${id}]`)
const save = (page: Page) => page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true })
const marks = (page: Page, section: string) => page.getByTestId(`marks-${section}`)
const addPhrase = async (page: Page, id: string, text: string) => {
  await row(page, id).getByTestId("phrase-input").fill(text)
  await row(page, id).getByTestId("phrase-add").click()
}

test.beforeEach(async () => {
  await mock.scenario("devices")
})

test("the list: each type with its defaults first, who answers on each device and how; a voice page appears when it connects", async ({ page, baseURL, context }) => {
  await loginAdmin(page, baseURL, "#settings/devices")
  const list = page.getByTestId("device-list")
  await expect(page.getByTestId("type-count")).toHaveText("2 browsers")
  const defaults = list.locator("[data-device='type:web-voice']")
  await expect(defaults).toContainText("Every browser")
  await expect(defaults.getByTestId("defaults-chip")).toBeVisible()
  await expect(defaults).toContainText("Jeff · without a phrase")
  await expect(defaults).toContainText("T3 · “Hey T3” +1")
  await expect(defaults).toContainText("Applies to 2 browsers · Each follows it unless it has its own value")
  const kitchen = list.locator(`[data-device=${KITCHEN}]`)
  await expect(kitchen).toContainText("Keuken · “Hé keuken” +1")
  await expect(kitchen.getByTestId("device-meta")).toHaveText("2 own settings · Seen 2 h ago")
  await expect(list.locator(`[data-device=${PHONE}]`).getByTestId("device-meta")).toHaveText("Follows the defaults · Seen 3 days ago")
  // Defaults come first in the list.
  expect(await list.locator("[data-device]").evaluateAll((els) => els.map((e) => e.getAttribute("data-device")))).toEqual(["type:web-voice", KITCHEN, PHONE])

  const voice = await context.newPage()
  await voice.goto(appUrl(baseURL))
  await voice.getByTestId("start").click()
  await expect(list.locator("[data-device]")).toHaveCount(4)
  const mine = list.locator(`[data-device=${await deviceIdOf(voice)}]`)
  await expect(mine.getByTestId("talking-now")).toHaveText("Talking now")
  await expect(mine.getByTestId("session-state")).toHaveText("listening")
  await voice.close()
})

test("no devices yet: the type is listed with its defaults and says how a device appears", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await loginAdmin(page, baseURL, "#settings/devices")
  await expect(page.getByTestId("no-devices")).toContainText("No devices yet.")
  await expect(page.locator("[data-device='type:web-voice']")).toBeVisible()
})

test("a section follows the defaults until it has its own value: Own value · Reset, saved as a value and as null", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${PHONE}`)
  await expect(page.getByTestId("own-legend")).toHaveText("Own value: set for this device only. Reset returns to Every browser.")
  await expect(marks(page, "Interrupting").getByTestId("follows-marker")).toHaveText("Follows Every browser")
  await expect(marks(page, "Assistants here").getByTestId("follows-marker")).toBeVisible()
  await page.getByTestId("group-interrupting").locator("summary").click()
  await page.getByTestId("seg-interrupt").getByRole("radio", { name: /Stop button only/ }).click()
  await expect(marks(page, "Interrupting").getByTestId("unsaved-marker")).toBeVisible()
  await expect(marks(page, "Interrupting").getByTestId("own-marker")).toHaveText("Own value")
  // The other sections still follow.
  await expect(marks(page, "Audio").getByTestId("follows-marker")).toBeVisible()
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  expect((await saves()).at(-1)).toMatchObject({ target: { kind: "device", id: PHONE }, settings: { interruptMode: "manual" } })
  expect(Object.keys((await saves()).at(-1)!.settings)).toEqual(["interruptMode"])
  await expect(marks(page, "Interrupting").getByTestId("unsaved-marker")).toHaveCount(0)
  await expect(marks(page, "Interrupting").getByTestId("own-marker")).toBeVisible()
  await expect(page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  // Reset goes back to the defaults: sent as null.
  await marks(page, "Interrupting").getByTestId("reset").click()
  await expect(marks(page, "Interrupting").getByTestId("follows-marker")).toBeVisible()
  await expect(marks(page, "Interrupting").getByTestId("unsaved-marker")).toBeVisible()
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  expect((await saves()).at(-1)!.settings).toEqual({ interruptMode: null })
  // The device list agrees: it follows the defaults again.
  await page.getByTestId("page-up").click()
  await expect(page.locator(`[data-device=${PHONE}]`).getByTestId("device-meta")).toContainText("Follows the defaults")
})

test("Kitchen iPad: own list and own captions; Reset on the list goes back to the type's list", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
  await expect(marks(page, "Assistants here").getByTestId("own-marker")).toBeVisible()
  await expect(marks(page, "Captions").getByTestId("own-marker")).toBeVisible()
  await expect(marks(page, "Phrases").getByTestId("follows-marker")).toBeVisible()
  await expect(row(page, "jeff")).toBeVisible()
  await expect(row(page, "keuken").getByTestId("fu-marks")).toContainText("Own value")
  await marks(page, "Assistants here").getByTestId("reset").click()
  await expect(row(page, "t3")).toBeVisible()
  await expect(row(page, "keuken")).toHaveCount(0)
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  expect((await saves()).at(-1)!.settings).toEqual({ assistants: null })
})

test("order: moving an assistant changes who the device hears with; the notice says what is not used", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
  // Jeff answers without a phrase here, so Jeff's recogniser is the device's; Keuken's (Dutch) is not used.
  await expect(row(page, "jeff").getByTestId("mark-hears")).toBeVisible()
  await expect(row(page, "keuken").getByTestId("mark-hears")).toHaveCount(0)
  await expect(page.getByTestId("hearer-notice")).toContainText("Kitchen iPad hears with Jeff’s recogniser")
  await expect(page.getByTestId("hearer-notice")).toContainText("Keuken is set to")
  // Nobody answers without a phrase: the first in the list is the hearer; move Keuken up.
  await page.getByTestId("without-phrase").selectOption("")
  await expect(row(page, "jeff").getByTestId("mark-hears")).toBeVisible() // still first
  await row(page, "keuken").getByTestId("move-up").click()
  await expect(row(page, "keuken").getByTestId("mark-hears")).toBeVisible()
  await expect(row(page, "jeff").getByTestId("mark-hears")).toHaveCount(0)
  expect(await page.getByTestId("assignments").locator("[data-assignment]").evaluateAll((els) => els.map((e) => e.getAttribute("data-assignment")))).toEqual(["keuken", "jeff"])
  await expect(page.getByTestId("hearer-notice")).toContainText("Kitchen iPad hears with Keuken’s recogniser")
  await expect(page.getByTestId("hearer-notice")).toContainText("Jeff is set to")
  // Letting Jeff answer without a phrase makes it the hearer again, wherever it is in the list.
  await page.getByTestId("without-phrase").selectOption("jeff")
  await expect(row(page, "jeff").getByTestId("mark-hears")).toBeVisible()
  await expect(row(page, "jeff").getByTestId("mark-without-phrase")).toBeVisible()
  await expect(row(page, "keuken").getByTestId("move-up")).toBeDisabled()
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  const last = (await saves()).at(-1)!
  expect(last.settings.assistants.map((a: { assistant: string }) => a.assistant)).toEqual(["keuken", "jeff"])
  // Jeff answering without a phrase is what the type says: that part stays following it.
  expect(last.settings.withoutPhrase).toBeUndefined()
})

test("add and remove an assistant and its phrases; a duplicate phrase is refused on the field; the follow-up can be overridden", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
  // A phrase already used on this device, by this assistant or another, is refused where it was typed.
  await addPhrase(page, "keuken", "hey, keuken!")
  await expect(row(page, "keuken").getByTestId("phrase-error")).toContainText("already a phrase of Keuken")
  await addPhrase(page, "keuken", "Hey Jeff")
  await expect(row(page, "keuken").getByTestId("phrase-error")).toContainText("already a phrase of Jeff on this device")
  await expect(row(page, "jeff").getByTestId("phrase-error")).toHaveCount(0)
  await expect(page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true })).toBeDisabled() // nothing was added
  await addPhrase(page, "keuken", "one two three four five six seven")
  await expect(row(page, "keuken").getByTestId("phrase-error")).toHaveText("Use at most 6 words.")
  // A new phrase, then take one away.
  await addPhrase(page, "keuken", "Ok kitchen")
  await expect(row(page, "keuken").locator("[data-phrase='Ok kitchen']")).toBeVisible()
  await row(page, "keuken").getByRole("button", { name: "Remove “Hé keuken”" }).click()
  // Add T3 (not on this device) and give it a phrase, then remove Jeff.
  await page.getByLabel("Assistant to add").selectOption("t3")
  await page.getByTestId("add-assistant").click()
  await expect(row(page, "t3")).toBeVisible()
  await addPhrase(page, "t3", "hey tee three")
  await expect(row(page, "t3").locator("[data-phrase='hey tee three']")).toBeVisible()
  // Follow-up override per assignment: own value, then Reset.
  await expect(row(page, "t3").getByTestId("fu-marks")).toContainText("Follows T3: 30 seconds")
  await page.getByLabel("Keep listening after a reply for T3").selectOption("5")
  await expect(row(page, "t3").getByTestId("fu-marks")).toContainText("Own value")
  await row(page, "t3").getByTestId("fu-reset").click()
  await expect(row(page, "t3").getByTestId("fu-marks")).toContainText("Follows T3: 30 seconds")
  await row(page, "t3").getByLabel("Keep listening after a reply for T3").selectOption("15")
  await row(page, "jeff").getByTestId("remove-assistant").click()
  await expect(row(page, "jeff")).toHaveCount(0)
  // Jeff answered without a phrase: that goes with it.
  await expect(page.getByTestId("without-phrase")).toHaveValue("")
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  const last = (await saves()).at(-1)!
  expect(last.settings.assistants).toEqual([
    { assistant: "keuken", phrases: ["Hey keuken", "Ok kitchen"], followUpSeconds: 15 },
    { assistant: "t3", phrases: ["hey tee three"], followUpSeconds: 15 }
  ])
  expect(last.settings.withoutPhrase).toEqual({ mode: "nobody" })
})

test("an assistant that cannot be reached: the page says so, saving asks first, Go back keeps the draft, Save anyway sends saveAnyway", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${PHONE}`)
  await page.getByLabel("Assistant to add").selectOption("keuken")
  await page.getByTestId("add-assistant").click()
  await expect(row(page, "keuken").getByTestId("unreachable")).toHaveText("Cannot be reached on this device. Add a phrase, or let it answer without one.")
  await save(page).click()
  const dialog = page.getByTestId("warnings-dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("warnings-list")).toContainText(/keuken cannot be reached/i)
  await dialog.getByRole("button", { name: "Go back" }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, "keuken")).toBeVisible()
  expect((await saves()).map((m) => m.saveAnyway)).toEqual([undefined])
  await save(page).click()
  await page.getByTestId("warnings-dialog").getByRole("button", { name: "Save anyway" }).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  expect((await saves()).map((m) => m.saveAnyway)).toEqual([undefined, undefined, true])
  await expect(page.getByTestId("warnings-dialog")).toHaveCount(0)
})

test("answers without a phrase: nobody, one assistant; TypeSafe is shown but unavailable until it is set up", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
  const select = page.getByTestId("without-phrase")
  await expect(select).toHaveValue("jeff")
  await expect(page.getByTestId("typesafe-unavailable")).toContainText("Choosing whichever fits needs TypeSafe, which is not set up.")
  await expect(select.locator("option[value=typesafe]")).toBeDisabled()
  await expect(select.locator("option[value=typesafe]")).toHaveText("The one that fits: TypeSafe decides (not set up)")
  await select.selectOption("")
  await expect(page.getByText("Every assistant here waits for its phrase.")).toBeVisible()
  await select.selectOption("keuken")
  await expect(page.getByText("Keuken answers whatever is said, without a phrase.")).toBeVisible()
  await expect(row(page, "keuken").getByTestId("mark-without-phrase")).toBeVisible()
  await expect(row(page, "keuken").getByTestId("mark-hears")).toBeVisible()
  await expect(page.getByTestId("typesafe-box")).toHaveCount(0)
})

test("TypeSafe set up: choosing it shows the fallback and the give-up time (default 400 ms), Handles, and reaches the overview", async ({ page, baseURL }) => {
  await fetch(`${MOCK}/mock/typesafe`, { method: "POST", body: JSON.stringify({ on: true }) })
  await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
  const select = page.getByTestId("without-phrase")
  await expect(select.locator("option[value=typesafe]")).toBeEnabled()
  await expect(page.getByTestId("typesafe-unavailable")).toHaveCount(0)
  await select.selectOption("typesafe")
  const box = page.getByTestId("typesafe-box")
  await expect(box).toBeVisible()
  await expect(box.getByLabel("If none fits")).toHaveValue("jeff")
  await expect(box.getByLabel("Give up after")).toHaveValue("400")
  await expect(row(page, "jeff")).toContainText("Handles: General questions")
  await expect(row(page, "keuken").getByTestId("mark-without-phrase")).toHaveCount(0)
  await box.getByLabel("If none fits").selectOption("")
  await expect(box).toContainText("the sentence is ignored")
  await box.getByLabel("Give up after").fill("5000")
  await expect(box).toContainText("Between 100 and 2000 ms.")
  await expect(save(page)).toBeDisabled()
  await box.getByLabel("Give up after").fill("300")
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  expect((await saves()).at(-1)!.settings.withoutPhrase).toEqual({ mode: "typesafe", fallback: null, giveUpMs: 300 })
  await page.getByTestId("page-up").click()
  await expect(page.locator(`[data-device=${KITCHEN}]`).getByTestId("device-meta")).toContainText("Without a phrase: TypeSafe decides")
})

test("rename saves with the page; Forget asks first and removes the device", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
  await page.getByLabel("Name", { exact: true }).fill("Kitchen")
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  expect((await saves()).at(-1)).toMatchObject({ name: "Kitchen", settings: {} })
  await expect(page.getByTestId("page-title")).toHaveText("Kitchen")
  await page.getByTestId("forget").click()
  const dialog = page.getByTestId("forget-dialog")
  await expect(dialog).toContainText("Forget Kitchen?")
  await dialog.getByRole("button", { name: "Keep it" }).click()
  await expect(dialog).toBeHidden()
  await page.getByTestId("forget").click()
  await page.getByTestId("forget-dialog").getByRole("button", { name: "Forget", exact: true }).click()
  await expect(page.getByTestId("page-devices-all")).toBeVisible()
  await expect(page.getByTestId("device-list").locator(`[data-device=${KITCHEN}]`)).toHaveCount(0)
  expect((await mock.log()).messages.filter((m) => m.type === "device.forget").map((m) => m.id)).toEqual([KITCHEN])
})

test("the defaults page: no Own value marks; a change reaches the devices that follow it, not the ones with their own list", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/devices/type.web-voice")
  await expect(page.getByTestId("page-title")).toHaveText("Every browser")
  await expect(page.getByTestId("device-sub")).toHaveText("Applies to 2 browsers except where one has its own value. A change reaches running devices at once.")
  await expect(page.locator("[data-testid^=marks-] [data-testid=own-marker], [data-testid^=marks-] [data-testid=follows-marker]")).toHaveCount(0)
  await expect(page.getByTestId("forget")).toHaveCount(0)
  await addPhrase(page, "t3", "hey three")
  await save(page).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  expect((await saves()).at(-1)).toMatchObject({ target: { kind: "type", type: "web-voice" } })
  await page.getByTestId("page-up").click()
  await expect(page.locator(`[data-device=${PHONE}]`)).toContainText("T3 · “Hey T3” +2")
  await expect(page.locator(`[data-device=${KITCHEN}]`)).not.toContainText("T3")
})

test("the phrase tester on a device page: lines say which assistant a phrase wakes, and the page is not asked to save", async ({ page, baseURL, context }) => {
  const voice = await context.newPage()
  await voice.goto(appUrl(baseURL))
  await voice.getByTestId("start").click()
  await expectVisualState(voice, "listening")
  const id = await deviceIdOf(voice)
  await loginAdmin(page, baseURL, `#settings/devices/${id}`)
  const tester = page.getByTestId("phrase-tester")
  await tester.getByTestId("tester-listen").click()
  await expect(tester).toHaveAttribute("data-on", "true")
  await mock.heard("Hey T3", "hey t3", true, id)
  await expect(tester.getByTestId("heard-lines").locator("[data-outcome=matched]")).toContainText("Matched Hey T3 → wakes T3")
  await mock.heard("what's the weather", undefined, true, id)
  await expect(tester.getByTestId("heard-lines").locator("[data-outcome=accepted]")).toContainText("Accepted without a phrase")
  // Unsaved edits are not tested.
  await page.getByTestId("without-phrase").selectOption("")
  await expect(tester.getByTestId("tester-unsaved")).toContainText("not tested until you save")
  const sent = (await mock.log()).messages.filter((m) => m.type === "wake.test")
  expect(sent.at(-1)).toMatchObject({ on: true, deviceId: id })
  await voice.close()
})
