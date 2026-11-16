// The generic catalog picker's pure logic (docs/MODEL-PICKERS.md §6): rows of a provider, favourites, search with typed
// models, trouble words, and the mapping of a model catalog's answer.
import { describe, expect, it, vi } from "vitest"
import type { ModelEntry, ModelFavourite, ProviderModels } from "@pva/protocol"
import {
  favouriteRows,
  type GenericFavourite,
  type GenericProvider,
  type GenericRow,
  llmValue,
  mapModelEntry,
  mapModelFavourite,
  mapModelProvider,
  matchesRow,
  missingMeta,
  modelNotice,
  percentOf,
  providerRows,
  providerTrouble,
  searchGroups,
  splitKey,
  sttValue,
  troubleSuffix,
  validModelId
} from "@/lib/catalogPicker.ts"
import { createModelCatalog } from "@/lib/modelCatalog.ts"
import { initialState } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { makeVoiceApi } from "@/lib/voiceCatalog.ts"

const entry = (provider: string, modelId: string, name: string, extra: Partial<ModelEntry> = {}): ModelEntry => ({
  model: { provider, modelId },
  key: `${provider}:${modelId}`,
  name,
  badges: [],
  tags: [modelId],
  apply: provider === "sherpa" ? { hearing: { engine: "sherpa", model: modelId } } : { llm: { account: provider as "anthropic", model: modelId } },
  listed: true,
  selectable: true,
  usedBy: [],
  favourite: false,
  ...extra
})
const info = (id: string, label: string, extra: Partial<ProviderModels["provider"]> = {}): ProviderModels["provider"] => ({
  id, label, location: "hosted", status: "ready", settingsPath: "shared/accounts", settingsLabel: "Shared settings › Language model accounts", inUse: false, ...extra
})
const pm = (provider: ProviderModels["provider"], models: ReadonlyArray<ModelEntry>, extra: Partial<ProviderModels> = {}): ProviderModels => ({ provider, models, stale: false, truncated: false, ...extra })

const custom = { placeholder: "claude-…", help: "A model id." }
const catalog: ReadonlyArray<ProviderModels> = [
  pm(info("anthropic", "Anthropic API", { customModel: custom }), [
    entry("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5", { badges: [{ kind: "context", label: "200k context", title: "200,000 tokens of context" }] }),
    entry("anthropic", "claude-opus-5-5", "Claude Opus 5.5", { badges: [{ kind: "context", label: "1M context" }] })
  ]),
  pm(info("openrouter", "OpenRouter", { status: "needs_key", reason: "missing", message: "OpenRouter is not set up." }), []),
  pm(info("home-model", "Home model", { location: "local", status: "error", message: "answered 404", customModel: { placeholder: "llama3.1:8b", help: "Ollama." } }),
    [entry("home-model", "qwen3-14b", "qwen3-14b", { listed: false, badges: [{ kind: "tag", label: "Not in the list" }] })],
    { error: { code: "provider_error", message: "answered 404" } }),
  pm(info("offline", "Offline stand-in", { location: "local" }), [entry("offline", "stand-in", "Offline stand-in")])
]
const lists: ReadonlyArray<GenericProvider> = catalog.map(mapModelProvider)
const fav = (key: string, name: string, addedAt: number): GenericFavourite => ({ key, providerId: splitKey(key)!.provider, name, addedAt })

