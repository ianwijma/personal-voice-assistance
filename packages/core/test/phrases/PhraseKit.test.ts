// P7 through the module test kit (docs/PHRASES.md "Testing"): a tiny module's phrase commands on the real decision,
// matcher, runner, gateway and notification service. A command runs as a `phrase` turn through the gateway; the risk
// policy, failures and the time limit; the ringing window opening and closing with the service; the host's controls;
// duplicates and refused declarations; the module stopped, started, restarted, and withdrawn between the decision and
// the run.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { defineAction, Param } from "../../src/Actions.ts"
import { checkModule } from "../../src/ModuleCheck.ts"
import { defineModule } from "../../src/ModuleDefinition.ts"
import { stubService, succeeds } from "../../src/ModuleStubs.ts"
import { provide, startTestModule } from "../../src/ModuleTestKit.ts"
import { PHRASE_ANSWER_CHARS } from "../../src/Phrases.ts"
import { ECHO_TAIL_MS } from "../../src/EchoGate.ts"
import { Playback, type PlaybackService } from "../../src/Playback.ts"
import { makeEgg } from "./egg.ts"

const said = (r: { readonly taken: boolean; readonly outcome?: { readonly said?: string } }) => (r.taken ? r.outcome?.said : undefined)
const did = (r: { readonly taken: boolean; readonly outcome?: { readonly did: string } }) => (r.taken ? r.outcome?.did : "not taken")

describe("a module's phrase commands", () => {
  it.effect("after the wake phrase: the action runs through the gateway as a phrase turn of the device, and its answer is spoken", () =>
    Effect.gen(function*() {
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition)
      const r = yield* kit.phrases.say("Egg timer for six minutes!", { device: "kitchen-display" })
      assert.strictEqual(did(r), "ran")
      assert.strictEqual(said(r), "Egg timer for 6 minutes.")
      const turn = egg.parts.turns[0]!
      assert.deepStrictEqual([turn.source, turn.assistantId, turn.deviceId, turn.person?.id], ["phrase", "jeff", "kitchen-display", "p-sam"])
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => [s.deviceId, s.text]), [["kitchen-display", "Egg timer for 6 minutes."]])
      // An optional slot left out, with no declared default: the action gets undefined (it words its own fallback).
      assert.strictEqual(said(yield* kit.phrases.say("boil an egg")), "Egg timer for 6 minutes.")
    }))

  it.effect("in Dutch, a Dutch household matches the Dutch phrases (and the host speaks Dutch)", () =>
    Effect.gen(function*() {
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(did(yield* kit.phrases.say("kookwekker voor zes minuten")), "ran")
      assert.strictEqual(did(yield* kit.phrases.say("egg timer for six minutes")), "not taken")
      assert.strictEqual(said(yield* kit.phrases.say("herhaal")), "Egg timer for 6 minutes.")
    }))

  it.effect("not taken: other words, and anything without the wake phrase while nothing rings", () =>
    Effect.gen(function*() {
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition)
      assert.deepStrictEqual(yield* kit.phrases.say("what's the weather"), { taken: false })
      assert.deepStrictEqual(yield* kit.phrases.say("egg status", { wake: false }), { taken: false })
      assert.deepStrictEqual(yield* kit.phrases.say("stop", { wake: false }), { taken: false })
      assert.deepStrictEqual(egg.parts.runs, [])
    }))

  it.effect(`the answer is cut to ${PHRASE_ANSWER_CHARS} characters at the module's page boundary`, () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      const r = yield* kit.phrases.say("egg status")
      assert.isAtMost(said(r)!.length, PHRASE_ANSWER_CHARS)
      assert.isTrue(said(r)!.startsWith("Still boiling."))
    }))

  it.effect("the risk policy refuses by the value said; a failing action says its own message; a hung one times out (5 s) with the host's sentence", () =>
    Effect.gen(function*() {
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition)
      assert.strictEqual(did(yield* kit.phrases.say("tell the house about the egg")), "ran")
      const refused = yield* kit.phrases.say("tell my sister about the egg")
      // P8: the risk policy's own sentence, the same as for the same action asked of the intent agent.
      assert.deepStrictEqual([did(refused), said(refused)], ["refused", "I can't send that: messages need the owner's confirmation, and I can't ask for that yet."])
      assert.deepStrictEqual(egg.parts.runs, ["tell"])
      const failed = yield* kit.phrases.say("crack the egg")
      assert.deepStrictEqual([did(failed), said(failed)], ["failed", "The egg cracked."])
      const hung = yield* kit.phrases.say("wait for the egg")
      assert.deepStrictEqual([did(hung), said(hung)], ["failed", "That didn't work."])
    }))

  it.effect("a command switched off for the assistant is not in its set (the gateway would refuse it too)", () =>
    Effect.gen(function*() {
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition, { household: { assistants: [{ id: "jeff", modules: { egg: { offTools: ["egg_status"] } } }] } })
      assert.deepStrictEqual(yield* kit.phrases.say("egg status"), { taken: false })
      assert.strictEqual(did(yield* kit.phrases.say("boil an egg")), "ran")
    }))
})

