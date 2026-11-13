import type { Message } from "@pva/core"

/**
 * What a harness agent's own session missed (docs/AGENTS-AND-INTENTS.md §1.4).
 * The shared history is the truth; the harness keeps its own session, so at
 * each turn it is sent what other agents said since its last turn, and a new
 * session is primed with the recent history.
 */

export const CATCH_UP_LIMIT = 20

/** `agentId` on assistant messages arrives with build-plan piece A; read it without depending on it. */
const agentIdOf = (m: Message): string | undefined => (m as { readonly agentId?: string }).agentId

/** "jev" → "Jev", "claude-subscription" → "Claude subscription". */
export const prettyAgentName = (id: string): string => {
  const words = id.replace(/[-_]+/g, " ").trim()
  return words.length === 0 ? "Assistant" : words[0]!.toUpperCase() + words.slice(1)
}

export interface CatchUpContext {
  readonly selfId: string
  readonly selfName: string
  /** Display name of another agent by id. */
  readonly nameOf?: (agentId: string) => string | undefined
}

const lines = (messages: ReadonlyArray<Message>, ctx: CatchUpContext): Array<string> => {
  const out: Array<string> = []
  for (const m of messages) {
    if (m.role === "tool") continue
    const content = m.content.replace(/\s+/g, " ").trim()
    if (content === "") continue
    if (m.role === "user") {
      out.push(`User: ${content}`)
      continue
    }
    const id = agentIdOf(m)
    const name = id === undefined ? "Assistant" : id === ctx.selfId ? "You" : ctx.nameOf?.(id) ?? prettyAgentName(id)
    out.push(`${name}: ${content}${m.interrupted === true ? " (interrupted)" : ""}`)
  }
  return out
}

const block = (body: ReadonlyArray<string>) => `<earlier>\n${body.join("\n")}\n</earlier>`

/** The last messages (tool messages left out), for priming a new session. Undefined when there is nothing. */
export const primeBlock = (history: ReadonlyArray<Message>, ctx: CatchUpContext): string | undefined => {
  const body = lines(history.filter((m) => m.role !== "tool").slice(-CATCH_UP_LIMIT), ctx)
  return body.length === 0 ? undefined : block(body)
}

/**
 * The catch-up for an existing session: `history.slice(syncedThrough)` minus
 * the agent's own previous turn (rule 1), as a block, or undefined (rule 2).
 *
 * Own turn: the leading user message and the non-user messages up to the next
 * user message, when the first assistant message there is this agent's. Before
 * messages carry `agentId`, a block that starts exactly where this agent's
 * last turn started is taken to be its own.
 */
export const catchUpBlock = (history: ReadonlyArray<Message>, syncedThrough: number, ctx: CatchUpContext): string | undefined => {
  let missed = history.slice(Math.max(0, Math.min(syncedThrough, history.length)))
  let interruptedLine: string | undefined
  if (missed[0]?.role === "user") {
    let end = 1
    while (end < missed.length && missed[end]!.role !== "user") end++
    const own = missed.slice(1, end)
    const firstAssistant = own.find((m) => m.role === "assistant")
    if (firstAssistant !== undefined) {
      const id = agentIdOf(firstAssistant)
      if (id === ctx.selfId || id === undefined) {
        const reply = own.filter((m): m is Extract<Message, { role: "assistant" }> => m.role === "assistant")
        const last = reply[reply.length - 1]
        if (last?.interrupted === true) {
          const heard = reply.map((m) => m.content).join(" ").replace(/\s+/g, " ").trim()
          interruptedLine = `(You were interrupted; the owner heard only: "${heard}")`
        }
        missed = missed.slice(end)
      }
    }
  }
  const body = lines(missed.filter((m) => m.role !== "tool").slice(-CATCH_UP_LIMIT), ctx)
  if (interruptedLine !== undefined) body.unshift(interruptedLine)
  return body.length === 0 ? undefined : block(body)
}

/** The user message written to the harness. */
export const composeMessage = (parts: {
  readonly instructions?: string | undefined
  readonly earlier?: string | undefined
  readonly context?: string | undefined
  readonly text: string
}): string =>
  [
    parts.instructions !== undefined ? `<instructions>\n${parts.instructions}\n</instructions>` : undefined,
    parts.earlier,
    parts.context !== undefined && parts.context.trim() !== "" ? `<context>\n${parts.context}\n</context>` : undefined,
    parts.text
  ].filter((s): s is string => s !== undefined).join("\n\n")
