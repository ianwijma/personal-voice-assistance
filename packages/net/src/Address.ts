/**
 * Which kind of address an IP address is, so `safeFetch` can refuse the ones that are not on the public internet.
 * Pure: parses IPv4 and IPv6 text itself (no `net` module, no resolution), including IPv4-mapped IPv6.
 */

export type AddressClass =
  | "public"
  | "unspecified"
  | "loopback"
  | "private"
  | "link-local"
  | "carrier-grade-nat"
  | "unique-local"
  | "multicast"
  | "broadcast"
  | "documentation"
  | "reserved"

/** Parse dotted-quad IPv4 (four decimal parts, each 0–255, no leading zeros beyond "0"). */
export const parseIPv4 = (text: string): ReadonlyArray<number> | undefined => {
  const parts = text.split(".")
  if (parts.length !== 4) return undefined
  const out: Array<number> = []
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return undefined
    const n = Number(p)
    if (n > 255) return undefined
    out.push(n)
  }
  return out
}

/** Parse IPv6 text into eight 16-bit groups. Accepts `::`, an embedded IPv4 tail and a `%zone` suffix. */
export const parseIPv6 = (input: string): ReadonlyArray<number> | undefined => {
  let text = input
  const zone = text.indexOf("%")
  if (zone >= 0) text = text.slice(0, zone)
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(":")) return undefined
  const dbl = text.indexOf("::")
  if (dbl >= 0 && text.indexOf("::", dbl + 1) >= 0) return undefined
  const side = (s: string): Array<number> | undefined => {
    if (s === "") return []
    const groups: Array<number> = []
    const parts = s.split(":")
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!
      if (i === parts.length - 1 && p.includes(".")) {
        const v4 = parseIPv4(p)
        if (v4 === undefined) return undefined
        groups.push(v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!)
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return undefined
        groups.push(parseInt(p, 16))
      }
    }
    return groups
  }
  if (dbl < 0) {
    const all = side(text)
    return all !== undefined && all.length === 8 ? all : undefined
  }
  const head = side(text.slice(0, dbl))
  const tail = side(text.slice(dbl + 2))
  if (head === undefined || tail === undefined) return undefined
  const fill = 8 - head.length - tail.length
  if (fill < 1) return undefined
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

export const classifyIPv4 = (o: ReadonlyArray<number>): AddressClass => {
  const [a, b, c] = [o[0]!, o[1]!, o[2]!]
  if (a === 0) return "unspecified"
  if (a === 10) return "private"
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade-nat"
  if (a === 127) return "loopback"
  if (a === 169 && b === 254) return "link-local"
  if (a === 172 && b >= 16 && b <= 31) return "private"
  if (a === 192 && b === 0 && c === 0) return "reserved"
  if (a === 192 && b === 0 && c === 2) return "documentation"
  if (a === 192 && b === 88 && c === 99) return "reserved"
  if (a === 192 && b === 168) return "private"
  if (a === 198 && (b === 18 || b === 19)) return "reserved"
  if (a === 198 && b === 51 && c === 100) return "documentation"
  if (a === 203 && b === 0 && c === 113) return "documentation"
  if (a >= 224 && a <= 239) return "multicast"
  if (o[0] === 255 && o[1] === 255 && o[2] === 255 && o[3] === 255) return "broadcast"
  if (a >= 240) return "reserved"
  return "public"
}

const embeddedV4 = (g: ReadonlyArray<number>, at: number): Array<number> => [g[at]! >> 8, g[at]! & 255, g[at + 1]! >> 8, g[at + 1]! & 255]

export const classifyIPv6 = (g: ReadonlyArray<number>): AddressClass => {
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)
  if (allZero(0, 7) && g[7] === 0) return "unspecified"
  if (allZero(0, 7) && g[7] === 1) return "loopback"
  // IPv4-mapped (::ffff:a.b.c.d): the IPv4 rules decide.
  if (allZero(0, 5) && g[5] === 0xffff) return classifyIPv4(embeddedV4(g, 6))
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address: it must be public too.
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return classifyIPv4(embeddedV4(g, 6))
  if (g[0] === 0x2002) return classifyIPv4(embeddedV4(g, 1))
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique-local"
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local"
  if ((g[0]! & 0xffc0) === 0xfec0) return "private" // deprecated site-local
  if ((g[0]! & 0xff00) === 0xff00) return "multicast"
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation"
  // Global unicast is 2000::/3; everything else (::/8 incl. IPv4-compatible, Teredo, discard, …) is reserved.
  if ((g[0]! & 0xe000) !== 0x2000) return "reserved"
  if (g[0] === 0x2001 && g[1]! < 0x200) return "reserved" // 2001::/23 protocol assignments (Teredo included)
  return "public"
}

export interface ParsedAddress {
  readonly family: 4 | 6
  readonly class: AddressClass
}

/** Classify an IP address given as text; `undefined` when the text is not an IP address at all. */
export const classifyAddress = (text: string): ParsedAddress | undefined => {
  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text
  const v4 = parseIPv4(bare)
  if (v4 !== undefined) return { family: 4, class: classifyIPv4(v4) }
  const v6 = parseIPv6(bare)
  if (v6 !== undefined) return { family: 6, class: classifyIPv6(v6) }
  return undefined
}