describe("the ringing window", () => {
  const ringing = Effect.gen(function*() {
    const egg = makeEgg()
    const kit = yield* startTestModule(egg.definition)
    yield* kit.phrases.say("boil an egg", { device: "kitchen-display" })
    assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
    // Its answer ("Egg timer for 6 minutes.") was spoken there: the window opens once its echo tail is over.
    yield* kit.advance(ECHO_TAIL_MS)
    return { egg, kit }
  })

  it.effect("'stop' without the wake phrase stops the ring through the service (outcome stop), and says nothing", () =>
    Effect.gen(function*() {
      const { kit } = yield* ringing
      const r = yield* kit.phrases.say("Stop!", { device: "kitchen-display", wake: false })
      assert.deepStrictEqual([r.taken, r.taken && r.by, did(r), said(r)], [true, "ringing", "stopped-ring", undefined])
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      assert.deepStrictEqual((yield* kit.notify.all).map((n) => n.outcome), ["stop"])
    }))

  it.effect("a button's label reaches the module's handler through the same claim as a press; its answer is spoken", () =>
    Effect.gen(function*() {
      const { egg, kit } = yield* ringing
      const r = yield* kit.phrases.say("snooze", { device: "kitchen-display", wake: false })
      assert.deepStrictEqual([did(r), said(r)], ["pressed", "Snoozed."])
      assert.strictEqual(egg.parts.snoozes.length, 1)
      assert.deepStrictEqual((yield* kit.notify.all).map((n) => n.outcome), ["snooze"])
    }))

  it.effect("closed on another device (it rings only on the device that asked), while a reply is spoken there, and with the device's setting off", () =>
    Effect.gen(function*() {
      const { kit } = yield* ringing
      assert.deepStrictEqual(yield* kit.phrases.say("stop", { device: "robins-phone", wake: false }), { taken: false })
      yield* kit.notify.replying("kitchen-display", true)
      assert.deepStrictEqual(yield* kit.phrases.say("stop", { device: "kitchen-display", wake: false }), { taken: false })
      yield* kit.notify.replying("kitchen-display", false)
      // Still the reply's echo tail: closed; once it is over, the window takes "stop".
      assert.deepStrictEqual(yield* kit.phrases.say("stop", { device: "kitchen-display", wake: false }), { taken: false })
      yield* kit.advance(ECHO_TAIL_MS)
      assert.strictEqual(did(yield* kit.phrases.say("stop", { device: "kitchen-display", wake: false })), "stopped-ring")
      const off = yield* startTestModule(makeEgg().definition, {
        household: { devices: [{ id: "kitchen-display", name: "Kitchen display", room: "Kitchen", ringingWithoutWake: false }] }
      })
      yield* off.phrases.say("boil an egg", { device: "kitchen-display" })
      assert.strictEqual(off.notify.engine.ringingOn("kitchen-display").length, 1)
      assert.deepStrictEqual(yield* off.phrases.say("stop", { device: "kitchen-display", wake: false }), { taken: false })
      // With the wake phrase, "stop" still stops it (the host's control, after the wake phrase).
      assert.strictEqual(did(yield* off.phrases.say("stop", { device: "kitchen-display" })), "stopped-ring")
    }))

  it.effect("it closes when the notification is resolved elsewhere, and under do not disturb (nothing rings)", () =>
    Effect.gen(function*() {
      const { egg, kit } = yield* ringing
      const [n] = kit.notify.engine.ringingOn("kitchen-display")
      yield* kit.notify.press(n!.id, "stop", { device: "kitchen-display" })
      assert.deepStrictEqual(yield* kit.phrases.say("stop", { device: "kitchen-display", wake: false }), { taken: false })
      yield* kit.asTurn(egg.parts.notify!.dnd.set())
      yield* kit.phrases.say("boil an egg", { device: "kitchen-display" })
      yield* kit.notify.settle
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      assert.deepStrictEqual(yield* kit.phrases.say("snooze", { device: "kitchen-display", wake: false }), { taken: false })
    }))

  it.effect("a device that disconnects holds nothing (closed); when it connects again it rings again and the window opens", () =>
    Effect.gen(function*() {
      const { kit } = yield* ringing
      yield* kit.notify.disconnect("kitchen-display")
      assert.deepStrictEqual(yield* kit.phrases.say("stop", { device: "kitchen-display", wake: false }), { taken: false })
      yield* kit.notify.connect("kitchen-display")
      assert.strictEqual(did(yield* kit.phrases.say("stop", { device: "kitchen-display", wake: false })), "stopped-ring")
    }))
})

