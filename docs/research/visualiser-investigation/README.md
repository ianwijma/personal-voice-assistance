# Visualiser investigation

*2026-11-16. Research, not product: nothing here is wired into the application.*

**Question.** The voice stage shows three sine lines while the assistant listens and speaks. What else could it show? The owner asked for at least ten animated designs, some abstract (orbs, light) and some more human (a face), inspired by Siri and ChatGPT's voice mode among others, each reacting visibly to different voices and loudness, ideally with no extra server resources, and each customisable.

**Outcome.** 18 new designs plus the current sine lines as a baseline, all running in one self-contained page with simulated voices, a reaction matrix and a settings panel per design. None needs the server. The durable rules that came out of it are in [`docs/CHARACTERS.md`](../../CHARACTERS.md); this directory keeps the evidence.

## What is here

| Path | What |
|---|---|
| `visualiser-lab.html` | The built lab. Open it in a browser; no server, no network, no microphone needed. |
| `lab/` | Its source: the contract, the voice analysis, the voice simulator, the designs, the settings panel, the screenshot script. `lab/README.md` explains how to build and add to it. |
| `lab/src/priorArt.ts` | The survey of 45 products, techniques and studies, with sources. Shown at the bottom of the lab page. |
| `lab/src/designs/` | One file per design. |

Build and look: `pnpm lab`, then open `docs/research/visualiser-investigation/visualiser-lab.html`. Click a design for its large view, the live signal readout, the reaction matrix (modes, loudness, voice register, delivery, assistant speaking) and the Customise panel.

## How it was done

1. A contract was written first (`lab/src/contract.ts`): a design is a pure drawing module that receives one frame per tick with the conversation mode and the voice features of both sides.
2. A harness was built around it: a feature extractor, a formant speech simulator so the page animates without a microphone, a conversation loop, a gallery, and per-design cost measurement.
3. Prior art was surveyed in parallel, from primary sources where possible.
4. Three designers each built six designs (light, matter, figures), checking their own work from screenshots across modes, voices and both themes.
5. Options were added: a declaration per design, a generated settings panel, and three settings that apply to every design.

## Findings

### No server is needed

Everything the designs react to is computed in the browser from audio the client already has: microphone frames and the reply player's output.

- The extractor (`lab/src/features.ts`: own FFT, YIN pitch, onset detection, a mouth-shape estimate) costs about 0.05 ms per call, measured in Node at 16 kHz and 48 kHz.
- On the simulated voices it reports loudness of about 0.07 for a whisper, 0.39 for normal speech and 0.76 for shouting, and median pitch of 99, 157, 231 and 314 Hz for the deep, mid, high and child voices.
- Syllable rate reads low: about 2.5, 3.3 and 4.3 per second for slow, normal and fast speech, where the true rates are nearer 2, 4 and 6. The order is right; onset detection catches 70 to 85 % of simulated syllables.

The one server addition worth considering later is exact phoneme timing from the voice engine for lip sync (see below).

### Cost

Mean `frame()` time at the 900 × 420 stage, in headless Chromium without a GPU. The application's budget is 2 ms.

| Design | Default | Heaviest settings |
|---|---|---|
| Most designs | 0.03 to 0.5 ms | about the same |
| Particle sphere | about 0.46 ms | 0.52 to 0.59 ms |
| Chladni sand | 0.6 to 0.8 ms | 1.0 to 1.44 ms |
| Dot matrix | 0.16 ms | 0.25 to 0.28 ms (fine grid) |

Caveats: the machine was under load during measurement; worst-frame figures spike to several milliseconds for every design including the baseline, which points to the environment. The cloud orb is the one WebGL design: its CPU side is under 0.1 ms, but its shader was only run in software, where a page with six of them drops to about 16 fps. It has not been run on a real GPU.

Code size, bundled alone and gzipped: 4 to 5 KB for a typical abstract design, 7 to 9 KB for a figure (they carry the shared listening model), 3.2 KB for the extractor. The baseline is 2.5 KB.

### What the survey says

Full entries with sources are in the lab page. The points that shaped the designs:

- **One shape through all phases.** Nearly every product keeps a single element and changes how it moves. Amazon's developer guidance calls it an attention system whose states change together with the sound cues.
- **Loudness is the only driver with first-party documentation** for a shipping product (Amazon: wider pulses for louder speech). Pitch is stated by Meta's motion studio; speaking speed by a Google patent; a 24-band spectrum ships as a default in Hume's SDK. Nothing public says how ChatGPT's, Gemini's or Claude's orbs are driven.
- **The "alive" look of the multicolour Siri wave** comes from curves appearing and fading at random under a single amplitude value, per the open-source reverse engineering, not from rich analysis.
- **Direction separates listening from speaking** in the clearest designs: inward when taking in, outward when responding (Meta), or pointing at the speaker (Alexa).
- **Split what each side controls**: in the open-source ElevenLabs orb the person's loudness changes size and the assistant's changes how fast the inside flows.
- **Faces add social attention and new ways to fail.** Nods timed to the speaker's pauses and pitch built rapport as well as a human listener; random nods did worse (USC Rapport Agent). Movement deepens the uncanny valley, so stay clearly stylised. Many expressions blur together.
- **Light patterns are widely misread**: about 37 % identified correctly in a study of smart-speaker users. Few states, each very different.
- **Reduced motion**: audio-reactive motion counts as motion under WCAG 2.3.3.
- **Phone design is moving to the screen edge** (Apple, Gemini Live), and ChatGPT made its orb opt-in in favour of the transcript.

