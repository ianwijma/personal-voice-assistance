// The run of a routine. Before it starts, what the action catalogue can tell is checked (a courtesy, not a guarantee);
// then its steps run one after the other in the module's shared scope, each one admitted and decided by the gateway as
// the person and device that started it, and the run stops, saying so in one true sentence, where a step is refused.
// One state per running routine, one fiber per run, which a module stop interrupts; a cancel only sets a flag and stops
// the line being spoken, so an action under way is never cut off in the middle.
import { type CatalogAction, CurrentJob, CurrentPrincipal, CurrentTurn, CurrentTurnTrace, type ModuleHostApi, type ModuleSpeech, type SpeechHandle, type TurnContext } from "@pva/core"
import { type Language, say } from "@pva/module-contracts"
import { Deferred, Effect, Exit, Fiber, type Scope } from "effect"
import { nameIn, type Routine, type Step } from "./routines.ts"
import { texts } from "./texts.ts"

/** How long one `say` step may wait for its line to be spoken (it waits for quiet on the device first). */
export const SAY_WAIT_MS = 120_000
/** The internal action that speaks a `say` step's line: `routines.line`, no phrases, not a tool of the model. */
export const LINE_ACTION = "line"
/** Phrase starts remembered so that a replay of the same phrase turn starts nothing (finished ones; unfinished stay). */
export const MAX_REPLAYS = 64

/** Why a routine is refused before it runs (said in one sentence, the step by its number in the owner's list). */
export type Refusal =
  | { readonly kind: "noDevice" | "notHere" }
  | { readonly kind: "already" | "busyHere"; readonly other: string }
  | { readonly kind: "refusedMissing" | "refusedConfirm" | "refusedParams"; readonly step: number }

export type StartAnswer = { readonly kind: "started" } | { readonly kind: "cancelled"; readonly text: string } | { readonly kind: "refused"; readonly refusal: Refusal; readonly text: string }

/** What a cancel answers (`routines_stop`, "cancel the routine"). */
export type CancelAnswer = { readonly kind: "none"; readonly text: string } | { readonly kind: "cancelled"; readonly text: string; readonly inCall: boolean }

/** What a run is doing now. One per routine, and one per device, at a time. */
interface RunState {
  readonly runId: number
  readonly routine: Routine
  readonly language: Language
  readonly deviceId: string
  /** The step being run (1-based, the owner's numbering); 0 before the first. */
  step: number
  /** Steps finished, whatever their outcome. */
  finished: number
  /** A `call` step's action is under way: interrupted or cancelled now, it may or may not complete. */
  inCall: boolean
  /** The line of the current `say` step, from its enqueue until it has ended. */
  line: SpeechHandle | undefined
  /** Claimed before enqueueing; settles once its handle is stored or enqueueing fails. */
  lineClaimed: Deferred.Deferred<void> | undefined
  /** Whether the current step may still claim an enqueue; revoked before any failed-step cleanup. */
  lineOpen: boolean
  /** The steps ended and their closing sentence is committed; cancellation can no longer win. */
  ending: boolean
  /** Cancelled by the person: no further step starts and nothing more is said. */
  cancelled: boolean
}

export interface Runner {
  /** Check the routine as the calling turn and, if the catalogue allows it, start it in the shared scope. Answers at once. */
  readonly start: (routine: Routine, language: Language) => Effect.Effect<StartAnswer>
  /** Cancel the routine running for the calling turn's device. */
  readonly cancel: (language: Language) => Effect.Effect<CancelAnswer>
  /**
   * The body of the internal line action: enqueue step `step`'s line of run `runId` on the calling device, for a turn of
   * that run's device with `source: "routine"`, and keep its handle with the run. `false`: no such line here.
   */
  readonly enqueueLine: (runId: number, step: number) => Effect.Effect<boolean>
  /** The routines running now, by key. */
  readonly running: () => ReadonlySet<string>
}

