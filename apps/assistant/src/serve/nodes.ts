import {
  type DeviceSettings,
  type NodeHello,
  type NodeInfo,
  type NodeManifest,
  type NodePairing,
  type NodePairRequest,
  type NodeStatusBody,
  MAX_DEVICE_NAME_CHARS,
  VOICE_NODE_DEVICE_TYPE,
  VOICE_NODE_KIND,
  WEB_VOICE_KIND
} from "@pva/protocol"
import { Effect } from "effect"
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto"
import type { DeviceRegistry } from "./devices.ts"
import { typeSettingsFrom } from "./devices.ts"
import type { SettingsStore, StoredNode } from "./SettingsStore.ts"

/**
 * Voice nodes on the server (docs/VOICE-NODES.md §3.3, §3.4, §6.1, §6.2): pairing codes, redeeming them
 * (`POST /node/pair`, served by `nodeDist.ts`), the credential check of a node's `hello`, what is known about a node
 * in memory (its last status, transport, running bundle), and the SPKI pin of the server's certificate.
 *
 * Security (the point of this module):
 * - A node device exists only by pairing. Its record holds the SHA-256 of a 32-byte random credential, never the
 *   credential; a hello is checked by comparing digests with `timingSafeEqual`.
 * - A pairing code is 40 random bits (8 Crockford base32 characters), valid `CODE_TTL_MS`, single use (taken out at
 *   the start of a redeem, before anything is awaited), at most `MAX_OUTSTANDING` at once, in memory only.
 * - Wrong codes back off per remote address (after `MAX_WRONG_BEFORE_WAIT` in a row: `FIRST_WAIT_MS`, doubling, at
 *   most `MAX_WAIT_MS`) and in total (`GLOBAL_WRONG_LIMIT` wrong in `GLOBAL_WINDOW_MS`: every redeem, right or
 *   wrong, is refused until the oldest of them is older than the window).
 * - No admin password, no admin, no codes: a redeem says `admin_disabled`.
 *
 * Who is told what (`node.paired`, `devices`, closing a replaced node's connections with 4403) is the hub's: it
 * listens with `onPaired`.
 */

/** A code is valid this long. */
export const CODE_TTL_MS = 10 * 60_000
/** Codes outstanding at once; one more cancels the oldest. */
export const MAX_OUTSTANDING = 3
/** Wrong codes in a row from one address before it has to wait. */
export const MAX_WRONG_BEFORE_WAIT = 5
export const FIRST_WAIT_MS = 30_000
export const MAX_WAIT_MS = 10 * 60_000
/** Wrong codes from all addresses together, within `GLOBAL_WINDOW_MS`, after which every redeem is refused. */
export const GLOBAL_WRONG_LIMIT = 50
export const GLOBAL_WINDOW_MS = 10 * 60_000
/** Addresses remembered for the back-off (the oldest is forgotten past this). */
const MAX_ADDRESSES = 1024
/** A `test-mic` relays levels for its duration plus this. */
export const METER_GRACE_MS = 1_000
export const DEFAULT_TEST_MIC_MS = 10_000

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** 40 random bits as 8 Crockford base32 characters. */
export const makePairCode = (random: (n: number) => Buffer = randomBytes): string => {
  const bytes = random(5)
  let bits = 0n
  for (const b of bytes) bits = (bits << 8n) | BigInt(b)
  let out = ""
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)]
  return out
}

/** A code as someone may type it: upper case, without dashes or spaces, `I`/`L` as 1, `O` as 0 (Crockford). */
export const normaliseCode = (code: string): string =>
  code.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0")

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest()

/** `"sha256:<hex>"` of a PEM certificate's public key (SPKI, DER): what a node and `curl --pinnedpubkey` check. */
export const spkiPin = (pem: string | Buffer): string => {
  const der = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })
  return `sha256:${createHash("sha256").update(der).digest("hex")}`
}

/** `::ffff:192.0.2.1` and `192.0.2.1` are one address. */
const addressKey = (address: string) => (address.startsWith("::ffff:") ? address.slice(7) : address)

export interface PairedEvent {
  readonly code: string
  readonly deviceId: string
  readonly name: string
  /** It replaced the credential of an existing node: its open connections must be closed (4403). */
  readonly replaced: boolean
}

export type RedeemAnswer = { readonly status: number; readonly json: unknown }

export type CreateResult =
  | { readonly ok: true; readonly pairing: NodePairing }
  | { readonly ok: false; readonly error: { readonly code: "admin_required" | "unknown_device"; readonly message: string } }

/** What `hello` decided (`SessionHub.hello`). */
export type HelloCheck =
  | { readonly node: false }
  | { readonly node: true; readonly ok: false; readonly reason: string }
  | { readonly node: true; readonly ok: true; readonly id: string; readonly name: string }

