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
name ("run the bedtime routine") runs it through the tool `routines_run`. Either way:

1. **The whole routine is checked first, as the person and device that asked**, before anything runs. It is refused
   as a whole, with one sentence naming the step, when a `call` step names an action this assistant cannot do here
   (the module is off for it, the action is switched off, or the risk policy refuses every class the action can be),
   when the action needs a confirmation (confirmation is off in this stack), when whether it is allowed depends on its
   values (see "What was left out"), or when the step's values do not fit the action's parameters. The routine's own
   command must also be offered on that device.
2. **Then it runs in the module's shared part, one step after the other**, outside the turn that started it: the
   phrase command answers nothing itself (the routine speaks for itself), the tool answers "Starting Good night.".
3. **Every step is checked on its own when it comes.** A `call` runs through the execution gateway with
   `host.actions.run`, as a turn of the starting device (its assistant, its connection, its default person; `source:
   "routine"`), so admission, the assistant's switches, the risk function and the risk policy as saved at that moment
   decide it again. A `say` step first reads the action catalogue as that same turn and goes on only while the
   routine's own command is still offered there (the module on, the policy still allowing `change`, the device still
   the assistant's and its connection still its own). A step refused now (the policy changed, the device left) stops
   the routine there: "Good night stopped at step 2: that isn't allowed here any more, so I left out the rest." So a
   routine can do nothing the assistant could not.

**Steps** in this version:

| Step | JSON | What it does |
|---|---|---|
| `say` | `{ "say": "Sleep well." }` | An announcement on the device that started the routine (`ctx.speech`), after whatever is being said there. The run waits until it has been spoken (at most 2 minutes, `SAY_WAIT_MS`). |
| `call` | `{ "call": "lamp.switch", "params": { "to": "off" } }` | An action of the starting assistant's catalogue (`<moduleId>.<actionId>`), with fixed parameters in their tool input form (a choice by its value, a duration as a phrase such as `"10 minutes"`, a number, true or false). Its answer is spoken on the same device when the action declares it the household's; an answer that may be personal is kept back (below). |
| `stop_if_failed` | `{ "stop_if_failed": true }` | Stops the routine when the step before it did not work. Not the first step. |

A timer is started by a `call` of the timers module's action, like any other action (the routines module does not use
the `Timers` service itself).

**What the person hears while it runs**, besides the routine's own lines:

| What happened | What is said at the end |
|---|---|
| every step worked, and something was spoken | nothing more |
| every step worked, nothing was spoken (a lights-only routine) | "Dim is done." / "Dim is klaar." |
| a step failed (the action answered a failure, did not finish in 5 s, was not running), and no `stop_if_failed` after it | the rest still runs, then "Tidy is done, but I couldn't confirm step 1." (another module's failure sentence is never repeated: it may come from outside) |
| a step failed and the next is `stop_if_failed` | "Tidy stopped: I couldn't confirm step 1, so I left out the rest." |
| a step refused when it came | "… stopped at step 2: that isn't allowed here any more, so I left out the rest." |
| a `say` (or a spoken answer) stopped on the device: the spoken "stop", the page's Stop, a reply taking the speaker | the routine ends there; nothing more is said |
| a `call`'s answer that may be personal | "I don't read out the answer to step 1 in a routine: it may be personal." |

"I couldn't confirm" is the honest form for every failure: an action that timed out may have done part of its work.

**A second start of the same routine while it runs is refused**, it does not join: "Good night is already running."
(on any device; one run per routine at a time in the household). Different routines may run at once.

**A run that is interrupted does not resume in the middle.** When the module stops while a routine runs (a restart, a
settings save, which restarts the module, the server shutting down), the run's fiber is interrupted with the shared
part, and the device that started it is told, while the part is still closing: "Good night was cut short when the
routines module restarted; it had finished 1 of its 2 steps." or, during a `call`, "… during step 2, which may or may
not have been done." Nothing is stored about runs, so after a server restart nothing is resumed and nothing more is
said (a server that is going down may not get to say even that line); saying the phrase again runs the routine from
the beginning.

**Privacy.** The module stores nothing personal: routines are household configuration in settings, and the state of a
run (which step it is on) is in memory only. A `call` runs as the starting device's default person (or as nobody on a
device without one: no person is lent to it), and its answer is spoken only on that device. `host.actions.run` hands
the routine only `{ ok, say }`, with no owner, so an action whose answer is not declared the household's
(`sensitivity: "personal"` or decided per answer) is not read out by a routine (it still runs); see "What was left
out".

