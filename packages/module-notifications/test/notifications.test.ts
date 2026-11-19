// The notifications module through the real host, gateway and notification service (the kit): its tools, its phrase
// commands, do not disturb, privacy on each kind of device, the inbound hook's handler, and the service failing.
import { assert, describe, it, vi } from "@effect/vitest"
import { type ModuleDefinition, type ModuleNotify, type ModuleRoute, NotifyError, type RouteRequest } from "@pva/core"
import { checkModule, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { holdsSecret, HOOK_TOKEN_HEADER, secretForms, tokenMatches } from "../src/hook.ts"
import { notificationsModule, catalog } from "../src/index.ts"
import { texts } from "../src/texts.ts"

vi.setConfig({ testTimeout: 30_000 })

const TOKEN = "hook-t0ken-for-tests-1234"
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
      const first = yield* kit.tool("notifications_send_test", {}, { device: "kitchen-display" })
      assert.deepStrictEqual(first.value, { spoken: "I sent a test notification to this device." })
      const again = yield* kit.tool("notifications_send_test", {}, { device: "kitchen-display" })
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
      const said = yield* kit.phrases.say("stuur een testmelding", { device: "kitchen-display" })
      assert.isTrue(said.taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["Ik heb een testmelding naar dit apparaat gestuurd."])
      const full = yield* startTestModule(wrapped((n) => ({ ...n, send: () => Effect.fail(new NotifyError({ reason: "limit", message: "x" })) })), NL)
      const r = yield* full.tool("notifications_send_test", {}, { device: "kitchen-display" })
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
      yield* kit.tool("notifications_send_test", {}, { device: "kitchen-display" })
      yield* hit(seen.routes[0]!, { body: { title: "Washer done", key: "washer" } })
      const kitchen = (yield* kit.tool("notifications_open", {}, { device: "kitchen-display" })).value as any
      assert.deepStrictEqual([...kitchen.titles].sort(), ["Test notification", "Washer done"])
      assert.strictEqual(kitchen.open, 2)
      assert.include(kitchen.covers, "not other modules'")
      assert.include(kitchen.outsideText, "untrusted")
      // The hall screen was not the test's origin: only the notification for every device.
      const hall = (yield* kit.tool("notifications_open", {}, { device: "hall-screen" })).value as any
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
      const sams = (yield* kit.tool("notifications_open", {}, { device: "kitchen-display" })).value as any
      assert.deepStrictEqual([sams.titles, sams.owner], [["Dentist at 3"], "p-sam"])
      const robins = (yield* kit.tool("notifications_open", {}, { device: "robins-phone" })).value as any
      assert.deepStrictEqual(robins.titles, ["Dentist at 3"])
      const hall = yield* kit.tool("notifications_open", {}, { device: "hall-screen" })
      assert.notInclude(hall.content, "Dentist")
      assert.include(JSON.stringify(hall.value), "1 personal ones are not read out here.")
      // Dismissing it from the public screen finds nothing: no title leaks through "which one".
      const dismissed = yield* kit.tool("notifications_dismiss", { which: "dentist" }, { device: "hall-screen" })
      assert.notInclude(dismissed.content, "Dentist")
      assert.strictEqual(((yield* kit.notify.all) as ReadonlyArray<any>)[0].state, "open")
      // On the owner's device it is dismissed, once.
      assert.deepStrictEqual((yield* kit.tool("notifications_dismiss", { which: "dentist" }, { device: "kitchen-display" })).value, { spoken: "Dismissed." })
      assert.strictEqual(((yield* kit.notify.all) as ReadonlyArray<any>)[0].outcome, "dismissed")
    }))

  it.effect("dismiss: by name, the only one, asks when several fit, an unknown name, nothing open, already gone", () =>
    Effect.gen(function*() {
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      const kit = yield* startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: TOKEN } })
      const dismiss = (which?: string) => kit.tool("notifications_dismiss", which === undefined ? {} : { which }, { device: "kitchen-display" })
      assert.include(JSON.stringify((yield* dismiss()).value), "nothing open")
      yield* hit(seen.routes[0]!, { body: { title: "Washer done", key: "a" } })
      yield* hit(seen.routes[0]!, { body: { title: "Washer finished", key: "b" } })
      yield* hit(seen.routes[0]!, { body: { title: "Door open", key: "c" } })
      const ask = (yield* dismiss()).value as any
      assert.include(ask.ask, "Which one?")
      assert.strictEqual(ask.candidates.length, 3)
      const two = (yield* dismiss("washer")).value as any
      assert.deepStrictEqual([...two.candidates].sort(), ["Washer done", "Washer finished"])
      assert.include(JSON.stringify((yield* dismiss("garage")).value), "I don't know a notification called garage.")
      assert.deepStrictEqual((yield* dismiss("door")).value, { spoken: "Dismissed." })
      assert.deepStrictEqual((yield* dismiss("washer done")).value, { spoken: "Dismissed." })
      // One left: no name needed. Then it is gone: a second dismissal does not claim success.
      assert.deepStrictEqual((yield* dismiss()).value, { spoken: "Dismissed." })
      assert.include(JSON.stringify((yield* dismiss()).value), "nothing open")
      // Resolved by someone else between the read and the change: said as gone, not as dismissed.
      let first = true
      const racy = yield* startTestModule(wrapped((n) => ({ ...n, resolve: (id, o) => (first ? ((first = false), Effect.succeed(false)) : n.resolve(id, o)) })), { secrets: { hookToken: TOKEN } })
      yield* racy.tool("notifications_send_test", {}, { device: "kitchen-display" })
      assert.deepStrictEqual((yield* racy.tool("notifications_dismiss", {}, { device: "kitchen-display" })).value, { spoken: "That one was already gone." })
    }))

  it.effect("a failed read is a failure, never 'nothing is open'; a cut read says so; Dutch", () =>
    Effect.gen(function*() {
      const failing = yield* startTestModule(wrapped((n) => ({ ...n, list: () => Effect.fail(new NotifyError({ reason: "failed", message: "x" })) })))
      const r = yield* failing.tool("notifications_open", {})
      assert.isFalse(r.ok)
      assert.include(r.content, "I couldn't read the open notifications.")
      const nl = yield* startTestModule(wrapped((n) => ({ ...n, list: () => Effect.fail(new NotifyError({ reason: "busy", message: "x" })) })), NL)
      assert.include((yield* nl.tool("notifications_dismiss", {})).content, "Ik kon de openstaande meldingen niet lezen.")
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
      yield* kit.tool("notifications_send_test", {}, { device: "kitchen-display" })
      const list = yield* kit.phrases.say("which notifications are open", { device: "kitchen-display" })
      assert.isTrue(list.taken)
      assert.include(kit.phrases.spoken.at(-1)?.text, "Test notification")
      const miss = yield* kit.phrases.say("dismiss the kettle", { device: "kitchen-display" })
      assert.isTrue(miss.taken)
      assert.include(kit.phrases.spoken.at(-1)?.text, "I don't know a notification called the kettle.")
      yield* kit.phrases.say("dismiss the notification", { device: "kitchen-display" })
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Dismissed.")
      const nl = yield* startTestModule(notificationsModule, NL)
      yield* nl.tool("notifications_send_test", {}, { device: "kitchen-display" })
      yield* nl.phrases.say("sluit de melding", { device: "kitchen-display" })
      assert.strictEqual(nl.phrases.spoken.at(-1)?.text, "Gesloten.")
    }))
})

