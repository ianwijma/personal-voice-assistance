# Settings UI: everything configurable from the browser

> **Changed 2026-11-16 (docs/ASSISTANTS.md §7.1, protocol 7).** The screen is still two levels (a category list, then
> pages), but the categories are now **Overview**, **Assistants** (one entry per assistant, plus All assistants and the
> new-assistant wizard), **Devices** (by device type, defaults first), **Shared settings** (Home, Modules, Language model
> accounts, Routing, Speech recognition models, Voice providers, Limits), **Keys & vault**, **Diagnostics** and **About**.
> The Language model, Speech recognition and Voices categories and the module on/off switches are gone: what they set is
> per assistant (language model account and model, hearing, voice, the modules an assistant has on), and the accounts,
> models and provider keys moved to Shared settings. The flat keys that became per-assistant (`LLM_PROVIDER`,
> `ANTHROPIC_MODEL`, `STT_SHERPA_MODEL`, `ASSISTANT_VOICE`, …) are no longer read by serve mode (the command-line modes still
> read them, and a data directory from before assistants is migrated into one assistant); the admin does not show them, and a
> value set in the environment locks the field of the migrated assistant (**Move to settings** writes it into the
> assistant). Everything below that says "Language model", "Speech recognition" or "Voices" category, or a module switch,
> is the design as built for protocol 5 and 6; the shell, page, validation, apply and reload, protected and locked states, search
> and the env view still work as described.

Design for a multi-level settings screen that replaces `.env` as the way to configure the assistant, written 2026-11-14
against commit `8cfaf14` (branch `t3/cloud-subscription-agent`). Read-only investigation; nothing in the repository was
changed. Builds on `docs/UI-AND-MODULES.md` §1.7/§3.7 and `docs/AGENTS-AND-INTENTS.md` §4 (its audit and screen plan are
still right about *which* settings exist; this document is about *where they live, how the screen behaves, and how
`.env` shrinks*).

Assumed to land in parallel (named here by role; align names with what actually lands):
- **Vault**: encrypted key store outside the repo, unlocked by a password; `PVA_VAULT_PASSWORD` allows unattended unlock.
- **Admin access**: per-connection admin state; protected sections/modules (anything holding a secret, language model,
  speech, agent modules); a "Keys & access" control.
- **`claude-subscription` as an `LLM_PROVIDER`** value, built on `packages/agent-claude-code`.

Legend: **[verify]** = not run or not confirmed here; **[run]** = executed on this machine today.

---

> **Changed 2026-11-16 (docs/VOICE-PROVIDERS.md):** the named voices are gone. The Voices page holds one field,
> `ASSISTANT_VOICE` (a voice key, `provider:voice`; the admin UI shows a voice picker over the HTTP API of that
> design); "Voice engines" is now **Voice providers** (section `voice-providers`, page `voices/providers`) with the
> hosted keys. `DEFAULT_VOICE`, `VOICES` and `TTS_PROVIDER` have no field any more; they are read only to migrate an
> old install's voice. Where this document names them below, that is the design as it was.

## Status: what is built (phase 2a, 2026-11-14)

The parallel work landed as: the vault and admin access in `apps/assistant/src/serve/{Vault,Keys,access}.ts`,
`packages/protocol/src/vault.ts`, `apps/web/src/lib/vault.ts`, `apps/web/src/components/KeysPanel.tsx`; the
`claude-subscription` provider in `apps/assistant/src/subscription.ts` (protocol 2).

**Built: P1, P2, P3, P5** (protocol 3). Phase 2b (below) built P4 and P7 (protocol 4). Not built: P6 (tools, Claude
login), P8 (search), P9.

| Piece | Where | Notes |
|---|---|---|
| P1 shell | `apps/web/src/components/settings/*`, `lib/settingsTree.ts`, `ui/registry.ts` (`settingsPages`), `lib/state.ts` (`ui.settingsOpen/settingsPath/settingsDirty/settingsLeave`) | List + page ≥ 1024 px, drill-down below; deep links; back (button, Esc on a phone, browser back through the hash history); global reload bar naming the pages, "(stops the reply)" while speaking, red on failure; sticky footer with Save / Save and reload / Cancel, lifted above the iOS keyboard with `visualViewport`; "Leave without saving?" for nav, back, close, and `beforeunload`; nav marks (unsaved dot, `!`, padlock, key, Overview dot); module pages; Overview (checklist, engines, voices, problems); This device split into three pages; Diagnostics › Latency and › Problems |
| P2 placement + flat storage | `packages/protocol/src/{settings,snapshot}.ts`, `apps/assistant/src/serve/{sectionDefinitions,sections,SettingsStore,flatten,Vault}.ts`, `Engine.ts` | Sections of §2.1 (table in UI-AND-MODULES §1.7); `SettingsFile`/`SecretsFile`/vault plaintext version 2 (`assistant` by key) with a v1 → v2 migration (owner-wins collision rule, logged without values, `settings.json.v1-backup`); `reloadPendingFor`; `ModuleInfo.kind/group` |
| P3 field semantics | `packages/core/src/Settings.ts` (`visibleWhen`, `source`, `isVisible`, `runSettingsChecks`), `packages/protocol` (`evaluateCondition`, `OptionTag`, `FieldSource`), `apps/web/src/lib/forms.ts`, `fields/ChoiceField.tsx`, `settings/FieldRow.tsx`, `settings/usePageForms.ts` | Draft-driven visibility (also across sections on a page and from other sections' saved values); hidden fields neither sent nor validated (client and server); tags + implication line; warnings with "Save anyway"; Changed · Reset; checks: final > eager silence (error), Deepgram eager < final (error), Claude API / Deepgram / Cartesia standard voice / a Cartesia voice without its key (warnings) |
| P5 keys & access | `settings/pages/AccessPages.tsx` (Edit access & vault = `KeysPanel`; Keys list with "used by"), `ServerPage.tsx` (inline password on every protected page), `SettingsNav.tsx` (padlock, key) | `VaultInfo.lockReason` words the locked view for a restart vs "Lock now" |

**Changed from the design, and why**

- **Language model › Provider holds the Claude API fields and the Claude subscription card** (`visibleWhen` on the
  key and model; the card shows when the draft chooses the subscription), instead of separate "Claude API" and
  "Claude subscription" pages first. The owner wanted provider, opt-in and switch on one page. The card is generic:
  a choice option names the module that serves it (`ChoiceOption.module = { id, optIn }`), and the page shows that
  module's state (off / starting / ready with model and plan / error), its opt-in (part of the page's draft), its
  switch, and **Use …** (save the choice and the opt-in, switch it on, reload the engines). The server's checks are
  unchanged (admin, opt-in). The module keeps its own page under Language model for its other settings.
