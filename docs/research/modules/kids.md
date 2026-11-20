# Kids: a children's mode as a module

Research write-up, 2026-11-18. Not an approved design. It uses the foundation names in [README.md](README.md) and
builds on [current-system.md](../module-investigation/current-system.md). Outside facts were checked on 2026-11-18 where
a link is given; anything else is marked **[unverified]**. This is not legal advice. Latency figures are estimates to
be measured with `TurnTrace`.

## 1. Summary

A `kids` module that makes the assistant safe and useful for the children in the house, instead of a flag:

- **age profiles** per child (bands 3–5, 6–8, 9–12, 13–17) that set persona, vocabulary, allowed tools and limits;
- a **child-safe assistant template** ("Buddy") and **tool restrictions** applied by policy, not by prompt alone;
- **bedtime stories**, generated or from an openly licensed library, with **serials** that continue night after night;
- **morning and bedtime routines** with a visual checklist and parent-defined rewards;
- **screen-time and quiet-time rules** per device and child;
- **questions answered at the child's level**, with topics the parents choose to hand back to a grown-up;
- **parental review** of the children's conversations;
- tuning for **children's voices**, and the **privacy and safety obligations**.

Boundary with [fun-and-ambient](fun-and-ambient.md): that module keeps sleep sounds, jokes, trivia, riddles, one-off
stories and idle behaviour, for everyone. This module takes over its "kids' mode" (§12 there) and adds what needs
data and rules: profiles, policy, serials, the library, routines, review. Homework help is
[learning](learning.md)'s, run with the child's settings from here.

- **Priority: first wave if children use the devices, otherwise skip** (fun-and-ambient open question 1 asks the
  same). Once children talk to a hosted model, the safety part is not optional.
- **Effort: L.** Policy enforced in core (tool filter, risk ceiling, quiet time) is M; routines and rewards M;
  stories and serials S–M; review page M. It touches routing, devices and every module's tool list.

## 2. What others do

| Product | Behaviour | Copy | Avoid |
|---|---|---|---|
| Amazon Kids on Echo (formerly FreeTime) | Child profiles, filtered content, explicit-song filter, time limits and bedtime, parent dashboard with activity **[unverified: current names]** | Time limits, bedtime, a parent dashboard | Upsell of a paid kids' subscription |
| Google Family Link on Nest | Supervised accounts, filters, "downtime" schedules **[unverified]** | Downtime per device | Voice match deciding permissions |
| Yoto, Toniebox | Story players without a screen or microphone; physical cards | A screen-free, calm bedtime | — |
| Khanmigo | Socratic tutor, parents see chats **[unverified]** | Explain-first; parents can read | — |
| Moxie, Miko robots | Companion persona for children **[unverified: status]** | — | Emotional dependence; "I love you" from a machine |
| ChatGPT, Character.ai | Teen restrictions and parental controls added after incidents in 2025 **[unverified: details]** | Hard topics routed to adults | Long open-ended companion chats |

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | Child (7), kids' room: "Buddy, why is the sky blue?" → "Sunlight has all the colours mixed. The air bumps the blue light around the most, so blue comes at us from everywhere. Cool, right?" | no |
| 2 | Bedtime: "Tell me the next Pip story." → `story_continue` → "Last time, Pip the kiwi found a map under the fern. Tonight…" four minutes, then "The end of chapter six. Sleep tight." | no |
| 3 | Morning, kitchen tablet: "What's left on my morning list?" → checklist on screen: teeth ✓, dressed ✓, bag ☐, shoes ☐. → "Bag and shoes. Two more stars and you've got your sticker!" | best with |
| 4 | "I brushed my teeth." → `routine_check` → "Ticked! Three of five." (parents may require a tap on the screen instead) | optional |
| 5 | Child: "Turn on the TV." at 20:15 with quiet time from 20:00 → "It's quiet time now. I can tell a story or play rain sounds." | no |
| 6 | A handed-back topic: "Where do people go when they die?" → "That's a big, important question. It's one to talk about with Mum or Dad. Want me to tell them you asked?" (setting: "hand back, and tell parent") | no |
| 7 | Child: "Send a message to Grandma." → kids' policy denies `message` class → "I can't send messages. Ask a grown-up to help." | no |
| 8 | Ambiguous: a child's "Play Frozen" → song, film or story? → music with explicit filter on, film only on an allowed screen in allowed hours: "The Frozen songs, or the story?" | no |
| 9 | Failure: speech misheard twice → "I didn't catch that. You can say it again, or press a picture on the screen." (big buttons: Story, Music, My list) | optional |
| 10 | Parent in admin: "Show what Sam asked this week." → list of conversations, flagged ones first. | admin |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `story_tell` | `kind: "new" \| "library"`, `about?`, `minutes?`, `serial?` | the story text streamed (generated) or the library item to play | R/W (serial state) | safe | generated: first clause 1–2 s; library: < 300 ms | yes for "the next Pip story" |
| `story_continue` | `serial?` | the serial's bible and last episode summary | R | safe | < 30 ms | yes |
| `routine_status` | `routine?: "morning" \| "bedtime" \| name`, `child?` | items with done state, stars | R | safe | < 30 ms | yes |
| `routine_check` | `item`, `child?` | updated list; reward reached? | W | changes data | < 30 ms | yes ("I brushed my teeth") |
| `rewards_status` | `child?` | stars this week, next reward | R | safe | < 30 ms | yes |
| `tell_parent` | `about` (one sentence), `child?` | queued for the parent's inbox | W | outward (to a parent) | < 30 ms | no |
| `kids_policy` (host, not a model tool) | — | the effective policy for this turn | — | — | < 5 ms | — |

