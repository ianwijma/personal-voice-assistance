import { dict } from "./Dict.ts"
import { guarded, isLanguage, isText, maxNumber, numberDecimals } from "./Domain.ts"
import { alt, from, many1, map, oneOf, opt, seq, tok, whole, words, type Input, type P } from "./Grammar.ts"
import { ambiguous, notUnderstood, ok, type Language, type Parsed } from "./Result.ts"
import { sliceText, tokenize } from "./Tokens.ts"

/**
 * The one number grammar per language (review round 3, decision 3). Every parser that reads a number reads it with these
 * productions, and `parseNumber` reads a phrase that is only a number with them. Supported (README, "Numbers"):
 * - digits: 0 to 999 999, no leading zero, at most two decimals; English "1,500" and "2.5", Dutch "1.500" and "2,5" (each
 *   language's separators only: "1.000" is no English number, "1,000" no Dutch one, since each is a thousand in the other);
 * - English words: "zero", 1–999 999 by British rules ("twenty five", "a hundred", "two hundred and five", "one thousand and five",
 *   "two thousand three hundred"); then optionally "point" and one or two digit words ("two point five");
 * - Dutch words: one written word ("vijfentwintig", "tweehonderd", "tweeduizend driehonderd" as the speaker writes it) or spaced parts
 *   that join into one ("vijf en twintig", "twee honderd"); then optionally "komma" and one or two digit words.
 */

const enUnits = dict<number>({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 })
const enTeens = dict<number>({ ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 })
const enTens = dict<number>({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 })
const enDigitWords = dict<number>({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 })
const nlDigitWords = dict<number>({ nul: 0, een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9 })

