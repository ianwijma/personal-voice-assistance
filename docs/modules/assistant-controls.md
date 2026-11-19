# Assistant controls (`assistant-controls`)

Stop, repeat, a new conversation and the reply volume, by voice and for the model.

- Package: `packages/module-assistant-controls`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 1 (wave B)
- Research: [docs/research/modules/assistant-controls.md](../research/modules/assistant-controls.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

## What it does

The host already takes **stop, never mind, repeat, louder and quieter** as spoken controls for every assistant on every
device, without the language model ([PHRASES.md](../PHRASES.md)). Those phrases are reserved: this module does not
register them. It adds:

- the **same operations as tools**, so the model can do them when the person words it freely ("could you turn it down a
  bit", "forget what we said and start again"): stop the reply, cancel what is pending, repeat the last reply, start a
  new conversation, set the reply volume to a level, louder, quieter, and what the volume is;
- **phrase commands** (no model) for what the host does not take: **a new conversation**, and **the volume to a level**.

It acts only through the core's `SessionControl` and `DeviceControl`, **on the device of the turn that asked** (a tool
has no device parameter: it cannot act on another device). It is off by default; with it off nothing changes for
anyone. It provides no service and contributes nothing.

**It stores nothing and schedules nothing.** It declares no collection, no job and no notification, and keeps nothing
of the host past a call. The reply volume is the server's own state (in memory, one level per device, back at the
loudest after a restart: PHRASES.md "Louder and quieter"); the module only asks the service to change it.

**Privacy.** The module holds and reveals no personal content. "Repeat" speaks the last reply **of the asking device**
again on that device, as the service does (a reply said on one device is never repeated on another: tested with a
reply on a private phone and a request at the public hall screen).

## Tools

All run as turns of the assistant on the asking device, through the gateway. Class `change` (they change what the house
does on that device) except the plain read. A result is one `spoken` line the model can pass on.

| Tool | Example phrase | Does | Says |
|---|---|---|---|
| `controls_stop_reply` | "could you stop talking" | stops the reply being prepared or spoken on this device, and an announcement being spoken there (`SessionControl.stopReply`). Not a ringing notification and not media: the host's spoken "stop" covers those | "Stopped." / "There was nothing to stop." |
| `controls_cancel_pending` | "forget it, cancel that" | cancels the reply being prepared or spoken and the open follow-up window, so the next sentence needs the wake phrase (`cancelPending`) | "Cancelled." / "There was nothing pending." |
| `controls_repeat_last` | "what was that again?" | speaks the device's last reply again, itself, as a canned reply (`repeatLast`); the description tells the model not to say it a second time | "Saying it again." / "I haven't said anything yet." |
| `controls_new_conversation` | "let's start from scratch" | a new conversation with the device's answering assistant (`newConversation`) | "Starting a new conversation." |
| `controls_set_volume` `{ level: 1–10 }` | "put the volume at seven" | sets the reply volume (replies, announcements and the page's cues; not music) | "Volume 4 of 5." / "The volume is already 4 of 5." |
| `controls_louder` | "a bit louder please" | one step up | "Louder: volume 5 of 5." / "That's as loud as I go." |
| `controls_quieter` | "turn it down a little" | one step down | "Quieter: volume 3 of 5." / "That's as quiet as I go." |
| `controls_get_volume` (plain read, `speculative`) | "how loud are you?" | reads the level | "The volume is 4 of 5." |

Every sentence is in English and Dutch ("Volume 4 van 5.", "Harder kan ik niet.", "Er was niets om te stoppen.").

## Phrase commands (actions)

Two actions run without the model after the wake phrase (or in a follow-up window). Both have `examples` in both
languages, are `change`, and are **not** also offered as generated tools (`offerAsTool: false`): the tools above do the
same.

| Action | English | Dutch |
|---|---|---|
| `new_conversation` (declared `endsReply`: the reply it cut off is not said again) | "new conversation", "start a new conversation", "start over", "new chat" | "nieuw gesprek", "start een nieuw gesprek", "begin opnieuw", "nieuwe chat" |
| `set_volume` (`{level}`: a number slot, whole number 1 to 10) | "volume seven", "volume to seven", "set volume to seven", "set the volume to seven" | "volume zeven", "volume op zeven", "zet volume op zeven", "zet het volume op zeven" |

**How a spoken number becomes a step.** The service has five steps (0.2 to 1 in steps of 0.2, loudest by default). A
person says a level from 1 to 10, as with most assistants, and **two levels share a step**: 1–2 is step 1 (the quietest),
3–4 step 2, 5–6 step 3, 7–8 step 4, 9–10 step 5 (the loudest). The answer always says the step it landed on ("Volume 4
of 5"), never the level said, so "volume eight" after "volume seven" is "The volume is already 4 of 5." and nothing is
sent. Said as digits or words, in both languages.

**At a limit.** A level outside 1 to 10, a fraction, "zero", or a word that is no number is **not this command**: the
phrase matcher reads a slot that does not parse as no match, so the sentence goes on to the assistant, whose tool
`controls_set_volume` refuses the level before it runs (its schema says 1 to 10). "Volume up" and "volume down" are the
host's louder and quieter. At the loudest or quietest step "louder"/"quieter" (tool) say "That's as loud as I go." /
"That's as quiet as I go." and change and send nothing.

Concurrency: the service makes each change in one step, and the module reads nothing before it writes: two devices asking
at once keep their own levels, and none is lost or applied twice (tested).

## Settings

None. There is nothing to configure: the phrases are fixed (the host's controls are not editable either), and the
volume steps belong to the service.

## What it stores

Nothing (no collection, no job, no notification, no secret). The volume is the server's memory (above).

## What it needs

`requires` nothing from the network or the machine. It uses the core services `SessionControl` and `DeviceControl`,
looked up at each use. **In the CLI modes they are absent**, and a stopped provider ends the same way: every control
answers "I can't do that here." / "Dat kan ik hier niet."; any other failure of a service call answers "That didn't work.
Try again in a moment." (the cause only in the log). The module runs on after either.

## What was left out

- **Switching the assistant, sleep and waking up, muting the microphone, `show_on`, hand-off, find my phone, speech
  rate**: the first versions of `SessionControl` and `DeviceControl` do not have them ([PHRASES.md](../PHRASES.md) "Not
  now": switching the assistant, sleep, microphone mute, device state). `show_on` also needs presentation (P10), which
  this stack does not have yet; hand-off and find my phone need a phone channel.
- **A "help" and "device status" tool, and a presentation of the volume**: presentation does not exist yet, and a spoken
  device status needs state the services do not expose (mute, sleep, the answering assistant).
- **The volume of media** (louder and quieter change the reply volume only: PHRASES.md "Louder and quieter").
- **Persisting the volume** across a restart: the service keeps it in memory; the module stores nothing.
- **A volume of 0 or "mute the replies"**: the service's quietest step is 0.2.

## Readings chosen where the contracts are open

- `controls_stop_reply` called **during the reply that is calling it** ends that reply (the service stops every
  conversation of the device). Its result is returned as usual, but the model's own reply may not be spoken; the
  description says it ends the reply. The host's spoken stop is the normal way and does not go through a turn.
- The tool's "stop" is **only the reply and the announcement** (`stopReply`); it does not stop a ring or media (the host's
  spoken "stop" does the ring, speech and media in order).
- `atLimit` on an absolute level means "that step is already set", and is said so ("already"), not as a bound.
