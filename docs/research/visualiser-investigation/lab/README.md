# Visualiser lab

> This is the research prototype behind [`../README.md`](../README.md) (the visualiser investigation). The long-lived rules for building characters are in [`docs/CHARACTERS.md`](../../../CHARACTERS.md). All commands below run from the repo root.

A single-file page for trying out "listening" and "speaking" visualisers against simulated (or real) voices.
`src/contract.ts` is the contract. Read it first: it is short, and it is the only interface a design sees.

## Add a design

1. Create `src/designs/<id>.ts`. `<id>` is kebab-case and must match `design.id`. The build finds the file by
   listing the directory, so there is no shared list to edit. Files starting with `_` are ignored.
2. Default-export a `Design`:
   ```ts
   import type { Design } from "../contract.ts"
   import { approach, clear2d, rgba, setup2d } from "../kit.ts"

   const design: Design = {
     id: "my-orb", name: "My orb", family: "abstract", renderer: "2d",
     summary: "…", inspiredBy: "…", serverNeeds: "none",
     modes: { idle: "…", listening: "…", hearing: "…", thinking: "…", speaking: "…" },
     mappings: [{ signal: "active.level", effect: "radius, 40 ms rise / 200 ms fall" }],
     create(canvas) {
       let g = setup2d(canvas), dpr = 1, w = 1, h = 1
       return {
         resize(width, height, ratio) { w = width; h = height; dpr = ratio; g = setup2d(canvas, dpr) },
         frame(f) { clear2d(g, dpr); /* draw from f only */ },
         dispose() {}
       }
     }
   }
   export default design
   ```
3. `src/designs/sine-lines.ts` is the worked example: complete metadata, reduced motion, smoothing with `dt`,
   no allocation per frame.
4. `src/kit.ts` has springs and smoothing (`approach`, `AttackRelease`, `Spring`), `noise2`/`noise3`/`fbm2`,
   `rng(seed)`, `clamp`/`lerp`/`smoothstep`/`remap`, colours on `Rgb` (`mix`, `rgba`, `lift`/`sink` that respect
   the theme), `setup2d`/`clear2d`, and for WebGL2 `glProgram` plus `FULLSCREEN_VERTEX`.

Import only from `../contract.ts`, `../kit.ts` and other files you own. Don't edit shared files.
A design that fails to compile, throws, or has bad metadata shows up as a red error tile, and every other design keeps running.

## Build and look

From the repo root:

```sh
pnpm lab          # writes docs/research/visualiser-investigation/visualiser-lab.html (open it in a browser)
pnpm lab:watch    # rebuilds on every save under lab/src; reload the page
pnpm check                          # type-checks the lab too (lab/tsconfig.json under docs/research/visualiser-investigation)
```

The gallery shows every design following one automatic conversation. Click a tile, or open `…/visualiser-lab.html#<id>`, for the detail view.
It has a large stage, the live feature values, your `modes` and `mappings`, and the reaction matrix: the same design under different
modes, loudness, voices, delivery and assistant loudness.

URL choices work in the query string or after the hash (`#my-orb?mode=hearing&theme=light`): `design`,
`mode=auto|idle|listening|hearing|thinking|speaking`, `theme=auto|dark|light`, `matrix=modes|loudness|voice|delivery|assistant`,
`reduced=1`, `user=deep,loud,fast-excited`, `agent=…`.

## Screenshot one design headlessly

```sh
node docs/research/visualiser-investigation/lab/shot.mjs --design my-orb --mode hearing --theme dark --out /tmp/orb-hearing.png
node docs/research/visualiser-investigation/lab/shot.mjs --design my-orb --matrix loudness --theme light --out /tmp/orb-loudness.png
node docs/research/visualiser-investigation/lab/shot.mjs --design my-orb --page --out /tmp/orb-page.png    # the whole detail view
node docs/research/visualiser-investigation/lab/shot.mjs --out /tmp/gallery.png                            # the gallery
```

Options of a design: `--opt id=value`, repeatable, e.g. `--opt lines=5 --opt glow=0 --opt '$you=#ff3399' --opt '$sensitivity=1.5'`
(common settings are `$you`, `$voice`, `$sensitivity`; toggles take `1`/`0`; colours `#rrggbb` or `you|voice|ink|inkFaint`).
`--panel` shoots the Customise panel instead of the stage.

Other options: `--t <seconds>` waits before the shot (default 2), `--width <px>`, `--reduced`, `--user`/`--agent <register,loudness,delivery>`.
The script uses the installed Playwright Chromium (SwiftShader for WebGL), prints console errors, and exits with 1 if the page threw.
Build first.