/** The current line of a run, as the line action left it. */
const lineOf = (state: RunState): SpeechHandle | undefined => state.line

/** The text of a step in the household's language. */
const textOf = (step: Step & { readonly kind: "say" }, language: Language) => (typeof step.text === "string" ? step.text : step.text[language])

/** Whether the values a `call` step gives fit the action as the catalogue describes it (names, required ones, kinds). */
const paramsFit = (action: CatalogAction, given: Readonly<Record<string, unknown>>): boolean => {
  for (const [name, value] of Object.entries(given)) {
    const param = action.params.find((p) => p.name === name)
    if (param === undefined) return false
    const ok = param.kind === "number" ? typeof value === "number" : param.kind === "boolean" ? typeof value === "boolean" : typeof value === "string"
    if (!ok) return false
  }
  return action.params.every((p) => p.optional || p.kind === "boolean" || Object.hasOwn(given, p.name))
}

/** "1, 2 and 3" / "1, 2 en 3". */
export const joinList = (items: ReadonlyArray<string>, last: string): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`

const listOf = (language: Language, steps: ReadonlyArray<number>) => joinList(steps.map(String), language === "en" ? "and" : "en")

/** "step 2" / "steps 2 and 4", in the language. */
const stepsText = (language: Language, steps: ReadonlyArray<number>) => say(texts, language, steps.length === 1 ? "stepOne" : "stepsMany", { list: listOf(language, steps) })

/** How far a run that stopped got: the steps before it that were done, and those it could not confirm. */
const before = (language: Language, done: ReadonlyArray<number>, unconfirmed: ReadonlyArray<number>) => {
  const doneText = done.length === 0
    ? unconfirmed.length === 0 ? say(texts, language, "beforeNone") : ""
    : say(texts, language, done.length === 1 ? "beforeOne" : "beforeMany", { list: listOf(language, done) })
  return [doneText, ...(unconfirmed.length === 0 ? [] : [say(texts, language, "alsoUnconfirmed", { steps: stepsText(language, unconfirmed) })])].filter(Boolean).join(" ")
}

/** The sentence of a run that stopped at step `at`: refused there, its values did not fit, or the step before it failed (`stop_if_failed`). */
export const stoppedSentence = (
  language: Language,
  name: string,
  at: number,
  why: "whyRefused" | "whyValues" | "failed",
  done: ReadonlyArray<number>,
  unconfirmed: ReadonlyArray<number>
): string =>
  why === "failed"
    ? say(texts, language, "stoppedFailed", { name, step: at, before: before(language, done, unconfirmed.filter((n) => n !== at)) })
    : say(texts, language, "stoppedAt", { name, step: at, why: say(texts, language, why), before: before(language, done, unconfirmed) })

export const makeRunner = (deps: { readonly host: ModuleHostApi; readonly speech: ModuleSpeech; readonly scope: Scope.Scope; readonly moduleId: string }): Runner => {
  const { host, speech, scope } = deps
  const running = new Map<string, RunState>()
  const byId = new Map<number, RunState>()
  let runs = 0
  /** Phrase starts by their turn and routine: the first start's answer, for a replay of the same phrase turn. */
  const replays = new Map<string, Deferred.Deferred<StartAnswer>>()
  const finishedReplays = new Set<string>()
  const cancelReplays = new Map<string, Deferred.Deferred<CancelAnswer>>()

  const refusal = (refusal: Refusal, language: Language, name: string): StartAnswer => ({
    kind: "refused",
    refusal,
    text: say(texts, language, refusal.kind, { name, ...("step" in refusal ? { step: refusal.step } : {}), ...("other" in refusal ? { other: refusal.other } : {}) })
  })

  /**
   * What the catalogue can tell, as the turn that starts it, before anything runs: the routine's own command (and,
   * when it has a `say` step, the line action) is offered to this assistant on this device, and each `call` names an
   * action of its catalogue (the module on for the assistant, the action not switched off, not every class it can have
   * refused by the policy) that needs no confirmation and whose parameters the step's values fit by name and kind. A
   * courtesy: each step is admitted and decided by the gateway again when it runs.
   */
  const precheck = (routine: Routine): Effect.Effect<Refusal | undefined> =>
    Effect.gen(function*() {
      const catalogue = yield* host.actions.list
      const offered = (id: string) => catalogue.some((a) => a.id === `${deps.moduleId}.${id}`)
      if (!offered(routine.actionId)) return { kind: "notHere" }
      if (routine.steps.some((s) => s.kind === "say") && !offered(LINE_ACTION)) return { kind: "notHere" }
      for (const [i, step] of routine.steps.entries()) {
        if (step.kind !== "call") continue
        const action = catalogue.find((a) => a.id === `${step.moduleId}.${step.actionId}`)
        if (action === undefined) return { kind: "refusedMissing", step: i + 1 }
        if (action.confirm) return { kind: "refusedConfirm", step: i + 1 }
        if (!paramsFit(action, step.params)) return { kind: "refusedParams", step: i + 1 }
      }
      return undefined
    })

  /** Stop requests and their terminal outcomes are awaited outside the invoking turn. The host handoff limit
   * (a line already handed to the device may still start once) is documented on the module page. */
  const stopHandle = (handle: SpeechHandle) => Effect.andThen(handle.stop, Effect.ignore(handle.done)).pipe(
    Effect.provideService(CurrentTurn, undefined)
  )

  /** Revoke the step before waiting: a failed/timed-out action cannot enqueue a new line later. */
  const stopLine = (state: RunState): Effect.Effect<void> => Effect.gen(function*() {
    state.lineOpen = false
    if (state.lineClaimed !== undefined) yield* Deferred.await(state.lineClaimed)
    const line = lineOf(state)
    if (line !== undefined) yield* stopHandle(line)
  }).pipe(Effect.uninterruptible)

  /** A closing report waits for queue acceptance, never playback. */
  const tell = (deviceId: string, text: string) => Effect.ignore(Effect.catchDefect(speech.say({ device: deviceId }, text), () => Effect.void))
  const close = (state: RunState, text?: string) => Effect.suspend(() => {
    if (state.cancelled) return Effect.void
    state.ending = true
    return text === undefined ? Effect.void : tell(state.deviceId, text)
  }).pipe(Effect.uninterruptible)

  /** Wait for playback, taking back the line before a timeout/failure advances the run. */
  const waitLine = (deviceId: string, handle: SpeechHandle): Effect.Effect<"spoken" | "stopped" | "not-spoken"> =>
    handle.done.pipe(
      Effect.timeoutOrElse({ duration: SAY_WAIT_MS, orElse: () => Effect.as(stopHandle(handle), undefined) }),
      Effect.map((outcomes) => {
        const mine = outcomes?.find((o) => o.deviceId === deviceId)
        return mine?.outcome === "spoken" ? "spoken" as const : mine?.outcome === "stopped" ? "stopped" as const : "not-spoken" as const
      }),
      Effect.catch(() => Effect.as(stopHandle(handle), "not-spoken" as const))
    )

  /** The steps, one after the other, each a gateway call as the starting turn (`source: "routine"`); waits outside any turn. */
  const runSteps = (state: RunState, stepTurn: TurnContext): Effect.Effect<void> =>
    Effect.gen(function*() {
      const { routine, deviceId, language } = state
      const name = nameIn(routine.name, language)
      const asStep = <A>(effect: Effect.Effect<A>) => Effect.provideService(effect, CurrentTurn, stepTurn)
      let lastFailed = false
      let spoke = false
      const done: Array<number> = []
      const unconfirmed: Array<number> = []
      /** The run stops at step `at`, which the gateway refused or whose values did not fit: one sentence, how far it got. */
      const stopAt = (at: number, why: "whyRefused" | "whyValues" | "failed") =>
        close(state, stoppedSentence(language, name, at, why, done, unconfirmed))
      for (const [i, step] of routine.steps.entries()) {
        if (state.cancelled) return
        state.step = i + 1
        if (step.kind === "stop_if_failed") {
          if (lastFailed) return yield* stopAt(i, "failed")
          state.finished = i + 1
          continue
        }
        const catalogue = yield* asStep(host.actions.list)
        if (state.cancelled) return
        // Every dispatched step is a gateway call: a `say` through our line action, a `call` through the action named.
        const request = step.kind === "say"
          ? { moduleId: deps.moduleId, actionId: LINE_ACTION, params: { run: state.runId, step: i + 1 } }
          : { moduleId: step.moduleId, actionId: step.actionId, params: step.params }
        const action = catalogue.find((a) => a.id === `${request.moduleId}.${request.actionId}`)
        // An unavailable target is still sent to the gateway for its refusal (including a policy's decision). Only
        // an otherwise offered action needs our additional check that the starting assistant still offers this routine.
        if (action !== undefined && !catalogue.some((a) => a.id === `${deps.moduleId}.${routine.actionId}`)) {
          // Withdrawal precedes shared-scope closure. A stopping module is not an assistant's switch refusal.
          if (host.view().modules.some((m) => m.id === deps.moduleId && m.state === "stopping")) return yield* Effect.interrupt
          return yield* stopAt(i + 1, "whyRefused")
        }
        if (step.kind === "call" && action !== undefined && !paramsFit(action, step.params)) return yield* stopAt(i + 1, "whyValues")
        state.inCall = step.kind === "call"
        state.line = undefined
        state.lineClaimed = undefined
        state.lineOpen = step.kind === "say"
        // A provider may interrupt its own call. Observe that child's outcome without interrupting this run; an
        // interruption of the outer run still reaches its cleanup and interrupts the child with it.
        const call = yield* Effect.forkChild(asStep(host.actions.run(request)))
        const exit = yield* Fiber.await(call)
        const result = Exit.isSuccess(exit) ? exit.value : { ok: false as const, code: "failed" as const }
        state.inCall = false
        // The line action set it while it ran (read through a function: the compiler cannot see that write).
        const line = lineOf(state)
        if (state.cancelled) {
          yield* stopLine(state)
          return
        }
        if (!result.ok) {
          if (step.kind === "say") yield* stopLine(state)
          if (state.cancelled) return
          // The host withdraws our instance before closing the shared scope. Its missing line action means this
          // run is being stopped too: use the same cleanup now, before a failed step can announce completion.
          if (step.kind === "say" && result.code === "not_running") return yield* Effect.interrupt
          state.finished = i + 1
          // Refused now (the policy, the assistant's switches or the device changed), or values that do not fit: stop here.
          if (result.code === "refused" || result.code === "needs_confirmation") return yield* stopAt(i + 1, "whyRefused")
          if (result.code === "invalid_params") return yield* stopAt(i + 1, "whyValues")
          lastFailed = true
          unconfirmed.push(i + 1)
          continue
        }
        if (step.kind === "call") {
          // A called action's answer is never read out: it does not say whose content it is (docs/modules/routines.md).
          state.finished = i + 1
          lastFailed = false
          done.push(i + 1)
          continue
        }
        const outcome = line === undefined ? "not-spoken" as const : yield* waitLine(deviceId, line)
        state.lineOpen = false
        state.line = undefined
        state.finished = i + 1
        // Stopped on the device (the spoken "stop", the page's Stop, a reply taking the speaker) or cancelled: it ends here.
        if (outcome === "stopped" || state.cancelled) return
        lastFailed = outcome !== "spoken"
        if (lastFailed) unconfirmed.push(i + 1)
        else {
          spoke = true
          done.push(i + 1)
        }
      }
      yield* close(state, unconfirmed.length > 0
        ? say(texts, language, "doneUnconfirmed", { name, steps: stepsText(language, unconfirmed) })
        : !spoke ? say(texts, language, "doneQuiet", { name }) : undefined)
    }).pipe(
      // The module stopped (a restart, a settings save, the server shutting down): nothing resumes. The line of the
      // run is stopped first (queued or playing), then the device is told, while the part is still closing.
      Effect.onInterrupt(() =>
        Effect.gen(function*() {
          yield* stopLine(state)
          if (state.cancelled || state.ending) return
          const name = nameIn(state.routine.name, state.language)
          const text = state.inCall
            ? say(texts, state.language, "cutShortCall", { name, step: state.step })
            : say(texts, state.language, "cutShort", { name, done: state.finished, total: state.routine.steps.length })
          yield* tell(state.deviceId, text)
        }).pipe(Effect.catchDefect(() => Effect.void))
      )
    )

  const enqueueLine = (runId: number, step: number): Effect.Effect<boolean> =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const state = byId.get(runId)
      const s = state?.routine.steps[step - 1]
      // Only the current step's line of a run on this very device, called by that run.
      if (state === undefined || s?.kind !== "say" || state.step !== step || turn?.source !== "routine" || turn.deviceId !== state.deviceId || state.cancelled || !state.lineOpen) return false
      // Claim before the enqueue can yield. Duplicates retain the original handle until this step settles.
      if (state.lineClaimed !== undefined) return true
      const claimed = Deferred.makeUnsafe<void>()
      state.lineClaimed = claimed
      return yield* speech.say({ device: state.deviceId }, textOf(s, state.language)).pipe(
        Effect.map((handle) => {
          state.line = handle
          return true
        }),
        Effect.catch(() => Effect.succeed(false)),
        Effect.ensuring(Deferred.succeed(claimed, undefined))
      )
    }).pipe(
      // Claim and enqueue under the same mask: an interruption cannot leave an unsettled claim behind.
      Effect.uninterruptible
    )

  /** Reserve an answer and hand the work to the shared scope before the caller can leave. The observer also
   * settles an unstarted fiber when that scope is already closed; a caller never owns cleanup or replay completion. */
  const owned = <A>(work: Effect.Effect<A>, settled: Deferred.Deferred<A>, onDone?: (exit: Exit.Exit<A>) => void) =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkIn(work, scope, { startImmediately: true })
      fiber.addObserver((exit) => {
        onDone?.(exit)
        Deferred.doneUnsafe(settled, exit)
      })
    })

  const cancel = (language: Language): Effect.Effect<CancelAnswer> =>
    Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const replayKey = turn?.source === "phrase" ? JSON.stringify([turn.assistantId, turn.conversationId, turn.turnId, turn.deviceId, "stop"]) : undefined
      const known = replayKey === undefined ? undefined : cancelReplays.get(replayKey)
      if (known !== undefined) return yield* restore(Deferred.await(known))
      const settled = Deferred.makeUnsafe<CancelAnswer>()
      if (replayKey !== undefined) {
        cancelReplays.set(replayKey, settled)
        if (cancelReplays.size > MAX_REPLAYS) cancelReplays.delete(cancelReplays.keys().next().value!)
      }
      const state = [...running.values()].find((r) => r.deviceId === turn?.deviceId && !r.cancelled && !r.ending)
      let answer: CancelAnswer = { kind: "none", text: say(texts, language, "nothingRunning") }
      if (state !== undefined) {
        state.cancelled = true
        const name = nameIn(state.routine.name, language)
        const inCall = state.inCall
        answer = inCall
          ? { kind: "cancelled", inCall, text: say(texts, language, "cancelledCall", { name, step: state.step }) }
          : { kind: "cancelled", inCall, text: say(texts, language, "cancelled", { name, done: state.finished, total: state.routine.steps.length }) }
      }
      // Marking cancelled and handing off cleanup share a mask. A caller leaving cannot abandon a claimed line.
      yield* owned(Effect.as(state === undefined ? Effect.void : stopLine(state), answer), settled)
      return yield* restore(Deferred.await(settled))
    }))

  /** Reserve and register cleanup under one mask; only the courtesy precheck is interruptible. */
  const begin = (routine: Routine, language: Language, turn: TurnContext & { readonly deviceId: string }): Effect.Effect<StartAnswer> =>
    Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
      const name = nameIn(routine.name, language)
      if (running.has(routine.key)) return refusal({ kind: "already", other: name }, language, name)
      const here = [...running.values()].find((r) => r.deviceId === turn.deviceId)
      if (here !== undefined) return refusal({ kind: "busyHere", other: nameIn(here.routine.name, language) }, language, name)
      const state: RunState = { runId: ++runs, routine, language, deviceId: turn.deviceId, step: 0, finished: 0, inCall: false, line: undefined, lineClaimed: undefined, lineOpen: false, ending: false, cancelled: false }
      running.set(routine.key, state)
      byId.set(state.runId, state)
      const release = Effect.sync(() => {
        if (running.get(routine.key)?.runId === state.runId) running.delete(routine.key)
        byId.delete(state.runId)
      })
      let handedOff = false
      return yield* Effect.gen(function*() {
        const problem = yield* restore(precheck(routine))
        if (state.cancelled) return { kind: "cancelled" as const, text: say(texts, language, "cancelled", { name, done: state.finished, total: routine.steps.length }) }
        if (problem !== undefined) return refusal(problem, language, name)
        const stepTurn: TurnContext = { ...turn, source: "routine" }
        const run = runSteps(state, stepTurn).pipe(
          Effect.ensuring(release),
          Effect.provideService(CurrentTurn, undefined),
          Effect.provideService(CurrentTurnTrace, undefined),
          Effect.provideService(CurrentJob, undefined),
          Effect.provideService(CurrentPrincipal, undefined)
        )
        const fiber = yield* Effect.forkIn(run, scope)
        // Also releases a fork rejected by an already closed scope, before its effect could install its finalizer.
        fiber.addObserver(() => { if (running.get(routine.key) === state) running.delete(routine.key); byId.delete(state.runId) })
        handedOff = true
        return { kind: "started" as const }
      }).pipe(Effect.ensuring(Effect.suspend(() => handedOff ? Effect.void : release)))
    }))

  const start = (routine: Routine, language: Language): Effect.Effect<StartAnswer> =>
    Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
      const turn = yield* CurrentTurn
      if (turn?.deviceId === undefined || turn.assistantId === undefined) return refusal({ kind: "noDevice" }, language, nameIn(routine.name, language))
      const key = turn.source === "phrase" ? JSON.stringify([turn.assistantId, turn.conversationId, turn.turnId, turn.deviceId, routine.key]) : undefined
      const known = key === undefined ? undefined : replays.get(key)
      if (known !== undefined) return yield* restore(Deferred.await(known))
      const first = Deferred.makeUnsafe<StartAnswer>()
      if (key !== undefined) replays.set(key, first)
      yield* owned(begin(routine, language, { ...turn, deviceId: turn.deviceId }), first, (exit) => {
        if (key === undefined) return
        if (Exit.isFailure(exit)) { replays.delete(key); return }
        // Completion order, counting only finished answers. Pending starts consume none of the 64 slots.
        finishedReplays.add(key)
        if (finishedReplays.size > MAX_REPLAYS) {
          const oldest = finishedReplays.values().next().value!
          finishedReplays.delete(oldest)
          replays.delete(oldest)
        }
      })
      return yield* restore(Deferred.await(first))
    }))

  return { start, cancel, enqueueLine, running: () => new Set(running.keys()) }
}
