# Automation platforms

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md)
and builds on [`landscape-automation-platforms.md`](../module-investigation/landscape-automation-platforms.md)
("automation landscape §n"). Outside facts carry inline links checked on this date. **[unverified]** marks a claim not
confirmed against a primary source. Latency figures are estimates to be measured with `TurnTrace`.

## 1. Summary

This module turns the household's automation software into a first-class peer of the assistant. It covers n8n,
Node-RED, Home Assistant scripts, Windmill, Activepieces, Huginn, Apple Shortcuts and Tasker. Two directions:

- **Outward:** it lists workflows on each platform, and the owner ticks which ones to expose. Each becomes a tool with
  typed parameters, taken from the platform where it has a schema. It runs them, follows long executions and reports
  the result.
- **Inward:** it gives the workflows a **callback API**. A flow can speak on a device, notify someone, show a
  presentation, or ask a question and wait for the spoken answer.
- **Packages:** we publish three of our own: an n8n community node, a Node-RED node, and a Home Assistant custom
  integration that exposes our devices as `assist_satellite`, `media_player` and `notify` entities.

**Boundaries.**

- [routines-and-automations.md](routines-and-automations.md) owns our own step sequences, quick commands, hooks as
  routine triggers, and the *thin* bridge: endpoints the owner declares by hand. This module replaces that bridge with
  discovered, typed, long-running integrations. Routines call its tools as `call` steps.
- [mcp-client.md](mcp-client.md) owns generic MCP servers. This module reuses its transport for n8n's and Windmill's
  MCP endpoints, but handles them as automation platforms: executions, status, callbacks.
- [notifications.md](notifications.md) §7 owns `/hooks/<id>`. The callback API sits next to it and delivers through
  the same Notification service.

**Priority: second wave**, with routines. The callback API's `say` and `notify` can come earlier, as soon as the
Notification service's announce exists, because every n8n or HA user asks for "announce on the kitchen speaker" first.

**Effort: L in total.** Core plus n8n and HA scripts is M; each further adapter S; the Node-RED and n8n nodes S–M each;
the HA custom integration M–L, because it is Python outside our workspace.

## 2. What others do

