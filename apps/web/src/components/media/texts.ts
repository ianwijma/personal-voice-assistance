/**
 * The words of the player surfaces. The voice page's own controls are fixed English strings; the household's language
 * reaches the page only through server texts, and the media messages carry none. So this page chooses by its own
 * language (`<html lang>`, then the browser's): English and Dutch, English for anything else.
 */
export interface MediaTexts {
  readonly nowPlaying: string
  readonly previous: string
  readonly next: string
  readonly play: string
  readonly pause: string
  readonly close: string
  readonly closeVideo: string
  readonly volume: string
  readonly position: string
  readonly spotify: string
  readonly openInSpotify: string
  readonly loading: string
  readonly blocked: string
  readonly video: string
  readonly openOnYoutube: string
  readonly errors: Readonly<Record<string, string>>
  readonly fallbackError: string
}

const en: MediaTexts = {
  nowPlaying: "Now playing",
  previous: "Previous track",
  next: "Next track",
  play: "Play",
  pause: "Pause",
  close: "Close music player",
  closeVideo: "Close video",
  volume: "Volume",
  position: "Position",
  spotify: "Spotify",
  openInSpotify: "Open in Spotify",
  loading: "Loading…",
  blocked: "Tap play to start",
  video: "Video",
  openOnYoutube: "Watch on YouTube",
  errors: {
    embed_refused: "This video cannot be played here.",
    not_found: "This video was not found.",
    no_referrer: "YouTube did not accept this page.",
    playback_error: "This could not be played.",
    account_error: "Spotify needs a Premium account.",
    initialization_error: "This browser cannot play Spotify.",
    authentication_error: "Spotify did not accept the sign-in.",
    no_credential: "Spotify is not signed in."
  },
  fallbackError: "This could not be played."
}

const nl: MediaTexts = {
  nowPlaying: "Nu aan het spelen",
  previous: "Vorig nummer",
  next: "Volgend nummer",
  play: "Afspelen",
  pause: "Pauzeren",
  close: "Muziekspeler sluiten",
  closeVideo: "Video sluiten",
  volume: "Volume",
  position: "Positie",
  spotify: "Spotify",
  openInSpotify: "Openen in Spotify",
  loading: "Laden…",
  blocked: "Tik op afspelen om te starten",
  video: "Video",
  openOnYoutube: "Bekijk op YouTube",
  errors: {
    embed_refused: "Deze video kan hier niet worden afgespeeld.",
    not_found: "Deze video is niet gevonden.",
    no_referrer: "YouTube accepteerde deze pagina niet.",
    playback_error: "Dit kon niet worden afgespeeld.",
    account_error: "Spotify heeft een Premium-account nodig.",
    initialization_error: "Deze browser kan Spotify niet afspelen.",
    authentication_error: "Spotify accepteerde de aanmelding niet.",
    no_credential: "Spotify is niet aangemeld."
  },
  fallbackError: "Dit kon niet worden afgespeeld."
}

export const mediaTexts = (language?: string): MediaTexts => {
  const lang = (language ?? (typeof document !== "undefined" ? document.documentElement.lang : "") ?? "").toLowerCase() ||
    (typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "")
  return lang.startsWith("nl") ? nl : en
}

/** `m:ss`, or `h:mm:ss` from an hour. */
export const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`
}
