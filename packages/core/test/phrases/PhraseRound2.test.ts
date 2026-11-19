// P7 review round 2 (docs/PHRASES.md): "stop" whose selected step fails (a3) and the execution trace's identity, outcome
// and single publication on early outcomes and interruptions (a4), on the runner itself and through the kit.
import { assert, describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { defineAction, Param, registerActions } from "../../src/Actions.ts"
import { ECHO_TAIL_MS } from "../../src/EchoGate.ts"
import { makeExecutionGateway } from "../../src/Gateway.ts"
import { type HouseholdStore, StoreError } from "../../src/HouseholdStore.ts"
import { defineModule } from "../../src/ModuleDefinition.ts"
import { startTestModule } from "../../src/ModuleTestKit.ts"
import type { Taken } from "../../src/PhraseDecision.ts"
import { makeCommandSlot, type PhrasePorts, type PhraseSessionPort, type PhraseTrace, runTaken } from "../../src/PhraseRunner.ts"
import { buildCommandSet, hostCommandSet, matchCommand, PREPARE_STEP_WORK } from "../../src/Phrases.ts"
import { makePhraseSets } from "../../src/PhraseSets.ts"
import { PlaybackError, type PlaybackService } from "../../src/Playback.ts"
import { makeEgg } from "./egg.ts"

const interrupting = "Where was I. The pasta needs eight more minutes."

/** The runner's ports with a session that records what it was asked, and knobs for each test. */
const portsFor = (over: Omit<Partial<PhrasePorts>, "session"> & { readonly session?: Partial<PhraseSessionPort> } = {}) => {
  const spoken: Array<{ readonly assistant: string | undefined; readonly text: string }> = []
  const traces: Array<PhraseTrace> = []
  const calls: Array<string> = []
  let turns = 0
  const ports: PhrasePorts = {
    deviceId: "kitchen-display",
    language: () => "en",
    notify: () => undefined,
    volume: () => Effect.succeed({ level: 1, atLimit: true }),
    playback: () => undefined,
    room: () => undefined,
    gateway: () => makeExecutionGateway(),
    turn: (assistant) => ({ turnId: ++turns, conversationId: "c-1", assistantId: assistant, source: "phrase", deviceId: "kitchen-display", person: { id: "p-sam", name: "Sam" } }) as never,
    isPublished: () => true,
    pageText: (_m, t, n) => String(t).slice(0, n),
    slot: makeCommandSlot(),
    trace: (t) => void traces.push(t),
    ...over,
    session: {
      replyActive: () => false,
      announcementActive: () => false,
      stopReply: Effect.sync(() => (calls.push("stopReply"), true)),
      stopAnnouncement: Effect.sync(() => (calls.push("stopAnnouncement"), true)),
      cancelPending: Effect.succeed(false),
      lastReply: () => undefined,
      interruptedReply: Effect.succeed({ assistant: "robin", text: interrupting }),
      replyCancelled: () => false,
      answering: () => "jeff",
      say: (assistant, text) => Effect.sync(() => (spoken.push({ assistant, text }), "done" as const)),
      ...over.session
    }
  }
  return { ports, spoken, traces, calls }
}

/** The notification service's row reads fail (an operational store fault), until the returned function is called. */
const failNotificationReads = (store: { readonly reader: HouseholdStore["reader"] }) => {
  const target = store as { reader: HouseholdStore["reader"] }
  const reader = target.reader
  target.reader = ((owner, c) => {
    const r = reader(owner, c)
    return owner === "core.notify" && c.name === "notifications" && r !== undefined
      ? { ...r, get: () => { throw new StoreError({ reason: "failed", message: "Simulated disk read failure" }) } }
      : r
  }) as HouseholdStore["reader"]
  return () => void (target.reader = reader)
}

const control = (control: "stop", assistant = "jeff"): Taken => {
  const match = matchCommand(hostCommandSet("en"), control)!
  return { by: "phrase", assistant, route: { assistant, by: "default" } as never, match, text: control }
}

describe("a3: once stop selected a step, a failure to stop it is said, and nothing else is stopped in its place", () => {
  it.effect("a ring whose stop fails (the store fails): \"I couldn't stop that.\", the ring still rings, the reply is not stopped and is said again", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      yield* kit.phrases.say("boil an egg")
      yield* kit.notify.replying("kitchen-display", true)
      const restore = failNotificationReads(kit.store)
      const r = yield* kit.phrases.say("stop", { interrupting })
      restore()
      assert.deepStrictEqual([r.taken && r.outcome.did, r.taken && r.outcome.said], ["failed", `I couldn't stop that. ${interrupting}`])
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
      assert.deepStrictEqual(kit.phrases.sessionCalls.filter((c) => c.call === "stop"), [])
      // The store works again: the next "stop" stops the ring.
      assert.strictEqual((yield* kit.phrases.say("stop")).taken && "ok", "ok")
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 0)
    }))

  it.effect("the ringing window's stop, without the wake phrase, says the failure the same way", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      yield* kit.phrases.say("boil an egg")
      yield* TestClock.adjust(1_000)
      const restore = failNotificationReads(kit.store)
      const r = yield* kit.phrases.say("stop", { wake: false })
      restore()
      assert.deepStrictEqual([r.taken && r.outcome.did, r.taken && r.outcome.said], ["failed", "I couldn't stop that."])
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
    }))

  it.effect("an announcement whose stop fails: said as a failure, the reply neither stopped nor lost", () =>
    Effect.gen(function*() {
      const { ports, spoken, calls } = portsFor({
        session: { announcementActive: () => true, replyActive: () => true, stopAnnouncement: Effect.die(new Error("the speech queue broke")) }
      })
      const out = yield* runTaken(control("stop"), ports)
      assert.deepStrictEqual([out.did, out.why], ["failed", "the announcement could not be stopped"])
      assert.deepStrictEqual(spoken, [{ assistant: "jeff", text: "I couldn't stop that." }, { assistant: "robin", text: interrupting }])
      assert.deepStrictEqual(calls, [])
    }))

  it.effect("media whose pause fails or times out: said as a failure; no player for the room is nothing to stop", () =>
    Effect.gen(function*() {
      const playback = (pause: PlaybackService["pause"]): PlaybackService => ({ pause, changeVolume: () => Effect.succeed(undefined) }) as never
      const run = (pause: PlaybackService["pause"]) => {
        const p = portsFor({ playback: () => playback(pause), room: () => "Kitchen" })
        return Effect.map(runTaken(control("stop"), p.ports), (out) => [out.did, out.said])
      }
      assert.deepStrictEqual(yield* run(() => Effect.fail(new PlaybackError({ reason: "failed", detail: "player offline" }))), ["failed", `I couldn't stop that. ${interrupting}`])
      const slow = yield* Effect.forkChild(run(() => Effect.never))
      yield* TestClock.adjust(60_000)
      assert.deepStrictEqual(yield* Fiber.join(slow), ["failed", `I couldn't stop that. ${interrupting}`])
      assert.deepStrictEqual(yield* run(() => Effect.fail(new PlaybackError({ reason: "no_player", detail: "none" }))), ["nothing", interrupting])
      assert.deepStrictEqual(yield* run(() => Effect.succeed(true)), ["paused-media", undefined])
    }))
})

