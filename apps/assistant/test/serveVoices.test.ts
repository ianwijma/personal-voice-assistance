// The voice picker's HTTP API through serve mode (docs/VOICE-PROVIDERS.md §5): auth, providers and their status,
// voice lists and their cache, previews (local and hosted), downloads, favourites and the assistant's voice. The
// hosted providers are fakes (no network, no paid calls); their REST mapping is tested in the adapters against
// local mock servers. Local previews use a tone engine instead of a model.
import { type Tts, TtsVoices, VoiceCatalogError } from "@pva/core"
import type { ToolId } from "@pva/protocol"
import * as SherpaTts from "@pva/tts-sherpa"
import { Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PresetDownloader } from "../src/serve/models.ts"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, type TestServer, TEST_ADMIN_PASSWORD, toneTts } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 20_000 })

const EL_KEY = "el-test-key-SECRET-1234567890"

let servers: Array<TestServer> = []
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) await s.close()
  servers = []
})

/** Writes a preset's files (empty) into `dir`, so it counts as downloaded. */
const install = (dir: string, preset: string) => {
  for (const file of Object.values(SherpaTts.presetFiles(SherpaTts.presets[preset]!, dir))) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "x")
  }
}

/** A hosted provider stand-in: two voices; previews return 0.1 s of PCM; "gone" is a voice it does not have. */
const fakeHosted = () => {
  const calls = { list: 0, preview: [] as Array<string> }
  const service = TtsVoices.of({
    list: Effect.sync(() => {
      calls.list++
      return {
        voices: [
          { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", description: "Warm.", language: "en", gender: "female" as const, tags: ["american"] },
          { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", tags: ["british"] }
        ],
        truncated: false
      }
    }),
    preview: (voiceId, text) =>
      voiceId === "gone"
        ? Effect.fail(new VoiceCatalogError({ reason: "unknown_voice", message: "ElevenLabs does not have that voice" }))
        : Effect.sync(() => {
          calls.preview.push(`${voiceId}:${text}`)
          return { sampleRate: 24_000, pcm: new Uint8Array(4_800) }
        })
  })
  return { calls, service }
}

/** Downloads that write the preset's files (so the voice list sees them) unless cancelled. */
const fakeDownloader = (dir: string, steps = 25): Readonly<Record<ToolId, PresetDownloader>> => {
  const tts: PresetDownloader = {
    installed: (name) => SherpaTts.isInstalled(name, dir),
    download: (name, { signal, onProgress }) =>
      new Promise((resolve, reject) => {
        let step = 0
        const tick = () => {
          if (signal.aborted) return reject(new Error("Cancelled"))
          onProgress({ phase: "download", done: ++step * 1000, total: steps * 1000, archive: name })
          if (step >= steps) {
            install(dir, name)
            return resolve(undefined)
          }
          setTimeout(tick, 20)
        }
        setTimeout(tick, 20)
      }),
    remove: async () => ({ removed: [] })
  }
  return { "stt-models": tts, "tts-models": tts }
}

const start = async (
  options: { readonly env?: Record<string, string>; readonly installed?: ReadonlyArray<string>; readonly shared?: boolean } = {}
) => {
  const modelDir = mkdtempSync(join(tmpdir(), "pva-voices-"))
  for (const preset of options.installed ?? ["en_US-lessac-medium"]) install(modelDir, preset)
  const hosted = fakeHosted()
  const engines = { started: [] as Array<string>, closed: 0, speakers: [] as Array<number> }
  const stt = controlledStt()
  const server = await startTestServer({
    build: fakeBuild({ stt: stt.stt, llm: scriptedLlm((t) => `You said: ${t}.`).llm }),
    env: { TTS_SHERPA_MODEL_DIR: modelDir, ELEVENLABS_API_KEY: EL_KEY, ...options.env },
    hostedVoices: { elevenlabs: Effect.succeed(hosted.service) },
    localPreviewEngine: (preset) =>
      Effect.acquireRelease(
        Effect.sync((): Tts["Service"] | SherpaTts.SharedEngine => {
          engines.started.push(preset)
          const tts = toneTts({ sampleRate: 22_050, millisPerClause: 80 })
          // `shared`: like the real preview engine, it also speaks the other presets of its set-up (records their speaker).
          return options.shared === true
            ? SherpaTts.shareEngine(SherpaTts.presets[preset]!, { tts, forSpeaker: (speaker) => (engines.speakers.push(speaker), tts) })
            : tts
        }),
        () => Effect.sync(() => engines.closed++)
      ),
    modelDownloaders: fakeDownloader(modelDir),
    freeBytes: async () => 50e9
  })
  servers.push(server)
  const admin = await ScriptedClient.connect({ url: server.url })
  clients.push(admin)
  const { token } = await admin.admin(TEST_ADMIN_PASSWORD)
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${server.url}/api/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
    })
    const type = response.headers.get("content-type") ?? ""
    const data = type.startsWith("application/json") ? await response.json() as any : new Uint8Array(await response.arrayBuffer())
    return { status: response.status, headers: response.headers, data }
  }
  return { server, api, hosted, engines, modelDir, stt, token, admin }
}

