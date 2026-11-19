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
- **A provider's answer that is malformed** (not JSON, no results list, a part present with the wrong type, such as Brave's
  `web` as a list or `null`) is a failure of that provider, so the fallback runs; only an answer without a `web` part at all
  (Brave's way of saying nothing matched) or with an empty list is "I found nothing for that."
- **Caps.** A daily cap on searches (any provider) and a monthly budget in dollars for the paid provider, checked and
  counted in one store transaction *before* each call, so a loop meets the cap and two searches at once cannot both pass
  it (tested: two searches competing for the last allowance make one provider request). The clock is read right before
  each provider's reservation, so a fallback after midnight or after the end of a month is counted in that new day and
  month, against its caps. A search that fails still counts (the provider may have billed it). At the monthly budget
  the paid provider is skipped and the other one used when there is one; at the daily cap the person is told when it
  resets and what to change. When the allowance cannot be read or written, no request leaves: "I couldn't check the
  search allowance, so I didn't search."
- **No cache.** Every search is asked of the provider and counted, the same search again too: nothing of a search is
  kept, so nothing stored can say what anyone searched for.
- **Reading a page** goes through `safeFetch` with a response-type policy (HTML and plain text), a size limit (1 MiB, a
  bigger page is refused, not cut), a time limit (6 s by default) and its guards: only http(s) on ports 80 and 443, no
  credentials, no address on the home network, checked on the address it connects to and on every redirect (the
  `192.168.1.1/admin` case answers "That address is on the home network, so I won't open it."). The page becomes Markdown
  with links reduced to their text and images, scripts and menus dropped (`@mozilla/readability` on `linkedom`, then
  `turndown`), cut to 6,000 characters. `focus` brings the paragraphs that mention its words first. HTML that leaves out
  its optional `<html>`, `<head>` or `<body>` tags is read like any other page (its nodes are put into a complete document
  first), and so is a short page below Readability's threshold (its body text is taken).
- **Blocked sites on every hop.** The owner's block list is checked on the address asked for and again on every redirect,
  before that hop's host is looked up or connected to (the module gives `safeFetch` a resolver and a connector that refuse
  a blocked host); a page that redirects to a blocked site answers "That site is on the blocked list, so I won't open
  it." and nothing of the blocked site is fetched. The `site` returned is the one that finally answered. Hosts are
  compared in one canonical form (lower case, IDNA as the URL parser gives it, without the terminal DNS dot) for block
  entries, page addresses and search results alike, so `blocked.example.com.`, `BLOCKED.example.com` and
  `xn--bcher-kva.example` for `bücher.example` are all caught. A block entry that is not a host name is refused when the
  owner saves it.
