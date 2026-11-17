# Documents (household paperwork and files)

Research write-up, 2026-11-18. Not an approved design. Shared foundations (Module manifest, Connection, Module store,
Scheduler, Event bus, Notification service, Tool context, Presentation, Device capabilities) are worked out in
[`../module-investigation/`](../module-investigation/) and linked, not redesigned. **[unverified]** and **[from
memory]** mark claims not confirmed in a primary source today. Latency figures are estimates to measure with
`TurnTrace`.

## 1. Summary

The module answers questions about the household's paperwork and files. "When does the car insurance expire?" "What's
our policy number with Centraal Beheer?" "How do I descale the coffee machine?" "Is the dishwasher still under
warranty?" It finds the document and gives the one fact asked for. It can show the page on a screen or hand the file to
a phone. Sources are Paperless-ngx (the main provider), a Nextcloud or WebDAV folder, and a local folder on the server.
Answers come from structured fields first, then full-text search, and only then from passages retrieved by meaning
(local embeddings) for the model to read. Documents are **owner-only by default**. Their content is never spoken on a
shared device unless the owner allows it.

**Boundary.**

- [memory-and-notes.md](memory-and-notes.md) holds short facts people *say* ("the boiler code is 4417"). This module
  holds facts that live in *files*. A fact read from a document is never copied into memories automatically.
- [google.md](google.md) `drive_find` finds Drive files by name and metadata. Drive as a full-text source here is
  possible later through that module's Connection.
- Reading a whole document aloud uses [read-aloud.md](read-aloud.md), and only on a private device.
- Warranty and renewal dates *remind* through [reminders.md](reminders.md).