const lessac = { provider: "sherpa", voiceId: "en_US-lessac-medium" }
const pim = { provider: "sherpa", voiceId: "nl_NL-pim-medium" }
const kokoro = { provider: "sherpa", voiceId: "kokoro-af_heart" }
const sarah = { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL" }
const skylar = { provider: "cartesia", voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" }

describe("voice API: access", () => {
  it("needs the admin token; refuses another origin; unknown paths and methods", async () => {
    const { server, api } = await start()
    const none = await fetch(`${server.url}/api/voices`)
    expect(none.status).toBe(401)
    expect((await none.json() as any).error.code).toBe("admin_required")
    const wrong = await fetch(`${server.url}/api/voices`, { headers: { Authorization: `Bearer ${"x".repeat(43)}` } })
    expect(wrong.status).toBe(401)
    const foreign = await api("GET", "voices", undefined, { Origin: "https://evil.example" })
    expect(foreign.status).toBe(403)
    expect(foreign.data.error.code).toBe("forbidden_origin")
    expect((await api("GET", "nothing-here")).status).toBe(404)
    expect((await api("DELETE", "voices")).data.error.code).toBe("method_not_allowed")
    expect((await api("POST", "voices/preview", "{not json")).data.error.code).toBe("invalid_request")
    expect((await api("POST", "voices/preview", "x".repeat(5_000))).status).toBe(413)
  })

  it("an allowed other origin (the UI on next dev) gets CORS for itself and its preflight answered; its own origin none", async () => {
    const { server, api } = await start()
    const preflight = await fetch(`${server.url}/api/voices/favourites/sherpa%3Aen_US-lessac-medium`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization, content-type" }
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT")
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/authorization/i)
    const allowed = await api("GET", "voices/favourites", undefined, { Origin: "http://localhost:3000" })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(allowed.headers.get("access-control-expose-headers")).toContain("X-Voice-Sample-Rate")
    // Refusals carry it too, so the page can read why.
    const unauthorised = await fetch(`${server.url}/api/voices`, { headers: { Origin: "http://localhost:3000" } })
    expect(unauthorised.status).toBe(401)
    expect(unauthorised.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    const same = await api("GET", "voices/favourites")
    expect(same.headers.get("access-control-allow-origin")).toBeNull()
    const evil = await fetch(`${server.url}/api/voices`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } })
    expect(evil.status).toBe(403)
    expect(evil.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("voice API: providers and voices", () => {
  it("lists every provider with its status: a missing key is needs_key, not an error, and never a key", async () => {
    const { api } = await start()
    const { status, data } = await api("GET", "voice-providers")
    expect(status).toBe(200)
    const byId = Object.fromEntries(data.providers.map((p: any) => [p.id, p]))
    expect(byId.sherpa).toMatchObject({ label: "On this machine", location: "local", status: "ready", voiceCount: Object.keys(SherpaTts.presets).length, inUse: true, settingsPath: "voices/providers" })
    expect(byId.cartesia).toMatchObject({ status: "needs_key", reason: "missing", keyField: "CARTESIA_API_KEY", inUse: false })
    expect(byId.elevenlabs).toMatchObject({ status: "ready", voiceCount: 2, keyField: "ELEVENLABS_API_KEY" })
    expect(JSON.stringify(data)).not.toContain(EL_KEY)
  })

  it("every provider's voices in one answer; local install state; hosted lists cached until refreshed", async () => {
    const { api, hosted } = await start()
    const first = await api("GET", "voices")
    expect(first.status).toBe(200)
    expect(first.data.selected).toBe("sherpa:en_US-lessac-medium")
    const [local, cartesia, elevenlabs] = ["sherpa", "cartesia", "elevenlabs"].map((id) => first.data.providers.find((p: any) => p.provider.id === id))
    expect(local.voices.find((v: any) => v.key === "sherpa:en_US-lessac-medium")).toMatchObject({
      name: "Lessac",
      language: "en-US",
      gender: "female",
      local: { state: "installed", sizeMb: 68, diskMb: 83 },
      previewable: true,
      selected: true,
      favourite: false
    })
    expect(local.voices.find((v: any) => v.key === "sherpa:kokoro-af_heart")).toMatchObject({ local: { state: "not_installed" }, previewable: false })
    expect(cartesia).toMatchObject({ provider: { status: "needs_key" }, voices: [] })
    expect(elevenlabs.voices.map((v: any) => v.key)).toEqual(["elevenlabs:EXAVITQu4vr4xnSDxMaL", "elevenlabs:JBFqnCBsd6RMkjVDRZzb"])
    expect(elevenlabs).toMatchObject({ stale: false, truncated: false })
    expect(typeof elevenlabs.fetchedAt).toBe("number")
    await api("GET", "voices")
    await api("GET", "voice-providers")
    expect(hosted.calls.list).toBe(1)
    await api("GET", "voices?refresh=1")
    expect(hosted.calls.list).toBe(2)
    const one = await api("GET", "voices?provider=sherpa")
    expect(one.data.providers.map((p: any) => p.provider.id)).toEqual(["sherpa"])
    expect((await api("GET", "voices?provider=polly")).data.error.code).toBe("unknown_provider")
  })

  it("no key is needs_key (missing); a locked key vault is needs_key (vault_locked)", async () => {
    const { api, admin } = await start({ env: { ELEVENLABS_API_KEY: "" } })
    const status = async () => (await api("GET", "voice-providers")).data.providers.find((p: any) => p.id === "elevenlabs")
    expect(await status()).toMatchObject({ status: "needs_key", reason: "missing" })
    const request = async (message: Record<string, unknown>) => {
      const requestId = `r${Math.random()}`
      const from = admin.messages.length
      admin.send({ ...message, requestId } as never)
      return admin.waitFor("result", (m) => m.requestId === requestId, { from })
    }
    expect((await request({ type: "vault.setup", password: "correct horse battery" })).ok).toBe(true)
    expect((await request({ type: "vault.lock" })).ok).toBe(true)
    expect(await status()).toMatchObject({ status: "needs_key", reason: "vault_locked" })
  })
})

describe("voice API: previews", () => {
  it("a local preview is a WAV of the voice; the assistant's own voice uses the running engine; repeats come from the cache", async () => {
    const { api, engines } = await start({ installed: ["en_US-lessac-medium", "nl_NL-pim-medium"] })
    const first = await api("POST", "voices/preview", { voice: lessac, text: "Hello there. How are you?" })
    expect(first.status).toBe(200)
    expect(first.headers.get("content-type")).toBe("audio/wav")
    expect(first.headers.get("x-voice-sample-rate")).toBe("22050")
    expect(first.headers.get("x-preview-cache")).toBe("miss")
    const wav = first.data as Uint8Array
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF")
    expect(wav.length).toBeGreaterThan(44)
    // The voice the assistant speaks with: no second engine.
    expect(engines.started).toEqual([])
    const again = await api("POST", "voices/preview", { voice: lessac, text: "Hello there. How are you?" })
    expect(again.headers.get("x-preview-cache")).toBe("hit")
    // Another local voice: one kept engine, reused for the next preview of the same voice.
    expect((await api("POST", "voices/preview", { voice: pim, text: "Hallo." })).status).toBe(200)
    expect((await api("POST", "voices/preview", { voice: pim, text: "Tot ziens." })).status).toBe(200)
    expect(engines.started).toEqual(["nl_NL-pim-medium"])
    expect(engines.closed).toBe(0)
  })

  it("one preview engine speaks every Kokoro voice of its lexicon: moving between them loads no model", async () => {
    const { api, engines } = await start({ installed: ["en_US-lessac-medium", "kokoro-af_heart"], shared: true })
    const say = async (voiceId: string) => (await api("POST", "voices/preview", { voice: { provider: "sherpa", voiceId }, text: `Hello from ${voiceId}.` })).status
    expect(await say("kokoro-af_bella")).toBe(200)
    expect(await say("kokoro-af_nicole")).toBe(200)
    expect(await say("kokoro-am_michael")).toBe(200)
    expect(await say("kokoro-af_bella")).toBe(200)
    expect(engines.started).toEqual(["kokoro-af_bella"])
    expect(engines.speakers).toEqual([6, 16])
    // Another lexicon (British, Chinese) is another set-up: the engine is replaced, as for any other voice.
    expect(await say("kokoro-bf_emma")).toBe(200)
    expect(await say("kokoro-bm_george")).toBe(200)
    expect(await say("kokoro-zf_xiaoxiao")).toBe(200)
    expect(engines.started).toEqual(["kokoro-af_bella", "kokoro-bf_emma", "kokoro-zf_xiaoxiao"])
    expect(engines.speakers).toEqual([6, 16, 26])
    expect(engines.closed).toBe(2)
    // The assistant's own voice still uses its running engine.
    expect(await say("en_US-lessac-medium")).toBe(200)
    expect(engines.started).toHaveLength(3)
  })

  it("refuses what cannot be previewed, with the documented codes", async () => {
    const { api } = await start()
    expect((await api("POST", "voices/preview", { voice: kokoro, text: "Hi." })).data.error.code).toBe("not_installed")
    expect((await api("POST", "voices/preview", { voice: skylar, text: "Hi." })).data.error.code).toBe("needs_key")
    expect((await api("POST", "voices/preview", { voice: { provider: "polly", voiceId: "joanna" }, text: "Hi." })).data.error.code).toBe("unknown_provider")
    expect((await api("POST", "voices/preview", { voice: { provider: "sherpa", voiceId: "nope" }, text: "Hi." })).data.error.code).toBe("unknown_voice")
    const long = await api("POST", "voices/preview", { voice: lessac, text: "a".repeat(301) })
    expect(long.status).toBe(400)
    expect(long.data.error.fieldErrors[0].key).toBe("text")
    expect((await api("POST", "voices/preview", { voice: lessac, text: "   " })).status).toBe(400)
    expect((await api("POST", "voices/preview", { voice: { provider: "sherpa", voiceId: "../x" }, text: "Hi." })).status).toBe(400)
  })

  it("a hosted preview goes through the provider's voices service; its own errors map to the API's", async () => {
    const { api, hosted } = await start()
    const ok = await api("POST", "voices/preview", { voice: sarah, text: "Good morning." })
    expect(ok.status).toBe(200)
    expect(ok.headers.get("x-voice-sample-rate")).toBe("24000")
    expect((ok.data as Uint8Array).length).toBe(44 + 4_800)
    expect(hosted.calls.preview).toEqual(["EXAVITQu4vr4xnSDxMaL:Good morning."])
    const gone = await api("POST", "voices/preview", { voice: { provider: "elevenlabs", voiceId: "gone" }, text: "Hi." })
    expect(gone.status).toBe(404)
    expect(gone.data.error.code).toBe("unknown_voice")
  })

  it("a local preview is refused while a device is in a turn", async () => {
    const { server, api, stt } = await start({ installed: ["en_US-lessac-medium", "nl_NL-pim-medium"] })
    const voice = await ScriptedClient.connect({ url: server.url })
    clients.push(voice)
    await voice.hello()
    await voice.claim()
    stt.emit({ _tag: "SpeechStarted" })
    await voice.waitFor("state", (m) => (m as { state: string }).state === "hearing", { timeoutMs: 5_000 })
    const busy = await api("POST", "voices/preview", { voice: pim, text: "Hallo." })
    expect(busy.status).toBe(409)
    expect(busy.data.error).toMatchObject({ code: "busy", retryAfterMs: 1000 })
    // A hosted preview does not touch the local engines: it is not refused.
    expect((await api("POST", "voices/preview", { voice: sarah, text: "Hi." })).status).toBe(200)
  })
})

describe("voice API: downloads", () => {
  it("start, observe and cancel a local voice's download; an installed or hosted voice is refused", async () => {
    const { api } = await start()
    const started = await api("POST", "voices/download", { voice: kokoro })
    expect(started.status).toBe(202)
    expect(started.data.job).toMatchObject({ tool: "tts-models", target: "kokoro-af_heart", state: "running" })
    const id = started.data.job.id
    expect((await api("GET", `jobs/${id}`)).data.job.id).toBe(id)
    const listed = await api("GET", "voices?provider=sherpa")
    expect(listed.data.providers[0].voices.find((v: any) => v.key === "sherpa:kokoro-af_heart").local).toMatchObject({ state: "downloading", job: { id } })
    expect((await api("POST", "voices/download", { voice: kokoro })).data.error.code).toBe("busy")
    const cancelled = await api("POST", "voices/download/cancel", { voice: kokoro })
    expect(cancelled.status).toBe(200)
    expect(cancelled.data.cancelled).toBe(true)
    for (let i = 0; i < 50 && (await api("GET", `jobs/${id}`)).data.job.state === "running"; i++) await new Promise((r) => setTimeout(r, 20))
    expect((await api("GET", `jobs/${id}`)).data.job.state).toBe("cancelled")
    expect((await api("POST", "voices/download/cancel", { voice: kokoro })).status).toBe(404)
    expect((await api("POST", "voices/download", { voice: lessac })).data.error.code).toBe("already_installed")
    expect((await api("POST", "voices/download", { voice: sarah })).status).toBe(400)
    expect((await api("GET", "jobs/job-999")).status).toBe(404)
  })

  it("the Kokoro voices download as one job: every one of them shows it, any of them cancels it, all are installed after", async () => {
    const { api } = await start()
    const emma = { provider: "sherpa", voiceId: "kokoro-bf_emma" }
    const started = await api("POST", "voices/download", { voice: emma })
    expect(started.status).toBe(202)
    expect(started.data.job).toMatchObject({ tool: "tts-models", target: "kokoro-af_heart", label: expect.stringContaining("Kokoro v1.0"), state: "running" })
    const id = started.data.job.id
    const kokoroEntries = async () =>
      (await api("GET", "voices?provider=sherpa")).data.providers[0].voices.filter((v: any) => v.voice.voiceId.startsWith("kokoro-"))
    const during = await kokoroEntries()
    expect(during.length).toBeGreaterThan(1)
    for (const v of during) expect(v.local).toMatchObject({ state: "downloading", job: { id } })
    // Another Kokoro voice while it runs: the same archive, so it is already being downloaded.
    expect((await api("POST", "voices/download", { voice: kokoro })).data.error).toMatchObject({ code: "busy", message: expect.stringContaining("already being downloaded") })
    expect((await api("POST", "voices/download/cancel", { voice: { provider: "sherpa", voiceId: "kokoro-am_michael" } })).status).toBe(200)
    for (let i = 0; i < 50 && (await api("GET", `jobs/${id}`)).data.job.state === "running"; i++) await new Promise((r) => setTimeout(r, 20))
    expect((await api("GET", `jobs/${id}`)).data.job.state).toBe("cancelled")

    const again = await api("POST", "voices/download", { voice: emma })
    expect(again.status).toBe(202)
    for (let i = 0; i < 100 && (await api("GET", `jobs/${again.data.job.id}`)).data.job.state === "running"; i++) await new Promise((r) => setTimeout(r, 20))
    for (const v of await kokoroEntries()) expect(v.local.state).toBe("installed")
    expect((await api("POST", "voices/download", { voice: { provider: "sherpa", voiceId: "kokoro-bm_george" } })).data.error.code).toBe("already_installed")
  })

  it("a finished download makes the voice installed and previewable", async () => {
    const { api } = await start()
    const { data } = await api("POST", "voices/download", { voice: pim })
    for (let i = 0; i < 200 && (await api("GET", `jobs/${data.job.id}`)).data.job.state === "running"; i++) await new Promise((r) => setTimeout(r, 20))
    const entry = (await api("GET", "voices?provider=sherpa")).data.providers[0].voices.find((v: any) => v.key === "sherpa:nl_NL-pim-medium")
    expect(entry).toMatchObject({ local: { state: "installed" }, previewable: true })
  })
})

describe("voice API: favourites", () => {
  it("add, list, remove; stored on the server for every device", async () => {
    const { server, api } = await start()
    expect((await api("GET", "voices/favourites")).data).toEqual({ favourites: [] })
    const added = await api("PUT", `voices/favourites/${encodeURIComponent("elevenlabs:EXAVITQu4vr4xnSDxMaL")}`)
    expect(added.status).toBe(200)
    expect(added.data.favourite).toMatchObject({ voice: sarah, key: "elevenlabs:EXAVITQu4vr4xnSDxMaL", name: "Sarah" })
    await api("PUT", `voices/favourites/${encodeURIComponent("sherpa:kokoro-af_heart")}`, { name: "Heart (later)" })
    // Idempotent; a name renames it.
    await api("PUT", `voices/favourites/${encodeURIComponent("elevenlabs:EXAVITQu4vr4xnSDxMaL")}`)
    const list = (await api("GET", "voices/favourites")).data.favourites
    expect(list.map((f: any) => [f.key, f.name])).toEqual([["elevenlabs:EXAVITQu4vr4xnSDxMaL", "Sarah"], ["sherpa:kokoro-af_heart", "Heart (later)"]])
    const file = JSON.parse(readFileSync(join(server.dataDir, "voice-favourites.json"), "utf8"))
    expect(file.version).toBe(1)
    expect(file.favourites).toHaveLength(2)
    const voices = (await api("GET", "voices")).data.providers.flatMap((p: any) => p.voices)
    expect(voices.find((v: any) => v.key === "elevenlabs:EXAVITQu4vr4xnSDxMaL").favourite).toBe(true)
    expect((await api("DELETE", `voices/favourites/${encodeURIComponent("elevenlabs:EXAVITQu4vr4xnSDxMaL")}`)).data.favourites).toHaveLength(1)
    expect((await api("DELETE", `voices/favourites/${encodeURIComponent("elevenlabs:EXAVITQu4vr4xnSDxMaL")}`)).status).toBe(404)
    expect((await api("PUT", "voices/favourites/not-a-key")).status).toBe(400)
    expect((await api("PUT", `voices/favourites/${encodeURIComponent("polly:x")}`)).data.error.code).toBe("unknown_provider")
  })

  it("survive a restart", async () => {
    const { server, api } = await start()
    await api("PUT", `voices/favourites/${encodeURIComponent("sherpa:en_US-lessac-medium")}`)
    expect(existsSync(join(server.dataDir, "voice-favourites.json"))).toBe(true)
    const { makeFavourites } = await import("../src/serve/Favourites.ts")
    const again = makeFavourites({ dataDir: server.dataDir, writable: () => false, log: () => {} })
    expect(again.list().map((f) => f.key)).toEqual(["sherpa:en_US-lessac-medium"])
  })
})

describe("voice API: the assistant's voice", () => {
  it("read, save (checked first), and the reload it needs", async () => {
    const { server, api } = await start()
    const before = await api("GET", "voices/default")
    expect(before.data.default).toMatchObject({ key: "sherpa:en_US-lessac-medium", source: "default", locked: false, running: "sherpa:en_US-lessac-medium", reloadPending: false })
    expect((await api("PUT", "voices/default", { voice: kokoro })).data.error.code).toBe("not_installed")
    expect((await api("PUT", "voices/default", { voice: skylar })).data.error.code).toBe("needs_key")
    expect((await api("PUT", "voices/default", { voice: { provider: "elevenlabs", voiceId: "nosuchvoice" } })).data.error.code).toBe("unknown_voice")
    const saved = await api("PUT", "voices/default", { voice: sarah })
    expect(saved.status).toBe(200)
    expect(saved.data.default).toMatchObject({ key: "elevenlabs:EXAVITQu4vr4xnSDxMaL", name: "Sarah", source: "saved", reloadPending: true })
    expect(saved.data.reload).toBeUndefined()
    expect(server.handle.engine.status().reloadPendingFor).toEqual(["voices/overview"])
    const settings = JSON.parse(readFileSync(join(server.dataDir, "settings.json"), "utf8"))
    expect(settings.assistant.ASSISTANT_VOICE).toBe("elevenlabs:EXAVITQu4vr4xnSDxMaL")
    const reloaded = await api("PUT", "voices/default", { voice: lessac, reload: true })
    expect(reloaded.data.reload).toEqual({ ok: true })
    expect((await api("GET", "voices")).data.selected).toBe("sherpa:en_US-lessac-medium")
  })

  it("set in the environment: locked", async () => {
    const { api } = await start({ env: { ASSISTANT_VOICE: "sherpa:en_US-lessac-medium" } })
    expect((await api("GET", "voices/default")).data.default).toMatchObject({ source: "environment", locked: true })
    expect((await api("PUT", "voices/default", { voice: sarah })).data.error.code).toBe("locked")
  })

  it("an old install's settings are migrated, with notes", async () => {
    const { api } = await start({ env: { DEFAULT_VOICE: "natural", VOICES: "standard,natural,expressive" } })
    const { data } = await api("GET", "voices/default")
    expect(data.default).toMatchObject({ key: "sherpa:kokoro-af_heart", source: "migrated" })
    expect(data.default.notes.join(" ")).toContain("VOICES is no longer used")
  })
})
