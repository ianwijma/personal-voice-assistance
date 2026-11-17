import { Schema } from "effect"
import { NonNegativeFinite } from "./common.ts"

/**
 * What a device can do, where it is and for whom (docs/MODULES-PLAN.md §4 P5; presentation-and-device-capabilities.md
 * §5). Pure and browser-safe: the server, the voice page and admin share these definitions.
 *
 * Three layers, because they come from three places and change at different speeds:
 *
 * - **Capabilities** (`DeviceCapabilities`): what the hardware and front end can do. Declared by the device in
 *   `hello.device.capabilities` and again with `device.caps` when it changes (a resize, a rotation). Absent means
 *   "cannot" (LSP's rule). The server keeps the last declaration per device in its record.
 * - **Place** (`DevicePlace`, the `place` device settings section): its room, how private it is, whose it is by default.
 *   Never detected; set in admin.
 * - **Live state** (`DeviceLiveState`): whether the page is visible and when someone last used it. Memory only.
 *
 * The owner can only take capabilities away (`CapabilityOverrides`, the `capabilities` section): a kiosk can be told
 * "treat as no display", never be given a display it lacks. `effectiveCapabilities` is the one function that applies
 * them; every later consumer (the Presenter, the delivery policy, the context line) calls it.
 */

// -- Capabilities ------------------------------------------------------------------------------------------------------

/** Display size classes, by the viewport in CSS pixels (`displayClassOf`). */
export const DisplayClass = Schema.Literals(["glance", "compact", "standard", "large"])
export type DisplayClass = typeof DisplayClass.Type

/** A presentation kind name ("card", "list", "timer"); at most `MAX_PRESENT_KINDS` per device. */
export const PresentKind = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/))
export type PresentKind = typeof PresentKind.Type
export const MAX_PRESENT_KINDS = 64

const Pixels = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))

export const DisplayCapability = Schema.Struct({
  /** `glance` ≤ 480 px (a small panel), `compact` a phone, `standard` a tablet or hub, `large` a desktop or TV. */
  class: DisplayClass,
  widthPx: Pixels,
  heightPx: Pixels,
  /** `devicePixelRatio`. */
  dpr: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 16 })),
  shape: Schema.optionalKey(Schema.Literals(["rect", "round"])),
  touch: Schema.Literals(["none", "coarse", "fine"]),
  /** `false`: e-ink or an LED matrix. */
  colour: Schema.Boolean
})
export type DisplayCapability = typeof DisplayCapability.Type

/** What the hardware and front end can do. Absent = cannot. */
export const DeviceCapabilities = Schema.Struct({
  v: Schema.Literal(1),
  display: Schema.optionalKey(DisplayCapability),
  /** Kind → the highest version the page renders. Empty until the presentation stage exists (P10). */
  present: Schema.optionalKey(Schema.Struct({
    kinds: Schema.Record(PresentKind, Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })))
      .check(Schema.makeFilter((r: Readonly<Record<string, number>>) => Object.keys(r).length <= MAX_PRESENT_KINDS || `at most ${MAX_PRESENT_KINDS} kinds`))
  })),
  /** `speech`: spoken replies. */
  speaker: Schema.optionalKey(Schema.Struct({ media: Schema.Array(Schema.Literals(["speech", "audio", "video"])).check(Schema.isMaxLength(3)) })),
  microphone: Schema.optionalKey(Schema.Struct({ farField: Schema.Boolean })),
  /** It can open a link in a browser (a phone tab). */
  openUrl: Schema.optionalKey(Schema.Boolean)
})
export type DeviceCapabilities = typeof DeviceCapabilities.Type

/** What is true right now. Sent at most once a second (`device.caps.live`); memory only on the server. */
export const DeviceLiveState = Schema.Struct({
  /** Page Visibility: `false` = the tab is in the background or the screen is off. */
  visible: Schema.Boolean,
  /** Epoch ms of the last touch, key or click on the page: a cheap presence signal. */
  lastInteractionAt: Schema.optionalKey(NonNegativeFinite)
})
export type DeviceLiveState = typeof DeviceLiveState.Type

/** The last declaration of a device, as its record keeps it. */
export const DeclaredCapabilities = Schema.Struct({
  capabilities: DeviceCapabilities,
  /** Epoch ms when it was last declared. */
  seenAt: NonNegativeFinite
})
export type DeclaredCapabilities = typeof DeclaredCapabilities.Type

/** Nothing: what a device that never declared anything can do. */
export const NO_CAPABILITIES: DeviceCapabilities = { v: 1 }

/**
 * The size class of a viewport (CSS pixels): `glance` when its longer side is at most 480, `compact` (a phone) when
 * its shorter side is under 500, `standard` (a tablet, a hub, a small window) when its longer side is under 1200,
 * else `large`.
 */
export const displayClassOf = (widthPx: number, heightPx: number): DisplayClass => {
  const long = Math.max(widthPx, heightPx)
  const short = Math.min(widthPx, heightPx)
  if (long <= 480) return "glance"
  if (short < 500) return "compact"
  if (long < 1200) return "standard"
  return "large"
}

/**
 * Whether two declarations differ in more than the viewport's exact size (a window being resized): the server writes
 * a changed declaration to the device record at once only then, and keeps the rest in memory until the next write.
 */
