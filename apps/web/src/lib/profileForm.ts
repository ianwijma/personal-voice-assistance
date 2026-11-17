import { type DeviceInfo, WAKE_PHRASE_CHARS_MAX, WAKE_PHRASE_WORDS_MAX, WAKE_PHRASES_MAX, WAKE_TOKEN, wakeWords } from "@pva/protocol"

/**
 * What the device pages share with the phrase tester (docs/ASSISTANTS.md §7.1): the interrupt choices, the wake-phrase
 * checks (the protocol's bounds, so the server accepts what passes) and "Seen 5 min ago". (The old profile form, its
 * groups and its overrides patch went with the Front ends page.)
 */

export const INTERRUPT_CHOICES = [
  { value: "instant", short: "Instant", label: "Instant (headphones)", help: "Speech interrupts the reply at once. Best with headphones." },
  { value: "confirm", short: "A few words", label: "After a few words (speakers)", help: "Speech interrupts once two words are heard that are not the assistant's own voice." },
  { value: "manual", short: "Stop only", label: "Stop button only", help: "Only the stop button interrupts a reply." }
] as const

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
