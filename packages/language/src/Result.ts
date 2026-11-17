/** The two languages every function here speaks. */
export type Language = "en" | "nl"

/**
 * What a parser returns: never a throw. `ambiguous` carries every reading so the module can ask
 * ("Do you mean Friday the 20th or the 27th?"); `not-understood` means nothing usable was found.
 */
export type Parsed<T> =
  | { readonly kind: "ok"; readonly value: T; readonly said: string }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<T>; readonly said: string; readonly reason: string }
  | { readonly kind: "not-understood" }

export const notUnderstood: Parsed<never> = { kind: "not-understood" }
export const ok = <T>(value: T, said: string): Parsed<T> => ({ kind: "ok", value, said })
export const ambiguous = <T>(candidates: ReadonlyArray<T>, said: string, reason: string): Parsed<T> => ({ kind: "ambiguous", candidates, said, reason })

/** A calendar date (month 1–12), no time zone. */
export interface LocalDate {
  readonly year: number
  readonly month: number
  readonly day: number
}
/** A wall-clock time. */
export interface ClockTime {
  readonly hour: number
  readonly minute: number
}
export interface LocalDateTime extends LocalDate, ClockTime {}
