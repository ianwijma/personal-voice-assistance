# Messaging (mail outside Google, chat apps, SMS)

Research write-up, 2026-11-17. Nothing here is built. Shared foundations (Connection, Module manifest, Requirements
and health, Module store, Scheduler, Event bus, Notification service, Tool context, Presentation, Device
capabilities) are worked out in [`../module-investigation/`](../module-investigation/) and linked, not redesigned.
Claims marked **[unverified]** or **[from memory]** were not confirmed in a primary source.

## 1. Summary

Sending and reading messages as a person, on channels other than Gmail (which the [google](google.md) module covers):
generic IMAP/SMTP mail, Telegram, Signal, Matrix, SMS, and possibly WhatsApp. It includes a contact directory that
resolves spoken names to a person and a channel ("tell Sanne I'm running late"), a mandatory read-back and
confirmation before anything leaves the house, and, as a separate capability, using a chat app as an extra **text
front end** to the assistant.

- **Priority: second wave.** Valuable ("message Ian that dinner's ready" is a top household request,
  [landscape-voice-assistants §17](../module-investigation/landscape-voice-assistants.md)), but it is the first
  *outward-facing* capability, and needs core confirmation switched on and person identity first.
- **Effort: M** for the core (contacts, confirmation flow, one channel: Telegram); **+S** per further channel
  (IMAP/SMTP, Signal, Matrix, SMS); WhatsApp is **L with high risk** (§5.3). The text front end is **M** because it is
  a new device type, not a module tool.

Not in scope: pushing *the assistant's own* alerts to a phone. That is the **Notification service** with ntfy/Web
Push/Apprise ([shared-state §8.7](../module-investigation/shared-state-jobs-and-notifications.md)). Messaging speaks
*as a person to another person*.

## 2. What others do

| Product | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa | Calls and messages between Echo users and contacts; Announcements to all Echos | Contacts with nicknames ("Mum") | A proprietary network only Alexa users can reach |
| Siri / HomePod | Send iMessage/SMS for a recognised voice: "Send Sanne a message saying …", reads it back, "Ready to send it?" | The read-back plus one yes/no; "change it" re-dictates | — |
| Google Assistant | Messages via the phone's apps, contacts from Google | Channel chosen per contact | Phone needed nearby |
| Home Assistant | `notify` platforms: Telegram (27,912 installs), Signal Messenger (signal-cli-rest-api), Matrix, SMTP, SMS gateways ([landscape-automation §11](../module-investigation/landscape-automation-platforms.md)) | One adapter per channel behind one `notify` shape | `notify.notify` sends to "the first notify action found": always resolve an explicit target (mistake 2 in [landscape-automation §13](../module-investigation/landscape-automation-platforms.md)) |
| OpenClaw, Hermes, n8n | Messaging channels (Telegram, WhatsApp, Signal, Discord) as both output and **input**: the agent is reachable in a chat ([landscape-launchers §2.5](../module-investigation/landscape-launchers-and-agent-tools.md)) | A chat app as a text front end | Letting a chat message trigger shell tools |

## 3. Example conversations

1. "Hey Jeff, tell Sanne I'm running ten minutes late." → "To Sanne on Signal: 'I'm running ten minutes late.' Send
   it?" → "Yes." → "Sent."
2. **Change before send.** "Message the family group: who wants pizza tonight?" → "To 'Family' on Telegram: 'Who
   wants pizza tonight?' Send it?" → "Add 'I'm ordering at six'." → "'Who wants pizza tonight? I'm ordering at six.'
   Send it?" → "Yes."
3. **Ambiguous name.** "Text Tom that the match is cancelled." → "Tom Bakker or Tom from football?" → "Football." →
   "To Tom van Dijk by SMS: 'The match is cancelled.' Send it?"
4. **Reading.** "Any messages?" → "Two. Sanne on Signal at 17:40: 'Can you pick up bread?' And the football group on
   Telegram, three messages about Saturday's carpool." → "Read the carpool ones." → (reads them, oldest first, with
   names)
