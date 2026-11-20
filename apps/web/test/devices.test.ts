import { describe, expect, it } from "vitest"
import type { Assignment, DeviceSettings } from "@pva/protocol"
import { exampleAssistantInfo, exampleDevice, exampleDeviceType } from "@pva/protocol/examples"
import {
  answersWithoutPhrase,
  baseOfDevice,
  baseOfType,
  draftOnRevision,
  editDraft,
  followUpLabel,
  hearerId,
  isDirty,
  isOwn,
  noEdit,
  patchOf,
  phraseChip,
  phraseConflict,
  quietLabel,
  reachWords,
  recogniserWords,
  resetSection,
  sameRecogniser,
  sectionChanged,
  sectionsOf,
  setKeys,
  settingsOf,
  valueOf,
  wakesAssistant
} from "@/lib/devices.ts"

// The device and defaults pages' pure core (docs/ASSISTANTS.md §2.3, §7.1): sections, edits over what is saved, the patch.
type Language = typeof exampleAssistantInfo.hearing.language
const type = exampleDeviceType
// `exampleDevice` has its own `interruptMode` and `withoutPhrase`; everything else follows the type.
const device = baseOfDevice(exampleDevice, type)
const typeBase = baseOfType(type)

describe("sections of a device type", () => {
  it("a type with every key has every section; a section needs all of its keys", () => {
    expect(sectionsOf(type)).toEqual(["assign", "phrases", "voicePage", "look", "voice", "place", "capabilities", "interrupting", "audio", "captions"])
    expect(sectionsOf({ keys: ["assistants", "withoutPhrase", "interruptMode"] })).toEqual(["assign", "interrupting"])
    // `assign` is two keys: one of them alone is not the section.
    expect(sectionsOf({ keys: ["assistants"] })).toEqual([])
    expect(sectionsOf({ keys: [] })).toEqual([])
  })

  it("an unknown type shows every section", () => {
    // Protocol 11 added Place and Capabilities, protocol 12 Sound and Sound devices (voice nodes).
    expect(sectionsOf(undefined)).toHaveLength(12)
  })
})

describe("what a section shows and whether it is own", () => {
  it("a device shows its own value, else the type's; a section is own when any of its keys is", () => {
    expect(valueOf(device, noEdit, "interruptMode")).toBe("instant")
    expect(valueOf(device, noEdit, "audio")).toEqual(type.settings.audio)
    expect(isOwn(device, noEdit, "interrupting")).toBe(true)
    expect(isOwn(device, noEdit, "assign")).toBe(true) // `withoutPhrase` is own, `assistants` is not
    expect(isOwn(device, noEdit, "audio")).toBe(false)
  })

  it("a type has no own sections, whatever is edited", () => {
    const edit = setKeys(typeBase, noEdit, { interruptMode: "instant" })
    expect(isOwn(typeBase, edit, "interrupting")).toBe(false)
    expect(isOwn(typeBase, noEdit, "assign")).toBe(false)
  })

  it("an edit makes a section own on a device, and a reset makes it follow the defaults again", () => {
    const edited = setKeys(device, noEdit, { audio: { ...type.settings.audio, speakAloud: false } })
    expect(isOwn(device, edited, "audio")).toBe(true)
    const reset = resetSection(device, noEdit, "interrupting")
    expect(isOwn(device, reset, "interrupting")).toBe(false)
    expect(valueOf(device, reset, "interruptMode")).toBe(type.settings.interruptMode)
  })

  it("settingsOf is the settings in force with the edits laid over them", () => {
    expect(settingsOf(device, noEdit)).toEqual(exampleDevice.settings)
    const s = settingsOf(device, setKeys(device, noEdit, { captions: { captions: false, speakTyped: true } }))
    expect(s.captions).toEqual({ captions: false, speakTyped: true })
    expect(s.interruptMode).toBe("instant")
  })
})

