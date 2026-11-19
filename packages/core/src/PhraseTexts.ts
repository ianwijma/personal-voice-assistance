import type { PhraseLanguage } from "./Phrases.ts"

/**
 * Every sentence the host says itself for a phrase command or an essential control, in English and Dutch, chosen by
 * the household's language (`HOME_LANGUAGE`, `phraseLanguageOf`: `nl…` is Dutch, anything else English), the same rule
 * and the same kind of small table as the notification service's (`NotifyTexts.ts`; the core cannot use
 * `defineTexts` of `@pva/module-contracts`, which depends on it). A module's own answer (its action's `say`, or the
 * message of its `ActionError`) is the module's, in the household's language already.
 */
const TEXTS = {
  en: {
    cantNow: "I can't do that right now.",
    notAllowed: "I'm not allowed to do that.",
    failed: "That didn't work.",
    couldNotStop: "I couldn't stop that.",
    busy: "One moment, I'm still doing the last one.",
    nothingToRepeat: "I haven't said anything yet.",
    louder: "Louder.",
    quieter: "Quieter.",
    loudest: "That's as loud as I go.",
    quietest: "That's as quiet as I go."
  },
  nl: {
    cantNow: "Dat kan ik nu niet doen.",
    notAllowed: "Dat mag ik niet doen.",
    failed: "Dat lukte niet.",
    couldNotStop: "Dat kon ik niet stoppen.",
    busy: "Een moment, ik ben nog met de vorige bezig.",
    nothingToRepeat: "Ik heb nog niets gezegd.",
    louder: "Harder.",
    quieter: "Zachter.",
    loudest: "Harder kan ik niet.",
    quietest: "Zachter kan ik niet."
  }
} as const

export type PhraseTextKey = keyof typeof TEXTS.en

export const phraseText = (language: PhraseLanguage, key: PhraseTextKey): string => TEXTS[language][key]

/** Both tables, for the test that compares their keys. */
export const PHRASE_TEXTS = TEXTS
