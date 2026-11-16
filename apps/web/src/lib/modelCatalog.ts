import {
  CancelResponse,
  JobResponse,
  type ModelFavourite,
  ModelFavouriteResponse,
  ModelFavouritesResponse,
  type PickerKind,
  type ProviderModels,
  ModelsResponse,
  parseModelKey
} from "@pva/protocol"
import { Schema } from "effect"
import { resolveWsUrl } from "./connection.ts"
import type { ClientState } from "./state.ts"
import { createStore, type Store } from "./store.ts"
import { ApiError, apiBaseFor, type CatalogHost, type CatalogNotice, type DownloadState, makeVoiceApi, type VoiceApi } from "./voiceCatalog.ts"

/**
 * The model pickers' data (docs/MODEL-PICKERS.md §4, §6.2): one catalog per kind (`llm`, `stt`) and client, as
 * `voiceCatalog.ts` is for voices: every provider's models, the favourites, and the downloads the picker started
 * (recogniser models on this machine; their progress comes from the `job` messages the admin socket receives).
 * Lists are fetched when a picker first opens, never on a turn's path.
 */

export interface ModelCatalogState {
  readonly load: "idle" | "loading" | "ready" | "error"
  readonly loadError?: string | undefined
  readonly refreshing: boolean
  readonly lists: ReadonlyArray<ProviderModels>
  readonly favourites: ReadonlyArray<ModelFavourite>
  readonly downloads: Readonly<Record<string, DownloadState>>
  readonly notice?: CatalogNotice | undefined
}

export const initialModelCatalog: ModelCatalogState = { load: "idle", refreshing: false, lists: [], favourites: [], downloads: {} }

type Update = Partial<ModelCatalogState> | ((s: ModelCatalogState) => ModelCatalogState)

export interface ModelCatalog {
  readonly kind: PickerKind
  readonly store: Store<ModelCatalogState, Update>
  /** Load the lists and favourites once (the first picker on a page). */
  readonly ensure: () => void
  /** Load again; `refresh`: ask the providers again now (`?refresh=1`). */
  readonly reload: (refresh?: boolean) => Promise<void>
  /** One provider's list again; `refresh`: ask the provider again now. */
  readonly reloadProvider: (id: string, refresh?: boolean) => Promise<void>
  readonly toggleFavourite: (key: string, name: string) => Promise<void>
  readonly download: (key: string) => Promise<void>
  readonly cancelDownload: (key: string) => Promise<void>
  readonly dismissNotice: () => void
}

const decode = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] => Schema.decodeUnknownSync(schema as never)(value) as S["Type"]
const messageOf = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback)

/** The settings sections whose change re-reads the lists: a key or address saved, a module switched on. */
const SECTION_GROUPS: Readonly<Record<PickerKind, ReadonlyArray<string>>> = { llm: ["agents"], stt: ["speech"] }

