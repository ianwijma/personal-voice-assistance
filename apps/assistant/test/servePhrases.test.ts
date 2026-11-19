// P7 in serve mode (docs/PHRASES.md): the real hub, voice sessions, notification service and module host. "quieter"
// reaches every voice page of the device as `output.volume`, again after a hello, and `DeviceControl` reads it; the
// ringing window takes a ringing card's button without the wake phrase on a device that answers nobody, and "stop" stops
// the ring; a module's phrase command runs; session control is a core service; after a server restart the volume is the
// default again and the commands work.
import { defineAction, defineModule, DeviceControl, type DeviceControlService, type ModuleNotify, Param, SessionControl, type SessionControlService } from "@pva/core"
import { endOfTurn } from "@pva/core/testing"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let notify: ModuleNotify | undefined
let session: SessionControlService | undefined
let device: DeviceControlService | undefined
const presses: Array<string> = []
const boiled: Array<string> = []
const egg = defineModule({
  apiVersion: 2,
  id: "egg",
  name: "Egg",
  description: "Rings, and starts by phrase.",
  shared: (ctx) =>
    Effect.gen(function*() {
      notify = ctx.notify
      session = ctx.host.service(SessionControl)
      device = ctx.host.service(DeviceControl)
      yield* ctx.notify.handle("answer", { run: (p) => Effect.sync(() => (presses.push(p.actionId), { say: "Snoozed." })) }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: () =>
    Effect.succeed({
      actions: [defineAction({
        id: "boil",
        label: "Boil an egg",
        description: "Boils an egg.",
        examples: ["boil an egg"],
        params: { length: Param.duration({ label: "Length", optional: true }) },
        phrases: { en: ["boil an egg"] },
        risk: "change",
        run: () => Effect.sync(() => (boiled.push("boil"), { say: "Egg on." }))
      })]
    })
})

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
  notify = undefined
  presses.length = 0
  boiled.length = 0
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const untilOpen = async (stt: ReturnType<typeof controlledStt>, n: number) => {
  for (let i = 0; i < 300 && stt.open() < n; i++) await sleep(10)
  expect(stt.open()).toBe(n)
}

const duck = defineModule({
  apiVersion: 2,
  id: "duck",
  name: "Duck",
  description: "Has the same phrase as the egg.",
  start: () =>
    Effect.succeed({
      actions: [defineAction({ id: "boil", label: "Boil", description: "Boils.", examples: ["boil an egg"], params: {}, phrases: { en: ["boil an egg", "boil a duck egg"] }, risk: "change", run: () => Effect.succeed({ say: "Duck egg on." }) })]
    })
})

const start = async (o: { readonly dataDir?: string; readonly wakePhrase?: boolean; readonly duck?: boolean } = {}) => {
  const stt = controlledStt()
  server = await startTestServer({
    build: fakeBuild({ stt: stt.stt, llm: scriptedLlm((t) => `Reply to ${t}.`).llm }),
    catalog: o.duck === true ? [greeterModule, egg, duck] : [greeterModule, egg],
    ...(o.dataDir !== undefined ? { dataDir: o.dataDir } : {}),
    ...(o.wakePhrase === true ? { kindDefaults: { interruptMode: "instant", activation: "wake-phrase" } } : {})
  })
  // The migrated assistant has every module of the catalogue that is on by default (egg is) switched on.
  return { stt }
}

describe("phrase commands in serve mode", () => {
  it("'quieter' reaches every voice page of the device as output.volume, again after a hello; DeviceControl reads it; other devices keep theirs", async () => {
    const { stt } = await start()
    const a = await ScriptedClient.connect({ url: server!.url, deviceId: "kitchen-0001" })
    const a2 = await ScriptedClient.connect({ url: server!.url, deviceId: "kitchen-0001" })
    const b = await ScriptedClient.connect({ url: server!.url, deviceId: "study-00001" })
    clients.push(a, a2, b)
    await a.hello()
    await a2.hello()
    await b.hello()
    await a.claim()
    await untilOpen(stt, 1)
    stt.emitTo(0, { _tag: "SpeechStarted" }, endOfTurn("quieter"))
    expect((await a.waitFor("output.volume")).volume).toBe(0.8)
    expect((await a2.waitFor("output.volume")).volume).toBe(0.8)
    // The answer is spoken (a canned reply), and nothing of "quieter" became a turn of the conversation.
    await a.waitFor("turn.start", (m) => m.userText === "")
    expect(a.messages.some((m) => m.type === "turn.start" && m.userText.includes("quieter"))).toBe(false)
    expect(device?.replyVolume("kitchen-0001")).toBe(0.8)
    expect(device?.replyVolume("study-00001")).toBe(1)
    expect(b.messages.some((m) => m.type === "output.volume")).toBe(false)
    // A new tab of the kitchen is told after its welcome; a new study tab is told nothing (the default).
    const a3 = await ScriptedClient.connect({ url: server!.url, deviceId: "kitchen-0001" })
    const b2 = await ScriptedClient.connect({ url: server!.url, deviceId: "study-00001" })
    clients.push(a3, b2)
    await a3.hello()
    await b2.hello()
    expect((await a3.waitFor("output.volume")).volume).toBe(0.8)
    await sleep(200)
    expect(b2.messages.some((m) => m.type === "output.volume")).toBe(false)
    // DeviceControl, as a module calls it.
    expect(await run(device!.changeReplyVolume("kitchen-0001", "louder"))).toEqual({ level: 1, atLimit: false })
    expect((await a.waitFor("output.volume", (m) => m.volume === 1)).volume).toBe(1)
  })

  it("a module's phrase command runs without the model; repeat, and SessionControl as a service", async () => {
    const { stt } = await start()
    const a = await ScriptedClient.connect({ url: server!.url, deviceId: "kitchen-0001" })
    clients.push(a)
    await a.hello()
    await a.claim()
    await untilOpen(stt, 1)
    stt.emitTo(0, { _tag: "SpeechStarted" }, endOfTurn("boil an egg"))
    await a.waitFor("assistant.text", (m) => m.text.includes("Egg on."))
    expect(boiled).toEqual(["boil"])
    expect(a.messages.some((m) => m.type === "turn.start" && m.userText === "boil an egg")).toBe(false)
    await a.waitFor("turn.end")
    expect(await run(session!.repeatLast("kitchen-0001"))).toBe(true)
    await a.waitFor("turn.start", (m) => m.userText === "", { from: a.messages.length - 1 })
    expect(await run(session!.repeatLast("nowhere-0001"))).toBe(false)
    expect(await run(session!.newConversation("nowhere-0001"))).toBeUndefined()
  })

  it("the ringing window on a device that answers nobody: a card's button and 'stop' without the wake phrase", async () => {
    const { stt } = await start({ wakePhrase: true })
    const a = await ScriptedClient.connect({ url: server!.url, deviceId: "kitchen-0001" })
    clients.push(a)
    await a.hello()
    await a.claim()
    await untilOpen(stt, 1)
    await sleep(300)
    const first = await run(notify!.send({ title: "Egg", priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" }))
    await a.waitFor("notification.ring", (m) => m.notification.id === first.notification.id)
    stt.emitTo(0, { _tag: "SpeechStarted" }, endOfTurn("Snooze."))
    expect((await a.waitFor("notification.resolved", (m) => m.id === first.notification.id)).outcome).toBe("snooze")
    expect(presses).toEqual(["snooze"])
    const second = await run(notify!.send({ title: "Door", priority: "ring", target: "everywhere" }))
    await a.waitFor("notification.ring", (m) => m.notification.id === second.notification.id)
    stt.emitTo(0, { _tag: "SpeechStarted" }, endOfTurn("stop"))
    expect((await a.waitFor("notification.resolved", (m) => m.id === second.notification.id)).outcome).toBe("stop")
    // Nothing rings: "stop" without the wake phrase is dropped as before (the device answers nobody without one).
    const before = a.messages.length
    stt.emitTo(0, { _tag: "SpeechStarted" }, endOfTurn("stop"))
    await sleep(400)
    expect(a.messages.slice(before).some((m) => m.type === "turn.start")).toBe(false)
  })

  it("two modules with the same phrase for an assistant: both left out (it goes to the model) and named on the Health page", async () => {
    const { stt } = await start({ duck: true })
    for (let i = 0; i < 100 && !server!.handle.host.issues.all().some((x) => x.id.startsWith("phrases.")); i++) await sleep(20)
    const issue = server!.handle.host.issues.all().find((x) => x.id.includes(".duplicate.en.boil an egg"))
    expect(issue?.title).toContain("egg.boil and duck.boil")
    const a = await ScriptedClient.connect({ url: server!.url, deviceId: "kitchen-0001" })
    clients.push(a)
    await a.hello()
    await a.claim()
    await untilOpen(stt, 1)
    stt.emitTo(0, { _tag: "SpeechStarted" }, endOfTurn("boil an egg"))
    await a.waitFor("turn.start", (m) => m.userText === "boil an egg")
    expect(boiled).toEqual([])
    stt.emitTo(0, { _tag: "SpeechStarted" }, endOfTurn("boil a duck egg"))
    await a.waitFor("assistant.text", (m) => m.text.includes("Duck egg on."))
  })

  it("after a server restart: the reply volume is the default again (memory only) and the phrases work", async () => {
    const first = await start()
    const dataDir = server!.dataDir
    const a = await ScriptedClient.connect({ url: server!.url, deviceId: "kitchen-0001" })
    clients.push(a)
    await a.hello()
    await a.claim()
    await untilOpen(first.stt, 1)
    first.stt.emitTo(0, { _tag: "SpeechStarted" }, endOfTurn("quieter"))
    expect((await a.waitFor("output.volume")).volume).toBe(0.8)
    a.close()
    clients.length = 0
    await server!.close()
    server = undefined
    const second = await start({ dataDir })
    const b = await ScriptedClient.connect({ url: server!.url, deviceId: "kitchen-0001" })
    clients.push(b)
    await b.hello()
    await b.claim()
    await untilOpen(second.stt, 1)
    await sleep(200)
    expect(b.messages.some((m) => m.type === "output.volume")).toBe(false)
    second.stt.emitTo(0, { _tag: "SpeechStarted" }, endOfTurn("quieter"))
    expect((await b.waitFor("output.volume")).volume).toBe(0.8)
    second.stt.emitTo(0, { _tag: "SpeechStarted" }, endOfTurn("boil an egg"))
    await b.waitFor("assistant.text", (m) => m.text.includes("Egg on."))
  })
})
