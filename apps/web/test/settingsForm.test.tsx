import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { SettingsForm as Form, SettingsPatch } from "@pva/protocol"
import { exampleWeatherModule } from "@pva/protocol/examples"
import { type PageFormDef, usePageForms } from "@/components/settings/usePageForms.ts"
import { setDraftValue } from "@/lib/forms.ts"

const weather = exampleWeatherModule.settings

// The settings screen's forms (`usePageForms`, which replaced `SettingsForm`).
describe("settings page forms (review finding 7)", () => {
  it("a change from another tab to a field the user did not edit is not reset by Save", async () => {
    const ok = { type: "result" as const, requestId: "r", ok: true }
    const fns = {
      section: vi.fn(async (_id: string, _patch: SettingsPatch, _confirm: boolean) => ok),
      module: vi.fn(async (_id: string, _patch: SettingsPatch) => ok),
      reload: vi.fn(async () => ok)
    }
    const def = (form: Form, revision: number): ReadonlyArray<PageFormDef> => [{ key: "m:weather", kind: "module", id: "weather", form, revision, readOnly: false }]
    const view = renderHook(({ defs }) => usePageForms(defs, () => undefined, fns), { initialProps: { defs: def(weather, 3) } })
    act(() => view.result.current.setDraft("m:weather", (d) => setDraftValue(d, "defaultPlace", "Rotterdam")))
    // Another tab changes the units.
    const remote: Form = { ...weather, values: { ...weather.values, units: "fahrenheit" } }
    view.rerender({ defs: def(remote, 4) })
    expect(view.result.current.views[0]!.state.sync.stale).toBe(true) // "Changed in another tab"
    await act(async () => {
      await view.result.current.save()
    })
    expect(fns.module).toHaveBeenCalledTimes(1)
    expect(fns.module.mock.calls[0]![1]).toEqual({ values: { defaultPlace: "Rotterdam" }, secrets: {} })
  })
})
