import { expect, expectVisualState, mock, test } from "./fixtures.ts"

// `next dev` derives the socket address itself (ws://<host>:8787/ws), no ?ws= needed.
test("next dev: connects to the mock and a spoken exchange works", async ({ page, baseURL }) => {
  await mock.scenario("voice")
  await page.goto(baseURL!)
  await page.getByTestId("start").click()
  await expectVisualState(page, "speaking", 15_000)
  await expectVisualState(page, "listening", 15_000)
  expect((await mock.log()).messages.some((m) => m.type === "playback.finished")).toBe(true)
})
