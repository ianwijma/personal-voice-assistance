# Music

Research write-up, 2026-11-17. Not an approved design. Outside facts carry inline links checked on this date; claims
marked **[unverified]** come from memory or a secondary source. Latency figures are estimates to be measured with
`TurnTrace`, never promises.

## 1. Summary

One `music` capability with several providers behind it. It finds music, radio and podcasts by voice. It plays them
on the device that heard the request, a named room or a group. It handles pause, skip and volume without the language
model, and shows what is playing on screens. The owner asked for "a Spotify module, or a music module that has a bunch
of integrations in it". This document recommends the second, with Music Assistant as the main backend and Spotify
both through it and directly.

- **Priority: first wave.** Music is the first or second use of every smart speaker in every survey
  ([landscape-voice-assistants.md](../module-investigation/landscape-voice-assistants.md) §13).
- **Effort: L.** Search and queue semantics are a medium job. The large part is getting audio out of the right place
  and ducking it while the assistant listens and speaks. That needs Device capabilities, a new media path to the
  browser, and changes to the route gate.
- **A useful first version is M**: Music Assistant (or Spotify Connect) driving speakers the household already has.
  The server touches no audio at all in that version.

## 2. What others do

| System | How it handles music | Copy | Avoid |
|---|---|---|---|
| Alexa, Google, HomePod | Linked accounts (Spotify, Apple Music, YouTube Music); "play X in the kitchen"; speaker groups; "move the music to the bedroom"; a default service per household; voice ID picks the person's account ([landscape](../module-investigation/landscape-voice-assistants.md) §1–3) | Default service, rooms and groups as first-class targets, per-person accounts, ducking on the wake word | Alexa+ music requests taking over 10 s (same source, §1f); a vague "Playing music by…" that names the wrong track |
| Home Assistant Assist | `HassMediaSearchAndPlay` with Music Assistant; `HassMediaPause/Unpause/Next/Previous`, `HassSetVolume`, all local without a model ([landscape](../module-investigation/landscape-voice-assistants.md) §4) | Transport intents that never touch a model | — |
| Music Assistant | One library over Spotify, Tidal, YouTube Music, Plex, Jellyfin, Subsonic, radio and local files. Players on Sonos, Cast, AirPlay, Snapcast, Squeezebox, DLNA and its own protocol, Sendspin. Groups and queue transfer. 64,529 HA installs ([landscape](../module-investigation/landscape-automation-platforms.md) §1.1, §11) | Integrate it, never rebuild it | — |
| OVOS (OCP) | Common Play: every media skill answers a search with a confidence and the best wins | Several providers answer one search and a ranker picks | Ranking by skill self-reported confidence |
| Raycast | Spotify Player is the 5th most installed extension ([landscape](../module-investigation/landscape-launchers-and-agent-tools.md) §1.1) | Spotify control on the desktop is a habit people already have | — |

Takeaway: the big assistants put rooms, groups and per-person accounts first. Home Assistant shows that transport
control does not need a model at all.

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | "Hey Jev, play some Nina Simone." → "Nina Simone, on Spotify, here in the kitchen." (music starts while the sentence ends) | no |
| 2 | (music playing) "Hey Jev, pause." → music stops within the second; a short cue instead of speech (fast path) | no |
| 3 | "Play Radio 2." → "Radio 2: NPO Radio 2 or BBC Radio 2?" → "The Dutch one." → "NPO Radio 2." | no; with a screen, the two stations are shown as a `list` with `pick` |
| 4 | "What's this song?" → "Feeling Good, by Nina Simone, from *I Put a Spell on You*." The screen shows the `media` card. | optional |
| 5 | "Play something like this." → "Here's a mix around Nina Simone: next is Etta James." | no |
| 6 | "Move the music to the living room." → "Moved to the living room." (queue transfer; the kitchen stops) | no |
| 7 | "Play the latest episode of The Rest Is History." → "Episode 612, from yesterday, 58 minutes." Later: "Continue my podcast." → resumes at 23:40. | no |
| 8 | Failure: "Play Taylor Swift on the bedroom speaker." → "The bedroom speaker isn't reachable right now. Shall I play it here instead?" | no |
| 9 | Failure: "Play my Discover Weekly." → "I can't open Spotify's own playlists with this setup. I can play your liked songs, or a mix based on what you've played lately." (see §5.2) | no |
| 10 | Ambiguous: "Play it louder." while music plays on the living-room group and the kitchen hears it → volume up on the group playing *from* the device's room, not on every speaker | no |
| 11 | Two people: "Play my running playlist." on the hallway device, whose default member is Ian, said by Anna → plays Ian's playlist unless Anna says "as Anna" (Connection resolution, §10) | no |

