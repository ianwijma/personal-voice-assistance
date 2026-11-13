import { assert, describe, it } from "@effect/vitest"
import { formatSayReport, parseSayArgs } from "../src/say.ts"
import { enableVoice, parseVoiceSettings, voiceCatalog, withVoicePrompt } from "../src/voices.ts"

const names = (settings: ReturnType<typeof parseVoiceSettings>) =>
  typeof settings === "string" ? settings : { enabled: settings.enabled.map((v) => v.name), defaultVoice: settings.defaultVoice }

describe("voice configuration", () => {
  it("defaults to the first declared voice only; expressive is off unless enabled", () => {
    assert.deepStrictEqual(names(parseVoiceSettings({})), { enabled: ["standard"], defaultVoice: "standard" })
    assert.deepStrictEqual(names(parseVoiceSettings({ voices: "", defaultVoice: "" })), { enabled: ["standard"], defaultVoice: "standard" })
  })

  it("VOICES enables voices (comma or space separated, any case); the default is always enabled", () => {
    assert.deepStrictEqual(names(parseVoiceSettings({ voices: "Expressive" })), {
      enabled: ["standard", "expressive"],
      defaultVoice: "standard"
    })
    assert.deepStrictEqual(names(parseVoiceSettings({ voices: "standard, expressive" })), {
      enabled: ["standard", "expressive"],
      defaultVoice: "standard"
    })
  })

  it("DEFAULT_VOICE switches the default in one setting", () => {
    assert.deepStrictEqual(names(parseVoiceSettings({ defaultVoice: "expressive" })), {
      enabled: ["expressive"],
      defaultVoice: "expressive"
    })
  })

  it("unknown names are reported with the declared voices", () => {
    assert.strictEqual(parseVoiceSettings({ voices: "opera" }), `VOICES: unknown voice "opera" (declared: standard, natural, expressive)`)
    assert.strictEqual(parseVoiceSettings({ defaultVoice: "opera" }), `DEFAULT_VOICE: unknown voice "opera" (declared: standard, natural, expressive)`)
    assert.strictEqual(parseVoiceSettings({}, []), "no voices are declared in voices.ts")
  })

  it("enableVoice adds a voice for say --voice", () => {
    const base = parseVoiceSettings({})
    assert.isTrue(typeof base !== "string")
    if (typeof base === "string") return
    assert.deepStrictEqual(names(enableVoice(base, "expressive")), { enabled: ["standard", "expressive"], defaultVoice: "standard" })
  })

  it("the voice block is added to the system prompt only with several voices", () => {
    const one = parseVoiceSettings({})
    const two = parseVoiceSettings({ voices: "expressive" })
    if (typeof one === "string" || typeof two === "string") return assert.fail("invalid settings")
    assert.strictEqual(withVoicePrompt("Be brief.", one), "Be brief.")
    const prompt = withVoicePrompt("Be brief.", two)
    assert.isTrue(prompt.startsWith("Be brief.\n\n"))
    assert.include(prompt, "[voice:expressive]")
    assert.include(prompt, voiceCatalog.find((v) => v.name === "expressive")!.description)
  })
})

describe("say", () => {
  it("parses --voice, --out and the text", () => {
    assert.deepStrictEqual(parseSayArgs(["--voice", "Expressive", "Ho", "ho", "--out", "x.wav"]), {
      voice: "expressive",
      out: "x.wav",
      text: "Ho ho"
    })
    assert.deepStrictEqual(parseSayArgs(["hello"]), { voice: undefined, out: undefined, text: "hello" })
    assert.match(parseSayArgs([]) as string, /^Usage: say/)
    assert.match(parseSayArgs(["--voice"]) as string, /--voice needs a value/)
  })

  it("reports per voice: first audio, synthesis time, audio length, real-time factor", () => {
    const report = formatSayReport([
      { voice: "standard", clauses: 1, startedAt: 0, firstAudioAt: 80, endedAt: 200, audioSeconds: 1 },
      { voice: "expressive", clauses: 2, startedAt: 10, firstAudioAt: 310, endedAt: 1010, audioSeconds: 2 },
      { voice: "standard", clauses: 1, startedAt: 1000, firstAudioAt: 1050, endedAt: 1100, audioSeconds: 0.5 }
    ])
    assert.strictEqual(report, [
      "standard: first audio 80 ms, synthesis 300 ms, audio 1.50 s, real-time factor 0.20 (2 clauses)",
      "expressive: first audio 300 ms, synthesis 1000 ms, audio 2.00 s, real-time factor 0.50 (2 clauses)"
    ].join("\n"))
  })
})
