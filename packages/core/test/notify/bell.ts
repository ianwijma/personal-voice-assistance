// The tiny module the notification tests drive (like the guide's reference module, but only what P9 adds): a ring with
// a snooze action whose handler lives in `shared`, a plain notification, and an announcement that may wait.
import { Effect, Schema } from "effect"
import { makeTool } from "../../src/Module.ts"
import { defineModule } from "../../src/ModuleDefinition.ts"
import type { ActionPress, ModuleNotify, ModuleSpeech, SpeechTarget } from "../../src/Notify.ts"
import { notifyLanguageOf, notifyRefusalText } from "../../src/NotifyTexts.ts"

/** What the module's shared part was given, so a test can call the service as code outside a turn does. */
export interface BellParts {
  notify?: ModuleNotify
  speech?: ModuleSpeech
  presses: Array<ActionPress>
  /** How the handler answers (a test may make it fail or wait). */
  answer: (press: ActionPress) => Effect.Effect<{ readonly say?: string; readonly keepOpen?: boolean } | void, unknown>
}

export const makeBell = (options: { readonly handler?: boolean } = {}) => {
  const parts: BellParts = {
    presses: [],
    answer: (press) => Effect.succeed(press.actionId === "snooze" ? { say: "Snoozed for five minutes." } : undefined)
  }
  const definition = defineModule({
    apiVersion: 2,
    id: "bell",
    name: "Bell",
    description: "Rings a bell and says things.",
    enabledByDefault: false,
    shared: (ctx) =>
      Effect.gen(function*() {
        parts.notify = ctx.notify
        parts.speech = ctx.speech
        if (options.handler !== false) {
          yield* ctx.notify.handle("answer", {
            run: (press) =>
              Effect.suspend(() => {
                parts.presses.push(press)
                return parts.answer(press)
              })
          }).pipe(Effect.orDie)
        }
        return { value: undefined }
      }),
    start: (ctx) =>
      Effect.succeed({
        tools: [
          makeTool({
            name: "bell_ring",
            description: "Ring the bell.",
            parameters: Schema.Struct({
              title: Schema.String,
              text: Schema.optionalKey(Schema.String),
              ring: Schema.optionalKey(Schema.Boolean),
              everywhere: Schema.optionalKey(Schema.Boolean),
              owner: Schema.optionalKey(Schema.String),
              key: Schema.optionalKey(Schema.String),
              inMs: Schema.optionalKey(Schema.Int),
              snooze: Schema.optionalKey(Schema.Boolean)
            }),
            risk: "change",
            execute: (i) =>
              ctx.notify.send({
                title: i.title,
                ...(i.text !== undefined ? { text: i.text } : {}),
                priority: i.ring === true ? "ring" : "normal",
                target: i.everywhere === true ? "everywhere" : "origin",
                ...(i.owner !== undefined ? { owner: i.owner } : {}),
                ...(i.key !== undefined ? { key: i.key } : {}),
                ...(i.inMs !== undefined ? { inMs: i.inMs } : {}),
                ...(i.snooze !== false && options.handler !== false ? { actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" } : {})
              }).pipe(
                Effect.map((r) => ({ id: r.notification.id, deduped: r.deduped, state: r.notification.state })),
                Effect.catchTag("NotifyError", (e) => Effect.succeed({ refused: e.reason, said: notifyRefusalText(notifyLanguageOf(ctx.host.view().home.HOME_LANGUAGE), e) }))
              )
          }),
          makeTool({
            name: "bell_say",
            description: "Say something somewhere.",
            parameters: Schema.Struct({
              text: Schema.String,
              device: Schema.optionalKey(Schema.String),
              room: Schema.optionalKey(Schema.String),
              wait: Schema.optionalKey(Schema.Boolean)
            }),
            risk: "change",
            execute: (i) =>
              Effect.gen(function*() {
                const target: SpeechTarget = i.device !== undefined ? { device: i.device } : i.room !== undefined ? { room: i.room } : "everywhere"
                const handle = yield* ctx.speech.say(target, i.text)
                if (i.wait === true) yield* handle.done
                return { deliveries: handle.deliveries }
              }).pipe(Effect.catchTag("SpeechError", (e) => Effect.succeed({ refused: e.reason, said: notifyRefusalText("en", e) })))
          })
        ]
      })
  })
  return { definition, parts }
}
