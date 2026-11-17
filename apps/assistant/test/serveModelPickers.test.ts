// The model pickers' HTTP API through serve mode (docs/MODEL-PICKERS.md §4): admin only, the catalogs of both kinds,
// refresh and the time limit over HTTP, favourites (add, rename, remove, kept across a restart, per kind, the limit),
// and recogniser downloads through the Models page's jobs. Model lists come from local stand-in servers through the
// real adapters; downloads are faked (no network).
import type { ToolId } from "@pva/protocol"
import { MAX_FAVOURITES } from "@pva/protocol"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PresetDownloader } from "../src/serve/models.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { type FakeApi, fakeOpenAiApi, homeModels } from "./support/fakeModelApis.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, type TestServer, TEST_ADMIN_PASSWORD } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

const OR_KEY = "sk-or-test-SECRET-abcdef0123456789"

let servers: Array<TestServer> = []
const clients: Array<ScriptedClient> = []
const apis: Array<FakeApi> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) await s.close()
  servers = []
  for (const a of apis.splice(0)) await a.close()
})

/** Recogniser presets "installed" in memory; a download steps every 20 ms unless cancelled. */
const fakeDownloaders = (installed: Set<string>, steps = 10): Readonly<Record<ToolId, PresetDownloader>> => {
  const one = (tool: ToolId): PresetDownloader => ({
    installed: (name) => installed.has(`${tool}:${name}`),
    download: (name, { signal, onProgress }) =>
      new Promise((resolve, reject) => {
        let step = 0
        const tick = () => {
          if (signal.aborted) return reject(new Error("Cancelled"))
          step++
          onProgress({ phase: "download", done: step * 1000, total: steps * 1000, archive: name })
          if (step >= steps) {
            installed.add(`${tool}:${name}`)
            return resolve(undefined)
          }
          setTimeout(tick, 20)
        }
        setTimeout(tick, 20)
      }),
    remove: async (name) => {
      installed.delete(`${tool}:${name}`)
      return { removed: [name] }
    }
  })
  return { "stt-models": one("stt-models"), "tts-models": one("tts-models") }
}

const start = async (options: { readonly env?: Record<string, string>; readonly dataDir?: string; readonly listTimeoutMs?: number; readonly steps?: number } = {}) => {
  const openrouter = await fakeOpenAiApi()
  apis.push(openrouter)
  const installed = new Set(["stt-models:parakeet-v2"])
  const server = await startTestServer({
    build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm((t) => `You said: ${t}.`).llm }),
    env: { OPENROUTER_API_KEY: OR_KEY, OPENROUTER_BASE_URL: `${openrouter.url}/api/v1`, STT_SHERPA_MODEL_DIR: mkdtempSync(join(tmpdir(), "pva-stt-")), ...options.env },
    modelDownloaders: fakeDownloaders(installed, options.steps),
    freeBytes: async () => 50e9,
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.listTimeoutMs !== undefined ? { modelListTimeoutMs: options.listTimeoutMs } : {})
  })
  servers.push(server)
  const admin = await ScriptedClient.connect({ url: server.url })
  clients.push(admin)
  const { token } = await admin.admin(TEST_ADMIN_PASSWORD)
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${server.url}/api/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
    const text = await response.text()
    return { status: response.status, text, data: text === "" ? undefined : JSON.parse(text) as any }
  }
  return { server, api, openrouter, installed, token }
}

const fav = (key: string) => `favourites/${encodeURIComponent(key)}`

