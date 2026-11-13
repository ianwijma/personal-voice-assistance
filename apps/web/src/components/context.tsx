"use client"
import type { Diagnostics } from "@/lib/audio/diagnostics.ts"
import { createContext, useContext } from "react"
import type { AssistantClient } from "@/lib/client.ts"
import type { Prefs } from "@/lib/prefs.ts"
import type { ClientState } from "@/lib/state.ts"
import { useStoreSelector } from "@/lib/store.ts"

export const ClientContext = createContext<AssistantClient | null>(null)

export const useClient = (): AssistantClient => {
  const client = useContext(ClientContext)
  if (client === null) throw new Error("useClient outside <ClientContext.Provider>")
  return client
}

/** Read a slice of the client state; re-renders only when it changes (per `isEqual`). */
export const useClientState = <T,>(selector: (s: ClientState) => T, isEqual?: (a: T, b: T) => boolean): T =>
  useStoreSelector(useClient().store, selector, isEqual)

export const usePrefs = <T,>(selector: (p: Prefs) => T, isEqual?: (a: T, b: T) => boolean): T =>
  useStoreSelector(useClient().prefs, selector, isEqual)

export const useDiagnostics = <T,>(selector: (d: Diagnostics) => T, isEqual?: (a: T, b: T) => boolean): T =>
  useStoreSelector(useClient().diagnostics, selector, isEqual)
