// Runs the mock assistant and `next dev` together; Ctrl-C stops both.
import { spawn } from "node:child_process"

const children = [
  spawn("pnpm", ["exec", "tsx", "mock/server.ts"], { stdio: "inherit", env: process.env }),
  spawn("pnpm", ["exec", "next", "dev"], { stdio: "inherit", env: process.env })
]
const stop = () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM")
}
for (const c of children) c.on("exit", () => { stop(); process.exitCode = c.exitCode ?? 0 })
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
