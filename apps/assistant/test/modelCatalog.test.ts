// The model pickers' catalog (docs/MODEL-PICKERS.md §3, §5) on its own: each provider's states, the lists fetched
// through the real adapters (llm-anthropic, llm-openai-compatible) from local stand-in servers, the cache (lifetime,
// refresh, a new key, the pause after a failure), the time limit, a failing provider next to working ones, the known
// models when Anthropic's list fails, the models assistants use that a list lacks, and the recogniser presets.
import type { Assistant, JobInfo, ProviderModels } from "@pva/protocol"
import { ConfigProvider, Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FAILED_RETRY_MS, LIST_MAX_AGE_MS, makeModelCatalog, type ModelCatalogOptions, PRESET_LANGUAGES, type SttItem, type SubscriptionView } from "../src/serve/ModelCatalog.ts"
import * as SherpaStt from "@pva/stt-sherpa"
import { anthropicModels, type FakeApi, fakeAnthropicApi, fakeOpenAiApi, homeModels } from "./support/fakeModelApis.ts"

vi.setConfig({ testTimeout: 20_000 })

const apis: Array<FakeApi> = []
afterEach(async () => {
  for (const a of apis.splice(0)) await a.close()
})
const track = async (api: Promise<FakeApi>) => {
  const a = await api
  apis.push(a)
  return a
}

const OR_KEY = "sk-or-test-SECRET-0123456789"
const AN_KEY = "sk-ant-test-SECRET-0123456789"

const assistant = (id: string, llm: Partial<Assistant["llm"]>, hearing: Partial<Assistant["hearing"]> = {}): Assistant =>
  ({ id, llm: { account: "offline", model: "", ...llm }, hearing: { engine: "sherpa", model: "parakeet-v2", ...hearing } }) as unknown as Assistant

