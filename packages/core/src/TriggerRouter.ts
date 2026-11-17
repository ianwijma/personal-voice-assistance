import type { RouteReason } from "@pva/protocol"
import { editDistance, joinSpelledLetters, normalizeWord, phoneticWord, type Word, words } from "./TextMatching.ts"
import type { RouteDecision, RouteInput, Router, RouterState, TriggerMatch } from "./Routing.ts"

/**
 * A trigger-phrase `Router` ("hey jev, ..." picks an agent, with tolerant matching), kept as a fixture for the tests of
 * the agent mechanism (`Conversation` with an `AgentSet`, the agent latency tests, the Jev end to end). The app does
 * not use it: devices and the route gate (RouteGate.ts) match phrases to assistants, and the Claude subscription
 * assistants use the fixed `subscriptionRouter` of the app. Exported from `@pva/core/testing`.
 */

/** In a rule, stands for whichever agent is the default (a phrase that means "back to normal"). */
export const DEFAULT_AGENT_REF = "@default"

export interface TriggerRule {
  /** Agent id (the module id of an agent), or `DEFAULT_AGENT_REF`. */
  readonly agent: string
  /** Phrases as the owner writes them ("hey jev"); all are equivalent (aliases). */
  readonly phrases: ReadonlyArray<string>
  /**
   * `turn`: only the utterance that starts with the phrase.
   * `conversation`: that utterance and the following ones, until another trigger,
   * `routing.set`, or `stickyIdleMs` without a turn for that agent.
   */
  readonly mode: "turn" | "conversation"
}

export interface RoutingConfig {
  /** Agent for utterances with no trigger (and nothing sticky or armed). */
  readonly defaultAgent: string
  /**
   * Answers when the routed agent is not running and the default is not either,
   * and takes over from an intent agent that passes a turn on when the intent
   * agent is itself the default. Should be a conversational agent. Optional.
   */
  readonly fallbackAgent?: string | undefined
  readonly rules: ReadonlyArray<TriggerRule>
  /** Words treated as interchangeable greetings in a phrase: "hey jev" also matches "hi jev", "okay jev". */
  readonly greetings: ReadonlyArray<string>
  /** Words skipped at the very start of an utterance before matching ("um, hey Jev"). */
  readonly fillers: ReadonlyArray<string>
  /**
   * When false (default), a phrase that starts with a greeting also matches without it
   * ("Jev, lights on"), but only when the name is recognised exactly or phonetically,
   * never by edit distance alone.
   */
  readonly requireGreeting: boolean
  /** A conversation-mode selection lapses after this long without a turn for that agent. */
  readonly stickyIdleMs: number
  /** After an utterance that was only a trigger (or a question from the agent), the next utterance within this time goes to that agent. */
  readonly armedMs: number
  /** Spoken when the utterance was only a trigger ("Hey Jev."). */
  readonly acknowledgement: string
}

export const defaultRoutingConfig: RoutingConfig = {
  defaultAgent: "anthropic",
  rules: [
    { agent: "jev", phrases: ["hey jev", "hey jeff"], mode: "turn" },
    { agent: "claude-subscription", phrases: ["hey claude"], mode: "conversation" },
    { agent: "codex-subscription", phrases: ["hey codex"], mode: "conversation" },
    { agent: "openrouter", phrases: ["hey router", "hey open router"], mode: "conversation" },
    { agent: "home-model", phrases: ["hey local", "hey home"], mode: "conversation" },
    { agent: DEFAULT_AGENT_REF, phrases: ["hey assistant", "back to normal"], mode: "conversation" }
  ],
  greetings: ["hey", "hi", "hello", "hay", "ok", "okay", "oke", "yo", "he", "hoi", "hallo"],
  fillers: ["um", "uh", "uhm", "umm", "er", "erm", "eh", "ehm", "euh", "hmm", "mm", "so"],
  requireGreeting: false,
  stickyIdleMs: 120_000,
  armedMs: 10_000,
  acknowledgement: "Yes?"
}

// ---------------------------------------------------------------------------
// Matching

interface PhraseWord {
  readonly norm: string
  readonly phon: string
  readonly greeting: boolean
}

interface CompiledPhrase {
  readonly rule: number
  readonly agent: string
  readonly mode: TriggerRule["mode"]
  readonly text: string
  readonly words: ReadonlyArray<PhraseWord>
}

/** Only the first words of an utterance can hold a trigger. */
const SCAN_CHARS = 160

/**
 * How well one recognised word matches one phrase word: 1 exact, 0.9 same
 * phonetic key, 0.8 one edit apart (both words at least 4 letters), 0.75 phonetic
 * keys one edit apart (both keys at least 4 letters), 0 no match. Short words
 * must match exactly or phonetically: one edit turns "jev" into "jen" or "rev".
 */
export const wordMatchScore = (norm: string, phrase: { readonly norm: string; readonly phon: string }): number => {
  if (norm === phrase.norm) return 1
  const phon = phoneticWord(norm)
  if (phon.length > 0 && phon === phrase.phon) return 0.9
  if (Math.min(norm.length, phrase.norm.length) >= 4 && editDistance(norm, phrase.norm, 1) <= 1) return 0.8
  if (Math.min(phon.length, phrase.phon.length) >= 4 && editDistance(phon, phrase.phon, 1) <= 1) return 0.75
  return 0
}

const upperFirst = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

/** The text after `end`, without the punctuation and spaces that separated it from the trigger. */
const remainderAfter = (text: string, end: number): string => upperFirst(text.slice(end).replace(/^[\s\p{P}]+/u, "").trimEnd())

