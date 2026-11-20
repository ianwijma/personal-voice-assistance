/**
 * Stand-in audio for the node's tests, through the same core contract the real backends implement: a microphone fed
 * by the test, and players that consume audio in real time (like a device) and record what they were given.
 */
import { AudioError, AudioInput, AudioOutput } from "@pva/core"
import { MIC_FRAME_SAMPLES, type NodeSoundDevices } from "@pva/protocol"
import { Cause, Context, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect"
import { NodeAudioInfo } from "../../src/audio.ts"
import { type NodeExit, runNode, type NodeRunOptions } from "../../src/node.ts"

export interface Play {
  readonly sampleRate: number
  /** Samples the player took so far. */
  pulled: number
  /** What the player was given, in order. */
  readonly chunks: Array<Uint8Array>
  outcome: "playing" | "finished" | "interrupted" | "failed"
}

/** A player that takes each chunk and then waits its duration (divided by `speed`), as a device draining a buffer. */
export const makeFakeOutput = (speed = 1) => {
  const plays: Array<Play> = []
  const output = AudioOutput.of({
    play: (audio, sampleRate) =>
      Effect.suspend(() => {
        const play: Play = { sampleRate, pulled: 0, chunks: [], outcome: "playing" }
        plays.push(play)
        return Stream.runForEach(audio, (chunk) => {
          play.pulled += chunk.length >> 1
          play.chunks.push(chunk)
          return Effect.sleep(((chunk.length >> 1) / sampleRate) * 1000 / speed)
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              play.outcome = Exit.isSuccess(exit) ? "finished" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed"
            })
          )
        )
      })
  })
  return { plays, output }
}

/** A microphone the test feeds frame by frame. */
export const makeFakeInput = () => {
  const queue = Effect.runSync(Queue.unbounded<Uint8Array, Cause.Done>())
  let n = 0
  return {
    input: AudioInput.of({ stream: Stream.fromQueue(queue) }),
    /** Push `count` 20 ms frames; sample 0 of each holds a running counter so frames can be told apart. */
    push: (count: number) => {
      for (let i = 0; i < count; i++) {
        const samples = new Int16Array(MIC_FRAME_SAMPLES)
        samples[0] = n++ % 32768
        Queue.offerUnsafe(queue, new Uint8Array(samples.buffer))
      }
    }
  }
}

export interface TestNode {
  readonly replies: ReturnType<typeof makeFakeOutput>
  readonly cues: ReturnType<typeof makeFakeOutput>
  /** The microphone the node started with. */
  readonly mic: ReturnType<typeof makeFakeInput>
  /** Every device choice `audioFor` was asked for, with the microphone it gave (the first is the CLI's). */
  readonly opened: Array<{ readonly devices: NodeSoundDevices; readonly mic: ReturnType<typeof makeFakeInput> }>
  readonly logs: Array<string>
  readonly traces: Array<string>
  /** What `runNode` returned (only when it ends by itself: restart, update, failed start). */
  readonly exit: Promise<NodeExit>
  readonly stop: () => Promise<void>
}

export const startNode = (
  options: Omit<NodeRunOptions, "log" | "onTrace"> & { readonly speed?: number; readonly brokenInputs?: ReadonlyArray<string> }
): TestNode => {
  const { speed: _speed, brokenInputs = [], ...runOptions } = options
  const replies = makeFakeOutput(options.speed ?? 1)
  const cues = makeFakeOutput(20)
  const mic = makeFakeInput()
  const logs: Array<string> = []
  const traces: Array<string> = []
  const layer = Layer.succeedContext(
    Context.make(AudioInput, mic.input).pipe(
      Context.add(AudioOutput, replies.output),
      Context.add(NodeAudioInfo, NodeAudioInfo.of({ input: "alsa", output: "alsa", outputLatencyMs: 20, cueOutput: cues.output }))
    )
  )
  const opened: TestNode["opened"] = []
  // Reopening the microphone on another device gives a fresh fake microphone; the player and the cue output stay.
  const audioFor = (devices: NodeSoundDevices) => {
    const fresh = makeFakeInput()
    opened.push({ devices: { ...devices }, mic: fresh })
    return {
      input: brokenInputs.includes(devices.input) ? AudioInput.of({ stream: Stream.fail(new AudioError({ message: `cannot open ${devices.input}` })) }) : fresh.input,
      output: replies.output,
      info: NodeAudioInfo.of({ input: "alsa", output: "alsa", outputLatencyMs: 20, cueOutput: cues.output })
    }
  }
  const fiber = Effect.runFork(Effect.scoped(runNode({ audioFor, missingTools: () => [], ...runOptions, log: (l) => logs.push(l), onTrace: (l) => traces.push(l) })).pipe(Effect.provide(layer)))
  const exit = Effect.runPromise(Fiber.join(fiber)) as Promise<NodeExit>
  exit.catch(() => {})
  return { replies, cues, mic, opened, logs, traces, exit, stop: () => Effect.runPromise(Fiber.interrupt(fiber)) }
}

export const until = async (predicate: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
