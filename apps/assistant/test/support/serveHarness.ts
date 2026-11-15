/**
 * Starts serve mode in-process with injected providers (a controllable `Stt`,
 * a scripted `Llm`, a tone `Tts`), a temporary data directory and a free port.
 */
import { defineModule, Llm, type LlmEvent, makeTool, type ModuleDefinition, Setting, Stt, type SttEvent, Tts, type TtsAudio } from "@pva/core"
import { sttContractKeeper } from "@pva/core/testing"
import { Effect, Exit, Queue, References, Schema, Scope, Stream } from "effect"
import type { ProfileOverrides } from "@pva/protocol"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineProviders, ProviderBuilder } from "../../src/serve/Engine.ts"
import { type ServeHandle, type ServeOptions, startServe } from "../../src/serve/serveMode.ts"

/**
 * An `Stt` that drains its audio (recording what it got) and emits events pushed by the test. Every `transcribe`
 * call (one per voice session, again after each engine reload) is a stream of its own: `emit` goes to every open
 * one (a test with one session; with none open yet, to the next that opens), `emitTo(i, …)` to the i-th open one in the order they were opened (sessions in
 * the order they were created; a reload reopens them in that order).
 */
export const controlledStt = () => {
  const chunks: Array<Uint8Array> = []
  interface Open {
    readonly queue: Queue.Queue<SttEvent>
    readonly chunks: Array<Uint8Array>
    readonly keep: ReturnType<typeof sttContractKeeper>
  }
  const open: Array<Open> = []
  /** `emit` with no stream open (a session whose loop is still starting): for the next one that opens. */
  const held: Array<SttEvent> = []
  let opened = 0
  const stt = Stt.of({
    transcribe: (audio) =>
      Stream.suspend(() => {
        // A real recogniser sends `SpeechStarted` before any transcript of an utterance; the conversation ignores
        // transcripts without one. The keeper inserts it where a test's script leaves it out.
        const entry: Open = { queue: Effect.runSync(Queue.unbounded<SttEvent>()), chunks: [], keep: sttContractKeeper() }
        open.push(entry)
        opened++
        if (held.length > 0) push(entry, held.splice(0))
        return Stream.merge(
          audio.pipe(Stream.tap((c) => Effect.sync(() => {
            chunks.push(c)
            entry.chunks.push(c)
          })), Stream.drain, Stream.orDie),
          Stream.fromQueue(entry.queue)
        ).pipe(Stream.ensuring(Effect.sync(() => {
          const i = open.indexOf(entry)
          if (i >= 0) open.splice(i, 1)
        })))
      })
  })
  const push = (entry: Open, events: ReadonlyArray<SttEvent>) => (entry.keep(events) as Array<SttEvent>).forEach((e) => Queue.offerUnsafe(entry.queue, e))
  return {
    stt,
    /** Audio received by every stream. */
    chunks,
    /** The audio received by the i-th open stream. */
    chunksOf: (i: number): ReadonlyArray<Uint8Array> => open[i]?.chunks ?? [],
    /** Streams open now, and opened since start. */
    open: () => open.length,
    opened: () => opened,
    emit: (...events: Array<SttEvent>) => {
      if (open.length === 0) held.push(...events)
      for (const entry of open) push(entry, events)
    },
    emitTo: (i: number, ...events: Array<SttEvent>) => {
      const entry = open[i]
      if (entry === undefined) throw new Error(`no recognition stream ${i} (${open.length} open)`)
      push(entry, events)
    }
  }
}

/** An `Llm` that answers with `reply(userText)` word by word (a few ms apart); tool calls are not used. */
export const scriptedLlm = (reply: (userText: string, requestIndex: number) => string, options: { readonly firstTokenMs?: number } = {}) => {
  const requests: Array<{ system: string; messages: ReadonlyArray<unknown> }> = []
  const llm = Llm.of({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push({ system: request.system, messages: request.messages })
        const last = request.messages.at(-1)
        const text = reply(last?.role === "user" ? last.content : "", requests.length - 1)
        const events: Array<LlmEvent> = [
          ...text.split(/(?<= )/).map((w): LlmEvent => ({ _tag: "TextDelta", text: w })),
          { _tag: "Done", stopReason: "end" }
        ]
        let first = true
        return Stream.fromIterable(events).pipe(
          Stream.tap((e) => {
            const wait = first && (options.firstTokenMs ?? 0) > 0 ? options.firstTokenMs! : e._tag === "TextDelta" ? 2 : 0
            first = false
            return wait > 0 ? Effect.sleep(wait) : Effect.void
          })
        )
      })
  })
  return { llm, requests }
}

