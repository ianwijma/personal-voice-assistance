import { expect, loginAdmin, mock, test } from "./fixtures.ts"

// Overview › "Who answers where" (mock-up `pOverview`): devices against assistants; and Shared settings (mock-up `pShared`).

test.beforeEach(async () => {
  await mock.scenario("devices")
})

test("the grid: rows are devices (defaults first), columns are assistants, a cell says how it is reached", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/overview")
  await expect(page.getByTestId("grid-count")).toHaveText("2 devices · 3 assistants")
  const grid = page.getByTestId("grid")
  await expect(grid.locator("thead th[data-assistant]")).toHaveText([/Jeff/, /T3/, /Keuken/])
  const cell = (row: string, a: string) => grid.locator(`[data-cell="${row}:${a}"]`)
  await expect(cell("type:web-voice", "jeff")).toContainText("Without a phrase")
  await expect(cell("type:web-voice", "t3")).toContainText("“Hey T3”")
  await expect(cell("type:web-voice", "t3")).toContainText("“Hey tee three”")
  await expect(cell("type:web-voice", "keuken")).toBeEmpty()
  await expect(cell("d-kitchen-ipad-0001", "keuken")).toContainText("“Hé keuken”")
  await expect(cell("d-kitchen-ipad-0001", "t3")).toBeEmpty()
  await expect(cell("d-kitchen-ipad-0001", "jeff").getByRole("button")).toHaveAccessibleName("Jeff on Kitchen iPad: answers without a phrase")
  await expect(cell("d-kitchen-ipad-0001", "keuken").getByRole("button")).toHaveAccessibleName("Keuken on Kitchen iPad: “Hé keuken”, “Hey keuken”")
  // A device that follows the defaults is dimmed and says so; the defaults row says who follows it.
  await expect(grid.locator("[data-row=d-pixel-phone-0002]")).toContainText("Follows Every browser")
  await expect(grid.locator("[data-row='type:web-voice']")).toContainText("Followed by Android phone · Chrome")
  // A cell opens the device.
  await cell("d-kitchen-ipad-0001", "keuken").getByRole("button").click()
  expect(new URL(page.url()).hash).toBe("#settings/devices/d-kitchen-ipad-0001")
})

test("the checklist names the assistants", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/overview")
  await expect(page.getByTestId("checklist")).toContainText("Assistants: Jeff, T3 and Keuken, all switched on")
})

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test("the grid is a list: each device with a line per assistant", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/overview/overview")
    const list = page.getByTestId("grid-list")
    await expect(list).toBeVisible()
    await expect(page.getByTestId("grid")).toBeHidden()
    await expect(list).toContainText("Every browser")
    await expect(list).toContainText("Kitchen iPad")
    await expect(list.getByText("Without a phrase").first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
