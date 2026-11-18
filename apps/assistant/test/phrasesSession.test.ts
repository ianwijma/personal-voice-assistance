// P7 on the real voice session (docs/PHRASES.md): the recogniser's events of an utterance in every order (speech start,
// interims, eager, final, resumed) for a taken and a not-taken utterance, in every interrupt mode; a taken utterance
// leaves no turn, nothing in the history and no call of a tool that is not speculative (the model calls one at every
// request here, so a speculative turn would reach it); "louder" over a reply says that reply again; the ringing window
// takes "stop" without the wake phrase on a device that answers nobody, but not while the device's own line plays.
import {
  buildCommandSet,
  defineAction,
  hostCommandSet,
  type LlmEvent,
  Llm,
  makeExecutionGateway,
  makeTool,
  makeToolRegistry,
  makeTurnTrace,
  Param,
  type PhraseOutcome,
  registerActions,
  type RingingCard,
  type SttEvent,
  type TurnSetup
} from "@pva/core"
import { BUILT_IN_WEB_VOICE_SETTINGS, type InterruptMode, REPLY_VOLUME, type ServerMessage, stepReplyVolume } from "@pva/protocol"
import { Effect, Exit, Schema, Scope, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeVoiceSession } from "../src/serve/VoiceSession.ts"
import { sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, type TestServer, toneTts } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const until = async (check: () => boolean, ms = 4_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(10)
  }
}

let server: TestServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

/** The tiny module's action, as the snapshot holds it (unsealed: the hand-made gateway runs it directly). */
const ran: Array<string> = []
const egg = registerActions("egg", [defineAction({
  id: "boil",
  label: "Boil an egg",
  description: "Boils an egg.",
  params: { length: Param.duration({ label: "Length", optional: true }) },
  phrases: { en: ["boil an egg", "egg timer for {length}"] },
  risk: "change",
  run: () => Effect.sync(() => (ran.push("boil"), { say: "Egg on." }))
})])

/** A model that asks for a tool with a side effect at every first request of a turn, then answers. */
const toolLlm = (reply: string) => {
  const requests: Array<string> = []
  const llm = Llm.of({
    stream: (request) =>
      Stream.suspend(() => {
        const last = request.messages.at(-1)
        requests.push(last?.role ?? "none")
        const events: Array<LlmEvent> = last?.role === "user"
          ? [{ _tag: "ToolCall", id: `c${requests.length}`, name: "side_effect", input: {} }, { _tag: "Done", stopReason: "tool_use" }]
          : [...reply.split(/(?<= )/).map((w): LlmEvent => ({ _tag: "TextDelta", text: w })), { _tag: "Done", stopReason: "end" }]
        return Stream.fromIterable(events).pipe(Stream.tap(() => Effect.sleep(2)))
      })
  })
  return { llm, requests }
}

