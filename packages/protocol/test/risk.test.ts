// P8, first version: the household's risk policy. One pure decision (`decideRisk`) tested by its complete table; the
// decoder of the saved value; the save check; the sentences in both languages.
import { describe, expect, it } from "vitest"
import {
  decideRisk,
  decodeRiskPolicy,
  DEFAULT_RISK_POLICY,
  FIXED_REASON,
  RISK_CLASSES,
  RISK_OUTCOMES,
  RISK_POLICY_KEYS,
  RISK_TEXTS,
  type RiskDecision,
  riskLanguageOf,
  riskOffered,
  type RiskOutcome,
  type RiskPolicy,
  riskPolicyKey,
  riskPolicyOf,
  riskPolicyValueProblem,
  riskReason,
  riskRefusalKey,
  riskSpoken,
  riskWithheld,
  type ToolRisk
} from "../src/index.ts"

/** Every policy the owner can save: 3 × 3 × 3. */
const ALL_POLICIES: ReadonlyArray<RiskPolicy> = RISK_OUTCOMES.flatMap((read) =>
  RISK_OUTCOMES.flatMap((change) => RISK_OUTCOMES.map((message) => ({ read, change, message, money: "deny" as const, security: "deny" as const })))
)

/** Every non-empty set of declared classes (31). */
const ALL_DECLARED: ReadonlyArray<ReadonlyArray<ToolRisk>> = Array.from({ length: 31 }, (_, i) => RISK_CLASSES.filter((_c, b) => (i + 1) & (1 << b)))

/** The table, written out independently of the function: what the policy says for a class it declared. */
const expected = (policy: RiskPolicy, risk: ToolRisk): RiskDecision => {
  if (risk === "money" || risk === "security") return { outcome: "deny", by: risk }
  const outcome = policy[risk]
  return outcome === "allow" ? { outcome, by: risk } : outcome === "confirm" ? { outcome, by: risk } : { outcome: "deny", by: risk }
}

describe("decideRisk: the complete table", () => {
  it("every saved policy × every set of declared classes × every class of the input (declared or not) × not judged", () => {
    let rows = 0
    for (const policy of ALL_POLICIES) {
      for (const declared of ALL_DECLARED) {
        for (const risk of RISK_CLASSES) {
          const got = decideRisk(policy, declared, risk)
          if (declared.includes(risk)) expect(got, `${JSON.stringify(policy)} ${declared} ${risk}`).toEqual(expected(policy, risk))
          // A class the tool did not declare (its risk function answered something else): not judged, refused.
          else expect(got).toEqual({ outcome: "deny", by: "unjudged" })
          rows++
        }
        // The risk function threw, answered nonsense or took too long.
        expect(decideRisk(policy, declared, undefined)).toEqual({ outcome: "deny", by: "unjudged" })
        rows++
      }
    }
    expect(rows).toBe(27 * 31 * 6)
  })

  it("the default policy, row by row", () => {
    const d = (risk: ToolRisk) => decideRisk(DEFAULT_RISK_POLICY, [risk], risk)
    expect(d("read")).toEqual({ outcome: "allow", by: "read" })
    expect(d("change")).toEqual({ outcome: "allow", by: "change" })
    expect(d("message")).toEqual({ outcome: "confirm", by: "message" })
    expect(d("money")).toEqual({ outcome: "deny", by: "money" })
    expect(d("security")).toEqual({ outcome: "deny", by: "security" })
  })

  it("money and security are deny whatever a policy object says (JavaScript, a hand-made object)", () => {
    const open = { read: "allow", change: "allow", message: "allow", money: "allow", security: "allow" } as unknown as RiskPolicy
    expect(decideRisk(open, ["money"], "money")).toEqual({ outcome: "deny", by: "money" })
    expect(decideRisk(open, ["security"], "security")).toEqual({ outcome: "deny", by: "security" })
    expect(decideRisk({ ...open, money: "confirm" } as unknown as RiskPolicy, ["money"], "money")).toEqual({ outcome: "deny", by: "money" })
  })

  it("a string that is no class is deny (unknown); a policy object holding nonsense for a class is deny", () => {
    expect(decideRisk(DEFAULT_RISK_POLICY, ["launch" as ToolRisk], "launch" as ToolRisk)).toEqual({ outcome: "deny", by: "unknown" })
    expect(decideRisk({ ...DEFAULT_RISK_POLICY, read: "maybe" } as unknown as RiskPolicy, ["read"], "read")).toEqual({ outcome: "deny", by: "read" })
  })
})

