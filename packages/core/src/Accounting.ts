import type { ActionParam, ParamOption, RegisteredAction } from "./Actions.ts"
import { defaultIntentWords, type IntentWords, isNegated } from "./IntentWords.ts"
import { isNumericWord } from "./NumberWords.ts"
import { phoneticWord, type Word, words } from "./TextMatching.ts"
import { IGNORABLE_OUTSIDE_NUMBERS, type Mark } from "./Utterance.ts"
import { numericSpans } from "./ValueParsing.ts"

/**
 * "Act only on what is fully accounted for" (docs/AGENTS-AND-INTENTS.md,
 * "Review fixes", third and fourth rounds). The intent path may run an action
 * with side effects only when every part of what was said is explained, each
 * part for exactly one purpose:
 *
 * - every CHARACTER: the canonical text (`Utterance.ts`) keeps only significant
 *   marks; each must be consumed by the number span it belongs to, by the final
 *   "?" of a polite question, by the name of the option it is part of, or be the
 *   comma that is ignorable outside numbers;
 * - every SPAN has one role (`assignRoles`): the name of an option, a number,
 *   text taken, the action's own words, a free filler or the request
 *   construction. Longest and most specific first; a span left with two
 *   possible roles is ambiguous (its parameters are asked for);
 * - the sentence is a REQUEST: an opening ("hey", "ok"), a request construction
 *   ("can you …", "I'd like …", "kun je …", or none: an imperative), manner words
 *   only at the edges, politeness only at the end, free fillers anywhere, and a
 *   body made of the action's words and its values, with the action's verb (if
 *   said) before any other content word. A statement ("I like the kitchen lights
 *   on"), a question about the world ("will the kitchen lights turn on") or
 *   reported speech does not parse, so it is handed on.
 *
 * Words inside a value (a number span, a name of an option) are explained only
 * by being that value: "the attic 40" names no option, "the bedroom" names
 * another one, "3 lights … 40 percent" has a number no parameter takes. A
 * negation or prohibition is never explained.
 *
 * Pure, local string work on one sentence: microseconds.
 */

/** Words `[from, to)` of an utterance. */
export interface WordSpan {
  readonly from: number
  readonly to: number
  /**
   * The span's last word carries a suffix the value's name does not have: a possessive
   * ("the bedroom's") or a bare plural that may be one with its apostrophe dropped ("the bedrooms").
   * Like an article or a placing preposition it is a dependent form (review round 6): it must be
   * followed by what it possesses, a content word ("the bedroom's lights"); at the end, or before a
   * filler, closer or manner word, the request is unfinished.
   */
  readonly possessive?: true
}

const CONTRACTIONS: Readonly<Record<string, string>> = { whats: "what", hows: "how", wheres: "where", whens: "when", thats: "that", its: "it" }

/**
 * Light stemming, the same on both sides: plural / third person -s, -es after a
 * sibilant, -ies. Nothing else (review round 7): not -ing and -ed (round 4:
 * "turning on the kitchen lights" and "the kitchen lights turned on" are not the
 * imperative "turn on …"), and not -en or -er, which make a different word of
 * another ("listen" is not "list"). Dutch forms an action needs ("zetten",
 * "lichten") are declared by the module in its label, description or examples.
 */
export const stemWord = (word: string): string => {
  if (word in CONTRACTIONS) return CONTRACTIONS[word]!
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.length > 4 && /(sh|ch|x|ss)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}

const ARTICLES = new Set(["the", "a", "an", "de", "het", "een"])

/**
 * Words that build sentences rather than name what to do: conjunctions, subordinators,
 * pronouns, auxiliaries and modals (English and Dutch). They are never part of an
 * action's vocabulary, even when its description uses them ("…, one lamp, or every
 * light"): what they do in a request is the request construction's business
 * (positional, `IntentWords`), so "turn on the kitchen lights or", "it is on" or
 * "will the lights turn on" are not explained by a description.
 */
export const STRUCTURAL_WORDS: ReadonlySet<string> = new Set([
  "and", "or", "but", "nor", "if", "when", "whenever", "while", "unless", "until", "because", "since", "so", "then", "than", "as",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "its", "his", "their", "your", "this", "that", "these", "those",
  "is", "are", "am", "was", "were", "be", "been", "being", "will", "would", "can", "could", "shall", "should", "may", "might", "must",
  "do", "does", "did", "have", "has", "had", "what", "which", "who", "whom", "whose", "where", "why", "how",
  "en", "of", "maar", "als", "wanneer", "tenzij", "totdat", "omdat", "dan", "dat", "die", "dit", "deze",
  "ik", "jij", "je", "hij", "zij", "ze", "wij", "we", "jullie", "u", "hem", "haar", "hen", "hun", "mij", "jou",
  "ben", "bent", "zijn", "waren", "wordt", "worden", "werd", "zal", "zult", "zullen", "zou", "zouden", "kan", "kun", "kunt", "kunnen",
  "wil", "wilt", "willen", "mag", "moet", "moeten", "heb", "hebt", "heeft", "hebben", "had", "wat", "welke", "wie", "waar", "waarom", "hoe"
])

