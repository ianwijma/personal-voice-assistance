# Characters

How to design and build the thing on the voice stage that shows the assistant is listening, thinking and speaking, and the rules that keep every character working as the application grows.

This is a living document. Update it whenever a character is added, the contract gains something, or a rule turns out wrong. The investigation that produced the first set of characters is in `docs/research/visualiser-investigation/` (findings, prior art and a runnable lab with 19 prototypes); this document holds what should outlast it.

**Status (2026-11-16).** The contract described here exists as a prototype in the lab (`docs/research/visualiser-investigation/lab/src/contract.ts`), where a character is called a *design*. The app itself still draws the three sine lines of `apps/web/src/lib/visualiser.ts`. Sections 3 to 5 are the rules the app's implementation must follow; where the lab already does something, it says so, and where it does not yet, it says "not built".

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
- **Any size** from a 160 × 140 cell to a 900 × 420 stage, and stay inside the canvas at every size and setting.
- **Transparent canvas.** Captions and overlays are drawn by the host on top; leave them room or stay out of the lower third.
- **Works with nothing but the core frame** (§4.2). This is the rule the whole compatibility story rests on.

### 2.5 Checklist before a character is accepted

1. Screenshots of the five modes in both themes: can someone who has never seen it name each?
2. Screenshots under whisper, normal, shouting; deep and high voice; slow and fast speech: are they tellably different?
3. Reduced-motion screenshots of the five modes.
4. Smallest and largest canvas; every option at both extremes together.
5. Measured frame cost at the heaviest settings.
6. The compatibility tests of §6 pass.
7. Manifest complete and exact: modes, mappings, options with help text, `uses`.

## 3. The manifest

What a character declares about itself. In the lab this is the `Design` object.

| Field | Meaning | Lab |
|---|---|---|
| `id` | Stable kebab-case identifier. Never reused for a different character. Stored in device profiles. | yes |
| `name`, `summary`, `inspiredBy` | For the picker. | yes |
| `family` | `abstract` or `figure` (the lab calls figures `character`). | yes |
| `version` | Semantic version of the character itself (§4.5). | not built |
| `contract` | The contract major version it was written against, e.g. `1`. | not built |
| `renderer` | What it draws with: `2d`, `webgl2`. A host skips renderers it does not offer. | yes |
| `modes` | One line per mode it draws: the five core modes always, plus any extra modes it opts into (§4.3). | core modes only |
| `mappings` | Signal → effect pairs. | yes |
| `options` | The settings it offers (§4.4). | yes |
| `uses` | Optional inputs it can take advantage of (§4.2), each with what it does without them. | as free text (`serverNeeds`) |
| `create(canvas)` | Returns an instance with `resize`, `frame`, `dispose`. | yes |

## 4. Compatibility

The application is modular and will keep growing: new signals, the language model taking part in expression, new kinds of display. The requirement is simple to state:

> **Any character ever shipped keeps working, unchanged, in every later version of the application. Any new character works, with reduced richness, in a host that offers less than it would like.**

Both directions follow from four rules.

### 4.1 The contract only grows

Within a contract major version:

- A field of the frame is never removed, never renamed, and never changes meaning, unit or range. `level` is 0 to 1 perceived loudness for ever.
- New information is added only as an **extension** (§4.2), never as a new required field.
- The five core modes never change meaning and are never removed. New modes may be added, but a character is only ever handed a mode it has declared it supports (§4.3).
- A host may give a character *more* than it asked for; a character must ignore what it does not know.

A change that cannot follow these rules is a new contract major version. The host then keeps an adapter that feeds the old frame shape to characters written for the old version. Adapters are the host's cost, never the character author's. Expect this to be rare; nothing foreseen in §5 needs it.

### 4.2 Core and extensions

The frame has two parts.

**Core**: mode, both voices' features, time, pointer, reduced motion, palette, options. Every host supplies all of it, always. A character may depend on it without checking.

**Extensions**: everything else, each a named, versioned, optional block:

```ts
frame.ext: {
  readonly "speech.phonemes"?: { readonly v: 1; … }
  readonly "reply.expression"?: { readonly v: 1; … }
  …
}
```