describe("do not disturb", () => {
  it.effect("on, for a length of time, until a time, off and is it on, as tools; the service holds the state for the house", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(notificationsModule)
      const dnd = (name: string, input: object = {}) => kit.tool(name, input, { device: "kitchen-display" }).pipe(Effect.map((r) => (r.value as any).spoken ?? r.content))
      assert.strictEqual(yield* dnd("notifications_dnd_status"), "Do not disturb is off.")
      assert.include(yield* dnd("notifications_dnd_on"), "on for the whole house")
      assert.isTrue((kit.notify.dnd()).on)
      assert.include(yield* dnd("notifications_dnd_status"), "until you turn it off")
      const forTwo = yield* dnd("notifications_dnd_on", { for: "two hours" })
      assert.include(forTwo, "until today at noon")
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
      const say = (text: string) => kit.phrases.say(text, { device: "kitchen-display" })
      assert.isTrue((yield* say("do not disturb for ten minutes")).taken)
      assert.strictEqual((kit.notify.dnd()).until, (yield* kit.now) + 600_000)
      assert.include(kit.phrases.spoken.at(-1)?.text, "until")
      assert.isTrue((yield* say("is do not disturb on")).taken)
      assert.include(kit.phrases.spoken.at(-1)?.text, "until")
      assert.isTrue((yield* say("do not disturb off")).taken)
      assert.isFalse((kit.notify.dnd()).on)
      assert.isTrue((yield* say("do not disturb")).taken)
      assert.isUndefined((kit.notify.dnd()).until)
      // A duration beyond the bound is not a slot: it goes on to the assistant.
      assert.isFalse((yield* say("do not disturb for three weeks")).taken)
      const nl = yield* startTestModule(notificationsModule, NL)
      yield* nl.phrases.say("niet storen voor een uur", { device: "kitchen-display" })
      assert.include(nl.phrases.spoken.at(-1)?.text, "Niet storen staat aan voor het hele huis tot")
      yield* nl.phrases.say("staat niet storen aan", { device: "kitchen-display" })
      assert.include(nl.phrases.spoken.at(-1)?.text, "Niet storen staat aan")
      yield* nl.phrases.say("niet storen uit", { device: "kitchen-display" })
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
      const bad = (body: unknown) => hit(route, { body }).pipe(Effect.map((r) => [r.status, r.body.field]))
      assert.deepStrictEqual(yield* bad({ title: "x".repeat(61) }), [400, "title"])
      assert.deepStrictEqual(yield* bad({ title: "two\nlines" }), [400, "title"])
      assert.deepStrictEqual(yield* bad({ title: "   " }), [400, "title"])
      assert.deepStrictEqual(yield* bad({ title: "ok", text: "x".repeat(201) }), [400, "text"])
      assert.deepStrictEqual(yield* bad({ title: "ok", key: "bad key!" }), [400, "key"])
      assert.deepStrictEqual(yield* bad({ title: "ok", priority: "ring" }), [400, "field priority"])
      assert.deepStrictEqual(yield* bad({ title: "ok", target: "origin" }), [400, "field target"])
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

  it.effect("while the module is stopped, its route is not the published one (the host withdraws it); after a restart the same token works", () =>
    Effect.gen(function*() {
      const seen = { routes: [] as ReadonlyArray<ModuleRoute> }
      const kit = yield* startTestModule(wrapped((n) => n, seen), { secrets: { hookToken: TOKEN } })
      yield* kit.restart
      assert.strictEqual((yield* hit(seen.routes[0]!)).status, 202)
    }))
})
