import type { AssistantState, SessionInfo } from "@pva/protocol"

/**
 * Voice sessions as the pages show them (docs/VOICE-SESSIONS.md §5): the refused Start in plain words, and the words
 * for a session's state in admin.
 */

/**
 * The start error for `sessions_full`: "The assistant is already talking on 4 devices. …". The count comes from the
 * server's message ("… on N devices"); without one it says "on other devices".
 */
export const sessionsFullText = (serverMessage: string | undefined): string => {
  const n = serverMessage === undefined ? undefined : /\b(\d+)\s+devices?\b/i.exec(serverMessage)?.[1]
  const where = n === undefined ? "on other devices" : n === "1" ? "on another device" : `on ${n} devices`
  return `The assistant is already talking ${where}. Try again when ${n === "1" ? "it is" : "one of them is"} done.`
}

/** A session's state as a few words ("waiting for the wake phrase"). */
export const STATE_WORD: Readonly<Record<AssistantState, string>> = {
  idle: "idle",
  asleep: "waiting for the wake phrase",
  listening: "listening",
  hearing: "hearing someone",
  thinking: "thinking",
  speaking: "speaking"
}

export const stateWord = (state: AssistantState): string => STATE_WORD[state] ?? state

/** The sessions whose device has a tab that owns the audio now ("talking now"), most recently active first. */
export const talkingSessions = (sessions: ReadonlyArray<SessionInfo>): ReadonlyArray<SessionInfo> => sessions.filter((x) => x.ownerPresent)

/** "3 turns", "1 turn", "no turns yet". */
export const turnsText = (n: number): string => (n === 0 ? "no turns yet" : `${n} turn${n === 1 ? "" : "s"}`)

/** "just now", "5 min ago", "2 h ago" for an epoch-ms time. */
export const agoText = (at: number, now: number): string => {
  const ms = Math.max(0, now - at)
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return `${Math.floor(ms / 86_400_000)} d ago`
}
