import {
  type DeviceInfo,
  type DeviceProfile,
  type ProfileField,
  type ProfileOverrides,
  type ProfilePatch,
  WAKE_PHRASE_CHARS_MAX,
  WAKE_PHRASE_WORDS_MAX,
  WAKE_PHRASES_MAX,
  WAKE_TOKEN,
  wakeWords
} from "@pva/protocol"

/**
 * The profile form of admin (Front ends › kind, Devices › device; docs/FRONTENDS-AND-ACTIVATION.md §5), as pure
 * functions: the groups and labels, how an inherited value is shown, a draft of overrides and the patch it saves
 * (`null` = inherit again), and the wake-phrase checks (the protocol's bounds, so the server accepts what passes).
 */

export interface ProfileGroup {
  readonly id: string
  readonly title: string
  readonly fields: ReadonlyArray<ProfileField>
  /** Collapsed under "Advanced". */
  readonly advanced?: boolean
}

export const PROFILE_GROUPS: ReadonlyArray<ProfileGroup> = [
  { id: "activation", title: "Activation", fields: ["activation", "wakePhrases", "wakeMatch", "followUpSeconds"] },
  { id: "voice", title: "Voice", fields: ["voice"] },
  { id: "interrupting", title: "Interrupting", fields: ["interruptMode"] },
  { id: "conversation", title: "Conversation", fields: ["conversationIdleMinutes"] },
  { id: "processing", title: "Audio processing", fields: ["echoCancellation", "noiseSuppression", "autoGainControl"] },
  { id: "display", title: "Display", fields: ["captions", "speakReplies"] },
  { id: "advanced", title: "Advanced", fields: ["outputPath", "prebufferMs"], advanced: true }
]

export const FIELD_LABEL: { readonly [F in ProfileField]: string } = {
  activation: "Activation",
  wakePhrases: "Wake phrases",
  wakeMatch: "Matching",
  followUpSeconds: "Keep listening after a reply",
  voice: "Voice",
  interruptMode: "Interrupting",
  conversationIdleMinutes: "Start a new conversation after",
  captions: "Captions",
  speakReplies: "Speak replies to typed messages",
  echoCancellation: "Echo cancellation",
  noiseSuppression: "Noise suppression",
  autoGainControl: "Automatic gain",
  outputPath: "Output path",
  prebufferMs: "Prebuffer"
}

export const INTERRUPT_CHOICES = [
  { value: "instant", short: "Instant", label: "Instant (headphones)", help: "Any speech interrupts the reply at once. For headphones, or a device whose echo test passes." },
  { value: "confirm", short: "A few words", label: "After a few words (speakers)", help: "Speech interrupts once two words are heard that are not the assistant's own voice." },
  { value: "manual", short: "Stop only", label: "Stop button only", help: "The microphone is held back while the assistant speaks; only Stop interrupts." }
] as const

const onOff = (v: boolean) => (v ? "On" : "Off")

/** A value as one short phrase ("Wake phrase", "3 phrases", "8 s", "Assistant default"). */
export const displayProfileValue = <F extends ProfileField>(field: F, value: DeviceProfile[F]): string => {
  switch (field) {
    case "activation":
      return value === "always" ? "Always listening" : "Wake phrase"
    case "wakePhrases": {
      const list = value as ReadonlyArray<string>
      return list.length === 1 ? `“${list[0]}”` : `${list.length} phrases`
    }
    case "wakeMatch":
      return value === "exact" ? "Exact" : "Close"
    case "followUpSeconds":
      return value === 0 ? "Off" : `${String(value)} s`
    case "voice":
      return value === "" ? "Assistant default" : String(value)
    case "interruptMode":
      return INTERRUPT_CHOICES.find((c) => c.value === value)?.short ?? String(value)
    case "outputPath":
      return value === "direct" ? "Direct" : "Media element"
    case "prebufferMs":
      return `${String(value)} ms`
    case "conversationIdleMinutes":
      return value === 0 ? "Never" : `${String(value)} min`
    default:
      return onOff(value as boolean)
  }
}

/** How a device activates, for the device list: "Always listening" or "Wake phrase · “hey jeff” +2". */
export const activationSummary = (profile: DeviceProfile): string => {
  if (profile.activation === "always") return "Always listening"
  const [first, ...rest] = profile.wakePhrases
  return `Wake phrase · “${first ?? ""}”${rest.length > 0 ? ` +${rest.length}` : ""}`
}