## Options

A design can expose a few settings a person would tune to taste. Declare them in `options` and read them from `frame.options`
(always complete and validated; defaults filled in). The detail view shows them in a "Customise" panel next to the stage, grouped by `group`
in declaration order, under a "General" section the harness adds to every design (your colour, assistant colour, sensitivity;
these override `palette.you` / `palette.voice` and scale `level`, `rms`, `bands`, `low`, `mid`, `high` for you, with no design code).
Values are kept per design in `localStorage` and mirrored in the URL hash as `opt.<id>=<value>` (the hash wins over storage), so a link reproduces a look.
"Copy settings" copies `{ "design": "<id>", "options": { … } }`.

```ts
options: [
  { id: "lines", kind: "number", label: "Lines", min: 1, max: 5, step: 1, default: 3, group: "Shape", help: "How many lines are drawn." },
  { id: "glow", kind: "toggle", label: "Glow", default: true },
  { id: "style", kind: "choice", label: "Style", choices: [{ value: "soft", label: "Soft" }, { value: "sharp", label: "Sharp" }], default: "soft" },
  { id: "tint", kind: "color", label: "Tint", default: "you" } // "#rrggbb" or you | voice | ink | inkFaint
],
// in frame():
const lines = optNumber(f.options, "lines"), glow = optToggle(f.options, "glow"), style = optChoice(f.options, "style"), tint = optColor(f, "tint")
```

Kit helpers (cheap, total: a missing id gives `0`, `false`, `""`, `palette.ink`):
`optNumber(options, id): number`, `optToggle(options, id): boolean`, `optChoice(options, id): string`, `optColor(frame, id): Rgb`
(a palette key resolves against `frame.palette`, so it follows the theme and the viewer's recolouring; `#rrggbb` is parsed once and cached).
A bad declaration (duplicate id, default out of range or off the step grid, default not among the choices, empty label) shows on the design's error tile.

Rules:
- Options are tastes a person would tune, not internal constants. 3 to 8 per design; ids are camelCase (not starting with `$`).
- Every combination must still work and still show the five modes.
- Glide to new values (`approach` with `dt`) instead of jumping; values can change between any two frames.
- A `size`-like option must keep the design inside the canvas at its maximum, at tile size and on the 900×420 stage.
- Use `unit` for numbers where it helps ("px", "%", "×"); write `help` as one plain sentence.

## Rules

- **Budget: 2 ms per `frame()`** on a laptop. The tile and the detail view show the mean and worst of your measured cost.
  The mean covers the last 120 frames and the worst the last 300, both skipping the first 10. Allocate in `create`/`resize`, not per frame.
- **Reduced motion** (`frame.reducedMotion`): no continuous motion and no flashes. The mode must still read from colour and shape.
  Try it with the "Reduced motion" button.
- **Both themes**: use `frame.palette` (it changes live). Mint `you` is the person and amber `voice` is the assistant.
  Draw on a transparent canvas, because the page background shows through.
- **Sizes**: everything from a 280×160 tile (matrix cells are about 160×140) up to the 900×420 stage must look intentional.
  `resize` gives CSS pixels and `dpr`.
- Never touch the DOM outside your canvas, never start your own animation loop, never read audio.
  `renderer: "webgl2"` designs must free their context in `dispose()`. At most 6 WebGL instances run at once,
  and the harness disposes and recreates them as they scroll in and out of view.
- `mappings` are promises: say exactly which signal moves what.

## What else is here

| File | What |
| --- | --- |
| `src/features.ts` | Pure feature extractor (FFT, YIN pitch, onsets, mouth estimate) that turns 40 ms windows into `VoiceFeatures`, at about 0.05 ms per call |
| `src/synth.ts` | Seeded formant speech simulator (register × loudness × delivery presets) |
| `src/sources.ts` | Clip player, microphone, dropped audio files, "hear it" monitor |
| `src/driver.ts` | Conversation loop (auto or pinned mode) producing both voices' features |
| `src/options.ts`, `src/optionStore.ts` | Option validation, merging, colours, sensitivity copy (pure); the per-design store (storage, URL pairs, JSON) |
| `test/options.test.ts` | Tests for those two |
| `src/engine.ts` | One rAF loop, visibility, WebGL cap, error isolation, cost measurement |
| `src/app.ts`, `src/lab.css` | The page |
| `src/priorArt.ts` | Prior-art survey shown below the gallery |
| `test/features.test.ts` | Extractor tests (run by `pnpm test`) |
