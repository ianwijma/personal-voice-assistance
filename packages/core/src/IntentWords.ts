import { words } from "./TextMatching.ts"
import { readUtterance } from "./Utterance.ts"

/**
 * The closed word lists of the typed-intent path, English and Dutch
 * (docs/AGENTS-AND-INTENTS.md, "Changes since the design", review rounds 2 and 3).
 * Shared by core's decider-independent rules (`interpretDecision`,
 * `Accounting.ts`) and the offline keyword decider, so both read "yes please",
 * "don't" and "please" alike.
 *
 * Every list that says an input is safe to act on is an ALLOW-list: a
 * confirmation is a phrase of `yes` and `yesFiller` and nothing else; a word of
 * a command is explained only by the action, its values or `filler`. Nothing is
 * inferred from the absence of a known bad word: `negation` and `prohibition`
 * are a second, independent veto, and a negation that is in no list still fails
 * as an unexplained word.
 *
 * Words are compared after `normalizeWord` (lower case, no accents, no
 * apostrophes: "don't" is "dont"). Entries of `yes`, `yesFiller` and `filler`
 * may be phrases of several words ("go ahead", "thank you"). Extend them with
 * `extendIntentWords`.
 */
export interface IntentWords {
  /**
   * Confirmation phrases: an explicit affirmative ("yes", "sure", "ja", "prima") or
   * a recognised imperative ("go ahead", "do it", "doe maar").
   */
  readonly yes: ReadonlySet<string>
  /** Phrases allowed before, between or after them in a confirmation ("please", "thank you", "alsjeblieft"). */
  readonly yesFiller: ReadonlySet<string>
  /** Words that make a reply a no; a refusal consists only of these and `noFiller`, at least one of these. */
  readonly no: ReadonlySet<string>
  readonly noFiller: ReadonlySet<string>
  /**
   * Negation: a request containing one of these is not acted on for an action
   * with side effects ("don't turn on …", "wouldnt …", "doe het licht niet aan").
   * Contractions are listed without apostrophes, as recognisers often write them;
   * a contraction split in two ("don t") is recognised too. Over-inclusive on
   * purpose: a question with "not" goes to the conversational agent, which is harmless.
   */
  readonly negation: ReadonlySet<string>
  /**
   * Prohibition verbs governing the command ("stop turning on the lights",
   * "cancel …", "hou op met …"): the same veto as a negation, except for an
   * action whose own label or examples use the word (a "Stop the timer" action).
   */
  readonly prohibition: ReadonlySet<string>
  /**
   * FREE fillers: the closed set of words that carry no meaning of their own
   * wherever they stand in a request or a reply: articles, "please", "now",
   * hesitations and the prepositions that only place a value ("to 40", "in the
   * kitchen", "op veertig"). Every other word must be explained by the request
   * construction (the positional lists below), the action, its parameters or its
   * values. Never add words that can change what is done (on, off, aan, uit, and,
   * not, …) or who does it (I, you, will, like, …: those are positional).
   */
  readonly filler: ReadonlySet<string>
  /** Phrases allowed only at the very start, before the request ("hey", "ok", "well", "hoi", "nou"). */
  readonly opening: ReadonlySet<string>
  /**
   * Request constructions that ask ("can you …", "would you …", "kun je …", "wil je …"): only
   * at the start (after openings, manner words and free fillers); they also account for one
   * final "?" ("can you turn on the kitchen lights?").
   */
  readonly askFrame: ReadonlySet<string>
  /** Request constructions that state a wish ("I want …", "I'd like …", "let's …", "ik wil …"): only at the start; no "?". */
  readonly wantFrame: ReadonlySet<string>
  /**
   * Manner words that cannot change which action or value is meant ("quickly", "right now",
   * "immediately", "snel", "meteen"): only at the start or the end of the request.
   */
  readonly manner: ReadonlySet<string>
  /** Politeness after a complete request ("thank you", "thanks", "cheers", "dank je", "bedankt"): only at the end. */
  readonly closing: ReadonlySet<string>
  /** Words a reply to a pending question may add besides the value ("make it 40", "set it to 40"). Replies only. */
  readonly replyFiller: ReadonlySet<string>
}

