// Review round 3 of PR 90 (P3 in the module host): the secret boundary's restated contract (the host never puts a
// secret on a page by construction; module-written text passes an exact safety net), press ownership at shutdown,
// record items, bounds, route declarations and buttons that are not buttons.
import { assert, describe, it } from "@effect/vitest"
import {
  MAX_COMBO_OPTIONS,
  MAX_OPTIONS_JSON,
  ModuleInfo,
  RecordsField,
  SettingField,
  SettingValue,
  TextListField
} from "@pva/protocol"
import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { defineAgent } from "../src/ModuleContributions.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, MAX_PRESS_STRAGGLERS, readOnlyPersistence } from "../src/ModuleHost.ts"
import { type ModuleRoute, RouteTokenError, routeProblem, type RouteTokenStore } from "../src/ModuleRoutes.ts"
import { makePageBoundary, MAX_REMEMBERED, OVERFLOW, REDACTED, TOO_LONG } from "../src/PageBoundary.ts"
import { resolveSettings, Setting } from "../src/Settings.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))
const ok: ModuleRoute["handler"] = () => Effect.succeed({ status: 200 })
const textOf = (r: { readonly ok: boolean; readonly result?: { readonly text: string } }) => (r.ok ? r.result!.text : "")

describe("rule 1: what the host produces from settings carries no secret, by construction", () => {
  it.effect("3a-1: an environment value is never quoted in a form error; a field check's message passes the boundary", () =>
    Effect.gen(function*() {
      const SECRET = "private-token"
      const mod = defineModule({
        id: "picky",
        name: "Picky",
        description: "Closed combo",
        settings: {
          token: Setting.secret({ label: "Token" }),
          pick: Setting.combo({ label: "Pick", default: "a", env: "PICK", allowCustom: false, options: [{ value: "a", label: "A" }] }),
          own: Setting.text({ label: "Own", default: "x", overridable: true, check: (v) => (v === "x" || v === "y" ? undefined : `${v} with ${SECRET} is wrong`) })
        },
        start: () => Effect.succeed({})
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { picky: { enabled: true } }, secrets: { picky: { token: SECRET } } }),
        env: { PICK: SECRET }
      })
      const page = JSON.stringify(host.modules())
      assert.notInclude(page, SECRET)
      assert.include(page, "PICK in the environment is not valid: Must be one of: a")
      // An assistant's own value refused by the module's own check: the message passes the boundary.
      const refused = host.checkOwn("picky", { own: "z" })
      assert.deepStrictEqual(refused, [{ key: "own", message: `z with ${REDACTED} is wrong` }])
    }))

  it.effect("the generated agent Test never transforms the answer before the boundary sees it (3a-7)", () =>
    Effect.gen(function*() {
      for (const [secret, deltas] of [
        [" prefix-token ", ["My key:", " prefix-token ", "!"]],
        ["alpha beta", ["alpha", " ", "beta"]]
      ] as const) {
        const agent = defineAgent({
          id: "talker",
          name: "Talker",
          description: "Talks",
          kind: "model",
          settings: { key: Setting.secret({ label: "Key", required: true }) },
          enabledByDefault: true,
          start: () => Effect.succeed({ turn: () => Stream.fromIterable(deltas.map((text) => ({ _tag: "TextDelta" as const, text }))) })
        })
        const host = yield* makeModuleHost({
          catalog: [agent],
          persistence: readOnlyPersistence({ modules: { talker: { enabled: true } }, secrets: { talker: { key: secret } } }),
          env: {}
        })
        yield* host.startEnabled
        const text = textOf(yield* host.fieldAction("talker", "test"))
        assert.notInclude(text, secret.trim(), secret)
        assert.notInclude(text, "alphabeta")
        assert.include(text, REDACTED, secret)
      }
    }))
})

