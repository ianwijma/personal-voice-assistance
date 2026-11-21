// The media module's tests: Spotify as an offline network of fixtures (the module's own `makeFixedApi` runs against it),
// YouTube search as a stub of the `WebVideos` contract, and the device's page as the kit's scriptable `kit.players` page.
// Nothing here reaches a network.
import { type CredentialStore, makeMemoryCredentialStore, type ModuleDefinition, type ModuleRoute, type RouteRequest } from "@pva/core"
import { makeOfflineNet, type OfflineConnector, provide, startTestModule, stubService } from "@pva/core/testing"
import { WebVideos, type WebVideo, type WebVideoQuery, WebVideosError } from "@pva/module-contracts"
import { Effect } from "effect"
import { mediaModule } from "../src/index.ts"

export const REFRESH_TOKEN = "refresh-token-one"
export const CLIENT_SECRET = "client-secret-s3cret"
export const CLIENT_ID = "client1234"

const id = (n: number) => `${String(n).padStart(22, "0")}`
export const uri = (kind: "track" | "album" | "artist" | "playlist", n: number) => `spotify:${kind}:${id(n)}`

export const track = (n: number, name: string, artist: string) => ({
  uri: uri("track", n),
  name,
  artists: [{ name: artist }],
  album: { images: [{ url: `https://i.scdn.co/image/cover${n}` }] },
  external_urls: { spotify: `https://open.spotify.com/track/${id(n)}` },
  // Fields Spotify has removed or may remove: present or not, the module never reads them.
  popularity: 50
})
export const album = (n: number, name: string, artist: string) => ({
  uri: uri("album", n),
  name,
  artists: [{ name: artist }],
  images: [{ url: `https://i.scdn.co/image/album${n}` }],
  external_urls: { spotify: `https://open.spotify.com/album/${id(n)}` }
})
export const artist = (n: number, name: string) => ({ uri: uri("artist", n), name, images: [{ url: `https://i.scdn.co/image/artist${n}` }], external_urls: { spotify: `https://open.spotify.com/artist/${id(n)}` } })
export const playlist = (n: number, name: string, owner = "Spotify") => ({ uri: uri("playlist", n), name, owner: { display_name: owner }, images: [], external_urls: { spotify: `https://open.spotify.com/playlist/${id(n)}` } })

export interface Found {
  tracks: Array<unknown>
  albums: Array<unknown>
  artists: Array<unknown>
  playlists: Array<unknown>
}

/** One recorded call to a Spotify host. */
export interface Call {
  readonly method: string
  readonly url: string
  readonly auth: string | undefined
  readonly body: string | undefined
}

