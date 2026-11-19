// The module through the real host, gateway and kit (docs/MODULES.md §17): every tool and action on its ordinary path and
// its refusals, in both languages, the phrase commands through the real matcher and runner, devices that do not share a
// level, a provider that is not there, stops or fails, and what the module promises it does not do (store, schedule).
import { assert, describe, it } from "@effect/vitest"
import { checkModule, expectOffByDefault, startTestModule } from "@pva/core/testing"
import { ModuleStopped, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"
import { assistantControlsModule, catalog, gainOfLevel, stepOfGain, texts } from "../src/index.ts"

const NL = { household: { home: { HOME_LANGUAGE: "nl-NL" } } } as const
const spoken = (r: { readonly value: unknown }) => (r.value as { readonly spoken: string }).spoken

/** The module with the core's services replaced (a CLI mode has none; a provider may stop or fail while called). */
const withServices = (service: (key: unknown) => unknown): ModuleDefinition<any> => ({
  ...assistantControlsModule,
  start: (ctx: any) => assistantControlsModule.start!({ ...ctx, host: { ...ctx.host, service } } as never)
})

describe("@pva/module-assistant-controls", () => {
  it.effect("accepted by the host, off by default, conformant, texts in both languages", () =>
    Effect.gen(function*() {
      yield* expectOffByDefault(catalog)
      for (const definition of catalog) yield* checkModule(definition, { texts })
    }))

  it.effect("offers its tools to the model, and the two phrase actions only as phrases", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(assistantControlsModule)
      assert.deepStrictEqual([...kit.toolNames()].sort(), [
        "controls_cancel_pending",
        "controls_get_volume",
        "controls_louder",
        "controls_new_conversation",
        "controls_quieter",
        "controls_repeat_last",
        "controls_set_volume",
        "controls_stop_reply"
      ])
      // Nothing stored and nothing scheduled: the module's promise on its page.
      assert.deepStrictEqual(yield* kit.jobs, [])
      assert.isUndefined(assistantControlsModule.storage)
      assert.isUndefined(assistantControlsModule.shared)
    }))

  describe("tools", () => {
    it.effect("stop the reply: what was stopped, and that there was nothing", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        yield* kit.notify.replying("kitchen-display", true)
        assert.strictEqual(spoken(yield* kit.tool("controls_stop_reply", {}, { device: "kitchen-display" })), "Stopped.")
        assert.strictEqual(spoken(yield* kit.tool("controls_stop_reply", {}, { device: "kitchen-display" })), "There was nothing to stop.")
        assert.deepStrictEqual(kit.phrases.sessionCalls.map((c) => [c.deviceId, c.call]), [["kitchen-display", "stop"], ["kitchen-display", "stop"]])
      }))

    it.effect("cancel what is pending: on the asking device only", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        yield* kit.notify.replying("kitchen-display", true)
        assert.strictEqual(spoken(yield* kit.tool("controls_cancel_pending", {}, { device: "robins-phone" })), "There was nothing pending.")
        assert.strictEqual(spoken(yield* kit.tool("controls_cancel_pending", {}, { device: "kitchen-display" })), "Cancelled.")
        assert.deepStrictEqual(kit.phrases.sessionCalls.map((c) => [c.deviceId, c.call]), [["robins-phone", "cancel"], ["kitchen-display", "cancel"]])
      }))

    it.effect("repeat the last reply of this device only: another device's reply is not said here", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        assert.strictEqual(spoken(yield* kit.tool("controls_repeat_last", {}, { device: "kitchen-display" })), "I haven't said anything yet.")
        kit.phrases.replied("robins-phone", "Your appointment is at three.")
        // The public hall screen has said nothing: Robin's private reply is never repeated there.
        assert.strictEqual(spoken(yield* kit.tool("controls_repeat_last", {}, { device: "hall-screen" })), "I haven't said anything yet.")
        assert.deepStrictEqual(kit.phrases.spoken, [])
        assert.strictEqual(spoken(yield* kit.tool("controls_repeat_last", {}, { device: "robins-phone" })), "Saying it again.")
        assert.deepStrictEqual(kit.phrases.spoken.map((s) => [s.deviceId, s.text]), [["robins-phone", "Your appointment is at three."]])
      }))

    it.effect("a new conversation for the asking device", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        assert.strictEqual(spoken(yield* kit.tool("controls_new_conversation", {}, { device: "kitchen-display" })), "Starting a new conversation.")
      }))

    it.effect("set the volume to a level: the step it lands on is said, a level that is the step already changes nothing", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        const set = (level: number) => kit.tool("controls_set_volume", { level }, { device: "kitchen-display" })
        assert.strictEqual(spoken(yield* set(7)), "Volume 4 of 5.")
        assert.strictEqual(kit.phrases.volume("kitchen-display"), 0.8)
        // 8 shares the step with 7: nothing changes, and it says so instead of "set".
        assert.strictEqual(spoken(yield* set(8)), "The volume is already 4 of 5.")
        assert.strictEqual(kit.phrases.volumeSends.length, 1)
        assert.strictEqual(spoken(yield* set(1)), "Volume 1 of 5.")
        assert.strictEqual(kit.phrases.volume("kitchen-display"), 0.2)
        assert.strictEqual(spoken(yield* set(10)), "Volume 5 of 5.")
        assert.strictEqual(kit.phrases.volume("kitchen-display"), 1)
        assert.deepStrictEqual(kit.phrases.volumeSends.map((s) => s.volume), [0.8, 0.2, 1])
      }))

    it("the mapping from a spoken level to a step: two levels to a step, and back", () => {
      assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((l) => stepOfGain(gainOfLevel(l))), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
      assert.deepStrictEqual([0, 0.2, 0.4, 0.6, 0.8, 1, 7].map(stepOfGain), [1, 1, 2, 3, 4, 5, 5])
    })

    it.effect("the levels the service really has are the ones assumed: five steps from 0.2 to 1", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        const seen: Array<number> = []
        for (let l = 1; l <= 10; l += 2) {
          yield* kit.tool("controls_set_volume", { level: l }, { device: "kitchen-display" })
          seen.push(kit.phrases.volume("kitchen-display"))
        }
        assert.deepStrictEqual(seen, [0.2, 0.4, 0.6, 0.8, 1])
      }))

    it.effect("a level outside 1 to 10 or not a whole number is refused before anything runs", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        for (const level of [0, 11, -3, 2.5]) {
          const r = yield* kit.tool("controls_set_volume", { level }, { device: "kitchen-display" })
          assert.isFalse(r.ok)
        }
        assert.deepStrictEqual(kit.phrases.volumeSends, [])
      }))

    it.effect("louder and quieter by a step, and what is said at each limit", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        const d = { device: "kitchen-display" }
        assert.strictEqual(spoken(yield* kit.tool("controls_louder", {}, d)), "That's as loud as I go.")
        assert.strictEqual(spoken(yield* kit.tool("controls_quieter", {}, d)), "Quieter: volume 4 of 5.")
        assert.strictEqual(spoken(yield* kit.tool("controls_louder", {}, d)), "Louder: volume 5 of 5.")
        for (let i = 0; i < 4; i++) yield* kit.tool("controls_quieter", {}, d)
        assert.strictEqual(kit.phrases.volume("kitchen-display"), 0.2)
        assert.strictEqual(spoken(yield* kit.tool("controls_quieter", {}, d)), "That's as quiet as I go.")
        // A limit changes nothing and sends nothing more.
        assert.strictEqual(kit.phrases.volumeSends.length, 6)
      }))

    it.effect("what the volume is, a plain read, per device", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        assert.strictEqual(spoken(yield* kit.tool("controls_get_volume", {}, { device: "kitchen-display" })), "The volume is 5 of 5.")
        yield* kit.tool("controls_set_volume", { level: 3 }, { device: "kitchen-display" })
        assert.strictEqual(spoken(yield* kit.tool("controls_get_volume", {}, { device: "kitchen-display" })), "The volume is 2 of 5.")
        // Another device keeps its own level.
        assert.strictEqual(spoken(yield* kit.tool("controls_get_volume", {}, { device: "robins-phone" })), "The volume is 5 of 5.")
      }))

    it.effect("two devices asking at once keep their own levels, and no change is lost or doubled", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        yield* Effect.all([
          kit.tool("controls_quieter", {}, { device: "kitchen-display" }),
          kit.tool("controls_quieter", {}, { device: "kitchen-display" }),
          kit.tool("controls_quieter", {}, { device: "robins-phone" }),
          kit.tool("controls_set_volume", { level: 3 }, { device: "hall-screen" })
        ], { concurrency: "unbounded" })
        assert.deepStrictEqual(["kitchen-display", "robins-phone", "hall-screen"].map((d) => kit.phrases.volume(d)), [0.6, 0.8, 0.4])
      }))

    it.effect("in Dutch, every sentence, limits and failures included", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule, NL)
        const d = { device: "kitchen-display" }
        assert.strictEqual(spoken(yield* kit.tool("controls_stop_reply", {}, d)), "Er was niets om te stoppen.")
        assert.strictEqual(spoken(yield* kit.tool("controls_cancel_pending", {}, d)), "Er was niets aan de hand.")
        assert.strictEqual(spoken(yield* kit.tool("controls_repeat_last", {}, d)), "Ik heb nog niets gezegd.")
        assert.strictEqual(spoken(yield* kit.tool("controls_new_conversation", {}, d)), "Ik begin een nieuw gesprek.")
        assert.strictEqual(spoken(yield* kit.tool("controls_louder", {}, d)), "Harder kan ik niet.")
        assert.strictEqual(spoken(yield* kit.tool("controls_quieter", {}, d)), "Zachter: volume 4 van 5.")
        assert.strictEqual(spoken(yield* kit.tool("controls_set_volume", { level: 1 }, d)), "Volume 1 van 5.")
        assert.strictEqual(spoken(yield* kit.tool("controls_set_volume", { level: 2 }, d)), "Het volume staat al op 1 van 5.")
        assert.strictEqual(spoken(yield* kit.tool("controls_get_volume", {}, d)), "Het volume staat op 1 van 5.")
        assert.strictEqual(spoken(yield* kit.tool("controls_quieter", {}, d)), "Zachter kan ik niet.")
      }))
  })

  describe("phrase commands", () => {
    it.effect("a new conversation by phrase: no model, one canned answer, the cut-off reply is not said again", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        const r = yield* kit.phrases.say("start a new conversation", { device: "kitchen-display", interrupting: "It is sunny and", interruptedBy: "jeff" })
        assert.isTrue(r.taken && r.by === "command")
        assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["Starting a new conversation."])
        for (const phrase of ["new conversation", "start over", "new chat"]) assert.isTrue((yield* kit.phrases.say(phrase)).taken)
      }))

    it.effect("a new conversation in Dutch", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule, NL)
        assert.isTrue((yield* kit.phrases.say("nieuw gesprek")).taken)
        assert.isTrue((yield* kit.phrases.say("begin opnieuw")).taken)
        assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["Ik begin een nieuw gesprek.", "Ik begin een nieuw gesprek."])
        // The other language's phrase is not this household's.
        assert.deepStrictEqual(yield* kit.phrases.say("new conversation"), { taken: false })
      }))

    it.effect("the volume to a level: a spoken number, in words or digits, on the device that heard it", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        const one = yield* kit.phrases.say("volume seven", { device: "kitchen-display", interrupting: "The weather is", interruptedBy: "jeff" })
        assert.isTrue(one.taken && one.by === "command")
        assert.strictEqual(kit.phrases.volume("kitchen-display"), 0.8)
        assert.strictEqual(kit.phrases.spoken.at(-2)?.text, "Volume 4 of 5.")
        assert.isTrue((yield* kit.phrases.say("set the volume to 3", { device: "robins-phone" })).taken)
        assert.strictEqual(kit.phrases.volume("robins-phone"), 0.4)
        assert.strictEqual(kit.phrases.volume("kitchen-display"), 0.8)
        // The same step again says so.
        yield* kit.phrases.say("volume to eight", { device: "kitchen-display" })
        assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "The volume is already 4 of 5.")
      }))

    it.effect("the volume to a level in Dutch", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule, NL)
        assert.isTrue((yield* kit.phrases.say("zet het volume op zes")).taken)
        assert.strictEqual(kit.phrases.volume("kitchen-display"), 0.6)
        assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Volume 3 van 5.")
        assert.isTrue((yield* kit.phrases.say("volume op 10")).taken)
        assert.strictEqual(kit.phrases.volume("kitchen-display"), 1)
      }))

    it.effect("a level outside the range, a word that is no number, and the host's own louder and quieter are not this command", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        for (const text of ["volume eleven", "volume zero", "volume 2.5", "volume loud", "volume 11"]) {
          assert.deepStrictEqual(yield* kit.phrases.say(text), { taken: false })
        }
        const up = yield* kit.phrases.say("volume up")
        assert.isTrue(up.taken && up.by === "control")
        assert.deepStrictEqual(kit.phrases.volumeSends.map((s) => s.volume), [])
      }))

    it.effect("the commands are in the set of an assistant that has the module on, and not of one that switched them off", () =>
      Effect.gen(function*() {
        const on = yield* startTestModule(assistantControlsModule)
        assert.isTrue((yield* on.phrases.say("volume five")).taken)
        const off = yield* startTestModule(assistantControlsModule, {
          household: { assistants: [{ id: "jeff", modules: { "assistant-controls": { offTools: ["assistant-controls_set_volume"] } } }] }
        })
        assert.deepStrictEqual(yield* off.phrases.say("volume five"), { taken: false })
        assert.isTrue((yield* off.phrases.say("new conversation")).taken)
      }))

    it.effect("through the actions as a routine runs them", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(assistantControlsModule)
        assert.deepStrictEqual(yield* kit.action("set_volume", { level: 6 }, { device: "kitchen-display" }), { ok: true, say: "Volume 3 of 5." })
        assert.deepStrictEqual(yield* kit.action("new_conversation", {}, { device: "kitchen-display" }), { ok: true, say: "Starting a new conversation." })
      }))
  })

  describe("when the core's services are not there", () => {
    it.effect("a mode without them (the CLI modes): every control says it cannot be done here, in both languages", () =>
      Effect.gen(function*() {
        const en = yield* startTestModule(withServices(() => undefined))
        for (const tool of ["controls_stop_reply", "controls_cancel_pending", "controls_repeat_last", "controls_new_conversation", "controls_louder", "controls_quieter", "controls_get_volume"]) {
          const r = yield* en.tool(tool, {}, { device: "kitchen-display" })
          assert.isFalse(r.ok)
          assert.include(JSON.stringify(r.content), "I can't do that here.")
        }
        const set = yield* en.tool("controls_set_volume", { level: 4 }, { device: "kitchen-display" })
        assert.include(JSON.stringify(set.content), "I can't do that here.")
        const nl = yield* startTestModule(withServices(() => undefined), NL)
        assert.include(JSON.stringify((yield* nl.tool("controls_louder", {}, { device: "kitchen-display" })).content), "Dat kan ik hier niet.")
        // A phrase says the same.
        yield* en.phrases.say("new conversation")
        assert.deepStrictEqual(en.phrases.spoken.map((s) => s.text), ["I can't do that here."])
      }))

    it.effect("a provider that stops during the call is the same as one that is off; a defect says it failed and the module runs on", () =>
      Effect.gen(function*() {
        const stops = { stopReply: () => Effect.die(new ModuleStopped({ message: "stopped" })) }
        const kit = yield* startTestModule(withServices((key) => ((key as { id: string }).id === "core.session-control" ? stops : undefined)))
        assert.include(JSON.stringify((yield* kit.tool("controls_stop_reply", {}, { device: "kitchen-display" })).content), "I can't do that here.")
        const breaks = { stopReply: () => Effect.die(new Error("boom")) }
        const broken = yield* startTestModule(withServices((key) => ((key as { id: string }).id === "core.session-control" ? breaks : undefined)))
        const r = yield* broken.tool("controls_stop_reply", {}, { device: "kitchen-display" })
        assert.isFalse(r.ok)
        assert.include(JSON.stringify(r.content), "That didn't work. Try again in a moment.")
        assert.notInclude(JSON.stringify(r.content), "boom")
        // The module is still up: another tool answers.
        assert.include(JSON.stringify((yield* broken.tool("controls_louder", {}, { device: "kitchen-display" })).content), "I can't do that here.")
      }))
  })
})
