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
import { type DeclaredCapabilities, type DevicePlace, effectiveCapabilities, roomOf } from "@pva/protocol"
import { Effect } from "effect"
import { deviceSettingsFrom } from "./devices.ts"
import type { SettingsFile } from "./SettingsStore.ts"

/**
 * What serve mode knows about each device beyond its routing (docs/MODULES-PLAN.md §4 P5): its effective `place`
 * section, what it can do (its last declaration minus the `capabilities` section's overrides), whether it is connected
 * and visible. From these: the `Devices` and `Privacy` services for modules, the `TargetDevice` of a voice page for the
 * household feed, the room and person of a turn (`CurrentTurn`), and the per-turn context line.
 *
 * Everything on a turn's path is a cache read: the list is rebuilt only when the settings file, the people or the live
 * state change (`changed()`), never per turn.
 */

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
  /** Last seen of a known device, with memory folded in. */
  readonly lastSeenOf?: (id: string) => number | undefined
  /** Live state per device (the hub's connections); absent: nothing is connected. */
  readonly live: (id: string) => DeviceLiveFacts
  /** Whether a person id is one of the household's (Members). */
  readonly isPerson: (id: string) => boolean
  readonly nameOfPerson: (id: string) => string | undefined
  /** Identity of the people value (`Sections.value(HOUSEHOLD_MEMBERS)`): a new one rebuilds the cache. */
  readonly peopleVersion: () => unknown
}

export interface DeviceFacts {
  /** A device's effective place; its default person only while that person exists. Unknown device: its type's defaults. */
  readonly placeOf: (deviceId: string | undefined) => DevicePlace
  /** What a projection of the household feed sees of a voice page's device. */
  readonly targetOf: (device: { readonly id: string; readonly name: string } | undefined) => TargetDevice
  /** The room and person a turn on this device has (`TurnOrigin`): `how: "device-default"`. */
  readonly originOf: (deviceId: string | undefined) => { readonly room?: string; readonly person?: TurnPerson }
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
    readonly people: unknown
    readonly version: number
    readonly list: ReadonlyArray<KnownDevice>
    readonly byId: ReadonlyMap<string, KnownDevice>
    readonly lines: Map<string, string>
  }
  let cache: Cache | undefined

  const placeIn = (file: SettingsFile, deviceId: string | undefined): DevicePlace => {
    const place = deviceSettingsFrom(file, deviceId).place
    return place.defaultPerson !== null && !options.isPerson(place.defaultPerson) ? { ...place, defaultPerson: null } : place
  }

  const current = (): Cache => {
    const file = options.file()
    const people = options.peopleVersion()
    if (cache !== undefined && cache.file === file && cache.people === people && cache.version === version) return cache
    const list = Object.entries(file.devices)
      .map(([id, record]): KnownDevice => {
        const settings = deviceSettingsFrom(file, id)
        const place = placeIn(file, id)
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
    cache = { file, people, version, list, byId: new Map(list.map((d) => [d.id, d])), lines: new Map() }
    return cache
  }

  const placeOf = (deviceId: string | undefined): DevicePlace => {
    const known = deviceId === undefined ? undefined : current().byId.get(deviceId)
    return known?.place ?? placeIn(options.file(), deviceId)
  }

  const contextLine = (deviceId: string | undefined): string => {
    const c = current()
    const key = deviceId ?? ""
    const cached = c.lines.get(key)
    if (cached !== undefined) return cached
    const line = deviceContextLine(c.list, deviceId, options.nameOfPerson)
    c.lines.set(key, line)
    return line
  }

  return {
    placeOf,
    targetOf: (device) => {
      if (device === undefined) return {}
      const place = placeOf(device.id)
      const room = roomOf(place)
      return {
        id: device.id,
        name: current().byId.get(device.id)?.name ?? device.name,
        ...(room !== undefined ? { room } : {}),
        privacy: place.privacy,
        ...(place.defaultPerson !== null ? { defaultPerson: place.defaultPerson } : {})
      }
    },
    originOf: (deviceId) => {
      const place = placeOf(deviceId)
      const room = roomOf(place)
      return {
        ...(room !== undefined ? { room } : {}),
        ...(place.defaultPerson !== null ? { person: { id: place.defaultPerson, how: "device-default" } } : {})
      }
    },
    changed: () => {
      version++
    },
    devices: makeDevices(() => current().list),
    privacy: makePrivacy(placeOf),
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
