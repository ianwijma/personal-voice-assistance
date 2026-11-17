// Serve mode's resource pool (docs/ASSISTANTS.md §3.2, WP-9) against the real server with the scripted client: each
// assistant's conversation answers from the language-model instance of its own `llm` settings, and a model change
// applies at that assistant's next turn start without a reload and without interrupting another device's turn.
import { Llm, type LlmEvent } from "@pva/core"
import type { Assistant, ServerMessage, ServerMessageOf } from "@pva/protocol"
import { Deferred, Effect, Exit, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type LlmBuilder, ResourceBuildError } from "../src/serve/Resources.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

/**
 * Instances that answer "<model>#<n>: <text>". A model in `holds` keeps each of its streams open (after the first
 * word) until its gate opens: a turn in progress. A model in `failing` cannot be built.
 */
const fakeModels = () => {
  const builds: Array<string> = []
  const requests: Array<string> = []
  const holds = new Map<string, Deferred.Deferred<void>>()
  const failing = new Set<string>()
  const build: LlmBuilder = (spec) =>
    Effect.gen(function*() {
      if (failing.has(spec.model)) return yield* new ResourceBuildError({ message: `The model ${spec.model} could not start.` })
      builds.push(spec.model)
      const name = `${spec.model}#${builds.length}`
      return Llm.of({
        stream: (request) =>
          Stream.suspend(() => {
            const last = request.messages.at(-1)
            const text = last?.role === "user" ? last.content : ""
            requests.push(`${name}: ${text}`)
            const hold = holds.get(spec.model)
            return Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: `${name}: ` }]).pipe(
              Stream.concat(Stream.fromEffectDrain(hold === undefined ? Effect.void : Deferred.await(hold))),
              Stream.concat(Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text }, { _tag: "Done", stopReason: "end" }]))
            )
          })
      })
    })
  return { build, builds, requests, holds, failing }
}

/**
 * A data directory with two assistants on the browser defaults, Alpha and Bravo (as in serveAssistants.test.ts), each
 * on the Anthropic account with its own model. Made from the migrated default install, then edited.
 */
const withModels = async (models: { alpha: string; bravo: string }): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-resources-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
  const base = file.assistants.byId[file.assistants.order[0]]
  const make = (id: "alpha" | "bravo", name: string) => ({ ...base, id, rev: 0, name, prompt: `You are ${name}.`, llm: { ...base.llm, account: "anthropic", model: models[id] } })
  file.assistants = { order: ["alpha", "bravo"], byId: { alpha: make("alpha", "Alpha"), bravo: make("bravo", "Bravo") } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: "bravo", phrases: ["hey bravo"] }],
    withoutPhrase: { mode: "nobody" }
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

const start = async (dataDir: string, models: ReturnType<typeof fakeModels>) => {
  server = await startTestServer({
    build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "the build's model").llm }),
    buildLlm: models.build,
    resourceGraceMs: 100,
    dataDir
  })
}

const connect = async (deviceId?: string) => {
  const client = await ScriptedClient.connect({ url: server!.url, ...(deviceId !== undefined ? { deviceId } : {}) })
  clients.push(client)
  return client
}

/** Type `text` to `assistantId`; resolves with the turn's end and its text once the turn has ended. */
const typed = (client: ScriptedClient, assistantId: string, text: string, id: string) => {
  const from = client.messages.length
  client.send({ type: "text.send", requestId: id, text, speak: false, assistantId })
  return (async () => {
    expect((await client.waitFor("result", (m) => m.requestId === id, { from })).ok).toBe(true)
    const start = await client.waitFor("turn.start", (m) => m.assistantId === assistantId, { from, timeoutMs: 10_000 })
    const end = await client.waitFor("turn.end", (m) => m.turnId === start.turnId, { from, timeoutMs: 10_000 })
    const reply = client.messages
      .slice(from)
      .filter((m): m is ServerMessageOf<"assistant.text"> => m.type === "assistant.text" && m.turnId === end.turnId)
      .map((m) => m.text)
      .join("")
    const errors = client.messages.slice(from).filter((m): m is ServerMessageOf<"error"> => m.type === "error")
    return { end, reply, errors }
  })()
}

const until = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

const assistantOf = (id: string): Assistant => server!.handle.store.assistants().find((a) => a.id === id)!
const saveModel = (id: string, model: string) => {
  const a = assistantOf(id)
  return Effect.runPromise(server!.handle.store.saveAssistantRecord({ ...a, llm: { ...a.llm, model } }))
}

