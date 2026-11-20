import { Cause, Clock, Data, Effect, Exit } from "effect"
import { ACTION_TIMEOUT_MS, ActionError, type ActionOutcome, actionToolName, type RegisteredAction } from "./Actions.ts"
import { type ExecutionGateway, isGatewayRefusal, spokenRefusal } from "./Gateway.ts"
import type { ToolRisk } from "./Module.ts"
import type { NotifyEngine } from "./NotifyEngine.ts"
import type { Taken } from "./PhraseDecision.ts"
import { PHRASE_ANSWER_CHARS, type PhraseLanguage } from "./Phrases.ts"
import { phraseText } from "./PhraseTexts.ts"
import { PLAYBACK_LIMITS, PlaybackError, type PlaybackService } from "./Playback.ts"
import type { VolumeChange } from "./SessionControl.ts"
import type { TurnContext } from "./TurnContext.ts"

/**
 * Running what took an utterance (`decideUtterance`, `PhraseDecision.ts`): the host's ringing window, its essential
 * controls and a module's phrase command (docs/PHRASES.md). Serve mode (`VoiceSession`) and the module test kit run the
 * same function with their own ports, so a module's test sees what serve mode does.
 *
 * Two parts (review round 1, E4): **the operation** (what rings is stopped, the action runs through the gateway, the
 * volume steps…), which decides an outcome and a **settlement**; then **one settlement for every outcome** (`settle`),
 * which decides what is spoken afterwards and in whose voice: the command's own sentence, if any, in the voice of the
 * assistant it was addressed to; then, unless the command ends the reply (`endsReply`, a "stop" that selected the reply,
 * "never mind"), the reply this utterance's start of speech interrupted, in **its** assistant's voice; in that order, the
 * second only after the first has finished, and nothing more once something cut the first short. The interrupted reply
 * is found by its turn; when its end is not recorded yet (the page's stop report has not come), the session waits for it,
 * bounded. A cancellation of that reply in the meantime (Stop, "never mind", a new conversation) revokes it: checked
 * after every wait and right before it would be said; the command's own answer is still said (review round 2, b1).
 *
 * Nothing here uses a decision taken before a wait: what rings, whether a reply or an announcement is active, whether the
 * command's action is still published, the volume and the room are read from the ports when they are used. Module
 * actions run one at a time per device (`CommandSlot`); the host's controls and the ringing window's "stop" are never
 * refused as busy (E6). Every taken utterance leaves exactly one execution trace (`PhrasePorts.trace`, E7): its identity
 * (the addressed assistant, the principal, the control or command) is fixed before anything can return early, its
 * outcome is what really happened (a risk only when the gateway judged the call), and it is published from a finaliser,
 * so also when the caller is interrupted during the action or the settlement (review round 2, a4).
 *
 * "stop" stops the first of: what rings, the announcement, the reply, the room's media. Once a step is selected (it
 * exists) the utterance is about that one: a failure to stop it is said as a failure ("I couldn't stop that.") and the
 * interrupted reply is said again, as for any command that does not end the reply; nothing else is stopped in its place
 * (review round 2, a3).
 */

/** A reply as a session keeps it: who said it and what was prepared of it (at most `MAX_KEPT_REPLY_CHARS`). */
export interface KeptReply {
  readonly assistant: string
  readonly text: string
}

/** The longest reply text kept for "repeat" and for saying an interrupted reply again (characters). */
export const MAX_KEPT_REPLY_CHARS = 2_000

/**
 * The text kept of a reply from its clauses, as serve mode and the kit keep it: whole clauses joined by a space, up to
 * `MAX_KEPT_REPLY_CHARS`; a first clause longer than that is cut to it; blank clauses are skipped.
 */
export const keptReplyText = (clauses: ReadonlyArray<string | undefined>): string => {
  let text = ""
  for (const clause of clauses) {
    const c = clause?.trim() ?? ""
    if (c === "") continue
    const next = text === "" ? c : `${text} ${c}`
    if (next.length > MAX_KEPT_REPLY_CHARS) {
      if (text === "") text = c.slice(0, MAX_KEPT_REPLY_CHARS)
      break
    }
    text = next
  }
  return text
}