/** Spotify, as the tests program it. */
export const makeWorld = () => {
  const calls: Array<Call> = []
  const world = {
    calls,
    /** What a search finds (only the kinds asked for are answered). */
    found: { tracks: [], albums: [], artists: [], playlists: [] } as Found,
    /** The owner's own playlists. */
    mine: [] as Array<unknown>,
    /** Statuses the next calls to a path answer, in order, before the normal answer. */
    statuses: { search: [] as Array<number>, play: [] as Array<number>, queue: [] as Array<number>, token: [] as Array<number>, me: [] as Array<number> },
    /** Headers the next answers carry (a 429's Retry-After). */
    headers: {} as Record<string, string>,
    /** Token refreshes served; every one answers a new access token. */
    refreshes: 0,
    /** The refresh token the next refresh hands out (rotation); undefined: none. */
    rotateTo: undefined as string | undefined,
    invalidGrant: false,
    /** What the play endpoint answers 403 with. */
    playForbiddenReason: undefined as string | undefined,
    /** The play endpoint's connection ends after the request was written. */
    playBreaks: false,
    /** Every request breaks (no connection). */
    down: false,
    /** Requests to a path (the method and query included). */
    to: (path: string, method?: string) => calls.filter((c) => new URL(c.url).pathname === path && (method === undefined || c.method === method)),
    net: undefined as unknown as ReturnType<typeof makeOfflineNet>,
    deps: undefined as unknown as { resolver: ReturnType<typeof makeOfflineNet>["resolver"]; connector: OfflineConnector },
    creds: makeMemoryCredentialStore()
  }
  const record = (r: { readonly method: string; readonly url: URL; readonly headers: Readonly<Record<string, string>>; readonly body?: Uint8Array }) =>
    calls.push({ method: r.method, url: r.url.href, auth: r.headers.authorization, body: r.body === undefined ? undefined : new TextDecoder().decode(r.body) })
  const answer = (queue: Array<number>, ok: () => { readonly status?: number; readonly body?: unknown; readonly headers?: Readonly<Record<string, string>> }) => {
    const status = queue.shift()
    if (status !== undefined) {
      const forbidden = status === 403 && world.playForbiddenReason !== undefined
      return { status, headers: world.headers, body: forbidden ? { error: { status: 403, message: world.playForbiddenReason === "PREMIUM_REQUIRED" ? "Player command failed: Premium required" : "Forbidden", reason: world.playForbiddenReason } } : { error: { status } } }
    }
    return ok()
  }
  const only = (types: string | null, list: ReadonlyArray<string>) => (types ?? "").split(",").filter((t) => list.includes(t))
  const net = makeOfflineNet({
    "https://accounts.spotify.com/api/token": (req) => {
      record(req)
      const form = new URLSearchParams(new TextDecoder().decode(req.body))
      if (form.get("grant_type") === "authorization_code") {
        return form.get("code") === "good-code"
          ? { body: { access_token: "access-from-code", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-from-code" } }
          : { status: 400, body: { error: "invalid_grant", error_description: "Invalid authorization code" } }
      }
      if (world.invalidGrant) return { status: 400, body: { error: "invalid_grant" } }
      return answer(world.statuses.token, () => {
        world.refreshes++
        return { body: { access_token: `access-${world.refreshes}`, token_type: "Bearer", expires_in: 3600, ...(world.rotateTo !== undefined ? { refresh_token: world.rotateTo } : {}) } }
      })
    },
    "https://api.spotify.com/v1/search": (req) => {
      record(req)
      return answer(world.statuses.search, () => {
        const types = only(req.url.searchParams.get("type"), ["track", "album", "artist", "playlist"])
        const body: Record<string, unknown> = {}
        for (const t of types) body[`${t}s`] = { items: [null, ...(world.found[`${t}s` as keyof Found] as Array<unknown>)] }
        return { body }
      })
    },
    "https://api.spotify.com/v1/me/playlists": (req) => {
      record(req)
      return { body: { items: [null, ...world.mine] } }
    },
    "https://api.spotify.com/v1/me": (req) => {
      record(req)
      return answer(world.statuses.me, () => ({ body: { display_name: "Ian <b>Wijma</b>", id: "ian123", email: "ian@example.org" } }))
    },
    "https://api.spotify.com/v1/me/player/play": (req) => {
      record(req)
      return answer(world.statuses.play, () => ({ status: 204 }))
    },
    "https://api.spotify.com/v1/me/player/queue": (req) => {
      record(req)
      return answer(world.statuses.queue, () => ({ status: 204 }))
    }
  })
  const connector: OfflineConnector = (req) => {
    if (world.down) return Promise.reject(Object.assign(new Error("connect ECONNREFUSED (test)"), { code: "ECONNREFUSED", notSent: true }))
    if (world.playBreaks && req.url.pathname === "/v1/me/player/play") {
      record(req)
      req.onConnect?.()
      return Promise.reject(Object.assign(new Error("read ECONNRESET (test)"), { code: "ECONNRESET" }))
    }
    return net.connector(req)
  }
  world.net = net
  world.deps = { resolver: net.resolver, connector }
  return world
}
export type World = ReturnType<typeof makeWorld>

/** The `WebVideos` contract as a stub: a search answers the list the test sets. */
export const makeVideos = (results: ReadonlyArray<WebVideo> = []) => {
  const state = { results, failWith: undefined as WebVideosError["reason"] | undefined }
  const stub = stubService<{ readonly search: (q: WebVideoQuery) => Effect.Effect<ReadonlyArray<WebVideo>, WebVideosError> }>("web-search", {
    search: () => (state.failWith === undefined ? Effect.succeed(state.results) : Effect.fail(new WebVideosError({ reason: state.failWith, detail: "test" })))
  })
  return { stub, state, provided: provide("web-search", { services: [WebVideos.of(stub.service)] }) }
}

export const video = (idChar: string, title: string, author?: string): WebVideo => ({
  title,
  url: `https://www.youtube.com/watch?v=${idChar.repeat(11)}`,
  site: "youtube.com",
  youtubeId: idChar.repeat(11),
  ...(author !== undefined ? { author } : {}),
  thumbnailUrl: `https://i.ytimg.com/vi/${idChar.repeat(11)}/hq720.jpg`
})

/** What a test records of the module through a wrapper: the routes its shared part published and the instance it started. */
export interface Seen {
  routes: ReadonlyArray<ModuleRoute>
  instance: { readonly fieldActions?: Record<string, (input: { settings: unknown; draft: boolean }) => Effect.Effect<{ ok: boolean; text: string; tone?: string; link?: { href: string; label: string } }, unknown>>; readonly info?: () => Record<string, string> } | undefined
}

export const wrapped = (definition: ModuleDefinition<any>, seen: Seen): ModuleDefinition<any> =>
  ({
    ...definition,
    shared: (ctx: any) => definition.shared!(ctx).pipe(Effect.tap((part: any) => Effect.sync(() => void (seen.routes = part.routes ?? [])))),
    start: (ctx: any) => definition.start(ctx).pipe(Effect.tap((instance: any) => Effect.sync(() => void (seen.instance = instance))))
  }) as ModuleDefinition<any>

export const request = (over: Partial<RouteRequest> = {}): RouteRequest =>
  ({ method: "GET", path: "", params: {}, query: {}, queryAll: {}, headers: { host: "assistant.example.org" }, body: undefined, address: "192.168.1.9", ...over }) as RouteRequest

export const route = (seen: Seen, path: string): ModuleRoute => seen.routes.find((r) => r.path === path)!
export const hit = (seen: Seen, path: string, over?: Partial<RouteRequest>) =>
  route(seen, path).handler(request(over)) as Effect.Effect<{ status: number; headers?: Record<string, string>; body?: any }>

export interface StartOptions {
  readonly world: World
  readonly videos?: ReturnType<typeof makeVideos> | undefined
  readonly signedIn?: boolean
  /** Epoch ms of the sign-in the vault holds (default: the kit's start). */
  readonly signedInAt?: number
  readonly settings?: Record<string, unknown>
  readonly secrets?: Record<string, string>
  readonly household?: Record<string, unknown>
  readonly credentials?: CredentialStore
}

/** The module, started with its settings, signed in to Spotify (unless `signedIn: false`), with `WebVideos` provided when given. */
export const startMedia = (o: StartOptions, seen: Seen = { routes: [], instance: undefined }) =>
  Effect.gen(function*() {
    if (o.signedIn !== false) {
      yield* o.world.creds.forModule("media").set("spotify-refresh", REFRESH_TOKEN)
      yield* o.world.creds.forModule("media").set("spotify-signin", JSON.stringify({ at: o.signedInAt ?? Date.parse("2026-11-18T09:00:00Z"), name: "Ian" }))
    }
    const kit = yield* startTestModule(wrapped(mediaModule(o.world.deps), seen), {
      settings: { spotifyClientId: CLIENT_ID, ...(o.settings ?? {}) },
      secrets: { spotifyClientSecret: CLIENT_SECRET, ...(o.secrets ?? {}) },
      credentials: o.credentials ?? o.world.creds,
      provide: o.videos === undefined ? [] : [o.videos.provided],
      ...(o.household !== undefined ? { household: o.household as never } : {})
    })
    return { kit, seen }
  })

let turns = 1_000
/** A turn of its own on `device` (each invocation in a test is a new one unless it says otherwise). */
export const at = (device = "kitchen-display", source?: "phrase") => ({ device, turnId: ++turns, conversationId: `c-${turns}`, ...(source !== undefined ? { source } : {}) })
export const NL = { home: { HOME_LANGUAGE: "nl-NL" } }
