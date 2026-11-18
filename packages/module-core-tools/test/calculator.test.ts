// The calculator module through the real host and gateway: tools, actions and settings. It needs no network and
// stores nothing; a currency is a sentence saying it is not converted yet.
import { assert, describe, it } from "@effect/vitest"
import { checkModule, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { calculatorModule, texts } from "../src/calculator.ts"

const nl = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }

describe("calculator", () => {
  it.effect("passes the conformance check, with its texts in both languages", () => checkModule(calculatorModule, { texts }))

  it.effect("works out sums, percentages and units, and says them for the ear", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(calculatorModule)
      const t = (expression: string) => calc.tool("calculate", { expression })
      const pct = yield* t("17% of 340")
      assert.deepStrictEqual(pct.value, { expression: "(17 / 100) * (340)", value: 57.8, spoken: "57.8" })
      assert.strictEqual(((yield* t("500 ml to cup")).value as any).spoken, "2 cups")
      assert.strictEqual(((yield* t("1 cup to ml")).value as any).spoken, "250 millilitres")
      assert.strictEqual(((yield* t("5 cm to inch")).value as any).spoken, "about 1.97 inches")
      assert.strictEqual(((yield* t("10 pounds to kg")).value as any).spoken, "about 4.54 kilograms")
      assert.strictEqual(((yield* t("0.1 + 0.2")).value as any).spoken, "0.3")
      assert.strictEqual(((yield* t("1234 * 5")).value as any).spoken, "6170")
      assert.strictEqual(((yield* t("1500000 * 3")).value as any).spoken, "4.5 million")
      assert.strictEqual(((yield* t("2 ^ 100")).value as any).spoken, "about 1.27 times ten to the power 30")
      assert.strictEqual(((yield* t("1 / 3")).value as any).spoken, "about 0.33")
      assert.strictEqual(((yield* t("-4 * 2")).value as any).spoken, "minus 8")
      assert.strictEqual(((yield* t("1 / 300000")).value as any).spoken, "about 3.33 times ten to the power minus 6")
      // Tool results are plain data: nothing to hide, but the result never holds more than the sum.
      assert.deepStrictEqual(Object.keys(pct.value as object).sort(), ["expression", "spoken", "value"])
    }))

  it.effect("speaks in Dutch for a Dutch household, with a decimal comma", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(calculatorModule, nl)
      assert.strictEqual(((yield* calc.tool("calculate", { expression: "17 procent van 340" })).value as any).spoken, "57,8")
      assert.strictEqual(((yield* calc.tool("calculate", { expression: "500 ml to cup" })).value as any).spoken, "2 kopjes")
      assert.strictEqual(((yield* calc.tool("calculate", { expression: "5 cm to inch" })).value as any).spoken, "ongeveer 1,97 inch")
      assert.strictEqual(((yield* calc.tool("calculate", { expression: "1500000 * 3" })).value as any).spoken, "4,5 miljoen")
      const bad = yield* calc.tool("calculate", { expression: "1 +" })
      assert.isFalse(bad.ok)
      assert.strictEqual(bad.content, "Ik begreep die som niet.")
    }))

  it.effect("every refusal says what the person can do, in both languages", () =>
    Effect.gen(function*() {
      for (const [setup, lang] of [[{}, "en"], [nl, "nl"]] as const) {
        const calc = yield* startTestModule(calculatorModule, setup)
        const said = (expression: string) => calc.tool("calculate", { expression }).pipe(Effect.map((r) => ({ ok: r.ok, content: r.content })))
        for (const [expression, key] of [["", "empty"], ["1 +", "syntax"], ["5 cm to kg", "mismatch"], ["sqrt(-4)", "noRealAnswer"], ["2 ^ 99999", "tooLarge"], ["evaluate(1)", "notAllowed"], ["1+".repeat(40) + "1", "tooComplex"], ["9".repeat(300), "tooLong"]] as const) {
          const r = yield* said(expression)
          assert.isFalse(r.ok, expression)
          assert.strictEqual(r.content, texts[lang][key], `${lang} ${key}`)
        }
        assert.strictEqual((yield* said("5 flurb to cm")).content, texts[lang].unknownUnit.replace("{name}", "flurb"))
        // Currencies are not converted in this version, however they are written.
        for (const expression of ["5 USD to EUR", "50 usd to eur", "50 dollars in euros", "€5 to $", "1 BTC to EUR", "100 gbp", "3 pound sterling to yen"]) {
          assert.strictEqual((yield* said(expression)).content, texts[lang].currency, `${lang} ${expression}`)
        }
      }
    }))

  it.effect("keeps the value it computed: an integer is exact to the last digit, and only the spoken form is rounded", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(calculatorModule)
      const v = (expression: string) => calc.tool("calculate", { expression }).pipe(Effect.map((r) => r.value as any))
      assert.deepStrictEqual(yield* v("1234567890123 + 1"), { expression: "1234567890123 + 1", value: 1234567890124, spoken: "about 1.23 trillion" })
      assert.strictEqual((yield* v("999999999999 * 9")).value, 8999999999991)
      assert.strictEqual((yield* v("9007199254740991 - 1")).value, 9007199254740990)
      assert.strictEqual((yield* v("123456789 * 1000")).value, 123456789000)
      // Outside the exact integers, the result says it is approximate: an operand, an intermediate result or the answer.
      for (const expression of ["9007199254740993 - 9007199254740992", "2 ^ 53 + 1 - 2 ^ 53", "2 ^ 60", "25!", "0.12345678901234567 * 2", "1e20 / 1e10"]) {
        const r = yield* v(expression)
        assert.strictEqual(r.approximate, true, expression)
        assert.match(r.spoken, /^about /, expression)
      }
      assert.isUndefined((yield* v("2 ^ 52")).approximate)
      assert.strictEqual((yield* v("2 ^ 52")).value, 4503599627370496)
      // A fraction loses only the binary noise.
      assert.strictEqual((yield* v("0.1 + 0.2")).value, 0.3)
      assert.strictEqual((yield* v("1 / 3")).value, 0.333333333333333)
    }))

  it.effect("a unit's spoken name never names another quantity: in Dutch an avoirdupois pound or ounce is said as such", () =>
    Effect.gen(function*() {
      const dutch = yield* startTestModule(calculatorModule, nl)
      const said = (expression: string) => dutch.tool("calculate", { expression }).pipe(Effect.map((r) => (r.value as any).spoken as string))
      assert.strictEqual(yield* said("453.59237 g to lb"), "1 Engels pond")
      assert.strictEqual(yield* said("907.18474 g to lb"), "2 Engelse pond")
      assert.strictEqual(yield* said("28.349523125 g to oz"), "1 ounce")
      assert.strictEqual(yield* said("1 lb to g"), "ongeveer 453,59 gram")
      for (const expression of ["1 lb to kg", "2 oz to g", "5 lb to oz", "1 pound to g"]) assert.notMatch(yield* said(expression), /\b(pond|ons)\b(?<!Engels pond|Engelse pond)/, expression)
      // US customary units mathjs uses, named as such in both languages.
      assert.strictEqual(yield* said("3.785411784 l to gal"), "1 Amerikaanse gallon")
      const en = yield* startTestModule(calculatorModule)
      assert.strictEqual(((yield* en.tool("calculate", { expression: "3.785411784 l to gal" })).value as any).spoken, "1 US gallon")
      assert.strictEqual(((yield* en.tool("calculate", { expression: "453.59237 g to lb" })).value as any).spoken, "1 pound")
    }))

  it.effect("needs no network and stores nothing: no collection, no job, no requirement", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(calculatorModule)
      yield* calc.advance(2 * 86_400_000)
      assert.deepStrictEqual(yield* calc.jobs, [])
      assert.isUndefined(calculatorModule.storage)
      assert.isUndefined(calculatorModule.requires)
      assert.deepStrictEqual(yield* calc.checkHealth, [])
      assert.strictEqual(((yield* calc.tool("calculate", { expression: "2 + 2" })).value as any).spoken, "4")
    }))

  it.effect("the size of a cup is a setting; a value that is not an option is refused", () =>
    Effect.gen(function*() {
      const us = yield* startTestModule(calculatorModule, { settings: { cup: "us" } })
      assert.strictEqual(((yield* us.tool("calculate", { expression: "1 cup to ml" })).value as any).spoken, "about 236.59 millilitres")
      // The host does not run a module whose settings do not decode: it is down, with a reason, and offers no tool.
      const bad = yield* startTestModule(calculatorModule, { settings: { cup: "bucket" } })
      assert.strictEqual(bad.info()?.state, "error")
      assert.deepStrictEqual(bad.toolNames(), [])
    }))

  it.effect("random: coins, dice, numbers and picks, fair and bounded, in both languages", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(calculatorModule)
      const r = (input: Record<string, unknown>) => calc.tool("random", input)
      const coin = (yield* r({ kind: "coin" })).value as any
      assert.match(coin.spoken, /^(Heads|Tails)\.$/)
      const dice = (yield* r({ kind: "dice", count: 2 })).value as any
      assert.lengthOf(dice.values, 2)
      assert.strictEqual(dice.total, dice.values[0] + dice.values[1])
      assert.match(dice.spoken, /^\d+ and \d+\. Total \d+\.$/)
      const one = (yield* r({ kind: "dice", sides: 20 })).value as any
      assert.isTrue(one.values[0] >= 1 && one.values[0] <= 20)
      // Fair: a thousand rolls of a six-sided die reach every face, none more than a quarter of the time.
      const counts = new Array<number>(7).fill(0)
      for (let i = 0; i < 300; i++) counts[((yield* r({ kind: "dice" })).value as any).values[0]]!++
      for (let face = 1; face <= 6; face++) assert.isTrue(counts[face]! > 10 && counts[face]! < 100, `face ${face}: ${counts[face]}`)
      const n = (yield* r({ kind: "number", min: 5, max: 6 })).value as any
      assert.isTrue(n.values[0] === 5 || n.values[0] === 6)
      const pick = (yield* r({ kind: "pick", options: ["pizza", "pasta"] })).value as any
      assert.match(pick.spoken, /^(pizza|pasta)\.$/)
      // Refusals.
      assert.strictEqual((yield* r({ kind: "pick", options: ["only one"] })).content, texts.en.needOptions)
      assert.strictEqual((yield* r({ kind: "pick" })).content, texts.en.needOptions)
      assert.strictEqual((yield* r({ kind: "number", min: 9, max: 3 })).content, texts.en.badRange)
      assert.strictEqual((yield* r({ kind: "number", min: -1_000_000_000, max: 1_000_000_000, count: 20 })).ok, true)
      assert.isFalse((yield* r({ kind: "dice", count: 21 })).ok)
      assert.isFalse((yield* r({ kind: "dice", sides: 1 })).ok)
      assert.isFalse((yield* r({ kind: "coin", count: 0 })).ok)
      assert.isFalse((yield* r({ kind: "marble" })).ok)
      const dutch = yield* startTestModule(calculatorModule, nl)
      assert.match(((yield* dutch.tool("random", { kind: "coin" })).value as any).spoken, /^(Kop|Munt)\.$/)
      assert.match(((yield* dutch.tool("random", { kind: "dice", count: 2 })).value as any).spoken, /^\d+ en \d+\. Totaal \d+\.$/)
      assert.strictEqual((yield* dutch.tool("random", { kind: "pick", options: ["a"] })).content, texts.nl.needOptions)
    }))

  it.effect("the typed actions run without the model, and refuse in words", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(calculatorModule)
      // No model follows an action: the sum is said back before the answer, so a misheard number is audible.
      assert.deepStrictEqual(yield* calc.action("calculate", { expression: "17% of 340" }), { ok: true, say: "17 percent of 340 is 57.8." })
      assert.deepStrictEqual(yield* calc.action("calculate", { expression: "12 * 15" }), { ok: true, say: "12 times 15 is 180." })
      assert.deepStrictEqual(yield* calc.action("calculate", { expression: "500 ml to cup" }), { ok: true, say: "500 millilitres in cups is 2 cups." })
      assert.deepStrictEqual(yield* calc.action("calculate", { expression: "what percent is 12 of 80" }), { ok: true, say: "12 of 80 is 15 percent." })
      assert.deepStrictEqual(yield* calc.action("calculate", { expression: "340 + 15%" }), { ok: true, say: "340 plus 15 percent is 391." })
      assert.deepStrictEqual(yield* calc.action("calculate", { expression: "sqrt(144) - 2.5" }), { ok: true, say: "the square root of 144 minus 2.5 is 9.5." })
      // Bounded: a sum too long to say back is answered alone.
      const long = "1 + ".repeat(25) + "1"
      assert.deepStrictEqual(yield* calc.action("calculate", { expression: long }), { ok: true, say: "The answer is 26." })
      const bad = yield* calc.action("calculate", { expression: "1 +" })
      assert.deepStrictEqual(bad, { ok: false, code: "failed", message: texts.en.syntax })
      const dice = yield* calc.action("roll_dice", { count: 2 })
      assert.isTrue(dice.ok && /Total/.test(dice.say ?? ""))
      const one = yield* calc.action("roll_dice", {})
      assert.isTrue(one.ok && /^A \d\.$/.test(one.say ?? ""))
      const coin = yield* calc.action("flip_coin", {})
      assert.isTrue(coin.ok && /^(Heads|Tails)\.$/.test(coin.say ?? ""))
      // The tools the model is offered: the two tools, not the actions again.
      assert.deepStrictEqual(calc.toolNames().sort(), ["calculate", "random"])
      const dutch = yield* startTestModule(calculatorModule, nl)
      assert.deepStrictEqual(yield* dutch.action("calculate", { expression: "17% van 340" }), { ok: true, say: "17 procent van 340 is 57,8." })
      assert.deepStrictEqual(yield* dutch.action("calculate", { expression: "12 * 15" }), { ok: true, say: "12 keer 15 is 180." })
      assert.deepStrictEqual(yield* dutch.action("calculate", { expression: "1 / 3" }), { ok: true, say: "1 gedeeld door 3 is ongeveer 0,33." })
      assert.deepStrictEqual(yield* dutch.action("calculate", { expression: "1 + ".repeat(25) + "1" }), { ok: true, say: "Het antwoord is 26." })
      // Off for every assistant: the gateway refuses the call.
      yield* calc.stop
      assert.isFalse((yield* calc.tool("calculate", { expression: "1+1" })).ok)
    }))
})
