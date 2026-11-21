// Spotify behind the module, against the offline network of fixtures (helpers.ts): the search and its pick rule, the play
// bodies per kind, the queue, 401 renewal and its single flight, 403/404/429, a lost connection, refresh-token rotation,
// `invalid_grant`, and that no token reaches a result, a log line or the admin page.
import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect } from "effect"
import { itemOf, pickItem, searchText, type MusicItem } from "../src/index.ts"
import { album, artist, at, CLIENT_ID, makeWorld, NL, playlist, REFRESH_TOKEN, startMedia, track, uri } from "./helpers.ts"

vi.setConfig({ testTimeout: 30_000 })

const item = (kind: MusicItem["kind"], name: string): MusicItem => ({ source: "spotify", kind, uri: uri(kind, 1), name })

describe("the pick rule", () => {
  it("an exact name wins, by kind order track, album, artist, playlist; else the first track, then album, artist, playlist", () => {
    const found = { track: [item("track", "Blue in Green"), item("track", "Kind of Blue")], album: [item("album", "Kind of Blue")], artist: [item("artist", "Kind of Blue")], playlist: [item("playlist", "Kind of Blue")] }
    // The exact name of a track beats the first track.
    assert.strictEqual(pickItem(found, "kind of blue", undefined)?.name, "Kind of Blue")
    assert.strictEqual(pickItem(found, "kind of blue", undefined)?.kind, "track")
    // With no exact track, an exact album beats the first track.
    assert.strictEqual(pickItem({ ...found, track: [item("track", "Blue in Green")] }, "Kind of Blue", undefined)?.kind, "album")
    // The accents, case and a leading article do not count (Members' name rule).
    assert.strictEqual(pickItem({ track: [], album: [item("album", "Café del Mar")], artist: [], playlist: [] }, "cafe del mar", undefined)?.kind, "album")
    // No exact name: the first track.
    assert.strictEqual(pickItem(found, "something else", undefined)?.name, "Blue in Green")
    // No tracks at all: the first album, then artist, then playlist.
    assert.strictEqual(pickItem({ track: [], album: [], artist: [item("artist", "A")], playlist: [item("playlist", "P")] }, "x", undefined)?.kind, "artist")
    assert.strictEqual(pickItem({ track: [], album: [], artist: [], playlist: [item("playlist", "P")] }, "x", undefined)?.kind, "playlist")
    assert.isUndefined(pickItem({ track: [], album: [], artist: [], playlist: [] }, "x", undefined))
    // A kind asked for: only that kind, exact first, else its first.
    assert.strictEqual(pickItem(found, "Kind of Blue", "album")?.kind, "album")
    assert.strictEqual(pickItem({ ...found, artist: [item("artist", "Miles")] }, "nothing", "artist")?.name, "Miles")
  })

  it("an item needs its own kind's address and a name; texts are cleaned; addresses must be https", () => {
    assert.isUndefined(itemOf("track", null))
    assert.isUndefined(itemOf("track", { uri: uri("album", 1), name: "Wrong kind" }))
    assert.isUndefined(itemOf("track", { uri: "spotify:track:../etc", name: "Bad id" }))
    assert.isUndefined(itemOf("track", { uri: uri("track", 1), name: "   " }))
    const got = itemOf("track", { uri: uri("track", 1), name: "Feeling\nGood‮", artists: [{ name: "Nina Simone" }], album: { images: [{ url: "http://insecure.example/a.jpg" }] }, external_urls: { spotify: "https://open.spotify.com/track/x" }, popularity: 3 })
    assert.strictEqual(got?.name, "Feeling Good")
    assert.strictEqual(got?.by, "Nina Simone")
    assert.isUndefined(got?.artUrl)
    assert.strictEqual(got?.link, "https://open.spotify.com/track/x")
  })

  it("field filters for a track or album with an artist; the artist as plain words otherwise; quotes taken out", () => {
    assert.strictEqual(searchText("Kind of Blue", "album", "Miles Davis"), "album:\"Kind of Blue\" artist:\"Miles Davis\"")
    assert.strictEqual(searchText("Feeling Good", "track", "Nina \"The\" Simone"), "track:\"Feeling Good\" artist:\"Nina The Simone\"")
    assert.strictEqual(searchText("Kind of Blue", undefined, "Miles Davis"), "Kind of Blue artist:\"Miles Davis\"")
    assert.strictEqual(searchText("Miles", "artist", undefined), "Miles")
    assert.strictEqual(searchText("Sunday", "playlist", "Ian"), "Sunday Ian")
  })
})

