// The weather module's extension (rain in the next hours, a day's forecast, warnings, two briefing sections) through the real
// host and gateway of the test kit, with no network: the offline network serves Open-Meteo's and MeteoAlarm's answers. The
// module lives in `packages/modules-builtin` (its pull request may change only `weather.ts` and `weather/` there), so its
// tests of the extension are in the local-info package, which owns the pull request.
import { assert, describe, it } from "@effect/vitest"
import { checkModule, makeOfflineNet, startTestModule } from "@pva/core/testing"
import { type BriefingRequest, type BriefingSection, BriefingSections } from "@pva/module-contracts"
import { Effect, Fiber } from "effect"
import { weatherModule } from "../../modules-builtin/src/weather.ts"
import { periodsOf } from "../../modules-builtin/src/weather/rain.ts"
import { forPlace, parseWarnings } from "../../modules-builtin/src/weather/warnings.ts"
import { texts } from "../../modules-builtin/src/weather/words.ts"
import { FEED, FORECAST, feed, forecast, GEOCODE, geocoding, json, utrecht } from "./weatherFixtures.ts"

type Spec = Parameters<typeof makeOfflineNet>[0]
const world = (over: { rain?: ReadonlyArray<number | null>; noRain?: boolean; feedBody?: unknown; feedStatus?: number; forecastBody?: unknown } = {}): Spec => ({
  [GEOCODE]: geocoding(),
  [FORECAST]: { body: over.forecastBody ?? forecast({ rain: over.rain, noRain: over.noRain }), headers: json },
  [FEED]: { body: over.feedBody ?? feed(), headers: json, ...(over.feedStatus !== undefined ? { status: over.feedStatus } : {}) }
})
const on = (spec: Spec, options: Parameters<typeof startTestModule>[1] = {}) => {
  const net = makeOfflineNet(spec)
  return Effect.map(startTestModule(weatherModule({ resolver: net.resolver, connector: net.connector }), options), (kit) => ({ kit, net }))
}
const dutch = { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam", HOME_LOCATION: "Utrecht" } }
type Said = { spoken: string } & Record<string, unknown>
const spoken = (r: { readonly value: unknown }) => (r.value as Said).spoken

describe("weather: conformance", () => {
  // `weather` is an existing module and stays on by default (nothing changes for an installation that has it on), so the one rule
  // about new modules, `off-by-default`, is the only one checked against a copy that is off.
  it.effect("passes the conformance check, with its texts in both languages", () =>
    checkModule({ ...weatherModule(), enabledByDefault: false }, { texts, settings: { defaultPlace: "Utrecht, Netherlands" } }))

  it("is still on by default, as before", () => assert.strictEqual(weatherModule().enabledByDefault, true))
})

describe("weather_rain_soon", () => {
  it.effect("dry for the whole time", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world())
      assert.strictEqual(spoken(yield* kit.tool("weather_rain_soon", {})), "No rain expected for the next 2 hours.")
      assert.strictEqual(spoken(yield* kit.tool("weather_rain_soon", { minutes: 60 })), "No rain expected for the next 1 hour.")
    }))

  it.effect("dry now, rain from a time, for a while or to the end of the window", () =>
    Effect.gen(function*() {
      const a = yield* on(world({ rain: [0, 0, 0.3, 0.3, 0.3, 0, 0, 0] }))
      const said = spoken(yield* a.kit.tool("weather_rain_soon", {}))
      assert.match(said, /^Dry until about .*, then light rain for about .*\.$/)
      const b = yield* on(world({ rain: [0, 0, 0, 0, 0, 1, 1, 1] }))
      assert.match(spoken(yield* b.kit.tool("weather_rain_soon", {})), /^Dry until about .*, then moderate rain\.$/)
      // Only the window asked for is looked at: rain at 11:15 is outside the next half hour.
      assert.strictEqual(spoken(yield* b.kit.tool("weather_rain_soon", { minutes: 30 })), "No rain expected for the next half an hour.")
    }))

  it.effect("raining now: when it eases off, or that it goes on; heavy and light are words, never millimetres", () =>
    Effect.gen(function*() {
      const a = yield* on(world({ rain: [2, 2, 0.2, 0, 0, 0, 0, 0] }))
      const stops = spoken(yield* a.kit.tool("weather_rain_soon", {}))
      assert.match(stops, /^Heavy rain now, easing off around .*\.$/)
      assert.notMatch(stops, /mm/)
      const b = yield* on(world({ rain: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2] }))
      assert.match(spoken(yield* b.kit.tool("weather_rain_soon", {})), /^Light rain now, and it keeps on for the next 2 hours\.$/)
    }))

  it.effect("in Dutch, and for a named place", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world({ rain: [0, 0, 0.3, 0.3, 0, 0, 0, 0] }), { household: dutch })
      assert.match(spoken(yield* kit.tool("weather_rain_soon", {})), /^Droog tot ongeveer .*, daarna lichte regen gedurende ongeveer .*\.$/)
      const maastricht = yield* kit.tool("weather_rain_soon", { place: "Maastricht" })
      assert.include(spoken(maastricht), " in Maastricht")
      assert.strictEqual(maastricht.ok, true)
    }))

  it.effect("no rain data is not dry: a place without quarter-hours, and a gap in them, say so", () =>
    Effect.gen(function*() {
      const none = yield* on(world({ noRain: true }))
      const r = yield* none.kit.tool("weather_rain_soon", {})
      assert.isFalse(r.ok)
      assert.include(r.content, "I can't get rain data for Utrecht")
      const gap = yield* on(world({ rain: [0, null, 0, 0, 0, 0, 0, 0] }))
      assert.include((yield* gap.kit.tool("weather_rain_soon", {})).content, "I can't get rain data")
    }))

  it.effect("a rain now sent to the model in a unit it can use; the quarter-hours reach it with the clock of the place", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world({ rain: [0, 0, 0.3, 0.3, 0, 0, 0, 0] }))
      const r = (yield* kit.tool("weather_rain_soon", {})).value as { periods: Array<{ kind: string; from: string; to: string }>; source: string }
      assert.deepStrictEqual(r.periods, [{ kind: "dry", from: "10:00", to: "10:30" }, { kind: "light", from: "10:30", to: "11:00" }, { kind: "dry", from: "11:00", to: "12:00" }])
    }))
})

