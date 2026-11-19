// P8: Shared settings › Risk policy. The server's `risk` section lands on its own shared page (admin only), money and
// security are drawn fixed (locked, with the reason, never in a save), and under the form the page says what the
// assistant says for each refusal, in the household's language (English and Dutch), with the server's own functions.
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FIXED_REASON, type SettingsPatch, type SettingsSection } from "@pva/protocol"
import type { AssistantClient } from "@/lib/client.ts"
import type { ResultMessage } from "@/lib/connection.ts"
import { buildSettingsTree, type NavPage } from "@/lib/settingsTree.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { ServerPage } from "@/components/settings/ServerPage.tsx"
import { RiskPolicyPage } from "@/components/settings/pages/RiskPolicyPage.tsx"

const outcomes = [
  { value: "allow", label: "Run it" },
  { value: "confirm", label: "Refuse: needs confirmation" },
  { value: "deny", label: "Refuse" }
]
/** The section as the server sends it (sectionDefinitions.ts `riskSection` through sections.ts). */
const riskSection = (values: Readonly<Record<string, string>> = {}): SettingsSection => ({
  id: "risk",
  title: "Risk policy",
  group: "modules",
  page: { id: "risk", title: "Risk policy", description: "What the assistant may do on its own." },
  order: 7,
  protected: true,
  form: {
    fields: [
      { type: "choice", key: "RISK_READ", label: "Look things up", apply: "live", default: "allow", options: outcomes, source: "default" },
      { type: "choice", key: "RISK_CHANGE", label: "Change things in the house", apply: "live", default: "allow", options: outcomes, source: "default" },
      { type: "choice", key: "RISK_MESSAGE", label: "Send messages", apply: "live", default: "confirm", options: outcomes, source: "default" },
      { type: "choice", key: "RISK_MONEY", label: "Spend money", apply: "live", default: "deny", options: [{ value: "deny", label: "Refuse" }], locked: { reason: FIXED_REASON }, source: "default" },
      { type: "choice", key: "RISK_SECURITY", label: "Locks, alarms, doors and gates", apply: "live", default: "deny", options: [{ value: "deny", label: "Refuse" }], locked: { reason: FIXED_REASON }, source: "default" }
    ],
    values: { RISK_READ: "allow", RISK_CHANGE: "allow", RISK_MESSAGE: "confirm", RISK_MONEY: "deny", RISK_SECURITY: "deny", ...values },
    secrets: {},
    errors: []
  },
  revision: 1
})
const homeSection = (language: string): SettingsSection => ({
  id: "home",
  title: "Home",
  group: "modules",
  page: { id: "home", title: "Home" },
  order: 5,
  form: { fields: [{ type: "choice", key: "HOME_LANGUAGE", label: "Language", apply: "live", default: "en-GB", options: [{ value: "en-GB", label: "English" }, { value: "nl-NL", label: "Dutch" }] }], values: { HOME_LANGUAGE: language }, secrets: {}, errors: [] },
  revision: 1
})

const storeWith = (sections: ReadonlyArray<SettingsSection>) => createStore({ ...initialState, vault: { state: "unlocked", admin: true }, sections }, reducer)

