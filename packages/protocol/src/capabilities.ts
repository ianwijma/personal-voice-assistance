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
/** A key that is not a kind name is left out of `present.kinds` when it is decoded. */
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

/** Whether replies may be spoken on a device with these capabilities: a speaker that plays speech. */
export const canSpeak = (caps: DeviceCapabilities | undefined): boolean => caps?.speaker?.media.includes("speech") === true

/**
 * What a speaker plays, from its actual media set: "speech", "speech and sound", "sound and video, no speech",
 * "nothing" (an empty set). Admin and the context line both use it, so neither says "speech" where none is sent.
 */
export const speakerMediaWords = (media: ReadonlyArray<"speech" | "audio" | "video">): string => {
  const names = [media.includes("speech") ? "speech" : undefined, media.includes("audio") ? "sound" : undefined, media.includes("video") ? "video" : undefined]
    .filter((n): n is string => n !== undefined)
  if (names.length === 0) return "nothing"
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`
  return media.includes("speech") ? list : `${list}, no speech`
}

/**
 * A few words for what a device can do ("tablet-size screen, touch, speaker (speech), microphone"; "voice only
 * (speech), no screen"; "no screen, speaker (sound, no speech)"; "nothing declared"), for the per-turn context line and admin. The speaker's words are its media set.
 */
export const capabilityWords = (caps: DeviceCapabilities): string => {
  const parts: Array<string> = []
  if (caps.display !== undefined) {
    parts.push(DISPLAY_WORDS[caps.display.class])
    if (caps.display.touch !== "none") parts.push("touch")
  }
  if (caps.speaker !== undefined) parts.push(`speaker (${speakerMediaWords(caps.speaker.media)})`)
  if (caps.microphone !== undefined) parts.push("microphone")
  if (parts.length === 0) return "nothing declared"
  if (caps.display === undefined) {
    if (canSpeak(caps)) return `voice only (${speakerMediaWords(caps.speaker!.media)}), no screen${caps.microphone === undefined ? ", no microphone" : ""}`
    return `no screen, ${parts.join(", ")}`
  }
  if (caps.speaker === undefined) parts.push("no speaker")
  return parts.join(", ")
}

/**
 * The presentation kinds the protocol knows, for the "never show these" switches of a device type that has no
 * representative device. Empty until the presentation catalogue arrives (P10 fills this one constant); admin then says
 * "none yet".
 */
export const KNOWN_PRESENT_KINDS: ReadonlyArray<PresentKind> = []

// -- Place (the `place` device settings section) -----------------------------------------------------------------------

/** A person's id in the household's Members (`Person.id`): made by the server, stable. */
export const PersonId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,39}$/))
export type PersonId = typeof PersonId.Type

export const MAX_ROOM_CHARS = 60

/** Control and format characters, line and paragraph separators: never part of a name a prompt may carry. */
const NOT_ONE_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
/** One line of plain text: no control or format characters, no line breaks (rooms; checked where they are saved). */
export const isOneLine = (s: string): boolean => !NOT_ONE_LINE.test(s)

/** `private`: one person's (a bedroom phone); `shared`: the household's (the kitchen); `public`: anyone may hear or see it (the hallway). */
export const DevicePrivacy = Schema.Literals(["private", "shared", "public"])
export type DevicePrivacy = typeof DevicePrivacy.Type

/** Where and for whom a device is. Never detected: set in admin. */
export const DevicePlace = Schema.Struct({
  /** Free text ("Kitchen"); "" = no room. Matched to Home Assistant areas by name. */
  room: Schema.String.check(
    Schema.isMaxLength(MAX_ROOM_CHARS),
    Schema.makeFilter((s: string) => isOneLine(s) || "a room is one line of text, without control characters")
  ),
  privacy: DevicePrivacy,
  /** A wall tablet in kiosk mode, as opposed to a tab opened now and then. */
  alwaysOn: Schema.Boolean,
  /** Other devices may send things here (a presentation, an announcement). */
  acceptsFromOthers: Schema.Boolean,
  /** Nothing that nobody here asked for is spoken in this room (the delivery policy, P9). */
  quietRoom: Schema.Boolean,
  /**
   * P7 (docs/MODULES-PLAN.md §2 row 4, "while ringing"): while a notification rings on the device, "stop" and the ringing
   * notification's buttons are accepted without the wake phrase (the host's `ringing` window, docs/PHRASES.md). Absent
   * means on (the default); `false` switches it off. Optional, so an older peer ignores it and needs no new version.
   */
  ringingWithoutWake: Schema.optionalKey(Schema.Boolean),
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

/** Whether the device accepts "stop" and a ringing notification's buttons without the wake phrase while it rings (default on). */
export const ringingWithoutWake = (place: Pick<DevicePlace, "ringingWithoutWake"> | undefined): boolean => place?.ringingWithoutWake !== false

/** Rooms are compared without case and surrounding space. */
export const sameRoom = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase()

// -- Members (shared settings › Members; the server's and the mock's one check) -----------------------------------------

/** The most people in Members. */
export const MAX_MEMBERS = 24

/**
 * A person's name as names are compared (duplicates in Members, `findPerson`): compatibility-normalised and without
 * combining marks *before* it is split into words, lower case, apostrophes dropped ("Änne" and "Änne" are
 * "anne"; "O'Brien" is "obrien").
 */
export const memberNameKey = (text: string): string =>
  [...text.normalize("NFKD").replace(/\p{M}/gu, "").matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu)]
    .map((m) => m[0].toLowerCase().replace(/['’]/g, ""))
    .filter((w) => w !== "")
    .join(" ")

/**
 * The Members list as a whole: at most `MAX_MEMBERS`; every person has a name of one line with letters or digits; no
 * two people have the same name (as `memberNameKey` compares them); aliases and the pronunciation are one line.
 * A message for the first problem, or `undefined`.
 */
export const checkMembers = (list: ReadonlyArray<{ readonly name: string; readonly aliases?: ReadonlyArray<string>; readonly pronunciation?: string }>): string | undefined => {
  if (list.length > MAX_MEMBERS) return `At most ${MAX_MEMBERS} people`
  const seen = new Set<string>()
  for (const [i, m] of list.entries()) {
    if (typeof m.name !== "string" || m.name.trim() === "") return `Person ${i + 1} needs a name`
    if (!isOneLine(m.name)) return `The name of person ${i + 1} must be one line, without control characters`
    const key = memberNameKey(m.name)
    if (key === "") return `Person ${i + 1} needs a name with letters or digits`
    if (seen.has(key)) return `Two people are called ${m.name.trim()}; give one of them another name (an alias can be shared)`
    seen.add(key)
    if ((m.aliases ?? []).some((a) => !isOneLine(a)) || (m.pronunciation !== undefined && !isOneLine(m.pronunciation))) {
      return `The other names and pronunciation of ${m.name.trim()} must be one line each`
    }
  }
  return undefined
}

/** The bounds of a Members record and of a diet list (the server's section and the mock's check use these). */
export const MEMBER_LIMITS = {
  id: 40,
  name: 60,
  aliases: 10,
  alias: 40,
  pronunciation: 60,
  dietItems: 30,
  dietItem: 60
} as const

/** The diet lists of a person and of the household. */
export const DIET_FIELDS = ["allergies", "diets", "dislikes"] as const

const isRecordValue = (u: unknown): u is Readonly<Record<string, unknown>> => typeof u === "object" && u !== null && !Array.isArray(u)

/**
 * A diet list (a person's or the household's): a list of at most `dietItems` one-line texts of at most `dietItem`
 * characters. A message for the first problem, or `undefined`.
 */
export const checkDietList = (label: string, value: unknown): string | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return `${label} must be a list`
  if (value.length > MEMBER_LIMITS.dietItems) return `${label}: at most ${MEMBER_LIMITS.dietItems}`
  for (const item of value) {
    if (typeof item !== "string") return `${label} must be texts`
    if ([...item].length > MEMBER_LIMITS.dietItem) return `${label}: each at most ${MEMBER_LIMITS.dietItem} characters`
    if (!isOneLine(item)) return `${label}: each one line, without control characters`
  }
  return undefined
}

/**
 * P5 round 2: the whole `HOUSEHOLD_MEMBERS` value as it arrives from a page, before anything is stored: a list of
 * records whose every field has its type and bounds (`MEMBER_LIMITS`), then `checkMembers`. The server's Members
 * section runs it as its check and the mock server on its save path, so both refuse the same values. A message for
 * the first problem, or `undefined`.
 */
export const checkMembersValue = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return "Must be a list of people"
  if (value.length > MAX_MEMBERS) return `At most ${MAX_MEMBERS} people`
  for (const [i, r] of value.entries()) {
    const who = `Person ${i + 1}`
    if (!isRecordValue(r)) return `${who} must be a record`
    if (r.id !== undefined && (typeof r.id !== "string" || [...r.id].length > MEMBER_LIMITS.id)) return `${who} has an id that is not valid`
    if (typeof r.name !== "string") return `${who} needs a name`
    if ([...r.name].length > MEMBER_LIMITS.name) return `The name of person ${i + 1}: at most ${MEMBER_LIMITS.name} characters`
    if (r.aliases !== undefined) {
      if (!Array.isArray(r.aliases) || r.aliases.some((a) => typeof a !== "string")) return `The other names of person ${i + 1} must be a list of texts`
      if (r.aliases.length > MEMBER_LIMITS.aliases) return `Person ${i + 1}: at most ${MEMBER_LIMITS.aliases} other names`
      if (r.aliases.some((a: string) => [...a].length > MEMBER_LIMITS.alias)) return `The other names of person ${i + 1}: each at most ${MEMBER_LIMITS.alias} characters`
    }
    if (r.pronunciation !== undefined) {
      if (typeof r.pronunciation !== "string") return `The pronunciation of person ${i + 1} must be a text`
      if ([...r.pronunciation].length > MEMBER_LIMITS.pronunciation) return `The pronunciation of person ${i + 1}: at most ${MEMBER_LIMITS.pronunciation} characters`
    }
    for (const field of DIET_FIELDS) {
      const problem = checkDietList(`${field.charAt(0).toUpperCase()}${field.slice(1)} of person ${i + 1}`, r[field])
      if (problem !== undefined) return problem
    }
  }
  return checkMembers(value.map((r) => ({
    name: (r as { name: string }).name,
    aliases: ((r as { aliases?: ReadonlyArray<string> }).aliases ?? []) as ReadonlyArray<string>,
    ...(typeof (r as { pronunciation?: unknown }).pronunciation === "string" ? { pronunciation: (r as { pronunciation: string }).pronunciation } : {})
  })))
}
