/**
 * Thin synchronous wrapper around `sherpa-onnx-node` 2.0.1's `KeywordSpotter` (keyword-spotter.js; native side
 * scripts/node-addon-api/src/keyword-spotting.cc upstream). The only file that touches the SDK.
 *
 * Phrases: the spotter is created with `keywordsBuf` (the phrase lines). Changing phrases at runtime means creating a
 * new spotter: `createStream(keywords)` exists but *adds* the given phrases to the ones the spotter was built with
 * (KeywordSpotterTransducerImpl::CreateStream(keywords)), so it cannot remove one. Rebuilding costs a model load
 * (see FINDINGS.md for the measured time).
 */
import { createRequire } from "node:module"
import { keywordsText, loadTokenizer, type Phrase, type Tokenizer } from "./keywords.ts"
import { type KwsModel, modelPaths } from "./models.ts"

interface NativeStream {
  acceptWaveform(o: { readonly samples: Float32Array; readonly sampleRate: number }): void
  inputFinished(): void
}
interface NativeSpotter {
  createStream(): NativeStream
  isReady(s: NativeStream): boolean
  decode(s: NativeStream): void
  reset(s: NativeStream): void
  getResult(s: NativeStream): { readonly keyword: string; readonly start_time: number; readonly tokens: ReadonlyArray<string>; readonly timestamps: ReadonlyArray<number> }
}
interface SherpaModule {
  readonly KeywordSpotter: new(config: unknown) => NativeSpotter
}

const require = createRequire(import.meta.url)
let sherpa: SherpaModule | undefined
const sdk = (): SherpaModule => (sherpa ??= require("sherpa-onnx-node") as SherpaModule)

export interface SpotterOptions {
  readonly model: KwsModel
  readonly modelDir?: string
  readonly phrases: ReadonlyArray<Phrase>
  /** Default 1 (the node has few cores and other work). */
  readonly threads?: number
  /** Boost for keyword tokens, upstream default 1.0. */
  readonly keywordsScore?: number
  /** Trigger probability threshold, upstream default 0.25. Higher = fewer false fires, more misses. */
  readonly keywordsThreshold?: number
  /** Trailing blanks after a keyword before it fires, upstream default 1. */
  readonly numTrailingBlanks?: number
  /** Overrides for out-of-lexicon words (phone models), e.g. `{ jev: ["JH", "EH1", "V"] }`. */
  readonly overrides?: Readonly<Record<string, ReadonlyArray<string>>>
}

export interface Fire {
  /** The phrase label (`hey_jeff`). */
  readonly keyword: string
  /** Seconds of audio fed to the stream when the fire was read (since the last reset). */
  readonly at: number
  /** Start of the keyword per the model, seconds since the stream (re)started. */
  readonly start: number
  readonly tokens: ReadonlyArray<string>
}

export interface Spotter {
  readonly tokenizer: Tokenizer
  readonly keywords: string
  /** Feed 16 kHz mono float samples; returns the fires found while decoding them. */
  readonly accept: (samples: Float32Array) => ReadonlyArray<Fire>
  /** Start over (new stream). */
  readonly reset: () => void
}

export const SAMPLE_RATE = 16000

export const createSpotter = (o: SpotterOptions): Spotter => {
  const tokenizer = loadTokenizer(o.model, o.modelDir, o.overrides)
  const keywords = keywordsText(tokenizer, o.phrases)
  const p = modelPaths(o.model, o.modelDir)
  const native = new (sdk().KeywordSpotter)({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: p.encoder, decoder: p.decoder, joiner: p.joiner },
      tokens: p.tokens,
      numThreads: o.threads ?? 1,
      provider: "cpu",
      debug: 0
    },
    keywordsScore: o.keywordsScore ?? 1.0,
    keywordsThreshold: o.keywordsThreshold ?? 0.25,
    numTrailingBlanks: o.numTrailingBlanks ?? 1,
    maxActivePaths: 4,
    keywordsBuf: keywords,
    keywordsBufSize: Buffer.byteLength(keywords, "utf8")
  })
  let stream = native.createStream()
  let fed = 0
  return {
    tokenizer,
    keywords,
    accept: (samples) => {
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
      fed += samples.length
      const fires: Array<Fire> = []
      while (native.isReady(stream)) {
        native.decode(stream)
        const r = native.getResult(stream)
        if (r.keyword !== "") {
          fires.push({ keyword: r.keyword, at: fed / SAMPLE_RATE, start: r.start_time, tokens: r.tokens })
          // Upstream examples reset after a fire so the same keyword is not reported again.
          native.reset(stream)
        }
      }
      return fires
    },
    reset: () => {
      stream = native.createStream()
      fed = 0
    }
  }
}
