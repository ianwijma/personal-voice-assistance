import { Deferred, Effect, type Scope } from "effect"
import type { RegisteredAction } from "./Actions.ts"
import {
  actionPhraseTexts,
  actionsByModule,
  assembleCommandSet,
  type CommandSet,
  type CompiledPhrase,
  compileActionPhrase,
  PHRASE_LIMITS,
  phraseConflictIssues,
  type PhraseLanguage,
  PREPARE_STEP_WORK,
  type PhraseWork
} from "./Phrases.ts"

/**
 * Phrase sets prepared ahead of use (docs/PHRASES.md "Sets are prepared ahead"; review round 1, E3). A recogniser's
 * final only reads a set that is ready for exactly what it depends on now; building one happens here, when something it
 * depends on changed, in bounded steps with a real yield to the event loop between them, never on a final. A step is
 * measured by the normalising it did (`PhraseWork`: one unit per phrase or choice name, each at most 80 characters), not
 * by modules: it yields once `PREPARE_STEP_WORK` units are done (review round 2, a2), and a choice's names are prepared
 * once, however many phrases read it, so one step is at most 256 units and one phrase's two new choices (2 × 96). A final whose set is not ready matches the host's
 * controls alone: they are reserved, so no module phrase can match the same words with more literal words, and the
 * answer is the one the full set would give whenever a control is said.
 *
 * Keys: `inputKey(assistant)` (cheap, read at every final) names what the set depends on (serve mode: the module snapshot's
 * version, the household's language, the assistant's module choices; never the identity of an assistant object), and
 * the content key (made while preparing) the language and the identities of the published actions with phrases, so a
 * change that keeps the same actions keeps the same set without compiling it again.
 */
export interface PhraseSetInputs {
  readonly language: () => PhraseLanguage
  /** The assistants whose sets are kept (serve mode: the switched-on ones). */
  readonly assistants: () => ReadonlyArray<{ readonly id: string; readonly name: string }>
  /** What `assistant`'s set depends on now (cheap: a final reads it); equal keys mean the same set. */
  readonly inputKey: (assistant: string) => string
  /** The actions `assistant`'s turns are offered now (read while preparing only). */
  readonly actionsOf: (assistant: string) => ReadonlyArray<RegisteredAction>
}

export interface PhraseSets {
  /** `assistant`'s set if it is ready for its inputs now; otherwise `undefined` (and a preparation is asked for). */
  readonly ready: (assistant: string) => CommandSet | undefined
  /** Something the sets depend on changed: prepare again (coalesced; in the background). */
  readonly changed: () => void
  /** Completes once nothing is left to prepare (the kit and tests; it asks for a pass first). */
  readonly settled: Effect.Effect<void>
  /** The Health page's issues of the ready sets (source `phrases`). */
  readonly issues: () => ReadonlyArray<ReturnType<typeof phraseConflictIssues>[number]>
  /** Preparations done, sets compiled (tests, the latency test). */
  readonly stats: () => { readonly passes: number; readonly compiled: number; readonly reused: number }
}

export interface PhraseSetOptions {
  /** One step's yield. Default: a macrotask (`setImmediate`), so audio framing and sockets run between steps. */
  readonly yieldStep?: Effect.Effect<void>
  /** Called after a pass, when the ready sets may have changed (serve mode puts the Health issues in the registry). */
  readonly onPrepared?: () => void
}

/** A yield to the event loop (not only to other fibers). */
export const macrotask: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const t = setImmediate(() => resume(Effect.void))
  return Effect.sync(() => clearImmediate(t))
})

interface Entry {
  readonly key: string
  readonly contentKey: string
  readonly set: CommandSet
  readonly name: string
}

