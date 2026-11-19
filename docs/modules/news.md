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
tells the news from that cache, one title and its outlet a sentence ("…, says NOS"). A person can ask about a story by
its number ("tell me more about the second one"), have the article behind it read, and add or drop feeds by voice. The
module also contributes a `news` section to the briefing.

The module is **off by default**; with it off nothing changes for anyone. When it is first switched on it puts a short
starter list in the store, once, chosen by the household's `HOME_LANGUAGE` at that moment:

| Language | Starter feeds |
|---|---|
| Dutch | NOS (`https://feeds.nos.nl/nosnieuwsalgemeen`), NU.nl (`https://www.nu.nl/rss/Algemeen`) |
| any other | BBC News (`https://feeds.bbci.co.uk/news/rss.xml`), The Guardian (`https://www.theguardian.com/world/rss`), Ars Technica (`https://feeds.arstechnica.com/arstechnica/index`) |

After that the list is the household's: removing every feed does not bring the starter back. A starter feed that cannot be
read is impossible to miss (below).

How it behaves:

- **Nothing slow on the turn path, and nothing slow on the main thread.** Headlines, stories and the briefing section read
  the cache: a bounded, indexed read of at most 280 items, newest first, in pages with a yield between them. Parsing a
  feed and turning an article into text each run in a **worker thread** (`offThread` from `@pva/core`) with a time
  limit, a memory limit and a bounded answer; the main thread only posts the text and receives the result. Only
  `feed_subscribe` and `news_article` use the network during a turn.
- **The newest stories, each once.** A feed's newest 25 entries are chosen across the whole feed (feeds are not always
  newest first). Headlines are the newest items of the feeds asked about; two items whose cleaned titles are equal are
  said once, with the first (newest) source. There is no grouping of stories across outlets.
- **Titles are cleaned for speech** when a feed is read: markup (also when escaped once or twice), entities, emoji,
  addresses, "LIVE:" / "VIDEO |" / "BREAKING NEWS:" labels and ALL-CAPS shouting go, and a title is at most 160
  characters, cut at a word. A title that cleans to nothing (only an address, a label or emoji) is said as "a story
  without a headline", never as the text that was taken out.
- **Feed text is untrusted.** Every result that holds text from a feed or an article carries a `notice` that says so, the
  texts are bounded (title 160, summary 240, article 6,000 characters), plain text is what is stored, and the module's
  instructions tell the model to report such text and never obey it. An address a feed gives (an article) goes through
  `safeFetch`, which refuses addresses on the local network. An entry without a link of its own has no article; the
  feed's own address is never used as one.
- **Feeds that cannot be read are impossible to miss.** A feed that has never been read after a try, or has not been read
  for a day, makes the refresh job fail with a message that names it, which is a Health issue until a refresh finds every
  feed readable again. A headline request when no feed could be reached says the feeds could not be reached; when some
  could not, it says how many (beside the stories found, or instead of "nothing new"). The typed action and the briefing
  section say the same in one sentence. "I haven't fetched the news yet" is said only when no feed has been tried yet.
- **A partial read is never presented as complete.** When the 280 items read did not reach the end of the window, the
  answer says so (`cut`), also when a topic found nothing within that part, and in the typed action. A source is read
  through its own index (`[feedId, published]`), so other feeds' items never hide it.
- **Politeness.** One request at a time to one host, shared by the refresh, subscribing and articles; the refresh leaves
  2 seconds between two requests to one host (four hosts at once); a host that answers 429 or 503 with `Retry-After` is
  not asked again before then (at most six hours). A conditional `GET` with the last `ETag` / `Last-Modified` (a 304
  costs almost nothing), each feed looked at no more often than the interval setting, and a feed that keeps failing backs
  off (two intervals, then four, … at most six hours). The `User-Agent` is `personal-voice-assistance/1`, with the
  owner's contact (Home › API contact) only when the owner set one.

## Tools

All tools answer in the household's language; text a feed wrote is passed on as it is (cleaned). Counts and lists are
said by `@pva/language` (`speakNumber`, `speakList`: "A, B and two more").

