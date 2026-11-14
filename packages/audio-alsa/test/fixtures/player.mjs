// Stand-in for aplay: records stdin to <outFile>, records its pid,
// and on end of input "drains" for <drainMs> before exiting 0.
// usage: player.mjs <pidFile> <outFile> <drainMs> <play|fail|stall>
import { appendFileSync, writeFileSync } from "node:fs"
const [pidFile, outFile, drainMs, mode] = process.argv.slice(2)
writeFileSync(pidFile, String(process.pid))
writeFileSync(outFile, "")
if (mode === "fail") {
  process.stderr.write("target not found\n")
  process.exit(2)
} else if (mode === "stall") {
  // Never read stdin: the writer must block on backpressure.
  setInterval(() => {}, 1000)
} else {
  process.stdin.on("data", (d) => appendFileSync(outFile, d))
  process.stdin.on("end", () => setTimeout(() => process.exit(0), Number(drainMs)))
}
