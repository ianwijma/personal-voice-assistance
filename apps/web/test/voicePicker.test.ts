// The voice picker's logic (docs/VOICE-PROVIDERS.md §4–§5): search, the favourites list, and the catalog's API
// calls against a scripted fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Favourite, JobInfo, ProviderInfo, ProviderVoices, VoiceEntry } from "@pva/protocol"
import { initialState } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ApiError, apiBaseFor, BUSY_TEXT, createVoiceCatalog, jobOf, makeVoiceApi } from "@/lib/voiceCatalog.ts"
import { DEFAULT_PREVIEW_TEXT, favouriteRows, languageLabel, matchesVoice, needsKeyText, parseKey, searchGroups, voiceMeta } from "@/lib/voicePicker.ts"

const provider = (id: string, label: string, extra: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id, label, location: id === "sherpa" ? "local" : "hosted", status: "ready", settingsPath: "voices/providers", inUse: false, ...extra
})
const voice = (p: string, voiceId: string, name: string, extra: Partial<VoiceEntry> = {}): VoiceEntry => ({
  voice: { provider: p, voiceId }, key: `${p}:${voiceId}`, name, tags: [], previewable: true, selected: false, favourite: false, ...extra
})
const lists: ReadonlyArray<ProviderVoices> = [
  { provider: provider("sherpa", "On this machine"), stale: false, truncated: false, voices: [
    voice("sherpa", "en_US-lessac-medium", "Lessac", { language: "en-US", gender: "female", tags: ["fast"] }),
    voice("sherpa", "en_GB-alba-medium", "Alba", { language: "en-GB", gender: "female", tags: ["fast"] })
  ] },
  { provider: provider("cartesia", "Cartesia", { status: "needs_key", reason: "missing" }), stale: false, truncated: false, voices: [] },
  { provider: provider("elevenlabs", "ElevenLabs"), stale: false, truncated: false, voices: [
    voice("elevenlabs", "a1", "Zoë", { language: "en-GB", gender: "female", tags: ["british", "warm"], description: "Soft and clear." }),
    voice("elevenlabs", "a2", "Daniel", { language: "en-GB", gender: "male", tags: ["british", "news"] })
  ] }
]
const fav = (key: string, name: string, addedAt: number): Favourite => {
  const ref = parseKey(key)!
  return { voice: ref, key, name, addedAt }
}

