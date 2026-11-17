import type { ConversationInfo, SessionInfo, TraceInfo } from "@pva/protocol"
import { Effect, Exit, Scope } from "effect"
import { MAX_TRACES } from "./Publisher.ts"
import type { VoiceSession } from "./VoiceSession.ts"

/**
 * The voice sessions of serve mode (docs/VOICE-SESSIONS.md §1, §2): device → `VoiceSession`.
 *
 * - A session is created at its device's first `audio.claim` or typed message (`open`), not at connect, so an idle
 *   open tab costs nothing. At most `max()` exist. One more takes the place of the least recently active session whose
 *   device has no connection (discarded early, as below); when every session's device is connected it is refused
 *   (`"full"`, error `sessions_full`).
 * - When its device has had no connection for `discardMs()` (`SESSION_DISCARD_MINUTES`), the session is discarded:
 *   its loop stops, its conversation is dropped (the agents are told, so a Claude subscription session closes) and
 *   its audio pipeline is closed. A device that comes back within that time finds its session as it left it.
 * - A device without a session still has a conversation id for each assistant (the one that assistant's first turn
 *   will start in), so a page can show it and `conversation.new` works before anything was said. The caller names the
 *   assistant (the one that will answer, when it means the device's) and passes the device's assignment list; the
 *   session takes every id over.
 */

export interface VoiceSessionsOptions {
  /** Build a session (in its own scope; closed when it is discarded). */
  readonly make: (
    key: string,
    device: { readonly id: string; readonly name: string } | undefined,
    /** Ids reserved for the device's assistants before its session existed (`conversation(key, assistant)`), by assistant. */
    reserved: ReadonlyMap<string, ConversationInfo> | undefined,
    /**
     * P5: this session was discarded or ended (`true` from then on, set in the step that removes it). Whatever it
     * still does while it stops (a reply, a tool, a transcript) must check it before sending to the device's
     * connections: a later session of the same device has the same key.
     */
    ended: () => boolean
  ) => Effect.Effect<VoiceSession, never, Scope.Scope>
  /** `MAX_VOICE_SESSIONS`, live. */
  readonly max: () => number
  /** `SESSION_DISCARD_MINUTES` in ms, live. */
  readonly discardMs: () => number
  /** Runs an effect synchronously with the server's services (logging). */
  readonly runSync: <A>(effect: Effect.Effect<A>) => A
  /** Runs an effect in the background in the server's scope. */
  readonly run: (effect: Effect.Effect<void>) => void
  /** A session was created or discarded, or something its admin row shows changed (`minor`: only its state). */
  readonly onChange: (minor: boolean) => void
  /** A session was discarded (the hub forgets its ownership). */
  readonly onDiscard: (key: string) => void
  /** A device without a session started a new conversation (`assistant`'s): tell its connections. */
  readonly announce: (key: string, conversation: ConversationInfo, assistant: string | undefined) => void
}

export interface VoiceSessions {
  readonly get: (key: string) => VoiceSession | undefined
  /** The device's session, created if needed; `"full"` when `max()` sessions exist already. */
  readonly open: (key: string, device: { readonly id: string; readonly name: string } | undefined) => VoiceSession | "full"
  /** The device's connections now (0 starts the discard timer, more cancels it). */
  readonly connections: (key: string, count: number) => void
  /**
   * `assistant`'s conversation on the device: in its session (absent: the answering assistant's), else the id reserved
   * for it (the session gives it to that assistant). Without a session the caller names the assistant (the one that
   * will answer for the device's own); absent only when the device has none. `assigned`: the ids of the device's
   * assistants now (its setup's list); used only without a session, to drop the reservations of the others.
   */
  readonly conversation: (key: string, assistant: string | undefined, assigned: ReadonlyArray<string>) => ConversationInfo
  /**
   * `conversation.new` on a device: `assistant`'s conversation in its session (absent: the answering assistant's),
   * else a new id reserved for `assistant` (announced; the other assistants keep theirs). `assigned`: as above.
   */
  readonly newConversation: (key: string, assistant: string | undefined, assigned: ReadonlyArray<string>) => Effect.Effect<ConversationInfo>
  /**
   * P5: the device's boundary changed (`deviceFacts.ts`): synchronously, its session is marked ended (it sends nothing
   * more), removed (the next `open` makes a new one, with new conversation ids) and stopped in the background (every
   * conversation ended, its agents told, its conversation-scoped rows erased); its reserved ids and discard timer go
   * too. The hub closes the device's connections in the same step.
   */
  readonly endDevice: (key: string) => void
  /** For admin: every session, most recently active first. */
  readonly list: () => ReadonlyArray<SessionInfo>
  readonly all: () => ReadonlyArray<VoiceSession>
  readonly size: () => number
  /** The most recently active session (the phrase tester's default). */
  readonly mostRecent: () => VoiceSession | undefined
  /** The recent traces of every session, oldest first (admin). */
  readonly traces: () => ReadonlyArray<TraceInfo>
  readonly addTrace: (trace: TraceInfo) => void
  /** Discard every session now (the server stops). */
  readonly closeAll: Effect.Effect<void>
}

/** Device ids remembered with a conversation id before their session exists. */
const MAX_RESERVED = 64

