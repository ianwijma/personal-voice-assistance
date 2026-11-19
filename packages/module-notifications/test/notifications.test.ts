// The notifications module through the real host, gateway and notification service (the kit): its tools, its phrase
// commands, do not disturb, privacy on each kind of device, the inbound hook's handler, and the service failing.
import { assert, describe, it, vi } from "@effect/vitest"
import { type ModuleDefinition, type ModuleNotify, type ModuleRoute, NotifyError, type RouteRequest } from "@pva/core"
import { checkModule, startTestModule } from "@pva/core/testing"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { holdsSecret, HOOK_TOKEN_HEADER, secretForms, tokenMatches } from "../src/hook.ts"
import { notificationsModule, catalog } from "../src/index.ts"
import { texts } from "../src/texts.ts"

vi.setConfig({ testTimeout: 30_000 })

const TOKEN = "hook-t0ken-for-tests-1234"
/** Every turn of a test is its own: the kit gives the same turn id to every call unless told otherwise. */
let turns = 100
const as = (device: string) => ({ device, turnId: ++turns })
const NL = { household: { home: { HOME_LANGUAGE: "nl-NL" } } }

/** A test's own wrapper: the module with its `ctx.notify` changed, and the routes its shared part returned recorded. */
const wrapped = (change: (n: ModuleNotify) => ModuleNotify, seen?: { routes: ReadonlyArray<ModuleRoute> }, extraTools?: (ctx: any) => ReadonlyArray<any>): ModuleDefinition<any> =>
  ({
    ...notificationsModule,
    shared: (ctx: any) =>
      notificationsModule.shared!({ ...ctx, notify: change(ctx.notify) }).pipe(
        Effect.tap((part: any) => Effect.sync(() => void (seen !== undefined && (seen.routes = part.routes ?? []))))
      ),
    start: (ctx: any) =>
      notificationsModule.start({ ...ctx, notify: change(ctx.notify) }).pipe(
        Effect.map((instance: any) => ({ ...instance, tools: [...(instance.tools ?? []), ...(extraTools?.(ctx) ?? [])] }))
      )
  }) as ModuleDefinition<any>

const request = (over: Partial<RouteRequest> & { readonly body?: unknown } = {}): RouteRequest =>
  ({ method: "POST", path: "notify", params: {}, query: {}, queryAll: {}, headers: { [HOOK_TOKEN_HEADER]: TOKEN }, body: { title: "Washer done" }, address: "192.168.1.9", ...over }) as RouteRequest

const hit = (route: ModuleRoute, over?: Parameters<typeof request>[0]) => route.handler(request(over)) as Effect.Effect<{ status: number; body?: any }>

describe("conformance", () => {
  it.effect("checkModule passes, with its texts in both languages and a secret given", () =>
    Effect.gen(function*() {
      yield* checkModule(notificationsModule, { texts })
      yield* checkModule(notificationsModule, { texts, secrets: { hookToken: TOKEN } })
    }))
  it.effect("the catalogue holds the production definition, off by default", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(catalog.map((m) => [m.id, m.enabledByDefault]), [["notifications", false]])
    }))
})

describe("a test notification", () => {
  it.effect("goes to the device that asked, once; a second says it is open; the service puts it on that page only", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const first = yield* kit.tool("notifications_send_test", {}, as("kitchen-display"))
      assert.deepStrictEqual(first.value, { spoken: "I sent a test notification to this device." })
      const again = yield* kit.tool("notifications_send_test", {}, as("kitchen-display"))
      assert.deepStrictEqual(again.value, { spoken: "A test notification is already open on this device." })
      yield* kit.notify.settle
      const all = yield* kit.notify.all
      assert.strictEqual(all.length, 1)
      assert.deepStrictEqual([all[0]?.priority, all[0]?.target, all[0]?.deviceId], ["normal", "origin", "kitchen-display"])
      assert.deepStrictEqual(kit.notify.messages.map((m) => [m.deviceId, m.message.type]), [["kitchen-display", "notification.ring"]])
    }))

  it.effect("in Dutch, by phrase, and the service's limit is worded in the household's language", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule, NL)
      const said = yield* kit.phrases.say("stuur een testmelding", as("kitchen-display"))
      assert.isTrue(said.taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["Ik heb een testmelding naar dit apparaat gestuurd."])
      const full = yield* startTestModule(wrapped((n) => ({ ...n, send: () => Effect.fail(new NotifyError({ reason: "limit", message: "x" })) })), NL)
      const r = yield* full.tool("notifications_send_test", {}, as("kitchen-display"))
      assert.isFalse(r.ok)
      assert.include(r.content, "Er wachten te veel meldingen.")
    }))

  it.effect("a service that is busy or failing is said, never reported as sent", () =>
    Effect.gen(function*() {
      const busy = yield* startTestModule(wrapped((n) => ({ ...n, send: () => Effect.fail(new NotifyError({ reason: "busy", message: "x" })) })))
      assert.isFalse((yield* busy.tool("notifications_send_test", {})).ok)
      const down = yield* startTestModule(wrapped((n) => ({ ...n, send: () => Effect.fail(new NotifyError({ reason: "failed", message: "x" })) })))
      const r = yield* down.tool("notifications_send_test", {})
      assert.isFalse(r.ok)
      assert.notInclude(r.content, "I sent")
    }))
})

