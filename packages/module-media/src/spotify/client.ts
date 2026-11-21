import { CredentialError, type ModuleCredentials, nameKey } from "@pva/core"
import { contentTypes, type Connector, makeFixedApi, NetFailure, NetTimeout, type Resolver, type SafeResponse } from "@pva/net"
import { randomBytes } from "node:crypto"
import { Effect, Fiber, type Scope } from "effect"
import { httpsUrl, type AccessToken, type MusicItem, type MusicKind, MusicError, type MusicQuery, type MusicSource, nameOf } from "../music.ts"

/**
 * Spotify behind `MusicSource` (docs/modules/media.md §3, §7): the owner's own Spotify developer app, signed in once with
 * the Authorization Code flow (the client secret stays on the server), and the Web API for what the page's player cannot
 * do itself: search, and "start this on that player". Pause, resume, volume and seek go to the page's player, not here.
 *
 * - **Tokens.** The refresh token is the one thing kept (`host.credentials`, the key vault), with the sign-in date and the
 *   display name beside it (`spotify-signin`, a small JSON). Access tokens last an hour: held in memory, refreshed when
 *   less than two minutes are left (one refresh at a time, shared by every caller, run in the module's own scope so one
 *   caller's interruption does not cancel the others'), and handed to the page's own player on its request.
 *   A refresh answer may carry a new refresh token: it replaces the old one in the vault. `invalid_grant` means the sign-in
 *   ended (refresh tokens end six months after sign-in; refreshing does not extend that): the credentials are cleared and
 *   the status says to sign in again.
 * - **Locked vault.** The token the module started with is kept in memory; a rotated token that cannot be written is kept
 *   in memory too and `cannotRenew` says so. A vault that is locked when the module starts leaves it signed out with `locked`.
 * - **Calls.** One `makeFixedApi` for `api.spotify.com` and `accounts.spotify.com`; a GET is retried once after a 401
 *   (the token is renewed), a PUT or POST never (it is reported: the person says it again); a 429 carries `Retry-After`.
 *   Nothing a response says is trusted beyond its shape: a field Spotify has removed (popularity, markets, previews) is
 *   never read.
 * - **Never in a result, a log line or a status**: the secret, a code, a token. Errors carry a reason and a short detail.
 */

export const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state",
  "user-read-currently-playing",
  "playlist-read-private"
].join(" ")

/** The credential names (docs/MODULES.md §8: a name matches `^[a-z][a-z0-9-]{0,31}$`). */
export const REFRESH_CREDENTIAL = "spotify-refresh"
export const SIGNIN_CREDENTIAL = "spotify-signin"

/** A sign-in attempt (the `state` Spotify sends back) is valid this long, and once. */
export const STATE_TTL_MS = 10 * 60_000
/** Sign-in attempts held at once. */
const MAX_PENDING = 16
/** An access token with less than this left is renewed before use. */
const RENEW_BEFORE_MS = 120_000
/** The longest a search or a play call may take, unless the caller says. */
const CALL_MS = 1_500
/** Spotify's answers are small; a page of 50 playlists is the biggest. */
const MAX_BYTES = 256 * 1024

const SEARCH_TYPES = ["track", "album", "artist", "playlist"] as const

/** What the module knows of the sign-in, read synchronously (the admin page's info line, health, the prepare of pages). */
export type AccountStatus =
  | { readonly kind: "not-set" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "ended" }
  | { readonly kind: "locked" }
  | { readonly kind: "unavailable" }
  | {
    readonly kind: "signed-in"
    readonly name?: string
    /** Epoch ms of the sign-in, when known. */
    readonly since?: number
    /** Epoch ms the sign-in ends (six months after it), when known. */
    readonly endsAt?: number
    /** A renewed token could not be written to the vault: the sign-in cannot be renewed until it is unlocked. */
    readonly cannotRenew: boolean
  }

export type SignInOutcome = "ok" | "expired" | "refused" | "locked" | "failed"

export interface SpotifyOptions {
  readonly clientId: string | undefined
  readonly clientSecret: string | undefined
  readonly credentials: ModuleCredentials
  readonly net: { readonly resolver?: Resolver; readonly connector?: Connector }
  /** The module's shared scope: a token refresh runs in it. */
  readonly scope: Scope.Scope
  /** Epoch ms now, on the Effect clock (so a test clock drives it). */
  readonly now: () => number
  /** The sign-in state changed (signed in, out, ended, a token could not be kept). */
  readonly onChange: () => void
  /** One line for the log; never a token, a secret or a response's text. */
  readonly log?: (line: string) => void
}

