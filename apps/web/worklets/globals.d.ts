// The AudioWorkletGlobalScope, which the DOM lib does not describe.
export {}

declare global {
  var sampleRate: number
  var currentTime: number
  var currentFrame: number
  class AudioWorkletProcessor {
    readonly port: MessagePort
    constructor(options?: unknown)
  }
  function registerProcessor(name: string, ctor: new (options?: any) => AudioWorkletProcessor): void
}
