# Home maintenance

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md):
module definition ([`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)),
shared state ([`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md))
and presentation ([`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md)),
cited as "module definition §n", "shared state §n" and "presentation §n".

## 1. Summary

The module treats the house as an inventory: appliances with brand, model number, purchase date, warranty end,
manual and service contact; recurring maintenance (filters, boiler service, smoke-alarm batteries, the car's MOT,
*APK* in the Netherlands); a home inventory for insurance; "where did we put the …" storage locations; and
troubleshooting an appliance from its own manual ("the dishwasher shows E24").

**Boundaries.** Recurring maintenance is delivered through [reminders](reminders.md) (RRULE storage, delivery, done
and snooze) and may appear as chores in [lists](lists.md); this module owns *what* is due and *why* (the item, the
interval, the log). Free-form facts ("the boiler code is 4711") stay in [memory-and-notes](memory-and-notes.md).
Receipts and policies as documents belong to a Paperless-ngx module (investigation §7, candidate without a document);
this module links to them.

- **Priority: second wave.** Useful every month, never urgent. The troubleshooting part is the one with a strong voice
  case: hands busy, appliance blinking, manual lost.
- **Effort: M.** Inventory and storage locations on our store are S. Maintenance schedules on reminders are S.
  Manual ingestion and search is M (PDF text, chunking, full-text search, page references). Homebox as a provider is
  S–M.

**Recommendation:** own store for items, locations and maintenance (small, voice-specific, fast path), Homebox as an
optional provider for people who already keep their inventory there, manuals indexed locally with SQLite FTS5.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| **Homebox** (fork by sysadminsmedia; the original by hay-kot is archived, from memory) | Self-hosted inventory: items in nested locations, tags (labels were converted to tags), warranty fields (lifetime, expiry, notes), purchase and sold details, maintenance entries (name, description, scheduled date), attachments typed `photo`, `manual`, `warranty`, `receipt`; asset ids and QR labels; REST API under `/api/v1` ([docs](https://2455caa7.homebox-docs.pages.dev/en/user-guide/organizing-items), [changelog](https://617e1723.homebox-docs.pages.dev/en/changelog/version/v0-23-1...latest/), [py-homebox](https://py-homebox.readthedocs.io/en/latest/api/items/)). Recent versions reportedly merge items and locations into one "entity" type (unverified). | The data model: item, location, warranty, maintenance, typed attachments. | Its API changing under us (a recent large refactor). |
| **Grocy** | Besides stock and chores: "equipment" with an attached manual and "batteries" with a charge interval, `POST /batteries/{id}/charge` to log a change ([API reference](https://unpkg.com/mcp-grocy-api@1.4.13/build/resources/api-reference.md); equipment endpoint unverified). | Battery tracking as its own simple concept: smoke alarms, remotes. | — |
| **Snipe-IT, InvenTree, Shelf.nu** | Business asset management and parts inventory. | — | Too heavy for a house. |
| **Paperless-ngx** | Scanned receipts, warranty cards and manuals with OCR and tags. | A link from an item to its receipt document. | Duplicating it. |
| **Alexa / Google** | "Where did I put my passport" via "remember" notes; no structure. | — | Free text cannot answer "what's under warranty". |
| **RDW open data** ([dataset](https://data.overheid.nl/dataset/11441-open-data-rdw--gekentekende-voertuigen)) | Dutch registered-vehicle data, CC-0, Socrata API; `vervaldatum_apk` per licence plate (YYYYMMDD), e.g. `https://opendata.rdw.nl/resource/m9d7-ebf2.json?kenteken=AB123C`. Users report refresh lag between this and the inspections dataset `vkij-7mwc` ([group thread](https://groups.google.com/g/voertuigen-open-data/c/qLr76AS8OPA)). | The APK due date filled in automatically. | Trusting one dataset blindly: show the date and its source. |

## 3. Example conversations

1. **Storage.** "Where's the drill?" → "In the shed, on the top shelf, blue case." "We put the Christmas lights in the
   attic, in the box marked X-mas." → "Noted: Christmas lights, attic, box X-mas."
2. **Not found.** "Where's the passport?" → "I don't know where the passport is. When you find it, tell me where it
   goes." It never guesses.
3. **Troubleshooting, a screen helps.** "The dishwasher shows E24." → "On your Bosch SMV4HVX31E, E24 means the water
   isn't draining. The manual says: clean the filter at the bottom, then check the drain hose for kinks. Page 52."
   The page passage is shown.
4. **Warranty.** "Is the washing machine still under warranty?" → "Bought 3 March 2024 with 2 years' warranty, so
   until 3 March 2026: it's expired. EU law may still cover defects that shouldn't happen this soon." (§13)
5. **Maintenance due.** Briefing line: "The ventilation filters are due this week. Last changed 18 May." "Done." →
   "Logged. Next time in six months, May 2027."
6. **Boiler service.** "When was the boiler last serviced?" → "12 October 2025, by Installatiebedrijf De Vries. It's
   due again in October 2026, so it's a month overdue. Want their number on your phone?"
7. **APK.** "When is the car's APK due?" → "On 14 February 2027, according to the RDW."
8. **Ambiguous.** "Change the filter." → "Which one: the ventilation filters, the cooker hood or the water filter?"
9. **Inventory for insurance, needs a screen.** "What's in the living room worth more than 500 euros?" → a `table` of
   four items with purchase prices; spoken: "Four items, 3,840 euros together: the TV, …"
10. **Failure.** Manual not uploaded: "I don't have the manual for the oven. If you know the model number, I can look
    it up on the web." (web-search, only if that module is on)

## 4. Tools

| Tool / action | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `house_where` | `thing` (text, fuzzy over item names and aliases) | Location path and note; "I don't know" | R | safe | <10 ms | yes ("where is/are …", "waar ligt …") |
| `house_put` | `thing`, `location` (dynamic over locations, or new), `note?` | Confirmation | W | `change` | <20 ms | yes ("we put X in Y") |
| `house_item` | `item` (dynamic) | Card: model, bought, warranty, manual, service contact, last maintenance | R | safe | <10 ms | yes |
| `house_item_add` | `name`, `brand?`, `model?`, `serial?`, `room?`, `bought?`, `price?`, `warranty_months?` | The item | W | `change` | <20 ms | no |
| `house_manual_search` | `item?` (default: inferred), `query` ("E24", "descale", "child lock") | Up to 3 passages with page numbers | R | safe | 10–50 ms (FTS5) | no (the model words the answer) |
| `maintenance_due` | `within?` (default 30 days), `item?` | Due and overdue tasks | R | safe | <10 ms | yes |
| `maintenance_done` | `task` (dynamic), `when?`, `by?`, `note?`, `cost?` | Logged; next due date | W | `change` | <20 ms | yes |
| `maintenance_add` | `task`, `item?`, `every` ("every 6 months", "yearly in October"), `lead_days?` | The task with next due | W | `change` | <20 ms | no |
| `maintenance_history` | `item` or `task` | Log entries | R | safe | <10 ms | yes |
| `inventory_report` | `room?`, `min_value?`, `tag?` | `table`; export link for insurance (CSV/PDF via `handoff`) | R | safe, personal (values) | <100 ms | no |
| `service_contact` | `item` or `trade` ("plumber") | Name, phone; "send to phone" offer | R | safe | <10 ms | yes |

## 5. Integrate or build

| Option | For | Against |
|---|---|---|
| **Own store** (items, locations, maintenance, log, manual index) | Fast path for "where is", our recurrence and delivery, works with nothing else running | Another inventory to keep |
| **Homebox provider** | Families who already use it get voice on their data; QR labels and photos | API churn; maintenance entries are dated, not recurring (from the docs), so recurrence would still be ours |
| **Grocy provider** | Equipment and batteries in a tool some households run for the kitchen | Equipment API unverified; no locations for non-food items |
| **Paperless-ngx link** | Receipts and warranty cards already scanned | Read-only link only |

**Recommendation.** Build the store. Offer a Homebox provider that *imports and syncs* items, locations, warranty and
manuals (read-mostly, `house_put` writes back the location), with `POST /api/v1/users/login` for a token and the
items and locations endpoints (paths from memory; check against the instance's Swagger). Recurrence stays here even
with Homebox.

**Manuals.** Upload a PDF in admin or attach a URL. The server extracts text per page with `pdfjs-dist` (already
planned for web-search), splits into passages of about 200 words keeping page numbers, and indexes them in an FTS5
table (memory-and-notes §5 already proposes FTS5 through `node:sqlite`). Error-code tables are kept as rows
(`code → meaning, action, page`) when the extractor recognises them, because "E24" is the most common query and FTS
tokenises codes poorly. Scanned manuals without a text layer need OCR (Tesseract or Paperless-ngx's OCR); not in v1.
The model answers from at most three passages and cites the page; it does not invent steps not in the passage.

**Dutch maintenance defaults** (seeded, editable; facts from memory, unverified): smoke alarms required on every floor
with a bedroom route since 1 July 2022 (*Bouwbesluit*), battery or unit check yearly, replacement after 10 years; gas
boiler (*cv-ketel*) service every 1–2 years, recommended not required; CO detector replacement per the label; APK from
RDW; ventilation (WTW) filters every 3–6 months; dishwasher filter monthly; gutters every autumn.

## 6. Data

| Table | Scope | Shape |
|---|---|---|
| `m_house__locations` | household | `{ id, name, aliases[], parentId?, room? }`: "attic › shelf 2 › box X-mas" |
| `m_house__items` | household | `{ id, name, aliases[], kind: appliance \| thing \| vehicle, brand?, model?, serial?, locationId?, bought?, priceCents?, warrantyUntil?, licencePlate?, serviceContactId?, docs: [{ kind: manual \| receipt \| warranty, mediaId \| url \| paperlessId }], provider?: { name: "homebox", remoteId } }` |
| `m_house__tasks` | household | `{ id, itemId?, name, aliases[], rrule, leadDays, assignee?, reminderId?, source: seed \| owner \| rdw }` |
| `m_house__log` | household | `{ taskId, at, by, note?, costCents?, contact? }` |
| `m_house__manual_passages` | household | FTS5: `{ itemId, page, text }`; `m_house__error_codes { itemId, code, meaning, action, page }` |

Service contacts are references into messaging's contact directory (investigation §11 #21: messaging owns contacts),
with a `trade` tag. **Exports:** `house.due(range)` (briefing), `house.items` (insurance export, video and music do not
need it).

## 7. Long-running work and events

- Each task's next occurrence is a reminder created through the reminders module's service (`for: household` or the
  assignee) with `lead_days`. Done on the reminder logs the task here (`reminders.done` → `maintenance_done`).
- A weekly job checks RDW for each vehicle's `vervaldatum_apk` and updates the APK task when it changes.
- Warranty: a job 30 days before `warrantyUntil` creates a `low` inbox item ("The TV's warranty ends next month").
- **Emits:** `house.maintenance.due`, `house.maintenance.done`, `house.item.added`. **Listens:** `reminders.done`,
  `energy.anomaly` (a freezer anomaly links to the freezer's item card and service contact).
- **Restart:** nothing of its own; reminders and the Scheduler carry the timing.

## 8. Presentation

| Situation | Kind | Without a screen |
|---|---|---|
| Item | `card` with facts (model, bought, warranty), a photo if any | Model and warranty in one sentence |
| Manual answer | `text` passage with "page 52", optional `handoff` QR to the PDF page | The steps, read one at a time ("next") |
| Due tasks | `list`, checkable (tick = `maintenance_done`) | Top three |
| Inventory | `table` with a CSV/PDF `handoff` | Count and total value |
| Where is | `text` with the location path | The path |

## 9. Notifications and proactive behaviour

Maintenance reminders at `normal` through reminders (held in quiet hours); overdue safety tasks (smoke alarms, CO,
boiler) re-announced weekly at `normal` until done; everything else `low` in the inbox and the briefing. No nagging
about non-safety tasks.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | country preset for seeded tasks (NL), currency | NL if `HOME_LANGUAGE` is Dutch (Open question 4) |
| Module | Homebox Connection (URL, user, password in the vault); seeded tasks on/off; manual uploads; RDW lookup on/off; inventory values visible on shared devices | none; on; —; on; no |
| Assistant | module on/off; `offTools` (`inventory_report`) | on |
| Device | — | — |
| Person | assignee for task kinds ("Ian does the boiler") | — |

**First run.** Pick seeded tasks and set their last-done dates; add the big appliances with model numbers (a photo of
the type plate on a screen device, read by a vision model, is a later convenience); upload manuals; enter plates.

## 11. Native tools and dependencies

| Need | Where | When missing |
|---|---|---|
| `pdfjs-dist` | server (npm) | Manuals cannot be indexed: "I can't read manuals on this server." |
| `node:sqlite` FTS5 | server | Fallback to `LIKE` search, slower and weaker |
| Homebox (optional) | LAN | Own store only |
| RDW open data (optional) | internet, no key | "I couldn't reach the RDW; the last APK date I have is …" |
| OCR (later) | server or Paperless-ngx | "This manual is a scan without text; I can't search it yet." |

## 12. Interaction with the rest of the system

- **Speech.** Model numbers are hard for recognisers ("SMV4HVX31E"); the user says "the dishwasher" and the item
  supplies the model. Error codes are short and recognised well ("E 24", "F 21" → `E24`, `F21` via normalisation).
- **Fast path.** "Where is X" and "we put X in Y" are typed actions with a local parser (English and Dutch: "waar
  ligt", "ik heb X in Y gelegd").
- **Other modules.** Reminders (delivery), lists (tasks as chores if the household prefers), memory (free facts),
  web-search (manual lookup on the web when no PDF), messaging (service contacts, "send to my phone"), energy
  (appliance anomalies), kitchen (none: food stock is the pantry's, not this inventory).
- **Assistants.** No template; a "Klusser" handyman assistant is possible later.

## 13. Privacy and safety

- Item values and serial numbers are useful to burglars and insurers; the inventory report is shown only on `private`
  devices, and values are never spoken on `shared` devices unless allowed.
- Warranty answers state the dates and, in the EU, that the legal guarantee (*conformiteit* in Dutch law, at least two
  years EU-wide and possibly longer for durable goods; from memory, not legal advice) may outlast the maker's warranty.
- Manual troubleshooting stays within the manual. Gas, electrical and boiler steps beyond user maintenance end with
  "call a technician", and the module never suggests bypassing a safety device.

## 14. Foundations needed

Module store (own tables, FTS5), Scheduler and reminders (delivery), Presentation (`card`, `list`, `table`,
`handoff`), media storage for PDFs, Connection (Homebox). **First version without most of them:** `house_where` /
`house_put` and `house_item` on a JSON or SQLite file, plus the RDW APK lookup spoken. Effort S.

## 15. Open questions

1. **Inventory home.** Do you already use Homebox, Grocy or a spreadsheet, or start in our store?
2. **Storage locations vs memory.** Memory-and-notes could hold "the drill is in the shed" as a free fact. This
   document argues for structured locations (rename, move, list a box). Agree, and should memory hand such facts over?
3. **Recurring tasks: reminders or chores?** Lists §5 builds chores with Effect `Cron`; reminders §5 uses RRULE. This
   module needs RRULE ("yearly in October", "every 18 months"), which supports investigation §11 (b). Agree?
4. **Seeded Dutch tasks:** turn them on by default for a Dutch household?
5. **Manuals:** upload PDFs yourself, or allow the server to fetch them from the maker's site by model number?
6. **Insurance export:** CSV, PDF, or both, and should photos be included?