/** A word with its comparison keys, computed once. */
interface Keyed {
  readonly norm: string
  readonly stem: string
  readonly phon: string
  /** Said with a possessive suffix and its apostrophe ("bedroom's", "kids'"); `norm` has no apostrophe ("bedrooms", "kids"). */
  readonly poss: boolean
}
/**
 * Phonetic keys only for words of plain letters (review round 5): `phoneticWord` drops every
 * other character, so "t٠wo" would sound like "two" with its digit unexplained.
 */
const phonOf = (norm: string) => (norm.length > 2 && /^[a-z]+$/.test(norm) ? phoneticWord(norm) : "")
const keyed = (norm: string, possessive = false): Keyed => ({ norm, stem: stemWord(norm), phon: phonOf(norm), poss: possessive })

/**
 * `said` is a plural of the name word `name` (review round 6): -s, -es after a sibilant, -ies for
 * a final consonant + y ("kitchens", "boxes", "nurseries"; Dutch "keukens", "kamers"). Nothing
 * else: a stem match must never discard a suffix with a meaning of its own. Not -en, -er, -ing,
 * -ed or -je ("wooden" is not "wood", "listen" not "list", "lampje" not "lamp", "kitchener" not
 * "kitchen"); Dutch -en plurals ("lampen") therefore name nothing, as do cut-off forms.
 */
const isPluralOf = (said: string, name: string): boolean =>
  said === `${name}s` || (/(s|sh|ch|x|z)$/.test(name) && said === `${name}es`) || (/[^aeiou]y$/.test(name) && said === `${name.slice(0, -1)}ies`)

/** 0: no match; 1: the word itself, or by sound; 2: a DEPENDENT form of it (a possessive, or a bare plural). */
type NameMatch = 0 | 1 | 2
const plainMatch = (said: string, saidPhon: string, name: Keyed): NameMatch =>
  said === name.norm ? 1 : isPluralOf(said, name.norm) ? 2 : saidPhon !== "" && saidPhon === name.phon ? 1 : 0

/**
 * How `said` names the word `name` of an option (review round 6; was: same word, same sound or
 * same stem). The same word or the same sound names it. A plural names it as a DEPENDENT form:
 * bare, it may be a possessive whose apostrophe the recogniser dropped ("the bedrooms lights").
 * A word said with a possessive suffix ("bedroom's") names it only through its base, and also as a
 * dependent form — unless the name itself has that very possessive ("Kids' room", "Mary's").
 */
const nameMatch = (said: Keyed, name: Keyed): NameMatch => {
  // "bedroom's" (norm "bedrooms") is the plural form of "bedroom" with an apostrophe; "kids'" is "kids".
  if (said.poss && !(name.poss && said.norm === name.norm)) return plainMatch(said.norm, said.phon, name) === 0 ? 0 : 2
  if (said.poss) return 1
  return plainMatch(said.norm, said.phon, name)
}
const namesWord = (said: Keyed, name: Keyed): boolean => nameMatch(said, name) !== 0

/** A word of an option's name; `article`: the name has an article right before it ("Lamp in the hall": hall). */
interface NameWord extends Keyed {
  readonly article: boolean
}
/** Names of an option as keyed word lists, articles left out ("The whole house" → whole house). Cached per option. */
const nameCache = new WeakMap<ParamOption, ReadonlyArray<ReadonlyArray<NameWord>>>()
const namesOf = (option: ParamOption): ReadonlyArray<ReadonlyArray<NameWord>> => {
  let names = nameCache.get(option)
  if (names === undefined) {
    names = [option.label, ...(option.aliases ?? [])]
      .map((name) => {
        const out: Array<NameWord> = []
        let article = false
        for (const w of words(name)) {
          if (ARTICLES.has(w.norm)) article = true
          else {
            out.push({ ...keyed(w.norm, w.possessive === true), article })
            article = false
          }
        }
        return out
      })
      .filter((t) => t.length > 0)
    nameCache.set(option, names)
  }
  return names
}
/** The punctuation an option's names contain ("Room #2", "Kids' room"): the only marks its mention may consume. */
const markCache = new WeakMap<ParamOption, ReadonlySet<string>>()
const marksOfOption = (option: ParamOption): ReadonlySet<string> => {
  let marks = markCache.get(option)
  if (marks === undefined) {
    marks = new Set([option.label, ...(option.aliases ?? [])].join(" ").replace(/[\p{L}\p{N}\s]/gu, ""))
    markCache.set(option, marks)
  }
  return marks
}
const utteranceCache = new WeakMap<ReadonlyArray<Word>, ReadonlyArray<Keyed>>()
const keyedWords = (ws: ReadonlyArray<Word>): ReadonlyArray<Keyed> => {
  let out = utteranceCache.get(ws)
  if (out === undefined) {
    out = ws.map((w) => keyed(w.norm, w.possessive === true))
    utteranceCache.set(ws, out)
  }
  return out
}

