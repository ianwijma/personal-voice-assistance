import {
  MAX_MEDIA_MS,
  MAX_MEDIA_PLAYERS,
  MAX_MEDIA_TEXT_CHARS,
  MAX_MEDIA_URL_CHARS,
  MEDIA_ERROR_CODE,
  MEDIA_REF,
  MEDIA_URL,
  type MediaCommand,
  type MediaCurrent,
  type MediaStateMessage,
  type MediaTalk
} from "@pva/protocol"
import { EMPTY_VIEW, type MediaView, type OpenCommand, type PagePlayer, type PlayerCurrent, type PlayerReport, type SurfacePlayer, isSurfacePlayer } from "./types.ts"

/**
 * The page's media controller (docs/modules/media.md §5, §6; docs/MODULES.md "Playing on a device"). It receives the
 * server's `media.command`s, routes each to the player of its source, keeps the one thing that is open, and reports
 * every change as `media.state`.
 *
 * Rules it keeps:
 * - `ack` is the highest `seq` handled (applied or refused), on every report; it starts again after a reconnect (the
 *   server numbers per connection).
 * - Reports are coalesced (at most one per `REPORT_MIN_MS`, the latest state wins) and repeated every
 *   `HEARTBEAT_MS` while something plays. A change of a position alone is not a change (the heartbeat carries it).
 * - One thing at a time: opening a source closes every other player, so Spotify never sounds under a video.
 * - A source this page has no player for is reported `{ ready: false, error: "unsupported" }`; its command is still acked.
 * - While the assistant is woken, listens, thinks or speaks (`setTalking`), the open thing follows `open.talk`: its
 *   level is lowered to `talk.level` times the user's level (about `RAMP_MS`, a ramp or steps) or it is paused; both
 *   are undone `RESTORE_MS` after it ends. A pause resumes only a player that was playing and that nothing touched
 *   (a pause, close, open or play, from the server or by touch) in between. The lowered level is never reported as the
 *   user's.
 * - A hidden tab pauses a video (`pausesWhenHidden`); music keeps playing.
 * - After a page reload nothing is restored: the state is "nothing open".
 * Everything a player says is untrusted text: it is cleaned and bounded here before it is sent.
 */

export const REPORT_MIN_MS = 250
export const HEARTBEAT_MS = 5_000
export const RAMP_MS = 150
export const RESTORE_MS = 1_000
/** A level a player reports itself is only believed this long after the page last set one (its report may lag). */
const VOLUME_SETTLE_MS = 600
/** A wish for a credential is said again this often (a report can be lost on its way), until the credential comes or the player's own wait ends. */
export const WANT_REPEAT_MS = 2_000
export const WANT_REPEAT_FOR_MS = 10_000
/** A `playing` report this soon after our own pause is the player catching up, not a touch. */
const PAUSE_GRACE_MS = 700

export interface MediaControllerOptions {
  readonly players: ReadonlyArray<PagePlayer>
  /** Send one `media.state`; false: not connected (the state is sent again by `resync`). */
  readonly send: (message: MediaStateMessage) => boolean
  /** Where `visibilitychange` comes from (default `document`). */
  readonly doc?: Pick<Document, "addEventListener" | "removeEventListener"> & { readonly visibilityState?: string }
}

type Current = PlayerCurrent & { readonly sampledAt: number }

const cut = (s: unknown, max: number): string | undefined => (typeof s === "string" && s.trim() !== "" ? s.trim().slice(0, max) : undefined)
const url = (s: unknown): string | undefined => (typeof s === "string" && s.length <= MAX_MEDIA_URL_CHARS && MEDIA_URL.test(s) ? s : undefined)
const ms = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_MEDIA_MS, Math.max(0, Math.round(n))) : undefined)
const level = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined)

