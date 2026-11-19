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

When the answer names problems, they are also shown as a **transient `list`** (bullets, titled "Problems" / "Problemen")
on the screen of the device that asked, for the tool and for the typed action: one item per problem the answer named
(at most three, worst first), then "And 3 more." / "En nog 3." when there are more. The items are the answer's own
sentences ("Weather has stopped with an error.", "The speech engines are stopped with an error."); the vault's is its short
form ("The key vault is locked."), and a module's name is cut to fit an item (80 characters) at a code point boundary, so
no sentence is cut in the middle.

- **Shows what that device was told, nothing more.** The list is built from the same view and the same detail decision
  as the answer (`public`, unknown or no device: none): a public device, a device the host does not know and a turn with
  no device are shown **no list at all** (they are told only whether things are fine); a shared and a private device
  get the same list, which carries no device name, no count of devices and never a module's error text or reason.
  A question about the devices only (`about: "devices"`) names no problem, so it shows none.
- **Follows the answer.** It is a transient: it ends by itself after 30 seconds, a newer list on that device replaces
  it, and an answer with no problem to show (everything fine, devices only, a public device's) takes the earlier list of
  that device down. The newest handle of each asking device is kept in memory; a restart forgets them and a stopped
  module's lists are withdrawn with it. A device without a display, or no Presenter (the CLI modes), changes nothing
  about the answer.
- No buttons and no handler. What a device that shows nothing is told to say is the problems' sentences joined (at
  most 300 characters).

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
