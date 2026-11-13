export interface PrerollFrame {
  readonly frame: Float32Array
  readonly index: number
  readonly speech: boolean
}

export declare class TurnAudio {
  constructor(options: { frameSamples?: number; maxFrames: number; graceFrames?: number; prerollFrames: number })
  readonly collecting: boolean
  readonly length: number
  readonly firstFrame: number
  push(frame: Float32Array, index: number, speech: boolean, preroll: () => ReadonlyArray<PrerollFrame>): Float32Array | undefined
  audio(): Float32Array
  audioThrough(atFrame: number): Float32Array
  speechAfter(atFrame: number): boolean
  commit(atFrame: number): void
  clear(): void
}
