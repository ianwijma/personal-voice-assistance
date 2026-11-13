// Serve mode with the key vault and per-connection admin access (docs/UI-AND-MODULES.md §1.6), driven by the
// scripted client. Vaults live in temporary directories (the harness sets vaultPath).
import type { ClientMessage, VaultInfo } from "@pva/protocol"
import { Config, Effect } from "effect"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EngineBuildProblems, type ProviderBuilder } from "../src/serve/Engine.ts"
import { KEYS_LOCKED_MESSAGE } from "../src/serve/SettingsStore.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 20_000 })

const PASSWORD = "correct horse battery"

let servers: Array<TestServer> = []
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) await s.close()
})

const start = async (extra: Partial<Parameters<typeof startTestServer>[0]> = {}) => {
  const stt = controlledStt()
  const llm = scriptedLlm((t) => `You said: ${t}.`)
  const server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), ...extra })
  servers.push(server)
  return server
}

const connect = async (server: TestServer) => {
  const client = await ScriptedClient.connect({ url: server.url })
  clients.push(client)
  return client
}

const helloed = async (server: TestServer) => {
  const client = await connect(server)
  const welcome = await client.hello()
  return { client, welcome }
}

type WithoutId<M> = M extends unknown ? Omit<M, "requestId"> : never
type RequestInput = WithoutId<Extract<ClientMessage, { readonly requestId: string }>>

