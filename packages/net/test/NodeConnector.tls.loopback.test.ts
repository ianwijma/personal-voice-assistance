// A real TLS connection on this machine's loopback interface (127.0.0.1 only; no request leaves the machine), with a self-signed
// certificate made here in the test. It shows what only a real handshake shows (review round 2, finding 26): the connector dials
// the address that was checked, while SNI and the certificate are checked against the URL's host name.
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { generateKeyPairSync, sign } from "node:crypto"
import https from "node:https"
import type { AddressInfo } from "node:net"
import type { TLSSocket } from "node:tls"
import { NetFailure } from "../src/Errors.ts"
import { contentTypes, fetchOwnerConfiguredLan, makeNodeConnector } from "../src/SafeFetch.ts"

// ---- a self-signed certificate, DER by hand (RFC 5280), signed with a fresh P-256 key ----------------------------------------------
const length = (n: number): Buffer => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]))
const tlv = (tag: number, ...parts: ReadonlyArray<Buffer>): Buffer => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), length(body.length), body]) }
const seq = (...p: ReadonlyArray<Buffer>) => tlv(0x30, ...p)
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split(".").map(Number)
  const out = [a! * 40 + b!]
  for (const n of rest) {
    const bytes = [n & 0x7f]
    for (let v = n >> 7; v > 0; v >>= 7) bytes.unshift((v & 0x7f) | 0x80)
    out.push(...bytes)
  }
  return tlv(0x06, Buffer.from(out))
}
const utcTime = (d: Date): Buffer => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"))
const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"))

const selfSigned = (dnsName: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const name = seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("pva loopback test")))))
  const now = Date.now()
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, Buffer.from([0x01, 0x23, 0x45, 0x67])),
    ecdsaSha256,
    name,
    seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, seq(
      seq(oid("2.5.29.17"), tlv(0x04, seq(tlv(0x82, Buffer.from(dnsName))))), // subjectAltName: dNSName
      seq(oid("2.5.29.19"), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))) // basicConstraints: CA
    ))
  )
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, privateKey)])))
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`
  return { cert, key: privateKey.export({ type: "pkcs8", format: "pem" }) as string }
}

const { cert, key } = selfSigned("pretend.example")

const serve = async () => {
  const seen: Array<{ servername: string | false | null | undefined; host: string | undefined; remote: string | undefined }> = []
  const server = https.createServer({ cert, key }, (req, res) => {
    seen.push({ servername: (req.socket as TLSSocket).servername, host: req.headers.host, remote: req.socket.remoteAddress })
    res.setHeader("Content-Type", "text/plain")
    res.end("secret")
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return { port: (server.address() as AddressInfo).port, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}
const options = (ca: string | undefined) => ({
  accept: contentTypes.webPage,
  // The name never resolves; whatever the resolver said, the test dials loopback, as the checked address.
  resolver: async () => ["192.168.0.1"],
  connector: (r: Parameters<ReturnType<typeof makeNodeConnector>>[0]) => makeNodeConnector(ca === undefined ? {} : { ca })({ ...r, address: "127.0.0.1" })
})
const failure = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (!Exit.isFailure(exit)) throw new Error("expected a failure")
  return exit.cause.reasons.map((r) => (r._tag === "Fail" ? r.error : undefined)).find((e) => e !== undefined) as NetFailure
}

describe("nodeConnector over real TLS (loopback only)", () => {
  it("connects to the checked address; SNI, Host and the certificate check use the URL's host", async () => {
    const s = await serve()
    try {
      const res = await Effect.runPromise(fetchOwnerConfiguredLan(`https://pretend.example:${s.port}/`, options(cert)))
      expect(res.text()).toBe("secret")
      expect(s.seen).toEqual([{ servername: "pretend.example", host: `pretend.example:${s.port}`, remote: "127.0.0.1" }])
    } finally { await s.close() }
  })
  it("a certificate for another name is refused, though the address is the same", async () => {
    const s = await serve()
    try {
      const error = await failure(fetchOwnerConfiguredLan(`https://other.example:${s.port}/`, options(cert)))
      expect(error).toBeInstanceOf(NetFailure)
      expect(error.stage).toBe("connect")
      expect(error.detail).toMatch(/other\.example|altnames|Hostname/i)
      expect(s.seen).toEqual([])
    } finally { await s.close() }
  })
  it("a certificate no trusted authority signed is refused", async () => {
    const s = await serve()
    try {
      const error = await failure(fetchOwnerConfiguredLan(`https://pretend.example:${s.port}/`, options(undefined)))
      expect(error).toBeInstanceOf(NetFailure)
      expect(error.detail).toMatch(/self[- ]signed|certificate/i)
      expect(s.seen).toEqual([])
    } finally { await s.close() }
  })
  it("an IP-literal URL is checked against that IP, which this certificate does not name", async () => {
    const s = await serve()
    try {
      const response = makeNodeConnector({ ca: cert })({ url: new URL(`https://127.0.0.1:${s.port}/`), address: "127.0.0.1", method: "GET", headers: {}, signal: new AbortController().signal })
      await expect(response).rejects.toThrow(/IP|127\.0\.0\.1|altnames/i)
      expect(s.seen).toEqual([])
    } finally { await s.close() }
  })
})
