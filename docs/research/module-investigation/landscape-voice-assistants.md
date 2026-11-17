# Landscape: existing voice assistants

Research for the module investigation. Question: which capability bundles ("modules") do existing voice assistants offer, how they structure them, how they behave across a household of devices, and what goes wrong. Written 2026-11-17 from web sources; inline links are the evidence. "Unverified" marks claims that rest on one weak source or on memory that was not re-checked.

Our current modules, for reference: `clock`, `weather`, `demo-home` (in `packages/modules-builtin`) and `home-assistant` (`packages/module-home-assistant`). A module contributes tools, per-turn context and stable instructions; UI contributions are status lines only, richer cards are deferred (`docs/UI-AND-MODULES.md` §1.1, §1.9).

## Summary

- **What people actually use is short and stable.** Across every survey since 2017 the top uses of smart speakers are music, quick questions, weather, timers/alarms and smart-home control. Third-party voice apps never became a habit: only 48% of owners had ever used one in 2020, and usage was flat ([Voicebot 2020](https://voicebot.ai/2020/05/03/streaming-music-questions-weather-timers-and-alarms-remain-smart-speaker-killer-apps-third-party-voice-app-usage-not-growing/)). Early Alexa+ users still mostly use timers, smart home, schedule checks, music and lookups ([SmartScope, secondary](https://smartscope.blog/en/blog/alexa-us-daily-use-cases-everyday-prompts-early-2026/)).
- **The 2025–2026 LLM migrations broke the basics.** Alexa+ (US-wide February 2026) and Gemini for Home (rolling out since October 2025) both drew reports of slow timers, lost lists, wrong-room actions and 10–40 second silences ([Spyglass](https://spyglass.org/broken-alexa-plus.md), [PiunikaWeb](https://piunikaweb.com/2026/04/21/gemini-google-home-good-bad-ugly-early-user-reports/)). The single strongest lesson for us: timers, alarms, lists and "stop" must be deterministic, fast and local, with the LLM on top, never in the way.
- **Skill platforms are converging on "tools with descriptions and JSON-schema parameters".** Alexa+ add-ons (Action SDK, MCP Toolkit), Apple App Intents, Leon 2.0 `skill.json` actions, Home Assistant's LLM API and OpenClaw `SKILL.md` all describe actions to a model instead of listing sample utterances. That is exactly our `Tool` shape, so our module system is already on the right side of this shift.
- **Household behaviour is where commercial assistants still lead.** Device-bound timers, announcements/broadcast, intercom, voice-matched personal results with a guest fallback, proximity-aware screens and "pending notification" indicators are mature on Alexa/Google/HomePod and weak or missing in open-source assistants.
- **Proactivity is welcome only when it is useful and quiet.** Alexa's "by the way" upsells are one of its most-complained-about behaviours ([Tom's Guide](https://www.tomsguide.com/how-to/by-the-way-did-you-know-alexas-annoying-suggestions-can-be-turned-off-heres-how)); Google's camera "Home Brief" and Home Assistant's `ask_question` show the useful kind.
- **Recommended first modules** (detail in the last table): timers, alarms, reminders, lists, assistant controls (stop/repeat/volume), announcements, music, kitchen, briefing, calendar.

---

## 1. Amazon Alexa and Alexa+ (Echo, Echo Show)

**Status.** Alexa+ is the LLM rebuild announced February 2025 and available to all US Prime members since 4 February 2026; $19.99/month without Prime ([TechRepublic](https://techrepublic.com/article/news-amazon-alexa-ai-all-us-users), [GeekWire](https://www.geekwire.com/2026/amazon-rolls-out-alexa-to-all-u-s-customers-making-its-ai-assistant-free-for-prime-members/)). Also on Fire TV, Fire tablets, the Alexa app and Alexa.com; early access in several European countries, Brazil and Mexico ([Amazon](https://www.aboutamazon.com/news/devices/new-alexa-generative-artificial-intelligence)). Some Prime members were switched over automatically, which produced consent complaints ([TechRepublic](https://www.techrepublic.com/article/news-amazon-auto-enables-alexa-plus-prime-members/)). Original Alexa keeps running for non-upgraded users.

**Retired features worth knowing about:** Alexa Guard (free intrusion/smoke-alarm listening) was retired in 2023 and its features moved to paid Emergency Assist ([CE Pro](https://www.cepro.com/news/amazon-shutters-alexa-guard-service-in-favor-of-new-paid-service/127469)); Alexa Together (remote caregiving) ended May 2025 ([Amazon](https://www.aboutamazon.com/md/news/devices/alexa-together-is-helping-bridge-the-miles-between-families)); the "Do Not Send Voice Recordings" local-processing option was removed 28 March 2025 ([The Register](https://www.theregister.com/2025/03/17/amazon_kills_on_device_alexa/)).

### (a) Capability catalogue

From Amazon's launch material ([Amazon](https://www.aboutamazon.com/news/devices/new-alexa-generative-artificial-intelligence)) and later coverage:

| Domain | What Alexa / Alexa+ does |
|---|---|
| Timers, alarms, reminders | Named multiple timers, alarms (incl. music alarms), reminders; person-targeted reminders on newer Echo Show using Visual ID ([Tom's Guide](https://www.tomsguide.com/ai/alexa-just-got-a-major-upgrade-for-the-holidays-here-are-the-new-shopping-and-home-features-im-most-excited-about)) |
| Lists | Shopping and to-do lists, synced to the app; historically third-party list sync (AnyList, Todoist) |
| Kitchen | Recipes, step-by-step on Echo Show, remembers "family recipes" and dietary needs; recipe requests were 5x higher among early Alexa+ users than on old Alexa (Amazon figure, secondary reporting: [Modern Retail](https://www.modernretail.co/technology/marketplace-briefing-amazon-says-customers-make-three-times-more-purchases-on-alexa-than-its-predecessor/)) |
| Music and audio | Amazon Music, Spotify, Apple Music, iHeartRadio; conversational requests ("background music for a dinner party"); multi-room groups; moving playback between rooms; AI-generated podcast episodes on a topic |
| Video | Fire TV: find shows, jump to a scene, actor info, sports stats |
| Smart home | Lights, plugs, thermostats, locks, robot vacuums (Roborock), Ring cameras ("did a package arrive?"); voice-created routines; built-in Zigbee/Matter/Thread hubs on Echo Show 8 and 11 (2025) ([Amazon](https://www.aboutamazon.com/news/devices/getting-started-echo-show-8-11-alexa-plus-features)) |
| Communication | Announcements to all/one Echo, Drop In (two-way audio/video intercom between Echos or contacts), calling, messaging (long-standing features; not re-checked for Alexa+) |
| Calendar, email, documents | Family calendar (full-screen, colour-coded per member on Echo Show); add events from a photo or forwarded email; summarise uploaded documents; turn study material into quizzes |
| Knowledge and web | Open questions, agentic web browsing to complete tasks (e.g. booking a Thumbtack repair) |
| Weather, news, briefings | Weather, Flash Briefing (news), proactive traffic nudge ("leave earlier") |
| Shopping and services | Product research, price history, deals, reorders; groceries (Fresh, Whole Foods); food delivery (Grubhub, Uber Eats); reservations (OpenTable, Vagaro); ticket alerts (Ticketmaster). Purchases 3x higher than old Alexa (Amazon figure) |
| Memory | Remembers facts you tell it ("my daughter is vegetarian") and uses them later |
| Kids | Amazon Kids profiles and filtered content (long-standing); Alexa+ kids' story generation delayed past launch ([eWeek](https://www.eweek.com/fr/news/amazon-alexa-plus-missing-features/)) |
| Safety | Emergency Assist (paid): smoke/CO alarm sound detection, urgent response |
| Personality | Four response styles: Brief, Chill, Sweet, Sassy |

### (b) How skills are structured

- **Classic Alexa Skills Kit.** A custom skill declares an *invocation name* ("Alexa, ask *Recipe Box* to …"), an *interaction model* of intents with sample utterances and typed slots, and an HTTPS/Lambda endpoint. Optional declarations: *account linking* via OAuth ([docs](https://developer.amazon.com/en-US/docs/alexa/account-linking/understand-account-linking.html)); *permissions* the user grants in the app such as name, email, address, lists read/write, reminders, notifications ([docs](https://developer.amazon.com/en-US/docs/alexa/custom-skills/configure-permissions-for-customer-information-in-your-skill.html)); interfaces like APL (screen), AudioPlayer, and access to the Reminders and Timers APIs ([Reminders](https://developer.amazon.com/en-US/docs/alexa/smapi/alexa-reminders-overview.html), [Timers](https://developer.amazon.com/en-US/docs/alexa/smapi/alexa-timers-api-reference.html)). Smart-home skills are different: no utterances, just device capability interfaces (PowerController, ThermostatController…) that Alexa maps language onto.
- **Alexa+ (2025–).** Amazon calls its internal modules *experts*: "groups of systems, capabilities, APIs, and instructions that accomplish specific types of tasks" ([Amazon](https://www.aboutamazon.com/news/devices/new-alexa-generative-artificial-intelligence)). For third parties it announced the AI Action SDK (expose your API as actions), Web Action SDK (Alexa drives your website via low-code workflows) and a Multi-Agent SDK preview (bring your own agent into the conversation) ([Amazon developer blog](https://developer.amazon.com/en-US/blogs/alexa/alexa-skills-kit/2025/02/new-alexa-announce-blog)). The current docs centre on a *Category SDK* (Action add-on or MCP add-on for verticals such as reservations, food ordering, rides) and an *MCP Toolkit* where Alexa+ is the MCP client of your server, with a 500 ms round-trip budget and the MCP Apps extension for visuals on screen devices ([docs](https://developer.amazon.com/en-US/docs/alexaplus/add-ons/choose-the-proper-alexaplus-integration-approach.html)). Access is allow-listed.
- **Migration gap.** Existing skills keep working on original Alexa; developers must apply to have a skill considered for Alexa+, and not every skill was carried over ([Lowpass](https://lowpass.cc/p/amazon-alex-plus-skills-missing-voice-developer-worries)).

### (c) Screens vs speakers

- **APL** (Alexa Presentation Language) is a JSON document format with data binding. Devices report *viewport profiles* (hub round small, hub landscape medium/large, TV, mobile) and skills pick layouts per profile; Amazon ships responsive components and templates ([docs](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-build-responsive-apl-documents.html)). A skill checks whether the device supports `Alexa.Presentation.APL` before sending visuals and must still return speech for headless devices.
- **Proximity-adaptive screens.** The 2023 Echo Show 8 used on-device vision to enlarge text when you are far away and show detail when close ([The Ambient](https://www.the-ambient.com/news/3rd-gen-amazon-echo-show-is-a-matter-controller-with-spatial-audio-skills-3133)); the 2025 Show 8/11 extend this with "Omnisense" sensor fusion that switches from ambient visuals to a personal home view as someone approaches, and can trigger routines on presence or Visual ID ([Amazon](https://www.aboutamazon.com/news/devices/getting-started-echo-show-8-11-alexa-plus-features)).
- Home-screen **widgets** (calendar, lists, timers, "For You" suggestions) keep state visible without asking.

### (d) Household and multi-device

- Timers belong to the Echo that set them; you can ask any Echo or the app about timers, and a ringing timer can be stopped from the device that rings (cross-device timer behaviour was not re-checked for Alexa+).
- Announcements broadcast to every Echo or a named one; Drop In opens an intercom.
- Voice ID and Visual ID give per-person calendars, reminders and music accounts; the family calendar colour-codes each member.
- Conversation context carries across devices in Alexa+.
- Echo Spatial Perception picks the nearest Echo when several hear the wake word (long-standing; Home Assistant users explicitly ask for the same feature, see [HA forum](https://community.home-assistant.io/t/alexa-style-esp-echo-spatial-perception/1010310)).

### (e) Proactive behaviour

- Notifications: a yellow ring on the speaker or a banner on screen, read out only when the user asks ("what are my notifications"). Third parties push via the Proactive Events API with fixed schemas (order status, weather alert, sports score…) ([docs](https://developer.amazon.com/en-US/docs/alexa/smapi/proactive-events-api.html)).
- "Hunches" on old Alexa suggested turning off a light left on; Alexa+ promises proactive nudges (traffic, ticket on-sale, price drops) ([Maginative](https://www.maginative.com/article/amazon-unveils-alexa-a-smarter-more-conversational-ai-assistant/)).
- Presence and Visual ID reminders on Omnisense devices.

### (f) Complaints and failure modes

- **Latency and regressions.** Alexa+ requests taking up to 15 s, weather and music over 10 s; timed fan control that used to work became unreliable ("run the fan for 15 minutes" turned the fan on and never off); smart-home integration called "surface-level" ([Spyglass](https://spyglass.org/broken-alexa-plus.md)).
- **Cloud dependency for alarms.** An August 2025 UK outage left alarms ringing that could not be cancelled; people unplugged Echos ([The Register](https://www.theregister.com/2025/08/14/alexa_hits_snooze_on_basic/)). In an analysis of 126 negative app reviews, alarms and timers were the most-named regression (31.7%) ([unstar.app, third-party analysis](https://unstar.app/blog/alexa-app-alarms-not-working-devices-offline-reviews-2026)).
- **Upsell.** "By the way…" suggestions after a simple timer; "Alexa, stop by the way" sometimes only snoozes them ([Tom's Guide](https://www.tomsguide.com/how-to/by-the-way-did-you-know-alexas-annoying-suggestions-can-be-turned-off-heres-how)).
- **Discovery.** Users learn a handful of commands and stop exploring; invocation-name skills ("ask X to…") were hard to remember. Alexa was reported to be losing about $10 billion a year in 2022 because use stayed shallow ([AppleInsider](https://appleinsider.com/articles/22/11/22/amazon-alexa-bled-10-billion-in-cash-in-2022)).
- **Privacy rollback and paywalls** (local processing removed; Guard features moved to a subscription).

---

## 2. Google Assistant, Gemini for Home (Nest speakers and Nest Hub)

**Status.** Gemini for Home replaces Google Assistant on Nest speakers and displays: US early access from October 2025, Australia from April 2026, 16 more countries around June 2026; still opt-in early access in many markets ([9to5Google](https://9to5google.com/2025/10/06/gemini-for-home-rolling-out-schedule-countries/), [Google AU](https://blog.google/intl/en-au/products/devices-services/try-the-new-gemini-for-home-voice-assistant/)). **Once a home switches it cannot go back to Google Assistant** ([Google help](https://support.google.com/googlenest/answer/16618650)). Google Home Premium ($10 Standard / $20 Advanced per month) gates Gemini Live on speakers, voice-created automations, camera history search, AI camera descriptions and Home Brief ([9to5Google](https://9to5google.com/2025/10/01/google-home-premium/), [Android Authority](https://www.androidauthority.com/google-home-premium-3602475/)).

**Things Google already took away:** Conversational Actions (all third-party voice apps and games, including the Nest Hub games tab and third-party list sync with AnyList, Any.do, Bring) shut down June 2023 ([Google FAQ](https://developers.google.com/assistant/ca-sunset/faq), [9to5Google](https://9to5google.com/2023/06/14/nest-hub-voice-apps/)). In January 2024 Google removed 17 "underutilized" Assistant features, including music/radio alarms and recipe follow-along on smart displays ([TechCrunch](https://techcrunch.com/2024/01/11/google-is-removing-17-underutilized-assistant-features/)).

### (a) Capability catalogue

Per Google's help page ([Google help](https://support.google.com/googlenest/answer/16618650)) plus coverage:

| Domain | What it does |
|---|---|
| Timers, alarms, reminders | Timers and alarms, media sleep timers, reminders (create/edit) |
| Lists, notes | Google Keep lists and notes; the Keep link broke for many users in August 2026 ([9to5Google](https://9to5google.com/2026/08/25/google-home-keep-integration-broken-due-to-bug/)) |
| Kitchen | "Cooking help (recipes, timers, shopping lists)"; step-by-step recipe follow-along was removed in 2024 |
| Music, video | Media search in natural language ("music videos", "that movie with…"), YouTube on displays, cast to TVs and speaker groups |
| Smart home | Devices, scenes, routines; voice-created automations (Premium); camera livestream and history search, AI event descriptions ("Sergei walking with a dog"), "Ask Home" questions about what cameras saw (Advanced) |
| Communication | Broadcast to all Nest devices (and reply), Duo/Meet calls on displays (historical; not re-checked under Gemini) |
| Calendar | Personal calendar via Voice Match |
| Knowledge | Gemini answers; Gemini Live open conversation with interruptions ("Hey Google, let's chat"), Premium on speakers; extended to 1st-gen Home Mini and Nest Hub in July 2026 ([Droid Life](https://www.droid-life.com/2026/07/23/googles-1st-gen-smart-home-devices-get-gemini-live/)) |
| Weather, news | Weather with visuals on displays; conversational news where you can ask about a headline (Google Home 4.18) ([Gadget Hacks](https://android.gadgethacks.com/news/gemini-for-home-smart-display-update-weather-media-browsing-and-news-features-explained/)) |
| Briefings | Home Brief: summary of the last 24 h of camera activity, adjustable ("only the kids", "shorter") |
| Kids | Voice-matched kids get filtered responses; parental controls ([Google help](https://support.google.com/googlenest/answer/16618650)) |

### (b) Extension model

There is no longer a general third-party voice-app platform for Google's home devices. Third parties integrate as smart-home devices (Google Home APIs, Matter) or as Android app actions on phones. Gemini on phones uses Google's own "extensions/apps" (Calendar, Keep, Tasks, Maps, Messages) rather than an open marketplace.

### (c) Screens vs speakers

- Nest Hub shows visual answers and YouTube; Gemini added redesigned visual cards for weather and general answers in July 2026 ([9to5Google](https://9to5google.com/2026/07/08/gemini-nest-hub-answer-weather-redesign/)).
- **Ultrasound presence sensing** (Nest Hub, Hub Max, ~4 ft): larger fonts from afar, more controls and pending notifications when you come close; detection stays on the device ([Google help](https://support.google.com/googlenest/answer/9509981)).
- **Look and Talk** (Hub Max): look at the screen and speak, no wake word, after Face Match + Voice Match; **Quick Phrases**: wake-word-free commands such as "stop", "set a timer", "turn on the lights" ([Google I/O 2022](https://blog.google/products/assistant/assistant-io-2022/)).
- Ambient mode: photo frame and clock when idle.

### (d) Household

- Voice Match (up to six people) gives each their calendar, commute, reminders and music; others get non-personal answers. Continued Conversation is a household-wide setting, so it applies to guests too ([summary of Google help pages](https://support.google.com/googlenest/answer/16618650)).
- Broadcast to every speaker/display or one room; family members can reply.
- Gemini for Home cannot yet set the assistant voice per person and has limited memory management ([PiunikaWeb](https://piunikaweb.com/2026/04/21/gemini-google-home-good-bad-ugly-early-user-reports/)).

### (e) Proactive

Pending notifications appear on the Hub's ambient screen when someone is near. Camera event descriptions and Home Brief are the main new proactive features. Old Assistant had "Family Bell" (scheduled chimes for the household) — its current status is unverified.

### (f) Complaints

- Light commands that used to take a second now leave the speaker silent for 20–40 s; ignored queries; "turn off kitchen lights" turning on a bedroom TV; all devices of one type responding; hallucinated weather, calendar entries and sensor readings; overly wordy answers; weak handling of lists, timers and multi-step commands; automations broken after the upgrade ([PiunikaWeb](https://piunikaweb.com/2026/04/21/gemini-google-home-good-bad-ugly-early-user-reports/), [9to5Google](https://9to5google.com/2025/12/17/gemini-for-home-reportedly-breaks-automations/)).
- Missed timers and reminders that never fired in a July 2026 review; Google later shipped fixes for slow timer handling and sleep timers that were not set ([Gadget Hacks](https://android.gadgethacks.com/news/gemini-for-home-timers-and-alarms-claims-vs-reality/)).
- Multi-part commands right "about half of the time" ([Android Authority](https://www.androidauthority.com/gemini-for-google-home-impressions-3633043)).
- Forced, irreversible migration; repeated feature removals.

---

## 3. Apple Siri (HomePod, HomePod mini, iPhone)

**Status.** The LLM "Siri AI" slipped from iOS 26.4 and shipped with iOS 27 (announced June 2026, released autumn 2026), built on Apple foundation models developed with Google Gemini technology ([MacRumors](https://www.macrumors.com/2026/02/06/siri-ios-26-4-rumors/), [MacRumors guide](https://macrumors.com/guide/ios-27-siri)). English only at launch; not on iPhone/iPad in the EU at launch. HomePod was barely mentioned at WWDC; an "Apple Intelligence Report" toggle for HomePod in iOS 27 suggests AI on new HomePod hardware ([9to5Mac](https://9to5mac.com/2026/08/26/ios-27-reveals-apple-tv-4k-homepod-may-get-powerful-new-features/)). A homeOS smart-home hub with a 7-inch screen was reported for an October 2026 launch; **I could not confirm that it shipped** ([TechRepublic](https://www.techrepublic.com/article/news-apple-smart-home-hub-october-13-homepod-mini/)). Treat Siri AI on HomePod as unverified.

### (a) Capabilities

| Domain | HomePod / Siri |
|---|---|
| Timers, alarms | Multiple named timers and alarms on HomePod, available to guests |
| Reminders, lists, notes | Via the owner's iPhone with Personal Requests |
| Music | Apple Music first-class, other services via apps; multi-room AirPlay; "play this everywhere"; handoff from iPhone |
| Smart home | HomeKit/Matter devices, scenes, automations; HomePod as home hub; sound recognition for smoke alarms (long-standing; not re-checked) |
| Communication | Intercom (announce to every HomePod and iPhone in the home or a room, reply from iPhone; long-standing, not re-checked), calls and messages via iPhone |
| Calendar, email | Personal Requests read calendar; Siri AI on iPhone searches mail, messages, notes and files ("find the confirmation number") |
| Knowledge | Siri AI web search, document analysis, recipe/trip/homework help; on-screen awareness on iPhone |
| Weather, news | Weather; news briefing (podcast-style) |

### (b) Extension model

**App Intents**: apps declare actions with typed parameters and entities in Swift; Siri, Shortcuts and Spotlight call them ([Apple docs](https://developer.apple.com/documentation/appintents)). In iOS 27 Siri AI can use "App Actions" in third-party apps that support them ([MacRumors guide](https://macrumors.com/guide/ios-27-siri)). HomePod has no third-party skills; it reaches apps through the owner's iPhone.

### (c) Screens vs speakers

HomePod is speaker-only (top-surface glow for listening/thinking). Visual results live on the iPhone. The rumoured hub would add the first Apple screen device designed for the home.

### (d) Household

Voice recognition for up to six people; recognised members get Personal Requests (messages, calls, calendar, reminders, notes, Shortcuts on their own iPhone); **guests can still use music, timers, alarms, weather and news** ([Apple](https://support.apple.com/guide/homepod/apd1841a8f81)). Early versions often replied "I'm not sure who is speaking" (older 9to5Mac report; exact article unverified).

### (e) Proactive

Little on HomePod; notifications go to iPhone/Watch. Siri Suggestions on iPhone.

### (f) Complaints

Years of "Siri is not smart" coverage, a two-year delay of the promised personal Siri, and no third-party extensibility on HomePod. Reviewers of iOS 27 are positive about the new Siri on iPhone ([MacStories](https://www.macstories.net/stories/ios-and-ipados-27-review/5/)).

---

## 4. Home Assistant Assist (voice pipelines, satellites, LLM agents)

**Status.** Active and the most-used open-source voice assistant. Year of Voice started 2023 ([HA](https://home-assistant.io/blog/2022/12/20/year-of-voice)); Voice chapters continue (chapter 11, October 2025). Home Assistant Voice Preview Edition and community satellites (ESP32-S3, FutureProofHomes Satellite1, ReSpeaker XVF3800) are the hardware.

### (a) Capabilities

Built-in intents ([sentence list](https://www.home-assistant.io/voice_control/builtin_sentences/), [intent list](https://contributors.home-assistant.io/core/internals/built-in-intents/)):

| Domain | Intents / features |
|---|---|
| Device control | `HassTurnOn/Off`, toggle, `HassLightSet` (brightness, colour), climate set temperature/fan mode, `HassFanSetSpeed`, covers (open/close/position), humidifier, scenes/scripts, vacuum start/dock/clean area, lawn mower |
| State questions | "Is the front door locked?", "which windows are open?", indoor temperature |
| Timers | Start (duration + optional name), cancel one/named/all, pause/resume, add/remove time, status; **delayed commands** ("turn off the lights in 10 minutes"), which cannot be cancelled ([chapter 7](https://www.home-assistant.io/blog/2024/06/26/voice-chapter-7)) |
| Lists | Shopping list and any to-do entity: add, complete, remove |
| Media | Pause/resume/next/previous, absolute and relative volume, mute, `HassMediaSearchAndPlay` with Music Assistant, Sonos, Jellyfin |
| Weather, time, date | `HassGetWeather`, current time and date |
| Broadcast | `HassBroadcast`: speak a message on other satellites |
| Conversation | `HassNevermind` (cancel accidental wake), `HassRespond` |
| LLM | Any conversation agent (OpenAI, Google, Anthropic, Ollama, OpenRouter; llama.cpp and LiteLLM integrations reported for 2026.8 — [secondary, unverified](https://www.privacysmarthome.com/guides/home-assistant-2026-8-local-ai-voice-ready-replace-cloud-2026/)); scripts exposed as LLM tools; MCP client and MCP server integrations; `ai_task.generate_data` for structured output in automations, with image attachments ([HA blog](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant)) |

### (b) Structure

- **Intents and sentences** live in the `home-assistant/intents` repo as YAML templates per language, with slot lists filled from entity/area names. Custom sentences and `intent_script` let users add their own. Speech-to-Phrase is a closed-vocabulary local STT generated from the user's entity names ([chapter 9](https://home-assistant.io/blog/2025/02/13/voice-chapter-9-speech-to-phrase)).
- **"Prefer handling commands locally"**: the intent matcher runs first, only unmatched utterances go to the LLM ([HA blog](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant)). A fuzzy matcher (2025.9, English) tolerates extra words.
- **Exposure as permission model**: only entities the user exposes to Assist are visible to any agent.
- **Pipelines**: wake word → STT → conversation agent → TTS, chosen per satellite; since 2025.10 a satellite can have **two wake words, each with its own pipeline** (e.g. local English and cloud LLM) ([chapter 11](https://www.home-assistant.io/blog/2025/10/22/voice-chapter-11)). Wyoming is the protocol between pipeline parts.

### (c) Screens vs speakers

Mostly headless satellites. The ESP32-S3-BOX shows timers as countdown text and a progress bar. View Assist and kiosk-satellite projects add tablet front ends; a 2026 Kiosk Satellite blueprint lets an LLM agent ring another kiosk as an intercom ([release notes](https://newreleases.io/project/github/jxlarrea/kiosk-satellite/release/2026.10.1)). Non-verbal confirmation: since 2025.10 a short beep replaces the spoken "turned on the lights" when every action happened in the satellite's own area ([chapter 11](https://www.home-assistant.io/blog/2025/10/22/voice-chapter-11)).

### (d) Household

- Satellites have an area; "turn on the lights" means this room's lights, and the LLM is told which room and devices are near ([HA blog](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant)).
- Timers are bound to the satellite that set them and ring there.
- **Duplicate wake words**: when two satellites hear the wake word, the one that started streaming first wins; users report the wrong satellite answering or several executing the same command, and work around it with per-room wake words or mute switches ([HA forum](https://community.home-assistant.io/t/vpe-multiple-satellites-which-wins-on-wake-word-does-not-work-well/1019767)).
- No speaker identification.

### (e) Proactive

`assist_satellite.announce` (speak a message), `start_conversation` (speak, then listen for a reply handled by the agent) and `ask_question` (speak, match the answer against a list of choices, return the choice to the automation; works with local Speech-to-Phrase) ([integration](https://www.home-assistant.io/integrations/assist_satellite/), [ask_question](https://www.home-assistant.io/actions/assist_satellite.ask_question/)). The canonical example: "The garage door is still open, shall I close it?". Satellite state conditions (idle/listening/processing/responding) arrived in 2026.2 ([release notes](https://www.home-assistant.io/blog/2026/02/04/release-20262/)).

### (f) Complaints

Rigid sentence matching for non-English languages, wrong-satellite wake, LLM latency on local hardware, uncancellable delayed commands, no voice ID, and the general DIY setup cost.

---

## 5. OpenVoiceOS, Mycroft and Neon

**Status.** Mycroft AI wound down in early 2023 ([Wikipedia](https://en.wikipedia.org/wiki/Mycroft_(software))); its servers are gone. OpenVoiceOS (OVOS) is the surviving community fork, now under an OpenVoiceOS Foundation ([CNX](https://www.cnx-software.com/2025/02/24/the-openvoiceos-foundation-aims-to-enable-open-source-privacy-and-customization-for-voice-assistants/)); `ovos-core` had commits in November 2026. Neon AI builds on the OVOS stack, supports the Mark II and claims 100+ skills ([Neon](https://www.neon.ai/ComparingNeon-OVos-Mycroft)); `NeonCore` last saw commits in September 2026.

### (a) Capabilities

Typical skill set (Neon's command list: [Neon](https://neon.ai/SkillCommandExamples); OVOS skills repos): timers, alarms, reminders, date/time, weather, Wikipedia/DuckDuckGo/Wolfram answers, news, jokes, unit conversion, volume, OCP media playback (YouTube, radio, podcasts, local files), Home Assistant control, personal info ("what's my name"), translation, games, and LLM "personas".

### (b) Structure

- Python class (`OVOSSkill`) with intent handlers; locale folders per language holding `.intent` (Padatious example sentences), `.voc` (Adapt keywords), `.entity`, `.dialog` (response templates with variants) ([OVOS manual](https://openvoiceos.github.io/ovos-technical-manual/)).
- `settingsmeta` declares the settings form; `skill.json` holds metadata for install and app-store display ([skill.json](https://openvoiceos.github.io/ovos-technical-manual/411-skill_json)).
- **Pipeline of matchers in priority order**: stop → converse (an active skill gets first look at the next utterance) → high-confidence Padatious/Adapt → OCP media → common query (several skills answer a question, best answer wins) → persona (LLM) → fallback skills. A persona can take everything, or only what no skill matched with high confidence, "so it doesn't step on timers and lights" ([ovos-persona](https://pypi.org/project/ovos-persona/0.6.24a1/), [OVOS blog](https://blog.openvoiceos.org/posts/2025-08-23-enhance-magicmirror-with-ovos)).
- Skills talk over a message bus; sessions make skills "session aware" so several satellites (HiveMind) can share one core.

### (c) Screens

The Mycroft GUI protocol lets a skill show QML pages (`gui.show_text`, `show_image`, custom pages) on a screen device; headless devices ignore them. Mark II had a 4.3" screen.

### (d)–(f)

Multi-device via HiveMind satellites; no voice ID. Complaints: skills often abandoned after Mycroft's collapse, install friction, English-centric quality, many moving parts.

---

## 6. Rhasspy

**Status: effectively finished.** `rhasspy/rhasspy3` is archived (last push December 2023, checked via the GitHub API). Its author leads voice at Nabu Casa and its ideas live on as Home Assistant's Wyoming protocol, Piper and Speech-to-Phrase ([HA](https://home-assistant.io/blog/2022/12/20/year-of-voice)). Rhasspy 2 offered offline intents from a `sentences.ini` grammar, MQTT (Hermes) events to any home-automation system, and satellites. Lesson: a closed grammar compiled from the user's own entity names gives very fast, very accurate local commands.

---

## 7. Willow

**Status.** `HeyWillow/willow` is not archived and had commits in November 2026, but public activity is low and I found no 2026 release notes ([GitHub](https://github.com/HeyWillow/willow)). Not to be confused with Willow Voice, a commercial dictation app.

Willow runs on ESP32-S3-BOX hardware: on-device wake word, audio streamed to the self-hosted Willow Inference Server (Whisper STT, TTS, optional LLM), a Willow Application Server to configure a fleet of devices, and on-device command recognition for a few hundred fixed commands; integrates with Home Assistant, openHAB and generic REST ([heywillow.io](https://heywillow.io/)). The box screen shows the recognised text and the result. Capability catalogue is thin by design: it is a fast front end for a home-automation system, not an assistant with skills. Point worth copying: fleet configuration from one server and a hard focus on wake-to-action latency.

---

## 8. Leon

**Status.** Active (commits on 17 November 2026), Node.js/TypeScript, MIT. The `develop` branch is heading to a "Leon 2.0 alpha" with a desktop app and a new web app; the public docs still describe the old version ([README](https://cdn.jsdelivr.net/gh/leon-ai/leon@master/README.md)).

- **Skills**: *native skills* follow explicit actions; *agent skills* guide the agent loop through open tasks; both use one tool system. Tools "declare their functions, settings, dependencies, and binaries" and run in isolated workers. Memory is layered (temporary context, persistent facts, daily summaries) and isolated per profile.
- **A real manifest** (`skills/native/timer_skill/skill.json`, read from the repo): name, icon, bridge (`nodejs`), version, description, and `actions` such as `set_timer` with a JSON-schema `parameters` object (`duration: {value: number, unit: HOURS|MINUTES|SECONDS}`), `cancel_timer`, `check_timer`. Skill folders also hold `locales`, `memory`, `src` and `test`. This is close to our `defineModule` + `Tool`.
- **Native skills on `develop`**: timer, to-do list, weather forecast, date/time, web search toolkit, music/audio toolkit, podcast generator, video summariser and translator, voice designer, games (Akinator, guess the number, rock-paper-scissors), jokes, speed test, "is it down", Have I Been Pwned, partner assistant, widget playground. Agent skills: coding, document authoring, live tutorial, media production.
- **Visuals**: "Aurora" component library for interactive charts, forms and visual answers in conversation (generative UI), plus "Vibes" ambient scenes following season, time and weather. Worth studying for our character/stage screen.

---

## 9. Josh.ai

Commercial, dealer-installed whole-home control for high-end custom installs (2,000+ certified dealers in North America). JoshGPT (since 2023, on a customised OpenAI model) mixes information and control in one sentence; JoshGPT 3.0 (2025) adds "generative control" such as "set the lights to the colours of the Northern Lights" ([CE Pro](https://www.cepro.com/products/joshgpt-brings-advanced-ai-to-control-market/), [Josh.ai CEDIA 2025](https://josh.ai/stories/joshai-launches-ai-x-os-debuts-larger-touchscreen-showcases-josh-edge-remote-and-introduces-new-partnerships-at-cedia-expo-2025)).

Domains: lighting, shades, climate, locks, AV distribution and TVs, multi-room music (Sonos, HEOS, WiiM, BluOS; lyric/theme search with BluOS), cameras with AI insights and notifications ("Josh Vision"), DoorLink intercom and access control with DoorBird/2N, sports scores and schedules ([CE Pro](https://www.cepro.com/news/josh-ai-2025-winter-launch-event-every-product-and-update-announced/147523)). Far-field Josh Micro/Nano microphones are room-aware (a room-bound remote and microphones act on their room). No third-party skill platform; integrations are written by Josh. Lessons: rooms and the music experience are the product; intercom with the front door is a household favourite; privacy (no data selling) is a selling point.

---

## 10. Samsung Bixby

Bixby is Samsung's assistant on Galaxy phones, TVs, Family Hub fridges and SmartThings appliances. On the Galaxy S26 (February 2026) and One UI 8.5, Bixby handles device tasks and hands complex, web-backed questions to Perplexity, with sources ([SamMobile](https://www.sammobile.com/news/how-samsung-new-bixby-makes-life-easier-for-galaxy-s26-users/), [Android Central](https://www.androidcentral.com/phones/samsung-galaxy/samsung-testing-perplexity-inside-bixby-for-galaxy-s26)). Third-party "capsules" (Bixby Developer Studio, Marketplace, 2018–2019) declared concepts, actions and dialogs with a planner that chained actions; I found no current evidence of the capsule ecosystem being active, and its status is **unverified** ([SamMobile 2019](https://www.sammobile.com/2019/06/27/bixby-marketplace-opens-up-for-developers-capsules/)). Relevant pattern: appliance control through SmartThings (washer done, fridge door open) is Samsung's household angle; the "device settings" domain (phone/TV settings by voice) is its strongest.

---

## 11. Conversational assistants: ChatGPT voice, Gemini Live, Claude voice

These are not home assistants (no wake word on shared devices, no timers bound to a room) but they set the bar for conversation quality.

- **ChatGPT voice**: since November 2025 voice runs inside the normal chat; answers show transcripts, images, maps and weather as they are spoken; the old separate voice screen remains as an option ([TechCrunch](https://techcrunch.com/2025/11/25/chatgpts-voice-mode-is-no-longer-a-separate-interface/), [MacRumors](https://www.macrumors.com/2025/11/26/chatgpt-voice-mode-update-seamless-chat/)). The maps are static graphics, not a map app ([TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpts-new-voice-integration-feels-like-the-missing-piece-in-ai-chat-ive-tried-it-and-its-almost-perfect)).
- **Gemini Live**: camera and screen sharing for all Android and iOS users since 2025 ([TechCrunch](https://techcrunch.com/2025/05/20/google-updates-the-gemini-app-with-real-time-ai-video-deep-research-and-more), [Android Central](https://www.androidcentral.com/apps-software/android-os/gemini-live-hits-iphones-in-us-with-camera-and-screen-sharing)); actions in Calendar, Keep, Tasks, Maps, with Messages/Phone/Clock reported later (partly secondary, unverified); on Nest speakers it is the Premium "let's chat" mode.
- **Claude voice**: since July 2026 runs on Opus, Sonnet and Haiku; can search Gmail and edit Google Calendar by voice (e.g. "push my meeting by 30 minutes"); free plan limited to Haiku and one connected tool; beta on mobile, desktop and web ([Claude blog](https://claude.com/blog/think-through-hard-problems-in-voice-mode), [The Decoder](https://the-decoder.com/claudes-voice-mode-now-runs-on-anthropics-most-capable-models-across-all-platforms/)). Whether Gmail sending works by voice is reported inconsistently (unverified).

What they show: barge-in and natural turn-taking are now expected; visuals that accompany speech (cards) are expected on screens; connected accounts (calendar, mail) are the most valued "tools".

---

## 12. Other open-source LLM voice assistants (2024–2026)

| Project | What it is | Relevance |
|---|---|---|
| [OpenClaw](https://github.com/openclaw/openclaw) (ex-Clawdbot/Moltbot) | Hugely popular self-hosted personal agent (~395k stars, Nov 2026); skills are folders with a `SKILL.md` (YAML front matter + Markdown) shared on the ClawHub registry; "Voice Wake" + "Talk Mode" on macOS/mobile; proactive "heartbeat" every 30 min plus cron jobs ([dev.to, secondary](https://dev.to/hex_agent/openclaw-202641-voice-wake-a-task-board-in-your-chat-and-smarter-failover-d4e)) | Proactivity model; **cautionary tale**: 341 of 2,857 audited ClawHub skills were malicious in February 2026 ([eSecurity Planet](https://esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub), [The Hacker News](https://thehackernews.com/2026/02/openclaw-integrates-virustotal-scanning.html)) |
| [Open-LLM-VTuber](https://docs.llmvtuber.com/en/docs/intro/) | Local voice companion with a Live2D avatar, echo-cancelled barge-in, emotion → expression mapping, MCP tools (time, web search) | Closest to our animated character; shows emotion tags driving the avatar |
| [Kyutai Unmute](https://kyutai.org/2025/05/22/unmute.html) | Open STT + TTS wrapped around any text LLM, semantic VAD, low latency | Component, not assistant; streaming STT/TTS reference |
| [HF speech-to-speech](https://github.com/huggingface/speech-to-speech) | VAD → STT → LLM → TTS reference pipeline | Component |
| [Pipecat](https://github.com/pipecat-ai/pipecat), [LiveKit Agents](https://github.com/livekit/agents) | Voice-agent frameworks (turn detection, interruptions, tool calls) | Frameworks; the assistant catalogue is up to you |

None of these has a household capability catalogue comparable to Alexa; they are conversation engines plus generic tools.

---

## 13. Usage data

| Source | Finding |
|---|---|
| Nielsen 2018 ([GeekWire](https://www.geekwire.com/2018/turn-tunes-despite-clever-gimmicks-music-still-reigns-king-smart-speakers/)) | Music 90% of users, real-time info (weather, traffic) 81% |
| Voicebot 2020 ([Voicebot](https://voicebot.ai/2020/05/03/streaming-music-questions-weather-timers-and-alarms-remain-smart-speaker-killer-apps-third-party-voice-app-usage-not-growing/)) | Music first for ever-tried, monthly and daily use; then questions, weather; timers and alarms in the top six (about half use timers monthly); only 48% had used any third-party voice app |
| 2018 survey, reported in search summaries (source unverified; possibly [Quantilope](https://www.quantilope.com/en/blog/insight-studies-how-do-you-really-use-smart-speakers-0)) | Questions 67%, weather 64%, alarms 61% |
| NPR/Edison Smart Audio Report (2017–2022, [RAIN News](https://rainnews.com/smart-audio-report/amp/)) | The longer a device is installed, the fewer features get used |
| Infinite Dial 2025 ([NPM](https://www.nationalpublicmedia.com/insights/articles/audio-listening-reaches-an-all-time-high-insights-from-the-2025-infinite-dial-report/)) | 35% of US 12+ own a smart speaker; 69% of owners use it for audio |
| Amazon on Alexa+ early access (secondary: [Modern Retail](https://www.modernretail.co/technology/marketplace-briefing-amazon-says-customers-make-three-times-more-purchases-on-alexa-than-its-predecessor/)) | 2x conversations, 3x purchases, 5x recipe requests vs. old Alexa; Amazon's own multiples, no absolute numbers |

The surveys are old (2018–2020) and US-centric, but nothing newer contradicts the ranking. Recipes are the one domain where LLMs clearly raised use.

---

## 14. Capability matrix

Y = built in and solid; P = partial, limited or via another device; – = no; ? = unverified. "LLM chat apps" = ChatGPT voice / Gemini Live / Claude voice.

| Domain | Alexa+ | Gemini for Home | Siri / HomePod | HA Assist | OVOS / Neon | Willow | Leon | Josh.ai | Bixby | LLM chat apps |
|---|---|---|---|---|---|---|---|---|---|---|
| Timers (named, multiple) | Y | Y (buggy) | Y | Y | Y | P (via HA) | Y | ? | Y | – |
| Alarms | Y | Y | Y | P (automations) | Y | – | – | ? | Y | P (phone clock) |
| Reminders | Y (per person) | Y | P (via iPhone) | P | Y | – | – | ? | Y | P |
| Shopping / to-do lists | Y | P (Keep, buggy) | P (via iPhone) | Y | Y | P | Y | ? | P | – |
| Kitchen / recipes | Y | P (follow-along removed) | P | – | P | – | – | – | P | P (chat) |
| Music / radio / podcasts | Y | Y | Y | Y (Music Assistant) | Y (OCP) | – | P | Y | P | – |
| Video / TV | Y (Fire TV) | Y (cast, YouTube) | P (Apple TV) | P | P | – | – | Y | Y (TV) | – |
| Smart home control | Y | Y | Y | Y | P (via HA) | Y | – | Y | Y (SmartThings) | – |
| Cameras / doorbell | Y (Ring) | Y (Premium) | P | P | – | – | – | Y | P | P (vision) |
| Announcements / intercom | Y (Drop In) | Y (Broadcast) | Y (Intercom) | Y (Broadcast) | P (HiveMind) | – | – | Y (DoorLink) | ? | – |
| Calendar | Y (family) | Y | P | P | P | – | – | – | Y | Y (connectors) |
| Email / documents | Y (forward, upload) | – | P (iPhone) | – | – | – | P | – | P | Y |
| Knowledge / web | Y | Y | Y (iOS 27) | P (LLM) | Y | – | Y | Y | Y (Perplexity) | Y |
| Weather | Y | Y | Y | Y | Y | – | Y | ? | Y | Y |
| News / briefing | Y | Y | Y | – | Y | – | – | ? | P | P |
| Routines / automations by voice | Y | Y (Premium) | P | P (LLM can't create) | – | – | – | P (scenes) | Y | – |
| Proactive notifications | Y | P | P (iPhone) | Y (announce, ask) | P | – | – | Y (cameras) | P | – |
| Shopping / ordering | Y | P | – | – | – | – | – | – | P | P |
| Kids / games | Y | P (games removed 2023) | – | – | P | – | Y (games) | – | P | P |
| Memory of household facts | Y | P | P | – | – | – | Y | – | ? | Y |
| Voice ID / profiles | Y (Voice + Visual ID) | Y (Voice/Face Match) | Y (6 users) | – | – | – | P (profiles) | ? | Y | n/a |
| Screen-adaptive visuals | Y (APL, proximity) | Y (cards, ultrasound) | – | P | Y (GUI) | P | Y (Aurora) | Y (touchscreen) | Y | Y |
| Third-party extensions | P (add-ons, allow-listed) | – (removed 2023) | P (App Intents) | Y | Y | – | Y | – | ? | P (connectors) |

---

## 15. Patterns worth copying

1. **Deterministic fast path first, LLM second.** Home Assistant's "prefer local", OVOS's pipeline where high-confidence skills run before the persona, and Alexa+ keeping smart-home commands fast while open questions go to the model. For us: timer, stop, volume and "turn on X" should not wait on a model round trip. Measure with `TurnTrace`.
2. **Actions declared as data with JSON-schema parameters.** Leon's `skill.json` actions, Alexa+ Action/MCP add-ons, App Intents. Same shape as our `Tool`; keep descriptions short and literal.
3. **Device and area context.** Every satellite knows its room; "the lights" means these lights, and the timer belongs to the device that set it. Non-verbal confirmation (a beep) when the action happened in the same room (HA 2025.10).
4. **One clear stop.** Wake-word-free "stop" while something is ringing or playing (Google Quick Phrases), and stopping an alarm on the device that rings even when the network is down.
5. **Personal vs guest results.** HomePod lets guests use music, timers, weather and news, and gates messages, calendar and reminders behind voice recognition. A good default for a household even before voice ID exists: shared things for anyone, personal things only with a known speaker or device owner.
6. **Proximity-aware screens.** Ambient view at a distance (clock, timers, pending notifications, photo/character) and detail up close (Echo Show Adaptive Content, Nest Hub ultrasound). For our character stage: the screen can show a running timer or list without being asked.
7. **Viewport profiles and graceful degradation.** APL picks a layout per profile and always returns speech; headless devices never miss information because it was only on screen.
8. **Notifications wait, they don't interrupt.** A pending indicator plus "what did I miss?" (Alexa ring, Nest Hub ambient). Interrupt only for things the user asked to be interrupted for (timers, alarms, doorbell).
9. **Ask, don't just tell.** HA's `ask_question` / `start_conversation`: an automation speaks, listens for a short reply and acts on it. Fits our turn model.
10. **Two wake phrases → two pipelines.** HA 2025.10 lets one satellite route "local" and "cloud" assistants by wake word; maps onto our assistants and Jev routing.
11. **Summaries instead of streams.** Google's Home Brief (what happened today, focus on the kids) and Alexa's morning routines: one spoken digest from many sources.
12. **Remembered household facts.** "My daughter is vegetarian" feeding recipes and shopping later (Alexa+, Leon's per-profile memory).
13. **Fleet configuration from one server** (Willow Application Server): devices are thin; settings live centrally. We already do this with device profiles.

## 16. Mistakes to avoid

1. **Letting the LLM rewrite the basics.** Alexa+ and Gemini for Home both made timers, lists and simple commands slower and less reliable; Gemini for Home reports 20–40 s silences and missed timers. Keep basics deterministic and tested.
2. **Alarms that depend on the cloud.** The 2025 UK Alexa outage left uncancellable alarms. Timers and alarms must fire and stop locally even if the language model or internet is down.
3. **Uncancellable or invisible scheduled actions.** HA's delayed commands cannot be listed or cancelled. Every scheduled thing should be a first-class, listable, cancellable item.
4. **Upsell and "did you know".** Alexa's "by the way" is the most-cited annoyance. No unsolicited tips after a command.
5. **Hallucinated state.** Gemini for Home invented sensor readings, weather and calendar items. Device state, weather and schedules must come from tool output, and the assistant should say "I don't know" when a tool fails.
6. **Wrong device / wrong room.** Commands acting on another room, all devices of a type responding, several satellites answering one wake word. Resolve targets explicitly and confirm when ambiguous.
7. **Wordiness on speakers.** Users call Gemini too wordy. Speaker replies should be one sentence; detail belongs on a screen.
8. **Invocation names and hidden features.** "Alexa, ask X to…" skills went unused and users stopped exploring after the first weeks. LLM routing removes invocation names; a short, discoverable "what can you do here" per room or module helps.
9. **Platform churn that deletes things people rely on.** Google killed Conversational Actions, games and list integrations (2023) and 17 features (2024); Alexa+ did not carry every skill over. Owning modules locally is our advantage; keep old modules working when contracts change.
10. **Forced, irreversible migrations and silent auto-upgrades** (Gemini for Home, Alexa+ auto-enable). Make big behaviour changes opt-in and reversible per device.
11. **Paywalling or removing privacy features** (Alexa Guard, local processing). Not a risk for a self-hosted project, but a reason households look for one.
12. **Unvetted third-party skills.** OpenClaw's ClawHub had hundreds of malicious skills in early 2026. If we ever load modules from outside the repo, they need review, explicit permissions and no blanket shell or network access.
13. **Unreliable voice ID used for personal data.** HomePod's "I'm not sure who is speaking". Fall back to the device's owner or ask, never guess for personal actions.

---

## 17. Candidate modules for us

Effort: S = a few days with existing pieces, M = one to two weeks, L = needs new infrastructure (scheduler, notifications, screen cards, identity). "Have it" uses the assistant names above. Value is for a multi-device household.

| Module | Tools it would hold | Have it | Household value | Effort |
|---|---|---|---|---|
| **timers** | `timer_start(duration, name?, device?)`, `timer_list`, `timer_cancel(name\|all)`, `timer_pause/resume`, `timer_adjust(delta)`; context: running timers on this device | All home assistants | Very high (top-5 use; kitchen) | M (needs a local scheduler that rings on the device, stop without wake word, visible on screens) |
| **alarms** | `alarm_set(time, days?, label?, sound?)`, `alarm_list`, `alarm_cancel`, `alarm_snooze`; music/radio alarm | Alexa, Google, HomePod, OVOS | High (bedrooms) | M (shares the scheduler with timers; must work offline) |
| **reminders** | `reminder_add(text, when, for_person?, device?)`, `reminder_list`, `reminder_done`; delivered on next presence or at time | Alexa, Google, Siri, OVOS | High | M (needs notifications module) |
| **lists** | `list_add(item, list?)`, `list_remove`, `list_read`, `list_clear`; backends: local, HA to-do, Todoist/Bring | All but Willow | Very high (shopping) | S–M (HA to-do path exists via home-assistant module) |
| **assistant controls** | `stop`, `repeat_last`, `volume_set/step`, `mute_mic`, `what_did_you_say`, `say_slower` | All | Very high (basic trust) | S (mostly server-side, some already in the protocol) |
| **announcements and intercom** | `announce(text, devices\|rooms\|all)`, `call_device(device)` (two-way), `reply_to_announcement` | Alexa, Google, HomePod, HA, Josh | High ("dinner's ready") | M (announce is cheap over existing TTS; two-way intercom is L) |
| **music** | `music_play(query, room?)`, `music_pause/resume/next`, `music_move(to_room)`, `music_group`, `what_is_playing`; backends: Music Assistant via HA, Spotify Connect, Jellyfin | All big three, HA, OVOS, Josh | Very high (top use) | M–L (search/queue semantics, playback is on other speakers) |
| **radio and podcasts** | `radio_play(station)`, `podcast_play(show, episode?)`, `podcast_resume` | Alexa, Google, HomePod, OVOS | Medium–high | M |
| **kitchen** | `recipe_find`, `recipe_import(url)`, `recipe_step(next\|prev\|repeat)`, `recipe_scale(servings)`, `convert_units`, `substitute(ingredient)`, ingredients → `list_add`, step timers → `timer_start` | Alexa (Show), formerly Google | High (5x recipe growth on Alexa+; screen + timers + lists together) | M (reuses timers, lists; screen step view is the deferred card work) |
| **briefing** | `briefing(morning\|evening\|custom)` composing weather, calendar, reminders, news, commute; per-person config | Alexa, Google, OVOS | High | S (on top of other modules) |
| **calendar** | `calendar_today(person?)`, `calendar_find`, `calendar_add_event`, `calendar_move_event`; CalDAV / Google | Alexa (family), Google, Siri, Claude voice | High (family coordination) | M (account linking via vault; per-person access) |
| **news** | `news_headlines(topic?)`, `news_more(headline)`; RSS sources | Alexa, Google, HomePod, OVOS | Medium | S |
| **knowledge** | `web_search`, `wikipedia`, `calculate`, `convert` (units, currency) | All | Medium–high | S |
| **weather** (extend) | add hourly / "will it rain at 3", alerts as notifications, a card for screens | All | High | S (module exists) |
| **smart home** (extend) | areas as context, scenes, state questions, "what's on", energy summary; confirm for locks/garage | All | Very high | S–M (home-assistant module exists) |
| **notifications** | `notifications_read`, `notifications_clear`; inbound sources (HA events, doorbell, timers missed, reminders, deliveries); policy: interrupt vs pending | Alexa, Google, HA | High | L (cross-device delivery policy, presence, screen indicator) |
| **routines** | `routine_create(trigger, actions)`, `routine_list`, `routine_run`, `routine_delete`; "every weekday at 7, read the briefing" | Alexa, Google (Premium) | Medium–high | L (scheduler + safe action language) |
| **household memory** | `remember(fact, person?)`, `forget`, `what_do_you_know_about` | Alexa+, Leon, Claude/ChatGPT | Medium–high | M (storage + editing UI) |
| **people and presence** | `who_is_home`, `where_is(person)` (from HA/phone), per-person profiles; later speaker ID | Alexa, Google, HomePod | Medium (enables personal results) | L |
| **messaging** | `message_person(person, text)` to their phone via ntfy/Signal/Telegram/Matrix; "tell Ian dinner's ready" when he's not home | Alexa, Google, Siri | Medium | M |
| **cameras and doorbell** | `camera_snapshot_describe(camera)`, `what_happened(since, camera?)`, doorbell announce with description | Alexa (Ring), Google (Premium), Josh | Medium | M (HA cameras + vision model) |
| **kids and games** | trivia/quiz, guess the number, rock-paper-scissors, riddles, jokes, bedtime story; filtered persona for kids' devices | Alexa, Leon, OVOS; Google removed 2023 | Medium (households with children) | S–M |
| **sleep and ambient sound** | `ambient_play(rain\|white_noise\|…)`, sleep timer | Alexa, Google, HomePod | Medium | S (audio files + timers) |
| **translation** | `translate(text, to)`, interpreter mode between two languages | Google, Alexa | Low–medium | S (model does it) |
| **commute and transit** | `departures(stop)`, `travel_time(to)`, leave-now notifications | Alexa, Google | Medium (depends on household) | M |
| **deliveries** | `packages_status`, notify on delivered (from email or carrier APIs, HA) | Alexa | Low–medium | M |
| **find my phone** | `ring_phone(person)` via HA companion app / ntfy | Alexa, Google, Siri | Medium | S |
| **ambient screen** | idle view: clock, running timers, next event, weather, photo frame, character | Echo Show, Nest Hub | Medium–high on screen devices | M (screen cards, see `docs/CHARACTERS.md`) |
| **shopping / ordering** | place orders, track prices | Alexa | Low (self-hosted, high risk) | L — skip |

**Suggested order** (value per effort, and dependencies): assistant controls → timers → alarms → lists → announcements → kitchen (needs timers + lists) → music → briefing → calendar → reminders + notifications. A local scheduler (timers, alarms, reminders, routines all need it) and a notification policy are the two shared pieces worth designing once.
