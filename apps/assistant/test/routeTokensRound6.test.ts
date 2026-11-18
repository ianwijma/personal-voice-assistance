// Review round 6 of PR 90 (route tokens, 6B-1): one canonical list of the kept records decides authentication,
// listing, the limit, mint and revoke; what a mint or revoke saves is exactly that list after the change, so a record
// that was not admitted is dropped from the file then and never revived.
import { Effect } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeRouteTokens } from "../src/serve/RouteTokens.ts"
import { ROUTE_TOKENS_ENTRY } from "../src/serve/SettingsStore.ts"
import { openStore } from "./support/store.ts"

vi.setConfig({ testTimeout: 20_000 })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pva-tokens6-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

type SecretsFile = { modules: Record<string, Record<string, string>> }
const readTokens = (data: string) => (JSON.parse(readFileSync(join(data, "secrets.json"), "utf8")) as SecretsFile).modules[ROUTE_TOKENS_ENTRY] ?? {}
/** Edit the stored records by hand, as if the server were stopped. */
const editTokens = (data: string, edit: (entry: Record<string, string>) => void) => {
  const path = join(data, "secrets.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as SecretsFile
  const entry = file.modules[ROUTE_TOKENS_ENTRY] ?? {}
  edit(entry)
  file.modules[ROUTE_TOKENS_ENTRY] = entry
  writeFileSync(path, JSON.stringify(file, null, 2))
}
/** The server started again on the same data directory. */
const restart = async (data: string) => {
  const store = await Effect.runPromise(openStore(data))
  return makeRouteTokens({ store, locked: () => false })
}

describe("route tokens, review round 6", () => {
  it("6B-1: twenty records under malformed ids: minting works, and afterwards the file holds the one new record; after a restart it authenticates", async () => {
    const data = join(dir, "data")
    const first = await restart(data)
    const template = await Effect.runPromise(first.forModule("hooks").mint("hook", "Template"))
    const record = readTokens(data)[template.token.id]!
    editTokens(data, (entry) => {
      delete entry[template.token.id]
      for (let i = 0; i < 20; i++) entry[`bad-${i}`] = JSON.stringify({ ...JSON.parse(record), createdAt: i })
    })

    const keeper = await restart(data)
    expect(await Effect.runPromise(keeper.forModule("hooks").list)).toEqual([])
    const minted = await Effect.runPromise(keeper.forModule("hooks").mint("hook", "Home Assistant"))
    expect(Object.keys(readTokens(data))).toEqual([minted.token.id])
    expect(keeper.check("hooks", "hook", minted.secret).ok).toBe(true)

    const again = await restart(data)
    expect(again.check("hooks", "hook", minted.secret).ok).toBe(true)
    expect(again.check("hooks", "hook", template.secret).ok).toBe(false)
    expect((await Effect.runPromise(again.forModule("hooks").list)).map((t) => t.id)).toEqual([minted.token.id])
  })

  it("6B-1: twenty valid records and a twenty-first with the first one's hash: once the first is revoked its bearer no longer authenticates, also after a restart", async () => {
    const data = join(dir, "data")
    const keeper0 = await restart(data)
    const minted = []
    for (let i = 0; i < 20; i++) minted.push(await Effect.runPromise(keeper0.forModule("hooks").mint("hook", `caller ${i}`)))
    const firstId = minted[0]!.token.id
    editTokens(data, (entry) => {
      // The first one's record again, under another valid id, made last.
      entry["ffffffffffff"] = JSON.stringify({ ...JSON.parse(entry[firstId]!), createdAt: Date.now() + 60_000 })
    })

    const keeper = await restart(data)
    expect((await Effect.runPromise(keeper.forModule("hooks").list)).map((t) => t.id)).not.toContain("ffffffffffff")
    expect(keeper.check("hooks", "hook", minted[0]!.secret).ok).toBe(true)
    expect(await Effect.runPromise(keeper.forModule("hooks").revoke(firstId))).toBe(true)
    expect(keeper.check("hooks", "hook", minted[0]!.secret).ok).toBe(false)
    const stored = Object.keys(readTokens(data))
    expect(stored.length).toBe(19)
    expect(stored).not.toContain("ffffffffffff")
    expect(stored).not.toContain(firstId)

    const again = await restart(data)
    expect(again.check("hooks", "hook", minted[0]!.secret).ok).toBe(false)
    expect(again.check("hooks", "hook", minted[1]!.secret).ok).toBe(true)
    expect((await Effect.runPromise(again.forModule("hooks").list)).length).toBe(19)
  })
})
