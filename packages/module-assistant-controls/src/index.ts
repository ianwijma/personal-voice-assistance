import {
  ActionError,
  CurrentTurn,
  defineAction,
  defineModule,
  DeviceControl,
  type DeviceControlService,
  type ModuleDefinition,
  type ModuleHostApi,
  makeTool,
  Param,
  SessionControl,
  type SessionControlService,
  ToolError
} from "@pva/core"
import { speakNumber } from "@pva/language"
import { defineTexts, homeLanguage, type ProviderOff, say, useService } from "@pva/module-contracts"
import { Data, Effect, Schema } from "effect"

/**
 * Assistant controls (docs/modules/assistant-controls.md): the host's spoken controls (stop, never mind, repeat, louder,
 * quieter) as tools for free phrasing, and phrase commands for what the host does not take: a new conversation and the
 * volume to a level. It acts only through the core's `SessionControl` and `DeviceControl`, on the device of the turn
 * that asked. It stores nothing, schedules nothing and keeps nothing of the host past a call.
 */

/**
 * The reply volume as `DeviceControl` has it (docs/PHRASES.md "Louder and quieter": 0.2 to 1 in steps of 0.2): five
 * steps. `@pva/protocol` owns the numbers and is not a dependency of a module, so they are written once here, and the
 * test pins them against the service itself.
 */
const STEP_GAIN = 0.2
const STEPS = 5

/** What a person says is a level from 1 to 10 (as most assistants have it); two spoken levels share a step: 1–2 is the quietest, 9–10 the loudest. */
const LEVEL_MIN = 1
const LEVEL_MAX = 10

/** The gain a spoken level asks for: its step (1–2 → 1, 3–4 → 2, … 9–10 → 5) times the step's size. */
export const gainOfLevel = (level: number): number => Math.round(Math.ceil(level / 2) * STEP_GAIN * 100) / 100

/** The step (1 to `STEPS`) a gain is: never 0, whatever the service answered. */
export const stepOfGain = (gain: number): number => Math.min(STEPS, Math.max(1, Math.round(gain / STEP_GAIN)))

export const texts = defineTexts({
  en: {
    stopped: "Stopped.",
    nothingToStop: "There was nothing to stop.",
    cancelled: "Cancelled.",
    nothingPending: "There was nothing pending.",
    repeating: "Saying it again.",
    nothingToRepeat: "I haven't said anything yet.",
    newConversation: "Starting a new conversation.",
    volumeSet: "Volume {step} of {steps}.",
    volumeAlready: "The volume is already {step} of {steps}.",
    volumeIs: "The volume is {step} of {steps}.",
    louder: "Louder: volume {step} of {steps}.",
    quieter: "Quieter: volume {step} of {steps}.",
    tooLoud: "That's as loud as I go.",
    tooQuiet: "That's as quiet as I go.",
    badLevel: "Say a volume from {min} to {max}.",
    noDevice: "I can't tell which device that is for.",
    unavailable: "I can't do that here.",
    failed: "That didn't work. Try again in a moment."
  },
  nl: {
    stopped: "Gestopt.",
    nothingToStop: "Er was niets om te stoppen.",
    cancelled: "Geannuleerd.",
    nothingPending: "Er was niets aan de hand.",
    repeating: "Ik zeg het nog eens.",
    nothingToRepeat: "Ik heb nog niets gezegd.",
    newConversation: "Ik begin een nieuw gesprek.",
    volumeSet: "Volume {step} van {steps}.",
    volumeAlready: "Het volume staat al op {step} van {steps}.",
    volumeIs: "Het volume staat op {step} van {steps}.",
    louder: "Harder: volume {step} van {steps}.",
    quieter: "Zachter: volume {step} van {steps}.",
    tooLoud: "Harder kan ik niet.",
    tooQuiet: "Zachter kan ik niet.",
    badLevel: "Zeg een volume van {min} tot {max}.",
    noDevice: "Ik weet niet voor welk apparaat dit is.",
    unavailable: "Dat kan ik hier niet.",
    failed: "Dat lukte niet. Probeer het zo nog eens."
  }
})

/** A control that could not be carried out; `message` is spoken (a tool's error, an action's error). */
class ControlFailure extends Data.TaggedError("ControlFailure")<{ readonly message: string }> {}

type Lang = "en" | "nl"

/** A number for the speech synthesiser in the household's language ("3"; never undefined for 1 to 10). */
const num = (n: number, lang: Lang): string => speakNumber(n, lang) ?? String(n)

/**
 * The one place that runs a control: the device is the turn's own (never a parameter: a tool cannot act on another
 * device), the core's service is looked up now, and the sentence is chosen after the answer. A provider that is not
 * there (CLI modes) or stopped during the call says `unavailable`; a defect says `failed`.
 */
