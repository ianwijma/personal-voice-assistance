# Calculator (`calculator`)

Arithmetic, units and currency, worked out exactly, and random picks.

- Package: `packages/module-core-tools` (with `knowledge`, `system-status`)
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 3 (wave A)
- Research: [docs/research/modules/core-tools.md](../research/modules/core-tools.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Works out sums exactly, so the model never does arithmetic in its head: plain arithmetic, percentages ("17% of 340",
"340 + 15%", "what percent is 12 of 80"), units ("500 ml to cups", "60 mph to km/h") and currencies ("50 USD to EUR"),
and fair random picks (coins, dice, a number in a range, one of several options). Everything but the currency rates
works offline. It answers with a number the model can say, rounded for the ear ("about 1.97 inches", "4.5 million"), in
English or Dutch (a decimal comma for Dutch households), and says the rate's date when the rate is more than a day old.

**The bound.** `calculate` cannot block the event loop. An expression is at most 200 characters from a fixed alphabet
(letters, digits, spaces and `. , + - * / ^ % ( ) ! _`), nests parentheses at most 12 deep, parses to at most 60 nodes and
40 levels, and then only a whitelist of node kinds is evaluated: real numbers, `pi`, `e`, `tau`, units, the operators
`+ - * / ^ %`, `to` / `in` and the postfix `!`, parentheses, and the functions `sqrt cbrt abs round floor ceil sign min max sin
cos tan asin acos atan log log10 log2 exp`. Each of these is constant-time on a number: a huge exponent is `Infinity`
("too large"), a huge factorial is `Infinity` from 171 on. What mathjs has that grows with its operands (combinations,
gcd, ranges, matrices, big numbers, strings, `evaluate`, `import`, function definitions, assignments, indexing) is
refused by name before anything runs. The test (`test/engine.test.ts`) feeds it 40 hostile inputs (`2^999999999`,
`10^10^10^10`, `factorial(1e9)`, `combinations(1e12, 5e11)`, 5,000 nested parentheses, `1+1+…` a hundred times,
`range(1, 1e9)`, `"a" * 1e9`, …) and fails any that takes 25 ms or more; in practice they take well under a millisecond
once the library is warm (it is warmed at start).

## Tools

| Tool | Parameters | Answers | Risk |
|---|---|---|---|
| `calculate` | `expression` (mathjs syntax, plus `%`, `of`, `to`/`in`, ISO currency codes) | `{ expression, value, unit?, exact, spoken, rateDate? }`; "57.8", "2 cups", "about 1.97 inches", "100 euros, at the rate of Wednesday the eighteenth of November 2026" | read, speculative |
| `random` | `kind` (`coin`, `dice`, `number`, `pick`), `count?`, `sides?`, `min?`, `max?`, `options?` | `{ values, total?, spoken }`; "A four." / "3 and 5. Total 8." / "Heads." / "pasta." | read, speculative |

A refusal is a spoken sentence the person can act on ("I can only do arithmetic, percentages, and unit or currency
conversions.", "I don't have exchange rates yet.", "Give me at least two things to pick from."), in both languages.
`random` uses `node:crypto`'s `randomInt` (never `Math.random`): at most 20 coins or dice, 2 to 1,000 sides, a range of
less than 2^47, at most 50 options.

Typed actions (they run without the language model; not offered to the model a second time): `calculator.calculate`
("what is 17 percent of 340", "bereken 12 keer 15"), `calculator.roll_dice` ("roll two dice", "gooi een dobbelsteen"),
`calculator.flip_coin` ("flip a coin", "kop of munt").

## Settings

| Setting | Default | |
|---|---|---|
| Size of a cup | metric, 250 ml | `metric` or `us` (236.6 ml): what "cup" means in a conversion |
| Fetch exchange rates | on | Off: nothing is ever sent, currencies say "Exchange rates are switched off", and Health shows an info line |

## What it stores

One collection, `rates` (household scope, `maxChars` 10,300, no indexes): one row, id `eur`, `{ date, fetchedAt, table }`,
where `table` is `"USD 1.0813;GBP 0.8731;…"` (units of each currency for one euro; at most 5,000 characters, about 160
fiat currencies). A list of it reads at most 2 rows (`maxListRows`), and only `get` by id is used. It is public data
about money, not about a person: **the module stores and reveals nothing personal**, and keeps no history of what was
calculated. It is replaced, never grown, by the daily job `refresh-rates` (cron `30 16 * * *`, the household's zone,
idempotent, retried) and once at start when the rates are missing or more than 36 hours old.

## What it needs

Optionally the internet: `GET https://api.frankfurter.dev/v2/rates?base=EUR` through `safeFetch` (JSON only, 256 KiB,
5 s), with the owner's API contact in the User-Agent only when one is set. The service also lists crypto currencies;
those are dropped (only ISO fiat codes are kept). An ISO code that mathjs already uses for another unit would be skipped and answer "I don't know the unit"; with this mathjs
version none is (a test installs every code the platform knows and records the skipped list, which is empty). No key, no secret, no other module.

## What was left out

- **Crypto prices** (off by default in the research; needs another service): left out.
- **A self-hosted or other rates provider URL** (the research's setting): left out; one public service, one switch.
- **A rates "Refresh now" button**: `fieldActions` run without a running instance and so without the store; the daily job
  and the start-up refresh cover it.
- **Facts presentations** (a `facts` card with the working on screen): waits for wave B (presentations, P10).
- **Natural-language arithmetic** ("twelve times fifteen" in words): the model writes the expression; this tool takes digits.
  Decimal commas in the expression are read as argument separators, so the model must write a dot.
- Spoken numbers above 10^18 or below 10^-3 are said in "times ten to the power" form.