describe("voice picker logic", () => {
  it("parses voice keys like the server", () => {
    expect(parseKey("sherpa:en_US-lessac-medium")).toEqual({ provider: "sherpa", voiceId: "en_US-lessac-medium" })
    expect(parseKey("cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4")?.voiceId).toBe("db6b0ed5-d5d3-463d-ae85-518a07d3c2b4")
    expect(parseKey("natural")).toBeUndefined()
    expect(parseKey("sherpa:")).toBeUndefined()
    expect(parseKey("Sherpa:x")).toBeUndefined()
  })

  it("says language, gender and two tags under a voice", () => {
    expect(languageLabel("en-US")).toBe("English (US)")
    expect(languageLabel("nl")).toBe("Dutch")
    expect(voiceMeta({ language: "en-GB", gender: "male", tags: ["british", "news", "premade"] })).toBe("English (GB) · male · british · news")
    expect(voiceMeta({ tags: [] })).toBe("")
  })

  it("matches every word, ignoring case and accents, over name, language, tags and provider", () => {
    const zoe = lists[2]!.voices[0]!
    const p = lists[2]!.provider
    expect(matchesVoice(zoe, p, "zoe")).toBe(true)
    expect(matchesVoice(zoe, p, "ZOË british")).toBe(true)
    expect(matchesVoice(zoe, p, "english soft")).toBe(true)
    expect(matchesVoice(zoe, p, "elevenlabs")).toBe(true)
    expect(matchesVoice(zoe, p, "zoe dutch")).toBe(false)
  })

  it("search looks across every provider and groups the results under provider headers", () => {
    const groups = searchGroups(lists, "gb")
    expect(groups.map((g) => g.header)).toEqual(["On this machine", "ElevenLabs"])
    expect(groups[0]!.rows.map((r) => r.key)).toEqual(["sherpa:en_GB-alba-medium"])
    expect(groups[1]!.rows).toHaveLength(2)
    expect(searchGroups(lists, "nothing like it")).toEqual([])
  })

  it("favourites are one flat list, voices of a provider together, then in the order added", () => {
    const rows = favouriteRows(lists, [
      fav("elevenlabs:a2", "Daniel", 1),
      fav("sherpa:en_GB-alba-medium", "Alba", 2),
      fav("cartesia:c9", "Skylar", 3),
      fav("elevenlabs:a1", "Zoë", 4),
      fav("sherpa:en_US-lessac-medium", "Lessac", 5)
    ])
    expect(rows.map((r) => r.key)).toEqual(["sherpa:en_GB-alba-medium", "sherpa:en_US-lessac-medium", "cartesia:c9", "elevenlabs:a2", "elevenlabs:a1"])
    // A favourite of a provider without a key is kept, with the name it was added with.
    expect(rows[2]).toMatchObject({ kind: "missing", name: "Skylar", providerId: "cartesia" })
  })

  it("explains a provider that needs a key, or locked keys", () => {
    expect(needsKeyText(provider("cartesia", "Cartesia", { status: "needs_key", reason: "missing" })).title).toBe("No Cartesia key yet")
    expect(needsKeyText(provider("cartesia", "Cartesia", { status: "needs_key", reason: "vault_locked" })).title).toBe("The keys are locked")
  })

  it("the API is the socket's server over HTTP", () => {
    expect(apiBaseFor("ws://127.0.0.1:8787/ws")).toBe("http://127.0.0.1:8787/api/")
    expect(apiBaseFor("wss://home.example:8443/ws?x=1")).toBe("https://home.example:8443/api/")
  })

  it("follows a download job: a running one for the voice, else the newest known", () => {
    const job = (id: string, state: JobInfo["state"], startedAt: number): JobInfo => ({ id, tool: "tts-models", action: "download", target: "en_GB-alba-medium", label: "Alba", state, log: [], startedAt })
    expect(jobOf([job("j1", "cancelled", 1), job("j2", "running", 2)], undefined, undefined, "en_GB-alba-medium")?.id).toBe("j2")
    expect(jobOf([job("j1", "cancelled", 5)], { job: job("j1", "running", 5) }, undefined, "en_GB-alba-medium")?.state).toBe("cancelled")
    expect(jobOf([], undefined, undefined, "x")).toBeUndefined()
  })
})

/** A scripted fetch: answers by "METHOD path", records the calls. */
const scripted = (routes: Record<string, (body: unknown) => Response | Promise<Response>>) => {
  const calls: Array<{ method: string; path: string; body: unknown; auth: string | null }> = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const path = url.pathname.replace(/^\/api\//, "") + url.search
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body, auth: new Headers(init?.headers).get("authorization") })
    const route = routes[`${method} ${path}`]
    if (route === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: "no route" } }), { status: 404 })
    return route(body)
  }) as typeof fetch
  return { calls, fetchFn }
}
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const fail = (status: number, code: string, message = code, retryAfterMs?: number) =>
  new Response(JSON.stringify({ error: { code, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } }), { status })

const host = () => ({ store: createStore(initialState, (s) => s) })

