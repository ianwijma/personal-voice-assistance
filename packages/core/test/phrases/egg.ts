// The tiny module the phrase tests drive (docs/PHRASES.md): actions with phrase commands in both languages, a ring with a
// snooze button whose handler lives in `shared`, and actions that answer at length, fail, hang, or can be refused by the
// risk policy. What each action saw as `CurrentTurn` is recorded.
import { Effect } from "effect"
import { ActionError, defineAction, Param } from "../../src/Actions.ts"
import { defineModule } from "../../src/ModuleDefinition.ts"
import type { ModuleNotify } from "../../src/Notify.ts"
import { CurrentTurn, type TurnContext } from "../../src/TurnContext.ts"

export interface EggParts {
  notify?: ModuleNotify
  turns: Array<TurnContext | undefined>
  snoozes: Array<string>
  runs: Array<string>
}

export const makeEgg = (options: { readonly id?: string; readonly status?: ReadonlyArray<string> } = {}) => {
  const parts: EggParts = { turns: [], snoozes: [], runs: [] }
  const record = (name: string) => Effect.flatMap(CurrentTurn, (t) => Effect.sync(() => {
    parts.turns.push(t)
    parts.runs.push(name)
  }))
  const definition = defineModule({
    apiVersion: 2,
    id: options.id ?? "egg",
    name: "Egg timer",
    description: "Boils eggs.",
    enabledByDefault: false,
    shared: (ctx) =>
      Effect.gen(function*() {
        parts.notify = ctx.notify
        yield* ctx.notify.handle("egg", { run: (press) => Effect.sync(() => (parts.snoozes.push(press.notificationId), { say: "Snoozed." })) }).pipe(Effect.orDie)
        return { value: undefined }
      }),
    start: (ctx) =>
      Effect.succeed({
        actions: [
          defineAction({
            id: "start",
            label: "Start the egg timer",
            description: "Rings when the egg is done.",
            examples: ["egg timer for six minutes", "kookwekker voor zes minuten"],
            params: { length: Param.duration({ label: "Length", minMs: 60_000, maxMs: 1_800_000, optional: true }) },
            phrases: { en: ["egg timer for {length}", "boil an egg"], nl: ["kookwekker voor {length}", "kook een ei"] },
            risk: "change",
            run: ({ length }) =>
              Effect.gen(function*() {
                yield* record("start")
                // Rings at once (a test needs it ringing; a real timer would schedule a job).
                yield* ctx.notify.send({ title: "Egg", priority: "ring", key: "egg", actions: [{ id: "snooze", label: "Snooze" }], handler: "egg" }).pipe(Effect.orDie)
                return { say: `Egg timer for ${Math.round((length ?? 360_000) / 60_000)} minutes.` }
              })
          }),
          defineAction({
            id: "status",
            label: "Egg status",
            description: "How the egg is doing.",
            examples: ["egg status"],
            params: {},
            phrases: { en: [...(options.status ?? ["egg status"])] },
            speculative: true,
            run: () => Effect.as(record("status"), { say: "Still boiling. ".repeat(40) })
          }),
          defineAction({
            id: "tell",
            label: "Tell someone about the egg",
            description: "Tells the household, or someone outside it.",
            examples: ["tell the house the egg is done"],
            params: { who: Param.choice({ label: "Who", options: [{ value: "house", label: "the house" }, { value: "outside", label: "my sister" }] }) },
            phrases: { en: ["tell {who} about the egg"] },
            // `message` (outside the house) is refused by the risk policy; `change` runs.
            risk: { classes: ["change", "message"], of: ({ who }) => (who === "outside" ? "message" : "change") },
            run: () => Effect.as(record("tell"), { say: "Told." })
          }),
          defineAction({
            id: "crack",
            label: "Crack the egg",
            description: "Always fails.",
            examples: ["crack the egg"],
            params: {},
            phrases: { en: ["crack the egg"] },
            risk: "change",
            run: () => Effect.andThen(record("crack"), Effect.fail(new ActionError({ message: "The egg cracked." })))
          }),
          defineAction({
            id: "wait",
            label: "Wait for the egg",
            description: "Never answers.",
            examples: ["wait for the egg"],
            params: {},
            phrases: { en: ["wait for the egg"] },
            risk: "change",
            endsReply: true,
            run: () => Effect.andThen(record("wait"), Effect.never)
          })
        ]
      })
  })
  return { definition, parts }
}
