// P7 through serve mode: model downloads as admin-only jobs with progress and cancel, only for names from the
// preset tables; delete refuses a model in use. The downloads themselves are faked (no network); the real
// downloader is tested in packages/core/test/download.test.ts.
import type { ClientMessage, JobInfo, ToolId } from "@pva/protocol"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeJobs } from "../src/serve/jobs.ts"
import { type PresetDownloader, presetItems, presetsInUse } from "../src/serve/models.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, type TestServer, TEST_ADMIN_PASSWORD } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 20_000 })

const PASSWORD = "correct horse battery"

/** Presets "installed" in memory; a download reports progress every 20 ms for `steps` steps unless cancelled. */
const fakeDownloaders = (installed: Set<string>, steps = 10): Readonly<Record<ToolId, PresetDownloader>> => {
  const one = (tool: ToolId): PresetDownloader => ({
    installed: (name) => installed.has(`${tool}:${name}`),
    download: (name, { signal, onProgress, onLog }) =>
      new Promise((resolve, reject) => {
        onLog(`Downloading ${name}`)
        onProgress({ phase: "check", done: 0, archive: name })
        let step = 0
        const tick = () => {
          if (signal.aborted) return reject(new Error("Cancelled"))
          step++
          onProgress({ phase: step <= steps / 2 ? "download" : "unpack", done: step * 1000, total: steps * 1000, archive: name })
          if (step >= steps) {
            installed.add(`${tool}:${name}`)
            return resolve(undefined)
          }
          setTimeout(tick, 20)
        }
        setTimeout(tick, 20)
      }),
    remove: async (name) => {
      installed.delete(`${tool}:${name}`)
      return { removed: [name] }
    }
  })
  return { "stt-models": one("stt-models"), "tts-models": one("tts-models") }
}

let servers: Array<TestServer> = []
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) await s.close()
})

const start = async (installed: Set<string>, steps?: number) => {
  const stt = controlledStt()
  const llm = scriptedLlm((t) => `You said: ${t}.`)
  const build = fakeBuild({
    stt: stt.stt,
    llm: llm.llm,
    engines: [
      { stage: "llm", provider: "fake", detail: "scripted", location: "local" },
      { stage: "stt", provider: "sherpa", detail: "parakeet-v2", location: "local" },
      { stage: "tts", provider: "sherpa", detail: "standard: en_US-lessac-medium", location: "local" }
    ]
  })
  const server = await startTestServer({
    build,
    modelDownloaders: fakeDownloaders(installed, steps),
    freeBytes: async () => 50e9,
    env: { STT_SHERPA_MODEL_DIR: mkdtempSync(join(tmpdir(), "pva-models-")), TTS_SHERPA_MODEL_DIR: mkdtempSync(join(tmpdir(), "pva-models-")) }
  })
  servers.push(server)
  return server
}
const connect = async (server: TestServer) => {
  const c = await ScriptedClient.connect({ url: server.url })
  clients.push(c)
  // Downloads and deletes are admin only (protocol 5).
  await c.admin(TEST_ADMIN_PASSWORD)
  return c
}