export interface Spotify {
  readonly source: MusicSource
  readonly configured: boolean
  readonly status: () => AccountStatus
  /** True while the last token refresh or call showed the client ID or secret is refused. */
  readonly clientRefused: () => boolean
  /**
   * Start a sign-in that returns to `redirectUri`: the address to send the browser to, or `undefined` when not configured.
   * `binding` is a random value the caller also gives the same browser (a cookie); `completeSignIn` needs it back, so a
   * `state` that reaches another browser's callback (login CSRF) is refused.
   */
  readonly beginSignIn: (redirectUri: string, binding: string) => string | undefined
  readonly completeSignIn: (code: string, state: string, binding: string | undefined) => Effect.Effect<SignInOutcome>
  /** `none`: nobody was signed in. `locked`: the vault is locked, so nothing was cleared. */
  readonly signOut: Effect.Effect<"ok" | "none" | "locked">
}

const addMonths = (epochMs: number, months: number): number => {
  const d = new Date(epochMs)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.getTime()
}

const enc = encodeURIComponent

const parse = (res: SafeResponse): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(res.text())
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const object = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const list = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : [])

const URI = /^spotify:(track|album|artist|playlist):[A-Za-z0-9]{1,64}$/

/** One search result or playlist as an item, or `undefined` when it lacks what the module needs (Spotify lists can hold nulls). */
export const itemOf = (kind: MusicKind, raw: unknown): MusicItem | undefined => {
  const o = object(raw)
  if (o === undefined || typeof o.uri !== "string") return undefined
  const m = URI.exec(o.uri)
  if (m === null || m[1] !== kind) return undefined
  const name = nameOf(o.name)
  if (name === undefined) return undefined
  const artists = list(o.artists)
  const by = kind === "track" || kind === "album"
    ? nameOf(object(artists[0])?.name)
    : kind === "playlist"
    ? nameOf(object(o.owner)?.display_name)
    : undefined
  // A track's cover is its album's.
  const images = list(kind === "track" ? object(o.album)?.images : o.images)
  const artUrl = httpsUrl(object(images[0])?.url)
  const link = httpsUrl(object(o.external_urls)?.spotify)
  return { source: "spotify", kind, uri: o.uri, name, ...(by !== undefined ? { by } : {}), ...(artUrl !== undefined ? { artUrl } : {}), ...(link !== undefined ? { link } : {}) }
}

/**
 * The pick rule (documented in docs/modules/media.md): among the results, a name equal to the words asked (compared as
 * Members compares names, `nameKey`) wins, looking at tracks, then albums, then artists, then playlists (or only the kind
 * asked for); otherwise the first result of the kind asked for, or with no kind the first track, else the first album,
 * artist or playlist. Spotify's own order is its relevance.
 */
export const pickItem = (found: Readonly<Record<MusicKind, ReadonlyArray<MusicItem>>>, query: string, kind: MusicKind | undefined): MusicItem | undefined => {
  const order: ReadonlyArray<MusicKind> = kind !== undefined ? [kind] : SEARCH_TYPES
  const wanted = nameKey(query)
  if (wanted !== "") {
    for (const k of order) {
      const exact = found[k].find((i) => nameKey(i.name) === wanted)
      if (exact !== undefined) return exact
    }
  }
  for (const k of order) if (found[k][0] !== undefined) return found[k][0]
  return undefined
}