describe("the host's essential controls", () => {
  it.effect("stop: what rings first; then a reply being spoken; then media Playback pauses on the device; with nothing, nothing", () =>
    Effect.gen(function*() {
      const playback = stubService<PlaybackService>("playback", { pause: succeeds(true) })
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition, { provide: [provide("music", { services: [Playback.of(playback.service)] })] })
      yield* kit.phrases.say("boil an egg")
      yield* kit.notify.replying("kitchen-display", true)
      // A ring and a reply: the ring is the first that exists; the reply is left.
      assert.strictEqual(did(yield* kit.phrases.say("stop")), "stopped-ring")
      assert.deepStrictEqual(kit.phrases.sessionCalls, [])
      // The reply now.
      assert.strictEqual(did(yield* kit.phrases.say("stop")), "stopped-reply")
      assert.deepStrictEqual(kit.phrases.sessionCalls, [{ deviceId: "kitchen-display", call: "stop" }])
      // Media on the device: asked by its id, not by a room.
      assert.strictEqual(did(yield* kit.phrases.say("stop")), "paused-media")
      assert.deepStrictEqual(playback.calls.pause, [["kitchen-display"]])
      // Nothing playing (the provider says it paused nothing).
      playback.answer("pause", succeeds(false))
      const r = yield* kit.phrases.say("stop")
      assert.deepStrictEqual([did(r), said(r)], ["nothing", undefined])
    }))

  it.effect("stop with no Playback provider and nothing else does nothing", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      assert.strictEqual(did(yield* kit.phrases.say("stop it")), "nothing")
    }))

  it.effect("a14: a device with no room is asked about media by its id, as any other (Playback is keyed by device)", () =>
    Effect.gen(function*() {
      const playback = stubService<PlaybackService>("playback", { pause: succeeds(true) })
      const kit = yield* startTestModule(makeEgg().definition, {
        provide: [provide("music", { services: [Playback.of(playback.service)] })],
        household: { devices: [{ id: "roomless-01", name: "Roomless" }] }
      })
      assert.strictEqual(did(yield* kit.phrases.say("stop", { device: "roomless-01" })), "paused-media")
      assert.deepStrictEqual(playback.calls.pause, [["roomless-01"]])
    }))

  it.effect("never mind: a pending reply is cancelled (silently); without one, nothing", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      assert.deepStrictEqual([did(yield* kit.phrases.say("never mind")), kit.phrases.spoken.length], ["nothing", 0])
      yield* kit.notify.replying("kitchen-display", true)
      assert.deepStrictEqual([did(yield* kit.phrases.say("forget it")), kit.phrases.spoken.length], ["cancelled", 0])
      assert.deepStrictEqual(kit.phrases.sessionCalls.map((c) => c.call), ["cancel", "cancel"])
    }))

  it.effect("repeat: with nothing said yet the host says so; after a reply it is said again", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      const first = yield* kit.phrases.say("repeat")
      assert.deepStrictEqual([did(first), said(first)], ["nothing", "I haven't said anything yet."])
      kit.phrases.replied("kitchen-display", "It is ten past four.")
      const again = yield* kit.phrases.say("say that again")
      assert.deepStrictEqual([did(again), said(again)], ["repeated", "It is ten past four."])
    }))

  it.effect("louder and quieter step the reply volume within its bounds, say so at the limits, and say an interrupted reply again", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      assert.strictEqual(kit.phrases.volume("kitchen-display"), 1)
      const loud = yield* kit.phrases.say("louder")
      assert.deepStrictEqual([did(loud), said(loud), kit.phrases.volume("kitchen-display")], ["volume", "That's as loud as I go.", 1])
      for (const level of [0.8, 0.6, 0.4, 0.2]) {
        assert.strictEqual(said(yield* kit.phrases.say("quieter")), "Quieter.")
        assert.strictEqual(kit.phrases.volume("kitchen-display"), level)
      }
      assert.strictEqual(said(yield* kit.phrases.say("a bit quieter")), "That's as quiet as I go.")
      assert.strictEqual(kit.phrases.volume("kitchen-display"), 0.2)
      // Said over a reply: the reply is said again at the new level, not "Louder.".
      const over = yield* kit.phrases.say("speak up", { interrupting: "The pasta needs eight more minutes." })
      assert.deepStrictEqual([said(over), kit.phrases.volume("kitchen-display")], ["The pasta needs eight more minutes.", 0.4])
      // Other devices keep their own level.
      assert.strictEqual(kit.phrases.volume("robins-phone"), 1)
    }))

  it.effect("a module command that interrupted a reply: the reply follows its answer, unless the action ends the reply", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      assert.strictEqual(said(yield* kit.phrases.say("tell the house about the egg", { interrupting: "Where was I." })), "Told. Where was I.")
      // `wait` is declared `endsReply` (it also times out): only the host's failure sentence.
      assert.strictEqual(said(yield* kit.phrases.say("wait for the egg", { interrupting: "Where was I." })), "That didn't work.")
    }))
})

