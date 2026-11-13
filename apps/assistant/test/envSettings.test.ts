// P4 (docs/SETTINGS-UI.md §4.4): the environment with origins, "Move to settings", and the CLI on the saved
// settings. Everything runs in temporary directories with temporary vaults.
import { makeModuleHost } from "@pva/core"
import type { ClientMessage } from "@pva/protocol"
import { Config, ConfigProvider, Effect, Logger, References } from "effect"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cliConfigProvider, explainMissingKey, loadCliSettings } from "../src/cliSettings.ts"
import { commentOutKeys, makeEnvView, parseEnvFile, scanEnvAssignments } from "../src/envView.ts"
import { makeEnvMover } from "../src/serve/envSettings.ts"
import { makeSections } from "../src/serve/sections.ts"
import { loadSettingsStore } from "../src/serve/SettingsStore.ts"
import { openVault } from "../src/serve/Vault.ts"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 20_000 })

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))
const SECRET = "sk-ant-test-0123456789abcdef"
const PASSWORD = "correct horse battery"
const cheapKdf = { N: 2 ** 12, r: 8, p: 1 }

describe("env view: where each variable came from", () => {
  const text = [
    "# a comment",
    "",
    "LLM_PROVIDER=anthropic",
    `export ANTHROPIC_API_KEY="${SECRET}"   # inline comment`,
    "SYSTEM_PROMPT=\"line one",
    "line two\"",
    "STT_SHERPA_AGC=true",
    "  STT_SHERPA_MODEL = 'whisper-turbo'",
    "LLM_PROVIDER=fake"
  ].join("\n")

  it("scans assignments with their lines, multi-line quoted values and `export`", () => {
    expect(scanEnvAssignments(text)).toEqual([
      { key: "LLM_PROVIDER", line: 3, lines: 1 },
      { key: "ANTHROPIC_API_KEY", line: 4, lines: 1 },
      { key: "SYSTEM_PROMPT", line: 5, lines: 2 },
      { key: "STT_SHERPA_AGC", line: 7, lines: 1 },
      { key: "STT_SHERPA_MODEL", line: 8, lines: 1 },
      { key: "LLM_PROVIDER", line: 9, lines: 1 }
    ])
  })

  it("values are Node's own (quotes and comments removed); the line is the last assignment's", () => {
    const parsed = Object.fromEntries(parseEnvFile(text).map((e) => [e.key, e]))
    expect(parsed.ANTHROPIC_API_KEY).toEqual({ key: "ANTHROPIC_API_KEY", value: SECRET, line: 4 })
    expect(parsed.SYSTEM_PROMPT?.value).toBe("line one\nline two")
    expect(parsed.STT_SHERPA_MODEL).toEqual({ key: "STT_SHERPA_MODEL", value: "whisper-turbo", line: 8 })
    expect(parsed.LLM_PROVIDER).toEqual({ key: "LLM_PROVIDER", value: "fake", line: 9 })
  })

  it("the process environment wins over a file and is `process` origin; release and restore", () => {
    const mirror: Record<string, string | undefined> = { STT_SHERPA_AGC: "false" }
    const view = makeEnvView({ processEnv: { STT_SHERPA_AGC: "false" }, files: [{ path: "/x/.env", text }], mirror })
    expect(view.origin("STT_SHERPA_AGC")).toEqual({ kind: "process" })
    expect(view.get("STT_SHERPA_AGC")).toBe("false")
    expect(view.origin("STT_SHERPA_MODEL")).toEqual({ kind: "file", path: "/x/.env", line: 8 })
    expect(view.locationOf("STT_SHERPA_MODEL")).toEqual({ file: "/x/.env", line: 8 })
    expect(view.sourceOf("STT_SHERPA_MODEL")).toBe("env-file")
    expect(view.sourceOf("STT_SHERPA_AGC")).toBe("env-process")
    view.release("STT_SHERPA_AGC")
    expect(view.get("STT_SHERPA_AGC")).toBeUndefined()
    expect(mirror.STT_SHERPA_AGC).toBeUndefined()
    view.restore("STT_SHERPA_AGC", "false", { kind: "process" })
    expect(view.get("STT_SHERPA_AGC")).toBe("false")
    // An earlier file wins over a later one.
    const two = makeEnvView({ processEnv: {}, files: [{ path: "/a/.env", text: "A=1" }, { path: "/b/.env", text: "A=2\nB=3" }] })
    expect([two.get("A"), two.origin("A"), two.get("B")]).toEqual(["1", { kind: "file", path: "/a/.env", line: 1 }, "3"])
    // Redacted: listed, no value.
    two.redact("B")
    expect([two.get("B"), two.keys().includes("B"), two.origin("B")]).toEqual([undefined, true, { kind: "file", path: "/b/.env", line: 2 }])
  })
})