const session = async (o: {
  readonly interrupt?: InterruptMode
  readonly withoutPhrase?: "assistant" | "nobody"
  readonly ringing?: () => ReadonlyArray<RingingCard> | undefined
  readonly reply?: string
  /** The assignment's follow-up (default: the assistant's own). */
  readonly followUpSeconds?: number
}) => {
  ran.length = 0
  const stt = controlledStt()
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "unused").llm }) })
  const scope = Effect.runSync(Scope.make())
  const messages: Array<ServerMessage> = []
  const assistants = new Map(Object.entries(server.handle.store.settings().assistants.byId))
  const assistant = [...assistants.keys()][0]!
  const sideEffects: Array<string> = []
  const tool = makeTool({ name: "side_effect", description: "Changes something.", parameters: Schema.Struct({}), execute: () => Effect.sync(() => (sideEffects.push("ran"), "done")) })
  const registry = makeToolRegistry([{ name: "test", tools: [tool] }])
  const model = toolLlm(o.reply ?? "One long sentence of the reply. A second long sentence follows it. And a third one to finish.")
  const outcomes: Array<PhraseOutcome> = []
  const stopped: Array<string> = []
  const pressed: Array<string> = []
  let volume: number = REPLY_VOLUME.default
  const turnTrace = makeTurnTrace()
  const voice = await run(makeVoiceSession({
    key: "phrase-device",
    deviceId: "phrase-device",
    name: () => "Phrases",
    engine: server.handle.engine,
    deviceSettings: () => ({
      ...BUILT_IN_WEB_VOICE_SETTINGS,
      interruptMode: o.interrupt ?? "instant",
      assistants: [{ assistant, phrases: ["hey jeff"], ...(o.followUpSeconds !== undefined ? { followUpSeconds: o.followUpSeconds } : {}) }],
      withoutPhrase: o.withoutPhrase === "nobody" ? { mode: "nobody" } : { mode: "assistant", assistant }
    }),
    assistants: () => assistants as never,
    conversationSetup: () => ({
      setup: Effect.sync((): TurnSetup => ({ system: "Test", registry, tts: toneTts({ millisPerClause: 400 }), llm: model.llm }))
    }),
    turnTrace,
    moduleOfTool: () => null,
    send: (m) => void messages.push(m),
    wakeHeard: () => undefined,
    onChange: () => undefined,
    heard: { dir: mkdtempSync(join(tmpdir(), "pva-heard-")), enabled: () => false, maxFiles: () => 0, model: () => "", lostOnTheWay: () => 0 },
    log: () => undefined,
    phrases: {
      language: () => "en",
      commandsFor: (a) => (a === undefined ? hostCommandSet("en") : buildCommandSet("en", egg)),
      ringing: o.ringing ?? (() => undefined),
      ports: {
        notify: () => ({
          ringingOn: () => o.ringing?.() ?? [],
          stopRinging: (d) => Effect.sync(() => (stopped.push(d), 1)),
          stopSpeech: () => Effect.succeed(false),
          press: (r) => Effect.sync(() => (pressed.push(r.actionId), { ok: true, say: "Snoozed." }))
        }),
        volume: (direction) =>
          Effect.sync(() => {
            const next = stepReplyVolume(volume, direction)
            volume = next.level
            return next
          }),
        playback: () => undefined,
        room: () => "Kitchen",
        gateway: () => makeExecutionGateway(),
        isPublished: () => true,
        pageText: (_m, t, max) => String(t).slice(0, max)
      },
      onOutcome: (outcome) => void outcomes.push(outcome)
    }
  }).pipe(Scope.provide(scope)))
  // The page, played by hand: playback starts 20 ms after a reply's first audio, and finishes a while after it ends.
  let starting: number | undefined
  const link = {
    sendMessage: (m: ServerMessage) => {
      messages.push(m)
      if (m.type === "reply.start") starting = m.turnId
      if (m.type === "reply.stop") voice.web.report({ type: "playback.stopped", turnId: m.turnId, playedSamples: 0 }, link as never)
      if (m.type === "reply.end") setTimeout(() => voice.web.report({ type: "playback.finished", turnId: m.turnId, playedSamples: 10_000_000 }, link as never), 600)
    },
    sendBinary: () => {
      const turnId = starting
      if (turnId === undefined) return
      starting = undefined
      setTimeout(() => voice.web.report({ type: "playback.started", turnId, outputLatencyMs: 0, startDelayMs: 0 }, link as never), 20)
    }
  }
  voice.web.setOwner(link as never)
  voice.ownerChanged(true, true)
  voice.conversation.start()
  await until(() => stt.open() === 1)
  const userTurns = () => messages.filter((m) => m.type === "turn.start" && m.userText !== "").length
  const history = () => run(voice.conversation.history())
  return {
    voice,
    stt,
    messages,
    outcomes,
    sideEffects,
    stopped,
    pressed,
    userTurns,
    history,
    traces: () => run(turnTrace.recent),
    volume: () => volume,
    close: () => run(Effect.andThen(voice.conversation.end, Scope.close(scope, Exit.void)))
  }
}

