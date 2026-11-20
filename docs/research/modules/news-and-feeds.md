# News and feeds (RSS, headlines, watchers, alerts)

Research write-up, 2026-11-18. Not an approved design. Shared foundations (Module manifest, Connection, Module store,
Scheduler, Event bus, Notification service, Tool context, Presentation, Device capabilities) are worked out in
[`../module-investigation/`](../module-investigation/) and linked, not redesigned. Claims marked **[unverified]** or
**[from memory]** were not confirmed in a primary source today. Latency figures are estimates to measure with
`TurnTrace`.

## 1. Summary

The owner asked for "an RSS module, or a news module". This module is both. It keeps the household's **subscriptions**
(RSS, Atom, JSON Feed), managed by voice and in the admin UI, or taken from a self-hosted reader the household already
runs (Miniflux, FreshRSS, anything that speaks the Google Reader or Fever API). It answers "what's the news" by topic
and region. It can go deeper: "tell me more about the second one" and "read me the article". It merges the same story
from five feeds into one item. It also owns **watchers** (page changes, through changedetection.io or a small built-in
checker) and **keyword alerts** ("tell me when there's news about the A27"), which go out through the Notification
service. On a screen it shows headline cards or a ticker.

**Boundary.** [briefing.md](briefing.md) consumes this module. It reads a `news.latest` export through its section
contract and keeps the digest, its order, length and delivery. The feed store, `news_*` tools and `watch_*` tools
sketched in briefing §4–§6 move here (see §15, question 7). Topic search across the open web stays in
[web-search.md](web-search.md). This module calls it only when the feeds have nothing. Reading a long article aloud
uses the engine in [read-aloud.md](read-aloud.md); this module hands it the text. Podcast feeds are
[podcasts-and-audiobooks.md](podcasts-and-audiobooks.md).

- **Priority: first wave** for subscriptions, headlines, "more about" and the briefing export. **Second wave** for
  keyword alerts, story clustering, changedetection.io and the ticker. Briefing is first wave and needs news on day
  one.
- **Effort: M.** Feeds-only, with fetch, parse, a cache and three tools, is **S** (two or three days). Reader
  providers, alerts, de-duplication and watchers make **M**. Clustering with embeddings and a full admin page for
  feeds push it towards **L**.

## 2. What others do