const nlUnits = dict<number>({
  een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, elf: 11, twaalf: 12, dertien: 13,
  veertien: 14, vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19
})
const nlTens = dict<number>({ twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, zeventig: 70, tachtig: 80, negentig: 90 })
const nlSmall = ["een", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen"]

// ---- English words -------------------------------------------------------------------------------------------------------------------

const enBelow100: P<number> = alt(
  from(enUnits), from(enTeens), from(enTens),
  map(seq(from(enTens), from(enUnits)), ([t, u]) => t + u)
)
const enHundreds: P<number> = map(
  seq(alt(from(enUnits), map(oneOf("a"), () => 1)), words("hundred"), opt(seq(opt(words("and")), enBelow100))),
  ([h, , rest]) => h * 100 + (rest === undefined ? 0 : rest[1])
)
const enBelow1000: P<number> = alt(enBelow100, enHundreds)
/** After "thousand" the hundreds take a number word: "a thousand two hundred", not "a thousand a hundred". */
const enRestAfterThousand: P<number> = alt(enBelow100, map(
  seq(from(enUnits), words("hundred"), opt(seq(opt(words("and")), enBelow100))),
  ([h, , rest]) => h * 100 + (rest === undefined ? 0 : rest[1])
))
const enThousands: P<number> = map(
  seq(alt(enBelow1000, map(oneOf("a"), () => 1)), words("thousand"), opt(alt(map(seq(words("and"), enBelow100), ([, r]) => r), enRestAfterThousand))),
  ([t, , rest]) => t * 1000 + (rest ?? 0)
)
const enWholeWords: P<number> = alt(map(words("zero"), () => 0), enBelow1000, enThousands)

// ---- Dutch words ---------------------------------------------------------------------------------------------------------------------

/** 1–99 as one word, as it is written: "zeven", "veertien", "twintig", "vijfentwintig", "tweeentwintig" (accents removed). */
const nlBelow100Word = (w: string): number | undefined => {
  const u = nlUnits[w] ?? nlTens[w]
  if (u !== undefined) return u
  for (let k = 0; k < nlSmall.length; k++) {
    const unit = nlSmall[k]!
    if (w.startsWith(`${unit}en`)) {
      const t = nlTens[w.slice(unit.length + 2)]
      if (t !== undefined) return k + 1 + t
    }
  }
  return undefined
}
/** 1–999: below 100, or [twee … negen] "honderd" [below 100]. "eenhonderd" is not how it is written. */
const nlBelow1000Word = (w: string): number | undefined => {
  const at = w.indexOf("honderd")
  if (at < 0) return nlBelow100Word(w)
  const left = w.slice(0, at)
  const right = w.slice(at + 7)
  const l = left === "" ? 1 : nlSmall.indexOf(left) >= 1 ? nlSmall.indexOf(left) + 1 : undefined
  const r = right === "" ? 0 : nlBelow100Word(right)
  return l === undefined || r === undefined ? undefined : l * 100 + r
}
/** A Dutch whole number written as one word, 0 to 999 999: below 1000, or [below 1000 except 1] "duizend" [below 1000]. */
export const nlWholeWord = (w: string): number | undefined => {
  if (w === "nul") return 0
  const at = w.indexOf("duizend")
  if (at < 0) return w === "" ? undefined : nlBelow1000Word(w)
  const left = w.slice(0, at)
  const right = w.slice(at + 7)
  const l = left === "" ? 1 : nlBelow1000Word(left)
  const r = right === "" ? 0 : nlBelow1000Word(right)
  if (l === undefined || r === undefined || (left !== "" && l === 1)) return undefined
  return l * 1000 + r
}
/** A token that can be part of a spaced Dutch number: a number word itself, or "en" between two ("vijf en twintig"). */
const nlPart = (w: string): boolean => w === "en" || (w !== "nul" && nlWholeWord(w) !== undefined)
/** Spaced parts joined into one written number ("vijf en twintig" = "vijfentwintig", "twee honderd"), or one word. */
const nlWholeWords: P<number> = (input, at) => {
  const out: Array<{ value: number; next: number }> = []
  if (input.norms[at] === "nul") return [{ value: 0, next: at + 1 }]
  let joined = ""
  // No ceiling on the parts (review round 4, finding 10): the joined word must be a written number up to 999 999, and the phrase has
  // at most `maxWords` tokens; "negen honderd negen en negentig duizend negen honderd negen en negentig" is ten parts.
  for (let k = at; k < input.norms.length && nlPart(input.norms[k]!); k++) {
    joined += input.norms[k]
    if (input.norms[at] === "en" || input.norms[k] === "en") continue
    const v = nlWholeWord(joined)
    if (v !== undefined) out.push({ value: v, next: k + 1 })
  }
  return out
}

// ---- digits --------------------------------------------------------------------------------------------------------------------------

const digitPattern: Record<Language, RegExp> = {
  en: /^(0|[1-9][0-9]{0,5}|[1-9][0-9]{0,2},[0-9]{3})(?:\.([0-9]{1,2}))?$/,
  nl: /^(0|[1-9][0-9]{0,5}|[1-9][0-9]{0,2}\.[0-9]{3})(?:,([0-9]{1,2}))?$/
}
/** A number written with digits in `language`'s convention, or `undefined`. */
export const digitValue = (token: string, language: Language): number | undefined => {
  const m = digitPattern[language].exec(token)
  if (m === null) return undefined
  const whole = Number(m[1]!.replace(/[.,]/g, ""))
  if (whole > maxNumber) return undefined
  return m[2] === undefined ? whole : Number(`${whole}.${m[2]}`)
}
const digitNumber = (language: Language): P<number> => tok((w, t) => (t.kind === "digits" ? digitValue(w, language) : undefined))

// ---- the grammar ---------------------------------------------------------------------------------------------------------------------

const decimalsAfter = (whole: P<number>, mark: string, digits: Readonly<Record<string, number | undefined>>): P<number> =>
  map(seq(whole, words(mark), many1(from(digits), undefined, numberDecimals)), ([w, , ds]) => Number(`${w}.${ds.join("")}`))

const wordNumbers: Record<Language, P<number>> = {
  en: alt(enWholeWords, decimalsAfter(enWholeWords, "point", enDigitWords)),
  nl: alt(nlWholeWords, decimalsAfter(nlWholeWords, "komma", nlDigitWords))
}

/** A number without a sign, in digits or words: 0 to 999 999.99. */
export const unsignedNumber: Record<Language, P<number>> = {
  en: alt(digitNumber("en"), wordNumbers.en),
  nl: alt(digitNumber("nl"), wordNumbers.nl)
}
/** A whole number from `min` to `max`, in digits or words. */
export const wholeNumber = (language: Language, min: number, max: number): P<number> =>
  map(unsignedNumber[language], (v) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined))
