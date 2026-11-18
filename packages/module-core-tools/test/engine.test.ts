// The calculator's bound (src/engine.ts): hostile inputs are refused or answered in a few milliseconds, never run long.
import { assert, describe, it } from "@effect/vitest"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { create, all } from "mathjs"
import { makeEngine, MAX_CHARS } from "../src/engine.ts"

const engine = makeEngine(create(all!), { cupMl: 250 })
// Warm the library up, as the module does at start, so a timing measures the sum and not the first call.
for (const s of ["1+2", "2^10", "5 cm to inch", "sqrt(4)"]) engine.evaluate(s)

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
  it("refuses every currency, however it is written, before anything is parsed", () => {
    const why = (s: string) => {
      const r = engine.evaluate(s)
      return r.ok ? "ok" : r.reason
    }
    for (const s of ["108 USD to EUR", "108 usd to eur", "50 Usd", "5 dollars", "10 euro in yen", "£5", "5 € to $", "3 pound sterling", "1 BTC to EUR"]) assert.strictEqual(why(s), "currency", s)
    // Every ISO code, in capitals and in lower case, except one that is a unit's name: "cup" is the cup.
    for (const code of Intl.supportedValuesOf("currency")) {
      if (code === "CUP") continue
      assert.strictEqual(why(`1 ${code}`), "currency", code)
      assert.strictEqual(why(`1 ${code.toLowerCase()}`), "currency", code.toLowerCase())
    }
    assert.strictEqual(why("1 cup to ml"), "ok")
    assert.notStrictEqual(why("1 CUP to ml"), "currency")
    // Pounds and ounces are masses.
    assert.strictEqual(why("10 pounds to kg"), "ok")
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
      assert.isTrue(ms < bound(25), `${text.slice(0, 40)} took ${ms.toFixed(1)} ms`)
      if (result.ok) assert.isTrue(Number.isFinite(result.value), text.slice(0, 40))
    }
  })
  it("keeps to its stated bound: 12 parentheses deep, 60 nodes, 200 characters", () => {
    assert.strictEqual((engine.evaluate("(".repeat(13) + "1" + ")".repeat(13)) as any).reason, "too-complex")
    assert.strictEqual((engine.evaluate("(".repeat(12) + "1" + ")".repeat(12)) as any).ok, true)
    assert.strictEqual((engine.evaluate("1+".repeat(40) + "1") as any).reason, "too-complex")
    assert.strictEqual((engine.evaluate("1+".repeat(25) + "1") as any).ok, true)
  })
})