describe("playing music: the Web API calls", () => {
  it.effect("search with the field filters, then the play body for each kind, on the page's own player id, with the Bearer token", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.found.albums.push(album(2, "Kind of Blue", "Miles Davis"))
      world.found.tracks.push(track(1, "Feeling Good", "Nina Simone"))
      world.found.artists.push(artist(3, "Nina Simone"))
      world.found.playlists.push(playlist(4, "Sunday Morning"))
      const { kit } = yield* startMedia({ world })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")

      const said = yield* kit.action("play_music", { query: "Kind of Blue", kind: "album", artist: "Miles Davis" }, at())
      assert.deepStrictEqual(said, { ok: true, say: "Playing the album Kind of Blue by Miles Davis." })
      const search = world.to("/v1/search")[0]!
      const url = new URL(search.url)
      assert.strictEqual(url.searchParams.get("q"), "album:\"Kind of Blue\" artist:\"Miles Davis\"")
      assert.strictEqual(url.searchParams.get("type"), "album")
      assert.strictEqual(url.searchParams.get("limit"), "5")
      assert.strictEqual(search.auth, "Bearer access-1")
      const play = world.to("/v1/me/player/play", "PUT")[0]!
      assert.strictEqual(new URL(play.url).searchParams.get("device_id"), "kitchen-display-spotify")
      assert.deepStrictEqual(JSON.parse(play.body!), { context_uri: uri("album", 2) })

      // A song: `uris`; an artist and a playlist: `context_uri`.
      yield* kit.action("play_music", { query: "Feeling Good", kind: "track" }, at())
      assert.deepStrictEqual(JSON.parse(world.to("/v1/me/player/play", "PUT")[1]!.body!), { uris: [uri("track", 1)] })
      assert.strictEqual((yield* kit.action("play_music", { query: "Nina Simone", kind: "artist" }, at())).ok, true)
      assert.deepStrictEqual(JSON.parse(world.to("/v1/me/player/play", "PUT")[2]!.body!), { context_uri: uri("artist", 3) })
      assert.strictEqual((yield* kit.action("play_music", { query: "Sunday Morning", kind: "playlist" }, at())).ok, true)
      assert.deepStrictEqual(JSON.parse(world.to("/v1/me/player/play", "PUT")[3]!.body!), { context_uri: uri("playlist", 4) })
      // The access token was fetched once for all of it, with the client's Basic credentials.
      assert.strictEqual(world.refreshes, 1)
      const refresh = world.to("/api/token")[0]!
      assert.strictEqual(refresh.auth, `Basic ${Buffer.from(`${CLIENT_ID}:client-secret-s3cret`).toString("base64")}`)
      assert.strictEqual(new URLSearchParams(refresh.body).get("refresh_token"), REFRESH_TOKEN)
    }))

  it.effect("no kind: one search over the four kinds, the pick rule applied, and the answer names what was found", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.found.tracks.push(track(1, "Blue in Green", "Miles Davis"))
      world.found.albums.push(album(2, "Kind of Blue", "Miles Davis"))
      const { kit } = yield* startMedia({ world })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      const said = yield* kit.action("play_music", { query: "kind of blue" }, at())
      assert.deepStrictEqual(said, { ok: true, say: "Playing the album Kind of Blue by Miles Davis." })
      assert.strictEqual(new URL(world.to("/v1/search")[0]!.url).searchParams.get("type"), "track,album,artist,playlist")
      // Nothing of that name: the first track.
      const other = yield* kit.action("play_music", { query: "something vague" }, at())
      assert.deepStrictEqual(other, { ok: true, say: "Playing the song Blue in Green by Miles Davis." })
    }))

  it.effect("a playlist is looked for among the owner's own first (by name, as Members compares), then by search", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.mine.push(playlist(7, "Zondag ochtend", "Ian"))
      world.found.playlists.push(playlist(8, "Zondag Ochtend (Spotify)"))
      const { kit } = yield* startMedia({ world })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      assert.deepStrictEqual(yield* kit.action("play_music", { query: "zondag Ochtend", kind: "playlist" }, at()), { ok: true, say: "Playing the playlist Zondag ochtend by Ian." })
      assert.strictEqual(world.to("/v1/search").length, 0, "the own playlist was enough")
      assert.deepStrictEqual(JSON.parse(world.to("/v1/me/player/play", "PUT")[0]!.body!), { context_uri: uri("playlist", 7) })
      // Not among the own: the search finds it.
      assert.deepStrictEqual(yield* kit.action("play_music", { query: "Zondag Ochtend (Spotify)", kind: "playlist" }, at()), { ok: true, say: "Playing the playlist Zondag Ochtend (Spotify) by Spotify." })
      assert.strictEqual(world.to("/v1/search").length, 1)
    }))

  it.effect("nothing found says so; the queue takes songs only and adds after what plays, with no `open`", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.found.tracks.push(track(1, "Feeling Good", "Nina Simone"))
      world.found.albums.push(album(2, "Kind of Blue", "Miles Davis"))
      const { kit } = yield* startMedia({ world })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      assert.deepStrictEqual(yield* kit.action("play_music", { query: "zzz", kind: "artist" }, at()), { ok: true, say: "I found nothing on Spotify for zzz." })
      assert.deepStrictEqual(yield* kit.action("play_music", { query: "Kind of Blue", kind: "album", queue: "add" }, at()), { ok: true, say: "I can only add songs to the queue." })
      assert.deepStrictEqual(yield* kit.action("play_music", { query: "Feeling Good", kind: "track", queue: "add" }, at()), { ok: true, say: "Added the song Feeling Good by Nina Simone to the queue." })
      const queue = world.to("/v1/me/player/queue", "POST")[0]!
      const q = new URL(queue.url).searchParams
      assert.strictEqual(q.get("uri"), uri("track", 1))
      assert.strictEqual(q.get("device_id"), "kitchen-display-spotify")
      assert.strictEqual(world.to("/v1/me/player/play").length, 0)
      assert.isFalse(page.commands().some((c) => c.type === "open"))
    }))
})

