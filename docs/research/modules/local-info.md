# Local information: weather, places, travel, bin day, parcels

Research write-up, 2026-11-17. Not an approved design. Code references are `path:line` on `main` at `70b15ec`.
Assumption used throughout: the household is in the Netherlands (Dutch examples and `nl-NL` appear across the docs
and the Home section offers it). Where a source is Dutch-only, a non-Dutch alternative is named. Claims about outside
services carry a link; "unverified" marks what I could not confirm. The web-search budget ran out part-way through,
so the parcel-carrier and AfterShip details rest on fewer sources than the rest.

## 1. Summary

The questions people ask a kitchen speaker about the world just outside the door: will it rain in the next hour, is
the pharmacy open, when is the next train, when must I leave, which bin goes out tomorrow, where is my parcel. All of
them are short read-only lookups that answer in one spoken sentence, and most need the household's location to be
precise rather than "Amsterdam, Netherlands".

**Recommendation: four modules, not one,** cut by backing service and by how often an assistant wants them:

| Module | Contents | Priority | Effort |
|---|---|---|---|
| `weather` (extend) | rain in the next 2 h, warnings, hourly and multi-day forecast | first wave | S |
| `travel` (new) | places and opening hours, travel time, public-transport departures and trips, commute checks | second wave | M |
| `bin-day` (new) | next collection per waste type, evening-before reminder | second wave (first if the scheduler exists) | S |
| `parcels` (new) | track numbers, delivery status | later | M |
| `markets`, `sports` | quotes, scores | later, off by default | S each |

One big `local-info` module would put 15+ tools in every assistant that wants the weather (tool-count cost,
[landscape-launchers §6](../module-investigation/landscape-launchers-and-agent-tools.md)), would need every key before
any of it works, and would restart all of it on any save. Separate modules can be switched per assistant (the kitchen
assistant gets `bin-day`, the coding one gets none) with the existing `modules` record. They share one thing, the
household places (section 10), which belongs to the Household configuration layer, not to any one module.

## 2. What others do

- **Weather.** Every assistant has it; the Dutch-specific killer question is minute-level rain ("gaat het regenen?"),
  answered by apps like Buienradar from radar nowcasts. Home Assistant ships `met` (MET Norway) by default and has a
  `buienradar` integration and MeteoAlarm for warnings ([landscape-automation §1.1](../module-investigation/landscape-automation-platforms.md)).
  Copy: rain timing in plain words ("dry until about 14:20, then light rain for half an hour"). Avoid: Gemini for Home
  inventing weather ([landscape-voice §16](../module-investigation/landscape-voice-assistants.md)); every number must come from a tool.
