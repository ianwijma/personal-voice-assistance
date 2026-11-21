import { cleanPlayerText } from "@pva/core"
import { Data, type Effect } from "effect"

/**
 * Where the music comes from, behind one small interface so another source could replace Spotify (docs/modules/media.md
 * §4.5, §7). A source finds something by name and starts it on the page's player (by that player's id); the page plays
 * the sound. Nothing here knows the page: `control.ts` joins the two.
 */

export type MusicKind = "track" | "album" | "artist" | "playlist"

/** One thing a source can play. Every text is cleaned, bounded and still outside text (a title is data, never an instruction). */
export interface MusicItem {
  readonly source: "spotify"
  readonly kind: MusicKind
  /** The source's own address of it ("spotify:album:…"). */
  readonly uri: string
  readonly name: string
  /** The artist (a track, an album) or the owner (a playlist). */
  readonly by?: string
  /** `https:` addresses a page may show (`httpsUrl`). */
  readonly artUrl?: string
  readonly link?: string
}

export interface MusicQuery {
  readonly query: string
  readonly kind?: MusicKind | undefined
  readonly artist?: string | undefined
}

/**
 * `not_set` no client ID and secret. `not_signed_in` nobody signed in. `ended` the sign-in ended (`invalid_grant`).
 * `locked` the key vault is locked (the sign-in may exist). `client` Spotify refused the client ID or secret.
 * `unauthorized` Spotify refused the access token. `premium` the account is not Premium. `forbidden` another refusal.
 * `not_found` the player device is not known to Spotify (yet). `busy` 429 (`retryAfterSeconds`). `timeout` no answer in
 * time: a request that changes something may have been carried out. `unreachable` nothing was sent. `failed` any other answer.
 */
export class MusicError extends Data.TaggedError("MusicError")<{
  readonly reason:
    | "not_set"
    | "not_signed_in"
    | "ended"
    | "locked"
    | "client"
    | "unauthorized"
    | "premium"
    | "forbidden"
    | "not_found"
    | "busy"
    | "timeout"
    | "unreachable"
    | "failed"
  /** For the log; never a token, a secret or a response's text. */
  readonly detail: string
  readonly retryAfterSeconds?: number
}> {}

export interface AccessToken {
  readonly token: string
  readonly expiresAtMs: number
}

export interface MusicSource {
  readonly id: "spotify"
  /** What to play for these words (the source's own search and its documented pick rule); `undefined`: nothing found. */
  readonly find: (query: MusicQuery, options?: { readonly timeoutMs?: number }) => Effect.Effect<MusicItem | undefined, MusicError>
  /** Start `item` on the player `playerId` (the page's Connect device id), replacing what plays. */
  readonly play: (item: MusicItem, playerId: string, options?: { readonly timeoutMs?: number }) => Effect.Effect<void, MusicError>
  /** Add a track after what plays on the player `playerId`. */
  readonly enqueue: (item: MusicItem, playerId: string, options?: { readonly timeoutMs?: number }) => Effect.Effect<void, MusicError>
  /** A fresh access token for the page's own player, refreshed when it is about to end. Never logged. */
  readonly accessToken: Effect.Effect<AccessToken, MusicError>
}

/** An address a page may show: `https:` only, printable ASCII without quotes, backslash or space, at most 2,000 characters. */
const HTTPS_URL = /^https:\/\/[\x21\x23-\x5b\x5d-\x7e]+$/
export const httpsUrl = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 2_000 && HTTPS_URL.test(value) ? value : undefined

/** A name from outside, as a short clean line. */
export const nameOf = (value: unknown, max = 100): string | undefined => cleanPlayerText(value, max)