/** One module action at a time per device (serve mode and the kit each keep one per device). */
export interface CommandSlot {
  /** Take the slot; `false`: another module action of the device runs. */
  readonly take: () => boolean
  readonly give: () => void
}

export const makeCommandSlot = (): CommandSlot => {
  let busy = false
  return {
    take: () => (busy ? false : (busy = true)),
    give: () => {
      busy = false
    }
  }
}

/** What the runner needs of the device's voice session (serve mode) or of the kit. */
export interface PhraseSessionPort {
  /** A reply is being prepared or spoken on the device now, or was as the utterance began. */
  readonly replyActive: () => boolean
  /** An announcement plays on the device now. */
  readonly announcementActive: () => boolean
  /** Stop every conversation of the device (as the page's Stop). Whether something was stopped. */
  readonly stopReply: Effect.Effect<boolean>
  /** Stop the announcement being spoken on the device. */
  readonly stopAnnouncement: Effect.Effect<boolean>
  /** Stop a reply being prepared or spoken and close the follow-up window of the reply it cancelled (E8). Whether anything was pending. */
  readonly cancelPending: Effect.Effect<boolean>
  /** The device's last spoken reply. */
  readonly lastReply: () => KeptReply | undefined
  /** The reply this utterance's start of speech interrupted, once its end is recorded (bounded wait); `undefined`: none. */
  readonly interruptedReply: Effect.Effect<KeptReply | undefined>
  /**
   * The interrupted reply was cancelled since the utterance's final (a "stop" that selected it, the page's Stop, "never
   * mind" or `cancelPending`, a new conversation of its assistant): it is not said again. Read after every wait, right
   * before it would be said (review round 2, b1). An explicit "repeat" is not affected.
   */
  readonly replyCancelled: () => boolean
  /** The device's answering assistant now (who speaks the host's own lines). */
  readonly answering: () => string | undefined
  /** Speak `text` as a canned reply of `assistant` (`undefined`: the answering one) and wait until it ended: `cut` when something cut it short. */
  readonly say: (assistant: string | undefined, text: string) => Effect.Effect<"done" | "cut">
}

/** The execution trace of a taken utterance (E7): its principal, the gateway's admission and risk outcome, timings, the outcome. */
export interface PhraseTrace {
  readonly by: "ringing" | "control" | "command"
  /** The control, the action (`<module>.<action>`), or the ringing match ("stop", or the action id). */
  readonly name: string
  /**
   * The principal: the turn of the utterance's assistant (the addressed one, else the device's answering one) on the
   * device, with its person. A command runs as exactly this turn. Absent only when the device answers nobody.
   */
  readonly turn?: TurnContext
  /** A command's action as its generated tool (`<module>_<action>`). */
  readonly tool?: string
  /** The class the gateway judged the call as, and its refusal, if any. */
  readonly risk?: ToolRisk
  readonly refused?: string
  /**
   * P8: the household risk policy's decision for the command's action (the same as for the model's call of that action),
   * when the gateway took one: its outcome and the class it was decided by.
   */
  readonly decision?: { readonly outcome: "allow" | "confirm" | "deny"; readonly by: string }
  /** How long the module's action ran. */
  readonly actionMs?: number
  /** P10: the action's outcome carried a presentation, handed to the Presenter. */
  readonly presented?: boolean
  /** From the run's start to the end of what was said (or to the interruption). */
  readonly totalMs: number
  /** What it came to; `interrupted`: the caller was interrupted before the operation decided an outcome. */
  readonly did: PhraseDid | "interrupted"
  /** Why (a refusal, a failure); `interrupted while speaking` when the caller was interrupted during the settlement. */
  readonly why?: string
}