describe("voice catalog (API client)", () => {
  const played: Array<string> = []
  beforeEach(() => {
    played.length = 0
    vi.stubGlobal("Audio", class {
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      readonly src: string
      constructor(src: string) {
        this.src = src
      }
      play() {
        played.push(this.src)
        return Promise.resolve()
      }
      pause() {}
    })
    URL.createObjectURL = () => `blob:${played.length}`
    URL.revokeObjectURL = () => undefined
  })
  afterEach(() => vi.unstubAllGlobals())

  const base = () => ({
    "GET voices": () => ok({ providers: lists, selected: "sherpa:en_US-lessac-medium" }),
    "GET voices/favourites": () => ok({ favourites: [fav("elevenlabs:a1", "Zoë", 1)] })
  })

  it("loads the lists and favourites once, with the admin token", async () => {
    const { calls, fetchFn } = scripted(base())
    const catalog = createVoiceCatalog(host(), makeVoiceApi(() => "http://x/api/", () => "tok-1234567890abcdef", fetchFn))
    catalog.ensure()
    catalog.ensure()
    await vi.waitFor(() => expect(catalog.store.get().load).toBe("ready"))
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET voices", "GET voices/favourites"])
    expect(calls[0]!.auth).toBe("Bearer tok-1234567890abcdef")
    expect(catalog.store.get().selected).toBe("sherpa:en_US-lessac-medium")
    expect(catalog.store.get().favourites.map((f) => f.key)).toEqual(["elevenlabs:a1"])
  })

  it("without a token it says to log in, and calls nothing", async () => {
    const { calls, fetchFn } = scripted(base())
    const catalog = createVoiceCatalog(host(), makeVoiceApi(() => "http://x/api/", () => undefined, fetchFn))
    await catalog.reload()
    expect(catalog.store.get()).toMatchObject({ load: "error", loadError: "Log in to admin first." })
    expect(calls).toEqual([])
  })

  it("a favourite changes at once and takes the server's list; a refusal puts it back", async () => {
    const { calls, fetchFn } = scripted({
      ...base(),
      "PUT voices/favourites/elevenlabs%3Aa2": () => ok({ favourite: fav("elevenlabs:a2", "Daniel", 9), favourites: [fav("elevenlabs:a1", "Zoë", 1), fav("elevenlabs:a2", "Daniel", 9)] }),
      "DELETE voices/favourites/elevenlabs%3Aa1": () => fail(500, "internal", "The favourites file could not be written")
    })
    const catalog = createVoiceCatalog(host(), makeVoiceApi(() => "http://x/api/", () => "tok-1234567890abcdef", fetchFn))
    await catalog.reload()
    const adding = catalog.toggleFavourite("elevenlabs:a2", { provider: "elevenlabs", voiceId: "a2" }, "Daniel")
    expect(catalog.store.get().favourites.map((f) => f.key)).toEqual(["elevenlabs:a1", "elevenlabs:a2"])
    await adding
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { name: "Daniel" } })
    expect(catalog.store.get().favourites.find((f) => f.key === "elevenlabs:a2")?.addedAt).toBe(9)
    await catalog.toggleFavourite("elevenlabs:a1", { provider: "elevenlabs", voiceId: "a1" }, "Zoë")
    expect(catalog.store.get().favourites.map((f) => f.key)).toEqual(["elevenlabs:a1", "elevenlabs:a2"])
    expect(catalog.store.get().notice).toMatchObject({ tone: "error", message: "The favourites file could not be written" })
  })

  it("plays one preview at a time: the same voice stops it, another replaces it, superseded is ignored", async () => {
    const answers: Array<(r: Response) => void> = []
    const { calls, fetchFn } = scripted({ ...base(), "POST voices/preview": () => new Promise<Response>((resolve) => answers.push(resolve)) })
    const catalog = createVoiceCatalog(host(), makeVoiceApi(() => "http://x/api/", () => "tok-1234567890abcdef", fetchFn))
    catalog.setPreviewText("  ")
    const first = catalog.preview("sherpa:en_US-lessac-medium", { provider: "sherpa", voiceId: "en_US-lessac-medium" })
    expect(catalog.store.get().preview).toEqual({ key: "sherpa:en_US-lessac-medium", phase: "loading" })
    // An empty text reads the default.
    await vi.waitFor(() => expect(calls.at(-1)?.body).toEqual({ voice: { provider: "sherpa", voiceId: "en_US-lessac-medium" }, text: DEFAULT_PREVIEW_TEXT }))
    const second = catalog.preview("elevenlabs:a1", { provider: "elevenlabs", voiceId: "a1" })
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    answers[0]!(fail(409, "superseded"))
    await first
    expect(catalog.store.get().preview?.key).toBe("elevenlabs:a1")
    // A byte body, not a `Blob`: this file runs under jsdom, whose Blob has no `stream()`, and
    // newer Node releases (22.23) call it when a Response is built from one.
    answers[1]!(new Response(new Uint8Array(44), { status: 200, headers: { "content-type": "audio/wav" } }))
    await second
    expect(catalog.store.get().preview).toEqual({ key: "elevenlabs:a1", phase: "playing" })
    expect(played).toHaveLength(1)
    expect(catalog.store.get().notice).toBeUndefined()
    await catalog.preview("elevenlabs:a1", { provider: "elevenlabs", voiceId: "a1" })
    expect(catalog.store.get().preview).toBeUndefined()
  })

  it("a local preview while the assistant talks says so", async () => {
    const { fetchFn } = scripted({ ...base(), "POST voices/preview": () => fail(409, "busy", "busy", 1000) })
    const catalog = createVoiceCatalog(host(), makeVoiceApi(() => "http://x/api/", () => "tok-1234567890abcdef", fetchFn))
    await catalog.preview("sherpa:en_US-lessac-medium", { provider: "sherpa", voiceId: "en_US-lessac-medium" })
    expect(catalog.store.get().preview).toBeUndefined()
    expect(catalog.store.get().notice).toEqual({ key: "sherpa:en_US-lessac-medium", tone: "error", message: BUSY_TEXT })
  })

  it("starts and cancels a download, keeping the job it answered with", async () => {
    const job: JobInfo = { id: "job-7", tool: "tts-models", action: "download", target: "en_GB-alba-medium", label: "Alba", state: "running", log: [], startedAt: 1 }
    const { calls, fetchFn } = scripted({
      ...base(),
      "POST voices/download": () => ok({ job }, 202),
      "POST voices/download/cancel": () => ok({ cancelled: true, job: { ...job, state: "cancelled" } })
    })
    const catalog = createVoiceCatalog(host(), makeVoiceApi(() => "http://x/api/", () => "tok-1234567890abcdef", fetchFn))
    const ref = { provider: "sherpa", voiceId: "en_GB-alba-medium" }
    const starting = catalog.download("sherpa:en_GB-alba-medium", ref)
    expect(catalog.store.get().downloads["sherpa:en_GB-alba-medium"]).toEqual({ starting: true })
    await starting
    expect(catalog.store.get().downloads["sherpa:en_GB-alba-medium"]).toEqual({ job })
    await catalog.cancelDownload("sherpa:en_GB-alba-medium", ref)
    expect(catalog.store.get().downloads["sherpa:en_GB-alba-medium"]?.job?.state).toBe("cancelled")
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ voice: ref }, { voice: ref }])
  })

  it("re-reads the local list when a voice-model download starts (the Kokoro voices all download with it) and when it ends", async () => {
    const { calls, fetchFn } = scripted({ ...base(), "GET voices?provider=sherpa": () => ok({ providers: [lists[0]], selected: "sherpa:en_US-lessac-medium" }) })
    const store = createStore<typeof initialState, typeof initialState>(initialState, (_s, next) => next)
    const catalog = createVoiceCatalog({ store } as never, makeVoiceApi(() => "http://x/api/", () => "tok-1234567890abcdef", fetchFn))
    catalog.ensure()
    await vi.waitFor(() => expect(catalog.store.get().load).toBe("ready"))
    const localReads = () => calls.filter((c) => c.path === "voices?provider=sherpa").length
    const job: JobInfo = { id: "job-9", tool: "tts-models", action: "download", target: "kokoro-af_heart", label: "Kokoro v1.0 (28 voices)", state: "running", log: [], startedAt: 1 }
    store.dispatch({ ...store.get(), jobs: [job] })
    await vi.waitFor(() => expect(localReads()).toBe(1))
    // Progress of the same job is not a new start.
    store.dispatch({ ...store.get(), jobs: [{ ...job, progress: { done: 1, total: 2, unit: "bytes" } }] })
    await new Promise((r) => setTimeout(r, 250))
    expect(localReads()).toBe(1)
    store.dispatch({ ...store.get(), jobs: [{ ...job, state: "succeeded" }] })
    await vi.waitFor(() => expect(localReads()).toBe(2))
  })

  it("an error answer becomes an ApiError with the server's code and message", async () => {
    const { fetchFn } = scripted({ "GET voices": () => fail(401, "admin_required", "Log in to admin first (the session may have ended)") })
    const api = makeVoiceApi(() => "http://x/api/", () => "tok-1234567890abcdef", fetchFn)
    await expect(api.request("voices")).rejects.toMatchObject({ status: 401, code: "admin_required" })
    await expect(api.request("voices")).rejects.toBeInstanceOf(ApiError)
  })
})