export interface Nodes {
  /** `node.pair.create` (the hub checks admin first). Seeds "Every voice node" once (§3.4) before answering. */
  readonly create: (request: { readonly name?: string | undefined; readonly replace?: string | undefined }) => Effect.Effect<CreateResult>
  /** `node.pair.cancel`. */
  readonly cancel: (code: string) => void
  /** `POST /node/pair` (`nodeDist.ts` parses the body and passes the request's remote address). */
  readonly redeem: (body: NodePairRequest, remoteAddress: string) => Effect.Effect<RedeemAnswer>
  /**
   * The credential check of a voice `hello` (§6.1), before `welcome`. A hello is a node's when its device names a
   * paired node's id, its kind is `voice-node`, it carries `hello.node`, or (without a device) its client id is a
   * paired node's id. A node's must carry the credential whose digest that record holds.
   */
  readonly checkHello: (hello: {
    readonly clientId: string
    readonly device?: { readonly id: string; readonly kind: string } | undefined
    readonly node?: NodeHello | undefined
  }) => HelloCheck
  /** An authenticated node connected: what its hello said that is kept in memory only. */
  readonly connected: (id: string, hello: NodeHello) => void
  /** `node.status` of an authenticated node. `true` when it differs from the last one. */
  readonly setStatus: (id: string, status: NodeStatusBody) => boolean
  /** `devices`' `node` of a paired node. */
  readonly info: (id: string, node: StoredNode) => NodeInfo
  /** A node was removed: forget what memory holds about it. */
  readonly forget: (id: string) => void
  /** `test-mic` was sent to `id`: levels are relayed until then (epoch ms). */
  readonly openMeter: (id: string, durationMs: number | undefined) => void
  /** A `node.level` from `id` is to be relayed now. */
  readonly metering: (id: string) => boolean
  readonly onPaired: (listener: (event: PairedEvent) => void) => void
  /** Where the ids of the devices connected now come from (the hub; nothing connected is evicted for a new node). */
  readonly connectedFrom: (source: () => ReadonlySet<string>) => void
}

export interface NodesOptions {
  readonly store: SettingsStore
  readonly registry: DeviceRegistry
  /** `PVA_ADMIN_PASSWORD` is set: there is an admin, so codes can be made. */
  readonly adminEnabled: boolean
  /** The server itself serves https/wss. */
  readonly tls: boolean
  /** `"sha256:<hex>"` of `SERVE_TLS_CERT`'s SPKI (with `tls`). */
  readonly tlsPin?: string | undefined
  /** `SERVE_HOST` is a loopback address. */
  readonly loopbackOnly: boolean
  /** The manifest of the node bundle the server serves (`nodeDist.manifest()`); `undefined`: not built. */
  readonly manifest: () => NodeManifest | undefined
  /** Default `Date.now` (epoch ms: codes' `expiresAt` goes to pages). */
  readonly now?: () => number
  /** Default `crypto.randomBytes`. */
  readonly random?: (n: number) => Buffer
  readonly log?: (line: string) => void
}

interface Code {
  readonly code: string
  readonly expiresAt: number
  readonly name?: string | undefined
  readonly replace?: string | undefined
}

interface Memory {
  bundleSha256?: string | undefined
  status?: NodeStatusBody | undefined
  meterUntil: number
}

interface Backoff {
  wrong: number
  until: number
}

/**
 * The browsers' effective assistants without their follow-up values and their `matching`, `withoutPhrase: nobody`,
 * everything else built-in (§3.4). `undefined` when the browsers have no assistant (nothing is seeded).
 */
export const seededNodeSettings = (browsers: DeviceSettings): DeviceSettings | undefined => {
  if (browsers.assistants.length === 0) return undefined
  return {
    ...VOICE_NODE_DEVICE_TYPE.builtIn,
    assistants: browsers.assistants.map(({ followUpSeconds: _f, ...rest }) => rest),
    matching: browsers.matching,
    withoutPhrase: { mode: "nobody" }
  }
}

