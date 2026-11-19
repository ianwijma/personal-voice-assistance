import { defineAction, defineModule, makeTool, type ModuleDefinition } from "@pva/core"
import { homeLanguage, type Language, say } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { makeRunner, type Runner } from "./run.ts"
import { findRoutine, nameIn, type Routine, routinesOf, settings } from "./routines.ts"
import { texts } from "./texts.ts"

export { fitSpeech, joinList, SAY_WAIT_MS } from "./run.ts"
export { GOOD_MORNING, MAX_ROUTINES, MAX_STEPS, parseSteps, routinesOf, routinesProblem, settings } from "./routines.ts"
export { texts } from "./texts.ts"

/**
 * Routines the owner defines in settings, started by one of their phrases after the wake phrase (no model) or by the
 * tool `routines_run`. Each run is checked as a whole first, then runs in the module's shared part, one step after the
 * other, each through the gateway as the person and device that started it (docs/modules/routines.md).
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

      const actions = routines.map((routine) => {
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
          run: () =>
            Effect.map(begin(routine), (answer) => (answer.kind === "refused" ? { say: answer.text } : {}))
        })
      })

      const run = makeTool({
        name: "routines_run",
        description:
          "Start one of the owner's routines by its name on this device. It runs its steps by itself after you answer; a routine with a step this assistant may not do here is refused as a whole.",
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
              return { spoken: say(texts, lang, "which", { list: names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${say(texts, lang, "or")} ${names.at(-1)}` }) }
            }
            const answer = yield* begin(found.routine)
            const routineName = nameIn(found.routine.name, lang)
            return answer.kind === "refused" ? { spoken: answer.text } : { spoken: say(texts, lang, "started", { name: routineName }) }
          })
      })

      const list = makeTool({
        name: "routines_list",
        description: "List the owner's routines: each one's name, the phrases that start it in the household's language, how many steps it has, and whether it is running now.",
        parameters: Schema.Struct({}),
        speculative: true,
        execute: () =>
          Effect.sync(() => {
            const lang = language()
            if (routines.length === 0) return { spoken: say(texts, lang, "none") }
            const now = ctx.shared.running()
            return {
              count: routines.length,
              routines: routines.map((r) => ({
                name: nameIn(r.name, lang),
                phrases: [...r.phrases[lang]],
                steps: r.steps.length,
                ...(now.has(r.key) ? { running: true } : {})
              }))
            }
          })
      })

      return {
        tools: [run, list],
        actions,
        instructions: "When the person asks for one of the owner's routines by name, start it with routines_run; it speaks for itself."
      }
    })
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [routinesModule]
