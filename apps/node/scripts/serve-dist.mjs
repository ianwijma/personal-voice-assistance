#!/usr/bin/env node
/**
 * A stand-in for the server's `/node/*` routes (WP-7) while they do not exist: serves `apps/node/dist` under
 * `/node/` and passes every other request, WebSocket upgrades included, through to an assistant. For trying the
 * installer and self-update against a real server:
 *
 *   node apps/node/scripts/serve-dist.mjs --port 8798 --assistant http://127.0.0.1:8799 [--dist apps/node/dist]
 *
 * Only the four dist files are served (no directory listing, no other paths). Not for production.
 */
import { createReadStream, existsSync, statSync } from "node:fs"
import * as http from "node:http"
import * as net from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: { port: { type: "string" }, host: { type: "string" }, assistant: { type: "string" }, dist: { type: "string" } }
})
const dist = resolve(values.dist ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist"))
const target = new URL(values.assistant ?? "http://127.0.0.1:8787")
const port = Number(values.port ?? 8798)
const host = values.host ?? "127.0.0.1"
const FILES = new Map([
  ["/node/manifest.json", "application/json"],
  ["/node/pva-node.mjs", "text/javascript"],
  ["/node/pva-node-boot.mjs", "text/javascript"],
  ["/node/install.sh", "text/x-shellscript"]
])
const log = (line) => process.stderr.write(`${new Date().toISOString()} serve-dist: ${line}\n`)

const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname
  if (path.startsWith("/node/")) {
    const type = FILES.get(path)
    const file = join(dist, path.slice("/node/".length))
    if (req.method !== "GET" || type === undefined || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n")
      log(`${req.method} ${path} 404`)
      return
    }
    res.writeHead(200, { "content-type": type, "content-length": statSync(file).size, "cache-control": "no-store" })
    createReadStream(file).pipe(res)
    log(`${req.method} ${path} 200`)
    return
  }
  const upstream = http.request(
    { host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    }
  )
  upstream.on("error", (e) => res.writeHead(502).end(`${e.message}\n`))
  req.pipe(upstream)
})

// WebSocket: replay the upgrade request to the assistant and splice the two sockets.
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    const headers = Object.entries({ ...req.headers, host: target.host }).map(([k, v]) => `${k}: ${v}`).join("\r\n")
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  const end = () => {
    socket.destroy()
    upstream.destroy()
  }
  upstream.on("error", end)
  socket.on("error", end)
  upstream.on("close", end)
  socket.on("close", end)
})

server.listen(port, host, () => log(`http://${host}:${port}/node/ from ${dist}; everything else to ${target.href}`))
