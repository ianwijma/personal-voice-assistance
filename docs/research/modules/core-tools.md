# Core tools: the generic agent toolbox

Research write-up, 2026-11-17. Not an approved design. It builds on
[landscape-launchers-and-agent-tools.md](../module-investigation/landscape-launchers-and-agent-tools.md) §1.4, §3.3–§3.9
and §7, and on what `packages/modules-builtin` holds today
([current-system.md](../module-investigation/current-system.md) §1.4: `clock` with `current_time`, the clock context
line and the `time_now` action; `weather`; the unwired `demo-home`). **(unverified)** marks claims I could not check
against a primary source. Latency figures are estimates to measure with `TurnTrace`, not results.

## 1. Summary

Every assistant should get a small set of tools for things a language model cannot know or cannot compute exactly:
exact arithmetic, unit and currency conversion, the time anywhere, date arithmetic, holidays, sunrise and sunset, a
grounded encyclopedia lookup, dice and coins, and the state of the assistant itself. The design goal is **five tools,
not fifteen**: one rich `calculate`, one rich `time`, one `lookup`, one `random`, one `system_status`. Everything the
model already does well (translation, definitions, spelling of common words) stays with the model, with instructions
and text-to-speech handling instead of a tool.

- **Priority: first wave.** These are the "quick answers" that make up about half of voice use (landscape §Summary),
  they are keyless and mostly offline, and they need none of the missing foundations.
- **Effort: M overall, made of S pieces.** `calculate` with currency is S, the `time` extension is S, `lookup`
  (Wikipedia, Wikidata, Wiktionary) is S, `random` and `system_status` are S each. The work that makes it M is the
  speaking side: number, unit and date formatting that suits TTS in English and Dutch.

## 2. What others do

