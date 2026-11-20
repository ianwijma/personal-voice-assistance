# Tabletop and games: the assistant at the table

Research write-up, 2026-11-18. Not an approved design. It uses the foundation names in [README.md](README.md) and
builds on [current-system.md](../module-investigation/current-system.md). Outside facts were checked on 2026-11-18 where
a link is given; anything else is marked **[unverified]**. Latency figures are estimates to be measured with
`TurnTrace`.

## 1. Summary

The assistant as a helper and host when people play together in the house:

- **score keeping** for any game, by voice, with undo and a visible scoreboard;
- **turn timers and chess-style clocks** (increment, delay), tapped on a screen;
- **dice and random draws with the roll shown**, in standard dice notation;
- **rules lookup** grounded in the rulebook the household owns or in openly licensed rules, with a citation;
- a **game-master assistant** for role-playing games with persistent campaign notes, NPCs and session recaps;
- **multi-player voice games across rooms** (a quiz with players on several devices) and **party games** with the
  character on screen as the host.

Boundary with [fun-and-ambient](fun-and-ambient.md): trivia, riddles, twenty questions and guess-the-number stay
there (one player or a casual group, no session, no players). This module starts where there is a **game session
with named players**: scores, clocks, rounds, campaigns. It uses `random` from [core-tools](core-tools.md) for its
fairness and [timers-and-alarms](timers-and-alarms.md) only for plain countdowns.

- **Priority: later**, except score keeping and dice (S, useful on game night without any foundation beyond a store).
- **Effort: M** for scores, clocks, dice and rules lookup over uploaded rulebooks; **L** with the game master and
  multi-room games (cross-device sessions, latency fairness, per-character voices).

## 2. What others do

| Product | Behaviour | Copy | Avoid |
|---|---|---|---|
| Alexa skills ("Score Keeper", "Chess Clock", dice) **[unverified: still listed]** | Single-purpose skills, one per need | The plain commands ("add five points to Ian") | A skill store; forgetting scores between invocations |
| Google Assistant | "Roll a die", "flip a coin", timers; third-party games removed in 2023 ([landscape](../module-investigation/landscape-voice-assistants.md) §2) | Built-ins, not skills | — |
| Board game companion apps (Mansions of Madness, Descent: app-driven games) **[unverified]** | The app runs the game master role | A screen as narrator and board state | — |
| Dice apps, Roll20, Foundry VTT | Dice notation, roll logs, initiative trackers, campaign journals | Notation (`4d6kh3`), a visible log, journals | Building a virtual tabletop |
| AI game masters (AI Dungeon, "Friends & Fables") **[unverified]** | LLM narration with memory | Campaign memory and recaps | A narrator that forgets rules and NPCs, or invents dice results |
| Chess clock apps (Chess Clock by Lichess, DGT hardware) | Fischer increment, Bronstein delay, big tap targets | Tap to switch; voice only to start, pause and query | Voice as the switch in blitz |

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | "Hey Jev, start Ticket to Ride: Ian, Anna, Sam." → "Game on. Scores at zero." Later: "Ian twelve points." → "Ian twelve." "Anna, minus four for tickets." → "Anna minus four: she's on 31." "Who's winning?" → "Sam, 58, then Ian 52." | optional: scoreboard |
| 2 | "Undo that." → "Took back Anna's minus four. She's on 35." | no |
| 3 | "Chess clock, five minutes each, three second increment, Ian is white." → a two-panel clock on the tablet; players tap their half; "Pause the clock" by voice; "Ian, ten seconds" spoken at low time. | yes |
| 4 | "Roll 4d6, drop the lowest, for strength." → dice tumble on screen, "Six, five, four and a two, dropped. Fifteen." Log line: "Ian, strength, 4d6kh3 = 15". | optional |
| 5 | "In Catan, can I build a road through someone else's settlement?" → `rules_lookup` over the owner's uploaded rulebook → "No: a road can't continue past an opponent's settlement. That's on page 9 of your rulebook." | optional: the paragraph |
| 6 | RPG night, Game Master assistant: "Recap last session." → "Last time the party reached Saltmarsh, met the smuggler Gellan, and Sam's ranger owes him a favour…" | no |
| 7 | GM: "What does the innkeeper say?" → the innkeeper's line, in the innkeeper's voice (needs the voice map, §12). "Note: the innkeeper's name is Mira and she hates the guard." → saved as an NPC note. | no |
| 8 | Across rooms: "Start a family quiz with the kitchen and the study." → both screens show the question; first tap wins; "Study got it first: Anna, one point." | yes |
| 9 | Ambiguous: "Add three." → to whom? → "Three for who?" (the current player if turns are tracked: "Three for Sam, whose turn it is?") | no |
| 10 | Failure: "Look up the rule for trading in Brass." with no rulebook uploaded → "I don't have the Brass rulebook. I can answer from memory, but I might be wrong. Or upload the PDF in Settings." | no |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `game_start` | `game`, `players: string[]`, `scoring?: "points" \| "rounds" \| "lowest-wins"`, `turns?: boolean` | the session (id, players, order) | W | changes data | < 30 ms | yes |
| `score` | `op: "add" \| "set" \| "show" \| "undo" \| "end"`, `player?`, `points?`, `note?` | totals, ranking, last change | W/R | changes data | < 20 ms | **yes** |
| `turn` | `op: "next" \| "who" \| "skip" \| "reverse"` | current player, round | W/R | safe | < 20 ms | yes |
| `clock` | `op: "start" \| "pause" \| "resume" \| "status" \| "stop"`, `kind?: "chess" \| "turn" \| "round"`, `base?`, `increment?`, `delay?`, `players?` | clock state; switching happens on tap | W | safe | < 50 ms (tap path is client-side) | yes |
| `roll` | `notation` (`2d6+3`, `4d6kh3`, `d20 adv`, `d%`), `purpose?`, `player?`, `secret?: boolean` | each die, kept/dropped, total, the log line | W (log) | safe | < 5 ms | **yes** |
| `draw` | `from: "deck" \| "list"`, `name?`, `count?` | drawn items (a card deck, names from a hat) | W | safe | < 5 ms | yes |
| `rules_lookup` | `game`, `question` | best passages with page, source and licence | R | safe | FTS 30 ms + model answer 1–2 s | no |
| `campaign_note` | `campaign?`, `kind: "npc" \| "place" \| "quest" \| "item" \| "session"`, `text`, `name?` | `{ id }` | W | changes data | < 20 ms | no |
| `campaign_recall` | `campaign?`, `query?`, `kind?` | matching notes; the last session's recap | R | safe | < 30 ms | no |
| `party_start` | `game: "werewolf" \| "word-chain" \| "charades" \| "wavelength-style" \| "quiz"`, `players`, `devices?` | the first prompt; secret roles go to private devices | W | safe | < 100 ms | no |