describe("tokens", () => {
  it.effect("an access token that ends is renewed once however many ask at the same moment (single flight)", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.found.tracks.push(track(1, "Feeling Good", "Nina Simone"))
      const { kit } = yield* startMedia({ world })
      const kitchen = yield* kit.players.page(["spotify"], { device: "kitchen-display" })
      const phone = yield* kit.players.page(["spotify"], { device: "robins-phone" })
      kitchen.respond("play")
      phone.respond("play")
      const [a, b] = yield* Effect.all([
        kit.action("play_music", { query: "Feeling Good", kind: "track" }, at("kitchen-display")),
        kit.action("play_music", { query: "Feeling Good", kind: "track" }, at("robins-phone"))
      ], { concurrency: 2 })
      assert.isTrue(a.ok && b.ok)
      assert.strictEqual(world.refreshes, 1)
      // An hour later it is renewed before use (two minutes ahead), again once.
      yield* kit.advance(3_600_000 - 60_000)
      yield* kit.action("play_music", { query: "Feeling Good", kind: "track" }, at())
      assert.strictEqual(world.refreshes, 2)
      assert.strictEqual(world.to("/v1/search").at(-1)!.auth, "Bearer access-2")
    }))

  it.effect("a 401 on a GET renews the token and goes again once", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.found.tracks.push(track(1, "Feeling Good", "Nina Simone"))
      world.statuses.search.push(401)
      const { kit } = yield* startMedia({ world })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      assert.strictEqual((yield* kit.action("play_music", { query: "Feeling Good", kind: "track" }, at())).ok, true)
      assert.deepStrictEqual(world.to("/v1/search").map((c) => c.auth), ["Bearer access-1", "Bearer access-2"])
      assert.strictEqual(world.refreshes, 2)
    }))

  it.effect("a 401 on the play call renews the token and reports; the PUT is not repeated", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.found.tracks.push(track(1, "Feeling Good", "Nina Simone"))
      world.statuses.play.push(401)
      const { kit } = yield* startMedia({ world })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      const said = yield* kit.action("play_music", { query: "Feeling Good", kind: "track" }, at())
      assert.isFalse(said.ok)
      assert.strictEqual((said as { message?: string }).message, "Spotify's sign-in had just run out and is renewed. Say that again.")
      assert.strictEqual(world.to("/v1/me/player/play", "PUT").length, 1)
      assert.strictEqual(world.refreshes, 2, "renewed, so the next request works")
      assert.strictEqual((yield* kit.action("play_music", { query: "Feeling Good", kind: "track" }, at())).ok, true)
      assert.strictEqual(world.to("/v1/me/player/play", "PUT").at(-1)!.auth, "Bearer access-2")
    }))

  it.effect("a refresh answer with a new refresh token replaces it in the vault; the sign-in date stays", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.found.tracks.push(track(1, "Feeling Good", "Nina Simone"))
      world.rotateTo = "refresh-token-two"
      const { kit } = yield* startMedia({ world })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      yield* kit.action("play_music", { query: "Feeling Good", kind: "track" }, at())
      assert.strictEqual(world.creds.dump()["media/spotify-refresh"], "refresh-token-two")
      assert.strictEqual(JSON.parse(world.creds.dump()["media/spotify-signin"]!).at, Date.parse("2026-11-18T09:00:00Z"))
      // The next renewal sends the new one.
      yield* kit.advance(3_600_000)
      yield* kit.action("play_music", { query: "Feeling Good", kind: "track" }, at())
      assert.strictEqual(new URLSearchParams(world.to("/api/token").at(-1)!.body).get("refresh_token"), "refresh-token-two")
    }))

  it.effect("a rotated token that cannot be written (vault locked) is used from memory, and says the sign-in cannot be renewed", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.found.tracks.push(track(1, "Feeling Good", "Nina Simone"))
      world.rotateTo = "refresh-token-two"
      const { kit } = yield* startMedia({ world })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      world.creds.lock()
      assert.strictEqual((yield* kit.action("play_music", { query: "Feeling Good", kind: "track" }, at())).ok, true)
      assert.include((yield* kit.checkHealth).map((i) => i.id), "media.spotify-cannot-renew")
      world.creds.unlock()
      yield* kit.advance(3_600_000)
      yield* kit.action("play_music", { query: "Feeling Good", kind: "track" }, at())
      assert.strictEqual(new URLSearchParams(world.to("/api/token").at(-1)!.body).get("refresh_token"), "refresh-token-two", "the token held in memory was sent")
    }))

  it.effect("invalid_grant ends the sign-in: credentials cleared, the answer and Health say to sign in again", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.invalidGrant = true
      const { kit } = yield* startMedia({ world })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      assert.deepStrictEqual(yield* kit.action("play_music", { query: "x" }, at()), { ok: true, say: "Spotify's sign-in has ended. Sign in again on the Media module's page." })
      assert.deepStrictEqual(world.creds.dump(), {})
      assert.include((yield* kit.checkHealth).map((i) => i.id), "media.spotify-sign-in-ended")
      // And the next request does not try again.
      const calls = world.to("/api/token").length
      yield* kit.action("play_music", { query: "x" }, at())
      assert.strictEqual(world.to("/api/token").length, calls)
    }))

  it.effect("the Spotify client refused (invalid_client) is Health's error, not a signed-out account", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.statuses.token.push(401)
      const { kit } = yield* startMedia({ world })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      const said = yield* kit.action("play_music", { query: "x" }, at())
      assert.isFalse(said.ok)
      assert.strictEqual((said as { message?: string }).message, "Spotify refused the client ID or secret. Check them on the Media module's page.")
      const issues = yield* kit.checkHealth
      assert.include(issues.map((i) => i.id), "media.spotify-client-refused")
      assert.notInclude(issues.map((i) => i.id), "media.spotify-sign-in-ended")
    }))
})

