# Energy and vehicle

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md):
module definition ([`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)),
shared state ([`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md))
and presentation ([`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md)),
cited as "module definition §n", "shared state §n" and "presentation §n".

## 1. Summary

The module answers questions about the house's energy and the car, and acts on the cheap hours: solar production,
use, home battery, gas; today's and tomorrow's dynamic electricity prices; "when is the cheapest time to run the
dishwasher"; starting or scheduling appliances; the car's state of charge, charging and preconditioning; the heat
pump; weekly summaries and anomaly alerts; a chart on the stage.

**Boundary.** [smart-home](smart-home.md) sketches `energy_now` / `energy_today` and the `energySensors` setting
(smart-home §4, §10). This module takes those over. It reads HA through smart-home's socket and HA's statistics, and
calls price sources and evcc directly. Climate control in general (`climate_set`) stays in smart-home; this module
only adds heat-pump energy questions and price-aware modes.

- **Priority: second wave, with the price slice early if the household has a dynamic contract.** In the Netherlands
  net metering (*salderen*) ends on 1 January 2027 ([Gaslicht](https://www.gaslicht.com/blog/salderingsregeling-afgeschaft-gevolgen/),
  [Omgevingsweb](https://omgevingsweb.nl/nieuws/einde-salderingsregeling-wat-verandert-er-voor-boeren-en-burgers-op-1-januari-2027/)),
  six weeks from now, so using your own solar and the cheap hours becomes worth real money.
- **Effort: M.** Prices and the cheapest-window calculation are S. Energy questions over HA statistics are S. Car via
  evcc is S; car without evcc is M (one integration per brand). Appliance scheduling depends on the appliance (S to
  M). Anomaly alerts are S–M.

**Recommendation:** HA for every measurement and device, a provider-neutral `PriceSource` (HA integration first,
ENTSO-E direct second), evcc as the charging brain when present, and our own small planner for "cheapest window".

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| **HA Energy dashboard** | Grid, solar, battery, gas, water, individual devices from long-term statistics; costs from a price entity. | Its configuration as our source of truth for which sensors mean what (`energy/get_prefs`, from memory). | Cost maths that ignores tax and supplier markup. |
| **HA price integrations** | `tibber.get_prices`, `energyzero.get_energy_prices`, `easyenergy.get_energy_usage_prices` / `get_energy_return_prices`, `nordpool.get_prices_for_date` (Nord Pool is spot only, excluding VAT and fees, published around 13:00 CET) ([Tibber](https://www.home-assistant.io/actions/tibber.get_prices/), [EnergyZero](https://www.home-assistant.io/actions/energyzero.get_energy_prices/), [easyEnergy](https://www.home-assistant.io/actions/easyenergy.get_energy_usage_prices/), [Nord Pool](https://www.home-assistant.io/integrations/nordpool)). ANWB Energie is served by the EnergyZero integration; Zonneplan has a core integration; Frank Energie a maintained HACS fork; EnerPrice (HACS) covers many Dutch suppliers' all-in tariffs ([forum](https://community.home-assistant.io/t/enerprice-dynamic-energy-prices-day-ahead-energy-prices-all-in-tariffs-price-analysis-forecasts-and-more/1016763)). | Response-data actions: one call returns the whole day. | Assuming hourly: since 1 October 2025 the EU day-ahead market clears per 15 minutes ([European Commission](https://energy.ec.europa.eu/news/eu-electricity-trading-day-ahead-markets-becomes-more-dynamic-2025-10-01_en)); some Dutch suppliers bill per quarter, others still hourly ([ACM](https://www.acm.nl/en/publications/acms-monitor-consumer-energy-market-rates-have-slightly-gone-down-start-heating-season-good-time-review-energy-contracts)). |
| **ENTSO-E Transparency** | Free day-ahead prices per bidding zone (NL `10YNL----------L`), `documentType=A44`, XML, with a security token requested from ENTSO-E (from memory, unverified details). | A supplier-neutral source that needs no HA. | Raw EUR/MWh read out as if it were the consumer price. |
| **Tibber / Zonneplan / Frank apps** | Smart charging and battery trading in the supplier's cloud. | "Ready by 07:00 at the lowest cost" as the user's sentence. | A cloud between the car and the house. |
| **evcc** ([REST API](https://docs.evcc.io/en/docs/integrations/rest-api)) | Local charging controller: PV surplus charging, tariffs (including dynamic ones), plans. `POST /api/loadpoints/<id>/mode/<mode>`, `POST /api/vehicles/<name>/plan/soc/<soc>/<RFC3339 time>`, `POST /api/loadpoints/<id>/limitsoc/<soc>`, `GET /api/state`; MQTT mirrors it under `evcc/loadpoints/<id>/`. Recent versions report `smart` where older ones said `pv`; `minpv` is now smart with always-charge ([evcc blog 2026-09](https://docs.evcc.io/en/blog/2026/09/25/highlights-smart-battery-solar-share)). | Delegate charging logic to it; ask it for the plan. | Version drift in mode names: read `GET /api/state` and map. |
| **Car integrations in HA** | Tesla Fleet and Tessie, Renault, Kia/Hyundai (HACS), Volkswagen ID (HACS), Polestar (HACS) and others expose battery level, range, charging switch and climate (names and coverage from memory, unverified). | One `vehicle` interface over these entities. | Waking the car with every question (battery drain, rate limits). |

## 3. Example conversations

1. "How much solar today?" → "11.4 kilowatt-hours so far. The house used 8.1, so you sent 4.6 to the grid." `chart`
   on a screen.
2. **Cheapest window.** "When's the cheapest time to run the dishwasher?" → "Between 02:15 and 04:15, about 18 cents
   cheaper than now. Or 12:30 tomorrow if the sun comes out." `chart` with the window shaded.
3. **Schedule.** "Start it then." → "The dishwasher will start at 02:15." (Home Connect remote start, if the appliance
   allows it.) Without remote start: "I can't start this dishwasher remotely. Set its delay to 5 hours."
4. **Prices.** "Is stroom nu duur?" → "Ja, 34 cent per kilowattuur. Vanaf 22:00 zakt het naar 21 cent." All-in price,
   including tax, as configured.
5. **Car.** "Is the car charged?" → "The Polestar is at 64 %, about 260 km. It's plugged in, charging on solar."
6. **Charge plan.** "Make sure the car is at 80 % by seven." → "Planned: 80 % by 07:00, charging mostly from 01:00 to
   04:30." (evcc plan.)
7. **Precondition.** "Warm up the car at a quarter past seven." → "The car will start heating at 07:15." Outward
   effect on a device outside the house, `change` class.
8. **Ambiguous.** "Charge the car." with two cars → "The Polestar or the Zoe?" One car plugged in → that one.
9. **Anomaly, proactive.** Morning briefing line: "The house used 40 % more than usual overnight. The freezer plug
   reported nothing since 01:10." (§9.)
10. **Failure.** Prices for tomorrow not yet published at 11:00: "Tomorrow's prices come out early afternoon. Right
    now the cheapest hour left today is 15:00."

## 4. Tools

| Tool / action | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `energy_now` | `kind?` (`use`, `solar`, `grid`, `battery`, `gas`) | Current watts, battery %, import/export | R | safe (`read`) | <5 ms cached | yes |
| `energy_period` | `kind?`, `period` (`today`, `yesterday`, `week`, `month`, or a range), `compare?` | kWh, m³, cost, comparison; `chart` | R | safe | 50–300 ms (HA statistics) | yes for today/yesterday |
| `price_now` | `when?` (`now`, `tonight`, `tomorrow`) | All-in price now, cheapest and dearest periods; `chart` | R | safe | <5 ms cached | yes |
| `price_cheapest_window` | `appliance?` (dynamic: owner profiles), `duration?`, `energy_kwh?`, `before?`, `after?`, `include_solar?` (default true) | Start, end, saving versus now; alternatives | R | safe | <20 ms (local computation) | yes for named appliances |
| `appliance_schedule` | `appliance`, `start` (time or `cheapest`), `before?` | Confirmation and the job id | W | `change` | <50 ms; at fire time the HA call | no (needs a start time chosen) |
| `appliance_schedule_list` / `_cancel` | `id?` | Pending scheduled starts | R / W | safe / `change` | <5 ms | yes |
| `vehicle_status` | `vehicle?` | SoC, range, plugged in, charging power, plan | R | safe | <5 ms cached (no car wake-up) | yes |
| `vehicle_charge` | `vehicle?`, `mode` (`now`, `solar`, `smart`, `off`), `target_soc?`, `by?` | evcc's resulting mode and plan | W | `change` | 100–500 ms | yes for `now`/`off` |
| `vehicle_precondition` | `vehicle?`, `at?` (default now), `temperature?` | Confirmation | W | `change` | 1–10 s (car cloud, unverified) | yes for "now" |
| `heat_pump_status` | — | Mode, flow temperature, COP today if available, kWh | R | safe | <5 ms | yes |
| `energy_anomalies` | `since?` | Open anomalies with explanation | R | safe | <10 ms | no |

Unlocking the car or opening its charge port is out of scope (`security`).

## 5. Integrate or build

| Need | Options | Recommendation |
|---|---|---|
| Measurements | HA entities and long-term statistics (`recorder/statistics_during_period` over WebSocket with `period: hour \| day \| month` and `types: ["change"]`, from memory); P1 meter via HA's DSMR or HomeWizard integrations | **HA only.** We never talk to inverters or meters directly. |
| Prices | (a) the supplier's HA integration action; (b) Nord Pool or ENTSO-E spot plus our own tariff formula; (c) EnerPrice (HACS) | **(a) where the supplier has one** (its prices already include its markup); **(b) as the fallback**, with the formula `(spot + supplier markup + energy tax) × (1 + VAT)` and the components as household settings, because Dutch tax rates change each 1 January. |
| Solar forecast | HA `forecast_solar` or Solcast (HACS) entities | Read if present; `include_solar` treats forecast surplus as near-zero marginal cost after 2027 (feed-in pays roughly spot minus fees, unverified for each supplier). |
| Cheapest window | build | A sliding window over 15-minute slots, minimising the sum of price × the appliance's energy per slot (flat profile, or an owner-recorded profile from a smart plug), with `before`/`after` limits and a "not during quiet hours" option for noisy machines. |
| Appliances | Home Connect (Bosch, Siemens) and Miele HA integrations; smart plug for simple loads; otherwise advice only | Use HA. Remote start must be enabled on the appliance; whether each integration allows a delayed start is unverified. |
| Charging | evcc; car integration directly; supplier smart charging | **evcc when present**; car entities for status otherwise; never duplicate evcc's planner. |
| Heat pump | HA `climate` / `water_heater` / sensors (Daikin, Mitsubishi, Panasonic, Quatt; coverage unverified) | Read-only questions plus owner-defined "eco" and "boost" scripts. |

## 6. Data

| What | Scope | Store | Shape |
|---|---|---|---|
| Sensor map | household | settings (from HA energy prefs, editable) | `{ grid_import, grid_export, solar, battery_soc, battery_power, gas, devices: [{ name, entity }] }` |
| Tariff | household | settings | `{ source: "ha:<entity or action>" \| "entsoe" \| "nordpool", resolution: 15 \| 60, markup_ct, tax_ct, vat, feedin_rule }` |
| Price cache | household | Module store, 3 days | `{ slotStart, minutes, spot, allIn }` |
| Appliance profiles | household | settings records | `{ name, aliases[], durationMin, kWh, profile?: number[], startEntity?, startMethod: "home_connect" \| "switch" \| "script" \| "advice", quiet: bool }` |
| Scheduled starts | household | Module store `schedules` + a Scheduler job | `{ appliance, at, createdBy, reason: "cheapest", expectedSaving }` |
| Vehicles | household | settings | `{ name, aliases[], evccVehicle?, socEntity?, pluggedEntity?, climateEntity? }` |
| Baselines | household | Module store | hour-of-week medians of import, 4 weeks |

**Exports:** `energy.today` (briefing), `price.window(duration)` (routines and timers: "cheapest hour"),
`vehicle.status` (briefing: "the car is at 64 %").

## 7. Long-running work and events

- **Jobs:** a daily price fetch at 13:15 CET and retries every 30 min until tomorrow's prices exist; scheduled appliance
  starts (Scheduler `deferred command`, shared state §6.1); a nightly baseline update; preconditioning at a time.
- **Restart:** scheduled starts survive (store + Scheduler). A start missed while the server was down is **not** run
  late (the price window has passed); the creator's device is told at the next turn.
- **Listens:** `presence.everyone_left` / `presence.first_home` ([presence-and-people](presence-and-people.md) §7) for
  owner-defined away modes; evcc MQTT for "charging finished".
- **Emits:** `energy.prices.published`, `energy.cheap_window` (start of an owner-marked cheap period),
  `energy.anomaly`, `vehicle.charged`, `vehicle.plugged`.

## 8. Presentation

| Situation | Kind | Without a screen |
|---|---|---|
| Prices today and tomorrow | `chart` bar, one bar per slot, colour by price band, the chosen window shaded (needs a `bands` option on `chart`, an addition to presentation §3.2) | "Cheapest from 02:15 to 04:15, at 21 cents; most expensive at 18:00" |
| Production and use | `chart` line, solar against use; `facts` for totals | Totals in one sentence |
| Car | `facts` (SoC gauge, range, plan) | One sentence |
| Scheduled start | pinned `progress` "Dishwasher at 02:15" in Orbit | — |

Charts follow one palette and never encode meaning in colour alone; the saving is printed as a number.

## 9. Notifications and proactive behaviour

| Case | Priority | Audience |
|---|---|---|
| Car charged to plan | `low` | inbox; the owner's phone if asked |
| Car not plugged in at 21:00 while a plan exists | `normal` | the car owner's devices |
| Negative or very low prices tomorrow (owner threshold) | `low` | inbox, briefing |
| Anomaly: base load 40 % above the 4-week median for 3 hours, a device plug at 0 W that is normally on (freezer), solar at zero on a sunny day | `normal` (freezer `high`) | adults |
| Scheduled start could not run | `normal` | the creator |

No "it's cheap now, run the washing machine" nudges unless the owner subscribes to them.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | currency (exists in the plan), tariff components, quiet hours | — |
| Module | sensor map; price source; evcc URL; vehicles; appliance profiles; anomaly thresholds; daily summary in briefing | from HA energy prefs; none |
| Assistant | module on/off; `offTools` (`vehicle_*`, `appliance_schedule`) | on |
| Device | — | — |
| Person | "my car" link; phone notifications for charging | — |

**First run.** (1) Import HA's energy configuration. (2) Pick the price source and confirm the all-in price for now
against the supplier's app. (3) Add appliances with duration and kWh (or record one cycle from a plug). (4) Add evcc or
car entities.

## 11. Native tools and dependencies

| Need | Where | When missing |
|---|---|---|
| HA energy sensors | LAN | "I don't have energy meters from Home Assistant." |
| A price source (HA integration, ENTSO-E token, or Nord Pool) | internet | "I don't know your electricity prices; tell me your supplier in the settings." |
| evcc (optional) | LAN | Charging control falls back to the car's switch, without plans: "I can start or stop charging, but I can't plan it without evcc." |
| Appliance with remote start | appliance | Advice only: "Set the delay to 5 hours." |

## 12. Interaction with the rest of the system

- **Numbers in speech.** Prices in cents with no decimals ("21 cent"), energy with one decimal, times rounded to the
  quarter hour. Dutch "kilowattuur" and "kuub" (m³ gas) are parsed and spoken.
- **Fillers.** None; every read is cached. Car commands that go through the manufacturer's cloud get "Asking the car".
- **Routines.** `price.window` lets a routine say "at the cheapest two hours tonight, run the dryer".
- **Briefing.** One line: yesterday's use and cost, today's cheapest window, the car's SoC.
- **Assistants.** No template; household assistants get read tools, write tools on adults' assistants.

## 13. Privacy and safety

- Energy use reveals presence and routines; the household's data stays local. ENTSO-E and Nord Pool calls carry no
  household data.
- Starting appliances unattended is a fire-safety question (dryers at night). The appliance profile has `night: bool`;
  dryers default to false.
- Car commands work on a device outside the house; preconditioning is `change`, any lock or charge-port command is
  out of scope.

## 14. Foundations needed

Scheduler (scheduled starts, price fetch), Module store, Presentation (`chart` with bands, `facts`), Notification
service, Event bus (presence, evcc), smart-home's socket. **First version without them:** `energy_now`,
`energy_period` (speech only), `price_now` and `price_cheapest_window` from an HA price integration, and
`vehicle_status` from evcc or HA. Effort S.

## 15. Open questions

1. **Your contract:** dynamic (which supplier: Tibber, Zonneplan, Frank, ANWB, other) or fixed? Billed per hour or
   per quarter? This decides whether the price slice is worth building now.
2. **Ownership:** move `energy_now` / `energy_today` from smart-home §4 to this module? Proposed yes.
3. **evcc:** do you run it, or should charging go through the car's integration only?
4. **Appliances:** which ones can start remotely (Home Connect, Miele), and do you want the assistant to start them
   unattended at night?
5. **All-in price:** trust the supplier integration's numbers, or compute from spot plus settings so every source
   gives the same figure?
6. **Anomaly alerts:** on by default, or only in the briefing?
7. **Home battery:** do you have or plan one (after 2027 self-consumption matters more), and should the assistant ever
   change its mode, or only report?
