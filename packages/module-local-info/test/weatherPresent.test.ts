// The `weather` presentation of a day's forecast (docs/PRESENTING.md), through the real host and Presenter of the test kit:
// what the card says (and does not), where it is shown (the shared, private and public devices of the default household,
// and a device without a screen), that it is replaced and ends, and that the answer the model reads is unchanged.
import { assert, describe, it } from "@effect/vitest"
import { presentationProblem } from "@pva/core"
import { checkModule, makeOfflineNet, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { forecastCard, iconOf } from "../../modules-builtin/src/weather/card.ts"
import { weatherModule } from "../../modules-builtin/src/weather.ts"
import { texts } from "../../modules-builtin/src/weather/words.ts"
import { FORECAST, forecast, GEOCODE, geocoding, json, utrecht } from "./weatherFixtures.ts"

// Several of these tests start a whole test household: on a slow two-core CI runner one can take longer than five seconds.
vi.setConfig({ testTimeout: 30_000 })

type Spec = Parameters<typeof makeOfflineNet>[0]
const world = (forecastBody: unknown = forecast(), known: ReadonlyArray<{ readonly name: string }> = [utrecht]): Spec => ({
  [GEOCODE]: geocoding(known),
  [FORECAST]: { body: forecastBody, headers: json }
})
const on = (spec: Spec, options: Parameters<typeof startTestModule>[1] = {}) => {
  const net = makeOfflineNet(spec)
  return startTestModule(weatherModule({ resolver: net.resolver, connector: net.connector }), options)
}
const dutch = { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam", HOME_LOCATION: "Utrecht" } }
const office = { id: "office-speaker", name: "Office speaker", room: "Office", capabilities: { v: 1, speaker: { media: ["speech"] } } } as const

type Kit = Effect.Success<ReturnType<typeof on>>
const cardOn = (kit: Kit, device: string) => kit.present.shown(device).map((p) => p.content)

const TOMORROW = { kind: "weather", place: "Utrecht", now: { temperature: "8 – 13°", condition: "Light rain", icon: "rain" }, days: [{ label: "Tomorrow", high: "13°", low: "8°", icon: "rain" }] }

describe("the forecast card: what it says", () => {
  it.effect("tomorrow's forecast: the place, the day's range, the condition and the day's high and low, and nothing the kind has no field for", () =>
    Effect.gen(function*() {
      const kit = yield* on(world())
      const r = yield* kit.tool("weather_forecast", { day: "tomorrow" })
      // The model reads the answer as before, then the note of what the server did.
      assert.isTrue(r.ok)
      assert.match(r.content, /"spoken":"Tomorrow: light rain, 8 to 13 degrees, 70 percent chance of rain, wind up to 35 km\/h\."/)
      assert.match(r.content, /\n\[Screen: Showing on "Kitchen display"\.\]$/)
      yield* kit.present.settle
      const [card] = cardOn(kit, "kitchen-display")
      assert.deepStrictEqual(card, TOMORROW)
      // The chance of rain and the wind have no field on the card, and are not smuggled into another one.
      assert.notMatch(JSON.stringify(card), /70|35|percent|km/)
    }))

  it.effect("today, a weekday, Dutch and Fahrenheit: the label, the words and the unit follow the answer", () =>
    Effect.gen(function*() {
      const kit = yield* on(world())
      yield* kit.tool("weather_forecast", {})
      yield* kit.present.settle
      assert.deepStrictEqual(cardOn(kit, "kitchen-display"), [{ kind: "weather", place: "Utrecht", now: { temperature: "6 – 11°", condition: "Overcast", icon: "cloud" }, days: [{ label: "Today", high: "11°", low: "6°", icon: "cloud" }] }])
      yield* kit.tool("weather_forecast", { day: "Friday" })
      yield* kit.present.settle
      const [friday] = cardOn(kit, "kitchen-display")
      assert.deepStrictEqual(friday?.kind === "weather" ? [friday.days?.[0]?.label, friday.now.condition, friday.now.icon] : [], ["Friday", "Light rain showers", "rain"])
      const nl = yield* on(world(), { household: dutch })
      yield* nl.tool("weather_forecast", { day: "morgen" })
      yield* nl.present.settle
      assert.deepStrictEqual(cardOn(nl, "kitchen-display"), [{ kind: "weather", place: "Utrecht", now: { temperature: "8 – 13°", condition: "Lichte regen", icon: "rain" }, days: [{ label: "Morgen", high: "13°", low: "8°", icon: "rain" }] }])
      const us = yield* on(world(), { household: { assistants: [{ id: "jeff", modules: { weather: { own: { units: "fahrenheit" } } } }] } })
      yield* us.tool("weather_forecast", { day: "tomorrow" })
      yield* us.present.settle
      const [f] = cardOn(us, "kitchen-display")
      assert.deepStrictEqual(f?.kind === "weather" ? [f.now.temperature, f.days?.[0]?.high, f.days?.[0]?.low] : [], ["8 – 13 °F", "13 °F", "8 °F"])
    }))

  it.effect("the hours asked for stay in the words; the card is the day", () =>
    Effect.gen(function*() {
      const kit = yield* on(world(), { household: { devices: [office] } })
      const r = yield* kit.tool("weather_forecast", { hours: 3 }, { device: "office-speaker" })
      assert.include(r.content, "In the next 3 hours")
      // Nothing to show on a speaker: what the model says instead is the day's sentence, which stands on its own.
      assert.match(r.content, /\[Screen: Not showing it: "Office speaker" has no display\. Say this instead: Today: overcast, 6 to 11 degrees\.\]$/)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
    }))

  it.effect("the card's own words are what the kind allows: a long place is cut at a code point, an emoji at the cut is never split, and the card is valid", () =>
    Effect.gen(function*() {
      const place = `${"A".repeat(39)}😀${"B".repeat(30)}`
      const kit = yield* on(world(forecast(), [{ name: place, latitude: 52.09, longitude: 5.12 } as never]), { settings: { defaultPlace: place } })
      yield* kit.tool("weather_forecast", { day: "tomorrow" })
      yield* kit.present.settle
      const [card] = cardOn(kit, "kitchen-display")
      assert.strictEqual(card?.kind === "weather" ? card.place : undefined, "A".repeat(39))
      assert.isUndefined(presentationProblem({ ...card!, spoken: "x" } as never))
      // The same cut at an exact boundary keeps the whole emoji.
      const exact = `${"A".repeat(38)}😀`
      const kept = forecastCard({ lang: "en", placeName: exact, date: { year: 2026, month: 11, day: 19 }, daysFromToday: 1, code: 61, condition: "light rain", min: 8, max: 13, fahrenheit: false, spoken: "Tomorrow.", spokenShort: "Tomorrow." })
      assert.strictEqual(kept?.kind === "weather" ? kept.place : undefined, exact)
    }))

  it.effect("a weather code the card has no icon for gives the same answer without a card (nothing is guessed)", () =>
    Effect.gen(function*() {
      const body = forecast()
      const odd = { ...body, daily: { ...body.daily, weather_code: [3, 7, 80, 3, 0, 71, 95] } }
      const kit = yield* on(world(odd))
      const r = yield* kit.tool("weather_forecast", { day: "tomorrow" })
      assert.isTrue(r.ok)
      assert.notInclude(r.content, "[Screen:")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.isUndefined(iconOf(7))
      assert.isUndefined(iconOf(null))
    }))

  it.effect("a refused or failed forecast shows nothing and changes nothing on the screen", () =>
    Effect.gen(function*() {
      const kit = yield* on(world())
      yield* kit.tool("weather_forecast", { day: "tomorrow" })
      yield* kit.present.settle
      const before = kit.present.shown("kitchen-display").map((p) => p.id)
      const refused = yield* kit.tool("weather_forecast", { day: "whenever" })
      assert.include(refused.content, "Which day do you mean?")
      assert.notInclude(refused.content, "[Screen:")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display").map((p) => p.id), before)
    }))
})

describe("the forecast card: where it is shown", () => {
  it.effect("the household's own content: the shared, the private and the public device each show it to the person who asked there, from the same decision", () =>
    Effect.gen(function*() {
      const kit = yield* on(world())
      for (const device of ["kitchen-display", "robins-phone", "hall-screen"]) {
        const r = yield* kit.tool("weather_forecast", { day: "tomorrow" }, { device })
        assert.match(r.content, /\[Screen: Showing on "[^"]+"\.\]$/)
        yield* kit.present.settle
        assert.deepStrictEqual(cardOn(kit, device), [TOMORROW])
        // The decision was taken for that very device, and the public one was a real candidate: weather has no owner.
        assert.isTrue(kit.present.decisions.some((d) => d.deviceId === device && d.decision.show))
      }
      // It was shown on the device that asked and on no other.
      const other = yield* kit.tool("weather_forecast", { day: "Friday" }, { device: "hall-screen" })
      assert.isTrue(other.ok)
      yield* kit.present.settle
      const [kitchen] = cardOn(kit, "kitchen-display")
      assert.strictEqual(kitchen?.kind === "weather" ? kitchen.days?.[0]?.label : undefined, "Tomorrow")
    }))

  it.effect("a device without a screen is told the same answer, nothing is shown there and the note says why", () =>
    Effect.gen(function*() {
      const kit = yield* on(world(), { household: { devices: [office] } })
      const r = yield* kit.tool("weather_forecast", { day: "tomorrow" }, { device: "office-speaker" })
      assert.isTrue(r.ok)
      assert.match(r.content, /"spoken":"Tomorrow: light rain, 8 to 13 degrees/)
      assert.match(r.content, /\[Screen: Not showing it: "Office speaker" has no display\. Say this instead: Tomorrow: light rain, 8 to 13 degrees, 70 percent chance of rain, wind up to 35 km\/h\.\]$/)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "office-speaker" && !d.decision.show))
    }))

  it.effect("the typed action `weather.tomorrow` shows the same card and says the same sentence", () =>
    Effect.gen(function*() {
      const kit = yield* on(world(), { household: dutch })
      const done = yield* kit.action("tomorrow", {}, { device: "hall-screen" })
      assert.deepStrictEqual(done, { ok: true, say: "Morgen: lichte regen, 8 tot 13 graden, 70 procent kans op regen, wind tot 35 km/h." })
      yield* kit.present.settle
      assert.deepStrictEqual(cardOn(kit, "hall-screen").map((c) => c.kind === "weather" ? c.days?.[0]?.label : undefined), ["Morgen"])
    }))
})

describe("the forecast card: replaced and withdrawn", () => {
  it.effect("a newer forecast replaces the card on that device (one transient at a time); it ends by itself and is gone from the page", () =>
    Effect.gen(function*() {
      const kit = yield* on(world())
      yield* kit.tool("weather_forecast", { day: "tomorrow" })
      yield* kit.present.settle
      const first = kit.present.shown("kitchen-display").map((p) => p.id)
      assert.strictEqual(first.length, 1)
      yield* kit.tool("weather_forecast", { day: "Friday" })
      yield* kit.present.settle
      const now = kit.present.shown("kitchen-display")
      assert.strictEqual(now.length, 1)
      assert.notDeepEqual(now.map((p) => p.id), first)
      assert.strictEqual(now[0]?.content.kind === "weather" ? now[0].content.days?.[0]?.label : undefined, "Friday")
      // Transient: thirty seconds by default, then it leaves the page.
      yield* kit.advance(31_000)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // A page that comes back does not get an ended card again.
      yield* kit.notify.disconnect("kitchen-display")
      yield* kit.notify.connect("kitchen-display")
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("a page that loses its connection shows nothing, and is not given a transient card that ended meanwhile", () =>
    Effect.gen(function*() {
      const kit = yield* on(world())
      yield* kit.tool("weather_forecast", { day: "tomorrow" })
      yield* kit.present.settle
      yield* kit.notify.disconnect("kitchen-display")
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      yield* kit.advance(40_000)
      yield* kit.notify.connect("kitchen-display")
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))
})

describe("the forecast card: the module", () => {
  it.effect("still passes the conformance check (its card's words are the weather service's, bounded)", () =>
    checkModule({ ...weatherModule(), enabledByDefault: false }, { texts, settings: { defaultPlace: "Utrecht, Netherlands" } }))
})