export const capabilitiesDifferMaterially = (a: DeviceCapabilities | undefined, b: DeviceCapabilities | undefined): boolean => {
  const strip = (c: DeviceCapabilities | undefined) =>
    c === undefined ? undefined : { ...c, ...(c.display !== undefined ? { display: { ...c.display, widthPx: 0, heightPx: 0 } } : {}) }
  return JSON.stringify(strip(a)) !== JSON.stringify(strip(b))
}

// -- Overrides (the `capabilities` device settings section) ------------------------------------------------------------

/** What the owner took away. Each can only remove (`effectiveCapabilities`). */
export const CapabilityOverrides = Schema.Struct({
  /** Treat as no display (a phone used as a speaker, a screen nobody looks at). */
  noDisplay: Schema.Boolean,
  /** Presentation kinds never sent here. */
  excludeKinds: Schema.Array(PresentKind).check(Schema.isMaxLength(MAX_PRESENT_KINDS)),
  /** Treat as no speaker: nothing is spoken here. */
  noSpeaker: Schema.Boolean
})
export type CapabilityOverrides = typeof CapabilityOverrides.Type

export const NO_OVERRIDES: CapabilityOverrides = { noDisplay: false, excludeKinds: [], noSpeaker: false }

/**
 * Effective capabilities = declared minus overrides. Never adds anything: no declaration is "cannot do anything"; no
 * display also means no presentation kinds; excluded kinds are dropped; no speaker drops the speaker.
 */
export const effectiveCapabilities = (declared: DeviceCapabilities | undefined, overrides: CapabilityOverrides = NO_OVERRIDES): DeviceCapabilities => {
  if (declared === undefined) return NO_CAPABILITIES
  const out: { -readonly [K in keyof DeviceCapabilities]: DeviceCapabilities[K] } = { v: 1 }
  const display = overrides.noDisplay ? undefined : declared.display
  if (display !== undefined) out.display = display
  if (display !== undefined && declared.present !== undefined) {
    const excluded = new Set(overrides.excludeKinds)
    out.present = { kinds: Object.fromEntries(Object.entries(declared.present.kinds).filter(([k]) => !excluded.has(k))) }
  }
  if (declared.speaker !== undefined && !overrides.noSpeaker) out.speaker = declared.speaker
  if (declared.microphone !== undefined) out.microphone = declared.microphone
  if (declared.openUrl === true) out.openUrl = true
  return out
}

const DISPLAY_WORDS: Readonly<Record<DisplayClass, string>> = {
  glance: "small screen",
  compact: "phone-size screen",
  standard: "tablet-size screen",
  large: "large screen"
}

/**
 * A few words for what a device can do ("tablet-size screen, touch, speaker, microphone"; "voice only, no screen";
 * "nothing declared"), for the per-turn context line and admin.
 */
export const capabilityWords = (caps: DeviceCapabilities): string => {
  const parts: Array<string> = []
  if (caps.display !== undefined) {
    parts.push(DISPLAY_WORDS[caps.display.class])
    if (caps.display.touch !== "none") parts.push("touch")
  }
  if (caps.speaker !== undefined) parts.push("speaker")
  if (caps.microphone !== undefined) parts.push("microphone")
  if (parts.length === 0) return "nothing declared"
  if (caps.display === undefined) return caps.speaker !== undefined ? `voice only, no screen${caps.microphone === undefined ? ", no microphone" : ""}` : `no screen, ${parts.join(", ")}`
  if (caps.speaker === undefined) parts.push("no speaker")
  return parts.join(", ")
}

// -- Place (the `place` device settings section) -----------------------------------------------------------------------

/** A person's id in the household's Members (`Person.id`): made by the server, stable. */
export const PersonId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,39}$/))
export type PersonId = typeof PersonId.Type

export const MAX_ROOM_CHARS = 60

/** `private`: one person's (a bedroom phone); `shared`: the household's (the kitchen); `public`: anyone may hear or see it (the hallway). */
export const DevicePrivacy = Schema.Literals(["private", "shared", "public"])
export type DevicePrivacy = typeof DevicePrivacy.Type

/** Where and for whom a device is. Never detected: set in admin. */
export const DevicePlace = Schema.Struct({
  /** Free text ("Kitchen"); "" = no room. Matched to Home Assistant areas by name. */
  room: Schema.String.check(Schema.isMaxLength(MAX_ROOM_CHARS)),
  privacy: DevicePrivacy,
  /** A wall tablet in kiosk mode, as opposed to a tab opened now and then. */
  alwaysOn: Schema.Boolean,
  /** Other devices may send things here (a presentation, an announcement). */
  acceptsFromOthers: Schema.Boolean,
  /** Nothing that nobody here asked for is spoken in this room (the delivery policy, P9). */
  quietRoom: Schema.Boolean,
  /**
   * Whose data a turn here means (docs/MODULES-PLAN.md §2 row 1, row 7): the one link between a device and a person.
   * It selects; it never grants access. `null`: nobody's (household data).
   */
  defaultPerson: Schema.NullOr(PersonId)
})
export type DevicePlace = typeof DevicePlace.Type

/** The built-in place of a browser. */
export const BUILT_IN_PLACE: DevicePlace = {
  room: "",
  privacy: "shared",
  alwaysOn: false,
  acceptsFromOthers: true,
  quietRoom: false,
  defaultPerson: null
}

/** The room as said ("Kitchen"), or `undefined` for none. */
export const roomOf = (place: Pick<DevicePlace, "room">): string | undefined => {
  const room = place.room.trim()
  return room === "" ? undefined : room
}

/** Rooms are compared without case and surrounding space. */
export const sameRoom = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase()
