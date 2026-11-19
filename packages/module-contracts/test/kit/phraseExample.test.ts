// docs/MODULES.md "Phrase commands" quotes this file: a module whose action can be said as a phrase command after the
// wake phrase (no language model), in English and Dutch, with a slot; and its test through the kit.
import { assert, describe, it } from "@effect/vitest"
import { defineAction, defineModule, Param } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { defineTexts, homeLanguage, say } from "../../src/index.ts"

// #region phrase-module
const lampTexts = defineTexts({
  en: { on: "The {room} lamp is on.", off: "The {room} lamp is off." },
  nl: { on: "De lamp in de {room} is aan.", off: "De lamp in de {room} is uit." }
})
const rooms = [{ value: "kitchen", label: "kitchen", aliases: ["keuken"] }, { value: "hall", label: "hall", aliases: ["gang"] }]

export const lampModule = defineModule({
  apiVersion: 2,
  id: "lamp",
  name: "Lamp",
  description: "Switches a room's lamp.",
  enabledByDefault: false,
  start: (ctx) =>
    Effect.succeed({
      actions: [defineAction({
        id: "switch",
        label: "Switch a lamp",
        description: "Switch the lamp in a room on or off.",
        examples: ["kitchen lamp on", "lamp uit in de keuken"],
        params: {
          // A slot reads a fixed choice (at most 32 options, prepared when the set is built), a number, a duration or text;
          // never a list the module fills while it runs (take such a name as text and resolve it in `run`).
          room: Param.choice({ label: "Room", options: rooms }),
          to: Param.choice({ label: "On or off", options: [{ value: "on", label: "on", aliases: ["aan"] }, { value: "off", label: "off", aliases: ["uit"] }] })
        },
        // Said after the wake phrase (or in a follow-up window), these run the action with no model call. Words are
        // matched exactly; each slot is read by its parameter's parser (a room by value, name or alias, on/off by label).
        phrases: { en: ["{room} lamp {to}", "turn the {room} lamp {to}"], nl: ["lamp {to} in de {room}"] },
        risk: "change",
        run: ({ room, to }) =>
          Effect.succeed({ say: say(lampTexts, homeLanguage(ctx.host.view()), to, { room: rooms.find((r) => r.value === room)?.label ?? room }) })
      })]
    })
})
// #endregion phrase-module

describe("the lamp (docs/MODULES.md)", () => {
  it.effect("a phrase after the wake phrase runs the action as a phrase turn of that device, and its answer is spoken", () =>
    Effect.gen(function*() {
      // #region phrase-test
      const kit = yield* startTestModule(lampModule)
      // As the recogniser's final after "hey Jeff": the kit decides as serve mode does, and runs it through the gateway.
      const said = yield* kit.phrases.say("Turn the kitchen lamp on.", { device: "kitchen-display" })
      assert.isTrue(said.taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["The kitchen lamp is on."])
      // Words that are not one of its phrases are not taken: they go on to the assistant as a turn.
      assert.deepStrictEqual(yield* kit.phrases.say("is the kitchen lamp on?"), { taken: false })
      // The host's controls are there for every assistant, whatever modules it has.
      const louder = yield* kit.phrases.say("louder")
      assert.isTrue(louder.taken && louder.by === "control")
      // #endregion phrase-test
    }))

  it.effect("in a Dutch household the Dutch phrases match, with the aliases of the slots", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(lampModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      yield* kit.phrases.say("lamp uit in de gang")
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["De lamp in de hall is uit."])
    }))
})