## Tools

| Tool or action | Parameters | Risk | Example | Answer |
|---|---|---|---|---|
| one action per routine, `routines.r_<name>` (not offered to the model as a tool) | none | `change` | "good night" (its phrases, in the household's language) | nothing when it starts (the routine speaks for itself); a refusal sentence otherwise: "I can't run Good night: step 2 is something this assistant can't do here." |
| `routines_run` | `name`: the routine's name as the person said it | `change` | "run the bedtime routine" | "Starting Bedtime."; "Which one: Good night or Good night kids?" when the name fits several; "I don't know a routine by that name." (never repeating the name); the same refusal sentences as the phrase |
| `routines_list` | none | `read` (speculative) | "what routines do I have?" | `{ count, routines: [{ name, phrases, steps, running? }] }`, phrases in the household's language; "There are no routines yet." |

A routine's action is a **phrase command** (docs/PHRASES.md): its phrases are words only (no slots), matched exactly
(case, accents and punctuation aside), in the household's language. It is declared `endsReply: true`: a routine
started over a reply replaces it. The action's examples are its phrases (or its name), for the intent agent.

`routines_run` matches the name on whole words with fillers dropped ("the", "my", "routine", "de", "het", "mijn",
"een", …): an exact name or phrase wins; otherwise a routine whose name holds every word said (or whose name's words are
all in what was said); more than one: it asks which.

Refusal sentences, before anything runs (English; Dutch in `src/texts.ts`):

- "I can't run Check: step 2 is something this assistant can't do here." (unknown action, module off for the assistant,
  switched off, or every class refused by the policy, e.g. a `security` step)
- "I can't run Check: step 2 needs a confirmation I can't ask for yet."
- "I can't run Check: whether step 2 is allowed depends on its values, which I can't check before it runs."
- "I can't run Check: the values in step 2 don't fit that action."
- "I can't run Check here." (the routine's own command is switched off for the assistant, or otherwise not offered
  there), and "I can only run a routine from a device." (the CLI modes, which have no device; in serve mode the
  gateway refuses a turn without a device before the tool runs).

Every sentence the module speaks fits a phrase command's spoken answer (300 characters) whole with the longest name
(a test fills each one at its worst).

## Settings

| Field | Kind | What |
|---|---|---|
| Routines | `records`, at most **16** (`MAX_ROUTINES`), orderable | Each: **Name** (one line, 1 to 40 characters), **English phrases** and **Dutch phrases** (text lists, at most 8 each, 80 characters each), **Steps (JSON)** (multiline text, at most 2,000 characters). |
| Good morning routine | boolean, default off | Adds the template below. |

**Why 16**: each routine with phrases is one action with phrases, and an instance may have at most 16
(`PHRASE_LIMITS.actionsPerModule`); 8 phrases per language is the host's bound for one action. So the module adds at
most 128 phrases per language to an assistant's set (the set's bound is 256 across all its modules; past it, the modules
that do not fit are left out whole and named on the Health page, docs/PHRASES.md).

**A save is refused, with a sentence under the field, when** (the same checks the host makes when the module starts, so
a saved list always starts):

- more than 16 routines: "At most 16 routines"; more than 8 phrases: "Routine 1, English phrases: At most 8 items";
- a name is empty, or two routines have the same name (case, accents and punctuation do not count):
  `Two routines are called "Café"; give each its own name`;
- a phrase is one of the host's own controls: `Routine "Hush", English phrase "be quiet": it is one of the
  assistant's own "stop" phrases, which no module may use` (the host's reserved phrases, docs/PHRASES.md);
- a phrase is in two routines, or twice in one in another spelling: `The English phrase "Movie time!" is in "A" and
  "B"; a phrase starts one routine` / `Routine "A" has the English phrase "Movie, time" twice` (the host would leave
  both out of the set);
