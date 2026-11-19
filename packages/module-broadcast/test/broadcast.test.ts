import { assert, describe, it } from "@effect/vitest"
import { type ModuleNotify, type SpeechTarget, SpeechError } from "@pva/core"
import { checkModule, KIT_PAGE_CAPABILITIES, startTestModule, type TestDevice } from "@pva/core/testing"
import { Effect } from "effect"
import { MAX_CARDS, MAX_TARGETS, broadcastModule, catalog } from "../src/index.ts"
import { texts } from "../src/texts.ts"
import { matchRoom, meansEveryone, roomKey } from "../src/rooms.ts"

const { speaker: _speaker, ...NO_SPEAKER } = KIT_PAGE_CAPABILITIES
const PAGE = KIT_PAGE_CAPABILITIES
const SPEAKER_ONLY: typeof KIT_PAGE_CAPABILITIES = { v: 1, speaker: { media: ["speech", "audio"] }, microphone: { farField: false } }

/** A house with several rooms: a screen that cannot speak, a speaker with no screen, a public hall screen, a phone. */
const HOUSE: ReadonlyArray<TestDevice> = [
  { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam", capabilities: PAGE },
  { id: "kitchen-speaker", name: "Kitchen speaker", room: "Kitchen", capabilities: SPEAKER_ONLY },
  { id: "study-tablet", name: "Study tablet", room: "Study", capabilities: PAGE },
  { id: "kids-tablet", name: "Kids tablet", room: "Kids' room", capabilities: PAGE },
  { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: null, capabilities: PAGE },
  { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private", defaultPerson: "p-robin", capabilities: PAGE },
  { id: "garage-screen", name: "Garage screen", room: "Garage", capabilities: NO_SPEAKER },
  { id: "attic-node", name: "Attic node", room: "Attic", connected: false, capabilities: PAGE }
]

/** The module with its notification handle kept, so a test can set do not disturb as the house's owner does. */
const withNotify = (parts: { notify?: ModuleNotify }): typeof broadcastModule => ({
  ...broadcastModule,
  shared: (ctx) =>
    Effect.sync(() => {
      parts.notify = ctx.notify
      return { value: undefined }
    })
})

const said = (r: { readonly value: unknown }): string => (r.value as { spoken: string }).spoken
const where = (kit: { notify: { announced: ReadonlyArray<{ deviceId: string }> } }) => kit.notify.announced.map((a) => a.deviceId).sort()

describe("broadcast", () => {
  it.effect("conforms: accepted by the host, off by default, texts in both languages with the same placeholders", () =>
    Effect.gen(function*() {
      for (const definition of catalog) yield* checkModule(definition, { texts, household: { devices: HOUSE } })
    }))

  it.effect("to everyone: the other devices are announced on with a chime, never the device that asked; the card goes to screens", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: { devices: HOUSE } })
      const r = yield* kit.tool("broadcast_send", { message: "Dinner is ready" }, { device: "kitchen-display" })
      yield* kit.advance(5_000)
      // The asking device is not in the list, and each announcement carries the chime.
      assert.deepStrictEqual(where(kit), ["hall-screen", "kids-tablet", "kitchen-speaker", "robins-phone", "study-tablet"])
      assert.isTrue(kit.notify.announced.every((a) => a.cue && a.text === "Dinner is ready" && a.outcome === "spoken"))
      // The answer says where it was queued and where it was not: the garage screen cannot speak, the attic is offline.
      assert.strictEqual(
        said(r),
        "Announcing on Hall screen, Kids tablet and three more. Not announced on Attic node (not connected) and Garage screen (cannot speak). Also showing it on Garage screen, Hall screen and three more."
      )
      yield* kit.present.settle
      // The card is on the screens that got it (and on the garage screen that cannot speak it), not on the asking device.
      const card = kit.present.shown("study-tablet")[0]
      assert.strictEqual(card?.content.kind, "card")
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.deepStrictEqual(kit.present.shown("garage-screen").length, 1)
      assert.deepStrictEqual(kit.present.shown("attic-node"), [])
    }))

  it.effect("the card says what was said, from which device, and is a transient one", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: { devices: HOUSE } })
      yield* kit.tool("broadcast_send", { message: "Lights out", room: "Kids' room" }, { device: "kitchen-display" })
      yield* kit.present.settle
      const [card] = kit.present.shown("kids-tablet")
      assert.deepStrictEqual(card?.content, {
        kind: "card",
        title: "Announcement for Kids' room",
        text: "Lights out",
        facts: [{ label: "From", value: "Kitchen display" }]
      })
      assert.strictEqual(card?.lifetime, "transient")
    }))

  it.effect("to one room: only that room's other devices; a room's name is text, resolved against the devices' rooms", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: { devices: HOUSE } })
      const r = yield* kit.tool("broadcast_send", { message: "Coming in five", room: "the kitchen" }, { device: "study-tablet" })
      yield* kit.advance(5_000)
      assert.deepStrictEqual(where(kit), ["kitchen-display", "kitchen-speaker"])
      assert.strictEqual(said(r), "Announcing on Kitchen display and Kitchen speaker. Also showing it on Kitchen display.")
      yield* kit.tool("broadcast_send", { message: "Lights out", room: "kids room" }, { device: "study-tablet" })
      yield* kit.advance(5_000)
      assert.deepStrictEqual(where(kit).filter((d) => d === "kids-tablet"), ["kids-tablet"])
    }))

  it.effect("a room that matches nothing, or two rooms: it asks, and announces nowhere", () =>
    Effect.gen(function*() {
      const two: ReadonlyArray<TestDevice> = [
        { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", capabilities: PAGE },
        { id: "master-bed", name: "Master tablet", room: "Master bedroom", capabilities: PAGE },
        { id: "guest-bed", name: "Guest tablet", room: "Guest bedroom", capabilities: PAGE }
      ]
      const kit = yield* startTestModule(broadcastModule, { household: { devices: two } })
      const none = yield* kit.tool("broadcast_send", { message: "Hello", room: "Garden" }, { device: "kitchen-display" })
      assert.strictEqual(said(none), "I don't know a room called Garden. The rooms are Guest bedroom, Kitchen and Master bedroom.")
      const several = yield* kit.tool("broadcast_send", { message: "Hello", room: "bedroom" }, { device: "kitchen-display" })
      assert.strictEqual(said(several), "Which room do you mean: Guest bedroom and Master bedroom?")
      yield* kit.advance(5_000)
      assert.deepStrictEqual(kit.notify.announced, [])
      // An exact name wins over a longer one that contains it.
      const exact = yield* startTestModule(broadcastModule, { household: { devices: [...two, { id: "kitchen-annex", name: "Annex tablet", room: "Kitchen annex", capabilities: PAGE }] } })
      yield* exact.tool("broadcast_send", { message: "Hello", room: "kitchen" }, { device: "master-bed" })
      yield* exact.advance(5_000)
      assert.deepStrictEqual(where(exact), ["kitchen-display"])
      // No device has a room at all.
      const bare = yield* startTestModule(broadcastModule, { household: { devices: [{ id: "kitchen-display", name: "Display", capabilities: PAGE }, { id: "other-display", name: "Other", capabilities: PAGE }] } })
      assert.strictEqual(said(yield* bare.tool("broadcast_send", { message: "Hello", room: "Kitchen" }, { device: "kitchen-display" })), "I don't know a room called Kitchen: no device has a room yet.")
    }))

  it.effect("the asking device is the only one in the room, or in the house: nothing is announced, and it says why", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: { devices: HOUSE } })
      const study = yield* kit.tool("broadcast_send", { message: "Hello", room: "Study" }, { device: "study-tablet" })
      assert.strictEqual(said(study), "Study has no device but this one, and announcements never go to the device that asked, so nothing was announced.")
      const lone = yield* startTestModule(broadcastModule, { household: { devices: [{ id: "kitchen-display", name: "Kitchen display", room: "Kitchen", capabilities: PAGE }] } })
      assert.strictEqual(
        said(yield* lone.tool("broadcast_send", { message: "Hello" }, { device: "kitchen-display" })),
        "This is the only device I know, and announcements never go to the device that asked, so nothing was announced."
      )
      yield* kit.advance(5_000)
      assert.deepStrictEqual(kit.notify.announced, [])
    }))

  it.effect("do not disturb: nothing is announced and no card is shown, and the answer says it was do not disturb", () =>
    Effect.gen(function*() {
      const parts: { notify?: ModuleNotify } = {}
      const kit = yield* startTestModule(withNotify(parts), { household: { devices: HOUSE } })
      yield* parts.notify!.dnd.set()
      const r = yield* kit.tool("broadcast_send", { message: "Dinner is ready" }, { device: "kitchen-display" })
      yield* kit.present.settle
      // The garage screen cannot speak (that is its reason, not do not disturb), so a card goes there alone.
      assert.strictEqual(said(r), "Nothing was announced: Attic node (not connected), Garage screen (do not disturb) and five more.")
      assert.deepStrictEqual(kit.notify.announced, [])
      assert.deepStrictEqual(kit.present.shown("study-tablet"), [])
      // Only do not disturb, everywhere it could have spoken: said so in one sentence.
      const speakers: ReadonlyArray<TestDevice> = [{ id: "kitchen-display", name: "Kitchen display", room: "Kitchen", capabilities: PAGE }, { id: "study-tablet", name: "Study tablet", room: "Study", capabilities: PAGE }]
      const quiet = yield* startTestModule(withNotify(parts), { household: { devices: speakers } })
      yield* parts.notify!.dnd.set()
      assert.strictEqual(said(yield* quiet.tool("broadcast_send", { message: "Hello" }, { device: "kitchen-display" })), "Do not disturb is on, so nothing was announced.")
    }))

  it.effect("a tool inside a turn does not wait for the announcement: devices busy with a reply still get it queued", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: HOUSE_ONLY_TWO })
      yield* kit.notify.replying("study-tablet", true)
      const r = yield* kit.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })
      assert.strictEqual(r.ok, true)
      assert.strictEqual(said(r), "Announcing on Study tablet. Also showing it on Study tablet.")
      assert.deepStrictEqual(kit.notify.announced, [])
      yield* kit.notify.replying("study-tablet", false)
      yield* kit.advance(5_000)
      assert.deepStrictEqual(where(kit), ["study-tablet"])
    }))

  it.effect("a message on a public device is announced there as on any other: it is the sender's, household content, and nothing is stored", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: { devices: HOUSE } })
      yield* kit.tool("broadcast_send", { message: "Mum is on her way" }, { device: "robins-phone" })
      yield* kit.advance(5_000)
      assert.include(where(kit), "hall-screen")
      // It keeps nothing: no collection, no job.
      assert.isUndefined(broadcastModule.storage)
      assert.deepStrictEqual(yield* kit.jobs, [])
    }))

  it.effect("the chime: sent to the other devices with one word after it, honestly said, and no card", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: HOUSE_ONLY_TWO })
      const r = yield* kit.tool("broadcast_chime", {}, { device: "kitchen-display" })
      yield* kit.advance(5_000)
      assert.deepStrictEqual(kit.notify.announced.map((a) => [a.deviceId, a.text, a.cue]), [["study-tablet", "Attention.", true]])
      assert.strictEqual(said(r), "Announcing on Study tablet.")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("study-tablet"), [])
      const room = yield* kit.tool("broadcast_chime", { room: "Garden" }, { device: "kitchen-display" })
      assert.strictEqual(said(room), "I don't know a room called Garden. The rooms are Kitchen and Study.")
    }))

  it.effect("the actions run the same way without the model: the message of the sentence, to everyone; the chime", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: HOUSE_ONLY_TWO })
      const sent = yield* kit.action("send", { message: "dinner is ready" }, { device: "kitchen-display" })
      assert.deepStrictEqual(sent, { ok: true, say: "Announcing on Study tablet. Also showing it on Study tablet." })
      const chime = yield* kit.action("chime", {}, { device: "kitchen-display" })
      assert.deepStrictEqual(chime, { ok: true, say: "Announcing on Study tablet." })
      yield* kit.advance(5_000)
      assert.deepStrictEqual(kit.notify.announced.map((a) => a.text), ["dinner is ready", "Attention."])
      // An action is not also a tool of the same name: the model has the two tools.
      assert.deepStrictEqual(kit.toolNames().sort(), ["broadcast_chime", "broadcast_send"])
      const blank = yield* kit.action("send", { message: "   " }, { device: "kitchen-display" })
      assert.deepStrictEqual(blank, { ok: true, say: "What should I announce?" })
    }))

  it.effect("the message is one short line: a line break, an empty one and a long one are refused by the schema, and nothing is announced", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: HOUSE_ONLY_TWO })
      for (const message of ["one\ntwo", "", "   ", "x".repeat(201), "bell\u0007"]) {
        const r = yield* kit.tool("broadcast_send", { message }, { device: "kitchen-display" })
        assert.isFalse(r.ok)
      }
      assert.isFalse((yield* kit.tool("broadcast_send", { message: "ok", room: "x".repeat(41) }, { device: "kitchen-display" })).ok)
      // The longest legal message and room name are accepted, and the announcement is the same text.
      const longest = "y".repeat(200)
      const r = yield* kit.tool("broadcast_send", { message: longest, room: "Study" }, { device: "kitchen-display" })
      assert.isTrue(r.ok)
      yield* kit.advance(5_000)
      assert.deepStrictEqual(kit.notify.announced.map((a) => a.text), [longest])
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("study-tablet").length, 1)
    }))

  it.effect("the setting that turns the card off: the announcement is the same, no card", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: HOUSE_ONLY_TWO, settings: { showCard: false } })
      const r = yield* kit.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })
      assert.strictEqual(said(r), "Announcing on Study tablet.")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("study-tablet"), [])
      const refused = yield* kit.configure({ showCard: "maybe" })
      assert.deepStrictEqual(refused, { ok: false, error: { code: "invalid_settings", message: "Some settings are not valid", moduleId: "broadcast", fieldErrors: [{ key: "showCard", message: "Must be on or off" }] } })
      // The refused value changed nothing: the module still runs with the card off.
      assert.strictEqual(said(yield* kit.tool("broadcast_send", { message: "Again" }, { device: "kitchen-display" })), "Announcing on Study tablet.")
    }))

  it.effect("a house of more devices than one broadcast is queued on, and more screens than it may show: both are said, nothing is claimed that did not happen", () =>
    Effect.gen(function*() {
      const many: Array<TestDevice> = [{ id: "kitchen-display", name: "Kitchen display", room: "Kitchen", capabilities: PAGE }]
      for (let i = 0; i < MAX_TARGETS + 6; i++) many.push({ id: `screen-${String(i).padStart(3, "0")}`, name: `Screen ${String(i).padStart(3, "0")}`, room: `Room ${i}`, capabilities: PAGE })
      const kit = yield* startTestModule(broadcastModule, { household: { devices: many } })
      const r = yield* kit.tool("broadcast_send", { message: "Fire drill" }, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.include(said(r), "There are 6 more devices than I announce on at once; I left those out.")
      const cards = many.filter((d) => kit.present.shown(d.id).length > 0)
      assert.strictEqual(cards.length, MAX_CARDS)
      yield* kit.advance(120_000)
      assert.strictEqual(kit.notify.announced.length, MAX_TARGETS)
    }))

  it.effect("a broadcast again replaces a device's card in place, so repeating it never uses up the module's places", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: HOUSE_ONLY_TWO })
      for (let i = 0; i < 12; i++) {
        const r = yield* kit.tool("broadcast_send", { message: `Round ${i}` }, { device: "kitchen-display" })
        assert.notInclude(said(r), "could not")
        yield* kit.present.settle
      }
      const [card] = kit.present.shown("study-tablet")
      assert.strictEqual(card?.content.kind === "card" ? card.content.text : "", "Round 11")
      assert.strictEqual(kit.present.shown("study-tablet").length, 1)
    }))

  it.effect("a restart in the middle changes nothing: the next broadcast works; with the module off, the tools are not there", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: HOUSE_ONLY_TWO })
      yield* kit.restart
      assert.include(said(yield* kit.tool("broadcast_send", { message: "Back" }, { device: "kitchen-display" })), "Announcing on Study tablet")
      yield* kit.stop
      assert.deepStrictEqual(kit.toolNames(), [])
    }))

  it.effect("speech that is not there, or that fails for one device: said, never claimed as announced", () =>
    Effect.gen(function*() {
      const speechWith = (say: (id: string) => Effect.Effect<never, SpeechError>): typeof broadcastModule => ({
        ...broadcastModule,
        start: (ctx) => broadcastModule.start({ ...ctx, speech: { say: (target: SpeechTarget) => say((target as { device: string }).device) } } as never)
      })
      const closed = yield* startTestModule(speechWith(() => Effect.fail(new SpeechError({ reason: "unavailable", message: "no speech here" }))), { household: HOUSE_ONLY_TWO })
      const refused = yield* closed.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })
      assert.isFalse(refused.ok)
      assert.include(refused.content, "I can't announce anything on this installation.")
      assert.deepStrictEqual(yield* closed.action("send", { message: "Dinner" }, { device: "kitchen-display" }), { ok: false, code: "failed", message: "I can't announce anything on this installation." })
      const gone = yield* startTestModule(speechWith(() => Effect.fail(new SpeechError({ reason: "no-device", message: "gone" }))), { household: HOUSE_ONLY_TWO })
      assert.strictEqual(said(yield* gone.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })), "Nothing was announced: Study tablet (failed).")
    }))

  it.effect("phrase commands: said after the wake phrase they run without the model; the room is text, resolved in the action", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: { devices: HOUSE } })
      const everyone = yield* kit.phrases.say("Tell everyone that dinner is ready", { device: "kitchen-display" })
      assert.isTrue(everyone.taken)
      yield* kit.advance(5_000)
      assert.isTrue(kit.notify.announced.every((a) => a.text === "dinner is ready"))
      assert.notInclude(where(kit), "kitchen-display")
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text.startsWith("Announcing on"), true)
      // A room, taken as text and found among the rooms; the longest phrase wins ("announce in the … that …").
      yield* kit.phrases.say("announce in the Kids' room that lights out", { device: "kitchen-display" })
      yield* kit.advance(5_000)
      assert.deepStrictEqual(kit.notify.announced.filter((a) => a.text === "lights out").map((a) => a.deviceId), ["kids-tablet"])
      // A room nobody has: its own sentence, nothing announced.
      const before = kit.notify.announced.length
      yield* kit.phrases.say("tell the garden that hello", { device: "kitchen-display" })
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text.startsWith("I don't know a room called garden."), true)
      yield* kit.advance(5_000)
      assert.strictEqual(kit.notify.announced.length, before)
      // The chime, with and without a room.
      yield* kit.phrases.say("ring the dinner bell", { device: "kitchen-display" })
      yield* kit.phrases.say("ring the bell in the study", { device: "kitchen-display" })
      yield* kit.advance(5_000)
      assert.deepStrictEqual(kit.notify.announced.filter((a) => a.text === "Attention.").map((a) => a.deviceId).filter((d) => d === "study-tablet").length, 2)
      // Words that are not a phrase of it are not taken.
      assert.deepStrictEqual(yield* kit.phrases.say("what is the weather", { device: "kitchen-display" }), { taken: false })
    }))

  it.effect("phrase commands in Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(broadcastModule, { household: { devices: HOUSE, home: { HOME_LANGUAGE: "nl-NL" } } })
      yield* kit.phrases.say("zeg tegen iedereen dat het eten klaar is", { device: "kitchen-display" })
      yield* kit.phrases.say("zeg tegen de Study dat het eten klaar is", { device: "kitchen-display" })
      yield* kit.phrases.say("zeg tegen de tuin dat het eten klaar is", { device: "kitchen-display" })
      yield* kit.phrases.say("bel de gong", { device: "kitchen-display" })
      yield* kit.advance(5_000)
      assert.strictEqual(kit.phrases.spoken[2]?.text.startsWith("Ik ken geen kamer die tuin heet."), true)
      assert.include(kit.notify.announced.map((a) => a.text), "het eten klaar is")
      assert.include(kit.notify.announced.map((a) => a.text), "Aandacht.")
      // The action's own words are checked too: a line over the bound is refused with a sentence, nothing announced.
      const long = yield* kit.action("send", { message: "y".repeat(201) }, { device: "kitchen-display" })
      assert.deepStrictEqual(long, { ok: true, say: "Ik roep één regel van hooguit 200 tekens om." })
    }))

  it.effect("both languages on every path: Dutch", () =>
    Effect.gen(function*() {
      const home = { HOME_LANGUAGE: "nl-NL" }
      const kit = yield* startTestModule(broadcastModule, { household: { devices: HOUSE, home } })
      const all = yield* kit.tool("broadcast_send", { message: "Het eten is klaar" }, { device: "kitchen-display" })
      assert.strictEqual(
        said(all),
        "Ik roep het om op Hall screen, Kids tablet en nog drie. Niet omgeroepen op Attic node (niet verbonden) en Garage screen (kan niet praten). Ik toon het ook op Garage screen, Hall screen en nog drie."
      )
      yield* kit.present.settle
      const [card] = kit.present.shown("study-tablet")
      assert.deepStrictEqual(card?.content.kind === "card" ? [card.content.title, card.content.facts] : [], ["Mededeling", [{ label: "Van", value: "Kitchen display" }]])
      assert.strictEqual(said(yield* kit.tool("broadcast_send", { message: "Hoi", room: "Tuin" }, { device: "kitchen-display" })), "Ik ken geen kamer die Tuin heet. De kamers zijn Attic, Bedroom, Garage, Hall, Kids' room, Kitchen en Study.")
      assert.strictEqual(said(yield* kit.tool("broadcast_send", { message: "Hoi", room: "Study" }, { device: "study-tablet" })), "Study heeft alleen dit apparaat, en omroepen gaan nooit naar het apparaat dat erom vroeg, dus er is niets omgeroepen.")
      assert.strictEqual(said(yield* kit.tool("broadcast_chime", {}, { device: "study-tablet" })).startsWith("Ik roep het om op"), true)
      yield* kit.advance(5_000)
      assert.include(kit.notify.announced.map((a) => a.text), "Aandacht.")
      assert.deepStrictEqual(yield* kit.action("send", { message: "  " }, { device: "kitchen-display" }), { ok: true, say: "Wat moet ik omroepen?" })
      const bedrooms = yield* startTestModule(broadcastModule, {
        household: { devices: [{ id: "kitchen-display", name: "K", room: "Kitchen", capabilities: PAGE }, { id: "master-bed", name: "M", room: "Master bedroom", capabilities: PAGE }, { id: "guest-bed", name: "G", room: "Guest bedroom", capabilities: PAGE }], home }
      })
      assert.strictEqual(said(yield* bedrooms.tool("broadcast_send", { message: "Hoi", room: "bedroom" }, { device: "kitchen-display" })), "Welke kamer bedoel je: Guest bedroom en Master bedroom?")
      const busy = yield* startTestModule(withNotify({}), { household: { devices: [{ id: "kitchen-display", name: "K", room: "Kitchen", capabilities: PAGE }], home } })
      assert.strictEqual(said(yield* busy.tool("broadcast_send", { message: "Hoi" }, { device: "kitchen-display" })), "Dit is het enige apparaat dat ik ken, en omroepen gaan nooit naar het apparaat dat erom vroeg, dus er is niets omgeroepen.")
    }))
})