describe("setKeys", () => {
  it("setting a section back to what it already is leaves no edit", () => {
    // Own and saved: the same own value is no edit.
    expect(setKeys(device, noEdit, { interruptMode: "instant" }).values).toEqual({})
    // Following the defaults: the value it follows is no edit either.
    expect(setKeys(device, noEdit, { audio: type.settings.audio }).values).toEqual({})
  })

  it("changing it back to the saved value drops an earlier edit of the key", () => {
    const edited = setKeys(device, noEdit, { interruptMode: "manual" })
    expect(edited.values).toEqual({ interruptMode: "manual" })
    expect(setKeys(device, edited, { interruptMode: "instant" }).values).toEqual({})
  })

  it("setting a key cancels its pending reset", () => {
    const reset = resetSection(device, noEdit, "interrupting")
    expect(reset.reset).toEqual(["interruptMode"])
    const again = setKeys(device, reset, { interruptMode: "manual" })
    expect(again.reset).toEqual([])
    expect(again.values).toEqual({ interruptMode: "manual" })
  })
})

describe("resetSection", () => {
  it("drops the edits of the section and resets only keys that have a saved own value", () => {
    const edited = setKeys(device, noEdit, { assistants: [{ assistant: "t3", phrases: [] }] })
    const reset = resetSection(device, edited, "assign")
    expect(reset.values).toEqual({})
    // `withoutPhrase` is own and saved; `assistants` follows the type: nothing to reset there.
    expect(reset.reset).toEqual(["withoutPhrase"])
    expect(isOwn(device, reset, "assign")).toBe(false)
  })

  it("leaves the edits of other sections alone", () => {
    const edited = setKeys(device, noEdit, { audio: { ...type.settings.audio, speakAloud: false } })
    const reset = resetSection(device, edited, "interrupting")
    expect(reset.values).toEqual(edited.values)
  })

  it("a section that follows the defaults has nothing to reset", () => {
    expect(resetSection(device, noEdit, "audio")).toEqual({ values: {}, reset: [], name: undefined })
  })
})

describe("sectionChanged and the patch", () => {
  it("nothing is changed without edits", () => {
    for (const s of sectionsOf(type)) expect(sectionChanged(device, noEdit, s)).toBe(false)
    expect(patchOf(device, noEdit)).toEqual({})
    expect(isDirty(device, noEdit, exampleDevice.name)).toBe(false)
  })

  it("an edited section is changed, and its value is in the patch", () => {
    const audio = { ...type.settings.audio, speakAloud: false }
    const edit = setKeys(device, noEdit, { audio })
    expect(sectionChanged(device, edit, "audio")).toBe(true)
    expect(sectionChanged(device, edit, "captions")).toBe(false)
    expect(patchOf(device, edit)).toEqual({ audio })
    expect(isDirty(device, edit, exampleDevice.name)).toBe(true)
  })

  it("a reset of an own section is changed and saves as null", () => {
    const edit = resetSection(device, noEdit, "interrupting")
    expect(sectionChanged(device, edit, "interrupting")).toBe(true)
    expect(patchOf(device, edit)).toEqual({ interruptMode: null })
  })

  it("a type's patch never carries a null: a type has no own values to reset", () => {
    const edit = { values: {}, reset: ["interruptMode" as const], name: undefined }
    expect(patchOf(typeBase, edit)).toEqual({})
    expect(patchOf(typeBase, setKeys(typeBase, noEdit, { interruptMode: "manual" }))).toEqual({ interruptMode: "manual" })
  })

  it("a type's value goes back to what it was when a reset is pending and shows the defaults", () => {
    // For a type the defaults are itself, so a reset shows no change.
    expect(valueOf(typeBase, { values: {}, reset: ["audio"], name: undefined }, "audio")).toEqual(type.settings.audio)
  })

  it("a rename alone is dirty; the same name (trimmed) is not", () => {
    expect(isDirty(device, { ...noEdit, name: "Kitchen" }, exampleDevice.name)).toBe(true)
    expect(isDirty(device, { ...noEdit, name: `  ${exampleDevice.name}  ` }, exampleDevice.name)).toBe(false)
    expect(isDirty(device, { ...noEdit, name: "Kitchen" }, undefined)).toBe(true)
  })
})

