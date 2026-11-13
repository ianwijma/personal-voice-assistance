import { type AssistantModule, makeTool, ToolError } from "@pva/core"
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
export const clockModule = (options: ClockOptions = {}): AssistantModule => {
  const locale = options.locale ?? "en-GB"
  const localZone = DateTime.zoneMakeNamedUnsafe(options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)

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
