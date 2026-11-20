import type { Message, ReportInput, TurnContext } from "@pva/core"
import type { TraceInfo } from "@pva/protocol"
import { Effect } from "effect"
import type { EndedConversation } from "./previous.ts"
import { type Fact, type HealthLine, type LogLine, missing, type Missing, type ReportFacts, type ShownItem } from "./render.ts"

/**
 * What a report gathers for its turn, from the host (docs/REPORTS.md "What a report holds"). Each source is asked once,
 * when the report is drafted; one that is not there, or fails, is left out with the reason the report gives
 * ("No history: the server restarted since"). Nothing here waits on the network.
 */
export interface ReportSources {
  /** The conversation of the assistant on the device now (its id and history); `undefined`: the device has no voice session. */
  readonly conversation: (deviceId: string, assistantId: string | undefined) => Effect.Effect<{ readonly conversationId: string; readonly history: ReadonlyArray<Message> } | undefined>
  /** The last conversation of the device and assistant that ended recently. */
  readonly previous: (deviceId: string, assistantId: string) => EndedConversation | undefined
  /** The traces of every session, oldest first (the report takes the device's). */
  readonly traces: () => ReadonlyArray<TraceInfo>
  /** The device as the server knows it: its name, facts and what the server shows there now. */
  readonly device: (deviceId: string) => { readonly name: string; readonly facts: ReadonlyArray<Fact>; readonly shown: ReadonlyArray<ShownItem> } | undefined
  /** The assistant's name and its configuration that matters for debugging (never a key). */
  readonly assistant: (assistantId: string) => { readonly name: string; readonly facts: ReadonlyArray<Fact> } | undefined
  readonly server: () => ReadonlyArray<Fact>
  readonly health: () => ReadonlyArray<HealthLine>
  /** The recent warnings and errors of the log (`undefined`: not kept in this mode). */
  readonly warnings: () => ReadonlyArray<LogLine> | undefined
}

const tryOr = <A>(f: () => A, why: string): A | Missing => {
  try {
    return f()
  } catch {
    return missing(why)
  }
}

/** The most messages of a conversation a report takes (the newest). */
const MAX_HISTORY = 400

/** `turn` is the host's own reading of `CurrentTurn` (never the module's word). */
export const gatherFacts = (input: ReportInput, turn: TurnContext, id: string, createdAt: number, sources: ReportSources): Effect.Effect<ReportFacts> =>
  Effect.gen(function*() {
    const deviceId = turn.deviceId
    const assistantId = turn.assistantId
    // The conversation now. The turn the report is made in is still running, so it is not in the history yet.
    const conversation: ReportFacts["conversation"] = deviceId === undefined
      ? missing("the report was not made on a device.")
      : yield* sources.conversation(deviceId, assistantId).pipe(
        Effect.map((c): ReportFacts["conversation"] => {
          if (c === undefined) return missing("the device has no voice session now (the server restarted, or the device was away long enough for its session to be discarded).")
          // Only the report's own conversation: a newer one on the device is not what the person was reporting.
          if (c.conversationId !== turn.conversationId) return missing("the device's conversation changed since the report's turn started (a new one began meanwhile).")
          return {
            conversationId: c.conversationId,
            history: c.history.slice(-MAX_HISTORY),
            note: "The turn the report was made in was still running, so it is not in this transcript; its words are in the description."
          }
        }),
        Effect.catchCause(() => Effect.succeed(missing("the history could not be read.")))
      )
    const ended = deviceId !== undefined && assistantId !== undefined ? tryOr(() => sources.previous(deviceId, assistantId), "it could not be read.") : undefined
    const previous: ReportFacts["previous"] = ended === undefined
      ? missing("no conversation of this assistant on this device ended in the last hour (the server keeps the previous one that long, in memory only).")
      : "missing" in ended
      ? ended
      : ended.conversationId === turn.conversationId
      ? missing("the conversation kept as the previous one is the report's own.")
      : { conversationId: ended.conversationId, endedAt: ended.endedAt, history: ended.history }
    const traces: ReportFacts["traces"] = deviceId === undefined
      ? missing("the report was not made on a device.")
      // The device's traces of the report's assistant (a trace that names none, a phrase command's, is kept).
      : tryOr(() => sources.traces().filter((t) => t.deviceId === deviceId && (assistantId === undefined || t.assistant === undefined || t.assistant.id === assistantId)), "they could not be read.")
    const device = deviceId === undefined ? missing("the report was not made on a device.") : tryOr(() => sources.device(deviceId) ?? missing(`the device ${JSON.stringify(deviceId)} is not known (any more).`), "it could not be read.")
    const assistant = assistantId === undefined ? missing("the turn names no assistant.") : tryOr(() => sources.assistant(assistantId) ?? missing(`the assistant ${JSON.stringify(assistantId)} is not known (any more).`), "it could not be read.")
    const server = tryOr(() => sources.server(), "")
    const health = tryOr(() => sources.health(), "")
    const warnings = tryOr(() => sources.warnings() ?? missing("this mode keeps no log lines."), "they could not be read.")
    return {
      id,
      kind: input.kind,
      title: input.title,
      description: input.description,
      answers: (input.answers ?? []).slice(0, 6),
      createdAt,
      turn: { turnId: turn.turnId, conversationId: turn.conversationId, source: turn.source },
      ...("missing" in device ? {} : { deviceName: device.name }),
      ...("missing" in assistant ? {} : { assistantName: assistant.name }),
      conversation,
      previous,
      traces,
      device: "missing" in device ? device : device.facts,
      shown: "missing" in device ? device : device.shown,
      assistant: "missing" in assistant ? assistant : assistant.facts,
      server: "missing" in server ? [] : server,
      health: "missing" in health ? [] : health,
      warnings
    } satisfies ReportFacts
  })
