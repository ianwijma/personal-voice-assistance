import { Cause, Effect, Exit } from "effect"
import { ACTION_TIMEOUT_MS, ActionError, type ActionOutcome, type RegisteredAction } from "./Actions.ts"
import { type ExecutionGateway, isGatewayRefusal } from "./Gateway.ts"
import type { NotifyEngine } from "./NotifyEngine.ts"
import type { Taken as PhraseDecisionTaken } from "./PhraseDecision.ts"
import { PHRASE_ANSWER_CHARS, type PhraseLanguage } from "./Phrases.ts"
import { phraseText } from "./PhraseTexts.ts"
import { PLAYBACK_LIMITS, type PlaybackService } from "./Playback.ts"
import type { VolumeChange } from "./SessionControl.ts"
import type { TurnContext } from "./TurnContext.ts"

/**
 * Running what took an utterance (`decideUtterance`, `PhraseDecision.ts`): the host's ringing window, its essential
 * controls and a module's phrase command (docs/PHRASES.md). Serve mode (`VoiceSession`) and the module test kit run the
 * same function with their own ports, so a module's test sees what serve mode does.
 *
 * Nothing here uses a decision taken before a wait: what rings, whether a reply is active, whether the command's action
 * is still published, the volume and the room are each read from the ports at the moment they are used.
 *
 * - **Ringing window** — "stop": every ring held on the device stopped (`stopRinging`, the same admission as the card's
 *   Stop: only a device that holds the card); a button's label: `press` of that action, the same claim as a button, and
 *   its answer is spoken.
 * - **stop** — the first of these that exists on the device: what rings there (`stopRinging`); a reply being prepared or
 *   spoken, or an announcement (every conversation of the device stopped, the announcement stopped); media the
 *   `Playback` service says it paused in the device's room. Says nothing.
 * - **never mind** — a pending interaction cancelled (a reply being prepared or spoken; an open armed or follow-up
 *   window). Says nothing.
 * - **repeat** — the device's last spoken reply again (a canned reply: no model, nothing in the history), or "I haven't
 *   said anything yet."
 * - **louder / quieter** — the reply volume one step (`output.volume`); then the reply this utterance interrupted is
 *   spoken again, at the new level, or else a short confirmation ("Louder.", or "That's as loud as I go.").
 * - **a module's command** — the action, if it is still published for the assistant, runs through the execution gateway
 *   as a `phrase` turn of that assistant on the device (admission, the risk policy), within `ACTION_TIMEOUT_MS`; its `say`
 *   (cut to `PHRASE_ANSWER_CHARS` at the module's page boundary) is spoken, followed by the reply the utterance interrupted
 *   unless the action is declared `endsReply`. An action withdrawn before it ran answers "I can't do that right now." and
 *   changes nothing; a refusal "I'm not allowed to do that."; a failure the module's own `ActionError` message, or "That
 *   didn't work." for a time-out or a defect.
 */

/** A reply as the session keeps it: who said it and what was prepared of it. */
export interface KeptReply {
  readonly assistant: string
  readonly text: string
}

/** What the runner needs of the device's voice session (serve mode) or of the kit. */
export interface PhraseSessionPort {
  /** A reply is being prepared or spoken on the device now, an announcement plays there, or one of these was audible when the utterance began. */
  readonly replyActive: () => boolean
  /** Stop every conversation of the device and the announcement being spoken (as the page's Stop and Esc). */
  readonly stopReply: Effect.Effect<boolean>
  /** Stop a reply being prepared or spoken and close the armed and follow-up windows. */
  readonly cancelPending: Effect.Effect<boolean>
  /** The device's last spoken reply. */
  readonly lastReply: () => KeptReply | undefined
  /** The reply this utterance cut short (it was playing when the utterance began and ended interrupted), if any. */
  readonly interruptedReply: () => KeptReply | undefined
  /** The device's answering assistant now (who speaks the host's own lines). */
  readonly answering: () => string | undefined
  /** Speak `text` on the device as a canned reply of `assistant` (`undefined`: the answering one). */
  readonly say: (assistant: string | undefined, text: string) => Effect.Effect<void>
}

