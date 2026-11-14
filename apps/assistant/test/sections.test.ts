// Assistant settings sections (sections.ts): effective values are cheap to read (they are read for every
// microphone frame) and follow every save.
import { Effect } from "effect"
import * as fs from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, existsSync: vi.fn(actual.existsSync), statSync: vi.fn(actual.statSync) }
})

const { makeSections } = await import("../src/serve/sections.ts")
const { openStore } = await import("./support/store.ts")

const fsCalls = () => vi.mocked(fs.existsSync).mock.calls.length + vi.mocked(fs.statSync).mock.calls.length

describe("Sections: effective values", () => {
  it("reading a value (as the microphone path does per frame) touches no file after the first read", async () => {
    const store = await Effect.runPromise(openStore(mkdtempSync(join(tmpdir(), "pva-sections-"))))
    const sections = makeSections(store, {})
    expect(sections.value("RECORD_HEARD_AUDIO")).toBe(false)
    const before = fsCalls()
    const t0 = performance.now()
    for (let i = 0; i < 1_000; i++) sections.value("RECORD_HEARD_AUDIO")
    const perLookupUs = ((performance.now() - t0) * 1000) / 1_000
    expect(fsCalls() - before).toBe(0)
    expect(perLookupUs).toBeLessThan(20)
  })

  it("a saved change is seen by the next read, and a failed or refused save changes nothing", async () => {
    const store = await Effect.runPromise(openStore(mkdtempSync(join(tmpdir(), "pva-sections-"))))
    const sections = makeSections(store, { SYSTEM_PROMPT: "" })
    expect(sections.value("RECORD_HEARD_AUDIO")).toBe(false)
    expect(sections.value("STT_SHERPA_FINAL_SILENCE_MS")).toBe(600)
    await Effect.runPromise(sections.update("recordings", { values: { RECORD_HEARD_AUDIO: true }, secrets: {} }))
    await Effect.runPromise(sections.update("stt-timing", { values: { STT_SHERPA_FINAL_SILENCE_MS: 700 }, secrets: {} }))
    expect(sections.value("RECORD_HEARD_AUDIO")).toBe(true)
    expect(sections.value("STT_SHERPA_FINAL_SILENCE_MS")).toBe(700)
    const refused = await Effect.runPromise(sections.update("stt-timing", { values: { STT_SHERPA_FINAL_SILENCE_MS: 5 }, secrets: {} }))
    expect(refused.result.ok).toBe(false)
    expect(sections.value("STT_SHERPA_FINAL_SILENCE_MS")).toBe(700)
    // Switching the recogniser provider (past the "no Deepgram key" warning): values do not depend on which fields are shown.
    await Effect.runPromise(sections.update("stt-engine", { values: { STT_PROVIDER: "deepgram" }, secrets: {} }, { confirmWarnings: true }))
    expect(sections.value("STT_PROVIDER")).toBe("deepgram")
    expect(sections.value("DEEPGRAM_EOT_THRESHOLD")).toBe(0.7)
    expect(sections.value("RECORD_HEARD_AUDIO")).toBe(true)
  })

  it("the environment wins over saved values", async () => {
    const store = await Effect.runPromise(openStore(mkdtempSync(join(tmpdir(), "pva-sections-"))))
    const sections = makeSections(store, { RECORD_HEARD_AUDIO: "true" })
    expect(sections.value("RECORD_HEARD_AUDIO")).toBe(true)
  })
})