const makeControls = (host: ModuleHostApi) => {
  const language = (): Lang => homeLanguage(host.view())
  const run = (use: (deviceId: string, lang: Lang) => Effect.Effect<string, ProviderOff>) =>
    Effect.gen(function*() {
      const lang = language()
      const turn = yield* CurrentTurn
      const deviceId = turn?.deviceId
      if (deviceId === undefined) return yield* Effect.fail(new ControlFailure({ message: say(texts, lang, "noDevice") }))
      return yield* use(deviceId, lang)
    }).pipe(
      Effect.catchDefect(() => Effect.fail(new ControlFailure({ message: say(texts, language(), "failed") }))),
      Effect.catchTag("ProviderOff", () => Effect.fail(new ControlFailure({ message: say(texts, language(), "unavailable") })))
    ) as Effect.Effect<string, ControlFailure>

  const session = <T>(use: (service: SessionControlService) => Effect.Effect<T>) => useService(host, SessionControl, use)
  const device = <T>(use: (service: DeviceControlService) => Effect.Effect<T>) => useService(host, DeviceControl, use)

  const stop = run((id, lang) =>
    session((s) => s.stopReply(id)).pipe(Effect.map((did) => say(texts, lang, did ? "stopped" : "nothingToStop")))
  )
  const cancel = run((id, lang) =>
    session((s) => s.cancelPending(id)).pipe(Effect.map((did) => say(texts, lang, did ? "cancelled" : "nothingPending")))
  )
  const repeat = run((id, lang) =>
    // The service speaks it itself, as a canned reply of the assistant that said it; this sentence only reports.
    session((s) => s.repeatLast(id)).pipe(Effect.map((did) => say(texts, lang, did ? "repeating" : "nothingToRepeat")))
  )
  const newConversation = run((id, lang) =>
    session((s) => s.newConversation(id)).pipe(Effect.map((conversation) => say(texts, lang, conversation === undefined ? "noDevice" : "newConversation")))
  )
  const volumeIs = run((id, lang) =>
    device((d) => Effect.sync(() => d.replyVolume(id))).pipe(Effect.map((gain) => say(texts, lang, "volumeIs", { step: num(stepOfGain(gain), lang), steps: num(STEPS, lang) })))
  )
  const step = (direction: "louder" | "quieter") =>
    run((id, lang) =>
      device((d) => d.changeReplyVolume(id, direction)).pipe(
        Effect.map((change) =>
          change.atLimit
            ? say(texts, lang, direction === "louder" ? "tooLoud" : "tooQuiet")
            : say(texts, lang, direction, { step: num(stepOfGain(change.level), lang), steps: num(STEPS, lang) })
        )
      )
    )
  const setVolume = (level: number) =>
    run((id, lang) => {
      if (!Number.isInteger(level) || level < LEVEL_MIN || level > LEVEL_MAX) {
        return Effect.succeed(say(texts, lang, "badLevel", { min: num(LEVEL_MIN, lang), max: num(LEVEL_MAX, lang) }))
      }
      return device((d) => d.changeReplyVolume(id, { to: gainOfLevel(level) })).pipe(
        // `atLimit` on a level is "that is the level already": nothing changed, and that is what is said.
        Effect.map((change) =>
          say(texts, lang, change.atLimit ? "volumeAlready" : "volumeSet", { step: num(stepOfGain(change.level), lang), steps: num(STEPS, lang) })
        )
      )
    })
  return { stop, cancel, repeat, newConversation, volumeIs, louder: step("louder"), quieter: step("quieter"), setVolume }
}

const noParams = Schema.Struct({})

const NEW_CONVERSATION = {
  en: ["new conversation", "start a new conversation", "start over", "new chat"],
  nl: ["nieuw gesprek", "start een nieuw gesprek", "begin opnieuw", "nieuwe chat"]
}
const SET_VOLUME = {
  en: ["volume {level}", "volume to {level}", "set volume to {level}", "set the volume to {level}"],
  nl: ["volume {level}", "volume op {level}", "zet volume op {level}", "zet het volume op {level}"]
}

