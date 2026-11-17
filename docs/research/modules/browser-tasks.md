# Browser tasks

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md).
Outside facts carry inline links checked on this date. **[unverified]** marks a claim not confirmed against a primary
source. Latency and success figures are estimates until measured with `TurnTrace` and a run log.

## 1. Summary

`browser-tasks` does delegated jobs in a real browser on the server. Examples: "book a table for four at Lucas on
Friday", "check if the Lego set is back in stock", "renew my library books", "fill in the school's absence form for
Mia". A task is a **background job**: it starts in a turn, reports progress, and asks the owner a question when it is
stuck or about to commit. It may show the live browser or screenshots on a screen. It ends with a spoken result.
Repeated tasks become **recipes**: recorded steps that rerun without a model, which makes "is it back in stock" cheap
enough to schedule.

**Boundaries.**

- [web-search.md](web-search.md) `read_page` fetches static pages without JavaScript, and its `research` job only
  reads. This module handles pages that need JavaScript, a login, or a form.
- [briefing.md](briefing.md)'s page watchers (changedetection.io) cover pages that change without a login. A stock
  check on a public product page belongs there. A stock check behind a login, or on a page that needs clicks, is a
  recipe here.
- [mcp-client.md](mcp-client.md) lists Playwright MCP as a stdio server. That path stays possible, but this module is
  the recommended one, because it adds jobs, the confirmation gate, credentials and recipes (§5).

**Priority: later** (third wave). The value is real but narrow. Reliability on unfamiliar sites is about one success
in two (§2). It needs most foundations, plus confirmations switched on, before it may submit anything.

**Effort: L.** The job runner, driver and progress reporting are M. Credentials, the confirmation gate, live view,
recipes and site policy make it L. Chromium on the server is the heaviest native dependency in the catalogue.

## 2. What others do

