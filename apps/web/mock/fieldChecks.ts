/**
 * The real server's checks of single field values that the mock repeats on a save (review round 3 of P2, finding 8): a choice
 * must be one of its options, a text no longer than its `maxLength`, and the Home section's own checks
 * (`apps/assistant/src/serve/sectionDefinitions.ts`: `checkTimeZone`, `checkCurrency`, `checkApiContact`). A save with any of these
 * errors is refused before anything is applied, so the previous values stay. Only the household fields (`HOME_…`) are checked here:
 * other sections' choices may have options the mock fills elsewhere.
 */
interface CheckedField {
  readonly key: string
  readonly type: string
  readonly options?: ReadonlyArray<{ readonly value: string }>
  readonly maxLength?: number
}

const ianaZoneName = /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/

const checkTimeZone = (zone: string): string | undefined => {
  const trimmed = zone.trim()
  if (trimmed === "") return undefined
  const refusal = "Unknown time zone (use an IANA name such as Europe/Amsterdam, not an offset)"
  if (!ianaZoneName.test(trimmed)) return refusal
  try {
    const resolved = new Intl.DateTimeFormat("en", { timeZone: trimmed }).resolvedOptions().timeZone
    return ianaZoneName.test(resolved) ? undefined : refusal
  } catch {
    return refusal
  }
}

/** The per-key checks of the Home section, as the real server has them. */
const homeChecks: Readonly<Record<string, (value: string) => string | undefined>> = {
  HOME_TIME_ZONE: checkTimeZone,
  HOME_CURRENCY: (code) => (/^[A-Z]{3}$/.test(code) ? undefined : "Use a three-letter currency code in capitals, e.g. EUR"),
  HOME_API_CONTACT: (contact) =>
    /^[\x20-\x7e]*$/.test(contact)
      ? undefined
      : "Use plain ASCII letters, digits and punctuation only: this goes in an HTTP header. Write an internationalised address in its ASCII form (xn--…, or %-encoded)"
}

/** The message for one value of one field, or `undefined` when the real server would accept it. `null` (back to the default) is always accepted. */
export const fieldValueError = (field: CheckedField, value: unknown): string | undefined => {
  if (value === null || !field.key.startsWith("HOME_")) return undefined
  if (field.type === "choice") {
    if (typeof value !== "string" || !(field.options ?? []).some((o) => o.value === value)) return "Choose one of the options."
  }
  if (field.type === "text") {
    if (typeof value !== "string") return "Must be text."
    if (field.maxLength !== undefined && value.length > field.maxLength) return `At most ${field.maxLength} characters.`
    const own = homeChecks[field.key]
    if (own !== undefined) return own(value)
  }
  return undefined
}