| Product | What it ships | Copy | Avoid |
|---|---|---|---|
| [Raycast calculator](https://manual.raycast.com/calculator) | One input for maths, units, currencies, crypto, time zones ("5pm ldn in sf"), date maths ("monday in 3 weeks"), durations, percentages | One rich input over many narrow tools | Clipboard-centric output |
| [Alfred Calculate Anything](https://alfred.app/workflows/biatidigital/calculate-anything) | Currency (ECB rates by default), 5,000 cryptocurrencies, units, VAT, percentages, time | Currency folded into the calculator; rate date shown | Hundreds of keyword triggers |
| Alexa, Google, Siri | Built-in time, timers, maths, conversions, "how many days until", sunrise, holidays, Wikipedia-style answers (landscape-voice-assistants.md §1–§3) | Short spoken answers with one rounded number | Reading long decimals; mishearing "15 or 50" |
| Home Assistant Assist | Built-in intents `HassGetCurrentTime`, `HassGetCurrentDate`, weather and timers, answered without an LLM | A local fast path for the commonest questions | Very narrow coverage |
| OpenClaw, Hermes ([docs](https://docs.openclaw.ai/tools)) | No calculator; `code_execution` and `web_search` cover maths and facts | — | A sandbox and a search call for "17 % of 340" |
| LangChain, LlamaIndex | Wikipedia, Wikidata, Wolfram Alpha tools (landscape §2.7, unverified) | Wikipedia as free grounding | Framework dependency |

The pattern to copy is the launcher one: group by intent, make each tool forgiving in what it accepts, return a value
plus a ready-to-speak form.

## 3. Example conversations

1. "Hey Jeff, what's seventeen percent of three hundred forty?" → `calculate({ expression: "17% of 340" })` →
   "Fifty-seven point eight."
2. "How many cups is five hundred millilitres?" → `calculate({ expression: "500 ml to cups" })` → "About two cups,
   two point one to be exact." (US cup; see open question 3.)
3. "Fifty dollars in euros?" → `calculate({ expression: "50 USD to EUR" })` → "About forty-three euros, at Friday's
   rate." (Rate date said because it is not today; number illustrative.)
4. "What time is it in Tokyo?" → `time({ op: "now", place: "Tokyo" })` → "It's ten past eleven at night in Tokyo,
   Tuesday."
5. "How many days until my birthday, the third of March?" → `time({ op: "until", date: "3 March" })` → "One hundred
   and six days, a Tuesday."
6. "Is Monday a holiday?" → `time({ op: "holidays", from: "next monday" })` → "No. The next public holiday is
   Christmas Day, Thursday the twenty-fifth."
7. "When does the sun set tonight?" → `time({ op: "sun", date: "today" })` → "At four thirty-two, about an hour and
   a half from now."
8. "Who was Annie M. G. Schmidt?" → `lookup({ query: "Annie M. G. Schmidt", lang: "nl" })` → two spoken sentences
   from the Dutch Wikipedia summary. On a screen device, a `card` with the photo and "from Wikipedia". **Screen
   optional.**
9. "Roll two dice." → `random({ kind: "dice", count: 2, sides: 6 })` → "A four and a six. Ten."
10. **Ambiguous:** "What's fifteen times fifty?" heard as "fifty times fifty". The tool returns the expression it
    computed; the assistant says "Fifty times fifty is two thousand five hundred" so a mishearing is audible and the
    user can correct it. Rule: always say the operands back for arithmetic.
11. **Failure:** "Convert ten pounds to kilos" with the rates feed down. `pounds` is a mass unit, so it works offline:
    "Four and a half kilos." But "ten pounds to euros" offline: "I can't get exchange rates right now. The last rate I
    have is from Monday: about eleven euros sixty."
12. **Failure:** "How's the server doing?" while the vault is locked → `system_status()` → "Everything runs, but the
    vault is locked, so the Home Assistant module is waiting for you to unlock it in Settings."

## 4. Tools

Risk classes follow the template (safe / changes data / outward-facing or costly); in the vocabulary of
[module-definition-config-and-dependencies.md](../module-investigation/module-definition-config-and-dependencies.md)
§B.5 every tool here is `read`.

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path without LLM |
|---|---|---|---|---|---|---|
| `calculate` | `expression: string` (mathjs syntax plus `%`, `of`, `to`, `in`, currency codes), `precision?: number` | `{ expression, value, unit?, exact: string, spoken: string, rateDate? }` | R | safe | < 5 ms local; +100–300 ms when rates are stale | Yes for "X percent of Y", "X unit to unit" via `ValueParsing` |
| `time` | `op: "now" \| "convert" \| "until" \| "since" \| "add" \| "week" \| "holidays" \| "sun"`, `place?`, `date?`, `time?`, `amount?`, `from?`, `to?` | `{ op, result, iso, spoken, zone }` | R | safe | < 5 ms; +200–600 ms when a place must be geocoded online | Yes for now, week number, sunset in the home place |
| `lookup` | `query: string`, `kind?: "summary" \| "fact" \| "define"`, `property?: string`, `lang?: string` | `{ title, extract (≤ 600 chars), source, url, lang, image? }` | R | safe (outbound read) | 200–800 ms (unverified, measure) | No |
| `random` | `kind: "coin" \| "dice" \| "number" \| "pick"`, `count?`, `sides?`, `min?`, `max?`, `options?: string[]` | `{ values, total?, spoken }` | R | safe | < 1 ms | Yes |
| `system_status` | `about?: "all" \| "modules" \| "internet" \| "devices" \| "server"` | `{ summary, issues: [...] }` | R | safe | < 50 ms; +up to 1.5 s for the internet probe | Yes |

All five are `speculative: true` (current-system.md §2.1), so a speculative turn can run them before commit.

**Why these boundaries.**

- `calculate` absorbs units, percentages, bases, fractions, statistics and currency. Raycast shows one box can do all
  of it, and the model writes good mathjs-style expressions when the description shows six examples.
- `time` replaces today's `current_time` and adds date maths, holidays and sun times. One `op` enum costs fewer
  prompt tokens than six tools, and the model rarely confuses ops within one tool (to verify with an eval set).
- `lookup` covers Wikipedia summaries, Wikidata facts and Wiktionary definitions behind one name, because all three
  are "a grounded short text about a thing".
- Translation and spelling get no tool (§5.6, §5.7).

**Renaming `current_time`.** Assistants store `offTools` by tool name (current-system.md §3.1). Replacing
`current_time` with `time` silently re-enables it for an assistant that had switched it off. Either keep the name
`current_time` for the extended tool (description changes, name stays) or migrate `offTools` in the settings
migration. Keeping the name is cheaper; the `time_now` action stays for the intent path.

## 5. Integrate or build

### 5.1 Calculator

| Option | For | Against |
|---|---|---|
| **[mathjs](https://mathjs.org) in a restricted scope** | Expressions, units (`5 cm to inch`), BigNumber and Fraction, statistics, custom units; pure JS; sub-millisecond | Needs the documented hardening; its unit names are English only |
| `nerdamer` or `algebrite` (CAS) | Solving equations | Rare need; maturity unverified |
| Code execution (`quickjs-emscripten`) | Anything | A sandbox for every sum; slower; separate module (landscape §3.14) |
| Wolfram\|Alpha LLM API | Natural language, science data | Key, cost and terms unverified; hosted |

Recommendation: mathjs. Follow its [security guidance](https://mathjs.org/docs/expressions/security.html): keep a
reference to `evaluate`, then override `import`, `createUnit`, `reviver`, `evaluate`, `parse`, `simplify`,
`derivative` and `resolve` with functions that throw. Add a pre-parse that rewrites `17% of 340`, `340 + 15%` and
`what percent is 12 of 80` into plain expressions, cap input at 300 characters, and evaluate under a 50 ms watchdog
(mathjs suggests a worker for heavy input; a length cap plus refusing `^` exponents over 1e6 is enough on the turn
path).

**Currency.** [Frankfurter](https://frankfurter.dev) needs no key, has no quota beyond abuse rate limiting, blends 112
central banks and official sources, covers 219 currencies, and offers `GET https://api.frankfurter.dev/v2/rates?base=EUR`
plus `/v2/rate/{base}/{quote}`. It has no conversion endpoint, which suits us: fetch all rates against EUR once a day
(and at start), cache them in the module store, and register each ISO code as a mathjs unit at the cached rate, so
`50 USD to EUR` and `3 * 12.50 GBP in EUR` are ordinary unit maths. It can also be self-hosted with Docker. Crypto
through CoinGecko's public API is an option to ship off by default (limits unverified).

### 5.2 Time, dates, holidays, sun

| Need | Library | Notes |
|---|---|---|
| Zones and arithmetic | Effect `DateTime` (already used by `clock`) | DST-correct; `zoneMakeNamed` |
| Place → zone | `geo-tz` (offline polygons) plus the city table `clock` already has; Open-Meteo geocoding (already used by `weather`) for unknown places | `geo-tz` data is tens of MB (unverified size); a city table of the 500 largest cities may be enough |
| Natural dates ("monday in 3 weeks") | `chrono-node` | English is solid; Dutch support exists but is partial (unverified). The model can also normalise to ISO before calling |
| Public holidays | `date-holidays` (offline rules, NL regions included) | Return name in the household language |
| Sunrise, sunset, twilight, moon | `suncalc` | Uses the household location from the Home section |
| Week numbers, workdays | own code on `DateTime` | ISO weeks: the Netherlands uses them ("week 47") |

Recommendation: all offline, inside the existing `clock` module. Add one context-line fact when it is free: "Today is
a public holiday (Koningsdag)" only on such a day, so the cached prefix is untouched (the clock line is per-turn context
already).

### 5.3 Wikipedia, Wikidata, dictionary

- **Summary:** `GET https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}` gives `extract`, `thumbnail`,
  `description`. Search first with the Action API `action=opensearch` or `list=search` to get the title.
- **Facts:** Wikidata `wbsearchentities` to find the item, then `wbgetentities` with a small property map for the
  usual questions (P2048 height, P569 birth date, P1082 population, P36 capital). SPARQL only for joins, later.
- **Definitions:** Wiktionary's REST `page/definition/{word}` (English-centred; Dutch entries are thinner, unverified).
- **Access:** keyless, but Wikimedia requires a User-Agent of the form `<client>/<version> (<contact>) <library>`
  and may block requests without one, and authenticated clients get higher limits
  ([access policy](https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy); numeric limits not on that page).
  The contact must be set by the owner in the module settings; we do not invent one.
- **Language:** the household language edition first (`nl`), then `en`; say which one was used only when it falls
  back.

Recommendation: build a small `knowledge` module with `lookup`, plain `fetch`, a 24-hour cache in the module store.

### 5.4 Random

`node:crypto` `randomInt`. No library. "Pick" takes the options from the utterance ("pick between pizza and
pasta"). Seeded or not does not matter for a household; fairness does (no `Math.random`).

### 5.5 System status

Read what the server already knows: module states and status lines from the `ModuleSnapshot`, vault lock state, the
engine summary (speech engines loaded), connected devices and sessions, disk free (`fs.statfs`), load and memory
(`node:os`), uptime, and an internet probe (`HEAD` to two hosts with a 1.5 s timeout). Later it reads the
[Requirements and health](../module-investigation/module-definition-config-and-dependencies.md) issue registry
(§C.5) instead of assembling its own. A speed test is out of scope for the tool (Ookla's CLI licence is restrictive,
LibreSpeed CLI is an option; unverified).

### 5.6 Translation

Default: no tool. The model translates. The real work is speech: a Dutch voice reading "arigatou gozaimasu" badly.
Instructions should tell the model to give the foreign phrase once, slowly, then a spelled or "sounds like" form. A
`translate` tool backed by LibreTranslate (AGPL sidecar) only makes sense for a weak local model; ship it later and
off by default (landscape §3.9).

### 5.7 Spelling

The model spells common words correctly. A `spell` op is still useful as an exact check for children's homework and
Scrabble disputes: `nspell` with the Hunspell dictionaries `dictionary-en` and `dictionary-nl` answers "is this a
word" offline. Put it under `lookup({ kind: "define" })` returning `{ valid, suggestions }`, not as its own tool.

### 5.8 Where each tool lives

| Tool | Package | Reason |
|---|---|---|
| `calculate` | `modules-builtin` (new `calculator` module, or inside `clock` renamed `essentials`) | Pure JS; currency degrades gracefully offline |
| `time` | `modules-builtin` `clock` (extended) | It already owns time zones and the context line |
| `random` | `modules-builtin` (with `calculate`) | Trivial |
| `system_status` | `modules-builtin`, but needs a small host read API | It must read the snapshot, which modules cannot do today |
| `lookup` | new `module-knowledge` (or `modules-builtin/knowledge.ts`) | Network, User-Agent setting, owner may want it off |
| `translate` | later, separate | Sidecar |

Recommendation: one new module `calculator` (`calculate`, `random`) next to `clock` and `weather`, extend `clock`,
and a separate `knowledge` module. `system_status` waits for a host read API (open question 5).

## 6. Data

| Collection | Scope | Shape | Readers |
|---|---|---|---|
| `rates` | household | `{ base: "EUR", date, fetchedAt, rates: Record<ISO, number> }`, one row | `calculate`; export as a read-only view for a future `shopping` or `travel` module |
| `lookup_cache` | household | `{ key: lang+query+kind, result, fetchedAt }`, 24 h TTL, 500 rows | `lookup` |

Both go in the [Module store](../module-investigation/shared-state-jobs-and-notifications.md) (§4.3–§4.4). Without the
store, a JSON file under `data/modules/<id>/` (module-definition §C.9) or memory with a refetch on start is fine:
nothing here is precious.

## 7. Long-running work and events

- A daily job at 16:30 Europe/Amsterdam refreshes rates (ECB-style rates are published once per working day; other
  Frankfurter providers publish at other times). With the [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md)
  (§6) it is a `recurring` job with missed policy "run once"; without it, a scoped fiber with `Effect.repeat` and
  `Schedule.spaced("6 hours")`, as Home Assistant's refresh does today.
- Events: none emitted. No restart concerns beyond refetching rates.

## 8. Presentation

Using the [Presentation](../module-investigation/presentation-and-device-capabilities.md) catalogue (§3.2):

| Tool | Screen | Without a screen |
|---|---|---|
| `calculate` | `facts`: expression, exact value, rounded value, rate date | The rounded value and operands |
| `time` `now`/`convert` | `facts` with both clocks; for several cities a `table` | One sentence |
| `time` `holidays` | `list` of the next five | The next one, "and three more this year" |
| `time` `sun` | `facts` (sunrise, sunset, day length) | The asked one |
| `lookup` | `card` with thumbnail (through the `/media/` proxy) and "Wikipedia" credit | Two sentences, "according to Wikipedia" |
| `random` | none; the character can do a small dice-roll gesture once `turn.activity` exists | The values |
| `system_status` | `list` of issues | Worst issue first, "and two minor ones" |

The character is not involved beyond the standard Presenter layout. Arithmetic is a good candidate for "say less when
shown": "Fifty-seven point eight" with the working on screen.

## 9. Notifications and proactive behaviour

None by default. Possible later, opt-in: a `low` inbox item "Tomorrow is a public holiday; the bins move to
Saturday" (needs the [Notification service](../module-investigation/shared-state-jobs-and-notifications.md) §8 and a
bin-day module), and a `normal` notice to the owner's devices when `system_status` finds a new error (better done by
the health page itself).

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | location, time zone, language (exist: `HOME_LOCATION`, `HOME_TIME_ZONE`, `HOME_LANGUAGE`); **currency** (new, module-definition §B.1); **units** (metric/imperial; cup = metric 250 ml or US 236.6 ml) | EUR, metric, metric cup |
| Module `calculator` | rates provider URL (Frankfurter public or self-hosted), refresh time, crypto on/off, decimals to speak (2) | public, 16:30, off, 2 |
| Module `clock` | existing `timeZone`, `locale`; holiday country and region (linked to the Home location); 12/24 h speech | NL, 24 h |
| Module `knowledge` | Wikimedia contact for the User-Agent (required), languages in order, extract length | —, `nl,en`, 600 |
| Assistant | on/off per module and per tool (exists); a children's assistant may turn `lookup` off | all on |
| Device | none | — |
| Person | later: preferred units ("my dad wants Fahrenheit") | — |

No secrets, no connections. First run: nothing for `calculator` and `clock`; for `knowledge`, the owner types a
contact (an email or a URL) once.

## 11. Native tools and dependencies

| Dependency | Where | Missing → behaviour and spoken line |
|---|---|---|
| `mathjs`, `date-holidays`, `suncalc`, `chrono-node`, `nspell`, `dictionary-en`, `dictionary-nl` (npm, pure JS) | server | Build-time; cannot be missing at run time |
| `geo-tz` data (npm) | server | Optional; without it, the city table plus geocoding |
| Frankfurter | internet | Last cached rate with its date: "at Monday's rate". No rate ever fetched: "I don't have exchange rates yet." |
| Wikimedia APIs | internet | "I can't reach Wikipedia right now." The model may answer from its own knowledge and must say so |
| Open-Meteo geocoder (for unusual places) | internet | "I don't know where Little Snoring is. Which country?" |

Declared with `requires: [{ network: "internet" }]` for `knowledge` only; `calculator` and `clock` must stay
`running` offline ([Requirements and health](../module-investigation/module-definition-config-and-dependencies.md) §C.3).

## 12. Interaction with the rest of the system

**Speaking numbers and units well.** This is the part worth designing carefully, because the TTS engines (Piper via
sherpa, Cartesia, ElevenLabs) normalise digits differently (unverified per engine; test each).

- Every tool returns `spoken` next to the raw value, built with `Intl.NumberFormat(locale, { maximumSignificantDigits: 3 })`
  and `{ style: "unit", unit: "kilometer", unitDisplay: "long" }`, which yields "5 kilometers" / "5 kilometer" in the
  household locale. The model is told to use `spoken` as is.
- Round to three significant figures by default; give the exact value only when asked or when it is short ("exactly
  2,500"). Never read more than four digits after a separator.
- Dutch uses a decimal comma and a full-stop thousands separator. "3,5" must reach a Dutch voice as "drie komma vijf"
  and never reach an English voice. Spelling numbers into words for the TTS (e.g. `n2words`, which supports Dutch,
  unverified) is the safest route where an engine misreads digits.
- Currency: "twelve euros fifty", not "twelve point five euros". Times: per locale ("kwart over drie" is beyond scope;
  "drie uur vijftien" is fine). Dates: weekday plus day plus month, never "3/3".
- Repeat the operands for arithmetic (example 10), because "fifteen" and "fifty" are a classic recognition confusion.
- Core already parses spoken numbers and durations (`ValueParsing.ts`, `NumberWords.ts`); the inverse belongs in a
  shared `speakable` helper in core so weather, timers and these tools agree.

**Fillers.** Not needed: everything but `lookup` answers in well under 300 ms; `lookup` is under a second and the
model's own lead-in ("Let me check Wikipedia") covers it.

**Agents and assistants.** Every assistant template should include `clock` and `calculator`; `knowledge` for general
assistants. No template of its own. The Claude subscription harness sees them as `mcp__assistant__calculate` etc.
(current-system.md §2.6).

**Intents (Jev).** `time_now` exists as an action; add actions `percent_of`, `convert_units`, `days_until`,
`coin_flip`, `roll_dice` with `examples`, so the typed-intent path answers them without a model once it is wired.

**Tool count.** With `clock`, `calculator`, `knowledge`, `weather` an assistant has 5–6 tools from this area. That
keeps the prompt well under the 10-tool level where Anthropic recommends deferred loading
([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).

## 13. Privacy and safety

- `lookup` sends the query to Wikimedia. Queries about household members' names would leave the house; the
  instructions say not to look up private people.
- `system_status` reveals module names and error text. On a device marked `public` in
  [Device capabilities](../module-investigation/presentation-and-device-capabilities.md) §5.2 (the hallway by the
  front door) it should answer "everything's fine" or "there's a problem, check Settings" without details.
- `random` must be honest; children will test it.
- No confirmation needed anywhere.

## 14. Foundations needed

| Foundation | Needed for | Without it |
|---|---|---|
| none | `calculate`, `time`, `random`, `lookup` | Works today as ordinary module tools |
| [Module store](../module-investigation/shared-state-jobs-and-notifications.md) | rate and lookup caches across restarts | In-memory cache, refetch on start |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | cards and facts on screens | Speech only, as today |
| [Requirements and health](../module-investigation/module-definition-config-and-dependencies.md) | `system_status` reading issues | Assemble status from the snapshot |
| [Tool context](../module-investigation/shared-state-jobs-and-notifications.md) (§4.5) | `system_status` hiding detail on public devices; "here" for sun times per room | Household location for everything |

A useful first version is shippable now: `calculate` with currency, the extended `time`, `random`, `lookup`. That is
the cheapest visible improvement in the whole module list.

## 15. Open questions

1. **One module or three?** `calculator` + extended `clock` + `knowledge` (recommended), or one `essentials` module
   with all five tools? One module is simpler to switch on; three let a children's assistant drop `lookup`.
2. **Keep the name `current_time`** for the extended tool, or rename to `time` and migrate `offTools`?
3. **Which cup and which pound?** Metric cup (250 ml) or US cup by default for a Dutch household following American
   recipes? The landscape document leaves this open.
4. **Spoken number formatting in core or per module?** A shared `speakable` helper in core is recommended, but it
   touches the reply path, which is latency-critical; measure with `TurnTrace` before and after.
5. **A host read API for `system_status`**: may a module read the module snapshot and device list? It is a new
   contribution type, not covered by any foundation document.
6. **Wikimedia contact in the User-Agent**: is the owner willing to put an email or URL there? Without one we risk the
   lowest rate tier.
7. **Crypto prices**: wanted at all? Off by default is proposed.
8. **Disagreement with the landscape document**: §7 there lists `dictionary` and `currency` as possible separate
   modules. This document folds currency into `calculate` and dictionary into `lookup` to keep the tool count at five.