/** Where an option's name is said (`possessive`: it ends in a dependent form, see `WordSpan`). */
export interface Mention extends WordSpan {
  readonly option: ParamOption
}

/**
 * Every place an option is named in `ws`: label or alias, word by word (same
 * word, same stem, or same sound; articles in between skipped). All matches,
 * overlapping ones included (`assignRoles` decides between them).
 */
export const allOptionMentions = (ws: ReadonlyArray<Word>, options: ReadonlyArray<ParamOption>): Array<Mention> => {
  const said = keyedWords(ws)
  const found: Array<Mention> = []
  for (const option of options) {
    for (const name of namesOf(option)) {
      const first = name[0]!
      for (let i = 0; i < said.length; i++) {
        if (!namesWord(said[i]!, first)) continue
        let k = i + 1
        let matched = 1
        let last: NameMatch = nameMatch(said[i]!, first)
        // An article may be said, or left out, only where the name has one ("lamp in hall"; not "forty the degrees lamp").
        let skipped = false
        while (matched < name.length && k < said.length) {
          const how = nameMatch(said[k]!, name[matched]!)
          if (how !== 0) {
            matched++
            last = how
            skipped = false
          } else if (ARTICLES.has(said[k]!.norm) && name[matched]!.article && !skipped) skipped = true
          else break
          k++
        }
        if (matched === name.length && !found.some((f) => f.option === option && f.from === i && f.to === k)) {
          found.push(last === 2 ? { option, from: i, to: k, possessive: true } : { option, from: i, to: k })
        }
      }
    }
  }
  return found
}

/**
 * Mentions a longer option name SHADOWS (review round 5): option B's name contains A's name and
 * every other content word of B's name is said too, outside A's mention ("the lamp in in the hall",
 * "the desk to lamp", "the lamp desk"). A broken longer name must not fall back to the shorter
 * name inside it: each such mention gets B as a second candidate over the same words, so the
 * span is ambiguous and the parameter is asked for. `filler`: words that need not be said ("in").
 */
export const shadowingOptions = (
  ws: ReadonlyArray<Word>,
  mention: Mention,
  options: ReadonlyArray<ParamOption>,
  filler: ReadonlySet<string>
): Array<ParamOption> => {
  const said = keyedWords(ws)
  const inner = said.slice(mention.from, mention.to).filter((w) => !ARTICLES.has(w.norm))
  const out: Array<ParamOption> = []
  for (const other of options) {
    if (other === mention.option) continue
    for (const name of namesOf(other)) {
      if (name.length <= inner.length) continue
      const at = name.findIndex((_, i) => inner.every((w, k) => name[i + k] !== undefined && namesWord(w, name[i + k]!)))
      if (at < 0) continue
      const rest = name.filter((_, i) => i < at || i >= at + inner.length).filter((w) => !filler.has(w.norm))
      const elsewhere = (w: Keyed) => said.some((x, i) => (i < mention.from || i >= mention.to) && namesWord(x, w))
      if (rest.length > 0 && rest.every(elsewhere)) {
        out.push(other)
        break
      }
    }
  }
  return out
}

/** `allOptionMentions` with overlaps removed, the longest names first (one parameter on its own). */
export const optionMentions = (ws: ReadonlyArray<Word>, options: ReadonlyArray<ParamOption>): Array<Mention> => {
  const found = allOptionMentions(ws, options)
  found.sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from)
  const taken: Array<Mention> = []
  for (const m of found) if (!taken.some((t) => m.from < t.to && t.from < m.to)) taken.push(m)
  return taken.sort((a, b) => a.from - b.from)
}

// ---------------------------------------------------------------------------
// Roles: each span of the sentence is used for exactly one purpose.

