import {
  choiceAnswer,
  type DecisionAnswer,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResponse,
  defineDecider,
  normalizeWord,
  phoneticWord,
  type Word,
  words
} from "@pva/core"
import { Effect } from "effect"

/**
 * The offline keyword decider (docs/AGENTS-AND-INTENTS.md §3.7): deterministic,
 * local, no settings, sub-millisecond. It answers the same typed questions as
 * Jev by overlapping words, using each question's machine-readable `role`.
 * Good enough to try the intent path and to test it; not a classifier.
 *
 * - `action`: each option is scored by the utterance's content words (stop
 *   words removed, light stemming, English and Dutch) found in its criterion
 *   (label, description, examples), each word weighted by how few actions
 *   share it; sentences of a description that start with "Not" are ignored
 *   (they name what the action is NOT for). An utterance close to one of the
 *   action's examples (same content words, Jaccard ≥ 0.75, parameter values
 *   such as room names left out on both sides) gets a bonus. Probabilities are the scores sharpened
 *   (fourth power) and normalised, so one clearly better action stands out.
 * - `fits`: 0.85 when the best action matched two content words or one example
 *   closely, 0.5 for one word, else 0.1.
 * - `compound`: 0.8 when "and/en/then/daarna" splits the utterance into two parts
 *   whose best actions differ, else 0.05.
 * - parameter choices: an option whose label or alias appears in the utterance
 *   (word by word, phonetic match allowed, articles skipped) gets 0.9; else uniform.
 *   Number candidates: the first one (the parser puts a number with a unit
 *   first) gets 0.7 when it carries a unit, else uniform.
 * - `stated`: 0.9 when an option of that parameter appears, else 0.1.
 * - `answers`: 0.9 when an option appears or the reply is short (≤ 4 words), else 0.2.
 * - `yes`: yes / ja / sure / doe maar / please → 0.95, no / nee / cancel → 0.05, else 0.5.
 * - `flag`: 0.5.
 */

const STOP = new Set([
  // English
  "a", "an", "the", "to", "of", "in", "at", "for", "with", "from", "by", "as", "into", "onto", "is", "are", "be", "was",
  "it", "its", "this", "that", "these", "those", "there", "here", "and", "or", "but", "so", "then", "please", "can",
  "could", "would", "will", "shall", "should", "you", "your", "me", "my", "i", "we", "us", "our", "do", "does", "did",
  "who", "hey", "hi", "just", "some", "very", "like", "want", "wanna", "let",
  "lets", "make", "get", "go", "now", "right", "also", "too", "if", "not", "no", "one", "say", "tell", "know",
  // Dutch
  "de", "het", "een", "van", "te", "op", "bij", "naar", "voor", "met", "om", "en", "of", "maar", "dan", "dat",
  "die", "dit", "deze", "er", "is", "zijn", "was", "ik", "je", "jij", "u", "mijn", "me", "mij", "we", "wij", "ons",
  "onze", "wil", "wilt", "kun", "kunt", "kan", "graag", "alsjeblieft", "even", "nu", "doe",
  "zet", "maak", "mag", "eens", "nog", "ook", "hoi", "hallo"
])

const CONJUNCTIONS = new Set(["and", "then", "en", "daarna", "dan", "also"])
const ARTICLES = new Set(["the", "a", "an", "de", "het", "een"])
const YES = new Set(["yes", "yeah", "yep", "sure", "ok", "okay", "please", "do", "ja", "jawel", "graag", "prima", "goed", "zeker", "correct", "right"])
const NO = new Set(["no", "nope", "cancel", "stop", "dont", "nee", "niet", "annuleer", "laat", "never"])
const UNIT = /(%|percent|procent|degrees?|graden|graad)/i

const CONTRACTIONS: Readonly<Record<string, string>> = { whats: "what", hows: "how", wheres: "where", whens: "when" }

/**
 * Light stemming, the same on both sides: plural s / es, Dutch plural -en, -ing, -ed.
 * Question words are kept (not stop words): "which lights are on" is a question, "lights on" a command.
 */
const stem = (word: string): string => {
  if (word in CONTRACTIONS) return CONTRACTIONS[word]!
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.length > 4 && word.endsWith("es") && /(sh|ch|x|ss)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  if (word.length > 5 && word.endsWith("en")) return word.slice(0, -2)
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2)
  return word
}

const contentWords = (text: string): Set<string> => {
  const out = new Set<string>()
  for (const w of words(text)) if (!STOP.has(w.norm)) out.add(stem(w.norm))
  return out
}

/** Criterion text without the sentences that say what an action is not for. */
const positive = (criterion: string): string => criterion.replace(/(?:^|\.\s+)Not [^.]*\.?/g, ". ")

const examplesOf = (criterion: string): Array<string> => {
  const at = criterion.indexOf("For example:")
  if (at < 0) return []
  return [...criterion.slice(at).matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
}

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 || b.size === 0) return 0
  let both = 0
  for (const x of a) if (b.has(x)) both++
  return both / (a.size + b.size - both)
}

interface ActionScore {
  readonly id: string
  readonly score: number
  readonly matched: number
  readonly closeExample: boolean
}