describe("weather_forecast", () => {
  it.effect("today, tomorrow and a weekday, with the chance of rain and strong wind only when they matter", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world())
      assert.strictEqual(spoken(yield* kit.tool("weather_forecast", {})), "Today: overcast, 6 to 11 degrees.")
      assert.strictEqual(spoken(yield* kit.tool("weather_forecast", { day: "tomorrow" })), "Tomorrow: light rain, 8 to 13 degrees, 70 percent chance of rain, wind up to 35 km/h.")
      assert.strictEqual(spoken(yield* kit.tool("weather_forecast", { day: "Friday" })), "Friday: light rain showers, 6 to 9 degrees, 90 percent chance of rain, wind up to 50 km/h.")
      assert.strictEqual(spoken(yield* kit.tool("weather_forecast", { day: "overmorgen" })), "Friday: light rain showers, 6 to 9 degrees, 90 percent chance of rain, wind up to 50 km/h.")
      const sunday = (yield* kit.tool("weather_forecast", { day: "Monday" })).value as Said
      assert.strictEqual(sunday.spoken.slice(0, 7), "Monday:")
      assert.strictEqual(sunday.date, "2026-11-23")
      assert.deepStrictEqual(sunday.units, { temperature: "°C", wind: "km/h" })
    }))

  it.effect("in Dutch, and in Fahrenheit for an assistant that owns that setting", () =>
    Effect.gen(function*() {
      const nl = yield* on(world(), { household: dutch })
      assert.strictEqual(spoken(yield* nl.kit.tool("weather_forecast", { day: "morgen" })), "Morgen: lichte regen, 8 tot 13 graden, 70 procent kans op regen, wind tot 35 km/h.")
      const us = yield* on(world(), { household: { assistants: [{ id: "jeff", modules: { weather: { own: { units: "fahrenheit" } } } }] } })
      const r = yield* us.kit.tool("weather_forecast", {})
      assert.include(spoken(r), "degrees Fahrenheit")
      assert.include(us.net.requests.find((q) => q.url.startsWith(FORECAST))!.url, "temperature_unit=fahrenheit")
    }))

  it.effect("the next hours of today; a day it cannot give is asked, not guessed", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world())
      const r = yield* kit.tool("weather_forecast", { hours: 3 })
      assert.match(spoken(r), /^Today: overcast, 6 to 11 degrees\. In the next 3 hours: 9 to 10 degrees, up to 10 percent chance of rain\.$/)
      assert.strictEqual(((r.value as Said).hourly as Array<{ time: string }>).map((h) => h.time).join(","), "10:00,11:00,12:00")
      assert.include((yield* kit.tool("weather_forecast", { day: "whenever" })).content, "Which day do you mean?")
      assert.include((yield* kit.tool("weather_forecast", { day: "2027-03-01" })).content, "only look a week ahead")
    }))

  it.effect("coordinates leave the house rounded to two decimals, and the User-Agent carries the contact only when the owner set one", () =>
    Effect.gen(function*() {
      const plain = yield* on(world())
      yield* plain.kit.tool("weather_forecast", {})
      const req = plain.net.requests.find((q) => q.url.startsWith(FORECAST))!
      assert.include(req.url, "latitude=52.09")
      assert.strictEqual(req.headers["user-agent"], "personal-voice-assistance/1")
      const named = yield* on(world(), { household: { home: { HOME_API_CONTACT: "owner@example.org", HOME_LOCATION: "Utrecht" } } })
      yield* named.kit.tool("weather_forecast", {})
      assert.strictEqual(named.net.requests[0]!.headers["user-agent"], "personal-voice-assistance/1 (owner@example.org)")
    }))
})

