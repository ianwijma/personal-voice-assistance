// TypeSafe routing on the real server (docs/ASSISTANTS.md §3.6, WP-14): the `routing` section, `canAuto`, the decide
// path through the real adapter over HTTP against a local fake of `/v1/systemone`, and the traces. Scripted clients.
import { endOfTurn, speechStarted } from "@pva/core/testing"
import type { ServerMessageOf } from "@pva/protocol"
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

describe("TypeSafe routing on the server", () => {
  it("routes sentences without a phrase through TypeSafe; phrases and typed text skip it; traces carry the outcome", async () => {
    const api = await fakeJev(30)
    const { stt } = await start({ TYPESAFE_ROUTING: "true", TYPESAFE_API_KEY: "ts-test-key", TYPESAFE_BASE_URL: api.url })
    const page = await connect()
    const welcome = await page.hello()
    expect(welcome.snapshot.setup).toMatchObject({ canAuto: true, withoutPhrase: { mode: "typesafe", fallback: "alpha" } })
    const admin = await connect()
    const adminWelcome = await admin.admin(TEST_ADMIN_PASSWORD)
    // The shared section: off by default (here switched on from the environment), the key a secret.
    const section = adminWelcome.snapshot.sections.find((s) => s.id === "routing")!
    expect(`${section.group}/${section.page?.id}`).toBe("agents/routing")
    expect(section.form.fields.map((f) => f.key)).toEqual(["TYPESAFE_ROUTING", "TYPESAFE_API_KEY", "TYPESAFE_MODEL", "TYPESAFE_BASE_URL"])
    expect(section.form.values).toMatchObject({ TYPESAFE_ROUTING: true, TYPESAFE_MODEL: "jev-1.14.0" })
    expect(section.form.secrets.TYPESAFE_API_KEY).toEqual({ set: true, source: "env" })
    await page.claim()
    await untilOpen(stt)

    // Chosen.
    const joke = await say(page, admin, stt, "tell me a joke")
    expect(joke.begun.assistantId).toBe("bravo")
    expect(joke.trace.route).toMatchObject({ by: "typesafe", outcome: "chosen", probability: 0.92, fits: 0.95, fallback: false })
    const ms = (joke.trace.route as { ms: number }).ms
    expect(ms).toBeGreaterThanOrEqual(25)
    // Asked at the final (no eager event): the request left before the conversation's end of turn.
    expect(joke.trace.marks.routeSent).toBeLessThan(0)
    expect(joke.trace.marks.routeReceived! - joke.trace.marks.routeSent!).toBeCloseTo(ms, 0)
    expect(api.requests).toHaveLength(1)
    const sent = api.requests[0]!
    expect(sent.headers.authorization).toBe("Bearer ts-test-key")
    expect(sent.body).toEqual({
      model: "jev-1.14.0",
      state: { utterance: "tell me a joke", available_actions: { alpha: "The house, timers, the weather.", bravo: "Bravo: Jokes" } },
      questions: {
        assistant: {
          type: "choice",
          instructions: "Which assistant is this sentence meant for?",
          criteria: { alpha: "The house, timers, the weather.", bravo: "Bravo: Jokes" }
        },
        fits: { type: "noul", instructions: "Is the sentence meant for one of the available assistants?" }
      }
    })

    // None fits: the fallback.
    const other = await say(page, admin, stt, "what is the capital of peru")
    expect(other.begun.assistantId).toBe("alpha")
    expect(other.trace.route).toMatchObject({ by: "typesafe", outcome: "none-fits", probability: 0.6, fits: 0.12, fallback: true })
    expect(api.requests).toHaveLength(2)

    // A phrase never asks TypeSafe.
    const phrase = await say(page, admin, stt, "hey bravo another joke please")
    expect(phrase.begun.assistantId).toBe("bravo")
    expect(phrase.trace.route).toEqual({ by: "phrase", phrase: "hey bravo" })
    expect(phrase.trace.marks.routeSent).toBeUndefined()
    // Typed text is not routed by TypeSafe: it goes to the fallback (§2.6 "Typed text").
    const from = page.messages.length
    page.send({ type: "text.send", requestId: "t1", text: "tell me a joke", speak: false })
    const typed = await page.waitFor("turn.start", () => true, { from })
    expect(typed.assistantId).toBe("alpha")
    await sleep(100)
    expect(api.requests).toHaveLength(2)
  })

  it("off by default: canAuto is false, nothing is sent, and nobody answers a sentence without a phrase", async () => {
    const api = await fakeJev()
    const { stt } = await start({ TYPESAFE_API_KEY: "ts-test-key", TYPESAFE_BASE_URL: api.url })
    const page = await connect()
    const welcome = await page.hello()
    expect(welcome.snapshot.setup).toMatchObject({ canAuto: false })
    const admin = await connect()
    const adminWelcome = await admin.admin(TEST_ADMIN_PASSWORD)
    expect(adminWelcome.snapshot.sections.find((s) => s.id === "routing")!.form.values.TYPESAFE_ROUTING).toBe(false)
    await page.claim()
    await untilOpen(stt)
    const from = page.messages.length
    stt.emit(speechStarted, endOfTurn("tell me a joke"))
    await sleep(300)
    expect(page.types(from)).not.toContain("turn.start")
    expect(api.requests).toHaveLength(0)
    // A phrase still works.
    stt.emit(speechStarted, endOfTurn("hey alpha hello"))
    expect((await page.waitFor("turn.start", () => true, { from })).assistantId).toBe("alpha")
    await page.waitFor("state", (m) => m.state !== "speaking" && m.state !== "thinking", { from })

    // Switched on in the shared section: live, the voice page learns it, and the next sentence is routed.
    const setupFrom = page.messages.length
    admin.send({ type: "settings.update", requestId: "s1", sectionId: "routing", patch: { values: { TYPESAFE_ROUTING: true }, secrets: {} } })
    expect(await admin.waitFor("result", (m) => m.requestId === "s1")).toMatchObject({ ok: true })
    expect(await page.waitFor("device.setup", () => true, { from: setupFrom })).toMatchObject({ canAuto: true })
    const joke = await say(page, admin, stt, "tell me a joke")
    expect(joke.begun.assistantId).toBe("bravo")
    expect(api.requests).toHaveLength(1)
  })

  it("a slow TypeSafe: the fallback answers at the give-up time, traced as a timeout", async () => {
    const api = await fakeJev(1_500)
    const { stt } = await start({ TYPESAFE_ROUTING: "true", TYPESAFE_API_KEY: "ts-test-key", TYPESAFE_BASE_URL: api.url })
    const page = await connect()
    await page.hello()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    await page.claim()
    await untilOpen(stt)
    const slow = await say(page, admin, stt, "tell me a joke")
    expect(slow.begun.assistantId).toBe("alpha")
    expect(slow.trace.route).toMatchObject({ by: "typesafe", outcome: "timeout", fallback: true })
    const ms = (slow.trace.route as { ms: number }).ms
    expect(ms).toBeGreaterThanOrEqual(395)
    expect(ms).toBeLessThan(1_000)
    expect(slow.trace.marks.routeReceived).toBeUndefined()
  })

  it("a device set to TypeSafe asks 'Save anyway' for a switched-on assistant without Handles", async () => {
    await start({ TYPESAFE_ROUTING: "true", TYPESAFE_API_KEY: "ts-test-key" })
    const admin = await connect()
    const welcome = await admin.admin(TEST_ADMIN_PASSWORD)
    const type = welcome.snapshot.deviceTypes!.find((t) => t.kind === "web-voice")!
    const send = async (saveAnyway: boolean) => {
      const requestId = `d-${saveAnyway}`
      const from = admin.messages.length
      admin.send({
        type: "device.save",
        requestId,
        target: { kind: "type", type: "web-voice" },
        rev: type.rev,
        settings: { withoutPhrase: { mode: "typesafe", fallback: "alpha", giveUpMs: 500 } },
        ...(saveAnyway ? { saveAnyway } : {})
      })
      return admin.waitFor("result", (m) => m.requestId === requestId, { from })
    }
    // Already TypeSafe with Bravo's empty Handles in the file: re-saving does not ask again; a fresh value would.
    expect(await send(false)).toMatchObject({ ok: true })
    // An assistant whose Handles becomes empty while it is on a TypeSafe device.
    const alpha = welcome.snapshot.assistants!.find((a) => a.id === "alpha")!
    const { usedOn: _u, resources: _r, problems: _p, ...record } = alpha
    const from = admin.messages.length
    admin.send({ type: "assistant.save", requestId: "a1", assistant: { ...record, handles: "" } })
    const refused = await admin.waitFor("result", (m) => m.requestId === "a1", { from })
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_settings", warnings: [{ key: "handles" }] } })
    admin.send({ type: "assistant.save", requestId: "a2", assistant: { ...record, handles: "" }, saveAnyway: true })
    expect(await admin.waitFor("result", (m) => m.requestId === "a2", { from })).toMatchObject({ ok: true })
  })
})
