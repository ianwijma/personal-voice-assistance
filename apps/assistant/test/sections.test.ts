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
  it("the Home section: defaults, the section as a page, and a time zone the machine does not know is refused (WP-12a)", async () => {
    const store = await Effect.runPromise(openStore(mkdtempSync(join(tmpdir(), "pva-sections-"))))
    const sections = makeSections(store, {})
    expect(sections.value("HOME_LANGUAGE")).toBe("en-GB")
    expect(sections.value("HOME_UNITS")).toBe("metric")
    expect(sections.value("HOME_DATE_FORMAT")).toBe("en-GB")
    expect(sections.value("HOME_CURRENCY")).toBe("EUR")
    expect(sections.value("HOME_CUP_SIZE")).toBe("metric")
    expect(sections.value("HOME_API_CONTACT") ?? "").toBe("")
    // Off until its effect on the first token is measured (docs/STORING-DATA.md "Ambient facts").
    expect(sections.value("HOME_AMBIENT_FACTS")).toBe("off")
    const home = sections.list().find((s) => s.id === "home")
    expect(home?.group).toBe("modules")
    expect(home?.form.fields.map((f) => f.key)).toEqual(["HOME_LOCATION", "HOME_TIME_ZONE", "HOME_LANGUAGE", "HOME_UNITS", "HOME_DATE_FORMAT", "HOME_CURRENCY", "HOME_CUP_SIZE", "HOME_API_CONTACT", "HOME_AMBIENT_FACTS"])

    const badCurrency = await Effect.runPromise(sections.update("home", { values: { HOME_CURRENCY: "euro" }, secrets: {} }))
    expect(badCurrency.result.ok).toBe(false)
    expect(sections.value("HOME_CURRENCY")).toBe("EUR")

    const bad = await Effect.runPromise(sections.update("home", { values: { HOME_TIME_ZONE: "Mars/Olympus" }, secrets: {} }))
    expect(bad.result.ok).toBe(false)
    expect(sections.value("HOME_TIME_ZONE") ?? "").toBe("")
    // A fixed offset is not a zone name: it cannot be a recurrence's TZID (modules P2, review round 2, finding 24).
    for (const offset of ["+01:00", "+0100", "-05:00", " +01 "]) {
      const refused = await Effect.runPromise(sections.update("home", { values: { HOME_TIME_ZONE: offset }, secrets: {} }))
      expect(refused.result.ok, offset).toBe(false)
    }
    expect(sections.value("HOME_TIME_ZONE") ?? "").toBe("")
    // Any three capital letters are a currency code; the description says so (finding 25).
    expect((await Effect.runPromise(sections.update("home", { values: { HOME_CURRENCY: "ZZZ" }, secrets: {} }))).result.ok).toBe(true)
    expect(sections.value("HOME_CURRENCY")).toBe("ZZZ")
    for (const code of ["eur", "EU", "EURO", "E1R"]) expect((await Effect.runPromise(sections.update("home", { values: { HOME_CURRENCY: code }, secrets: {} }))).result.ok, code).toBe(false)
    expect(home?.form.fields.find((f) => f.key === "HOME_CURRENCY")?.description).toContain("any three capital letters")

    for (const zone of ["Europe/Amsterdam", " Asia/Tokyo ", ""]) {
      const saved = await Effect.runPromise(sections.update("home", { values: { HOME_TIME_ZONE: zone }, secrets: {} }))
      expect(saved.result.ok).toBe(true)
    }
    expect(sections.value("HOME_TIME_ZONE")).toBe("")

    const units = await Effect.runPromise(sections.update("home", { values: { HOME_UNITS: "furlongs" }, secrets: {} }))
    expect(units.result.ok).toBe(false)
    expect(sections.value("HOME_UNITS")).toBe("metric")
  })
  it("the Home section's currency, cup size and API contact: saved, kept across a restart, defaults for older settings, header-safe contact (modules P2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-sections-"))
    // Settings saved before the three fields existed: they read their defaults.
    const older = makeSections(await Effect.runPromise(openStore(dir)), {})
    expect((await Effect.runPromise(older.update("home", { values: { HOME_LOCATION: "Utrecht, Netherlands" }, secrets: {} }))).result.ok).toBe(true)
    const reopened = makeSections(await Effect.runPromise(openStore(dir)), {})
    expect(reopened.value("HOME_LOCATION")).toBe("Utrecht, Netherlands")
    expect(reopened.value("HOME_CURRENCY")).toBe("EUR")
    expect(reopened.value("HOME_CUP_SIZE")).toBe("metric")
    expect(reopened.value("HOME_API_CONTACT") ?? "").toBe("")
    // Valid values are saved and survive a restart.
    const saved = await Effect.runPromise(reopened.update("home", { values: { HOME_CURRENCY: "GBP", HOME_CUP_SIZE: "us", HOME_API_CONTACT: "me@example.com" }, secrets: {} }))
    expect(saved.result.ok).toBe(true)
    const again = makeSections(await Effect.runPromise(openStore(dir)), {})
    expect(again.value("HOME_CURRENCY")).toBe("GBP")
    expect(again.value("HOME_CUP_SIZE")).toBe("us")
    expect(again.value("HOME_API_CONTACT")).toBe("me@example.com")
    // A contact a header cannot hold is refused with a message, and the saved one stays.
    for (const contact of ["https://example.com/联系", "me@exämple.com", "a\r\nX-Evil: 1"]) {
      const refused = await Effect.runPromise(again.update("home", { values: { HOME_API_CONTACT: contact }, secrets: {} }))
      expect(refused.result.ok, contact).toBe(false)
      expect(JSON.stringify(refused.result)).toContain("ASCII")
    }
    expect(again.value("HOME_API_CONTACT")).toBe("me@example.com")
    const cup = await Effect.runPromise(again.update("home", { values: { HOME_CUP_SIZE: "teacup" }, secrets: {} }))
    expect(cup.result.ok).toBe(false)
  })
})