/** A span that may fill a role: a parameter's option name (`role` = parameter name), or a number (`role` = NUMBER). */
export interface RoleCandidate extends WordSpan {
  readonly role: string
  readonly option?: ParamOption
}
/** The role of number spans in `assignRoles`. */
export const NUMBER_ROLE = "#number"

/** A span with two possible roles (equal-length or partial overlap): none of them may use it; its parameters are asked for. */
export interface AmbiguousSpan extends WordSpan {
  readonly roles: ReadonlySet<string>
}

export interface Roles {
  /** Candidates that keep their role, in order of position. */
  readonly taken: ReadonlyArray<RoleCandidate>
  readonly ambiguous: ReadonlyArray<AmbiguousSpan>
}

const overlaps = (a: WordSpan, b: WordSpan) => a.from < b.to && b.from < a.to
const contains = (outer: WordSpan, inner: WordSpan) => outer.from <= inner.from && inner.to <= outer.to
const lengthOf = (s: WordSpan) => s.to - s.from

/**
 * Assign each span one role, the longest first: a span inside a strictly longer one
 * is consumed by it ("room two" names the room, so its "two" is not a number; "two
 * hundred" is a number, so its "two" names nothing). The same option found twice
 * over the same words is one candidate. Any other overlap (two different options or
 * roles over the same words, or two spans that cross) leaves every span involved
 * ambiguous, and anything overlapping an ambiguous span is ambiguous too.
 */
export const assignRoles = (candidates: ReadonlyArray<RoleCandidate>): Roles => {
  const sorted = [...candidates].sort((a, b) => lengthOf(b) - lengthOf(a) || a.from - b.from)
  const taken: Array<RoleCandidate> = []
  const ambiguous: Array<{ from: number; to: number; roles: Set<string> }> = []
  const markAmbiguous = (span: WordSpan, roles: ReadonlyArray<string>) => {
    const hit = ambiguous.find((a) => overlaps(a, span))
    if (hit === undefined) ambiguous.push({ from: span.from, to: span.to, roles: new Set(roles) })
    else {
      hit.from = Math.min(hit.from, span.from)
      hit.to = Math.max(hit.to, span.to)
      for (const r of roles) hit.roles.add(r)
    }
  }
  for (const c of sorted) {
    if (ambiguous.some((a) => overlaps(a, c))) {
      markAmbiguous(c, [c.role])
      continue
    }
    const hits = taken.filter((t) => overlaps(t, c))
    if (hits.length === 0) {
      taken.push(c)
      continue
    }
    const same = (t: RoleCandidate) => t.role === c.role && t.option === c.option && t.from === c.from && t.to === c.to
    if (hits.every((t) => same(t) || (contains(t, c) && lengthOf(t) > lengthOf(c)))) continue
    for (const t of hits) taken.splice(taken.indexOf(t), 1)
    markAmbiguous({ from: Math.min(c.from, ...hits.map((h) => h.from)), to: Math.max(c.to, ...hits.map((h) => h.to)) }, [c.role, ...hits.map((h) => h.role)])
  }
  return { taken: taken.sort((a, b) => a.from - b.from), ambiguous }
}

// ---------------------------------------------------------------------------
// Vocabulary

/** Description text without the sentences that say what an action is not for ("Not for dimming: …"). */
const positive = (description: string): string => description.replace(/(?:^|(?<=[.!?;]\s))Not [^.]*\.?/g, " ")

/** Stems of the words of `text` that are not inside a number ("dim to 40 percent" → dim, to, percent). */
const textStems = (text: string, keepNumbers = false): Array<string> => {
  const ws = words(text)
  const spans = keepNumbers ? [] : numericSpans(text, ws)
  return ws.filter((_, i) => !spans.some((s) => i >= s.from && i < s.to)).map((w) => stemWord(w.norm))
}

/** The words an action explains by itself (`vocabulary`) and the verbs among them that must come first (`verbs`). */
export interface ActionWords {
  readonly vocabulary: ReadonlySet<string>
  readonly verbs: ReadonlySet<string>
}

const vocabularyCache = new WeakMap<RegisteredAction, {
  readonly lists: IntentWords
  readonly options: ReadonlyArray<ReadonlyArray<ParamOption>>
  readonly words: ActionWords
}>()

/**
 * The words an action explains by itself, as stems: its label, the positive
 * sentences of its description, its examples, its parameters' labels, units and
 * text markers. Number words are left out (a number is only ever a value), and
 * so are names of its parameters' values in examples, unless the label or the
 * description uses them ("lights" in "Turn lights on" stays): a value is
 * explained by being chosen, never by an example that happens to name it.
 * Negations are never part of a vocabulary.
 */
