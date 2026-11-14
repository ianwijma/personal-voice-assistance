// `downloadPreset` and the download script, with a fake fetch serving tiny archives built here (no network).
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { main } from "../scripts/download-models.ts"
import { deletePreset, downloadPreset, isInstalled, presetArchives } from "../src/download.ts"
import { presets, sizeMb, VAD_URL } from "../src/presets.ts"

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

/** A `.tar.bz2` holding the files an archive spec expects (tiny). */
const fixture = (expect: ReadonlyArray<string>, omit: ReadonlyArray<string> = []): Buffer => {
  const src = tmp("pva-stt-src-")
  for (const path of expect) {
    if (omit.includes(path)) continue
    mkdirSync(join(src, path, ".."), { recursive: true })
    writeFileSync(join(src, path), "x")
  }
  const top = [...new Set(expect.map((p) => p.split("/")[0]!))]
  const out = join(tmp("pva-stt-out-"), "a.tar.bz2")
  execFileSync("tar", ["-cjf", out, "-C", src, ...top])
  return readFileSync(out)
}

const fakeFetch = (name: "parakeet-v2", options: { omit?: ReadonlyArray<string> } = {}) => {
  const urls: Array<string> = []
  const bodies = new Map<string, Buffer>([[VAD_URL, Buffer.from("vad")]])
  for (const spec of presetArchives(name)) if (spec.kind === "tar.bz2") bodies.set(spec.url, fixture(spec.expect, options.omit))
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input)
    urls.push(url)
    const body = bodies.get(url)
    return body === undefined
      ? new Response("no", { status: 404 })
      : new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } })
  }
  return { fetch, urls }
}

const plenty = async () => 100e9

describe("stt-sherpa downloads", () => {
  it("every preset has a size; the hybrid's is both of its models", () => {
    expect(sizeMb(presets["parakeet-v2"])).toBe(484)
    expect(sizeMb(presets["hybrid-nemotron-parakeet"])).toBe(960)
  })

  it("downloadPreset fetches the VAD and the preset's archive from the table; refuses unknown names", async () => {
    const modelDir = tmp("pva-stt-models-")
    const { fetch, urls } = fakeFetch("parakeet-v2")
    await downloadPreset("parakeet-v2", { modelDir, fetch, freeBytes: plenty })
    expect(isInstalled("parakeet-v2", modelDir)).toBe(true)
    expect(urls).toEqual([VAD_URL, presets["parakeet-v2"].model.archive.url])
    await expect(downloadPreset("../../etc", { modelDir, fetch })).rejects.toThrow('Unknown preset "../../etc"')
    await expect(downloadPreset("https://example.com/x.tar.bz2", { modelDir, fetch })).rejects.toThrow("Unknown preset")
    expect((await deletePreset("parakeet-v2", modelDir)).removed).toEqual([presets["parakeet-v2"].model.archive.dir])
    expect(isInstalled("parakeet-v2", modelDir)).toBe(false)
    expect(existsSync(join(modelDir, "silero_vad.onnx"))).toBe(true)
  })

  it("the script is a thin wrapper that still works (and fails clearly)", async () => {
    const modelDir = tmp("pva-stt-models-")
    const log: Array<string> = []
    const { fetch } = fakeFetch("parakeet-v2")
    expect(await main(["parakeet-v2", "--model-dir", modelDir], { fetch, freeBytes: plenty, log: (l) => log.push(l) })).toBe(0)
    expect(log.at(-1)).toBe("parakeet-v2: ready")
    expect(isInstalled("parakeet-v2", modelDir)).toBe(true)
    const list: Array<string> = []
    expect(await main(["--list", "--model-dir", modelDir], { log: (l) => list.push(l) })).toBe(0)
    expect(list.find((l) => l.startsWith("parakeet-v2"))).toMatch(/installed\s+484 MB/)
    const bad: Array<string> = []
    expect(await main(["no-such-model"], { log: (l) => bad.push(l) })).toBe(1)
    expect(bad[0]).toContain('Unknown preset "no-such-model"')
    const broken = fakeFetch("parakeet-v2", { omit: [`${presets["parakeet-v2"].model.archive.dir}/tokens.txt`] })
    const out: Array<string> = []
    expect(await main(["parakeet-v2", "--model-dir", tmp("pva-stt-models-")], { fetch: broken.fetch, freeBytes: plenty, log: (l) => out.push(l) })).toBe(1)
    expect(out.at(-1)).toContain("does not contain")
  })
})
