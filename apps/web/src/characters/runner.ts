/**
 * One instance of one character on one canvas: builds the `Frame` the contract promises and calls the character.
 * The host (`host.ts`) wraps this with the animation loop, the audio and the failure handling; the compatibility
 * tests drive it directly with scripted audio, so what they test is what the page runs.
 *
 * Per frame the runner resolves the application's mode for this character (§4.3), keeps `prevMode` and
 * `modeAge`, applies the host-level settings (recolouring, sensitivity) and passes the character's own options,
 * validated on every `setStored` (§4.4). It allocates nothing per frame.
 */
import {
  BAND_COUNT,
  CORE_MODES,
  type Character,
  type CharacterInstance,
  type CoreMode,
  EXTRA_MODES,
  type ExtraMode,
  type Frame,
  type FrameExtensions,
  type Mode,
  type OptionValues,
  type Palette,
  type Pointer,
  type VoiceFeatures
} from "./contract.ts"
import { createVoiceFeatures } from "./features.ts"
import { recolour, resolveAll, type ResolvedOptions, scaleFeatures } from "./options.ts"

const isCore = (m: string): m is CoreMode => (CORE_MODES as ReadonlyArray<string>).includes(m)

/**
 * The mode `character` is handed for the application's `mode`: the mode itself if it is core or declared in
 * `extraModes`, else its fallback, walked until one is (every chain ends at a core mode).
 */
export const resolveMode = (mode: Mode, extraModes: Character["extraModes"]): Mode => {
  let m: Mode = mode
  for (let i = 0; i < 16; i++) {
    if (isCore(m)) return m
    if (extraModes !== undefined && Object.hasOwn(extraModes, m)) return m
    m = EXTRA_MODES[m as ExtraMode] as Mode
  }
  return "idle"
}

/** The core mode at the end of `mode`'s fallback chain. */
export const coreOf = (mode: Mode): CoreMode => resolveMode(mode, undefined) as CoreMode

const NO_EXTENSIONS: FrameExtensions = Object.freeze({})

export interface StepInput {
  /** The application's mode (any `Mode`); the runner resolves it for this character. */
  readonly mode: Mode
  /** Seconds since the previous frame; clamped to 0.1. */
  readonly dt: number
  readonly user: VoiceFeatures
  readonly agent: VoiceFeatures
  readonly palette: Palette
  readonly reducedMotion: boolean
  readonly pointer: Pointer
  readonly sinceInterrupt: number
  readonly ext?: FrameExtensions
}

export class Runner {
  readonly character: Character
  readonly canvas: HTMLCanvasElement
  private instance: CharacterInstance | null = null
  private resolved: ResolvedOptions
  private version = 0
  private readonly frameObj: Frame
  private readonly userView: VoiceFeatures = createVoiceFeatures()
  private readonly agentView: VoiceFeatures = createVoiceFeatures()
  private readonly userBands = new Float32Array(BAND_COUNT)
  private readonly agentBands = new Float32Array(BAND_COUNT)
  private basePalette: Palette | null = null
  private paletteVersion = -1
  private started = false

  constructor(character: Character, canvas: HTMLCanvasElement, stored: OptionValues | undefined) {
    this.character = character
    this.canvas = canvas
    this.resolved = resolveAll(character.options, stored, ++this.version)
    const silent = this.userView
    this.frameObj = {
      t: 0,
      dt: 0,
      mode: "idle",
      coreMode: "idle",
      prevMode: "idle",
      modeAge: 0,
      user: silent,
      agent: silent,
      active: silent,
      pointer: { x: 0, y: 0, down: false, inside: false },
      reducedMotion: false,
      palette: undefined as unknown as Palette, // set on the first step
      options: this.resolved.values,
      sinceInterrupt: Infinity,
      ext: NO_EXTENSIONS
    }
  }

  /** The validated options (the character's own and the host-level ones). */
  get options(): ResolvedOptions {
    return this.resolved
  }

  /** New stored values (a changed choice): validated against the current declaration, applied from the next frame. */
  setStored(stored: OptionValues | undefined): void {
    this.resolved = resolveAll(this.character.options, stored, ++this.version)
  }

  /** May throw (the character's `create`). */
  create(): void {
    this.instance = this.character.create(this.canvas)
  }

  /** Size the canvas (device pixels) and tell the character (CSS pixels). May throw. */
  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.max(1, Math.round(width * dpr))
    this.canvas.height = Math.max(1, Math.round(height * dpr))
    this.instance?.resize(width, height, dpr)
  }

  /** Build the frame and draw it. May throw (the character's `frame`). */
  step(input: StepInput): void {
    const inst = this.instance
    if (inst === null) return
    const f = this.frameObj
    const dt = Math.min(0.1, Math.max(0, input.dt))
    const mode = resolveMode(input.mode, this.character.extraModes)
    if (!this.started) {
      this.started = true
      f.mode = mode
      f.prevMode = mode
      f.modeAge = 0
    } else if (mode !== f.mode) {
      f.prevMode = f.mode
      f.mode = mode
      f.modeAge = 0
    } else f.modeAge += dt
    f.t += dt
    f.dt = dt
    f.coreMode = coreOf(mode)
    const o = this.resolved
    if (input.palette !== this.basePalette || o.version !== this.paletteVersion) {
      this.basePalette = input.palette
      this.paletteVersion = o.version
      f.palette = recolour(input.palette, o.you, o.voice)
    }
    if (o.sensitivity === 1) {
      f.user = input.user
      f.agent = input.agent
    } else {
      scaleFeatures(input.user, this.userView, this.userBands, o.sensitivity)
      scaleFeatures(input.agent, this.agentView, this.agentBands, o.sensitivity)
      f.user = this.userView
      f.agent = this.agentView
    }
    f.active = f.coreMode === "speaking" ? f.agent : f.user
    const p = f.pointer
    p.x = input.pointer.x
    p.y = input.pointer.y
    p.down = input.pointer.down
    p.inside = input.pointer.inside
    f.reducedMotion = input.reducedMotion
    f.options = o.values
    f.sinceInterrupt = input.sinceInterrupt
    f.ext = input.ext ?? NO_EXTENSIONS
    inst.frame(f)
  }

  /** Release the instance. Never throws. */
  dispose(): void {
    const inst = this.instance
    this.instance = null
    try {
      inst?.dispose()
    } catch {
      // a failing dispose must not stop the stage
    }
  }
}
