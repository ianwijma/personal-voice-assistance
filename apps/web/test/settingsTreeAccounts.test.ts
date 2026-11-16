import { describe, expect, it } from "vitest"
import type { SettingsSection } from "@pva/protocol"
import { exampleVoiceSection } from "@pva/protocol/examples"
import { buildSettingsTree } from "@/lib/settingsTree.ts"

// A server section of the OpenRouter / home-model account keys (`llm-openai-accounts`) and one with the `HOME_*` keys
// of the Home module: `HOME_MODEL_*` must land on Language model accounts, not on Home.
const accountsSection: SettingsSection = {
  ...exampleVoiceSection,
  id: "llm-openai-accounts",
  title: "OpenRouter and home model",
  group: "agents",
  page: { id: "openai-accounts", title: "OpenRouter and home model" },
  order: 15,
  protected: true,
  form: {
    fields: [
      { type: "secret", key: "OPENROUTER_API_KEY", label: "OpenRouter API key", apply: "live" },
      { type: "text", key: "OPENROUTER_BASE_URL", label: "OpenRouter address", apply: "live", default: "", advanced: true },
      { type: "text", key: "HOME_MODEL_BASE_URL", label: "Home model server address", apply: "live", default: "" },
      { type: "secret", key: "HOME_MODEL_API_KEY", label: "Home model API key", apply: "live" }
    ],
    values: { HOME_MODEL_BASE_URL: "http://192.168.1.20:11434" },
    secrets: { OPENROUTER_API_KEY: { set: true, source: "store" }, HOME_MODEL_API_KEY: { set: false, source: "none" } },
    errors: []
  }
}
const homeSection: SettingsSection = {
  ...exampleVoiceSection,
  id: "home",
  title: "Home",
  group: "modules",
  page: { id: "home", title: "Home" },
  form: { fields: [{ type: "text", key: "HOME_CITY", label: "City", apply: "live", default: "" }], values: {}, secrets: {}, errors: [] }
}

describe("settings tree: the OpenRouter and home-model keys", () => {
  const shared = buildSettingsTree({ sections: [homeSection, accountsSection], modules: [], clientPages: [] }).find((g) => g.slug === "shared")!
  const keysOf = (id: string) =>
    (shared.pages.find((p) => p.id === id)!.source as { sections: ReadonlyArray<SettingsSection> }).sections.flatMap((s) => s.form.fields.map((f) => f.key))

  it("puts every OPENROUTER_* and HOME_MODEL_* key on the Language model accounts page", () => {
    expect(keysOf("accounts")).toEqual(["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "HOME_MODEL_BASE_URL", "HOME_MODEL_API_KEY"])
  })

  it("keeps HOME_MODEL_* off the Home page (its HOME_ prefix must not win)", () => {
    expect(keysOf("home")).toEqual(["HOME_CITY"])
  })

  it("shows the account fields plainly, marks the page protected and as holding keys", () => {
    const page = shared.pages.find((p) => p.id === "accounts")!
    const fields = (page.source as { sections: ReadonlyArray<SettingsSection> }).sections.flatMap((s) => s.form.fields)
    expect(fields.every((f) => f.advanced === undefined)).toBe(true)
    expect(page).toMatchObject({ protected: true, hasSecrets: true, inUse: true })
  })
})
