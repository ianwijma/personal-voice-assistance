// Signing in to Spotify from the admin page: the buttons (field actions) that give a link, the ticket that ties the start
// route to an admin's press, the redirect address built from the request's own origin, the callback with its single-use
// `state`, what is kept in the vault, and that nothing a caller sends is ever echoed into a page.
import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect } from "effect"
import { CALLBACK_PATH, redirectUriOf, SPOTIFY_SCOPES } from "../src/index.ts"
import { CLIENT_ID, hit, makeVideos, makeWorld, NL, request, type Seen, startMedia, video } from "./helpers.ts"

vi.setConfig({ testTimeout: 30_000 })

/** A page's text with the apostrophe the HTML escaped read back. */
const plain = (body: string) => body.replace(/&#39;/g, "'")
const press = (seen: Seen, key: string) => seen.instance!.fieldActions![key]!({ settings: {}, draft: false }) as Effect.Effect<{ ok: boolean; text: string; tone?: string; link?: { href: string; label: string } }>
const fresh = (): Seen => ({ routes: [], instance: undefined })

/** Press Sign in, follow its link to the start route, and answer the state Spotify would send back. */
const beginSignIn = (seen: Seen, headers: Record<string, string> = { host: "assistant.example.org" }) =>
  Effect.gen(function*() {
    const pressed = yield* press(seen, "spotifySignIn")
    const href = pressed.link!.href
    const ticket = new URL(href, "https://x.example").searchParams.get("ticket")!
    const started = yield* hit(seen, "spotify/start", { query: { ticket }, headers })
    const location = started.headers?.Location
    const cookie = started.headers?.["Set-Cookie"]?.split(";")[0]
    return { pressed, ticket, started, location, cookie, state: location === undefined ? undefined : new URL(location).searchParams.get("state")! }
  })

describe("the buttons", () => {
  it.effect("Show the address links to the address page; Sign in needs the client ID and secret, and then links to the start route with a ticket", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      const seen = fresh()
      yield* startMedia({ world, signedIn: false }, seen)
      const address = yield* press(seen, "spotifyAddress")
      assert.deepStrictEqual(address.link, { href: "/api/modules/media/spotify/address", label: "Show the redirect address" })
      const signIn = yield* press(seen, "spotifySignIn")
      assert.isTrue(signIn.ok)
      assert.match(signIn.link!.href, /^\/api\/modules\/media\/spotify\/start\?ticket=[A-Za-z0-9_-]{20,}$/)
      assert.strictEqual(signIn.link!.label, "Continue to Spotify")

      const unset = fresh()
      yield* startMedia({ world: makeWorld(), signedIn: false, settings: { spotifyClientId: "" }, secrets: { spotifyClientSecret: "" } }, unset)
      const refused = yield* press(unset, "spotifySignIn")
      assert.deepStrictEqual([refused.ok, refused.link], [false, undefined])
      assert.strictEqual(refused.text, "Enter the client ID and the client secret, save, and then sign in.")
    }))

  it.effect("the module's status line says where the sign-in stands, and whether videos can be searched", () =>
    Effect.gen(function*() {
      const { kit } = yield* startMedia({ world: makeWorld(), signedIn: false })
      assert.deepStrictEqual(kit.info()!.status, { text: "Spotify: not signed in · Video search: off", tone: "neutral" })
      const signed = yield* startMedia({ world: makeWorld(), videos: makeVideos() })
      assert.deepStrictEqual(signed.kit.info()!.status, { text: "Spotify: signed in · Video search: on", tone: "ok" })
    }))

  it.effect("the address page shows the exact redirect address from the request's own origin, escaped; an unusable host is refused", () =>
    Effect.gen(function*() {
      const seen = fresh()
      yield* startMedia({ world: makeWorld(), signedIn: false }, seen)
      const ok = yield* hit(seen, "spotify/address", { headers: { host: "assistant.example.org" } })
      assert.strictEqual(ok.status, 200)
      assert.include(ok.body, "https://assistant.example.org/api/modules/media/spotify/callback")
      assert.strictEqual(ok.headers?.["Content-Type"], "text/html; charset=utf-8")
      // Behind a declared proxy the HTTP layer resolves the origin the browser used (`RouteRequest.origin`); the module reads that.
      const proxied = yield* hit(seen, "spotify/address", { headers: { host: "127.0.0.1:3000" }, origin: { scheme: "https", host: "voice.example.org" } })
      assert.include(proxied.body, "https://voice.example.org/api/modules/media/spotify/callback")
      // A forwarding header the HTTP layer did not vouch for is never read, here or by the address page.
      const forged = yield* hit(seen, "spotify/address", { headers: { host: "assistant.example.org", "x-forwarded-host": "evil.example.org" } })
      assert.include(forged.body, "https://assistant.example.org/api/modules/media/spotify/callback")
      assert.notInclude(forged.body, "evil.example.org")
      // The http addresses Spotify allows are loopback ones, with the scheme the request really came on.
      assert.strictEqual(redirectUriOf({ scheme: "http", host: "127.0.0.1:8787" }), "http://127.0.0.1:8787/api/modules/media/spotify/callback")
      assert.strictEqual(redirectUriOf({ scheme: "http", host: "[::1]:8787" }), "http://[::1]:8787/api/modules/media/spotify/callback")
      assert.strictEqual(redirectUriOf({ scheme: "https", host: "127.0.0.1:8787" }), "https://127.0.0.1:8787/api/modules/media/spotify/callback")
      assert.strictEqual(redirectUriOf({ scheme: "http", host: "192.168.1.9" }), "https://192.168.1.9/api/modules/media/spotify/callback")
      // Not usable: `localhost`, and a host with markup in it. Nothing of it is echoed.
      for (const host of ["localhost:3000", "evil\"><script>alert(1)</script>"]) {
        const wrong = yield* hit(seen, "spotify/address", { headers: { host } })
        assert.strictEqual(wrong.status, 400)
        assert.notInclude(wrong.body, "script")
        assert.include(plain(wrong.body), "This address can't be used with Spotify")
      }
      assert.strictEqual(CALLBACK_PATH, "/api/modules/media/spotify/callback")
    }))
})

