import {
  applicableOwn,
  capabilitiesDifferMaterially,
  type DeclaredCapabilities,
  type DeviceCapabilities,
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
  MAX_DEVICE_NAME_CHARS,
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
   * A device said hello (or picked an assistant): remember it (first time: with its suggested name, cleaned to one
   * line, and its declaration so far; the 64-device cap drops the least recently seen, devices with own settings
   * last, connected devices never) and update `lastSeen`. `connected`: ids of devices with an open connection now.
   * It never declares capabilities (only `declare` does).
   */
  readonly seen: (device: DeviceHello, connected: ReadonlySet<string>) => Effect.Effect<void>
  /**
   * A device's connection closed: `lastSeen` = now (memory; written with the next save). `last`: it was the device's
   * last connection; a declaration of a device whose record was never written is then dropped.
   */
  readonly left: (id: string, last?: boolean) => void
  /** `lastSeen` of a known device with the visits kept in memory folded in. */
  readonly lastSeenOf: (id: string) => number | undefined
  readonly known: (id: string) => boolean
  /** A remembered device's name. */
  readonly nameOf: (id: string) => string | undefined
  readonly kindOfDevice: (id: string) => string | undefined
  /**
   * P5: what a known device declared last (`hello.device.capabilities`, `device.caps`): the latest declaration
   * received (memory), else its record's; `undefined` when it never declared anything.
   */
  readonly declaredOf: (id: string) => DeclaredCapabilities | undefined
  /**
   * P5: a connected device declared what it can do (`hello` or `device.caps`; nothing else declares). Declarations are
   * ordered by arrival (a per-device counter, never the clock): the latest one is the device's, also while its first
   * registration is still being written (it goes into the new record). Synchronous; `true` when it changed what is
   * known (an identical declaration is ignored). A change of more than the window's exact size
   * (`capabilitiesDifferMaterially`) is then to be written: run `persist`.
   */
  readonly declare: (id: string, capabilities: DeviceCapabilities) => boolean
  /**
   * Write the declarations that changed materially: one write at a time for all devices (later ones coalesce into
   * the next, at most one per `DECLARE_WRITE_GAP_MS`), each record with its latest declaration. Never fails.
   */
  readonly persist: Effect.Effect<void>
  /** `device.forget` (admin). */
  readonly forget: (id: string) => Effect.Effect<DeviceResult>
}

export interface DeviceRegistryOptions {
  readonly store: SettingsStore
  /** Default `Date.now`. */
  readonly now?: () => number
  /** The gap between two writes of declarations. Default `DECLARE_WRITE_GAP_MS`. */
  readonly declareGapMs?: number
}

/** At most one write of declarations per this long (all devices together). */
export const DECLARE_WRITE_GAP_MS = 1000

/** A name a page suggested, as kept: one line, no control or format characters, at most the limit. */
export const cleanDeviceName = (name: string): string => {
  const flat = name.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim()
  const short = [...flat].slice(0, MAX_DEVICE_NAME_CHARS).join("").trim()
  return short === "" ? "Browser" : short
}

