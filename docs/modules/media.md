# Media (`media`)

Plays music from Spotify and YouTube videos on the device you talk to, with voice and touch controls.

- Package: `packages/module-media` (it replaced `packages/module-music`, which was removed on 2026-11-21)
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 8 (wave B)
- Research this builds on: [research/modules/music.md](../research/modules/music.md) (its "route 3", superseded by this
  page) and [research/modules/video.md](../research/modules/video.md)
- How to write a module: [docs/MODULES.md](../MODULES.md), "Playing on a device (`DevicePlayers`)"

**Status.** Built on 2026-11-21 (steps 4 and 6 of the plan this page started as). Everything below that says what the
module does is covered by tests against a scripted page, a fake Spotify and a stubbed video search. **Nothing has been tried
on a real browser, a real Spotify Premium account or a real SearXNG yet**: see [Not yet verified on a real device](#not-yet-verified-on-a-real-device).
The page that draws the player and makes the sound (`apps/web`) is a separate piece of work: [The page](#the-page-the-contract)
describes the contract the module relies on, not something this module does.

## What it does

One module, two sources, one player per device. It is off by default.

- **"Play Kind of Blue by Miles Davis"**: the server searches Spotify, starts the best match on the asking device's page and
  says what it found ("Playing the album Kind of Blue by Miles Davis."). The page shows the cover, title and artist with
  previous, play/pause, next, a volume slider and a close button.
- **"Play a video about sharpening knives on YouTube"**: the server searches YouTube through the household's own SearXNG, the
  page opens YouTube's player in a theatre layout (the player takes the stage at 16:9, as large as fits) and playback starts.
  YouTube's own controls stay usable.
- **Voice controls**, as phrase commands that need no language model: pause, resume, next, previous, and "back / forward ten
  seconds". Volume, seeking to a time, "what's playing" and "close the video" are tools and actions.
- **One thing plays per device.** Starting a video pauses the music and the other way round (the page does this). The transport
  words act on whatever that device has open.
- **The host's "stop"** pauses the device's player (the module provides `Playback`), after a ring, an announcement and a reply,
  as the host orders them.
- **While the assistant listens and speaks**, music is lowered and a video pauses (settings). The page does this itself, from the
  `talk` setting each `open` carries: there is no round trip.
- **An answer says what happened**: the page reports the player's state, so "Paused." is said after the page confirmed it, and a
  command the page took but could not finish is told as it is (`Tap play to start.`, a Premium account missing). A command that
  was sent and not acknowledged in time is never worded as "it didn't start": it may still happen.

Everything acts on the asking device (`CurrentTurn.deviceId`); there is no `where`. A device that cannot play (no device, a voice
node, the admin page, a page without the player, a device switched to "no display" or "no speaker") is told "This device can't
play music or video."

## Tools

The module offers **actions** (typed commands the intent agent and the phrase tables can run without the model); each is also
offered to the model as the tool `media_<id>`, except where noted. Every answer is in the household's language (English and
Dutch), and every title, artist and channel in an answer is outside text that was cleaned (control, format and direction
characters become spaces) and is marked as data, never as an instruction.

| Action (tool) | Parameters | Risk | Example | Answers |
|---|---|---|---|---|
| `play_music` (`media_play_music`) | `query`, `kind` (`track`, `album`, `artist`, `playlist`; optional), `artist` (optional), `queue` (`now`, `add`; default now) | change | "play the album Kind of Blue by Miles Davis" | "Playing the album Kind of Blue by Miles Davis." |
| `play_video` (`media_play_video`) | `query` | change | "play a video about sharpening knives on YouTube" | "Playing How to Sharpen a Knife, from Bon Appétit." |
| `pause`, `resume`, `next`, `previous` | none | change | "pause", "next song", "skip" | "Paused." / "Playing." / "Next." / "Previous." |
| `seek` (`media_seek`) | `by` (seconds, negative is back) or `to` (seconds from the start) | change | "go back thirty seconds" | "Went back 30 seconds." |
| `skip_back`, `skip_forward` (phrases only: no tool) | none | change | "back ten seconds" | "Went back 10 seconds." |
| `volume` (`media_volume`) | `level` (0 to 100) or `change` (`up`, `down`: ten points from the level the page reports) | change | "turn the music down" | "Volume at 40 percent." |
| `close` (`media_close`) | none | change | "close the video", "stop the music" | "Closed." |
| `now_playing` (the tool `media_now_playing`, speculative; no action tool) | none | read | "what's playing?" | "Feeling Good by Nina Simone, on Spotify." |

- **Kind missing from the request**: one Spotify search over `track,album,artist,playlist`; the pick rule below. The answer always
  names what was found, so a wrong guess is heard at once.
- **The pick rule** (also in `pickItem`): among the results, a name equal to the words asked (compared as Members compares names,
  `nameKey`: case, accents and a leading article do not count) wins, looking at tracks, then albums, then artists, then playlists
  (or only the kind asked for); otherwise the first result of the kind asked for, or with no kind the first track, else the
  first album, artist or playlist. Spotify's own order is its relevance. Fields Spotify has removed or may remove (popularity,
  available markets, previews) are never read.