/** Question words weigh in the action score but do not make a sentence a command ("what is a quark"). */
const QUESTION = new Set(["what", "which", "how", "where", "when", "why", "wat", "welke", "hoe", "waar", "wanneer", "waarom"])

const scoreActions = (
  options: Readonly<Record<string, string | null>>,
  utterance: ReadonlySet<string>,
  values: {
    /** Words of every parameter value; left out of examples unless the action's own description uses them. */
    readonly every: ReadonlySet<string>
    /** Words of the values named in this utterance; left out of the utterance unless the action's own description uses them. */
    readonly named: ReadonlySet<string>
  } = { every: new Set(), named: new Set() }
): Array<ActionScore> => {
  const ids = Object.keys(options)
  const sets = ids.map((id) => {
    const criterion = options[id] ?? id
    const described = contentWords(positive(criterion.split("For example:")[0]!))
    const keep = (w: string, drop: ReadonlySet<string>) => described.has(w) || !drop.has(w)
    const examples = examplesOf(criterion).map((e) => new Set([...contentWords(e)].filter((w) => keep(w, values.every))))
    const said = new Set([...utterance].filter((w) => keep(w, values.named)))
    return { id, all: new Set([...described, ...examples.flatMap((e) => [...e])]), examples, said }
  })
  const df = new Map<string, number>()
  for (const s of sets) for (const w of s.all) df.set(w, (df.get(w) ?? 0) + 1)
  const n = Math.max(sets.length, 1)
  return sets.map((s) => {
    let score = 0
    let matched = 0
    for (const w of s.said) {
      if (!s.all.has(w)) continue
      if (!QUESTION.has(w)) matched++
      score += Math.log(1 + n / (df.get(w) ?? 1))
    }
    const closeExample = s.examples.some((ex) => jaccard(ex, s.said) >= 0.75)
    if (closeExample) score += 2
    return { id: s.id, score, matched, closeExample }
  })
}

const sharpen = (scores: ReadonlyArray<ActionScore>): Record<string, number> => {
  const powered = scores.map((s) => s.score ** 4)
  const total = powered.reduce((a, b) => a + b, 0)
  const out: Record<string, number> = {}
  scores.forEach((s, i) => {
    out[s.id] = total === 0 ? 1 / scores.length : powered[i]! / total
  })
  return out
}

/** Label and aliases of an option criterion "Living room (also called: lounge, woonkamer): …". */
const namesOf = (criterion: string): Array<string> => {
  const m = /^(.*?)(?: \(also called: (.*?)\))?(?:: .*)?$/s.exec(criterion)
  if (m === null) return [criterion]
  return [m[1]!, ...(m[2]?.split(",").map((s) => s.trim()) ?? [])].filter((s) => s.length > 0)
}

const tokens = (text: string): Array<string> => words(text).map((w: Word) => w.norm).filter((w) => !ARTICLES.has(w))

const sameWord = (a: string, b: string) => a === b || stem(a) === stem(b) || (a.length > 2 && phoneticWord(a) === phoneticWord(b))

/** Longest name of the option found in the utterance, in words (0 = not found). */
const phraseLength = (utterance: ReadonlyArray<string>, name: string): number => {
  const phrase = tokens(name)
  if (phrase.length === 0) return 0
  for (let i = 0; i + phrase.length <= utterance.length; i++) {
    if (phrase.every((p, j) => sameWord(utterance[i + j]!, p))) return phrase.length
  }
  return 0
}

/** Probabilities for a choice over named options, and whether any option was named. */
const chooseOption = (question: Extract<DecisionQuestion, { type: "choice" }>, utterance: ReadonlyArray<string>) => {
  const ids = Object.keys(question.options)
  const isCandidates = ids.includes("none") && ids.every((id) => id === "none" || /^c\d+$/.test(id))
  const probabilities: Record<string, number> = {}
  if (isCandidates) {
    const first = question.options["c0"] ?? ""
    const lead = UNIT.test(first) ? 0.7 : 1 / ids.length
    for (const id of ids) probabilities[id] = id === "c0" ? lead : (1 - lead) / (ids.length - 1)
    return { probabilities, named: true, matchedNames: [] as Array<string> }
  }
  const matchedNames: Array<string> = []
  const lengths = ids.map((id) => {
    let longest = 0
    for (const name of [...namesOf(question.options[id] ?? id), id]) {
      const length = phraseLength(utterance, name)
      if (length > 0) matchedNames.push(name)
      longest = Math.max(longest, length)
    }
    return longest
  })
  const best = Math.max(0, ...lengths)
  if (best === 0) {
    for (const id of ids) probabilities[id] = 1 / ids.length
    return { probabilities, named: false, matchedNames }
  }
  const winners = lengths.filter((l) => l === best).length
  const rest = ids.length - winners
  ids.forEach((id, i) => {
    probabilities[id] = lengths[i] === best ? (rest === 0 ? 1 / winners : 0.9 / winners) : 0.1 / rest
  })
  return { probabilities, named: true, matchedNames }
}