describe("reading and dismissing what is open", () => {
  it.effect("each device is told only what is for it, and what the list covers is said", () =>
    Effect.gen(function*() {
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      const kit = yield* startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: TOKEN } })
      yield* kit.tool("notifications_send_test", {}, as("kitchen-display"))
      yield* hit(seen.routes[0]!, { body: { title: "Washer done", key: "washer" } })
      const kitchen = (yield* kit.tool("notifications_open", {}, as("kitchen-display"))).value as any
      assert.deepStrictEqual([...kitchen.titles].sort(), ["Test notification", "Washer done"])
      assert.strictEqual(kitchen.open, 2)
      assert.include(kitchen.covers, "not other modules'")
      assert.include(kitchen.outsideText, "untrusted")
      // The hall screen was not the test's origin: only the notification for every device.
      const hall = (yield* kit.tool("notifications_open", {}, as("hall-screen"))).value as any
      assert.deepStrictEqual(hall.titles, ["Washer done"])
      // Nothing open: the answer says what it covers, not "none".
      const empty = yield* startTestModule(notificationsModule)
      const none = (yield* empty.tool("notifications_open", {})).value as any
      assert.include(none.spoken, "Other modules' notifications are not covered here.")
      const nl = yield* startTestModule(notificationsModule, NL)
      assert.include(((yield* nl.tool("notifications_open", {})).value as any).spoken, "Meldingen van andere modules vallen hier niet onder.")
    }))

  it.effect("a personal one is read where the privacy rule allows it, and only counted elsewhere (no title leaks)", () =>
    Effect.gen(function*() {
      const { makeTool } = yield* Effect.promise(() => import("@pva/core"))
      const { Schema } = yield* Effect.promise(() => import("effect"))
      const kit = yield* startTestModule(wrapped((n) => n, undefined, (ctx) => [makeTool({
        name: "test_personal",
        description: "Sends a personal notification for a person to every device (a test's own tool).",
        parameters: Schema.Struct({ owner: Schema.String }),
        risk: "change",
        execute: ({ owner }: { owner: string }) => ctx.notify.send({ title: "Dentist at 3", priority: "normal", target: "everywhere", owner, key: "dentist" }).pipe(Effect.map(() => "ok"))
      })]))
      yield* kit.tool("test_personal", { owner: "p-sam" })
      const sams = (yield* kit.tool("notifications_open", {}, as("kitchen-display"))).value as any
      assert.deepStrictEqual([sams.titles, sams.owner], [["Dentist at 3"], "p-sam"])
      const robins = (yield* kit.tool("notifications_open", {}, as("robins-phone"))).value as any
      assert.deepStrictEqual(robins.titles, ["Dentist at 3"])
      const hall = yield* kit.tool("notifications_open", {}, as("hall-screen"))
      assert.notInclude(hall.content, "Dentist")
      assert.deepStrictEqual(hall.value, { spoken: "Nothing I can read out here; 1 personal notification is kept for its owner's devices." })
      // Dismissing it from the public screen finds nothing: no title leaks through "which one".
      const dismissed = yield* kit.tool("notifications_dismiss", { which: "dentist" }, as("hall-screen"))
      assert.notInclude(dismissed.content, "Dentist")
      assert.strictEqual(((yield* kit.notify.all) as ReadonlyArray<any>)[0].state, "open")
      // On the owner's device it is dismissed, once.
      assert.deepStrictEqual((yield* kit.tool("notifications_dismiss", { which: "dentist" }, as("kitchen-display"))).value, { spoken: "Dismissed." })
      assert.strictEqual(((yield* kit.notify.all) as ReadonlyArray<any>)[0].outcome, "dismissed")
    }))

  it.effect("dismiss: by name, the only one, asks when several fit, an unknown name, nothing open, already gone", () =>
    Effect.gen(function*() {
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      const kit = yield* startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: TOKEN } })
      const dismiss = (which?: string) => kit.tool("notifications_dismiss", which === undefined ? {} : { which }, as("kitchen-display"))
      assert.include(JSON.stringify((yield* dismiss()).value), "nothing open")
      yield* hit(seen.routes[0]!, { body: { title: "Washer done", key: "a" } })
      yield* hit(seen.routes[0]!, { body: { title: "Washer finished", key: "b" } })
      yield* hit(seen.routes[0]!, { body: { title: "Door open", key: "c" } })
      const ask = (yield* dismiss()).value as any
      assert.include(ask.ask, "Which one?")
      assert.strictEqual(ask.candidates.length, 3)
      const two = (yield* dismiss("washer")).value as any
      assert.deepStrictEqual([...two.candidates].sort(), ["Washer done", "Washer finished"])
      assert.include(JSON.stringify((yield* dismiss("garage")).value), "I don't know a notification by that name from this module.")
      assert.deepStrictEqual((yield* dismiss("door")).value, { spoken: "Dismissed." })
      assert.deepStrictEqual((yield* dismiss("washer done")).value, { spoken: "Dismissed." })
      // One left: no name needed. Then it is gone: a second dismissal does not claim success.
      assert.deepStrictEqual((yield* dismiss()).value, { spoken: "Dismissed." })
      assert.include(JSON.stringify((yield* dismiss()).value), "nothing open")
      // Resolved by someone else between the read and the change: said as gone, not as dismissed.
      let first = true
      const racy = yield* startTestModule(wrapped((n) => ({ ...n, resolve: (id, o) => (first ? ((first = false), Effect.succeed(false)) : n.resolve(id, o)) })), { secrets: { hookToken: TOKEN } })
      yield* racy.tool("notifications_send_test", {}, as("kitchen-display"))
      assert.deepStrictEqual((yield* racy.tool("notifications_dismiss", {}, as("kitchen-display"))).value, { spoken: "That one was already gone." })
    }))

  it.effect("a failed read is a failure, never 'nothing is open'; a cut read says so; Dutch", () =>
    Effect.gen(function*() {
      const failing = yield* startTestModule(wrapped((n) => ({ ...n, list: () => Effect.fail(new NotifyError({ reason: "failed", message: "x" })) })))
      const r = yield* failing.tool("notifications_open", {})
      assert.isFalse(r.ok)
      assert.include(r.content, "I couldn't read the open notifications of this module's hook and test.")
      const nl = yield* startTestModule(wrapped((n) => ({ ...n, list: () => Effect.fail(new NotifyError({ reason: "busy", message: "x" })) })), NL)
      assert.include((yield* nl.tool("notifications_dismiss", {})).content, "Ik kon de openstaande meldingen van de hook en de test van deze module niet lezen.")
      // Pages that stay full past the bound: the answer says it was cut.
      const note = (i: number) => ({ id: `n${i}`, module: "notifications", state: "open", title: `T${i}`, priority: "normal", target: "everywhere", actions: [], sentAt: i, expiresAt: 9e12 }) as any
      const endless = yield* startTestModule(wrapped((n) => ({ ...n, list: ({ after, limit }: any = {}) => Effect.succeed(Array.from({ length: limit ?? 12 }, (_, i) => note(after === undefined ? i : Number(after.id.slice(1)) + 1 + i))) })))
      const cut = (yield* endless.tool("notifications_open", {})).value as any
      assert.include(cut.cut, "first 60 open ones")
      assert.strictEqual(cut.open, 60)
    }))

  it.effect("phrases: which notifications are open, dismiss the notification; Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      yield* kit.tool("notifications_send_test", {}, as("kitchen-display"))
      const list = yield* kit.phrases.say("which notifications are open", as("kitchen-display"))
      assert.isTrue(list.taken)
      assert.include(kit.phrases.spoken.at(-1)?.text, "Test notification")
      const miss = yield* kit.phrases.say("dismiss the kettle", as("kitchen-display"))
      assert.isTrue(miss.taken)
      assert.include(kit.phrases.spoken.at(-1)?.text, "I don't know a notification by that name from this module.")
      yield* kit.phrases.say("dismiss the notification", as("kitchen-display"))
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Dismissed.")
      const nl = yield* startTestModule(notificationsModule, NL)
      yield* nl.tool("notifications_send_test", {}, as("kitchen-display"))
      yield* nl.phrases.say("sluit de melding", as("kitchen-display"))
      assert.strictEqual(nl.phrases.spoken.at(-1)?.text, "Gesloten.")
    }))
})