| Platform | How a workflow is listed and run | Long runs and waiting | Copy | Avoid |
|---|---|---|---|---|
| **n8n** | Public REST API at `/api/v1`, `X-N8N-API-KEY`: `GET /workflows` (filters `active`, `tags`, `name`; `cursor` + `limit` ≤ 250), `GET /executions/{id}`, `POST /executions/{id}/stop`. **No REST endpoint runs a workflow**; a workflow runs from a webhook ([API](https://docs.n8n.io/api/), [workflows](https://docs.n8n.io/connect/n8n-api/build-and-run/workflows.md), [executions](https://docs.n8n.io/connect/n8n-api/build-and-run/executions.md)). **Instance-level MCP** at `…/mcp-server/http`, with OAuth or a personal access token. Workflows are off until the "Available in MCP" toggle. Tools include `search_workflows`, `get_workflow_details`, `execute_workflow` and `get_workflow_execution` ([docs](https://docs.n8n.io/connect/connect-to-n8n-mcp-server.md), [tools](https://docs.n8n.io/connect/connect-to-n8n-mcp-server/mcp-server-tools-reference.md)); beta since 1.120/1.121, Nov 2025 ([announcement](https://community.n8n.io/t/introducing-instance-level-mcp-access-in-n8n-beta/223178)) | `execute_workflow` returns `{executionId, status: started}` at once; poll `get_workflow_execution`. Execution states: `new`, `running`, `waiting`, `success`, `error`, `crashed`, `canceled`. The Wait node's "On Webhook Call" mode resumes at `$execution.resumeUrl` ([Wait](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait.md)) | Owner opt-in per workflow; async run with an id; a resume URL for "ask and wait" | The MCP Server Trigger's `$fromAI()` parameters all become required (automation landscape §2.5) |
| **Node-RED** | Admin API: `GET /flows`, `GET /flow/:id`, `POST /flows` with `Node-RED-Deployment-Type`, `POST /nodes` installs a module. Bearer tokens come from `POST /auth/token` when `adminAuth` is set ([methods](https://nodered.org/docs/api/admin/methods/), [auth](https://nodered.org/docs/api/admin/oauth)). There is **no notion of a callable flow with parameters**; `http in` + `http response` make an endpoint | Whatever the flow does; nothing standard | Config nodes holding one shared connection ([config nodes](https://nodered.org/docs/creating-nodes/config-nodes)) | Using the admin API to rewrite flows from a voice turn |
| **Home Assistant** | `get_services` over the websocket lists every script with `fields` and `selector`s. `call_service` with `return_response: true`, or REST `POST /api/services/script/<name>?return_response` ([REST](https://contributors.home-assistant.io/core/internals/rest-api/), [WS](https://contributors.home-assistant.io/core/internals/websocket-api/)) | `script.turn_on` returns at once and the `script.<name>` state shows it is running; a direct call blocks. Script `default` and `required` are not enforced at run time ([script](https://www.home-assistant.io/integrations/script/)) | Typed fields from selectors; HA's own `script__<name>` tools (automation landscape §1.5) | Trusting `required` |
| **Windmill** | `GET /api/w/{ws}/scripts/list`, `flows/list`; each script carries a JSON Schema `schema` of its arguments. Run async with `POST /api/w/{ws}/jobs/run/p/{path}` or sync with `jobs/run_wait_result/p/{path}`; flows use `/f/` ([OpenAPI](https://raw.githubusercontent.com/windmill-labs/windmill/main/backend/windmill-api/openapi.yaml)). MCP at `<base>/api/mcp`, scoped by `mcp:favorites` or `mcp:scripts:<paths>` ([MCP](https://www.windmill.dev/docs/core_concepts/mcp)) | `jobs_u/completed/get_result_maybe/{id}` gives `{completed, result, success}`. Suspend steps hand out `wmill.getResumeUrls()` → `{resume, cancel, approvalPage}` ([approval](https://www.windmill.dev/docs/flows/flow_approval)) | The best typed source: the function signature is the schema | — |
| **Activepieces** | The public API is "only available in the Platform and Enterprise editions" ([API](https://www.activepieces.com/docs/endpoints/overview)). The MCP server builds and tests flows; it does **not** expose published flows as tools ([MCP tools](https://www.activepieces.com/docs/mcp/tools.md)). Catch Webhook plus `/sync` waits for a Return Response action ([source](https://raw.githubusercontent.com/activepieces/activepieces/main/packages/pieces/core/webhook/src/lib/triggers/catch-hook.ts)) | Sync timeout 30 s (408 after it) ([limits](https://www.activepieces.com/docs/flows/known-limits)); "Respond and Wait for Next Webhook" suspends with an `x-activepieces-resume-webhook-url` header ([source](https://raw.githubusercontent.com/activepieces/activepieces/main/packages/pieces/core/webhook/src/lib/actions/return-response-and-wait-for-next-webhook.ts)). Measured warm sync webhook p50 163 ms ([latency](https://www.activepieces.com/docs/install/architecture/latency.md)) | Sync webhook with a hard timeout | Building on the paid API |
| **Huginn** | WebhookAgent receives at `/users/:user_id/web_requests/:agent_id/:secret`; PostAgent sends ([webhook](https://raw.githubusercontent.com/huginn/huginn/master/app/models/agents/webhook_agent.rb), [post](https://raw.githubusercontent.com/huginn/huginn/master/app/models/agents/post_agent.rb)). No token JSON API for agents | Event graph; nothing to poll | Watchers that need no model | — |
| **Apple Shortcuts** | Not callable from our server. Shortcuts calls *us* with Get Contents of URL (GET/POST/PUT/PATCH/DELETE, JSON body) ([Apple](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios)); a Siri phrase runs a shortcut by name ([Apple](https://support.apple.com/guide/shortcuts/run-shortcuts-with-siri-apd07c25bb38/ios)) | The reply is the HTTP response | — | — |
| **Tasker** | Since 6.2.18 an **HTTP Request event** makes the phone a web server on a chosen port, answered by an HTTP Response action ([changes](https://tasker.joaoapps.com/changes/changes6.2.html), [event](https://tasker.joaoapps.com/userguide/en/help/eh_http_request.html)) | — | Our server can call an Android phone directly ("ring my phone") | Exposing that port beyond the LAN |

**Take-away.** Three platforms can be *discovered* with typed inputs: Windmill fully, HA scripts through selectors,
and n8n partly (instance MCP lists and runs workflows, but webhook inputs are untyped). Node-RED, Activepieces CE and
Huginn are webhook-only: the owner declares the fields, or our own node package declares them from inside the
platform. Every platform with long runs has an id-plus-poll model and a resume URL, which is what "ask and wait" needs.

## 3. Example conversations

S = a screen helps; everything also works headless.

1. "Hey Jev, run the photo backup." → n8n workflow `Photo backup` (exposed; no fields) via `execute_workflow` →
   "Started. It usually takes about ten minutes; I'll tell you when it's done." Later on the same device: "The photo
   backup finished: 312 new photos." S: a pinned `progress` item.
2. "Has the photo backup finished?" → `automation_status` → "Still running, seven minutes so far. Last time it took
   eleven."
3. "Make the energy report for October." → Windmill script `f/home/energy_report(month: string, send_to: enum)`. The
   model fills `month: "2026-10"` and asks: "Should I send it to you or to Sam?" "Me." → sync run, 4 s → "Sent. You
   used 312 kWh, 8 % less than September."
4. "Movie mode." → HA script `script.movie_mode` with field `brightness` (`number`, 0–100, default 20), exposed as a
   tool: "Movie mode, lights at 20 percent."
5. A workflow asks a question. Node-RED sees that the dryer is done and calls our `ask` node → kitchen device: "The
   dryer is done. Should I start the dishwasher too?" "Yes." → the answer `yes` flows out of the node's output and
   Node-RED starts the dishwasher. No answer in 2 minutes → the `timeout` output.
6. A workflow shows something. n8n, on a doorbell event, posts a presentation → hallway screen: a camera snapshot
   `image` and "Parcel delivery at the door." **S** (headless devices only speak it).
7. Ambiguous: "Run the backup." with *Photo backup* and *Laptop backup* exposed → "The photo backup or the laptop
   backup?"
8. Failure: "Run the photo backup." while n8n is down → "n8n isn't answering, so the photo backup didn't start." The
   admin Health page shows the probe failure.
9. Refused by policy: an HA automation calls our `ask_question` on the hallway satellite: "Someone is at the door.
   Unlock it?" → the answer is still reported to HA, but our risk policy forbids treating a spoken "yes" from an
   untrusted device as consent to a `security` action (§13). HA's automation must decide. Our docs tell owners not to
   build this.
10. Siri on a phone: "Hey Siri, Jev status" → a shortcut calls `GET /api/automation/v1/status` → "Two workflows
    running: photo backup, energy report."

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk (B.5) | Latency | Fast path |
|---|---|---|---|---|---|---|
| `<prefix>_<slug>`, one per exposed workflow, script or flow | typed from the platform (§5.2), or owner-declared | sync: the result's `say` or a summary; async: `{ runId, started }` and a spoken "started" | W (owner may mark R) | owner-declared; default `change`, `message` if the workflow sends anything outward | sync 0.1–10 s; async returns < 500 ms | only with an owner phrase (routines quick command) |
| `automation_status` | `run?: dynamic` (running and recent runs) | state, elapsed, typical duration, last result line | R, speculative | read | < 20 ms (store) | yes |
| `automation_cancel` | `run: dynamic` | "Stopped the photo backup." (n8n `POST /executions/{id}/stop`, Windmill cancel) | W | change | 100–800 ms | yes |
| `automation_list` | `platform?: choice` | exposed workflows, one line each | R, speculative | read | < 10 ms | yes |
| `automation_find` | `query` | matching workflows not loaded as tools (when more than 10 are exposed) | R | read | < 5 ms | no |

Tool names follow mcp-client's rule: `[a-z0-9_]`, ≤ 64 characters, unique, prefix per platform connection (`n8n_`,
`ha_script_`, `wm_`, `nr_`). The deferral rule is mcp-client §5.9, reused: above 10 exposed workflows per assistant,
only the most used are loaded and the rest are reachable through `automation_find`.

**The callback API (not tools; HTTP, for the platforms).** Base `/api/automation/v1`. Auth is
`Authorization: Bearer <integration token>`. One token per platform connection, scoped (§13), LAN-only by default.

| Endpoint | Body | Effect |
|---|---|---|
| `POST /say` | `{ text, to: device \| room \| person \| "origin", priority?, voice? }` | an `Announce` through the Notification service (shared state §8.6) |
| `POST /notify` | `{ title, spoken?, kind?, priority?, audience, actions?, dedupeKey? }` | `notify.send` with `source.module = "automation:<conn>"` |
| `POST /present` | `{ to, kind, payload, ttlSeconds? }` | one presentation from the **closed catalogue** only (`image`, `card`, `facts`, `list`, `progress`, `text`); images go through `/media/` |
| `POST /ask` | `{ to, question, answers?: [{ id, sentences[] }], timeoutSeconds ≤ 600, callbackUrl?, priority? }` | `202 { questionId }`; a notification of kind `question` with `followUp`; the answer is POSTed to `callbackUrl` (an n8n `resumeUrl`, a Windmill `resume` URL, an Activepieces resume URL) and is also readable at `GET /ask/{id}` |
| `POST /turn` | `{ assistant, text, device? }` | a typed turn for that assistant under its normal policy; reply in the response (routines example 6) |
| `GET /targets` | — | devices, rooms, people the token may address (for dropdowns in our nodes) |
| `POST /subscriptions` | `{ events[], url }` | the platform's trigger subscribes to our Event bus (`timers.finished`, `routines.finished`, `alarms.dismissed`) |

The `answers` shape copies HA's `assist_satellite.ask_question` (`answers[{id, sentences[]}]`,
[services.yaml](https://raw.githubusercontent.com/home-assistant/core/dev/homeassistant/components/assist_satellite/services.yaml)).
Closed answers are matched locally, like a confirmation, without a model. With no `answers`, the free transcript is
returned.

## 5. Integrate or build

### 5.1 One generic design

Every platform is an adapter behind one interface. Adapters live in `packages/automation-<platform>`. Only the HA one
needs a library, and it reuses the smart-home connection.

```ts
// Proposal
interface AutomationPlatform {
  readonly id: "n8n" | "home-assistant" | "windmill" | "node-red" | "activepieces" | "huginn" | "webhook"
  list: Effect<ReadonlyArray<Runnable>, PlatformError>     // discovery; webhook-only platforms return declared ones
  run(r: RunnableRef, input: unknown): Effect<RunOutcome, PlatformError>
  status(run: RunHandle): Effect<RunState, PlatformError>   // poll target for async runs
  cancel?(run: RunHandle): Effect<void, PlatformError>
}
interface Runnable { ref: RunnableRef; name: string; description: string
  input: JsonSchema | "owner-declared"; mode: "sync" | "async" | "either"; typicalMs?: number }
type RunOutcome = { done: { ok: boolean; say?: string; data?: unknown } } | { started: RunHandle }
type RunState = "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"
```

The host side is the same for all of them: the owner's exposure list, JSON Schema to `Schema.Codec` conversion, risk
and timeouts, the Scheduler `task` that polls, the result notification and the callback API. Platform differences
fit in about 200 lines per adapter **[estimate]**.

### 5.2 Per platform

| Platform | Discovery | Input schema | Run | Status | Recommendation |
|---|---|---|---|---|---|
| n8n | instance MCP `search_workflows` (opt-in toggle in n8n), or REST `GET /workflows?tags=pva` | untyped (`inputs` of type webhook, form or chat). Proposal: a JSON Schema in a fenced block in the workflow's description, else owner-declared fields | instance MCP `execute_workflow` (async); or the production webhook in "When Last Node Finishes" mode for sync | `get_workflow_execution` or REST `GET /executions/{id}` | **Build first.** Instance MCP through mcp-client's transport, REST as fallback |
| HA scripts | websocket `get_services`, domain `script` | selectors → schema: `text` → string, `number{min,max}` → number, `select{options}` → enum, `boolean`, `entity{domain}` → dynamic choice, `duration` → duration | `call_service` with `return_response` (sync); `script.turn_on` (async) | `script.<name>` state over the websocket | **Build first**, on the existing HA connection; it replaces routines' `ha_script_<name>` |
| Windmill | `scripts/list`, `flows/list`, or MCP with `mcp:favorites` | JSON Schema, as is | `run_wait_result` if `typicalMs` < 8 s, else `jobs/run` | `get_result_maybe/{id}` | Second; clean and small |
| Node-RED | none in the platform; **our node** registers tools (§5.3) | declared in our node's editor | over our node's websocket | our node's `progress` and `done` | Second, through the node package |
| Activepieces | none in CE | owner-declared | Catch Webhook `/sync` (30 s cap) | flows call back through our API | Generic webhook adapter |
| Huginn | none | owner-declared | WebhookAgent URL | PostAgent calls back | Generic webhook adapter |
| Shortcuts, Tasker | n/a (they call us) | — | Tasker: optional `GET` to the phone's HTTP Request event | — | Document recipes; no adapter |

### 5.3 Our own packages

| Package | Contents | Notes |
|---|---|---|
| **`n8n-nodes-pva`** (community node) | Credential type `PvaApi` (base URL + token; `test` calls `GET /api/automation/v1/targets`). Node *PVA* with operations Say, Notify, Show, Ask (Ask posts `callbackUrl = $execution.resumeUrl`, then the workflow continues in a Wait node), Run turn. Node *PVA Trigger*: a webhook trigger whose create and delete methods call `POST/DELETE /subscriptions` | Scaffold with `npm create @n8n/node@latest`. Verified status needs no runtime dependencies, and from 2026-05-01 publishing from GitHub Actions with npm provenance ([rules](https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes.md)). Verified nodes install on n8n Cloud too ([docs](https://docs.n8n.io/integrations/community-nodes/installation-and-management/install-verified-community-nodes.md)) |
| **`@pva/node-red-pva`** | Config node `pva-server` (URL, token; holds one websocket to us). `pva-tool` (name, description, parameter table, risk): registers a tool and emits a message when called. `pva-tool-reply`, `pva-progress`. `pva-say`, `pva-notify`, `pva-show`, `pva-ask` (two outputs: answer, timeout) | Must be scoped (new modules after 2022-01-31) and submitted to the Flow Library by hand ([packaging](https://nodered.org/docs/creating-nodes/packaging)). The websocket means Node-RED needs no inbound port and no `adminAuth` change |
| **HA custom integration `pva`** (HACS) | Config flow: URL + token. Per device: `assist_satellite.pva_<device>` (ANNOUNCE, START_CONVERSATION; `announce`, `start_conversation`, `ask_question` map to our `/say` and `/ask`). `media_player.pva_<device>` (PLAY_MEDIA with `announce`). `notify.pva_<device>` (`send_message`). Per assistant: a `conversation` agent, so an HA Assist pipeline can answer with one of our assistants | Python, `custom_components/pva/` plus `hacs.json` ([HACS](https://hacs.xyz/docs/publish/integration/)). Satellite contract: subclass `AssistSatelliteEntity`, implement `async_announce` and `async_start_conversation` ([dev docs](https://raw.githubusercontent.com/home-assistant/developers.home-assistant/master/docs/core/entity/assist-satellite.md)); `ask_question` exists since 2025.7 ([release](https://www.home-assistant.io/blog/2025/07/02/release-20257/)). `iot_class: local_push` over our websocket |

### 5.4 What to build first

1. The callback API's `say`, `notify` and `ask`. Every platform can use them with a plain HTTP node today, and they
   double as the inbound half of [notifications.md](notifications.md).
2. The n8n adapter (the owner named it) and HA script discovery (the connection exists).
3. The Node-RED package (Node-RED has no discovery, so the package is the only way to get typed tools from it).
4. The HA custom integration: the largest value for an HA household, because every HA automation can then address
   our devices like any other satellite. It is also the largest piece of work, and in another language.
5. Windmill, then the generic webhook adapter for Activepieces and Huginn, then the n8n community node.

## 6. Data

| Where | Scope | Content |
|---|---|---|
| settings (`records`) | household | platform connections: kind, base URL, vault reference for the token, prefix, default timeout; exposed runnables: ref, spoken name, risk, mode override, owner-declared fields, which assistants |
| Module store `runs` | household (origin kept) | run id, platform, ref, origin device, assistant and person, started, state, last poll, result line; 30 days |
| Module store `durations` | household | rolling median per runnable, for "usually ten minutes" and the sync/async choice |
| Module store `questions` | household | question id, token, target, answers, deadline, answer, callback URL, delivery state |
| Module store `registrations` | household | tools registered by Node-RED nodes: node id, schema, last seen |
| vault | — | platform tokens; hashes of integration tokens |
| exports | — | `automation.runs.active` as an ambient line ("photo backup running, 7 min"); `automation.list` for routines |

## 7. Long-running work and events

- **Async runs** are Scheduler `task` jobs (shared state §6.1) that poll with back-off from 2 s to 30 s, capped by a
  per-runnable deadline (default 2 h). On a restart the handle is in the store and polling resumes. That differs from
  a plain `task`, whose fiber is lost: here the work runs on the platform, so it is safe to continue.
- **State `waiting`** (n8n Wait node, Windmill suspend) is reported as "waiting for an answer" if one of our
  questions is open for that run, else as "paused".
- **Questions** are Scheduler jobs with a deadline. On timeout: POST `{ answer: null, reason: "timeout" }` to the
  callback. After a restart, open questions are re-asked once only if more than half their time remains.
- **Node-RED websocket:** a scoped fiber per connection; registrations refresh on reconnect and vanish after 5 minutes.
- **Events published:** `automation.run.started`, `automation.run.finished` (ok, failed, cancelled),
  `automation.question.answered`. **Listens to:** nothing it does not forward; subscriptions come from platforms.

## 8. Presentation

- **Screen:** a running async workflow is a pinned `progress` item (indeterminate, or a percentage from
  `pva-progress`), with a cancel action. A finished run with data shows `facts` or a `list` if the platform result has
  a `display` field naming one. `/present` calls show their own kind. Questions with closed answers show a `confirm`-like
  card with one button per answer, labelled by the first sentence.
- **The character:** "working" during a sync run (CHARACTERS.md `turn.activity`, designed only); nothing for background.
- **Headless:** spoken only; a run finishing is a `result` notification line. `/present` to a headless device falls back
  to speaking the payload's title, or is refused (`409 no display`) if the caller set `requireDisplay`.

## 9. Notifications and proactive behaviour

- Run results: priority `normal`, `ring: origin`, else the inbox. Silent if the owner set the runnable to "quiet".
- Failed runs started by a person: `normal` to the origin. Failed runs started by a routine or a schedule: `low` to the
  owner's inbox.
- `/say` and `/notify` default to `normal`. The token's scope may allow `high`, and `critical` only for a token the
  owner marks "safety" (HA smoke or leak).
- `/ask` is `high` by default, so it is not held for an idle device. It respects quiet hours: during them the
  question goes to the inbox, and the callback gets `reason: "quiet-hours"` at once.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | callback API on; LAN-only; maximum priority per token; quiet-hours behaviour of `ask` | on; on; `normal`; refuse |
| Module | connections (§6); poll back-off; run deadline (2 h); sync threshold (8 s); max exposed per assistant (25); question max timeout (600 s) | as stated |
| Assistant | which exposed workflows; `offTools` | none |
| Device | accepts `/say`, `/present`, `/ask` from automations (each on/off); trusted for `security` runnables | on, on, on; off |
| Person | may be addressed by `/ask` | yes |

**Connections:** n8n (base URL + API key, or OAuth to instance MCP), Windmill (URL + token + workspace), Node-RED (none:
the node connects to us with an integration token), HA (existing). **First run:** add a connection → **Test** lists
the workflows → tick some, set spoken names and risk → assign to assistants → copy an integration token for the
callback API.

## 11. Native tools and dependencies

None on our server beyond npm (the MCP client library from [mcp-client.md](mcp-client.md) §5.1). Each platform is an
optional service with a health probe (module definition §C.3): n8n `GET /api/v1/workflows?limit=1`, Windmill
`GET /api/version`, HA ping, Node-RED "node connected in the last 60 s". Missing service, spoken: "n8n isn't answering,
so the photo backup didn't start." Our packages need n8n ≥ 1.121 for instance MCP **[assumed: the oldest release with
`execute_workflow`]**, Node-RED ≥ 3, HA ≥ 2025.7 for `ask_question`.

## 12. Interaction with the rest of the system

- **Voice.** Workflow names are the owner's, so the spoken name is a setting ("photo backup", not `Backup v3 (copy)`).
  Admin warns when two spoken names differ by one word. A sync run over 700 ms gets a filler. Barge-in abandons a sync
  wait but does not cancel the platform run; "stop the backup" does.
- **Schema quality.** HA's `required` is not enforced, n8n's webhook inputs are untyped, and `$fromAI()` makes
  everything required. So the adapter treats discovered schemas as hints. The owner can mark a field optional or
  fixed (a locked value, like Zapier's managed mode, automation landscape §4.4).
- **Fast path.** Workflow tools have no `examples`, so Jev cannot pick them. A routines quick command can bind a phrase
  to one ("movie mode"). That is the LLM-free path.
- **Agents and other modules.** The Claude subscription harness sees `mcp__assistant__n8n_photo_backup`; no assistant
  template. Routines (`call` steps, hooks), notifications (all callback deliveries), smart-home (HA connection,
  shared websocket), mcp-client (transport, pins, trust levels), presentation.

## 13. Privacy and safety

- **Risk is declared by the owner.** It defaults to `change`, or `message` if the platform node graph contains an
  email, chat or HTTP node to the internet (n8n `get_workflow_details` shows the nodes). We cannot see what a workflow
  really does. Until core confirmations are on, `message`, `money` and `security` runnables cannot be exposed
  (mcp-client §13 rule).
- **Spoken answers are not consent.** `/ask` answers are reported as data, with the device and recognised text. The
  API documentation says plainly that they must not unlock, disarm or pay. A token can be restricted to devices.
- **Integration tokens** are scoped (`say`, `notify`, `present`, `ask`, `turn`, `subscribe`), revocable, rate-limited
  (default 30/min), LAN-only by default, and logged with the caller IP. `/turn` runs under the named assistant's own
  policy and is off by default.
- **Text from platforms is data.** It is spoken or shown as is, and wrapped (`[From n8n "Photo backup": …]`) when
  recorded in a conversation, never put into a prompt as instructions.
- **Children and guests:** no workflow tools by default. `/ask` to a child's device only for tokens that allow it.
- **The HA integration** gives HA admins the ability to make our devices speak. That is the point, but it is listed on
  the connection card.

## 14. Foundations needed

Notification service with `Announce` and the `question` kind (callback API); Scheduler (polling, question
deadlines); Module store (runs, questions); Connection (platform tokens, n8n OAuth); Requirements and health (probes);
Presentation (`/present`, `progress`); Device capabilities (refusing `/present` headless); Tool context (origin of a
run); the `records` settings field; core confirmations for `message` runnables; the host HTTP route for the callback
API (current-system.md §9, gap 21).

**A useful first version without most of them:** HA scripts and n8n workflows discovered and exposed as sync tools
(8 s timeout, `change` risk only), owner-declared fields where the schema is missing, and `POST /say` built on core's
existing `Say` input to one device. That needs only an HTTP route and the `records` field.

## 15. Open questions

1. **Disagreement with routines §5 and §10.** Routines puts n8n's MCP Server Trigger in the MCP bridge and keeps
   `ha_script_<name>` and hand-declared endpoints in routines. This document proposes one automation module for all of
   them, with discovery, and routines only calling it. Which split do you want?
2. **Disagreement with mcp-client example 4,** which expects an n8n run to come back as an MCP task handle. n8n's
   instance MCP returns an execution id to poll instead, so the polling must live here, not in the generic client.
3. **n8n: instance MCP or REST plus webhooks?** Instance MCP is beta, but it is the only path that lists *and* runs. The
   alternative requires a webhook trigger in every exposed workflow.
4. **Where do n8n input schemas come from:** a JSON Schema in the workflow description (a convention of ours), or
   fields typed in our admin?
5. **Do we publish the HA custom integration?** It is Python and needs HACS upkeep, but it makes our devices first-class
   in HA. Or do we rely on HA calling our callback API with `rest_command`?
6. **May `/turn` exist at all?** It lets any token holder talk to an assistant with that assistant's tools.
7. **Which platforms do you run today?** n8n is named. Is Node-RED in use (as the HA add-on, on 54,545 installs per
   automation landscape §1.1), and do you use Windmill or Activepieces at all?
8. **Questions during quiet hours:** refuse at once (proposed), or hold until morning and keep the workflow waiting?