describe("rule 3: the boundary's exact contract", () => {
  it("replaces every exact occurrence of any length, merging overlaps, and nothing else (3a-2)", () => {
    const b = makePageBoundary({ current: () => ["abc", "t"] })
    assert.strictEqual(b.redact("m", "x abc y"), `x ${REDACTED} y`)
    // A one-letter secret is replaced wherever it occurs: heavily redacted text is correct.
    assert.strictEqual(b.redact("m", "tot"), `${REDACTED}o${REDACTED}`)
    // Case-sensitive, exact: "ABC" is not the value.
    assert.strictEqual(b.redact("m", "ABC"), "ABC")
    const o = makePageBoundary({ current: () => ["abcd", "cdef"] })
    // Overlapping occurrences: no part of either is left.
    assert.strictEqual(o.redact("m", "xabcdefx"), `x${REDACTED}x`)
  })

  it("matches before clipping, and never checks part of a text: a text too long to check is not shown", () => {
    const b = makePageBoundary({ current: () => ["0123456789"] })
    assert.strictEqual(b.text("m", `${"x".repeat(8)}0123456789`, 12), `xxxxxxxx${REDACTED}`.slice(0, 11) + "…")
    assert.strictEqual(b.text("m", "y".repeat(70_000), 100), TOO_LONG)
  })

  it("keeps a value while any holder lives, forgets it after; at the cap it hides the module's texts instead of forgetting (3a-3)", () => {
    const b = makePageBoundary({ current: () => [] })
    const part = {}
    const press = {}
    b.remember("m", part, ["S0"])
    b.remember("m", press, ["S0", "S1"])
    b.release(press)
    // S0 is still held by the part; S1 only by the press, which has ended.
    assert.strictEqual(b.redact("m", "S0 S1"), `${REDACTED} S1`)
    // No count-based eviction: S0 survives any number of other values.
    const others = {}
    b.remember("m", others, Array.from({ length: MAX_REMEMBERED - 1 }, (_, i) => `v${i}-value`))
    assert.strictEqual(b.redact("m", "S0"), REDACTED)
    // One more distinct value than the cap: the module fails closed while its holder lives.
    const late = {}
    b.remember("m", late, ["one-too-many"])
    assert.strictEqual(b.redact("m", "anything"), OVERFLOW)
    assert.deepStrictEqual(b.options("m", [{ value: "x", label: "X" }]), [])
    b.release(late)
    assert.strictEqual(b.redact("m", "anything S0"), `anything ${REDACTED}`)
    // Another module is not affected.
    assert.strictEqual(b.redact("other", "S0"), "S0")
  })

  it.effect("a live instance's key stays redacted through 70 rotations and a vault lock (3a-3)", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        id: "rot",
        name: "Rot",
        description: "Echoes its key",
        settings: {
          token: Setting.secret({ label: "Token", required: true }),
          state: Setting.info({ label: "Now" }),
          ping: Setting.action({ label: "Ping", buttonLabel: "Ping" })
        },
        fieldActions: { ping: ({ settings }) => Effect.succeed({ ok: true, text: `ping ${String(settings.token).length}` }) },
        start: ({ settings }) => Effect.succeed({ info: () => ({ state: `Signed in with ${settings.token}` }) })
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { rot: { enabled: true } }, secrets: {} }),
        env: {}
      })
      yield* host.startEnabled
      // The key comes from the vault only (nothing saved holds it): the running instance is its only holder.
      yield* host.setSecrets({ rot: { token: "S0-original-key" } })
      assert.strictEqual(host.modules()[0]!.state, "running")
      for (let i = 1; i <= 70; i++) {
        yield* host.setSecrets({ rot: { token: `S${i}-rotated-key` } })
        yield* host.fieldAction("rot", "ping")
      }
      yield* host.setSecrets({})
      const page = JSON.stringify(host.modules())
      assert.notInclude(page, "S0-original-key")
      assert.include(page, `Signed in with ${REDACTED}`)
    }))

  it.effect("a route path or token name that holds a secret is not shown as is (3a-4)", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        apiVersion: 2,
        id: "pathy",
        name: "Pathy",
        description: "Puts its key in a path",
        settings: { token: Setting.secret({ label: "Token", required: true }) },
        shared: ({ settings }) =>
          Effect.succeed({
            value: undefined,
            routes: [
              { method: "GET", path: `callback/${settings.token}`, public: true, handler: ok },
              { method: "POST", path: "hook", guards: ["token"], token: String(settings.token), handler: ok }
            ]
          }),
        start: () => Effect.succeed({})
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { pathy: { enabled: true } }, secrets: { pathy: { token: "abcd1234" } } }),
        env: {}
      })
      yield* host.startEnabled
      const routes = host.modules()[0]!.routes ?? []
      assert.deepStrictEqual(routes.map((r) => r.path), [`/api/modules/pathy/callback/${REDACTED}`, "/api/modules/pathy/hook"])
      assert.isUndefined(routes[1]!.token)
      assert.notInclude(JSON.stringify(host.modules()), "abcd1234")
      // The live route itself is unchanged.
      assert.strictEqual(host.routes()[0]!.route.path, "callback/abcd1234")
    }))

  it.effect("a token the module mints through host.routeTokens is remembered while its part lives (3a-5)", () =>
    Effect.gen(function*() {
      const store: RouteTokenStore = {
        forModule: (moduleId) => ({
          mint: (name, label) =>
            Effect.succeed({ token: { id: "0123456789ab", moduleId, name, label, createdAt: 0 }, secret: "minted-bearer-secret" }),
          list: Effect.succeed([]),
          revoke: () => Effect.fail(new RouteTokenError({ reason: "failed", message: "no" }))
        })
      }
      const mod = defineModule({
        apiVersion: 2,
        id: "minter",
        name: "Minter",
        description: "Mints and talks",
        settings: { state: Setting.info({ label: "Now" }) },
        shared: ({ host }) => host.routeTokens.mint("hook", "Mine").pipe(Effect.orDie, Effect.map((m) => ({ value: m.secret }))),
        start: ({ shared }) => Effect.succeed({ info: () => ({ state: `Token ${String(shared)}` }) })
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { minter: { enabled: true } }, secrets: {} }),
        env: {},
        routeTokens: store
      })
      yield* host.startEnabled
      const page = JSON.stringify(host.modules())
      assert.notInclude(page, "minted-bearer-secret")
      assert.include(page, `Token ${REDACTED}`)
    }))
})