describe("a4: one execution trace per taken utterance, with its identity, from a finaliser", () => {
  const actions = registerActions("probe", [
    defineAction({ id: "silent", label: "Silent", description: "Silent.", params: {}, phrases: { en: ["test silent"] }, risk: "change", run: () => Effect.void }),
    defineAction({ id: "hang", label: "Hang", description: "Hangs.", params: {}, phrases: { en: ["test hang"] }, risk: "change", run: () => Effect.never })
  ])
  const set = buildCommandSet("en", actions)
  const command = (text: string, assistant: string | undefined = "jeff"): Taken => ({ by: "phrase", assistant, route: { assistant: assistant ?? "jeff", by: "default" } as never, match: matchCommand(set, text)!, text })
  const identity = (t: PhraseTrace | undefined) => [t?.by, t?.name, t?.turn?.assistantId, t?.turn?.person?.id, t?.tool]

  it.effect("busy: the addressed assistant, the principal and the tool; no risk (it never reached the gateway)", () =>
    Effect.gen(function*() {
      const { ports, traces } = portsFor()
      ports.slot.take()
      const out = yield* runTaken(command("test silent", "robin"), ports)
      assert.strictEqual(out.did, "busy")
      assert.strictEqual(traces.length, 1)
      assert.deepStrictEqual(identity(traces[0]), ["command", "probe.silent", "robin", "p-sam", "probe_silent"])
      assert.deepStrictEqual([traces[0]!.did, traces[0]!.risk, traces[0]!.refused, traces[0]!.actionMs], ["busy", undefined, undefined, undefined])
    }))

  it.effect("withdrawn before the run: the same identity (the device's answering assistant when none was addressed), not-running, no risk", () =>
    Effect.gen(function*() {
      const { ports, traces } = portsFor({ isPublished: () => false })
      const out = yield* runTaken(command("test silent", undefined), ports)
      assert.strictEqual(out.did, "not-running")
      assert.deepStrictEqual(identity(traces[0]), ["command", "probe.silent", "jeff", "p-sam", "probe_silent"])
      assert.deepStrictEqual([traces.length, traces[0]!.did, traces[0]!.why, traces[0]!.risk], [1, "not-running", "not published", undefined])
    }))

  it.effect("interrupted during the action: one trace, did interrupted, the gateway's risk and the time the action ran; the slot is free", () =>
    Effect.gen(function*() {
      const { ports, traces } = portsFor()
      const fiber = yield* Effect.forkChild(runTaken(command("test hang"), ports))
      yield* TestClock.adjust(1_200)
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(traces.length, 1)
      assert.deepStrictEqual(identity(traces[0]), ["command", "probe.hang", "jeff", "p-sam", "probe_hang"])
      assert.deepStrictEqual([traces[0]!.did, traces[0]!.risk], ["interrupted", "change"])
      assert.isAtLeast(traces[0]!.actionMs!, 1_200)
      assert.isTrue(ports.slot.take())
    }))

  it.effect("interrupted during the settlement: one trace with the outcome it had and why it ended early", () =>
    Effect.gen(function*() {
      const speaking = yield* Deferred.make<void>()
      const { ports, traces } = portsFor({ session: { say: () => Effect.andThen(Deferred.succeed(speaking, undefined), Effect.never) } })
      const fiber = yield* Effect.forkChild(runTaken(command("test silent"), ports))
      yield* Deferred.await(speaking)
      assert.strictEqual(traces.length, 0)
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(traces.length, 1)
      assert.deepStrictEqual([traces[0]!.did, traces[0]!.why, traces[0]!.risk], ["ran", "interrupted while speaking", "change"])
      assert.deepStrictEqual(identity(traces[0]), ["command", "probe.silent", "jeff", "p-sam", "probe_silent"])
    }))

  it.effect("a control and the ringing window carry the principal too", () =>
    Effect.gen(function*() {
      const { ports, traces } = portsFor()
      yield* runTaken(control("stop", "robin"), ports)
      yield* runTaken({ by: "ringing", match: { kind: "stop", phrase: "stop" } }, ports)
      assert.deepStrictEqual(traces.map((t) => [t.by, t.name, t.turn?.assistantId, t.turn?.person?.id]), [["control", "stop", "robin", "p-sam"], ["ringing", "stop", "jeff", "p-sam"]])
    }))
})

