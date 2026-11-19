import {
  type ContextProvider,
  CurrentTurn,
  deviceContextLine,
  type DevicesService,
  type KnownDevice,
  makeDevices,
  makePrivacy,
  type PrivacyService,
  type TargetDevice,
  type TurnPerson
} from "@pva/core"
import { boundaryKey, type DeclaredCapabilities, type DeviceOutputs, deviceOutputsFrom, type DevicePresentOutputs, devicePresentFrom, type DevicePlace, effectiveCapabilities, roomOf, speakerAllowedFrom } from "@pva/protocol"
import { Effect } from "effect"
import { deviceSettingsFrom } from "./devices.ts"
import { type EffectiveMembers, effectiveMembersOf } from "./people.ts"
import type { SettingsFile } from "./SettingsStore.ts"

/**
 * What serve mode knows about each device beyond its routing (docs/MODULES-PLAN.md §4 P5): its effective `place`
 * section, what it can do (its last declaration minus the `capabilities` section's overrides), whether it is connected
 * and visible. From these: the `Devices` and `Privacy` services for modules, the `TargetDevice` of a voice page for the
 * household feed, the room and person of a turn (`CurrentTurn`), and the per-turn context line.
 *
 * Everything on a turn's path is a cache read: the list is rebuilt on the first read after the settings file, the
 * people or the live state changed (`changed()`), not on every turn.
 *
 * Only devices the server has a record of count: a device id it has not seen (or whose first registration has not
 * been written yet) has no place, so the privacy rule refuses it, its turns have no room or person, and its pages get
 * no person data. A device type's defaults never stand in for such a device. A known device that is offline keeps its
 * saved place.
 *
 * **The boundary** (`boundaryIn`, `boundaryChanged`): what decides what a device may be told or sent — its privacy,
 * its default person (while a member), and its output overrides (`noSpeaker`, `noDisplay`, excluded kinds; its own
 * over its type's). Serve mode compares it for every connected device and session in the step that commits a
 * settings change (`SettingsStore.onCommitted`); a device whose boundary changed has its session ended with its
 * connections (`SessionHub.endSessions`), as has every device when a person leaves Members. Room, name, always-on,
 * accepts-from-others and quiet-room are not part of it.
 */

/** What decides what a device may be told or sent, in one settings file (see above). */
export interface Boundary {
  /** The file has a record of the device (a page without a device, or one not registered yet: `false`). */
  readonly known: boolean
  readonly key: string
}

export const boundaryIn = (file: SettingsFile, deviceId: string | undefined, kind?: string): Boundary => {
  const known = deviceId !== undefined && file.devices[deviceId] !== undefined
  const settings = deviceSettingsFrom(file, known ? deviceId : undefined, kind)
  // Without a record, only the output overrides (its type's) apply: privacy refuses an unknown device anyway.
  if (!known) return { known: false, key: `unknown|${boundaryKey({ ...settings, place: { ...settings.place, privacy: "public", defaultPerson: null } }, () => false)}` }
  const members = effectiveMembersOf(file.assistant).referenceable
  return { known: true, key: boundaryKey(settings, (id) => members.has(id)) }
}

/**
 * Whether a commit from `before` to `after` crosses the device's boundary. A device's first registration (unknown →
 * known) does not: nothing was sent to it before (its first welcome waits for the record), and an unknown device has
 * only its type's defaults, which its new record starts from. Being forgotten (known → unknown) does.
 */
export const boundaryChanged = (before: SettingsFile, after: SettingsFile, deviceId: string | undefined, kind?: string): boolean => {
  const b = boundaryIn(before, deviceId, kind)
  const a = boundaryIn(after, deviceId, kind)
  if (b.key === a.key) return false
  return !(!b.known && a.known)
}

/**
 * A person who was a member before the commit (`effectiveMembersOf`, an id a reference may name) is not after it: every
 * device's session ends.
 */
export const membersRemoved = (before: SettingsFile, after: SettingsFile): boolean => {
  const b = effectiveMembersOf(before.assistant)
  const a = effectiveMembersOf(after.assistant)
  if (a === b) return false
  for (const id of b.referenceable) if (!a.referenceable.has(id)) return true
  return false
}

export interface DeviceLiveFacts {
  readonly connected: boolean
  readonly visible: boolean
  readonly lastInteractionAt?: number | undefined
}