/** A player's current thing in the wire's bounds. */
export const cleanCurrent = (source: string, c: PlayerCurrent, volume: number | undefined): MediaCurrent => {
  const out: { -readonly [K in keyof MediaCurrent]: MediaCurrent[K] } = { source, status: c.status }
  const title = cut(c.title, MAX_MEDIA_TEXT_CHARS)
  if (title !== undefined) out.title = title
  const artist = cut(c.artist, MAX_MEDIA_TEXT_CHARS)
  if (artist !== undefined) out.artist = artist
  const album = cut(c.album, MAX_MEDIA_TEXT_CHARS)
  if (album !== undefined) out.album = album
  const artUrl = url(c.artUrl)
  if (artUrl !== undefined) out.artUrl = artUrl
  const link = url(c.link)
  if (link !== undefined) out.link = link
  if (typeof c.ref === "string" && MEDIA_REF.test(c.ref)) out.ref = c.ref
  const dur = ms(c.durationMs)
  if (dur !== undefined) out.durationMs = dur
  const pos = ms(c.positionMs)
  if (pos !== undefined) out.positionMs = pos
  const vol = level(volume)
  if (vol !== undefined) out.volume = vol
  if (typeof c.canNext === "boolean") out.canNext = c.canNext
  if (typeof c.canPrevious === "boolean") out.canPrevious = c.canPrevious
  if (typeof c.errorCode === "string" && MEDIA_ERROR_CODE.test(c.errorCode)) out.errorCode = c.errorCode
  return out
}

export class MediaController {
  private readonly players = new Map<string, PagePlayer>()
  private readonly reports = new Map<string, PlayerReport>()
  private readonly options: MediaControllerOptions
  private readonly listeners = new Set<() => void>()
  private view: MediaView = EMPTY_VIEW

  private active: string | undefined
  private current: Current | undefined
  private lastKey = ""
  private ack: number | undefined
  private readonly wants = new Set<string>()
  /** When each wish was first made, to repeat it every `WANT_REPEAT_MS` until `WANT_REPEAT_FOR_MS` have passed. */
  private readonly wantedAt = new Map<string, number>()
  private wantTimer: ReturnType<typeof setInterval> | undefined

  // Reporting.
  private dirty = false
  private lastSentAt = -Infinity
  private reportTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined

  // Talk.
  private talkConfig: MediaTalk = { mode: "none", level: 0.2 }
  private talking = false
  private lowered = false
  /** Paused by the talk rule, and not touched since: resumes. `reassert`: a server start that arrives meanwhile is paused again. */
  private pausedByTalk: { reassert: boolean; at: number } | undefined
  private restoreTimer: ReturnType<typeof setTimeout> | undefined
  private rampTimer: ReturnType<typeof setInterval> | undefined
  /** The user's own level of the open player; undefined: not known yet. */
  private userVolume: number | undefined
  /** The user's level per source, kept across opens (a player's own `volume` is only where it started). */
  private readonly volumes = new Map<string, number>()
  private applied: number | undefined
  private volumeSetAt = -Infinity

  private readonly onVisibility = () => this.visibilityChanged()
  private stopped = false

  constructor(options: MediaControllerOptions) {
    this.options = options
    for (const p of options.players) {
      this.players.set(p.source, p)
      this.reports.set(p.source, { ready: false })
      p.attach({
        report: (r) => this.playerReport(p.source, r),
        current: (c) => this.playerCurrent(p.source, c),
        needsCredential: () => this.playerWants(p.source)
      })
    }
    options.doc?.addEventListener("visibilitychange", this.onVisibility)
  }

  /** The sources this page has players for (`DeviceCapabilities.media.players`). */
  sources(): ReadonlyArray<string> {
    return [...this.players.keys()]
  }

  /** The element-drawing player of `source` (the theatre mounts YouTube's frame into the page through it). */
  surface(source: string): SurfacePlayer | undefined {
    const p = this.players.get(source)
    return p !== undefined && isSurfacePlayer(p) ? p : undefined
  }

  // -- UI --------------------------------------------------------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  readonly getView = (): MediaView => this.view