describe("commenting lines out of .env", () => {
  it("rewrites atomically with a 0600 backup, keeps the mode, and writes no value", async () => {
    const dir = tmp("pva-envfile-")
    const path = join(dir, ".env")
    const original = `# mine\nLLM_PROVIDER=anthropic\nANTHROPIC_API_KEY=${SECRET}\nSYSTEM_PROMPT="a\nb"\nSERVE_PORT=8800\n`
    writeFileSync(path, original)
    chmodSync(path, 0o640)
    const now = new Date("2026-11-14T10:00:00.000Z")
    const result = await commentOutKeys(path, ["ANTHROPIC_API_KEY", "SYSTEM_PROMPT"], now)
    expect([...result.keys].sort()).toEqual(["ANTHROPIC_API_KEY", "SYSTEM_PROMPT"])
    const after = readFileSync(path, "utf8")
    expect(after).toBe(
      "# mine\nLLM_PROVIDER=anthropic\n# ANTHROPIC_API_KEY moved to the settings UI on 2026-11-14\n# SYSTEM_PROMPT moved to the settings UI on 2026-11-14\nSERVE_PORT=8800\n"
    )
    expect(after).not.toContain(SECRET)
    expect(statSync(path).mode & 0o777).toBe(0o640)
    expect(readFileSync(result.backup, "utf8")).toBe(original)
    expect(statSync(result.backup).mode & 0o777).toBe(0o600)
    // No temporary file is left behind.
    expect(readdirSync(dir).sort()).toEqual([".env", ".env.bak-2026-11-14T10-00-00-000Z"])
  })

  it("keeps CRLF line ends", async () => {
    const dir = tmp("pva-envfile-")
    const path = join(dir, ".env")
    writeFileSync(path, "A=1\r\nSTT_SHERPA_AGC=true\r\nB=2\r\n")
    await commentOutKeys(path, ["STT_SHERPA_AGC"], new Date("2026-11-14T00:00:00Z"))
    expect(readFileSync(path, "utf8")).toBe("A=1\r\n# STT_SHERPA_AGC moved to the settings UI on 2026-11-14\r\nB=2\r\n")
  })
})

// ---------------------------------------------------------------------------
// The mover on its own (vault states, logs)

const moverSetup = async (envText: string, vaultState: "none" | "locked" | "unlocked") => {
  const dir = tmp("pva-mover-")
  const envPath = join(dir, ".env")
  writeFileSync(envPath, envText)
  const view = makeEnvView({ processEnv: { STT_SHERPA_VAD_THRESHOLD: "0.6" }, files: [{ path: envPath, text: envText }] })
  const store = await Effect.runPromise(loadSettingsStore(join(dir, "data")))
  const sections = makeSections(store, view.record, { envOrigin: view.sourceOf, envLocation: view.locationOf })
  const lines: Array<string> = []
  const logger = Logger.layer([Logger.make(({ message }) => lines.push(Array.isArray(message) ? message.join(" ") : String(message)))])
  const run = <A>(effect: Effect.Effect<A, unknown, any>) =>
    Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(logger), Effect.provideService(References.MinimumLogLevel, "Debug")) as Effect.Effect<A, unknown>)
  return { dir, envPath, view, store, sections, lines, run, vaultState }
}

