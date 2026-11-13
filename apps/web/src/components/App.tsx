"use client"
import { useEffect, useState } from "react"
import { createAssistantClient } from "@/lib/client.ts"
import { ChatPanel } from "./ChatPanel.tsx"
import { ClientContext, useClientState } from "./context.tsx"
import { ControlDock } from "./ControlDock.tsx"
import { LiveAnnouncer } from "./LiveAnnouncer.tsx"
import { OptionsDrawer } from "./OptionsDrawer.tsx"
import { ShortcutsDialog } from "./ShortcutsDialog.tsx"
import { Stage } from "./Stage.tsx"
import { Toasts } from "./Toasts.tsx"
import { TopBar } from "./TopBar.tsx"
import { useShortcuts } from "./useShortcuts.ts"

export function App() {
  const [client] = useState(createAssistantClient)
  useEffect(() => client.connect(), [client])
  useEffect(() => {
    // For tests and debugging in the console.
    ;(window as unknown as { __pva?: unknown }).__pva = client
  }, [client])
  return (
    <ClientContext.Provider value={client}>
      <Shell />
    </ClientContext.Provider>
  )
}

function Shell() {
  useShortcuts()
  const chatOpen = useClientState((s) => s.ui.chatOpen)
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <TopBar />
      <main className="relative min-h-0 flex-1" data-chat-open={chatOpen || undefined}>
        <Stage />
        <ControlDock />
        <Toasts />
      </main>
      <ChatPanel />
      <OptionsDrawer />
      <ShortcutsDialog />
      <LiveAnnouncer />
    </div>
  )
}
