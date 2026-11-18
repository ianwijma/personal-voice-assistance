# Kitchen (`kitchen`)

A pantry ledger, stored recipes, and what you can make with what is in the house.

- Package: `packages/module-kitchen`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 7 (wave A)
- Research: [docs/research/modules/kitchen.md](../research/modules/kitchen.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

The first version is the research document's slice 1 plus stored recipes, as the plan's row asks:

- **A pantry ledger.** Every change of stock is one booking (`add`, `use`, `set`, `undo`), and a product's stock is the
  sum of its bookings. The sum is also kept on the product's row, written in the same transaction as each booking, so a
  read is one row; the nightly job checks it against the ledger and, should they ever differ, sets it to the ledger's.
  Stock never goes below zero: using more than is on record sets it to none and says so.
- **Approximate amounts.** "About 250 grams" is booked as approximate, and the stock is then said with "about". "Some
  of the cheese" moves no amount and marks the stock as uncertain until someone says how much is left. Amounts are
  read by `@pva/language` (`parseQuantity`, English and Dutch: "een ons", "een pond", "twee pakken") and spoken by it
  (`speakAmount`), so the amount is echoed in every answer and a misheard "fifty" is heard at once.
- **Undo by a reversing booking.** "Undo that" reverses the asking device's own last booking of the last day; saying
  it again reverses the one before. Undoing the booking that made a product (a misheard "a kilo of ice") takes the
  product out again.
- **Product settings.** A minimum to keep, the size of one package (so "two bags of rice" can be booked), other names
  ("rijst"), and forgetting a product. A product is made on the fly by the first purchase or correction, in grams,
  millilitres or pieces as the amount said.
- **Low stock onto the shopping list**, through the `Lists` service: a product below its minimum (or, by default, one
  that ran out) is added with the key `kitchen:product:<id>`, so repeated checks keep one item, and ticked off when its
  stock is back. The booking stands whatever the list does; the answer says when the list is off, full or does not
  answer within 1.5 s. The nightly job adds low products again, which catches those the list could not take.
- **Stored recipes, entered by voice**: the model structures what the person dictates (title, servings, total time,
  ingredient lines, steps, the allergens it contains and the diets it suits) and saves it; ingredient lines are read
  into keys and amounts for matching.
- **`kitchen_what_can_i_make`**: the stored recipes that fit a time limit ("within 15 minutes"), the household's and
  each person's diets and allergies, and what is in the pantry, best first (nothing missing, then fewer missing, then
  fewer dislikes, then quicker), with what is missing.

## Tools

Typed actions (they run without the model from their examples; the model gets each as the tool `kitchen_<id>`):

| Action / tool | Example | Risk | What it answers |
|---|---|---|---|
| `stock_add` / `kitchen_stock_add` (`what`) | "I bought a kilo of rice", "ik heb een kilo rijst gekocht" | change | "Added 1 kilogram of rice. You now have about 1.2 kilograms of rice." |
| `stock_use` / `kitchen_stock_use` (`what`) | "I used about 250 grams of rice" | change | "Okay, about 950 grams of rice left." (plus the shopping list line when it went low) |
| `stock_out` / `kitchen_stock_out` (`what`) | "we're out of rice", "we hebben geen rijst meer" | change | "Okay, no rice left. Rice is on the shopping list." |
| `stock_set` / `kitchen_stock_set` (`what`) | "there is about a kilo of rice left" | change | "Okay, you have about 1 kilogram of rice." |
| `stock_query` / `kitchen_stock_query` (`item`, optional) | "how much rice is left", "hoeveel rijst hebben we nog" | read | "You have about 950 grams of rice." / with no item: "In the pantry: …" |
| `stock_low` / `kitchen_stock_low` | "what are we running low on" | read | "Running low: rice and milk." |
| `undo` / `kitchen_undo` | "undo that", "maak dat ongedaan" | change | "Undone. You now have 1 kilogram of rice." |
| `keep_minimum` / `kitchen_keep_minimum` (`what`) | "always keep two kilos of rice" | change | "Okay, I'll keep at least 2 kilograms of rice in stock." |
| `what_to_make` (not offered as a tool: the model has `kitchen_what_can_i_make`) | "what can I cook within 15 minutes", "wat kan ik maken" | read | "You could make Egg fried rice, short of spring onion." |