let seq = 0
type WithoutId<M> = M extends unknown ? Omit<M, "requestId"> : never
const request = async (client: ScriptedClient, message: WithoutId<Extract<ClientMessage, { readonly requestId: string }>>) => {
  const requestId = `m${++seq}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from })
}

describe("serve: model downloads", () => {
  it("the snapshot lists the models with size and state; the running engines' models are in use", async () => {
    const server = await start(new Set(["stt-models:parakeet-v2", "tts-models:en_US-lessac-medium"]))
    const a = await ScriptedClient.connect({ url: server.url })
    clients.push(a)
    const { snapshot } = await a.admin(TEST_ADMIN_PASSWORD)
    const stt = snapshot.models?.find((m) => m.tool === "stt-models")
    expect(stt?.freeMb).toBe(50_000)
    expect(stt?.items.find((i) => i.id === "parakeet-v2")).toMatchObject({ installed: true, inUse: true, sizeMb: 484 })
    expect(stt?.items.find((i) => i.id === "whisper-turbo")).toMatchObject({ installed: false, inUse: false, sizeMb: 565 })
    const tts = snapshot.models?.find((m) => m.tool === "tts-models")
    expect(tts?.items.find((i) => i.id === "en_US-lessac-medium")).toMatchObject({ installed: true, inUse: true })
    expect(snapshot.jobs).toEqual([])
  })

  it("a download is a job: progress over the socket to every page, then the sections are announced again", async () => {
    const installed = new Set(["stt-models:parakeet-v2"])
    const server = await start(installed)
    const a = await connect(server)
    const watcher = await connect(server)
    const from = watcher.messages.length
    expect(await request(a, { type: "job.start", tool: "stt-models", action: "download", target: "whisper-turbo" })).toMatchObject({ ok: true })
    // A second start of the same download is refused.
    expect(await request(a, { type: "job.start", tool: "stt-models", action: "download", target: "whisper-turbo" })).toMatchObject({ ok: false, error: { code: "busy" } })
    const done = await watcher.waitFor("job", (m) => m.job.state === "succeeded", { from, timeoutMs: 5_000 })
    const jobs = watcher.messages.slice(from).flatMap((m) => (m.type === "job" ? [m.job] : [])) as Array<JobInfo>
    expect(jobs[0]).toMatchObject({ state: "running", target: "whisper-turbo", label: "Whisper turbo — robust, 99 languages, slow" })
    expect(jobs.some((j) => j.phase === "download" && j.progress !== undefined && j.progress.done < j.progress.total!)).toBe(true)
    expect(jobs.some((j) => j.phase === "unpack")).toBe(true)
    expect(done.job.log).toContain("Downloading whisper-turbo")
    const models = await watcher.waitFor("models", (m) => m.models[0]!.items.find((i) => i.id === "whisper-turbo")!.installed, { from })
    expect(models.models[0]!.tool).toBe("stt-models")
    // The sections are announced again, so the choice's `not-downloaded` tags follow the files (faked here).
    const section = await watcher.waitFor("section.changed", (m) => m.section.id === "stt-engine", { from })
    expect(section.section.id).toBe("stt-engine")
  })

  it("cancel ends the job as cancelled", async () => {
    const server = await start(new Set(), 1000)
    const a = await connect(server)
    const from = a.messages.length
    expect((await request(a, { type: "job.start", tool: "tts-models", action: "download", target: "kokoro-af_heart" })).ok).toBe(true)
    const running = await a.waitFor("job", (m) => m.job.state === "running" && m.job.progress !== undefined, { from })
    expect(await request(a, { type: "job.cancel", jobId: running.job.id })).toMatchObject({ ok: true })
    const ended = await a.waitFor("job", (m) => m.job.id === running.job.id && m.job.state !== "running", { from })
    expect(ended.job.state).toBe("cancelled")
    expect(await request(a, { type: "job.cancel", jobId: running.job.id })).toMatchObject({ ok: false })
  })

  it("only names from the preset tables are accepted, never a URL or a path", async () => {
    const server = await start(new Set())
    const a = await connect(server)
    for (const target of ["https://example.com/evil.tar.bz2", "../../etc/passwd", "parakeet-v2; rm -rf /"]) {
      expect(await request(a, { type: "job.start", tool: "stt-models", action: "download", target })).toMatchObject({
        ok: false,
        error: { code: "invalid_settings" }
      })
      expect(await request(a, { type: "model.delete", tool: "tts-models", target })).toMatchObject({ ok: false, error: { code: "invalid_settings" } })
    }
    // A preset of the other table is unknown to this one.
    expect(await request(a, { type: "job.start", tool: "tts-models", action: "download", target: "parakeet-v2" })).toMatchObject({ ok: false })
    await sleep(50)
    expect(server.handle.jobs.list()).toEqual([])
  })

  it("job.* and model.delete are refused for a page without admin access", async () => {
    const server = await start(new Set(["tts-models:nl_NL-pim-medium"]))
    const admin = await connect(server)
    expect((await request(admin, { type: "vault.setup", password: PASSWORD })).ok).toBe(true)
    // A voice page (no admin login).
    const b = await ScriptedClient.connect({ url: server.url })
    clients.push(b)
    await b.hello()
    expect(await request(b, { type: "job.start", tool: "stt-models", action: "download", target: "whisper-turbo" })).toMatchObject({ ok: false, error: { code: "admin_required" } })
    expect(await request(b, { type: "job.cancel", jobId: "job-1" })).toMatchObject({ ok: false, error: { code: "admin_required" } })
    expect(await request(b, { type: "model.delete", tool: "tts-models", target: "nl_NL-pim-medium" })).toMatchObject({ ok: false, error: { code: "admin_required" } })
    expect(server.handle.jobs.list()).toEqual([])
    expect(await request(admin, { type: "model.delete", tool: "tts-models", target: "nl_NL-pim-medium" })).toMatchObject({ ok: true })
  })

  it("deleting a model the running engines use is refused", async () => {
    const server = await start(new Set(["stt-models:parakeet-v2", "tts-models:en_US-lessac-medium"]))
    const a = await connect(server)
    expect(await request(a, { type: "model.delete", tool: "stt-models", target: "parakeet-v2" })).toMatchObject({
      ok: false,
      error: { code: "busy", message: expect.stringContaining("in use by the running engines") }
    })
    expect(await request(a, { type: "model.delete", tool: "tts-models", target: "en_US-lessac-medium" })).toMatchObject({ ok: false, error: { code: "busy" } })
  })
})

describe("voice models of a shared archive (the Kokoro voices)", () => {
  it("are one item of the Models page, under the archive's owner; a voice using it keeps it in use", () => {
    const items = presetItems("tts-models")
    const kokoro = items.filter((i) => i.id.startsWith("kokoro-"))
    expect(kokoro).toHaveLength(1)
    expect(kokoro[0]).toMatchObject({ id: "kokoro-af_heart", label: expect.stringMatching(/^Kokoro v1\.0 \(\d+ voices\)$/), sizeMb: 350 })
    expect(kokoro[0]!.description).toContain("voices in one download")
    // Every Piper voice is an item of its own.
    expect(items.find((i) => i.id === "nl_NL-ronnie-medium")).toMatchObject({ label: "Piper nl_NL-ronnie-medium", sizeMb: 68 })
    const used = presetsInUse([{ stage: "tts", provider: "sherpa", detail: "voice: kokoro-bf_emma" }])
    expect([...used.tts].sort()).toEqual(["kokoro-af_heart", "kokoro-bf_emma"])
  })

  it("a Kokoro voice other than the owner is not a Models page target", async () => {
    const server = await start(new Set())
    const a = await connect(server)
    expect(await request(a, { type: "job.start", tool: "tts-models", action: "download", target: "kokoro-bf_emma" })).toMatchObject({ ok: false, error: { code: "invalid_settings" } })
  })
})

describe("jobs model", () => {
  it("throttles progress, keeps the last finished jobs, and limits concurrent jobs", async () => {
    const updates: Array<JobInfo> = []
    const jobs = makeJobs({ onChange: (j) => updates.push(j), throttleMs: 1000, maxRunning: 1 })
    let finish: () => void = () => {}
    const started = jobs.start({
      tool: "stt-models",
      action: "download",
      target: "a",
      label: "A",
      run: (_signal, report) =>
        new Promise((resolve) => {
          for (let i = 1; i <= 100; i++) report.progress(i, 100)
          finish = () => resolve()
        })
    })
    expect(started.ok).toBe(true)
    expect(jobs.start({ tool: "tts-models", action: "download", target: "b", label: "B", run: async () => {} })).toMatchObject({ ok: false, code: "busy" })
    // The start, then one progress update; the other 99 are held by the throttle.
    expect(updates.length).toBe(2)
    finish()
    await sleep(10)
    expect(updates.at(-1)).toMatchObject({ state: "succeeded", progress: { done: 100, total: 100 } })
    expect(jobs.list().map((j) => j.state)).toEqual(["succeeded"])
  })
})
