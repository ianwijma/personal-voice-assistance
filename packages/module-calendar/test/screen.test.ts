// What the calendar shows on a screen (docs/modules/calendar.md, "On a screen"; docs/PRESENTING.md): a list of an agenda
// answer and a card for "my next appointment", through the kit's real Presenter on the default household's devices (the
// shared kitchen display of Sam, Robin's private phone, the public hall screen) and a speaker without a screen.
import { assert, describe, it } from "@effect/vitest"
import { closedModulePresent, presentationProblem, type Presentation } from "@pva/core"
import { makeOfflineNet, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { calendarModuleWith } from "../src/index.ts"
import { budgetNotes } from "../src/screen.ts"
import { cutPoints } from "../src/text.ts"
import { advanceAndRefresh, allFixtures, AMS, calendar, everyone, familyOnly, FAMILY, ics, served } from "./fixtures.ts"
import { startShown, type Started } from "./screenKit.ts"

// Each test starts a household and expands whole calendars: allow a slow runner its time.
vi.setConfig({ testTimeout: 30_000 })

const kitchen = { device: "kitchen-display" }
const phone = { device: "robins-phone" }
const hall = { device: "hall-screen" }
const nl = { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: AMS } }

type Page = ReadonlyArray<{ readonly content: { readonly kind: string; readonly title?: string; readonly items?: ReadonlyArray<{ readonly text: string }>; readonly facts?: ReadonlyArray<{ readonly label: string; readonly value: string }>; readonly text?: string } }>
const itemsOf = (page: Page) => (page[0]?.content.items ?? []).map((i) => i.text)
const everything = (x: unknown) => JSON.stringify(x)
const lonely = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Every presentation the module asked for is valid by the Presenter's own checks, and its text has no lone surrogate. */
const assertValid = (p: Presentation, now = Date.UTC(2026, 10, 18, 9, 0, 0)) => {
  assert.isUndefined(presentationProblem(p, now))
  assert.isFalse(lonely.test(everything(p)))
}