Tools for the model:

| Tool | Parameters | Risk | Answers |
|---|---|---|---|
| `kitchen_product_set` | `item`, and any of `minimum`, `noMinimum`, `package`, `alias` | change | "Rice: keep at least 2 kilograms and a package holds 1 kilogram." |
| `kitchen_product_forget` | `item` | change | "Rice is no longer in the pantry. The daily backups keep it for up to 14 days." |
| `kitchen_recipe_save` | `title`, `servings`, `minutes`, `ingredients[]`, `steps[]`, `allergens[]`, `diets[]?`, `source` | change | "Saved Egg fried rice: serves 2, 20 minutes. Not in the pantry yet: soy sauce and spring onion." |
| `kitchen_recipe_list` | none | read | the first 10 titles and how many more |
| `kitchen_recipe_get` | `name` | read | the recipe's lines, steps, servings and time; a name a little off is offered ("Did you mean Shakshuka?"), never guessed |
| `kitchen_recipe_forget` | `name` | change | "Forgot the recipe for Shakshuka. The daily backups keep it for up to 14 days." |
| `kitchen_what_can_i_make` | `maxMinutes?`, `people?[]`, `everyone?`, `allowMissing?` (0–3, default 1) | read | up to five recipes with what is missing, and how many were left out for diets or for being short |

The module never guesses: an unknown product ("There's no basmati in the pantry. Did you mean rice?"), an amount in
another unit than the product's ("I keep rice in grams; how much is that in grams?"), a package of unknown size, two
things at once, an unknown or ambiguous person ("Which Sam do you mean: Sam Jones and Sam Smith?") are all questions,
and nothing is booked. Every sentence is in English and Dutch (`src/texts.ts`). Bare "add milk" is the shopping list's,
not the pantry's: the module's instructions and `stock_add`'s description say so.

**Diets and allergies (`kitchen_what_can_i_make`).** It applies the household's diet always, and the diets of the
people it is for: those named, everyone, or (when nobody is named) the person the asking device belongs to. Their
parts are taken together, the strictest reading: the household's and every person's own (`People.dietOf`). A recipe
is left out when an allergy is in its declared allergens, its title or an ingredient (by substring, with a table of
related words in both languages: "nuts" also leaves out peanut butter, pesto and nutmeg), and when a diet asked for is
not one it declares ("vegan" satisfies "vegetarian"). A dislike only lowers it. When few stored recipes fit, the
model is told what is in the pantry, and the diets to keep to if it offers a dish of its own, which it must say is its
own idea.

**Bounds.** One answer reads at most 500 products (20 pages of 25) and 100 recipes (20 pages of 5, in order of time, so
"within 15 minutes" stops at the first recipe that takes longer), and says so when it was cut. It checks at most 200
diet words (more is refused: "ask for fewer people"); each recipe is at most 20 ingredients, and each diet word has at
most about 30 related words, so the work per answer is at most 100 × 200 × 30 × 29 substring checks of keys of at most
40 characters, in practice a few milliseconds (the test with 120 recipes and 181 diet words checks it).

## Settings

| Field | Default | What it does |
|---|---|---|
| Low stock to the shopping list (`lowStockToList`) | on | below its minimum, a product goes on the shopping list; ticked off when it is back |
| Also when something runs out (`listWhenOut`) | on | a product with none left goes on the list, also without a minimum |
| A cup is (`cup`) | 250 ml | metric or US cup, for "a cup of milk" |
| Always in the house (`assumed`) | salt, pepper, water, oil, zout, peper, olie | never counted as missing in a recipe |
| Keep pantry history for (`keepDays`) | 90 days (7–730) | bookings older than this are added up into one each night; the stock stays the same |

No secrets, and nothing an assistant overrides.

## What it stores