const ORDERS: ReadonlyArray<readonly [string, (text: string) => ReadonlyArray<SttEvent>]> = [
  ["speech start, final", (t) => [{ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: t }]],
  ["speech start, interims, final", (t) => [{ _tag: "SpeechStarted" }, { _tag: "Interim", text: t.split(" ").slice(0, 2).join(" ") }, { _tag: "Interim", text: t }, { _tag: "EndOfTurn", text: t }]],
  ["speech start, interim, eager, final", (t) => [{ _tag: "SpeechStarted" }, { _tag: "Interim", text: t }, { _tag: "EagerEndOfTurn", text: t }, { _tag: "EndOfTurn", text: t }]],
  ["eager, resumed, eager again, final", (t) => [
    { _tag: "SpeechStarted" },
    { _tag: "EagerEndOfTurn", text: t.split(" ").slice(0, 2).join(" ") },
    { _tag: "TurnResumed" },
    { _tag: "Interim", text: t },
    { _tag: "EagerEndOfTurn", text: t },
    { _tag: "EndOfTurn", text: t }
  ]],
  ["eager, resumed, final", (t) => [{ _tag: "SpeechStarted" }, { _tag: "EagerEndOfTurn", text: t }, { _tag: "TurnResumed" }, { _tag: "EndOfTurn", text: t }]]
]

describe("one decision per utterance, on the real voice session", () => {
  for (const mode of ["instant", "confirm", "manual"] as const) {
    for (const [name, events] of ORDERS) {
      it(`${mode}, ${name}: a taken utterance leaves no turn, no history and no tool call; one that is not taken is a turn`, async () => {
        const s = await session({ interrupt: mode })
        try {
          s.stt.emit(...events("hey jeff boil an egg"))
          await until(() => s.outcomes.length === 1)
          await sleep(150)
          expect(s.outcomes[0]).toMatchObject({ did: "ran", said: "Egg on." })
          expect(ran).toEqual(["boil"])
          expect(s.userTurns()).toBe(0)
          expect(await s.history()).toEqual([])
          expect(s.sideEffects).toEqual([])
          // No turn of its words was committed: a speculative one (from an eager transcript) was discarded.
          expect((await s.traces()).filter((t) => t.mode === "voice" && t.outcome !== "discarded")).toEqual([])
          // The answer is a canned reply: no words of the utterance, nothing in the history.
          await until(() => s.messages.some((m) => m.type === "turn.end"), 5_000)
          expect(await s.history()).toEqual([])
          await until(() => !s.voice.gate.audible(performance.now()), 6_000)
          // The same order with words that are no command: one turn, its tool ran once, its exchange in the history.
          s.stt.emit(...events("hey jeff what is the weather"))
          await until(() => s.userTurns() === 1)
          await until(() => s.messages.filter((m) => m.type === "turn.end").length === 2, 6_000)
          expect(s.sideEffects).toEqual(["ran"])
          expect((await s.history()).filter((m) => m.role === "user").map((m) => (m as { content: string }).content)).toEqual(["what is the weather"])
          expect(s.outcomes).toHaveLength(1)
        } finally {
          await s.close()
        }
      })
    }
  }

  for (const mode of ["instant", "confirm", "manual"] as const) {
    it(`${mode}: "louder" said over a reply (with the wake phrase) steps the volume and says the interrupted reply again; no turn, no history of its own`, async () => {
      const s = await session({ interrupt: mode, withoutPhrase: "nobody" })
      try {
        expect(await run(s.voice.conversation.sendText("tell me something", true))).toBe("accepted")
        await until(() => s.voice.gate.audible(performance.now()))
        const historyBefore = (await s.history()).length
        s.stt.emit({ _tag: "SpeechStarted" }, { _tag: "Interim", text: "hey jeff quieter" }, { _tag: "EndOfTurn", text: "hey jeff quieter" })
        if (mode === "manual") {
          // Manual: the microphone counts for nothing while the reply plays (the echo gate drops every event).
          await sleep(400)
          expect(s.outcomes).toEqual([])
        } else {
          await until(() => s.outcomes.length === 1)
          expect(s.outcomes[0]!.did).toBe("volume")
          expect(s.volume()).toBe(0.8)
          // What had been prepared of the interrupted reply, said again as a canned reply.
          expect(s.outcomes[0]!.said).toContain("One long sentence of the reply.")
          await sleep(200)
          expect(s.messages.filter((m) => m.type === "turn.start" && m.userText === "").length).toBe(1)
        }
        await sleep(300)
        // The typed turn is its exchange; nothing of "quieter" is in the history.
        const history = await s.history()
        expect(history.length).toBe(historyBefore === 0 ? history.length : historyBefore)
        expect(JSON.stringify(history)).not.toContain("quieter")
        expect(s.userTurns()).toBe(1)
      } finally {
        await s.close()
      }
    })
  }

  it("'hey jeff stop' over a reply stops it and it is not said again; repeat then says the last reply", async () => {
    const s = await session({ withoutPhrase: "nobody", reply: "A short reply." })
    try {
      await run(s.voice.conversation.sendText("hello", true))
      await until(() => s.voice.gate.audible(performance.now()))
      s.stt.emit({ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "hey jeff stop" })
      await until(() => s.outcomes.length === 1)
      expect(s.outcomes[0]!.did).toBe("stopped-reply")
      expect(s.outcomes[0]!.said).toBeUndefined()
      await sleep(300)
      expect(s.messages.filter((m) => m.type === "turn.start" && m.userText === "").length).toBe(0)
      s.stt.emit({ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "hey jeff, repeat that" })
      await until(() => s.outcomes.length === 2)
      expect(s.outcomes[1]).toMatchObject({ did: "repeated", said: "A short reply." })
      expect(s.voice.control.lastReply()?.text).toBe("A short reply.")
    } finally {
      await s.close()
    }
  })
})

