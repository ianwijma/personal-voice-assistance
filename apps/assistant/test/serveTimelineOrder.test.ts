// The order of a voice turn's time line on the real server: the recogniser's own times (speech started, first partial
// transcript) are kept although a gate or the TypeSafe call holds the events back. Real clock, generous gaps.
import { eagerEndOfTurn, endOfTurn, interim, speechStarted } from "@pva/core/testing"
import type { ServerMessageOf, TraceEvent } from "@pva/protocol"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

type Json = Record<string, any>

let server: TestServer | undefined
let jev: Http.Server | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
  jev?.closeAllConnections()
  jev?.close()
  jev = undefined
})

/** A fake `/v1/systemone`: Bravo for jokes, nobody otherwise; `delayMs` before answering. */
const fakeJev = async (delayMs = 0) => {
  const requests: Array<{ readonly headers: Http.IncomingHttpHeaders; readonly body: any }> = []
  jev = Http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw)
      requests.push({ headers: req.headers, body })
      const joke = String(body.state.utterance).includes("joke")
      const answer = {
        model: "jev-1.14.0",
        answers: {
          assistant: { type: "choice", choice: joke ? "bravo" : "alpha", confidence: 0.8, probabilities: joke ? { alpha: 0.08, bravo: 0.92 } : { alpha: 0.6, bravo: 0.4 } },
          fits: { type: "noul", noul: joke ? 0.95 : 0.12 }
        },
        usage: { input_tokens: 80, output_tokens: 4 }
      }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(answer))
      }, delayMs)
    })
  })
  await new Promise<void>((resolve) => jev!.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${(jev.address() as AddressInfo).port}`, requests }
}

/** Alpha (fallback, Handles set) and Bravo (no Handles) on the browser defaults, TypeSafe deciding, picking allowed. */
const dataDir = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "pva-typesafe-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir: dir })
  await first.close()
  const path = join(dir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const alpha = { ...base, id: "alpha", rev: 0, name: "Alpha", purpose: "Everything", handles: "The house, timers, the weather.", prompt: "You are Alpha.", followUpSeconds: 0, modules: {} }
  const bravo = { ...base, id: "bravo", rev: 0, name: "Bravo", purpose: "Jokes", handles: "", prompt: "You are Bravo.", followUpSeconds: 0, modules: {} }
  file.assistants = { order: ["alpha", "bravo"], byId: { alpha, bravo } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: "bravo", phrases: ["hey bravo"] }],
    withoutPhrase: { mode: "typesafe", fallback: "alpha", giveUpMs: 400 },
    voicePage: { pick: true },
    interruptMode: "instant"
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dir
}

const start = async (env: Record<string, string>) => {
  const stt = controlledStt()
  const llm = scriptedLlm((t) => `Reply to ${t}.`)
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), dataDir: await dataDir(), env })
  return { stt, llm }
}
const connect = async () => {
  const client = await ScriptedClient.connect({ url: server!.url })
  clients.push(client)
  return client
}

const untilOpen = async (stt: ReturnType<typeof controlledStt>) => {
  for (let i = 0; i < 200 && stt.open() < 1; i++) await sleep(10)
  expect(stt.open()).toBe(1)
}

/** One utterance; the turn it starts and its trace (from admin's `trace` push). */
const say = async (page: ScriptedClient, admin: ScriptedClient, stt: ReturnType<typeof controlledStt>, text: string) => {
  const from = page.messages.length
  const adminFrom = admin.messages.length
  stt.emit(speechStarted, endOfTurn(text))
  const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
  const trace: ServerMessageOf<"trace"> = await admin.waitFor("trace", (m) => m.trace.turnId === begun.turnId, { from: adminFrom, timeoutMs: 10_000 })
  await page.waitFor("state", (m) => m.state !== "speaking" && m.state !== "thinking", { from, timeoutMs: 5_000 })
  return { begun, trace: trace.trace }
}

const at = (line: ReadonlyArray<TraceEvent>, name: string): number => {
  const e = line.find((x) => x.name === name)
  if (e === undefined) throw new Error(`no ${name} in ${line.map((x) => x.name).join(", ")}`)
  return e.at
}

/** An utterance spoken over ~300 ms: start, a partial after 100 ms, a longer one after 200 ms, the final after 300 ms. */
const speak = async (stt: ReturnType<typeof controlledStt>, partials: ReadonlyArray<string>, final: string) => {
  stt.emit(speechStarted)
  for (const p of partials) {
    await sleep(100)
    stt.emit(interim(p))
  }
  await sleep(100)
  stt.emit(endOfTurn(final))
}

describe("the time line keeps the recogniser's times", () => {
  it("TypeSafe device: speech started and first partial come before routing, which comes before the choice and the end of turn", async () => {
    const api = await fakeJev(150)
    const { stt } = await start({ TYPESAFE_ROUTING: "true", TYPESAFE_API_KEY: "ts-test-key", TYPESAFE_BASE_URL: api.url })
    const page = await connect()
    await page.hello()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    await page.claim()
    await untilOpen(stt)
    const from = page.messages.length
    const adminFrom = admin.messages.length
    await speak(stt, ["tell me", "tell me a"], "tell me a joke")
    const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
    const trace = (await admin.waitFor("trace", (m) => m.trace.turnId === begun.turnId, { from: adminFrom, timeoutMs: 10_000 })).trace
    const line = trace.timeline!
    expect(trace.route).toMatchObject({ by: "typesafe" })
    // 0 is the conversation's end of turn, which waits for the routing answer: the user began 300 ms of speech + the call before it.
    expect(at(line, "endOfTurn")).toBe(0)
    expect(at(line, "speechStarted")).toBeLessThan(-400)
    expect(at(line, "speechStarted") + 60).toBeLessThan(at(line, "firstInterim"))
    expect(at(line, "firstInterim") + 100).toBeLessThan(at(line, "routing"))
    expect(at(line, "routing")).toBeLessThanOrEqual(at(line, "assistantChosen"))
    expect(at(line, "assistantChosen")).toBeLessThanOrEqual(0)
  })

  it("TypeSafe device, eager transcript: the eager end of turn is the recogniser's, before the routing call it waited for", async () => {
    const api = await fakeJev(200)
    const { stt } = await start({ TYPESAFE_ROUTING: "true", TYPESAFE_API_KEY: "ts-test-key", TYPESAFE_BASE_URL: api.url })
    const page = await connect()
    await page.hello()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    await page.claim()
    await untilOpen(stt)
    const from = page.messages.length
    const adminFrom = admin.messages.length
    stt.emit(speechStarted)
    await sleep(100)
    stt.emit(interim("tell me a joke"))
    await sleep(100)
    stt.emit(eagerEndOfTurn("tell me a joke"))
    // Past the routing answer: the speculative turn runs, and the final promotes it.
    await sleep(500)
    stt.emit(endOfTurn("tell me a joke"))
    const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
    const trace = (await admin.waitFor("trace", (m) => m.trace.turnId === begun.turnId, { from: adminFrom, timeoutMs: 10_000 })).trace
    const line = trace.timeline!
    expect(trace.route).toMatchObject({ by: "typesafe" })
    expect(trace.speculative).toBe(true)
    expect(api.requests.length).toBe(1)
    const routing = line.find((x) => x.name === "routing")!
    expect(routing.ms).toBeGreaterThanOrEqual(150)
    // The eager transcript arrived as the routing call left, not when its answer came back.
    expect(at(line, "eagerEndOfTurn")).toBeLessThan(routing.at + routing.ms! - 100)
    expect(at(line, "eagerEndOfTurn") + 100).toBeLessThan(at(line, "assistantChosen"))
    expect(at(line, "speechStarted") + 150).toBeLessThan(at(line, "eagerEndOfTurn"))
  })

  it("wake-phrase device: the utterance's start and first partial precede the phrase, which the route gate only released with words", async () => {
    const { stt } = await start({})
    const page = await connect()
    await page.hello()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    await page.claim()
    await untilOpen(stt)
    const from = page.messages.length
    const adminFrom = admin.messages.length
    await speak(stt, ["hey", "hey bravo tell"], "hey bravo tell me a joke")
    const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
    const trace = (await admin.waitFor("trace", (m) => m.trace.turnId === begun.turnId, { from: adminFrom, timeoutMs: 10_000 })).trace
    const line = trace.timeline!
    expect(trace.route).toEqual({ by: "phrase", phrase: "hey bravo" })
    expect(at(line, "speechStarted")).toBeLessThan(-250)
    expect(at(line, "speechStarted") + 60).toBeLessThan(at(line, "firstInterim"))
    expect(at(line, "firstInterim") + 60).toBeLessThan(at(line, "wakePhrase"))
    expect(at(line, "wakePhrase")).toBeLessThanOrEqual(at(line, "assistantChosen"))
    expect(at(line, "assistantChosen")).toBeLessThan(0)
  })
})
