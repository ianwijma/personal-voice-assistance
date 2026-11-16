import { expect, type Page } from "@playwright/test"
import { appUrl, gotoAdmin, loginAdmin, MOCK, mock, test } from "./fixtures.ts"

// The admin pages that finish the assistants work (docs/ASSISTANTS.md WP-12, WP-14, WP-15), against the mock: an
// assistant's own module settings, Shared settings › Modules (instances, no switch), Home, Routing (and the device
// page's TypeSafe option that follows it) and Diagnostics › Latency with traces of every route kind.

const KITCHEN = "d-kitchen-ipad-0001"
const open = async (page: Page, baseURL: string | undefined, id: string, tab = "basics") => {
  await gotoAdmin(page, baseURL, `#settings/assistants/${id}/${tab}`)
  await expect(page.getByTestId("assistant-page")).toHaveAttribute("data-assistant", id)
}
const saveButton = (page: Page) => page.getByTestId("page-footer").getByRole("button", { name: "Save", exact: true })
const saves = async () => (await mock.log()).messages.filter((m) => m.type === "assistant.save") as unknown as Array<{ assistant: Record<string, any> }>
const post = (path: string, body: unknown) => fetch(`${MOCK}${path}`, { method: "POST", body: JSON.stringify(body) })

test.describe("Assistant › Modules: own settings", () => {
  test.beforeEach(async () => {
    await mock.scenario("devices")
  })

  test("shared by default with the shared value shown; own value, field error, save, Reset, back to shared", async ({ page, baseURL }) => {
    await open(page, baseURL, "jeff", "modules")
    const weather = page.locator("[data-module=weather]")
    // Shared by default: the shared values are shown, and a way to own them.
    await expect(weather.getByTestId("shared-line")).toContainText("Uses the shared settings")
    await expect(weather.getByTestId("shared-line")).toContainText("Celsius, km/h")
    await weather.getByTestId("use-own").click()
    const own = weather.getByTestId("own-settings")
    await expect(own).toContainText("Own settings for Jeff")
    await expect(own).toContainText("Timeout stays shared.")
    const place = weather.locator("[data-field='modules.weather.own.defaultPlace']")
    await expect(place.getByTestId("same-as-shared")).toBeVisible()
    // An own value: marked, with Reset.
    await place.getByRole("textbox").fill("Atlantis")
    await expect(place.getByTestId("own-marker")).toHaveText("Own value")
    await expect(place.getByTestId("own-reset")).toBeVisible()
    await expect(page.locator("[role=tab][data-tab=modules] [data-mark=dirty]")).toBeVisible()
    // The server refuses the value: the error is on that field, which stays as typed.
    await saveButton(page).click()
    await expect(place.getByTestId("field-error")).toHaveText("Open-Meteo does not know this place.")
    await expect(place.getByRole("textbox")).toHaveAttribute("aria-invalid", "true")
    await expect(place.getByRole("textbox")).toHaveValue("Atlantis")
    expect((await saves()).at(-1)!.assistant.modules.weather.own).toEqual({ defaultPlace: "Atlantis" })
    // Editing the field clears its error; a good value saves.
    await place.getByRole("textbox").fill("Rotterdam")
    await expect(place.getByTestId("field-error")).toHaveCount(0)
    await saveButton(page).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    expect((await saves()).at(-1)!.assistant.modules.weather.own).toEqual({ defaultPlace: "Rotterdam" })
    await expect(place.getByTestId("own-marker")).toBeVisible()
    // Reset: back to following the shared value (the key leaves the assistant's own values).
    await place.getByTestId("own-reset").click()
    await expect(place.getByTestId("same-as-shared")).toBeVisible()
    await saveButton(page).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    expect((await saves()).at(-1)!.assistant.modules.weather.own).toEqual({})
    // Units: a choice, own to Fahrenheit, then the whole module back to the shared settings.
    await weather.locator("[data-field='modules.weather.own.units']").getByRole("radio", { name: "Fahrenheit, mph" }).click()
    await expect(weather.locator("[data-field='modules.weather.own.units']").getByTestId("own-marker")).toBeVisible()
    await weather.getByTestId("use-shared").click()
    await expect(weather.getByTestId("use-own")).toBeVisible()
    await saveButton(page).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    expect((await saves()).at(-1)!.assistant.modules.weather).toEqual({ on: true, offTools: [] })
  })

  test("an assistant that already has its own value shows it, the shared value on Reset, and the other fields shared", async ({ page, baseURL }) => {
    await open(page, baseURL, "t3", "modules")
    const clock = page.locator("[data-module=clock]")
    const locale = clock.locator("[data-field='modules.clock.own.locale']")
    await expect(locale.getByTestId("own-marker")).toBeVisible()
    await expect(locale.getByRole("radio", { name: "November 13, 2026" })).toBeChecked()
    await expect(locale.getByTestId("own-reset")).toHaveAttribute("title", "Back to the shared value (13 November 2026)")
    await expect(clock.locator("[data-field='modules.clock.own.timeZone']").getByTestId("same-as-shared")).toBeVisible()
    await locale.getByTestId("own-reset").click()
    await expect(locale.getByRole("radio", { name: "13 November 2026", exact: true })).toBeChecked()
    await expect(locale.getByTestId("same-as-shared")).toBeVisible()
  })

  test("a module without overridable fields, and the wizard, show only the shared settings", async ({ page, baseURL }) => {
    await open(page, baseURL, "jeff", "modules")
    // Home Assistant: only `domains` is overridable; its address and token are never offered.
    const ha = page.locator("[data-module=home-assistant]")
    await ha.getByTestId("use-own").click()
    await expect(ha.getByTestId("own-settings")).toContainText("Address, access token and include details stay shared.")
    await expect(ha.locator("[data-field^='modules.home-assistant.own.']")).toHaveCount(1)
  })
})