describe("reading the list", () => {
  const asg = (assistant: string, ...phrases: string[]): Assignment => ({ assistant, phrases })
  const wp = (s: DeviceSettings["withoutPhrase"], ...assistants: Assignment[]) => ({ assistants, withoutPhrase: s })

  it("answersWithoutPhrase names only the assistant of `assistant` mode", () => {
    expect(answersWithoutPhrase({ mode: "assistant", assistant: "jeff" }, "jeff")).toBe(true)
    expect(answersWithoutPhrase({ mode: "assistant", assistant: "jeff" }, "t3")).toBe(false)
    expect(answersWithoutPhrase({ mode: "typesafe", fallback: "jeff", giveUpMs: 400 }, "jeff")).toBe(false)
    expect(answersWithoutPhrase({ mode: "nobody" }, "jeff")).toBe(false)
  })

  it("reachWords: without a phrase beats a phrase, a phrase beats typesafe, else unreachable", () => {
    const s = wp({ mode: "assistant", assistant: "jeff" }, asg("jeff", "hey jeff"), asg("t3", "hey t3"), asg("x"))
    expect(reachWords(s, asg("jeff", "hey jeff"))).toBe("without-phrase")
    expect(reachWords(s, asg("t3", "hey t3"))).toBe("phrase")
    expect(reachWords(s, asg("x"))).toBe("unreachable")
    const ts = wp({ mode: "typesafe", fallback: null, giveUpMs: 400 }, asg("x"))
    expect(reachWords(ts, asg("x"))).toBe("typesafe")
  })

  it("the hearer follows the protocol's rule: the without-phrase assistant, else the first, else none", () => {
    expect(hearerId(wp({ mode: "assistant", assistant: "t3" }, asg("jeff")))).toBe("t3")
    expect(hearerId(wp({ mode: "nobody" }, asg("jeff"), asg("t3")))).toBe("jeff")
    expect(hearerId(wp({ mode: "nobody" }))).toBeNull()
  })

  it("phraseChip shows the first phrase and a count of the rest", () => {
    expect(phraseChip(asg("jeff"))).toBeUndefined()
    expect(phraseChip(asg("jeff", "Hey Jeff"))).toBe("“Hey Jeff”")
    expect(phraseChip(asg("jeff", "Hey Jeff", "Hey Jev", "Hey Geoff"))).toBe("“Hey Jeff” +2")
  })

  it("recogniserWords names Deepgram, or the model with its language unless it is auto", () => {
    const label = (m: string) => `Model ${m}`
    const local = (model: string, language: Language) => ({ hearing: { ...exampleAssistantInfo.hearing, engine: "sherpa" as const, model, language } })
    expect(recogniserWords({ hearing: { ...exampleAssistantInfo.hearing, engine: "deepgram" } }, label)).toBe("Deepgram")
    expect(recogniserWords(local("small", "auto"), label)).toBe("Model small")
    expect(recogniserWords(local("small", "nl"), label)).toBe("Model small · nl")
  })

  it("sameRecogniser: the same model and language, or both Deepgram", () => {
    const h = exampleAssistantInfo.hearing
    const local = (model: string, language: Language) => ({ hearing: { ...h, engine: "sherpa" as const, model, language } })
    const dg = { hearing: { ...h, engine: "deepgram" as const } }
    expect(sameRecogniser(local("small", "nl"), local("small", "nl"))).toBe(true)
    expect(sameRecogniser(local("small", "nl"), local("small", "en"))).toBe(false)
    expect(sameRecogniser(local("small", "nl"), local("base", "nl"))).toBe(false)
    expect(sameRecogniser(dg, dg)).toBe(true)
    expect(sameRecogniser(dg, local("small", "nl"))).toBe(false)
  })
})

describe("phrases", () => {
  const names = (id: string) => (id === "jeff" ? "Jeff" : "T3")
  const list: Assignment[] = [
    { assistant: "jeff", phrases: ["Hey Jeff"] },
    { assistant: "t3", phrases: ["hey t3"] }
  ]

  it("a phrase of another assistant is refused, whatever the case and punctuation, and names who has it", () => {
    expect(phraseConflict("hey t3", list, names)).toBe("“hey t3” is already a phrase of T3 on this device. A phrase can wake one assistant only.")
    expect(phraseConflict("  HEY, Jeff! ", list, names)).toMatch(/is already a phrase of Jeff/)
  })

  it("a new phrase, and one with no words in it, are no conflict", () => {
    expect(phraseConflict("ok computer", list, names)).toBeUndefined()
    expect(phraseConflict("   ", list, names)).toBeUndefined()
    expect(phraseConflict("!!!", list, names)).toBeUndefined()
    expect(phraseConflict("hey jeff", [], names)).toBeUndefined()
  })
})

