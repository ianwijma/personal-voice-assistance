import { adminUrl, appUrl, expect, expectVisualState, MOCK_PORT, mock, test } from "./fixtures.ts"

// `next dev` derives the socket address itself (ws://<host>:8787/ws), no ?ws= needed — unless the mock runs on
// another port (E2E_MOCK_PORT, because 8787 is taken), when the page is told with ?ws=.
test("next dev: connects to the mock and a spoken exchange works", async ({ page, baseURL }) => {
  await mock.scenario("voice")
  await page.goto(MOCK_PORT === 8787 ? baseURL! : appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "speaking", 15_000)
  await expectVisualState(page, "listening", 15_000)
  expect((await mock.log()).messages.some((m) => m.type === "playback.finished")).toBe(true)
})

test("next dev: the admin route is its own page; /admin redirects to /admin/", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(adminUrl(baseURL).replace("/admin/", "/admin"))
  await expect(page).toHaveURL(/\/admin\/\?ws=/)
  await expect(page.getByTestId("login-form")).toBeVisible()
})