test.describe("Shared settings › Modules", () => {
  test.beforeEach(async () => {
    await mock.scenario("devices")
  })

  test("no global switch for a capability; who uses it, the instances, own-value owners", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/shared/modules")
    const clock = page.getByTestId("module-block-clock")
    await expect(clock.getByRole("switch")).toHaveCount(0)
    await expect(clock.getByTestId("used-by")).toContainText("Used by: Jeff, Keuken · T3 has its own date format")
    const instances = clock.getByTestId("instance")
    await expect(instances).toHaveCount(2)
    await expect(instances.nth(0)).toContainText("Running")
    await expect(instances.nth(0)).toContainText("Shared settings · Jeff, Keuken")
    await expect(instances.nth(1)).toContainText("Own date format · T3")
    await expect(instances.nth(1)).toHaveAttribute("data-own", "true")
    await expect(clock.getByTestId("own-note")).toContainText("An assistant can have its own time zone, date format")
    // Nobody has it on: not running, and said so.
    const ha = page.getByTestId("module-block-home-assistant")
    await expect(ha.getByTestId("used-by")).toContainText("Used by: Jeff")
    // Notes: T3 and Keuken have it on.
    await expect(page.getByTestId("module-block-notes").getByTestId("used-by")).toContainText("Used by: T3, Keuken")
    // Switching it on is the assistants' business: the server refuses.
    expect((await mock.log()).messages.filter((m) => m.type === "module.enable" || m.type === "module.disable")).toEqual([])
  })

  test("a failing instance shows its error naming the assistants; saving a working token fixes it", async ({ page, baseURL }) => {
    await post("/mock/module-error", { module: "home-assistant", message: "Home Assistant rejected the token (HTTP 401)." })
    await loginAdmin(page, baseURL, "#settings/shared/modules")
    const ha = page.getByTestId("module-block-home-assistant")
    await expect(ha.getByTestId("module-home-assistant")).toHaveAttribute("data-state", "error")
    await expect(ha.getByTestId("instance-error")).toContainText("rejected the token (HTTP 401). (for jeff)")
    await expect(page.getByTestId("nav-shared-modules").locator("[data-mark=error]")).toBeVisible()
    const form = ha.getByTestId("form-m-home-assistant")
    await form.getByRole("button", { name: "Replace" }).click()
    await form.getByPlaceholder("Paste the new value").fill("good-token")
    await saveButton(page).click()
    await expect(ha.getByTestId("module-home-assistant")).toHaveAttribute("data-state", "running")
    await expect(ha.getByTestId("instance")).toContainText("Connected to Home")
  })

  test("the instances follow the assistants: an own value on Jeff's Weather starts a second instance", async ({ page, baseURL }) => {
    await open(page, baseURL, "keuken", "modules")
    await page.locator("[data-module=weather]").getByRole("switch", { name: "Weather" }).click()
    await saveButton(page).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    await page.getByTestId("nav-shared").click()
    await page.getByTestId("nav-shared-modules").click()
    const weather = page.getByTestId("module-block-weather")
    await expect(weather.getByTestId("used-by")).toContainText("Used by: Jeff, Keuken")
    await expect(weather.getByTestId("instance")).toHaveCount(1)
    await expect(weather.getByTestId("instance")).toContainText("Shared settings · Jeff, Keuken")
  })

  test("a module the server lets nobody switch on is listed as not running", async ({ page, baseURL }) => {
    // Everyone switches Notes off: it stops, with nothing to switch on here.
    for (const id of ["t3", "keuken"]) {
      await open(page, baseURL, id, "modules")
      await page.locator("[data-module=notes]").getByRole("switch", { name: "Notes" }).click()
      await saveButton(page).click()
      await expect(page.getByTestId("footer-note")).toContainText("Saved")
    }
    await page.getByTestId("nav-shared").click()
    await page.getByTestId("nav-shared-modules").click()
    const notes = page.getByTestId("module-block-notes")
    await expect(notes.getByTestId("used-by")).toContainText("Used by: no assistant yet")
    await expect(notes.getByTestId("no-instances")).toContainText("Not running")
    await expect(notes.getByRole("switch")).toHaveCount(0)
  })
})

