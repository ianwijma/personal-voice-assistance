import { appUrl, expect, expectVisualState, mock, test } from "./fixtures.ts"

test.beforeEach(async () => {
  await mock.scenario("typed")
})

test("typing without audio: an unspoken reply streams into the chat, with its tool", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await page.getByRole("button", { name: "or type instead" }).click()
  await expect(page.getByTestId("chat-panel")).toBeVisible()
  await expect(page.locator("#chat-input")).toBeFocused()
  // History from the snapshot is there.
  await expect(page.getByTestId("turn")).toHaveCount(2)
  await page.locator("#chat-input").fill("What time is it in Tokyo?")
  await page.keyboard.press("Enter")
  const turn = page.getByTestId("turn").last()
  await expect(turn).toContainText("What time is it in Tokyo?")
  await expect(turn.getByTestId("tool-chip")).toHaveAttribute("data-status", "ok")
  await expect(turn.getByTestId("tool-chip")).toContainText("current_time")
  await expect(turn).toContainText("twenty past four", { timeout: 5000 })
  await expect(turn).toHaveAttribute("data-outcome", "completed")
  await expect(page.locator("#chat-input")).toHaveValue("")
  const send = (await mock.log()).messages.find((m) => m.type === "text.send")!
  expect(send.speak).toBe(false) // no audio on this tab
  // Clicking the tool chip shows its input.
  await turn.getByTestId("tool-chip").click()
  await expect(turn.locator("pre")).toContainText("Asia/Tokyo")
})

test("typing with audio: the reply is spoken, its clauses fill in as they play; a failed tool shows its error", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await page.keyboard.press("/")
  await expect(page.locator("#chat-input")).toBeFocused()
  await page.keyboard.type("Tell me a long story")
  await page.keyboard.press("Enter")
  await expectVisualState(page, "speaking", 8000)
  const turn = page.getByTestId("turn").last()
  await expect(turn.locator("[data-played]").first()).toBeVisible()
  await expectVisualState(page, "listening", 20_000)
  await expect(turn).toHaveAttribute("data-outcome", "completed")
  await expect(turn.locator("[data-played]")).toHaveCount(4)
  expect((await mock.log()).messages.find((m) => m.type === "text.send")!.speak).toBe(true)

  await page.locator("#chat-input").fill("this will fail")
  await page.keyboard.press("Enter")
  const failed = page.getByTestId("turn").last().getByTestId("tool-chip")
  await expect(failed).toHaveAttribute("data-status", "running")
  await expect(failed).toHaveAttribute("data-status", "error", { timeout: 6000 })
  await expect(failed).toContainText("did not answer within 3000 ms")
})

test("replies that arrive while the chat is closed set the unread dot", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await page.keyboard.press("c")
  await page.locator("#chat-input").fill("hello")
  await page.keyboard.press("Enter")
  await page.keyboard.press("Escape") // closes the panel (focus is inside it)
  await expect(page.getByTestId("chat-panel")).toBeHidden()
  await expect(page.getByTestId("unread-dot")).toBeVisible({ timeout: 6000 })
  await page.keyboard.press("c")
  await expect(page.getByTestId("unread-dot")).toBeHidden()
})

test("Shift+Enter makes a new line; a typed message while speaking interrupts the reply", async ({ page, baseURL }) => {
  await page.goto(appUrl(baseURL))
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  await page.keyboard.press("c")
  const input = page.locator("#chat-input")
  await input.fill("Tell me a long story")
  await page.keyboard.press("Enter")
  await expectVisualState(page, "speaking", 8000)
  await input.click()
  await page.keyboard.type("line one")
  await page.keyboard.press("Shift+Enter")
  await page.keyboard.type("line two")
  await expect(input).toHaveValue("line one\nline two")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("turn").nth(-2)).toHaveAttribute("data-outcome", "interrupted", { timeout: 4000 })
})
