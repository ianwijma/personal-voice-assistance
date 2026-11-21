"use client"
import { type CSSProperties, useEffect, useState } from "react"
import { createAssistantClient } from "@/lib/client.ts"
import { ChatPanel } from "../ChatPanel.tsx"
import { shallowEqual } from "@/lib/store.ts"
import { ClientContext, useClientState } from "../context.tsx"
import { ControlDock } from "../ControlDock.tsx"
import { MediaSurface } from "../media/MediaSurface.tsx"
import { LiveAnnouncer } from "../LiveAnnouncer.tsx"
import { NotificationCards } from "../NotificationCards.tsx"
import { PresentationStage } from "../PresentationStage.tsx"
import { ShortcutsDialog } from "../ShortcutsDialog.tsx"
import { Stage } from "../Stage.tsx"
import { StateAnnouncer } from "../StateLabel.tsx"
import { Toasts } from "../Toasts.tsx"
import { TopBar } from "../TopBar.tsx"
import { useMediaQuery, WIDE_QUERY } from "../useMediaQuery.ts"
import { useShortcuts } from "../useShortcuts.ts"
import { useSessionFocus } from "./useSessionFocus.ts"
import { PageMenus } from "./PageMenus.tsx"
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
 * `inert`. Every page menu or dialog hides and inerts the presentation stage on every width. Notifications have a
 * fixed strip above menus and dialogs, reserved even when empty, so a ring never moves or covers a menu item. Dialog scopes include
 * the strip. Toasts and the screen-reader announcers stay outside, above every panel.
 */
function Shell() {
  useShortcuts()
  useSessionFocus()
  const ui = useClientState((s) => ({ chat: s.ui.chatOpen, sheet: s.ui.sheetOpen, help: s.ui.shortcutsOpen }), shallowEqual)
  const [menus, setMenus] = useState<ReadonlyArray<string>>([])
  const wide = useMediaQuery(WIDE_QUERY)
  const modal = ui.sheet || ui.help
  const behind = modal || (ui.chat && !wide)
  const stageCovered = modal || ui.chat || menus.length > 0
  return (
    <PageMenus.Provider value={{ surface: ui.help ? "help" : ui.sheet ? "settings" : ui.chat ? "chat" : "page", ids: menus, set: setMenus }}>
      <div
        style={{ "--pva-notifications-space": "calc(88px + env(safe-area-inset-top))" } as CSSProperties}
        className="fixed inset-0 flex flex-col overflow-hidden pt-[var(--pva-notifications-space)] pb-[env(safe-area-inset-bottom)]"
      >
        <h1 className="sr-only">Voice assistant</h1>
        <div id="voice-notifications" data-testid="voice-notifications" data-keep-active="" className="fixed inset-x-4 top-[calc(8px+env(safe-area-inset-top))] z-[70] mx-auto h-[72px] max-w-[420px]">
          <NotificationCards />
        </div>
        <div className="contents" inert={behind} data-testid="page-behind">
          <TopBar />
          <main className="relative min-h-0 flex-1" data-chat-open={ui.chat || undefined}>
            <Stage />
            <ControlDock />
          </main>
          {/* The player surface (music panel, theatre): inert with the page while a modal panel is open. */}
          <MediaSurface />
        </div>
        <div className="contents" inert={modal}>
          <ChatPanel />
        </div>
        <div className={stageCovered ? "hidden" : "contents"} hidden={stageCovered} inert={stageCovered}>
          {/* Ordinary presentations yield to open menus and dialogs; notifications keep their fixed place above. */}
          <PresentationStage obscured={stageCovered} />
        </div>
        <VoiceSheet />
        <ShortcutsDialog />
        <Toasts />
        <StateAnnouncer />
        <LiveAnnouncer />
      </div>
    </PageMenus.Provider>
  )
}
