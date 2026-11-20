import type { HostView } from "@pva/core"
import { Schema } from "effect"
import type { Language } from "./common.ts"

/**
 * Two small helpers every module uses, so twenty modules do the same thing the same way (docs/MODULES.md,
 * "Speaking" and "Storing data").
 */

// ---------------------------------------------------------------------------------------------------------------------
// Spoken texts in English and Dutch

/**
 * A module's fixed sentences in both languages, keyed alike: `{ en: { done: "Added {item}." }, nl: { done: "{item}
 * staat erop." } }`. Placeholders are `{name}`. `checkModule(definition, { texts })` (`@pva/core/testing`) checks that
 * both languages have the same keys and the same placeholders and that no text is empty.
 */
export interface Texts<K extends string> {
  readonly en: { readonly [key in K]: string }
  readonly nl: { readonly [key in K]: string }
}

export const defineTexts = <const K extends string>(texts: Texts<K>): Texts<K> => texts

/** The household's language from the Home section (`HOME_LANGUAGE`: `nl-…` is Dutch, anything else English). */
export const homeLanguage = (view: Pick<HostView, "home">): Language => {
  const value = view.home.HOME_LANGUAGE
  return typeof value === "string" && value.toLowerCase().startsWith("nl") ? "nl" : "en"
}

/** One text in `language`, its placeholders filled; a placeholder without a value stays as written. */
export const say = <K extends string>(
  texts: Texts<K>,
  language: Language,
  key: K,
  values: Readonly<Record<string, string | number>> = {}
): string => texts[language][key].replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole))

// ---------------------------------------------------------------------------------------------------------------------
// Stored text

/**
 * The characters `StoredText` refuses: control characters other than tab, line feed, carriage return, backspace and
 * form feed, and lone surrogates. What is left costs at most two characters of JSON each (`"`, `\`, `\n` are escaped
 * with one backslash), so a stored text of `n` characters takes at most `2n + 2` of a collection's `maxChars`.
 * `checkModule` recognises this exact pattern; the test kit keeps the same text (`STORED_TEXT_PATTERN_SOURCE` in
 * `@pva/core/testing`, compared by a test).
 */
export const STORED_TEXT_PATTERN = /^[^\u0000-\u0007\u000b\u000e-\u001f\ud800-\udfff]*$/u

/**
 * A string schema for text a module stores: at most `maxLength` UTF-16 units, without the characters above. Use it
 * for every free text field of a collection's schema, so `checkModule` can prove the collection's worst legal value
 * fits its `maxChars` (a plain `Schema.String` with a maximum counts six characters of JSON per character, the
 * worst JSON has; one without a maximum cannot fit at all).
 */
export const StoredText = (maxLength: number) =>
  Schema.String.check(Schema.isMaxLength(maxLength), Schema.isPattern(STORED_TEXT_PATTERN))