export interface DeviceFactsOptions {
  /** The settings file now (`SettingsStore.settings`): the same object while nothing is saved. */
  readonly file: () => SettingsFile
  /** The last declaration of a known device (`DeviceRegistry.declaredOf`). */
  readonly declaredOf: (id: string) => DeclaredCapabilities | undefined
  /**
   * The latest declaration received from a device, also one whose first registration is not written yet
   * (`DeviceRegistry.latestOf`). Absent: `declaredOf`.
   */
  readonly latestOf?: (id: string) => DeclaredCapabilities | undefined
  /** Last seen of a known device, with the registry's memory folded in (`DeviceRegistry.lastSeenOf`). */
  readonly lastSeenOf?: (id: string) => number | undefined
  /** Live state per device (the hub's connections); absent: nothing is connected. */
  readonly live: (id: string) => DeviceLiveFacts
}

export interface DeviceFacts {
  /** A known device's effective place (its default person only while that person is in Members); `undefined` otherwise. */
  readonly placeOf: (deviceId: string | undefined) => DevicePlace | undefined
  /** What a projection of the household feed sees of a voice page's device. */
  readonly targetOf: (device: { readonly id: string; readonly name: string } | undefined) => TargetDevice
  /** The room and person a turn on this device has (`TurnOrigin`): `how: "device-default"`. */
  readonly originOf: (deviceId: string | undefined) => { readonly room?: string; readonly person?: TurnPerson }
  /**
   * Whether reply audio may be sent to the device now, from the committed settings and its latest declaration: not
   * when "Don't use its speaker" is set (its own, else its type's; for a device without a record, or a page without a
   * device, its type's defaults), nor when its latest declaration has no speaker that plays speech. A device that never
   * declared anything (a page of an older build) may. Read where audio leaves (every frame), so a cache read.
   */
  readonly speakerAllowed: (deviceId: string | undefined, kind?: string) => boolean
  /**
   * P9: what a device can do with a notification or an announcement now, from one place (`deviceOutputsFrom`): the
   * owner's overrides (its own, else its type's) first, then its latest declaration; a page that never declared speaks
   * and shows unless an override says not.
   */
  readonly outputsOf: (deviceId: string, kind?: string) => DeviceOutputs
  /**
   * P10: what a device can do with a presentation now, from one place (`devicePresentFrom`): its latest declaration
   * minus the owner's overrides (its own, else its type's). A page that never declared anything shows none.
   */
  readonly presentOf: (deviceId: string, kind?: string) => DevicePresentOutputs
  /** Something live changed (a connection, a declaration, visibility): the next read rebuilds the list. */
  readonly changed: () => void
  readonly devices: DevicesService
  readonly privacy: PrivacyService
  /** The per-turn context line ("This device"), from the cache: no I/O. */
  readonly contextLine: (deviceId: string | undefined) => string
  readonly contextProvider: ContextProvider
}