export interface PhrasePorts {
  readonly deviceId: string | undefined
  readonly language: () => PhraseLanguage
  /** The notification service; absent (the CLI modes): nothing rings. */
  readonly notify: () => Pick<NotifyEngine, "ringingOn" | "stopRinging" | "press"> | undefined
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
  /** The action is in `assistant`'s published actions now. */
  readonly isPublished: (assistant: string, action: RegisteredAction) => boolean
  /** The module's page boundary (`ModuleHost.pageText`). */
  readonly pageText: (moduleId: string, text: unknown, max: number) => string
  /** The device's one module action at a time. */
  readonly slot: CommandSlot
  /** Every taken utterance's execution trace (timed with the `Clock`). Must not throw (a throw is ignored). */
  readonly trace?: (trace: PhraseTrace) => void
}

/** What a taken utterance came to (the log, the kit, the trace). */
export type PhraseDid =
  | "stopped-ring"
  | "pressed"
  | "stopped-announcement"
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
  /** Another module action of the device was still running: this one was answered "One moment…" and not run. */
  | "busy"

export interface PhraseOutcome {
  readonly taken: Taken
  readonly did: PhraseDid
  /** What the device said for it, if anything (the answer, then the interrupted reply). */
  readonly said?: string
  /** Why it did not run (`refused`, `not-running`, `failed`, `busy`): for the log, the trace and tests. */
  readonly why?: string
}

/** What is said after the operation: an answer (fixed, or chosen once the interrupted reply is known) and whether that reply is said again. */
interface Settlement {
  readonly answer?: Answer | ((resumed: KeptReply | undefined) => Answer | undefined)
  readonly resume: boolean
}
interface Answer {
  readonly assistant: string | undefined
  readonly text: string
}

/**
 * THE settlement (E4): the answer first (when it depends on the interrupted reply, that is read first), then the
 * interrupted reply unless the outcome ends it; the second only after the first finished; nothing more after a cut.
 */
const settle = (s: Settlement, session: PhraseSessionPort): Effect.Effect<string | undefined> =>
  Effect.gen(function*() {
    const spoken: Array<string> = []
    const speak = (a: Answer | undefined) =>
      a === undefined || a.text.trim().length === 0 ? Effect.succeed("done" as const) : Effect.tap(session.say(a.assistant, a.text), () => Effect.sync(() => void spoken.push(a.text)))
    /** The interrupted reply, unless it was cancelled meanwhile (b1: checked after each wait). */
    const interrupted = Effect.map(session.interruptedReply, (r) => (r === undefined || session.replyCancelled() ? undefined : r))
    let resumed: KeptReply | undefined
    if (typeof s.answer === "function") {
      resumed = s.resume ? yield* interrupted : undefined
      if ((yield* speak(s.answer(resumed))) === "cut") return spoken.join(" ") || undefined
    } else {
      if ((yield* speak(s.answer)) === "cut") return spoken.join(" ") || undefined
      resumed = s.resume ? yield* interrupted : undefined
    }
    // Right before it is said: a cancellation while the answer played revokes it too.
    if (resumed !== undefined && !session.replyCancelled()) yield* speak(resumed)
    return spoken.length === 0 ? undefined : spoken.join(" ")
  })

class PhraseTimeout extends Data.TaggedError("PhraseTimeout")<{}> {}

interface Operation {
  readonly did: PhraseDid
  readonly why?: string
  readonly settlement: Settlement
}

/** The execution trace while it is gathered: fixed identity first, the gateway's decision and timings as they happen. */
interface TraceRecord {
  readonly by: PhraseTrace["by"]
  readonly name: string
  /** The utterance's assistant: the addressed one, else the device's answering one. */
  readonly assistant: string | undefined
  readonly turn: TurnContext | undefined
  readonly tool?: string
  risk?: ToolRisk
  refused?: string
  decision?: { readonly outcome: "allow" | "confirm" | "deny"; readonly by: string }
  actionStarted?: bigint
  actionMs?: number
  presented?: boolean
}

