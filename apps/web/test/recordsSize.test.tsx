import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MAX_LIST_JSON, type SettingField, type SettingsSection, type SettingValue } from "@pva/protocol"
import { exampleVoiceSection } from "@pva/protocol/examples"
import type { AssistantClient } from "@/lib/client.ts"
import type { ResultMessage } from "@/lib/connection.ts"
import type { NavPage } from "@/lib/settingsTree.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { ServerPage } from "@/components/settings/ServerPage.tsx"

// P5 review round 4 (p5-r4b finding 2): a records value (Members included) is checked as a whole against the wire's
// bound before it is sent: past it, the field says so and Save waits, with the data kept. And a save whose request is
// rejected (refused before it is sent, or failed after) ends: the error is shown, Save and Cancel work again.

afterEach(cleanup)

const diet = (label: string, key: string): SettingField =>
  ({ type: "textList", key, label, default: [], maxItems: 30, itemMaxLength: 60 }) as unknown as SettingField

/** The Members field as the server describes it (a hidden id, a name, a pronunciation, three diet lists). */
const membersField = {
  type: "records",
  key: "HOUSEHOLD_MEMBERS",
  label: "People",
  apply: "live",
  default: [],
  itemFields: [
    { type: "text", key: "id", label: "Id", default: "", hidden: true, maxLength: 40 },
    { type: "text", key: "name", label: "Name", default: "", maxLength: 60 },
    { type: "text", key: "pronunciation", label: "Pronunciation", default: "", maxLength: 60 },
    diet("Allergies", "allergies"),
    diet("Diets", "diets"),
    diet("Dislikes", "dislikes")
  ],
  itemLabel: "person",
  titleKey: "name",
  maxItems: 24,
  orderable: false,
  source: "saved"
} as unknown as SettingField

type Person = { id: string; name: string; pronunciation: string; allergies: Array<string>; diets: Array<string>; dislikes: Array<string> }

/**
 * Six people with full diet lists (every item one the chip field accepts: 58 characters, distinct), cut so that the
 * whole value is exactly `size` characters as JSON.
 */
const peopleOfSize = (size: number): Array<Person> => {
  const people: Array<Person> = Array.from({ length: 6 }, (_, p) => ({ id: `p-person0${p}`, name: `Person ${p}`, pronunciation: "", allergies: [], diets: [], dislikes: [] }))
  const len = () => JSON.stringify(people).length
  outer: for (const person of people) {
    for (const list of ["allergies", "diets", "dislikes"] as const) {
      for (let i = 0; i < 30; i++) {
        const item = `${String(i).padStart(2, "0")}${"x".repeat(56)}`
        if (len() + item.length + 3 > size) break outer
        person[list].push(item)
      }
    }
  }
  // The rest in the first person's pronunciation (at most 60 characters).
  people[0]!.pronunciation = "y".repeat(size - len())
  expect(people[0]!.pronunciation.length).toBeLessThanOrEqual(60)
  expect(len()).toBe(size)
  return people
}

const setup = (people: Array<Person>, updateSection: (...args: ReadonlyArray<unknown>) => Promise<ResultMessage>) => {
  const section: SettingsSection = {
    ...exampleVoiceSection,
    id: "members",
    title: "Members",
    group: "modules",
    page: { id: "members", title: "Members" },
    form: { fields: [membersField], values: { HOUSEHOLD_MEMBERS: people as unknown as SettingValue }, secrets: {}, errors: [] }
  }
  const store = createStore({ ...initialState, vault: { state: "none", admin: true }, sections: [section] }, reducer)
  const page: NavPage = {
    group: "shared",
    id: "members",
    title: "Members",
    order: 0,
    source: { kind: "server", sections: [section], moduleIds: [] },
    inUse: true,
    listed: true,
    protected: false,
    hasSecrets: false,
    hasErrors: false,
    origins: []
  }
  const ok: ResultMessage = { type: "result", requestId: "r", ok: true }
  const update = vi.fn(updateSection)
  const client = { store, updateSection: update, configureModule: vi.fn(async () => ok), reloadEngines: vi.fn(async () => ok), settings: vi.fn() } as unknown as AssistantClient
  render(<ClientContext.Provider value={client}><ServerPage page={page} /></ClientContext.Provider>)
  const footer = () => screen.getByTestId("page-footer")
  const save = () => within(footer()).getByRole("button", { name: "Save" }) as HTMLButtonElement
  const cancel = () => within(footer()).getByRole("button", { name: "Cancel" }) as HTMLButtonElement
  const nameInput = () => {
    const row = screen.getAllByTestId("record")[0]!
    const toggle = row.querySelector<HTMLElement>("[aria-expanded]")!
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle)
    return within(row).getByLabelText("Name") as HTMLInputElement
  }
  return { update, save, cancel, nameInput }
}

const TOO_LONG = /too long all together/

describe("a records value is checked as a whole against the wire's bound", () => {
  it("Members just below the bound saves; one character over blocks Save with the error at the field, and the data stays", async () => {
    // Two characters below: "Person 0" → "Person 0a" is one below, "Person 0ab" exactly at the bound, one more over it.
    const people = peopleOfSize(MAX_LIST_JSON - 2)
    const { update, save, nameInput } = setup(people, async () => ({ type: "result", requestId: "r", ok: true }))
    fireEvent.change(nameInput(), { target: { value: "Person 0ab" } })
    expect(screen.queryByText(TOO_LONG)).toBeNull()
    expect(save().disabled).toBe(false)
    fireEvent.change(nameInput(), { target: { value: "Person 0abc" } })
    expect(screen.getByText(TOO_LONG)).toHaveTextContent(`${(MAX_LIST_JSON + 1).toLocaleString("en-GB")} characters`)
    expect(save().disabled).toBe(true)
    await act(async () => fireEvent.click(save()))
    expect(update).not.toHaveBeenCalled()
    // Nothing is lost: the edit is still there, and taking one character off lets it save.
    expect(nameInput().value).toBe("Person 0abc")
    fireEvent.change(nameInput(), { target: { value: "Person 0ab" } })
    expect(screen.queryByText(TOO_LONG)).toBeNull()
    expect(save().disabled).toBe(false)
    await act(async () => fireEvent.click(save()))
    expect(update).toHaveBeenCalledTimes(1)
    const sent = update.mock.calls[0]![1] as { values: Record<string, unknown> }
    expect(JSON.stringify(sent.values.HOUSEHOLD_MEMBERS).length).toBe(MAX_LIST_JSON)
  })
})

describe("a save whose request is rejected ends", () => {
  it("refused before it is sent: the error is shown, Save and Cancel are usable again, and a later save goes", async () => {
    let refuse = true
    const { update, save, cancel, nameInput } = setup(peopleOfSize(2000), async () => {
      if (refuse) throw new Error("The message could not be encoded")
      return { type: "result", requestId: "r", ok: true }
    })
    fireEvent.change(nameInput(), { target: { value: "Sam" } })
    await act(async () => fireEvent.click(save()))
    expect(update).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/The settings were not saved: The message could not be encoded/)).toBeTruthy()
    expect(save().disabled).toBe(false)
    expect(cancel().disabled).toBe(false)
    expect(nameInput().value).toBe("Sam")
    refuse = false
    await act(async () => fireEvent.click(save()))
    expect(update).toHaveBeenCalledTimes(2)
  })
})
