import { makeExecutionGateway, makeTool, makeToolRegistry } from "@pva/core"
import { Effect, Schema } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { commentOutKeys, makeEnvView } from "../src/envView.ts"
import { makeEnvMover } from "../src/serve/envSettings.ts"
import { makeSections } from "../src/serve/sections.ts"
import { loadSettingsStore } from "../src/serve/SettingsStore.ts"
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


describe("risk override file boundaries (review round 2)", () => {
  for (const read of ["allow", "deny"]) {
    const other = read === "allow" ? "deny" : "allow"
    const files = () => {
      const dir = mkdtempSync(join(tmpdir(), "pva-risk-files-"))
      const paths = [join(dir, "launch.env"), join(dir, "repo.env")]
      paths.forEach((path, i) => writeFileSync(path, `RISK_READ=${i === 0 ? read : other}\n`))
      const load = () => makeEnvView({ processEnv: {}, files: paths.map((path) => ({ path, text: readFileSync(path, "utf8") })) })
      return { dir, paths, load }
    }
    it(`moves every declaration of read=${read} and preserves the decision after restart`, async () => {
      const { dir, paths, load } = files()
      const view = load()
      const store = await run(openStore(dir))
      const sections = makeSections(store, view.record)
      const mover = makeEnvMover({ view, catalog: [], sections, store, host: {} as never, vaultState: () => "none", onMoved: () => {} })
      expect(await run(mover.move(["RISK_READ"]))).toEqual({ ok: true, moved: ["RISK_READ"] })
      expect(paths.map((path) => readFileSync(path, "utf8").includes("RISK_READ="))).toEqual([false, false])
      expect(await lookup(sections)()).toBe(answer(read))
      const restarted = makeSections(await run(openStore(dir)), load().record)
      expect(await lookup(restarted)()).toBe(answer(read))
    })

    it(`keeps read=${read} locked until the file rename, including a restart at that boundary`, async () => {
      const { dir, path, view } = fixture(read)
      const store = await run(openStore(dir))
      const sections = makeSections(store, view.record)
      const paused = latch()
      const gate = latch()
      const mover = makeEnvMover({ view, catalog: [], sections, store, host: {} as never, vaultState: () => "none", onMoved: () => {}, commentOut: async (...args) => {
        paused.resolve()
        await gate.promise
        return commentOutKeys(...args)
      } })
      const move = run(mover.move(["RISK_READ"]))
      await paused.promise
      let edit, locked, pending, restarted
      try {
        locked = sections.list().find((s) => s.id === "risk")!.form.fields.find((f) => f.key === "RISK_READ")!.locked
        edit = await run(sections.update("risk", { values: { RISK_READ: other }, secrets: {} }))
        pending = await lookup(sections)()
        const diskView = makeEnvView({ processEnv: {}, files: [{ path, text: readFileSync(path, "utf8") }] })
        restarted = await lookup(makeSections(await run(loadSettingsStore(dir, { readOnly: true })), diskView.record))()
      } finally { gate.resolve(); await move }
      expect(locked).toBeDefined()
      expect(edit!.result.ok).toBe(false)
      expect([pending, restarted]).toEqual([answer(read), answer(read)])
      expect(view.get("RISK_READ")).toBeUndefined()
      expect((await run(sections.update("risk", { values: { RISK_READ: other }, secrets: {} }))).result.ok).toBe(true)
      expect(await lookup(makeSections(await run(openStore(dir)), {}))()).toBe(answer(other))
    })

    for (const failureAt of [0, 1]) {
      it(`a failed rewrite ${failureAt + 1} keeps read=${read} locked and restart-safe, then retry removes all declarations`, async () => {
        const { dir, paths, load } = files()
        const view = load()
        const store = await run(openStore(dir))
        const sections = makeSections(store, view.record)
        let writes = 0
        let fail = true
        const mover = makeEnvMover({ view, catalog: [], sections, store, host: {} as never, vaultState: () => "none", onMoved: () => {}, commentOut: async (...args) => {
          if (fail && writes++ === failureAt) { fail = false; throw new Error("single failed rewrite") }
          return commentOutKeys(...args)
        } })
        const result = await run(mover.move(["RISK_READ"]))
        expect(result.ok).toBe(false)
        expect(view.get("RISK_READ")).toBe(read)
        expect((await run(sections.update("risk", { values: { RISK_READ: other }, secrets: {} }))).result.ok).toBe(false)
        expect(await lookup(sections)()).toBe(answer(read))
        expect(await lookup(makeSections(await run(loadSettingsStore(dir, { readOnly: true })), load().record))()).toBe(answer(read))
        expect(await run(mover.move(["RISK_READ"]))).toEqual({ ok: true, moved: ["RISK_READ"] })
        expect(paths.map((path) => readFileSync(path, "utf8").includes("RISK_READ="))).toEqual([false, false])
        expect(await lookup(makeSections(await run(openStore(dir)), load().record))()).toBe(answer(read))
      })
    }
  }
})

