# Characters

How to design and build the thing on the voice stage that shows the assistant is listening, thinking and speaking, and the rules that keep every character working as the application grows.

This is a living document. Update it whenever a character is added, the contract gains something, or a rule turns out wrong. The investigation that produced the first set of characters is in `docs/research/visualiser-investigation/` (findings, prior art and a runnable lab with 19 prototypes); this document holds what should outlast it.

**Status (2026-11-16).** The groundwork is in the app: the contract (`apps/web/src/characters/contract.ts`), the host that runs one character on the voice stage (`host.ts`), the feature extractor, kit, options and the shared helpers brought over from the lab, the registry, the baseline character (the sine lines, `library/sine-lines.ts`) and the compatibility tests of §6. Only the baseline is in the library so far; the 18 prototypes of the investigation (`docs/research/visualiser-investigation/`, where a character is called a *design*) are to be ported one file each (§7). The lab stays as a frozen research snapshot with its own copies. Extensions (§4.2, §5) are designed but none exists yet. Since 2026-11-17 the look is chosen and tuned in the admin, per assistant and per device (§4.4, docs/LOOKS-AND-VOICES.md). Port authors start at `apps/web/src/characters/README.md`.

**Update (2026-11-16): the whole stage.** A character may now ask for a canvas covering the whole voice page instead of the box in its middle (`canvas: "stage"`, §2.6), and every frame says where the box is (`focus`). Characters that do not ask behave exactly as before. The baseline is a stage character (version 1.1.0). The 18 ports each move to the stage by the recipe in the README.

## 1. What a character is

A **character** is a module that draws the assistant's presence on a canvas. It may be abstract (a flame, a ring of light) or a figure (a face, a pair of eyes, a creature). Both kinds follow the same contract and the same rules; "character" does not imply a face.

A character:

- is given one **frame** per animation tick: the conversation mode, the voice features of the person and of the assistant, the time, the theme colours, the viewer's settings and the pointer;
- draws that frame on its own canvas and does nothing else. It never touches the page outside its canvas, never starts its own animation loop, never reads audio, never opens a network connection and never imports application code;
- declares what it is in a **manifest**: identity, version, renderer, the settings it offers, and which optional inputs it can use.

The **host** is the application code that owns the canvas, the animation loop, the audio analysis and the settings. One host can run any character; one character can run in any host that speaks its contract (the web client, the lab, later a voice node with a small display).

This is the same split the rest of the application uses (`docs/ARCHITECTURE.md`, `docs/UI-AND-MODULES.md` §3.12): a narrow interface, modules that know nothing about each other, one line to register a new one.

## 2. Designing a character

### 2.1 What it must say

A person glancing at the stage needs one answer: *whose turn is it?* Everything else is secondary.

| Mode | The person should read | Typical means |
|---|---|---|
| idle | Nothing is happening; it is not listening. | Grey, small, nearly still, dozing. |
| listening | The microphone is open and it is waiting for me. | The person's colour, attentive pose, calm; clearly different from idle while still quiet. |
| hearing | It is taking in what I say right now. | Reacts to the person's own voice within a frame or two; motion travels inward. |
| thinking | It heard me and is working; I should wait. | Its own rhythm, no audio; visibly not a stall. Mixes both colours or uses a third look. |
| speaking | It is talking. | The assistant's colour; motion travels outward; follows the reply audio. |

These five are the **core modes**. Every character supports all five, always. The set of modes can grow (§4.3): the app already has further states (asleep, muted, reconnecting, error: `docs/UI-AND-MODULES.md` §3.3) and more are expected. A character need not design any of them: each mode beyond the core names the core mode it falls back to, and a character that has not opted into it is simply shown that core mode.

Rules that came out of the investigation:

- **Five modes must be tellable from a still frame**, not only from motion. Test with screenshots. Reduced-motion users get stills only.
- **Never rely on colour alone.** Mint is the person and amber the assistant by default, but both can be recoloured, and some people cannot tell them apart. Add direction (inward when taking in, outward when giving out), shape, position or size.
- **One continuous object.** Modes are transitions of the same thing, never a cut to another picture. Every product surveyed that is well regarded does this.
- **Few states, each very different.** A study of smart-speaker lights found that people correctly identified about 37 % of patterns. Do not add sub-states a person has to learn.
- **Calm by default.** This sits on a desk all day. Idle and listening should be quiet enough to ignore.

### 2.2 What drives it

Everything a character receives is computed in the browser from audio the client already has: the microphone frames and the reply player's output. The analysis costs about 0.05 ms per frame and needs no server. The signals (exact definitions and ranges in the contract file):

| Signal | What it is | Good for |
|---|---|---|
| `level` | Perceived loudness, 0 to 1 | Size, brightness, reach. The one signal every character uses. |
| `pitch`, `register`, `pitchDelta` | Pitch now, the voice's usual pitch, and whether it is rising or falling | Position, grain, tilt; telling a deep voice from a high one; questions. |
| `bands`, `low`/`mid`/`high`, `brightness` | The spectrum | Outline detail, colour temperature. |
| `onset`, `syllableRate` | Syllable starts and pace | Bursts, bounces, particles; the feel of fast against slow speech. |
| `voicing`, `sibilance` | Voiced or breathy; "s" and "sh" | Solid against hollow (a whisper), sparkle, teeth. |
| `speaking`, `speechFor`, `silenceFor` | Voice activity and timing | Backchannel: reacting at the end of a phrase. |
| `mouth.open/wide/round` | A mouth-shape estimate from the spectrum | Lip sync without phoneme data. |