describe("Spotify's answers", () => {
  const playSetup = Effect.gen(function*() {
    const world = makeWorld()
    world.found.tracks.push(track(1, "Feeling Good", "Nina Simone"))
    const started = yield* startMedia({ world })
    const page = yield* started.kit.players.page(["spotify"])
    page.respond("play")
    return { world, kit: started.kit, page }
  })
  const play = (kit: Effect.Success<typeof playSetup>["kit"]) => kit.action("play_music", { query: "Feeling Good", kind: "track" }, at())

  it.effect("403 Premium required is the account's problem; another 403 points at the Spotify app's users", () =>
    Effect.gen(function*() {
      const { world, kit } = yield* playSetup
      world.statuses.play.push(403)
      world.playForbiddenReason = "PREMIUM_REQUIRED"
      assert.strictEqual(((yield* play(kit)) as { message?: string }).message, "Spotify needs a Premium account to play here.")
      world.playForbiddenReason = "SOMETHING_ELSE"
      world.statuses.play.push(403)
      assert.include(((yield* play(kit)) as { message?: string }).message ?? "", "added to the app in the Spotify developer dashboard")
    }))

  it.effect("404 on play (the page's player is not known to Spotify yet): the page is prepared again and the call goes again once", () =>
    Effect.gen(function*() {
      const { world, kit, page } = yield* playSetup
      // A first request makes the page's player known (the page answered nothing before the test said how).
      assert.isTrue((yield* play(kit)).ok)
      world.statuses.play.push(404)
      const before = page.commands().filter((c) => c.type === "prepare").length
      const putsBefore = world.to("/v1/me/player/play", "PUT").length
      assert.deepStrictEqual(yield* play(kit), { ok: true, say: "Playing the song Feeling Good by Nina Simone." })
      assert.strictEqual(world.to("/v1/me/player/play", "PUT").length, putsBefore + 2)
      assert.strictEqual(page.commands().filter((c) => c.type === "prepare").length, before + 1)
      // A second 404 is reported, not looped.
      world.statuses.play.push(404, 404)
      const again = (yield* play(kit)) as { message?: string }
      assert.strictEqual(again.message, "This device's Spotify player isn't ready yet. Try again in a moment.")
      assert.strictEqual(world.to("/v1/me/player/play", "PUT").length, putsBefore + 4)
    }))

  it.effect("429 says Spotify is busy, in the household's language", () =>
    Effect.gen(function*() {
      const world = makeWorld()
      world.headers = { "retry-after": "7" }
      world.statuses.search.push(429)
      const { kit } = yield* startMedia({ world, household: NL as never })
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      assert.strictEqual(((yield* kit.action("play_music", { query: "x" }, at())) as { message?: string }).message, "Spotify is druk, probeer het zo nog eens.")
    }))

  it.effect("a play call whose connection ended after it was written says it may still happen; a search that cannot connect says Spotify can't be reached", () =>
    Effect.gen(function*() {
      const { world, kit } = yield* playSetup
      world.playBreaks = true
      assert.strictEqual(((yield* play(kit)) as { message?: string }).message, "Spotify didn't answer in time; it may still happen.")
      world.playBreaks = false
      world.down = true
      assert.strictEqual(((yield* play(kit)) as { message?: string }).message, "I couldn't reach Spotify.")
    }))

  it.effect("signed out, not set up, a locked vault: each says what to do, and nothing is sent to Spotify", () =>
    Effect.gen(function*() {
      const out = makeWorld()
      const a = yield* startMedia({ world: out, signedIn: false })
      const pageA = yield* a.kit.players.page(["spotify"])
      pageA.respond("play")
      assert.deepStrictEqual(yield* a.kit.action("play_music", { query: "x" }, at()), { ok: true, say: "Spotify isn't signed in. Sign in on the Media module's page." })
      const unset = makeWorld()
      const b = yield* startMedia({ world: unset, signedIn: false, settings: { spotifyClientId: "" }, secrets: { spotifyClientSecret: "" } })
      const pageB = yield* b.kit.players.page(["spotify"])
      pageB.respond("play")
      assert.deepStrictEqual(yield* b.kit.action("play_music", { query: "x" }, at()), { ok: true, say: "Spotify isn't set up yet. Add the client ID and secret on the Media module's page, then sign in." })
      const locked = makeWorld()
      locked.creds.lock()
      const c = yield* startMedia({ world: locked, signedIn: false })
      const pageC = yield* c.kit.players.page(["spotify"])
      pageC.respond("play")
      assert.deepStrictEqual(yield* c.kit.action("play_music", { query: "x" }, at()), { ok: true, say: "The key vault is locked, so I can't reach Spotify. Unlock it in the admin." })
      assert.deepStrictEqual([out.calls.length, unset.calls.length, locked.calls.length], [0, 0, 0])
    }))

  it.effect("no token, secret or code is in a result, the admin page's info and issues, or any command but `credential`", () =>
    Effect.gen(function*() {
      const { world, kit, page } = yield* playSetup
      world.rotateTo = "refresh-token-two"
      const said = yield* play(kit)
      const tool = yield* kit.tool("media_now_playing", {}, at())
      yield* kit.expectNoSecrets(said, tool, kit.info(), yield* kit.checkHealth)
      const everything = JSON.stringify([said, tool, kit.info(), yield* kit.checkHealth, page.commands()])
      for (const secret of ["access-1", REFRESH_TOKEN, "refresh-token-two", "client-secret-s3cret"]) assert.notInclude(everything, secret)
    }))
})
