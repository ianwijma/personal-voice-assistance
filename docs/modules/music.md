# Music (`music`)

Plays and controls music per room through Music Assistant in Home Assistant.

- Package: `packages/module-music`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 8 (wave B)
- Research: [docs/research/modules/music.md](../research/modules/music.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Route 1 of the research only: the server touches no audio. Everything goes through the smart-home module's
`HomeAssistant` transport to the owner's Home Assistant media players, Music Assistant's among them:

- **play** an artist, an album, a song, a playlist or a radio station by its name, now, next, or added to the queue;
- **pause, resume, next, previous**, also as phrase commands (no language model);
- **volume**: a level from 0 to 100, or a step up or down;
- **what is playing**: title, artist, album and volume;
- **`Playback`**: the service the host's "stop" uses to pause what plays in the device's room.

**Per room.** A request acts on the asking device's room (its Place), unless it names a room or a player ("pause the
music in the bedroom", "play Radio 2 on the hall TV"). A name is text, resolved when the action runs, in this order
(the first that matches decides; names are compared as Members compares them, case, accents and punctuation aside, and
without a leading "the", "de" or "het"):

1. a line of the **Rooms and players** setting;
2. with **Use Home Assistant areas** on (the default): the Home Assistant area of that name or alias, and the media
   players in it. One is the room's player; of several, the one Music Assistant serves (an entity with Music
   Assistant's `mass_player_type` attribute) when exactly one is; otherwise it asks which, naming them ("Hall has more
   than one player: Hall TV and Hall Cast. Which one?"), and never picks the first;
3. a media player's own name, an alias or its entity id (so the answer to "which one?" works).

A name it does not know: "I don't know a room or player called …". An area without a player, a device without a room,
and a player in the table that Home Assistant does not expose each have their own sentence.

**State.** What a player is doing comes from the Home Assistant provider's cache, which polls Home Assistant about once a
minute (packages/module-contracts/src/homeAssistant.ts): it may be up to about a minute old, and the "what is playing"
answer says so (`asOf`). While Home Assistant does not answer (`reconnecting`) the answer is the last state it reported,
said to be possibly out of date. Before any state has arrived (`unknown`) every tool says "Home Assistant hasn't
reported its players yet". A state of `unknown` or `unavailable` is said as such, **never as "nothing is playing"**;
only `idle`, `off`, `standby` and `on` are "nothing is playing". The module keeps no player state of its own, with one
exception: the level it set itself (see Volume).

**Commands are sent whatever the cached state says** (pause, resume, next, previous), because the cache may be a minute
behind: a person who hears music and says "pause" is not told it was not playing. A player that is switched off is told
so for transport and volume ("Kitchen speaker is switched off."), and asked anyway to play (playing turns it on); an
`unavailable` player is a failure that says so.

**Play.** `media_player.play_media` with the name as `media_content_id` and the kind as `media_content_type` (`artist`,
`album`, `track`, `playlist`, `radio`), and `enqueue` `next` or `add` when asked. Music Assistant's player entities take
a name there: Home Assistant's `music_assistant` integration passes a content id with `://` on as an address, a number
as a library id, a path on its server as that file, and anything else to Music Assistant's search by name, which plays
its best match (home-assistant/core, `homeassistant/components/music_assistant/media_player.py`,
`_async_handle_play_media`, read 2026-11-19). So the answer names what was asked for and says that Music Assistant picks
the closest match ("Playing the artist Nina Simone on Kitchen speaker; Music Assistant picks the closest match to that
name."): the module cannot see what was found (below, "Missing below"). A player that is not Music Assistant's cannot
look up a name, and Home Assistant answers with an error: "Kitchen speaker couldn't play that. Only Music Assistant
players find music by name, and it may not have found Nina Simon." A query that is an address, a file path or a media
source (`://`, a leading `/`, `\`, `~` or `.`, a drive letter, `media-source:`) is never passed on ("I play music by its
name; I can't play an address or a file."): it would make Music Assistant fetch a URL or open a file a model chose.

**Volume.** `media_player.volume_set` with a level from 0 to 1. A step ("louder", "turn the music down") is the
**Volume step** setting from the player's present level, clamped to 0 to 100. The present level is the cache's
`volume_level`, except right after the module set one itself: because the cache shows a change up to a minute late,
the level the module set counts for a step while the cache still shows the level from before the change, for at most
two poll intervals (`OWN_LEVEL_MS`, 120 s). Once the cache shows any other level (this one, or someone turning the
knob) the cache is believed. A step whose call failed or timed out (it may or may not have happened) clears it. A
restart of the module clears it too. Without a present level a step is refused and nothing is sent ("I don't know
Kitchen speaker's volume right now, … Say a level, like 30 percent."); a level needs none. Volume changes go **one at a
time** (one semaphore in the shared part, the player read again inside it), so two devices saying "louder" at once give
two steps, not one.

**Failures** of a call, from the contract's reasons: `not_connected` "Home Assistant isn't answering right now, so I
couldn't reach …"; `refused`; `unknown_entity`; `invalid`; `failed`; and `timeout` "Home Assistant didn't answer in
time; … may still do it." (never that nothing happened). Each call waits at most 3 s (`CALL_TIMEOUT_MS`, the `Playback`
contract's bound), inside the action's 5 s. The smart-home module off, or stopping during the call: "The Home Assistant
module is off." Every sentence is in English and Dutch.

**Outside content.** Player names (cut to 60 characters), titles, artists and albums (cut to 100) come from Home
Assistant: line breaks, control and direction characters are flattened to a space, and what the model reads carries a
`note` that it is data, never instructions.

## Tools

Each action is also offered to the model as the generated tool `music_<id>`, except `now_playing`, which the model reads
as the `music_now_playing` tool (it marks what comes from Home Assistant). Every one takes an optional `where` (a room
or a player, as text, at most 60 characters).

| Tool / action | Parameters | Risk | Example | Answers |
|---|---|---|---|---|
| `music_play` (`music.play`) | `query` (text), `kind` (`artist`, `album`, `track`, `playlist`, `radio`), `queue` (`now`, `next`, `add`; default now), `where` | change | "play the album Kind of Blue in the kitchen", "speel de afspeellijst Zondagochtend" | "Playing the album Kind of Blue on Kitchen speaker; Music Assistant picks the closest match to that name." |
| `music_pause` (`music.pause`) | `where` | change | "pause the music" | "Paused Kitchen speaker." |
| `music_resume` (`music.resume`) | `where` | change | "resume the music in the bedroom" | "Bedroom speaker is playing again." |
| `music_next` (`music.next`) | `where` | change | "skip this song" | "Skipped to the next track on Kitchen speaker." |
| `music_previous` (`music.previous`) | `where` | change | "previous song" | "Back to the previous track on Kitchen speaker." |
| `music_volume` (`music.volume`) | `level` (0–100) or `change` (`up`, `down`), `where` | change | "set the music to 30 percent", "muziek zachter" | "Kitchen speaker is at 30 percent." |
| `music_now_playing` (tool) | `where` | read, speculative | "what's playing?" | `{ spoken, player, state, title?, artist?, album?, volumePercent?, asOf, stale, note }`: "Kitchen speaker is playing Feeling Good by Nina Simone." |
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

- `pause(room)`: resolves the room as above; pauses the player and answers `true` when its cached state is `playing` or
  `buffering`; `false` when it is anything else, and when no state has arrived yet (nothing is done). A room no player
  serves, or one with several players and none chosen, is `no_player`; a room that is empty, longer than 60 characters
  or not one line is `invalid`. A failed call is `failed`, one without an answer in 3 s `timeout` (the host's "stop"
  then says "I couldn't stop that."). With the smart-home module off the player's state is not known: `false`, nothing
  done.
- `changeVolume(room, { to } | { by })`: `to` from 0 to 1, `by` from −1 to 1 (otherwise `invalid`), clamped, through
  the same one-at-a-time path as `music_volume`; `unknown_level` for a step without a present level (nothing changed);
  answers the level set; the smart-home module off is `failed`.

What plays is household data (the contract says so): the module stores nothing personal and answers the same on every
device.

## Settings

| Key | Kind | Default | Notes |
|---|---|---|---|
| `players` | records (room, media player), at most 32 | none | "Rooms and players": a room (one line, 1–60 characters, each room once) and a `media_player.…` entity id |
| `useAreas` | boolean | on | "Use Home Assistant areas": rooms not in the table use the player in the area of the same name |
| `volumeStep` | number, 5–25 | 10 | percent per step up or down |

Nothing is overridable per assistant; there are no secrets. Health: a warning (`music.no-players`) when the table is empty
and areas are off, since no room can then have a player.

## What it stores

Nothing: no collections, no jobs, no events. It keeps in memory only the level it last set on each player (at most
120 s, see Volume), lost at a restart. Nothing personal is kept anywhere.

## What it needs

- `uses: ["home-assistant"]`: the smart-home module's `HomeAssistant` service (packages/module-contracts/src/homeAssistant.ts),
  looked up at each use. It calls only allow-listed services of the `media_player` domain on one entity id each:
  `media_pause`, `media_play`, `media_next_track`, `media_previous_track`, `volume_set` (`volume_level`) and
  `play_media` (`media_content_id`, `media_content_type`, `enqueue`).
- Home Assistant with media players exposed to the smart-home module (its "media players" kind), and Music Assistant's
  Home Assistant integration for playing by name. No `requires` of its own: the module makes no request itself.
- Provides `Playback`.

**Bounds.** A room is resolved from the provider's cache at each request, in steps of at most 200 names with a yield to
the event loop between them; only the first 200 media players (in entity id order) are compared by name.
`test/latency.test.ts`, at the largest cache the contract allows (500 areas and 5,000 entities, each with 20 aliases of
200 characters), a name that matches nothing: longest stop of the main thread 4.0 to 5.5 ms (bound 10 ms; 167 ms
without the steps), the whole answer at most 191 ms (development machine, three runs).

## What was left out

Left out because the preparation parts' first versions do not have it:

- **The `media` guard** on the devices of a room while its player plays (and "a room with a player starts guarded"):
  docs/PHRASES.md, "Not now" (no guards in P7's first version). So nothing changes about when the assistant listens.
- **The `media` presentation kind** (a now-playing card) and a `list` with `pick` for "which one": presentations are
  not on this branch's base (P10).
- **Media volume for the host's "louder" and "quieter"**: docs/PHRASES.md ("Media volume is not changed in this
  version"). `Playback.changeVolume` is there for when it is.

Left out by the plan's row and the lead's notes: playback in the browser or on nodes (routes 3 and 4), Spotify direct,
ducking, podcasts, favourites, groups, moving the queue, "play something like this", sleep timer.

Left out because something is **missing below** (the smallest change that would provide it, in the smart-home module's
allow-list, `packages/module-home-assistant/src/services.ts` on its branch, and the table in its page):

- **Naming what was found, and asking "which one?" for a name with several matches** ("Radio 2: NPO Radio 2 or BBC
  Radio 2?"): needs `music_assistant.search` with `returnResponse` (fields `name`, `media_type`, `limit`, at most 10),
  on a Music Assistant config entry rather than an entity, so the transport's "entity ids only" rule would need a
  read-only exception for it. Without it Music Assistant plays its best match, and the answer says so.
- **"The album X by Y"** (an album or track narrowed by its artist) and **radio mode** (keep playing similar music):
  need `music_assistant.play_media` on media players with `media_id`, `media_type`, `artist`, `album`, `enqueue` and
  `radio_mode`; `media_player.play_media` has no field for them (its `extra` is not on the list either).

## Contract readings

- **`Playback` has two operations** (`pause`, `changeVolume`); the plan's §5.2 also names "what plays in a room" and
  "resume". The module implements exactly the interface as it is; those are its own tools until a consumer needs them.
- **A room with several players** in `Playback`: the contract does not say; the module pauses none and answers
  `no_player` ("never pick the first").
- **`pause` with the smart-home module off** (or stopping during the call): the contract's "the provider does not know
  the player's state", so `false` and nothing done, rather than a failure the host would word as "I couldn't stop that".
- **`pause` while Home Assistant does not answer** (`reconnecting`): the cache may still say `playing`; the call then
  fails `not_connected`, which is `failed`.
- **Rooms** are compared with `nameKey` as the contract says, and also without a leading article, as for every other
  name the module takes.
