// The order of a voice turn's time line on the real server: the recogniser's own times (speech started, first partial
// transcript) are kept although a gate or the TypeSafe call holds the events back. Scheduling-independent: most tests
// run the trace clock by hand (`manualClock`): it stands still at a value the test sets, the test waits until the
// session has read it for the events it wants stamped (a barrier, not a sleep), then moves it on, so each entry's time
// is known exactly. Stamped where the conversation handles the event, an entry would carry the later value. The
// remaining one keeps the real clock and asserts only what causality guarantees.
import { makeTurnTrace, type TurnTrace } from "@pva/core"
import { eagerEndOfTurn, endOfTurn, interim, speechStarted, turnResumed } from "@pva/core/testing"
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

/**
 * A fake `/v1/systemone`: Bravo for jokes, nobody otherwise; `delayMs` before answering (at least). `hold`: the first
 * request is answered only once the test calls `release()`.
 */
const fakeJev = async (delayMs = 0, hold = false) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
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
      const first = requests.length === 1
      void (hold && first ? held : Promise.resolve()).then(() =>
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(answer))
        }, delayMs)
      )
    })
  })
  await new Promise<void>((resolve) => jev!.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${(jev.address() as AddressInfo).port}`, requests, release: () => release() }
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
    withoutPhrase: { mode: "typesafe", fallback: "alpha", giveUpMs: 2_000 },
    voicePage: { pick: true },
    interruptMode: "instant"
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dir
}

const start = async (env: Record<string, string>, turnTrace?: TurnTrace["Service"]) => {
  const stt = controlledStt()
  const llm = scriptedLlm((t) => `Reply to ${t}.`)
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), dataDir: await dataDir(), env, ...(turnTrace !== undefined ? { turnTrace } : {}) })
  return { stt, llm }
}

/** A trace clock that stands still at the value the test set last, and counts how often the server read it. */
const manualClock = () => {
  let t = 0
  let reads = 0
  return {
    turnTrace: makeTurnTrace({
      now: () => {
        reads++
        return t
      }
    }),
    set: (to: number) => void (t = to),
    reads: () => reads
  }
}
/** Far apart: entries stamped at one step are a whole number of steps from those at another. */
const STEP = 10_000

const TYPESAFE_ENV = (url: string) => ({ TYPESAFE_ROUTING: "true", TYPESAFE_API_KEY: "ts-test-key", TYPESAFE_BASE_URL: url })
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

/** Until `check` holds (polled), else fail. */
const until = async (what: string, check: () => boolean, ms = 5_000) => {
  for (let i = 0; i < ms / 10 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

describe("the time line keeps the recogniser's times", () => {
  it("TypeSafe device: speech started and first partial keep their own times, before routing, the choice and the end of turn", async () => {
    const clock = manualClock()
    const api = await fakeJev()
    const { stt } = await start(TYPESAFE_ENV(api.url), clock.turnTrace)
    const page = await connect()
    await page.hello()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    await page.claim()
    await untilOpen(stt)
    const from = page.messages.length
    const adminFrom = admin.messages.length
    clock.set(STEP)
    const read = clock.reads()
    stt.emit(speechStarted, interim("tell me"))
    await until("the start and the first partial stamped", () => clock.reads() >= read + 2)
    clock.set(2 * STEP)
    stt.emit(interim("tell me a"), endOfTurn("tell me a joke"))
    const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
    const trace = (await admin.waitFor("trace", (m) => m.trace.turnId === begun.turnId, { from: adminFrom, timeoutMs: 10_000 })).trace
    const line = trace.timeline!
    expect(trace.route).toMatchObject({ by: "typesafe" })
    // 0 is the conversation's end of turn, which waits for the routing answer (all at 2 × STEP). The dispatcher held the
    // start until then: stamped in the conversation, it would be 0 too.
    expect(at(line, "endOfTurn")).toBe(0)
    expect(at(line, "speechStarted")).toBe(-STEP)
    expect(at(line, "firstInterim")).toBe(-STEP)
    expect(at(line, "routing")).toBe(0)
    expect(at(line, "assistantChosen")).toBe(0)
  })

  it("TypeSafe device, eager transcript: the eager end of turn is the recogniser's, before the routing call it waited for", async () => {
    // The real clock: only what causality guarantees (stamped before it was dispatched; answered no sooner than 200 ms).
    const api = await fakeJev(200)
    const { stt } = await start(TYPESAFE_ENV(api.url))
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
    // The fake answers no sooner than 200 ms after the request.
    expect(routing.ms).toBeGreaterThanOrEqual(150)
    // The eager transcript arrived before the routing call it started left (stamped in the conversation, after its answer).
    expect(at(line, "eagerEndOfTurn")).toBeLessThanOrEqual(routing.at)
    expect(at(line, "eagerEndOfTurn")).toBeLessThan(at(line, "assistantChosen"))
    expect(at(line, "speechStarted")).toBeLessThanOrEqual(at(line, "eagerEndOfTurn"))
  })

  it("TypeSafe device: a resume and a second eager transcript that arrive while routing is pending keep their own times", async () => {
    const clock = manualClock()
    // The first routing call is held until the test releases it.
    const api = await fakeJev(0, true)
    const { stt } = await start(TYPESAFE_ENV(api.url), clock.turnTrace)
    const page = await connect()
    await page.hello()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    await page.claim()
    await untilOpen(stt)
    const from = page.messages.length
    const adminFrom = admin.messages.length
    // Every transcript is Bravo's: the resume reaches the same conversation as the final.
    clock.set(STEP)
    stt.emit(speechStarted, interim("a joke"), eagerEndOfTurn("a joke"))
    await until("the first routing call", () => api.requests.length === 1)
    // While it is pending:
    clock.set(2 * STEP)
    const read = clock.reads()
    stt.emit(turnResumed, eagerEndOfTurn("a joke about cats"))
    await until("the resume and the second eager stamped", () => clock.reads() >= read + 2)
    clock.set(3 * STEP)
    api.release()
    // The second eager's own call starts only now (the session dispatches in order), and is answered at once.
    await until("the second routing call", () => api.requests.length === 2)
    stt.emit(endOfTurn("a joke about cats"))
    const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
    const trace = (await admin.waitFor("trace", (m) => m.trace.turnId === begun.turnId, { from: adminFrom, timeoutMs: 10_000 })).trace
    const line = trace.timeline!
    expect(trace.route).toMatchObject({ by: "typesafe" })
    expect(trace.assistant?.id).toBe("bravo")
    expect(api.requests.length).toBe(2)
    // `routing` is the second eager's call (the final reuses its answer), sent after the release. Stamped where they
    // were dispatched (after the release), the resume and the second eager would be 0 too.
    expect(at(line, "endOfTurn")).toBe(0)
    expect(at(line, "routing")).toBe(0)
    expect(at(line, "speechStarted")).toBe(-2 * STEP)
    expect(at(line, "turnResumed")).toBe(-STEP)
    expect(at(line, "eagerEndOfTurn")).toBe(-STEP)
  })

  it("wake-phrase device: the utterance's start and first partial precede the phrase, which the route gate only released with words", async () => {
    const clock = manualClock()
    const { stt } = await start({}, clock.turnTrace)
    const page = await connect()
    await page.hello()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    await page.claim()
    await untilOpen(stt)
    const from = page.messages.length
    const adminFrom = admin.messages.length
    clock.set(STEP)
    const read = clock.reads()
    stt.emit(speechStarted, interim("hey"))
    await until("the start and the first partial stamped", () => clock.reads() >= read + 2)
    clock.set(2 * STEP)
    stt.emit(interim("hey bravo tell"), endOfTurn("hey bravo tell me a joke"))
    const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
    const trace = (await admin.waitFor("trace", (m) => m.trace.turnId === begun.turnId, { from: adminFrom, timeoutMs: 10_000 })).trace
    const line = trace.timeline!
    expect(trace.route).toEqual({ by: "phrase", phrase: "hey bravo" })
    // The route gate released the start and the partials only with "hey bravo tell" (at 2 × STEP, as the end of turn):
    // stamped in the conversation, they would be 0 too.
    expect(at(line, "speechStarted")).toBe(-STEP)
    expect(at(line, "firstInterim")).toBe(-STEP)
    expect(at(line, "wakePhrase")).toBe(0)
    expect(at(line, "assistantChosen")).toBe(0)
  })
})
