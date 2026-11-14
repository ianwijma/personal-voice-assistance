import { appUrl, expect, loginAdmin, mock, test } from "./fixtures.ts"

// Admin › Devices: the list (name, kind, last seen, talking now with its state, activation), a device's page with rename, the
// profile form with "Default (…)" or an override with Reset (sent as null), and forget with confirmation.

const updates = async () => (await mock.log()).messages.filter((m) => m.type === "device.admin.update")

test("no devices yet: the list says how one appears", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await loginAdmin(page, baseURL, "#settings/devices")
  await expect(page.getByTestId("no-devices")).toContainText("No devices yet.")
})

test("the list shows every device, which one is talking now and how it activates; a voice page appears when it connects", async ({ page, baseURL, context }) => {
  await mock.scenario("devices")
  await loginAdmin(page, baseURL, "#settings/devices")
  const list = page.getByTestId("device-list")
  await expect(list.locator("[data-device]")).toHaveCount(2)
  const kitchen = list.locator("[data-device=d-kitchen-ipad-0001]")
  await expect(kitchen).toContainText("Kitchen iPad")
  await expect(kitchen).toContainText("Wake phrase · “hey jeff” +2")
  await expect(kitchen).toContainText("3 own settings")
  await expect(kitchen).toContainText("Seen 2 h ago")
  await expect(kitchen).toContainText("Voice assistant in a browser")
  await expect(list.locator("[data-device=d-pixel-phone-0002]")).toContainText("Always listening")

  const voice = await context.newPage()
  await voice.goto(appUrl(baseURL))
  await voice.getByTestId("start").click()
  await expect(list.locator("[data-device]")).toHaveCount(3)
  const mine = list.locator("[data-device]").first()
  await expect(mine).toContainText("Connected now")
  await expect(mine.getByTestId("talking-now")).toHaveText("Talking now")
  await expect(mine.getByTestId("session-state")).toHaveText("listening")
  await voice.close()
})

test("a device page: rename, override and Reset (null), forget with confirmation", async ({ page, baseURL }) => {
  await mock.scenario("devices")
  await loginAdmin(page, baseURL, "#settings/devices")
  await page.getByTestId("device-list").locator("[data-device=d-kitchen-ipad-0001]").click()
  await expect(page.getByTestId("page-devices-device")).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#settings/devices/d-kitchen-ipad-0001")
  await expect(page.getByTestId("page-up")).toHaveText(/Devices/)

  // Rename.
  const name = page.getByLabel("Name", { exact: true })
  await name.fill("Kitchen")
  await page.getByRole("button", { name: "Rename" }).click()
  await expect(page.getByTestId("rename")).toContainText("Renamed")
  expect((await updates()).at(-1)).toMatchObject({ id: "d-kitchen-ipad-0001", name: "Kitchen" })

  // Inherited fields say their default; overrides offer Reset.
  const form = page.getByTestId("profile-device-d-kitchen-ipad-0001")
  await expect(form.locator("[data-field=captions]").getByTestId("inherited")).toHaveText("Default (On)")
  const followUp = form.locator("[data-field=followUpSeconds]")
  await expect(followUp).toHaveAttribute("data-overridden", "true")
  await expect(followUp.getByTestId("custom-marker")).toHaveText("Override")
  await expect(followUp.getByTestId("unsaved-marker")).toHaveCount(0)
  await expect(followUp.getByTestId("reset")).toHaveAccessibleName("Reset Keep listening after a reply to the default for this kind (8 s)")
  await followUp.getByTestId("reset").click()
  await expect(followUp.getByTestId("inherited")).toHaveText("Default (8 s)")
  await expect(followUp.getByTestId("unsaved-marker")).toHaveText("Unsaved")
  await form.locator("[data-field=captions]").getByRole("switch").click()
  await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  expect((await updates()).at(-1)!.patch).toEqual({ followUpSeconds: null, captions: false })
  // Saved: "Unsaved" goes, the override stays marked.
  await expect(form.getByTestId("unsaved-marker")).toHaveCount(0)
  await expect(form.locator("[data-field=captions]").getByTestId("custom-marker")).toHaveText("Override")

  // Forget: asks first; Keep it keeps it.
  await page.getByTestId("forget").click()
  const dialog = page.getByTestId("forget-dialog")
  await expect(dialog).toContainText("Forget Kitchen?")
  await dialog.getByRole("button", { name: "Keep it" }).click()
  await expect(dialog).toBeHidden()
  await page.getByTestId("forget").click()
  await page.getByTestId("forget-dialog").getByRole("button", { name: "Forget", exact: true }).click()
  await expect(page.getByTestId("page-devices-all")).toBeVisible()
  await expect(page.getByTestId("device-list").locator("[data-device=d-kitchen-ipad-0001]")).toHaveCount(0)
  expect((await mock.log()).messages.filter((m) => m.type === "device.forget").map((m) => m.id)).toEqual(["d-kitchen-ipad-0001"])
})

test("an override set in admin reaches the device's page live", async ({ page, baseURL, context }) => {
  await mock.scenario("typed")
  const voice = await context.newPage()
  await voice.goto(appUrl(baseURL))
  await voice.getByTestId("start").click()
  const id = await voice.evaluate(() => localStorage.getItem("pva.deviceId"))
  await loginAdmin(page, baseURL, `#settings/devices/${id}`)
  const form = page.getByTestId(`profile-device-${id}`)
  await form.locator("[data-field=captions]").getByRole("switch").click()
  await page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByTestId("footer-note")).toContainText("Saved")
  // Captions off: the caption area is gone on the voice page.
  await voice.getByTestId("settings-toggle").click() // any interaction; the profile already arrived
  await expect(voice.getByTestId("captions")).toHaveCount(0)
  await voice.close()
})