describe("weather_warnings", () => {
  it.effect("the warning for the place's region, until when, in both languages; the others and the past are left out", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world())
      const r = yield* kit.tool("weather_warnings", {})
      assert.strictEqual(spoken(r), "Code yellow for wind in Utrecht until six o'clock.")
      assert.deepStrictEqual((r.value as Said).warnings, [{ level: "yellow", phenomenon: "wind", area: "Utrecht", until: "2026-11-18T17:00:00.000Z" }])
      const nl = yield* on(world(), { household: dutch })
      assert.strictEqual(spoken(yield* nl.kit.tool("weather_warnings", {})), "Code geel voor wind in Utrecht tot zes uur.")
    }))

  it.effect("another place: its own region's warning, and 'no warnings' when there are none for it", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world())
      assert.match(spoken(yield* kit.tool("weather_warnings", { place: "Maastricht" })), /^Code orange for snow and ice in Limburg until .* at .*\.$/)
      const quiet = yield* on(world({ feedBody: { warnings: [] } }))
      assert.strictEqual(spoken(yield* quiet.kit.tool("weather_warnings", {})), "No weather warnings for Utrecht.")
    }))

  it.effect("several: the worst first and a count", () =>
    Effect.gen(function*() {
      const more = feed([{ alert: { info: [{ language: "en", onset: "2026-11-18T08:00:00+00:00", expires: "2026-11-18T20:00:00+00:00", parameter: [{ valueName: "awareness_level", value: "3; orange; Severe" }, { valueName: "awareness_type", value: "3; Thunderstorms" }], area: [{ areaDesc: "Utrecht" }] }] } }])
      const { kit } = yield* on(world({ feedBody: more }))
      assert.strictEqual(spoken(yield* kit.tool("weather_warnings", {})), "Code orange for thunderstorms in Utrecht until nine o'clock. And 1 more.")
    }))

  it.effect("a feed that cannot be checked is never 'no warnings': down, an error status, rubbish, a changed shape", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [string, Parameters<typeof world>[0]]> = [
        ["an error status", { feedStatus: 503 }],
        ["not found", { feedStatus: 404 }],
        ["a changed shape", { feedBody: { items: [] } }],
        ["alerts that cannot be read", { feedBody: { warnings: [{ nothing: 1 }, "x", 3] } }],
        ["a list", { feedBody: [] }]
      ]
      for (const [name, over] of cases) {
        const { kit } = yield* on(world(over))
        const r = yield* kit.tool("weather_warnings", {})
        assert.isFalse(r.ok, name)
        assert.include(r.content, "I can't check weather warnings at the moment", name)
        assert.notInclude(r.content, "No weather warnings", name)
      }
      const nl = yield* on(world({ feedStatus: 500 }), { household: dutch })
      assert.include((yield* nl.kit.tool("weather_warnings", {})).content, "Ik kan de weerwaarschuwingen op dit moment niet controleren")
    }))
})