const HOUSE_ONLY_TWO = { devices: [{ id: "kitchen-display", name: "Kitchen display", room: "Kitchen", capabilities: PAGE }, { id: "study-tablet", name: "Study tablet", room: "Study", capabilities: PAGE }] satisfies ReadonlyArray<TestDevice> }

describe("rooms", () => {
  it("compares a room's name by words, never picking the first of several", () => {
    const rooms = [{ room: "Kids' room" }, { room: "Kitchen" }, { room: "Living room" }, { room: "Bedroom 1" }, { room: "Bedroom 2" }]
    assert.strictEqual(roomKey("The Kids' Room "), "kids room")
    assert.deepStrictEqual(matchRoom(rooms, "kids room"), { kind: "room", label: "Kids' room", key: "kids room" })
    assert.deepStrictEqual(matchRoom(rooms, "living"), { kind: "room", label: "Living room", key: "living room" })
    assert.strictEqual(matchRoom(rooms, "bedroom").kind, "several")
    assert.strictEqual(matchRoom(rooms, "room").kind, "several")
    assert.strictEqual(matchRoom(rooms, "x").kind, "none")
    assert.strictEqual(matchRoom(rooms, "kit").kind, "none")
    assert.isTrue(meansEveryone("Iedereen"))
    assert.isFalse(meansEveryone("the kitchen"))
  })
})
