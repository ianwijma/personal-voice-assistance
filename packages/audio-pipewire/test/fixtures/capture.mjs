// Stand-in for pw-record: writes bytes 0,1,2,...(mod 256) to stdout in odd-sized
// pieces, records its pid, then either exits with an error or keeps running.
// Once the last write has been handed to the pipe (its callback; correct whether or not
// stdout is synchronous here) it creates <pidFile>.written: by then all but the pipe's own
// buffer has been read by the parent.
// usage: capture.mjs <pidFile> <totalBytes> <exit|hang>
import { writeFileSync } from "node:fs"
const [pidFile, total, mode] = process.argv.slice(2)
writeFileSync(pidFile, String(process.pid))
const bytes = new Uint8Array(Number(total)).map((_, i) => i % 256)
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
