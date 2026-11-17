import type { DevicePrivacy } from "@pva/protocol"
import { Effect } from "effect"
import { ServiceKey } from "./ModuleApi.ts"
import { CurrentTurn } from "./TurnContext.ts"

/**
 * Who may see or hear personal content where (docs/MODULES-PLAN.md §2 row 8). Two levels on a result, a presentation,
 * a notification or a spoken line: `household` (the default) and `personal`, which names its owner (a person id).
 *
 * | the device that would speak or show it | `personal` content |
 * |---|---|
 * | `private` | yes |
 * | `shared` | only when the device's default person is the owner |
 * | `public` | no |
 *
 * Personal content with no known owner is treated as someone else's. `household` content is always yes. The question
 * is about the device that would speak or show it, which is not always the device that asked. A device the server
 * does not know, or one that is offline, is judged from its saved place (an unknown one: its type's defaults, by
 * default `shared` with nobody's name on it, so no).
 */

/** What the rule reads of a device: its `place` section's privacy and default person. */
export interface PrivacyPlace {
  readonly privacy: DevicePrivacy
  readonly defaultPerson: string | null
}

/** The rule itself, on a device's place. `owner` absent or empty: an unknown owner (someone else's). */
export const mayRevealTo = (owner: string | undefined, place: PrivacyPlace): boolean => {
  switch (place.privacy) {
    case "private":
      return true
    case "shared":
      return owner !== undefined && owner !== "" && place.defaultPerson === owner
    case "public":
      return false
  }
}

/** An item to reveal: household data, or personal data with its owner (absent: not known). */
export type RevealItem = { readonly sensitivity: "household" } | { readonly sensitivity: "personal"; readonly owner?: string | undefined }

/** `mayRevealTo` for an item: household data always, personal data by the table. */
export const mayRevealItemTo = (item: RevealItem, place: PrivacyPlace): boolean =>
  item.sensitivity === "household" ? true : mayRevealTo(item.owner, place)

/** Which device is meant: its id, or a turn (`CurrentTurn`, its `deviceId`). `undefined`: no device (judged like an unknown one). */
export type DeviceRef = string | { readonly deviceId?: string | undefined } | undefined

export interface PrivacyService {
  /** May personal content of `owner` be spoken or shown on `device`? */
  readonly mayReveal: (owner: string | undefined, device: DeviceRef) => boolean
  /** The same for an item that says its sensitivity (household items: always yes). */
  readonly mayRevealItem: (item: RevealItem, device: DeviceRef) => boolean
  /** `mayReveal` about the device of the current turn (`CurrentTurn`). */
  readonly mayRevealHere: (owner: string | undefined) => Effect.Effect<boolean>
}

/** `host.service(Privacy)`: provided by the core in serve mode. */
export const Privacy = ServiceKey<PrivacyService>("core.privacy")

/** The device id a `DeviceRef` names. */
export const deviceIdOf = (device: DeviceRef): string | undefined => (typeof device === "string" ? device : device?.deviceId)

/** A `PrivacyService` over a way to find a device's place (its saved settings; type defaults for an unknown device). */
export const makePrivacy = (placeOf: (deviceId: string | undefined) => PrivacyPlace): PrivacyService => {
  const mayReveal = (owner: string | undefined, device: DeviceRef) => mayRevealTo(owner, placeOf(deviceIdOf(device)))
  return {
    mayReveal,
    mayRevealItem: (item, device) => (item.sensitivity === "household" ? true : mayReveal(item.owner, device)),
    mayRevealHere: (owner) =>
      Effect.gen(function*() {
        const turn = yield* CurrentTurn
        return mayReveal(owner, turn)
      })
  }
}