5. **Reply.** "Reply to Sanne: yes, sourdough?" → "To Sanne on Signal: 'Yes, sourdough?' Send it?"
6. **Mail outside Google.** "Did the plumber answer my email?" → "Yes, Jansen Installatie replied at 11:02 on your
   Fastmail: he can come Tuesday morning." (IMAP)
7. **Refused on a shared device.** On the hallway speaker (not `allowRisky`): "Send a message to my boss." → "I don't
   send messages from the hallway speaker. You can do it from the study or your phone."
8. **Failure.** "Tell Ian dinner's ready." → "Signal isn't connected right now, so I couldn't send it. Shall I announce
   it on the speakers instead?" (offers the broadcast module)
9. **Text front end.** Ian, on the train, in Telegram to the household bot: "Did I leave the living room lights
   on?" → bot: "Yes, two lamps in the living room are on." → "Turn them off." → "Done." (a device of type
   `chat-telegram`, §12)
10. **Unknown contact.** "Message Lotte that I've got her keys." → "I don't have a Lotte in contacts. Want me to add
    her? You can do that in the admin page."

Screens are optional throughout; a `confirm` card with the message text helps on a screen device (examples 1–5).

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `contacts_resolve` | `name`, `channel?` | candidates: person/contact id, display name, channels available, score | read | safe | < 30 ms (local) | yes |
| `message_prepare` | `to` (name, group, or contact id), `text`, `channel?`, `replyTo?` | a prepared message id, resolved recipient and channel, final text, the read-back sentence | write (conversation state only) | safe | < 50 ms | yes (typed action) |
| `message_send` | `preparedId` | sent id, channel, time | write | outward-facing (`message`) | Telegram 200–500 ms, Signal 0.5–3 s, SMS 1–5 s, SMTP 0.5–2 s | no; always confirmed |
| `messages_unread` | `from?`, `channel?`, `since?`, `max?` (≤ 10) | per conversation: sender, channel, count, last text (≤ 200 chars), time | read | safe | < 30 ms (local inbox) | yes ("any messages") |
| `messages_read` | `conversation` (from the previous result), `max?` | messages oldest first with names | read | safe | < 30 ms | no |
| `mail_inbox` (IMAP) | `since?`, `from?`, `query?` (text), `max?` | same row shape as the google module's `mail_overview` | read | safe | 300 ms–2 s live (IMAP SEARCH + FETCH ENVELOPE), < 30 ms cached | yes |
| `mail_compose` (SMTP) | `to`, `subject`, `body`, `replyTo?` | prepared id (sent with `message_send`) | write (local) | safe | < 50 ms | no |

The two-step `prepare` → `send` split is the core design: preparation is free and speculative-safe, only `send`
leaves the house, and `send` refuses unless the confirmation for *that exact prepared id* happened in this
conversation. Read tools return messages already received by the channel workers (§7), so they answer in milliseconds.

## 5. Integrate or build

### 5.1 Channels

