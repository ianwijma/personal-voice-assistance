import type { Page } from "@playwright/test"
import { adminUrl, expect, gotoAdmin, loginAdmin, mock, test } from "./fixtures.ts"

// The admin settings screen (docs/SETTINGS-UI.md §3, docs/FRONTENDS-AND-ACTIVATION.md §5): the page itself after the
// login: list + page from 1024 px, drill-down on a phone, hash deep links under /admin/,
// back, "Leave without saving?", the global reload bar, draft-driven visibility, warnings with "Save anyway",
// Reset to default, and the Claude subscription set up from one page.

const footer = (page: Page) => page.getByTestId("page-footer")
const save = (page: Page) => footer(page).getByRole("button", { name: "Save", exact: true })
const hash = (page: Page) => new URL(page.url()).hash

test.beforeEach(async () => {
  await mock.scenario("modules")
})

test.describe("desktop (1280 × 800)", () => {
  test("list + page: navigate, the hash follows, browser back goes to the previous page, a deep link opens a page", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL)
    await expect(page.getByTestId("page-overview-overview")).toBeVisible()
    await expect(page.getByTestId("settings-nav")).toBeVisible()
    await page.getByTestId("nav-shared").click()
    await expect(page.getByTestId("page-shared-home")).toBeVisible()
    expect(hash(page)).toBe("#settings/shared")
    // The current category is expanded to its pages, in the mock-up's order (Home and Routing when the server has them).
    const pages = await page.getByTestId("settings-nav").locator("[data-testid^=nav-shared-]").allTextContents()
    expect(pages.map((t) => t.trim())).toEqual(["Home", "Members", "Risk policy", "Modules", "Language model accounts", "Routing", "Speech recognition models", "Voice providers", "Limits"])
    await page.getByTestId("nav-shared-limits").click()
    await expect(page.getByTestId("page-shared-limits")).toBeVisible()
    expect(hash(page)).toBe("#settings/shared/limits")
    await page.goBack()
    await expect(page.getByTestId("page-shared-home")).toBeVisible()
    await page.goBack()
    await expect(page.getByTestId("page-overview-overview")).toBeVisible()

    await page.goto(adminUrl(baseURL, "#settings/shared/providers")) // the session token survives the navigation
    await expect(page.getByTestId("page-shared-providers")).toBeVisible()
    await expect(page.getByTestId("nav-shared-providers")).toHaveAttribute("aria-current", "page")
    await expect(page.getByTestId("page-title")).toHaveText("Voice providers")
  })

  test("the fields that moved onto the assistant are gone from the shared pages; the keys and limits stay", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/shared/accounts")
    const accounts = page.getByTestId("page-shared-accounts")
    await expect(accounts.locator("[data-field=ANTHROPIC_API_KEY]")).toBeVisible()
    await expect(accounts.locator("[data-field=ANTHROPIC_BASE_URL]")).toBeVisible()
    for (const gone of ["LLM_PROVIDER", "ANTHROPIC_MODEL", "ANTHROPIC_EFFORT"]) await expect(accounts.locator(`[data-field=${gone}]`)).toHaveCount(0)
    await expect(page.getByTestId("module-block-claude-subscription")).toContainText("Claude subscription")
    await gotoAdmin(page, baseURL, "#settings/shared/limits")
    await expect(page.locator("[data-field=MAX_VOICE_SESSIONS]")).toBeVisible()
    await expect(page.locator("[data-field=SYSTEM_PROMPT]")).toHaveCount(0)
    await expect(page.locator("[data-field=CONVERSATION_IDLE_MINUTES]")).toHaveCount(0)
    // The old per-assistant pages are not in the navigation (Language model, Speech engine and timing, Voices).
    for (const gone of ["nav-language-model", "nav-speech", "nav-voices", "nav-frontends", "nav-modules"]) await expect(page.getByTestId(gone)).toHaveCount(0)
  })

  test("Leave without saving? Stay keeps the edit; Discard leaves", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/shared/modules")
    await page.getByTestId("nav-shared-limits").click()
    const field = page.locator("[data-field=MAX_VOICE_SESSIONS]").getByRole("spinbutton")
    await field.fill("3")
    await expect(page.getByTestId("nav-shared-limits").locator("[data-mark=dirty]")).toBeVisible()
    await page.getByTestId("nav-diagnostics").click()
    const dialog = page.getByTestId("leave-dialog")
    await expect(dialog).toContainText("Leave without saving?")
    await dialog.getByRole("button", { name: "Stay" }).click()
    await expect(dialog).toBeHidden()
    await expect(field).toHaveValue("3")
    // Browser back is held too, and Stay puts the page back.
    await page.goBack()
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Stay" }).click()
    await expect(page.getByTestId("page-shared-limits")).toBeVisible()
    expect(hash(page)).toBe("#settings/shared/limits")
    await page.getByTestId("nav-diagnostics").click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Discard changes" }).click()
    await expect(page.getByTestId("settings-page")).toBeVisible()
    expect((await mock.log()).messages.filter((m) => m.type === "settings.update")).toEqual([])
  })

  test("a saved value is Custom (not Unsaved); an edit adds Unsaved; Reset to default sends null", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/shared/limits")
    const field = page.locator("[data-field=MAX_VOICE_SESSIONS]")
    const input = field.getByRole("spinbutton")
    await input.fill("3")
    await save(page).click()
    await expect(footer(page).getByText("Saved")).toBeVisible()
    await expect(field).toHaveAttribute("data-source", "saved")
    await expect(field.getByTestId("custom-marker")).toHaveText("Custom")
    await expect(field.getByTestId("unsaved-marker")).toHaveCount(0)
    await input.fill("5")
    await expect(field.getByTestId("unsaved-marker")).toHaveText("Unsaved")
    await input.fill("3")
    await expect(field.getByTestId("unsaved-marker")).toHaveCount(0)
    await field.getByRole("button", { name: /Reset/ }).click()
    await save(page).click()
    await expect(field).toHaveAttribute("data-source", "default")
    const updates = (await mock.log()).messages.filter((m) => m.type === "settings.update")
    expect(updates.at(-1)!.patch).toEqual({ values: { MAX_VOICE_SESSIONS: null }, secrets: {} })
  })

  test("the subscription agent refuses to start without the opt-in (the server's check stays)", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/shared/accounts")
    const header = page.getByTestId("module-claude-subscription")
    await header.getByRole("switch").click()
    await expect(header).toHaveAttribute("data-state", "error")
    await expect(header.getByRole("alert")).toContainText("Use my Claude subscription")
  })
})

