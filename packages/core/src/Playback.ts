import { Data, type Effect } from "effect"
import { ServiceKey } from "./ModuleApi.ts"

/**
 * `Playback`: pausing what plays on a device, and changing its volume (docs/MODULES-PLAN.md §5.2; §4 P7;
 * docs/modules/media.md §4.3). Provided by the media module (which plays in the page of the device that asked, through
 * `DevicePlayers`), used by the host's essential controls (P7: "stop" pauses what plays on the device; "louder" and
 * "quieter" still change the reply volume only).
 *
 * **Two operations only**, the ones that first consumer needs. Reading what plays, resuming, and choosing what to play
 * are the provider's own tools; they join this contract when a consumer needs them.
 *
 * **Where the key lives.** In `@pva/core` since P7 (the host's "stop" uses it); `@pva/module-contracts` re-exports it
 * unchanged. Keys are compared by id.
 *
 * **Devices.** Both operations name the device by its id (`CurrentTurn.deviceId`, `PhrasePorts.deviceId`: one to
 * `PLAYBACK_LIMITS.deviceIdChars` characters of letters, digits, `_` and `-`; anything else is `invalid`). What a device
 * plays is what its own page's player plays; a device without such a page (a voice node, the admin page, a page that is
 * closed) has none, and the provider answers `no_player`.
 *
 * **`pause(deviceId)`** answers `true` when something was playing on that device and the page has now confirmed it
 * paused. `false`: nothing was playing there (or it was already paused). A page that does not confirm within
 * `PLAYBACK_LIMITS.callTimeoutMs` is `timeout` (it may still have paused).
 *
 * **`changeVolume(deviceId, change)`** takes a level from 0 to 1 (`to`) or a step from −1 to 1 (`by`, "louder" is +0.1);
 * another number (or not a finite number) is `invalid`. It answers the level the player was set to, from 0 to 1:
 *
 * - `to` sets that level.
 * - `by` is relative to the player's present level, which the page reports, and the result is **clamped to 0 to 1**:
 *   "louder" at 0.95 sets 1 and answers 1; it is never `invalid` for leaving the range. A `by` may now succeed.
 * - When the page has not reported a level yet (nothing open, or a player that does not say), a `by` is refused with
 *   `unknown_level` and nothing is changed: it never guesses a starting level. A `to` needs no present level.
 *
 * A device no player serves is `no_player`. Each is one call to the player within `PLAYBACK_LIMITS.callTimeoutMs`
 * (`timeout` after that: it may still have happened).
 *
 * **Errors.** `PlaybackError.reason` is for the consumer to word in its own two languages; `detail` for the log only.
 *
 * **When the provider is off or stops**: `host.service(Playback)` is `undefined` (the host's "stop" then stops only what
 * it owns); a call while it stops may die with `ModuleStopped`: `useService(host, Playback, …)` makes both
 * `ProviderOff`.
 *
 * **Privacy.** What plays is household data.
 */
export const PLAYBACK_LIMITS = { deviceIdChars: 64, callTimeoutMs: 3_000 } as const

/** A refusal or failure (see "Errors" above). */
export class PlaybackError extends Data.TaggedError("PlaybackError")<{
  /**
   * `no_player`: nothing plays on that device (no page with a player). `invalid`: a device id, level or step out of
   * range. `unknown_level`: a relative change while the player's present level is not known (nothing changed).
   * `timeout`, `failed`: the player.
   */
  readonly reason: "no_player" | "invalid" | "unknown_level" | "timeout" | "failed"
  readonly detail: string
}> {}

export interface PlaybackService {
  readonly pause: (deviceId: string) => Effect.Effect<boolean, PlaybackError>
  readonly changeVolume: (deviceId: string, change: { readonly to: number } | { readonly by: number }) => Effect.Effect<number, PlaybackError>
}

export const Playback = ServiceKey<PlaybackService>("playback")
