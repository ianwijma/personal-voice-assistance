# Media requests

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md).
Outside facts carry inline links checked on this date. **[unverified]** marks a claim not confirmed against a primary
source. Latency figures are estimates to be measured with `TurnTrace`.

## 1. Summary

`media-requests` gives the household's self-hosted media stack a voice. It makes **requests** ("add the new season of
Severance") through Seerr, the merged Overseerr and Jellyseerr. It reports **status** ("is it downloaded yet") from
Sonarr, Radarr and the download client. It answers questions about **the library** ("what's new on the server"), watch
history and watchlists from Jellyfin and Trakt. It **picks something** ("something short and funny for tonight") from
TMDB metadata, filtered to what the household has or can stream. It tells the household **what's coming** in
low-priority notifications and briefing lines. On a screen it shows posters, details and trailers.

**Boundary with [video.md](video.md).** Video *plays* things: YouTube, Jellyfin and Plex playback, casting,
`video_continue` for resume, transcripts. This module *finds, requests and tracks* things and answers questions about
the library. "Play it" after a recommendation is a hand-off to `video_play` with the Jellyfin item id. A trailer is a
hand-off to video's YouTube player.

**Priority: later** for most households, **second wave** if the owner runs the stack (open question 1). It is pure
integration with no foundations of its own, and the read-only half works today.