  private publish() {
    const c = this.active !== undefined && this.current !== undefined ? { ...cleanCurrent(this.active, this.current, this.userVolume), sampledAt: this.current.sampledAt } : undefined
    const v = this.view
    if (v.talking === this.talking && v.volume === this.userVolume && v.current !== undefined && c !== undefined && sameView(v.current, c)) return
    if (v.talking === this.talking && v.volume === this.userVolume && v.current === undefined && c === undefined) return
    this.view = { current: c, talking: this.talking, volume: this.userVolume }
    for (const l of [...this.listeners]) l()
  }

  // -- Commands --------------------------------------------------------------------------------------------------------

  /** One `media.command` from the server. */
  handleCommand(seq: number, command: MediaCommand): void {
    try {
      this.run(command)
    } catch {
      // A player that throws must not stop the acknowledgement: the server would wait for it.
    }
    this.ack = Math.max(this.ack ?? 0, seq)
    this.markDirty()
  }

  /** What a touch on our own buttons does: the same as the command, without a round trip (the report follows as for any change). */
  touch(command: Exclude<MediaCommand, { type: "prepare" } | { type: "credential" } | { type: "open" }>): void {
    try {
      this.run(command)
    } catch {
      // As above.
    }
    this.markDirty()
  }

  private playerOf(source: string): PagePlayer | undefined {
    return this.players.get(source)
  }
  private activePlayer(): PagePlayer | undefined {
    return this.active === undefined ? undefined : this.players.get(this.active)
  }

  private unsupported(source: string) {
    if (this.reports.size >= MAX_MEDIA_PLAYERS && !this.reports.has(source)) return
    this.reports.set(source, { ready: false, error: "unsupported" })
  }

  private run(c: MediaCommand): void {
    switch (c.type) {
      case "prepare":
        for (const s of c.sources) {
          const p = this.playerOf(s.source)
          if (p === undefined) this.unsupported(s.source)
          else p.prepare(s.config)
        }
        return
      case "credential": {
        const p = this.playerOf(c.source)
        this.wants.delete(c.source)
        this.wantedAt.delete(c.source)
        this.stopWantTimerIfIdle()
        if (p === undefined) this.unsupported(c.source)
        else p.credential(c.token, c.expiresAtMs)
        return
      }
      case "open":
        return this.open(c)
      case "play":
        this.pausedByTalk = undefined
        return this.activePlayer()?.play()
      case "pause":
        this.pausedByTalk = undefined
        return this.activePlayer()?.pause()
      case "next":
        return this.activePlayer()?.next()
      case "previous":
        return this.activePlayer()?.previous()
      case "seek": {
        const p = this.activePlayer()
        if (p === undefined) return
        const to = "toMs" in c ? c.toMs : (this.positionNow() ?? 0) + c.byMs
        const dur = this.current?.durationMs
        p.seek(Math.max(0, dur !== undefined && dur > 0 ? Math.min(to, dur) : to))
        // A seek is a change worth reporting at once even when the player's own report lags.
        this.lastKey = ""
        return
      }
      case "volume": {
        this.setUserVolume(c.level)
        return
      }
      case "close": {
        const p = this.activePlayer()
        this.pausedByTalk = undefined
        this.clearTalkEffects()
        this.active = undefined
        this.current = undefined
        this.userVolume = undefined
        this.applied = undefined
        this.lastKey = ""
        this.stopHeartbeat()
        p?.close()
        this.publish()
        return
      }
    }
  }

