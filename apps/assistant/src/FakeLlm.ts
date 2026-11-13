import { Llm, type LlmEvent, type LlmRequest } from "@pva/core"
import { Effect, Layer, Stream } from "effect"

/**
 * Offline stand-in for a real model, so text mode runs without an API key.
 * Questions about the time go through the `current_time` tool (exercising the
 * tool loop); everything else is echoed back. Words stream with a small delay.
 */
const respond = (request: LlmRequest): Array<LlmEvent> => {
  const last = request.messages.at(-1)
  if (last?.role === "tool") {
    const result = last.results[0]
    if (result === undefined || result.isError) return words("Sorry, I could not read the clock.")
    const { time, date, timeZone } = JSON.parse(result.content) as Record<string, string>
    return words(`It is ${time} on ${date} in ${timeZone}.`)
  }
  const text = last?.role === "user" ? last.content.trim() : ""
  if (/\btime\b/i.test(text) && request.tools.some((t) => t.name === "current_time")) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return [
      { _tag: "ToolCall", id: `call_${request.messages.length}`, name: "current_time", input: { timeZone } },
      { _tag: "Done", stopReason: "tool_use" }
    ]
  }
  return words(text.length > 0 ? `You said: ${text}` : "I did not catch that.")
}

const words = (text: string): Array<LlmEvent> => [
  ...text.split(/(?<= )/).map((word): LlmEvent => ({ _tag: "TextDelta", text: word })),
  { _tag: "Done", stopReason: "end" }
]

export interface FakeLlmTiming {
  /** Request → first event (text or tool call), standing in for a hosted model's time to first token. Default 0. */
  readonly firstTokenMs?: number
  /** Words per second after the first one. Default 1000 / 15 (a 15 ms gap). 0 = all at once. */
  readonly tokensPerSecond?: number
}

const make = (timing: FakeLlmTiming = {}) => {
  const firstTokenMs = timing.firstTokenMs ?? 0
  const gapMs = timing.tokensPerSecond === undefined ? 15 : timing.tokensPerSecond > 0 ? 1000 / timing.tokensPerSecond : 0
  return Llm.of({
    stream: (request) =>
      Stream.suspend(() => {
        let first = true
        return Stream.fromIterable(respond(request)).pipe(
          Stream.tap((event) => {
            if (event._tag === "Done") return Effect.void
            const wait = first ? firstTokenMs : event._tag === "TextDelta" ? gapMs : 0
            first = false
            return wait > 0 ? Effect.sleep(wait) : Effect.void
          })
        )
      })
  })
}

export const FakeLlm = {
  make,
  layer: Layer.succeed(Llm, make()),
  /** With a simulated time to first token and token rate (for `bench --live`). */
  layerTimed: (timing: FakeLlmTiming) => Layer.succeed(Llm, make(timing))
}
