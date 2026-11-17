import { Effect, Stream } from "effect"
import { type Agent, type AgentEvent, AgentError, type AgentTurnInput } from "./Agent.ts"
import type { Message, ToolCall, ToolResult } from "./Domain.ts"
import type { Llm } from "./Services.ts"
import { addTraceEvent } from "./TurnTrace.ts"

/**
 * A `model` agent over any `Llm` (docs/AGENTS-AND-INTENTS.md §1.7): the
 * assistant's own tool loop, moved out of `Conversation` unchanged.
 *
 * Request = system prompt, per-turn context, the shared history, the user's
 * text and the rounds of this turn so far, and the tools of the turn's
 * snapshot. Tool calls of one response run concurrently; a non-speculative
 * tool waits for `promoted`. A `"\n"` is emitted before the tools of a round
 * that said something, so the clause chunker flushes it and it is heard while
 * the tools run. At most `maxToolRounds` rounds of tools (so at most
 * `maxToolRounds + 1` model calls).
 */

interface Round {
  text: string
  readonly toolCalls: Array<ToolCall>
  results?: ReadonlyArray<ToolResult>
}

const roundMessages = (rounds: ReadonlyArray<Round>): Array<Message> =>
  rounds.flatMap((r): Array<Message> =>
    r.results === undefined ? [] : [
      { role: "assistant", content: r.text, toolCalls: r.toolCalls },
      { role: "tool", results: r.results }
    ]
  )

const NEWLINE: AgentEvent = { _tag: "TextDelta", text: "\n" }

/** The whole turn (every round and the tools between them) inside the instance's hold, when it has one. */
const held = (llm: Llm["Service"], turn: Stream.Stream<AgentEvent, AgentError>): Stream.Stream<AgentEvent, AgentError> =>
  llm.holdDuring === undefined ? turn : llm.holdDuring(turn)

export const makeModelAgent = (options: { readonly llm: Llm["Service"] }): Pick<Agent, "turn"> => ({
  turn: (input: AgentTurnInput): Stream.Stream<AgentEvent, AgentError> =>
    held(options.llm, Stream.suspend(() => {
      const { llm } = options
      const tools = input.tools
      const request = input.context === undefined ? { system: input.system } : { system: input.system, context: input.context }
      const base: ReadonlyArray<Message> = [...input.history, { role: "user", content: input.text }]
      const rounds: Array<Round> = []
      // One clock for the tool spans and the model events: the trace's (`input.now`), else the monotonic one.
      const clock = input.now ?? (() => performance.now())
      const now = Effect.sync(clock)

      const runTools = (round: Round): Stream.Stream<AgentEvent> => {
        const results: Array<ToolResult | undefined> = round.toolCalls.map(() => undefined)
        const gate = round.toolCalls.some((call) => !tools.isSpeculative(call.name))
          ? Stream.fromEffectDrain(input.promoted)
          : Stream.empty
        const calls = round.toolCalls.map((call, index) =>
          Stream.make({ _tag: "ToolStarted", call } as AgentEvent).pipe(
            Stream.concat(Stream.fromEffect(Effect.gen(function*() {
              const start = yield* now
              const result = yield* tools.run(call)
              const ms = (yield* now) - start
              results[index] = result
              input.trace.tools.push({ name: call.name, ms })
              addTraceEvent(input.trace, "tool", start, ms, call.name)
              return { _tag: "ToolFinished", result, ms } satisfies AgentEvent
            })))
          )
        )
        return gate.pipe(
          Stream.concat(calls.length === 1 ? calls[0]! : Stream.mergeAll(calls, { concurrency: "unbounded" })),
          Stream.concat(Stream.fromEffectDrain(Effect.sync(() => {
            round.results = results as Array<ToolResult>
          })))
        )
      }

      const round = (n: number): Stream.Stream<AgentEvent, AgentError> =>
        Stream.suspend(() => {
          const current: Round = { text: "", toolCalls: [] }
          const messages = [...base, ...roundMessages(rounds)]
          rounds.push(current)
          const detail = `round ${n + 1}`
          input.mark("llmRequestSent")
          addTraceEvent(input.trace, "llmRequestSent", clock(), undefined, detail)
          let first = false
          return llm.stream({ ...request, messages, tools: tools.specs }).pipe(
            Stream.mapError((error) => new AgentError({ message: error.message, reason: "failed", cause: error })),
            Stream.map((event): AgentEvent | undefined => {
              switch (event._tag) {
                case "TextDelta":
                  input.mark("llmFirstToken")
                  if (!first) {
                    first = true
                    addTraceEvent(input.trace, "llmFirstToken", clock(), undefined, detail)
                  }
                  current.text += event.text
                  return event.text.length > 0 ? event : undefined
                case "ToolCall":
                  current.toolCalls.push({ id: event.id, name: event.name, input: event.input })
                  return undefined
                case "Done":
                  addTraceEvent(input.trace, "llmDone", clock(), undefined, detail)
                  return undefined
              }
            }),
            Stream.filter((event): event is AgentEvent => event !== undefined),
            Stream.concat(Stream.suspend(() => {
              if (current.toolCalls.length === 0) return Stream.empty
              if (n >= input.maxToolRounds) {
                return Stream.fromEffectDrain(Effect.logWarning(`Tool round limit (${input.maxToolRounds}) reached; ending turn`))
              }
              // "\n" makes the clause chunker flush what was said before the tools run.
              const flush = current.text.length > 0 ? Stream.make(NEWLINE) : Stream.empty
              return flush.pipe(Stream.concat(runTools(current)), Stream.concat(round(n + 1)))
            }))
          )
        })

      return round(0)
    }))
})
