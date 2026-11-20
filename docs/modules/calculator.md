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
"340 + 15%", "what percent is 12 of 80") and units ("500 ml to cups", "60 mph to km/h"), and fair random picks (coins,
dice, a number in a range, one of several options). **It does not convert currencies** in this version: an expression
that names one (an ISO code in either case, "dollars", "euro", a currency sign) is answered "I can't convert currencies
yet." / "Valuta kan ik nog niet omrekenen."

**The value is the computed value.** An integer result is the integer computed, exact to the last digit inside the
range of exact integers (±2^53): `1234567890123 + 1` is `1234567890124`. When an operand, an intermediate result or the
answer is outside that range, or an operand has more than 15 significant digits, the result says `approximate: true`
(and the spoken answer "about …"). A fraction is given to 15 significant digits, the precision of the arithmetic (0.1 + 0.2
is 0.3). **Only the spoken form is rounded** for the ear ("about 1.97 inches", "4.5 million", "about 1.23 trillion"), in
English or Dutch (a decimal comma for Dutch households). A unit's spoken name never names another quantity: in Dutch an
avoirdupois pound is "Engels pond" and an ounce "ounce" (Dutch "pond" is 500 g and "ons" 100 g); mathjs's gallon, pint,
quart and fluid ounce are the US ones and are said so ("US gallon", "Amerikaanse gallon"), its ton is the "short ton".

**The bound.** `calculate` cannot block the event loop. An expression is at most 200 characters from a fixed alphabet
(letters, digits, spaces and `. , + - * / ^ % ( ) ! _`), nests parentheses at most 12 deep, parses to at most 60 nodes and
40 levels, and then only a whitelist of node kinds is evaluated: real numbers, `pi`, `e`, `tau`, units, the operators
`+ - * / ^ %`, `to` / `in` and the postfix `!`, parentheses, and the functions `sqrt cbrt abs round floor ceil sign min max sin
cos tan asin acos atan log log10 log2 exp`. Each of these is constant-time on a number: a huge exponent is `Infinity`
("too large"), a huge factorial is `Infinity` from 171 on. What mathjs has that grows with its operands (combinations,
gcd, ranges, matrices, big numbers, strings, `evaluate`, `import`, function definitions, assignments, indexing) is
refused by name before anything runs. The exactness check evaluates each of the at most 60 subtrees once more. The test
(`test/engine.test.ts`) feeds it 40 hostile inputs (`2^999999999`, `10^10^10^10`, `factorial(1e9)`,
`combinations(1e12, 5e11)`, 5,000 nested parentheses, `1+1+…` a hundred times, `range(1, 1e9)`, `"a" * 1e9`, …) and fails
any that takes 25 ms or more; in practice they take well under a millisecond once the library is warm (it is warmed at
start).

## Tools

| Tool | Parameters | Answers | Risk |
|---|---|---|---|
| `calculate` | `expression` (mathjs syntax, plus `%`, `of`, `to`/`in`) | `{ expression, value, unit?, approximate?, spoken }`; "57.8", "2 cups", "about 1.97 inches" | read, speculative |
| `random` | `kind` (`coin`, `dice`, `number`, `pick`), `count?`, `sides?`, `min?`, `max?`, `options?` | `{ values, total?, spoken }`; "A four." / "3 and 5. Total 8." / "Heads." / "pasta." | read, speculative |

A refusal is a spoken sentence the person can act on ("I can only do arithmetic, percentages and unit conversions.",
"I can't convert currencies yet.", "Give me at least two things to pick from."), in both languages. `random` uses
`node:crypto`'s `randomInt` (never `Math.random`): at most 20 coins or dice, 2 to 1,000 sides, a range of less than 2^47,
at most 50 options.

Typed actions (they run without the language model; not offered to the model a second time): `calculator.calculate`
("what is 17 percent of 340", "bereken 12 keer 15"), `calculator.roll_dice` ("roll two dice", "gooi een dobbelsteen"),
`calculator.flip_coin` ("flip a coin", "kop of munt"). Because no model follows an action, `calculator.calculate` says
the sum back before the answer, so a misheard number is audible: "17 percent of 340 is 57.8." / "17 procent van 340 is
57,8.", "500 millilitres in cups is 2 cups.". A sum longer than 120 characters said is not repeated ("The answer is 26.").

## Settings

| Setting | Default | |
|---|---|---|
| Size of a cup | metric, 250 ml | `metric` or `us` (236.6 ml): what "cup" means in a conversion |

## What it stores

Nothing. No collection, no job, no history of what was calculated. **The module stores and reveals nothing personal.**

## What it needs

Nothing outside the process: **no network** (no `requires`, no `health`), no key, no other module. mathjs is loaded when
the module is first demanded, never at the app's start.

## What was left out

- **Currency conversion** (rates, their job, the stored row and the setting): cut; correct dated, validated rates are a piece of work of their own.
- **Crypto prices** and **a self-hosted or other rates provider URL**: left out with the currencies.
- **Facts presentations** (a `facts` card with the working on screen): waits for wave B (presentations, P10).
- **Natural-language arithmetic** ("twelve times fifteen" in words): the model writes the expression; this tool takes digits.
  Decimal commas in the expression are read as argument separators, so the model must write a dot.
- Spoken numbers above 10^18 or below 10^-3 are said in "times ten to the power" form.
