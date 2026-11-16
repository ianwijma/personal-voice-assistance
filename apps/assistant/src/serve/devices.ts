import {
  applicableOwn,
  type DeviceInfo,
  type DeviceListInfo,
  type DeviceSettings,
  type DeviceTypeInfo,
  DEVICE_TYPES,
  deviceTypeOf,
  effectiveDeviceSettings,
  hearerOf,
  WEB_VOICE_DEVICE_TYPE,
  WEB_VOICE_KIND
} from "@pva/protocol"
import type { SettingsFile } from "./SettingsStore.ts"

/**
 * Device types and devices as version 4 stores them (docs/ASSISTANTS.md §2.3, §2.6), computed for the server and the
 * pushes. Pure functions of the settings file: `frontends.ts` still serves the protocol 5 messages (`device.update`,
 * `frontend.update`, `device.admin.update`, `device.forget`, the profile), this file adds the protocol 7 view.
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

/** `devices`: the protocol 5 entries (from `Frontends.devices`) with `own`, `settings`, `hearer` and `rev` added. */
export const deviceListInfos = (file: SettingsFile, base: ReadonlyArray<DeviceInfo>): ReadonlyArray<DeviceListInfo> =>
  base.map((d) => {
    const settings = deviceSettingsFrom(file, d.id, d.kind)
    return { ...d, own: file.devices[d.id]?.own ?? {}, settings, hearer: hearerOf(settings), rev: file.devices[d.id]?.rev ?? 0 }
  })
