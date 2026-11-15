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
 * - A device without a session still has a conversation id (the one its first turn will start in), so a page can
 *   show it and `conversation.new` works before anything was said.
 */

export interface VoiceSessionsOptions {
  /** Build a session (in its own scope; closed when it is discarded). */
  readonly make: (
    key: string,
    device: { readonly id: string; readonly name: string } | undefined,
    initial: ConversationInfo | undefined
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
  /** A device without a session started a new conversation: tell its connections. */
  readonly announce: (key: string, conversation: ConversationInfo) => void
}

export interface VoiceSessions {
  readonly get: (key: string) => VoiceSession | undefined
  /** The device's session, created if needed; `"full"` when `max()` sessions exist already. */
  readonly open: (key: string, device: { readonly id: string; readonly name: string } | undefined) => VoiceSession | "full"
  /** The device's connections now (0 starts the discard timer, more cancels it). */
  readonly connections: (key: string, count: number) => void
  /** The device's conversation: its session's, else the one its first turn will start in. */
  readonly conversation: (key: string) => ConversationInfo
  /**
   * `conversation.new` on a device: `assistant`'s conversation in its session (absent: the answering assistant's),
   * else a new reserved id (announced).
   */
  readonly newConversation: (key: string, assistant?: string) => Effect.Effect<ConversationInfo>
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
  const sessions = new Map<string, { readonly session: VoiceSession; readonly scope: Scope.Closeable }>()
  const reserved = new Map<string, ConversationInfo>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const traces: Array<TraceInfo> = []
  let closed = false

  const fresh = (): ConversationInfo => ({ id: globalThis.crypto.randomUUID(), startedAt: Date.now() })
  const reserve = (key: string, info: ConversationInfo) => {
    reserved.delete(key)
    reserved.set(key, info)
    while (reserved.size > MAX_RESERVED) reserved.delete(reserved.keys().next().value!)
    return info
  }

  const stop = (entry: { readonly session: VoiceSession; readonly scope: Scope.Closeable }) =>
    Effect.andThen(
      entry.session.conversation.end,
      Scope.close(entry.scope, Exit.void)
    ).pipe(Effect.catchCause((cause) => Effect.logError(`Voice session ${entry.session.name()} did not close cleanly`, cause)))

  const discard = (key: string) => {
    const entry = sessions.get(key)
    if (entry === undefined) return
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
      const initial = reserved.get(key)
      reserved.delete(key)
      const session = options.runSync(Scope.provide(options.make(key, device, initial), scope))
      sessions.set(key, { session, scope })
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
    conversation: (key) => sessions.get(key)?.session.conversation.conversation() ?? reserved.get(key) ?? reserve(key, fresh()),
    newConversation: (key, assistant) =>
      Effect.suspend(() => {
        const session = sessions.get(key)?.session
        if (session !== undefined) return session.conversation.newConversation(assistant)
        return Effect.sync(() => {
          const info = reserve(key, fresh())
          options.announce(key, info)
          return info
        })
      }),
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
      sessions.clear()
      return Effect.forEach(all, stop, { concurrency: "unbounded", discard: true })
    })
  }
}