const sameValue = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b

export const overridesEqual = (a: ProfileOverrides, b: ProfileOverrides, fields: ReadonlyArray<ProfileField>): boolean =>
  fields.every((f) => Object.hasOwn(a, f) === Object.hasOwn(b, f) && sameValue(a[f], b[f]))

/** The patch that turns `saved` into `draft`, for the fields shown: changed values, and `null` for each reset. */
export const draftPatch = (saved: ProfileOverrides, draft: ProfileOverrides, fields: ReadonlyArray<ProfileField>): ProfilePatch => {
  const patch: Record<string, unknown> = {}
  for (const f of fields) {
    const inDraft = Object.hasOwn(draft, f)
    const inSaved = Object.hasOwn(saved, f)
    if (inDraft && (!inSaved || !sameValue(draft[f], saved[f]))) patch[f] = draft[f]
    else if (!inDraft && inSaved) patch[f] = null
  }
  return patch as ProfilePatch
}

/** Set an override (a copy). */
export const setOverride = <F extends ProfileField>(draft: ProfileOverrides, field: F, value: DeviceProfile[F]): ProfileOverrides =>
  ({ ...draft, [field]: value }) as ProfileOverrides

/** Remove an override: the field inherits again (a copy). */
export const clearOverride = (draft: ProfileOverrides, field: ProfileField): ProfileOverrides => {
  const next: Record<string, unknown> = { ...draft }
  delete next[field]
  return next as ProfileOverrides
}

/** The effective value of a field: the draft's override, else the inherited one. */
export const effectiveValue = <F extends ProfileField>(draft: ProfileOverrides, base: DeviceProfile, field: F): DeviceProfile[F] =>
  (Object.hasOwn(draft, field) ? draft[field] : base[field]) as DeviceProfile[F]

/** A phrase as stored: its words, normalised and joined by one space ("Hey, Jeff!" → "hey jeff"). */
export const normalisePhrase = (text: string): string => wakeWords(text).join(" ")

/** What is wrong with adding `text` to `phrases`, if anything (the protocol's bounds, and no duplicates). */
export const phraseProblem = (text: string, phrases: ReadonlyArray<string>): string | undefined => {
  const words = wakeWords(text)
  if (words.length === 0) return "Type a phrase, for example “hey jeff”."
  if (words.length > WAKE_PHRASE_WORDS_MAX) return `Use at most ${WAKE_PHRASE_WORDS_MAX} words.`
  if (text.trim().length > WAKE_PHRASE_CHARS_MAX) return `Use at most ${WAKE_PHRASE_CHARS_MAX} characters.`
  const normal = words.join(" ")
  if (phrases.some((p) => normalisePhrase(p) === normal)) return "That phrase is already in the list."
  if (phrases.length >= WAKE_PHRASES_MAX) return `At most ${WAKE_PHRASES_MAX} phrases.`
  return undefined
}

/**
 * The phrase to add from a line the tester ignored ("Hey go, what's the time?"): its first words, as many as the
 * longest phrase in the list has (two for "hey jeff"), so a mishearing of the phrase becomes a phrase of its own.
 */
export const phraseFromHeard = (text: string, phrases: ReadonlyArray<string>): string => {
  const words = (text.match(WAKE_TOKEN) ?? []).map((w) => w.toLowerCase())
  const n = Math.max(1, Math.min(WAKE_PHRASE_WORDS_MAX, ...phrases.map((p) => wakeWords(p).length)))
  return words.slice(0, n).join(" ")
}

/** "now" while connected, else "5 min ago", "3 h ago", "2 days ago", or the date. */
export const lastSeenText = (device: Pick<DeviceInfo, "lastSeen" | "connections">, now: number): string => {
  if (device.connections > 0) return "Connected now"
  const s = Math.max(0, Math.round((now - device.lastSeen) / 1000))
  if (s < 60) return "Seen just now"
  const m = Math.round(s / 60)
  if (m < 60) return `Seen ${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `Seen ${h} h ago`
  const d = Math.round(h / 24)
  if (d < 14) return `Seen ${d} day${d === 1 ? "" : "s"} ago`
  return `Seen ${new Date(device.lastSeen).toLocaleDateString()}`
}
