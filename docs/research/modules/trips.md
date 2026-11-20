# Trips (itineraries, flights, trains, packing, holiday mode)

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md):
the store, scheduler, events, notifications and tool context in
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) ("shared state
§n"), presentation and device places in
[`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md) ("presentation
§n"), connections and risk classes in
[`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)
("module definition §n"). Outside facts were checked on 2026-11-18. Anything not confirmed is marked **[unverified]**.
The household is assumed to be in the Netherlands, so Schiphol and NS appear first; this is not confirmed.

## 1. Summary

Travel beyond the daily commute. A **trip** is a stored object with segments (flights, trains, stays, car hire, events)
assembled from confirmation e-mails and the calendar. Around it the module offers:

- **flight status** with gate changes, delays and boarding as notifications;
- **train disruptions** on a booked journey (NS, and DB or others abroad);
- a **packing list** created in the [lists](lists.md) module from a template plus the destination's weather;
- **destination facts**: weather, local time, currency;
- **"when do I need to leave for the airport?"** from travel time, the airline's advice and a buffer;
- **holiday mode** for the house on departure and its reversal on return, through [smart-home](smart-home.md).

**Boundaries.** The daily commute, travel time, departures and saved places belong to the `travel` module in
[local-info](local-info.md) §1; trips calls its `travel_time` and never duplicates routing. Events stay in
[calendar](calendar.md); trips reads them and may add a segment as an event only on request. Reading mail is the
[google](google.md) or [messaging](messaging.md) mail connection. Time zones and currency are
[core-tools](core-tools.md) (`time`, `calculate` with Frankfurter). Delivery is the Notification service.

- **Priority: second wave**, after calendar, a mail connection and local-info `travel`. Trips are infrequent, but the
  day of travel is exactly when a hands-free "has the gate changed?" helps.
- **Effort: L** overall. A manual trip with flight status and packing list is **M**. E-mail extraction is the
  expensive part.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| TripIt | Forward confirmations to plans@ to build an itinerary; flight alerts in Pro. Its public API is closed to new integrations ([TripIt](https://help.tripit.com/en/support/solutions/articles/103000391296-tripit-public-api)) | Forwarding as the ingestion method; one trip per date range | A closed API |
| Google (Gmail, Assistant) | Trips built from Gmail reservations using schema.org markup (`FlightReservation`, `LodgingReservation`, `TrainReservation`) ([Gmail markup](https://developers.google.com/workspace/gmail/markup/reference/flight-reservation)); "when is my flight?" | Read the same JSON-LD that senders already embed | Markup is often stripped when mail is forwarded ([Dyspatch](https://www.dyspatch.io/blog/gmail-schema/)) |
| [KDE Itinerary](https://apps.kde.org/kitinerary-extractor) | Open-source extractor for e-mails, PDFs, Apple Wallet passes and barcodes of many airlines, railways and booking sites; `kitinerary-extractor` CLI, latest 6.7.2 (2026-06-04) | Local, privacy-preserving extraction we can call | A native dependency (KDE Frameworks) |
| Flighty, App in the Air | Push for gate changes, delays, inbound aircraft late | Notify only on change; the inbound aircraft as a delay predictor | Paid data costs |
| [TREK](https://github.com/mauriceboe/TREK), [AdventureLog](https://www.linuxlinks.com/adventurelog-self-hostable-travel-tracker-trip-planner/) | Self-hosted trip planners with itineraries, maps, budgets; TREK has packing templates and a built-in MCP server | A possible provider for households already using one | — |
| Home Assistant | `alarm_control_panel` `armed_vacation` ([HA](https://www.home-assistant.io/triggers/alarm_control_panel.armed_vacation/)), [presence simulation](https://github.com/slashback100/presence_simulation) (HACS), [Alarmo](https://github.com/nielsfaber/alarmo), thermostat away modes | Holiday mode as one owner-defined HA script | Some panels do not report `armed_vacation` correctly ([forum](https://community.home-assistant.io/t/alarm-control-panel-vacation-mode/213872)) |

## 3. Example conversations

S = a screen helps; works headless. "P" = personal; on the traveller's devices or as a household trip.

| # | Situation | Exchange | Note |
|---|---|---|---|
| 1 | Itinerary | "What's our trip to Lisbon?" → "Friday the 5th: KLM 1691 from Schiphol at 9:20, landing 11:35 local time. Hotel Lumen for four nights. Back Tuesday at 18:05." | S: a `table` of segments; `map` on request. |
| 2 | New confirmation | Unprompted, owner's phone: "I found a booking for Hotel Lumen, 5–9 December, in your mail. Add it to the Lisbon trip?" → "Yes." | Extraction is suggested, never silently added. |
| 3 | Leave time | "When do I need to leave for the airport?" → "Leave by 6:35. The train takes 38 minutes, KLM advises arriving two hours before a European flight, and I added 15 minutes." | `travel_time` + advice + buffer; reasons are spoken. |
| 4 | Gate change | Day of travel, hallway device and phones: "KLM 1691 now leaves from gate D7, not D3." | `normal`; Schiphol `GCH` status. |
| 5 | Delay | "Is our flight on time?" → "It's delayed by 40 minutes, new departure 10:00. You can leave 30 minutes later." | Leave-by re-planned. |
| 6 | Train abroad | "Any problems with our train to Cologne?" → "The ICE 105 is 12 minutes late; your connection in Duisburg still works." | DB data quality varies (§5). |
| 7 | Packing | "Make a packing list for Lisbon." → "New list 'Lisbon packing' with 22 items from your city-trip template; it'll be 16 degrees with showers, so I added an umbrella." | In [lists](lists.md). |
| 8 | Destination | "What time is it in Lisbon?" → "13:10 there, an hour behind." "What's fifty euros in…" → not needed: Portugal uses the euro → "Lisbon uses the euro too." | core-tools does the maths. |
| 9 | Holiday mode | "We're leaving now." → "Turn on holiday mode: alarm to vacation, heating to 15, presence lights on, until Tuesday evening?" → "Yes." → "Holiday mode is on. I'll warm the house from Tuesday 15:00." | `security` change: confirmed, trusted device only. |
| 10 | Ambiguous | "When's my flight?" with two trips → "To Lisbon on Friday, or to Oslo in January?" | |
| 11 | Failure | "Has the gate changed?" (flight API quota spent) → "I can't get live flight data right now. Last update at 7:10: gate D3, on time. The KLM app will have the latest." | |
| 12 | Shared device | Hallway, a visitor: "When are they away?" → (guest session) "I can't share that." | Absence is security-sensitive (§13). |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `trip_get` | `trip?: dynamic`, `when?: text` | segments with local times, confirmation codes hidden unless asked | R | safe (personal) | < 20 ms | yes |
| `trip_add_segment` | `trip?`, `kind: "flight" \| "train" \| "stay" \| "car" \| "event"`, `flight?: text` ("KL1691"), `date?`, `from?`, `to?`, `name?`, `ref?` | the segment, resolved (airports, times) | W | changes data | < 50 ms; flight lookup 0.3–1 s | no |
| `trip_import` | `source: "mail" \| "file" \| "calendar"`, `messageId?`, `fileId?` | proposed segments for confirmation | W | changes data (after confirmation) | 1–5 s (extractor) | no |
| `flight_status` | `flight?: text`, `date?` (default the next trip flight) | status, gate, terminal, scheduled and estimated times, source, as-of | R | outward (API quota) | 0.3–1 s | yes |
| `train_status` | `segment?` or `from`, `to`, `at` | delays, cancellations, platform, connection check | R | safe | 0.3–1.5 s | yes |
| `trip_leave_by` | `segment?`, `mode?`, `buffer_min?` | leave-by time with the parts (travel, advice, buffer) | R | safe | 0.3–1.5 s (calls `travel_time`) | yes |
| `trip_destination` | `trip?` | local time and offset, weather summary, currency, plug type **[data source for plugs unverified]** | R | safe | 0.3–1 s | yes |
| `trip_packing_list` | `trip?`, `template?: dynamic` | the list created or updated in lists | W | changes data | < 50 ms + weather | yes |
| `holiday_mode` | `on: boolean`, `until?: text`, `profile?: dynamic` | what was changed in HA | W | **security**, confirm | 0.3–1 s | no |

Latencies are estimates, to be confirmed with `TurnTrace`. General assistants get `trip_get`, `flight_status`,
`train_status`, `trip_leave_by` and `trip_destination`. `holiday_mode` is only on trusted devices (§13).

## 5. Integrate or build

**Itinerary extraction**, in order:

1. **schema.org JSON-LD** in the mail HTML (`FlightReservation`, `LodgingReservation`, `TrainReservation`,
   `RentalCarReservation`, `EventReservation`), parsed with `linkedom` (already proposed in [kitchen](kitchen.md) §5).
   Cheap and exact when present.
2. **`kitinerary-extractor`** (KDE) for PDFs, `.pkpass` and mails without markup; outputs JSON-LD. A native binary on
   the server (§11); flags to be confirmed with `--help` **[unverified]**.
3. **The language model** as a last resort on the mail text, with the result shown for confirmation, never stored
   unconfirmed.

Ingestion: a "trips" label or folder in the household mail connection, or a dedicated forwarding address read by the
[messaging](messaging.md) IMAP channel. Calendar events with a flight number in the title are offered as segments.

**Flight status.**

| Source | Access | Verdict |
|---|---|---|
| [Schiphol Public Flight API](https://developer.schiphol.nl/apis/flight-api/overview) | Free key from developer.schiphol.nl; v4 with `app_id`, `app_key` and `ResourceVersion: v4` headers; statuses include `BRD` boarding, `GCH` gate change, `GTD` gate closed, `DEP`, `CNX` cancelled ([statuses](https://developer.schiphol.nl/apis/flight-api/flight-statuses)) | **First** for AMS departures and arrivals: free, gate-level |
| [AeroDataBox](https://providers.apievangelist.com/providers/aerodatabox/) | `GET /flights/{searchBy}/{searchParam}/{dateLocal}`; a Flight Alert push API with webhooks; billing moved to credits in 2026 **[pricing unverified]** | **Second**, for flights elsewhere and the return leg |
| [FlightAware AeroAPI](https://flightaware.com/commercial/aeroapi/) | Personal tier, billed per result set, small free allowance **[third-party figures]**; alerts may need a higher tier **[unverified]** | Alternative to AeroDataBox |
| OpenSky Network | ADS-B positions, no schedules or gates; OAuth2 since 2026-03 | Skip |

Polling plan: every 30 min from 24 h before departure, every 5 min from 3 h before, stop after departure (then
arrival only). Webhooks where the provider has them.

**Trains.** NS Reisinformatie API (the key already proposed for local-info; trips and disruptions endpoints, v3 path
**[unverified]**). Abroad: `v6.db.transport.rest` is down because DB's HAFAS endpoint was shut off; its successor is
the `db-vendo-client` npm package with lower rate limits ([readme](https://unpkg.com/db-vendo-client@6.11.1/readme.md));
[Transitous](https://transitous.org/api/) (MOTIS 2) covers Europe with GTFS-RT where operators publish it. Eurostar
has no public API **[unverified]**.

**Leave time.** Schiphol publishes no security wait-time API; its guidance has been two hours before a European flight
and three before an intercontinental one, with volatile waits in 2026
([Schiphol](https://www.schiphol.nl/en/messages/waiting-times-at-security-check-possibly-longer-than-usual)). The module
uses a per-airport, per-kind advice table the owner can edit, plus `travel_time` from local-info.

**Holiday mode:** an owner-chosen HA script (`script.holiday_mode_on`/`_off`) through the smart-home connection, not
our own list of entities. Recommendation overall: **build** the trip store and orchestration; **integrate**
extraction (JSON-LD, kitinerary), Schiphol and AeroDataBox, NS and Transitous; TREK as an optional provider later.

## 6. Data

| Collection | Scope | Fields |
|---|---|---|
| `trips` | household (family trip) or person | `name`, `destination` (place, country, tz), `start`, `end`, `travellers[]`, `holidayProfile?`, `packingListId?` |
| `segments` | as the trip | `kind`, `start`/`end` with tz, `from`/`to` (IATA or station ids), `carrier`, `number`, `ref` (encrypted), `source` (`mail:<id>`, `manual`, `calendar`), `status` cache |
| `flight_watch` | as the trip | `segmentId`, `provider`, `lastStatus`, `gate`, `nextPollAt` |
| `packing_templates` | household | name (city trip, beach, ski, business), items, weather rules ("rain > 30 % → umbrella") |
| `holiday_state` | household | `on`, `since`, `until`, `profile`, `restoreJobId` |

Exports: `trips.current()` and `trips.upcoming(days)` for [briefing](briefing.md) and [calendar](calendar.md);
`holiday_state` for [reminders](reminders.md) (hold household reminders while away) and notifications.

## 7. Long-running work and events

| Job | When | Missed while down |
|---|---|---|
| `flight-poll` | as in §5, per watched segment | run once at start if within the window |
| `train-check` | from 2 h before a booked train, every 5 min | run once |
| `leave-by` | one-shot at leave-by minus 15 min, re-planned on delay | fire late if still before leave-by |
| `mail-scan` | on new mail in the trips folder (IMAP IDLE or Gmail push), else every 30 min | run once |
| `holiday-off` | at `until` minus the warm-up | fires at start; asks before arming changes |
| `trip-cleanup` | 7 days after a trip ends: drop status caches and confirmation codes | run once |

**Events:** `trip.created`, `trip.segment.changed`, `flight.gate_changed`, `flight.delayed`, `flight.cancelled`,
`train.disrupted`, `holiday.on`, `holiday.off`. **Listens to:** `mail.received` (from google or messaging),
`calendar.changed`, `home-assistant.presence.changed` (everyone left: offer holiday mode if a trip starts today).

## 8. Presentation

- **Itinerary:** `table` (day, time local, segment, status) in the Presenter layout; a `map` of the route on request.
- **Flight:** `facts` (flight, gate, terminal, status, estimated time) pinned in Orbit on the day of travel, updated
  live through `present.update`.
- **Leave by:** a `card` with the time and its three parts; at the time, a `timer`-like countdown "leave in 12 min".
- **Boarding pass:** a `handoff` to the phone; the screen never shows the barcode.
- **Headless:** short lines; gate letters and numbers spoken slowly ("gate D, seven").

## 9. Notifications and proactive behaviour

| Case | Priority | Where |
|---|---|---|
| Gate change, delay over 15 min, cancellation, train disruption on the booked journey | `normal` (cancellation `high`) | travellers' phones; the hallway and kitchen devices on the travel day, if they are home |
| Leave in 15 minutes | `normal` | where the traveller is; phone |
| New booking found in mail | `low` | the owner's inbox and phone |
| Check-in opens **[only if the extracted data has `checkinUrl`]** | `low` | phone |
| Holiday mode ending, house warming up | `low` | inbox |

During quiet hours only cancellations and gate changes within 3 h of departure ring. Nothing is announced while the
house is in holiday mode, except to phones.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | home airport and station; saved places (local-info); time zone; currency | AMS; from places |
| Module | flight providers and keys (Schiphol, AeroDataBox); poll windows; airport advice table (EU 2 h, intercontinental 3 h); buffer; mail folder; packing templates; holiday profile (HA scripts) | Schiphol only; as §5; 15 min |
| Assistant | module on/off | on for general assistants |
| Device | announce travel-day updates here | hallway, kitchen |
| Person | which trips are personal; phone delivery; preferred mode to the airport | — ; phone; transit |

**Connections:** mail (google or messaging IMAP), `schiphol` (app id and key), `aerodatabox` (key), NS key (shared
with local-info), the HA connection. **First run:** home airport, a trips mail folder or forwarding address, a holiday
HA script, two packing templates.

## 11. Native tools and dependencies

| Need | Where | Missing |
|---|---|---|
| `kitinerary-extractor` (KDE package, e.g. `kitinerary` in Debian or Flatpak) | server | JSON-LD and model extraction only; PDFs and passes: "I couldn't read that attachment; add the flight number and I'll do the rest." |
| Flight API key | internet | "Live flight status isn't set up; I can only tell you the scheduled times." |
| HA scripts for holiday mode | LAN | `holiday_mode` is left out; "Holiday mode isn't set up in Home Assistant." |

## 12. Interaction with the rest of the system

- **Speech:** flight numbers ("KL sixteen ninety-one", "KLM 1691", "kay ell") normalised to IATA `KL1691`; airports
  by name or code ("Schiphol", "AMS", "Lissabon"); times always said in the local time of where the event happens,
  with "your time" when they differ.
- **Fast path:** "is my flight on time", "when do I leave", "what gate" are typed actions over the next trip.
- **Fillers:** a live status call over 1 s gets "Checking the flight…".
- **Assistants:** no template; general assistants get the read tools.
- **Other modules:** local-info `travel_time`; lists for packing; core-tools for time and currency; weather for the
  destination; smart-home for holiday mode; calendar; mail via google or messaging; [briefing](briefing.md) on the
  travel day.

## 13. Privacy and safety

- **Absence is a security fact.** "The house is empty until Tuesday" is never spoken on `public` devices or to
  guests, and the ambient line about trips appears only on `private` devices.
- **Confirmation codes, passport numbers and boarding passes** are stored encrypted, never spoken on shared devices,
  and deleted 7 days after the trip.
- **Holiday mode** is `security` class: confirmed, only on trusted devices (module definition §B.5), and the
  undo job asks before disarming.
- **Mail extraction** reads only the configured folder or forwarding address, never the whole mailbox; extracted
  text is untrusted data, not instructions.

## 14. Foundations needed

Module store, Scheduler, Notification service with phones, Tool context and `Person` records (travellers), Event bus
(mail, calendar, presence), Connection (mail, HA, keys), risk classes with confirmation and trusted devices,
Presentation (`table`, `facts`, `card`, `map`, `handoff`), local-info `travel` and lists.

**A useful first version without most of them:** manual trips ("add flight KL1691 on Friday"), `flight_status` from
Schiphol, `trip_leave_by` with a fixed travel time, and a packing list through the `Lists` service. No mail, no
holiday mode, no push.

## 15. Open questions

1. **How often do you fly or take international trains,** and from which airport? This decides whether the module is
   worth L.
2. **Mail ingestion:** a folder or label in your mailbox, or a dedicated forwarding address?
3. **Paid flight data:** is a few euros a month for AeroDataBox or AeroAPI acceptable for non-Schiphol flights?
4. **Holiday mode:** what should it do in your house (alarm, heating, presence lights, cameras), and should it ever
   start without being asked when everyone leaves on a trip day? Proposed: only offer.
5. **Disagreement with [local-info](local-info.md) §1:** it puts "when must I leave" in `travel` as a commute check.
   Trips needs leave-by for one-off events with airline advice; this document proposes trips calls `travel_time`
   and owns the trip-specific rules, and local-info keeps recurring commutes. Agree?
6. **Disagreement with [calendar](calendar.md) §7:** calendar plans "leave-time reminders (later)" when a commute
   module exists. Should those, for events with a location, live in calendar (via `travel_time`) or here?
