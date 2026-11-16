import { appUrl, expect, expectVisualState, mock, test } from "./fixtures.ts"

/**
 * The full-stage canvas (docs/CHARACTERS.md §2.6): the baseline asks for the whole stage, so its canvas covers the
 * viewport behind the page, takes no pointer events, does not scroll or slide, and is told each frame where the box is.
 */
const debug = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __pvaStage: { debug: () => { id: string; canvas: string; size: { width: number; height: number; ratio: number }; focus: { x: number; y: number; width: number; height: number } } } }).__pvaStage.debug())
const box = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const r = document.querySelector(".stage-vis")!.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })

test("the baseline draws on a full-stage canvas behind the page, centred on the box, following it when the chat opens", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await page.goto(appUrl(baseURL))
  await page.waitForFunction(() => (window as unknown as { __pvaStage?: unknown }).__pvaStage !== undefined)
  const canvas = page.locator("[data-testid=stage-layer] canvas")
  await expect(canvas).toHaveCount(1)
  expect(await canvas.boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
  expect(await canvas.evaluate((c) => getComputedStyle(c).pointerEvents)).toBe("none")
  expect(await page.locator(".stage-vis canvas").first().evaluate((c) => getComputedStyle(c).visibility)).toBe("hidden")
  const d = await debug(page)
  expect(d).toMatchObject({ id: "sine-lines", canvas: "stage", size: { width: 1280, height: 800 } })
  expect(d.focus).toEqual(await box(page))
  // The page stays usable through it: Start is a click on a button the canvas covers.
  await page.getByTestId("start").click()
  await expectVisualState(page, "listening")
  // The chat panel slides the stage aside (1024–1439 px): the focus follows the box, the canvas does not move.
  await page.keyboard.press("c")
  await expect(page.getByTestId("chat-panel")).toBeVisible()
  await expect.poll(async () => (await debug(page)).focus.x).toBeLessThan(d.focus.x - 150)
  await page.waitForTimeout(400)
  expect((await debug(page)).focus).toEqual(await box(page))
  expect(await canvas.boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
})