  private open(c: Extract<MediaCommand, { type: "open" }>): void {
    const p = this.playerOf(c.source)
    if (p === undefined) {
      this.unsupported(c.source)
      return
    }
    // One thing at a time.
    for (const other of this.players.values()) if (other !== p) other.close()
    const sameSource = this.active === c.source
    this.active = c.source
    this.pausedByTalk = undefined
    this.clearTalkEffects()
    this.talkConfig = c.talk
    if (!sameSource) {
      this.current = undefined
      this.userVolume = this.volumes.get(c.source) ?? p.volume
      this.applied = this.userVolume
    }
    const hidden = this.options.doc?.visibilityState === "hidden" && p.pausesWhenHidden
    const holdForTalk = this.talking && c.talk.mode === "pause" && c.autoplay
    const cmd: OpenCommand = {
      source: c.source,
      ...(c.ref !== undefined ? { ref: c.ref } : {}),
      ...(c.kind !== undefined ? { kind: c.kind } : {}),
      ...(c.title !== undefined ? { title: c.title } : {}),
      ...(c.subtitle !== undefined ? { subtitle: c.subtitle } : {}),
      ...(c.artUrl !== undefined ? { artUrl: c.artUrl } : {}),
      ...(c.link !== undefined ? { link: c.link } : {}),
      ...(c.startAtMs !== undefined ? { startAtMs: c.startAtMs } : {}),
      autoplay: c.autoplay && !hidden && !holdForTalk
    }
    // Opened while the assistant is talking (the usual case: the reply that says "Playing …" is still going): it starts
    // lowered, or held, and the end of the talk undoes it.
    if (this.talking && c.talk.mode === "lower" && this.userVolume !== undefined) {
      this.lowered = true
      this.applied = this.userVolume * c.talk.level
      p.setVolume(this.applied)
      this.volumeSetAt = Date.now()
    }
    if (holdForTalk) this.pausedByTalk = { reassert: true, at: Date.now() }
    // Show it at once, whatever the player says first (a player may answer from inside `open`).
    this.current = { status: "loading", ...(c.title !== undefined ? { title: c.title } : {}), ...(c.subtitle !== undefined ? { artist: c.subtitle } : {}), ...(c.artUrl !== undefined ? { artUrl: c.artUrl } : {}), ...(c.link !== undefined ? { link: c.link } : {}), ...(c.ref !== undefined ? { ref: c.ref } : {}), sampledAt: Date.now() }
    this.lastKey = keyOf(this.current)
    p.open(cmd)
    this.publish()
  }

  // -- Player events ---------------------------------------------------------------------------------------------------

  private playerReport(source: string, r: PlayerReport) {
    this.reports.set(source, r)
    this.markDirty()
  }

  private playerWants(source: string) {
    this.wants.add(source)
    if (!this.wantedAt.has(source)) this.wantedAt.set(source, Date.now())
    this.startWantTimer()
    this.markDirty()
  }

  /** While a player waits for a credential its wish is repeated in a report, so one that was lost does not leave it waiting. */
  private startWantTimer() {
    if (this.wantTimer !== undefined || this.stopped) return
    this.wantTimer = setInterval(() => {
      const now = Date.now()
      let again = false
      for (const [source, at] of this.wantedAt) {
        if (now - at < WANT_REPEAT_FOR_MS) again = true
        else this.wantedAt.delete(source) // the player's own wait has ended; the wish stays in the reports, as before
      }
      if (again) this.markDirty()
      this.stopWantTimerIfIdle()
    }, WANT_REPEAT_MS)
  }
  private stopWantTimerIfIdle() {
    if (this.wantedAt.size > 0 || this.wantTimer === undefined) return
    clearInterval(this.wantTimer)
    this.wantTimer = undefined
  }

  private playerCurrent(source: string, c: PlayerCurrent) {
    if (source !== this.active) return // what a closed player says later is not shown
    const p = this.activePlayer()
    const prev = this.current
    this.current = { ...c, sampledAt: Date.now() }
    // A level the player reports is the user's, unless we lowered it or set one a moment ago.
    if (c.volume !== undefined && !this.lowered && this.rampTimer === undefined && Date.now() - this.volumeSetAt > VOLUME_SETTLE_MS) {
      this.userVolume = c.volume
      this.applied = c.volume
      this.volumes.set(source, c.volume)
    }
    if (c.status === "playing") {
      const hold = this.pausedByTalk
      if (hold !== undefined) {
        if (hold.reassert && this.talking) p?.pause() // the server started it during the talk: held until the talk ends
        else if (Date.now() - hold.at > PAUSE_GRACE_MS) this.pausedByTalk = undefined // the user pressed play inside the player: no longer ours to resume
      }
      this.startHeartbeat()
      if (this.options.doc?.visibilityState === "hidden" && p?.pausesWhenHidden === true) p.pause()
    } else if (prev?.status === "playing") this.stopHeartbeatIfNotPlaying()
    this.publish()
    const key = keyOf(this.current)
    if (key !== this.lastKey) {
      this.lastKey = key
      this.markDirty()
    }
  }