const catalog = (env: Record<string, string>, extra: Partial<ModelCatalogOptions> & { clock?: { t: number } } = {}) => {
  const clock = extra.clock ?? { t: 1_800_000_000_000 }
  const options: ModelCatalogOptions = {
    configProvider: () => ConfigProvider.fromEnvRecord(env),
    vaultLocked: () => false,
    assistants: () => [],
    subscription: (): SubscriptionView => ({ state: "missing", enabled: false }),
    sttItems: (): ReadonlyArray<SttItem> => [],
    sttDownload: () => undefined,
    isFavourite: () => false,
    listTimeoutMs: 2_000,
    now: () => clock.t,
    ...extra
  }
  return { catalog: makeModelCatalog(options), clock }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const byId = (lists: ReadonlyArray<ProviderModels>, id: string) => lists.find((p) => p.provider.id === id)!

describe("model catalog: language model accounts", () => {
  it("lists every account with its state; one that is not set up has no models and says where to set it up", async () => {
    const { catalog: c } = catalog({})
    const lists = await run(c.models("llm", undefined, false))
    expect(lists.map((p) => [p.provider.id, p.provider.status])).toEqual([
      ["anthropic", "needs_key"],
      ["claude-subscription", "needs_setup"],
      ["openrouter", "needs_key"],
      ["home-model", "needs_address"],
      ["offline", "ready"]
    ])
    for (const p of lists.slice(0, 4)) {
      expect(p.models).toEqual([])
      expect(p.provider.settingsPath).toBe("shared/accounts")
      expect(p.provider.message).toMatch(/Shared settings › Language model accounts|switch it on/)
    }
    expect(byId(lists, "anthropic").provider.reason).toBe("missing")
    const offline = byId(lists, "offline")
    expect(offline.models.map((m) => [m.key, m.apply])).toEqual([["offline:stand-in", { llm: { account: "offline", model: "" } }]])
    expect(offline.provider.customModel).toBeUndefined()
    // Providers alone: the same states, nothing fetched.
    expect((await run(c.providers("llm"))).map((p) => p.status)).toEqual(lists.map((p) => p.provider.status))
  })

  it("says the vault is locked when a key may be in it", async () => {
    const { catalog: c } = catalog({}, { vaultLocked: () => true })
    const p = byId(await run(c.models("llm", "openrouter", false)), "openrouter").provider
    expect([p.status, p.reason]).toEqual(["needs_key", "vault_locked"])
  })

  it("OpenRouter: the adapter's list with context and price; only models that take tools; the key never in an answer", async () => {
    const api = await track(fakeOpenAiApi())
    const { catalog: c } = catalog({ OPENROUTER_API_KEY: OR_KEY, OPENROUTER_BASE_URL: `${api.url}/api/v1` })
    const [list] = await run(c.models("llm", "openrouter", false))
    expect(list!.provider.status).toBe("ready")
    expect(list!.provider.listSource).toBe("provider")
    expect(list!.provider.customModel?.placeholder).toBe("provider/model")
    expect(list!.models.map((m) => m.model.modelId)).toEqual(["openai/gpt-oss-20b", "meta-llama/llama-3.3-70b-instruct:free"])
    const gpt = list!.models[0]!
    expect(gpt.key).toBe("openrouter:openai/gpt-oss-20b")
    expect(gpt.apply).toEqual({ llm: { account: "openrouter", model: "openai/gpt-oss-20b" } })
    expect(gpt.badges.map((b) => b.label)).toEqual(["131k context", "$0.04 / $0.15 per M"])
    expect(gpt.llm?.pricing).toEqual({ inputPerMTok: 0.04, outputPerMTok: 0.15 })
    expect(list!.models[1]!.badges.map((b) => b.label)).toEqual(["66k context", "Free"])
    expect(api.requests[0]!.path).toBe("/api/v1/models")
    expect(api.requests[0]!.authorization).toBe(`Bearer ${OR_KEY}`)
    expect(JSON.stringify(list)).not.toContain(OR_KEY)
  })

  it("caches a list for its lifetime, fetches it again after it, at once with refresh, and for a new key", async () => {
    const api = await track(fakeOpenAiApi())
    const env: Record<string, string> = { OPENROUTER_API_KEY: OR_KEY, OPENROUTER_BASE_URL: `${api.url}/v1` }
    const { catalog: c, clock } = catalog(env)
    const first = byId(await run(c.models("llm", "openrouter", false)), "openrouter")
    expect(api.lists()).toBe(1)
    expect(first.fetchedAt).toBe(clock.t)
    clock.t += LIST_MAX_AGE_MS.openrouter - 1
    const again = byId(await run(c.models("llm", undefined, false)), "openrouter")
    expect(api.lists()).toBe(1)
    expect(again.stale).toBe(false)
    // The providers call never fetches.
    await run(c.providers("llm"))
    expect(api.lists()).toBe(1)
    clock.t += 2
    await run(c.models("llm", "openrouter", false))
    expect(api.lists()).toBe(2)
    await run(c.models("llm", "openrouter", true))
    expect(api.lists()).toBe(3)
    // Another key: another cache entry, fetched with the new key.
    env.OPENROUTER_API_KEY = `${OR_KEY}-2`
    await run(c.models("llm", "openrouter", false))
    expect(api.lists()).toBe(4)
    expect(api.requests.at(-1)!.authorization).toBe(`Bearer ${OR_KEY}-2`)
  })

  it("a refetch that fails keeps the older list (stale, with the error); after a failure it waits before asking again", async () => {
    const api = await track(fakeOpenAiApi())
    const { catalog: c, clock } = catalog({ OPENROUTER_API_KEY: OR_KEY, OPENROUTER_BASE_URL: `${api.url}/v1` })
    await run(c.models("llm", "openrouter", false))
    api.behave({ kind: "status", status: 401, body: JSON.stringify({ error: { message: `bad key ${OR_KEY}` } }) })
    // Older than its lifetime: the next request fetches it again, and that fails.
    clock.t += LIST_MAX_AGE_MS.openrouter
    const failed = byId(await run(c.models("llm", "openrouter", false)), "openrouter")
    expect(failed.provider.status).toBe("error")
    expect(failed.error?.code).toBe("unauthorized")
    expect(failed.provider.message).toMatch(/rejected the API key \(401\)/)
    expect(failed.stale).toBe(true)
    expect(failed.models).toHaveLength(2)
    expect(JSON.stringify(failed)).not.toContain(OR_KEY)
    // Still too old, but it failed a moment ago: no new request until FAILED_RETRY_MS has passed (a refresh asks).
    clock.t += FAILED_RETRY_MS - 1
    const lists = api.lists()
    await run(c.models("llm", "openrouter", false))
    expect(api.lists()).toBe(lists)
    clock.t += 1
    api.behave({ kind: "ok" })
    const back = byId(await run(c.models("llm", "openrouter", false)), "openrouter")
    expect(api.lists()).toBe(lists + 1)
    expect([back.provider.status, back.stale, back.error]).toEqual(["ready", false, undefined])
  })

  it("a provider that does not answer gives up at the time limit; the other accounts are listed all the same", async () => {
    const slow = await track(fakeOpenAiApi(homeModels))
    slow.behave({ kind: "hang" })
    const ok = await track(fakeOpenAiApi())
    const anthropic = await track(fakeAnthropicApi())
    const { catalog: c } = catalog({
      HOME_MODEL_BASE_URL: slow.url,
      OPENROUTER_API_KEY: OR_KEY,
      OPENROUTER_BASE_URL: `${ok.url}/v1`,
      ANTHROPIC_API_KEY: AN_KEY,
      ANTHROPIC_BASE_URL: anthropic.url
    }, { listTimeoutMs: 300 })
    const started = Date.now()
    const lists = await run(c.models("llm", undefined, false))
    const took = Date.now() - started
    expect(took).toBeLessThan(2_000)
    const home = byId(lists, "home-model")
    expect(home.provider.status).toBe("error")
    expect(home.error?.code).toBe("timeout")
    expect(home.provider.message).toMatch(/did not answer/)
    expect(home.models).toEqual([])
    // The typed model is what is left.
    expect(home.provider.customModel?.placeholder).toBe("llama3.1:8b")
    expect(byId(lists, "openrouter").provider.status).toBe("ready")
    expect(byId(lists, "openrouter").models).toHaveLength(2)
    expect(byId(lists, "anthropic").models.map((m) => m.model.modelId)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-old-4"])
  })

  it("home model: its server's models; a server without /v1/models leaves the typed model, and models in use stay listed", async () => {
    const api = await track(fakeOpenAiApi(homeModels))
    const users = [assistant("jeff", { account: "home-model", model: "llama3.1:8b" }), assistant("t3", { account: "home-model", model: "mistral-small:24b" })]
    const { catalog: c, clock } = catalog({ HOME_MODEL_BASE_URL: api.url }, { assistants: () => users })
    const [list] = await run(c.models("llm", "home-model", false))
    expect(api.requests[0]!.path).toBe("/v1/models")
    expect(list!.models.map((m) => [m.model.modelId, m.listed, m.usedBy])).toEqual([
      ["llama3.1:8b", true, ["jeff"]],
      ["qwen2.5:14b", true, []],
      ["mistral-small:24b", false, ["t3"]]
    ])
    expect(list!.models[2]!.badges.map((b) => b.label)).toContain("Not in the list")
    expect(list!.provider.inUse).toBe(true)
    api.behave({ kind: "status", status: 404 })
    clock.t += LIST_MAX_AGE_MS["home-model"]
    // A new server (another address): nothing cached for it.
    const other = await track(fakeOpenAiApi())
    other.behave({ kind: "status", status: 404 })
    const { catalog: c2 } = catalog({ HOME_MODEL_BASE_URL: other.url }, { assistants: () => users })
    const [failed] = await run(c2.models("llm", "home-model", false))
    expect(failed!.provider.status).toBe("error")
    expect(failed!.provider.message).toMatch(/404/)
    expect(failed!.provider.customModel).toBeDefined()
    expect(failed!.models.map((m) => [m.model.modelId, m.listed])).toEqual([["llama3.1:8b", false], ["mistral-small:24b", false]])
  })

  it("an address that is refused is an error without a fetch", async () => {
    const { catalog: c } = catalog({ HOME_MODEL_BASE_URL: "http://user:pw@192.168.1.20:11434" })
    const [list] = await run(c.models("llm", "home-model", false))
    expect(list!.provider.status).toBe("error")
    expect(list!.provider.message).not.toContain("pw")
  })

  it("Anthropic: the API's list through the adapter (pages, deprecated marked); when it fails, the models the code knows", async () => {
    const api = await track(fakeAnthropicApi())
    const { catalog: c } = catalog({ ANTHROPIC_API_KEY: AN_KEY, ANTHROPIC_BASE_URL: api.url })
    const [list] = await run(c.models("llm", "anthropic", false))
    expect(list!.provider.listSource).toBe("provider")
    expect(api.requests[0]!.path).toBe("/v1/models?limit=100")
    // The SDK (1.8) sends the key as a bearer token.
    expect(api.requests[0]!.authorization).toBe(`Bearer ${AN_KEY}`)
    const [haiku, sonnet, old] = list!.models
    expect(haiku!.badges.map((b) => b.label)).toEqual(["200k context"])
    expect(sonnet!.badges.map((b) => b.label)).toEqual(["1M context"])
    expect(old!.badges.map((b) => b.label)).toEqual(["200k context", "Deprecated"])
    expect(haiku!.llm).toEqual({ contextTokens: 200000, maxOutputTokens: 64000, releasedAt: Date.parse("2026-10-01T00:00:00Z") })
    // The epoch is "unknown" in the API: no release date.
    expect(old!.llm?.releasedAt).toBeUndefined()

    const refused = await track(fakeAnthropicApi())
    refused.behave({ kind: "status", status: 401, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${AN_KEY}` } }) })
    const { catalog: c2 } = catalog({ ANTHROPIC_API_KEY: AN_KEY, ANTHROPIC_BASE_URL: refused.url })
    const [known] = await run(c2.models("llm", "anthropic", false))
    expect(known!.provider.status).toBe("error")
    expect(known!.provider.listSource).toBe("known")
    expect(known!.provider.message).toMatch(/Anthropic rejected the API key \(401\)/)
    expect(known!.models.map((m) => m.model.modelId)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"])
    expect(JSON.stringify(known)).not.toContain(AN_KEY)
  })

  it("Anthropic: more than one page is read", async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ ...anthropicModels[0], id: `claude-test-${i}`, display_name: `Test ${i}` }))
    const api = await track(fakeAnthropicApi(many))
    const { catalog: c } = catalog({ ANTHROPIC_API_KEY: AN_KEY, ANTHROPIC_BASE_URL: api.url })
    const [list] = await run(c.models("llm", "anthropic", false))
    expect(list!.models).toHaveLength(130)
    expect(api.lists()).toBe(2)
  })

  it("Claude subscription: Claude Code's own list while it runs, else the models the code names; not running is set-up", async () => {
    let view: SubscriptionView = { state: "running", enabled: true, models: [{ value: "default", label: "Default (recommended)", description: "Opus for the hard parts" }, { value: "claude-haiku-5-5", label: "Haiku 5.5" }] }
    const users = [assistant("jeff", { account: "claude-subscription", model: "claude-haiku-5-5" })]
    const { catalog: c } = catalog({}, { subscription: () => view, assistants: () => users })
    const [running] = await run(c.models("llm", "claude-subscription", false))
    expect(running!.provider.status).toBe("ready")
    expect(running!.provider.listSource).toBe("provider")
    expect(running!.models.map((m) => [m.model.modelId, m.name, m.usedBy])).toEqual([["default", "Default (recommended)", []], ["claude-haiku-5-5", "Haiku 5.5", ["jeff"]]])
    expect(running!.models[0]!.description).toBe("Opus for the hard parts")
    view = { state: "running", enabled: true }
    const [known] = await run(c.models("llm", "claude-subscription", false))
    expect(known!.provider.listSource).toBe("known")
    expect(known!.models.map((m) => m.model.modelId)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"])
    view = { state: "starting", enabled: true }
    const [starting] = await run(c.models("llm", "claude-subscription", false))
    expect([starting!.provider.status, starting!.models]).toEqual(["needs_setup", []])
    expect(starting!.provider.message).toMatch(/starting/)
  })

  it("an unknown provider is refused; names come from the lists at hand", async () => {
    const { catalog: c } = catalog({})
    const failure = await Effect.runPromise(Effect.flip(c.models("llm", "nope", false)))
    expect([failure.status, failure.code]).toEqual([404, "unknown_provider"])
    expect(c.nameOf("llm", { provider: "anthropic", modelId: "claude-opus-5-5" })).toBe("Claude Opus 5.5")
    expect(c.nameOf("llm", { provider: "openrouter", modelId: "x/y" })).toBeUndefined()
    expect(c.nameOf("stt", { provider: "sherpa", modelId: "parakeet-v2" })).toBe("Parakeet v2")
  })
})

describe("model catalog: speech recognition models", () => {
  it("lists every preset on this machine with languages, measured memory and install state; Deepgram needs its key", async () => {
    const job = { id: "job-1", tool: "stt-models", action: "download", target: "whisper-turbo", label: "Whisper", state: "running", phase: "download", progress: { done: 1, total: 10, unit: "bytes" }, log: [], startedAt: 1 } as unknown as JobInfo
    const users = [assistant("jeff", {}, { engine: "sherpa", model: "parakeet-v2" }), assistant("t3", {}, { engine: "sherpa", model: "nemotron-3.5" })]
    const { catalog: c } = catalog({}, {
      sttItems: () => [{ id: "parakeet-v2", installed: true, sizeMb: 484, diskMb: 663 }, { id: "nemotron-320", installed: true, sizeMb: 477, diskMb: 686 }],
      sttDownload: (preset) => (preset === "whisper-turbo" ? job : undefined),
      assistants: () => users
    })
    const lists = await run(c.models("stt", undefined, false))
    expect(lists.map((p) => [p.provider.id, p.provider.status])).toEqual([["sherpa", "ready"], ["deepgram", "needs_key"]])
    const local = lists[0]!
    expect(local.models).toHaveLength(SherpaStt.presetNames.length)
    // Recommended first, the demoted presets last.
    expect(local.models.at(-1)!.badges.map((b) => b.label)).toContain("Not recommended")
    const pv2 = local.models.find((m) => m.model.modelId === "parakeet-v2")!
    expect(pv2.local).toEqual({ state: "installed", sizeMb: 484, diskMb: 663, ramMb: 1050, loadMs: 1609 })
    expect(pv2.badges.map((b) => b.label)).toEqual(["English", "1.1 GB memory", "Recommended"])
    expect(pv2.selectable).toBe(true)
    expect(pv2.usedBy).toEqual(["jeff"])
    expect(pv2.apply).toEqual({ hearing: { engine: "sherpa", model: "parakeet-v2" } })
    // An old preset name in an assistant counts for the preset it became.
    expect(local.models.find((m) => m.model.modelId === "nemotron-320")!.usedBy).toEqual(["t3"])
    const whisper = local.models.find((m) => m.model.modelId === "whisper-turbo")!
    expect(whisper.local?.state).toBe("downloading")
    expect(whisper.local?.job?.id).toBe("job-1")
    expect(whisper.selectable).toBe(false)
    expect(whisper.stt).toMatchObject({ languagesLabel: "99 languages", takesLanguage: true, liveWords: false })
    const ultra = local.models.find((m) => m.model.modelId === "parakeet-ultra")!
    expect(ultra.local?.state).toBe("not_installed")
    expect(ultra.badges.map((b) => b.label)).toContain(`${SherpaStt.sizeMb(SherpaStt.presets["parakeet-ultra"])} MB download`)
    expect(lists[1]!.provider.settingsPath).toBe("shared/speech")
    expect(lists[1]!.models).toEqual([])
  })

  it("every preset has its languages", () => {
    for (const name of SherpaStt.presetNames) expect(PRESET_LANGUAGES[name]?.label).toBeTruthy()
  })

  it("Deepgram with a key: its one shared model; choosing it changes the engine only", async () => {
    const users = [assistant("jeff", {}, { engine: "deepgram", model: "parakeet-v2" })]
    const { catalog: c } = catalog({ DEEPGRAM_API_KEY: "dg-SECRET-key-0123456789" }, { assistants: () => users })
    const [dg] = await run(c.models("stt", "deepgram", false))
    expect(dg!.provider.status).toBe("ready")
    expect(dg!.models.map((m) => [m.key, m.apply, m.usedBy])).toEqual([["deepgram:flux-general-en", { hearing: { engine: "deepgram" } }, ["jeff"]]])
    expect(JSON.stringify(dg)).not.toContain("dg-SECRET")
  })
})