describe("do not disturb", () => {
  it.effect("on, for a length of time, until a time, off and is it on, as tools; the service holds the state for the house", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const dnd = (name: string, input: object = {}) => kit.tool(name, input, as("kitchen-display")).pipe(Effect.map((r) => (r.value as any).spoken ?? r.content))
      assert.strictEqual(yield* dnd("notifications_dnd_status"), "Do not disturb is off.")
      assert.include(yield* dnd("notifications_dnd_on"), "on for the whole house")
      assert.isTrue((kit.notify.dnd()).on)
      assert.include(yield* dnd("notifications_dnd_status"), "until you turn it off")
      const forTwo = yield* dnd("notifications_dnd_on", { for: "two hours" })
      assert.include(forTwo, "for 2 hours")
      assert.strictEqual((kit.notify.dnd()).until, (yield* kit.now) + 2 * 3_600_000)
      // It ends by itself, on time.
      yield* kit.advance(2 * 3_600_000 + 1_000)
      assert.isFalse((kit.notify.dnd()).on)
      assert.strictEqual(yield* dnd("notifications_dnd_status"), "Do not disturb is off.")
      // Until a time said in words: 10:00 now, "eight" is this evening.
      const until = yield* dnd("notifications_dnd_on", { until: "eight" })
      assert.include(until, "until")
      assert.include(until, "eight")
      // It is a little after noon by now: eight in the evening is a little under eight hours away.
      assert.strictEqual((kit.notify.dnd()).until! - (yield* kit.now), 8 * 3_600_000 - 1_000)
      assert.include(yield* dnd("notifications_dnd_status"), "until")
      assert.strictEqual(yield* dnd("notifications_dnd_off"), "Do not disturb is off for the whole house.")
      assert.isFalse((kit.notify.dnd()).on)
    }))

  it.effect("what cannot be done is said: both given, unclear, too long, in the past, ambiguous", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const dnd = (input: object) => kit.tool("notifications_dnd_on", input).pipe(Effect.map((r) => (r.value as any).spoken))
      assert.include(yield* dnd({ for: "an hour", until: "eight" }), "either for how long or until when")
      assert.include(yield* dnd({ for: "banana" }), "For how long?")
      assert.include(yield* dnd({ until: "banana" }), "Until when?")
      assert.include(yield* dnd({ for: "two weeks" }), "at most seven days")
      assert.include(yield* dnd({ until: "yesterday at nine" }), "passed")
      assert.isFalse((kit.notify.dnd()).on)
    }))

  it.effect("phrase commands: on, for a duration slot, off, is it on; Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const say = (text: string) => kit.phrases.say(text, as("kitchen-display"))
      assert.isTrue((yield* say("do not disturb for ten minutes")).taken)
      assert.strictEqual((kit.notify.dnd()).until, (yield* kit.now) + 600_000)
      assert.include(kit.phrases.spoken.at(-1)?.text, "for 10 minutes")
      assert.isTrue((yield* say("is do not disturb on")).taken)
      assert.include(kit.phrases.spoken.at(-1)?.text, "for another 10 minutes")
      assert.isTrue((yield* say("do not disturb off")).taken)
      assert.isFalse((kit.notify.dnd()).on)
      assert.isTrue((yield* say("do not disturb")).taken)
      assert.isUndefined((kit.notify.dnd()).until)
      // A duration beyond the bound is not a slot: it goes on to the assistant.
      assert.isFalse((yield* say("do not disturb for three weeks")).taken)
      const nl = yield* startTestModule(notificationsModule, NL)
      yield* nl.phrases.say("niet storen voor een uur", as("kitchen-display"))
      assert.include(nl.phrases.spoken.at(-1)?.text, "Niet storen staat aan voor het hele huis voor 1 uur")
      yield* nl.phrases.say("staat niet storen aan", as("kitchen-display"))
      assert.include(nl.phrases.spoken.at(-1)?.text, "Niet storen staat aan")
      yield* nl.phrases.say("niet storen uit", as("kitchen-display"))
      assert.strictEqual(nl.phrases.spoken.at(-1)?.text, "Niet storen staat uit voor het hele huis.")
    }))

  it.effect("it survives a restart of the module, and a failing service is never reported as off or done", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      yield* kit.tool("notifications_dnd_on", { for: "an hour" })
      yield* kit.restart
      assert.include(((yield* kit.tool("notifications_dnd_status", {})).value as any).spoken, "until")
      const broken = yield* startTestModule(
        wrapped((n) => ({ ...n, dnd: { get: Effect.fail(new NotifyError({ reason: "failed", message: "x" })), set: () => Effect.fail(new NotifyError({ reason: "failed", message: "x" })), clear: Effect.fail(new NotifyError({ reason: "busy", message: "x" })) } })),
        NL
      )
      assert.include((yield* broken.tool("notifications_dnd_status", {})).content, "Ik kon niet lezen of niet storen aan staat.")
      assert.include((yield* broken.tool("notifications_dnd_on", {})).content, "Ik kon niet storen niet aanzetten.")
      assert.include((yield* broken.tool("notifications_dnd_off", {})).content, "Het huis was bezig")
      // A service that says it is still on after "off" is not "off".
      const stuck = yield* startTestModule(wrapped((n) => ({ ...n, dnd: { ...n.dnd, clear: Effect.succeed({ on: true }) } })))
      assert.include((yield* stuck.tool("notifications_dnd_off", {})).content, "still reads as on")
    }))
})

