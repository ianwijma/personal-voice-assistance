# Media (`media`): plan

**Status: a plan, not built.** Written 2026-11-21. It replaces the music module ([music.md](music.md)), which plays
through Home Assistant only. Nothing here is measured yet: every claim about latency, echo and autoplay is something
step 0 has to prove on the owner's own browser.

- Package (new): `packages/module-media`. Removed by this plan: `packages/module-music`.
- Earlier research this builds on: [research/modules/music.md](../research/modules/music.md) (its "route 3") and
  [research/modules/video.md](../research/modules/video.md).
- How to write a module: [docs/MODULES.md](../MODULES.md)

## 1. What the owner asked for

1. Music plays **on the device that was asked**, not on Home Assistant players. The Home Assistant route goes away.
2. YouTube videos play on that device too, as large as the screen allows, in YouTube's own embedded player, so a
   person can sit and use the player's controls.
3. Music comes from Spotify.
4. Both are controlled by touch and by voice: play, pause, next and previous for music; play, pause and the usual
   video controls for video.

## 2. What it will do

One module, two sources, one player per device.

- **"Play Kind of Blue by Miles Davis"**: the server searches Spotify, starts the best match on the asking device's
  page, and says what it found ("Playing the album Kind of Blue by Miles Davis."). A now-playing panel shows the cover,
  title and artist with previous, play/pause, next, a volume slider and a close button.
- **"Play a video about sharpening knives on YouTube"**: the server searches YouTube, the page opens YouTube's player
  in a **theatre** layout (the player takes the stage at 16:9, as large as fits; the character shrinks to a corner),
  and playback starts. YouTube's own controls stay usable; a close button and "next result" sit outside the player.
- **Voice controls**, as phrase commands that need no language model: pause, resume, next, previous, and for video
  "back / forward ten seconds". Volume, seeking to a time, "what's playing" and "close the video" are tools.
- **One thing plays per device.** Starting a video pauses the music and the other way round. The transport words act
  on whatever that device is playing.
- **The host's "stop"** pauses the device's player, after a ring, an announcement and a reply, as today.

Unlike the music module, an answer says **what happened**: the page reports the player's state, so "Paused." is said
after the page confirmed it (within a short wait), and "I couldn't start that video" when the player refused.

### Not in the first version

