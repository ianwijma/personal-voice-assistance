import { describe, expect, it } from "vitest"
import type { DeviceSetup, Look, ServerMessage } from "@pva/protocol"
import { exampleDeviceSetup, serverExamples } from "@pva/protocol/examples"
import { BASELINE_ID, tryoutFromSearch, withTryout } from "@/characters/choice.ts"
import { stageChoiceOf } from "@/components/Visualiser.tsx"
import { type Action, type ClientState, initialState, reducer } from "@/lib/state.ts"
import { shownAssistantId, stageLookOf, topBarName } from "@/lib/voiceSetup.ts"

/** Which look the voice page's stage shows (docs/LOOKS-AND-VOICES.md §3), and the address bar's try-out. */

const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)
const flame: Look = { character: "flame", version: "1.1.1", options: { size: 0.8 } }
const lips: Look = { character: "lips", version: "1.1.1" }
const eyes: Look = { character: "robot-eyes", version: "1.1.1" }

const setup = (patch: Partial<DeviceSetup> = {}): DeviceSetup => ({
  ...exampleDeviceSetup,
  assistants: [
    { id: "jeff", name: "Jeff", purpose: "Everyday questions.", on: true, phrases: [], look: flame },
    { id: "t3", name: "T3", purpose: "Coding work.", on: true, phrases: ["Hey T3"], look: lips },
    { id: "keuken", name: "Keuken", purpose: "Kitchen.", on: true, phrases: ["Hey keuken"] }
  ],
  withoutPhrase: { mode: "assistant", assistant: "jeff" },
  canPick: true,
  canAuto: false,
  ...patch
})
const welcome = (s: DeviceSetup): ServerMessage => ({ ...serverExamples.welcome, snapshot: { ...serverExamples.welcome.snapshot, setup: s, conversations: [] } })
const turnStart = (turnId: number, assistantId: string): ServerMessage => ({ type: "turn.start", turnId, source: "voice", userText: "Hi", spoken: true, assistantId })
const turnEnd = (turnId: number): ServerMessage => ({
  type: "turn.end",
  turnId,
  outcome: "completed",
  trace: { turnId, mode: "voice", speculative: false, outcome: "completed", marks: {}, tools: [], voices: [] }
})

describe("the stage's look", () => {
  it("before a setup: the baseline", () => expect(stageLookOf(initialState)).toBeUndefined())

  it("the assistant the top bar names: who answers without a phrase", () => {
    const s = run([welcome(setup())])
    expect(shownAssistantId(s)).toBe("jeff")
    expect(topBarName(s)).toBe("Jeff")
    expect(stageLookOf(s)).toEqual(flame)
  })

  it("the assistant holding the turn wins, and the stage follows it back", () => {
    let s = run([welcome(setup()), { type: "state", state: "listening" }, turnStart(1, "t3")])
    expect(stageLookOf(s)).toEqual(lips)
    s = run([turnEnd(1), turnStart(2, "jeff")], s)
    expect(stageLookOf(s)).toEqual(flame)
  })

  it("an assistant without a look shows the baseline, unless the device has its own look", () => {
    const s = run([welcome(setup()), { type: "state", state: "listening" }, turnStart(1, "keuken")])
    expect(stageLookOf(s)).toBeUndefined()
    // A device with its own look: the setup resolves it into every assistant (lookFor) and carries it itself.
    const own = setup({ look: eyes, assistants: setup().assistants.map((a) => ({ ...a, look: eyes })) })
    expect(stageLookOf(run([welcome(own), { type: "state", state: "listening" }, turnStart(1, "keuken")]))).toEqual(eyes)
  })

  it("no single assistant named (Auto, nobody with several, an empty list): the device's own look, else the baseline", () => {
    expect(stageLookOf(run([welcome(setup({ withoutPhrase: { mode: "nobody" } }))]))).toBeUndefined()
    expect(stageLookOf(run([welcome(setup({ withoutPhrase: { mode: "typesafe", fallback: "jeff" }, canAuto: true }))]))).toBeUndefined()
    expect(stageLookOf(run([welcome(setup({ assistants: [], look: eyes, withoutPhrase: { mode: "nobody" } }))]))).toEqual(eyes)
    // One assistant: it is named whatever the rule.
    const one = setup({ assistants: [setup().assistants[1]!], withoutPhrase: { mode: "nobody" } })
    expect(stageLookOf(run([welcome(one)]))).toEqual(lips)
  })

  it("a new setup (the admin saved another look) changes the stage without a turn", () => {
    const s = run([welcome(setup()), { type: "device.setup", ...setup({ assistants: setup().assistants.map((a) => (a.id === "jeff" ? { ...a, look: eyes } : a)) }) }])
    expect(stageLookOf(s)).toEqual(eyes)
  })
})

describe("the address bar's try-out (this page load only)", () => {
  it("?character= wins over the configured look, with its opt.* values as given", () => {
    const t = tryoutFromSearch("?ws=x&character=lips&opt.mouthRange=1.2&opt.$you=%23ff0000")
    expect(t).toEqual({ tryout: { character: "lips", options: { mouthRange: "1.2", $you: "#ff0000" } }, search: "?ws=x" })
    expect(withTryout(flame, t!.tryout)).toEqual({ character: "lips", options: { mouthRange: "1.2", $you: "#ff0000" } })
    expect(stageChoiceOf(run([welcome(setup())]), t!.tryout)).toEqual({ character: "lips", options: { mouthRange: "1.2", $you: "#ff0000" } })
  })
  it("opt.* alone tunes the configured look (the baseline when there is none)", () => {
    const t = tryoutFromSearch("?opt.size=0.6")!.tryout
    expect(withTryout(flame, t)).toEqual({ ...flame, options: { size: "0.6" } })
    expect(withTryout(undefined, t)).toEqual({ character: BASELINE_ID, options: { size: "0.6" } })
  })
  it("nothing about characters: no try-out, the configured look as it is", () => {
    expect(tryoutFromSearch("?ws=x")).toBeUndefined()
    expect(withTryout(flame, undefined)).toBe(flame)
    expect(stageChoiceOf(run([welcome(setup())]), undefined)).toEqual(flame)
  })
})
