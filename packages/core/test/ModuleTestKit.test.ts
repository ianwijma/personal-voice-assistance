// The module test kit (docs/MODULES.md, "Testing"): a module in the real host as serve mode runs it, its turns
// admitted by the real gateway, stubs for the modules it uses, the core's privacy rule over a household fixed for the
// test, and its lifecycle. The reference module's test (packages/module-contracts/test/kit) uses every handle on a real
// module.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"
import { defineAction } from "../src/Actions.ts"
import { defineCollection } from "../src/HouseholdStore.ts"
import { ContributionKey, ServiceKey } from "../src/ModuleApi.ts"
import { makeTool } from "../src/Module.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { People } from "../src/People.ts"
import { Privacy } from "../src/Privacy.ts"
import { Setting } from "../src/Settings.ts"
import { CurrentTurn, makeConnectionRef } from "../src/TurnContext.ts"
import {
  DEFAULT_TEST_START,
  dietProblem,
  KIT_WAIT_CAP_MS,
  expectOffByDefault,
  makeTestPeople,
  makeTestTurn,
  provide,
  returns,
  startTestModule,
  stops,
  stubService,
  succeeds,
  takeUnprogrammedStubCalls,
  UnprogrammedStubCall
} from "../src/testing.ts"

interface Greeter {
  readonly greet: (name: string) => string
}
const Greeters = ServiceKey<Greeter>("greeter")
const Lines = ContributionKey<string>("test.lines")

/** A module that uses a service and contributions of others, and says who asks. */
const asker = defineModule({
  apiVersion: 2,
  id: "asker",
  name: "Asker",
  description: "Uses other modules.",
  enabledByDefault: false,
  start: (ctx) =>
    Effect.succeed({
      tools: [
        makeTool({
          name: "asker_who",
          description: "Who is asking, and what the greeter says.",
          parameters: Schema.Struct({}),
          speculative: true,
          execute: () =>
            Effect.gen(function*() {
              const turn = yield* CurrentTurn
              const greeter = ctx.host.service(Greeters)
              const lines = yield* ctx.host.contributions(Lines)
              const person = turn?.person === undefined ? undefined : ctx.host.service(People)?.get(turn.person.id)?.name
              return { device: turn?.deviceId, room: turn?.room, person, greeting: greeter?.greet(person ?? "you") ?? "the greeter is off", lines }
            })
        })
      ]
    })
})

