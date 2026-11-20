/** The product token of our requests. */
export const productToken = "personal-voice-assistance"

/**
 * Text that can stand in a header comment: control characters, brackets and backslashes become spaces, and every character outside
 * printable ASCII is percent-encoded as UTF-8 ("https://example.com/联系" → "https://example.com/%E8%81%94%E7%B3%BB"), so the value is
 * one Node accepts for any input (review round 1, finding 26). At most 200 characters, cut before a broken escape.
 */
const clean = (s: string): string => {
  const spaced = s.replace(/[\u0000-\u001f\u007f()\\]/g, " ").replace(/\s+/g, " ").trim()
  let out = ""
  for (const ch of spaced) {
    const part = /^[\x20-\x7e]$/.test(ch) ? ch : [...new TextEncoder().encode(ch)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("")
    if (out.length + part.length > 200) break
    out += part
  }
  return out.trim()
}

/** A character a header value cannot hold (anything outside printable ASCII, space and tab), for checking settings as they are saved. */
export const headerUnsafe = (s: string): boolean => /[^\t\x20-\x7e]/.test(s)

/**
 * The `User-Agent` for public APIs that ask who is calling (Nominatim, Open-Meteo, MET Norway, OSM, …):
 * `personal-voice-assistance/1 (you@example.com)`. `contact` is the household's API contact (the Home section's
 * `HOME_API_CONTACT`); empty or blank leaves it out, with no empty parentheses: `personal-voice-assistance/1`.
 * Whatever it is given, the result is a legal header value: control characters and brackets are stripped and anything outside ASCII
 * is percent-encoded.
 */
export const userAgent = (contact: string | undefined, product: string = productToken, version = "1"): string => {
  const asToken = (s: string, fallback: string) => clean(String(s)).replace(/[^!#$%&'*+\-.^_`|~0-9A-Za-z ]/g, "").replace(/\s+/g, "-").replace(/^-+|-+$/g, "") || fallback
  const token = `${asToken(product, productToken)}/${clean(String(version)).replace(/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/g, "") || "1"}`
  const who = typeof contact === "string" ? clean(contact) : ""
  return who === "" ? token : `${token} (${who})`
}