- An extension is **absent** when the host does not have it: an older host, a voice engine that cannot produce it, a device that switched it off, or simply the moment before the data arrives.
- A character lists the extensions it can use in `uses` and **must work without every one of them**, using the core signals instead. There is no such thing as a required extension. Lip sync without `speech.phonemes` falls back to the `mouth` estimate; expression without `reply.expression` falls back to neutral.
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

The lab has only the five core modes.

### 4.4 Options

A character's settings are data: the character declares them, the host renders the controls, validates and stores the values. Built in the lab (`lab/src/options.ts`, `optionStore.ts`).

Stored form, as it will go into a device profile:

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

**Reserved ids**, with fixed meaning across all characters, so settings carry over when the person switches character:

| id | Meaning |
|---|---|
| `size` | Overall size, 1 = designed size. |
| `speed` | Speed of ambient motion, 1 = designed speed. |
| `glow` | Amount of glow or halo. |
| `expressiveness` | Figures: size of nods, tilts, bounces, flinches. |
| `liveliness` | Figures: how often it blinks and shifts gaze. |
| `mouthRange` | Figures with a mouth: how far it opens. |
| `nods` | Figures: nods along at phrase ends. |
| `followsPointer` | Figures with eyes: gaze follows the pointer. |

**Where a person chooses and tunes a character is not decided.** The admin UI is being reorganised around assistants and devices (`docs/ASSISTANTS.md`, in progress on its own branch), and a character most likely belongs to an assistant, with a device able to override it. Until that lands there is no settings page for characters: the choice is a per-browser preference, and the stored form above is what any later settings page will read and write. Nothing in a character depends on where its settings are kept.

Three settings belong to the host, not to any character, and apply to all: the person's colour, the assistant's colour, and sensitivity (a multiplier on loudness signals). A character must not duplicate them.

### 4.5 Versions

- **Contract**: one integer. Raised only for a change §4.1 forbids. Characters declare the one they were written for; the host lists the ones it serves.
- **Extension**: one integer each (`v`). Raised when its shape changes in a way old readers cannot ignore.
- **Character**: semantic version. *Patch*: no visible change at default settings. *Minor*: new options or new use of an extension; defaults look the same. *Major*: the default look or an option's meaning changes; prefer shipping a new character id instead, so nobody's stage changes under them.

### 4.6 Isolation and failure

- A character that throws, or that exceeds its frame budget persistently, is stopped and replaced by the baseline character (the sine lines). The conversation is never affected: audio does not depend on the stage. The lab already isolates failures per instance.
- A character is loaded on demand as its own chunk (4 to 9 KB gzipped each in the investigation), so adding characters does not grow the page for people who do not use them.
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

Compatibility is kept by tests, not by intention. For every character in the application (not built; the lab has the option validation tests and per-design visual checks):

1. **Core only**: run a scripted conversation with no `ext` and only the five core modes. It must not throw and must draw something different in each of the five modes.
2. **Everything**: the same with every known extension present.
3. **The unknown**: an extension name that does not exist, a known extension with a version one higher than known, and an application mode the character did not declare (the host must hand it the fallback). Output must equal the core-only run.
4. **Appearing and disappearing**: extensions that come and go mid-reply. No throw.
5. **Options**: every option at minimum and maximum, all together; stored values from every earlier version of the character, plus garbage, go through the host's validation and produce a working character.
6. **Defaults are stable**: a recording of the drawing calls at default settings, compared against the previous release of the same character version line. This is how the investigation proved that adding options changed nothing by default.
7. **Budget**: mean frame time at the heaviest settings under 2 ms.

A contract change is accepted only when the full set of existing characters passes 1, 5, 6 and 7 without being edited.

## 7. Adding a character: the short version

1. Read §2 and look at the prototypes in the lab for the family closest to your idea.
2. Write one file exporting the manifest and `create`. Use only the core frame first.
3. Make the five modes read from stills in both themes. Then make voices tellable. Then add options.
4. Add optional extension support last, each with its fallback.
5. Run the checklist (§2.5) and the tests (§6). Register it with one line.
6. Add it to the list below.

## 8. Characters

None in the application yet beyond the baseline sine lines. The 18 prototypes and the recommendation of which to build first are in `docs/research/visualiser-investigation/README.md`.
