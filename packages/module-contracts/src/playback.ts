import { ServiceKey } from "@pva/core"
import { Data, type Effect } from "effect"

/**
 * `Playback`: pausing what plays in a room, and changing its volume (docs/MODULES-PLAN.md §5.2; §4 P7;
 * docs/research/modules/music.md §12). Provided by `music` (`packages/module-music`, wave B), used by the host's
 * essential controls (P7: "stop" pauses media playing in the room, "louder" and "quieter" change its volume).
 *
 * **Two operations only**, the ones that first consumer needs. Reading what plays, resuming, and choosing what to play
 * are music's own tools; they join this contract when a consumer needs them.
 *
 * **Where the key lives.** The plan has P7 define this key in `@pva/core`, because the host's "stop" uses it. P7 is
 * written after this scaffold, so the key is defined here now with the id `playback`; when P7 adds its key to the core
 * it uses the same id and interface, and this package re-exports it. Keys are compared by id, so music provides the
 * same service either way.
 *
 * **Rooms.** A room is a device's `place.room` as the caller has it (one line, at most 60 characters, the server's
 * `MAX_ROOM_CHARS`; longer or empty is `invalid`), compared as Members compares names (`nameKey` in `@pva/core`:
 * case, accents and punctuation ignored). The provider maps rooms to its players (music: a room → player table in its
 * settings, or Home Assistant areas of the same name).
 *
 * **Operations.** `pause(room)` pauses the room's player if it is playing and answers whether it did (`false`:
 * nothing was playing, or the provider does not know the player's state yet, in which case it does nothing).
 * `changeVolume(room, change)` takes a level from 0 to 1 (`to`) or a step from −1 to 1 (`by`, "louder" is +0.1);
 * another number is `invalid`. It answers the new level from 0 to 1. A room no player serves is `no_player`. Each is
 * one call to the player within `PLAYBACK_LIMITS.callTimeoutMs` (`timeout` after that: it may still have happened).
 *
 * **Errors.** `PlaybackError.reason` is for the consumer to word in its own two languages; `detail` for the log only.
 *
 * **When music is off or stops**: `host.service(Playback)` is `undefined` (the host's "stop" then stops only what it
 * owns); a call while it stops may die with `ModuleStopped`: `useService(host, Playback, …)` makes both
 * `ProviderOff`.
 *
 * **Privacy.** What plays is household data.
 */
export const PLAYBACK_LIMITS = { roomChars: 60, callTimeoutMs: 3_000 } as const

/** A refusal or failure (see "Errors" above). */
export class PlaybackError extends Data.TaggedError("PlaybackError")<{
  /** `no_player`: nothing serves that room. `invalid`: a room, level or step out of range. `timeout`, `failed`: the player. */
  readonly reason: "no_player" | "invalid" | "timeout" | "failed"
  readonly detail: string
}> {}

export interface PlaybackService {
  readonly pause: (room: string) => Effect.Effect<boolean, PlaybackError>
  readonly changeVolume: (room: string, change: { readonly to: number } | { readonly by: number }) => Effect.Effect<number, PlaybackError>
}

export const Playback = ServiceKey<PlaybackService>("playback")
