# Routines and automations

Research write-up, 2026-11-17. Not an approved design. It uses the shared foundations named in [README.md](README.md):
the Scheduler and Event bus from
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) ("shared
state §n"), and the Connection, Module manifest and risk policy from
[`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)
("module definition §n"). The landscape it draws on is
[`landscape-automation-platforms.md`](../module-investigation/landscape-automation-platforms.md) ("automation landscape
§n"). Inbound hooks are shared with [notifications.md](notifications.md) §7.

## 1. Summary

A **routine** is a named, owner-defined sequence of steps across modules: "good morning" reads the weather and the
first calendar event, starts the kitchen radio and tells the kids it is time to get up. It starts by voice, at a time,
on an event (alarm dismissed, timer finished), from a webhook, or on presence. The same module bridges to the tools
households already run. It calls Home Assistant scripts, n8n workflows and Node-RED flows as tools, receives their
webhooks, lets phone automations (Apple Shortcuts, Tasker) trigger it, and holds "quick commands": a spoken phrase
mapped to a template, defined in the UI without code.

- **Priority: second wave.** It needs the Scheduler, the Event bus, hooks and at least three modules worth combining
  (timers/alarms, notifications, weather, plus calendar or music). Quick commands and the n8n/HA bridge are cheap and
  could come earlier, because they need only settings and the HTTP connection.
- **Effort: M** for routines, triggers and quick commands; **S** for the automation bridge (HTTP and HA script calls);
  **M** more if the MCP client for n8n's MCP Server Trigger is in scope (that is the separate MCP bridge module,
  module definition §A.5).

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa routines | Triggers: voice phrase, schedule (incl. sunrise/sunset), smart-home device, phone location, alarm dismissed; actions across skills; a **Wait** step of up to four hours (third-party guides, [How-To Geek](https://www.howtogeek.com/732897/the-5-most-useful-actions-for-alexa-routines/); **unverified against Amazon's docs**) | Alarm-dismissed trigger. A wait step. Phrase triggers | Long waits held in memory: a guide asks what happens on power loss during a six-hour wait (no answer) |
| Google Home automations | Routines renamed **Automations**; starters, conditions, actions; household vs personal; Gemini "Help me create" writes them for Premium users ([Google](https://support.google.com/googlehome/answer/15962877?hl=en)) | Starter / condition / action vocabulary | Automations broken by the Gemini upgrade ([9to5Google](https://9to5google.com/2025/12/17/gemini-for-home-reportedly-breaks-automations/)) |
| Home Assistant | Automations = trigger → condition → action; scripts are sequences with typed `fields`, exposed to LLMs as `script__<name>` tools; blueprints are parameterised templates (automation landscape §1.3, §1.5). Webhook trigger at `/api/webhook/<webhook_id>`, `POST`/`PUT` by default, `local_only: true` by default, payload in `trigger.json` ([docs](https://www.home-assistant.io/triggers/webhook/)). Scripts can be run over REST with a bearer token, and `?return_response` returns their data ([REST API](https://contributors.home-assistant.io/core/internals/rest-api/)) | Scripts-as-tools with typed fields. LAN-only webhooks by default | A full YAML automation engine; we should not build a second one |
| n8n | Webhook node with test and production URLs, Basic / Header / JWT auth, and responses "Immediately", "When Last Node Finishes" or via a **Respond to Webhook** node ([docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)). The MCP Server Trigger exposes workflows as MCP tools (automation landscape §2.5) | "When Last Node Finishes" gives a synchronous tool call with a result | Every `$fromAI()` parameter becomes required over MCP (automation landscape §2.5) |
| Node-RED | `http in` + `http response` nodes make any flow an endpoint (automation landscape §3.3) | Same as n8n: a URL is the interface | — |
| Apple Shortcuts / Tasker | Personal automations on arrive/leave, time, NFC, Wi-Fi, CarPlay; since iOS 17 location automations can **run immediately** but always notify ([Cassinelli](https://matthewcassinelli.com/automations-run-immediately-shortcuts-notifications/)); "Get Contents of URL" / Tasker HTTP Request call us (automation landscape §10) | Phones as presence sensors and triggers without an app of ours | — |
| Raycast quicklinks, Alfred workflows | Owner-made commands with a `{argument}` placeholder that open a URL or run a script (launcher landscape §1.1, §1.4) | Typed templates, no code | — |

**Take-away:** commercial assistants make routines simple (a phrase or time plus a list of actions). Home Assistant and
n8n make them powerful. Our job is the simple layer over *our own* modules and devices, plus clean bridges to the
powerful tools, not a third automation engine.

## 3. Example conversations

S = a screen helps; it works headless too.

1. Bedroom, after the 6:45 alarm is dismissed (trigger `alarms.dismissed`, weekdays): "Good morning. It's 4 degrees
   and dry. First up: dentist at 10. Radio's on in the kitchen." The kids' room node: "Time to get up!" S: a weather
   card plus the first event.
2. Living room: "Hey Jeff, bedtime." → runs the routine: HA script `script.bedtime` (lights off downstairs, doors
   checked), DND on the bedroom node until 07:00, tomorrow's alarm read back: "Night. Your alarm is at 6:45."
3. "Hey Jeff, movie mode." → a quick command bound to the HA scene `scene.movie`: "Movie mode." There is no LLM round
   trip once the phrase is matched (§12).
4. "Hey Jeff, ask n8n for today's bin day." → calls the n8n workflow tool `n8n_bin_day` ("When Last Node Finishes")
   and speaks its `say` field: "Paper and plastic tomorrow." A filler plays if it takes more than 700 ms.
5. Ian's phone, Shortcuts *Leave work* automation → `POST /hooks/leaving-work` → the routine "Ian's on his way":
   kitchen device "Ian left work, home in about 30 minutes", and the hallway lights go on at sunset via HA.
6. Siri on Ian's iPhone: "Hey Siri, ask Jeff to add oat milk to the shopping list." → a shortcut posts the dictated
   text to a `text` hook, which runs it as a typed turn for the chosen assistant; the reply goes back as the HTTP
   response, and Siri speaks it.
7. Ambiguous: "Run good night." when both "good night" (adults) and "good night kids" exist → "Good night, or good
   night kids?"
8. Failure: "Bedtime." while Home Assistant is unreachable → steps run in order; the failed step is reported, the rest
   still run: "Done, except the lights: Home Assistant didn't answer."
9. Creating by voice: "Every Friday at five, announce that it's pizza night." → "I've drafted a routine 'pizza night':
   every Friday at 17:00, announce 'it's pizza night'. Switch it on in the admin page, or say 'switch on pizza night'
   on a trusted device." (See §13 for why it is a draft.)
10. "What routines do I have?" → "Good morning, bedtime, movie mode and pizza night (off)." S: a list with switches.

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `routines_run` | `name: dynamic` (routine names and phrases), `args?: record` (declared routine fields) | a summary of the step results, and each step's own `say` as it happens | W | the highest risk among its steps | step sum; first audio < 300 ms (target, to be measured) | yes (exact phrase) |
| `routine_<slug>` (one tool per routine with `exposeAsTool`, like HA's `script__<name>`) | the routine's typed fields | as above | W | as above | as above | yes |
| `routines_list` | `filter?: choice` (on, off, all) | names, triggers, on/off | R, speculative | safe | < 10 ms | yes |
| `routines_switch` | `name`, `on: boolean` | "Pizza night is on." | W | changes data; trusted device only | < 20 ms | yes |
| `routines_draft` | `name`, `trigger` (structured), `steps` (structured, only from the action catalogue) | the draft echo | W (draft only) | changes data | < 50 ms | no (model-built) |
| `routines_history` | `name?`, `limit?` | last runs with per-step outcome | R, speculative | safe | < 10 ms | no |
| `<bridge>_<name>` (one per configured n8n / Node-RED / HTTP endpoint) | fields declared in the UI (text, number, choice) | the endpoint's JSON `say` / `data` | as declared | owner-declared risk (default outward-facing) | network: 100 ms–10 s, timeout per endpoint | no |
| `ha_script_<name>` (scripts the owner ticks, via the HA connection) | the script's `fields` | the response data | W | owner-declared (default changes data) | 50–500 ms LAN | no |

Steps are **actions from the turn's action catalogue** (`ActionDefinition`s of running modules, current-system.md
§2.4), plus a few built-in steps:

| Built-in step | Meaning |
|---|---|
| `say` | speak fixed text on a device |
| `announce` | through notifications |
| `wait` | a scheduler job, so it survives a restart |
| `ask` | one LLM turn with a prompt template, e.g. "summarise today's calendar in one sentence"; the only step that uses a model |
| `call` | a bridge endpoint |
| `if` | one condition from a closed set: time window, weekday, person present, device in DND, quiet hours, a state read from a speculative action's result equal to a value |
| `set_dnd` | through notifications |
| `stop_if_failed` | stop the routine when the previous step failed |

No loops and no variables beyond declared fields. That boundary is deliberate (§5).

## 5. Integrate or build, and how far to go

| Concern | Leave it to | Why |
|---|---|---|
| "When motion in the hallway after sunset, light on for 2 minutes" | Home Assistant | Device state, sensors, sub-second local triggers, HA already does it well and the household's automations live there |
| "When an email from the school arrives, summarise it and post to Telegram" | n8n | Many services, credentials, parsing, retries |
| Flows with branches, loops, maths | n8n / Node-RED / HA scripts | A general engine is years of work (automation landscape §13) |
| Sequences of **our** actions on **our** devices, triggered by voice, our alarms and timers, our clock | **Build: routines** | Needs our device targeting, quiet hours, the spoken summary, and must not depend on an outside service for "good morning" |
| Calling outside flows as tools, receiving their events | **Build: the bridge** (thin) | Small; gives the long tail without writing integrations (automation landscape §14, `automation-bridge`, `phone-triggers`) |
| Being called by outside flows ("announce on the kitchen node") | **Build: hooks** | The washing machine case; also our part of HA and n8n flows |
| Third-party MCP servers (n8n MCP Server Trigger, Windmill MCP) | The separate MCP bridge module (module definition §A.5) | Not routines: process isolation, allowlists, trust (launcher landscape §4) |

**Recommendation:** build a small sequencer with the closed step set above, four trigger kinds, quick commands, and a
thin HTTP / HA-script bridge. Write it down as a rule that **anything needing a loop, a variable or a sensor belongs in
HA or n8n**, and make it easy to call those from a routine and to call us from them. Effect's `Cron` (stable) handles
schedules. Persistence of in-flight waits uses the Scheduler, not Effect workflows (shared state §2.2).

## 6. Data

Routines are **owner configuration**, so their definitions live with settings (`settings.json`, edited in admin, as a
`records` field, which is BUILT, NOT WIRED on module forms today, current-system.md §6.2). Runs and drafts are data, so
they go in the Module store.

```ts
// Proposal: a routine definition (settings)
{ id: "good-morning"; name: "Good morning"; on: boolean
  phrases: ["good morning", "goedemorgen"]          // quick-match phrases (also wake-route style matching)
  exposeAsTool: boolean; fields?: Record<string, { kind: "text" | "number" | "choice"; options?: string[] }>
  triggers: Array<
    | { kind: "voice" }                               // via phrases or the tool
    | { kind: "time"; cron: string; tz?: string }     // "0 7 * * 1-5"
    | { kind: "event"; type: "alarms.dismissed" | "timers.finished" | "presence.changed" | string; where?: Record<string, string> }
    | { kind: "hook"; hookId: string }
    | { kind: "presence"; person: PersonId; event: "arrive_home" | "leave_home" }>
  runOn: { device: "trigger" | DeviceId | { room: string } }   // where `say` steps speak
  steps: ReadonlyArray<Step>; risk: "derived"; owner: PersonId | "household" }
```

| Store collection | Scope | Content |
|---|---|---|
| `routineRuns` | household | routine id, trigger, actor (`turn`, `job`, `hook`), started, per-step result and ms, outcome; 30 days |
| `routineDrafts` | person | drafts made by voice, waiting for the owner |
| `bridgeEndpoints` | settings | name, URL, method, auth (vault reference), declared fields, timeout, risk |
| `quickCommands` | settings | phrase(s), kind (`say`, `routine`, `url`, `ha_service`, `ask`), template with `{placeholders}` |

Exports: `routines.list` (names and phrases, for the briefing and for Jev's phrase table).

## 7. Long-running work and events

- **Time triggers** are `recurring` Scheduler jobs with handler `routine.run`, missed policy "run the last missed
  occurrence once if within 30 minutes, otherwise skip and log". A 7:00 "good morning" at 11:00 is wrong.
- **Wait steps** are `deferred command` jobs carrying the run id and step index. After a restart the run resumes at the
  next step. A step with side effects that is more than 10 minutes late is skipped and reported, not run (shared state
  §6.1).
- **Event triggers** subscribe through `events.subscribe` (shared state §5) in the module's scope. A storm guard runs a
  routine at most once per 60 s per trigger, configurable.
- **Hook triggers** go through the host hook endpoint (notifications.md §7). A routine hook may answer synchronously
  with the run summary (Shortcuts shows or speaks it) if the routine finishes within 10 s; otherwise it answers
  `202 Accepted` with a run id.
- **Events published:** `routines.started`, `routines.step`, `routines.finished` (ok, partial, failed),
  `quickcommand.run`.
- A run is a fiber in the Scheduler's scope (like `task` jobs), not the turn's, so barge-in on the announcing device
  stops the speech but not the routine. "Stop the routine" cancels it.

## 8. Presentation

- **Screen:** while a routine runs, a `progress` pinned item ("Good morning · 3 of 5") in Orbit. Step presentations
  (the weather card, the first event) appear in turn via the normal reveal rule (presentation §3.6). At the end, a
  short `facts` summary if a step failed.
- **Admin, not the stage:** editing routines is an admin page built from the existing field types plus `records` and a
  step list; there is no module UI code in the browser (module definition §A.2).
- **Headless:** only the spoken steps and a soft "done" earcon. Silent routines (lights only) confirm with the HA-style
  beep when everything happened in the device's own room (landscape-voice-assistants.md §4(c)), else "Done".

## 9. Notifications and proactive behaviour

Scheduled and event-triggered routines are the main source of *unprompted* speech, so they are bound by the
notification rules. A `say` step from a non-voice trigger is sent as an `Announce` at priority `normal` (owner may set
`high` per routine), and it waits for an idle device, respects quiet hours and DND, and lands in the inbox when held.
A failed scheduled routine sends a `low` item to the owner's inbox ("Bedtime ran at 23:00; Home Assistant didn't
answer"). Nothing is spoken for a routine that ran fully silently.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | routines list; hooks; bridge endpoints; quick commands; who may switch routines on | — ; owner only |
| Module | missed-run window (30 min); late side-effect limit (10 min); storm guard (60 s); bridge default timeout (5 s); max steps (20) | as stated |
| Assistant | module on/off; which routines it may run (all / chosen), `offTools` | all |
| Device | `trusted` for switching routines and running routines with `security` steps (module definition §B.5 `allowRisky`) | off |
| Person | own routines ("Ian's morning") | — |

**Connections:** Home Assistant (scripts, scenes, presence), and per bridge endpoint a header or bearer token in the
vault, as an HTTP Connection type ("n8n instance": base URL + header auth, with a test call). **First run:** create one
routine from a template ("Good morning": weather, first event, radio) in admin; optionally tick HA scripts to expose.

## 11. Native tools and dependencies

None on the server. The bridges depend on the owner's services, declared as optional services with health probes
(module definition §C.3): an HA ping, and a `HEAD` or test call per n8n / Node-RED endpoint. Missing service, spoken:
"The bedtime routine needs Home Assistant, which isn't answering. I did the rest." Missing module for a step (music
off): the step is skipped and the admin card shows "Step 3 needs the music module".

## 12. Interaction with the rest of the system

- **Fast path:** routine phrases and quick-command phrases are exact or close matches, like wake phrases (the RouteGate
  matcher, current-system.md §3.3). Proposal: after the wake phrase, an utterance that matches a routine phrase runs it
  without any agent. That is the cheapest LLM-free path and does not wait for Jev. Measure `TurnTrace` from end of
  speech to first audio. Unmatched utterances go on to normal routing.
- **Speech recognition:** routine names should be distinctive. Admin warns when a phrase is close to another
  routine's, a wake phrase or a common command ("stop").
- **Fillers:** a bridge call longer than 700 ms gets a filler ("One moment."); the bridge timeout default is 5 s.
- **Model:** with `exposeAsTool`, routines appear to the model as tools, so "can you do the bedtime thing" works. The
  module's instructions say: prefer a routine when the request matches one.
- **Agents:** the Claude subscription harness sees routine tools as `mcp__assistant__routine_bedtime` (current-system.md
  §2.6). Jev gets routines as actions with their phrases as `examples`.
- **Other modules:** timers and alarms (`alarms.dismissed`), notifications (announce, DND, hooks), reminders (presence
  events), home-assistant (scripts, scenes), weather, calendar, music, briefing. A briefing could be a routine with
  `ask` steps rather than its own module; see open question 6.
- **Actor kind:** shared state §4.5 defines `Actor` as `turn | job | admin | ui`. Routines triggered by hooks need a
  `hook` actor (hook id, caller IP), so that logs and policy can tell them apart. That is an addition to the
  foundation.

## 13. Privacy and safety

- **Risk is derived:** a routine's risk is the highest of its steps (module definition §B.5). With household defaults
  (`message: confirm`, `money` / `security: deny`), a routine with a door-lock step cannot run from an untrusted
  device, a hook or a schedule unless the owner explicitly allows that routine. Because core confirmations are off
  today (current-system.md §2.5), `confirm` steps cannot run inside routines at all until confirmations come back.
- **Voice-created routines are drafts.** A routine runs unattended later with the owner's authority. A misheard
  "every day at 3 am announce…" must not go live from a TV in the room. Drafts are switched on in admin or on a trusted
  device.
- **Hooks** run only owner-defined steps with declared fields. Field values are data, substituted into step
  parameters through the action's typed params (validated). They are never put into an `ask` prompt as instructions
  without the wrapping label.
- **Bridge endpoints** are outward-facing by default: they send household data to n8n or Node-RED. The admin page shows
  what each one sends.
- Children: may run routines marked "for everyone", may not switch routines or create drafts.

## 14. Foundations needed

Scheduler (time triggers, waits), Event bus (event triggers), Notification service (announce, DND, inbox), Module
store (runs, drafts), Connection (HA, HTTP endpoints), Requirements and health (bridge probes), Tool context (the
trigger device), Presentation (`progress`), Device capabilities (where `say` goes), plus the host hook endpoint and the
`records` settings field wired to module forms.

**A useful first version without most of them:** quick commands and voice-triggered routines whose steps are existing
actions (HA lights, weather `today`, clock) and `say`. They are matched by phrase and run in the turn, defined as
settings. Add HA script calls and HTTP bridge endpoints as tools. No time triggers, waits or hooks yet. That needs only
the `records` field and the phrase match.

## 15. Open questions

1. **How far to go:** is a closed step set with one-condition `if` and no loops enough, with everything else in Home
   Assistant or n8n? Or do you want branching in our routines?
2. **Do you run n8n or Node-RED today, and which HA scripts would you expose?** That decides whether the bridge comes
   before routines.
3. **Voice-created routines:** drafts confirmed in admin (proposed), or allowed live from a trusted device?
4. **Phrase fast path:** should routine phrases bypass every agent after the wake phrase (fast, but "bedtime story"
   could trigger "bedtime"), or go through Jev/the model?
5. **Phones:** Shortcuts and Tasker posting to hooks requires the server reachable from the phone. LAN/VPN only, or
   behind the HTTPS name from outside?
6. **Briefing:** a routine template with `ask` steps, or its own module (automation landscape §14 lists `briefing` as a
   separate S module)? This document leans to a template plus a small `briefing` action, so it is not built twice.
7. **Where definitions live:** routines as settings (proposed, editable and backed up with config) or as Module store
   data (editable by voice, versioned with the change log)? Module definition §A.2 and shared state §4 do not settle
   this for owner-authored records.
