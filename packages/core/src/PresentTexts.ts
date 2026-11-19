import type { PresentPageTexts } from "@pva/protocol"
import type { NotifyLanguage } from "./NotifyTexts.ts"

/**
 * Every word the Presenter shows or says itself on a page, in English and Dutch, chosen by the household's language
 * (`HOME_LANGUAGE`, the rule of `notifyLanguageOf`). The note for the model (`ShowOutcome.note`) is not here: it is
 * written for the model, in English, which words the reply in the household's language itself.
 */
const TEXTS = {
  en: {
    region: "On screen",
    loading: "Loading the image…",
    imageMissing: "The image is not available.",
    timerDone: "Done",
    credit: "Image:",
    high: "High",
    low: "Low",
    done: "Done.",
    cantNow: "I can't do that right now.",
    over: "That has ended already.",
    failed: "That didn't work.",
    handling: "That is being handled already.",
    tooMany: "Too much at once; try again in a moment."
  },
  nl: {
    region: "Op het scherm",
    loading: "De afbeelding wordt geladen…",
    imageMissing: "De afbeelding is niet beschikbaar.",
    timerDone: "Klaar",
    credit: "Afbeelding:",
    high: "Hoog",
    low: "Laag",
    done: "Klaar.",
    cantNow: "Dat kan ik nu niet doen.",
    over: "Dat is al afgelopen.",
    failed: "Dat lukte niet.",
    handling: "Daar wordt al aan gewerkt.",
    tooMany: "Te veel tegelijk; probeer het zo opnieuw."
  }
} as const

export type PresentTextKey = keyof typeof TEXTS.en

export const presentText = (language: NotifyLanguage, key: PresentTextKey): string => TEXTS[language][key]

/** The stage's own words for a page. */
export const presentPageTexts = (language: NotifyLanguage): PresentPageTexts => {
  const t = TEXTS[language]
  return { region: t.region, loading: t.loading, imageMissing: t.imageMissing, failed: t.failed, timerDone: t.timerDone, credit: t.credit, high: t.high, low: t.low }
}

/** Both tables, for the test that compares their keys. */
export const PRESENT_TEXTS = TEXTS