| Tool | Risk | What it does | Example |
|---|---|---|---|
| `news_headlines` (`topic?`, `source?`, `max?` 1–5, `sinceHours?` 1–168, default 36) | read | The newest stories, numbered; the numbers are remembered for this conversation. Result: `stories` (`ref`, `title`, `source`, `minutesAgo`), `more`, `updatedMinutesAgo`, `cut` when the read was cut short, `unreachable` when feeds could not be reached, `notice`. Or a `spoken` line: no feeds, no such source, not fetched yet, the feeds could not be reached (all, or how many), nothing new, nothing on that topic (and whether that was within a cut read). | "What's the news?" / "Any tech news?" |
| `news_story` (`ref`) | read | More about one story of the last list: summary from the feed, source, age. Asks for the headlines first when there is no list in this conversation, and says a story is gone when its feed was unsubscribed. | "Tell me more about the second one." |
| `news_article` (`ref`) | read | Fetches the page behind a story and gives its readable text, at most 6,000 characters; a longer one ends with " […]" and a `cut` sentence with the article's length in words. When it could read only a few lines (under 80 words) it says so and why it cannot tell more (the rest may need a subscription or come later from the site), with the feed's summary. A story without an article link says so, with the summary. | "Read me the article." |
| `feed_subscribe` (`url`, `name?`, `topics?` ≤ 5) | change | Reads the feed once to check it is one, then subscribes the household (its stories are there at once). One subscription at a time, so the limit of 60 holds and each answer says what that call saved. Refusals say what to do: not an address, too long once written out (300 characters), not a feed ("I need the feed's own address"), unreachable, too slow, too big, too heavy to read (the parse went past its limits), the site asked to wait, refused, already followed, at the limit. | "Subscribe to https://example.org/feed.xml." |
| `feed_unsubscribe` (`name`) | change | Unsubscribes by name (or part of it, or the address). The feed is gone from every read at once; a job removes its stored stories. A name that fits two feeds asks which; an unknown one lists what is followed. | "Unsubscribe from Ars Technica." |
| `feed_list` (`topic?`) | read | The feeds with their topics, whether they work (`ok`, `failing: <why>`, `not fetched yet`, `not reached for over a day`) and the age of their newest story; ten at a time with "more". | "Which feeds do I follow?" |

Typed actions (they run without the language model; the model is also offered each as a tool):

| Action (tool) | Risk | Says | Examples |
|---|---|---|---|
| `news.top` (`news_top`) | read | The newest stories (the headlines setting) as one spoken text, with a sentence when the read was cut or feeds could not be reached, and remembers them as the last list. Also a phrase command and a list on the screen (below). | "what's the news", "geef me de koppen" |
| `news.unsubscribe` (`news_unsubscribe`) | change | As `feed_unsubscribe`. | "unsubscribe from NOS", "zeg NU.nl op" |
| `news.feeds` (`news_feeds`) | read | "You follow A, B and three more." | "which news feeds do I follow", "welke nieuwsfeeds volg ik" |

**Phrase command.** `news.top` is also a phrase command (docs/PHRASES.md): said after the wake phrase it runs the action
without the language model. Nothing else of the module has phrases.

| Language | Phrases |
|---|---|
| English | "what's the news", "what is the news", "give me the headlines" |
| Dutch | "wat is het nieuws", "geef me de koppen", "wat zijn de nieuwskoppen" |

Matching is exact on words (case, accents and punctuation do not count): "what's the news today", "the news" and "news"
are not the command and go on to the assistant. The action's own sentences are reached through the phrase: no feeds,
"I haven't fetched the news yet", "I couldn't reach your news feeds", nothing new.

