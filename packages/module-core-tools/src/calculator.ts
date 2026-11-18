// The calculator module: `calculate` (arithmetic, percentages, units, currency) and `random`, bounded as engine.ts says.
import { ActionError, defineAction, defineCollection, defineModule, makeTool, Param, Setting, ToolError } from "@pva/core"
import { speakDate, speakList, type LocalDate } from "@pva/language"
import { defineTexts, homeLanguage, say, StoredText } from "@pva/module-contracts"
import { Clock, Effect, Schema } from "effect"
import { randomInt } from "node:crypto"
import { type CalcFailure, type Engine, makeEngine } from "./engine.ts"
import { agentOf, type NetDeps } from "./net.ts"
import { decodeTable, encodeTable, fetchRates, MAX_RATES } from "./rates.ts"
import { spokenNumber, spokenUnit } from "./spoken.ts"

export const texts = defineTexts({
  en: {
    empty: "What should I work out?",
    tooLong: "That is too long for me to work out. Try a shorter sum.",
    tooComplex: "That sum is too complicated for me. Try it in smaller steps.",
    notAllowed: "I can only do arithmetic, percentages, and unit or currency conversions.",
    syntax: "I couldn't understand that sum.",
    unknownUnit: "I don't know the unit {name}.",
    mismatch: "Those two can't be converted into each other.",
    noRealAnswer: "That has no real answer.",
    tooLarge: "That number is too large for me to work out.",
    noRates: "I don't have exchange rates yet.",
    ratesOff: "Exchange rates are switched off, so I can't convert currencies.",
    atRate: "at the rate of {date}",
    answer: "{about}{number}{unit}",
    withRate: "{answer}, {atRate}",
    coinHeads: "heads",
    coinTails: "tails",
    total: "Total {total}.",
    diceOne: "A {value}.",
    needOptions: "Give me at least two things to pick from.",
    badRange: "The smallest number has to be lower than the largest.",
    rangeTooWide: "That range is too wide.",
    noHealthRates: "Exchange rates are switched off.",
    healthDetail: "Currency conversion will not work. Switch exchange rates on in the module's settings."
  },
  nl: {
    empty: "Wat moet ik uitrekenen?",
    tooLong: "Dat is te lang voor mij om uit te rekenen. Probeer een kortere som.",
    tooComplex: "Die som is te ingewikkeld voor mij. Probeer het in kleinere stappen.",
    notAllowed: "Ik kan alleen rekenen, procenten uitrekenen en eenheden of valuta omrekenen.",
    syntax: "Ik begreep die som niet.",
    unknownUnit: "Ik ken de eenheid {name} niet.",
    mismatch: "Die twee kan ik niet in elkaar omrekenen.",
    noRealAnswer: "Daar is geen echt antwoord op.",
    tooLarge: "Dat getal is te groot voor mij om uit te rekenen.",
    noRates: "Ik heb nog geen wisselkoersen.",
    ratesOff: "Wisselkoersen staan uit, dus ik kan geen valuta omrekenen.",
    atRate: "tegen de koers van {date}",
    answer: "{about}{number}{unit}",
    withRate: "{answer}, {atRate}",
    coinHeads: "kop",
    coinTails: "munt",
    total: "Totaal {total}.",
    diceOne: "Een {value}.",
    needOptions: "Geef me minstens twee dingen om uit te kiezen.",
    badRange: "Het kleinste getal moet lager zijn dan het grootste.",
    rangeTooWide: "Dat bereik is te groot.",
    noHealthRates: "Wisselkoersen staan uit.",
    healthDetail: "Valuta omrekenen werkt niet. Zet wisselkoersen aan in de instellingen van de module."
  }
})

/** The stored exchange rates: one row, units of each currency for one euro. */
export const Rates = Schema.Struct({
  date: StoredText(10),
  fetchedAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })),
  table: StoredText(5_000)
})
export const rates = defineCollection({ name: "rates", scope: "household", schema: Rates, maxChars: 10_300 })
const RATES_ID = "eur"
const STALE_MS = 36 * 3_600_000

const settings = {
  cup: Setting.choice({
    label: "Size of a cup",
    description: "What \"cup\" means in a conversion.",
    options: [{ value: "metric", label: "Metric cup, 250 ml" }, { value: "us", label: "US cup, 236.6 ml" }],
    default: "metric"
  }),
  exchangeRates: Setting.boolean({
    label: "Fetch exchange rates",
    description: "Once a day from the public Frankfurter service (no key). Off: currencies cannot be converted and nothing is sent.",
    default: true
  })
}

