import type { Secrets } from "./redact.ts"

/**
 * The configured secrets (the token, the secret parts of the address) in every form a successful answer of Home
 * Assistant could carry them in: as written, percent-encoded, base64 (padded or not) and base64url (padded or not).
 * Successful content is compared with these as decoded text (every key and string leaf, after `JSON.parse`), so an
 * escaped quote in the answer is no disguise; a match drops the record or cuts the answer, and nothing is rewritten.
 */
export const secretForms = (secrets: Secrets): ReadonlyArray<string> => {
  const out = new Set<string>()
  for (const s of secrets) {
    if (typeof s !== "string" || s.length === 0) continue
    const b64 = Buffer.from(s, "utf8").toString("base64")
    const url = b64.replace(/\+/g, "-").replace(/\//g, "_")
    for (const form of [s, encodeURIComponent(s), b64, b64.replace(/=+$/, ""), url, url.replace(/=+$/, "")]) if (form.length > 0) out.add(form)
  }
  return [...out]
}

/** The longest form: how much more than a bound a text must keep for a form that starts inside the bound to be seen whole. */
export const longestForm = (forms: ReadonlyArray<string>): number => Math.max(0, ...forms.map((f) => f.length))

/** Whether a decoded value holds a form: any string leaf or key, at any depth (bounded by the answer's own size). */
export const holdsForm = (forms: ReadonlyArray<string>, value: unknown): boolean => {
  if (forms.length === 0) return false
  if (typeof value === "string") return forms.some((f) => value.includes(f))
  if (Array.isArray(value)) return value.some((v) => holdsForm(forms, v))
  if (typeof value === "object" && value !== null) return Object.entries(value).some(([k, v]) => holdsForm(forms, k) || holdsForm(forms, v))
  return false
}
