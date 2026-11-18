# Weather (`weather`)

Today's weather and the forecast for the home or a named place, from Open-Meteo.

- Package: `packages/modules-builtin`: `src/weather.ts`, and new files only under `src/weather/`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 18 (wave A); extended by the local-info pull request (`weather_rain_soon`, `weather_forecast`, `weather_warnings`, a briefing section)
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
- **`weather_warnings`**: code yellow, orange or red warnings in force or beginning in the next 48 hours for the place's
  region, from the public MeteoAlarm service. When the service cannot be reached or its answer is not what was expected the
  tool says it **cannot check**, never "no warnings".
- **Two briefing sections**, `weather` (the day, and first any rain that starts in the next two hours, which makes it a `lead`)
  and `weather.warnings` (a sentence when there is a warning, otherwise nothing; a failure when it cannot be checked).

The first two (`weather`, `today`) are unchanged and keep using their own `fetch`; the new parts fetch through `@pva/net`'s
`safeFetch` (via `makeCachedJson`: forecasts are kept ten minutes, warnings fifteen, places a day, an old answer serves up to
three hours when the service fails, but a rain answer older than 20 minutes is not used). Coordinates are rounded to two decimals
(about a kilometre) before they leave the house. The weather module is **on by default**, as before; its tool list now has the
three new tools.

No personal content: weather is the household's, and every device is told the same.

## Tools

| Tool / action | Risk | Parameters | Says (example) |
|---|---|---|---|
| `weather` / `weather.today` | read | `place?` | unchanged |
| `weather_rain_soon` | read (speculative) | `place?`, `minutes?` (30 to 120, default 120) | "Dry until about 11:15, then light rain for about 30 minutes." |
| `weather_forecast` | read (speculative) | `place?`, `day?` (today, tomorrow, weekday, date), `hours?` (1 to 24, today) | "Tomorrow: light rain, 8 to 13 degrees, 70 percent chance of rain, wind up to 35 km/h." |
| `weather_warnings` | read (speculative) | `place?` | "Code yellow for wind in Utrecht until six o'clock." / "No weather warnings for Utrecht." |
| `weather.rain_soon` (action) | read | none (home) | "gaat het het komende uur regenen", "will it rain in the next hour" |
| `weather.tomorrow` (action) | read | none (home) | "wat voor weer wordt het morgen", "what's the weather tomorrow" |
| `weather.warnings` (action) | read | none (home) | "zijn er weerwaarschuwingen", "any weather warnings" |

The actions are for the typed path (no model) and are not also offered as tools; they use home only, because a place word after
"in" would take "the next hour" for a place. Every sentence is in English and Dutch (the household's language).

## Settings

No new settings: the module's own (Home location, Units, Timeout) are unchanged and still `overridable` per assistant
where they were. A briefing and the tools use the place and units of **the asking assistant**, asked at each call. Warnings
need the place's country (from the geocoder) to pick the national feed and match the warning's region by the place's region or
name; the country feed is `feeds.meteoalarm.org/api/v1/warnings/feeds-<country>`.

## What it stores

Nothing: no collection and no job. Its caches (places, forecasts, warnings) are in memory, in the module's shared part, and are
empty after a restart.

## What it needs

`requires: internet` and a `health` (which has nothing to check without a network: it reports nothing). It **provides** two
`BriefingSections` contributions (`weather`, `weather.warnings`). Outside services: Open-Meteo (geocoding, forecast, rain; its free
tier is for non-commercial use, under 10,000 calls a day) and MeteoAlarm. The User-Agent is the product token, plus the owner's
contact (Home › API contact) only when set.

**Not checked against the live services.** The author had no network: the MeteoAlarm feed's JSON shape (a `warnings` list of
CAP `alert`s with `awareness_level` and `awareness_type` parameters and `areaDesc` areas) is read from what the service documents
and from the research document, strictly, and is tested with fixtures of that shape. If the live feed differs, the warnings tools
answer "I can't check weather warnings at the moment" rather than a wrong all-clear; that is the first thing to look at when the
module is first run for real.

## What was left out

Left out because it waits for **wave B** (no presentations, notifications or module speech yet): the `weather` presentation
(a forecast card, the rain bar chart), the warning notification ("code orange for wind") and "tell me when it starts raining",
and the ambient fact on screens.

Left out for the first version, as the plan's row says: Buienradar's radar nowcast as a rain source for the Netherlands and
Belgium, KNMI's own warnings dataset, the `warnings_seen` collection and the `weather.warning` event, a poll job for warnings, and
a warnings region setting. The two earlier tools keep their own `fetch` (their tests and the module's behaviour are unchanged).
