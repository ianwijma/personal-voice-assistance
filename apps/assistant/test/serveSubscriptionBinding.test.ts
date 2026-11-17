// Serve mode: a Claude subscription assistant moved to the Anthropic account keeps answering through the subscription
// agents (here their offline stand-in, which starts with its notice) while the new model is still being built, and
// switches to the single model once the pool publishes the new binding (PR #32 review, round 2, finding 3).
import { Llm, type LlmEvent } from "@pva/core"
import type { ServerMessageOf } from "@pva/protocol"
import { Deferred, Effect, Exit, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LlmBuilder } from "../src/serve/Resources.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

/** Instances that answer "<model or account>#<n>: <text>"; a model in `builds` with a gate is built once it opens. */
const fakeModels = () => {
  const built: Array<string> = []
  const gates = new Map<string, Deferred.Deferred<void>>()
  const build: LlmBuilder = (spec) =>
    Effect.gen(function*() {
      const gate = gates.get(spec.model)
      if (gate !== undefined) yield* Deferred.await(gate)
      built.push(spec.model)
      const name = `${spec.model === "" ? spec.account : spec.model}#${built.length}`
      return Llm.of({
        stream: (request) =>
          Stream.suspend(() => {
            const last = request.messages.at(-1)
            const text = last?.role === "user" ? last.content : ""
            return Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: `${name}: ${text}` }, { _tag: "Done", stopReason: "end" }])
          })
      })
    })
  return { build, built, gates }
}

/** A data directory with one assistant, Alpha, on the Claude subscription account, on the browser defaults. */
const withSubscription = async (): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-subscription-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
  const base = file.assistants.byId[file.assistants.order[0]]
  const alpha = { ...base, id: "alpha", rev: 0, name: "Alpha", prompt: "You are Alpha.", llm: { ...base.llm, account: "claude-subscription", model: "claude-sonnet-5-5" } }
  file.assistants = { order: ["alpha"], byId: { alpha } }
  file.deviceTypes["web-voice"] = { ...file.deviceTypes["web-voice"], assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }], withoutPhrase: { mode: "nobody" } }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

/** Type `text` to Alpha; resolves with the turn's reply once the turn has ended. */
const typed = async (client: ScriptedClient, text: string, id: string) => {
  const from = client.messages.length
  client.send({ type: "text.send", requestId: id, text, speak: false, assistantId: "alpha" })
  expect((await client.waitFor("result", (m) => m.requestId === id, { from })).ok).toBe(true)
  const start = await client.waitFor("turn.start", (m) => m.assistantId === "alpha", { from, timeoutMs: 10_000 })
  const end = await client.waitFor("turn.end", (m) => m.turnId === start.turnId, { from, timeoutMs: 10_000 })
  return client.messages
    .slice(from)
    .filter((m): m is ServerMessageOf<"assistant.text"> => m.type === "assistant.text" && m.turnId === end.turnId)
    .map((m) => m.text)
    .join("")
}

const until = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

const NOTICE = "Claude subscription is off"

describe("serve: the conversation's kind follows the binding in use (PR #32)", () => {
  it("subscription → Anthropic: the subscription agents answer until the new model is ready, then the model does", async () => {
    const models = fakeModels()
    server = await startTestServer({
      build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "the build's model").llm }),
      buildLlm: models.build,
      resourceGraceMs: 100,
      dataDir: await withSubscription()
    })
    const voice = await ScriptedClient.connect({ url: server.url, deviceId: "device-a" })
    clients.push(voice)
    await voice.hello()
    const resources = server.handle.resources

    const one = await typed(voice, "one", "t1")
    expect(one).toContain(NOTICE)
    expect(one).toMatch(/claude-subscription#\d: one/)

    // Saved as Anthropic; its instance is still being built (held), so the old binding stays in use.
    const gate = Deferred.makeUnsafe<void>()
    models.gates.set("model-a", gate)
    const alpha = server.handle.store.assistants().find((a) => a.id === "alpha")!
    await Effect.runPromise(server.handle.store.saveAssistantRecord({ ...alpha, llm: { ...alpha.llm, account: "anthropic", model: "model-a" } }))
    await until("model-a building", () => resources.status().some((r) => r.key.includes("|model-a|") && r.state === "starting"))
    expect(resources.keyFor("alpha")).toBe("claude-subscription")
    const two = await typed(voice, "two", "t2")
    expect(two).toContain(NOTICE)
    expect(two).toMatch(/claude-subscription#\d: two/)

    // Ready: the binding is published, the conversation restarts as a single-model one.
    Deferred.doneUnsafe(gate, Exit.void)
    await until("alpha bound to model-a", () => resources.keyFor("alpha")?.includes("|model-a|") === true)
    await sleep(200)
    const three = await typed(voice, "three", "t3")
    expect(three).not.toContain(NOTICE)
    expect(three).toMatch(/^model-a#\d: three$/)
  })
})