describe("presses at shutdown (3a-8, 3a-9)", () => {
  it.effect("an instance's press is stopped before the shared part's resources are released", () =>
    Effect.gen(function*() {
      const seen: Array<boolean> = []
      const mod = defineModule({
        apiVersion: 2,
        id: "sockets",
        name: "Sockets",
        description: "A shared socket",
        settings: { use: Setting.action({ label: "Use", buttonLabel: "Use" }) },
        shared: () =>
          Effect.map(
            Effect.acquireRelease(Effect.sync(() => ({ open: true })), (s) => Effect.sync(() => void (s.open = false))),
            (socket) => ({ value: socket })
          ),
        start: ({ shared }) =>
          Effect.succeed({
            fieldActions: {
              // Its cleanup takes a moment and uses the shared socket.
              use: () =>
                Effect.never.pipe(
                  Effect.onInterrupt(() => Effect.andThen(Effect.sleep(500), Effect.sync(() => seen.push((shared as { open: boolean }).open))))
                )
            }
          })
      })
      const scope = yield* Scope.make()
      const host = yield* makeModuleHost({ catalog: [mod], persistence: readOnlyPersistence({ modules: { sockets: { enabled: true } }, secrets: {} }), env: {} }).pipe(
        Scope.provide(scope)
      )
      yield* host.startEnabled
      yield* Effect.forkChild(host.fieldAction("sockets", "use"))
      yield* advance(10)
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* advance(1_000)
      yield* Fiber.join(closing)
      assert.deepStrictEqual(seen, [true])
    }))

  it.effect("no definition press is admitted once shutdown has begun, even a module's first", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []
      const slow = defineModule({
        id: "slow",
        name: "Slow",
        description: "Slow cleanup",
        settings: { go: Setting.action({ label: "Go", buttonLabel: "Go" }) },
        fieldActions: { go: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sleep(1_000))) },
        start: () => Effect.succeed({})
      })
      const fresh = defineModule({
        id: "fresh",
        name: "Fresh",
        description: "Never pressed",
        settings: { go: Setting.action({ label: "Go", buttonLabel: "Go" }) },
        fieldActions: { go: () => Effect.sync(() => void ran.push("fresh")).pipe(Effect.as({ ok: true, text: "ran" })) },
        start: () => Effect.succeed({})
      })
      const scope = yield* Scope.make()
      const host = yield* makeModuleHost({ catalog: [slow, fresh], persistence: readOnlyPersistence(), env: {} }).pipe(Scope.provide(scope))
      yield* Effect.forkChild(host.fieldAction("slow", "go"))
      yield* advance(10)
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* advance(100)
      // The host is stopping (waiting for slow's cleanup): fresh's first press is refused and never runs.
      assert.deepStrictEqual(yield* host.fieldAction("fresh", "go"), { ok: false, code: "not_running", message: "The assistant is stopping" })
      yield* advance(2_000)
      yield* Fiber.join(closing)
      assert.deepStrictEqual(ran, [])
      // After the host has closed too.
      assert.isFalse((yield* host.fieldAction("fresh", "go")).ok)
      assert.deepStrictEqual(ran, [])
    }))

  it.effect("presses that do not stop are capped per module: further presses are refused and Health says why (3b-3 for buttons)", () =>
    Effect.gen(function*() {
      const settings: Record<string, ReturnType<typeof Setting.action>> = {}
      const fieldActions: Record<string, () => Effect.Effect<{ ok: boolean; text: string }>> = {}
      for (let i = 0; i <= MAX_PRESS_STRAGGLERS; i++) {
        settings[`b${i}`] = Setting.action({ label: `B${i}`, buttonLabel: "Go" })
        fieldActions[`b${i}`] = () => Effect.as(Effect.uninterruptible(Effect.never), { ok: true, text: "never" })
      }
      const mod = defineModule({ id: "stuck", name: "Stuck", description: "Never stops", settings, fieldActions, start: () => Effect.succeed({}) })
      const scope = yield* Scope.make()
      const host = yield* makeModuleHost({ catalog: [mod], persistence: readOnlyPersistence(), env: {}, closeTimeoutMs: 100 }).pipe(Scope.provide(scope))
      for (let i = 0; i < MAX_PRESS_STRAGGLERS; i++) {
        const press = yield* Effect.forkChild(host.fieldAction("stuck", `b${i}`))
        yield* advance(8_000)
        assert.match(textOf(yield* Fiber.join(press)), /Did not finish/)
      }
      yield* advance(10_000)
      const refused = yield* host.fieldAction("stuck", `b${MAX_PRESS_STRAGGLERS}`)
      assert.deepStrictEqual(refused.ok ? undefined : refused.code, "busy")
      assert.match(refused.ok ? "" : refused.message, /have not stopped yet/)
      const issue = host.issues.all().find((i) => i.id === "stuck.presses-stuck")
      assert.strictEqual(issue?.severity, "error")
      // Closing the host gives up on them after its limit (they never end).
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* advance(1_000)
      yield* Fiber.join(closing)
    }))
})

