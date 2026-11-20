# Plants and pets

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md):
module definition ([`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)),
shared state ([`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md))
and presentation ([`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md)),
cited as "module definition §n", "shared state §n" and "presentation §n".

## 1. Summary

Care logs for living things. Pets: a feeding log so two people do not both feed the dog, medication, vet
appointments, and automatic feeders, litter boxes and pet flaps through Home Assistant (HA). Plants: watering
schedules, soil-moisture sensors through HA, weather-aware advice, identification from a photo. Garden: irrigation
zones that skip watering after rain.

**Boundaries.** Medication and vet reminders are delivered by [reminders](reminders.md) (nagging, done and snooze);
vet appointments live in [calendar](calendar.md). Pet food stock is the [kitchen](kitchen.md) pantry's. Device control
goes through [smart-home](smart-home.md)'s HA socket.

- **Priority: later**, except the feeding log, which is a small, daily, two-person win and can come with the second
  wave.
- **Effort: S–M.** The feeding log and medication on reminders are S. Plant schedules and HA sensors are S.
  Identification (Pl@ntNet) is S. Irrigation through HA is S if the owner already runs Smart Irrigation, M otherwise.

**Recommendation:** one small module with a care log in our store; HA for every sensor and device; Pl@ntNet for
identification; no own irrigation logic.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| **Whisker (Litter-Robot, Feeder-Robot)** in HA ([docs](https://www.home-assistant.io/integrations/litterrobot/)) | Core integration: litter box state and waste level, feeder food level, meal log, a "give snack" button; push updates. | Feeder events as log entries ("the feeder gave breakfast at 07:00"). | — |
| **Sure Petcare** in HA | Core integration for flaps and feeders: pet inside/outside, flap lock modes. | "Is the cat in?" | Locking a flap by voice without the owner's say. |
| **Tractive** in HA ([docs](https://www.home-assistant.io/integrations/tractive/)) | GPS tracker location, activity; needs Tractive Premium. | "Where is the dog?" like a person. | — |
| **Petlibro** | Community HACS integrations only, support varies per model ([forum](https://community.home-assistant.io/t/petlibro-cloud-integration-non-tuya-wip/759978)). | — | Promising it works. |
| **Olen's Plant + OpenPlantbook** ([plant](https://github.com/Olen/homeassistant-plant), [openplantbook](https://github.com/Olen/home-assistant-openplantbook)) | A plant device per plant combining moisture, conductivity, light, temperature and humidity sensors with species thresholds from OpenPlantbook (free account, client id and secret). Not compatible with HA's built-in `plant`. FYTA has a core integration. | Thresholds per species; one "problem" state per plant. | — |
| **Pl@ntNet API** ([quota](https://my.plantnet.org/doc/api/quota), [terms](https://my.plantnet.org/terms_of_use)) | Identification from photos; free up to 500 identifications a day, 10 concurrent requests, quota per day reset at 00:00 UTC; `remainingIdentificationRequests` in each answer. | Free, European (Cirad/INRAE/Inria/IRD consortium, from memory). | — |
| **Smart Irrigation** (HACS, [README](https://github.com/jeroenterheerdt/HAsmartirrigation/blob/master/README.md)) | A per-zone "bucket": add net precipitation (rain minus evapotranspiration), water when below zero, `smart_irrigation.reset_bucket` after watering; weather from OpenWeatherMap, Pirate Weather or sensors. Maintenance appears to have moved to a fork ([altmenorg](https://github.com/altmenorg/HAsmartirrigation), unverified). | Let HA decide run times; we only report and ask. | Our own ET model. |
| **Open-Meteo** | Daily `et0_fao_evapotranspiration` and `precipitation_sum` (variable names from memory); the weather module already calls Open-Meteo (current-system §1.4). | Weather-aware plant advice without another key. | — |

## 3. Example conversations

1. **Feeding log.** "Did anyone feed the dog?" → "Yes, Anna fed Bobbie at 07:40." Or: "Not yet today. Breakfast is
   usually at 07:30."
2. "I just fed the dog." → "Logged: Bobbie, breakfast, 08:05, by Ian." Device person or voice hint (presence-and-people).
3. **Double feeding.** Sam: "I fed the cat." at 18:10, Anna fed her at 17:55 → "Logged, but Anna already fed Mimi at
   17:55. Logged it as a second meal."
4. "Heeft de kat al eten gehad?" → "Ja, de voerautomaat gaf om 07:00 ontbijt, 30 gram." From the Feeder-Robot.
5. **Medication.** "Bobbie needs his pill every morning for ten days." → "Every day at 08:00 until 28 November:
   Bobbie's pill. I'll keep reminding until someone says done." (a nagging reminder)
6. **Plants.** "Do the plants need water?" → "The monstera is dry: 12 % moisture, below its 15 %. The others are fine."
7. **Weather-aware.** "Should I water the garden?" → "No. 9 mm of rain fell yesterday and more is forecast tonight."
8. **Identification, needs a camera on the device.** "What plant is this?" (photo from a phone or tablet) → "Most likely
   a Calathea orbifolia, 87 % sure. It likes indirect light and moist soil." (Pl@ntNet)
9. **Ambiguous.** "Did you feed them?" with a dog and a cat → "The dog or the cat?"
10. **Failure.** "Is the litter box full?" with Whisker's cloud down → "I can't reach the Litter-Robot right now. Last
    reading at 14:00: 60 % full."

## 4. Tools

| Tool / action | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `care_log` | `subject` (dynamic: pets, plants, garden zones), `what` (`fed`, `walked`, `medicine`, `watered`, `fertilised`, free text), `amount?`, `by?`, `at?` | Logged; warns on a likely duplicate | W | `change` | <20 ms | yes ("I fed the dog") |
| `care_last` | `subject`, `what?` | Last entry with who and when, including feeder and sensor events | R | safe | <10 ms | yes ("did anyone feed …") |
| `care_today` | `subject?` | Today's entries and what is still due | R | safe | <10 ms | yes |
| `care_schedule` | `subject`, `what`, `every` (RRULE phrase), `until?`, `nag?` | Creates a reminder through the reminders service | W | `change` | <20 ms | no |
| `pet_status` | `pet?` | Inside/outside (flap), location (Tractive), feeder and litter levels | R | safe | <5 ms cached | yes |
| `feeder_give` | `feeder`, `portions?` (default 1) | Confirmation | W | `change` | 0.5–3 s (vendor cloud, unverified) | yes |
| `plant_status` | `plant?`, `room?` | Problems first: moisture, light, temperature versus thresholds | R | safe | <5 ms | yes |
| `plant_identify` | image from the device (screen device with camera) | Species with score, care summary | R | safe; sends a photo to Pl@ntNet | 1–3 s (unverified) | no |
| `garden_watering` | `zone?` | Skip or water, and why (rain, ET0, bucket) | R | safe | <50 ms | yes |
| `irrigation_run` | `zone`, `minutes?` (default from Smart Irrigation) | Started; stops by HA | W | `change` | ~200 ms | yes |

## 5. Integrate or build

- **Care log: build.** It is a small table with a fast path; no app does "two people, one dog" with voice.
- **Devices: HA only** (Whisker, Sure Petcare, Tractive, Petlibro via HACS, Olen's Plant, FYTA, Xiaomi BLE or Zigbee
  soil sensors, OpenSprinkler, Gardena, Rachio). Feeder and litter events from HA become log entries with
  `by: "feeder"`.
- **Thresholds:** from Olen's Plant entities when present; otherwise owner-set per plant with OpenPlantbook as an
  optional lookup.
- **Identification:** Pl@ntNet (`POST https://my-api.plantnet.org/v2/identify/all?api-key=…` with `images` and
  `organs` parts, from memory) within the free quota; a vision LLM as a fallback that says it is less certain.
- **Watering advice:** Smart Irrigation's bucket when present; otherwise one rule: skip if rain in the last 24 h plus
  the forecast for the next 24 h exceeds the day's ET0 (Open-Meteo), else water. Indoor plants follow sensors or
  schedules, never weather.

## 6. Data

| Table | Scope | Shape |
|---|---|---|
| `m_care__subjects` | household | `{ id, kind: pet \| plant \| zone, name, aliases[], species?, room?, entities: { feeder?, litter?, flap?, tracker?, plant?, moisture?, valve? }, photoMediaId? }` |
| `m_care__log` | household | `{ subjectId, what, amount?, by: PersonId \| "feeder" \| "sensor" \| "guest", at, note?, source: voice \| ha \| ui }` |
| `m_care__schedules` | household | `{ subjectId, what, rrule, until?, nag?, reminderId }` |

Kept one year (vet visits want history: "when did he last get worming tablets?"). **Exports:** `care.today` (briefing:
"the cat's pill is still due"), `care.last(subject, what)`.

## 7. Long-running work and events

- Schedules are reminders (reminders §7); `reminders.done` for a care reminder writes a log entry.
- **Listens:** HA feeder, litter and flap events through smart-home's socket; plant problem states; `presence.left`
  (optional: "nobody fed the dog today and everyone is out", §9).
- **Emits:** `care.logged`, `care.missed`, `care.plant.problem`.
- **Restart:** feeder events missed while down are read back from the integration's meal log where available (unverified
  per vendor); otherwise lost.

