# Briefing (good morning, summaries, news and watchers)

Research write-up, 2026-11-17. Nothing here is built. Shared foundations (Module manifest, Module store, Scheduler,
Event bus, Notification service, Tool context, Presentation, Device capabilities) are worked out in
[`../module-investigation/`](../module-investigation/) and linked, not redesigned. Claims marked **[unverified]** or
**[from memory]** were not confirmed in a primary source.

## 1. Summary

"Good morning" and "what did I miss?" in one spoken digest composed from other modules: weather, [calendar](calendar.md),
reminders and alarms, [mail](google.md) and [messages](messaging.md), news, commute, deliveries, bin day, running
jobs. It owns two small data sources of its own: **news feeds** (RSS/Atom and optional news APIs) and **watchers**
("tell me when this page changes"). It can run on request, on a schedule, or when someone appears in the morning, at a
chosen length, and it can be interrupted, skipped through and resumed. On a screen it becomes a set of cards.

- **Priority: first wave for the on-request version, second wave for scheduled and presence-triggered.** It is the
  single most popular automation (IFTTT's 7 AM forecast applet, 801k users,
  [landscape-automation §14](../module-investigation/landscape-automation-platforms.md)), and it gives every other
  module a daily audience.
- **Effort: S** for on-request with weather, calendar and news; **M** with the section contract, length control,
  scheduling, presence triggers and cards. Almost all of the data comes from other modules.

## 2. What others do

