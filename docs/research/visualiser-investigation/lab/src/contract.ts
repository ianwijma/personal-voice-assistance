/**
 * Visualiser lab: the contract between the harness and the designs.
 *
 * A design is a pure drawing module. Each animation frame the harness hands it
 * one `Frame`: the conversation mode plus the voice features of both sides,
 * all computed in the browser from audio the client already has (microphone
 * frames and the reply player's output). No design may need anything else to
 * work; a design that could use more (word timings, phonemes) says so in
 * `serverNeeds` and still works without it.
 *
 * Designs never touch the DOM outside their canvas, never start their own
 * animation loop, and never read audio themselves.
 */

/** Conversation mode, the subset of the app's visual states the lab explores. */
export type Mode =
  /** Nobody is using the assistant. Calm, nearly still. */
  | "idle"
  /** Microphone open, waiting for the person to speak. Attentive. */
  | "listening"
  /** The person is speaking. Driven by `user`. */
  | "hearing"
  /** The assistant is working on the reply. No audio. */
  | "thinking"
  /** The assistant is speaking. Driven by `agent`. */
  | "speaking"

export const MODES: ReadonlyArray<Mode> = ["idle", "listening", "hearing", "thinking", "speaking"]

/** Number of spectrum bands in `VoiceFeatures.bands`. */
export const BAND_COUNT = 24
/** Number of samples in `VoiceFeatures.wave`. */
export const WAVE_SIZE = 256

/**
 * What the lab knows about one voice at one instant. Every value is already
 * lightly smoothed (attack about 30 ms, release about 150 ms unless noted) and
 * safe to use directly; a design may smooth further for its own feel.
 * The object and its arrays are reused between frames: copy what you keep.
 */
export interface VoiceFeatures {
  /** Perceived loudness, 0..1. About 0.1 for a whisper, 0.4 for normal speech, 0.75 and up for shouting. 0 in silence. */
  level: number
  /** Unsmoothed RMS of the latest window, 0..1 linear. */
  rms: number
  /** Voice activity, with a 250 ms hangover so it does not flicker between syllables. */
  speaking: boolean
  /** Seconds the current utterance has lasted (0 when not speaking). */
  speechFor: number
  /** Seconds since the voice last stopped (0 while speaking). */
  silenceFor: number

  /** How periodic the sound is, 0..1. Vowels are near 1; whispers, "s" and "f" near 0. */
  voicing: number
  /** Fundamental frequency in Hz, 0 when unvoiced. */
  pitchHz: number
  /** Pitch on a log scale, 0 (70 Hz, very deep) .. 1 (400 Hz, child or excited). Holds its last value through unvoiced gaps. */
  pitch: number
  /** Intonation: semitones per second, smoothed over about 200 ms. Positive is rising (a question), negative falling. */
  pitchDelta: number
  /** This speaker's running median `pitch` (adapts over a few seconds): the register of the voice, deep vs high. */
  register: number

  /** Log-spaced spectrum, 80 Hz .. 8 kHz, each 0..1. */
  bands: Float32Array
  /** Energy 80–300 Hz, 0..1. */
  low: number
  /** Energy 300–1500 Hz, 0..1. */
  mid: number
  /** Energy 1500–8000 Hz, 0..1. */
  high: number
  /** Spectral centroid, 0 (dark, "oo") .. 1 (bright, "ee", "s"). */
  brightness: number
  /** High-frequency noise, 0..1: peaks on "s", "sh", "f", "t". */
  sibilance: number

  /** Syllable onset: jumps to 1 when a syllable starts and decays to 0 in about 150 ms. */
  onset: number
  /** Syllables per second over the last 2 s: about 2 for slow speech, 4 normal, 6 and up fast. */
  syllableRate: number

  /**
   * A mouth-shape estimate from the spectrum (no phoneme data needed), each 0..1:
   * `open` is the jaw (loud open vowels like "ah"), `wide` spread lips ("ee"),
   * `round` rounded lips ("oo"). All near 0 in silence; `open` is small on consonants.
   */
  mouth: { open: number; wide: number; round: number }

  /** The latest time-domain window, −1..1, `WAVE_SIZE` samples, for oscilloscope-style drawing. */
  wave: Float32Array
}

export interface Pointer {
  /** Position inside the canvas in CSS pixels. */
  x: number
  y: number
  /** A button or finger is down. */
  down: boolean
  /** The pointer is over this canvas. */
  inside: boolean
}

