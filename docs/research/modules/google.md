# Google (mail, calendars, tasks, contacts)

Research write-up, 2026-11-17. Nothing here is built. Names in **bold** that refer to shared foundations (Connection,
Module manifest, Module store, Scheduler, Notification service, Tool context, Presentation, Device capabilities) are
worked out in [`../module-investigation/`](../module-investigation/) and are linked, not redesigned, here. Claims
marked **[unverified]** were not confirmed in a primary source.

## 1. Summary

One Google account, linked once, serving several capabilities: reading and summarising Gmail ("anything important?"),
the person's Google calendars (as a provider of the [calendar module](calendar.md)), Google Tasks (as a provider of
the lists module), and Google Contacts (as a name source for [messaging](messaging.md) and mail). The module owns the
`google` **Connection** type and the Gmail tools; calendar and tasks tools stay provider-neutral in their own modules.
This is on the owner's wish list ("a Google integration module that can read emails and my calendars").

- **Priority: first wave**, right after the **Connection** foundation exists, because the owner asked for it and
  calendar is in every survey's top five ([landscape-voice-assistants.md §14](../module-investigation/landscape-voice-assistants.md)).
- **Effort: L.** The API calls are simple. The cost is the OAuth reality for a self-hosted server (§5.2), reading
  mail aloud well (§12), a per-person account model, and a send path that needs confirmation, which core has switched
  off today ([current-system.md §2.5](../module-investigation/current-system.md)).

## 2. What others do

