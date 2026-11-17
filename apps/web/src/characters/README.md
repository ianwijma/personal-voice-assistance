# Characters: for port authors

What a character is and the rules it follows: [`docs/CHARACTERS.md`](../../../../docs/CHARACTERS.md). This page is the practical part: where your file goes, what it may import, how to test it and how to look at it.

## Adding a character is adding one file

`library/<id>.ts`, default-exporting a `Character` (`contract.ts`). Nothing else: no list to edit, no registration. `scripts/build-characters.mjs` lists `library/` into the git-ignored `library.generated.ts` (one `import()` per character, so each is its own chunk) before `dev`, `build`, `check` and `test`; `dev:mock` also watches the folder. The compatibility tests find your file the same way, and write its digest snapshot on the first run: commit `test/characters/__snapshots__/<id>.digest` with it. A port is therefore two new files and touches nothing shared.

| File | What |
|---|---|
| `contract.ts` | The contract. Fixed: never edit it in a port. |
| `kit.ts` | Small allocation-free helpers (smoothing, springs, noise, colour, canvas setup, option readers). `clear2d(g, dpr, origin)` puts (0, 0) at the focus. |
| `shared/figure.ts` | The figures' rig: blinks, gaze, the listening model (`Social`), the mouth, personality options. Was the lab's `designs/_character.ts`. |
| `shared/light.ts` | Helpers of the light family. Was `designs/_light.ts`. |
| `shared/matter.ts` | Helpers of the matter family. Was `designs/_matter.ts`. |
| `library/sine-lines.ts` | The baseline, a worked example, including of a stage character. |
| `host.ts`, `runner.ts`, `voices.ts`, `features.ts`, `options.ts`, `manifest.ts`, `choice.ts`, `registry.ts` | The host side. A character never imports these. |

A file in `library/` may import `../contract.ts`, `../kit.ts` and `../shared/*.ts`, and nothing else: no application code, no packages, no page globals (`document`, `window`, `fetch`, timers, …). `test/characters/isolation.test.ts` enforces it. The shared modules are used by six characters each: import them, never edit them in a port (a change there changes five other characters, and two ports editing them would conflict).

## Porting a design from the lab

The lab's `designs/<id>.ts` becomes `library/<id>.ts`, behaviour unchanged:

- Imports: `../contract.ts` and `../kit.ts` stay; `./_character.ts` → `../shared/figure.ts`, `./_light.ts` → `../shared/light.ts`, `./_matter.ts` → `../shared/matter.ts`.
- Types: `Design` → `Character`, `DesignInstance` → `CharacterInstance`. A table keyed by mode (`{ [M in Mode]: … }`) becomes `{ [M in CoreMode]: … }` and is read with `f.coreMode` (for a character that declares no extra modes `f.mode` is always a core mode, but its type is the wider `Mode`).
- Manifest: add `version: "1.0.0"` and `contract: 1`; `family: "character"` becomes `"figure"`; `serverNeeds` goes. Do not turn what it said into `uses`: it described what a design *could* use one day, while `uses` lists only extensions the code reads from `frame.ext` today (docs/CHARACTERS.md §3, §4.2). A ported design reads none, so it has no `uses`; add an entry (`{ ext, gain, without }`, names from docs/CHARACTERS.md §5.2) in the same change that makes the code read that extension. `extraModes` only if you design those modes (docs/CHARACTERS.md §4.3).
- The shared helpers read `frame.coreMode` instead of `frame.mode`; nothing else changed in them.

Measured on the lab designs before porting (docs/CHARACTERS.md §6): every check passes except "(5) reduced motion" for `aurora-ribbons`, `cloud-orb` and `pitch-ink`, which still change between two frames a second apart in a pinned, silent mode. Those ports need a decision (hold the pose, or ask the lead to relax the check), not a silent change.

## Making a character use the whole stage

