# Characters: for port authors

What a character is and the rules it follows: [`docs/CHARACTERS.md`](../../../../docs/CHARACTERS.md). This page is the practical part: where your file goes, what it may import, how to test it and how to look at it.

## Adding a character is adding one file

`library/<id>.ts`, default-exporting a `Character` (`contract.ts`). Nothing else: no list to edit, no registration. `scripts/build-characters.mjs` lists `library/` into the git-ignored `library.generated.ts` (one `import()` per character, so each is its own chunk) before `dev`, `build`, `check` and `test`; `dev:mock` also watches the folder. The compatibility tests find your file the same way, and write its digest snapshot on the first run: commit `test/characters/__snapshots__/<id>.digest` with it. A port is therefore two new files and touches nothing shared.

| File | What |
|---|---|
| `contract.ts` | The contract. Fixed: never edit it in a port. |
| `kit.ts` | Small allocation-free helpers (smoothing, springs, noise, colour, canvas setup, option readers). |
| `shared/figure.ts` | The figures' rig: blinks, gaze, the listening model (`Social`), the mouth, personality options. Was the lab's `designs/_character.ts`. |
| `shared/light.ts` | Helpers of the light family. Was `designs/_light.ts`. |
| `shared/matter.ts` | Helpers of the matter family. Was `designs/_matter.ts`. |
| `library/sine-lines.ts` | The baseline, a worked example. |
| `host.ts`, `runner.ts`, `voices.ts`, `features.ts`, `options.ts`, `manifest.ts`, `choice.ts`, `registry.ts` | The host side. A character never imports these. |

A file in `library/` may import `../contract.ts`, `../kit.ts` and `../shared/*.ts`, and nothing else: no application code, no packages, no page globals (`document`, `window`, `fetch`, timers, …). `test/characters/isolation.test.ts` enforces it. The shared modules are used by six characters each: import them, never edit them in a port (a change there changes five other characters, and two ports editing them would conflict).

## Porting a design from the lab

The lab's `designs/<id>.ts` becomes `library/<id>.ts`, behaviour unchanged:

- Imports: `../contract.ts` and `../kit.ts` stay; `./_character.ts` → `../shared/figure.ts`, `./_light.ts` → `../shared/light.ts`, `./_matter.ts` → `../shared/matter.ts`.
- Types: `Design` → `Character`, `DesignInstance` → `CharacterInstance`. A table keyed by mode (`{ [M in Mode]: … }`) becomes `{ [M in CoreMode]: … }` and is read with `f.coreMode` (for a character that declares no extra modes `f.mode` is always a core mode, but its type is the wider `Mode`).
- Manifest: add `version: "1.0.0"` and `contract: 1`; `family: "character"` becomes `"figure"`; `serverNeeds` goes, and what it said becomes `uses` entries (`{ ext, gain, without }`, names from docs/CHARACTERS.md §5.2) or nothing when it said "none". `extraModes` only if you design those modes (docs/CHARACTERS.md §4.3).
- The shared helpers read `frame.coreMode` instead of `frame.mode`; nothing else changed in them.

Measured on the lab designs before porting (docs/CHARACTERS.md §6): every check passes except "(5) reduced motion" for `aurora-ribbons`, `cloud-orb` and `pitch-ink`, which still change between two frames a second apart in a pinned, silent mode. Those ports need a decision (hold the pose, or ask the lead to relax the check), not a silent change.

## Tests

```sh
# The compatibility suite for one character (the quotes matter: the suite is named `character "<id>"`)
pnpm --filter @pva/web exec vitest run test/characters/compat.test.ts -t '"<id>"'
# A deliberate change of the default look: check it, then rewrite the digest
pnpm --filter @pva/web exec vitest run test/characters/compat.test.ts -t '"<id>"' -u
# Everything, from the repository root
pnpm check && pnpm test
```

The suite drives your character with simulated voices through the real feature extractor, on a recording fake canvas (jsdom has none; the fake also provides `OffscreenCanvas` and a WebGL2 context that accepts everything). It checks the five core modes are different, extra modes and their fallbacks, unknown extensions, option extremes and garbage, reduced motion, the default-look digest, the manifest and a generous cost bound. The real 2 ms budget is measured in the page (below).

## Looking at it in the app

```sh
MOCK_SCENARIO=typed pnpm --filter @pva/web dev:mock     # the mock assistant on :8787 and next dev on :3000
```

Open `http://localhost:3000/?character=<id>` (add `&opt.<option>=<value>` for options, `&opt.$you=%23ff8800`, `&opt.$sensitivity=1.5` for the host-level settings). The choice is saved for this browser and the parameters leave the address bar; `?character=sine-lines` goes back to the baseline. If port 8787 is taken (a running assistant), start with `MOCK_PORT=8797` and add `&ws=ws://localhost:8797/ws`.

The `typed` scenario runs no turn by itself, so every visual state can be held with the mock's control endpoints (port as above):

| State | How |
|---|---|
| not started | Load the page; do not press Start. |
| listening | Press Start. |
| hearing, thinking, speaking (no audio), idle, asleep | `curl -X POST localhost:8787/mock/state -d '{"state":"hearing"}'` (any of those names) |
| speaking with real reply audio | `curl -X POST localhost:8787/mock/turn` (the scripted turn: hearing, thinking, then a spoken reply) |
| muted | Press `M`. |
| disconnected | `curl -X POST localhost:8787/mock/offline -d '{"ms":10000}'` |
| error | `curl -X POST localhost:8787/mock/scenario -d '{"name":"outdated"}'`, then reload. |
| observer | A second tab of the same browser (it does not own the audio and gets stand-in voices). |

In the browser console, `__pvaStage.debug()` says which character is on stage, whether the host fell back and why, and the mean cost of `frame()` (`frameMs`) and of the voices' features (`featuresMs`) over the last 120 frames. Reduced motion: the browser's developer tools can emulate `prefers-reduced-motion`; the light theme follows `prefers-color-scheme`.

## The picture for your pull request

Every port attaches the same contact sheets, made by one command:

```sh
CHARACTER=<id> pnpm --filter @pva/web shots:character
```

It builds the static export (set `SKIP_BUILD=1` to reuse an existing one in `out/`; `PVA_WEB_EXPORT_DIR` if you export elsewhere), starts its own mock and static server on free ports (so several checkouts can run it at once; `SHOTS_MOCK_PORT` / `SHOTS_WEB_PORT` pin them), and takes about a minute. It writes exactly two files, which you attach to the pull request (committing them is fine; they are not ignored):

- `apps/web/screenshots/characters/<id>-dark.png`
- `apps/web/screenshots/characters/<id>-light.png`

Each is a row of five panels, IDLE, LISTENING, HEARING, THINKING, SPEAKING: the voice page's stage area at the desktop size (1280 x 800 window) with your character in that state, composed into one image in the browser. Every panel is a fresh page. HEARING runs on Chromium's fake microphone (the speech-like tone of `e2e/fakeMic.ts`), SPEAKING on the mock's scripted turn with real reply audio (`/mock/turn`); the other three are captioned as having no audio. The command fails, with the reason, if your character is not on stage or the host fell back (`__pvaStage.debug()`), so a broken port cannot produce a sheet of the baseline.

For a one-off picture in some other state, write a Playwright file as `e2e/screenshots.shots.ts` does (`appUrl(baseURL, "&character=<id>")`, `mock.state(...)`, `page.locator(".stage-vis").screenshot(...)`) and run it with `pnpm --filter @pva/web screenshots`; keep it out of your pull request.