export const makeTriggerRouter = (config: RoutingConfig): Router => {
  const greetings = new Set(config.greetings.map(normalizeWord))
  const greetingKeys = new Set([...greetings].map(phoneticWord))
  const fillers = new Set(config.fillers.map(normalizeWord))
  const isGreeting = (norm: string) => greetings.has(norm) || greetingKeys.has(phoneticWord(norm))

  const phrases: Array<CompiledPhrase> = []
  config.rules.forEach((rule, index) => {
    for (const text of rule.phrases) {
      const ws = joinSpelledLetters(words(text)).map((w, i): PhraseWord => ({
        norm: w.norm,
        phon: phoneticWord(w.norm),
        greeting: i === 0 && greetings.has(w.norm)
      }))
      if (ws.length === 0 || ws.every((w) => w.greeting)) continue // nothing to recognise
      phrases.push({ rule: index, agent: rule.agent, mode: rule.mode, text, words: ws })
    }
  })

  const resolve = (agent: string) => (agent === DEFAULT_AGENT_REF ? config.defaultAgent : agent)

  const matchPhrase = (
    utterance: ReadonlyArray<Word>,
    phrase: CompiledPhrase
  ): { readonly used: number; readonly end: number; readonly score: number } | undefined => {
    let i = 0
    let j = 0
    let score = 1
    let greetingMissing = false
    if (phrase.words[0]!.greeting) {
      j = 1
      if (utterance.length > 0 && isGreeting(utterance[0]!.norm)) i = 1
      else if (config.requireGreeting) return undefined
      else greetingMissing = true
    }
    for (; j < phrase.words.length; j++, i++) {
      const word = utterance[i]
      if (word === undefined) return undefined
      const s = wordMatchScore(word.norm, phrase.words[j]!)
      if (s === 0) return undefined
      score = Math.min(score, s)
    }
    if (greetingMissing) {
      if (score < 0.9) return undefined
      score = Math.min(score, 0.85)
    }
    return { used: i, end: utterance[i - 1]!.end, score }
  }

  const matchTrigger = (text: string): TriggerMatch | undefined => {
    let utterance = joinSpelledLetters(words(text.slice(0, SCAN_CHARS)))
    let skip = 0
    while (skip < utterance.length && fillers.has(utterance[skip]!.norm)) skip++
    utterance = utterance.slice(skip)
    if (utterance.length === 0) return undefined

    let best: { readonly phrase: CompiledPhrase; readonly used: number; readonly end: number; readonly score: number } | undefined
    for (const phrase of phrases) {
      const m = matchPhrase(utterance, phrase)
      if (m === undefined) continue
      // More words matched wins ("hey open router" over "hey open"), then the better score, then rule order.
      if (best === undefined || m.used > best.used || (m.used === best.used && m.score > best.score)) {
        best = { phrase, used: m.used, end: m.end, score: m.score }
      }
    }
    if (best === undefined) return undefined
    return {
      rule: best.phrase.rule,
      agentId: resolve(best.phrase.agent),
      mode: best.phrase.mode,
      phrase: best.phrase.text,
      matched: text.slice(utterance[0]!.start, best.end),
      end: best.end,
      score: best.score
    }
  }

  const route = (input: RouteInput): RouteDecision => {
    const { now, state } = input
    const trigger = matchTrigger(input.text)
    const text = trigger === undefined ? input.text.trim() : remainderAfter(input.text, trigger.end)
    const stickyLive = state.sticky !== undefined && now - state.sticky.lastUsedAt < config.stickyIdleMs
    const keptSticky = stickyLive ? state.sticky : undefined

    let wanted: string
    let reason: RouteReason
    let next: RouterState
    let acknowledge: string | undefined
    if (input.explicitAgent !== undefined) {
      wanted = input.explicitAgent
      reason = "explicit"
      next = { sticky: keptSticky }
    } else if (trigger !== undefined) {
      wanted = trigger.agentId
      reason = "trigger"
      const isDefault = config.rules[trigger.rule]?.agent === DEFAULT_AGENT_REF || wanted === config.defaultAgent
      const sticky = trigger.mode === "conversation" ? (isDefault ? undefined : { agentId: wanted, lastUsedAt: now }) : keptSticky
      if (text.length === 0) {
        acknowledge = config.acknowledgement
        next = { sticky, armed: { agentId: wanted, until: now + config.armedMs } }
      } else {
        next = { sticky }
      }
    } else if (state.armed !== undefined && now < state.armed.until) {
      wanted = state.armed.agentId
      reason = "armed"
      next = { sticky: keptSticky?.agentId === wanted ? { agentId: wanted, lastUsedAt: now } : keptSticky }
    } else if (keptSticky !== undefined) {
      wanted = keptSticky.agentId
      reason = "sticky"
      next = { sticky: { agentId: wanted, lastUsedAt: now } }
    } else {
      wanted = config.defaultAgent
      reason = "default"
      next = {}
    }

    const base = {
      reason,
      text,
      ...(trigger !== undefined ? { trigger } : {}),
      ...(acknowledge !== undefined ? { acknowledge } : {})
    }
    if (input.isAvailable(wanted)) return { ...base, agentId: wanted, next: clean(next) }

    // Not running: the default answers (or the fallback), and nothing sticks to or arms the missing agent.
    const replacement = [config.defaultAgent, config.fallbackAgent].find((a): a is string => a !== undefined && a !== wanted && input.isAvailable(a))
    const without: RouterState = {
      sticky: next.sticky?.agentId === wanted ? undefined : next.sticky,
      armed: next.armed?.agentId === wanted ? undefined : next.armed
    }
    return { ...base, agentId: replacement, unavailable: wanted, next: clean(without) }
  }

  return { route, matchTrigger }
}

const clean = (state: RouterState): RouterState => ({
  ...(state.sticky !== undefined ? { sticky: state.sticky } : {}),
  ...(state.armed !== undefined ? { armed: state.armed } : {})
})
