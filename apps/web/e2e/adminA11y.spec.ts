import { expect, gotoAdmin, loginAdmin, mock, test } from "./fixtures.ts"

// Admin review round 2 (docs/FRONTENDS-AND-ACTIVATION.md, Status): focus after navigation, the skip link, the nav
// marks and their legend, the latency table at 1280 px, and the phone header at 320 px.

test("wide screen: focus goes to the visible page title, the next Tab reaches the page; Skip to settings comes first", async ({ page, baseURL }) => {
  await mock.scenario("devices")
  await loginAdmin(page, baseURL, "#settings/overview")
  // From the keyboard: the title takes focus and shows the focus ring.
  await page.getByTestId("nav-frontends").focus()
  await page.keyboard.press("Enter")
  const title = page.getByTestId("page-title")
  await expect(title).toBeFocused()
  await expect(title).toBeVisible()
  expect(await title.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid")
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.querySelector("[data-testid=settings-page]")!.contains(document.activeElement))).toBe(true)
  // The skip link is the first thing Tab reaches, and goes to the page title.
  await page.reload()
  await expect(page.getByTestId("settings")).toBeVisible()
  // From the top of the document.
  await page.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
  await page.keyboard.press("Tab")
  const skip = page.getByTestId("skip-to-settings")
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  await page.keyboard.press("Enter")
  await expect(title).toBeFocused()
})

test("nav marks differ in shape and every mark shown is in the legend", async ({ page, baseURL }) => {
  await mock.scenario("keys-locked")
  await loginAdmin(page, baseURL, "#settings/speech/turn-timing")
  const legend = page.getByTestId("marks-legend")
  await page.getByTestId("settings-page").locator("input[type=number]").first().fill("700")
  await expect(page.getByTestId("settings-nav").locator("button [data-mark=dirty]").first()).toBeVisible()
  const shown = await page.getByTestId("settings-nav").locator("button [data-mark]").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-mark")))])
  const listed = await legend.locator("[data-legend]").evaluateAll((els) => els.map((e) => e.getAttribute("data-legend")))
  expect(listed.sort()).toEqual(shown.sort())
  // Unsaved is a filled dot, "to set up" a hollow ring (when shown).
  const shape = (kind: string) => page.getByTestId("settings-nav").locator(`[data-mark=${kind}] > span`).first().evaluate((el) => {
    const s = getComputedStyle(el)
    return { fill: s.backgroundColor, border: s.borderTopWidth }
  })
  expect((await shape("dirty")).border).toBe("0px")
  if (shown.includes("todo")) expect((await shape("todo")).fill).toBe("rgba(0, 0, 0, 0)")
  for (const kind of shown) await expect(page.getByTestId("settings-nav").locator(`button [data-mark=${kind}]`).first()).toHaveAttribute("title", /.+/)
})

test("latency: every column fits the page column at 1280 px", async ({ page, baseURL }) => {
  await mock.scenario("typed")
  await loginAdmin(page, baseURL, "#settings/diagnostics/latency")
  await page.evaluate(() => {
    const c = (window as unknown as { __pva: { store: { dispatch: (a: unknown) => void } } }).__pva
    for (let i = 1; i <= 3; i++) {
      const outcome = i === 3 ? "interrupted" : "completed"
      c.store.dispatch({
        type: "turn.end",
        turnId: 900 + i,
        outcome,
        trace: {
          turnId: 900 + i, mode: "voice", speculative: i % 2 === 0, outcome, voices: ["sherpa:kokoro-af_heart"],
          tools: i === 2 ? [{ name: "weather", ms: 241 }, { name: "calendar", ms: 88 }] : [],
          marks: { llmFirstToken: 180 + i, ttsFirstAudio: 260 + i, playbackStart: 300 + i }
        }
      })
    }
  })
  const table = page.getByTestId("latency-table")
  await expect(table.locator("tbody tr")).toHaveCount(3)
  await expect(table).toHaveAttribute("data-scrolls", "false")
  expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)
})

test.describe("phone at 320 px", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true })

  test("the status line wraps, the Voice link says so, device rows keep last seen and the phrase together", async ({ page, baseURL }) => {
    await mock.scenario("devices")
    await loginAdmin(page, baseURL, "#settings/devices")
    const line = page.getByTestId("assistant-line-narrow")
    const text = line.locator("p")
    expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(await page.getByTestId("voice-link").innerText()).toBe("Voice")
    await expect(page.getByTestId("voice-link")).toHaveAccessibleName("Open the voice assistant")
    for (const id of ["voice-link", "logout"]) {
      const b = (await page.getByTestId(id).boundingBox())!
      expect(Math.round(b.width), id).toBeGreaterThanOrEqual(44)
      expect(Math.round(b.height), id).toBeGreaterThanOrEqual(44)
    }
    const kitchen = page.getByTestId("device-list").locator("[data-device=d-kitchen-ipad-0001]")
    await expect(kitchen).toContainText("Seen 2 h ago")
    const seen = kitchen.getByText("Seen 2 h ago")
    expect(await seen.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const row = el.parentElement!.getBoundingClientRect()
      return box.right <= row.right + 0.5
    })).toBe(true)
    await gotoAdmin(page, baseURL, "#settings/frontends/web-voice")
    const remove = page.getByTestId("phrase-list").locator("button[aria-label^=Remove]")
    if (await remove.count() > 0) expect(Math.round((await remove.first().boundingBox())!.width)).toBeGreaterThanOrEqual(44)
  })
})
