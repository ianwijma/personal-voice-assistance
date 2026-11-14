// The JavaScript each exported page loads (its <script src> tags), raw and gzipped, and the chunks only one of the
// two front ends loads. Usage: node scripts/bundle-sizes.mjs [out]
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { gzipSync } from "node:zlib"

const root = resolve(process.argv[2] ?? "out")
const pages = { voice: "index.html", admin: "admin/index.html" }
const scripts = (html) => [...new Set([...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]))]
const size = (src) => {
  const buf = readFileSync(join(root, src.replace(/^\//, "")))
  return { raw: buf.length, gz: gzipSync(buf).length }
}
const kb = (n) => `${(n / 1024).toFixed(1)} kB`
const lists = Object.fromEntries(Object.entries(pages).map(([name, file]) => [name, scripts(readFileSync(join(root, file), "utf8"))]))
for (const [name, list] of Object.entries(lists)) {
  const total = list.map(size).reduce((a, b) => ({ raw: a.raw + b.raw, gz: a.gz + b.gz }), { raw: 0, gz: 0 })
  const other = Object.entries(lists).filter(([n]) => n !== name).flatMap(([, l]) => l)
  const own = list.filter((s) => !other.includes(s)).map(size).reduce((a, b) => ({ raw: a.raw + b.raw, gz: a.gz + b.gz }), { raw: 0, gz: 0 })
  console.log(`${name.padEnd(6)} ${String(list.length).padStart(2)} scripts  ${kb(total.raw).padStart(9)} (${kb(total.gz)} gzip)   only this page: ${kb(own.raw)} (${kb(own.gz)} gzip)`)
}