describe("the risk policy's page", () => {
  it("is its own page under Shared settings, admin only, with the sentences panel under the form", () => {
    const shared = buildSettingsTree({ sections: [homeSection("en-GB"), riskSection()], modules: [], clientPages: [{ group: "shared", id: "risk-extra", title: "What the assistant says", order: 0 }] })
      .find((g) => g.slug === "shared")!
    const page = shared.pages.find((p) => p.id === "risk")!
    expect(page).toMatchObject({ title: "Risk policy", protected: true, extra: "risk-extra" })
    expect((page.source as { sections: ReadonlyArray<SettingsSection> }).sections.flatMap((s) => s.form.fields.map((f) => f.key))).toEqual([
      "RISK_READ",
      "RISK_CHANGE",
      "RISK_MESSAGE",
      "RISK_MONEY",
      "RISK_SECURITY"
    ])
  })

  it("money and security are shown fixed (Refuse, with the reason) and never sent; a settable class is saved", async () => {
    const sections = [homeSection("en-GB"), riskSection()]
    const store = storeWith(sections)
    const ok: ResultMessage = { type: "result", requestId: "r", ok: true }
    const updateSection = vi.fn(async (_id: string, _patch: SettingsPatch) => ok)
    const client = { store, updateSection, configureModule: vi.fn(async () => ok), reloadEngines: vi.fn(async () => ok), settings: vi.fn() } as unknown as AssistantClient
    const page = buildSettingsTree({ sections, modules: [], clientPages: [] }).find((g) => g.slug === "shared")!.pages.find((p) => p.id === "risk") as NavPage
    render(<ClientContext.Provider value={client}><ServerPage page={page} extra={<RiskPolicyPage />} /></ClientContext.Provider>)
    const locked = screen.getAllByTestId("locked-value")
    expect(locked).toHaveLength(2)
    for (const row of locked) {
      expect(row.textContent).toContain("Refuse")
      expect(row.textContent).toContain(FIXED_REASON)
    }
    // The fixed rows have no control; the settable ones do.
    expect(screen.queryByRole("radiogroup", { name: "Spend money" })).toBeNull()
    expect(screen.queryByRole("radiogroup", { name: "Locks, alarms, doors and gates" })).toBeNull()
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Change things in the house" })).getByRole("radio", { name: "Refuse" }))
    const save = within(screen.getByTestId("page-footer")).getByRole("button", { name: "Save" }) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(save)
    })
    expect(updateSection).toHaveBeenCalledTimes(1)
    expect(updateSection.mock.calls[0]![0]).toBe("risk")
    expect(updateSection.mock.calls[0]![1].values).toEqual({ RISK_CHANGE: "deny" })
  })

  it("in English: what the assistant says for each refusal of the saved policy; nothing for what runs", () => {
    const store = storeWith([homeSection("en-GB"), riskSection({ RISK_CHANGE: "deny" })])
    render(<ClientContext.Provider value={{ store } as unknown as AssistantClient}><RiskPolicyPage /></ClientContext.Provider>)
    const panel = screen.getByTestId("risk-sentences")
    expect(within(panel).getByRole("heading").textContent).toBe("What the assistant says when it refuses")
    expect(screen.getByTestId("risk-row-read").getAttribute("data-outcome")).toBe("allow")
    expect(screen.queryByTestId("risk-spoken-read")).toBeNull()
    expect(screen.getByTestId("risk-outcome-change").textContent).toBe("Refuse")
    expect(screen.getByTestId("risk-spoken-change").textContent).toBe("“I can't do that: this household doesn't allow me to change things in the house.”")
    expect(screen.getByTestId("risk-outcome-message").textContent).toBe("Refuse: needs confirmation")
    expect(screen.getByTestId("risk-spoken-message").textContent).toBe("“I can't send that: messages need the owner's confirmation, and I can't ask for that yet.”")
    // The fixed rows: always refused.
    expect(screen.getByTestId("risk-spoken-money").textContent).toBe("“I can't do that: I never spend money.”")
    expect(screen.getByTestId("risk-spoken-security").textContent).toBe("“I can't do that: I never work locks, alarms, doors or gates.”")
  })

  it("in Dutch: the panel and the sentences are Dutch; a hand-edited money value in the section's values is still Refuse", () => {
    const store = storeWith([homeSection("nl-NL"), riskSection({ RISK_READ: "confirm", RISK_MONEY: "allow" })])
    render(<ClientContext.Provider value={{ store } as unknown as AssistantClient}><RiskPolicyPage /></ClientContext.Provider>)
    const panel = screen.getByTestId("risk-sentences")
    expect(panel.getAttribute("lang")).toBe("nl")
    expect(within(panel).getByRole("heading").textContent).toBe("Wat de assistent zegt als hij weigert")
    expect(screen.getByTestId("risk-outcome-read").textContent).toBe("Weigeren: bevestiging nodig")
    expect(screen.getByTestId("risk-spoken-read").textContent).toBe("“Dat kan ik niet opzoeken: dit huishouden wil dat de eigenaar het eerst bevestigt, en daar kan ik nog niet om vragen.”")
    expect(screen.getByTestId("risk-outcome-money").textContent).toBe("Weigeren")
    expect(screen.getByTestId("risk-spoken-money").textContent).toBe("“Dat kan ik niet doen: ik geef nooit geld uit.”")
  })
})
