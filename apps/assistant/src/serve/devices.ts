import {
  applicableOwn,
  type DeviceHello,
  type DeviceInfo,
  type DeviceListInfo,
  type DeviceSettings,
  type DeviceTypeInfo,
  DEVICE_TYPES,
  deviceTypeOf,
  effectiveDeviceSettings,
  type ErrorInfo,
  hearerOf,
  MAX_DEVICES,
  WEB_VOICE_DEVICE_TYPE,
  WEB_VOICE_KIND
} from "@pva/protocol"
import { Effect } from "effect"
import type { SettingsFile, SettingsStore, StoredDevice } from "./SettingsStore.ts"

/**
 * Device types and devices as version 4 stores them (docs/ASSISTANTS.md §2.3, §2.6), computed for the server and the
 * pushes. Pure functions of the settings file, and the device registry (`makeDeviceRegistry`: which devices were seen,
 * their names and last visits, forgetting one). Who gets which message is the hub's business (`SessionHub`).
 */

/** A type's complete defaults: its saved ones over the built-in (a type never saved: the built-in). */
export const typeSettingsFrom = (file: SettingsFile, kind: string): DeviceSettings => {
  const type = deviceTypeOf(kind) ?? WEB_VOICE_DEVICE_TYPE
  return effectiveDeviceSettings(type.builtIn, file.deviceTypes[kind], undefined)
}

/** A device's effective settings: its own sections ← its type's defaults ← the built-in (no device: the browser defaults). */
export const deviceSettingsFrom = (file: SettingsFile, deviceId: string | undefined, kind?: string): DeviceSettings => {
  const record = deviceId === undefined ? undefined : file.devices[deviceId]
  const k = record?.kind ?? kind ?? WEB_VOICE_KIND
  const type = deviceTypeOf(k) ?? WEB_VOICE_DEVICE_TYPE
  return effectiveDeviceSettings(type.builtIn, file.deviceTypes[k], record === undefined ? undefined : applicableOwn(type, record.own))
}

/** `device.types`: every type with its complete defaults and rev. */
export const deviceTypeInfos = (file: SettingsFile): ReadonlyArray<DeviceTypeInfo> =>
  DEVICE_TYPES.map((t) => ({
    kind: t.kind,
    title: t.title,
    one: t.one,
    many: t.many,
    description: t.description,
    keys: [...t.keys],
    settings: typeSettingsFrom(file, t.kind),
    rev: file.deviceTypes[t.kind]?.rev ?? 0
  }))

/** `devices`: the registry's entries (`DeviceRegistry.devices`) with `own`, `settings`, `hearer` and `rev` added. */
export const deviceListInfos = (file: SettingsFile, base: ReadonlyArray<DeviceInfo>): ReadonlyArray<DeviceListInfo> =>
  base.map((d) => {
    const settings = deviceSettingsFrom(file, d.id, d.kind)
    return { ...d, own: file.devices[d.id]?.own ?? {}, settings, hearer: hearerOf(settings), rev: file.devices[d.id]?.rev ?? 0 }
  })

// -- The registry of remembered devices ------------------------------------------------------------------------------

/** A device record is written again on `hello` only when its stored `lastSeen` is older than this. */
export const LAST_SEEN_WRITE_MS = 10 * 60_000

export type DeviceResult = { readonly ok: true } | { readonly ok: false; readonly error: ErrorInfo }

const failure = (code: ErrorInfo["code"], message: string): DeviceResult => ({ ok: false, error: { code, message } })

export interface DeviceRegistry {
  /**
   * Every remembered device, most recently seen first. `live`: connections and whether one owns the audio, per
   * device id (from the hub).
   */
  readonly devices: (live: (id: string) => { readonly connections: number; readonly audioOwner: boolean }) => ReadonlyArray<DeviceInfo>
  /**
   * A device said hello: remember it (first time: with its suggested name; the 64-device cap drops the least
   * recently seen, devices with own settings last, connected devices never) and update `lastSeen`. `connected`: ids
   * of devices with an open connection now.
   */
  readonly seen: (device: DeviceHello, connected: ReadonlySet<string>) => Effect.Effect<void>
  /** A device's connection closed: `lastSeen` = now (memory; written with the next save). */
  readonly left: (id: string) => void
  readonly known: (id: string) => boolean
  /** A remembered device's name. */
  readonly nameOf: (id: string) => string | undefined
  readonly kindOfDevice: (id: string) => string | undefined
  /** `device.forget` (admin). */
  readonly forget: (id: string) => Effect.Effect<DeviceResult>
}

