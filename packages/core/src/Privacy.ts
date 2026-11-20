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
 * `household` content is always yes. The question is about the device that would speak or show it, which is not
 * always the device that asked.
 *
 * **It fails closed.** Every argument is checked at run time (JSON, JavaScript callers and badly decoded module data
 * do not obey the types): anything that is not a well-formed household item, or a well-formed personal item whose
 * owner is one of the household's Members, for a device the server knows, is refused. A missing, null, empty or
 * malformed owner; an owner who is not (or no longer) in Members; an unknown sensitivity; a missing device, an
 * unknown device id, a malformed reference or "no turn" where a device is needed: all no. A known device that is
 * offline is judged by its saved place. A device type's defaults never stand in for a device the server has not
 * seen. `mayRevealTo` is the one implementation of the rule; the household feed (`mayRevealScopeTo`), the ambient
 * facts, the per-turn context line and the `Privacy` service all call it.
 */

/** What the rule reads of a device: its `place` section's privacy and default person. */
export interface PrivacyPlace {
  readonly privacy: DevicePrivacy
  readonly defaultPerson: string | null
}

/** A person id as Members makes them (`PersonId` in the protocol). */
const PERSON_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
/** A device id (`DeviceId` in the protocol). */
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/

/** A well-formed person id (a string of the `PersonId` form). */
export const isPersonId = (u: unknown): u is string => typeof u === "string" && PERSON_ID.test(u)
/** A well-formed device id (a string of the `DeviceId` form). */
export const isDeviceId = (u: unknown): u is string => typeof u === "string" && DEVICE_ID.test(u)

const isObject = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** A well-formed place: one of the three privacy levels, and nobody or a well-formed person id. */
export const isPrivacyPlace = (u: unknown): u is PrivacyPlace => {
  if (!isObject(u)) return false
  const privacy = u.privacy
  if (privacy !== "private" && privacy !== "shared" && privacy !== "public") return false
  return u.defaultPerson === null || isPersonId(u.defaultPerson)
}

/** Whether a person id is one of the household's Members now. */
export type IsMember = (personId: string) => boolean

/**
 * THE rule (docs/MODULES-PLAN.md §2 row 8), on a device's place: may personal content of `owner` be spoken or shown
 * there? `owner` must be a well-formed person id that `isMember` knows, `place` a well-formed place; anything else is
 * no.
 */
export const mayRevealTo = (owner: unknown, place: unknown, isMember: IsMember): boolean => {
  if (!isPersonId(owner) || !isPrivacyPlace(place)) return false
  let member = false
  try {
    member = isMember(owner) === true
  } catch {
    member = false
  }
  if (!member) return false
  switch (place.privacy) {
    case "private":
      return true
    case "shared":
      return place.defaultPerson === owner
    case "public":
      return false
  }
}

/** An item to reveal: household data, or personal data with its owner (a personal item without one is refused). */
export type RevealItem = { readonly sensitivity: "household" } | { readonly sensitivity: "personal"; readonly owner?: string | undefined }

/**
 * Checks an item at run time: `household` (no owner needed), or `personal` with an owner (checked by `mayRevealTo`).
 * Anything else (`undefined`, an unknown sensitivity, a non-object) is `undefined`: refused.
 */
const itemOf = (u: unknown): { readonly household: true } | { readonly household: false; readonly owner: unknown } | undefined => {
  if (!isObject(u)) return undefined
  if (u.sensitivity === "household") return { household: true }
  if (u.sensitivity === "personal") return { household: false, owner: u.owner }
  return undefined
}

/** `mayRevealTo` for an item: a well-formed household item always; a personal one by the rule; anything else no. */
export const mayRevealItemTo = (item: unknown, place: unknown, isMember: IsMember): boolean => {
  const i = itemOf(item)
  if (i === undefined) return false
  return i.household ? true : mayRevealTo(i.owner, place, isMember)
}

/** Which device is meant: its id, or a turn (`CurrentTurn`, its `deviceId`). Anything else names no device. */
export type DeviceRef = string | { readonly deviceId?: string | undefined } | undefined

/** The device id a `DeviceRef` names, when it is well formed; `undefined` otherwise. */
export const deviceIdOf = (device: unknown): string | undefined => {
  if (isDeviceId(device)) return device
  if (isObject(device) && isDeviceId(device.deviceId)) return device.deviceId
  return undefined
}

export interface PrivacyService {
  /** May personal content of `owner` be spoken or shown on `device`? Fails closed (see above). */
  readonly mayReveal: (owner: string | undefined, device: DeviceRef) => boolean
  /** The same for an item that says its sensitivity (a well-formed household item: always yes). */
  readonly mayRevealItem: (item: RevealItem, device: DeviceRef) => boolean
  /** `mayReveal` about the device of the current turn (`CurrentTurn`); no turn, or a turn without a device: no. */
  readonly mayRevealHere: (owner: string | undefined) => Effect.Effect<boolean>
}

/** `host.service(Privacy)`: provided by the core in serve mode. */
export const Privacy = ServiceKey<PrivacyService>("core.privacy")

/**
 * A `PrivacyService` over the saved place of each device the server knows (`placeOf`: `undefined` for a device it
 * has not seen, which is then refused) and the household's Members (`isMember`).
 */
export const makePrivacy = (placeOf: (deviceId: string) => PrivacyPlace | undefined, isMember: IsMember): PrivacyService => {
  const placeFor = (device: unknown): PrivacyPlace | undefined => {
    const id = deviceIdOf(device)
    if (id === undefined) return undefined
    try {
      return placeOf(id)
    } catch {
      return undefined
    }
  }
  const mayReveal = (owner: unknown, device: unknown): boolean => {
    const place = placeFor(device)
    return place !== undefined && mayRevealTo(owner, place, isMember)
  }
  return {
    mayReveal,
    mayRevealItem: (item, device) => {
      const i = itemOf(item)
      if (i === undefined) return false
      return i.household ? true : mayReveal(i.owner, device)
    },
    mayRevealHere: (owner) =>
      Effect.gen(function*() {
        const turn = yield* CurrentTurn
        return turn !== undefined && mayReveal(owner, turn)
      })
  }
}