describe("model picker API: access", () => {
  it("is admin only, refuses another origin, and names unknown kinds, paths and methods", async () => {
    const { server, api } = await start()
    for (const path of ["models/llm", "models/stt", "models/llm/providers", "models/llm/favourites"]) {
      const anonymous = await fetch(`${server.url}/api/${path}`)
      expect(anonymous.status).toBe(401)
      expect((await anonymous.json() as any).error.code).toBe("admin_required")
      const wrong = await fetch(`${server.url}/api/${path}`, { headers: { Authorization: "Bearer aaaaaaaaaaaaaaaaaaaaaaaa" } })
      expect(wrong.status).toBe(401)
    }
    expect((await fetch(`${server.url}/api/models/llm`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401)
    expect((await api("GET", "models/llm", undefined, { Origin: "https://evil.example" })).status).toBe(403)
    const kind = await api("GET", "models/tts")
    expect([kind.status, kind.data.error.code]).toEqual([404, "unknown_kind"])
    expect((await api("POST", "models/llm", {})).status).toBe(405)
    expect((await api("GET", "models/llm/elsewhere")).data.error.code).toBe("not_found")
    const provider = await api("GET", "models/llm?provider=nope")
    expect([provider.status, provider.data.error.code]).toEqual([404, "unknown_provider"])
  })
})

describe("model picker API: catalogs", () => {
  it("language models: every account with its state; OpenRouter's list through the adapter; no key in any answer", async () => {
    const { api, openrouter } = await start()
    const { status, text, data } = await api("GET", "models/llm")
    expect(status).toBe(200)
    expect(data.kind).toBe("llm")
    expect(data.providers.map((p: any) => [p.provider.id, p.provider.status])).toEqual([
      ["anthropic", "needs_key"],
      ["claude-subscription", "needs_setup"],
      ["openrouter", "ready"],
      ["home-model", "needs_address"],
      ["offline", "ready"]
    ])
    const or = data.providers[2]
    expect(or.models.map((m: any) => m.key)).toEqual(["openrouter:openai/gpt-oss-20b", "openrouter:meta-llama/llama-3.3-70b-instruct:free"])
    expect(or.provider.keyField).toBe("OPENROUTER_API_KEY")
    expect(text).not.toContain(OR_KEY)
    expect(openrouter.lists()).toBe(1)
    // The migrated assistant answers offline: it is the offline row's user.
    expect(data.providers[4].models[0].usedBy.length).toBeGreaterThan(0)
    // Cached: no new fetch; `refresh=1` fetches; `providers` never fetches.
    await api("GET", "models/llm?provider=openrouter")
    expect(openrouter.lists()).toBe(1)
    await api("GET", "models/llm?provider=openrouter&refresh=1")
    expect(openrouter.lists()).toBe(2)
    const providers = await api("GET", "models/llm/providers")
    expect(providers.data.providers.map((p: any) => p.id)).toEqual(["anthropic", "claude-subscription", "openrouter", "home-model", "offline"])
    expect(openrouter.lists()).toBe(2)
  })

  it("a home server that does not answer gives up at the time limit without holding up the other accounts", async () => {
    const home = await fakeOpenAiApi(homeModels)
    apis.push(home)
    home.behave({ kind: "hang" })
    const { api } = await start({ env: { HOME_MODEL_BASE_URL: home.url }, listTimeoutMs: 300 })
    const started = Date.now()
    const { data } = await api("GET", "models/llm")
    expect(Date.now() - started).toBeLessThan(3_000)
    const byId = (id: string) => data.providers.find((p: any) => p.provider.id === id)
    expect(byId("home-model").provider.status).toBe("error")
    expect(byId("home-model").error.code).toBe("timeout")
    expect(byId("home-model").provider.customModel).toBeDefined()
    expect(byId("openrouter").models).toHaveLength(2)
  })

  it("recogniser models: the presets on this machine with their state; Deepgram without its key", async () => {
    const { api } = await start()
    const { data } = await api("GET", "models/stt")
    expect(data.providers.map((p: any) => [p.provider.id, p.provider.status])).toEqual([["sherpa", "ready"], ["deepgram", "needs_key"]])
    const pv2 = data.providers[0].models.find((m: any) => m.model.modelId === "parakeet-v2")
    expect([pv2.local.state, pv2.selectable, pv2.local.ramMb]).toEqual(["installed", true, 1050])
    expect(data.providers[0].models.find((m: any) => m.model.modelId === "whisper-turbo").local.state).toBe("not_installed")
  })
})

describe("model picker API: favourites", () => {
  it("adds (name from the list), renames, removes; per kind; kept in the data directory across a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-model-favs-"))
    const { api, server } = await start({ dataDir })
    expect((await api("GET", "models/llm/favourites")).data).toEqual({ favourites: [] })
    await api("GET", "models/llm")
    const added = await api("PUT", `models/llm/${fav("openrouter:openai/gpt-oss-20b")}`)
    expect(added.status).toBe(200)
    expect(added.data.favourite).toMatchObject({ model: { provider: "openrouter", modelId: "openai/gpt-oss-20b" }, key: "openrouter:openai/gpt-oss-20b", name: "OpenAI: gpt-oss-20b" })
    // Idempotent; a name renames.
    expect((await api("PUT", `models/llm/${fav("openrouter:openai/gpt-oss-20b")}`)).data.favourites).toHaveLength(1)
    expect((await api("PUT", `models/llm/${fav("openrouter:openai/gpt-oss-20b")}`, { name: "Small GPT" })).data.favourite.name).toBe("Small GPT")
    // A provider without a key can be a favourite too (its name is the id).
    expect((await api("PUT", `models/llm/${fav("home-model:llama3.1:8b")}`)).data.favourite.name).toBe("llama3.1:8b")
    expect((await api("PUT", `models/stt/${fav("sherpa:whisper-turbo")}`)).data.favourite.name).toBe("Whisper turbo")
    const list = await api("GET", "models/llm")
    expect(list.data.providers[2].models[0].favourite).toBe(true)
    expect((await api("GET", "models/stt")).data.providers[0].models.find((m: any) => m.key === "sherpa:whisper-turbo").favourite).toBe(true)
    // Errors.
    expect((await api("PUT", `models/llm/${fav("nope:x")}`)).data.error.code).toBe("unknown_provider")
    expect((await api("PUT", `models/llm/${fav("sherpa:parakeet-v2")}`)).data.error.code).toBe("unknown_provider")
    expect((await api("PUT", `models/llm/${fav("no-colon")}`)).status).toBe(400)
    expect((await api("PUT", `models/llm/${fav("openrouter: spaced ")}`)).status).toBe(400)
    expect((await api("PUT", `models/llm/${fav("openrouter:x")}`, { name: "" })).status).toBe(400)
    const file = join(dataDir, "model-favourites-llm.json")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, "utf8")).favourites.map((f: any) => f.model.modelId)).toEqual(["openai/gpt-oss-20b", "llama3.1:8b"])
    expect(existsSync(join(dataDir, "model-favourites-stt.json"))).toBe(true)

    const removed = await api("DELETE", `models/llm/${fav("home-model:llama3.1:8b")}`)
    expect(removed.data.favourites.map((f: any) => f.key)).toEqual(["openrouter:openai/gpt-oss-20b"])
    expect((await api("DELETE", `models/llm/${fav("home-model:llama3.1:8b")}`)).status).toBe(404)
    expect((await api("POST", `models/llm/${fav("home-model:llama3.1:8b")}`, {})).status).toBe(405)

    await server.close()
    servers = servers.filter((s) => s !== server)
    const again = await start({ dataDir })
    expect((await again.api("GET", "models/llm/favourites")).data.favourites.map((f: any) => [f.key, f.name])).toEqual([["openrouter:openai/gpt-oss-20b", "Small GPT"]])
    expect((await again.api("GET", "models/stt/favourites")).data.favourites.map((f: any) => f.key)).toEqual(["sherpa:whisper-turbo"])
  })

  it(`refuses more than ${MAX_FAVOURITES}`, async () => {
    const { api } = await start()
    for (let i = 0; i < MAX_FAVOURITES; i++) expect((await api("PUT", `models/llm/${fav(`home-model:m${i}`)}`, { name: `M${i}` })).status).toBe(200)
    const over = await api("PUT", `models/llm/${fav("home-model:one-more")}`, { name: "One more" })
    expect([over.status, over.data.error.code]).toEqual([409, "limit_reached"])
  })
})

