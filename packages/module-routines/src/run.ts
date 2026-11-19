// The run of a routine: checked as a whole before anything runs, then its steps one after the other in the module's
// shared scope, each through the gateway as the person and device that started it. One state per routine (`running`),
// one fiber per run, which a module stop interrupts.
import { type CatalogAction, CurrentJob, CurrentPrincipal, CurrentTurn, CurrentTurnTrace, type ModuleHostApi, type ModuleSpeech, type TurnContext } from "@pva/core"
import { type Language, say } from "@pva/module-contracts"
import { Effect, Exit, type Scope } from "effect"
import { nameIn, type Routine, type Step } from "./routines.ts"
import { texts } from "./texts.ts"

/** How long one `say` step may wait for its announcement to be spoken (it waits for quiet on the device first). */
export const SAY_WAIT_MS = 120_000
/** The longest line a step speaks: an announcement's bound. */
export const SPEECH_CHARS = 300

/** Why a routine is refused before it runs (said in one sentence, the step by its number in the owner's list). */
export type Refusal =
  | { readonly kind: "noDevice" | "notHere" | "already" }
  | { readonly kind: "refusedMissing" | "refusedConfirm" | "refusedUnchecked" | "refusedParams"; readonly step: number }

export type StartAnswer = { readonly kind: "started" } | { readonly kind: "refused"; readonly refusal: Refusal; readonly text: string }

/**
 * What a run is doing now: one per routine at a time. Its only continuation is the run's own fiber, and nothing but
 * that fiber ends it (a module stop interrupts it), so no other path can act for a run that is no longer current.
 */
interface RunState {
  readonly runId: number
  readonly routine: Routine
  readonly deviceId: string
  /** The step being run (1-based, the owner's numbering); 0 before the first. */
  step: number
  /** Steps finished, whatever their outcome. */
  finished: number
  /** A `call` step is under way: interrupted now, it may or may not have been done. */
  inCall: boolean
}

export interface Runner {
  /** Check the routine as the calling turn and, if every step may run, start it in the shared scope. Answers at once. */
  readonly start: (routine: Routine, language: Language) => Effect.Effect<StartAnswer>
  /** The routines running now, by key. */
  readonly running: () => ReadonlySet<string>
}

/** The text of a step in the household's language. */
const textOf = (text: Step & { readonly kind: "say" }, language: Language) => (typeof text.text === "string" ? text.text : text.text[language])

/**
 * A line another module answered, made fit to be spoken as an announcement: control characters become spaces, and a
 * line over the bound keeps its whole sentences (or, when the first alone is too long, its words up to the bound, cut
 * at a code point, with an ellipsis).
 */
export const fitSpeech = (text: string, max = SPEECH_CHARS): string => {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  let out = ""
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    const next = out === "" ? sentence : `${out} ${sentence}`
    if (next.length > max) break
    out = next
  }
  if (out !== "") return out
  const points = Array.from(clean)
  let cut = ""
  for (const p of points) {
    if (cut.length + p.length > max - 1) break
    cut += p
  }
  const space = cut.lastIndexOf(" ")
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

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