describe("startTestModule", () => {
  it.effect("runs a tool as a turn of the household's device, with a stub for the module it uses", () =>
    Effect.gen(function*() {
      const greeter = stubService<Greeter>("greeter", { greet: (n) => `Hello ${n}` })
      const kit = yield* startTestModule(asker, { provide: [provide("greeter", { services: [Greeters.of(greeter.service)], contributions: [Lines.of("from the greeter")] })] })
      assert.strictEqual(yield* kit.now, DEFAULT_TEST_START)
      const r = yield* kit.tool("asker_who", {})
      assert.deepStrictEqual(r.value, { device: "kitchen-display", room: "Kitchen", person: "Sam", greeting: "Hello Sam", lines: ["from the greeter"] })
      // On the public hall screen nobody is the default person.
      const hall = yield* kit.tool("asker_who", {}, { device: "hall-screen" })
      assert.deepStrictEqual(hall.value, { device: "hall-screen", room: "Hall", greeting: "Hello you", lines: ["from the greeter"] })
      assert.deepStrictEqual(greeter.calls.greet, [["Sam"], ["you"]])
    }))

  it.effect("contributions follow the turn's assistant; a service is there while any assistant has its provider on", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(asker, {
        provide: [provide("greeter", { services: [Greeters.of({ greet: () => "hi" })], contributions: [Lines.of("line")] })],
        household: {
          assistants: [{ id: "jeff" }, { id: "plain", modules: { greeter: false } }],
          devices: [{ id: "kitchen-display", name: "Kitchen", room: "Kitchen", assistants: ["jeff", "plain"] }]
        }
      })
      assert.deepStrictEqual(yield* kit.contributions(Lines, { assistant: "jeff" }), ["line"])
      assert.deepStrictEqual(yield* kit.contributions(Lines, { assistant: "plain" }), [])
      const plain = yield* kit.tool("asker_who", {}, { assistant: "plain" })
      assert.strictEqual((plain.value as { greeting: string }).greeting, "hi")
    }))

  it.effect("a stand-in no assistant has on is not running: the consumer finds no service and says the other module is off", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(asker, {
        provide: [provide("greeter", { services: [Greeters.of({ greet: () => "hi" })] })],
        household: { assistants: [{ id: "jeff", modules: { greeter: false } }] }
      })
      assert.isUndefined(kit.service(Greeters))
      const r = yield* kit.tool("asker_who", {})
      assert.strictEqual((r.value as { greeting: string }).greeting, "the greeter is off")
    }))

  it.effect("the gateway refuses what serve mode refuses: an unknown device, an assistant not on the device, a person who is not its default, another device's connection", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(asker, {
        household: { assistants: [{ id: "jeff" }, { id: "other" }], devices: [{ id: "kitchen-display", name: "Kitchen", assistants: ["jeff"], defaultPerson: "p-sam" }, { id: "hall-screen", name: "Hall" }] }
      })
      const unknown = yield* kit.tool("asker_who", {}, makeTestTurn({ device: "nowhere-device" }))
      assert.match(unknown.content, /^Not run: .*not known/)
      const offDevice = yield* kit.tool("asker_who", {}, { assistant: "other" })
      assert.match(offDevice.content, /^Not run: .*not on the device/)
      const notDefault = yield* kit.tool("asker_who", {}, { person: "p-robin" })
      assert.match(notDefault.content, /^Not run: .*default person/)
      // Every turn the kit makes comes in on its device's connection; a whole turn with another device's is refused.
      assert.strictEqual(kit.turn().connection?.id, kit.turn({ device: "kitchen-display" }).connection?.id)
      const foreign = { ...kit.turn(), connection: kit.turn({ device: "hall-screen" }).connection! }
      assert.match((yield* kit.tool("asker_who", {}, foreign)).content, /^Not run: the request did not come from the device "kitchen-display"/)
      const stray = { ...kit.turn(), connection: makeConnectionRef("a-tab-nobody-knows") }
      assert.match((yield* kit.tool("asker_who", {}, stray)).content, /^Not run: the request did not come from/)
      assert.isTrue((yield* kit.tool("asker_who", {}, kit.turn())).ok)
    }))

  it.effect("stop and start: tools withdrawn while it is off, a new start afterwards; restart is one real restart", () =>
    Effect.gen(function*() {
      let starts = 0
      const counted = defineModule({ apiVersion: 2, id: "counted", name: "Counted", description: "Counts its starts.", enabledByDefault: false, start: () => Effect.sync(() => (starts++, {})) })
      const kit = yield* startTestModule(counted)
      assert.strictEqual(starts, 1)
      assert.strictEqual(kit.info()?.state, "running")
      yield* kit.stop
      assert.strictEqual(kit.info()?.state, "disabled")
      assert.isTrue(Exit.isFailure(yield* Effect.exit(kit.restart)))
      yield* kit.start
      assert.strictEqual(starts, 2)
      yield* kit.restart
      assert.strictEqual(starts, 3)
      // A second restart within the host's interval is held for it, and still happens once.
      yield* kit.restart
      assert.strictEqual(starts, 4)
      assert.strictEqual(kit.info()?.state, "running")
    }))

  it.effect("restart keeps the demand: a provider another module uses starts once more, not three times", () =>
    Effect.gen(function*() {
      let shared = 0
      const provider = defineModule({
        apiVersion: 2,
        id: "provider",
        name: "Provider",
        description: "Provides.",
        enabledByDefault: false,
        shared: () => Effect.sync(() => (shared++, { value: undefined })),
        start: () => Effect.succeed({})
      })
      const user = defineModule({ apiVersion: 2, id: "user", name: "User", description: "Uses the provider.", enabledByDefault: false, uses: ["provider"], start: () => Effect.succeed({}) })
      const kit = yield* startTestModule(provider, { others: [user] })
      assert.strictEqual(shared, 1)
      yield* kit.restart
      assert.strictEqual(shared, 2)
    }))

  it.effect("configure changes the saved settings: the module is replaced and its tool reads the new value", () =>
    Effect.gen(function*() {
      let starts = 0
      const numbered = defineModule({
        apiVersion: 2,
        id: "numbered",
        name: "Numbered",
        description: "Reads its number.",
        enabledByDefault: false,
        settings: { n: Setting.number({ label: "N", default: 1, integer: true, min: 1, max: 9 }) },
        start: (ctx) =>
          Effect.sync(() => {
            starts++
            return { tools: [makeTool({ name: "numbered_n", description: "The number.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed(ctx.settings.n) })] }
          })
      })
      const kit = yield* startTestModule(numbered)
      assert.strictEqual((yield* kit.tool("numbered_n", {})).value, 1)
      const result = yield* kit.configure({ n: 2 })
      assert.isTrue(result.ok)
      assert.strictEqual(starts, 2)
      assert.strictEqual((yield* kit.tool("numbered_n", {})).value, 2)
    }))

  it.effect("a health check or a start that never answers fails instead of hanging the test", () =>
    Effect.gen(function*() {
      const silent = defineModule({ apiVersion: 2, id: "silent", name: "Silent", description: "Never answers.", enabledByDefault: false, health: () => Effect.never, start: () => Effect.succeed({}) })
      const kit = yield* startTestModule(silent)
      const issues = yield* kit.checkHealth
      assert.match(issues.find((i) => i.id === "silent.health")?.title ?? "", /did not finish/)
      const stuck = defineModule({ apiVersion: 2, id: "stuck", name: "Stuck", description: "Never starts.", enabledByDefault: false, start: () => Effect.never })
      const never = yield* startTestModule(stuck)
      assert.strictEqual(never.info()?.state, "error")
    }))

  it.effect("expectNoSecrets fails when a secret's value is in a value it is given, escaped or nested, and passes otherwise", () =>
    Effect.gen(function*() {
      const Kept = defineCollection({ name: "kept", scope: "person", maxChars: 400, schema: Schema.Struct({ note: Schema.String.check(Schema.isMaxLength(50)) }) })
      const keyed = defineModule({
        apiVersion: 2,
        id: "keyed",
        name: "Keyed",
        description: "Has a key.",
        enabledByDefault: false,
        settings: { key: Setting.secret({ label: "Key" }) },
        storage: { collections: [Kept] },
        start: (ctx) =>
          Effect.succeed({
            tools: [
              makeTool({ name: "keyed_leak", description: "Leaks.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed(`the key is ${ctx.settings.key}`) }),
              // A structured result: the model gets JSON, where the quote of the key is escaped.
              makeTool({ name: "keyed_nested", description: "Leaks deep.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed({ a: [{ key: ctx.settings.key }] }) }),
              makeTool({ name: "keyed_fine", description: "Fine.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed({ status: "signed in" }) }),
              makeTool({
                name: "keyed_keep",
                description: "Keeps a note for the person.",
                parameters: Schema.Struct({}),
                risk: "change",
                execute: () => Effect.asVoid(ctx.store.collection(Kept).insert({ note: `k=${ctx.settings.key}` })).pipe(Effect.orDie)
              })
            ]
          })
      })
      const secret = 's3cret"value\\x'
      const kit = yield* startTestModule(keyed, { secrets: { key: secret } })
      const fine = yield* kit.tool("keyed_fine", {})
      // Nothing to scan of its own: an empty person-scoped collection is no problem.
      yield* kit.expectNoSecrets(fine)
      const failsWith = (...values: ReadonlyArray<unknown>) =>
        Effect.map(Effect.exit(kit.expectNoSecrets(...values)), (exit) => (Exit.isFailure(exit) ? String(exit.cause) : "passed"))
      const nested = yield* kit.tool("keyed_nested", {})
      assert.include(nested.content, 's3cret\\"value') // escaped in the JSON the model gets
      assert.include(yield* failsWith(fine, nested), "value 2")
      assert.include(yield* failsWith(nested.content), "value 1")
      assert.include(yield* failsWith(yield* kit.tool("keyed_leak", {})), "value 1")
      // The rows the test read itself, from a person-scoped collection.
      yield* kit.tool("keyed_keep", {})
      const rows = yield* kit.asTurn(kit.moduleStore().collection(Kept).list({}))
      assert.include(yield* failsWith(fine, rows), "value 2")
    }))

  it.effect("the tool list is what serve mode offers: without the tools and generated action tools the assistant switched off", () =>
    Effect.gen(function*() {
      const two = defineModule({
        apiVersion: 2,
        id: "two",
        name: "Two",
        description: "Two tools and an action.",
        enabledByDefault: false,
        start: () =>
          Effect.succeed({
            tools: ["two_a", "two_b"].map((name) => makeTool({ name, description: "A tool.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed(name) })),
            actions: [defineAction({ id: "go", label: "Go", description: "Go.", examples: ["go"], params: {}, risk: "change", run: () => Effect.succeed({ say: "gone" }) })]
          })
      })
      const kit = yield* startTestModule(two, {
        household: { assistants: [{ id: "jeff", modules: { two: { offTools: ["two_b", "two_go"] } } }, { id: "plain" }], devices: [{ id: "kitchen-display", name: "Kitchen", assistants: ["jeff", "plain"] }] }
      })
      assert.sameMembers(kit.toolNames({ assistant: "jeff" }), ["two_a"])
      assert.sameMembers(kit.toolNames({ assistant: "plain" }), ["two_a", "two_b", "two_go"])
      // Called anyway, a switched-off tool is refused by the gateway, as on every path.
      assert.match((yield* kit.tool("two_b", {}, { assistant: "jeff" })).content, /^Not run: two_b is switched off/)
    }))

  it.effect("Home-linked settings resolve as in serve mode: Home values under saved values and an assistant's own", () =>
    Effect.gen(function*() {
      const read = (id: "clock" | "weather", settings: NonNullable<Parameters<typeof defineModule>[0]["settings"]>) =>
        defineModule({
          apiVersion: 2,
          id,
          name: id,
          description: "Reads its settings.",
          enabledByDefault: false,
          settings,
          start: (ctx) => Effect.succeed({ tools: [makeTool({ name: `${id}_settings`, description: "Its settings.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed(ctx.settings) })] })
        })
      const clock = read("clock", { timeZone: Setting.text({ label: "Zone" }), locale: Setting.text({ label: "Locale" }) })
      const home = { HOME_TIME_ZONE: "Pacific/Auckland", HOME_DATE_FORMAT: "nl-NL", HOME_LOCATION: " Wellington ", HOME_UNITS: "imperial" }
      const linked = yield* startTestModule(clock, { household: { home } })
      assert.deepStrictEqual((yield* linked.tool("clock_settings", {})).value, { timeZone: "Pacific/Auckland", locale: "nl-NL" })
      const saved = yield* startTestModule(clock, { household: { home }, settings: { timeZone: "Europe/Paris" } })
      assert.deepStrictEqual((yield* saved.tool("clock_settings", {})).value, { timeZone: "Europe/Paris", locale: "nl-NL" })
      const weather = read("weather", { defaultPlace: Setting.text({ label: "Place", overridable: true }), units: Setting.text({ label: "Units" }) })
      const own = yield* startTestModule(weather, {
        household: { home, assistants: [{ id: "jeff", modules: { weather: { own: { defaultPlace: "Napier" } } } }, { id: "plain" }], devices: [{ id: "kitchen-display", name: "Kitchen", assistants: ["jeff", "plain"] }] }
      })
      assert.deepStrictEqual((yield* own.tool("weather_settings", {}, { assistant: "jeff" })).value, { defaultPlace: "Napier", units: "fahrenheit" })
      assert.deepStrictEqual((yield* own.tool("weather_settings", {}, { assistant: "plain" })).value, { defaultPlace: "Wellington", units: "fahrenheit" })
    }))

  it.effect("jobs and runJob see every job of the module, however many other modules scheduled before it", () =>
    Effect.gen(function*() {
      const busy = (n: number) =>
        defineModule({
          apiVersion: 2,
          id: `busy-${n}`,
          name: "Busy",
          description: "Has many jobs.",
          enabledByDefault: false,
          shared: (ctx) =>
            Effect.gen(function*() {
              yield* ctx.scheduler.handle("tick", { payload: Schema.Struct({}), run: () => Effect.void }).pipe(Effect.orDie)
              for (let i = 0; i < 200; i++) yield* ctx.scheduler.schedule({ handler: "tick", key: `k${i}`, inMs: 60_000 + i }).pipe(Effect.orDie)
              return { value: undefined }
            }),
          start: () => Effect.succeed({})
        })
      let ran = 0
      const late = defineModule({
        apiVersion: 2,
        id: "late",
        name: "Late",
        description: "One job, after everyone's.",
        enabledByDefault: false,
        shared: (ctx) =>
          Effect.gen(function*() {
            yield* ctx.scheduler.handle("once", { payload: Schema.Struct({}), run: () => Effect.sync(() => void ran++) }).pipe(Effect.orDie)
            yield* ctx.scheduler.schedule({ handler: "once", key: "once", inMs: 3_600_000 }).pipe(Effect.orDie)
            return { value: undefined }
          }),
        start: () => Effect.succeed({})
      })
      const kit = yield* startTestModule(late, { others: Array.from({ length: 10 }, (_, i) => busy(i)) })
      const jobs = yield* kit.jobs
      assert.deepStrictEqual(jobs.map((j) => j.handler), ["once"])
      yield* kit.runJob(jobs[0]!.id)
      assert.strictEqual(ran, 1)
    }))
})

describe("the kit drives the test clock through the module's own waits", () => {
  it.effect("a stop whose cleanup sleeps, and closing the test's scope, finish without the test moving the clock", () =>
    Effect.gen(function*() {
      let cleaned = 0
      const tidy = defineModule({
        apiVersion: 2,
        id: "tidy",
        name: "Tidy",
        description: "Cleans up slowly.",
        enabledByDefault: false,
        start: () => Effect.as(Effect.addFinalizer(() => Effect.andThen(Effect.sleep(100), Effect.sync(() => void cleaned++))), {})
      })
      const kit = yield* startTestModule(tidy)
      yield* kit.stop
      assert.strictEqual(kit.info()?.state, "disabled")
      assert.strictEqual(cleaned, 1)
      yield* kit.start
      yield* Effect.scoped(Effect.asVoid(startTestModule(tidy)))
      assert.strictEqual(cleaned, 2)
    }))

  it.effect("a bootstrap with several modules beside it that never start ends with each in error", () =>
    Effect.gen(function*() {
      const silent = (id: string) => defineModule({ apiVersion: 2, id, name: id, description: "Never starts.", enabledByDefault: false, start: () => Effect.never })
      const kit = yield* startTestModule(silent("last"), { others: ["first", "second", "third", "fourth"].map(silent) })
      assert.deepStrictEqual(kit.host.modules().map((m) => m.state), ["error", "error", "error", "error", "error"])
    }))

  it.effect("a wait longer than the kit's cap fails the test, naming it, instead of hanging", () =>
    Effect.gen(function*() {
      // 61 modules that each use up the host's 10 s start limit, one after the other: over KIT_WAIT_CAP_MS.
      const silent = (id: string) => defineModule({ apiVersion: 2, id, name: id, description: "Never starts.", enabledByDefault: false, start: () => Effect.never })
      const exit = yield* Effect.exit(Effect.scoped(startTestModule(silent("last"), { others: Array.from({ length: 60 }, (_, i) => silent(`m-${i}`)) })))
      assert.isTrue(KIT_WAIT_CAP_MS < 61 * 10_000)
      assert.include(String(Exit.isFailure(exit) ? exit.cause : "passed"), "The test kit gave up waiting for the start of last and the modules beside it: 10 minutes of test-clock time passed")
    }))
})

describe("stubs of a contract", () => {
  interface Counter {
    readonly add: (n: number) => Effect.Effect<number, { readonly _tag: "Full" }>
    readonly peek: () => number
  }
  const Counters = ServiceKey<Counter>("counter")
  const user = defineModule({
    apiVersion: 2,
    id: "counting",
    name: "Counting",
    description: "Counts with the counter.",
    enabledByDefault: false,
    start: (ctx) =>
      Effect.succeed({
        tools: [makeTool({
          name: "counting_add",
          description: "Add two.",
          parameters: Schema.Struct({}),
          risk: "change",
          execute: () => Effect.catch(ctx.host.service(Counters)!.add(2), (e) => Effect.succeed(e._tag))
        })]
      })
  })

  it.effect("records its calls and answers as programmed: a value, a function of the arguments, a typed failure, a stopped provider", () =>
    Effect.gen(function*() {
      const counter = stubService<Counter>("counter", { add: (n) => Effect.succeed(n + 40), peek: returns(7) })
      assert.strictEqual(yield* counter.service.add(2), 42)
      assert.strictEqual(counter.service.peek(), 7)
      counter.answer("add", succeeds(1))
      assert.strictEqual(yield* counter.service.add(5), 1)
      counter.answer("add", () => Effect.fail({ _tag: "Full" as const }))
      assert.deepStrictEqual(yield* Effect.flip(counter.service.add(1)), { _tag: "Full" })
      counter.answer("add", stops())
      const stopped = yield* Effect.exit(counter.service.add(1))
      assert.isTrue(Exit.isFailure(stopped) && String(stopped.cause).includes("ModuleStopped"))
      assert.deepStrictEqual(counter.calls.add, [[2], [5], [1], [1]])
    }))

  it.effect("a method called without an answer fails the test through the kit, whatever the module did with the error", () =>
    Effect.gen(function*() {
      const counter = stubService<Counter>("counter")
      const kit = yield* startTestModule(user, { provide: [provide("counter", { services: [Counters.of(counter.service)] })] })
      const exit = yield* Effect.exit(kit.tool("counting_add", {}))
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "without a programmed answer")
      // Called outside the kit, the throw is the test's to see; it takes the record itself, or the kit fails on it.
      assert.throws(() => counter.service.peek(), UnprogrammedStubCall)
      assert.strictEqual(takeUnprogrammedStubCalls().length, 1)
    }))

  it.effect("an unprogrammed call the module's start catches fails the start; one left from outside a kit fails the next kit", () =>
    Effect.gen(function*() {
      const counter = stubService<Counter>("counter")
      const eager = defineModule({
        apiVersion: 2,
        id: "eager",
        name: "Eager",
        description: "Counts as it starts, and swallows what goes wrong.",
        enabledByDefault: false,
        uses: ["counter"],
        start: (ctx) => Effect.as(Effect.ignore(Effect.suspend(() => ctx.host.service(Counters)!.add(1)).pipe(Effect.catchCause(() => Effect.void))), {})
      })
      const exit = yield* Effect.exit(Effect.scoped(startTestModule(eager, { provide: [provide("counter", { services: [Counters.of(counter.service)] })] })))
      assert.include(String(Exit.isFailure(exit) ? exit.cause : "passed"), "after the start")
      // A call made outside any kit and not taken: the next kit refuses to start over it.
      assert.throws(() => counter.service.peek(), UnprogrammedStubCall)
      const next = yield* Effect.exit(Effect.scoped(startTestModule(eager, { provide: [provide("counter", { services: [Counters.of(stubService<Counter>("counter", { add: succeeds(1) }).service)] })] })))
      assert.include(String(Exit.isFailure(next) ? next.cause : "passed"), "before the test kit started")
    }))

  it.effect("an unprogrammed call from the module's background fiber fails the test when its scope closes", () =>
    Effect.gen(function*() {
      const counter = stubService<Counter>("counter")
      const later = defineModule({
        apiVersion: 2,
        id: "later",
        name: "Later",
        description: "Counts a while after it starts.",
        enabledByDefault: false,
        uses: ["counter"],
        shared: (ctx) =>
          Effect.as(
            Effect.forkScoped(Effect.andThen(Effect.sleep(60_000), Effect.ignore(Effect.suspend(() => ctx.host.service(Counters)!.add(1)).pipe(Effect.catchCause(() => Effect.void))))),
            { value: undefined }
          ),
        start: () => Effect.succeed({})
      })
      const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
        yield* startTestModule(later, { provide: [provide("counter", { services: [Counters.of(counter.service)] })] })
        // Time passes without a kit call (a test's own adjust): only the scope's end can find the call.
        yield* Effect.sleep(0)
        yield* TestClock.adjust(60_001)
      })))
      assert.include(String(Exit.isFailure(exit) ? exit.cause : "passed"), "when the test's scope closed")
    }))
})

describe("the household of a test", () => {
  it("is fixed: Privacy is the core's rule over it; the third member is nobody's default person", () => {
    const h = makeTestPeople()
    assert.isTrue(h.privacy.mayReveal("p-sam", "kitchen-display"))
    assert.isFalse(h.privacy.mayReveal("p-robin", "kitchen-display"))
    assert.isTrue(h.privacy.mayReveal("p-sam", "robins-phone"))
    assert.isFalse(h.privacy.mayReveal("p-sam", "hall-screen"))
    assert.isFalse(h.privacy.mayReveal("p-alex", "kitchen-display"))
    assert.isTrue(h.privacy.mayReveal("p-alex", "robins-phone"))
    assert.isFalse(h.privacy.mayReveal("p-nobody", "robins-phone"))
    assert.strictEqual(h.people.find("sam").kind, "found")
    assert.strictEqual(h.devices.get("hall-screen")?.place.privacy, "public")
    assert.notProperty(h, "setPrivacy")
  })

  it.effect("its diets are as the server keeps them, and People.setDiet is refused (the household does not change)", () =>
    Effect.gen(function*() {
      assert.isUndefined(dietProblem(["nuts", "egg"]))
      assert.isDefined(dietProblem(["  Nuts  "]))
      assert.isDefined(dietProblem(["nuts", "Nuts"]))
      assert.isDefined(dietProblem(["\n egg\n"]))
      assert.throws(() => makeTestPeople({ people: [{ id: "p-sam", name: "Sam", diet: { allergies: ["  Nuts  "] } }] }), /as the server keeps them/)
      const h = makeTestPeople({ people: [{ id: "p-sam", name: "Sam", diet: { allergies: ["nuts"] } }], devices: [] })
      assert.deepStrictEqual(h.people.dietOf("p-sam").allergies, ["nuts"])
      const refused = yield* Effect.flip(h.people.setDiet({ person: "p-sam" }, { allergies: ["egg"] }))
      assert.strictEqual(refused.code, "not_saved")
      assert.throws(() => makeTestPeople({ devices: [{ id: "kitchen-display", name: "K", defaultPerson: "p-ghost" }] }), /not one of its people/)
    }))

  it.effect("Privacy and People reach the module through host.service", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(asker)
      assert.isDefined(kit.service(Privacy))
      assert.strictEqual(kit.service(People)?.list().length, 3)
    }))
})

describe("expectOffByDefault", () => {
  it.effect("passes for modules that are off, and fails for one that is on", () =>
    Effect.gen(function*() {
      yield* expectOffByDefault([asker])
      const on = defineModule({ id: "on", name: "On", description: "On by default.", start: () => Effect.succeed({}) })
      const exit = yield* Effect.exit(expectOffByDefault([on]))
      assert.isTrue(exit._tag === "Failure")
    }))
})