describe("presses and route handlers in the one-worker host (merge with P1 round 3)", () => {
  it.effect("a press in flight gets the grace period when its module stops; one that never stops cannot hold the worker", () =>
    Effect.gen(function*() {
      const mode = { current: "quick" as "quick" | "stuck" }
      const mod = defineModule({
        apiVersion: 2,
        id: "presser",
        name: "Presser",
        description: "Presses",
        settings: { go: Setting.action({ label: "Go", buttonLabel: "Go" }) },
        shared: () => Effect.succeed({ value: undefined }),
        start: () =>
          Effect.succeed({
            fieldActions: {
              go: () =>
                mode.current === "quick"
                  ? Effect.as(Effect.sleep(300), { ok: true, text: "done" })
                  : Effect.as(Effect.uninterruptible(Effect.never), { ok: true, text: "never" })
            }
          })
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { presser: { enabled: true } }, secrets: {} }),
        env: {},
        graceMs: 1_000,
        stopTimeoutMs: 500
      })
      yield* host.startEnabled
      // Within the grace period: the press ends on its own and is answered.
      const quick = yield* Effect.forkChild(host.fieldAction("presser", "go"))
      yield* advance(10)
      const disabled = yield* Effect.forkChild(host.disable("presser"))
      yield* advance(10)
      // Withdrawn at once: no new press reaches it.
      assert.deepStrictEqual((yield* host.fieldAction("presser", "go")).ok, false)
      yield* advance(400)
      assert.deepStrictEqual(textOf(yield* Fiber.join(quick)), "done")
      assert.isTrue((yield* Fiber.join(disabled)).ok)
      // A press that never stops: the grace period, then the part's close limit, then the part is abandoned and the
      // worker goes on (the module starts again).
      assert.isTrue((yield* host.enable("presser")).ok)
      mode.current = "stuck"
      yield* Effect.forkChild(host.fieldAction("presser", "go"))
      yield* advance(10)
      const stopped = yield* Effect.forkChild(host.disable("presser"))
      yield* advance(1_000)
      yield* advance(600)
      assert.isTrue((yield* Fiber.join(stopped)).ok)
      assert.isTrue(host.issues.all().some((i) => i.id.startsWith("presser.problem.") && /did not finish stopping/.test(i.title)))
      assert.isTrue((yield* host.enable("presser")).ok)
      assert.strictEqual(host.modules()[0]!.state, "running")
    }))

  it.effect("a route handler runs as a call in flight: refused once withdrawn, given the grace period, and one that never stops cannot hold the worker", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        apiVersion: 2,
        id: "web",
        name: "Web",
        description: "Routes",
        shared: () =>
          Effect.succeed({
            value: undefined,
            routes: [
              { method: "GET", path: "quick", public: true, handler: () => Effect.as(Effect.sleep(300), { status: 200 }) },
              { method: "GET", path: "stuck", public: true, handler: () => Effect.as(Effect.uninterruptible(Effect.never), { status: 200 }) }
            ] satisfies ReadonlyArray<ModuleRoute>
          }),
        start: () => Effect.succeed({})
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { web: { enabled: true } }, secrets: {} }),
        env: {},
        graceMs: 1_000,
        stopTimeoutMs: 500
      })
      yield* host.startEnabled
      // As the app's router runs a handler: forked into the shared part's scope.
      const call = (path: string) =>
        Effect.gen(function*() {
          const live = host.routes().find((r) => r.route.path === path)!
          return yield* Effect.forkIn(Effect.suspend(() => live.route.handler({} as never)), live.scope)
        })
      const quick = yield* call("quick")
      yield* advance(10)
      const disabled = yield* Effect.forkChild(host.disable("web"))
      yield* advance(10)
      assert.deepStrictEqual(host.routes(), [])
      yield* advance(400)
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(quick)))
      assert.isTrue((yield* Fiber.join(disabled)).ok)
      assert.isTrue((yield* host.enable("web")).ok)
      const stuck = yield* call("stuck")
      yield* advance(10)
      const stopped = yield* Effect.forkChild(host.disable("web"))
      yield* advance(1_000)
      yield* advance(600)
      assert.isTrue((yield* Fiber.join(stopped)).ok)
      assert.isUndefined(stuck.pollUnsafe())
      assert.isTrue(host.issues.all().some((i) => i.id.startsWith("web.problem.") && /did not finish stopping/.test(i.title)))
      assert.isTrue((yield* host.enable("web")).ok)
      assert.strictEqual(host.routes().length, 2)
    }))
})