describe("Move to settings (the mover)", () => {
  it("refuses keys while the vault is locked, changing nothing; non-secrets still move", async () => {
    const env = `ANTHROPIC_API_KEY=${SECRET}\nSTT_SHERPA_AGC=false\n`
    const t = await moverSetup(env, "locked")
    await t.run(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [greeterModule], persistence: t.store.modulePersistence, env: t.view.record })
      const mover = makeEnvMover({ view: t.view, catalog: [greeterModule], sections: t.sections, host, store: t.store, vaultState: () => "locked", onMoved: () => {} })
      const refused = yield* mover.move(["ANTHROPIC_API_KEY", "STT_SHERPA_AGC"])
      expect(refused).toMatchObject({ ok: false, error: { code: "locked" } })
      expect(JSON.stringify(refused)).not.toContain(SECRET)
      expect(readFileSync(t.envPath, "utf8")).toBe(env)
      expect(t.view.get("ANTHROPIC_API_KEY")).toBe(SECRET)
      const moved = yield* mover.move(["STT_SHERPA_AGC"])
      expect(moved).toMatchObject({ ok: true, moved: ["STT_SHERPA_AGC"] })
      expect(t.store.settings().assistant.STT_SHERPA_AGC).toBe(false)
      expect(readFileSync(t.envPath, "utf8")).toContain("# STT_SHERPA_AGC moved to the settings UI on")
      expect(readFileSync(t.envPath, "utf8")).toContain(`ANTHROPIC_API_KEY=${SECRET}`)
    }))
    expect(t.lines.join("\n")).toContain("Moved STT_SHERPA_AGC from")
  })

  it("moves a key (no vault yet: into secrets.json) and an engine key without a field; never logs a value", async () => {
    const t = await moverSetup(`ANTHROPIC_API_KEY=${SECRET}\nSTT_SHERPA_THREADS=3\nSERVE_PORT=1\nSTT_SHERPA_MODLE=x\n`, "none")
    await t.run(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [greeterModule], persistence: t.store.modulePersistence, env: t.view.record })
      let moved = 0
      const mover = makeEnvMover({ view: t.view, catalog: [greeterModule], sections: t.sections, host, store: t.store, vaultState: () => "none", onMoved: () => moved++ })
      const info = mover.info()
      const kinds = Object.fromEntries(info.entries.map((e) => [e.key, [e.kind, e.movable, e.secret]]))
      expect(kinds).toEqual({
        ANTHROPIC_API_KEY: ["setting", true, true],
        SERVE_PORT: ["bootstrap", false, false],
        STT_SHERPA_MODLE: ["unknown", false, false],
        STT_SHERPA_THREADS: ["setting", true, false],
        STT_SHERPA_VAD_THRESHOLD: ["setting", false, false]
      })
      expect(info.entries.find((e) => e.key === "ANTHROPIC_API_KEY")?.page).toEqual({ path: ["language-model", "provider"], title: "Language model › Provider" })
      // A bootstrap, an unknown and a process variable are refused; the rest moves.
      const result = yield* mover.move(["ANTHROPIC_API_KEY", "STT_SHERPA_THREADS", "SERVE_PORT", "STT_SHERPA_MODLE", "STT_SHERPA_VAD_THRESHOLD"])
      expect(result.ok).toBe(false)
      expect(result.moved).toEqual(["ANTHROPIC_API_KEY", "STT_SHERPA_THREADS"])
      if (!result.ok) {
        expect(result.error.message).toContain("SERVE_PORT cannot be set in the settings")
        expect(result.error.message).toContain("STT_SHERPA_VAD_THRESHOLD comes from the process environment")
      }
      expect(moved).toBe(1)
      expect(t.store.secrets().assistant.ANTHROPIC_API_KEY).toBe(SECRET)
      expect(t.store.settings().assistant.STT_SHERPA_THREADS).toBe("3")
      expect(statSync(join(t.dir, "data", "secrets.json")).mode & 0o777).toBe(0o600)
      // The providers read them from the saved settings now.
      const threads = yield* Effect.gen(function*() {
        return yield* Config.Int("STT_SHERPA_THREADS")
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, t.sections.configProvider()))
      expect(threads).toBe(3)
      // The field re-resolves: saved, not locked.
      const field = t.sections.list().flatMap((s) => s.form.fields).find((f) => f.key === "ANTHROPIC_API_KEY")!
      expect(field.locked).toBeUndefined()
      expect(field.source).toBe("saved")
    }))
    expect(t.lines.join("\n")).not.toContain(SECRET)
  })

  it("an invalid value in .env is refused without echoing it", async () => {
    const t = await moverSetup("STT_SHERPA_EAGER_SILENCE_MS=fast-please\n", "none")
    await t.run(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [], persistence: t.store.modulePersistence, env: t.view.record })
      const mover = makeEnvMover({ view: t.view, catalog: [], sections: t.sections, host, store: t.store, vaultState: () => "none", onMoved: () => {} })
      const result = yield* mover.move(["STT_SHERPA_EAGER_SILENCE_MS"])
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain("fast-please")
      expect(t.view.get("STT_SHERPA_EAGER_SILENCE_MS")).toBe("fast-please")
    }))
  })
})