- **What a phrase may say.** A phrase answer is at most 300 characters (`PHRASE_ANSWER_CHARS`) and the host cuts what is
  longer. So in a phrase turn (and only there) the action builds its answer inside that limit: whole headlines, in order,
  with room kept for the honest notes (the read was cut short, feeds could not be reached) and, when not every selected
  headline fits, one closing sentence: "There are three more; ask me for the headlines." ("Er zijn er nog drie; vraag me
  om de koppen."). When not even one whole headline fits beside the notes, the first one is said with its title shortened
  at a word. The list on the screen and what "the second one" refers to are exactly the headlines that were spoken.
  Outside a phrase turn (the typed action, the model's `news_top`, the tools) the answer is exactly as it was: every
  selected headline.
- **Said once.** A repeat of one phrase invocation (the same assistant, conversation, turn, device and connection) is
  answered with its first words and reads, remembers and shows nothing again; a new invocation acts again. The record is
  one for the whole module, in `shared`, used by every assistant whatever its settings; a repeat runs nothing, and a new
  invocation runs with its own assistant's settings. It holds the newest 64 finished phrase invocations, this run of the
  module only. Calls that are not phrase turns (the model's, a routine's) are never remembered.

**The list on the screen.** When `news.top` tells stories, it returns the headlines that were read out with its answer
(`{ say, present }`; as the model's tool `news_top`, `{ forModel, present }`): a transient `list` titled "News"
(docs/PRESENTING.md), shown on the screen of the device that asked once the turn is committed. A title and its source a
line ("Storm hits the coast – BBC News"), at most 80 UTF-16 units a line, the source at most 24 of them and the title
giving way first. The two notes the answer carries are lines of the list in a few words: "Older stories were not read."
when the read was cut, and "1 of 3 feeds not reached." (or "Feeds not reached; these are the last headlines.") when feeds
could not be reached. Nothing the answer did not say is on it. Text from feeds is plain text there: one line, no
brackets, control or bidirectional characters, lone surrogates dropped and every valid character (also outside the
basic plane: "𠮷野家") kept; cut at a code point boundary inside the unit bound (one function, `cutCodePoints`). Its
`spoken` text, which the model says where the asking device shows nothing, is the answer's own sentences (in a phrase
turn, the answer itself), whole, within 300 characters.

- **A snapshot of the answer.** The module never touches a screen from inside a tool, and holds no handle: the list is
  what the answer said when it said it. It ends by its own 30 seconds, or when the next presentation on that device
  replaces it. It is **not** taken down when a feed it shows is unsubscribed, when a later answer finds nothing, or when
  the model reads headlines of its own: it simply ends within 30 seconds. A later answer on the same device replaces it.
- **Reconnecting and restarting.** A page that lost its connection clears what it showed; a list that is still within
  its lifetime comes back when the page reconnects, with no new question, and a list that ended does not. A restart of
  the module takes its transient lists off every page and nothing is brought back.
- **Privacy.** The news is household data, so the list is a `household` presentation: the Presenter decides for each
  device, at the moment of showing, and shows it on a shared, a private and a public screen alike, as the spoken answer is
  the same on every device. A device without a display, one that is offline or one whose page cannot draw a list is
  shown nothing, and that changes nothing about the answer. There is nothing personal in it to ask `Privacy.mayReveal` about.
- **No buttons and no ticks**, so no press handler: the list is only to read.
- Cost: showing is one enqueue after the answer. Over the largest cache (1,425 items, five headlines) the answer with its
  list held the main thread at most 2.6 to 3.9 ms (`test/latency.test.ts`, three runs, bound 10 ms, 30 ms on CI).

The action is called `top`, not `headlines`, because the host generates a tool `news_<action>` for every action and
`news_headlines` is the tool above.

**Briefing.** `BriefingSections` gets a section `news` (title "News"): the newest stories of the last 36 hours, one
title and one source a sentence ("In the news: …, says NOS."), each cut at a word to fit the contract's 300 characters,
as many as the briefing's length allows (`short` 1, `normal` 2, `long` up to 4), at most the asking assistant's
"Headlines per answer" (read with `settingsFor` at that moment). It reads the cache only. When feeds could not be
reached it says so in one sentence: instead of the stories when there are none, as a sentence of its own when there is
room, or in the lead sentence when there is only one. It is `empty` when there are no feeds or no recent story, fails
with `BriefingSectionError` `unavailable` when no feed has been tried yet, and `failed` when the store cannot be read.
Priority `normal`. It never holds personal content (no `owner`, `withheld: 0`).

## Settings

| Field | Default | What it does |
|---|---|---|
| Keep headlines for (`keepDays`, 1–14) | 7 days | How long the nightly clean-up keeps stories. |
| Look for news every (`refreshMinutes`, 15–240) | 30 minutes | The least time between two looks at one feed. The job itself runs every 15 minutes and skips feeds that are not due. |
| Headlines per answer (`headlines`, 1–5) | 3 | How many stories "what's the news" tells. An assistant may have its own value (`overridable`). |

There are no secrets. Invalid values put the module down with the reason (the admin page shows it) until they are fixed.

## What it stores

**Nothing in this module is about one person**: every row is household data, no row has an owner, and the module
answers every device alike (a shared, a private and a public screen get the same news, and the same list on the screen), so
it asks `Privacy.mayReveal` about nothing. There are no person-scoped feeds or topics in this version. The module never stores secrets; a
subscription address with credentials in it is refused.

| Collection | Scope | `maxChars` | Rows of one list page | Indexes | Holds |
|---|---|---|---|---|---|
| `feeds` | household | 1,700 | 14 | `url` | One subscription: address, label, topics (≤ 5), starter flag, `ETag` / `Last-Modified`, last try / last answer / newest story times, failures in a row and the last reason. At most 60. |
| `items` | household | 1,700 | 14 | `published`; `[feedId, published]` | One story of one feed (title, summary, article address when it has one, time first seen). The id is a hash of the feed and the entry's whole identity (its id, else its link, else its title, hashed whole), so one entry is one row; a correction under the same identity replaces its title, summary and address. At most 25 newest entries per feed are taken each look. Kept `keepDays`. |
| `state` | household | 100 | 1 | – | One row (`starter`) saying the starter list was put in. |
| `lastlist` | conversation | 600 | 1 | – | One row (`last`): one item id per story of the last answer, so "the second one" means something in that conversation. It is written in one step; when it cannot be written the answer fails, and a reference in that conversation is not answered from an older list. |

A turn reads at most 280 items (`SCAN_ITEMS`) and says when it was cut short; the feeds (≤ 60) are read in at most six
pages.

Scheduled (system jobs, started in `shared`): `refresh` every 15 minutes (cron `*/15 * * * *`) and once 3 seconds after
every start (key `refresh-start`, replaced, never doubled; it does not report feeds that cannot be read, the next one
does); `cleanup` nightly at 04:30. A refresh that comes while another runs is skipped. A refresh checks, in the same
transaction that writes, that the feed is still subscribed at the same address, so one unsubscribed while its fetch ran
writes nothing. Unsubscribing writes a `purge` job (key `purge:<feedId>`) in the same transaction as the removal; it
removes 20 pages of the feed's items a run and plans its next run a second later until none are left. The clean-up
removes expired items oldest first, then searches for items of feeds that are gone (moving on past the items that stay),
100 pages of each a run; when a run ends with work left it plans another a minute later (`cleanup-more`). Every write
of a job carries the job as its actor. All handlers are idempotent.

## What it needs

- `requires`: the internet (feeds and articles). Its `health` is empty: the feeds and their state are in the store, which
  health cannot read. A feed that cannot be read shows as the refresh job's own Health issue, naming the feeds, and in
  `feed_list`.
- `uses`: nothing. It **provides** a `BriefingSections` contribution; if the briefing module is off, nothing reads it.
- Libraries, loaded only inside the worker threads: `feedsmith` (parsing, `src/parseFeed.task.ts`), `linkedom` and
  `@mozilla/readability` (articles, `src/readArticle.task.ts`).
- Bounds: a feed answer at most 1 MiB and 6 s; its parse at most 5 s, 192 MB and a 128 KiB answer. An article page at
  most 600 KB and 5 s; its parse at most 5 s, 256 MB and a 64 KiB answer. A parse past a limit is a typed failure with
  its own sentence ("too much for me to read", "took too long"); a feed whose parse fails so is marked failing (`limit`)
  like any other failure.
- Main thread, measured with a 1 ms heartbeat (`test/latency.test.ts`, development machine, three runs, after one warm-up
  call): subscribing to a 1,047,067-byte feed held it at most 5.6 to 6.6 ms; reading a 599,099-byte article 3.4 to
  4.2 ms; a headline request over 1,425 cached items 2.8 to 3.0 ms. The test's bound is 10 ms (30 ms on CI). Each
  worker costs about a quarter of a second to start, which is why `feed_subscribe` and `news_article` are `slow`.

## What was left out

Left out because the plan's row says so (OPML import, reader providers, alerts, clustering beyond titles, watchers, the
ticker):

- OPML import and export; Miniflux, FreshRSS and other reader providers; keyword alerts; watchers
  (`watch_*`, changedetection.io); the ticker; GDELT, Kagi Kite and the other optional sources.

Cut from the first version after review:

- **Grouping the same story across outlets.** Headlines are the newest items, with equal cleaned titles said once and the
  first source; there are no source lists per story and nothing to remember about groups.
- **Paywall detection.** The article tool says what it could read; when that is very little it says so and why it cannot
  tell more. It never claims a page is behind a paywall.

Left out of the phrase command and presentation (the first piece of wave B, above, is in; these are not):

- A phrase for "unsubscribe from X" (the typed action is matched from its examples by the intent agent; a name is text and
  is resolved in the action), and phrases with a topic or a source.
- The story `card` with its QR hand-off, and the ticker (P10).
- Reading a long article aloud through a read-aloud engine, and "save for later" (`news_article` gives the text to the
  model instead).
- Alert notifications (P9), and a spoken notice outside a reply that feeds could not be reached.

Left out because the first version is smaller than the research document, and not named in the plan's row:

- `feed_find` (discovering a feed from a site's address or name: "subscribe to the Leidsch Dagblad") and subscribing by a
  name. `feed_subscribe` needs the feed's own address. Saying so is the refusal's text.
- Feeds and topics per person (`scope: me`), per-feed aliases for outlet names, a kids' feed list, the `news.latest`
  export and the `news.refreshed` event (the briefing section is the one consumer).
- The starter feeds' addresses are long-standing public feeds of large outlets, but they were not checked against the
  live sites from this offline build; a dead one shows as a Health issue naming it.
