import {
  DEFAULT_DEVICE_PROFILE,
  DEVICE_EDITABLE_FIELDS,
  type DeviceHello,
  type DeviceInfo,
  type DeviceProfile,
  effectiveProfile,
  applyProfilePatch,
  type ErrorInfo,
  type FieldError,
  type FrontendKindInfo,
  MAX_DEVICES,
  PROFILE_FIELDS,
  type ProfileField,
  type ProfileOverrides,
  type ProfilePatch,
  patchFields,
  WEB_VOICE_KIND
} from "@pva/protocol"
import { Effect } from "effect"
import type { DeviceRecord, FrontendData, SettingsStore } from "./SettingsStore.ts"

/**
 * Front-end kinds, devices and their profiles (docs/FRONTENDS-AND-ACTIVATION.md §2), on the server.
 *
 * Kinds are a registry (`FRONTEND_KINDS`): adding one (`satellite`) is one entry. Kind defaults and device records
 * are stored in `data/settings.json` (`frontends`, `devices`) through `SettingsStore.saveFrontends`. Effective
 * profile = `DEFAULT_DEVICE_PROFILE` ← kind defaults ← device overrides, with `voice` validated against the enabled
 * voices (a voice that is not enabled, or no longer is, falls back to `""`, the assistant's default).
 *
 * This module only computes and stores; who gets which message (`device.profile`, `frontends`, `devices`) is the
 * hub's business (`SessionHub`).
 */

export interface FrontendKind {
  readonly id: string
  readonly title: string
  readonly description: string
  /** The profile fields that apply to this kind, in form order. */
  readonly fields: ReadonlyArray<ProfileField>
}

/** The front-end kinds, in the order admin lists them. */
export const FRONTEND_KINDS: ReadonlyArray<FrontendKind> = [
  {
    id: WEB_VOICE_KIND,
    title: "Voice assistant in a browser",
    description: "The voice page (/) on a phone, tablet or computer: microphone and speaker of that browser.",
    fields: PROFILE_FIELDS
  }
  // Satellites (a box with a microphone and a speaker) will be one more entry here, e.g.
  // { id: "satellite", title: "Satellite", description: "…", fields: [activation, wake…, voice, interruptMode] }.
]

export const kindOf = (id: string): FrontendKind | undefined => FRONTEND_KINDS.find((k) => k.id === id)

/** A device record is written again on `hello` only when its stored `lastSeen` is older than this. */
export const LAST_SEEN_WRITE_MS = 10 * 60_000

export type FrontendResult = { readonly ok: true } | { readonly ok: false; readonly error: ErrorInfo }

const failure = (code: ErrorInfo["code"], message: string, fieldErrors?: ReadonlyArray<FieldError>): FrontendResult => ({
  ok: false,
  error: { code, message, ...(fieldErrors !== undefined ? { fieldErrors } : {}) }
})

export interface Frontends {
  /** Every kind with its defaults (admin). */
  readonly kinds: () => ReadonlyArray<FrontendKindInfo>
  /**
   * Every remembered device, most recently seen first. `live`: connections and whether one owns the audio, per
   * device id (from the hub).
   */
  readonly devices: (live: (id: string) => { readonly connections: number; readonly audioOwner: boolean }) => ReadonlyArray<DeviceInfo>
  /** The effective profile of a device (unknown or no device: its kind's defaults; no kind: `web-voice`). */
  readonly profile: (deviceId: string | undefined, kind?: string) => DeviceProfile
  /**
   * A device said hello: remember it (first time: with its suggested name; the 64-device cap drops the least
   * recently seen, devices with overrides last, connected devices never) and update `lastSeen`. `connected`: ids
   * of devices with an open connection now. Saves in the background (`run`); `onSaved` after the save.
   */
  readonly seen: (device: DeviceHello, connected: ReadonlySet<string>) => Effect.Effect<void>
  /** A device's connection closed: `lastSeen` = now (memory; written with the next save). */
  readonly left: (id: string) => void
  readonly known: (id: string) => boolean
  readonly kindOfDevice: (id: string) => string | undefined
  /**
   * `device.update` from the device itself: only `DEVICE_EDITABLE_FIELDS`. A device whose first record is still
   * being saved is recorded with this change.
   */
  readonly updateOwn: (device: DeviceHello, patch: ProfilePatch, connected: ReadonlySet<string>) => Effect.Effect<FrontendResult>
  /** `frontend.update` (admin). */
  readonly updateKind: (kind: string, patch: ProfilePatch) => Effect.Effect<FrontendResult>
  /** `device.admin.update` (admin). */
  readonly updateDevice: (id: string, name: string | undefined, patch: ProfilePatch | undefined) => Effect.Effect<FrontendResult>
  /** `device.forget` (admin). */
  readonly forget: (id: string) => Effect.Effect<FrontendResult>
}

