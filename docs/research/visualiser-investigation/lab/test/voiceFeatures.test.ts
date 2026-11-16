// @vitest-environment node
import { describe, expect, it } from "vitest"
import { BAND_COUNT, WAVE_SIZE } from "../src/contract.ts"
import { copyVoiceFeatures, createVoiceFeatures } from "../src/features.ts"

describe("createVoiceFeatures", () => {
  it("is silent, with correctly sized buffers", () => {
    const f = createVoiceFeatures()
    expect(f.speaking).toBe(false)
    expect(f.level).toBe(0)
    expect(f.bands).toHaveLength(BAND_COUNT)
    expect(f.wave).toHaveLength(WAVE_SIZE)
    expect(f.mouth).toEqual({ open: 0, wide: 0, round: 0 })
  })

  it("gives independent objects each time", () => {
    const a = createVoiceFeatures()
    const b = createVoiceFeatures()
    a.bands[0] = 1
    a.mouth.open = 1
    expect(b.bands[0]).toBe(0)
    expect(b.mouth.open).toBe(0)
  })
})

describe("copyVoiceFeatures", () => {
  it("copies every field and the arrays by value, without replacing the target's buffers", () => {
    const from = createVoiceFeatures()
    let n = 1
    for (const key of Object.keys(from) as Array<keyof typeof from>) {
      const v = from[key]
      if (typeof v === "number") (from as unknown as Record<string, number>)[key] = n++ / 100
      else if (typeof v === "boolean") (from as unknown as Record<string, boolean>)[key] = true
    }
    from.mouth.open = 0.1
    from.mouth.wide = 0.2
    from.mouth.round = 0.3
    from.bands.fill(0.5)
    from.wave.fill(-0.25)
    const to = createVoiceFeatures()
    const bands = to.bands
    const wave = to.wave
    const mouth = to.mouth
    copyVoiceFeatures(to, from)
    expect(to).toEqual(from)
    expect(to.bands).toBe(bands)
    expect(to.wave).toBe(wave)
    expect(to.mouth).toBe(mouth)
    expect(to.bands).not.toBe(from.bands)
    expect(to.mouth).not.toBe(from.mouth)
    from.bands[0] = 0.99
    from.mouth.open = 0.99
    expect(to.bands[0]).toBe(0.5)
    expect(to.mouth.open).toBe(0.1)
  })

  it("covers every key of VoiceFeatures (a new field must be copied too)", () => {
    const from = createVoiceFeatures()
    for (const key of Object.keys(from) as Array<keyof typeof from>) {
      const v = from[key]
      if (typeof v === "number") (from as unknown as Record<string, number>)[key] = 0.77
      else if (typeof v === "boolean") (from as unknown as Record<string, boolean>)[key] = true
    }
    const to = createVoiceFeatures()
    copyVoiceFeatures(to, from)
    for (const key of Object.keys(from) as Array<keyof typeof from>) expect(to[key], key).toEqual(from[key])
  })
})
