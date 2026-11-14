import type { PlayerEvent } from "./VoiceAudio.ts"

/**
 * The page's side of reply playback for one audio session: the messages to the player worklet, the
 * played-sample count of each reply, and the final count the server is told when a reply stops
 * (docs/UI-AND-MODULES.md §2.6). That count is the server's only source for what the owner heard, so
 * (third review, 2026-11-14):
 *
 * - **The count is readable at any time, without asking the worklet.** The worklet publishes it after
 *   every render quantum: into a shared counter (`SharedCounter`) when the page is cross-origin isolated,
 *   otherwise as a small `count` message per quantum while samples are being handed to the device. With
 *   the shared counter the best count here is at most one quantum (2.7 ms at 48 kHz) behind what the
 *   worklet handed out. It switches on by itself as soon as the server sends the isolation headers.
 * - **On the message route the best count is the last count received: a lower bound.** Count messages wait
 *   in the page's task queue behind whatever the main thread is doing, and a browser gives no way to drain a
 *   `MessagePort` synchronously: a `pagehide` handler or a timer cannot receive the messages queued behind
 *   it. So a provisional count (stop deadline, unload, a failed player) can be behind by the count messages
 *   still in flight: one per render quantum (2.7 ms at 48 kHz) while audio plays, for as long as the main
 *   thread was busy. That is the accepted cost (after the final review): the page's clock is never used to
 *   raise a count, because the page cannot tell in time whether the player really rendered what the clock
 *   says (a processor that died while the context runs on for the microphone, a clock that advanced after a
 *   suspension without rendering).
 * - **A final count is final only when it is exact.** A stop is answered by the worklet with its exact
 *   count. If that answer has not come `STOP_ANSWER_MS` after the stop (a context the browser stopped
 *   rendering may not deliver messages to the worklet), the page answers with its best count; when the
 *   exact answer comes later it is always sent too, as a second `playback.stopped` for the reply
 *   (a confirmation or a correction: never suppressed). Every final says whether it is exact (`PlayerEvent.exact`), and the
 *   client sends it as `playback.stopped`'s `exact` (`client.ts`, `playbackReport`): the server keeps an
 *   `exact: false` count as provisional and takes the exact one if it comes within its stop deadline.
 * - **A stop asked for while rendering, then a suspension**: the page tells the worklet to finish that
 *   stop at once (no fade on resume), so nothing of the reply plays after the page may have answered.
 * - **Tearing down never loses the count.** `finalise` stops whatever reply is open and waits (bounded)
 *   for every pending stop to be answered before the caller closes the context; `unload` answers at once
 *   with the published count (a page being unloaded cannot wait).
 *
 * One link per session: a newer session gets a new link, so an old session's teardown only ever touches
 * its own replies.
 *
 * **Who may answer for a reply** (sixth review, finding 1). A count is reported as exact only by the player
 * that rendered that reply's audio and still knows it:
 *
 * - (a) A reply's accounting belongs to the link (player) that received its `start`. When that player dies
 *   (`processorerror`: the page replaces it, `VoiceAudio.replacePlayer`), `retire` answers what was open with
 *   its published count, marked provisional, and hands the page's record of every reply it knew (`InheritedReply`:
 *   its final count, and whether that count is the old player's exact one) to the replacement link.
 * - (b) A link never lets its player answer for a reply it has no record of: a `stopped`, `finished`,
 *   `progress` or `count` from the worklet for an unknown reply is dropped (a fresh worklet answers a stop
 *   for an id it never played with 0). A stop or end of an inherited reply is answered from the record,
 *   provisional unless the record holds the old player's exact count, and is not passed to the new player.
 *   A reply with no record at all is not answered (nothing of it was played here).
 * - (c) A reply whose player was replaced while it played is over on the page: the rest of its audio is
 *   dropped, not played by the new player (it would start after a gap, and its count would not include what
 *   the old player rendered); its final count is the old player's best count, sent as provisional at once,
 *   and again (provisional) when the server's `reply.stop` or `reply.end` closes it. The server keeps that
 *   provisional count; since no exact count follows, it commits it when its wait ends (300 ms after its own
 *   `reply.stop`, or, if it never stops the reply, when its 2 s stall watchdog stops it).
 * - (d) The next reply starts on the new player like any other.
 *
 * A reply cannot outlive its player in the other cases: a WebSocket reconnect flushes the reply on the same
 * player (`stop(undefined, report: false)`), End and a takeover finalise every reply on the same player before
 * its context closes (and a new session's link has no record of the old replies, so it never answers for
 * them), and the fallback from the shared counter to messages keeps the same player and the same records.
 *
 * **A reported count never exceeds the audio actually rendered** (seventh review, finding 1; after the final
 * review, without exception). History records only what was heard, so undercounting by a few milliseconds is
 * acceptable; overcounting is not. Every count the page reports is `publishedCount`: what the worklet itself
 * published (its final once it gave one; else the highest of its count and progress messages and the shared
 * counter). Every published number was written after the worklet rendered those samples, so it is never above
 * what rendered. Every provisional answer (the stop deadline, unload, a failed player's retirement) and
 * `bestCount` is the published count and nothing else; the context's clock never raises a count.
 *
 * **Reply instances** (seventh review, finding 3). A reply id can repeat: the server numbers turns from 1 per
 * process (a page that outlives a server restart sees the same ids again), and the echo test uses one fixed id.
 * So every reply gets an instance token at `replyStart` (`newToken`, unique within the page), every message
 * about a reply to the worklet carries it, the worklet echoes it on every message about that reply and writes it
 * into the shared counter next to the id, and the page takes a message or a counter value only when its token is
 * the current one for that reply. An older instance's queued `finished`, `stopped` or counts are dropped, and a
 * pending stop of an older instance is settled silently when the id starts again (its connection is gone).
 */

