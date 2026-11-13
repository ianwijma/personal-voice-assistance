export interface AgcOptions {
  /** Peak level the envelope is brought to. Default -12 dBFS. */
  readonly targetDbfs?: number
  /** Default 30 dB. */
  readonly maxGainDb?: number
  /** The gain does not change while the peak envelope is below this. Default -48 dBFS. */
  readonly minPeakDbfs?: number
  /** The estimated noise floor is never raised above this (RMS). Default -50 dBFS. */
  readonly noiseCeilingDbfs?: number
  readonly releaseSeconds?: number
  readonly riseDbPerSecond?: number
  readonly frameSamples?: number
}

export interface Agc {
  /** One frame of 16 kHz float samples, changed in place. */
  readonly process: (frame: Float32Array) => void
  readonly gainDb: () => number
  readonly noiseFloorDbfs: () => number
  readonly reset: () => void
}

export declare const makeAgc: (options?: AgcOptions) => Agc
