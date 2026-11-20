// The calculator module: `calculate` (arithmetic, percentages, units) and `random`, bounded as engine.ts says. It needs
// no network and stores nothing. Currencies are not converted in this version: asking for one says so.
import { ActionError, defineAction, defineModule, makeTool, Param, Setting, ToolError } from "@pva/core"
import { speakList } from "@pva/language"
import { defineTexts, homeLanguage, type Language, say } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { randomInt } from "node:crypto"
import { type CalcFailure, type CalcSuccess, type Engine, makeEngine } from "./engine.ts"
import { spokenNumber, spokenSum, spokenUnit } from "./spoken.ts"

export const texts = defineTexts({
  en: {
    empty: "What should I work out?",
    tooLong: "That is too long for me to work out. Try a shorter sum.",
    tooComplex: "That sum is too complicated for me. Try it in smaller steps.",
    notAllowed: "I can only do arithmetic, percentages and unit conversions.",
    currency: "I can't convert currencies yet.",
    syntax: "I couldn't understand that sum.",
    unknownUnit: "I don't know the unit {name}.",
    mismatch: "Those two can't be converted into each other.",
    noRealAnswer: "That has no real answer.",
    tooLarge: "That number is too large for me to work out.",
    answer: "{about}{number}{unit}",
    percentAnswer: "{about}{number} percent",
    sumIs: "{sum} is {answer}.",
    answerIs: "The answer is {answer}.",
    coinHeads: "heads",
    coinTails: "tails",
    total: "Total {total}.",
    diceOne: "A {value}.",
    needOptions: "Give me at least two things to pick from.",
    badRange: "The smallest number has to be lower than the largest.",
    rangeTooWide: "That range is too wide."
  },
  nl: {
    empty: "Wat moet ik uitrekenen?",
    tooLong: "Dat is te lang voor mij om uit te rekenen. Probeer een kortere som.",
    tooComplex: "Die som is te ingewikkeld voor mij. Probeer het in kleinere stappen.",
    notAllowed: "Ik kan alleen rekenen, procenten uitrekenen en eenheden omrekenen.",
    currency: "Valuta kan ik nog niet omrekenen.",
    syntax: "Ik begreep die som niet.",
    unknownUnit: "Ik ken de eenheid {name} niet.",
    mismatch: "Die twee kan ik niet in elkaar omrekenen.",
    noRealAnswer: "Daar is geen echt antwoord op.",
    tooLarge: "Dat getal is te groot voor mij om uit te rekenen.",
    answer: "{about}{number}{unit}",
    percentAnswer: "{about}{number} procent",
    sumIs: "{sum} is {answer}.",
    answerIs: "Het antwoord is {answer}.",
    coinHeads: "kop",
    coinTails: "munt",
    total: "Totaal {total}.",
    diceOne: "Een {value}.",
    needOptions: "Geef me minstens twee dingen om uit te kiezen.",
    badRange: "Het kleinste getal moet lager zijn dan het grootste.",
    rangeTooWide: "Dat bereik is te groot."
  }
})

const settings = {
  cup: Setting.choice({
    label: "Size of a cup",
    description: "What \"cup\" means in a conversion.",
    options: [{ value: "metric", label: "Metric cup, 250 ml" }, { value: "us", label: "US cup, 236.6 ml" }],
    default: "metric"
  })
}

const failureText = (failure: CalcFailure, lang: Language): string => {
  switch (failure.reason) {
    case "empty": return say(texts, lang, "empty")
    case "too-long": return say(texts, lang, "tooLong")
    case "too-complex": return say(texts, lang, "tooComplex")
    case "not-allowed": return say(texts, lang, "notAllowed")
    case "syntax": return say(texts, lang, "syntax")
    case "mismatch": return say(texts, lang, "mismatch")
    case "no-real-answer": return say(texts, lang, "noRealAnswer")
    case "too-large": return say(texts, lang, "tooLarge")
    case "currency": return say(texts, lang, "currency")
    case "unknown-unit":
      return failure.detail === undefined ? say(texts, lang, "syntax") : say(texts, lang, "unknownUnit", { name: failure.detail })
  }
}

