// Review round 5 of PR 90 (route tokens): a token change queued while the vault locks is refused, never acknowledged
// without effect (5B-1); stored records that are not valid are ignored for authentication and listing alike, with one
// Health issue (5B-2).
import { defineModule, makeModuleHost, readOnlyPersistence } from "@pva/core"
import { ModuleRoutesResponse } from "@pva/protocol"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeModuleRouter } from "../src/serve/moduleRoutes.ts"
import { makeRouteTokens } from "../src/serve/RouteTokens.ts"
import { ROUTE_TOKENS_ENTRY } from "../src/serve/SettingsStore.ts"
import { openVault } from "../src/serve/Vault.ts"
import { openStore } from "./support/store.ts"

vi.setConfig({ testTimeout: 20_000 })

const PASSWORD = "correct horse battery"
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pva-tokens5-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const failureOf = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? JSON.stringify(exit.cause) : undefined)

describe("route tokens, review round 5", () => {
  it("5B-1: a revoke and a mint queued behind another vault operation, the vault locked before they run: both refused as locked; after unlocking the token still works and nothing was minted", async () => {
    const vault = await openVault({ path: join(dir, "vault.enc"), kdf: { N: 2 ** 12, r: 8, p: 1 } })
    expect((await vault.setup(PASSWORD, { modules: {}, assistant: {} })).ok).toBe(true)
    const store = await Effect.runPromise(openStore(join(dir, "data"), { vault }))
    const keeper = makeRouteTokens({ store, locked: () => vault.state() === "locked" })
    const hooks = keeper.forModule("hooks")
    const minted = await Effect.runPromise(hooks.mint("hook", "Home Assistant"))
    expect(keeper.check("hooks", "hook", minted.secret).ok).toBe(true)

    // Another vault operation holds the vault's exclusive section: the token changes queue behind it.
    let release!: () => void
    const held = vault.exclusive(() => new Promise<void>((resolve) => (release = resolve)))
    const revoking = Effect.runPromise(Effect.exit(hooks.revoke(minted.token.id)))
    const minting = Effect.runPromise(Effect.exit(hooks.mint("hook", "Another caller")))
    await new Promise((r) => setTimeout(r, 20))
    vault.lock()
    release()
    await held
    const revoked = await revoking
    const mintedAgain = await minting
    expect(failureOf(revoked)).toMatch(/"reason":"locked"/)
    expect(failureOf(mintedAgain)).toMatch(/"reason":"locked"/)

    expect((await vault.unlock(PASSWORD)).ok).toBe(true)
    // A refusal: the token was not revoked (and was never said to be), nothing else was added.
    expect(keeper.check("hooks", "hook", minted.secret).ok).toBe(true)
    expect((await Effect.runPromise(hooks.list)).map((t) => t.id)).toEqual([minted.token.id])
    // Asked again with the vault unlocked: revoked for real.
    expect(await Effect.runPromise(hooks.revoke(minted.token.id))).toBe(true)
    expect(keeper.check("hooks", "hook", minted.secret).ok).toBe(false)
  })

  it("5B-2: after a restart, records with a malformed id, details the wire refuses, or over the module's bound neither authenticate nor are listed; the inventory decodes; Health says how many", async () => {
    const data = join(dir, "data")
    const store = await Effect.runPromise(openStore(data))
    const keeper = makeRouteTokens({ store, locked: () => false })
    const good = await Effect.runPromise(keeper.forModule("hooks").mint("hook", "Good caller"))
    const renamed = await Effect.runPromise(keeper.forModule("hooks").mint("hook", "Renamed id"))
    const relabelled = await Effect.runPromise(keeper.forModule("hooks").mint("hook", "Relabelled"))
    const many = []
    for (let i = 0; i < 20; i++) many.push(await Effect.runPromise(keeper.forModule("other").mint("hook", `caller ${i}`)))

    // Edited by hand while the server was stopped.
    const path = join(data, "secrets.json")
    const file = JSON.parse(readFileSync(path, "utf8")) as { modules: Record<string, Record<string, string>> }
    const entry = file.modules[ROUTE_TOKENS_ENTRY]!
    entry["not-hex"] = entry[renamed.token.id]!
    delete entry[renamed.token.id]
    entry[relabelled.token.id] = JSON.stringify({ ...JSON.parse(entry[relabelled.token.id]!), label: "x".repeat(200) })
    // A twenty-first token of a module that may hold twenty: the record of an existing one, under a new id.
    entry["0123456789ab"] = entry[many[0]!.token.id]!
    writeFileSync(path, JSON.stringify(file, null, 2))

    const reported: Array<number> = []
    const reopened = await Effect.runPromise(openStore(data))
    const after = makeRouteTokens({ store: reopened, locked: () => false, report: (n) => reported.push(n) })
    after.audit()
    expect(reported).toEqual([3])
    expect(after.check("hooks", "hook", renamed.secret).ok).toBe(false)
    expect(after.check("hooks", "hook", relabelled.secret).ok).toBe(false)
    expect(after.check("hooks", "hook", good.secret).ok).toBe(true)
    expect(after.check("other", "hook", many[0]!.secret).ok).toBe(true)
    expect((await Effect.runPromise(after.forModule("other").list)).length).toBe(20)

    // The admin inventory decodes, listing only the valid ones.
    const scope = await Effect.runPromise(Scope.make())
    const catalog = [
      defineModule({ id: "hooks", name: "Hooks", description: "", settings: {}, start: () => Effect.succeed({}) }),
      defineModule({ id: "other", name: "Other", description: "", settings: {}, start: () => Effect.succeed({}) })
    ]
    const host = await Effect.runPromise(makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: {}, routeTokens: after }).pipe(Scope.provide(scope)))
    const router = makeModuleRouter({ host, admin: { enabled: false, check: () => undefined, touch: () => false }, tokens: after, services: Context.empty(), remoteAddress: () => "127.0.0.1" })
    const view = await Effect.runPromise(router.view())
    const decoded = Schema.decodeUnknownExit(ModuleRoutesResponse)(JSON.parse(JSON.stringify(view)))
    expect(Exit.isSuccess(decoded)).toBe(true)
    expect(view.modules.find((m) => m.moduleId === "hooks")!.tokens.map((t) => t.id)).toEqual([good.token.id])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})