export interface FrontendsOptions {
  readonly store: SettingsStore
  /** The names of the enabled voices; empty = not known yet (no validation then). */
  readonly enabledVoices: () => ReadonlySet<string>
  /** Default `Date.now`. */
  readonly now?: () => number
}

export const makeFrontends = (options: FrontendsOptions): Frontends => {
  const { store } = options
  const now = options.now ?? Date.now
  /** `lastSeen` newer than the stored one (memory only until the next save). */
  const lastSeen = new Map<string, number>()

  const data = (): FrontendData => store.settings()
  const kindDefaults = (kind: string): ProfileOverrides => data().frontends[kind] ?? {}

  const validVoice = (profile: DeviceProfile): DeviceProfile => {
    if (profile.voice === "") return profile
    const voices = options.enabledVoices()
    return voices.size === 0 || voices.has(profile.voice) ? profile : { ...profile, voice: "" }
  }

  const profile = (deviceId: string | undefined, kind?: string): DeviceProfile => {
    const record = deviceId === undefined ? undefined : data().devices[deviceId]
    const k = record?.kind ?? kind ?? WEB_VOICE_KIND
    return validVoice(effectiveProfile(kindDefaults(k), record?.overrides ?? {}, DEFAULT_DEVICE_PROFILE))
  }

  /** Checks shared by every patch: fields of the kind, and a voice that is enabled. */
  const checkPatch = (patch: ProfilePatch, allowed: ReadonlyArray<ProfileField>): FrontendResult => {
    const fields = patchFields(patch)
    const outside = fields.filter((f) => !allowed.includes(f))
    if (outside.length > 0) {
      return failure("invalid_settings", "These settings do not apply here", outside.map((key) => ({ key, message: "Does not apply to this front end" })))
    }
    const voice = patch.voice
    if (typeof voice === "string" && voice !== "") {
      const voices = options.enabledVoices()
      if (voices.size > 0 && !voices.has(voice)) {
        return failure("invalid_settings", `"${voice}" is not an enabled voice`, [{ key: "voice", message: "Not an enabled voice" }])
      }
    }
    return { ok: true }
  }

  const save = (what: string, change: (committed: FrontendData) => FrontendData): Effect.Effect<FrontendResult> =>
    store.saveFrontends(what, change).pipe(
      Effect.as<FrontendResult>({ ok: true }),
      Effect.catch((e) => Effect.succeed(failure("internal", e.message)))
    )

  const withLastSeen = (id: string, record: DeviceRecord): DeviceRecord => {
    const seen = lastSeen.get(id)
    return seen !== undefined && seen > record.lastSeen ? { ...record, lastSeen: seen } : record
  }

  /** The devices map with memory `lastSeen` folded in (what a save writes). */
  const withAllLastSeen = (devices: FrontendData["devices"]): Record<string, DeviceRecord> =>
    Object.fromEntries(Object.entries(devices).map(([id, r]) => [id, withLastSeen(id, r)]))

  const hasOverrides = (r: DeviceRecord) => Object.keys(r.overrides).length > 0

  /** Make room for one more: drop the least recently seen not connected (without overrides first). */
  const capped = (devices: Record<string, DeviceRecord>, connected: ReadonlySet<string>): Record<string, DeviceRecord> => {
    const out = { ...devices }
    const ids = Object.keys(out)
    let excess = ids.length - (MAX_DEVICES - 1)
    if (excess <= 0) return out
    const candidates = ids
      .filter((id) => !connected.has(id))
      .sort((a, b) => Number(hasOverrides(out[a]!)) - Number(hasOverrides(out[b]!)) || out[a]!.lastSeen - out[b]!.lastSeen)
    for (const id of candidates) {
      if (excess <= 0) break
      delete out[id]
      lastSeen.delete(id)
      excess--
    }
    return out
  }

  return {
    kinds: () =>
      FRONTEND_KINDS.map((k) => ({
        id: k.id,
        title: k.title,
        description: k.description,
        fields: [...k.fields],
        defaults: kindDefaults(k.id),
        profile: validVoice(effectiveProfile(kindDefaults(k.id), {}, DEFAULT_DEVICE_PROFILE))
      })),
    devices: (live) => {
      const t = now()
      return Object.entries(data().devices)
        .map(([id, stored]): DeviceInfo => {
          const record = withLastSeen(id, stored)
          const l = live(id)
          return {
            id,
            kind: record.kind,
            name: record.name,
            firstSeen: record.firstSeen,
            lastSeen: l.connections > 0 ? Math.max(record.lastSeen, t) : record.lastSeen,
            overrides: record.overrides,
            profile: profile(id),
            connections: l.connections,
            audioOwner: l.audioOwner
          }
        })
        .sort((a, b) => b.lastSeen - a.lastSeen)
    },
    profile,
    seen: (device, connected) =>
      Effect.suspend(() => {
        const t = now()
        const stored = data().devices[device.id]
        lastSeen.set(device.id, t)
        if (stored !== undefined && t - stored.lastSeen < LAST_SEEN_WRITE_MS) return Effect.void
        return store.saveFrontends(stored === undefined ? `device ${device.id}` : `the last visit of device ${device.id}`, (committed) => {
          const devices = withAllLastSeen(committed.devices)
          const before = devices[device.id]
          const record: DeviceRecord = before === undefined
            ? { kind: device.kind, name: device.name.trim(), firstSeen: t, lastSeen: t, overrides: {} }
            : { ...before, lastSeen: Math.max(before.lastSeen, t) }
          const room = before === undefined ? capped(devices, connected) : devices
          return { frontends: committed.frontends, devices: { ...room, [device.id]: record } }
        }).pipe(Effect.catch((e) => Effect.logDebug(`Device ${device.id} not saved: ${e.message}`)))
      }),
    left: (id) => {
      if (data().devices[id] !== undefined) lastSeen.set(id, now())
    },
    known: (id) => data().devices[id] !== undefined,
    kindOfDevice: (id) => data().devices[id]?.kind,
    updateOwn: (device, patch, connected) =>
      Effect.suspend(() => {
        const id = device.id
        const record = data().devices[id]
        const fields = patchFields(patch)
        const notEditable = fields.filter((f) => !DEVICE_EDITABLE_FIELDS.includes(f))
        if (notEditable.length > 0) {
          return Effect.succeed(failure("admin_required", `Only admin can change ${notEditable.join(", ")}: log in on the admin page`))
        }
        const checked = checkPatch(patch, kindOf(record?.kind ?? device.kind)?.fields ?? PROFILE_FIELDS)
        if (!checked.ok) return Effect.succeed(checked)
        return save(`the settings of device ${id}`, (committed) => {
          const t = now()
          const before = committed.devices[id]
          const devices = withAllLastSeen(committed.devices)
          const current = before === undefined
            ? { kind: device.kind, name: device.name.trim(), firstSeen: t, lastSeen: t, overrides: {} }
            : withLastSeen(id, before)
          const room = before === undefined ? capped(devices, connected) : devices
          return {
            frontends: committed.frontends,
            devices: { ...room, [id]: { ...current, overrides: applyProfilePatch(current.overrides, patch) } }
          }
        })
      }),
    updateKind: (kind, patch) =>
      Effect.suspend(() => {
        const k = kindOf(kind)
        if (k === undefined) return Effect.succeed(failure("unknown_device", `There is no front-end kind "${kind}"`))
        const checked = checkPatch(patch, k.fields)
        if (!checked.ok) return Effect.succeed(checked)
        return save(`the defaults of ${k.title}`, (committed) => {
          const next = applyProfilePatch(committed.frontends[kind] ?? {}, patch)
          const frontends = { ...committed.frontends }
          if (Object.keys(next).length === 0) delete frontends[kind]
          else frontends[kind] = next
          return { frontends, devices: committed.devices }
        })
      }),
    updateDevice: (id, name, patch) =>
      Effect.suspend(() => {
        const record = data().devices[id]
        if (record === undefined) return Effect.succeed(failure("unknown_device", "That device is not known (it may have been forgotten)"))
        if (patch !== undefined) {
          const checked = checkPatch(patch, kindOf(record.kind)?.fields ?? PROFILE_FIELDS)
          if (!checked.ok) return Effect.succeed(checked)
        }
        return save(`device ${id}`, (committed) => {
          const current = committed.devices[id]
          if (current === undefined) return committed
          const next: DeviceRecord = {
            ...withLastSeen(id, current),
            ...(name !== undefined ? { name: name.trim() } : {}),
            overrides: patch === undefined ? current.overrides : applyProfilePatch(current.overrides, patch)
          }
          return { frontends: committed.frontends, devices: { ...withAllLastSeen(committed.devices), [id]: next } }
        })
      }),
    forget: (id) =>
      Effect.suspend(() => {
        if (data().devices[id] === undefined) return Effect.succeed(failure("unknown_device", "That device is not known (it may have been forgotten already)"))
        return save(`forgetting device ${id}`, (committed) => {
          const devices = withAllLastSeen(committed.devices)
          delete devices[id]
          return { frontends: committed.frontends, devices }
        }).pipe(Effect.tap((r) => Effect.sync(() => {
          if (r.ok) lastSeen.delete(id)
        })))
      })
  }
}
