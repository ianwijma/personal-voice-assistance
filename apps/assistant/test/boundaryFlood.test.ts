// P5 review round 2, decision 1: a change of what a device may be told or sent ends its session in the step that
// commits it. Randomised: a device busy with everything at once (a reply being spoken, a typed turn, a tool call in
// flight, household rows streaming to its pages, a second tab) gets each kind of boundary change at a random point.
// The server side of every connection is watched (the hub's `accept` is wrapped): nothing may be sent on the device's
// old connections after the commit, they must be closed in that step, and the successor shares nothing with them.
import { defineCollection, defineModule, Llm, type LlmEvent, makeTool, type ModuleStore, type Row, Tts, type TtsAudio } from "@pva/core"
import { endOfTurn } from "@pva/core/testing"
import { type ClientMessage, CloseCode, type DeviceCapabilities, type ServerMessageOf } from "@pva/protocol"
import { Effect, Schema, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LlmBuilder } from "../src/serve/Resources.ts"
import type { HubConnection } from "../src/serve/SessionHub.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: Number(process.env.PVA_FLOOD_TIMEOUT ?? 180_000) })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

type Json = Record<string, any>

/** A small seeded generator (mulberry32), so a failing run can be repeated with its seed. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

const Item = Schema.Struct({ text: Schema.String })
const items = defineCollection({ name: "items", scope: "person", schema: Item, project: (row: Row<typeof Item.Type>) => ({ text: row.value.text }) })
let storeRef: ModuleStore | undefined

/** A tool that takes a while (a call in flight at the commit), and a person-scoped collection for feed frames. */
const busy = defineModule({
  apiVersion: 2,
  id: "busy",
  name: "Busy",
  description: "A slow tool and a person's rows",
  storage: { collections: [items] },
  shared: (ctx) =>
    Effect.sync(() => {
      storeRef = ctx.store
      return { value: undefined }
    }),
  start: () =>
    Effect.succeed({
      tools: [makeTool({
        name: "slow",
        description: "Takes a moment",
        parameters: Schema.Struct({}),
        execute: () => Effect.as(Effect.sleep(150), "done")
      })]
    })
})

/** First a tool call, then a long answer (spoken by the slow voice below). */
const toolThenLong: LlmBuilder = () =>
  Effect.succeed(Llm.of({
    stream: (request) =>
      Stream.suspend(() => {
        const last = request.messages.at(-1)
        const events: Array<LlmEvent> = last?.role === "tool"
          ? [{ _tag: "TextDelta", text: "Here is a long answer about Sam's list. " }, { _tag: "TextDelta", text: "And then some more of it. " }, { _tag: "Done", stopReason: "end" }]
          : [{ _tag: "ToolCall", id: `c${Math.random()}`, name: "slow", input: {} }, { _tag: "Done", stopReason: "tool_use" }]
        return Stream.fromIterable(events).pipe(Stream.tap(() => Effect.sleep(5)))
      })
  }))

/** 40 ms chunks, 20 ms apart: a clause takes about a second to send. */
const slowTts = Tts.of({
  sampleRate: 22_050,
  synthesize: (clauses) =>
    clauses.pipe(Stream.zipWithIndex, Stream.flatMap(([, clause]) =>
      Stream.fromIterable(Array.from({ length: 50 }, (): TtsAudio => ({ audio: new Uint8Array(new Int16Array(882).fill(700).buffer), clause }))).pipe(
        Stream.tap(() => Effect.sleep(20))
      )
    ))
})

const tablet: DeviceCapabilities = {
  v: 1,
  display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 2, touch: "coarse", colour: true },
  present: { kinds: { card: 1 } },
  speaker: { media: ["speech", "audio"] },
  microphone: { farField: false }
}

/** What the server did on one connection: closed (with which code) and anything sent after the commit mark. */
interface Watched {
  closeCode: number | undefined
  committed: boolean
  sentAfterCommit: Array<string>
}

