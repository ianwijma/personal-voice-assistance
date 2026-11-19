// P7 review round 1 through the kit (docs/PHRASES.md): the one settlement for every outcome (a5, a6, a8, b6), the
// execution trace (a7), defaults (a4), one module action at a time per device while the host's controls stay free (a9,
// E6), announcements in the window and in "stop" (a10), the two core services for modules (a11), the kept reply's bound
// (a12), and a cancelled utterance (E5).
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { ActionError, defineAction, Param } from "../../src/Actions.ts"
import { defineModule } from "../../src/ModuleDefinition.ts"
import { startTestModule } from "../../src/ModuleTestKit.ts"
import { MAX_KEPT_REPLY_CHARS } from "../../src/PhraseRunner.ts"
import { DeviceControl, type DeviceControlService, SessionControl, type SessionControlService } from "../../src/SessionControl.ts"
import { makeEgg } from "./egg.ts"

const said = (r: { readonly taken: boolean; readonly outcome?: { readonly said?: string } }) => (r.taken ? r.outcome?.said : undefined)
const did = (r: { readonly taken: boolean; readonly outcome?: { readonly did: string } }) => (r.taken ? r.outcome?.did : "not taken")

/** A module whose actions do what a test needs: answer, stay silent, throw in announce, take a while. */
const probe = (record: Array<unknown> = []) =>
  defineModule({
    apiVersion: 2,
    id: "probe",
    name: "Probe",
    description: "Probes.",
    enabledByDefault: false,
    start: () =>
      Effect.succeed({
        actions: [
          defineAction({
            id: "fan",
            label: "Fan",
            description: "Fan.",
            examples: ["fan on"],
            params: {
              speed: Param.choice({ label: "Speed", options: [{ value: "low", label: "low" }, { value: "high", label: "high" }], default: "low", optional: true }),
              yes: Param.boolean({ label: "Yes", question: "Yes?" })
            },
            phrases: { en: ["fan on", "fan on {speed}"] },
            risk: "change",
            run: (values) => Effect.sync(() => (record.push(values), { say: "Fan on." }))
          }),
          defineAction({ id: "quiet", label: "Quiet", description: "Says nothing.", examples: ["do it quietly"], params: {}, phrases: { en: ["do it quietly"] }, risk: "change", run: () => Effect.void }),
          defineAction({
            id: "shout",
            label: "Shout",
            description: "Announce throws.",
            examples: ["shout"],
            params: {},
            phrases: { en: ["shout it"] },
            risk: "change",
            announce: () => {
              throw new Error("announce broke")
            },
            run: () => Effect.void
          }),
          defineAction({ id: "slow", label: "Slow", description: "Takes a second.", examples: ["go slowly"], params: {}, phrases: { en: ["go slowly"] }, risk: "change", run: () => Effect.as(Effect.sleep(1_000), { say: "Done slowly." }) }),
          defineAction({ id: "crack", label: "Crack", description: "Fails.", examples: ["crack it"], params: {}, phrases: { en: ["crack it"] }, risk: "change", run: () => Effect.fail(new ActionError({ message: "It cracked." })) }),
          defineAction({ id: "hang", label: "Hang", description: "Never ends.", examples: ["hang on"], params: {}, phrases: { en: ["hang on forever"] }, risk: "change", run: () => Effect.never }),
          defineAction({
            id: "tell",
            label: "Tell",
            description: "Tells someone.",
            examples: ["tell my sister"],
            params: { who: Param.choice({ label: "Who", options: [{ value: "house", label: "the house" }, { value: "outside", label: "my sister" }] }) },
            phrases: { en: ["tell {who}"] },
            risk: { classes: ["change", "message"], of: ({ who }) => (who === "outside" ? "message" : "change") },
            run: () => Effect.succeed({ say: "Told." })
          })
        ]
      })
  })

describe("a4: a parameter the phrase leaves out", () => {
  it.effect("reaches the action with its declared default and false for a yes/no, as on every other path", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      const kit = yield* startTestModule(probe(seen))
      yield* kit.phrases.say("fan on")
      yield* kit.action("fan", {})
      assert.deepStrictEqual(seen, [{ speed: "low", yes: false }, { speed: "low", yes: false }])
    }))
})