  // -- Talk ------------------------------------------------------------------------------------------------------------

  /** The assistant was woken, listens, thinks or speaks (`true`), or went quiet. */
  setTalking(active: boolean): void {
    if (active === this.talking) return
    this.talking = active
    this.publish()
    if (this.current === undefined) return
    if (active) {
      if (this.restoreTimer !== undefined) clearTimeout(this.restoreTimer)
      this.restoreTimer = undefined
      this.talkBegin()
    } else {
      if (this.restoreTimer !== undefined) clearTimeout(this.restoreTimer)
      this.restoreTimer = setTimeout(() => {
        this.restoreTimer = undefined
        this.talkRestore()
      }, RESTORE_MS)
    }
  }

  private talkBegin() {
    const p = this.activePlayer()
    if (p === undefined || this.current === undefined) return
    const t = this.talkConfig
    if (t.mode === "lower" && !this.lowered) {
      this.lowered = true
      this.rampTo(t.level * (this.userVolume ?? p.volume))
    } else if (t.mode === "pause" && this.pausedByTalk === undefined && this.current.status === "playing") {
      this.pausedByTalk = { reassert: false, at: Date.now() }
      p.pause()
      this.markDirty()
    }
  }

  private talkRestore() {
    const p = this.activePlayer()
    if (p === undefined) return
    if (this.lowered) {
      this.lowered = false
      this.rampTo(this.userVolume ?? p.volume)
    }
    if (this.pausedByTalk !== undefined) {
      this.pausedByTalk = undefined
      p.play()
      this.markDirty()
    }
  }

  private clearTalkEffects() {
    if (this.restoreTimer !== undefined) clearTimeout(this.restoreTimer)
    this.restoreTimer = undefined
    if (this.rampTimer !== undefined) clearInterval(this.rampTimer)
    this.rampTimer = undefined
    this.lowered = false
  }

  private setUserVolume(v: number) {
    const p = this.activePlayer()
    this.userVolume = Math.min(1, Math.max(0, v))
    if (this.active !== undefined) this.volumes.set(this.active, this.userVolume)
    this.volumeSetAt = Date.now()
    if (p === undefined) return
    const target = this.lowered ? this.userVolume * this.talkConfig.level : this.userVolume
    this.rampTo(target, false)
    if (this.current !== undefined) this.publish()
  }

  private rampTo(target: number, animate = true) {
    const p = this.activePlayer()
    if (this.rampTimer !== undefined) clearInterval(this.rampTimer)
    this.rampTimer = undefined
    if (p === undefined) return
    this.volumeSetAt = Date.now()
    const from = this.applied ?? target
    const steps = animate ? Math.max(1, p.volumeSteps) : 1
    if (steps <= 1 || from === target) {
      p.setVolume(target)
      this.applied = target
      return
    }
    let i = 0
    this.rampTimer = setInterval(() => {
      i++
      const v = i >= steps ? target : from + ((target - from) * i) / steps
      p.setVolume(v)
      this.applied = v
      this.volumeSetAt = Date.now()
      if (i >= steps && this.rampTimer !== undefined) {
        clearInterval(this.rampTimer)
        this.rampTimer = undefined
      }
    }, RAMP_MS / steps)
  }

  // -- Hidden tab ------------------------------------------------------------------------------------------------------

  private visibilityChanged() {
    const p = this.activePlayer()
    if (p === undefined || !p.pausesWhenHidden) return
    if (this.options.doc?.visibilityState === "hidden" && this.current?.status === "playing") {
      this.pausedByTalk = undefined
      p.pause()
    }
  }

