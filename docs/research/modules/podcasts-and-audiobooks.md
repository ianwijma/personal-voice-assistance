# Podcasts and audiobooks

Research write-up, 2026-11-18. Not an approved design. Shared foundations (Module manifest, Connection, Module store,
Scheduler, Event bus, Notification service, Tool context, Presentation, Device capabilities) are worked out in
[`../module-investigation/`](../module-investigation/) and linked, not redesigned. **[unverified]** and **[from
memory]** mark claims not confirmed in a primary source today. Latency figures are estimates to measure with
`TurnTrace`.

## 1. Summary

The module handles spoken-word audio that is listened to over days, not minutes. It finds a podcast and subscribes to
it. It gets the latest or the next episode. It plays an audiobook and keeps **one position per person** that follows
them from the kitchen to the bedroom to their phone. It supports playback speed, "back 30 seconds", chapters, and a
sleep timer that can stop "at the end of the chapter". It answers "what was that episode about?" from show notes and
transcripts. Audiobookshelf is the main self-hosted provider, for both books and podcasts. Podcast Index and the
iTunes Search API cover search. gPodder-protocol sync keeps the phone's podcast app (AntennaPod) in step.

**Boundary with [music.md](music.md).** Music owns the **playback path**: its routes 1–4 (an external player through
Music Assistant, the page's own `<audio>` element, a player on a voice node), ducking, the media guard and the `media`
presentation. This module uses that path and does not build another one. Music sketched `podcast_play`,
`podcastSubscriptions` and `episodeProgress` (music §4, §6). This document proposes to take those over (§15, question
6). Music then keeps radio and music, and this module owns everything that has a **resume position**. Feeds share the
parser with [news-and-feeds.md](news-and-feeds.md). Long *text* read aloud (ebooks without audio) is
[read-aloud.md](read-aloud.md).

- **Priority: second wave.** With Music Assistant, "play the latest episode of X" already works in music's first
  version. This module adds the parts that make listening over days work: cross-device resume, speed, chapters,
  sleep at chapter end, and sync with the phone.
- **Effort: M.** Audiobookshelf through its API, Podcast Index search and our own progress store are S–M each. Exact
  resume on external players and gPodder sync add the rest. Transcribing episodes locally for "what was it about"
  is a separate M.

## 2. What others do

| Product | How it works | Copy | Avoid |
|---|---|---|---|
| Alexa + Audible | "Read my book" resumes across Echo devices and the phone; "go back 30 seconds"; "next chapter"; sleep timer | Position belongs to the person, not the device | Book locked to one store |
| Google / Apple Podcasts on speakers | "Play the latest episode of …", "continue my podcast"; the phone and speaker share position | "Continue" as one command | Continuing someone else's podcast on a shared speaker |
| Audiobookshelf | Self-hosted server for books and podcasts with apps, users, progress, bookmarks, chapters and podcast auto-download ([API](https://api.audiobookshelf.org/), marked "out-of-date and no longer maintained") | The provider | — |
| Music Assistant | Its [Audiobookshelf provider](https://www.music-assistant.io/music-providers/audiobookshelf/) plays books and podcasts. Progress syncs both ways and is "fetched just before playback". Guest ABS users are not supported, and ABS 2.26+ wants an API key | Let MA play on Sonos, Cast and AirPlay with ABS progress | — |
| AntennaPod | Phone app syncing subscriptions and episode actions over the gPodder API or the Nextcloud [gPodder Sync](https://git.crystalyx.net/Xefir/nextcloud-gpodder/src/tag/3.8.0/README.md) app | Speak the same sync protocol | — |
| Pocket Casts, Overcast | Smart speed, trim silence, per-show speed | Per-show speed | — |

## 3. Example conversations

1. "Hey Jev, continue my book." → "*Project Hail Mary*, chapter 14, from where you stopped in the bedroom last night."
   (Ian's position from Audiobookshelf; plays on this room's player)
2. "Play the latest episode of The Rest Is History." → "Episode 612, *The Fall of Constantinople*, from yesterday,
   58 minutes." (from Podcast Index or the subscription's feed)
3. "Go back thirty seconds." → seeks, with a short cue and no speech (fast path).
4. "Faster." → "Speed 1.25." "Back to normal." → 1.0. (Per show: the next episode of that show starts at 1.25.)
5. "Stop at the end of the chapter." → "OK, I'll stop in about 12 minutes, at the end of chapter 14."
6. "What was that episode about?" → from show notes and, where the feed has one, the transcript: "Mostly the siege
   itself: the chain across the Golden Horn, the cannon from Orban, and why the walls finally fell. They mention
   Roger Crowley's book as the best account."
7. "Subscribe to Lex Fridman." → two matches in Podcast Index → "Lex Fridman Podcast, about 450 episodes? Or a clips
   show?" **(screen: a `gallery` of covers with pick)**
8. **Ambiguous.** "Continue." on the kitchen speaker after Anna listened there this morning, said by Ian → "Your
   book, or Anna's podcast that was playing here?" (only when the speaker is not resolved; otherwise Ian's)
9. **Failure.** "Continue my book." → "Audiobookshelf isn't answering. I have your position from yesterday, 3 h 12 min
   into the book, but I can't play the audio without it."
10. **Failure.** "Play the new Darknet Diaries." → "There's no new episode since the one you finished on Monday."

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `listen_continue` | `what?: "book" \| "podcast" \| title`, `where?` | what resumed, position, where | W | changes | 0.3–1.5 s (progress fetch + player start) | **yes** ("continue my book") |
| `podcast_play` | `show`, `episode?: "latest" \| "next" \| "oldest-unplayed" \| title \| number`, `where?` | episode, duration, start position | W | changes | 0.5–2 s | yes for subscribed shows |
| `book_play` | `title` or `author`, `where?` | book, chapter, position | W | changes | 0.5–2 s | no |
| `listen_seek` | `by?: ±seconds`, `to?: time \| "chapter-start"`, `chapter?: "next" \| "previous" \| number` | new position, chapter title | W | changes | 100–500 ms | **yes** |
| `listen_speed` | `rate?: 0.5–3`, `change?: "faster" \| "slower" \| "normal"`, `remember?: "show" \| "book"` | new rate | W | changes | < 200 ms (route 3); provider-dependent | **yes** |
| `listen_sleep` | `after?: duration`, `at?: "chapter-end" \| "episode-end"`, `cancel?` | when it stops | W | changes | < 50 ms (Scheduler) | **yes** |
| `listen_status` | `where?` | title, chapter, position, remaining, speed, who | R | safe | < 100 ms | yes |
| `podcast_search` | `query`, `max?` ≤ 5 | shows: title, author, episodes, feed id, cover | R | safe | 0.3–1 s | no |
| `podcast_subscribe` / `_unsubscribe` | `show` or `feedUrl`, `scope?: me \| household` | the subscription | W | changes data | 0.5–2 s | yes ("unsubscribe from X") |
| `podcast_new` | `show?` | unplayed new episodes since last check | R | safe | < 50 ms (cache) | yes |
| `episode_about` | `ref?: "current" \| "last" \| episode id`, `question?` | show notes (cleaned), transcript excerpt, chapters | R | safe | 50 ms cached; 0.5–2 s transcript fetch | no |
| `listen_bookmark` | `note?` | bookmark at the current position (ABS bookmark when connected) | W | changes data | < 300 ms | yes ("bookmark this") |
| `listen_mark` | `ref`, `played: boolean` | ok | W | changes data | < 300 ms | yes ("mark it as played") |

Transport (pause, resume, stop, volume) is music's `music_control` and `music_volume`. They act on whatever plays,
so they are not repeated here. Read tools are `speculative: true`. Nothing is costly.

## 5. Integrate or build

### 5.1 Audiobookshelf (ABS): the main provider

ABS's own documentation is unmaintained, so every path below must be checked against a running server before
building. The playback endpoints are on the docs page today. The progress endpoints are named in its table of
contents, and their paths are **[from memory]**.

| Need | Call |
|---|---|
| Auth | `Authorization: Bearer <token>`. On ABS ≥ 2.26 an API key from the web UI, as MA's notes say |
| Search | `GET /api/libraries/{id}/search?q=&limit=` ([docs](https://api.audiobookshelf.org/)) |
| Start a session | `POST /api/items/{id}/play` or `/play/{episodeId}` with `deviceInfo {deviceId, clientName}`, `supportedMimeTypes`, `forceDirectPlay`, `mediaPlayer` (same page); returns the audio tracks, chapters and current time |
| Report progress | `POST /api/session/{id}/sync {currentTime, timeListened, duration}` every 15–30 s; `POST /api/session/{id}/close` at stop **[from memory]** |
| Read and write position | `GET /api/me/progress/{itemId}[/{episodeId}]`, `PATCH /api/me/progress/{itemId}` with `currentTime`, `isFinished` **[from memory]** |
| "Continue" | `GET /api/me/items-in-progress` **[from memory]** |
| Chapters | `media.chapters[] = { id, start, end, title }` (docs) |
| Bookmarks | `POST /api/me/item/{id}/bookmark {time, title}` **[from memory]** |
| Podcasts | ABS downloads episodes itself and has "check for new episodes" (named in the docs) |

**Per person.** Every household member gets their own ABS user, mapped to a Person through a
[Connection](../module-investigation/module-definition-config-and-dependencies.md) per person. A guest on a shared
device has no ABS account and gets "I can only continue books for someone I know."

### 5.2 Who plays, and who keeps the position

| Route (music §5.1) | How | Position source of truth |
|---|---|---|
| **1. Music Assistant** with its ABS provider | `music_assistant.play_media` of the ABS item on the room's player | ABS, synced by MA both ways. Seek, speed and chapter jumps go through MA; speed control in MA is **[unverified]** |
| **3. The page plays a URL** | Our server proxies the ABS track URL (`/media/stream/<id>`, music §5.1). The page's `<audio>` sets `playbackRate` with `preservesPitch` (standard in browsers) and reports the position | Our module, written to ABS with `session/sync` |
| **4. A player on a voice node** | `mpv --speed=` with its JSON IPC `seek` and `time-pos` **[from memory]** | Our module, as route 3 |
| Plain podcast feeds without ABS | Any route, with the enclosure URL | Our `progress` collection; pushed to gPodder sync |

**Recommendation.** If the household runs ABS and MA, route 1 is the first version: MA does the hard part. Route 3
gives exact speed and sleep-at-chapter-end on browser devices. Our module keeps a **position mirror** in any case, so
"how far am I?" and the briefing's "you're 70 % through" work without asking a player.

**Moving between rooms.** "Continue in the bedroom" or a plain "continue" on another device does four things. It
stops the old player (reading its final position first). It writes that position to ABS. It starts the new player
2 s earlier than the stop point, a small rewind that listeners expect. Then it closes the old session. Two players
never play the same book for the same person.

### 5.3 Podcast search and subscriptions

| Source | Facts | Use |
|---|---|---|
| [Podcast Index](https://github.com/Podcastindex-org/example-code) | Free key and secret. Every request needs `User-Agent`, `X-Auth-Key`, `X-Auth-Date` (Unix seconds, accepted within a few minutes) and `Authorization: sha1(key + secret + date)` in hex. `GET /api/1.0/search/byterm?q=`. `episodes/byfeedid`, `podcasts/byfeedurl` and the `transcripts`/`chaptersUrl` fields of episodes are **[from memory]** | Primary search; open index; Podcasting 2.0 data |
| [iTunes Search API](https://performance-partners.apple.com/search-api) | Keyless, `https://itunes.apple.com/search?media=podcast&term=`; about 20 calls a minute per Apple, enforced with 403s ([forum](https://developer.apple.com/forums/thread/66399)) | Fallback search, good for well-known shows; returns `feedUrl` |
| The feed itself | Parsed with `feedsmith`, which reads the iTunes and `podcast:` namespaces (news-and-feeds §5.1) | Episodes, enclosures, chapters, transcripts |
| ABS | Has its own podcast search and auto-download | When ABS is the provider, subscribe there |

**Where subscriptions live.** With ABS, they are ABS podcast library items. Without ABS, they are our `subscriptions`
collection (person scope), exported over the gPodder protocol.

### 5.4 Sync with the phone (gPodder protocol)

AntennaPod (and gPodder, Kasts **[unverified]**) sync subscriptions and **episode actions** (`play` with `started`,
`position`, `total`, plus `download`, `delete`, `new`) over the gpodder.net API v2 **[from memory: action fields]**.
They can also use the Nextcloud gPodder Sync app (`GET /index.php/apps/gpoddersync/episode_action?since=`,
`/subscriptions?since=`, matching episodes by `guid`, else by URL
([README](https://git.crystalyx.net/Xefir/nextcloud-gpodder/src/tag/3.8.0/README.md))). The self-hosted
[opodsync](https://github.com/kd2org/opodsync) speaks both protocols. Its README warns that media URLs may differ
between the app and the RSS feed, which is why the match is by guid first.

Options: (a) the module is a **client** of the household's opodsync or Nextcloud app, or (b) the module **is** a
gPodder-compatible server. **Recommendation: (a).** It is less code and another service already owns the record. (b)
needs HTTP routes for modules, which are absent today ([current-system gap 21](../module-investigation/current-system.md#9-gaps-a-module-ecosystem-would-need)).

### 5.5 "What was that episode about?"

1. **Show notes** from the feed (`content:encoded` or `description`), cleaned. They are always available and often
   enough.
2. **`podcast:chapters`** JSON (titles with timestamps) answers "which part was about X?" and enables chapter
   skipping.
3. **`podcast:transcript`** (SRT, VTT or JSON). Apple reads the tag since iOS 17.4. About 4.8 % of episodes in the
   Podcasting 2.0 index carry one ([secondary figure](https://voxbooster.com/blog/podcast-transcript-chapter-marker-adoption-statistics-2026/),
   **[unverified]**). Fetch it, cut it to the part around the current position or to 6,000 characters, and let the
   model answer.
4. **Our own transcript** (later, opt-in): run the episode through a local batch recogniser. The current recognisers
   are streaming sherpa-onnx models tuned for commands. A batch Whisper-class model for an hour of speech is a new
   dependency and costs minutes of CPU per episode **[estimate, to measure]**. Run it as a `task` job overnight, only
   for subscribed shows the person marked.

## 6. Data

| Collection | Scope | Rough schema | Readable by others |
|---|---|---|---|
| `subscriptions` | person (household optional) | `{ feedUrl, piId?, absItemId?, title, aliases[], speed?, autoNew: boolean }` | briefing ("new episodes") |
| `episodes` | household cache | `{ guid, feedUrl, title, published, duration, enclosure, chaptersUrl?, transcriptUrl?, notes }`, 60 days | — |
| `progress` | person | `{ itemKey (abs:<id> \| guid), positionS, durationS, finished, updatedAt, deviceId, synced: { abs?, gpodder? } }` | briefing, music (`listen_status`) |
| `sessions` | device | `{ itemKey, person, provider, providerSessionId?, playerId, startedAt, speed }` | music (who is playing here) |
| `bookmarks` | person | `{ itemKey, positionS, note, at }` (mirror of ABS) | — |
| `prefs` | person | `{ defaultSpeed, skipBackS: 30, skipForwardS: 30, rewindOnResumeS: 2 }` | — |

## 7. Long-running work and events

- **Progress sync** (in-session fiber, every 20 s while playing; at pause, stop, sleep and room move). On a restart,
  route 1 players keep playing and the module re-reads their position. Route 3 pages report their position again in
  `hello` (music §7).
- **New-episode check** (Scheduler `recurring`, every 2 h per feed; with ABS, ABS does it).
- **gPodder sync** (`recurring`, every 15 min, plus a push after each session).
- **Sleep timer**: a Scheduler `deferred` job. For "at chapter end", the due time is recomputed when speed or position
  changes. It ends with a 10 s fade (music's `music_sleep`).
- **Events emitted:** `listen.started`, `listen.progress` (at most every 30 s), `listen.finished`, `podcast.new`.
  **Consumed:** `music.playback.changed` (a player stopped by someone else), `notification.ringing` (pause, not duck,
  for spoken word).

## 8. Presentation

- **Now listening** is music's `media` kind, with chapter title and chapter progress as extra facts, and actions back
  30, forward 30, speed and sleep. The cover comes through `/media/<hash>`. The Orbit layout keeps the character
  beside the cover. In the Ambient layout the cover is large and the character dozes.
- **Search results**: a `gallery` of covers with `pick`. **Chapters**: a `list` with tap-to-jump. **"What was it
  about"**: a `card` with the summary and the chapter list.
- **Without a screen**: one sentence per action ("Chapter 14, *The Beetles*."). Positions are spoken as time left
  ("about 40 minutes left in this chapter"), never as raw timestamps.

## 9. Notifications and proactive behaviour

- `low` (inbox) by default: "New episode of The Rest Is History." Spoken only if the person turned on "tell me about
  new episodes" for that show, and only on their private device.
- No announcements in the middle of a book. Timers and announcements pause spoken word (they do not duck it) and
  resume 2 s back.
- Briefing may list "new episodes" as a `filler` section.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | providers (ABS, plain feeds), MA for playback | ABS via MA if both are present |
| Module | ABS URL; Podcast Index key and secret (vault); gPodder server URL; new-episode check interval; episode cache days; local transcription on/off | —; —; —; 2 h; 60; off |
| Assistant | on/off; `offTools` | inherit |
| Device | where "here" plays (music's setting); pause or duck spoken word for announcements | music's; pause |
| Person | ABS Connection (own user and key); gPodder account; default speed; skip lengths; new-episode alerts per show | —; —; 1.0; 30 s; off |

**First run:** connect ABS (URL, then each person's API key, with **Test** showing "Ian: 3 books in progress"),
optionally add a Podcast Index key, optionally connect opodsync or Nextcloud gPodder Sync, and confirm the rooms →
players map from music.

## 11. Native tools and dependencies

| Need | Where | When missing, the assistant says |
|---|---|---|
| Audiobookshelf | LAN | "Audiobookshelf isn't answering, so I can't play books right now." |
| Music Assistant (route 1) | LAN | falls back to route 3 on a browser device: "I'll play it on this screen instead." |
| Podcast Index key | vault | search falls back to iTunes: no sentence needed |
| `mpv` | voice node (route 4) | "This speaker can't play podcasts yet." |
| Batch speech-to-text model (later) | server | "I only have the show notes for that one." |

## 12. Interaction with the rest of the system

- **Voice.** Show names are long and often English inside a Dutch sentence ("speel de nieuwste aflevering van The
  Rest Is History"). Fuzzy match against subscription `aliases` first, then search. Numbers: "episode six twelve" and
  "aflevering 612" both go through core `ValueParsing`.
- **Fast path.** "Continue my book", "back thirty seconds", "next chapter", "faster", "stop at the end of the
  chapter", "what am I listening to" are actions with `examples` for the Jev path, and part of music's closed-set
  control matcher until Jev is wired.
- **Media guard.** Spoken word in the room puts the route gate in "phrase required", as for music. Podcast speech
  triggers false wakes more easily than music does **[to measure with the saved-audio tool]**.
- **Interruption.** Barge-in on a reply pauses the book, and the book resumes 2 s back after the reply. The listener
  talking over the book does nothing, because of the media guard.
- **Assistants.** No template of its own. A "Bedtime" assistant on the bedroom device with "continue my book" and
  a 30-minute sleep default is a candidate routine ([routines](routines-and-automations.md)), not a module feature.
- **Other modules.** Music (playback path, transport), briefing ("new episodes"), timers and alarms (pause on ring),
  news-and-feeds (shared feed parser), reminders ("remind me to finish the episode").

## 13. Privacy and safety

- What a person listens to is personal. "Continue" on a shared device uses the resolved person, else the device's
  default person, and it never offers someone else's book by title unless the speaker is ambiguous (example 8).
- Children: per-person ABS users keep adult books out of a child's "continue". The explicit flag from the iTunes
  `itunes:explicit` tag filters podcast search for a kids' assistant.
- No purchases. Audible and other DRM stores are out of scope.
- Show notes and transcripts are untrusted text: data, never instructions.

## 14. Foundations needed

Hard: Tool context (who and where), Connection (per-person ABS keys), and music's playback routes with the room →
player map. For the full version: the Module store (progress, subscriptions), Scheduler (sleep, checks, sync), Event
bus, and Presentation (`media`, `gallery`). **Useful first version:** with ABS and MA, `listen_continue`,
`podcast_play`, `listen_seek` and `listen_sleep` as calls to MA's `play_media` and media-player services, with ABS
holding the progress. There is no store of our own, and the version is about S–M.

## 15. Open questions

1. **Run Audiobookshelf?** It is the recommended backbone for books and podcasts. Without it, podcasts only, with our
   own progress store.
2. **Phone sync:** does anyone use AntennaPod or another gPodder-sync app, and is opodsync or Nextcloud already
   running?
3. **Cross-room hand-off:** should "continue" on a new device stop the old one automatically, or ask first?
4. **Sleep at chapter end** needs exact positions. Is route 3 (a tablet or node plays the audio itself) acceptable in
   the bedroom, or must it be the room's speaker through MA?
5. **Local transcripts** of episodes overnight: worth the CPU and a new batch model, or show notes and published
   transcripts only?
6. **Disagreement with [music.md](music.md) §4 and §5.2:** music lists `podcast_play` and podcast subscriptions as its
   own build (M). This document proposes that everything with a resume position lives here, and that music keeps
   transport and the playback path. Agree, or should podcasts stay in music and audiobooks alone move here?
7. **Default speed per show** remembered automatically after "faster", or only when asked ("always play this one
   faster")?
