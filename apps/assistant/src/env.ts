/**
 * Loads `.env` files into `process.env` with Node's built-in `process.loadEnvFile`
 * (variables already set in the environment win). Imported first by `main.ts`:
 * it must run before any module reads the environment, and Effect's default
 * `ConfigProvider` snapshots the environment the first time it is used.
 *
 * Looks in the directory the command was started from (`INIT_CWD` under pnpm,
 * which runs the script from `apps/assistant`) and in the repository root.
 */
import { existsSync } from "node:fs"
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

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

for (const path of new Set([resolve(userCwd, ".env"), resolve(repoRoot, ".env")])) {
  if (existsSync(path)) process.loadEnvFile(path)
}