describe("one settlement for every outcome (E4)", () => {
  const interrupting = "Where was I. The pasta needs eight more minutes."
  it.effect("a5: the interrupted reply follows a failure, a refusal, a time-out and a withdrawal, as it follows success", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(probe())
      assert.strictEqual(said(yield* kit.phrases.say("crack it", { interrupting })), `It cracked. ${interrupting}`)
      assert.strictEqual(said(yield* kit.phrases.say("tell my sister", { interrupting })), `I'm not allowed to do that. ${interrupting}`)
      assert.strictEqual(said(yield* kit.phrases.say("hang on forever", { interrupting })), `That didn't work. ${interrupting}`)
      const taken = yield* kit.phrases.decide("fan on")
      yield* kit.stop
      assert.strictEqual((yield* kit.phrases.run(taken!, { interrupting })).said, `I can't do that right now. ${interrupting}`)
    }))

  it.effect("a6: the answer in the addressed assistant's voice, then the interrupted reply in its own assistant's voice, in that order", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(probe(), { household: { assistants: [{ id: "jeff" }, { id: "robin" }] } })
      yield* kit.phrases.say("fan on", { assistant: "jeff", interrupting: "Robin was speaking.", interruptedBy: "robin" })
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => [s.assistant, s.text]), [["jeff", "Fan on."], ["robin", "Robin was speaking."]])
    }))

  it.effect("a8: an announce that throws is the module's failure: the host's sentence, and the interrupted reply still follows", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(probe())
      const r = yield* kit.phrases.say("shout it", { interrupting })
      assert.deepStrictEqual([did(r), said(r), r.taken && r.outcome.why], ["failed", `That didn't work. ${interrupting}`, "its announce threw"])
    }))

  it.effect("b6: stop that selected a ring says the reply its own start of speech interrupted again; one that selected the reply does not", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      yield* kit.phrases.say("boil an egg")
      const ring = yield* kit.phrases.say("stop", { interrupting })
      assert.deepStrictEqual([did(ring), said(ring)], ["stopped-ring", interrupting])
      const reply = yield* kit.phrases.say("stop", { interrupting })
      assert.deepStrictEqual([did(reply), said(reply)], ["stopped-reply", undefined])
      // "never mind" ends the reply too.
      assert.strictEqual(said(yield* kit.phrases.say("never mind", { interrupting })), undefined)
    }))
})

describe("a7: an execution trace for every taken utterance", () => {
  it.effect("silent, failed, refused and timed-out actions: principal, risk, the gateway's refusal, timings, the outcome", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(probe())
      yield* kit.phrases.say("do it quietly")
      yield* kit.phrases.say("crack it")
      yield* kit.phrases.say("tell my sister")
      yield* kit.phrases.say("hang on forever")
      yield* kit.phrases.say("louder")
      const t = kit.phrases.traces
      assert.deepStrictEqual(t.map((x) => [x.by, x.name, x.did]), [
        ["command", "probe.quiet", "ran"],
        ["command", "probe.crack", "failed"],
        ["command", "probe.tell", "refused"],
        ["command", "probe.hang", "failed"],
        ["control", "louder", "volume"]
      ])
      assert.deepStrictEqual([t[0]!.turn?.source, t[0]!.turn?.assistantId, t[0]!.turn?.deviceId, t[0]!.turn?.person?.id, t[0]!.risk, t[0]!.tool], ["phrase", "jeff", "kitchen-display", "p-sam", "change", "probe_quiet"])
      assert.strictEqual(t[2]!.risk, "message")
      assert.isString(t[2]!.refused)
      assert.strictEqual(t[3]!.why, "timeout")
      assert.isAtLeast(t[3]!.actionMs!, 5_000)
      for (const x of t) assert.isAtLeast(x.totalMs, 0)
    }))
})

describe("one module action at a time per device; the host's controls are never busy (a9, E6)", () => {
  it.effect("two at once on one device: the second is answered busy; on another device both run; stop and louder run meanwhile", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(probe())
      const first = yield* Effect.forkChild(kit.phrases.say("go slowly"))
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      const second = yield* kit.phrases.say("fan on")
      assert.deepStrictEqual([did(second), said(second)], ["busy", "One moment, I'm still doing the last one."])
      const other = yield* kit.phrases.say("fan on", { device: "robins-phone" })
      assert.strictEqual(did(other), "ran")
      assert.strictEqual(did(yield* kit.phrases.say("louder")), "volume")
      assert.strictEqual(did(yield* kit.phrases.say("stop")), "nothing")
      const done = yield* Fiber.join(first)
      assert.strictEqual(did(done), "ran")
      assert.strictEqual(did(yield* kit.phrases.say("fan on")), "ran")
    }))
})

