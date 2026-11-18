# Writing a module (module API v2)

This is for the author of one module of [docs/MODULES-PLAN.md](MODULES-PLAN.md) §5.1, who has this page, the plan's row
for their module and their module's research document (`docs/research/modules/<name>.md`), and nothing else. It says
what a module is, the rules the preparation stack (P1 to P6) settled, and how to test a module so that it keeps them.
Where this page and a research document disagree, the plan and this page win.

The deeper references, only when this page is not enough: [ARCHITECTURE.md](ARCHITECTURE.md) (the host, the gateway,
the store, the scheduler, people), [UI-AND-MODULES.md](UI-AND-MODULES.md) §1.10–§1.11 (API v2, settings fields,
routes), [STORING-DATA.md](STORING-DATA.md), [SCHEDULING.md](SCHEDULING.md).

Every code block on this page is quoted from a test file that compiles and runs (`docs.test.ts` in
`packages/module-contracts/test` keeps them the same). The **reference module** is
`packages/module-contracts/test/kit/pinboard.ts`: short notes pinned for the household or one person. It has one of
everything (a setting, a secret, a collection with an index and paging, a tool that reads, a tool that changes, an
action, a scheduled job, a route, a health check, personal content, two languages) and `pinboard.test.ts` runs each
part through the test kit.

## Contents