- **Voices**: no per-voice pages (`voice-<name>`, piece H). `TTS_PROVIDER` and `CARTESIA_API_KEY` share a protected
  "Voice providers" page (the design's "Hosted voice service"; called "Voice engines" until 2026-11-16, docs/VOICE-PROVIDERS.md), so the Voices page itself stays open to every page.
- **`FieldSource`** is `default | saved | env-file | env-process`. No `vault` value: `SecretState` already says it.
  `env-file` vs `env-process` comes from `env.ts` noting which keys `.env` added (no line numbers: P4).
- **Not downloaded**: options carry the `not-downloaded` tag, but there is no `unavailable` + Download action yet
  (P7), so saving a missing preset is still refused with the download command.
- **Warnings** travel as `ErrorInfo.warnings` on an `invalid_settings` refusal (no new error code), and
  `settings.update.confirmWarnings` saves anyway. Only new warnings ask (an unrelated save is not held up by a
  warning that is already there). Module forms have no checks yet.
- **Keys list "used by"** is computed by the client from the forms it already has (no `snapshot.vault.keys`), so
  no protocol change was needed. Admin access and the vault share one page ("Edit access & vault"), because admin
  access is granted by the vault password; there is no separate admin password.
- **Paths use category slugs** (`language-model`, `speech`, `voices`, `modules`, `keys`, `device`, `diagnostics`,
  `about`, `other`); `reloadPendingFor` uses the server's `<group>/<page>` and the UI maps it.
- **Esc on a wide screen closes** (the list is always in view); on a phone it goes up a level. Tablets use the
  drill-down with the page at most 680 px.
- **A category shows a padlock** when any of its pages is protected.
- **Protocol 3**: the additions are optional fields, but a save may be answered with warnings that a v2 page cannot
  confirm, and the section ids changed, so the version was bumped.
- **Not verified**: the sticky footer above the iOS keyboard on a real iPhone (Playwright ran Chromium with mobile
  emulation only, no WebKit).

Leftovers for later pieces are listed in §6.

## Status: extended fields and module routes (modules P3, protocol 10, 2026-11-18)

The five extended field types (`textList`, `records`, `combo`, `action`, `info`; docs/AGENTS-AND-INTENTS.md §4.3) are
members of `SettingField`, so every generated form (module, agent, section) can use them, and the generic renderers
draw them (docs/UI-AND-MODULES.md §1.11, §3.7). Built:

| Piece | Where | Notes |
|---|---|---|
| Protocol | `packages/protocol/src/settings.ts` (the five types, `FieldActionResult`), `client.ts` (`module.action`), `server.ts` (`Result.action`), `moduleRoutes.ts` | Protocol 10: new members of the closed field and value sets; `SettingFieldV2` & co. are aliases |
| Core | `Settings.ts` (`Setting.textList`, `records`, `combo`, `action`, `info`; `isEditableSetting`), `SettingsExtra.ts` | Stored, loaded, resolved per layer (env, saved, an assistant's own values for `overridable` fields); `action`/`info` never saved or patched, left out of `SettingsOf` |
| Host | `ModuleHost.ts` (`fieldAction(id, key, values?)`, the described form's info values, combo options and the agents' Test button) | 8 s (answered at the deadline, cleanup in the background), one press per button at a time, busy until the press has really ended (`FieldActionOwner`: an instance's presses are stopped before it closes); the draft only for `requiresSaved: false`; settings that do not resolve are the result; failures are a generic sentence; secrets reach no page by construction, and everything the module's code writes passes the page boundary's exact safety net (`PageBoundary.ts`, docs/UI-AND-MODULES.md "Secrets and the admin page": every exact occurrence of a current or earlier secret value, any length, replaced by `[secret]` before clipping; earlier values kept while what received them lives; runtime options with a secret value dropped); only a declared action field is a button; presses that do not stop are capped per module; a closed combo shows only its static options |
| Renderers | `fields/TextListField.tsx`, `RecordsField.tsx` (item fields through the same renderers), `ComboField.tsx`, `ActionField.tsx`, `InfoField.tsx`; `lib/forms.ts` (deep equality, buttons and info never in a patch); `settings/FieldRow.tsx` (no Custom/Reset marker on them) | One renderer per type (`ui/fieldRenderers.ts`, a missing one is a compile error). A text item that could not be added, and an item field's invalid text inside a record, are local errors of the form (§3.3): Save waits, the page counts as edited, Cancel clears them (the fields are drawn again from the fresh draft). Records keep a stable identity per row (which one is open, its typed text and its problems move with it); removing a row removes its problems. Only the local errors of fields still in the form and shown count (`PageFormView.localErrors`), and a field row that goes (hidden by `visibleWhen`, gone from a new form) clears its own: an invalid combo that is hidden no longer holds Save. **One rule for the form's state** (review round 3): a button press, a save or a reset acts on exactly what is shown. While any shown field holds what it cannot accept (a local error), Save and every button of the form are refused with that field's error ("Fix this first: Levels: Level 1, Low: …"), and a press with the draft sends only the shown fields' values. "Reset to the default" replaces the field's value and draws that field alone again (`FormState.fieldEpochs`), so its private state (text being typed, a rejected item, a record's rows) and its local error go with it; Save then sends `null` for it. Cancel draws the whole form again |
| Module page | `settings/ModuleRoutes.tsx` | "Web addresses" for any module with routes or tokens, running or not (a stopped module's tokens can be revoked); a token's purpose (its name) is chosen when the routes accept several and shown on each token; `lan` routes are marked unreachable when `SERVE_BEHIND_PROXY` is set |
| Modules | `modules-builtin/src/demoHome.ts` (rooms and lamps as records, Check, Switch everything off, Now), `module-home-assistant` (Test, Connected to, Rooms and lights) | |
| Mock | `apps/web/mock/demoHome.ts` | The demo home with every new type, `module.action`, `/api/module-routes` (as the server: nothing listed or changed while the mock's vault is locked, 503; at most 20 tokens, 409; labels of 1 to 80 characters, 400; back to the seeded tokens on `/mock/reset` and a scenario change) |
| Bounds | `packages/protocol/src/settings.ts` (`MAX_*`, `BoundedChoiceOption`, `RecordsValue`, `TextListValue`) | Every new string, list and record bounded on the wire both ways; the constructors refuse declarations outside them; the host cuts runtime options to 200 and 32 KB; a module's whole form is checked once against the wire schema and an 8 KiB budget (`MODULE_FORM_BUDGET_BYTES`, the complete field array), what the instance adds is trimmed to it ("and N more"); the complete form as it is sent (messages after the page boundary, the generated Test button) with its listed tools is at most 48 KiB (`MODULE_FORM_MAX_BYTES`: a larger save is refused, larger saved settings are invalid and show no form, longer messages are cut); one module's whole projection is at most 256 KiB as one `module.changed` (`MODULE_FRAME_MAX_BYTES`: routes, tools, instance errors, then the form shortened in that order), and the modules of one admin snapshot at most 448 KiB together (`ADMIN_MODULES_SHARE_BYTES`): a module that does not fit is a light entry there (`details: "follow"`, shown as loading) and its complete projection follows at once in its own `module.changed`; defaults are decoded by their own field |

Sections do not declare buttons yet (a section's handler would be the server's: `settings.action` is still not in the
protocol); a button outside a module form is shown disabled.

## Status: the risk policy (modules P8, first version, 2026-11-19)

The household's risk policy (docs/MODULES.md §4) is a household section like Home and Members, on its own page:
**Shared settings › Risk policy**. (This "P8" is the modules plan's, docs/MODULES-PLAN.md §4; not this document's
search phase.)

| Piece | Where | Notes |
|---|---|---|
| Section | `apps/assistant/src/serve/sectionDefinitions.ts` (`riskSection`, id `risk`, group `modules`, page `risk`, order 7, **protected**: admin only) | `RISK_READ`, `RISK_CHANGE`, `RISK_MESSAGE`: a choice of **Run it** / **Refuse: needs confirmation** / **Refuse** (`allow` / `confirm` / `deny`), defaults `allow`, `allow`, `confirm`, applied live (no reload). `RISK_MONEY`, `RISK_SECURITY`: a choice with only Refuse, no environment variable |
| Fixed fields | `sections.ts` (`SectionDefinition.fixed`: key → value and reason) | Shown locked with the reason ("Fixed at Refuse: devices are not authenticated yet …", `FIXED_REASON`), never written; a saved value of a hand-edited file is dropped when the values are read (every reader sees Refuse) and taken out of the file at the section's next save; a save that sets one to anything but Refuse is refused with the reason and writes nothing |
| Validation | `SectionDefinition.checkPatch` = `riskPolicyPatchProblems` (`@pva/protocol`) first, then the fixed check and `applySettingsPatch`; one save, one lock, as every section | An unknown outcome or an opened money/security refuses the whole save (`invalid_settings`, the first problem's message, every problem as a field error), nothing written. A typo in a hand-edited file is that field's error on the page, and the policy reads that class's default meanwhile |
| Reading | `riskPolicy.ts` (`effectiveRiskPolicy`, `servePolicyReader`), `sections.ts` (`riskPolicy()`) | One canonical reader (the section's fields resolved as every reader resolves them, then decoded), published into an in-memory record when the sections are made, with every committed save and on `announceAll`; the gateway reads the record as a field, so a save applies to the next call and the next tool list and no call builds definitions or touches a file. The settings `ConfigProvider` serves the policy's keys as the reader resolves them; the CLI modes read them through the same function once at their start (`modules.ts`) |
| Page | `apps/web/src/lib/settingsTree.ts` (`SHARED_PAGES` "Risk policy"), `ui/adminRegistry.ts` (`risk-extra`), `settings/pages/RiskPolicyPage.tsx` | The generic form (the fixed rows drawn by `FieldRow` as locked values with a padlock and the reason; locked fields are never in a patch), and under it **What the assistant says when it refuses**: for each class the saved outcome and the sentence the person hears, in the household's language (Home › Language: Dutch or English), made with `decodeRiskPolicy`, `decideRisk` and `riskSpoken` from `@pva/protocol`. The form's own labels are English, like every admin page |
| Mock | `apps/web/mock/server.ts` (section `risk`) | The same fields; a save is checked with `riskPolicyPatchProblems` (the real section's function: the same answers, `riskPolicySaveParity.test.ts`) before the generic checks, and money/security are never written. A press (a notification's action, a presentation's tick or button) is decided with the shared decoder, `decideRisk` (class `change`) and the shared spoken refusal; `stop` is never refused |

Not built: a policy per assistant or per device (the plan's later P8), Connections and OAuth.

## Status: phase 2b (P4 and P7, 2026-11-14)

**Built: P4 and P7** (protocol 4). Still not built: P6 (tools, Claude login: the jobs model is ready for it), P8, P9.

| Piece | Where | Notes |
|---|---|---|
| P4 env view | `apps/assistant/src/envView.ts`, `env.ts` | Values from `util.parseEnv`, lines from a scan (comments, `export`, quoted multi-line values); process variables win over files, an earlier file over a later one; `release` / `restore` / `redact` (`PVA_VAULT_PASSWORD` once read); a live record that sections and the module host read |
| P4 lock origins | core `Settings.ts` (`envLocation`), protocol `locked.file/line` | "Set by X in /…/.env, line 3" |
| P4 env list + move | `serve/envSettings.ts`, protocol `env.ts`, `settings.moveFromEnv`, `env` | Kinds `setting` / `bootstrap` / `development` / `unknown`; engine keys without a field (`STT_SHERPA_THREADS`, `TTS_SHERPA_*`, `CARTESIA_*`, `VOICE_<NAME>_*`, …) move too, saved by key; `commentOutKeys` (backup 0600, temp file + rename, mode kept, CRLF kept) |
| P4 CLI | `apps/assistant/src/cliSettings.ts`, `main.ts`, `modules.ts` | `makeSections(store, env).configProvider()` for every CLI mode; vault by `PVA_VAULT_PASSWORD` or a no-echo prompt on a TTY (Enter skips); "X is not set" gets "the key vault is locked" appended |
| P4 fixes | `llm-anthropic` (`baseURL` from `ANTHROPIC_BASE_URL`, always passed), `decide-typesafe` (`enabledWhenSet: "apiKey"`), core `ModuleHost` (`enabledWhenSet`, re-checked in `setSecrets`), `tts-sherpa/scripts` (model dir passed in) | New Language model fields `ANTHROPIC_BASE_URL`, `ANTHROPIC_WARM_UP` (advanced) |
| P4 UI | `settings/pages/OverridesPage.tsx` (Diagnostics › Settings from outside), `FieldRow.tsx` (Move to settings on a `.env` lock), `lib/setupChecklist.ts` | Overview item "N settings are still in .env" |
| P4 docs | `.env.example` (§1.7), README Configuration | |
| P7 downloader | `packages/core/src/download.ts` (`@pva/core/download`) | statfs check (download + unpacked + 50 MB), `.downloads/<name>.part`, stall 60 s, Content-Length check, `nice -n 10 tar -xjf -` fed from the archive (unpack progress = bytes read), `.unpack-<id>/`, expected files, move into place; cancel/failure clean up; `cleanPartials` at serve start |
| P7 presets | `stt-sherpa/src/{presets,download}.ts`, `tts-sherpa/src/{Presets,download}.ts` | `sizeMb`/`diskMb` per archive (Content-Length of the releases and `du` of full unpacks, 2026-11-14), `downloadPreset`, `deletePreset`, `isInstalled`; both scripts are `main(argv, deps)` wrappers |
| P7 server | `serve/jobs.ts`, `serve/models.ts`, `SessionHub` (`job.start`, `job.cancel`, `model.delete`, admin only), protocol `jobs.ts` | One job per tool+target, two at once, updates throttled to 4/s, last 10 finished kept; targets only from the tables; delete refuses a model in use (from the running engines, including a hybrid's parts) or shared with another installed preset |
| P7 UI | `settings/DownloadControl.tsx`, `settings/pages/ModelsPages.tsx` (Speech recognition › Models, Voices › Models), `FieldRow.tsx` | Inline Download under a chosen `not-downloaded` option (recogniser, local voices); Save waits until it is there |

**Changed from the design, and why**

- **The Overrides page is Diagnostics › Settings from outside**, not Keys & access (the task placed it in
  Diagnostics). The env list is **sent to every page** (names, origins, file and line; never values), not admin only:
  the same facts were already on every field's lock. Moving is admin only.
- **The server sends the env list** (`snapshot.env`), instead of the client deriving it from locked fields: it also
  covers engine keys without a field, bootstrap and development variables, and unknown ones (typos).
- **Engine keys without a field** can be moved; they are saved by key and read by the providers, but no page edits
  them yet (they show on Diagnostics only while still in `.env`). Removing one again means editing `settings.json`.
- **A moved value does not mark a reload**: it is the value the engines already run with.
- **Jobs**: `ToolId` is `stt-models` | `tts-models` only (P6 adds its tools, a protocol change); `job` and `models`
  go to every page (progress is not secret); only admin pages may start, cancel or delete. Delete is a request
  (`model.delete`), not a job. No `ToolInfo` yet: the Models pages use `ModelSet`.
- **"Unavailable + Download"** is `ChoiceOption.download` plus the existing `not-downloaded` tag (no
  `unavailable` object). The server still refuses saving a missing recogniser (now "… is not downloaded yet: download
  it first (565 MB)"), as a backstop for a page that skipped the inline Download.
- **Downloads are not paused during a turn** (§5.4's fallback): the measurement below shows no effect worth it.
- **CLI keeps the vault unlocked for the process's life** (the old code locked it right after copying the keys), so
  modules and providers read the same store.
- **TypeSafe Jev** is not in the module catalog yet; the fix is in the decider and the host, tested with the host.

**Direct environment reads left (§1, §4.4)**, after this phase (`grep process.env` over `apps/*/src`, `packages/*/src`):

| Read | Status |
|---|---|
| `decide-typesafe` `enabledByDefault` from `process.env.TYPESAFE_API_KEY` | **fixed**: `enabledWhenSet`, judged by the module host on env + vault |
| `@anthropic-ai/sdk` reading `ANTHROPIC_BASE_URL` itself | **fixed**: `config.baseURL`, always passed |
| `tts-sherpa/scripts/download-models.ts` `TTS_SHERPA_MODEL_DIR` | **fixed**: `main(argv, { env })`, the library takes `modelDir` |
| Module host and sections given raw `process.env` | **fixed**: the env view's live record (serve); the CLI passes its process environment, which is what the CLI reads |
| `env.ts` `INIT_CWD` | stays: set by pnpm, where relative paths resolve; not configuration |
| `serveMode.ts` / `cliSettings.ts` `PVA_VAULT_PASSWORD`, `Vault.ts` `defaultVaultPath(env)` | stay: bootstrap (read before the settings, and the password is removed from `process.env` and the view once read) |
| `agent-claude-code` passing `process.env` to Claude Code | stays: the subprocess environment, filtered to an allowlist; not a setting |
| web `NEXT_PUBLIC_PVA_WS_URL`, `NODE_ENV` | stay: build time |

**Latency** (§5.4, measured with `TurnTrace` by `bench --live`, no hosted model):

Run on the development machine (16 cores) on 2026-11-14: `bench --live --rounds 6` over two test clips
(`models/test-wavs/0.wav`, short; `1.wav`, a long sentence), local Parakeet v2 + Piper, the offline stand-in with
`BENCH_LLM_FIRST_TOKEN_MS=250`, 12 turns each. "During unpack": the real downloader (`downloadArchives`) looping on a
564 MB Whisper archive served from a local HTTP server (download 0.7 s, then `nice -n 10 tar -xjf` for 32 s per round,
so the unpack ran through every turn). Milliseconds from the end of the clip's audio:

| Turns | eager (median) | tts audio − 1st clause (typical) | PLAY median, short clip | PLAY median, long clip | PLAY median / worst, all 12 |
|---|---|---|---|---|---|
| Idle | 27 | 23–31 | 321 | 1269 | **790 / 1442** |
| During unpack | 61 | 23–55 | 353 | 1250 | **812 / 1414** |

Reading: an unpack adds about 30 ms to a short turn (the recogniser's eager decision and the first audio are a little
later) and nothing measurable to a long one (within run-to-run noise); the worst case did not get worse. Not worth
pausing unpacking during a turn, so it is not done. The download phase itself was not measured on its own (locally it
lasts under a second; from GitHub it lasts longer but is network-bound, not CPU-bound). Not run: a download on a
machine with few cores, where the niced bzip2 process competes for the same core as the decoder.

**Not verified / known gaps**: a real download from GitHub through the UI (the downloader ran against a local HTTP
server with real archives; the release URLs and sizes were checked with HEAD requests); the TTY password prompt by
hand (unit-tested with an injected prompt); `ENOSPC` mid-download (only the statfs check is tested).

---

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Where settings live | Everything except four bootstrap variables moves into the UI. `.env` keeps only `PVA_VAULT_PASSWORD` (optional), `PVA_DATA_DIR`, `SERVE_HOST`, `SERVE_PORT`, and the TLS pair when used (§1.4). |
| Screen | A settings screen with a category list on the left and the page on the right (≥ 1024 px); a drill-down list with a back button on phones (< 640 px) and tablets. Replaces the 420 px tabbed drawer. |
| Tree | 9 level-1 categories, each with level-2 pages. Server data places every section and module (`group` + `page`), so modules and agents from the catalog appear without UI changes. |
| Storage | Assistant settings stored **flat by key** (keys are already globally unique env names), so sections become presentation only and can be regrouped without migrations. |
| Dependent fields | `visibleWhen` on fields, evaluated against the *draft*, so choosing "Deepgram" shows its fields before saving. Choice options carry `tags` (hosted, needs key, not downloaded) and an implication line. |
| Values set outside the UI | Shown with where they come from (`.env` at a path, or the process environment). For `.env` entries, **Move to settings** stores the value (secrets go to the vault) and comments the line out. |
| CLI modes | `voice`, `text`, `say`, `bench`, `transcribe` read the saved settings (and the vault) too. Today they read only modules' saved settings, so a smaller `.env` would break them. |
| Installers | One allowlist of known tools on the server, with fixed argv, no shell, admin only. Long-running work is a **job** with progress and a log tail streamed over the socket. |
| Claude Code | Already bundled: the Agent SDK ships the binary (`@anthropic-ai/claude-agent-sdk-linux-x64`, Claude Code 2.1.323 **[run]**). So "install" is rarely needed and **login is the real task**: `claude auth login` driven from the UI, finished on Anthropic's own page. `claude setup-token` is excluded, because it would mean storing a session token (§5.2). |
| Speech models | Downloaded from the UI through the same preset tables the download scripts use, with byte progress, cancel and a disk-space check. Picking a model that isn't downloaded offers **Download** inline instead of failing on save. |
| Latency | Nothing here touches the turn path. Two side effects are covered: decompressing models while a conversation runs (run `tar` under `nice` and measure with `TurnTrace`, §5.4) and engine reloads (unchanged). |

---

## 1. Inventory of every environment variable

Method: grep of `Config.*(` (every constructor, including template-literal names), `env: "…"` in `Setting.*`
declarations, `process.env` and `env[` across `apps/` and `packages/` (excluding tests and `baseline.tmp`), plus implicit
reads by SDKs. Columns: **UI today** = there is a field for it in `sections.ts` or a module's settings. **Verdict**: *UI*
= move into the settings screen; *bootstrap* = stays in `.env`; *dev* = development, benchmark or CLI only (env only,
not in the UI unless stated); *drop* = remove.

### 1.1 Provider selection and conversation

| Variable | What it does | Default | Read by | UI today | Verdict / where |
|---|---|---|---|---|---|
| `LLM_PROVIDER` | Language model: `fake` \| `anthropic` (+ `claude-subscription` landing now) | `fake` | `providers.ts:85` (via `choose`), `serve/Engine.ts:81`, `voice.ts:38`, `main.ts:118` | yes (`language-model`) | **UI** → Language model › Provider. Later replaced by `DEFAULT_AGENT` (AGENTS-AND-INTENTS §4.4); keep as a legacy alias |
| `STT_PROVIDER` | Recogniser: `sherpa` (local) \| `deepgram` | `sherpa` | `providers.ts:88`, `Engine.ts:82,135`, `sections.ts:251` | yes (`speech`) | **UI** → Speech recognition › Engine |
| `TTS_PROVIDER` | Engine for voices that don't name one | `sherpa` | `providers.ts:94`, `voices.ts:107`, `sections.ts:258` | yes (`speech`) | **UI** → Voices › standard voice › Engine (written as `VOICE_STANDARD_PROVIDER`; `TTS_PROVIDER` stays the fallback) |
| `AUDIO_BACKEND` | CLI audio: `pipewire` \| `file` | `pipewire` | `providers.ts:99,104`, `voice.ts:39` | no | **dev** (serve uses the browser; CLI voice mode only) |
| `SYSTEM_PROMPT` | Base system prompt | `defaultSystemPrompt` (`config.ts:3`) | `config.ts:11`, `sections.ts:186`, `serveMode.ts` setup | yes | **UI** → Language model › Behaviour |
| `MAX_TOOL_ROUNDS` | Tool rounds per turn | 5 | `config.ts:12`, `sections.ts:194` | yes (advanced, reload) | **UI** → Language model › Behaviour (advanced) |
| `BARGE_IN` | CLI: stop talking on user speech | true | `config.ts:13` | no | **dev** (serve always barges in; the per-device interrupt mode decides) |

### 1.2 Language model providers

| Variable | What | Default | Read by | UI today | Verdict / where |
|---|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | API key | — (required) | `llm-anthropic/src/index.ts:321`, `sections.ts:244`; stripped from the Claude harness env (`agent-claude-code/src/options.ts:24`) | yes (secret) | **UI**, vault → Language model › Claude API |
| `ANTHROPIC_MODEL` | Model id | `claude-haiku-5-5` | `index.ts:322`, `Engine.ts:87`, `sections.ts:243` | yes (text) | **UI** (choice + custom later: `combo`) |
| `ANTHROPIC_MAX_TOKENS` | Reply cap | 1024 | `index.ts:323` | no | **UI**, advanced |
| `ANTHROPIC_EFFORT` | `low`\|`medium`\|`high` | `low` | `index.ts:324` | no | **UI**, advanced (implication text: "higher = slower first word") |
| `ANTHROPIC_THINKING` | `disabled`\|`adaptive` | `disabled` | `index.ts:327` | no | **UI**, advanced (warn: adds latency) |
| `ANTHROPIC_TIMEOUT_MS` | No-event timeout | 5000 | `index.ts:330` | no | **UI**, advanced |
| `ANTHROPIC_WARM_UP` | Open the HTTPS connection at startup | true | `index.ts:331` | no | **UI**, advanced |
| `ANTHROPIC_BASE_URL` | API endpoint | SDK default | **implicit**: `@anthropic-ai/sdk` reads `process.env` itself (`index.ts:19`, no `Config` read) | no | **UI**, advanced, **after a fix**: add `baseUrl: Config.option(Config.String("ANTHROPIC_BASE_URL"))` to `AnthropicLlm.config` and always pass `baseURL`, so a UI value reaches the SDK and a stray shell export can't bypass the settings |
| `CLAUDE_SUBSCRIPTION_OPT_IN`, `CLAUDE_SUBSCRIPTION_MODEL` | Opt-in switch; model | false; `claude-haiku-5-5` | `agent-claude-code/src/agent.ts:346,353` (module settings) | as module settings once in the catalog | **UI** → Language model › Claude subscription (with the login card, §5.2) |
| `OPENROUTER_*`, `HOME_MODEL_*` (`API_KEY`, `MODEL`, `MAX_TOKENS`, `TEMPERATURE`, `REASONING_EFFORT`, `TIMEOUT_MS`, `SORT_BY_LATENCY`, `BASE_URL`, `SERVER`) | OpenAI-compatible agents (prefix per profile) | per profile | `llm-openai-compatible/src/agent.ts:74–170` (module settings) | not in the catalog yet | **UI** → Language model › one page per agent |
| `TYPESAFE_API_KEY`, `_MODEL`, `_BASE_URL`, `_TIMEOUT_MS` | Jev decision provider | — | `decide-typesafe/src/decider.ts:43–65`; **also** `enabledByDefault` reads `process.env.TYPESAFE_API_KEY` directly (`decider.ts:33`) | not in the catalog yet | **UI**; change `enabledByDefault` to "key present in the vault or env" (pass a lookup instead of raw `process.env`) |
| `JEV_DECIDER` | Which decider Jev prefers | — | `agent-intent/src/jev.ts:25` | not in the catalog yet | **UI** → Language model › Jev |
| `BENCH_LLM_FIRST_TOKEN_MS`, `BENCH_LLM_TOKENS_PER_S` | Simulated speed of the offline stand-in (also in serve when set) | unset (untimed); 60 | `providers.ts:24,26`, `main.ts:70–71` | no | **dev**; optionally under Language model › Offline stand-in › Advanced ("Simulate a hosted model") |

### 1.3 Speech recognition

| Variable | What | Default | Read by | UI today | Verdict / where |
|---|---|---|---|---|---|
| `STT_SHERPA_MODEL` | Preset | `parakeet-v2` | `stt-sherpa/src/SherpaStt.ts:320`, `Engine.ts:95`, `sections.ts:109` | yes | **UI** → Speech recognition › Engine (+ inline download) |
| `STT_SHERPA_LANGUAGE` | Whisper/Nemotron language | `auto` | `SherpaStt.ts:330`, `sections.ts:120` | yes | **UI** → Engine; `visibleWhen` model ∈ {whisper, nemotron} |
| `STT_SHERPA_EAGER_SILENCE_MS` | Pause before the speculative reply | 250 | `SherpaStt.ts:331`, `sections.ts:130` | yes | **UI** → Turn timing |
| `STT_SHERPA_FINAL_SILENCE_MS` | Pause that ends the turn | 600 | `SherpaStt.ts:332`, `sections.ts:136` | yes | **UI** → Turn timing; cross-check: must be > eager |
| `STT_SHERPA_MIN_SPEECH_MS` | Shortest speech | 100 | `SherpaStt.ts:333`, `sections.ts:175` | yes (adv.) | **UI** → Turn timing (advanced) |
| `STT_SHERPA_VAD_THRESHOLD` | Silero threshold | 0.5 | `SherpaStt.ts:334`, `sections.ts:150` | yes | **UI** → Microphone processing |
| `STT_SHERPA_AGC`, `STT_SHERPA_AGC_MAX_GAIN_DB` | Server gain control | true, 30 | `SherpaStt.ts:335–336`, `sections.ts:141,163` | yes | **UI** → Microphone processing |
| `STT_SHERPA_THREADS` | Decoder threads | preset's | `SherpaStt.ts:329` | no | **UI**, advanced → Engine |
| `STT_SHERPA_MODEL_DIR` | Model folder | `<repo>/models` | `SherpaStt.ts:328`, `sections.ts:294` | no | **UI**, read-only info on the Speech models page; editable under Diagnostics › Advanced with apply = reload (it's a path on the server, so admin only). Keep env as an override |
| `DEEPGRAM_API_KEY` | Key | — | `stt-deepgram/src/index.ts:95` | no | **UI**, vault → Speech recognition › Deepgram |
| `DEEPGRAM_MODEL` | Model | `flux-general-en` | `index.ts:96`, `Engine.ts:94` | no | **UI** → Deepgram |
| `DEEPGRAM_EOT_THRESHOLD`, `DEEPGRAM_EAGER_EOT_THRESHOLD` | Turn confidence | 0.7, 0.5 | `index.ts:97–98`, `sections.ts:86,96` | yes (when deepgram) | **UI** → Deepgram (merge the current provider-switched `listening` section into `visibleWhen`) |
| `DEEPGRAM_EOT_TIMEOUT_MS` | Silence cap | 5000 | `index.ts:99` | no | **UI**, advanced |
| `DEEPGRAM_URL` | Endpoint | `wss://api.deepgram.com/v2/listen` | `index.ts:100` | no | **dev** (tests point it at a mock) |

### 1.4 Voices and speech synthesis

| Variable | What | Default | Read by | UI today | Verdict / where |
|---|---|---|---|---|---|
| `VOICES` | Enabled voices | `""` → default voice only | `voices.ts:85`, `sections.ts:218` | yes | **UI** → Voices › Overview |
| `DEFAULT_VOICE` | Default voice | first in catalog | `voices.ts:86`, `sections.ts:211`, `serveMode.ts:241` | yes | **UI** → Voices › Overview |
| `VOICE_<NAME>_PROVIDER` | Engine of one voice | declared provider, else `TTS_PROVIDER` | `voices.ts:102` | no | **UI** → Voices › <name> › Engine |
| `VOICE_<NAME>_<KEY>` for any provider key | Per-voice override; lookup order `VOICE_<NAME>_<KEY>` → the voice's declared `settings` → `<KEY>` (`voices.ts:115–120`) | — | the `ConfigProvider` wrapper, so every adapter key below | no | **UI** → Voices › <name>: fields keyed by the prefixed name (AGENTS-AND-INTENTS §4.4 table). The prefix scheme stays the storage format, so adapters need no change |
| `TTS_SHERPA_PRESET` | Piper/Kokoro preset | `en_US-lessac-medium` (`tts-sherpa/src/Presets.ts:67`) | `tts-sherpa/src/index.ts:83`, `Engine.ts:103` | no (unprefixed) | **UI** only as the per-voice field; the unprefixed key stops being set from the UI |
| `TTS_SHERPA_SPEED`, `_TRIM_SILENCE`, `_CLAUSE_PAUSE_MS`, `_SENTENCE_PAUSE_MS` | Delivery | 1, true, 150, 300 | `index.ts:86–89` | no | **UI** per voice |
| `TTS_SHERPA_PAD_MS`, `_CHUNK_MS`, `_THREADS` | Tuning | 20, 40, preset's | `index.ts:85,90,91` | no | **UI** per voice, advanced |
| `TTS_SHERPA_MODEL_DIR` | Model folder | `<repo>/models` | `index.ts:84`; **also** `tts-sherpa/scripts/download-models.ts:11` via `process.env` | no | as `STT_SHERPA_MODEL_DIR` (one "Models folder" setting for both) |
| `CARTESIA_API_KEY` | Key | — | `tts-cartesia/src/index.ts:385` | no | **UI**, vault → Voices › Hosted voice service |
| `CARTESIA_MODEL`, `_VOICE`, `_LANGUAGE` | Model, voice id, language | `sonic-3.6`, `db6b0ed5-…` ("Skylar"), unset (`_LANGUAGE` overrides; unset = the voice's own language, else `en`) | `index.ts:386–388`, `Engine.ts:104` | no | **UI** per voice |
| `CARTESIA_MAX_BUFFER_DELAY_MS` | Server-side buffering | 0 | `index.ts:390` | no | **UI** per voice, advanced |
| `CARTESIA_SAMPLE_RATE` | Output Hz | 24000 | `index.ts:389` | no | **drop from the UI** (the router resamples, nothing to gain); env stays for tests |
| `CARTESIA_URL` | Endpoint | `wss://api.cartesia.ai` | `index.ts:391` | no | **dev** |
| `ELEVENLABS_API_KEY` | Key | — | `tts-elevenlabs/src/index.ts` (`config`) | no | **UI**, vault → Voices › Voice providers (added 2026-11-16) |
| `ELEVENLABS_VOICE`, `_MODEL`, `_LANGUAGE`, `_SPEED`, `_STABILITY`, `_AUTO_MODE` | Voice id, model, language, voice settings | `EXAVITQu4vr4xnSDxMaL`, `eleven_flash_v2_5`, unset, unset, unset, true | `tts-elevenlabs/src/index.ts` (`config`) | no | engine keys (move from `.env`, saved by key); per voice with `VOICE_<NAME>_` |
| `ELEVENLABS_SAMPLE_RATE`, `ELEVENLABS_URL` | Output Hz, endpoint | 24000, `wss://api.elevenlabs.io` | `tts-elevenlabs/src/index.ts` (`config`) | no | **dev** |

### 1.5 Modules

| Variable | What | Default | Read by | UI today | Verdict |
|---|---|---|---|---|---|
| `CLOCK_TIME_ZONE` | IANA zone | Home's time zone (WP-12a), else the machine's | `modules-builtin/src/clock.ts` | yes | **UI** → Modules › Clock |
| `WEATHER_DEFAULT_PLACE`, `WEATHER_UNITS` | Place, units | Home's location and units (WP-12a) | `weather.ts` | yes | **UI** → Modules › Weather |
| `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN` | HA address, token | — | `module-home-assistant/src/module.ts:43,51` | in the catalog since WP-12c | **UI**, token in the vault → Modules › Home Assistant |
| `HOME_LOCATION`, `HOME_TIME_ZONE`, `HOME_LANGUAGE`, `HOME_UNITS`, `HOME_DATE_FORMAT`, `HOME_CURRENCY`, `HOME_CUP_SIZE`, `HOME_API_CONTACT` | Home (docs/ASSISTANTS.md §2.4) | —, the machine's, `en-GB`, `metric`, `en-GB`, `EUR`, `metric`, — | section `home` (`sectionDefinitions.ts`); the prompts' Home line and the modules' linked defaults | yes (WP-12a) | **UI** → Shared settings › Home |
| `HOUSEHOLD_DIET_ALLERGIES`, `HOUSEHOLD_DIET_DIETS`, `HOUSEHOLD_DIET_DISLIKES` | Members: the household's diet (protocol 11, P5) | none | section `members` (`serve/people.ts`); the `People` service | yes | **UI** → Shared settings › Members |
| `HOUSEHOLD_MEMBERS` | Members: the people. **Not read from the environment**: people get ids the server makes and keeps, which an environment variable cannot hold. The environment view lists it under "Not read" with that reason (`EnvEntry.refused`), and the start logs a warning | none | section `members`, saved values only | no | **UI** → Shared settings › Members; remove the variable |
| `RECORD_HEARD_AUDIO`, `RECORD_HEARD_AUDIO_MAX_FILES` | Save what the recogniser heard | false, 50 | read only through `sections.value` (`serveMode.ts:163–164`); env only as a lock | yes | **UI** → Diagnostics › Recordings |

### 1.6 Serve mode, paths and bootstrap

| Variable | What | Default | Read by | UI today | Verdict |
|---|---|---|---|---|---|
| `PVA_DATA_DIR` | Where `settings.json` (and the vault) live | `<repo>/data` | `serve/SettingsStore.ts:37`, `modules.ts` (CLI) | no | **bootstrap**: it's the location of the settings themselves. Shown read-only under Keys & access › Server |
| `PVA_VAULT_PASSWORD` (new) | Unattended vault unlock | unset (unlock in the UI) | vault (parallel work) | — | **bootstrap**, optional. Without it, the vault is unlocked from the UI after each restart, and until then key-needing engines report "Vault locked" |
| `SERVE_HOST` | Bind address | `127.0.0.1` | `serveMode.ts:288` | no | **bootstrap**: if the page could change its own exposure, it could lock itself out or open itself to the network. Shown read-only with the exposure warning |
| `SERVE_PORT` | Port | 8787 | `serveMode.ts:289` | no | **bootstrap** (changing it from the page drops the page's own connection). Read-only display |
| `SERVE_TLS_CERT`, `SERVE_TLS_KEY` | HTTPS for the microphone off-localhost | unset | `serveMode.ts:294–295` | no | **bootstrap** for now (applies at restart). Could move to settings later with "applies at restart" and a revert timer; not worth it yet. Read-only display ("HTTPS on: cert …") |
| `SERVE_ALLOWED_ORIGINS` | Extra WebSocket origins (the Next dev server) | `http://localhost:3000,http://127.0.0.1:3000` | `serveMode.ts:290` | no | **dev** |
| `PVA_WEB_DIR` | Built UI folder | `<repo>/apps/web/out` | `serveMode.ts:296` | no | **dev**/packaging |
| `INIT_CWD` | Set by pnpm; where relative paths resolve | `process.cwd()` | `env.ts:25` | — | internal, not configuration |
| `AUDIO_INPUT_FILE`, `AUDIO_INPUT_TRAILING_SILENCE_MS`, `AUDIO_OUTPUT_DIR` | File audio backend | —, 3000, `audio-out` | `providers.ts:68–73`, `transcribe.ts:28` | no | **dev** (CLI) |
| `PIPEWIRE_CAPTURE_TARGET`, `_PLAYBACK_TARGET`, `_CAPTURE_LATENCY_MS`, `_PLAYBACK_LATENCY_MS` | PipeWire nodes, latency | default, default, 20, 20 | `audio-pipewire/src/PipeWire.ts:176–179` | no | **dev** (CLI voice mode) |
| `BENCH_ROUNDS`, `BENCH_TTS_FIRST_AUDIO_MS`, `BENCH_EAGER_LEAD_MS`, `BENCH_PLAYBACK_MS_PER_CLAUSE`, `BENCH_OUTPUT_DIR` | Benchmarks | 3, 150, 200, 200, `bench-out` | `main.ts:72–100` | no | **dev** |
| `NEXT_PUBLIC_PVA_WS_URL`, `NODE_ENV` | Web build: socket URL, dev port guess | unset | `apps/web/src/lib/connection.ts:378,381` | no | **dev** (build time) |
| `MOCK_PORT`, `MOCK_HOST`, `MOCK_SCENARIO`, `MOCK_QUIET` | Web mock server | 8787, 127.0.0.1, `voice`, — | `apps/web/mock/server.ts:46–56` | no | **dev** |
| `SCREENSHOT_DIR`, `RUNS`, `CLAUDE_SUBSCRIPTION_LIVE` | Screenshots, TTS measure runs, live test opt-in | — | `apps/web/e2e/screenshots.shots.ts:10`, `tts-sherpa/scripts/measure.ts:14`, agent live test | no | **dev**/test |
| *(passthrough)* full `process.env` | Handed to the Claude Code process (minus `STRIPPED_ENV`) and to the module host for field locks | — | `agent-claude-code/src/agent.ts:78`, `serveMode.ts:76`, `modules.ts:36` | — | Keep, but the module host gets the same **env view** as sections (§4.4) so "Move to settings" also unlocks module fields. `CLAUDE_CONFIG_DIR` in that env decides where the Claude login lives (default `~/.claude`) |

### 1.7 Resulting `.env.example` (all lines commented out, because the defaults are right for most setups)

```sh
# Everything else is set in the web UI (Options). These are read before the UI exists.
# PVA_VAULT_PASSWORD=        # unlock the key vault at startup; without it, unlock it in the UI after each restart
# PVA_DATA_DIR=              # settings and vault; default <repo>/data
# SERVE_HOST=127.0.0.1       # anything else exposes the assistant to your network
# SERVE_PORT=8787
# SERVE_TLS_CERT=            # both set: HTTPS (needed for the microphone off localhost)
# SERVE_TLS_KEY=
```

The developer and benchmark variables move to a short "Development variables" table in the README (they're still
read; they just aren't in the owner's file).

---

## 2. Information architecture

### 2.1 Category tree

Level 1 (left list) → level 2 (pages) → fields. **(dyn)** = generated from server data; **(cond)** = shown when a
condition holds; 🔒 = protected (admin only, assumed from the parallel work).

```
1  Overview                         status + setup checklist (no fields)
   └ (single page)                  "Language model: offline stand-in → choose one", "Speech model: downloaded",
                                    "Vault: locked → unlock", engine problems, reload-pending, Start hint

2  Language model 🔒                group "agents"
   ├ Provider                       LLM_PROVIDER (choice with tags) — later DEFAULT_AGENT + Routing page
   ├ Behaviour                      SYSTEM_PROMPT, MAX_TOOL_ROUNDS (adv.)
   ├ Claude API            (dyn)    ANTHROPIC_API_KEY, _MODEL, Advanced: _MAX_TOKENS _EFFORT _THINKING _TIMEOUT_MS _WARM_UP _BASE_URL
   ├ Claude subscription   (dyn)    tool card (Claude Code: version, login, Log in) + module form (opt-in, model, …)
   ├ Offline stand-in      (dyn)    Advanced: simulated speed (BENCH_LLM_*), optional
   ├ OpenRouter / Home model / Codex / Jev   (dyn, when in the catalog)
   └ Decision providers    (dyn)    one sub-page per kind:"decider" module

3  Speech recognition 🔒            group "speech"
   ├ Engine                         STT_PROVIDER; (cond sherpa) STT_SHERPA_MODEL [+Download], _LANGUAGE (cond), _THREADS (adv.)
   ├ Turn timing           (cond sherpa)   _EAGER_SILENCE_MS, _FINAL_SILENCE_MS, _MIN_SPEECH_MS (adv.)
   ├ Microphone processing (cond sherpa)   _VAD_THRESHOLD, _AGC, _AGC_MAX_GAIN_DB (adv.)
   ├ Deepgram              (cond deepgram, or "Set up" when not selected)  key, model, thresholds, timeout (adv.)
   └ Speech models                  downloads manager: presets, size, installed/missing, Download/Delete, folder (read-only)

4  Voices 🔒                        group "voices"
   ├ Overview                       DEFAULT_VOICE, VOICES, running engines list (read-only)
   ├ standard / natural / expressive (dyn, one per voiceCatalog entry)   engine, preset or Cartesia voice, speed, pauses,
   │                                Advanced; [Play a sample]
   ├ Hosted voice service           CARTESIA_API_KEY
   └ Voice models                   TTS preset downloads (same component as Speech models)

5  Modules                          kind "capability" (dyn: one page per module, catalog order)
   ├ Clock / Weather / Home Assistant 🔒 (has a secret) / Demo home …
   └ (each page: enable switch, status, settings form, tools/actions list)

6  Keys & access                    group "access" (always visible; its contents are partly protected)
   ├ Admin access                   this connection: admin or not, [Unlock admin] / [Sign out]
   ├ Key vault 🔒                   state (locked/unlocked/absent), unlock, change password, keys list (name, used by, set/not set)
   ├ Settings from outside 🔒       every field set by .env or the process environment, with source and [Move to settings]
   └ Server                         read-only: address, port, HTTPS, exposure warning, data folder, assistant version

7  This device                      browser localStorage (not server settings; not protected)
   ├ Microphone & speaker           device choice, Interrupting (3-way), echo test
   ├ Audio processing               echo cancellation, noise suppression, auto gain
   └ Display                        captions, latency readout, Advanced: output path, prebuffer

8  Diagnostics                      group "diagnostics"
   ├ Recordings 🔒                  RECORD_HEARD_AUDIO, _MAX_FILES (adv.); later: list + download of recent recordings
   ├ Latency                        last 20 TurnTrace rows (existing LatencyReadout data), median/worst
   ├ Software 🔒                    every allowlisted tool: Claude Code, Codex, speech models (status, version, actions, last job log)
   └ Engine problems                EngineStatus.problems, module errors, store problems (corrupt settings set aside)

9  About                            version, protocol, connection id, keyboard shortcuts
```

Why this cut:
- **One question per level-1 entry**: what answers me (2), how it hears me (3), how it sounds (4), what it can do (5),
  who may change things and where the keys are (6), this phone or laptop (7), why it misbehaves (8).
- **Speech recognition and Voices stay separate** although both are "speech": they have different reload costs,
  different hosted alternatives and different download sets, and the owner asked for them separately.
- **Keys appear twice, intentionally**: each provider page has its own key field (that's where you need it), and Keys &
  access › Key vault lists all keys with "used by" (that's where you audit them). Both edit the same vault entry.
- **Overview** exists because a first-run owner with an empty `.env` needs to be told what's missing; it replaces the
  `.env` tutorial the owner doesn't want.

### 2.2 How dynamic content fits

Placement is data the server sends. The UI hard-codes only the nine categories and their order.

| Thing | Category from | Page from | Order |
|---|---|---|---|
| Settings section | `SettingsSection.group` (closed set: `agents`, `speech`, `voices`, `modules`, `access`, `diagnostics`, `general`; Overview, This device and About are client-only) | `SettingsSection.page` (id + title); sections sharing a `page` render stacked on one page | `order` (number), then server order |
| Module | `ModuleInfo.kind`: `agent` → Language model, `decider` → Language model › Decision providers, `capability`/absent → Modules | one page per module, id = module id | catalog order |
| Voice | sections `voice-<name>` with `group: "voices"`, `page: "voice-<name>"` (generated from `voiceCatalog`) | | catalog order |
| Tool card (installer) | `ToolInfo.placement`: list of `{ group, page }` where the card is embedded (Claude Code → Language model › Claude subscription **and** Diagnostics › Software) | | |
| Client-only pages | Overview, This device, Diagnostics › Latency, About: UI registry entries (`ui/registry.ts` grows a `settingsPages` list, the same "one file plus one line" rule) | | |

Unknown `group` values (a newer server) fall back to `general`, a category that's shown only when non-empty. That
matches the existing rule in AGENTS-AND-INTENTS §4.2.

**Provider-dependent pages and fields**: a page can carry `visibleWhen` (Deepgram page: `STT_PROVIDER = deepgram`). A
hidden page still appears in the list as a muted "Set up Deepgram" row under "Not in use", so a key can be entered
*before* switching, which is what "dependent fields" should allow. Fields use the same `visibleWhen` (§4.2). Today
`sections.ts:82` rebuilds the whole `listening` section per provider and announces two sections on change
(`sections.ts:358`). With `visibleWhen`, the full spec is always sent and the client decides, so that special case goes
away.

---

## 3. Layout and interaction

### 3.1 Shell

The settings become a **full-screen layer** (`role="dialog"`, `aria-modal`) opened from the existing gear button. The
right drawer is too narrow for two panes. Breakpoints follow UI-AND-MODULES §3.10.

**Desktop (≥ 1024 px): list + page**

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ SETTINGS                                   [ Search settings…            ⌘K ]          [ × ] │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▌Saved changes need an engine reload (Speech recognition › Engine).        [ Reload now ]    │  ← global, only while reloadPending
├────────────────────────┬─────────────────────────────────────────────────────────────────────┤
│  Overview          ●   │  Speech recognition › Engine                                    🔒  │
│  Language model    🔒  │  How your speech is turned into text. Runs on this machine.         │
│  Speech recognition◂   │                                                                     │
│    Engine          ◂   │  Speech to text                                                     │
│    Turn timing         │  ( ● On this machine )  ( ○ Deepgram  HOSTED · NEEDS KEY )          │
│    Microphone proc.    │  Your voice never leaves this machine.                              │
│    Speech models       │                                                                     │
│    Not in use:         │  Speech recognition model                              RELOAD       │
│    Set up Deepgram     │  [ Parakeet v2 — English, most accurate              ▾ ]            │
│  Voices                │  Reads the whole sentence once you pause; no live words.            │
│  Modules               │                                                                     │
│  Keys & access         │  Language                                                           │
│  This device           │  [ Automatic ▾ ]   (shown for Whisper and Nemotron only)            │
│  Diagnostics       !   │                                                                     │
│  About                 │  ▸ Advanced (1)                                                     │
│                        │ ─────────────────────────────────────────────────────────────────── │
│                        │  [ Save ]  [ Cancel ]   Applies after an engine reload (≈ 2 s).     │  ← sticky page footer
└────────────────────────┴─────────────────────────────────────────────────────────────────────┘
   240 px list, current category expanded to its pages     page column max 640 px, scrolls on its own
```

- The list shows level-2 pages only under the current category (an accordion), so it stays short.
- **Badges in the list**: `●` the setup checklist has an open item; `!` errors (engine problem, module in error, field
  error in a saved form); `🔒` protected and this connection isn't admin; a dot on a page with unsaved edits
  ("Leave without saving?" when navigating away from a dirty page).
- Deep links: `#settings/speech/engine`, `#settings/modules/weather`, `#settings/voices/voice-natural`. The existing
  `ui.optionsTab` becomes `ui.settingsPath: [group, page?]`. Esc on a page goes up a level and on the list closes.

**Tablet (640–1023 px)**: same as the phone drill-down, but the page is centred at max 640 px. Trying to fit two panes
under 1024 px made both columns cramped.

**Phone (< 640 px, iPhone): drill-down**

```
┌───────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│ Settings              [×] │   │ ‹ Settings  Speech rec.   │   │ ‹ Speech rec.   Engine    │
│ [ Search…               ] │   │                           │   │ Speech to text            │
│ ▌Reload needed  [Reload]  │   │ Engine                  › │   │ (● This machine)          │
│ Overview            ●   › │   │ Turn timing             › │   │ (○ Deepgram  HOSTED)      │
│ Language model     🔒   › │   │ Microphone processing   › │   │                           │
│ Speech recognition      › │──▶│ Speech models           › │──▶│ Model            RELOAD   │
│ Voices                  › │   │ ───────────────────────── │   │ [ Parakeet v2         ▾ ] │
│ Modules                 › │   │ NOT IN USE                │   │ Reads the whole sentence… │
│ Keys & access           › │   │ Set up Deepgram         › │   │ ▸ Advanced (1)            │
│ This device             › │   │                           │   │                           │
│ Diagnostics         !   › │   │                           │   │ ┌───────────────────────┐ │
│ About                   › │   │                           │   │ │ Save         Cancel   │ │ ← sticky, above the
└───────────────────────────┘   └───────────────────────────┘   └─┴───────────────────────┴─┘   home indicator
```

- 56 px rows, `env(safe-area-inset-*)` padding, `100dvh`. The sticky Save bar sits above the keyboard (use
  `visualViewport` to lift it on iOS when an input is focused).
- The back button carries the parent's name (iOS convention). Swiping back isn't hijacked: the browser's own back
  gesture goes through the hash history, so `#settings/speech` → `#settings` works with it for free.
- One level of pages only: level 3 (e.g. a records item in Routing) opens inline as an expanding row, never as a fourth
  screen.

### 3.2 A page

A page = a header (title, one-line description, `🔒`/status), then one or more forms (one per section on that page, or
the module form), then embedded cards (tool card, downloads, engine list). It maps onto the existing components:

| Need | Existing | New / changed |
|---|---|---|
| Generated form | `SettingsForm.tsx` (draft, patch, server errors, stale "Changed in another tab", Advanced disclosure) | Save/Cancel move to a sticky page footer (one footer per page; with two forms on a page, Save saves both and reports per form); `visibleWhen`; warnings; "default"/"changed" marker + "Reset to default" per field (sends `null`, already supported by `SettingsPatch`) |
| Field renderers | `fields/*.tsx`, `ui/fieldRenderers.ts` | Choice options render `tags` as chips and disable `unavailable` options with the reason and an inline action ("Download · 640 MB"); the v2 types from AGENTS-AND-INTENTS §4.3 since protocol 10 (text lists, records, combos, buttons, info values; docs/UI-AND-MODULES.md §1.11) |
| Module page | `ModuleCard.tsx` (switch, status, error/Retry, form, tools) | Becomes `ModulePage`: the same parts laid out as a page (switch in the header); `ModuleCard` stays for compact lists (Overview) |
| Engines list, voices list | `AssistantTab.tsx` | Split: engines → Overview and the category pages; reload bar → global shell |
| Device settings | `DeviceTab.tsx` | Split into three pages; no logic change |
| About | `AboutTab.tsx` | Unchanged |
| Panel behaviour | `ui/Panel.tsx` (`useDialog`, `PanelHeader`) | Reused for the shell; `PanelHeader` gets a back button slot |
| Tabs registry | `ui/registry.ts` `optionTabs` | → `settingsPages` (client-only pages) + `groupMeta` (titles, icons, order of the nine categories) |
| **New** | | `SettingsShell`, `SettingsNav`, `SettingsPage`, `SetupChecklist`, `ToolCard`, `JobLog`, `DownloadsList`, `AccessPage`, `OverridesPage`, `SettingsSearch` |

### 3.3 Validation that explains itself

Four levels. Each is needed by a real case in the current settings.

| Level | When | Shown | Example from the code |
|---|---|---|---|
| **Local** (client, per keystroke) | type/range: the renderer's `onLocalError` (exists) | under the field, blocks Save | "12a" in a number field |
| **Field** (server, on save) | `Setting.decode`/`check`; returned as `fieldErrors` (exists) | under the field | `checkModel` (`sections.ts:291`): model files missing |
| **Cross-field** (server, on save) | new: a section-level `check(values) → FieldError[] \| Warning[]` | errors under the named field; warnings in an amber box above Save, "Save anyway" | final silence ≤ eager silence (error); Anthropic chosen but no key (warning: "Replies will fail until you add the key below", with a link to that field); expressive voice enabled but no Cartesia key; Deepgram chosen with no key |
| **Implication** (static, before saving) | option `description` (exists) + new `tags` | under the selected option, chips on every option | "HOSTED: your words are sent to Deepgram", "NEEDS KEY", "NOT DOWNLOADED · 640 MB", "SLOWER START (≈ 0.2–0.9 s first audio)" for Kokoro |

Rules:
- A missing download isn't an error. It's an **unavailable option** with an action. Picking it opens the inline
  download card; when the download finishes the option becomes available and the draft keeps the choice, so Save works.
  This replaces today's "save fails with the download command" (`sections.ts:338`), which is the `.env`-style
  tutorial the owner doesn't want.
- Hidden fields (`visibleWhen` false) are never validated or sent; their saved values stay.
- Field errors from saved values that became invalid (`form.errors`, exists) show on load, and the page's list item
  gets `!`.

### 3.4 Apply and reload

The apply modes are unchanged: `live` (next turn) and `reload` (engine reload ≈ 2 s, interrupts a reply). Modules restart
with a 10 s grace (live from the owner's point of view). New: `restart` appears only on read-only bootstrap info
("Applies when the assistant restarts").

- The per-field `RELOAD` chip stays. The page footer says "Applies after an engine reload" when a reload field is dirty.
- After saving reload fields: the **global bar** ("Saved changes need an engine reload · Reload now") appears at the top
  of the shell on every page, until reloaded. It names the pages with pending changes. To support that, the server
  sends `reloadPendingFor: string[]` (page ids) next to `reloadPending` (§4.1). **Save and reload** is offered as a
  second footer button on pages whose dirty fields are all `reload`.
- Reload failure: the preflight already keeps the running engines (`Engine.ts`, `defaultPreflight`). The bar turns red
  with the problem and "Running engines kept"; the page with the problem gets `!`.
- Reloading interrupts a reply in progress. If the assistant is speaking, the button says "Reload now (stops the reply)".

### 3.5 Protected, locked and set-outside states

There are three kinds of "can't edit". Each gets its own icon and its own way out:

| State | Icon | Field shows | Way out |
|---|---|---|---|
| **Admin only** (connection isn't admin) | padlock | non-secret values read-only; secrets "Set"/"Not set"; actions hidden | page header button **Unlock admin** → Keys & access › Admin access flow, then returns to the page |
| **Set outside the UI** (env) | pin | value + "From `.env` (/home/…/.env, line 12)" or "From the environment of the process (exported by the shell or service)" | **Move to settings** (only for `.env` origins; admin; §4.4). For a process-env value: an explanation only |
| **Vault locked** (secret fields) | key | "Stored in the vault (locked)" | **Unlock vault** inline (password field), admin |

Protected pages stay in the list for non-admins (with the padlock), so the owner knows they exist. The server enforces
everything; the UI only reflects it.

### 3.6 Search

It's worth doing, but late (phase P8). There are about 90 fields across 30 pages, and searching by the old environment
variable name ("CARTESIA_VOICE") is the bridge for an owner who remembers `.env`. Everything is already in the snapshot
(`sections`, `modules`), so this is a pure client-side index: label, description, env key, option labels, page title.
Results are a list of "Voices › natural › Speed"; choosing one navigates and focuses the field (`data-field` attributes
exist). No server change.

### 3.7 Overview page (first run with an empty `.env`)

```
 Overview
 ┌─────────────────────────────────────────────────────────────────┐
 │ Getting started                                         2 of 4  │
 │ ✓ Speech recognition: Parakeet v2 (downloaded)                  │
 │ ✓ Voice: standard (Piper, on this machine)                      │
 │ ○ Language model: offline stand-in (echoes you)  [ Choose… ]    │  → Language model › Provider
 │ ○ Key vault: locked                              [ Unlock ]     │  → inline password
 └─────────────────────────────────────────────────────────────────┘
 Engines   Language model  fake · offline stand-in           LOCAL
           Speech rec.     sherpa · parakeet-v2              LOCAL
           Voice           standard · Piper en_US-lessac     LOCAL
```

The checklist items are computed client-side from the snapshot (engine list, module states, vault and access state,
engine problems). No server work beyond what the other phases add.

---

## 4. Server and protocol changes

### 4.1 Placement on sections (checked: the core model has no `group`)

`packages/core/src/Settings.ts` has no grouping, and `SettingsSection` (`protocol/src/snapshot.ts:52`) is
`{ id, title, description?, form, revision }`. `group` exists only in the unmerged `protocol/src/agents.ts:267`
(`agents | speech | voices | general`) and `SettingsSectionGroupFields` (`agents.ts:376`).

Proposed, as optional fields (no version bump on their own; they can ride along with the v2 merge, piece G):

```ts
// protocol: widen the unmerged SettingsGroup before it merges
SettingsGroup = Literals(["agents", "speech", "voices", "modules", "access", "diagnostics", "general"])
SettingsSection += {
  group?: SettingsGroup,
  page?: { id: string, title: string, description?: string },   // sections with the same page.id share a page
  order?: number,
  visibleWhen?: Condition,          // whole page conditional (Deepgram)
  protected?: boolean               // align with the admin-access work
}
EngineStatus += { reloadPendingFor?: string[] }   // page ids whose saved values the running engines don't use yet
```

Server: `SectionDefinition` (`sections.ts:17`) gains `group`, `page`, `order`, `visibleWhen`. The current five sections
become: `llm-provider`, `llm-behaviour`, `llm-anthropic` (Language model); `stt-engine`, `stt-timing`, `stt-mic`,
`stt-deepgram` (Speech recognition); `voices`, `voice-<name>` ×3, `voice-services` (Voices); `recordings`
(Diagnostics).

### 4.2 Field semantics

```ts
Condition = { key: FieldKey, in: ReadonlyArray<string | number | boolean> }
          | { all: ReadonlyArray<Condition> } | { any: ReadonlyArray<Condition> }   // keys may be in other sections
common += {
  visibleWhen?: Condition,
  source?: "default" | "saved" | "env-file" | "env-process" | "vault",  // for markers and Reset
}
ChoiceOption += {
  tags?: ReadonlyArray<"hosted" | "local" | "needs-key" | "not-downloaded" | "slow-start" | "experimental">,
  unavailable?: { reason: string, action?: { kind: "download", target: string, sizeMb?: number } | { kind: "page", path: string } }
}
SettingsForm += { warnings?: ReadonlyArray<{ key: FieldKey | null, message: string }> }
locked += { source?: "env-file" | "env-process", file?: string, line?: number }   // the existing reason text stays
```

- `visibleWhen` keys can name fields in other sections (e.g. `STT_PROVIDER` from `stt-engine` governs `stt-timing`).
  Keys are global, so the client resolves them from all sections' values plus the current page's draft.
- Core: `Setting.*` constructors accept `visibleWhen` and `tags` (choice options already pass through `ChoiceOption`).
  `resolveSettings` fills `source`. A section-level `check` runs in `Sections.update` after `applySettingsPatch`.
- Closed-set note: `tags` is a closed literal set, so adding a tag later is a protocol change. Keep the set small.

### 4.3 Flat storage

`SettingsFile.sections: Record<sectionId, Record<key, value>>` (`SettingsStore.ts:20`) ties storage to layout. Moving a
field between pages would lose the saved value. `configProvider()` (`sections.ts:366`) already flattens everything, which
works only because keys are unique.

**Change**: `SettingsFile` v2 = `{ version: 2, modules, assistant: Record<key, value> }`. On load, v1 is migrated by
merging every `sections[*]` record into `assistant` (keys don't collide; on a collision the later section wins and a
problem is logged), and the file is written back as v2 (with `settings.json.v1-backup`). `sources(id)` in `sections.ts`
becomes `stored: store.assistant()` filtered to the spec's keys. Secrets move to the vault (parallel work); if the vault
keeps a sections/modules split, it should also store assistant secrets flat by key.

### 4.4 Moving the remaining environment reads behind the settings, and the env view

What serve mode already does right: every engine provider is built under `sections.configProvider()`
(`serveMode.ts:228`, `Engine.ts:206,266`), which is `orElse(env, saved)`. What's left:

1. **CLI modes don't read saved sections.** `voice.ts`, `text` mode, `say.ts`, `bench`, `transcribe.ts` use Effect's
   default provider (process env + `.env`). Only modules read the store (`modules.ts:30`). Fix: a shared
   `cliConfigProvider` = `makeSections(loadSettingsStore(dir, { readOnly: true }), envView).configProvider()` installed
   with `Effect.provideService(ConfigProvider.ConfigProvider, …)` at the top of `main.ts`. Secrets come from the vault:
   `PVA_VAULT_PASSWORD`, or an interactive password prompt when stdin is a TTY, else "vault locked" startup errors per
   stage (the existing per-stage reporting handles it).
2. **`ANTHROPIC_BASE_URL`** is read by the SDK, not by `Config`. Make it explicit (table 1.2).
3. **`decide-typesafe` `enabledByDefault`** reads raw env (`decider.ts:33`). Pass a `hasSecret(key)` lookup that
   checks env view and vault.
4. **The module host's `env`** (`serveMode.ts:76`, `modules.ts:36`) is a raw `process.env` record. Replace it with
   the env view below.
5. **`tts-sherpa/scripts/download-models.ts:11`** reads `process.env.TTS_SHERPA_MODEL_DIR`. It becomes a library
   function taking `modelDir` (§5.4); the script passes the env value.
6. Bootstrap reads (`ServeConfig`, `DataDirConfig`) stay as they are.

**Env view** (new, `apps/assistant/src/envView.ts`):

```ts
interface EnvView {
  get(key: string): string | undefined                 // non-empty only
  origin(key: string): { kind: "file"; path: string; line: number } | { kind: "process" } | undefined
  release(key: string): void                           // stop treating it as set (after "Move to settings")
  record(): Readonly<Record<string, string>>           // for ConfigProvider.fromEnvRecord and SettingsSources.env
  subscribe(f: () => void): () => void
}
```

`env.ts` today calls `process.loadEnvFile(path)`, which can't say which keys came from which file. Change it to read
each file with `util.parseEnv(readFileSync(path))` (available in this Node **[run]**), apply keys not already in
`process.env` (same precedence as now), and record `path` + line per applied key. Keys present before loading are
`process` origin.

**Move to settings** (admin, `.env` origins only), new client message `settings.moveFromEnv { requestId, keys[] }`:
1. Validate each value with its field's `fromEnv`. Save to the store (non-secret) or the vault (secret; fails if the vault
   is locked, with "Unlock the vault first").
2. Rewrite the file: back it up as `.env.bak-<timestamp>` (0600), replace the line with
   `# KEY moved to the settings UI on 2026-11-14` (never echo the value), and write atomically (temp + rename, keeping
   the file mode).
3. `envView.release(key)` → forms re-resolve. The field unlocks and now shows `source: "saved"`/`"vault"`. Broadcast
   `section.changed`/`module.changed`.
4. If a released key is a reload field, set `reloadPending`. The running engines keep the old value until the reload,
   so nothing changes mid-turn.

The Overrides page (Keys & access › Settings from outside) is derived client-side from every form's `locked` fields,
plus a server-provided list of known `.env` keys that match no field (`unusedEnvKeys`, so typos like
`STT_SHERPA_MODLE` become visible). It offers **Move all from .env**.

Precedence stays **env > saved > default**. Flipping it would make a deliberate `SERVE_*`-style or test override
silently lose to a stale saved value. With `.env` emptied by "Move to settings", the lock only ever shows up for
things the owner deliberately exported.

### 4.5 Access and vault hooks (align with the parallel work)

The UI needs from the server: `snapshot.access = { admin: boolean, adminConfigured: boolean }`, `protected` on sections
and modules (or a server-computed rule), `snapshot.vault = { state: "absent" | "locked" | "unlocked", keys:
{ key, set, usedBy: string[] }[] }` (admin only, no values), `SecretState.source += "vault"`, and every write (`settings.update`,
`module.configure`, `module.enable`, `engine.reload`, `settings.moveFromEnv`, `job.*`) rejected with a `forbidden` error
code for non-admin connections. `usedBy` comes from walking all section/module specs for secret fields with that key.

### 4.6 Tools and jobs (for §5)

```ts
// snapshot (admin connections only; others get [])
ToolInfo = {
  id: "claude-code" | "codex" | "stt-models" | "tts-models",            // closed set = the allowlist
  name: string,
  state: "checking" | "missing" | "installed" | "error",
  version?: string, source?: "bundled" | "path" | "configured",
  login?: { state: "logged-in" | "logged-out" | "unknown", detail?: string, expiresAt?: string },
  items?: { id: string, label: string, installed: boolean, sizeMb?: number }[],   // model presets
  actions: ("install" | "login" | "logout" | "download" | "delete" | "recheck")[],
  placement: { group: SettingsGroup, page: string }[],
  job?: JobInfo                                                            // the running or last job
}
JobInfo = {
  id: string, tool: ToolInfo["id"], action: string, target?: string,
  state: "running" | "waiting" | "succeeded" | "failed" | "cancelled",
  phase?: string,                                  // "Downloading", "Unpacking", "Waiting for you to sign in"
  progress?: { done: number, total?: number, unit: "bytes" | "steps" },
  link?: { url: string, label: string },           // only URLs whose host is on the tool's allowlist
  prompt?: { label: string, kind: "code" },        // e.g. the OAuth code the CLI asks for
  log: string[],                                   // last 200 lines, each ≤ 300 chars, ANSI stripped
  error?: string, startedAt: number, endedAt?: number
}
// client → server
job.start  { requestId, tool, action, target? }   // target validated against ToolInfo.items / fixed values
job.input  { requestId, jobId, text }              // one line to the process's stdin; never logged or echoed
job.cancel { requestId, jobId }
// server → admin connections
tool.changed { tool: ToolInfo }                    // includes job updates, throttled to ≤ 4/s per job
```

Protocol cost: new messages and snapshot fields with closed literal sets → bundle with the v2 merge, or make it v3.

---

## 5. Installers and logins (optional goal)

### 5.1 The safety model

- **Allowlist only.** `apps/assistant/src/serve/tools/registry.ts` maps each `ToolInfo.id` to an object with
  `detect()` and fixed `actions`. Each action is an argv array built in code. The only variable parts are values checked
  against a closed set: a preset name from `presetNames`, or `"stable"` for an install target. Nothing typed by the user
  reaches argv, a path or a URL. `job.input` goes to stdin only, and only while the job is in `waiting`.
- **No shell.** `child_process.spawn(file, args, { shell: false })`. Executables are resolved to absolute paths at
  detect time (bundled path from the SDK package, or `which` over a fixed `PATH`). `curl … | bash` is never used.
- **Environment**: `HOME`, `PATH`, `LANG`, `USER`, `CLAUDE_CONFIG_DIR`/`CODEX_HOME` if set; API keys and
  `ANTHROPIC_*` stripped (the agent's `STRIPPED_ENV` list). `cwd` is a fresh temp folder. `stdin` is a pipe (closed
  unless a prompt is open).
- **Limits**: one job per tool. At most one install/login job and two downloads at a time. Timeouts: detect 5 s,
  login 10 min, install 10 min, download none but stalled > 60 s fails. Output capped (200 lines kept, 1 MB read then
  truncated).
- **Admin only**, enforced in `SessionHub` for `job.*`. Every job writes one audit line to the server log: connection id,
  tool, action, target, outcome, duration. No output content goes to the log for login jobs.
- **Links**: a URL is surfaced as a button only if its host is on the tool's list (Claude: `claude.ai`, `claude.com`,
  `console.anthropic.com`, `platform.claude.com`; Codex: `auth.openai.com`, `chatgpt.com`). Other URLs stay plain log
  text.
- Jobs live on the server: closing the tab doesn't stop them, and a reconnecting admin tab gets `job` in the snapshot.
  A server restart forgets jobs, and partial files (`.part`) are cleaned at startup.

### 5.2 Claude Code (the `claude-subscription` agent)

**What's actually installed** **[run]**:
- System: `/home/ian/.local/bin/claude` → `~/.local/share/claude/versions/2.1.318` (the native installer layout;
  2.1.316 also present). `claude --version` → `2.1.318 (Claude Code)`.
- Bundled: `@anthropic-ai/claude-agent-sdk` 0.3.323 declares `optionalDependencies` on per-platform packages. Here,
  `@anthropic-ai/claude-agent-sdk-linux-x64/claude` (362 MB) is installed in the main checkout and reports
  `2.1.323 (Claude Code)`. The agent's `claudePath` setting says "Empty: the copy bundled with the SDK"
  (`agent.ts`). **So the agent works without any system `claude`.** (This worktree has no `node_modules`; checked in
  `/home/ian/.t3/projects/personal-voice-assistance`.)
- Login state is per user, not per binary: `claude auth status --json` reports `configDirectory: /home/ian/.claude`,
  so a login made with either binary serves both.

**Detect** (in `packages/agent-claude-code`, the only package allowed to know about the SDK; export
`claudeCodeTool = { binaries(), version(bin), authStatus(bin) }`):
1. Candidates in order: the `claudePath` setting, the bundled binary (resolve
   `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude` with `createRequire`), then `claude` on `PATH`.
2. `<bin> --version` (5 s), parsed with `/^(\d+\.\d+\.\d+) \(Claude Code\)/`.
3. `<bin> auth status --json` (5 s). Observed shape **[run]**, sensitive values omitted:
   ```json
   { "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "analyticsDisabled": false,
     "projectsDirectory": "/home/ian/.claude/projects", "configDirectory": "/home/ian/.claude",
     "loginExpiresAt": "2026-12-02T09:28:34.414Z", "email": "…", "orgId": "…", "orgName": "…", "subscriptionType": "max" }
   ```
   Map to `login.state` and `detail` = "Max plan · renews by 2 Dec". Don't send `email`/`orgId`/`orgName` to the
   browser by default (admin-only "Show account" if wanted). Never log them. `authMethod` other than `claude.ai` (e.g.
   Console/API key) → warn "This login bills an API account; the agent refuses it (`apiKeySource` check)", which matches
   `session.ts` refusing API-key logins.
4. Re-run detect after any job, on demand (**Check again**), and when the agent module fails with an auth error
   (`isAuthError` in `agent.ts`).

**Install** (rarely needed):
- Shown only when no candidate binary exists. That happens when the optional dependency was skipped (unsupported
  platform or libc, or `pnpm install --no-optional`).
- Preferred action: **repair the bundled copy**, i.e. `pnpm install --frozen-lockfile` in the repo root (fixed argv,
  `cwd` = repo root). It restores the platform package the lockfile already pins, and it's the same command the owner
  ran to set the repo up.
- Secondary action, "Also install the `claude` command for your user": run an existing binary's own installer,
  `<bundled claude> install stable` (from `claude install --help` **[run]**: "Install Claude Code native build. Use
  [target] to specify version (stable, latest, or specific version)"). This needs no download script and no
  `curl | bash`, because the code comes from a package already pinned by the lockfile. **[verify]**: not run here (it
  would modify `~/.local`). Only offered when a binary exists (bootstrapping from nothing = the pnpm repair).
- Not offered: `npm install -g @anthropic-ai/claude-code` (writes to the global npm prefix, often root-owned, so it
  fails or needs sudo; duplicates the native install) and the curl installer (remote script into a shell).

**Login** (the real task). `claude auth login --help` **[run]**: `--claudeai` (subscription, default), `--console`,
`--email`, `--sso`. The flow:

```
 Language model › Claude subscription
 ┌──────────────────────────────────────────────────────────────────┐
 │ Claude Code      2.1.323 · built in                       LOCAL  │
 │ Login            ○ Not logged in                                 │
 │                  [ Log in with your Claude account ]             │
 └──────────────────────────────────────────────────────────────────┘
        │ job.start { tool: "claude-code", action: "login" }
        ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ Signing in · waiting for you                       [ Cancel ]    │
 │ 1. [ Open the Claude sign-in page ↗ ]   (link from the CLI)      │
 │ 2. After you approve, Claude shows a code. Paste it here:        │
 │    [ ••••••••••••••••••••     ] [ Send ]                         │
 │ ▸ Details (log)                                                  │
 └──────────────────────────────────────────────────────────────────┘
        │ exit 0 → detect again → "Logged in · Max plan"
        ▼  if the agent module is enabled and in error: restart it (module host enable)
```

- Spawn `<bin> auth login --claudeai` with piped stdio and `BROWSER=` unset/`/bin/false` so it doesn't try to open a
  browser on the server. Scan stdout/stderr for the first allowlisted URL → `job.link`. If the CLI prints a code prompt
  (pattern like `/paste.*code/i`), move to `waiting` with `prompt: { kind: "code" }`. The code from `job.input` is
  written to stdin plus newline, then the prompt clears. It's never stored, logged, echoed in `log`, or sent to other
  tabs.
- **Two cases**: (a) The page is open on the server machine itself (`location.hostname` is loopback). The CLI's own
  localhost callback completes the sign-in when the owner approves in that browser, so no code relay is needed. (b) The
  page is on the iPhone. The callback to the server's localhost can't reach it, so the CLI's manual "paste the code"
  path is needed. The UI shows step 2 only when the CLI asks.
- **[verify] before building (the spike in phase P6)**: whether `claude auth login` with no TTY prints the URL and
  accepts a pasted code on stdin, or needs a pseudo-terminal. Run it with `CLAUDE_CONFIG_DIR=$(mktemp -d)`, so the
  owner's real login is untouched, and cancel before approving. If it needs a TTY: use `script -qfec "<argv>" /dev/null`
  (util-linux, fixed argv, no shell interpolation of user data) rather than adding `node-pty` (native build). If neither
  works: the card falls back to "Log in from a terminal on this machine: `claude auth login`", the one place a command
  is shown, because there's no UI alternative.
- **Terms** (`docs/research/agent-backends.md` §2, quoted there): "developers may not collect, store, or intermediate
  Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow".
  This design runs the unmodified binary's own login. Sign-in completes on Anthropic's pages, and the assistant never
  sees a credential or token. In case (b) it relays a one-time authorization code from the owner's clipboard to that
  binary's stdin without keeping it. **The owner decides** whether case (b) is acceptable. Default: offer it behind the
  existing opt-in switch, with case (a) preferred whenever possible.
- **`claude setup-token` is excluded** from the allowlist. Its help says it sets up "a long-lived authentication token
  (requires Claude subscription)" **[run]**. The token is printed for the caller to keep (as `CLAUDE_CODE_OAUTH_TOKEN`).
  Putting it in the vault would mean the assistant *stores a Claude.ai session token*, which is exactly what the quoted
  terms forbid. It's also unnecessary, because the CLI's own credential store already persists the login.
- **Logout**: `<bin> auth logout`, admin + confirm dialog: "This also signs out Claude Code in your terminal on this
  machine." (Same credential store.)

**Failure modes**

| Failure | Detected by | Shown |
|---|---|---|
| No binary at all | detect finds no candidate | "Claude Code isn't available" + **Repair** (pnpm install) |
| Bundled binary can't run (glibc/musl mismatch, noexec temp) | `--version` exits ≠ 0 or ENOENT/EACCES | error + stderr tail; suggest **Repair**; `claudePath` field highlighted |
| `auth status` output not JSON / fields renamed in a new version | JSON parse / schema decode fails | `login.state: "unknown"` + "Couldn't read the login status (Claude Code 2.x changed?)"; the agent's own start check (`initializationResult`) stays authoritative |
| Login URL never appears (30 s) | no allowlisted URL in output | job fails with the log tail; fallback text (terminal command) |
| Wrong/expired code | process prints an error, exits ≠ 0 | "Sign-in failed: <last line>", **Try again** starts a new job |
| Owner closes the tab mid-login | job keeps running until timeout (10 min) | re-attaches on reconnect; **Cancel** kills the process group |
| Logged in with Console/API key | `authMethod` | warning, agent stays off (existing `apiKeySource` refusal) |
| Usage limit / plan lapsed | agent turn errors (`billing_error`, `account_on_hold`) | status line on the agent page + "Check again"; nothing to install |
| Install target network failure | `claude install` exits ≠ 0 | failed job with log; existing bundled copy keeps working |

### 5.3 Codex (`codex login`), for when `packages/agent-codex` lands

**[run]**: `codex-cli 0.166.0` at `~/.local/bin/codex` → `../lib/node_modules/@openai/codex/bin/codex.js` (an npm
global install under a user-owned prefix). `codex login status` → `Not logged in`. `codex login --help` lists
`--device-auth`, `--with-api-key`, `--with-access-token`, and `status`.

- **Detect**: `codex --version` (`/^codex-cli (\S+)/`), `codex login status` (text; map "Not logged in" vs
  "Logged in using ChatGPT/API key" **[verify exact wording when logged in]**).
- **Login**: `codex login --device-auth`. It prints a verification URL and a one-time code. The owner opens the URL on
  any device (the iPhone included) and types the code *on OpenAI's page*. The assistant relays nothing back, so there's
  no `job.input`. The UI shows the URL as a link and the code in large mono text with a copy button. The job succeeds
  when the process exits 0, then detect runs again. This is the cleanest flow of the three.
- **Excluded**: `--with-api-key` / `--with-access-token` (they would make the UI a credential pipe; an OpenAI API key
  belongs to an API-key agent with a vault field, not to the subscription harness).
- **Install**: `npm install -g @openai/codex@<pinned>`. It's offered only when `npm config get prefix` is writable by the
  user (it is here: `~/.local`); otherwise the action is disabled with "npm's global folder needs root". Pin the version
  the agent package was tested with (research: 0.166.0 tested).

### 5.4 Local speech models

Today: `pnpm download-models` (root `package.json`) = `stt-sherpa download-models` + `tts-sherpa download`. Both scripts
fetch fixed GitHub release URLs from the preset tables (`stt-sherpa/src/presets.ts:108` `archive()`,
`tts-sherpa/src/Presets.ts`), stream to `.part`, rename, `tar xjf`, check the expected files, and delete the archive.
That's already idempotent and atomic. The recogniser field error points at `DOWNLOAD_COMMAND`
(`presets.ts:275,341`).

Design:
- Move the download logic into library functions: `downloadPreset(name, { modelDir, signal, onProgress })` in
  `stt-sherpa` and `tts-sherpa` (each package owns its URLs). The scripts become thin wrappers, so both paths share
  one implementation. `onProgress({ phase: "download" | "unpack" | "verify", done, total })` uses `Content-Length`.
- Unpack with `spawn("nice", ["-n", "10", "tar", "-xjf", archive, "-C", modelDir])`. bzip2 decompression is CPU heavy
  and runs on the machine that's decoding speech.
- **Latency claim to verify, not assume**: run a conversation during a download and compare `TurnTrace`
  `ttsFirstAudio`/`playbackStart` medians against idle. If the difference shows, the UI says "Downloads may slow replies
  until they finish" and the default becomes "pause unpacking while a turn is running".
- **Disk space**: `fs.statfs(modelDir)` before starting. Required size = archive size + unpacked size (add `sizeMb` to
  each preset; the descriptions already state sizes informally, e.g. "about 300 MB"). Refuse with "Needs ≈ 1.4 GB,
  0.9 GB free".
- **Cancel**: abort the fetch, kill tar, remove `.part` and a half-unpacked folder (unpack into
  `modelDir/.unpack-<id>`, then rename).
- **UI**: Speech recognition › Speech models and Voices › Voice models list each preset with label, description, size,
  installed/missing, **Download** / **Delete** (delete refuses the preset in use by the running engines). The
  recogniser and voice-preset selects mark missing presets as `unavailable` with an inline Download action (§3.3).
  After a download, `installedPresets()` changes and the section is re-announced (`modelOptions()` in
  `sections.ts:42` already computes labels live).
- **Failure modes**: HTTP 404/5xx (upstream moved; show the URL and status), stall > 60 s, `tar` missing or without
  bzip2 (detect at startup: `tar --version`; "Install bzip2"), archive missing expected files (existing check: fail and
  delete), disk full mid-download (ENOSPC → clean `.part`), models folder not writable (EACCES at the start).

---

## 6. Phasing

Pieces are delegate-sized: each owns its files, keeps `pnpm check` and `pnpm test` green, and is testable without keys.
**Every piece that touches `apps/assistant`, `apps/web`, `packages/protocol` or `packages/agent-claude-code` starts
after the agent currently editing them has landed.** The pieces that need the vault/access work say so.

| # | Piece | Owns | Tests | Risks |
|---|---|---|---|---|
| **P1** | **Settings shell (web)**: full-screen layer, list + page ≥ 1024, drill-down < 1024, hash deep links, global reload bar, sticky page footer, `ModulePage`, split `AssistantTab`/`DeviceTab` into pages. Until P2 lands, a client-side fallback table maps today's section ids to groups/pages | `apps/web/src/components/settings/*` (new), `OptionsDrawer.tsx` (replaced), `ui/registry.ts`, `lib/state.ts` (`ui.settingsPath`), `AssistantTab.tsx`, `DeviceTab.tsx` | unit: tree builder (sections + modules → nav), path parsing; Playwright against the mock at 390×844 and 1280×800: navigate, back, deep link, dirty-leave prompt, reload bar; existing e2e updated | merge conflicts with in-flight web work; iOS keyboard vs sticky footer (test in WebKit) |
| **P2** | **Placement + flat storage (server, protocol)**: `group/page/order/visibleWhen` on sections, `reloadPendingFor`, widen `SettingsGroup`; `SettingsFile` v2 + migration; split today's sections into the pages of §2.1; voice sections (AGENTS-AND-INTENTS piece H's `voiceSections.ts`) | `packages/protocol/src/{snapshot,agents,examples}.ts`, `apps/assistant/src/serve/{sections,SettingsStore,voiceSections}.ts`, mock server | migration v1→v2 (incl. collision), every section resolves/patches, `reloadPendingFor`, examples test covers new fields, scripted-client serve test | coordinate with piece G's v2 merge (same files): do P2's protocol part inside G or right after it |
| **P3** | **Field semantics**: `visibleWhen` (core + renderer), option `tags`/`unavailable`, form `warnings`, field `source` + Reset, section-level cross-field `check`s (final > eager; provider without key; voice without key) | `packages/core/src/Settings.ts`, `packages/protocol/src/settings.ts`, `apps/web/src/components/SettingsForm.tsx`, `fields/ChoiceField.tsx`, `lib/forms.ts`, `sections.ts` checks | core: visibility doesn't validate hidden fields, warnings don't block, `source` per precedence; web: draft-driven visibility, Save anyway; serve: warnings round-trip | `tags` is a closed set (protocol change to grow); keep cross-section conditions simple (equality only) |
| **P4** | **Shrink `.env`**: env view with origins (`env.ts`, `envView.ts`), module host and sections on the env view, `settings.moveFromEnv` + file rewrite, CLI modes on saved settings, explicit `ANTHROPIC_BASE_URL`, `decide-typesafe` lookup, new `.env.example`, README trim, Overrides page | `apps/assistant/src/{env,envView,main,voice,text,say,transcribe}.ts`, `serve/{serveMode,SessionHub}.ts` (move message), `packages/llm-anthropic/src/index.ts` (config line), `packages/decide-typesafe/src/decider.ts`, `.env.example`, `README.md`, web `OverridesPage` | parse origins (file vs process, line numbers); move rewrites a temp `.env` atomically with backup and no value echo; released key unlocks the field and re-resolves; CLI provider precedence (env > saved > default); vault-locked move refused | the CLI vault prompt needs the vault API; rewriting a user file must be careful (atomic, mode kept, backup) |
| **P5** | **Keys & access pages** (after vault + admin land): admin unlock/sign out, vault state/unlock/change password, keys list with "used by", padlock/key states in nav and fields, Server info page | web `components/settings/access/*`, small server glue only where the parallel work left hooks (`usedBy` computation in `sections.ts`/module host) | Playwright: non-admin sees padlocks and read-only values, unlock → editable; vault locked → secret fields show "locked"; server rejects writes from non-admin (scripted client) | depends entirely on the parallel API; don't start before it's merged |
| **P6** | **Tool registry, jobs, Claude Code**: first a 1-hour **spike** (no-TTY behaviour of `claude auth login` with a throwaway `CLAUDE_CONFIG_DIR`, cancelled before approval, with the owner's OK); then `claudeCodeTool` in the adapter, `serve/tools/{registry,jobs}.ts`, protocol `jobs.ts`, `ToolCard`/`JobLog`, embedding in Language model › Claude subscription and Diagnostics › Software | `packages/agent-claude-code/src/tool.ts` (new; only the adapter resolves the SDK binary), `apps/assistant/src/serve/tools/*`, `packages/protocol/src/jobs.ts`, `SessionHub.ts` (job routing, admin check), web `ToolCard.tsx`, `JobLog.tsx` | fake executables (small Node scripts: prints version / JSON status; prints a URL, waits for a code on stdin, exits 0 or 1; hangs) run through the real spawner; argv never contains client strings (property test over `job.start` inputs); non-admin `job.*` → `forbidden`; code never appears in `log` or server log; cancel kills the process group; timeout | CLI output format can change between Claude Code versions → defensive parsing + terminal fallback; terms (owner decision on code relay); the 362 MB binary must not be spawned on every page load (detect is cached, refreshed on demand) |
| **P7** | **Speech model downloads** (could go before P6: lower risk, serves local-first): library `downloadPreset` in both sherpa packages (scripts become wrappers), `sizeMb` per preset, statfs check, `nice` unpack, Models pages, inline Download in selects | `packages/stt-sherpa/{src/presets.ts,src/download.ts,scripts/download-models.ts}`, `packages/tts-sherpa/{src/Presets.ts,src/download.ts,scripts/download-models.ts}`, `serve/tools/models.ts`, web `DownloadsList.tsx` | local HTTP server serving a tiny `.tar.bz2` fixture: progress events, cancel cleans `.part` and unpack folder, missing-file archive fails, 404, stall timeout; statfs mocked; script wrappers still work; **TurnTrace comparison** during a real download (manual, recorded in the PR) | bzip2 CPU vs reply latency (measure); disk usage (Whisper/Parakeet are hundreds of MB) |
| **P8** | **Search** | web `SettingsSearch.tsx`, `lib/settingsIndex.ts` | index unit tests (env key, label, option label); Playwright: search → navigates → focuses field | none significant |
| **P9** | **Codex login/install** (when `agent-codex` exists) | `packages/agent-codex/src/tool.ts`, registry entry | fake `codex` script printing a device URL + code; npm prefix writability check | wording of `codex login status` when logged in **[verify]** |

**Recommended order**: P2 ∥ P1 → P3 → P4 → P7 → P5 (as soon as vault/admin merge; it can jump ahead) → P6 → P8 → P9.

**Done (2026-11-14, phase 2a)**: P1, P2, P3, P5 — see "Status" at the top. Seams left for the rest: P4 can widen
`FieldSource` origins (line numbers) and add the Overrides page under Keys & access (a `settingsPages` line); P6's
tool card belongs on the Claude subscription card in `ServerPage.tsx` (`OptionModuleCard`) and on a Diagnostics page;
P7 adds `ChoiceOption.unavailable` and replaces the save-time model refusal in `sections.ts` (`checkModel`); P8 can
index `buildSettingsTree`'s pages and the `data-field` attributes.
The owner gets the visible change (P1+P2) first, then working dependent fields (P3), then an almost empty `.env`
(P4), then the local-first download experience (P7), and finally the optional installer/login work (P6).

**What the owner decides or supplies**

| Item | Needed by | Default if unanswered |
|---|---|---|
| Is relaying the Claude sign-in code from the phone acceptable under Anthropic's terms (§5.2)? | P6 | Only the same-machine flow (no relay); phone shows "Finish signing in on the computer running the assistant" |
| OK to run the P6 spike (`claude auth login` in a throwaway config dir, cancelled before approval)? | P6 | Spike not run; P6 ships with the terminal fallback only |
| Keep `SERVE_HOST`/`SERVE_PORT`/TLS in `.env` (read-only in the UI)? | P4 | Yes |
| Unattended vault unlock (`PVA_VAULT_PASSWORD` in `.env`) or unlock in the UI after each restart? | P4/P5 | Unlock in the UI; Overview shows it as the first open item |