/** The next reply instance token (see the header): unique within the page, never 0 (a worklet's "none"). */
let nextToken = 1
const newToken = (): number => {
  const token = nextToken
  nextToken = nextToken >= 0x7fff_ffff ? 1 : nextToken + 1
  return token
}

/** The page's record of a reply whose player died (rule (a) above). */
export interface InheritedReply {
  /** The final count the page holds: the old player's own when `exact`, else its best count (a lower bound). */
  readonly count: number
  readonly exact: boolean
}

/** How long the server waits for `playback.stopped` after it sent `reply.stop` (`packages/audio-web`, `WebAudio.ts`, `stopWaitMs`). */
export const SERVER_STOP_WAIT_MS = 300

/**
 * How long a stop waits for the worklet's exact count before the page answers with its best count:
 * 50 ms (fourth review, finding 3; was 200 ms).
 *
 * The answer must reach the server within `SERVER_STOP_WAIT_MS` of the server sending `reply.stop`, or
 * the server keeps the last `progress` count it received (up to 250 ms stale) and drops the late final.
 * That 300 ms holds: the hop to the page, this wait, the page's own scheduling (a busy main thread,
 * clamped timers) and the hop back. With 50 ms, 250 ms remain for the round trip and scheduling: a
 * slow local link (Wi-Fi in power saving, 100–200 ms round trips) still answers in time, where 200 ms
 * left only 100 ms. A longer wait buys little: a rendering context answers within one render callback (a
 * few ms, ~100 ms with Bluetooth bursts), and a context that is not rendering never answers at all; the
 * best count is behind the exact one by the 4 ms fade, a render quantum, and on the message route the
 * count messages still in flight (see the header). The exact count always follows when it comes, as a confirmation or a correction.
 */
export const STOP_ANSWER_MS = 50

/**
 * Which route the live count takes, and why (fifth review, finding 4): for the "This device" diagnostics.
 * The shared counter is used only once the page has seen it hold a count the worklet also sent by message;
 * until then, and whenever it fails, the count comes by message.
 */
export interface PlaybackRoute {
  readonly route: "shared" | "messages"
  readonly reason: string
}

/** How long the worklet has to say it received the shared counter (`ready`) before the page stops waiting for it. */
export const SHARED_READY_MS = 1000
/** Count messages in a row for the current reply that the shared counter fails to match before it is given up. */
export const SHARED_MISSES = 8