export const actionVocabulary = (
  action: RegisteredAction,
  optionsOf: (param: ActionParam) => ReadonlyArray<ParamOption>,
  lists: IntentWords = defaultIntentWords
): ReadonlySet<string> => actionWords(action, optionsOf, lists).vocabulary

/**
 * `actionVocabulary` and the action's VERBS: the words its label and examples start
 * with that they never use anywhere else and that name no value and are no filler
 * ("turn", "switch", "dim", "set", "doe", "zet"; not "lights", which "turn on the
 * kitchen lights" also uses later). A request that says a verb says it before any
 * other content word: "the kitchen lights turn on" is a statement, not a request.
 */
export const actionWords = (
  action: RegisteredAction,
  optionsOf: (param: ActionParam) => ReadonlyArray<ParamOption>,
  lists: IntentWords = defaultIntentWords
): ActionWords => {
  // Cached while the action's value lists are the same arrays (a module's own cache) and the word lists the same.
  const current = Object.values(action.definition.params as Readonly<Record<string, ActionParam>>)
    .flatMap((p) => (p.kind === "choice" || p.kind === "dynamic" ? [optionsOf(p)] : []))
  const hit = vocabularyCache.get(action)
  if (hit !== undefined && hit.lists === lists && hit.options.length === current.length && hit.options.every((o, i) => o === current[i])) {
    return hit.words
  }
  const built = buildWords(action, optionsOf, lists)
  vocabularyCache.set(action, { lists, options: current, words: built })
  return built
}

const buildWords = (
  action: RegisteredAction,
  optionsOf: (param: ActionParam) => ReadonlyArray<ParamOption>,
  lists: IntentWords
): ActionWords => {
  const def = action.definition
  const described = new Set([...textStems(def.label), ...textStems(positive(def.description))])
  const valueWords = new Set<string>()
  const vocabulary = new Set(described)
  for (const param of Object.values(def.params as Readonly<Record<string, ActionParam>>)) {
    for (const s of textStems(param.label)) vocabulary.add(s)
    if (param.kind === "number" && param.unit !== undefined) for (const s of textStems(param.unit, true)) vocabulary.add(s)
    if (param.kind === "text") for (const marker of param.after) for (const s of textStems(marker)) vocabulary.add(s)
    if (param.kind === "choice" || param.kind === "dynamic") {
      for (const option of optionsOf(param)) for (const name of namesOf(option)) for (const w of name) valueWords.add(w.stem)
    }
  }
  for (const example of def.examples ?? []) {
    for (const s of textStems(example)) if (described.has(s) || !valueWords.has(s)) vocabulary.add(s)
  }
  // A read-only action answers questions: its question words stay ("what time is it"); it is never acted on through them.
  const structural = def.speculative === true ? new Set<string>() : STRUCTURAL_WORDS
  for (const s of [...vocabulary]) if (lists.negation.has(s) || isNegated([s], lists) || structural.has(s)) vocabulary.delete(s)
  // Verbs: first words of the label and the examples, used nowhere else in them.
  const firsts = new Set<string>()
  const later = new Set<string>()
  for (const sentence of [def.label, ...(def.examples ?? [])]) {
    textStems(sentence, true).forEach((s, i) => (i === 0 ? firsts : later).add(s))
  }
  const verbs = new Set<string>()
  for (const s of firsts) {
    if (!later.has(s) && !valueWords.has(s) && !lists.filler.has(s) && vocabulary.has(s)) verbs.add(s)
  }
  return { vocabulary, verbs }
}

// ---------------------------------------------------------------------------
// Spans

/** Character range → the words it covers. */
export const wordsIn = (ws: ReadonlyArray<Word>, start: number, end: number): WordSpan | undefined => {
  let from = -1
  let to = -1
  ws.forEach((w, i) => {
    if (w.end > start && w.start < end) {
      if (from < 0) from = i
      to = i + 1
    }
  })
  return from < 0 ? undefined : { from, to }
}

/** Where `text` (a value taken from the utterance) sits, at or after character `after`. */
export const spanOfText = (utterance: string, ws: ReadonlyArray<Word>, text: string, after = 0): WordSpan | undefined => {
  const at = utterance.indexOf(text, after)
  return at < 0 ? undefined : wordsIn(ws, at, at + text.length)
}

/** Characters `[start, end)` of the canonical text where marks are consumed; `chars`: only these marks (an option's own punctuation). */
export interface CharSpan {
  readonly start: number
  readonly end: number
  readonly chars?: ReadonlySet<string>
}

