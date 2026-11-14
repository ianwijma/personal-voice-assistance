/**
 * Loads `.env` files into `process.env` (variables already set in the environment win), remembering the file and
 * line of each (`envView`). Imported first by `main.ts`:
 * it must run before any module reads the environment, and Effect's default
 * `ConfigProvider` snapshots the environment the first time it is used.
 *
 * Looks in the directory the command was started from (`INIT_CWD` under pnpm,
 * which runs the script from `apps/assistant`) and in the repository root.
 */
import { existsSync, readFileSync } from "node:fs"
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type EnvView, makeEnvView } from "./envView.ts"

/**
 * Node gives each address 250 ms to connect before trying the next (IPv4/IPv6
 * auto-selection) and fails with ETIMEDOUT when none makes it. A provider
 * whose TCP handshake takes longer than that (measured here: Deepgram 216 ms,
 * Open-Meteo 255 ms) would fail intermittently or always, for `fetch` and `ws`
 * alike. A reachable address still connects as fast as before.
 */
setDefaultAutoSelectFamilyAttemptTimeout(1000)

/** Directory the user ran the command from; relative paths given on the command line resolve against it. */
export const userCwd = process.env.INIT_CWD ?? process.cwd()

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))

const processEnv: Record<string, string | undefined> = { ...process.env }
const files: Array<{ path: string; text: string }> = []
for (const path of new Set([resolve(userCwd, ".env"), resolve(repoRoot, ".env")])) {
  if (!existsSync(path)) continue
  files.push({ path, text: readFileSync(path, "utf8") })
}

/**
 * Every environment variable with where it came from (`envView.ts`): `.env` files (path and line) are applied to
 * `process.env` here, without overriding what the process already had. "Move to settings" releases a variable from
 * this view and from `process.env`.
 */
export const envView: EnvView = makeEnvView({ processEnv, files, mirror: process.env })
for (const [key, value] of Object.entries(envView.record)) if (process.env[key] === undefined) process.env[key] = value

/** Where an environment variable came from: a `.env` file, or the process environment (exported by the shell or the service). */
export const envOrigin = (name: string): "env-file" | "env-process" => envView.sourceOf(name)
