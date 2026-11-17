// The resource pool's language models (docs/ASSISTANTS.md §3.2, WP-9): keyed by configuration, shared when equal,
// switched at the next turn start after a change, released after the grace period, failures per resource.
import { Llm, type LlmEvent, LlmError } from "@pva/core"
import type { AssistantLlm } from "@pva/protocol"
import { ConfigProvider, Deferred, Effect, Exit, Scope, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  defaultLlmBuilder,
  type LlmBuilder,
  llmKeyOf,
  type LlmSpec,
  llmSpecOf,
  makeResourcePool,
  ResourceBuildError,
  type ResourcePool,
  type ResourcePoolOptions
} from "../src/serve/Resources.ts"
import { sleep } from "./support/scriptedClient.ts"

const anthropic = (model: string, over: Partial<AssistantLlm> = {}): AssistantLlm => ({
  account: "anthropic",
  model,
  effort: "low",
  thinking: "off",
  maxTokens: 1024,
  giveUpMs: 5000,
  warmUp: true,
  useModules: true,
  freshSessionAfterMinutes: 0,
  ...over
})
const spec = (model: string, over: Partial<AssistantLlm> = {}): LlmSpec => llmSpecOf(anthropic(model, over), { anthropic: { credential: "k1" } })

/** A builder whose instances answer "<model>#<n>: <text>"; `hold` makes a model's builds wait; `fail` fails them. */
const fakeBuilder = () => {
  const builds: Array<{ model: string; n: number }> = []
  const released: Array<string> = []
  const holds = new Map<string, Deferred.Deferred<void>>()
  const failing = new Set<string>()
  /** A stream on `model` waits for this before it ends (a turn in flight). */
  const streamHolds = new Map<string, Deferred.Deferred<void>>()
  const build: LlmBuilder = (s) =>
    Effect.gen(function*() {
      const n = builds.length + 1
      builds.push({ model: s.model, n })
      const hold = holds.get(s.model)
      if (hold !== undefined) yield* Deferred.await(hold)
      if (failing.has(s.model)) return yield* new ResourceBuildError({ message: `ANTHROPIC_API_KEY is not set` })
      yield* Effect.addFinalizer(() => Effect.sync(() => released.push(`${s.model}#${n}`)))
      return Llm.of({
        stream: () =>
          Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: `${s.model}#${n}` }]).pipe(
            Stream.concat(Stream.fromEffectDrain(Effect.suspend(() => {
              const h = streamHolds.get(s.model)
              return h === undefined ? Effect.void : Deferred.await(h)
            }))),
            Stream.concat(Stream.make<Array<LlmEvent>>({ _tag: "Done", stopReason: "end" }))
          )
      })
    })
  return { build, builds, released, holds, failing, streamHolds }
}

let scope: Scope.Closeable | undefined
afterEach(async () => {
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void))
  scope = undefined
})

const makePool = async (options: ResourcePoolOptions): Promise<ResourcePool> => {
  scope = Effect.runSync(Scope.make())
  return Effect.runPromise(Scope.provide(makeResourcePool(options), scope))
}
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
/** The text an instance answers with (fails with the instance's `LlmError`). */
const ask = (llm: Llm["Service"] | undefined) =>
  run(Stream.runCollect(llm!.stream({ system: "", messages: [{ role: "user", content: "hi" }], tools: [] })).pipe(
    Effect.map((events) => events.flatMap((e) => (e._tag === "TextDelta" ? [e.text] : [])).join(""))
  ))
const wanted = (entries: Record<string, LlmSpec>) => new Map(Object.entries(entries))