/** The characters a mention covers, with the punctuation its option's names contain. */
export const mentionChars = (ws: ReadonlyArray<Word>, m: Mention): CharSpan => ({ start: ws[m.from]!.start, end: ws[m.to - 1]!.end, chars: marksOfOption(m.option) })

// ---------------------------------------------------------------------------
// The accounting

export interface Accounting {
  /** The utterance's words (of its canonical text). */
  readonly ws: ReadonlyArray<Word>
  /** The canonical text and its significant marks; without them, only words are accounted for. */
  readonly text?: string
  readonly marks?: ReadonlyArray<Mark>
  /** Words explained by themselves (stems): the action's vocabulary, the question's own words. */
  readonly vocabulary: ReadonlySet<string>
  /** The action's verbs (stems): explained only before any other content word. */
  readonly verbs?: ReadonlySet<string>
  /** Spans explained as values: the option named, the number used, the text taken. */
  readonly covered: ReadonlyArray<WordSpan>
  /** Spans that can only be explained as values (number spans, names of options, ambiguous spans); explained only when covered. */
  readonly reserved: ReadonlyArray<WordSpan>
  /** Characters where marks are consumed: every number span (its reading decides), text taken, options named. */
  readonly consumed?: ReadonlyArray<CharSpan>
  /**
   * "request": a fresh request (must name the action); "reply": the answer to a pending question
   * (`replyFiller` allowed); "question": a read-only action's question, only for a provider's
   * `fits` role (core never acts on its outcome: the request construction and verb order do not
   * apply, a final "?" and the words of `QUESTION_FILLER` are free).
   */
  readonly mode?: "request" | "reply" | "question"
  readonly lists?: IntentWords
}

export interface AccountResult {
  /** What nothing explains: words, marks, "(no action word)". Empty: the utterance is fully accounted for. */
  readonly unexplained: ReadonlyArray<string>
  /** How many words the action's own vocabulary explains (how specifically the sentence names this action). */
  readonly vocabulary: number
}

const inside = (spans: ReadonlyArray<WordSpan>, i: number) => spans.some((s) => i >= s.from && i < s.to)

/** Words free in a read-only question for a provider's `fits` role (round 3's filler list; never used to act). */
export const QUESTION_FILLER: ReadonlySet<string> = new Set([
  "i", "me", "my", "we", "us", "our", "you", "your", "it", "its", "please", "kindly", "thanks", "thank", "can", "could", "would", "will",
  "want", "wanna", "id", "like", "lets", "tell", "just", "now", "then", "also", "too", "hey", "hi", "hello", "ok", "okay", "well", "so",
  "ik", "mij", "wij", "ons", "je", "jij", "jou", "u", "uw", "dank", "bedankt", "kun", "kunt", "kan", "wil", "wilt", "zou", "mag", "dan",
  "ook", "hoi", "hallo", "nou"
])

/**
 * Words that make the number after them a time or a condition, not a value (review round 5):
 * "dim the kitchen at 7", "… by 7", "… until 7", "zet de keuken om 7 op 40". A number right after
 * one is no candidate for a number parameter (it stays a reserved span nobody takes, so the
 * sentence is not accounted for), except after "at" with the parameter's own unit said ("at 50
 * percent"; "by 10 percent" is a change, not a level). For a duration parameter the same words count, except those
 * that introduce a duration ("in", "over", "binnen", "for", "voor", "van").
 */
export const TIME_BEFORE_NUMBER: ReadonlySet<string> = new Set([
  "at", "by", "until", "till", "til", "after", "before", "around", "since", "from", "past", "in", "within",
  "om", "tot", "na", "voor", "vanaf", "rond", "omstreeks", "sinds", "tegen", "uiterlijk", "over", "binnen"
])
export const TIME_BEFORE_DURATION: ReadonlySet<string> = new Set(
  [...TIME_BEFORE_NUMBER].filter((w) => !["in", "within", "over", "binnen", "voor"].includes(w))
)

/** Free fillers that attach to what follows them (articles, possessives, prepositions): never the last word of a request's body. */
const DEPENDENT: ReadonlySet<string> = new Set([
  "the", "a", "an", "my", "our", "to", "in", "at", "for", "of", "into", "de", "het", "een", "t", "mijn", "onze", "ons", "op", "naar", "voor",
  "van", "bij", "te"
])

/**
 * The request construction at the edges of `ws`: words `[0, lead)` and
 * `[tail, n)` are the construction (openings, a request frame, manner words,
 * politeness, free fillers), never a value; `question`: an asking frame ("can
 * you …"), which accounts for one final "?".
 */