| Channel | Integration | Auth and setup | Inbound | Risks and limits |
|---|---|---|---|---|
| **Telegram** | [Bot API](https://core.telegram.org/bots/api): `sendMessage`, `sendVoice`, `getUpdates` with long polling (`timeout=50`), so no public URL is needed **[from memory]** | Create a bot with @BotFather, token in the vault; each family member opens the bot and sends `/start`, which records their chat id | yes | A bot cannot message someone who has not started it **[from memory]**. Messages are sent *as the household bot*, not as Ian. Bot chats are cloud chats, not end-to-end encrypted |
| **Signal** | [`signal-cli`](https://github.com/AsamK/signal-cli) in daemon mode (JSON-RPC; D-Bus), or the `bbernhard/signal-cli-rest-api` container that HA uses **[from memory]** | `signal-cli link` as a secondary device of a person's account (sends *as Ian*), or register a dedicated number for a household bot | yes | Needs JRE 25 (or the experimental GraalVM native build); bundled `libsignal-client` covers x86_64 Linux only, ARM needs a separate library; releases older than three months may stop working because Signal's server changes ([signal-cli README](https://github.com/AsamK/signal-cli)): it must be updated, which the managed-binaries strategy of [module-definition §C.6](../module-investigation/module-definition-config-and-dependencies.md) has to cover |
| **Matrix** | `matrix-bot-sdk` or `matrix-js-sdk` with the Rust crypto module for E2EE rooms **[from memory]** | A bot account on the household's homeserver (Synapse, Conduit) or matrix.org; access token in the vault | yes | E2EE device verification is fiddly; bridges (mautrix-signal, mautrix-whatsapp) can reach other networks, with the same ToS risks as the underlying network |
| **IMAP/SMTP mail** | `imapflow` (IMAP with IDLE), `mailparser`, `nodemailer` | Host, port, user, app password per account; OAuth for providers that require it (Outlook.com **[unverified]**) | yes (IDLE) | Shares the "reading mail well" code with the google module (quote and signature stripping, newsletter collapsing). Fastmail also offers JMAP, a cleaner API **[from memory]** |
| **SMS** | [SMS Gateway for Android](https://docs.sms-gate.app/) on a spare phone in *local server* mode (REST on the phone, port 8080, works offline on the LAN), or Twilio, or HA's SMS integrations | Phone credentials shown in the app; or a Twilio key | yes (gateway webhooks) | Costs per SMS through the phone plan or Twilio; Android may kill the app in the background |
| **WhatsApp** | see §5.3 | | | |

### 5.2 Contacts

A local **contact directory** owned by this module: household people (from the people records) plus contacts, each
with aliases ("Mum", "Oma", "mam"), a phonetic key, and per-channel handles (`signal: +316…`, `telegram: chatId`,
`email: …`). Sources: manual entries in admin (the default and the only one needed for a household), the google
module's People API cache (`contacts.resolve` export), CardDAV via `tsdav` (Nextcloud, iCloud). Imports are merged by
phone number and email. Only contacts with at least one handle on a connected channel are offered as recipients.

### 5.3 WhatsApp: the state of the options

| Option | What it is | Verdict |
|---|---|---|
| WhatsApp Cloud API (Meta) | Official Business API: a business number, message templates for anything outside a 24-hour customer-service window **[from memory]**, per-conversation pricing. Since 15 January 2026 its terms bar general-purpose AI assistants as the primary functionality ([TechCrunch](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/), [9to5Mac](https://9to5mac.com/2025/10/20/whatsapp-bans-ai-chatbots-from-using-its-business-api/)) | Not a fit: it sends as a business, needs Meta business verification, and the assistant-as-a-chat-front-end use is the banned case |
| Baileys / whatsapp-web.js | Unofficial libraries that act as a linked WhatsApp Web device | Against WhatsApp's terms; reports of bans range from "manageable" to weeks ([zylos research](https://zylos.ai/zh/research/2026-01-26-whatsapp-api-automation), vendor-biased, **[unverified]**); several malicious npm forks in 2026, one hijacking the account ([OffSeq](https://radar.offseq.com/threat/malicious-code-in-dreamguyxeonbaileyx-npm-ff6f2183cd9403be)) |
| mautrix-whatsapp bridge | Matrix bridge built on the same unofficial protocol | Same ban risk, plus a Matrix server to run |

**Recommendation: skip WhatsApp** in this module. If the household insists, offer it as an explicitly experimental
adapter that must use a **dedicated number**, never a person's own account, behind a warning in admin.

### 5.4 Recommendation

Build the module (contacts, prepare/confirm/send, inbox) and integrate channels as adapter packages
(`packages/channel-telegram`, `channel-signal`, `channel-imap`, `channel-matrix`, `channel-sms`), each implementing
`{ send(to, text), inbound: Stream<Message>, health }`. Order: **Telegram** (no native dependency, five-minute setup,
also the text front end), **IMAP/SMTP** (owner's non-Google mail), **Signal** (what the family probably uses; sends as
the person), then Matrix or SMS on demand.

## 6. Data

| What | Scope | Shape | Readable by |
|---|---|---|---|
| Contacts | household (shared contacts) and person (a person's own) | `{ id, name, aliases[], phoneticKey, handles: { channel, address, verified }[], personId? }` | this module; `contacts.resolve` export for google and calendar |
| Channel accounts | household or person | `{ id, channel, owner, label, sendsAs: "person" \| "bot", status }`; tokens in the vault (**Connection** records) | host, this module |
| Inbox | person (messages to a person's account), household (household bot groups) | `{ id, channel, conversationId, from, text, at, readAt?, spokenAt? }`; kept 14 days | this module; counts to the ambient facts and [briefing](briefing.md) |
| Prepared messages | conversation | `{ id, to, channel, text, replyTo?, confirmedAt? }` | this module |
| Sent log | person | `{ id, channel, to, textHash, at, device, assistant }` (an audit trail, text optional) | admin |

## 7. Long-running work and events

- **Channel workers** run in the module's scope: Telegram long polling, Signal JSON-RPC subscription, IMAP IDLE,
  Matrix sync. Each stores its cursor (Telegram `update_id`, IMAP `UIDVALIDITY`+`UIDNEXT`, Matrix `since`) in the
  **Module store**, so a restart continues where it stopped and does not re-announce old messages.
- **Events**: `messaging.received` (scope of the recipient), `messaging.sent`, `messaging.channel.status`.
- **Delayed send** ("tell Sanne at five that …") becomes a `deferred command` job on the **Scheduler**
  ([shared-state §6.1](../module-investigation/shared-state-jobs-and-notifications.md)), confirmed when created, and
  dropped if more than 15 minutes late.
- Missing a channel (process down): messages stay on the provider and arrive at reconnect; nothing to replay locally.

## 8. Presentation

| Situation | Screen | Speaker only |
|---|---|---|
| Prepared message | `card` (To, channel, text) with a `confirm` (Send / Change / Cancel) | The read-back sentence and "Send it?" |
| Unread | `list` grouped by conversation, `sensitivity: "personal"` | Count, then sender and first line per conversation, three at most |
| A conversation | `list` of messages | Read oldest first, sender names only when they change |
| Sent | brief `text` "Sent to Sanne" | "Sent." |

## 9. Notifications and proactive behaviour

- Incoming messages are **not announced by default**. A person can mark contacts or groups as "announce": then a
  `normal` notification "Message from Sanne" (sender only; the text on request) goes to that person's devices via the
  **Notification service**, respecting quiet hours and the device's `privacy`.
- Ambient facts carry "2 unread messages (Sanne, Football)" for the device's person.
- Never read message text unprompted on a `shared` device.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | Policy for `message` risk | confirm |
| Household | Household channel accounts (the Telegram bot, a family Signal number) | — |
| Module | Contacts (records), channel order per contact ("Signal, then SMS") | — |
| Module | Inbox retention; announce rules | 14 days; none |
| Assistant | May send (a kids' assistant: only to household members) | per assistant |
| Device | `allowRisky` (needed to send); text front-end devices: allowed tools | off except owner-marked devices |
| Person | Own channel accounts (linked Signal, IMAP mailbox), signature, announce list | — |

**First-run setup (Telegram):** create a bot with @BotFather, paste the token, open the bot on each phone and send
`/start`; admin lists the chats that appeared and the owner assigns each to a person. **Signal:** install the managed
`signal-cli`, press "Link", scan the QR code with Signal on the phone (Settings → Linked devices).

## 11. Native tools and dependencies

| Dependency | Where | When missing |
|---|---|---|
| `signal-cli` + JRE 25 (or the native build), `libsignal-client` for the arch | server | Signal adapter `unavailable`: "Signal isn't installed on the server." |
| Android phone with SMS Gateway | LAN | "The SMS phone isn't reachable." |
| Matrix homeserver | LAN or internet | "I can't reach the Matrix server." |
| Telegram, IMAP: none (HTTPS/TLS sockets) | — | "Telegram isn't answering right now." |

A message is never silently dropped: a failed send returns an error, the assistant says so (example 8), and the
prepared message stays available for "try again".

## 12. Interaction with the rest of the system

- **Names by voice.** `contacts_resolve` uses aliases, then phonetic match, then the recogniser's n-best if available;
  two candidates within a small score gap means a question (example 3). Household members are preferred over contacts.
- **Dictated text.** Keep the recogniser's words; the model may fix punctuation and capitalisation only, never rephrase.
  An explicit "say it nicely" allows rewording, and the read-back shows the result.
- **Confirmation by voice.** Core's confirmation (today switched off, [current-system §2.5](../module-investigation/current-system.md))
  words the question; the follow-up window accepts "yes", "send it", "ja", "verstuur maar", "change it", "cancel".
  Any other reply cancels. The question names recipient, channel and the full text.
- **Fillers.** Signal and SMS can take seconds: the reply "Sending" is spoken right after "yes", and success or
  failure follows.
- **Text front end (a new device type, not a tool).** A `chat-telegram` (later `chat-signal`, `chat-matrix`) device
  type bridges a chat to a voice session: inbound text → `text.send` for that device, the assistant's text reply →
  `sendMessage`. Presentations degrade to text (`list` as lines, images as photos). Each chat is a device record with a
  person, `privacy: "private"`, and `allowRisky: false` by default; only chat ids assigned in admin are accepted, all
  others are ignored. This reuses the voice-session machinery ([current-system §4.3](../module-investigation/current-system.md))
  and the routing, and keeps "who is asking" exact. It belongs with the device and front-end work, so it should be
  designed in that track.
- **Assistants.** No template; every general assistant may get `messages_unread` and `message_prepare`; `send` follows
  policy.
- **Other modules.** Uses `contacts.resolve` from google; offers "announce on the speakers instead" through the
  broadcast module; feeds unread counts to [briefing](briefing.md).

## 13. Privacy and safety

- Sending is risk class **`message`**: confirmed by default, denied on devices without `allowRisky`, and never
  authorised by voice identity alone ([module-definition §B.5](../module-investigation/module-definition-config-and-dependencies.md)).
  A TV saying "tell my boss I quit" must fail on the confirmation and the device policy.
- Accounts that send **as a person** (linked Signal, a personal mailbox) are usable only when that person is the
  resolved speaker; on a shared device the household bot is the only sender.
- Incoming messages are untrusted text: shown and read as data; a message can never trigger a tool, and a turn that
  read message text cannot send in the same tool round without a fresh confirmation.
- Children: a kids' assistant may message household members only, through the household bot.
- The sent log lets the owner see what was sent from which device; message text in it is optional (off by default).
- WhatsApp: see §5.3; never on a person's own number.

## 14. Foundations needed

Hard: **core confirmation switched on** (at least for the `message` risk class), **Tool context** (device and person),
**Connection** (channel accounts, vault). Soft: **Module store** (contacts, inbox, cursors), **Requirements and
health** (signal-cli), **Notification service** (announce rules), **Presentation** (`confirm` card), **Device
capabilities** (`privacy`, `allowRisky`), people records.

**Useful first version without them:** Telegram only, household bot, recipients limited to household members whose
chat ids are configured in module settings, sending only from a screen device via the `confirm` card (a "Send" button
press is the confirmation, no spoken yes needed), and `messages_unread` from an in-memory inbox. This is low risk:
the bot can only reach the family.

## 15. Open questions

1. Which apps does the family actually use: Signal, Telegram, WhatsApp? If WhatsApp is the only one, is a dedicated
   number with an unofficial library acceptable, or is the answer "no WhatsApp"?
2. Should messages go out **as you** (linked Signal, your mailbox) or as a **household bot**? "As you" needs a known
   speaker; the bot is safe on shared devices.
3. Is spoken confirmation enough to send, or must sending also require a trusted device (`allowRisky`)?
4. Should a chat app become a text front end to the assistant (example 9), and may it control the house from outside?
5. Contacts: maintain a small list in admin, or import from Google/CardDAV?
6. Which non-Google mailboxes exist (Fastmail, Outlook, a provider's IMAP)?
7. **Disagreement with [landscape-voice-assistants §17](../module-investigation/landscape-voice-assistants.md):** it lists
   ntfy as a messaging channel. This document keeps ntfy in the **Notification service** (the assistant reaching a
   phone) and messaging for person-to-person messages, so policies and confirmation differ correctly.