const failureText = (failure: CalcFailure, lang: "en" | "nl", ratesOn: boolean): string => {
  switch (failure.reason) {
    case "empty": return say(texts, lang, "empty")
    case "too-long": return say(texts, lang, "tooLong")
    case "too-complex": return say(texts, lang, "tooComplex")
    case "not-allowed": return say(texts, lang, "notAllowed")
    case "syntax": return say(texts, lang, "syntax")
    case "mismatch": return say(texts, lang, "mismatch")
    case "no-real-answer": return say(texts, lang, "noRealAnswer")
    case "too-large": return say(texts, lang, "tooLarge")
    case "no-rates": return say(texts, lang, ratesOn ? "noRates" : "ratesOff")
    case "unknown-unit":
      // An unknown three-capital word is most likely a currency the module has no rate for.
      return failure.detail !== undefined && /^[A-Z]{3}$/.test(failure.detail)
        ? say(texts, lang, ratesOn ? "noRates" : "ratesOff")
        : failure.detail === undefined ? say(texts, lang, "syntax") : say(texts, lang, "unknownUnit", { name: failure.detail })
  }
}

interface RateState {
  date: string | undefined
  fetchedAt: number | undefined
}

const tidy = (n: number): number => (n === 0 ? 0 : Number(n.toPrecision(12)))