| Product | What it does with Google mail and calendar | Copy | Avoid |
|---|---|---|---|
| Gemini (phone, Gemini for Home) | Connected Apps: Gmail, Calendar, Tasks, Keep, Drive ([landscape-launchers §2.4](../module-investigation/landscape-launchers-and-agent-tools.md)); Voice Match gives each member their own calendar | Per-person accounts selected by who is speaking | Hallucinated calendar entries reported on Gemini for Home ([landscape-voice-assistants §2(f)](../module-investigation/landscape-voice-assistants.md)): every fact must come from a tool result |
| Claude voice | Searches Gmail and edits Google Calendar by voice since July 2026 ("push my meeting by 30 minutes") | Edit-by-intent rather than edit-by-field | Hosted connector: all mail passes through the vendor |
| Alexa+ | Family calendar on Echo Show, add events from a forwarded email | Colour per member on screen | Upsell interjections |
| HomePod / Siri | "Personal Requests" (mail, messages, calendar) only for a recognised voice; guests still get timers and weather | The guest rule (§13) | — |
| OpenClaw | The `gog` CLI as its Google skill ([gogcli](https://github.com/openclaw/gogcli)) | JSON-first CLI, multi-account | Shell access for the agent |
| Home Assistant | `google` (Calendar) and `google_mail` (send only) integrations, with "application credentials": the owner brings his own OAuth client ([HA OAuth2 docs](https://contributors.home-assistant.io/core/integrations/oauth2/)) | Bring-your-own client ID; one credential per account | It relies on `my.home-assistant.io` as redirect relay, which we do not have |

The lesson from all of them: mail is valuable as a **summary and a search**, not as a reader that recites messages.
Nobody's voice product reads full emails well; the good ones say who wrote and what it is about, and offer more.

## 3. Example conversations

1. **Morning check (no screen needed).**
   "Hey Jeff, anything important in my mail?" → "Three new since last night. Your landlord wrote about the boiler
   service on Thursday morning, and asks if nine works. The school sent the trip permission form. The rest is
   newsletters." → "What does the landlord want exactly?" → "He says the engineer comes Thursday between nine and
   twelve and asks you to reply if that doesn't work."
2. **Sender question.** "Did Sanne email me today?" → "No mail from Sanne today. The last one was Monday, about the
   birthday present."
3. **Reply with confirmation.** "Reply to the landlord: nine is fine." → "I'll send to Peter de Vries: 'Nine o'clock
   on Thursday is fine, thanks.' Send it?" → "Yes." → "Sent." (Needs core confirmation switched on for the `message`
   risk class, §13.)
4. **Draft, not send.** "Draft an email to the school saying Mila is ill today." → "Drafted to the school office. I've
   put it on the study screen; say send when it looks right." (**screen** for review)
5. **Search.** "Find the email with the train tickets." → "The NS confirmation from 2 November: Amsterdam to
   Utrecht, Saturday 22 November, 10:14." On a screen the message card shows the booking code.
6. **Ambiguous person.** "What did Tom send me?" → "There are two Toms: Tom Bakker and Tom from the football club.
   Which one?"
7. **Shared device, wrong person.** On the kitchen speaker whose default person is the household:
   "Read my email." → "Mail is personal and this device isn't set to anyone. Say 'as Ian' or ask on your phone."
8. **Failure: expired consent.** "Anything new in my mail?" → "I can't reach your Google account; the link needs
   renewing. I've put a note in the admin page." (`invalid_grant` on refresh, §7)
9. **Contacts lookup.** "What's Oma's phone number?" → "Oma, mobile: 06 12 34 56 78." (personal, read-only)
10. **Tasks via the lists module.** "Add 'renew passport' to my Google tasks." → "Added to My Tasks."

## 4. Tools

Calendar and task tools are defined once in the [calendar](calendar.md) and lists modules and backed by this
connection; only the mail, contacts and Drive tools belong to this module. Risk classes follow the template (safe /
changes data / outward-facing) and map onto the `risk` proposal of
[module-definition §B.5](../module-investigation/module-definition-config-and-dependencies.md) (`read` / `change` /
`message`).

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `mail_overview` | `since?` (ISO or "last-check"), `only?: "important" \| "primary" \| "all"`, `max?` (≤ 20) | count, then per message: id, sender name, sender address, subject, snippet (≤ 160 chars), date, labels, an `importance` reason | read | safe | 300–700 ms (list + batched metadata gets); 20 ms from cache | yes: a templated "3 new, from X, Y and Z" works without the model |
| `mail_search` | `query` (Gmail syntax produced by the model: `from:`, `subject:`, `newer_than:`, `has:attachment`), `max?` | same rows as above | read | safe | 400–900 ms | no |
| `mail_read` | `id`, `part: "gist" \| "body"`, `maxChars?` (default 1500) | sender, subject, date, plain-text body stripped of quotes and signatures, attachment names | read | safe | 200–500 ms | no |
| `mail_draft` | `to` (contact name or address), `subject?`, `body`, `replyTo?` (message id) | a local draft id, resolved recipient, final text | write (local only) | changes data | < 50 ms (local) | no |
| `mail_send` | `draftId` | sent message id | write | outward-facing (`message`) | 400–800 ms | no; always confirmed |
| `mail_mark` | `ids`, `as: "read" \| "archived"` | ok | write | changes data | 200–400 ms | no |
| `contacts_find` | `name` | up to 5 matches: display name, nicknames, phones, emails, a match score | read | safe | 20 ms from cache, 300 ms live | yes |
| `drive_find` | `query`, `max?` (≤ 5) | title, type, modified, owner, a link for `handoff` | read | safe | 400–800 ms | no |

All read tools are `speculative: true`. `mail_draft` is deliberately local: Gmail drafts need the restricted
`gmail.compose` scope, while sending a message we built ourselves needs only `gmail.send`, which is "sensitive", not
"restricted" ([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)). Keeping drafts in the
**Module store** (conversation scope) avoids one restricted scope and makes "read it back" instant.

## 5. Integrate or build

### 5.1 Four ways to reach Google

| Option | How | For | Against |
|---|---|---|---|
| **A. Google REST APIs directly** | `fetch` against `gmail.googleapis.com/gmail/v1/users/me/...`, `www.googleapis.com/calendar/v3/...`, `tasks.googleapis.com/tasks/v1/...`, `people.googleapis.com/v1/people/me/connections`, in one adapter package with our own token refresh | Full control over latency (batch metadata, partial responses with `fields=`), exact scopes, tokens in our vault, Effect-native errors | We write the OAuth flow and a small client; the `googleapis` npm package is large, so a hand-written client for ~12 endpoints is preferable |
| B. IMAP/SMTP + CalDAV/CardDAV | `imap.gmail.com:993`, `smtp.gmail.com:465`, Google CalDAV `https://apidata.googleusercontent.com/caldav/v2/<calendarId>/events` **[from memory]** | Shares code with the generic [messaging](messaging.md) IMAP adapter and the CalDAV provider; Gmail's `X-GM-RAW` IMAP extension still allows Gmail search syntax **[from memory]** | IMAP with OAuth needs `https://mail.google.com/` (restricted, full access including permanent delete). App passwords still work for accounts with 2-Step Verification according to third-party guides, but Google is pushing these protocols to OAuth and reports conflict about how far that has gone ([Mailbird](https://www.getmailbird.com/gmail-oauth-authentication-changes-user-guide/), [Nylas guide](https://cli.nylas.com/guides/gmail-app-password-setup.md)) **[unverified]**. No importance markers or categories. Google CalDAV also needs OAuth. |
| C. An existing MCP server through the MCP bridge module | Google's own remote servers `gmailmcp.googleapis.com/mcp/v1` and `calendarmcp.googleapis.com/mcp/v1`, developer preview since April 2026 ([Workspace update](https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html); endpoints from [a third-party guide](https://www.dragapp.com/blog/gmail-mcp-server/), **[unverified]**), or the community [`google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) (Python, 120+ tools, `--tool-tier core`, read-only mode) | No code; follows Google's API changes; good for an experiment | Extra round trip per call; tool annotations are untrusted hints, so every tool is treated as non-speculative ([module-definition §A.5](../module-investigation/module-definition-config-and-dependencies.md)); 120 tools is far past the 30–50 where tool selection degrades ([landscape-launchers §2.3](../module-investigation/landscape-launchers-and-agent-tools.md)); Google's remote server needs enrolment in the Workspace Developer Preview Program and sources disagree on whether it can send; the community server keeps its own tokens outside our vault |
| D. A command-line tool | [`gws`](https://docs.rs/crate/google-workspace-cli/0.22.5/source/README.md) (`googleworkspace/cli`, Rust, `npm i -g @googleworkspace/cli`, commands generated from Google's Discovery Service, credentials AES-256-GCM in the OS keyring, pre-1.0, "not an officially supported Google product") or [`gog`](https://cdn.jsdelivr.net/gh/steipete/gogcli@main/README.md) (Go, JSON output, multiple accounts, `gog auth add you@gmail.com --services gmail,calendar`) | Excellent for prototyping and for the owner's own scripts; both already solve multi-account OAuth | A process spawn per call (tens to hundreds of ms, to be measured); tokens live in the tool's keyring, not our vault; pre-1.0 output formats change; a native binary to manage ([module-definition §C](../module-investigation/module-definition-config-and-dependencies.md)) |

**Recommendation: A**, as `packages/connection-google` (the OAuth client, token refresh, typed errors) plus
`packages/module-google` (mail, contacts, Drive tools). No Google SDK outside the adapter, per the project rule. Use
C or D only as a throwaway prototype to learn which questions the owner actually asks before building the summariser.

### 5.2 The OAuth reality for a self-hosted server

These facts decide the setup flow and the health checks:

| Fact | Source | Consequence |
|---|---|---|
| The device-code flow allows only `openid`, `email`, `profile`, `drive.file`, `drive.appdata`, `youtube`, `youtube.readonly` | [Google limited-input devices](https://developers.google.com/identity/protocols/oauth2/limited-input-device) | The cleanest flow for a headless box cannot be used for Gmail, Calendar, Tasks or Contacts |
| Every Gmail read scope is **restricted** (`gmail.readonly`, `gmail.metadata`, `gmail.modify`, `gmail.compose`, `mail.google.com`); `gmail.send` is sensitive; `gmail.labels` is non-sensitive | [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) | A public app would need verification plus an annual security assessment; a personal app does not (next row) |
| Verification is not needed "if the app is for your personal use (fewer than 100 users)"; users click through the unverified-app warning; the 100-user cap counts over the project's lifetime and cannot be reset | [When verification is not needed](https://support.google.com/cloud/answer/13464323), [unverified-app FAQ](https://support.google.com/cloud/answer/13463817) | Each owner creates **his own Google Cloud project**. We never ship a shared client ID. Whether the exemption explicitly covers restricted scopes is not stated on that page **[unverified]**, but it is how `gog`, `gws` and rclone users work |
| A project in **Testing** status gets refresh tokens that expire after 7 days (unless only basic profile scopes) | [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2) | Setup must tell the owner to press **Publish app** (In production) after adding himself; health check warns when a token's age approaches 7 days |
| Refresh tokens also die after 6 months unused, beyond 100 per account per client (oldest silently invalidated), and on a password change when Gmail scopes are included | same | A daily no-op refresh keeps a rarely used account alive; `invalid_grant` becomes connection status `needs-reauth` (§7) |
| A **Google Workspace** account (own domain) can mark the app **Internal**: no warning screen, no cap | [When verification is not needed](https://support.google.com/cloud/answer/13464323) | Recommend it when the owner's mail is on Workspace |
| Desktop clients use a loopback redirect `http://127.0.0.1:<port>`; custom schemes and copy-paste (OOB) are gone | [Installed apps](https://developers.google.com/identity/protocols/oauth2/native-app) | Use a **Desktop app** client type. Loopback with any port is accepted for that type without registering each URI **[from memory]** |
| Web clients refuse raw private IPs and `.local` names | [module-definition §B.4](../module-investigation/module-definition-config-and-dependencies.md) | A LAN redirect `https://192.168.1.10:8787/...` is impossible; a real domain name with a DNS-01 certificate works |

**Flow we recommend** (flow 2 in [§B.4](../module-investigation/module-definition-config-and-dependencies.md)):
authorization code + PKCE with a loopback redirect. When the admin page is open on the server itself, the redirect
lands. From a phone, the browser ends on an unreachable `http://127.0.0.1:...` page; the admin page asks the owner to
paste that address, and the server finishes the exchange with the `code` and `state` it contains. If the server has a
real HTTPS name, offer flow 3 (a Web client and `https://<name>/oauth/google/callback`) as the smoother option.

## 6. Data

| What | Scope | Shape | Readable by |
|---|---|---|---|
| Connection record | person (or household for a shared family account) | `{ id, type: "google", owner, label: "ian@gmail.com", scopes[], status: ok \| locked \| needs-reauth, createdAt }` in settings; refresh token in the vault | host only |
| Mail cursor | person | `{ connectionId, historyId, lastCheckAt, lastSpokenAt }` | this module |
| Mail header cache | person | last 200 messages: id, threadId, from, subject, snippet, date, labelIds, importance; dropped after 7 days | this module; `briefing` through an export `mail.overview` (counts and senders only) |
| Contacts cache | person | display name, nicknames, phones, emails, a phonetic key (§12) | `contacts_find`; [messaging](messaging.md) through an export `contacts.resolve` |
| Drafts | conversation | `{ id, to, subject, body, replyTo }` | this module; gone when the conversation ends |
| VIP senders and mute rules | person | addresses or domains, "always important" / "never mention" | this module |

Bodies are never stored; they are fetched on demand. All rows go through the **Module store**
([shared-state §4](../module-investigation/shared-state-jobs-and-notifications.md)).

## 7. Long-running work and events

- **Mail sync job** (**Scheduler**, `recurring`, every 3 min during the day, 15 min at night, per connection):
  `GET users/me/history?startHistoryId=<cursor>&historyTypes=messageAdded`, then metadata for new ids
  (`format=metadata&metadataHeaders=From&metadataHeaders=Subject`). Gmail push (`users.watch`) needs Cloud Pub/Sub;
  a *pull* subscription would work without exposing the server, but adds a second Google product to set up. Polling
  is enough for a voice assistant, and the cursor survives a restart. After a restart with a cursor older than
  Gmail's history window the API returns 404 **[from memory]**; then resync the last 24 hours.
- **Token keeper** (daily): refresh each connection once, so the 6-month idle expiry never hits; on `invalid_grant`
  set `needs-reauth` and raise one `low` notification to the owner (admin inbox, not spoken).
- **Contacts sync** (daily, plus on demand): People API `connections.list` with `personFields=names,nicknames,phoneNumbers,emailAddresses` and a sync token.
- **Events emitted** (**Event bus**): `google.mail.new` (person scope, with importance), `google.connection.status`.
  The briefing and notification rules listen to the first; the admin page to the second.
- Across a restart: nothing is lost except in-flight drafts, which are conversation-scoped by design.

## 8. Presentation

| Situation | Screen device | Speaker only |
|---|---|---|
| `mail_overview` | `list` (sender, subject, time; important ones first), `sensitivity: "personal"` | Count, then up to three senders with a five-word gist each, then "and four newsletters" |
| `mail_read` | `card` with sender, subject and the cleaned body; a `handoff` QR code to open it in Gmail | Gist first, the body only on "read it all", in chunks of about 30 seconds with "shall I go on?" |
| Draft review | `card` with To, Subject, Body and a `confirm` (Send / Cancel) | Full read-back, then the spoken confirmation |
| Contacts | `facts` | Spoken |

The character stays in the corner layout while a mail card is up ([presentation §4.1](../module-investigation/presentation-and-device-capabilities.md)).
Personal presentations are not shown on a `shared` or `public` device; the Presenter offers the owner's phone instead
([presentation §6.1](../module-investigation/presentation-and-device-capabilities.md)).

## 9. Notifications and proactive behaviour

- Default: **nothing unprompted**. New mail is counted in ambient facts ("2 important unread") for that person only.
- Opt-in per person: an `important mail` rule (VIP sender, or Gmail's `IMPORTANT` label plus `CATEGORY_PERSONAL`)
  raises a `normal` notification to that person's devices, spoken only on `private` devices and outside quiet hours,
  else inbox and phone push via the **Notification service**. Content spoken: sender and subject only.
- Never announce mail on a `shared` device without a known person present.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | Allow personal modules on shared devices | off |
| Module | OAuth client ID and secret (secret in the vault) | — (required) |
| Module | Sync interval day / night | 3 min / 15 min |
| Module | Exclude categories from "new mail" | Promotions, Social, Updates, Forums |
| Assistant | Tools on (e.g. a "Kids" assistant gets none) | via `offTools` |
| Assistant | May send mail | off (risk `message` → deny) |
| Device | Policy can only narrow: "no personal mail here" | inherits |
| Person | Connections (one or more Google accounts), VIP senders, mute list, "read bodies aloud" | — |

**Connection** needs: client ID + secret per household (one Cloud project), one refresh token per linked account.

**First-run setup for the owner** (shown as a checklist in admin, each step with a link):
1. Create a project at console.cloud.google.com; enable Gmail API, Google Calendar API, Google Tasks API, People API.
2. OAuth consent screen: External (or Internal on Workspace), add yourself as a test user, then **Publish app**.
3. Create an OAuth client of type **Desktop app**; paste the client ID and secret into the module.
4. Press **Link a Google account**; choose which capabilities (mail read, mail send, calendar, tasks, contacts). We
   request only those scopes (incremental authorization).
5. Accept the "Google hasn't verified this app" warning (Advanced → Go to …). The admin page says why this is expected.
6. Pick the owner of the account (a person, or the household), and test: the card shows "Gmail: 1,204 unread, last
   sync just now".

Scope sets: mail read `gmail.readonly`; mark read and archive `gmail.modify` (replaces readonly); send `gmail.send`;
calendar read `calendar.events.readonly` + `calendar.calendarlist.readonly`, write `calendar.events`; tasks `tasks`;
contacts `contacts.readonly`; Drive `drive.metadata.readonly` **[restricted status unverified]**
([Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)).

## 11. Native tools and dependencies

None on the server beyond Node: plain HTTPS. Requirements declared in the **Module manifest**: `{ network: "internet" }`
and the connection type. Missing pieces and what the assistant says:

| Missing | State | Spoken |
|---|---|---|
| No client ID configured | `unavailable` | "Google isn't set up yet. The owner can add it in the admin page." |
| Vault locked | connection `locked` | "I can't open your Google account until the vault is unlocked." |
| `needs-reauth` | connection status | "Your Google link has expired; it needs renewing in the admin page." |
| Scope not granted (e.g. send) | tool refuses | "I can read your mail but wasn't given permission to send. That's a setting in the admin page." |
| Google API 429/5xx | tool error | "Google isn't answering right now." (never invent a result) |

Photos and Maps are out of this module: since 31 March 2025 the Photos Library API only manages media the app itself
created, and reading a library needs the user-driven Picker API
([Google Photos API updates](https://developers.googleblog.com/en/google-photos-picker-api-launch-and-library-api-updates/)),
so "show photos of the kids" belongs to an Immich module. Maps travel times need an API key with billing, not OAuth,
and belong to a commute module.

## 12. Interaction with the rest of the system

- **Reading mail well.** The tool, not the model, does the heavy lifting: strip quoted replies (`On … wrote:`),
  signatures, tracking footers and HTML; collapse newsletters by `List-Unsubscribe` header into one "and five
  newsletters". The model gets rows with an `importance` reason (`vip`, `gmail-important`, `reply-to-you`,
  `from-contact`, `newsletter`) and is instructed to speak senders by first name, never read addresses, dates as
  "this morning" / "yesterday", and stop after three items with an offer.
- **"Anything important?"** is a ranking, not a model judgment: VIP and contacts first, then Gmail's `IMPORTANT`
  label in the primary category, then threads where the person is the last recipient awaiting a reply. Everything
  else is counted, not read.
- **Privacy of content sent to the LLM.** Summaries are written by the assistant's language model, which is hosted
  (local-first rule: everything local except the model). By default only headers and snippets reach it; bodies only
  when the person asks about one message. A per-person switch can keep mail tools away from hosted-model assistants.
- **Speech recognition quirks.** Names are the failure point ("Sanne" heard as "Sana", "Joost" as "Jost"):
  `contacts_find` matches on a phonetic key (Double Metaphone or a Dutch-aware Cologne-style code **[choice open]**)
  and returns several candidates with scores; the model asks when the top two are close (example 6).
- **Fillers.** `mail_overview` from cache answers within the speculative window; a live search says "let me look"
  first (text before a tool call is already spoken while it runs).
- **Interruption.** Barge-in stops a body read; "go on" resumes from the next chunk (the chunk index is kept in the
  conversation-scoped draft/read state).
- **Assistants.** Ships an assistant template "Secretary" (mail, calendar, contacts; a concise, discreet persona;
  suggested phrase "hey secretary"). The general assistant gets read tools; send stays off unless the owner opts in.
- **Typed intents (Jev).** `mail_overview` is offered as an action `mail_new` with examples ("any new mail", "heb ik
  mail") and a templated `say`, so the common question works without the model.
- **Other modules.** Provides `google` providers for [calendar](calendar.md) and lists; `contacts.resolve` for
  [messaging](messaging.md); `mail.overview` for [briefing](briefing.md).

## 13. Privacy and safety

- Mail, contacts and personal calendars are **person-scoped**. Resolution follows
  [§B.4](../module-investigation/module-definition-config-and-dependencies.md): speaking person, then device default
  person, then a household account; never "the first account found".
- Voice identity may **select** whose mail, never authorise sending ([shared-state §4.6](../module-investigation/shared-state-jobs-and-notifications.md)).
- **Sending** is risk class `message`: confirm by default, deny on devices that are not `allowRisky`. Until core's
  confirmation is switched on, the module offers drafts and a screen `confirm` card only; no spoken send.
- **Prompt injection.** Mail is untrusted text. Tool results wrap bodies as data, and the assistant's instructions
  say content inside mail is never an instruction. A tool round that read a mail body may not call `mail_send` in
  the same turn without a fresh confirmation (a rule in the module, enforced in `mail_send`).
- **Guests and children.** Guests get nothing from this module; a children's assistant has it off.
- Revocation: "Unlink" deletes the refresh token, calls `https://oauth2.googleapis.com/revoke`, and purges caches.

## 14. Foundations needed

Hard: **Connection** (OAuth, vault storage, per-person owner), **Tool context** (who is asking, which device).
Soft: **Module store** (caches, cursor), **Scheduler** (sync, token keeper), **Notification service** (important
mail), **Presentation** (cards), **Device capabilities** (`privacy`), people records.

**Useful first version without them:** a single-owner module with the client ID, secret and refresh token as module
secret fields (the paste-the-redirect flow done by a small CLI command `pva google link`), read-only scopes,
`mail_overview`, `mail_search`, `mail_read` and the calendar provider, live calls only (no cache), on assistants the
owner uses on private devices. It answers the wish-list request in about a week and is replaced by the Connection
version later.

## 15. Open questions

1. **Accounts:** only your own Google account, or also a partner's and a shared family account? This decides whether
   per-person connections are needed in the first version.
2. **Read scope or full mailbox actions:** is reading enough (`gmail.readonly`), or do you want "archive that" and
   "mark as read" (`gmail.modify`, a broader restricted scope)?
3. **Sending:** should the assistant ever send mail by voice, or only prepare drafts you send from the screen?
   This is the first real use of core's confirmation, which is switched off today.
4. **Hosted model and mail:** is it acceptable that mail headers and, on request, bodies go to the hosted language
   model? If not, mail tools need an assistant on the home model server.
5. **Workspace or consumer Gmail?** An Internal Workspace app avoids the warning screen and the cap.
6. **Disagreement with [landscape-automation §14](../module-investigation/landscape-automation-platforms.md):** it lists
   a `google` *bundle* that owns Calendar and Tasks tools. This document keeps those tools in provider-neutral
   modules and makes Google a provider, so CalDAV and Google calendars answer the same way.
7. Is a MCP prototype (Google's preview server or `google_workspace_mcp`) worth a week before building option A?