export interface DeviceRegistryOptions {
  readonly store: SettingsStore
  /** Default `Date.now`. */
  readonly now?: () => number
}

export const makeDeviceRegistry = (options: DeviceRegistryOptions): DeviceRegistry => {
  const { store } = options
  const now = options.now ?? Date.now
  /** `lastSeen` newer than the stored one (memory only until the next save). */
  const lastSeen = new Map<string, number>()
  const stored = () => store.settings().devices

  const withLastSeen = (id: string, record: StoredDevice): StoredDevice => {
    const seen = lastSeen.get(id)
    return seen !== undefined && seen > record.lastSeen ? { ...record, lastSeen: seen } : record
  }

  /** The records with memory `lastSeen` folded in (what a save writes). */
  const withAllLastSeen = (devices: Readonly<Record<string, StoredDevice>>): Record<string, StoredDevice> =>
    Object.fromEntries(Object.entries(devices).map(([id, r]) => [id, withLastSeen(id, r)]))

  const hasOwn = (r: StoredDevice) => Object.keys(r.own).length > 0

  /** Make room for one more: drop the least recently seen not connected (without own settings first). */
  const capped = (devices: Record<string, StoredDevice>, connected: ReadonlySet<string>): Record<string, StoredDevice> => {
    const out = { ...devices }
    const ids = Object.keys(out)
    let excess = ids.length - (MAX_DEVICES - 1)
    if (excess <= 0) return out
    const candidates = ids
      .filter((id) => !connected.has(id))
      .sort((a, b) => Number(hasOwn(out[a]!)) - Number(hasOwn(out[b]!)) || out[a]!.lastSeen - out[b]!.lastSeen)
    for (const id of candidates) {
      if (excess <= 0) break
      delete out[id]
      lastSeen.delete(id)
      excess--
    }
    return out
  }

  return {
    devices: (live) => {
      const t = now()
      return Object.entries(stored())
        .map(([id, record0]): DeviceInfo => {
          const record = withLastSeen(id, record0)
          const l = live(id)
          return {
            id,
            kind: record.kind,
            name: record.name,
            firstSeen: record.firstSeen,
            lastSeen: l.connections > 0 ? Math.max(record.lastSeen, t) : record.lastSeen,
            connections: l.connections,
            audioOwner: l.audioOwner
          }
        })
        .sort((a, b) => b.lastSeen - a.lastSeen)
    },
    seen: (device, connected) =>
      Effect.suspend(() => {
        const t = now()
        const before0 = stored()[device.id]
        lastSeen.set(device.id, t)
        if (before0 !== undefined && t - before0.lastSeen < LAST_SEEN_WRITE_MS) return Effect.void
        return store.saveDeviceRecords(before0 === undefined ? `device ${device.id}` : `the last visit of device ${device.id}`, (committed) => {
          const devices = withAllLastSeen(committed)
          const before = devices[device.id]
          const record: StoredDevice = before === undefined
            ? { kind: device.kind, name: device.name.trim(), firstSeen: t, lastSeen: t, own: {}, rev: 0 }
            : { ...before, lastSeen: Math.max(before.lastSeen, t) }
          const room = before === undefined ? capped(devices, connected) : devices
          return { ...room, [device.id]: record }
        }).pipe(Effect.catch((e) => Effect.logDebug(`Device ${device.id} not saved: ${e.message}`)))
      }),
    left: (id) => {
      if (stored()[id] !== undefined) lastSeen.set(id, now())
    },
    known: (id) => stored()[id] !== undefined,
    nameOf: (id) => stored()[id]?.name,
    kindOfDevice: (id) => stored()[id]?.kind,
    forget: (id) =>
      Effect.suspend(() => {
        if (stored()[id] === undefined) return Effect.succeed(failure("unknown_device", "That device is not known (it may have been forgotten already)"))
        return store.saveDeviceRecords(`forgetting device ${id}`, (committed) => {
          const devices = withAllLastSeen(committed)
          delete devices[id]
          return devices
        }).pipe(
          Effect.as<DeviceResult>({ ok: true }),
          Effect.catch((e) => Effect.succeed(failure("internal", e.message))),
          Effect.tap((r) => Effect.sync(() => {
            if (r.ok) lastSeen.delete(id)
          }))
        )
      })
  }
}
