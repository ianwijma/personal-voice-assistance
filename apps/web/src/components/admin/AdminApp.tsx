"use client"
import { useEffect, useState } from "react"
import { createAssistantClient } from "@/lib/client.ts"
import { ClientContext, useClientState } from "../context.tsx"
import { AdminShell } from "./AdminShell.tsx"
import { LoginScreen } from "./LoginScreen.tsx"

/**
 * The admin front end (`/admin/`): a login, then the two-level settings screen as the page itself
 * (docs/FRONTENDS-AND-ACTIVATION.md §5). It never claims the audio and never asks for the microphone.
 */
export function AdminApp() {
  const [client] = useState(() => {
    const c = createAssistantClient({ frontend: "admin" })
    // The settings screen is this page: always open.
    c.store.dispatch({ type: "local/ui", patch: { settingsOpen: true } })
    return c
  })
  useEffect(() => client.connect(), [client])
  useEffect(() => {
    ;(window as unknown as { __pva?: unknown }).__pva = client
  }, [client])
  return (
    <ClientContext.Provider value={client}>
      <Gate />
    </ClientContext.Provider>
  )
}

function Gate() {
  const inside = useClientState((s) => s.admin.loggedIn && s.adminReady)
  return inside ? <AdminShell /> : <LoginScreen />
}