/** The answer for the ear: the number rounded for speaking ("about" when that is not the value), its unit. Only this is rounded. */
const spokenAnswer = (result: CalcSuccess, lang: Language): string => {
  const number = spokenNumber(result.value, lang)
  const about = number.about || result.approximate ? (lang === "nl" ? "ongeveer " : "about ") : ""
  if (result.percent?.kind === "what") return say(texts, lang, "percentAnswer", { about, number: number.text })
  const unit = result.unit === undefined ? "" : ` ${spokenUnit(result.unit, result.value, lang)}`
  return say(texts, lang, "answer", { about, number: number.text, unit })
}

export const makeCalculator = () =>
  defineModule({
    apiVersion: 2,
    id: "calculator",
    name: "Calculator",
    description: "Arithmetic, percentages and units, worked out exactly, and random picks.",
    enabledByDefault: false,
    settings,
    shared: (ctx) =>
      Effect.gen(function*() {
        // The library is large: loaded here, when the module is demanded, never at the app's start.
        const { create, all } = yield* Effect.promise(() => import("mathjs"))
        const engine = makeEngine(create(all!), { cupMl: ctx.settings.cup === "us" ? 236.588 : 250 })
        // Warm the library up once, so the first spoken sum costs what the next does.
        for (const sum of ["1 + 2 * 3", "2 ^ 10", "5 cm to inch", "17% of 340", "sqrt(16)"]) engine.evaluate(sum)
        return { value: { engine } }
      }),
    start: (ctx) =>
      Effect.sync(() => {
        const calculate = (expression: string) =>
          Effect.sync(() => {
            const lang = homeLanguage(ctx.host.view())
            const { engine } = ctx.shared as { engine: Engine }
            const result = engine.evaluate(expression)
            if (!result.ok) return { ok: false as const, message: failureText(result, lang) }
            const answer = spokenAnswer(result, lang)
            return {
              ok: true as const,
              result,
              answer,
              value: {
                expression: result.expression,
                value: result.value,
                ...(result.unit !== undefined ? { unit: result.unit } : {}),
                ...(result.approximate ? { approximate: true } : {}),
                spoken: answer
              }
            }
          })

        const calculateTool = makeTool({
          name: "calculate",
          description:
            "Work out arithmetic exactly, with units. Takes one expression such as \"17% of 340\", \"(3 + 4) * 12.5\", \"sqrt(144)\", \"500 ml to cup\", \"5 cm to inch\" or \"60 mph to km/h\". It does not convert currencies. " +
            "Operators + - * / ^ % and ! ; functions sqrt cbrt abs round floor ceil min max sin cos tan log exp; constants pi e. Always use this instead of working a sum out yourself, and say the numbers you worked with back to the person. " +
            "value is the computed value (an integer exactly; approximate: true when it could not be exact); spoken is it rounded for the ear.",
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

        const sayOf = (lang: Language, values: ReadonlyArray<string>) => speakList(values, lang) ?? values.join(", ")

        const roll = (
          input: { readonly kind: "coin" | "dice" | "number" | "pick"; readonly count?: number; readonly sides?: number; readonly min?: number; readonly max?: number; readonly options?: ReadonlyArray<string> },
          lang: Language
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
            description: "Work out arithmetic, a percentage or a unit conversion, and say the sum back with the answer.",
            examples: ["what is 17 percent of 340", "calculate 12 times 15", "500 ml to cups", "wat is 17 procent van 340", "bereken 12 keer 15"],
            params: { expression: Param.text({ label: "The sum", after: ["calculate", "what is", "what's", "bereken", "wat is", "hoeveel is"], maxWords: 14 }) },
            speculative: true,
            offerAsTool: false,
            run: ({ expression }) =>
              Effect.flatMap(calculate(expression), (r) => {
                if (!r.ok) return Effect.fail(new ActionError({ message: r.message }))
                // No model follows an action: the sum is said back first, so a misheard number is audible.
                const lang = homeLanguage(ctx.host.view())
                const sum = spokenSum(r.result.tree, lang, r.result.percent)
                return Effect.succeed({ say: sum === undefined ? say(texts, lang, "answerIs", { answer: r.answer }) : say(texts, lang, "sumIs", { sum, answer: r.answer }) })
              })
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
          instructions: "For any arithmetic, percentage or unit conversion, use calculate and say the numbers back. For dice, coins and picks, use random."
        }
      })
  })

export const calculatorModule = makeCalculator()