test.describe("Shared settings › Home and Routing", () => {
  test.beforeEach(async () => {
    await mock.scenario("devices")
  })

  test("Home: location, time zone, language, units and date format save through settings.update", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/shared/home")
    const form = page.getByTestId("form-s-home")
    await expect(form.locator("[data-field]")).toHaveCount(5)
    await form.locator("[data-field=HOME_LOCATION]").getByRole("textbox").fill("Utrecht, Netherlands")
    await form.locator("[data-field=HOME_TIME_ZONE]").getByRole("textbox").fill("Europe/Amsterdam")
    await form.locator("[data-field=HOME_LANGUAGE]").getByRole("radio", { name: "Dutch (Netherlands)" }).click()
    await form.locator("[data-field=HOME_UNITS]").getByRole("radio", { name: "Imperial (°F, mph)" }).click()
    await saveButton(page).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    const sent = (await mock.log()).messages.filter((m) => m.type === "settings.update").at(-1) as unknown as { sectionId: string; patch: { values: Record<string, unknown> } }
    expect(sent.sectionId).toBe("home")
    expect(sent.patch.values).toEqual({ HOME_LOCATION: "Utrecht, Netherlands", HOME_TIME_ZONE: "Europe/Amsterdam", HOME_LANGUAGE: "nl-NL", HOME_UNITS: "imperial" })
    await expect(form.locator("[data-field=HOME_LOCATION]").getByRole("textbox")).toHaveValue("Utrecht, Netherlands")
  })

  test("Routing: hosted wording, which devices use TypeSafe, the key through the vault flow; on and off flip the device page's option", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, `#settings/devices/${KITCHEN}`)
    const select = page.getByTestId("without-phrase")
    await expect(select.locator("option[value=typesafe]")).toBeDisabled()
    await page.getByTestId("typesafe-unavailable").getByRole("link").first().click()
    await expect(page.getByTestId("page-title")).toHaveText("Routing")
    const intro = page.getByTestId("routing-intro")
    await expect(intro.getByTestId("option-tags")).toContainText("Hosted")
    await expect(intro.getByTestId("option-tags")).toContainText("Needs key")
    await expect(intro.getByTestId("routing-status")).toHaveText("Not set up")
    await expect(intro).toContainText("picks which assistant on a device")
    await expect(intro.getByTestId("routing-used-by")).toHaveText("Used by: no device yet")
    const form = page.getByTestId("form-s-routing")
    await expect(form.locator("[data-field=TYPESAFE_ROUTING]")).toContainText("Hosted and optional. What is sent: the sentence as text and the Handles line")
    // On without a key warns and asks first; the key is set like every other: Set, paste, Save.
    await form.locator("[data-field=TYPESAFE_ROUTING]").getByRole("switch").click()
    await form.locator("[data-field=TYPESAFE_API_KEY]").getByRole("button", { name: "Set" }).click()
    await form.getByPlaceholder("Paste the new value").fill("tsk-example")
    await saveButton(page).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    await expect(intro.getByTestId("routing-status")).toHaveText("On")
    const sent = (await mock.log()).messages.filter((m) => m.type === "settings.update").at(-1) as unknown as { sectionId: string; patch: { values: Record<string, unknown>; secrets: Record<string, unknown> } }
    expect(sent.sectionId).toBe("routing")
    expect(sent.patch.values).toEqual({ TYPESAFE_ROUTING: true })
    expect(sent.patch.secrets).toEqual({ TYPESAFE_API_KEY: "tsk-example" })
    // The device page now offers it, and the Routing page names the device once it uses it.
    const go = (hash: string) => page.evaluate((h) => { window.location.hash = h }, hash)
    await go(`#settings/devices/${KITCHEN}`)
    await expect(page.getByTestId("without-phrase").locator("option[value=typesafe]")).toBeEnabled()
    await expect(page.getByTestId("typesafe-unavailable")).toHaveCount(0)
    await page.getByTestId("without-phrase").selectOption("typesafe")
    await saveButton(page).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    await go("#settings/shared/routing")
    await expect(page.getByTestId("routing-used-by")).toContainText("Used by: Kitchen iPad")
    // Switching it off makes the option unavailable again (a device that had it answers nobody without a phrase).
    await page.getByTestId("form-s-routing").locator("[data-field=TYPESAFE_ROUTING]").getByRole("switch").click()
    await saveButton(page).click()
    await expect(page.getByTestId("footer-note")).toContainText("Saved")
    await expect(page.getByTestId("routing-status")).toHaveText("Key set, switched off")
    await go(`#settings/devices/${KITCHEN}`)
    await expect(page.getByTestId("typesafe-unavailable")).toContainText("which is not set up")
    // (The device keeps the choice it has, shown as not set up; another device could not choose it.)
    await expect(page.getByTestId("without-phrase").locator("option[value=typesafe]")).toHaveText("The one that fits: TypeSafe decides (not set up)")
  })
})