let requestCounter = 0
type Request = Extract<ClientMessage, { requestId: string }>
type WithoutId<T> = T extends unknown ? Omit<T, "requestId"> : never
const request = async (client: ScriptedClient, message: WithoutId<Request>) => {
  const requestId = `r${++requestCounter}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from, timeoutMs: 15_000 })
}

const until = async (what: string, check: () => boolean, ms = 8000) => {
  for (let i = 0; i < ms / 10 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

describe("review round 2: the boundary under load", () => {
  it("every kind of boundary change, at a random point of a busy device: nothing on the old connections after the commit, the successor shares nothing", async () => {
    const seed = Number(process.env.PVA_FLOOD_SEED ?? Date.now() % 100_000)
    const next = random(seed)
    // One assistant with the busy module, answering on every browser without a phrase.
    const dataDir = mkdtempSync(join(tmpdir(), "pva-flood-"))
    const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
    await first.close()
    const path = join(dataDir, "settings.json")
    const file = JSON.parse(readFileSync(path, "utf8")) as Json
    const base = file.assistants.byId[file.assistants.order[0]]
    file.assistants = { order: ["alpha"], byId: { alpha: { ...base, id: "alpha", rev: 0, name: "Alpha", toolRounds: 3, llm: { ...base.llm, account: "anthropic", model: "m" }, modules: { busy: { on: true, offTools: [] } } } } }
    file.deviceTypes["web-voice"] = { ...file.deviceTypes["web-voice"], assistants: [{ assistant: "alpha", phrases: [] }], withoutPhrase: { mode: "assistant", assistant: "alpha" }, interruptMode: "manual" }
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
    const stt = controlledStt()
    server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "").llm, tts: slowTts }), buildLlm: toolThenLong, dataDir, catalog: [busy] })
    const store = server.handle.store

    // The server side of every connection.
    const watched = new Map<string, Watched>()
    const hub = server.handle.hub as { accept: (c: HubConnection) => unknown }
    const accept = hub.accept.bind(hub)
    hub.accept = (connection: HubConnection) => {
      const w: Watched = { closeCode: undefined, committed: false, sentAfterCommit: [] }
      watched.set(connection.id, w)
      return accept({
        ...connection,
        sendText: (text) => {
          if (w.committed) w.sentAfterCommit.push(text.slice(0, 80))
          connection.sendText(text)
        },
        sendBinary: (data) => {
          if (w.committed) w.sentAfterCommit.push(`binary ${data.byteLength}`)
          connection.sendBinary(data)
        },
        close: (code, reason) => {
          w.closeCode ??= code
          connection.close(code, reason)
        }
      })
    }
    /** The device's connections at the next commit: marked (in the commit's own step, after the server's listener). */
    let armed: Array<Watched> = []
    const problems: Array<string> = []
    store.onCommitted(() => {
      for (const w of armed) {
        if (w.closeCode === undefined) problems.push("a connection was still open after the commit")
        w.committed = true
      }
      armed = []
    })

    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    const members = async (list: ReadonlyArray<Json>) =>
      expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: list as never }, secrets: {} } })).ok).toBe(true)
    await members([{ name: "Sam" }, { name: "Robin" }])
    const people = () => store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>
    const samId = people()[0]!.id as string
    await until("the module's store", () => storeRef !== undefined)

    const D = "flood-dev-0001"
    const saveD = async (settings: Json) => {
      const r = await request(admin, { type: "device.save", target: { kind: "device", id: D }, rev: store.settings().devices[D]?.rev ?? 0, settings: settings as never })
      expect(r.ok, JSON.stringify(r)).toBe(true)
    }
    const saveType = async (settings: Json) => {
      const r = await request(admin, { type: "device.save", target: { kind: "type", type: "web-voice" }, rev: store.settings().deviceTypes["web-voice"]?.rev ?? 0, settings: settings as never })
      expect(r.ok, JSON.stringify(r)).toBe(true)
    }
    const caps = (noSpeaker: boolean, noDisplay = false, excludeKinds: ReadonlyArray<string> = []) => ({ noSpeaker, noDisplay, excludeKinds })
    const place = (privacy: "private" | "shared", defaultPerson: string | null) => ({ room: "Kitchen", privacy, alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson })

    type Kind = "privacy" | "defaultPerson" | "noSpeaker" | "noDisplay" | "excludeKinds" | "typeOverride" | "memberRemoved" | "forget"
    const kinds: ReadonlyArray<Kind> = ["privacy", "defaultPerson", "noSpeaker", "noDisplay", "excludeKinds", "typeOverride", "memberRemoved", "forget"]
    const order = [...kinds, ...kinds].map((k) => ({ k, r: next() })).sort((a, b) => a.r - b.r).map((x) => x.k)
    const connect = async () => {
      const page = await ScriptedClient.connect({ url: server!.url, deviceId: D })
      clients.push(page)
      await page.hello({ device: { ...page.device, capabilities: tablet } })
      return page
    }
    const boundaryOf: Record<Kind, () => Promise<void>> = {
      privacy: () => saveD({ place: place("shared", samId) }),
      defaultPerson: () => saveD({ place: place("private", people()[1]!.id as string) }),
      noSpeaker: () => saveD({ capabilities: caps(true) }),
      noDisplay: () => saveD({ capabilities: caps(false, true) }),
      excludeKinds: () => saveD({ capabilities: caps(false, false, ["card"]) }),
      typeOverride: () => saveType({ capabilities: caps(true) }),
      memberRemoved: () => members(people().filter((p) => p.name !== "Temp")),
      forget: async () => expect((await request(admin, { type: "device.forget", id: D })).ok).toBe(true)
    }

    let rounds = 0
    const log = process.env.PVA_FLOOD_DEBUG !== undefined ? (line: string) => console.log(`[flood ${seed}] ${line}`) : () => {}
    for (const kind of order) {
      rounds++
      log(`round ${rounds}: ${kind}`)
      // The starting point: D known, private, Sam's, speaking, nothing excluded; the type without overrides; a
      // temporary member to remove.
      const setUp = await connect()
      await saveType({ capabilities: caps(false) })
      if (!people().some((p) => p.name === "Temp")) await members([...people(), { name: "Temp" }])
      // Its capabilities follow the type (null: back to the defaults), so a type override reaches it.
      await saveD({ place: place("private", samId), capabilities: null })
      // Those saves may themselves have been boundaries for the set-up page: it is not used.
      setUp.close()
      log("set up")

      const a = await connect()
      const b = await connect()
      await a.claim()
      log("claimed")
      const wa = watched.get(a.messages.find((m): m is ServerMessageOf<"welcome"> => m.type === "welcome")!.connectionId)!
      const wb = watched.get(b.messages.find((m): m is ServerMessageOf<"welcome"> => m.type === "welcome")!.connectionId)!
      const before = server.handle.sessions.get(D)
      // Everything at once: a spoken reply (tool call first), a typed turn from the other tab, rows streaming.
      stt.emit(endOfTurn(`tell me about it ${rounds}`))
      b.send({ type: "text.send", requestId: `t${++requestCounter}`, text: "and from here?", speak: false })
      let streaming = true
      const rows = (async () => {
        for (let i = 0; streaming && i < 200; i++) {
          await Effect.runPromise(storeRef!.collection(items).insert({ text: `row ${rounds}.${i}` }, { scope: { kind: "person", id: samId } }))
          await sleep(10)
        }
      })()
      await sleep(Math.floor(next() * 600))
      const oldIds = new Set<string>()
      for (const page of [a, b]) {
        for (const m of page.messages) {
          if (m.type === "conversation") oldIds.add(m.id)
          if (m.type === "welcome") for (const c of m.snapshot.conversations) oldIds.add(c.id)
          if (m.type === "turn.start" && "conversationId" in m) oldIds.add(String((m as Json).conversationId))
        }
      }
      if (before !== undefined) oldIds.add(before.conversation.conversation().id)
      armed = [wa, wb]
      // The successors connect the moment their predecessors are closed (as fast as a page could), while the old
      // session may still be stopping.
      const successor = (page: ScriptedClient) => page.closed.then(() => connect())
      const nextA = successor(a)
      const nextB = successor(b)
      log("committing")
      await boundaryOf[kind]()
      log("committed")
      streaming = false
      const closedOrNot = (page: ScriptedClient) => Promise.race([page.closed.then((c) => c.code), sleep(5000).then(() => -1)])
      expect(await closedOrNot(a), kind).toBe(CloseCode.settingsChanged)
      expect(await closedOrNot(b), kind).toBe(CloseCode.settingsChanged)
      expect(wa.committed && wb.committed, `${kind}: the commit was seen`).toBe(true)
      expect(server.handle.sessions.get(D), kind).not.toBe(before ?? null)

      // The successors: a new session, with nothing of the old one.
      const a2 = await nextA
      const b2 = await nextB
      await rows
      log("rows stopped")
      expect(wa.sentAfterCommit, `${kind} (seed ${seed}): sent on tab A after the commit`).toEqual([])
      expect(wb.sentAfterCommit, `${kind} (seed ${seed}): sent on tab B after the commit`).toEqual([])
      const welcome = a2.messages.find((m): m is ServerMessageOf<"welcome"> => m.type === "welcome")!
      expect(welcome.snapshot.history, kind).toEqual([])
      for (const c of welcome.snapshot.conversations) expect(oldIds.has(c.id), `${kind}: an old conversation id`).toBe(false)
      const read = `h${++requestCounter}`
      a2.send({ type: "conversation.read", requestId: read, assistantId: "alpha" })
      const history = await a2.waitFor("conversation.history", (m) => m.requestId === read)
      expect(history.history, kind).toEqual([])
      expect(oldIds.has(history.id), kind).toBe(false)
      await sleep(400)
      // Neither successor claimed or typed: no session of theirs exists, so anything of a session's is the old one's.
      const allowed = new Set(["welcome", "household.snapshot", "household.event", "device.setup", "conversation.history", "result", "pong", "session"])
      for (const page of [a2, b2]) {
        const leaked = page.messages.filter((m) => !allowed.has(m.type))
        expect(leaked.map((m) => m.type), `${kind} (seed ${seed}): the old session reached its successor`).toEqual([])
        expect([...page.replySamples.values()].reduce((x, y) => x + y, 0), kind).toBe(0)
      }
      expect(problems, `seed ${seed}`).toEqual([])
      a2.close()
      b2.close()
      await Promise.all([a2.closed, b2.closed])
    }
    expect(rounds).toBe(16)
  })
})
