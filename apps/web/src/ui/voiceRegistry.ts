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
import type { ClientState } from "@/lib/state.ts"

/**
 * The voice front end's extension point (docs/UI-AND-MODULES.md §3.12): elements on the stage. A new one is one
 * component file plus one line here. (The admin screen's pages are in `adminRegistry.ts`.)
 */
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