/** A number word in words only (no digits): for clock times, which have their own digit forms. */
export const wordNumber = (language: Language, min: number, max: number): P<number> =>
  map(language === "en" ? enWholeWords : nlWholeWords, (v) => (v >= min && v <= max ? v : undefined))

const minusWord: Record<Language, string> = { en: "minus", nl: "min" }
/** A number with an optional sign word: "minus five", "min 2,5". "minus zero" is not a number. */
export const signedNumber: Record<Language, P<number>> = {
  en: alt(unsignedNumber.en, map(seq(words(minusWord.en), unsignedNumber.en), ([, v]) => (v > 0 ? -v : undefined))),
  nl: alt(unsignedNumber.nl, map(seq(words(minusWord.nl), unsignedNumber.nl), ([, v]) => (v > 0 ? -v : undefined)))
}

// ---- amounts: a number with the spoken fractions quantities and durations use ---------------------------------------------------

const andAHalf: Record<Language, P<string>> = { en: words("and", "a", "half"), nl: alt(words("en", "een", "half"), words("en", "een", "halve")) }
/** "two and a half", "twee en een half", "tweeënhalf", "anderhalf", "een half", "een kwart", "driekwart": an amount said with a fraction. */
export const amountNumber: Record<Language, P<number>> = {
  en: alt(
    unsignedNumber.en,
    map(seq(wholeNumber("en", 1, maxNumber), andAHalf.en), ([n]) => n + 0.5)
  ),
  nl: alt(
    unsignedNumber.nl,
    map(seq(wholeNumber("nl", 1, maxNumber), andAHalf.nl), ([n]) => n + 0.5),
    map(oneOf("anderhalf", "anderhalve"), () => 1.5),
    tok((w) => {
      const m = /^(.+)enhalf$/.exec(w)
      const n = m === null ? undefined : nlWholeWord(m[1]!)
      return n !== undefined && n >= 1 ? n + 0.5 : undefined
    }),
    map(alt(words("een", "half"), words("een", "halve")), () => 0.5),
    map(words("een", "kwart"), () => 0.25),
    map(alt(words("driekwart"), words("drie", "kwart")), () => 0.75)
  )
}
/** English fractions said before an article: "half a kilo", "half an hour", "a quarter of an hour", "three quarters of an hour". */
export const enFractionBeforeArticle: P<number> = alt(
  map(words("half"), () => 0.5),
  map(words("a", "quarter", "of"), () => 0.25),
  map(words("three", "quarters", "of"), () => 0.75)
)

/**
 * A phrase that is only a number, in `language`'s grammar (see the top of this file), with an optional sign word ("minus five",
 * "min vijf"): `ok` with the number, else `not-understood`. "five five", "5 five", "one thousand two thousand", "twenty thirty",
 * "1e3", three decimals, a million and "2,5" in English are not numbers.
 */
export const parseNumber: (text: string, language: Language) => Parsed<number> = guarded((text: string, language: Language): Parsed<number> => {
  if (!isText(text) || !isLanguage(language)) return notUnderstood
  const toks = tokenize(text)
  if (toks === undefined || toks.length === 0) return notUnderstood
  const input: Input = { text, toks, norms: toks.map((t) => t.norm) }
  const values = whole(signedNumber[language], input, String)
  const said = sliceText(text, toks, 0, toks.length)
  if (values.length === 0) return notUnderstood
  return values.length === 1 ? ok(values[0]!, said) : ambiguous(values, said, "The words read as more than one number")
}, notUnderstood)
