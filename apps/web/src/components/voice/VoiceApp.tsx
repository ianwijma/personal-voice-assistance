"use client"
import { useEffect, useState } from "react"
import { createAssistantClient } from "@/lib/client.ts"
import { ChatPanel } from "../ChatPanel.tsx"
import { shallowEqual } from "@/lib/store.ts"
import { ClientContext, useClientState } from "../context.tsx"
import { ControlDock } from "../ControlDock.tsx"
import { LiveAnnouncer } from "../LiveAnnouncer.tsx"
import { PresentationStage } from "../PresentationStage.tsx"
import { ShortcutsDialog } from "../ShortcutsDialog.tsx"
import { Stage } from "../Stage.tsx"
import { StateAnnouncer } from "../StateLabel.tsx"
import { Toasts } from "../Toasts.tsx"
import { TopBar } from "../TopBar.tsx"
import { useMediaQuery, WIDE_QUERY } from "../useMediaQuery.ts"
import { useShortcuts } from "../useShortcuts.ts"
import { useSessionFocus } from "./useSessionFocus.ts"
import { VoiceSheet } from "./VoiceSheet.tsx"

/**
 * The voice front end (`/`): the stage, the controls, the conversation and one small settings sheet. Nothing of the
 * admin screen is imported here, so this page's bundle does not carry it (docs/FRONTENDS-AND-ACTIVATION.md §5).
 */
export function VoiceApp() {
  const [client] = useState(() => createAssistantClient({ frontend: "voice" }))
  useEffect(() => client.connect(), [client])
  // `?character=<id>&opt.<id>=<value>` tries a character for this page load: the stage reads it (`Visualiser.tsx`).
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

/**
 * While a modal panel is open (the settings sheet, Help, or the chat as a sheet below 1024 px) everything behind it is
 * `inert`; notification ring controls remain available over chat. Toasts and the screen-reader announcers stay outside,
 * above every panel.
 */
function Shell() {
  useShortcuts()
  useSessionFocus()
  const ui = useClientState((s) => ({ chat: s.ui.chatOpen, sheet: s.ui.sheetOpen, help: s.ui.shortcutsOpen }), shallowEqual)
  const wide = useMediaQuery(WIDE_QUERY)
  const modal = ui.sheet || ui.help
  const behind = modal || (ui.chat && !wide)
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <h1 className="sr-only">Voice assistant</h1>
      <div className="contents" inert={behind} data-testid="page-behind">
        <TopBar />
        <main className="relative min-h-0 flex-1" data-chat-open={ui.chat || undefined}>
          <Stage />
          <ControlDock />
        </main>
      </div>
      <div className="contents" inert={modal}>
        <ChatPanel />
      </div>
      <div className="contents" inert={modal}>
        {/* P10: the presentation stage beside the character: P9's notification cards first, then the presentations. */}
        <PresentationStage obscured={ui.chat && !wide} />
      </div>
      <VoiceSheet />
      <ShortcutsDialog />
      <Toasts />
      <StateAnnouncer />
      <LiveAnnouncer />
    </div>
  )
}
