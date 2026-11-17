// The `openrouter` and `home-model` accounts through the resource pool (docs/ASSISTANTS.md WP-13b), against the real
// server with the scripted client and a local mock of the OpenAI-compatible API: an assistant answers through its own
// instance pointed at the mock; different models are separate instances, equal settings share one; an account that is
// not set up is that resource's problem and only its assistants' turns fail; a changed address builds a new instance.
import type { Assistant, ServerMessageOf } from "@pva/protocol"
import { ConfigProvider, Effect } from "effect"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultLlmBuilder } from "../src/serve/Resources.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
const mocks: Array<Http.Server> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
  for (const m of mocks.splice(0)) {
    m.closeAllConnections()
    m.close()
  }
})

interface Seen {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly body: any
}

/** A mock of the chat completions API: answers "<name>|<model>|<last user text>" as a stream; `GET /models` lists nothing. */
const mockApi = async (name: string) => {
  const seen: Array<Seen> = []
  const http = Http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = raw === "" ? undefined : JSON.parse(raw)
      seen.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization, body })
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [] }))
        return
      }
      const users = (body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "user")
      const text = `${name}|${body.model}|${users.at(-1)?.content.split("\n\n<context>")[0] ?? ""}`
      res.writeHead(200, { "content-type": "text/event-stream" })
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.end(chunk({ role: "assistant", content: "" }, null) + chunk({ content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n")
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  mocks.push(http)
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  /** The chat requests (not the warm-up of one token, not the model list). */
  const turns = () => seen.filter((s) => s.method === "POST" && s.body.max_tokens !== 1)
  return { url, seen, turns }
}

/**
 * A data directory with assistants on the browser defaults, each `[id, account, model]`; all on the web-voice defaults
 * list (no wake-phrase routing needed: turns are typed to an assistant by id).
 */
const withAssistants = async (list: ReadonlyArray<readonly [string, string, string]>, extra: Partial<Assistant["llm"]> = {}): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-openai-accounts-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
  const base = file.assistants.byId[file.assistants.order[0]]
  const make = (id: string, account: string, model: string) => ({
    ...base,
    id,
    rev: 0,
    name: id[0]!.toUpperCase() + id.slice(1),
    prompt: `You are ${id}.`,
    llm: { ...base.llm, account, model, maxTokens: 321, giveUpMs: 4000, warmUp: true, ...extra }
  })
  file.assistants = { order: list.map(([id]) => id), byId: Object.fromEntries(list.map(([id, account, model]) => [id, make(id, account, model)])) }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: list.map(([id]) => ({ assistant: id, phrases: [`hey ${id}`] })),
    withoutPhrase: { mode: "nobody" }
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

/** The real account builders (`defaultLlmBuilder`) over the server's environment; the keys come from `env`, the shared settings from saves. */
const start = async (dataDir: string, env: Record<string, string> = {}) => {
  server = await startTestServer({
    build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "the build's model").llm }),
    buildLlm: defaultLlmBuilder(() => ConfigProvider.fromEnvRecord(env)),
    env,
    resourceGraceMs: 100,
    dataDir
  })
}