describe("the inbound hook", () => {
  const start = (extra?: object) => {
    const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
    return Effect.map(startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: TOKEN }, ...extra }), (kit) => ({ kit, route: seen.routes[0]! }))
  }

  it.effect("one POST route that needs the home network; the token is its own setting", () =>
    Effect.gen(function*() {
      const { route } = yield* start()
      assert.deepStrictEqual([route.method, route.path, route.guards], ["POST", "notify", ["lan"]])
      assert.isAtMost(route.bodyLimitBytes!, 2_048)
    }))

  it.effect("a valid call shows a normal card on every device; a repeat with the same key is deduped", () =>
    Effect.gen(function*() {
      const { kit, route } = yield* start()
      const ok = yield* hit(route, { body: { title: "Washer done", text: "Cycle finished", key: "washer" } })
      assert.deepStrictEqual([ok.status, ok.body], [202, { ok: true, deduped: false }])
      assert.deepStrictEqual((yield* hit(route, { body: { title: "Washer done", key: "washer" } })).body, { ok: true, deduped: true })
      yield* kit.notify.settle
      const [n] = yield* kit.notify.all
      assert.deepStrictEqual([n?.priority, n?.target, n?.key, n?.title, n?.text], ["normal", "everywhere", "hook:washer", "Washer done", "Cycle finished"])
      assert.deepStrictEqual([...new Set(kit.notify.messages.map((m) => m.deviceId))].sort(), ["hall-screen", "kitchen-display", "robins-phone"])
      assert.isTrue(kit.notify.messages.every((m) => m.message.type === "notification.ring"))
    }))

  it.effect("no token, a wrong token, an unset token: refused, and nothing is sent or echoed", () =>
    Effect.gen(function*() {
      const { kit, route } = yield* start()
      const missing = yield* hit(route, { headers: {} })
      const wrong = yield* hit(route, { headers: { [HOOK_TOKEN_HEADER]: `${TOKEN}x` } })
      const short = yield* hit(route, { headers: { [HOOK_TOKEN_HEADER]: "x" } })
      assert.deepStrictEqual([missing.status, wrong.status, short.status], [401, 401, 401])
      assert.deepStrictEqual(missing.body, wrong.body)
      assert.strictEqual((yield* kit.notify.all).length, 0)
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      yield* startTestModule(wrapped((n) => n, seen))
      const unset = yield* hit(seen.routes[0]!)
      assert.deepStrictEqual([unset.status, unset.body], [503, { ok: false, error: "not-set-up" }])
      yield* kit.expectNoSecrets(missing, wrong, short, unset)
    }))

  it.effect("every text is bounded, priority and target cannot be chosen, and the token cannot ride in a text", () =>
    Effect.gen(function*() {
      const { kit, route } = yield* start()
      const bad = (body: unknown) => hit(route, { body }).pipe(Effect.map((r) => [r.status, r.body.field ?? r.body.error]))
      assert.deepStrictEqual(yield* bad({ title: "x".repeat(61) }), [400, "title"])
      assert.deepStrictEqual(yield* bad({ title: "two\nlines" }), [400, "title"])
      assert.deepStrictEqual(yield* bad({ title: "   " }), [400, "title"])
      assert.deepStrictEqual(yield* bad({ title: "ok", text: "x".repeat(201) }), [400, "text"])
      assert.deepStrictEqual(yield* bad({ title: "ok", key: "bad key!" }), [400, "key"])
      assert.deepStrictEqual(yield* bad({ title: "ok", priority: "ring" }), [400, "unknown-field"])
      assert.deepStrictEqual(yield* bad({ title: "ok", target: "origin" }), [400, "unknown-field"])
      assert.deepStrictEqual(yield* bad([1]), [400, "body"])
      assert.deepStrictEqual(yield* bad({ title: 5 }), [400, "title"])
      for (const form of secretForms(TOKEN)) assert.deepStrictEqual(yield* bad({ title: "ok", text: `see ${form}` }), [400, "text"])
      assert.strictEqual((yield* kit.notify.all).length, 0)
      assert.isTrue(holdsSecret(`a ${Buffer.from(TOKEN).toString("base64")} b`, TOKEN))
      assert.isFalse(holdsSecret("hello", TOKEN))
    }))

  it.effect("the service's limit is a 429 and a busy store a 503; no detail of the failure is sent", () =>
    Effect.gen(function*() {
      const send = (reason: "limit" | "busy" | "failed") => {
        const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
        return Effect.flatMap(
          startTestModule(wrapped((n) => ({ ...n, send: () => Effect.fail(new NotifyError({ reason, message: "internal detail" })) }), seen), { secrets: { hookToken: TOKEN } }),
          () => hit(seen.routes[0]!)
        )
      }
      assert.deepStrictEqual((yield* send("limit")).status, 429)
      assert.deepStrictEqual((yield* send("busy")).status, 503)
      const failed = yield* send("failed")
      assert.deepStrictEqual([failed.status, JSON.stringify(failed.body)], [502, '{"ok":false,"error":"not-sent"}'])
    }))

  it.effect("the token is compared in constant time (hashed first) and never kept in a result, a row or a Health issue", () =>
    Effect.gen(function*() {
      assert.isTrue(tokenMatches(TOKEN, TOKEN))
      assert.isFalse(tokenMatches(TOKEN, TOKEN.slice(0, -1)))
      assert.isFalse(tokenMatches("", ""))
      assert.isFalse(tokenMatches(TOKEN, undefined))
      const { kit, route } = yield* start()
      const sent = yield* hit(route, { body: { title: "Fine" } })
      const open = yield* kit.tool("notifications_open", {})
      const rows = yield* kit.notify.all
      yield* kit.expectNoSecrets(sent, open, rows, kit.issues(), kit.info())
      assert.deepStrictEqual((yield* (yield* startTestModule(notificationsModule)).checkHealth).map((i) => i.id), ["notifications.no-hook-token"])
      assert.deepStrictEqual(yield* kit.checkHealth, [])
    }))

})

// ---------------------------------------------------------------------------------------------------------------------
// Review round 1

const fresh = (device: string, conversationId = "conversation-1") => ({ device, conversationId, turnId: ++turns })

describe("review 1.1/1.2: the token never becomes content or an error", () => {
  // Written by hand, independently of `secretForms`: the token, its base64, base64url, and percent-encodings in full and in part.
  const token = "hookToken12345!?"
  const raw = token
  const b64 = "aG9va1Rva2VuMTIzNDUhPw=="
  const b64url = "aG9va1Rva2VuMTIzNDUhPw"
  const pctFull = "%68%6f%6f%6b%54%6f%6b%65%6e%31%32%33%34%35%21%3F"
  const pctPart = "hook%54oken12345%21?"
  const pctEncodeUri = "hookToken12345!%3F"

  it.effect("each form is refused in the title and in the text, the answer names only a fixed field", () =>
    Effect.gen(function*() {
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      yield* startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: token } })
      const route = seen.routes[0]!
      for (const form of [raw, b64, b64url, pctFull, pctPart, pctEncodeUri]) {
        const inTitle = yield* hit(route, { headers: { [HOOK_TOKEN_HEADER]: token }, body: { title: `x ${form}` } })
        const inText = yield* hit(route, { headers: { [HOOK_TOKEN_HEADER]: token }, body: { title: "ok", text: `see ${form}` } })
        assert.deepStrictEqual([inTitle.status, inTitle.body], [400, { ok: false, error: "invalid", field: "title" }], form)
        assert.deepStrictEqual([inText.status, inText.body], [400, { ok: false, error: "invalid", field: "text" }], form)
      }
      // An invalid escape is only text: it neither hides the token nor refuses an innocent title.
      assert.strictEqual((yield* hit(route, { headers: { [HOOK_TOKEN_HEADER]: token }, body: { title: "100% sure %zz" } })).status, 202)
    }))

  it.effect("a short token cannot be saved, and a short stored one closes the hook (the same answer as no token)", () =>
    Effect.gen(function*() {
      const setting = (notificationsModule.settings as any).hookToken
      assert.deepStrictEqual(setting.decode("abc"), { ok: false, error: "Must be at least 16 characters" })
      assert.deepStrictEqual(setting.fromEnv("abc"), { ok: false, error: "Must be at least 16 characters" })
      assert.isTrue(setting.decode("0123456789abcdef").ok)
      // The route itself, given a short value some other way, is closed: nothing is sent, not even a title equal to the token.
      const { hookRoute } = yield* Effect.promise(() => import("../src/hook.ts"))
      let sent = 0
      const route = hookRoute({ send: () => Effect.sync(() => void sent++) } as any, "abc")
      const r = yield* hit(route, { headers: { [HOOK_TOKEN_HEADER]: "abc" }, body: { title: "abc" } })
      assert.deepStrictEqual([r.status, r.body, sent], [503, { ok: false, error: "not-set-up" }, 0])
      assert.deepStrictEqual((yield* (yield* startTestModule(notificationsModule)).checkHealth).map((i) => i.id), ["notifications.no-hook-token"])
    }))

  it.effect("an unknown JSON field: one fixed code, the name is never reflected (the reviewer's case, exactly)", () =>
    Effect.gen(function*() {
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      yield* startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: "hookToken12345" + "xy" } })
      const r = yield* hit(seen.routes[0]!, { headers: { [HOOK_TOKEN_HEADER]: "hookToken12345xy" }, body: { title: "Fine", hookToken12345xy: "value" } })
      assert.deepStrictEqual([r.status, r.body], [400, { ok: false, error: "unknown-field" }])
      assert.notInclude(JSON.stringify(r.body), "hookToken")
      // Every error answer of the route is built from fixed words.
      const answers = [
        yield* hit(seen.routes[0]!, { headers: {} }),
        yield* hit(seen.routes[0]!, { headers: { [HOOK_TOKEN_HEADER]: "hookToken12345xy" }, body: [] }),
        yield* hit(seen.routes[0]!, { headers: { [HOOK_TOKEN_HEADER]: "hookToken12345xy" }, body: { title: "" } }),
        yield* hit(seen.routes[0]!, { headers: { [HOOK_TOKEN_HEADER]: "hookToken12345xy" }, body: { title: "t", key: "bad key hookToken12345xy" } })
      ]
      for (const a of answers) assert.match(JSON.stringify(a.body), /^\{"ok":false,"error":"[a-z-]+"(,"field":"(body|title|text|key)")?\}$/)
    }))
})

