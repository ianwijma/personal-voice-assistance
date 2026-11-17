import type { ScopeRef, TargetDevice } from "./HouseholdStore.ts"
import { type IsMember, isDeviceId, mayRevealTo } from "./Privacy.ts"

/**
 * P5's whole part in the household feed (docs/MODULES-PLAN.md §4 P5), kept here so the feed itself (P4's
 * `HouseholdFeed.ts`, `serve/HouseholdPush.ts`) stays P4's. Four things:
 *
 * 1. `TargetDevice` carries the device's room, privacy and default person (`HouseholdStore.ts`; filled by
 *    `serve/deviceFacts.ts` `targetOf` from the server's own record, only for a device it knows).
 * 2. A person-scoped row or event goes to a page only by the privacy rule (`mayRevealPersonScopeTo`, which calls
 *    `mayRevealTo`): a known device, an owner who is in Members now.
 * 3. The person scopes a snapshot reads (`personScopesFor`): the device's default person, then every member; the rule
 *    then decides. They share one collection's `SNAPSHOT_ROWS` (the
 *    `left` budget in `HouseholdFeed.snapshot`), so 24 people do not make 24 × 500 rows.
 * 4. The triggers: a change of the device's privacy or default person, or a person leaving Members, ends the device's
 *    session with its connections (`SessionHub.endSessions`, at the commit): its pages start again from a new
 *    snapshot. A change of its room, or a person added, gives its pages a fresh snapshot (`HouseholdHooks.placeChanged`
 *    and `resync` in `HouseholdPush.ts`, called by `SessionHub.refreshTargets` and serve mode's Members listener).
 */

/** Members now, read at each call (`people`: the household's person ids). Absent or failing: nobody. */
export const membersFrom = (people: (() => ReadonlyArray<string>) | undefined): IsMember => (id) => {
  try {
    return people?.().includes(id) === true
  } catch {
    return false
  }
}

/** May a page on `device` see rows of `personId`? Only a device the server knows (it has a `privacy`), by the rule. */
export const mayRevealPersonScopeTo = (personId: string, device: TargetDevice, isMember: IsMember | undefined): boolean =>
  isMember !== undefined && isDeviceId(device.id) &&
  mayRevealTo(personId, { privacy: device.privacy, defaultPerson: device.defaultPerson ?? null }, isMember)

/** The person scopes a snapshot of `device` reads for a person-scoped collection (the rule filters them after). */
export const personScopesFor = (device: TargetDevice, people: (() => ReadonlyArray<string>) | undefined): ReadonlyArray<ScopeRef> => {
  let ids: ReadonlyArray<string> = []
  try {
    ids = people?.() ?? []
  } catch {
    ids = []
  }
  return [...new Set([...(device.defaultPerson !== undefined ? [device.defaultPerson] : []), ...ids])].map((id): ScopeRef => ({ kind: "person", id }))
}