describe("weather: actions, settings and the outside service", () => {
  it.effect("the actions answer with no model, and are not also tools", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world({ rain: [0, 0, 0.3, 0.3, 0, 0, 0, 0] }))
      assert.match(((yield* kit.action("rain_soon", {})) as { say: string }).say, /^Dry until about/)
      assert.strictEqual(((yield* kit.action("tomorrow", {})) as { say: string }).say.slice(0, 9), "Tomorrow:")
      assert.strictEqual(((yield* kit.action("warnings", {})) as { say: string }).say, "Code yellow for wind in Utrecht until six o'clock.")
      assert.deepStrictEqual(kit.toolNames(), ["weather", "weather_rain_soon", "weather_forecast", "weather_warnings"])
    }))

  it.effect("no home place: it asks; an unknown place: it says so; invalid parameters are refused by the schema", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world(), { household: { home: { HOME_LANGUAGE: "en-GB", HOME_LOCATION: "" } } })
      assert.include((yield* kit.tool("weather_forecast", {})).content, "I don't know where home is yet")
      assert.include((yield* kit.tool("weather_forecast", { place: "Atlantis" })).content, "I couldn't find a place called Atlantis")
      assert.isFalse((yield* kit.tool("weather_rain_soon", { minutes: 500 })).ok)
      assert.isFalse((yield* kit.tool("weather_forecast", { hours: 0 })).ok)
    }))

  it.effect("unreachable, an error status, rubbish in the answer: the person is told, in their language", () =>
    Effect.gen(function*() {
      const down = yield* on({ [GEOCODE]: { status: 503, body: "x" } })
      assert.include((yield* down.kit.tool("weather_forecast", {})).content, "I can't reach the weather service right now")
      const rubbish = yield* on({ [GEOCODE]: geocoding(), [FORECAST]: { body: { daily: "nope" }, headers: json } })
      assert.include((yield* rubbish.kit.tool("weather_forecast", {})).content, "sent me something I couldn't read")
      const nl = yield* on({ [GEOCODE]: { status: 500, body: "x" } }, { household: dutch })
      assert.include((yield* nl.kit.tool("weather_rain_soon", {})).content, "Ik kan de weerdienst nu niet bereiken")
      const html = yield* on({ [GEOCODE]: geocoding(), [FORECAST]: { body: "<html></html>", headers: { "content-type": "text/html" } } })
      assert.include((yield* html.kit.tool("weather_rain_soon", {})).content, "can't reach the weather service")
    }))

  it.effect("slow: a service that never answers is given up on within the module's timeout", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet(world())
      const kit = yield* startTestModule(
        weatherModule({ resolver: net.resolver, connector: (request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })) }),
        {}
      )
      const call = yield* Effect.forkChild(kit.tool("weather_rain_soon", {}))
      yield* kit.advance(5_000)
      const r = yield* Fiber.join(call)
      assert.isFalse(r.ok)
      assert.include(r.content, "can't reach the weather service")
    }))

  it.effect("the first tool of the module is unchanged: it still uses its own fetch", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet(world())
      const answers: Array<string> = []
      const fetch = (async (input: string | URL | Request) => {
        answers.push(String(input instanceof Request ? input.url : input))
        throw new TypeError("offline")
      }) as typeof globalThis.fetch
      const kit = yield* startTestModule(weatherModule({ fetch, resolver: net.resolver, connector: net.connector }), {})
      const r = yield* kit.tool("weather", {})
      assert.isFalse(r.ok)
      assert.strictEqual(answers.length, 1)
    }))
})