The policy is not a tool the model may call or skip: the host applies it before the turn (§5.1). Parents manage
routines, rewards, serials and review in admin, not by voice on a kids' device.

## 5. Integrate or build

### 5.1 Policy, enforced by the host

Prompt-only safety is not enough. The host applies, per turn, the policy of the child in the [Tool context](../module-investigation/shared-state-jobs-and-notifications.md)
(device default person; voice is never the authority, as [fun-and-ambient §12](fun-and-ambient.md#12-interaction-with-the-rest-of-the-system)
says):

| Rule | Mechanism | Today |
|---|---|---|
| Allowed modules and tools per age band | intersected with the assistant's `modules`/`offTools` before the registry is built | assistant filter exists (current-system §3.1); intersection is new |
| Risk ceiling `read` + `change` of own data; `message`, `money`, `security` denied | risk classes ([module-definition B.5](../module-investigation/module-definition-config-and-dependencies.md)) | new |
| Safe search strict, explicit music off, no image generation, no camera | per-module settings forced by the policy | new |
| Quiet time and screen-time windows | route gate answers with a fixed sentence or limits to the allowed set (stories, sleep sounds) | new |
| Volume cap | device audio setting | new |
| Output check | a cheap second check of the reply against the handed-back topics and a word list before TTS **[proposal; cost to measure with `TurnTrace`]** | new |

### 5.2 The model behind a child's assistant

- Anthropic's [Usage Policy](https://www.anthropic.com/aup) defines a minor as anyone under 18, and its consumer
  terms bar under-18 use; organisations whose product lets minors talk to the models must follow separate
  [guidelines for organisations serving minors](https://support.claude.com/en/articles/15591275-child-safety-guidance-for-developers)
  (age assurance, moderation) **[unverified: full text not read]**. A child using the owner's **Claude subscription**
  account through Claude Code is plausibly outside the consumer terms; the **API account** under the developer
  guidelines is the cleaner path. Other providers on OpenRouter have their own terms **[unverified]**.
- A local model on the home model server avoids sending children's words out, at a quality cost.
- Recommendation: the Buddy assistant on the Anthropic API account (or home model), never the subscription account;
  the owner confirms this in the first-run steps.

### 5.3 Stories

| Source | Licence | Notes |
|---|---|---|
| Generated by the model | — | Length from minutes (about 130 words a minute for a slow bedtime pace **[estimate]**), age band, characters; streamed clause by clause like any reply |
| [StoryWeaver](https://storyweaver.org.in/about) (Pratham Books) | CC BY 4.0 | Thousands of picture books in many languages; Dutch coverage unknown; no public API found, the text exists as a [Markdown export](https://www.github.com/global-asp/pb-source) |
| Project Gutenberg (Grimm, Andersen, Aesop; some Dutch) | public domain in the US; check per country **[unverified]** | Old texts need gentle retelling for small children: the model can adapt, marked as "retold" |
| LibriVox | public domain audio | Played through [music](music.md)'s playback path |
| The household's own audiobooks (Audiobookshelf, Jellyfin) | own copies | Read-only provider, LAN **[unverified: Audiobookshelf API details]** |

**Serials**: a story bible per serial (characters, places, rules of the world, tone) plus a one-paragraph summary per
episode; the next episode is generated from the bible and the last three summaries, so it stays consistent for months.

### 5.4 Routines and rewards

Build on the [lists](lists.md) checklist model: a routine is a named checklist per child with a time window and a
reset time. Rewards are stars toward a parent-named reward ("sticker", "pick Friday's film"). Parents choose whether a
spoken "I did it" ticks an item or a screen tap is needed. No leaderboard between siblings by default.

### 5.5 Children's voices

Recognisers do worse on children: on the MyST corpus Whisper-small and -medium start near 13–14 % word errors and
reach about 9 % after fine-tuning ([Kid-Whisper](https://arxiv.org/abs/2309.07927v3)); young children and spontaneous
speech are much worse (a study reports large gaps for 4–6-year-olds **[unverified: numbers]**). In this repo:
`parakeet-v2` is English only; for a Dutch child `parakeet-ultra` or `whisper-turbo` (the latter "most robust for Dutch
in noise", preset description). Tuning for a child's hearing profile: longer `finalSilenceMs` (children pause
mid-sentence), lower `vadThreshold`, AGC on. Always offer a touch fallback on screens, and a phrase list for Jev
("next story", "my list") that matches loosely.

## 6. Data

| Collection | Scope | Schema |
|---|---|---|
| `childProfiles` | person (child) | `{ personId, birthYear, band, language, handBack: string[], homeworkMode, quietTime, screenTime }` |
| `serials` | person or device | `{ title, bible, episodes: [{ n, summary, at }], voice? }` |
| `routines` | person | `{ name, items[], window, resetAt, tickBy: "voice" \| "tap" }` |
| `routineLog` | person | `{ routine, item, at, by: "voice" \| "tap" \| "parent" }` |
| `rewards` | person | `{ goal, stars, reached[] }` |
| `conversationLog` | person (child), parents can read | `{ at, deviceId, said, replied, flags[] }`, kept 30 days by default |

`conversationLog` is the one place this system would keep conversations (current-system §4.3: none are kept today).

## 7. Long-running work and events

- [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md): routine resets each morning and
  evening; quiet-time windows start and end; nightly deletion of `conversationLog` rows past retention.
- Events: `kids.routine.checked`, `kids.reward.reached`, `kids.flag` (a handed-back topic or a blocked request), and
  `kids.quiet.changed` (screens dim, the route gate changes).
- Restart: windows are recomputed from wall-clock time; nothing is lost.

## 8. Presentation

- Routine: a big `list` with checkboxes and pictures per item, stars as `facts`; the character cheers once when a
  routine completes (only with `reply.expression`, [CHARACTERS.md](../../CHARACTERS.md) §5.2; otherwise nothing).
- Quick buttons on a kids' device (Story, Music, My list, Ask): a fixed layout, since recognition fails more often.
- Stories: no visuals by default (bedtime); optional one picture per chapter as in fun-and-ambient §8.
- Quiet time: the screen dims, the character `asleep`.
- Without a screen: routines are read out ("Two left: bag and shoes"); ticking by voice only if allowed.

## 9. Notifications and proactive behaviour

On a kids' device, opt-in per routine: "Time for your bedtime list" at the start of the window, `normal` priority,
once. To parents: a daily or weekly digest in the inbox (questions handed back, blocked requests), and `tell_parent`
items. Never proactive companionship ("I missed you").

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | the kids' policy per age band (modules, risk ceiling, filters, output check); handed-back topics; review retention; which model account children may use | strict; death, sex, violence in news, self-harm → hand back and tell parent; 30 days; API only |
| Module | story library sources; serial length; reward wording | generated + StoryWeaver; 4 min; stars |
| Assistant | Buddy template: short warm sentences, no sarcasm, never claims feelings or friendship, admits not knowing | — |
| Device | kids' device (applies the policy), which child is default, quiet-time and screen windows, volume cap | off |
| Person (child) | birth year, band, language, homework mode, routines, rewards | — |

First run: add each child as a Person, mark their devices, choose the model account, review the handed-back list,
create Buddy from the template, set routines.

## 11. Native tools and dependencies

No native binaries. Library audio needs music's playback route; without it: "I can't play recorded stories on this
speaker; I'll tell you one instead." A child's recogniser may need the larger multilingual model (1.0–1.6 GB, presets).

## 12. Interaction with the rest of the system

- **Routing.** A kids' device's `withoutPhrase` is Buddy; adult assistants stay reachable only by their phrase and,
  in the policy, only for adults' own devices.
- **Other modules under the policy.** music (explicit off), video (allowed hours, safe search), images (no
  generation), web-search (off below 9–12, or summary-only), smart-home (only the child's room lights), timers (own
  timers only), [learning](learning.md) homework (explain-first), memory (no person-scoped reads of adults).
- **Fast path.** "Next story", "what's on my list", "I did my teeth" are Jev actions; they matter more here.
- **Voice.** A slow, warm voice per Buddy; a serial may keep its own narrator voice (needs the per-voice change in
  [translation §12](translation.md#12-interaction-with-the-rest-of-the-system)).

## 13. Privacy and safety

- **Law.** A household using its own system is largely outside GDPR (Article 2(2)(c), purely household activity), but
  the hosted model provider processes children's words; in the Netherlands the age of digital consent under the GDPR
  is 16 **[unverified]**. US COPPA binds services directed at children, not a family's own server **[unverified]**.
- **Provider terms** (§5.2) are the binding constraint in practice.
- **Recordings.** "Save what the assistant hears" (`recordings/`) is forced off on kids' devices.
- **Review is transparent.** Buddy tells children, in their terms, that parents can see what they ask. Review is for
  safety, not surveillance: retention short, flags first.
- **No emotional dependence.** No claims of love or friendship; long late-night chats end with a gentle goodnight
  after a set length.
- **Guests' children** use the device's default child profile or the strictest band.
- **Disclosure of harm.** If a child says something that suggests danger, Buddy answers kindly, suggests a trusted
  adult, and raises a `high` notification to the parents. What counts is a parent decision (open question 4).

## 14. Foundations needed

- **Needed first:** People and rooms (child persons, device default person), [Tool context](../module-investigation/shared-state-jobs-and-notifications.md),
  risk classes and policy, [Module store](../module-investigation/shared-state-jobs-and-notifications.md),
  [Device capabilities](../module-investigation/presentation-and-device-capabilities.md) (kids flag, privacy).
- **Later:** [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md) (windows, resets),
  [Notification service](../module-investigation/shared-state-jobs-and-notifications.md) (digest, flags),
  [Presentation](../module-investigation/presentation-and-device-capabilities.md) (checklist, buttons), templates.
- **First version without them:** a hand-made Buddy assistant on the API account with modules switched off except
  clock and weather, bound to the kids' room device as `withoutPhrase`; stories by prompt. That is a safer start than
  waiting, and it is what fun-and-ambient §14 calls the first version too.

## 15. Open questions

1. **Are there children, and how old?** That sets the wave and the bands that matter.
2. **Which model may children talk to?** API account, home model, or none hosted? The subscription account is not
   recommended (§5.2).
3. **Parental review**: keep children's conversations at all, and for how long?
4. **Handed-back topics and danger signals**: which topics, and do parents get notified immediately?
5. **Rewards**: stars and parent rewards, or no gamification at all?
6. **Disagreement with [fun-and-ambient §5 and §12](fun-and-ambient.md#12-interaction-with-the-rest-of-the-system)**:
   it calls kids' mode "a policy and an assistant template, not a separate module". The policy must indeed live in
   the host, but profiles, serials, routines, rewards and review are module data, so this document proposes a module,
   with fun-and-ambient's kids' rows moved here.
