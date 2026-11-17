# Fun and ambient

Research write-up, 2026-11-17. Not an approved design, and lower priority than the media modules. Claims marked
**[unverified]** come from memory. Latency figures are estimates to be measured with `TurnTrace`.

## 1. Summary

A bundle of small things that make the assistant pleasant to live with:

- ambient and sleep sounds with a sleep timer;
- games and trivia;
- jokes and stories;
- a kids' mode;
- character-driven idle behaviour on the stage.

Most of it is the language model plus a little state, which is why it is cheap. Ambient sound reuses the playback
path of [music.md](music.md).

- **Priority: later.** Sleep sounds come first once music's playback path exists. Kids' mode comes first if children
  use the devices.
- **Effort: S to M.**
  - Sleep sounds: S on top of music route 3.
  - Games and stories: S each, mostly prompts and a Module store collection.
  - Kids' mode: M, because it is a policy that crosses every module.
  - Idle behaviour: S per character extension.

## 2. What others do

| System | Behaviour | Copy | Avoid |
|---|---|---|---|
| Alexa, Google, HomePod | Rain and white noise with "for 8 hours"; jokes; Amazon Kids profiles and filtered content; Google removed third-party games in 2023 ([landscape](../module-investigation/landscape-voice-assistants.md) §1, §2) | Sleep timer phrasing, kids' profiles | Games that need a skill store to survive |
| Leon, OVOS | Native games (Akinator, guess the number, rock-paper-scissors), jokes ([landscape](../module-investigation/landscape-voice-assistants.md) §5, §8) | Games as built-ins, not plugins | — |
| Leon "Vibes" | Ambient scenes following season, time and weather ([landscape](../module-investigation/landscape-voice-assistants.md) §8) | The idle stage reflecting the day | Busy animation on an idle screen |
| Echo Show, Nest Hub | Ambient screen: clock, photos, pending items ([landscape](../module-investigation/landscape-voice-assistants.md) §15.6) | Idle as real estate | — |

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | Bedroom: "Hey Jev, play rain sounds for an hour." → "Rain, for an hour." It fades out at the end. | no |
| 2 | "Let's play trivia, easy, animals." → "Question one of five: what is a group of crows called?" → "A murder." → "Right! One point." | optional: the question and choices as a `list` |
| 3 | "Tell me a joke." → a short clean joke; "Another one" works in the follow-up window. | no |
| 4 | Kids' room, bedtime: "Tell me a story about a kiwi who wants to fly." → a 3-minute story, spoken in clauses. "Stop" ends it; "What happened next?" continues tomorrow. | no |
| 5 | Failure: "Play ocean sounds in the kitchen." with no playback route on the kitchen node → "This speaker can't play sounds yet. I can play them on the kitchen tablet." | no |
| 6 | Ambiguous: "Play something relaxing." → music or ambient? The module asks once: "Calm music, or nature sounds?" Afterwards the device remembers the answer. | no |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `ambient_play` | `sound: rain \| ocean \| forest \| fire \| white \| pink \| brown \| fan`, `for?: duration`, `where?` | what plays until when | W | changes | < 300 ms | **yes** |
| `ambient_stop` | `where?`, `fade?: seconds` | ok | W | changes | < 100 ms | **yes** |
| `game_start` | `game: trivia \| riddles \| twenty-questions \| guess-number`, `topic?`, `difficulty?`, `rounds?` | the first question | W (conversation state) | safe | trivia API 200–500 ms | no |
| `game_answer` | `answer` | correct or not, score, next question | W | safe | < 50 ms | no |
| `game_score` | none | scores this game, or the household's best | R | safe | < 50 ms | no |
| `story_continue` | `story?` | the saved state of a story (characters, where it stopped) | R | safe | < 50 ms | no |

Jokes and stories need no tool: they are the model's own output, guided by instructions. `story_continue` exists only
to remember a story across days.

## 5. Integrate or build

- **Ambient sounds: build.**
  - White, pink and brown noise are generated in the browser with an `AudioWorklet`. That needs no files, loops
    perfectly, and costs nothing.
  - Recorded loops (rain, waves) come from CC0 recordings on Freesound, filtered by the CC0 licence **[unverified:
    which files]**. They are stored on the server and played through the music module's route 3 proxy. Nodes play
    them with `mpv` (music route 4).
- **Trivia: integrate.** Open Trivia DB: `https://opentdb.com/api.php?amount=5&category=27&difficulty=easy&type=multiple`,
  keyless, with a session token so questions do not repeat, under CC BY-SA 4.0 **[unverified: current terms]**. The
  model hosts the game, and the API supplies checked questions. Questions the model writes itself are sometimes
  wrong, and an API answer key avoids that.
- **Jokes: the model**, with an instruction ("clean, short, one at a time"). JokeAPI with `safe-mode` as a source on
  kids' devices **[unverified]**.
- **Stories: the model.** The prompt supplies length (in minutes, about 150 words a minute of speech), age and
  characters. Clauses stream to TTS as they do today.
