import { ServiceKey } from "@pva/core"
import { Data, type Effect } from "effect"

/**
 * `Playback`: what plays in a room, and pausing, resuming and its volume (docs/MODULES-PLAN.md §5.2; §4 P7;
 * docs/research/modules/music.md §12). Provided by `music` (`packages/module-music`), used by the host's essential
 * controls (P7: "stop" pauses media playing in the room, "louder" and "quieter" change its volume) and by
 * assistant-controls.
 *
 * **Where the key lives.** The plan has P7 define this key in `@pva/core`, because the host's "stop" uses it. P7 is
 * written after this scaffold, so the key is defined here now with the id `playback`; when P7 adds its key to the core
 * it uses the same id and interface, and this module re-exports it. Keys are compared by id, so music provides the
 * same service either way.
 *
 * **Rooms.** A room is a device's `place.room` (free text), compared as Members compares names (`nameKey` in
 * `@pva/core`: case, accents and punctuation ignored). The provider maps rooms to its players (music: a room → player
 * table in its settings, or Home Assistant areas of the same name).
 *
 * **State.** `inRoom(room)` answers at once from the provider's cache: `undefined` when no player serves the room,
 * otherwise the player's state. `unknown` means the provider has not heard from the player (music after a reconnect,
 * until Home Assistant's first state). The host's "stop" pauses only what is `playing`; it never acts on `unknown`.
 *
 * **Operations.** `pause` and `resume` answer whether something changed (`false`: nothing was playing, or paused).
 * `changeVolume` takes a level from 0 to 1 (`to`) or a step from −1 to 1 (`by`, "louder" is +0.1) and answers the new
 * level. Each is one call to the player within `PLAYBACK_LIMITS.callTimeoutMs`.
 *
 * **When music is off or stops**: `host.service(Playback)` is `undefined` (the host's "stop" then stops only what it
 * owns); a call while it stops may die with `ModuleStopped`: `useService(host, Playback, "music", …)` makes both
 * `ProviderOff`.
 *
 * **Privacy.** What plays is household data.
 */
export const PLAYBACK_LIMITS = { titleChars: 200, callTimeoutMs: 3_000 } as const

export interface PlaybackState {
  /** The room as asked. */
  readonly room: string
  readonly state: "playing" | "paused" | "idle" | "unknown"
  /** The player's name ("Kitchen speakers"). */
  readonly player: string
  readonly title?: string
  readonly artist?: string
  /** 0 to 1, when the player says. */
  readonly volume?: number
}

/** A refusal or failure; `message` is one sentence that can be spoken. */
export class PlaybackError extends Data.TaggedError("PlaybackError")<{
  /** `no_player`: nothing serves that room. `invalid`: a level or step out of range. `timeout`, `failed`: the player. */
  readonly reason: "no_player" | "invalid" | "timeout" | "failed"
  readonly message: string
}> {}

export interface PlaybackService {
  readonly inRoom: (room: string) => PlaybackState | undefined
  readonly pause: (room: string) => Effect.Effect<boolean, PlaybackError>
  readonly resume: (room: string) => Effect.Effect<boolean, PlaybackError>
  readonly changeVolume: (room: string, change: { readonly to: number } | { readonly by: number }) => Effect.Effect<number, PlaybackError>
}

export const Playback = ServiceKey<PlaybackService>("playback")
