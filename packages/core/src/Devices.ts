import { capabilityWords, type DeclaredCapabilities, type DeviceCapabilities, type DevicePlace, roomOf, sameRoom } from "@pva/protocol"
import { ServiceKey } from "./ModuleApi.ts"
import { type DeviceRef, deviceIdOf } from "./Privacy.ts"

/**
 * The house's devices as modules and later host parts see them (docs/MODULES-PLAN.md §4 P5): name, room, place,
 * effective capabilities (declared minus the owner's overrides, `effectiveCapabilities`), whether it is connected, and
 * "the best other screen" (presentation-and-device-capabilities.md §6.2). Every read is a snapshot of cached values;
 * nothing here does I/O, so it may be called on a turn's path.
 */

export interface KnownDevice {
  readonly id: string
  readonly name: string
  readonly kind: string
  /** `place.room`, trimmed; `undefined` for none. */
  readonly room: string | undefined
  /** The effective `place` section. */
  readonly place: DevicePlace
  /** Declared minus overrides; `{ v: 1 }` (nothing) for a device that never declared anything. */
  readonly capabilities: DeviceCapabilities
  /** The last declaration, as declared, and when (absent: never declared). */
  readonly declared: DeclaredCapabilities | undefined
  /** A voice connection of it is open now. */
  readonly connected: boolean
  /** A tab of it is visible now (always `false` while not connected). */
  readonly visible: boolean
  /** Epoch ms of the last interaction (touch or voice), when known. */
  readonly lastInteractionAt: number | undefined
  /** Epoch ms it was last seen. */
  readonly lastSeen: number
}

export interface DevicesService {
  /** Every known device, most recently seen first. */
  readonly list: () => ReadonlyArray<KnownDevice>
  readonly get: (id: string) => KnownDevice | undefined
  /** Other screens that could show something for `from`, best first (§6.2); `person`: whose phone counts (default: `from`'s default person). */
  readonly otherScreens: (from: DeviceRef, options?: { readonly person?: string | undefined }) => ReadonlyArray<KnownDevice>
  /** The first of `otherScreens`, or `undefined`. */
  readonly bestOtherScreen: (from: DeviceRef, options?: { readonly person?: string | undefined }) => KnownDevice | undefined
}

/** `host.service(Devices)`: provided by the core in serve mode. */
export const Devices = ServiceKey<DevicesService>("core.devices")

/** It can show something: a display that the owner did not take away. */
export const hasScreen = (d: Pick<KnownDevice, "capabilities">): boolean => d.capabilities.display !== undefined

/**
 * "The best other screen" (§6.2): the display-capable devices other than `from` that accept things from other
 * devices, ranked (1) same room, connected and visible; (2) same room and always on; (3) the person's phone, if it can
 * open a link and is connected; (4) any other connected display in a shared room. Ties go to the most recent
 * interaction (else the most recently seen). Devices that fit no rank are left out.
 */
export const rankOtherScreens = (
  devices: ReadonlyArray<KnownDevice>,
  from: Pick<KnownDevice, "id" | "room" | "place"> | undefined,
  person?: string | undefined
): ReadonlyArray<KnownDevice> => {
  const who = person ?? from?.place.defaultPerson ?? undefined
  const rank = (d: KnownDevice): number | undefined => {
    const here = sameRoom(d.room, from?.room)
    if (here && d.connected && d.visible) return 1
    if (here && d.place.alwaysOn) return 2
    if (who !== undefined && d.place.defaultPerson === who && d.capabilities.openUrl === true && d.connected) return 3
    if (d.connected && d.place.privacy === "shared") return 4
    return undefined
  }
  const recent = (d: KnownDevice) => d.lastInteractionAt ?? d.lastSeen
  return devices
    .filter((d) => d.id !== from?.id && hasScreen(d) && d.place.acceptsFromOthers)
    .flatMap((d) => {
      const r = rank(d)
      return r === undefined ? [] : [{ d, r }]
    })
    .sort((a, b) => a.r - b.r || recent(b.d) - recent(a.d))
    .map((x) => x.d)
}

/** A `DevicesService` over a snapshot function (the caller caches it). */
export const makeDevices = (snapshot: () => ReadonlyArray<KnownDevice>): DevicesService => {
  const get = (id: string) => snapshot().find((d) => d.id === id)
  const otherScreens: DevicesService["otherScreens"] = (from, options = {}) => {
    const id = deviceIdOf(from)
    const all = snapshot()
    const self = id === undefined ? undefined : all.find((d) => d.id === id)
    return rankOtherScreens(all, self ?? (id === undefined ? undefined : { id, room: undefined, place: { room: "", privacy: "shared", alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson: null } }), options.person)
  }
  return { list: snapshot, get, otherScreens, bestOtherScreen: (from, options) => otherScreens(from, options)[0] }
}

/** The most other screens the context line names (the rest are counted). */
export const CONTEXT_LINE_SCREENS = 6

/**
 * The per-turn context line about the turn's device (presentation §5.4): this device, what it can do, its room, its
 * privacy and default person; then the other screens in the house that accept things from other devices, each "on"
 * (connected and visible) or "off". Never part of the cached system prompt. Example:
 * `Device: Kitchen speaker (voice only, no screen; room Kitchen; shared). Other screens: Kitchen iPad (on), Living room TV (off).`
 */
export const deviceContextLine = (
  devices: ReadonlyArray<KnownDevice>,
  deviceId: string | undefined,
  nameOf: (personId: string) => string | undefined = () => undefined
): string => {
  const self = deviceId === undefined ? undefined : devices.find((d) => d.id === deviceId)
  const parts: Array<string> = []
  if (self === undefined) parts.push("Device: a voice page without a known device (capabilities unknown).")
  else {
    const facts = [capabilityWords(self.capabilities)]
    const room = roomOf(self.place)
    if (room !== undefined) facts.push(`room ${room}`)
    const person = self.place.defaultPerson === null ? undefined : nameOf(self.place.defaultPerson)
    facts.push(person !== undefined ? `${self.place.privacy}, usually ${person}` : self.place.privacy)
    if (self.place.quietRoom) facts.push("quiet room")
    parts.push(`Device: ${self.name} (${facts.join("; ")}).`)
  }
  const screens = devices
    .filter((d) => d.id !== deviceId && hasScreen(d) && d.place.acceptsFromOthers)
    .map((d) => ({ d, on: d.connected && d.visible, here: sameRoom(d.room, self?.room) }))
    .sort((a, b) => Number(b.here) - Number(a.here) || Number(b.on) - Number(a.on) || a.d.name.localeCompare(b.d.name))
  if (screens.length === 0) parts.push("Other screens: none.")
  else {
    const named = screens.slice(0, CONTEXT_LINE_SCREENS).map((s) => `${s.d.name}${s.d.room !== undefined && !s.d.name.toLowerCase().includes(s.d.room.toLowerCase()) ? ` in ${s.d.room}` : ""} (${s.on ? "on" : "off"})`)
    const more = screens.length - named.length
    parts.push(`Other screens: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`)
  }
  return parts.join(" ")
}