export const defaultIntentWords: IntentWords = {
  yes: new Set([
    // English: explicit affirmatives
    "yes", "yeah", "yea", "yep", "yup", "sure", "sure thing", "ok", "okay", "okey", "oke", "okidoki", "alright", "all right",
    "absolutely", "definitely", "certainly", "of course", "indeed", "affirmative", "correct", "thats correct", "that is correct",
    "thats right", "that is right", "fine", "thats fine", "that is fine", "very well", "perfect", "sounds good",
    // English: imperatives
    "go ahead", "go for it", "please do", "do it", "do so", "do that", "lets do it", "proceed", "confirm", "confirmed",
    // Dutch: explicit affirmatives
    "ja", "jawel", "jazeker", "jep", "jup", "zeker", "zeker weten", "natuurlijk", "tuurlijk", "prima", "goed", "is goed",
    "dat is goed", "is prima", "dat is prima", "klopt", "dat klopt", "akkoord", "okee", "perfect", "graag", "ja graag",
    // Dutch: imperatives
    "doe maar", "doe het", "doe het maar", "doe dat", "doe dat maar", "ga je gang", "ga uw gang", "ga maar", "ga door",
    "ga verder", "doen", "uitvoeren"
  ]),
  yesFiller: new Set([
    "please", "thanks", "thank you", "thanks a lot", "cheers", "oh", "um", "uh", "uhm", "eh", "ehm", "well", "hey", "now", "then",
    "alsjeblieft", "alstublieft", "graag", "dank je", "dank u", "dankjewel", "dankuwel", "bedankt", "nou", "nu", "dan"
  ]),
  no: new Set(["no", "nope", "nah", "cancel", "stop", "dont", "nee", "niet", "nooit", "annuleer", "laat", "never", "not", "geen"]),
  noFiller: new Set(["thanks", "thank", "you", "mind", "maar", "doen", "it", "that", "do", "please", "now", "hoeft", "het", "dat", "dank", "je", "wait", "alsjeblieft", "nodig"]),
  negation: new Set([
    // English
    "not", "no", "nope", "never", "nothing", "none", "neither", "nor", "nobody", "nowhere", "without", "except", "unless",
    "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "wont", "wouldnt", "shouldnt", "mustnt", "cant", "cannot",
    "couldnt", "havent", "hasnt", "hadnt", "neednt", "shant", "aint", "mightnt", "maynt", "nt",
    // Dutch
    "niet", "nooit", "geen", "niks", "niets", "nee", "nergens", "niemand", "zonder", "behalve", "noch"
  ]),
  prohibition: new Set([
    // English
    "stop", "stopping", "quit", "quitting", "cease", "halt", "cancel", "cancelling", "canceling", "abort", "avoid", "avoiding",
    "refrain", "forget", "skip", "prevent", "enough",
    // Dutch ("stop met", "hou op met", "houd op met", "niet meer")
    "stoppen", "hou", "houd", "ophouden", "annuleer", "annuleren", "vermijd", "vermijden", "vergeet", "staak", "staken", "voorkom",
    "genoeg"
  ]),
  filler: new Set([
    // English: articles, possessive determiners, politeness, hesitation, value-placing prepositions
    "the", "a", "an", "my", "our", "please", "kindly", "just", "now", "um", "uh", "uhm", "umm", "er", "erm", "eh", "hmm",
    "to", "in", "at", "for", "of", "into",
    // Dutch
    "de", "het", "een", "t", "mijn", "onze", "ons", "alsjeblieft", "alstublieft", "graag", "even", "eens", "nu", "ehm", "euh",
    "op", "naar", "voor", "van", "bij", "te"
  ]),
  opening: new Set([
    "hey", "hi", "hello", "ok", "okay", "oke", "okee", "alright", "all right", "well", "so", "oh",
    "hoi", "hallo", "nou", "zo", "goed"
  ]),
  askFrame: new Set([
    "can you", "could you", "will you", "would you", "can u", "could u", "will u", "would u",
    "kun je", "kun jij", "kunt u", "kan je", "kan jij", "wil je", "wil jij", "wilt u", "zou je", "zou jij", "zoudt u", "zou u"
  ]),
  wantFrame: new Set([
    "i want", "i want you to", "i wanna", "id like", "id like you to", "i would like", "i would like you to", "i would like to", "id like to",
    "lets", "let us",
    "ik wil", "ik wil graag", "ik zou graag", "ik zou graag willen", "ik zou willen"
  ]),
  manner: new Set(["quickly", "now", "right now", "immediately", "right away", "snel", "nu", "even", "meteen", "nu meteen", "direct"]),
  closing: new Set([
    "please", "thanks", "thank you", "thank you very much", "thanks a lot", "thanks very much", "many thanks", "cheers", "for me",
    "alsjeblieft", "alstublieft", "graag", "dank je", "dank je wel", "dankjewel", "dank u", "dank u wel", "dankuwel", "bedankt",
    "voor mij", "voor me"
  ]),
  replyFiller: new Set(["it", "make", "maak"])
}

