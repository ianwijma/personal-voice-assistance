import type { ComponentType } from "react"
import { AboutTab } from "@/components/AboutTab.tsx"
import { AssistantTab } from "@/components/AssistantTab.tsx"
import { DeviceTab } from "@/components/DeviceTab.tsx"
import { KeysTab } from "@/components/KeysPanel.tsx"
import { ModulesTab } from "@/components/ModulesTab.tsx"
import {
  AudioErrorCard,
  ConnectingHint,
  ObserverBanner,
  OutdatedNotice,
  ResumeAudio,
  StartHint,
  StartPrompt
} from "@/components/overlays.tsx"
import type { ClientState } from "@/lib/state.ts"
import { KEYS_TAB } from "@/lib/vault.ts"

/**
 * The extension points of the UI (docs/UI-AND-MODULES.md §3.12). A new panel or
 * stage element is one component file plus one line here.
 */

export interface OptionTab {
  readonly id: string
  readonly title: string
  readonly component: ComponentType
  /** Show the tab only when this holds (default: always). */
  readonly when?: (s: ClientState) => boolean
}

/** Tabs of the options drawer, in order. */
export const optionTabs: ReadonlyArray<OptionTab> = [
  { id: "modules", title: "Modules", component: ModulesTab },
  { id: "assistant", title: "Assistant", component: AssistantTab },
  { id: KEYS_TAB, title: "Keys & access", component: KeysTab },
  { id: "device", title: "This device", component: DeviceTab },
  { id: "about", title: "About", component: AboutTab }
]

export interface StageOverlay {
  readonly id: string
  readonly component: ComponentType
  /** Rendered under the visualiser while this holds; several may show, in this order. */
  readonly when: (s: ClientState) => boolean
}

const open = (s: ClientState) => s.connection.status === "open"
const audioHere = (s: ClientState) => s.session.role === "owner" && s.audio.phase !== "off"

/** Elements shown on the stage under the visualiser, first to last. */
export const stageOverlays: ReadonlyArray<StageOverlay> = [
  { id: "outdated", component: OutdatedNotice, when: (s) => s.connection.status === "outdated" },
  { id: "connecting", component: ConnectingHint, when: (s) => s.connection.status === "connecting" },
  { id: "audio-error", component: AudioErrorCard, when: (s) => open(s) && s.audio.phase === "error" },
  {
    id: "start",
    component: StartPrompt,
    when: (s) => open(s) && !s.session.ownerPresent && (s.audio.phase === "off" || s.audio.phase === "starting")
  },
  {
    id: "observer",
    component: ObserverBanner,
    when: (s) => open(s) && s.session.ownerPresent && !audioHere(s) && s.audio.phase !== "error"
  },
  { id: "resume", component: ResumeAudio, when: (s) => audioHere(s) && s.audio.phase === "suspended" },
  { id: "start-hint", component: StartHint, when: (s) => open(s) && audioHere(s) && s.audio.phase === "running" }
]

export { fieldRenderers } from "./fieldRenderers.ts"
