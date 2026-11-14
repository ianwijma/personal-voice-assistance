// A plain static file server for the exported site (`out/`), like the assistant's server: GET/HEAD, a directory
// URL (`/`, `/admin/`) → its index.html, a directory without the trailing slash (`/admin`) → 308 to `/admin/`
// (the export uses `trailingSlash: true`), `/x` → x.html.
// Usage: node scripts/serve-static.mjs [dir] [port]
import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, normalize, resolve } from "node:path"

const root = resolve(process.argv[2] ?? "out")
const port = Number(process.argv[3] ?? 3200)
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8"
}

createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end()
    return
  }
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)
  let file = normalize(join(root, path))
  if (!file.startsWith(root)) {
    res.writeHead(403).end()
    return
  }
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!path.endsWith("/")) {
      const url = new URL(req.url ?? "/", "http://x")
      res.writeHead(308, { location: `${url.pathname}/${url.search}` }).end()
      return
    }
    file = join(file, "index.html")
  }
  else if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`
  if (!existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found")
    return
  }
  res.writeHead(200, {
    "content-type": types[extname(file)] ?? "application/octet-stream",
    "cache-control": path.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache"
  })
  if (req.method === "HEAD") res.end()
  else createReadStream(file).pipe(res)
}).listen(port, "127.0.0.1", () => console.log(`static: http://127.0.0.1:${port} → ${root}`))
