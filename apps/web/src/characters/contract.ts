/**
 * Characters: the contract between the host and a character (docs/CHARACTERS.md).
 *
 * A character is a pure drawing module for the voice stage. Each animation
 * frame the host hands it one `Frame`; it draws on its own canvas and does
 * nothing else: no DOM outside the canvas, no animation loop of its own, no
 * audio, no network, no imports from the application (only this file,
 * `kit.ts` and the helpers in `shared/`).
 *
 * This is contract version 1. It only grows (docs/CHARACTERS.md §4): fields
 * never change meaning, new information arrives as optional extensions
 * (`Frame.ext`), and new modes are opt-in with a fallback. A character
 * written against this file must keep working unchanged in every later host.
 */

/** The contract major version this file describes. */
export const CONTRACT_VERSION = 1

/**
 * The five core modes. Every character draws all five, and every host can
 * drive a character with these alone. Their meaning never changes.
 */
export type CoreMode =
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

export const CORE_MODES: ReadonlyArray<CoreMode> = ["idle", "listening", "hearing", "thinking", "speaking"]

/**
 * Modes beyond the core, each with the mode it falls back to. A character
 * opts into the ones it draws (`Character.extraModes`); the host hands a
 * character only modes it declared, walking this chain otherwise, so a
 * character never sees a mode it does not know.
 *
 * Adding an entry here is always safe. An entry's meaning and fallback never
 * change, and entries are never removed.
 */
export const EXTRA_MODES = {
  /** Wake-phrase mode, waiting for the phrase: the microphone is open but nothing is sent on. */
  asleep: "idle",
  /** The person switched the microphone off. */
  muted: "idle",
  /** Nobody owns the audio on this device yet (before Start). */
  "not-started": "idle",
  /** The connection to the server is down; the client is retrying. */
  disconnected: "idle",
  /** A fatal client error (microphone failed, page out of date). */
  error: "idle"
} as const satisfies { readonly [mode: string]: string }

export type ExtraMode = keyof typeof EXTRA_MODES
/** Any mode the application can be in. */
export type Mode = CoreMode | ExtraMode

/** Number of spectrum bands in `VoiceFeatures.bands`. */
export const BAND_COUNT = 24
/** Number of samples in `VoiceFeatures.wave`. */
export const WAVE_SIZE = 256

/**
 * What the host knows about one voice at one instant. Every value is already
 * lightly smoothed (attack about 30 ms, release about 150 ms unless noted) and
 * safe to use directly; a character may smooth further for its own feel.
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
  /**
   * The mode to draw: a core mode, or an extra mode this character declared in
   * `extraModes`. Never a mode the character did not declare.
   */
  mode: Mode
  /** The core mode at the end of `mode`'s fallback chain. A character that only wants the broad state reads this. */
  coreMode: CoreMode
  /** The mode before this one (resolved the same way), for transitions. */
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
   * The viewer's settings for this character: one value per entry of `Character.options`,
   * always complete (defaults filled in) and already validated against the spec.
   * May change between any two frames; glide to new values rather than jump where a jump would show.
   */
  options: OptionValues
  /**
   * Seconds since the assistant's reply was last interrupted (the person spoke
   * over it or pressed Stop); `Infinity` if never. A character may collapse its
   * speaking look faster just after an interruption.
   */
  sinceInterrupt: number
  /**
   * Optional inputs beyond the core, by name (docs/CHARACTERS.md §4.2). An
   * entry is absent whenever the host does not have it; a character must work
   * with none of them. Ignore names and versions you do not know.
   */
  ext: FrameExtensions
}

/**
 * The extensions defined so far. None yet: the first ones foreseen
 * (`speech.phonemes`, `reply.expression`, …) are described in
 * docs/CHARACTERS.md §5.2 and are added here, each as an optional property
 * whose value carries its own version `v`.
 */
export interface FrameExtensions {
  readonly [name: string]: { readonly v: number } | undefined
}

interface OptionBase {
  /** Camel-case key in `Frame.options`, unique within the character. */
  readonly id: string
  /** Short label for the control, sentence case. */
  readonly label: string
  /** One plain sentence on what it changes, shown under the control. */
  readonly help?: string
  /** Optional heading the settings UI groups controls under, e.g. "Shape", "Reaction", "Colour", "Behaviour". */
  readonly group?: string
}

/**
 * One setting a character exposes. Options are what a person would want to tune to
 * their taste or their screen, never internal constants. Every combination of
 * values must give a character that still works and still shows the five modes.
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

export interface CharacterInstance {
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

/** The manifest and factory of one character. */
export interface Character {
  /** Stable kebab-case identifier, equal to the file name. Stored in settings; never reused for another character. */
  readonly id: string
  readonly name: string
  /** Semantic version of this character (docs/CHARACTERS.md §4.5). */
  readonly version: string
  /** The contract major version it was written against. */
  readonly contract: 1
  /** "abstract", or "figure" for faces, eyes and creatures. */
  readonly family: "baseline" | "abstract" | "figure"
  /** One sentence: what it is. */
  readonly summary: string
  /** Products or ideas it draws on, in plain words. */
  readonly inspiredBy: string
  /** How each core mode looks, one short line each. */
  readonly modes: { readonly [M in CoreMode]: string }
  /** The extra modes this character draws itself, with how each looks. Omitted: it is handed their fallbacks. */
  readonly extraModes?: { readonly [M in ExtraMode]?: string }
  /** Which voice signal moves what. Be exact: these are the character's promises. */
  readonly mappings: ReadonlyArray<{ readonly signal: string; readonly effect: string }>
  /**
   * Extensions this character can take advantage of, each with what it does
   * without them. All optional: the character works with none. The host uses
   * this to decide what is worth producing.
   */
  readonly uses?: ReadonlyArray<{ readonly ext: string; readonly gain: string; readonly without: string }>
  /** What it draws with. A host skips renderers it does not offer. */
  readonly renderer: "2d" | "webgl2"
  /** The settings this character exposes, read each frame from `Frame.options`. Omitted or empty: nothing to tune. */
  readonly options?: ReadonlyArray<OptionSpec>
  create(canvas: HTMLCanvasElement): CharacterInstance
}

/**
 * A character choice as it is stored (docs/CHARACTERS.md §4.4): what a device
 * profile or a browser preference holds. The host validates it on every load.
 */
export interface CharacterChoice {
  readonly character: string
  /** The character's version when the options were saved. */
  readonly version?: string
  readonly options?: OptionValues
}
