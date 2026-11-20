// The per-turn configuration snapshot (docs/ASSISTANTS.md §3.7, §5.4 `TraceInfo.config`): every finished turn's trace
// says what that turn used (its assistant's language model and voice, the recogniser the device heard with, the
// modules and tools, reply early, tool rounds), captured at the turn's start, so a later change leaves it as it was.
import { Llm, type LlmEvent, voiceKey } from "@pva/core"
import { endOfTurn, interim, speechStarted } from "@pva/core/testing"
import { type Assistant, type ServerMessage, type ServerMessageOf, TraceInfo } from "@pva/protocol"
import { Effect, Schema, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LlmBuilder } from "../src/serve/Resources.ts"
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

type Json = Record<string, any>

/** Instances that answer "<model>: <text>". */
const fakeModels: LlmBuilder = (spec) =>
  Effect.succeed(Llm.of({
    stream: (request) =>
      Stream.suspend(() => {
        const last = request.messages.at(-1)
        const text = last?.role === "user" ? last.content : ""
        return Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: `${spec.model}: ${text}` }, { _tag: "Done", stopReason: "end" }])
      })
  }))

/**
 * Alpha (Anthropic `model-a`, high effort, adaptive thinking, 2048 tokens, the greeter module on, 3 tool rounds, reply
 * early, its own end pauses: the device's hearer) and Bravo (`model-b`, low effort, 512 tokens, no module, 1 tool round,
 * no reply early, another voice), "hey alpha" / "hey bravo" on the browser defaults.
 */
const dataDirWithTwo = async (): Promise<{ dataDir: string; base: Json }> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-traceconfig-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const alpha = {
    ...base,
    id: "alpha",
    rev: 0,
    name: "Alpha",
    prompt: "You are Alpha.",
    toolRounds: 3,
    replyEarly: true,
    llm: { ...base.llm, account: "anthropic", model: "model-a", effort: "high", thinking: "adaptive", maxTokens: 2048 },
    hearing: { ...base.hearing, eagerSilenceMs: 300, finalSilenceMs: 700 },
    modules: { greeter: { on: true, offTools: [] } }
  }
  const bravo = {
    ...base,
    id: "bravo",
    rev: 0,
    name: "Bravo",
    prompt: "You are Bravo.",
    toolRounds: 1,
    replyEarly: false,
    llm: { ...base.llm, account: "anthropic", model: "model-b", effort: "low", thinking: "off", maxTokens: 512 },
    voice: { provider: "piper", voiceId: "nl_NL-pim-medium" },
    modules: {}
  }
  file.assistants = { order: ["alpha", "bravo"], byId: { alpha, bravo } }
  file.modules = { ...file.modules, greeter: { ...(file.modules?.greeter ?? {}), enabled: true, settings: { greeting: "hello" } } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: "bravo", phrases: ["hey bravo"] }],
    withoutPhrase: { mode: "nobody" },
    interruptMode: "instant"
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return { dataDir, base }
}

const connect = async () => {
  const client = await ScriptedClient.connect({ url: server!.url })
  clients.push(client)
  return client
}

const traces = (client: ScriptedClient): Array<TraceInfo> =>
  client.messages.flatMap((m: ServerMessage): Array<TraceInfo> => (m.type === "trace" ? [m.trace] : []))

const until = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 500 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

