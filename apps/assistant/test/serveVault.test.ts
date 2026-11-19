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
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

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

/** A voice page. */
const helloed = async (server: TestServer) => {
  const client = await connect(server)
  const welcome = await client.hello()
  return { client, welcome }
}

/** An admin page, logged in (`welcome.snapshot` is the admin snapshot). */
const adminPage = async (server: TestServer) => {
  const client = await connect(server)
  const welcome = await client.admin(TEST_ADMIN_PASSWORD)
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
  const seen = [...client.messages].reverse().find((m) => m.type === "vault" || m.type === "admin.snapshot")
  const current = seen?.type === "vault" ? seen.vault : seen?.type === "admin.snapshot" ? seen.snapshot.vault : undefined
  if (current !== undefined && pred(current)) return current
  return (await client.waitFor("vault", (m) => pred(m.vault), { from: 0 })).vault
}

const protectedUpdate = { type: "settings.update", sectionId: "language-model", patch: { values: { LLM_PROVIDER: "fake" }, secrets: {} } } as const
const openUpdate = { type: "settings.update", sectionId: "voices", patch: { values: { ASSISTANT_VOICE: null }, secrets: {} } } as const
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
  it("no voice page may change anything, also before a vault exists; an admin page may; protected items are flagged", async () => {
    const server = await start()
    const { client: voice } = await helloed(server)
    for (const update of [protectedUpdate, openUpdate, configureGreeter, { type: "vault.setup", password: PASSWORD } as const]) {
      expect(await request(voice, update)).toMatchObject({ ok: false, error: { code: "admin_required" } })
    }
    const { client, welcome } = await adminPage(server)
    expect(welcome.snapshot.vault).toEqual({ state: "none", admin: true, location: join(server.dataDir, "vault", "vault.enc") })
    const flags = Object.fromEntries(welcome.snapshot.sections.map((s) => [s.id, s.protected === true]))
    expect(flags).toEqual({
      home: false,
      members: false,
      risk: true,
      "language-model": true,
      "llm-behaviour": false,
      "llm-openai-accounts": true,
      "stt-engine": true,
      "stt-timing": false,
      "stt-mic": false,
      "stt-deepgram": true,
      voices: false,
      "voice-providers": true,
      routing: true,
      recordings: false
    })
    expect(welcome.snapshot.modules[0]).toMatchObject({ id: "greeter", protected: true })
    expect((await request(client, protectedUpdate)).ok).toBe(true)
    expect((await request(client, openUpdate)).ok).toBe(true)
    expect((await request(client, configureGreeter)).ok).toBe(true)
  })

  it("the vault needs an admin page and its own password; typing the vault password grants nothing; a lock keeps admin", async () => {
    const server = await start()
    const { client: a } = await adminPage(server)
    const { client: voice } = await helloed(server)

    expect(await request(a, { type: "vault.setup", password: "short" })).toMatchObject({ ok: false, error: { code: "bad_password" } })
    expect(await request(a, { type: "vault.setup", password: PASSWORD })).toEqual({ type: "result", requestId: expect.any(String), ok: true })
    expect(await vaultState(a, (v) => v.state === "unlocked")).toMatchObject({ state: "unlocked", admin: true })
    expect(existsSync(join(server.dataDir, "vault", "vault.enc"))).toBe(true)
    // The voice page gets no vault messages at all, and the right vault password changes nothing for it.
    expect(voice.types()).not.toContain("vault")
    expect(await request(voice, { type: "vault.unlock", password: PASSWORD })).toMatchObject({ ok: false, error: { code: "admin_required" } })
    expect(await request(voice, openUpdate)).toMatchObject({ ok: false, error: { code: "admin_required" } })

    // A second admin page (its own login) works alongside.
    const { client: b, welcome } = await adminPage(server)
    expect(welcome.snapshot.vault).toMatchObject({ state: "unlocked", admin: true })
    expect((await request(b, configureGreeter)).ok).toBe(true)

    // A locks: the keys leave memory; both admin pages stay admin (their sessions are not the vault's).
    expect((await request(a, { type: "vault.lock" })).ok).toBe(true)
    for (const client of [a, b]) expect(await vaultState(client, (v) => v.state === "locked")).toMatchObject({ admin: true })
    expect((await request(a, protectedUpdate)).ok).toBe(true)
    expect(await request(b, { type: "vault.unlock", password: "wrong horse" })).toMatchObject({ ok: false, error: { code: "bad_password" } })
    expect((await request(b, { type: "vault.unlock", password: PASSWORD })).ok).toBe(true)
    expect(voice.types()).not.toContain("vault")
    for (const c of [a, b, voice]) expect(JSON.stringify(c.messages)).not.toContain(PASSWORD)
  })

  it("a restart starts locked: engines that need a key fail cleanly; unlocking reloads them; modules get their secrets back", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-serve-"))
    const first = await start({ dataDir, build: keyedBuild() })
    expect(first.handle.engine.status()).toMatchObject({ state: "failed", problems: [{ message: "ANTHROPIC_API_KEY is not set" }] })
    const { client: a } = await adminPage(first)
    expect((await request(a, { type: "vault.setup", password: PASSWORD })).ok).toBe(true)
    // The key field is shown (and saved) only with the Claude API chosen, so the patch chooses it too.
    const keyUpdate = {
      type: "settings.update",
      sectionId: "language-model",
      patch: { values: { LLM_PROVIDER: "anthropic" }, secrets: { ANTHROPIC_API_KEY: "sk-ant-test" } }
    } as const
    expect((await request(a, keyUpdate)).ok).toBe(true)
    expect((await request(a, { type: "module.configure", moduleId: "greeter", patch: { values: {}, secrets: { token: "tok" } } })).ok).toBe(true)
    expect(existsSync(join(dataDir, "secrets.json"))).toBe(false)
    a.close()
    await first.close()
    servers = servers.filter((s) => s !== first)

    const second = await start({ dataDir, build: keyedBuild() })
    const { client: b, welcome } = await adminPage(second)
    expect(welcome.snapshot.vault).toMatchObject({ state: "locked", admin: true })
    expect(welcome.snapshot.engine).toMatchObject({
      state: "failed",
      problems: [{ stage: "language model (LLM_PROVIDER)", message: KEYS_LOCKED_MESSAGE }]
    })
    const greeter = welcome.snapshot.modules.find((m) => m.id === "greeter")!
    expect(greeter.settings.secrets.token).toEqual({ set: false, source: "none" })
    // Typed on a voice page (admin connections have no voice session since protocol 6).
    const { client: voice } = await helloed(second)
    const refusedText = await request(voice, { type: "text.send", text: "hello", speak: false })
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
    const { client: a } = await adminPage(first)
    expect((await request(a, { type: "vault.setup", password: PASSWORD })).ok).toBe(true)
    a.close()
    await first.close()
    servers = servers.filter((s) => s !== first)

    const auto = await start({ dataDir, env: { PVA_VAULT_PASSWORD: PASSWORD } })
    const { client: b } = await helloed(auto)
    expect(await request(b, protectedUpdate)).toMatchObject({ ok: false, error: { code: "admin_required" } })
    expect(auto.handle.vault.state()).toBe("unlocked")
    const { client: c, welcome } = await adminPage(auto)
    expect(welcome.snapshot.vault).toMatchObject({ state: "unlocked", admin: true })
    expect((await request(c, protectedUpdate)).ok).toBe(true)
    b.close()
    c.close()
    await auto.close()
    servers = servers.filter((s) => s !== auto)

    const wrong = await start({ dataDir, env: { PVA_VAULT_PASSWORD: "not the password" } })
    const { welcome: w } = await adminPage(wrong)
    expect(w.snapshot.vault).toMatchObject({ state: "locked", admin: true })
  })

  it("setup moves data/secrets.json into the vault, deletes it and reports it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-serve-"))
    writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ version: 1, modules: { greeter: { token: "legacy" } }, sections: {} }), { mode: 0o600 })
    const server = await start({ dataDir })
    const { client, welcome } = await adminPage(server)
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
    const { client } = await adminPage(server)
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
    const { client } = await adminPage(server)
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

