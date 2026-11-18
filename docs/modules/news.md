# News and feeds (`news`)

Headlines and stories from news feeds, and subscribing to feeds by voice.

- Package: `packages/module-news`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 20 (wave A)
- Research: [docs/research/modules/news-and-feeds.md](../research/modules/news-and-feeds.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

The household follows news feeds (RSS, Atom, JSON Feed). A job keeps a small cache of their newest stories; the assistant
tells the news from that cache, in one or two sentences a story, with the outlet named ("says NOS"). The same story from
several feeds is one story. A person can ask about a story by its number ("tell me more about the second one"), have the
article behind it read, and add or drop feeds by voice. The module also contributes a `news` section to the briefing.

The module is **off by default**; with it off nothing changes for anyone. When it is first switched on it puts a starter
list in the store, once: NOS, NU.nl and Tweakers for a Dutch household, BBC News, The Guardian and Ars Technica for any
other (the household's `HOME_LANGUAGE` at that moment). After that the list is the household's: removing every feed
does not bring the starter back.

How it behaves:

- **Nothing slow on the turn path.** Headlines, stories and the briefing section read the cache (a bounded, indexed read of
  at most 280 items, newest first). Only `feed_subscribe` and `news_article` use the network during a turn.
- **Titles are cleaned for speech** when a feed is read: markup, entities, emoji, links, "LIVE:" / "VIDEO |" /
  "BREAKING NEWS:" labels and ALL-CAPS shouting go, and a title is at most 160 characters, cut at a word.
- **The same story once.** Titles that share most of their significant words (Jaccard ≥ 0.6, at least three words each) are
  one story; stories with more outlets come first, then the newest. This is titles only (no embeddings).
- **Feed text is untrusted.** Every result that holds text from a feed or an article carries a `notice` that says so, the
  texts are bounded (title 160, summary 240, article 6,000 characters), markup is stripped when stored, and the module's
  instructions tell the model to report such text and never obey it. An address a feed gives (an article) goes through
  `safeFetch`, which refuses addresses on the local network.
- **Politeness.** One request at a time to one host (four hosts at once), a conditional `GET` with the last `ETag` /
  `Last-Modified` (a 304 costs almost nothing), each feed looked at no more often than the interval setting, and a feed
  that keeps failing backs off (two intervals, then four, … at most six hours). The `User-Agent` is
  `personal-voice-assistance/1`, with the owner's contact (Home › API contact) only when the owner set one.

## Tools

All tools answer in the household's language; text a feed wrote is passed on as it is (cleaned).

| Tool | Risk | What it does | Example |
|---|---|---|---|
| `news_headlines` (`topic?`, `source?`, `max?` 1–5, `sinceHours?` 1–168, default 36) | read | The top stories, numbered; the numbers are remembered for this conversation. Result: `stories` (`ref`, `title`, `sources`, `minutesAgo`), `more`, `updatedMinutesAgo`, `cut` when the scan was cut short, `notice`. Or a `spoken` line: no feeds, nothing fetched yet, nothing new, nothing on that topic. | "What's the news?" / "Any tech news?" |
| `news_story` (`ref`) | read | More about one story of the last list: summary from the feed, outlets, age. Asks for the headlines first when there is no list in this conversation. | "Tell me more about the second one." |
| `news_article` (`ref`) | read | Fetches the page behind a story and gives its readable text (at most 6,000 characters). A page behind a paywall is not bypassed: it says so and gives the feed's summary. | "Read me the article." |
| `feed_subscribe` (`url`, `name?`, `topics?` ≤ 5) | change | Reads the feed once to check it is one, then subscribes the household (its stories are there at once). Refusals say what to do: not an address, not a feed ("I need the feed's own address"), unreachable, too slow, too big, refused, already followed, at the limit of 60. | "Subscribe to https://example.org/feed.xml." |
| `feed_unsubscribe` (`name`) | change | Unsubscribes by name (or part of it, or the address); its stored stories go with it. A name that fits two feeds asks which; an unknown one lists what is followed. | "Unsubscribe from Tweakers." |
| `feed_list` (`topic?`) | read | The feeds with their topics, whether they work (`ok`, `failing: <why>`, `not fetched yet`) and the age of their newest story; ten at a time with "more". | "Which feeds do I follow?" |

Typed actions (they run without the language model; the model is also offered each as a tool):

| Action (tool) | Risk | Says | Examples |
|---|---|---|---|
| `news.top` (`news_top`) | read | The top stories (the headlines setting) as one spoken text, and remembers them as the last list. | "what's the news", "geef me de koppen" |
| `news.unsubscribe` (`news_unsubscribe`) | change | As `feed_unsubscribe`. | "unsubscribe from NOS", "zeg NU.nl op" |
| `news.feeds` (`news_feeds`) | read | The names of the feeds followed. | "which news feeds do I follow", "welke nieuwsfeeds volg ik" |

The action is called `top`, not `headlines`, because the host generates a tool `news_<action>` for every action and
`news_headlines` is the tool above.

**Briefing.** `BriefingSections` gets a section `news` (title "News"): the top stories of the last 36 hours, one sentence
each ("In the news: …, says NOS."), as many as the briefing's length allows (`short` 1, `normal` 2, `long` up to 4), at most
the asking assistant's "Headlines per answer" (read with `settingsFor` at that moment). It reads the cache only, is
`empty` when there are no feeds or no recent story, and fails with `BriefingSectionError` `unavailable` when the store
cannot be read. Priority `normal`. It never holds personal content (no `owner`, `withheld: 0`).

## Settings

| Field | Default | What it does |
|---|---|---|
| Keep headlines for (`keepDays`, 1–14) | 7 days | How long the nightly clean-up keeps stories. |
| Look for news every (`refreshMinutes`, 15–240) | 30 minutes | The least time between two looks at one feed. The job itself runs every 15 minutes and skips feeds that are not due. |
| Headlines per answer (`headlines`, 1–5) | 3 | How many stories "what's the news" tells. An assistant may have its own value (`overridable`). |

There are no secrets. Invalid values put the module down with the reason (the admin page shows it) until they are fixed.

## What it stores

**Nothing in this module is about one person**: every row is household data, no row has an owner, and the module
answers every device alike (a shared, a private and a public screen get the same news), so it asks `Privacy.mayReveal`
about nothing. There are no person-scoped feeds or topics in this version. The module never stores secrets; a
subscription address with credentials in it is refused.

| Collection | Scope | `maxChars` | Rows of one list page | Indexes | Holds |
|---|---|---|---|---|---|
| `feeds` | household | 1,700 | 14 | `url` | One subscription: address, label, topics (≤ 5), starter flag, `ETag` / `Last-Modified`, last try / last answer / newest story times, failures in a row and the last reason. At most 60. |
| `items` | household | 1,700 | 14 | `published`; `[feedId, published]` | One story of one feed (title, summary, address, time). The id is a hash of the feed and the entry's own id, so one entry is one row. At most 25 newest entries per feed are taken each look. Kept `keepDays`. |
| `state` | household | 100 | 1 | – | One row (`starter`) saying the starter list was put in. |
| `lastlist` | conversation | 1,800 | 1 | – | One row (`last`): the item ids of the last answer, so "the second one" means something in that conversation. |

A turn reads at most 20 pages of 14 items (`SCAN_ITEMS` = 280) and says when it was cut short; the feeds (≤ 60) are read in
at most six pages. Clean-up and unsubscribing remove in batches of one page per transaction, with a yield between them.

Scheduled (system jobs, started in `shared`): `refresh` every 15 minutes (cron `*/15 * * * *`) and once 3 seconds after
every start (key `refresh-start`, replaced, never doubled); `cleanup` nightly at 04:30. Both handlers are idempotent. A
refresh checks, in the same transaction that writes, that the feed is still subscribed at the same address, so one
unsubscribed while its fetch ran writes nothing.

## What it needs

- `requires`: the internet (feeds and articles). Its `health` is empty: the feeds and their state are in the store, which
  health cannot read; a feed that fails shows in `feed_list`, and a refresh that fails shows as the job's own Health issue.
- `uses`: nothing. It **provides** a `BriefingSections` contribution; if the briefing module is off, nothing reads it.
- Libraries (loaded only when first used): `feedsmith` (parsing), `linkedom` and `@mozilla/readability` (articles).
- Bounds: a feed answer at most 1 MiB and 6 s (parsed synchronously, so that is the parse's bound; at most 25 entries
  kept); an article page at most 600 KB and 5 s (parsed with linkedom and Readability; the parse of the largest legal page
  is tested to stay well under a second).

## What was left out

Left out because the plan's row says so (OPML import, reader providers, alerts, clustering beyond titles, watchers, the
ticker):

- OPML import and export; Miniflux, FreshRSS and other reader providers; keyword alerts; watchers
  (`watch_*`, changedetection.io); clustering beyond titles (embeddings); the ticker; GDELT, Kagi Kite and the other
  optional sources.

Left out for wave B (they need a phrase command, a presentation, a notification or the module's own speech, which do
not exist yet):

- Phrase commands for "what's the news" and "unsubscribe from X" without the model (the typed actions above are matched
  from their examples by the intent agent; the phrase command is the faster path of P7).
- The headline `list` of cards, the story `card` with its QR hand-off, and the ticker (P10).
- Reading a long article aloud through a read-aloud engine, and "save for later" (`news_article` gives the text to the
  model instead).
- Alert notifications (P9), and a spoken "no news since 7:10"-style notice outside a reply.

Left out because the first version is smaller than the research document, and not named in the plan's row:

- `feed_find` (discovering a feed from a site's address or name: "subscribe to the Leidsch Dagblad") and subscribing by a
  name. `feed_subscribe` needs the feed's own address. Saying so is the refusal's text.
- Feeds and topics per person (`scope: me`), per-feed aliases for outlet names, a kids' feed list, the `news.latest`
  export and the `news.refreshed` event (the briefing section is the one consumer).
- Spoken ages and lists worded by `@pva/language`: the package does not depend on it, so counts are digits and a list of
  names is joined by a small helper ("A, B and C" / "A, B en C").
- The starter feeds' addresses were written from memory and are untested against the live sites; the owner can change the
  list by voice or ask for others.
