// Home, linked module defaults and module instances per assistant in serve mode (docs/ASSISTANTS.md §2.4, §2.6,
// WP-12a/12b/12c): the Home line reaches the prompt the model receives, Weather and Clock follow Home unless set, an
// assistant's own module values run its own instance (and are checked at `assistant.save`), and Home Assistant
// (against the fake Home Assistant server) gives its tools to the assistant that has it on.
import { type ModuleDefinition, Llm, type LlmEvent } from "@pva/core"
import { homeAssistantModule } from "@pva/module-home-assistant"
import { clockModule, weatherModule } from "@pva/modules-builtin"
import type { ClientMessage, ModuleInfo } from "@pva/protocol"
import { Effect, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startFakeHomeAssistant } from "../../../packages/module-home-assistant/test/fakeHomeAssistant.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
const after: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
  for (const f of after.splice(0)) await f()
})

type Json = Record<string, any>

/** An `Llm` that records the system prompt, the context and the tool names of every request, and answers "Ok.". */
const recordingLlm = () => {
  const requests: Array<{ system: string; context: string | undefined; tools: ReadonlyArray<string> }> = []
  const llm = Llm.of({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push({ system: request.system, context: request.context, tools: request.tools.map((t) => t.name) })
        return Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: "Ok." }, { _tag: "Done", stopReason: "end" }])
      })
  })
  return { llm, requests }
}

/** A weather lookup stand-in: records every URL, answers Utrecht and a 50 degree day. */
const weatherFetch = () => {
  const urls: Array<URL> = []
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    urls.push(url)
    const body = url.host.startsWith("geocoding")
      ? { results: [{ name: "Utrecht", latitude: 52.09, longitude: 5.12, country: "Netherlands" }] }
      : {
        current: { time: "2026-11-16T11:45", temperature_2m: 50, apparent_temperature: 48, weather_code: 3, wind_speed_10m: 9 },
        daily: { weather_code: [3], temperature_2m_max: [52], temperature_2m_min: [44], precipitation_probability_max: [10] }
      }
    return new Response(JSON.stringify(body))
  }) as typeof globalThis.fetch
  return { fetch, urls }
}

/** Alpha and Bravo on the browser defaults ("hey alpha" / "hey bravo"); `modules` per assistant. */
const dataDirWith = async (modules: { readonly alpha: Json; readonly bravo: Json }, catalog: ReadonlyArray<ModuleDefinition<any>>): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-modules-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir, catalog })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const alpha = { ...base, id: "alpha", rev: 0, name: "Alpha", prompt: "You are Alpha.", modules: modules.alpha }
  const bravo = { ...base, id: "bravo", rev: 0, name: "Bravo", prompt: "You are Bravo.", modules: modules.bravo }
  file.assistants = { order: ["alpha", "bravo"], byId: { alpha, bravo } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: "bravo", phrases: ["hey bravo"] }],
    withoutPhrase: { mode: "nobody" }
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

const start = async (modules: { readonly alpha: Json; readonly bravo: Json }, catalog: ReadonlyArray<ModuleDefinition<any>>) => {
  const llm = recordingLlm()
  server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: llm.llm }), dataDir: await dataDirWith(modules, catalog), catalog: [...catalog] })
  return llm
}

const connect = async () => {
  const client = await ScriptedClient.connect({ url: server!.url })
  clients.push(client)
  return client
}