export const makeRunner = (deps: { readonly host: ModuleHostApi; readonly speech: ModuleSpeech; readonly scope: Scope.Scope; readonly moduleId: string }): Runner => {
  const { host, speech, scope } = deps
  const running = new Map<string, RunState>()
  let runs = 0

  const refusal = (refusal: Refusal, language: Language, name: string): StartAnswer => ({
    kind: "refused",
    refusal,
    text: say(texts, language, refusal.kind, { name, ...("step" in refusal ? { step: refusal.step } : {}) })
  })

  /**
   * Every step checked as the turn that starts it, before anything runs: the routine's own action is offered to this
   * assistant on this device, and each `call` names an action of its catalogue (the gateway's list: the module on for
   * the assistant, the action not switched off, not every class it can have refused by the risk policy) that needs no
   * confirmation, whose class does not depend on its values (then being listed means the policy allows it), and whose
   * parameters the step's values fit.
   */
  const precheck = (routine: Routine): Effect.Effect<Refusal | { readonly kind: "ok"; readonly household: ReadonlySet<string> }> =>
    Effect.gen(function*() {
      const catalogue = yield* host.actions.list
      if (!catalogue.some((a) => a.id === `${deps.moduleId}.${routine.actionId}`)) return { kind: "notHere" }
      const household = new Set<string>()
      for (const [i, step] of routine.steps.entries()) {
        if (step.kind !== "call") continue
        const action = catalogue.find((a) => a.id === `${step.moduleId}.${step.actionId}`)
        if (action === undefined) return { kind: "refusedMissing", step: i + 1 }
        if (action.confirm) return { kind: "refusedConfirm", step: i + 1 }
        if (action.risk === undefined) return { kind: "refusedUnchecked", step: i + 1 }
        if (!paramsFit(action, step.params)) return { kind: "refusedParams", step: i + 1 }
        if (action.sensitivity === "household") household.add(action.id)
      }
      return { kind: "ok", household }
    })

  /** One line on the run's device, waited for: spoken to its end, stopped there, or not spoken (skipped, failed, too late). */
  const speak = (deviceId: string, text: string): Effect.Effect<"spoken" | "stopped" | "not-spoken"> =>
    Effect.gen(function*() {
      const handle = yield* speech.say({ device: deviceId }, text)
      if (!handle.deliveries.some((d) => d.queued)) return "not-spoken" as const
      const outcomes = yield* handle.done.pipe(
        Effect.timeoutOrElse({ duration: SAY_WAIT_MS, orElse: () => Effect.andThen(handle.stop, Effect.succeed(undefined)) })
      )
      const mine = outcomes?.find((o) => o.deviceId === deviceId)
      return mine?.outcome === "spoken" ? "spoken" as const : mine?.outcome === "stopped" ? "stopped" as const : "not-spoken" as const
    }).pipe(Effect.catch(() => Effect.succeed("not-spoken" as const)))

  /** A line said when the run ends, not waited for in a way that could hold anything up. */
  const tell = (deviceId: string, text: string) => Effect.ignore(speak(deviceId, text))

  /** The steps, one after the other, as the starting turn (`source: "routine"`); outside any turn for speech. */
  const runSteps = (state: RunState, stepTurn: TurnContext, household: ReadonlySet<string>, language: Language): Effect.Effect<void> =>
    Effect.gen(function*() {
      const { routine, deviceId } = state
      const name = nameIn(routine.name, language)
      const asStep = <A>(effect: Effect.Effect<A>) => Effect.provideService(effect, CurrentTurn, stepTurn)
      let lastFailed = false
      let spoke = false
      const unconfirmed: Array<number> = []
      for (const [i, step] of routine.steps.entries()) {
        state.step = i + 1
        if (step.kind === "stop_if_failed") {
          if (lastFailed) return yield* tell(deviceId, say(texts, language, "stoppedFailed", { name, step: i }))
          state.finished = i + 1
          continue
        }
        if (step.kind === "say") {
          // The step's own check, as the person and device that started it: the routine is still offered here.
          const catalogue = yield* asStep(host.actions.list)
          if (!catalogue.some((a) => a.id === `${deps.moduleId}.${routine.actionId}`)) return yield* tell(deviceId, say(texts, language, "stoppedRefused", { name, step: i + 1 }))
          const outcome = yield* speak(deviceId, textOf(step, language))
          state.finished = i + 1
          // Stopped on the device (the spoken "stop", the page's Stop, a reply taking the speaker): the person ended it.
          if (outcome === "stopped") return
          lastFailed = outcome !== "spoken"
          if (lastFailed) unconfirmed.push(i + 1)
          else spoke = true
          continue
        }
        state.inCall = true
        const result = yield* asStep(host.actions.run({ moduleId: step.moduleId, actionId: step.actionId, params: step.params }))
        state.inCall = false
        state.finished = i + 1
        if (!result.ok) {
          // A refusal now (the policy, the assistant's switches or the device changed since the check): stop here.
          if (result.code === "refused" || result.code === "needs_confirmation") return yield* tell(deviceId, say(texts, language, "stoppedRefused", { name, step: i + 1 }))
          lastFailed = true
          unconfirmed.push(i + 1)
          continue
        }
        lastFailed = false
        if (result.say !== undefined && result.say.trim() !== "") {
          // The action ran as this turn and answered for this device: said here, and nowhere else. An answer that may
          // be someone's personal content (the action does not declare it the household's) is not read out: the run
          // gets no owner with it to ask the privacy rule about, so it says that it kept it back.
          const outcome = yield* speak(deviceId, household.has(`${step.moduleId}.${step.actionId}`) ? fitSpeech(result.say) : say(texts, language, "withheldAnswer", { step: i + 1 }))
          if (outcome === "stopped") return
          if (outcome === "spoken") spoke = true
        }
      }
      if (unconfirmed.length > 0) {
        const list = unconfirmed.map(String)
        const steps = say(texts, language, list.length === 1 ? "stepOne" : "stepsMany", { list: joinList(list, language === "en" ? "and" : "en") })
        yield* tell(deviceId, say(texts, language, "doneUnconfirmed", { name, steps }))
      } else if (!spoke) yield* tell(deviceId, say(texts, language, "doneQuiet", { name }))
    }).pipe(
      // The module stopped (a restart, a settings save, the server shutting down): nothing resumes. Said on the device
      // while the part is still closing; a server that is going down may not get to say it.
      Effect.onInterrupt(() =>
        Effect.suspend(() => {
          const name = nameIn(state.routine.name, language)
          const text = state.inCall
            ? say(texts, language, "cutShortCall", { name, step: state.step })
            : say(texts, language, "cutShort", { name, done: state.finished, total: state.routine.steps.length })
          return speech.say({ device: state.deviceId }, text).pipe(Effect.ignore, Effect.catchDefect(() => Effect.void))
        })
      )
    )

  const start = (routine: Routine, language: Language): Effect.Effect<StartAnswer> =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const name = nameIn(routine.name, language)
      if (turn?.deviceId === undefined || turn.assistantId === undefined) return refusal({ kind: "noDevice" }, language, name)
      // A second start while it runs is refused (it does not join): one run per routine at a time, reserved at once.
      if (running.has(routine.key)) return refusal({ kind: "already" }, language, name)
      const state: RunState = { runId: ++runs, routine, deviceId: turn.deviceId, step: 0, finished: 0, inCall: false }
      running.set(routine.key, state)
      const release = Effect.sync(() => {
        if (running.get(routine.key)?.runId === state.runId) running.delete(routine.key)
      })
      const checked = yield* precheck(routine).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? release : Effect.void)))
      if (checked.kind !== "ok") {
        yield* release
        return refusal(checked, language, name)
      }
      const stepTurn: TurnContext = { ...turn, source: "routine" }
      // Outside the turn that started it: no turn, trace, job or principal of its own; each step names its turn.
      const run = runSteps(state, stepTurn, checked.household, language).pipe(
        Effect.ensuring(release),
        Effect.provideService(CurrentTurn, undefined),
        Effect.provideService(CurrentTurnTrace, undefined),
        Effect.provideService(CurrentJob, undefined),
        Effect.provideService(CurrentPrincipal, undefined)
      )
      yield* Effect.forkIn(run, scope).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? release : Effect.void)))
      return { kind: "started" as const }
    })

  return { start, running: () => new Set(running.keys()) }
}

/** "1, 2 and 3" / "1, 2 of 3" / "1 en 2". */
export const joinList = (items: ReadonlyArray<string>, last: string): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`
