# Phrase commands, the essential controls, the ringing window

How something said to the assistant runs without the language model: a module's **phrase command** (an action of
yours with phrases), the host's **essential controls** ("stop", "never mind", "repeat", "louder", "quieter"), and the
host's **ringing window** ("stop" and a ringing card's buttons without the wake phrase). This is the first version of
docs/MODULES-PLAN.md §4 P7; what is left out is at the end. The matcher is `packages/core/src/Phrases.ts`, the one
decision per utterance `PhraseDecision.ts`, what runs a taken utterance `PhraseRunner.ts`, the host's own sentences
`PhraseTexts.ts`, session and device control `SessionControl.ts`, the volume message `packages/protocol/src/volume.ts`.
Every promise here has a case in `packages/core/test/phrases/` (the matcher by table, the decision, the kit with a tiny
module), `apps/assistant/test/phrasesSession.test.ts` (the real voice session), `servePhrases.test.ts` (serve mode),
`apps/web/test/replyVolume.test.ts`, `connection.test.ts`, `mockServer.test.ts`, and the latency step
(`packages/store-sqlite/test/phraseLatency.test.ts`).

## Declaring a command

A phrase command is an **action** of your instance (`defineAction`, docs/MODULES.md §10) with `phrases`, per language:

```ts
defineAction({
  id: "switch",
  label: "Switch a lamp",
  description: "Switch the lamp in a room on or off.",
  examples: ["kitchen lamp on", "lamp uit in de keuken"],
  params: { room: Param.dynamic({ label: "Room", options: () => rooms }), to: Param.choice({ label: "On or off", options: [...] }) },
  phrases: { en: ["{room} lamp {to}", "turn the {room} lamp {to}"], nl: ["lamp {to} in de {room}"] },
  risk: "change",
  run: ({ room, to }) => Effect.succeed({ say: … })
})
```

(The whole module and its test: `packages/module-contracts/test/kit/phraseExample.test.ts`, quoted in docs/MODULES.md.)

- **Words and slots.** A phrase is words and `{param}` slots naming the action's parameters. Every required parameter
  (not `optional`, not a yes/no one) is a slot in every phrase; an optional one left out gets its `default`. A `boolean`
  parameter cannot be a slot. Two slots need a word between them; a phrase needs at least one word that is not a slot.
- **Slots read with the parameter's own parser**: `choice` and `dynamic` by value, label or alias (`resolveOption`, which
  tolerates what it always did: case, a leading article, a sound-alike or one edit on a long name); `number` and
  `duration` with core's reader (the whole slot must be exactly one number or duration, within its bounds, with no other
  unit than the parameter's); `text` as said, at most its `maxWords` (and 8). A slot that does not read means the phrase
  does not match.
- **Matching is exact on words.** Case, accents, apostrophes, punctuation and spacing do not count (the words of
  `TextMatching.words`, the normalisation wake phrases use; `@pva/language` exports no normaliser of its own). Nothing
  else is forgiven: no fuzzy matching, no stemming, no fillers ("the kitchen lamp on please" is not "{room} lamp {to}").
  Give the variants people say as phrases.
- **Which language**: the household's (`HOME_LANGUAGE`; `nl…` is Dutch, anything else English). Declare both.
- **The longest phrase wins** (most literal words). Two phrases of one action that tie: the first. A host control beats
  a module phrase of the same length. Two modules' commands that tie on an utterance: neither runs, the utterance goes on
  to the assistant as before.
- **When**: after the wake phrase, in an armed or follow-up window, or on a device whose assistant answers without a
  phrase (the plan's `after-wake`): an utterance the route gate gives to the assistant. An utterance it drops (the
  device is asleep, the assistant is switched off) is never taken. While TypeSafe decides who answers, only the host's
  controls are matched. Typed text is never matched: it is a message to the assistant.
- **For whom**: the assistants that use your instance and have the action on. A command is in an assistant's set when
  its action is in the registry that assistant's turns get: the modules it has on, without the tools and action tools it
  switched off, and without what the risk policy refuses for every class. A module that is not published (stopped,
  restarting, down) has no phrases in any set: saying one goes on to the assistant as before.

### The bounds

