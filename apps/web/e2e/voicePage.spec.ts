import { appUrl, deviceIdOf, expect, expectVisualState, gotoAdmin, mock, test } from "./fixtures.ts"

// The voice page with assistants (docs/ASSISTANTS.md §7.2, WP-8): the assistant menu in the top bar, the strip naming who
// has the turn, one conversation per assistant with a switcher, and the sheet's Assistant group. The mock's web-voice
// defaults: Jeff answers without a phrase, T3 is woken by "Hey T3" / "Hey tee three", and the device lets people pick.

test.beforeEach(async () => {
  await mock.scenario("typed")
})

const menuButton = (page: import("@playwright/test").Page) => page.getByTestId("assistant-menu-button")
const messages = async (type: string) => (await mock.log()).messages.filter((m) => m.type === type)

test.describe("the assistant menu in the top bar", () => {
  test("names the answering assistant and lists the device's assistants with how each is reached", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await expect(menuButton(page)).toHaveText("Jeff")
    await menuButton(page).click()
    const menu = page.getByTestId("assistant-menu-button-menu")
    await expect(menu.getByRole("menuitemradio")).toHaveCount(3) // Jeff, T3, Nobody (no "Whichever fits" without the decision service)
    await expect(menu.getByTestId("assistant-jeff")).toHaveAttribute("aria-checked", "true")
    await expect(menu.getByTestId("assistant-jeff")).toContainText("Answers without a phrase")
    await expect(menu.getByTestId("assistant-t3")).toContainText("Say “Hey T3” or “Hey tee three”")
    await expect(menu.getByTestId("assistant-nobody")).toContainText("Sleeps until it hears a phrase")
    await expect(menu).toContainText("This decides who answers without a phrase on this device.")
    // The checked item has the focus; Esc closes the menu and gives the focus back.
    await expect(menu.getByTestId("assistant-jeff")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(menu).toBeHidden()
    await expect(menuButton(page)).toBeFocused()
  })

  test("arrow keys move through the items; Home and End jump; Tab closes", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await menuButton(page).focus()
    await page.keyboard.press("ArrowDown") // opens it on the checked item
    const menu = page.getByTestId("assistant-menu-button-menu")
    await expect(menu.getByTestId("assistant-jeff")).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(menu.getByTestId("assistant-t3")).toBeFocused()
    await page.keyboard.press("End")
    await expect(menu.getByTestId("assistant-nobody")).toBeFocused()
    await page.keyboard.press("ArrowDown") // wraps
    await expect(menu.getByTestId("assistant-jeff")).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(menu).toBeHidden()
  })

  test("picking sends device.pick, changes withoutPhrase, and the admin state of the device shows it", async ({ page, baseURL, context }) => {
    await page.goto(appUrl(baseURL))
    await expect(menuButton(page)).toHaveText("Jeff")
    const id = await deviceIdOf(page)
    await menuButton(page).click()
    await page.getByTestId("assistant-t3").click()
    await expect(menuButton(page)).toHaveText("T3")
    await expect(menuButton(page)).toBeFocused()
    await expect.poll(async () => (await messages("device.pick")).map((m) => m.withoutPhrase)).toEqual(["t3"])

    // Device-wide and persistent: admin sees the device's own value; a reload still names T3.
    const admin = await context.newPage()
    await gotoAdmin(admin, baseURL, "#settings/devices")
    await expect
      .poll(() => admin.evaluate((d) => {
        const client = (window as unknown as { __pva: { store: { get: () => { devices: ReadonlyArray<{ id: string; own: { withoutPhrase?: unknown } }> } } } }).__pva
        return client.store.get().devices.find((x) => x.id === d)?.own.withoutPhrase
      }, id))
      .toEqual({ mode: "assistant", assistant: "t3" })
    await page.reload()
    await expect(menuButton(page)).toHaveText("T3")
    await menuButton(page).click()
    await expect(page.getByTestId("assistant-t3")).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("assistant-t3")).toContainText("Answers without a phrase")
    await expect(page.getByTestId("assistant-jeff")).toContainText("No phrase on this device") // Jeff has none, and no longer answers without one
  })

  test("Nobody: the device sleeps until a phrase, and the label says which", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").click()
    await expectVisualState(page, "listening")
    await menuButton(page).click()
    await page.getByTestId("assistant-nobody").click()
    await expectVisualState(page, "asleep")
    await expect(menuButton(page)).toHaveText("Jeff · T3")
    await expect(page.getByTestId("state-label")).toHaveText("Say “Hey T3”") // only T3 has a phrase
    await menuButton(page).click()
    await expect(page.getByTestId("assistant-nobody")).toHaveAttribute("aria-checked", "true")
  })

  test("Whichever fits is offered only where the decision service is set up; picking it shows Auto", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await menuButton(page).click()
    await expect(page.getByTestId("assistant-typesafe")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await mock.typesafe(true)
    await menuButton(page).click()
    await expect(page.getByTestId("assistant-typesafe")).toContainText("Each thing you say goes to the assistant it suits.")
    await page.getByTestId("assistant-typesafe").click()
    await expect(menuButton(page)).toHaveText("Auto")
    expect((await messages("device.pick")).map((m) => m.withoutPhrase)).toEqual(["typesafe"])
  })

  test("a refused pick is told (and nothing changes)", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await expect(menuButton(page)).toHaveText("Jeff")
    await mock.device({ voicePage: { pick: false } }) // admin switches picking off while the menu is open on this page
    await expect(page.getByTestId("assistant-menu-button")).toHaveCount(0)
    const result = await page.evaluate(async () => {
      const client = (window as unknown as { __pva: { pickAssistant: (v: string) => Promise<{ ok: boolean; error?: { code: string } }> } }).__pva
      return client.pickAssistant("t3")
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("not_allowed")
    await expect(page.getByTestId("assistant-name")).toHaveText("Jeff")
  })

  test("no menu when the device does not let people pick: the name is shown, and the sheet lists the assistants", async ({ page, baseURL }) => {
    await mock.device({ voicePage: { pick: false } })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("assistant-name")).toHaveText("Jeff")
    await expect(menuButton(page)).toHaveCount(0)
    await page.getByTestId("settings-toggle").click()
    const sheet = page.getByTestId("voice-sheet")
    await expect(sheet.getByTestId("assistant-choices")).toHaveCount(0)
    await expect(sheet.getByTestId("assistant-list")).toContainText("Jeff")
    await expect(sheet.getByTestId("assistant-list")).toContainText("T3")
    await expect(sheet).toContainText("Who answers, phrases and follow-up are changed in admin.")
  })

  test("no menu with one assistant, and the chat has no switcher", async ({ page, baseURL }) => {
    await mock.device({ assistants: [{ assistant: "jeff", phrases: [] }] })
    await page.goto(appUrl(baseURL))
    await expect(page.getByTestId("assistant-name")).toHaveText("Jeff")
    await expect(menuButton(page)).toHaveCount(0)
    await page.keyboard.press("c")
    await expect(page.getByTestId("conversation-switcher")).toHaveCount(0)
    await expect(page.getByTestId("chat-panel").getByRole("heading", { name: "Conversation", exact: true })).toBeVisible()
    await expect(page.getByTestId("conversation-note")).toHaveCount(0)
    await expect(page.locator("#chat-input")).toHaveAttribute("placeholder", "Type a message")
    await expect(page.getByTestId("new-conversation")).toHaveAttribute("aria-label", "New conversation")
    // Even the only assistant is named on its replies.
    await expect(page.getByTestId("assistant-label").first()).toHaveText("Jeff")
  })

  test("the device's setup follows admin live: a new assistant list reaches the open page", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await expect(menuButton(page)).toHaveText("Jeff")
    await mock.device({ assistants: [{ assistant: "t3", phrases: [] }, { assistant: "jeff", phrases: ["hey jeff"] }], withoutPhrase: { mode: "assistant", assistant: "t3" } })
    await expect(menuButton(page)).toHaveText("T3")
    await menuButton(page).click()
    await expect(page.getByTestId("assistant-menu-button-menu").getByRole("menuitemradio").first()).toContainText("T3")
  })
})