describe("conflicts and declarations", () => {
  it.effect("two modules with the same phrase for one assistant: both left out, named for the Health page; their other phrases stay", () =>
    Effect.gen(function*() {
      const a = makeEgg()
      const b = makeEgg({ id: "duck", status: ["egg status", "duck status"] })
      const kit = yield* startTestModule(a.definition, { others: [b.definition] })
      const conflicts = (yield* kit.phrases.commandsFor()).conflicts
      assert.deepStrictEqual(conflicts.filter((c) => c.kind === "duplicate").map((c) => c.kind === "duplicate" && c.shape).sort(), [
        "boil an egg",
        "crack the egg",
        "egg status",
        "egg timer for {}",
        "tell {} about the egg",
        "wait for the egg"
      ])
      assert.deepStrictEqual(yield* kit.phrases.say("egg status"), { taken: false })
      assert.strictEqual(did(yield* kit.phrases.say("duck status")), "ran")
    }))

  it.effect("a phrase outside the rules refuses the start, naming the action, the phrase and why (the Health page shows it)", () =>
    Effect.gen(function*() {
      const bad = defineModule({
        apiVersion: 2,
        id: "bad",
        name: "Bad",
        description: "Declares a reserved phrase.",
        enabledByDefault: false,
        start: () =>
          Effect.succeed({
            actions: [defineAction({ id: "halt", label: "Halt", description: "Halt.", params: { what: Param.text({ label: "What", after: [] }) }, phrases: { en: ["stop", "halt everything"] }, risk: "change", run: () => Effect.void })]
          })
      })
      const kit = yield* startTestModule(bad)
      assert.strictEqual(kit.info()?.state, "error")
      const error = kit.info()?.error ?? ""
      assert.include(error, "Phrase commands refused")
      assert.include(error, "bad.halt: \"stop\" (en)")
      assert.include(error, "the required parameter what has no slot")
      assert.isTrue(kit.issues().some((i) => i.title.includes("Bad") || i.detail.includes("Phrase commands refused")))
    }))

  it.effect("passes the conformance check with its phrases", () => checkModule(makeEgg().definition))
})

describe("lifecycle", () => {
  it.effect("stopped: its phrases are not in the set (not taken); started and restarted: they run again", () =>
    Effect.gen(function*() {
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition)
      yield* kit.stop
      assert.deepStrictEqual(yield* kit.phrases.say("boil an egg"), { taken: false })
      // The host's controls do not depend on any module.
      assert.strictEqual(did(yield* kit.phrases.say("louder")), "volume")
      yield* kit.start
      assert.strictEqual(did(yield* kit.phrases.say("boil an egg")), "ran")
      yield* kit.restart
      assert.strictEqual(did(yield* kit.phrases.say("egg status")), "ran")
    }))

  it.effect("a match whose module is withdrawn before it runs: 'I can't do that right now.', and nothing ran", () =>
    Effect.gen(function*() {
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition)
      const taken = yield* kit.phrases.decide("boil an egg")
      assert.strictEqual(taken?.by, "phrase")
      yield* kit.stop
      const outcome = yield* kit.phrases.run(taken!)
      assert.deepStrictEqual([outcome.did, outcome.said], ["not-running", "I can't do that right now."])
      assert.deepStrictEqual(egg.parts.runs, [])
      // Restarted between the decision and the run: the old action is withdrawn too (a new one is published).
      yield* kit.start
      const again = yield* kit.phrases.decide("boil an egg")
      yield* kit.restart
      assert.strictEqual((yield* kit.phrases.run(again!)).did, "not-running")
      assert.deepStrictEqual(egg.parts.runs, [])
    }))
})
