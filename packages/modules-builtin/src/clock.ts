import { type AssistantModule, defineAction, defineModule, type HostView, makeTool, Param, Setting, ToolError } from "@pva/core"
import { homeLanguage, type Language } from "@pva/module-contracts"
import { DateTime, Effect, Option, Schema } from "effect"
import { OPS, REPEATS, run as runExtended, Say, UNITS } from "./clock/extended.ts"

export { run as extendedTime, texts as clockTexts, type ExtendedInput } from "./clock/extended.ts"

export interface ClockOptions {
  /** IANA zone of the user. Default: the system zone. */
  readonly timeZone?: string
  /** BCP 47 locale for formatting. Default "en-GB". */
  readonly locale?: string
}

/**
 * Where the extended operations read the household's language, at each call (the Home section's, as it is set now; not
 * the date format). Absent (the clock started without the host's view, as its version 1 callers start it): the
 * language of the date format.
 */
export interface ClockLanguage {
  readonly language?: () => Language
}

/**
 * Reference module: a context provider (local date and time, sent with every
 * turn in the LLM request's `context` field, separate from the cached system
 * prompt) and a read-only tool (time in another zone).
 * Time comes from Effect's `Clock`, so tests can use `TestClock`.
 */
export const makeClock = (options: ClockOptions & ClockLanguage = {}): AssistantModule => {
  const locale = options.locale ?? "en-GB"
  const language = options.language ?? ((): Language => (locale.toLowerCase().startsWith("nl") ? "nl" : "en"))
  const zone = options.timeZone === undefined || options.timeZone === "" ? Intl.DateTimeFormat().resolvedOptions().timeZone : options.timeZone
  const localZone = DateTime.zoneMakeNamedUnsafe(zone)

  const describe = (now: DateTime.Zoned) => ({
    timeZone: DateTime.zoneToString(now.zone),
    date: DateTime.format(now, { locale, dateStyle: "full" }),
    time: DateTime.format(now, { locale, timeStyle: "short" }),
    iso: DateTime.formatIsoOffset(now)
  })

  const localNow = Effect.map(DateTime.now, (now) => DateTime.setZone(now, localZone))

  // Minute resolution: seconds would be noise in a spoken answer. (The context
  // is not part of the cached prompt prefix, so changing it costs no cache hit.)
  const context = {
    name: "Clock",
    get: Effect.map(localNow, (now) => {
      const d = describe(now)
      return `It is ${d.date}, ${d.time} local time (${d.timeZone}).`
    })
  }

  const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
  const currentTime = makeTool({
    name: "current_time",
    description:
      "Get the current date and time in an IANA time zone, e.g. \"America/New_York\" or \"Asia/Tokyo\" (the household's own zone is in the context line). With no op, answers the time there. " +
      "op converts or counts: \"convert\" (what `time` in zone `from` on `date`, default today there, is in timeZone), \"until\" or \"since\" a `date` (days), \"add\" `amount` of `unit` to a date, \"week\" (week number of a date). " +
      "`place` is a city name that replaces timeZone. Dates are ISO (2026-12-25) or words (\"3 March\", \"next monday\"); an ambiguous date, a time that does not exist that day, and a time that happens twice when the clocks go back are a question back to the person: ask it, then call again (for a repeated time with `repeat`).",
    parameters: Schema.Struct({
      timeZone: Schema.String.annotate({ description: "IANA time zone name" }),
      op: optional(Schema.Literals(OPS).annotate({ description: "What to work out; absent: the time in timeZone" })),
      place: optional(Schema.String.check(Schema.isMaxLength(60)).annotate({ description: "A city (Tokyo, Den Haag): its zone is used instead of timeZone" })),
      date: optional(Schema.String.check(Schema.isMaxLength(120)).annotate({ description: "A date, ISO or in words; absent means today where the op allows" })),
      time: optional(Schema.String.check(Schema.isMaxLength(60)).annotate({ description: "A clock time, for op convert (\"15:00\", \"3 pm\")" })),
      from: optional(Schema.String.check(Schema.isMaxLength(60)).annotate({ description: "For op convert: the city or IANA zone `time` is in (default the household's zone)" })),
      repeat: optional(Schema.Literals(REPEATS).annotate({ description: "For op convert: a time that happens twice when the clocks go back, the earlier or the later one (only when the person said which)" })),
      amount: optional(Schema.Int.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 })).annotate({ description: "For op add: how many (negative goes back)" })),
      unit: optional(Schema.Literals(UNITS).annotate({ description: "For op add: days (default), weeks, months or years" }))
    }),
    speculative: true,
    latency: "instant",
    execute: ({ timeZone, op, ...rest }) => {
      // No op: the original answer, unchanged.
      if (op === undefined && rest.place === undefined) {
        return Option.match(DateTime.zoneMakeNamed(timeZone), {
          onNone: () => Effect.fail(new ToolError({ message: `Unknown time zone "${timeZone}"` })),
          onSome: (zone) => Effect.map(DateTime.now, (now) => describe(DateTime.setZone(now, zone)))
        })
      }
      return Effect.flatMap(DateTime.now, (now) =>
        Effect.try({
          try: () => runExtended({ timeZone, op: op ?? "now", ...rest }, { now: DateTime.toEpochMillis(now), zone, lang: language() }),
          catch: (error) => new ToolError({ message: error instanceof Say ? error.message : "I couldn't work that out." })
        }))
    }
  })

  return { name: "clock", tools: [currentTime], context: [context] }
}