Background and design rules: docs/CHARACTERS.md §2.6. In short: with `canvas: "stage"` the canvas covers the whole voice page, `resize` reports that size, and `frame.focus` (`{ x, y, width, height }`, CSS px, per frame) is where the old box is. Everything gets the stage canvas unless there is a reason not to; the question is only how much of it a character uses (the table in §2.6: edge light uses all of it; glowing shapes put their glow and particles beyond the box; line-like ones keep the box's width and gain vertical room; figures keep a box-like layout and gain uncut shadows, glow and motion room). `library/sine-lines.ts` is the worked example (diff it against its 1.0.0 in git: `git log -p -- apps/web/src/characters/library/sine-lines.ts`).

### The change, for a ported 2D `library/<id>.ts` drawn in the box from (0, 0)

1. Manifest: add `canvas: "stage",` after `renderer`; raise `version` by a minor step (`"1.0.0"` → `"1.1.0"`). Update a mapping or a mode line only if what it promises changed (say "the box" where it says "the canvas" or "the height").
2. Keep the canvas's own size from `resize` under other names (for example `CW`, `CH`); the character's layout no longer comes from it.
3. At the top of `frame`, replace `clear2d(g, dpr)` with:

   ```ts
   const fo = f.focus
   clear2d(g, dpr, fo) // clears the whole canvas; (0, 0) is now the box's top-left corner
   W = fo.width
   H = fo.height
   ```

   and leave the drawing code as it is: what it drew from (0, 0) to (W, H) now lands on the box, and anything beyond (glow, haze, sparks) is no longer cut. The canvas spans `-fo.x .. CW - fo.x` by `-fo.y .. CH - fo.y` in these coordinates.
4. Pointer: `f.pointer` is in canvas coordinates, so use `f.pointer.x - fo.x`, `f.pointer.y - fo.y`. `f.pointer.inside` now means "in the window"; a character that reacts to hovering itself tests the box: `px >= 0 && px < W && py >= 0 && py < H`.
5. Run the tests (below). The `dark` / `light` / `overflow` lines of the digest must not change (only the header's version and the new `stage` lines): `clear2d` with the origin at (0, 0) makes exactly the calls it made without it, so if box lines changed, the box look changed, and step 3 or a trap below was done wrong. Then update with `-u` and look at the page (below).

That is all for most characters (flame needed exactly this). Then go through the traps; each is a place where the old code assumed the canvas is the box.

### Traps

- **Layout computed in `resize`.** Sizes, centres, radii, path or gradient caches, grid geometry, particle bounds computed from `width`/`height` in `resize` are now the whole page. Compute them in `frame` from `fo.width`/`fo.height`, or keep the cache and rebuild it when the focus size changes (compare with the last size; the focus's position changes often, its size rarely: on a window resize, or the layout scaling with the height). Never rebuild on a position change.
- **Arrays sized for the old box** (one sample per 2 px across the width, a grid per cell): allocate in `resize` for the canvas (the largest the focus can be), and use the part the focus needs each frame (`Math.min(arr.length, …)`). sine-lines does this with `ys`.
- **Offscreen canvases and layers** (`new OffscreenCanvas(w, h)` in `resize`, a glow layer, a trail buffer): decide what each holds. The shape's own layer: size it to the focus (rebuild on a size change only) and draw it with `drawImage` at (0, 0) after `clear2d(g, dpr, fo)`. A glow or haze layer meant to spread: size it to the canvas but by a pixel budget (draw it at reduced resolution and scale it up), because a full-page layer at full resolution costs many times the box's. A layer drawn with `drawImage(layer, 0, 0, W, H)` while `W`, `H` are still the canvas size draws a page-sized layer into the box.
- **Transforms reset inside `frame`.** `g.setTransform(dpr, 0, 0, dpr, 0, 0)`, `g.setTransform(1, 0, 0, 1, 0, 0)`, `g.resetTransform()` or a second `clear2d(g, dpr)` drop the focus offset: everything after it is drawn at the page's corner. Use `g.save()`/`g.restore()` around temporary transforms, or set `g.setTransform(dpr, 0, 0, dpr, dpr * fo.x, dpr * fo.y)` again.
- **`clearRect`, `fillRect(0, 0, W, H)` and clips.** `clearRect(0, 0, W, H)` with the focus size clears only the box: clear with `clear2d` at the top of the frame only. A wash, vignette or background painted with `fillRect(0, 0, W, H)` becomes a box-shaped patch with hard edges: make it a radial gradient that reaches alpha 0, or paint the whole canvas (`fillRect(-fo.x, -fo.y, CW, CH)`). `g.rect(0, 0, W, H); g.clip()` cuts the glow at the box again: remove it unless it is the shape's own outline.
- **Radial glows with hard edges.** A radial gradient filled into a square shows that square when the last stop's alpha is above 0, or when the square is smaller than the gradient's radius (`fillRect(cx - r, cy - r, 2r, 2r)` with the gradient's outer radius `r` is right). In the box these were hidden by the box's edge; on the stage every one shows.
- **Clamps that kept things inside the canvas** (`Math.min(top, H * 0.98)`, particles killed or wrapped at `x < 0 || x > W`, "never past the top of the canvas"): they now hold things inside the box. Keep them for the essential shape; let sparks, particles and glow go to the canvas edge (`-fo.x .. CW - fo.x`) or fade out on their own. Particles stored in box coordinates move with the box when the focus moves; that is fine.
- **Helpers that take a size** (`unit(w, h)` in `shared/light.ts`, a figure's scale): pass the focus size.
- **WebGL2.** Keep `gl.viewport(0, 0, canvas.width, canvas.height)` (the whole canvas) in `resize`. Pass the shape's centre and scale per frame from the focus, in device pixels with y flipped (`gl_FragCoord` starts at the bottom): `cx = (fo.x + fo.width / 2) * dpr`, `cy = (CH - fo.y - fo.height / 2) * dpr`, scale from `fo.width`/`fo.height` times `dpr`, never from the resolution uniform. A full-canvas fragment shader costs per pixel of the whole page: return early far from the shape, or render the glow into a smaller framebuffer.
- **The pixel ratio.** Use the `dpr` from `resize`: for a stage canvas the host may have lowered it, below 1 too (backing store capped at 4.2 million device pixels; 1920 × 1080 at ratio 2 gets 1.42, 3840 × 2160 at ratio 1 gets 0.71; never below 0.5). Never read `devicePixelRatio`.
- **Cost.** Measure on the stage at 1280 × 800 and at 1920 × 1080 (`__pvaStage.debug().frameMs`, after 2 s in each mode; the limit before the host stops a character is 4 ms, the target 2 ms). Edge glow with nothing but `canvas: "stage"` measured 5.5 ms at 1280 × 800 and 10.8 ms at 1920 × 1080: its glow work surface follows the canvas size; give it a pixel budget.

### Edge light

A character that lights the screen's edge (edge-glow) uses the whole canvas and ignores `focus` for its shape: keep `clear2d(g, dpr)`, keep `W`, `H` from `resize` (now the page), and fix the cost. It may use the focus to keep its light clear of the box. Check (9) of the suite accepts a drawing that surrounds the focus.

### Staying box-like

A figure or a solid shape keeps its layout in the box (the recipe above does exactly that) and gains uncut shadows and glow and room for a bounce or a lean. A character should stay `"box"` (leave the field out) only if it cannot work on a larger canvas at all; say why in the pull request. None of the 18 is known to need it.

### Digest and pictures

The compatibility suite runs a stage character as before (no focus: the box) for the `dark`, `light` and `overflow` lines, and on the desktop stage for the `stage` lines and check (9) (offset focus, moving focus, option extremes, centred on the focus). A deliberate change of the stage look regenerates the digest the usual way (`-u`, below); check with `git diff` that only the lines you meant changed. The contact sheets (below) show the whole page, so glow and edges can be judged; also look at a phone width (390 × 844) and with the chat panel open (`C`; at 1280 px wide the box slides 200 px left), in both themes.

## Tests

```sh
# The compatibility suite for one character (the quotes matter: the suite is named `character "<id>"`)
pnpm --filter @pva/web exec vitest run test/characters/compat.test.ts -t '"<id>"'
# A deliberate change of the default look: check it, then rewrite the digest
pnpm --filter @pva/web exec vitest run test/characters/compat.test.ts -t '"<id>"' -u
# Everything, from the repository root
pnpm check && pnpm test
```

The suite drives your character with simulated voices through the real feature extractor, on a recording fake canvas (jsdom has none; the fake also provides `OffscreenCanvas` and a WebGL2 context that accepts everything). It checks the five core modes paint something and paint something different (clearing and setting state is not painting), extra modes and their fallbacks, unknown extensions, option extremes and garbage, reduced motion, the default-look digest, the manifest, a 1 × 1 canvas and focus and a focus partly off the canvas, and a generous cost bound. Like a browser, the fake throws for a negative radius (`arc`, `arcTo`, `ellipse`, `createRadialGradient`, `roundRect`), so clamp computed radii at 0. The real 2 ms budget is measured in the page (below).

## Looking at it in the app

```sh
MOCK_SCENARIO=typed pnpm --filter @pva/web dev:mock     # the mock assistant on :8787 and next dev on :3000
```

Open `http://localhost:3000/?character=<id>` (add `&opt.<option>=<value>` for options, `&opt.$you=%23ff8800`, `&opt.$sensitivity=1.5` for the host-level settings). This is a try-out for this page load only: it wins over the look configured in the admin, nothing is stored, and the parameters leave the address bar; reload to see the configured look again. `opt.*` without `character` tunes the configured look. To keep a look, set it in the admin (`http://localhost:3000/admin/`, password `admin password`): Assistants › an assistant › Look (the picker, your options as controls, a live preview), or Devices › a device › Look for a device's own (docs/LOOKS-AND-VOICES.md). If port 8787 is taken (a running assistant), start with `MOCK_PORT=8797` and add `&ws=ws://localhost:8797/ws`.

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

Each is a row of five panels, IDLE, LISTENING, HEARING, THINKING, SPEAKING: the whole voice page at the desktop size (1280 x 800 window, so glow beyond the box and the text over it show) with your character in that state, composed into one image in the browser. Every panel is a fresh page. HEARING runs on Chromium's fake microphone (the speech-like tone of `e2e/fakeMic.ts`), SPEAKING on the mock's scripted turn with real reply audio (`/mock/turn`); the other three are captioned as having no audio. The command fails, with the reason, if your character is not on stage or the host fell back (`__pvaStage.debug()`), so a broken port cannot produce a sheet of the baseline.

For a one-off picture in some other state, write a Playwright file as `e2e/screenshots.shots.ts` does (`appUrl(baseURL, "&character=<id>")`, `mock.state(...)`, `page.screenshot(...)`) and run it with `pnpm --filter @pva/web screenshots`; keep it out of your pull request.
