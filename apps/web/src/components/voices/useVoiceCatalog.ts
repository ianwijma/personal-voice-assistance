"use client"
import type { AssistantClient } from "@/lib/client.ts"
import { type CatalogState, createVoiceCatalog, type VoiceCatalog } from "@/lib/voiceCatalog.ts"
import { useStoreSelector } from "@/lib/store.ts"
import { useClient } from "../context.tsx"

/** One catalog per client: every voice picker on the page shares its lists, favourites and preview. */
const catalogs = new WeakMap<AssistantClient, VoiceCatalog>()

export const catalogFor = (client: AssistantClient): VoiceCatalog => {
  let catalog = catalogs.get(client)
  if (catalog === undefined) {
    catalog = createVoiceCatalog(client)
    catalogs.set(client, catalog)
  }
  return catalog
}

export const useVoiceCatalog = (): VoiceCatalog => catalogFor(useClient())

export const useCatalogState = <T,>(selector: (s: CatalogState) => T, isEqual?: (a: T, b: T) => boolean): T =>
  useStoreSelector(useVoiceCatalog().store, selector, isEqual)