describe("signing in", () => {
  it.effect("start sends the browser to Spotify with the scopes, the redirect address and a state; the ticket works once", () =>
    Effect.gen(function*() {
      const seen = fresh()
      yield* startMedia({ world: makeWorld(), signedIn: false }, seen)
      const begun = yield* beginSignIn(seen)
      assert.strictEqual(begun.started.status, 302)
      const url = new URL(begun.location!)
      assert.strictEqual(`${url.origin}${url.pathname}`, "https://accounts.spotify.com/authorize")
      assert.strictEqual(url.searchParams.get("response_type"), "code")
      assert.strictEqual(url.searchParams.get("client_id"), CLIENT_ID)
      assert.strictEqual(url.searchParams.get("scope"), SPOTIFY_SCOPES)
      assert.strictEqual(url.searchParams.get("scope"), "streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state user-read-currently-playing playlist-read-private")
      assert.strictEqual(url.searchParams.get("redirect_uri"), "https://assistant.example.org/api/modules/media/spotify/callback")
      assert.match(begun.state!, /^[A-Za-z0-9_-]{20,}$/)
      // The ticket is single use; a made-up one, none and a long one are refused with a page, and no redirect.
      for (const query of [{ ticket: begun.ticket }, { ticket: "A".repeat(32) }, {}, { ticket: "x".repeat(500) }]) {
        const again = yield* hit(seen, "spotify/start", { query })
        assert.strictEqual(again.status, 400)
        assert.isUndefined(again.headers?.Location)
      }
    }))

  it.effect("the callback checks the state, exchanges the code with the same redirect address, keeps the refresh token in the vault, and says so", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      const seen = fresh()
      const { kit } = yield* startMedia({ world, signedIn: false }, seen)
      const begun = yield* beginSignIn(seen)
      const done = yield* hit(seen, "spotify/callback", { query: { code: "good-code", state: begun.state! }, headers: { cookie: begun.cookie! } })
      assert.strictEqual(done.status, 200)
      assert.include(done.body, "Signed in to Spotify. You can close this page.")
      const exchange = new URLSearchParams(world.to("/api/token")[0]!.body)
      assert.deepStrictEqual([exchange.get("grant_type"), exchange.get("code"), exchange.get("redirect_uri")], ["authorization_code", "good-code", "https://assistant.example.org/api/modules/media/spotify/callback"])
      // Kept in the vault, with the day and the name beside it; the access token only in memory.
      const held = world.creds.dump()
      assert.strictEqual(held["media/spotify-refresh"], "refresh-from-code")
      assert.deepStrictEqual(JSON.parse(held["media/spotify-signin"]!), { at: Date.parse("2026-11-18T09:00:00Z"), name: "Ian <b>Wijma</b>" })
      assert.notInclude(JSON.stringify(held), "access-from-code")
      // The page's line: who, and until when (six months after).
      assert.include(seen.instance!.info!().spotifyStatus!, "Signed in as Ian <b>Wijma</b>, until 2027-05-18.")
      assert.strictEqual(kit.info()!.status?.tone, "ok")
      // The state is single use.
      const replay = yield* hit(seen, "spotify/callback", { query: { code: "good-code", state: begun.state! }, headers: { cookie: begun.cookie! } })
      assert.strictEqual(replay.status, 400)
      assert.include(replay.body, "expired or was already used")
    }))

  it.effect("a wrong or expired state, a denied sign-in, a code Spotify refuses: a page, nothing kept; no query text is echoed", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      const seen = fresh()
      const { kit } = yield* startMedia({ world, signedIn: false }, seen)
      const script = "<script>alert('x')</script>"
      const wrongState = yield* hit(seen, "spotify/callback", { query: { code: "good-code", state: "A".repeat(32) } })
      assert.strictEqual(wrongState.status, 400)
      const denied = yield* hit(seen, "spotify/callback", { query: { error: script, state: script } })
      assert.strictEqual(denied.status, 400)
      assert.include(denied.body, "cancelled or refused")
      const junk = yield* hit(seen, "spotify/callback", { query: { code: script, state: script } })
      assert.strictEqual(junk.status, 400)
      const none = yield* hit(seen, "spotify/callback", { query: {} })
      assert.strictEqual(none.status, 400)
      for (const r of [wrongState, denied, junk, none]) {
        assert.notInclude(r.body, "script")
        assert.notInclude(r.body, "alert")
        assert.strictEqual(r.headers?.["Content-Security-Policy"], "default-src 'none'; style-src 'unsafe-inline'")
        assert.strictEqual(r.headers?.["Cache-Control"], "no-store")
      }
      // Spotify refuses the code.
      const refused = yield* beginSignIn(seen)
      const bad = yield* hit(seen, "spotify/callback", { query: { code: "bad-code", state: refused.state! }, headers: { cookie: refused.cookie! } })
      assert.strictEqual(bad.status, 400)
      assert.include(plain(bad.body), "Spotify didn't accept the sign-in")
      // A state that waited too long.
      const slow = yield* beginSignIn(seen)
      yield* kit.advance(10 * 60_000 + 1)
      const late = yield* hit(seen, "spotify/callback", { query: { code: "good-code", state: slow.state! }, headers: { cookie: slow.cookie! } })
      assert.strictEqual(late.status, 400)
      assert.deepStrictEqual(world.creds.dump(), {})
      assert.include(seen.instance!.info!().spotifyStatus!, "Not signed in.")
    }))

  it.effect("start sets a cookie bound to the state (HttpOnly, SameSite=Lax, Path, 10 minutes, Secure unless plain loopback); a callback without it, or with another browser's, is refused and the state is spent", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      const seen = fresh()
      yield* startMedia({ world, signedIn: false }, seen)
      const begun = yield* beginSignIn(seen)
      const set = begun.started.headers!["Set-Cookie"]!
      assert.match(set, /^pva_media_spotify=[A-Za-z0-9_-]{20,}; HttpOnly; SameSite=Lax; Path=\/api\/modules\/media\/spotify\/; Max-Age=600; Secure$/)
      const local = yield* beginSignIn(seen, { host: "127.0.0.1:8787" })
      assert.notInclude(local.started.headers!["Set-Cookie"]!, "Secure")
      // Another browser (no cookie, or another one's): refused, nothing exchanged, and the state cannot be used again.
      for (const headers of [{}, { cookie: "pva_media_spotify=AAAAAAAAAAAAAAAAAAAAAAAA" }, { cookie: "other=1" }]) {
        const again = yield* beginSignIn(seen)
        const refused = yield* hit(seen, "spotify/callback", { query: { code: "good-code", state: again.state! }, headers })
        assert.strictEqual(refused.status, 400)
        const replay = yield* hit(seen, "spotify/callback", { query: { code: "good-code", state: again.state! }, headers: { cookie: again.cookie! } })
        assert.strictEqual(replay.status, 400)
      }
      assert.strictEqual(world.to("/api/token").length, 0)
      // The right browser: signed in, and the cookie is cleared.
      const done = yield* hit(seen, "spotify/callback", { query: { code: "good-code", state: begun.state! }, headers: { cookie: `x=1; ${begun.cookie!}` } })
      assert.strictEqual(done.status, 200)
      assert.match(done.headers!["Set-Cookie"]!, /^pva_media_spotify=; .*Max-Age=0$/)
    }))

  it.effect("the sign-in routes are limited per address, and their shared total is far above what one address can use up", () =>
    Effect.gen(function*() {
      const seen = fresh()
      yield* startMedia({ world: makeWorld(), signedIn: false }, seen)
      for (const path of ["spotify/start", "spotify/callback", "spotify/address"]) {
        const limit = seen.routes.find((r) => r.path === path)!.rateLimit!
        assert.strictEqual(limit.perAddress, 20)
        assert.isAtLeast(limit.total!, 20 * 10)
      }
    }))

  it.effect("a locked vault cannot keep the sign-in: a page says so, and nothing is half signed in", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      const seen = fresh()
      yield* startMedia({ world, signedIn: false }, seen)
      const begun = yield* beginSignIn(seen)
      world.creds.lock()
      const done = yield* hit(seen, "spotify/callback", { query: { code: "good-code", state: begun.state! }, headers: { cookie: begun.cookie! } })
      assert.strictEqual(done.status, 503)
      assert.include(done.body, "key vault is locked")
      world.creds.unlock()
      assert.deepStrictEqual(world.creds.dump(), {})
      assert.include(seen.instance!.info!().spotifyStatus!, "Not signed in.")
    }))

  it.effect("in Dutch the pages and the line are Dutch", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      const seen = fresh()
      yield* startMedia({ world, signedIn: false, household: { home: NL.home } }, seen)
      const begun = yield* beginSignIn(seen)
      const done = yield* hit(seen, "spotify/callback", { query: { code: "good-code", state: begun.state! }, headers: { cookie: begun.cookie! } })
      assert.include(done.body, "Ingelogd bij Spotify. Je kunt deze pagina sluiten.")
      assert.include(done.body, "lang=\"nl\"")
      assert.include(seen.instance!.info!().spotifyStatus!, "Ingelogd als Ian <b>Wijma</b>, tot 2027-05-18.")
    }))

  it.effect("Sign out forgets the sign-in and the date; signed out already says so; a locked vault clears nothing", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      const seen = fresh()
      yield* startMedia({ world }, seen)
      assert.include(seen.instance!.info!().spotifyStatus!, "Signed in as Ian")
      world.creds.lock()
      const locked = yield* press(seen, "spotifySignOut")
      assert.isFalse(locked.ok)
      world.creds.unlock()
      assert.strictEqual(Object.keys(world.creds.dump()).length, 2)
      const out = yield* press(seen, "spotifySignOut")
      assert.deepStrictEqual([out.ok, out.text], [true, "Signed out of Spotify."])
      assert.deepStrictEqual(world.creds.dump(), {})
      assert.include(seen.instance!.info!().spotifyStatus!, "Not signed in.")
      assert.strictEqual((yield* press(seen, "spotifySignOut")).text, "You were not signed in.")
    }))

  it.effect("a page that was prepared without Spotify is prepared again with it once the sign-in is made, and again without it on sign-out", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      const videos = makeVideos([video("a", "A video")])
      const seen = fresh()
      const { kit } = yield* startMedia({ world, videos, signedIn: false }, seen)
      const page = yield* kit.players.page(["spotify", "youtube"])
      page.respond("ack")
      const prepares = () => page.commands().flatMap((c) => (c.type === "prepare" ? [c.sources] : []))
      assert.deepStrictEqual(prepares(), [[{ source: "youtube" }]])
      const begun = yield* beginSignIn(seen)
      assert.strictEqual((yield* hit(seen, "spotify/callback", { query: { code: "good-code", state: begun.state! }, headers: { cookie: begun.cookie! } })).status, 200)
      yield* kit.players.settle
      yield* kit.advance(100)
      assert.deepStrictEqual(prepares().at(-1), [{ source: "spotify", config: { name: "Kitchen display" } }, { source: "youtube" }])
      yield* press(seen, "spotifySignOut")
      yield* kit.players.settle
      yield* kit.advance(100)
      assert.deepStrictEqual(prepares().at(-1), [{ source: "youtube" }])
    }))
})
