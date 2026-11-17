import type { ModuleDefinition, SettingsSpec } from "@pva/core"
import type { ModuleInfo, SettingsForm, SettingsSection, VaultState } from "@pva/protocol"
import { KEYS_LOCKED_MESSAGE } from "./SettingsStore.ts"

/**
 * Which settings are protected (docs/UI-AND-MODULES.md §1.6, "Keys & access").
 * Only a page with admin access may change a protected settings section, or
 * switch a protected module on or off or change its settings. The rule is
 * data-driven, so it holds for any module or section, wherever a UI shows it:
 *
 * - any form with a secret field (an API key, a token);
 * - the sections that choose providers (`language-model`, `stt-engine`, `voice-providers`: marked `protected` in
 *   `sectionDefinitions.ts`);
 * - every agent module (it decides who answers, and may use a subscription).
 *
 * Everything else (voices, listening, conversation, ordinary modules) stays
 * open to every page.
 */

export const PROTECTED_SECTION_IDS: ReadonlySet<string> = new Set(["language-model", "stt-engine", "voice-providers"])

const hasSecret = (form: SettingsForm) => form.fields.some((f) => f.type === "secret")
const specHasSecret = (spec: SettingsSpec) => Object.entries(spec).some(([key, setting]) => setting.describe(key).type === "secret")

export const isSectionProtected = (section: Pick<SettingsSection, "id" | "form" | "protected">): boolean =>
  section.protected === true || PROTECTED_SECTION_IDS.has(section.id) || hasSecret(section.form)

export const isModuleProtected = (def: Pick<ModuleDefinition<any>, "kind" | "settings">): boolean =>
  def.kind === "agent" || specHasSecret(def.settings as SettingsSpec)

export interface AccessPolicy {
  readonly moduleProtected: (id: string) => boolean
  readonly sectionProtected: (id: string) => boolean
  /** The info as sent to pages: placement (`group`), `protected`, and a clearer error while the keys are locked. */
  readonly module: (info: ModuleInfo) => ModuleInfo
  readonly section: (section: SettingsSection) => SettingsSection
}

export const makeAccessPolicy = (options: {
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  readonly sections: () => ReadonlyArray<SettingsSection>
  readonly vaultState: () => VaultState
}): AccessPolicy => {
  const modules = new Map(options.catalog.map((def) => [def.id, def]))
  const moduleProtected = (id: string) => {
    const def = modules.get(id)
    return def !== undefined && isModuleProtected(def)
  }
  const needsKey = (id: string) => {
    const def = modules.get(id)
    return def !== undefined && specHasSecret(def.settings as SettingsSpec)
  }
  return {
    moduleProtected,
    sectionProtected: (id) => {
      const section = options.sections().find((s) => s.id === id)
      return PROTECTED_SECTION_IDS.has(id) || (section !== undefined && isSectionProtected(section))
    },
    module: (info) => {
      // Placement on the settings screen: agents and decision providers under Language model, the rest under Modules.
      const placed: ModuleInfo = { ...info, group: info.kind === "agent" || info.kind === "decider" ? "agents" : "modules" }
      if (!moduleProtected(info.id)) return placed
      // A module that needs a key fails to start while the vault is locked: say so instead of "X is not set".
      const locked = options.vaultState() === "locked" && info.state === "error" && needsKey(info.id)
      return { ...placed, protected: true, ...(locked ? { error: KEYS_LOCKED_MESSAGE } : {}) }
    },
    section: (section) => (isSectionProtected(section) ? { ...section, protected: true } : section)
  }
}
