import {
  API_PREFIX,
  ApiErrorBody,
  CancelResponse,
  type DefaultVoice,
  DefaultVoiceResponse,
  type Favourite,
  FavouriteResponse,
  FavouritesResponse,
  type JobInfo,
  JobResponse,
  MAX_PREVIEW_CHARS,
  type ProviderVoices,
  type VoiceRefJson,
  VoicesResponse
} from "@pva/protocol"
import { Schema } from "effect"
import { ADMIN_TOKEN_KEY } from "./adminToken.ts"
import { resolveWsUrl } from "./connection.ts"
import type { ClientState } from "./state.ts"
import { createStore, type Store } from "./store.ts"
import { DEFAULT_PREVIEW_TEXT } from "./voicePicker.ts"

/**
 * The voice picker's data (docs/VOICE-PROVIDERS.md §5): every provider's voices, the favourites, the one preview
 * that plays, and the downloads the picker started. One catalog per client, so every picker on a page shares one
 * copy of the lists (and one preview at a time). Talks to the admin HTTP API with the admin session token; download
 * progress comes from the `job` messages the admin socket already receives.
 */

export interface DownloadState {
  readonly starting?: boolean
  /** The download job the API answered with (its progress follows in the client state's `jobs`). */
  readonly job?: JobInfo
}

/** A line for the person: what just went wrong (or right) with a preview, a favourite or a download. */
export interface CatalogNotice {
  readonly key?: string
  readonly tone: "error" | "info"
  readonly message: string
}

export interface CatalogState {
  readonly load: "idle" | "loading" | "ready" | "error"
  readonly loadError?: string | undefined
  readonly refreshing: boolean
  readonly lists: ReadonlyArray<ProviderVoices>
  /** The server's assistant voice (what `ASSISTANT_VOICE` resolves to now). */
  readonly selected?: string | undefined
  readonly favourites: ReadonlyArray<Favourite>
  readonly preview?: { readonly key: string; readonly phase: "loading" | "playing" } | undefined
  readonly previewText: string
  readonly downloads: Readonly<Record<string, DownloadState>>
  readonly notice?: CatalogNotice | undefined
  readonly defaultVoice?: DefaultVoice | undefined
}

export const initialCatalog: CatalogState = {
  load: "idle",
  refreshing: false,
  lists: [],
  favourites: [],
  previewText: DEFAULT_PREVIEW_TEXT,
  downloads: {}
}

type Update = Partial<CatalogState> | ((s: CatalogState) => CatalogState)

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterMs: number | undefined
  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

/** The API's address: the HTTP side of the socket's server (`ws://host:port/ws` → `http://host:port/api/`). */
export const apiBaseFor = (wsUrl: string): string => {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  url.pathname = API_PREFIX
  url.search = ""
  url.hash = ""
  return url.toString()
}