export const createModelCatalog = (kind: PickerKind, host: CatalogHost, api: VoiceApi = makeVoiceApi(() => apiBaseFor(resolveWsUrl(location)))): ModelCatalog => {
  const store = createStore<ModelCatalogState, Update>(initialModelCatalog, (s, u) => (typeof u === "function" ? u(s) : { ...s, ...u }))
  const set = (u: Update) => store.dispatch(u)
  const get = store.get
  const noun = kind === "llm" ? "language models" : "speech recognition models"

  const json = async <S extends Schema.Top>(schema: S, path: string, init?: Parameters<VoiceApi["request"]>[1]): Promise<S["Type"]> =>
    decode(schema, await (await api.request(path, init)).json())

  let loadSeq = 0
  const reload = async (refresh = false) => {
    const seq = ++loadSeq
    set((s) => ({ ...s, ...(s.load === "ready" ? { refreshing: true } : { load: "loading" as const }) }))
    try {
      const [models, favs] = await Promise.all([ // continuation(state): only the newest load writes (`seq`)
        json(ModelsResponse, `models/${kind}${refresh ? "?refresh=1" : ""}`),
        json(ModelFavouritesResponse, `models/${kind}/favourites`)
      ])
      if (seq !== loadSeq) return
      const { loadError: _e, ...rest } = get()
      set(() => ({ ...rest, load: "ready", refreshing: false, lists: models.providers, favourites: favs.favourites }))
    } catch (e) {
      if (seq !== loadSeq) return
      const message = messageOf(e, `The ${noun} could not be loaded.`)
      set((s) => (s.load === "ready" ? { ...s, refreshing: false, notice: { tone: "error", message } } : { ...s, load: "error", refreshing: false, loadError: message }))
    }
  }

  const reloadProvider = async (id: string, refresh = false) => {
    if (refresh) set({ refreshing: true })
    try {
      const answer = await json(ModelsResponse, `models/${kind}?provider=${encodeURIComponent(id)}${refresh ? "&refresh=1" : ""}`) // continuation(state): merges by provider id into the newest lists
      const fresh = answer.providers.find((p) => p.provider.id === id)
      set((s) => ({ ...s, refreshing: false, lists: fresh === undefined ? s.lists : s.lists.map((p) => (p.provider.id === id ? fresh : p)) }))
    } catch (e) {
      set((s) => ({ ...s, refreshing: false, ...(refresh ? { notice: { tone: "error" as const, message: messageOf(e, `The ${noun} could not be loaded.`) } } : {}) }))
    }
  }

  // Follow the client: a download job of a recogniser model starting or ending, or a change of the models (a download
  // from the Models page), re-reads the machine's list; a change of the vault, of the settings sections that hold the
  // keys and addresses, or of the Claude subscription module re-reads everything.
  let watching = false
  const watch = () => {
    if (watching) return
    watching = true
    const groups = SECTION_GROUPS[kind]
    const sectionsKey = (s: ClientState) => s.sections.filter((x) => x.group !== undefined && groups.includes(x.group)).map((x) => `${x.id}:${x.revision}`).join(",")
    const subscription = (s: ClientState) => (kind === "llm" ? `${s.modules.byId["claude-subscription"]?.state}:${s.modules.byId["claude-subscription"]?.enabled}` : "")
    let models = host.store.get().models
    let vault = host.store.get().vault.state
    let sections = sectionsKey(host.store.get())
    let sub = subscription(host.store.get())
    const seen = new Set(host.store.get().jobs.map((j) => (j.state === "running" ? `r:${j.id}` : `e:${j.id}`)))
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
        else void reloadProvider("sherpa")
      }, 150)
    }
    host.store.subscribe(() => {
      const s = host.store.get()
      if (kind === "stt") {
        for (const j of s.jobs) {
          if (j.tool !== "stt-models") continue
          const id = `${j.state === "running" ? "r" : "e"}:${j.id}`
          if (seen.has(id)) continue
          seen.add(id)
          soon(false)
        }
        if (s.models !== models) {
          models = s.models
          soon(false)
        }
      }
      const key = sectionsKey(s)
      const now = subscription(s)
      if (s.vault.state !== vault || key !== sections || now !== sub) {
        vault = s.vault.state
        sections = key
        sub = now
        soon(true)
      }
    })
  }

  // ---- Favourites (on the server: the same on every device).
  const toggleFavourite = async (key: string, name: string) => {
    const ref = parseModelKey(key)
    if (ref === undefined) return
    const before = get().favourites
    const on = before.some((f) => f.key === key)
    set({ favourites: on ? before.filter((f) => f.key !== key) : [...before, { model: ref, key, name, addedAt: Date.now() }] })
    try {
      const path = `models/${kind}/favourites/${encodeURIComponent(key)}`
      const answer = on
        ? await json(ModelFavouritesResponse, path, { method: "DELETE" }) // continuation(state): the answer is the whole list
        : await json(ModelFavouriteResponse, path, { method: "PUT", body: { name: name.slice(0, 100) || ref.modelId } }) // continuation(state): see above
      set({ favourites: answer.favourites })
    } catch (e) {
      if (on && e instanceof ApiError && e.code === "not_found") return
      set({ favourites: before, notice: { key, tone: "error", message: messageOf(e, "The favourites could not be changed.") } })
    }
  }

  // ---- Downloads of recogniser models on this machine (jobs, as on the Models page).
  const setDownload = (key: string, d: DownloadState | undefined) =>
    set((s) => {
      const { [key]: _old, ...rest } = s.downloads
      return { ...s, downloads: d === undefined ? rest : { ...rest, [key]: d } }
    })
  const download = async (key: string) => {
    const ref = parseModelKey(key)
    if (ref === undefined || kind !== "stt" || get().downloads[key]?.starting === true) return
    setDownload(key, { ...get().downloads[key], starting: true })
    try {
      const { job } = await json(JobResponse, "models/stt/download", { method: "POST", body: { model: ref } }) // continuation(state): writes only this model's entry
      setDownload(key, { job })
    } catch (e) {
      setDownload(key, undefined)
      if (e instanceof ApiError && e.code === "already_installed") return void reloadProvider(ref.provider)
      set({ notice: { key, tone: "error", message: messageOf(e, "The download did not start.") } })
    }
  }
  const cancelDownload = async (key: string) => {
    const ref = parseModelKey(key)
    if (ref === undefined || kind !== "stt") return
    try {
      const answer = await json(CancelResponse, "models/stt/download/cancel", { method: "POST", body: { model: ref } }) // continuation(state): writes only this model's entry
      setDownload(key, { job: answer.job })
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") return void reloadProvider(ref.provider)
      set({ notice: { key, tone: "error", message: messageOf(e, "The download could not be cancelled.") } })
    }
  }

  return {
    kind,
    store,
    ensure: () => {
      watch()
      if (get().load === "idle") void reload()
    },
    reload,
    reloadProvider,
    toggleFavourite,
    download,
    cancelDownload,
    dismissNotice: () => set({ notice: undefined })
  }
}