/** `name`, or `name 2`, `name 3`, … so that it is not one of `taken` (case-insensitive), within the name limit. */
const uniqueName = (name: string, taken: ReadonlySet<string>): string => {
  const base = name.trim().slice(0, MAX_DEVICE_NAME_CHARS).trim() || "Voice node"
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`
    const candidate = `${base.slice(0, MAX_DEVICE_NAME_CHARS - suffix.length).trimEnd()}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export const makeNodes = (options: NodesOptions): Nodes => {
  const { store, registry } = options
  const now = options.now ?? Date.now
  const random = options.random ?? randomBytes
  const log = options.log ?? (() => {})
  /** By code, oldest first (Map order). */
  const codes = new Map<string, Code>()
  const memory = new Map<string, Memory>()
  const addresses = new Map<string, Backoff>()
  /** Times of wrong codes within the window, oldest first. */
  let wrongTimes: Array<number> = []
  const listeners: Array<(event: PairedEvent) => void> = []
  let connectedDevices: () => ReadonlySet<string> = () => new Set()

  const memoryOf = (id: string): Memory => {
    let m = memory.get(id)
    if (m === undefined) {
      m = { meterUntil: 0 }
      memory.set(id, m)
    }
    return m
  }

  const prune = (t: number) => {
    // An expired code is kept for one more lifetime, so a late redeem hears "expired" rather than "bad_code".
    for (const [k, c] of codes) if (t >= c.expiresAt + CODE_TTL_MS) codes.delete(k)
    wrongTimes = wrongTimes.filter((w) => t - w < GLOBAL_WINDOW_MS)
  }
  const outstanding = (t: number) => [...codes.values()].filter((c) => t < c.expiresAt)

  const json = (status: number, body: unknown): RedeemAnswer => ({ status, json: body })

  const wrong = (address: string, t: number) => {
    wrongTimes.push(t)
    const b = addresses.get(address) ?? { wrong: 0, until: 0 }
    addresses.delete(address)
    b.wrong++
    if (b.wrong >= MAX_WRONG_BEFORE_WAIT) b.until = t + Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (b.wrong - MAX_WRONG_BEFORE_WAIT))
    addresses.set(address, b)
    while (addresses.size > MAX_ADDRESSES) addresses.delete(addresses.keys().next().value!)
  }

  const seed = Effect.suspend(() => {
    const file = store.settings()
    if (file.deviceTypes[VOICE_NODE_KIND] !== undefined) return Effect.void
    const seeded = seededNodeSettings(typeSettingsFrom(file, WEB_VOICE_KIND))
    if (seeded === undefined) return Effect.void
    return store.saveDeviceType(VOICE_NODE_KIND, 0, seeded).pipe(
      Effect.asVoid,
      Effect.catch((e) => Effect.sync(() => log(`Every voice node was not seeded from the browsers: ${e.message}`)))
    )
  })

  const create: Nodes["create"] = (request) =>
    Effect.suspend(() => {
      if (!options.adminEnabled) {
        return Effect.succeed<CreateResult>({ ok: false, error: { code: "admin_required", message: "Admin is disabled: no pairing code can be made" } })
      }
      if (request.replace !== undefined && registry.nodeOf(request.replace) === undefined) {
        return Effect.succeed<CreateResult>({ ok: false, error: { code: "unknown_device", message: "That device is not a paired voice node" } })
      }
      return Effect.map(seed, (): CreateResult => {
        const t = now()
        prune(t)
        let code = makePairCode(random)
        while (codes.has(code)) code = makePairCode(random)
        const live = outstanding(t)
        // A fourth outstanding code cancels the oldest.
        for (const old of live.slice(0, Math.max(0, live.length - (MAX_OUTSTANDING - 1)))) codes.delete(old.code)
        const entry: Code = {
          code,
          expiresAt: t + CODE_TTL_MS,
          ...(request.name !== undefined ? { name: request.name } : {}),
          ...(request.replace !== undefined ? { replace: request.replace } : {})
        }
        codes.set(code, entry)
        const manifest = options.manifest()
        return {
          ok: true,
          pairing: {
            code,
            expiresAt: entry.expiresAt,
            ...(request.replace !== undefined ? { replace: request.replace } : {}),
            tls: options.tls,
            ...(options.tls && options.tlsPin !== undefined ? { tlsPin: options.tlsPin } : {}),
            loopbackOnly: options.loopbackOnly,
            bundle: manifest === undefined ? null : { version: manifest.version, sha256: manifest.bundle.sha256 }
          }
        }
      })
    })

  const redeem: Nodes["redeem"] = (body, remoteAddress) =>
    Effect.suspend(() => {
      if (!options.adminEnabled) return Effect.succeed(json(503, { error: "admin_disabled" }))
      const t = now()
      prune(t)
      const address = addressKey(remoteAddress)
      const backoff = addresses.get(address)
      const own = backoff !== undefined && backoff.until > t ? backoff.until - t : 0
      const total = wrongTimes.length >= GLOBAL_WRONG_LIMIT ? wrongTimes[wrongTimes.length - GLOBAL_WRONG_LIMIT]! + GLOBAL_WINDOW_MS - t : 0
      const wait = Math.max(own, total)
      if (wait > 0) return Effect.succeed(json(429, { error: "rate_limited", retryAfterMs: Math.ceil(wait) }))
      const code = normaliseCode(body.code)
      const entry = codes.get(code)
      if (entry === undefined) {
        wrong(address, t)
        return Effect.succeed(json(403, { error: "bad_code" }))
      }
      // Single use: taken out before anything is awaited, so two redeems of one code cannot both pass.
      codes.delete(code)
      if (t >= entry.expiresAt) return Effect.succeed(json(403, { error: "expired" }))
      addresses.delete(address)
      const credential = random(32).toString("base64url")
      const node: StoredNode = {
        credentialSha256: sha256(credential).toString("hex"),
        pairedAt: t,
        version: body.version,
        platform: body.platform
      }
      const connected = connectedDevices()
      const fresh = Effect.suspend(() => {
        const id = `vn-${random(12).toString("base64url")}`
        const taken = new Set(Object.values(store.settings().devices).map((d) => d.name.toLowerCase()))
        const name = uniqueName(entry.name ?? body.hostname, taken)
        return Effect.as(registry.addNode(id, { name, node }, connected), { id, name, replaced: false })
      })
      const paired = entry.replace === undefined
        ? fresh
        : Effect.flatMap(registry.renewNode(entry.replace, node), (renewed) =>
          renewed
            ? Effect.succeed({ id: entry.replace!, name: registry.nameOf(entry.replace!) ?? entry.replace!, replaced: true })
            // The node was removed after the code was made: pair as a new node.
            : fresh)
      return paired.pipe(
        Effect.map(({ id, name, replaced }) => {
          // A new credential: whatever memory had about the old one (its running bundle, status) no longer applies.
          if (replaced) memory.delete(id)
          for (const listener of listeners) {
            try {
              listener({ code, deviceId: id, name, replaced })
            } catch (error) {
              log(`node.paired listener failed: ${String(error)}`)
            }
          }
          return json(200, { deviceId: id, credential, name })
        }),
        Effect.catch((e) =>
          Effect.sync(() => {
            log(`A voice node could not be paired: ${e.message}`)
            // Not used up: the owner may try again while it is valid.
            if (now() < entry.expiresAt) codes.set(code, entry)
            return json(503, { error: "unavailable" })
          })
        )
      )
    })

  const checkHello: Nodes["checkHello"] = (hello) => {
    const device = hello.device
    const claimedId = device?.id ?? hello.clientId
    const record = registry.nodeOf(claimedId)
    const claims = record !== undefined || device?.kind === VOICE_NODE_KIND || hello.node !== undefined
    if (!claims) return { node: false }
    if (device === undefined) return { node: true, ok: false, reason: "a voice node must name its device" }
    if (record === undefined) return { node: true, ok: false, reason: "this device is not a paired voice node" }
    if (hello.node === undefined) return { node: true, ok: false, reason: "a voice node must present its credential" }
    const expected = Buffer.from(record.credentialSha256, "hex")
    const given = sha256(hello.node.credential)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { node: true, ok: false, reason: "the credential does not match" }
    }
    return { node: true, ok: true, id: device.id, name: registry.nameOf(device.id) ?? device.id }
  }

  return {
    create,
    cancel: (code) => {
      codes.delete(normaliseCode(code))
    },
    redeem,
    checkHello,
    connected: (id, hello) => {
      const m = memoryOf(id)
      m.bundleSha256 = hello.bundleSha256
    },
    setStatus: (id, status) => {
      const m = memoryOf(id)
      const changed = JSON.stringify(m.status) !== JSON.stringify(status)
      m.status = status
      return changed
    },
    info: (id, node) => {
      const m = memory.get(id)
      const manifest = options.manifest()
      const bundle = m?.bundleSha256
      return {
        pairedAt: node.pairedAt,
        ...(node.version !== undefined ? { version: node.version } : {}),
        ...(bundle !== undefined ? { bundleSha256: bundle } : {}),
        ...(bundle !== undefined && manifest !== undefined ? { upToDate: bundle === manifest.bundle.sha256 } : {}),
        ...(node.platform !== undefined ? { platform: node.platform } : {}),
        ...(m?.status !== undefined ? { status: m.status } : {}),
        // As the server sees it: it serves TLS itself, or not (a reverse proxy in front is not known here).
        ...(m !== undefined ? { transport: options.tls ? "wss" : "ws" } : {})
      }
    },
    forget: (id) => {
      memory.delete(id)
    },
    openMeter: (id, durationMs) => {
      memoryOf(id).meterUntil = now() + (durationMs ?? DEFAULT_TEST_MIC_MS) + METER_GRACE_MS
    },
    metering: (id) => (memory.get(id)?.meterUntil ?? 0) > now(),
    onPaired: (listener) => {
      listeners.push(listener)
    },
    connectedFrom: (source) => {
      connectedDevices = source
    }
  }
}
