// Stand-in for pw-record: writes bytes 0,1,2,...(mod 256) to stdout in odd-sized
// pieces, records its pid, then either exits with an error or keeps running.
// Once the last write has been handed to the pipe (its callback; correct whether or not
// stdout is synchronous here) it creates <pidFile>.written: by then all but the pipe's own
// buffer has been read by the parent.
// With `indexed`, every 640-byte frame starts with its own number (32-bit little-endian),
// so a test can tell which frames it was given.
// usage: capture.mjs <pidFile> <totalBytes> <exit|hang> [indexed]
import { writeFileSync } from "node:fs"
const [pidFile, total, mode, indexed] = process.argv.slice(2)
writeFileSync(pidFile, String(process.pid))
const bytes = new Uint8Array(Number(total)).map((_, i) => i % 256)
if (indexed === "indexed") {
  const view = new DataView(bytes.buffer)
  for (let frame = 0; frame * 640 + 4 <= bytes.length; frame++) view.setUint32(frame * 640, frame, true)
}
const sizes = [100, 1000, 333, 7]
let offset = 0
const done = () => {
  writeFileSync(`${pidFile}.written`, "")
  if (mode === "exit") {
    process.stderr.write("no such target node\n")
    process.stdout.end(() => process.exit(3))
  } else {
    setInterval(() => {}, 1000)
  }
}
for (let i = 0; offset < bytes.length; i++) {
  const n = sizes[i % sizes.length]
  const last = offset + n >= bytes.length
  process.stdout.write(bytes.subarray(offset, offset + n), last ? done : undefined)
  offset += n
}
if (bytes.length === 0) done()