## 8. Presentation

| Situation | Kind | Without a screen |
|---|---|---|
| "Did anyone feed …" | `facts` (last fed, by, next due) | One sentence |
| Today | `list` per subject, tick to log | Top three |
| Plants | `list` sorted by problem, small sensor bars | Problems only |
| Identification | `card` with the matched photo (from Pl@ntNet's reference images via `/media/`), score, care | Species and score |
| Garden | `facts` (rain, ET0, decision) | One sentence |

## 9. Notifications and proactive behaviour

| Case | Priority | Audience |
|---|---|---|
| Pet medication due | `normal`, nag until done | the assignee's devices, then the phone |
| Pet not fed by the usual time + 2 h (owner opt-in) | `normal` | adults at home; phone if nobody is home |
| Litter box full, feeder low or jammed | `low` (jam `normal`) | inbox |
| Plant dry | `low` | inbox and briefing; never spoken unprompted |
| Frost tonight and garden plants marked tender | `low` | briefing (from the weather module) |

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | pets and plants (subjects), usual feeding times | — |
| Module | duplicate window (60 min); "not fed" alert; Pl@ntNet key (vault); OpenPlantbook client (vault); watering rule | 60 min; off; —; —; Smart Irrigation if present |
| Assistant | module on/off; `offTools` (`feeder_give`, `irrigation_run`) | on |
| Device | — | — |
| Person | assignee for medication; children may log feeding | — ; yes |

**First run:** add pets and plants, link HA entities, set usual feeding times; optionally add the Pl@ntNet key.

## 11. Native tools and dependencies

| Need | Where | When missing |
|---|---|---|
| HA pet and plant integrations | LAN, vendor clouds for some | Log by voice only: "I don't see a feeder; I'll go by what you tell me." |
| Pl@ntNet API key | internet | "I can't identify plants without a Pl@ntNet key." |
| A camera on the asking device | screen device | "Show me the plant on a device with a camera." |
| Open-Meteo | internet | "I can't check the rain right now." |

## 12. Interaction with the rest of the system

- **Speech.** Pet names are proper nouns: hot words, aliases ("Bob", "Bobbie"). "Fed" and "feed" are easily confused
  by recognisers; "I fed the dog" vs "feed the dog" (a command for a feeder) is resolved by tense and by whether a
  feeder exists, and a command on a feeder gets an echo before it runs.
- **Presence.** Who logged it comes from the device person or the voice hint ([presence-and-people](presence-and-people.md));
  a wrong name is harmless and can be corrected ("that was Sam").
- **Other modules.** Reminders (schedules), calendar (vet), kitchen (pet food on the shopping list when the feeder's
  hopper is low and stock is out), local-info weather (rain, frost), images (identification photo handling).

## 13. Privacy and safety

- Plant photos go to Pl@ntNet; photos with people in them should not. The tool asks the device to crop to the plant
  when possible and states that the photo leaves the house.
- Feeding by voice: a TV saying "feed the cat" could dispense food. `feeder_give` is limited to one portion per
  command and to the device's room unless named; a daily maximum from the feeder's own settings applies.
- Medication doses are logged as said; the assistant does not advise on veterinary dosing.

## 14. Foundations needed

Module store, reminders (Scheduler, Notification service), Event bus, smart-home's socket, Presentation (`facts`,
`list`, `card`), camera input from a screen device for identification (new: no device sends images today). **First
version:** `care_log`, `care_last`, `care_today` on our store, speech only. Effort S.

## 15. Open questions

1. **Which pets and devices** (Litter-Robot, Sure Petcare flap, Petlibro, Tractive), and which plants or sensors?
2. **"Not fed" alerts:** wanted, and to whom when nobody is home?
3. **Feeder by voice:** allow dispensing at all, or only on screens?
4. **Identification photo from the device:** the voice page has no camera capture today; is it worth adding for this
   and for home-maintenance type plates, or use the phone and a share link?
5. **One module or two?** This document keeps plants and pets together because the care log is the same shape. A
   separate `garden` module would make sense only with real irrigation.
