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
hook and the test), not timers' or reminders' notifications. A successful list says so (`covers`), the empty answer says
so, and the failed-read and unknown-name sentences speak of "this module's hook and test" / "from this module". Of those
it tells a device only what is for it (sent to every device, or to that device) and, for a personal one, only where
`Privacy.mayReveal(owner, device)` says so *now*, asked after the last read and again right before a dismissal. When every
open one is personal and withheld, it says so truthfully ("Nothing I can read out here; 1 personal notification is kept for
its owner's devices.", singular and plural, both languages) and never a title. Nothing this module sends is personal today
(the hook and the test are household content); the rule is built and tested for when the service gives a module more.

## Tools

Actions are not offered to the model as tools; the tools below are the model's way in. All answers are in the household's
language (English and Dutch). **Every change goes through one shared operation** (`src/operations.ts`, made in the
module's shared part), so a tool and a phrase run the same code. Each keeps a bounded record (256) of finished operations
by the invocation's identity (assistant, conversation, turn, device, the operation and what it was asked): a **repeat of the
same invocation, sequential or concurrent, gets the first outcome and changes nothing** (do not disturb is not extended; a
dismissal stays bound to the notification chosen the first time). A new utterance has a new turn id and acts again.

| Tool | Risk | Does | Example |
|---|---|---|---|
| `notifications_open` | read | the open ones for this device (at most 5 titles and "and N more", how many personal ones are kept back, and that the read was cut when it was); titles are marked as untrusted outside text | "which notifications are open?" |
| `notifications_dismiss` `{ which? }` | change | one open notification of this module on this device. The name has its leading articles and trailing filler words dropped (the, a, an, de, het, een; one, notification, melding), then the exact title wins, else every remaining word must be a whole word of the title (no stemming); **several matches ask which**, none refuses with "I don't know a notification by that name from this module." (the name is never repeated); no name: the only open one | "dismiss the washing machine" |
| `notifications_dnd_on` `{ for?, until? }` | change | do not disturb for the house: until turned off, `for` a length in words, or `until` a time in words; at most 7 days; both is refused; an unclear or ambiguous time is a question. A "for" answer confirms the length ("for 2 hours"), an "until" answer the clock time; **never a time that is not the real end** | "do not disturb until eight" |
| `notifications_dnd_off` | change | off; says so only when the service then reads off | "do not disturb off" |
| `notifications_dnd_status` | read | on, with the time left (`speakDuration`) and the clock time only when the end is on a whole minute; a failed read says it could not read, never "off" | "is do not disturb on?" |
| `notifications_send_test` | change | a `normal` test card to the asking device. The key is derived from the device read at that moment, so each device has its own; "already open on this device" only when the open one targets this device; it expires after 10 minutes | "send a test notification" |

**Phrase commands** (run without the language model after the wake phrase; actions `notifications.<id>`): `dnd_on` ("do
not disturb", "niet storen"), `dnd_for` (**a duration slot**: "do not disturb for ten minutes", "niet storen voor een uur";
a duration over seven days is not a slot, so it goes on to the assistant), `dnd_until` (**a text slot**: "do not disturb
until eight", "niet storen tot acht uur"; the time is read in the action by the tool's code, an unreadable or ambiguous one
is refused in words and changes nothing), `dnd_off`, `dnd_status`, `send_test`, `open` ("which notifications are open"),
`dismiss` ("dismiss the notification", "dismiss {which}": the name is text, resolved in the action).

## The hook

`POST /api/modules/notifications/notify`, JSON `{ "title": "Washer done", "text": "optional", "key": "optional" }`, header
`X-PVA-Token: <the token>`.

- **Both are needed**: the request must come from the home network (the route's `lan` guard; with `SERVE_BEHIND_PROXY`
  the guard refuses everyone, so the hook is unreachable by design; forwarded and cross-site requests are refused by the
  router) **and** carry the hook token, a secret setting. The token is compared in constant time (both sides hashed with
  SHA-256, then `timingSafeEqual`). No token, or one shorter than 16 characters (the setting refuses a shorter value when
  saved; a shorter stored one counts as none): every call answers 503 `not-set-up`. A missing and a wrong token answer the
  same 401.
- **The token is never echoed or kept in content**: a title, text or key that holds it, as written, in base64 or
  base64url, or percent-encoded (in full or in part; one bounded pass of percent-decoding, an invalid escape is just text)
  is refused. Every error answer is built from fixed words: `{ error: "invalid", field: "title"|"text"|"key"|"body" }`
  or `{ error: "unknown-field" }`; nothing the caller wrote, not even a field name, is repeated.
- **Priority `normal` only, to every device** (a silent card). A `priority`, `target` or any other field is refused
  (`unknown-field`). Nothing above `normal` can come from a hook.
- **Bounded, outside text**: title one line, 1–60; text at most 200 without control characters; key at most 48 of
  `A-Za-z0-9_.:@/-`, stored as `hook:<key>` (one open card per key; a repeat answers `deduped: true`); body at most 2 KiB;
  10 calls a minute per address and 30 in all. Titles reach the model only marked as untrusted outside text.
- Answers are machine codes (`202 { ok, deduped }`, `400`, `401`, `429` too many open (10 per module), `503` busy or not
  set up, `502` not sent): the caller is a script.
- The token goes in `X-PVA-Token`, not `Authorization`: the host removes `Authorization` from a request to a route that
  has no `token` guard.

## Settings

| Field | Kind | Meaning |
|---|---|---|
| Hook token | secret | the token above, at least 16 characters (a shorter value is refused when saved). Empty: the hook is closed. A Health issue (info) says so. |

## What it stores

**Nothing of its own**: no collection, no scheduled job. Open notifications and do not disturb (and its end, which the
service ends on time) are the service's rows. So nothing personal is stored here, and a restart of the module changes
nothing (tested). Besides the in-memory record of finished operations (bounded, 256, lost at a restart: a repeat after a
restart is a new invocation), no module data is read and written: dismissing resolves by id once (a second dismissal finds it
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
- A `Test` button in the settings form.
