import { expect, type Page } from "@playwright/test"
import { loginAdmin, mock, test } from "./fixtures.ts"

// Admin › Assistants › New assistant (docs/ASSISTANTS.md §7.1, mock-up `pWizard`): seven steps at
// `#settings/assistants/new/<n>`; nothing is sent before "Create assistant", which sends assistant.create with placements.

const created = async () => (await mock.log()).messages.filter((m) => m.type === "assistant.create") as unknown as Array<{ assistant: Record<string, any>; copyOf?: string; placements?: Array<{ target: Record<string, string>; phrase?: string }> }>
const next = (page: Page) => page.getByTestId("wizard-next").click()

test.beforeEach(async () => {
  await mock.scenario("devices")
})

test("a blank assistant through the seven steps: Start, model, hearing, voice, modules, Where, Check; placements land on devices", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/assistants/all")
  await page.getByTestId("new-assistant").click()
  expect(new URL(page.url()).hash).toBe("#settings/assistants/new/1")
  await expect(page.getByTestId("page-title")).toHaveText("New assistant")
  await expect(page.getByTestId("wizard-step-name")).toHaveText("Start")
  await expect(page.getByTestId("step-count")).toHaveText("Step 1 of 7")
  await page.getByLabel("Name", { exact: true }).fill("Mia")
  await page.getByLabel("Purpose").fill("Helps with the garden")
  await next(page)
  await expect(page.getByTestId("wizard-next")).toHaveText("Next: Hearing")
  await expect(page.getByRole("radiogroup", { name: "Account" })).toBeVisible()
  await page.getByRole("radiogroup", { name: "Effort" }).getByRole("radio", { name: "Medium" }).click()
  await next(page)
  await expect(page.getByTestId("hearing-callout")).toContainText("A device hears with one recogniser")
  await next(page)
  await expect(page.getByTestId("voice-picker")).toContainText("Lessac")
  await next(page)
  await expect(page.getByTestId("module-list")).toBeVisible()
  await next(page)
  // Where: tick Every browser and the kitchen iPad, with a phrase each; the phone without a phrase warns.
  await expect(page.getByTestId("where-list")).toContainText("Also reaches Android phone · Chrome")
  await page.getByRole("checkbox", { name: "Every browser (defaults)" }).click()
  await expect(page.getByText("Without a phrase it cannot be reached here.")).toBeVisible()
  await page.getByLabel("Wake phrase on Every browser").fill("hey mia")
  await page.getByRole("checkbox", { name: "Kitchen iPad" }).click()
  await page.getByLabel("Wake phrase on Kitchen iPad").fill("hey mia keuken")
  await next(page)
  await expect(page.getByTestId("check-list")).toContainText("Every browser on “hey mia”")
  // Going back from Check keeps what was typed.
  await page.getByRole("button", { name: "Edit Start" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Mia")
  // Forward to Check again with Next. (Setting the fragment from the page right after the app's own pushState, as this
  // test did, is lost about one run in twenty: Chromium reverts it to the pushed entry while that entry is still being
  // committed. Nothing in the app is involved, so the test goes the way a person does.)
  for (let step = 1; step < 7; step++) await next(page)
  await expect(page.getByTestId("step-count")).toHaveText("Step 7 of 7")
  await expect(created()).resolves.toHaveLength(0) // nothing is sent before Create
  await page.getByTestId("wizard-create").click()
  await expect(page.getByTestId("assistant-page")).toHaveAttribute("data-assistant", "mia")
  const [body] = await created()
  expect(body!.assistant).toMatchObject({ name: "Mia", purpose: "Helps with the garden", llm: { account: "anthropic", effort: "medium" } })
  expect(body!.copyOf).toBeUndefined()
  expect(body!.placements).toEqual([{ target: { kind: "type", type: "web-voice" }, phrase: "hey mia" }, { target: { kind: "device", id: "d-kitchen-ipad-0001" }, phrase: "hey mia keuken" }])
  // The placements are on the devices: Used on lists them.
  await page.locator("[role=tab][data-tab=used]").click()
  await expect(page.getByTestId("tab-panel-used")).toContainText("Kitchen iPad")
  await expect(page.getByTestId("tab-panel-used")).toContainText("“hey mia keuken”")
  await expect(page.getByTestId("tab-panel-used")).toContainText("Every browser")
})

test("Create without a name goes back to Start with the error on the field; Decide later creates it on no device", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/assistants/new/7")
  await page.getByTestId("wizard-create").click()
  await expect(page.getByTestId("wizard")).toHaveAttribute("data-step", "1")
  await expect(page.locator("[data-field=name]").getByTestId("field-error")).toHaveText("An assistant needs a name.")
  await page.getByLabel("Name", { exact: true }).fill("Solo")
  await page.evaluate(() => { location.hash = "#settings/assistants/new/6" })
  await page.getByRole("checkbox", { name: "Android phone · Chrome" }).click()
  await page.getByTestId("decide-later").click()
  await expect(page.getByTestId("check-list")).toContainText("Decided later")
  await page.getByTestId("wizard-create").click()
  await expect(page.getByTestId("assistant-page")).toHaveAttribute("data-assistant", "solo")
  const [body] = await created()
  expect(body!.placements).toEqual([])
})

test("Start from a copy takes the settings of that assistant, not its devices; a duplicate name is refused on the field", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/assistants/new/1")
  await page.getByLabel("Name", { exact: true }).fill("Jeff")
  await page.getByRole("radio", { name: /Copy of Keuken/ }).click()
  await page.evaluate(() => { location.hash = "#settings/assistants/new/7" })
  await expect(page.getByTestId("check-list")).toContainText("Copy of Keuken")
  await expect(page.getByTestId("check-list")).toContainText("qwen3-14b")
  await page.getByTestId("wizard-create").click()
  await expect(page.getByTestId("wizard")).toHaveAttribute("data-step", "1")
  await expect(page.locator("[data-field=name]").getByTestId("field-error")).toHaveText("Another assistant already has this name.")
  await page.getByLabel("Name", { exact: true }).fill("Keuken twee")
  await page.evaluate(() => { location.hash = "#settings/assistants/new/7" })
  await page.getByTestId("wizard-create").click()
  await expect(page.getByTestId("assistant-page")).toHaveAttribute("data-assistant", "keuken-twee")
  const body = (await created()).at(-1)
  expect(body!.copyOf).toBe("keuken")
  expect(body!.assistant).toMatchObject({ name: "Keuken twee", llm: { account: "home-model", model: "qwen3-14b" }, voice: { voiceId: "nl_NL-pim-medium" } })
})

test("a duplicate phrase on a device refuses the create at Where; typed work asks before leaving", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/assistants/new/1")
  await page.getByLabel("Name", { exact: true }).fill("Mia")
  await page.evaluate(() => { location.hash = "#settings/assistants/new/6" })
  await page.getByRole("checkbox", { name: "Kitchen iPad" }).click()
  await page.getByLabel("Wake phrase on Kitchen iPad").fill("Hey Jeff")
  await page.evaluate(() => { location.hash = "#settings/assistants/new/7" })
  await page.getByTestId("wizard-create").click()
  await expect(page.getByTestId("where-error")).toContainText("Hey Jeff")
  await expect(page.getByTestId("wizard")).toHaveAttribute("data-step", "6")
  await page.getByTestId("nav-diagnostics").click()
  await expect(page.getByTestId("leave-dialog")).toBeVisible()
  await page.getByRole("button", { name: "Stay" }).click()
})