export const makeVoiceSessions = (options: VoiceSessionsOptions): VoiceSessions => {
  type Entry = { readonly session: VoiceSession; readonly scope: Scope.Closeable; readonly fence: { ended: boolean } }
  const sessions = new Map<string, Entry>()
  /**
   * Per device without a session, the ids reserved for its assistants (`""`: the device has no assistant).
   *
   * Invariant: a device holds a reservation only for an assistant assigned to it now (or `""` while it has none).
   * Every read or new reservation first drops the device's other ones (`reserve`, with the assignment list the caller
   * passes), so a device never holds more entries than it has assignments (at most `MAX_ASSIGNMENTS`). A reservation
   * of an assistant that is still assigned goes only by `conversation.new` for it, or when the session opens and takes
   * them over (or with the whole device, the oldest past `MAX_RESERVED`). An assistant taken off the device loses its
   * reservation at the next read or reservation; put back, it gets a new id.
   */
  const reserved = new Map<string, Map<string, ConversationInfo>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const traces: Array<TraceInfo> = []
  let closed = false

  const fresh = (): ConversationInfo => ({ id: globalThis.crypto.randomUUID(), startedAt: Date.now() })
  /** The device's reservations, most recently used last (the oldest devices are forgotten past `MAX_RESERVED`). */
  const reservationsOf = (key: string): Map<string, ConversationInfo> => {
    const byAssistant = reserved.get(key) ?? new Map<string, ConversationInfo>()
    reserved.delete(key)
    reserved.set(key, byAssistant)
    while (reserved.size > MAX_RESERVED) reserved.delete(reserved.keys().next().value!)
    return byAssistant
  }
  /**
   * `assistant`'s reservation on the device (`renew`: a new one in its place), after dropping those of assistants not
   * in `assigned` (the invariant above). An assistant not in `assigned` gets an id that is not kept.
   */
  const reserve = (key: string, assistant: string | undefined, assigned: ReadonlyArray<string>, renew: boolean): ConversationInfo => {
    const keep = new Set(assigned.length === 0 ? [""] : assigned)
    const byAssistant = reservationsOf(key)
    for (const a of [...byAssistant.keys()]) if (!keep.has(a)) byAssistant.delete(a)
    const slot = assistant ?? ""
    const info = (renew ? undefined : byAssistant.get(slot)) ?? fresh()
    if (keep.has(slot)) byAssistant.set(slot, info)
    return info
  }

  const stop = (entry: Entry) =>
    Effect.andThen(
      entry.session.conversation.end,
      Scope.close(entry.scope, Exit.void)
    ).pipe(Effect.catchCause((cause) => Effect.logError(`Voice session ${entry.session.name()} did not close cleanly`, cause)))

  const discard = (key: string) => {
    const entry = sessions.get(key)
    if (entry === undefined) return
    entry.fence.ended = true
    sessions.delete(key)
    reserved.delete(key)
    options.onDiscard(key)
    options.onChange(false)
    options.run(stop(entry))
  }

  const cancelTimer = (key: string) => {
    const timer = timers.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(key)
  }

  return {
    get: (key) => sessions.get(key)?.session,
    open: (key, device) => {
      const existing = sessions.get(key)
      if (existing !== undefined) return existing.session
      if (closed) return "full"
      // At the limit, a device that is here takes the place of one that left (no connection, waiting for its
      // discard timer): the least recently active of those is discarded now. Full only when every session's
      // device is still connected.
      while (sessions.size >= Math.max(1, options.max())) {
        let gone: VoiceSession | undefined
        for (const k of timers.keys()) {
          const s = sessions.get(k)?.session
          if (s !== undefined && (gone === undefined || s.lastActiveAt() < gone.lastActiveAt())) gone = s
        }
        if (gone === undefined) return "full"
        cancelTimer(gone.key)
        options.runSync(Effect.logInfo(`Voice session ${gone.name()} discarded early: its device left and another one needs the place`))
        discard(gone.key)
      }
      const scope = options.runSync(Scope.make())
      const ids = reserved.get(key)
      reserved.delete(key)
      const fence = { ended: false }
      const session = options.runSync(Scope.provide(options.make(key, device, ids, () => fence.ended), scope))
      sessions.set(key, { session, scope, fence })
      session.conversation.start()
      options.onChange(false)
      return session
    },
    connections: (key, count) => {
      if (count > 0) return cancelTimer(key)
      if (!sessions.has(key) || timers.has(key)) return
      const timer = setTimeout(() => {
        timers.delete(key)
        discard(key)
      }, Math.max(0, options.discardMs()))
      timer.unref?.()
      timers.set(key, timer)
    },
    conversation: (key, assistant, assigned) => {
      const session = sessions.get(key)?.session
      if (session !== undefined) return session.conversation.conversation(assistant)
      return reserve(key, assistant, assigned, false)
    },
    newConversation: (key, assistant, assigned) =>
      Effect.suspend(() => {
        const session = sessions.get(key)?.session
        if (session !== undefined) return session.conversation.newConversation(assistant)
        return Effect.sync(() => {
          const info = reserve(key, assistant, assigned, true)
          options.announce(key, info, assistant)
          return info
        })
      }),
    endDevice: (key) => {
      cancelTimer(key)
      reserved.delete(key)
      discard(key)
    },
    list: () => [...sessions.values()].map((e) => e.session).sort((a, b) => b.lastActiveAt() - a.lastActiveAt()).map((s) => s.info()),
    all: () => [...sessions.values()].map((e) => e.session),
    size: () => sessions.size,
    mostRecent: () => {
      let best: VoiceSession | undefined
      for (const { session } of sessions.values()) if (best === undefined || session.lastActiveAt() > best.lastActiveAt()) best = session
      return best
    },
    traces: () => traces.slice(),
    addTrace: (trace) => {
      traces.push(trace)
      if (traces.length > MAX_TRACES) traces.shift()
    },
    closeAll: Effect.suspend(() => {
      closed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      const all = [...sessions.values()]
      for (const entry of all) entry.fence.ended = true
      sessions.clear()
      return Effect.forEach(all, stop, { concurrency: "unbounded", discard: true })
    })
  }
}