describe("records, bounds and declarations", () => {
  it("3a-10: an omitted record key goes through its field's decoder and check, like a given one", () => {
    const rooms = Setting.records({
      label: "Rooms",
      itemLabel: "room",
      titleKey: "name",
      item: {
        name: Setting.text({ label: "Name", default: "", check: (v) => (v.trim() ? undefined : "Name required") }),
        floor: Setting.number({ label: "Floor", default: 0, integer: true })
      }
    })
    assert.deepStrictEqual(rooms.decode([{ name: "" }]), { ok: false, error: "Room 1, Name: Name required" })
    assert.deepStrictEqual(rooms.decode([{}]), { ok: false, error: "Room 1, Name: Name required" })
    assert.deepStrictEqual(rooms.decode([{ name: "Hall" }]), { ok: true, value: [{ name: "Hall", floor: 0 }] })
    // On every path a value arrives by: saved values too.
    const resolved = resolveSettings({ rooms }, { stored: { rooms: [{ floor: 1 }] }, secrets: {}, env: {} })
    assert.isUndefined(resolved.value)
  })

  it("3a-11: the protocol bounds every new list, record and string, and the constructors refuse what does not fit", () => {
    const decodes = (schema: Schema.Codec<any, any>, value: unknown) => Exit.isSuccess(Schema.decodeUnknownExit(schema as never)(value))
    assert.isFalse(decodes(SettingValue, Array.from({ length: 300 }, () => ({ a: "x" }))))
    assert.isFalse(decodes(SettingValue, [{ a: "x".repeat(40_000) }]))
    const field = Setting.textList({ label: "Aliases" }).describe("aliases")
    assert.isTrue(decodes(TextListField, { ...field, source: "default" }))
    assert.isFalse(decodes(TextListField, { ...field, maxItems: -1 }))
    assert.isFalse(decodes(TextListField, { ...field, default: Array.from({ length: 201 }, (_, i) => `a${i}`) }))
    const records = Setting.records({ label: "R", itemLabel: "r", titleKey: "n", item: { n: Setting.text({ label: "N" }) } }).describe("r")
    assert.isFalse(decodes(RecordsField, { ...records, itemLabel: "x".repeat(61) }))
    assert.isFalse(decodes(SettingField, { ...Setting.combo({ label: "C", default: "a" }).describe("c"), options: Array.from({ length: 201 }, (_, i) => ({ value: `v${i}`, label: "L" })) }))
    assert.throws(() => Setting.textList({ label: "Bad", maxItems: -1 }), /maxItems/)
    assert.throws(() => Setting.textList({ label: "Bad", itemMaxLength: 100_000 }), /itemMaxLength/)
    assert.throws(() => Setting.records({ label: "Bad", itemLabel: "r", titleKey: "n", maxItems: 0, item: { n: Setting.text({ label: "N" }) } }), /maxItems/)
    assert.throws(() => Setting.combo({ label: "Bad", default: "a", maxLength: 0 }), /maxLength/)
    assert.throws(() => Setting.action({ label: "x".repeat(300), buttonLabel: "Go" }), /label/)
  })

  it.effect("3a-11: a module's 10 000 runtime options reach the page within the wire's bounds", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        id: "many",
        name: "Many",
        description: "Lots of options",
        settings: { model: Setting.combo({ label: "Model", default: "a", options: [{ value: "a", label: "A" }] }) },
        start: () =>
          Effect.succeed({
            settingOptions: () => ({ model: Array.from({ length: 10_000 }, (_, i) => ({ value: `m${i}`, label: "l".repeat(200), description: "d".repeat(400) })) })
          })
      })
      const host = yield* makeModuleHost({ catalog: [mod], persistence: readOnlyPersistence({ modules: { many: { enabled: true } }, secrets: {} }), env: {} })
      yield* host.startEnabled
      const info = host.modules()[0]!
      const combo = info.settings.fields.find((f) => f.key === "model")!
      const options = combo.type === "combo" ? combo.options : []
      assert.isAtMost(options.length, MAX_COMBO_OPTIONS)
      assert.isAtMost(JSON.stringify(options).length, MAX_OPTIONS_JSON)
      assert.strictEqual(options[0]!.value, "a")
      assert.isTrue(Exit.isSuccess(Schema.encodeUnknownExit(ModuleInfo as never)(info)))
      const picker = host.settingOptions("many")?.["model"] ?? []
      assert.isAtMost(JSON.stringify(picker).length, MAX_OPTIONS_JSON)
    }))

  it("3a-12: a route with an unknown body mode is refused before it is published", () => {
    const route = { method: "POST", path: "hook", guards: ["lan"], body: "typo", handler: ok } as unknown as ModuleRoute
    assert.match(routeProblem([route]) ?? "", /unknown body mode/)
  })

  it.effect("3a-13: a handler without an action field is not a button", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []
      const mod = defineModule({
        id: "leftover",
        name: "Leftover",
        description: "A handler without a field",
        settings: {},
        fieldActions: { wipe: () => Effect.sync(() => void ran.push("wipe")).pipe(Effect.as({ ok: true, text: "wiped" })) },
        start: () => Effect.succeed({ fieldActions: { wipe: () => Effect.sync(() => void ran.push("instance wipe")).pipe(Effect.as({ ok: true, text: "wiped" })) } })
      })
      const host = yield* makeModuleHost({ catalog: [mod], persistence: readOnlyPersistence({ modules: { leftover: { enabled: true } }, secrets: {} }), env: {} })
      yield* host.startEnabled
      const r = yield* host.fieldAction("leftover", "wipe")
      assert.deepStrictEqual(r, { ok: false, code: "unknown_action", message: `Leftover has no action "wipe"` })
      assert.deepStrictEqual(ran, [])
    }))
})
