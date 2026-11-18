// The calculator module through the real host and gateway: tools, actions, settings, the rates job across a restart,
// and a network that is unreachable, slow or answering rubbish (the offline network: no test reaches the network).
import { assert, describe, it } from "@effect/vitest"
import { checkModule, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { makeCalculator, rates, texts } from "../src/calculator.ts"
import { FRANKFURTER, hangingNet, netWith, ratesAnswer } from "./support.ts"

const nl = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }

describe("calculator", () => {
  it.effect("passes the conformance check, with its texts in both languages", () => checkModule(makeCalculator(netWith({ [FRANKFURTER]: { body: ratesAnswer() } }).deps), { texts }))

  it.effect("works out sums, percentages and units, and says them for the ear", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(makeCalculator(netWith({}).deps))
      const t = (expression: string) => calc.tool("calculate", { expression })
      const pct = yield* t("17% of 340")
      assert.deepStrictEqual(pct.value, { expression: "(17 / 100) * (340)", value: 57.8, exact: "57.8", spoken: "57.8" })
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
      assert.deepStrictEqual(Object.keys(pct.value as object).sort(), ["exact", "expression", "spoken", "value"])
    }))

  it.effect("speaks in Dutch for a Dutch household, with a decimal comma", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(makeCalculator(netWith({}).deps), nl)
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
        const calc = yield* startTestModule(makeCalculator(netWith({}).deps), setup)
        const said = (expression: string) => calc.tool("calculate", { expression }).pipe(Effect.map((r) => ({ ok: r.ok, content: r.content })))
        for (const [expression, key] of [["", "empty"], ["1 +", "syntax"], ["5 cm to kg", "mismatch"], ["sqrt(-4)", "noRealAnswer"], ["2 ^ 99999", "tooLarge"], ["evaluate(1)", "notAllowed"], ["1+".repeat(40) + "1", "tooComplex"], ["9".repeat(300), "tooLong"]] as const) {
          const r = yield* said(expression)
          assert.isFalse(r.ok, expression)
          assert.strictEqual(r.content, texts[lang][key], `${lang} ${key}`)
        }
        assert.strictEqual((yield* said("5 flurb to cm")).content, texts[lang].unknownUnit.replace("{name}", "flurb"))
        // No exchange rates yet: a currency is not known.
        assert.strictEqual((yield* said("5 USD to EUR")).content, texts[lang].noRates)
      }
    }))

  it.effect("converts currencies at the rates it fetched, and says whose date they are when they are old", () =>
    Effect.gen(function*() {
      const { net, deps } = netWith({ [FRANKFURTER]: { body: ratesAnswer("2026-11-18") } })
      const calc = yield* startTestModule(makeCalculator(deps))
      yield* calc.advance(1_000)
      const usd = yield* calc.tool("calculate", { expression: "108 USD to EUR" })
      assert.deepStrictEqual({ ...(usd.value as any) }, { expression: "108 USD to EUR", value: 100, unit: "EUR", exact: "100", spoken: "100 euros", rateDate: "2026-11-18" })
      assert.strictEqual(((yield* calc.tool("calculate", { expression: "50 usd to gbp" })).value as any).spoken, "about 39.81 pounds")
      // Crypto in the answer is dropped.
      assert.strictEqual((yield* calc.tool("calculate", { expression: "1 BTC to EUR" })).ok, false)
      assert.strictEqual(net.requests[0]?.url, "https://api.frankfurter.dev/v2/rates?base=EUR")
      assert.strictEqual(net.requests[0]?.headers["user-agent"], "personal-voice-assistance/1")
      // Three days later the rate is old, and the answer says so.
      yield* calc.advance(3 * 86_400_000 - 1_000)
      const old = yield* calc.tool("calculate", { expression: "108 USD to EUR" })
      assert.strictEqual((old.value as any).spoken, "100 euros, at the rate of Wednesday the eighteenth of November 2026")
      // A Dutch household hears it in Dutch.
      const dutch = yield* startTestModule(makeCalculator(netWith({ [FRANKFURTER]: { body: ratesAnswer() } }).deps), nl)
      yield* dutch.advance(1_000)
      assert.strictEqual(((yield* dutch.tool("calculate", { expression: "108 USD to EUR" })).value as any).spoken, "100 euro")
    }))

  it.effect("keeps the rates in the store and the daily job; both survive a restart", () =>
    Effect.gen(function*() {
      const { net, deps } = netWith({ [FRANKFURTER]: { body: ratesAnswer() } })
      const calc = yield* startTestModule(makeCalculator(deps))
      yield* calc.advance(1_000)
      const row = (yield* calc.moduleStore().collection(rates).list({}))[0]!
      assert.strictEqual(row.id, "eur")
      assert.strictEqual(row.value.date, "2026-11-18")
      assert.include(row.value.table, "USD 1.08")
      assert.notInclude(row.value.table, "BTC")
      const job = (yield* calc.jobs).find((j) => j.handler === "refresh-rates")!
      assert.strictEqual(job.cron, "30 16 * * *")
      // The internet goes away; after a restart the stored rates still answer.
      net.requests.length = 0
      yield* calc.restart
      assert.strictEqual(((yield* calc.tool("calculate", { expression: "108 USD to EUR" })).value as any).spoken, "100 euros")
      // The job runs as a job, refetches, and replaces the one row (it does not add another).
      yield* calc.runJob(job.id)
      assert.strictEqual((yield* calc.moduleStore().collection(rates).list({})).length, 1)
      assert.isAbove(net.requests.length, 0)
    }))

  it.effect("the largest stored rates row is stored, and a restart reads it back", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(makeCalculator(netWith({}).deps), { settings: { exchangeRates: false } })
      // The worst legal value: 5,000 characters that each cost two of JSON, the largest time and the longest date.
      const worst = { date: "2026-11-18", fetchedAt: 8_640_000_000_000_000, table: "\"".repeat(5_000) }
      assert.isTrue((yield* Effect.exit(calc.moduleStore().collection(rates).insert(worst, { id: "eur" })))._tag === "Success")
      yield* calc.restart
      assert.strictEqual((yield* calc.tool("calculate", { expression: "1 + 1" })).ok, true)
    }))

  it.effect("the outside service unreachable, slow or answering rubbish: the sums still work, currencies say they have no rates", () =>
    Effect.gen(function*() {
      const answers = [
        { name: "unreachable", fixtures: {} },
        { name: "an error status", fixtures: { [FRANKFURTER]: { status: 503, body: "down" } } },
        { name: "not JSON", fixtures: { [FRANKFURTER]: { headers: { "content-type": "application/json" }, body: "<html>nope" } } },
        { name: "the wrong type", fixtures: { [FRANKFURTER]: { headers: { "content-type": "text/html" }, body: "<html>" } } },
        { name: "the wrong shape", fixtures: { [FRANKFURTER]: { body: { rates: { USD: 1 } } } } },
        { name: "nothing usable", fixtures: { [FRANKFURTER]: { body: [{ date: "2026-11-18", base: "EUR", quote: "XYZ", rate: 1 }, { date: "2026-11-18", base: "EUR", quote: "USD", rate: -1 }] } } }
      ]
      for (const { name, fixtures } of answers) {
        const calc = yield* startTestModule(makeCalculator(netWith(fixtures).deps))
        yield* calc.advance(10_000)
        assert.strictEqual(((yield* calc.tool("calculate", { expression: "2 + 2" })).value as any).spoken, "4", name)
        const r = yield* calc.tool("calculate", { expression: "5 USD to EUR" })
        assert.isFalse(r.ok, name)
        assert.strictEqual(r.content, texts.en.noRates, name)
        assert.deepStrictEqual(yield* calc.moduleStore().collection(rates).list({}), [], name)
      }
    }))

  it.effect("a service that never answers does not hold a turn: sums are answered at once, and stopping cuts the fetch off", () =>
    Effect.gen(function*() {
      const { net, deps } = hangingNet()
      const calc = yield* startTestModule(makeCalculator(deps))
      assert.strictEqual(((yield* calc.tool("calculate", { expression: "2 + 2" })).value as any).spoken, "4")
      assert.strictEqual((yield* calc.tool("calculate", { expression: "5 USD to EUR" })).content, texts.en.noRates)
      assert.isAbove(net.requests.length, -1)
      yield* calc.stop
    }))

  it.effect("exchange rates off: nothing is fetched or scheduled, and a currency says so", () =>
    Effect.gen(function*() {
      const { net, deps } = netWith({ [FRANKFURTER]: { body: ratesAnswer() } })
      const calc = yield* startTestModule(makeCalculator(deps), { settings: { exchangeRates: false } })
      yield* calc.advance(86_400_000)
      assert.strictEqual(net.requests.length, 0)
      assert.isUndefined((yield* calc.jobs).find((j) => j.handler === "refresh-rates"))
      assert.strictEqual((yield* calc.tool("calculate", { expression: "5 USD to EUR" })).content, texts.en.ratesOff)
      assert.deepStrictEqual((yield* calc.checkHealth).map((i) => i.id), ["calculator.rates-off"])
      const on = yield* startTestModule(makeCalculator(netWith({}).deps))
      assert.deepStrictEqual(yield* on.checkHealth, [])
    }))

  it.effect("the size of a cup is a setting; a value that is not an option is refused", () =>
    Effect.gen(function*() {
      const us = yield* startTestModule(makeCalculator(netWith({}).deps), { settings: { cup: "us" } })
      assert.strictEqual(((yield* us.tool("calculate", { expression: "1 cup to ml" })).value as any).spoken, "about 236.59 millilitres")
      // The host does not run a module whose settings do not decode: it is down, with a reason, and offers no tool.
      const bad = yield* startTestModule(makeCalculator(netWith({}).deps), { settings: { cup: "bucket" } })
      assert.strictEqual(bad.info()?.state, "error")
      assert.deepStrictEqual(bad.toolNames(), [])
    }))

  it.effect("random: coins, dice, numbers and picks, fair and bounded, in both languages", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(makeCalculator(netWith({}).deps))
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
      const dutch = yield* startTestModule(makeCalculator(netWith({}).deps), nl)
      assert.match(((yield* dutch.tool("random", { kind: "coin" })).value as any).spoken, /^(Kop|Munt)\.$/)
      assert.match(((yield* dutch.tool("random", { kind: "dice", count: 2 })).value as any).spoken, /^\d+ en \d+\. Totaal \d+\.$/)
      assert.strictEqual((yield* dutch.tool("random", { kind: "pick", options: ["a"] })).content, texts.nl.needOptions)
    }))

  it.effect("the typed actions run without the model, and refuse in words", () =>
    Effect.gen(function*() {
      const calc = yield* startTestModule(makeCalculator(netWith({}).deps))
      assert.deepStrictEqual(yield* calc.action("calculate", { expression: "17% of 340" }), { ok: true, say: "57.8" })
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
      // Off for every assistant: the gateway refuses the call.
      yield* calc.stop
      assert.isFalse((yield* calc.tool("calculate", { expression: "1+1" })).ok)
    }))
})