export const makeDeviceFacts = (options: DeviceFactsOptions): DeviceFacts => {
  let version = 0
  type Cache = {
    readonly file: SettingsFile
    /** Members in `file` (`effectiveMembersOf`): the only answer to "is this id a member" here. */
    readonly members: EffectiveMembers
    readonly version: number
    readonly list: ReadonlyArray<KnownDevice>
    readonly byId: ReadonlyMap<string, KnownDevice>
    readonly lines: Map<string, string>
    /** Per known device: `speakerAllowed`. */
    readonly speaks: ReadonlyMap<string, boolean>
  }
  let cache: Cache | undefined

  const placeIn = (file: SettingsFile, members: EffectiveMembers, deviceId: string): DevicePlace => {
    const place = deviceSettingsFrom(file, deviceId).place
    return place.defaultPerson !== null && !members.referenceable.has(place.defaultPerson) ? { ...place, defaultPerson: null } : place
  }

  const current = (): Cache => {
    const file = options.file()
    const members = effectiveMembersOf(file.assistant)
    if (cache !== undefined && cache.file === file && cache.members === members && cache.version === version) return cache
    const list = Object.entries(file.devices)
      .map(([id, record]): KnownDevice => {
        const settings = deviceSettingsFrom(file, id)
        const place = placeIn(file, members, id)
        const declared = options.declaredOf(id) ?? record.declared
        const live = options.live(id)
        return {
          id,
          name: record.name,
          kind: record.kind,
          room: roomOf(place),
          place,
          capabilities: effectiveCapabilities(declared?.capabilities, settings.capabilities),
          declared,
          connected: live.connected,
          visible: live.connected && live.visible,
          lastInteractionAt: live.lastInteractionAt,
          lastSeen: Math.max(record.lastSeen, options.lastSeenOf?.(id) ?? 0)
        }
      })
      .sort((a, b) => b.lastSeen - a.lastSeen)
    const speaks = new Map(Object.keys(file.devices).map((id) => [id, speaksIn(file, id, undefined)]))
    cache = { file, members, version, list, byId: new Map(list.map((d) => [d.id, d])), lines: new Map(), speaks }
    return cache
  }

  /** `speakerAllowed` in one file (see the interface). */
  const speaksIn = (file: SettingsFile, deviceId: string | undefined, kind: string | undefined): boolean => {
    const known = deviceId !== undefined && file.devices[deviceId] !== undefined
    const settings = deviceSettingsFrom(file, known ? deviceId : undefined, kind)
    const declared = deviceId === undefined ? undefined : (options.latestOf ?? options.declaredOf)(deviceId) ?? file.devices[deviceId]?.declared
    return speakerAllowedFrom(settings, declared?.capabilities)
  }

  const known = (deviceId: string | undefined): KnownDevice | undefined => (deviceId === undefined ? undefined : current().byId.get(deviceId))
  const placeOf = (deviceId: string | undefined): DevicePlace | undefined => known(deviceId)?.place

  // A person is a member while the committed settings' effective Members can name them (fails closed otherwise).
  const isMember = (id: string) => current().members.referenceable.has(id)
  const nameOfPerson = (id: string) => current().members.byId.get(id)?.name

  const contextLine = (deviceId: string | undefined): string => {
    const c = current()
    const key = deviceId ?? ""
    const cached = c.lines.get(key)
    if (cached !== undefined) return cached
    const line = deviceContextLine(c.list, deviceId, nameOfPerson, isMember)
    c.lines.set(key, line)
    return line
  }

  return {
    placeOf,
    targetOf: (device) => {
      if (device === undefined) return {}
      const self = known(device.id)
      // Not (yet) a known device: its id and name, no place, so no person data reaches its pages.
      if (self === undefined) return { id: device.id, name: device.name }
      return {
        id: device.id,
        name: self.name,
        ...(self.room !== undefined ? { room: self.room } : {}),
        privacy: self.place.privacy,
        ...(self.place.defaultPerson !== null ? { defaultPerson: self.place.defaultPerson } : {})
      }
    },
    originOf: (deviceId) => {
      const self = known(deviceId)
      if (self === undefined) return {}
      return {
        ...(self.room !== undefined ? { room: self.room } : {}),
        ...(self.place.defaultPerson !== null ? { person: { id: self.place.defaultPerson, how: "device-default" } } : {})
      }
    },
    speakerAllowed: (deviceId, kind) => {
      const c = current()
      const cached = deviceId === undefined ? undefined : c.speaks.get(deviceId)
      return cached ?? speaksIn(c.file, deviceId, kind)
    },
    outputsOf: (deviceId, kind) => {
      const file = current().file
      const known = file.devices[deviceId] !== undefined
      const settings = deviceSettingsFrom(file, known ? deviceId : undefined, kind)
      const declared = (options.latestOf ?? options.declaredOf)(deviceId) ?? file.devices[deviceId]?.declared
      return deviceOutputsFrom(settings, declared?.capabilities)
    },
    presentOf: (deviceId, kind) => {
      const file = current().file
      const known = file.devices[deviceId] !== undefined
      const settings = deviceSettingsFrom(file, known ? deviceId : undefined, kind)
      const declared = (options.latestOf ?? options.declaredOf)(deviceId) ?? file.devices[deviceId]?.declared
      return devicePresentFrom(settings, declared?.capabilities)
    },
    changed: () => {
      version++
    },
    devices: makeDevices(() => current().list),
    privacy: makePrivacy(placeOf, isMember),
    contextLine,
    contextProvider: {
      name: "This device",
      get: Effect.gen(function*() {
        const turn = yield* CurrentTurn
        // A turn without a device (a CLI mode, a test) gets nothing; a voice page without a device gets its line.
        return turn === undefined ? "" : contextLine(turn.deviceId)
      })
    }
  }
}