test.describe("Diagnostics › Latency", () => {
  test.beforeEach(async () => {
    await mock.scenario("latency")
  })
  const rows = (page: Page) => page.getByTestId("trace-row")
  const row = (page: Page, turn: number) => page.locator(`[data-testid=trace-row][data-turn="${turn}"]`)

  test("ten columns: assistant, device and routing beside the timings; TypeSafe's time and outcome; every route kind", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/diagnostics/latency")
    await expect(rows(page)).toHaveCount(13)
    await expect(page.locator("thead th")).toHaveText(["turn", "assistant", "device", "routing", "1st token", "tts audio", "playback", "audible", "outcome", "tools"])
    const table = page.getByTestId("latency-table")
    await expect(table).toHaveAttribute("data-scrolls", "false")
    // Newest first, each with its assistant and device.
    await expect(rows(page).first()).toContainText("48")
    await expect(row(page, 48).getByTestId("trace-assistant")).toHaveText("Jeff")
    await expect(row(page, 48).getByTestId("trace-device")).toHaveText("iPhone · Safari")
    await expect(row(page, 48)).toContainText("early")
    await expect(row(page, 48).getByTestId("trace-audible")).toHaveText("238")
    // Routing: only TypeSafe asks, and its outcome is under its time.
    await expect(row(page, 48).getByTestId("trace-routing")).toHaveText("")
    await expect(row(page, 46).getByTestId("trace-routing")).toHaveText("")
    await expect(row(page, 45).getByTestId("trace-routing")).toHaveText("138chosen")
    await expect(row(page, 44).getByTestId("trace-routing")).toHaveText("141none fits")
    await expect(row(page, 39).getByTestId("trace-routing")).toHaveText("400timed out")
    await expect(row(page, 38).getByTestId("trace-routing")).toHaveText("212error")
    // Slow turns are coloured (800 ms warn, 1500 ms danger).
    await expect(row(page, 43).getByTestId("trace-audible")).toHaveClass(/text-danger/)
    await expect(row(page, 45).getByTestId("trace-audible")).toHaveClass(/text-warn/)
    await expect(row(page, 47).getByTestId("trace-audible")).toHaveClass(/text-ink-muted/)
    // Medians per assistant (the audible time).
    const summary = page.getByTestId("latency-summary")
    await expect(summary).toContainText("Jeff median")
    await expect(summary).toContainText("T3 median")
    await expect(summary).toContainText("Keuken median")
    const medians = await summary.getByTestId("median-assistant").allInnerTexts()
    expect(medians.map((m) => m.replace(/^·\s*/, ""))).toEqual(["Jeff median 245 ms", "T3 median 612 ms", "Keuken median 931 ms"])
    // A turn with no snapshot says so.
    await row(page, 36).getByTestId("trace-toggle").click()
    await expect(page.getByTestId("trace-facts")).toContainText("not recorded")
  })

  test("filters: by assistant (with the median and worst), by device and by route; and together", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/diagnostics/latency")
    const assistants = page.getByTestId("filter-assistant")
    await assistants.getByRole("radio", { name: "Keuken" }).click()
    await expect(rows(page)).toHaveCount(3)
    await expect(page.getByTestId("latency-summary")).toHaveText("median 931 msworst 1544 ms")
    await expect(page.getByTestId("latency-summary")).not.toContainText("Jeff")
    await assistants.getByRole("radio", { name: "All assistants" }).click()
    await page.getByTestId("filter-device").selectOption({ label: "Kitchen iPad" })
    await expect(rows(page)).toHaveCount(4)
    for (const turn of [39, 43, 44, 45]) await expect(row(page, turn)).toBeVisible()
    // Medians stay per assistant while one device is shown.
    await expect(page.getByTestId("median-assistant")).toHaveCount(2)
    await page.getByTestId("filter-route").selectOption("typesafe")
    await expect(rows(page)).toHaveCount(3)
    await page.getByTestId("filter-route").selectOption("phrase")
    await expect(rows(page)).toHaveCount(1)
    await expect(row(page, 43)).toBeVisible()
    await page.getByTestId("filter-route").selectOption("typed")
    await expect(page.getByTestId("no-match")).toHaveText("No turns match these filters.")
    await page.getByTestId("filter-device").selectOption("all")
    await expect(rows(page)).toHaveCount(1)
    await expect(row(page, 41)).toBeVisible()
    await page.getByTestId("filter-route").selectOption("all")
    await assistants.getByRole("radio", { name: "T3" }).click()
    await expect(rows(page)).toHaveCount(3)
    for (const [route, turns] of [["phrase", [43, 46]], ["armed", [42]], ["follow-up", [40]], ["default", [36, 37, 47, 48]], ["typed", [41]], ["typesafe", [38, 39, 44, 45]]] as const) {
      await assistants.getByRole("radio", { name: "All assistants" }).click()
      await page.getByTestId("filter-route").selectOption(route)
      await expect(rows(page)).toHaveCount(turns.length)
      for (const turn of turns) await expect(row(page, turn)).toBeVisible()
    }
  })

  test("the configuration popover on the assistant's name (hover and focus) and the open row say what it was set to", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/diagnostics/latency")
    const name = row(page, 45).getByTestId("trace-assistant")
    await name.hover()
    const pop = page.getByTestId("trace-popover")
    await expect(pop).toBeVisible()
    await expect(pop).toContainText("Keuken at turn 45 · Kitchen iPad")
    await expect(pop).toContainText("Home model · qwen3-14b · effort low")
    await expect(pop).toContainText("Parakeet v2 · English · end pause 600 ms (Kitchen iPad hears with Jeff's)")
    await expect(pop).toContainText("Pim · on this machine")
    await expect(pop).toContainText("2 modules · 4 tools")
    await expect(pop).toContainText("TypeSafe · 91% · 138 ms")
    await expect(pop.getByTestId("popover-changed")).toHaveCount(0)
    await page.mouse.move(0, 0)
    await expect(pop).toBeHidden()
    // Focus shows it too (keyboard), and it names TypeSafe's fallback when none fits.
    await row(page, 44).getByTestId("trace-assistant").focus()
    await expect(pop).toContainText("TypeSafe · none fits (22%) · 141 ms → Jeff")
    await row(page, 36).getByTestId("trace-toggle").focus()
    await expect(pop).toBeHidden()
    // The turn with no assistant name to hover: no popover; a turn without a snapshot says so in its open row.
    await row(page, 41).getByTestId("trace-toggle").click()
    const detail = page.getByTestId("trace-detail-row")
    await expect(detail).toContainText("Chosen by")
    await expect(detail).toContainText("Typed text")
    await expect(detail.getByRole("link", { name: "Open T3" })).toHaveAttribute("href", /#settings\/assistants\/t3$/)
    await row(page, 41).getByTestId("trace-toggle").click()
    await expect(detail).toHaveCount(0)
  })

  test("changed since: the snapshot differs from the assistant now; changing the assistant adds it live", async ({ page, baseURL }) => {
    await loginAdmin(page, baseURL, "#settings/diagnostics/latency")
    // Turn 41 (T3): the voice was Lessac then, it is Heart now. Turn 42 (Jeff): a bigger model then. Turn 39: Keuken heard it then.
    await row(page, 41).getByTestId("trace-toggle").click()
    await expect(page.getByTestId("changed-since")).toHaveText("Changed since this turn: voice Lessac → Heart")
    await row(page, 41).getByTestId("trace-toggle").click()
    await row(page, 42).getByTestId("trace-assistant").hover()
    await expect(page.getByTestId("popover-changed")).toHaveText("Changed since: model claude-sonnet-5-5 → claude-haiku-5-5; effort medium → low")
    await page.mouse.move(0, 0)
    await row(page, 39).getByTestId("trace-toggle").click()
    await expect(page.getByTestId("changed-since")).toContainText("hearing Keuken's → Jeff's")
    await row(page, 39).getByTestId("trace-toggle").click()
    // An unchanged turn has no marker; a turn without a snapshot cannot say.
    await row(page, 46).getByTestId("trace-toggle").click()
    await expect(page.getByTestId("changed-since")).toHaveCount(0)
    await row(page, 46).getByTestId("trace-toggle").click()
    // Change Jeff's model somewhere else: turn 46 now differs.
    await post("/mock/assistant", { id: "jeff", patch: { llm: { account: "anthropic", model: "claude-opus-5-5", effort: "low", thinking: "off", maxTokens: 1024, giveUpMs: 5000, warmUp: true, useModules: true, freshSessionAfterMinutes: 30 } } })
    await row(page, 46).getByTestId("trace-toggle").click()
    await expect(page.getByTestId("changed-since")).toHaveText("Changed since this turn: model claude-haiku-5-5 → claude-opus-5-5")
  })

  test("a live turn arrives with its assistant, device and route, and a snapshot equal to the assistant now", async ({ page, baseURL, browser }) => {
    await mock.scenario("typed")
    await loginAdmin(page, baseURL, "#settings/diagnostics/latency")
    await expect(page.getByText("No turns yet.")).toBeVisible()
    const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 800 } })
    const voice = await ctx.newPage()
    await voice.goto(appUrl(baseURL))
    await voice.getByTestId("chat-toggle").click()
    await voice.locator("#chat-input").fill("What time is it in Tokyo?")
    await voice.keyboard.press("Enter")
    await expect(rows(page)).toHaveCount(1, { timeout: 15_000 })
    await expect(rows(page).first().getByTestId("trace-assistant")).toHaveText("Jeff")
    await rows(page).first().getByTestId("trace-toggle").click()
    await expect(page.getByTestId("trace-facts")).toContainText("Anthropic API · claude-haiku-5-5 · effort low")
    await expect(page.getByTestId("trace-facts")).toContainText("Typed text")
    await expect(page.getByTestId("changed-since")).toHaveCount(0)
    await ctx.close()
  })
})