export const requestFrame = (
  ws: ReadonlyArray<Word>,
  isValue: (i: number) => boolean,
  lists: IntentWords = defaultIntentWords
): { readonly lead: number; readonly tail: number; readonly question: boolean } => {
  const n = ws.length
  const phrase = (from: number, to: number): string | undefined => {
    for (let k = from; k < to; k++) if (isValue(k)) return undefined
    return ws.slice(from, to).map((w) => w.norm).join(" ")
  }
  let lead = 0
  let frame = false
  let question = false
  outer: while (lead < n) {
    for (let len = Math.min(5, n - lead); len >= 1; len--) {
      const p = phrase(lead, lead + len)
      if (p === undefined) continue
      if (!frame && (lists.askFrame.has(p) || lists.wantFrame.has(p))) {
        frame = true
        question = lists.askFrame.has(p)
      } else if (!(!frame && lists.opening.has(p)) && !lists.manner.has(p) && !(len === 1 && lists.filler.has(p) && !DEPENDENT.has(p))) continue
      lead += len
      continue outer
    }
    break
  }
  // From the end: closings, manner words and free fillers, but never a filler that places or
  // determines what follows it (`DEPENDENT`: "to", "for", "the", "my", "op", …). Those stay in the
  // body, where `account` requires them to be followed by what they place: "turn on the kitchen
  // lights for my", "… at", "… to please" are unfinished (review round 5).
  let tail = n
  outer: while (tail > lead) {
    for (let len = Math.min(5, tail - lead); len >= 1; len--) {
      const p = phrase(tail - len, tail)
      if (p === undefined || !(lists.closing.has(p) || lists.manner.has(p) || (len === 1 && lists.filler.has(p) && !DEPENDENT.has(p)))) continue
      tail -= len
      continue outer
    }
    break
  }
  return { lead, tail, question }
}

/**
 * Account for an utterance: every word and every significant mark is explained
 * once, by the request construction, a value, the action's words or a free
 * filler, in an order a request can have. See the module comment.
 */
export const account = (a: Accounting): AccountResult => {
  const lists = a.lists ?? defaultIntentWords
  const ws = a.ws
  const out: Array<string> = []
  const isValue = (i: number) => inside(a.covered, i) || inside(a.reserved, i)
  const question = a.mode === "question"
  const frame = question ? { lead: 0, tail: ws.length, question: true } : requestFrame(ws, isValue, lists)
  let vocabulary = 0
  let content = false
  // A free filler that only places or determines a value ("to", "in", "the", "my", "op", "de")
  // must be followed by what it places: "turn on the kitchen lights for my" was cut off.
  let dangling: string | undefined
  // A value ending in a possessive (or a bare plural that may be one) must be followed right away
  // by a content word it possesses (review round 6): "the bedroom's lights", not "the bedroom's",
  // "the bedroom's please", "the bedroom's to 40 percent".
  let owner: string | undefined
  for (let i = frame.lead; i < frame.tail; i++) {
    const w = ws[i]!
    if (inside(a.covered, i)) {
      content = true
      dangling = undefined
      owner = a.covered.some((c) => c.possessive === true && c.to === i + 1) ? w.norm : undefined
      continue
    }
    if (owner !== undefined) {
      const possessed = !lists.filler.has(w.norm) && a.vocabulary.has(stemWord(w.norm)) && a.verbs?.has(stemWord(w.norm)) !== true
      if (!possessed) out.push(owner)
      owner = undefined
    }
    const negation = lists.negation.has(w.norm) || (w.norm === "t" && isNegated(ws.slice(Math.max(0, i - 1), i + 1).map((x) => x.norm), lists))
    if (negation || inside(a.reserved, i)) {
      out.push(w.norm)
      continue
    }
    // "t" ('t, Dutch "het") right before a number word is what is left of a cut-off number ("t eight" of "thirty eight").
    if (w.norm === "t" && ws[i + 1] !== undefined && isNumericWord(ws[i + 1]!.norm)) {
      out.push(w.norm)
      continue
    }
    if (lists.filler.has(w.norm) || (a.mode === "reply" && lists.replyFiller.has(w.norm)) || (question && QUESTION_FILLER.has(w.norm))) {
      if (DEPENDENT.has(w.norm) && !question) dangling = w.norm
      continue
    }
    const stem = stemWord(w.norm)
    if (!a.vocabulary.has(stem)) {
      out.push(w.norm)
      continue
    }
    // An article or preposition right before the verb places nothing ("at set the kitchen …", round 5).
    if (dangling !== undefined && !question && a.verbs?.has(stem) === true) {
      out.push(dangling)
      dangling = undefined
    }
    // A verb after another content word: a statement ("the kitchen lights turn on"), not a request.
    if (content && !question && a.verbs?.has(stem) === true) {
      out.push(w.norm)
      continue
    }
    vocabulary++
    content = true
    dangling = undefined
  }
  if (dangling !== undefined) out.push(dangling)
  if (owner !== undefined) out.push(owner)
  // Frame words of the lead or tail that are negations still count against it (never part of a construction).
  for (let i = 0; i < ws.length; i++) {
    if ((i < frame.lead || i >= frame.tail) && lists.negation.has(ws[i]!.norm)) out.push(ws[i]!.norm)
  }
  if (a.marks !== undefined && a.text !== undefined) {
    if (!partitioned(a, frame.question || question, out)) out.push(NOT_PARTITIONED)
  }
  if (a.mode === "request" && vocabulary === 0) out.push("(no action word)")
  return { unexplained: out, vocabulary }
}

