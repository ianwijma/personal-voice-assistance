// P7 review round 1 (b3, E3): serve mode's phrase sets are prepared ahead of use and keyed by what they depend on. A
// final reads a ready set (the host's controls alone while it is not ready); an assistant object replaced by an equal
// one (an environment override, an unrelated save) keeps its set without compiling it again; a module change prepares
// it again, reusing it when the actions with phrases are the same.
import { defineAction, hostCommandSet, makeExecutionGateway, matchCommand, type ModulePart, registerActions } from "@pva/core"
import { exampleAssistant } from "@pva/protocol/examples"
import { Effect, Exit, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { withEnvironment } from "../src/serve/migrateAssistants.ts"
import { makeReplyVolumes, makeServePhrases } from "../src/serve/phraseCommands.ts"

const moduleOf = (m: number, a = 16) => {
  const actions = registerActions(`module-${m}`, Array.from({ length: a }, (_, i) =>
    defineAction({ id: `action_${i}`, label: "Action", description: "Action.", params: {}, phrases: { en: Array.from({ length: 8 }, (_, v) => `please module${m} action${i} variant${v} now`) }, run: () => Effect.void })))
  return { moduleId: `module-${m}`, module: { name: `module-${m}`, intentActions: actions }, instructions: "" } satisfies ModulePart
}

describe("serve mode's phrase sets (E3)", () => {
  it("b3: ready ahead of use; an equal assistant object keeps its set; a module change prepares it again", async () => {
    const scope = Effect.runSync(Scope.make())
    try {
      let parts: ReadonlyArray<ModulePart> = Array.from({ length: 32 }, (_, m) => moduleOf(m))
      let snapshot = { version: 1 } as never as { version: number }
      let assistant = { ...exampleAssistant, id: "assistant", on: true }
      const issues: Array<unknown> = []
      let listener: (() => void) | undefined
      const phrases = await Effect.runPromise(makeServePhrases({
        host: {
          snapshot: () => snapshot as never,
          issues: { set: (_s: string, list: ReadonlyArray<unknown>) => void issues.push(list), all: () => [], subscribe: () => () => undefined } as never,
          gateway: makeExecutionGateway(),
          pageText: (_m, t) => String(t),
          service: () => undefined,
          subscribe: (l: () => void) => ((listener = l), () => undefined)
        } as never,
        assistants: () => new Map([[assistant.id, assistant]]),
        partsOf: () => parts,
        language: () => "en",
        notify: {} as never,
        ringingAllowed: () => false,
        room: () => undefined,
        volume: makeReplyVolumes(() => undefined).service,
        log: () => undefined
      }).pipe(Scope.provide(scope)))
      // Not ready yet (no preparation has run): the host's controls alone, so a module phrase is not taken; a control is.
      expect(phrases.commandsFor("assistant")).toEqual(hostCommandSet("en"))
      expect(matchCommand(phrases.commandsFor("assistant"), "please module3 action4 variant5 now")).toBeUndefined()
      expect(matchCommand(phrases.commandsFor("assistant"), "louder")).toMatchObject({ kind: "control", control: "louder" })
      await Effect.runPromise(phrases.sets.settled)
      const set = phrases.commandsFor("assistant")
      expect(set.phrases.filter((p) => p.owner.kind === "action")).toHaveLength(256)
      expect(phrases.sets.stats().compiled).toBe(1)
      expect(issues.length).toBeGreaterThan(0)
      // Twelve equal assistant objects (an environment override makes a fresh one each time): the same set, nothing compiled.
      for (let i = 0; i < 12; i++) {
        assistant = { ...withEnvironment({ ...exampleAssistant, id: "assistant" }, { env: { SYSTEM_PROMPT: `Prompt ${i}` } } as never).assistant, on: true }
        const t = performance.now()
        expect(phrases.commandsFor("assistant")).toBe(set)
        expect(performance.now() - t).toBeLessThan(5)
      }
      await Effect.runPromise(phrases.sets.settled)
      expect(phrases.sets.stats().compiled).toBe(1)
      // A module change (a new snapshot) with the same actions: prepared again (a reuse needs no steps), the same set.
      snapshot = { version: 2 }
      listener?.()
      await Effect.runPromise(phrases.sets.settled)
      expect(phrases.commandsFor("assistant")).toBe(set)
      expect(phrases.sets.stats()).toMatchObject({ compiled: 1, reused: 1 })
      // Other actions: compiled again.
      parts = [moduleOf(99, 1)]
      snapshot = { version: 3 }
      await Effect.runPromise(phrases.sets.settled)
      expect(phrases.sets.stats().compiled).toBe(2)
      expect(matchCommand(phrases.commandsFor("assistant"), "please module99 action0 variant0 now")).toMatchObject({ kind: "command" })
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })
})
