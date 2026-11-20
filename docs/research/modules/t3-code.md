# T3 Code

Research write-up, 2026-11-17. Not an approved design. Upstream facts were read in the
[pingdotgg/t3code](https://github.com/pingdotgg/t3code) repository (`main`, latest release v0.1.10 of 2026-11-17) and on
this machine; each claim is marked **[doc]** (upstream documentation), **[src]** (read in upstream source),
**[local]** (seen on this machine, read only) or **[unverified]**. Shared foundations are named as in
[`README.md`](README.md) and not redesigned here.

## 1. Summary

A module that lets the owner talk to his own T3 Code instance: hear what his coding threads are doing, start a thread
from a dictated prompt, send a follow-up, stop a run, answer a question an agent asked, check pull requests, and be told
when a thread is done. T3 Code is an outside service with a documented MCP endpoint for agents it did not start, so
this is a **module with tools over that endpoint**, not a new agent backend (§12).

- **Priority: second wave.** High value for this owner and a real wish-list item, but it is one person's tool. The
  read-only half (status aloud) works without any new foundation. The useful write half needs confirmation and the
  Scheduler, and it is only safe once there is a trusted-device rule.
- **Effort: M.** The surface already exists upstream (about ten MCP tools), and Effect 4 ships an MCP client
  (`effect/ai/McpClient`, experimental since 4.0.6, no OAuth). The work is the OAuth sign-in on a headless server, the
  confirm-before-send flow, speech-friendly summaries, and the "tell me when done" job.

### What integration surface is actually confirmed

| Surface | Status | What it gives |
|---|---|---|
| **`/mcp` over HTTP with OAuth** for outside agents | **[doc]** [outside-agents.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md), [environment-auth.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md); **[local]** probed: `POST http://127.0.0.1:3773/mcp` without a token answers `401 invalid_mcp_credential` with `resource_metadata=…/.well-known/oauth-protected-resource/mcp`; the metadata lists `/oauth/mcp/authorize`, `/oauth/mcp/token`, `/oauth/mcp/register` (dynamic registration), `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code"]` (no refresh grant), scopes `orchestration:read`, `orchestration:operate` | Project list, thread list/search/read/launch/send/wait/interrupt, pending questions, PR links, scheduled tasks. The owner approves at **Read only** or a permission-mode ceiling (Supervised … Full access). A sign-in lasts 30 days. |
| **`t3 thread` CLI** on the host | **[local]** `t3 v0.1.6`: `t3 thread list|start|send|show`, flags `--json`, `--wait` (exit 1 failed, 2 waiting for an answer), `--worktree <ref>`, `--provider/--model`; **[src]** [`cli/thread.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/cli/thread.ts) mints a short-lived MCP-client session with `access: "full-access"` from the local data directory and revokes it after the command | The same tools without a sign-in, but only on the same machine and same user, only four verbs, and always at the full-access ceiling |
| **WebSocket RPC** (what the T3 web, desktop and mobile apps use) | **[doc]** exists ([connection-runtime.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md), scoped bearer tokens from `t3 auth session issue`); not documented as a public API | Everything the app can do, including answering approvals. Internal, version-coupled: not recommended. |
| MCP sessions on other routes | **[doc]** "Only `/mcp` accepts these sessions. Every other HTTP and WebSocket path rejects that subject." | — |
| Answering **approvals** (permission requests) from outside | **[src]** not possible over MCP: `t3_pending_request` "respond: answer one with `answers`; this cannot approve a permission request", and approvals are not listed | Questions yes, approvals no (§12, §15) |
| Push of thread events to an outside client | **[doc]** none on `/mcp` ("sends nothing while a wait is open"); T3's own phone notifications need T3 Connect ([mobile-notifications.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/mobile-notifications.md)) | We long-poll `t3_thread_wait` |

**Local install [local].** `~/.local/bin/t3` → `~/.t3/runtime/versions/0.1.6/t3` (a 168 MB ELF), and the desktop app
`T3 Code (Beta)` in `/opt` (`/usr/bin/t3code`). The running server is the desktop app's: `~/.t3/userdata/server-runtime.json`
reports server version 0.1.9, host `0.0.0.0`, port 3773, origin `http://127.0.0.1:3773`; the desktop setting
`serverExposureMode` is `network-accessible`; `t3 status --json` shows LAN on, T3 Connect on, background service not
installed. Projects live in `~/.t3/projects`, worktrees in `~/.t3/worktrees`. No secrets were printed.

## 2. What others do

| Who | What | Take |
|---|---|---|
| T3 Code's own [voice input](https://github.com/pingdotgg/t3code/blob/main/docs/user/voice-input.md) **[doc]** | Dictation into the composer; "the transcript lands in your draft for review, and only sending the message sends anything to an agent"; cloud dictation sends "vocabulary hints" | Confirm-before-send is the upstream norm. Copy it. |
| T3 Code [outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md) **[doc]** | Claude Code, Codex, ChatGPT and bots such as Poke connect to `/mcp` with OAuth; outside agents use `t3_thread_launch` then `t3_thread_wait`/`t3_thread_read` instead of `delegate_task` | We are one more outside agent. The upstream advice is the tool choice below. |
| T3 Code [mobile notifications](https://github.com/pingdotgg/t3code/blob/main/docs/user/mobile-notifications.md) **[doc]** | Alerts "when an agent finishes, fails, needs approval, or asks for input", live activities, through T3 Connect | The owner may already get these on his phone. Our announcement must add something (speaking it in the room) and not double-ring the phone (§9). |
| Talon Voice, Serenade **[unverified, from memory]** | Voice *coding*: dictating code tokens with a custom grammar and vocabulary | The wrong level for us. We dictate intent ("fix the flaky timer test"), never code. |
| GitHub Copilot Voice ("Hey, GitHub!") **[unverified, from memory: a technical preview that was ended]** | Spoken editor commands and code explanation | Voice inside the editor did not stick. Voice *about* long-running agent work, away from the desk, is the gap. |

Avoid: reading code, diffs or paths aloud; starting work from a misheard sentence; a voice path that can run full-access
agents from any room.

## 3. Example conversations

1. Status (no screen needed).
   > "Hey T3, what are my threads doing?"
   > "Three are active. *Assistant controls research* is running, eleven minutes in. *Fix flaky timer test* finished
   > and opened a pull request. *Stage layout* is waiting for an approval in T3 Code."
2. Detail of one thread (screen helps: the card shows the last message and changed files).
   > "What did the timer test thread say?"
   > "It found the test relied on a real clock, switched it to the test clock, and all 412 tests pass. It opened pull
   > request 91. Want me to read the summary or put it on the screen?"
3. Start a thread, confirm before send (screen shows the exact text with Send and Edit).
   > "Start a thread in the voice assistant: make the weather module say rain in the next hour."
   > "In personal-voice-assistance, a new worktree from main: 'Make the weather module say whether it will rain in the
   > next hour.' Send it?" — "Yes." — "Started. I'll tell you when it's done."
4. Misrecognition caught at confirmation.
   > "Start a thread in pee vee ay: rename the dock prop to toolbar."
   > "In personal-voice-assistance: 'Rename the dock prop to toolbar.' Send it?" — "No, the Doc component, D O C." —
   > "'Rename the Doc component's prop to toolbar.' Send it?" — "Yes."
5. Follow-up and stop.
   > "Tell the weather thread to use Open-Meteo's minutely data." — "Send 'Use Open-Meteo's minutely data' to *Weather
   > rain next hour*? It's running, so it will steer the current turn." — "Yes." … later: "Stop the weather thread." —
   > "Stopped. It had changed two files."
6. Answering a question.
   > (announced) "The stage layout thread is asking: should the timer badge sit left or right of the character?" —
   > "Right." — "Answered: right."
7. Approval (failure the owner has to finish elsewhere).
   > "Approve it." — "I can't approve commands from here; T3 Code only allows that in its own app. It wants to run
   > `pnpm install`. It's on your phone in T3 Code, or I can put the link on the study screen."
8. Ambiguous.
   > "How's the test thread?" — "Two threads match: *Fix flaky timer test* in personal-voice-assistance, finished, and
   > *Test PR for CI* in the same project, running. Which one?"
9. Not reachable.
   > "What's T3 doing?" — "I can't reach T3 Code on this computer right now; the desktop app may be closed."
10. Wrong device.
   > (kitchen speaker, guest present) "Start a thread …" — "Coding threads only run from your study devices."

## 4. Tools

Our tool names are our own (they wrap upstream tools of similar names). Latency is a guess for a loopback call and
must be measured with `TurnTrace` (`toolMs`) before any claim **[unverified]**.

| Tool | Parameters | Returns | R/W | Risk class | Latency | Fast path |
|---|---|---|---|---|---|---|
| `t3_overview` | `project?` (spoken name), `include?: "active" \| "recent"` | ≤ 8 threads: title, project, status (`running`, `waiting`, `completed`, …), age, needs-you flag (question/approval), PR state | read | safe (personal) | 0.2–0.6 s: `t3_thread_list { allProjects: true, statuses, limit }` | yes, a typed action "what are my threads doing" |
| `t3_projects` | — | Project names and ids, with the owner's aliases | read | safe | ~0.2 s: `t3_project_list` | yes |
| `t3_thread_status` | `thread` (spoken title or "the last one") | Status, latest run, last assistant message trimmed to ~1 500 chars, changed-file count if present, PR links, pending question | read | safe (personal) | 0.3–1 s: `t3_thread_search` + `t3_thread_read { view: "messages", limit: 3, maxCharsPerItem: 1500 }` | no: the model summarises |
| `t3_thread_activity` | `thread`, `limit?` | Summarised tool, checkpoint and runtime-request items (what it is doing now) | read | safe | 0.3–1 s: `t3_thread_read { view: "activity" }` | no |
| `t3_draft` | `kind: "start" \| "send"`, `text`, `project?`, `thread?`, `workspace?: "worktree" \| "root"`, `baseRef?` | A `draftId` plus the read-back sentence and the resolved target; nothing is sent | write (draft only) | changes data (conversation scope) | < 50 ms | no |
| `t3_send_draft` | `draftId` | The launched or messaged thread, its link | write | **outward-facing or costly** (runs agents as the owner) | 0.5–2 s: `t3_thread_launch { projectId, title, message, workspaceStrategy, runtimeMode }` or `t3_thread_send { threadId, message, mode: "auto", clientRequestId }` | no; refused unless the draft came from an earlier turn |
| `t3_thread_stop` | `thread` | Interrupted run, or "nothing running" | write | changes data | ~0.5 s: `t3_thread_interrupt` | yes ("stop the weather thread", with a spoken target check) |
| `t3_answer` | `thread`, `answer` | Which question was answered | write | outward-facing or costly | ~0.5 s: `t3_pending_request { action: "read" }` then `{ action: "respond", requestId, answers }` | no |
| `t3_pull_requests` | `thread?`, `project?` | Linked PRs with last known state and stack order | read | safe | ~0.5 s: `list_thread_pull_requests` | yes |
| `t3_ci_status` | `pr` (number or "the timer PR") | Checks summary: passed / failing (names) / pending | read | safe | 0.5–1.5 s: GitHub REST check runs (§5) | yes |
| `t3_notify_when_done` | `thread`, `also?: "questions"` | The watch id; starts a Scheduler job | write | changes data | < 50 ms | yes ("tell me when it's done") |
| `t3_show` | `thread`, `what?: "summary" \| "changes" \| "link"` | Presentation note; the content goes to the screen | read | safe | 0.3–1 s | no |

Not exposed by voice on purpose: `delegate_task`, `create_threads` (thread callers only, **[doc]**), `t3_project_create`
or `delete`, `t3_thread_transfer`, environment links, `schedule_task` (an outside client may call it **[unverified]**,
but a recurring agent run started by voice is a bad default), `request_secret` (refused for outside clients **[doc]**).

## 5. Integrate or build

| Option | For | Against |
|---|---|---|
| **A. MCP client to `/mcp` with OAuth** | Documented for outside agents; works on loopback, Tailscale HTTPS and the T3 Connect URL; the grant is a ceiling the owner chooses; revocable in T3's *Settings → Sharing & access* | OAuth on a headless server (paste-back flow); re-approval every 30 days (no refresh grant offered); no push events; no approvals |
| B. Shell out to `t3 thread … --json` | No sign-in; already a stable CLI | Same host and user only; full-access ceiling always (wrong for voice); only list/start/send/show; no project list, interrupt or questions |
| C. WebSocket RPC as a paired client | Everything, including approvals and live events | Undocumented and internal; scopes from `t3 auth session issue` include `terminal:operate` unless narrowed; breaks on T3 upgrades |
| D. Generic `mcp-client` module (landscape doc §4) pointed at T3 | No T3-specific code | Raw upstream tools are agent-shaped (positions, cursors, `clientRequestId`, 30 000-character reads), not voice-shaped; no confirm flow; no summaries |

**Recommendation: A**, in a module package `packages/module-t3-code`, using `effect/ai/McpClient` over Streamable HTTP
with our own small OAuth client (dynamic registration, PKCE S256, loopback redirect `http://127.0.0.1:<port>/callback`
with the paste-the-final-address fallback, as the
[Connection](../module-investigation/module-definition-config-and-dependencies.md) flows describe in §B.4). No provider SDK
is needed, so the adapter rule is not touched. Keep **B as a fallback** only for read tools when the server is on the
same host and no sign-in exists yet. Do not build C. If the generic MCP bridge (D) is built first, this module can sit
on its transport and keep its own voice-shaped tools.

**CI status** is not in T3's outside surface: PR state comes back as "last known state" and `watch_pull_request`
wakes a *thread* on check changes **[src]**. For checks, use a GitHub Connection and
`GET /repos/{owner}/{repo}/commits/{ref}/check-runs` (or `gh pr checks` on the host). That is shared with a later
`github` module; until then `t3_ci_status` is left out.

**Approval prompts.** Approve the voice assistant at the **Auto** ceiling (or **Supervised**), never Full access. T3's
own default for new threads is Full access **[doc]** ([permission-modes.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md)),
so `t3_send_draft` always passes an explicit `runtimeMode` no higher than a module setting (default `auto`) and a
`workspaceStrategy: { type: "worktree", baseRef: "origin/main", startFromOrigin: true }` by default, so voice-started work
never edits the main checkout.

## 6. Data

| What | Scope ([Module store](../module-investigation/shared-state-jobs-and-notifications.md) §4.3) | Schema (rough) | Readable by others |
|---|---|---|---|
| The T3 sign-in | Connection (vault), owner | `{ url, clientId, accessToken, expiresAt, grant: "read-only" \| ceiling }` | no |
| Project aliases | person (owner) | `{ spoken: "voice assistant" \| "pva", projectId }`, seeded from project names | no |
| Drafts | conversation | `{ draftId, kind, text, target, createdTurn, createdAt }`, dropped at conversation end | no |
| Watches | person (owner) | `{ watchId, threadId, runId?, origin: { deviceId, assistantId }, notifyOn: ["done","question","approval"], lastStatus, lastPosition }` | no |
| Cache | memory only | project list and thread shells, 30 s | — |

Thread content is never stored here; T3 is the record. Other modules read nothing except, through ambient facts
(§7 of the shared-state document), one line: "T3: 2 threads running, 1 waiting for you".

## 7. Long-running work and events

- **`t3_notify_when_done`** schedules a `task` job on the [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md)
  (§6.1). The task loops `t3_thread_wait { threadId, runId, timeoutMs: 45000 }`, in chunks under 50 s because T3
  Connect's edge drops idle requests after about 100 s **[doc]** ([remote.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md)),
  and between waits reads `t3_thread_list { statuses: ["waiting"] }` for the thread so a question or approval is caught
  (a wait does not end on an approval for an ordinary thread **[unverified]**).
- **Events** on the [Event bus](../module-investigation/shared-state-jobs-and-notifications.md) (§5):
  `t3-code.thread.finished { threadId, status }`, `t3-code.thread.needs-you { threadId, kind: "question" | "approval" }`,
  `t3-code.signin.expiring`. It listens to nothing.
- **Restart.** The wait is idempotent, so the job is marked re-runnable: after a restart it reads the thread once; if it
  finished while we were down, it announces late ("finished 12 minutes ago"). T3's own threads survive their own
  restarts **[doc]**; a T3 server that is down makes the job retry with backoff and say nothing until it is back.
- **Without the Scheduler** (first version): an in-memory fiber in the module's scope does the same wait; it dies with a
  restart, and the tool says so ("I'll keep an eye on it until the assistant restarts").

## 8. Presentation

Using the [Presentation](../module-investigation/presentation-and-device-capabilities.md) kinds (§3.2):

- `t3_overview` → `list` (title, project, status as secondary text, a dot for "needs you"); tapping an item is a typed
  turn "tell me about *Stage layout*".
- `t3_thread_status` → `card`: title, project and branch, status, the last message trimmed, `facts` for runs, files
  changed and PRs; actions "Stop", "Open in T3" (`handoff`), "Tell me when done".
- `t3_draft` → `confirm` with the **exact text** that will be sent, the project and the workspace; on a screen the
  owner can read the prompt instead of hearing all of it. "Edit" is a typed turn.
- `t3_show { what: "changes" }` → `table` (file, +, −) when the activity view carries checkpoint file stats, otherwise
  `facts` with the counts **[unverified: the detail checkpoint items expose]**. Never rendered code.
- A watched thread → a pinned `progress` (indeterminate) in Orbit layout until it ends.
- `handoff` → the hosted link `https://app.t3.codes/threads/<environmentId>/<threadId>`, which T3 gives outside clients
  instead of `t3-thread://` links **[doc]**, as a QR code.
- The character only presents; it never reacts to success or failure on its own (CHARACTERS.md §2.3).

**Without a screen** the model speaks one or two sentences: status, the gist, and an offer ("put it on the study
screen?"). File paths are shortened to the folder ("in the stage package"), numbers rounded, branch names said only when
asked.

## 9. Notifications and proactive behaviour

Through the [Notification service](../module-investigation/shared-state-jobs-and-notifications.md) (§8):

| Event | Kind / priority | Audience | Spoken |
|---|---|---|---|
| Watched thread finished | `result`, normal | owner; `ring: "origin"`, else inbox | "*Weather rain next hour* is done and opened a pull request." Follow-up window on the coding assistant |
| Watched thread failed | `result`, normal | same | "*Weather rain next hour* failed: the tests didn't pass." |
| Question asked | `question`, normal | same | The question in one sentence; follow-up window open for the answer |
| Approval waiting | `info`, low | inbox, screen badge | Not spoken by default (T3 already pushes it to the phone, and we cannot approve) |
| Sign-in expires in ≤ 3 days | `info`, low | admin | — |

Only watched threads speak. No "by the way, a thread finished" for threads the owner did not ask about. Quiet hours
apply. If T3 mobile notifications are on, a household setting can keep ours to in-room speech only, so the phone does
not buzz twice.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | — | — |
| Module (shared) | `url` (T3 environment URL; on the same host found from `~/.t3/userdata/server-runtime.json` `origin`), `maxRuntimeMode` (`approval-required` / `auto-accept-edits` / `auto`), `defaultWorkspace` (`worktree` from `origin/main` / `root`), `readBackFull` (read the whole prompt back, or only on screenless devices), `timeoutMs` (5 000), `useCliFallback` (on) | — / `auto` / worktree / screenless only / 5 000 / on |
| Connection | T3 sign-in (OAuth; secret in the vault) | none |
| Assistant | which assistant has the module (the coding template); `overridable`: default project | coding assistant only |
| Device | trusted for coding (allow write tools) — part of the device policy proposed in §B.5 | off for every device |
| Person | project aliases (owner) | from project names |

**First run.** (1) In admin, Modules › T3 Code: the URL is pre-filled when T3 runs on the same host. (2) "Sign in"
opens T3's approval page (or shows its address to open on a phone); the owner picks **Auto** (or Read only) and
approves with a code from `t3 auth pairing create` or T3's *Use T3 Code in another app (MCP)*. (3) Paste the final
address back if the redirect could not load. (4) "Test" lists projects. (5) Mark the study devices trusted for coding.

## 11. Native tools and dependencies

| Dependency | Where | When missing |
|---|---|---|
| A running T3 Code server (desktop app or `t3 serve` / background service) | the T3 host (today the same machine) | Health: `unavailable`, "T3 Code is not answering at 127.0.0.1:3773". Spoken: "I can't reach T3 Code right now; the app may be closed." |
| HTTPS or loopback to it | network | Plain `http://` to a LAN address is refused by the module: the bearer token would cross the LAN in clear, and T3's own docs say agents only sign in over https or localhost **[doc]** |
| `t3` CLI (fallback only) | same host | fallback off; no message |
| GitHub Connection (CI only) | server | `t3_ci_status` absent |

[Requirements and health](../module-investigation/module-definition-config-and-dependencies.md) (§C.3, §C.5):
`requires: [{ network: "lan" }]`; `health()` fetches `/.well-known/oauth-protected-resource` (no token) and, with the
token, `tools/list`; issues: unreachable, signed out, sign-in expiring, ceiling lower than `maxRuntimeMode`.

## 12. Interaction with the rest of the system

**Module, not agent backend.** The agent backends here (`packages/agent-claude-code`, docs/research/agent-backends.md)
answer *a voice turn*: one sentence in, text deltas out within about a second, history kept in the harness, our tools
given to it through an in-process MCP server (`packages/agent-claude-code/src/sdk.ts:48`). A T3 thread is the opposite:
minutes to hours per run, no text stream to an outside client, its own approvals, many threads at once. Making T3 an
`Agent` would mean a voice turn that waits minutes, or an agent whose "reply" is "sent". T3 also already runs Claude Code
and Codex itself, so a second harness layer adds nothing. The voice assistant's own model is the right conversational
layer: it picks the thread, words the prompt, and summarises. One future exception is worth noting: a *sticky* "talk to
this thread" mode (every utterance becomes a `t3_thread_send` to one thread until "done") is a conversation mode of
this module, not an agent.

**Voice and speech recognition.**
- Dictated prompts are intent, not code. The assistant rewrites filler but keeps the owner's words; it never adds
  requirements. The read-back is the exact text that will be sent.
- Vocabulary: project names, thread titles, branch names, package names (`agent-claude-code`, `module-home-assistant`)
  and common terms (pnpm, Effect, worktree, PR, CI, Vitest, TypeScript) are misheard. Three layers: (1) the module's
  context line lists project and active-thread titles, so the model can map "pee vee ay" to *personal-voice-assistance*;
  (2) fuzzy matching of targets against that list in the module, never in the model; (3) recogniser biasing where the
  engine offers it: Deepgram's keyterm prompting **[unverified, from memory]**, sherpa-onnx hotwords for transducer
  models with modified beam search **[unverified for Parakeet-TDT]**. Measure WER on a coding phrase set as
  docs/research/stt-quality.md did, before claiming a gain.
- Spelling: "D O C" and "capital D" are honoured in the read-back; code identifiers dictated letter by letter are
  joined.
- Fillers: list and read take a few hundred ms; launch can take seconds, so the model says "starting it" first.
  Barge-in during a long read-back cancels the send (the draft stays).
- Numbers: PR numbers and counts as words; ids are never spoken.

**Assistant template "coding"** (module `templates`, §A.4): name suggestion "T3", purpose "your coding threads in T3
Code", `handles: "coding threads, pull requests, T3 Code"`, modules `t3-code` and `clock`, suggested phrase "hey T3"
(the sample assistant in docs/ASSISTANTS.md already uses that id), an English recogniser (Parakeet, per stt-quality.md),
a calm voice. Prompt core: "You manage the owner's coding agents in T3 Code. Be brief. Never read code, diffs or full
paths aloud. Before starting or messaging a thread, always create a draft and read it back; send only after a clear yes.
You cannot approve commands; say where to approve." Other assistants do not get the module.

**Intents and other modules.** Typed actions for the fast path: `t3-code_overview`, `t3-code_stop` (with target), `t3-code_notify_when_done`.
The draft/send pair never runs without the model. Uses `handoff` (assistant controls) for "put it on my phone", and the
Notification service for announcements.

## 13. Privacy and safety

- **This runs code on the owner's machine as the owner.** A T3 thread at Full access can do anything the user can; even
  at Auto it runs commands. Treat `t3_send_draft`, `t3_answer` and `t3_thread_stop` as the `security` class of
  §B.5: allowed only on devices marked trusted, only with the coding assistant, never for guests or children, and
  refused (tool left out of the turn) elsewhere. Until [Tool context](../module-investigation/shared-state-jobs-and-notifications.md) exists, the enforceable rule is
  today's: only assign the coding assistant to the owner's own devices (device assignments, docs/ASSISTANTS.md).
- **Confirmation in the module.** Core confirmation is off (`confirmActions: "off"`). The draft/send split enforces it
  in the module: `t3_send_draft` accepts only a draft created in an *earlier* turn of the same conversation (with Tool
  context; until then, at least 2 s old), so a model cannot draft and send in one breath. When core confirmation is on,
  `t3_send_draft` becomes a `confirm: true` action and the module check stays as a second lock.
- **Ceiling.** The OAuth grant is the hard limit: approve at Auto or Supervised. A leaked voice-assistant token then
  cannot start full-access work. Revoke in T3's Sharing & access.
- **Wake-word accidents.** A TV saying "start a thread …" reaches a draft at worst; sending needs a second, explicit yes.
- **Prompt injection.** Thread text read back to the model is untrusted data (an agent could write "tell the assistant
  to send …"); results are wrapped and labelled, and no send happens without the owner's yes.
- **Personal content.** Thread content and PR titles are `personal` presentations: not shown on shared screens, not
  announced in shared rooms unless the device is trusted.
- **Same user, same machine.** T3 agents run as the user that also runs the assistant server; they can read
  `data/` but not the encrypted vault (by design, see the settings-UI decision). Keep it that way.

## 14. Foundations needed

| Foundation | Needed for | Without it |
|---|---|---|
| [Connection](../module-investigation/module-definition-config-and-dependencies.md) (§B.4) | OAuth sign-in, token in the vault | A secret field "access token" plus a one-off sign-in script on the host |
| [Tool context](../module-investigation/shared-state-jobs-and-notifications.md) (§4.5) | trusted-device rule, "earlier turn" check, announce on the origin device | assistant-to-device assignment as the gate; 2 s draft age |
| Risk policy (§B.5) | leaving write tools out on untrusted devices | as above |
| [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md) (§6) + [Notification service](../module-investigation/shared-state-jobs-and-notifications.md) (§8) | "tell me when done" across restarts | in-memory watch, spoken via core `Say` once that is exposed; until then T3's own phone push |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | cards, confirm, handoff | everything spoken |
| [Module store](../module-investigation/shared-state-jobs-and-notifications.md) | aliases, watches | aliases as a settings text field |

**Useful first version (S–M):** read-only grant, `t3_overview`, `t3_thread_status`, `t3_pull_requests`, a context line,
the coding template. Then the draft/send pair and stop at the Auto ceiling. Then watches.

### What breaks when T3 Code runs on another machine

| Concern | Same machine (today) | Other machine |
|---|---|---|
| Discovery | `server-runtime.json` gives the origin | URL typed by the owner |
| Transport | loopback HTTP | needs HTTPS: Tailscale HTTPS (`t3 serve --tailscale-serve` or the desktop switch) or the T3 Connect URL; plain LAN HTTP refused (§11) |
| Sign-in | loopback redirect works if a browser runs on the server | paste-back flow; approval with a pairing code on the T3 machine |
| CLI fallback | available | gone |
| Waits | direct | ≤ 45 s chunks matter on T3 Connect (≈ 100 s idle drop) |
| Desktop-app server | the server only runs while the app is open | install T3's background service (`t3 service install`) on that machine |
| Links | `app.t3.codes` links work anywhere | same |
| Cloud dependency | none | T3 Connect route depends on T3's relay (Clerk identity, tunnel) **[doc]**; Tailscale does not |
| Latency | loopback | one LAN or tailnet hop per call; measure |

## 15. Open questions

1. **Ceiling.** Approve the assistant at **Auto**, **Supervised** (every command waits for an approval we cannot give by
   voice), or Read only at first?
2. **Approvals by voice.** Upstream deliberately keeps approvals out of MCP. Is "approve it in T3 on your phone" acceptable,
   or is approving by voice wanted enough to justify the undocumented RPC path (option C), which I recommend against?
3. **Where will T3 run** after the assistant moves to a server: on this desktop (then Tailscale HTTPS or T3 Connect), or
   as T3's background service on the same server?
4. **Default workspace** for voice-started threads: a new worktree from `origin/main` (my default), or the project root
   as T3's own default?
5. **Read-back length.** Read the full prompt back on every device, or only on screenless ones, with the screen as the
   check elsewhere?
6. **Double notifications.** Keep T3's phone push and add in-room speech, or have ours replace it for watched threads?
7. **CI status** needs a GitHub Connection. Is a `github` module (checks, reviews) wanted, or is T3's PR state enough?
8. **30-day re-approval.** Acceptable, or should the module mint a fresh session through the CLI on the same host
   (full-access ceiling, which I advise against)?
9. **Disagreement with the landscape documents.** They list code-related work as `code-runner` and `mcp-client` only;
   I recommend a dedicated module rather than routing T3 through the generic MCP bridge, because voice needs drafts,
   summaries and a ceiling the generic bridge does not have.
