// The resource pool's sharing, release and eviction rules and its error paths (docs/ASSISTANTS.md §3.2, WP-9),
// beyond what resources.test.ts covers: shared instances outliving one user, going back to an old configuration,
// failed and never-used instances released at once, defects in a builder, the pool's own shutdown, `onChange`.
import { Llm, type LlmEvent, LlmError } from "@pva/core"
import type { AssistantLlm } from "@pva/protocol"
import { Deferred, Effect, Exit, Scope, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  llmConfigOf,
  llmKeyOf,
  llmLabelOf,
  type LlmBuilder,
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
const spec = (model: string): LlmSpec => llmSpecOf(anthropic(model), { anthropic: { credential: "k1" } })
const wanted = (entries: Record<string, LlmSpec>) => new Map(Object.entries(entries))

/** Builder whose instances answer "<model>#<n>"; `hold` delays a model's build; `fail` makes it fail with a value. */
const fakeBuilder = () => {
  const builds: Array<string> = []
  const released: Array<string> = []
  const holds = new Map<string, Deferred.Deferred<void>>()
  const failWith = new Map<string, () => Effect.Effect<never, ResourceBuildError>>()
  const build: LlmBuilder = (s) =>
    Effect.gen(function*() {
      const n = builds.length + 1
      builds.push(s.model)
      const hold = holds.get(s.model)
      if (hold !== undefined) yield* Deferred.await(hold)
      const fail = failWith.get(s.model)
      if (fail !== undefined) return yield* fail()
      yield* Effect.addFinalizer(() => Effect.sync(() => released.push(`${s.model}#${n}`)))
      return Llm.of({ stream: () => Stream.make<Array<LlmEvent>>({ _tag: "TextDelta", text: `${s.model}#${n}` }, { _tag: "Done", stopReason: "end" }) })
    })
  return { build, builds, released, holds, failWith }
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
const ask = (llm: Llm["Service"] | undefined) =>
  run(Stream.runCollect(llm!.stream({ system: "", messages: [{ role: "user", content: "hi" }], tools: [] })).pipe(
    Effect.map((events) => events.flatMap((e) => (e._tag === "TextDelta" ? [e.text] : [])).join(""))
  ))

describe("resource pool: sharing and release", () => {
  it("a shared instance outlives one of its users and is released only after the last one leaves", async () => {
    const fake = fakeBuilder()
    const pool = await makePool({ buildLlm: fake.build, graceMs: 40 })
    await run(pool.reconcile(wanted({ a: spec("m"), b: spec("m") })))
    const shared = pool.llmFor("a")
    await run(pool.reconcile(wanted({ b: spec("m") })))
    expect(pool.llmFor("a")).toBeUndefined()
    expect(pool.keyFor("a")).toBeUndefined()
    expect(pool.llmFor("b")).toBe(shared)
    expect(pool.status()).toMatchObject([{ state: "ready", usedBy: ["b"] }])
    await sleep(100)
    expect(fake.released).toEqual([])
    await run(pool.reconcile(wanted({})))
    expect(pool.status()).toMatchObject([{ state: "unused", usedBy: [] }])
    await sleep(100)
    expect(fake.released).toEqual(["m#1"])
    expect(pool.status()).toEqual([])
  })

  it("going back to the previous configuration within the grace period reuses that instance and cancels its release", async () => {
    const fake = fakeBuilder()
    const pool = await makePool({ buildLlm: fake.build, graceMs: 60 })
    await run(pool.reconcile(wanted({ a: spec("old") })))
    const old = pool.llmFor("a")
    await run(pool.reconcile(wanted({ a: spec("new") })))
    expect(pool.llmFor("a")).not.toBe(old)
    await run(pool.reconcile(wanted({ a: spec("old") })))
    expect(pool.llmFor("a")).toBe(old)
    expect(fake.builds).toEqual(["old", "new"])
    await sleep(150)
    // "new" is the one nobody uses now; "old" was never released.
    expect(fake.released).toEqual(["new#2"])
    expect(await ask(pool.llmFor("a"))).toBe("old#1")
  })

  it("an instance that nobody uses is shown as unused and a ready one is offered by key only while it is ready", async () => {
    const fake = fakeBuilder()
    const gate = Deferred.makeUnsafe<void>()
    fake.holds.set("slow", gate)
    const pool = await makePool({ buildLlm: fake.build, graceMs: 1000 })
    const reconciled = run(pool.reconcile(wanted({ a: spec("slow") })))
    expect(pool.llm(llmKeyOf(spec("slow")))).toBeUndefined()
    Deferred.doneUnsafe(gate, Exit.void)
    await reconciled
    expect(pool.llm(llmKeyOf(spec("slow")))).toBe(pool.llmFor("a"))
    await run(pool.reconcile(wanted({})))
    // Still ready (kept for the grace period), no longer used.
    expect(pool.status()).toMatchObject([{ state: "unused" }])
    expect(pool.llm(llmKeyOf(spec("slow")))).toBeDefined()
  })

  it("a failed instance is released at once when its assistant leaves, without waiting for the grace period", async () => {
    const fake = fakeBuilder()
    fake.failWith.set("broken", () => Effect.fail(new ResourceBuildError({ message: "no key" })))
    const pool = await makePool({ buildLlm: fake.build, graceMs: 60_000 })
    await run(pool.reconcile(wanted({ a: spec("broken") })))
    expect(pool.status()).toMatchObject([{ state: "failed", problem: "no key" }])
    await run(pool.reconcile(wanted({})))
    expect(pool.status()).toEqual([])
    expect(pool.llmFor("a")).toBeUndefined()
  })

  it("an assistant that leaves while its instance is still being built does not leave a running instance behind", async () => {
    const fake = fakeBuilder()
    const gate = Deferred.makeUnsafe<void>()
    fake.holds.set("slow", gate)
    const pool = await makePool({ buildLlm: fake.build, graceMs: 20 })
    const first = run(pool.reconcile(wanted({ a: spec("slow") })))
    await sleep(10)
    await run(pool.reconcile(wanted({})))
    Deferred.doneUnsafe(gate, Exit.void)
    await first
    await sleep(80)
    expect(pool.status()).toEqual([])
    // Whatever the build produced is closed: the finalizer it registered ran (or it never registered one).
    expect(fake.released.length).toBe(fake.builds.length)
  })

  it("a changed model that fails to build leaves the assistant on its working instance, and the failure is its own resource", async () => {
    const fake = fakeBuilder()
    fake.failWith.set("bad", () => Effect.fail(new ResourceBuildError({ message: "bad model" })))
    const pool = await makePool({ buildLlm: fake.build, graceMs: 20 })
    await run(pool.reconcile(wanted({ a: spec("good") })))
    await run(pool.reconcile(wanted({ a: spec("bad") })))
    // The new instance settled as failed: the assistant is bound to it and gets its problem on the next turn.
    expect(pool.keyFor("a")).toBe(llmKeyOf(spec("bad")))
    await expect(ask(pool.llmFor("a"))).rejects.toThrow("bad model")
    // Switching back to the working configuration within the grace period needs no new build.
    await run(pool.reconcile(wanted({ a: spec("good") })))
    expect(await ask(pool.llmFor("a"))).toBe("good#1")
    expect(fake.builds).toEqual(["good", "bad"])
  })
})

describe("resource pool: error paths", () => {
  it("a build that dies with a defect is a failed resource with that message, not a crashed pool", async () => {
    const fake = fakeBuilder()
    fake.failWith.set("boom", () => Effect.die(new Error("native module missing")) as never)
    const pool = await makePool({ buildLlm: fake.build })
    await run(pool.reconcile(wanted({ a: spec("boom"), b: spec("fine") })))
    expect(pool.status().find((r) => r.usedBy.includes("a"))).toMatchObject({ state: "failed", problem: "native module missing" })
    expect(pool.status().find((r) => r.usedBy.includes("b"))).toMatchObject({ state: "ready" })
    const error = await ask(pool.llmFor("a")).catch((e) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(error.message).toBe("native module missing")
  })

  it("a build that dies with something that is not an Error still reports a problem", async () => {
    const fake = fakeBuilder()
    fake.failWith.set("odd", () => Effect.die("plain string") as never)
    const pool = await makePool({ buildLlm: fake.build })
    await run(pool.reconcile(wanted({ a: spec("odd") })))
    expect(pool.status()).toMatchObject([{ state: "failed", problem: "plain string" }])
  })

  it("a builder that throws synchronously is a failed resource", async () => {
    const pool = await makePool({
      buildLlm: () => {
        throw new Error("builder exploded")
      }
    })
    await run(pool.reconcile(wanted({ a: spec("m") })))
    expect(pool.status()).toMatchObject([{ state: "failed", problem: "builder exploded" }])
  })

  it("a failed instance is not rebuilt by an ordinary reconcile, and `retryFailed` leaves a working instance alone", async () => {
    const fake = fakeBuilder()
    fake.failWith.set("broken", () => Effect.fail(new ResourceBuildError({ message: "no key" })))
    const pool = await makePool({ buildLlm: fake.build })
    await run(pool.reconcile(wanted({ a: spec("broken"), b: spec("fine") })))
    await run(pool.reconcile(wanted({ a: spec("broken"), b: spec("fine") })))
    expect(fake.builds).toEqual(["broken", "fine"])
    await run(pool.reconcile(wanted({ a: spec("broken"), b: spec("fine") }), { retryFailed: true }))
    // Only the failed one is built again.
    expect(fake.builds).toEqual(["broken", "fine", "broken"])
  })

  it("`explainProblem` rewords the status only; the turn's error keeps the raw message", async () => {
    const fake = fakeBuilder()
    fake.failWith.set("broken", () => Effect.fail(new ResourceBuildError({ message: "ANTHROPIC_API_KEY is not set" })))
    const pool = await makePool({ buildLlm: fake.build, explainProblem: () => "Unlock the vault." })
    await run(pool.reconcile(wanted({ a: spec("broken") })))
    expect(pool.status()).toMatchObject([{ problem: "Unlock the vault." }])
    await expect(ask(pool.llmFor("a"))).rejects.toThrow("ANTHROPIC_API_KEY is not set")
  })

  it("a throwing `onChange` listener breaks nothing, and `onChange` fires only when the status is different", async () => {
    const fake = fakeBuilder()
    let calls = 0
    const pool = await makePool({
      buildLlm: fake.build,
      onChange: () => {
        calls++
        throw new Error("listener bug")
      }
    })
    await run(pool.reconcile(wanted({ a: spec("m") })))
    expect(pool.status()).toMatchObject([{ state: "ready" }])
    const afterFirst = calls
    expect(afterFirst).toBeGreaterThan(0)
    await run(pool.reconcile(wanted({ a: spec("m") })))
    expect(calls).toBe(afterFirst)
  })
})

describe("resource pool: shutdown", () => {
  it("closing the pool releases every instance, builds still running included, and later reconciles do nothing", async () => {
    const fake = fakeBuilder()
    const gate = Deferred.makeUnsafe<void>()
    fake.holds.set("slow", gate)
    const pool = await makePool({ buildLlm: fake.build, graceMs: 60_000 })
    await run(pool.reconcile(wanted({ a: spec("one") })))
    await run(pool.reconcile(wanted({})))
    expect(fake.released).toEqual([])
    await Effect.runPromise(Scope.close(scope!, Exit.void))
    scope = undefined
    expect(fake.released).toEqual(["one#1"])
    expect(pool.status()).toEqual([])
    await run(pool.reconcile(wanted({ a: spec("two") })))
    expect(fake.builds).toEqual(["one"])
    expect(pool.llmFor("a")).toBeUndefined()
  })
})

describe("resource pool: spec, key, label and config", () => {
  it("an empty address is the default endpoint; a credential stamp changes the instance but never the key", () => {
    const base = llmSpecOf(anthropic("m"), { anthropic: { address: "" } })
    expect(base.address).toBe("https://api.anthropic.com")
    expect(llmKeyOf(llmSpecOf(anthropic("m"), { anthropic: { address: "", credential: "a" } }))).toBe(llmKeyOf(llmSpecOf(anthropic("m"), { anthropic: { credential: "b" } })))
  })

  it("an address that is not a URL is never shown", () => {
    const key = llmKeyOf(llmSpecOf(anthropic("m"), { anthropic: { address: "not a url with secret" } }))
    expect(key).toContain("(invalid address)")
    expect(key).not.toContain("secret")
  })

  it("accounts other than Anthropic and the offline ones are keyed by account and model", () => {
    const openrouter = llmSpecOf({ ...anthropic("some/model"), account: "openrouter" })
    expect(llmKeyOf(openrouter)).toBe("openrouter|some/model")
    expect(llmKeyOf(llmSpecOf({ ...anthropic("a/b"), account: "home-model" }))).toBe("home-model|a/b")
  })

  it("the adapter's settings follow the spec: thinking is adaptive or disabled, the address only when there is one", () => {
    expect(llmConfigOf(llmSpecOf(anthropic("m", { thinking: "adaptive", warmUp: false, giveUpMs: 900 }), { anthropic: { address: "http://proxy:1/" } }))).toMatchObject({
      ANTHROPIC_MODEL: "m",
      ANTHROPIC_THINKING: "adaptive",
      ANTHROPIC_WARM_UP: "false",
      ANTHROPIC_TIMEOUT_MS: "900",
      ANTHROPIC_BASE_URL: "http://proxy:1/"
    })
    expect(llmConfigOf(spec("m"))).toMatchObject({ ANTHROPIC_THINKING: "disabled", ANTHROPIC_WARM_UP: "true", ANTHROPIC_MAX_TOKENS: "1024" })
    expect(llmConfigOf(llmSpecOf({ ...anthropic(""), account: "offline" }))).toEqual({})
  })

  it("labels say what the instance is without exposing anything secret", () => {
    expect(llmLabelOf(spec("claude-haiku-5-5"))).toBe("Claude API claude-haiku-5-5 (low effort, thinking off, 1024 tokens)")
    expect(llmLabelOf(llmSpecOf({ ...anthropic(""), account: "offline" }))).toBe("Offline stand-in")
    expect(llmLabelOf(llmSpecOf({ ...anthropic("m/x"), account: "openrouter" }))).toBe("OpenRouter m/x")
  })
})
