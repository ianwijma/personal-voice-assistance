import type { DeviceCapabilities, DevicePrivacy, SettingsSection } from "@pva/protocol"

/**
 * The Place and "What it can do" sections of a device page (protocol 11), as pure functions: the household's people
 * from the Members section, the privacy choices and their words, and the rows of a declaration.
 */

/** The Members field (shared settings › Members) and its section. */
export const MEMBERS_KEY = "HOUSEHOLD_MEMBERS"

export interface MemberRef {
  readonly id: string
  readonly name: string
}

/** The people of the Members section as saved (records without an id, which the server has not made yet, are left out). */
export const membersOf = (sections: ReadonlyArray<SettingsSection>): ReadonlyArray<MemberRef> => {
  for (const s of sections) {
    const value = s.form.values[MEMBERS_KEY]
    if (!Array.isArray(value)) continue
    return value.flatMap((r) => {
      if (typeof r !== "object" || r === null || Array.isArray(r)) return []
      const record = r as Readonly<Record<string, unknown>>
      return typeof record.id === "string" && record.id !== "" && typeof record.name === "string" && record.name.trim() !== ""
        ? [{ id: record.id, name: record.name.trim() }]
        : []
    })
  }
  return []
}

export const PRIVACY_CHOICES: ReadonlyArray<{ readonly value: DevicePrivacy; readonly label: string; readonly help: string }> = [
  { value: "private", label: "Private", help: "One person's device, such as a phone or a bedside speaker: personal things are shown and spoken here." },
  { value: "shared", label: "Shared", help: "The household's, such as the kitchen tablet: personal things only for its default person; others' are left out." },
  { value: "public", label: "Public", help: "Anyone may hear or see it, such as the hallway by the front door: no personal things at all." }
]

const DISPLAY_SIZE: Readonly<Record<string, string>> = {
  glance: "Small screen",
  compact: "Phone-size screen",
  standard: "Tablet-size screen",
  large: "Large screen"
}

/** The rows of "What it can do": each capability, and whether the device has it. */
export const declaredRows = (caps: DeviceCapabilities): ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: string; readonly has: boolean }> => {
  const d = caps.display
  return [
    {
      key: "display",
      label: "Screen",
      value: d === undefined
        ? "None"
        : `${DISPLAY_SIZE[d.class] ?? d.class}, ${d.widthPx} × ${d.heightPx}${d.dpr !== 1 ? ` at ×${d.dpr}` : ""}${d.touch === "none" ? "" : d.touch === "coarse" ? ", touch" : ", mouse or pen"}${d.colour ? "" : ", no colour"}`,
      has: d !== undefined
    },
    { key: "speaker", label: "Speaker", value: caps.speaker === undefined ? "None" : caps.speaker.media.includes("audio") ? "Speech and sound" : "Speech", has: caps.speaker !== undefined },
    { key: "microphone", label: "Microphone", value: caps.microphone === undefined ? "None" : caps.microphone.farField ? "Hears across the room" : "Yes", has: caps.microphone !== undefined },
    { key: "openUrl", label: "Opens links", value: caps.openUrl === true ? "Yes (a phone)" : "No", has: caps.openUrl === true }
  ]
}
