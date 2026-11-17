import { describe, expect, it } from "@effect/vitest"
import { classifyAddress } from "../src/Address.ts"

const cases: ReadonlyArray<readonly [string, string]> = [
  ["8.8.8.8", "public"], ["1.1.1.1", "public"], ["93.184.216.34", "public"], ["172.15.0.1", "public"], ["172.32.0.1", "public"],
  ["0.0.0.0", "unspecified"], ["0.1.2.3", "unspecified"],
  ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback"],
  ["10.0.0.1", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.1.1", "private"],
  ["169.254.169.254", "link-local"], ["169.254.0.1", "link-local"],
  ["100.64.0.1", "carrier-grade-nat"], ["100.127.255.255", "carrier-grade-nat"], ["100.128.0.1", "public"],
  ["224.0.0.1", "multicast"], ["239.255.255.255", "multicast"],
  ["255.255.255.255", "broadcast"], ["240.0.0.1", "reserved"],
  ["192.0.2.1", "documentation"], ["198.51.100.7", "documentation"], ["203.0.113.9", "documentation"],
  ["198.18.0.1", "reserved"],
  ["::", "unspecified"], ["::1", "loopback"], ["0:0:0:0:0:0:0:1", "loopback"],
  ["fc00::1", "unique-local"], ["fd12:3456::1", "unique-local"],
  ["fe80::1", "link-local"], ["fe80::1%eth0", "link-local"], ["febf::1", "link-local"],
  ["ff02::1", "multicast"],
  ["2001:db8::1", "documentation"],
  ["2606:4700:4700::1111", "public"], ["2a00:1450:4001:81b::200e", "public"],
  // IPv4-mapped, in every spelling.
  ["::ffff:127.0.0.1", "loopback"], ["::ffff:7f00:1", "loopback"], ["::ffff:10.1.2.3", "private"], ["::ffff:a01:203", "private"],
  ["::ffff:169.254.169.254", "link-local"], ["::ffff:8.8.8.8", "public"], ["0:0:0:0:0:ffff:192.168.0.1", "private"],
  // NAT64 and 6to4 carry an IPv4 address.
  ["64:ff9b::7f00:1", "loopback"], ["64:ff9b::808:808", "public"], ["2002:c0a8:101::1", "private"], ["2002:808:808::", "public"],
  // IPv4-compatible and Teredo are reserved.
  ["::7f00:1", "reserved"], ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "reserved"], ["100::1", "reserved"],
  ["[::1]", "loopback"]
]

describe("classifyAddress", () => {
  for (const [address, expected] of cases) it(`${address} is ${expected}`, () => expect(classifyAddress(address)?.class).toBe(expected))

  it("knows IPv4 from IPv6", () => {
    expect(classifyAddress("1.2.3.4")?.family).toBe(4)
    expect(classifyAddress("::ffff:1.2.3.4")?.family).toBe(6)
  })
  for (const bad of ["example.com", "", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1::2::3", "12345::1", "::g", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::8"])
    it(`"${bad}" is not an address`, () => expect(classifyAddress(bad)).toBeUndefined())
})
