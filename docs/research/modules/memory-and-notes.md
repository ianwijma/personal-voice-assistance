# Memory and notes

Research write-up, 2026-11-17. Not an approved design. It builds on
[landscape-launchers-and-agent-tools.md](../module-investigation/landscape-launchers-and-agent-tools.md) §3.17 and
§5.11, the "household memory" rows in
[landscape-voice-assistants.md](../module-investigation/landscape-voice-assistants.md) §17 and
[landscape-automation-platforms.md](../module-investigation/landscape-automation-platforms.md) §14, and on the
[Module store](../module-investigation/shared-state-jobs-and-notifications.md) scopes and identity proposals (§4.3,
§4.6). **(unverified)** marks claims I could not confirm against a primary source.

## 1. Summary

Two related things the assistant keeps across conversations. **Memories** are short facts and preferences the
assistant should know ("Sam is allergic to nuts", "Ian takes his coffee black", "the wifi password is …"). **Notes**
are things a person asks to have stored and found again: quick voice notes, a journal entry, "the boiler code is
4417", "I parked on level 3". Both live in the Module store with a scope (household or person) and a sensitivity,
both are searchable by voice, and a small set of pinned memories goes into every turn's context so the assistant
behaves well without a tool call.

- **Priority: first wave**, right after the [Module store](../module-investigation/shared-state-jobs-and-notifications.md)
  exists. It is what makes the assistant feel personal, and it is cheap once storage is there.
- **Effort: M.** Storage, full-text search and five tools are S on top of the store. The care goes into scope and
  privacy on shared devices, the pinned-context budget, forgetting, and an admin page to read and edit everything.
  Two-way sync with Obsidian or Nextcloud is a separate M.

The landscape documents rate this S (automation §14) and M (launchers §7, voice §17); M is the honest figure because
of the privacy rules.

## 2. What others do