describe("resource pool: language models", () => {
  it("two assistants with different models answer from their own instance; identical settings share one", async () => {
    const fake = fakeBuilder()
    const pool = await makePool({ buildLlm: fake.build })
    await run(pool.reconcile(wanted({ a: spec("model-a"), b: spec("model-b"), c: spec("model-a") })))
    expect(fake.builds.map((b) => b.model).sort()).toEqual(["model-a", "model-b"])
    expect(await ask(pool.llmFor("a"))).toBe("model-a#1")
    expect(await ask(pool.llmFor("b"))).toBe("model-b#2")
    // c has a's settings: the same instance.
    expect(pool.llmFor("c")).toBe(pool.llmFor("a"))
    expect(pool.llm(llmKeyOf(spec("model-a")))).toBe(pool.llmFor("a"))
    const status = pool.status()
    expect(status).toHaveLength(2)
    expect(status.find((r) => r.key === llmKeyOf(spec("model-a")))).toMatchObject({ kind: "llm", state: "ready", usedBy: ["a", "c"], location: "hosted" })
    expect(status.find((r) => r.key === llmKeyOf(spec("model-b")))).toMatchObject({ state: "ready", usedBy: ["b"] })
    // A reconcile with the same wants builds nothing.
    await run(pool.reconcile(wanted({ a: spec("model-a"), b: spec("model-b"), c: spec("model-a") })))
    expect(fake.builds).toHaveLength(2)
  })

  it("a model change builds the new instance first; the assistant keeps the old one until it is ready, then switches; a stream in flight finishes on the old one; the old one is released after the grace period", async () => {
    const fake = fakeBuilder()
    const pool = await makePool({ buildLlm: fake.build, graceMs: 80 })
    await run(pool.reconcile(wanted({ a: spec("old"), b: spec("other") })))
    const old = pool.llmFor("a")
    const other = pool.llmFor("b")

    // A turn on the old instance is in flight while the model changes.
    const inFlightGate = Deferred.makeUnsafe<void>()
    fake.streamHolds.set("old", inFlightGate)
    const inFlight = ask(old)
    const buildGate = Deferred.makeUnsafe<void>()
    fake.holds.set("new", buildGate)
    const switched = run(pool.reconcile(wanted({ a: spec("new"), b: spec("other") })))
    await sleep(10)
    // Building: a's next turn start still gets the old instance; b is untouched.
    expect(pool.llmFor("a")).toBe(old)
    expect(pool.llmFor("b")).toBe(other)
    expect(pool.status().map((r) => [r.key.split("|")[1], r.state]).sort()).toEqual([["new", "starting"], ["old", "ready"], ["other", "ready"]])
    Deferred.doneUnsafe(buildGate, Exit.void)
    await switched
    // Ready: a's next turn uses the new one.
    expect(pool.llmFor("a")).not.toBe(old)
    expect(await ask(pool.llmFor("a"))).toBe("new#3")
    expect(pool.status().find((r) => r.key.includes("|old|"))).toMatchObject({ state: "unused", usedBy: [] })
    // The grace period passes while the old turn still streams: it is kept until that stream ends.
    await sleep(150)
    expect(fake.released).toEqual([])
    Deferred.doneUnsafe(inFlightGate, Exit.void)
    expect(await inFlight).toBe("old#1")
    await sleep(10)
    expect(fake.released).toEqual(["old#1"])
    expect(pool.status().map((r) => r.key.split("|")[1]).sort()).toEqual(["new", "other"])
    expect(pool.llmFor("b")).toBe(other)
  })

  it("unused instances are released after the grace period; wanted again within it, the same instance is kept", async () => {
    const fake = fakeBuilder()
    const pool = await makePool({ buildLlm: fake.build, graceMs: 80 })
    await run(pool.reconcile(wanted({ a: spec("m") })))
    const first = pool.llmFor("a")
    await run(pool.reconcile(wanted({})))
    expect(pool.llmFor("a")).toBeUndefined()
    expect(pool.status()).toMatchObject([{ state: "unused", usedBy: [] }])
    await sleep(30)
    await run(pool.reconcile(wanted({ a: spec("m") })))
    expect(pool.llmFor("a")).toBe(first)
    expect(fake.builds).toHaveLength(1)
    await sleep(120)
    expect(fake.released).toEqual([])
    await run(pool.reconcile(wanted({})))
    await sleep(40)
    expect(fake.released).toEqual([])
    await sleep(80)
    expect(fake.released).toEqual(["m#1"])
    expect(pool.status()).toEqual([])
  })

  it("a failing instance shows its problem in the status and answers with it; the others run; a retry builds it again", async () => {
    const fake = fakeBuilder()
    fake.failing.add("broken")
    const changes: Array<number> = []
    const pool = await makePool({
      buildLlm: fake.build,
      onChange: () => changes.push(Date.now()),
      explainProblem: (m) => (m === "ANTHROPIC_API_KEY is not set" ? "The keys are locked." : m)
    })
    await run(pool.reconcile(wanted({ a: spec("broken"), b: spec("fine") })))
    expect(pool.status().find((r) => r.usedBy.includes("a"))).toMatchObject({ state: "failed", problem: "The keys are locked.", usedBy: ["a"] })
    expect(pool.status().find((r) => r.usedBy.includes("b"))).toMatchObject({ state: "ready" })
    expect(pool.status().find((r) => r.usedBy.includes("b"))!.problem).toBeUndefined()
    await expect(ask(pool.llmFor("a"))).rejects.toThrow("ANTHROPIC_API_KEY is not set")
    expect(await ask(pool.llmFor("b"))).toBe("fine#2")
    // Not retried by an ordinary reconcile; retried with `retryFailed` (a vault unlock).
    await run(pool.reconcile(wanted({ a: spec("broken"), b: spec("fine") })))
    expect(fake.builds).toHaveLength(2)
    fake.failing.delete("broken")
    await run(pool.reconcile(wanted({ a: spec("broken"), b: spec("fine") }), { retryFailed: true }))
    expect(fake.builds).toHaveLength(3)
    expect(await ask(pool.llmFor("a"))).toBe("broken#3")
    expect(pool.status().map((r) => r.state).sort()).toEqual(["ready", "ready"])
    expect(changes.length).toBeGreaterThan(0)
  })

  it("a turn that starts while its first instance is being built waits for it", async () => {
    const fake = fakeBuilder()
    const gate = Deferred.makeUnsafe<void>()
    fake.holds.set("slow", gate)
    const pool = await makePool({ buildLlm: fake.build })
    const reconciled = run(pool.reconcile(wanted({ a: spec("slow") })))
    expect(pool.status()).toMatchObject([{ state: "starting", usedBy: ["a"] }])
    const answer = ask(pool.llmFor("a"))
    await sleep(20)
    Deferred.doneUnsafe(gate, Exit.void)
    expect(await answer).toBe("slow#1")
    await reconciled
  })

  it("rebuild: every resource in use gets a fresh instance; assistants switch once it is ready", async () => {
    const fake = fakeBuilder()
    const pool = await makePool({ buildLlm: fake.build, graceMs: 20 })
    await run(pool.reconcile(wanted({ a: spec("m"), b: spec("m") })))
    const before = pool.llmFor("a")
    await run(pool.reconcile(wanted({ a: spec("m"), b: spec("m") }), { rebuild: true }))
    expect(fake.builds).toHaveLength(2)
    expect(pool.llmFor("a")).not.toBe(before)
    expect(pool.llmFor("b")).toBe(pool.llmFor("a"))
    await sleep(60)
    expect(fake.released).toEqual(["m#1"])
  })

  it("keys: the offline accounts share one instance whatever their model fields; the Anthropic key carries every field the adapter reads, never the key stamp", () => {
    const offline = llmSpecOf({ ...anthropic(""), account: "offline" })
    const offline2 = llmSpecOf({ ...anthropic("x", { maxTokens: 64 }), account: "offline" })
    expect(llmKeyOf(offline)).toBe("offline")
    expect(llmKeyOf(offline2)).toBe("offline")
    expect(llmKeyOf(llmSpecOf({ ...anthropic("claude-haiku-5-5"), account: "claude-subscription" }))).toBe("claude-subscription")
    const key = llmKeyOf(spec("claude-haiku-5-5"))
    expect(key).toBe("anthropic|claude-haiku-5-5|low|thinking-off|1024tok|5000ms|warm|https://api.anthropic.com")
    expect(key).not.toContain("k1")
    for (const over of [{ effort: "high" }, { thinking: "adaptive" }, { maxTokens: 2048 }, { giveUpMs: 9000 }, { warmUp: false }] as const) {
      expect(llmKeyOf(spec("claude-haiku-5-5", over))).not.toBe(key)
    }
    // A credential in the address is not shown.
    const withUser = llmSpecOf(anthropic("m"), { anthropic: { address: "https://user:secret@proxy.example/v1?token=t" } })
    expect(llmKeyOf(withUser)).toContain("https://proxy.example/v1")
    expect(llmKeyOf(withUser)).not.toContain("secret")
  })

  it("a changed account key (its stamp) makes a new instance with the same shown key", async () => {
    const fake = fakeBuilder()
    const pool = await makePool({ buildLlm: fake.build, graceMs: 20 })
    const withKey = (k: string) => llmSpecOf(anthropic("m"), { anthropic: { credential: k } })
    await run(pool.reconcile(wanted({ a: withKey("one") })))
    const first = pool.llmFor("a")
    await run(pool.reconcile(wanted({ a: withKey("two") })))
    expect(fake.builds).toHaveLength(2)
    expect(pool.llmFor("a")).not.toBe(first)
    expect(pool.keyFor("a")).toBe(llmKeyOf(withKey("one")))
  })

  it("the default builder: offline builds the stand-in; an account without an adapter yet is a problem of that resource", async () => {
    const pool = await makePool({ buildLlm: defaultLlmBuilder(() => ConfigProvider.fromEnvRecord({})) })
    await run(pool.reconcile(wanted({
      a: llmSpecOf({ ...anthropic(""), account: "offline" }),
      b: llmSpecOf({ ...anthropic("some/model"), account: "openrouter" })
    })))
    expect(pool.status().find((r) => r.usedBy.includes("a"))).toMatchObject({ state: "ready", location: "local", label: "Offline stand-in" })
    expect(pool.status().find((r) => r.usedBy.includes("b"))).toMatchObject({ state: "failed", problem: "The OpenRouter account is not available yet." })
    expect((await ask(pool.llmFor("a"))).length).toBeGreaterThan(0)
    await expect(ask(pool.llmFor("b"))).rejects.toBeInstanceOf(LlmError)
  })
})