describe("riskOffered: a tool whose every declared class is refused is left out", () => {
  it("every saved policy × every set of declared classes: offered exactly when one declared class is allowed", () => {
    for (const policy of ALL_POLICIES) {
      for (const declared of ALL_DECLARED) {
        expect(riskOffered(policy, declared)).toBe(declared.some((c) => expected(policy, c).outcome === "allow"))
      }
    }
  })

  it("all refused, some refused, none refused", () => {
    expect(riskOffered(DEFAULT_RISK_POLICY, ["message"])).toBe(false)
    expect(riskOffered(DEFAULT_RISK_POLICY, ["money", "security"])).toBe(false)
    expect(riskOffered(DEFAULT_RISK_POLICY, ["change", "security"])).toBe(true)
    expect(riskOffered(DEFAULT_RISK_POLICY, ["change"])).toBe(true)
    expect(riskOffered({ ...DEFAULT_RISK_POLICY, change: "deny" }, ["change", "security"])).toBe(false)
  })

  it("riskPolicyKey changes exactly when what the policy offers changes", () => {
    for (const a of ALL_POLICIES) {
      for (const b of ALL_POLICIES) {
        const sameOffers = ALL_DECLARED.every((d) => riskOffered(a, d) === riskOffered(b, d))
        expect(riskPolicyKey(a) === riskPolicyKey(b), `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(sameOffers)
      }
    }
  })
})

describe("the saved value's decoder and the save check", () => {
  const from = (record: Readonly<Record<string, unknown>>) => decodeRiskPolicy((k) => record[k])

  it("nothing saved is the default, which is the behaviour before the policy was a setting", () => {
    expect(from({})).toEqual(DEFAULT_RISK_POLICY)
    expect(DEFAULT_RISK_POLICY).toEqual({ read: "allow", change: "allow", message: "confirm", money: "deny", security: "deny" })
  })

  it("each settable class is read; a value that is no outcome (a typo in a hand-edited file) is that class's default", () => {
    expect(from({ RISK_READ: "deny", RISK_CHANGE: "confirm", RISK_MESSAGE: "allow" })).toEqual({ read: "deny", change: "confirm", message: "allow", money: "deny", security: "deny" })
    expect(from({ RISK_READ: "Allow", RISK_CHANGE: 3, RISK_MESSAGE: null })).toEqual(DEFAULT_RISK_POLICY)
  })

  it("a hand-edited file that says money or security may run is read as deny", () => {
    expect(from({ RISK_MONEY: "allow", RISK_SECURITY: "confirm" })).toEqual(DEFAULT_RISK_POLICY)
    expect(riskPolicyOf({ money: "allow" as never, security: "allow" as never, message: "allow" })).toEqual({ ...DEFAULT_RISK_POLICY, message: "allow" })
  })

  it("a reader that throws gives the defaults", () => {
    expect(decodeRiskPolicy(() => {
      throw new Error("boom")
    })).toEqual(DEFAULT_RISK_POLICY)
  })

  it("the save check: an outcome or null for a settable class; only deny or null for money and security; other keys are not its business", () => {
    for (const key of [RISK_POLICY_KEYS.read, RISK_POLICY_KEYS.change, RISK_POLICY_KEYS.message]) {
      for (const o of RISK_OUTCOMES) expect(riskPolicyValueProblem(key, o)).toBeUndefined()
      expect(riskPolicyValueProblem(key, null)).toBeUndefined()
      expect(riskPolicyValueProblem(key, "sometimes")).toBe("Choose one of the options.")
      expect(riskPolicyValueProblem(key, true)).toBe("Choose one of the options.")
    }
    for (const key of [RISK_POLICY_KEYS.money, RISK_POLICY_KEYS.security]) {
      expect(riskPolicyValueProblem(key, "deny")).toBeUndefined()
      expect(riskPolicyValueProblem(key, null)).toBeUndefined()
      expect(riskPolicyValueProblem(key, "allow")).toBe(FIXED_REASON)
      expect(riskPolicyValueProblem(key, "confirm")).toBe(FIXED_REASON)
    }
    expect(riskPolicyValueProblem("HOME_LANGUAGE", "anything")).toBeUndefined()
  })
})

describe("the sentences, in English and Dutch", () => {
  const refusals: ReadonlyArray<RiskDecision> = [
    ...(["read", "change", "message"] as const).flatMap((by) => [{ outcome: "confirm" as const, by }, { outcome: "deny" as const, by }]),
    { outcome: "deny", by: "money" },
    { outcome: "deny", by: "security" },
    { outcome: "deny", by: "unknown" },
    { outcome: "deny", by: "unjudged" }
  ]

  it("both languages have the same keys in every table", () => {
    expect(Object.keys(RISK_TEXTS.model.nl).sort()).toEqual(Object.keys(RISK_TEXTS.model.en).sort())
    expect(Object.keys(RISK_TEXTS.spoken.nl).sort()).toEqual(Object.keys(RISK_TEXTS.spoken.en).sort())
    expect(Object.keys(RISK_TEXTS.page.nl.outcomes).sort()).toEqual(Object.keys(RISK_TEXTS.page.en.outcomes).sort())
    expect(Object.keys(RISK_TEXTS.page.nl.classes).sort()).toEqual(Object.keys(RISK_TEXTS.page.en.classes).sort())
  })

  it("every refusal has a sentence for the model and for speech in both languages; an allowed call has none", () => {
    for (const language of ["en", "nl"] as const) {
      for (const d of refusals) {
        expect(riskReason(language, d)!.length).toBeGreaterThan(10)
        expect(riskSpoken(language, d)!.length).toBeGreaterThan(5)
      }
      expect(riskReason(language, { outcome: "allow", by: "read" })).toBeUndefined()
      expect(riskSpoken(language, { outcome: "allow", by: "read" })).toBeUndefined()
      expect(riskRefusalKey({ outcome: "allow", by: "change" })).toBeUndefined()
    }
  })

  it("confirm and deny of a class have different sentences, for the model and for speech, in both languages", () => {
    for (const language of ["en", "nl"] as const) {
      for (const by of ["read", "change", "message"] as const) {
        expect(riskReason(language, { outcome: "confirm", by })).not.toBe(riskReason(language, { outcome: "deny", by }))
        expect(riskSpoken(language, { outcome: "confirm", by })).not.toBe(riskSpoken(language, { outcome: "deny", by }))
      }
    }
  })

  it("the default policy's English refusals are the gateway's sentences from before the setting, word for word", () => {
    expect(riskReason("en", { outcome: "confirm", by: "message" })).toBe(
      "it would send a message in the owner's name, which needs the owner's confirmation, and this assistant cannot ask for it yet."
    )
    expect(riskReason("en", { outcome: "deny", by: "money" })).toBe("it would spend money, which this assistant never does.")
    expect(riskReason("en", { outcome: "deny", by: "security" })).toBe("it would act on a lock, an alarm, a door or a gate, which this assistant never does.")
    expect(riskReason("en", { outcome: "deny", by: "unknown" })).toBe("what it would do is not a risk class this assistant knows.")
    expect(riskReason("en", { outcome: "deny", by: "unjudged" })).toBe("what it would do could not be judged.")
  })

  it("the withheld sentence (sensitivity) and the language rule", () => {
    expect(riskWithheld("en")).toMatch(/^Withheld: /)
    expect(riskWithheld("nl")).toMatch(/^Achtergehouden: /)
    expect(riskLanguageOf("nl-NL")).toBe("nl")
    expect(riskLanguageOf("en-GB")).toBe("en")
    expect(riskLanguageOf("de-DE")).toBe("en")
    expect(riskLanguageOf(undefined)).toBe("en")
  })

  it("every outcome has a page label in both languages", () => {
    for (const language of ["en", "nl"] as const) {
      for (const o of RISK_OUTCOMES as ReadonlyArray<RiskOutcome>) expect(RISK_TEXTS.page[language].outcomes[o].length).toBeGreaterThan(2)
      for (const c of RISK_CLASSES) expect(RISK_TEXTS.page[language].classes[c].length).toBeGreaterThan(2)
    }
  })
})
