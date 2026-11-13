import type { ComponentType } from "react"
import {
  AudioErrorCard,
  ConnectingHint,
  ObserverBanner,
  OutdatedNotice,
  ResumeAudio,
  StartHint,
  StartPrompt
} from "@/components/overlays.tsx"
import { AboutPage } from "@/components/settings/pages/AboutPage.tsx"
import { AccessPage, KeysListPage } from "@/components/settings/pages/AccessPages.tsx"
import { AudioProcessingPage, DisplayPage, MicrophonePage } from "@/components/settings/pages/DevicePages.tsx"
import { LatencyPage, ProblemsPage } from "@/components/settings/pages/DiagnosticsPages.tsx"
import { SpeechModelsPage, VoiceModelsPage } from "@/components/settings/pages/ModelsPages.tsx"
import { OverridesPage } from "@/components/settings/pages/OverridesPage.tsx"
import { OverviewPage } from "@/components/settings/pages/OverviewPage.tsx"
import type { ClientPageRef } from "@/lib/settingsTree.ts"
import type { ClientState } from "@/lib/state.ts"

/**
 * The extension points of the UI (docs/UI-AND-MODULES.md §3.12). A new settings
 * page or stage element is one component file plus one line here.
 */

/**
 * A page of the settings screen that the client itself provides (docs/SETTINGS-UI.md §2.2). `group` is a category
 * slug of `settingsGroups` (`lib/settingsTree.ts`); pages sort by `order` with the server's pages of that category
 * (sections 10–100, modules from 500). Everything else on the screen comes from the server's data.
 */
export interface SettingsPageEntry extends ClientPageRef {
  readonly component: ComponentType
}

export const settingsPages: ReadonlyArray<SettingsPageEntry> = [
  { group: "overview", id: "overview", title: "Overview", description: "What is set up, and what still needs doing.", order: 0, component: OverviewPage },
  { group: "keys", id: "access", title: "Edit access & vault", description: "Who may change keys, providers and agents.", order: 10, component: AccessPage },
  { group: "keys", id: "keys", title: "Keys", description: "Every key, whether it is set, and what uses it.", order: 20, component: KeysListPage },
  { group: "device", id: "microphone", title: "Microphone & speaker", description: "Saved in this browser only.", order: 10, component: MicrophonePage },
  { group: "device", id: "audio-processing", title: "Audio processing", description: "Saved in this browser only.", order: 20, component: AudioProcessingPage },
  { group: "device", id: "display", title: "Display", description: "Saved in this browser only.", order: 30, component: DisplayPage },
  { group: "diagnostics", id: "latency", title: "Latency", description: "How fast the last replies started.", order: 20, component: LatencyPage },
  { group: "diagnostics", id: "problems", title: "Problems", description: "Engines and modules that could not start.", order: 30, component: ProblemsPage },
  { group: "diagnostics", id: "overrides", title: "Settings from outside", description: "What .env and the environment set, and moving it into the settings.", order: 40, component: OverridesPage },
  { group: "speech", id: "models", title: "Models", description: "The speech recognition models on this machine: download and delete.", order: 90, component: SpeechModelsPage },
  { group: "voices", id: "models", title: "Models", description: "The voice models on this machine: download and delete.", order: 90, component: VoiceModelsPage },
  { group: "about", id: "about", title: "About", description: "Version, connection and keyboard shortcuts.", order: 0, component: AboutPage }
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
