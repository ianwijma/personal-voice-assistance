# Music (`music`)

Plays and controls music per room through Music Assistant in Home Assistant.

> **To be replaced.** The owner does not use Home Assistant for music. The plan in [media.md](media.md) (2026-11-21)
> replaces this module with `media`: Spotify music and YouTube video played on the asking device itself. This page
> describes the module as it is until that plan's last step removes it. What the new module keeps from this one: the
> phrase tables for pause, resume, next and previous, the once-per-phrase-invocation record, the English and Dutch
> text pattern and the cleaning of outside text. What goes: rooms and players, every Home Assistant call, the
> room-keyed `Playback`.

- Package: `packages/module-music`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 8 (wave B)
- Research: [docs/research/modules/music.md](../research/modules/music.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Route 1 of the research only: the server touches no audio. Everything goes through the smart-home module's
`HomeAssistant` transport to the owner's Home Assistant media players, Music Assistant's among them:

- **play** an artist, an album, a song, a playlist or a radio station by its name: now (replacing the queue), next, or
  added to the queue;
- **pause, resume, next, previous**, also as phrase commands (no language model);
- **volume**: a level from 0 to 100, or one of the player's own steps up or down;
- **what is playing**: title, artist, album and volume, at the provider's last poll;
- **`Playback`**: the service the host's "stop" uses to pause what plays in the device's room.

**It says what it asked, not what happened.** A command's answer from Home Assistant says the command was taken, not
what the player did with it (a "resume" with nothing to resume succeeds and changes nothing), and the provider's cache
shows the result only at its next poll. So every acknowledgement names the command: "Asked Kitchen speaker to
resume.", "Asked Music Assistant to play its closest match for the artist Nina Simone on Kitchen speaker.", "Turned
Kitchen speaker up a step.", "Set Kitchen speaker to 30 percent."

**Per room.** A request acts on the asking device's room (its Place), unless it names a room or a player ("pause the
music in the bedroom", "play Radio 2 on the hall TV"). A name is text, resolved when the action runs, in this order
(the first that matches decides; names are compared as Members compares them, case, accents and punctuation aside, and
without a leading "the", "de" or "het"):

1. a line of the **Rooms and players** setting;
2. an exposed media player whose entity id is exactly the text (`media_player.hall_tv`), looked up directly;
3. with **Use Home Assistant areas** on (the default): the Home Assistant area of that name or alias, and the media
   players in it. One is the room's player; of several, the one Music Assistant serves (an entity with Music
   Assistant's `mass_player_type` attribute) when exactly one is; otherwise it asks which, and never picks the first;
4. every exposed media player whose name or alias is the text: one is it; several, a question counting all of them.
   The Music Assistant preference of step 3 is only among an area's players: two players of one name are asked about,
   whichever serves them.

A question names at most three players and says how many there are ("Kitchen has 101 players, among them A, B and C.
Which one?"). Every area and every player is searched (none is left out), in steps (see "Bounds"). A name it does not
know: "I don't know a room or player called …". An area without a player, a device without a room, and a player in
the table that Home Assistant does not expose each have their own sentence.

**State.** What a player was doing comes from the Home Assistant provider's cache, which polls Home Assistant about once
a minute (packages/module-contracts/src/homeAssistant.ts). Every "what is playing" answer, in every state, says so:
"At Home Assistant's last check, up to about a minute ago, Kitchen speaker was playing Feeling Good by Nina Simone."
While Home Assistant does not answer (`reconnecting`): "At Home Assistant's last check, before it stopped answering, …
That may be out of date." Before any state has arrived (`unknown`) every tool says "Home Assistant hasn't reported its
players yet". A state of `unknown` or `unavailable` is said as such, **never as "nothing is playing"**; only `idle`,
`off`, `standby` and `on` are "nothing was playing". The contract gives no time of the last poll, so the age is "up to
about a minute", not a number of seconds (missing below).

**The cache never vetoes a command.** Transport, volume and play are sent whatever the cache says (off, unavailable,
idle, playing), because it may be a minute old: a player last seen off may have been switched on since. Home
Assistant's own answer is what is reported ("Kitchen speaker couldn't do that."). Only `Playback.pause` reads the
cache, as its contract says (below).

**Play.** `media_player.play_media` with the name as `media_content_id`, the kind as `media_content_type` (`artist`,
`album`, `track`, `playlist`, `radio`) and an explicit `enqueue`: `replace` for "play" (so it plays at once, whatever
Music Assistant's default for that kind is), `next`, or `add`. For a song or an album, an optional **artist** is sent in
the form Music Assistant's name search documents, `"Artist - Title"` ("Miles Davis - Kind of Blue"), bounded at 200
characters as a whole. Music Assistant's player entities take a name there: Home Assistant's `music_assistant`
integration reads one content id several ways: a content id with `://` as an address, a number as a library id, a path
its host can open as that file, and anything else as a name for Music Assistant's search, which plays its best match
(home-assistant/core, `homeassistant/components/music_assistant/media_player.py`, `_async_handle_play_media`, read
2026-11-19). So:

- The answer says what was asked for and that Music Assistant picks the closest match: the call returns nothing about
  what was found.
- **Refused, with a sentence**, before anything is sent:
  - a text with `://` or a backslash anywhere, or starting with `/`, `.` or `~` or a drive prefix (`C:`): "I play
    music by its name; I can't play an address or a file.";
  - a text ending like a file name (a dot and 2 to 5 letters or digits: `.mp3`, `.m3u8`; also a real name such as
    "will.i.am" or "Love.exe"): "This connection can't safely look up a name of that form, so I can't play it.";
  - a title that is only digits: "Which artist is 1989 by?" for a song or an album (with the artist, "Taylor Swift -
    1989" is sent), and "I can't look up a name that is only a number." for the other kinds.

  The artist and the combined "Artist - Title" are checked against the first two rules (address and name form) and the
  200-character bound; an artist of digits only is not refused, because the combined text is not only digits ("311 -
  Amber"). A slash inside a name (AC/DC) is allowed.
- **What this does not prove**: that no text can reach the integration's file branch. A relative path without an
  extension that Home Assistant's host can read ("music/song") is not excluded. Only a name-only lookup would exclude
  it (missing below).
- A player that is not Music Assistant's cannot look up a name, and Home Assistant answers with an error: "Kitchen
  speaker couldn't play that. Only Music Assistant players find music by name, and it may have found nothing for the
  artist Nina Simon."

**Volume.** A level sends `media_player.volume_set` with exactly that level (30 → 0.3) and says the level that was
sent. "Up" and "down" (tool, action) send `media_player.volume_up` / `volume_down`: one of the player's own steps per
request, whatever the cache says, and no level is read or said. Nothing about volume is kept between calls, and no
request waits for another: each call has its own time limit.

**Failures** of a call, from the contract's reasons: `not_connected` "Home Assistant isn't answering right now, so I
couldn't reach …"; `refused`; `unknown_entity`; `invalid`; `failed`; and `timeout` "Home Assistant didn't answer in
time; … may still do it." (never that nothing happened). The provider stopping during a call: "The Home Assistant
module stopped during the request; … may still do it." Each call waits at most 3 s (`CALL_TIMEOUT_MS`, the `Playback`
contract's bound), inside the action's 5 s. The smart-home module off: "The Home Assistant module is off." Every
sentence is in English and Dutch.

**A phrase invocation acts once.** A play, transport or volume request that came in as a phrase command runs through
one bounded record in the module's shared part, keyed by the phrase turn's identity (assistant, conversation, turn id,
device) with the operation and its input: a repeat of the same invocation, at once or later, sends nothing and gets the
first outcome (a failure too). A run cut short (interrupted, a defect) before its call to Home Assistant went out keeps
nothing, so its replay runs; cut short after the call went out, it may have happened, so the record stays and a replay
sends nothing and says "I may already have done that. If not, say it again." A new utterance is a new identity and
acts. The last 256 are kept. **A call made by the model is never held back or answered from the record**: the gateway
gives a tool or an action no per-call id, and a turn plus an input is not an invocation, so "skip two songs" as two
`music_next` calls skips twice, and two "up" calls step twice (missing below).

**Outside content.** Player names (cut to 60 characters), titles, artists and albums (cut to 100) come from Home
Assistant: line breaks, control and direction characters are flattened to a space, and what the model reads carries a
`note` that it is data, never instructions.

## Tools

Each action is also offered to the model as the generated tool `music_<id>`, except `now_playing`, which the model reads
as the `music_now_playing` tool (it marks what comes from Home Assistant). Every one takes an optional `where` (a room,
a player's name or its entity id, as text, at most 60 characters).

| Tool / action | Parameters | Risk | Example | Answers |
|---|---|---|---|---|
| `music_play` (`music.play`) | `query` (text), `kind` (`artist`, `album`, `track`, `playlist`, `radio`), `artist` (text, for a song or an album), `queue` (`now`, `next`, `add`; default now), `where` | change | "play the album Kind of Blue by Miles Davis in the kitchen", "speel de afspeellijst Zondagochtend" | "Asked Music Assistant to play its closest match for the album Kind of Blue by Miles Davis on Kitchen speaker." |
| `music_pause` (`music.pause`) | `where` | change | "pause the music" | "Asked Kitchen speaker to pause." |
| `music_resume` (`music.resume`) | `where` | change | "resume the music in the bedroom" | "Asked Bedroom speaker to resume." |
| `music_next` (`music.next`) | `where` | change | "skip this song" | "Asked Kitchen speaker to skip to the next track." |
| `music_previous` (`music.previous`) | `where` | change | "previous song" | "Asked Kitchen speaker to go back to the previous track." |
| `music_volume` (`music.volume`) | `level` (0–100) or `change` (`up`, `down`), `where` | change | "set the music to 30 percent", "muziek zachter" | "Set Kitchen speaker to 30 percent." / "Turned Kitchen speaker down a step." |
| `music_now_playing` (tool) | `where` | read, speculative | "what's playing?" | `{ spoken, player, state, title?, artist?, album?, volumePercent?, asOf, stale, note }`: "At Home Assistant's last check, up to about a minute ago, Kitchen speaker was playing Feeling Good by Nina Simone." |
| `music.now_playing` (action, not a tool) | `where` | read, speculative | "wat speelt er" | the same sentence, as `{ say }` |

**Phrase commands** (transport only; `{where}` is text, resolved in the action):

| Action | English | Dutch |
|---|---|---|
| pause | pause; pause the music; pause music; pause the radio; pause the music in (the) {where} | pauze; pauzeer; pauzeer de muziek; muziek pauzeren; zet de muziek op pauze; pauzeer de muziek in (de) {where} |
| resume | resume; resume the music; resume music; continue the music; unpause; unpause the music; resume the music in (the) {where} | hervat; hervat de muziek; muziek hervatten; ga verder met de muziek; speel verder; speel de muziek verder; hervat de muziek in (de) {where} |
| next | next; next song; next track; skip; skip this song; skip this track; next song in (the) {where} | volgende; volgend nummer; volgende nummer; sla over; sla dit nummer over; volgend liedje; volgend nummer in (de) {where} |
| previous | previous; previous song; previous track; go back a song; back a song; previous song in (the) {where} | vorige; vorig nummer; vorige nummer; een nummer terug; vorig liedje; vorig nummer in (de) {where} |

"Stop" is the host's: it pauses media the `Playback` service says is playing in the device's room (after a ring, an
announcement and a reply). "Louder" and "quieter" are the host's too and change the reply volume only in this version
(docs/PHRASES.md); the music volume is `music_volume` ("turn the music up").

**`Playback`** (provided; packages/core/src/Playback.ts), exactly its two operations:

- **One deadline**: each operation has `PLAYBACK_LIMITS.callTimeoutMs` (3 s) from entry. Resolving the room spends from
  it (measured in real time), and the call to Home Assistant gets only what is left; when resolving used it all up the
  answer is `timeout` with nothing sent. After the call went out, running out of time is `timeout` too (it may still
  have happened).
- `pause(room)`: resolves the room as above; pauses the player and answers `true` when its cached state is `playing` or
  `buffering`; `false` when it is anything else, and when no state has arrived yet or the smart-home module is off
  before anything is sent (nothing is done). Once the pause was sent, a failure is never `false`: a failed call or the
  provider stopping during it is `failed`, no answer in 3 s `timeout` (the host's "stop" then says "I couldn't stop
  that."). A room no player serves, or one with several players and none chosen, is `no_player`; a room that is empty,
  longer than 60 characters or not one line is `invalid`.
- `changeVolume(room, { to })`: `volume_set` with exactly `to` (0 to 1, otherwise `invalid`), answering it.
  `changeVolume(room, { by })`: always `unknown_level` (from −1 to 1, otherwise `invalid`), nothing sent (see "What
  was left out").

What plays is household data (the contract says so): the module stores nothing personal and answers the same on every
device.

## Settings

| Key | Kind | Default | Notes |
|---|---|---|---|
| `players` | records (room, media player), at most 32 | none | "Rooms and players": a room (one line, 1–60 characters, each room once) and a `media_player.…` entity id |
| `useAreas` | boolean | on | "Use Home Assistant areas": rooms not in the table use the player in the area of the same name |

Nothing is overridable per assistant; there are no secrets. Health: a warning (`music.no-players`) when the table is empty
and areas are off, since no room can then have a player.

## What it stores

Nothing: no collections, no jobs, no events, no player state, no volume. In memory only: the outcome of the last 256 phrase
invocations (above), and the compared form of each area's and player's names, per object of the provider's cache (a
poll that brings a new object is compared afresh). Nothing personal is kept anywhere.

## What it needs

- `uses: ["home-assistant"]`: the smart-home module's `HomeAssistant` service (packages/module-contracts/src/homeAssistant.ts),
  looked up at each use. It calls only allow-listed services of the `media_player` domain on one entity id each:
  `media_pause`, `media_play`, `media_next_track`, `media_previous_track`, `volume_set` (`volume_level`),
  `volume_up`, `volume_down`, and `play_media` (`media_content_id`, `media_content_type`, `enqueue`).
- Home Assistant with media players exposed to the smart-home module (its "media players" kind), and Music Assistant's
  Home Assistant integration for playing by name. No `requires` of its own: the module makes no request itself.
- Provides `Playback`.

**Bounds.** A room is resolved from the provider's cache at each request. Every area and every media player is compared,
in steps of at most 100 names with a yield to the event loop between them. `test/latency.test.ts`, at the largest cache
the contract allows (500 areas and 5,000 media players, each with 20 aliases of 200 characters), each run on a cache of
new objects (nothing remembered helps), for a name that matches nothing, the last player by name, and a name all
5,000 carry: longest stop of the main thread 3.5 to 6.0 ms (bound 10 ms), the whole answer 1.3 to 1.4 s (development
machine, three runs each). That is the contract's limit, not a household: with a few dozen players it is milliseconds.
At that limit a `Playback` operation that must search everything spends 1.3 to 1.4 s of its 3 s budget resolving, and
the call to Home Assistant gets only the rest (about 1.6 s); a provider slower than that is `timeout` (test:
latency.test.ts, "Playback has one 3 s budget from entry").

## What was left out

Left out because the preparation parts' first versions do not have it:

- **The `media` guard** on the devices of a room while its player plays (and "a room with a player starts guarded"):
  docs/PHRASES.md, "Not now" (no guards in P7's first version). So nothing changes about when the assistant listens.
- **The `media` presentation kind** (a now-playing card) and a `list` with `pick` for "which one": presentations are
  not on this branch's base (P10).
- **Media volume for the host's "louder" and "quieter"**: docs/PHRASES.md ("Media volume is not changed in this
  version").

Left out by the plan's row and the lead's notes: playback in the browser or on nodes (routes 3 and 4), Spotify direct,
ducking, podcasts, favourites, groups, moving the queue, "play something like this", sleep timer.

Left out because something is **missing below** (the smallest change that would provide it):

- **A name-only lookup, naming what was found, and asking between matches** ("Radio 2: NPO Radio 2 or BBC Radio 2?"):
  `music_assistant.search` with `returnResponse` (`name`, `media_type`, `limit` at most 10) on the smart-home module's
  allow-list (`packages/module-home-assistant/src/services.ts` and its page), with a read-only exception to "entity ids
  only" for its config entry, then playing the returned item by its URI. Until then Music Assistant plays its best match
  for the name, the answer says so, and a text that happens to be a path Home Assistant's host can read is not provably
  excluded (see Play).
- **Radio mode** (keep playing similar music): `music_assistant.play_media` with `radio_mode` on the allow-list.
  `media_player.play_media` has no field for it.
- **`Playback.changeVolume(room, { by })`**: a step needs the player's present level, and a polled cache never
  establishes it, so it is always `unknown_level` (the contract allows that). A fresh read of one entity in the
  `HomeAssistant` contract (`refresh(entityId)`, one state read within its time limit) would lift it. No consumer uses
  `by` yet; the host's "louder" changes the reply volume.
- **A per-call identity for tool and action handlers**: the model's tool-call id (`ToolCall.id`) is dropped before the
  gateway (`ToolRegistry`), and an action's `run` gets only its parameters. Handed to the handler and kept across a
  genuine replay, it would let a model call be held to once like a phrase. Until then model calls always run.
- **The age of a reading in seconds**: the `HomeAssistant` contract has no time of the last poll. A `lastPolledAt()`
  (or a per-entity read time) would let "what is playing" say "20 seconds ago" instead of "up to about a minute ago".

## Contract readings

- **`Playback` has two operations** (`pause`, `changeVolume`); the plan's §5.2 also names "what plays in a room" and
  "resume". The module implements exactly the interface as it is; those are its own tools until a consumer needs them.
- **A room with several players** in `Playback`: the contract does not say; the module pauses none and answers
  `no_player` ("never pick the first").
- **`pause` with the smart-home module off before anything is sent**: the contract's "the provider does not know the
  player's state", so `false` and nothing done. Once the pause was sent, the provider stopping is `failed`.
- **`pause` while Home Assistant does not answer** (`reconnecting`): the cache may still say `playing`; the call then
  fails `not_connected`, which is `failed`.
- **Rooms** are compared with `nameKey` as the contract says, and also without a leading article, as for every other
  name the module takes.