- **Off the main thread.** Everything that turns the fetched page into text (decoding its charset, parsing, Readability,
  Turndown, the plain-text path) runs as one task in a fresh worker thread (`offThread` from `@pva/core`,
  `src/page.task.ts`): the bytes go in, at most a title and 6,000 characters of text come out (answer limit 64 KiB), with
  a real time limit of 3 s (start-up included) and a 256 MB heap. The markup is still cut to 400,000 characters, and a
  document of more than 6,000 elements skips Readability. A page that takes longer, such as 25 KB of 2,272 nested
  elements (which held the event loop for 34 s when it was parsed on the main thread), ends as a timeout and the person
  hears "That page is too complex for me to read." Interrupting the turn (barge-in, the module stopping) terminates the
  worker. Measured with a 1 ms heartbeat in the package's tests, the longest event-loop stop during `read_page` of that
  nested page, a 400 KB page of 50,000 elements and a 390 KB text file of 130,000 paragraphs is 2.0 to 3.0 ms on the
  development machine in most runs; the worst seen was 8 ms, a pause that comes in the middle of the nested page's
  worker run (at any heap size, with nothing running on the main thread). The test asserts under 10 ms (30 ms on CI,
  the store's latency allowance). The worker's start-up adds about 0.3 s to each page. The libraries are
  loaded only in the worker, so the main thread never loads them.

## Tools

| Tool | Parameters | Risk | Answers |
|---|---|---|---|
| `web_search` | `query` (2–200 characters, one line), `recency?` (`day`, `week`, `month`, `year`), `count?` (1–5, default from settings), `site?` (a domain) | `read` (speculative only when no paid provider can answer) | `{ notice, results: [{ n, title, site, snippet, url, published? }], provider }`, or a `spoken` "I found nothing for that." |
| `read_page` | `url`, `focus?` (what to look for) | `read` (never speculative: it fetches an address a model chose) | `{ notice, title, site, text, truncated }` |

Example phrases (the model decides which tool; there is no phrase-command path): "who won the Dutch Grand Prix this
year?" → `web_search`; "is the A12 still closed this weekend?" → `web_search` with `recency: "week"`; "what does that
article say?" → `read_page` on result 1. "Wie won de Grand Prix van Nederland?" works the same; every sentence the module
itself speaks (errors, caps, refusals) is in English and Dutch by `HOME_LANGUAGE`.

Errors say what the person can do: not set up ("The owner can pick a search provider in Settings."), slow, unreachable,
key refused, rate limited, JSON off on the SearXNG server, the daily or monthly budget used, the allowance unreadable, a
page on the home network, a PDF, a blocked site, too big, too slow, too complex to read. Each is tested in English and
Dutch.

**Action** (runs without the model, offered to the model as `web-search_usage`):

| Action | Examples | Says |
|---|---|---|
| `web-search.usage` | "how many searches have I used", "how much web search budget is left", "hoeveel zoekopdrachten heb ik gebruikt" | "Today 3 of 100 searches are used. This month 41 searches, and the paid ones cost about 0.2 of the 5 dollars allowed." Numbers are worded by `@pva/language` (`speakNumber`: "0,2" in Dutch); a spend under half a cent is "less than 0.01" |

## Settings

| Field | Default | Notes |
|---|---|---|
| Search provider | SearXNG | `searxng` or `brave` |
| SearXNG address | empty | http(s), no credentials, no `?` or `#`; JSON output must be on in its `settings.yml` (`search.formats`) |
| Brave Search key | not set | secret (key vault); never in a result, row, error, event or Health issue |
| Fall back to the other provider | on | only when the other is set up |
| Safe search | moderate | `off`, `moderate`, `strict`; **an assistant may own its value** (a stricter assistant) |
| Results per search | 4 | 1–5 |
| Searches per day | 100 | any provider; every search is counted |
| Monthly budget for paid searches | 5 USD | `0` turns the paid provider off |
| Price of 1,000 Brave searches (advanced) | 5 USD | to estimate the spend |
| Search time limit (advanced) | 2,500 ms | 500–10,000 |
| Page time limit (advanced) | 6,000 ms | 1,000–15,000 |
| Blocked sites | none | domains (and their subdomains) never shown and never opened, also not through a redirect; an entry that is not a host name is refused on save |
| **Test** | | sends one search to the chosen provider and says what is wrong ("JSON output is off: add json to `search.formats`"). With Brave it is one paid search, not counted in the usage; the button asks first |

Health says when no provider is set up, or when the chosen one lacks its address or key (it checks settings only; the Test
button is the network check).

## What it stores

Counters only. No query text, no result and no page is stored anywhere; no person or device is named in a row (every write
names the module as its actor, so the store's "last written by" is not whoever searched). A row holds a month, a day, the
provider's name and numbers, and its id is the month and the provider (`2026-11:brave`), so nothing a search could be
recovered from (tested with a provider whose answer repeats a personal query). A query does leave the house: the
provider sees it, with the server's address.

| Collection | Scope | `maxChars` | Indexes | Rows a list reads | Holds |
|---|---|---|---|---|---|
| `usage` | household | 300 | `month` | 83 (never listed on a turn: the three rows of a month are read by id, `<month>:searxng`, `<month>:brave`, `<month>:pages`) | month, kind, searches this month, the day and its count, estimated micro-dollars. Kept 14 months |

**Scheduled:** nothing. Old months are removed when a new month starts, in the transaction that counts its first search:
one bounded read of at most 12 of the oldest rows through the `month` index, those older than 14 months removed.

## What it needs

- `requires: [{ network: "internet" }]` (Brave and the pages), and `health` as above. SearXNG on the LAN is reached through
  the owner-configured function only.
- A SearXNG server with JSON output on, or a Brave Search API key. Nothing else; no service from another module, no
  contribution provided or used.
- Libraries (all in the package, loaded only in the page task's worker): `@mozilla/readability`, `linkedom`, `turndown`;
  `@pva/language` for spoken numbers.

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

- **PDFs.** `read_page` refuses a PDF, like any other file, with "I can only read web pages and plain text, not PDFs or other files." *before* its body is read (the network helper no longer says which type was refused, so there is one sentence for all of them): the response-type policy
  is HTML and plain text only, narrower than the `webPage` preset. A PDF could now be parsed in the page task's worker
  with its time limit; that is a later version. The dependency is still in `package.json` (the lockfile is not this PR's
  to change).
- **"Allow LAN fetches"** for `read_page` (open question 7 of the research): `read_page` never reaches the home network.
- A **result cache** and a **page cache** (a stored copy of what people searched for or read), the **`last_sources`**
  collection, the **event** `web-search.budget.reached` and the 80 % warning (a notification), per-person budgets, and a
  "watch this" monitor.
- The Test button of Brave is not counted in the usage (a field action has no store).