describe("labels", () => {
  it("quietLabel: minutes, whole hours, never", () => {
    expect(quietLabel("never")).toBe("never")
    expect(quietLabel(10)).toBe("after 10 min quiet")
    expect(quietLabel(60)).toBe("after 1 h quiet")
    expect(quietLabel(120)).toBe("after 2 h quiet")
    expect(quietLabel(90)).toBe("after 90 min quiet") // not a whole number of hours
    expect(quietLabel(59)).toBe("after 59 min quiet")
  })

  it("followUpLabel: 0 is Off", () => {
    expect(followUpLabel(0)).toBe("Off")
    expect(followUpLabel(8)).toBe("8 seconds")
  })
})

// Review of PR #35, finding 1: a save that went through takes only what it sent; edits made meanwhile stay.
describe("the draft when a new revision arrives", () => {
  const sent = setKeys(device, noEdit, { matching: "exact" })
  const renamed = { ...sent, name: "Kitchen" }

  it("the edits of this page's save that went through: a clean draft on the new revision", () => {
    expect(draftOnRevision({ edit: sent, rev: 1 }, 2, device, exampleDevice.name, sent)).toEqual({ edit: noEdit, rev: 2 })
  })

  it("a rename made while that save was on its way is kept, on the new revision (not dropped, not shown as behind)", () => {
    const next = draftOnRevision({ edit: renamed, rev: 1 }, 2, device, exampleDevice.name, sent)
    expect(next.rev).toBe(2)
    expect(next.edit).toBe(renamed)
    expect(isDirty(device, next.edit, exampleDevice.name)).toBe(true)
  })

  it("without a save of this page: a draft with nothing to save follows, one with edits stays where it was", () => {
    expect(draftOnRevision({ edit: noEdit, rev: 1 }, 2, device, exampleDevice.name, undefined)).toEqual({ edit: noEdit, rev: 2 })
    const draft = { edit: renamed, rev: 1 }
    expect(draftOnRevision(draft, 2, device, exampleDevice.name, undefined)).toBe(draft)
  })

  it("the same revision changes nothing", () => {
    const draft = { edit: renamed, rev: 2 }
    expect(draftOnRevision(draft, 2, device, exampleDevice.name, sent)).toBe(draft)
  })
})

// Review of PR #35, round 2, finding 1: a change made while a save is on its way (even one back to the saved value) is not lost.
describe("a change to the draft while a save is on its way", () => {
  const savedMatching = settingsOf(device, noEdit).matching
  const other = savedMatching === "close" ? "exact" : "close"
  const sent = setKeys(device, noEdit, { matching: other })
  const back = (e: typeof sent) => setKeys(device, e, { matching: savedMatching })

  it("is ignored: the draft stays exactly what was sent, and the save's revision leaves it clean and matching the server", () => {
    const during = editDraft({ edit: sent, rev: 1 }, back, 1, true)
    expect(during.edit).toBe(sent)
    expect(settingsOf(device, during.edit).matching).toBe(other)
    expect(draftOnRevision(during, 2, device, exampleDevice.name, sent)).toEqual({ edit: noEdit, rev: 2 })
  })

  it("is applied when no save is on its way; a first edit starts from the current revision", () => {
    const after = editDraft({ edit: sent, rev: 1 }, back, 3, false)
    expect(after.rev).toBe(1)
    expect(settingsOf(device, after.edit).matching).toBe(savedMatching)
    expect(editDraft({ edit: noEdit, rev: 1 }, (e) => setKeys(device, e, { matching: other }), 3, false)).toEqual({ edit: sent, rev: 3 })
  })
})

// Review of PR #35, finding 3: the phrase tester names the assistant from the tested device's saved assignments.
describe("wakesAssistant", () => {
  const saved: Assignment[] = [
    { assistant: "jeff", phrases: ["Hey Jeff"] },
    { assistant: "t3", phrases: ["hey t3"] }
  ]

  it("finds the assistant whose phrase matched, whatever the case and punctuation", () => {
    expect(wakesAssistant(saved, "hey jeff")).toBe("jeff")
    expect(wakesAssistant(saved, "Hey, Jeff!")).toBe("jeff")
    expect(wakesAssistant(saved, "hey t3")).toBe("t3")
  })

  // Round 2, finding 2: punctuation separates words, as in the server's `phraseKey`; it is not deleted.
  it("keeps word boundaries: \"hey-jeff\" and \"heyjeff\" are different phrases", () => {
    const close: Assignment[] = [
      { assistant: "jeff", phrases: ["hey-jeff"] },
      { assistant: "t3", phrases: ["heyjeff"] }
    ]
    expect(wakesAssistant(close, "heyjeff")).toBe("t3")
    expect(wakesAssistant(close, "hey jeff")).toBe("jeff")
    expect(wakesAssistant(close, "Hey-Jeff")).toBe("jeff")
  })

  it("a phrase that is only in a draft, or on another device, wakes nobody here", () => {
    expect(wakesAssistant(saved, "ok computer")).toBeUndefined()
    expect(wakesAssistant([], "hey jeff")).toBeUndefined()
  })
})