- **Priority: second wave.** It is valuable to the owner and the landscape surveys name it
  ([automation §11](../module-investigation/landscape-automation-platforms.md#11-self-hosted-household-apps-integrate-or-build)),
  but it needs Tool context, person resolution and device privacy before it is safe on any shared device.
- **Effort: M.** Paperless-ngx read-only (search, custom fields, preview, hand-off) is **S–M**. A folder source with our
  own text index adds M. Embedding-based question answering and fact extraction with owner review add **L**.

## 2. What others do

| Product | How it works | Copy | Avoid |
|---|---|---|---|
| Paperless-ngx | OCR, tags, correspondents, document types, custom fields (dates, money, text), full-text search, per-object permissions ([API](https://raw.githubusercontent.com/paperless-ngx/paperless-ngx/dev/docs/api.md)). Since 3.0 it has built-in AI: suggestions, a vector index and **document chat** over the documents the user may see, with Ollama, Hugging Face or OpenAI-compatible backends ([guide](https://wz-it.com/en/blog/paperless-ngx-ai-setup/), **[secondary]**). v3.5.0 is the latest release ([releases](https://github.com/paperless-ngx/paperless-ngx/releases)) | Custom fields as the answer to "when does X expire"; permissions per document | Making the voice assistant a second document manager |
| paperless-ai, paperless-gpt | Third-party add-ons: RAG chat and tagging (paperless-ai), LLM OCR and titles (paperless-gpt) ([paperless-gpt](https://github.com/icereed/paperless-gpt)) | — | Running three AI layers over the same documents |
| Nextcloud | WebDAV files at `/remote.php/dav/files/<user>/`, RFC 5323 `SEARCH` ([docs](https://docs.nextcloud.com/server/stable/developer_manual/client_apis/WebDAV/search.html)), a Context Agent with MCP ([automation §11](../module-investigation/landscape-automation-platforms.md#11-self-hosted-household-apps-integrate-or-build)) | Standard WebDAV as a source | — |
| ChatGPT / Claude projects | Upload files, ask questions, citations | Answer with the document named and dated | Sending every household document to a hosted model by default |
| Alexa, Google | No household-document feature | — | — |

## 3. Example conversations

1. On Ian's phone: "When does the car insurance expire?" → `documents_fact({ question })` finds the Paperless
   document typed *Polis* from *Centraal Beheer* with custom field `Expires = 2027-03-31` → "On 31 March 2027,
   according to your Centraal Beheer policy from April 2026."
2. "Remind me a month before." → creates a reminder through the reminders module: "I'll remind you on 1 March."
3. "Show me the policy." → on the phone: the first page as an image, with "Open the PDF" as a `handoff`. **Screen.**
4. "How do I descale the coffee machine?" → finds the *Manual* tag, *Philips EP2231*, and retrieves the descaling
   passage → "Hold the aqua-clean button for five seconds, then …" (manuals are `household`, so this works in the
   kitchen).
5. "Is the dishwasher still under warranty?" → purchase date 2024-06-12 from the receipt, warranty 24 months → "No,
   it ended in June. The receipt is from Coolblue, if you want to claim anyway." (if Coolblue extended it, the field
   says so)
6. **Shared device.** In the kitchen: "What's our mortgage interest rate?" → "That's in a private document, so I won't
   read it here. I've sent it to your phone."
7. **Ambiguous.** "When does the insurance expire?" → three policies → "Car, home or travel insurance?"
8. **Not found.** "Where's the warranty for the fridge?" → "I couldn't find a fridge receipt or warranty in
   Paperless. The closest is the AEG manual from 2021."
9. **Failure.** "What's the policy number?" with Paperless down → "Paperless isn't answering, so I can't look in your
   documents right now."
10. **Low confidence.** A fact the model extracted but the owner never confirmed → "The 2026 statement seems to say
    €1,240 a year, but I'm not certain. Want me to show you the page?"

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `documents_search` | `query`, `type?` (policy, manual, receipt, contract…), `correspondent?`, `since?`, `max?` ≤ 5 | hits: `ref`, title, type, correspondent, date, sensitivity, snippet (withheld per §13) | R | safe | 0.2–1 s (Paperless); < 50 ms (own FTS) | no |
| `documents_fact` | `question`, `ref?` | the answer with source `{ ref, title, date, page }`, `confidence: field \| confirmed \| extracted \| passage` | R | safe | 0.3–2 s; plus a model round when passages are read | no |
| `documents_passages` | `ref?`, `question`, `max?` ≤ 4 | passages (≤ 1,500 chars each) with page numbers, for the model | R | safe | 0.1–1.5 s (embedding the question + search) | no |
| `documents_show` | `ref`, `page?`, `to?: "here" \| "my phone" \| device` | a page image on a screen, or a `handoff` link | R | outward-facing (content leaves the server to a device) | 0.5–2 s (render) | yes ("show it on my phone") |
| `documents_recent` | `days?` | newly added documents | R | safe | < 1 s | yes |
| `documents_expiring` | `within?` (default 60 days) | documents with an expiry or warranty end in the window | R | safe | < 100 ms (fact table) | yes |
| `documents_fact_confirm` | `factId`, `value?` | the confirmed fact | W | changes data | < 50 ms | no (admin page as well) |

Read tools are `speculative: true` except `documents_show`. Nothing writes to Paperless in this version: uploading
and tagging are later (§5.6).

## 5. Integrate or build

### 5.1 Paperless-ngx: the main provider

Facts from the API documentation in the repository ([api.md](https://raw.githubusercontent.com/paperless-ngx/paperless-ngx/dev/docs/api.md)):

- **Auth**: `Authorization: Token <token>`. The token comes from "My Profile" or `POST /api/token/`. Use a dedicated
  Paperless user per household member with Paperless's own permissions (`owner`, `set_permissions.view.users/groups`).
  The module then sees only what that person may see.
- **Versioning**: `Accept: application/json; version=10`. Versions 9 and 10 are supported, and anything else returns
  406. Read `X-Api-Version` at connect and pin the version ([landscape automation §13](../module-investigation/landscape-automation-platforms.md#13-mistakes-to-avoid) warns about the 406 break in
  v3).
- **Search**: `GET /api/documents/?query=<full text>`, `more_like_id=`, `title_search=`, plus filters on
  `document_type__id`, `correspondent__id` and `tags__id__all` **[filter names from memory]**. Custom fields:
  `custom_field_query=["Expires", "range", ["2026-11-18", "2027-01-18"]]`. Autocomplete:
  `/api/search/autocomplete/?term=`.
- **Files**: `/api/documents/{id}/preview/`, `/thumb/`, `/download/` (`?original=true` for the original file),
  `/metadata/`.
- **Built-in chat (3.x)**: exists, but its API endpoint was not confirmed today **[unverified]**. It answers with
  Paperless's own model configuration.

**Recommendation.** Use Paperless as a **search and field store**, and let *our* assistant's model do the wording.
That keeps one model choice and one privacy decision (§13). Paperless's own chat is an optional backend for
`documents_fact` when the owner already runs it with a local model: "ask Paperless" instead of retrieving passages.

### 5.2 Folder sources: Nextcloud/WebDAV and a local folder

| Source | Access | Index |
|---|---|---|
| Nextcloud / any WebDAV | `PROPFIND` for listing with `getetag` and `getlastmodified`; `GET` for files; Nextcloud `SEARCH` (RFC 5323) on `/remote.php/dav/` ([docs](https://docs.nextcloud.com/server/stable/developer_manual/client_apis/WebDAV/search.html)); Basic auth with an app password (Connection) | Ours: Nextcloud's search finds names and metadata; full-text search needs its Full Text Search app with Elasticsearch **[unverified]** |
| Local folder on the server | `fs` with a watcher | Ours |

Our index: text from PDFs with `pdfjs-dist`, DOCX with `mammoth` **[package choice unverified]**, plain text and
Markdown. Scanned PDFs without a text layer need OCR: `ocrmypdf` (Tesseract) as an optional native tool, or "put it
through Paperless". Text goes into an FTS5 table per chunk (about 1,000 characters, with page numbers), in the Module
store.

### 5.3 Question answering: full text or embeddings

| Approach | Good at | Weak at | Cost |
|---|---|---|---|
| **Structured fields** (Paperless custom fields; our confirmed facts) | "When does X expire", "policy number", "amount" | Anything not entered | none; exact |
| **Full-text search** (Paperless `query`, our FTS5 with `unicode61 remove_diacritics 2`) | Names, numbers, model numbers ("EP2231"), exact terms | "Descale" vs "ontkalken"; questions phrased unlike the text | < 50 ms |
| **Embeddings** (passages by meaning) | Manuals, "how do I…", Dutch documents asked about in English | Exact numbers; needs a model and an index | ms per query on CPU; indexing minutes per hundred documents **[estimate]** |

**Local embedding model.** Use [EmbeddingGemma-300M](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX)
in ONNX through `@huggingface/transformers` (q8 or q4; the card warns fp16 does not work). Its 768 dimensions can be
truncated (Matryoshka), for example to 256. Multilingual coverage is claimed by Google **[unverified for Dutch
quality]**. The alternative is `multilingual-e5-small`, as proposed in
[memory-and-notes §5.2](memory-and-notes.md#52-search). Vectors go in a plain table with brute-force cosine: a
household's 20,000 chunks × 256 floats is about 20 MB and scans in tens of milliseconds **[estimate]**. `sqlite-vec`
(a native extension) only if that proves slow. The same model serves memory-and-notes and news clustering, loaded
once.

**Pipeline for `documents_fact`:**

1. Fields: does a typed field answer it?
2. If not, a hybrid search: FTS and vector results merged by reciprocal rank.
3. The top 3–4 passages go to the model, with title, date and page, marked as untrusted document text.
4. The model answers with the source named. The tool returns `confidence`, and anything below `field` or `confirmed`
   is said with a hedge (example 10).

**Fact extraction (later).** An overnight job asks the model, per new document of a known type, for
`{ expires, renews, policyNumber, amount, warrantyMonths, purchaseDate }`. It stores them as **unconfirmed facts**
and lists them in admin for the owner to confirm. It writes them back to Paperless custom fields only after
confirmation. This makes "when does it expire" fast and exact next time, and it never puts an unchecked number in a
reminder.

### 5.4 Manuals and warranties

- **Manuals**: a document type or tag `Manual`, with the appliance and model. They are household-scoped, not
  sensitive, and served by passages. A manual missing from the archive could be found with
  [web-search](web-search.md) ("find the manual for the Philips EP2231") and saved into Paperless by the owner. This
  module does not download it on its own.
- **Warranties**: purchase date (receipt), warranty months (a field, or a default per shop), and expiry computed. Dutch
  consumer law can give longer rights than the shop's warranty **[legal detail not researched; say "the shop's
  warranty", nothing more]**.
- **`documents_expiring`** feeds a monthly `low` inbox item and, on request, reminders.

### 5.5 Showing a page, handing to a phone

- **Render**: Paperless's `/thumb/` for a small image. For a full page, render the PDF page on the server with
  `pdftoppm` (poppler-utils, native) or `pdfjs-dist` with `@napi-rs/canvas` **[package choice unverified]**. Then
  serve it through `/media/<hash>` with a short lifetime (`moment`), never cached beyond the presentation.
- **Hand-off**: a `handoff` QR or a notification to the person's phone with a **one-time link** to our server (a
  random token, valid 10 minutes, bound to the person, proxying `/download/`). The Paperless token and URL never reach
  a device.
- Target choice follows [presentation §6.3](../module-investigation/presentation-and-device-capabilities.md): "my
  phone" is the person's private device.

### 5.6 Scanning with a device camera (later)

A screen device with a camera could take a photo in the page (`getUserMedia`, then a still) and upload it to Paperless
with `POST /api/documents/post_document/` **[from memory]**, where Paperless OCRs and files it. This needs its own
consent design for cameras ([presentation §5.2](../module-investigation/presentation-and-device-capabilities.md)
`camera`: "never used without its own consent design"), an owner-only flow, and it is a write. Out of scope for the
first versions. Paperless's own phone apps and consume folders already cover scanning well.

## 6. Data

| Collection | Scope | Rough schema | Readable by others |
|---|---|---|---|
| `sources` | household | `{ id, kind: paperless \| webdav \| folder, url, connectionId, person? }` | — |
| `docs` | person or household (from the source's permissions) | `{ ref, sourceId, externalId, title, type, correspondent, date, sensitivity: household \| private \| secret, etag, pages }` | — |
| `chunks` + `chunks_fts` + `chunks_vec` | as `docs` | `{ ref, page, text, vector? }` (folder sources; Paperless passages are fetched on demand and cached for 7 days) | — |
| `facts` | as `docs` | `{ ref, key, value, unit?, page, status: field \| confirmed \| extracted, extractedAt }` | reminders (dates via an export) |
| `handoffs` | person | `{ token, ref, expiresAt, used }` | — |

**Sensitivity** comes from Paperless tags (owner-chosen, for example `private` or `secret`), or from document types
the owner marks (medical, tax, bank, identity documents are `private` by default), or from folder rules.

## 7. Long-running work and events

- **Sync** (Scheduler `recurring`, every 30 min): Paperless `GET /api/documents/?modified__gt=` **[filter from
  memory]**, WebDAV `PROPFIND` etags, a local folder watcher. New and changed documents get chunked and embedded in a
  low-priority `task` (`nice`, one at a time), so it never competes with speech.
- **Fact extraction** (nightly `task`, opt-in, only new documents).
- **Expiry check** (daily): emits `documents.expiring { ref, key, date }`.
- **Events emitted:** `documents.added`, `documents.expiring`. **Consumed:** none.
- **Restart:** the index persists; interrupted indexing resumes from the last etag.

## 8. Presentation

- **Search results**: `list` with type icon, title, correspondent and date. Snippets only on private devices.
- **A fact**: a `card` with the answer large, and the source document and page as a subtitle. "Show the page" is an
  action.
- **A page**: `image` with `moment` lifetime and the `personal` mark, never pinned. Pages are not shown on `public`
  devices at all.
- **Without a screen**: the fact with its source in one sentence ("31 March 2027, from your Centraal Beheer policy"),
  then "Want it on your phone?"
- The character takes the Orbit layout and a "looking it up" pose while searching (`turn.activity`).

## 9. Notifications and proactive behaviour

- Monthly `low` inbox item to the owner: "Two things expire in the next 60 days: travel insurance on 2 January, the
  passport of Sam on 14 January." It goes on the owner's private devices only, and never as a spoken announcement.
- New unconfirmed facts: a `low` admin badge.
- Nothing is spoken unprompted.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | who may use documents at all; types that are private by default | owner only; medical, tax, bank, identity, contracts |
| Module | sources (Paperless URL, WebDAV URL, folder path); index folders on/off; embeddings on/off and model; fact extraction on/off; model for passages (the assistant's, or a fixed local model) | —; on; off; off; the assistant's |
| Assistant | on/off (off for kids' and guest assistants, and by default for every assistant except the owner's main one) | off |
| Device | may show document pages; may speak `household` document facts; may speak `private` ones | private devices: yes / yes / yes; shared: no / yes / no; public: no / no / no |
| Person | own Paperless token (Connection); own folders | — |

**First run:** connect Paperless (URL and token; **Test** shows "Paperless 3.5, API v10, 1,284 documents visible to
Ian"), mark sensitive types and tags, choose devices, then optionally switch on embeddings (with a time estimate for
the first index).

## 11. Native tools and dependencies

| Need | Where | When missing, the assistant says |
|---|---|---|
| Paperless-ngx | LAN | "Paperless isn't answering, so I can't look in your documents right now." |
| Embedding model (~300 MB **[unverified size for q8]**) | server, downloaded like speech models | keyword search only; admin shows "search by meaning is off" |
| `pdftoppm` (poppler-utils) | server, optional | page images fall back to Paperless thumbnails: "I can only show a small preview." |
| `ocrmypdf` + Tesseract | server, optional | scanned files in folders are skipped: "That file is a scan without text; Paperless can read it if you add it there." |
| WebDAV server | LAN or internet | that source is marked unavailable |

## 12. Interaction with the rest of the system

- **Voice.** Insurers, shops and model numbers are hard for recognisers ("Centraal Beheer" → "central beheer",
  "EP2231" → "EP twenty-two thirty-one"). Correspondent names from Paperless form a hint list for fuzzy matching.
  Numbers go through `ValueParsing`. Spoken answers read policy numbers in groups of four.
- **Fillers.** Passage search plus a model round can take two seconds; the model says "Let me look in your
  documents" first.
- **Assistants.** Only the owner's main assistant by default. A "Household admin" template is possible but adds
  little.
- **Intents.** "What expires soon" and "show it on my phone" are typed actions. Questions need the model.
- **Other modules.** Reminders (expiry and warranty), web-search (finding manuals), read-aloud (private reading),
  memory-and-notes (shared embedding model), google (Drive later), kitchen (appliance manuals).

## 13. Privacy and safety

- **Owner-only by default.** Every other person and assistant is off until the owner switches them on. Paperless
  permissions per person apply on top.
- **Device rule.** A `private` or `secret` document's content is never spoken or shown on a `shared` or `public`
  device. It answers "That's in a private document" and offers the phone (example 6). Speaker identification is a
  hint, never authorisation ([shared-state §4.6](../module-investigation/shared-state-jobs-and-notifications.md)).
- **The model sees document text.** With a hosted model (Anthropic API, OpenRouter, the Claude subscription), passages
  leave the house. This is the owner's decision, per sensitivity: `household` documents may go to the assistant's
  model; `private` ones only to a local model (home-model account) or as fields without passages. That is the default
  proposed here.
- **Logs.** Tool results with document text are redacted in `TurnTrace` and logs, as memory-and-notes does for
  secrets. History keeps "[document fact: policy expiry]" rather than the content after the turn.
- **Hand-off links** are one-time, short-lived and bound to a person. Page images are evicted after display.
- **Untrusted content.** A document can contain prompt-injection text. The tools are read-only, so the worst outcome
  is a wrong answer, which is why answers always name their source.
- **Children and guests**: no access.

## 14. Foundations needed

Hard: **Tool context** with person, **Device capabilities** (`place.privacy`), and **Connection** (tokens per
person). Then the Module store (index, facts), Scheduler (sync, extraction), Presentation (`card`, `image`,
`handoff`) and the Notification service (phone hand-off). **Useful first version without them:** Paperless only,
on the owner's main assistant, with every device treated as shared: `documents_search` and `documents_fact` over
custom fields and Paperless full text, answering facts but never content, and "open it in Paperless" as the hand-off.
It is S, and already answers "when does the car insurance expire".

## 15. Open questions

1. **Paperless-ngx running?** It is the recommended source. Without it, folders with our own index and OCR, which is
   more work.
2. **Hosted models and documents:** may passages from household documents go to the assistant's hosted model, and
   private ones never (proposed)? Or only a local model for everything?
3. **Who besides the owner** may ask about documents, and on which devices may facts be spoken?
4. **Embeddings**: worth a 300 MB local model and an indexing pass for "how do I descale", or is full-text search
   enough?
5. **Fact extraction** with owner confirmation: wanted, and may confirmed facts be written back to Paperless custom
   fields?
6. **Paperless's own chat** (3.x) as the answering backend instead of our retrieval: acceptable if it runs on a local
   model?
7. **Disagreement with [landscape-automation §14](../module-investigation/landscape-automation-platforms.md#14-candidate-modules-for-us),**
   which rates documents M and "Paperless read-only". This document agrees for the first version. But question
   answering over manuals and folders is the larger part of the value, and it is L.