1. [What you start from](#1-what-you-start-from)
2. [The shape of a module](#2-the-shape-of-a-module)
3. [The turn: who is asking](#3-the-turn-who-is-asking)
4. [Risk classes and what the gateway refuses](#4-risk-classes-and-what-the-gateway-refuses)
5. [Storing data](#5-storing-data)
6. [Scheduling](#6-scheduling)
7. [People and privacy](#7-people-and-privacy)
8. [Secrets](#8-secrets)
9. [Settings forms](#9-settings-forms)
10. [HTTP routes](#10-http-routes)
11. [The network](#11-the-network)
12. [Services and contributions between modules](#12-services-and-contributions-between-modules)
13. [What a module survives, and what it must not do](#13-what-a-module-survives-and-what-it-must-not-do)
14. [Latency](#14-latency)
15. [Speaking](#15-speaking)
16. [Testing: the kit and checkModule](#16-testing-the-kit-and-checkmodule)
17. [What a module pull request may touch](#17-what-a-module-pull-request-may-touch)
18. [The modules](#18-the-modules)

## 1. What you start from

The scaffold (P11) has made your package, `packages/module-<id>/`: a `package.json` with the libraries the plan's
Appendix A gives your module and the workspace packages it needs, a `tsconfig.json`, and `src/index.ts`, which exports
your module (`defineModule`, `apiVersion: 2`, off by default, no tools) and a `catalog` array with it. The app lists
that array once (`apps/assistant/src/modules.ts`), so **you never edit the catalogue**: what your package's `catalog`
holds is what the app runs. Keep the module's id; you may turn the definition into a factory that takes test
dependencies (`listsModule(deps)`) as long as `catalog` holds the production one.

`test/module.test.ts` already runs the conformance check (§16) on it. Your page is `docs/modules/<id>.md`, a stub with
its headings (§17).

The contracts you provide or consume are in `@pva/module-contracts` (§12); their fakes for your tests in
`@pva/module-contracts/fakes`. Spoken numbers, times, dates, durations, quantities and recurrences are
`@pva/language`; outgoing HTTP is `@pva/net`.

## 2. The shape of a module

A module is one `defineModule({...})` with two lifetimes:

- **`shared(ctx)`** runs **once per module** while it is demanded (a switched-on assistant has it on, or a demanded
  module names it in `uses`), with the module's shared settings only. Sockets, caches, job handlers, event
  subscriptions, services, contributions and routes belong here. What it returns as `value`, every instance gets as
  `ctx.shared`. 10 s to start.
- **`start(ctx)`** runs once per **distinct set of effective settings** (assistants with equal settings share one
  instance): tools, actions, context providers, instructions. 10 s to start.

They start, stop and are replaced **together**: any change of what the module runs (a shared setting, an assistant
joining with new values, a secret, a restart) withdraws everything it published, gives its calls in flight 10 s, closes
its instances, then its shared part, and only then starts the new ones. For that moment the module is absent. There is
never an old and a new one at once.

The definition's other members: `settings` (§9), `storage` (§5), `events` (event types voice pages may see), `uses`
(module ids this one cannot run without), `requires` (`{ network: "internet" | "lan", why }`, or a program on the
server), `health` (below), `templates` (suggested assistants), `declaredActions` (known while it is unavailable),
`fieldActions` (Test buttons), `version`. The reference module's settings and its shared part:

<!-- region: packages/module-contracts/test/kit/pinboard.ts#settings -->
```ts
const settings = {
  keepDays: Setting.number({ label: "Keep notes for", description: "Days a note stays pinned.", default: 7, integer: true, min: 1, max: 365, unit: "days" }),
  signingKey: Setting.secret({ label: "Webhook key", description: "When set, the pin address also needs it in the X-Pinboard-Key header." })
}
```

<!-- region: packages/module-contracts/test/kit/pinboard.ts#shared -->
```ts
shared: (ctx) =>
  Effect.gen(function*() {
    const board = ctx.store.collection(notes)
    // A handler is registered in `shared` (once per module), with a payload schema, idempotent: running it twice is fine.
    yield* ctx.scheduler.handle("expire", {
      payload: Schema.Struct({}),
      idempotent: true,
      run: () =>
        Effect.gen(function*() {
          const keepDays = ctx.settingsFor(undefined)?.keepDays ?? 7
          const job = yield* CurrentJob
          const cutoff = (yield* Clock.currentTimeMillis) - keepDays * 86_400_000
          const old = (yield* allNotes((q) => board.list({ orderBy: { field: "pinnedAt", direction: "asc" }, ...q }))).filter((r) => r.value.pinnedAt < cutoff)
          // One synchronous transaction; nothing in it awaits, and no store failure is caught inside it.
          yield* ctx.store.transaction((tx) => {
            for (const row of old) tx.collection(notes).remove(row.id, { actor: { kind: "job", jobId: job?.jobId ?? "expire" } })
          })
        })
    }).pipe(Effect.orDie)
    // A system job: cron with minute, hour and day of week only. Scheduling the same key again replaces it.
    yield* ctx.scheduler.schedule({ handler: "expire", key: "expire", payload: {}, cron: "0 4 * * *" }).pipe(Effect.orDie)
    return {
      value: undefined,
      // A route under /api/modules/pinboard/pin: a token of this module AND a LAN caller; a small JSON body.
      routes: [{
        method: "POST" as const,
        path: "pin",
        guards: ["token", "lan"] as const,
        token: "pin",
        bodyLimitBytes: 1_024,
        description: "Pin a household note from a home automation.",
        handler: (request) =>
          Effect.gen(function*() {
            const key = ctx.settings.signingKey
            if (key !== undefined) {
              const given = Buffer.from(request.headers["x-pinboard-key"] ?? "")
              const want = Buffer.from(key)
              if (given.length !== want.length || !timingSafeEqual(given, want)) return { status: 401, body: { error: "bad key" } }
            }
            const body = request.body as { readonly text?: unknown } | undefined
            const text = typeof body?.text === "string" ? body.text.trim() : ""
            if (text === "" || !Schema.is(StoredText(200))(text)) return { status: 400, body: { error: "text: 1 to 200 characters of one line" } }
            const row = yield* board.insert({ text, pinnedAt: yield* Clock.currentTimeMillis })
            return { status: 201, body: { id: row.id } }
          })
      }]
    }
  }),
```

What `start` returns (`ModuleInstance`): `tools` (for the model), `actions` (typed actions: each is a generated tool
`<moduleId>_<actionId>` and an intent for the fast path; give `examples`, English and Dutch), `context` (context
providers, §14), `instructions` (one stable sentence or two appended to the system prompt while the module is on;
never changing data), and `info` / `settingOptions` / `fieldActions` for the form. A tool that reads:

<!-- region: packages/module-contracts/test/kit/pinboard.ts#read-tool -->
```ts
const read = makeTool({
  name: "pinboard_read",
  description: "Read the notes pinned on the household's pinboard, newest first.",
  parameters: Schema.Struct({}),
  speculative: true, // a plain read: safe to run before the turn is committed; its risk is `read`
  // The result names whose personal note it holds; the gateway checks it against the asking device (P8).
  sensitivity: (result) => {
    const owner = (result as { readonly owner?: string }).owner
    return owner === undefined ? { kind: "household" } : { kind: "personal", owner }
  },
  execute: () =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      // Looked up at each use, never kept: `Privacy` is the core's, and decides at the moment of revealing.
      const privacy = ctx.host.service(Privacy)
      const lang = languageOf(ctx.host.view())
      const rows = yield* allNotes((q) => board.list({ orderBy: { field: "pinnedAt", direction: "desc" }, ...q })).pipe(
        Effect.mapError(() => new ToolError({ message: "The pinboard could not be read." }))
      )
      if (rows.length === 0) return { spoken: say(texts, lang, "empty") }
      let owner: string | undefined
      let withheld = 0
      const shown: Array<string> = []
      for (const r of rows) {
        const o = r.value.owner
        // A personal note is read only where the rule allows it now, on the device that will speak it.
        if (o !== undefined && privacy?.mayReveal(o, turn) !== true) {
          withheld++
          continue
        }
        if (o !== undefined) owner ??= o
        shown.push(r.value.text)
      }
      return {
        notes: shown.slice(0, 10),
        more: Math.max(0, shown.length - 10),
        ...(withheld > 0 ? { withheld: say(texts, lang, "withheld", { count: withheld }) } : {}),
        ...(owner !== undefined ? { owner } : {})
      }
    })
})
```

A tool that changes, with its risk class, and an action:

<!-- region: packages/module-contracts/test/kit/pinboard.ts#change-tool -->
```ts
const pin = makeTool({
  name: "pinboard_pin",
  description: "Pin a short note on the pinboard, for everyone or only for the person asking.",
  parameters: Schema.Struct({
    text: StoredText(200).annotate({ description: "The note, one short line" }),
    forMe: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only for the person asking" }))
  }),
  risk: "change", // it changes household data: declared, never left to be inferred
  execute: ({ text, forMe }) =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const lang = languageOf(ctx.host.view())
      const person = forMe === true ? turn?.person?.id : undefined
      yield* board.insert({ text, pinnedAt: yield* Clock.currentTimeMillis, ...(person !== undefined ? { owner: person } : {}) }).pipe(
        Effect.mapError(() => new ToolError({ message: "The note could not be pinned." }))
      )
      if (forMe === true && person === undefined) return { spoken: say(texts, lang, "noPerson") }
      return { spoken: say(texts, lang, "pinned", { text }) }
    })
})
```

<!-- region: packages/module-contracts/test/kit/pinboard.ts#action -->
```ts
const clear = defineAction({
  id: "clear",
  label: "Clear the pinboard",
  description: "Take down every household note older than a day. Personal notes stay.",
  examples: ["clear the pinboard", "take the old notes down", "maak het prikbord leeg"],
  params: {},
  risk: "change",
  run: () =>
    Effect.gen(function*() {
      const lang = languageOf(ctx.host.view())
      const cutoff = (yield* Clock.currentTimeMillis) - 86_400_000
      const old = (yield* allNotes((q) => board.list({ orderBy: { field: "pinnedAt", direction: "asc" }, ...q })).pipe(
        Effect.mapError(() => new ActionError({ message: "The pinboard could not be read." }))
      )).filter((r) => r.value.owner === undefined && r.value.pinnedAt < cutoff)
      yield* ctx.store.transaction((tx) => {
        for (const row of old) tx.collection(notes).remove(row.id)
      }).pipe(Effect.mapError(() => new ActionError({ message: "The pinboard could not be cleared." })))
      return { say: say(texts, lang, "cleared", { count: old.length }) }
    })
})
```

**`health`** is a cheap check (at start, on "Check again", by `pnpm start doctor`; never on a turn; 5 s) that returns
issues with a fix. A module that depends on anything outside the process declares `requires` and `health` (§3.3 of the
plan); `checkModule` fails one that requires the network without a `health`. Issue ids are prefixed with the module id
by the host.

<!-- region: packages/module-contracts/test/kit/pinboard.ts#health -->
```ts
health: ({ settings }) =>
  Effect.succeed(
    settings?.signingKey === undefined
      ? [{ id: "pinboard.no-key", severity: "info" as const, title: "The pin address has no key", detail: "Any LAN caller with a token can pin. Set a webhook key to require it too." }]
      : []
  ),
```

**A module never keeps what the host gave it past its part.** Every member of `ctx` (`host`, `store`, `events`,
`scheduler`, the core services) answers `ModuleStopped` once the part that got it has closed. Look services up at each
use (§12), and ask `ctx.settingsFor(assistantId)` each time shared code acts for a caller: a change that keeps the run
(an assistant joining an existing instance) changes its answer without a restart.

## 3. The turn: who is asking

Every tool call, action run and context gathering of a turn runs with **`CurrentTurn`** (`yield* CurrentTurn`): turn
id, conversation id, assistant id, device id and name, room, person, `source` (`voice`, `text`, `touch`, `phrase`,
`routine`) and an opaque `connection`. What a tool may assume when it runs, because the **execution gateway** admitted
the call first:

- the assistant exists, has the module on, and has not switched the tool off;
- the device is a known device and has that assistant; the connection is that device's;
- the person, when there is one, is in Members and is **the device's default person** (`how: "device-default"`; there is
  no voice identification). A person selects *whose* data a turn means; it never grants anything. A device id is
  claimed by the page, not authenticated: never treat "the turn is Sam's" as proof that Sam is there.

What it may not assume: that there is a person (a shared device without a default person, a public screen), a room, or
a screen. Outside a turn there is no `CurrentTurn`: a job runs with `CurrentJob` (its origin: the module, and the
assistant, device and person it was scheduled for), a route handler and `shared` code with neither. Code that awaits
inside native callbacks loses the fiber's context: read `CurrentTurn` first and pass it on.

## 4. Risk classes and what the gateway refuses

Every tool and action has a class: `read` (lookups), `change` (household state: lights, timers, lists, speaking on the
house's own devices), `message` (sent to people outside the house, or in the owner's name on an outside channel),
`money`, `security` (locks, alarms, garage doors). **Declare it** on everything that is not a plain read: `risk:
"change"`. A plain read is `speculative: true` (it may run before the turn is committed) and is `read`. A class that
depends on the input is `risk: { classes: ["change", "security"], of: (input) => … }`: a pure function of the validated
input, at most 2 ms, that answers one of its declared classes (otherwise the call is refused with a generic sentence).

What the gateway does, in order, on every path (a model's tool call, the Claude Code bridge, the intent agent, a
routine step through `host.actions.run`, a job): checks the principal (above), that the assistant has the module on and
the tool is not switched off, runs the risk function, then the risk policy. In this stack the policy is fixed: `read`
and `change` run; `message` is refused as needing a confirmation; **`money` and `security` are refused everywhere**
(devices are not authenticated). An action declared `confirm: true` is refused on every path (confirmation is off).
A refusal comes back to the model as a tool result "Not run: …" and the module's code never runs. So: do not build
anything whose first version needs `message`, `money` or `security`; say in the description of a tool that can be
`money` or `security` that it is (`checkModule`'s `risk-said`), so the model is not surprised by the refusal.

`sensitivity` (`household`, `personal` with an owner, or a function of the result) says whose a result is; the gateway
carries it and P8 checks it against the asking device. `latency` (`instant`, `quick`, `slow`, `background`) is metadata.

## 5. Storing data

Data that outlives a turn lives in **document collections** in the household store (`data/household.db`), declared on
the manifest and used through `ctx.store` in `shared` and `start`. There is no SQL, no search and no undo in the
interface.

<!-- region: packages/module-contracts/test/kit/pinboard.ts#collection -->
```ts
const PERSON_ID = Schema.String.check(Schema.isMaxLength(40), Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,39}$/))

/** One pinned note: household data, or personal with its owner (a Members id). */
export const Note = Schema.Struct({
  text: StoredText(200),
  /** Absent: the household's. Present: personal, shown only where `Privacy.mayReveal(owner, device)` says so. */
  owner: Schema.optionalKey(PERSON_ID),
  /** Epoch ms; indexed, so lists can be ordered by it and read page by page. */
  pinnedAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))
})
export type Note = typeof Note.Type

export const notes = defineCollection({
  name: "notes",
  scope: "household",
  schema: Note,
  // The worst legal note is about 700 characters of JSON (checkModule computes it): 800 lets one list read 31 rows.
  maxChars: 800,
  indexes: ["pinnedAt"]
})
```

The rules:

- **`maxChars` and the rows a list may read.** A value is a JSON object of at most `maxChars` characters of JSON
  (default 2,000, at most 16,000). A `list` asks for at most `maxListRows(c) = min(100, floor(25,000 / maxChars))` rows
  (12 at 2,000; 62 at 400; 100 at 250). **Declare `maxChars` as small as your values really are**, and bound every
  field so the worst legal value fits it: `checkModule`'s `stored-value` computes the worst from the schema (a string
  costs 6 characters of JSON per character, the worst JSON escape; `StoredText(n)` from `@pva/module-contracts` costs 2,
  because it refuses control characters and lone surrogates; a string or list without a maximum cannot fit at all).
- **Lists** are one index range: no filter (ordered by `updatedAt`, `createdAt` or an indexed field), an equality
  filter on one indexed field, or a filter on `f` ordered by `g` with the pair `[f, g]` declared. Anything else is
  `invalid`: store a combined field and index it. Ties go by `createdAt`, then id.
- **Paging with `after`**: to read more than one list returns, pass the last row of a page as `after` in the same query.
  `after` must be a row a list returned, not a copy.

<!-- region: packages/module-contracts/test/kit/pinboard.ts#reading -->
```ts
/** Every note, newest first, page by page: a list reads at most `maxListRows(notes)` rows, `after` continues. */
const allNotes = (list: (q: { readonly limit: number; readonly after?: Row<Note> }) => Effect.Effect<ReadonlyArray<Row<Note>>, unknown>) =>
  Effect.gen(function*() {
    const out: Array<Row<Note>> = []
    let after: Row<Note> | undefined
    for (let page = 0; page < 20; page++) {
      const rows = yield* list({ limit: 25, ...(after !== undefined ? { after } : {}) })
      out.push(...rows)
      if (rows.length < 25) break
      after = rows.at(-1)
    }
    return out
  })
```

- **Scopes**: `household`, `person`, `assistant`, `device`, `conversation`, filled from `CurrentTurn` or passed
  (`{ scope: { kind, id } }`, the only way outside a turn). A person-scoped call with no person fails `ScopeUnknown`:
  ask "whose?"; it is never written to the household instead. A collection's scope never changes.
- **Transactions are synchronous and flat**: `ctx.store.transaction((tx) => …)` runs a plain function (no `await`, no
  Effect, no promise: that rolls everything back and fails `invalid`) in one uninterrupted step; a transaction inside one
  joins it. Do the asynchronous work before or after. Events of a transaction are released after its commit.
- **Never catch a store failure inside a transaction and go on with it.** A failure your function throws and does not
  catch rolls it back; one it catches is a failed call and the rest commits. A scheduler's `writeIn` that fails with
  anything but a refusal must not be caught (§6): committing after it could keep half a write.
- `update(id, f, { expectRev })` reads, applies `f` and writes in one step; `expectRev` makes an edit from an older
  read a `StoreConflict`. Write amounts as deltas. Pass `{ actor }` from jobs and routes.
- **Data versions and migrations.** One `storage.version` per module (default 1). **Any change of a collection's
  schema, indexes or `maxChars` needs a higher version**, and `migrate: { [fromVersion]: (json) => json }` where the
  values change; changing a custom check's function needs one too. The upgrade runs once at start, before the module,
  after a backup, all collections in one transaction (at most 20,000 rows); a failure leaves the module `unavailable`
  and the data as it was. Data written by a newer version makes the module `unavailable` and is never touched.
- **`remove` removes for good** (secure delete, the log checkpointed), but the daily backups keep a row up to 14 days:
  say so where a person asks to forget something.
- **What must not be stored**: secrets, passwords, door codes (refuse them: "I don't keep codes"); anything a person
  would not want read by anyone on the home network in a `device` or `person` scope or a projection to voice pages
  (device ids are claimed, not authenticated); the id of a projected row is visible to every page that could see its
  scope, so put nothing private in an id. Personal content without its owner (§7).
- Errors: `StoreError` (`unavailable`, `read-only` in the CLI modes, `invalid`, `busy`, `failed`), `StoreConflict`,
  `StoreNotFound`, `ScopeUnknown`. `busy` means nothing was done; say so and let the person try again.

## 6. Scheduling

The scheduler calls a handler of your module at a time, once. **Register handlers in `shared`** (an instance runs once
per distinct settings, and two handlers of one name refuse the start); see the reference module's `shared` above. Then:

- **`schedule({ handler, payload, at | inMs | cron, key?, late?, origin? })`**. The payload is JSON of at most 1,000
  characters (keep data in your own collection and schedule its id); **an absent payload is `null`**, so a handler with
  `Schema.Struct({})` needs `payload: {}` (`checkModule`'s `job-payload`). A `key` keeps one live job per key: scheduling
  it again replaces the old one. At most 200 live jobs per module.
- **Idempotency and retries**: a handler that declares `idempotent: true` is retried with back-off (5 s, 10 s, 20 s, …)
  up to `retries` (default 3, at most 10) when it fails, times out (`timeoutMs`, default 60 s) or is cut short by a
  crash; one that does not is run at most once per occurrence and a failure is `failed` on the Health page. Declare it
  only if running twice is harmless (it checks what it already did).
- **The late rule**: `late: "run"` (the default) runs a job found late once, however late; `late: { withinMs }` runs it
  only that late at most, else the job is `missed` and the handler is not called. A repeating job that missed several
  occurrences runs once, for the latest. The handler is told how late it is (`due.lateMs`).
- **The cron grammar** is for system jobs (a cache refresh, a nightly clean-up): minute, hour and day-of-week fields
  (and seconds first), **day of month and month must be `*`**, at most 100 characters. `0 7 1 * *` is refused
  (`checkModule`'s `cron`). A cron job without a `timeZone` uses the household's.
- **A spoken recurrence** ("every second Tuesday") is an `RRULE` kept in **your own row**, with **one job for the next
  occurrence**; the handler plans the one after. `@pva/language` reads the phrase (`parseRecurrence`, never guessing:
  ambiguous is a question) and computes the next time (`nextOccurrence`):

<!-- region: packages/module-contracts/test/kit/examples.test.ts#recurrence -->
```ts
const Rule = Schema.Struct({ text: StoredText(120), rrule: StoredText(200), dtstart: StoredText(80), timeZone: StoredText(64) })
const rules = defineCollection({ name: "rules", scope: "household", schema: Rule, maxChars: 1_100 })

export const nagModule = defineModule({
  apiVersion: 2,
  id: "nag",
  name: "Nag",
  description: "Repeats a line on a spoken schedule.",
  enabledByDefault: false,
  storage: { collections: [rules] },
  shared: (ctx) =>
    Effect.gen(function*() {
      const store = ctx.store.collection(rules)
      /** One job for the next occurrence only; its handler plans the one after. The rule stays in our own row. */
      const planNext = (id: string, rule: typeof Rule.Type, after: number) => {
        const at = nextOccurrence(rule, after)
        return at === undefined
          ? Effect.void // the series has ended
          : Effect.asVoid(ctx.scheduler.schedule({ handler: "due", key: `rule:${id}`, payload: { id }, at, late: { withinMs: 15 * 60_000 } }))
      }
      yield* ctx.scheduler.handle("due", {
        payload: Schema.Struct({ id: Schema.String }),
        run: ({ id }, due) =>
          Effect.gen(function*() {
            const row = yield* store.get(id)
            if (row === undefined) return // removed meanwhile: nothing to do, nothing to plan
            // … deliver it (P9's notifications, once they exist) …
            yield* planNext(id, row.value, due.dueAt)
          })
      }).pipe(Effect.orDie)
      return { value: { store, planNext } }
    }),
  start: (ctx) =>
    Effect.succeed({
      tools: [makeTool({
        name: "nag_every",
        description: "Repeat a line on a schedule said in words (\"every Tuesday at half seven\").",
        parameters: Schema.Struct({ text: StoredText(120), when: Schema.String.check(Schema.isMaxLength(120)) }),
        risk: "change",
        execute: ({ text, when }) =>
          Effect.gen(function*() {
            const timeZone = String(ctx.host.view().home.HOME_TIME_ZONE ?? "Europe/Amsterdam")
            const now = yield* Clock.currentTimeMillis
            const said = parseRecurrence(when, homeLanguage(ctx.host.view()), { now, timeZone })
            // Never guessed: ambiguous or not understood becomes a question for the person.
            if (said.kind !== "ok") return { spoken: `When exactly? I didn't understand "${when}".` }
            const rule = { text, rrule: said.value.rrule, dtstart: said.value.dtstart, timeZone: said.value.timeZone }
            const row = yield* ctx.shared.store.insert(rule).pipe(Effect.mapError(() => new ToolError({ message: "It could not be saved." })))
            yield* ctx.shared.planNext(row.id, rule, now).pipe(Effect.mapError(() => new ToolError({ message: "It could not be planned." })))
            return { spoken: `Every time: ${text}.`, first: said.value.startInstant }
          })
      })]
    })
})
```

- **Inside your own transaction**: `prepare(request)` (an Effect, outside), then `job.writeIn(tx)` (synchronous,
  inside): the job commits or rolls back with your rows. A refusal (`invalid` at the limit) may be caught and the rest
  committed; any other failure of `writeIn` must not be caught.
- No pause and resume (cancel and schedule again), no background tasks (a fiber in your own scope), no notification
  jobs (P9's service has its own). `cancel`, `reschedule`, `get` and `list` (your live jobs, 10 a page, `after`).

## 7. People and privacy

Two levels of content, on a result, a spoken line or anything shown: **household** (the default) and **personal**, which
names its owner (a Members person id). The rule, `Privacy.mayReveal(owner, device)`, about **the device that will speak
or show it** (not always the device that asked):

| device | personal content |
|---|---|
| `private` | yes |
| `shared` | only when its default person is the owner |
| `public` | no |

It fails closed: an unknown or missing owner, a person no longer in Members, an unknown device are all no. Personal
content with no known owner is treated as someone else's. So:

- **Put an owner on personal content** when you store it (a person-scoped row, or an owner field), and keep household
  data in the household.
- **Ask `Privacy.mayReveal` at the moment of revealing**, for that device (the reference module's read tool above): on
  a shared device that is not the owner's, reduce it ("Sam: busy 12:30 to 13:30") or leave it out and say so; on a
  public one leave it out.
- **Never cache** the answer of `mayReveal`, of `settingsFor`, or a membership (`People.get`): a device's place, its
  default person and Members change while the module runs (a change of privacy or default person also ends that
  device's session). Look them up when acting.
- `People` (`host.service(People)`): `list`, `get`, `find(spoken)` (`found` / `ambiguous` / `none`: ask when ambiguous),
  diets (`dietOf`, `setDiet`). `Devices`: the known devices, their places and capabilities, the best other screen.
- There are no children, no trusted devices and no voice identification in this stack. Do not suggest protections
  that do not exist.

## 8. Secrets

A secret is a settings field of kind secret: `Setting.secret({ label, required? })`. It lives in the key vault, never on
a page, never overridable by an assistant, and the module receives it in `settings` only while the vault is unlocked.
**Never put a secret, or anything derived from one, in a status line, an error, a log line, a tool result, an action's
text, an option label or value, a description, an `info` value, a route path or token name, or a Health issue.** Say
what happened instead ("The key was refused"). The host's page boundary replaces exact occurrences of a secret on admin
pages with `[secret]`, but that is a safety net, not a licence (it cannot see an encoded or cut secret); `checkModule`
starts the module with recognisable secret values and fails (`secret`) when one reaches what the module wrote or what
the admin page shows. Compare a secret with `timingSafeEqual` (the reference module's route). A route's callers use
route tokens the owner mints (§10), not module secrets.

## 9. Settings forms

Field kinds (`Setting.*` from `@pva/core`): `text`, `secret`, `number`, `boolean`, `choice`, `multichoice`, `textList`,
`records` (a list of flat items), `combo` (a choice with suggestions the instance fills), `action` (a button: a "Test"
handler in `fieldActions`, 8 s) and `info` (a read-only value the instance sets). A field may be `overridable` (an
assistant may own its value; never a secret, and modules do not mark addresses) and `visibleWhen` another field has one
of some values. Precedence: environment, then saved, then default.

- **`records` stay flat**: an item is text, number, boolean, choice, multichoice or text-list fields. **Nested
  configuration** (a routine's steps, an MCP server's tool policy) is **JSON in a text field**, validated with a schema
  and explained on error. Nobody builds a nested editor in this stack.
- **Size budgets**: the described form at most 8 KiB as the wire encodes it (the module does not start otherwise:
  `checkModule`'s `form`); the complete form as sent, with values and tools, at most 48 KiB (a save over it is
  refused); a `records` or `textList` value at most 32 KB of JSON; a `combo` at most 200 options; `info` values cut to
  1,000 characters, Test results to 500.

<!-- region: packages/module-contracts/test/kit/examples.test.ts#settings-form -->
```ts
/** Nested configuration (a routine's steps) is JSON in a text field, validated with a schema and explained on error. */
const Steps = Schema.Array(Schema.Struct({ say: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))), action: Schema.optionalKey(Schema.String) })).check(
  Schema.isMaxLength(20)
)
const decodeSteps = Schema.decodeUnknownExit(Schema.fromJsonString(Steps))
const explainSteps = (text: string): string | undefined =>
  text.trim() === "" || Exit.isSuccess(decodeSteps(text)) ? undefined : "Steps are a JSON list of at most 20 { \"say\": … } or { \"action\": … } objects."

export const formSettings = {
  baseUrl: Setting.text({ label: "Server address", placeholder: "http://searx.lan:8080", maxLength: 200 }),
  apiKey: Setting.secret({ label: "API key" }),
  count: Setting.number({ label: "Results", default: 3, integer: true, min: 1, max: 10, overridable: true }),
  rooms: Setting.textList({ label: "Rooms", maxItems: 20, itemMaxLength: 40 }),
  feeds: Setting.records({
    label: "Feeds",
    itemLabel: "feed",
    titleKey: "name",
    maxItems: 30,
    item: { name: Setting.text({ label: "Name", maxLength: 40 }), url: Setting.text({ label: "Address", maxLength: 300 }) }
  }),
  steps: Setting.text({ label: "Steps (JSON)", multiline: true, maxLength: 4_000, check: explainSteps }),
  test: Setting.action({ label: "Check the server", buttonLabel: "Test" })
}
```

## 10. HTTP routes

A `shared` part may return `routes`, answered under `/api/modules/<moduleId>/<path>` only while that part is the
published one (404 when the module is stopped, 503 while it restarts). Each route declares **guards, every one of which
must pass**: `admin` (the admin session), `token` (a route token of this module with the route's `token` name, minted by
the owner on the module's page, one per caller, revocable), `lan` (a private or loopback caller; refused for everyone
when the server is behind a declared proxy). A route without guards must be `public: true`, a GET with no body. Also:
`body` (`json`, `bytes`, `none`), `bodyLimitBytes` (8 KB, at most 1 MB), `rateLimit` (30 a minute per caller, 120 in
all), `timeoutMs` (5 s, at most 30 s). A handler runs outside any turn, in a slot of the module (at most 16 at once),
and is interrupted when its part closes. Requests a browser marks as from another site are refused before the guards.

The reference module's route is in its `shared` part above; its test:

<!-- region: packages/module-contracts/test/kit/pinboard.test.ts#route -->
```ts
it.effect("the pin address needs a token of the module and a LAN caller, and the key when one is set", () =>
  Effect.gen(function*() {
    const board = yield* startTestModule(pinboardModule, { secrets: { signingKey: "k3y-for-tests" } })
    const { secret } = yield* board.mintRouteToken("pin", "Home Assistant")
    const body = { text: "Washing done" }
    assert.strictEqual((yield* board.route({ method: "POST", path: "pin", body })).status, 401)
    assert.strictEqual((yield* board.route({ method: "POST", path: "pin", body, as: { token: secret, address: "8.8.8.8" } })).status, 403)
    assert.strictEqual((yield* board.route({ method: "POST", path: "pin", body, as: { token: secret } })).status, 401)
    const ok = yield* board.route({ method: "POST", path: "pin", body, headers: { "X-Pinboard-Key": "k3y-for-tests" }, as: { token: secret } })
    assert.strictEqual(ok.status, 201)
    const read = yield* board.tool("pinboard_read", {})
    assert.deepStrictEqual((read.value as { notes: Array<string> }).notes, ["Washing done"])
  }))
```

## 11. The network

Outgoing HTTP is `@pva/net`, never `fetch`:

- **`safeFetch(url, { accept, … })`** for public APIs and any URL a model chose: `accept` (the response types you take:
  `contentTypes.json`, `webPage`, `feed`, `image`, or your own) is required; only `http`/`https`, ports 80 and 443, no
  credentials in the URL, every non-public address refused (checked on the address it connects to, and on every
  redirect), limits on size (`maxBytes`, 2 MiB) and time (`timeoutMs`, 6 s).
- **`fetchOwnerConfiguredLan(url, …)`** only for an address the owner typed into your settings (a LAN SearXNG, Home
  Assistant): it also allows private addresses and other ports. **Never pass it a URL a model chose.**
- **`makeCachedJson`** for JSON with a time to live, `ETag` and stale-if-error.
- **`userAgent(contact)`**: put the owner's contact (Home › API contact, `HOME_API_CONTACT`) in the User-Agent **only
  when the owner set one**.
- Declare `requires: [{ network: "internet", why }]` (or `"lan"`) and a `health`.
- Take the `resolver` and `connector` as dependencies, so tests pass the kit's network that has no network:

<!-- region: packages/module-contracts/test/kit/network.test.ts#net-module -->
```ts
/** What a module that fetches takes from its tests: the resolver and connector (absent: the real ones). */
export interface NetDeps {
  readonly resolver?: Resolver
  readonly connector?: Connector
}

/** The User-Agent: the product token, and the owner's contact only when the owner set one (Home › API contact). */
const agentOf = (view: Pick<HostView, "home">) => {
  const contact = view.home.HOME_API_CONTACT
  return userAgent(typeof contact === "string" && contact.trim() !== "" ? contact : undefined)
}

/** A public API: `safeFetch` with the response type it accepts, a size and a time limit. */
export const fetchForecast = (deps: NetDeps, view: Pick<HostView, "home">, place: string) =>
  safeFetch(`https://api.example.org/forecast?place=${encodeURIComponent(place)}`, {
    accept: contentTypes.json,
    maxBytes: 64 * 1024,
    timeoutMs: 3_000,
    headers: { "user-agent": agentOf(view) },
    ...deps
  }).pipe(Effect.map((response) => JSON.parse(response.text()) as { readonly rain: boolean }))

/** An address the owner typed into the module's settings (a LAN SearXNG): the separate, explicit function. */
export const searchOwnServer = (deps: NetDeps, baseUrl: string, query: string) =>
  fetchOwnerConfiguredLan(`${baseUrl}/search?format=json&q=${encodeURIComponent(query)}`, { accept: contentTypes.json, timeoutMs: 3_000, ...deps })
```

<!-- region: packages/module-contracts/test/kit/network.test.ts#net-test -->
```ts
it.effect("serves fixtures, fails every other host, and keeps the owner's LAN for the LAN function", () =>
  Effect.gen(function*() {
    const net = makeOfflineNet(
      { "https://api.example.org/forecast": { body: { rain: true } }, "http://searx.lan/search": { body: { results: [] } } },
      { lan: { "searx.lan": "192.168.1.5" } }
    )
    const deps = { resolver: net.resolver, connector: net.connector }
    assert.deepStrictEqual(yield* fetchForecast(deps, { home: {} }, "Utrecht"), { rain: true })
    assert.strictEqual(net.requests[0]?.headers["user-agent"], "personal-voice-assistance/1")
    // Any other host is a lookup failure, as when the internet is not there.
    const elsewhere = yield* Effect.flip(safeFetch("https://elsewhere.example.com/", { accept: contentTypes.json, ...deps }))
    assert.strictEqual(elsewhere._tag, "NetFailure")
    // A LAN address: refused to safeFetch (a model's URL), allowed for the owner's own server.
    const refused = yield* Effect.flip(safeFetch("http://searx.lan/search", { accept: contentTypes.json, ...deps }))
    assert.strictEqual(refused._tag, "NetRefused")
    const own = yield* searchOwnServer(deps, "http://searx.lan", "bins")
    assert.strictEqual(own.status, 200)
  }))
```

Everything that comes back (a page, a feed, a tool result of an MCP server, an invitation's text) is untrusted data:
pass it to the model marked as such, cut to a bound, never as instructions.

## 12. Services and contributions between modules

A module offers others a **service** (one provider per key: `services: [Key.of(impl)]` in `shared`) or a
**contribution** (any number: `contributions: [Key.of(value)]`). The shared keys and their interfaces are in
`@pva/module-contracts`, each documented in full in its file:

| Key | Kind | Provided by | Used by | File |
|---|---|---|---|---|
| `Lists` | service | lists | kitchen | `lists.ts` |
| `Timers` | service | timers | routines; kitchen later | `timers.ts` |
| `HomeAssistant` | service (a transport) | home-assistant (smart-home) | music, presence | `homeAssistant.ts` |
| `Playback` | service | music | the host's "stop" and volume (P7), assistant-controls | `playback.ts` |
| `Mcp` | service (a transport) | mcp | t3-code (later) | `mcp.ts` |
| `CalendarProviders` | contribution | calendar (ICS, CalDAV); google later | calendar | `calendar.ts` |
| `BriefingSections` | contribution | weather, bin-day, calendar, news, reminders; google later | briefing | `briefing.ts` |

The core's own are `People`, `Privacy`, `Devices` in `@pva/core` (later `SessionControl`, `DeviceControl`).

- **Look a service up at each use** (`ctx.host.service(Key)`), never keep it: `undefined` means its module is off, and
  the consumer says so in one sentence. A call made while the provider stops may die with `ModuleStopped`.
  `useService(host, Key, "name", use)` turns both into `ProviderOff`:

<!-- region: packages/module-contracts/test/contracts.test.ts#consumer -->
```ts
/** A consumer: asks the lists module through useService and says so when it is off. */
const consumer = defineModule({
  apiVersion: 2,
  id: "consumer",
  name: "Consumer",
  description: "Adds rice.",
  enabledByDefault: false,
  start: (ctx) =>
    Effect.succeed({
      tools: [makeTool({
        name: "consumer_add",
        description: "Add rice to the shopping list.",
        parameters: Schema.Struct({}),
        risk: "change",
        execute: () =>
          useService(ctx.host, Lists, "lists", (lists) => lists.addItem({ list: { kind: "shopping" }, text: "Rice", source: { module: "consumer" }, dedupeKey: "consumer:rice" })).pipe(
            Effect.map((r) => r.outcome),
            Effect.catchTag("ProviderOff", (off) => Effect.succeed(off.message)),
            Effect.catchTag("ListsError", (e) => Effect.succeed(e.message))
          )
      })]
    })
})
```

- **A service call runs on behalf of the call that made it**: the gateway admitted the consumer's tool or job, and the
  provider does not ask again. So a service offers only what any caller may do (reads and `change` on household
  data). The two transports (`HomeAssistant`, `Mcp`) are never offered to the model as tools: the consumer classifies
  its own tools, and each call it makes must fit the call the gateway admitted.
- **Contributions** are read live: `host.contributions(Key)` (an Effect; inside a turn only those of modules the turn's
  assistant has on). Native code names the assistant: `host.contributionsFor(Key, assistantId)`.
- A module that **cannot run at all** without a provider names it in `uses`; one that works without it does not.
- Events (`ctx.events.publish("item.completed", …)`, published as `<moduleId>.item.completed`) may be listened to, but
  nothing may depend on an event for correctness: they are lost at a restart. Consume a subscription in the part's
  scope (`Effect.forkScoped` in `shared`).
- **Testing a consumer**: give it the contract's fake through the kit's `provide`, which publishes it from a stand-in
  module of the provider's id, exactly as the real one would be found:

<!-- region: packages/module-contracts/test/contracts.test.ts#consumer-test -->
```ts
const fake = makeFakeLists()
const on = yield* startTestModule(consumer, { provide: [provide("lists", { services: [Lists.of(fake.service)] })] })
assert.strictEqual((yield* on.tool("consumer_add", {})).value, "added")
const off = yield* startTestModule(consumer)
assert.strictEqual((yield* off.tool("consumer_add", {})).value, "The lists module is off.")
```

## 13. What a module survives, and what it must not do

Modules are compiled into the app and trusted. The host handles correctly an Effect of yours that fails, dies or takes
too long **and stops when it is interrupted**, and a plain function you hand it (a settings check, a decoder, a risk
function) that throws: that becomes your module's error, and the module is down until it is fixed. It does **not**
promise anything for code that breaks the runtime's rules. So:

- **Stop when interrupted.** A turn is cut off by barge-in all the time; a stop gives your calls 10 s, then interrupts
  them. Never make long work uninterruptible; wait with `Effect.sleep`, never a busy loop; pass the `AbortSignal` on.
- **Never block the event loop.** It also frames audio for every browser. No unbounded synchronous work: parse and
  evaluate with bounds (an expression evaluator with limits on size and depth, or a worker stopped at a deadline; a
  length limit alone does not bound a synchronous evaluator), keep transactions small, cut large inputs first.
- **Finite cleanup.** Finalizers finish in 5 s (past that the host abandons them and says so on the Health page).
- **Do not hand the host objects whose properties throw or change**, do not go around the gateway (sealed tools are not
  a security boundary, but going around them is a bug), and keep nothing of the host after your part closed.
- A request you make (`requestRestart`, a save, a schedule) is recorded whole or not at all; `requestRestart` is taken
  up at most once every 5 s and only from a live part.
- Event handlers are not calls in flight: they get no grace period and are interrupted when the part closes. Do what
  must not be cut short in one store transaction.

## 14. Latency

Nothing slow on the turn path; a claim about latency needs `TurnTrace` numbers, not reasoning.

- **A context provider has 50 ms** per turn, or contributes nothing that turn: answer from a cache or the store
  (bounded, indexed reads), never the network. Keep its line short; it is sent with every turn.
- Instructions are part of the cached prompt prefix: stable text only; changing them costs one cache miss.
- A read tool that is safe to run early is `speculative: true`: it may run before the turn is committed. A tool's
  `latency` says what to expect (`instant` < 50 ms, `quick` < 1 s, `slow` seconds).
- Store calls are synchronous: one `list` holds the main thread at most a few milliseconds (§5); a `schedule` from a
  tool is a fraction of a millisecond. A risk function has 2 ms.
- Slow work (a feed refresh, a calendar sync) is a job or a fiber in `shared` that keeps a cache; the turn reads the
  cache.

## 15. Speaking

What a tool returns goes to the model, which words the reply. Return **a `spoken` line** (one or two sentences, ready to
say) or **a small result the model can word in a sentence or two**: the answer first, then at most a few items with "and
N more". Never markup, never a URL to read out, never a list of fifty things. Typed actions return `{ say }`, spoken as
it is with no model.

Every sentence the module says itself is in **English and Dutch**, chosen by the household's language
(`homeLanguage(ctx.host.view())`, `HOME_LANGUAGE`; anything that is not Dutch is English), British conventions
("half seven" is 7:30; Dutch "half zeven" is 6:30). Numbers, times, dates, durations, amounts and lists are worded by
`@pva/language` (`speakTime`, `speakDate`, `speakDuration`, `speakAmount`, `speakList`) so every module sounds the same.
Keep the texts in one table with the same placeholders in both languages (`checkModule(definition, { texts })` compares
them):

<!-- region: packages/module-contracts/test/kit/pinboard.ts#texts -->
```ts
/** Every sentence the module speaks, in both languages, with the same placeholders (checkModule compares them). */
export const texts = defineTexts({
  en: {
    pinned: "Pinned: {text}.",
    pinnedFor: "Pinned for {name}: {text}.",
    empty: "The pinboard is empty.",
    cleared: "Cleared {count} old notes.",
    withheld: "{count} personal notes are not read out here.",
    noPerson: "I don't know who is asking, so I pinned it for everyone."
  },
  nl: {
    pinned: "Vastgeprikt: {text}.",
    pinnedFor: "Vastgeprikt voor {name}: {text}.",
    empty: "Het prikbord is leeg.",
    cleared: "{count} oude briefjes weggehaald.",
    withheld: "{count} persoonlijke briefjes lees ik hier niet voor.",
    noPerson: "Ik weet niet wie het vraagt, dus het hangt er voor iedereen."
  }
})
```

## 16. Testing: the kit and checkModule

Tests never reach the network and leave nothing on disk. The kit is `@pva/core/testing`; run tests inside `it.effect`
(the test clock).

**`startTestModule(definition, options)`** starts your module in the **real** module host, as serve mode runs it: the
real execution gateway with serve mode's checks, the real scheduler engine on the in-memory household store, the
core's `People`, `Privacy` and `Devices` rules over a test household (default: Sam and Robin; a shared kitchen display
whose default person is Sam, Robin's private phone, a public hall screen; the assistant `jeff` on all three; English,
Amsterdam; the clock at Wednesday 18 November 2026, 10:00 in Amsterdam). Options: `settings`, `secrets`, `provide`
(fakes of other modules), `others` (real modules beside it), `household` (people, devices with their privacy and
default person, assistants with their module choices, `offTools` and own values, Home values), `startAt`. It returns
handles:

| Handle | What it does |
|---|---|
| `tool(name, input, as?)` | a tool call as the model's tool loop makes it, through the assistant's registry and the gateway, as a turn (`{ device, assistant, person, room, source }` resolved against the household, or a `TurnContext`); answers `{ ok, content, value }` as the model gets it |
| `action(id, params, as?)` | an action through `host.actions.run` (as a routine step runs it) |
| `asTurn(effect, as?)` | run code as a turn (to call a service directly) |
| `jobs`, `runJob(id)`, `advance(ms)`, `now` | the module's jobs; move the test clock and let the scheduler run what came due, through the gateway with the job's origin |
| `route({ method, path, body, headers, query, as })` | an HTTP route with its guards checked against the caller (`admin`, a token `secret`, an `address`), its body mode and time limit; `mintRouteToken(name)` mints one as the owner would |
| `service(Key)`, `contributions(Key, as?)` | what is published now, as a turn's assistant sees it |
| `stop`, `start`, `restart`, `configure(patch)` | the lifecycle: switched off for every assistant, on again, a new start, a settings change |
| `info()`, `issues()`, `checkHealth`, `toolNames(as?)` | the admin page's view of it, its Health issues, the tools a turn is offered |
| `moduleStore()`, `store`, `events`, `people` | the module's store, the household store, every event on the bus, the household (change a device's privacy or default person, remove a person) |

Also: `makeTestTurn` (a `CurrentTurn`), `makeTestPeople` (the core services over a household), `provide(moduleId, {
services, contributions })`, `makeOfflineNet(fixtures, { lan })` (§11), `expectOffByDefault(catalog)`. The fakes of
every contract are in `@pva/module-contracts/fakes` (`makeFakeLists`, `makeFakeTimers`, `makeFakeHomeAssistant` with
`set`, `setConnection`, `overflow`, `makeFakePlayback`, `makeFakeMcp`, `makeFakeCalendarProvider`,
`makeFakeBriefingSection`).

<!-- region: packages/module-contracts/test/kit/pinboard.test.ts#turns -->
```ts
it.effect("a personal note is read where the privacy rule allows it, and withheld elsewhere", () =>
  Effect.gen(function*() {
    const board = yield* startTestModule(pinboardModule)
    // Sam, at the shared kitchen display whose default person is Sam (the default test household).
    const pinned = yield* board.tool("pinboard_pin", { text: "Dentist at 3", forMe: true }, { device: "kitchen-display" })
    assert.deepStrictEqual(pinned.value, { spoken: "Pinned: Dentist at 3." })
    yield* board.advance(60_000)
    yield* board.tool("pinboard_pin", { text: "Bins out tonight" }, { device: "kitchen-display" })

    const kitchen = yield* board.tool("pinboard_read", {}, { device: "kitchen-display" })
    assert.deepStrictEqual(kitchen.value, { notes: ["Bins out tonight", "Dentist at 3"], more: 0, owner: "p-sam" })
    // A public hall screen: the household note only, and a sentence about what was left out.
    const hall = yield* board.tool("pinboard_read", {}, { device: "hall-screen" })
    assert.deepStrictEqual(hall.value, { notes: ["Bins out tonight"], more: 0, withheld: "1 personal notes are not read out here." })
    // Robin's private phone: a private device may be told anyone's personal content.
    const phone = yield* board.tool("pinboard_read", {}, { device: "robins-phone" })
    assert.deepStrictEqual((phone.value as { notes: Array<string> }).notes, ["Bins out tonight", "Dentist at 3"])
  }))
```

<!-- region: packages/module-contracts/test/kit/pinboard.test.ts#job -->
```ts
it.effect("the daily job takes down notes older than the setting, at 04:00, with the job's origin", () =>
  Effect.gen(function*() {
    const board = yield* startTestModule(pinboardModule, { settings: { keepDays: 1 } })
    const [job] = yield* board.jobs
    assert.strictEqual(job?.cron, "0 4 * * *")
    const store = board.moduleStore().collection(notes)
    const now = yield* board.now
    yield* store.insert({ text: "stale", pinnedAt: now - 2 * 86_400_000 })
    yield* store.insert({ text: "fresh", pinnedAt: now })
    yield* board.runJob(job!.id)
    const left = yield* store.list({})
    assert.deepStrictEqual(left.map((r) => r.value.text), ["fresh"])
  }))
```

**`checkModule(definition, { settings?, secrets?, texts?, provide?, household? })`**, which every module's test calls,
starts the module through the kit and fails with every rule it breaks, each named with its place:

| Rule | Fails when |
|---|---|
| `api-version` | the module does not declare `apiVersion: 2` |
| `off-by-default` | a new module is on before the owner chose (`enabledByDefault` not `false`) |
| `form` | its described settings form does not encode with the wire's schema, or exceeds 8 KiB |
| `start` | it does not start in the real host with the given settings and secrets |
| `secret` | a secret's value is in a status line, an error, the form, a Health issue, a tool's name or description, an action's text, instructions, a route or a context provider's name |
| `risk` | a tool or action that is not a plain read (`speculative: true`) declares no risk class |
| `risk-said` | one that can be `money` or `security` does not say so in its description |
| `tool-name` | a tool's name, or an action's generated `<moduleId>_<actionId>`, is not 1–64 of `[A-Za-z0-9_-]`, or is used twice |
| `tool-description` | a tool's description is empty or over 1,024 characters |
| `tool-parameters` | a tool's parameters are not an object schema (`Schema.Struct`), or a property name is outside 1–64 of `[A-Za-z0-9_.-]` |
| `action-examples` | an action declares no `examples` |
| `stored-value` | a collection's worst legal value is longer than its `maxChars`, or unbounded |
| `scheduler-shared` | a job handler is registered in `start` instead of `shared` |
| `cron` | a cron expression it schedules is outside the accepted grammar |
| `job-payload` | a job it schedules has a payload its handler's schema does not decode |
| `health` | it requires the network and declares no `health`, or its `health()` fails or does not answer |
| `texts` | its texts differ between English and Dutch in keys or placeholders, or one is empty or not one line |

<!-- region: packages/module-contracts/test/kit/pinboard.test.ts#check -->
```ts
it.effect("passes the conformance check, with its texts in both languages", () => checkModule(pinboardModule, { texts }))
```

What `checkModule` cannot see stays your test's job: what a tool answers, privacy on each kind of device, that a
person-scoped call without a person asks "whose", the late rule of your jobs, a restart in the middle, a provider that
is off. Run your package's tests and `pnpm check` behind the shared lock
(`flock /workspace/build-cache/ian/pva-heavy.lock …`, `VITEST_MAX_WORKERS=4`).

## 17. What a module pull request may touch

- Its own package under `packages/module-<id>/` (source, tests, `package.json`).
- **Its own page, `docs/modules/<id>.md`** (one per module id; a package with several ids has one page each), filled in
  under the stub's headings: what it does, its tools, settings, what it stores, what it needs, and what was left out.
  This replaces the plan's "own section in `docs/MODULES.md`", so twenty pull requests never edit the same file.
- `pnpm-lock.yaml`, only when it adds a dependency the scaffold did not foresee; the description names it.
- **Nothing else.** The scaffold has created the package, registered it in the catalogue, added the dependencies of
  Appendix A and defined the contracts it shares. If the core lacks something the module needs, stop and report it
  instead of editing shared files.
- Four have a wider reach, limited to these files: core-tools: `packages/modules-builtin/src/clock.ts` and new files
  beside it, and `docs/modules/clock.md`; local-info: `packages/modules-builtin/src/weather.ts` and new files beside it,
  and `docs/modules/weather.md` (the package's `package.json` and `index.ts` are ready: `index.ts` re-exports everything
  `clock.ts` and `weather.ts` export, so a new file is exported from one of those two); smart-home: all of
  `packages/module-home-assistant/`; calls-and-intercom (later): the files its own plan names.

## 18. The modules

| Module | Package | Wave | Page |
|---|---|---|---|
| Assistant controls | `module-assistant-controls` | B | [assistant-controls](modules/assistant-controls.md) |
| Timers, alarms | `module-timers` | B | [timers](modules/timers.md), [alarms](modules/alarms.md) |
| Core tools | `module-core-tools`, `modules-builtin` (clock) | A | [calculator](modules/calculator.md), [knowledge](modules/knowledge.md), [system-status](modules/system-status.md), [clock](modules/clock.md) |
| Web search | `module-web-search` | A | [web-search](modules/web-search.md) |
| Lists | `module-lists` | A | [lists](modules/lists.md) |
| Notifications | `module-notifications` | B | [notifications](modules/notifications.md) |
| Kitchen | `module-kitchen` | A | [kitchen](modules/kitchen.md) |
| Music | `module-music` | B | [music](modules/music.md) |
| Smart home | `module-home-assistant` | A | [home-assistant](modules/home-assistant.md) |
| Reminders | `module-reminders` | B | [reminders](modules/reminders.md) |
| Images | `module-images` | B | [images](modules/images.md) |
| Calendar | `module-calendar` | A | [calendar](modules/calendar.md) |
| Memory and notes | `module-memory` | A | [memory](modules/memory.md) |
| Broadcast | `module-broadcast` | B | [broadcast](modules/broadcast.md) |
| Briefing | `module-briefing` | A | [briefing](modules/briefing.md) |
| Local info | `module-local-info`, `modules-builtin` (weather) | A | [bin-day](modules/bin-day.md), [weather](modules/weather.md) |
| Presence | `module-presence` | A | [presence](modules/presence.md) |
| News and feeds | `module-news` | A | [news](modules/news.md) |
| Routines | `module-routines` | B | [routines](modules/routines.md) |
| MCP client | `module-mcp` | A | [mcp](modules/mcp.md) |

Wave A is written on this scaffold now; wave B after the first versions of P7 to P10 (notifications, phrase commands,
presentation, the risk policy). Google, T3 Code and calls-and-intercom have their own plan later.