- **With an artist** a song or an album is searched with Spotify's field filters (`track:"…" artist:"…"`); for an artist or a
  playlist the name is just more words.
- **A playlist** is looked for among the owner's own first (`GET /v1/me/playlists?limit=50`, the first fifty, name compared as
  above), then by search.
- **`queue: add`** is for a song only (Spotify's queue takes single tracks): "I can only add songs to the queue." for the rest. It
  adds after what plays and opens nothing. "Play next" is not offered.
- **Video**: only YouTube results (the video id is read from the address) are kept, at most five per search, remembered for that
  device so `next` and `previous` move through them ("There is no next video result." at the ends). A video that refuses to be
  embedded or is gone (`embed_refused`, `not_found`) is followed by the next result, at most twice more.
- **Transport goes to the page only** (not Spotify's Web API: faster, and no quota), on whatever is open on the asking device;
  with nothing open: "Nothing is playing here."

### Phrases

Phrase commands (docs/PHRASES.md; after the wake phrase, with no model call), in English and Dutch, without a `{where}`: pause
("pause", "pause the music", "pause the video", "pauzeer de muziek", …), resume ("resume", "continue the music", "speel verder",
…), next and previous ("next", "skip", "next video", "volgend nummer", "vorige", …), and "back ten seconds" / "forward ten
seconds" ("tien seconden terug", "tien seconden vooruit", …). The host owns "stop", "louder" and "quieter" (the reply volume, not the
media's): the module claims none of them. **"hey …, pause" needs the wake phrase while media plays**; a bare "pause" is the
media guard's business (see Still to do).

**Once per invocation.** A phrase command's invocation (assistant, conversation, turn, device, operation, input) acts once: a
repeat, even a concurrent one, gets the first outcome and sends nothing; a run cut short after its command went out says "I may
already have done that. If not, say it again." (bounded record of 256). A model's tool call has no identity of its own and always
acts.

## How a play request runs

Time: an action has 5 s, so a request has 4.6 s in all (`BUDGET_MS`), shared as: a search 1.5 s, the page's acknowledgement
1.2 s, the page's player being made ready 2 s, the page saying it plays 1.5 s. When the whole runs out the answer says "That is
taking a while; it may still start." (the command was sent) or "That took too long; say it again." (nothing was). These numbers
are limits, not measurements: no latency is claimed here (docs/MODULES.md §15).

**Music, the Spotify call sequence:**

1. When a page with players appears, the module sends it `prepare` (Spotify with `config.name` = the device's name, so the
   Connect device carries it; YouTube when the video search is there). The page loads Spotify's player and asks for a token
   (`wants: credential`); the module answers with a `credential` command carrying a fresh access token, on the connection that
   asked. The token is never logged, kept in a state or sent in any other command.
2. `GET https://api.spotify.com/v1/search?q=…&type=…&limit=5` (or `GET /v1/me/playlists?limit=50` first for a playlist), with
   `Authorization: Bearer <access token>`.
3. The page's Spotify player must be ready and have its `playerId` (the Connect device id); if not, `prepare` is sent again and
   waited for, at most 2 s ("This device's Spotify player isn't ready yet. Try again in a moment.").
4. `open { source: "spotify", title, subtitle, artUrl, link, kind, autoplay: true, talk }` to the asking page (it shows the cover,
   the title, the controls and the Spotify link).
5. `PUT https://api.spotify.com/v1/me/player/play?device_id=<playerId>` with `{ "context_uri": "spotify:album:…" }` (album, artist,
   playlist) or `{ "uris": ["spotify:track:…"] }` (song). A `404` (Spotify does not know the page's player yet): `prepare` again,
   wait for a player id, and try once more.
6. The page's state is read until it says `playing` (said: "Playing …"), `blocked` ("Tap play to start.") or `error` (its own
   sentence), for at most 1.5 s; silence is "it may still start".

`queue: add` replaces steps 4 to 6 with `POST /v1/me/player/queue?uri=…&device_id=…`. Spotify's answers: `401` renews the token
(one refresh at a time, shared by every caller) and a GET goes again once; a `PUT` or `POST` is reported instead ("Spotify's
sign-in had just run out and is renewed. Say that again."); `403` is a Premium account missing or another refusal; `429` says
"Spotify is busy, try again in a moment."; a connection that ended after a `PUT` was written says it may still happen; a search
that cannot connect says "I couldn't reach Spotify."

**Video:** `WebVideos.search({ site: "youtube", safeSearch, language, maxResults: 5 })` (the web-search module's service over the
household's SearXNG), then `open { source: "youtube", ref: <video id>, title, subtitle: <channel>, artUrl, link, autoplay: true,
talk }` with `awaitStatus: playing`: `playing` is said ("Playing How to Sharpen a Knife, from Bon Appétit."), `blocked` is "Tap
play to start.", `error` with `embed_refused` or `not_found` tries the next result, and a time-out is never "it didn't start".

## Signing in to Spotify

All of it is done in the admin page, with no address typed and no file edited. The module is Spotify's "Authorization Code" flow
with the owner's own developer app (the client secret stays on the server).

**What the owner does** (the first time, and twice a year after that, see "Setting it up" below for the dashboard side):

1. Enter the **client ID** and **client secret** on the Media page, and Save.
2. Press **Show the address**: a link appears; opening it shows the exact redirect address (`https://<the address you are using
   now>/api/modules/media/spotify/callback`). Register it under Redirect URIs in the Spotify app.
3. Press **Sign in with Spotify**: a link appears ("Continue to Spotify"); opening it sends the browser to Spotify, and Spotify
   sends it back to the callback, which says "Signed in to Spotify. You can close this page." The page's status line then reads
   "Signed in as <name>, until <date>."

**How it works.**

- A button press (a field action) cannot open a browser tab itself, and an `info` field is read-only text, so the smallest generic
  capability was added: **a field action's answer may carry a `link`** (`FieldActionResult.link`: a path under the module's own
  `/api/modules/<id>/` and a label up to 60 characters). The host drops any link that is not such a path; the admin page shows it
  beside the button's answer, as a link the owner opens in a new tab (never opened by the page, because a popup opened after a
  request is blocked). Files: `packages/protocol/src/settings.ts`, `packages/core/src/ModuleContributions.ts`,
  `packages/core/src/ModuleHost.ts`, `apps/assistant/src/serve/moduleAction.ts`, `apps/web/src/components/fields/ActionField.tsx`.
- **The start route is public, tied to an admin by a ticket.** A browser navigating to a link cannot send the admin session token,
  so `GET /api/modules/media/spotify/start` is a public route that needs a single-use `ticket` (random, ten minutes) which only
  the Sign in press (an admin action) can make. It reads the origin it was reached on from the request's `X-Forwarded-Host` or
  `Host` (the page and the route are on the same origin, whatever proxy is in front), builds the redirect address, and sends the
  browser to `https://accounts.spotify.com/authorize` with the scopes `streaming user-read-email user-read-private
  user-modify-playback-state user-read-playback-state user-read-currently-playing playlist-read-private`, the client ID, the
  redirect address and a random single-use `state` kept in memory for ten minutes.
- **The scheme is `https`** (decision 3 below); only the loopback address `127.0.0.1` is `http`, as Spotify allows. `localhost` is
  refused by Spotify, so no address is built for it and the page says so.
- **The callback** (`GET /api/modules/media/spotify/callback`, public as a callback must be) checks the `state`, exchanges the code
  with `POST https://accounts.spotify.com/api/token` (form body, `Authorization: Basic base64(id:secret)`), keeps the refresh token in
  the key vault (`host.credentials`, name `spotify-refresh`, with the sign-in day and the display name beside it in
  `spotify-signin`), reads the display name from `GET /v1/me`, and answers a small page. Nothing from the query is echoed.
- **Tokens.** Access tokens last an hour: held in memory, renewed when less than two minutes are left, one renewal at a time. A
  renewal may hand out a new refresh token: it replaces the old one in the vault. `invalid_grant` means the sign-in ended: the
  credentials are cleared and the status says to sign in again. Refresh tokens end six months after the sign-in (refreshing does
  not extend that): Health warns 14 days before, and the status line shows the date.
- **A locked key vault**: a module running keeps the token it started with; a renewed token that cannot be written is kept in
  memory and Health says the sign-in cannot be renewed; a vault locked at start leaves Spotify signed out with its own sentence.

## Settings

Every setting is made in the admin UI: no environment variable and no file edit.

| Key | Kind | Notes |
|---|---|---|
| `spotifyClientId` | text | from the owner's Spotify developer app; not secret |
| `spotifyClientSecret` | secret | the key vault |
| `spotifyStatus` | info | "Signed in as …, until 2027-05-21." / "Not signed in." / the vault is locked / the sign-in has ended |
| `spotifyAddress` | action | **Show the address**: a link to the page that shows the redirect address to register |
| `spotifySignIn` | action | **Sign in with Spotify**: a link that continues at Spotify (needs the client ID and secret saved) |
| `spotifySignOut` | action | **Sign out**: forgets the sign-in (asks first; a locked vault clears nothing) |
| `videoSafeSearch` | choice (`strict`, `moderate`, `none`; default `moderate`) | passed to SearXNG with every video search |
| `musicWhileTalking` | choice (`lower`, `pause`; default `lower`) | what the page does to music while the assistant listens and speaks |
| `duckLevel` | number (0 to 100, default 20) | how far music (and a video set to lower) is lowered |
| `videoWhileTalking` | choice (`pause`, `duck`; default `pause`) | a talking video is hard to hear over, so it pauses and goes on afterwards |

Each source works alone: without a Spotify sign-in the music tools say so and video still works, and the other way round.

## Routes

All `GET`, all public (a browser arrives on them), each rate limited to 20 a minute per address:

- `/api/modules/media/spotify/start?ticket=…`: described above; an unknown, used or old ticket gets a page, never a redirect.
- `/api/modules/media/spotify/callback?code=…&state=…`: described above.
- `/api/modules/media/spotify/address`: shows the exact redirect address for the origin it was reached on (escaped; a host that
  is not a plain host name, and `localhost`, are refused with a sentence).

Every page is HTML in the household's language with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and a
`Content-Security-Policy` that allows nothing but its own inline style.

## Health

Issue ids start with `media.` (the host adds the module): `spotify-not-set` (info), `spotify-not-signed-in` (warning),
`spotify-sign-in-ended` (warning), `spotify-vault-locked` (warning), `spotify-no-vault` (info, outside serve mode),
`spotify-cannot-renew` (a renewed token could not be kept), `spotify-sign-in-ends-soon` (14 days before, and after the end),
`spotify-client-refused` (error), `no-video-search` (info: the web-search module is off or has no SearXNG address; music still
works), and per device `player-initialization-error` (its browser has no protected-media support) and `player-account-error`
(Spotify's player needs Premium), cleared when that page reports no error or leaves. The health check reads what the running
module knows; it makes no request.

## What it stores

**Nothing in the store.** No search cache (SearXNG has no quota, Spotify's search is one cheap call), no watch or listening
history. In the key vault, as module credentials: the Spotify refresh token (`spotify-refresh`) and the day of the sign-in with the
display name (`spotify-signin`, a small JSON). In memory only: the access token, the single-use sign-in states and tickets, each
device's last five video results, the record of finished phrase invocations, and what each page was last prepared with. A
credential stays when the module is switched off, as route tokens do; **Sign out** clears it.

## What it needs

- The **web page of the device** with the players (see below), over `DevicePlayers`; it works only in serve mode.
- **Spotify**: a developer app of the owner's (Premium owner; development mode allows five users and a search of at most ten
  results, so five are asked for), and a **Premium** account for the player to play.
- **A SearXNG** for video, through the Web search module (`WebVideos`: switched on, with a SearXNG address). Without it the
  video tool says "Video search isn't available…" and music still works; the module does not list it in `uses`, because it works
  without it.
- **`https`**: the assistant is reached over HTTPS (decision 3), so Spotify's sign-in can return to it.
- `page: { thirdPartyEmbeds: true }`: while this module is on, the voice page is served without cross-origin isolation (and with
  `Referrer-Policy: strict-origin-when-cross-origin`), so Spotify's and YouTube's players can load; no setting to edit.
- The internet (`requires: internet`), for Spotify's API (and, in the page, for both players).

## Setting it up

In the admin page, with a Spotify Premium account:

1. **Make a Spotify app.** Go to `developer.spotify.com/dashboard`, sign in, press Create app. Any name and description. For
   "Which API/SDKs are you planning to use?" tick **Web API** and **Web Playback SDK**. Leave the redirect address for step 4 (the
   form wants one: give `https://127.0.0.1/` for now, or fill it in later under Settings). Open the app's Settings: copy the
   **Client ID**, and View client secret for the **secret**.
2. **Add yourself.** In the app's User management, add the Spotify account (name and e-mail) of everyone who will use it (five at
   most in development mode); without it Spotify answers "forbidden" and the assistant says so.
3. **Switch the module on** (Settings → modules → Media, for the assistants that should have it), paste the client ID and the
   secret, and **Save**.
4. **Register the redirect address.** Press **Show the address**, open the link, and copy the address it shows into the app's
   Settings → Redirect URIs (Add, then Save). It is `https://<the address in your browser>/api/modules/media/spotify/callback`;
   open the admin page the way the voice pages are opened (the same address), so it is the right one.
5. **Sign in.** Press **Sign in with Spotify**, open the link, and agree. The status line shows who is signed in and until when.
   Repeat it twice a year (Health tells you 14 days before).
6. **Video** needs the Web search module on with your SearXNG address, and `json` among that server's `search.formats`.
7. **On each device** open the voice page once and press **Start** (browsers only let a page play sound after a touch). A
   browser without Widevine (some Chromium builds) cannot play Spotify; Health says so for that device. Ads play in YouTube's
   player unless that browser is signed in to YouTube Premium.

## Facts that shape the design

Checked on 2026-11-21 against the providers' own pages unless marked.

**Spotify**

| Fact | Consequence |
|---|---|
| Developer Policy III.3: "Do not create … any kind of voice assistant that provides voice-control functionality." No exception for personal use. | **Decided: go ahead** (below). It works technically; the known risk is Spotify disabling the owner's app. The source stays behind `MusicSource` so another could replace it. |
| The Web Playback SDK turns the tab into a Spotify Connect device. Premium only. Chrome, Firefox, Safari, Edge. It needs encrypted media (Widevine): a Chromium build without it fails with `initialization_error`. | Health says which device; step 0 of the plan tests the owner's browser first. |
| Playback must be unlocked by a user gesture once per page load (`activateElement()`); otherwise a transferred playback arrives paused. | The page's existing **Start** press does it. |
| A development-mode app needs a Premium owner, allows 5 users, search returns at most 10 results. Player endpoints (`PUT /me/player/play`, queue, transfer) are unchanged. | Enough for one household. |
| Redirect address for sign-in must be `https://…` or `http://127.0.0.1:<port>`; not `localhost`, not a LAN address over plain HTTP. | Sign in from the assistant's HTTPS address, or once from a browser on the server machine (`127.0.0.1`). |
| Refresh tokens end six months after sign-in; refreshing does not extend that. | Health warns two weeks before; the owner signs in again twice a year. |
| Policy II.4/II.5: show cover art and metadata, linked back to Spotify. III.6: never with video. III.7: no mixing or overlapping. | The panel always shows art, title, artist and a Spotify link (`open` carries them). Music pauses when a video starts. Music is lowered, not mixed with anything of ours beyond the assistant's voice. |
| One account plays in one place: starting on a second device stops the first. | Not handled: starting on a second device stops the first, as Spotify does. |

**YouTube**

| Fact | Consequence |
|---|---|
| The IFrame Player API is the only allowed way to play YouTube in our page: `loadVideoById`, `playVideo`, `pauseVideo`, `seekTo`, `setVolume`, state and error events. | Used as is, by the page. |
| Developer Policies: nothing drawn over the player, no hidden controls or links, no audio-only or background play, ads untouched. | The page's controls sit outside the player rectangle; the player pauses when the tab is hidden. |
| YouTube's own search (the Data API) needs a Google API key and allows about 100 searches a day. | **Not used.** The owner chose the household's SearXNG, which the web-search module already reaches. No key, no quota, and Google sees no search from us. |
| SearXNG's video search returns results from several sites and cannot ask for "embeddable only". | Only results whose address is a YouTube watch address are kept (the id is read from it). Videos that refuse embedding (errors 101, 150) are found out by the page; the module tries the next result, at most twice. |
| The player needs a Referer (error 153 otherwise). | The page sets `Referrer-Policy: strict-origin-when-cross-origin`, `origin=` and `enablejsapi=1`; the server sends the header on pages. |
| Unmuted autoplay in a cross-origin frame needs the page to have been interacted with and `allow="autoplay"`. Behaviour differs per browser **[to verify on the device]**. | When the browser blocks it, the player is shown ready and the assistant says "Tap play to start." |
| Fullscreen from script needs a gesture. | The theatre layout fills the page instead; YouTube's own fullscreen button still works by touch. |
| Ads play unless that browser is signed in to YouTube Premium. | Nothing to do; said in the setup steps. |

**This repository**

| Fact | Consequence |
|---|---|
| Every page was served cross-origin isolated, which blocks third-party scripts and frames that do not opt in. | **Decided: isolation goes off** while this module is on (`page.thirdPartyEmbeds`). The cost is a slightly less exact count of what was heard when a reply is cut off (docs/RUNNING.md). |
| Presentations are a closed set and carry no player state back. | A player is not a presentation: it has its own contract (`DevicePlayers`, `media.command`, `media.state`). |
| `Playback` was keyed by room and only music provided it. | Keyed by device now; this module provides it. |
| Modules reach the internet only through `@pva/net`, which sent GET and HEAD. | `makeFixedApi` (GET, PUT, POST, DELETE with a JSON or form body to hosts named in the module's own code). |
| A module could not keep a secret it obtained itself. | `host.credentials` (the key vault). |
| The echo gate knows only the assistant's own speech. Nothing ducks, and no rule requires the wake phrase while media plays. Browser echo cancellation of SDK and iframe audio is unproven. | Ducking is the page's (`open.talk`); the media guard and the measurements are still to do (below). |
| The web-search module already offers other modules an image search over SearXNG. | Video search is added the same way (`WebVideos`). |

## Changes below the module (merged before it)

Each is documented where it lives; this is the list. `DevicePlayers` (`packages/core/src/DevicePlayers.ts`, test kit
`kit.players`), the protocol's `media.command` and `media.state` and `DeviceCapabilities.media` (`packages/protocol/src/media.ts`,
additive within protocol 12), `Playback` keyed by device (`packages/core/src/Playback.ts`; the host's "stop" passes the device it
knows), `makeFixedApi` in `@pva/net`, `host.credentials` (docs/MODULES.md §8), `page.thirdPartyEmbeds` (docs/MODULES.md §11) and
`WebVideos` in the web-search module (`packages/module-contracts/src/webVideos.ts`). This module added one generic capability
of its own: the `link` a button's answer may carry (above).

## The page (the contract)

Built separately in `apps/web`; this module relies on exactly this and no more. The page: declares `media.players` (the sources
it can play: `spotify`, `youtube`) and `"video"` in `speaker.media`; answers `prepare` by loading the players it was named
(Spotify's SDK only when `spotify` is named, so a household without the module contacts neither company), with `config.name` as the
Spotify Connect device's name; reports `players: [{ source, ready, playerId?, error? }]`; asks for a token with `wants:
credential` when it has none or it runs out and uses the `credential` command it gets; on `open` shows the player surface (a
music panel with the cover, title, artist, Spotify link, previous / play-pause / next, progress, volume and close; or the theatre
layout with the YouTube frame as large as fits and the controls outside it) and acts on `open.talk` while the assistant listens
and speaks (`lower` to `level`, `pause`, or `none`); handles `play`, `pause`, `next`, `previous`, `seek`, `volume` and `close`;
reports `media.state` on every change and every few seconds while playing, with `ack` set to the highest command number handled;
reports `current.status` as `loading`, `playing`, `paused`, `ended`, `blocked` (autoplay refused) or `error` with an `errorCode`
(`initialization_error`, `account_error`, `authentication_error` for Spotify; `embed_refused`, `not_found` for YouTube); unlocks
both players with its **Start** press; pauses a video when the tab is hidden (not music); on reload reports no player and the module
restarts nothing by itself. Touch and voice share one state: a touch on the page's own buttons goes straight to the player and is
reported; the module never needs to be asked for a pause.

## Listening while something plays

This is the part most likely to go wrong, and not all of it is built.

- **Ducking, in the page, with no round trip.** When the wake phrase is heard, and while the assistant listens and speaks: music
  drops to the duck level (default 20 %) over about 150 ms and returns a second after the reply ends. **A video pauses instead**
  and resumes afterwards (a talking video at 20 % is still heard as speech), unless the command was itself "pause" or "close".
  Both are settings. *Built here as the `talk` each `open` carries; done by the page.*
- **Media guard.** While a device's player is `playing`, that device needs the wake phrase for every request: no follow-up
  window and no answering without the phrase. Otherwise lyrics and video speech become turns. This is a change to the route gate,
  fed by `DevicePlayers.isPlaying`, and it is the guard docs/PHRASES.md lists under "Not now". **Not built yet: still to do.**
- **So "pause" is "hey …, pause"** in this version. Bare "pause" while media plays stays out.
- **What the device measurements must show**: how often the wake phrase is heard over music and over a video at normal volume, and
  how much of the media's sound reaches speech recognition with the browser's echo cancellation on. If the wake phrase is not
  reliable, the design needs push-to-talk on the panel as a fallback before anything else is built.

## Decisions (owner, 2026-11-21)

1. **Spotify's policy against voice assistants controlling Spotify**: ignored; go ahead with Spotify.
2. **Page isolation**: off while this module is on, so Spotify's and YouTube's players can load.
3. **The assistant is reached over HTTPS**, so Spotify's sign-in returns to
   `https://<the assistant's address>/api/modules/media/spotify/callback`.
4. **Video search goes through SearXNG**, not YouTube's Data API. No Google API key.
5. **While the assistant listens and speaks**: music lowers, video pauses. Pausing music instead is a setting.
6. **Module id `media`** replaces `music`; the old settings and the room table are dropped, not migrated.
7. **Every setting is made in the admin UI**, as for every module: no environment variable and no file edit.

## Tests

`packages/module-media/test`: the conformance check with the texts of both languages (`module.test.ts`); the Spotify client against
an offline network (`spotify.test.ts`: the pick rule, the search filters, the play body per kind, the queue, 401 renewal and its
single flight, rotation of the refresh token, a locked vault, `invalid_grant`, 403, 404, 429, a connection lost after the
request, signed out and not set up, and that no token or secret reaches a result, a status, an issue or a command); the sign-in
(`signIn.test.ts`: the buttons and their links, the ticket, the redirect address, the callback's `state` check, what is kept
in the vault, that nothing of the query is echoed, a locked vault, Dutch, sign-out and the pages prepared again); and the
orchestration against scripted pages (`media.test.ts`: `prepare` on connect, credentials, the music and video requests and each
way they end, the `talk` settings, no player, the transport from confirmed state, phrases and their once-record, `Playback`,
Health, Dutch). The core's test for the link a button may carry is in `packages/core/test/ModuleHostFieldsRoutes.test.ts`.

## Not yet verified on a real device

Everything below needs a real Spotify Premium account, a real SearXNG and a real browser, and has been checked only against
scripts and fixtures.

- That Spotify's Authorization Code flow works end to end with a real developer app: the redirect address as built from the
  `Host` and `X-Forwarded-Host` headers behind the owner's real proxy, the scopes, the refresh-token rotation, and the six-month end.
- That the Web Playback SDK loads in the owner's browser with isolation off, plays (Widevine), and that `PUT /me/player/play` on
  the page's `playerId` starts it; the wait for `playing` (1.5 s) and the `404` retry on a real device that Spotify learns of late.
- That the page's `open` followed by the Web API call does not leave a stale `playing` from the previous track that would be
  read as the new one (the module trusts `open` to reset the page's state).
- That YouTube's frame autoplays after one **Start** press in each browser, and what a real SearXNG returns for a video search
  (which engines are on, whether YouTube results carry a length; `json` in its formats).
- The time budget (4.6 s in all, and the parts) against real latencies, with `TurnTrace` numbers.
- Wake-phrase hit rate and echo over music and over a video, and whether browser echo cancellation covers the SDK's and the
  frame's audio.
- That a Spotify account that is not registered in the developer dashboard gets the "forbidden" sentence and not something else,
  and that Spotify's 403 for a missing Premium account carries `PREMIUM_REQUIRED` as assumed.

## Still to do

- **The media guard in the route gate** (build step 5): the wake phrase required for every request on a device while its player is
  `playing`, fed by `DevicePlayers.isPlaying`; measured again on the device.
- **The real-device measurements** above, and the plan revised from them (push-to-talk on the panel if the wake phrase is not
  reliable over music).
- **The page** (`apps/web`), as the contract above says (built separately).

## What was left out

- Devices without a screen (voice nodes, the admin page): they answer "This device can't play music or video." A player on a node
  (Spotify's Soloist, see the music research §5.2) is a later route.
- Playing on another device or room ("play it in the bedroom"), groups, moving playback; a second device starts and stops the
  first, as Spotify does.
- Radio stations (Spotify has none by name; `radio` as a kind is dropped), podcasts, local files, Jellyfin, "play next" in the
  queue, adding anything but a song to the queue.
- YouTube Music, playlists and channels on YouTube, subtitles by voice, watch history, summaries.
- Home Assistant players: the smart-home module keeps its media-player entities for its own tools; nothing of this module uses
  them. The old music module (per-room Music Assistant) is gone, with its room table and settings, not migrated.
- A search cache, listening history, a store of any kind.
- Environment variables for any of this: every setting is made in the admin UI.
- A Spotify source other than Spotify (the interface `MusicSource` is there for it).

## Earlier research

[research/modules/music.md](../research/modules/music.md) and [research/modules/video.md](../research/modules/video.md) were written
before this module; this page supersedes them where they differ (superseded by this page: the Home Assistant route and the
per-room player table are gone).