describe("a5: interrupting a kit phrase call interrupts its action, as the real runner does", () => {
  const worker = (gate: Deferred.Deferred<void>, seen: { started: number; finished: number; cleaned: number }) =>
    defineModule({
      apiVersion: 2,
      id: "worker",
      name: "Worker",
      description: "Works until released.",
      enabledByDefault: false,
      start: () =>
        Effect.succeed({
          actions: [defineAction({
            id: "work",
            label: "Work",
            description: "Works.",
            examples: ["do work"],
            params: {},
            phrases: { en: ["do work"] },
            risk: "change",
            run: () =>
              Effect.gen(function*() {
                seen.started++
                yield* Deferred.await(gate)
                seen.finished++
                return { say: "Finished." }
              }).pipe(Effect.ensuring(Effect.sync(() => void seen.cleaned++)))
          })]
        })
    })

  for (const how of ["say", "run"] as const) {
    it.effect(`phrases.${how}: the action's clean-up runs, nothing is said afterwards, the slot is free again`, () =>
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const seen = { started: 0, finished: 0, cleaned: 0 }
        const kit = yield* startTestModule(worker(gate, seen))
        const call = how === "say" ? kit.phrases.say("do work") : Effect.flatMap(kit.phrases.decide("do work"), (taken) => kit.phrases.run(taken!))
        const caller = yield* Effect.forkChild(call)
        for (let i = 0; i < 200 && seen.started === 0; i++) yield* Effect.yieldNow
        assert.strictEqual(seen.started, 1)
        yield* Fiber.interrupt(caller)
        assert.deepStrictEqual(seen, { started: 1, finished: 0, cleaned: 1 })
        yield* Deferred.succeed(gate, undefined)
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow
        assert.deepStrictEqual(seen, { started: 1, finished: 0, cleaned: 1 })
        assert.deepStrictEqual(kit.phrases.spoken, [])
        assert.deepStrictEqual(kit.phrases.traces.map((t) => t.did), ["interrupted"])
        // The device's one action at a time is free: the next command runs (the gate is open now).
        const next = yield* kit.phrases.say("do work")
        assert.deepStrictEqual([next.taken && next.outcome.did, kit.phrases.spoken.map((s) => s.text)], ["ran", ["Finished."]])
      }))
  }
})