describe("review 1.3/1.6/1.8/1.11: dismiss by name", () => {
  const withHook = (extra?: object) => {
    const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
    return Effect.map(startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: TOKEN }, ...extra }), (kit) => ({ kit, route: seen.routes[0]! }))
  }
  const post = (route: ModuleRoute, title: string, key: string) => hit(route, { body: { title, key } })

  it.effect("a refusal never repeats the asked name, even the token, on the tool and the phrase, in both languages", () =>
    Effect.gen(function*() {
      const { kit } = yield* withHook()
      const tool = yield* kit.tool("notifications_dismiss", { which: TOKEN }, as("kitchen-display"))
      assert.deepStrictEqual(tool.value, { spoken: "I don't know a notification by that name from this module." })
      yield* kit.phrases.say(`dismiss ${TOKEN}`, { device: "kitchen-display" })
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "I don't know a notification by that name from this module.")
      yield* kit.expectNoSecrets(tool, kit.phrases.spoken)
      const { kit: nl } = yield* withHook(NL)
      assert.deepStrictEqual((yield* nl.tool("notifications_dismiss", { which: "iets" }, as("kitchen-display"))).value, { spoken: "Ik ken geen melding met die naam van deze module." })
    }))

  it.effect("the page's examples verbatim: articles and filler words are dropped, then whole words match", () =>
    Effect.gen(function*() {
      const { kit, route } = yield* withHook()
      yield* post(route, "Washing machine done", "w")
      yield* post(route, "Door open", "d")
      yield* post(route, "Washing line wet", "l")
      const dismiss = (which: string) => kit.tool("notifications_dismiss", { which }, as("kitchen-display")).pipe(Effect.map((r) => r.value as any))
      // Two titles hold "washing": ask, never pick the first.
      const ask = yield* dismiss("the washing one")
      assert.deepStrictEqual([...ask.candidates].sort(), ["Washing line wet", "Washing machine done"])
      // "the washing machine" is an unambiguous ordinary reference (the action's own example).
      assert.deepStrictEqual(yield* dismiss("the washing machine"), { spoken: "Dismissed." })
      assert.deepStrictEqual(yield* dismiss("a door notification"), { spoken: "Dismissed." })
      // No stemming: "washer" is not a word of any title.
      assert.deepStrictEqual(yield* dismiss("washer"), { spoken: "I don't know a notification by that name from this module." })
      assert.deepStrictEqual(yield* dismiss("washing line wet"), { spoken: "Dismissed." })
    }))

  it.effect("more than one match asks; the exact title wins over a longer one", () =>
    Effect.gen(function*() {
      const { kit, route } = yield* withHook()
      yield* post(route, "Washing machine done", "a")
      yield* post(route, "Washing machine done late", "b")
      // Both titles hold every word of the reference: more than one fits, so it asks...
      const ask = (yield* kit.tool("notifications_dismiss", { which: "the washing machine" }, as("kitchen-display"))).value as any
      assert.include(ask.ask, "Which one?")
      assert.deepStrictEqual([...ask.candidates].sort(), ["Washing machine done", "Washing machine done late"])
      // ...but the full title said wins, and only that card is dismissed.
      assert.deepStrictEqual((yield* kit.tool("notifications_dismiss", { which: "washing machine done" }, as("kitchen-display"))).value, { spoken: "Dismissed." })
      assert.deepStrictEqual((yield* kit.notify.all).filter((n) => n.state === "open").map((n) => n.title), ["Washing machine done late"])
    }))

  it.effect("in Dutch: de/het/een and a trailing melding are dropped (tool and phrase)", () =>
    Effect.gen(function*() {
      const { kit: nl, route } = yield* withHook(NL)
      yield* post(route, "Wasmachine klaar", "w")
      yield* post(route, "Deur open", "d")
      assert.deepStrictEqual((yield* nl.tool("notifications_dismiss", { which: "de wasmachine melding" }, as("kitchen-display"))).value, { spoken: "Gesloten." })
      yield* nl.phrases.say("sluit de deur", { device: "kitchen-display" })
      assert.strictEqual(nl.phrases.spoken.at(-1)?.text, "Gesloten.")
    }))

  it.effect("withheld-only is said truthfully: nothing to read here, N kept for their owner, no title (list and dismiss, both languages, singular and plural)", () =>
    Effect.gen(function*() {
      const { makeTool } = yield* Effect.promise(() => import("@pva/core"))
      const mk = (extra: object) => startTestModule(wrapped((n) => n, undefined, (ctx) => [makeTool({
        name: "test_personal", description: "A test's own tool: sends a personal notification for a person to every device.", parameters: Schema.Struct({ owner: Schema.String, key: Schema.String }), risk: "change",
        execute: ({ owner, key }: { owner: string; key: string }) => ctx.notify.send({ title: "Dentist at 3", priority: "normal", target: "everywhere", owner, key }).pipe(Effect.map(() => "ok"))
      })]), extra)
      const kit = yield* mk({})
      yield* kit.tool("test_personal", { owner: "p-sam", key: "a" }, as("kitchen-display"))
      const one = "Nothing I can read out here; 1 personal notification is kept for its owner's devices."
      assert.deepStrictEqual((yield* kit.tool("notifications_open", {}, as("hall-screen"))).value, { spoken: one })
      assert.deepStrictEqual((yield* kit.tool("notifications_dismiss", {}, as("hall-screen"))).value, { spoken: one })
      yield* kit.tool("test_personal", { owner: "p-robin", key: "b" }, as("kitchen-display"))
      const many = "Nothing I can read out here; 2 personal notifications are kept for their owner's devices."
      assert.deepStrictEqual((yield* kit.tool("notifications_open", {}, as("hall-screen"))).value, { spoken: many })
      yield* kit.phrases.say("sluit de melding", { device: "hall-screen" })
      const nl = yield* mk(NL)
      yield* nl.tool("test_personal", { owner: "p-sam", key: "a" }, as("kitchen-display"))
      assert.deepStrictEqual((yield* nl.tool("notifications_open", {}, as("hall-screen"))).value, { spoken: "Niets wat ik hier kan voorlezen; 1 persoonlijke melding wordt bewaard voor de apparaten van de eigenaar." })
      yield* nl.tool("test_personal", { owner: "p-robin", key: "b" }, as("kitchen-display"))
      assert.deepStrictEqual((yield* nl.tool("notifications_dismiss", {}, as("hall-screen"))).value, { spoken: "Niets wat ik hier kan voorlezen; 2 persoonlijke meldingen worden bewaard voor de apparaten van hun eigenaar." })
      assert.notInclude(JSON.stringify([yield* kit.tool("notifications_open", {}, as("hall-screen"))]), "Dentist")
    }))
})

