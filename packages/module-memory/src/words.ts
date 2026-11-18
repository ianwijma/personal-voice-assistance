// Pure helpers of the memory module: word matching in code (no search engine, no SQL) and the guard rail that
// refuses codes and passwords. Everything here is bounded by the argument sizes the schemas already limit.

/** Letters without accents, lower case: "Café" and "cafe" match, "Ä" is "a". */
export const normalise = (text: string): string => text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase()

/** Words too common to look for, English and Dutch: "what did the plumber say about" looks for "plumber". */
const STOP = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "is", "was", "are", "it", "my", "me", "i", "we", "you", "and", "or",
  "what", "who", "when", "where", "did", "do", "does", "say", "said", "tell", "about", "for", "that", "this", "with", "have", "has",
  "de", "het", "een", "van", "in", "op", "aan", "is", "was", "ben", "ik", "mijn", "we", "je", "en", "of", "wat", "wie", "wanneer",
  "waar", "heb", "heeft", "zei", "zeg", "gezegd", "over", "voor", "dat", "dit", "met", "te", "om", "dan", "toch"
])

/** At most this many words of a query are used, and a query is at most 100 characters (the tools' schemas). */
export const MAX_QUERY_WORDS = 8

/** The words a query looks for: normalised, at least two letters, without filler words, at most `MAX_QUERY_WORDS`. */
export const queryWords = (query: string): ReadonlyArray<string> => {
  const words = normalise(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOP.has(w))
  return Array.from(new Set(words)).slice(0, MAX_QUERY_WORDS)
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

/** Epoch ms as a calendar date `YYYY-MM-DD` in a time zone (the household's), for a model to word. */
export const dateIn = (at: number, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
  } catch {
    return new Date(at).toISOString().slice(0, 10)
  }
}
