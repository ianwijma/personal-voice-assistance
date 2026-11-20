# Video

Research write-up, 2026-11-17. Not an approved design. Outside facts carry inline links checked on this date; claims
marked **[unverified]** come from memory or a secondary source. Latency figures are estimates to be measured with
`TurnTrace`.

## 1. Summary

`video` puts YouTube and the household's own video library on the screens in the house. It plays on the tablet that
heard the request, or casts to a TV. It also answers "what is this video about?" from a transcript without anyone
watching. The owner's model is "a Google Assistant with a screen, I can play YouTube".

- **Priority: second wave**, after music and the first Presentation kinds. It has the same ducking and wake problems
  as music, so it reuses what [music.md](music.md) builds.
- **Effort: M** for YouTube in the page plus casting through Home Assistant. **L** with Jellyfin in-page playback and
  transcript summaries.
- The legal line decides the design. YouTube may only be played through YouTube's own player, visibly. Everything
  else (audio only, downloads, background play) is against its terms.

## 2. What others do

| System | Behaviour | Copy | Avoid |
|---|---|---|---|
| Google Nest Hub | YouTube on the hub; "play X on the living room TV" casts; music videos for song requests ([landscape](../module-investigation/landscape-voice-assistants.md) §2) | The two targets: "here" and "the TV" | — |
| Echo Show | Prime Video, Netflix and web browsing; YouTube only through a browser after a dispute ([landscape](../module-investigation/landscape-voice-assistants.md) §1) **[detail unverified]** | — | Depending on a platform that can pull access |
| Home Assistant | Cast, Android TV Remote, Kodi, webOS and Jellyfin as `media_player` entities; `media_player.play_media`; Assist pause/resume/next on them ([landscape](../module-investigation/landscape-voice-assistants.md) §4) | Casting through HA: one call for every TV brand | — |
| OVOS | OCP plays YouTube through yt-dlp-style extractors ([landscape](../module-investigation/landscape-voice-assistants.md) §5) | — | Breakage every time YouTube changes, and terms violations |
| Leon | "Video summariser and translator" native skill ([landscape](../module-investigation/landscape-voice-assistants.md) §8) | Summaries as a first-class use | — |
| Gemini app | Answers questions about a YouTube link **[from memory]** | "Watch it for me" | — |

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | Kitchen tablet: "Hey Jev, show me how to fold a fitted sheet." → "Here's a two-minute one from Martha Stewart." The video plays, and the character moves to a corner. | **yes** |
| 2 | (video playing) "Hey Jev, pause." → it pauses at once; a cue, no speech | yes |
| 3 | "Put the latest Veritasium on the living room TV." → "Playing *Why…* on the living room TV." | the TV, not the asker |
| 4 | Kitchen speaker, no screen: "Play the Tiny Desk concert by Anderson .Paak." → "I can't play videos on this speaker. I can put it on the kitchen tablet, or play the album on Spotify. Which?" | no (an offer) |
| 5 | "What's this video about?" (a link shared earlier, or the one playing) → after about 5 s: "It's a 22-minute review of three heat pumps. The verdict: the Daikin is quietest, the Mitsubishi cheapest to run." | no |
| 6 | "Continue the series we were watching." → Jellyfin resume: "Episode 4 of *Slow Horses*, from 31 minutes, on the living room TV." | the TV |
| 7 | Ambiguous: "Play Frozen." → with a screen, a `gallery` with `pick`: the film (Jellyfin), "Let It Go" (YouTube), the soundtrack (music). Without a screen: "The film, the song, or the soundtrack?" | optional |
| 8 | Failure: "Play it on the bedroom TV." → "The bedroom TV is off and I can't turn it on. Shall I play it here?" | — |
| 9 | Failure (quota): "Find a video about sourdough." → "I've used up today's YouTube searches. I can still play videos you name exactly, or show it on the TV's YouTube app." | — |

## 4. Tools

