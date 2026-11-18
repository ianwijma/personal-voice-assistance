import { ActionError, CurrentTurn, defineAction, type HostView, makeTool, ToolError, type TurnContext } from "@pva/core"
import {
  type BriefingRequest, BriefingSectionError, type BriefingSection, type BriefingSectionResult, homeLanguage, type Language, say
} from "@pva/module-contracts"
import { speakDate, speakDuration, speakNumber, speakTime } from "@pva/language"
import { Clock, Data, Effect, Schema } from "effect"
import { type Place, type WeatherClient, WeatherError } from "./client.ts"
import { periodsOf, type Period } from "./rain.ts"
import { forPlace, parseWarnings, type Warning } from "./warnings.ts"
import { awarenessTypeKeys, conditionsEn, conditionsNl, texts } from "./words.ts"

/** The settings the extension reads, for one assistant: the weather module's own. */
export interface WeatherSettingsView {
  readonly defaultPlace: string
  readonly units: "celsius" | "fahrenheit"
  readonly timeoutMs: number
}

/** What the tools, actions and sections need from the module that runs them. Looked up when used, never kept. */
export interface WeatherEnv {
  readonly client: () => WeatherClient
  /** The effective settings: an instance's own for a tool, `settingsFor(assistant)` for a briefing. `undefined`: not valid. */
  readonly settings: (turn: TurnContext | undefined) => WeatherSettingsView | undefined
  readonly view: () => HostView
}

/** A sentence for the person, in the household's language: a failure the tool or action words as its error. */
class Said extends Data.TaggedError("Said")<{ readonly message: string }> {}

type Answer = Record<string, unknown> & { readonly spoken: string }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const SLOT_MAX_AGE_MS = 20 * 60_000
const HORIZON_MS = 48 * 3_600_000

/** A whole number as it is said. */
const num = (n: number, lang: Language) => speakNumber(Math.round(n), lang) ?? String(Math.round(n))

const homeZone = (home: HostView["home"]): string => {
  const zone = home.HOME_TIME_ZONE
  return typeof zone === "string" && zone.trim() !== "" ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone
}
const contactOf = (home: HostView["home"]): string | undefined => {
  const c = home.HOME_API_CONTACT
  return typeof c === "string" && c.trim() !== "" ? c : undefined
}
const dateParts = (iso: string) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) })
const clockOf = (iso: string) => ({ hour: Number(iso.slice(11, 13)), minute: Number(iso.slice(14, 16)) })
/** The date and clock of an epoch moment in a zone, as `YYYY-MM-DDTHH:MM`. */
const isoIn = (epochMs: number, zone: string): string => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(epochMs))
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00"
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  zondag: 0, maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6
}
const weekdayOf = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()

const failureText = (e: unknown, lang: Language, place?: string): string =>
  e instanceof Said
    ? e.message
    : e instanceof WeatherError
    ? say(texts, lang, e.reason === "no-place" ? "noPlace" : e.reason === "unknown-place" ? "unknownPlace" : e.reason === "unreadable" ? "unreadable" : "unreachable", { place: place ?? "" })
    : say(texts, lang, "unreachable")

/** The words of a rain intensity: "light rain". */
const kindWord = (kind: Period["kind"], lang: Language) => say(texts, lang, kind === "light" ? "kindLight" : kind === "moderate" ? "kindModerate" : "kindHeavy")

