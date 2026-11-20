import { NodeManifest, NodePairRequest } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import type * as http from "node:http"
import { join } from "node:path"

/**
 * Serving the voice node (docs/VOICE-NODES.md §5.5, §6.3): the four files of `apps/node/dist` under `/node/` and
 * `POST /node/pair`. The pairing itself is `nodes.ts`' (injected as `redeem`); this file only parses and limits.
 */

/** What `POST /node/pair` is answered with, from `nodes.ts`. */
export type Redeem = (body: NodePairRequest, remoteAddress: string) => Effect.Effect<{ readonly status: number; readonly json: unknown }>

export interface NodeDist {
  /** The validated manifest of the files being served; undefined when `dist/` is not built or does not check out. */
  readonly manifest: () => NodeManifest | undefined
  /** A request under `/node/`, after the host check. */
  readonly handle: (req: http.IncomingMessage, res: http.ServerResponse, redeem: Redeem) => void
}

export interface NodeDistOptions {
  /** Warnings (a manifest that does not match its files). Default: one line on stderr. */
  readonly log?: (line: string) => void
}

/** Largest `POST /node/pair` body (§5.5). */
export const MAX_PAIR_BODY_BYTES = 4096

/** The default `PVA_NODE_DIR` (`<repo>/apps/node/dist`), given the repository root. */
export const defaultNodeDir = (repoRoot: string): string => join(repoRoot, "apps", "node", "dist")

interface Served {
  readonly bytes: Buffer
  readonly type: string
  readonly cache: string
  readonly etag: string | undefined
}
interface Loaded {
  readonly manifest: NodeManifest
  /** By route name (`pva-node.mjs`, …). */
  readonly files: ReadonlyMap<string, Served>
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const decodeManifest = Schema.decodeUnknownSync(NodeManifest)
const decodePair = Schema.decodeUnknownSync(NodePairRequest)

/** The routes and what each file is called in the manifest (the installer rejects any other path). */
const ROUTES = {
  "manifest.json": { type: "application/json; charset=utf-8", cache: "no-store" },
  "pva-node.mjs": { type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "pva-node-boot.mjs": { type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "install.sh": { type: "text/plain; charset=utf-8", cache: "no-store" }
} as const
type RouteName = keyof typeof ROUTES
const isRoute = (name: string): name is RouteName => Object.hasOwn(ROUTES, name)

const load = (dir: string): Loaded => {
  const manifestBytes = readFileSync(join(dir, "manifest.json"))
  const manifest = decodeManifest(JSON.parse(manifestBytes.toString("utf8")))
  const files = new Map<string, Served>([["manifest.json", { bytes: manifestBytes, ...ROUTES["manifest.json"], etag: undefined }]])
  const entries: ReadonlyArray<readonly [RouteName, typeof manifest.bundle | undefined]> = [
    ["pva-node.mjs", manifest.bundle],
    ["pva-node-boot.mjs", manifest.boot],
    ["install.sh", manifest.installer]
  ]
  for (const [name, artifact] of entries) {
    if (artifact === undefined) continue
    if (artifact.path !== name) throw new Error(`manifest path "${artifact.path}" where "${name}" is expected`)
    // Read once and kept: what is checked is what is served, even if the file is rewritten a moment later.
    const bytes = readFileSync(join(dir, name))
    if (bytes.length !== artifact.bytes) throw new Error(`${name} is ${bytes.length} bytes, the manifest says ${artifact.bytes}`)
    const digest = sha256(bytes)
    if (digest !== artifact.sha256) throw new Error(`${name} has SHA-256 ${digest}, the manifest says ${artifact.sha256}`)
    files.set(name, { bytes, ...ROUTES[name], etag: name === "install.sh" ? undefined : `"${digest}"` })
  }
  return { manifest, files }
}

const json = (res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text), ...extra })
  res.end(text)
}
const plain404 = (res: http.ServerResponse) =>
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("Not found")

export const makeNodeDist = (dir: string, options: NodeDistOptions = {}): NodeDist => {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  let signature: string | undefined
  let loaded: Loaded | undefined

  /** One `stat` of the manifest per call; reloaded (and the artifacts checked again) when it changed. */
  const current = (): Loaded | undefined => {
    let next: string | undefined
    try {
      const s = statSync(join(dir, "manifest.json"))
      next = s.isFile() ? `${s.ino}:${s.size}:${s.mtimeMs}` : undefined
    } catch {
      next = undefined
    }
    if (next === signature) return loaded
    signature = next
    loaded = undefined
    if (next === undefined) return undefined
    try {
      loaded = load(dir)
    } catch (error) {
      log(`voice node bundle in ${dir} is not served: ${(error as Error).message} (rebuild with pnpm --filter @pva/node bundle)`)
    }
    return loaded
  }

  const servePair = (req: http.IncomingMessage, res: http.ServerResponse, redeem: Redeem) => {
    if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" }).end()
    // Browsers never pair: whatever page sent this, it is not a node.
    if (req.headers.origin !== undefined) return json(res, 403, { error: "bad_origin" })
    const declared = Number(req.headers["content-length"] ?? 0)
    if (declared > MAX_PAIR_BODY_BYTES) return json(res, 400, { error: "bad_request" }, { Connection: "close" })
    const chunks: Array<Buffer> = []
    let size = 0
    let done = false
    const bad = () => {
      if (done) return
      done = true
      json(res, 400, { error: "bad_request" }, { Connection: "close" })
      req.destroy()
    }
    req.on("data", (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > MAX_PAIR_BODY_BYTES) return bad()
      chunks.push(chunk)
    })
    req.on("error", () => {
      done = true
    })
    req.on("end", () => {
      if (done) return
      done = true
      let body: NodePairRequest
      try {
        body = decodePair(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        return json(res, 400, { error: "bad_request" })
      }
      Effect.runPromise(redeem(body, req.socket.remoteAddress ?? "")).then(
        (answer) => json(res, answer.status, answer.json, answer.status === 429 ? retryAfter(answer.json) : {}),
        () => json(res, 503, { error: "unavailable" })
      )
    })
  }

  const handle: NodeDist["handle"] = (req, res, redeem) => {
    const name = (req.url ?? "").split("?")[0]!.slice("/node/".length)
    if (name === "pair") return servePair(req, res, redeem)
    if (!isRoute(name)) return plain404(res)
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" }).end()
    const file = current()?.files.get(name)
    if (file === undefined) return json(res, 404, { error: "not_built" })
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": file.type,
      "Content-Length": file.bytes.length,
      "Cache-Control": file.cache,
      "X-Content-Type-Options": "nosniff",
      ...(file.etag === undefined ? {} : { ETag: file.etag })
    }
    if (file.etag !== undefined && req.headers["if-none-match"] === file.etag) {
      res.writeHead(304, { "Cache-Control": file.cache, ETag: file.etag }).end()
      return
    }
    res.writeHead(200, headers).end(req.method === "HEAD" ? undefined : file.bytes)
  }

  current()
  return { manifest: () => current()?.manifest, handle }
}

const retryAfter = (body: unknown): http.OutgoingHttpHeaders => {
  const ms = (body as { retryAfterMs?: unknown } | null)?.retryAfterMs
  return typeof ms === "number" && Number.isFinite(ms) ? { "Retry-After": Math.max(1, Math.ceil(ms / 1000)) } : {}
}