Asked about but not confirmed, so left out or marked: how ChatGPT's and Claude's orbs are rendered or driven; per-state behaviour of Apple's edge glow; Alexa+'s speaking indicator; the visuals of Pi, Sesame's demo, Tesla's Grok and Mycroft Mark II; the lip-sync method of Grok's companions, Razer's Project AVA and Replika.

### The designs

**Abstract**

| Design | What it is | Strongest at | Weak at |
|---|---|---|---|
| Aurora ribbons | Translucent lenses along a horizon, one per syllable | Loudness, voice | Thinking mode; thin at small sizes |
| Edge glow | Light on the stage border; centre free for captions | Leaves room for text | Voice differences subtle when small |
| Cloud orb (WebGL) | Churning sphere; person sets size, assistant sets flow | Modes | Unmeasured on a GPU |
| Dot quartet | Four dots that become bars and orbit | Legible at every size | Plain; delivery |
| Light ring | Bright arc sits at the person's pitch | Voice register in a still | Delivery; assistant loudness |
| Twin lights | Two lights; each syllable flies from speaker to listener | Whose turn, direction, pace in one still | Assistant loudness |
| Liquid blob | Glossy drop dented by the voice | Voice | Hearing against listening |
| Particle sphere | Points spiral in to listen, fly out to speak | Modes, loudness | Voice |
| Pitch ink | A pen writing each voice's melody on two staves | The only one showing intonation; keeps a trace | Thinking; reduced motion |
| Ripple pond | Rings converge to listen, spread to speak | Modes, loudness, voice | Busy while speaking |
| Flame | Pilot light, tall flame, flicker, ember, fire | Every mode a different silhouette | Delivery |
| Chladni sand | Sand on a vibrating plate; pitch picks the figure | Voice | Most expensive; loud looks messy |

**Figures**

| Design | What it is | Strongest at | Weak at |
|---|---|---|---|
| Line face | Comic-strip face with sound marks | Lip sync reads well | Question tilt subtle when small |
| Robot eyes | Eyes only, rim light in the speaker's colour | Modes, whisper and shout | Voice, delivery |
| Lips | Mouth shapes; sealed with the waveform on the seam while listening | Best lip sync; original listening idea | Some may find a mouth too bodily |
| Blob buddy | Soft creature with squash and stretch | Calm; loudness reactions | Small mouth, coarse lip sync |
| Profile head | Sound enters the ear, links up inside, leaves the mouth | Tells the whole story literally | Looks a little like a mannequin |
| Dot matrix | Face on an LED grid a voice node could show | Pitch readable in a still | Coarse mouth |

The figures share one listening model (`lab/src/designs/_character.ts`): a nod 0.25 to 0.37 s into the pause after a phrase, a tilt instead when the phrase ended rising, a lean in for a whisper, a flinch at a shout that wears off, and a bounce per spoken syllable.

**Common weaknesses.** Delivery (slow, fast, questions) is the least visible difference in most designs; loudness and register read clearly. Spectral lip sync never fully closes the mouth, because m, b and p cannot be seen in the spectrum.

### Customisation

Every design declares 7 or 8 options (the baseline 5), rendered as a generated panel; values are validated, stored per design, mirrored in the URL, and exported as the JSON a device profile would hold. Three settings apply to every design from the harness: the person's colour, the assistant's colour, and sensitivity. Figures share five personality options with the same ids. Adding options changed nothing at default settings: for the figures this was verified by recording every canvas call of old and new code over the same 40 s conversation and comparing; for five of the six matter designs by pixel comparison of still modes.

Known rough extremes: edge glow at maximum depth, light ring at maximum spectrum detail, pitch ink with brush on the slowest paper at maximum zoom, a subtle flame tint. Changing edge glow's depth or corner roundness causes a one-off pause of 5 to 7 ms when the value settles.

## Not verified

- Real microphone input, audio-file input and the "hear it" monitor: everything ran on simulated voices.
- Pointer reactions (hover, press): implemented in most designs, not exercised.
- Gliding between option values: checked from code and recordings, mostly not watched.
- Any frame cost on real hardware, and the cloud orb on a GPU.
- The designs on a phone.

## Recommendation

Build first: **flame**, **light ring**, **pitch ink** and **twin lights** from the abstract set; **blob buddy** and **lips** from the figures. They were each designer's own strongest picks and held up when every design was compared across the five modes.

Before any of them goes into the application: the contract needs the additions in `docs/CHARACTERS.md` (versions, extensions, opt-in modes), the extractor needs to run on the real microphone frames and player output, and the unverified items above need a pass on real hardware.
