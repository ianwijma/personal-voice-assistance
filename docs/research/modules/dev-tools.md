# Dev tools

Research write-up, 2026-11-18. Not an approved design. Shared foundations are named as in [`README.md`](README.md) and
linked, not redesigned. Outside facts carry a link; **[unverified]** marks what I could not confirm against a primary
source. Latency figures are targets to be measured with `TurnTrace`.

## 1. Summary

Developer status by voice, beyond T3 Code: pull or merge requests waiting on the owner, failing CI, new issues and
releases on GitHub and GitLab; whether the last deploy on Vercel, Coolify, Dokploy or Kubernetes worked; new and
regressed errors in Sentry; on-call pages; a "what broke overnight" digest; and one write, an issue created from
dictation, always drafted and confirmed. **Read-only by default.**

- **Boundary.** [t3-code](t3-code.md) owns coding threads and their linked PRs; it deferred CI checks to "a later
  `github` module" ([t3-code §5](t3-code.md#5-integrate-or-build), Q7). This is that module, and `t3_ci_status` should
  call it. [mcp-client](mcp-client.md) can bring GitHub's, GitLab's or Sentry's MCP servers; this module is the
  voice-shaped native subset (§5.2). [homelab](homelab.md) owns hosts and containers; this module owns "did my deploy
  work" on deploy platforms, even when Coolify or Dokploy run on the owner's homelab. [briefing](briefing.md) composes
  the overnight digest from this module's `dev_overnight`.
- **Priority: second wave.** Real daily value for the owner and cheap read-only first version; nobody else in the
  household uses it.
- **Effort: M.** GitHub plus one deploy platform plus Sentry, read-only, with the digest, is M. Each extra platform is S.
  The dictated issue is S once confirmations exist.

## 2. What others do