describe("a10: announcements count for the ringing window and for stop", () => {
  it.effect("while an announcement plays (and in its echo tail) the window is closed; after the wake phrase, stop takes the ring, then the announcement", () =>
    Effect.gen(function*() {
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition, { speechMs: 100_000 })
      yield* kit.phrases.say("boil an egg")
      // An announcement on the kitchen display (code outside a turn, as a job would say it): it plays for 100 s.
      yield* egg.parts.speech!.say({ device: "kitchen-display" }, "Stop. The bins go out tonight.")
      yield* kit.notify.settle
      assert.strictEqual(kit.notify.announced.length, 1)
      assert.deepStrictEqual(yield* kit.phrases.say("stop", { wake: false }), { taken: false })
      assert.strictEqual(did(yield* kit.phrases.say("stop")), "stopped-ring")
      assert.strictEqual(did(yield* kit.phrases.say("stop")), "stopped-announcement")
      yield* kit.notify.settle
      assert.strictEqual(kit.notify.announced[0]!.outcome, "stopped")
    }))
})

describe("a11: SessionControl and DeviceControl for modules", () => {
  it.effect("a module looks both up and uses them on the kit's session and volume", () =>
    Effect.gen(function*() {
      let session: SessionControlService | undefined
      let device: DeviceControlService | undefined
      const user = defineModule({
        apiVersion: 2,
        id: "user",
        name: "User",
        description: "Uses the core's controls.",
        enabledByDefault: false,
        shared: (ctx) =>
          Effect.sync(() => {
            session = ctx.host.service(SessionControl)
            device = ctx.host.service(DeviceControl)
            return { value: undefined as void }
          }),
        start: () => Effect.succeed({})
      })
      const kit = yield* startTestModule(user)
      assert.isDefined(session)
      assert.isDefined(device)
      assert.deepStrictEqual(yield* device!.changeReplyVolume("kitchen-display", "quieter"), { level: 0.8, atLimit: false })
      assert.strictEqual(kit.phrases.volume("kitchen-display"), 0.8)
      assert.strictEqual(device!.replyVolume("kitchen-display"), 0.8)
      assert.strictEqual(yield* session!.repeatLast("kitchen-display"), false)
      kit.phrases.replied("kitchen-display", "It is ten.")
      assert.strictEqual(yield* session!.repeatLast("kitchen-display"), true)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["It is ten."])
      yield* kit.notify.replying("kitchen-display", true)
      assert.strictEqual(yield* session!.cancelPending("kitchen-display"), true)
      assert.isString(yield* session!.newConversation("kitchen-display"))
      assert.isUndefined(yield* session!.newConversation("nowhere-0001"))
      // The part's lifetime: once the module stopped, the services it kept die with ModuleStopped.
      yield* kit.stop
      const after = yield* Effect.exit(Effect.suspend(() => device!.changeReplyVolume("kitchen-display", "louder")))
      assert.isTrue(after._tag === "Failure")
      assert.strictEqual(kit.phrases.volume("kitchen-display"), 0.8)
    }))
})

describe("a12: the kept reply has serve mode's bound", () => {
  it.effect(`at most ${MAX_KEPT_REPLY_CHARS} characters, whole sentences; a first sentence longer is cut`, () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      kit.phrases.replied("kitchen-display", "x".repeat(2_001))
      assert.strictEqual(said(yield* kit.phrases.say("repeat"))!.length, MAX_KEPT_REPLY_CHARS)
      const sentence = `${"y".repeat(998)}.`
      kit.phrases.replied("kitchen-display", `${sentence} ${sentence} ${sentence}`)
      assert.strictEqual(said(yield* kit.phrases.say("repeat")), `${sentence} ${sentence}`)
      const r = yield* kit.phrases.say("louder", { interrupting: "z".repeat(2_500) })
      assert.strictEqual(said(r)!.length, "That's as loud as I go. ".length + MAX_KEPT_REPLY_CHARS)
    }))
})

describe("E5: a cancelled utterance runs nothing", () => {
  it.effect("no command and no control runs for it", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      const kit = yield* startTestModule(probe(seen))
      assert.deepStrictEqual(yield* kit.phrases.say("fan on", { cancelled: true }), { taken: false })
      assert.deepStrictEqual(yield* kit.phrases.say("louder", { cancelled: true }), { taken: false })
      assert.deepStrictEqual(seen, [])
      assert.strictEqual(kit.phrases.volume("kitchen-display"), 1)
    }))
})