test.describe("phone (390 × 844)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("drill-down: categories → pages → page, the back button names the parent, the footer sits at the bottom", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL)
    const settings = page.getByTestId("settings")
    await expect(settings).toHaveAttribute("data-level", "list")
    await page.getByTestId("nav-shared").tap()
    await expect(settings).toHaveAttribute("data-level", "pages")
    await expect(page.getByTestId("settings-back")).toHaveText("Admin")
    await expect(page.getByTestId("settings-pages")).toContainText("Language model accounts")
    await page.getByTestId("nav-shared-limits").tap()
    await expect(settings).toHaveAttribute("data-level", "page")
    await expect(page.getByTestId("settings-back")).toHaveText("Shared settings")
    const row = await page.getByTestId("nav-overview").count()
    expect(row).toBe(0)
    // Edit: the sticky footer is on screen, at the bottom.
    await page.locator("[data-field=MAX_VOICE_SESSIONS]").getByRole("spinbutton").fill("3")
    const box = await footer(page).boundingBox()
    expect(Math.round(box!.y + box!.height)).toBeLessThanOrEqual(844)
    expect(Math.round(box!.y + box!.height)).toBeGreaterThan(780)
    await save(page).tap()
    await expect(footer(page).getByText("Saved")).toBeVisible()
    await page.getByTestId("settings-back").tap()
    await expect(settings).toHaveAttribute("data-level", "pages")
    await page.getByTestId("settings-back").tap()
    await expect(settings).toHaveAttribute("data-level", "list")
    // The browser's own back gesture goes through the hash history too.
    await page.getByTestId("nav-shared").tap()
    await page.getByTestId("nav-shared-providers").tap()
    await page.goBack()
    await expect(settings).toHaveAttribute("data-level", "pages")
  })

  test("a deep link opens the page; a one-page category opens it directly; Overview is reachable", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/shared/modules")
    await expect(page.getByTestId("page-shared-modules")).toBeVisible()
    await expect(page.getByTestId("module-block-weather")).toBeVisible()
    await expect(page.getByTestId("settings-back")).toHaveText("Shared settings")
    await page.goto(adminUrl(baseURL, "#settings/about"))
    await expect(page.getByTestId("page-about-about")).toBeVisible()
    await expect(page.getByTestId("settings-back")).toHaveText("Admin")
    await page.getByTestId("settings-back").tap()
    await page.getByTestId("nav-overview").tap()
    await expect(page.getByTestId("checklist")).toBeVisible()
  })
})