describe("moving Home language (review round 2)", () => {
  for (const moveFirst of [true, false]) {
    it(`an overlapping Home save ${moveFirst ? "after a successful" : "before a failed"} language move preserves Dutch on the page and gateway`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pva-language-move-"))
      const path = join(dir, ".env")
      const text = "HOME_LANGUAGE=nl-NL\n"
      writeFileSync(path, text)
      const view = makeEnvView({ processEnv: {}, files: [{ path, text }] })
      const paused = latch()
      const gate = latch()
      const queued = latch()
      let armed = false
      let writes = 0
      const store = await run(openStore(dir, { beforeStep: async (step) => {
        if (!armed || step !== "journal") return
        if (++writes === 1) { paused.resolve(); await gate.promise }
        else if (!moveFirst && writes === 2) throw new Error("single failed move journal")
      } }))
      await run(store.saveAssistant(["HOME_LANGUAGE"], { HOME_LANGUAGE: "en-GB" }, {}))
      const wrapped = { ...store, saveAssistant: (...args: Parameters<typeof store.saveAssistant>) => { queued.resolve(); return store.saveAssistant(...args) } }
      const sections = makeSections(moveFirst ? wrapped : store, view.record)
      const mover = makeEnvMover({ view, catalog: [], sections, store: moveFirst ? store : wrapped, host: {} as never, vaultState: () => "none", onMoved: () => {} })
      const home = () => run(sections.update("home", { values: { HOME_LOCATION: "Sydney" }, secrets: {} }))
      const move = () => run(mover.move(["HOME_LANGUAGE"]))
      armed = true
      const first = moveFirst ? move() : home()
      await paused.promise
      const second = moveFirst ? home() : move()
      await queued.promise
      gate.resolve()
      const results = await Promise.all([first, second])
      expect(results[moveFirst ? 0 : 1]).toMatchObject({ ok: moveFirst })
      expect(results[moveFirst ? 1 : 0]).toMatchObject({ result: { ok: true } })
      expect(sections.list().find((s) => s.id === "home")!.form.values.HOME_LANGUAGE).toBe("nl-NL")
      expect(sections.riskLanguage()).toBe("nl")
      const registry = makeToolRegistry([{ name: "probe", tools: [makeTool({ name: "send", description: "", risk: "message", parameters: Schema.Struct({}), execute: () => Effect.succeed("sent") })] }], { gateway: makeExecutionGateway({ policy: sections.riskPolicy, language: sections.riskLanguage }) })
      expect((await run(registry.run({ id: "x", name: "send", input: {} }))).content).toMatch(/^Niet uitgevoerd:/)
      expect(readFileSync(path, "utf8").includes("HOME_LANGUAGE=")).toBe(!moveFirst)
      const restartedView = makeEnvView({ processEnv: {}, files: [{ path, text: readFileSync(path, "utf8") }] })
      expect(makeSections(await run(openStore(dir)), restartedView.record).riskLanguage()).toBe("nl")
    })
  }
})
