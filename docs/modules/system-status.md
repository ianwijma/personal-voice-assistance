# System status (`system-status`)

How the assistant itself is doing: its modules, engines and devices.

- Package: `packages/module-core-tools` (with `calculator`, `knowledge`)
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 3 (wave A)
- Research: [docs/research/modules/core-tools.md](../research/modules/core-tools.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Answers "how is the server doing" and "is everything working" from what the assistant already knows about itself: the
state of every module (running, switched off, stopped with an error, unavailable), whether the key vault is locked,
whether the speech engines are ready, and which devices are connected. It reads **only the host's own view**
(`ctx.host.view()`); it probes no network, reads no disk or load, runs no command, and stores nothing.

## Tools

| Tool | Parameters | Answers |
|---|---|---|
| `system_status` | `about?`: `all` (default), `modules`, `devices` | `{ spoken, fine, problems: [{ kind, state?, name? }], running, connectedDevices }`; "Everything is running: 12 modules. 2 devices are connected." / "The key vault is locked, so modules that need a key are waiting for you to unlock it in Settings." |

Risk: read, speculative. At most three problems are named ("And 2 more."): the vault, the speech engines (their state
said in the household's language: "starting", "stopped with an error" / "aan het opstarten", "gestopt met een fout"),
modules that stopped with an error, then those that are unavailable. A problem is its kind, state and module name only:
**no module's error text or reason is ever passed on** (it can hold an address, a key's fragment or a person's name).
Typed action: `system-status.status` ("how is the server doing", "werkt alles").

**Privacy.** Module names are about the house, not a person, but a hall screen is where visitors stand, and a device's
name is often someone's ("Robin's phone"). The asking device's privacy is read through `Devices` at the moment of
answering:

| Device | Hears |
|---|---|
| `public` (with or without a default person), a device the host does not know, no device, no `Devices` service | only "Everything is running." or "There is a problem. Check the settings page." (`{ spoken, fine }`) |
| `shared` | the problems by name (at most three), how many modules run, **how many** devices are connected |
| `private` | the same, and the connected devices' names (at most five) |

## On the screen

When the answer names problems to a device that may be told them, they come with a **transient `list`** (bullets, titled
"Problems as just answered" / "Problemen zoals net gemeld") for the screen: one item per problem the answer named (at most
three, worst first), then "And 3 more." / "En nog 3." when there are more. The items are the answer's own sentences
("Weather has stopped with an error."); the vault's is its short form ("The key vault is locked."), and a module's name is
cut to fit an item (80 characters) at a code point boundary, so no sentence is cut in the middle.

- **Returned with the answer, never shown from inside the tool.** The tool answers `{ forModel, present }` and the action
  `{ say, present }`, with `forModel` and `say` exactly what they were. The module shows and withdraws nothing itself and
  keeps no handle: a tool may run before its turn is committed, and the Presenter shows what a speculative tool returned
  only once the turn is promoted (a discarded turn shows nothing).
- **Only where the detailed answer may stay.** Whether a device is told details depends on its kind *when it is asked*; a
  list could later be in front of a device that became public. So the list is **personal to the person asking** (the
  turn's known person: the device's default person, the voice or the chosen speaker), and the Presenter decides it again
  for each device at each moment and withdraws it from one that no longer qualifies. With **no known person** there is no
  list at all (the answer is still spoken as before); a public device, an unknown device and no device are told only
  whether things are fine and get no list; `about: "devices"` and a house with no problems have none either. It carries no
  device name, no device count and never a module's error text or reason.
- **A snapshot.** The list is the problems as just answered: it is not updated when the house recovers within its 30
  seconds, and a later answer with nothing to show does **not** take it down. It ends by itself after 30 seconds, or when
  the next presentation on that device replaces it; a stopped module's lists are withdrawn with it. No live updating.
- No buttons and no handler. What a device that shows nothing is told to say is the problems' sentences joined (at most
  300 characters).

## Settings

None.

## What it stores

Nothing. **No personal content.**

## What it needs

Nothing outside the process. It is useful on the server; in the CLI modes the view has no devices, no vault state and no
engine, and it says only what it has.

## What was left out

- **The internet probe, disk space, load and memory, uptime** (research §5.5): "reads the host's own view only" (the lead's
  note); the view has no such members. The smallest change that would provide them is a `HostView.system` member
  (uptime, load, free disk) filled by the app.
- **Health issues with their fixes** (the research: "later it reads the issue registry"): the view does not carry the
  issue registry; adding `HostView.issues` would let it name the worst issue and its fix.
- **Any spoken line outside a reply** (a proactive announcement of a problem): not now.
- **`facts` and `table` presentations** (counts of modules and devices as a table): those kinds do not exist yet.
- **A module's status line or reason**: the view has the reason a module is unavailable, as free text from the host,
  which is neither spoken nor put in the result (see Privacy); naming the cause would need a short, safe reason code in
  `HostModuleView`.
