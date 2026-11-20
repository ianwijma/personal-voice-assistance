# Module research

One document per candidate module. These are research write-ups to choose from, not approved designs.
The overall findings and the build order are in [`../module-investigation/investigation.md`](../module-investigation/investigation.md).

## Shared foundations the module documents refer to

Each foundation is worked out once, in `../module-investigation/`. Module documents use these names and link to the document instead of redesigning it.

| Name | What it is | Worked out in |
|---|---|---|
| Module manifest | `defineModule` plus the proposed optional fields (`requires`, `connections`, `storage`, `health`, `templates`) | `module-definition-config-and-dependencies.md` |
| Connection | A typed, tested link to an outside account or service (Google, Spotify, Grocy), kept in the vault and shared by modules | `module-definition-config-and-dependencies.md` |
| Requirements and health | Declared native tools and services, probes, the `unavailable` state, `pva doctor` | `module-definition-config-and-dependencies.md` |
| Module store | Namespaced SQLite storage per module with scopes household / person / assistant / device / conversation | `shared-state-jobs-and-notifications.md` |
| Scheduler | Jobs that outlive a turn and a restart (timers, alarms, recurring and long tasks) | `shared-state-jobs-and-notifications.md` |
| Event bus | Module events that front ends and other modules subscribe to | `shared-state-jobs-and-notifications.md` |
| Notification service | Priorities, targeting, quiet hours, inbox, announce | `shared-state-jobs-and-notifications.md` |
| Tool context | Which device, assistant, conversation and person called a tool | `shared-state-jobs-and-notifications.md` |
| Presentation | The fixed set of visual kinds a tool can return, and how the character shares the stage with them | `presentation-and-device-capabilities.md` |
| Device capabilities | What a device declares it has (display, speaker, room) and how output degrades without it | `presentation-and-device-capabilities.md` |