describe("review 1.4: a repeat of the same invocation returns the first outcome", () => {
  it.effect("dnd_for with the same phrase identity, a minute apart: not extended", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const turn = kit.turn({ device: "kitchen-display", source: "phrase", turnId: 901 })
      const first = yield* kit.action("dnd_for", { duration: "ten minutes" }, turn)
      const until = kit.notify.dnd().until
      yield* kit.advance(60_000)
      const again = yield* kit.action("dnd_for", { duration: "ten minutes" }, turn)
      assert.deepStrictEqual(again, first)
      assert.strictEqual(kit.notify.dnd().until, until)
      // A new utterance is a new identity and does extend it.
      yield* kit.action("dnd_for", { duration: "ten minutes" }, kit.turn({ device: "kitchen-display", source: "phrase", turnId: 902 }))
      assert.strictEqual(kit.notify.dnd().until, until! + 60_000)
    }))

  it.effect("dismiss with the same identity is bound to the first notification: a later one is not dismissed", () =>
    Effect.gen(function*() {
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      const kit = yield* startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: TOKEN } })
      yield* hit(seen.routes[0]!, { body: { title: "Washer done", key: "w" } })
      const turn = kit.turn({ device: "kitchen-display", source: "phrase", turnId: 902 })
      const first = yield* kit.action("dismiss", {}, turn)
      yield* hit(seen.routes[0]!, { body: { title: "Door open", key: "d" } })
      const again = yield* kit.action("dismiss", {}, turn)
      assert.deepStrictEqual([first, again], [{ ok: true, say: "Dismissed." }, { ok: true, say: "Dismissed." }])
      const open = (yield* kit.notify.all).filter((n) => n.state === "open")
      assert.deepStrictEqual(open.map((n) => n.title), ["Door open"])
    }))

  it.effect("concurrent repeats: one change, both get its answer", () =>
    Effect.gen(function*() {
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      const kit = yield* startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: TOKEN } })
      yield* hit(seen.routes[0]!, { body: { title: "Washer done", key: "w" } })
      const turn = kit.turn({ device: "kitchen-display", source: "phrase", turnId: 903 })
      const both = yield* Effect.all([kit.action("dismiss", {}, turn), kit.action("dismiss", {}, turn)], { concurrency: "unbounded" })
      assert.deepStrictEqual(both, [{ ok: true, say: "Dismissed." }, { ok: true, say: "Dismissed." }])
      const dnds = yield* Effect.all([kit.action("dnd_for", { duration: "ten minutes" }, turn), kit.action("dnd_for", { duration: "ten minutes" }, turn)], { concurrency: "unbounded" })
      assert.deepStrictEqual(dnds[0], dnds[1])
      assert.strictEqual(kit.notify.dnd().until, (yield* kit.now) + 600_000)
    }))

  it.effect("a tool and then an action of one identity are one request; finished records are bounded (a 257th makes the oldest forgotten)", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const turn = kit.turn({ device: "kitchen-display", source: "phrase", turnId: 904 })
      const a = yield* kit.tool("notifications_dnd_on", { for: "ten minutes" }, turn)
      const until = kit.notify.dnd().until
      yield* kit.advance(60_000)
      // The action decodes "ten minutes" to 600000 ms: the same request, so the first deadline stays.
      const b = yield* kit.action("dnd_for", { duration: "ten minutes" }, turn)
      assert.deepStrictEqual([b.ok, (b as any).say], [true, (a.value as any).spoken])
      assert.strictEqual(kit.notify.dnd().until, until)
      // Inside the bound the repeat still joins the first. Past it (256 others finished since), the oldest is forgotten and acts again.
      // (Other finished invocations that change nothing: a dismissal with nothing open.)
      for (let i = 0; i < 254; i++) yield* kit.tool("notifications_dismiss", {}, as("kitchen-display"))
      yield* kit.action("dnd_for", { duration: "ten minutes" }, turn)
      assert.strictEqual(kit.notify.dnd().until, until)
      yield* kit.tool("notifications_dismiss", {}, as("kitchen-display"))
      yield* kit.tool("notifications_dismiss", {}, as("kitchen-display"))
      yield* kit.action("dnd_for", { duration: "ten minutes" }, turn)
      assert.strictEqual(kit.notify.dnd().until, (yield* kit.now) + 600_000)
    }))

})

describe("review 1.5: one test per asking device", () => {
  it.effect("two devices each get a test card; the second is not told one is open there", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      assert.deepStrictEqual((yield* kit.tool("notifications_send_test", {}, as("kitchen-display"))).value, { spoken: "I sent a test notification to this device." })
      assert.deepStrictEqual((yield* kit.tool("notifications_send_test", {}, as("robins-phone"))).value, { spoken: "I sent a test notification to this device." })
      assert.deepStrictEqual((yield* kit.tool("notifications_send_test", {}, as("robins-phone"))).value, { spoken: "A test notification is already open on this device." })
      yield* kit.notify.settle
      const all = yield* kit.notify.all
      assert.deepStrictEqual(all.map((n) => n.deviceId).sort(), ["kitchen-display", "robins-phone"])
      assert.isTrue(all.every((n) => /^test:[0-9a-f]{24}$/.test(n.key ?? "")))
    }))

  it.effect("two simultaneous requests on one device: one card, the other says it is open", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const both = yield* Effect.all([kit.tool("notifications_send_test", {}, as("kitchen-display")), kit.tool("notifications_send_test", {}, as("kitchen-display"))], { concurrency: "unbounded" })
      assert.deepStrictEqual(both.map((r) => (r.value as any).spoken).sort(), ["A test notification is already open on this device.", "I sent a test notification to this device."])
      assert.strictEqual((yield* kit.notify.all).length, 1)
    }))
})