export interface PhrasePorts {
  readonly deviceId: string | undefined
  readonly language: () => PhraseLanguage
  /** The notification service; absent (the CLI modes): nothing rings. */
  readonly notify: () => Pick<NotifyEngine, "ringingOn" | "stopRinging" | "stopSpeech" | "press"> | undefined
  readonly session: PhraseSessionPort
  /** One step of the device's reply volume. */
  readonly volume: (direction: "louder" | "quieter") => Effect.Effect<VolumeChange>
  /** The `Playback` provider now (`host.service(Playback)`), if one is published. */
  readonly playback: () => PlaybackService | undefined
  /** The device's room now (`place.room`), if it has one. */
  readonly room: () => string | undefined
  readonly gateway: () => ExecutionGateway
  /** The turn a command of `assistant` runs as (`source: "phrase"`, the device, its person and connection, a fresh turn id). */
  readonly turn: (assistant: string) => TurnContext
  /** The action is in `assistant`'s published parts now (the module snapshot). */
  readonly isPublished: (assistant: string, action: RegisteredAction) => boolean
  /** The module's page boundary (`ModuleHost.pageText`). */
  readonly pageText: (moduleId: string, text: unknown, max: number) => string
}

/** What a taken utterance came to (the log, the kit). */
export type PhraseDid =
  | "stopped-ring"
  | "pressed"
  | "stopped-reply"
  | "paused-media"
  | "cancelled"
  | "repeated"
  | "volume"
  | "ran"
  | "nothing"
  | "refused"
  | "not-running"
  | "failed"
  /** Another taken utterance of the device was still running: this one was answered "One moment…" and not run. */
  | "busy"

export interface PhraseOutcome {
  readonly taken: PhraseDecisionTaken
  readonly did: PhraseDid
  /** What the device said for it, if anything. */
  readonly said?: string
  /** Why it did not run (`refused`, `not-running`, `failed`): for the log and tests, never spoken as it is. */
  readonly why?: string
}

const joined = (...parts: ReadonlyArray<string | undefined>) => parts.filter((p): p is string => p !== undefined && p.trim().length > 0).join(" ")