/** `track:"…" artist:"…"` and its kin: Spotify's field filters, with quotes taken out of the words. */
export const searchText = (query: string, kind: MusicKind | undefined, artist: string | undefined): string => {
  const words = query.replace(/"/g, " ").replace(/\s+/g, " ").trim()
  const by = artist?.replace(/"/g, " ").replace(/\s+/g, " ").trim()
  if (by === undefined || by === "") return words
  // Filters exist for tracks and albums; for the rest (or no kind) the artist's name is just more words, as a filter on the whole.
  if (kind === "track" || kind === "album") return `${kind}:"${words}" artist:"${by}"`
  if (kind === undefined) return `${words} artist:"${by}"`
  return `${words} ${by}`
}

export const makeSpotify = (o: SpotifyOptions): Effect.Effect<Spotify> =>
  Effect.gen(function*() {
    const api = makeFixedApi({ hosts: ["api.spotify.com", "accounts.spotify.com"] })
    const clientId = o.clientId?.trim() ?? ""
    const clientSecret = o.clientSecret ?? ""
    const configured = clientId !== "" && clientSecret !== ""
    const log = o.log ?? (() => undefined)

    let refresh: string | undefined
    let signedInAt: number | undefined
    let name: string | undefined
    let vault: "ok" | "locked" | "unavailable" = "ok"
    let ended = false
    let cannotRenew = false
    let refused = false
    let access: AccessToken | undefined
    let inflight: Fiber.Fiber<AccessToken, MusicError> | undefined
    /** Counts every change of who is signed in (a sign-in, a sign-out, an ended sign-in): a refresh that began under an older one is dropped. */
    let generation = 0
    const pending = new Map<string, { readonly redirectUri: string; readonly binding: string; readonly expires: number }>()

    // -- what the vault holds ----------------------------------------------------------------------------------------
    const stored = yield* o.credentials.get(REFRESH_CREDENTIAL).pipe(Effect.result)
    if (stored._tag === "Success") {
      refresh = stored.success
      if (refresh !== undefined) {
        const meta = yield* o.credentials.get(SIGNIN_CREDENTIAL).pipe(Effect.orElseSucceed(() => undefined))
        try {
          const m = meta === undefined ? undefined : object(JSON.parse(meta))
          if (m !== undefined) {
            if (typeof m.at === "number" && Number.isFinite(m.at)) signedInAt = m.at
            if (typeof m.name === "string") name = nameOf(m.name)
          }
        } catch {
          // A damaged note about the sign-in is not a damaged sign-in: the date is simply not known.
        }
      }
    } else {
      vault = stored.failure.reason === "locked" ? "locked" : "unavailable"
    }

    const changed = () => {
      try {
        o.onChange()
      } catch {
        // The listener is the module's own; nothing it does may break a call.
      }
    }

    const status = (): AccountStatus => {
      if (!configured) return { kind: "not-set" }
      if (refresh === undefined) {
        if (vault === "locked") return { kind: "locked" }
        if (vault === "unavailable") return { kind: "unavailable" }
        return ended ? { kind: "ended" } : { kind: "signed-out" }
      }
      return {
        kind: "signed-in",
        ...(name !== undefined ? { name } : {}),
        ...(signedInAt !== undefined ? { since: signedInAt, endsAt: addMonths(signedInAt, 6) } : {}),
        cannotRenew
      }
    }

    // -- one call ----------------------------------------------------------------------------------------------------
    const netError = (method: string) => (e: unknown): MusicError => {
      if (e instanceof NetTimeout) return new MusicError({ reason: "timeout", detail: `${method}: no answer in time` })
      if (e instanceof NetFailure) {
        // Written, then lost: whether a change was carried out is unknown.
        if (e.requestSent === true) return new MusicError({ reason: "timeout", detail: `${method}: the connection ended after the request was sent` })
        return new MusicError({ reason: "unreachable", detail: `${method}: ${e.stage}` })
      }
      const tag = typeof e === "object" && e !== null && "_tag" in e ? String((e as { _tag: unknown })._tag) : "error"
      return new MusicError({ reason: "failed", detail: `${method}: ${tag}` })
    }

    const http = (
      method: "GET" | "PUT" | "POST",
      url: string,
      options: { readonly headers: Readonly<Record<string, string>>; readonly json?: unknown; readonly form?: Readonly<Record<string, string>>; readonly timeoutMs?: number }
    ) =>
      api.call(url, {
        method,
        accept: contentTypes.json,
        maxBytes: MAX_BYTES,
        timeoutMs: options.timeoutMs ?? CALL_MS,
        headers: options.headers,
        ...(options.json !== undefined ? { json: options.json } : {}),
        ...(options.form !== undefined ? { form: options.form } : {}),
        ...o.net
      }).pipe(Effect.mapError(netError(method)))

    /** What a non-2xx answer means. */
    const failure = (res: SafeResponse, what: string): MusicError => {
      const body = parse(res)
      const error = object(body?.error)
      switch (res.status) {
        case 401:
          return new MusicError({ reason: "unauthorized", detail: `${what}: 401` })
        case 403: {
          const reason = typeof error?.reason === "string" ? error.reason : ""
          const message = typeof error?.message === "string" ? error.message : ""
          return new MusicError({ reason: reason === "PREMIUM_REQUIRED" || /premium/i.test(message) ? "premium" : "forbidden", detail: `${what}: 403` })
        }
        case 404:
          return new MusicError({ reason: "not_found", detail: `${what}: 404` })
        case 429: {
          const wait = Number(res.headers["retry-after"])
          return new MusicError({ reason: "busy", detail: `${what}: 429`, ...(Number.isFinite(wait) && wait >= 0 ? { retryAfterSeconds: Math.min(wait, 3_600) } : {}) })
        }
        default:
          return new MusicError({ reason: "failed", detail: `${what}: ${res.status}` })
      }
    }

    // -- the token endpoint ------------------------------------------------------------------------------------------
    const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`
    const tokenCall = (form: Readonly<Record<string, string>>, timeoutMs = 3_000) =>
      http("POST", "https://accounts.spotify.com/api/token", { headers: { authorization: basic }, form, timeoutMs })

    const accessFrom = (body: Record<string, unknown> | undefined): { readonly access: AccessToken; readonly refresh?: string } | undefined => {
      const token = body?.access_token
      if (typeof token !== "string" || token === "") return undefined
      const seconds = typeof body?.expires_in === "number" && Number.isFinite(body.expires_in) ? Math.max(60, Math.min(body.expires_in, 86_400)) : 3_600
      const next = typeof body?.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : undefined
      return { access: { token, expiresAtMs: o.now() + seconds * 1000 }, ...(next !== undefined ? { refresh: next } : {}) }
    }

    /** The sign-in ended for good: forget it (the vault too, as far as it can be reached). */
    const endSignIn = Effect.gen(function*() {
      generation++
      refresh = undefined
      access = undefined
      signedInAt = undefined
      name = undefined
      ended = true
      cannotRenew = false
      yield* o.credentials.clear(REFRESH_CREDENTIAL).pipe(Effect.ignore)
      yield* o.credentials.clear(SIGNIN_CREDENTIAL).pipe(Effect.ignore)
      log("The Spotify sign-in has ended")
      changed()
    })

    const notSignedIn = (): MusicError => {
      const s = status()
      return new MusicError({
        reason: s.kind === "not-set" ? "not_set" : s.kind === "ended" ? "ended" : s.kind === "locked" ? "locked" : "not_signed_in",
        detail: s.kind
      })
    }

    const doRefresh: Effect.Effect<AccessToken, MusicError> = Effect.gen(function*() {
      const current = refresh
      if (current === undefined || !configured) return yield* notSignedIn()
      const began = generation
      const res = yield* tokenCall({ grant_type: "refresh_token", refresh_token: current })
      // Who is signed in changed while the answer was on its way (a sign-out, a new sign-in): it is of no use and is never kept.
      if (began !== generation) return yield* (refresh === undefined ? Effect.fail(notSignedIn()) : doRefresh)
      if (res.status !== 200) {
        const code = parse(res)?.error
        if (code === "invalid_grant") {
          yield* endSignIn
          return yield* new MusicError({ reason: "ended", detail: "refresh: invalid_grant" })
        }
        if (code === "invalid_client" || res.status === 401) {
          refused = true
          changed()
          return yield* new MusicError({ reason: "client", detail: "refresh: the client ID or secret was refused" })
        }
        return yield* failure(res, "refresh")
      }
      const got = accessFrom(parse(res))
      if (got === undefined) return yield* new MusicError({ reason: "failed", detail: "refresh: no access token in the answer" })
      refused = false
      access = got.access
      // A new refresh token replaces the old one, in memory at once and in the vault if it can be reached.
      if (got.refresh !== undefined && got.refresh !== current) {
        refresh = got.refresh
        const kept = yield* o.credentials.set(REFRESH_CREDENTIAL, got.refresh).pipe(Effect.result)
        if (kept._tag === "Failure") {
          cannotRenew = true
          log(`A renewed Spotify sign-in could not be kept (${kept.failure instanceof CredentialError ? kept.failure.reason : "error"})`)
          changed()
        } else if (cannotRenew) {
          cannotRenew = false
          changed()
        }
      }
      return got.access
    })

    /** One refresh at a time: whoever comes while one runs waits for it. It runs in the module's scope, so no caller can cancel it for the rest. */
    const renew: Effect.Effect<AccessToken, MusicError> = Effect.suspend(() => {
      if (inflight !== undefined) return Fiber.join(inflight)
      return Effect.gen(function*() {
        const fiber: Fiber.Fiber<AccessToken, MusicError> = yield* Effect.forkIn(
          doRefresh.pipe(Effect.ensuring(Effect.sync(() => void (inflight = undefined)))),
          o.scope
        )
        inflight = fiber
        return yield* Fiber.join(fiber)
      })
    })

    const accessToken: Effect.Effect<AccessToken, MusicError> = Effect.suspend(() => {
      if (!configured || refresh === undefined) return Effect.fail(notSignedIn())
      const have = access
      if (have !== undefined && have.expiresAtMs - o.now() > RENEW_BEFORE_MS) return Effect.succeed(have)
      return renew
    })

    /** A call with the access token: a 401 renews it; a GET goes again once, a PUT or POST is reported (it was refused, not run). */
    const authed = (method: "GET" | "PUT" | "POST", url: string, options: { readonly json?: unknown; readonly timeoutMs?: number } = {}) =>
      Effect.gen(function*() {
        const first = yield* accessToken
        const res = yield* http(method, url, { ...options, headers: { authorization: `Bearer ${first.token}` } })
        if (res.status !== 401) return res
        access = undefined
        const second = yield* renew
        if (method !== "GET") return yield* new MusicError({ reason: "unauthorized", detail: `${method}: the access token was refused and has been renewed` })
        return yield* http(method, url, { ...options, headers: { authorization: `Bearer ${second.token}` } })
      })

    // -- search ------------------------------------------------------------------------------------------------------
    const ownPlaylists = (timeoutMs: number) =>
      authed("GET", "https://api.spotify.com/v1/me/playlists?limit=50", { timeoutMs }).pipe(
        Effect.flatMap((res) =>
          res.status >= 200 && res.status < 300
            ? Effect.succeed(list(parse(res)?.items).flatMap((x) => itemOf("playlist", x) ?? []))
            : Effect.fail(failure(res, "playlists"))
        ),
        // Not being able to read the owner's own playlists (a refused scope, a hiccup) is not the end: the search goes on.
        Effect.catchIf((e) => e.reason === "forbidden" || e.reason === "failed" || e.reason === "not_found", () => Effect.succeed<ReadonlyArray<MusicItem>>([]))
      )

    const find: MusicSource["find"] = (q, options = {}) =>
      Effect.gen(function*() {
        const timeoutMs = options.timeoutMs ?? CALL_MS
        const words = q.query.trim()
        if (q.kind === "playlist") {
          const wanted = nameKey(words)
          const own = (yield* ownPlaylists(timeoutMs)).find((p) => wanted !== "" && nameKey(p.name) === wanted)
          if (own !== undefined) return own
        }
        const types = q.kind !== undefined ? [q.kind] : [...SEARCH_TYPES]
        const url = `https://api.spotify.com/v1/search?q=${enc(searchText(words, q.kind, q.artist))}&type=${types.join(",")}&limit=5`
        const res = yield* authed("GET", url, { timeoutMs })
        if (res.status < 200 || res.status >= 300) return yield* failure(res, "search")
        const body = parse(res)
        const found = Object.fromEntries(
          SEARCH_TYPES.map((k) => [k, list(object(body?.[`${k}s`])?.items).flatMap((x) => itemOf(k, x) ?? [])])
        ) as unknown as Record<MusicKind, ReadonlyArray<MusicItem>>
        return pickItem(found, words, q.kind)
      })

    const play: MusicSource["play"] = (item, playerId, options = {}) =>
      authed("PUT", `https://api.spotify.com/v1/me/player/play?device_id=${enc(playerId)}`, {
        json: item.kind === "track" ? { uris: [item.uri] } : { context_uri: item.uri },
        timeoutMs: options.timeoutMs ?? CALL_MS
      }).pipe(Effect.flatMap((res) => (res.status >= 200 && res.status < 300 ? Effect.void : Effect.fail(failure(res, "play")))))

    const enqueue: MusicSource["enqueue"] = (item, playerId, options = {}) =>
      authed("POST", `https://api.spotify.com/v1/me/player/queue?uri=${enc(item.uri)}&device_id=${enc(playerId)}`, { timeoutMs: options.timeoutMs ?? CALL_MS }).pipe(
        Effect.flatMap((res) => (res.status >= 200 && res.status < 300 ? Effect.void : Effect.fail(failure(res, "queue"))))
      )

    // -- signing in --------------------------------------------------------------------------------------------------
    const beginSignIn = (redirectUri: string, binding: string): string | undefined => {
      if (!configured) return undefined
      const at = o.now()
      for (const [k, v] of pending) if (v.expires <= at) pending.delete(k)
      while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!)
      const state = randomBytes(24).toString("base64url")
      pending.set(state, { redirectUri, binding, expires: at + STATE_TTL_MS })
      return `https://accounts.spotify.com/authorize?response_type=code&client_id=${enc(clientId)}&scope=${enc(SPOTIFY_SCOPES)}&redirect_uri=${enc(redirectUri)}&state=${enc(state)}`
    }

    const completeSignIn = (code: string, state: string, binding: string | undefined): Effect.Effect<SignInOutcome> =>
      Effect.gen(function*() {
        const entry = pending.get(state)
        // Single use, whatever follows.
        pending.delete(state)
        // The browser that comes back must be the one that left (`binding`), or the state is as good as unknown.
        if (entry === undefined || entry.expires <= o.now() || !configured || binding === undefined || binding !== entry.binding) return "expired" as const
        const res = yield* tokenCall({ grant_type: "authorization_code", code, redirect_uri: entry.redirectUri }, 5_000).pipe(Effect.result)
        if (res._tag === "Failure") return "failed" as const
        if (res.success.status !== 200) return "refused" as const
        const got = accessFrom(parse(res.success))
        if (got === undefined || got.refresh === undefined) return "refused" as const
        // Before the vault is written: a refresh still on its way from the earlier sign-in must not land after the new one.
        generation++
        const kept = yield* o.credentials.set(REFRESH_CREDENTIAL, got.refresh).pipe(Effect.result)
        if (kept._tag === "Failure") return kept.failure.reason === "locked" ? ("locked" as const) : ("failed" as const)
        generation++
        refresh = got.refresh
        access = got.access
        ended = false
        cannotRenew = false
        refused = false
        vault = "ok"
        signedInAt = o.now()
        // The display name is a courtesy: a sign-in without it is still a sign-in.
        const me = yield* http("GET", "https://api.spotify.com/v1/me", { headers: { authorization: `Bearer ${got.access.token}` }, timeoutMs: 2_500 }).pipe(Effect.result)
        const body = me._tag === "Success" && me.success.status === 200 ? parse(me.success) : undefined
        name = nameOf(body?.display_name) ?? nameOf(body?.id)
        yield* o.credentials.set(SIGNIN_CREDENTIAL, JSON.stringify({ at: signedInAt, ...(name !== undefined ? { name } : {}) })).pipe(Effect.ignore)
        changed()
        return "ok" as const
      })

    const signOut: Effect.Effect<"ok" | "none" | "locked"> = Effect.gen(function*() {
      const had = refresh !== undefined
      generation++
      const cleared = yield* o.credentials.clear(REFRESH_CREDENTIAL).pipe(Effect.result)
      if (cleared._tag === "Failure" && cleared.failure.reason === "locked") return "locked" as const
      yield* o.credentials.clear(SIGNIN_CREDENTIAL).pipe(Effect.ignore)
      const existed = had || (cleared._tag === "Success" && cleared.success)
      generation++
      refresh = undefined
      access = undefined
      signedInAt = undefined
      name = undefined
      ended = false
      cannotRenew = false
      pending.clear()
      changed()
      return existed ? ("ok" as const) : ("none" as const)
    })

    const source: MusicSource = { id: "spotify", find, play, enqueue, accessToken }
    return { source, configured, status, clientRefused: () => refused, beginSignIn, completeSignIn, signOut }
  })