## 4. Tools

Risk classes follow the template: **safe** (read), **changes** (changes data or state: playback, a library), **costly**
(outward-facing or costly). They map onto the proposal's `read` / `change` / `message`-`money` classes in
[module-definition-config-and-dependencies.md](../module-investigation/module-definition-config-and-dependencies.md) §B.5.

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `music_play` | `query`, `kind?: track \| album \| artist \| playlist \| genre \| radio \| podcast`, `where?: string` (room, device, group, "here"), `enqueue?: replace \| next \| add`, `shuffle?`, `source?` | what started, where, from which provider; a `media` Presentation | W | changes | search 150–600 ms plus start 300–1500 ms by provider | yes for the "play <favourite>" form |
| `music_control` | `action: pause \| resume \| stop \| next \| previous \| restart`, `where?` | new state | W | changes | 100–500 ms | **yes** |
| `music_volume` | `level?: 0–100`, `change?: up \| down \| number`, `where?` | new level | W | changes | 100–500 ms | **yes** |
| `music_now_playing` | `where?` | title, artist, album, position, source, player; a `media` Presentation | R | safe | 50–200 ms | **yes** (spoken template) |
| `music_search` | `query`, `kind?`, `limit? ≤ 10`, `source?` | ranked items with ids, for "the second one" | R | safe | 150–600 ms | no |
| `music_move` | `to`, `from?` | the target and what moved | W | changes | 0.5–2 s | yes ("move the music to X") |
| `music_group` | `rooms: string[]`, `action: join \| leave` | the group | W | changes | 0.5–2 s | no |
| `music_like_this` | `seed?: "current" \| query`, `where?` | the first track of the mix | W | changes | 1–3 s | no |
| `music_save` | `what: "current" \| itemId`, `to: library \| playlistName` | ok | W | changes (writes to the person's account) | 200–600 ms | yes ("like this song") |
| `radio_play` | `station?`, `tag?`, `country?`, `where?` | station name, codec | W | changes | 300 ms–1 s | yes for favourites |
| `podcast_play` | `show`, `episode?: latest \| next \| resume \| title` | episode, duration, resume point | W | changes | 0.5–2 s | yes for "continue my podcast" |
| `music_sleep` | `after: duration`, `where?` | when it stops (a Scheduler job) | W | changes | < 50 ms | yes |
| `music_sources` | none | providers, connections and their health, players per room | R | safe | < 50 ms | no |

Nothing is costly: no purchases, no messages. `music_save` writes to a person's own account and should be refused for
guests (§13). Every read tool is `speculative`.

## 5. Integrate or build

### 5.1 Where audio comes out: the deciding question

In serve mode the server never touches a sound card. Browsers play the mono s16 PCM reply audio it sends over the
WebSocket ([current-system.md](../module-investigation/current-system.md) §5.4). PipeWire (`pw-cat`) is used only by
the CLI `voice` mode. Voice nodes (designed on an unmerged branch) use ALSA. So music has these routes. Routes 1, 2
and 4 extend §C.1 of the dependencies document; route 3 is new.

| Route | How | Devices | Ducking | Effort |
|---|---|---|---|---|
| **1. External player** | The server calls an API: Music Assistant (directly or via HA `media_player`), Spotify Web API on a Connect device, Jellyfin session, MPD. Audio comes out of Sonos, Cast, AirPlay or a hi-fi. | Any room with a networked speaker; the voice device itself stays silent | Server-side volume call per turn, 100–500 ms per call (estimate), or pause | M |
| **2. Server streams over the reply channel** | Mix music into the PCM the device already plays | Every device | Exact (the server mixes) | XL: a stereo or compressed media channel, mixing, a protocol bump. Not recommended |
| **3. The device plays a URL** (new) | The server sends `media.play { url, gain }` and the page plays it in its own `<audio>` element. The URL is a server proxy, `/media/stream/<id>` (radio, local files, Jellyfin/Subsonic, podcasts). Inside the browser, the Spotify Web Playback SDK makes the tab a Connect device. | Browser devices | **Local and immediate.** The page is the reply player too, so it ramps music gain down at the first reply chunk with no round trip | M |
| **4. A player on the node** | `mpv`, Spotify Soloist or go-librespot on the voice node, commanded by the server | Voice nodes | Local, through the node's mixer | M per player, after voice nodes merge |

**Recommendation.** Ship route 1 first, with no audio in our stack. Add route 3 next for "here" on browser devices.
Add route 4 when voice nodes exist. Skip route 2. Route 3 needs a proxy because many radio streams are plain `http://`:
the radio-browser result for "NPO Radio 2" is `http://icecast.omroep.nl/radio2-sb-aac` (queried 2026-11-17), and an
`https://` voice page would block it as mixed content.

### 5.2 Providers

| Provider | Facts that decide it | Verdict |
|---|---|---|
| **Music Assistant** (MA) | Multi-provider library, players, groups and queue transfer. HA actions `music_assistant.play_media`, `search`, `get_library`, `get_queue`, `transfer_queue`, `play_announcement` ([HA docs](https://www.home-assistant.io/integrations/music_assistant/)). Player entities pause automatically during announcements (same page). "Endless Mix" keeps playing similar music ([MA play media](https://www.music-assistant.io/faq/massplaymedia/)). Its web player is a Sendspin player, so a browser tab can join synchronised multi-room playback ([MA Sendspin](https://beta.music-assistant.io/player-support/sendspin)). Sendspin is an Open Home Foundation protocol at "Release Candidate 1", with JavaScript, Python and C++ SDKs under Apache 2.0 ([sendspin-audio.com](https://www.sendspin-audio.com)). | **Primary backend.** Use it through the existing HA module first. Use its own WebSocket API later **[unverified: API shape]**. |
| **Spotify Web API** | Since 2026-02-11 (new apps) and 2026-03-09 (existing apps), Development Mode needs a Premium owner. The cap is **five authorised users per client ID** ([Spotify blog](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)), and the app stops working if the owner's Premium lapses. Search `limit` max is 10, default 5. Batch `GET /tracks`, `/albums`, `/artists`, `browse/*`, `artists/{id}/top-tracks` and other users' playlists are removed. Playlist reads work only for playlists the user owns or collaborates on ([migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)). Since 2024-11-27, new apps get no recommendations, related artists, audio features or Spotify-owned editorial playlists **[from memory: Spotify blog 2024-11-27]**. Up to 25 client IDs per account, sharing one quota; a 429 carries `"reason": "QUOTA_EXCEEDED"` ([2026-07-23](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)). **Refresh tokens expire six months after sign-in**, and refreshing does not extend them ([2026-06-18](https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration)). Extended quota is only for organisations with 250k MAU ([quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)). Player endpoints (`PUT /me/player/play`, `PUT /me/player` transfer, `GET /me/player/devices`, `POST /me/player/queue`, `PUT /me/player/volume`) need Premium **[from memory; the migration guide lists no player changes]**. | **Yes, as a Connection per member**, for control and personal library. Five users fits a household. No "Discover Weekly" (example 9). |
| **Spotify Web Playback SDK** | Turns a browser tab into a Connect device. Premium only; mobile-only Premium plans excluded. Chrome, Firefox, Safari and Edge on Android, iOS, macOS, Windows and Linux. On iOS, playback does not start automatically after a transfer. "Must not be used in commercial projects without Spotify's prior written approval" ([SDK](https://developer.spotify.com/documentation/web-playback-sdk)). Needs encrypted media: Chromium builds without Widevine will not play **[unverified for the owner's kiosk browser]**. | **Yes, for route 3 on screens.** Personal use is not commercial. |
| **Spotify Soloist** | Spotify's own headless Connect client, released 2026-08-13 ([blog](https://developer.spotify.com/blog/2026-08-13-introducing-spotify-soloist)). It runs on Linux (PipeWire, PulseAudio fallback, `--pipewire-device`), Apple Silicon and Windows. Setup needs Premium; Free and Premium users can then connect. It has an optional local WebSocket API (`--ws 127.0.0.1:0`) with no authentication, and `soloist ctl` with `status`, `now`, `queue`, `pause`, `play`, `volume`. **Builds expire 90 days after their build date** (exit code 10) ([overview](https://developer.spotify.com/documentation/soloist/concepts/overview)). | **Preferred for route 4** on nodes and on a PipeWire desktop. The 90-day expiry needs the node self-update path. |
| **librespot / go-librespot / spotifyd** | librespot is Premium only. It warns that "accounts created after an apparent cutoff date can no longer obtain the audio decryption keys", with no known workaround ([README](https://github.com/librespot-org/librespot), [issue #1649](https://github.com/librespot-org/librespot/issues/1649)), and that use "is probably forbidden" by Spotify. go-librespot (GPL-3.0) has a REST API on port 3678 (`/status`, `/player/play`, `/player/queue`) plus WebSocket events, and zeroconf, interactive or device-auth login ([repo](https://github.com/devgianlu/go-librespot)). spotifyd is built on librespot. | **Fallback only.** Soloist is the supported path now. |
| **MPD / Mopidy** | MPD protocol on TCP 6600 (`add`, `play`, `pause`, `setvol`, `idle player`); Mopidy adds JSON-RPC at `/mopidy/rpc` and `/mopidy/ws` with extensions for local files, Jellyfin, Subsonic and podcasts. Snapcast adds multi-room, and its Snapweb client plays in a browser **[from memory]**. Mopidy-Spotify depends on a librespot-based GStreamer plugin **[from memory]**, so it inherits the same key problem. | Provider for owners who already run it; not a reason to install it |
| **Jellyfin, Navidrome, Subsonic** | Jellyfin REST with an API key (`Authorization: MediaBrowser Token="…"`), search via `GET /Items?searchTerm=&IncludeItemTypes=Audio`, stream via `/Audio/{id}/universal` **[from memory]**. Navidrome speaks the Subsonic API (`search3`, `stream`, token auth `t = md5(password + salt)`); OpenSubsonic adds API keys **[unverified]**. | Through MA first; direct as a route 3 source (the server proxies `stream`) |
| **YouTube Music** | No official API. `ytmusicapi` is unofficial. Playback means yt-dlp stream extraction, against YouTube's terms (see [video.md](video.md) §5) | Only through MA's provider, at the owner's own risk; never built by us |
| **Local files** | A folder on the server: tags read with `music-metadata` (npm, pure JS) **[unverified: package choice]**, served through the route 3 proxy | Through MA if MA runs; else a small built-in source |
| **Internet radio** | radio-browser.info: find servers via DNS `all.api.radio-browser.info`, send "a speaking http agent string", count each play with `/json/url/<stationuuid>` ([API](https://api.radio-browser.info/)). `GET /json/stations/search?name=&countrycode=&tag=&order=clickcount&reverse=true&hidebroken=true&limit=` returns `url_resolved`, `codec` and `bitrate` (checked live). | **Build** (S): keyless, local-first, a top HA integration |
| **Podcasts** | Podcast Index API (free key and secret, SHA-1 auth header, `/api/1.0/search/byterm`) and the keyless iTunes Search API (`media=podcast`) **[from memory]**; then the RSS feed itself | **Build** (M): subscriptions and resume points are ours (person scope) |

### 5.3 "Play something like this"

Spotify's recommendation endpoints are gone for new apps, so the module cannot ask Spotify for "similar". Options, in
order:

1. **MA's Endless Mix / `radio_mode`** when MA plays the track. It is MA's problem.
2. **An open similarity source**: ListenBrainz radio or Last.fm `track.getSimilar` **[unverified: current terms]**,
   then provider search per track. Each search costs one call against the shared development quota.
3. **The language model suggests ten tracks**, and the module resolves each with `music_search`. It costs one model
   round (about 150 output tokens) and up to ten searches; measure with `TurnTrace`. The first track can play after
   the first search hit.

Recommendation: 1 where available, else 3. Option 2 only if 3 picks badly.

## 6. Data

All of it lives in the Module store ([shared-state-jobs-and-notifications.md](../module-investigation/shared-state-jobs-and-notifications.md) §4).

| Collection | Scope | Rough schema | Readable by others |
|---|---|---|---|
| `players` | household | `{ id, provider, providerPlayerId, name, room?, kind: speaker \| group \| browser \| node, lastSeen }` | yes (`exports`: rooms with speakers) |
| `favourites` | household and person | `{ label, kind, providerRef, aliases[] }` ("Radio 2" = NPO Radio 2) | yes |
| `playback` | device | `{ playerId, source, item, startedAt, positionMs, state }`, last known per device | yes: ambient fact "kitchen: Nina Simone, playing" |
| `podcastSubscriptions`, `episodeProgress` | person | `{ feedUrl, title }`, `{ episodeGuid, positionMs, finished }` | no |
| `lastResults` | conversation | the last search result list, for "the second one" | no |

Listening history is not stored by default. The providers keep their own.

## 7. Long-running work and events

- **Scheduler** jobs: sleep timer (`deferred command`, "stop in 30 minutes", with a 10 s fade); podcast feed refresh
  (`recurring`, every 6 h); Spotify token check (`recurring`, daily). Missed while down: the sleep timer runs at start
  if it is late (stopping is harmless); feeds refresh once.
- **Events** published: `music.playback.changed { deviceId?, playerId, state, item }`, `music.queue.changed`,
  `music.connection.expiring`. Front ends use the first for the `media` presentation; the character extension (§8)
  uses it too.
- **Events** consumed: `notification.ringing` (duck or pause the player in that room while a timer rings, resume
  after); `alarm.due` from an alarms module ("wake me with Radio 2" calls `radio_play`).
- **Restart**: route 1 and 4 players keep playing; the module re-reads their state at start. Route 3 audio keeps
  playing in the tab while the WebSocket reconnects; the page reports its `media` state again in `hello`.

## 8. Presentation

Uses the Presentation foundation's `media` kind ([presentation-and-device-capabilities.md](../module-investigation/presentation-and-device-capabilities.md) §3.2), with lifetime `pinned`.

- **Now playing**: Orbit layout. Album art and title sit docked beside the character, with play/pause/skip as
  `actions` of type `tool`. When idle, the Ambient layout makes the art large, StandBy-style, with the character small
  and dozing in a corner. Album art comes through `/media/<hash>` like every image.
- **Choices**: `list` with `pick` for stations or albums ("Radio 2", example 3).
- **Queue**: `list` (numbered) on request ("what's next?").
- **The character reacting to music** is a new optional extension, `media.playback`: `{ v: 1, state, level?,
  beatPhase? }`. It follows `CHARACTERS.md` §5.2: optional, ignored by old characters, never on the reply path.
  - `level` exists only when the audio passes through the page's own Web Audio graph (route 3 proxy streams). An
    `AnalyserNode` on the `<audio>` element gives it for free.
  - Spotify's SDK audio (encrypted media) and external speakers give no level, and Spotify's audio-features endpoint
    is gone for new apps. Those get `state` only.
  - A figure may sway gently or tap in time; a light character may breathe with the level. This is attention, not
    emotion (`CHARACTERS.md` §2.3). It drops to stillness when the assistant listens or speaks, so the person can always tell the two
    states apart.
- **Without a screen**: one sentence naming what plays and where ("Nina Simone, on the living-room speakers"). "What's
  playing" is spoken from the template "*title*, by *artist*", with the album only when asked.

## 9. Notifications and proactive behaviour

- `low`: "Spotify sign-in for Ian expires in 7 days" (six-month token), shown in the admin inbox and as a badge on
  Ian's devices, never spoken.
- `normal`: a new episode of a subscribed podcast, only if the person turned it on; inbox only by default.
- Nothing is spoken unprompted. Music is the cause of interruptions, never the source of them.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | default provider order (`music-assistant`, `spotify`, `radio`, …); room → default player; radio country; explicit content allowed | MA first; country from `HOME_LOCATION` |
| Module | MA URL and token (or "via Home Assistant"); MPD host; Jellyfin/Navidrome URL and key; Podcast Index key and secret (vault); stream proxy on/off | via HA |
| Assistant | which providers it may use; a "DJ" persona template (§12) | all |
| Device | where "here" plays: `this device` (route 3 or 4), a named player, or `none`; duck level (default 20 %); **media guard** (§12) on | the room's player, else this device |
| Person | own Spotify Connection; explicit filter; podcast subscriptions | — |

Connections: `spotify` (per person, scopes `user-read-playback-state`, `user-modify-playback-state`,
`user-read-currently-playing`, `user-library-read`, `user-library-modify`, `playlist-read-private`, `streaming` for
the SDK). The flow is the loopback-paste or HTTPS-domain one from §B.4 of the dependencies document, because Spotify
offers no device-code flow and rejects `localhost` and plain-HTTP LAN redirects
([redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)).

First-run setup for the owner:

1. Point the module at MA, or confirm "via Home Assistant".
2. Map rooms to players; the module proposes a mapping from HA areas.
3. Optionally create a Spotify app (Premium owner), add up to four other household members in its User Management,
   and connect each person.
4. Pick favourite stations.

## 11. Native tools and dependencies

Declared with Requirements and health ([dependencies](../module-investigation/module-definition-config-and-dependencies.md) §C.3).

| Need | Where | When missing, the assistant says |
|---|---|---|
| Music Assistant server (a service) | LAN | "Music isn't connected right now; Music Assistant isn't answering." |
| Spotify Connection | vault | "Spotify isn't linked for you yet. The owner can link it in Settings." |
| Soloist or go-librespot | the playback device (node) | "This speaker can't play Spotify itself. I can play it on the kitchen speakers." |
| `mpv` | the playback device (node) | "This speaker can't play radio yet." |
| `ffmpeg` | server, optional | only for streams browsers cannot decode: HLS radio on browsers without native HLS **[unverified which]**; otherwise not needed |
| Widevine-capable browser | the screen device | the Web Playback SDK fails to start; fall back to the room's player and say so once |

## 12. Interaction with the rest of the system

**Ducking (the hard part).**

- Browser and node routes duck locally: the page ramps media gain to the duck level over about 150 ms when the
  first reply PCM chunk arrives and when a `wake` message arrives. It restores the gain 1 s after `reply.end`, or
  when the follow-up window closes. That is no extra round trip.
- External players get one volume call at `wake` and one at the end. If the player's volume call is slow (measure:
  `TurnTrace` marks around the call), use pause and resume instead. MA announcements already pause by themselves.
- Timers ringing (`notification.ringing`) duck the room's player for the length of the ring.

**Listening while music plays.**

- Browser echo cancellation cancels only what the browser itself plays, and even that is unproven for Web Audio output
  ([UI-AND-MODULES.md](../../UI-AND-MODULES.md) §5 echo test, "verify"). Music from a Sonos in the same room is not
  cancelled at all.
- So, with music on in a device's room, the **media guard** puts the device's route gate into "phrase required": it
  behaves as if `withoutPhrase` were `nobody` and follow-up windows were off. Otherwise lyrics become turns. The
  guard is on while `music.playback.changed` says `playing` for a player in that room.
- The wake phrase itself is harder to hear over music. Measure with "Save what the assistant hears" and `pnpm start
  compare-models` before promising it works at party volume.

**Fast path.**

- Transport commands are module actions with `examples` ("pause", "stop the music", "next", "skip this", "louder",
  "volume to thirty", "what's playing"), so the Jev intent path (BUILT, NOT WIRED) can run them without a model.
- Until Jev is wired, the closed-set control matcher proposed in
  [assistant-controls.md](assistant-controls.md) §5 (option A) answers them with a cue. It sits between the route
  gate and the dispatcher and works with no model. It never says "OK, pausing".
- "Stop" follows that document's order: ringing first, then a reply, then media on this device. "Stop the music" is
  always this module's action.
- Volume words go to the media while media plays near the device and no reply is speaking. During a reply they go to
  the speech volume (`controls_volume`). This split is proposed here, not agreed (open question 9).

**Speech recognition.**

- Artist names are mangled ("Nina Simone" → "Nina Simon"). Search is fuzzy, and the spoken confirmation always names
  what was found.
- Numbers: "volume to thirty" uses core's `ValueParsing`.
- Filler for slow providers: the model's "Let me find that" is spoken while `music_play` runs.

**Agents and assistants.**

- A `dj` assistant template (persona: short replies, names what plays, never chatty between tracks) with
  `suggestedPhrases: ["hey dj"]`.
- Every general assistant gets the transport actions.
- Typed-intent routing: "play …" utterances are a clear `handles` entry for TypeSafe.

**Other modules.** Home Assistant (players, rooms, presence); alarms (wake with music); timers (ducking); kids' mode
(explicit filter, [fun-and-ambient.md](fun-and-ambient.md)); video (YouTube music videos, [video.md](video.md)).

## 13. Privacy and safety

- A shared device plays from the device's default member's account. A guest can play radio and the household
  library, and cannot write to anyone's library (`music_save` refused: "I'll only save songs for someone I know").
- What someone listens to is personal: on a `shared` device the `media` card shows it anyway, because it is already
  audible. Queues and history of another person are not read out.
- Children: the person's or device's explicit filter is passed to providers (Spotify items have an `explicit` flag;
  MA has none **[unverified]**, so filter after search).
- No purchases exist in this module. Volume over 80 % from a voice command on a node asks "That's very loud. Sure?"
  once (core confirmation, when it is switched on).

## 14. Foundations needed

- **Before a first version:** Tool context (which device and room spoke); the HA module extended to `media_player`
  and MA actions.
- **For the full version:** Device capabilities (speaker media, room); Connection (Spotify per person); Module store
  (favourites, podcast progress); Event bus (`music.playback.changed`, the media guard); Scheduler (sleep timer);
  Presentation (`media`, `list`); Requirements and health (players on nodes); and the new `media.play` message for
  route 3.
- **Useful first version without them:** a `music` module on top of HA. It uses `music_assistant.play_media`,
  `media_player.media_pause/next_track/volume_set` and state reads, with a room → player table in module settings
  and the room passed by an `overridable` per-assistant default. That is about one week; no screen and no ducking on
  browser devices.

## 15. Open questions

1. **Music Assistant as the backbone?** It means running MA (an HA add-on or container). The alternative is Spotify
   direct plus radio only. Default: MA.
2. **Route 3 for browser devices:** is "the tablet itself plays" wanted, or is every room served by a real speaker?
   It decides whether `media.play` and the stream proxy are built at all.
3. **Sendspin in the voice page?** Making our page a Sendspin player gives multi-room sync for free. But it is a
   Release Candidate, and it duplicates route 3. Worth a spike?
4. **Who owns the Spotify app?** One Premium owner, at most five users, re-sign-in every six months. Acceptable?
5. **Media guard strictness:** require the wake phrase whenever anything plays in the room, even on devices set to
   answer without one? Default: yes.
6. **Ducking vs pausing** for external players: duck (keeps the mood, needs fast volume calls) or pause (reliable)?
   Default: duck on browser and node routes, pause on external players until measured.
7. **Disagreement with §C.1 of the dependencies document:** it lists only "server streams over the reply channel" for
   browsers. This document adds route 3 (the page plays a URL), which avoids a protocol change to the PCM channel. Do
   you agree it replaces route 2?
8. **Character and music:** may figures move to the beat (calm sway), or should characters stay still while music
   plays?
9. **"Louder" with music on:** media volume (proposed here), or always the assistant's speech volume as
   [assistant-controls.md](assistant-controls.md) defines `controls_volume`? One device volume for both is simpler,
   but it makes replies too loud after "louder" at a party.