describe("calendar: the agenda as a list on the screen of the device that asked", () => {
  it.effect("a shared device (Sam's kitchen display): events in full, Robin's time as busy and nothing else, marked as Sam's", () =>
    Effect.gen(function*() {
      const { kit, asked } = yield* startShown(allFixtures, everyone)
      const answer = yield* kit.tool("calendar_agenda", {}, kitchen)
      // The answer is what it always was: nothing of the screen is in it.
      assert.notInclude(answer.content, "Screen")
      yield* kit.present.settle
      assert.strictEqual(asked.length, 1)
      assert.deepStrictEqual(asked[0]!.target, "origin")
      const p = asked[0]!.presentation
      assert.deepStrictEqual(p, {
        kind: "list",
        title: "Today",
        style: "bullets",
        items: [
          { id: "e1", text: "Standup at half past nine" },
          { id: "e2", text: "Lunch with Marloes at half past twelve" },
          { id: "e3", text: "Swimming lesson at four o'clock" },
          { id: "e4", text: "Gym at seven o'clock" },
          { id: "e5", text: "Robin is busy from two o'clock to three o'clock" }
        ],
        spoken: "Today: Standup at half past nine, Lunch with Marloes at half past twelve, Swimming lesson at four o'clock, Gym at seven o'clock and Robin is busy from two o'clock to three o'clock.",
        sensitivity: { personal: "p-sam" }
      })
      assertValid(p)
      assert.notInclude(everything(p), "Divorce")
      assert.notInclude(everything(p), "Robin's work")
      assert.deepStrictEqual(itemsOf(kit.present.shown("kitchen-display") as Page), p.kind === "list" ? p.items.map((i) => i.text) : [])
      // It is transient, shown on that device alone, and marked as Sam's for the Presenter's decision at the moment of showing.
      const [live] = kit.present.engine.live()
      assert.strictEqual(live?.lifetime, "transient")
      assert.strictEqual(live?.owner, "p-sam")
      assert.deepStrictEqual(live?.target, { device: "kitchen-display" })
      assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
      assert.deepStrictEqual(kit.present.shown("robins-phone"), [])
    }))

  it.effect("the public hall screen is a real candidate: the household's events and a count, no title, name or calendar of a member", () =>
    Effect.gen(function*() {
      const { kit, asked } = yield* startShown(allFixtures, everyone)
      yield* kit.tool("calendar_agenda", { days: 3 }, hall)
      yield* kit.present.settle
      const p = asked[0]!.presentation
      assert.strictEqual(p.kind, "list")
      assert.isUndefined(p.sensitivity)
      for (const word of ["Gym", "Divorce", "Dentist", "Paris", "Robin", "Sam", "lawyer"]) assert.notInclude(everything(p), word)
      assert.include(itemsOf(kit.present.shown("hall-screen") as Page).at(-1), "Personal events not shown here: ")
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "hall-screen" && d.decision.show))
      assertValid(p)
      // Whose calendar by name, or "me", on a public screen is refused (a spoken answer): nothing is shown for it.
      yield* kit.tool("calendar_agenda", { who: "Robin" }, hall)
      yield* kit.tool("calendar_agenda", { who: "me" }, hall)
      assert.strictEqual(asked.length, 1)
    }))

  it.effect("a private phone: one member's events are listed, the other's are counted and not listed", () =>
    Effect.gen(function*() {
      const { kit, asked } = yield* startShown(allFixtures, everyone)
      yield* kit.tool("calendar_agenda", {}, phone)
      yield* kit.present.settle
      const p = asked[0]!.presentation
      assert.deepStrictEqual(p.kind === "list" ? p.items.map((i) => i.text) : [], [
        "Standup at half past nine",
        "Lunch with Marloes at half past twelve",
        "Divorce lawyer at two o'clock",
        "Swimming lesson at four o'clock",
        "Events of other people not shown here: 1."
      ])
      assert.deepStrictEqual(p.sensitivity, { personal: "p-robin" })
      assert.notInclude(everything(p), "Gym")
      // The answer itself has everything, as before.
      assert.include((yield* kit.tool("calendar_agenda", {}, phone)).content, "Gym")
    }))

  it.effect("a device without a screen: the answer is the same, nothing is held, and the decision says why", () =>
    Effect.gen(function*() {
      const household = {
        devices: [
          { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "private" as const, defaultPerson: "p-sam" },
          { id: "office-speaker", name: "Office speaker", room: "Office", privacy: "private" as const, defaultPerson: "p-sam", capabilities: { v: 1 as const, speaker: { media: ["speech" as const] } } }
        ]
      }
      const { kit } = yield* startShown(allFixtures, { ...everyone, household })
      const onScreen = yield* kit.tool("calendar_agenda", {}, kitchen)
      const without = yield* kit.tool("calendar_agenda", {}, { device: "office-speaker" })
      assert.strictEqual(without.content, onScreen.content)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "office-speaker" && !d.decision.show))
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
    }))

  it.effect("where nothing can be shown at all (the command-line modes), the answer is unchanged", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet(allFixtures)
      const base = calendarModuleWith({ resolver: net.resolver, connector: net.connector })
      const closed = { ...base, start: (ctx: Started) => base.start!({ ...ctx, present: closedModulePresent("no screen here") } as never) } as typeof base
      const kit = yield* startTestModule(closed, { settings: everyone.settings })
      yield* advanceAndRefresh(kit, 0)
      const answer = yield* kit.tool("calendar_agenda", {}, kitchen)
      assert.isTrue(answer.ok)
      assert.include(answer.content, "Standup")
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("in Dutch, the same list in the household's words", () =>
    Effect.gen(function*() {
      const { kit, asked } = yield* startShown(allFixtures, { ...everyone, household: { home: nl.home } })
      yield* kit.tool("calendar_agenda", {}, hall)
      yield* kit.present.settle
      const p = asked[0]!.presentation
      assert.deepStrictEqual(p.kind === "list" ? p.items.map((i) => i.text) : [], [
        "Standup om half tien",
        "Lunch with Marloes om half een",
        "Swimming lesson om vier uur",
        "Persoonlijke afspraken die hier niet staan: 2."
      ])
      assert.strictEqual(p.kind === "list" ? p.title : "", "Vandaag")
      assert.strictEqual(p.spoken, "Vandaag: Standup om half tien, Lunch with Marloes om half een en Swimming lesson om vier uur. Persoonlijke afspraken die hier niet staan: 2.")
      assertValid(p)
    }))
})