- **Kids' mode: build**, as a policy and an assistant template, not a separate module. See §12.

## 6. Data

Kept in the Module store.

| Collection | Scope | Schema |
|---|---|---|
| `games` | conversation | `{ game, questions[], index, score }`, deleted at conversation end |
| `highScores` | household | `{ game, person?, score, at }` |
| `stories` | person or device | `{ title, summary, characters, lastPart, updatedAt }`, so "what happened next?" works on another day |
| `ambientDefaults` | device | `{ sound, for }` (the bedroom's usual) |
| `triviaToken` | household | the Open Trivia DB session token |

## 7. Long-running work and events

- A sleep timer is a Scheduler `deferred command` that ends ambient sound with a 30 s fade. It is harmless to run
  late after a restart.
- Events: emits `ambient.playback.changed`, shared with music's media guard and ducking, so the wake phrase is
  required while rain plays. Consumes `alarm.due`: an alarm stops sleep sounds first.

## 8. Presentation

- **Sleep sounds**: the screen dims to a dark Ambient layout with a clock and the sound's name. The character is
  `asleep`, and the brightness follows the room's quiet hours.
- **Trivia**: question and choices as a `list` with `pick`, so tapping answers. The score is a small `facts` badge in
  Orbit.
- **Stories**: no visuals by default. Optionally one generated or found image per story chapter, with the Hold-up
  from [images-and-photos.md](images-and-photos.md) (the cost is per image).
- **Idle behaviour** (screens only):
  - The stage at rest is the character's own life between events ([CHARACTERS.md](../../CHARACTERS.md) §2.3: blinks,
    small gaze shifts, seeded timing).
  - Proposed optional extension `ambient.context`: `{ v: 1, dayPhase: dawn | day | dusk | night, weather?: clear |
    rain | snow | wind, quiet: boolean }`, fed by the clock and weather modules. A light character could burn lower at
    night; a figure could yawn once at dusk.
  - Rules: calm, never animated loops that draw the eye, never an invented emotion.
  - Old characters ignore it ([CHARACTERS.md](../../CHARACTERS.md) §5.2).
- **Without a screen**: everything here is spoken or sound; nothing degrades.

## 9. Notifications and proactive behaviour

None spoken. The single exception is opt-in per device: a gentle "it's bedtime" at a set time on a kids' device,
priority `normal`, honouring quiet hours.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | kids' mode policy (sources, explicit filters, allowed modules); game question source | strict; Open Trivia DB |
| Module | sound library folder; maximum ambient duration | bundled set; 10 h |
| Assistant | a `kids` template: persona, voice, modules on | off |
| Device | kids' device (applies the policy); default sleep sound; bedtime | no |
| Person | age group (for stories and trivia difficulty) | adult |

## 11. Native tools and dependencies

No native tools on the server. Recorded loops need music route 3 (browser) or `mpv` on a node. Without them, the
generated noises still work in the browser. On a node the assistant says "This speaker can't play sounds yet."

## 12. Interaction with the rest of the system

- **Kids' mode** is a device policy plus an assistant template.
  - **The device**, marked "kids":
    - uses the `kids` assistant, whose persona is short sentences, warm, no sarcasm;
    - sets safe search strict in images and video;
    - turns explicit content off in music;
    - turns generation off, and turns off risky classes (`message`, `money`, `security` denied, already the default
      ceiling);
    - limits the volume.
  - Voice is not identification. Kids' mode follows the device, not a guessed speaker.
- **Games and the fast path**: answers are free text, so they need the model; no fast path.
- **Recognition**: trivia answers are noisy ("a murder" → "amurder"). Grading accepts one edit and the model's
  judgement.
- **Interruption**: barge-in ends a story clause. "Carry on" resumes from the stored `lastPart`.
- **Other modules**: music (playback, ducking), clock and weather (idle context), images (story pictures), and
  alarms (stop sleep sounds).

## 13. Privacy and safety

- High scores name people only if they say who they are.
- Stories and games for children do not store their names beyond the story record, which an adult can delete in
  admin.
- Kids' devices get no purchases, no messages, no web images, and no camera snapshots.

## 14. Foundations needed

- Music's playback route (for recorded sounds), Scheduler (sleep timer), Module store (games, stories), Device
  capabilities (place and a kids flag), and Presentation (`list`, `facts`).
- **First version without them:** jokes, stories and model-hosted riddles work today through instructions alone.
  Browser-generated noise needs only a small `media.play`-style message.

## 15. Open questions

1. **Are there children using the devices?** That decides whether kids' mode is built early or not at all.
2. **Sound library**: bundle a few CC0 loops in the repository (about 20 MB), or download them on first use as a job?
3. **Idle character behaviour**: is `ambient.context` (time of day, weather) welcome, or should the idle stage stay
   exactly as calm as today?
4. **Trivia source**: Open Trivia DB (English only) or model-written questions in Dutch too?
