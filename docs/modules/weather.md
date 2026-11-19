# Weather (`weather`)

Today's weather and the forecast for the home or a named place, from Open-Meteo.

- Package: `packages/modules-builtin`: `src/weather.ts`, and new files only under `src/weather/`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 18 (wave A); extended by the local-info pull request (`weather_rain_soon`, `weather_forecast`, a briefing section)
- Research: [docs/research/modules/local-info.md](../research/modules/local-info.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

An existing module. The local-info pull request extends it in `src/weather.ts` and in new files only under
`src/weather/` (exported from `weather.ts`; never other files of `modules-builtin`), and fills in this page
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Weather from Open-Meteo, with no account. The module existed before (`weather` and the `today` action: current weather and
today's forecast); the local-info pull request adds, in `weather.ts` and `weather/`:

- **`weather_rain_soon`**: will it rain in the next 30 to 120 minutes, when it starts and stops, how hard (light, moderate,
  heavy: words, never millimetres), from Open-Meteo's 15-minute precipitation. Native quarter-hours exist in central Europe
  and North America; elsewhere Open-Meteo interpolates from hourly data, so the quarter-hours are less exact there.
- **`weather_forecast`**: one day of the coming week (today, tomorrow, a weekday, or a date): conditions, lowest and highest
  temperature, the chance of rain when it is 30 percent or more, strong wind when it is 30 km/h (20 mph) or more; with `hours`
  for today, a summary of the next hours.
- **A briefing section**, `weather` (the day, and first any rain that starts in the next two hours, which makes it a `lead`).

**The `weather` presentation.** A forecast of a day (`weather_forecast`, and the typed action `weather.tomorrow`, which is the
same answer) is also shown as a card on the device that asked, when it can show it (docs/PRESENTING.md, the `weather` kind),
and the answer the model reads is unchanged (the host adds "[Screen: Showing on …]" or "[Screen: Not showing it: … Say this
instead: …]" after it). The card says what the answer said and nothing more:

- **place**: the service's place name, cut to one line of at most 40 characters at a code point boundary (an emoji is never
  split); outside text, shown as text and never as markup.
- **now** (the kind's headline, which for a forecast is the day, not the moment): the day's range ("8 – 13°", "46 – 55 °F"),
  the condition in words ("Light rain", "Lichte regen") and an icon from the closed set, chosen from the weather code
  (clear or mainly clear: `sun`; partly cloudy: `partly`; overcast: `cloud`; fog: `fog`; drizzle, rain, showers: `rain`; snow:
  `snow`; thunderstorm: `storm`). A weather code with no icon gives the answer **without a card** rather than a guessed icon.
- **days**: one row, the asked day ("Today", "Tomorrow" or its weekday, in the household's language), its high and low
  and the same icon.
- The chance of rain, the wind and the coming hours (`hours`) have no field in the kind and stay in the spoken answer;
  the card never shows what the answer did not say.
- **spoken**: the day's sentence without the hours ("Tomorrow: light rain, 8 to 13 degrees, 70 percent chance of rain, wind up
  to 35 km/h."), which stands on its own for a device that cannot show the card. A rain answer (`weather_rain_soon`) and a
  failed or refused forecast show nothing and change nothing on the screen.
- **Transient**, the host's default: it stays 30 seconds and is replaced by the next thing shown on that device; it is
  withdrawn when it ends, and a page that was away does not get it back. A restart ends it with the module's part.
- **Privacy**: weather is the household's, so the presentation has no owner (`sensitivity: household`): the host decides
  for the device that would show it, at the moment of showing, and the shared, private and public devices of the
  household all show it to whoever asked there; a device with no display shows nothing and is told so.
- No buttons and no ticks, so no press handler.

**Only what the service really covered.** The service is asked for epoch timestamps (`timeformat=unixtime`) and the
place's IANA zone, so every quarter-hour and hour is an instant, worded in the place's own zone (right across the changes
of daylight saving time). A rain answer uses the quarter-hours from the one now is in, each following the last exactly,
none unknown; when they end before the time asked, it answers for what they cover and says "I only know until …", and
with less than a quarter of an hour known it says it has no rain data, never "dry". A day's forecast is found by its
calendar date in the place's zone at the moment of asking (or of the briefing), never by its position in the answer: a
forecast made before midnight still gives tomorrow as tomorrow. The coming hours start at the hour now is in, go on while
each row follows the last and has a temperature, and say until when they go when they stop early; a chance of rain the
service does not know is said to be unknown, never zero.

**One time budget.** A tool call or action has 4 s in all, geocoding included (or the module's Timeout when that is
shorter), each request getting the time that is left: under the gateway's five seconds, with time left to say why. A
briefing section has 650 ms in all, under the contract's 800 ms.

The first two (`weather`, `today`) are unchanged and keep using their own `fetch`; the new parts fetch through `@pva/net`'s
`safeFetch` (via `makeCachedJson`: forecasts are kept ten minutes, places a day, an old answer serves up to three hours when
the service fails, but a rain answer older than 20 minutes is not used). Coordinates are rounded to two decimals (about a
kilometre) before they leave the house. The weather module is **on by default**, as before; its tool list now has the two
new tools.

**Outside text.** The geocoder's place name, region and country are cut to one line of at most 80 characters (no control
or bidirectional characters); every result that holds one says it is the weather service's: data, not instructions. The
service's times are checked to be numbers and its zone to be a zone this machine knows; every series is at most 400 long.

No personal content: weather is the household's, and every device is told the same.

## Tools

| Tool / action | Risk | Parameters | Says (example) |
|---|---|---|---|
| `weather` / `weather.today` | read | `place?` | unchanged |
| `weather_rain_soon` | read (speculative) | `place?`, `minutes?` (30 to 120, default 120) | "Dry until about quarter past eleven, then moderate rain." / "No rain expected for the next 1 hour 55 minutes. I only know until noon." |
| `weather_forecast` | read (speculative) | `place?`, `day?` (today, tomorrow, weekday, date), `hours?` (1 to 24, today) | "Tomorrow: light rain, 8 to 13 degrees, 70 percent chance of rain, wind up to 35 km/h." (and the card above) |
| `weather.rain_soon` (action) | read | none (home) | "gaat het het komende uur regenen", "will it rain in the next hour" |
| `weather.tomorrow` (action) | read | none (home) | "wat voor weer wordt het morgen", "what's the weather tomorrow" (and the card above) |

The actions are for the typed path (no model) and are not also offered as tools; they use home only, because a place word after
"in" would take "the next hour" for a place. Every sentence is in English and Dutch: the household's language for tools and
actions, the briefing's own language for the section.

## Settings

No new settings: the module's own (Home location, Units, Timeout) are unchanged and still `overridable` per assistant
where they were. A briefing and the tools use the place and units of **the asking assistant**, asked at each call.

## What it stores

Nothing: no collection and no job. Its caches (places, forecasts) are in memory, in the module's shared part, and are
empty after a restart.

## What it needs

`requires: internet` and a `health` (which has nothing to check without a network: it reports nothing). It **provides** one
`BriefingSections` contribution (`weather`). Outside service: Open-Meteo (geocoding, forecast, rain; its free tier is for
non-commercial use, under 10,000 calls a day). The User-Agent is the product token, plus the owner's contact (Home › API
contact) only when set.

**Checked once against the live service.** On 18 November 2026 the exact request (latitude 51.48, longitude 0.00,
`timeformat=unixtime`, `past_minutely_15=2`, `forecast_minutely_15=12`, the hourly and daily fields) answered 200 in
0.5 s: integer epoch times, `timezone` "Europe/London", 14 quarter-hours from two before now with 900 s steps, 168 hours
and 7 days at local midnight, no nulls. That answer is kept as `packages/module-local-info/test/openMeteoLive.json` and a
test reads it through the real client. If the live answer changes, the tools say the service sent something they could
not read, or that they have no rain data, rather than a wrong answer.

## What was left out

Left out for later: "tell me when it starts raining" as a notification, the ambient fact on screens, a card for the rain
(the `weather` kind has no field for rain, and the forecast card does not carry the chance of rain), and a card for the
coming hours or for several days (the card is the one asked day).

**Weather warnings: left out.** They need a warning source whose answers have been checked against the live service and a
way to match a place to its region by code. (A first version read MeteoAlarm's feed, unverified, and matched places to
warning regions by comparing words; it could say "no weather warnings" when it could not tell, which is worse than no
tool.)

Left out for the first version, as the plan's row says: Buienradar's radar nowcast as a rain source for the Netherlands and
Belgium, and KNMI's own warnings dataset. The two earlier tools keep their own `fetch` (their tests and the module's behaviour
are unchanged).
