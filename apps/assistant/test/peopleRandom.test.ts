// P5 review round 2, decision 4: people writes are all-or-nothing, the caches included. Randomised: concurrent diet
// edits (some interrupted at a random point), Members additions and removals, and device and device type saves naming
// a default person, with every settings write delayed by a random few milliseconds. Sampled all the time: the
// committed settings, the People service and the privacy rule never disagree, and no device's effective default
// person is someone who is not a member; at every pause, no stored reference dangles and the gate still works.
import { defineModule, Devices, type ModuleHostApi, People, Privacy } from "@pva/core"
import { BUILT_IN_PLACE, type ClientMessage } from "@pva/protocol"
import { Effect, Exit, Fiber } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 120_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

type Json = Record<string, any>
let hostRef: ModuleHostApi | undefined
const probe = defineModule({
  apiVersion: 2,
  id: "people-probe",
  name: "People probe",
  description: "Reaches the core's services",
  shared: (ctx) =>
    Effect.sync(() => {
      hostRef = ctx.host
      return { value: undefined }
    }),
  start: () => Effect.succeed({})
})

describe("review round 2: people under concurrent edits and interruptions", () => {
  it("settings, People and privacy never disagree; no reference dangles; the gate survives interruptions", async () => {
    const seed = Number(process.env.PVA_PEOPLE_SEED ?? Date.now() % 100_000)
    const next = random(seed)
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)]!
    server = await startTestServer({
      build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }),
      catalog: [probe],
      // Every settings write waits a random few milliseconds (wider windows for the races).
      settingsBeforeStep: () => sleep(Math.floor(next() * 12))
    })
    const store = server.handle.store
    for (let i = 0; i < 400 && hostRef === undefined; i++) await sleep(10)
    const people = hostRef!.service(People)!
    const privacy = hostRef!.service(Privacy)!
    const devices = hostRef!.service(Devices)!

    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    let requestCounter = 0
    const request = (message: Record<string, unknown>) => {
      const requestId = `r${++requestCounter}`
      const from = admin.messages.length
      admin.send({ ...message, requestId } as ClientMessage)
      return admin.waitFor("result", (m) => m.requestId === requestId, { from, timeoutMs: 15_000 })
    }
    const stored = (): ReadonlyArray<Json> => (store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json> | undefined) ?? []
    expect((await request({ type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Sam" }, { name: "Robin" }, { name: "Kim" }] }, secrets: {} } })).ok).toBe(true)

    // A private device: the privacy rule says yes for exactly the members.
    const D = "people-rand-01"
    const page = await ScriptedClient.connect({ url: server.url, deviceId: D })
    clients.push(page)
    await page.hello()
    const place = (defaultPerson: string | null) => ({ ...BUILT_IN_PLACE, privacy: "private", defaultPerson })
    expect((await request({ type: "device.save", target: { kind: "device", id: D }, rev: store.settings().devices[D]!.rev, settings: { place: place(null) } })).ok).toBe(true)

    // Sampled all the time.
    const problems: Array<string> = []
    let everRemoved = new Set<string>()
    const check = (when: string) => {
      const ids = stored().map((m) => m.id as string)
      const listed = people.list().map((p) => p.id)
      if (JSON.stringify(listed) !== JSON.stringify(ids)) problems.push(`${when}: People ${listed} but settings ${ids}`)
      for (const m of stored()) {
        const p = people.get(m.id)
        if (p === undefined) {
          problems.push(`${when}: ${m.id} in settings, not in People`)
          continue
        }
        for (const k of ["allergies", "diets", "dislikes"] as const) {
          if (JSON.stringify(p.diet[k] ?? []) !== JSON.stringify(m[k] ?? [])) problems.push(`${when}: ${m.id} ${k} People ${JSON.stringify(p.diet[k])}, settings ${JSON.stringify(m[k])}`)
        }
        if (!privacy.mayReveal(m.id, D)) problems.push(`${when}: privacy refuses member ${m.id}`)
      }
      for (const gone of everRemoved) {
        if (ids.includes(gone)) continue
        if (people.get(gone) !== undefined) problems.push(`${when}: removed ${gone} still in People`)
        if (privacy.mayReveal(gone, D)) problems.push(`${when}: privacy allows removed ${gone}`)
      }
      const effective = devices.get(D)?.place.defaultPerson ?? null
      if (effective !== null && !ids.includes(effective)) problems.push(`${when}: the device's effective default person ${effective} is not a member`)
    }
    const sampler = setInterval(() => check("sample"), 2)
    const noDangling = (when: string) => {
      const ids = new Set(stored().map((m) => m.id as string))
      const file = store.settings()
      for (const [id, d] of Object.entries(file.devices)) {
        const p = d.own.place?.defaultPerson
        if (p !== undefined && p !== null && !ids.has(p)) problems.push(`${when}: device ${id} names ${p}`)
      }
      for (const [kind, t] of Object.entries(file.deviceTypes)) {
        const p = (t as Json).place?.defaultPerson
        if (p !== undefined && p !== null && !ids.has(p)) problems.push(`${when}: type ${kind} names ${p}`)
      }
    }

    let added = 0
    let interrupted = 0
    for (let batch = 0; batch < 8; batch++) {
      const running: Array<Promise<unknown>> = []
      for (let op = 0; op < 6; op++) {
        const kind = pick(["diet", "diet", "diet", "add", "remove", "device", "type"] as const)
        const current = stored().map((m) => m.id as string)
        if (kind === "diet") {
          const who = next() < 0.85 && current.length > 0 ? pick(current) : pick([...everRemoved, "p-nobody00"])
          const fiber = Effect.runFork(people.setDiet({ person: who }, { [pick(["allergies", "diets", "dislikes"] as const)]: [`x${Math.floor(next() * 1000)}`] }))
          if (next() < 0.5) {
            const after = Math.floor(next() * 25)
            running.push(sleep(after).then(() => Effect.runPromise(Fiber.interrupt(fiber))).then(() => void interrupted++))
          } else running.push(Effect.runPromise(Fiber.await(fiber)).then((exit) => Exit.isSuccess(exit) || true))
        } else if (kind === "add") {
          const list = [...stored(), { name: `Person ${++added}` }]
          if (list.length <= 20) running.push(request({ type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: list }, secrets: {} } }))
        } else if (kind === "remove") {
          if (current.length <= 1) continue
          const gone = pick(current)
          everRemoved = new Set([...everRemoved, gone])
          running.push(request({ type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: stored().filter((m) => m.id !== gone) }, secrets: {} } }))
        } else if (kind === "device") {
          running.push(request({ type: "device.save", target: { kind: "device", id: D }, rev: store.settings().devices[D]?.rev ?? 0, settings: { place: place(current.length > 0 ? pick(current) : null) } }))
        } else {
          running.push(request({ type: "device.save", target: { kind: "type", type: "web-voice" }, rev: store.settings().deviceTypes["web-voice"]?.rev ?? 0, settings: { place: { ...place(current.length > 0 ? pick(current) : null), privacy: "shared" } } }))
        }
        await sleep(Math.floor(next() * 15))
      }
      await Promise.all(running)
      // Whatever was interrupted: the gate is free and the caches follow what was committed.
      await sleep(100)
      check(`after batch ${batch}`)
      noDangling(`after batch ${batch}`)
    }
    clearInterval(sampler)
    // The gate still works: one more diet goes through and is read back at once.
    const last = stored()[0]!.id as string
    await Effect.runPromise(people.setDiet({ person: last }, { dislikes: ["final"] }))
    expect(people.dietOf(last).dislikes).toContain("final")
    expect(problems.slice(0, 10), `seed ${seed}`).toEqual([])
    expect(interrupted).toBeGreaterThan(0)
  })
})