| Product | How news works | Copy | Avoid |
|---|---|---|---|
| Alexa Flash Briefing | Owner-picked sources; each a short audio or text item | Ordered source list, real audio bulletins | Skills that read 2-minute promos |
| Google News / Gemini | "What's the news about X" with a publisher's audio clip; topic follow | Topic as a first-class follow | Opaque ranking |
| Kagi News ([Kite](https://news.kagi.com/api-docs)) | One daily batch of clustered stories per category, built only from public RSS feeds. Data at `kite.kagi.com/kite.json`; the code is open; the data is CC BY-NC per its repository **[unverified licence wording]** ([kite-public](https://github.com/kagisearch/kite-public)) | Clustering, one summary per story with its source articles, "once a day is enough" | — |
| Miniflux | Minimalist reader, REST API, `X-Auth-Token` ([API](https://miniflux.app/docs/api.html)) | A clean API we can drive | — |
| FreshRSS | Self-hosted reader with the Google Reader API at `/api/greader.php` and a Fever API ([docs](https://freshrss.github.io/FreshRSS/en/developers/06_GoogleReader_API.html)) | Speak the de facto reader protocol | — |
| changedetection.io | Page watcher with Playwright fetcher, REST API, Apprise notifications ([API](https://changedetection.io/docs/api_v1/index.html)) | Delegate JavaScript-heavy pages | Rebuilding a browser fetcher |
| Huginn / IFTTT | Website agents, "new item in feed → notify" | Keyword alert as a rule | Hourly polling for urgent things |

Lessons: the owner picks the sources. One story is one item, not five. Headlines stay short. Depth comes on request.

## 3. Example conversations

1. "Hey Jev, what's the news?" → "Three stories. The cabinet agreed the housing plan, says NOS. Storm warning for the
   coast tonight. And Ajax lost to PSV, two–one." (from cached feeds, about 50 ms of tool time)
2. "Tell me more about the second one." → `news_story({ ref: 2 })` → "KNMI issued code orange for Zeeland and Holland
   coast from 18:00, gusts up to 110 km/h. Three outlets carry it; the KNMI's own page has the details."
3. "Read me the article." → hands the cleaned text to read-aloud: "It's about four minutes. Here goes." **(speaker)**
4. "Any tech news?" → topic `tech` from Tweakers and Ars Technica feeds → two headlines.
5. "Subscribe to the Leidsch Dagblad." → `feed_find` discovers `…/rss` on the site → "I found their main feed and a
   Leiden-only feed. Which one?" **(with a screen: a `list` with pick)**
6. "Tell me when there's news about the A4 roadworks." → `news_alert_add({ keywords: ["A4", "werkzaamheden"] })` →
   "I'll tell you when a story about A4 roadworks appears in your feeds." Later, a `normal` notification.
7. "Tell me when the Rijksmuseum page lists Vermeer tickets." → `watch_add` (see briefing example 7).
8. **Ambiguous.** "What's the news in Utrecht?" → region `Utrecht` matches a feed tagged with that region and the
   word in titles → if nothing: "Nothing about Utrecht in your feeds today. Shall I search the web?"
9. **Failure.** "Read me the FD article." → paywalled: "That article is behind the FD's paywall. I can give you their
   summary, or send the link to your phone." Never a bypass.
10. **Failure.** "What's new?" with every feed failing → "I couldn't reach any news feeds since 7:10. The last
    headlines I have are from then; want them?"

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `news_headlines` | `topic?`, `region?`, `source?`, `since?` (default 24 h), `max?` ≤ 5 | numbered stories: `ref`, title (cleaned), sources[], time, one-line summary | R | safe | 10–30 ms (cache) | **yes** (template "N stories: …") |
| `news_story` | `ref` (number from the last list, or story id), `detail?: "summary" \| "sources"` | longer summary, the source list, related stories | R | safe | 20 ms; 0.5–2 s when the article is fetched | no |
| `news_article` | `ref`, `source?` | readability text ≤ 6,000 chars, `paywalled`, word count, `readAloudId` | R | safe (fetches a feed-listed URL) | 0.5–2 s | no |
| `news_search` | `query`, `since?` | stories from feeds; `fallback: "web"` when empty (the model may then call `web_search`) | R | safe | 30–80 ms (FTS) | no |
| `feed_find` | `site_or_name` | candidate feeds: url, title, type | R | outward-facing | 0.5–3 s | no |
| `feed_subscribe` / `feed_unsubscribe` | `url` or `name`, `topics?`, `region?`, `scope?: household \| me` | the feed record | W | changes data | 0.5–2 s (first fetch) | yes ("unsubscribe from X") |
| `feed_list` | `topic?` | feeds with label, last item time, health | R | safe | < 20 ms | yes |
| `news_alert_add` / `_list` / `_remove` | `keywords[]`, `exclude?[]`, `sources?`, `priority?: low \| normal` | alert id | W / R | changes data | < 30 ms | yes ("stop the A4 alert") |
| `watch_add` / `watch_list` / `watch_remove` | as [briefing §4](briefing.md#4-tools): `url`, `what?`, `every?` ≥ 15 min, `notify?` | watcher id, first snapshot summary | W / R | changes data | 1–3 s | no / yes |
| `news_save` | `ref` | hands the article URL to read-aloud's `read_later_save` | W | changes data | 0.2–1 s | yes ("save that for later") |

All read tools are `speculative: true`. `feed_find` and `watch_add` fetch owner- or model-supplied URLs, so they use
the SSRF guard from [web-search §13](web-search.md#13-privacy-and-safety). `ref` numbers resolve against the
conversation-scoped "last list" (as `music_search` does).

## 5. Integrate or build

### 5.1 Feed handling: build

- **Fetch.** Plain `fetch` with `If-None-Match` / `If-Modified-Since` (store `etag`, `last-modified`). At most one
  request per host per minute. Back off on 429 and 5xx and honour `Retry-After`. Use a speaking User-Agent without
  personal data ("pva-news/1").
- **Parse.** [`feedsmith`](https://www.jsdelivr.com/package/npm/feedsmith) (MIT) parses RSS, Atom, RDF and JSON Feed,
  plus the iTunes, Podcast and Dublin Core namespaces and OPML. It has one maintainer and about 27k weekly downloads
  ([depscope](https://depscope.dev/pkg/npm/feedsmith), **[unverified figures]**). `rss-parser` is the fallback.
  OPML import and export come with the same library, so a subscription list can move from any reader.
- **Clean.** Strip HTML, emoji, "LIVE:", "VIDEO |" and ALL-CAPS prefixes from titles for speech. Keep the original
  for the screen.
- **Discover.** `feed_find` reads `<link rel="alternate" type="application/rss+xml">` from the page, then tries
  `/feed`, `/rss`, `/atom.xml`. Miniflux's `POST /v1/discover` does the same when Miniflux is the provider.

### 5.2 Providers: the built-in store, or a reader the household runs

| Provider | Access | What it gives | Verdict |
|---|---|---|---|
| **Built-in** | The Module store | Subscriptions, items, read state | Default; local-first, no extra service |
| **Miniflux** | `X-Auth-Token` header; `GET /v1/entries?status=unread&category_id=&search=&published_after=`; `GET /v1/feeds`; `POST /v1/feeds {feed_url, category_id}`; `PUT /v1/entries {entry_ids, status}`; `GET /v1/entries/{id}/fetch-content` ([API](https://miniflux.app/docs/api.html)) | Its subscriptions, categories (= topics), read state, full content fetch | **Best provider**: a clean REST API, and "mark read" keeps the phone app in step |
| **FreshRSS** (and Inoreader, The Old Reader, Bazqux) | Google Reader API: `POST accounts/ClientLogin` (`Email`, `Passwd` = the API password) → `Authorization: GoogleLogin auth=<Auth>`; `reader/api/0/subscription/list`, `stream/contents/reading-list`, `subscription/edit`; a `token` call before writes ([FreshRSS](https://freshrss.github.io/FreshRSS/en/developers/06_GoogleReader_API.html)). `edit-tag` for marking read **[from memory]** | Same as Miniflux, older protocol | Yes, one adapter covers several readers |
| **Fever API** | `api_key = md5(email:password)`, `?api&items&since_id=` **[from memory]** | Read-only items and groups | Only if nothing else is available |
| **Nextcloud News** | REST API v1.3 **[unverified]** | — | Later, on request |

**Recommendation.** Use the built-in store by default. When a reader is connected (a
[Connection](../module-investigation/module-definition-config-and-dependencies.md)), the reader becomes the record.
Subscribing by voice then subscribes in the reader, and read state flows both ways. The module keeps only its own
cache, clusters and alerts. That means the household manages feeds in one place, the app it already uses.

### 5.3 News sources and their terms

| Source | Access | Terms that matter | Use |
|---|---|---|---|
| Publishers' own RSS (NOS, BBC, Tweakers, local papers, councils, clubs) | keyless | Personal reading of a public feed; titles and descriptions as the publisher wrote them | **The default.** Starter lists per language in the module |
| Kagi Kite `kite.json` | keyless, daily batch | CC BY-NC data **[unverified]**: a non-commercial household fits; attribute Kagi and the sources | Optional "world news, already clustered" source |
| [GDELT DOC 2.0](https://blog.gdeltproject.org/?p=4833) | keyless; `mode=ArtList`, `sourcecountry:`, `sourcelang:`, `timespan=` | About one request per 5 s or HTTP 429; at most 250 records; three-month window for list modes ([summary](https://jentic.com/apis/api.gdeltproject.org/gdelt), **[unverified, secondary]**) | Topic and region search when feeds have nothing ("news about Suriname") |
| The Guardian Open Platform | free developer key | Non-commercial developer key per the Guardian's forum; current limits not confirmed (the access page could not be fetched today) **[unverified]** | Optional English full-text topic search |
| NewsAPI.org | key | Free plan is development only, not for production ([pricing](https://newsapi.org/pricing), from briefing §5.2) | **Not suitable** |
| GNews, NewsData.io, Currents, mediastack | key | Free tiers of 100–600 requests a day, often delayed 12 h, terms conflict between sources ([comparison](https://cloro.dev/blog/news-api-free/), **[unverified]**) | Not recommended; delayed news is not news |
| Web search news modes | per query | Costs money ([web-search §5.1](web-search.md#51-providers-november-2026)) | Fallback, by explicit hand-off |

### 5.4 De-duplication and clustering

1. **Same item.** Match on `guid`, then on a canonical URL (strip `utm_*`, `fbclid`, fragments, `amp/` paths, and
   follow `rel=canonical` when the article is fetched).
2. **Same story, different outlets.** Normalise the title (lowercase, strip punctuation and stop words for nl and en)
   and compare token shingles with Jaccard ≥ 0.5 inside a 36-hour window. Run a SimHash over title plus description
   as a cheap pre-filter. That catches "Kabinet akkoord over woningplan" and "Kabinet bereikt akkoord woningbouwplan".
3. **Cross-language or reworded** stories need embeddings. Use the same local embedding model proposed in
   [documents §5.3](documents.md#53-question-answering-full-text-or-embeddings). Cosine ≥ 0.8 merges. This is **later**:
   it costs about 10–30 ms per item on CPU **[estimate, to measure]**.
4. **Ranking.** A story's weight = number of distinct sources + recency + the person's topics. "Top three" means the
   three heaviest clusters, not the three newest items.

Each cluster gets a `ref` and a **lead source**: the owner's preferred outlet, else the earliest one.

### 5.5 Watchers and alerts

Watchers are as designed in [briefing §5.3](briefing.md#53-watchers-build-small-integrate-optionally). They now live
here. They cover the built-in checker for static pages and changedetection.io for JavaScript pages. The
changedetection.io calls are `POST /api/v1/watch {url, title, tags, time_between_check, notification_urls}`, then
`GET /api/v1/watch/{uuid}/difference/previous/latest?format=text` for the change text, with header `x-api-key`
([API](https://changedetection.io/docs/api_v1/index.html)). Its notifications use Apprise URLs, so the cleanest hook
back to us is an Apprise `json://` POST to an inbound hook of the
[notifications module](notifications.md). Polling is the fallback while modules cannot have HTTP routes
([current-system gap 21](../module-investigation/current-system.md#9-gaps-a-module-ecosystem-would-need)).

**Keyword alerts** run on every new item after refresh. They match keywords and phrases in the title and description
(FTS5 `MATCH`), with an exclude list and an optional source filter. They fire at most once per cluster, so five
outlets give one alert. The rate limit is three alerts per alert rule per day, and anything beyond that is folded into
the inbox.

### 5.6 Paywalls and fair summarising

- Never bypass a paywall: no archive mirrors, no Googlebot user agent, no removing overlays.
- A fetched page under 400 words with paywall markers (`isAccessibleForFree: false` in JSON-LD, known overlay
  classes) is marked `paywalled`. The module then offers the feed's own description and a hand-off to the phone,
  where the person's own subscription works.
- Name the outlet in every spoken summary ("says NOS"). Keep summaries to two or three sentences and do not read
  someone else's whole article as our summary. Reading the full text aloud is the person's own reading of a page
  they could open, done through read-aloud, for one listener.

## 6. Data

All in the [Module store](../module-investigation/shared-state-jobs-and-notifications.md).

| Collection | Scope | Rough schema | Readable by others |
|---|---|---|---|
| `feeds` | household; person extras | `{ id, url, label, kind: news \| watch-feed, topics[], region?, language, provider: builtin \| miniflux \| greader, etag, lastModified, lastItemAt, health }` | briefing (labels) |
| `items` | household | `{ guid, feedId, title, titleSpoken, summary, url, canonicalUrl, published, clusterId, paywalled? }`, kept 7 days | via export |
| `clusters` | household | `{ id, items[], leadItemId, weight, topics[], firstSeen }` | `news.latest` export |
| `items_fts` | module SQL | FTS5 over title and summary | — |
| `alerts` | person | `{ id, keywords[], exclude[], sources[], priority, lastFiredAt, firedToday }` | — |
| `watchers` | person | as briefing §6 | — |
| `prefs` | person | `{ topics[], preferredSources[], region, headlineCount }` | briefing |
| `lastList` | conversation | the numbered refs of the last answer | — |

Export to other modules: `news.latest({ topic?, max }) → clusters` for briefing, plus the `news.alert` and
`watch.changed` events.

## 7. Long-running work and events

- **Refresh** (Scheduler `recurring`, every 15–30 minutes per feed with jitter; per-feed override for slow feeds;
  with a reader provider, one call to the reader instead). After a restart it refreshes once at start.
- **Cluster pass** after each refresh (in process, < 200 ms for a few hundred items **[estimate]**).
- **Alert matching** after the cluster pass. **Watcher checks** as in briefing §7.
- **Clean-up** every night: delete items older than 7 days and stale clusters.
- **Events emitted:** `news.refreshed`, `news.alert { alertId, clusterId }`, `watch.changed`. **Consumed:** nothing
  needed; briefing listens to `news.refreshed` to warm its section cache.

## 8. Presentation

- **Headlines** on a screen are a `list` of cards: title, outlet, time, thumbnail from the feed's media tag (through
  the server's `/media/<hash>` proxy, [presentation §3.2](../module-investigation/presentation-and-device-capabilities.md)).
  A tap is a `say` action "more about item 2". The list appears as the first headline is spoken.
- **A story** is a `card` with the summary, a "sources" facts row and a `handoff` QR for the lead article.
- **Ticker.** On an `alwaysOn` display in the Ambient layout, a pinned strip shows the top five cluster titles, one at
  a time, every 8 s, with the character in its corner. It is a pinned `list` with a `ticker` display hint. It is off
  by default and can be set per device. It never speaks.
- **Without a screen:** at most three headlines, each one sentence with the outlet, then "Want more on any of them?"
  URLs are never spoken.

## 9. Notifications and proactive behaviour

- **Keyword alerts:** priority `normal` by default (`low` = inbox only), to the alert's owner, on their private
  devices. Shared devices get them only if the owner allows it. Quiet hours apply.
- **Watcher changes:** as in [briefing §9](briefing.md#9-notifications-and-proactive-behaviour).
- **Breaking news** is not a feature. A household that wants it creates an alert on its broadcaster's breaking-news
  feed.
- Never: "no new stories", and no spoken unprompted headlines (that belongs to briefing's schedule).

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | language and region (Home section); default topics | from Home |
| Module | provider (`builtin`, `miniflux`, `greader`); reader URL and credentials (Connection); refresh interval; starter feeds; optional sources (Kite, GDELT, Guardian key); clustering on; item retention | builtin; 20 min; per language; off; on; 7 days |
| Assistant | on/off; `offTools` (a kids' assistant without `news_article`, with a children's feed only) | inherit |
| Device | ticker on, headline thumbnails | off; on |
| Person | topics, preferred outlets, alert rules, watchers, headline count | household default; 3 |

Secrets: Miniflux API key, FreshRSS API password, Guardian key and changedetection.io key all live in the vault.
**First-run:** pick a starter list or import OPML, or connect a reader and press **Test** ("Miniflux: 42 feeds, 310
unread"). Then choose topics.

## 11. Native tools and dependencies

None on the server beyond npm packages (`feedsmith`, `@mozilla/readability`, `linkedom`, shared with web-search).
Optional services: Miniflux or FreshRSS on the LAN, and changedetection.io. When something is missing, the assistant
says one of these:

- Reader unreachable: "Your news reader isn't answering; here's what I had at 7:10."
- No feeds: "No news feeds are set up yet. You can add some in Settings, or say 'subscribe to' and a site."
- JavaScript page: "That page needs a browser to check; the owner can connect changedetection.io for it."

## 12. Interaction with the rest of the system

- **Voice.** Outlet names get mangled ("Tweakers" → "tweakers", "NRC" → "and RC"). A per-feed `aliases` list
  solves it. Ordinals ("the second one", "the last one", "die over Ajax") resolve against `lastList`.
- **Fillers.** Headlines need none. `news_article` and `feed_find` use the text-before-tool flush: "Let me get the
  article."
- **Interruption.** "Next" and "skip" between headlines go to the typed-intent path, as in briefing §12.
- **Fast path.** "What's the news", "tech news", "unsubscribe from X" and "stop the A4 alert" are actions with
  `examples`. The template path speaks the top three without a model.
- **Assistants.** No template. Every general assistant gets the read tools, and the main one gets subscribe and alerts.
- **Other modules.** Briefing (export), web-search (fallback), read-aloud (article reading, read-later), notifications
  (alerts, inbound changedetection hook), memory-and-notes (none).

## 13. Privacy and safety

- Feed text is untrusted: data, never instructions. A headline saying "ignore previous instructions" is just a
  headline.
- Person-scoped alerts and topics are private. On a shared device, "what's the news" uses household feeds plus the
  device's default person's topics.
- Children: a kids' assistant reads only feeds marked `kids` (for example NOS Jeugdjournaal **[from memory: feed
  exists]**). Alerts on violent keywords are not suppressed for adults, and the module never filters what adults read.
- Outbound requests: feeds and watchers use the SSRF guard. Allowing LAN targets is a separate owner switch.

## 14. Foundations needed

Hard: none for a first version. The Module store and Scheduler are needed for persistence and refresh across
restarts. The Notification service is needed for alerts, Presentation for cards and the ticker, and Tool context for
person topics. **Useful first version:** built-in feeds in a JSON file, refreshed by a scoped fiber, with
`news_headlines`, `news_story` and `news_article`, plus the `news.latest` export for briefing. That is the S version
and is enough for briefing.

## 15. Open questions

1. **Reader or built-in?** Does the household already use Miniflux, FreshRSS or a phone RSS app worth syncing with?
2. **Which outlets** form the starter list (NOS, NU.nl, RTV regional, BBC, Tweakers, a local paper)?
3. **Clustered world news from Kagi Kite**: is its non-commercial data licence acceptable to rely on?
4. **Alerts on shared speakers**: may a keyword alert ever be spoken in the kitchen, or only on private devices?
5. **Ticker**: wanted on the kitchen display, or is the stage better left calm?
6. **Paywalled outlets the household pays for**: hand off to the phone only, or log in on the server (cookies in the
   vault)? This document recommends hand-off only.
7. **Disagreement with [briefing §15 Q7](briefing.md#15-open-questions):** briefing keeps feeds and watchers inside
   itself until a second consumer appears. The owner's explicit request for an RSS module, plus alerts and
   read-aloud as consumers, is that second consumer. This document proposes moving `news_*`, `feed_*` and `watch_*`
   here, so that briefing reads only `news.latest`. Agree?