/** Answer a request by keywords. Pure. */
export const decideByKeywords = (request: DecisionRequest): DecisionResponse => {
  const utterance = request.state.utterance
  const utteranceWords = contentWords(utterance)
  const utteranceTokens = tokens(utterance)
  const answers: Record<string, DecisionAnswer> = {}
  const noul = (value: number): DecisionAnswer => ({ type: "noul", value })

  // Parameter questions by "action/param", for `stated` and `answers`.
  const named = new Map<string, boolean>()
  const choices = new Map<string, ReturnType<typeof chooseOption>>()
  for (const [name, q] of Object.entries(request.questions)) {
    if (q.type === "choice" && q.role.kind === "param") {
      const result = chooseOption(q, utteranceTokens)
      choices.set(name, result)
      named.set(`${q.role.action}/${q.role.param}`, (named.get(`${q.role.action}/${q.role.param}`) ?? false) || result.named)
    }
  }

  // Words that name a parameter value ("kitchen", "living room") say nothing about which action is meant.
  const namedValues = new Set([...choices.values()].flatMap((c) => c.matchedNames.flatMap((n) => [...contentWords(n)])))
  // In examples, parameter values are left out ("… in de woonkamer" is as good an example for the kitchen).
  const everyValue = new Set(Object.values(request.questions).flatMap((q) =>
    q.type === "choice" && q.role.kind === "param" ? Object.entries(q.options).flatMap(([id, c]) => namesOf(c ?? id).flatMap((n) => [...contentWords(n)])) : []
  ))
  const actionQuestion = request.questions["action"]
  const scores = actionQuestion?.type === "choice" ? scoreActions(actionQuestion.options, utteranceWords, { every: everyValue, named: namedValues }) : []
  const best = scores.reduce<ActionScore | undefined>((b, s) => (b === undefined || s.score > b.score ? s : b), undefined)

  for (const [name, q] of Object.entries(request.questions)) {
    switch (q.role.kind) {
      case "action":
        answers[name] = choiceAnswer(sharpen(scores))
        break
      case "fits":
        answers[name] = noul(best === undefined ? 0.1 : best.matched >= 2 || best.closeExample ? 0.85 : best.matched === 1 ? 0.5 : 0.1)
        break
      case "compound": {
        let compound = false
        if (actionQuestion?.type === "choice") {
          const ws = words(utterance)
          const cuts = ws.flatMap((w, i) => (CONJUNCTIONS.has(w.norm) && i > 0 && i < ws.length - 1 ? [i] : []))
          for (const cut of cuts) {
            const left = contentWords(utterance.slice(0, ws[cut]!.start))
            const right = contentWords(utterance.slice(ws[cut]!.end))
            const top = (part: Set<string>) => {
              const s = scoreActions(actionQuestion.options, part, { every: everyValue, named: namedValues }).filter((x) => x.matched > 0)
              return s.length === 0 ? undefined : s.reduce((a, b) => (b.score > a.score ? b : a)).id
            }
            const l = top(left)
            const r = top(right)
            if (l !== undefined && r !== undefined && l !== r) compound = true
          }
        }
        answers[name] = noul(compound ? 0.8 : 0.05)
        break
      }
      case "param":
        if (q.type === "choice") answers[name] = choiceAnswer(choices.get(name)!.probabilities)
        else answers[name] = noul(0.5)
        break
      case "stated":
        answers[name] = noul(named.get(`${q.role.action}/${q.role.param}`) === true ? 0.9 : 0.1)
        break
      case "flag":
        answers[name] = noul(0.5)
        break
      case "answers": {
        const answer = request.questions["pending/answer"]
        const optionNamed = answer !== undefined && choices.get("pending/answer")?.named === true
        const yesNo = request.questions["pending/yes"] !== undefined && words(utterance).some((w) => YES.has(w.norm) || NO.has(w.norm))
        answers[name] = noul(optionNamed || yesNo || words(utterance).length <= 4 ? 0.9 : 0.2)
        break
      }
      case "yes": {
        const ws = words(utterance).map((w) => w.norm)
        const phrase = ws.join(" ")
        answers[name] = noul(
          ws.some((w) => NO.has(w)) ? 0.05 : ws.some((w) => YES.has(w)) || phrase.includes("doe maar") ? 0.95 : 0.5
        )
        break
      }
    }
  }
  return { answers, model: "keywords" }
}

/** The keyword decider as a provider (for tests and direct use). */
export const makeKeywordDecider = (): DecisionProvider => ({
  id: "keywords",
  name: "Offline keywords",
  location: "local",
  decide: (request) => Effect.sync(() => decideByKeywords(request))
})

/** The keyword decider as a module (enabled by default: it makes the intent path work without a key). */
export const keywordsDecider = defineDecider({
  id: "keywords",
  name: "Offline keywords",
  description: "Recognises commands by their words, on this machine. Works without any key; less exact than TypeSafe Jev.",
  enabledByDefault: true,
  start: () => Effect.succeed({ location: "local" as const, decide: (request: DecisionRequest) => Effect.sync(() => decideByKeywords(request)) })
})

/** Exposed for tests. */
export const keywordInternals = { contentWords, stem, namesOf, normalizeWord }