describe("weather: the briefing", () => {
  type Kit = Effect.Success<ReturnType<typeof startTestModule>>
  const sections = (kit: Kit) => Effect.map(kit.contributions(BriefingSections), (all: ReadonlyArray<BriefingSection>) => all.filter((s) => s.id.startsWith("weather")))
  const request = (kit: Kit, over: Partial<BriefingRequest> = {}, as?: Parameters<Kit["turn"]>[0]): BriefingRequest => ({
    turn: kit.turn(as), kind: "morning", length: "normal", maxSentences: 2, language: "en", now: Date.UTC(2026, 10, 18, 9), ...over
  })

  it.effect("the weather section: the day, and rain that starts soon first (a lead); in Dutch; at most the sentences asked", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world({ rain: [0, 0, 0.3, 0.3, 0.3, 0, 0, 0] }))
      const all = yield* sections(kit)
      assert.deepStrictEqual(all.map((s) => [s.id, s.title]), [["weather", "Weather"], ["weather.warnings", "Weather warnings"]])
      const weather = all[0]!
      const r = yield* weather.gather(request(kit))
      assert.strictEqual(r._tag, "section")
      assert.strictEqual((r as { priority: string }).priority, "lead")
      assert.strictEqual((r as { sentences: ReadonlyArray<string> }).sentences.length, 2)
      assert.match((r as { sentences: ReadonlyArray<string> }).sentences[0]!, /^Dry until about/)
      assert.strictEqual(((yield* weather.gather(request(kit, { maxSentences: 1 }))) as { sentences: ReadonlyArray<string> }).sentences.length, 1)
      const nl = yield* weather.gather(request(kit, { language: "nl" }))
      assert.match((nl as { sentences: ReadonlyArray<string> }).sentences[0]!, /^Droog tot ongeveer/)
    }))

  it.effect("the weather section on a dry day is the day only, and is normal priority", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world())
      const weather = (yield* sections(kit))[0]!
      assert.deepStrictEqual(yield* weather.gather(request(kit)), { _tag: "section", sentences: ["Today: overcast, 6 to 11 degrees."], priority: "normal", withheld: 0 })
    }))

  it.effect("the warnings section: a sentence when there is a warning, nothing when there is none, a failure (never 'none') when it cannot be checked", () =>
    Effect.gen(function*() {
      const { kit } = yield* on(world())
      const warn = (yield* sections(kit))[1]!
      assert.deepStrictEqual(yield* warn.gather(request(kit)), { _tag: "section", sentences: ["Code yellow for wind in Utrecht until six o'clock."], priority: "normal", withheld: 0 })
      const quiet = yield* on(world({ feedBody: { warnings: [] } }))
      assert.deepStrictEqual(yield* (yield* sections(quiet.kit))[1]!.gather(request(quiet.kit)), { _tag: "empty" })
      const broken = yield* on(world({ feedStatus: 500 }))
      const failure = yield* Effect.flip((yield* sections(broken.kit))[1]!.gather(request(broken.kit)))
      assert.strictEqual(failure.reason, "unavailable")
    }))

  it.effect("the section uses the asking assistant's place and units, asked at each call", () =>
    Effect.gen(function*() {
      const { kit, net } = yield* on(world(), { household: { assistants: [{ id: "jeff" }, { id: "kim", modules: { weather: { own: { defaultPlace: "Maastricht", units: "fahrenheit" } } } }], devices: [{ id: "kitchen-display", name: "Kitchen", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam", assistants: ["jeff", "kim"] }] as any } })
      const weather = (yield* sections(kit))[0]!
      const r = yield* weather.gather(request(kit, {}, { assistant: "kim" }))
      assert.strictEqual(r._tag, "section")
      assert.include((r as { sentences: ReadonlyArray<string> }).sentences.join(" "), "Fahrenheit")
      assert.isTrue(net.requests.some((q) => q.url.includes("latitude=50.85")))
    }))

  it.effect("a briefing never waits for a service that does not answer: it gives up within its budget and fails the section", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet(world())
      const kit = yield* startTestModule(
        weatherModule({ resolver: net.resolver, connector: (request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })) }),
        {}
      )
      const weather = (yield* sections(kit))[0]!
      const gather = yield* Effect.forkChild(Effect.flip(weather.gather(request(kit))))
      yield* kit.advance(1_000)
      assert.strictEqual((yield* Fiber.join(gather)).reason, "unavailable")
    }))
})

describe("weather: reading the answers", () => {
  const slot = (time: string, mm: number) => ({ time, startMs: Date.parse(`${time}:00Z`) - 3_600_000, mm })
  const slots = [slot("2026-11-18T10:00", 0), slot("2026-11-18T10:15", 0.2), slot("2026-11-18T10:30", 1), slot("2026-11-18T10:45", 0)]
  const now = Date.parse("2026-11-18T09:20:00Z")

  it("quarter-hours over by now are not shown, and the strongest of a wet run names it", () => {
    const p = periodsOf(slots, now, 3_600_000)
    assert.deepStrictEqual(p.map((x) => [x.kind, x.from, x.to]), [["moderate", "2026-11-18T10:15", "2026-11-18T10:45"], ["dry", "2026-11-18T10:45", "2026-11-18T11:00"]])
  })

  it("warnings: strict about the shape, the same warning once, a region match both ways", () => {
    const now = Date.parse("2026-11-18T09:00:00Z")
    assert.strictEqual(parseWarnings("text", now, 1)._tag, "unreadable")
    assert.strictEqual(parseWarnings({ warnings: "x" }, now, 1)._tag, "unreadable")
    const ok = parseWarnings(feed([JSON.parse(JSON.stringify(feed().warnings[0]))]), now, 48 * 3_600_000)
    assert.strictEqual(ok._tag, "ok")
    if (ok._tag === "ok") {
      assert.strictEqual(forPlace(ok.warnings, utrecht).length, 1)
      assert.strictEqual(forPlace(ok.warnings, { name: "Flevoland Noord" }).length, 1)
      assert.strictEqual(forPlace(ok.warnings, { name: "Zeeland" }).length, 0)
      assert.strictEqual(forPlace(ok.warnings, { name: "Zeist", admin1: "Utrecht" }).length, 1)
    }
  })
})