describe("the per-turn configuration snapshot (TraceInfo.config)", () => {
  it("voice and typed turns of two assistants carry what each used; a later change leaves earlier traces as they were", async () => {
    const { dataDir, base } = await dataDirWithTwo()
    const stt = controlledStt()
    server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "the build's").llm }), buildLlm: fakeModels, resourceGraceMs: 100, dataDir })
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const page = await connect()
    await page.hello()
    await page.claim()
    await until("the recogniser stream", () => stt.open() === 1)

    const spoken = async (text: string) => {
      const from = page.messages.length
      // Spoken over ~200 ms (a first partial after 100 ms) so the time line's order can be asserted.
      stt.emit(speechStarted)
      await sleep(100)
      stt.emit(interim(text.split(" ").slice(0, 3).join(" ")))
      await sleep(100)
      stt.emit(endOfTurn(text))
      const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
      return page.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
    }
    const typed = async (assistantId: string, text: string, id: string) => {
      const from = page.messages.length
      page.send({ type: "text.send", requestId: id, text, speak: false, assistantId })
      expect((await page.waitFor("result", (m) => m.requestId === id, { from })).ok).toBe(true)
      const begun = await page.waitFor("turn.start", (m) => m.assistantId === assistantId, { from, timeoutMs: 10_000 })
      return page.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
    }

    const ends: Array<ServerMessageOf<"turn.end">> = []
    ends.push(await spoken("hey alpha what time is it"))
    ends.push(await typed("alpha", "and tomorrow", "t1"))
    ends.push(await spoken("hey bravo tell me a joke"))
    ends.push(await typed("bravo", "another one", "t2"))
    await until("four traces", () => traces(admin).length === 4)

    // The recogniser the device heard with: its hearer Alpha's (the first assignment), with Alpha's end pauses.
    const hearing = { hearer: "alpha", engine: "sherpa", model: base.hearing.model, eagerSilenceMs: 300, finalSilenceMs: 700 }
    const alphaConfig = {
      llm: { account: "anthropic", model: "model-a", effort: "high", thinking: "adaptive", maxTokens: 2048 },
      hearing,
      voice: voiceKey(base.voice),
      voiceFrom: "assistant",
      modules: 1,
      tools: 1,
      // The names behind the counts: the modules and tools the turn had, each tool with its module.
      moduleList: [{ id: "greeter", name: "Greeter" }],
      toolList: [{ name: "greet", module: "greeter" }],
      replyEarly: true,
      toolRounds: 3
    }
    const bravoConfig = {
      llm: { account: "anthropic", model: "model-b", effort: "low", thinking: "off", maxTokens: 512 },
      hearing,
      voice: "piper:nl_NL-pim-medium",
      voiceFrom: "assistant",
      modules: 0,
      tools: 0,
      moduleList: [],
      toolList: [],
      replyEarly: false,
      toolRounds: 1
    }
    const first = traces(admin)
    expect(first.map((t) => [t.mode, t.assistant?.id])).toEqual([["voice", "alpha"], ["text", "alpha"], ["voice", "bravo"], ["text", "bravo"]])
    expect(first.map((t) => t.config)).toEqual([alphaConfig, alphaConfig, bravoConfig, bravoConfig])
    // The time line of the voice turn: the utterance began, the phrase was heard, the assistant chosen, then the end of turn.
    const spokenLine = first[0]!.timeline!
    const lineNames = spokenLine.map((e) => e.name)
    expect(lineNames).toEqual(expect.arrayContaining(["speechStarted", "firstInterim", "wakePhrase", "assistantChosen", "endOfTurn", "llmRequestSent", "turnEnded"]))
    expect(spokenLine.find((e) => e.name === "wakePhrase")!.detail).toBe("hey alpha")
    expect(spokenLine.find((e) => e.name === "assistantChosen")!.detail).toBe("alpha")
    const when = (name: string) => spokenLine.find((e) => e.name === name)!.at
    // In the order it happened (non-strict orderings only, which causality guarantees whatever the scheduling; the exact
    // times are serveTimelineOrder.test.ts's, on a hand-run clock).
    expect(when("endOfTurn")).toBe(0)
    expect(when("speechStarted")).toBeLessThanOrEqual(when("firstInterim"))
    expect(when("firstInterim")).toBeLessThanOrEqual(when("wakePhrase"))
    expect(when("wakePhrase")).toBeLessThanOrEqual(when("assistantChosen"))
    expect(when("assistantChosen")).toBeLessThanOrEqual(0)
    // As the protocol's schema reads it.
    for (const t of first) expect(Schema.decodeUnknownSync(TraceInfo)(t).config).toEqual(t.config)
    // The device's own `turn.end` does not carry it (a voice connection never learns a model, §5.3).
    for (const end of ends) expect(end.trace).not.toHaveProperty("config")

    // Alpha's model and tool rounds change; Bravo's voice changes. Earlier traces keep what their turns used.
    const store = server.handle.store
    const of = (id: string): Assistant => store.assistants().find((a) => a.id === id)!
    await Effect.runPromise(store.saveAssistantRecord({ ...of("alpha"), toolRounds: 5, llm: { ...of("alpha").llm, model: "model-c" } }))
    await Effect.runPromise(store.saveAssistantRecord({ ...of("bravo"), voice: { provider: "piper", voiceId: "en_US-lessac-medium" } }))
    await until("Alpha on model-c", () => server!.handle.resources.keyFor("alpha")?.includes("model-c") === true)
    await until("Bravo's new voice", () => server!.handle.resources.ttsKeyFor("bravo") === "piper:en_US-lessac-medium")
    await typed("alpha", "what now", "t3")
    await typed("bravo", "and now", "t4")
    await until("six traces", () => traces(admin).length === 6)
    const all = traces(admin)
    expect(all.slice(0, 4).map((t) => t.config)).toEqual([alphaConfig, alphaConfig, bravoConfig, bravoConfig])
    expect(all[4]!.config).toEqual({ ...alphaConfig, llm: { ...alphaConfig.llm, model: "model-c" }, toolRounds: 5 })
    expect(all[5]!.config).toEqual({ ...bravoConfig, voice: "piper:en_US-lessac-medium" })

    // A new admin page gets the recent traces with the snapshots they were made with.
    const later = await connect()
    const welcome = await later.admin(TEST_ADMIN_PASSWORD)
    expect(welcome.snapshot.traces.map((t) => t.config)).toEqual(all.map((t) => t.config))
  })

  it("a new hearer on the same recogniser (identical hearing settings) is named by the next turns' snapshots", async () => {
    const { dataDir, base } = await dataDirWithTwo()
    // Alpha hears with the same settings as Bravo, and the device may pick who answers without a phrase.
    const path = join(dataDir, "settings.json")
    const file = JSON.parse(readFileSync(path, "utf8")) as Json
    file.assistants.byId.alpha.hearing = base.hearing
    file.deviceTypes["web-voice"].voicePage = { pick: true }
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
    const stt = controlledStt()
    server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "the build's").llm }), buildLlm: fakeModels, resourceGraceMs: 100, dataDir })
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const page = await connect()
    await page.hello()
    await page.claim()
    await until("the recogniser stream", () => stt.open() === 1)

    const typed = async (assistantId: string, text: string, id: string) => {
      const from = page.messages.length
      page.send({ type: "text.send", requestId: id, text, speak: false, assistantId })
      expect((await page.waitFor("result", (m) => m.requestId === id, { from })).ok).toBe(true)
      const begun = await page.waitFor("turn.start", (m) => m.assistantId === assistantId, { from, timeoutMs: 10_000 })
      return page.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
    }
    const hearingOf = (hearer: string) => ({ hearer, engine: "sherpa", model: base.hearing.model, eagerSilenceMs: base.hearing.eagerSilenceMs, finalSilenceMs: base.hearing.finalSilenceMs })

    await typed("alpha", "hello", "t1")
    await until("one trace", () => traces(admin).length === 1)
    expect(traces(admin)[0]!.config?.hearing).toEqual(hearingOf("alpha"))

    // Bravo now answers without a phrase, so Bravo is the hearer; the recogniser stream goes on as it was.
    const from = page.messages.length
    page.send({ type: "device.pick", requestId: "p1", withoutPhrase: "bravo" })
    expect((await page.waitFor("result", (m) => m.requestId === "p1", { from })).ok).toBe(true)
    await page.waitFor("device.setup", (m) => m.withoutPhrase.mode === "assistant", { from })
    await sleep(100)
    expect(stt.opened()).toBe(1)

    await typed("bravo", "hi there", "t2")
    const fromSpoken = page.messages.length
    stt.emit(speechStarted, endOfTurn("tell me a joke"))
    const begun = await page.waitFor("turn.start", () => true, { from: fromSpoken, timeoutMs: 10_000 })
    expect(begun.assistantId).toBe("bravo")
    await page.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from: fromSpoken, timeoutMs: 10_000 })
    await until("three traces", () => traces(admin).length === 3)
    const all = traces(admin)
    expect(stt.opened()).toBe(1)
    // The earlier turn keeps the hearer it was heard with; the later ones name Bravo.
    expect(all.map((t) => [t.mode, t.config?.hearing])).toEqual([["text", hearingOf("alpha")], ["text", hearingOf("bravo")], ["voice", hearingOf("bravo")]])
  })
})
