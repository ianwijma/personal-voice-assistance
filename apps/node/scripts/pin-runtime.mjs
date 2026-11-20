#!/usr/bin/env node
/**
 * Pin the Node runtime nodes get (scripts/runtime.json): `node apps/node/scripts/pin-runtime.mjs 22.23.5`.
 * Reads the official SHASUMS256.txt of that release over HTTPS and writes the .tar.gz URLs and hashes for
 * linux-arm64 and linux-x64. A maintainer runs this and commits the result; nodes never trust a hash they fetch
 * themselves. (Checking the GPG signature of SHASUMS256.txt.asc against the Node release keys is left to the
 * maintainer: `gpg --verify`.)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const version = process.argv[2]
if (version === undefined || !/^22\.\d+\.\d+$/.test(version)) {
  process.stderr.write("usage: pin-runtime.mjs <22.x.y> (the repo needs Node >= 22.18)\n")
  process.exit(2)
}
const file = join(dirname(fileURLToPath(import.meta.url)), "runtime.json")
const base = `https://nodejs.org/dist/v${version}`
const response = await fetch(`${base}/SHASUMS256.txt`)
if (!response.ok) throw new Error(`${base}/SHASUMS256.txt: HTTP ${response.status}`)
const sums = new Map((await response.text()).trim().split("\n").map((line) => line.trim().split(/\s+/).reverse()))
const pin = (arch) => {
  const name = `node-v${version}-linux-${arch}.tar.gz`
  const sha256 = sums.get(name)
  if (sha256 === undefined || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`no hash for ${name}`)
  return { url: `${base}/${name}`, sha256 }
}
const current = JSON.parse(readFileSync(file, "utf8"))
const next = { comment: current.comment, version, "linux-arm64": pin("arm64"), "linux-x64": pin("x64") }
writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
process.stdout.write(`pinned Node ${version}\n`)