// ---------------------------------------------------------------------------
// Through serve mode and the protocol

let servers: Array<TestServer> = []
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) await s.close()
})

let seq = 0
type WithoutId<M> = M extends unknown ? Omit<M, "requestId"> : never
const request = async (client: ScriptedClient, message: WithoutId<Extract<ClientMessage, { readonly requestId: string }>>) => {
  const requestId = `e${++seq}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from })
}

describe("serve: settings from outside", () => {
  const startWithEnv = async (text: string) => {
    const dir = tmp("pva-serve-env-")
    const envPath = join(dir, ".env")
    writeFileSync(envPath, text)
    chmodSync(envPath, 0o600)
    const envView = makeEnvView({ processEnv: {}, files: [{ path: envPath, text }] })
    const stt = controlledStt()
    const llm = scriptedLlm((t) => `You said: ${t}.`)
    const server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), envView, dataDir: join(dir, "data") })
    servers.push(server)
    return { server, envPath }
  }
  const connect = async (server: TestServer) => {
    const c = await ScriptedClient.connect({ url: server.url })
    clients.push(c)
    return c
  }

  it("fields show the .env file and line; the snapshot lists the variables; an admin moves them, others are refused", async () => {
    const { server, envPath } = await startWithEnv(`# keys\nANTHROPIC_API_KEY=${SECRET}\nSTT_SHERPA_AGC=false\n`)
    const a = await connect(server)
    const welcome = await a.hello()
    const agc = welcome.snapshot.sections.flatMap((s) => s.form.fields).find((f) => f.key === "STT_SHERPA_AGC")!
    expect(agc.source).toBe("env-file")
    expect(agc.locked).toEqual({ reason: `Set by STT_SHERPA_AGC in ${envPath}, line 3`, file: envPath, line: 3 })
    expect(welcome.snapshot.env?.entries.map((e) => [e.key, e.line, e.movable])).toEqual([
      ["ANTHROPIC_API_KEY", 2, true],
      ["STT_SHERPA_AGC", 3, true]
    ])

    // A vault exists: page `b` is not admin and is refused.
    expect((await request(a, { type: "vault.setup", password: PASSWORD })).ok).toBe(true)
    const b = await connect(server)
    await b.hello()
    expect(await request(b, { type: "settings.moveFromEnv", keys: ["STT_SHERPA_AGC"] })).toMatchObject({ ok: false, error: { code: "locked" } })
    expect(readFileSync(envPath, "utf8")).toContain("STT_SHERPA_AGC=false")

    // The admin page moves both: the key into the vault, the switch into settings.json.
    const from = a.messages.length
    expect(await request(a, { type: "settings.moveFromEnv", keys: ["ANTHROPIC_API_KEY", "STT_SHERPA_AGC"] })).toMatchObject({ ok: true })
    const file = readFileSync(envPath, "utf8")
    expect(file).not.toContain(SECRET)
    expect(file).toMatch(/# ANTHROPIC_API_KEY moved to the settings UI on \d{4}-\d{2}-\d{2}/)
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
    const backups = readdirSync(join(envPath, "..")).filter((n) => n.startsWith(".env.bak-"))
    expect(backups).toHaveLength(1)
    const settings = JSON.parse(readFileSync(join(server.dataDir, "settings.json"), "utf8"))
    expect(settings.assistant).toEqual({ STT_SHERPA_AGC: false })
    expect(readFileSync(join(server.dataDir, "settings.json"), "utf8")).not.toContain(SECRET)
    expect(server.handle.vault.secrets()?.assistant.ANTHROPIC_API_KEY).toBe(SECRET)

    // The fields re-resolve and the env list is sent again.
    const env = await a.waitFor("env", () => true, { from })
    expect(env.env.entries).toEqual([])
    const changed = await a.waitFor("section.changed", (m) => m.section.form.fields.some((f) => f.key === "STT_SHERPA_AGC" && f.source === "saved"), { from })
    expect(changed.section.form.values.STT_SHERPA_AGC).toBe(false)
    // No message to any page ever carried the value.
    for (const m of [...a.messages, ...b.messages]) expect(JSON.stringify(m)).not.toContain(SECRET)
  })

  it("a secret is refused while the vault is locked (after a restart)", async () => {
    const { server, envPath } = await startWithEnv(`ANTHROPIC_API_KEY=${SECRET}\n`)
    const a = await connect(server)
    await a.hello()
    expect((await request(a, { type: "vault.setup", password: PASSWORD })).ok).toBe(true)
    // Locking also ends admin access, so the request is refused for both reasons; the file stays.
    expect((await request(a, { type: "vault.lock" })).ok).toBe(true)
    expect(await request(a, { type: "settings.moveFromEnv", keys: ["ANTHROPIC_API_KEY"] })).toMatchObject({ ok: false, error: { code: "locked" } })
    expect(readFileSync(envPath, "utf8")).toContain(SECRET)
  })
})

