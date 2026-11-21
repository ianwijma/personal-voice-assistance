import type { MediaConfig } from "@pva/protocol"
import type { OpenCommand, PagePlayer, PlayerCurrent, PlayerEvents } from "@/lib/media/types.ts"

/** A scriptable player: records what it is told and lets a test say what it reports. */
export class FakePlayer implements PagePlayer {
  readonly calls: Array<string> = []
  readonly volumes: Array<number> = []
  events!: PlayerEvents
  opened: OpenCommand | undefined
  readonly source: string
  readonly options: { volume?: number; volumeSteps?: number; pausesWhenHidden?: boolean }
  constructor(source: string, options: { volume?: number; volumeSteps?: number; pausesWhenHidden?: boolean } = {}) {
    this.source = source
    this.options = options
  }
  get volume() {
    return this.options.volume ?? 0.8
  }
  get volumeSteps() {
    return this.options.volumeSteps ?? 1
  }
  get pausesWhenHidden() {
    return this.options.pausesWhenHidden ?? false
  }
  attach(events: PlayerEvents) {
    this.events = events
  }
  prepare(config?: MediaConfig) {
    this.calls.push(`prepare${config?.name !== undefined ? `:${String(config.name)}` : ""}`)
  }
  open(c: OpenCommand) {
    this.opened = c
    this.calls.push(`open:${c.autoplay ? "play" : "hold"}`)
  }
  play() {
    this.calls.push("play")
  }
  pause() {
    this.calls.push("pause")
  }
  next() {
    this.calls.push("next")
  }
  previous() {
    this.calls.push("previous")
  }
  seek(ms: number) {
    this.calls.push(`seek:${ms}`)
  }
  setVolume(v: number) {
    this.volumes.push(Math.round(v * 1000) / 1000)
    this.calls.push(`volume:${Math.round(v * 1000) / 1000}`)
  }
  close() {
    this.calls.push("close")
  }
  credential(token: string, expiresAtMs: number) {
    this.calls.push(`credential:${token}:${expiresAtMs}`)
  }
  /** Test: what the player reports. */
  say(c: Partial<PlayerCurrent> & { status: PlayerCurrent["status"] }) {
    this.events.current(c)
  }
}