| System | How it works | Copy | Avoid |
|---|---|---|---|
| **ChatGPT agent / Operator** | A remote browser driven by a computer-use model. It asks before consequential actions and lets the user take over for logins and payment **[unverified: openai.com returned 403 to the research fetch]** | Take-over for logins; stop before committing | — |
| **Claude in Chrome** | Runs in the user's own Chrome with per-site permissions. It asks before publishing, purchasing or sharing personal data, and blocks financial, adult and pirated-content sites. Without mitigations, 23.6 % of prompt-injection attacks succeeded; with them, 11.2 % ([blog](https://claude.com/blog/claude-for-chrome), [help](https://support.claude.com/en/articles/12012173-getting-started-with-claude-for-chrome)) | Per-site permission; blocked categories; the injection numbers as a warning | Running in the person's main browser profile |
| **Anthropic computer use** | Tool `computer_toolset_20260801` for the 5.x models (no beta header). Docs advise an isolated VM, a domain allowlist and human confirmation for purchases and accepting terms ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)) | Allowlist and confirmation guidance | — |
| **OpenAI computer use** | Responses API tool `{"type": "computer"}` returning `computer_call` actions; advises confirming purchases and form submissions ([docs](https://developers.openai.com/api/docs/guides/tools-computer-use)) | — | — |
| **Gemini computer use** | Built into general Gemini models. Risky steps return `safety_decision: require_confirmation`, and the app answers with `safety_acknowledgement`. Seven policy categories include financial transactions and account creation ([docs](https://aistudio.google.com/docs/computer-use)) | A model-side confirmation signal *in addition to* our own gate | Relying on it alone |
| **Stagehand v3** | TypeScript, talks CDP directly (no Playwright dependency) since 2025-10-29. `act`, `extract` (zod schema), `observe`, `agent().execute()`. **Caches** elements and actions, so a repeated action needs no model call until the page changes ([blog](https://www.browserbase.com/blog/stagehand-v3), [docs](https://docs.stagehand.dev/v3/first-steps/introduction)) | Action cache = our recipes; typed `extract` | Vendor-measured speed claims |
| **browser-use** | MIT, Python ≥ 3.11 first; a TypeScript port exists, but which npm package is official is unclear **[unverified]** ([repo](https://github.com/browser-use/browser-use)) | — | A Python runtime on the server for one module |
| **Playwright MCP** | Accessibility-snapshot tools (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`, …). Vision tools are opt-in (`--caps vision`). The profile persists by default, `--isolated` keeps it in memory. The README itself says CLI plus skills is more token-efficient than MCP ([repo](https://github.com/microsoft/playwright-mcp)) | Snapshot-first, vision as fallback | 5–14k tokens of tool definitions in a voice assistant's prompt (launchers §3.15) |

**How reliable is this?** On Online-Mind2Web (300 tasks on 136 live sites, judged by people), Operator succeeded 61.3 %
of the time, Claude Computer Use 3.7 56.3 %, and Browser Use 30.0 %, although Browser Use claimed about 90 % on
WebVoyager ([paper](https://arxiv.org/html/2504.01382v4)). Newer models are surely better, but no comparable
independent figure was found. Plan for **"often fails on a new site; reliable once a recipe exists"**, and design the
spoken reporting around failure.

## 3. Example conversations

Most need no screen. **S** = a screen adds the live view or the confirmation card.

1. "Hey Jev, check if the Lego Titanic is back in stock at Intertoys." → recipe `intertoys-stock` exists (product URL,
   one `extract`) → 4 s, no model call: "Still out of stock. Want me to check every morning and tell you when it's
   back?" "Yes." → a daily recurring job.
2. "Renew my library books." → recipe `library-renew` with Ian's saved login → 40 s: "Renewed three books until 9
   December. *Dune* couldn't be renewed: someone reserved it."
3. "Book a table for four at Lucas on Friday at seven." → new task, model-driven → "I'll try their booking page; it
   may take a few minutes." → progress → the gate: "They have 19:00 or 19:30 for four. 19:00 needs a phone number and
   says no-shows cost €25 per person. Shall I book 19:00 under Ian?" **S:** the confirmation card with a
   screenshot of the filled form. "Yes." → "Booked. Confirmation number K7Q2."
4. Stuck, with a question: the school form asks "reason for absence" with five options → kitchen device: "The absence
   form wants a reason: illness, medical appointment, family, religious holiday or other. Which?" "Illness." → it
   continues.
5. Stuck, needs a person: a CAPTCHA or 2FA code → "The site wants a code sent to your phone. Read it to me, or finish
   it on the kitchen screen." **S** take-over in admin.
6. "How's the table booking going?" → `browser_task_status` → "It's on the booking page, choosing the time. Two
   minutes so far." "Show me." → the live view on this screen. **S**
7. Refused by policy: "Buy the Lego set if it's back." → "I won't buy things on my own. I'll tell you the moment it's
   in stock and put the page on your phone." (`money` is `deny` by default, module definition §B.5.)
8. Ambiguous: "Renew the books." with logins for Ian and Sam → "Yours, Sam's, or both?"
9. Failure: "Check my bin collection on the council site." → after 3 minutes: "I couldn't get through the council's
   address search. I've saved screenshots in Settings. A recipe might work after you show me once." (A bin day ICS
   feed in [local-info.md](local-info.md) is the better fix.)

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk (B.5) | Latency | Fast path |
|---|---|---|---|---|---|---|
| `browser_task_start` | `goal: text`, `site?: dynamic` (allowlisted sites), `as?: dynamic` (a saved login), `deadlineMinutes? ≤ 30` | `{ taskId, started }` and a spoken "I'll try…" | W (creates a job) | `change` to start; commits are gated separately (§13) | < 300 ms to start; job 30 s–15 min | no |
| `browser_recipe_run` | `recipe: dynamic`, `params?` (the recipe's typed fields) | the recipe's `extract` result, or `{ taskId }` if long | per recipe (R for checks) | per recipe | 2–60 s | yes, by phrase |
| `browser_recipe_watch` | `recipe`, `params?`, `every: choice` (hourly, daily), `until?: condition` ("in stock") | "I'll check every morning." | W | `change` | < 50 ms | no |
| `browser_task_status` | `task?: dynamic` | step, elapsed, last screenshot reference | R, speculative | read | < 20 ms | yes |
| `browser_task_answer` | `task`, `answer: text` | "Thanks, continuing." | W | `change` | < 50 ms | no |
| `browser_task_show` | `task`, `where?: dynamic` (a screen) | "On the kitchen screen." | W | read | < 200 ms | yes |
| `browser_task_cancel` | `task` | "Stopped." | W | `change` | < 500 ms | yes |

The commit itself is **not** a tool the model can call: the driver stops at a commit point and asks core to confirm
(§13). No tool gives the model passwords, cookies or card numbers.

## 5. Integrate or build

### 5.1 Driver options

| Option | Language and runtime | Cost per task | Robustness | Fit |
|---|---|---|---|---|
| **A. Playwright MCP through [mcp-client](mcp-client.md)** | stdio Node server, our Chromium | high: tool definitions plus accessibility snapshots in the assistant's own context | good on accessible sites | Quickest experiment. But no recipes, no gate before submit, and a voice turn's context fills with page dumps |
| **B. Stagehand v3 in an adapter** (`packages/browser-stagehand`) | TypeScript, CDP, local Chromium; "works with any Chromium browser" ([docs](https://docs.stagehand.dev/v3/first-steps/introduction)); local mode without Browserbase **[unverified on the fetched pages]** | low once cached; model calls only on new or changed pages | good; self-healing when the DOM shifts (vendor claim) | **Recommended.** TS, fits the adapter rule, action cache gives recipes almost for free |
| **C. Own loop on `playwright-core` with aria snapshots** | TypeScript, Playwright 1.65 ([notes](https://playwright.dev/docs/release-notes)) | medium | as A, but under our control | Fallback if Stagehand's local mode disappoints |
| **D. Provider computer use** (Anthropic toolset, OpenAI `computer`, Gemini) | screenshots to the provider, actions back | highest (images per step) | best on visual or badly-labelled sites | Second driver for sites where A–C fail; not by default |
| **E. Python browser-use** | Python ≥ 3.11 sidecar | low–medium | 30 % on Online-Mind2Web | No: a second runtime for one module |

**The driver's model** is a configured account (module setting), not the asking assistant's. A Claude subscription
assistant cannot lend its harness to a background job cleanly, and browser steps want a cheap, fast model. The
[web-search](web-search.md) `research` job has the same question (its open question 4).

### 5.2 Where the browser runs

| Option | Facts | Verdict |
|---|---|---|
| **Local Chromium on the server** | Playwright supports Debian 12/13 and Ubuntu 22.04–26.04 on x86-64 and arm64. Headless runs use `chrome-headless-shell`; arm64 Linux uses Chromium builds ([intro](https://playwright.dev/docs/intro), [notes](https://playwright.dev/docs/release-notes)). Install `npx playwright install --with-deps --only-shell chromium` (needs root for the apt packages) ([browsers](https://playwright.dev/docs/browsers)). The docs' sample `du` shows about 281 MB for Chromium. RAM is several hundred MB per open context **[unverified estimate]** | **Default.** Home IP, no account, no per-hour cost |
| **Steel (self-hosted)** | `ghcr.io/steel-dev/steel-browser`, Apache-2.0, CDP on 9223, a `/ui` with live view and replay; ports are unauthenticated ([repo](https://github.com/steel-dev/steel-browser)) | Good if the browser should live in its own container or on another box; bind to localhost |
| **Browserless** | SSPL-1.0 or commercial; persistent sessions and live streaming are premium ([repo](https://github.com/browserless/browserless)) | No: licence and paywalled features |
| **Browserbase (hosted)** | Free: 1 browser-hour, 15-minute sessions. Developer: $20/month for 100 hours, basic stealth and CAPTCHA solving. Live view through `debuggerFullscreenUrl`, take-over possible. Contexts persist logins, encrypted at rest ([pricing](https://www.browserbase.com/pricing), [live view](https://docs.browserbase.com/features/session-live-view), [contexts](https://docs.browserbase.com/features/contexts)). A Cloudflare "signed agent" ([Cloudflare](https://blog.cloudflare.com/signed-agents/)) | **Optional provider** for sites that block a home browser. Breaks local-first, and logins then live at a vendor |
| Hyperbrowser, Anchor | About $0.09–0.10 per browser-hour, CAPTCHA on paid plans ([Hyperbrowser](https://www.hyperbrowser.ai/pricing), [Anchor](https://anchorbrowser.io/pricing)) | Only if Browserbase is ruled out |

**Recommendation:** Stagehand (B) on a local Chromium headless shell. Run it in a **separate worker process** under
its own user, with a memory cap, started on demand and stopped after 5 idle minutes. Keep the provider choice open
for Browserbase. Use computer use (D) as a per-site override.

### 5.3 Recipes

A recipe is a named, parameterised sequence the module stores after a successful run, once the owner says "save
that". Steps are Stagehand's cached actions plus one typed `extract` (zod schema → our `Schema`), for example
`{ inStock: boolean, price: number }`. A recipe reruns without a model. On a cache miss (the page changed), it
retries once with the model and marks itself "repaired" in admin. Recipes have the same parameter types as actions
(`Param.text | choice | number`), so a recipe can also be offered as a routine step and a phrase.

### 5.4 Credentials

- **Profiles.** One Playwright persistent profile per *site and person* in `data/browser/profiles/<site>-<person>/`,
  never shared between people. Playwright's own docs warn that `storageState` files are impersonation-grade secrets
  ([auth](https://playwright.dev/docs/auth)). Profiles are encrypted at rest with a key from the vault, and decrypted
  only into the worker's private tmpfs while it runs **[design proposal]**.
- **First login by the owner,** through take-over (§8): the owner logs in once on a screen, and the profile keeps the
  session. No password is stored if the session lasts.
- **Passwords when needed:** from the vault, or from Bitwarden through `bw serve` on localhost:8087
  ([Bitwarden CLI](https://bitwarden.com/help/cli/)). They are injected by the driver into a field the model has
  *named*. The model never sees the value, as in 1Password's "Secure Agentic Autofill" with Browserbase, which also
  requires real-time human approval per use ([1Password](https://1password.com/press/2025/oct/browserbase-ai-security-partnership)).
- **2FA codes and CAPTCHAs** are never solved automatically. The task asks the person (example 5).
- **Payment cards are never stored** in this module.

## 6. Data

| Where | Scope | Content |
|---|---|---|
| settings | household | site allowlist with per-site policy (allowed, logins allowed, commits allowed, driver, hosted or local); driver model account; budgets |
| Module store `tasks` | person, else household | goal, site, as-person, state (`running`, `asking`, `confirming`, `done`, `failed`, `cancelled`), step log, screenshot references, result, cost; 30 days |
| Module store `recipes` | household or person | name, site, params schema, cached steps, extract schema, last success, repairs |
| Module store `watches` | person | recipe, params, schedule, stop condition, last value |
| files | — | `data/browser/profiles/` (encrypted), `data/browser/shots/<task>/` (screenshots, 7 days) |

Exports: `browser.tasks.active` as an ambient line ("booking a table at Lucas, waiting for your answer").

## 7. Long-running work and events

- **A task** is a Scheduler `task` job (shared state §6.1), at most one running at a time (one Chromium) and two queued.
  A hard deadline (default 10 minutes, at most 30) and a model budget per task (default 40 steps) stop runaway loops.
- **Restart:** a task's browser dies with the process. It is reported "interrupted by a restart", with the last
  screenshot, and never rerun automatically, because a half-submitted form must not be submitted twice. Recipes marked
  idempotent (read-only checks) may rerun.
- **Questions** use the Notification service's `question` kind with `followUp`. The task waits up to 10 minutes, then
  stops and reports.
- **Watches** are `recurring` jobs that run a recipe. They notify when the stop condition flips, and then end.
- **Events published:** `browser.task.started`, `browser.task.asking`, `browser.task.confirming`,
  `browser.task.finished`, `browser.watch.hit`.

## 8. Presentation

- **Progress:** a pinned `progress` item ("Booking at Lucas · step 6"), with a cancel action.
- **Screenshots:** every step's screenshot goes through `/media/` as an `image`, updated in place with `present.update`
  at most once every 2 s. That keeps the page CSP at `img-src 'self'` (presentation §3.2). A CDP screencast
  (`Page.startScreencast`) **[unverified detail]** or Playwright's newer `page.screencast` API (1.59,
  [notes](https://playwright.dev/docs/release-notes)) feeds the frames.
- **Live view and take-over:** in admin, not on the stage. It is a page that relays the frames and forwards clicks and
  keys over our websocket. A Browserbase iframe would break the CSP and leak the session to any viewer. Take-over on a
  kitchen tablet is possible only for its own person's task, on a `private` or trusted device.
- **The confirmation card:** a `confirm` presentation with the screenshot of the filled form and a summary of what will
  be sent ("table for 4, Fri 19:00, name Ian, phone ending 42, no-show fee €25").
- **The character:** "working" while the user waits on the first step. It is idle afterwards, because the job is in
  the background.
- **Headless:** spoken progress only on request, the question and the confirmation spoken in full, and "the details
  are in your inbox".

## 9. Notifications and proactive behaviour

Results are `result` at `normal`, on the origin device, else the inbox. Questions and confirmations are `question` at
`high`, to the origin device, then the person's phone after 60 s. Watch hits are `normal` to the person ("The Lego
Titanic is back in stock at Intertoys, €679"), with a `handoff` link to the page. Nothing else is said unprompted.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | module on (off); local or hosted browser; allowed site list; commit policy per class (book, submit form, message, purchase) | off; local; empty; confirm, confirm, confirm, deny |
| Module | driver (Stagehand, own loop, computer use); driver model account; deadline; step budget; monthly cost cap; screenshot retention | Stagehand; —; 10 min; 40; €10; 7 d |
| Assistant | may start browser tasks; may run recipes | no; yes |
| Device | may confirm commits (trusted); may show live view | off; screens in `private` places |
| Person | own logins and recipes; phone for questions | — |

**First run:** install Chromium from the Health page → add a site to the allowlist → optionally log in through
take-over → run one task with "save as recipe".

## 11. Native tools and dependencies

| Dependency | Where | Missing, spoken |
|---|---|---|
| Chromium headless shell (Playwright-managed, pinned with Playwright's version) plus its apt libraries | server, x64 or arm64 | "Browser tasks aren't set up on this server: the browser isn't installed." |
| `@browserbasehq/stagehand` (npm) | server, in the adapter package only | build time |
| A driver model account | vault | "Browser tasks need a model account in Settings." |
| `bw` (optional) | server | "I can't reach the password manager, so I can't log in to the library." |
| Browserbase key (optional) | vault | falls back to local, says so |

Under the hardened systemd unit (module definition §C.8), Chromium's own sandbox needs user namespaces. The worker
may need `--no-sandbox` inside its own systemd sandbox instead **[unverified: depends on the unit's settings]**. `pva
doctor` should test-launch the browser.

## 12. Interaction with the rest of the system

- **Voice.** Start with a lead-in ("I'll try their booking page"), then go quiet. Read results in one or two sentences.
  Spoken questions use closed options whenever the page has them. Dates and times are read back in full before a
  commit ("Friday the 21st at seven in the evening").
- **Speech recognition.** Site and shop names are mis-heard, so the `site` parameter matches the allowlist with edit
  tolerance, and a new site is never opened from a misheard name without saying it back.
- **Fast path.** Recipes with phrases run without the model ("check the Lego stock").
- **Assistants.** No template. Only assistants the owner chooses get `browser_task_start`.
- **Other modules.** Notifications (questions, results), briefing (watch hits in the morning digest), routines (recipes
  as steps), web-search (`read_page` first, a browser task only when it fails), automation-platforms (an n8n flow can
  run a recipe through `/turn`, which is off by default).

## 13. Privacy and safety

- **The commit gate.** The driver classifies each click or submit before it happens:
  - navigation and reading are `read`;
  - typing into fields is `change`;
  - submitting a form, sending a message, booking, accepting terms, or anything with a price is a **commit**.
  - A commit pauses the task and goes through core confirmation at the policy for its class: purchases `money` (deny
    by default), bookings and forms `message` (confirm), on a trusted device or the person's phone.
  - The classifier is a rule set (button text, form method, `type=submit`, URL patterns, any price on the page) plus
    the provider's own `require_confirmation` when the driver is Gemini. It errs towards "commit".
  - Until core confirmations are on (current-system.md §2.5), **no commit can happen at all**: tasks stop at the gate
    and hand the page to the person.
- **Prompt injection.** Page text is untrusted. A page that tells the agent to visit another site, reveal data or
  "ignore instructions" must not be obeyed. The worker enforces the site allowlist at the network layer, not only in
  the prompt. Claude in Chrome's 11.2 % residual injection success is the reason.
- **Terms and anti-bot measures.** Many sites forbid automated access. Amazon sued Perplexity over its Comet agent in
  November 2025 and won a preliminary injunction on 2026-03-06 ([eWeek](https://www.eweek.com/news/amazon-perplexity-comet-injunction/));
  an appeals court later overturned it **[ruling date and court unverified]**
  ([ChannelNews](https://www.channelnews.com.au/amazon-loses-bid-to-block-perplexitys-ai-shopping-assistant/)).
  Policy: sites are added by the owner only; no CAPTCHA solving; a modest step rate; one task at a time; the owner
  is told that some sites forbid this.
- **Shared devices:** task results with personal data (bookings, library loans) are `personal` presentations, not
  shown on `shared` screens. Live view only on private or trusted screens.
- **Children and guests:** cannot start tasks or confirm commits.

## 14. Foundations needed

Scheduler (`task`, `recurring`), Notification service (`question`, `result`), Module store, core confirmations and the
risk policy, Presentation (`progress`, `image` with `present.update`, `confirm`), Device capabilities and places
(trusted, private), Connection (driver model account), Requirements and health (Chromium probe), Tool context (who
asked: logins are per person), and the vault for encrypted profiles.

**A useful first version without most of them:** read-only recipes only, with no commits, no logins and no live view.
For example, "is it back in stock" on a JavaScript-heavy page, run in the turn with a 20 s timeout and a spoken
answer. That needs only Chromium and the adapter, and it shows whether the stack works on the server's hardware.

## 15. Open questions

1. **At all, and when?** Is this worth a 300 MB browser on the server and a third model account for a narrow set of
   tasks? Which tasks do you actually want: library, school forms, bookings, stock?
2. **Commits:** may it ever submit a booking or form after a spoken "yes" on a trusted device, or only hand over the
   filled page for you to press the button?
3. **web-search §5.4 against launchers §3.2.** Web-search keeps Playwright out of `read_page`; the launcher landscape
   proposed a Playwright render as its fallback. Once this module puts a browser on the server, this document sides
   with the landscape: `read_page` may fall back to it for JavaScript pages, at a cost of seconds per page. Agreed?
4. **Hosted browsers:** allowed for sites that block the home IP, given that logins then live at Browserbase?
5. **Disagreement with mcp-client §5.4,** which lists Playwright MCP as a starter server for "browser jobs". This
   document recommends against that path for tasks with commits. Keep it listed for read-only use only?
6. **Driver model:** a fixed cheap model account, or the asking assistant's account?
7. **Server hardware:** is the target arm64 or x64, and does it have the RAM for Chromium next to the speech models
   (about 2.5 GB)?
