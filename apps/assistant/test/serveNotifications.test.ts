// P9 in serve mode (docs/NOTIFICATIONS.md): the real hub and service. A ring reaches every voice page of its devices,
// again a page that says hello while it is open; a press runs through `notification.action` (the module's handler,
// answered with `result.say`); stop resolves it on every page; an admin page cannot press.
import { defineModule, type ModuleNotify } from "@pva/core"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let notify: ModuleNotify | undefined
const presses: Array<string> = []
const bell = defineModule({
  apiVersion: 2,
  id: "bell",
  name: "Bell",
  description: "Rings.",
  shared: (ctx) =>
    Effect.gen(function*() {
      notify = ctx.notify
      yield* ctx.notify.handle("answer", { run: (p) => Effect.sync(() => (presses.push(p.actionId), { say: "Snoozed." })) }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: () => Effect.succeed({})
})

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
  notify = undefined
  presses.length = 0
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("notifications in serve mode", () => {
  it("a ring to every device: pages get it, again after a hello; snooze runs the handler; stop takes it down everywhere", async () => {
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog: [greeterModule, bell] })
    const kitchen = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-0001" })
    const study = await ScriptedClient.connect({ url: server.url, deviceId: "study-00001" })
    clients.push(kitchen, study)
    await kitchen.hello()
    await study.hello()
    // The devices' records are written after their first hello.
    await sleep(300)
    const sent = await run(notify!.send({ title: "Pasta timer", text: "Ten minutes are up.", priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" }))
    const id = sent.notification.id
    const ring = await kitchen.waitFor("notification.ring", (m) => m.notification.id === id)
    expect(ring.notification).toMatchObject({ title: "Pasta timer", text: "Ten minutes are up.", priority: "ring", show: true, sound: true, actions: [{ id: "stop", label: "Stop" }, { id: "snooze", label: "Snooze" }] })
    await study.waitFor("notification.ring", (m) => m.notification.id === id)
    // A second page of the kitchen says hello while it rings: it gets the ring too.
    const kitchen2 = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-0001" })
    clients.push(kitchen2)
    await kitchen2.hello()
    await kitchen2.waitFor("notification.ring", (m) => m.notification.id === id)
    // An admin page cannot press.
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    admin.send({ type: "notification.action", requestId: "a1", id, actionId: "stop" })
    expect((await admin.waitFor("result", (m) => m.requestId === "a1")).ok).toBe(false)
    // Snooze from the study: the module's handler answers; the notification is resolved with that outcome.
    study.send({ type: "notification.action", requestId: "n1", id, actionId: "snooze" })
    const answer = await study.waitFor("result", (m) => m.requestId === "n1")
    expect([answer.ok, answer.say]).toEqual([true, "Snoozed."])
    expect(presses).toEqual(["snooze"])
    // (`from: 0`: the resolved message may come before the result.)
    for (const page of [kitchen, kitchen2, study]) expect((await page.waitFor("notification.resolved", (m) => m.id === id, { from: 0 })).outcome).toBe("snooze")
    // A second one, stopped from the kitchen: gone from every page.
    const two = await run(notify!.send({ title: "Door", priority: "ring", target: "everywhere" }))
    await study.waitFor("notification.ring", (m) => m.notification.id === two.notification.id)
    kitchen.send({ type: "notification.action", requestId: "n2", id: two.notification.id, actionId: "stop" })
    expect((await kitchen.waitFor("result", (m) => m.requestId === "n2")).say).toBe("Done.")
    await study.waitFor("notification.resolved", (m) => m.id === two.notification.id, { from: 0 })
    await kitchen2.waitFor("notification.resolved", (m) => m.id === two.notification.id, { from: 0 })
  })
})