- **Places and hours.** Google and Alexa answer "is X open" from their own place databases. Open alternatives: OSM via
  Overpass plus the `opening_hours` tag, which the [`opening_hours`](https://github.com/opening-hours/opening_hours.js)
  library (npm `opening_hours`, LGPL-3.0) evaluates with `getState(date)` and `getNextChange(date)`, including public
  holidays when given a country code.
- **Travel and transit.** Alexa's traffic nudge ("leave earlier"), Google's commute card, HA's `waze_travel_time`
  (11,016 installs) and the `nederlandse_spoorwegen` integration. Raycast and Alfred have travel-time commands.
  Copy: a fixed "commute" that needs no parameters. Avoid: answers that read a table aloud.
- **Bin day.** The most popular custom HA integration with household value is `waste_collection_schedule`
  (27,453 installs, same doc §1.1). Its README lists about 90 Dutch sources (Afval Wijzer, Ximmio, Circulus, HVC Groep,
  Rova, Twente Milieu, Gemeente Utrecht, …) and a generic ICS source ([README](https://raw.githubusercontent.com/mampfes/hacs_waste_collection_schedule/master/README.md)).
  Copy: a reminder the evening before, not on the day.
- **Parcels.** Alexa announces Amazon deliveries; Raycast and Alfred have trackers built on 17TRACK or AfterShip.
  Home Assistant's PostNL integration page now shows "The integration you requested has been removed"
  ([HA](https://www.home-assistant.io/integrations/postnl/); the page does not say why). Lesson: carrier APIs for
  consumers come and go.

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | "Gaat het het komende uur regenen?" → "Tot ongeveer kwart over twee droog, daarna een half uur lichte regen." | no (a 2-hour rain bar chart if there is one) |
| 2 | "Any weather warnings?" → "Yes, code yellow for wind in Utrecht until 18:00, gusts up to 75 km/h." / "No warnings for Utrecht." | no |
| 3 | "Is the Albert Heijn open?" → "The Albert Heijn on Biltstraat is open until 22:00." | no; a `facts` card with the week's hours on a screen |
| 4 | "When's the next train to Amsterdam?" → "From Utrecht Centraal: 8:14 from platform 5, about 4 minutes late; then 8:22." | no; a `table` of the next six on a screen |
| 5 | "When do I need to leave for work?" → "Cycling takes 18 minutes; leave by 8:42 to be there at 9." | no |
| 6 | "Which bin goes out tomorrow?" → "The green bin, GFT, tomorrow morning." | no |
| 7 (ambiguous) | "How long to the station?" → "Utrecht Centraal or Utrecht Overvecht?" → "Centraal." → "About 12 minutes by bike." | no |
| 8 (failure) | "When's the next bus?" → "I can't reach the departure service right now. Your usual 28 normally leaves at 17 and 47 past the hour." | no |
| 9 (failure, setup) | "Where's my parcel?" → "Parcel tracking isn't set up yet; the owner can add it under Settings, Parcels." | no |
| 10 | "Show me the route to Ikea" (on the kitchen speaker) → "I can't show maps here. It's 25 minutes by car via the A27. Shall I send it to your phone?" | yes (map, or `handoff`) |

Exchange 8 shows a pattern worth keeping: a stored favourite (section 6) gives a grounded fallback, clearly marked as the
timetable, not live data.

## 4. Tools

Risk classes follow the README (safe / changes data / outward-facing or costly), mapped to `read`/`change` of the
proposed risk policy ([module-definition §B.5](../module-investigation/module-definition-config-and-dependencies.md)).
Every tool here is safe and `speculative: true` unless stated. Latencies are expectations to be measured with
`TurnTrace`, not measurements.

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `weather` (exists, `packages/modules-builtin/src/weather.ts:136`) | `place?` | place, local time, now, today | read | safe | 0.2–0.6 s (two calls on a cold geocode) | yes, as action `today` (`:178`) |
| `weather_rain_soon` | `place?`, `minutes?` (30–120, default 120) | dry/wet periods with start and end times, peak mm/h, source | read | safe | 0.2–0.5 s | yes, action `rain_soon` |
| `weather_forecast` | `place?`, `day?` (today…+6, or a weekday), `hours?` | hourly or daily rows: code, min/max, rain chance and sum, wind, UV | read | safe | 0.2–0.5 s | partly ("tomorrow" as an action) |
| `weather_warnings` | `place?` | active and upcoming warnings: level, phenomenon, region, from/until | read | safe | 0.3–1 s | yes, action `warnings` |
| `place_find` | `query`, `near?` (a saved place or "here") | up to 5 candidates: name, address, distance, OSM id | read | safe | 0.5–2 s | no |
| `place_hours` | `place` (name or OSM id), `at?` | open now?, next change, the week's hours, source tag | read | safe | 0.5–3 s (Overpass) | no |
| `nearby` | `kind` (pharmacy, supermarket, fuel, …), `near?`, `openNow?` | up to 5 places with distance and open state | read | safe | 1–4 s | no |
| `travel_time` | `to`, `from?` (default home), `mode` (car, bike, walk, transit), `at?`, `arriveBy?` | duration, distance, leave-by time, one-line route | read | safe | 0.3–1.5 s | yes for saved places, action `commute` |
| `departures` | `stop?` (default the favourite), `line?`, `direction?`, `count?` (≤ 10) | departures: line, destination, planned, expected, platform, cancelled | read | safe | 0.3–1.5 s | yes for favourites, action `next_departure` |
| `trip` | `to`, `from?`, `at?`, `arriveBy?` | up to 3 itineraries: legs, transfers, delays | read | safe | 0.5–2 s | no |
| `commute_watch` | `place`, `days`, `arriveBy`, `mode`, `on?` | the stored watch | write | changes data | < 50 ms (store) | no |
| `bin_next` | `type?` (gft, paper, plastic/pmd, rest, glass) | next date per type, or for the asked type | read | safe | < 20 ms (cached) | yes, action `next` |
| `parcels_list` | — | tracked parcels with label, carrier, last status, ETA | read | safe | < 50 ms (store) | yes |
| `parcel_add` | `code`, `label?`, `carrier?` | the registered parcel | write | outward-facing (sends the number to a tracking service, costs quota) | 0.5–2 s | no |
| `parcel_remove` | `label` or `code` | ok | write | changes data | < 50 ms | no |
| `quote` (`markets`) | `symbol` or company name | price, change today, currency, delay note | read | safe | 0.3–1 s | no |
| `score` (`sports`) | `team`, `when?` (last, next, live) | result or fixture | read | safe | 0.3–1 s | no |

Design notes:

- `place` everywhere accepts a saved-place name first ("home", "work", "Oma's"), then free text. Resolution is the
  server's: exact saved name or alias, then geocoding biased to the home area. Ambiguity returns candidates and the
  model asks (exchange 7), following the HA matching rule quoted in [shared-state §7](../module-investigation/shared-state-jobs-and-notifications.md).
- Results are trimmed at the tool for speech: `departures` returns at most 10 rows, and an instruction line says to
  read only the first two. No raw API JSON enters the history.
- Fast-path actions use `Param.choice` over saved places and favourite stops (`Param.dynamic`, as Home Assistant's
  `target`), so Jev can run "wanneer gaat mijn bus" without a model once the intent path is wired.

## 5. Integrate or build

**Weather.**

| Need | Option | Key? | Terms / limits | Verdict |
|---|---|---|---|---|
| Hourly/daily, warnings-free | [Open-Meteo](https://open-meteo.com/en/docs) (in use) | no | Free tier non-commercial (personal home automation is named as allowed), < 10,000 calls/day, 5,000/h, 600/min, CC-BY 4.0 ([terms](https://open-meteo.com/en/terms)) | keep |
| Rain next 2 h, anywhere | Open-Meteo `minutely_15=precipitation,rain` with `forecast_minutely_15=8` | no | Native 15-minute data "only available in Central Europe and North America" (ICON-D2, AROME, RRFS); elsewhere interpolated from hourly ([docs](https://open-meteo.com/en/docs)). It offers `knmi_seamless` and Harmonie AROME Netherlands models | default |
| Rain next 2 h, NL/BE radar nowcast | Buienradar `https://gpsgadget.buienradar.nl/data/raintext?lat=…&lon=…` | no | Undocumented endpoint; 5-minute lines of intensity and time; non-commercial use with attribution per third-party quotes of Buienradar's terms ([PyPI buienradar](https://pypi.org/project/buienradar), [HA forum notes](https://community.openhab.org/t/buienradar-binding-reports-buienradar-api-at-uri-xxxx-return-empty-result/151592.md)); NL/BE coordinates only (unverified) | optional provider, NL only |
| Warnings, Europe | MeteoAlarm Atom/CAP feeds, likely `feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-netherlands` (URL pattern from HA's integration, unverified) | no | Known to be fragile for unofficial clients ([HA forum](https://community.home-assistant.io/t/meteoalarm/394097)) | default for warnings, behind a health check |
| Warnings, NL official | [KNMI Data Platform](https://dataplatform.knmi.nl/dataset/groups/waarschuwingen-nederland-48h-1-0) | yes (Open Data API key; an anonymous key exists, unverified) | CC-BY 4.0; the 48 h warnings dataset page is now titled "[DEPRECATED]", and KNMI renewed its warning system in 2026 ([KNMI](https://www.knmi.nl/kennis-en-datacentrum/uitleg/vernieuwing-knmi-waarschuwingen)); successor dataset not confirmed | later, once the successor is known |

Open-Meteo has no warnings endpoint (none on its docs page). Recommendation: Open-Meteo for everything except warnings;
MeteoAlarm for warnings; Buienradar as an opt-in "radar rain (NL/BE)" provider whose answer wins when both exist, since
radar nowcasts beat model output for the next hour (expected, unmeasured: compare both against what happened for a
month before switching the default).

**Places.** Geocoding through [Nominatim](https://operations.osmfoundation.org/policies/nominatim/): at most 1 request
per second for the whole application, an identifying User-Agent, caching required, no autocomplete. That fits a
household if results are cached and saved places are geocoded once at save time. [Photon](https://photon.komoot.io) is
the self-hostable alternative (terms of the public instance unverified). Opening hours and `nearby` through the public
Overpass instance: about 10,000 requests and 1 GB a day, HTTP 429 when slots run out, 180 s default timeout
([Overpass commons](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)); queries must set
`[timeout:3]` so a voice turn never waits 180 s. OSM's opening hours for Dutch chains are generally good, for small
shops patchy (unverified; spot-check 20 local places before promising it).

**Routing.** OSRM's public demo is run by FOSSGIS on a best-effort basis, may cut access without reason, and forbids
heavy use ([OSRM wiki](https://github.com/Project-OSRM/osrm-backend/wiki/API%20Usage%20Policy)). A household's few
calls a day are light, but a commute watch polling every minute is not. Valhalla and GraphHopper are the alternatives;
GraphHopper's hosted API needs a key (free tier unverified). Self-hosting OSRM with a Netherlands extract in Docker is
the robust path (RAM and disk for the NL extract unverified; expect a few GB). Recommendation: public OSRM for car, bike
and walk at first, the commute watch capped at one check per run, self-hosting as a documented upgrade.

**Public transport.**

| Option | Covers | Key? | Terms | Verdict |
|---|---|---|---|---|
| [Transitous](https://transitous.org/api/) (MOTIS 2) `https://api.transitous.org/api/` | Europe-wide GTFS and GTFS-RT, including NL | no | Non-commercial, open-source projects only; User-Agent with app name, version and a contact; > 720 `/plan` requests a day counts as heavy | default |
| NS Reisinformatie `/reisinformatie-api/api/v2/departures` | Dutch trains, platforms, disruptions | yes, `Ocp-Apim-Subscription-Key` from apiportal.ns.nl ([HA integration](https://www.home-assistant.io/integrations/nederlandse_spoorwegen)); price of the key unverified, believed free | NS conditions of use | optional provider for trains |
| OVapi `v0.ovapi.nl` (KV78Turbo) | Dutch bus, tram, metro, ferry realtime | no (third-party listings, unverified) | No official docs found; status in 2026 unverified | skip unless Transitous lacks a stop's realtime |

Transitous endpoints used: `/api/v1/stoptimes` (`stopId`, `n`, `time`, `arriveBy`, `direction`, `mode`, `radius`)
for departures, `/api/v1/plan` for trips, and its geocoder for stop names; parameter names are from a generated client
of the MOTIS OpenAPI spec ([Debian source](https://sources.debian.org/src/rust-motis-openapi-sdk/1.0.0-1/docs/TimetableApi.md)),
and MOTIS 2.5 added newer `/api/v5` stoptimes, so the adapter pins a version and is tested against the live spec.

**Bin day.** (a) An ICS feed URL: many Dutch collectors offer a calendar export (unverified per municipality), and the
generic ICS source of `waste_collection_schedule` shows it is common. Parse with `ical.js` (MPL-2.0) or `node-ical`.
(b) Via Home Assistant: if the owner runs `waste_collection_schedule`, read its sensors through
[`smart-home`](smart-home.md)'s module. (c) Port the ~90 Dutch scrapers: no; they break and need upkeep. Recommend (a)
plus (b), with a manual "every other Tuesday" rule as the fallback.

**Parcels.** No good keyless option exists, said plainly:

- [17TRACK](https://api.17track.net/en/doc) (`17token` header, `POST /track/v2.4/register`, `TRACKING_UPDATED`
  webhook) ended its 100 free numbers a month; accounts made after 7 January 2026 get 200 numbers once. Real use is paid.
- AfterShip: its pricing page refused automated access; free-plan API access unverified.
- Carrier sites (PostNL, DHL, DPD): unofficial endpoints that change. HA's PostNL integration was removed.
- Parsing shipping e-mails ("your parcel is on its way", with a track-and-trace link) needs a mail connection, which
  does not exist yet, and gives status only as fresh as the last e-mail.

Recommendation: later; build on 17TRACK with the owner's key and the e-mail path once a mail module exists.

**Markets and sports.** Small HTTP tools over Finnhub or Alpha Vantage (keys) and TheSportsDB or football-data.org
(keys); limits unverified ([landscape-launchers §3.12](../module-investigation/landscape-launchers-and-agent-tools.md)).
Ship off by default.

## 6. Data

All through the [Module store](../module-investigation/shared-state-jobs-and-notifications.md) (§4).

| Module | Collection | Scope | Rough schema | Readable by others |
|---|---|---|---|---|
| `weather` | `geocache` | household | query → `{ name, lat, lon, admin1, country }` | no (exists in memory today, `weather.ts:85`) |
| `weather` | `warnings_seen` | household | warning id, level, until | yes, as event `weather.warning` |
| `travel` | `favourites` | household or person | `{ label, kind, stopId?, lat, lon, lines? }` (kind: stop or place) | yes, export `favourites` |
| `travel` | `commute_watches` | person | `{ placeId, days, arriveBy, mode, leadMinutes, deviceId?, jobId }` | no |
| `travel` | `geocache`, `hours_cache` | household | OSM id → place, `opening_hours` string, fetched at; 24 h TTL | no |
| `bin-day` | `collections` | household | `{ date, type, source }`, refreshed daily | yes, export `next` (the briefing reads it) |
| `parcels` | `parcels` | person | `{ code, carrier?, label, status, eta?, lastEventAt, delivered }`, deleted 7 days after delivery | yes, ambient fact "1 parcel out for delivery" |

Saved places themselves (home, work) are household configuration, not module data (section 10). If voice-added places
("remember this as the gym") are wanted, they move to a store collection in the household or person scope.

## 7. Long-running work and events

Through the [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md) (§6) and [Event bus](../module-investigation/shared-state-jobs-and-notifications.md) (§5):

| Job | Kind | When | Missed while down |
|---|---|---|---|
| warnings poll | `recurring` | every 15 min | skip (next run catches up) |
| rain alert ("tell me if it starts raining") | `task` with a deadline, polling every 5 min, ends after 3 h | on request | skip; say "the rain watch stopped at the restart" |
| commute check | `recurring` cron per watch, `leadMinutes` before leave-by time | weekdays | skip if more than 10 min late |
| bin refresh and reminder | `recurring` daily 03:00 refresh; reminder at a set time the evening before | daily | reminder `fire-late` until 23:00, then skip |
| parcel poll (no webhook) | `recurring` hourly while a parcel is undelivered | | skip |

Events emitted: `weather.warning` (new or upgraded level), `weather.rain_starting`, `travel.commute_delayed`,
`bin.tomorrow`, `parcel.status_changed`, `parcel.delivered`. Listens to: nothing in v1. Later, `smart-home` could
listen to `weather.warning` to close covers (an owner-made routine, never automatic). Inbound parcel webhooks need a
module HTTP route, which is ABSENT ([current-system §9](../module-investigation/current-system.md), gap 21), so v1 polls.

## 8. Presentation

[Presentation](../module-investigation/presentation-and-device-capabilities.md) kinds used:

- `weather` for forecasts (§3.2 already names this module as its source), with the rain-next-2-h series as a `chart`
  (bar, mm/h) when the question was about rain.
- `facts` for opening hours (today first, then the week) and for a warning (level, phenomenon, until).
- `table` for departures (line, to, time, delay, platform; at most 6 rows) and `list` for `nearby` and trip options.
- `map` for a route only once the server can render static map images. That is not small: it needs a tile source
  whose terms allow it (OSM's tile policy for server-side rendering unverified) or self-hosted tiles. Until then a
  `handoff` with an OpenStreetMap directions link is the honest version.

The character presents as for any card (Presenter layout). Without a screen everything here speaks well except maps;
the rule in presentation §3.6 applies: no apology for departures or weather, an offer of the phone for a route.

## 9. Notifications and proactive behaviour

Through the [Notification service](../module-investigation/shared-state-jobs-and-notifications.md) (§8). Everything off
until the owner enables it per kind.

| What | Priority | Devices | Quiet hours |
|---|---|---|---|
| Red or orange warning for home | `high` | everywhere with a speaker, once per warning | visual only, inbox |
| Yellow warning | `low` | inbox, screen badge, ambient fact | — |
| "Rain starts in about 10 minutes" (only after a request) | `normal` | the device that asked | inbox |
| Commute: "Leave in 5 minutes; your train is 10 minutes late" | `normal` | the person's default devices, or their phone | not applicable (it runs at the commute time) |
| "Paper bin goes out tomorrow" | `normal` at the reminder time, `low` otherwise | the room set for it (hallway, kitchen) | inbox |
| Parcel delivered / out for delivery | `low` | inbox; spoken only if asked for | — |

Ambient facts (shared-state §7) carry "bin tomorrow: paper" and "warning: code yellow wind" for every assistant,
within the 600-character cap. No "by the way" upsell after an unrelated answer ([landscape-voice §16.4](../module-investigation/landscape-voice-assistants.md)).

## 10. Configuration

**Household location.** Today `HOME_LOCATION` is free text ("Amsterdam, Netherlands",
`apps/assistant/src/serve/sectionDefinitions.ts:146`), geocoded by the weather module on every new instance and fed
to it as a linked default for `defaultPlace` (`weather.ts:227`). That is enough for weather, not for "how long to work"
or "the nearest pharmacy". Proposal: the Household layer ([module-definition §B.1](../module-investigation/module-definition-config-and-dependencies.md))
gains a **places** list, a `records` field (BUILT, NOT WIRED on module forms, current-system §6.2):

```ts
// PROPOSAL
type HouseholdPlace = { id: string; name: string; aliases: string[]; kind: "home" | "work" | "school" | "stop" | "other"
  address?: string; lat: number; lon: number; person?: PersonId }   // person: "Ian's work"
```

Exactly one `home`. Coordinates are resolved once at save (one Nominatim call) and shown for the owner to confirm.
`HOME_LOCATION` stays as the display name and is derived from home when places exist. Per-person places wait for
household `Person` records (shared-state §4.6); until then a place has no person and "my work" means the only work.

| Layer | Setting | Default |
|---|---|---|
| Household | places (home, work, school, stops), units (exists), language (exists), API contact for User-Agent (an e-mail or URL the owner chooses; none is invented) | home from `HOME_LOCATION` |
| Module `weather` | rain provider (`open-meteo` / `buienradar`), warnings source (`meteoalarm` / `knmi` / off), warning region (auto from home), timeout (exists) | open-meteo, meteoalarm |
| Module `travel` | routing endpoint (public OSRM or own URL), transit provider (Transitous; NS key optional), Overpass endpoint, default mode (bike) | public services |
| Module `bin-day` | source (ICS URL / Home Assistant entity / manual rule), type names mapping, reminder time | none |
| Module `parcels` | 17TRACK key (secret) | — |
| Assistant | which of these modules are on (exists); weather place override (exists, `overridable`) | — |
| Device | room and privacy (proposed in presentation §5.3); whether bin and warning announcements play here | — |
| Person | commute watches, favourite stops, per-person places | — |

Secrets and [Connections](../module-investigation/module-definition-config-and-dependencies.md): NS key and 17TRACK key are
plain secrets in the vault, not OAuth connections. First run for the owner: confirm home on a map preview, add work,
pick a favourite stop by searching, paste the bin-calendar URL, press "Test" (a `fieldActions` button, BUILT, NOT WIRED).

## 11. Native tools and dependencies

No binaries. npm: `opening_hours` (LGPL-3.0, used unmodified as a library), an ICS parser. Network: internet
([Requirements and health](../module-investigation/module-definition-config-and-dependencies.md), `{ network: "internet" }`).
Optional self-hosted services: OSRM, Photon, MOTIS, each a container on the server or LAN, never on a device.

Health checks: one cheap request per backing service every few minutes at most, cached (Open-Meteo, MeteoAlarm feed
parse, Transitous `stoptimes` for the favourite stop, ICS fetch). Spoken lines when something is missing:

- No home coordinates: "I don't know exactly where home is yet; the owner can set it under Home."
- Transit service down: "I can't reach the departure service right now." plus the timetable fallback (exchange 8).
- Warnings feed broken: "I can't check weather warnings at the moment," never "there are no warnings".
- Parcels without a key: exchange 9.

## 12. Interaction with the rest of the system

- **Speech recognition.** Dutch place and stop names are the hard part ("Overvecht", "Zuilen", "'s-Hertogenbosch"),
  and English recognisers mangle them. Saved-place aliases help; stop names are fuzzy-matched against the favourites
  and the stop geocoder, not taken literally. Line numbers ("de 28", "bus twenty-eight") go through `ValueParsing`.
- **Times and numbers.** Say "8:14, four minutes late", never "08:14:00+01:00"; delays under a minute are "on time".
  Rain intensity in words (light, moderate, heavy), not mm/h.
- **Slow tools.** Overpass and `trip` can exceed 2 s; they get a lead-in ("let me look") per
  [landscape-launchers §3.16](../module-investigation/landscape-launchers-and-agent-tools.md), and hard timeouts of 3–4 s.
- **Intents.** The weather `today` action exists; add `rain_soon`, `warnings`, `next_departure`, `commute`, `bin_next` with Dutch and
  English `examples` ("gaat het regenen", "welke container moet buiten", "wanneer gaat mijn trein").
- **Assistant templates.** None of its own; these modules belong to the general and kitchen assistants. A `briefing`
  module (separate document, not here) composes weather, warnings, bin day and commute.
- **[Tool context](../module-investigation/shared-state-jobs-and-notifications.md).** Needed for "here" (the device's room
  does not move, so "near here" means home for every device today) and for whose commute and parcels.
- **Other modules.** `smart-home` for the HA bin-day path; a future mail module for parcels; `assistant-controls`
  ([assistant-controls.md](assistant-controls.md)) for "send that to my phone".

## 13. Privacy and safety

- The home address leaves the house with every routing, geocoding and transit query. Weather needs far less: round
  coordinates to two decimals (about 1 km) for Open-Meteo and Buienradar; send full precision only to routing.
- The User-Agent names the application and the owner-chosen contact, nothing else (Transitous and Nominatim require a
  contact; it must not be filled with the owner's address by default).
- Commute watches reveal routines; they are person-scoped and not readable from shared devices by other people once
  persons exist. Parcel labels can be personal ("present for Anna"): `sensitivity: "personal"`, not shown on shared or
  public screens, listed only to the owner of the parcel.
- No tool here changes the world except `parcel_add` (spends quota); no confirmation is needed beyond that.
- Guests and children may ask everything except parcels and commute details.

## 14. Foundations needed

| Foundation | Needed for | Without it |
|---|---|---|
| Module manifest (`requires`, `health`) | spoken "can't reach" lines, Health page | the module fails inside a turn with a `ToolError` |
| Module store | favourites, caches, parcels, commute watches | in-memory caches; favourites as settings |
| Scheduler + Notification service | warnings, commute, bin reminder, parcels | ask-only; nothing proactive |
| Presentation | cards, tables, rain chart | speech only (fine for all but maps) |
| Household places (a `records` field) | travel, nearby, commute | a `work address` text field per module |
| Tool context | "here", "my" | home and the single owner |

**Useful first version without any foundation:** `weather_rain_soon`, `weather_forecast` and `weather_warnings` in the
existing `weather` module (S, keyless), plus a `bin-day` module that reads an ICS URL on demand and answers
`bin_next`. Both are pure request-and-answer tools.

## 15. Open questions

1. **Location.** Am I right that the household is in the Netherlands, and that a precise home address (not just a
   town) may be stored and sent to routing services?
2. **Rain source.** Open-Meteo only (one provider, worldwide), or Buienradar's undocumented radar endpoint as the NL
   default, accepting that it may break and is non-commercial only?
3. **Warnings.** MeteoAlarm's fragile feed now, or wait for KNMI's post-2026 warnings dataset (needs a key)?
4. **Split.** I merge `places` and `travel` into one module, unlike the separate rows in
   [landscape-launchers §7](../module-investigation/landscape-launchers-and-agent-tools.md), because they share geocoding,
   saved places and a key-free backend. Agree, or keep them apart?
5. **Commute.** Who commutes, how (bike, train, car), and should a delay notice go to a speaker at home or to a phone?
6. **Self-hosting.** Is running OSRM or MOTIS on the server acceptable, or must public services do?
7. **Bin day.** Does your municipality publish an ICS calendar, or does Home Assistant already run
   `waste_collection_schedule`?
8. **Parcels.** Worth paying for 17TRACK, or wait for a mail module and parse shipping e-mails?
9. **Markets and sports.** Any team or stock you would actually ask about? If not, skip both.
