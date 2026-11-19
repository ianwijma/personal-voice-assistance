# Phrase commands, the essential controls, the ringing window

How something said to the assistant runs without the language model: a module's **phrase command** (an action of
yours with phrases), the host's **essential controls** ("stop", "never mind", "repeat", "louder", "quieter"), and the
host's **ringing window** ("stop" and a ringing card's buttons without the wake phrase). This is the first version of
docs/MODULES-PLAN.md §4 P7; what is left out is at the end. The matcher is `packages/core/src/Phrases.ts`, the one
decision per utterance `PhraseDecision.ts`, what runs a taken utterance `PhraseRunner.ts`, the host's own sentences
`PhraseTexts.ts`, sets prepared ahead `PhraseSets.ts`, session and device control `SessionControl.ts`, the volume
message and its one state machine `packages/protocol/src/volume.ts`.
Every promise here has a case in `packages/core/test/phrases/` (the matcher by table, the decision, the kit with a tiny
module, and the findings of review round 1), `apps/assistant/test/phrasesSession.test.ts` (the real voice session, the
page's stop report early and late), `servePhrases.test.ts` and `servePhraseSets.test.ts` (serve mode),
`replyVolumes.test.ts`, `packages/protocol/test/volume.test.ts`, `apps/web/test/replyVolume.test.ts`,
`connection.test.ts`, `mockServer.test.ts`, and the latency step
(`packages/store-sqlite/test/phraseLatency.test.ts`).

## Declaring a command

A phrase command is an **action** of your instance (`defineAction`, docs/MODULES.md §10) with `phrases`, per language:

```ts
defineAction({
  id: "switch",
  label: "Switch a lamp",
  description: "Switch the lamp in a room on or off.",
  examples: ["kitchen lamp on", "lamp uit in de keuken"],
  params: { room: Param.choice({ label: "Room", options: rooms }), to: Param.choice({ label: "On or off", options: [...] }) },
  phrases: { en: ["{room} lamp {to}", "turn the {room} lamp {to}"], nl: ["lamp {to} in de {room}"] },
  risk: "change",
  run: ({ room, to }) => Effect.succeed({ say: … })
})
```

(The whole module and its test: `packages/module-contracts/test/kit/phraseExample.test.ts`, quoted in docs/MODULES.md.)

- **Words and slots.** A phrase is words and `{param}` slots naming the action's parameters. Every required parameter
  (not `optional`, not a yes/no one) is a slot in every phrase. A parameter a phrase leaves out gets what every other
  path gives it, before the risk class is judged: its declared `default`, `false` for a yes/no parameter, else
  `undefined`. Two slots need a word between them; a phrase needs at least one word that is not a slot.
- **What a slot can be: a number, a duration, a fixed choice (at most 32 options and 96 names, counting values, labels
  and aliases, each at most 40 characters) or text.** A `boolean` cannot be a slot,
  and neither can a parameter whose options come from a callback (`Param.dynamic`): the module's start is refused with a
  sentence saying to make it text and resolve the name in the action (which runs off the matching path, within the
  action's time limit). Everything the matcher reads is prepared when the set is built: a choice's values, labels and
  aliases become lookup keys (case, accents, punctuation and a leading article do not count; no sound-alikes, no edit
  distance), made once per choice however many phrases read it (the start's check only counts and measures the names),
  a number's and a duration's bounds are kept. **A match makes no call into module code and normalises
  nothing but the utterance.** Why: in the first version a slot of a 255-option list was resolved by `resolveOption` on
  every reading (sound-alike keys and edit distance for every option), and a sentence aligned with 256 two-slot phrases
  spent its 64 readings in 220–238 ms of main thread (review round 1, a1); the same aligned case now takes a median
  0.21 ms (see "Latency").
- **A slot's value is what was said.** The characters between the slot's neighbouring words (a sign, a leading decimal
  point or comma, `%`, `°`, `#`, `+` and `.` included; the separators `, ; :` beside it and an utterance's closing
  punctuation not, but a comma glued to the first digit group, ",5", is the number's) go to the slot's parser, which
  decides: "set −5" is −5 for a number that allows it, "set .5" and "zet ,5" are 0.5, "dim 40%" is 40 for a percent
  parameter and nothing for a unitless one, "wait -5 minutes" and "wait ,5 minutes" are no duration, "note C++" is
  "C++". A number or duration must be the whole slot: one expression, which covers every character of the slot that is
  not a space (so "#5", "$5", "+5", "5+" and "5/" are no number; a sign the parser reads, a leading decimal mark, "%"
  and "°" are part of the expression), within its bounds and with no other unit than the parameter's; text is at most
  its `maxWords` (and 8). A slot that does not read means the phrase does not match.
- **Matching is exact on words.** Case, accents, apostrophes, punctuation and spacing do not count (`phraseWords`: a word
  keeps its combining marks while it is cut out, so composed and decomposed accents, "één" either way, give the same
  word, and a slot's characters still come from the original text; `@pva/language` exports no normaliser of its own).
  Nothing else is forgiven: no fuzzy matching, no stemming, no fillers ("the kitchen lamp on please" is not
  "{room} lamp {to}"). Give the variants people say as phrases.
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
  switched off. What the risk policy refuses does **not** leave a set (P8): the phrase is taken and its action is
  decided when it runs (below), so a refused command says why instead of going on to the assistant. A module that is not published (stopped,
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
| options of a choice that is a slot | 32 | the module does not start |
| names of a choice that is a slot (its values, labels and aliases, counted) | 96, each at most 40 characters | the module does not start (the sentence names the slot and the count or the name) |
| a parameter whose options come from a callback (`Param.dynamic`) as a slot | — | the module does not start (make it text) |
| words of one slot | 8 (a text slot: its `maxWords`, at most 8) | that reading does not match |
| slot readings for one utterance, over every phrase (a reading: one parser call on a span whose words are aligned) | 64 (`slotReads`) | the search proved nothing: **not taken**, it goes on to the assistant; no shorter match found earlier is used |
| the time a command's action may take | 5 s (`ACTION_TIMEOUT_MS`, as every action) | "That didn't work." |
| the spoken answer | 300 characters, at your page boundary | cut |
| module actions running at once on a device (a command, a ringing card's button) | 1 | the next is answered "One moment, I'm still doing the last one."; the host's controls and the ringing "stop" are never refused as busy |
| a reply kept for "repeat" and for saying it again | 2,000 characters, whole clauses | cut |
| the wait for the interrupted reply's end (the page's stop report) | 2 s | read as it is then |
| the wait for one canned reply to end before the next is said | 3 min | the next is not said |

## What a command's action may do, and what is said

- It runs **through the execution gateway** like every other entry path, as a turn of the assistant on the device with
  `source: "phrase"` (`CurrentTurn`: the device, its room, its default person, the connection that owns its audio, a
  fresh turn id, the assistant's current conversation id): admission, the assistant's switches, your risk function and
  the household's risk policy (docs/MODULES.md §4), on the policy of that moment and with the same function as the
  model's call of the same action: the same class, the same decision. A refusal by the risk policy says the policy's
  own spoken sentence, the one the intent path says ("I can't do that: this household doesn't allow me to change
  things in the house.", in the household's language); a refusal by the gateway's other checks says "I'm not allowed
  to do that.". The host's own controls ("stop", "never mind", "repeat", "louder", "quieter") do not go through the
  gateway and are never refused; a ringing card's button said aloud is a press on the card, decided as one
  (docs/NOTIFICATIONS.md).
- It returns at once (within 5 s) with `{ say }` (else its `announce`): spoken as a **canned reply** of the assistant it
  was addressed to, on that device (its voice, through the device's one output, recorded nowhere: nothing enters the
  conversation history), cut to 300 characters. Anything longer it starts in your shared part, or schedules (`inMs: 0`).
- A failure says your `ActionError`'s message (cut to 300); a time-out, a defect or an `announce` that throws "That
  didn't work."; a refusal by the risk policy its own sentence (above), by the gateway's other checks "I'm not allowed
  to do that."; one module action already running on the
  device "One moment, I'm still doing the last one.".
- **Not published when it runs** (the module stopped or restarted between the moment the utterance was decided and the
  run): "I can't do that right now.", and nothing ran.
- **One settlement for every outcome.** After the operation, one function decides what is said and in whose voice:
  the command's own sentence (above), if any, in the voice of the assistant it was addressed to; then, unless the command
  ends the reply, **the reply this utterance's start of speech interrupted**, said again (as far as it was prepared) in
  the voice of the assistant that was saying it, after the first has finished, never cutting it off; nothing more once
  something cut the first short. The commands that end the reply: an action declared `endsReply: true`, a "stop" that
  selected the reply, and "never mind". The interrupted reply is the one playing when the utterance began, found by its
  turn; when the page's report that it stopped has not come yet, the settlement waits for it (at most 2 s).
- **A cancelled reply is not brought back.** When the interrupted reply is cancelled while the settlement waits (a
  "stop" that selects it, the page's Stop, "never mind" or `cancelPending`, a new conversation of its assistant), it is
  not said again: checked after every wait and right before it would be said. The command's own sentence is still said,
  and the lines of such a settlement open no follow-up window. "repeat" still says the last reply when asked. A "stop"
  said while such a settlement is pending selects that reply still to come (it counts as the reply).
- **A cancelled utterance runs nothing, and is no turn**: when the page's Stop or a new conversation cancelled the
  utterance between its first words and its final, no command and no control runs for it, and its final reaches the
  conversations with no words (as a taken utterance's does), so it never becomes a turn, even when the stop came before
  the conversation had opened the utterance (with or without phrase commands).
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

- **stop** is one operation: it stops **only the first of these that exists** on the device: what rings there (every
  ring the device holds, through the notification service's `stopRinging`, the same admission as the card's Stop); the
  announcement being spoken there (`stopSpeech`); a reply being prepared or spoken (every conversation of the device, as
  the page's Stop; a reply this utterance's own start of speech cut off counts); media the `Playback` service says it
  paused in the device's room (`pause(room)`, within its 3 s; with no provider, no room, or no player for the room, this
  step does nothing). It says nothing itself. When it selected a ring or an announcement, the reply its start of speech
  interrupted is said again (the settlement); when it selected the reply, that reply stays stopped. **Once a step is
  selected, the utterance is about that one**: when stopping it fails (the notification service reports the ring could
  not be stopped, the announcement's stop fails, the media's pause fails or takes longer than 3 s), it says "I couldn't
  stop that." ("Dat kon ik niet stoppen."), nothing else is stopped in its place, and the interrupted reply is said
  again.
- **never mind** cancels a pending interaction: a reply being prepared or spoken, and the armed and follow-up windows,
  including the one the cancelled reply would open when its end is reported, late or not (the reply is known by its
  turn; a later reply opens its own window as before). Rings, announcements and media are left alone. It says nothing.
- **repeat** says again the reply this utterance interrupted, else the device's last spoken reply (the last committed
  reply of any assistant there, as far as it was prepared, at most 2,000 characters), with the voice of the assistant
  that said it, as a canned reply; with none since the session began: "I haven't said anything yet.".
- **louder / quieter** change the device's **reply volume** one step (below), then say the reply they interrupted again
  at the new level, or else "Louder." / "Quieter."; at the bound "That's as loud as I go." / "That's as quiet as I go."
  (then the interrupted reply). Media volume is not changed in this version.
- The host's controls and the ringing window's "stop" are never refused as busy, whatever module action runs.

### Louder and quieter: the reply volume

One level per device, in memory (back at the default after a server restart): 0.2 to 1 in steps of 0.2, default 1 (the
page's level before this version). **One state machine**, `changeReplyVolume` in `@pva/protocol`, pure, holds the whole
transition and the server and the web mock both run it: a step ("louder", "quieter"; at the bound `atLimit` and nothing
changes), an absolute level (moved to the nearest step; one that is the level already is `atLimit` and changes nothing),
the device moved to the newest place, the default not kept, and at most 256 levels: past them the oldest is dropped
**and that device's pages are sent the default in the same step**, so a page never keeps a level the server forgot. The
server sends `output.volume { volume }` for every send of a transition to every voice page of the device, and to a page
right after its `welcome` when its level is not the default; a page sets its gain back to the default at every
`welcome` first, so a server that restarted and a page that kept an old level never disagree. The page applies it to a
gain node after the visualiser's analyser and before the output (the stage sees the reply as it was made): replies,
announcements and the page's wake and ring cues.

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

Off, a card's buttons cannot be said at all (they are pressed on the card), and "stop" works after the wake phrase, as
the host's control (the Place form says so).

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
holds such a call until it is promoted). The answer is a canned reply. An utterance that is not taken goes through the
gates exactly as before. Each fact the run uses is read when it is used: what rings, whether a reply or an announcement
is active, whether the action is still published, the volume, the room.

### Sets are prepared ahead

A final only **reads** a set; it never builds one. Each switched-on assistant's set is prepared ahead (`PhraseSets.ts`),
whenever something it depends on changes (the modules publish or withdraw, a settings save, the household's language),
in bounded steps with a real yield to the event loop between them: a step is measured by the normalising it did (a unit
per phrase or choice name, each at most 80 characters) and ends after 256 units (`PREPARE_STEP_WORK`), so a module of
16 actions with two full choices per phrase is prepared over a dozen steps, not one. A set
is keyed by exactly what it depends on: the module snapshot's version, the language and the assistant's module choices
(on, the tools switched off), never by the identity of an assistant object; and inside, by the published actions with
phrases, so a change that keeps the same actions keeps the same set without compiling it again. A final whose set is
not ready matches the host's controls alone, and a module phrase is not taken (it goes on to the assistant). That loses
nothing a control could take: a host phrase is reserved, so no module phrase can read the same words with more literal
words, and a control matches the same with or without the module set.

### Traces

Every taken utterance leaves an **execution trace**, published where turn traces are (admin's latency list, the `trace`
message), and no conversation turn or history entry: `TraceInfo` with `phrase` (additive within protocol 11): what took
it (`by`: ringing, control, command; `name`), the outcome (`did`, `why`), for a command the class the gateway judged it
as and its refusal (`risk`, `refused`), the risk policy's decision (`decision`: `outcome` and `by`, P8), the person it ran for, how long the action ran (`actionMs`, and the tool in
`tools`), and the whole run (`totalMs`). Also for a silent action, and a failed, refused or timed-out one. Exactly one
per taken utterance: its identity (the addressed assistant, else the device's answering one; the principal, the turn a
command runs as, with its person; the control or command and its tool) is fixed before anything can return early, so a
busy or withdrawn command has it too; its outcome is what happened (a risk only when the gateway judged the call); it
is published from a finaliser, so also when the session ends during the action (`did: "interrupted"`) or while its
answer is spoken (`why: "interrupted while speaking"`).

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
| `say(text, { device?, assistant?, wake?, interrupting?, interruptedBy?, cancelled? })` | the recogniser's final on a device, once the sets are ready: after the wake phrase (default), or `wake: false` (only the ringing window can take it: open while the kit's service says something rings there, the device's "while ringing" is on, and no reply (`notify.replying`), announcement or line the kit itself spoke (a command's answer, a repeat, a reply said again) is audible there or in its 300 ms echo tail, serve mode's own rule (`EchoGate`): advance the clock 300 ms after a phrase whose answer was spoken before testing the window; and the utterance did not interrupt a reply). `interrupting`: the text of a reply the utterance cut off (kept by serve mode's rule), `interruptedBy`: whose; `cancelled`: the utterance was cancelled before its final. Interrupting the call (the test's fiber) interrupts the command's action as in serve mode: its clean-up runs, nothing is said afterwards, the device's slot is free again. Answers `{ taken: false }` or `{ taken: true, by: "ringing" \| "control" \| "command", outcome }` (`did`, `said`, `why`) |
| `decide(text, as)`, `run(taken, as)` | the decision alone, and running it later (Effects: change something in between, as a module that restarts) |
| `spoken`, `answered`, `traces` | every line said (with its assistant), every outcome, every execution trace |
| `replied(device, text)` | a reply was spoken (what "repeat" says), kept as serve mode keeps it (2,000 characters, whole sentences) |
| `volume(device)`, `volumeSends` | the device's reply volume; every `output.volume` serve mode would send |
| `commandsFor(assistant?)` | the assistant's set once prepared (an Effect), with its conflicts (the Health page's) |
| `sessionCalls` | the stops and cancels the kit's session was asked for |

The kit runs serve mode's own helpers: the one decision, the prepared sets (`makePhraseSets`), the runner and its one
settlement, one module action at a time per device (`makeCommandSlot`), the volume state machine, the kept reply's rule
(`keptReplyText`); and a module gets the kit's `SessionControl` and `DeviceControl` (on the same session and volume
state), dying with `ModuleStopped` once its part closed. Where it differs from serve mode: it has no recogniser, echo
gate or route gate (`wake` stands in for the route: the wake phrase's assistant, or nobody), no conversation (a "reply
being spoken" is `notify.replying`), the canned answer is recorded and counts as finished at once, and it waits for the
sets before each phrase. What a real voice session adds is tested in `apps/assistant/test/phrasesSession.test.ts`.

## Latency

Measured by `packages/store-sqlite/test/phraseLatency.test.ts` (the latency step; the longest stops asserted with the
shared `bound(10)`; the work counted with the matcher's `MatchStats`) on the development machine, at the stated
maximum: one assistant's set at its bound (256 module phrases of 8 words with 2 slots each: a choice of 32 options with an
alias each, and a duration; plus the host's 37 English controls).

| What | Number |
|---|---|
| a near miss: 24 words, 257 phrases aligned (the 256 and "please stop"), no reading; 500 utterances | median 0.032 ms, p95 0.039 ms, worst 0.061 ms; longest stop 1.03 ms |
| a match: 11 words, 2 readings; 500 utterances | median 0.039 ms, p95 0.056 ms, worst 0.23 ms; longest stop 1.09 ms |
| the reviewers' aligned worst case: 9 alternating words against 256 two-slot phrases over those words (number and duration slots), 80 aligned, the full 64 readings, not taken; 200 utterances | median 0.217 ms, p95 0.356 ms, worst 0.496 ms; longest stop 1.24 ms (220–238 ms in the first version, with a 255-option list resolved per reading) |
| the maximum choice-bearing module (16 actions × 8 phrases, each phrase two slots that are choices at the full budget: 32 options, 96 names of 40 characters, every action its own two choices; new objects each time, as after a start): the start's declaration check, 30 times | median 0.52 ms, worst 1.04 ms, in one synchronous step |
| the same module's set prepared, 10 preparations after 10 starts | median 5.6 ms of wall time each, in 90 steps; longest step 1.24 ms; longest stop 2.0 ms |
| preparing one assistant's set from 4,096 declarations (32 modules × 16 actions × 8 phrases, a duration slot; 256 kept), 10 preparations | median 2.3 ms of wall time each, in steps; longest stop 2.6 ms |
| a 24-word turn that is no command, something ringing, its set invalidated before every final (the final read the host's controls while the set was prepared again: 120 of 120), `TurnTrace`, 100 turns × 4 counterbalanced runs, the real `Conversation`, the model's first token at 5 ms | end of turn → first audio 5.424 ms without the decision, 5.421 ms with it (p95 5.68 / 5.57); the recogniser's final → first audio 5.440 / 5.522 ms (p95 5.70 / 5.69) |

So a turn that is not a command moved by a median 0.08 ms from the recogniser's final (the test asserts under 1 ms),
and a final never compiles a set. Run as CI runs it (`CI=1`, two cores): the aligned worst case median 0.217 ms, worst
3.3 ms, longest stop 3.9 ms; the choice-bearing module's check worst 3.3 ms, its preparation's longest step 1.8 ms and
longest stop 2.6 ms; the 4,096-declaration preparation's longest stop 3.5 ms; the turn's final → first audio 5.423 /
5.541 ms. (Before review round 2 the choice-bearing module's check took 27–115 ms and its preparation stopped the main
thread for 18–99 ms in one step, with one to ten aliases per option.)

## Not now

Module windows, `capture`, guards, the `audible` window (wake-free control while a reply plays) and its setting, typed
actions before the model, switching the assistant, sleep, microphone mute, device state, earcons and canned replies of a
module, media volume for louder and quieter, phrases on a notification's actions (a button's label is its phrase),
matching typed text, fuzzy matching, the admin warning for a routine phrase close to a wake phrase, and the measurement
of false stops.