test.describe("the strip names who has the turn", () => {
  test("a phrase in the sentence: the turn is T3's, from thinking to the follow-up", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").click()
    await expectVisualState(page, "listening")
    const label = page.getByTestId("state-label")
    await expect(label).toHaveText("Listening") // Jeff answers without a phrase: no name
    await mock.turn({ assistantId: "t3", phrase: "hey t3" })
    await expect(label).toHaveText("Thinking · T3", { timeout: 8000 })
    await expect(menuButton(page)).toHaveText("T3")
    await expect(label).toHaveText("Speaking · T3", { timeout: 8000 })
    await expectVisualState(page, "listening", 20_000)
    await expect(label).toHaveText("Listening… · T3") // T3 keeps the turn for its follow-up
    // The conversation of the turn is T3's, not Jeff's.
    await page.keyboard.press("c")
    await expect(page.getByTestId("conversation-switcher")).toHaveText("Conversation with T3")
    await expect(page.getByTestId("turn").last()).toContainText("assistant menu")
    await expect(page.getByTestId("assistant-label").last()).toHaveText("T3")
  })

  test("the phrase alone arms T3: Listening… · T3, and the top bar says T3; picking clears it", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").click()
    await expectVisualState(page, "listening")
    await mock.wake("hey t3", true)
    await expect(page.getByTestId("state-label")).toHaveText("Listening… · T3")
    await expect(menuButton(page)).toHaveText("T3")
    await menuButton(page).click()
    await expect(page.getByTestId("assistant-t3")).toContainText("answering now")
    await page.getByTestId("assistant-jeff").click()
    await expect(menuButton(page)).toHaveText("Jeff")
    await expect(page.getByTestId("state-label")).toHaveText("Listening")
  })

  test("Whichever fits: the assistant it chose is named, and the top bar says Auto between turns", async ({ page, baseURL }) => {
    await mock.typesafe(true)
    await mock.device({ withoutPhrase: { mode: "typesafe", fallback: "jeff", giveUpMs: 400 } })
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").click()
    await expectVisualState(page, "listening")
    await expect(menuButton(page)).toHaveText("Auto")
    await expect(page.getByTestId("state-label")).toHaveText("Listening")
    await mock.turn({ assistantId: "t3" })
    await expect(page.getByTestId("state-label")).toHaveText("Speaking · T3", { timeout: 10_000 })
    await expect(menuButton(page)).toHaveText("T3")
  })

  test("asleep with more phrases than fit: the label says so, and where to find them", async ({ page, baseURL }) => {
    await mock.device({
      assistants: [{ assistant: "jeff", phrases: ["hey jeff"] }, { assistant: "t3", phrases: ["hey t3"] }, { assistant: "keuken", phrases: ["hé keuken"] }],
      withoutPhrase: { mode: "nobody" }
    })
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").click()
    await expectVisualState(page, "asleep")
    await expect(page.getByTestId("state-label")).toHaveText("Say a wake phrase")
    await expect(page.getByTestId("asleep-hint")).toContainText("the menu at the top left lists them")
    await expect(menuButton(page)).toHaveText("3 assistants")
  })
})