describe("generic picker logic: models", () => {
  it("splits a key at the first colon and checks typed ids like the assistant does", () => {
    expect(splitKey("home-model:llama3.1:8b")).toEqual({ provider: "home-model", id: "llama3.1:8b" })
    expect(splitKey("openrouter:openai/gpt-oss-20b:free")).toEqual({ provider: "openrouter", id: "openai/gpt-oss-20b:free" })
    expect(splitKey("nothing")).toBeUndefined()
    expect(validModelId("qwen3-14b")).toBe(true)
    expect(validModelId("")).toBe(false)
    expect(validModelId(" padded ")).toBe(false)
    expect(validModelId("a".repeat(101))).toBe(false)
    expect(validModelId("two\nlines")).toBe(false)
  })

  it("maps an entry: badges under the name, ids as search words, what choosing applies, the tooltip", () => {
    const row = lists[0]!.rows[0]!
    expect(row).toMatchObject({ key: "anthropic:claude-haiku-5-5", name: "Claude Haiku 5.5", meta: ["200k context"], selectable: true, listed: true, choice: { apply: { llm: { account: "anthropic", model: "claude-haiku-5-5" } } } })
    expect(row.search).toContain("claude-haiku-5-5")
    expect(row.title).toBe("200,000 tokens of context")
    // A model in use that the list lacks is marked even when the server sent no badge.
    expect(mapModelEntry(entry("home-model", "x", "x", { listed: false })).meta).toEqual(["Not in the list"])
  })

  it("maps a local row with its state and job", () => {
    const job = { id: "j1", tool: "stt-models", target: "whisper-turbo", state: "running", startedAt: 1, progress: { done: 1, total: 4, unit: "bytes" } } as never
    const row = mapModelEntry(entry("sherpa", "whisper-turbo", "Whisper turbo", { selectable: false, local: { state: "downloading", sizeMb: 565, diskMb: 1039, job } }))
    expect(row.local).toMatchObject({ state: "downloading", sizeMb: 565 })
    expect(row.selectable).toBe(false)
    expect(percentOf(row.local!.job!)).toBe(25)
  })

  it("lists a provider's rows, then the typed row where the provider takes one (also when its list failed)", () => {
    expect(providerRows(lists[0]!).map((r) => r.kind)).toEqual(["entry", "entry", "typed"])
    expect(providerRows(lists[2]!).map((r) => r.kind)).toEqual(["entry", "typed"])
    // No typed row without a custom model, or for a provider that is not set up.
    expect(providerRows(lists[3]!).map((r) => r.kind)).toEqual(["entry"])
    expect(providerRows(lists[1]!)).toEqual([])
  })

  it("search finds rows by name, facts and id across providers, under provider headers", () => {
    expect(matchesRow(lists[0]!.rows[1]!, lists[0]!, "1m CONTEXT")).toBe(true)
    expect(matchesRow(lists[0]!.rows[1]!, lists[0]!, "opus context")).toBe(true)
    expect(matchesRow(lists[0]!.rows[1]!, lists[0]!, "opus 200k")).toBe(false)
    const groups = searchGroups(lists, "claude opus")
    expect(groups.map((g) => g.header)).toEqual(["Anthropic API"])
    expect(groups[0]!.rows.map((r) => r.key)).toEqual(["anthropic:claude-opus-5-5"])
    expect(searchGroups(lists, "zzz qqq")).toEqual([])
  })

  it("search offers the text as a typed model on each provider that takes one, unless it is exactly a listed id", () => {
    const groups = searchGroups(lists, "acme/rocket")
    expect(groups.map((g) => g.header)).toEqual(["Anthropic API", "Home model"])
    expect(groups[0]!.rows).toEqual([{ kind: "use", key: "use:anthropic", provider: lists[0], text: "acme/rocket" }])
    const exact = searchGroups(lists, "qwen3-14b")
    expect(exact.map((g) => g.header)).toEqual(["Anthropic API", "Home model"]) // Anthropic: typed; Home model: the listed row only
    expect(exact[1]!.rows.map((r) => r.kind)).toEqual(["entry"])
    // A text with a space is not an id.
    expect(searchGroups(lists, "two words")).toEqual([])
  })

  it("favourites are one flat list, providers in rail order, each in the order added; a model gone stays as missing", () => {
    const rows = favouriteRows(lists, [
      fav("offline:stand-in", "Offline stand-in", 1),
      fav("anthropic:claude-opus-5-5", "Claude Opus 5.5", 2),
      fav("openrouter:openai/gpt-oss-20b", "OpenAI: gpt-oss-20b", 3),
      fav("anthropic:claude-haiku-5-5", "Claude Haiku 5.5", 4)
    ])
    expect(rows.map((r) => r.key)).toEqual(["anthropic:claude-opus-5-5", "anthropic:claude-haiku-5-5", "openrouter:openai/gpt-oss-20b", "offline:stand-in"])
    expect(rows[2]).toMatchObject({ kind: "missing", name: "OpenAI: gpt-oss-20b", providerId: "openrouter" })
    expect(missingMeta(lists[1], "openrouter")).toBe("Needs a OpenRouter key")
    expect(missingMeta(lists[0], "anthropic")).toBe("Not available now")
    expect(missingMeta(undefined, "x")).toBe("Not available now")
  })

  it("says what is wrong with a provider: a dot on the rail, words for assistive technology, a panel", () => {
    expect(lists.map(providerTrouble)).toEqual([undefined, "needs_key", "error", undefined])
    expect(providerTrouble({ status: "needs_address" })).toBe("needs_setup")
    expect(providerTrouble({ status: "needs_setup" })).toBe("needs_setup")
    expect(troubleSuffix({ status: "needs_key" })).toBe(" (needs a key)")
    expect(troubleSuffix({ status: "needs_key", reason: "vault_locked" })).toBe(" (keys locked)")
    expect(troubleSuffix({ status: "needs_setup" })).toBe(" (not set up)")
    expect(troubleSuffix({ status: "error" })).toBe(" (a problem)")
    expect(troubleSuffix({ status: "ready" })).toBe("")
    expect(modelNotice({ status: "needs_key", reason: "missing", label: "OpenRouter" })).toMatchObject({ title: "No OpenRouter key yet" })
    expect(modelNotice({ status: "needs_key", reason: "vault_locked", label: "OpenRouter" }).title).toBe("The keys are locked")
    expect(modelNotice({ status: "needs_address", label: "Home model", message: "Add it." })).toEqual({ title: "No Home model address yet", body: "Add it." })
    expect(modelNotice({ status: "needs_setup", label: "Claude subscription" }).title).toBe("Claude subscription is not set up")
  })

  it("maps a provider: the link the catalog gives, the problem and the note on older or known models", () => {
    expect(lists[1]).toMatchObject({ status: "needs_key", linkText: "Open Shared settings › Language model accounts", settingsPath: "shared/accounts", rows: [] })
    expect(lists[1]!.problem).toBeUndefined()
    expect(lists[2]!.problem).toEqual({ message: "answered 404" })
    const known = mapModelProvider(pm(info("anthropic", "Anthropic API", { status: "error", message: "unreachable", listSource: "known" }), [entry("anthropic", "a", "A")]))
    expect(known.problem?.note).toContain("models this assistant knows of")
    const stale = mapModelProvider(pm(info("openrouter", "OpenRouter", { status: "error", message: "unreachable" }), [entry("openrouter", "a", "A")], { stale: true }))
    expect(stale.problem?.note).toContain("earlier")
    const f: ModelFavourite = { model: { provider: "anthropic", modelId: "x" }, key: "anthropic:x", name: "X", addedAt: 5 }
    expect(mapModelFavourite(f)).toEqual({ key: "anthropic:x", providerId: "anthropic", name: "X", addedAt: 5 })
  })

  it("names what the page holds as the chosen key", () => {
    expect(llmValue("anthropic", "claude-haiku-5-5")).toBe("anthropic:claude-haiku-5-5")
    expect(llmValue("home-model", "llama3.1:8b")).toBe("home-model:llama3.1:8b")
    expect(llmValue("offline", "")).toBe("offline:stand-in")
    expect(llmValue("anthropic", "")).toBe("")
    expect(sttValue("sherpa", "parakeet-v2", [])).toBe("sherpa:parakeet-v2")
    expect(sttValue("deepgram", "parakeet-v2", [{ ...lists[0]!, id: "deepgram", rows: [{ ...lists[0]!.rows[0]!, key: "deepgram:flux-general-en" }] }])).toBe("deepgram:flux-general-en")
    expect(sttValue("deepgram", "parakeet-v2", [])).toBe("deepgram:flux-general-en")
  })
})