describe("calendar: a card for my next appointment", () => {
  it.effect("the tool for \"me\" and the typed action show the asking person's next event, marked as theirs", () =>
    Effect.gen(function*() {
      const { kit, asked } = yield* startShown(allFixtures, everyone)
      const said = yield* kit.action("my_next", {}, kitchen)
      // The sentence is what it always was.
      assert.deepStrictEqual(said, { ok: true, say: "Next: Gym, today at seven o'clock." })
      const tool = yield* kit.tool("calendar_next", { who: "me" }, phone)
      assert.notInclude(tool.content, "Screen")
      yield* kit.present.settle
      assert.deepStrictEqual(asked.map((a) => a.presentation), [
        {
          kind: "card",
          title: "Gym",
          facts: [{ label: "When", value: "today at seven o'clock" }, { label: "Calendar", value: "Sam's" }],
          spoken: "Next: Gym, today at seven o'clock.",
          sensitivity: { personal: "p-sam" }
        },
        {
          kind: "card",
          title: "Divorce lawyer",
          facts: [{ label: "When", value: "today at two o'clock" }, { label: "Calendar", value: "Robin's work" }],
          spoken: "Next: Divorce lawyer, today at two o'clock.",
          sensitivity: { personal: "p-robin" }
        }
      ])
      for (const a of asked) assertValid(a.presentation)
      assert.strictEqual(kit.present.shown("kitchen-display")[0]?.content.kind, "card")
    }))

  it.effect("no card for the household's next event, a named event, a refusal or a question; the household's own event has no owner", () =>
    Effect.gen(function*() {
      const { kit, asked } = yield* startShown(allFixtures, everyone)
      yield* kit.action("next_event", {}, kitchen)
      yield* kit.action("when_is", { match: "dentist" }, kitchen)
      yield* kit.tool("calendar_next", { match: "dentist", who: "me" }, kitchen)
      yield* kit.tool("calendar_next", {}, kitchen)
      // "Me" with nobody known asking (the public screen) is a question: nothing to show.
      yield* kit.action("my_next", {}, hall)
      yield* kit.tool("calendar_next", { who: "me" }, hall)
      yield* kit.present.settle
      assert.deepStrictEqual(asked, [])
      assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
    }))

  it.effect("with nothing coming up, a card says so and replaces the earlier one; a place and the notes are on it", () =>
    Effect.gen(function*() {
      const lone = ics([{ uid: "d", summary: "Dentist with a very long name that goes on and on past what a card can hold on one line", start: "20261118T143000", end: "20261118T150000", tz: AMS, location: "Tandartspraktijk" }])
      const { kit, asked } = yield* startShown({ "https://cal.example.org/sam.ics": served(lone) }, { settings: { calendars: [calendar("Sam's", "https://cal.example.org/sam.ics", "Sam")] } })
      yield* kit.action("my_next", {}, kitchen)
      yield* kit.present.settle
      const first = asked[0]!.presentation
      const title = first.kind === "card" ? first.title : ""
      assert.isAtMost(title.length, 60)
      assert.isTrue(title.startsWith("Dentist with a very long name") && title.endsWith("…"))
      assert.deepStrictEqual(first.kind === "card" ? first.facts : [], [
        { label: "When", value: "today at half past two" },
        { label: "Where", value: "Tandartspraktijk" },
        { label: "Calendar", value: "Sam's" }
      ])
      assertValid(first)
      // After the event it is over: nothing coming up, said on the card that takes the place of the earlier one.
      yield* kit.advance(5 * 3_600_000)
      yield* kit.action("my_next", {}, kitchen)
      yield* kit.present.settle
      const none = kit.present.shown("kitchen-display")
      assert.strictEqual(none.length, 1)
      assert.strictEqual(none[0]?.content.kind, "card")
      assert.deepStrictEqual(none[0]?.content, { kind: "card", title: "My next appointment", text: "Nothing coming up on the calendar in the next 62 days.", facts: [] })
    }))

  it.effect("in Dutch the card says When and Where in Dutch", () =>
    Effect.gen(function*() {
      const { kit, asked } = yield* startShown(allFixtures, { ...everyone, household: { home: nl.home } })
      yield* kit.action("my_next", {}, kitchen)
      yield* kit.present.settle
      const p = asked[0]!.presentation
      assert.deepStrictEqual(p.kind === "card" ? p.facts : [], [{ label: "Wanneer", value: "vandaag om zeven uur" }, { label: "Agenda", value: "Sam's" }])
      assert.strictEqual(p.spoken, "Hierna: Gym, vandaag om zeven uur.")
    }))
})

