// Child process for the data-directory lock tests.
//   holdLock.ts <dir>                 takes the lock, prints "locked", waits to be killed
//   holdLock.ts <dir> --grandchild    the same, after starting a long-lived `sleep` that outlives it
//   holdLock.ts <dir> --race          prints "ready"; then per stdin line: "go" tries to take the lock and prints
//                                     "won" or "lost: <message>"; "release" releases it and prints "released"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { acquireDataDirLockSync, type DataDirLock, releaseDataDirLock } from "../../src/serve/DataDirLock.ts"

const dir = process.argv[2]!
const mode = process.argv[3]

if (mode === "--race") {
  let lock: DataDirLock | undefined
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line === "go") {
      try {
        lock = acquireDataDirLockSync(dir).lock
        process.stdout.write("won\n")
      } catch (error) {
        process.stdout.write(`lost: ${(error as Error).message.replace(/\n/g, " ")}\n`)
      }
    } else if (line === "release") {
      if (lock !== undefined) releaseDataDirLock(lock)
      lock = undefined
      process.stdout.write("released\n")
    }
  }).on("close", () => process.exit(0))
  process.stdout.write("ready\n")
} else {
  acquireDataDirLockSync(dir)
  if (mode === "--grandchild") {
    const sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
    sleeper.unref()
    process.stdout.write(`grandchild ${sleeper.pid}\n`)
  }
  process.stdout.write("locked\n")
  setInterval(() => {}, 60_000)
}
