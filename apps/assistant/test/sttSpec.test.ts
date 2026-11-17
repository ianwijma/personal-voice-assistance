// The pure part of the resource pool's recognisers (docs/ASSISTANTS.md §3.2, WP-11): how a hearer's `hearing` becomes
// a key plus stream options (`sttSpecOf`), what the key and the status show (`sttKeyOf`, `sttLabelOf`, `sttRamMbOf`,
// `sttLoadMsOf`), and the options handed to stt-sherpa (`sherpaOptionsOf`). The pool and the builders are in
// resourcesRecognisers.test.ts.
import type { AssistantHearing } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_DEEPGRAM_MODEL,
  sherpaOptionsOf,
  sttKeyOf,
  sttLabelOf,
  sttLoadMsOf,
  sttRamMbOf,
  sttSpecOf
} from "../src/serve/Resources.ts"

const hearing = (model: string, extra: Partial<AssistantHearing> = {}): AssistantHearing => ({
  engine: "sherpa",
  model,
  language: "auto",
  eagerSilenceMs: 250,
  finalSilenceMs: 600,
  minSpeechMs: 100,
  agc: true,
  agcMaxGainDb: 30,
  vadThreshold: 0.5,
  deepgram: { eotThreshold: 0.7, eagerEotThreshold: 0.5, eotTimeoutMs: 5000 },
  ...extra
})

describe("sttSpecOf: a hearing as the pool keys it", () => {
  it("carries every per-stream setting into `stream`, the Deepgram confidences included", () => {
    const spec = sttSpecOf(hearing("parakeet-v2", {
      eagerSilenceMs: 111,
      finalSilenceMs: 222,
      minSpeechMs: 33,
      vadThreshold: 0.65,
      agc: false,
      agcMaxGainDb: 12,
      deepgram: { eotThreshold: 0.9, eagerEotThreshold: 0.4, eotTimeoutMs: 1234 }
    }))
    expect(spec.stream).toEqual({
      eagerSilenceMs: 111,
      finalSilenceMs: 222,
      minSpeechMs: 33,
      vadThreshold: 0.65,
      agc: false,
      agcMaxGainDb: 12,
      eotThreshold: 0.9,
      eagerEotThreshold: 0.4,
      eotTimeoutMs: 1234
    })
  })

  it("sherpa: the shared model directory and thread count join the spec; unset or empty ones stay out", () => {
    const withShared = sttSpecOf(hearing("parakeet-v2"), { modelDir: "/models", threads: 6 })
    expect(withShared).toMatchObject({ engine: "sherpa", model: "parakeet-v2", modelDir: "/models", threads: 6 })

    const bare = sttSpecOf(hearing("parakeet-v2"), { modelDir: "", threads: undefined })
    expect("modelDir" in bare).toBe(false)
    expect("threads" in bare).toBe(false)
    // Zero threads is a setting, not "unset".
    expect(sttSpecOf(hearing("parakeet-v2"), { threads: 0 }).threads).toBe(0)
  })

  it("sherpa: a preset alias resolves to the preset name; an unknown model is kept as it is, with no language", () => {
    const alias = "nemotron-3.5"
    const resolved = SherpaStt.resolvePresetName(alias)!
    expect(sttSpecOf(hearing(alias)).model).toBe(resolved)
    const unknown = sttSpecOf(hearing("no-such-model", { language: "nl" }))
    expect(unknown.model).toBe("no-such-model")
    expect(unknown.language).toBe("")
  })

  it("sherpa: the language is kept only for a model that takes one", () => {
    expect(sttSpecOf(hearing("whisper-turbo", { language: "nl" })).language).toBe("nl")
    expect(sttSpecOf(hearing("parakeet-v2", { language: "nl" })).language).toBe("")
  })

  it("deepgram: model and address fall back to the defaults when the shared settings are missing or empty", () => {
    const dg = (shared?: Parameters<typeof sttSpecOf>[1]) => sttSpecOf(hearing("whatever", { engine: "deepgram", language: "nl" }), shared)
    for (const shared of [undefined, {}, { deepgram: {} }, { deepgram: { model: "", address: "" } }]) {
      const spec = dg(shared)
      expect(spec).toMatchObject({ engine: "deepgram", model: DEFAULT_DEEPGRAM_MODEL, language: "" })
      expect(spec.address).toBe("wss://api.deepgram.com/v2/listen")
      expect("credential" in spec).toBe(false)
    }
    const custom = dg({ deepgram: { model: "flux-general-nl", address: "wss://dg.example/v2/listen", credential: "stamp" } })
    expect(custom).toMatchObject({ model: "flux-general-nl", address: "wss://dg.example/v2/listen", credential: "stamp" })
    // The hearer's own model and language mean nothing to Deepgram: it uses the shared model.
    expect(dg({ deepgram: { model: "m" } }).model).toBe("m")
  })
})

