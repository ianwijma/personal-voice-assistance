import { Stream } from "effect"

/**
 * Voice markers: the model picks a voice by starting its reply (or a later
 * clause) with `[voice:NAME]`. These helpers are pure string functions shared
 * by the clause chunker (keep a marker in one piece), the voice router (switch
 * voice, strip the marker) and display code (never show a marker to the user).
 */

const leading = /^\s*\[voice:\s*([a-z0-9_-]*)\s*\]\s*/i
const anywhere = /\[voice:\s*[a-z0-9_-]*\s*\]\s*/gi
/** A `[voice:NAME` that has not been closed yet (or any prefix of `[voice:`). */
const unfinished = /^\[(?:v(?:o(?:i(?:c(?:e(?::\s*[a-z0-9_-]*\s*)?)?)?)?)?)?$/i

/** The marker syntax for `name`. */
export const voiceMarker = (name: string): string => `[voice:${name}]`

/** The voice named by a marker at the start of `clause` (lower-cased), and the clause without any marker. */
export const parseVoiceMarker = (clause: string): { readonly voice: string | undefined; readonly text: string } => {
  const match = leading.exec(clause)
  const rest = match === null ? clause : clause.slice(match[0].length)
  return { voice: match?.[1]?.toLowerCase(), text: stripVoiceMarkers(rest).trim() }
}

/** `text` with every marker (and the whitespace after it) removed. */
export const stripVoiceMarkers = (text: string): string => text.includes("[") ? text.replace(anywhere, "") : text

/** Length of a complete marker (with surrounding whitespace) at the start of `text`, else 0. */
export const leadingMarkerLength = (text: string): number => leading.exec(text)?.[0].length ?? 0

/** `text` (leading whitespace ignored) could still become a marker: `[`, `[vo`, `[voice: exp`, ... */
export const isUnfinishedMarker = (text: string): boolean => {
  const t = text.trimStart()
  return t.startsWith("[") && unfinished.test(t)
}

/**
 * Removes markers from a stream of text deltas (a marker may be split across
 * deltas). Text is held back only while it could be the start of a marker, so
 * ordinary text passes through unchanged and undelayed.
 */
export const stripVoiceMarkersStream = <E, R>(self: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
  Stream.mapAccum(
    self,
    () => ({ pending: "", trimNext: false }),
    (state, delta): readonly [{ pending: string; trimNext: boolean }, ReadonlyArray<string>] => {
      let text = state.pending + delta
      if (state.trimNext) text = text.trimStart()
      const stripped = stripVoiceMarkers(text)
      // A marker at the very end: the space after it may arrive in the next delta.
      const trimNext = endsWithMarker(text)
      const open = stripped.lastIndexOf("[")
      if (open >= 0 && isUnfinishedMarker(stripped.slice(open))) {
        const out = stripped.slice(0, open)
        return [{ pending: stripped.slice(open), trimNext: false }, out.length > 0 ? [out] : []]
      }
      return [{ pending: "", trimNext: trimNext || (state.trimNext && stripped.length === 0) }, stripped.length > 0 ? [stripped] : []]
    },
    { onHalt: (state) => (state.pending.length > 0 ? [state.pending] : []) }
  )

const endsWithMarker = (text: string) => /\[voice:\s*[a-z0-9_-]*\s*\]$/i.test(text)
