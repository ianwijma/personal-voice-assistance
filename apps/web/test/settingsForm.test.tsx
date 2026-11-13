import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { SettingsForm as Form, SettingsPatch } from "@pva/protocol"
import { exampleWeatherModule } from "@pva/protocol/examples"
import { SettingsForm } from "@/components/SettingsForm.tsx"

const weather = exampleWeatherModule.settings

describe("SettingsForm (review finding 7)", () => {
  it("a change from another tab to a field the user did not edit is not reset by Save", async () => {
    const onSave = vi.fn(async (_patch: SettingsPatch) => ({ type: "result" as const, requestId: "r", ok: true }))
    const view = render(<SettingsForm form={weather} revision={3} idPrefix="w" onSave={onSave} />)
    fireEvent.change(screen.getByLabelText("Home location"), { target: { value: "Rotterdam" } })
    // Another tab changes the units.
    const remote: Form = { ...weather, values: { ...weather.values, units: "fahrenheit" } }
    view.rerender(<SettingsForm form={remote} revision={4} idPrefix="w" onSave={onSave} />)
    expect(screen.getByText("Changed in another tab")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toEqual({ values: { defaultPlace: "Rotterdam" }, secrets: {} })
  })
})
