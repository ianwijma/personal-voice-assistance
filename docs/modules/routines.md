# Routines (`routines`)

Routines and quick commands the owner defines, started by a phrase.

- Package: `packages/module-routines`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 21 (wave B)
- Research: [docs/research/modules/routines-and-automations.md](../research/modules/routines-and-automations.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

The owner writes routines in the module's settings: a name, the phrases that start it, and its steps. Saying one of
its phrases after the wake phrase ("hey Jeff, good night") runs it with no model call; asking the assistant for it by
name ("run the bedtime routine") runs it through the tool `routines_run`.

**A routine is not all-or-nothing.** It is a list of steps run one after the other, each decided when it comes:

1. **Before it starts, what the action catalogue can tell is checked**, as the person and device that asked: the
   routine's own command (and, if it has a `say` step, the module's line action) is offered there, and every `call`
   names an action that exists, is offered to that assistant on that device (its module on, the action not switched
   off, not every class it can be refused by the risk policy), needs no confirmation, and whose parameters the step's
   values fit by name and kind. If not, the routine is refused as a whole, before anything runs, with one sentence
   naming the step: "I can't run Good night: step 2 is something this assistant can't do here." This check is a
   courtesy, not a guarantee: the catalogue cannot say whether one particular call would be refused (an action whose
   class depends on its values, a choice value it does not have, a number outside its bounds, a duration that does not
   read), and the policy may change while a routine runs.
2. **Then it runs in the module's shared part, outside the turn that started it**: the phrase command answers nothing
   itself (the routine speaks for itself); the tool answers "Starting Good night." If cancellation won while the
   initial catalogue lookup was pending, the start instead answers that the routine was stopped, and no step runs.
3. **Before each `call` or `say`, the live catalogue is checked again** as the starting assistant: the routine's own
   command must still be offered, and a call's parameter names and kinds must still fit the registered action. A
   withdrawal or a mismatch stops there; an action already under way finishes. Every dispatched step is then a gateway
   call as a turn of the starting device (its assistant, its connection, its default person; `source: "routine"`):
   admission, the assistant's switches, the risk function and the risk policy as saved at that moment decide it. A
   `call` is `host.actions.run` of the action named; a `say` is `host.actions.run` of the module's own line action
   (below). `stop_if_failed` is local control, with no gateway call.
4. **A step that is refused, or whose values do not fit, ends the run there**, and the routine says so in one true
   sentence, with what was already done: "Good night stopped at step 3: I'm not allowed to do that. Steps 1 and 2 are
   done." / "… stopped at step 2: its values don't fit that action. Step 1 is done." A run that stopped never says it
   "is done". Steps before it are not undone.

**Steps** in this version:

| Step | JSON | What it does |
|---|---|---|
| `say` | `{ "say": "Sleep well." }` | One line (the owner's text, at most 300 characters) on the device that started the routine, after whatever is being said there. The run waits until it has been spoken, at most 2 minutes (`SAY_WAIT_MS`); past that the run requests a stop and waits for the handle's terminal outcome before advancing, and the step counts as not confirmed. The host handoff limit below applies. |
| `call` | `{ "call": "lamp.switch", "params": { "to": "off" } }` | An action of the starting assistant's catalogue (`<moduleId>.<actionId>`), with fixed parameters in their tool input form (a choice by its value, a duration as a phrase such as `"10 minutes"`, a number, true or false). **The action's answer is never read out** (below). |
| `stop_if_failed` | `{ "stop_if_failed": true }` | Stops the routine when the step before it did not work. Not the first step. After a `call` it is about whether the action ran and succeeded, not about anything being spoken (nothing of a called action's answer is). |

**Answers of called actions are not read out.** `host.actions.run` gives the routine `{ ok, say }`: the answer does
not say whose content it is, and a classification read before the call could be stale by the time it answers (the
other module may have restarted with other settings). So a `call` step is done or it failed, and that is all the
routine says about it; what a routine says, it says in its `say` steps.

**The line action.** `routines.line` (parameters: the run and the step) has no phrases (it is not one of the 16) and is
not a tool of the model; risk `change`. It enqueues the current step's line of a run on the device that run belongs
to, for a turn of that device with `source: "routine"`, and returns; it speaks no text it is given, and refuses
anything else ("That line belongs to no routine running here."). The run keeps the line's handle and waits for it
outside the turn. Each run/step is claimed once before enqueueing; redelivering that internal line request keeps the
original handle and enqueues nothing else. A failed or timed-out line action revokes that step's claim, waits for
any pending enqueue to settle, and requests a stop and waits for its handle's terminal outcome before the run advances
or releases its reservation. A later delivery cannot enqueue the revoked step. Every dispatched `say` reaches the
gateway, and a policy that refuses `change` refuses it.

**Speech handoff limit.** The module waits for `stop` and the handle's terminal outcome, but the host can report an
item stopped before its playback fiber has ended and can miss an item between its queue and that fiber. A line that
was already handed to the device may still be spoken once, even after a cancellation or timeout has answered. No
later step starts after cancellation. Preventing that last playback requires the host change listed below.

**What the person hears**, besides the routine's own lines:

| What happened | What is said |
|---|---|
| every step worked, and a line was spoken | nothing more |
| every step worked, nothing was spoken (a lights-only routine) | "Dim is done." / "Dim is klaar." |
| a step failed (the action answered a failure, interrupted itself, did not finish in 5 s, was not running, or a line was not spoken), and no `stop_if_failed` after it | the rest still runs, then "Tidy is done, but I couldn't confirm step 1." (another module's failure sentence is never repeated: it may come from outside; "couldn't confirm", because an action that timed out may have done part of its work) |
| a step failed and the next is `stop_if_failed` | "Tidy stopped: I couldn't confirm step 2, so I left out the rest. Step 1 is done." |
| a step refused by the gateway when it came (the policy, the assistant's switches, the device or its default person changed; a class the values make `security`) | "Good night stopped at step 3: I'm not allowed to do that. Steps 1 and 2 are done." |
| a step whose values do not fit the action | "Check stopped at step 2: its values don't fit that action. Step 1 is done." |
| the routine's line stopped on the device (the spoken "stop", the page's Stop, a reply taking the speaker) | the routine ends there; nothing more is said |
| cancelled (below) | only the cancel's own answer |
| the module stopped, including a restart or disable (below) | the module-stop sentence |

When steps before the stop were not all done, the sentence says which were and which could not be confirmed ("Step 1
is done. I couldn't confirm step 2."). If none is confirmed but some are unconfirmed, it says only which could not
be confirmed; it does not claim nothing was done. Every such sentence fits an announcement (300 characters) whole with
20 steps and the longest name in the four representative done/unconfirmed partitions covered by the tests.

**What counts as done.** Completion, refusal, cancellation and module-stop reports use the same record of completed
steps. A `call` enters it only after the gateway answers that the action succeeded; a `say` also waits for confirmed
playback. Refusal, withdrawal, failure, and cancellation before that answer leave the step out. `stop_if_failed` is
local control and does not add a completed action. An unconfirmed step may still have had an effect; it is never
counted as confirmed done.

**One at a time.** A second start of the same routine while it runs is refused, it does not join: "Good night is
already running." (on any device). A start of another routine on a device that is already running one is refused too:
"Good night is still running here." Different routines run at once on different devices.

**A phrase heard once starts once.** A start whose turn came in as a phrase command is remembered (in the shared part,
by assistant, conversation, turn, device and routine, reserved before anything waits; the newest 64 finished ones,
and every unfinished one): the same phrase turn again gets the first start's answer and runs nothing. Finished
answers are retained in completion order; pending starts consume none of those 64 slots. The shared runner owns the
reservation, cleanup and replay answer once the request is handed to it: interruption of the requesting turn does not
cancel that work or erase an accepted start's answer. Use the module's cancellation command to cancel it. A call by the
model (`routines_run`) runs every time; while the routine runs it is refused as above.

**Stopping a routine.**

- **"cancel the routine"** ("annuleer de routine"), a phrase command of the module, or the tool **`routines_stop`**,
  ends the routine running on the asking device: no further step starts, and the run requests a stop for its current
  line (playing or still waiting). If the line is still being enqueued, cancellation waits for its handle or an enqueue
  failure, requests a stop and waits for the handle's terminal outcome before answering. The speech handoff limit
  above still permits one late playback; the routine queues no more lines. The shared runner owns this cleanup even
  if the caller of cancellation is interrupted. The answer says how far it got: "I stopped Queued; it had
  finished 0 of its 2 steps." or, while an action is under way, "I stopped Slowly during step 2; that step may still
  complete." (the action is not cut off in the middle). "No routine is running here." when there is none or a closing
  report is already committed; a run cannot both acknowledge cancellation and announce completion. The closing
  decision and its acceptance by the speech queue are protected together from interruption, including for refusal
  reports; a module restart waits for that acceptance, without waiting for playback. The routine can
  be started again once the action under way has finished. Phrase cancellation outcomes are remembered by assistant,
  conversation, turn, device and command (the newest 64, including pending cleanup), checked before selecting a run:
  a replay waits for the first cancellation to finish cleanup, returns its answer and cancels nothing else.
  Model calls cancel anew each time. The cancel action has `endsReply: true`, so cancelling over "Starting Bedtime."
  does not repeat that start reply after the acknowledgement.
- **The host's "stop"** stops what the device is saying. When that is the routine's own line, the routine ends there.
  **The host gives a module no signal for a "stop" said while an action of the routine runs** (or while nothing of the
  routine is being said), so that "stop" does not stop the routine: it goes on with its next step. Use "cancel the
  routine". (A test holds this limit as stated; see "What was left out".)

**A run that is interrupted does not resume in the middle.** A provider action interrupting itself is an unconfirmed
step, following the ordinary failure and `stop_if_failed` rules above; it is not a module stop. A line action withdrawn
while the routines module is stopping follows module-stop cleanup even if the gateway returns `failed`. When the module stops
while a routine runs (a disable, a restart, a settings save, which restarts the module, the server shutting down), the
run's fiber is interrupted with the shared part: it requests a stop for its line and waits for the handle's terminal
outcome (subject to the speech handoff limit above), and only then the device is told, while the part is still closing:
"Good night was cut short when the routines module stopped; it had finished 1 of its 2 steps." or, during a `call`, "… during step 2, which may or may not have been done." Nothing is stored
about runs, so after a server restart nothing is resumed and nothing more is said (a server that is going down may not
get to say even that line); saying the phrase again runs the routine from the beginning.

**How a run is recorded.** A dispatched `call` or `say` that reaches the gateway's risk evaluation produces an
`onDecision` callback, with the turn id of the start; the kit retains these in `riskDecisions()`. Local
`stop_if_failed` steps, local catalogue/value refusals and gateway refusals before risk evaluation produce no such
callback. Serve mode's policy log keeps only refusals whose turn id is absent, so it does not retain these routines'
step callbacks, including policy refusals carrying the starting turn id. The starting turn's execution trace ends
with the start (a phrase command's trace, or the model turn's): the run does not keep it open, and no step writes into
it. A step that runs after its turn has ended has no execution trace of its own: the host offers a module no way to
open and publish one (see "What was left out").

**Privacy.** The module stores nothing personal: routines are household configuration in settings, and the state of a
run (which step it is on) is in memory only. A `call` runs as the starting device's default person (or as nobody on a
device without one: no person is lent to it), and nothing of its answer is spoken anywhere. The routine's own lines
are the owner's household text, spoken on the starting device.

## Tools

| Tool or action | Parameters | Risk | Example | Answer |
|---|---|---|---|---|
| one action per routine, `routines.r_<name>` (not offered to the model as a tool) | none | `change` | "good night" (its phrases, in the household's language) | nothing when it starts (the routine speaks for itself); a refusal sentence otherwise |
| `routines.stop`, offered to the model as **`routines_stop`** | none | `change` | "cancel the routine" / "annuleer de routine" | "I stopped Good night; it had finished 1 of its 2 steps."; "I stopped Slowly during step 2; that step may still complete."; "No routine is running here." |
| `routines.line` (internal: not a tool, no phrases) | `run`, `step` | `change` | a running routine's `say` step | nothing; "That line belongs to no routine running here." to anything else |
| `routines_run` | `name`: the routine's name as the person said it | `change` | "run the bedtime routine" | "Starting Bedtime."; "Which one: Good night or Good night kids?" when the name fits several; "I don't know a routine by that name." (never repeating the name); the same refusal sentences as the phrase |
| `routines_list` | none | `read` (speculative) | "what routines do I have?" | `{ count, omitted, routines: [{ name, phrases, omittedPhrases, steps, running? }] }`, at most three complete entries and two phrase examples each, in the household's language; "There are no routines yet." |

A routine's action is a **phrase command** (docs/PHRASES.md): its phrases are words only (no slots), matched exactly
(case, accents and punctuation aside), in the household's language. It is declared `endsReply: true`: a routine
started over a reply replaces it. Its examples are its phrases (or its name), for the intent agent.

`routines_list` returns the total routine count, the first three entries in settings order, and the number of omitted
routines (`omitted`). Each entry includes up to two complete phrase examples and the number of other phrases in that
language (`omittedPhrases`); neither names nor phrase examples are cut mid-entry.

A routine's action ID is derived only from its normalized name, with a stable hash suffix when the ASCII slug loses
characters or is truncated. It stays within 40 characters. An existing assistant `offTools` setting follows that ID
across reordering, additions and removals. Renaming to an unused normalized name gives it a new ID, which defaults on;
renaming back restores the original ID and its existing setting. Case, accent or punctuation changes that keep the
normalized name do not change its ID. The assistant editor currently lists and validates only the published tools
(`routines_run`, `routines_list`, `routines_stop`), so it cannot save a per-routine switch. The host needs a list of
configurable action IDs, including phrase actions that are not model tools, for the editor to set these switches.

`routines_run` finds a routine in this order, asking which when more than one fits at a level: a saved name exactly as
said (its words: case, accents and punctuation do not count; so a routine named "A", "The", "My routine", "De",
"Het" or "Mijn routine" is found); one of its phrases exactly; the same with filler words dropped ("the", "my",
"routine", "one", "de", "het", "mijn", "een", …: "the bedtime routine" is "Bedtime", and "the evening one" can
select "Evening lights"); a routine whose name holds every word said, or whose name's words are all in what was said.
Clarification names at most three complete routines; when more match, it gives the remaining count and asks for a
more specific name, within 300 characters even at 15 names of 40 characters each.

Refusal sentences before anything runs (English; Dutch in `src/texts.ts`): "I can't run Check: step 2 is something
this assistant can't do here." (unknown action, module off for the assistant, switched off, or every class refused by
the policy, e.g. a `security` step); "… step 2 needs a confirmation I can't ask for yet."; "… the values in step 2
don't fit that action." (a value of the wrong kind, or a required one missing); "I can't run Check here." (the
routine's own command, or the line action, is not offered there); "I can only run a routine from a device." (the CLI
modes, which have no device; in serve mode the gateway refuses a turn without a device before the tool runs).

Every sentence a routine's start, cancel and refusal can say fits a phrase command's spoken answer (300 characters,
`PHRASE_ANSWER_CHARS`) whole; the text-budget test fills their placeholders with maximum-length names and bounded counts.

## Settings

| Field | Kind | What |
|---|---|---|
| Routines | `records`, at most **15** (`MAX_ROUTINES`), orderable | Each: **Name** (one line, 1 to 40 characters), **English phrases** and **Dutch phrases** (text lists, at most 8 each, 80 characters each), **Steps (JSON)** (multiline text, at most 2,000 characters, 1 to 20 steps). |
| Good morning routine | boolean, default off | Adds the template below. |

**Why 15**: each routine with phrases is one action with phrases; an instance may have at most 16
(`PHRASE_LIMITS.actionsPerModule`), and one is the module's own "cancel the routine". 8 phrases per language is the
host's bound for one action. So the module adds at most 121 phrases per language to an assistant's set (the set's bound
is 256 across all its modules; past it, the modules that do not fit are left out whole and named on the Health page,
docs/PHRASES.md).

**A save is refused, with a sentence under the field, when** (the same checks the host makes when the module starts, so
a saved list always starts):

- more than 15 routines: "At most 15 routines"; more than 8 phrases: "Routine 1, English phrases: At most 8 items";
- a name is empty, or two routines have the same name (case, accents and punctuation do not count):
  `Two routines are called "Café"; give each its own name`;
- a phrase is one of the host's own controls: `Routine "Hush", English phrase "be quiet": it is one of the
  assistant's own "stop" phrases, which no module may use` (the host's reserved phrases, docs/PHRASES.md);
- a phrase is the module's own "cancel the routine" / "annuleer de routine": `… it is the phrase that cancels a
  running routine`;
- a phrase is in two routines, or twice in one in another spelling: `The English phrase "Movie time!" is in "A" and
  "B"; a phrase starts one routine` / `Routine "A" has the English phrase "Movie, time" twice` (the host would leave
  both out of the set);
- a phrase the host would refuse otherwise (a `{slot}`, more than 8 words, over 80 characters), with the host's reason;
- the steps are not valid: not JSON, not a list of 1 to 20, a step without exactly one of `say`, `call`,
  `stop_if_failed`, a key it does not use, a `say` that is not one line of 1 to 300 characters, a `call` not written
  `module.action` with module ID `[a-z][a-z0-9-]{0,39}`, action ID `[a-z][a-z0-9_]{0,39}` and at most 64
  characters combined (including the dot), a parameter name outside a letter followed by letters, digits or `_`
  (at most 40 characters),
  more than 8 parameters on the submitted object, or a value that is not one line of text (≤ 200), a number or true or
  false, `stop_if_failed` first, or a `call` of a routine ("a routine does not start other routines"). The sentence
  names the routine and the step, never quoting the value.

Not known when saving (see "What was left out"): whether the policy or the assistant allows a step, a phrase that
another module also has (the host leaves both out of that assistant's set and names them on the Health page).

**The Good morning template.** Switched on, it adds the routine "Good morning" ("Goedemorgen" in a Dutch household),
phrases "good morning" / "goedemorgen", with one step, a greeting to build on (copy it into a routine of your own and
add `call` steps for your lights and the like):

```json
[{ "say": "Good morning! Have a good day." }]
```

(its greeting is "Goedemorgen! Een fijne dag." in a Dutch household). It is left out while 15 routines of the owner's
are set or one of them has its name or one of its phrases (the owner's own wins).

## What it stores

Nothing in the household store: no collections, no jobs. The routines are settings (backed up with the configuration);
the state of a run is one in-memory record per running routine in the shared part. Phrase starts (at most 64 finished
ones, plus unfinished ones) and phrase cancellation outcomes (at most 64) are in memory too; all are gone when the
module stops.

## What it needs

- `requires`: nothing outside the process (no network, no program), so no `health`.
- `uses`: no module. It uses the host's `host.actions.list` and `host.actions.run` (the action catalogue, through the
  gateway), `ctx.speech` (lines, from its own line action), and the modules the steps call, looked up live through the
  catalogue.
- Provides no service or contribution.
- Latency: the check before a run reads the in-memory catalogue once and looks at at most 20 steps; the phrase command
  answers within that (no store, no network). Steps run outside the turn.

## What was left out

Left out by the plan's row: `wait`, steps that need confirmation, time, event, hook and presence triggers, drafts by
voice, history (no run is recorded), the n8n and Home Assistant script bridge (§2 row 2). Announcing on another device
or in another room is outside the row (`ctx.speech` could do it).

Left out because the preparation parts' first versions do not have it: a `progress` presentation while a routine runs
(the five kinds of docs/PRESENTING.md have none).

Missing below (each with the smallest change that would provide it):

- **Checking a call without running it.** The catalogue answers per action, not per call, and describes a parameter
  only by name, kind and whether it is optional; so a routine cannot be refused as a whole for a step the gateway
  would refuse for its values, and it is checked step by step instead. Smallest change:
  `ActionCatalogue.check(request)`: the gateway's admission, value check, risk function and `decideRisk` on the policy
  now, as the caller's principal, without running the action. The module's live parameter check is separate from
  dispatch; rejecting unknown keys in the host's action decoder against the exact definition it executes would make
  that check atomic across a provider restart.
- **The catalogue outside a turn, for a check at save time.** A settings `check` is a plain function of the value, and
  outside a turn or a job `host.actions.list` lists nothing in serve mode; so a routine that the policy or the assistant
  would refuse is accepted when it is saved. Smallest change: `ActionCatalogue.listFor(assistantId)` callable from a
  module's own part, and a save hook that can refuse on its verdict (or, short of refusing, an `info()` warning).
- **Configurable phrase-action IDs in the assistant editor.** Its tool list and save validator exclude actions with
  `offerAsTool: false`, so an owner cannot set a per-routine switch there. Smallest change: a host list of configurable
  action IDs that the editor and validator both use, while keeping phrase-only actions out of the model's tools.
- **Whose content an action's answer is.** `ActionRunResult` is `{ ok, say }`; so a routine reads out no answer at
  all. Smallest change: `ActionRunResult` carries the result's sensitivity (`household`, or `personal` with its owner)
  for the execution that ran, so the routine can ask `Privacy.mayReveal` for its device.
- **A terminal speech stop across the device handoff.** A line already handed to the device may still be spoken once
  after cancellation or timeout has answered, because the host can lose sight of an item between its queue and current
  playback, and can mark it stopped before the playback fiber ends. Smallest change: keep the item cancellable across
  that transition in `NotifyEngine`, and make the handle's stop/outcome wait until playback can no longer start.
- **A device's "stop" delivered to the module running something for it.** The host's "stop" reaches the speech service
  and the reply, not a module; so a "stop" said while a routine's action runs does not stop the routine. Smallest
  change: a subscription (or a callback registered with the run) through which the host tells a module that the person
  said "stop" on a device it is running something for.
- **A trace for background executions.** A dispatched step that reaches risk evaluation after its turn has ended
  gets a gateway callback but no execution trace, and serve mode's policy log excludes its callback because it carries
  a turn id; the module cannot open and publish a trace. Smallest change: a host-owned way to open an execution
  trace for a background step (its principal, its calls, its outcome and duration) and publish it where turn and phrase
  traces go.

Contract readings (the most conservative one each time):

- A step runs as a **turn of the starting device** with `source: "routine"` (the start's turn id, conversation id and
  connection), not as a job: so the gateway checks at every step that the device still has the assistant, that the
  connection is still the device's and that the person is still its default person.
- Being listed by `host.actions.list` says only what it says: the module is on, the action not switched off, and not
  every class it can be is refused. Each call is decided by the gateway when it runs.