const connect = async (deviceId?: string) => {
  const client = await ScriptedClient.connect({ url: server!.url, ...(deviceId !== undefined ? { deviceId } : {}) })
  clients.push(client)
  return client
}

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
  for (let i = 0; i < 400 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

const llmResources = () => server!.handle.resources.status().filter((r) => r.kind === "llm")
const saveShared = async (admin: ScriptedClient, id: string, values: Record<string, string | boolean>) => {
  admin.send({ type: "settings.update", requestId: id, sectionId: "llm-openai-accounts", patch: { values, secrets: {} } })
  expect(await admin.waitFor("result", (m) => m.requestId === id)).toMatchObject({ ok: true })
}
const saveLlm = (id: string, llm: Partial<Assistant["llm"]>) => {
  const a = server!.handle.store.assistants().find((x) => x.id === id)!
  return Effect.runPromise(server!.handle.store.saveAssistantRecord({ ...a, llm: { ...a.llm, ...llm } }))
}

describe("serve: OpenAI-compatible accounts from the resource pool (WP-13b)", () => {
  it("home model: not set up shows as the account's problem and only its assistants fail; setting the address builds it; a new address builds a new instance", async () => {
    const one = await mockApi("one")
    const two = await mockApi("two")
    await start(await withAssistants([["alpha", "home-model", "model-a"], ["bravo", "offline", ""]]))
    const admin = await connect()
    const welcome = await admin.admin(TEST_ADMIN_PASSWORD)
    const words = "Home model is not set up: add the server address in Shared settings › Language model accounts."
    expect(llmResources().find((r) => r.usedBy.includes("alpha"))).toMatchObject({ state: "failed", problem: words })
    const info = (welcome.snapshot.assistants ?? []).find((a) => a.id === "alpha")!
    expect(info.problems).toContain(`Language model (Home model model-a): ${words}`)
    expect(info.resources.llm).toBe("failed")
    expect((welcome.snapshot.assistants ?? []).find((a) => a.id === "bravo")!.problems.some((p) => p.startsWith("Language model"))).toBe(false)

    const voice = await connect("device-a")
    await voice.hello()
    const failed = await typed(voice, "alpha", "hello", "t1")
    expect(failed.end.outcome).toBe("failed")
    expect(failed.errors.map((e) => e.error.code)).toContain("turn_failed")
    expect((await typed(voice, "bravo", "hello", "t2")).end.outcome).toBe("completed") // the other assistant answers

    // The address set (a bare http://host:port: /v1 is added): built, warmed with a one-token request, answering.
    await saveShared(admin, "s1", { HOME_MODEL_BASE_URL: one.url })
    await until("alpha ready", () => llmResources().some((r) => r.usedBy.includes("alpha") && r.state === "ready"))
    expect(one.seen.some((s) => s.method === "POST" && s.path === "/v1/chat/completions" && s.body.max_tokens === 1)).toBe(true) // warm-up
    const answered = await typed(voice, "alpha", "what time is it", "t3")
    expect(answered.end.outcome).toBe("completed")
    // The failed turn's question stays in the history; the adapter joins consecutive user messages.
    expect(answered.reply).toBe("one|model-a|hello\n\nwhat time is it")
    expect(one.turns()).toHaveLength(1)
    expect(one.turns()[0]!.body).toMatchObject({ model: "model-a", max_tokens: 321, stream: true })
    expect(one.turns()[0]!.authorization).toBe("Bearer none") // no key set
    expect(llmResources().find((r) => r.usedBy.includes("alpha"))?.problem).toBeUndefined()

    // A changed address: a new instance, the old one released after the grace period.
    const before = llmResources().find((r) => r.usedBy.includes("alpha"))!
    await saveShared(admin, "s2", { HOME_MODEL_BASE_URL: two.url })
    await until("alpha on the new address", () => {
      const now = llmResources().find((r) => r.usedBy.includes("alpha"))
      return now !== undefined && now.state === "ready" && now.key !== before.key
    })
    expect((await typed(voice, "alpha", "again", "t4")).reply).toBe("two|model-a|again")
    expect(one.turns()).toHaveLength(1)
    await until("old instance released", () => llmResources().filter((r) => r.usedBy.includes("alpha")).length === 1)
  })

  it("home model: different models are separate instances, equal settings share one", async () => {
    const api = await mockApi("api")
    await start(await withAssistants([["alpha", "home-model", "model-a"], ["bravo", "home-model", "model-b"]]), { HOME_MODEL_BASE_URL: api.url })
    const voice = await connect("device-a")
    await voice.hello()
    const keys = () => llmResources().map((r) => [r.key.split("|")[1], r.state, r.usedBy] as const).sort()
    expect(keys()).toEqual([["model-a", "ready", ["alpha"]], ["model-b", "ready", ["bravo"]]])
    expect((await typed(voice, "alpha", "x", "t1")).reply).toBe("api|model-a|x")
    expect((await typed(voice, "bravo", "y", "t2")).reply).toBe("api|model-b|y")

    // Equal settings share: bravo moves to model-a.
    await saveLlm("bravo", { model: "model-a" })
    await until("one shared instance", () => server!.handle.resources.keyFor("bravo") === server!.handle.resources.keyFor("alpha"))
    expect(server!.handle.resources.llmFor("bravo")).toBe(server!.handle.resources.llmFor("alpha"))
    expect((await typed(voice, "bravo", "z", "t3")).reply).toBe("api|model-a|z")
    // A different longest reply is a different instance of the same model.
    await saveLlm("bravo", { maxTokens: 200 })
    await until("separate again", () => server!.handle.resources.keyFor("bravo") !== server!.handle.resources.keyFor("alpha"))
    expect((await typed(voice, "bravo", "w", "t4")).reply).toBe("api|model-a|w")
    expect(api.turns().at(-1)!.body.max_tokens).toBe(200)
    // Effort and thinking are not read by this account: changing them builds nothing.
    const built = api.seen.length
    await saveLlm("alpha", { effort: "high", thinking: "adaptive" })
    await sleep(100)
    expect(server!.handle.resources.keyFor("alpha")).toBe(llmResources().find((r) => r.usedBy.includes("alpha"))!.key)
    expect(api.seen.length).toBe(built)
  })

  it("OpenRouter: no key is the account's problem; with a key the turn carries it, and the connection is warmed with the model list", async () => {
    const api = await mockApi("or")
    const dataDir = await withAssistants([["alpha", "openrouter", "vendor/model-x"], ["bravo", "offline", ""]])
    await start(dataDir, { OPENROUTER_BASE_URL: api.url })
    const words = "OpenRouter is not set up: add its API key in Shared settings › Language model accounts."
    expect(llmResources().find((r) => r.usedBy.includes("alpha"))).toMatchObject({ state: "failed", problem: words })
    const voice = await connect("device-a")
    await voice.hello()
    expect((await typed(voice, "alpha", "hello", "t1")).end.outcome).toBe("failed")
    expect((await typed(voice, "bravo", "hello", "t2")).end.outcome).toBe("completed")
    await server!.close()
    server = undefined
    clients.splice(0).forEach((c) => c.close())

    await start(dataDir, { OPENROUTER_BASE_URL: api.url, OPENROUTER_API_KEY: "sk-or-test-key" })
    const voice2 = await connect("device-a")
    await voice2.hello()
    expect(api.seen.some((s) => s.method === "GET" && s.path === "/v1/models" && s.authorization === "Bearer sk-or-test-key")).toBe(true)
    const answered = await typed(voice2, "alpha", "hello", "t3")
    expect(answered.reply).toBe("or|vendor/model-x|hello")
    expect(api.turns()[0]!.authorization).toBe("Bearer sk-or-test-key")
    expect(api.turns()[0]!.body).toMatchObject({ model: "vendor/model-x", max_tokens: 321, provider: { sort: "latency" } })
    // The key is never in a status line or a problem.
    expect(JSON.stringify(llmResources())).not.toContain("sk-or-test-key")

    // "Prefer the fastest provider" switched off: a new instance (same key shown), whose turns ask for no sorting.
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const sorted = server!.handle.resources.llmFor("alpha")
    await saveShared(admin, "s1", { OPENROUTER_SORT_BY_LATENCY: false })
    await until("alpha on an unsorted instance", () => {
      const now = server!.handle.resources.llmFor("alpha")
      return now !== undefined && now !== sorted
    })
    expect((await typed(voice2, "alpha", "again", "t4")).reply).toBe("or|vendor/model-x|again")
    expect(api.turns().at(-1)!.body.provider).toBeUndefined()
    // And on again: the turns sort by latency again.
    const unsorted = server!.handle.resources.llmFor("alpha")
    await saveShared(admin, "s2", { OPENROUTER_SORT_BY_LATENCY: true })
    await until("alpha on a sorted instance", () => {
      const now = server!.handle.resources.llmFor("alpha")
      return now !== undefined && now !== unsorted
    })
    await typed(voice2, "alpha", "once more", "t5")
    expect(api.turns().at(-1)!.body).toMatchObject({ provider: { sort: "latency" } })
  })
})
