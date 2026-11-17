// The preset table: speaker ids, shared archives, engine set-up per voice. No model files, no network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { deletePreset, isInstalled, presetArchive } from "../src/download.ts"
import { archiveOwner, archiveVoices, DEFAULT_PRESET, engineConfig, engineSetup, presetFiles, presetLabel, presets } from "../src/Presets.ts"

/**
 * `speaker2id` of `kokoro-multi-lang-v1_0/model.onnx` (the sherpa-onnx `tts-models` release, 349886476 bytes, read from
 * the model's metadata on 2026-11-16): ids 0–27, the American and British English speakers, and 45–52, Mandarin.
 */
const KOKORO_SPEAKER2ID: Readonly<Record<string, number>> = {
  af_alloy: 0, af_aoede: 1, af_bella: 2, af_heart: 3, af_jessica: 4, af_kore: 5, af_nicole: 6, af_nova: 7, af_river: 8,
  af_sarah: 9, af_sky: 10, am_adam: 11, am_echo: 12, am_eric: 13, am_fenrir: 14, am_liam: 15, am_michael: 16,
  am_onyx: 17, am_puck: 18, am_santa: 19, bf_alice: 20, bf_emma: 21, bf_isabella: 22, bf_lily: 23, bm_daniel: 24,
  bm_fable: 25, bm_george: 26, bm_lewis: 27, zf_xiaobei: 45, zf_xiaoni: 46, zf_xiaoxiao: 47, zf_xiaoyi: 48, zm_yunjian: 49,
  zm_yunxi: 50, zm_yunxia: 51, zm_yunyang: 52
}

const all = Object.values(presets)
const kokoro = all.filter((p) => p.engine === "kokoro")
const piper = all.filter((p) => p.engine === "piper")

const tmp = () => mkdtempSync(join(tmpdir(), "pva-tts-presets-"))
const fakeArchive = (name: string, dir: string) => {
  for (const file of Object.values(presetFiles(presets[name]!, dir))) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "x")
  }
}

