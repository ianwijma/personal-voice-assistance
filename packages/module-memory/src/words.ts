// Pure helpers of the memory module: word matching in code (no search engine, no SQL), notebook names, and the guard
// rail that refuses codes and passwords. Everything here is bounded by the argument sizes the callers already limit.
import { isLine } from "@pva/module-contracts"

/** Letters without accents, lower case: "Café" and "cafe" match, "Ä" is "a". For matching only, never for a stored name. */
export const normalise = (text: string): string => text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase()

/** Words too common to look for, English and Dutch: "what did the plumber say about" looks for "plumber". */
const STOP = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "is", "was", "are", "it", "my", "me", "i", "we", "you", "and", "or",
  "what", "who", "when", "where", "did", "do", "does", "say", "said", "tell", "about", "for", "that", "this", "with", "have", "has",
  "de", "het", "een", "van", "in", "op", "aan", "is", "was", "ben", "ik", "mijn", "we", "je", "en", "of", "wat", "wie", "wanneer",
  "waar", "heb", "heeft", "zei", "zeg", "gezegd", "over", "voor", "dat", "dit", "met", "te", "om", "dan", "toch"
])

/** The most meaningful words one query may have: a query with more is refused (it asks for fewer), never shortened. */
export const MAX_QUERY_WORDS = 8
/** The longest query looked at, in characters: the tools allow 100; a longer one (from a typed action) is refused. */
export const MAX_QUERY_CHARS = 200

/**
 * The words a query looks for: normalised, at least two letters, without filler words, each once. `undefined` when
 * the query has more than `MAX_QUERY_WORDS` of them or is longer than `MAX_QUERY_CHARS`: the caller asks for fewer
 * words instead of dropping some, because a weaker query can match, and forget, the wrong item.
 */
export const queryWords = (query: string): ReadonlyArray<string> | undefined => {
  if (query.length > MAX_QUERY_CHARS) return undefined
  const words = Array.from(new Set(normalise(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOP.has(w))))
  return words.length > MAX_QUERY_WORDS ? undefined : words
}

/**
 * A test of a stored text against the words: every word must start a word of the text ("plumb" finds "plumber"). The
 * text is cut to its first 4,000 characters (a note holds at most 1,000), so the work per row is bounded.
 */
export const matcher = (words: ReadonlyArray<string>): ((text: string) => boolean) => (text) => {
  const tokens = normalise(text.slice(0, 4_000)).split(/[^\p{L}\p{N}]+/u)
  return words.every((w) => tokens.some((t) => t.startsWith(w)))
}

/**
 * Whether a text looks like a code, a password or another secret, in English or Dutch. A guard rail, not a guarantee
 * (docs/modules/memory.md): it catches the usual ways of saying one, and a card-number-sized run of digits.
 */
export const looksSecret = (text: string): boolean => {
  const t = normalise(text.slice(0, 4_000))
  if (/\b(pass ?words?|pass ?codes?|pass ?phrases?|wachtwoord\w*|pin ?codes?|pincode\w*|alarm ?codes?|alarmcode\w*|door ?codes?|deurcode\w*|access ?codes?|toegangscode\w*|security ?codes?|beveiligingscode\w*|verification ?codes?|cvv|cvc|api ?keys?|secret ?keys?|private ?keys?|access ?tokens?|bearer)\b/.test(t)) return true
  // "my pin is 4417", "the pin: 1234"
  if (/\bpin\b\s*(is|was|=|:)?\s*\d{3,}/.test(t)) return true
  // "the boiler code is 4417", "code 1234" (a postcode is not a code: `\bcode\b` does not match inside it)
  if (/\bcode\b[^.\n]{0,20}?\d{3,}/.test(t)) return true
  // A card or account number: 13 to 19 digits, spaces or dashes between.
  if (/(?<![\d])(?:\d[ -]?){13,19}(?![\d])/.test(t)) return true
  return false
}

/** Spaces and line breaks of any kind made one space, the ends trimmed. */
export const tidy = (text: string): string => text.replace(/\s+/g, " ").trim()

/** The longest notebook name, in UTF-16 units (as the stored schema counts). */
export const NOTEBOOK_CHARS = 30

/**
 * A notebook's name as it is stored and looked up: one line, single-spaced, composed (NFC, so a name never grows by
 * decomposing), lower case, and at most `NOTEBOOK_CHARS` long, cut between whole code points so a character is never
 * split in two. Accents stay: "café" is its own notebook. `""` when nothing is left; `undefined` when what is left is
 * not a valid name (a control character): the caller refuses it rather than store something else.
 */
export const notebookName = (raw: string): string | undefined => {
  const composed = tidy(raw.slice(0, 400)).normalize("NFC").toLowerCase()
  let name = ""
  for (const ch of composed) {
    if (name.length + ch.length > NOTEBOOK_CHARS) break
    name += ch
  }
  name = name.trim()
  return name === "" || isLine(name, NOTEBOOK_CHARS) ? name : undefined
}

/**
 * One formatter per operation, for the few items an answer carries: epoch ms as a calendar date `YYYY-MM-DD` in a time
 * zone (the household's), for a model to word. An unknown zone falls back to UTC.
 */
export const dateFormatter = (timeZone: string): ((at: number) => string) => {
  try {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    return (at) => f.format(at)
  } catch {
    return (at) => new Date(at).toISOString().slice(0, 10)
  }
}
