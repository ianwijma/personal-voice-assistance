import type { ClientState } from "../state.ts"
import { MediaController } from "./controller.ts"
import { SpotifyPlayer } from "./spotify.ts"
import { YoutubePlayer } from "./youtube.ts"
import type { PagePlayer } from "./types.ts"
import type { MediaStateMessage } from "@pva/protocol"

export { MediaController } from "./controller.ts"
export type { MediaView, PagePlayer } from "./types.ts"

export { MEDIA_SOURCES } from "./sources.ts"

/** The page's players. Creating them loads nothing: a provider's script is fetched on the server's `prepare`. */
export const createPagePlayers = (): ReadonlyArray<PagePlayer> => [new SpotifyPlayer(), new YoutubePlayer()]

export const createMediaController = (send: (m: MediaStateMessage) => boolean): MediaController =>
  new MediaController({ players: createPagePlayers(), send, ...(typeof document === "undefined" ? {} : { doc: document }) })

/**
 * Is the assistant talking with this person: woken (the wake phrase was heard), listening, hearing, thinking or
 * speaking its reply? From the page's own state, so the media is lowered or paused the moment the server says the
 * assistant is awake (`wake`, `state`) or the local player starts the reply, with no further round trip.
 */
export const isTalking = (s: ClientState): boolean =>
  s.woke !== undefined ||
  s.audio.playing !== undefined ||
  s.session.serverState === "listening" ||
  s.session.serverState === "hearing" ||
  s.session.serverState === "thinking" ||
  s.session.serverState === "speaking"