/** A tone `Tts`: `millisPerClause` of audio per clause in 40 ms chunks, produced faster than real time. */
export const toneTts = (options: { readonly sampleRate?: number; readonly millisPerClause?: number } = {}) => {
  const sampleRate = options.sampleRate ?? 22_050
  const perChunk = Math.round(sampleRate * 0.04)
  const chunks = Math.max(1, Math.round((options.millisPerClause ?? 400) / 40))
  return Tts.of({
    sampleRate,
    synthesize: (clauses) =>
      clauses.pipe(
        Stream.zipWithIndex,
        Stream.flatMap(([, clause]) =>
          Stream.fromIterable(Array.from({ length: chunks }, (): TtsAudio => ({ audio: new Uint8Array(new Int16Array(perChunk).fill(800).buffer), clause }))).pipe(
            Stream.tap(() => Effect.sleep(2))
          )
        )
      )
  })
}

export const fakeBuild = (providers: Partial<EngineProviders> & Pick<EngineProviders, "stt" | "llm">): ProviderBuilder =>
  Effect.succeed({
    tts: toneTts(),
    voice: { provider: "sherpa", voiceId: "en_US-lessac-medium" },
    maxToolRounds: 5,
    engines: [{ stage: "llm", provider: "fake", detail: "scripted", location: "local" }],
    voiceInfo: [{ name: "sherpa:en_US-lessac-medium", description: "Lessac", enabled: true, isDefault: true, engine: "tone", location: "local" }],
    ...providers
  })

/** A module with one setting and one tool, for the broadcast tests. */
export const greeterModule: ModuleDefinition<any> = defineModule({
  id: "greeter",
  name: "Greeter",
  description: "Greets.",
  settings: {
    greeting: Setting.text({ label: "Greeting", default: "hello", check: (v) => (v === "bad" ? "Not this one" : undefined) }),
    token: Setting.secret({ label: "Token" })
  },
  start: ({ settings, setStatus }) =>
    Effect.sync(() => {
      setStatus({ text: `Says ${settings.greeting}`, tone: "ok" })
      return {
        instructions: `Greet with ${settings.greeting}.`,
        tools: [makeTool({ name: "greet", description: "greet", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed(settings.greeting) })]
      }
    })
})

export interface TestServer {
  readonly handle: ServeHandle
  readonly url: string
  readonly dataDir: string
  readonly close: () => Promise<void>
}

/** The admin password every test server has (unless a test passes `adminPassword`). */
export const TEST_ADMIN_PASSWORD = "test admin password"

/**
 * Starts a test server. Without a `settings.json` in its data directory one is written first with the `web-voice`
 * kind defaults `kindDefaults` (default `{ interruptMode: "instant" }`: barge-in tests interrupt by voice, as the
 * scripted client's `claim("instant")` did before protocol 5).
 */
export const startTestServer = async (
  options: Partial<ServeOptions> & Pick<ServeOptions, "build"> & { readonly kindDefaults?: ProfileOverrides }
): Promise<TestServer> => {
  const scope = Effect.runSync(Scope.make())
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "pva-serve-"))
  if (!existsSync(join(dataDir, "settings.json"))) {
    mkdirSync(dataDir, { recursive: true })
    const frontends = { "web-voice": options.kindDefaults ?? { interruptMode: "instant" } }
    writeFileSync(join(dataDir, "settings.json"), `${JSON.stringify({ version: 3, modules: {}, assistant: {}, frontends, devices: {} }, null, 2)}\n`)
  }
  const { kindDefaults: _, ...serveOptions } = options
  const program = startServe({
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: ["http://localhost:3000"],
    webDir: join(dataDir, "no-web"),
    catalog: [greeterModule],
    env: {},
    // Never the owner's real vault; a cheap scrypt so tests stay fast (a vault opens with its own stored parameters).
    vaultPath: join(dataDir, "vault", "vault.enc"),
    vaultKdf: { N: 2 ** 12, r: 8, p: 1 },
    adminPassword: TEST_ADMIN_PASSWORD,
    ...serveOptions,
    dataDir
  }).pipe(Scope.provide(scope), Effect.provideService(References.MinimumLogLevel, "Error"))
  const handle = await Effect.runPromise(program)
  await Effect.runPromise(handle.ready)
  return {
    handle,
    url: handle.http.url,
    dataDir,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

/** 16 kHz PCM filled with one byte value, so the test can tell microphone audio from the noise floor. */
export const markedPcm = (ms: number, value = 0x11) => new Uint8Array(Math.round((ms / 1000) * 16_000) * 2).fill(value)