export const ROUTE_REASONS = {
  notIsolated: "the page is not cross-origin isolated",
  unconfirmed: "shared memory not confirmed yet (it is checked while the first reply plays)",
  confirmed: "shared memory, confirmed by the player",
  notReceived: "the player did not receive the shared buffer",
  noReady: "the player did not confirm the shared buffer",
  stuck: "the shared counter did not advance while audio played"
} as const

/** The port of the player node (an `AudioWorkletNode`'s `MessagePort`, or a test double). */
export interface PlayerPort {
  postMessage(message: unknown, transfer?: Array<Transferable>): void
  onmessage: ((event: MessageEvent) => void) | null
}

export interface Timers {
  readonly setTimeout: (f: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

const realTimers: Timers = {
  setTimeout: (f, ms) => setTimeout(f, ms), // continuation(none): a wrapper; each caller guards its callback
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/**
 * The worklet's shared live counter: 5 Int32 (sequence number, odd while a write is in progress; reply
 * id; the reply's instance token; count; 1 while the reply is open). Needs `SharedArrayBuffer`, which browsers
 * give only to cross-origin isolated pages (COOP `same-origin` and COEP `require-corp` response headers).
 */
export class SharedCounter {
  static available(): boolean {
    return typeof SharedArrayBuffer === "function" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  }

  /** The buffer's length: the worklet checks it (`player.js`), so a page and a worklet of different layouts never pair up. */
  static readonly BYTES = 20
  readonly buffer: SharedArrayBuffer
  private readonly view: Int32Array

  constructor() {
    this.buffer = new SharedArrayBuffer(SharedCounter.BYTES)
    this.view = new Int32Array(this.buffer)
  }

  /**
   * The live count of instance `token` of reply `id`, or undefined when the counter holds another reply or
   * another instance of it (or a write kept racing).
   */
  read(id: number, token: number): number | undefined {
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = Atomics.load(this.view, 0)
      if ((before & 1) === 1) continue
      const counted = Atomics.load(this.view, 1) >>> 0
      const instance = Atomics.load(this.view, 2)
      const played = Atomics.load(this.view, 3)
      if (Atomics.load(this.view, 0) !== before) continue
      return counted === id >>> 0 && instance === (token | 0) ? played : undefined
    }
    return undefined
  }
}

interface Reply {
  readonly id: number
  /** This instance of the reply (see the header): messages and counter values of another instance are dropped. */
  readonly token: number
  /** The reply's own sample rate (its count is in these samples). */
  readonly rate: number
  /** The best count known: the highest the worklet reported (progress, count messages, finals). */
  played: number
  /** Not finished or stopped yet (as far as the worklet said). */
  open: boolean
  /** The worklet's own final count (finished or stopped), once it came. */
  exact: number | undefined
  /** What was sent as the final count, and whether it was the exact one. */
  answered: { readonly count: number; readonly exact: boolean; readonly report: boolean } | undefined
  /** A stop that waits for its answer: the deadline, and everyone waiting for the answer. */
  pending: { readonly timer: unknown; readonly report: boolean; readonly waiters: Array<() => void> } | undefined
}

/** A message from the player worklet (see `worklets/player.js`): each about a reply carries its instance `token`. */
type WorkletMessage =
  | (PlayerEvent & { readonly token?: number })
  | { readonly type: "ready"; readonly shared?: boolean }
  | {
    readonly type: "count"
    readonly id: number
    readonly token?: number
    readonly playedSamples: number
  }

/** A worklet message as an event for the page (the instance token is the link's business only). */
type WithoutToken<T> = T extends unknown ? Omit<T, "token"> : never
const withoutToken = <T extends { readonly token?: number }>(e: T): WithoutToken<T> => {
  const { token: _token, ...rest } = e
  return rest as WithoutToken<T>
}

export class PlaybackLink {
  private readonly port: PlayerPort
  private readonly emit: (event: PlayerEvent) => void
  private readonly counter: SharedCounter | undefined
  private readonly timers: Timers
  private readonly replies = new Map<number, Reply>()
  /** Replies of the player this link replaced: the page's records of them (rules (a)–(c) in the header). */
  private readonly inherited: Map<number, InheritedReply>
  private current: number | undefined
  private detached = false
  /** The shared counter's state: used for the count only when `confirmed`. */
  private shared: "none" | "unconfirmed" | "confirmed" | "failed"
  private sharedMisses = 0
  private readyTimer: unknown
  private routeNow: PlaybackRoute
  private readonly onRoute: ((route: PlaybackRoute) => void) | undefined

  constructor(
    port: PlayerPort,
    emit: (event: PlayerEvent) => void,
    options: {
      readonly counter?: SharedCounter | undefined
      readonly timers?: Timers
      /** The route changed (confirmed, or fell back to messages). */
      readonly onRoute?: (route: PlaybackRoute) => void
      /** Why there is no shared counter (when `counter` is undefined). */
      readonly routeReason?: string
      /** Replies of a player this link replaces (`retire`): answered from these records, never by this link's player. */
      readonly inherited?: ReadonlyMap<number, InheritedReply>
    } = {}
  ) {
    this.port = port
    this.emit = emit
    this.inherited = new Map(options.inherited ?? [])
    this.counter = options.counter
    this.timers = options.timers ?? realTimers
    // continuation(link): this link's own port; `detach` clears it and `onMessage` checks `detached`.
    port.onmessage = (e: MessageEvent) => this.onMessage(e.data as WorkletMessage)
    this.onRoute = options.onRoute
    this.shared = this.counter === undefined ? "none" : "unconfirmed"
    this.routeNow = { route: "messages", reason: this.counter === undefined ? options.routeReason ?? ROUTE_REASONS.notIsolated : ROUTE_REASONS.unconfirmed }
    if (this.counter !== undefined) {
      // continuation(link): acts only while this link is attached and the counter still unconfirmed and unanswered.
      this.readyTimer = this.timers.setTimeout(() => {
        this.readyTimer = undefined
        if (!this.detached && this.shared === "unconfirmed") this.sharedFailed(ROUTE_REASONS.noReady)
      }, SHARED_READY_MS)
    }
  }

  /** The route the live count takes now (see `PlaybackRoute`). */
  get route(): PlaybackRoute {
    return this.routeNow
  }

  private setRoute(route: PlaybackRoute) {
    this.routeNow = route
    this.onRoute?.(route)
  }

  /**
   * The shared counter cannot be trusted: stop reading it, and tell the worklet to send `count` messages
   * (it does until it is told the counter works, so none were missed while unconfirmed).
   */
  private sharedFailed(reason: string) {
    if (this.shared === "failed" || this.shared === "none") return
    this.shared = "failed"
    if (this.readyTimer !== undefined) this.timers.clearTimeout(this.readyTimer)
    this.readyTimer = undefined
    this.post({ type: "route", shared: false })
    this.setRoute({ route: "messages", reason })
  }

  /** A count message for `reply`: does the shared counter hold at least as much (it is written first)? */
  private checkShared(reply: Reply, played: number) {
    if (this.shared !== "unconfirmed" || played <= 0) return
    const read = this.counter!.read(reply.id, reply.token)
    if (read !== undefined && read >= played) {
      this.shared = "confirmed"
      if (this.readyTimer !== undefined) this.timers.clearTimeout(this.readyTimer)
      this.readyTimer = undefined
      this.post({ type: "route", shared: true })
      this.setRoute({ route: "shared", reason: ROUTE_REASONS.confirmed })
      return
    }
    // The counter holds another reply: a miss only when this is the reply the page started last (otherwise
    // the worklet may simply be on a newer one already).
    if (read === undefined ? this.current === reply.id : true) {
      if (++this.sharedMisses >= SHARED_MISSES) this.sharedFailed(ROUTE_REASONS.stuck)
    }
  }

  /** The reply now playing (the last one started), if any. */
  get currentReply(): number | undefined {
    return this.current
  }

  /** The last reply started, while it is still open (not finished or stopped as far as the page knows). */
  get openReply(): number | undefined {
    return this.current !== undefined && this.replies.get(this.current)?.open === true ? this.current : undefined
  }

  /**
   * What the worklet itself published for `reply` (see the header): its final count once it gave one, else the
   * highest count it reported or wrote into the shared counter for this instance. Never above what rendered.
   */
  private publishedCount(reply: Reply): number {
    if (reply.exact !== undefined) return reply.exact
    // An unconfirmed counter is read too: it holds only counts the worklet wrote, so it can only raise the
    // count (one that does not work reads nothing); a failed one is not read at all.
    const shared = this.shared === "confirmed" || this.shared === "unconfirmed" ? this.counter?.read(reply.id, reply.token) : undefined
    return Math.max(reply.played, shared ?? 0)
  }

  /** The best count of reply `id` the worklet published: at most one render quantum behind with the shared counter. */
  bestCount(id: number): number {
    const reply = this.replies.get(id)
    if (reply === undefined) return this.inherited.get(id)?.count ?? 0
    return this.publishedCount(reply)
  }

  post(message: unknown, transfer?: Array<Transferable>) {
    if (this.detached) return
    if (transfer === undefined) this.port.postMessage(message)
    else this.port.postMessage(message, transfer)
  }

  replyStart(id: number, sampleRate: number) {
    this.inherited.delete(id) // a new reply of that id is this player's own
    if (this.current !== undefined) {
      const previous = this.replies.get(this.current)
      // A new reply replaces the old one in the worklet (a hard cut; it answers `stopped` for it).
      if (previous !== undefined) previous.open = false
    }
    // An older instance of this id (a server restart, the echo test): its connection is gone, so a stop it still
    // waits for is settled without an answer, and its worklet messages no longer match (rule above: tokens).
    const older = this.replies.get(id)
    if (older?.pending !== undefined) {
      this.timers.clearTimeout(older.pending.timer)
      const waiters = older.pending.waiters
      older.pending = undefined
      for (const w of waiters) w()
    }
    this.replies.delete(id) // re-inserted below: the newest reply is the last in the map's order
    const token = newToken()
    this.current = id
    this.replies.set(id, { id, token, rate: sampleRate, played: 0, open: true, exact: undefined, answered: undefined, pending: undefined })
    while (this.replies.size > 16) {
      const oldest = this.replies.keys().next().value!
      if (this.replies.get(oldest)?.pending !== undefined) break
      this.replies.delete(oldest)
    }
    this.post({ type: "start", id, token, rate: sampleRate })
  }

  frame(buffer: ArrayBuffer) {
    if (buffer.byteLength < 8) return
    const id = new DataView(buffer).getUint32(4, true)
    // The rest of a reply whose player died is not played (rule (c)).
    if (this.inherited.has(id)) return
    this.post({ type: "frame", buffer, token: this.replies.get(id)?.token ?? 0 }, [buffer])
  }

  end(id: number) {
    if (this.answerInherited(id, true)) return
    this.post({ type: "end", id, token: this.replies.get(id)?.token ?? 0 })
  }

  /**
   * A stop or end of a reply of the player this link replaced: answered from the page's record (rule (b)),
   * never passed to this link's player. False when `id` is not such a reply.
   */
  private answerInherited(id: number, report: boolean): boolean {
    const record = this.inherited.get(id)
    if (record === undefined) return false
    if (report && !this.detached) this.emit({ type: "stopped", id, playedSamples: record.count, report: true, exact: record.exact })
    return true
  }

  /**
   * Stop reply `turnId` (undefined: whatever plays). `report: false` when the socket is gone. `now`: the
   * context is not rendering, so the worklet must not fade (the fade would wait for rendering).
   */
  stop(turnId: number | undefined, report: boolean, now: boolean, answerWithinMs = STOP_ANSWER_MS) {
    if (turnId !== undefined && this.answerInherited(turnId, report)) return
    const id = turnId ?? this.current
    const reply = id === undefined ? undefined : this.replies.get(id)
    // A stop for whatever plays carries no id or token: the worklet answers with its own (dropped unless current).
    const message = turnId === undefined ? { type: "stop", report } : { type: "stop", id: turnId, token: reply?.token ?? 0, report }
    this.post(now ? { ...message, now: true } : message)
    if (!report || id === undefined || reply === undefined) return
    if (reply.answered !== undefined || reply.exact !== undefined || reply.pending !== undefined) return
    if (turnId === undefined && !reply.open) return // nothing playing: the worklet reports nothing either
    this.arm(reply, report, answerWithinMs)
  }

  /** Wait for `reply`'s answer; after `ms`, answer with its published count (and keep waiting for a correction). */
  private arm(reply: Reply, report: boolean, ms: number) {
    const mine: { timer: unknown; readonly report: boolean; readonly waiters: Array<() => void> } = { timer: undefined, report, waiters: [] }
    // continuation(reply): acts only while this very wait is still the reply's pending one (an answer,
    // `unload`, `detach` or a newer instance of the id clears it and its timer); counts from this record only.
    mine.timer = this.timers.setTimeout(() => {
      if (reply.pending !== mine || this.detached) return
      reply.pending = undefined
      if (reply.answered === undefined && reply.exact === undefined) {
        const count = this.publishedCount(reply)
        reply.answered = { count, exact: false, report: mine.report }
        reply.open = false
        this.emit({ type: "stopped", id: reply.id, playedSamples: count, report: mine.report, exact: false })
      }
      for (const w of mine.waiters) w()
    }, ms)
    reply.pending = mine
  }

  /**
   * The context stopped rendering after time `at`. A stop the page asked for while it was rendering may
   * be mid-fade, or not received yet: finish it at once, so the fade does not play when rendering
   * resumes (after the page may already have answered with its count).
   */
  suspended(at: number) {
    this.post({ type: "suspended", at })
    for (const [id, reply] of this.replies) {
      // Only the reply the worklet plays: one a newer reply replaced was cut hard already (and a stray stop
      // for it would be answered with 0).
      if (reply.pending !== undefined && id === this.current) this.post({ type: "stop", id, token: reply.token, report: reply.pending.report, now: true })
    }
  }

  prebuffer(ms: number) {
    this.post({ type: "prebuffer", ms })
  }

  private onMessage(e: WorkletMessage) {
    if (this.detached || e === null || typeof e !== "object" || typeof e.type !== "string") return
    if (e.type === "ready") {
      if (this.shared === "unconfirmed" && e.shared !== true) this.sharedFailed(ROUTE_REASONS.notReceived)
      return
    }
    // Every other message is about a reply: taken only for the instance this link knows by that id (rule (b),
    // and the instance tokens in the header). A fresh player answers a stop for an id it never played with 0,
    // and an older instance's messages may still be queued: both are dropped here.
    const reply = this.replies.get(e.id)
    if (reply === undefined || e.token !== reply.token) return
    const event = withoutToken(e)
    switch (event.type) {
      case "stats":
        return this.emit(event)
      case "count":
        this.checkShared(reply, event.playedSamples)
        reply.played = Math.max(reply.played, event.playedSamples)
        return
      case "progress":
        this.checkProgress(reply, event.playedSamples)
        reply.played = Math.max(reply.played, event.playedSamples)
        return this.emit(event)
      case "finished":
      case "stopped": {
        reply.played = Math.max(reply.played, event.playedSamples)
        reply.open = false
        reply.exact = event.playedSamples
        const pending = reply.pending
        if (pending !== undefined) {
          this.timers.clearTimeout(pending.timer)
          reply.pending = undefined
        }
        const answered = reply.answered
        if (answered !== undefined && !answered.exact) {
          // The page already answered with its best count, marked provisional. The exact count is always
          // sent too, even when it is the same: the server holds a provisional count until an exact one
          // arrives or its stop deadline passes, so staying silent would end the turn up to ~250 ms late.
          const report = event.type === "stopped" ? event.report || answered.report : true
          reply.answered = { count: event.playedSamples, exact: true, report }
          this.emit({ type: "stopped", id: event.id, playedSamples: event.playedSamples, report, exact: true })
        } else {
          if (answered === undefined) reply.answered = { count: event.playedSamples, exact: true, report: event.type === "finished" || event.report }
          this.emit(event.type === "stopped" ? { ...event, exact: true } : event)
        }
        for (const w of pending?.waiters ?? []) w()
        return
      }
      default:
        return this.emit(event)
    }
  }

  /** After confirmation the counter is written before every progress message: one behind it for the same instance has stopped advancing. */
  private checkProgress(reply: Reply, played: number) {
    const read = this.shared === "confirmed" ? this.counter!.read(reply.id, reply.token) : undefined
    if (read !== undefined && read < played) this.sharedFailed(ROUTE_REASONS.stuck)
  }

  /**
   * Before the context closes (End, a takeover, a fatal error): stop the reply that is still open (or
   * whose stop is pending) and wait until each has an answer, at most `ms` (then the best count). The
   * worklet keeps rendering meanwhile, so a fade that was started finishes and reports exactly.
   */
  finalise(now: boolean, ms = STOP_ANSWER_MS): Promise<void> {
    const waits: Array<Promise<void>> = []
    for (const [id, reply] of this.replies) {
      if (reply.answered !== undefined || reply.exact !== undefined) continue
      if (reply.pending === undefined) {
        if (!reply.open) continue
        this.stop(id, true, now, ms)
      }
      const pending = reply.pending
      // continuation(reply): resolved by the reply's answer, its deadline, `unload` or `detach`; resolving does nothing else.
      if (pending !== undefined) waits.push(new Promise<void>((resolve) => pending.waiters.push(resolve)))
    }
    return Promise.all(waits).then(() => undefined) // continuation(none): only settles
  }

  /**
   * The page is being unloaded: nothing can be waited for. Each open or pending reply is stopped and
   * answered at once with its published count (the worklet's exact answer, should the page live on, follows
   * as a correction). On the message route that is the last count received: count messages still queued
   * behind this handler cannot be received first (see the header). With the shared counter it is the
   * worklet's own live count.
   */
  unload(now: boolean) {
    this.answerAllNow(now)
  }

  /** Stop and answer every open or pending reply at once, with its published count. */
  private answerAllNow(now: boolean) {
    for (const [id, reply] of this.replies) {
      if (reply.answered !== undefined || reply.exact !== undefined) continue
      if (reply.pending === undefined && !reply.open) continue
      if (reply.pending === undefined) this.post({ type: "stop", id, token: reply.token, report: true, ...(now ? { now: true } : {}) })
      const report = reply.pending?.report ?? true
      if (reply.pending !== undefined) this.timers.clearTimeout(reply.pending.timer)
      const waiters = reply.pending?.waiters ?? []
      reply.pending = undefined
      const count = this.publishedCount(reply)
      reply.answered = { count, exact: false, report }
      reply.open = false
      this.emit({ type: "stopped", id, playedSamples: count, report, exact: false })
      for (const w of waiters) w()
    }
  }

  /**
   * This link's player died (`processorerror`) and is being replaced, or the page gives up on playback (rule
   * (a)): every reply still open is answered at once with what the player published, provisional. The link is
   * detached, and the page's record of each reply it knew is returned for the replacement link (`inherited`): a
   * reply the old player answered exactly keeps that exact count; any other keeps its published count, provisional.
   */
  retire(now: boolean): Map<number, InheritedReply> {
    this.answerAllNow(now)
    const records = new Map(this.inherited)
    for (const [id, reply] of this.replies) {
      const exact = reply.exact !== undefined
      records.set(id, { count: this.publishedCount(reply), exact })
    }
    this.detach()
    return records
  }

  /** The context is closing: no more messages either way. */
  detach() {
    this.detached = true
    this.port.onmessage = null
    if (this.readyTimer !== undefined) this.timers.clearTimeout(this.readyTimer)
    this.readyTimer = undefined
    for (const reply of this.replies.values()) {
      if (reply.pending !== undefined) this.timers.clearTimeout(reply.pending.timer)
      const waiters = reply.pending?.waiters ?? []
      reply.pending = undefined
      for (const w of waiters) w()
    }
  }
}