describe("a6: a line the kit speaks keeps the ringing window closed for serve mode's echo tail", () => {
  it.effect("a command's answer: closed at once and just before the tail's end, open at its end", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      yield* kit.phrases.say("boil an egg")
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["Egg timer for 6 minutes."])
      assert.isUndefined(yield* kit.phrases.decide("snooze", { wake: false }))
      yield* TestClock.adjust(ECHO_TAIL_MS - 1)
      assert.isUndefined(yield* kit.phrases.decide("snooze", { wake: false }))
      yield* TestClock.adjust(1)
      assert.strictEqual((yield* kit.phrases.decide("snooze", { wake: false }))?.by, "ringing")
    }))

  it.effect("a repeat and an interrupted reply said again close it the same way; an utterance that interrupted a reply finds it closed", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(makeEgg().definition)
      yield* kit.phrases.say("boil an egg")
      yield* TestClock.adjust(ECHO_TAIL_MS)
      yield* kit.phrases.say("repeat")
      assert.isUndefined(yield* kit.phrases.decide("snooze", { wake: false }))
      yield* TestClock.adjust(ECHO_TAIL_MS)
      assert.strictEqual((yield* kit.phrases.decide("snooze", { wake: false }))?.by, "ringing")
      yield* kit.phrases.say("louder", { interrupting })
      assert.isUndefined(yield* kit.phrases.decide("snooze", { wake: false }))
      yield* TestClock.adjust(ECHO_TAIL_MS)
      assert.strictEqual((yield* kit.phrases.decide("snooze", { wake: false }))?.by, "ringing")
      assert.isUndefined(yield* kit.phrases.decide("snooze", { wake: false, interrupting }))
    }))
})

describe("a2: a set is prepared in steps of bounded work, not per module", () => {
  it.effect("the maximum choice-bearing module (one module) is prepared over many steps", () =>
    Effect.gen(function*() {
      const name = (s: string) => `${s} ${"x".repeat(40)}`.slice(0, 40)
      const choice = (tag: string) => Param.choice({ label: "C", options: Array.from({ length: 32 }, (_, i) => ({ value: name(`${tag} v${i}`), label: name(`${tag} l${i}`), aliases: [name(`${tag} a${i}`)] })) })
      const actions = registerActions("choices", Array.from({ length: 16 }, (_, a) =>
        defineAction({ id: `a${a}`, label: "A", description: "A.", params: { r: choice(`r${a}`), s: choice(`s${a}`) }, phrases: { en: Array.from({ length: 8 }, (_, v) => `please action${a} variant${v} in {r} at {s}`) }, run: () => Effect.void })))
      let steps = 0
      const sets = yield* makePhraseSets({ language: () => "en", assistants: () => [{ id: "a", name: "A" }], inputKey: () => "1", actionsOf: () => actions }, { yieldStep: Effect.sync(() => void steps++) })
      yield* sets.settled
      expect(sets.ready("a")?.phrases.filter((p) => p.owner.kind === "action")).toHaveLength(128)
      // 128 phrases and 32 choices of 96 names: 3,200 units, a yield after every 256 or so (and one after the set).
      expect(steps).toBeGreaterThanOrEqual(Math.floor((128 + 32 * 96) / (PREPARE_STEP_WORK + 2 * 96)))
    }).pipe(Effect.scoped))
})

describe("b1 on the runner: a reply cancelled meanwhile is not said again; checked after each wait and right before it", () => {
  const louder = (): Taken => ({ by: "phrase", assistant: "jeff", route: { assistant: "jeff", by: "default" } as never, match: matchCommand(hostCommandSet("en"), "louder")!, text: "louder" })

  it.effect("cancelled while the interrupted reply's end is awaited: louder says its own sentence and not the reply", () =>
    Effect.gen(function*() {
      let cancelled = false
      const { ports, spoken } = portsFor({
        volume: () => Effect.succeed({ level: 0.8, atLimit: false }),
        session: { replyCancelled: () => cancelled, interruptedReply: Effect.sync(() => (cancelled = true, { assistant: "robin", text: interrupting })) }
      })
      yield* runTaken(louder(), ports)
      assert.deepStrictEqual(spoken, [{ assistant: "jeff", text: "Louder." }])
    }))

  it.effect("cancelled while the answer plays: the answer is said, the reply is not", () =>
    Effect.gen(function*() {
      let cancelled = false
      const { ports, spoken } = portsFor({
        session: {
          replyCancelled: () => cancelled,
          say: (assistant, text) => Effect.sync(() => (spoken.push({ assistant, text }), cancelled = true, "done" as const))
        }
      })
      yield* runTaken(louder(), ports)
      assert.deepStrictEqual(spoken, [{ assistant: "jeff", text: "That's as loud as I go." }])
    }))
})
