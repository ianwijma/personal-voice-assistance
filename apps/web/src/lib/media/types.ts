import type { MediaConfig, MediaCurrent, MediaTalk } from "@pva/protocol"

/**
 * The page's players (docs/modules/media.md §5). Framework-free: nothing here touches React, so the controller and the
 * players are tested without a browser. A player knows one provider; the controller knows none.
 */

/** What a player reports about itself (`media.state.players[]`, without the source). */
export interface PlayerReport {
  readonly ready: boolean
  /** The provider's id for this page as a playback device (a Spotify Connect device id). */
  readonly playerId?: string
  /** A slug: "unsupported", "initialization_error", "account_error", "no_credential". */
  readonly error?: string
}

/** What is open in a player (`media.state.current` without the source). Positions are as of the moment of the report. */
export type PlayerCurrent = Omit<MediaCurrent, "source">

/** A player's way back to the controller. */
export interface PlayerEvents {
  readonly report: (report: PlayerReport) => void
  /** What is open changed (a position alone too: the controller decides what is worth reporting). */
  readonly current: (current: PlayerCurrent) => void
  /** The player needs a fresh access token (`credential` command). */
  readonly needsCredential: () => void
}

/** `media.command` `open`, as the controller hands it to a player (`autoplay` already decided by the controller). */
export interface OpenCommand {
  readonly source: string
  readonly ref?: string | undefined
  readonly kind?: string | undefined
  readonly title?: string | undefined
  readonly subtitle?: string | undefined
  readonly artUrl?: string | undefined
  readonly link?: string | undefined
  readonly startAtMs?: number | undefined
  readonly autoplay: boolean
}

export interface PagePlayer {
  readonly source: string
  /** The level (0 to 1) the player starts at; later levels are the controller's to track (it reports the user's, never a lowered one). */
  readonly volume: number
  /** How many steps a ramp of the level takes (1: the level is set at once; YouTube has no ramp of its own). */
  readonly volumeSteps: number
  /** A video that must pause while the tab is hidden (YouTube's policy). Music keeps playing. */
  readonly pausesWhenHidden: boolean
  /** Called once by the controller, before anything else. */
  attach(events: PlayerEvents): void
  /** Load the provider's script and get ready. Idempotent. `config` is the server's, bounded. */
  prepare(config?: MediaConfig): void
  open(command: OpenCommand): void
  play(): void
  pause(): void
  next(): void
  previous(): void
  seek(toMs: number): void
  /** Set the level, 0 to 1. */
  setVolume(level: number): void
  /** Stop and hide what is open. The provider's connection stays (Spotify) or goes (YouTube). */
  close(): void
  /** A short-lived token for the provider, `expiresAtMs` in epoch milliseconds (the server's clock). Never logged. */
  credential(token: string, expiresAtMs: number): void
  /** Called inside a user gesture (the Start press, a first touch): unlocks sound where the browser needs it. */
  activate?(): void
}

/** A player that draws into an element of the page (YouTube's frame): the theatre gives it that element. */
export interface SurfacePlayer extends PagePlayer {
  mount(element: HTMLElement): void
  unmount(): void
}

export const isSurfacePlayer = (p: PagePlayer): p is SurfacePlayer => typeof (p as Partial<SurfacePlayer>).mount === "function"

export type { MediaConfig, MediaTalk }

/** What the UI reads: the open thing with the instant its position was taken, and whether the assistant is talking. */
export interface MediaView {
  readonly current: (MediaCurrent & { readonly sampledAt: number }) | undefined
  /** The assistant was woken, listens, thinks or speaks (the theatre's badge grows back). */
  readonly talking: boolean
  /** The level the user chose (never the lowered one), when known. */
  readonly volume: number | undefined
}

export const EMPTY_VIEW: MediaView = { current: undefined, talking: false, volume: undefined }
