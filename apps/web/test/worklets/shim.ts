/**
 * A minimal AudioWorkletGlobalScope for running the worklet sources in Node:
 * `AudioWorkletProcessor` with a fake port, and the `sampleRate` / `currentTime` globals.
 * Import this before the worklet modules.
 */
export interface FakePort {
  onmessage: ((e: { data: unknown }) => void) | null
  readonly sent: Array<any>
  postMessage(message: unknown, transfer?: ReadonlyArray<unknown>): void
  /** Deliver a message to the processor, as the main thread would. */
  deliver(message: unknown): void
}

const makePort = (): FakePort => {
  const port: FakePort = {
    onmessage: null,
    sent: [],
    postMessage(message) {
      port.sent.push(message)
    },
    deliver(message) {
      port.onmessage?.({ data: message })
    }
  }
  return port
}

const g = globalThis as any
g.sampleRate = 48_000
g.currentTime = 0
g.AudioWorkletProcessor = class {
  readonly port: FakePort = makePort()
}

export const setSampleRate = (rate: number) => {
  g.sampleRate = rate
}
export const setCurrentTime = (t: number) => {
  g.currentTime = t
}
export const getCurrentTime = (): number => g.currentTime