// ---------------------------------------------------------------------------
// CLI modes

describe("CLI modes on the saved settings", () => {
  const read = (provider: ConfigProvider.ConfigProvider, key: string) =>
    Effect.runPromise(Effect.gen(function*() {
      return yield* Config.String(key).pipe(Config.withDefault("(default)"))
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider)))

  it("environment > saved > default", async () => {
    const dir = tmp("pva-cli-")
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 2, modules: {}, assistant: { LLM_PROVIDER: "anthropic", STT_SHERPA_MODEL: "whisper-turbo" } }))
    const store = await Effect.runPromise(loadSettingsStore(dir, { readOnly: true }))
    const provider = cliConfigProvider(store, { LLM_PROVIDER: "fake", EMPTY: "" })
    expect(await read(provider, "LLM_PROVIDER")).toBe("fake")
    expect(await read(provider, "STT_SHERPA_MODEL")).toBe("whisper-turbo")
    expect(await read(provider, "TTS_PROVIDER")).toBe("(default)")
  })

  const withVault = async () => {
    const dir = tmp("pva-cli-vault-")
    const vaultPath = join(dir, "vault.enc")
    const vault = await openVault({ path: vaultPath, kdf: cheapKdf })
    expect((await vault.setup(PASSWORD, { modules: {}, assistant: { ANTHROPIC_API_KEY: SECRET } })).ok).toBe(true)
    return { dir, vaultPath }
  }
  const quiet = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect.pipe(Effect.provideService(References.MinimumLogLevel, "None")))

  it("PVA_VAULT_PASSWORD unlocks the vault: the keys are read behind the environment", async () => {
    const { dir, vaultPath } = await withVault()
    const loaded = await quiet(loadCliSettings({ env: { PVA_VAULT_PASSWORD: PASSWORD }, dataDir: dir, vaultPath }))
    expect(loaded.settings.vaultState).toBe("unlocked")
    expect(await read(loaded.configProvider, "ANTHROPIC_API_KEY")).toBe(SECRET)
  })

  it("on a terminal the password is asked for; Enter skips, and a missing key says why", async () => {
    const { dir, vaultPath } = await withVault()
    let asked = 0
    const typed = await quiet(loadCliSettings({ env: {}, dataDir: dir, vaultPath, prompt: async () => (asked++, PASSWORD) }))
    expect([asked, typed.settings.vaultState]).toEqual([1, "unlocked"])
    expect(await read(typed.configProvider, "ANTHROPIC_API_KEY")).toBe(SECRET)
    const skipped = await quiet(loadCliSettings({ env: {}, dataDir: dir, vaultPath, prompt: async () => "" }))
    expect(skipped.settings.vaultState).toBe("locked")
    expect(await read(skipped.configProvider, "ANTHROPIC_API_KEY")).toBe("(default)")
    expect(explainMissingKey("ANTHROPIC_API_KEY is not set", skipped.settings)).toContain("key vault")
    expect(explainMissingKey("ANTHROPIC_API_KEY is not set", typed.settings)).toBe("ANTHROPIC_API_KEY is not set")
  })

  it("without a terminal it never asks", async () => {
    const { dir, vaultPath } = await withVault()
    const loaded = await quiet(loadCliSettings({ env: {}, dataDir: dir, vaultPath }))
    expect(loaded.settings.vaultState).toBe("locked")
  })
})