All randomness uses `node:crypto` `randomInt`, as [core-tools §5.4](core-tools.md#54-random) requires. The model
never invents a roll: it must call `roll`, and the instructions say so.

## 5. Integrate or build

### 5.1 Scores, turns, clocks, dice: build

- Small and specific: a session row with players and an append-only score ledger (so "undo" is the last delta).
- Dice notation: [`@dice-roller/rpg-dice-roller`](https://dice-roller.github.io/documentation/) supports keep/drop,
  exploding and modifiers **[unverified: licence, maintenance]**; a 150-line own parser for `NdS(kh|kl)N±M` is an
  alternative, using our crypto source either way.
- Clocks: the server holds the authoritative times; the screen device handles taps locally and reports them
  (`clock.tap` with the device's timestamp), so a 200–400 ms voice path never decides a blitz game. Fischer
  increment and Bronstein delay are a few lines each. A plain "two minutes per turn" timer can reuse the
  [timers](timers-and-alarms.md) ringing.

### 5.2 Rules lookup: sources and licences

| Source | What it is | Licence and access |
|---|---|---|
| The household's own rulebook PDFs, uploaded in admin | The real rules of the games on the shelf | Publisher's copyright; a private copy for private use; never shared or sent anywhere except as excerpts in the model prompt **[legal position unverified]** |
| Publishers' free rulebook downloads | Most publishers post PDFs | The owner downloads them; same as above |
| D&D [SRD 5.1 and 5.2](https://www.dndbeyond.com/posts/1949-you-can-now-publish-your-own-creations-using-the) | Core 5e rules | CC-BY-4.0, irrevocable; may be bundled with attribution |
| Pathfinder 2e via the ORC licence / Archives of Nethys | Rules reference | **[unverified: licence of the text and site terms]** |
| [BoardGameGeek XML API2](https://boardgamegeek.com/wiki/page/BGG_XML_API) | Metadata (players, play time, weight), not rules text; user-uploaded files have their own rights | Application token required since autumn 2025 ([client README](https://cdn.jsdelivr.net/npm/bgg-ts-client@0.3.0/README.md)); non-commercial terms |
| FIDE Laws of Chess, standard card-game rules (Pagat) | Rules of classic games | FIDE text freely published; Pagat's terms **[unverified]** |
| The model's own knowledge | Broad, often wrong in detail | Only as a labelled fallback ("from memory, might be wrong") |

Recommendation: a rules library per game: PDFs uploaded in admin, text extracted with pdfjs, split into passages with
page numbers, searched with FTS5 (as [memory-and-notes §5](memory-and-notes.md#5-integrate-or-build) does); SRD 5.2
bundled. BGG only for "how long does Brass take" and player counts, with the owner's token.

### 5.3 Game master

An assistant template, not code: a narrator persona, the `campaign_*` tools, `roll`, `rules_lookup` over the system's
SRD, and per-turn context with the current scene and the party (pinned like memory's pinned facts, capped). After a
session, "end session" writes a recap note from the conversation, so the next session starts from it; conversations
themselves are not kept (current-system §4.3). Combat bookkeeping (initiative order, hit points) uses `turn` and
`score` with a "tracker" view.

### 5.4 Multi-room games

Each device has its own voice session ([VOICE-SESSIONS](../../VOICE-SESSIONS.md)); a game spanning devices is a
household-scoped session that several devices join. Questions go out with `Announce`
([Notification service](../module-investigation/shared-state-jobs-and-notifications.md)); answers come from each
device. Fairness for "first to answer": spoken answers differ in recognition time per device, so buzzers are screen
taps timestamped on the device with a clock offset measured at join **[proposal]**; voice-only nodes get "everyone
answers, then we reveal" rounds instead of races.

## 6. Data

| Collection | Scope | Schema |
|---|---|---|
| `games` | household | `{ game, players[], order, turn, round, startedAt, endedAt?, scoring }` |
| `scoreLedger` | household | `{ gameId, player, delta, note?, at, by }` (append-only) |
| `rolls` | household | `{ gameId?, player?, notation, dice[], total, secret, at }` |
| `clocks` | device | `{ gameId, kind, base, increment, delay, remaining[], running }` |
| `rulebooks` | household | `{ game, source, licence, pages, passages_fts }` |
| `campaigns` | household | `{ name, system, party[], notes[{ kind, name, text, at }], recaps[] }` |
| `records` | household | `{ game, winner, scores, at }` ("who won the most Catan this year?") |

## 7. Long-running work and events

- Clocks live on the server as timestamps, not as running fibers; a flag-fall is a [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md)
  job at the expected time, recomputed on every tap.
- A game left open is closed after 12 hours of no change (the scores kept in `records`).
- Events: `game.score.changed`, `game.turn.changed`, `game.roll`, `game.clock.flag` on the
  [Event bus](../module-investigation/shared-state-jobs-and-notifications.md), so every screen in the game updates.
- Restart: sessions, scores and campaign notes survive; a running clock resumes paused, and the assistant says so.

## 8. Presentation

- **Scoreboard**: a `table` (players by rounds) or `facts` (totals), pinned while the game runs
  ([presentation §4.4](../module-investigation/presentation-and-device-capabilities.md#44-pinned-widgets-and-the-ambient-stage)).
- **Clock**: a full-screen two-panel layout with large tap targets (a new layout; the `timer` kind is not enough).
- **Dice**: an animated roll then the result and the log; a dice-roll gesture by the character once `turn.activity`
  exists ([CHARACTERS.md](../../CHARACTERS.md) §5.2), as [core-tools §8](core-tools.md#8-presentation) also suggests.
- **The character as host**: in party games the character is the presenter: it faces the player whose turn it is
  (a proposed `stage.content` direction hint), reacts to a right answer with `reply.expression`, and dims while
  players talk among themselves. Old characters ignore both extensions and keep their normal modes.
- **Secret information** (werewolf roles, a hidden roll) only on `private` devices or phones via `handoff`, never on
  the shared screen or spoken aloud.
- **Without a screen**: scores, turns and dice by voice; chess clocks and races are not offered ("The clock needs a
  screen to tap. Use the kitchen tablet?").

## 9. Notifications and proactive behaviour

Only inside a running game: "Ian, ten seconds", "Round five, Sam starts", "Time's up" (`normal`, only on the
game's devices). Nothing outside a game.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | players (from People, plus guest names per game); house rules per game ("free parking money") | — |
| Module | rulebooks (upload, licence note); bundled SRD on/off; BGG token (vault); idle close time | —; on; —; 12 h |
| Assistant | Game Master template (system, tone, content level); Host template for party games | — |
| Device | joins household games; clock layout allowed; private device for secret roles | on; screens only; per device privacy |
| Person | display name and colour on the scoreboard | — |

First run: nothing for scores and dice. For rules: upload PDFs. For the GM: create the template, name the campaign,
add the party.

## 11. Native tools and dependencies

| Dependency | Where | When missing |
|---|---|---|
| `pdfjs-dist` (npm) | server | bundled; scanned PDFs without text need OCR: "This rulebook is a scan; I can't search it yet." |
| BGG token | vault | Metadata questions answered from memory, labelled |
| A screen with touch | device | Clocks and buzzers not offered there |
| Voices per character | server or hosted | The GM speaks every character in its own voice |

## 12. Interaction with the rest of the system

- **Recognition.** Names and numbers dominate ("Ian twelve", "Anna minus four"): the score fast path parses
  `<player> <number>` with core's `ValueParsing` and players' names as a closed list, so the model is not needed for
  the common case. "Fifteen" and "fifty" are the classic confusion: always repeat the number and the new total.
- **Follow-up without a wake phrase.** During a game the device keeps a game window open for score and turn phrases
  only (a closed grammar, like the stop words in [assistant-controls](assistant-controls.md)); everything else needs
  the phrase, because the table is noisy and full of talk.
- **Interruption.** Table talk must not barge in on the GM's narration: interrupt mode "phrase only" for the GM.
- **Voices per character** reuse the `voices` map proposed in [translation §12](translation.md#12-interaction-with-the-rest-of-the-system),
  keyed by character instead of language.
- **Templates.** Game Master (narrator, fair dice, asks for rolls, never decides for players) and Host (energetic,
  brief, keeps time).
- **Other modules.** core-tools `random`; timers for plain countdowns; music for background ambience in RPGs;
  [kids](kids.md) policy limits GM content level; memory-and-notes is not used for campaign notes (they are game
  data, kept separately).

## 13. Privacy and safety

- Scores and campaign notes are household data; guests' names are deleted with the game unless saved.
- Uploaded rulebooks stay on the server and are never served to devices other than as quoted passages.
- Secret roles and hidden rolls never reach shared screens or speech.
- RPG content level is set per campaign; children's devices force the kids' policy.

## 14. Foundations needed

- **Needed first:** [Module store](../module-investigation/shared-state-jobs-and-notifications.md) (scores survive a
  conversation), [Tool context](../module-investigation/shared-state-jobs-and-notifications.md) (which device and table).
- **Later:** [Presentation](../module-investigation/presentation-and-device-capabilities.md) (scoreboard, clock
  layout, dice), [Event bus](../module-investigation/shared-state-jobs-and-notifications.md) (several screens),
  [Device capabilities](../module-investigation/presentation-and-device-capabilities.md) (touch, privacy),
  Notification service and `Announce` (multi-room), assistant templates, the fast path for score phrases.
- **First version without them:** `score`, `turn` and `roll` as ordinary tools with in-memory state per module
  instance, plus a hand-made Game Master assistant prompt. Lost on restart, but good for one game night.

## 15. Open questions

1. **Which games does the household play?** That decides whether rules lookup, clocks or the GM come first.
2. **Rulebook PDFs**: acceptable to keep publishers' rulebooks on the server for private lookup?
3. **Game window without a wake phrase** for score phrases: welcome, or too risky at a noisy table?
4. **Multi-room games**: worth the cross-device session work, or is one screen per game enough?
5. **The character as host**: should party games be the pilot for `stage.content` direction and `reply.expression`?
6. **Disagreement with [fun-and-ambient §4](fun-and-ambient.md#4-tools)**: its `game_score` keeps household high
   scores for trivia. Scores with named players and sessions belong here; fun-and-ambient's could become a reader of
   `records` so there is one score store.
