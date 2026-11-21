import { readFileSync } from "node:fs"

/**
 * This install's version: the root `package.json`'s, which the release workflow sets (docs/RELEASING.md). Read once,
 * at start; "0.0.0" when it cannot be read.
 */
export const SERVER_VERSION: string = (() => {
  try {
    const version = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { readonly version?: unknown }).version
    return typeof version === "string" && version !== "" ? version : "0.0.0"
  } catch {
    return "0.0.0"
  }
})()