- Devices without a screen (voice nodes, the admin page). They answer "This device can't play music or video." A
  player on a node (Spotify's Soloist, see the music research §5.2) is a later route.
- Playing on another device or room ("play it in the bedroom"), groups, moving playback.
- Radio stations, podcasts, local files, Jellyfin. Spotify has no radio stations by name; `radio` as a kind is dropped.
- YouTube Music, playlists and channels on YouTube, subtitles by voice, watch history, summaries.
- Home Assistant players. The smart-home module keeps its media-player entities for its own tools; nothing of this
  module uses them.

## 3. Facts that shape the design

Checked on 2026-11-21 against the providers' own pages unless marked.

**Spotify**

| Fact | Consequence |
|---|---|
| Developer Policy III.3: "Do not create … any kind of voice assistant that provides voice-control functionality." No exception for personal use. | **Decided: go ahead** (§9). It works technically; the known risk is Spotify disabling the owner's app. The source stays behind an interface so another could replace it. |
| The Web Playback SDK turns the tab into a Spotify Connect device. Premium only. Chrome, Firefox, Safari, Edge. It needs encrypted media (Widevine): a Chromium build without it fails with `initialization_error`. | Step 0 tests the owner's browser first. |
| Playback must be unlocked by a user gesture once per page load (`activateElement()`); otherwise a transferred playback arrives paused. | The page's existing **Start** press does it. |
| A development-mode app needs a Premium owner, allows 5 users, search returns at most 10 results. Player endpoints (`PUT /me/player/play`, queue, transfer) are unchanged. | Enough for one household. |
| Redirect address for sign-in must be `https://…` or `http://127.0.0.1:<port>`; not `localhost`, not a LAN address over plain HTTP. | Sign in from the assistant's HTTPS address, or once from a browser on the server machine. |
| Refresh tokens end six months after sign-in; refreshing does not extend that. | Health warns two weeks before; the owner signs in again twice a year. |
| Policy II.4/II.5: show cover art and metadata, linked back to Spotify. III.6: never with video. III.7: no mixing or overlapping. | The panel always shows art, title, artist and a Spotify link. Music pauses when a video starts. Music is lowered, not mixed with anything of ours beyond the assistant's voice (decided, §9). |
| One account plays in one place: starting on a second device stops the first. | Said in the answer when it happens. |

**YouTube**

| Fact | Consequence |
|---|---|
| The IFrame Player API is the only allowed way to play YouTube in our page: `loadVideoById`, `playVideo`, `pauseVideo`, `seekTo`, `setVolume`, state and error events. | Used as is. |
| Developer Policies: nothing drawn over the player, no hidden controls or links, no audio-only or background play, ads untouched. | Our controls sit outside the player rectangle; the player pauses when the tab is hidden. |
| YouTube's own search (the Data API) needs a Google API key and allows about 100 searches a day. | **Not used.** The owner chose the household's SearXNG, which the web-search module already reaches (decided, §9). No key, no quota, and Google sees no search from us. |
| SearXNG's video search returns results from several sites and cannot ask for "embeddable only". | Only results whose address is a YouTube watch address are kept (the video id is read from it). Videos that refuse embedding (errors 101, 150) are found out by the page; the module tries the next result, at most twice. |
| The player needs a Referer (error 153 otherwise). | The page sets `Referrer-Policy: strict-origin-when-cross-origin`, `origin=` and `enablejsapi=1`. |
| Unmuted autoplay in a cross-origin frame needs the page to have been interacted with and `allow="autoplay"`. Behaviour differs per browser **[to verify in step 0]**. | When the browser blocks it (`onAutoplayBlocked`), the player is shown ready and the assistant says "Tap play to start." |
| Fullscreen from script needs a gesture. | The theatre layout fills the page instead; YouTube's own fullscreen button still works by touch. |
| Ads play unless that browser is signed in to YouTube Premium. | Nothing to do; said in the setup notes. |

**This repository**

| Fact | Consequence |
|---|---|
| Every page is served cross-origin isolated (`Cross-Origin-Embedder-Policy: require-corp`, `apps/assistant/src/serve/http.ts`). That blocks third-party scripts and frames that do not opt in; Spotify's and YouTube's do not. | **Decided: isolation goes off** for the voice page (§9; `SERVE_CROSS_ORIGIN_ISOLATION=false` exists). The cost is a slightly less exact count of what was heard when a reply is cut off (docs/RUNNING.md). |
| Presentations are a closed set (`card`, `list`, `timer`, `image`, `weather`), last at most minutes or hours, close without telling the module, and carry no player state back. | A player is **not** a presentation. It gets its own small contract (§4). |
| No message lets a module tell a device to do something, or a page report state to a module. | Two new, additive protocol messages (§4). |
| `Playback` is keyed by room and only music provides it. Its one consumer is the host's "stop". | It becomes keyed by device (§4). |
| Modules reach the internet only through `@pva/net`, which sends GET and HEAD (plus JSON POST to owner-typed LAN addresses). Spotify needs PUT and POST with JSON, and one form-encoded POST for tokens. | A new helper for fixed public API hosts (§4). |
| A module cannot keep a secret it obtained itself; the vault holds only what the owner typed and route tokens. | A vault-backed credential slot for modules (§4). |
| Module routes exist (`/api/modules/<id>/…`), including a public GET meant for a sign-in callback. No module uses one for sign-in yet. | The Spotify callback is the first. |
| The echo gate knows only the assistant's own speech. Nothing ducks, and there is no rule that requires the wake phrase while media plays. Browser echo cancellation of SDK and iframe audio is unproven. | Ducking and a media guard are part of this plan (§6), and step 0 measures them. |
| The web-search module already offers other modules an image search over SearXNG (`WebImages` in `@pva/module-contracts`, used by `images`). | Video search is added the same way (§4.7). |
| `"video"` already exists as a `speaker.media` capability; the page does not declare it. | The page declares it, plus which players it has. |

## 4. Changes below the module

Each is the smallest thing that makes the module possible. They are host changes, so they need the owner's approval
as the Reports service did (docs/MODULES.md §18).

**4.1 `DevicePlayers` (core service, `packages/core`).** The module's way to a page's player, and the page's way back.

```ts
interface DevicePlayersService {
  /** What the device's page last reported, or `undefined` when it has no player. */
  readonly state: (deviceId: string) => Effect<PlayerState | undefined>
  /** Sends a command and waits for the page's next report (at most `ackTimeoutMs`). */
  readonly send: (deviceId: string, command: PlayerCommand) => Effect<PlayerState, PlayerError>
  /** Reports as they arrive (ended, error, paused by touch, closed). */
  readonly changes: Stream<{ deviceId: string; state: PlayerState }>
}
```

- `PlayerCommand`: `open { source, ref, title, … }`, `play`, `pause`, `next`, `previous`, `seek`, `volume`, `duck`,
  `close`, and `token` (a fresh Spotify access token for the SDK).
- `PlayerState`: source (`spotify` | `youtube` | none), status (`loading`, `playing`, `paused`, `ended`, `blocked`,
  `error`), what is playing (title, artist, art address, duration, position), volume, the Spotify device id once the
  SDK is ready, and an error code.
- `source` is an open string on the wire and a closed list in the page: a page that does not know a source answers
  `error: unsupported`. Core never imports a provider.

**4.2 Protocol (`packages/protocol`).** Two message types, both additive, so the version stays 12:

- server → page: `media.command { command }` (one message type with the command union inside; the server union is
  close to the compiler's limit);
- page → server: `media.state { state }`, rate-limited, sent on every change and every few seconds while playing.
- `DeviceCapabilities` gains optional `media.players: string[]`; the page also declares `"video"` in `speaker.media`.

**4.3 `Playback` keyed by device.** `pause(deviceId)` and `changeVolume(deviceId, …)`; the room form goes. The
host's "stop" passes the device it already knows (`PhrasePorts.deviceId`). `pause` answers `true` from the page's
confirmed state. `changeVolume { by }` works now, because the page reports its level.

**4.4 `@pva/net`: calls to a fixed public API.** A module-usable helper for `https:` hosts named in the module's own
code (here `api.spotify.com`, `accounts.spotify.com`): GET, PUT, POST, DELETE; a JSON or form body; sent once, never
retried on a redirect; every other rule of `safeFetch`. `postFixedPublicJson` (host-only today) is the model.

**4.5 Module credentials in the vault.** `host.credentials.get/set/clear(name)`: a value the module obtained itself
(the Spotify refresh token), kept in the key vault next to route tokens, never in settings or the store, never sent to
a page. Locked vault: the module keeps the token it started with and health says sign-in cannot be renewed.

**4.6 Serving.** Isolation off for the voice page and `Referrer-Policy: strict-origin-when-cross-origin`.
The end-to-end test that asserts the isolation state changes with it.

**4.7 `WebVideos` (web-search module).** A second service beside `WebImages`, offered while the SearXNG address is
set and valid: one call is one SearXNG request in the `videos` category, answering title, address, source site,
length and thumbnail address per result, with the module's safe-search level and blocked sites applied. This is a
change to `packages/module-web-search` and `packages/module-contracts`, not a host change. Step 0 checks what the
owner's SearXNG actually returns for videos (which engines are on, whether YouTube results carry a length).

## 5. The page (`apps/web`)

- **A player surface on the stage**, separate from presentations, driven by `media.command`:
  - *Music panel*: cover art, title, artist, Spotify link and logo, previous / play-pause / next, progress, volume,
    close. The character stays; the panel docks beside it.
  - *Theatre*: the YouTube frame at 16:9, as large as the viewport allows with room for a control strip outside it
    (title, next result, close). The character becomes a corner badge and grows back while the assistant listens or
    speaks. Nothing of ours overlaps the player.
- **Two page players behind one interface** (`open`, `play`, `pause`, `next`, `previous`, `seek`, `setVolume`,
  `state`), in `apps/web/src/lib/media/`: one loads Spotify's SDK script, one YouTube's IFrame API. They load only
  when the server says the module is on, so a household without it contacts neither company.
- **Start** unlocks both (Spotify's `activateElement()`; the page's activation covers the YouTube frame).
- **Touch and voice share one state.** A touch on our buttons goes straight to the page player and is reported; a
  touch inside YouTube's player arrives as its state event. The module never needs to be asked for a pause.
- **Hidden tab**: the video pauses (YouTube's policy). Music keeps playing.
- **Reload or reconnect**: the page reports "no player"; the module does not restart anything by itself.

## 6. Listening while something plays

This is the part most likely to go wrong, and nothing here is proven.

- **Ducking, in the page, with no round trip.** When the wake phrase is heard, and while the assistant listens and
  speaks: music drops to a duck level (default 20 %) over about 150 ms and returns a second after the reply ends.
  **Video pauses instead** and resumes afterwards (a talking video at 20 % is still heard as speech) unless the
  command was itself "pause" or "close". Both are settings, so music can be set to pause too.
- **Media guard.** While a device's player is `playing`, that device needs the wake phrase for every request: no
  follow-up window and no answering without the phrase. Otherwise lyrics and video speech become turns. This is a
  change to the route gate, fed by `DevicePlayers` state, and it is the guard docs/PHRASES.md lists under "Not now".
- **So "pause" is "hey …, pause"** in this version. Bare "pause" while media plays (the `audible` window) stays out.
- **What step 0 measures**: how often the wake phrase is heard over music and over a video at normal volume, and how
  much of the media's sound reaches speech recognition with the browser's echo cancellation on. If the wake phrase is
  not reliable, the design needs push-to-talk on the panel as a fallback before anything else is built.

## 7. The module (`packages/module-media`)

**Tools and actions**

| Tool / action | Parameters | Risk | Example | Answers |
|---|---|---|---|---|
| `media_play_music` (`media.play_music`) | `query`, `kind` (`track`, `album`, `artist`, `playlist`; optional), `artist?`, `queue` (`now`, `add`; default now) | change | "play the album Kind of Blue by Miles Davis" | "Playing the album Kind of Blue by Miles Davis." |
| `media_play_video` (`media.play_video`) | `query` | change | "play a video about sharpening knives on YouTube" | "Playing How to Sharpen a Knife, from Bon Appétit." |
| `media_pause`, `media_resume`, `media_next`, `media_previous` | none | change | "pause", "next song", "skip" | "Paused." / none when the result is audible |
| `media_seek` | `by` (seconds, ±) or `to` (seconds) | change | "go back thirty seconds" | "Went back 30 seconds." |
| `media_volume` | `level` (0–100) or `change` (`up`, `down`) | change | "turn the music down" | "Music at 40 percent." |
| `media_close` | none | change | "close the video", "stop the music" | "Closed." |
| `media_now_playing` | none | read, speculative | "what's playing?" | "Feeling Good by Nina Simone, on Spotify." |

- No `where`: everything acts on the asking device (`CurrentTurn.deviceId`).
- `queue: add` is for a track only (Spotify's queue takes single tracks); "play next" is not offered.
- A playlist is looked for among the owner's own playlists first, then by search.
- "Next" on a video is the next search result; on music it is Spotify's next track.
- Phrase commands: the music module's English and Dutch tables for pause, resume, next and previous, without the
  `{where}` forms, plus "pause the video", "back / forward ten seconds" and their Dutch forms.
- Kept from the music module: the once-per-phrase-invocation record, the text table pattern (English and Dutch), the
  cleaning of outside text (titles and names are data, never instructions). Dropped: room resolution, the Home
  Assistant calls, the name-form refusals (they guarded a Music Assistant quirk).

**Needs.** `uses: ["web-search"]` for `WebVideos`, looked up at each use. With the web-search module off or without a
SearXNG address, the video tool says so and music still works.

**How a play request runs.** Search (server; Spotify's own search for music, `WebVideos` with "youtube" kept to
YouTube results for video) → the page is told to open the source if it is not open → for Spotify,
`PUT /me/player/play` on the page's Connect device id; for YouTube, `open { ref: videoId }` → wait for the page's
`playing`, `blocked` or `error` → answer. Pause, resume, next, previous, seek and volume go to the page player only,
not through Spotify's Web API: faster, and no quota.

**Settings**

| Key | Kind | Notes |
|---|---|---|
| `spotifyClientId` | text | from the owner's Spotify developer app |
| `spotifyClientSecret` | secret | vault |
| `spotifySignIn` | action + info | shows the exact redirect address to register, opens Spotify's sign-in, shows "signed in as …, until 2027-05-21" |
| `videoSafeSearch` | choice (`strict`, `moderate`, `none`; default `moderate`) | passed to SearXNG |
| `musicWhileTalking` | choice (`lower`, `pause`; default `lower`) | |
| `duckLevel` | number (0–100, default 20) | how far music is lowered while the assistant listens or speaks |
| `videoWhileTalking` | choice (`pause`, `duck`; default `pause`) | |

Each source works alone: without a Spotify sign-in the music tools say so and video still works, and the other way
round.

**Routes.** `GET /api/modules/media/spotify/callback` (public, as a sign-in callback must be): checks the `state` it
issued, exchanges the code, stores the refresh token (§4.5), answers a small "You can close this page".

**Health.** Spotify not signed in; sign-in ends within 14 days; the owner's Premium lapsed (`account_error`); the
web-search module off or without a SearXNG address (no video search); a device reported no encrypted-media support; isolation still on.

**Stores.** Nothing but the credential: no search cache (SearXNG has no quota), no watch or listening history. The refresh token is in the vault, not the store.

**Access tokens.** The server refreshes the hour-long access token and hands one to the page over its own connection
(`token` command) when the SDK asks. Note: a device id is claimed, not proven (docs/MODULES.md), so any page admitted
as a voice device can get a token that controls the owner's Spotify playback. That is the same trust the page already
has over the assistant.

## 8. Build order

Work is delegated to Sonnet with a written brief per step; each step is its own pull request and gets an independent
review before the next starts. `pnpm check` and `pnpm test` pass at every step, run one at a time.

| Step | What | Depends on |
|---|---|---|
| **0. Spike** (throwaway page, no repo changes merged) | On the owner's real device and browser: Spotify SDK loads and plays with isolation off; YouTube frame autoplays after one press; wake-phrase hit rate and echo over music and video; latency from command to sound. Also: what the owner's SearXNG returns for a video search. Needs a Spotify developer app from the owner. **The plan is revised from these numbers.** | none |
| **1. Host pieces** | §4.4 net helper, §4.5 credentials, §4.6 serving, and §4.7 `WebVideos` in the web-search module (its own pull request). Tests for each. | 0 |
| **2. Contract** | §4.1 `DevicePlayers`, §4.2 protocol and capabilities, §4.3 `Playback` by device with the host's "stop" moved over; docs/ARCHITECTURE.md and docs/PHRASES.md updated. Music module still compiles against a shim or is switched off here. | 1 |
| **3. Page** | Player surface, theatre layout, the two page players, ducking, the mock server. Driven by the mock before any module exists. | 2 |
| **4. Module** | `packages/module-media`: Spotify sign-in and search, YouTube search, tools, actions, phrases, settings, health, tests with fake providers and a fake page. | 2 (3 for the end-to-end run) |
| **5. Media guard** | Route-gate rule from player state; measured again on the device. | 3, 4 |
| **6. Remove music** | Delete `packages/module-music` and this plan's "plan" status; rewrite this page as the module's page; update docs/MODULES-STATUS.md, docs/MODULES-PLAN.md, the catalog test, the protocol examples, the Home Assistant contract's comments. | 4 |

Steps 3 and 4 can run in parallel once step 2 is merged.

## 9. Decisions (owner, 2026-11-21)

1. **Spotify's policy against voice assistants controlling Spotify**: ignored; go ahead with Spotify.
2. **Page isolation**: off, so Spotify's and YouTube's players can load.
3. **The assistant is reached over HTTPS**, so Spotify's sign-in returns to
   `https://<the assistant's address>/api/modules/media/spotify/callback`.
4. **Video search goes through SearXNG**, not YouTube's Data API. No Google API key.
5. **While the assistant listens and speaks**: music lowers, video pauses. Pausing music instead is a setting.
6. **Module id `media`** replaces `music`; the old settings and the room table are dropped, not migrated.
