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
| `system_status` | `about?`: `all` (default), `modules`, `devices` | `{ spoken, fine, problems: [{ kind, state?, name?, reason? }], running, connectedDevices }`; "Everything is running: 12 modules. Connected devices: Kitchen display and Robin's phone." / "The key vault is locked, so modules that need a key are waiting for you to unlock it in Settings." |

Risk: read, speculative. At most three problems are named ("And two more."): the vault, the speech engines, modules that
stopped with an error, then those that are unavailable. Typed action: `system-status.status` ("how is the server doing",
"werkt alles").

**Privacy.** Module names and error text are about the house, not a person, but a hall screen is where visitors stand: on a
`public` device, on a device the host does not know, and when there is no device, the answer is only "Everything is
running." or "There is a problem. Check the settings page." (the asking device's privacy is read through `Devices` at
the moment of answering). Shared and private devices hear the details.

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
- **A `list` presentation of issues** and any spoken line outside a reply: wave B.
- **A new `HostModuleView.status` line**: the view has the state and the reason a module is unavailable, not the module's
  status line, so the reason is not spoken (it is in the result for the model).