Rules:

- **Be honest.** If something moves with the voice, it must be driven by the voice. A looped animation that only looks reactive is found out within seconds. List every signal-to-effect pair in the manifest's `mappings`; they are promises and they are shown to the user.
- **Use more than loudness, with a reason for each.** A whisper and a shout must look very different; so should a deep voice and a child's. Pace and intonation are the hardest to show and the easiest to neglect.
- **The person and the assistant should feel different**, not only look different. One proven split: the person's loudness changes size, the assistant's changes how fast the inside moves.
- **Smooth with the frame time** (`dt`), never per frame, so it behaves the same at 60 and 120 Hz.

### 2.3 Figures: faces, eyes, creatures

A figure can do what an abstract form cannot: show attention. It also fails in ways an abstract form cannot.

- **Listening must react to the person, not run a loop.** In a controlled study, nods timed to the speaker's pauses and pitch built rapport as well as a human listener; the same nods at random times did worse. Nod shortly after a phrase ends, tilt on a rising question, lean in for a whisper, pull back from a shout.
- **Clearly stylised, never near-human.** Movement deepens the uncanny valley. A few strokes, dots for eyes, flat shapes.
- **Few expressions.** Only show what the assistant has a basis for: attention, effort, speaking. No invented emotions (but see §5 for expression the language model supplies).
- **Life between events**: blinks, small gaze shifts and breathing with irregular, seeded timing, so two instances never blink in step.
- **Lip sync from the spectrum is good, not exact.** It cannot see closed-mouth sounds (m, b, p). Exact timing needs the speech engine's phoneme data (§5.2).
- **Friendly, calm, adult.** No gendered or ethnic features.
- **Shared personality.** Figures use the same option ids for the same things (§4.4), so a person's taste carries from one figure to another.

### 2.4 Constraints every character meets

- **2 ms per frame** on a laptop at stage size, at its heaviest settings. No allocation per frame. Measure; do not reason.
- **Reduced motion** (`reducedMotion`): no continuous motion and no flashes. Hold poses. The mode still reads.
- **Dark and light themes**, from the frame's palette. Additive glow that works on dark vanishes on a pale background: design for both from the start.
- **Any size** from a 160 × 140 cell to a 900 × 420 stage, and stay inside the canvas at every size and setting. A stage character (§2.6) sizes itself from `focus`, the same range, on a canvas up to the whole window.
- **Transparent canvas.** Captions and overlays are drawn by the host on top; leave them room or stay out of the lower third. On the stage, the page's text sits below and around the box and carries a halo in the page colour (`stage-legible`), which keeps it readable over soft light, not over solid shapes.
- **Works with nothing but the core frame** (§4.2). This is the rule the whole compatibility story rests on.

### 2.5 Checklist before a character is accepted

1. Screenshots of the five modes in both themes: can someone who has never seen it name each?
2. Screenshots under whisper, normal, shouting; deep and high voice; slow and fast speech: are they tellably different?
3. Reduced-motion screenshots of the five modes.
4. Smallest and largest canvas; every option at both extremes together.
5. Measured frame cost at the heaviest settings, for a stage character on the stage at 1280 × 800 and 1920 × 1080 (`__pvaStage.debug().frameMs`).
6. The compatibility tests of §6 pass.
7. Manifest complete and exact: modes, mappings, options with help text, `uses`, `canvas`.
8. A stage character: whole-page screenshots (the contact sheets show them) with no hard edge anywhere, in both themes, at desktop and phone size, with the chat panel open (the box slides 200 px left at 1024 to 1439 px wide); the text stays readable.

### 2.6 Using the whole stage

The box in the middle of the voice page (`.stage-vis`, at most 720 px wide and 48 to 240 px high) is too small for light: a glow cut off at its edges shows as a lit rectangle with hard edges, and a character that lights the screen's edge cannot reach the edge. So a character can ask for the whole stage.

**What the host gives.** `canvas: "stage"` in the manifest. The canvas then covers the whole stage area of the voice page: the full viewport, behind the header, the captions, the controls and the chat panel. `resize(width, height, dpr)` reports that size. Each frame, `frame.focus` is the box's rectangle on that canvas (CSS pixels): where the character centres itself and what it sizes its main shape from. It is per frame because the box moves without the canvas resizing: the stage slides 200 px left while the chat panel is open (desktop widths 1024 to 1439 px, over 320 ms), the box's height and position scale with the window height (and the box shrinks to a strip while something is presented, §2.7), and the stage scrolls under long captions on short screens (the canvas does not scroll, so the focus moves, and can reach past the canvas edge). For a `"box"` character, `focus` is the whole canvas, so the same code serves both.

