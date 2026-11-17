// The settings screen's server side (docs/SETTINGS-UI.md §4): placement, flat storage and its v1 → v2 migration,
// visibleWhen, cross-field checks with "Save anyway", field sources, reloadPendingFor and the vault's lock reason.
// Driven by the scripted client against the real server with injected providers.
import type { ClientMessage, SettingsSection } from "@pva/protocol"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { flattenSections } from "../src/serve/flatten.ts"
import { readSettingsFile, readStoredSettings } from "../src/serve/SettingsStore.ts"
import { readVaultSecrets } from "../src/serve/Vault.ts"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, type TestServer, TEST_ADMIN_PASSWORD } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 20_000 })

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

const helloed = async (server: TestServer) => {
  const client = await ScriptedClient.connect({ url: server.url })
  clients.push(client)
  // Every change is admin only since protocol 5: these pages log in (`welcome.snapshot` is the admin snapshot).
  const welcome = await client.admin(TEST_ADMIN_PASSWORD)
  return { client, welcome }
}

type WithoutId<M> = M extends unknown ? Omit<M, "requestId"> : never
let seq = 0
const request = async (client: ScriptedClient, message: WithoutId<Extract<ClientMessage, { readonly requestId: string }>>) => {
  const requestId = `s${++seq}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from })
}

const section = (sections: ReadonlyArray<SettingsSection>, id: string) => sections.find((s) => s.id === id)!
const field = (s: SettingsSection, key: string) => s.form.fields.find((f) => f.key === key)!

describe("flat storage", () => {
  it("a version-1 settings file is migrated at start: values by key, the original kept as a backup", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-serve-"))
    const v1 = {
      version: 1,
      modules: { greeter: { enabled: true, settings: { greeting: "hoi" } } },
      sections: {
        listening: { STT_SHERPA_FINAL_SILENCE_MS: 700, STT_SHERPA_MODEL: "nemotron-3.5" },
        voices: { DEFAULT_VOICE: "natural" },
        "language-model": { LLM_PROVIDER: "anthropic" }
      }
    }
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify(v1))
    const server = await start({ dataDir })
    const { welcome } = await helloed(server)
    expect(section(welcome.snapshot.sections, "stt-timing").form.values.STT_SHERPA_FINAL_SILENCE_MS).toBe(700)
    // The renamed preset is still understood.
    expect(section(welcome.snapshot.sections, "stt-engine").form.values.STT_SHERPA_MODEL).toBe("nemotron-320")
    // DEFAULT_VOICE has no field any more; it stays in the file and the voice migration reads it (docs/VOICE-PROVIDERS.md §6.2).
    expect(section(welcome.snapshot.sections, "language-model").form.values.LLM_PROVIDER).toBe("anthropic")
    expect(welcome.snapshot.modules[0]!.settings.values.greeting).toBe("hoi")
    const written = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"))
    // Written as version 4 (docs/ASSISTANTS.md §6): the flat keys stay, and the one assistant has them.
    expect(written).toMatchObject({
      version: 4,
      modules: v1.modules,
      assistant: { STT_SHERPA_FINAL_SILENCE_MS: 700, STT_SHERPA_MODEL: "nemotron-3.5", DEFAULT_VOICE: "natural", LLM_PROVIDER: "anthropic" },
      assistants: { order: ["assistant"] },
      devices: {},
      migration: { from: 1 }
    })
    expect(written.assistants.byId.assistant).toMatchObject({
      llm: { account: "anthropic" },
      hearing: { finalSilenceMs: 700, model: "nemotron-320" },
      voice: { provider: "sherpa", voiceId: "kokoro-af_heart" },
      modules: { greeter: { on: true, offTools: [] } }
    })
    expect(JSON.parse(readFileSync(join(dataDir, "settings.json.v1-backup"), "utf8"))).toEqual(v1)
  })

  it("migration is collision-safe: the version-1 owner of a key wins, else the later section, and it is reported", () => {
    const read = readSettingsFile({
      version: 1,
      modules: {},
      sections: {
        listening: { STT_PROVIDER: "deepgram", STT_SHERPA_AGC: false, X_EXTRA: 1 },
        speech: { STT_PROVIDER: "sherpa" },
        other: { X_EXTRA: 2, STT_SHERPA_AGC: false }
      }
    })!
    expect(read.migrated).toBe(true)
    // STT_PROVIDER belonged to "speech"; X_EXTRA had no owner, so the later section wins; equal values are no collision.
    expect(read.file.assistant).toEqual({ STT_PROVIDER: "sherpa", STT_SHERPA_AGC: false, X_EXTRA: 2 })
    expect(read.problems).toHaveLength(2)
    expect(read.problems.join(" ")).toContain("STT_PROVIDER was saved in two sections (listening, speech)")
    expect(read.problems.join(" ")).not.toContain("deepgram")
    // The owner wins even when it comes first.
    expect(flattenSections({ speech: { STT_PROVIDER: "sherpa" }, listening: { STT_PROVIDER: "deepgram" } }, "x").flat).toEqual({ STT_PROVIDER: "sherpa" })
    // A version-2 file is read as version 3 (then migrated to 4); anything else is not a settings file.
    expect(readStoredSettings({ version: 2, modules: {}, assistant: { A: 1 } })).toEqual({
      file: { version: 3, from: 2, file: { version: 3, modules: {}, assistant: { A: 1 }, frontends: {}, devices: {} } },
      migrated: true,
      problems: []
    })
    expect(readSettingsFile({ version: 2, modules: {}, assistant: { A: 1 } })).toMatchObject({ file: { version: 4, assistant: { A: 1 } }, migrated: true })
    expect(readSettingsFile({ version: 5 })).toBeUndefined()
    expect(readSettingsFile({ version: 4, devices: [] })).toBeUndefined()
    expect(readSettingsFile({ version: 3, frontends: [] })).toBeUndefined()
  })

  it("an older vault's per-section secrets are read flat", () => {
    expect(readVaultSecrets({ modules: { m: { t: "x" } }, sections: { "language-model": { ANTHROPIC_API_KEY: "k" }, speech: { DEEPGRAM_API_KEY: "d" } } }))
      .toEqual({ modules: { m: { t: "x" } }, assistant: { ANTHROPIC_API_KEY: "k", DEEPGRAM_API_KEY: "d" } })
    expect(readVaultSecrets({ modules: {}, assistant: { A: "1" } })).toEqual({ modules: {}, assistant: { A: "1" } })
    expect(readVaultSecrets({ modules: {}, assistant: { A: 1 } })).toBeUndefined()
  })

  it("a save replaces only its section's keys, and a field keeps its value wherever it is shown", async () => {
    const server = await start()
    const { client } = await helloed(server)
    expect((await request(client, { type: "settings.update", sectionId: "voices", patch: { values: { ASSISTANT_VOICE: "cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" }, secrets: {} }, confirmWarnings: true })).ok).toBe(true)
    expect((await request(client, { type: "settings.update", sectionId: "stt-mic", patch: { values: { STT_SHERPA_AGC: false }, secrets: {} } })).ok).toBe(true)
    expect((await request(client, { type: "settings.update", sectionId: "voices", patch: { values: { ASSISTANT_VOICE: null }, secrets: {} } })).ok).toBe(true)
    expect(JSON.parse(readFileSync(join(server.dataDir, "settings.json"), "utf8")).assistant).toEqual({ STT_SHERPA_AGC: false })
    expect(existsSync(join(server.dataDir, "settings.json.v1-backup"))).toBe(false)
  })
})

describe("field semantics", () => {
  it("visibleWhen: a hidden field is not validated or saved; choosing the provider in the same save shows it", async () => {
    const server = await start()
    const { client, welcome } = await helloed(server)
    const llm = section(welcome.snapshot.sections, "language-model")
    expect(field(llm, "ANTHROPIC_MODEL").visibleWhen).toEqual({ key: "LLM_PROVIDER", in: ["anthropic"] })
    expect(section(welcome.snapshot.sections, "stt-deepgram").visibleWhen).toEqual({ key: "STT_PROVIDER", in: ["deepgram"] })
    // With the offline stand-in chosen, a (bad) model value for the Claude API is ignored, not refused.
    const hidden = await request(client, { type: "settings.update", sectionId: "language-model", patch: { values: { ANTHROPIC_MODEL: 7 as never }, secrets: {} } })
    expect(hidden.ok).toBe(true)
    const shown = await request(client, {
      type: "settings.update",
      sectionId: "language-model",
      patch: { values: { LLM_PROVIDER: "anthropic", ANTHROPIC_MODEL: 7 as never }, secrets: {} }
    })
    expect(shown.error?.fieldErrors?.map((e) => e.key)).toEqual(["ANTHROPIC_MODEL"])
  })

  it("a cross-field error refuses the save under its field: the turn must end after the early reply", async () => {
    const server = await start()
    const { client } = await helloed(server)
    const result = await request(client, {
      type: "settings.update",
      sectionId: "stt-timing",
      patch: { values: { STT_SHERPA_EAGER_SILENCE_MS: 800, STT_SHERPA_FINAL_SILENCE_MS: 600 }, secrets: {} }
    })
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_settings", fieldErrors: [{ key: "STT_SHERPA_FINAL_SILENCE_MS" }] } })
    expect(result.error?.fieldErrors?.[0]?.message).toContain("800 ms")
  })

  it("warnings ask first; with confirmWarnings the save goes through and the form keeps the warning; adding the key clears it", async () => {
    const server = await start()
    const { client } = await helloed(server)
    const deepgram = { type: "settings.update", sectionId: "stt-engine", patch: { values: { STT_PROVIDER: "deepgram" }, secrets: {} } } as const
    const asked = await request(client, deepgram)
    expect(asked).toMatchObject({ ok: false, error: { code: "invalid_settings", warnings: [{ key: "STT_PROVIDER" }] } })
    expect(asked.error?.fieldErrors).toBeUndefined()
    expect(asked.error?.warnings?.[0]?.message).toContain("no Deepgram key")
    expect(JSON.parse(readFileSync(join(server.dataDir, "settings.json"), "utf8")).assistant, "nothing was saved").toEqual({})

    const from = client.messages.length
    expect((await request(client, { ...deepgram, confirmWarnings: true })).ok).toBe(true)
    const engine = await client.waitFor("section.changed", (m) => m.section.id === "stt-engine", { from })
    expect(engine.section.form.warnings?.[0]?.key).toBe("STT_PROVIDER")
    // The pages that depend on the provider are announced too.
    const announced = client.messages.slice(from).flatMap((m) => (m.type === "section.changed" ? [m.section.id] : []))
    expect(announced).toContain("stt-engine")

    // An unrelated save is not held up by the warning that is already there.
    expect((await request(client, { type: "settings.update", sectionId: "llm-behaviour", patch: { values: { SYSTEM_PROMPT: "Be brief." }, secrets: {} } })).ok).toBe(true)

    const keyFrom = client.messages.length
    expect((await request(client, { type: "settings.update", sectionId: "stt-deepgram", patch: { values: {}, secrets: { DEEPGRAM_API_KEY: "dg-key" } } })).ok).toBe(true)
    const cleared = await client.waitFor("section.changed", (m) => m.section.id === "stt-engine", { from: keyFrom })
    expect(cleared.section.form.warnings).toBeUndefined()
  })

  it("a hosted voice without its key warns; the Claude API without its key warns", async () => {
    const server = await start()
    const { client } = await helloed(server)
    const voices = await request(client, { type: "settings.update", sectionId: "voices", patch: { values: { ASSISTANT_VOICE: "cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" }, secrets: {} } })
    expect(voices.error?.warnings?.[0]).toMatchObject({ key: "ASSISTANT_VOICE" })
    expect(voices.error?.warnings?.[0]?.message).toContain("This voice speaks through Cartesia, but there is no Cartesia key")
    const key = await request(client, { type: "settings.update", sectionId: "voice-providers", patch: { values: {}, secrets: { CARTESIA_API_KEY: "car-key" } } })
    expect(key.ok).toBe(true)
    expect((await request(client, { type: "settings.update", sectionId: "voices", patch: { values: { ASSISTANT_VOICE: "cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" }, secrets: {} } })).ok).toBe(true)
    // A voice that is not a voice key is refused by the field itself.
    const bad = await request(client, { type: "settings.update", sectionId: "voices", patch: { values: { ASSISTANT_VOICE: "expressive" }, secrets: {} } })
    expect(bad.error?.fieldErrors?.[0]).toMatchObject({ key: "ASSISTANT_VOICE" })
    const llm = await request(client, { type: "settings.update", sectionId: "language-model", patch: { values: { LLM_PROVIDER: "anthropic" }, secrets: {} } })
    expect(llm.error?.warnings?.[0]).toMatchObject({ key: "ANTHROPIC_API_KEY" })
    const withKey = await request(client, {
      type: "settings.update",
      sectionId: "language-model",
      patch: { values: { LLM_PROVIDER: "anthropic" }, secrets: { ANTHROPIC_API_KEY: "sk-ant" } }
    })
    expect(withKey.ok).toBe(true)
  })

  it("field source: default, saved, .env and the process environment (locked)", async () => {
    const server = await start({
      env: { STT_SHERPA_AGC: "false", ASSISTANT_VOICE: "sherpa:en_US-lessac-medium" },
      envOrigin: (name) => (name === "STT_SHERPA_AGC" ? "env-file" : "env-process")
    })
    const { client } = await helloed(server)
    expect((await request(client, { type: "settings.update", sectionId: "stt-mic", patch: { values: { STT_SHERPA_VAD_THRESHOLD: 0.4 }, secrets: {} } })).ok).toBe(true)
    const { welcome } = await helloed(server)
    const mic = section(welcome.snapshot.sections, "stt-mic")
    expect(field(mic, "STT_SHERPA_AGC")).toMatchObject({ source: "env-file", locked: { reason: "Set by STT_SHERPA_AGC in .env" } })
    expect(field(mic, "STT_SHERPA_VAD_THRESHOLD").source).toBe("saved")
    expect(field(mic, "STT_SHERPA_AGC_MAX_GAIN_DB").source).toBe("default")
    expect(field(section(welcome.snapshot.sections, "voices"), "ASSISTANT_VOICE")).toMatchObject({
      source: "env-process",
      locked: { reason: "Set by ASSISTANT_VOICE in the environment" }
    })
    expect(field(section(welcome.snapshot.sections, "voice-providers"), "CARTESIA_API_KEY").source).toBe("default")
  })

  it("reloadPendingFor names every page with saved changes the engines do not use yet", async () => {
    const server = await start()
    const { client } = await helloed(server)
    await request(client, { type: "settings.update", sectionId: "stt-mic", patch: { values: { STT_SHERPA_AGC: false }, secrets: {} } })
    await request(client, { type: "settings.update", sectionId: "voices", patch: { values: { ASSISTANT_VOICE: "cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" }, secrets: {} }, confirmWarnings: true })
    await request(client, { type: "settings.update", sectionId: "stt-mic", patch: { values: { STT_SHERPA_VAD_THRESHOLD: 0.3 }, secrets: {} } })
    // A live field does not need a reload.
    await request(client, { type: "settings.update", sectionId: "llm-behaviour", patch: { values: { SYSTEM_PROMPT: "Be brief." }, secrets: {} } })
    expect(server.handle.engine.status().reloadPendingFor).toEqual(["speech/microphone", "voices/overview"])
    expect((await request(client, { type: "engine.reload" })).ok).toBe(true)
    expect(server.handle.engine.status()).toMatchObject({ reloadPending: false, reloadPendingFor: [] })
  })
})

describe("vault lock reason", () => {
  it("locked since the start, or by a page", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-serve-"))
    const first = await start({ dataDir })
    const { client: a } = await helloed(first)
    expect((await request(a, { type: "vault.setup", password: "correct horse battery" })).ok).toBe(true)
    const from = a.messages.length
    expect((await request(a, { type: "vault.lock" })).ok).toBe(true)
    expect((await a.waitFor("vault", (m) => m.vault.state === "locked", { from })).vault.lockReason).toBe("manual")
    a.close()
    await first.close()
    servers = servers.filter((s) => s !== first)
    const second = await start({ dataDir })
    const { welcome } = await helloed(second)
    expect(welcome.snapshot.vault).toMatchObject({ state: "locked", lockReason: "start" })
  })
})