const readToken = (): string | undefined => {
  try {
    return globalThis.sessionStorage?.getItem(ADMIN_TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

const decode = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] => Schema.decodeUnknownSync(schema as never)(value) as S["Type"]

/** A preview refused because a device is in a turn, in words. */
export const BUSY_TEXT = "The assistant is talking; try again in a moment."

export interface VoiceApi {
  readonly request: (path: string, init?: { readonly method?: string; readonly body?: unknown; readonly signal?: AbortSignal }) => Promise<Response>
}

export const makeVoiceApi = (base: () => string, token: () => string | undefined = readToken, fetchFn: typeof fetch = (...a) => globalThis.fetch(...a)): VoiceApi => ({
  request: async (path, init = {}) => {
    const t = token()
    if (t === undefined) throw new ApiError(401, "admin_required", "Log in to admin first.")
    let res: Response
    try {
      res = await fetchFn(`${base()}${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${t}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
        cache: "no-store"
      })
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e
      throw new ApiError(0, "network", "The assistant could not be reached.")
    }
    if (res.ok) return res
    let info: { code: string; message: string; retryAfterMs?: number } | undefined
    try {
      info = decode(ApiErrorBody, await res.json()).error
    } catch {
      info = undefined
    }
    throw new ApiError(res.status, info?.code ?? `http_${res.status}`, info?.message ?? `The assistant answered ${res.status}.`, info?.retryAfterMs)
  }
})

const messageOf = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback)
const aborted = (e: unknown) => e instanceof DOMException && e.name === "AbortError"

export interface VoiceCatalog {
  readonly store: Store<CatalogState, Update>
  /** Load the lists and favourites once (the first picker on a page). */
  readonly ensure: () => void
  /** Load again; `refresh`: ask the hosted providers again now (`?refresh=1`). */
  readonly reload: (refresh?: boolean) => Promise<void>
  readonly loadDefault: () => Promise<void>
  readonly toggleFavourite: (key: string, voice: VoiceRefJson, name: string) => Promise<void>
  /** Read the preview text in this voice; the same voice again stops it; another voice replaces it. */
  readonly preview: (key: string, voice: VoiceRefJson) => Promise<void>
  readonly stopPreview: () => void
  readonly setPreviewText: (text: string) => void
  readonly download: (key: string, voice: VoiceRefJson) => Promise<void>
  readonly cancelDownload: (key: string, voice: VoiceRefJson) => Promise<void>
  readonly dismissNotice: () => void
}

/** The bits of the client the catalog follows: download jobs, model changes, the vault and the voice sections. */
export interface CatalogHost {
  readonly store: { readonly get: () => ClientState; readonly subscribe: (listener: () => void) => () => void }
}

export const createVoiceCatalog = (host: CatalogHost, api: VoiceApi = makeVoiceApi(() => apiBaseFor(resolveWsUrl(location)))): VoiceCatalog => {
  const store = createStore<CatalogState, Update>(initialCatalog, (s, u) => {
    const next = typeof u === "function" ? u(s) : { ...s, ...u }
    return next
  })
  const set = (u: Update) => store.dispatch(u)
  const get = store.get

  const json = async <S extends Schema.Top>(schema: S, path: string, init?: Parameters<VoiceApi["request"]>[1]): Promise<S["Type"]> =>
    decode(schema, await (await api.request(path, init)).json())

  let loadSeq = 0
  const reload = async (refresh = false) => {
    const seq = ++loadSeq
    set((s) => ({ ...s, ...(s.load === "ready" ? { refreshing: true } : { load: "loading" as const }) }))
    try {
      const [voices, favs] = await Promise.all([ // continuation(state): only the newest load writes (`seq`)
        json(VoicesResponse, `voices${refresh ? "?refresh=1" : ""}`),
        json(FavouritesResponse, "voices/favourites")
      ])
      if (seq !== loadSeq) return
      const { loadError: _e, ...rest } = get()
      set(() => ({ ...rest, load: "ready", refreshing: false, lists: voices.providers, selected: voices.selected, favourites: favs.favourites }))
    } catch (e) {
      if (seq !== loadSeq) return
      set((s) => (s.load === "ready"
        ? { ...s, refreshing: false, notice: { tone: "error", message: messageOf(e, "The voices could not be loaded.") } }
        : { ...s, load: "error", refreshing: false, loadError: messageOf(e, "The voices could not be loaded.") }))
    }
  }

  /** One provider's list again (after a download finished or a model was deleted). */
  const reloadProvider = async (id: string) => {
    try {
      const answer = await json(VoicesResponse, `voices?provider=${encodeURIComponent(id)}`) // continuation(state): merges by provider id into the newest lists
      const fresh = answer.providers.find((p) => p.provider.id === id)
      if (fresh === undefined) return
      set((s) => ({ ...s, lists: s.lists.map((p) => (p.provider.id === id ? fresh : p)), selected: answer.selected }))
    } catch {
      // The next full load corrects it.
    }
  }

  const localProviders = () => get().lists.filter((p) => p.provider.location === "local").map((p) => p.provider.id)

  // Follow the client: a download job of a voice model that ended, or a change of the models (a download or delete
  // from the Models page), re-reads the local lists; a change of the vault or of a voices section (a key saved on
  // the Voice providers page) re-reads everything.
  let watching = false
  const watch = () => {
    if (watching) return
    watching = true
    let models = host.store.get().models
    let vault = host.store.get().vault.state
    const sectionsKey = (s: ClientState) => s.sections.filter((x) => x.group === "voices").map((x) => `${x.id}:${x.revision}`).join(",")
    let sections = sectionsKey(host.store.get())
    const ended = new Set(host.store.get().jobs.filter((j) => j.state !== "running").map((j) => j.id))
    let timer: ReturnType<typeof setTimeout> | undefined
    let full = false
    const soon = (all: boolean) => {
      full ||= all
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        const all = full
        full = false
        if (get().load !== "ready") return
        if (all) void reload()
        else for (const id of localProviders()) void reloadProvider(id)
      }, 150)
    }
    // A voice-model job that starts is re-read too: the voices of a shared archive (the Kokoro voices) all download
    // with it, and their entries then carry it (`local.job`), so every one of their rows shows the progress.
    const started = new Set(host.store.get().jobs.map((j) => j.id))
    host.store.subscribe(() => {
      const s = host.store.get()
      for (const j of s.jobs) {
        if (j.state === "running") {
          if (started.has(j.id)) continue
          started.add(j.id)
          if (j.tool === "tts-models") soon(false)
          continue
        }
        if (ended.has(j.id)) continue
        ended.add(j.id)
        started.add(j.id)
        if (j.tool === "tts-models") soon(false)
      }
      if (s.models !== models) {
        models = s.models
        soon(false)
      }
      const key = sectionsKey(s)
      if (s.vault.state !== vault || key !== sections) {
        vault = s.vault.state
        sections = key
        soon(true)
      }
    })
  }

  // ---- Preview: one at a time, for every picker of the page.
  let run: { readonly key: string; readonly controller: AbortController; audio?: HTMLAudioElement; url?: string } | undefined
  const stopPreview = () => {
    const r = run
    run = undefined
    if (r !== undefined) {
      r.controller.abort()
      if (r.audio !== undefined) {
        r.audio.onended = null
        r.audio.onerror = null
        r.audio.pause()
      }
      if (r.url !== undefined) URL.revokeObjectURL(r.url)
    }
    if (get().preview !== undefined) set({ preview: undefined })
  }

  const preview = async (key: string, voice: VoiceRefJson) => {
    if (get().preview?.key === key) return stopPreview()
    stopPreview()
    const mine = { key, controller: new AbortController() } as NonNullable<typeof run>
    run = mine
    set((s) => ({ ...s, preview: { key, phase: "loading" }, notice: s.notice?.key === key || s.notice?.tone === "error" ? undefined : s.notice }))
    const text = (get().previewText.trim() || DEFAULT_PREVIEW_TEXT).slice(0, MAX_PREVIEW_CHARS)
    try {
      const res = await api.request("voices/preview", { method: "POST", body: { voice, text }, signal: mine.controller.signal }) // continuation(state): `run === mine` is checked after every step
      const blob = await res.blob()
      if (run !== mine) return
      mine.url = URL.createObjectURL(blob)
      const audio = new Audio(mine.url)
      mine.audio = audio
      audio.onended = () => {
        if (run === mine) stopPreview()
      }
      audio.onerror = () => {
        if (run !== mine) return
        stopPreview()
        set({ notice: { key, tone: "error", message: "The browser could not play this preview." } })
      }
      await audio.play() // continuation(state): see above
      if (run !== mine) return
      set({ preview: { key, phase: "playing" } })
    } catch (e) {
      if (run !== mine || aborted(e)) return
      // A newer preview (from another tab) replaced this one: nothing to say.
      if (e instanceof ApiError && e.code === "superseded") return void stopPreview()
      stopPreview()
      const message = e instanceof ApiError && e.code === "busy"
        ? BUSY_TEXT
        : e instanceof DOMException
        ? "The browser did not play the preview (press the speaker again)."
        : messageOf(e, "The preview failed.")
      set({ notice: { key, tone: "error", message } })
    }
  }

  // ---- Favourites (on the server: the same on every device).
  const toggleFavourite = async (key: string, voice: VoiceRefJson, name: string) => {
    const before = get().favourites
    const on = before.some((f) => f.key === key)
    set({ favourites: on ? before.filter((f) => f.key !== key) : [...before, { voice, key, name, addedAt: Date.now() }] })
    try {
      const path = `voices/favourites/${encodeURIComponent(key)}`
      const answer = on
        ? await json(FavouritesResponse, path, { method: "DELETE" }) // continuation(state): the answer is the whole list
        : await json(FavouriteResponse, path, { method: "PUT", body: { name: name.slice(0, 100) || voice.voiceId } }) // continuation(state): see above
      set({ favourites: answer.favourites })
    } catch (e) {
      if (on && e instanceof ApiError && e.code === "not_found") return
      set({ favourites: before, notice: { key, tone: "error", message: messageOf(e, "The favourites could not be changed.") } })
    }
  }

  // ---- Downloads of voices on this machine (jobs, as on the Models page).
  const setDownload = (key: string, d: DownloadState | undefined) =>
    set((s) => {
      const { [key]: _old, ...rest } = s.downloads
      return { ...s, downloads: d === undefined ? rest : { ...rest, [key]: d } }
    })
  const download = async (key: string, voice: VoiceRefJson) => {
    if (get().downloads[key]?.starting === true) return
    setDownload(key, { ...get().downloads[key], starting: true })
    try {
      const { job } = await json(JobResponse, "voices/download", { method: "POST", body: { voice } }) // continuation(state): writes only this voice's entry
      setDownload(key, { job })
    } catch (e) {
      setDownload(key, undefined)
      if (e instanceof ApiError && e.code === "already_installed") return void reloadProvider(voice.provider)
      set({ notice: { key, tone: "error", message: messageOf(e, "The download did not start.") } })
    }
  }
  const cancelDownload = async (key: string, voice: VoiceRefJson) => {
    try {
      const answer = await json(CancelResponse, "voices/download/cancel", { method: "POST", body: { voice } }) // continuation(state): writes only this voice's entry
      setDownload(key, { job: answer.job })
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") return void reloadProvider(voice.provider)
      set({ notice: { key, tone: "error", message: messageOf(e, "The download could not be cancelled.") } })
    }
  }

  const loadDefault = async () => {
    try {
      const answer = await json(DefaultVoiceResponse, "voices/default") // continuation(state): last answer wins; it is the server's current value
      set({ defaultVoice: answer.default })
    } catch {
      // Shown without it: the picker still works.
    }
  }

  return {
    store,
    ensure: () => {
      watch()
      if (get().load === "idle") void reload()
    },
    reload,
    loadDefault,
    toggleFavourite,
    preview,
    stopPreview,
    setPreviewText: (previewText) => set({ previewText }),
    download,
    cancelDownload,
    dismissNotice: () => set({ notice: undefined })
  }
}

/** The download job of a voice (or, with `tool`, another model): a running one for it, else the newest of the one the picker started and the list's. */
export const jobOf = (
  jobs: ReadonlyArray<JobInfo>,
  d: DownloadState | undefined,
  listJob: JobInfo | undefined,
  target: string | undefined,
  tool = "tts-models"
): JobInfo | undefined => {
  const byId = (id: string | undefined) => (id === undefined ? undefined : jobs.find((j) => j.id === id))
  const own = byId(d?.job?.id) ?? d?.job
  const listed = byId(listJob?.id) ?? listJob
  const running = target === undefined ? undefined : jobs.find((j) => j.tool === tool && j.target === target && j.state === "running")
  return running ?? [own, listed].filter((j): j is JobInfo => j !== undefined).sort((a, b) => b.startedAt - a.startedAt)[0]
}
