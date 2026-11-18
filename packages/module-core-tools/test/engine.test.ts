// The calculator's bound (src/engine.ts): hostile inputs are refused or answered in a few milliseconds, never run long.
import { assert, describe, it } from "@effect/vitest"
import { create, all } from "mathjs"
import { makeEngine, MAX_CHARS } from "../src/engine.ts"

const engine = makeEngine(create(all!), { cupMl: 250 })
engine.setRates(new Map([["USD", 1.08], ["GBP", 0.86], ["JPY", 160]]))
// Warm the library up, as the module does at start, so a timing measures the sum and not the first call.
for (const s of ["1+2", "2^10", "5 cm to inch", "sqrt(4)"]) engine.evaluate(s)

const SKIPPED: Array<string> = []
const timed = (text: string) => {
  const start = performance.now()
  const result = engine.evaluate(text)
  return { result, ms: performance.now() - start }
}

describe("the bounded evaluator", () => {
  it("works out the ordinary things", () => {
    const v = (s: string) => {
      const r = engine.evaluate(s)
      return r.ok ? { value: r.value, unit: r.unit } : r
    }
    assert.deepStrictEqual(v("(3 + 4) * 12.5"), { value: 87.5, unit: undefined })
    assert.deepStrictEqual(v("17% of 340"), { value: 57.8, unit: undefined })
    assert.deepStrictEqual(v("17 percent of 340"), { value: 57.8, unit: undefined })
    assert.deepStrictEqual(v("17 procent van 340"), { value: 57.8, unit: undefined })
    assert.deepStrictEqual(v("340 + 15%"), { value: 391, unit: undefined })
    assert.deepStrictEqual(v("what percent is 12 of 80"), { value: 15, unit: undefined })
    assert.deepStrictEqual(v("5!"), { value: 120, unit: undefined })
    assert.deepStrictEqual(v("sqrt(144) + pi * 0"), { value: 12, unit: undefined })
    assert.deepStrictEqual(v("500 ml to cup"), { value: 2, unit: "cup" })
    assert.deepStrictEqual(v("10 pounds to kg"), { value: 4.5359237, unit: "kg" })
    assert.strictEqual((v("5 cm to inch") as any).unit, "inch")
    assert.strictEqual((v("60 mph to km/h") as any).unit, "km / h")
    assert.strictEqual((v("60 mph to kph") as any).unit, "km / hour")
  })
  it("converts currencies at the installed rates, and in lower case", () => {
    const usd = engine.evaluate("108 USD to EUR")
    assert.isTrue(usd.ok && Math.abs(usd.value - 100) < 1e-9 && usd.unit === "EUR")
    const low = engine.evaluate("108 usd to eur")
    assert.isTrue(low.ok && Math.abs(low.value - 100) < 1e-9)
    const cross = engine.evaluate("1 GBP to USD")
    assert.isTrue(cross.ok && Math.abs(cross.value - 1.08 / 0.86) < 1e-9)
  })
  it("refuses what it must refuse, with a reason", () => {
    const why = (s: string) => {
      const r = engine.evaluate(s)
      return r.ok ? "ok" : r.reason
    }
    assert.strictEqual(why(""), "empty")
    assert.strictEqual(why("1 +"), "syntax")
    assert.strictEqual(why("1 / 0"), "too-large")
    assert.strictEqual(why("sqrt(-4)"), "no-real-answer")
    assert.strictEqual(why("5 cm to kg"), "mismatch")
    assert.strictEqual(why("5 flurb to cm"), "unknown-unit")
    assert.strictEqual(why("1" + "0".repeat(MAX_CHARS)), "too-long")
    assert.strictEqual(why("2 ^ 1000000"), "too-large")
    for (const s of ["evaluate(\"1\")", "import({a: 1})", "[1,2,3]", "x = 5", "f(x) = x", "\"abc\"", "a.b", "{a: 1}", "1:10", "zeros(5)", "range(1, 10)", "(sqrt)(4)", "sqrt", "cm"]) {
      assert.notStrictEqual(why(s), "ok", s)
    }
  })
  it("answers hostile inputs in a few milliseconds", () => {
    const hostile = [
      "2 ^ 999999999", "10 ^ 10 ^ 10 ^ 10", "9 ^ 9 ^ 9 ^ 9", "factorial(1e9)", "1e9!", "170! ^ 170", "(5 cm) ^ 1e9", "10 ^ 1000000 cm to inch",
      "combinations(1e12, 5e11)", "gcd(1e15, 3)", "permutations(1e9)", "nthRoot(2, 1e-300)", "round(1.5, 1e9)", "bignumber(2) ^ 1000000", "zeros(100000)",
      "range(1, 1e9)", "1:1e9", "sum(range(1, 1e9))", "\"a\" * 1e9", "[1,2,3] * 1e9", "sin(1e300)", "log(0)", "0 ^ 0", "(-8) ^ (1/3)",
      "(".repeat(5000) + "1" + ")".repeat(5000), "(".repeat(13) + "1" + ")".repeat(13), "1+".repeat(100) + "1", "sqrt(".repeat(30) + "4" + ")".repeat(30),
      "-".repeat(150) + "1", "1" + "!".repeat(150), "9".repeat(199), "1e308 * 1e308", "1e-400", "0.".padEnd(190, "0") + "1", "2^2^2^2^2^2^2^2",
      "((((((((((((1))))))))))))", "1 + ".repeat(49) + "5%", "1".repeat(100) + " + " + "1".repeat(90) + "%", "what percent is " + "9".repeat(80) + " of " + "9".repeat(80), "1 USD ".repeat(20) + "to EUR", "min(" + "1,".repeat(90) + "1)", "a b c d e f g h", "sqrt(sqrt(sqrt(sqrt(sqrt(16)))))"
    ]
    for (const text of hostile) {
      const { result, ms } = timed(text)
      assert.isTrue(ms < 25, `${text.slice(0, 40)} took ${ms.toFixed(1)} ms`)
      if (result.ok) assert.isTrue(Number.isFinite(result.value), text.slice(0, 40))
    }
  })
  it("installs every ISO currency, skipping the codes mathjs already uses for another unit", () => {
    const fresh = makeEngine(create(all!), { cupMl: 250 })
    const everything = new Map(Intl.supportedValuesOf("currency").map((code, i) => [code, 1 + i / 100] as const))
    const skipped = fresh.setRates(everything)
    // Recorded (docs/modules/calculator.md): these cannot be converted, and say "I don't know the unit" instead of guessing.
    assert.deepStrictEqual(skipped, SKIPPED)
    assert.isAbove(everything.size - skipped.length, 140)
    for (const code of ["USD", "GBP", "JPY", "CHF", "AUD", "CAD", "SEK", "NOK", "DKK", "PLN", "TRY", "BRL", "INR", "CNY"]) assert.isTrue(fresh.hasCurrency(code), code)
  })
  it("keeps to its stated bound: 12 parentheses deep, 60 nodes, 200 characters", () => {
    assert.strictEqual((engine.evaluate("(".repeat(13) + "1" + ")".repeat(13)) as any).reason, "too-complex")
    assert.strictEqual((engine.evaluate("(".repeat(12) + "1" + ")".repeat(12)) as any).ok, true)
    assert.strictEqual((engine.evaluate("1+".repeat(40) + "1") as any).reason, "too-complex")
    assert.strictEqual((engine.evaluate("1+".repeat(25) + "1") as any).ok, true)
  })
})