describe("sttKeyOf: what makes two recognisers one instance", () => {
  const key = (h: AssistantHearing, shared?: Parameters<typeof sttSpecOf>[1]) => sttKeyOf(sttSpecOf(h, shared))

  it("sherpa: the model directory and the thread count are part of the key; the stream options are not", () => {
    const base = key(hearing("parakeet-v2"))
    expect(key(hearing("parakeet-v2"), { modelDir: "/models" })).not.toBe(base)
    expect(key(hearing("parakeet-v2"), { threads: 2 })).not.toBe(base)
    expect(key(hearing("parakeet-v2"), { threads: 2 })).not.toBe(key(hearing("parakeet-v2"), { threads: 3 }))
    expect(key(hearing("parakeet-v2", { finalSilenceMs: 1500, vadThreshold: 0.9, agc: false, minSpeechMs: 5 }))).toBe(base)
  })

  it("sherpa: no language shows as a dash, a language as itself", () => {
    expect(key(hearing("parakeet-v2")).split("|")[2]).toBe("-")
    expect(key(hearing("whisper-turbo", { language: "nl" })).split("|")[2]).toBe("nl")
  })

  it("deepgram: the credential and the stream confidences are not part of the key; the model and address are", () => {
    const dg = (shared: Parameters<typeof sttSpecOf>[1], extra: Partial<AssistantHearing> = {}) =>
      key(hearing("x", { engine: "deepgram", ...extra }), shared)
    const base = dg({ deepgram: { credential: "one" } })
    expect(dg({ deepgram: { credential: "two" } })).toBe(base)
    expect(dg({ deepgram: { credential: "one" } }, { deepgram: { eotThreshold: 0.8, eagerEotThreshold: 0.3, eotTimeoutMs: 100 } })).toBe(base)
    expect(dg({ deepgram: { model: "flux-general-nl" } })).not.toBe(base)
    expect(dg({ deepgram: { address: "wss://dg.example/v2/listen" } })).not.toBe(base)
  })

  it("the engines never collide, even with the same model name", () => {
    expect(key(hearing("parakeet-v2", { engine: "deepgram" }), { deepgram: { model: "parakeet-v2" } })).not.toBe(key(hearing("parakeet-v2")))
  })
})

describe("what the status shows of a recogniser", () => {
  it("a local model: the preset's label (with the language when it has one), its measured memory and load time", () => {
    const parakeet = sttSpecOf(hearing("parakeet-v2"))
    expect(sttLabelOf(parakeet)).toBe(`Speech model ${SherpaStt.presets["parakeet-v2"].label}`)
    expect(sttRamMbOf(parakeet)).toBe(SherpaStt.presets["parakeet-v2"].ramMb)
    expect(sttLoadMsOf(parakeet)).toBe(SherpaStt.presets["parakeet-v2"].loadMs)
    expect(sttRamMbOf(parakeet)).toBeGreaterThan(0)

    const whisper = sttSpecOf(hearing("whisper-turbo", { language: "nl" }))
    expect(sttLabelOf(whisper)).toBe(`Speech model ${SherpaStt.presets["whisper-turbo"].label} (nl)`)
  })

  it("an unknown model is labelled by its name, with no measured memory or load time", () => {
    const spec = sttSpecOf(hearing("no-such-model"))
    expect(sttLabelOf(spec)).toBe("Speech model no-such-model")
    expect(sttRamMbOf(spec)).toBeUndefined()
    expect(sttLoadMsOf(spec)).toBeUndefined()
  })

  it("Deepgram: a hosted label naming the model, and no memory or load time", () => {
    const spec = sttSpecOf(hearing("x", { engine: "deepgram" }), { deepgram: { model: "flux-general-nl" } })
    expect(sttLabelOf(spec)).toBe("Speech recognition Deepgram flux-general-nl")
    expect(sttRamMbOf(spec)).toBeUndefined()
    expect(sttLoadMsOf(spec)).toBeUndefined()
  })
})

describe("sherpaOptionsOf: what stt-sherpa is given", () => {
  it("the worker's key parts and the stream's own timing, VAD and gain", () => {
    const spec = sttSpecOf(hearing("whisper-turbo", { language: "nl" }), { modelDir: "/models", threads: 4 })
    const options = sherpaOptionsOf(spec, {
      ...spec.stream,
      eagerSilenceMs: 150,
      finalSilenceMs: 700,
      minSpeechMs: 60,
      vadThreshold: 0.8,
      agc: true,
      agcMaxGainDb: 18
    })
    expect(options).toEqual({
      model: "whisper-turbo",
      modelDir: "/models",
      threads: 4,
      language: "nl",
      eagerSilenceMs: 150,
      finalSilenceMs: 700,
      minSpeechMs: 60,
      vadThreshold: 0.8,
      agc: { maxGainDb: 18 }
    })
  })

  it("gain control off is `agc: false` whatever the gain ceiling says; no language, directory or threads are left out", () => {
    const spec = sttSpecOf(hearing("parakeet-v2", { agc: false, agcMaxGainDb: 24 }))
    const options = sherpaOptionsOf(spec, spec.stream)
    expect(options.agc).toBe(false)
    expect("language" in options).toBe(false)
    expect("modelDir" in options).toBe(false)
    expect("threads" in options).toBe(false)
  })
})