- a phrase the host would refuse otherwise (a `{slot}`, more than 8 words, over 80 characters), with the host's reason;
- the steps are not valid: not JSON, not a list of 1 to 20, a step without exactly one of `say`, `call`,
  `stop_if_failed`, a key it does not use, a `say` that is not one line of 1 to 300 characters, a `call` not written
  `module.action` or with more than 8 parameters or a value that is not one line of text (≤ 200), a number or true or
  false, `stop_if_failed` first, or a `call` of a routine ("a routine does not start other routines"). The sentence
  names the routine and the step, never quoting the value.

A phrase that another module also has is not known when saving: the host leaves both out of that assistant's set and
names them on the Health page (docs/PHRASES.md).

**The Good morning template.** Switched on, it adds the routine "Good morning" ("Goedemorgen" in a Dutch household),
phrases "good morning" / "goedemorgen", with these steps (copy them into a routine of your own to change it):

```json
[{ "say": "Good morning!" }, { "call": "clock.time_now" }, { "call": "weather.today" }]
```

(its greeting is "Goedemorgen!" in a Dutch household). It is left out while 16 routines of the owner's are set or one
of them has its name or one of its phrases (the owner's own wins). Like every routine it is refused as a whole when the
clock or the weather module is not on for the assistant.

## What it stores

Nothing in the household store: no collections, no jobs. The routines are settings (backed up with the configuration);
the state of a run is one in-memory record per running routine in the shared part, gone when the module stops.

## What it needs

- `requires`: nothing outside the process (no network, no program), so no `health`.
- `uses`: no module. It uses the host's `host.actions.list` and `host.actions.run` (the action catalogue, through the
  gateway), `ctx.speech` (announcements), and the modules the steps call, looked up live through the catalogue.
- Provides no service or contribution.
- Latency: the check before a run reads the in-memory catalogue once and looks at at most 20 steps; the phrase command
  answers within that (no store, no network). Steps run outside the turn.

## What was left out

Left out by the plan's row: `wait`, steps that need confirmation, time, event, hook and presence triggers, drafts by
voice, history (no run is recorded), the n8n and Home Assistant script bridge (§2 row 2).

Left out because the preparation parts' first versions do not have it:

- A `progress` presentation while a routine runs (research §8): not in the row; the five kinds of docs/PRESENTING.md
  have no progress item.
- Announcing to another device or room than the one that started the routine (research `runOn`): not in the row.

Left out because something is missing below (each with the smallest change that would provide it):

- **The policy check at save time.** A settings `check` is a plain function of the value, with no host, and outside a
  turn or a job the action catalogue lists nothing in serve mode, so a routine that the policy or the assistant would
  refuse is accepted when it is saved and refused (as a whole, before anything runs) when it is started. Smallest
  change: `ActionCatalogue.listFor(assistantId)` (the catalogue as one assistant's turns see it, callable from a
  module's own part), and a way for the form to show a running instance's verdict (the module's `info()` could then
  say "Bedtime: step 3 is refused for Jeff").
- **Asking whether one particular call would be refused.** `host.actions.list` answers per action, not per call:
  for an action whose class depends on its values (`risk: { classes, of }`, a cover that is `change` or `security`),
  being listed does not say whether these values are allowed, and its parameters' options and bounds are not described
  (only names, kinds and whether optional). Such a step is refused as a whole ("whether step 2 is allowed depends on
  its values"), and a value outside an option list fails when the step runs (it is "not confirmed"). Smallest change:
  `ActionCatalogue.check(request): Effect<ActionRunResult-like>`: the gateway's admission, value check, risk function
  and `decideRisk` on the policy now, as the caller's principal, without running the action.
- **The owner of an action's answer.** `ActionRunResult` is `{ ok, say }`: the action's `sensitivity` (an owner) is
  not passed on, so a routine cannot ask `Privacy.mayReveal` before reading an answer out, and keeps back every answer
  not declared the household's. Smallest change: `ActionRunResult` carries the result's sensitivity (`household`, or
  `personal` with its owner), as already reported for briefing.

Contract readings (the most conservative one each time):

- A step runs as a **turn of the starting device** with `source: "routine"` (the start's turn id, conversation id and
  connection), not as a job: so the gateway checks at every step that the device still has the assistant, that the
  connection is still the device's and that the person is still its default person.
- A `say` step is not a gateway call; its own check is that the routine's command is still offered to that turn.
- Being listed by `host.actions.list` is read as "the policy allows it" only for an action with one class.