export const makePhraseSets = (inputs: PhraseSetInputs, options: PhraseSetOptions = {}): Effect.Effect<PhraseSets, never, Scope.Scope> =>
  Effect.gen(function*() {
    const yieldStep = options.yieldStep ?? macrotask
    const entries = new Map<string, Entry>()
    const ids = new WeakMap<RegisteredAction, number>()
    let nextId = 1
    const idOf = (a: RegisteredAction) => {
      let id = ids.get(a)
      if (id === undefined) {
        id = nextId++
        ids.set(a, id)
      }
      return id
    }
    let dirty = true
    /** Completed (and replaced) by every change: the idle loop waits for it. */
    let signal = Deferred.makeUnsafe<void>()
    /** Waiting for the next moment nothing is left to prepare. */
    const idle: Array<Deferred.Deferred<void>> = []
    const counters = { passes: 0, compiled: 0, reused: 0 }

    const changed = () => {
      dirty = true
      const was = signal
      signal = Deferred.makeUnsafe<void>()
      Deferred.doneUnsafe(was, Effect.void)
    }

    /** One assistant's set, step by step: a phrase at a time, a yield after every `PREPARE_STEP_WORK` units of work. */
    const prepare = (language: PhraseLanguage, actions: ReadonlyArray<RegisteredAction>) =>
      Effect.gen(function*() {
        const modules: Array<{ readonly moduleId: string; readonly phrases: ReadonlyArray<CompiledPhrase> }> = []
        const over: Array<string> = []
        const work: PhraseWork = { units: 0 }
        let count = 0
        for (const m of actionsByModule(actions)) {
          if (over.length > 0) {
            if (m.actions.some((a) => a.definition.phrases?.[language] !== undefined)) over.push(m.moduleId)
            continue
          }
          const phrases: Array<CompiledPhrase> = []
          for (const a of m.actions) {
            for (const text of actionPhraseTexts(language, a)) {
              const compiled = compileActionPhrase(language, a, text, work)
              if (compiled !== undefined) phrases.push(compiled)
              if (work.units >= PREPARE_STEP_WORK) {
                work.units = 0
                yield* yieldStep
              }
            }
          }
          if (phrases.length > 0) {
            if (count + phrases.length > PHRASE_LIMITS.phrasesPerAssistant) over.push(m.moduleId)
            else {
              count += phrases.length
              modules.push({ moduleId: m.moduleId, phrases })
            }
          }
        }
        return assembleCommandSet(language, modules, over)
      })

    const pass = Effect.gen(function*() {
      counters.passes++
      const language = inputs.language()
      const wanted = inputs.assistants()
      for (const a of wanted) {
        const key = inputs.inputKey(a.id)
        const known = entries.get(a.id)
        if (known?.key === key) continue
        const actions = inputs.actionsOf(a.id).filter((x) => x.definition.phrases !== undefined)
        const contentKey = `${language}|${actions.map((x) => `${x.id}#${idOf(x)}`).join(",")}`
        if (known?.contentKey === contentKey) {
          counters.reused++
          entries.set(a.id, { ...known, key, name: a.name })
          continue
        }
        const set = yield* prepare(language, actions)
        counters.compiled++
        // Built for the inputs read before the steps: a change during them marks the pass dirty, and the next pass sees
        // the key differ again if it mattered.
        entries.set(a.id, { key, contentKey, set, name: a.name })
        yield* yieldStep
      }
      const keep = new Set(wanted.map((a) => a.id))
      for (const id of [...entries.keys()]) if (!keep.has(id)) entries.delete(id)
      try {
        options.onPrepared?.()
      } catch {
        // A throwing observer must not stop the preparations.
      }
    })

    const loop = Effect.gen(function*() {
      for (;;) {
        if (!dirty) {
          for (const done of idle.splice(0)) Deferred.doneUnsafe(done, Effect.void)
          yield* Deferred.await(signal)
          continue
        }
        dirty = false
        yield* pass.pipe(Effect.catchCause((cause) => Effect.logWarning("Phrase sets could not be prepared", cause)))
      }
    })
    yield* Effect.forkScoped(loop)

    const sets: PhraseSets = {
      ready: (assistant) => {
        const entry = entries.get(assistant)
        if (entry === undefined || entry.key !== inputs.inputKey(assistant)) {
          changed()
          return undefined
        }
        return entry.set
      },
      changed,
      settled: Effect.suspend(() => {
        const done = Deferred.makeUnsafe<void>()
        idle.push(done)
        changed()
        return Deferred.await(done)
      }),
      issues: () => [...entries.entries()].flatMap(([id, e]) => phraseConflictIssues({ id, name: e.name }, e.set)),
      stats: () => ({ ...counters })
    }
    return sets
  })
