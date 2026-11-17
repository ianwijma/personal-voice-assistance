"use client"
import { useMemo } from "react"
import type { ModelFavourite, PickerKind, ProviderModels } from "@pva/protocol"
import { type GenericFavourite, type GenericProvider, mapModelFavourite, mapModelProvider } from "@/lib/catalogPicker.ts"
import { createModelCatalog, type ModelCatalog } from "@/lib/modelCatalog.ts"
import type { AssistantClient } from "@/lib/client.ts"
import { jobOf } from "@/lib/voiceCatalog.ts"
import { shallowEqual, useStoreSelector } from "@/lib/store.ts"
import { useClient, useClientState } from "../context.tsx"
import type { PickerSource, PickerState, PickerWords } from "./CatalogPicker.tsx"

/**
 * The data adapters of the model pickers (docs/MODEL-PICKERS.md §6.2): `modelSource("llm")` and `modelSource("stt")`
 * map one catalog per kind and client (`lib/modelCatalog.ts`) to what `CatalogPicker` draws.
 */

const WORDS: Readonly<Record<PickerKind, PickerWords>> = {
  llm: {
    search: "Search all models…",
    searchLabel: "Search all models",
    refresh: "Ask the providers for their models again",
    loading: "Loading models…",
    loadFailed: "The models could not be loaded",
    noMatch: ["No models match", "Try another name, or a word from its facts."],
    noFavourites: ["No favourites yet", "Star a model to keep it here."],
    noRows: ["No models", "This provider has no models to offer."],
    rail: "Language model providers",
    none: "Choose a model",
    panel: "Models"
  },
  stt: {
    search: "Search all models…",
    searchLabel: "Search all models",
    refresh: "Ask the providers for their models again",
    loading: "Loading models…",
    loadFailed: "The models could not be loaded",
    noMatch: ["No models match", "Try another name, language or size."],
    noFavourites: ["No favourites yet", "Star a model to keep it here."],
    noRows: ["No models", "This provider has no models to offer."],
    rail: "Speech recognition providers",
    none: "Choose a model",
    panel: "Models"
  }
}

// What a catalog's answer maps to is computed once per answer, however many components read it.
const providersCache = new WeakMap<ReadonlyArray<ProviderModels>, ReadonlyArray<GenericProvider>>()
const favouritesCache = new WeakMap<ReadonlyArray<ModelFavourite>, ReadonlyArray<GenericFavourite>>()
const mappedProviders = (lists: ReadonlyArray<ProviderModels>) => {
  let v = providersCache.get(lists)
  if (v === undefined) providersCache.set(lists, (v = lists.map(mapModelProvider)))
  return v
}
const mappedFavourites = (favs: ReadonlyArray<ModelFavourite>) => {
  let v = favouritesCache.get(favs)
  if (v === undefined) favouritesCache.set(favs, (v = favs.map(mapModelFavourite)))
  return v
}

const catalogs = new WeakMap<AssistantClient, Partial<Record<PickerKind, ModelCatalog>>>()

export const modelCatalogFor = (client: AssistantClient, kind: PickerKind): ModelCatalog => {
  let byKind = catalogs.get(client)
  if (byKind === undefined) catalogs.set(client, (byKind = {}))
  return (byKind[kind] ??= createModelCatalog(kind, client))
}

const sources = new WeakMap<ModelCatalog, PickerSource>()

/** The picker source of one kind on one client (one per catalog, so its identity is stable). */
export const modelSource = (client: AssistantClient, kind: PickerKind): PickerSource => {
  const catalog = modelCatalogFor(client, kind)
  let source = sources.get(catalog)
  if (source === undefined) {
    const tool = "stt-models"
    source = {
      id: kind,
      noun: "model",
      words: WORDS[kind],
      emptyIcon: kind === "llm" ? "bolt" : "ear",
      useState: (): PickerState => {
        const s = useStoreSelector(catalog.store, (x) => ({ load: x.load, loadError: x.loadError, refreshing: x.refreshing, lists: x.lists, favourites: x.favourites, notice: x.notice }), shallowEqual)
        return { load: s.load, loadError: s.loadError, refreshing: s.refreshing, lists: mappedProviders(s.lists), favourites: mappedFavourites(s.favourites), notice: s.notice }
      },
      ensure: catalog.ensure,
      refresh: () => void catalog.reload(true),
      retry: () => void catalog.reload(),
      retryProvider: (id) => void catalog.reloadProvider(id, true),
      toggleFavourite: (key, name) => void catalog.toggleFavourite(key, name),
      ...(kind === "stt" ? { download: (key: string) => void catalog.download(key), cancelDownload: (key: string) => void catalog.cancelDownload(key) } : {}),
      useDownload: (key, row) => {
        const d = useStoreSelector(catalog.store, (x) => x.downloads[key])
        const job = useClientState((s) => (row?.local === undefined ? undefined : jobOf(s.jobs, d, row.local.job, key.slice(key.indexOf(":") + 1), tool)))
        return { starting: d?.starting === true, job }
      },
      useRowPhase: () => undefined,
      typed: (providerId, text) => ({ apply: { llm: { account: providerId as "anthropic", model: text } } }),
      onClose: () => catalog.dismissNotice()
    }
    sources.set(catalog, source)
  }
  return source
}

export const useModelSource = (kind: PickerKind): PickerSource => {
  const client = useClient()
  return useMemo(() => modelSource(client, kind), [client, kind])
}
