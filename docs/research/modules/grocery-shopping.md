# Grocery shopping (from the shopping list to a supermarket order)

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md):
the store, scheduler, events, notifications and tool context in
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) ("shared state
§n"), presentation and device places in
[`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md) ("presentation
§n"), connections and risk classes in
[`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)
("module definition §n"). Outside facts were checked on 2026-11-18 from repositories, package registries and search
summaries. Anything not confirmed is marked **[unverified]**. The household is assumed to be in the Netherlands, which
is not confirmed; international equivalents are covered in §5.

## 1. Summary

Turning the household shopping list into a supermarket order: match each generic item ("milk", "rice, 1 kg") to a
store product with the household's preferred brand and pack size, look up prices and offers, fill the store's cart,
pick a delivery slot, and, only after an explicit confirmation, place or finalise the order. Staples that the pantry
says are below minimum can be re-ordered as a standing basket.

**Boundaries.** The shopping list itself, its items and its live checklist belong to [lists](lists.md); this module
reads it through the `Lists` service and ticks items off when they are in the cart. Stock, minimum stock and
`staple` flags belong to [kitchen](kitchen.md) (`kitchen_product_set`, the `low-stock-sweep` job, kitchen §7); this
module never books stock. The kitchen may book a purchase when an order is delivered, through its own tools, if the
owner turns that on. Money flows are not tracked here; [finance](finance.md) may be told an order total.

- **Priority: later**, and only for a household that already orders online. Every Dutch supermarket integration is
  unofficial (§5) and can break without notice. Picnic is the exception that makes it worth considering: an active
  Node client and a Home Assistant core integration.
- **Effort: M** for "fill the Picnic cart from the list" with product matching and preferred brands. **L** with slot
  booking, order confirmation, offers, a second store and re-ordering staples. Product matching is the real work,
  not the HTTP calls.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa + Amazon Fresh / Whole Foods | Voice add to the Alexa shopping list, then a cart in the Amazon app; "reorder" of past purchases **[unverified: current flow]** | Cart filled by voice, checkout on the phone | Upselling; voice purchase on by default |
| Google Assistant + Walmart | Walmart voice ordering relaunched on Google Assistant in 2019 with "add to my cart" ([TechCrunch](https://techcrunch.com/2019/04/02/walmart-partners-with-google-on-voice-enabled-grocery-shopping/)); early reports said about 2 % of Alexa owners shopped by voice and most did not repeat it ([GearBrain](https://www.gearbrain.com/walmart-voice-shopping-google-assistant-2633566679.html)) | Learning the household's usual products | Expecting people to buy by voice without seeing the basket |
| [Instacart Developer Platform](https://docs.instacart.com/developer_platform_api) | `POST /idp/v1/products/products_link` creates a shopping-list page from items; the user picks a store and checks out on Instacart; recipe pages too | **Hand off the final step** to the store's own app or site | US and Canada only (inference) |
| Kroger public API | OAuth2 with `cart.basic:write`; `PUT /cart/add` with UPC and quantity; product search per `filter.locationId`; no checkout ([client](https://pypi.org/project/kroger-api/)) | The API stops at the cart on purpose | — |
| Tesco | Had a public grocery API (from 2009), later retired; no official API now ([listing](https://parse.bot/marketplace/07b466cc-ad41-4625-8ee0-b278c24a8c18/tesco-com-api)) **[no official notice found]** | — | Scraped catalogue services |
| Home Assistant [Picnic](https://www.home-assistant.io/integrations/picnic/) | 19 sensors (cart items and total, selected slot, next delivery ETA, last order), a to-do list backed by the cart, action `picnic.add_product` by product id, name or GTIN | Cart as a to-do list; add by GTIN | — |
| Bring!, AnyList | Lists with store sections; Bring has supermarket partner offers **[unverified]** | Store-section sorting | Ads in the list |

**Take-aways:** every serious integration stops at the cart and lets the person check out where they can see the
basket and price. Copy that as the default. Learn preferences from what the person confirms, not from the model's
guess.

## 3. Example conversations

S = a screen helps; works headless. **S!** = needs a screen.

| # | Situation | Exchange | Note |
|---|---|---|---|
| 1 | Fill cart | "Put the shopping list in the Picnic cart." → "Twelve of fourteen items are in the cart, €43.60. Two need a choice: oat milk and bread. Shall I show them?" | Known matches go straight in; new items ask. |
| 2 | Choice, S | Screen shows three oat milks → taps Oatly Barista 1 l → "Oatly Barista from now on?" → "Yes." | Preference stored per item. Headless: "Oatly Barista for €2.79 or Picnic's own for €1.49?" |
| 3 | Price | "How much is the Lavazza coffee at Picnic?" → "€6.99 for 500 grams; it's on offer, two for €11." | Read-only search. |
| 4 | Offers | "Any offers on things we usually buy?" → "Three: the coffee, Arla yoghurt 25 % off, and the dishwasher tablets." | Offers matched against preferred products. |
| 5 | Slot | "When can Picnic deliver?" → "Tomorrow between 17:00 and 18:00, or Thursday morning from 8:20." → "Tomorrow." → "Selected tomorrow 17:00–18:00." | Slot selection is `change`, not `money`. |
| 6 | Order | "Order it." → "Place the Picnic order: 14 items, €48.10 including delivery, tomorrow 17:00–18:00, paid with your saved iDEAL method? Say 'yes, order it'." → "Yes, order it." → "Ordered. Delivery tomorrow between 17:00 and 18:00." | `money`: the full sum, the slot and a distinct phrase; trusted device only (§13). |
| 7 | Default handoff | Without order rights: "Order it." → "The cart is ready, €48.10. Check out in the Picnic app; I've sent a link to your phone." | The default (§15). |
| 8 | Staples | "Reorder the staples." → "Rice, pasta and dishwasher tablets are below your minimum; added to the cart, €9.40." | Reads kitchen low stock. |
| 9 | Ambiguous | "Add cheese to the cart." → "The usual Old Amsterdam 300 g, or something else?" | One preferred product per generic item. |
| 10 | Failure, API change | "Fill the Picnic cart." → "Picnic didn't accept my request; their app may have changed. Your list is unchanged. I've told the owner." | Health goes `degraded`; admin sees the error. |
| 11 | Failure, out of stock | "Two items are sold out: the Arla yoghurt and the oat milk. Want the Picnic brand instead?" | |
| 12 | Kid's device | Child's tablet: "Order sweets." → "I can put sweets on the shopping list for a grown-up to check." | `money` and cart writes are denied on that device. |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `grocery_search` | `query: text`, `store?: dynamic`, `limit?` | products: name, brand, size, price, unit price, offer, id | R | safe (outward: a search on the store's API) | 0.3–1 s | no |
| `grocery_fill_cart` | `store?`, `list?` (default the shopping list), `items?: dynamic[]`, `only_known?: boolean` | added items with product and price; unresolved items with candidates | W | changes data (the store's cart) | 1–4 s for 15 items | yes |
| `grocery_choose` | `item: dynamic`, `product: dynamic` (from candidates), `remember?: boolean` | the item's match, saved as preferred | W | changes data | < 300 ms | yes |
| `grocery_cart` | `store?` | cart lines, total, delivery fee, minimum order shortfall | R | safe | 0.3–1 s | yes |
| `grocery_cart_remove` | `item: dynamic`, `quantity?` | updated cart | W | changes data | 0.3–1 s | yes |
| `grocery_offers` | `store?`, `only_usual?: boolean` | offers on preferred products | R | safe | 0.5–2 s | yes |
| `grocery_slots` | `store?`, `days?` | available slots with fee | R | safe | 0.3–1 s | yes |
| `grocery_slot_select` | `slot: dynamic` | selected slot | W | changes data | 0.3–1 s | no |
| `grocery_order` | `store?` | placed order: id, total, slot | W | **money**, confirm | 1–3 s | **no, never** |
| `grocery_handoff` | `store?` | a deep link or QR to the store's app or site | R | safe | < 50 ms | yes |
| `grocery_staples` | `store?`, `include_low?: boolean` | staples and low-stock products to add | R | safe | < 50 ms | yes |

Latencies are estimates against unofficial APIs, to be confirmed with `TurnTrace`. `grocery_order` is never on the
fast path and never speculative; with the household default `money: deny` (module definition §B.5) it is not in any
registry until the owner allows it for a named device.

## 5. Integrate or build

**Netherlands.**

| Store | Access (checked 2026-11-18) | Verdict |
|---|---|---|
| **Picnic** | Unofficial. npm [`picnic-api`](https://github.com/MRVDH/picnic-api) (MRVDH, MIT, 5.5.0, commits on 2026-11-13): services Auth, Cart, Catalog, Checkout, Delivery, Payment, Recipe, User; `auth.login(email, password)` or an existing `authKey`; 2FA by `auth.generate2FACode("SMS")` and a verify call (method name inconsistent in the README); `catalog.getSearchResults`, `cart.addProductToCart`. Python [`python-picnic-api2`](https://pypi.org/project/python-picnic-api2/) 2.0.1 (2026-08-05) used by HA: `search`, `add_product`, `get_cart`, `get_delivery_slots`, `get_article_by_gtin`, with `Picnic2FARequired`. HA core integration exposes `picnic.add_product` | **First provider.** Two routes: (a) through HA's integration, which keeps the unofficial client out of our repository but only adds products and reads sensors; (b) `picnic-api` directly, inside the adapter package, for search, choices, slots and checkout. Start with (a) for cart fill if HA runs, (b) for the rest. Picnic has deprecated endpoints before, breaking a tool built on this client **[from a search summary]**. |
| **Albert Heijn** | No official API; the mobile API (`api.ah.nl`) is undocumented. The old AppiePy broke in 2021 ([libraries.io](https://libraries.io/pypi/appiepy)). [`appie-go`](https://github.com/gwillem/appie-go) (Go, AGPL-3.0): anonymous token for product and bonus search, browser OAuth with refresh tokens for orders and lists; it edits orders, placing one is **[unverified]**. TypeScript search: [`allerhande-client`](https://remcodewlde.github.io/allerhande-client) | **Search and offers only** (anonymous token), plus "send to the AH app's list" if a maintained path exists. No ordering. |
| **Jumbo** | [`python-jumbo-api`](https://github.com/peternijssen/python-jumbo-api) archived 2023; [SupermarktConnector](https://github.com/bartmachielsen/SupermarktConnector) last pushed 2022 | Skip |
| Plus, Dirk, Crisp, Flink | `plus-wrapper` broken since 2023 ([repo](https://github.com/RinseV/plus-wrapper)); the rest only paid scrapers | Skip |
| **Price comparison** | [Checkjebon](https://github.com/supermarkt/checkjebon) (MIT) publishes daily price data for AH, ALDI, Coop, DekaMarkt, Dirk, Hoogvliet, Jan Linders, Jumbo, Picnic, Plus, SPAR and Vomar as one JSON file **[size and frequency from a third party]** | Optional read-only "where is it cheapest?", fetched once a day |

**Elsewhere:** Instacart IDP (shopping-list page link, handoff only, US/CA); Kroger (cart add, no checkout, US); Tesco,
Ocado, Walmart and Amazon Fresh have no public ordering API that was found **[unverified for Ocado, Walmart, Amazon]**.
The `GroceryStore` interface (search, cart, slots, order, handoff, feature flags like lists §5) fits all of them; only
the capability flags differ.

**Product matching** (ours, in every case):

| Step | Detail |
|---|---|
| 1. Known match | `item → product` table per store, keyed by the list item's normalised name (lists' catalogue name) and size |
| 2. Barcode | If the kitchen has a GTIN for the product (kitchen §6 `barcodes[]`), look it up (`get_article_by_gtin` on Picnic) |
| 3. Search and rank | Store search on the item name; rank by preferred brand, own-brand rule, the size closest to the list quantity or the kitchen `package`, unit price, past purchases. Fuzzy names with `fuse.js` (kitchen §5) |
| 4. Ask | If the top two are close, or nothing was bought before: a `gallery` choice on screen, two options headless. The answer is stored. |
| 5. Quantity | "Rice, 1 kg" with only 500 g packs → 2 packs; said back when it changes the count |

[Open Food Facts](https://openfoodfacts.github.io/openfoodfacts-documentation/docs/Product-Opener/v2) can name brands
and categories from a GTIN (search limited to 10 requests per minute, ODbL data), useful for the kitchen catalogue
more than for orders.

**Recommendation:** build the module and the matching; integrate Picnic first (HA route for cart fill, `picnic-api`
in an adapter for search, slots and order), AH search and offers second, Checkjebon optional. **Default to handoff for
checkout**; enable `grocery_order` only by explicit owner choice.

## 6. Data

| Collection | Scope | Fields |
|---|---|---|
| `grocery_matches` | household | `store`, `itemKey`, `productId`, `name`, `brand`, `size`, `packs`, `lastPrice`, `confirmedBy`, `confirmedAt`, `uses` |
| `grocery_prefs` | household | brand rules ("own brand for basics", "always Oatly"), excluded products, allergies read from kitchen prefs |
| `grocery_carts` | household | per store: lines we added with the list item id (for ticking and undo), cart total, `syncedAt` |
| `grocery_orders` | household | `store`, `remoteId`, `total`, `slot`, `placedBy`, `deviceId`, `confirmationText`, `state` |
| `grocery_price_cache` | household | product → price, offer, fetched at (24 h TTL) |

Exports: `grocery.nextDelivery()` for [briefing](briefing.md) and ambient facts ("Picnic delivers today 17:00–18:00");
`grocery.order.placed` events for kitchen and finance.

## 7. Long-running work and events

| Job | When | Missed while down |
|---|---|---|
| `cart-sync` | after each write and every 15 min while a cart has lines | run once |
| `slot-watch` (opt-in) | every 30 min: tell the person when a wanted slot opens | skip |
| `order-cutoff` | 1 h before the store's change cut-off for an open order: "Anything else for tomorrow's Picnic order?" **[cut-off times per store unverified]** | skip if past |
| `delivery-status` | on the delivery day, via HA sensors or polling every 10 min | run once |
| `offers-refresh` | daily 07:00 | run once |
| `prices-import` (Checkjebon) | daily | run once |

**Events:** `grocery.cart.changed`, `grocery.order.placed`, `grocery.delivery.eta`, `grocery.delivery.done`,
`grocery.provider.status`. **Listens to:** `lists.item.added` (optional "keep the cart in step with the list"),
`kitchen.stock.low` (staples), `home-assistant` Picnic sensor changes.

## 8. Presentation

- **Fill result:** a `list` of cart lines with price, and unresolved items at the top as a `gallery` choice (tap a
  product). The character in the Presenter layout.
- **Order confirmation:** a `confirm` with the total, slot and payment method in large text, beside the spoken
  question; a tap on Yes counts the same as the spoken phrase.
- **Delivery:** a pinned `facts` badge on the day ("Picnic 17:12–17:32").
- **Handoff:** a `handoff` QR and a phone notification with the store's link.
- **Headless:** totals rounded to ten cents, choices limited to two, and the order question always complete.

## 9. Notifications and proactive behaviour

| Case | Priority | Where |
|---|---|---|
| Delivery ETA narrowed or the van is near (HA sensor) | `normal` | kitchen and hallway devices, the orderer's phone |
| Order cut-off soon, with an open order | `low` | orderer's phone and inbox |
| Wanted slot available (opt-in) | `normal` | orderer's phone |
| Provider broken | `low` | admin Health page and owner inbox |

No offer announcements, no "you usually buy X" nudges.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | currency; household risk policy (`money: deny` by default); allergies (from kitchen) | EUR; deny |
| Module | stores and their connections; default store; brand rules; own-brand rule; checkout mode (`handoff` or `order`); confirmation phrase; spend limit per order; sync cart with list | none; Picnic; none; off; handoff; "yes, order it"; €150; off |
| Assistant | module on/off; tool subset | on for the kitchen assistant without `grocery_order` |
| Device | `allowRisky` (trusted device, module definition §B.5) | false |
| Person | may order (adults chosen by the owner); phone for handoff links | owner only |

**Connections:** `picnic` (email, password, country, and the 2FA code flow at setup; the auth key in the vault),
`albert-heijn` (anonymous; later OAuth), the HA connection for the Picnic integration route. **First run:** sign in to
Picnic with the SMS code, fill the cart once from the list and confirm the matches on a screen (about 15 choices,
once), set brand rules, choose handoff or order.

## 11. Native tools and dependencies

None beyond npm (`picnic-api` inside the adapter package only, per the project rule on provider SDKs). When the
provider fails: "Picnic isn't answering the way I expect; it may have changed its app. Your shopping list is
unchanged." When no store is set up: "Online shopping isn't set up; the list is ready for the shop."

## 12. Interaction with the rest of the system

- **Speech:** brand names are poorly recognised ("Oatly", "Old Amsterdam", "Lavazza"); match against `grocery_matches`
  names first, then the store search. Prices as money ("two seventy-nine"). Every order question includes the total
  in full euros and cents.
- **Fast path:** "fill the cart", "what's in the cart", "when's the delivery", "reorder staples" are typed actions.
  "Order it" is a typed action that always goes to core's confirmation, never auto-runs.
- **Fillers:** "Filling the cart…" for anything over 1 s; filling is a short background job with a `progress` view
  for long lists.
- **Assistants:** the kitchen's **Chef** template gets search, cart, offers and staples; ordering stays off.
- **Other modules:** lists (source items, tick when carted, kept until delivered), kitchen (staples, package sizes,
  GTINs, allergies; booking on delivery is the kitchen's choice), finance (order total), briefing (delivery today).

## 13. Privacy and safety

- **Ordering is outward-facing and costly.** `grocery_order` is `money`: denied by default; when allowed, only on
  trusted devices, only for chosen adults, always with the spoken total, slot and payment method, a distinct
  confirmation phrase, and a per-order spend limit. No speculative or model-initiated orders, no "order it" from a
  wake-phrase misfire: a confirmation older than 60 s expires.
- **Unofficial APIs:** account passwords and tokens are in the vault; the store may treat API access as a breach of
  its terms (no statement found from Picnic or AH **[unverified]**), so the owner accepts that risk at setup.
- **Children and guests:** add to the shopping list only (lists), no cart writes.
- **Prompt injection:** product names and descriptions are store data, passed as data.

## 14. Foundations needed

Lists with its `Lists` service, kitchen low stock (for staples), Connection with a 2FA setup flow, risk classes with
confirmation switched on and trusted devices, Tool context with the person, Module store, Scheduler, Notification
service, Presentation (`list`, `gallery`, `confirm`, `handoff`, `facts`), the HA connection.

**A useful first version without most of them:** "put the shopping list in the Picnic cart" through HA's
`picnic.add_product` by name, with matches confirmed on screen and stored in a JSON file, and checkout always in the
Picnic app. No ordering, no slots.

## 15. Open questions

1. **Do you order groceries online, and where?** Picnic, AH, Jumbo, or the shop in person? Without online ordering,
   skip this module and keep the list sorted by store section instead.
2. **Checkout:** always hand off to the store's app (recommended), or allow voice ordering on trusted devices with a
   spend limit?
3. **Unofficial API risk:** are you comfortable using your Picnic account through an unofficial client?
4. **Brand rules:** own brand by default, or the brand you bought last?
5. **Disagreement with [kitchen](kitchen.md) §15 question 6:** kitchen asks whether ticking an item in the shop books
   a purchase. With online orders this document proposes booking on delivery, not when carted, and only when the
   kitchen setting says so.
6. **Disagreement with [lists](lists.md) §5:** lists offers Bring!, KitchenOwl and others as whole-list backends. A
   Picnic cart is not a list backend here (HA exposes it as a to-do list, but it is a cart with prices). Agree that
   the cart stays a separate concept?