describe("the Look and Voice sections (docs/LOOKS-AND-VOICES.md §2, §4)", () => {
  const allKeys = type
  const older = { ...type, keys: type.keys.filter((k) => k !== "look" && k !== "voice") }
  const flame = { character: "flame", version: "1.1.1", options: { size: 0.8 } }
  const amy = { provider: "piper", voiceId: "en_US-amy-medium" }

  it("are sections of a type that has their keys, and not of one that does not (an older server)", () => {
    expect(sectionsOf(allKeys)).toEqual(["assign", "phrases", "voicePage", "look", "voice", "place", "capabilities", "interrupting", "audio", "captions"])
    expect(sectionsOf(older)).not.toContain("look")
    expect(sectionsOf(older)).not.toContain("voice")
  })

  it("a device follows its type (the assistant's look and voice) until it sets its own; Reset goes back", () => {
    expect(valueOf(device, noEdit, "look")).toEqual({ from: "assistant" })
    expect(isOwn(device, noEdit, "look")).toBe(false)
    const e = setKeys(device, setKeys(device, noEdit, { look: { from: "device", look: flame } }), { voice: { from: "device", voice: amy } })
    expect(isOwn(device, e, "look")).toBe(true)
    expect(isOwn(device, e, "voice")).toBe(true)
    expect(sectionChanged(device, e, "look")).toBe(true)
    expect(settingsOf(device, e)).toMatchObject({ look: { from: "device", look: flame }, voice: { from: "device", voice: amy } })
    expect(patchOf(device, e)).toEqual({ look: { from: "device", look: flame }, voice: { from: "device", voice: amy } })
    const back = resetSection(device, e, "look")
    expect(isOwn(device, back, "look")).toBe(false)
    expect(patchOf(device, back)).toEqual({ voice: { from: "device", voice: amy } })
  })

  it("a saved own look resets to null in the patch; following the assistant can be a device's own value", () => {
    const saved = baseOfDevice({ ...exampleDevice, own: { ...exampleDevice.own, look: { from: "device", look: flame } }, settings: { ...exampleDevice.settings, look: { from: "device", look: flame } } }, type)
    expect(isOwn(saved, noEdit, "look")).toBe(true)
    expect(patchOf(saved, resetSection(saved, noEdit, "look"))).toEqual({ look: null })
    // The type's defaults fix a look; this device follows the assistant anyway, as its own value.
    const typeFixed = { ...type, settings: { ...type.settings, look: { from: "device" as const, look: flame } } }
    const follower = baseOfDevice({ ...exampleDevice, settings: { ...exampleDevice.settings, look: { from: "device", look: flame } } }, typeFixed)
    const e = setKeys(follower, noEdit, { look: { from: "assistant" } })
    expect(patchOf(follower, e)).toEqual({ look: { from: "assistant" } })
    expect(isOwn(follower, e, "look")).toBe(true)
  })

  it("an edit back to the saved own look leaves nothing to save", () => {
    const saved = baseOfDevice({ ...exampleDevice, own: { ...exampleDevice.own, voice: { from: "device", voice: amy } }, settings: { ...exampleDevice.settings, voice: { from: "device", voice: amy } } }, type)
    const e = setKeys(saved, setKeys(saved, noEdit, { voice: { from: "assistant" } }), { voice: { from: "device", voice: { ...amy } } })
    expect(patchOf(saved, e)).toEqual({})
    expect(isDirty(saved, e, exampleDevice.name)).toBe(false)
  })

  it("a type's defaults set them for every device of the type", () => {
    const e = setKeys(typeBase, noEdit, { look: { from: "device", look: flame } })
    expect(patchOf(typeBase, e)).toEqual({ look: { from: "device", look: flame } })
    expect(isOwn(typeBase, e, "look")).toBe(false) // a type has no "own": it is the defaults
  })
})