/** Reported when the characters of the canonical text are not partitioned among winning spans (an internal error: never act). */
export const NOT_PARTITIONED = "(characters not partitioned)"

const sameChars = (x: CharSpan, y: CharSpan) => x.start === y.start && x.end === y.end && x.chars === y.chars
const sameSpan = (x: WordSpan, y: WordSpan) => x.from === y.from && x.to === y.to

/**
 * Character ownership (review round 5), checked rather than assumed. Every character of the
 * canonical text must be owned by exactly one of:
 *
 * - a winning value span in use (`covered`): the characters of its words, and of the marks it
 *   consumes (`consumed`: number spans that kept the number role, an option's own punctuation,
 *   all marks inside text taken);
 * - a word that is not part of a value (its role was decided above: construction, the action's
 *   words, a filler; if nothing explains it, it is already reported);
 * - the closed ignorable set: a single space between tokens, a comma outside every number span
 *   (`IGNORABLE_OUTSIDE_NUMBERS`), the one final "?" of an asking frame.
 *
 * A mark no span owns is reported (it is unexplained); a word or mark that two different
 * winning spans claim, or a character with no owner at all (words and marks disagreeing about
 * the text), makes the whole check fail: `false`, and the caller reports `NOT_PARTITIONED`.
 */
const partitioned = (a: Accounting, asking: boolean, out: Array<string>): boolean => {
  const text = a.text!
  const marks = a.marks!
  const owners = new Uint8Array(text.length)
  let ok = true
  const covered: Array<WordSpan> = []
  for (const c of a.covered) if (!covered.some((d) => sameSpan(c, d))) covered.push(c)
  a.ws.forEach((w, i) => {
    const claims = covered.filter((c) => i >= c.from && i < c.to).length
    if (claims > 1) ok = false
    for (let k = w.start; k < w.end; k++) owners[k]! += 1
  })
  const consumed: Array<CharSpan> = []
  for (const c of a.consumed ?? []) if (!consumed.some((d) => sameChars(c, d))) consumed.push(c)
  const winners = covered.map((c) => ({ start: a.ws[c.from]?.start ?? 0, end: a.ws[c.to - 1]?.end ?? 0 }))
  const insideWinner = (k: number) => winners.some((w) => k > w.start && k < w.end) || consumed.some((c) => k > c.start && k < c.end - 1)
  const lastMark = marks[marks.length - 1]
  for (const m of marks) {
    const claims = consumed.filter((c) => m.start >= c.start && m.start < c.end && (c.chars === undefined || c.chars.has(m.char))).length
    if (claims > 1) ok = false
    if (claims > 0) {
      owners[m.start]! += 1
      continue
    }
    // Ignorable only where no span owns it: a comma before a space and outside every winning span
    // (inside "room, two" it splits a name; ",dim" is glued to nothing), the one final "?" of "can you …?".
    const ignorable = (IGNORABLE_OUTSIDE_NUMBERS.has(m.char) && text[m.start + 1] === " " && !insideWinner(m.start)) ||
      (m.char === "?" && asking && (a.mode === "question" || m === lastMark) && text.slice(m.start + 1).trim() === "")
    // An unexplained mark is reported, and counted once: it is not left out of the partition.
    if (!ignorable) out.push(m.char)
    owners[m.start]! += 1
  }
  for (let k = 0; k < text.length; k++) {
    if (text[k] === " " && (k === 0 || text[k - 1] !== " ")) owners[k]! += 1
    if (owners[k] !== 1) ok = false
  }
  return ok
}

/** The words (and marks) nothing explains (empty: the utterance is fully accounted for). */
export const unexplainedWords = (a: Accounting): Array<string> => [...account(a).unexplained]