export const assistantControlsModule = defineModule({
  apiVersion: 2,
  id: "assistant-controls",
  name: "Assistant controls",
  description: "Stop, repeat, a new conversation and the reply volume, by voice and for the model.",
  enabledByDefault: false,
  start: (ctx) => {
    const controls = makeControls(ctx.host)
    const toolError = Effect.mapError((e: ControlFailure) => new ToolError({ message: e.message }))
    const actionError = Effect.mapError((e: ControlFailure) => new ActionError({ message: e.message }))
    return Effect.succeed({
      tools: [
        makeTool({
          name: "controls_stop_reply",
          description:
            "Stop the reply being prepared or spoken on this device, and an announcement being spoken here. For 'stop', 'be quiet'. Not for a ringing notification or media. Called during a reply it ends that reply.",
          parameters: noParams,
          risk: "change",
          execute: () => controls.stop.pipe(toolError, Effect.map((spoken) => ({ spoken })))
        }),
        makeTool({
          name: "controls_cancel_pending",
          description: "Cancel what is pending on this device: the reply being prepared or spoken, and the open follow-up window, so the next sentence needs the wake phrase again. For 'never mind', 'cancel that'.",
          parameters: noParams,
          risk: "change",
          execute: () => controls.cancel.pipe(toolError, Effect.map((spoken) => ({ spoken })))
        }),
        makeTool({
          name: "controls_repeat_last",
          description: "Say the last reply spoken on this device again, word for word, without asking the model. For 'say that again'. It speaks the line itself; do not repeat it in your answer.",
          parameters: noParams,
          risk: "change",
          execute: () => controls.repeat.pipe(toolError, Effect.map((spoken) => ({ spoken })))
        }),
        makeTool({
          name: "controls_new_conversation",
          description: "Start a new conversation with the assistant on this device: what was said before is no longer remembered in it. For 'start over', 'new conversation'.",
          parameters: noParams,
          risk: "change",
          execute: () => controls.newConversation.pipe(toolError, Effect.map((spoken) => ({ spoken })))
        }),
        makeTool({
          name: "controls_set_volume",
          description: `Set the reply volume of this device (replies, announcements and its cues; not music) to a level from ${LEVEL_MIN} to ${LEVEL_MAX}. The device has five steps, so two levels share a step (1–2 is the quietest, 9–10 the loudest); the answer says the step it is on. It stays until changed, and is back at the loudest after the server restarts.`,
          parameters: Schema.Struct({
            level: Schema.Int.check(Schema.isBetween({ minimum: LEVEL_MIN, maximum: LEVEL_MAX })).annotate({ description: `Volume from ${LEVEL_MIN} (quietest) to ${LEVEL_MAX} (loudest)` })
          }),
          risk: "change",
          execute: ({ level }) => controls.setVolume(level).pipe(toolError, Effect.map((spoken) => ({ spoken })))
        }),
        makeTool({
          name: "controls_louder",
          description: "Turn the reply volume of this device up one step of five. Says when it is as loud as it goes.",
          parameters: noParams,
          risk: "change",
          execute: () => controls.louder.pipe(toolError, Effect.map((spoken) => ({ spoken })))
        }),
        makeTool({
          name: "controls_quieter",
          description: "Turn the reply volume of this device down one step of five. Says when it is as quiet as it goes.",
          parameters: noParams,
          risk: "change",
          execute: () => controls.quieter.pipe(toolError, Effect.map((spoken) => ({ spoken })))
        }),
        makeTool({
          name: "controls_get_volume",
          description: "Say what the reply volume of this device is now, as a step of five.",
          parameters: noParams,
          speculative: true,
          latency: "instant",
          execute: () => controls.volumeIs.pipe(toolError, Effect.map((spoken) => ({ spoken })))
        })
      ],
      actions: [
        defineAction({
          id: "new_conversation",
          label: "Start a new conversation",
          description: "Start a new conversation with the assistant on this device. Not for stopping a reply: that is the host's stop.",
          examples: ["new conversation", "start over", "nieuw gesprek", "begin opnieuw"],
          params: {},
          phrases: NEW_CONVERSATION,
          // The conversation the reply belonged to is gone: the reply that was cut off is not said again.
          endsReply: true,
          // The tool of the same operation is `controls_new_conversation`: this one is for phrases and routines.
          offerAsTool: false,
          risk: "change",
          run: () => controls.newConversation.pipe(actionError, Effect.map((say) => ({ say })))
        }),
        defineAction({
          id: "set_volume",
          label: "Set the volume",
          description: `Set the reply volume of this device to a level from ${LEVEL_MIN} to ${LEVEL_MAX}. Not for louder or quieter: those are the host's.`,
          examples: ["volume seven", "set the volume to four", "zet het volume op vijf", "volume 3"],
          params: { level: Param.number({ label: "Volume level", min: LEVEL_MIN, max: LEVEL_MAX, integer: true }) },
          phrases: SET_VOLUME,
          offerAsTool: false,
          risk: "change",
          run: ({ level }) => controls.setVolume(level).pipe(actionError, Effect.map((say) => ({ say })))
        })
      ]
    })
  }
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [assistantControlsModule]