describe("model picker API: recogniser downloads", () => {
  it("downloads a preset as the Models page's job, shows its progress in the list, then it can be chosen; cancel; refusals", async () => {
    const { api } = await start({ steps: 15 })
    const whisper = { provider: "sherpa", modelId: "whisper-turbo" }
    const started = await api("POST", "models/stt/download", { model: whisper })
    expect(started.status).toBe(202)
    expect(started.data.job).toMatchObject({ tool: "stt-models", target: "whisper-turbo", state: "running" })
    expect((await api("POST", "models/stt/download", { model: whisper })).data.error.code).toBe("busy")
    await sleep(80)
    const during = (await api("GET", "models/stt")).data.providers[0].models.find((m: any) => m.key === "sherpa:whisper-turbo")
    expect(during.local.state).toBe("downloading")
    expect(during.local.job.id).toBe(started.data.job.id)
    expect(during.selectable).toBe(false)
    const polled = await api("GET", `jobs/${started.data.job.id}`)
    expect(polled.data.job.progress.done).toBeGreaterThan(0)
    for (let i = 0; i < 100 && (await api("GET", `jobs/${started.data.job.id}`)).data.job.state === "running"; i++) await sleep(30)
    expect((await api("GET", `jobs/${started.data.job.id}`)).data.job.state).toBe("succeeded")
    const after = (await api("GET", "models/stt")).data.providers[0].models.find((m: any) => m.key === "sherpa:whisper-turbo")
    expect([after.local.state, after.selectable]).toEqual(["installed", true])
    expect((await api("POST", "models/stt/download", { model: whisper })).data.error.code).toBe("already_installed")

    const ultra = { provider: "sherpa", modelId: "parakeet-ultra" }
    const second = await api("POST", "models/stt/download", { model: ultra })
    expect(second.status).toBe(202)
    const cancelled = await api("POST", "models/stt/download/cancel", { model: ultra })
    expect([cancelled.status, cancelled.data.cancelled]).toEqual([200, true])
    for (let i = 0; i < 50 && (await api("GET", `jobs/${second.data.job.id}`)).data.job.state === "running"; i++) await sleep(20)
    expect((await api("GET", `jobs/${second.data.job.id}`)).data.job.state).toBe("cancelled")
    expect((await api("POST", "models/stt/download/cancel", { model: ultra })).status).toBe(404)

    expect((await api("POST", "models/stt/download", { model: { provider: "deepgram", modelId: "flux-general-en" } })).status).toBe(400)
    expect((await api("POST", "models/stt/download", { model: { provider: "sherpa", modelId: "nope" } })).data.error.code).toBe("unknown_model")
    expect((await api("POST", "models/stt/download", { model: { provider: "nope", modelId: "x" } })).data.error.code).toBe("unknown_provider")
    expect((await api("POST", "models/llm/download", { model: { provider: "openrouter", modelId: "x" } })).status).toBe(404)
    expect((await api("POST", "models/stt/download", { model: "whisper-turbo" })).status).toBe(400)
    expect((await api("GET", "models/stt/download")).status).toBe(405)
  })
})
