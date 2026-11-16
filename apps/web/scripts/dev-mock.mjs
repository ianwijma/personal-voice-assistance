// Runs the mock assistant, `next dev` and the character-list watcher together; Ctrl-C stops them all.
import { spawn } from "node:child_process"

const children = [
  spawn("pnpm", ["exec", "tsx", "mock/server.ts"], { stdio: "inherit", env: process.env }),
  spawn("pnpm", ["exec", "next", "dev"], { stdio: "inherit", env: process.env }),
  // A character file added while this runs is picked up (the list is regenerated; Turbopack reloads it).
  spawn("node", ["scripts/build-characters.mjs", "--watch"], { stdio: "inherit", env: process.env })
]
const stop = () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM")
}
for (const c of children) c.on("exit", () => { stop(); process.exitCode = c.exitCode ?? 0 })
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