export const makeWeatherExtras = (env: WeatherEnv) => {
  /** The place asked for, or home; its settings; and the household's view. */
  const resolve = (named: string | undefined, turn: TurnContext | undefined, budgetMs: number | undefined) =>
    Effect.gen(function*() {
      const settings = env.settings(turn)
      if (settings === undefined) return yield* new WeatherError({ reason: "no-place" })
      const view = env.view()
      const query = named?.trim() || settings.defaultPlace.trim()
      if (query === "") return yield* new WeatherError({ reason: "no-place" })
      const timeoutMs = Math.min(settings.timeoutMs, budgetMs ?? settings.timeoutMs)
      const place = yield* env.client().place(query, timeoutMs, contactOf(view.home)).pipe(Effect.mapError((e) => (e.reason === "unknown-place" ? new Said({ message: say(texts, homeLanguage(view), "unknownPlace", { place: query }) }) : e)))
      return { place, named: named?.trim() !== undefined && named.trim() !== "", settings, view, lang: homeLanguage(view), timeoutMs, contact: contactOf(view.home) }
    })

  const withBudget = <A, E>(effect: Effect.Effect<A, E>, ms: number | undefined) =>
    ms === undefined ? effect : effect.pipe(Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.fail(new WeatherError({ reason: "unreachable" })) }))

  // ----- rain in the next hours ------------------------------------------------------------------------------------------------

  /** The sentence about the next `minutes` of rain, and the periods it is made from. */
  const rainSentence = (ctx: { readonly place: Place; readonly named: boolean; readonly settings: WeatherSettingsView; readonly lang: Language; readonly timeoutMs: number; readonly contact: string | undefined }, minutes: number) =>
    Effect.gen(function*() {
      const { lang } = ctx
      const f = yield* env.client().forecast(ctx.place, ctx.settings.units === "fahrenheit", ctx.timeoutMs, ctx.contact)
      const now = yield* Clock.currentTimeMillis
      const m = f.value.minutely_15
      // A quarter-hour of rain that is not known is not a dry one: no data, not "no rain".
      if (m === undefined || f.ageMs > SLOT_MAX_AGE_MS && f.source === "stale") return yield* new Said({ message: say(texts, lang, "noRainData", { place: ctx.place.name }) })
      const offsetMs = f.value.utc_offset_seconds * 1000
      const slots = m.time.map((time, i) => ({ time, startMs: Date.parse(`${time}:00Z`) - offsetMs, mm: m.precipitation[i] ?? Number.NaN }))
      const periods = periodsOf(slots, now, minutes * 60_000)
      if (periods.length === 0 || slots.some((s) => Number.isNaN(s.mm) && s.startMs + 900_000 > now && s.startMs < now + minutes * 60_000)) {
        return yield* new Said({ message: say(texts, lang, "noRainData", { place: ctx.place.name }) })
      }
      const where = ctx.named ? ` in ${ctx.place.name}` : ""
      const [first, second, third] = periods
      let spoken: string
      if (first!.kind === "dry") {
        spoken = second === undefined
          ? say(texts, lang, "rainNone", { where, span: speakDuration(minutes * 60_000, lang) ?? `${minutes}` })
          : say(texts, lang, third === undefined ? "rainStarts" : "rainStartsFor", {
            where,
            time: speakTime(clockOf(second.from), lang) ?? second.from.slice(11),
            kind: kindWord(second.kind, lang),
            span: speakDuration(second.minutes * 60_000, lang) ?? `${second.minutes}`
          })
      } else {
        spoken = cap(
          second === undefined
            ? say(texts, lang, "rainNowStays", { kind: kindWord(first!.kind, lang), where, span: speakDuration(minutes * 60_000, lang) ?? `${minutes}` })
            : say(texts, lang, "rainNowStops", { kind: kindWord(first!.kind, lang), where, time: speakTime(clockOf(second.from), lang) ?? second.from.slice(11) })
        )
      }
      if (first!.kind === "dry") spoken = cap(spoken)
      return { spoken, wetSoon: first!.kind !== "dry" || second !== undefined, periods: periods.map((p) => ({ kind: p.kind, from: p.from.slice(11), to: p.to.slice(11) })) }
    })

  const rainSoon = (named: string | undefined, minutes: number, turn: TurnContext | undefined): Effect.Effect<Answer, unknown> =>
    Effect.gen(function*() {
      const ctx = yield* resolve(named, turn, undefined)
      const r = yield* withBudget(rainSentence(ctx, minutes), ctx.settings.timeoutMs)
      return { spoken: r.spoken, place: ctx.place.name, periods: r.periods, source: "Open-Meteo, 15-minute precipitation" }
    })

  // ----- the forecast of a day ---------------------------------------------------------------------------------------------------

  const dayIndex = (word: string | undefined, dates: ReadonlyArray<string>): number | "ask" | "far" => {
    const w = word?.trim().toLowerCase() ?? ""
    if (w === "" || w === "today" || w === "vandaag") return 0
    if (w === "tomorrow" || w === "morgen") return 1
    if (w === "day after tomorrow" || w === "overmorgen") return 2
    const iso = /^(\d{4}-\d{2}-\d{2})$/.exec(w)?.[1]
    if (iso !== undefined) return dates.indexOf(iso) >= 0 ? dates.indexOf(iso) : "far"
    const weekday = WEEKDAYS[w.replace(/^(on|this|next|op|aanstaande|komende)\s+/, "")]
    if (weekday === undefined) return "ask"
    const at = dates.findIndex((d) => weekdayOf(d) === weekday)
    return at >= 0 ? at : "far"
  }

  const forecastDay = (named: string | undefined, day: string | undefined, hours: number | undefined, turn: TurnContext | undefined): Effect.Effect<Answer, unknown> =>
    Effect.gen(function*() {
      const ctx = yield* resolve(named, turn, undefined)
      const { lang, settings } = ctx
      const fahrenheit = settings.units === "fahrenheit"
      return yield* withBudget(
        Effect.gen(function*() {
          const f = (yield* env.client().forecast(ctx.place, fahrenheit, ctx.timeoutMs, ctx.contact)).value
          const dates = f.daily.time
          const at = dayIndex(day, dates)
          if (at === "ask") return yield* new Said({ message: say(texts, lang, "dayAsk") })
          if (at === "far") return yield* new Said({ message: say(texts, lang, "dayTooFar") })
          const d = dates[at]!
          const min = f.daily.temperature_2m_min[at]
          const max = f.daily.temperature_2m_max[at]
          const code = f.daily.weather_code[at]
          if (min === null || min === undefined || max === null || max === undefined) return yield* new WeatherError({ reason: "unreadable" })
          const rain = f.daily.precipitation_probability_max[at] ?? undefined
          const wind = f.daily.wind_speed_10m_max[at] ?? undefined
          const unit = fahrenheit ? "mph" : "km/h"
          const windy = wind !== undefined && wind >= (fahrenheit ? 20 : 30)
          const condition = (lang === "nl" ? conditionsNl : conditionsEn)[code ?? -1] ?? (lang === "nl" ? "onbekend weer" : "unknown conditions")
          const dayWord = speakDate(dateParts(d), lang, dateParts(dates[0]!)) ?? d
          let spoken = cap(
            say(texts, lang, "forecast", {
              day: dayWord,
              where: ctx.named ? ` in ${ctx.place.name}` : "",
              condition,
              min: num(min, lang),
              max: num(max, lang),
              degrees: say(texts, lang, fahrenheit ? "degreesF" : "degrees"),
              rain: rain !== undefined && rain >= 30 ? say(texts, lang, "rainChance", { n: num(rain, lang) }) : "",
              wind: windy ? say(texts, lang, "windUpTo", { n: num(wind!, lang), unit }) : ""
            })
          )
          const hourly: Array<{ time: string; temperature: number; rainChance: number | null; condition: string }> = []
          if (hours !== undefined && at === 0) {
            // The place's own clock, to the hour, in the form the service writes ("2026-11-18T10").
            const nowIso = new Date((yield* Clock.currentTimeMillis) + f.utc_offset_seconds * 1000).toISOString().slice(0, 13)
            const start = f.hourly.time.findIndex((t) => t.slice(0, 13) >= nowIso)
            const from = start < 0 ? 0 : start
            for (let i = from; i < Math.min(f.hourly.time.length, from + hours); i++) {
              const t = f.hourly.temperature_2m[i]
              if (t === null || t === undefined) continue
              hourly.push({ time: f.hourly.time[i]!.slice(11), temperature: Math.round(t), rainChance: f.hourly.precipitation_probability[i] ?? null, condition: (lang === "nl" ? conditionsNl : conditionsEn)[f.hourly.weather_code[i] ?? -1] ?? "" })
            }
            if (hourly.length > 0) {
              spoken += say(texts, lang, "hours", {
                n: num(hourly.length, lang),
                min: num(Math.min(...hourly.map((h) => h.temperature)), lang),
                max: num(Math.max(...hourly.map((h) => h.temperature)), lang),
                degrees: say(texts, lang, fahrenheit ? "degreesF" : "degrees"),
                p: num(Math.max(...hourly.map((h) => h.rainChance ?? 0)), lang)
              })
            }
          }
          return {
            spoken,
            place: ctx.place.name,
            date: d,
            condition,
            min: Math.round(min),
            max: Math.round(max),
            rainChance: rain ?? null,
            windMax: wind === undefined ? null : Math.round(wind),
            units: { temperature: fahrenheit ? "°F" : "°C", wind: unit },
            ...(hourly.length > 0 ? { hourly: hourly.slice(0, 24) } : {})
          } satisfies Answer
        }),
        settings.timeoutMs
      )
    })

  // ----- warnings ------------------------------------------------------------------------------------------------------------------

  const typeName = (w: Warning, lang: Language) =>
    w.type !== undefined && w.type in awarenessTypeKeys ? say(texts, lang, awarenessTypeKeys[w.type as keyof typeof awarenessTypeKeys]) : say(texts, lang, "typeOther")

  const warningSentence = (list: ReadonlyArray<Warning>, lang: Language, zone: string, nowMs: number) => {
    const top = list[0]!
    const today = isoIn(nowMs, zone)
    const when = (ms: number) => {
      const iso = isoIn(ms, zone)
      const time = speakTime(clockOf(iso), lang) ?? iso.slice(11)
      return iso.slice(0, 10) === today.slice(0, 10) ? time : say(texts, lang, "at", { day: speakDate(dateParts(iso), lang, dateParts(today)) ?? iso.slice(0, 10), time })
    }
    const level = say(texts, lang, top.level === "yellow" ? "levelYellow" : top.level === "orange" ? "levelOrange" : "levelRed")
    return cap(
      say(texts, lang, "warnYes", { level, what: typeName(top, lang), place: top.area, until: top.untilMs === undefined ? "" : say(texts, lang, "warnUntil", { when: when(top.untilMs) }) }) +
        (list.length > 1 ? say(texts, lang, "warnMore", { count: num(list.length - 1, lang) }) : "")
    )
  }

  const warnings = (named: string | undefined, turn: TurnContext | undefined, budgetMs: number | undefined): Effect.Effect<Answer & { readonly lead: boolean; readonly any: boolean }, unknown> =>
    Effect.gen(function*() {
      const ctx = yield* resolve(named, turn, budgetMs)
      const { lang } = ctx
      const failed = new Said({ message: say(texts, lang, "warnUnavailable") })
      if (ctx.place.country === undefined) return yield* failed
      const feed = yield* env.client().warnings(ctx.place.country, ctx.timeoutMs, ctx.contact).pipe(Effect.mapError(() => failed))
      const now = yield* Clock.currentTimeMillis
      const parsed = parseWarnings(feed.value, now, HORIZON_MS)
      // A feed that is not what was expected, or too old: never "no warnings".
      if (parsed._tag === "unreadable" || (feed.source === "stale" && feed.ageMs > 2 * 3_600_000)) return yield* failed
      const mine = forPlace(parsed.warnings, ctx.place)
      if (mine.length === 0) return { spoken: say(texts, lang, "warnNone", { place: ctx.place.admin1 ?? ctx.place.name }), place: ctx.place.name, warnings: [], lead: false, any: false }
      const zone = homeZone(ctx.view.home)
      return {
        spoken: warningSentence(mine, lang, zone, now),
        place: ctx.place.name,
        warnings: mine.slice(0, 5).map((w) => ({ level: w.level, phenomenon: typeName(w, "en"), area: w.area, ...(w.untilMs !== undefined ? { until: new Date(w.untilMs).toISOString() } : {}) })),
        lead: mine[0]!.level !== "yellow",
        any: true
      }
    })

  // ----- tools and actions ---------------------------------------------------------------------------------------------------------

  const placeParam = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100)).annotate({ description: "City name, optionally followed by a comma and region or country; leave out for home" }))

  const toolError = (lang: () => Language) => (e: unknown) => new ToolError({ message: failureText(e, lang()) })
  const lang = () => homeLanguage(env.view())

  const rainTool = makeTool({
    name: "weather_rain_soon",
    description: "Say whether it will rain in the next hour or two, when it starts and stops, and how hard, for home or a named place. Rain data comes in quarter-hours.",
    parameters: Schema.Struct({
      place: placeParam,
      minutes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 120 })).annotate({ description: "How far ahead to look, 30 to 120 minutes; default 120" }))
    }),
    speculative: true,
    latency: "quick",
    execute: ({ place, minutes }) => Effect.flatMap(currentTurn, (turn) => rainSoon(place, minutes ?? 120, turn)).pipe(Effect.mapError(toolError(lang)))
  })

  const forecastTool = makeTool({
    name: "weather_forecast",
    description: "The weather forecast for a day this week (today, tomorrow, or a weekday): conditions, lowest and highest temperature, chance of rain, strong wind. With `hours` for today, also the next hours.",
    parameters: Schema.Struct({
      place: placeParam,
      day: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(30)).annotate({ description: "today, tomorrow, a weekday name, or a date like 2026-11-20; default today" })),
      hours: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 })).annotate({ description: "For today: also summarise this many coming hours" }))
    }),
    speculative: true,
    latency: "quick",
    execute: ({ place, day, hours }) => Effect.flatMap(currentTurn, (turn) => forecastDay(place, day, hours, turn)).pipe(Effect.mapError(toolError(lang)))
  })

  const warningsTool = makeTool({
    name: "weather_warnings",
    description: "Weather warnings (code yellow, orange or red) in force or coming in the next two days for home or a named place, from the public MeteoAlarm service. Says so when the service cannot be checked.",
    parameters: Schema.Struct({ place: placeParam }),
    speculative: true,
    latency: "quick",
    execute: ({ place }) =>
      Effect.flatMap(currentTurn, (turn) => warnings(place, turn, undefined)).pipe(
        Effect.map(({ lead: _lead, any: _any, ...answer }) => answer),
        Effect.mapError(toolError(lang))
      )
  })

  const actionError = (e: unknown) => new ActionError({ message: failureText(e, lang()) })
  const rainAction = defineAction({
    id: "rain_soon",
    label: "Will it rain soon",
    description: "Say whether it will rain in the next hour or two at home. Not for a forecast of a whole day: that is `tomorrow` or the weather.",
    examples: ["will it rain in the next hour", "is it going to rain soon", "gaat het het komende uur regenen", "komt er regen aan"],
    params: {},
    speculative: true,
    offerAsTool: false,
    run: () => Effect.flatMap(currentTurn, (turn) => rainSoon(undefined, 120, turn)).pipe(Effect.map((a) => ({ say: a.spoken })), Effect.mapError(actionError))
  })
  const tomorrowAction = defineAction({
    id: "tomorrow",
    label: "Weather tomorrow",
    description: "Say tomorrow's weather forecast at home. Today's weather is `today`.",
    examples: ["what's the weather tomorrow", "will it be cold tomorrow", "wat voor weer wordt het morgen", "hoe wordt het weer morgen"],
    params: {},
    speculative: true,
    offerAsTool: false,
    run: () => Effect.flatMap(currentTurn, (turn) => forecastDay(undefined, "tomorrow", undefined, turn)).pipe(Effect.map((a) => ({ say: a.spoken })), Effect.mapError(actionError))
  })
  const warningsAction = defineAction({
    id: "warnings",
    label: "Weather warnings",
    description: "Say whether there are weather warnings for home.",
    examples: ["any weather warnings", "is there a weather warning", "zijn er weerwaarschuwingen", "is er code geel"],
    params: {},
    speculative: true,
    offerAsTool: false,
    run: () => Effect.flatMap(currentTurn, (turn) => warnings(undefined, turn, undefined)).pipe(Effect.map((a) => ({ say: a.spoken })), Effect.mapError(actionError))
  })

  // ----- the briefing ----------------------------------------------------------------------------------------------------------------

  /** A briefing waits for no one: the cache, or one lookup within this budget. */
  const BRIEFING_BUDGET_MS = 600
  const unavailable = (detail: string) => new BriefingSectionError({ reason: "unavailable", detail })

  const weatherSection: BriefingSection = {
    id: "weather",
    title: "Weather",
    gather: (request: BriefingRequest): Effect.Effect<BriefingSectionResult, BriefingSectionError> =>
      Effect.gen(function*() {
        const settings = env.settings(request.turn)
        if (settings === undefined || settings.defaultPlace.trim() === "") return { _tag: "empty" } as const
        const sentences: Array<string> = []
        let priority: "lead" | "normal" = "normal"
        const ctx = yield* resolve(undefined, request.turn, BRIEFING_BUDGET_MS)
        const r = yield* withBudget(rainSentence({ ...ctx, lang: request.language }, 120), BRIEFING_BUDGET_MS).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (r !== undefined && r.wetSoon) {
          sentences.push(r.spoken)
          priority = "lead"
        }
        const day = yield* withBudget(forecastDay(undefined, "today", undefined, request.turn), BRIEFING_BUDGET_MS)
        sentences.push((day as Answer).spoken)
        return { _tag: "section", sentences: sentences.slice(0, request.maxSentences), priority, withheld: 0 } as const
      }).pipe(Effect.mapError((e) => unavailable(e instanceof WeatherError ? e.reason : "failed"))) as Effect.Effect<BriefingSectionResult, BriefingSectionError>
  }

  const warningsSection: BriefingSection = {
    id: "weather.warnings",
    title: "Weather warnings",
    gather: (request) =>
      Effect.gen(function*() {
        const settings = env.settings(request.turn)
        if (settings === undefined || settings.defaultPlace.trim() === "") return { _tag: "empty" } as const
        const r = yield* warnings(undefined, request.turn, BRIEFING_BUDGET_MS)
        if (!r.any) return { _tag: "empty" } as const
        return { _tag: "section", sentences: [r.spoken].slice(0, request.maxSentences), priority: r.lead ? "lead" : "normal", withheld: 0 } as const
      }).pipe(
        Effect.catch((e) => Effect.fail(new BriefingSectionError({ reason: "unavailable", detail: e instanceof WeatherError ? e.reason : "failed" })))
      ) as Effect.Effect<BriefingSectionResult, BriefingSectionError>
  }

  return { tools: [rainTool, forecastTool, warningsTool], actions: [rainAction, tomorrowAction, warningsAction], sections: [weatherSection, warningsSection] }
}

// The turn of a call, read where the call runs (`undefined` outside a turn).
const currentTurn = CurrentTurn