The second round of documents also asks for core pieces that are not in this table (images in tool results, a
reading session, capture mode, a voice per language, call audio relay, a callback API, module widgets, companion
pairing and others); they are listed in [investigation §6](../module-investigation/investigation.md#6-foundations).

What exists in the code today is in `../module-investigation/current-system.md`.

## Template

Every module document has these sections, in this order.

1. **Summary** — what the module is for in two or three sentences, a priority suggestion (first wave / second wave / later / skip) and a rough effort (S, M, L, XL) with the reason.
2. **What others do** — how existing assistants, automation tools and apps handle this domain, with links. What to copy and what to avoid.
3. **Example conversations** — five to ten spoken exchanges, including a failure and an ambiguous one. Mark which need a screen.
4. **Tools** — a table: tool name, parameters, what it returns, read or write, risk class (safe / changes data / outward-facing or costly), expected latency, whether it must work without the language model (fast path).
5. **Integrate or build** — options for the backing service or library, trade-offs, a recommendation.
6. **Data** — what the module stores, in which scope, the rough schema, what other modules may read.
7. **Long-running work and events** — jobs it schedules, events it emits and listens to, what happens across a restart.
8. **Presentation** — what it shows on a device with a screen (which presentation kinds, how the character is involved), and what it says on a device without one.
9. **Notifications and proactive behaviour** — what it may say unprompted, at which priority, on which devices.
10. **Configuration** — a table of settings by layer: household (global), module, assistant, device, person. Secrets and connections it needs. First-run setup steps for the owner.
11. **Native tools and dependencies** — binaries, services, models, API keys; where each must live (server or the device with the speaker or screen); how the module behaves when one is missing, including the sentence the assistant speaks.
12. **Interaction with the rest of the system** — voice (speech recognition quirks, names and numbers, fillers for slow tools, interruption), the character, agents and assistants (whether it ships an assistant template and its persona, which assistants should get it), intents and wake routes, other modules.
13. **Privacy and safety** — personal data on shared devices, confirmation for risky actions, guests and children.
14. **Foundations needed** — which shared foundations must exist first, and what a useful first version is without them.
15. **Open questions** — decisions for the owner.

## Ranking

All 55 modules from most to least useful. This is the lead's judgement, not a measurement. It weighs how often a
household would use the module, whether it is on the owner's wish list, how much other modules depend on it, and
what it costs to build and keep working. The first-round modules were chosen as the obvious candidates, so most of
them rank above the second-round ones. Modules whose rank depends on the household (children, a dynamic energy
contract, an existing media stack) are marked.

**Tier 1: the assistant feels incomplete without these**

| # | Module | Why here |
|---|---|---|
| 1 | [assistant-controls](assistant-controls.md) | "Stop" and volume are used every day and must never fail; everything else is judged by them |
| 2 | [timers-and-alarms](timers-and-alarms.md) | The most used feature of every voice assistant, and the first user of the store and scheduler |
| 3 | [core-tools](core-tools.md) | Calculator, time and lookups: cheap, no foundations needed, used constantly |
| 4 | [web-search](web-search.md) | Turns "I don't know" into an answer; no foundations needed |
| 5 | [lists](lists.md) | Shopping and to-do lists are daily household use, and the kitchen depends on them |
| 6 | [notifications](notifications.md) | Every module that speaks unprompted needs it; nothing proactive works without it |
| 7 | [kitchen](kitchen.md) | Top of the wish list, and the one domain where a language model clearly beats older assistants |
| 8 | [music](music.md) | The single most common request to a smart speaker; held back only by its effort |
| 9 | [smart-home](smart-home.md) | Already exists; extending it is cheap and it supplies rooms, presence and events to others |
| 10 | [reminders](reminders.md) | Daily use, small once timers exist |

**Tier 2: clearly worth building**

| # | Module | Why here |
|---|---|---|
| 11 | [images-and-photos](images-and-photos.md) | The "picture of a kiwi" case and the pilot for everything shown on a screen |
| 12 | [calendar](calendar.md) | "What's on today" is a daily question and the briefing needs it |
| 13 | [memory-and-notes](memory-and-notes.md) | Makes the assistant personal; small once the store exists |
| 14 | [google](google.md) | On the wish list; high value, but the sign-in setup is the hardest of any module |
| 15 | [t3-code](t3-code.md) | On the wish list; useful to the owner alone, and the integration surface is confirmed |
| 16 | [broadcast](broadcast.md) | The owner's idea; live broadcast is a small step on top of announce and is used daily in a family |
| 17 | [briefing](briefing.md) | Cheap, because it only composes what other modules already know |
| 18 | [local-info](local-info.md) | Weather is a top-five request; the rest of the module is optional extras |
| 19 | [presence-and-people](presence-and-people.md) | Little use on its own, but person records and rooms unblock a dozen other modules |
| 20 | [news-and-feeds](news-and-feeds.md) | The owner's idea; the feeds-only version is small and feeds the briefing |
| 21 | [routines-and-automations](routines-and-automations.md) | "Good morning" and "bedtime" tie the other modules together |
| 22 | [mcp-client](mcp-client.md) | One module that brings hundreds of outside tools, at the cost of trust and prompt size |
| 23 | [calls-and-intercom](calls-and-intercom.md) | The owner's idea; the audio intercom stage is good value, the later stages are large |

**Tier 3: good, for the right household or after the basics**

| # | Module | Why here |
|---|---|---|
| 24 | [video](video.md) | Wanted, but only on screens, and YouTube's terms limit what is allowed |
| 25 | [automation-platforms](automation-platforms.md) | Lets n8n and Node-RED do the long tail so we do not build it; needs one of them running |
| 26 | [dashboard](dashboard.md) | Makes a screen useful all day, not only while talking; large |
| 27 | [messaging](messaging.md) | Useful, but every send needs confirmation and the popular channel (WhatsApp) is closed |
| 28 | [vision](vision.md) | Barcode scanning feeds the pantry; needs a camera and a decision on sending frames out |
| 29 | [homelab](homelab.md) | Fits this owner well; read-only status is cheap, actions are risky |
| 30 | [contacts](contacts.md) | A supporting module: needed by calls and messaging, rarely asked for directly |
| 31 | [dev-tools](dev-tools.md) | Fits this owner; read-only and small, but a phone already shows the same |
| 32 | [computer-control](computer-control.md) | A good Raycast-style idea, but it needs a companion program on every computer |
| 33 | [podcasts-and-audiobooks](podcasts-and-audiobooks.md) | Good if the household listens; rides on the music playback path |
| 34 | [cameras-and-security](cameras-and-security.md) | The doorbell picture is the valuable part; needs cameras and Frigate or Home Assistant |
| 35 | [dictation-and-transcription](dictation-and-transcription.md) | Dictation and memos are handy; meeting transcripts bring consent problems |
| 36 | [energy-and-vehicle](energy-and-vehicle.md) | High value on a dynamic tariff or with solar or a car, little otherwise |
| 37 | [emergency-and-safety](emergency-and-safety.md) | The alarm relay is cheap and matters; the rest must be reliable or not exist |
| 38 | [network](network.md) | "Why is the internet down" and the guest Wi-Fi code are good; the rest is rarely used |

**Tier 4: nice to have**

| # | Module | Why here |
|---|---|---|
| 39 | [focus-and-productivity](focus-and-productivity.md) | A focus session is a timer with extras; time tracking has better tools already |
| 40 | [fun-and-ambient](fun-and-ambient.md) | Sleep sounds get real use; the rest is charm, not need |
| 41 | [documents](documents.md) | Occasional use, sensitive data, and only with Paperless-ngx running |
| 42 | [read-aloud](read-aloud.md) | Pleasant, but needs a new long-reading speech path for one feature |
| 43 | [translation](translation.md) | The model already answers "how do you say"; interpreter mode is large and rarely needed at home |
| 44 | [media-requests](media-requests.md) | Small and fun if the media stack is already running, pointless otherwise |
| 45 | [home-maintenance](home-maintenance.md) | Reminders and notes cover most of it; someone has to enter the inventory |
| 46 | [kids](kids.md) | Moves to tier 1 if children use the devices; otherwise skip. Large and carries obligations |
| 47 | [learning](learning.md) | Good for one motivated person; the model alone already does much of it |
| 48 | [health-and-fitness](health-and-fitness.md) | Sensitive data and medical limits; habit and medication reminders are covered by reminders |

**Tier 5: skip unless there is a specific wish**

| # | Module | Why here |
|---|---|---|
| 49 | [trips](trips.md) | Large, used a few times a year, and airline apps already do it |
| 50 | [tabletop-and-games](tabletop-and-games.md) | Scores and dice are trivial additions; the game master is a hobby project of its own |
| 51 | [printers](printers.md) | Rare use; every printer needs its own adapter |
| 52 | [grocery-shopping](grocery-shopping.md) | Rests on one unofficial supermarket client, and checkout still happens in the store's app |
| 53 | [finance](finance.md) | Read-only answers a phone gives faster, about data that should not be spoken aloud |
| 54 | [plants-and-pets](plants-and-pets.md) | The feeding log is a list; the rest is Home Assistant's job |
| 55 | [browser-tasks](browser-tasks.md) | About half of tasks fail on a new site, it is heavy on the server, and it may not submit anything anyway |

## Index

55 documents, grouped by theme. Wave and effort as each document's §1 gives them. The overview, with the
foundations, disagreements and the order of work, is
[`../module-investigation/investigation.md`](../module-investigation/investigation.md#7-module-catalogue).

**Basics**

| Module | What it covers | Wave | Effort |
|---|---|---|---|
| [assistant-controls](assistant-controls.md) | Stop, cancel, repeat, volume, mute, switch assistant, sleep, show-on, find my phone | first (the very first) | M |
| [core-tools](core-tools.md) | Calculator with units and currency, time and dates, Wikipedia lookup, random, system status | first | M (built from S pieces) |
| [timers-and-alarms](timers-and-alarms.md) | Named timers and alarms as household data, ringing on devices, controllable anywhere | first | M (L in practice) |
| [reminders](reminders.md) | Reminders at a time, on a repeat, on arrival, for another person | first | M (+M presence) |
| [web-search](web-search.md) | `web_search`, `read_page` and background `research` with pluggable providers | first | M (research L) |
| [translation](translation.md) | Interpreter mode, camera text, translated subtitles and a phrasebook | second (phrasebook and camera text earlier) | L (phrasebook S) |

**Household and people**

| Module | What it covers | Wave | Effort |
|---|---|---|---|
| [presence-and-people](presence-and-people.md) | `Person` records, home/away and room presence, speaker-ID hint, guest mode | first for records and home/away; second for rooms; later voice ID | M (first version S) |
| [contacts](contacts.md) | Household address book: aliases, pronunciation, relations, channels, dates; a name resolver for other modules | second; first slice with `Person` records | M |
| [lists](lists.md) | Shopping, to-do and named lists, chores; a `Lists` service for other modules | first | M |
| [kitchen](kitchen.md) | Pantry ledger, recipes, "what can I make", guided cooking, meal plan, the Chef assistant | first (after timers and lists) | L |
| [grocery-shopping](grocery-shopping.md) | The shopping list into a supermarket cart or order (Picnic first): matching, offers, slots | later, only if the household orders online | M (L with ordering) |
| [calendar](calendar.md) | Provider-neutral calendar: agenda, free time, add or change, event reminders | first | M (L with every provider) |
| [memory-and-notes](memory-and-notes.md) | Remembered facts, voice notes, journal; pinned memories in each turn | first (after Module store) | M |
| [documents](documents.md) | Answers from household paperwork in Paperless-ngx and folders: facts, manuals, warranties, hand-off | second | M (QA over manuals L) |
| [home-maintenance](home-maintenance.md) | Appliances, warranties, maintenance schedules, where things are kept, troubleshooting from manuals | second | M |
| [plants-and-pets](plants-and-pets.md) | Care logs for pets, plants and garden, HA pet and plant devices, plant identification | later; feeding log second | S–M |
| [finance](finance.md) | Budget and spending questions from Actual, Firefly III or YNAB, cash logging; never moves money | later, only with an existing budget | M (L in full) |

**Communication**

| Module | What it covers | Wave | Effort |
|---|---|---|---|
| [notifications](notifications.md) | Announce and intercom, the inbox by voice, do-not-disturb, phone channels, inbound hooks | first (in two parts) | L |
| [broadcast](broadcast.md) | One-way house-wide messages with replies, chimes, voice messages for a person, scheduled broadcasts | first for live broadcast; second for the rest | M (live broadcast S) |
| [calls-and-intercom](calls-and-intercom.md) | Two-way audio and video between house devices, later groups, phones and outside callers | second for audio intercom; later for video and phones | XL in four stages (stage 1 M) |
| [messaging](messaging.md) | Mail outside Google, Telegram, Signal, Matrix, SMS; contacts; read-back and confirmation | second | M (+S per channel) |
| [emergency-and-safety](emergency-and-safety.md) | "Call for help" escalation, check-ins, smoke/CO/gas/leak alarm relay, medical card | first for the alarm relay; second for help and check-ins | M (L with check-ins and SMS) |
| [google](google.md) | One Google account: mail, contacts, Drive; provider for calendar and tasks | first (after Connection) | L |

**Information and reading**

| Module | What it covers | Wave | Effort |
|---|---|---|---|
| [briefing](briefing.md) | Morning, evening and "what did I miss" digests, news feeds, page watchers | first on request; second scheduled | S (M in full) |
| [news-and-feeds](news-and-feeds.md) | RSS and Atom subscriptions, headlines, story clustering, page watchers, keyword alerts; feeds the briefing | first for feeds and headlines; second for alerts and clustering | M (feeds only S) |
| [local-info](local-info.md) | Weather extensions, places and travel, bin day, parcels, markets and sports | weather first; travel and bin day second; parcels later | S per part; travel and parcels M |
| [trips](trips.md) | Trips with segments, flight and train status, packing lists, leave-by times, holiday mode | second, after calendar, mail and travel | L (manual trip M) |
| [read-aloud](read-aloud.md) | Articles, read-later items and ebook chapters read aloud for minutes, with resume and highlighting | second | L (first version M) |
| [dictation-and-transcription](dictation-and-transcription.md) | Long dictation, voice memos, diarised meeting transcripts and summaries, room captions | second for dictation and memos; later meetings and captions | M (meetings add L) |

**Media and play**

| Module | What it covers | Wave | Effort |
|---|---|---|---|
| [music](music.md) | Music, radio and podcasts over Music Assistant, Spotify and others, per room | first | L (first version M) |
| [podcasts-and-audiobooks](podcasts-and-audiobooks.md) | Podcasts and audiobooks with a per-person resume position across devices, speed, chapters, sleep | second | M |
| [video](video.md) | YouTube and Jellyfin/Plex on house screens or cast to TVs, transcript summaries | second | M (L) |
| [media-requests](media-requests.md) | Seerr requests, *arr status, library, recommendations and upcoming releases | later; second if the owner runs the stack | M |
| [images-and-photos](images-and-photos.md) | Pictures of things, generated images, Immich photos, camera snapshots, photo frame | first (Presentation pilot) | M |
| [fun-and-ambient](fun-and-ambient.md) | Sleep sounds, games and trivia, stories, kids' mode, idle character behaviour | later | S–M |
| [tabletop-and-games](tabletop-and-games.md) | Score keeping, game clocks, dice, rules lookup, a game master, multi-room party games | later; scores and dice earlier | M (L with game master) |

**Family and wellbeing**

| Module | What it covers | Wave | Effort |
|---|---|---|---|
| [kids](kids.md) | Age profiles, a host-enforced children's policy, stories, routines, parental review | first if children use the devices, otherwise skip | L |
| [learning](learning.md) | Language practice, spaced-repetition flashcards, quizzes from own material, homework help | second | M (L with Anki and pronunciation) |
| [health-and-fitness](health-and-fitness.md) | `wellbeing` (habits, medication, breathing) and `fitness` (guided workouts, outside data) | second; outside data later | L (`wellbeing` M) |
| [focus-and-productivity](focus-and-productivity.md) | Focus sessions with do-not-disturb and scenes, time tracking, planning, task capture | second; planning later | M |

**Home, screens and devices**

| Module | What it covers | Wave | Effort |
|---|---|---|---|
| [smart-home](smart-home.md) | Home Assistant: more domains, rooms, locks and alarms, presence, cameras, energy, events | first | M (L for everything) |
| [cameras-and-security](cameras-and-security.md) | Doorbell with a picture, camera view and description, visit history, message at the door, arming | second | M (L with live view and talk) |
| [energy-and-vehicle](energy-and-vehicle.md) | Solar, use and prices, cheapest-window planning, appliance starts, car charging, heat pump | second; price slice early on a dynamic contract | M |
| [network](network.md) | Devices, guest Wi-Fi QR, pauses, DNS filter, and why the internet is down | second; outage and guest QR could be first | M |
| [printers](printers.md) | Paper, label and receipt printing, scanning to Paperless, 3D printer status and control | later for paper; second for 3D | M |
| [vision](vision.md) | The camera on request: what is this, read text, barcodes, plants, fixed views | second | M (L with a local model) |
| [dashboard](dashboard.md) | The ambient home screen: widgets from modules per device, near and far, night mode | second, after Presentation; fixed first version with the pilot | L (fixed first version M) |

**Automation, computers and code**

| Module | What it covers | Wave | Effort |
|---|---|---|---|
| [routines-and-automations](routines-and-automations.md) | Owner-defined step sequences, quick commands, bridge to HA scripts and n8n | second | M (bridge S) |
| [automation-platforms](automation-platforms.md) | n8n, Node-RED, HA scripts and Windmill as typed tools, plus a callback API for flows | second, with routines; callback `say` earlier | L (n8n and HA scripts M) |
| [mcp-client](mcp-client.md) | Any MCP server's tools, with allowlists, trust levels and a tool budget | second | L (read-only HTTP M) |
| [browser-tasks](browser-tasks.md) | Delegated background jobs in a server browser, with questions, a commit gate and recipes | later (third wave) | L |
| [computer-control](computer-control.md) | Raycast-style control of the owner's computer through a companion agent (`pva-desk`) | second | L (Linux first version M) |
| [t3-code](t3-code.md) | T3 Code threads by voice: status, dictate, stop, answer, "tell me when done" | second | M |
| [dev-tools](dev-tools.md) | Pull requests, CI, deploys, Sentry, on-call and an overnight digest, read-only | second | M |
| [homelab](homelab.md) | Proxmox, Docker, systemd, monitors, alerts, UPS and updates, with owner-named actions | second | M (L with every backend) |