let seq = 0
/** Send a request and wait for its result. */
const request = async (client: ScriptedClient, message: RequestInput) => {
  const requestId = `q${++seq}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from })
}

/** The newest `vault` message (or the welcome's) matching `pred`, waiting for it if needed. */
const vaultState = async (client: ScriptedClient, pred: (v: VaultInfo) => boolean): Promise<VaultInfo> => {
  const seen = [...client.messages].reverse().find((m) => m.type === "vault" || m.type === "welcome")
  const current = seen?.type === "vault" ? seen.vault : seen?.type === "welcome" ? seen.snapshot.vault : undefined
  if (current !== undefined && pred(current)) return current
  return (await client.waitFor("vault", (m) => pred(m.vault), { from: 0 })).vault
}

const protectedUpdate = { type: "settings.update", sectionId: "language-model", patch: { values: { ANTHROPIC_MODEL: "claude-sonnet-5-5" }, secrets: {} } } as const
const openUpdate = { type: "settings.update", sectionId: "voices", patch: { values: { DEFAULT_VOICE: "standard" }, secrets: {} } } as const
const configureGreeter = { type: "module.configure", moduleId: "greeter", patch: { values: { greeting: "hoi" }, secrets: {} } } as const

/** A provider build that needs ANTHROPIC_API_KEY from the settings (as the real Anthropic adapter does). */
const keyedBuild = (): ProviderBuilder => {
  const stt = controlledStt()
  const llm = scriptedLlm((t) => `You said: ${t}.`)
  return Effect.gen(function*() {
    yield* Effect.gen(function*() {
      return yield* Config.String("ANTHROPIC_API_KEY")
    }).pipe(
      Effect.mapError(() => new EngineBuildProblems({ problems: [{ stage: "language model (LLM_PROVIDER)", message: "ANTHROPIC_API_KEY is not set" }] }))
    )
    return yield* fakeBuild({ stt: stt.stt, llm: llm.llm })
  })
}

describe("serve: key vault and admin access", () => {
  it("before a vault exists every page may change everything; protected items are flagged", async () => {
    const server = await start()
    const { client, welcome } = await helloed(server)
    expect(welcome.snapshot.vault).toEqual({ state: "none", admin: true, location: join(server.dataDir, "vault", "vault.enc") })
    const flags = Object.fromEntries(welcome.snapshot.sections.map((s) => [s.id, s.protected === true]))
    expect(flags).toEqual({ conversation: false, voices: false, listening: false, "language-model": true, speech: true })
    expect(welcome.snapshot.modules[0]).toMatchObject({ id: "greeter", protected: true })
    expect((await request(client, protectedUpdate)).ok).toBe(true)
    expect((await request(client, configureGreeter)).ok).toBe(true)
  })

  it("after setup: the page that set it is admin, others are refused (`locked`) until they type the password; admin is per connection", async () => {
    const server = await start()
    const { client: a } = await helloed(server)
    const { client: b } = await helloed(server)

    expect(await request(a, { type: "vault.setup", password: "short" })).toMatchObject({ ok: false, error: { code: "bad_password" } })
    expect(await request(a, { type: "vault.setup", password: PASSWORD })).toEqual({ type: "result", requestId: expect.any(String), ok: true })
    expect(await vaultState(a, (v) => v.state === "unlocked")).toMatchObject({ state: "unlocked", admin: true })
    expect(await vaultState(b, (v) => v.state === "unlocked")).toMatchObject({ state: "unlocked", admin: false })
    expect(existsSync(join(server.dataDir, "vault", "vault.enc"))).toBe(true)

    // B: protected items refused, open ones fine.
    const refused = await request(b, protectedUpdate)
    expect(refused).toMatchObject({ ok: false, error: { code: "locked" } })
    expect(refused.error?.message).toMatch(/Keys & access/)
    expect(await request(b, configureGreeter)).toMatchObject({ ok: false, error: { code: "locked" } })
    expect(await request(b, { type: "module.disable", moduleId: "greeter" })).toMatchObject({ ok: false, error: { code: "locked" } })
    expect(await request(b, { type: "vault.lock" })).toMatchObject({ ok: false, error: { code: "locked" } })
    expect((await request(b, openUpdate)).ok).toBe(true)
    // A: allowed.
    expect((await request(a, protectedUpdate)).ok).toBe(true)

    // B types a wrong password, then the right one: now B is admin too; a third page still is not.
    expect(await request(b, { type: "vault.unlock", password: "wrong horse" })).toMatchObject({ ok: false, error: { code: "bad_password" } })
    expect((await request(b, { type: "vault.unlock", password: PASSWORD })).ok).toBe(true)
    expect(await vaultState(b, (v) => v.admin)).toMatchObject({ state: "unlocked", admin: true })
    expect((await request(b, configureGreeter)).ok).toBe(true)
    const { client: c, welcome } = await helloed(server)
    expect(welcome.snapshot.vault).toMatchObject({ state: "unlocked", admin: false })
    expect(await request(c, protectedUpdate)).toMatchObject({ ok: false, error: { code: "locked" } })

    // A locks: the keys leave memory and every page loses admin access.
    expect((await request(a, { type: "vault.lock" })).ok).toBe(true)
    for (const client of [a, b, c]) expect(await vaultState(client, (v) => v.state === "locked")).toMatchObject({ admin: false })
    expect(await request(a, protectedUpdate)).toMatchObject({ ok: false, error: { code: "locked" } })
    expect(JSON.stringify(a.messages)).not.toContain(PASSWORD)
  })

  it("admin access ends after the idle limit and when the page disconnects", async () => {
    const server = await start({ adminIdleMs: 300 })
    const { client: a } = await helloed(server)
    expect((await request(a, { type: "vault.setup", password: PASSWORD })).ok).toBe(true)
    expect((await request(a, protectedUpdate)).ok).toBe(true)
    await sleep(450)
    expect(await vaultState(a, (v) => !v.admin)).toMatchObject({ state: "unlocked", admin: false })
    expect(await request(a, protectedUpdate)).toMatchObject({ ok: false, error: { code: "locked" } })

    expect((await request(a, { type: "vault.unlock", password: PASSWORD })).ok).toBe(true)
    a.close()
    const { client: again, welcome } = await helloed(server)
    expect(welcome.snapshot.vault?.admin).toBe(false)
    expect(await request(again, protectedUpdate)).toMatchObject({ ok: false, error: { code: "locked" } })
  })

  it("a restart starts locked: engines that need a key fail cleanly; unlocking reloads them; modules get their secrets back", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-serve-"))
    const first = await start({ dataDir, build: keyedBuild() })
    expect(first.handle.engine.status()).toMatchObject({ state: "failed", problems: [{ message: "ANTHROPIC_API_KEY is not set" }] })
    const { client: a } = await helloed(first)
    expect((await request(a, { type: "vault.setup", password: PASSWORD })).ok).toBe(true)
    const keyUpdate = { type: "settings.update", sectionId: "language-model", patch: { values: {}, secrets: { ANTHROPIC_API_KEY: "sk-ant-test" } } } as const
    expect((await request(a, keyUpdate)).ok).toBe(true)
    expect((await request(a, { type: "module.configure", moduleId: "greeter", patch: { values: {}, secrets: { token: "tok" } } })).ok).toBe(true)
    expect(existsSync(join(dataDir, "secrets.json"))).toBe(false)
    a.close()
    await first.close()
    servers = servers.filter((s) => s !== first)

    const second = await start({ dataDir, build: keyedBuild() })
    const { client: b, welcome } = await helloed(second)
    expect(welcome.snapshot.vault).toMatchObject({ state: "locked", admin: false })
    expect(welcome.snapshot.engine).toMatchObject({
      state: "failed",
      problems: [{ stage: "language model (LLM_PROVIDER)", message: KEYS_LOCKED_MESSAGE }]
    })
    const greeter = welcome.snapshot.modules.find((m) => m.id === "greeter")!
    expect(greeter.settings.secrets.token).toEqual({ set: false, source: "none" })
    const refusedText = await request(b, { type: "text.send", text: "hello", speak: false })
    expect(refusedText.error?.code).toBe("engine_failed")

    expect((await request(b, { type: "vault.unlock", password: PASSWORD })).ok).toBe(true)
    await b.waitFor("engine", (m) => m.engine.state === "ready", { from: 0, timeoutMs: 5_000 })
    await b.waitFor("module.changed", (m) => m.module.id === "greeter" && m.module.settings.secrets.token?.set === true, { from: 0 })
    const changed = await b.waitFor("section.changed", (m) => m.section.id === "language-model" && m.section.form.secrets.ANTHROPIC_API_KEY?.set === true, { from: 0 })
    expect(changed.section.protected).toBe(true)
    expect(JSON.stringify(b.messages)).not.toContain("sk-ant-test")
  })

  it("PVA_VAULT_PASSWORD unlocks at start without giving any page admin access; a wrong one leaves it locked", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-serve-"))
    const first = await start({ dataDir })
    const { client: a } = await helloed(first)
    expect((await request(a, { type: "vault.setup", password: PASSWORD })).ok).toBe(true)
    a.close()
    await first.close()
    servers = servers.filter((s) => s !== first)

    const auto = await start({ dataDir, env: { PVA_VAULT_PASSWORD: PASSWORD } })
    const { client: b, welcome } = await helloed(auto)
    expect(welcome.snapshot.vault).toMatchObject({ state: "unlocked", admin: false })
    expect(await request(b, protectedUpdate)).toMatchObject({ ok: false, error: { code: "locked" } })
    expect((await request(b, { type: "vault.unlock", password: PASSWORD })).ok).toBe(true)
    expect((await request(b, protectedUpdate)).ok).toBe(true)
    b.close()
    await auto.close()
    servers = servers.filter((s) => s !== auto)

    const wrong = await start({ dataDir, env: { PVA_VAULT_PASSWORD: "not the password" } })
    const { welcome: w } = await helloed(wrong)
    expect(w.snapshot.vault).toMatchObject({ state: "locked", admin: false })
  })

  it("setup moves data/secrets.json into the vault, deletes it and reports it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-serve-"))
    writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ version: 1, modules: { greeter: { token: "legacy" } }, sections: {} }), { mode: 0o600 })
    const server = await start({ dataDir })
    const { client, welcome } = await helloed(server)
    expect(welcome.snapshot.modules[0]!.settings.secrets.token).toEqual({ set: true, source: "store" })
    expect((await request(client, { type: "vault.setup", password: PASSWORD })).ok).toBe(true)
    const info = await vaultState(client, (v) => v.importedLegacySecrets !== undefined)
    expect(info).toMatchObject({ state: "unlocked", admin: true, importedLegacySecrets: 1 })
    expect(existsSync(join(dataDir, "secrets.json"))).toBe(false)
    expect(server.handle.host.modules()[0]!.settings.secrets.token).toEqual({ set: true, source: "store" })
    expect(readFileSync(join(dataDir, "vault", "vault.enc"), "utf8")).not.toContain("legacy")
  })

  it("a password that fails validation is never echoed back in the error", async () => {
    const server = await start()
    const { client } = await helloed(server)
    const secret = `hunter2-${"x".repeat(300)}`
    const from = client.messages.length
    client.sendRaw(JSON.stringify({ type: "vault.unlock", requestId: "x1", password: secret }))
    const error = await client.waitFor("error", () => true, { from })
    expect(error.error.code).toBe("bad_message")
    expect(error.error.message).toMatch(/longer than 256 characters/)
    expect(JSON.stringify(client.messages)).not.toContain("hunter2")
  })

  it("too many wrong passwords: refused for a while, with the wait on the page", async () => {
    let now = 5_000_000
    const server = await start({ vaultNow: () => now })
    const { client } = await helloed(server)
    expect((await request(client, { type: "vault.setup", password: PASSWORD })).ok).toBe(true)
    expect((await request(client, { type: "vault.lock" })).ok).toBe(true)
    for (let i = 0; i < 5; i++) await request(client, { type: "vault.unlock", password: "wrong horse" })
    const refused = await request(client, { type: "vault.unlock", password: PASSWORD })
    expect(refused.error).toMatchObject({ code: "bad_password" })
    expect(refused.error?.message).toMatch(/try again in 30 s/)
    expect(await vaultState(client, (v) => v.retryAfterMs !== undefined)).toMatchObject({ state: "locked", retryAfterMs: 30_000 })
    now += 30_000
    expect((await request(client, { type: "vault.unlock", password: PASSWORD })).ok).toBe(true)
  })
})

