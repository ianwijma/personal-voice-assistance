// The shared model downloader (docs/SETTINGS-UI.md §5.4) against a local HTTP server serving a tiny .tar.bz2
// built by the test (no network). The free disk space is faked.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type ArchiveSpec, cleanPartials, DownloadError, type DownloadProgress, downloadArchives } from "../src/download.ts"

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

/** `<name>.tar.bz2` holding `<name>/model.onnx` (random, so bzip2 cannot shrink it to nothing) and `<name>/tokens.txt`. */
const makeArchive = (name: string, files: ReadonlyArray<string> = ["model.onnx", "tokens.txt"], bytes = 200_000): Buffer => {
  const src = tmp("pva-fixture-src-")
  mkdirSync(join(src, name))
  for (const f of files) writeFileSync(join(src, name, f), f.endsWith(".onnx") ? Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256))) : "a\nb\n")
  const out = join(tmp("pva-fixture-out-"), `${name}.tar.bz2`)
  execFileSync("tar", ["-cjf", out, "-C", src, name])
  return readFileSync(out)
}

let server: Http.Server
let base = ""
const routes = new Map<string, (req: Http.IncomingMessage, res: Http.ServerResponse) => void>()

beforeAll(async () => {
  server = Http.createServer((req, res) => {
    const route = routes.get(req.url ?? "")
    if (route === undefined) {
      res.writeHead(404)
      res.end("not found")
      return
    }
    route(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

/** Serve `body` in chunks with a pause between them (so cancel and progress can be seen). */
const serve = (path: string, body: Buffer, options: { chunk?: number; pauseMs?: number; stopAfter?: number } = {}) => {
  routes.set(path, (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) })
    const chunk = options.chunk ?? 16_384
    let offset = 0
    const next = () => {
      if (res.destroyed) return
      if (options.stopAfter !== undefined && offset >= options.stopAfter) return // hang: a stall
      if (offset >= body.length) {
        res.end()
        return
      }
      res.write(body.subarray(offset, offset + chunk))
      offset += chunk
      setTimeout(next, options.pauseMs ?? 0)
    }
    next()
  })
}

const spec = (name: string, path: string, extra: Partial<ArchiveSpec> = {}): ArchiveSpec => ({
  name,
  url: `${base}${path}`,
  kind: "tar.bz2",
  expect: [`${name}/model.onnx`, `${name}/tokens.txt`],
  sizeMb: 0.2,
  diskMb: 0.2,
  ...extra
})

const plenty = async () => 100e9

/** Nothing but the models themselves is left: no `.part`, no archive, no unpack folder. */
const leftovers = (modelDir: string) => [
  ...readdirSync(modelDir).filter((n) => n.startsWith(".unpack-")),
  ...(existsSync(join(modelDir, ".downloads")) ? readdirSync(join(modelDir, ".downloads")) : [])
]

describe("downloadArchives", () => {
  it("downloads with progress, unpacks under nice, checks the files, and leaves nothing behind", async () => {
    const archive = makeArchive("voice-a")
    serve("/a.tar.bz2", archive, { chunk: 8192 })
    const modelDir = tmp("pva-models-")
    const progress: Array<DownloadProgress> = []
    const log: Array<string> = []
    await downloadArchives([spec("voice-a", "/a.tar.bz2")], { modelDir, freeBytes: plenty, onProgress: (p) => progress.push(p), onLog: (l) => log.push(l) })
    expect(existsSync(join(modelDir, "voice-a", "model.onnx"))).toBe(true)
    expect(leftovers(modelDir)).toEqual([])
    expect(progress[0]?.phase).toBe("check")
    const downloads = progress.filter((p) => p.phase === "download")
    expect(downloads.at(-1)).toMatchObject({ done: archive.length, total: archive.length })
    expect(progress.some((p) => p.phase === "unpack" && p.done === archive.length)).toBe(true)
    expect(log.some((l) => l.startsWith("Downloading"))).toBe(true)
    // A second run finds it there and fetches nothing.
    routes.delete("/a.tar.bz2")
    await downloadArchives([spec("voice-a", "/a.tar.bz2")], { modelDir, freeBytes: plenty })
  })

  it("a plain file (the VAD model) is saved as is", async () => {
    serve("/vad.onnx", Buffer.from("vad-bytes"))
    const modelDir = tmp("pva-models-")
    await downloadArchives([{ name: "silero_vad.onnx", url: `${base}/vad.onnx`, kind: "file", expect: ["silero_vad.onnx"], sizeMb: 0, diskMb: 0 }], {
      modelDir,
      freeBytes: plenty
    })
    expect(readFileSync(join(modelDir, "silero_vad.onnx"), "utf8")).toBe("vad-bytes")
    expect(leftovers(modelDir)).toEqual([])
  })

  it("refuses when the disk is too full, before fetching anything", async () => {
    let fetched = 0
    routes.set("/never.tar.bz2", (_req, res) => {
      fetched++
      res.end()
    })
    const modelDir = tmp("pva-models-")
    const error = await downloadArchives([spec("big", "/never.tar.bz2", { sizeMb: 500, diskMb: 700 })], {
      modelDir,
      freeBytes: async () => 900e6
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DownloadError)
    expect((error as DownloadError).reason).toBe("disk")
    expect((error as DownloadError).message).toBe(`Needs about 1.3 GB free in ${modelDir}; 900 MB free`)
    expect(fetched).toBe(0)
  })

  it("cancel aborts and removes the .part file and the unpack folder", async () => {
    const archive = makeArchive("voice-b", undefined, 400_000)
    serve("/b.tar.bz2", archive, { chunk: 4096, pauseMs: 5 })
    const modelDir = tmp("pva-models-")
    const controller = new AbortController()
    let sawPart = false
    const run = downloadArchives([spec("voice-b", "/b.tar.bz2")], {
      modelDir,
      freeBytes: plenty,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === "download" && p.done > 20_000 && !controller.signal.aborted) {
          sawPart = readdirSync(join(modelDir, ".downloads")).some((n) => n.endsWith(".part"))
          controller.abort()
        }
      }
    })
    const error = await run.catch((e: unknown) => e)
    expect((error as DownloadError).reason).toBe("cancelled")
    expect(sawPart).toBe(true)
    expect(leftovers(modelDir)).toEqual([])
    expect(existsSync(join(modelDir, "voice-b"))).toBe(false)
  })

  it("cancel during unpacking kills tar and removes the half-unpacked folder", async () => {
    const archive = makeArchive("voice-c", undefined, 3_000_000)
    serve("/c.tar.bz2", archive, { chunk: 1 << 20 })
    const modelDir = tmp("pva-models-")
    const controller = new AbortController()
    const error = await downloadArchives([spec("voice-c", "/c.tar.bz2")], {
      modelDir,
      freeBytes: plenty,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === "unpack") controller.abort()
      }
    }).catch((e: unknown) => e)
    expect((error as DownloadError).reason).toBe("cancelled")
    expect(leftovers(modelDir)).toEqual([])
    expect(existsSync(join(modelDir, "voice-c"))).toBe(false)
  })

  it("an archive missing an expected file fails and is removed", async () => {
    serve("/d.tar.bz2", makeArchive("voice-d", ["model.onnx"]))
    const modelDir = tmp("pva-models-")
    const error = await downloadArchives([spec("voice-d", "/d.tar.bz2")], { modelDir, freeBytes: plenty }).catch((e: unknown) => e)
    expect((error as DownloadError).reason).toBe("incomplete")
    expect((error as DownloadError).message).toBe("The archive voice-d does not contain voice-d/tokens.txt")
    expect(leftovers(modelDir)).toEqual([])
    expect(existsSync(join(modelDir, "voice-d"))).toBe(false)
  })

  it("HTTP 404 says the file moved upstream", async () => {
    const modelDir = tmp("pva-models-")
    const error = await downloadArchives([spec("gone", "/gone.tar.bz2")], { modelDir, freeBytes: plenty }).catch((e: unknown) => e)
    expect((error as DownloadError).reason).toBe("http")
    expect((error as DownloadError).message).toContain("answered HTTP 404 (the file has moved upstream)")
    expect(leftovers(modelDir)).toEqual([])
  })

  it("a stall (no bytes for stallMs) fails and cleans up", async () => {
    serve("/stall.tar.bz2", makeArchive("voice-e"), { chunk: 4096, stopAfter: 8192 })
    const modelDir = tmp("pva-models-")
    const started = Date.now()
    const error = await downloadArchives([spec("voice-e", "/stall.tar.bz2")], { modelDir, freeBytes: plenty, stallMs: 300 }).catch((e: unknown) => e)
    expect((error as DownloadError).reason).toBe("stalled")
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(leftovers(modelDir)).toEqual([])
  })

  it("cleanPartials removes what an interrupted run left", async () => {
    const modelDir = tmp("pva-models-")
    mkdirSync(join(modelDir, ".downloads"))
    writeFileSync(join(modelDir, ".downloads", "x.tar.bz2.part"), "half")
    mkdirSync(join(modelDir, ".unpack-123"))
    mkdirSync(join(modelDir, "kept"))
    expect((await cleanPartials(modelDir)).length).toBe(2)
    expect(leftovers(modelDir)).toEqual([])
    expect(existsSync(join(modelDir, "kept"))).toBe(true)
  })
})
