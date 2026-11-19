import { makeExecutionGateway, makeTool, makeToolRegistry } from "@pva/core"
import { Effect, Schema } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeEnvView } from "../src/envView.ts"
import { makeEnvMover } from "../src/serve/envSettings.ts"
import { makeSections } from "../src/serve/sections.ts"
import { openStore } from "./support/store.ts"

const run = Effect.runPromise
const latch = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const fixture = (read: string) => {
  const dir = mkdtempSync(join(tmpdir(), "pva-risk-move-"))
  const path = join(dir, ".env")
  const text = `RISK_READ=${read}\n`
  writeFileSync(path, text)
  return { dir, path, view: makeEnvView({ processEnv: {}, files: [{ path, text }] }) }
}
const lookup = (sections: ReturnType<typeof makeSections>) => {
  const registry = makeToolRegistry([{ name: "probe", tools: [makeTool({ name: "look", description: "", risk: "read", parameters: Schema.Struct({}), execute: () => Effect.succeed("OK") })] }], { gateway: makeExecutionGateway({ policy: sections.riskPolicy }) })
  return async () => (await run(registry.run({ id: "x", name: "look", input: {} }))).content
}
const answer = (read: string) => read === "allow" ? "OK" : "Not run: it would look something up, which this household does not allow."

describe("moving a risk override", () => {
  for (const read of ["allow", "deny"]) {
    const saved = read === "allow" ? "deny" : "allow"
    it(`an overlapping successful risk save preserves moved read=${read}, also after restart`, async () => {
      const { dir, path, view } = fixture(read)
      let inject = false
      const paused = latch()
      const gate = latch()
      const queued = latch()
      const store = await run(openStore(dir, { beforeStep: async (step) => {
        if (inject && step === "journal") { inject = false; paused.resolve(); await gate.promise }
      } }))
      await run(store.saveAssistant(["RISK_READ"], { RISK_READ: saved }, {}))
      const sections = makeSections({ ...store, saveAssistant: (...args) => {
        queued.resolve()
        return store.saveAssistant(...args)
      } }, view.record)
      const mover = makeEnvMover({ view, catalog: [], sections, store, host: {} as never, vaultState: () => "none", onMoved: () => {} })
      inject = true
      const move = run(mover.move(["RISK_READ"]))
      await paused.promise
      const edit = run(sections.update("risk", { values: { RISK_MESSAGE: "deny" }, secrets: {} }))
      await queued.promise
      gate.resolve()
      const [moved, edited] = await Promise.all([move, edit])
      expect([moved.ok, edited.result.ok]).toEqual([true, true])
      expect(readFileSync(path, "utf8")).not.toMatch(/^RISK_READ=/m)
      expect(store.settings().assistant).toMatchObject({ RISK_READ: read, RISK_MESSAGE: "deny" })
      expect(await lookup(sections)()).toBe(answer(read))
      const reopened = makeSections(await run(openStore(dir)), {})
      expect(reopened.riskPolicy().read).toBe(read)
      expect(await lookup(reopened)()).toBe(answer(read))
    })

    it(`a failed move keeps read=${read} on the page and gateway while pending and after return`, async () => {
      const { dir, path, view } = fixture(read)
      let inject = false
      let writes = 0
      const homePaused = latch()
      const homeGate = latch()
      const movePaused = latch()
      const moveGate = latch()
      const queued = latch()
      const store = await run(openStore(dir, { beforeStep: async (step) => {
        if (!inject || step !== "journal") return
        if (++writes === 1) { homePaused.resolve(); await homeGate.promise }
        else if (writes === 2) { movePaused.resolve(); await moveGate.promise; throw new Error("failed move journal") }
      } }))
      await run(store.saveAssistant(["RISK_READ"], { RISK_READ: saved }, {}))
      const sections = makeSections(store, view.record)
      const mover = makeEnvMover({ view, catalog: [], sections, store: { ...store, saveAssistant: (...args) => {
        queued.resolve()
        return store.saveAssistant(...args)
      } }, host: {} as never, vaultState: () => "none", onMoved: () => {} })
      const call = lookup(sections)
      const state = async () => ({ page: sections.list().find((s) => s.id === "risk")!.form.values.RISK_READ, record: sections.riskPolicy().read, result: await call() })
      inject = true
      const home = run(sections.update("home", { values: { HOME_LOCATION: "Sydney" }, secrets: {} }))
      await homePaused.promise
      const move = run(mover.move(["RISK_READ"]))
      await queued.promise
      homeGate.resolve()
      await movePaused.promise
      const pending = await state()
      moveGate.resolve()
      const [homeResult, moved] = await Promise.all([home, move])
      const returned = await state()
      expect(homeResult.result.ok).toBe(true)
      expect(moved).toMatchObject({ ok: false, moved: [] })
      expect({ pending, returned }).toEqual({ pending: { page: read, record: read, result: answer(read) }, returned: { page: read, record: read, result: answer(read) } })
      expect(view.get("RISK_READ")).toBe(read)
      expect(readFileSync(path, "utf8")).toBe(`RISK_READ=${read}\n`)
    })
  }
})
