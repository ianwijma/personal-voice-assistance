# Finance (household money, read-only by default)

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md):
the store, scheduler, events, notifications and tool context in
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) ("shared state
§n"), presentation and device places in
[`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md) ("presentation
§n"), connections and risk classes in
[`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)
("module definition §n"). Outside facts were checked on 2026-11-18. Anything not confirmed is marked **[unverified]**.
The household is assumed to be in the Netherlands, which is not confirmed.

## 1. Summary

The household's money by voice: "how much did we spend on groceries this month", "I paid twelve fifty cash at the
market", "which bills are due this week", "what subscriptions do we pay for", "how much does Sam owe me". The module
answers from a budgeting app the household already runs (Actual Budget, Firefly III or YNAB) and never moves money.
Bank data reaches the module only through that app's own bank sync, not through a bank connection of ours.

**Boundaries.** Plain currency conversion stays with `calculate` in [core-tools](core-tools.md). Bill due dates are
delivered through the Notification service like [calendar](calendar.md) event alarms. The module does not create
[reminders](reminders.md) rows. Grocery orders and their cost belong to [grocery-shopping](grocery-shopping.md). The
kitchen's purchase bookings ([kitchen](kitchen.md) §6) carry no prices, and this module does not add them.

- **Priority: later**, and only if the household already keeps a budget in one of the supported apps. Money by voice
  is rare in every assistant (§2). Its value is quick capture of cash spending and a monthly answer, not a dashboard.
- **Effort: M** for a read-only first provider (Actual Budget) plus cash logging. **L** with three providers, bills
  and subscriptions, shared expenses and the privacy rules on every device. The hard part is the privacy rules,
  not the APIs.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa banking skills | US banks (Capital One and others) offered balance and recent-transaction skills with a spoken PIN **[unverified: current availability]** | A voice PIN as a second factor on shared speakers | Balances spoken in a shared room |
| Google Assistant, Siri | No native budgeting. Siri answers about Apple Card and Apple Cash in Wallet on the phone only **[unverified]** | Personal money only on the personal device | — |
| [Actual Budget](https://actualbudget.org/docs/api/) | Local-first envelope budgeting. The Node client `@actual-app/api` downloads the budget file and runs queries locally (`runQuery` with ActualQL, `getTransactions`, `importTransactions` with rules and dedupe on `imported_id`). Bank sync through Enable Banking or GoCardless in Europe ([bank sync](https://actualbudget.org/docs/advanced/bank-sync/)) | Queries run on a local copy, so no network hop per question. Rules categorise imported rows. | Bank-sync secrets are kept on the Actual server, not end-to-end encrypted ([docs](https://actualbudget.org/docs/advanced/bank-sync/)) |
| [Firefly III](https://docs.firefly-iii.org/) | Self-hosted double-entry finance manager with a REST API under `/api/v1/` (Personal Access Token), insights such as `GET /api/v1/insight/expense/category?start=&end=` ([docs](https://docs.firefly-iii.org/api/insightexpensecategory/)), bills, budgets, and a Data Importer for Enable Banking, SimpleFIN and GoCardless ([providers](https://docs.firefly-iii.org/how-to/data-importer/import/third-party-providers/)). Official HA integration ([HA](https://www.home-assistant.io/integrations/firefly_iii/)) | Insight endpoints already sum by category, so a question is one call | Admin token for HA's integration |
| [YNAB](https://api.ynab.com/) | Hosted; REST at `https://api.ynab.com/v1`, now organised as "plans", Personal Access Token, **200 requests per hour per token**, delta sync with `last_knowledge_of_server`, amounts in milliunits | Delta sync for a cheap cache | Hosted only; rate limit forbids per-question calls |
| [Splitwise](https://dev.splitwise.com/) | Shared expenses: `POST /api/v3.0/create_expense` (`cost`, `description`, `group_id`, `split_equally` or per-user `paid_share`/`owed_share`); balances from `get_groups`/`get_friends` | Balance per person in one sentence | A 200 response can still carry `errors` |
| [IHateMoney](https://ihatemoney.readthedocs.io/en/latest/api.html) | Self-hosted shared bills: `/api/projects/<id>/bills`, `/members`, `/statistics` (balance per member) | Small and self-hostable | — |
| Tricount (bunq) | Popular in NL for shared costs; no official API, only an unofficial Python client ([PyPI](https://pypi.org/project/tricount-api/0.1.1/)) | — | Unofficial clients |
| [Wallos](https://github.com/ellite/wallos) | Self-hosted subscription tracker with a key-authenticated REST API, webhooks and an iCal feed | Subscriptions as their own list with renewal dates | Manual entry only |

**Take-aways:** nobody does household money well by voice, and the reason is privacy on shared devices. Copy the
local-copy query model (Actual) and the delta cache (YNAB). Never speak a balance where others can hear.

## 3. Example conversations

S = a screen helps; it also works headless. **S!** = needs a screen. "P" = only on a `private` device or after the
person is chosen (§13).

| # | Situation | Exchange | Note |
|---|---|---|---|
| 1 | Spending, household | "How much did we spend on groceries this month?" → "€412 on groceries so far in November, €38 less than this time last month." | S: a bar `chart` per week. Household category, allowed on shared devices if the owner allows it (§10). |
| 2 | Cash expense | "I paid twelve fifty cash at the market for vegetables." → "Logged €12.50, cash, Markt, groceries." "Undo." → "Removed." | Fast path: amount, payee and category parsed locally. |
| 3 | Bills | "Which bills are due this week?" → "Two: the energy bill on Thursday and the phone on Saturday." | Amounts are not said on a shared device; "how much?" → "I'll show the amounts on your phone." |
| 4 | Subscriptions, S | "What subscriptions are we paying for?" → "Seven, about €96 a month. The biggest are the gym and Netflix. Shall I show them?" | `table` on screen. |
| 5 | Shared costs | "Add forty euros for the cleaner, split with Sam." → "Add €40 'cleaner', paid by you, split equally with Sam, to Splitwise? Sam will see it." → "Yes." → "Added. Sam now owes you €65." | Outward-facing: Sam is notified by Splitwise, so it is read back and confirmed. |
| 6 | Balance refused | Kitchen speaker: "What's my bank balance?" → "I don't read balances out in the kitchen. I've sent it to your phone." | §13. On Ian's phone page it is answered. |
| 7 | Ambiguous | "How much is left?" → "Left in the groceries budget, or in the current account?" | Budget vs account. |
| 8 | Ambiguous category | "Log twenty euros at the HEMA." → "Under household or gifts?" | Learned per payee after the first answer. |
| 9 | Failure | "How much did we spend on eating out?" (Actual unreachable) → "I can't reach Actual Budget. From the copy I had at 9:10, about €140 this month." | Stale cache with its time. |
| 10 | Bank consent | Unprompted, on Ian's phone: "The ING connection in Actual expires in 7 days. Renew it in Actual's bank sync settings." | PSD2 consent renewal (§5). |

## 4. Tools

Risk classes from module definition §B.5. No tool has the `money` class, because none moves money. Reads that reveal
personal amounts carry a `sensitivity: personal` tag that the Presenter and the speech path enforce (§13).

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `finance_spending` | `category?: dynamic`, `payee?: dynamic`, `period?: text` ("this month", "last week", "since Monday"), `compare?: "previous" \| "average"`, `scope?: "household" \| "mine"` | total, comparison, top payees, weekly series | R | safe (personal) | < 50 ms from cache | yes |
| `finance_log_expense` | `amount: number`, `currency?`, `payee?: text`, `category?: dynamic`, `account?: dynamic` (default the cash account), `date?: text`, `note?` | the booked row | W | changes data | < 30 ms local, then outbox | yes |
| `finance_undo` | — | the last row this actor logged, removed | W | changes data | < 30 ms | yes |
| `finance_bills` | `range?: "week" \| "month"`, `include_paid?: boolean` | bills with due date, payee, amount, paid state | R | safe (personal) | < 20 ms | yes |
| `finance_subscriptions` | `sort?: "cost" \| "renewal"` | recurring payments with monthly cost and next date | R | safe (personal) | < 20 ms | yes |
| `finance_budget` | `category?: dynamic` | budgeted, spent, left for the month | R | safe (personal) | < 20 ms | yes |
| `finance_balance` | `account?: dynamic` | balance, as of time | R | safe (**private devices only**) | < 20 ms | yes |
| `shared_expenses_status` | `with?: dynamic` (person), `group?` | who owes whom | R | safe (personal) | 200–600 ms (Splitwise) | yes |
| `shared_expenses_add` | `amount`, `description`, `with: people[]`, `paid_by?`, `split?: "equal" \| shares` | the expense, new balance | W | outward-facing (others are notified) | 300–800 ms | no (confirmation) |

Latencies are estimates, to be measured with `TurnTrace`. General assistants get `finance_spending`,
`finance_log_expense`, `finance_undo` and `finance_bills`; the rest are for an assistant the owner chooses. There is
no `pay`, `transfer` or `pay_bill` tool, and this document recommends never adding one (§15).

## 5. Integrate or build

**Budgeting providers.**

| Option | For | Against |
|---|---|---|
| **Actual Budget** via [`@actual-app/api`](https://actualbudget.org/docs/api/) 26.11.0 (Node ≥ 22, [npm](https://registry.npmjs.org/@actual-app/api/latest)) | `init({ serverURL, password, dataDir })` then `downloadBudget(syncId, { password })` (the e2e key); queries run on a local SQLite copy, so answers are fast and work while the Actual server is down. `importTransactions` dedupes and runs rules. A budget-scoped API key can replace the server password. Local-first, like this project. | It is a full sync client inside our process (memory, its own SQLite, its own release cycle). Better run in a worker or child process so a crash or a migration does not take the voice path down. |
| **Firefly III** REST | Plain HTTP with a token; insight endpoints sum by category; bills are native; official HA integration | One HTTP call per question (cache needed); heavier server (PHP, database) |
| **YNAB** REST | Many households already use it; EUR budgets possible | Hosted; 200 requests/hour per token forces a cache; subscription cost |
| Own ledger | No extra app | We would become a budgeting app (categories, rules, imports, reconciliation). **Skip.** |

**Bank data (PSD2).** The module never talks to a bank. Bank sync is the budgeting app's job:

- **GoCardless Bank Account Data** (formerly Nordigen) no longer takes new sign-ups. Existing users continue. This is
  reported by [a third-party post](https://dev.to/johnfrandsen/gocardless-bank-account-data-alternatives-what-to-use-when-signups-are-disabled-326d)
  and by Actual's docs ("not accepting new accounts"). GoCardless's own notice was not read **[unverified]**.
- **Enable Banking** has a free restricted mode for private individuals linking their own accounts
  ([terms](https://enablebanking.com/terms), [linked accounts](https://enablebanking.com/docs/api/linked-accounts/)).
  Its Dutch market page lists ING, Rabobank, ABN AMRO (payment accounts only), ASN, SNS and Triodos with app-based SCA
  ([NL](https://enablebanking.com/docs/markets/nl/)). bunq is not listed there **[unverified]**. Consent validity is
  set per bank, typically up to 180 days, and background fetches are limited to about four per day per bank
  ([FAQ](https://enablebanking.com/docs/faq)). Both Actual and Firefly support it.
- **bunq** has its own public API (`api.bunq.com`, an API key bound to the creating IP, per-endpoint rate limits,
  [docs](https://doc.bunq.com/basics/rate-limits)). It is only worth a provider if the household banks with bunq and
  the budgeting app cannot reach it.
- Salt Edge, Tink and Yapily are business-priced and need licences; SimpleFIN covers North America only.

**Shared expenses:** Splitwise first (most used, simple API), IHateMoney as the self-hosted option, Tricount not at
all (no API).

**Recommendation:** a `FinanceProvider` interface (`spending`, `transactions`, `bills`, `budgets`, `accounts`,
`logExpense`) with **Actual Budget first**, Firefly III second, YNAB third. Bank sync stays inside the chosen app.
Splitwise is a separate small `SharedExpenses` provider. Subscriptions come from the provider's scheduled
transactions (Actual schedules, Firefly bills, YNAB scheduled transactions), with Wallos as an optional source.

## 6. Data

Module store collections (shared state §4):

| Collection | Scope | Fields | Read by others |
|---|---|---|---|
| `finance_cache` | household (household budget) or person (personal budget) | categories, payees, accounts (names only), month totals per category, scheduled transactions; `fetchedAt` | no |
| `finance_aliases` | household | `said` → category or payee id ("boodschappen", "the market" → Markt) | no |
| `finance_outbox` | person | cash expenses not yet written to the provider: `{ opId, amount, payee, category, date, actor }` | no |
| `finance_journal` | conversation | last rows logged, for `finance_undo` | no |
| `finance_bill_alerts` | person | which bill occurrences were announced (dedupe `billId@date`) | no |

Amounts are stored as integer cents. Exports: `finance.billsDue(person, range)` for [briefing](briefing.md), returning
only payee and date, never amounts. No ambient line by default: a line such as "€412 groceries" in every turn's
context would leak into answers on shared devices.

## 7. Long-running work and events

| Job (Scheduler) | When | Does | Missed while down |
|---|---|---|---|
| `cache-refresh` | every 60 min, and after each write | Actual: `sync()`; YNAB: delta request; Firefly: insights for this and last month | run once at start |
| `outbox-replay` | every 60 s while not empty | writes cash expenses with an `imported_id` so a replay cannot duplicate | resumes |
| `bill-check` | daily 09:00 | bills due tomorrow and today, one `low` notification per bill | run once |
| `consent-check` | daily | bank consents (from the provider's account status) expiring within 7 days | run once |
| `month-summary` (opt-in) | first day of the month, 09:00 | last month by category | skipped if more than a day late |

**Events:** `finance.expense.logged`, `finance.bill.due`, `finance.consent.expiring`, `finance.provider.status`.
**Listens to:** nothing in the first version. A later [grocery-shopping](grocery-shopping.md) order could emit
`grocery.order.placed` with a total that this module offers to categorise; it must not book it on its own, because the
bank sync will import the same payment.

## 8. Presentation

- **Spending:** a `chart` (bars per week or per category) in the Presenter layout, with the total as the spoken line.
- **Bills and subscriptions:** a `table` (payee, date, amount); only on a `private` device, or as a `handoff` QR to the
  phone on shared screens.
- **Logged expense:** a small `card` ("€12.50 · Markt · groceries · cash") with an Undo button for 10 s.
- **Character:** no special choreography; the Presenter layout. No celebratory or scolding reactions to spending.
- **Headless:** one sentence with one rounded number ("about four hundred and ten euros"); lists capped at three.

## 9. Notifications and proactive behaviour

| Case | Priority | Where | Quiet hours |
|---|---|---|---|
| Bill due tomorrow | `low` | the person's phone and inbox; payee only on shared screens | inbox |
| Bank consent expiring in 7 days | `normal` | the owner's phone | held |
| Provider unreachable for 24 h | `low` | admin Health page and owner inbox | — |
| Monthly summary (opt-in) | `low` | the person's private devices only | — |

Nothing else is said unprompted: no spending warnings and no "you spent a lot on takeaway".

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | currency (core-tools §10); which budget is the household budget; whether household spending totals may be spoken on `shared` devices | EUR; none; no |
| Module | provider (Actual, Firefly, YNAB); cache refresh interval; cash account; bill alert time; month summary on/off; Splitwise group per household | none; 60 min; "Cash"; 09:00; off |
| Assistant | module on/off; tool subset | off for every assistant until the owner switches it on |
| Device | inherits the device's `privacy` (private, shared, public) from presentation §5; nothing finance-specific | — |
| Person | own budget connection (YNAB token or Actual budget), Splitwise account, which personal tools may answer on which of their devices | none |

**Connections:** `actual` (server URL, server password or budget API key, sync id, optional e2e password), `firefly`
(URL and Personal Access Token), `ynab` (Personal Access Token), `splitwise` (OAuth or API key). All in the vault,
owned by the household or a person (module definition §B.4). **First run:** pick the provider, enter the connection,
choose the household budget and the cash account, map ten common spoken category words (Dutch and English), and
choose which devices count as private.

## 11. Native tools and dependencies

| Need | Where | When missing |
|---|---|---|
| `@actual-app/api` (npm, Node ≥ 22) and a writable `dataDir` | server, preferably a worker process | "Finance isn't set up: Actual Budget isn't connected." |
| A running Actual, Firefly III or YNAB account | LAN or internet | the module is `unavailable` with the reason; cached answers carry their time |
| Splitwise or IHateMoney | internet or LAN | shared-expense tools are left out; "Shared costs aren't set up." |

No binaries. The Actual client keeps a decrypted copy of the budget on the server's disk, so the data directory falls
under the server's backup and disk-encryption rules.

## 12. Interaction with the rest of the system

- **Speech:** amounts as money ("twelve euros fifty"; Dutch "twaalf euro vijftig", "twaalf vijftig"); "a tenner",
  "een tientje" as €10. Category words in both languages through `finance_aliases`. Speech recognition errors on
  numbers are costly, so every logged amount is echoed back in full.
- **Fast path (Jev):** "I paid X at Y", "how much did we spend on X this month" and "undo" are typed actions.
- **Fillers:** none needed for cached reads. Splitwise writes say "Adding it to Splitwise…" if longer than 1 s.
- **Assistants:** no template. The module is off by default and switched on per assistant.
- **Other modules:** [briefing](briefing.md) reads `finance.billsDue` (payees only); [core-tools](core-tools.md) does
  currency; [grocery-shopping](grocery-shopping.md) may offer an order total (§7).
- **Untrusted text:** payee names and memos come from banks and shops and go to the model as data, never as
  instructions (a memo reading "ignore previous instructions" stays a memo).

## 13. Privacy and safety

- **Read-only by default.** The only writes are the household's own cash rows and, with confirmation, Splitwise
  entries. Payments and transfers are out of scope; the `money` risk class stays `deny`.
- **Balances and personal amounts** are spoken only on `private` devices or on a screen after the person is chosen
  (shared state §4.6). On `shared` and `public` devices the tool returns a refusal that sends the answer to the
  person's phone. Voice identity, when it exists, may select the person but never unlocks balances (shared state
  §4.6).
- **Household totals** on shared devices only when the owner switches that on (§10).
- **Guests and children** get nothing from this module; the tools are not in their registry.
- **Logs:** transcripts containing amounts follow the normal transcript retention; the module itself stores no
  transaction copies beyond the provider's cache.

## 14. Foundations needed

Tool context with the person and device privacy, `Person` records, Connection (vault), Module store, Scheduler,
Notification service (phone channel), Presentation (`chart`, `table`, `card`, `handoff`), Device capabilities with
`privacy`, risk classes with confirmation switched on for `shared_expenses_add`.

**A useful first version without most of them:** Actual Budget only, read-only spending and budget questions plus
cash logging, the module switched on only for an assistant assigned to the owner's private device. That needs the
Actual connection fields as module settings (today's pattern) and a JSON outbox. No scheduler, no notifications.

## 15. Open questions

1. **Do you keep a budget already?** Which app (Actual, Firefly III, YNAB, a bank app only)? Without one, this module
   should wait.
2. **Bank sync:** with GoCardless closed to new users, is Enable Banking in Actual or Firefly acceptable to you,
   including its 180-day consent renewals and the bank-sync secrets stored on that server?
3. **Shared devices:** may household totals ("we spent €412 on groceries") be spoken in the kitchen, or only on
   private devices?
4. **Housemates:** Splitwise, IHateMoney, Tricount (no API) or nothing?
5. **Never pay:** agree that no tool ever moves money, even with confirmation?
6. **Disagreement with [reminders](reminders.md) §12:** it says a task with a moment is a reminder. Bill due dates
   are owned here and delivered as notifications, like calendar event alarms, because they change when the provider
   changes them. Agree?
7. **Disagreement with module definition §B.5:** it lists `money` as "purchases, bookings". This module would like a
   separate sensitivity tag (`personal`) for reads, because a balance read is harmless to the world but harmful to
   privacy, and risk classes only cover effects.
