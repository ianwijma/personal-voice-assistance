# Printers

Research write-up, 2026-11-18. Not an approved design. Shared foundations are named as in [`README.md`](README.md) and
linked, not redesigned. Outside facts carry a link; **[unverified]** marks what I could not confirm against a primary
source. Latency figures are targets to be measured with `TurnTrace`.

## 1. Summary

Paper and 3D printers by voice. **Paper:** print the shopping list, a recipe or a label ("print a label: flour, opened
today"), on an office printer (CUPS/IPP), a receipt printer (ESC/POS) or a label printer (Brother QL); scan to
Paperless-ngx. **3D:** progress of the current print on a stage, a camera snapshot, finished and failed notifications,
pause and cancel with confirmation, for OctoPrint, Moonraker/Klipper, Bambu Lab and Prusa printers.

- **Boundary.** [lists](lists.md) and [kitchen](kitchen.md) own the content; this module renders and prints it.
  [images-and-photos](images-and-photos.md) owns camera snapshots in general; the 3D printer's camera is read here
  through the printer's own API. Paperless *search* ("when does the insurance renew") is the separate documents
  candidate in [investigation §7](../module-investigation/investigation.md#7-module-catalogue); this module only scans
  into it. [smart-home](smart-home.md) may already expose printers as HA entities; that is an adapter here.
- **Priority: later for paper, second wave for 3D** if the owner has a 3D printer (progress and "it failed" are the
  real value). A receipt printer for the shopping list is a small, fun first slice.
- **Effort: M.** Paper: IPP and ESC/POS are S each, Brother QL S–M (Python sidecar or raster encoder), scanning S.
  3D: one adapter S each; Bambu is M (MQTT, developer mode, camera).

## 2. What others do

| Who | What | Copy | Avoid |
|---|---|---|---|
| Alexa / Google | Printing via HP and Canon cloud skills **[unverified, from memory]** | "Print my shopping list" as a one-liner | Cloud printing accounts |
| Home Assistant | [IPP](https://www.home-assistant.io/integrations/ipp/) (ink levels, state), OctoPrint, PrusaLink built in; Moonraker and [ha-bambulab](https://github.com/greghesp/ha-bambulab) via HACS | Reuse the HA entities for state when present | Driving pause/cancel through generic HA buttons without our confirmation |
| Mainsail, Fluidd, OctoEverywhere, Obico | Progress, webcam, push on finish and on AI-detected failures | Progress + ETA + snapshot in one card; failure detection from Obico rather than our own vision | — |
| Receipt-printer projects (ESC/POS "daily briefing" printers) | Morning to-do lists on 80 mm paper | Short, list-shaped content on a receipt | Printing anything long |

## 3. Example conversations

1. "Hey Jeff, print the shopping list." → `print_list { list: "shopping" }` to the default printer (receipt, kitchen) → "Printing eleven items."
2. "Print the lasagne recipe." → office printer, A4 PDF rendered from the recipe → "Sent to the office printer, two pages."
3. "Print a label: flour, opened today." → Brother QL, 62 mm tape → "Label printed."
4. "Scan this to Paperless as the car insurance letter." → `scan_to_paperless { title: "Car insurance letter", tags: ["insurance"] }` → "Scanned two pages and sent them to Paperless. It's processing."
5. "How's the print going?" (kitchen screen) → "The Prusa is at 64 percent, about 1 hour 20 left, layer 182 of 290." Screen: `progress` card with a camera snapshot.
6. "Show me the printer camera." → `image` on the screen. **Needs a screen.**
7. (announced) "The Bambu finished the cable clips." / "The Voron paused: filament runout."
8. "Cancel the print." → "Cancel *bracket_v3* on the Voron at 64 percent? It can't be resumed." → "Yes." → "Cancelled."
9. **Ambiguous:** "Pause the printer." with two 3D printers printing → "The Prusa or the Bambu?"
10. **Failure:** "Print the shopping list." → "The receipt printer isn't answering. It may be off; want it on the office printer instead?"

## 4. Tools

Risk classes are [§B.5](../module-investigation/module-definition-config-and-dependencies.md#b5-risky-tools)'s;
template equivalent in brackets.

| Tool | Parameters | Returns | R/W | Risk | Latency (target) | Fast path |
|---|---|---|---|---|---|---|
| `print_list` | `list`, `printer?` | printed item count | W | change (paper) | 0.5–3 s | yes |
| `print_document` | `what: recipe \| note \| last-result`, `id?`, `printer?`, `copies?: ≤ 3` | pages, printer | W | change; > 10 pages confirm (costly) | 1–5 s | no |
| `print_label` | `text`, `date?: today`, `qr?: url`, `copies?: ≤ 5` | done | W | change | 0.5–2 s | yes |
| `printer_status` | `printer?` | state, ink/toner or tape, queue | R | read (safe) | 0.2–1 s | yes |
| `scan_to_paperless` | `title?`, `tags?`, `correspondent?`, `pages?: single \| feeder` | Paperless task id | W | change (personal) | 10–60 s, a task | no |
| `print3d_status` | `printer?` | state, file, %, ETA, layer, temps, last error | R | read | 0.1–0.5 s (subscription cache) | yes |
| `print3d_snapshot` | `printer?` | `image` presentation | R | read (camera: personal) | 0.5–2 s | no |
| `print3d_pause` / `_resume` | `printer?` | new state | W | change, confirm | 0.5–2 s | yes |
| `print3d_cancel` | `printer?` | cancelled | W | change, **always confirm** (destroys the print) | 0.5–2 s | no |
| `print3d_notify` | `printer?`, `on: finish \| fail \| both` | watch id | W | change | < 50 ms | yes |

Not offered: starting a 3D print by voice, heating, moving axes, G-code, firmware. Starting a print needs a person at the
printer (bed clear, filament loaded).

## 5. Integrate or build

**Paper.**

| Printer | Path | Library |
|---|---|---|
| Office (any IPP Everywhere / AirPrint printer, or CUPS queue) | IPP `Print-Job` with a PDF to `ipp://host:631/ipp/print` or `ipp://cups:631/printers/<q>` | [`ipp`](https://github.com/williamkapke/ipp) (pure JS, IPP/2.0); PDF from HTML with the server's renderer **[unverified choice: `pdfkit` or a headless browser]** |
| Receipt (Epson TM, Star, generic 80 mm) | raw TCP 9100, ESC/POS | [`node-thermal-printer`](https://www.npmjs.com/package/node-thermal-printer) (`tcp://ip:9100`, Epson and Star types) |
| Label (Brother QL-800/810W/820NWB) | raster protocol over TCP 9100 | `brother_ql` (Python; the original is unmaintained, forks exist **[unverified which is current]**) as a sidecar container; or our own raster encoder (the protocol is documented by Brother **[unverified]**) |
| Scanner | eSCL (AirScan) over HTTP: `POST /eSCL/ScanJobs`, then `GET …/NextDocument`; or SANE `scanimage` with `sane-airscan` ([backend](https://github.com/alexpevzner/sane-airscan)) | eSCL is plain HTTP+XML, no native dependency |
| Paperless-ngx | `POST /api/documents/post_document/` (multipart `document`, `title`, `tags`, `correspondent`), returns a task UUID, then `GET /api/tasks/?task_id=` **[unverified from docs; matches the documented API as I know it]**; or drop the PDF into the consume folder | token auth |

**3D.**

| Printer | API | Events | Writes |
|---|---|---|---|
| OctoPrint | REST, `X-Api-Key`; `GET /api/job`, `POST /api/job {"command":"pause","action":"pause"}`, `{"command":"cancel"}` ([job API](https://docs.octoprint.org/en/main/api/job)); webcam snapshot URL from settings | push via its SockJS socket **[unverified detail]** | PRINT permission on an app key |
| Moonraker (Klipper) | JSON-RPC over WebSocket or HTTP; `printer.objects.query` / subscribe for `print_stats` (`state`, `filename`, `print_duration`), `display_status.progress`; `printer.print.pause`, `.resume`, `.cancel` ([printer API](https://moonraker.readthedocs.io/en/latest/external_api/printer/)); webcams from `server.webcams.list` | `notify_status_update` subscription **[unverified name in current docs]** | API key or trusted-client IP range |
| Bambu Lab | local MQTT on 8883 (TLS) with the LAN access code; report fields `gcode_state`, `mc_percent`, `mc_remaining_time` (units disputed: minutes vs seconds); commands via the reverse-engineered OpenBambuAPI schema **[unverified]**. Since the January 2025 firmware, third-party **writes need LAN-only plus Developer Mode**, which disconnects the cloud ([Bambu wiki](https://wiki.bambulab.com/en/knowledge-sharing/enable-developer-mode)) | MQTT push | only in Developer Mode; otherwise read-only |
| Prusa (MK4, XL, Core One) | PrusaLink local `GET /api/v1/status`, job pause/resume/stop, digest auth or `X-Api-Key` ([forum](https://forum.prusa3d.com/forum/introcuctions-instrutctions/get-status-values-of-printer-from-raspberry-used-for-prusalink)); Prusa Connect has no public API of the same shape | poll 5 s | PrusaLink only |

**Recommendation:** build the module with a `PaperPrinter` and a `Printer3d` interface and one adapter each; integrate
the printers' own APIs (local, no cloud); use HA entities only as a read fallback. Use Obico (or Bambu's own detection)
for failure detection rather than sending camera frames to a model. Bambu writes only if the owner accepts Developer
Mode (§15).

## 6. Data

| What | Scope | Schema | Read by others |
|---|---|---|---|
| Printers | household settings + vault | `{ id, kind: paper \| label \| receipt \| 3d, adapter, url, credentialRef, room?, spoken[], default?: "list" \| "document" \| "label" }` | — |
| 3D state cache | memory | per printer: state, file, %, ETA, at | ambient line "Prusa: 64 %, done ~15:40" |
| Watches | person | `{ printer, on, origin: { deviceId } }` | — |
| Print log | household | `{ at, printer, what, pages, by }`, 30 days | — |

## 7. Long-running work and events

- A subscription fiber per 3D printer (MQTT, WebSocket, or 5 s polling) keeps the cache; transitions emit
  `printers.3d.finished`, `.failed`, `.paused` (with reason), `printers.paper.error` (out of paper, jam).
- `print3d_notify` defaults to on for every print started while the module runs (owner setting); finish and failure go
  through the [Notification service](../module-investigation/shared-state-jobs-and-notifications.md#8-notifications).
- `scan_to_paperless` is a [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler)
  `task`: scan, upload, poll the Paperless task, report "added as document 1,204" or the consume error.
- After a restart, subscriptions resume and the state is re-read; a print that finished while down is announced late
  only if it finished in the last 15 minutes.

## 8. Presentation

`print3d_status` → `progress` (file name, percent, ETA as a clock time, layer) with the latest snapshot as its image;
pinned while printing if the owner asks "keep the print on screen". `print3d_snapshot` → `image`, refreshed every 10 s
while shown. `print3d_cancel` → `confirm` naming file and percent. `printer_status` → `facts` (toner, tape). Without a
screen: percent and ETA in one sentence; snapshots offered on the nearest screen.

## 9. Notifications and proactive behaviour

| What | Priority | Where |
|---|---|---|
| 3D print failed or paused for an error (runout, spaghetti detected, thermal) | `high` | owner devices, the printer's room, phone |
| 3D print finished | `normal` | origin device and the printer's room; inbox otherwise |
| Paper printer out of paper or toner low | `low` | inbox |
| Scan added to Paperless | none (the tool's own result) | — |

Quiet hours: a failed print is still `high` (a heater left on matters); finished prints wait for morning.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | which printer for lists, documents, labels | first of each kind |
| Module | printers and credentials; page limit before confirm (10); receipt width (80 mm); label tape (62 mm); notify on every 3D print | none; 10; 80; 62; on |
| Assistant | main assistant: paper printing and 3D status; Admin: all | as stated |
| Device | `allowRisky` not needed; cancel requires a trusted device or the printer's room | — |
| Person | — | — |

**First run:** add a printer by IP (IPP printers can be found with mDNS `_ipp._tcp`), test print; for 3D, paste the
OctoPrint key, Moonraker URL, PrusaLink credentials or the Bambu access code and serial; **Test** shows state.

## 11. Native tools and dependencies

| Dependency | Where | Missing → spoken |
|---|---|---|
| Printer on the LAN | LAN | "The receipt printer isn't answering." |
| `brother_ql` sidecar (if no native encoder) | server, container | "Label printing isn't set up." |
| MQTT client (`mqtt` npm) | server | build-time |
| Bambu Developer Mode | printer | Bambu read-only: "I can see the Bambu but can't pause it; it needs developer mode." |
| PDF renderer | server | documents unavailable; lists still print on receipt |

## 12. Interaction with the rest of the system

- **Voice.** Printer names are short owner aliases ("the Voron", "the label printer"). File names from slicers
  (`bracket_v3_0.2mm_PLA_MK4_1h20m.gcode`) are shortened to the first words. ETA as a clock time, not a duration, when
  over an hour.
- **Agents.** No template; the Chef ([kitchen](kitchen.md)) gets `print_list`, `print_document` and `print_label` for
  recipes and pantry labels.
- **Intents.** Typed: "print the shopping list", "how's the print", "pause the print" (with confirm).
- **Other modules.** [lists](lists.md) and [kitchen](kitchen.md) provide content through their services;
  [routines](routines-and-automations.md) can print a list as a step (Saturday shopping); [briefing](briefing.md) can
  print itself on the receipt printer.

## 13. Privacy and safety

- Paper costs money and can be abused by a TV or a guest ("print 500 copies"): copy and page limits, confirm above 10
  pages, nothing printed from a `public` device.
- Scanning sends personal documents to Paperless; the scan never passes through the hosted model.
- 3D: cancel destroys hours of work and filament, so it is always confirmed with the file name and percent; pause is
  confirmed too (a paused print can fail on cooling). Starting prints, heating and movement are never offered: a 3D
  printer is a heater and a motion system and needs a person present.
- Printer cameras show a room: snapshots are `personal`, shown on private and shared screens only, never sent to the
  hosted model unless asked.
- Children and guests: may ask for status; may not print documents or cancel.

## 14. Foundations needed

| Foundation | For | Without it |
|---|---|---|
| Risk classes, confirmations | cancel, pause, large prints | status and list printing only |
| [Notification service](../module-investigation/shared-state-jobs-and-notifications.md#8-notifications) | finished and failed | ask-only |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | progress card, snapshot | spoken only |
| [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler) | scan task | scan waits in the turn (≤ 60 s) |
| [lists](lists.md) `Lists` service | `print_list` | not shippable |

**Useful first version (S):** `print3d_status` for one printer plus `print_list` on a receipt printer.

## 15. Open questions

1. **Which printers exist:** an IPP office printer, a receipt or label printer, and which 3D printers (OctoPrint,
   Klipper, Bambu, Prusa)?
2. **Bambu Developer Mode:** accept losing Bambu cloud features to get pause and cancel, or keep it read-only?
3. **Label printer encoder:** run the Python `brother_ql` as a sidecar, or write a TypeScript raster encoder?
4. **Failure detection:** Obico (self-hosted, needs a GPU or CPU time), the printer's own, or none?
5. **Pause by voice from any room**, or only from the printer's room and trusted devices?
6. **Disagreement with [investigation §7](../module-investigation/investigation.md#7-module-catalogue):** it lists
   Paperless-ngx as a read-only documents candidate; scanning *into* Paperless fits here, but if a documents module is
   built, `scan_to_paperless` should move there.
