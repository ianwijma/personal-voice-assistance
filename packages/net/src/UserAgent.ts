/** The product token of our requests. */
export const productToken = "personal-voice-assistance"

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)

/**
 * The `User-Agent` for public APIs that ask who is calling (Nominatim, Open-Meteo, MET Norway, OSM, …):
 * `personal-voice-assistance/1 (you@example.com)`. `contact` is the household's API contact (the Home section's
 * `HOME_API_CONTACT`); empty or blank leaves it out, with no empty parentheses: `personal-voice-assistance/1`.
 * Control characters and brackets are stripped so a setting cannot break the header.
 */
export const userAgent = (contact: string | undefined, product: string = productToken, version = "1"): string => {
  const token = `${clean(product).replace(/[\s/]/g, "-") || productToken}/${clean(version).replace(/\s/g, "") || "1"}`
  const who = contact === undefined ? "" : clean(contact)
  return who === "" ? token : `${token} (${who})`
}