/** Run what took an utterance. Never fails (an interruption of the caller interrupts it): every failure is an outcome. */
export const runTaken = (taken: Taken, ports: PhrasePorts): Effect.Effect<PhraseOutcome> =>
  Effect.suspend(() => {
    // The trace's identity, before anything can return: who it was for, as whom it runs, what was said.
    const by = taken.by === "ringing" ? "ringing" as const : taken.match.kind === "control" ? "control" as const : "command" as const
    const name = taken.by === "ringing" ? (taken.match.kind === "stop" ? "stop" : taken.match.actionId) : taken.match.kind === "control" ? taken.match.control : taken.match.action.id
    const assistant = (taken.by === "ringing" ? undefined : taken.assistant) ?? ports.session.answering()
    const rec: TraceRecord = {
      by,
      name,
      assistant,
      turn: assistant === undefined ? undefined : ports.turn(assistant),
      ...(taken.by !== "ringing" && taken.match.kind === "command" ? { tool: phraseToolName(taken.match.action) } : {})
    }
    let op: Operation | undefined
    let settled = false
    let started = 0n
    const publish = (exit: Exit.Exit<PhraseOutcome>) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeNanos
        if (rec.actionMs === undefined && rec.actionStarted !== undefined) rec.actionMs = Number(now - rec.actionStarted) / 1e6
        const interrupted = Exit.isFailure(exit)
        const did = op?.did ?? "interrupted"
        const why = op === undefined ? undefined : interrupted && !settled ? "interrupted while speaking" : op.why
        try {
          ports.trace?.({
            by: rec.by,
            name: rec.name,
            ...(rec.turn !== undefined ? { turn: rec.turn } : {}),
            ...(rec.tool !== undefined ? { tool: rec.tool } : {}),
            ...(rec.risk !== undefined ? { risk: rec.risk } : {}),
            ...(rec.refused !== undefined ? { refused: rec.refused } : {}),
            ...(rec.decision !== undefined ? { decision: rec.decision } : {}),
            ...(rec.actionMs !== undefined ? { actionMs: rec.actionMs } : {}),
            ...(rec.presented === true ? { presented: true } : {}),
            totalMs: Number(now - started) / 1e6,
            did,
            ...(why !== undefined ? { why } : {})
          })
        } catch {
          // An observer must not change the outcome.
        }
      })
    return Effect.gen(function*(): Effect.fn.Return<PhraseOutcome> {
      started = yield* Clock.currentTimeNanos
      op = yield* operate(taken, ports, rec).pipe(
        Effect.catchCause((cause): Effect.Effect<Operation> =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed({ did: "failed", why: "the host failed", settlement: { answer: { assistant: undefined, text: phraseText(ports.language(), "failed") }, resume: true } })
        )
      )
      const said = yield* settle(op.settlement, ports.session)
      settled = true
      return { taken, did: op.did, ...(said !== undefined ? { said } : {}), ...(op.why !== undefined ? { why: op.why } : {}) }
    }).pipe(Effect.onExit(publish))
  })

/** A selected step of "stop" run: its value, or `failed` (a failure or defect; an interruption is the caller's). */
type Attempt<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: unknown }
const attempt = <A, E>(step: Effect.Effect<A, E>): Effect.Effect<Attempt<A>> =>
  Effect.flatMap(Effect.exit(step), (exit): Effect.Effect<Attempt<A>> => {
    if (Exit.isSuccess(exit)) return Effect.succeed({ ok: true, value: exit.value })
    if (Cause.hasInterruptsOnly(exit.cause)) return Effect.failCause(exit.cause as Cause.Cause<never>)
    return Effect.succeed({ ok: false, error: Cause.squash(exit.cause) })
  })