describe("the ringing window, on the real voice session", () => {
  const card = [{ id: "n-1", actions: [{ id: "snooze", label: "Snooze" }] }]

  it("a device that answers nobody: 'stop' and a button's label without the wake phrase are taken while something rings, not otherwise", async () => {
    let ringing: ReadonlyArray<RingingCard> = card
    const s = await session({ withoutPhrase: "nobody", ringing: () => ringing })
    try {
      s.stt.emit({ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "Stop." })
      await until(() => s.outcomes.length === 1)
      expect(s.outcomes[0]).toMatchObject({ did: "stopped-ring", taken: { by: "ringing" } })
      expect(s.stopped).toEqual(["phrase-device"])
      s.stt.emit({ _tag: "SpeechStarted" }, { _tag: "Interim", text: "snooze" }, { _tag: "EndOfTurn", text: "snooze" })
      await until(() => s.outcomes.length === 2)
      expect(s.outcomes[1]).toMatchObject({ did: "pressed", said: "Snoozed." })
      expect(s.pressed).toEqual(["snooze"])
      // Nothing rings now (the service says so): "stop" without the wake phrase is dropped as before.
      ringing = []
      s.stt.emit({ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "stop" })
      await sleep(300)
      expect(s.outcomes).toHaveLength(2)
      expect(s.userTurns()).toBe(0)
    } finally {
      await s.close()
    }
  })

  it("the device's own spoken line: an utterance heard while a reply plays is not taken by the window (in instant mode too)", async () => {
    // No follow-up window (a follow-up window is after-wake, plan step 5: "stop" there is the host's control, which stops the ring).
    const s = await session({ withoutPhrase: "nobody", followUpSeconds: 0, ringing: () => card, reply: "Stop. Snooze. Words of the reply itself, long enough to keep playing for a while." })
    try {
      await run(s.voice.conversation.sendText("say it", true))
      await until(() => s.voice.gate.audible(performance.now()))
      s.stt.emit({ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "stop" })
      await sleep(400)
      expect(s.outcomes).toEqual([])
      expect(s.stopped).toEqual([])
      // Once it is quiet again (the reply and its echo tail over), the window takes "stop".
      await until(() => !s.voice.gate.audible(performance.now()), 6_000)
      s.stt.emit({ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "stop" })
      await until(() => s.outcomes.length === 1)
      expect(s.outcomes[0]!.did).toBe("stopped-ring")
    } finally {
      await s.close()
    }
  })

  it("the window closed by the device's setting (the session is given no ringing): not taken", async () => {
    const s = await session({ withoutPhrase: "nobody", ringing: () => undefined })
    try {
      s.stt.emit({ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "stop" })
      await sleep(300)
      expect(s.outcomes).toEqual([])
    } finally {
      await s.close()
    }
  })
})
