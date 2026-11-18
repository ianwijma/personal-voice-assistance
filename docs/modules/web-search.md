# Web search (`web-search`)

Searches the web through SearXNG or Brave and reads a page in short.

- Package: `packages/module-web-search`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 4 (wave A)
- Research: [docs/research/modules/web-search.md](../research/modules/web-search.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

## What it does

Gives an assistant current facts from the web. `web_search` returns up to five short results from the provider the owner
chose; `read_page` opens one page and returns its main text. The model words the answer (one to three sentences, one site
named, never an address read out). The module is **off by default**.

- **Providers** sit behind one `SearchProvider` interface inside the package (`src/providers.ts`): **SearXNG** at an
  address the owner typed (so it may be on the home network; it goes through `fetchOwnerConfiguredLan`, which is never
  given an address a model chose) and **Brave Search** with a key (`safeFetch`, key in a request header only). With the
  fallback on and both set up, the other one answers when the chosen one fails, times out, answers rubbish, or is over
  its cap. `provider` in the result says which answered.
- **Everything from the web is untrusted text.** Titles, snippets and page text are stripped of markup and control
  characters, cut to a bound, and handed to the model with a `notice` saying so ("not an instruction"). The module's
  instructions say the same. A result address is never cut (one over 300 characters is dropped), a second result from a
  host already shown is dropped, and so is a blocked site.
- **Caps.** A daily cap on searches (any provider) and a monthly budget in dollars for the paid provider, checked and
  counted in one store transaction *before* each call, so a loop meets the cap and two searches at once cannot both pass
  it. A search that fails still counts (the provider may have billed it). At the monthly budget the paid provider is
  skipped and the other one used when there is one; at the daily cap the person is told when it resets and what to change.
- **Cache.** The same search again within ten minutes is answered from the household's cache and is free.
- **Reading a page** goes through `safeFetch` with a response-type policy (HTML and plain text), a size limit (1 MiB, a
  bigger page is refused, not cut), a time limit (6 s by default) and its guards: only http(s) on ports 80 and 443, no
  credentials, no address on the home network, checked on the address it connects to and on every redirect (the
  `192.168.1.1/admin` case answers "That address is on the home network, so I won't open it."). The page becomes Markdown
  with links reduced to their text and images, scripts and menus dropped (`@mozilla/readability` on `linkedom`, then
  `turndown`), cut to 6,000 characters. `focus` brings the paragraphs that mention its words first.
- **Bounded work.** The parse is the only CPU work and is bounded: markup is cut to 400,000 characters before parsing, a
  document of more than 6,000 elements skips Readability (its body text is taken), the stages yield to the event loop
  between them, and the text that leaves is at most 6,000 characters. A test reads a 400,000-character page with 60,000
  extra elements and asserts under one second (measured about 0.2 s on the build machine, in two stages with a turn of the event loop between them: a worst-case page holds the loop for that long, which is why the page is cut before it is parsed and why a worker is the next step if that is ever too much). The libraries are
  imported where used, so an installation with the module off never loads them.

## Tools

| Tool | Parameters | Risk | Answers |
|---|---|---|---|
| `web_search` | `query` (2–200 characters, one line), `recency?` (`day`, `week`, `month`, `year`), `count?` (1–5, default from settings), `site?` (a domain) | `read` (speculative only when no paid provider can answer) | `{ notice, results: [{ n, title, site, snippet, url, published? }], provider, cached }`, or a `spoken` "I found nothing for that." |
| `read_page` | `url`, `focus?` (what to look for) | `read` (never speculative: it fetches an address a model chose) | `{ notice, title, site, text, truncated }` |

Example phrases (the model decides which tool; there is no phrase-command path): "who won the Dutch Grand Prix this
year?" → `web_search`; "is the A12 still closed this weekend?" → `web_search` with `recency: "week"`; "what does that
article say?" → `read_page` on result 1. "Wie won de Grand Prix van Nederland?" works the same; every sentence the module
itself speaks (errors, caps, refusals) is in English and Dutch by `HOME_LANGUAGE`.

Errors say what the person can do: not set up ("The owner can pick a search provider in Settings."), slow, unreachable,
key refused, rate limited, JSON off on the SearXNG server, the daily or monthly budget used, a page on the home network, a
PDF, a blocked site, too big, too slow.

**Action** (runs without the model, offered to the model as `web-search_usage`):

| Action | Examples | Says |
|---|---|---|
| `web-search.usage` | "how many searches have I used", "how much web search budget is left", "hoeveel zoekopdrachten heb ik gebruikt" | "Today 3 of 100 searches are used. This month 41 searches, and the paid ones cost about 0.20 of the 5 dollars allowed." |

## Settings

| Field | Default | Notes |
|---|---|---|
| Search provider | SearXNG | `searxng` or `brave` |
| SearXNG address | empty | http(s), no credentials, no `?` or `#`; JSON output must be on in its `settings.yml` (`search.formats`) |
| Brave Search key | not set | secret (key vault); never in a result, row, error, event or Health issue |
| Fall back to the other provider | on | only when the other is set up |
| Safe search | moderate | `off`, `moderate`, `strict`; **an assistant may own its value** (a stricter assistant) |
| Results per search | 4 | 1–5 |
| Searches per day | 100 | any provider; a cache hit is free |
| Monthly budget for paid searches | 5 USD | `0` turns the paid provider off |
| Price of 1,000 Brave searches (advanced) | 5 USD | to estimate the spend |
| Search time limit (advanced) | 2,500 ms | 500–10,000 |
| Page time limit (advanced) | 6,000 ms | 1,000–15,000 |
| Blocked sites | none | domains (and their subdomains) never shown and never opened |
| **Test** | | sends one search to the chosen provider and says what is wrong ("JSON output is off: add json to `search.formats`"). With Brave it is one paid search, not counted in the usage; the button asks first |

Health says when no provider is set up, or when the chosen one lacks its address or key (it checks settings only; the Test
button is the network check).

## What it stores

Nothing personal. No query text is stored anywhere, no person or device is named in a row (every write names the module as
its actor, so the store's "last written by" is not whoever searched), and what is cached is public web results. A query does
leave the house: the provider sees it, with the server's address.

| Collection | Scope | `maxChars` | Indexes | Rows a list reads | Holds |
|---|---|---|---|---|---|
| `usage` | household | 300 | `month` | 83 (never listed on a turn: the three rows of a month are read by id, `<month>:searxng`, `<month>:brave`, `<month>:pages`; the daily job lists oldest first to clear old months, 30 at a time) | month, kind, searches this month, the day and its count, estimated micro-dollars. Kept 14 months |
| `search_cache` | household | 7,500 | `at` | 3 (the daily job lists oldest first in batches of 3, up to 200 batches) | at, provider, up to five results; the row id is a hash of the search, so the query is not stored. Ten minutes' life |

**Scheduled:** one daily system job, `purge` (cron `40 4 * * *`, the household's time zone, idempotent), removes expired cache
rows and counters older than 14 months, in small batches each its own transaction. A cache row that is expired but not yet
purged is never served (the age is checked on read). Both collections are bounded: the cache gets at most one row per search
and searches are capped per day.

## What it needs

- `requires: [{ network: "internet" }]` (Brave and the pages), and `health` as above. SearXNG on the LAN is reached through
  the owner-configured function only.
- A SearXNG server with JSON output on, or a Brave Search API key. Nothing else; no service from another module, no
  contribution provided or used.
- Libraries (all in the package): `@mozilla/readability`, `linkedom`, `turndown`.

## What was left out

Left out for wave B (needs something that does not exist yet):

- **Sources on screen** and **`search_sources`**: the `list` presentation of the sources and the QR hand-off (P10), and
  sending the sources to a phone (P9 notifications). The `url` in each result is there for the model, which never reads it out.
- **Spoken filler** ("let me look that up") from the module: `ctx.speech` does not exist. The tool's `latency` is `slow`
  and its instructions line asks the model for a short lead-in.

Left out because the plan's row says so ("left for later"):

- **`research`** (the background multi-search job with a report), more providers (Tavily, Exa, Kagi, Perplexity, and their
  `extract`), provider-native search.

Left out by decision of this first version:

- **PDFs.** `read_page` refuses a PDF with "I can't read PDF files yet." *before* its body is read: the response-type policy
  is HTML and plain text only, narrower than the `webPage` preset. `pdfjs-dist` parses on the calling thread without a bound
  this module could state and test (a hostile PDF can take as long as it likes), so it stays out until it can run in a worker
  that is stopped at a deadline. The dependency is still in `package.json` (the lockfile is not this PR's to change).
- **"Allow LAN fetches"** for `read_page` (open question 7 of the research): `read_page` never reaches the home network.
- A **page cache**, the **`last_sources`** collection, the **event** `web-search.budget.reached` and the 80 % warning
  (a notification), per-person budgets, and a "watch this" monitor.
- **Numbers are said as digits** in the usage sentence (with the language's decimal mark): `@pva/language` is not among
  this package's dependencies and the lockfile is not this PR's to change.
- The Test button of Brave is not counted in the usage (a field action has no store).