describe("voice presets", () => {
  it("engine set-ups: one per Kokoro lexicon (American, British, Chinese), one per Piper voice", () => {
    expect(new Set(kokoro.map(engineSetup)).size).toBe(3)
    expect(engineSetup(presets["kokoro-af_heart"]!)).toBe(engineSetup(presets["kokoro-am_michael"]!))
    expect(engineSetup(presets["kokoro-zf_xiaoxiao"]!)).toBe(engineSetup(presets["kokoro-zm_yunxi"]!))
    expect(engineSetup(presets["kokoro-af_heart"]!)).not.toBe(engineSetup(presets["kokoro-bf_emma"]!))
    expect(new Set(piper.map(engineSetup)).size).toBe(piper.length)
  })

  it("keeps the keys of earlier versions (saved ASSISTANT_VOICE values and favourites)", () => {
    for (const name of ["en_US-lessac-medium", "nl_NL-pim-medium", "kokoro-af_heart"]) expect(Object.hasOwn(presets, name)).toBe(true)
    expect(DEFAULT_PRESET).toBe("en_US-lessac-medium")
    expect(presets["kokoro-af_heart"]!.speaker).toBe(3)
  })

  it("offers every English and Mandarin Kokoro speaker of the archive, each with its verified id, and no other language", () => {
    expect(Object.fromEntries(kokoro.map((p) => [p.name.slice("kokoro-".length), p.speaker]))).toEqual(KOKORO_SPEAKER2ID)
    for (const p of kokoro) {
      const id = p.name.slice("kokoro-".length)
      expect(p.voice.language).toBe(id.startsWith("b") ? "en-GB" : id.startsWith("z") ? "zh-CN" : "en-US")
      expect(p.voice.gender).toBe(id[1] === "f" ? "female" : "male")
      expect(p.files.lexicon).toBe(id.startsWith("b") ? "lexicon-gb-en.txt" : id.startsWith("z") ? "lexicon-zh.txt" : "lexicon-us-en.txt")
    }
    expect(kokoro.filter((p) => p.voice.description.includes(`other ${kokoro.length - 1} Kokoro voices`))).toHaveLength(kokoro.length - 1)
  })

  it("names voices uniquely and gives Piper voices their release URL", () => {
    expect(new Set(all.map((p) => p.voice.name)).size).toBe(all.length)
    for (const p of piper) {
      expect(p.url).toBe(`https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-${p.name}.tar.bz2`)
      expect(p.speaker).toBe(0)
      expect(p.sampleRate).toBe(/-(x_)?low$/.test(p.name) ? 16_000 : 22_050)
      expect(p.voice.language.replace("-", "_")).toBe(p.name.slice(0, 5))
    }
    expect(piper.filter((p) => p.voice.language.startsWith("nl")).length).toBeGreaterThanOrEqual(4)
    expect(piper.filter((p) => p.voice.language.startsWith("en")).length).toBeGreaterThanOrEqual(8)
  })

  it("groups the Kokoro voices under one archive, owned by Heart; a Piper voice owns its own", () => {
    for (const p of kokoro) expect(archiveOwner(p.name)).toBe("kokoro-af_heart")
    expect(archiveVoices("kokoro-bf_emma")).toEqual(kokoro.map((p) => p.name))
    expect(archiveOwner("nl_NL-pim-medium")).toBe("nl_NL-pim-medium")
    expect(archiveVoices("nl_NL-pim-medium")).toEqual(["nl_NL-pim-medium"])
    expect(archiveOwner("nope")).toBeUndefined()
    expect(archiveOwner("constructor")).toBeUndefined()
    expect(presetLabel(presets["kokoro-af_heart"]!)).toBe(`Kokoro v1.0 (${kokoro.length} voices)`)
    expect(presetLabel(presets["nl_NL-pim-medium"]!)).toBe("Piper nl_NL-pim-medium")
    // Same download for every speaker: the same archive, the same expected files.
    for (const p of kokoro) expect(presetArchive(p)).toEqual(presetArchive(presets["kokoro-af_heart"]!))
  })

  it("installing (or deleting) the Kokoro archive installs (or deletes) every Kokoro voice", async () => {
    const dir = tmp()
    try {
      fakeArchive("kokoro-af_heart", dir)
      for (const p of kokoro) expect(isInstalled(p.name, dir)).toBe(true)
      expect(isInstalled("en_US-lessac-medium", dir)).toBe(false)
      expect((await deletePreset("kokoro-bm_george", dir)).removed).toEqual(["kokoro-multi-lang-v1_0"])
      for (const p of kokoro) expect(isInstalled(p.name, dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("sets up the engine for the one voice: its speaker id and its lexicon", () => {
    const emma = engineConfig(presets["kokoro-bf_emma"]!, "/m", 8)
    expect(emma.module).toBe("sherpa-onnx-node")
    expect(emma.config.model).toMatchObject({ kokoro: { lexicon: "/m/kokoro-multi-lang-v1_0/lexicon-gb-en.txt", lang: "en-gb" } })
    const heart = engineConfig(presets["kokoro-af_heart"]!, "/m", 8)
    expect(heart.config.model).toMatchObject({ kokoro: { lexicon: "/m/kokoro-multi-lang-v1_0/lexicon-us-en.txt", lang: "en-us" } })
    expect(heart.config).not.toHaveProperty("ruleFsts")
    // Chinese: the English lexicon first (English words in a Chinese reply), then the Chinese one; the rule FSTs read
    // digits, dates and phone numbers (without them sherpa-onnx skips digits).
    const xiaoxiao = engineConfig(presets["kokoro-zf_xiaoxiao"]!, "/m", 8)
    expect(xiaoxiao.config.model).toMatchObject({
      kokoro: { lexicon: "/m/kokoro-multi-lang-v1_0/lexicon-us-en.txt,/m/kokoro-multi-lang-v1_0/lexicon-zh.txt", lang: "zh" }
    })
    expect(xiaoxiao.config).toMatchObject({
      ruleFsts: "/m/kokoro-multi-lang-v1_0/date-zh.fst,/m/kokoro-multi-lang-v1_0/phone-zh.fst,/m/kokoro-multi-lang-v1_0/number-zh.fst"
    })
    const ronnie = engineConfig(presets["nl_NL-ronnie-medium"]!, "/m", 4)
    expect(ronnie.module).toBe("sherpa-onnx-node-v1")
    expect(ronnie.config.model).toMatchObject({ vits: { model: "/m/vits-piper-nl_NL-ronnie-medium/nl_NL-ronnie-medium.onnx" } })
  })
})