| Product | Model | Copy | Avoid |
|---|---|---|---|
| ChatGPT memory | Saved memories plus reference to chat history; saved automatically or on request; managed in settings (landscape §2.2, details unverified) | Explicit "remember" plus a list the user can edit | Silent automatic saving the user does not notice |
| Claude API [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) | Client-side file operations (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`) under `/memories`; the app implements storage; docs warn about path traversal, size caps and expiry | Storage under our control; caps; expiry | A file system as the model's interface: many round trips per turn, and a system prompt that tells the model to view memory before anything else |
| Hermes Agent | Curated memory with periodic nudges to save; SQLite FTS5 recall over past sessions; user modelling via Honcho (landscape §2.5) | FTS5 | Agent-written memories without review |
| OpenClaw | Memory as Markdown files plus search (landscape §3.17) | Inspectable files | — |
| Raycast | AI Memory and Notes extensions (landscape §1.1) | Notes separate from memory | — |
| Alexa+ | "Remember that …", then recall; per-profile (landscape-voice-assistants.md §1, unverified details) | Spoken confirmation of what was saved | — |
| mem0, Letta, Zep/Graphiti | Memory layers with extraction, embeddings, graphs (unverified; not checked) | — | A second LLM call per turn to extract facts |
| Obsidian, Nextcloud Notes | The owner's existing notes | Sync target | Making them the store of record |

## 3. Example conversations

1. "Hey Jeff, remember that Sam is allergic to nuts." → `remember({ text: "Sam is allergic to nuts", about: ["Sam"],
   kind: "fact", pinned: true })` → "Got it. Sam is allergic to nuts; I'll keep that in mind." Later, in a recipe
   conversation, the assistant says "This one has almonds, which won't work for Sam" without any tool call (pinned).
2. "The wifi password is pannenkoek-42." → `remember({ text, kind: "fact", sensitivity: "secret", about: ["wifi"] })`
   → "Saved as a secret. I'll only say it on a private device or show it on screen."
3. "What's the wifi password?" on the kitchen speaker (shared) → `recall({ query: "wifi password" })` returns
   `secret, withheld on shared device` → "I've put it on the kitchen screen." On a device with no screen: "I'll only
   say that on a private device. Ask me on your phone, or I can spell it if you say 'yes, read it'." **Screen
   optional.**
4. "Note: the plumber said the valve under the sink needs replacing." → `note({ text })` → "Noted."
5. "What did the plumber say?" → `recall({ query: "plumber" })` → "On Tuesday you noted that the valve under the sink
   needs replacing."
6. "Journal: long walk with the dog, felt good." → `note({ text, notebook: "journal" })` → "Added to your journal."
   "What did I write in my journal last week?" → `read_notes({ notebook: "journal", since: "7 days" })` → a short
   summary.
7. "Forget what I said about the plumber." → `forget({ query: "plumber" })` finds one note → "Deleted your note about
   the plumber and the valve." Two matches → "I have two: the valve note from Tuesday and the invoice note from
   October. Which one?"
8. **Ambiguous scope:** "Remember I don't like coriander." on a shared device whose default person is Ian. The speaker
   may not be Ian → "Saved for Ian. If that wasn't you, say 'that's for Anna'."
9. **Failure:** "Remember the alarm code is …" when the household policy forbids storing security codes → "I won't
   store alarm codes. Keep those in your password manager."
10. **Failure:** store unavailable (database locked or migrating) → "I can't save notes right now. Say it again in a
    minute?"

## 4. Tools

Five tools; `recall` searches memories and notes together, so the model never has to pick.

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path without LLM |
|---|---|---|---|---|---|---|
| `remember` | `text: string` (≤ 500 chars), `about?: string[]` (people, places, things), `kind?: "fact" \| "preference" \| "instruction"`, `scope?: "household" \| "me"`, `sensitivity?: "normal" \| "private" \| "secret"`, `pinned?: boolean`, `until?: string` (expiry, "after Friday") | `{ id, saved: text, scope, person?, pinned, replaced? }` | W | changes data | < 20 ms | Yes: "remember that …" with the rest as text |
| `recall` | `query: string`, `about?: string`, `kinds?: ("memory" \| "note")[]`, `since?`, `limit?: 1–10` | `{ items: [{ id, text, kind, at, scope, withheld? }], more }` | R | safe | < 30 ms (FTS) | Partly |
| `forget` | `query?: string`, `id?: string`, `all?: "today" \| "about"` | `{ deleted: [...] }` or `{ candidates: [...] }` | W | changes data | < 20 ms | Yes, with a candidate list |
| `note` | `text: string` (≤ 4,000 chars), `notebook?: string` ("journal", "ideas", default "notes"), `scope?` | `{ id, notebook, at }` | W | changes data | < 20 ms | Yes: "note …", "journal …" |
| `read_notes` | `notebook?`, `since?`, `until?`, `limit?` | `{ items, more }` | R | safe | < 30 ms | Yes |

`recall` and `read_notes` are `speculative: true`. `remember`, `note` and `forget` are not, but they are cheap and
undoable (§6), so no confirmation is needed except for `forget` with `all`. Under module-definition §B.5 they are
`read` and `change`.

**Replace, do not duplicate.** `remember` first searches for a memory about the same subject; when one exists ("Ian's
coffee: with milk") it replaces it and returns `replaced`, and the assistant says "Updated: black, not with milk."

## 5. Integrate or build

### 5.1 Store

| Option | For | Against |
|---|---|---|
| **The [Module store](../module-investigation/shared-state-jobs-and-notifications.md) (SQLite via `@effect/sql-sqlite-node` on `node:sqlite`) with FTS5** | Scopes, change log, backup, undo come with the foundation; FTS5 gives ranked keyword search with prefix queries | FTS5 availability in Node's bundled SQLite build is assumed, not checked (unverified); falls back to `LIKE` |
| Markdown files per person and notebook (OpenClaw, Hermes) | Human-readable, sync-friendly | No transactions; search needs an index anyway |
| Claude memory tool (`memory_20250818`) | The model is trained for it | Claude API only; file-operation round trips; we would still implement storage |
| mem0 or Letta | Extraction and embeddings | A service, a second LLM call per turn; conflicts with local-first |

Recommendation: the store with FTS5, rows as the record, a Markdown export (§5.4).

### 5.2 Search

A household accumulates hundreds of memories and a few thousand notes over years. FTS5 with a `unicode61
remove_diacritics 2` tokenizer handles "café"/"cafe", prefix search handles "plumb*". Dutch compounds ("loodgieter"
for "plumber") are the gap: keyword search does not translate. Options in order:

1. FTS5 plus the model writing the query in the language the note was likely written in (cheap; instructions only).
2. Synonyms via the `about` tags the model writes on save (people, places, topics in both languages).
3. Local embeddings later: a small multilingual model (for example `multilingual-e5-small` in ONNX) through
   `@huggingface/transformers` or sherpa-onnx's runtime, vectors in a plain table with brute-force cosine (thousands of
   rows is fine without `sqlite-vec`, a native extension). Unverified model size and speed; measure on the server.

### 5.3 What is injected and what is retrieved

| Kind | Path | Why |
|---|---|---|
| Pinned memories for the current person and the household (allergies, names, standing preferences, "speak slowly to grandma") | A context provider adds them to the per-turn `context` (current-system.md §1.1: 50 ms budget, not in the cached prefix) | The assistant must act on them without deciding to look; safety facts must not depend on a tool call |
| Everything else (notes, unpinned memories, journal) | `recall` / `read_notes` | Keeps context small |
| Secrets | Never injected; `recall` only, with the device rule in §13 | — |

Budget: pinned lines capped at 800 characters per turn (about 200 tokens), newest last, a warning in admin when the
cap cuts something. The `remember` tool pins `kind: "instruction"` and safety facts by default (the model sets
`pinned`; the admin can change it). Whether 200 extra context tokens per turn change `llmFirstToken` is to be measured
with `TurnTrace` before pinning is on by default (shared-state §7 asks the same for ambient facts).

The stable part, the instructions block ("When the user states a lasting fact about the household or a person, offer
to remember it; never save secrets unless asked; say what you saved"), goes in the module's `instructions`, which are
part of the cached prefix.

### 5.4 Sync with Obsidian, Markdown, Nextcloud

| Target | Mechanism | Notes |
|---|---|---|
| Markdown folder | One-way export: `memory/<person>.md`, `notes/<notebook>/<yyyy-mm-dd>.md`, written on change | Simplest; Syncthing or a mounted share carries it anywhere; secrets excluded |
| Obsidian | The export folder inside the vault, or the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) (`/vault/{path}`, `/search/simple/`, bearer key, HTTPS on 27124) | The REST API works only while Obsidian runs on that machine; the plugin also offers an MCP endpoint usable through the [MCP client](mcp-client.md) |
| Nextcloud Notes | [Notes API v1](https://github.com/nextcloud/notes/blob/main/docs/api/README.md) at `/index.php/apps/notes/api/v1/notes`, Basic auth with an app password | A [Connection](../module-investigation/module-definition-config-and-dependencies.md) in the vault; ETag-based sync details not checked |
| WebDAV (any) | Write Markdown files | Generic |

Recommendation: our store is the record. Ship the one-way Markdown export first; two-way sync (import edits made in
Obsidian) later, with "last writer wins per note, keep the other as a conflict copy". Memories stay one-way: an edit
in a file must not silently change what the assistant believes about a person.

## 6. Data

| Collection | Scope | Schema (rough) |
|---|---|---|
| `memories` | household or person | `{ text, about: string[], kind, sensitivity, pinned, source: { said, deviceId, assistantId, at }, until?, lastUsedAt, useCount }` |
| `notes` | household or person | `{ text, notebook, about: string[], sensitivity, createdAt, source, audioRef? }` |
| `notes_fts`, `memories_fts` | module-owned SQL | FTS5 virtual tables over `text` and `about` |
| `sync_state` | household | `{ target, path, etag?, syncedAt }` |

Scopes follow shared-state §4.3: a "me" item takes the person from [Tool context](../module-investigation/shared-state-jobs-and-notifications.md)
(§4.5), falling back to the device's default person; with no person known, the tool asks or saves to the household
with a note in the reply. The change log gives "undo that" and "what did I tell you today?". Other modules read only
through a declared read-only export of pinned memories (for example a `kitchen` module checking allergies), never the
tables. The `audioRef` points at a saved recording only when the owner turned "keep the audio of voice notes" on
(`recordings/` exists, current-system.md §7.1).

## 7. Long-running work and events

- A daily [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md) job deletes memories past `until`
  ("the plumber comes Thursday") and lists stale ones (unused for a year) for review in admin. It never deletes those
  by itself.
- The export job runs debounced after changes (30 s) and nightly.
- Events emitted: `memory.saved`, `memory.forgotten`, `notes.added`, so a screen can refresh and an automation can
  react ("when a note in 'shopping' is added …"). Listens to: person records changing (a renamed person updates
  `about`).
- Restart: nothing in flight matters; writes are transactional.

## 8. Presentation

| Situation | Screen ([Presentation](../module-investigation/presentation-and-device-capabilities.md)) | No screen |
|---|---|---|
| `remember` | a small `card` "Remembered: …" with an Undo action, `glance` lifetime | The spoken echo of what was saved |
| `recall` with several results | `list`, newest first | Top one, "and two more" |
| A secret on a shared screen | `facts` with the value, marked `personal`, `moment` lifetime; not shown on `public` devices | Withheld (§13) |
| `read_notes` (journal) | `list` with dates; tap to open as `text` | A spoken summary |
| `forget` with candidates | `list` with `pick: true` | Spoken choices |

The character takes a small "noting" gesture once `turn.activity` exists (docs/CHARACTERS.md §5.2, DESIGNED-ONLY).
Admin gets a Memory page: per person and household, search, edit, pin, delete, export, with the source sentence and
device of each item.

## 9. Notifications and proactive behaviour

None by default. Proactive use of memory is the pinned context, which acts only when the user is talking. Possible
later, opt-in: an evening `low` prompt "Want to add anything to your journal?" on the person's private device, and a
monthly "I have 12 memories you haven't used in a year; review them in Settings" to the owner's inbox
([Notification service](../module-investigation/shared-state-jobs-and-notifications.md)).

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | members (Person records, shared-state §4.6); what may never be stored (alarm codes, bank PINs, passwords other than wifi); auto-suggest saving facts (off / ask / on) | —, codes and PINs blocked, ask |
| Module | pinned budget (characters); secrets allowed; keep audio of voice notes; export folder; sync target and connection; FTS language | 800; yes; off; none; none; nl+en |
| Assistant | on/off; may read person-scoped memories; may write; pinned context on | on; yes; yes; on |
| Device | inherited from [Device capabilities](../module-investigation/presentation-and-device-capabilities.md) `place.privacy` (private / shared / public) and default person | shared |
| Person | private by default ("my" items not readable by others); own notebooks; journal on/off | private |

No secrets, except a Nextcloud app password or Obsidian API key when sync is on (vault). First run: add household
members, set each device's default person and privacy, decide on the blocked list.

## 11. Native tools and dependencies

| Dependency | Where | When missing |
|---|---|---|
| `node:sqlite` with FTS5 (through the store) | server | FTS falls back to `LIKE` search; admin shows "search is basic" |
| An embedding model (optional, later) | server | Keyword search only |
| Obsidian running with the Local REST API plugin | the owner's desktop | Sync paused; status line "Obsidian not reachable" |
| Nextcloud | LAN or internet | Sync paused |

Nothing here needs internet; the module works fully offline.

## 12. Interaction with the rest of the system

**Speech recognition.** Names are the weak point ("Sam" heard as "Psalm", "Anna" as "Hannah"). On save, the model
matches `about` against household member names and says the name back ("Sam is allergic to nuts"), so a mishearing is
audible. Passwords dictated by voice are unreliable (case, digits, symbols); the assistant reads back secrets letter by
letter with the NATO alphabet on request, and the admin page or a typed message is the better way to enter them.
Recognisers also mangle numbers in codes ("forty-four seventeen" vs "4417"); core's `ValueParsing` normalises digits
before saving.

**Fillers.** None needed: all tools are local and fast.

**Agents and assistants.** Every assistant gets `recall` and `remember`; a children's assistant gets them without
person-scoped reads. A "Journal" assistant template (a calm persona, only `note` and `read_notes`, a private-device
phrase such as "hey diary") is a candidate. On the Claude subscription path the tools arrive as
`mcp__assistant__remember` etc.; Claude Code's own memory features are off there (built-in tools disabled,
current-system.md §2.6), so this module is the only memory on every backend.

**Intents (Jev).** "Remember that …", "note …", "journal …", "what's the wifi password" are good typed actions with
`examples`: the text after the trigger is the parameter, no model needed.

**Other modules.** A `lists` module owns shopping and to-do lists; "note that we need milk" should go to the list, and
the instructions say so. [Web search](web-search.md) research reports are stored by that module but can be found with
`recall` if it exports them. `kitchen` reads pinned allergies.

## 13. Privacy and safety

- **Scopes.** Person items are visible only when the actor is that person (device default, or chosen on a screen),
  and in admin. Household items are visible to every assistant that has the module. Speaker identity is a selection
  hint, never an authorisation (shared-state §4.6): a person-scoped `private` item asked for on a shared device with an
  uncertain speaker is answered with "That's in Ian's private notes" rather than the content.
- **Secrets on shared devices.** `secret` items are never in context or history beyond the turn that read them: the
  tool result reaching the model says `[secret withheld: shown on Kitchen iPad]` and the value goes only to the
  presentation; on a `private` device, or after an explicit "yes, read it", it is spoken. `TurnTrace` and logs must
  not record the value (a redaction rule on the tool's output).
- **Forgetting.** `forget` deletes the row and its FTS entry; the change log keeps an op record without the text
  (only id and "deleted"), so forgetting really forgets. Backups are the exception: a forgotten item survives in
  backups for their retention (14 days, shared-state §4.8); the admin says so.
- **Guests and children.** A device in guest mode (or an assistant without the module) has no access. Children cannot
  read adults' private items; household items such as the wifi password are fine.
- **Prompt injection.** Notes may contain text pasted from elsewhere; `recall` results are marked as stored content,
  not instructions.
- **Blocked content.** The household blocked list (alarm codes, PINs) is checked on save with simple patterns and the
  model's own judgement; it is a guard rail, not a guarantee.

## 14. Foundations needed

| Foundation | For | Without it |
|---|---|---|
| [Module store](../module-investigation/shared-state-jobs-and-notifications.md) | everything | A JSON file per scope under `data/modules/memory/` with in-memory search: acceptable for a single-person first version |
| [Tool context](../module-investigation/shared-state-jobs-and-notifications.md) and Person records | person scope, device privacy | Household scope only, one owner |
| [Device capabilities](../module-investigation/presentation-and-device-capabilities.md) (`place.privacy`) | the secrets rule | Treat every device as shared: secrets shown only in admin |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | undo cards, secrets on screen | Speech only |
| [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md) | expiry, export | Expiry checked lazily on read |
| [Connection](../module-investigation/module-definition-config-and-dependencies.md) | Nextcloud sync | Markdown export only |

A useful first version: household-scope memories and notes in a JSON file, the five tools, pinned memories in
context, no secrets, an admin list. It already covers "remember Sam's allergy" and "what did the plumber say".

## 15. Open questions

1. **Who is in the household** and do you want per-person memories now, or household-only until Person records
   exist?
2. **Automatic saving**: should the assistant save facts it hears without being asked (with a spoken "I'll remember
   that"), only offer ("Want me to remember that?"), or only on "remember"?
3. **Secrets at all?** Is the wifi password the kind of secret you want stored, and should secrets ever be spoken on
   a shared speaker after "yes, read it"?
4. **Pinned context cost**: accept about 200 extra tokens per turn for pinned memories, pending a `TurnTrace`
   measurement?
5. **Sync direction**: one-way export to Markdown/Obsidian enough, or must notes written in Obsidian or Nextcloud come
   back?
6. **Keep the audio of voice notes**, or transcripts only?
7. **Lists versus notes**: should "note that we need milk" go to a shopping list module (not yet designed) or stay a
   note?
8. **Embeddings**: worth a local embedding model for Dutch/English cross-language recall, or is keyword search plus
   tags enough?
