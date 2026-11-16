import type { ComponentType } from "react"
import { AboutPage } from "@/components/settings/pages/AboutPage.tsx"
import { KeysListPage, VaultPage } from "@/components/settings/pages/AccessPages.tsx"
import { AssistantPage } from "@/components/settings/pages/AssistantPage.tsx"
import { AssistantsPage } from "@/components/settings/pages/AssistantsPage.tsx"
import { NewAssistantWizard } from "@/components/settings/pages/NewAssistantWizard.tsx"
import { DevicePage, DevicesPage } from "@/components/settings/pages/DevicesPages.tsx"
import { LatencyPage, ProblemsPage } from "@/components/settings/pages/DiagnosticsPages.tsx"
import { SpeechModelsPage, VoiceModelsPage } from "@/components/settings/pages/ModelsPages.tsx"
import { OverridesPage } from "@/components/settings/pages/OverridesPage.tsx"
import { OverviewPage } from "@/components/settings/pages/OverviewPage.tsx"
import type { ClientPageRef } from "@/lib/settingsTree.ts"

/**
 * The admin front end's extension point (docs/UI-AND-MODULES.md §3.12, docs/SETTINGS-UI.md §2.2): the settings
 * pages the client itself provides. `group` is a category slug of `settingsGroups` (`lib/settingsTree.ts`); pages
 * sort by `order` with the server's pages of that category (sections 10–100, modules from 500). Everything else on
 * the screen comes from the server's data. A `perItem` page is shown once per front-end kind or device and reads
 * its item from the path. (The voice front end's stage elements are in `voiceRegistry.ts`.)
 */
export interface SettingsPageEntry extends ClientPageRef {
  readonly component: ComponentType
}

export const settingsPages: ReadonlyArray<SettingsPageEntry> = [
  { group: "overview", id: "overview", title: "Overview", description: "What is set up, and what still needs doing.", order: 0, wide: true, component: OverviewPage },
  { group: "assistants", id: "all", title: "All assistants", description: "Each assistant is who answers, and how: its prompt, language model, hearing, voice and modules.", order: 0, component: AssistantsPage },
  { group: "assistants", id: "new", title: "New assistant", order: 50, listed: false, backLabel: "Assistants", under: "all", component: NewAssistantWizard },
  { group: "assistants", id: "assistant", title: "Assistant", order: 100, perItem: true, component: AssistantPage },
  { group: "devices", id: "all", title: "All devices", description: "Where people talk. Open one to choose which assistants answer there and which phrases wake them.", order: 0, component: DevicesPage },
  { group: "devices", id: "device-type", title: "Device type", order: 10, perItem: true, component: DevicePage },
  { group: "devices", id: "device", title: "Device", order: 100, perItem: true, component: DevicePage },
  { group: "keys", id: "access", title: "Vault", description: "The encrypted file that keeps the keys, and its password.", order: 10, component: VaultPage },
  { group: "keys", id: "keys", title: "Keys", description: "Every key, whether it is set, and what uses it.", order: 20, component: KeysListPage },
  { group: "diagnostics", id: "latency", title: "Latency", description: "How fast the last replies started.", order: 20, component: LatencyPage },
  { group: "diagnostics", id: "problems", title: "Problems", description: "Engines and modules that could not start.", order: 30, component: ProblemsPage },
  { group: "diagnostics", id: "overrides", title: "Settings from outside", description: "What .env and the environment set, and moving it into the settings.", order: 40, component: OverridesPage },
  // The model lists complete the shared pages they are named after (`<page>-extra`): not pages of their own.
  { group: "shared", id: "speech-extra", title: "Models", order: 0, component: SpeechModelsPage },
  { group: "shared", id: "providers-extra", title: "Voice models", order: 0, component: VoiceModelsPage },
  { group: "about", id: "about", title: "About", description: "Version and connection.", order: 0, component: AboutPage }
]

/** The component of a page by category and its source id (ids are unique within a category only). */
export const clientPage = (group: string, id: string): ComponentType | undefined =>
  settingsPages.find((p) => p.group === group && p.id === id)?.component

export { fieldRenderers, fieldRenderersByKey } from "./fieldRenderers.ts"
