// Module credentials (`host.credentials`, docs/MODULES.md): kept in the vault under the module's own namespace.
import { defineModule, makeModuleHost, type ModuleCredentials, readOnlyPersistence } from "@pva/core"
import { Effect, Exit, Scope } from "effect"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCredentials } from "../src/serve/Credentials.ts"
import { openVault } from "../src/serve/Vault.ts"
import { openStore } from "./support/store.ts"

vi.setConfig({ testTimeout: 20_000 })

const PASSWORD = "correct horse battery"
const SECRET = "refresh-0123456789-abcdef"
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pva-credentials-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)
const failure = async <A, E>(e: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(e)
  return Exit.isFailure(exit) ? JSON.stringify(exit.cause) : undefined
}

describe("module credentials", () => {
  it("keeps a value per module namespace; a module never reads another's; unset is undefined", async () => {
    const store = await run(openStore(join(dir, "data")))
    const credentials = makeCredentials({ store, locked: () => false })
    const a = credentials.forModule("alpha")
    const b = credentials.forModule("beta")
    expect(await run(a.get("token"))).toBeUndefined()
    await run(a.set("token", SECRET))
    expect(await run(a.get("token"))).toBe(SECRET)
    expect(await run(b.get("token"))).toBeUndefined()
    await run(b.set("token", "other"))
    expect(await run(a.get("token"))).toBe(SECRET)
    expect(await run(a.clear("token"))).toBe(true)
    expect(await run(a.clear("token"))).toBe(false)
    expect(await run(a.get("token"))).toBeUndefined()
    expect(await run(b.get("token"))).toBe("other")
  })

  it("persists across a restart and never appears in the admin-visible settings", async () => {
    const data = join(dir, "data")
    const first = makeCredentials({ store: await run(openStore(data)), locked: () => false })
    await run(first.forModule("alpha").set("token", SECRET))
    const again = makeCredentials({ store: await run(openStore(data)), locked: () => false })
    expect(await run(again.forModule("alpha").get("token"))).toBe(SECRET)
    for (const name of readdirSync(data)) {
      if (name === "secrets.json") continue
      if (name.endsWith(".json")) expect(readFileSync(join(data, name), "utf8")).not.toContain(SECRET)
    }
  })

  it("in the vault: encrypted at rest, survives lock and unlock, fails locked (not undefined) while locked", async () => {
    const vault = await openVault({ path: join(dir, "vault.enc"), kdf: { N: 2 ** 12, r: 8, p: 1 } })
    expect((await vault.setup(PASSWORD, { modules: {}, assistant: {} })).ok).toBe(true)
    const data = join(dir, "data")
    const store = await run(openStore(data, { vault }))
    const credentials = makeCredentials({ store, locked: () => vault.state() === "locked" })
    const a = credentials.forModule("alpha")
    await run(a.set("token", SECRET))
    expect(readFileSync(join(dir, "vault.enc"), "utf8")).not.toContain(SECRET)
    expect(readdirSync(data).filter((n) => n === "secrets.json" ? readFileSync(join(data, n), "utf8").includes(SECRET) : false)).toEqual([])
    vault.lock()
    expect(await failure(a.get("token"))).toMatch(/"reason":"locked"/)
    expect(await failure(a.set("token", "x"))).toMatch(/"reason":"locked"/)
    expect(await failure(a.clear("token"))).toMatch(/"reason":"locked"/)
    expect((await vault.unlock(PASSWORD)).ok).toBe(true)
    expect(await run(a.get("token"))).toBe(SECRET)
  })

  it("holds at most 8 names per module; replacing one is not a new name", async () => {
    const store = await run(openStore(join(dir, "data")))
    const a = makeCredentials({ store, locked: () => false }).forModule("alpha")
    for (let i = 0; i < 8; i++) await run(a.set(`n${i}`, "v"))
    expect(await failure(a.set("n8", "v"))).toMatch(/"reason":"limit"/)
    await run(a.set("n0", "replaced"))
    expect(await run(a.get("n0"))).toBe("replaced")
    const other = makeCredentials({ store, locked: () => false }).forModule("beta")
    await run(other.set("n8", "v"))
    expect(await run(a.clear("n1"))).toBe(true)
    await run(a.set("n8", "v"))
  })

  it("through the host: name and size are checked, no store is unavailable, and a stored value is kept from a page", async () => {
    let seen: ModuleCredentials | undefined
    const mod = defineModule({
      apiVersion: 2,
      id: "creds",
      name: "Creds",
      description: "Keeps a credential",
      shared: ({ host }) => Effect.sync(() => {
        seen = host.credentials
        return { value: undefined }
      }),
      start: () => Effect.succeed({})
    })
    const scope = await run(Scope.make())
    const withStore = async (credentials?: Parameters<typeof makeModuleHost>[0]["credentials"]) => {
      seen = undefined
      const host = await run(makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { creds: { enabled: true } }, secrets: {} }),
        env: {},
        localPrincipal: true,
        ...(credentials !== undefined ? { credentials } : {})
      }).pipe(Scope.provide(scope), Effect.flatMap((h) => Effect.as(h.startEnabled, h))))
      return host
    }
    await withStore()
    expect(await failure(seen!.set("token", "x"))).toMatch(/"reason":"unavailable"/)
    expect(await failure(seen!.get("token"))).toMatch(/"reason":"unavailable"/)

    const store = await run(openStore(join(dir, "data")))
    const host = await withStore(makeCredentials({ store, locked: () => false }))
    expect(await failure(seen!.set("Bad Name", "x"))).toMatch(/"reason":"invalid"/)
    expect(await failure(seen!.set("token", "x".repeat(4097)))).toMatch(/"reason":"invalid"/)
    await run(seen!.set("token", SECRET))
    expect(JSON.stringify(host.snapshot())).not.toContain(SECRET)
    expect(JSON.stringify(host.modules())).not.toContain(SECRET)
    await run(seen!.set("token", "é".repeat(2048)))
    expect(await failure(seen!.set("token", "é".repeat(2049)))).toMatch(/"reason":"invalid"/)
    await run(Scope.close(scope, Exit.void))
  })
})