/** The operation and its settlement. */
const operate = (taken: Taken, ports: PhrasePorts, rec: TraceRecord): Effect.Effect<Operation> =>
  Effect.gen(function*(): Effect.fn.Return<Operation> {
    const lang = ports.language()
    const session = ports.session
    const deviceId = ports.deviceId
    const notify = ports.notify()
    const host = (key: Parameters<typeof phraseText>[1], assistant?: string): Answer => ({ assistant, text: phraseText(lang, key) })
    /** A selected step of "stop" that failed: said as a failure, the interrupted reply said again, nothing else stopped. */
    const couldNotStop = (why: string, assistant: string | undefined): Operation => ({ did: "failed", why, settlement: { answer: host("couldNotStop", assistant), resume: true } })
    /** What rings on the device, stopped through the service (selected: it rang when read). */
    const stopRing = (assistant: string | undefined) =>
      Effect.map(attempt(notify!.stopRinging(deviceId!)), (r): Operation =>
        r.ok ? { did: r.value > 0 ? "stopped-ring" : "nothing", settlement: { resume: true } } : couldNotStop("the ring could not be stopped", assistant))

    if (taken.by === "ringing") {
      const m = taken.match
      if (deviceId === undefined || notify === undefined) return { did: "nothing", settlement: { resume: true } }
      if (m.kind === "stop") return yield* stopRing(undefined)
      // A button runs the module's handler: one module action at a time.
      if (!ports.slot.take()) return { did: "busy", why: "another action runs", settlement: { answer: host("busy"), resume: true } }
      const answer = yield* notify.press({ notificationId: m.notificationId, actionId: m.actionId, deviceId }).pipe(Effect.ensuring(Effect.sync(() => ports.slot.give())))
      return answer.ok
        ? { did: "pressed", settlement: { answer: { assistant: undefined, text: answer.say }, resume: true } }
        : { did: answer.code === "not_running" ? "not-running" : "refused", why: answer.code ?? "refused", settlement: { answer: { assistant: undefined, text: answer.say }, resume: true } }
    }

    const m = taken.match
    const addressed = taken.assistant
    if (m.kind === "control") {
      switch (m.control) {
        case "stop": {
          // The first that exists, each read now; once selected, that one is what this utterance is about.
          if (deviceId !== undefined && notify !== undefined && notify.ringingOn(deviceId).length > 0) return yield* stopRing(addressed)
          if (session.announcementActive()) {
            const r = yield* attempt(session.stopAnnouncement)
            return r.ok ? { did: "stopped-announcement", settlement: { resume: true } } : couldNotStop("the announcement could not be stopped", addressed)
          }
          if (session.replyActive()) {
            yield* session.stopReply
            return { did: "stopped-reply", settlement: { resume: false } }
          }
          const playback = ports.playback()
          const room = ports.room()
          if (playback !== undefined && room !== undefined) {
            const r = yield* attempt(playback.pause(room).pipe(
              Effect.timeoutOrElse({ duration: PLAYBACK_LIMITS.callTimeoutMs, orElse: () => Effect.fail(new PlaybackError({ reason: "timeout", detail: "no answer in time" })) })
            ))
            if (r.ok) return r.value ? { did: "paused-media", settlement: { resume: false } } : { did: "nothing", settlement: { resume: true } }
            // No player for the room (or no usable room): nothing played there. Anything else: it could not be paused.
            if (r.error instanceof PlaybackError && (r.error.reason === "no_player" || r.error.reason === "invalid")) return { did: "nothing", settlement: { resume: true } }
            return couldNotStop("the media could not be paused", addressed)
          }
          return { did: "nothing", settlement: { resume: true } }
        }
        case "never-mind":
          return { did: (yield* session.cancelPending) ? "cancelled" : "nothing", settlement: { resume: false } }
        case "repeat": {
          // The reply this utterance interrupted (once its end is recorded), else the last one: it is the answer.
          const r = (yield* session.interruptedReply) ?? session.lastReply()
          return r === undefined
            ? { did: "nothing", settlement: { answer: host("nothingToRepeat", addressed), resume: false } }
            : { did: "repeated", settlement: { answer: { assistant: r.assistant, text: r.text }, resume: false } }
        }
        case "louder":
        case "quieter": {
          const change = yield* ports.volume(m.control)
          const control = m.control
          return {
            did: "volume",
            settlement: {
              resume: true,
              // At the bound the host says so; otherwise the interrupted reply, at the new level, is the confirmation.
              answer: (resumed) =>
                change.atLimit ? host(control === "louder" ? "loudest" : "quietest", addressed) : resumed === undefined ? host(control, addressed) : undefined
            }
          }
        }
      }
    }

    // A module's phrase command. Its answers are the addressed assistant's; the interrupted reply follows unless it ends it.
    const action = m.action
    const assistant = rec.assistant
    const resume = action.definition.endsReply !== true
    if (!ports.slot.take()) return { did: "busy", why: "another action runs", settlement: { answer: host("busy", assistant), resume } }
    return yield* Effect.gen(function*(): Effect.fn.Return<Operation> {
      const turn = rec.turn
      if (turn === undefined || assistant === undefined || !ports.isPublished(assistant, action)) {
        return { did: "not-running", why: "not published", settlement: { answer: host("cantNow", assistant), resume } }
      }
      rec.actionStarted = yield* Clock.currentTimeNanos
      const exit = yield* Effect.exit(
        ports.gateway().action(action, m.values, {
          principal: { _tag: "turn", turn },
          onDecision: (d) => {
            if (d.risk !== undefined) rec.risk = d.risk
            if (d.refused !== undefined) rec.refused = d.refused
            if (d.outcome !== undefined && d.by !== undefined) rec.decision = { outcome: d.outcome, by: d.by }
            if (d.presented === true) rec.presented = true
          }
        }).pipe(Effect.timeoutOrElse({ duration: ACTION_TIMEOUT_MS, orElse: () => Effect.fail(new PhraseTimeout()) }))
      )
      rec.actionMs = Number((yield* Clock.currentTimeNanos) - rec.actionStarted) / 1e6
      if (Exit.isSuccess(exit)) {
        const outcome = exit.value as ActionOutcome | void
        let own: string | undefined
        try {
          own = outcome?.say ?? action.definition.announce?.(m.values as never)
        } catch {
          // A throwing `announce` is that module's failure: the host's sentence, the reply still said again.
          return { did: "failed", why: "its announce threw", settlement: { answer: host("failed", assistant), resume } }
        }
        const answer = own === undefined ? undefined : { assistant, text: ports.pageText(action.moduleId, own, PHRASE_ANSWER_CHARS) }
        return { did: "ran", settlement: { ...(answer !== undefined ? { answer } : {}), resume } }
      }
      if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
      const error = Cause.squash(exit.cause)
      if (error instanceof ActionError && isGatewayRefusal(error)) {
        // P8: a refusal of the risk policy is said in the policy's own sentence (as for the same action asked of the
        // intent agent); the host's other refusals keep "I'm not allowed to do that."
        const spoken = spokenRefusal(error)
        return { did: "refused", why: error.message, settlement: { answer: spoken !== undefined ? { assistant, text: spoken } : host("notAllowed", assistant), resume } }
      }
      // Withdrawn as it was called (the module stopped): nothing ran.
      if (!ports.isPublished(assistant, action)) return { did: "not-running", why: "withdrawn", settlement: { answer: host("cantNow", assistant), resume } }
      if (error instanceof PhraseTimeout) return { did: "failed", why: "timeout", settlement: { answer: host("failed", assistant), resume } }
      if (error instanceof ActionError) {
        return { did: "failed", why: "the action failed", settlement: { answer: { assistant, text: ports.pageText(action.moduleId, error.message, PHRASE_ANSWER_CHARS) }, resume } }
      }
      return { did: "failed", why: "defect", settlement: { answer: host("failed", assistant), resume } }
    }).pipe(Effect.ensuring(Effect.sync(() => ports.slot.give())))
  })

/** The generated tool name of an action (what a trace's tool list shows). */
export const phraseToolName = (action: RegisteredAction): string => actionToolName(action.moduleId, action.definition.id)
