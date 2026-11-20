// P8: the household's risk policy as a settings section (sectionDefinitions.ts `riskSection`, sections.ts): read through
// the one decoder at every call (a save applies to the next), bounded and validated on save (an invalid save writes
// nothing), and money and security fixed at Refuse through the admin API and in a hand-edited settings file.
import { decodeRiskPolicy, DEFAULT_RISK_POLICY, FIXED_REASON } from "@pva/protocol"
import { Config, ConfigProvider, Effect } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeSections } from "../src/serve/sections.ts"
import { openStore } from "./support/store.ts"

const policyOf = (sections: ReturnType<typeof makeSections>) => decodeRiskPolicy((key) => sections.value(key))
const riskSection = (sections: ReturnType<typeof makeSections>) => sections.list().find((s) => s.id === "risk")!

describe("the risk policy section", () => {
  it("never saved: the default; the section is admin only, on Shared settings › Risk policy, with money and security locked", async () => {
    const sections = makeSections(await Effect.runPromise(openStore(mkdtempSync(join(tmpdir(), "pva-risk-")))), {})
    expect(policyOf(sections)).toEqual(DEFAULT_RISK_POLICY)
    const section = riskSection(sections)
    expect([section.group, section.page?.id, section.protected]).toEqual(["modules", "risk", true])
    expect(section.form.fields.map((f) => [f.key, f.locked?.reason])).toEqual([
      ["RISK_READ", undefined],
      ["RISK_CHANGE", undefined],
      ["RISK_MESSAGE", undefined],
      ["RISK_MONEY", FIXED_REASON],
      ["RISK_SECURITY", FIXED_REASON]
    ])
    expect(section.form.values).toEqual({ RISK_READ: "allow", RISK_CHANGE: "allow", RISK_MESSAGE: "confirm", RISK_MONEY: "deny", RISK_SECURITY: "deny" })
    expect(section.form.errors).toEqual([])
  })

  it("a save applies to the next read, without a restart, and survives one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-risk-"))
    const sections = makeSections(await Effect.runPromise(openStore(dir)), {})
    const saved = await Effect.runPromise(sections.update("risk", { values: { RISK_MESSAGE: "allow", RISK_CHANGE: "confirm" }, secrets: {} }))
    expect(saved.result.ok).toBe(true)
    expect(saved.reload).toBe(false)
    expect(policyOf(sections)).toEqual({ ...DEFAULT_RISK_POLICY, message: "allow", change: "confirm" })
    const reopened = makeSections(await Effect.runPromise(openStore(dir)), {})
    expect(policyOf(reopened)).toEqual({ ...DEFAULT_RISK_POLICY, message: "allow", change: "confirm" })
    // Back to the default (null).
    expect((await Effect.runPromise(reopened.update("risk", { values: { RISK_MESSAGE: null, RISK_CHANGE: null }, secrets: {} }))).result.ok).toBe(true)
    expect(policyOf(reopened)).toEqual(DEFAULT_RISK_POLICY)
  })

  it("an invalid save writes nothing: an unknown outcome, money or security made anything but Refuse (the admin API)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-risk-"))
    const store = await Effect.runPromise(openStore(dir))
    const sections = makeSections(store, {})
    await Effect.runPromise(sections.update("risk", { values: { RISK_READ: "confirm" }, secrets: {} }))
    const before = readFileSync(join(dir, "settings.json"), "utf8")
    for (const values of [{ RISK_READ: "sometimes" }, { RISK_MONEY: "allow" }, { RISK_SECURITY: "confirm" }, { RISK_CHANGE: "deny", RISK_MONEY: "allow" }]) {
      const refused = await Effect.runPromise(sections.update("risk", { values, secrets: {} }))
      expect(refused.result.ok, JSON.stringify(values)).toBe(false)
      if ("RISK_MONEY" in values || "RISK_SECURITY" in values) expect(JSON.stringify(refused.result)).toContain("Fixed at Refuse")
    }
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(before)
    expect(policyOf(sections)).toEqual({ ...DEFAULT_RISK_POLICY, read: "confirm" })
    // Refuse for money is accepted and changes nothing (it is never written).
    expect((await Effect.runPromise(sections.update("risk", { values: { RISK_MONEY: "deny" }, secrets: {} }))).result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).assistant.RISK_MONEY).toBeUndefined()
  })

  it("a hand-edited settings file that says money or security may run is read as Refuse, and the page shows the rows fixed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-risk-"))
    const sections = makeSections(await Effect.runPromise(openStore(dir)), {})
    await Effect.runPromise(sections.update("risk", { values: { RISK_MESSAGE: "deny" }, secrets: {} }))
    const file = join(dir, "settings.json")
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    parsed.assistant.RISK_MONEY = "allow"
    parsed.assistant.RISK_SECURITY = "confirm"
    parsed.assistant.RISK_CHANGE = "whenever"
    writeFileSync(file, JSON.stringify(parsed))
    const reopened = makeSections(await Effect.runPromise(openStore(dir)), {})
    expect(policyOf(reopened)).toEqual({ ...DEFAULT_RISK_POLICY, message: "deny" })
    expect(reopened.value("RISK_MONEY")).toBe("deny")
    expect(reopened.value("RISK_SECURITY")).toBe("deny")
    const section = riskSection(reopened)
    expect(section.form.values.RISK_MONEY).toBe("deny")
    expect(section.form.fields.find((f) => f.key === "RISK_MONEY")?.locked?.reason).toBe(FIXED_REASON)
    // The typo in a settable class is reported on its field; the decoder reads its default meanwhile.
    expect(section.form.errors.map((e) => e.key)).toEqual(["RISK_CHANGE"])
    // The next save of the section takes the hand-edited fixed values out of the file.
    expect((await Effect.runPromise(reopened.update("risk", { values: { RISK_CHANGE: "allow" }, secrets: {} }))).result.ok).toBe(true)
    const after = JSON.parse(readFileSync(file, "utf8")).assistant
    expect([after.RISK_MONEY, after.RISK_SECURITY, after.RISK_CHANGE]).toEqual([undefined, undefined, "allow"])
  })

  it("the environment can set a settable class (and locks it); it cannot open money or security", async () => {
    const sections = makeSections(await Effect.runPromise(openStore(mkdtempSync(join(tmpdir(), "pva-risk-")))), { RISK_MESSAGE: "allow", RISK_MONEY: "allow" })
    expect(policyOf(sections)).toEqual({ ...DEFAULT_RISK_POLICY, message: "allow" })
    expect(riskSection(sections).form.fields.find((f) => f.key === "RISK_MESSAGE")?.locked?.reason).toMatch(/^Set by RISK_MESSAGE/)
  })
})

it("the ConfigProvider serves resolved risk values ahead of raw environment strings", async () => {
  const sections = makeSections(await Effect.runPromise(openStore(mkdtempSync(join(tmpdir(), "pva-risk-")))), {
    RISK_MONEY: "allow", RISK_SECURITY: "confirm", RISK_READ: " deny ", RISK_CHANGE: "invalid"
  })
  const read = (key: string) => Effect.runPromise(Config.String(key).pipe(Effect.provideService(ConfigProvider.ConfigProvider, sections.configProvider())))
  expect(await Promise.all(["RISK_MONEY", "RISK_SECURITY", "RISK_READ", "RISK_CHANGE", "RISK_MESSAGE"].map(read))).toEqual(["deny", "deny", "deny", "allow", "confirm"])
})