describe("serve: language models from the resource pool (WP-9)", () => {
  it("two assistants with different models answer from their own instance; identical settings share one", async () => {
    const models = fakeModels()
    await start(await withModels({ alpha: "model-a", bravo: "model-b" }), models)
    expect(models.builds.sort()).toEqual(["model-a", "model-b"]) // built before the first turn
    const voice = await connect("device-a")
    await voice.hello()
    expect((await typed(voice, "alpha", "hello alpha", "t1")).reply).toMatch(/^model-a#\d: hello alpha$/)
    expect((await typed(voice, "bravo", "hello bravo", "t2")).reply).toMatch(/^model-b#\d: hello bravo$/)

    // Admin sees both resources, each with its user.
    const admin = await connect()
    const welcome = await admin.admin(TEST_ADMIN_PASSWORD)
    const resources = (welcome.snapshot.engine.resources ?? []).filter((r) => r.kind === "llm")
    expect(resources.map((r) => [r.key.split("|")[1], r.state, r.usedBy]).sort()).toEqual([
      ["model-a", "ready", ["alpha"]],
      ["model-b", "ready", ["bravo"]]
    ])

    // Bravo moves to Alpha's model: one shared instance, nothing new built.
    await saveModel("bravo", "model-a")
    await until("bravo on model-a", () => server!.handle.resources.keyFor("bravo") === server!.handle.resources.keyFor("alpha"))
    expect(server!.handle.resources.llmFor("bravo")).toBe(server!.handle.resources.llmFor("alpha"))
    expect(models.builds).toHaveLength(2)
    expect((await typed(voice, "bravo", "same model", "t3")).reply).toMatch(/^model-a#\d: same model$/)
    // The unused model-b instance goes after the grace period.
    const models_ = () => server!.handle.resources.status().filter((r) => r.kind === "llm")
    await until("model-b released", () => models_().length === 1)
    expect(models_()[0]).toMatchObject({ state: "ready", usedBy: ["alpha", "bravo"] })
  })

  it("a model change on Alpha does not interrupt a turn in progress on another device, and applies at Alpha's next turn; no engine reload", async () => {
    const models = fakeModels()
    await start(await withModels({ alpha: "model-a", bravo: "model-b" }), models)
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const deviceA = await connect("device-a")
    await deviceA.hello()
    const deviceB = await connect("device-b")
    await deviceB.hello()

    // Turns in progress: Bravo on device B, and Alpha itself on device A (both held mid-reply).
    const bravoGate = Deferred.makeUnsafe<void>()
    const alphaGate = Deferred.makeUnsafe<void>()
    models.holds.set("model-b", bravoGate)
    models.holds.set("model-a", alphaGate)
    const bravoTurn = typed(deviceB, "bravo", "long story", "b1")
    const alphaTurn = typed(deviceA, "alpha", "old question", "a1")
    await until("both requests sent", () => models.requests.length === 2)

    const from = admin.messages.length
    await saveModel("alpha", "model-a2")
    await until("model-a2 ready", () => server!.handle.resources.status().some((r) => r.key.includes("|model-a2|") && r.state === "ready"))
    await until("alpha bound to model-a2", () => server!.handle.resources.keyFor("alpha")?.includes("|model-a2|") === true)

    // Both turns still run; they finish on the instances they started with.
    Deferred.doneUnsafe(bravoGate, Exit.void)
    Deferred.doneUnsafe(alphaGate, Exit.void)
    const b = await bravoTurn
    const a = await alphaTurn
    expect(b.end.outcome).toBe("completed")
    expect(b.reply).toMatch(/^model-b#\d: long story$/)
    expect(a.end.outcome).toBe("completed")
    expect(a.reply).toMatch(/^model-a#\d: old question$/)

    // Alpha's next turn (on either device) uses the new model; Bravo is unchanged.
    expect((await typed(deviceA, "alpha", "new question", "a2")).reply).toMatch(/^model-a2#\d: new question$/)
    expect((await typed(deviceB, "alpha", "from b", "a3")).reply).toMatch(/^model-a2#\d: from b$/)
    expect((await typed(deviceB, "bravo", "still b", "b2")).reply).toMatch(/^model-b#\d: still b$/)
    // Alpha's history carried over the switch (same conversation).
    expect(models.requests.filter((r) => r.startsWith("model-a2"))).toHaveLength(2)

    // No reload: the engine stayed ready, and the old instance was released after the grace period.
    const states = admin.messages.slice(from).flatMap((m: ServerMessage) => (m.type === "engine" ? [m.engine.state] : []))
    expect(states.every((s) => s === "ready")).toBe(true)
    await until("model-a released", () => !server!.handle.resources.status().some((r) => r.key.includes("|model-a|")))
    expect(server!.handle.engine.status().state).toBe("ready")
  })

  it("a failing instance shows its problem in the status; that assistant's turn fails with turn_failed; the other assistant answers", async () => {
    const models = fakeModels()
    models.failing.add("broken")
    await start(await withModels({ alpha: "model-a", bravo: "broken" }), models)
    const admin = await connect()
    const welcome = await admin.admin(TEST_ADMIN_PASSWORD)
    expect(welcome.snapshot.engine.state).toBe("ready")
    const broken = (welcome.snapshot.engine.resources ?? []).find((r) => r.kind === "llm" && r.usedBy.includes("bravo"))
    expect(broken).toMatchObject({ kind: "llm", state: "failed", problem: "The model broken could not start." })

    const voice = await connect("device-a")
    await voice.hello()
    const failed = await typed(voice, "bravo", "hello", "t1")
    expect(failed.end.outcome).toBe("failed")
    expect(failed.errors.map((e) => e.error.code)).toContain("turn_failed")
    expect((await typed(voice, "alpha", "hello", "t2")).reply).toMatch(/^model-a#\d: hello$/)

    // Fixed by a new model: built, bound, answering.
    await saveModel("bravo", "model-b")
    await until("bravo ready", () => server!.handle.resources.status().some((r) => r.kind === "llm" && r.usedBy.includes("bravo") && r.state === "ready"))
    expect((await typed(voice, "bravo", "again", "t3")).reply).toMatch(/^model-b#\d: again$/)
    // The failed instance is gone at once (it held nothing a turn needs).
    expect(server!.handle.resources.status().some((r) => r.kind === "llm" && r.state === "failed")).toBe(false)
  })
})