**Effort: M.** Seerr search and request, *arr status and Jellyfin "what's new" are S each. Recommendations with TMDB,
the library filter and Trakt history are M. Webhook-driven notifications need the host hook endpoint.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| **Seerr** (Overseerr + Jellyseerr) | Merged into one project announced 2026-02-10, for Jellyfin, Plex and Emby ([blog](https://docs.seerr.dev/blog/seerr-release/)); v3.5.2 on 2026-11-12 ([releases](https://github.com/seerr-team/seerr/releases)). Overseerr was archived on 2026-02-15 ([repo](https://github.com/sct/overseerr)). Requests per user with permissions, quotas and approvals; it hands them to Sonarr and Radarr | Per-user permissions and auto-approve; one request path | Bypassing it with direct *arr writes |
| **Home Assistant** | `overseerr` integration (shown as "Seerr") since 2025.2, with actions `overseerr.search_media`, `request_media`, `get_requests` and an event entity for pending, approved, available, failed ([docs](https://www.home-assistant.io/integrations/overseerr)). Core also has sonarr, radarr, lidarr, qbittorrent, sabnzbd, transmission, jellyfin, plex and tautulli; no trakt ([components](https://github.com/home-assistant/core/tree/dev/homeassistant/components)) | Voice requests through HA's own assistant are possible already | It registers itself as Seerr's webhook, and **Seerr allows only one webhook** (same page) |
| **Ombi** | The older request front end, v4.53 stable ([releases](https://github.com/Ombi-app/Ombi/releases)) | — | A second provider for little gain |
| **Trakt** | Watchlist, history, scrobbling, recommendations, calendars; device-code login "best for TVs, media centers, CLI tools" ([auth guide](https://github.com/trakt/trakt-api/blob/HEAD/projects/developer/src/lib/guides/authentication-oauth.md)) | Device code flow for a headless server | Free-account limits (watchlist was capped at 100 in 2025, [AlternativeTo](https://alternativeto.net/news/2025/2/trakt-tv-has-set-stricter-limits-for-free-users-and-raised-vip-subscription-prices-by-100-); 2026 figures **[unverified]**) |
| **Google TV, Alexa** | "Add to my watchlist", "what should I watch" with streaming availability **[from memory]** | Recommendation answers that name *where* to watch | Upselling services the household has not got |
| **MCP** | A small Rust MCP server, `yarr`, covers Sonarr, Radarr, Prowlarr, Overseerr, qBittorrent, Plex and Jellyfin ([repo](https://github.com/dinglebear-ai/yarr), 17 stars) | Proof that the surface is small | Exposing indexers and torrent clients to a model |

## 3. Example conversations

S = a screen helps. Everything works headless.

1. "Hey Jev, add the new season of Severance." → `media_search` finds the show (TMDB 95396 **[id unverified]**), with
   season 2 available and season 3 announced → `media_request(seasons: "latest")` as Ian's Seerr user →
   "Requested season 3. It's not out yet; I'll tell you when it's ready to watch." S: a `card` with the poster.
2. "Is Slow Horses downloaded yet?" → `media_status` → Sonarr queue plus the download client → "Episode 4 is at 62
   percent, about eight minutes left. Episode 5 isn't out until Wednesday."
3. "What's new on the server?" → Jellyfin `Items/Latest` → "Since Sunday: *The Brutalist*, two episodes of
   *Andor*, and a new album by Fontaines D.C." S: a `gallery` of posters.
4. "Something short and funny for tonight." → `media_recommend(mood: "funny", maxMinutes: 100)` → TMDB discover for
   comedy (genre 35) under 100 minutes, kept to the library and unwatched by the people present → "*Game Night*, 100
   minutes, on the server, nobody's seen it. Or *What We Do in the Shadows*, 86 minutes, on Netflix." "The first one."
   → hand-off to `video_play` on the living room TV. S: a `gallery` with `pick`.
5. Ambiguous: "Add Dune." → three matches → with a screen, a `gallery` with `pick` of the 1984 film, the 2021 film and
   *Part Two*. Without a screen: "The 1984 film, the 2021 one, or Part Two? You already have the 2021 one."
6. "What's coming out this week?" → Sonarr and Radarr calendars for monitored titles → "Andor on Tuesday, the Severance
   finale on Friday, nothing new in films."
7. "Show me the trailer." (after example 4) → the YouTube key from TMDB videos **[endpoint unverified]** → hand-off
   to video's player on this screen. **S**
8. Refused, a child's device: "Add Deadpool." → Mia's Seerr user lacks auto-approve → "I've asked for it. A grown-up
   has to approve it in Seerr."
9. Failure: "Add the new Paddington film." → requested, but Radarr finds nothing for days → after 3 days a `low` note
   in the requester's inbox: "Paddington in Peru is requested but hasn't been found yet."
10. Failure: Seerr down → "The request server isn't answering, so I couldn't add it. I'll keep 'Severance season 3'
    on your list to try later?" "Yes." → a retry job.

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk (B.5) | Latency | Fast path |
|---|---|---|---|---|---|---|
| `media_search` | `query`, `type?: movie \| tv \| any`, `year?: number` | up to 5 matches: title, year, TMDB id, library status (available, partly, requested, none), seasons | R, speculative | read | 200–600 ms (Seerr `GET /search`) | no |
| `media_request` | `ref` (from search), `seasons?: "all" \| "latest" \| number[]`, `is4k?: boolean` | request id and status (pending, approved), what happens next | W | change | 200–800 ms | no |
| `media_status` | `title?: dynamic` (requests and queue), `scope?: queue \| requests \| both` | per item: requested, searching, downloading (percent, ETA), importing, available | R, speculative | read | 300 ms–1 s (fan-out to Seerr, Sonarr, Radarr, client) | yes ("is it done") |
| `media_whats_new` | `days? = 7`, `type?: movie \| episode \| album \| any`, `for?: dynamic` (person) | recently added items, grouped by show | R, speculative | read | 200–500 ms | yes |
| `media_upcoming` | `days? = 7`, `type?` | monitored episodes and films with air or release dates | R, speculative | read | 200–500 ms (`/api/v3/calendar`) | yes |
| `media_recommend` | `mood?: text`, `genres?: choice[]`, `maxMinutes?: number`, `type?`, `where?: library \| streaming \| any`, `for?: dynamic` (people present), `notSeen? = true` | 3 picks with a one-line reason each, runtime, where to watch | R | read (TMDB, history) | 0.8–2 s | no |
| `media_details` | `ref` | card data: overview, runtime, rating, cast, poster, where to watch | R, speculative | read | 200–500 ms | no |
| `media_watchlist` | `action: add \| remove \| read`, `ref?`, `person?` | the list or "added" | W for add and remove | change | 300 ms–1 s (Trakt) | no |
| `media_history` | `person?`, `days? = 14` | what was watched, from Jellyfin played state or Trakt | R | read (personal) | 300 ms | no |
| `media_cancel_request` | `request: dynamic` | "Cancelled." | W | change | 300 ms | no |

There are **no** tools for indexers, torrent or Usenet clients, manual release picks, or deleting files. Download
clients are read for progress only (§13).

## 5. Integrate or build

### 5.1 Requests: Seerr, not the *arr apps directly

| Option | Facts | Verdict |
|---|---|---|
| **Seerr API** | `{server}/api/v1`, default port 5055, auth `X-Api-Key`. `GET /search?query=`. `POST /request` takes `mediaType` and `mediaId` (TMDB id), with optional `seasons` (numbers or `"all"`) and `is4k`. `POST /request/{id}/approve`, `GET /request`, `/user/{id}/quota`, `/discover/watchlist` ([spec](https://github.com/seerr-team/seerr/blob/develop/seerr-api.yml)). `X-API-User: <userId>` with the admin key acts as that user, according to the source code rather than the spec ([auth.ts](https://github.com/seerr-team/seerr/blob/develop/server/middleware/auth.ts)). Users with `AUTO_APPROVE` (128) are approved on request, and new users default to `REQUEST` only ([permissions](https://github.com/seerr-team/seerr/blob/develop/server/lib/permissions.ts)) | **Yes.** Requests carry the right person, quota and approval rules, and Seerr already talks to Sonarr and Radarr |
| Sonarr / Radarr direct | Sonarr v4 stable (v4.0.20, 2026-09-16), with v5 in pre-release and a new `/api/v5` ([releases](https://github.com/Sonarr/Sonarr/releases)). Radarr v7 stable since 2026-11-16, still on `/api/v3` ([releases](https://github.com/Radarr/Radarr/releases)). `POST /api/v3/series` needs `qualityProfileId` and `rootFolderPath` ([Sonarr spec](https://github.com/Sonarr/Sonarr/blob/main/src/Sonarr.Api.V3/openapi.json)) | **Read only:** `/queue`, `/calendar`, `/history`, `/wanted/missing`. Write only through Seerr. Pin the API version per connection (automation landscape §13, mistake 5) |
| Via Home Assistant | `overseerr.request_media` and friends | Fallback if HA owns the Seerr webhook; adds a hop |
| Ombi | — | Skip |

### 5.2 Status: the *arr queues and the download client

- **Sonarr / Radarr queue** gives per-episode progress and state, which is usually enough.
- **qBittorrent** `GET /api/v2/torrents/info` (`progress` 0–1, `eta` in seconds). API keys exist since WebAPI 2.14.1,
  sent as `Authorization: Bearer` (qBittorrent 5.2+) ([changelog](https://github.com/qbittorrent/qBittorrent/blob/master/WebAPI_Changelog.md)).
- **SABnzbd** `api?mode=queue&output=json` (`timeleft`, `slots[].percentage`) ([API](https://sabnzbd.org/wiki/configuration/5.0/api)).
- **Transmission** switched to JSON-RPC 2.0 with snake_case names (`torrent_get`, `percent_done`) in 4.1.0
  ([spec](https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md)).

**Recommendation:** read the *arr queue first and the client only for ETA. The client adapter is optional and read-only.

### 5.3 Library: Jellyfin first, Plex second

- **Jellyfin is on 12.x** (12.0 released 2026-09-08). Legacy auth headers are off by default; use
  `Authorization: MediaBrowser Token="…"` ([12.0](https://github.com/jellyfin/jellyfin/releases/tag/v12.0),
  [PR 15559](https://github.com/jellyfin/jellyfin/pull/15559)).
- **Endpoints** take `userId` as a query parameter: `GET /Items/Latest?userId=&includeItemTypes=&groupItems=`,
  `GET /Items?userId=&sortBy=DateCreated&isPlayed=false`, `GET /UserItems/Resume`, `GET /Shows/NextUp`
  ([OpenAPI](https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json)). `GetItems` behaves differently from
  10.11 with filters, so test against 12.
- **The Jellyfin webhook plugin** (v22) sends `ItemAdded` and playback events
  ([plugin](https://github.com/jellyfin/jellyfin-plugin-webhook)).
- **Plex:** `X-Plex-Token`, `/hubs/home/recentlyAdded` ([docs](https://developer.plex.tv/pms/)). The watchlist via
  `discover.provider.plex.tv` is documented only by python-plexapi.
- **Code sharing:** video.md already plans a Jellyfin adapter. **Share one `packages/media-jellyfin` adapter** between
  the two modules, through a provider interface (`library.latest`, `library.search`, `library.played`).

### 5.4 Metadata and recommendations: TMDB

- **Auth:** the API Read Access Token as `Authorization: Bearer`. Rate limit "roughly 40 per second"
  ([auth](https://developer.themoviedb.org/docs/authentication-application),
  [limits](https://developer.themoviedb.org/docs/rate-limiting)).
- **`/discover/movie`** with `with_genres=35`, `with_runtime.lte=100`, `vote_count.gte=200`,
  `sort_by=vote_average.desc`, `with_watch_providers` plus `watch_region=NL`, and
  `with_watch_monetization_types=flatrate` ([reference](https://developer.themoviedb.org/reference/discover-movie)).
  `/trending/movie/week`.
- **Watch providers** must credit JustWatch, or access can be revoked
  ([providers](https://developer.themoviedb.org/reference/movie-watch-providers)).
- **Images** are at `https://image.tmdb.org/t/p/w500/<path>`, proxied through `/media/`.
- **Terms:** free for non-commercial use with the TMDB logo and its notice ([FAQ](https://developer.themoviedb.org/docs/faq)).

**The recommender is ours and small.** A fixed table ("funny", "scary", "for the kids") or one model call turns the
mood into genres and a runtime. TMDB discover gives about 40 candidates. They are intersected with the Jellyfin library
(by TMDB provider id) and the household's streaming services, and anything the people present have watched is dropped
(Jellyfin played state, Trakt history). The rest is ranked by rating with a bonus for recency or the watchlist, and
the model writes one reason for each of three picks.

Trakt's `/recommendations/movies` is an optional extra signal, not the engine.

### 5.5 Trakt

- **Headers:** `trakt-api-key`, `trakt-api-version: 2` and a User-Agent
  ([headers](https://github.com/trakt/trakt-api/blob/HEAD/projects/developer/src/lib/guides/required-headers.md)).
- **Login:** the device code flow, `POST /oauth/device/code`, then poll `/oauth/device/token`. The server shows the code
  on a screen or speaks it, which fits the Connection foundation's device-code path.
- **Limits:** 1 write per second and 500 GETs per 5 minutes. A 420 means an account limit was hit
  ([limits](https://github.com/trakt/trakt-api/blob/HEAD/projects/developer/src/lib/guides/rate-limiting.md),
  [account](https://github.com/trakt/trakt-api/blob/HEAD/projects/developer/src/lib/guides/user-account-limits.md)).
- **Verdict:** a per-person optional Connection. Jellyfin's played state is enough for most households.

### 5.6 Books and music

Readarr is retired: its repository was archived on 2025-06-27 after its metadata source failed
([wiki](https://wiki.servarr.com/readarr)). Bookshelf is an active fork ([repo](https://github.com/pennydreadful/bookshelf)).
Lidarr is on `/api/v1` ([spec](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/openapi.json)).
**Not in the first version.** Music requests belong next to [music.md](music.md) if anyone asks.

## 6. Data

| Where | Scope | Content |
|---|---|---|
| settings | household | connections: Seerr, Sonarr, Radarr, download client, Jellyfin or Plex, TMDB token (vault references); household streaming services and region; default 4K off |
| settings (person layer) | person | Seerr user id, Jellyfin user id, Trakt Connection |
| Module store `pendingRequests` | person | requests made by voice: Seerr request id, title, requested at, last state; feeds "available" announcements and retries |
| Module store `tmdbCache` | household | discover and details responses, 24 h; images through `/media/` |
| Module store `lastResults` | conversation | for "the first one", "the trailer" |
| Module store `watches` | person | "tell me when it's out" items that are not requests (a cinema release) |

Exports: `media.upcoming(days)` and `media.newSince(time)` for [briefing.md](briefing.md); `media.lastPick` for
video's hand-off.

## 7. Long-running work and events

- **Inbound webhooks** through the host hook endpoint ([notifications.md](notifications.md) §7), each bound to this
  module:
  - Seerr's webhook agent, with notification types `MEDIA_AVAILABLE` (8), `MEDIA_APPROVED` (4), `MEDIA_FAILED` (16)
    and `MEDIA_DECLINED` (64), and a JSON template with `{{media_tmdbid}}`, `{{request_id}}` and
    `{{notifyuser_username}}` ([agent](https://github.com/seerr-team/seerr/blob/develop/server/lib/notifications/agents/webhook.ts));
  - Sonarr and Radarr Connect webhooks (`Grab`, `Download`, `ManualInteractionRequired`, `Health`)
    ([Sonarr](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Notifications/Webhook/WebhookEventType.cs));
  - Jellyfin's `ItemAdded`.
- **Fallback when the webhook is taken** (HA owns Seerr's single slot): a `recurring` job polls `GET /request` every 10
  minutes for the voice-made requests only.
- **Retries:** example 10's retry is a `deferred command` job, three attempts over an hour.
- **Weekly:** a `recurring` job on Monday morning collects upcoming episodes for the briefing.
- **Events published:** `media.request.created`, `media.available`, `media.download.stuck`. **Listens to:**
  `video.playback.changed`, to drop "unwatched" picks once playing starts.
- **Restart:** all state is in the store; webhooks missed while down are covered by one poll at start.

## 8. Presentation

- **Search and recommendations:** a `gallery` with `pick` of posters with title, year, runtime and a status badge
  (On the server, Requested, On Netflix). The character "holds up" the first pick as the voice names it (presentation
  §3.6).
- **Details:** a `card` with poster, overview, rating, runtime, cast and where to watch. Footer: "Data from TMDB";
  "Streaming data from JustWatch" when providers are shown.
- **Status:** a `progress` per downloading item; a `list` for the request queue.
- **Upcoming:** a `list` grouped by day. A `table` only for a full week on a large screen.
- **Trailer:** hand-off to video's `video` kind and Theatre layout ([video.md](video.md) §8).
- **Headless:** at most three items spoken, each with one fact ("100 minutes, on the server"). The rest: "and four
  more; they're on the kitchen screen" when one is near.

## 9. Notifications and proactive behaviour

- **Available:** "*Severance* season 3 episode 1 is ready to watch." Priority `normal`, to the *requester* (person
  audience), on their devices when idle, else the inbox. Several in one hour are batched. This takes over video.md §9's
  "a new episode is on Jellyfin" notification (open question 3).
- **Failed, declined or not found after 3 days:** `low`, inbox of the requester.
- **Stuck download** (`ManualInteractionRequired`, a health warning): `low`, owner's inbox only.
- **Upcoming:** never spoken alone. A line in the morning briefing on the release day, opt-in per person.
- Nothing during quiet hours; nothing on devices in `public` places.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | streaming services owned and the region (for `where`); kids' certification ceiling; announce availability | none, `HOME_LOCATION` country; household kids policy; on |
| Module | connections; default quality and 4K (off); results per answer (3); recommendation pool size (40); poll interval if no webhook (10 min) | as stated |
| Assistant | may request (on); may read history (off for shared assistants) | as stated |
| Device | may request (off for `public` places); show posters | on; on |
| Person | Seerr user, Jellyfin user, Trakt Connection; announce my requests; include me in "unwatched" | —; on; on |

**First run:** enter the Seerr URL and API key → **Test** lists Seerr users → map household people to Seerr and
Jellyfin users → optionally add the Sonarr and Radarr keys for status and the TMDB token for recommendations → copy
the hook URL into Seerr's webhook agent.

## 11. Native tools and dependencies

None: HTTP only, npm `fetch`. Every service is an optional dependency with a probe: Seerr `GET /api/v1/status`, *arr
`GET /api/v3/system/status`, Jellyfin `GET /System/Info/Public`. Each tool degrades on its own:

- without Seerr: "I can't add things; the request server isn't set up";
- without Sonarr and Radarr: no download progress, only Seerr's state;
- without a TMDB token: recommendations from the library alone ("something short and funny" filters Jellyfin by genre
  and runtime).

## 12. Interaction with the rest of the system

- **Voice.** Titles are the hard part: "Severance" is fine, but "Andor" may come out as "and or" and "Shōgun" as
  "show gun". Search runs on the transcript and its phonetic variants; the reply says the title back ("Requested
  *Andor* season 2"). Season numbers come through `NumberWords`. "The new season" means the latest *announced* season
  that is not available. Say which one, as in example 1. Filler: "Let me check the server" for `media_status`.
- **People present.** "Unwatched" needs to know who is watching. It uses the device's default person, plus "with Sam"
  in the request ("something for me and Sam").
- **Fast path.** `media_status` and `media_whats_new` take few parameters and are good Jev actions. Requests go
  through the model, because the title needs search.
- **Assistants.** An optional "Film night" assistant template: a warm, brief persona with `media-requests`, `video`
  and the smart-home "movie mode" routine. General assistants get the read tools.
- **Other modules.** [video.md](video.md) (play, trailers, shared Jellyfin adapter); [briefing.md](briefing.md)
  (upcoming, new since yesterday); [notifications.md](notifications.md) (hooks, available); routines (film-night
  routine); [automation-platforms.md](automation-platforms.md) (households that already wire Seerr into n8n).

## 13. Privacy and safety

- **Piracy line.** Sonarr and Radarr describe themselves as tools "for Usenet and BitTorrent users"
  ([Sonarr](https://github.com/Sonarr/Sonarr)), and Prowlarr lists public torrent indexers
  ([wiki](https://wiki.servarr.com/prowlarr/supported-indexers)). Where the files come from is the household's own
  responsibility. This module never searches indexers, picks releases or talks to a torrent client beyond reading
  progress. Trakt's API terms forbid use in apps "that promote copyright infringement or piracy"
  ([create an app](https://github.com/trakt/trakt-api/blob/HEAD/projects/developer/src/lib/guides/create-an-app.md)).
  The Trakt connection therefore stays limited to history and watchlists.
- **Requests act as a person.** Seerr's per-user permissions, quotas and approvals are the policy. A guest or a
  `public` device has no Seerr user and cannot request.
- **Watch history is personal.** `media_history` and Trakt data are not spoken or shown on `shared` devices unless the
  person asked on their own device. "What did Sam watch?" is refused for anyone but Sam and the owner.
- **Children:** recommendations obey the household certification ceiling (TMDB `certification_country` and
  `certification.lte` **[parameter names unverified]**). Requests from a child's Seerr user need approval.
- **Disk and bandwidth:** 4K and "all seasons" of long shows are confirmed by repeating the size of the request ("all
  14 seasons of Grey's Anatomy?"). This is a spoken check in the module, not a core confirmation.

## 14. Foundations needed

Tool context and `Person` records (who requests, who is watching), Module store (pending requests, cache), host hook
endpoint and Event bus (Seerr and *arr webhooks), Notification service (available), Scheduler (polling fallback,
retries), Presentation (`gallery`, `card`, `progress`, `list`), Connection (Trakt device code), Requirements and
health (probes).

**A useful first version without most of them:** `media_search`, `media_request` with one fixed Seerr user,
`media_status` from Seerr plus the *arr queues, `media_whats_new` from Jellyfin, `media_upcoming`. All of them are
spoken only, with settings for URLs and keys. No notifications yet: "is it ready?" is asked, not announced.

## 15. Open questions

1. **Do you run this stack?** Which pieces: Seerr, Sonarr, Radarr, which download client, Jellyfin or Plex? Without
   it, the module is skipped and only TMDB recommendations over Jellyfin remain.
2. **Seerr's single webhook:** if HA's Seerr integration is in use, it holds the only webhook slot. Poll from our side,
   go through HA's event entity, or move the webhook to us?
3. **Disagreement with video.md §9,** which sends "a new episode is on Jellyfin" itself. This document proposes that
   media-requests owns all arrival notifications (they come from Seerr, *arr and Jellyfin webhooks), and that video
   only plays. Agreed?
4. **Per-person Seerr users,** or one household user for everyone with names in the request comment?
5. **Trakt at all,** given its free-account limits and VIP-gated methods (HTTP 426)? Jellyfin's played state covers
   "unwatched" for the household.
6. **Recommendations beyond the library:** may it suggest streaming titles, and which services do you have?
7. **Kids:** may a child's request go straight to Seerr as pending, or should the assistant refuse and tell a parent?
