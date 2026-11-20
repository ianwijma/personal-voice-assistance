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

/**
 * IPv4, from the IANA IPv4 Special-Purpose Address Registry
 * (https://www.iana.org/assignments/iana-ipv4-special-registry/, RFC 6890 and the RFCs it lists) and the multicast space
 * (https://www.iana.org/assignments/multicast-addresses/). Every block the registry does not mark "globally reachable" is refused;
 * so is all of 192.0.0.0/24, although two anycast addresses in it (192.0.0.9 PCP, 192.0.0.10 TURN) are global, because no web page
 * lives there. The registry's globally reachable blocks 192.31.196.0/24 and 192.175.48.0/24 (AS112) and 192.52.193.0/24 (AMT) stay
 * public. Review round 1, finding 2: the list is the registry, not patched entry by entry.
 */
export const classifyIPv4 = (o: ReadonlyArray<number>): AddressClass => {
  const [a, b, c] = [o[0]!, o[1]!, o[2]!]
  if (a === 0) return "unspecified" // 0.0.0.0/8 "this network" (RFC 791), 0.0.0.0/32 "this host"
  if (a === 10) return "private" // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade-nat" // 100.64.0.0/10 shared address space (RFC 6598)
  if (a === 127) return "loopback" // 127.0.0.0/8 (RFC 1122)
  if (a === 169 && b === 254) return "link-local" // 169.254.0.0/16 (RFC 3927), cloud metadata included
  if (a === 172 && b >= 16 && b <= 31) return "private" // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 0 && c === 0) return "reserved" // 192.0.0.0/24 IETF protocol assignments (RFC 6890): DS-Lite, NAT64 discovery, …
  if (a === 192 && b === 0 && c === 2) return "documentation" // 192.0.2.0/24 TEST-NET-1 (RFC 5737)
  if (a === 192 && b === 88 && c === 99) return "reserved" // 192.88.99.0/24 deprecated 6to4 relay anycast (RFC 7526)
  if (a === 192 && b === 168) return "private" // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return "reserved" // 198.18.0.0/15 benchmarking (RFC 2544)
  if (a === 198 && b === 51 && c === 100) return "documentation" // 198.51.100.0/24 TEST-NET-2 (RFC 5737)
  if (a === 203 && b === 0 && c === 113) return "documentation" // 203.0.113.0/24 TEST-NET-3 (RFC 5737)
  if (a >= 224 && a <= 239) return "multicast" // 224.0.0.0/4 (RFC 5771)
  if (o[0] === 255 && o[1] === 255 && o[2] === 255 && o[3] === 255) return "broadcast" // 255.255.255.255/32 limited broadcast (RFC 919)
  if (a >= 240) return "reserved" // 240.0.0.0/4 reserved (RFC 1112)
  return "public"
}

const embeddedV4 = (g: ReadonlyArray<number>, at: number): Array<number> => [g[at]! >> 8, g[at]! & 255, g[at + 1]! >> 8, g[at + 1]! & 255]

/**
 * IPv6, from the IANA IPv6 Special-Purpose Address Registry (https://www.iana.org/assignments/iana-ipv6-special-registry/, RFC 6890)
 * and the IPv6 Address Space registry (https://www.iana.org/assignments/ipv6-address-space/: only 2000::/3 is global unicast).
 * Forms that carry an IPv4 address (IPv4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16) are judged by that address.
 * All of 2001::/23 (IETF protocol assignments: Teredo, benchmarking, ORCHID, …) is refused, although a few anycast addresses and
 * overlay identifiers in it are global, because no web page lives there. 2620:4f:8000::/48 (AS112) is global and stays public.
 */
export const classifyIPv6 = (g: ReadonlyArray<number>): AddressClass => {
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)
  if (allZero(0, 7) && g[7] === 0) return "unspecified" // ::/128
  if (allZero(0, 7) && g[7] === 1) return "loopback" // ::1/128
  if (allZero(0, 5) && g[5] === 0xffff) return classifyIPv4(embeddedV4(g, 6)) // ::ffff:0:0/96 IPv4-mapped (RFC 4291)
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return classifyIPv4(embeddedV4(g, 6)) // 64:ff9b::/96 NAT64 (RFC 6052)
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return "reserved" // 64:ff9b:1::/48 local-use translation (RFC 8215)
  if (g[0] === 0x2002) return classifyIPv4(embeddedV4(g, 1)) // 2002::/16 6to4 (RFC 3056)
  if (g[0] === 0x0100 && allZero(1, 4)) return "reserved" // 100::/64 discard-only (RFC 6666); 100:0:0:1::/64 dummy prefix (RFC 9780)
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique-local" // fc00::/7 (RFC 4193)
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local" // fe80::/10 (RFC 4291)
  if ((g[0]! & 0xffc0) === 0xfec0) return "private" // fec0::/10 deprecated site-local (RFC 3879)
  if ((g[0]! & 0xff00) === 0xff00) return "multicast" // ff00::/8 (RFC 4291)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation" // 2001:db8::/32 (RFC 3849)
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return "documentation" // 3fff::/20 (RFC 9637)
  if (g[0] === 0x5f00) return "reserved" // 5f00::/16 SRv6 SIDs (RFC 9602)
  // Only 2000::/3 is global unicast; everything else (::/8 incl. IPv4-compatible, 4000::/2, …) is reserved or unassigned.
  if ((g[0]! & 0xe000) !== 0x2000) return "reserved"
  if (g[0] === 0x2001 && g[1]! < 0x200) return "reserved" // 2001::/23 IETF protocol assignments (RFC 2928)
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
