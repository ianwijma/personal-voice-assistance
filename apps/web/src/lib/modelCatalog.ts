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

  /**
   * The downloads whose job had succeeded when a list was asked for (key → job id). That list says whether the model
   * is still installed (it may have been deleted since), so their records go when it arrives (`settle`).
   */
  const finishedDownloads = (): ReadonlyMap<string, string> => {
    const jobs = host.store.get().jobs
    const out = new Map<string, string>()
    for (const [key, d] of Object.entries(get().downloads)) {
      const id = d.job?.id
      if (id === undefined || d.starting === true) continue
      if ((jobs.find((j) => j.id === id) ?? d.job)?.state === "succeeded") out.set(key, id)
    }
    return out
  }
  const settle = (downloads: ModelCatalogState["downloads"], finished: ReadonlyMap<string, string>): ModelCatalogState["downloads"] =>
    finished.size === 0
      ? downloads
      : Object.fromEntries(Object.entries(downloads).filter(([key, d]) => d.starting === true || d.job?.id === undefined || finished.get(key) !== d.job?.id))

  // Every request that writes a provider's list (a full load, or one provider's) takes the next `listSeq`; an answer
  // writes a provider's list only if no newer request's answer has written it (`listAt`), whichever kind that was.
  // So an older answer never brings back a list (or settings) a newer one replaced.
  let listSeq = 0
  const listAt = new Map<string, number>()
  const newer = (id: string, at: number) => at > (listAt.get(id) ?? 0)
  // `refreshing` is true while any request that shows it is pending, not only the one that ended last.
  let busy = 0
  const busyStart = () => {
    busy++
    set({ refreshing: true })
  }
  const busyEnd = () => {
    busy--
    if (busy === 0) set({ refreshing: false })
  }

  let loadSeq = 0
  const reload = async (refresh = false) => {
    const seq = ++loadSeq
    const at = ++listSeq
    const finished = finishedDownloads()
    // The favourites answer is shown only if no favourite change was pending when it was asked for or started since:
    // otherwise it may predate that change, and the change's own answer (or the optimistic state) is newer.
    const favAt = favPending === 0 ? favSeq : -1
    const marked = get().load === "ready"
    if (marked) busyStart()
    else set({ load: "loading" })
    try {
      const [models, favs] = await Promise.all([ // continuation(state): only the newest load writes (`seq`), each list only if newest (`listAt`)
        json(ModelsResponse, `models/${kind}${refresh ? "?refresh=1" : ""}`),
        json(ModelFavouritesResponse, `models/${kind}/favourites`)
      ])
      if (marked) busyEnd()
      if (seq !== loadSeq) return
      const { loadError: _e, ...rest } = get()
      const lists = models.providers.map((p) => {
        const id = p.provider.id
        const kept = newer(id, at) ? undefined : rest.lists.find((q) => q.provider.id === id)
        if (kept !== undefined) return kept
        listAt.set(id, Math.max(at, listAt.get(id) ?? 0))
        return p
      })
      set(() => ({ ...rest, load: "ready", lists, favourites: favAt === favSeq && favPending === 0 ? favs.favourites : rest.favourites, downloads: settle(rest.downloads, finished) }))
    } catch (e) {
      if (marked) busyEnd()
      if (seq !== loadSeq) return
      const message = messageOf(e, `The ${noun} could not be loaded.`)
      set((s) => (s.load === "ready" ? { ...s, notice: { tone: "error", message } } : { ...s, load: "error", loadError: message }))
    }
  }

  const reloadProvider = async (id: string, refresh = false) => {
    const at = ++listSeq
    if (refresh) busyStart()
    const finished = finishedDownloads()
    try {
      const answer = await json(ModelsResponse, `models/${kind}?provider=${encodeURIComponent(id)}${refresh ? "&refresh=1" : ""}`) // continuation(state): writes this provider's list only if newest (`listAt`)
      if (refresh) busyEnd()
      const fresh = answer.providers.find((p) => p.provider.id === id)
      const s = get()
      if (fresh === undefined || !newer(id, at) || !s.lists.some((p) => p.provider.id === id)) return
      listAt.set(id, at)
      set({
        lists: s.lists.map((p) => (p.provider.id === id ? fresh : p)),
        downloads: settle(s.downloads, new Map([...finished].filter(([key]) => key.startsWith(`${id}:`))))
      })
    } catch (e) {
      if (refresh) busyEnd()
      // A newer answer for this provider already arrived: this failure is old news.
      if (refresh && newer(id, at)) set({ notice: { tone: "error", message: messageOf(e, `The ${noun} could not be loaded.`) } })
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

  // ---- Favourites (on the server: the same on every device). The changes go to the server one at a time, in the
  // order they were made, and only the newest one's answer is shown: an older answer would undo a newer star.
  let favourites: Promise<void> = Promise.resolve()
  let favSeq = 0
  let favPending = 0
  /** The server's list as of the last answer (while changes are pending). */
  let favConfirmed: ReadonlyArray<ModelFavourite> = []
  const toggleFavourite = (key: string, name: string): Promise<void> => {
    const ref = parseModelKey(key)
    if (ref === undefined) return favourites
    const before = get().favourites
    if (favPending === 0) favConfirmed = before
    favPending++
    const seq = ++favSeq
    const on = before.some((f) => f.key === key)
    set({ favourites: on ? before.filter((f) => f.key !== key) : [...before, { model: ref, key, name, addedAt: Date.now() }] })
    const change = async () => {
      let notice: CatalogNotice | undefined
      try {
        const path = `models/${kind}/favourites/${encodeURIComponent(key)}`
        const answer = on
          ? await json(ModelFavouritesResponse, path, { method: "DELETE" }) // continuation(state): the answer is the whole list; only the newest change writes it (`favSeq`)
          : await json(ModelFavouriteResponse, path, { method: "PUT", body: { name: name.slice(0, 100) || ref.modelId } }) // continuation(state): see above
        favConfirmed = answer.favourites
      } catch (e) {
        if (on && e instanceof ApiError && e.code === "not_found") favConfirmed = favConfirmed.filter((f) => f.key !== key)
        else notice = { key, tone: "error", message: messageOf(e, "The favourites could not be changed.") }
      }
      favPending--
      if (seq === favSeq) set({ favourites: favConfirmed })
      if (notice !== undefined) set({ notice })
    }
    favourites = favourites.then(change)
    return favourites
  }

  // ---- Downloads of recogniser models on this machine (jobs, as on the Models page).
  const setDownload = (key: string, d: DownloadState | undefined) =>
    set((s) => {
      const { [key]: _old, ...rest } = s.downloads
      return { ...s, downloads: d === undefined ? rest : { ...rest, [key]: d } }
    })
  // A model's record is written by its download and its cancel; only the newest of those started for it writes (`dlAt`).
  let dlSeq = 0
  const dlAt = new Map<string, number>()
  const download = async (key: string) => {
    const ref = parseModelKey(key)
    if (ref === undefined || kind !== "stt" || get().downloads[key]?.starting === true) return
    const at = ++dlSeq
    dlAt.set(key, at)
    setDownload(key, { ...get().downloads[key], starting: true })
    try {
      const { job } = await json(JobResponse, "models/stt/download", { method: "POST", body: { model: ref } }) // continuation(state): writes only this model's entry, only if newest (`dlAt`)
      if (dlAt.get(key) !== at) return
      setDownload(key, { job })
    } catch (e) {
      if (dlAt.get(key) !== at) return
      setDownload(key, undefined)
      if (e instanceof ApiError && e.code === "already_installed") return void reloadProvider(ref.provider)
      set({ notice: { key, tone: "error", message: messageOf(e, "The download did not start.") } })
    }
  }
  const cancelDownload = async (key: string) => {
    const ref = parseModelKey(key)
    if (ref === undefined || kind !== "stt") return
    const at = ++dlSeq
    dlAt.set(key, at)
    try {
      const answer = await json(CancelResponse, "models/stt/download/cancel", { method: "POST", body: { model: ref } }) // continuation(state): writes only this model's entry, only if newest (`dlAt`)
      if (dlAt.get(key) !== at) return
      setDownload(key, { job: answer.job })
    } catch (e) {
      if (dlAt.get(key) !== at) return
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