  // -- Reporting -------------------------------------------------------------------------------------------------------

  /** The position as of now, for a seek relative to it. */
  positionNow(): number | undefined {
    const c = this.current
    if (c === undefined || c.positionMs === undefined) return undefined
    return c.status === "playing" ? c.positionMs + (Date.now() - c.sampledAt) : c.positionMs
  }

  private markDirty() {
    this.dirty = true
    this.schedule()
  }

  private schedule() {
    if (this.stopped || this.reportTimer !== undefined) return
    const wait = Math.max(0, this.lastSentAt + REPORT_MIN_MS - Date.now())
    if (wait === 0) {
      this.flush()
      return
    }
    this.reportTimer = setTimeout(() => {
      this.reportTimer = undefined
      if (this.dirty) this.flush()
    }, wait)
  }

  private build(): MediaStateMessage {
    const players = [...this.reports].slice(0, MAX_MEDIA_PLAYERS).map(([source, r]) => ({
      source,
      ready: r.ready,
      ...(r.playerId !== undefined && MEDIA_REF.test(r.playerId) ? { playerId: r.playerId } : {}),
      ...(r.error !== undefined && MEDIA_ERROR_CODE.test(r.error) ? { error: r.error } : {})
    }))
    const current = this.active !== undefined && this.current !== undefined ? cleanCurrent(this.active, this.current, this.userVolume) : undefined
    // The position is the one of this instant, not of the player's last report.
    const nowPos = ms(this.positionNow())
    const withPosition = current !== undefined && current.status === "playing" && nowPos !== undefined ? { ...current, positionMs: nowPos } : current
    // While the talk rule holds it paused the server must know: its "stop" still has to reach it (it resumes after the talk).
    const reported = withPosition !== undefined && this.pausedByTalk !== undefined ? { ...withPosition, held: true } : withPosition
    return {
      type: "media.state",
      state: { players, ...(reported !== undefined ? { current: reported } : {}) },
      ...(this.ack !== undefined ? { ack: this.ack } : {}),
      ...(this.wants.size > 0 ? { wants: [...this.wants].slice(0, 8).map((source) => ({ source, what: "credential" as const })) } : {})
    }
  }

  private flush() {
    this.dirty = false
    this.lastSentAt = Date.now()
    if (!this.options.send(this.build())) this.dirty = true // not connected: `resync` sends it
  }

  /** After every `welcome`: a new connection, so the server numbers again from the start; send the whole state. */
  resync(): void {
    this.ack = undefined
    if (this.reportTimer !== undefined) clearTimeout(this.reportTimer)
    this.reportTimer = undefined
    this.flush()
  }

  private startHeartbeat() {
    if (this.heartbeat !== undefined) return
    this.heartbeat = setInterval(() => {
      if (this.current?.status !== "playing") return this.stopHeartbeat()
      this.markDirty()
    }, HEARTBEAT_MS)
  }
  private stopHeartbeatIfNotPlaying() {
    if (this.current?.status !== "playing") this.stopHeartbeat()
  }
  private stopHeartbeat() {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  /** The Start press (or any first touch): unlocks sound in players that need a gesture. */
  activate(): void {
    for (const p of this.players.values()) {
      try {
        p.activate?.()
      } catch {
        // A player that cannot activate says so by its own report.
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.stopHeartbeat()
    this.clearTalkEffects()
    if (this.wantTimer !== undefined) clearInterval(this.wantTimer)
    this.wantTimer = undefined
    if (this.reportTimer !== undefined) clearTimeout(this.reportTimer)
    this.options.doc?.removeEventListener("visibilitychange", this.onVisibility)
  }
}

/** What counts as a change worth a report: everything but the position. */
const keyOf = (c: PlayerCurrent & { sampledAt?: number }): string => JSON.stringify({ ...c, positionMs: undefined, sampledAt: undefined })

const sameView = (a: MediaView["current"] & object, b: MediaView["current"] & object): boolean =>
  a.sampledAt === b.sampledAt && JSON.stringify(a) === JSON.stringify(b)