/** `base` with more words (another language, a household's own "yes"). */
export const extendIntentWords = (
  extra: { readonly [K in keyof IntentWords]?: Iterable<string> },
  base: IntentWords = defaultIntentWords
): IntentWords => {
  const merge = (key: keyof IntentWords) => new Set([...base[key], ...(extra[key] ?? [])])
  return {
    yes: merge("yes"),
    yesFiller: merge("yesFiller"),
    no: merge("no"),
    noFiller: merge("noFiller"),
    negation: merge("negation"),
    prohibition: merge("prohibition"),
    filler: merge("filler"),
    opening: merge("opening"),
    askFrame: merge("askFrame"),
    wantFrame: merge("wantFrame"),
    manner: merge("manner"),
    closing: merge("closing"),
    replyFiller: merge("replyFiller")
  }
}

/** The normalised words of a text, as the lists compare them. */
export const replyWords = (text: string): Array<string> => words(text).map((w) => w.norm)

/** Every word from `strong` ∪ `filler` and at least one from `strong`. */
const only = (ws: ReadonlyArray<string>, strong: ReadonlySet<string>, filler: ReadonlySet<string>) =>
  ws.length > 0 && ws.some((w) => strong.has(w)) && ws.every((w) => strong.has(w) || filler.has(w))

/** Contractions a recogniser may split at the apostrophe: "don t", "won t". */
const splitContraction = new Set([
  "don", "doesn", "didn", "isn", "aren", "wasn", "weren", "won", "wouldn", "shouldn", "mustn", "can", "couldn", "haven",
  "hasn", "hadn", "needn", "shan", "ain", "mightn"
])

/** A negation word, or a contraction split in two ("don t"). */
export const isNegated = (ws: ReadonlyArray<string>, lists: IntentWords = defaultIntentWords): boolean =>
  ws.some((w, i) => lists.negation.has(w) || (w === "t" && i > 0 && splitContraction.has(ws[i - 1]!)))

/**
 * A prohibition verb ("stop", "cancel", "hou op") other than those in `own`
 * (the action's own words: "stop" does not veto a "Stop the timer" action).
 */
export const isProhibited = (ws: ReadonlyArray<string>, own: ReadonlySet<string> = new Set(), lists: IntentWords = defaultIntentWords): boolean =>
  ws.some((w) => lists.prohibition.has(w) && !own.has(w))

/**
 * Whether `ws` from position 0 can be split into phrases of `strong` and
 * `filler` with at least one `strong` phrase (phrases up to four words).
 */
const phrasesOnly = (ws: ReadonlyArray<string>, strong: ReadonlySet<string>, filler: ReadonlySet<string>): boolean => {
  // reach[i]: 0 = not reachable, 1 = reachable with fillers only, 2 = reachable with a strong phrase.
  const reach = new Array<number>(ws.length + 1).fill(0)
  reach[0] = 1
  for (let i = 0; i < ws.length; i++) {
    if (reach[i] === 0) continue
    for (let len = 1; len <= 4 && i + len <= ws.length; len++) {
      const phrase = ws.slice(i, i + len).join(" ")
      if (strong.has(phrase)) reach[i + len] = 2
      if (filler.has(phrase)) reach[i + len] = Math.max(reach[i + len]!, reach[i]!)
    }
  }
  return reach[ws.length] === 2
}

/**
 * A confirmation, by a closed phrase grammar:
 *
 *   confirmation := filler* affirmative (filler | affirmative)*
 *
 * with `affirmative` from `lists.yes` ("yes", "go ahead", "doe maar") and
 * `filler` from `lists.yesFiller` ("please", "thank you", "alsjeblieft"), and
 * nothing else: no negation, no question mark, no punctuation but commas and
 * the sentence punctuation the canonical text drops ("Yes." and "yes!" confirm;
 * "yes?" does not). Interrogative forms ("is that
 * right", "is that okay", "do you", "shall I", "zal ik") are not in the
 * grammar, so they never confirm, with or without a question mark.
 */
export const isConfirmation = (text: string, lists: IntentWords = defaultIntentWords): boolean => {
  // The canonical text (the one normalisation shared with the parser and the promotion comparison):
  // any mark left ("yes?", "yes -", "ok…?", a glued ",yes") is not part of the grammar: the canonical
  // text has already dropped every comma that is punctuation (round 5: the same rule as the accounting).
  const u = readUtterance(text)
  if (u.marks.length > 0) return false
  const ws = u.words.map((w) => w.norm)
  return ws.length > 0 && !isNegated(ws, lists) && phrasesOnly(ws, lists.yes, lists.yesFiller)
}

/** `isConfirmation` of words already split (no question mark known). */
export const isAffirmative = (ws: ReadonlyArray<string>, lists: IntentWords = defaultIntentWords): boolean =>
  ws.length > 0 && !isNegated(ws, lists) && phrasesOnly(ws, lists.yes, lists.yesFiller)

/** A bounded refusal: the whole reply is a no ("no thanks", "laat maar", "niet doen"). */
export const isRefusal = (ws: ReadonlyArray<string>, lists: IntentWords = defaultIntentWords): boolean => only(ws, lists.no, lists.noFiller)