/** A place the `time_now` action knows by name. */
export interface ClockPlace {
  readonly name: string
  /** IANA zone. */
  readonly zone: string
  readonly aliases?: ReadonlyArray<string>
}

/** The places `time_now` offers (a `places` setting replaces this constant with the settings widening, piece G/H). */
export const defaultPlaces: ReadonlyArray<ClockPlace> = [
  { name: "Amsterdam", zone: "Europe/Amsterdam" },
  { name: "London", zone: "Europe/London", aliases: ["Londen"] },
  { name: "New York", zone: "America/New_York" },
  { name: "Tokyo", zone: "Asia/Tokyo" }
]

/**
 * The `time_now` action (docs/AGENTS-AND-INTENTS.md §3.9): read-only, so the
 * intent agent may run it during a speculative turn. "It's 14:32." or, for a
 * named place, "In Tokyo it's 22:32."
 */
export const clockActions = (options: ClockOptions & { readonly places?: ReadonlyArray<ClockPlace> } = {}) => {
  const locale = options.locale ?? "en-GB"
  const local = options.timeZone === undefined || options.timeZone === "" ? Intl.DateTimeFormat().resolvedOptions().timeZone : options.timeZone
  const places = options.places ?? defaultPlaces
  const timeIn = (zone: string) =>
    Effect.map(DateTime.now, (now) => DateTime.format(DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(zone)), { locale, timeStyle: "short" }))
  const timeNow = defineAction({
    id: "time_now",
    label: "Tell the time",
    description: "Say what time it is now, here or in one of the named places.",
    examples: ["what time is it", "what's the time in Tokyo", "hoe laat is het", "hoe laat is het in New York"],
    params: {
      zone: Param.choice({
        label: "Place",
        optional: true,
        options: places.map((p) => ({ value: p.zone, label: p.name, ...(p.aliases !== undefined ? { aliases: p.aliases } : {}) }))
      })
    },
    speculative: true,
    run: ({ zone }) =>
      Effect.map(timeIn(zone ?? local), (time) => {
        const place = zone === undefined ? undefined : places.find((p) => p.zone === zone)
        return { say: place === undefined ? `It's ${time}.` : `In ${place.name} it's ${time}.` }
      })
  })
  return [timeNow]
}

/**
 * The clock as a module: time zone and date format are settings. It declares API version 2 only to read the household's
 * language through the host's view for the extended operations; everything else is as in version 1 (on by default, no
 * shared part), and its start still takes the version 1 context its existing callers give it (no `host`).
 */
export const clockModule = defineModule({
  apiVersion: 2,
  id: "clock",
  name: "Clock",
  description: "Tells the model the local date and time, and the time anywhere else.",
  settings: {
    timeZone: Setting.text({
      label: "Time zone",
      description: "IANA name, e.g. Europe/Amsterdam. Follows Home's time zone unless set here; empty: this machine's zone.",
      placeholder: Intl.DateTimeFormat().resolvedOptions().timeZone,
      env: "CLOCK_TIME_ZONE",
      maxLength: 64,
      overridable: true,
      check: (zone) => (zone === "" || Option.isSome(DateTime.zoneMakeNamed(zone)) ? undefined : "Unknown time zone")
    }),
    locale: Setting.choice({
      label: "Date format",
      options: [
        { value: "en-GB", label: "13 November 2026" },
        { value: "en-US", label: "November 13, 2026" },
        { value: "nl-NL", label: "13 november 2026" }
      ],
      default: "en-GB",
      overridable: true
    })
  },
  start: (ctx) =>
    Effect.sync(() => {
      const host = (ctx as { readonly host?: { readonly view: () => HostView } }).host
      const language = host === undefined ? {} : { language: () => homeLanguage(host.view()) }
      return { ...makeClock({ ...ctx.settings, ...language }), actions: clockActions(ctx.settings) }
    })
})