| What | Bound | At the bound |
|---|---|---|
| phrases of one action in one language | 8 | the module does not start; the Health page names the action and why |
| actions with phrases in one instance | 16 | the module does not start |
| words of a phrase (a slot counts as one) | 8 | the module does not start |
| characters of a phrase | 80, one line | the module does not start |
| slots of a phrase | 2, not side by side | the module does not start |
| a phrase that is one of the host's (in that language) | reserved | the module does not start |
| the same phrase twice in one action | — | the module does not start |
| module phrases in one assistant's set, per language | 256 | the modules past it are left out of that assistant's set whole, and named on the Health page (source `phrases`) |
| the same phrase (shape) from two modules in one assistant's set | — | both left out for that assistant, named on the Health page |
| an utterance | 24 words, 300 characters | it matches nothing |
| words of one slot | 8 (a text slot: its `maxWords`, at most 8) | that reading does not match |
| slot readings for one utterance, over every phrase | 64 (`slotReads`) | nothing further can match it (it goes on as not taken) |
| the time a command's action may take | 5 s (`ACTION_TIMEOUT_MS`, as every action) | "That didn't work." |
| the spoken answer | 300 characters, at your page boundary | cut |
| taken utterances running at once on a device | 1 | the next is answered "One moment, I'm still doing the last one." |

## What a command's action may do, and what is said

