// P7 (docs/PHRASES.md): the one decision per utterance (`decideUtterance`), with stand-in gates. The gates are called
// exactly once per final, with the real final or with one that has no words; a taken utterance's final goes on with no
// words; one that is not taken goes on exactly as the gates made it; the route decides which set is matched.
import { describe, expect, it } from "vitest"
import { buildCommandSet, decideUtterance, defineAction, hostCommandSet, Param, registerActions, type RouteResult, type RouteTarget, type SttEvent } from "../../src/index.ts"
import { Effect } from "effect"

const timers = registerActions("timers", [defineAction({
  id: "start",
  label: "Start a timer",
  description: "A timer.",
  params: { length: Param.duration({ label: "Length" }) },
  phrases: { en: ["timer for {length}"] },
  run: () => Effect.succeed({ say: "Started." })
})])

const harness = (route: RouteTarget | undefined, o: { readonly ringing?: ReadonlyArray<{ id: string; actions: ReadonlyArray<{ id: string; label: string }> }>; readonly wake?: boolean } = {}) => {
  const gated: Array<SttEvent> = []
  const asked: Array<string | undefined> = []
  const gates = (final: SttEvent): ReadonlyArray<RouteResult> => {
    gated.push(final)
    // The route gate as it would answer: the final with the wake phrase removed, for the route's target.
    const text = final._tag === "EndOfTurn" ? final.text.replace(/^hey jeff,?\s*/i, "") : ""
    return [{ events: [{ _tag: "EndOfTurn", text }], ...(route !== undefined ? { target: route } : {}) }]
  }
  const decide = (text: string) =>
    decideUtterance({
      final: { _tag: "EndOfTurn", text },
      language: "en",
      ringing: o.ringing,
      wakeAtStart: (t) => o.wake ?? /^hey jeff/i.test(t),
      gates,
      commandsFor: (a) => {
        asked.push(a)
        return a === undefined ? hostCommandSet("en") : buildCommandSet("en", timers)
      }
    })
  return { decide, gated, asked }
}

const phrase: RouteTarget = { assistant: "jeff", by: "phrase", phrase: "hey jeff" }

describe("decideUtterance", () => {
  it("not taken: the gates' results exactly, the gates called once with the real final", () => {
    const h = harness(phrase)
    const d = h.decide("hey jeff what's the weather")
    expect(d.taken).toBeUndefined()
    expect(d.results).toEqual([{ events: [{ _tag: "EndOfTurn", text: "what's the weather" }], target: phrase }])
    expect(h.gated).toEqual([{ _tag: "EndOfTurn", text: "hey jeff what's the weather" }])
    expect(h.asked).toEqual(["jeff"])
  })

  it.each([
    ["phrase", phrase],
    ["armed", { assistant: "jeff", by: "armed" } as RouteTarget],
    ["follow-up", { assistant: "jeff", by: "follow-up" } as RouteTarget],
    ["default (answers without a phrase)", { assistant: "jeff", by: "default" } as RouteTarget]
  ])("after-wake, routed by %s: a module command is taken and its final goes on with no words", (_by, route) => {
    const h = harness(route)
    const d = h.decide("hey jeff, timer for ten minutes")
    expect(d.taken).toMatchObject({ by: "phrase", assistant: "jeff", text: "timer for ten minutes", match: { kind: "command", values: { length: 600_000 } } })
    expect(d.results).toEqual([{ events: [{ _tag: "EndOfTurn", text: "" }], target: route }])
    expect(h.gated).toHaveLength(1)
  })

  it("a decide target (TypeSafe): the host's controls only, with no assistant named", () => {
    const route: RouteTarget = { by: "decide", fallback: "jeff" }
    const h = harness(route)
    expect(h.decide("timer for ten minutes").taken).toBeUndefined()
    expect(h.decide("louder").taken).toMatchObject({ by: "phrase", assistant: undefined, match: { kind: "control", control: "louder" } })
    expect(h.asked).toEqual([undefined, undefined])
  })

  it("an utterance the route gate dropped (asleep, an assistant switched off) is never taken; nothing is asked", () => {
    const h = harness({ by: "dropped", reason: "asleep" })
    expect(h.decide("stop").taken).toBeUndefined()
    expect(h.asked).toEqual([])
    const off = harness({ by: "dropped", reason: "off", assistant: "jeff" })
    expect(off.decide("hey jeff stop").taken).toBeUndefined()
  })

  it("a blank final: the gates once, nothing taken", () => {
    const h = harness(phrase, { ringing: [{ id: "n1", actions: [] }] })
    expect(h.decide("  ").taken).toBeUndefined()
    expect(h.gated).toEqual([{ _tag: "EndOfTurn", text: "  " }])
  })

  describe("the ringing window", () => {
    const ringing = [{ id: "n1", actions: [{ id: "snooze", label: "Snooze" }] }]

    it("'stop' without the wake phrase, on a device that answers nobody: taken before the gates, which see a final with no words", () => {
      const h = harness({ by: "dropped", reason: "asleep" }, { ringing })
      const d = h.decide("Stop!")
      expect(d.taken).toEqual({ by: "ringing", match: { kind: "stop", phrase: "stop" } })
      expect(h.gated).toEqual([{ _tag: "EndOfTurn", text: "" }])
      expect(h.asked).toEqual([])
    })

    it("a button's label is taken as that notification's action", () => {
      const h = harness({ by: "dropped", reason: "asleep" }, { ringing })
      expect(h.decide("snooze").taken).toEqual({ by: "ringing", match: { kind: "action", notificationId: "n1", actionId: "snooze", label: "Snooze" } })
    })

    it("a wake phrase at the start leaves the window: 'hey jeff stop' is the host's stop after the wake phrase", () => {
      const h = harness(phrase, { ringing })
      const d = h.decide("hey jeff stop")
      expect(d.taken).toMatchObject({ by: "phrase", match: { kind: "control", control: "stop" } })
      expect(h.gated).toEqual([{ _tag: "EndOfTurn", text: "hey jeff stop" }])
      // "hey jeff snooze": not a control, not a command of jeff's: not taken (it goes to jeff as a turn).
      expect(harness(phrase, { ringing }).decide("hey jeff snooze").taken).toBeUndefined()
    })

    it("closed (undefined: nothing rings, the setting is off, or the device was audible): 'stop' without a phrase is not taken", () => {
      const h = harness({ by: "dropped", reason: "asleep" }, {})
      expect(h.decide("stop").taken).toBeUndefined()
      expect(h.gated).toEqual([{ _tag: "EndOfTurn", text: "stop" }])
      expect(harness({ by: "dropped", reason: "asleep" }, { ringing: [] }).decide("stop").taken).toBeUndefined()
    })

    it("other words in the window go through the gates as before", () => {
      const h = harness({ assistant: "jeff", by: "default" }, { ringing })
      expect(h.decide("what time is it").taken).toBeUndefined()
      expect(h.gated).toEqual([{ _tag: "EndOfTurn", text: "what time is it" }])
    })
  })
})