type RequestInput = Extract<ClientMessage, { readonly requestId: string }> extends infer M ? M extends unknown ? Omit<M, "requestId"> : never : never
let seq = 0
const request = async (client: ScriptedClient, message: RequestInput) => {
  const requestId = `r${++seq}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from })
}

/** A typed turn to `assistantId`, finished. */
const typed = async (page: ScriptedClient, text: string, assistantId: string) => {
  const from = page.messages.length
  page.send({ type: "text.send", requestId: `t-${from}`, text, speak: false, assistantId })
  await page.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
}

/** The module's latest info an admin page holds. */
const moduleOf = (admin: ScriptedClient, id: string): ModuleInfo | undefined => {
  let found: ModuleInfo | undefined
  for (const m of admin.messages) {
    if (m.type === "admin.snapshot") found = m.snapshot.modules.find((x) => x.id === id) ?? found
    else if (m.type === "module.changed" && m.module.id === id) found = m.module
  }
  return found
}

const until = async (what: () => boolean) => {
  for (let i = 0; i < 300 && !what(); i++) await sleep(10)
  expect(what()).toBe(true)
}

/** An assistant's tool in the running host (its instance). */
const toolOf = (assistantId: string, name: string) =>
  (server!.handle.host.snapshot().assistantParts.get(assistantId) ?? []).flatMap((p) => p.module.tools ?? []).find((t) => t.name === name)

describe("Home and module instances (WP-12a/12b)", () => {
  it("the Home line is in the prompt the model receives; Weather and Clock follow Home; an own date format answers that assistant in it", async () => {
    const weather = weatherFetch()
    const llm = await start(
      {
        alpha: { clock: { on: true, offTools: [] }, weather: { on: true, offTools: [] } },
        bravo: { clock: { on: true, offTools: [], own: { locale: "nl-NL" } } }
      },
      [clockModule, weatherModule({ fetch: weather.fetch })]
    )
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const page = await connect()
    await page.hello()

    // Before Home is set: the machine's zone and the default language; Weather has no place.
    await typed(page, "first", "alpha")
    expect(llm.requests[0]!.system).toContain(`Home: time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}; language en-GB.`)
    expect(moduleOf(admin, "weather")!.settings.values).toMatchObject({ defaultPlace: "", units: "celsius" })

    const saved = await request(admin, {
      type: "settings.update",
      sectionId: "home",
      patch: {
        values: { HOME_LOCATION: "Utrecht, Netherlands", HOME_TIME_ZONE: " Asia/Tokyo ", HOME_LANGUAGE: "nl-NL", HOME_UNITS: "imperial", HOME_DATE_FORMAT: "en-US" },
        secrets: {}
      }
    })
    expect(saved.ok).toBe(true)
    // The linked defaults moved with Home (nothing is saved for these modules).
    await until(() => moduleOf(admin, "weather")?.settings.values.defaultPlace === "Utrecht, Netherlands")
    expect(moduleOf(admin, "weather")!.settings.values.units).toBe("fahrenheit")
    await until(() => moduleOf(admin, "clock")?.settings.values.timeZone === "Asia/Tokyo")
    expect(moduleOf(admin, "clock")!.settings.values.locale).toBe("en-US")
    await until(() => moduleOf(admin, "clock")?.instances?.length === 2 && moduleOf(admin, "clock")!.state === "running")
    expect(moduleOf(admin, "clock")!.instances!.map((i) => [i.assistants, i.own])).toEqual([[["alpha"], []], [["bravo"], ["locale"]]])
    expect(moduleOf(admin, "clock")!.settings.fields.map((f) => [f.key, f.overridable === true])).toEqual([["timeZone", true], ["locale", true]])

    await typed(page, "second", "alpha")
    await typed(page, "third", "bravo")
    const home = "Home: Utrecht, Netherlands; time zone Asia/Tokyo; language nl-NL."
    expect(llm.requests[1]!.system).toContain(home)
    expect(llm.requests[1]!.system).toContain("You are Alpha.")
    expect(llm.requests[2]!.system).toContain(home)
    expect(llm.requests[2]!.system).toContain("You are Bravo.")
    // The clock's context: Alpha in Home's date format (en-US), Bravo in its own (nl-NL); both in Home's zone.
    expect(llm.requests[1]!.context).toMatch(/It is [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}, .* local time \(Asia\/Tokyo\)\./)
    expect(llm.requests[2]!.context).toMatch(/It is [a-z]+dag \d{1,2} [a-z]+ \d{4}, .* local time \(Asia\/Tokyo\)\./)
    expect(llm.requests[1]!.tools).toEqual(["current_time", "clock_time_now", "weather"])
    expect(llm.requests[2]!.tools).toEqual(["current_time", "clock_time_now"])

    // The weather tool without a place looks up Home, in Home's units.
    const report = (await Effect.runPromise(toolOf("alpha", "weather")!.execute({}))) as { now: string }
    expect(weather.urls.at(-2)!.searchParams.get("name")).toBe("Utrecht")
    expect(weather.urls.at(-1)!.searchParams.get("temperature_unit")).toBe("fahrenheit")
    expect(report.now).toContain("50°F")
  })

  it("assistant.save: own values of overridable fields are accepted and run an instance; secrets, shared fields and bad values are refused", async () => {
    await start(
      { alpha: { clock: { on: true, offTools: [] }, greeter: { on: true, offTools: [] } }, bravo: { clock: { on: true, offTools: [] } } },
      [clockModule, weatherModule({ fetch: weatherFetch().fetch }), greeterModule]
    )
    const admin = await connect()
    const welcome = await admin.admin(TEST_ADMIN_PASSWORD)
    // One clock for both: they have equal settings.
    expect(welcome.snapshot.modules.find((m) => m.id === "clock")!.instances).toEqual([{ assistants: ["alpha", "bravo"], own: [], state: "running" }])
    // Weather: nobody has it on, so it does not run (its own switch is not read).
    expect(welcome.snapshot.modules.find((m) => m.id === "weather")).toMatchObject({ enabled: false, state: "disabled", instances: [] })
    const stored = (welcome.snapshot.assistants ?? []).find((a) => a.id === "bravo")!
    const { problems: _p, resources: _r, usedOn: _u, ...bravo } = stored as any

    const refused = await request(admin, {
      type: "assistant.save",
      assistant: {
        ...bravo,
        modules: {
          clock: { on: true, offTools: [], own: { locale: "xx-XX" } },
          weather: { on: true, offTools: [], own: { timeoutMs: 500 } },
          greeter: { on: true, offTools: [], own: { token: "mine" } }
        }
      }
    })
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_settings" } })
    expect(refused.error?.fieldErrors?.map((e) => e.key).sort()).toEqual(["modules.clock.own.locale", "modules.greeter.own.token", "modules.weather.own.timeoutMs"])

    const ok = await request(admin, { type: "assistant.save", assistant: { ...bravo, modules: { clock: { on: true, offTools: [], own: { timeZone: "America/New_York" } } } } })
    expect(ok.ok).toBe(true)
    await until(() => moduleOf(admin, "clock")?.instances?.length === 2 && moduleOf(admin, "clock")!.state === "running")
    expect(moduleOf(admin, "clock")!.instances!.map((i) => [i.assistants, i.own])).toEqual([[["alpha"], []], [["bravo"], ["timeZone"]]])
    const nowIn = async (assistantId: string) =>
      ((await Effect.runPromise(toolOf(assistantId, "current_time")!.execute({ timeZone: "UTC" }))) as { date: string }).date
    expect(await nowIn("alpha")).toMatch(/\d{4}$/)
    const context = await Effect.runPromise(
      Effect.forEach(server!.handle.host.snapshot().assistantParts.get("bravo")!.flatMap((p) => p.module.context ?? []), (c) => c.get)
    )
    expect(context.join("\n")).toContain("(America/New_York)")

    // Back to the shared settings: one instance again; the other closes after its grace period.
    const fresh = (await (async () => {
      await until(() => admin.messages.some((m) => m.type === "assistants" && m.assistants.some((a) => a.id === "bravo" && a.rev === bravo.rev + 1)))
      return [...admin.messages].reverse().find((m) => m.type === "assistants")!
    })()) as Json
    const { problems: _q, resources: _s, usedOn: _v, ...latest } = fresh.assistants.find((a: Json) => a.id === "bravo")
    expect((await request(admin, { type: "assistant.save", assistant: { ...latest, modules: { clock: { on: true, offTools: [] } } } })).ok).toBe(true)
    await until(() => moduleOf(admin, "clock")?.instances?.length === 1)
    expect(moduleOf(admin, "clock")!.instances![0]!.assistants).toEqual(["alpha", "bravo"])
    // Its own switch is the assistants' now.
    expect((await request(admin, { type: "module.disable", moduleId: "clock" })).error?.code).toBe("not_allowed")
  })
})

describe("Home Assistant in the app (WP-12c)", () => {
  it("is in the catalog; with the shared address and token it starts against the (fake) Home Assistant, and its tools reach the assistant that has it on", async () => {
    const ha = await startFakeHomeAssistant()
    after.push(ha.close)
    const llm = await start(
      { alpha: { "home-assistant": { on: true, offTools: ["home-assistant_set_brightness"] } }, bravo: {} },
      [homeAssistantModule()]
    )
    const admin = await connect()
    const welcome = await admin.admin(TEST_ADMIN_PASSWORD)
    // Without a token it cannot run: one instance, in error, for Alpha.
    const before = welcome.snapshot.modules.find((m) => m.id === "home-assistant")!
    expect(before).toMatchObject({ enabled: true, state: "error" })
    expect(before.settings.fields.map((f) => [f.key, f.overridable === true])).toEqual([
      ["baseUrl", false],
      ["token", false],
      ["domains", true],
      ["aliases", false],
      ["timeoutMs", false],
      ["server", false],
      ["lists", false],
      ["test", false]
    ])
    const configured = await request(admin, { type: "module.configure", moduleId: "home-assistant", patch: { values: { baseUrl: ha.url }, secrets: { token: ha.token } } })
    expect(configured.ok).toBe(true)
    await until(() => moduleOf(admin, "home-assistant")?.state === "running")
    expect(moduleOf(admin, "home-assistant")!.instances).toEqual([expect.objectContaining({ assistants: ["alpha"], own: [], state: "running" })])
    expect(ha.requests.some((r) => r.path === "/api/config" && r.authorization === `Bearer ${ha.token}`)).toBe(true)
    expect(JSON.stringify(admin.messages)).not.toContain(ha.token)

    const page = await connect()
    await page.hello()
    await typed(page, "which lights are on", "alpha")
    await typed(page, "tell me a joke", "bravo")
    expect(llm.requests[0]!.tools).toEqual(["home_state", "home-assistant_lights_on", "home-assistant_lights_off", "home-assistant_lights_status"])
    expect(llm.requests[0]!.system).toContain("controlled through Home Assistant")
    expect(llm.requests[1]!.tools).toEqual([])
    expect(llm.requests[1]!.system).not.toContain("Home Assistant")
    // The tool works against the server.
    const state = String(await Effect.runPromise(toolOf("alpha", "home_state")!.execute({}).pipe(Effect.map((v) => JSON.stringify(v)))))
    expect(state).toContain("Living room")
  })
})