describe("review 1.7: a do not disturb sentence names only the real end", () => {
  it.effect("for seconds, and a non-aligned end, English: a duration, never a clock time", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const on = (input: object) => kit.tool("notifications_dnd_on", input, as("kitchen-display")).pipe(Effect.map((r) => (r.value as any).spoken))
      assert.strictEqual(yield* on({ for: "ten seconds" }), "Do not disturb is on for the whole house for 10 seconds. Rings stay silent and nothing is announced.")
      assert.strictEqual(
        (yield* kit.tool("notifications_dnd_status", {}, as("kitchen-display")).pipe(Effect.map((r) => (r.value as any).spoken))),
        "Do not disturb is on for the whole house for another 10 seconds."
      )
      yield* kit.advance(4_500)
      assert.strictEqual((yield* kit.tool("notifications_dnd_status", {}, as("kitchen-display"))).value && ((yield* kit.tool("notifications_dnd_status", {}, as("kitchen-display"))).value as any).spoken, "Do not disturb is on for the whole house for another 6 seconds.")
      // An hour from a whole minute ends on a whole minute: the clock time is given too, and it is the real end.
      yield* kit.advance(10_000)
      assert.strictEqual(yield* on({ for: "an hour" }), "Do not disturb is on for the whole house for 1 hour. Rings stay silent and nothing is announced.")
    }))

  it.effect("until a time says the clock time; status gives what is left, and the clock time only on a whole minute; Dutch too", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const spoken = (name: string, input: object = {}) => kit.tool(name, input, as("kitchen-display")).pipe(Effect.map((r) => (r.value as any).spoken as string))
      assert.strictEqual(yield* spoken("notifications_dnd_on", { until: "eight" }), "Do not disturb is on for the whole house until today at eight o'clock. Rings stay silent and nothing is announced.")
      assert.strictEqual(yield* spoken("notifications_dnd_status"), "Do not disturb is on for the whole house for another 10 hours, until today at eight o'clock.")
      yield* kit.advance(1_000)
      assert.strictEqual(yield* spoken("notifications_dnd_status"), "Do not disturb is on for the whole house for another 9 hours 59 minutes 59 seconds, until today at eight o'clock.")
      const nl = yield* startTestModule(notificationsModule, NL)
      assert.strictEqual(((yield* nl.tool("notifications_dnd_on", { for: "tien seconden" }, as("kitchen-display"))).value as any).spoken, "Niet storen staat aan voor het hele huis voor 10 seconden. Beltonen blijven stil en er wordt niets omgeroepen.")
      assert.strictEqual(((yield* nl.tool("notifications_dnd_status", {}, as("kitchen-display"))).value as any).spoken, "Niet storen staat aan voor het hele huis, nog 10 seconden.")
    }))
})

describe("review 1.9: do not disturb until a time, as a phrase", () => {
  it.effect("clear, ambiguous and unrecognised times; unrecognised changes nothing", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const say = (text: string) => kit.phrases.say(text, { device: "kitchen-display" })
      assert.isTrue((yield* say("do not disturb until eight")).taken)
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Do not disturb is on for the whole house until today at eight o'clock. Rings stay silent and nothing is announced.")
      assert.strictEqual(kit.notify.dnd().until! - (yield* kit.now), 10 * 3_600_000)
      yield* kit.tool("notifications_dnd_off", {}, as("kitchen-display"))
      assert.isTrue((yield* say("do not disturb until banana")).taken)
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Until when? I didn't understand the time.")
      assert.isFalse(kit.notify.dnd().on)
      assert.isTrue((yield* say("do not disturb until yesterday at nine")).taken)
      assert.include(kit.phrases.spoken.at(-1)?.text, "passed")
      assert.isFalse(kit.notify.dnd().on)
      const nl = yield* startTestModule(notificationsModule, NL)
      assert.isTrue((yield* nl.phrases.say("niet storen tot acht uur", { device: "kitchen-display" })).taken)
      assert.include(nl.phrases.spoken.at(-1)?.text, "Niet storen staat aan voor het hele huis tot")
      assert.isTrue((yield* nl.phrases.say("niet storen tot banaan", { device: "kitchen-display" })).taken)
      assert.strictEqual(nl.phrases.spoken.at(-1)?.text, "Tot wanneer? Ik begreep de tijd niet.")
    }))

  it.effect("a really ambiguous time asks and changes nothing, in both languages", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      assert.isTrue((yield* kit.phrases.say("do not disturb until Friday at midnight", { device: "kitchen-display" })).taken)
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Until when exactly? That could be more than one time.")
      assert.isFalse(kit.notify.dnd().on)
      assert.include(((yield* kit.tool("notifications_dnd_on", { until: "Friday at midnight" }, as("kitchen-display"))).value as any).spoken, "more than one time")
      const nl = yield* startTestModule(notificationsModule, NL)
      assert.isTrue((yield* nl.phrases.say("niet storen tot vrijdag om middernacht", { device: "kitchen-display" })).taken)
      assert.strictEqual(nl.phrases.spoken.at(-1)?.text, "Tot wanneer precies? Dat kan meer dan één tijdstip zijn.")
      assert.isFalse(nl.notify.dnd().on)
    }))
})