export const makeDeviceRegistry = (options: DeviceRegistryOptions): DeviceRegistry => {
  const { store } = options
  const now = options.now ?? Date.now
  /** `lastSeen` newer than the stored one (memory only until the next save). */
  const lastSeen = new Map<string, number>()
  /**
   * The latest declaration received per device, with its place in the order of arrival (`seq`). Memory always holds
   * the newest: a declaration is only ever replaced by a later one, and every write of device records takes it.
   */
  const declared = new Map<string, { readonly value: DeclaredCapabilities; readonly seq: number }>()
  let declareSeq = 0
  /** Devices whose latest declaration differs materially from their record's and is still to be written. */
  const dirty = new Set<string>()
  const stored = () => store.settings().devices
  const gapMs = options.declareGapMs ?? DECLARE_WRITE_GAP_MS

  const withLastSeen = (id: string, record: StoredDevice): StoredDevice => {
    const seen = lastSeen.get(id)
    const caps = declared.get(id)?.value
    const withSeen = seen !== undefined && seen > record.lastSeen ? { ...record, lastSeen: seen } : record
    return caps !== undefined ? { ...withSeen, declared: caps } : withSeen
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
      declared.delete(id)
      dirty.delete(id)
      excess--
    }
    return out
  }

  /** After a write: a device whose declaration changed since the write took it is written again. */
  const afterWrite = (taken: ReadonlyMap<string, number | undefined>) => {
    for (const [id, seq] of taken) {
      const now = declared.get(id)
      if (now === undefined || now.seq === seq) dirty.delete(id)
      else if (capabilitiesDifferMaterially(stored()[id]?.declared?.capabilities, now.value.capabilities)) dirty.add(id)
    }
  }

  let persisting = false
  let again = false
  const persistable = () => [...dirty].some((id) => stored()[id] !== undefined)
  /** One writer for every device's declaration; requests while it writes are folded into its next round. */
  const persist: Effect.Effect<void> = Effect.suspend(() => {
    if (persisting) {
      again = true
      return Effect.void
    }
    if (!persistable()) return Effect.void
    persisting = true
    const round = Effect.suspend(() => {
      again = false
      const ids = [...dirty].filter((id) => stored()[id] !== undefined)
      for (const id of ids) dirty.delete(id)
      if (ids.length === 0) return Effect.void
      /** The declaration each record took, by its place in the order of arrival. */
      const taken = new Map<string, number | undefined>()
      return store.saveDeviceRecords(ids.length === 1 ? `what device ${ids[0]} can do` : "what devices can do", (committed) => {
        for (const id of ids) taken.set(id, declared.get(id)?.seq)
        return withAllLastSeen(committed)
      }).pipe(
        Effect.tap(() => Effect.sync(() => afterWrite(taken))),
        Effect.catch((e) => Effect.logDebug(`Device capabilities not saved (kept in memory until the next write): ${e.message}`))
      )
    })
    const loop: Effect.Effect<void> = Effect.andThen(
      round,
      Effect.suspend(() => (again || persistable() ? Effect.andThen(Effect.sleep(gapMs), loop) : Effect.void))
    )
    return loop.pipe(Effect.ensuring(Effect.sync(() => {
      persisting = false
    })))
  })

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
        const write = before0 === undefined || t - before0.lastSeen >= LAST_SEEN_WRITE_MS
        if (!write) return persist
        const taken = new Map<string, number | undefined>()
        const saved = store.saveDeviceRecords(before0 === undefined ? `device ${device.id}` : `the last visit of device ${device.id}`, (committed) => {
          for (const id of dirty) taken.set(id, declared.get(id)?.seq)
          taken.set(device.id, declared.get(device.id)?.seq)
          const devices = withAllLastSeen(committed)
          const before = devices[device.id]
          // The latest declaration at the moment of writing: one that came while this write waited is in it too.
          const caps = declared.get(device.id)?.value
          const record: StoredDevice = before === undefined
            ? { kind: device.kind, name: cleanDeviceName(device.name), firstSeen: t, lastSeen: t, own: {}, rev: 0, ...(caps !== undefined ? { declared: caps } : {}) }
            : { ...before, lastSeen: Math.max(before.lastSeen, t) }
          const room = before === undefined ? capped(devices, connected) : devices
          return { ...room, [device.id]: record }
        }).pipe(
          // What this write took is on disk; a declaration still newer is written by `persist`.
          Effect.tap(() => Effect.sync(() => afterWrite(taken))),
          Effect.catch((e) => Effect.logDebug(`Device ${device.id} not saved: ${e.message}`))
        )
        return Effect.andThen(saved, persist)
      }),
    left: (id, last) => {
      if (stored()[id] !== undefined) lastSeen.set(id, now())
      else if (last === true) {
        // A device whose first registration was never written: nothing of it is kept.
        declared.delete(id)
        dirty.delete(id)
      }
    },
    lastSeenOf: (id) => {
      const record = stored()[id]
      if (record === undefined) return undefined
      return Math.max(record.lastSeen, lastSeen.get(id) ?? 0)
    },
    known: (id) => stored()[id] !== undefined,
    declaredOf: (id) => {
      const record = stored()[id]
      if (record === undefined) return undefined
      return declared.get(id)?.value ?? record.declared
    },
    declare: (id, capabilities) => {
      const previous = declared.get(id)?.value ?? stored()[id]?.declared
      if (previous !== undefined && JSON.stringify(previous.capabilities) === JSON.stringify(capabilities)) return false
      declared.set(id, { value: { capabilities, seenAt: now() }, seq: ++declareSeq })
      if (capabilitiesDifferMaterially(stored()[id]?.declared?.capabilities, capabilities)) dirty.add(id)
      else dirty.delete(id)
      return true
    },
    persist,
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
            if (r.ok) {
              lastSeen.delete(id)
              declared.delete(id)
              dirty.delete(id)
            }
          }))
        )
      })
  }
}
