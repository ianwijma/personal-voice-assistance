# Contacts

Research write-up, 2026-11-18. Not an approved design. Code references are `main` at `70b15ec`. Shared foundations
are named as in [`README.md`](README.md) and linked, not redesigned. Claims marked **[unverified]** or **[from
memory]** were not confirmed in a primary source during this session.

## 1. Summary

The household address book as a shared capability: the people the house knows (members, family, friends, the
plumber), each with spoken-name aliases, how the name is pronounced and how the recogniser tends to mishear it,
relationship terms that depend on who is speaking ("my mum" is Oma for Ian and Grandma-Anna for the children), ways to
reach them, and dates (birthdays, anniversaries) that feed [reminders](reminders.md) and the [briefing](briefing.md).
It answers "who is Sam", "what's Oma's number", "when is Mum's birthday", and, as a service, resolves names for
[calls-and-intercom](calls-and-intercom.md), [messaging](messaging.md), [broadcast](broadcast.md),
[emergency-and-safety](emergency-and-safety.md), [calendar](calendar.md) and mail.

**Boundaries.** Household **members** are the `Person` records of the shared-state foundation
([§4.6](../module-investigation/shared-state-jobs-and-notifications.md#46-identity-who-said-it)): who uses the devices.
This module adds *contacts* (people the house knows, members included as a view) and the relations between them. It
takes over the contact directory that [messaging §5.2](messaging.md#52-contacts) and the `contacts_find` tool and cache
that [google §4](google.md#4-tools) define; both become consumers and Google becomes a provider (open question 1).
Sending is not here: channels and confirmation stay in messaging.

- **Priority: second wave**, built just before messaging and calls, which cannot say "Sam" without it. A first slice
  (members plus manual contacts with aliases) is small enough to come with `Person` records in Phase 4.
- **Effort: M.** Local store, resolver and admin page S–M; CardDAV import S; Google provider S (on the google
  module's Connection); birthdays to reminders and briefing S; two-way sync M and deferred.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Siri / iOS Contacts | Relationship labels on the "me" card ("Mum is Anna"), set by saying "Anna is my mother"; phonetic first/last name fields used for recognition and speech; vCard export with `X-PHONETIC-FIRST-NAME` and `X-ABRELATEDNAMES` **[from memory]** | Relations per speaker; phonetic fields | — |
| Google Contacts / People API | `names[].phoneticGivenName`, `nicknames[]`, `birthdays[].date`, `events[]` with type `anniversary`, `relations[]` with types such as `mother`, `father`, `spouse`, `child`, `brother`, `sister`, `friend`, `partner` or custom ([People API](https://developers.google.com/people/api/rest/v1/people)) | Map these fields 1:1 into our model | — |
| vCard 4.0 (RFC 6350) | `BDAY`, `ANNIVERSARY`, `NICKNAME`, `RELATED` with `TYPE` values including `parent`, `child`, `sibling`, `spouse`, `kin`, `co-resident`, `neighbor`, `friend` and **`emergency`** ([RFC 6350](https://www.rfc-editor.org/rfc/rfc6350.html) §6.2.5, §6.2.6, §6.6.6); RFC 9554 adds a `PHONETIC` parameter (`ipa`, `piny`, `jyut`, `script`) ([RFC 9554](https://datatracker.ietf.org/doc/rfc9554/)) | Use the standard fields so a CardDAV round trip keeps them | Relying on `PHONETIC` support in servers and apps **[support unverified]** |
| CardDAV (RFC 6352) servers: Nextcloud, iCloud, Fastmail, Radicale | Address books over WebDAV; Nextcloud derives a "Contact birthdays" calendar from `BDAY` **[from memory]** | Read-only import first; `tsdav` already chosen for CalDAV ([lists](lists.md), [calendar](calendar.md)) | Double birthdays when the calendar module also reads that birthday calendar |
| Alexa | Contacts imported from the phone, nicknames, Drop In permissions per contact ([Pocket-lint](https://www.pocket-lint.com/how-to-set-up-and-use-drop-in-on-amazon-echo-devices/)) | Per-contact permissions as fields on the contact | The whole phone book uploaded to a cloud |
| Home Assistant | `person` entities for members, linked to device trackers | Link a member contact to an HA `person` for presence ([smart-home §6](smart-home.md#6-data)) | — |

## 3. Example conversations

1. "Hey Jeff, who is Sam?" → "Sam is Ian's daughter; she lives here." (household relation, safe on any device)
2. Ian, study: "What's my mum's number?" → "Oma, mobile: oh-six, one-two, three-four, five-six, seven-eight." (S: a
   `facts` card; personal, only on Ian's or `private` devices)
3. Ambiguous: "Call Tom." → "Tom Bakker or Tom from football?" → "Football." The choice is remembered for this
   conversation only.
4. Relation from a child's device: "Call Grandma." → the kids' tablet's default person is Sam → Sam's `grandmother`
   relation → Oma. The same words on Ian's device have no match: "Who do you mean by Grandma?"
5. Teaching by voice: "Anna is my sister." → "Got it: Anna Visser is your sister." (writes a relation, `changes
   data`; only for the device's resolved person)
6. Pronunciation: "You're saying Sanne wrong. It's SAH-nuh." → "SAH-nuh. Thanks." (stores a respelling; the next reply
   uses it)
7. Birthdays: "Whose birthday is coming up?" → "Oma turns 80 on Saturday, and Tom Bakker's birthday is the 3rd." In the
   morning [briefing](briefing.md): "It's Lotte's birthday today."
8. Add: "Add the plumber, Jansen Installatie, 06 98 76 54 32." → "Added Jansen Installatie with that mobile number."
   (number read back digit by digit)
9. Failure: "What's Lotte's email?" → "I don't have an email for Lotte. Her contact came from your Nextcloud address
   book; you can add it there."
10. Privacy refusal on the hallway node (`public`): "What's Oma's address?" → "I don't read out addresses here."

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `contacts_resolve` | `name` (as spoken), `purpose?: "call" \| "message" \| "email" \| "broadcast" \| "any"`, `channel?` | ranked candidates: contact id, display name, relation to the speaker, reachable channels, score, `ambiguous` flag | R, speculative | safe | < 20 ms (local index) | yes |
| `contacts_find` | `query` (name, relation, company, "the plumber") | up to 5 contacts with name, relation, which fields exist (not their values) | R, speculative | safe | < 20 ms | yes |
| `contacts_details` | `contact`, `fields: ("phone" \| "email" \| "address" \| "birthday" \| "notes")[]` | the asked fields | R | safe, personal | < 20 ms | yes |
| `contacts_who_is` | `name` | one sentence: relation to the speaker and the household | R, speculative | safe | < 20 ms | yes |
| `contacts_dates` | `within?: duration` (default 14 d), `kind?: "birthday" \| "anniversary" \| "all"`, `person?` | upcoming dates with age or years when known | R, speculative | safe | < 20 ms | yes |
| `contacts_add` | `name`, `phone?`, `email?`, `relation?`, `aliases?` | the new contact, read back | W | changes data | < 50 ms (local); + provider write if two-way | no |
| `contacts_update` | `contact`, `set` (aliases, respelling, relation, birthday, channel handles) | the change, read back | W | changes data | < 50 ms | no |
| `contacts_relate` | `contact`, `term` ("mother", "sister", "boss", custom), `of?: person` (default speaker) | "Anna is your sister." | W | changes data | < 20 ms | yes ("X is my Y") |
| `contacts_say_as` | `contact`, `respelling` and/or `heardAs` | "SAH-nuh, thanks." | W | changes data | < 20 ms | yes |

**Service for other modules (no tools):** `Contacts.resolve(name, { purpose, speaker })`, `Contacts.get(id)`,
`Contacts.handles(id, channel)`, `Contacts.upcomingDates(range)`, `Contacts.emergencyContacts(person)` and
`Contacts.pronunciation(id)` for TTS, exported through the module manifest's service mechanism
([module-definition A.2](../module-investigation/module-definition-config-and-dependencies.md#a2-what-a-module-may-contribute)).

## 5. Integrate or build

**Build the directory and resolver; integrate the sources.**

| Source | How | Fields we take | Write back? | Notes |
|---|---|---|---|---|
| **Local (admin and voice)** | Module store | everything | — | The default and the only one a household needs |
| **CardDAV** (Nextcloud, iCloud with an app-specific password, Fastmail, Radicale) | `tsdav` `fetchAddressBooks` / `fetchVCards` with `sync-collection` tokens **[from memory]**; parse vCard 3/4 with `ical.js` (which also reads vCard) or a small vCard parser **[from memory]** | `FN`, `N`, `NICKNAME`, `TEL`, `EMAIL`, `ADR`, `BDAY`, `ANNIVERSARY`, `RELATED`, `X-PHONETIC-*`, `X-ABRELATEDNAMES`, `PHOTO` (optional) | later, opt-in, only our own fields under `X-PVA-*` | One Connection per address book; daily sync and on demand |
| **Google People API** | through the [google](google.md) module's Connection; `people.connections.list` with `personFields=names,nicknames,phoneNumbers,emailAddresses,birthdays,events,relations` (adds three fields to google §7's list) and a sync token | names with `phoneticGivenName`, nicknames, phones, emails, birthdays, `events[type=anniversary]`, `relations` | no (`contacts.readonly`) | One Google account per person |
| **Home Assistant `person` entities** | [smart-home](smart-home.md) Connection | name, linked HA person id for presence | no | Members only |
| Phone exports (a `.vcf` file uploaded in admin) | one-off import | as CardDAV | no | For households without a sync server |

**Merging.** Contacts from several sources are merged by normalised phone number (E.164 via `libphonenumber-js`
**[from memory]**) and email; a merged contact keeps per-source records and a local overlay (our aliases, respelling,
relations, permissions) that a sync never overwrites. Conflicting birthdays: the local value wins, else the most
recently changed source, and admin shows the conflict.

**The resolver.** Candidates from: exact alias, then relation term for the speaker, then display-name tokens, then a
phonetic key, then `heardAs` misrecognitions. The phonetic key must handle Dutch names inside English sentences; Double
Metaphone is English-centred, a Dutch-aware variant is google §12's open choice
([google §12](google.md#12-interaction-with-the-rest-of-the-system)). Score boosts: household members, the speaker's
own relations, recently contacted. Two candidates within a small gap → a question naming both with a distinguishing
word (surname, relation, group). The resolver is deterministic and local, so it runs on the fast path.

**Pronunciation.** Two fields: `respelling` (a sounds-like spelling used verbatim in TTS input, works with every
engine: "SAH-nuh") and optional `ipa` (only for engines that accept phonemes **[support per provider unverified]**).
`heardAs` lists what the recogniser produced for the name ("Sana", "Zanne") and feeds recogniser hot words where the
provider supports them (sherpa-onnx hotwords for transducer models **[from memory]**,
[stt-quality](../stt-quality.md)).

## 6. Data

| What | Scope | Shape |
|---|---|---|
| Contacts | household (shared address book) or person (a person's own, from their Google or CardDAV) | `{ id, displayName, given?, family?, aliases[], respelling?, ipa?, heardAs[], org?, phones: { e164, label }[], emails[], addresses[], birthday?: { month, day, year? }, anniversary?, notes?, personId? (a household member), sources: { connectionId, remoteId, etag }[], updatedAt }` |
| Relations | person (the "from" side) | `{ from: personId, to: contactId, term: "mother" \| … \| custom, vcardType?: RFC 6350 value, source }` |
| Channel handles | contact | `{ channel: "signal" \| "telegram" \| "email" \| "sms" \| "call-link" \| "device", address, verified }`, used by messaging and calls |
| Per-contact permissions | household | `{ contactId, mayDropIn: bool, mayRingAtNight: bool, emergency: { order, channels } }` (used by calls and emergency) |
| Sync cursors | connection | CardDAV sync token, Google `nextSyncToken` |

Readable by others through the service only; raw rows never go to a model in bulk. The ambient line carries nothing
from contacts (no names in every turn).

## 7. Long-running work and events

- **Scheduler:** daily sync per source at 04:00 and on demand; a daily job at 00:05 that publishes the day's and the
  coming week's dates.
- **Events emitted:** `contacts.changed` (id, which fields), `contacts.dates.today` (birthdays and anniversaries
  today), `contacts.dates.upcoming` (7 days). [Briefing](briefing.md) and [reminders](reminders.md) listen; the
  reminders module may create "buy a present" reminders only when the person asked for that rule.
- **Listens to:** `google.connection.changed`, CardDAV connection status.
- **Restart:** sync resumes from its token; nothing else is pending.
- **Calendar overlap:** if the [calendar](calendar.md) module reads Nextcloud's birthday calendar or Google's
  "Birthdays" calendar, the briefing must dedupe by contact id or name and date (open question 4).

## 8. Presentation

| Situation | Screen | Speaker only |
|---|---|---|
| Who is X / details | `facts` card (name, relation, the asked field), `sensitivity: "personal"` for numbers and addresses | one sentence; numbers digit by digit, in groups |
| Ambiguous name | `list` with `pick` (tap the right Tom) | the question naming both |
| Upcoming dates | `list` (date, name, age) | the first three, then "and two more" |
| Added or changed | brief `card` with the fields read back | the read-back sentence |

On `shared` devices, personal fields of a person's own contacts are not shown; household contacts are. On `public`
devices only names and relations to the household.

## 9. Notifications and proactive behaviour

- Birthdays and anniversaries are `low`: they appear in the briefing and the inbox, never spoken unprompted. A person
  may opt into a `normal` reminder at a chosen time ("tell me two days before Oma's birthday"), which is a
  [reminders](reminders.md) rule.
- A failed sync is a `low` health item for the owner ("the Nextcloud address book hasn't synced since Monday").
- No "you haven't called Oma in a while" nudges.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | shared address book on; who may edit by voice (adults); read numbers aloud on `shared` devices | on; adults; household contacts only |
| Module | sources (Connections: CardDAV address books, Google accounts, `.vcf` imports); sync time; merge rules; phonetic algorithm; which fields import (photos off) | none; 04:00; phone and email; Dutch-aware; no photos |
| Assistant | module on/off; `offTools` (a kids' assistant: no `contacts_details` for addresses) | on |
| Device | may read personal fields (by `privacy`) | private yes, shared household only, public names only |
| Person | own address book sources; own relations; birthday reminder rules | none |

**First run:** admin › Contacts shows household members (from `Person` records) and lets the owner add contacts or
connect a source. A "Say it" button plays each name with the assistant's voice so wrong pronunciations are caught
before anyone hears them in a call.

## 11. Native tools and dependencies

None on the server: `tsdav`, a vCard parser and `libphonenumber-js` are npm libraries **[package choice open]**. A
CardDAV server or a Google account is optional. When a source is unreachable the local copy answers and the
assistant says nothing about it unless asked; for a contact only in an unreachable source that was never synced: "I
can't reach your Nextcloud address book right now."

## 12. Interaction with the rest of the system

- **Speech recognition** is the hard part: names are out-of-vocabulary, Dutch names in English sentences and English
  names in Dutch ones. Hot words from aliases and `heardAs`; `heardAs` is filled from corrections ("no, Sanne") and
  shown in admin. Never guess between two candidates.
- **Speech output:** every module that speaks a contact name calls `Contacts.pronunciation(id)` so the respelling is
  used everywhere (calls ringing, broadcasts, briefing).
- **Relations depend on the speaker**: the Tool context's person (device-default, chosen, or voice-ID hint). With no
  person, relation terms resolve against household-level relations only ("the kids' grandma" if the owner set one) or
  ask.
- **Fast path:** `contacts_resolve` and `contacts_who_is` are local and deterministic; calls and broadcasts use them
  without a model.
- **Agents and assistants:** every household assistant gets read tools; editing tools for adult assistants. No
  template.
- **Other modules:** messaging (recipients, handles), calls (targets, drop-in permissions, call links), broadcast
  (person targets, voice messages), emergency (ordered emergency contacts, `RELATED;TYPE=emergency` on import),
  calendar (attendees by name), google (provider), briefing (dates), reminders (date rules), memory-and-notes
  (facts about a person stay in memory; this module keeps only address-book fields).

## 13. Privacy and safety

- Numbers, addresses and notes are `personal`. Read aloud only on `private` devices or to the resolved owner of a
  person-scoped contact; on `shared` devices only household contacts' numbers; never on `public` ones.
- A person's own imported address book (their Google contacts) is person-scoped: other household members cannot query
  it. A household book is visible to all adults.
- Children: may resolve household and family names for calls and broadcasts; do not get numbers or addresses read out.
- Voice editing: "X is my Y" writes only to the speaking person's relations, and only for a known person; changes are
  logged with device and time.
- Nothing goes to the hosted model in bulk; a turn sees only the resolved candidates it needs.
- Imports are read-only by default, so the assistant can never damage the family's real address book.

## 14. Foundations needed

[Module store](../module-investigation/shared-state-jobs-and-notifications.md#4-the-shared-data-layer) (contacts,
relations); `Person` records ([shared-state §4.6](../module-investigation/shared-state-jobs-and-notifications.md#46-identity-who-said-it));
[Tool context](../module-investigation/shared-state-jobs-and-notifications.md#45-turn-context-proposal) (speaker for
"my mum"); [Connection](../module-investigation/module-definition-config-and-dependencies.md#b4-connections-and-oauth-on-a-headless-server)
(CardDAV, Google); [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler)
(sync, dates); [Event bus](../module-investigation/shared-state-jobs-and-notifications.md#5-event-bus);
[Device capabilities](../module-investigation/presentation-and-device-capabilities.md#5-device-capabilities)
(privacy); the `records` settings field (BUILT, NOT WIRED) if contacts are edited in a module form rather than a
dedicated admin page.

**A useful first version (S):** household members plus manual contacts in a JSON file, aliases and respelling,
`contacts_resolve` and `contacts_who_is`, no relations per speaker, no sync.

## 15. Open questions

1. **Ownership, and a disagreement.** [Investigation §11 #21](../module-investigation/investigation.md#11-disagreements-between-documents)
   recommends that *messaging* owns the directory with Google as a source, and [google §4](google.md#4-tools) has its
   own `contacts_find`. I propose a separate contacts module that both use, because calls, broadcast and emergency
   need the same directory without messaging. Acceptable?
2. **Source of truth:** keep the address book here and import read-only, or treat Nextcloud/Google as the master and
   write our fields back?
3. **Who may see whose contacts** on shared devices: household book for all adults, personal books private?
4. **Birthdays from contacts or from the calendar?** Both exist (Nextcloud and Google generate birthday calendars);
   which one does the briefing trust?
5. **Teaching relations by voice** ("Anna is my sister"): allowed without a confirmed speaker identity?
6. **Pronunciation:** respellings only, or also IPA for providers that support it?
7. **Photos** of contacts on screens (caller card on a ringing call): wanted?