test.describe("one conversation per assistant", () => {
  const openChat = async (page: import("@playwright/test").Page, baseURL: string | undefined) => {
    await page.goto(appUrl(baseURL))
    await expect(menuButton(page)).toHaveText("Jeff")
    await page.keyboard.press("c")
    await expect(page.getByTestId("chat-panel")).toBeVisible()
  }
  const switchTo = async (page: import("@playwright/test").Page, name: string) => {
    await page.getByTestId("conversation-switcher").click()
    await page.getByTestId("conversation-switcher-menu").getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click()
    await expect(page.getByTestId("conversation-switcher")).toHaveText(`Conversation with ${name}`)
  }

  test("the chat starts on the answering assistant's conversation; the switcher reads another one without changing who answers", async ({ page, baseURL }) => {
    await openChat(page, baseURL)
    await expect(page.getByTestId("conversation-switcher")).toHaveText("Conversation with Jeff")
    await expect(page.getByTestId("turn")).toHaveCount(2)
    await expect(page.getByTestId("conversation-note")).toHaveText("Each assistant keeps its own conversation on this device.")
    await page.getByTestId("conversation-switcher").click()
    const menu = page.getByTestId("conversation-switcher-menu")
    await expect(menu.getByRole("menuitemradio")).toHaveCount(2)
    await expect(menu).toContainText("Reading a conversation does not change who answers.")
    await expect(menu.getByRole("menuitemradio").nth(1)).toContainText("exchange") // T3's: "2 exchanges"
    await page.keyboard.press("Escape")

    await switchTo(page, "T3")
    await expect(page.getByTestId("turn")).toHaveCount(2)
    await expect(page.getByTestId("turn").first()).toContainText("voice sessions thread")
    await expect(page.getByTestId("assistant-label").first()).toHaveText("T3")
    await expect(page.locator("#chat-input")).toHaveAttribute("placeholder", "Type a message to T3")
    // Nobody's turn changed: the top bar still says Jeff, no device.pick was sent, and the note says where speech goes.
    await expect(menuButton(page)).toHaveText("Jeff")
    expect(await messages("device.pick")).toEqual([])
    expect(await messages("conversation.read")).toHaveLength(1)
    await expect(page.getByTestId("conversation-note")).toHaveText("Typed messages go to T3. Speaking still reaches Jeff.")
    // Closing the chat goes back to the answering assistant.
    await page.getByRole("button", { name: "Close conversation" }).click()
    await page.keyboard.press("c")
    await expect(page.getByTestId("conversation-switcher")).toHaveText("Conversation with Jeff")
    await expect(page.getByTestId("turn").first()).toContainText("weather")
  })

  test("typed text goes to the conversation that is shown", async ({ page, baseURL }) => {
    await openChat(page, baseURL)
    await switchTo(page, "T3")
    await page.locator("#chat-input").fill("What time is it in Tokyo?")
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await messages("text.send")).map((m) => m.assistantId)).toEqual(["t3"])
    await expect(page.getByTestId("turn")).toHaveCount(3)
    await expect(page.getByTestId("turn").last()).toContainText("twenty past four", { timeout: 6000 })
    await expect(page.getByTestId("turn").last().getByTestId("assistant-label")).toHaveText("T3")
    // Jeff's conversation does not have it.
    await switchTo(page, "Jeff")
    await expect(page.getByTestId("turn")).toHaveCount(2)
    await expect(page.getByTestId("chat-panel")).not.toContainText("Tokyo")
    await page.locator("#chat-input").fill("hello Jeff")
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await messages("text.send")).map((m) => m.assistantId)).toEqual(["t3", "jeff"])
    // Reading T3's again shows its three exchanges (the server's, fresh).
    await switchTo(page, "T3")
    await expect(page.getByTestId("turn")).toHaveCount(3)
    await expect(page.getByTestId("chat-panel")).not.toContainText("hello Jeff")
  })

  test("a new conversation for one assistant leaves the other's chat intact", async ({ page, baseURL }) => {
    await openChat(page, baseURL)
    await switchTo(page, "T3")
    const aria = await page.getByTestId("new-conversation").getAttribute("aria-label")
    expect(aria).toBe("New conversation with T3 (Jeff keeps its own)")
    await page.getByTestId("new-conversation").click()
    await expect.poll(async () => (await messages("conversation.new")).map((m) => m.assistantId)).toEqual(["t3"])
    await expect(page.getByTestId("turn")).toHaveCount(0)
    await expect(page.getByTestId("conversation-divider")).toHaveText("New conversation")
    // Jeff's is as it was; T3's stays empty with its divider.
    await switchTo(page, "Jeff")
    await expect(page.getByTestId("turn")).toHaveCount(2)
    await expect(page.getByTestId("conversation-divider")).toHaveCount(0)
    await switchTo(page, "T3")
    await expect(page.getByTestId("turn")).toHaveCount(0)
    await expect(page.getByTestId("conversation-divider")).toHaveText("New conversation")
    // ... and a conversation of the one that answers restarts only that one.
    await switchTo(page, "Jeff")
    await page.getByTestId("new-conversation").click()
    await expect.poll(async () => (await messages("conversation.new")).map((m) => m.assistantId)).toEqual(["t3", "jeff"])
    await expect(page.getByTestId("turn")).toHaveCount(0)
    await switchTo(page, "T3")
    await expect(page.getByTestId("turn")).toHaveCount(0)
    await expect(page.getByTestId("conversation-divider")).toHaveText("New conversation")
  })

  test("an assistant's turn is filed under its own conversation while the chat shows another", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await page.getByTestId("start").click()
    await expectVisualState(page, "listening")
    await page.keyboard.press("c")
    await expect(page.getByTestId("conversation-switcher")).toHaveText("Conversation with Jeff")
    await expect(page.getByTestId("turn")).toHaveCount(2)
    // T3 answers while the chat is on Jeff's: the turn does not appear there, and the switcher says T3 now has the turn.
    await mock.turn({ assistantId: "t3", phrase: "hey t3" })
    await expectVisualState(page, "speaking", 10_000)
    await expect(page.getByTestId("conversation-switcher")).toHaveText("Conversation with T3") // the chat follows the answering assistant
    await expectVisualState(page, "listening", 20_000)
    await expect(page.getByTestId("turn")).toHaveCount(3)
    // The other side: view Jeff's explicitly; it has its own two.
    await switchTo(page, "Jeff")
    await expect(page.getByTestId("turn")).toHaveCount(2)
    await expect(page.getByTestId("conversation-note")).toContainText("Typed messages go to Jeff. Speaking still reaches T3.")
  })

  test("a conversation reset for one assistant clears only that one (a new conversation from another tab of the device)", async ({ page, baseURL }) => {
    await openChat(page, baseURL)
    await mock.send([{ type: "conversation", id: "conv-t3-fresh", reason: "new", startedAt: Date.now(), assistantId: "t3" }])
    await expect(page.getByTestId("turn")).toHaveCount(2) // Jeff's chat is untouched
    await expect(page.getByTestId("conversation-divider")).toHaveCount(0)
    await mock.send([{ type: "conversation", id: "conv-jeff-fresh", reason: "idle", startedAt: Date.now(), assistantId: "jeff" }])
    await expect(page.getByTestId("turn")).toHaveCount(0)
    await expect(page.getByTestId("conversation-divider")).toHaveAttribute("data-reason", "idle")
  })
})

