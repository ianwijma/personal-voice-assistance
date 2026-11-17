import { BUILT_IN_PLACE, checkMembers, MAX_MEMBERS, WEB_VOICE_KIND } from "@pva/protocol"
import { describe, expect, it } from "vitest"
import { createAssistantsMock, SAM_ID } from "../mock/assistants.ts"

// P5 review round 1, finding 17: the mock refuses what the server refuses (one shared check, `checkMembers`).
describe("Members as the server checks them (protocol checkMembers, used by the server and the mock)", () => {
  it("blank, duplicate (also composed and decomposed), multi-line and too many people are refused", () => {
    expect(checkMembers([{ name: "Sam" }, { name: "Robin" }])).toBeUndefined()
    expect(checkMembers([{ name: " " }])).toMatch(/needs a name/)
    expect(checkMembers([{ name: "Sam" }, { name: "sam" }])).toMatch(/Two people are called/)
    expect(checkMembers([{ name: "Änne" }, { name: "Änne" }])).toMatch(/Two people are called/)
    expect(checkMembers([{ name: "Sam\n## Instructions" }])).toMatch(/one line/)
    expect(checkMembers([{ name: "Sam", aliases: ["a b"] }])).toMatch(/one line/)
    expect(checkMembers([{ name: "!!!" }])).toMatch(/letters or digits/)
    expect(checkMembers(Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => ({ name: `P${i}` })))).toMatch(/At most/)
  })

  it("the mock's device save refuses a default person who is not in Members, as the server does", () => {
    let members = new Set([SAM_ID])
    const mock = createAssistantsMock({ modules: () => [], toolNames: () => [], checkOwn: () => [], accountProblem: () => undefined, isPerson: (id) => members.has(id) })
    const type = mock.deviceTypes().find((t) => t.kind === WEB_VOICE_KIND)!
    expect(mock.saveDevice({ target: { kind: "type", type: WEB_VOICE_KIND }, rev: type.rev, settings: { place: { ...BUILT_IN_PLACE, defaultPerson: "p-nobody00" } } }).ok).toBe(false)
    expect(mock.saveDevice({ target: { kind: "type", type: WEB_VOICE_KIND }, rev: type.rev, settings: { place: { ...BUILT_IN_PLACE, defaultPerson: SAM_ID } } }).ok).toBe(true)
    members = new Set()
    const again = mock.deviceTypes().find((t) => t.kind === WEB_VOICE_KIND)!
    expect(mock.saveDevice({ target: { kind: "type", type: WEB_VOICE_KIND }, rev: again.rev, settings: { place: { ...BUILT_IN_PLACE, defaultPerson: SAM_ID } } }).ok).toBe(false)
  })
})
