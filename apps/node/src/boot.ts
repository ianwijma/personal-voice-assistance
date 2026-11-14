/**
 * The boot guard, `/opt/pva-node/pva-node-boot.mjs` (docs/VOICE-NODES.md §7.3; built by `scripts/bundle.mjs` from
 * this file and `releases.ts` alone). The unit runs it instead of the bundle:
 *
 *   node /opt/pva-node/pva-node-boot.mjs --config /etc/pva-node/node.json --audio alsa
 *
 * It counts the start of a pending release, rolls back one that failed `MAX_FAILED_STARTS` starts, and only then
 * loads `releases/current/pva-node.mjs` with the same arguments. Because the counting happens before the bundle is
 * loaded, a bundle that cannot even load (a syntax error, a missing export) is rolled back like one that never
 * reaches `welcome`. The installer owns this file (root, not self-updated), so a bad bundle cannot break it.
 *
 * `PVA_NODE_RELEASES` overrides the releases directory (default: `releases` next to this file). The bundle learns
 * that it runs under the guard from `PVA_NODE_BOOT` (this file's path).
 */
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { bootStart, RELEASE_FILE } from "./releases.ts"

const self = fileURLToPath(import.meta.url)
const releases = process.env["PVA_NODE_RELEASES"] ?? join(self, "..", "releases")
const say = (line: string) => process.stderr.write(`${new Date().toISOString()} pva-node-boot: ${line}\n`)

const decision = (() => {
  try {
    return bootStart(releases)
  } catch (error) {
    // The bookkeeping must never keep the node from starting (a read-only directory, a full disk).
    say(`cannot update ${join(releases, "state.json")}: ${(error as Error).message}; starting without rollback protection`)
    return undefined
  }
})()

if (decision?._tag === "NoRelease") {
  say(`no release installed in ${releases} (current/${RELEASE_FILE} is missing); run install.sh again`)
  process.exit(1)
}
if (decision?._tag === "RolledBack" || decision?._tag === "GaveUp") say(decision.message)
else if (decision?._tag === "Run" && decision.start !== undefined) say(`new release ${decision.sha256.slice(0, 12)}, start ${decision.start}`)

const bundle = join(releases, "current", RELEASE_FILE)
process.env["PVA_NODE_BOOT"] = self
process.env["PVA_NODE_RELEASES"] = releases
// The bundle parses `process.argv.slice(2)` as if it had been started directly.
process.argv = [process.argv[0]!, bundle, ...process.argv.slice(2)]
try {
  await import(pathToFileURL(bundle).href)
} catch (error) {
  say(`the release in ${bundle} failed to load: ${(error as Error).stack ?? String(error)}`)
  process.exit(1)
}