test.describe("the settings sheet", () => {
  test("Assistant, Microphone, Speaker, More, Admin: no Voice, no Activation, no follow-up time", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await page.getByTestId("settings-toggle").click()
    const sheet = page.getByTestId("voice-sheet")
    await expect(sheet.getByRole("heading", { level: 3 })).toHaveText(["Assistant", "Microphone", "Speaker"])
    await expect(sheet.getByTestId("sheet-more")).toBeVisible()
    await expect(sheet.getByTestId("admin-link")).toBeVisible()
    await expect(sheet.getByRole("heading", { name: "Activation" })).toHaveCount(0)
    await expect(sheet.getByRole("heading", { name: "Voice", exact: true })).toHaveCount(0)
    await expect(sheet.getByLabel("Keep listening after a reply")).toHaveCount(0)
    await expect(sheet.getByTestId("wake-phrases")).toHaveCount(0)
    // The choices: each assistant with its purpose and how it is reached, then Nobody.
    const choices = sheet.getByTestId("assistant-choices")
    await expect(choices.getByRole("radio")).toHaveCount(3)
    await expect(choices.getByTestId("sheet-assistant-jeff")).toBeChecked()
    await expect(choices).toContainText("Everyday questions and the house.")
    await expect(choices).toContainText("Answers without a phrase")
    await expect(choices).toContainText("Say “Hey T3” or “Hey tee three”")
    await expect(choices).toContainText("Sleeps until it hears a phrase")
    await expect(sheet).toContainText("This decides who answers without a phrase on this device, for everyone who uses it.")
    await expect(sheet).toContainText("Phrases and follow-up are changed in admin.")
  })

  test("choosing there is the same pick as in the menu, and says when it is used", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await page.getByTestId("settings-toggle").click()
    const sheet = page.getByTestId("voice-sheet")
    await sheet.getByTestId("sheet-assistant-t3").click() // the server's setup moves the choice, so it is checked a moment later
    await expect(sheet.getByTestId("assistant-saved")).toHaveText("Used from the next thing you say.")
    await expect(sheet.getByTestId("sheet-assistant-t3")).toBeChecked()
    expect((await messages("device.pick")).map((m) => m.withoutPhrase)).toEqual(["t3"])
    await page.keyboard.press("Escape")
    await expect(menuButton(page)).toHaveText("T3")
  })

  test("a refused choice stays next to the control", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL))
    await page.getByTestId("settings-toggle").click()
    await mock.device({ voicePage: { pick: false } })
    // The page's setup now says no: the choices turn into the list (nothing to pick); a stale pick is refused by the server.
    await expect(page.getByTestId("voice-sheet").getByTestId("assistant-list")).toBeVisible()
  })
})
