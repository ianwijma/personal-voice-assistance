# Reports (`report`)

Lets a person report a problem with the assistant or suggest a feature; the owner reads the report and sends it to the
project on GitHub.

- Package: `packages/module-report`
- How reports work, what they hold and the admin API: [docs/REPORTS.md](../REPORTS.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This module came with a core service (`Reports` in `packages/core/src/Reports.ts`, provided by serve mode), so its pull
request is an owner-approved exception to docs/MODULES.md §18: the module and the core change go together.

## What it does

The way in. A person says "report a problem: the timer didn't ring" or "I have a feature idea …", and the model calls
`report_file` with what the person said. The module passes that to the core's `Reports` service, which adds everything
the server knows about the conversation (the transcript with its tool calls, the previous conversation, the turn
traces, the device, the assistant, the server, its Health issues and recent warnings), keeps the report as a draft and
answers. The module itself gathers nothing and stores nothing.

Before it files, the model may ask **at most two short questions, one per turn**, when the report lacks what a
developer needs: for a problem, what the person expected and what they saw or heard instead (the screen is not
captured, so it asks what was on it when that matters); for a feature, what it should do and when they would use it. It
never invents details, keeps the person's own words in `description`, and does not repeat the conversation (it is
attached). The instructions say so; a fuller questionnaire for features is left for later.

## Tools

| Tool | Parameters | Answers | Risk |
|---|---|---|---|
| `report_file` | `kind` (`problem`, `feature`), `title` (one line, 3–120 characters), `description` (3–2,000), `answers?` (at most 4 of `{ question, answer }`) | `{ spoken }`: the draft is kept and where to find it, or it was sent with its issue number, or it was kept but sending failed | `change`; `message` while "Send at once" is on with a token |

What it says (English; Dutch alike):

| The host answers | Spoken |
|---|---|
| `draft` | "I've kept that report. The owner can read it and send it from the admin panel, under Reports." |
| `sent` with a number | "I've sent that report. It's issue 142." |
| `sent` without one | "I've sent that report." |
| `failed` | "I've kept that report, but sending it didn't work. The owner can send it from the admin panel, under Reports." |
| the host failed | "I couldn't keep that report just now. Please try again in a moment." |
| no `Reports` (the CLI modes) | "Reporting isn't available here." |

**Risk.** Drafting writes a local record: `change`. With "Send at once" on and a token set, a call posts a public issue
in the owner's name, which is the `message` class (docs/MODULES.md §4). A risk function decides on the input only, so
the class is chosen where the settings are known: `start` declares the tool `message` for an instance whose settings
send at once, and the module restarts with every settings change. By default the household's policy refuses `message`,
so with "Send at once" on the tool is **not offered** until the owner sets Shared settings › Risk policy › Message to
Run it. Nothing is weakened: the tool passes what it was declared as (`send` on the draft), and the host sends at once
only when that and its own copy of the setting agree, so the immediate send follows a call the gateway admitted as
`message`.

The host reads the turn itself (`CurrentTurn`) and gives `Reports` to this module alone (`moduleCoreServices`): no
other module can draft, or change the token or the switch.

**Sensitivity**: `household`. The answer names no personal content (a fixed sentence and an issue number). The report
itself holds the conversation, and stays with the owner until it is sent (docs/REPORTS.md "Privacy").

There is no typed action: a report's description is free text, which the intent path's `text` parameter cuts from the
sentence locally, and the questions before filing need the model. The LLM path only.

## Settings

| Setting | Default | What it does |
|---|---|---|
| GitHub token (secret) | none | A fine-grained personal access token with Issues: read and write on `ianwijma/personal-voice-assistance`, kept in the key vault. Without it reports are kept, and the admin page opens GitHub's new-issue page to file each one by hand. |
| Send at once | off | File a new report without waiting for the owner. It goes out as it is, in the owner's name, to a public repository, nobody reading it first: what the assistant said, tool results and the previous conversation included. The tool is then `message`. |

The shared part hands both to the host (`Reports.configure`) and takes them back when it closes, so the host uses the
token only while the module runs with it. A report kept while the module ran can still be read, edited, removed and
filed by hand after the module is switched off; sending it with the token needs the module on.

## What it stores

Nothing of its own. The host keeps the reports (docs/REPORTS.md "Storage").

## What it needs

`requires: [{ network: "internet" }]` for the GitHub API, only when a token is set; the host makes the request (the
module never fetches). `health`: "No GitHub token for reports" (information; a warning while "Send at once" is on).

## What was left out

- Screenshots: the person describes what they see (docs/REPORTS.md "Not in this version").
- A fuller feature questionnaire; a duplicate check against open issues; a "that was wrong" quick flag that drafts the
  last turn with no questions.
- A typed action (above).
