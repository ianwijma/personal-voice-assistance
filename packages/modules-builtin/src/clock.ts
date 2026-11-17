import { type AssistantModule, defineAction, defineModule, makeTool, Param, Setting, ToolError } from "@pva/core"
import { DateTime, Effect, Option, Schema } from "effect"

export interface ClockOptions {
  /** IANA zone of the user. Default: the system zone. */
  readonly timeZone?: string
  /** BCP 47 locale for formatting. Default "en-GB". */
  readonly locale?: string
}

/**
 * Reference module: a context provider (local date and time, sent with every
 * turn in the LLM request's `context` field, separate from the cached system
 * prompt) and a read-only tool (time in another zone).
 * Time comes from Effect's `Clock`, so tests can use `TestClock`.
 */
export const makeClock = (options: ClockOptions = {}): AssistantModule => {
  const locale = options.locale ?? "en-GB"
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

  const currentTime = makeTool({
    name: "current_time",
    description: "Get the current date and time in an IANA time zone, e.g. \"America/New_York\" or \"Asia/Tokyo\".",
    parameters: Schema.Struct({
      timeZone: Schema.String.annotate({ description: "IANA time zone name" })
    }),
    speculative: true,
    execute: ({ timeZone }) =>
      Option.match(DateTime.zoneMakeNamed(timeZone), {
        onNone: () => Effect.fail(new ToolError({ message: `Unknown time zone "${timeZone}"` })),
        onSome: (zone) => Effect.map(DateTime.now, (now) => describe(DateTime.setZone(now, zone)))
      })
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

/** The clock as a module: time zone and date format are settings. */
export const clockModule = defineModule({
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
  start: ({ settings }) => Effect.sync(() => ({ ...makeClock(settings), actions: clockActions(settings) }))
})
