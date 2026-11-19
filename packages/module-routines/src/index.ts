import { ActionError, defineAction, defineModule, makeTool, type ModuleDefinition, Param } from "@pva/core"
import { homeLanguage, type Language, say } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { LINE_ACTION, makeRunner, type Runner } from "./run.ts"
import { CANCEL_PHRASES, findRoutine, MAX_STEPS, nameIn, type Routine, routinesOf, settings } from "./routines.ts"
import { texts } from "./texts.ts"

export { joinList, LINE_ACTION, MAX_REPLAYS, SAY_WAIT_MS } from "./run.ts"
export { CANCEL_PHRASES, GOOD_MORNING, MAX_ROUTINES, MAX_STEPS, parseSteps, routinesOf, routinesProblem, settings } from "./routines.ts"
export { texts } from "./texts.ts"

/**
 * Routines the owner defines in settings, started by one of their phrases after the wake phrase (no model) or by the
 * tool `routines_run`. What the catalogue can tell is checked first; then the steps run in the module's shared part,
 * one after the other, each a gateway call as the person and device that started it, and the run stops where a step
 * is refused (docs/modules/routines.md).
 */
export const routinesModule = defineModule({
  apiVersion: 2,
  id: "routines",
  name: "Routines",
  description: "Routines and quick commands the owner defines, started by a phrase.",
  enabledByDefault: false,
  settings,
  shared: (ctx) =>
    Effect.gen(function*() {
      // The runs belong to the shared part: they outlive the turn that started them, and end with the module.
      const scope = yield* Effect.scope
      const runner: Runner = makeRunner({ host: ctx.host, speech: ctx.speech, scope, moduleId: "routines" })
      return { value: runner }
    }),
  start: (ctx) =>
    Effect.sync(() => {
      const routines = routinesOf(ctx.settings)
      const language = (): Language => homeLanguage(ctx.host.view())

      /** Start one routine as the calling turn; the answer is a refusal, or nothing (the routine speaks for itself). */
      const begin = (routine: Routine) => ctx.shared.start(routine, language())

      const routineActions = routines.map((routine) => {
        const phrases = {
          ...(routine.phrases.en.length > 0 ? { en: [...routine.phrases.en] } : {}),
          ...(routine.phrases.nl.length > 0 ? { nl: [...routine.phrases.nl] } : {})
        }
        const label = nameIn(routine.name, "en")
        return defineAction({
          id: routine.actionId,
          label: `Run the routine ${label}`,
          description: `Run the owner's routine "${label}" on this device.`,
          examples: [...routine.phrases.en, ...routine.phrases.nl].length > 0 ? [...routine.phrases.en, ...routine.phrases.nl] : [label],
          params: {},
          ...(Object.keys(phrases).length > 0 ? { phrases } : {}),
          // A routine started over a reply replaces it: the reply is not said again after it.
          endsReply: true,
          // Not a tool of its own: the model has `routines_run`. Its phrases are in the assistant's set all the same.
          offerAsTool: false,
          risk: "change",
          run: () => Effect.map(begin(routine), (answer) => (answer.kind === "refused" ? { say: answer.text } : {}))
        })
      })

      // A `say` step is a gateway call: the run calls this action as the person and device that started it, and it
      // enqueues the current step's line of that run on that device and returns; the run waits for the line outside
      // the turn. No phrases (it is not one of the 16), not a tool of the model, and it speaks no text it is given:
      // only the line the owner wrote for that step of a run on that device.
      const line = defineAction({
        id: LINE_ACTION,
        label: "Speak a routine's line",
        description: "Used by a running routine for its say steps; never for a request of the person.",
        examples: ["(a running routine's say step)"],
        params: {
          run: Param.number({ label: "Run", integer: true, min: 1 }),
          step: Param.number({ label: "Step", integer: true, min: 1, max: MAX_STEPS })
        },
        offerAsTool: false,
        risk: "change",
        run: ({ run, step }) =>
          Effect.flatMap(ctx.shared.enqueueLine(run, step), (ok) => (ok ? Effect.succeed({}) : Effect.fail(new ActionError({ message: say(texts, language(), "noLine") }))))
      })

      // The module's own way to cancel: the host's "stop" stops what the device is saying (which ends the routine when it
      // is the routine's line) but gives a module no signal while an action runs. Offered as the tool `routines_stop`.
      const stop = defineAction({
        id: "stop",
        label: "Cancel the routine",
        description: "Cancel the routine running on this device: no further step starts and its line stops. An action already under way may still complete.",
        examples: [...CANCEL_PHRASES.en, ...CANCEL_PHRASES.nl, "stop the good night routine"],
        params: {},
        phrases: { en: [...CANCEL_PHRASES.en], nl: [...CANCEL_PHRASES.nl] },
        endsReply: true,
        risk: "change",
        run: () => Effect.map(ctx.shared.cancel(language()), (answer) => ({ say: answer.text }))
      })

      const run = makeTool({
        name: "routines_run",
        description:
          "Start one of the owner's routines by its name on this device. It runs its steps by itself after you answer, each decided when it runs; it stops where a step is refused.",
        parameters: Schema.Struct({
          name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)).annotate({ description: "The routine's name, as the person said it" })
        }),
        risk: "change",
        execute: ({ name }) =>
          Effect.gen(function*() {
            const lang = language()
            if (routines.length === 0) return { spoken: say(texts, lang, "none") }
            const found = findRoutine(routines, name, lang)
            // A name the person said is never repeated in a refusal.
            if (found.kind === "none") return { spoken: say(texts, lang, "unknown") }
            if (found.kind === "ambiguous") {
              const names = found.routines.map((r) => nameIn(r.name, lang))
              const shown = names.slice(0, 3)
              const list = `${shown.slice(0, -1).join(", ")} ${say(texts, lang, "or")} ${shown.at(-1)}`
              return { spoken: names.length > shown.length
                ? say(texts, lang, "whichMore", { list, count: names.length - shown.length })
                : say(texts, lang, "which", { list }) }
            }
            const answer = yield* begin(found.routine)
            return answer.kind === "refused" ? { spoken: answer.text } : { spoken: say(texts, lang, "started", { name: nameIn(found.routine.name, lang) }) }
          })
      })

      const list = makeTool({
        name: "routines_list",
        description: "List the total and up to three routines, with at most two phrase examples in the household's language, step counts and running state. Omitted routines and phrases are counted.",
        parameters: Schema.Struct({}),
        speculative: true,
        execute: () =>
          Effect.sync(() => {
            const lang = language()
            if (routines.length === 0) return { spoken: say(texts, lang, "none") }
            const now = ctx.shared.running()
            return {
              count: routines.length,
              omitted: Math.max(0, routines.length - 3),
              routines: routines.slice(0, 3).map((r) => ({
                name: nameIn(r.name, lang),
                phrases: r.phrases[lang].slice(0, 2),
                omittedPhrases: Math.max(0, r.phrases[lang].length - 2),
                steps: r.steps.length,
                ...(now.has(r.key) ? { running: true } : {})
              }))
            }
          })
      })

      return {
        tools: [run, list],
        actions: [...routineActions, line, stop],
        instructions: "When the person asks for one of the owner's routines by name, start it with routines_run; it speaks for itself. To cancel one, use routines_stop."
      }
    })
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [routinesModule]