| Product | How the briefing works | Copy | Avoid |
|---|---|---|---|
| Alexa | "Good morning" routine; Flash Briefing skills (news sources as short audio or text items); proactive traffic nudge | Sources as an ordered, owner-picked list; real news audio clips | "By the way" upsells inside routines ([landscape-voice-assistants summary](../module-investigation/landscape-voice-assistants.md)) |
| Google / Gemini for Home | "Tell me about my day", Good-morning routine; **Home Brief**: last 24 h of camera activity, adjustable ("only the kids", "shorter") | Adjustable by voice in natural terms ("shorter", "skip news") | — |
| Siri / HomePod | Podcast-style news briefing | Playing a broadcaster's bulletin instead of reading headlines | — |
| ChatGPT | Scheduled tasks (2026-06-17) and monitors that notify only on change; replaced Pulse ([landscape-launchers §2.2](../module-investigation/landscape-launchers-and-agent-tools.md)) | "Notify only when something changes" for watchers | A daily essay nobody listens to |
| Home Assistant community | Morning blueprints: an automation gathers weather, calendar and sensors, an LLM words it, a satellite speaks it | Gather in code, let the model only word it | Long LLM pauses before the first word |
| Huginn | Website agents and digest emails ([landscape-automation §8](../module-investigation/landscape-automation-platforms.md)) | Watchers with a CSS selector and a digest | Hourly polling for time-sensitive things (IFTTT's mistake) |

The lessons: compose from structured data, keep the first sentence fast, let the listener steer by voice, and say
nothing for empty sections.

## 3. Example conversations

1. "Good morning, Jeff." → "Morning, Ian. Eight degrees and dry until three, then rain, so take a coat. You have
   standup at nine thirty and lunch with Marloes. The 8:12 to Utrecht is on time. Two important mails, one from the
   landlord. Paper bin goes out tonight. That's it." (normal length, about 30 s)
2. **Shorter.** "Just the short version." → "Eight degrees, rain from three. Standup at nine thirty. Train on time."
   (remembered per person: "always keep it short" sets the preference)
3. **Steer.** During the news section: "Skip." → next section. "More about that." → the model expands on the headline
   with the article text (a fetch, so a filler: "Let me get the article").
4. **Interrupted.** Ian starts talking ("wait, what time is lunch?") → the briefing stops, the question is answered,
   then "Shall I carry on?" → "Yes." → resumes at the next section, not from the start.
5. **What did I miss?** In the evening: "What did I miss?" → "While you were out: a parcel was delivered, Sanne
   messaged about bread, and the research on heat pumps is ready." (inbox plus events of the day)
6. **Presence-triggered.** First voice or touch on the kitchen display after 06:30, 07:12: the screen shows the
   morning cards; the speaker says only "Morning. Rain from three, and the paper bin goes out tonight. Say 'brief me'
   for the rest." (no full briefing unprompted)
7. **Watcher.** "Tell me when the Rijksmuseum page lists tickets for the Vermeer exhibition." → "I'll check that page
   every hour and tell you when it changes." Later, a `normal` notification: "The Vermeer page changed: it now says
   tickets available from 1 December."
8. **Failure.** "Brief me." → "Morning. Nine degrees and cloudy. I couldn't reach your calendar this morning. No news
   feeds are set up." (a slow or failed section is named once, never invented)
9. **Ambiguous.** On the shared kitchen speaker with no default person: "Brief me." → "Here's the household briefing:
   … For your own calendar and mail, ask on your phone or say 'as Ian'."
10. **News only.** "What's the news?" → three headlines from the owner's feeds, then "Want the NOS bulletin?" →
    plays the latest broadcaster audio bulletin (**speaker with audio**).

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `briefing` | `kind: "morning" \| "evening" \| "missed" \| "custom"`, `length?: "short" \| "normal" \| "long"`, `sections?` (ids), `who?` | ordered sections: id, title, one or two spoken sentences, priority, data for cards, `failed` with reason; total estimated seconds | read | safe | budget 800 ms (sections in parallel, each with its own timeout); cached sections 20 ms | yes: the typed action speaks the template join without the model |
| `briefing_section` | `id`, `detail?: "more"` | one section at the next level of detail | read | safe | 50–800 ms | no |
| `news_headlines` | `source?`, `topic?`, `max?` (≤ 5) | headline, source, time, one-line summary, link id | read | safe | 10–30 ms from the feed cache | yes |
| `news_article` | `id` | article text (readability-extracted, ≤ 4000 chars) | read | safe | 0.5–2 s (fetch) | no |
| `news_bulletin` | `source?` | an audio enclosure URL for the media module to play | read | safe | 10–30 ms | yes |
| `watch_add` | `url`, `what?` (text or CSS selector described in words, resolved by the tool), `every?` (min 15 min), `notify?: "change" \| "contains:<text>"` | watcher id, first snapshot summary | write | changes data | 1–3 s (first fetch) | no |
| `watch_list` / `watch_remove` | `id?` | watchers / ok | read / write | safe / changes data | < 30 ms | yes |
| `briefing_prefs` | `length?`, `skip?`, `add?`, `time?` | updated preferences | write | changes data | < 30 ms | yes ("always keep it short") |

The briefing is mostly a **composition** step; the slow parts live in the section providers and are cached by their
own modules, so the briefing itself stays inside a speculative-safe budget.

## 5. Integrate or build

### 5.1 Composition: build

A **section contract**, proposed as a read-only export other modules declare (the "exports" idea of
[shared-state §4.4](../module-investigation/shared-state-jobs-and-notifications.md)), not a new module kind:

```ts
// PROPOSAL, not code
interface BriefingSection {
  id: string                      // "weather", "calendar", "mail", "commute", "bins", "news", "deliveries", "jobs"
  title: string
  personal: boolean               // needs a resolved person; left out on shared devices without one
  gather: (ctx: { person?: PersonId; deviceId: string; kind: BriefingKind; length: Length; now: number })
    => Effect<{ spoken: ReadonlyArray<string>; priority: "lead" | "normal" | "filler"; present?: PresentationInput } | "empty", SectionError>
}
```

Each section writes its own sentences from its own data (the weather module knows "take a coat"), with a sentence
budget per length. The briefing orders sections (owner order, then `lead` items first: "rain from three" before
"eight degrees"), drops `empty` ones silently, and names failed ones once.

**Wording: two paths.** (a) **Template join**: concatenate section sentences with short connectives. No model, works
offline and on the typed-intent path, first audio after the slowest section or 800 ms. (b) **Model pass**: the
`briefing` tool result goes to the assistant's model, which words it naturally and can respond to "and the
weather tomorrow?". It adds model first-token time and output tokens (a 30 s briefing is about 80 words, roughly 110
tokens); the actual cost must be measured with `TurnTrace` before choosing the default. **Recommendation:** template
join for scheduled and presence-triggered briefings and for the `short` length; the model pass on request. Keep the
section sentences good enough that both sound fine.

