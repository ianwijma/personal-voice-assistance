import type { Message } from "@pva/core"

/**
 * The last ended conversation per device and assistant, kept in memory for a while (docs/REPORTS.md "What a report
 * holds"): the idle reset (the assistant's `newConversationAfter`) empties the history at the start of the very turn
 * that says "report that the timer didn't ring", so what the person reports is usually in the conversation before.
 * Fed by the sessions' `conversationEnded` hook with the history the conversation had when it ended. Bounded: one
 * conversation per device and assistant, at most `maxEntries` of them, its newest `maxMessages` messages, for
 * `keepMs`. Never written anywhere; a restart forgets it. A conversation is kept with the device's privacy boundary
 * of that moment (its place and default person, as the caller words it): one asked for under another boundary is not
 * given (a device made public since does not hand on what was said while it was private).
 */

export const PREVIOUS_KEEP_MS = 60 * 60_000
const MAX_ENTRIES = 64
const MAX_MESSAGES = 200

export interface EndedConversation {
  readonly conversationId: string
  readonly endedAt: number
  readonly history: ReadonlyArray<Message>
  /** The device's privacy boundary when it ended (the caller's words). */
  readonly boundary?: string
}

export interface PreviousConversations {
  /** A conversation ended (an empty one is not kept, and does not replace the one kept). */
  readonly ended: (deviceId: string, assistantId: string, conversationId: string, history: ReadonlyArray<Message>, boundary?: string) => void
  /** The last ended conversation of the device and assistant, while it is recent enough and under the same boundary. */
  readonly get: (deviceId: string, assistantId: string, boundary?: string) => EndedConversation | undefined
  /** Forget a device's (its session was discarded or the device removed). */
  readonly forgetDevice: (deviceId: string) => void
  /** Forget everything (the report module stopped). */
  readonly clear: () => void
}

export const makePreviousConversations = (options: { readonly now?: () => number; readonly keepMs?: number; readonly maxEntries?: number } = {}): PreviousConversations => {
  const now = options.now ?? Date.now
  const keepMs = options.keepMs ?? PREVIOUS_KEEP_MS
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  const kept = new Map<string, EndedConversation>()
  const keyOf = (deviceId: string, assistantId: string) => JSON.stringify([deviceId, assistantId])
  const expire = () => {
    const cutoff = now() - keepMs
    for (const [k, v] of kept) if (v.endedAt < cutoff) kept.delete(k)
  }
  return {
    ended: (deviceId, assistantId, conversationId, history, boundary) => {
      if (history.length === 0) return
      expire()
      const key = keyOf(deviceId, assistantId)
      kept.delete(key)
      kept.set(key, { conversationId, endedAt: now(), history: history.slice(-MAX_MESSAGES), ...(boundary !== undefined ? { boundary } : {}) })
      while (kept.size > maxEntries) kept.delete(kept.keys().next().value!)
    },
    get: (deviceId, assistantId, boundary) => {
      expire()
      const found = kept.get(keyOf(deviceId, assistantId))
      return found === undefined || found.boundary !== boundary ? undefined : found
    },
    forgetDevice: (deviceId) => {
      for (const k of [...kept.keys()]) if ((JSON.parse(k) as [string, string])[0] === deviceId) kept.delete(k)
    },
    clear: () => kept.clear()
  }
}