Risk classes as in [music.md](music.md) §4: safe, changes, costly.

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `video_search` | `query`, `source?: youtube \| jellyfin \| plex`, `duration?: short \| medium \| long`, `limit? ≤ 8` | items with id, title, channel, duration, thumbnail; a `gallery` Presentation | R | safe (uses quota) | 300–800 ms | no |
| `video_play` | `query? \| itemId`, `where?` ("here", a TV, a room), `startAt?: seconds \| "resume"` | what plays where; a `video` Presentation on the device | W | changes | 0.5–3 s (casting is slow) | yes for "resume" |
| `video_control` | `action: pause \| resume \| stop \| seek \| skip-back \| skip-forward \| captions-on \| captions-off`, `seconds?`, `where?` | new state | W | changes | 50 ms in the page, 0.3–1 s cast | **yes** |
| `video_volume` | `level? \| change?`, `where?` | level | W | changes | as above | **yes** |
| `video_now_playing` | `where?` | title, channel or show, position | R | safe | < 200 ms | yes |
| `video_cast_targets` | none | TVs and cast devices with on/off state, from HA | R | safe | < 100 ms (cached) | no |
| `video_summarise` | `itemId? \| url? \| "current"`, `focus?: string` | summary text, chapter list, source of the transcript | R | costly (model tokens; may run a long job) | 3–30 s; long videos as a Scheduler task | no |
| `video_continue` | `show?` | the resume item from Jellyfin or Plex | R | safe | 200–600 ms | yes |

## 5. Integrate or build

### 5.1 YouTube

