// `downloadPreset` and the download script for voices, with a fake fetch (no network).
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { main } from "../scripts/download-models.ts"
import { deletePreset, isInstalled } from "../src/download.ts"
import { presets } from "../src/Presets.ts"

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

const fixture = (name: string): Buffer => {
  const preset = presets[name]!
  const src = tmp("pva-tts-src-")
  for (const f of Object.values(preset.files)) {
    mkdirSync(join(src, preset.dir, f, ".."), { recursive: true })
    writeFileSync(join(src, preset.dir, f), "x")
  }
  const out = join(tmp("pva-tts-out-"), "a.tar.bz2")
  execFileSync("tar", ["-cjf", out, "-C", src, preset.dir])
  return readFileSync(out)
}

describe("tts-sherpa downloads", () => {
  it("the script downloads from the preset table into TTS_SHERPA_MODEL_DIR (passed in, not read from process.env)", async () => {
    const modelDir = tmp("pva-tts-models-")
    const body = fixture("nl_NL-pim-medium")
    const urls: Array<string> = []
    const fetch: typeof globalThis.fetch = async (input) => {
      urls.push(String(input))
      return new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } })
    }
    const log: Array<string> = []
    const code = await main(["nl_NL-pim-medium"], { fetch, freeBytes: async () => 1e11, env: { TTS_SHERPA_MODEL_DIR: modelDir }, log: (l) => log.push(l) })
    expect(code).toBe(0)
    expect(urls).toEqual([presets["nl_NL-pim-medium"]!.url])
    expect(isInstalled("nl_NL-pim-medium", modelDir)).toBe(true)
    expect(log.at(-1)).toContain("ready in")
    expect((await deletePreset("nl_NL-pim-medium", modelDir)).removed).toEqual([presets["nl_NL-pim-medium"]!.dir])
    expect(isInstalled("nl_NL-pim-medium", modelDir)).toBe(false)
    const bad: Array<string> = []
    expect(await main(["../x"], { log: (l) => bad.push(l) })).toBe(1)
    expect(bad[0]).toContain('Unknown preset "../x"')
  })
})