describe("calendar: what a screen shows follows the calendars", () => {
  it.effect("a newer answer takes the device's place; an answer with nothing replaces it too (an empty list)", () =>
    Effect.gen(function*() {
      const { kit } = yield* startShown(allFixtures, familyOnly)
      yield* kit.tool("calendar_agenda", {}, kitchen)
      yield* kit.present.settle
      assert.strictEqual(itemsOf(kit.present.shown("kitchen-display") as Page).length, 3)
      yield* kit.tool("calendar_agenda", { day: "tomorrow" }, kitchen)
      yield* kit.present.settle
      assert.deepStrictEqual(itemsOf(kit.present.shown("kitchen-display") as Page), ["Bins out, all day"])
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      yield* kit.tool("calendar_agenda", { day: "Friday" }, kitchen)
      yield* kit.present.settle
      const [now] = kit.present.shown("kitchen-display")
      assert.deepStrictEqual(now?.content, { kind: "list", title: "Friday: nothing on the calendar.", style: "bullets", items: [] })
    }))

  it.effect("a refresh that changes what the calendars say takes the list down; one that changes nothing leaves it", () =>
    Effect.gen(function*() {
      let body = FAMILY
      // The refresh is due at seven past the hour; the list is shown 20 seconds before it and lives 30.
      const changed = yield* startShown({ "https://cal.example.org/family.ics": () => served(body) }, familyOnly)
      yield* advanceAndRefresh(changed.kit, 6 * 60_000 + 40_000)
      yield* changed.kit.tool("calendar_agenda", {}, kitchen)
      yield* changed.kit.present.settle
      assert.strictEqual(changed.kit.present.shown("kitchen-display").length, 1)
      body = ics([{ uid: "film", summary: "Film night", start: "20261118T200000", end: "20261118T220000", tz: AMS }])
      yield* advanceAndRefresh(changed.kit, 25_000)
      yield* changed.kit.present.settle
      // 5 seconds after the refresh, 25 before the list would have ended by itself: it was taken down by the refresh.
      assert.deepStrictEqual(changed.kit.present.shown("kitchen-display"), [])
      assert.deepStrictEqual(changed.kit.present.engine.live(), [])

      const same = yield* startShown({ "https://cal.example.org/family.ics": (req) => (req.headers["if-none-match"] === "\"v1\"" ? { status: 304 } : served(FAMILY, { etag: "\"v1\"" })) }, familyOnly)
      yield* advanceAndRefresh(same.kit, 6 * 60_000 + 40_000)
      yield* same.kit.tool("calendar_agenda", {}, kitchen)
      yield* same.kit.present.settle
      yield* advanceAndRefresh(same.kit, 25_000)
      yield* same.kit.present.settle
      assert.strictEqual(same.kit.present.shown("kitchen-display").length, 1)
    }), 60_000)

  it.effect("a transient list ends by itself; and when the module stops, what it showed leaves the screen", () =>
    Effect.gen(function*() {
      const { kit } = yield* startShown(allFixtures, familyOnly)
      yield* kit.tool("calendar_agenda", {}, kitchen)
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      yield* kit.advance(31_000)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      yield* kit.tool("calendar_agenda", {}, kitchen)
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      yield* kit.stop
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))
})

describe("calendar: the bounds, and the notes of the answer on the presentation", () => {
  it.effect("thirty events: whole items inside twelve, an honest \"and 19 more\", every line within its bound, emoji at the cut safe", () =>
    Effect.gen(function*() {
      const many = ics(Array.from({ length: 30 }, (_, i) => ({
        uid: `e${i}`,
        summary: i % 3 === 0 ? "😀".repeat(50) : i % 3 === 1 ? `${"x".repeat(58)}😀 ${i}` : `Meeting ${i}`,
        start: `20261118T${String(8 + Math.floor(i / 6)).padStart(2, "0")}${String((i % 6) * 10).padStart(2, "0")}00`,
        end: `20261118T${String(8 + Math.floor(i / 6)).padStart(2, "0")}${String((i % 6) * 10 + 5).padStart(2, "0")}00`,
        tz: AMS
      })))
      const { kit, asked } = yield* startShown({ "https://cal.example.org/m.ics": served(many) }, { settings: { calendars: [calendar("Many", "https://cal.example.org/m.ics")] } })
      yield* kit.tool("calendar_agenda", {}, kitchen)
      yield* kit.present.settle
      const p = asked[0]!.presentation
      assertValid(p)
      assert.strictEqual(p.kind, "list")
      const items = p.kind === "list" ? p.items.map((i) => i.text) : []
      assert.strictEqual(items.length, 12)
      assert.strictEqual(items.at(-1), "and 19 more")
      for (const t of items) assert.isAtMost(t.length, 80)
      assert.isAtMost(p.spoken.length, 300)
      // Spoken, the first four and the true total of the rest.
      assert.match(p.spoken, / and 26 more\.$/)
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
    }))

  it.effect("a day read only in part says so on the list, with \"at least\", and in the spoken text", () =>
    Effect.gen(function*() {
      const crowded = ics(Array.from({ length: 205 }, (_, i) => ({ uid: `c${i}`, summary: `Slot ${i}`, start: "20261118T110000", end: "20261118T111000", tz: AMS })))
      const { kit, asked } = yield* startShown({ "https://cal.example.org/c.ics": served(crowded) }, { settings: { calendars: [calendar("Slots", "https://cal.example.org/c.ics")] } })
      yield* kit.tool("calendar_agenda", {}, kitchen)
      yield* kit.present.settle
      const p = asked[0]!.presentation
      assertValid(p)
      const items = p.kind === "list" ? p.items.map((i) => i.text) : []
      assert.strictEqual(items.at(-1), "Read in part; there may be more.")
      assert.strictEqual(items.at(-2), "and at least 190 more")
      assert.include(p.spoken, "Read in part; there may be more.")
    }))

  it.effect("a calendar that could not be refreshed or read in part: the card and the list say so, the spoken text too, without naming a personal calendar", () =>
    Effect.gen(function*() {
      let down = false
      const { kit, asked } = yield* startShown({
        "https://cal.example.org/family.ics": () => (down ? { status: 500, ...served("BEGIN:VCALENDAR") } : served(FAMILY)),
        "https://cal.example.org/sam.ics": served(ics([{ uid: "g", summary: "Gym", start: "20261118T190000", end: "20261118T200000", tz: AMS }, { uid: "bad", summary: "Bad", start: "20261318T190000", end: "20261318T200000", tz: AMS }]))
      }, { settings: { calendars: [calendar("Family", "https://cal.example.org/family.ics"), calendar("Sam's", "https://cal.example.org/sam.ics", "Sam")] } })
      down = true
      yield* advanceAndRefresh(kit, 3_600_000)
      yield* kit.tool("calendar_agenda", {}, hall)
      yield* kit.action("my_next", {}, kitchen)
      yield* kit.present.settle
      const [list, card] = asked.map((a) => a.presentation)
      assertValid(list!)
      assertValid(card!)
      const lines = list!.kind === "list" ? list!.items.map((i) => i.text) : []
      assert.isTrue(lines.some((l) => l.startsWith("Not refreshed since ")), lines.join("|"))
      // The notes, in the answer's order, and no calendar named where its events may not be shown.
      assert.deepStrictEqual(lines.slice(3), ["Personal events not shown here: 1.", "Not refreshed since today at ten o'clock.", "Some events could not be read: 1."])
      assert.include(list!.spoken, "Some events could not be read: 1.")
      assert.include(list!.spoken, "Not refreshed since ")
      assert.notInclude(everything(list), "Sam")
      // The card for Sam on the kitchen display: his own calendar read in part is said without any title hidden.
      assert.strictEqual(card!.kind, "card")
      assert.include(card!.kind === "card" ? (card!.text ?? "") : "", "Some events could not be read: 1.")
      assert.include(card!.spoken, "Some events could not be read: 1.")
    }), 60_000)

  it("notes that do not fit are kept whole or replaced by one line saying there are more, never cut through", () => {
    const notes = ["a".repeat(100), "b".repeat(100), "c".repeat(100)]
    assert.deepStrictEqual(budgetNotes(notes, 400, "MORE", 1), notes)
    assert.deepStrictEqual(budgetNotes(notes, 250, "MORE", 1), [notes[0], notes[1], "MORE"])
    assert.deepStrictEqual(budgetNotes(notes, 150, "MORE", 1), [notes[0], "MORE"])
    assert.deepStrictEqual(budgetNotes(notes, 4, "MORE", 1), ["MORE"])
    assert.deepStrictEqual(budgetNotes(notes, 3, "MORE", 1), [])
  })

  it("a cut is at a code point boundary inside the limit, marked", () => {
    for (const max of [59, 60, 61]) {
      const cut = cutPoints("😀".repeat(40), max, true)
      assert.isAtMost(cut.length, max)
      assert.isTrue(cut.endsWith("…"))
      assert.isFalse(lonely.test(cut))
    }
    assert.strictEqual(cutPoints("short", 60, true), "short")
  })

  it.effect("a title of 59 letters and an emoji (61 units) is a valid card title", () =>
    Effect.gen(function*() {
      const lone = ics([{ uid: "d", summary: `${"x".repeat(59)}😀`, start: "20261118T143000", end: "20261118T150000", tz: AMS, location: `${"y".repeat(59)}😀` }])
      const { kit, asked } = yield* startShown({ "https://cal.example.org/sam.ics": served(lone) }, { settings: { calendars: [calendar("Sam's", "https://cal.example.org/sam.ics", "Sam")] } })
      yield* kit.action("my_next", {}, kitchen)
      yield* kit.present.settle
      const p = asked[0]!.presentation
      assertValid(p)
      assert.strictEqual(p.kind === "card" ? p.title : "", `${"x".repeat(59)}…`)
      assert.strictEqual(p.kind === "card" ? p.facts?.[1]?.value : "", `${"y".repeat(59)}…`)
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
    }))
})
