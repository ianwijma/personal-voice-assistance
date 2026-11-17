import type { ConversationEvent, Message, Trace } from "@pva/core"
import type { HistoryItem, ServerMessage, TraceInfo } from "@pva/protocol"

/**
 * Turns `ConversationEvent`s into protocol messages (docs/UI-AND-MODULES.md
 * §4.4). Synchronous: `Conversation.onEvent` calls it on the turn's fiber, it
 * maps the event and calls `broadcast` (which serialises once and writes to
 * each socket). A speculative turn's messages are held back until it is
 * promoted and dropped if it is discarded, so it never appears in any UI.
 */

const TOOL_INPUT_LIMIT = 2_048
export const MAX_TRACES = 20
export const MAX_HISTORY_ITEMS = 200

interface TurnView {
  readonly spoken: boolean
  pending: boolean
  readonly buffer: Array<ServerMessage>
  readonly voice: string
  /** The assistant answering (protocol 7 `assistantId` on its messages). */
  readonly assistant: string | undefined
}

export interface PublisherOptions {
  readonly broadcast: (message: ServerMessage) => void
  /** The module that contributes a tool (from the module host's current snapshot). */
  readonly moduleOfTool: (name: string) => string | null
  /** The key of the voice that speaks `assistant`'s replies in this session (`assistant.text.voice`). */
  readonly voice: (assistant: string | undefined) => string
  /** Right after `turn.start` of a committed (or just promoted) turn went out, before the rest of its messages. */
  readonly onCommitted?: (turnId: number) => void
  /** A committed turn ended: its trace (serve mode keeps the recent ones of every session for admin). */
  readonly onTrace?: (trace: TraceInfo) => void
}

export interface Publisher {
  /** `assistant`: the assistant whose conversation the event comes from (its id tags the turn's messages). */
  readonly onEvent: (event: ConversationEvent, assistant?: string) => void
  /** The most recent traces, oldest first (for `welcome`). */
  readonly traces: () => ReadonlyArray<TraceInfo>
  /** The committed turn that is running (between `turn.start` and `turn.end`). */
  readonly committedTurn: () => number | undefined
}

const truncateInput = (input: unknown): unknown => {
  let json: string | undefined
  try {
    json = JSON.stringify(input)
  } catch {
    return String(input)
  }
  if (json === undefined) return null
  return json.length <= TOOL_INPUT_LIMIT ? JSON.parse(json) : `${json.slice(0, TOOL_INPUT_LIMIT)}…`
}

/** Marks relative to end of turn, as in the CLI's latency line. */
export const traceInfo = (trace: Trace): TraceInfo => {
  const origin = trace.marks.endOfTurn ?? trace.startedAt
  const marks: Record<string, number> = {}
  for (const key of ["llmRequestSent", "llmFirstToken", "firstClause", "ttsFirstAudio", "playbackStart", "routeSent", "routeReceived"] as const) {
    const t = trace.marks[key]
    if (t !== undefined) marks[key] = Math.round((t - origin) * 10) / 10
  }
  return {
    turnId: trace.id,
    mode: trace.mode,
    speculative: trace.speculative,
    outcome: trace.outcome ?? "failed",
    marks,
    ...(trace.endedAt !== undefined ? { totalMs: Math.round((trace.endedAt - origin) * 10) / 10 } : {}),
    tools: trace.tools.map((t) => ({ name: t.name, ms: Math.max(0, Math.round(t.ms)) })),
    voices: [...trace.voices],
    ...(trace.client !== undefined ? { client: { ...trace.client } } : {}),
    ...(trace.session !== undefined ? { session: trace.session.slice(0, 64) } : {}),
    // Protocol 7 (docs/ASSISTANTS.md §3.7, §5.4): who answered, on which device, and who chose the assistant.
    ...(trace.assistant !== undefined ? { assistant: { id: trace.assistant.id, name: trace.assistant.name } } : {}),
    ...(trace.deviceId !== undefined ? { deviceId: trace.deviceId } : {}),
    ...(trace.device !== undefined ? { device: trace.device } : {}),
    ...(trace.route !== undefined ? { route: { ...trace.route } } : {})
  }
}