- It runs **through the execution gateway** like every other entry path, as a turn of the assistant on the device with
  `source: "phrase"` (`CurrentTurn`: the device, its room, its default person, the connection that owns its audio, a
  fresh turn id, the assistant's current conversation id): admission, the assistant's switches, your risk function and
  the risk policy. A refusal is "I'm not allowed to do that." (in the household's language).
- It returns at once (within 5 s) with `{ say }`: spoken as a **canned reply** of that assistant on that device (its
  voice, through the device's one output, recorded nowhere: nothing enters the conversation history), cut to 300
  characters. Anything longer it starts in your shared part, or schedules (`inMs: 0`).
- A failure says your `ActionError`'s message (cut to 300); a time-out or a defect "That didn't work.".
- **Not published when it runs** (the module stopped or restarted between the moment the utterance was decided and the
  run): "I can't do that right now.", and nothing ran.
- **The reply it interrupted.** A phrase said over a reply cuts the reply off (barge-in, as any speech does). After your
  answer the host says that reply again, as far as it had been prepared, unless your action is declared `endsReply:
  true` (an action that means "stop that"). "louder" and "quieter" do the same; "stop" and "never mind" do not.
- **Idempotent?** A command runs once per utterance; there is no retry.

## The host's essential controls

For every assistant on every device, whatever modules it has, in both languages, with their common variants (reserved:
no module may declare these words in that language):

| Control | English | Dutch |
|---|---|---|
| stop | stop, stop it, stop that, stop talking, please stop, stop please, be quiet, quiet, silence, shush, hush | stop, stoppen, stop maar, hou op, houd op, stil, wees stil, stil maar, sst |
| never mind | never mind, nevermind, forget it, forget about it, cancel, cancel that | laat maar, laat maar zitten, laat ook maar, vergeet het, annuleer, annuleren |
| repeat | repeat, repeat that, say that again, say again, say it again, come again, pardon, what did you say | herhaal, herhaal dat, herhaal dat nog eens, zeg het nog eens, nog een keer, wat zei je, pardon |
| louder | louder, louder please, a bit louder, speak up, volume up, turn it up | harder, harder graag, wat harder, luider, volume omhoog, zet het harder |
| quieter | quieter, quieter please, a bit quieter, softer, volume down, turn it down | zachter, zachter graag, wat zachter, stiller, volume omlaag, zet het zachter |

- **stop** is one operation: it stops **the first of these that exists** on the device: what rings there (every ring
  the device holds, through the notification service's `stopRinging`, the same admission as the card's Stop); a reply
  being prepared or spoken, or an announcement (every conversation of the device, as the page's Stop; the announcement
  through `stopSpeech`); media the `Playback` service says it paused in the device's room (`pause(room)`, within its 3 s;
  with no provider, or no room, this step does nothing). It says nothing. A reply cut off by the utterance itself counts
  as being spoken.
- **never mind** cancels a pending interaction: a reply being prepared or spoken, and an open armed or follow-up window
  (the next sentence needs the wake phrase). Rings, announcements and media are left alone. It says nothing.
- **repeat** says the device's last spoken reply again (the last committed reply of any assistant there, as far as it
  was prepared, at most 2,000 characters), with the voice of the assistant that said it, as a canned reply; with none
  since the session began: "I haven't said anything yet.".
- **louder / quieter** change the device's **reply volume** one step (below), then say the reply they interrupted again,
  or else "Louder." / "Quieter.", or at the bound "That's as loud as I go." / "That's as quiet as I go.". Media volume is
  not changed in this version.

### Louder and quieter: the reply volume

One level per device, in memory (back at the default after a server restart): 0.2 to 1 in steps of 0.2, default 1 (the
page's level before this version), `REPLY_VOLUME` and the pure `stepReplyVolume` in `@pva/protocol`, which the server and
the web mock both use. The server sends `output.volume { volume }` to every voice page of the device when it changes,
and to a page right after its `welcome` when it is not the default; a page sets its gain back to the default at every
`welcome` first, so a server that restarted and a page that kept an old level never disagree. The page applies it to a
gain node after the visualiser's analyser and before the output (the stage sees the reply as it was made): replies,
announcements and the page's wake and ring cues. At most 256 devices' levels are kept (the oldest change is forgotten).

## The ringing window

The host's only window in this version: open on a device exactly while the notification service says something rings
there (`ringingOn(device)`, read at the utterance's final; nothing rings under do not disturb, on a device whose pages
hold no ringing card, or once it was resolved anywhere), and while the device's setting **"Stop a ring without the wake
phrase"** is on (`place.ringingWithoutWake`, admin › the device › Place; on by default). In it, without the wake phrase:

- a `stop` phrase of the household's language stops every ring held on the device (as "stop" above, without its other
  steps);
- the label of a button of a notification ringing there (its words, exact) presses that action through
  `NotifyEngine.press`, the same claim and admission as the card's button; its answer is spoken. A label shared by two
  ringing notifications goes to the newest. A label that is a stop phrase is "stop".

An utterance that starts with a wake phrase leaves the window (the plan's step 1) and goes the after-wake way: "hey Jeff,
stop" is the host's stop, which stops the ring first; "hey Jeff, snooze" is not a control (it goes to the assistant).

**The device's own spoken line.** The window does not take an utterance during which the device was audible at any
moment: from the page's report that a reply or an announcement started playing on that device until it ended, plus the
echo tail (`ECHO_TAIL_MS`, 300 ms): the echo gate's `audible` window, the same signal that tells the echo gate the
assistant's own voice may be in the microphone. **Not solved**: another device's announcement heard through this
device's microphone (an announcement "everywhere"); a television or a person in the room saying "stop"; the ring cue
itself (three tones the page makes) is not speech and is not in the audible window, so a recogniser that heard a word in
it would be believed; and a follow-up window (after-wake by the plan's step 5) is open while a reply plays, so in
`instant` mode the device's own words in a follow-up window reach the route gate as they always did, and a "stop" among
them is the host's stop. How often a ring's own line stops it was not measured (there is no spoken line on a ring in
P9's first version).

## The one decision per utterance

`decideUtterance` (`PhraseDecision.ts`), called by the voice session at each utterance's final transcript
(`VoiceSession.onStt`) and nowhere else, decides once whether the utterance is taken, by the ringing window (before the
echo gate, so one word is not lost to its two-word rule), by a host control or by a module's command (after the route
gate). The utterance's earlier events (speech start, interims, eager, resumed) were passed on as always: the start of
speech may interrupt a reply, and an eager transcript may start a speculative turn. A taken utterance's final reaches the
conversations with no words, so it closes the utterance, discards that speculative turn and starts nothing: **it never
becomes a turn, nothing of it enters the history, and no tool that is not speculative runs for it** (a speculative turn
holds such a call until it is promoted). The answer is a canned reply (its own trace, as a typed canned reply has). An
utterance that is not taken goes through the gates exactly as before. Each fact the run uses is read when it is used:
what rings, whether a reply is active, whether the action is still published, the volume, the room.

In `manual` interrupt mode the microphone counts for nothing while a reply plays (as before), so a control said over a
reply is not heard; in `confirm` mode the echo gate passes it once it is two words or more that the reply did not just
say ("hey Jeff, louder").

## Session and device control (for modules)

`SessionControl` and `DeviceControl` are core services (`ctx.host.service(SessionControl)`), each call naming the device
(a tool passes its turn's `deviceId`): `stopReply`, `cancelPending`, `repeatLast`, `newConversation`; `replyVolume`,
`changeReplyVolume("louder" | "quieter" | { to })`. The spoken controls do exactly these. Absent in the CLI modes.

## Testing

`startTestModule` (`@pva/core/testing`) gives `kit.phrases`, on the real decision, matcher, runner and gateway, and the
real notification service:

| Handle | What it does |
|---|---|
| `say(text, { device?, assistant?, wake?, interrupting? })` | the recogniser's final on a device: after the wake phrase (default), or `wake: false` (only the ringing window can take it: open while the kit's service says something rings there, the device's "while ringing" is on, and `notify.replying(device)` is off). `interrupting`: the text of a reply the utterance cut off. Answers `{ taken: false }` or `{ taken: true, by: "ringing" \| "control" \| "command", outcome }` (`did`, `said`, `why`) |
| `decide(text, as)`, `run(taken, as)` | the decision alone, and running it later (to change something in between, as a module that restarts) |
| `spoken`, `answered` | every line said, every outcome |
| `replied(device, text)` | a reply was spoken (what "repeat" says) |
| `volume(device)` | the device's reply volume |
| `commandsFor(assistant?)` | the assistant's set as serve mode builds it, with its conflicts (the Health page's) |
| `sessionCalls` | the stops and cancels the kit's session was asked for |

Where the kit differs from serve mode: it has no recogniser, echo gate or route gate (`wake` stands in for the route: the
wake phrase's assistant, or nobody), no conversation (a "reply being spoken" is `notify.replying`), and the canned answer
is recorded, not synthesised. What a real voice session adds is tested in `apps/assistant/test/phrasesSession.test.ts`.

## Latency

Measured by `packages/store-sqlite/test/phraseLatency.test.ts` (the latency step; the longest stops asserted with the
shared `bound(10)`) on the development machine, at the stated maximum: one assistant's set at its bound (256 module
phrases of 8 words with 2 slots each: a dynamic list of 255 options with an alias each, and a duration; plus the host's
controls), utterances of 24 words.

| What | Number |
|---|---|
| a near miss (every phrase aligns its first words, then fails), 500 utterances | median 0.032 ms, p95 0.04 ms, worst 0.13 ms; longest stop 1.1 ms |
| a match (the 255-option list read once, the duration once), 500 utterances | median 0.32 ms, p95 0.56–0.74 ms, worst 1.1–1.3 ms; longest stop 1.5–1.8 ms |
| a sentence built to align with 256 two-slot phrases everywhere (the full 64 readings) | median 0.052 ms, worst 0.13 ms; longest stop 1.0 ms |
| a 24-word turn that is no command, with something ringing and the full set (`TurnTrace`, 100 turns × 4 counterbalanced runs, the real `Conversation`, the model's first token at 5 ms) | end of turn → first audio 5.408 ms without the decision, 5.437 ms with it (p95 5.71 / 6.40); the recogniser's final → first audio 5.431 / 5.505 ms (p95 5.75 / 6.46) |

So a turn that is not a command moved by a median 0.07 ms from the recogniser's final (the test asserts under 1 ms).
In serve mode the set is cached per module snapshot, assistant and language, so a final reads it from the cache.

## Not now

Module windows, `capture`, guards, the `audible` window (wake-free control while a reply plays) and its setting, typed
actions before the model, switching the assistant, sleep, microphone mute, device state, earcons and canned replies of a
module, media volume for louder and quieter, phrases on a notification's actions (a button's label is its phrase),
matching typed text, fuzzy matching, the admin warning for a routine phrase close to a wake phrase, and the measurement
of false stops.