describe("the model catalog's calls", () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const setup = (answer: (url: string, init?: RequestInit) => Response) => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}) })
      return answer(String(url), init)
    })
    const host = { store: createStore(initialState, (s) => s) }
    const api = makeVoiceApi(() => "http://h/api/", () => "token", fetchFn as unknown as typeof fetch)
    return { calls, catalog: createModelCatalog("llm", host, api) }
  }
  const sample = { kind: "llm", providers: catalog }
  const favs = { favourites: [] }

  it("loads the lists and favourites of its kind; refresh asks the providers again", async () => {
    const { calls, catalog: c } = setup((url) => (url.includes("favourites") ? reply(favs) : reply(sample)))
    await c.reload()
    expect(calls.map((x) => x.url).sort()).toEqual(["http://h/api/models/llm", "http://h/api/models/llm/favourites"])
    expect(c.store.get().load).toBe("ready")
    expect(c.store.get().lists).toHaveLength(4)
    await c.reload(true)
    expect(calls.at(-1)!.url).toMatch(/models\/llm(\?refresh=1|\/favourites)$/)
    expect(calls.some((x) => x.url === "http://h/api/models/llm?refresh=1")).toBe(true)
  })

  it("Retry of one provider asks for it with refresh=1 and replaces only that provider", async () => {
    const { calls, catalog: c } = setup((url) => (url.includes("favourites") ? reply(favs) : url.includes("provider=anthropic") ? reply({ kind: "llm", providers: [pm(info("anthropic", "Anthropic API"), [entry("anthropic", "only", "Only")])] }) : reply(sample)))
    await c.reload()
    await c.reloadProvider("anthropic", true)
    expect(calls.at(-1)!.url).toBe("http://h/api/models/llm?provider=anthropic&refresh=1")
    expect(c.store.get().lists.map((p) => p.provider.id)).toEqual(["anthropic", "openrouter", "home-model", "offline"])
    expect(c.store.get().lists[0]!.models.map((m) => m.name)).toEqual(["Only"])
    expect(c.store.get().lists[2]!.models.map((m) => m.name)).toEqual(["qwen3-14b"])
    expect(c.store.get().refreshing).toBe(false)
  })

  it("a star is shown at once and kept by the server under the encoded key; a failure puts it back", async () => {
    const key = "openrouter:openai/gpt-oss-20b:free"
    const { calls, catalog: c } = setup((url, init) => {
      if (init?.method === "PUT") return reply({ favourite: { model: { provider: "openrouter", modelId: "openai/gpt-oss-20b:free" }, key, name: "gpt", addedAt: 1 }, favourites: [{ model: { provider: "openrouter", modelId: "openai/gpt-oss-20b:free" }, key, name: "gpt", addedAt: 1 }] })
      return url.includes("favourites") ? reply(favs) : reply(sample)
    })
    await c.reload()
    await c.toggleFavourite(key, "gpt")
    expect(calls.at(-1)).toMatchObject({ method: "PUT", url: `http://h/api/models/llm/favourites/${encodeURIComponent(key)}`, body: { name: "gpt" } })
    expect(c.store.get().favourites.map((f) => f.key)).toEqual([key])
    const failing = setup((_url, init) => (init?.method === "DELETE" ? reply({ error: { code: "boom", message: "No." } }, 500) : _url.includes("favourites") ? reply({ favourites: [{ model: { provider: "openrouter", modelId: "x" }, key: "openrouter:x", name: "X", addedAt: 1 }] }) : reply(sample)))
    await failing.catalog.reload()
    await failing.catalog.toggleFavourite("openrouter:x", "X")
    expect(failing.catalog.store.get().favourites.map((f) => f.key)).toEqual(["openrouter:x"])
    expect(failing.catalog.store.get().notice).toMatchObject({ tone: "error", message: "No." })
  })

  it("only recognisers download; the model goes in the body as a reference", async () => {
    const llm = setup(() => reply({ job: {} }))
    await llm.catalog.download("anthropic:claude-haiku-5-5")
    expect(llm.calls).toEqual([])
    const calls: Array<{ url: string; body?: unknown }> = []
    const host = { store: createStore(initialState, (s) => s) }
    const api = makeVoiceApi(() => "http://h/api/", () => "token", (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return reply({ job: { id: "job-3", tool: "stt-models", target: "whisper-turbo", action: "download", label: "Whisper turbo", state: "running", log: [], startedAt: 1 } }, 202)
    }) as unknown as typeof fetch)
    const stt = createModelCatalog("stt", host, api)
    await stt.download("sherpa:whisper-turbo")
    expect(calls[0]).toEqual({ url: "http://h/api/models/stt/download", body: { model: { provider: "sherpa", modelId: "whisper-turbo" } } })
    expect(stt.store.get().downloads["sherpa:whisper-turbo"]?.job?.id).toBe("job-3")
  })
})

// A row that is not a model's: the row type has what a voice needs too.
it("a generic row carries either kind of choice", () => {
  const row: GenericRow = { key: "sherpa:x", providerId: "sherpa", name: "X", meta: [], search: [], selectable: true, listed: true, favourite: false, usedBy: [], choice: { voice: { provider: "sherpa", voiceId: "x" } } }
  expect("voice" in row.choice).toBe(true)
})