/** The calculator as a factory: the tests give it a network that has none; `calculatorModule` is the production one. */
export const makeCalculator = (deps: NetDeps = {}) =>
  defineModule({
    apiVersion: 2,
    id: "calculator",
    name: "Calculator",
    description: "Arithmetic, units and currency, worked out exactly, and random picks.",
    enabledByDefault: false,
    settings,
    requires: [{ network: "internet", optional: true, why: "Exchange rates, fetched once a day. Everything else works offline." }],
    health: ({ settings: s }) =>
      Effect.succeed(
        s?.exchangeRates === false
          ? [{ id: "calculator.rates-off", severity: "info" as const, title: say(texts, "en", "noHealthRates"), detail: say(texts, "en", "healthDetail") }]
          : []
      ),
    storage: { collections: [rates] },
    shared: (ctx) =>
      Effect.gen(function*() {
        // The library is large: loaded here, when the module is demanded, never at the app's start.
        const { create, all } = yield* Effect.promise(() => import("mathjs"))
        const engine = makeEngine(create(all!), { cupMl: ctx.settings.cup === "us" ? 236.588 : 250 })
        // Warm the library up once, so the first spoken sum costs what the next does.
        for (const sum of ["1 + 2 * 3", "2 ^ 10", "5 cm to inch", "17% of 340", "sqrt(16)"]) engine.evaluate(sum)
        const state: RateState = { date: undefined, fetchedAt: undefined }
        const on = ctx.settings.exchangeRates !== false
        const store = ctx.store.collection(rates)

        const install = (row: typeof Rates.Type) => {
          engine.setRates(decodeTable(row.table))
          state.date = row.date
          state.fetchedAt = row.fetchedAt
        }
        const saved = yield* store.get(RATES_ID).pipe(Effect.orElseSucceed(() => undefined))
        if (saved !== undefined) install(saved.value)

        /** Fetch, keep and install the rates. Fails with a reason; the job retries it, a start only tries once. */
        const refresh = Effect.gen(function*() {
          const table = yield* fetchRates(deps, agentOf(ctx.host.view()))
          const row = { date: table.date, fetchedAt: yield* Clock.currentTimeMillis, table: encodeTable(table.perEuro) }
          const existing = yield* store.get(RATES_ID)
          if (existing === undefined) yield* store.insert(row, { id: RATES_ID })
          else yield* store.update(RATES_ID, () => row)
          install(row)
        })

        if (on) {
          yield* ctx.scheduler.handle("refresh-rates", { payload: Schema.Struct({}), idempotent: true, run: () => refresh }).pipe(Effect.orDie)
          // Once a day, after the central banks have published (the household's zone).
          yield* ctx.scheduler.schedule({ handler: "refresh-rates", key: "rates", cron: "30 16 * * *" }).pipe(Effect.orDie)
          const now = yield* Clock.currentTimeMillis
          if (state.fetchedAt === undefined || now - state.fetchedAt > STALE_MS) yield* Effect.forkScoped(Effect.ignore(refresh))
        }
        return { value: { engine, state, ratesOn: on } }
      }),
    start: (ctx) =>
      Effect.sync(() => {
        const calculate = (expression: string) =>
          Effect.gen(function*() {
            const lang = homeLanguage(ctx.host.view())
            const { engine, state, ratesOn } = ctx.shared as { engine: Engine; state: RateState; ratesOn: boolean }
            const result = engine.evaluate(expression)
            if (!result.ok) return { ok: false as const, message: failureText(result, lang, ratesOn) }
            const value = tidy(result.value)
            const number = spokenNumber(value, lang)
            const unit = result.unit === undefined ? "" : ` ${spokenUnit(result.unit, value, lang)}`
            let spoken = say(texts, lang, "answer", { about: number.about ? (lang === "nl" ? "ongeveer " : "about ") : "", number: number.text, unit })
            // A currency is in the answer or the sum: say whose rate it was when it is not today's.
            const usesRate = [...expression.matchAll(/\b[A-Za-z]{3}\b/g)].some((m) => m[0].toUpperCase() !== "EUR" && engine.hasCurrency(m[0].toUpperCase()))
            const rateDate = usesRate ? state.date : undefined
            if (rateDate !== undefined) {
              const now = yield* Clock.currentTimeMillis
              if (now - Date.parse(`${rateDate}T12:00:00Z`) > 36 * 3_600_000) {
                const [year, month, day] = rateDate.split("-").map(Number) as [number, number, number]
                const today = new Date(now)
                const todayLocal: LocalDate = { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1, day: today.getUTCDate() }
                const said = speakDate({ year, month, day }, lang, todayLocal) ?? rateDate
                spoken = say(texts, lang, "withRate", { answer: spoken, atRate: say(texts, lang, "atRate", { date: said }) })
              }
            }
            return {
              ok: true as const,
              value: {
                expression: result.expression,
                value,
                ...(result.unit !== undefined ? { unit: result.unit } : {}),
                exact: String(value),
                spoken,
                ...(rateDate !== undefined ? { rateDate } : {})
              }
            }
          })

        const calculateTool = makeTool({
          name: "calculate",
          description:
            "Work out arithmetic exactly, with units and currencies. Takes one expression such as \"17% of 340\", \"(3 + 4) * 12.5\", \"sqrt(144)\", \"500 ml to cup\", \"5 cm to inch\", \"60 mph to km/h\" or \"50 USD to EUR\" (ISO currency codes). " +
            "Operators + - * / ^ % and ! ; functions sqrt cbrt abs round floor ceil min max sin cos tan log exp; constants pi e. Always use this instead of working a sum out yourself, and say the numbers you worked with back to the person.",
          parameters: Schema.Struct({ expression: Schema.String.check(Schema.isMaxLength(400)).annotate({ description: "The expression to work out, in plain digits with a dot as the decimal mark" }) }),
          speculative: true,
          latency: "instant",
          execute: ({ expression }) =>
            Effect.flatMap(calculate(expression), (r) => (r.ok ? Effect.succeed(r.value) : Effect.fail(new ToolError({ message: r.message }))))
        })

        const randomTool = makeTool({
          name: "random",
          description: "Flip a coin, roll dice, draw a random whole number in a range, or pick one of several options, fairly.",
          parameters: Schema.Struct({
            kind: Schema.Literals(["coin", "dice", "number", "pick"]),
            count: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({ description: "How many coins or dice (default 1)" })),
            sides: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1000 })).annotate({ description: "Sides of a die (default 6)" })),
            min: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: -1_000_000_000, maximum: 1_000_000_000 })).annotate({ description: "Lowest number (default 1)" })),
            max: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: -1_000_000_000, maximum: 1_000_000_000 })).annotate({ description: "Highest number (default 100)" })),
            options: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(50)).annotate({ description: "What to pick from, for kind pick" }))
          }),
          speculative: true,
          latency: "instant",
          execute: (input) =>
            Effect.suspend(() => {
              const lang = homeLanguage(ctx.host.view())
              const r = roll(input, lang)
              return r.ok ? Effect.succeed(r.value) : Effect.fail(new ToolError({ message: r.message }))
            })
        })

        const sayOf = (lang: "en" | "nl", values: ReadonlyArray<string>) => speakList(values, lang) ?? values.join(", ")

        const roll = (
          input: { readonly kind: "coin" | "dice" | "number" | "pick"; readonly count?: number; readonly sides?: number; readonly min?: number; readonly max?: number; readonly options?: ReadonlyArray<string> },
          lang: "en" | "nl"
        ): { readonly ok: true; readonly value: { readonly values: ReadonlyArray<string | number>; readonly total?: number; readonly spoken: string } } | { readonly ok: false; readonly message: string } => {
          const count = input.count ?? 1
          switch (input.kind) {
            case "coin": {
              const values = Array.from({ length: count }, () => (randomInt(2) === 0 ? say(texts, lang, "coinHeads") : say(texts, lang, "coinTails")))
              const first = values[0]!
              return { ok: true, value: { values, spoken: `${first.charAt(0).toUpperCase()}${first.slice(1)}${values.length > 1 ? `, ${sayOf(lang, values.slice(1))}` : ""}.` } }
            }
            case "dice": {
              const sides = input.sides ?? 6
              const values = Array.from({ length: count }, () => randomInt(1, sides + 1))
              const total = values.reduce((a, b) => a + b, 0)
              const spoken = values.length === 1 ? say(texts, lang, "diceOne", { value: values[0]! }) : `${sayOf(lang, values.map(String))}. ${say(texts, lang, "total", { total })}`
              return { ok: true, value: { values, ...(values.length > 1 ? { total } : {}), spoken } }
            }
            case "number": {
              const min = input.min ?? 1
              const max = input.max ?? 100
              if (min >= max) return { ok: false, message: say(texts, lang, "badRange") }
              if (max - min >= 2 ** 47) return { ok: false, message: say(texts, lang, "rangeTooWide") }
              const values = Array.from({ length: count }, () => randomInt(min, max + 1))
              return { ok: true, value: { values, spoken: `${sayOf(lang, values.map(String))}.` } }
            }
            case "pick": {
              const options = (input.options ?? []).map((o) => o.trim()).filter((o) => o !== "")
              if (options.length < 2) return { ok: false, message: say(texts, lang, "needOptions") }
              const chosen = options[randomInt(options.length)]!
              return { ok: true, value: { values: [chosen], spoken: `${chosen}.` } }
            }
          }
        }

        const actions = [
          defineAction({
            id: "calculate",
            label: "Work out a sum",
            description: "Work out arithmetic, a percentage, or a unit or currency conversion.",
            examples: ["what is 17 percent of 340", "calculate 12 times 15", "500 ml to cups", "fifty dollars in euros", "wat is 17 procent van 340", "bereken 12 keer 15"],
            params: { expression: Param.text({ label: "The sum", after: ["calculate", "what is", "what's", "bereken", "wat is", "hoeveel is"], maxWords: 14 }) },
            speculative: true,
            offerAsTool: false,
            run: ({ expression }) =>
              Effect.flatMap(calculate(expression), (r) => (r.ok ? Effect.succeed({ say: r.value.spoken }) : Effect.fail(new ActionError({ message: r.message }))))
          }),
          defineAction({
            id: "roll_dice",
            label: "Roll dice",
            description: "Roll one or more dice.",
            examples: ["roll a die", "roll two dice", "gooi een dobbelsteen", "gooi twee dobbelstenen"],
            params: { count: Param.number({ label: "How many dice", min: 1, max: 20, integer: true, optional: true }) },
            speculative: true,
            offerAsTool: false,
            run: ({ count }) => {
              const r = roll({ kind: "dice", count: count ?? 1 }, homeLanguage(ctx.host.view()))
              return r.ok ? Effect.succeed({ say: r.value.spoken }) : Effect.fail(new ActionError({ message: r.message }))
            }
          }),
          defineAction({
            id: "flip_coin",
            label: "Flip a coin",
            description: "Flip a coin: heads or tails.",
            examples: ["flip a coin", "heads or tails", "gooi een munt op", "kop of munt"],
            params: {},
            speculative: true,
            offerAsTool: false,
            run: () => {
              const r = roll({ kind: "coin" }, homeLanguage(ctx.host.view()))
              return r.ok ? Effect.succeed({ say: r.value.spoken }) : Effect.fail(new ActionError({ message: r.message }))
            }
          })
        ]

        return {
          tools: [calculateTool, randomTool],
          actions,
          instructions: "For any arithmetic, percentage or unit or currency conversion, use calculate and say the numbers back. For dice, coins and picks, use random."
        }
      })
  })

export const calculatorModule = makeCalculator()
export { MAX_RATES }