export const makePublisher = (options: PublisherOptions): Publisher => {
  const turns = new Map<number, TurnView>()
  const traces: Array<TraceInfo> = []
  let committed: number | undefined

  const send = (turnId: number, message: ServerMessage) => {
    const view = turns.get(turnId)
    if (view?.pending === true) view.buffer.push(message)
    else options.broadcast(message)
  }

  /** Protocol 7: `assistantId` on a turn's messages. */
  const tag = (view: TurnView | undefined) => (view?.assistant !== undefined ? { assistantId: view.assistant } : {})

  const handle = (event: ConversationEvent, assistant: string | undefined) => {
    switch (event._tag) {
      case "TurnStarted": {
        const view: TurnView = {
          spoken: event.spoken,
          pending: event.speculative,
          buffer: [],
          voice: options.voice(assistant),
          assistant
        }
        turns.set(event.turnId, view)
        const start: ServerMessage = {
          type: "turn.start",
          turnId: event.turnId,
          source: event.source,
          userText: event.text,
          spoken: event.spoken,
          ...tag(view)
        }
        if (event.speculative) view.buffer.push(start)
        else {
          committed = event.turnId
          options.broadcast(start)
          options.onCommitted?.(event.turnId)
        }
        return
      }
      case "TurnPromoted": {
        const view = turns.get(event.turnId)
        if (view === undefined) return
        view.pending = false
        committed = event.turnId
        const [start, ...rest] = view.buffer.splice(0)
        if (start !== undefined) options.broadcast(start)
        options.onCommitted?.(event.turnId)
        for (const message of rest) options.broadcast(message)
        return
      }
      case "TextDelta": {
        const view = turns.get(event.turnId)
        if (view === undefined || view.spoken) return
        const text = event.text
        if (text.length > 0) send(event.turnId, { type: "assistant.text", turnId: event.turnId, clause: null, text, ...tag(view) })
        return
      }
      case "ClauseQueued": {
        const view = turns.get(event.turnId)
        if (view === undefined) return
        const text = event.text.trim()
        if (text.length === 0) return
        send(event.turnId, { type: "assistant.text", turnId: event.turnId, clause: event.index, text, voice: view.voice, ...tag(view) })
        return
      }
      case "ClausePlaying":
        return send(event.turnId, { type: "assistant.playing", turnId: event.turnId, clause: event.index })
      case "ToolStarted":
        return send(event.turnId, {
          type: "tool.start",
          turnId: event.turnId,
          callId: event.call.id,
          tool: event.call.name,
          moduleId: options.moduleOfTool(event.call.name),
          input: truncateInput(event.call.input) as never,
          ...tag(turns.get(event.turnId))
        })
      case "ToolFinished":
        return send(event.turnId, {
          type: "tool.end",
          turnId: event.turnId,
          callId: event.result.id,
          ok: !event.result.isError,
          ms: Math.max(0, event.ms),
          ...(event.result.isError ? { error: event.result.content.slice(0, 500) } : {}),
          ...tag(turns.get(event.turnId))
        })
      case "TurnEnded": {
        const view = turns.get(event.turnId)
        turns.delete(event.turnId)
        if (committed === event.turnId) committed = undefined
        if (event.outcome === "discarded" || view?.pending === true) return
        const info = traceInfo(event.trace)
        traces.push(info)
        if (traces.length > MAX_TRACES) traces.shift()
        // Admin's traces carry the session and the device (its name, which admin sets); the device's own tabs do not
        // need them.
        options.onTrace?.(info)
        const { session: _session, device: _device, deviceId: _deviceId, ...forDevice } = info
        options.broadcast({ type: "turn.end", turnId: event.turnId, outcome: event.outcome, trace: forDevice })
        if (event.outcome === "failed") {
          options.broadcast({
            type: "error",
            error: { code: "turn_failed", message: "That reply failed (see the assistant's log); the conversation continues.", turnId: event.turnId }
          })
        }
        return
      }
    }
  }

  return {
    onEvent: (event, assistant) => {
      try {
        handle(event, assistant)
      } catch (error) {
        console.error("serve: could not publish a conversation event", error)
      }
    },
    traces: () => traces.slice(),
    committedTurn: () => committed
  }
}

/**
 * History as the user saw it: one user item per user message and at most one
 * assistant item per turn (its text, interrupted if any part
 * was, and its tool calls with success). The last `MAX_HISTORY_ITEMS` items.
 */
export const historyItems = (messages: ReadonlyArray<Message>): Array<HistoryItem> => {
  const items: Array<HistoryItem> = []
  let texts: Array<string> = []
  let interrupted = false
  let tools: Array<{ name: string; ok: boolean }> = []
  let calls = new Map<string, { name: string; ok: boolean }>()
  let open = false
  const close = () => {
    if (open && (texts.length > 0 || tools.length > 0)) items.push({ role: "assistant", text: texts.join(" "), interrupted, tools })
    texts = []
    interrupted = false
    tools = []
    calls = new Map()
    open = false
  }
  for (const message of messages) {
    switch (message.role) {
      case "user":
        close()
        items.push({ role: "user", text: message.content })
        open = true
        break
      case "assistant": {
        open = true
        const text = message.content.trim()
        if (text.length > 0) texts.push(text)
        if (message.interrupted === true) interrupted = true
        for (const call of message.toolCalls ?? []) {
          const tool = { name: call.name, ok: true }
          tools.push(tool)
          calls.set(call.id, tool)
        }
        break
      }
      case "tool":
        for (const result of message.results) {
          const tool = calls.get(result.id)
          if (tool !== undefined) tool.ok = !result.isError
        }
        break
    }
  }
  close()
  return items.slice(-MAX_HISTORY_ITEMS)
}
