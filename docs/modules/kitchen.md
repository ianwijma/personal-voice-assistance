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
  sum of its bookings. The sum is also kept on the product's row, written in the same transaction as each booking (both
  or neither), so a read is one row; the nightly job checks it against the ledger and, should they ever differ, sets it
  to the ledger's. Bookings of one product are one at a time (each is one synchronous store transaction). Stock never
  goes below zero: using more than is on record sets it to none and says so. An amount that would take it past what is
  kept (a tonne) is refused whole, never cut to fit.
- **Stock is either known or unknown.** An approximate booking ("about 250 grams", "some of the cheese", a package of
  unknown size) makes the product's stock **unknown** until someone sets it exactly ("there are 150 grams of cheese
  left", "we're out of cheese"). While it is unknown every answer says so and gives the last known amount only as that
  ("I don't know exactly how much cheese there is; last I knew, about 400 grams of cheese"), the overview too, and a
  recipe that needs it hears "may be missing", never "enough". Amounts are read by `@pva/language` (`parseQuantity`,
  English and Dutch: "een ons", "een pond", "twee pakken") and spoken by it (`speakAmount`, `speakList`), so the amount
  is echoed in every answer and a misheard "fifty" is heard at once.
- **Undo is one step.** "Undo that" reverses the asking device's most recent booking, if it was made in the last ten
  minutes and nothing else was booked for that product since; the reversal is then exact by construction, and the
  stock is known or unknown exactly as it was before. Otherwise it refuses and says to set the amount instead. After an
  undo there is nothing more to undo until a new booking. Undoing the booking that made a product (a misheard "a kilo
  of ice") takes the product out again.
- **Product settings.** A minimum to keep, the size of one package (exact, or it is not kept: "about 900 grams" is a
  question), other names ("rijst"), and forgetting a product: its row and names go at once, and all of its bookings in
  steps until none are left (a restart in the middle is finished by the nightly job). A product is made on the fly by
  the first purchase or correction, in grams, millilitres or pieces as the amount said. Singular and plural name one
  product in English and Dutch ("eieren" and "ei", "tomaten" and "tomaat", "uien" and "ui": the common endings and a
  small table of irregular words), for products, aliases and recipe ingredients.
- **Low stock onto the shopping list**, through the `Lists` service: a product below its minimum (or, by default, one
  that ran out) is added with the key `kitchen:product:<id>`, so repeated checks keep one item, and ticked off when its
  stock is back. After each booking the module brings that product's item into line with the product as it is then,
  one call per product at a time (so a slow add never lands after the tick-off of a later restock); when the list is
  off, fails or does not answer within 1.5 s, the answer says the shopping list could not be updated, and never says
  whether an item is or is not on it. The nightly job brings every product's item into line, a bounded number a night,
  carrying on where the last night stopped.
- **Stored recipes, entered by voice**: the model structures what the person dictates (title, servings, total time,
  ingredient lines, steps, the diets it suits) and saves it; ingredient lines are stored whole as said, and read into
  keys and amounts for matching. A save whose lines give more ingredients than a recipe holds (20) is refused, never
  cut. **Allergens are declared from a fixed vocabulary**: see "Allergies" below.
- **`kitchen_what_can_i_make`**: the stored recipes that fit a time limit ("within 15 minutes", compared as given,
  never rounded), the household's and each person's diets and allergies, and what is in the pantry, best first
  (nothing missing, then fewer missing or possibly missing, then fewer dislikes, then quicker), with what is missing,
  what may be missing, and where each recipe came from (the household's own, or the assistant's idea that was saved).
  Requirements are added up per product before they are compared with the stock; one that cannot be compared (cups
  against grams, pieces against grams, packages of an unknown size) is "may be missing", never "enough".

## Allergies

Matching words in ingredient lines can never be made complete (compounds, the other language, cut text), so the rule
is safe by construction rather than clever:

- There is **one fixed vocabulary**: the fourteen major allergens of EU food law (cereals containing gluten,
  crustaceans, eggs, fish, peanuts, soybeans, milk, tree nuts, celery, mustard, sesame, sulphites, lupin, molluscs),
  each with its English and Dutch names and common synonyms, which map **to** it in both directions of language ("ei",
  "eieren", "egg", "eggs" are eggs; "pinda", "peanut", "aardnoot" are peanuts; "amandel", "almond", "walnoot" are tree
  nuts). "Nuts" or "noten" said alone means tree nuts and peanuts both, and "shellfish" both crustaceans and molluscs:
  the stricter reading (`src/allergens.ts`).
- A stored recipe carries its allergens **from that vocabulary** and a flag saying the declaration is complete.
  `kitchen_recipe_save` sets the flag only when the caller states the allergens (its description tells the model to
  ask the person, naming the fourteen, when they did not say; "none" is a valid answer). A word outside the vocabulary
  is a question, and nothing is saved. A recipe saved without a declaration is stored with the flag off, and the
  answer says it will not be suggested to anyone with an allergy.
- For a request where anyone it is for (the household, the people named, everyone, or the device's default person)
  has an allergy, a recipe is suggested **only if** its declaration is complete and contains none of those allergens.
  On top of that, never instead of it, it is left out when any vocabulary name or synonym of those allergens occurs as
  a substring of its title or any of its ingredient lines, read whole. A recipe is never made eligible by matching.
- A person's allergy that maps to nothing in the vocabulary ("kiwi") cannot be checked: for a request that includes
  that person nothing is suggested, and the answer says, in the household's language, that it cannot check for that
  allergy and that a person has to read the recipes' ingredients (naming the allergy only where `Privacy.mayReveal`
  allows it on the asking device).
- Every answer for someone with an allergy ends with one sentence: the suggestions go by the allergens declared when
  the recipes were saved; check the ingredients.

Diets are met only when a recipe declares them ("vegan" satisfies "vegetarian"). A dislike only lowers a recipe.

## Phrases

One phrase command, for what people say with their hands full: that something has run out. It runs the existing action
`stock_out` with no model call, after the wake phrase (docs/PHRASES.md): same parameter (`what`, taken as text and
resolved in the action), same refusals, same sentences, same risk class (`change`). In both languages, exact words:

| Language | Phrases (`{what}` is the product) | Example, and what is said |
|---|---|---|
| English | "we're out of {what}", "we are out of {what}", "we ran out of {what}", "we've run out of {what}", "we have run out of {what}" | "we're out of rice": "Okay, no rice left. Rice is on the shopping list." |
| Dutch | "we hebben geen {what} meer", "de {what} is op", "het {what} is op" | "we hebben geen rijst meer": "Oké, geen rijst meer. Rijst staat op het boodschappenlijstje." |

The household's language decides which set is heard. A near miss is not a phrase and goes to the assistant ("we're
almost out of rice", "the rice is gone", "we hebben geen rijst", "rijst is op"). The slot is read as the tool reads
it, so "rice and milk" is "One thing at a time, please: how much of what?", an unknown product is a question ("There's
no basmati in the pantry."), and the usual fillers at its end ("please") are dropped. A phrase is one invocation: the
same phrase run twice with the identity the gateway gave it (assistant, conversation, turn, device) acts once and
returns its first answer. The identity is claimed before anything runs, so two copies that overlap book once and the
second waits for the first's outcome; a claim that has not finished is never dropped, finished ones are kept, the last
64, in the shared part (not across a restart: a spoken phrase is never retried). Two utterances are two invocations
and act twice. It applies only to a call whose turn came in as a phrase command: the model's tool and a routine run
every time, also twice in one turn.

## On a screen

`stock_low` also puts **a list of what is low or missing on the screen of the device that asked**
(`docs/PRESENTING.md`, a plain `list`, no ticks). It is returned with the answer (`{ say, present }`), never shown from
inside the action: `stock_low` may run before the turn is committed, and the host shows what a speculative call returns
only when the turn is promoted: a discarded turn shows nothing and withdraws nothing.

- **It shows what the answer says, and nothing more**: the products the answer names, in its order (all of them up to
  six; else the first five), then the answer's own "and 25 more" ("and more" when the read was cut) and, for a cut read,
  its line "I read the first 100 of them; there are more." Texts are cut at a character boundary inside the limit. The
  sentence the model says where nothing can be shown is the answer's own (with fewer names when it would pass 300
  characters). The answer and the tool's result are exactly what they were; the host adds its note of what it did with
  the screen on a line after the tool's answer.
- **Privacy**: household data, like the spoken answer; the decision is the Presenter's, at each moment of showing, for
  each device. It is shown on the shared, the private and the public screen alike, as the answer is said on all of them;
  a device with no display shows nothing and nothing else changes. It shows no recipe, so the allergy rules have nothing
  to leave out. An empty answer shows nothing.
- **Transient**: on the screen for the default 30 seconds, and a newer transient one of any module takes the screen.
  An empty answer does not withdraw an earlier list, and a discarded turn withdraws nothing: a list ends by its
  lifetime or is replaced by the next one on that device. Nothing else manages it: it is not updated when the stock changes (the answer was the stock at that moment) and the
  module holds no handle.

## Tools

Typed actions (they run without the model from their examples; the model gets each as the tool `kitchen_<id>`):

| Action / tool | Example | Risk | What it answers |
|---|---|---|---|
| `stock_add` / `kitchen_stock_add` (`what`) | "I bought a kilo of rice", "ik heb een kilo rijst gekocht" | change | "Added 1 kilogram of rice. You now have 1.2 kilograms of rice." |
| `stock_use` / `kitchen_stock_use` (`what`) | "I used 250 grams of rice", "I used some of the cheese" | change | "Okay, 950 grams of rice left." (plus the shopping list line when it went low); after "some" or "about": that the amount is not known now |
| `stock_out` / `kitchen_stock_out` (`what`) | "we're out of rice", "we hebben geen rijst meer" (also a phrase command: see "Phrases") | change | "Okay, no rice left. Rice is on the shopping list." |
| `stock_set` / `kitchen_stock_set` (`what`) | "there is a kilo of rice left" | change | "Okay, you have 1 kilogram of rice." (exact: known again); "about a kilo" is noted and stays not known exactly |
| `stock_query` / `kitchen_stock_query` (`item`, optional) | "how much rice is left", "hoeveel rijst hebben we nog" | read | "You have 950 grams of rice." / not known: "I don't know exactly how much rice there is; last I knew, about …" / with no item: "In the pantry: …" |
| `stock_low` / `kitchen_stock_low` | "what are we running low on" | read | "Running low: rice and milk." (and a plain list on the asking device's screen: see "On a screen") |
| `undo` / `kitchen_undo` | "undo that", "maak dat ongedaan" | change | "Undone. You now have 1 kilogram of rice." / more than ten minutes old, or the product changed since: refused, "tell me how much there is instead" |
| `keep_minimum` / `kitchen_keep_minimum` (`what`) | "always keep two kilos of rice" | change | "Okay, I'll keep at least 2 kilograms of rice in stock." |
| `what_to_make` (not offered as a tool: the model has `kitchen_what_can_i_make`) | "what can I cook within 15 minutes", "wat kan ik maken" | read | "You could make Egg fried rice, short of spring onion." with every note (a cut read, what was left out) and the allergy sentence last |

Tools for the model:

| Tool | Parameters | Risk | Answers |
|---|---|---|---|
| `kitchen_product_set` | `item`, and any of `minimum`, `noMinimum`, `package`, `alias` | change | "Rice: keep at least 2 kilograms and a package holds 1 kilogram." |
| `kitchen_product_forget` | `item` | change | "Rice is no longer in the pantry. The daily backups keep it for up to 14 days." |
| `kitchen_recipe_save` | `title`, `servings`, `minutes`, `ingredients[]`, `steps[]`, `allergens[]?` (from the fourteen, as the person stated them; absent: not declared), `diets[]?`, `source` | change | "Saved Egg fried rice: serves 2, 20 minutes. Not in the pantry yet: soy sauce and spring onion." |
| `kitchen_recipe_list` | none | read | the first 10 titles and how many more |
| `kitchen_recipe_get` | `name` | read | the recipe's lines, steps, servings, time, declared allergens and source; a name a little off is offered ("Did you mean Shakshuka?"), never guessed |
| `kitchen_recipe_forget` | `name` | change | "Forgot the recipe for Shakshuka. The daily backups keep it for up to 14 days." |
| `kitchen_what_can_i_make` | `maxMinutes?`, `people?[]`, `everyone?`, `allowMissing?` (0–3, default 1: missing and possibly missing together) | read | up to five recipes with what is missing, what may be missing and their source; how many were left out (diets and allergies, allergens not declared, being short); what a bound cut; the allergy sentence last |

The module never guesses: an unknown product ("There's no basmati in the pantry. Did you mean rice?"), an amount in
another unit than the product's ("I keep rice in grams; how much is that in grams?"), a package of unknown size, two
things at once, an unknown or ambiguous person ("Which Sam do you mean: Sam Jones and Sam Smith?") are all questions,
and nothing is booked. Every sentence is in English and Dutch (`src/texts.ts`). Bare "add milk" is the shopping list's,
not the pantry's: the module's instructions and `stock_add`'s description say so.

**Whose diets.** It applies the household's diet always, and the diets of the people it is for: those named (by name
or alias), everyone, or (when nobody is named) the person the asking device belongs to. Their parts are taken
together, the strictest reading: the household's and every person's own (`People.dietOf`). When few stored recipes
fit, the model is told what is in the pantry, and the diets to keep to if it offers a dish of its own, which it must
say is its own idea; a saved recipe whose source is the assistant is said to be its idea too.

**Bounds.** One answer reads at most 500 products (20 pages of 25), 100 low products (4 pages of 25) and 100 recipes
(20 pages of 5, in order of time, so "within 15 minutes" stops at the first recipe that takes longer: complete for that
range), and says so whenever a bound cut a read: the overview and the low list then give no count they did not make
("… and more"), a cooking answer says only the first 100 were read and its counts are of those, and an ingredient whose
product lies past the pantry's bound is "may be missing". It checks at most 200 diet words (more is refused: "ask for
fewer people"). The allergy check compares at most the fourteen allergens' names with a recipe's title and at most 20
lines of 80 characters, one recipe at a time, with the event loop free between recipes and between pages of a read:
the worst case (100 recipes of 20 lines against 200 allergy words that all map) held the event loop at most 2.1 ms,
each call 19 ms in all, measured by a 1 ms heartbeat in `recipes.test.ts` ("the worst case keeps the event loop
free", asserted below 10 ms, three times that on CI as the store's latency tests allow).

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
are the core's (`People`, edited in Members) and are read at the moment of answering, never copied. Data version 2
(`storage.version`); version 1's rows are migrated at start: an approximate or uncertain stock becomes unknown, keys
get the Dutch singulars, and a recipe's old allergens are kept where they name the vocabulary but are never a complete
declaration.

| Collection | Scope | `maxChars` (rows per list) | Indexes | Kept |
|---|---|---|---|---|
| `products`: name, key, unit, stock (the sum: while unknown, the last known amount), unknown, low, min, pack, aliases, when the night last folded it and last checked its list item | household | 1,000 (25) | `key`; `[low, key]`; `tidiedAt`; `listedAt` | until forgotten |
| `names`: one row per name or alias of a product | household | 300 (83) | `key`; `product` | with the product |
| `bookings`: the ledger: product, kind, delta, approx, whether the stock was unknown before, the words said, time, device | household | 800 (31) | `[product, at]`; `[device, at]` | `keepDays`, then folded into one `carry` booking per product with their sum |
| `forgotten`: a product forgotten whose bookings are not all removed yet | household | 200 (100) | none | until its bookings are gone |
| `recipes`: title, key, servings, minutes, ingredients (key, amount, unit, optional, packs), allergens (from the vocabulary), declared, diets, source | household | 5,000 (5) | `titleKey`; `minutes` | until forgotten |
| `recipe_texts`: the ingredient lines (whole, as said) and steps, under the recipe's id | household | 14,000 (1) | none (read by id) | with the recipe |

A list reads: the overview reads `products` by `key`, 25 a page; "running low" reads `[low, key]` with `low: true`;
undo reads the device's last booking and its product's last booking, one row each; a product's bookings are read by
`[product, at]`; "what can I make" reads a recipe's text row by id when an allergy is to be checked. Bookings name the
device they were said on (a claimed device id: it only decides which device's change "undo" takes back). `remove`
removes for good; the daily backups keep a row up to 14 days, and forgetting says so.

**Scheduled.** One system job, `tidy`, every day at 03:30 in the household's zone (`30 3 * * *`), kept across restarts
(a start schedules it only when it is not there). Each part is bounded per night and carries on the next night where
it stopped: the products are taken in order of when the job last saw them (`tidiedAt`, `listedAt`), oldest first, so a
prefix of products it keeps skipping can never starve the rest.

- Per product, in one small transaction each (at most 2,000 products a night): fold bookings older than `keepDays` (at
  most 100 per product a night) into one `carry`, compare the product's sum with its ledger and repair it from the
  ledger.
- Remove the bookings of forgotten products in steps (at most 20,000 a night) until none are left.
- Bring the shopping list into line with each product (at most 500 a night, and at most a minute): a low product's
  item is added, a product that is not low has kitchen's item ticked off. When the list is off, busy or slow, the night
  stops asking it, and those products are first the next night.

Idempotent: a run cut short by a restart is run again and finds each product's progress on its row.

## What it needs

- `uses`: nothing; it works without the lists module and says so ("The Lists module is off, so I couldn't update the
  shopping list for rice."). Consumes the `Lists` service (`@pva/module-contracts`, `lists.ts`): `addItem` with a dedupe key
  and `completeByKey`, each call bounded to 1.5 s.
- Core services: `People` (diets, finding a named person), `Privacy` (what may be named on the asking device).
- No network, no outside service, no `requires`, no `health` (nothing outside the process to check), no secrets.
- `fuse.js` for "did you mean" on a miss (a bounded read of names, only when nothing matched).

**Privacy.** The module holds no personal content. What it reveals of a person is their diet: a person's allergy or
diet is applied wherever it is asked for, but named (passed to the model for a dish of its own, with the result
marked `personal` with its owner) only where `Privacy.mayReveal(owner, turn)` allows it now, on the asking device.
Elsewhere the answer says only how many recipes were left out, and tells the model not to invent a dish. An allergy
that cannot be checked is named only where it may be revealed; elsewhere it is "one of the allergies of the people you
asked about". The tests run
this on the shared kitchen display (Sam's: Sam's allergy named, Robin's not), Robin's private phone, the public hall
screen with and without a default person, and a shared screen with nobody.

## What was left out

Added since the first version: the phrase "we're out of …" and the plain low-stock list (above). Still left out:

- **The checklist that can be kept and ticked** (a tick puts the product on the shopping list; a list kept on the
  screen, updated as the stock changes and withdrawn when nothing is low). It waits for three things the host does not
  offer yet: (a) finding or dismissing a presentation by its key after a restart, (b) an id on a press, so a tick can be
  answered once, and (c) a handle for a presentation returned with a result, so an action's list can be updated.

- **Presentations**: the `facts` stock answer, the expiring part of the checklist (there are no expiry dates), the
  "what can I make" `list` with pick, the recipe `card`, the `steps` view (research §8).
- **Notifications**: the expiry check, the daily low-stock inbox line, the thaw reminder (§9).
- **Other phrase commands** and the hands-free cooking window ("next", "back") (§12).

Left for later by the plan's row: URL import, scaling, guided cooking (sessions, step timers through `Timers`), the
meal plan and shopping for it, the Chef template, outside providers (Grocy, Mealie, Tandoor) and their outbox,
barcodes. Also not in this version: locations, best-before and expiry dates, opening a pack, conversions between
volume and weight per ingredient ("a cup of rice in grams", `kitchen_convert`), the cook log, and setting a diet by
voice (Members and `People.setDiet` own diets; the memory module's instructions send "Sam is allergic to nuts" there).
By design, not later: more than one step of undo (after an undo, or past ten minutes, the amount is set instead),
allergens outside the fourteen (an allergy outside them cannot be checked, and nothing is suggested for it), and a
package size that is only approximate.
