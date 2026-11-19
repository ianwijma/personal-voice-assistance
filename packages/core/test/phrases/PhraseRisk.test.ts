// P8 and the phrase commands: a phrase command's action takes the same risk decision as the same action called by the
// model (the same class, the same refusal sentence as the spoken one of the intent path), the decision is in the
// phrase's execution trace, an action the policy refuses for every class is still taken as a phrase and refused (never
// "not taken" or "can't now"), a ringing button's press is decided like a press on the card, and the host's own controls
// are never refused.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { defineAction } from "../../src/Actions.ts"
import { defineModule } from "../../src/ModuleDefinition.ts"
import { startTestModule } from "../../src/ModuleTestKit.ts"
import { ECHO_TAIL_MS } from "../../src/EchoGate.ts"
import { makeEgg } from "./egg.ts"

const said = (r: { readonly taken: boolean; readonly outcome?: { readonly said?: string } }) => (r.taken ? r.outcome?.said : undefined)
const did = (r: { readonly taken: boolean; readonly outcome?: { readonly did: string } }) => (r.taken ? r.outcome?.did : "not taken")

const DENY_CHANGE_SPOKEN = "I can't do that: this household doesn't allow me to change things in the house."
const DENY_CHANGE_MODEL = "Not run: it would change something in the house, which this household does not allow."
const CONFIRM_MESSAGE_SPOKEN = "I can't send that: messages need the owner's confirmation, and I can't ask for that yet."

/** A module whose only action is `message` (refused by the default policy for every class it declares). */
const poster = defineModule({
  apiVersion: 2,
  id: "poster",
  name: "Poster",
  description: "Posts notes outside the house.",
  enabledByDefault: false,
  start: () =>
    Effect.succeed({
      actions: [
        defineAction({
          id: "post",
          label: "Post the note",
          description: "Posts the note to a friend.",
          examples: ["post the note"],
          params: {},
          phrases: { en: ["post the note"], nl: ["plaats het briefje"] },
          risk: "message",
          run: () => Effect.succeed({ say: "Posted." })
        })
      ]
    })
})

describe("a phrase command under the household's risk policy", () => {
  it.effect("the same decision as the model's call of the action: refused with the policy's sentence, the decision in the execution trace", () =>
    Effect.gen(function*() {
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition, { household: { risk: { change: "deny" } } })
      const phrase = yield* kit.phrases.say("egg timer for six minutes", { device: "kitchen-display" })
      assert.deepStrictEqual([did(phrase), said(phrase)], ["refused", DENY_CHANGE_SPOKEN])
      assert.deepStrictEqual(egg.parts.runs, [])
      const trace = kit.phrases.traces[kit.phrases.traces.length - 1]!
      assert.deepStrictEqual([trace.by, trace.tool, trace.risk, trace.decision, trace.did], ["command", "egg_start", "change", { outcome: "deny", by: "change" }, "refused"])
      // The model's call of the same action: the same class and decision, the model's sentence.
      const model = yield* kit.tool("egg_start", {}, { device: "kitchen-display" })
      assert.strictEqual(model.content, DENY_CHANGE_MODEL)
      const [byPhrase, byModel] = kit.riskDecisions().slice(-2)
      assert.deepStrictEqual([byPhrase!.outcome, byPhrase!.by, byModel!.outcome, byModel!.by], ["deny", "change", "deny", "change"])
      assert.strictEqual(byPhrase!.name, byModel!.name)
      // Allowed again: the next phrase runs (the policy is read when it runs), and the trace says allow.
      kit.setRiskPolicy({})
      assert.strictEqual(did(yield* kit.phrases.say("egg timer for six minutes", { device: "kitchen-display" })), "ran")
      assert.deepStrictEqual(kit.phrases.traces[kit.phrases.traces.length - 1]!.decision, { outcome: "allow", by: "change" })
    }))

  it.effect("an action refused for every class it declares is still taken as a phrase and refused with its sentence (not handed to the model)", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(poster)
      assert.isFalse(kit.toolNames().includes("poster_post"), "the model is not offered it")
      const r = yield* kit.phrases.say("post the note")
      assert.deepStrictEqual([did(r), said(r)], ["refused", CONFIRM_MESSAGE_SPOKEN])
      assert.deepStrictEqual(kit.phrases.traces[kit.phrases.traces.length - 1]!.decision, { outcome: "confirm", by: "message" })
      // Allowed: it runs.
      kit.setRiskPolicy({ message: "allow" })
      assert.deepStrictEqual([did(yield* kit.phrases.say("post the note")), said(yield* kit.phrases.say("post the note"))], ["ran", "Posted."])
    }))

  it.effect("in Dutch, the refusal is the policy's Dutch sentence", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(poster, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(said(yield* kit.phrases.say("plaats het briefje")), "Dat kan ik niet versturen: berichten moet de eigenaar eerst bevestigen, en daar kan ik nog niet om vragen.")
    }))

  it.effect("a ringing button's press is decided like a press on the card; 'stop' and the other host controls are never refused", () =>
    Effect.gen(function*() {
      const egg = makeEgg()
      const kit = yield* startTestModule(egg.definition)
      yield* kit.phrases.say("boil an egg", { device: "kitchen-display" })
      yield* kit.advance(ECHO_TAIL_MS)
      // Everything the owner can set is refused now.
      kit.setRiskPolicy({ read: "deny", change: "deny", message: "deny" })
      const snooze = yield* kit.phrases.say("snooze", { device: "kitchen-display", wake: false })
      assert.deepStrictEqual([did(snooze), said(snooze)], ["refused", DENY_CHANGE_SPOKEN])
      assert.deepStrictEqual(egg.parts.snoozes, [])
      assert.deepStrictEqual(kit.riskDecisions().filter((d) => d.principal === "notification").map((d) => [d.name, d.outcome, d.by]), [["egg/egg", "deny", "change"]])
      // The host's "stop" stops the ring (once the refusal's echo tail is over, the window takes it again).
      yield* kit.advance(ECHO_TAIL_MS)
      assert.strictEqual(did(yield* kit.phrases.say("stop", { device: "kitchen-display", wake: false })), "stopped-ring")
      // The other controls run (none is refused, none reaches the gateway).
      const before = kit.riskDecisions().length
      for (const control of ["never mind", "repeat", "louder", "quieter", "stop"]) {
        assert.notStrictEqual(did(yield* kit.phrases.say(control, { device: "kitchen-display" })), "refused", control)
      }
      assert.strictEqual(kit.riskDecisions().length, before)
    }))
})