**What the character does.**

- Size and centre the main shape from `focus` (for most characters: draw exactly what it drew in the box, at the box's place; `clear2d(g, dpr, frame.focus)` does it for 2D code written from (0, 0)).
- Clear the whole canvas, and draw glow, haze, particles and sparks wherever they reach: they now fade out on their own instead of being cut.
- Keep everything essential inside `focus`: the mode must read from what is inside the box. What is outside is atmosphere: the page's text sits below and around the box.
- Follow `focus` every frame, never cache it in `resize`; a jump of the focus (the panel opening, a scroll) must not leave things behind or spawn anything.
- Stay a good box character too: a host without a stage (the lab, a voice node, the tests) gives a stage character the box with `focus` the whole canvas.

**How much of the stage to use** depends on the character, not on a rule; every character gets the stage canvas unless there is a reason not to:

| Kind | Uses the stage for | Examples |
|---|---|---|
| Edge light | The whole canvas: it lights the screen's edge and leaves the middle (and the focus) free. Ignores `focus` for its shape. | edge-glow |
| Light and glow around a centred shape | Glow, halo, haze, sparks and particles beyond the box; the shape stays the box's size, centred on it. | flame, twin-lights, light-ring, cloud-orb, liquid-blob, particle-sphere, ripple-pond, aurora-ribbons |
| Line-like | Keep the box's width (they fade at the ends); more room to move up and down. | sine-lines, pitch-ink |
| Figures and solid shapes | Little: soft shadow or glow, motion (a bounce, a lean) that may leave the box a little. Box-like layout, stage canvas. | blob-buddy, line-face, lips, profile-head, robot-eyes, dot-quartet, dot-matrix, chladni-sand |

**Cost.** A stage canvas has many more pixels than the box (1280 × 800 is 5.9 times a 720 × 240 box; 1920 × 1080 at pixel ratio 2 is 48 times a box at ratio 1). The host caps a stage canvas's backing store at 4.2 million device pixels (`STAGE_MAX_PIXELS` in `host.ts`: the pixel ratio is lowered until the backing store, each side rounded to whole pixels, fits, below 1 when the CSS viewport alone is larger than the cap, but never below 0.5, `STAGE_MIN_RATIO`; 1280 × 800 at ratio 2 fits, 1920 × 1080 at ratio 2 gets ratio 1.42, 3840 × 2160 at ratio 1 gets 0.71; only a window of more than about 16.8 million CSS pixels goes past the cap, at ratio 0.5), so use the `dpr` from `resize`. Per-pixel work (full-canvas fills, `getImageData`, offscreen layers, shaders) grows with the canvas: size such work by a pixel budget, not by the canvas, and measure at 1920 × 1080 too. Measured (2026-11-16, headless Chromium, software raster, the baseline speaking / hearing with a loud voice): `frame()` itself 0.05 to 0.08 ms at every size; with the drawing rasterised (forced by a 1-pixel `getImageData`), 0.56 / 0.91 ms at 1280 × 800 ratio 1, 1.64 / 2.67 ms at 1280 × 800 ratio 2, 2.41 / 3.98 ms at 1920 × 1080 ratio 2 uncapped and 1.14 / 1.93 ms capped (the box today: 0.51 / 0.68 ms at ratio 1, 1.22 / 1.76 ms at ratio 2). In the page the host measured the baseline's `frame()` at 0.13 to 0.19 ms at 1280 × 800 ratio 1 and 0.14 to 0.19 ms at 1920 × 1080 ratio 2.

### 2.7 The presentation stage (P10)

Since P10 the voice page shows what modules present (cards, lists, timers, images, the weather) and P9's notification
cards in **one presentation stage** (docs/PRESENTING.md "The voice page"). **The contract does not change for a
character**: the frame, the box (`.stage-vis`), the stage canvas and `focus` are as before, and no character is told
what is presented. What a character sees is the box changing size, which it always could (it already scales with the
window height, from 16 px up):

- **while something is presented the box shrinks to a strip under the header** (40 px high on a phone, 64 px from
  640 px wide, its width unchanged; 16 px, covered by the presentation, on a screen at most 600 px high), and returns to
  its usual size when the last presentation goes or a menu, a panel or the chat covers the stage. The change is
  immediate (no animated resize), so a box character gets one `resize` each way and a stage character's `focus` moves
  in one frame;
- the presentation area takes the rest, from under that strip to just above the controls (96 px above the bottom of
  the page), up to 960 px wide: opaque cards with a border and the panel shadow, drawn above the stage, so glow under
  them is hidden rather than fought with; a stage character's atmosphere still shows around them;
- the captions and the stage's overlays step aside while something is presented; the state label stays under the box;
- it slides 200 px left with the stage while the desktop chat is open (1024 to 1439 px wide), as the box does.

So a character must stay readable in a strip 40 px high (a mode must read from what is inside the focus, as before);
what it draws outside the focus may run under the presentation area.

### 2.8 The player surface (media module)

Since the media module's page (docs/modules/media.md §5, docs/UI-AND-MODULES.md §3.1) the stage can also show a music
panel (Spotify) or a theatre (YouTube's frame). **The contract does not change for a character**: no character is told
what plays, the frame and `focus` are as before, and a character written before this still works. What a character sees
is the box changing size and place, which it already could (§2.7):

- **Music panel**: nothing changes for the character. The panel is a separate card (a phone: above the controls; from
  1024 px: at the right of the stage), and the box stays where it is.
- **Theatre**: the frame takes the stage and the character yields, with the same means as a presentation, in two
  steps. *Quiet*: the box is a badge of 72 × 48 px at the left end of the theatre's strip (`position: fixed`, so out of
  the layout; `data-theatre-badge` on the root). A character must read its mode from a 72 × 48 px focus: a box
  character gets one `resize`, a stage character's `focus` moves in one frame, and the stage canvas still covers the
  whole viewport behind the page. *Talking* (woken, listening, hearing, thinking, speaking): the box is its usual size
  again, and the theatre's frame starts below it. The frame is above the canvas, never under glow the character draws
  over it: a character's drawing is behind the page's content, so nothing of a character is ever drawn over the frame.
- A character that does not survive a 72 × 48 px focus is already out of contract (§2.7 asks for a strip 40 px high).

## 3. The manifest

What a character declares about itself: the `Character` object in `apps/web/src/characters/contract.ts` (in the lab, the `Design` object). The host checks it on every load (`manifest.ts`) and refuses a character whose manifest is incomplete; the compatibility tests check it too (§6.7).

| Field | Meaning | Where it is used |
|---|---|---|
| `id` | Stable kebab-case identifier, equal to the file name. Never reused for a different character. Stored in the choice. | Registry, choice, host |
| `name`, `summary`, `inspiredBy` | For the picker. | Manifest check; the admin's character picker shows `name`, `summary` and `family` |
| `family` | `baseline`, `abstract` or `figure` (the lab calls figures `character`). | Manifest check; the picker |
| `version` | Semantic version of the character itself (§4.5). | Manifest check; stored with the choice |
| `contract` | The contract major version it was written against: `1`. | Host refuses a version it does not serve |
| `renderer` | What it draws with: `2d`, `webgl2`. | Host gives a `webgl2` character a canvas of its own; refuses a renderer it does not serve |
| `canvas` | How much of the page its canvas covers: `"box"` (omitted: the default, as before the field existed) or `"stage"` (§2.6). | Host gives a stage character a canvas of its own on the page's full-stage layer and `focus` each frame; refuses a value it does not serve |
| `modes` | One line per core mode. | Manifest check |
| `extraModes` | The extra modes it draws itself (§4.3), one line each. | Host's mode resolution |
| `mappings` | Signal → effect pairs. | Manifest check (the promises; shown in a future picker) |
| `options` | The settings it offers (§4.4). | Host validates stored values on every load; the admin's look editor renders a control for each (label, help, `group`, `unit`) |
| `uses` | The extensions (§4.2) its code reads from `frame.ext` today, each with what it gains and what it does without them. Only those: not an extension it might use one day (a design note says that), and none for a character that reads no extension. | Manifest check; the host will use it to decide what to produce once extensions exist |
| `create(canvas)` | Returns an instance with `resize`, `frame`, `dispose`. | Host |

## 4. Compatibility

The application is modular and will keep growing: new signals, the language model taking part in expression, new kinds of display. The requirement is simple to state:

> **Any character ever shipped keeps working, unchanged, in every later version of the application. Any new character works, with reduced richness, in a host that offers less than it would like.**

Both directions follow from four rules.

### 4.1 The contract only grows

Within a contract major version:

- A field of the frame is never removed, never renamed, and never changes meaning, unit or range. `level` is 0 to 1 perceived loudness for ever.
- New information is added only as an **extension** (§4.2), never as a new required field (the one exception, information every host has itself, is below).
- The five core modes never change meaning and are never removed. New modes may be added, but a character is only ever handed a mode it has declared it supports (§4.3).
- A host may give a character *more* than it asked for; a character must ignore what it does not know.
- The manifest may gain optional fields whose absence means exactly the old behaviour (`canvas`, §2.6).
- The core frame may gain a field only when every host can always supply it from its own knowledge (never from a server or a device that may lack it) and a character that never reads it is unaffected. `focus` (§2.6) is the one so far: every host knows where it put the character.

A change that cannot follow these rules is a new contract major version. The host then keeps an adapter that feeds the old frame shape to characters written for the old version. Adapters are the host's cost, never the character author's. Expect this to be rare; nothing foreseen in §5 needs it.

### 4.2 Core and extensions

The frame has two parts.

**Core**: mode, both voices' features, time, pointer, focus, reduced motion, palette, options. Every host supplies all of it, always. A character may depend on it without checking.

**Extensions**: everything else, each a named, versioned, optional block:

```ts
frame.ext: {
  readonly "speech.phonemes"?: { readonly v: 1; … }
  readonly "reply.expression"?: { readonly v: 1; … }
  …
}
```

- An extension is **absent** when the host does not have it: an older host, a voice engine that cannot produce it, a device that switched it off, or simply the moment before the data arrives.
- A character lists in `uses` exactly the extensions its code reads from `frame.ext`, no more (a `uses` entry asks the host to produce that data, so a false one costs work for nothing), and **must work without every one of them**, using the core signals instead. There is no such thing as a required extension. Lip sync without `speech.phonemes` falls back to the `mouth` estimate; expression without `reply.expression` falls back to neutral.
- A character checks the extension's `v` and treats a higher version it does not know as absent, unless the extension's own documentation says newer versions stay readable by older readers (they should: extensions grow by the rules of §4.1 too).
- A character never changes behaviour abruptly when an extension appears or disappears mid-conversation; it glides.

What this gives:

| | Old host (core only) | New host (core + extensions) |
|---|---|---|
| **Old character** (reads core) | works | works: ignores `ext` |
| **New character** (can use extensions) | works: falls back to core | works at full richness |

The host uses `uses` to decide what is worth producing: if the selected character does not use phoneme timings, the server is never asked for them. Extensions cost nothing when nobody wants them.

### 4.3 Modes: five for certain, more by opt-in

The five core modes are the floor: every character supports them and every host can drive a character with them alone. The set is open above that floor. New modes will come (the app's own asleep and muted states are the first; others, such as waiting for a confirmation or running a long tool, are likely), and adding one must not break a character written before it existed.

How that works:

- **Every mode beyond the core names its fallback**, which is a core mode or another mode that eventually reaches one: `asleep → idle`, `muted → idle`, `confirming → listening`. The fallback is part of the mode's definition and is recorded in the contract next to it.
- **A character declares the extra modes it draws** in its manifest, beside the five it must have.
- **The host hands a character only modes it declared.** For each frame the host takes the application's actual mode and walks the fallback chain until it reaches one the character supports. An old character therefore never sees a value it does not know; it sees the core mode, exactly as before the new mode existed.
- The frame carries both: `mode`, the resolved mode for this character, and `coreMode`, the core mode at the end of the chain. A character that only wants the broad state reads `coreMode` and never needs updating.
- **A mode is added for a state the person must be able to tell apart**, not for decoration. Section 2.1's warning applies: few states, each very different. A new mode needs a reason a person would care, a fallback, and at least one character that draws it.
- A mode's meaning never changes once defined, and a mode is never removed; a mode nobody uses any more simply stops being sent.

Modes say *what the assistant is doing*. They are not the place for *how it feels about it*: expression (warm, apologetic, emphatic) is a separate layer that sits on top of whatever mode is current, and arrives as an extension (§5.3). Keeping the two apart is what lets either grow without multiplying the other.

| | Host knows only core modes | Host knows more modes |
|---|---|---|
| **Character draws only core modes** | works | works: is handed the fallback |
| **Character draws extra modes** | works: those modes never occur | works: is handed them |

The app's extra modes are `asleep`, `muted`, `not-started`, `disconnected` and `error`, all falling back to `idle` (`EXTRA_MODES` in the contract). The application's visual state (`visualState` in `apps/web/src/lib/state.ts`) is exactly a `Mode`; `Visualiser.tsx` fails to compile if the two drift apart. The resolution is `resolveMode` in `runner.ts`. The baseline declares all five extra modes; the lab prototypes declare none.

### 4.4 Options

A character's settings are data: the character declares them, the host renders the controls, validates and stores the values. Validation is `apps/web/src/characters/options.ts` (from the lab); the host runs it on every load, and the admin's look editor runs it on every edit (see the end of this section).

Stored form, as an assistant's or a device's `look` holds it (`Look` in `packages/protocol/src/looks.ts`):

```json
{ "character": "flame", "version": "1.2.0", "options": { "size": 0.8, "style": "lantern", "sparks": false } }
```

Rules for the **host**, on every load:

- Unknown option ids in stored data are dropped silently (the character was downgraded, or the option was removed).
- Missing ids take the character's default (the character was upgraded).
- Values are validated against the current declaration: numbers clamped to the range and snapped to the step, choices not in the list replaced by the default, wrong types replaced by the default.
- A stored `character` id the host does not have falls back to the default character, and the stored data is kept untouched so that it works again when the character returns.
- The character always receives a complete, valid set. It never validates.

Rules for the **character author**:

- An option id never changes meaning. To change what an option does, add a new id and retire the old one.
- **A new option's default reproduces the look from before the option existed.** Upgrading a character must not change how it looks for someone who never touched its settings.
- Widening a range is fine. Narrowing one, or removing a choice, is fine only because the host clamps; make sure the clamped result is sensible.
- Options are tastes a person would tune, not internal constants. Three to eight per character. Every combination works, stays in the canvas and still shows five distinct modes.
- No option may switch off the thing that distinguishes a mode (for example the marks that make hearing differ from listening).
- Values glide when changed and snap under reduced motion.

**Reserved ids**, with fixed meaning across all characters, so settings carry over when the person switches character. A character need not offer them; when it does, it uses the kind below and a default that is the designed look (1 for a number, on for a toggle). `RESERVED_OPTIONS` in `options.ts`; the compatibility tests enforce it.

| id | Kind | Meaning |
|---|---|---|
| `size` | number | Overall size, 1 = designed size. |
| `speed` | number | Speed of ambient motion, 1 = designed speed. |
| `glow` | number, or toggle | Amount of glow or halo, 1 = designed; a toggle where the character has a single glow to switch (the baseline does). |
| `expressiveness` | number | Figures: size of nods, tilts, bounces, flinches. |
| `liveliness` | number | Figures: how often it blinks and shifts gaze. |
| `mouthRange` | number | Figures with a mouth: how far it opens. |
| `nods` | toggle | Figures: nods along at phrase ends. |
| `followsPointer` | toggle | Figures with eyes: gaze follows the pointer. |

**Where a person chooses and tunes a character: decided (docs/LOOKS-AND-VOICES.md).** A look (the stored form above) belongs to an **assistant** (`Assistant.look`, absent = the baseline), and a **device** or a device type's defaults can override it for every assistant (`DeviceSettings.look`, `{ from: "assistant" }` or `{ from: "device", look }`). The server resolves it into `device.setup`, and the voice page shows the look of the assistant holding the turn, else of the one its top bar names, else the device's own, else the baseline. It is edited in the admin: Assistants › an assistant › Look, and Devices › a device (or "Every browser") › Look; the editor renders each character's declared options (number → slider, toggle → switch, choice → segmented control or select, colour → theme colour or custom), validates every value with `options.ts` and stores only values that differ from their defaults, with the character's `version`. The old per-browser preference (`Prefs.character`) is no longer read; a stored one is dropped on the next write. Nothing in a character depends on where its settings are kept. To try a character, open the voice page with `?character=<id>` and any number of `&opt.<id>=<value>` (the lab's syntax; `opt.*` alone tunes the configured look): it wins over the configured look for this page load only, nothing is stored, and the parameters leave the address bar. Values from the address bar are kept as given (strings) and validated on load like any other.

Three settings belong to the host, not to any character, and apply to all: the person's colour, the assistant's colour, and sensitivity (a multiplier on loudness signals). A character must not duplicate them. They are stored next to the character's own options under the keys `$you`, `$voice` and `$sensitivity` (as in the lab). When the host falls back to the baseline it keeps these three and none of the failed character's own options.

### 4.5 Versions

- **Contract**: one integer. Raised only for a change §4.1 forbids. Characters declare the one they were written for; the host lists the ones it serves.
- **Extension**: one integer each (`v`). Raised when its shape changes in a way old readers cannot ignore.
- **Character**: semantic version. *Patch*: no visible change at default settings. *Minor*: new options or new use of an extension; defaults look the same. *Major*: the default look changes, and options may be added, removed or replaced under new ids (never an existing id with a new meaning, §4.4); prefer shipping a new character id instead, so nobody's stage changes under them.

### 4.6 Isolation and failure

- A character that fails to load, has an incomplete manifest, is written for a contract version or renderer the host does not serve, throws in `create`, `resize` or `frame`, or exceeds its frame budget persistently, is disposed and replaced by the baseline character (the sine lines) for the rest of the page's life, with one console warning. An unknown id in the choice also shows the baseline; the stored choice is never changed by the host. The conversation is never affected: audio does not depend on the stage.
- **Persistently** (`host.ts`): the mean `frame()` cost over a window of 120 measured frames, each frame counted at most 16 ms (so one long pause cannot do it), is above 4 ms (twice the 2 ms budget of §2.4) in 3 consecutive windows, about 6 s at 60 Hz. The first 30 frames after a character starts, after a resize and after the tab comes back from the background are not measured, and a return from the background starts the count again. The baseline is never stopped for its cost.
- A character is loaded on demand as its own chunk (4 to 9 KB gzipped each in the investigation; the registry's loaders are plain `import()`s, `scripts/build-characters.mjs`), so adding characters does not grow the page for people who do not use them. Whatever is on stage stays until the next character is ready (the baseline at page load); the swap happens inside one task, so there is no blank frame.
- The host reads the current state through `window.__pvaStage.debug()` (character on stage, its canvas area, size and pixel ratio, the focus, fallback and why, mean frame and feature cost), for tests and the console.
- A stage character's canvas is the host's: created on the page's full-stage layer (fixed, behind the page's content, no pointer events) when the character starts and removed when it stops, so switching between box and stage characters at run time leaves nothing behind; the box's canvas stays in the layout, hidden, as the focus placeholder. A stage character's pointer is read on the window, in its canvas's coordinates (`inside`: the pointer is in the window). The layout reads for `focus` happen before the character's frame is timed, so they never count against its budget.
- A character has no access to audio, the socket, storage or application state. It cannot slow the audio path, which is what the latency budget in `docs/ARCHITECTURE.md` protects.
- The baseline character is part of the host and has no extensions and no options that can fail. There is always something to fall back to.

## 5. Growing: where new capability plugs in

None of this is built. It is recorded so that when it is built, it goes in through §4 and breaks nothing.

### 5.1 The principle

New capability reaches characters **only as extensions and opt-in modes**. Nobody adds a parameter to `frame()`, a mode without a fallback, or a second entry point. If a new feature seems to need one of those, the feature's design is wrong or it is time for a contract major version, and that is a decision to make explicitly.

### 5.2 Foreseen extensions

| Extension | Source | Carries | Fallback without it |
|---|---|---|---|
| `speech.phonemes` | The voice engine (Piper can output per-phoneme sample counts; hosted engines offer viseme or character timestamps) | Mouth shapes with exact timing, aligned to played samples | The spectral `mouth` estimate |
| `speech.words` | Voice engine or the clause stream the client already receives | The word being spoken now | Syllable onsets |
| `reply.expression` | The language model (§5.3) | Expression and gesture cues timed to the reply | Neutral; core-driven motion only |
| `turn.activity` | The server's tool events, already sent to the client | What the assistant is doing while thinking (searching, running a tool) | Generic thinking |
| `hearing.direction` | A microphone array on a voice node | Where the voice comes from | None; pitch or nothing |
| `transcript.interim` | The interim transcript the client already receives | Words heard so far | Syllable onsets |

Rules for adding one:

1. Define it in the protocol package as an optional, versioned message or field that old clients ignore and old servers never send. A client that does not know a message type must drop it without error; verify this holds before relying on it.
2. Time it against **played audio** (sample position in the reply), not against arrival. Text and cues arrive before the sound they belong to; a face that reacts to text arrival is early.
3. It must never delay the reply. If producing it costs latency in the turn, it is produced beside the audio path and may arrive late or not at all, and characters cope because it is optional. Back any latency claim with `TurnTrace` numbers.
4. Only produce it when the selected character lists it in `uses`.
5. Document it here, with its fallback, before any character uses it.

### 5.3 When the language model takes part

The likely first step: the model marks its reply with a small set of cues (for example an expression per sentence, or an occasional gesture), which the server strips from the spoken text and sends as `reply.expression`.

- **A small closed vocabulary**, chosen for what characters can show (for example `neutral`, `warm`, `apologetic`, `curious`, `emphatic`), plus intensity. Not free text. The research is clear that many expressions blur together.
- **Every cue has a meaning an abstract character can use too**: a flame can burn warmer, a ring can soften. The vocabulary is about the reply, not about faces.
- **Unknown cues are ignored.** The vocabulary may grow; old characters treat a cue they do not know as `neutral`. New cues are therefore always safe to add.
- **Old characters keep working by construction**: they never read `ext`. New characters without the model (a different agent backend, the model not asked to produce cues, a provider that cannot) fall back to neutral.
- **It is the model's expression, stated as such.** Section 2.3 says no invented emotions: that rule is about characters deciding to emote on their own. A cue from the model is information about the reply and may be shown, within the calm and adult limits of §2.3.
- The same route serves later ideas: the model choosing a gesture, pointing at something on screen, a "did not understand" expression. Each is a new cue or a new extension, never a contract change.

### 5.4 New displays

A voice node with a small screen, an LED matrix or a light ring is a new **renderer** kind and a new host, not a new contract. The frame is the same. A character lists the renderers it supports; the dot-matrix prototype was drawn with this in mind (a 27 × 13 grid a device could show physically). A host offers the characters whose renderer it has.

## 6. Tests that keep the promise

Compatibility is kept by tests, not by intention. `apps/web/test/characters/compat.test.ts` runs the suite of `test/characters/support/compat.ts` against every character the registry finds, so a new character gets it by existing. The voices are the lab's formant synthesiser (`support/synth.ts`) played through the real feature extractor the way the host feeds it; the drawing goes to a recording fake canvas (`support/fakeCanvas.ts`: jsdom has none), which folds every call into a hash, so two runs can be compared exactly. Each run uses a freshly evaluated module, so per-page state (a figure's instance counter) starts the same. The numbered checks:

1. **Core only**: a scripted conversation with no `ext` and only the five core modes; each core mode pinned for 2 s. No throw, and the last frame differs between every pair of the five modes. It must also *paint*: in each mode the last frame makes a call that puts pixels on a canvas (2D `fill`, `stroke`, `fillRect`, `strokeRect`, `fillText`, `strokeText`, `drawImage`, `putImageData`; WebGL `draw*`), and what it paints (the paint calls, the calls before them, and the state each paint is made with) differs between every pair of modes; clearing, and state set after the last paint, do not count. `test/characters/compatChecks.test.ts` proves this on a character that only clears and on one whose modes differ only in unused state.
2. **Extra modes**: every mode of `EXTRA_MODES` pinned: it draws, and one the character did not declare draws exactly what its fallback draws.
3. **The unknown**: an extension name that does not exist and known-looking names with a version far too high, present throughout and then coming and going: no throw, and output equal to the core-only run. (There are no known extensions yet, so "every known extension present" is not tested; add it with the first extension.)
4. **Options**: every option at minimum and at maximum together (host-level settings included) at the smallest cell, the largest stage and a 2× stage; every choice value; garbage stored values: validation gives a complete set and the character runs.
5. **Reduced motion**: each core mode pinned with silent input: two frames a second apart are identical.
6. **Defaults are stable**: a digest of the drawing calls every 0.5 s of the conversation at default settings, in both themes, plus how far solid drawing reaches past the canvas edge at the three sizes, is stored per character in `test/characters/__snapshots__/<id>.digest` (written on the first run; a change must be deliberate: check the look, then update with `-u`). These runs give no focus (the runner uses the whole canvas), exactly as before stage characters existed. A stage character's digest adds `stage` lines: the conversation on the desktop stage (1280 × 800, focus 720 × 240 at 280, 200) and where its solid drawing reached.
7. **Manifest**: the checks of `manifest.ts` (id equals the file name, version is semver, contract is served, extra modes exist, `uses` entries complete, options valid, reserved ids with their kind and default).
8. **Cost**: the mean `frame()` time over the conversation on the recording canvas stays under 20 ms. This only catches pathological cost; the real budget (2 ms, §2.4) is measured in the page (`window.__pvaStage.debug().frameMs`). No allocation per frame is not asserted.
9. **The whole stage** (stage characters only; a box character passes trivially): the conversation on a desktop stage (1280 × 800, focus 720 × 240 at 280, 200) and a phone stage (390 × 844 at ratio 2, focus 358 × 160 at 16, 240) with no throw; for 2D, the solid drawing over the conversation is centred inside the focus or surrounds it (a character lighting the screen's edge); the five core modes differ on the stage, also in what they paint; a focus that moves and changes size every frame; every option at its extremes with the moving focus.
10. **Tiny and off-canvas**: the conversation on a 1 × 1 canvas (at ratio 1 and 2) and, for a stage character, with a 1 × 1 focus, with a 1 × 1 canvas and focus, and with the focus partly above the desktop and phone stages (negative `y`): no throw, and no 2D geometry call given a non-finite number (a browser silently skips those). The fake canvas throws where a browser does: `arc`, `arcTo`, `ellipse` and `createRadialGradient` an `IndexSizeError` for a negative radius, `roundRect` a `RangeError` for negative radii, in every check.

Also: `test/characters/isolation.test.ts` checks that files under `library/` and `shared/` import only the contract, the kit and the shared modules and name no page or network globals (in the code, including inside a template literal's `${…}`, not in comments or string text); `host.test.ts` covers loading, swapping, mode resolution, option validation on load, every fallback, and the stage: the canvas on the layer, its size and backing-store cap, focus following the box without a resize, the window pointer, switching between box and stage characters both ways, falling back on the stage, and a stage character without a layer; `baseline.test.ts` checks the baseline's look in every visual state.

Run against the 18 lab prototypes (wrapped with a version and contract) before they were ported, every check passes except (5) for aurora-ribbons (listening), cloud-orb (idle; the WebGL fake records its uniforms, so it may be a time uniform the shader ignores) and pitch-ink (listening; by design its pen keeps writing under reduced motion). Drawing past the canvas edge, recorded in (6), is 0 to 2 px for most, and up to 11 px (pitch-ink, light-ring at the small cell), 40 px (liquid-blob, light-ring on the large stage), 209 px (flame's sparks) and 304 px (particle-sphere's particles) at default settings: these are recorded, not judged, because particles and sparks may leave the frame on purpose, and a bounding box of path points cannot tell a visible overflow from one that fades out.

A contract change is accepted only when the full set of existing characters passes 1, 4, 6 and 8 without being edited.

## 7. Adding a character: the short version

1. Read §2 and look at the prototypes in the lab for the family closest to your idea.
2. Add one file, `apps/web/src/characters/library/<id>.ts`, default-exporting the `Character` (manifest and `create`). It may import `../contract.ts`, `../kit.ts` and `../shared/*.ts`, nothing else. Use only the core frame first. That file is the whole registration: `scripts/build-characters.mjs` lists the library before dev, build, check and test.
3. Make the five modes read from stills in both themes. Then make voices tellable. Then add options.
4. Add optional extension support last, each with its fallback.
5. Run the tests: `pnpm --filter @pva/web exec vitest run test/characters/compat.test.ts -t '"<id>"'`. The first run writes `test/characters/__snapshots__/<id>.digest`; commit it with the character. Then `pnpm check` and `pnpm test`.
6. Look at it in the app (`pnpm --filter @pva/web dev:mock`, then `?character=<id>` on the voice page, or pick it on an assistant's Look tab in the admin, where its options appear as controls; the README in `apps/web/src/characters/` has the recipe for every visual state and for screenshots), and run the checklist (§2.5).
7. Add it to the list below.

## 8. Characters

| id | Family | Since | Notes |
|---|---|---|---|
| `sine-lines` | baseline | 1.0.0 | The default and the fallback; bundled with the host; draws every extra mode. 1.1.0: a stage character (lines keep the box's width, swing up to a quarter of the box's height, at least 48 px, past it at full voice). 1.1.1: under reduced motion the shape is held (amplitude in thirds and line weights step to the voice at most once a second) instead of gliding; the default look is unchanged. |

The 18 prototypes and the recommendation of which to build first are in `docs/research/visualiser-investigation/README.md`.
