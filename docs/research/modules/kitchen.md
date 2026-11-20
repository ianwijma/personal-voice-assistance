# Kitchen (pantry, recipes, meal plan, guided cooking) and the Chef assistant

Research write-up, 2026-11-17. Not an approved design. It builds on the shared foundations named in
[README.md](README.md). Store, scheduler, events and notifications are in
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) ("shared state
§n"). Presentation kinds and device rules are in
[`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md) ("presentation
§n"). Manifest, connections and templates are in
[`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)
("module definition §n"). What exists today is in [`current-system.md`](../module-investigation/current-system.md).
Outside facts were checked on 2026-11-17 against each project's published OpenAPI document or source at the release
named. Anything not checked is marked **[unverified]**.

## 1. Summary

One `kitchen` module covers everything that happens in the kitchen:

- a **pantry** that knows what is in the house, how much, where it is kept and when it expires ("add a kilo of rice to
  the pantry", "I used about 250 grams of rice");
- **recipes**, imported from a URL, dictated, or invented by the model and then saved;
- **"what can I cook"** matching against the stock, with a time limit ("what can I make today with my ingredients
  within 15 minutes?");
- **guided cooking**: one step at a time, "next" without a wake phrase, a timer per step, the steps on a screen;
- a **meal plan**, **consumption booked when a recipe is cooked**, and **low stock to the shopping list**, so the list
  fills itself because the system knows how much rice is left.

It ships a **Chef** assistant template. The shopping list belongs to the [lists](lists.md) module and step timers to
[timers](timers-and-alarms.md); the kitchen module writes to both and does not copy them.

- **Priority: first wave, as the first large module after `timers` and `lists`.** It is at the top of the owner's wish
  list, and recipes are the one domain where LLM assistants clearly raised use (5x recipe requests on Alexa+,
  landscape-voice-assistants §13). It consumes the Module store, `timers` and `lists`, so it cannot come before them.
- **Effort: L overall, shipped in slices.** Slice 1 (M): pantry by voice plus low stock to the shopping list. Slice 2
  (M): recipes with URL import, matching and scaling. Slice 3 (M): guided cooking with `steps` and step timers. Slice 4
  (S): meal plan and shopping for the plan. Each external provider is S–M more. The hard part is not code volume but
  the product catalogue: units, aliases and conversions that make "a kilo of rice" and "250 grams of rice" land on the
  same row.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa (Echo Show), Alexa+ | Recipes with step-by-step on the Show; Alexa+ remembers "family recipes" and dietary needs (landscape-voice-assistants §1) | Dietary memory that every recipe answer respects; steps on screen with voice "next" | Upsells and shopping-for-you; recipe content locked to partners |
| Google / Nest Hub | "Cooking help (recipes, timers, shopping lists)"; step-by-step follow-along was **removed in 2024** (landscape-voice-assistants §2) | — | Removing the feature people used. Owning the module locally avoids this. |
| [Grocy](https://grocy.info/) v4.7.1 (2026-09-04) | Stock per product with stock and purchase units and conversions; `min_stock_amount`; best-before dates, opened state, locations; every change is a logged transaction that can be undone; recipes checked against stock ("fulfillment"); meal plan; chores; barcodes with external lookup | The ledger model (shared state §4.2): purchase / consume / inventory-correction / product-opened, undo by transaction id. Min stock as the shopping-list trigger. | Data entry burden: every product must be defined with units before use, which is what makes people abandon it. Voice must create products on the fly. |
| [Mealie](https://mealie.io/) v3.31.0 (2026-11-13) | URL import (`POST /api/recipes/create/url`), ingredient parser, foods and units, meal plans, shopping lists, and `GET /api/recipes/suggestions` that ranks recipes by missing foods (`maxMissingFoods`, `includeFoodsOnHand`) | The suggestion shape: per recipe `missingFoods`, `substitutedFoods`, `missingTools`. Steps carry `durationSeconds` (in the v3.31.0 source) for timers. | "On hand" is one boolean per food per household (`householdsWithIngredientFood`), not an amount. It cannot know that 250 g of rice is left. |
| [Tandoor](https://docs.tandoor.dev/) 2.7.3 (2026-11-15) | Recipes, meal plan, shopping, cook log; since 2.6.0 a **pantry** with locations (`is_freezer`), amounts and expiry (`/api/inventory-entry/`, `/api/inventory-log/` with `add`/`remove`/`move`), and recipe search `makenow=true` | The cook log (servings, rating, comment) for "what did we have last week". Freezer as a location property. | The 2.6.0 notes say pantry "integrations with shopping/planning and cooking are planned for the future": booking stock when cooking does not exist yet. |
| [KitchenOwl](https://docs.kitchenowl.org/) v0.8.1 (2026-11-08) | Shared shopping list with live updates (Socket.IO), recipes with URL scrape (`/api/household/{id}/recipe/scrape`), meal planner, expenses, a built-in MCP server at `/mcp` | Add by name (`POST /api/shoppinglist/{id}/add-item-by-name`), which is what a voice add needs | No stock at all, so it is a list provider, not a pantry |
| Home Assistant | Shopping list and to-do entities; Mealie's integration exposes its lists as to-do entities (landscape-automation §11) | Typed list surface (see [lists](lists.md)) | No kitchen logic: HA is a transport here, not a model |

**Take-aways:** stock is a ledger of deltas, never a number that gets overwritten; products are creatable by voice
with sensible defaults; matching uses amounts, not "on hand yes/no"; step timers and the shopping list are the
household's ordinary timers and list, so "how long on the rice?" works from any device. No app above does voice-first
consumption ("I used about 250 g"): every one expects a form or a barcode.

## 3. Example conversations

S = a screen helps, and it also works headless. **S!** = needs a screen. "Chef" is the template's suggested wake phrase.

| # | Situation | Exchange | Note |
|---|---|---|---|
| 1 | Purchase | "Hey Chef, add a kilo of rice to the pantry." → "Added a kilo of rice. You now have about 1.2 kilos." | The old 200 g were approximate, so the total is "about". |
| 2 | Consume, fuzzy | "I used about 250 grams of rice." → "Okay, about 950 grams left." | Books `consume 250 g approx` (shared state §4.7). |
| 3 | Matching, S | "What can I make today with my ingredients within 15 minutes?" → "Three of your recipes: egg fried rice, where you have everything; shakshuka, short only a tin of tomatoes; and tuna pasta salad. Shall we do the fried rice?" | Screen: a `list` with what is missing per recipe. |
| 4 | Guided cooking, S | "Yes, for two." → "Egg fried rice for two, six steps. Step one: beat two eggs with a pinch of salt." … "Next." (no wake phrase, §12) → "Step two: heat a tablespoon of oil in a wok…" "How much rice again?" → "300 grams of cooked rice." At "fry for 3 minutes": "Start the timer." → "Rice, three minutes." | `steps` view follows; the timer is pinned in Orbit. |
| 5 | Finish and consume | "Done." → "Enjoy. I've taken 150 grams of rice, two eggs and a spring onion off the pantry. Rice is below your two kilo minimum, so it's on the shopping list." "Undo that." → "Put back: rice, eggs, spring onion." | The undo covers the cooking booking; the list item stays until stock recovers or someone removes it. |
| 6 | Ambiguous product | "I used some of the cheese." → "The cheddar or the parmesan?" → "Parmesan." → "Okay. I've marked the parmesan as uncertain; tell me roughly how much is left when you know." | "Some" moves no amount but flags the stock. |
| 7 | Ambiguous target | "Add milk." → "Milk is on the shopping list." | Bare "add X" means the shopping list, as in HA's `HassShoppingListAddItem`. A pantry booking needs a cue ("I bought milk", "add milk to the pantry", "put milk in the fridge"). Naming the destination makes a wrong guess audible. |
| 8 | Failure, overspend | "I used 500 grams of flour." (200 g on record) → "I only had 200 grams of flour on record, so I've set it to zero and put flour on the shopping list." | Stock never goes silently negative. |
| 9 | Failure, provider down | (Grocy as pantry) "I bought six eggs." → "I can't reach Grocy right now, so the eggs aren't booked yet. I'll book them as soon as it's back." | The booking waits in an outbox (§5). |
| 10 | Invented recipe | "Something with the courgettes before they go off?" → "None of your saved recipes use courgette. An idea of my own: courgette and feta fritters, about 20 minutes, and you have everything. Want it step by step, or shall I save it?" | The tool result marks it as not stored; the model must say so (§13). |
| 11 | Meal plan | "Plan the lasagne for Saturday for six, and put what I need on the shopping list." → "Lasagne on Saturday for six. Added mince, lasagne sheets and ricotta to the list; you have the rest." | `kitchen_plan_set` then `kitchen_shop_for`. |
| 12 | Import, S! | Typed or pasted on the tablet or phone: "save this: https://…" → "Saved 'Chicken tikka masala', serves four, 50 minutes. Two ingredients I couldn't match: garam masala and kasoori methi. Add them as new pantry items?" | URLs are not dictated. |

## 4. Tools

Every write is a typed action (`defineAction`, current-system §2.4), so each becomes a tool `kitchen_<action>` and an
intent for the Jev path; read tools are `speculative: true`. Latency is the module's own work: a few indexed SQLite
statements for the local store (expected well under 20 ms), one or two LAN HTTP calls with Grocy or Mealie (50–300 ms).
These are estimates to be confirmed with `TurnTrace`. Risk classes follow module definition §B.5: *safe* = `read`,
*changes data* = `change`, *outward* = network fetch or cost.

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `kitchen_stock_add` | `item: Param.dynamic` (products + aliases; unknown → new product), `amount?: number`, `unit?: choice`, `approx?: boolean`, `said: text`, `location?: dynamic`, `best_before?: text` | booking id, new total ("about 1.2 kg") | W | changes data | < 20 ms local | yes |
| `kitchen_stock_use` | `item`, `amount?`, `unit?`, `approx?`, `said`, `spoiled?: boolean` | booking id, remaining, `low: boolean` | W | changes data | < 20 ms | yes |
| `kitchen_stock_set` | `item`, `amount?` or `state: "none" \| "some" \| "full-pack"` | correction booking ("we're out of rice") | W | changes data | < 20 ms | yes |
| `kitchen_stock_move` | `item`, `to: dynamic` (fridge, freezer, pantry, cellar), `amount?`, `opened?: boolean` | new location and new best-before (the freezer extends it, opening shortens it) | W | changes data | < 20 ms | yes |
| `kitchen_stock_query` | `item?`, `location?`, `expiring_within_days?: number`, `low_only?: boolean` | per product: amount, approx, soonest best-before, location | R | safe | < 10 ms | yes |
| `kitchen_undo` | `what?: "last" \| booking id` | what was reversed | W | changes data | < 20 ms | yes |
| `kitchen_product_set` | `item`, `min_stock?`, `target_stock?`, `package?: text` ("a 1 kg bag"), `staple?: boolean`, `shelf_life_days?`, `conversion?: text` ("a cup is 185 g") | the product's settings | W | changes data | < 20 ms | yes ("always keep two kilos of rice") |
| `kitchen_what_can_i_make` | `max_minutes?`, `servings?`, `allow_missing?: 0–3`, `use_expiring?: boolean`, `meal?: choice`, `diet?: multichoice` | ranked recipes with `missing[]`, `expiring_used[]`, `minutes`, `source` | R | safe | < 50 ms local over a few hundred recipes | yes (templated top 3) |
| `kitchen_recipe_find` | `query?`, `max_minutes?`, `tags?`, `diet?`, `ingredient?` | recipe summaries | R | safe | < 20 ms; Mealie/Tandoor 100–300 ms | partly |
| `kitchen_recipe_get` | `recipe: dynamic`, `servings?` | scaled ingredients and steps | R | safe | < 20 ms | yes |
| `kitchen_recipe_import` | `url: text`, `servings_hint?` | saved summary plus unmatched ingredient lines | W | outward (fetches a third-party site) | 1–5 s, network-bound | no |
| `kitchen_recipe_save` | `title`, `servings`, `minutes?`, `ingredients: text[]`, `steps: text[]`, `source: "own" \| "assistant"`, `tags?` | saved id plus unmatched lines | W | changes data | < 30 ms | no (the model composes it) |
| `kitchen_cook_start` | `recipe`, `servings?`, `on?: dynamic` (device; default the asking device) | session, step 1 text, step count; shows `steps` | W | changes data | < 20 ms | yes |
| `kitchen_cook_step` | `move: "next" \| "back" \| "repeat" \| "goto" \| "ingredients"`, `n?` | step text, `timer_seconds?` | W (session) | safe | < 10 ms | **yes, must** |
| `kitchen_cook_amount` | `item` | the scaled amount in this session ("300 g cooked rice") | R | safe | < 10 ms | yes |
| `kitchen_cook_finish` | `consume?: boolean` (default from settings), `rating?: 1–5`, `note?` | bookings made, products now low | W | changes data | < 30 ms | yes |
| `kitchen_plan_get` | `from?`, `to?`, `meal?` | plan entries | R | safe | < 10 ms | yes ("what's for dinner?") |
| `kitchen_plan_set` | `date: text` (parsed locally), `meal: choice` (breakfast, lunch, dinner, snack), `recipe?` or `text?`, `servings?` | entry | W | changes data | < 20 ms | yes |
| `kitchen_plan_remove` | `date`, `meal?` | removed entry | W | changes data | < 20 ms | yes |
| `kitchen_shop_for` | `what: "plan" \| "recipe" \| "low"`, `recipe?`, `from?`, `to?`, `servings?` | items added to the shopping list, items already in stock | W | changes data | < 50 ms | yes |
| `kitchen_convert` | `amount`, `from`, `to`, `item?` | the converted amount; needs `item` for volume↔mass | R | safe | < 5 ms | yes |

Twenty-one tools in the cached prefix is a lot (landscape-launchers §4: selection degrades around 30–50 per assistant).
So **Chef** gets all of them and a general assistant a five-tool subset through `offTools`: `stock_add`, `stock_use`,
`stock_query`, `what_can_i_make`, `shop_for`. Plain unit maths ("ten pounds in kilos") stays with `calculate` in
[core-tools](core-tools.md); `kitchen_convert` exists only for conversions that depend on the ingredient ("a cup of rice
in grams").

**Matching.** Candidate recipes are filtered by `max_minutes` against total time (recipes without a time are left out
and counted: "and two without a time"), then by the household's and the device person's diets (an allergy is a hard
filter, a dislike lowers the score). Ingredients are scaled to the servings and compared with stock in base units;
"assumed" items (salt, pepper, water, oil by default), optional and "to taste" ingredients never count as missing. The
score orders by no missing items, then fewer missing, then use of stock expiring within 3 days, then not cooked recently
(cook log), then rating; the top five return with `missing[]`. It is one in-memory pass after two indexed reads. When
fewer than two stored recipes match, the result says so and adds the capped stock list and active diets, and the model
may propose its own dish under the rule in §13.

## 5. Integrate or build

| Option | What it means | For | Against |
|---|---|---|---|
| **A. Own store** | Module-owned SQL tables in the Module store (shared state §4.4, `m_kitchen__*`) | Voice-specific needs fit: `approx` amounts, the words said, undo by actor, products created on the fly. Local-first, no extra service, fast path under 20 ms, matching on amounts. | We write the catalogue, unit conversion, URL import and an admin editor. No phone app for the family to browse recipes. |
| **B. [Grocy](https://grocy.info/) as the pantry provider** | REST, header `GROCY-API-KEY`. `POST /stock/products/{productId}/add` (`amount`, `best_before_date`, `location_id`, `price`) and `/consume` (`amount`, `spoiled`, `recipe_id`); `POST /stock/transactions/{transactionId}/undo`; `GET /stock/products/by-barcode/{barcode}`; `POST /stock/shoppinglist/add-missing-products` (`list_id`); `GET /recipes/fulfillment`, `POST /recipes/{recipeId}/consume`; generic `/objects/{entity}` with `query[]=name~rice`; change detection `GET /system/db-changed-time` (all from the [OpenAPI document](https://raw.githubusercontent.com/grocy/grocy/master/grocy.openapi.json)) | A mature stock model with a web UI, barcode workflows, price history and chores. The household may already run it. | One more PHP service. Exact amounts only, no "about". A product must exist with units first (`POST /objects/products` with `qu_id_stock`/`qu_id_purchase`). No push: poll `db-changed-time`. Recipe time is not a native field as far as the schema shows **[unverified]**; a userfield would hold it. |
| **C. [Mealie](https://mealie.io/documentation/getting-started/api-usage/) for recipes and the plan** | Long-lived tokens from `/user/profile/api-tokens`, sent as `Authorization: Bearer` **[from the FastAPI security scheme, not the docs page]**. `POST /api/recipes/create/url` (`url`, `includeTags`), `GET /api/recipes?search=&queryFilter=`, `GET /api/recipes/{slug}`, `GET /api/recipes/suggestions?foods=&maxMissingFoods=`, `GET/POST /api/households/mealplans` (`date`, `entryType`, `recipeId`), `GET /api/households/mealplans/today`, `POST /api/parser/ingredients`; webhooks and event notifications exist | The best recipe library UI and import, with apps and household sharing. `totalTimeSeconds` and step `durationSeconds` in v3.31.0. | No stock amounts, so amount matching still needs our pantry, joined by a food-link table (Mealie food id ↔ our product). |
| **D. [Tandoor](https://docs.tandoor.dev/) for recipes, plan, optionally pantry** | Token in the `Authorization` header (`Bearer`); 2.7.0 removed `api-token-auth/`, tokens are made in the UI. `POST /api/recipe-from-source/` (`url`), `GET /api/recipe/?query=&makenow=true`, `GET/POST /api/meal-plan/`, `GET/POST /api/inventory-entry/` (`food`, `unit`, `amount`, `expires`, `inventory_location`), `GET /api/inventory-log/`, `POST /api/cook-log/` | A real pantry with expiry since 2.6.0; the strongest food hierarchy (substitutes, children). | The pantry is new and not linked to cooking or shopping yet. Step `time` is an integer **[unit unverified, probably minutes]**. |
| **E. [KitchenOwl](https://docs.kitchenowl.org/latest/reference/API/)** | JWT from `POST /api/auth`, long-lived token from `POST /api/auth/llt`; `POST /api/shoppinglist/{id}/add-item-by-name` (`name`, `description`); recipe scrape; MCP at `/mcp` (`KITCHENOWL_MCP_ENABLED=true`) | A good shared list for the family's phones. | No stock: it belongs in [lists](lists.md) as a list provider. |
| **F. Hybrid** | The module defines three capability interfaces, `Pantry`, `RecipeBook` and `MealPlan`, each with a local provider and optional external ones. Always ours: parsing, matching, guided cooking, scaling, conversions and the voice ledger semantics. | Start local; plug in what the household already runs, one source of truth per part. | Three interfaces to keep honest. A mixed setup needs a food-link table and a mapping UI. |

**Recommendation: F, with the local store as the default and first provider for all three parts.** External providers
in this order: Mealie for recipes and plan (most used, best import), Grocy for the pantry (for households that already
keep stock there), Tandoor for recipes and plan (its pantry only once it books on cooking), KitchenOwl only as a
[lists](lists.md) provider. Rules:

| Rule | Detail |
|---|---|
| One source of truth per part | No two-way stock sync. With Grocy as pantry, our tables keep only the voice extras (`said`, `approx`, actor) keyed by Grocy's transaction id. |
| Outbox | Failed provider writes are replayed in order. Bookings are deltas, so a late replay is still correct (shared state §3). Undo of an outboxed booking removes it. |
| URL import | Fetch on the server, parse JSON-LD `@type: "Recipe"` (also inside `@graph`) per [schema.org/Recipe](https://schema.org/Recipe): `recipeIngredient`, `recipeInstructions` (`HowToStep`, `HowToSection`), `totalTime`/`prepTime`/`cookTime` (ISO 8601), `recipeYield`, `suitableForDiet`; microdata as fallback; `linkedom` 0.18.15. With Mealie as the book, push the result with `POST /api/recipes/create/html-or-json`, so both stores share one import path. |
| Ingredient lines | `parse-ingredient` 3.2.0 (English; mixed numbers, vulgar fractions) plus our Dutch unit words; Mealie's parser or Tandoor's `/api/ingredient-parser/post/` when they are the provider. |
| Food matching | Fuzzy over names and aliases (`fuse.js` 7.5.0, or the wake-phrase matcher). An unmatched line is asked about once, on screen, and remembered as an alias. |
| Step timers in text | "Simmer for 12 minutes" → core's `ValueParsing` gives `timer_seconds`. |

## 6. Data

All tables are module-owned SQL (shared state §4.4) in **household** scope unless stated. Amounts are stored as decimals
in the product's base unit (`g`, `ml` or `piece`), with the words said kept alongside (shared state §4.7).

| Table / collection | Key fields | Notes |
|---|---|---|
| `m_kitchen__products` | `id`, `name`, `aliases[]` (EN and NL, plurals), `base_unit`, `package` (`{ amount, said: "1 kg bag" }`), `conversions[]` (`cup = 185 g`, `tin = 400 g`, `clove = 5 g`), `min_stock`, `target_stock`, `default_location`, `shelf_life_days`, `opened_shelf_life_days`, `freezer_shelf_life_days`, `use_by`, `assumed`, `staple`, `barcodes[]`, `diet_tags[]`, `provider_ref?` | Created by voice with defaults inferred from the unit said ("a kilo" means grams). |
| `m_kitchen__stock_tx` (ledger) | `op_id` (uuid), `product_id`, `kind` (`purchase`, `consume`, `correct`, `open`, `move`, `spoil`), `delta`, `approx`, `said`, `location`, `best_before?`, `recipe_id?`, `session_id?`, `actor` (shared state §4.5), `at`, `undoes?`, `provider_tx?` | Kept forever (a ledger collection, shared state §4.2). |
| `m_kitchen__stock_lots` (cache) | `product_id`, `location`, `amount`, `approx`, `uncertain`, `best_before`, `opened_at?` | Rebuilt from the ledger; consumption is first in, first out. |
| `m_kitchen__recipes` | `id`, `title`, `source` (`imported`, `own`, `assistant`), `source_url?`, `servings`, `minutes_total?`, `minutes_active?`, `tags[]`, `diets[]`, `image?`, `notes`, `rating?`, `provider_ref?` | |
| `m_kitchen__recipe_items` | `recipe_id`, `pos`, `section?`, `text` (original line), `product_id?`, `amount?` (base unit, per base servings), `unit_said?`, `optional`, `to_taste` | Unmatched lines keep `product_id = null`. |
| `m_kitchen__recipe_steps` | `recipe_id`, `pos`, `text`, `timer_seconds?`, `item_refs[]` | |
| `m_kitchen__plan` / `m_kitchen__cook_log` | plan: `date`, `meal`, `recipe_id?` or `text`, `servings`, `cooked_at?`; log: `recipe_id`, `at`, `servings`, `rating?`, `note?` | The log feeds "not cooked recently". |
| `cooking_sessions` (collection, **device** scope) | `recipe_id`, `servings`, `step`, `started_at`, `last_step_at`, `timers[]`, `scaled_items` | One per device; ends at finish or 3 h idle. |
| `kitchen_prefs` (collection, **person** scope, household default row) | `diets[]`, `allergies[]`, `dislikes[]`, `portion_factor` | |
| `m_kitchen__food_links` | `product_id` ↔ `provider`, `remote_food_id` | Only in a mixed setup. |

**Fuzzy quantities**, parsed locally by extending `ValueParsing` with mass, volume and kitchen units, so the intent path
needs no model:

| Said | Booked |
|---|---|
| "about 250 grams" / "a kilo", "een kilo" / "een ons", "een pond" | 250 g `approx` / 1000 g / 100 g, 500 g |
| "a tablespoon", "een eetlepel" / "a teaspoon", "een theelepel" | 15 ml / 5 ml, or grams through the product's conversion |
| "a cup" | the household cup setting (metric 250 ml or US 236.6 ml; core-tools §10) |
| "half the bag" | 0.5 × the product's `package` |
| "a handful", "a bit" | the product's default portion, `approx`; asked once if there is none, then remembered |
| "the rest", "all of it", "we're out of" | a correction to 0 |
| "some", "a few" (no number) | no amount change; the product is marked `uncertain` |
| "two" with no unit | pieces when the base unit is `piece`, otherwise packages |

**Exports** (read-only views, shared state §4.4): `kitchen.stock` (product, amount, approx, soonest best-before),
`kitchen.expiring`, `kitchen.plan.today` (for a briefing module), `kitchen.session` (active session per device, for
ambient facts).

## 7. Long-running work and events

| Job (Scheduler, shared state §6) | When | Does | Missed while down |
|---|---|---|---|
| `expiry-check` | daily, default 16:30 (before dinner), `recurring` | finds lots due within `warnDays`; one `low` notification; emits `kitchen.stock.expiring` | run once at start |
| `low-stock-sweep` | daily, and inside every consume call | re-checks min stock; keeps the shopping list in step | run once |
| `outbox-replay` | every 30 s while the outbox is not empty, with backoff | replays provider writes in order | resumes at start |
| `provider-refresh` | every 60 s (Grocy `db-changed-time`, Mealie/Tandoor list endpoints) | refreshes the cache for matching and the fast path | resumes |
| `session-expire` | 3 h after the last step | ends a forgotten session without consuming | fires at start |

Step timers are **not** kitchen jobs: `kitchen_cook_step` returns `timer_seconds`, and on "start the timer" the kitchen
calls `timers_start` (label "Rice, step 4", `ring_on` = the session's device), so it rings, pauses and lists like every
other timer ([timers](timers-and-alarms.md) §4).

**Publishes:** `kitchen.stock.changed` (each booking, with delta and actor), `kitchen.stock.low` (`product`, `amount`,
`min`, `suggested`), `kitchen.stock.expiring`, `kitchen.recipe.saved`, `kitchen.cooking.started` / `.step` /
`.finished`, `kitchen.plan.changed`. **Listens to:** `timers.finished` with a kitchen label (the step view highlights
the next step and, if the device is idle, "rice is done; next is step five"), and `lists.item.completed` for items the
kitchen added (books one package as an `approx` purchase when `restockOnCheckOff` is on, because "ticked in the shop"
is not "put in the cupboard"). **Restart:** sessions, ledger and outbox are in SQLite; step timers survive through the
scheduler; cooking resumes at the stored step ("We were at step four of the fried rice").

## 8. Presentation

| Moment | Kind (presentation §3.2) | Layout (presentation §4.1) | Lifetime |
|---|---|---|---|
| Stock answer, a few products | `facts` (product → "about 950 g, fridge, best before Fri") | Presenter | glance |
| Expiring or low items, pantry overview | `list` (checklist; a tick books "used up") | Presenter | glance, or task while editing |
| "What can I make" | `list` with `pick: true`, `secondary` = "missing: tinned tomatoes" | Presenter; a tap is a typed turn "the shakshuka" (presentation §4.3) | task |
| Recipe overview | `card` (title, image via `/media/`, minutes, servings, source) plus a `list` of scaled ingredients | Hold-up, then Presenter | task |
| Guided cooking | `steps` with `current` and `timerSeconds` per step | **Companion**: the character perches on the step card's corner, nearly full screen | task, until finish or a new conversation |
| Step timer | `timer` from the timers module | Orbit beside the step card | pinned |
| Week plan / import result | `table` (day × meal; `list` on compact displays) / `card` plus a `list` of unmatched lines with `pick` | Presenter | glance / task |

The step view is server-owned state: "next" on a kitchen node moves the step on the tablet beside it through
`present.update` (presentation §6.3). A **Kitchen display** device setting names the screen that follows a headless
speaker's session, so a node plus a tablet works as one cooking station. The character glances at the highlighted step
when it is read (`stage.content.attention`, presentation §4.2) and at the timer when it rings, and invents no emotion.
**Without a screen:** steps are read one at a time (the count once at the start); "ingredients" reads the scaled list
in groups of four; matching reads the top three with what is missing; long lists offer "shall I put the rest on the
kitchen screen?" (presentation §6.2).

## 9. Notifications and proactive behaviour

| What | Priority (shared state §8.2) | Where | Example |
|---|---|---|---|
| Something expires within `warnDays` | `low` (inbox, badge); spoken only in a briefing or when asked | household | "Milk and the chicken thighs expire tomorrow." |
| Items added to the shopping list for low stock | `low`, batched per day | inbox only | "Added to the shopping list: rice, eggs." |
| Step timer finished while cooking | timers rings (`high`); the kitchen adds the next-step line at `normal` | the session's device | "Rice is done. Next: add the soy sauce." |
| Thaw reminder for tomorrow's plan | `normal`, at a set time the day before, only when a planned recipe needs a frozen item | kitchen devices | "Tomorrow's curry needs the chicken from the freezer." |

Never during quiet hours, never a suggestion to buy something. The thaw reminder is the only unprompted kitchen speech,
and it is off until the owner switches it on.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | units, cup size, parsing language (`HOME_LANGUAGE`), household diets and allergies, "assumed" items | metric, 250 ml, from Home, none, salt/pepper/water/oil |
| Module | providers: `pantry: local \| grocy \| tandoor`, `recipes: local \| mealie \| tandoor \| grocy`, `plan: local \| mealie \| tandoor \| grocy` | all `local` |
| Module | `shoppingList` (a list of the lists module), `addLowStock: auto \| inbox-only \| off` | "Shopping", `auto` |
| Module | `consumeOnCook: auto \| ask \| off`, `restockOnCheckOff: auto \| off` | `auto` (spoken summary and undo), `off` |
| Module | `warnDays`, expiry check time, thaw reminders | 2, 16:30, off |
| Module | `cookingWindow: on \| off`, window timeout | on, 20 min after the last step |
| Module (advanced) | import: allow private addresses, allow LLM extraction when a page has no schema.org data; Open Food Facts lookup and its User-Agent contact | off, off, off |
| Assistant | parts on through `offTools`; `inventRecipes: yes \| when-asked \| never` (overridable) | Chef: all, `yes`; others: the five-tool subset, `when-asked` |
| Device | room (Kitchen), "Kitchen display" link, cooking window allowed here, barcode scanning allowed here | off except devices in the Kitchen room |
| Person | diets, allergies, dislikes, portion factor | household default |
| Connections (module definition §B.4; household-owned, credential in the vault) | `grocy` (URL, API key; test `GET /system/info`), `mealie` (URL, token; test `GET /api/app/about` **[path unverified]**), `tandoor` (URL, token; test `GET /api/recipe/?page_size=1`), `kitchenowl` (URL, `llt` token; used by lists) | none |

**First-run setup:**

1. Admin › Assistants › New › from template **Chef**; assign it to the kitchen device with the suggested phrase "hey
   chef".
2. Pick providers (local by default); linking Grocy or Mealie runs the connection test.
3. The **staples** checklist: about 30 common items (rice, pasta, flour, eggs, milk, onions, tinned tomatoes, …). The
   owner ticks what the house keeps, with a rough amount and a minimum. This replaces a full inventory, which is where
   pantry apps lose people.
4. Optionally paste up to ten favourite recipe URLs and set household allergies and diets.

## 11. Native tools and dependencies

| Dependency | Where | Needed for | When missing, the assistant says |
|---|---|---|---|
| Module store (SQLite) | server | everything local | module `unavailable` (module definition §A.4): "The kitchen isn't set up yet." |
| `linkedom`, `parse-ingredient` (npm, pure JS) | server | URL import, ingredient lines | — (bundled) |
| Internet | server | URL import, Open Food Facts | "I can't reach that website from here." |
| Grocy, Mealie, Tandoor | another box or a container | the chosen provider | Writes: "I can't reach Grocy right now, so the eggs aren't booked yet. I'll book them as soon as it's back." Reads: "I can't reach Mealie, so I'm only using the recipes I had cached." |
| Barcode input (later) | kitchen tablet or phone | scanning products | the scan field is not shown |

**Barcodes, later.** First choice: a cheap USB or Bluetooth HID scanner that types the code into a focused field on the
voice page (no camera permission, no new protocol). Second: the tablet camera with `BarcodeDetector`, which is not
baseline and secure-context-only ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector)), so the
`barcode-detector` 3.2.4 polyfill (ZXing WebAssembly) is needed, plus the `camera` capability and its own consent design
(presentation §5.2). Unknown codes are looked up from the server at Open Food Facts, `GET
https://world.openfoodfacts.org/api/v2/product/{code}.json` **[v2 path from memory; the docs page shows v3.6]**: 15
product reads per minute per IP, a `AppName/Version (contact)` User-Agent requested, data under ODbL
([API docs](https://openfoodfacts.github.io/openfoodfacts-server/api/)). With Grocy as provider, use its `GET
/stock/products/by-barcode/{barcode}` and `/stock/barcodes/external-lookup/{barcode}` instead.

## 12. Interaction with the rest of the system

| Topic | Behaviour |
|---|---|
| Numbers and units | Echoed in every confirmation ("a kilo", "about 950 grams"), so "fifteen" heard as "fifty", or "a kilo of ice" for rice, is caught at once. |
| Product names | A closed set (catalogue plus aliases) matched like wake phrases. An unknown name creates a product only on a purchase; on a consume it asks: "I don't have 'basmati' in the pantry. Is that the rice?" Dutch: "een ons", "een pond", "half pak", "boodschappenlijst" as a list alias. |
| Diets in the prompt | In the per-turn context for Chef (`Diet: vegetarian household; Sam: nut allergy`), not in the cached prompt. |
| Hands-free cooking window | While a session runs on a device, the route gate accepts a short closed set without the wake phrase: "next", "back", "repeat", "again", "start the timer", "how much <item>", "what's next", "done", and Dutch "volgende", "terug", "nog een keer". Matched locally like the ringing window (shared state §8.4), run through `kitchen_cook_step` on the intent path: no model, only TTS latency. Longer speech goes to normal routing, so kitchen chatter is not a command. It closes 20 minutes after the last step or at "done". Every move updates the screen, so a false "next" is visible and "back" undoes it. |
| Fillers | Only URL import is slow; its announce "Fetching the recipe…" plays while the tool runs (current-system §2.2). |
| Assistants | Chef: everything. General assistants: the five-tool subset, so "add rice to the pantry" works from the study. A children's assistant: `stock_query`, `recipe_find` and `cook_*`, no ledger writes. |
| Other modules | [lists](lists.md): `addItem` with `dedupeKey: "kitchen:product:<id>"`, so repeated low-stock checks update one item. [timers](timers-and-alarms.md): step timers. Briefing: `kitchen.plan.today`, `kitchen.expiring`. Home Assistant: an oven or kettle state could feed a step later. Ambient facts: `Cooking: fried rice, step 4/6 (kitchen). Expiring: milk (tomorrow).` |

**Chef template** (module definition §A.1, `templates`):

| Field | Value |
|---|---|
| name, purpose | Chef; "Cooking, recipes, the pantry, groceries and the meal plan." |
| handles (TypeSafe routing) | cooking, recipes, what's in the pantry, what to eat, shopping list, meal plan, kitchen timers |
| modules on | `kitchen` (all tools), `lists`, `timers`, `calculate` |
| suggested phrase, look, voice | "hey chef"; a warm figure such as `blob-buddy` or `flame`; a calm voice (the owner picks) |
| prompt sketch | "You are the household's chef. Be brief: one step per reply while cooking. Always say amounts with units. Use tools for stock and recipes; never guess what is in the pantry. When you suggest a dish that is not a saved recipe, say it is your own idea. Respect the allergies in the context strictly; if unsure whether an ingredient contains an allergen, say so. Offer to save a dish the user liked." |

## 13. Privacy and safety

| Concern | Rule |
|---|---|
| Diets and allergies are health data | Person-scoped; used to filter, never shown on a shared screen ("Sam: nut allergy"); the context line goes to the model only. A guest asking "something for tonight" still gets the household allergy filter. |
| Invented recipes | The result carries `source: "assistant"` and the reply must say "an idea of my own". The model checks ingredients against active allergies and says when it cannot know (stock cubes, sauces). No food-safety advice beyond standard cooking temperatures. Never "eat it anyway" past a `use_by` date (products distinguish `use_by` from `best_before`). |
| Consumption without confirmation | Core confirmation is off (current-system §2.5). Bookings are `change` risk, spoken back, and undoable by the same actor with `kitchen_undo`; admin shows the ledger with an undo per row. |
| URL import is a server-side fetch | Refuse private, loopback and link-local addresses (SSRF) unless allowed; 2 MB and 10 s limits; scripts stripped; HTTP(S) only. |
| Children and guests | Children's assistants cannot change stock; anyone in the house may add to the shopping list. |

## 14. Foundations needed

| Foundation | Used for |
|---|---|
| Module store (with module-owned SQL) | everything; the ledger |
| Tool context | which device's cooking session; the actor on each booking; the person's diets |
| Event bus | `kitchen.stock.low` → lists, `timers.finished` → next step |
| Scheduler | expiry check, outbox, refresh (step timers go through timers) |
| Presentation, Device capabilities | `steps`, `list`, `card`, `facts`, `table`; the Kitchen display link, the room, the camera later |
| Notification service | expiry and low-stock inbox, thaw reminder |
| Module manifest, Connection | `templates` for Chef, `requires` on lists and timers; Grocy, Mealie, Tandoor connections |

**A useful first version without most of them** (slice 1): stock tools on a SQLite file under `data/modules/kitchen/`
(module definition §C.9) with `instructions`, the actor recorded as "voice" until tool context exists, the shopping
list through the [lists](lists.md) local store, no screen and no proactive speech. That already answers "add a kilo of
rice", "I used about 250 grams", "how much rice is left" and "what do we need", and needs no scheduler because the
low-stock check runs inside the consume call. Guided cooking needs tool context, the presentation kinds and a finished
timers module to be good.

## 15. Open questions

1. **Own store first, or Grocy or Mealie first?** Do you already run any of them, and would the family use their phone
   apps? This document recommends the local store first (option F) and **disagrees with
   [landscape-automation §11](../module-investigation/landscape-automation-platforms.md)**, which says to integrate
   Grocy because "rebuilding it is pointless": the voice-specific parts ("about", the words said, undo by actor,
   creating products by voice, a fast path without a network hop) do not exist in Grocy, and we need only a small part
   of it (no prices, batteries, equipment or stores). It agrees with shared state §9.2 that both are viable.
2. **One module or three?** Recommended: one `kitchen` module with parts switched per assistant through `offTools`,
   plus one Chef template. The parts share the product catalogue, the join key for matching, cooking consumption and
   low stock; three modules (`pantry`, `recipes`, `meal-plan`) would need that catalogue as a cross-module export with
   its own migrations. The landscape tables list `kitchen` and `pantry` separately; this document folds them together.
3. **Hands-free "next" while cooking**, without the wake phrase: acceptable, and only on kitchen-room devices?
4. **Consumption on "done":** book automatically with a spoken summary and undo (recommended), or ask first, which adds
   a turn while your hands are full?
5. **Precision:** is "about" good enough, with stock in approximate grams, or do you want packages counted (two bags of
   rice) as Grocy does?
6. **Ticking an item in the shop:** book an approximate purchase of one package, or only remove it from the list?
7. **Model-invented recipes:** offered freely (Chef default), only when asked, or never? Saved automatically when
   cooked?
8. **Barcodes:** a USB or Bluetooth scanner at the tablet, the tablet camera, or not at all?
9. **Language:** are your recipes and products mostly Dutch? `parse-ingredient` is English-only, so a Dutch unit and
   number layer is needed either way.
10. **Meal plan:** household only, or per person (the kids' lunches)? Dinner only, or all meals?
11. **Disagreement with presentation §4.3:** a tick on a pantry checklist should book directly as a tool action without
    a model turn, not become a typed turn. The same question is raised in [lists](lists.md).