describe("review 2", () => {
  /** A service whose list can be held: each held read says it started, and waits for `release`. */
  const gated = () => {
    const state = { held: false, started: 0, resolved: 0, release: Deferred.makeUnsafe<void>() }
    const change = (n: ModuleNotify): ModuleNotify => ({
      ...n,
      resolve: (id, outcome) => Effect.tap(n.resolve(id, outcome), (done) => Effect.sync(() => void (done && state.resolved++))),
      list: (q) => Effect.gen(function*() {
        if (state.held) {
          state.started++
          yield* Deferred.await(state.release)
        }
        return yield* n.list(q)
      })
    })
    return { state, change }
  }
  const until = (state: { started: number }, n: number) => Effect.gen(function*() { for (let i = 0; i < 2_000 && state.started < n; i++) yield* Effect.yieldNow })

  it.effect("an invocation still in flight is never forgotten: 256 fresh ones later its repeat joins it, and one card is dismissed", () =>
    Effect.gen(function*() {
      const g = gated()
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      const kit = yield* startTestModule(wrapped(g.change, seen), { secrets: { hookToken: TOKEN } })
      yield* hit(seen.routes[0]!, { body: { title: "Washer done", key: "w" } })
      const turn = kit.turn({ device: "kitchen-display", turnId: 5001 })
      g.state.held = true
      const original = yield* kit.tool("notifications_dismiss", {}, turn).pipe(Effect.forkChild)
      yield* until(g.state, 1)
      g.state.held = false
      for (let i = 0; i < 256; i++) yield* kit.tool("notifications_dnd_off", {}, as("kitchen-display"))
      const repeat = yield* kit.tool("notifications_dismiss", {}, turn).pipe(Effect.forkChild)
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow
      yield* hit(seen.routes[0]!, { body: { title: "Door open", key: "d" } })
      yield* Deferred.succeed(g.state.release, undefined)
      const results = [yield* Fiber.join(original), yield* Fiber.join(repeat)]
      // One invocation: the repeat joined it (the same answer), and it can never dismiss two cards.
      assert.deepStrictEqual(results[0]!.value, results[1]!.value)
      assert.isAtMost(g.state.resolved, 1)
    }))

  it.effect("at 64 invocations in flight a new mutation is refused as busy and nothing is done; it works again once they settle", () =>
    Effect.gen(function*() {
      const g = gated()
      const kit = yield* startTestModule(wrapped(g.change))
      g.state.held = true
      const fibers = []
      for (let i = 0; i < 64; i++) fibers.push(yield* kit.tool("notifications_dismiss", {}, as("kitchen-display")).pipe(Effect.forkChild))
      yield* until(g.state, 64)
      assert.strictEqual(g.state.started, 64)
      const refused = yield* kit.tool("notifications_dnd_on", {}, as("kitchen-display"))
      assert.isFalse(refused.ok)
      assert.include(refused.content, "I'm busy with other things right now; try again in a moment.")
      assert.isFalse(kit.notify.dnd().on)
      g.state.held = false
      yield* Deferred.succeed(g.state.release, undefined)
      for (const f of fibers) yield* Fiber.join(f)
      assert.isTrue((yield* kit.tool("notifications_dnd_on", {}, as("kitchen-display"))).ok)
    }))

  it.effect("the busy sentence is Dutch in a Dutch household", () =>
    Effect.gen(function*() {
      const g = gated()
      const kit = yield* startTestModule(wrapped(g.change), NL)
      g.state.held = true
      const fibers = []
      for (let i = 0; i < 64; i++) fibers.push(yield* kit.tool("notifications_dismiss", {}, as("kitchen-display")).pipe(Effect.forkChild))
      yield* until(g.state, 64)
      assert.include((yield* kit.tool("notifications_dnd_off", {}, as("kitchen-display"))).content, "Ik ben even bezig met andere dingen; probeer het zo nog eens.")
      g.state.held = false
      yield* Deferred.succeed(g.state.release, undefined)
      for (const f of fibers) yield* Fiber.join(f)
    }))

  it.effect("dismiss by tool and then by phrase of one identity is one request (the name is keyed as words)", () =>
    Effect.gen(function*() {
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      const kit = yield* startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: TOKEN } })
      yield* hit(seen.routes[0]!, { body: { title: "Washing machine done", key: "w" } })
      const turn = kit.turn({ device: "kitchen-display", source: "phrase", turnId: 5100 })
      assert.deepStrictEqual((yield* kit.tool("notifications_dismiss", { which: "The washing machine" }, turn)).value, { spoken: "Dismissed." })
      yield* hit(seen.routes[0]!, { body: { title: "Washing machine door", key: "d" } })
      assert.deepStrictEqual(yield* kit.action("dismiss", { which: "the  Washing machine!" }, turn), { ok: true, say: "Dismissed." })
      assert.deepStrictEqual((yield* kit.notify.all).filter((n) => n.state === "open").map((n) => n.title), ["Washing machine door"])
    }))

  it.effect("an until request is keyed by its resolved instant: the same time said two ways is one request", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const turn = kit.turn({ device: "kitchen-display", source: "phrase", turnId: 5200 })
      const a = yield* kit.tool("notifications_dnd_on", { until: "eight" }, turn)
      const instant = kit.notify.dnd().until
      yield* kit.tool("notifications_dnd_off", {}, as("kitchen-display"))
      const b = yield* kit.action("dnd_until", { time: "8 pm" }, turn)
      assert.deepStrictEqual([b.ok, (b as any).say], [true, (a.value as any).spoken])
      assert.isFalse(kit.notify.dnd().on) // the repeat did nothing: it returned the first outcome
      assert.isNumber(instant)
    }))

  const overlap = (language: "en" | "nl") => Effect.gen(function*() {
    const dutch = language === "nl"
    const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
    const kit = yield* startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: TOKEN }, ...(dutch ? NL : {}) })
    const [withArticle, plain, longer] = dutch ? ["De deur", "Deur", "De deur open"] : ["The Door", "Door", "Door open"]
    return { kit, seen, withArticle, plain, longer }
  })
  const openTitles = (kit: any) => Effect.map(kit.notify.all as Effect.Effect<ReadonlyArray<any>>, (all) => all.filter((n) => n.state === "open").map((n) => n.title).sort())

  for (const language of ["en", "nl"] as const) {
    it.effect(`a full title said wins over its article-less twin and its longer neighbour (${language})`, () =>
      Effect.gen(function*() {
        const { kit, seen, withArticle, plain, longer } = yield* overlap(language)
        yield* hit(seen.routes[0]!, { body: { title: withArticle, key: "a" } })
        yield* hit(seen.routes[0]!, { body: { title: plain, key: "b" } })
        yield* kit.tool("notifications_dismiss", { which: withArticle }, as("kitchen-display"))
        assert.deepStrictEqual(yield* openTitles(kit), [plain])
        // With "Door open" beside "The Door": the full title is not an ambiguity.
        yield* hit(seen.routes[0]!, { body: { title: longer, key: "c" } })
        yield* hit(seen.routes[0]!, { body: { title: withArticle, key: "d" } })
        yield* kit.tool("notifications_dismiss", { which: withArticle }, as("kitchen-display"))
        assert.deepStrictEqual(yield* openTitles(kit), [longer, plain].sort())
      }))

    it.effect(`two titles that are the same after articles are dropped ask, when none was said in full (${language})`, () =>
      Effect.gen(function*() {
        const { kit, seen, withArticle, plain } = yield* overlap(language)
        yield* hit(seen.routes[0]!, { body: { title: withArticle, key: "a" } })
        yield* hit(seen.routes[0]!, { body: { title: plain, key: "b" } })
        const ask = (yield* kit.tool("notifications_dismiss", { which: dutchOrEnglish(language) }, as("kitchen-display"))).value as any
        assert.deepStrictEqual([...ask.candidates].sort(), [plain, withArticle].sort())
        assert.deepStrictEqual(yield* openTitles(kit), [plain, withArticle].sort())
      }))
  }
  const dutchOrEnglish = (language: "en" | "nl") => (language === "nl" ? "een deur" : "a door")
})
