import { expect, loginAdmin, mock, test } from "./fixtures.ts"

// Diagnostics › Reports (docs/REPORTS.md) against the mock server: open the list, open a draft, edit it, send it, and
// see the issue link.

test.beforeEach(async () => {
  await mock.scenario("typed")
})

test("open a draft report, edit it, send it to GitHub and see the issue", async ({ page, baseURL }) => {
  await loginAdmin(page, baseURL, "#settings/diagnostics/reports")
  const rows = page.getByTestId("report")
  await expect(rows.first()).toContainText("The timer rang twice in the kitchen")
  await rows.first().getByTestId("report-open").click()
  await expect(page).toHaveURL(/#settings\/diagnostics\/reports\/r00000000000000a1$/)
  await expect(page.getByTestId("report-public-notice")).toContainText("public")
  await page.getByLabel("Title").fill("The timer rang three times")
  await page.getByRole("button", { name: "Send to GitHub" }).click()
  await expect(page.getByTestId("report-status")).toHaveText("Sent")
  await expect(page.getByTestId("report-issue")).toHaveAttribute("href", /\/issues\/\d+$/)
  await expect(page.getByLabel("Title")).toHaveValue("The timer rang three times")
  await page.getByTestId("report-back").click()
  await expect(page.getByTestId("report").first()).toContainText("The timer rang three times")
})