export interface Frame {
  /** Seconds since the instance was created. */
  t: number
  /** Seconds since the previous frame, clamped to 0.1. */
  dt: number
  mode: Mode
  /** The mode before this one, for transitions. */
  prevMode: Mode
  /** Seconds since `mode` began. */
  modeAge: number
  /** The person (microphone). */
  user: VoiceFeatures
  /** The assistant (reply audio). */
  agent: VoiceFeatures
  /** Whichever side matters now: `agent` while speaking, otherwise `user`. */
  active: VoiceFeatures
  pointer: Pointer
  /** `prefers-reduced-motion`: no continuous motion, no flashes; state must still read from colour and shape. */
  reducedMotion: boolean
  /** The app's theme colours, current for this frame (dark or light). `you` and `voice` may have been recoloured by the viewer. */
  palette: Palette
  /**
   * The viewer's settings for this design: one value per entry of `Design.options`,
   * always complete (defaults filled in) and already validated against the spec.
   * May change between any two frames; glide to new values rather than jump where a jump would show.
   */
  options: OptionValues
}

interface OptionBase {
  /** Camel-case key in `Frame.options`, unique within the design. */
  readonly id: string
  /** Short label for the control, sentence case. */
  readonly label: string
  /** One plain sentence on what it changes, shown under the control. */
  readonly help?: string
  /** Optional heading the settings UI groups controls under, e.g. "Shape", "Reaction", "Colour", "Behaviour". */
  readonly group?: string
}

/**
 * One setting a design exposes. Options are what a person would want to tune to
 * their taste or their screen, never internal constants. Every combination of
 * values must give a design that still works and still shows the five modes.
 */
export type OptionSpec =
  | (OptionBase & { readonly kind: "number"; readonly min: number; readonly max: number; readonly step: number; readonly default: number; readonly unit?: string })
  | (OptionBase & { readonly kind: "toggle"; readonly default: boolean })
  | (OptionBase & { readonly kind: "choice"; readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string }>; readonly default: string })
  /** A colour: "#rrggbb", or a palette key that follows the theme and the viewer's recolouring ("you", "voice", "ink", "inkFaint"). */
  | (OptionBase & { readonly kind: "color"; readonly default: string })

export type OptionValues = { readonly [id: string]: number | boolean | string }

export type Rgb = readonly [number, number, number]

/** The app's colour tokens (globals.css) as 0..255 RGB. */
export interface Palette {
  readonly dark: boolean
  readonly bg: Rgb
  readonly surface: Rgb
  readonly line: Rgb
  readonly ink: Rgb
  readonly inkFaint: Rgb
  /** The person's colour (mint). */
  readonly you: Rgb
  /** The assistant's colour (amber). */
  readonly voice: Rgb
  readonly danger: Rgb
}

export interface DesignInstance {
  /**
   * The canvas changed size. `width` and `height` are CSS pixels; the harness
   * has already set `canvas.width/height` to those times `dpr`.
   */
  resize(width: number, height: number, dpr: number): void
  /** Draw one frame. Clear the canvas yourself (transparent; the page background shows through). */
  frame(frame: Frame): void
  /** Release everything (WebGL contexts, buffers). */
  dispose(): void
}

export interface Design {
  /** Kebab-case, equal to the file name. */
  readonly id: string
  readonly name: string
  readonly family: "baseline" | "abstract" | "character"
  /** One sentence: what it is. */
  readonly summary: string
  /** Products or ideas it draws on, in plain words. */
  readonly inspiredBy: string
  /** How each mode looks, one short line each, shown next to the design. */
  readonly modes: { readonly [M in Mode]: string }
  /** Which voice signal moves what, shown as a table. Be exact: these are the design's promises. */
  readonly mappings: ReadonlyArray<{ readonly signal: string; readonly effect: string }>
  /** "none", or what optional server data would improve it and how. */
  readonly serverNeeds: string
  /** "2d" designs get a fresh canvas and call getContext("2d") themselves; same for "webgl2". Declared so the harness can cap live WebGL contexts. */
  readonly renderer: "2d" | "webgl2"
  /** The settings this design exposes, read each frame from `Frame.options`. Omitted or empty: nothing to tune. */
  readonly options?: ReadonlyArray<OptionSpec>
  create(canvas: HTMLCanvasElement): DesignInstance
}

/** One product in the prior-art survey (src/priorArt.ts), shown in the lab. */
export interface PriorArt {
  readonly product: string
  readonly maker: string
  /** Years or versions this look applies to. */
  readonly era: string
  readonly form: "waveform" | "orb" | "dots-bars" | "edge-light" | "light-ring" | "particles" | "face" | "eyes" | "avatar" | "text" | "other"
  /** What it looks like and how it moves, concretely. */
  readonly look: string
  /** How listening, thinking and speaking differ. */
  readonly states: string
  /** What is known or reasonably inferred about what drives it (amplitude, spectrum, phonemes, scripted). Say which is which. */
  readonly drivenBy: string
  /** What is worth taking from it. */
  readonly takeaway: string
  readonly sources: ReadonlyArray<string>
}