| Option | Facts | Verdict |
|---|---|---|
| **IFrame Player API in the voice page** | The official embeddable player, controlled from JS: `loadVideoById`, `pauseVideo`, `setVolume`, `seekTo`, `onStateChange` **[API names from memory]**. The YouTube API Services Developer Policies forbid modifying, building upon or blocking "any portion or functionality of a YouTube player" (III.I.6). They forbid obscuring player links (III.I.4) and attribution (III.F.2.c), separating "the audio or video components" (III.I.7), and playing from "a background player … not displayed in the page, tab, or screen that the user is viewing" (III.I.9) ([policies](https://developers.google.com/youtube/terms/developer-policies)). A cross-origin iframe needs `allow="autoplay; encrypted-media"`. | **Yes.** It is the only allowed way to play YouTube in our page. |
| **YouTube Data API v3** for search | Default quota: **100 `search.list` calls a day**, 100 `videos.insert`, and 10,000 units for everything else. A read usually costs 1 unit, and more can be requested through a quota-extension form ([getting started](https://developers.google.com/youtube/v3/getting-started)). Useful `search.list` parameters: `q`, `type=video`, `videoEmbeddable=true`, `safeSearch=strict \| moderate \| none`, `videoDuration`, `regionCode`, `relevanceLanguage` **[from memory]**. An API key lives in the vault; no OAuth is needed for public search. Policy III.E.1 forbids storing copies of audiovisual content; caching API *data* has its own refresh limits **[unverified: the 30-day rule]**. | **Yes.** Cache each query's results for a day in the Module store; 100 searches a day is plenty for a household. |
| **yt-dlp + mpv** (headless, or on a box by the TV) | Works without a key. But YouTube now needs an external JavaScript runtime (Deno by default; Node ≥ 22 with `--js-runtimes node`) to solve its challenges ([yt-dlp EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS)). It breaks when YouTube changes and needs frequent updates (see [dependencies](../module-investigation/module-definition-config-and-dependencies.md) §C.6). It violates III.E.1 (download or cache) and III.I.7/9 (audio only, background) for YouTube. | **Not for YouTube by default.** At most an opt-in, owner-labelled "unsupported" provider. Fine for sites whose terms allow it (PeerTube, a public-domain archive). |
| **Invidious / Piped** front ends | Unofficial proxies of YouTube; instances come and go **[unverified: current state]** | Skip |
| **The TV's own YouTube app via cast** | HA's Cast integration can start the YouTube app with `media_content_type: cast` and `media_content_id: '{"app_name": "youtube", "media_id": "<videoId>"}'` **[from memory: HA cast docs]**. Android TV Remote in HA can open a `https://www.youtube.com/watch?v=…` URL **[unverified]**. | **Yes** for TVs. It is YouTube's own app, so the terms are YouTube's problem, not ours. |

### 5.2 Casting and TVs

| Target | Path | Notes |
|---|---|---|
| Chromecast, Google TV | HA `cast` → `media_player.play_media`; direct `castv2-client` from Node as an alternative **[unverified: maintenance]** | HA first: no mDNS from our server needed |
| Android TV, Fire TV | HA `androidtv_remote` / `androidtv` | Launch app or URL; transport via the remote |
| LG webOS, Samsung | HA `webostv`, `samsungtv` | Mostly transport and app launch |
| DLNA renderers | HA `dlna_dmr` with a URL | For Jellyfin or local files, not YouTube |
| Kodi | HA `kodi`, or Kodi JSON-RPC `Player.Open` | Plays Jellyfin or local files; YouTube via its add-on |

**Recommendation:** every TV goes through HA `media_player` entities. Turning a TV on (`media_player.turn_on`) is
often impossible over the network: CEC, Wake-on-LAN and vendor quirks. The tool must report "off" honestly (example 8).

### 5.3 Jellyfin and Plex

- **Jellyfin.** REST with an API key. `GET /Users/{userId}/Items/Resume` for "continue". `GET /Items?searchTerm=…`.
  Remote control through `GET /Sessions` and `POST /Sessions/{id}/Playing?playCommand=PlayNow&itemIds=…`. In-page
  playback via HLS `/Videos/{id}/master.m3u8` with `hls.js` where the browser has no native HLS **[from memory]**.
  **Integrate.**
- **Plex.** `X-Plex-Token`, `/library/search`, `/hubs/continueWatching`. Remote control of Plex clients goes through
  the companion protocol and is fragile **[unverified: current state]**. Integrate search and resume. Casting only via
  HA's Plex `media_player`.

### 5.4 "Watch it for me": summaries

| Transcript source | Facts | Verdict |
|---|---|---|
| YouTube captions via the Data API | `captions.download` needs OAuth and edit rights on the video **[from memory]**, so not for other people's videos | No |
| yt-dlp `--skip-download --write-auto-subs --sub-format json3` | Fetches only the caption track, not the audiovisual content. Still unofficial access, with the same breakage as §5.1 | Opt-in, labelled |
| Gemini API with the YouTube URL as input | Google's own path for public videos **[unverified: current limits and pricing]**; adds a second model account | Good fallback if the owner adds a Gemini key |
| Local transcription of downloaded audio | sherpa-onnx is already here. But this downloads YouTube audio (III.E.1) and costs minutes of CPU for a long video | Only for Jellyfin and local files |
| Jellyfin subtitles | `GET /Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.vtt` **[from memory]** | Yes |

Sizes: a 20-minute talk is about 3,000 words of transcript, roughly 4,000 tokens: well within one Claude call. Over
about 90 minutes, chunk and summarise in a Scheduler `task`, and report back with a `result` notification.

## 6. Data

Kept in the Module store.

| Collection | Scope | Schema | Others read? |
|---|---|---|---|
| `searchCache` | household | `{ query, source, results[], fetchedAt }`, kept 24 h | no |
| `quota` | household | `{ day, searchCalls }`, to say "used up" before Google does | no |
| `castTargets` | household | `{ entityId, name, room, kind, supportsYoutube }`, from HA, refreshed every 60 s | yes (`exports`) |
| `nowPlaying` | device | `{ itemId, source, positionS, state, target }` | yes (ambient fact) |
| `summaries` | household | `{ itemId, source, transcriptSource, summary, chapters, createdAt }`, 30 days | yes (`exports`) |
| `lastResults` | conversation | for "the second one" | no |

## 7. Long-running work and events

- **Scheduler** `task` for long summaries: at most one at a time, cancellable ("stop summarising"). After a restart it
  is reported "interrupted by a restart" ([shared-state](../module-investigation/shared-state-jobs-and-notifications.md) §6.1).
- **Events** published: `video.playback.changed { deviceId \| target, state, item }`, shared with the media guard in
  [music.md](music.md) §12. Also `video.summary.ready`.
- **Events** consumed: `notification.ringing` (pause in-page video while a timer rings), `music.playback.changed`
  (starting a video "here" pauses music "here").
- **Restart**: in-page video keeps playing while the socket reconnects. Cast playback is independent of us.

## 8. Presentation

The Presentation catalogue has no `video` kind ([presentation-and-device-capabilities.md](../module-investigation/presentation-and-device-capabilities.md) §3.2); `media` is a now-playing card.

- **Proposed new kind:** `{ kind: "video", v: 1, provider: "youtube" | "jellyfin", ref, startAt?, title }`. The
  device renders the provider's player: the YouTube IFrame, or `<video>` with HLS from the server proxy.
  - Lifetime `task`; it ends when the video ends or is dismissed.
  - Fallback: a `card` with the thumbnail and a `handoff` QR code.
  - `present.update` carries server-initiated control (pause, seek).
- **Layout: a new "Theatre" layout.** The video takes the stage at 16:9.
  - The character shrinks to a small badge in the corner farthest from the player's controls. The Companion layout's
    corner perch is the model.
  - **Nothing of ours is drawn over the YouTube player rectangle**, because of III.I.4 and III.I.6. Captions,
    toasts and the character sit outside it. On a 16:9 tablet that means letterbox bars or a slightly smaller player.
- **Speaking during a video.** On the wake phrase the page ducks the player (`setVolume`, or the `<video>` element's
  volume) and the character grows back to Hold-up size beside the player. It shrinks again after the reply.
- "Pause" pauses instead of ducking. Barge-in and Stop never stop the video: Stop is for speech (Presentation §3.6
  rule 5).
- **Tab hidden or screen off:** pause the YouTube player. III.I.9 forbids a background player, and the page knows
  through Page Visibility (`DeviceLiveState.visible`).
- **Search results:** a `gallery` with `pick` of thumbnails, title and duration. Thumbnails pass through `/media/`
  like any image. Do YouTube thumbnails count as "content" under III.E? **[unverified]**
- **The character watching**: with the `stage.content` extension, a figure glances at the video now and then and
  looks at the person when spoken to. It is calm, and makes no comments.
- **Without a screen** ([Device capabilities](../module-investigation/presentation-and-device-capabilities.md) §6.1): "video" is inherently visual. The reply is one short refusal, a one-line description, and
  one offer: the best screen (§6.2 of that document), or the same work as audio from a music provider (example 4).
  Never YouTube audio alone.

## 9. Notifications and proactive behaviour

- `normal` (opt-in per person): "A new episode of *Slow Horses* is on Jellyfin", inbox and badge only.
- `result`: "Your summary of the heat pump video is ready", spoken on the origin device when idle
  ([shared-state](../module-investigation/shared-state-jobs-and-notifications.md) §8.6), with a follow-up window ("read it to me").
- Nothing else unprompted.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | safe search level (`strict` / `moderate`); default TV per room; allow unofficial extractors (off) | `moderate`; off |
| Module | YouTube Data API key (vault); Jellyfin URL and key; Plex URL and token; Gemini key for summaries (optional); daily search budget | — ; 90 |
| Assistant | may play video; may summarise (token cost) | yes; yes |
| Device | plays video itself (needs a display); default cast target; pause when hidden (fixed on for YouTube) | from capabilities |
| Person | own Jellyfin user; safe-search override (stricter only) | household |

First-run setup:

1. Create a Google Cloud project, enable YouTube Data API v3, and paste the key.
2. Confirm the TVs discovered through HA and their rooms.
3. Optionally connect Jellyfin.

## 11. Native tools and dependencies

| Need | Where | Missing → spoken |
|---|---|---|
| A browser with a display | the screen device | "I can't play videos on this speaker." plus an offer |
| YouTube Data API key | vault | "YouTube search isn't set up. I can still play videos on the TV's YouTube app." |
| Home Assistant with TV integrations | LAN | "I can't reach the TVs right now." |
| `hls.js` (npm, bundled in the web app) | the screen device | none: bundled |
| `yt-dlp` + Deno (opt-in only) | server | "Transcripts aren't available for this video." |
| `ffmpeg` (Jellyfin transcoding is Jellyfin's) | — | not needed |

## 12. Interaction with the rest of the system

- **Voice.**
  - Titles are long and messy, so search is fuzzy and the reply names the pick ("a two-minute one from Martha
    Stewart").
  - Channel names are often mis-heard; prefer `channelTitle` matching with one edit of tolerance.
  - Filler: "Let me find one" is spoken during `video_search`.
- **Wake while a video plays.** This is the same media guard as music: phrase required on that device and in that
  room. Videos talk, and talk becomes turns. Echo cancellation of the iframe's audio is unknown; measure with the
  echo test ([UI-AND-MODULES.md](../../UI-AND-MODULES.md) §5).
- **Fast path.** `video_control` and `video_volume` are actions with examples ("pause", "go back ten seconds",
  "turn on subtitles") for Jev and the control matcher of [assistant-controls.md](assistant-controls.md) §5, as in
  [music.md](music.md) §12. The same words control
  whichever of music or video is playing on or near the device. Video wins when it is visible.
- **The character.**
  - A Theatre layout and a badge state. "Watching" is not a mode: the character is `idle`, and size and placement
    carry it.
  - Any new mode needs a reason a person would care ([CHARACTERS.md](../../CHARACTERS.md) §4.3). This one has none.
- **Assistants.** No template of its own. General assistants get it; a kids' assistant gets it with `safeSearch=strict`
  and a channel allowlist ([fun-and-ambient.md](fun-and-ambient.md)).
- **Other modules.** Music (shared transport words, audio alternatives); Home Assistant (TVs); images (the `gallery`
  kind).

## 13. Privacy and safety

- YouTube search queries go to Google under the household's API key. They are not tied to a person's account unless
  OAuth is added later, which this design avoids.
- Children: `safeSearch=strict` is a filter, not a guarantee. A kids' device should use a channel or playlist
  allowlist (household setting), with search off.
- Watch history: none is stored beyond `nowPlaying`. Jellyfin keeps its own per user.
- Casting to a TV in another room is visible to the people there. Refuse to cast to a device in a room marked
  `private` unless the speaker is that room's person.

## 14. Foundations needed

- Presentation (with the new `video` kind and the Theatre layout), Device capabilities (display, visibility), and
  Tool context (which device asked).
- Module store (cache, quota), Scheduler (summary tasks), Notification service (`result`), and Event bus (media
  guard).
- **A first version without them:** casting only. Tools call HA `media_player.play_media` on TVs (YouTube app via
  cast) and Jellyfin sessions, with no in-page player. Summaries only for Jellyfin subtitles. That works today with an
  extended HA module and a TV list in settings.

## 15. Open questions

1. **Add a `video` kind and a Theatre layout to the Presentation catalogue**, or keep video on TVs only?
2. **Unofficial extractors** (yt-dlp for transcripts or headless playback): never, or opt-in with a warning? Default:
   never for playback; opt-in for transcripts only.
3. **Gemini for "watch it for me"?** It adds a second model account and Google sees the video IDs. The alternative is
   no YouTube summaries.
4. **Kids and YouTube:** allowlist only, or search with `strict`?
5. **TVs that cannot be turned on over the network:** is "it's off" acceptable, or should HA scripts (CEC through a
   Pi, an IR blaster) be configured per TV?
6. **Thumbnails through `/media/`:** is proxying YouTube thumbnails acceptable under the policies, or should the
   `video` kind's gallery load them straight from `i.ytimg.com`? That would break the Presentation document's
   `img-src 'self'` rule.
