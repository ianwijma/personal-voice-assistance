# Notifications (`notifications`)

Reads and dismisses notifications, and do not disturb by voice.

- Package: `packages/module-notifications`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 6 (wave B)
- Research: [docs/research/modules/notifications.md](../research/modules/notifications.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

## What it does

The spoken side of the notification service ([NOTIFICATIONS.md](../NOTIFICATIONS.md)). It is off by default.

- **Read out what is open for this device**, dismiss one, send a test.
- **Do not disturb by voice**: on, on for a length of time, on until a time, off, and "is it on". Do not disturb is the
  service's, for the **whole house** (there is no per-device one in the first version); every answer says so.
- **One inbound hook** on a module route, so a script on the home network (Home Assistant, n8n) can show a card.

**What "open for this device" covers, and why it is narrower than it sounds.** `ctx.notify.list` gives a module only its
*own* open notifications (docs/NOTIFICATIONS.md "The calls"). So the list covers what was sent through this module (the
hook and the test), not timers' or reminders' notifications, and **every answer says so** (`covers`, and the
"nothing" sentence names it). Of those it tells a device only what is for it (sent to every device, or to that device)
and, for a personal one, only where `Privacy.mayReveal(owner, device)` says so *now*, asked after the last read and again
right before a dismissal. Nothing this module sends is personal today (the hook and the test are household content);
the rule is built and tested for when the service gives a module more.

## Tools

Each tool has the same behaviour as its action where it has one; actions are not offered to the model as tools (their
tools below are the model's way in). All answers are in the household's language (English and Dutch).

| Tool | Risk | Does | Example |
|---|---|---|---|
| `notifications_open` | read | the open ones for this device (at most 5 titles and "and N more", a count of personal ones not read out here, and that the read was cut when it was); titles are marked as untrusted outside text | "which notifications are open?" |
| `notifications_dismiss` `{ which? }` | change | one open notification of this module on this device, by words of its title; without a name the only open one; **asks which** when several fit, never the first; "I don't know a notification called …"; "That one was already gone." when it ended meanwhile | "dismiss the washer one" |
| `notifications_dnd_on` `{ for?, until? }` | change | do not disturb for the house: until turned off, `for` a length in words ("two hours"), or `until` a time in words ("eight", "tomorrow at seven"); at most 7 days; both is refused; an unclear or ambiguous time is a question | "do not disturb until eight" |
| `notifications_dnd_off` | change | off; says so only when the service then reads off | "do not disturb off" |
| `notifications_dnd_status` | read | on (until when) or off; a failed read says it could not read, never "off" | "is do not disturb on?" |
| `notifications_send_test` | change | a `normal` test card to this device (key `test`: a second one says it is already open; it expires after 10 minutes) | "send a test notification" |

**Phrase commands** (run without the language model after the wake phrase; actions `notifications.<id>`):
`dnd_on` ("do not disturb", "niet storen"), `dnd_for` (**a duration slot**: "do not disturb for ten minutes", "niet storen
voor een uur"; a duration over seven days is not a slot, so it goes on to the assistant), `dnd_off` ("do not disturb off",
"niet storen uit"), `dnd_status` ("is do not disturb on"), `send_test` ("send a test notification"), `open` ("which
notifications are open"), `dismiss` ("dismiss the notification", "dismiss {which}": the name is **text** and is resolved in
the action, with its own "I don't know a notification called …"). "Until a time" is a tool only: the phrase slots are a
duration (the brief's first version); a time is taken as words by the tool.

## The hook

`POST /api/modules/notifications/notify`, JSON `{ "title": "Washer done", "text": "optional", "key": "optional" }`, header
`X-PVA-Token: <the token>`.

- **Both are needed**: the request must come from the home network (the route's `lan` guard; with `SERVE_BEHIND_PROXY`
  the guard refuses everyone, so the hook is unreachable by design) **and** carry the hook token, a secret setting. The
  token is compared in constant time (both sides hashed with SHA-256, then `timingSafeEqual`, so length shows nothing).
  No token set: every call answers 503 `not-set-up`. A missing and a wrong token answer the same 401. The token is never
  echoed, stored, or put in a result or Health issue.
- **Priority `normal` only, to every device** (a silent card). A `priority`, `target` or any other field is refused 400,
  naming the field (never its value). Nothing above `normal` can come from a hook.
- **Bounded, outside text**: title one line, 1–60; text at most 200 without control characters; key at most 48 of
  `A-Za-z0-9_.:@/-`, stored as `hook:<key>` (one open card per key; a repeat answers `deduped: true`); body at most 2 KiB;
  10 calls a minute per address and 30 in all. A text that holds the token (as written, percent-encoded or in base64) is
  refused. Titles reach the model only marked as untrusted outside text.
- Answers are machine codes (`202 { ok, deduped }`, `400 { error: "invalid", field }`, `401`, `429` too many open
  (10 per module), `503` busy or not set up, `502` not sent): the caller is a script.
- The token goes in `X-PVA-Token`, not `Authorization`: the host removes `Authorization` from a request to a route that
  has no `token` guard.

## Settings

| Field | Kind | Meaning |
|---|---|---|
| Hook token | secret | the token above. Empty: the hook is closed. A Health issue (info) says so. |

## What it stores

**Nothing of its own**: no collection, no scheduled job. Open notifications and do not disturb (and its end, which the
service ends on time) are the service's rows. So nothing personal is stored here, and a restart of the module changes
nothing (tested). No read-then-write is made on module data: dismissing resolves by id once (a second dismissal finds it
gone and says so), do not disturb is set or cleared as one service call, a test and a hook send dedupe by key.

Bounds (nothing on a turn computes more than this): the list reads at most 5 pages of 12 and says when it was cut (this
module has at most 10 open, so one page holds them); a time or duration said in words is at most 60 characters.

## What it needs

No `requires`: no outgoing request. It uses the notification service (`ctx.notify`, `ctx.notify.dnd`; not available in
the CLI modes: every call then answers that it is unavailable) and `Privacy`. It provides nothing. No notification
buttons beyond the host's Stop, so no action handler is registered.

## What was left out

- **Phone channels, escalation, hooks from outside the home network, anything above `normal` from a hook** (the brief).
- **Listing every module's notifications for a device.** The service gives a module only its own (see above). The
  smallest change: a `ctx.notify.listFor(deviceId?)` that returns open notifications of **all** modules for the asking
  device, already filtered through `decideDelivery` (privacy, target, can-show), a page at a time.
- **Per-device do not disturb, quiet hours** ("Not now" in NOTIFICATIONS.md).
- **An inbox, "what did I miss", marking read, replies, announce/intercom** (research §4: announce belongs to broadcast).
- **Any presentation** (`ctx.present`): P10 does not exist on this base.
- **"Until a time" as a phrase**: slots are a number, a duration, a choice or text; the tool takes it in words.
- A `Test` button in the settings form.