/** Run what took an utterance. Never fails: every failure is an outcome (and, where the device should say so, a spoken line). */
export const runTaken = (taken: PhraseDecisionTaken, ports: PhrasePorts): Effect.Effect<PhraseOutcome> =>
  Effect.gen(function*(): Effect.fn.Return<PhraseOutcome> {
    const lang = ports.language()
    const session = ports.session
    const speak = (assistant: string | undefined, text: string) => Effect.as(session.say(assistant, text), text)
    const deviceId = ports.deviceId
    const notify = ports.notify()

    if (taken.by === "ringing") {
      if (deviceId === undefined || notify === undefined) return { taken, did: "nothing" }
      const m = taken.match
      if (m.kind === "stop") {
        const n = yield* notify.stopRinging(deviceId)
        return { taken, did: n > 0 ? "stopped-ring" : "nothing" }
      }
      const answer = yield* notify.press({ notificationId: m.notificationId, actionId: m.actionId, deviceId })
      const said = yield* speak(undefined, answer.say)
      return answer.ok
        ? { taken, did: "pressed", said }
        : { taken, did: answer.code === "not_running" ? "not-running" : "refused", said, why: answer.code ?? "refused" }
    }

    const m = taken.match
    if (m.kind === "control") {
      switch (m.control) {
        case "stop": {
          // The first that exists, each read now.
          if (deviceId !== undefined && notify !== undefined && notify.ringingOn(deviceId).length > 0) {
            const n = yield* notify.stopRinging(deviceId)
            if (n > 0) return { taken, did: "stopped-ring" }
          }
          if (session.replyActive()) {
            yield* session.stopReply
            return { taken, did: "stopped-reply" }
          }
          const playback = ports.playback()
          const room = ports.room()
          if (playback !== undefined && room !== undefined) {
            const paused = yield* playback.pause(room).pipe(
              Effect.timeoutOrElse({ duration: PLAYBACK_LIMITS.callTimeoutMs, orElse: () => Effect.succeed(false) }),
              Effect.catchCause(() => Effect.succeed(false))
            )
            if (paused) return { taken, did: "paused-media" }
          }
          return { taken, did: "nothing" }
        }
        case "never-mind":
          return { taken, did: (yield* session.cancelPending) ? "cancelled" : "nothing" }
        case "repeat": {
          const last = session.lastReply()
          if (last === undefined) return { taken, did: "nothing", said: yield* speak(undefined, phraseText(lang, "nothingToRepeat")) }
          return { taken, did: "repeated", said: yield* speak(last.assistant, last.text) }
        }
        case "louder":
        case "quieter": {
          const change = yield* ports.volume(m.control)
          const line = change.atLimit ? phraseText(lang, m.control === "louder" ? "loudest" : "quietest") : phraseText(lang, m.control)
          const resumed = session.interruptedReply()
          const said = resumed === undefined
            ? yield* speak(undefined, line)
            : yield* speak(resumed.assistant, change.atLimit ? joined(line, resumed.text) : resumed.text)
          return { taken, did: "volume", said }
        }
      }
    }

    // A module's phrase command.
    const action = m.action
    const assistant = taken.assistant ?? session.answering()
    if (assistant === undefined || !ports.isPublished(assistant, action)) {
      return { taken, did: "not-running", said: yield* speak(assistant, phraseText(lang, "cantNow")), why: "not published" }
    }
    const run = ports.gateway().action(action, m.values, { principal: { _tag: "turn", turn: ports.turn(assistant) } }).pipe(
      Effect.timeoutOrElse({ duration: ACTION_TIMEOUT_MS, orElse: () => Effect.fail(new ActionError({ message: "timeout" })) })
    )
    const exit = yield* Effect.exit(run)
    const resumed = action.definition.endsReply === true ? undefined : session.interruptedReply()
    const tail = (answer: string | undefined) => (resumed === undefined ? answer ?? "" : joined(answer, resumed.text))
    const voice = resumed?.assistant ?? assistant
    if (Exit.isSuccess(exit)) {
      const outcome = exit.value as ActionOutcome | void
      const own = outcome?.say ?? action.definition.announce?.(m.values as never)
      const answer = own === undefined ? undefined : ports.pageText(action.moduleId, own, PHRASE_ANSWER_CHARS)
      const text = tail(answer)
      return { taken, did: "ran", ...(text.length > 0 ? { said: yield* speak(voice, text) } : {}) }
    }
    const error = Cause.squash(exit.cause)
    if (error instanceof ActionError && isGatewayRefusal(error)) {
      return { taken, did: "refused", said: yield* speak(assistant, phraseText(lang, "notAllowed")), why: error.message }
    }
    // Withdrawn after the check (the module stopped as it was called): nothing ran.
    if (!ports.isPublished(assistant, action)) return { taken, did: "not-running", said: yield* speak(assistant, phraseText(lang, "cantNow")), why: "withdrawn" }
    if (error instanceof ActionError && error.message !== "timeout") {
      const own = ports.pageText(action.moduleId, error.message, PHRASE_ANSWER_CHARS)
      return { taken, did: "failed", said: yield* speak(assistant, own), why: "the action failed" }
    }
    return { taken, did: "failed", said: yield* speak(assistant, phraseText(lang, "failed")), why: error instanceof ActionError ? "timeout" : "defect" }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed<PhraseOutcome>({ taken, did: "failed", why: "the host failed" })
    )
  )