| Who | What | Copy | Avoid |
|---|---|---|---|
| GitHub mobile, notifications inbox | "Review requested", "CI failed on your PR", grouped per repo | The *involves me* filters: `review-requested:@me`, `author:@me` with failing checks | Every notification as noise |
| [GitHub MCP server](https://github.com/github/github-mcp-server) | Remote at `https://api.githubcopilot.com/mcp/`, toolsets selected by `X-MCP-Toolsets`, read-only by `X-MCP-Readonly: true` ([config guide](https://github.blog/ai-and-ml/generative-ai/a-practical-guide-on-how-to-use-the-github-mcp-server/)) | Toolsets and the read-only switch | Dozens of tools in a voice prompt |
| [GitLab MCP server](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) | Beta since 18.6, `/api/v4/mcp`, OAuth dynamic registration | — | OAuth bugs on GitLab.com reported ([issue](https://gitlab.com/gitlab-org/gitlab/-/issues/585699)) |
| [Sentry MCP](https://docs.sentry.io/product/sentry-mcp) | `https://mcp.sentry.dev/mcp`, OAuth; `search_issues` translates natural language into Sentry search | Ask for "new issues in the last 24 h" | AI search tools needing a second model key on stdio |
| PagerDuty, Opsgenie, Grafana OnCall | Paging with acknowledge | Acknowledge as the one on-call write | Opsgenie ends support on 2027-04-05 ([Atlassian](https://www.atlassian.com/software/opsgenie)); Grafana OnCall OSS archived 2026-03-24 ([Grafana](https://grafana.com/docs/oncall/latest/set-up/open-source/)) |
| Slack/Discord deploy bots | "Deploy of `web` to production succeeded in 2m 10s" | One sentence per deploy | — |

## 3. Example conversations

1. "Hey Jeff, anything waiting on me?" → `dev_inbox` → "Two reviews requested: Sol's stage layout PR and the CI cache PR. And your timer PR has one failing check." (screen: `list`)
2. "What failed on the timer PR?" → `dev_checks { pr: "timer" }` → "The Playwright job failed: three tests in the stage suite timed out. Lint and unit tests passed."
3. "Did the deploy work?" → `dev_deploys { since: "1h" }` → "Yes. Coolify deployed the assistant docs site twelve minutes ago; it's healthy."
4. "What broke overnight?" → `dev_overnight` → "Two things. CI on main failed at 03:10 after the dependency bump, and Sentry has a new error in the web app, 42 events, *TypeError: cannot read 'kinds' of undefined*. Nothing paged."
5. "Any new issues on the voice assistant?" → "One, from yesterday: *Echo gate drops a single stop*, opened by you."
6. "Create an issue on the voice assistant repo: timer card flickers on the kitchen tablet when the minute changes." → "Draft for personal-voice-assistance. Title: 'Timer card flickers when the minute changes'. Body: 'Seen on the kitchen tablet.' File it?" → "Yes." → "Filed as issue 112." **Screen helps:** confirm card with full text.
7. "Latest release of Effect?" → `dev_releases { repo: "Effect-TS/effect" }` → "Version 4.1.6, released Tuesday." (any public repo)
8. **On-call:** "Am I on call?" → "No, you're off until Monday 09:00. Nothing is open."
9. **Ambiguous:** "How's CI?" → "On which repo: the voice assistant or the docs site? Main is green on both."
10. **Failure:** "Did the deploy work?" → "I can't reach Dokploy; the token may have expired. Coolify's last deploy was fine."

## 4. Tools

Risk classes are [§B.5](../module-investigation/module-definition-config-and-dependencies.md#b5-risky-tools)'s;
template equivalent in brackets. Repos and projects are resolved from owner aliases and the watched list, not by the
model.

| Tool | Parameters | Returns | R/W | Risk | Latency (target) | Fast path |
|---|---|---|---|---|---|---|
| `dev_inbox` | `forge?: github \| gitlab`, `repo?` | PRs/MRs awaiting my review, my PRs with failing checks or changes requested, mentions; ≤ 8 | R | read (personal) | 0.4–1.2 s (one GraphQL query); cached 2 min | yes |
| `dev_checks` | `pr?` or `ref?` (default: main of the default repo), `repo?` | per check: name, state, failing step summary | R | read | 0.5–1.5 s | yes |
| `dev_issues` | `repo?`, `since?`, `state?`, `label?` | ≤ 8 issues with title, author, age | R | read | 0.4–1 s | yes |
| `dev_releases` | `repo` (any public repo by alias or `owner/name`) | latest release, date, highlights cut to 600 chars | R | read | 0.3–1 s | yes |
| `dev_deploys` | `platform?`, `app?`, `since?` | deploys: app, environment, state, duration, commit title, health | R | read | 0.3–1.5 s per platform | yes |
| `dev_errors` | `project?`, `since?` (24 h), `kind?: new \| regressed \| top` | Sentry issues: title, count, users, first seen | R | read (personal: may contain user data) | 0.5–1.5 s | yes |
| `dev_oncall` | — | am I on call, until when, open incidents | R | read | 0.4–1 s | yes |
| `dev_overnight` | `since?` (default: last quiet-hours start) | digest: CI failures on default branches, failed deploys, new Sentry issues, pages, new issues | R | read | cached by a job (§7), < 100 ms | yes |
| `dev_issue_draft` | `repo`, `title`, `body?`, `labels?` | `draftId`, read-back sentence; nothing filed | W (draft) | change (conversation scope) | < 50 ms | no |
| `dev_issue_file` | `draftId` | issue number and URL | W | **message** (outward-facing, public on public repos) | 0.5–1.5 s | no |
| `dev_ack_page` | `incident?` | acknowledged | W | **message** (tells the team you are on it) | 0.5–1.5 s | yes (with confirm) |
| `dev_rerun` | `pr` or `run` | rerun started | W | change (costs CI minutes) | 0.5–1 s | no |

Not offered: merge, approve, close, comment, deploy, rollback, scale, delete, cancel runs, Sentry resolve or ignore.
Those are code-review or production decisions, and a voice prompt is the wrong place for them. `dev_rerun` is the one
borderline write, off by default.

## 5. Integrate or build

### 5.1 Backends

| Platform | API | Credential (least power) |
|---|---|---|
| GitHub | GraphQL for `dev_inbox` (one `search(query: "is:pr is:open review-requested:@me")` plus `author:@me` with `statusCheckRollup`); REST `GET /repos/{o}/{r}/commits/{ref}/check-runs`, `/actions/runs?status=failure`, `/releases/latest`, `POST /repos/{o}/{r}/issues` | Fine-grained PAT, selected repos: Metadata, Pull requests, Checks, Actions, Issues **read**; Issues **write** only if filing is on. Unauthenticated for public releases (60 requests/h) |
| GitLab | REST v4 `GET /merge_requests?reviewer_username=…&state=opened&scope=all`, `/projects/:id/pipelines?ref=main&status=failed`, `POST /projects/:id/issues` | Personal or project token, `read_api`; `api` only for filing **[unverified that a narrower write scope exists]** |
| Forgejo / Gitea | Gitea-compatible REST (`/repos/search`, `/repos/{o}/{r}/pulls?state=open`, commit statuses) | token with read scopes |
| Vercel | REST `GET /v6/deployments?projectId=…&limit=5` (`state`: `READY`, `ERROR`, `BUILDING`) **[unverified version path]** | access token scoped to the team |
| Coolify | `GET /api/v1/deployments` and per-application deployments, bearer token ([API](https://coolify.io/docs/api/overview)); `read` permission redacts sensitive values ([permissions](https://coolify.io/docs/api/permissions)) | token with `read` only |
| Dokploy | `GET /api/deployment.all?applicationId=…`, `x-api-key` ([reference](https://docs.dokploy.com/docs/api/reference-deployment)); deploy "done" does not mean the container is healthy | API key (no read-only scope found **[unverified]**) |
| Kubernetes / Argo CD / Flux | `@kubernetes/client-node`: Deployments' `status.conditions`, rollout generation; Argo CD `GET /api/v1/applications` sync and health | ServiceAccount bound to the built-in `view` ClusterRole, namespace-limited |
| Sentry | REST `GET /api/0/organizations/{org}/issues/?query=is:unresolved firstSeen:-24h&statsPeriod=24h` | internal integration token with `event:read`, `project:read` |
| PagerDuty | REST `GET /oncalls?user_ids[]=…`, `/incidents?statuses[]=triggered`; Events API not needed | read-only API key; user token for acknowledge |
| ntfy / self-hosted alerting | pages that arrive as [notifications](notifications.md) hooks | — |

### 5.2 Native tools or MCP servers

GitHub's remote MCP with `X-MCP-Readonly: true` and `X-MCP-Toolsets: pull_requests,actions,issues` is the closest
alternative, and [mcp-client §5.4](mcp-client.md#54-a-vetted-starter-list) lists it. For voice it falls short in four
ways: no "waiting on me" in one call (the model chains three to five calls, each a round trip of seconds on the
subscription path); results sized for an IDE, not speech; no draft-then-confirm for filing; no fast path. Sentry's MCP
is similar. **Recommendation: native tools for the dozen questions above, using the forge APIs directly; the MCP
servers stay available through the MCP client for the long tail ("find the PR that changed the echo gate") in an
Admin or coding assistant.** No provider SDK is needed (`fetch`; `@kubernetes/client-node` only inside an adapter
package under the provider-SDK rule).

### 5.3 Which forge first

GitHub: the owner's repos are there (commit history shows PR numbers into the 80s on GitHub). GitLab and Forgejo as
adapters behind the same `Forge` interface (`inbox`, `checks`, `issues`, `releases`, `createIssue`).

## 6. Data

| What | Scope | Schema | Read by others |
|---|---|---|---|
| Connections | [Connection](../module-investigation/module-definition-config-and-dependencies.md#b4-connections-and-oauth-on-a-headless-server), person (owner) | GitHub PAT or OAuth app, GitLab token, Sentry, deploy platforms, PagerDuty | t3-code (GitHub, for CI) |
| Watched repos and apps | person | `{ forge, repo, spoken[], defaultBranch, important: boolean }`; `{ platform, app, spoken[] }` | briefing |
| Seen state | person | last-seen ids per source, so "new" means new to the owner | — |
| Overnight digest | person | `{ from, to, items[] }`, kept 7 days | briefing |
| Drafts | conversation | `{ draftId, repo, title, body, labels, createdTurn }` | — |

## 7. Long-running work and events

- **Digest job:** a [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler)
  `recurring` job at the end of quiet hours builds `dev_overnight` (missed → run once at start).
- **Watchers:** polling every 2–5 minutes for watched repos' default-branch checks and watched apps' deploys, or
  push where available: GitHub webhooks need a public URL, so polling is the default; Coolify and Dokploy can POST to a
  [notifications](notifications.md) hook on the LAN **[unverified for Dokploy]**.
- **"Tell me when CI finishes on this PR"**: a `task` watching one check suite, ending at completion or after 2 hours.
- **Events:** `dev-tools.ci.failed`, `.ci.fixed`, `dev-tools.deploy.failed`, `.succeeded`, `dev-tools.error.new`,
  `dev-tools.page.triggered`. [t3-code](t3-code.md) may listen to `ci.*` for PRs its threads opened.

## 8. Presentation

`dev_inbox` → `list` (title, repo, why it is here: "review requested", "1 failing check"); tap → typed turn "tell me about
…". `dev_checks` → `list` with state dots; `dev_deploys` → `table`; `dev_errors` → `card` per issue with count and a
`handoff` QR to the Sentry page; `dev_issue_draft` → `confirm` with the exact title and body; `dev_overnight` →
`list` grouped by source. Code, stack traces and diffs are never rendered or spoken; only titles and counts. Without a
screen: count first, then up to three items, then "and two more on the study screen".

## 9. Notifications and proactive behaviour

| What | Priority | Where |
|---|---|---|
| Page triggered while I'm on call | `critical`, repeats until acknowledged | owner devices and phone; ignores quiet hours |
| CI failed on main of an `important` repo | `normal` | owner's study devices, else inbox |
| Deploy failed (watched app) | `normal` | same |
| New Sentry issue in an `important` project | `low`; `normal` if > N events in 10 min | inbox |
| Review requested | `low` | inbox; never spoken unprompted |
| Watched PR's CI finished | `normal` | origin device |

Nothing is announced in shared rooms. If GitHub or PagerDuty already push to the owner's phone, our phone channel stays
off for those kinds (same double-ring rule as [t3-code §9](t3-code.md#9-notifications-and-proactive-behaviour)).

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | — | — |
| Module | platforms and their connections; poll intervals; filing issues on/off; rerun on/off; digest time | none; 2–5 min; off; off; end of quiet hours |
| Assistant | the coding assistant (T3) and an Admin assistant; the main assistant read-only inbox only, if at all | coding and Admin |
| Device | `allowRisky` for filing and acknowledging | off |
| Person | watched repos, apps, projects; aliases; "important" flags; on-call identity | from the token's recent repos |

**First run:** create a fine-grained GitHub PAT (read scopes above, selected repos), paste it; **Test** shows the inbox;
tick watched repos and mark important ones; add Coolify/Dokploy/Vercel tokens and Sentry; optionally PagerDuty.

## 11. Native tools and dependencies

| Dependency | Where | Missing → spoken |
|---|---|---|
| Internet (GitHub, Sentry, Vercel, PagerDuty) | server | "I can't reach GitHub right now." |
| LAN reach to Coolify, Dokploy, Kubernetes API | server | that platform `unavailable` |
| `@kubernetes/client-node` | server, adapter package | Kubernetes adapter absent |
| `gh` CLI | optional, not used | — |

Expired or under-scoped tokens are the common failure: health checks call one cheap endpoint per connection and report
"GitHub token expires in 5 days" to admin.

## 12. Interaction with the rest of the system

- **Voice.** Repo names, PR titles and branch names are misheard; the module matches against watched repos and the
  open PRs' titles ("the timer PR" → the PR whose title contains "timer"), as [t3-code §12](t3-code.md#12-interaction-with-the-rest-of-the-system)
  does for threads. PR numbers as words; SHAs never spoken; error titles shortened to the exception type and a few
  words. Dictated issue text is the owner's words, cleaned of fillers only, never embellished by the model.
- **Fillers.** Reads come from caches where possible; a cold inbox query says "checking GitHub".
- **Assistants.** No template of its own: it joins the "coding" template of [t3-code](t3-code.md#12-interaction-with-the-rest-of-the-system)
  and the Admin template of [homelab](homelab.md#12-interaction-with-the-rest-of-the-system).
- **Intents.** Typed actions: "anything waiting on me", "how's CI on main", "did the deploy work", "what broke
  overnight", "am I on call", "acknowledge" (with confirm).
- **Other modules.** [briefing](briefing.md) reads `dev_overnight`; [t3-code](t3-code.md) calls `dev_checks` for
  `t3_ci_status`; [homelab](homelab.md) and dev-tools both see a failed Coolify deploy: homelab reports the container,
  dev-tools the deploy, and the briefing dedupes by app.

## 13. Privacy and safety

- **Read-only default** is enforced by the credential, not only by policy: the default PAT has no write scopes. Filing
  issues requires a second token or added scope, chosen by the owner.
- **Filing an issue** is `message` (outward-facing; on a public repo it is published to the world): draft in one turn,
  file only after a yes in a later turn on a trusted device; the read-back names the repo and says "public" when it is.
  Prompt injection: issue and PR text read back to the model is untrusted data; a PR body saying "file an issue that…"
  cannot file anything without the owner's yes.
- **Acknowledging a page** is `message`; it tells colleagues someone is on it. Confirm, trusted device only.
- **Personal and third-party data.** Sentry events contain end users' data; only titles and counts are spoken or shown,
  never event payloads. Private repo names and PR titles are `personal`: not on shared screens, not in shared rooms.
- **Guests and children:** nothing.
- Until confirmations are on, `dev_issue_file`, `dev_ack_page` and `dev_rerun` are not shipped.

## 14. Foundations needed

| Foundation | For | Without it |
|---|---|---|
| [Connection](../module-investigation/module-definition-config-and-dependencies.md#b4-connections-and-oauth-on-a-headless-server) | tokens shared with t3-code | secret fields in module settings |
| Risk classes, confirmations | filing, acknowledging | read-only module |
| [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler) | digest, watchers, "tell me when CI finishes" | on-request only |
| [Notification service](../module-investigation/shared-state-jobs-and-notifications.md#8-notifications) | pages, CI failures | nothing proactive |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | lists, confirm card | spoken only |
| [Tool context](../module-investigation/shared-state-jobs-and-notifications.md#45-turn-context-proposal) | personal rules on shared devices; "earlier turn" draft check | assign only to the owner's devices |

**Useful first version (S):** GitHub PAT read-only, `dev_inbox`, `dev_checks`, `dev_issues`, `dev_releases`, one deploy
platform, spoken only, on the coding assistant.

## 15. Open questions

1. **Forges and platforms in use:** GitHub only, or also GitLab or Forgejo? Which of Vercel, Coolify, Dokploy and
   Kubernetes run deploys today?
2. **Filing issues by voice:** wanted, and only on the owner's own repos?
3. **On-call:** is there any paging (PagerDuty, a self-hosted path) or is this a solo setup where "pages" are just
   homelab alerts?
4. **Overnight digest:** its own spoken summary, or only as a section of the [briefing](briefing.md)?
5. **Where it lives:** a separate module (my proposal) or folded into t3-code? [t3-code §15 Q7](t3-code.md#15-open-questions)
   asks whether a GitHub module is wanted at all; I answer yes, because CI and deploys matter for work T3 did not start.
6. **Disagreement with [mcp-client §5.4](mcp-client.md#54-a-vetted-starter-list):** it suggests GitHub's MCP server for
   "any new issues on my repo"; I would answer the common questions natively and keep the MCP server for the long tail.
7. **`dev_rerun`:** allow re-running failed CI by voice (costs minutes, harmless otherwise) or leave every write out?