**Length control.** At ~150 spoken words a minute **[assumed; to measure per voice]**: `short` ≈ 15 s (lead items
only), `normal` ≈ 30–45 s (one or two sentences per section), `long` ≈ 2 min (adds news summaries and tomorrow).
Sections get a sentence budget, not a free hand.

### 5.2 News sources: integrate

| Source | Access | Notes |
|---|---|---|
| RSS/Atom feeds chosen by the owner (NOS `https://feeds.nos.nl/nosnieuwsalgemeen` **[from memory]**, BBC, Tweakers, a local paper, a club site) | `fetch` with ETag, parse with `rss-parser` or `feedsmith` | The default: free, no key, local-first. Recommended in [landscape-launchers §3.11](../module-investigation/landscape-launchers-and-agent-tools.md) |
| Podcast/bulletin feeds (a broadcaster's hourly radio news as MP3 enclosures) | same, `enclosure` URL to the media module | Real voices, current, no summarising; which Dutch bulletin feeds exist is **[unverified]** |
| The Guardian Open Platform | free developer key **[from memory]** | Topic search with full text |
| GDELT DOC 2.0 API | free, no key | Topic search across many languages; limits **[unverified]** |
| NewsAPI.org | Developer plan: free, development only, not allowed in staging or production, 100 requests a day, articles delayed ([pricing](https://newsapi.org/pricing)); Business $449/month | Not suitable |
| Web search news modes (Brave, Tavily) | paid per query | Only for "news about X" when feeds have nothing |

**Recommendation:** feeds only in version 1, with a curated starter list per language; topic search through the
web-search module later. Headline summaries are the feed's own description; the model summarises an article only when
asked ("more about that").

### 5.3 Watchers: build small, integrate optionally

A built-in watcher fetches a URL on a **Scheduler** job, extracts the target text (whole page via readability, or a CSS
selector the owner or the model picked), normalises whitespace and dates, hashes it, and notifies on change or when a
text appears. That covers "has this page changed" and "tell me when X appears" for static pages. For JavaScript-heavy
pages, integrate [changedetection.io](https://changedetection.io/docs/api_v1/index.html) (self-hosted, Playwright
fetcher, REST API for watches and tags, Apprise notifications): `watch_add` creates a watch there and a small webhook
or poll reads its change history. RSS feeds the household subscribes to can also act as watchers ("tell me when the
club posts something").

### 5.4 Other sections, by provider

| Section | Comes from | Notes |
|---|---|---|
| Weather | existing `weather` module (Open-Meteo) | needs a `briefing.section` export: "rain from 15:00" is a lead item |
| Agenda | [calendar](calendar.md) `calendar.window` | personal and household parts separately |
| Reminders, alarms, timers | timers/reminders modules, the Scheduler | "your alarm for tomorrow is set for 6:45" in the evening briefing |
| Mail, messages | [google](google.md) `mail.overview`, [messaging](messaging.md) inbox counts | personal; senders only |
| Commute | a commute module: NS Reisinformatie API (`public-reisinformatie/api/v2/departures`, key in header `Ocp-Apim-Subscription-Key`, free tier, per community clients **[unverified]**), or HA `waze_travel_time` | the owner's usual train or route per weekday |
| Deliveries | tracking numbers found in mail by the google/IMAP modules, or a parcel integration in HA **[provider choice open]** | "a PostNL parcel arrives between 14:00 and 16:00" |
| Bin day | an ICS feed through calendar, or HA `waste_collection_schedule` | the evening before is the useful moment |
| Running jobs, inbox | Scheduler `task` jobs and the Notification service inbox | "the heat-pump research is ready" |
| Home | home-assistant module | only anomalies: "the back door is open", never "all lights are off" |

## 6. Data

| What | Scope | Shape | Readable by |
|---|---|---|---|
| Briefing preferences | person (and a household default) | `{ sections: id[] (order), skip: id[], length, morningFrom: "06:30", scheduled?: { time, days, device }, presence: boolean }` | this module |
| Last briefing | person | `{ at, kind, sectionsSpoken[], resumeAt? }` (for "carry on" and "what did I miss" since) | this module |
| Feeds | household; person extras | `{ id, url, label, language, kind: "news" \| "bulletin" \| "watch", etag, lastItemAt }` | this module |
| Feed items | household | last 50 per feed: guid, title, summary, link, published; 3 days | `news_*` tools; other modules via `news.latest` |
| Watchers | person | `{ id, url, selector?, condition, every, lastHash, lastText, lastChangeAt, owner }` | this module |

All in the **Module store**.

## 7. Long-running work and events

- **Feed refresh** (**Scheduler**, `recurring`, every 15–30 min, at most one fetch per host per minute); missed while
  down: refresh at start.
- **Watcher checks** (per watcher, `recurring`, minimum 15 minutes, with jitter; back off on errors; stop and tell the
  owner after 3 days of failures).
- **Scheduled briefing** (`recurring` with `Cron` and the household time zone, e.g. weekdays 07:00): at due time it
  *prepares* the briefing (warms every section cache) and shows the cards on the target display; it speaks only if the
  device saw presence in the last few minutes or the person asked for spoken delivery. Missed by more than 30 minutes:
  skip (a stale morning briefing at noon is useless).
- **Presence trigger**: subscribes to the **Event bus** for device interaction (`lastInteractionAt` from
  [presentation §5.2](../module-investigation/presentation-and-device-capabilities.md)), alarm `acknowledged`, and HA
  presence or motion events; fires once per person per morning window.
- **Events emitted**: `briefing.ready` (cards prepared), `briefing.spoken`, `watch.changed`.

## 8. Presentation

On a screen the briefing is a **deck of cards**, revealed as each section is spoken
([presentation §3.6](../module-investigation/presentation-and-device-capabilities.md)): `weather` kind, agenda as
`list`, commute as `facts` (departure, platform, delay), news as `list` with tap-to-expand (a `say` action "more about
item 2"), mail counts as `facts` (`personal`). The current section's card is large; the rest stack as a strip. On an
`alwaysOn` kitchen display the morning cards stay **pinned** until 10:00 as the ambient stage, with the character small
in a corner ([presentation §4.4](../module-investigation/presentation-and-device-capabilities.md)). On a speaker, the
briefing is spoken section by section, each section one clause group so that barge-in, "skip" and "next" act on
section boundaries. On a speaker that can play audio, the news section may offer the broadcaster bulletin.

## 9. Notifications and proactive behaviour

- **Scheduled briefing**: delivered as described in §7; quiet hours suppress speech but not the cards.
- **Presence greeting**: at most one short line (the lead items) and an offer, never the full briefing unprompted
  (example 6).
- **Watchers**: `normal` notification to the watcher's owner on change; `low` (inbox) if the owner chose "just
  collect".
- **Evening**: optional `low` items ("bins tonight", "alarm set for 6:45") to the inbox and as an evening card.
- Never: a "nothing new" announcement.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | Household briefing sections and order | weather, household agenda, bins, news |
| Household | Morning window for presence triggers | 06:00–10:00 |
| Module | Feeds (records), bulletin source, watcher minimum interval, section timeout | starter feeds by language; 15 min; 800 ms |
| Assistant | Wording path (template / model), persona tone | template for scheduled, model on request |
| Device | Scheduled or presence briefing here; cards pinned until | off; 10:00 |
| Person | Sections, order, skip list, length, scheduled time and device, commute route, VIP senders (shared with google) | household default, `normal` |

No secrets in version 1 (feeds need none); a Guardian key, NS key or changedetection.io token go to the vault.

**First-run setup:** pick sections and order (drag list), pick feeds from a starter list or paste URLs, choose a
default length, optionally a scheduled time and device. "Preview" plays the briefing on the admin's device.

## 11. Native tools and dependencies

None for feeds and simple watchers (HTTP and an HTML parser such as `linkedom` plus a readability port inside the
module). Optional: a changedetection.io instance (LAN) for dynamic pages; the media module for bulletins. Missing
pieces degrade per section ("No news feeds are set up"; "I couldn't check the trains"); a watcher on a JavaScript-only
page says "That page needs a browser to read; the owner can connect changedetection.io for it."

## 12. Interaction with the rest of the system

- **Voice.** Sections are separate clauses; numbers and times go through the TTS normaliser ("8:12" → "twelve past
  eight"); the model pass is told the time budget. Feed headlines are often written for the eye (all caps,
  "LIVE:", emoji): strip them before speaking.
- **Fillers.** The template path needs none. The model pass speaks a canned greeting ("Morning, Ian.") immediately
  while sections gather, using the existing text-before-tool flush.
- **Interruption and steering.** Barge-in stops at once and stores `resumeAt`; "skip", "next", "stop", "more",
  "carry on" (and Dutch "volgende", "stop", "meer", "ga door") are recognised by the typed-intent path while a briefing
  is active, like the ringing window ([shared-state §8.4](../module-investigation/shared-state-jobs-and-notifications.md)).
- **Character.** During a briefing the stage uses the corner layout with cards; a `turn.activity` extension could make
  the character glance at each new card.
- **Assistants.** A template "Morning" is unnecessary; the briefing belongs to the main assistant. Wake routes:
  "good morning" as a phrase on the kitchen device bound to the main assistant is a natural owner choice, suggested
  but never added automatically.
- **Other modules.** Reads every module's `briefing.section`; the routines module can run "bedtime" with the evening
  briefing as one step.

## 13. Privacy and safety

- Sections declare `personal`. On a `shared` or `public` device the briefing includes personal sections only when the
  resolved person is the device's default person or chose themselves on the screen; otherwise the household briefing
  plus one sentence on how to get the personal part (example 9).
- Presence-triggered briefings never speak personal content, even on a private device, unless the person opted in.
- Watchers fetch only `http(s)` URLs, not private network addresses unless the owner allows LAN targets (a watcher is
  an outbound request the model can create; block `localhost`, link-local and the server's own ports).
- Feed and page text is untrusted: data, never instructions; "more about that" articles are truncated.
- Children: a kids' assistant gets weather, household agenda and a children's news feed if configured.

## 14. Foundations needed

Hard for on-request: **Tool context** (person and device) and other modules' section exports. For scheduled and
presence briefings: **Scheduler**, **Event bus**, **Notification service** (quiet hours), **Device capabilities**
(`privacy`, `alwaysOn`, presence). For cards: **Presentation**.

**Useful first version without them:** an on-request `briefing` tool that calls the existing weather tool, the calendar
module's read tool and an in-memory RSS cache refreshed by a scoped fiber, and returns sections for the model to
word. It works on any device today and is the core of everything else.

## 15. Open questions

1. Which sections, in which order, and how long should a normal morning briefing be (15 s, 30 s, a minute)?
2. Scheduled, presence-triggered, or only on request? If presence: may the kitchen speaker greet you unprompted?
3. News: which feeds or broadcasters, and do you prefer read headlines or a broadcaster's audio bulletin?
4. Wording: deterministic templates (fast, offline) or the language model (natural, slower, costs tokens) by default?
5. Commute and deliveries: which train or route, and is there a parcel source you already use (mail, HA, an app)?
6. Should watchers be built in, or should the household run changedetection.io?
7. **Disagreement with [landscape-automation §14](../module-investigation/landscape-automation-platforms.md):** it
   lists `feeds` as its own module. This document puts feeds and watchers inside `briefing` to start, with a
   `news.latest` export, and splits them out only if another consumer appears.
