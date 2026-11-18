// docs/MODULES.md "Notifications and announcements" quotes this file: a module that rings when the kettle is done, with
// a snooze whose handler lives in `shared`, and says it in the kitchen; and its test through the kit.
import { assert, describe, it } from "@effect/vitest"
import { defineModule, makeTool } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect, Schema } from "effect"
import { defineTexts, homeLanguage, say } from "../../src/index.ts"

// #region notify-module
const kettleTexts = defineTexts({
  en: { done: "The kettle has boiled", snooze: "Snooze", snoozed: "I'll remind you in five minutes.", started: "I'll tell you when it has boiled.", failed: "I couldn't set that reminder." },
  nl: { done: "Het water kookt", snooze: "Later", snoozed: "Over vijf minuten zeg ik het nog eens.", started: "Ik zeg het als het water kookt.", failed: "Die herinnering kon ik niet zetten." }
})

export const kettleModule = defineModule({
  apiVersion: 2,
  id: "kettle",
  name: "Kettle",
  description: "Rings when the kettle has boiled.",
  enabledByDefault: false,
  shared: (ctx) =>
    Effect.gen(function*() {
      // An action handler is registered in `shared`, like a job handler: published and withdrawn with the module.
      // While the module is down, its actions answer "I can't do that right now"; `stop` always works.
      yield* ctx.notify.handle("kettle", {
        run: (press) =>
          Effect.gen(function*() {
            const lang = homeLanguage(ctx.host.view())
            // Runs as the press (its device is the origin). This one ends now, so its key is free for the next.
            yield* ctx.notify.resolve(press.notificationId, "snooze")
            yield* ctx.notify.send({
              title: say(kettleTexts, lang, "done"),
              priority: "ring",
              key: "kettle",
              inMs: 5 * 60_000,
              actions: [{ id: "snooze", label: say(kettleTexts, lang, "snooze") }],
              handler: "kettle"
            })
            return { say: say(kettleTexts, lang, "snoozed") }
          }).pipe(Effect.orElseSucceed(() => ({ say: say(kettleTexts, homeLanguage(ctx.host.view()), "failed"), keepOpen: true })))
      }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: (ctx) =>
    Effect.succeed({
      tools: [makeTool({
        name: "kettle_watch",
        description: "Ring on this device when the kettle has boiled (in about three minutes).",
        parameters: Schema.Struct({}),
        risk: "change",
        execute: () =>
          Effect.gen(function*() {
            const lang = homeLanguage(ctx.host.view())
            // One transaction and an enqueue: fine on a turn. Sent later by the service's own scheduler job.
            yield* ctx.notify.send({
              title: say(kettleTexts, lang, "done"),
              priority: "ring",
              key: "kettle",
              inMs: 3 * 60_000,
              actions: [{ id: "snooze", label: say(kettleTexts, lang, "snooze") }],
              handler: "kettle"
            })
            // An announcement in the room, after whatever is being said there. Inside a turn, never wait for `done`.
            yield* ctx.speech.say({ room: "Kitchen" }, say(kettleTexts, lang, "started"), { cue: true })
            return { spoken: say(kettleTexts, lang, "started") }
          }).pipe(
            Effect.catchTag("NotifyError", () => Effect.succeed({ spoken: say(kettleTexts, homeLanguage(ctx.host.view()), "failed") })),
            // No device in the kitchen, or none that may speak: the ring still comes.
            Effect.catchTag("SpeechError", () => Effect.succeed({ spoken: say(kettleTexts, homeLanguage(ctx.host.view()), "started") }))
          )
      })]
    })
})
// #endregion notify-module

describe("the kettle (docs/MODULES.md)", () => {
  it.effect("rings on the device that asked when it is due; snooze rings again five minutes later", () =>
    Effect.gen(function*() {
      // #region notify-test
      const kit = yield* startTestModule(kettleModule)
      yield* kit.tool("kettle_watch", {}, { device: "kitchen-display" })
      // The announcement went to the kitchen's device; nothing rings yet.
      yield* kit.advance(2_000)
      assert.deepStrictEqual(kit.notify.announced.map((a) => [a.deviceId, a.text]), [["kitchen-display", "I'll tell you when it has boiled."]])
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      // Three minutes later it rings there, with stop and snooze.
      yield* kit.advance(3 * 60_000)
      const [ringing] = kit.notify.engine.ringingOn("kitchen-display")
      assert.deepStrictEqual(ringing?.actions.map((a) => a.id), ["snooze"])
      // Snooze, as a press on the card: the module's handler answers, and it rings again five minutes later.
      assert.deepStrictEqual(yield* kit.notify.press(ringing!.id, "snooze", { device: "kitchen-display" }), { ok: true, say: "I'll remind you in five minutes." })
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      yield* kit.advance(5 * 60_000)
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
      // Why it went where it went: every decision is recorded.
      assert.isTrue(kit.notify.decisions.every((d) => d.deviceId === "kitchen-display" && d.decision.deliver))
      // #endregion notify-test
    }))
})