All of it is **household data** in the household store; the module stores **nothing personal**. Diets and allergies
are the core's (`People`, edited in Members) and are read at the moment of answering, never copied.

| Collection | Scope | `maxChars` (rows per list) | Indexes | Kept |
|---|---|---|---|---|
| `products`: name, key, unit, stock (the sum), approx, uncertain, low, min, pack, aliases | household | 1,000 (25) | `key`; `[low, key]` | until forgotten |
| `names`: one row per name or alias of a product | household | 300 (83) | `key`; `product` | with the product |
| `bookings`: the ledger: product, kind, delta, approx, flags before, the words said, time, device, what it undoes | household | 800 (31) | `at`; `[product, at]`; `[device, at]` | `keepDays`, then folded into one `carry` booking per product with their sum |
| `recipes`: title, key, servings, minutes, ingredients (key, amount, unit, optional, packs), allergens, diets, source | household | 5,000 (5) | `titleKey`; `minutes` | until forgotten |
| `recipe_texts`: the ingredient lines and steps as said, under the recipe's id | household | 14,000 (1) | none (read by id) | with the recipe |

A list reads: the overview reads `products` by `key`, 25 a page; "running low" reads `[low, key]` with `low: true`;
undo reads one page of 16 of the device's bookings, newest first; a product's bookings are read by `[product, at]`.
Bookings name the device they were said on (a claimed device id: it only decides which device's change "undo" takes
back). `remove` removes for good; the daily backups keep a row up to 14 days, and forgetting says so.

**Scheduled.** One system job, `tidy`, every day at 03:30 in the household's zone (`30 3 * * *`), kept across restarts
(a start schedules it only when it is not there). Per product, in one small transaction each: fold bookings older than
`keepDays` (at most 100 per night per product) into one `carry`, compare the product's sum with its ledger and repair
it from the ledger; then remove bookings of products that are gone; then put low products on the shopping list again.
Idempotent; at most 5,000 products and 400 bookings per product per run.

## What it needs

- `uses`: nothing; it works without the lists module and says so ("The Lists module is off, so rice isn't on the
  shopping list."). Consumes the `Lists` service (`@pva/module-contracts`, `lists.ts`): `addItem` with a dedupe key
  and `completeByKey`, each call bounded to 1.5 s.
- Core services: `People` (diets, finding a named person), `Privacy` (what may be named on the asking device).
- No network, no outside service, no `requires`, no `health` (nothing outside the process to check), no secrets.
- `fuse.js` for "did you mean" on a miss (a bounded read of names, only when nothing matched).

**Privacy.** The module holds no personal content. What it reveals of a person is their diet: a person's allergy or
diet is applied wherever it is asked for, but named (passed to the model for a dish of its own, with the result
marked `personal` with its owner) only where `Privacy.mayReveal(owner, turn)` allows it now, on the asking device.
Elsewhere the answer says only how many recipes were left out, and tells the model not to invent a dish. The tests run
this on the shared kitchen display (Sam's: Sam's allergy named, Robin's not), Robin's private phone, the public hall
screen with and without a default person, and a shared screen with nobody.

## What was left out

Waits for wave B (P7, P9, P10 do not exist yet):

- **Presentations**: the `facts` stock answer, the low and expiring `list` checklist with ticks, the "what can I make"
  `list` with pick, the recipe `card`, the `steps` view (research §8).
- **Notifications**: the expiry check, the daily low-stock inbox line, the thaw reminder (§9).
- **Phrase commands** and the hands-free cooking window ("next", "back") (§12).

Left for later by the plan's row: URL import, scaling, guided cooking (sessions, step timers through `Timers`), the
meal plan and shopping for it, the Chef template, outside providers (Grocy, Mealie, Tandoor) and their outbox,
barcodes. Also not in this version: locations, best-before and expiry dates, opening a pack, conversions between
volume and weight per ingredient ("a cup of rice in grams", `kitchen_convert`), the cook log, and setting a diet by
voice (Members and `People.setDiet` own diets; the memory module's instructions send "Sam is allergic to nuts" there).
