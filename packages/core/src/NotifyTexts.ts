/**
 * Every sentence and label the notification service shows or says itself, in English and Dutch (docs/NOTIFICATIONS.md
 * "Languages"), chosen by the household's language (`HOME_LANGUAGE`: `nl…` is Dutch, anything else English, the rule
 * `homeLanguage` of `@pva/module-contracts` uses). The core cannot depend on that package (it depends on the core), so
 * the service keeps its own small table of the same shape. None of these texts holds a number or a time; a module
 * that words one uses `@pva/language`.
 */
export type NotifyLanguage = "en" | "nl"

const TEXTS = {
  en: {
    stop: "Stop",
    cantNow: "I can't do that right now.",
    done: "Done.",
    over: "That has ended already.",
    failed: "That didn't work.",
    limit: "Too many notifications are waiting.",
    unavailable: "Notifications work only on the server.",
    busy: "The house was busy; try again.",
    notSent: "The notification could not be sent.",
    inTurn: "An announcement can't be waited for during a reply.",
    noDevice: "There is no device there to say it on.",
    notSaid: "That can't be announced here.",
    handling: "That is being handled already.",
    region: "Notifications",
    startAudio: "Start audio to hear it."
  },
  nl: {
    stop: "Stop",
    cantNow: "Dat kan ik nu niet doen.",
    done: "Klaar.",
    over: "Dat is al afgelopen.",
    failed: "Dat lukte niet.",
    limit: "Er wachten te veel meldingen.",
    unavailable: "Meldingen werken alleen op de server.",
    busy: "Het huis was bezig; probeer het opnieuw.",
    notSent: "De melding kon niet worden verstuurd.",
    inTurn: "Op een omroep kan niet worden gewacht tijdens een antwoord.",
    noDevice: "Daar is geen apparaat om het op te zeggen.",
    notSaid: "Dat kan hier niet worden omgeroepen.",
    handling: "Daar wordt al aan gewerkt.",
    region: "Meldingen",
    startAudio: "Zet het geluid aan om het te horen."
  }
} as const

export type NotifyTextKey = keyof typeof TEXTS.en

/** The household's language from a Home value (`HOME_LANGUAGE`). */
export const notifyLanguageOf = (homeLanguage: unknown): NotifyLanguage =>
  typeof homeLanguage === "string" && homeLanguage.toLowerCase().startsWith("nl") ? "nl" : "en"

export const notifyText = (language: NotifyLanguage, key: NotifyTextKey): string => TEXTS[language][key]

/** Both tables, for the test that compares their keys. */
export const NOTIFY_TEXTS = TEXTS

/**
 * The sentence for a module to say when a notification or speech call failed, in the household's language: a module
 * may use it as it is, or word its own.
 */
export const notifyRefusalText = (
  language: NotifyLanguage,
  error: { readonly _tag: "NotifyError" | "SpeechError"; readonly reason: string }
): string => {
  if (error._tag === "SpeechError") {
    return notifyText(language, error.reason === "in-turn" ? "inTurn" : error.reason === "no-device" ? "noDevice" : error.reason === "unavailable" ? "unavailable" : "notSaid")
  }
  return notifyText(language, error.reason === "limit" ? "limit" : error.reason === "busy" ? "busy" : error.reason === "unavailable" ? "unavailable" : "notSent")
}

/**
 * The chime before an announcement (`say(…, { cue: true })`): two short soft tones, falling, about 300 ms, generated
 * at the voice's rate (no asset file) and played in front of the announcement's audio, through the same output.
 * PCM s16le mono.
 */
export const announcementChime = (sampleRate: number): Uint8Array => {
  const tones: ReadonlyArray<{ readonly hz: number; readonly ms: number }> = [{ hz: 880, ms: 120 }, { hz: 660, ms: 160 }]
  const gapMs = 30
  const fadeMs = 12
  const peak = 0.16
  const total = Math.round(((tones.reduce((n, t) => n + t.ms, 0) + gapMs) * sampleRate) / 1000)
  const out = new Int16Array(total)
  let offset = 0
  tones.forEach((tone, i) => {
    const n = Math.round((tone.ms * sampleRate) / 1000)
    const fade = Math.max(1, Math.round((fadeMs * sampleRate) / 1000))
    for (let k = 0; k < n && offset + k < total; k++) {
      const edge = Math.min(k, n - 1 - k)
      const env = edge >= fade ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade)
      out[offset + k] = Math.round(peak * env * Math.sin((2 * Math.PI * tone.hz * k) / sampleRate) * 32767)
    }
    offset += n + (i === 0 ? Math.round((gapMs * sampleRate) / 1000) : 0)
  })
  return new Uint8Array(out.buffer)
}
