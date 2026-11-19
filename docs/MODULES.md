# Writing a module (module API v2)

This is for the author of one module of [docs/MODULES-PLAN.md](MODULES-PLAN.md) §5.1, who has this page, the plan's row
for their module and their module's research document (`docs/research/modules/<name>.md`), and nothing else. It says
what a module is, the rules the preparation stack (P1 to P6) settled, and how to test a module so that it keeps them.
Where this page and a research document disagree, the plan and this page win.

> **Wave A: what does not exist yet.** You are writing on the scaffold (P11). Notifications, ringing and a module's own
> speech (`ctx.notify`, `ctx.speech`) exist in a first version since P9 (§16, [NOTIFICATIONS.md](NOTIFICATIONS.md));
> phrase commands after the wake phrase, the host's essential controls and the ringing window since P7 (§16 "Phrase
> commands", [PHRASES.md](PHRASES.md)); and presentations (a card, a list with ticks, a timer, an image, the weather:
> `ctx.present`, or `{ forModel, present }` from a tool) since P10 (§16, [PRESENTING.md](PRESENTING.md)). A
> presentation your first version names is one small PR after yours, unless your PR is written on top of P10. Not yet,
> for everyone: connections
> and OAuth, CalDAV, an MCP client, and any outgoing HTTP but `GET` and `HEAD` (§12). The plan's "Order from here" (§4)
> has the waves.

The deeper references, only when this page is not enough: [ARCHITECTURE.md](ARCHITECTURE.md) (the host, the gateway,
the store, the scheduler, people), [UI-AND-MODULES.md](UI-AND-MODULES.md) §1.10–§1.11 (API v2, settings fields,
routes), [STORING-DATA.md](STORING-DATA.md), [SCHEDULING.md](SCHEDULING.md).

Every code block on this page is quoted from a file that compiles and runs (`docs.test.ts` in
`packages/module-contracts/test` keeps them the same, and fails on a block that is not quoted from one). The
**reference module** is `packages/module-contracts/test/kit/pinboard.ts`: short notes pinned for the household or one
person. It has one of everything a wave A module needs (a setting, a secret, a collection with an index and a bounded
scan, a tool that reads, a tool that changes and asks whose, a job scheduled from a turn, a daily job, an action, a
health check, personal content, two languages) and `pinboard.test.ts` runs each part through the test kit.

## Contents

1. [What you start from](#1-what-you-start-from)
2. [The shape of a module](#2-the-shape-of-a-module)
3. [The turn: who is asking](#3-the-turn-who-is-asking)
4. [Risk classes and the risk policy](#4-risk-classes-and-the-risk-policy)
5. [Storing data](#5-storing-data)
6. [Scheduling](#6-scheduling)
7. [People and privacy](#7-people-and-privacy)
8. [Secrets](#8-secrets)
9. [Settings forms](#9-settings-forms)
10. [Typed actions](#10-typed-actions)
11. [HTTP routes](#11-http-routes)
12. [The network](#12-the-network)
13. [Services and contributions between modules](#13-services-and-contributions-between-modules)
14. [What a module survives, and what it must not do](#14-what-a-module-survives-and-what-it-must-not-do)
15. [Latency](#15-latency)
16. [Speaking](#16-speaking)
17. [Testing: the kit and checkModule](#17-testing-the-kit-and-checkmodule)
18. [What a module pull request may touch](#18-what-a-module-pull-request-may-touch)
19. [The modules](#19-the-modules)

## 1. What you start from

The scaffold has made your package, `packages/module-<pkg>/` (the table in §19 names it; one package can hold several
module ids): a `package.json` with the libraries the plan's Appendix A gives your module and the workspace packages it
needs, a `tsconfig.json`, and `src/index.ts`, which exports your module (`defineModule`, `apiVersion: 2`, off by
default, no tools) and a `catalog` array with it. The app lists that array once (`apps/assistant/src/modules.ts`), so
**you never edit the catalogue**: what your package's `catalog` holds is what the app runs. Keep the module's id; you
may turn the definition into a factory that takes test dependencies (`listsModule(deps)`) as long as `catalog` holds
the production one.

`test/module.test.ts` already runs the conformance check (§17) on it. Your page is `docs/modules/<id>.md`, a stub with
its headings (§18).

The contracts you provide or consume are in `@pva/module-contracts` (§13); your tests give a consumer a **stub** of a
contract (`stubService` in `@pva/core/testing`), never an imitation of the provider. Spoken numbers, times, dates,
durations, quantities and recurrences are `@pva/language`; outgoing HTTP is `@pva/net`: `GET` and `HEAD`, and a JSON `POST`
to an address the owner typed (§12).

## 2. The shape of a module

A module is one `defineModule({...})` with two lifetimes:

- **`shared(ctx)`** runs **once per module** while it is demanded (a switched-on assistant has it on, or a demanded
  module names it in `uses`). Its `ctx.settings` holds the module's **shared** fields only: an `overridable` field is
  not in it (an assistant may own its value), so shared code that acts for a caller reads that caller's values with
  `ctx.settingsFor(assistantId)` at that moment (§9). Sockets, caches, job handlers, event subscriptions, services and
  contributions belong here. What it returns as `value`, every instance gets as `ctx.shared`. 10 s to start.
- **`start(ctx)`** runs once per **distinct set of effective settings** (assistants with equal settings share one
  instance; its `ctx.settings` has every field, the assistant's own values over the shared ones): tools, actions,
  context providers, instructions. 10 s to start.

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
  printerKey: Setting.secret({ label: "Label printer key", description: "Not used by this example's tools: it shows a secret declared, checked by health and kept out of every result." })
}
```

<!-- region: packages/module-contracts/test/kit/pinboard.ts#shared -->
```ts
shared: (ctx) =>
  Effect.gen(function*() {
    const board = ctx.store.collection(notes)
    // Handlers are registered in `shared` (once per module), each with a payload schema. Both are idempotent: running
    // one twice for the same occurrence does no harm, so a run cut short by a restart is simply run again.
    yield* ctx.scheduler.handle("expire", {
      payload: Schema.Struct({}),
      idempotent: true,
      run: () =>
        Effect.gen(function*() {
          const job = yield* CurrentJob
          if (job === undefined) return yield* Effect.die(new Error("expire runs only as a job"))
          const keepDays = ctx.settingsFor(undefined)?.keepDays ?? 7
          const cutoff = (yield* Clock.currentTimeMillis) - keepDays * 86_400_000
          // Oldest first, a bounded batch per transaction, until a batch reaches a note that stays: maintenance work
          // goes on in steps that each take a moment, never in one unbounded read.
          for (let batch = 0; batch < 100; batch++) {
            const scan = yield* scanNotes((q) => board.list({ orderBy: { field: "pinnedAt", direction: "asc" }, ...q }))
            const old = scan.rows.filter((r) => r.value.pinnedAt < cutoff)
            // One synchronous transaction; nothing in it awaits, and no store failure is caught inside it.
            yield* ctx.store.transaction((tx) => {
              for (const row of old) tx.collection(notes).remove(row.id, { actor: { kind: "job", jobId: job.jobId } })
            })
            if (!scan.cut || old.length < scan.rows.length) return
            yield* Effect.yieldNow
          }
        })
    }).pipe(Effect.orDie)
    yield* ctx.scheduler.handle("unpin", {
      payload: Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(200)) }),
      idempotent: true,
      run: ({ id }) =>
        Effect.gen(function*() {
          // A job scheduled from a turn runs with that turn's origin (`CurrentJob`: its assistant, device and person).
          const job = yield* CurrentJob
          if (job === undefined) return yield* Effect.die(new Error("unpin runs only as a job"))
          yield* board.remove(id, { actor: { kind: "job", jobId: job.jobId } })
        })
    }).pipe(Effect.orDie)
    // A system job: cron with minute, hour and day of week only. Scheduling the same key again replaces it.
    yield* ctx.scheduler.schedule({ handler: "expire", key: "expire", cron: "0 4 * * *" }).pipe(Effect.orDie)
    return { value: undefined }
  }),
```

What `start` returns (`ModuleInstance`): `tools` (for the model), `actions` (typed actions, §10), `context` (context
providers, §15), `instructions` (one stable sentence or two appended to the system prompt while the module is on;
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
      const scan = yield* scanNotes((q) => board.list({ orderBy: { field: "pinnedAt", direction: "desc" }, ...q })).pipe(
        Effect.mapError(() => new ToolError({ message: say(texts, lang, "unreadable") }))
      )
      if (scan.rows.length === 0) return { spoken: say(texts, lang, "empty") }
      let owner: string | undefined
      let withheld = 0
      const shown: Array<string> = []
      for (const r of scan.rows) {
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
        ...(scan.cut ? { cut: say(texts, lang, "cut", { count: SCAN_ROWS }) } : {}),
        ...(owner !== undefined ? { owner } : {})
      }
    })
})
```

A tool that changes, with its risk class: it asks whose before it writes anything personal, and writes a note and the
job that takes it down in one transaction (§6):

<!-- region: packages/module-contracts/test/kit/pinboard.ts#change-tool -->
```ts
const pin = makeTool({
  name: "pinboard_pin",
  description: "Pin a short note on the pinboard, for everyone or only for the person asking, optionally for some hours.",
  parameters: Schema.Struct({
    // Stored text, and one line: `StoredText` alone allows a line break, so `isLine` checks the rest.
    text: StoredText(200).check(Schema.makeFilter((t: string) => isLine(t, 200) || "one line, without line breaks")).annotate({ description: "The note, one short line" }),
    forMe: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only for the person asking" })),
    hours: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 72 })).annotate({ description: "Take it down after this many hours" }))
  }),
  risk: "change", // it changes household data: declared, never left to be inferred
  execute: ({ text, forMe, hours }) =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const lang = languageOf(ctx.host.view())
      const person = turn?.person?.id
      // Personal content needs an owner. Nobody known is asking (a public screen, no default person): ask whose,
      // and write nothing. Never store it as the household's instead, and never repeat the text here.
      if (forMe === true && person === undefined) return { spoken: say(texts, lang, "whose") }
      const owner = forMe === true ? person : undefined
      const note: Note = { text, whose: owner === undefined ? "household" : "personal", pinnedAt: yield* Clock.currentTimeMillis, ...(owner !== undefined ? { owner } : {}) }
      const failed = () => new ToolError({ message: say(texts, lang, "unsaved") })
      // The confirmation repeats a personal note only where it may be revealed: a public screen with a default
      // person knows whose it is, and still must not show it. Asked now, for this device.
      const quiet = owner !== undefined && ctx.host.service(Privacy)?.mayReveal(owner, turn) !== true
      if (hours === undefined) {
        yield* board.insert(note).pipe(Effect.mapError(failed))
        return { spoken: quiet ? say(texts, lang, "pinnedPrivately") : say(texts, lang, "pinned", { text }) }
      }
      // The note and the job that takes it down are written in one transaction: both or neither. The row's id is
      // chosen first, so the job's payload can name it; the job inherits this turn's origin.
      const id = randomUUID()
      const job = yield* ctx.scheduler.prepare({ handler: "unpin", key: `unpin:${id}`, payload: { id }, inMs: hours * 3_600_000 }).pipe(Effect.mapError(failed))
      yield* ctx.store.transaction((tx) => {
        tx.collection(notes).insert(note, { id })
        job.writeIn(tx)
      }).pipe(Effect.mapError(failed))
      return { spoken: quiet ? say(texts, lang, "pinnedPrivatelyUntil", { hours }) : say(texts, lang, "pinnedUntil", { hours, text }) }
    })
})
```

And an action (§10):

<!-- region: packages/module-contracts/test/kit/pinboard.ts#action -->
```ts
const clear = defineAction({
  id: "clear",
  label: "Clear the pinboard",
  description: "Take down household notes older than a day. Personal notes stay.",
  examples: ["clear the pinboard", "take the old notes down", "maak het prikbord leeg"],
  params: {},
  risk: "change",
  run: () =>
    Effect.gen(function*() {
      const lang = languageOf(ctx.host.view())
      const cutoff = (yield* Clock.currentTimeMillis) - 86_400_000
      // The household's notes only, oldest first, through the index on [whose, pinnedAt]: every row read is one
      // the action may take down, so the personal notes it keeps never stand in its way.
      const scan = yield* scanNotes((q) => board.list({ where: { whose: "household" }, orderBy: { field: "pinnedAt", direction: "asc" }, ...q })).pipe(
        Effect.mapError(() => new ActionError({ message: say(texts, lang, "unreadable") }))
      )
      const old = scan.rows.filter((r) => r.value.pinnedAt < cutoff)
      yield* ctx.store.transaction((tx) => {
        for (const row of old) tx.collection(notes).remove(row.id)
      }).pipe(Effect.mapError(() => new ActionError({ message: say(texts, lang, "uncleared") })))
      // Cut short while every note it read was old: there may be more old ones, and saying it again reaches them,
      // because the ones it took down are gone. Otherwise it reached a note that stays, and is done.
      const more = scan.cut && old.length === scan.rows.length
      return { say: say(texts, lang, more ? "clearedSome" : "cleared", { count: old.length }) }
    })
})
```

**`health`** is a cheap check (at start, on "Check again", by `pnpm start doctor`; never on a turn; 5 s) that returns
issues with a fix. A module that depends on anything outside the process declares `requires` and `health` (§3.3 of the
plan); `checkModule` fails one that requires the network without a `health`. The host puts the module's id before each
issue's id. `health` receives the settings and whether the module runs, nothing else (no store, no services).

<!-- region: packages/module-contracts/test/kit/pinboard.ts#health -->
```ts
health: ({ settings }) =>
  Effect.succeed(
    settings?.printerKey === undefined
      ? [{ id: "pinboard.no-printer-key", severity: "info" as const, title: "No label printer key", detail: "Set one on the module's page to print notes." }]
      : []
  ),
```

**What a failure does.** It depends on where it happens:

| What fails | What happens |
|---|---|
| `shared` or `start` fails, dies or takes over 10 s; the settings do not decode or a field's check refuses them; a tool name the host refuses (§17) | the module is **down**: `error` on the admin page and a Health issue, until the settings change, the owner presses Check again, or a restart |
| a tool's `execute`, an action's `run` | that call fails: the model gets the error as the tool result, a typed action says its error; the module runs on |
| a job's handler | that run fails: retried if the handler is idempotent; after that a **one-off** job is `failed`, while a **repeating** (cron) job moves on to its next occurrence and stays `scheduled`, with `lastError` and a Health issue until an occurrence succeeds; the module runs on (§6) |
| `health()` fails, dies or takes over 5 s | a Health issue; the module runs on |
| a risk function throws, answers a class it did not declare, or takes over 2 ms | that call is refused with a generic sentence (details in the log); the module runs on |
| a context provider takes over 50 ms or fails | it contributes nothing to that turn |

**A module never keeps what the host gave it past its part.** Every member of `ctx` (`host`, `store`, `events`,
`scheduler`, the core services) answers `ModuleStopped` once the part that got it has closed. Look services up at each
use (§13), and ask `ctx.settingsFor(assistantId)` each time shared code acts for a caller: a change that keeps the run
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
a screen. Code that awaits inside native callbacks loses the fiber's context: read `CurrentTurn` first and pass it on.

**Outside a turn.** `shared` code has no `CurrentTurn`. A job runs with **`CurrentJob`**, its **origin**: the job, the
module, and the assistant, device and person it was scheduled for. A job scheduled while a turn or another job runs
**inherits that turn's or job's origin** (a request's own `origin` replaces it; a job scheduled in `shared` at start has
none). The gateway admits the job's calls for that assistant. Its person is who it was for **when it was scheduled**:
when it runs, the device's default person may be someone else (a job is not a turn, so the gateway does not tie the two
together). So a job never asks the device who its person is now; it works on its origin's person's data, and checks
`Privacy.mayReveal(owner, device)` at the moment it reveals anything (§7). The reference module's "pin for two hours"
job and its test (§17) show the origin arriving.

## 4. Risk classes and the risk policy

Every tool and action has a class: `read` (lookups), `change` (household state: lights, timers, lists, speaking on the
house's own devices), `message` (sent to people outside the house, or in the owner's name on an outside channel),
`money`, `security` (locks, alarms, garage doors). **Declare it** on everything that is not a plain read: `risk:
"change"`. A plain read is `speculative: true` (it may run before the turn is committed) and is `read`. A class that
depends on the input is `risk: { classes: ["change", "security"], of: (input) => … }`: a pure function of the validated
input, at most 2 ms, that answers one of its declared classes (otherwise the call is refused with a generic sentence).
A press handler (`ctx.present.handle`, `ctx.notify.handle`) may declare `risk` the same way, of the press; without it
a press is `change`.

**The policy is the household's** (P8, first version): the owner sets it on the admin page, Shared settings › Risk
policy, per class: **Run it** (`allow`), **Refuse: needs confirmation** (`confirm`) or **Refuse** (`deny`). One level
only: it applies to every assistant on every device (no assistant or device narrows it yet). `money` and `security`
are fixed at Refuse (devices are not authenticated): the page shows them and does not let them change, a settings file
that says otherwise is read as Refuse, and the decision refuses them whatever it is given. Nothing saved means the
default, which is the behaviour before the policy was a setting: **`read` and `change` run, `message` is refused as
needing a confirmation the assistant cannot ask for yet, `money` and `security` are refused.** Confirmation itself is
still off, so `confirm` refuses too, with its own sentence.

What the gateway does, in order, on every path that runs a tool, an action or a press handler (a model's tool call, the
Claude Code bridge, a generated action tool, the intent agent, a phrase command, a routine step or tool through
`host.actions.run`, a job, a press on a presentation or a notification, core's confirmed path, the CLI modes): checks the principal (§3), that the
assistant has the module on and the tool is not switched off, runs the risk function on the validated input, then
decides with **one function**, `decideRisk(policy, declared classes, class of this input)` (`@pva/protocol`), on the
policy **as saved at that moment**: a save applies to the next call, without a restart. An action declared `confirm:
true` is refused on every path before that (confirmation is off). A module route and a field action (a Test button)
run with no principal: a call they make is refused before any decision.

- A tool or action **every** declared class of which is refused is **not offered**: it is left out of the model's tool
  list and of the turn's action catalogue, decided with the same function each time a list is read. One that can also
  be `change` (a cover: a blind or a garage door) is offered, and each call is refused when its input makes it
  `security`. A list made before a change and a call after it may disagree; the call's check wins and the model gets
  the refusal.
- A refusal comes back to the model as a tool result ("Not run: …", in Dutch "Niet uitgevoerd: …", by the Home
  language), a typed action and a phrase command say it in a sentence for speech ("I can't do that: …"; the host's
  controls, "stop", "never mind", "repeat", "louder", "quieter", are never refused), a press is answered with that
  sentence on the page, `host.actions.run` answers `{ ok: false, code: "refused", message }`; `confirm` and `deny` have
  different sentences, and the module's code never runs.
- Every decision is recorded: a turn's on its trace (`Trace.calls`, the latency line's `risk:` part), every one through
  the gateway's `onDecision` (serve mode logs refusals outside a turn; the test kit keeps them in `riskDecisions()`). A
  call refused before the decision (no principal, the module off, invalid input) has no outcome recorded.
- So: build nothing whose first version needs `message`, `money` or `security`; and say in the description of a tool
  that can be `money` or `security` that it is (`checkModule`'s `risk-said`), so the model is not surprised.

`sensitivity` (`household`, `personal` with an owner, or a function of the result) says whose a result is. **The
gateway enforces it for a tool's result on its way back to the model**: a `personal` result is passed through
`Privacy.mayReveal` for the asking device at the moment the tool finishes; where it may not be revealed, the model gets
a fixed sentence ("Withheld: …") and nothing of the result, and nothing of it is presented. For an action called as a
tool, the classifier receives **the action's own outcome** (`ActionOutcome`: its `say`, `present`, …), before it is
formatted or shown. **A failure is covered too**: a `ToolError`, an `ActionError` or a defect of a tool or action whose
results are fixed `personal` is withheld where such a result would be ("Withheld: …", still an error result); a
classifier of the result cannot be asked about a failure, so a failure of a tool with a classifier is always withheld
from the model. Write failure messages that help the person, and expect them to be withheld from shared and public
devices. `personal` without a known owner (`sensitivity: "personal"`, or a classifier that throws or answers nonsense)
is someone else's: it is withheld everywhere, also on a private device. A result is decided once, when its tool
finishes; it is not checked again while it waits for sibling tools (serve ends a device's session when its privacy
changes). A job, a route and `host.actions.run` hand results to module code, not to a model, and a job has no asking
device: there the module checks privacy itself, on the device that will speak or show it (§7), as it always did. Keep
checking in your own code where you build a result from several people's data (the gateway sees one sensitivity per
result). `latency` (`instant`, `quick`, `slow`, `background`) is metadata.

In tests, the kit behaves like serve mode: `startTestModule(m, { household: { risk: { change: "deny" } } })` starts
with a saved policy, `kit.setRiskPolicy(…)` saves another (it applies to the next call and list), and
`kit.riskDecisions()` lists every decision.

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
  /** Whose kind of note it is, indexed with `pinnedAt`, so the household's notes can be listed without the personal ones. */
  whose: Schema.Literals(["household", "personal"]),
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
  // Indexed values are bounded scalars (a literal, a bounded integer): the store refuses anything else when it is
  // written, and pinboard.test.ts writes a row with each at its largest.
  indexes: ["pinnedAt", ["whose", "pinnedAt"]]
})
```

The rules:

- **A value is an object.** A collection's schema is a `Schema.Struct` (or a union of them): the store keeps JSON
  objects only, and refuses anything else when it is written. `checkModule`'s `collection` runs the store's own
  declaration check on every collection you declare.
- **`maxChars` and the rows a list may read.** A value is at most `maxChars` characters of JSON (default 2,000, at most
  16,000). A `list` asks for at most `maxListRows(c) = min(100, floor(25,000 / maxChars))` rows (12 at 2,000; 62 at 400;
  100 at 250). **Declare `maxChars` as small as your values really are**, and bound every field so the worst legal value
  fits it: `checkModule`'s `stored-value` computes the worst from the schema (a string costs 6 characters of JSON per
  character, the worst JSON escape; `StoredText(n)` from `@pva/module-contracts` costs 2, because it refuses control
  characters other than tab, line feed, carriage return, backspace and form feed, and lone surrogates; a number 25; a
  string or list without a maximum cannot fit at all).
- **Indexes.** At most 8, of at most 8 distinct top-level fields (`[A-Za-z_][A-Za-z0-9_]{0,63}`); a row's own names
  `id`, `rev`, `scope`, `createdAt` and `updatedAt` cannot be indexed. **An indexed field must be a bounded scalar**: a
  string of at most 500 characters without NUL or a lone surrogate (`StoredText(n)` with `n` ≤ 500, a literal), a
  finite number, a boolean, or missing; `null` is refused. **The store refuses anything else when the row is
  written**, not before: `checkModule` does not judge indexed values. So **your tests write a row with every indexed
  field at its largest** (the longest string, the largest number) and see it stored, as the reference module's do.
- **Lists** are one index range: no filter (ordered by `updatedAt`, `createdAt` or an indexed field), an equality
  filter on one indexed field, or a filter on `f` ordered by `g` with the pair `[f, g]` declared. Anything else is
  `invalid`: store a combined field and index it. Ties go by `createdAt`, then id.
- **Paging with `after`**: to read more than one list returns, pass the last row of a page as `after` in the same query.
  `after` must be a row a list returned, not a copy. **A scan on a turn is bounded, and says when it was cut short**:
  never call a partial read "every note", and never remove the bound with an unbounded turn-time scan. Maintenance work
  (a nightly clean-up) goes in batches, each its own transaction, with a yield between them.

<!-- region: packages/module-contracts/test/kit/pinboard.ts#reading -->
```ts
/** The most notes one answer reads: 20 pages of 25, each one bounded indexed read. A turn never scans further. */
export const SCAN_ROWS = 500
const PAGE = 25

/**
 * The notes in one order, page by page (`after` continues a list), at most `SCAN_ROWS`, and whether there were more:
 * a bounded scan says so when it is cut short, so nothing calls a partial read "every note".
 */
const scanNotes = (list: (q: { readonly limit: number; readonly after?: Row<Note> }) => Effect.Effect<ReadonlyArray<Row<Note>>, unknown>) =>
  Effect.gen(function*() {
    const rows: Array<Row<Note>> = []
    let after: Row<Note> | undefined
    for (let page = 0; page < SCAN_ROWS / PAGE; page++) {
      const got = yield* list({ limit: PAGE, ...(after !== undefined ? { after } : {}) })
      rows.push(...got)
      if (got.length < PAGE) return { rows, cut: false }
      after = got.at(-1)
    }
    const beyond = yield* list({ limit: 1, ...(after !== undefined ? { after } : {}) })
    return { rows, cut: beyond.length > 0 }
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
  read a `StoreConflict`. Write amounts as deltas. Pass `{ actor }` from jobs.
- **Data versions and migrations.** One `storage.version` per module (default 1). **Any change of a collection's
  schema, indexes or `maxChars` needs a higher version**, and `migrate: { [fromVersion]: (json) => json }` where the
  values change; changing a custom check's function needs one too. The upgrade runs once at start, before the module,
  after a backup, all collections in one transaction (at most 20,000 rows); a failure leaves the module `unavailable`
  and the data as it was. **A read never migrates a row**: only that upgrade does. Data written by a newer version
  makes the module `unavailable` and is never touched.
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
  characters (keep data in your own collection and schedule its id); **an absent payload is `{}`**. While the handler
  is published (always, for a module scheduling its own jobs while it runs), **a payload its schema does not decode is
  refused at once**, `invalid`, at `schedule`, `prepare` and `reschedule`, and so is one whose decoder throws. That
  holds for a payload schema that **decodes synchronously** (a `Schema.Struct` of plain fields and checks: use one);
  a schema that decodes asynchronously cannot be decided then, is accepted, and is decoded when the job runs, where a
  payload that does not fit fails the job. A `key` keeps one live job per key: scheduling it again replaces the old
  one. At most 200 live jobs per module (`limit` past that). The job's origin is the calling turn's or job's (§3).
- **A handler**: `payload` (a schema), `run(payload, due)`, `idempotent` (default false), `retries` (0 to 10, default 3),
  `timeoutMs` (100 ms to 10 minutes, default 60 s). A handler that declares `idempotent: true` is retried with back-off
  (5 s, 10 s, 20 s, …) up to `retries` when it fails, times out or is cut short by a crash; one that does not is run at
  most once per occurrence. Declare it only if running twice is harmless (it checks what it already did). **What a
  failure leaves** (after the last retry): a **one-off** job is `failed`, a Health issue until it is dismissed; a
  **repeating** (cron) job always moves on to its next occurrence and stays `scheduled`, with `lastError` and
  `failedAt` on its row and a Health issue until an occurrence succeeds, so look for those, not for `failed`, to see
  a broken refresh. A run **cut short** by the module stopping, the server shutting down or a crash is not a failure
  of the handler: the row stays `running` until the handler is published again (or the scheduler's maintenance pass
  finds it), and then an idempotent handler's job runs again, any other one-off job becomes `failed`, and a repeating
  one moves on.
- **The late rule**: `late: "run"` (the default) runs a job found late once, however late; `late: { withinMs }` runs it
  only that late at most, else the job is `missed` and **the handler is not called**. A repeating job that missed
  several occurrences runs once, for the latest. The handler is told how late it is (`due.lateMs`). A handler that
  plans the next occurrence of a series must always run, so it keeps `late: "run"` and decides inside whether the
  occurrence is still worth delivering (below).
- **The cron grammar** is for system jobs (a cache refresh, a nightly clean-up): minute, hour and day-of-week fields
  (and seconds first), **day of month and month must be `*`**, at most 100 characters. `0 7 1 * *` is refused. A cron
  job without a `timeZone` uses the household's. `isSchedulerCron(expr, timeZone?)` from `@pva/core` answers why one
  would be refused (or `undefined`), for checking a schedule your module builds.
- **A spoken recurrence** ("every second Tuesday") is an `RRULE` kept in **your own row**, with **one job for the next
  occurrence**; the handler plans the one after, always after now, so an occurrence missed during an outage is skipped,
  never planned in the past. `@pva/language` reads the phrase (`parseRecurrence`, never guessing: ambiguous is a
  question) and computes the next time (`nextOccurrence`). The rule and its first job are written in one transaction:

<!-- region: packages/module-contracts/test/kit/examples.test.ts#recurrence -->
```ts
const Rule = Schema.Struct({ text: StoredText(120), rrule: StoredText(200), dtstart: StoredText(80), timeZone: StoredText(64) })
const rules = defineCollection({ name: "rules", scope: "household", schema: Rule, maxChars: 1_100 })

const nagTexts = defineTexts({
  en: { when: "When exactly? I didn't understand when.", saved: "Every time: {text}.", unsaved: "I couldn't save that." },
  nl: { when: "Wanneer precies? Ik begreep niet wanneer.", saved: "Elke keer: {text}.", unsaved: "Dat kon ik niet bewaren." }
})

/** The household's zone: `HOME_TIME_ZONE`, and when it is empty (the default), this machine's, as the Home section means. */
const homeZone = (home: Readonly<Record<string, unknown>>): string => {
  const zone = home.HOME_TIME_ZONE
  return typeof zone === "string" && zone.trim() !== "" ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** An occurrence found later than this is not delivered (the moment has passed), but the series goes on. */
const DELIVER_WITHIN_MS = 15 * 60_000

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
      /** The job for the next occurrence after `after`, prepared (not written): `undefined` when the series has ended. */
      const prepareNext = (id: string, rule: typeof Rule.Type, after: number): Effect.Effect<Option.Option<PreparedJob>, SchedulerError> => {
        const at = nextOccurrence(rule, after)
        // The handler always runs, however late (`late: "run"`, the default), so the series is never lost to an outage.
        return at === undefined ? Effect.succeed(Option.none()) : Effect.asSome(ctx.scheduler.prepare({ handler: "due", key: `rule:${id}`, payload: { id }, at }))
      }
      yield* ctx.scheduler.handle("due", {
        payload: Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(200)) }),
        // Running it twice for one occurrence plans the same next job again (same key: it replaces): safe to retry.
        idempotent: true,
        run: ({ id }, due) =>
          Effect.gen(function*() {
            const row = yield* store.get(id)
            if (row === undefined) return // removed meanwhile: nothing to deliver, nothing to plan
            const now = yield* Clock.currentTimeMillis
            if (due.lateMs <= DELIVER_WITHIN_MS) {
              // … deliver it (P9's notifications, once they exist) …
            }
            // Always the next occurrence after now: one missed during an outage is skipped, never planned in the past.
            const next = yield* prepareNext(id, row.value, Math.max(now, due.dueAt))
            if (Option.isSome(next)) yield* ctx.store.transaction((tx) => void next.value.writeIn(tx))
          })
      }).pipe(Effect.orDie)
      return { value: { store, prepareNext } }
    }),
  start: (ctx) =>
    Effect.succeed({
      tools: [makeTool({
        name: "nag_every",
        description: "Repeat a line on a schedule said in words (\"every Tuesday at half seven\").",
        parameters: Schema.Struct({ text: StoredText(120), when: StoredText(120) }),
        risk: "change",
        execute: ({ text, when }) =>
          Effect.gen(function*() {
            const view = ctx.host.view()
            const lang = homeLanguage(view)
            const now = yield* Clock.currentTimeMillis
            const said = parseRecurrence(when, lang, { now, timeZone: homeZone(view.home) })
            // Never guessed: ambiguous or not understood becomes a question for the person.
            if (said.kind !== "ok") return { spoken: say(nagTexts, lang, "when") }
            const rule = { text, rrule: said.value.rrule, dtstart: said.value.dtstart, timeZone: said.value.timeZone }
            // The rule and its first job in one transaction: both or neither (at the job limit, neither).
            const id = randomUUID()
            const unsaved = () => new ToolError({ message: say(nagTexts, lang, "unsaved") })
            const first = yield* ctx.shared.prepareNext(id, rule, now).pipe(Effect.mapError(unsaved))
            yield* ctx.store.transaction((tx) => {
              tx.collection(rules).insert(rule, { id })
              if (Option.isSome(first)) first.value.writeIn(tx)
            }).pipe(Effect.mapError(unsaved))
            return { spoken: say(nagTexts, lang, "saved", { text }), first: said.value.startInstant }
          })
      })]
    })
})
```

- **Inside your own transaction**: `prepare(request)` (an Effect, outside), then `job.writeIn(tx)` (synchronous,
  inside): the job commits or rolls back with your rows, so a refused job (`limit`) leaves neither. A refusal may be
  caught and the rest committed; any other failure of `writeIn` must not be caught. Choose a row's id first
  (`insert(value, { id })`) when the job's payload names it.
- The Home section's `HOME_TIME_ZONE` is empty by default, meaning this machine's zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`); never substitute a fixed zone for it.
- No pause and resume (cancel and schedule again), no background tasks (a fiber in your own scope), no notification
  jobs (a notification for later is a job of yours whose handler calls `ctx.notify.send`, §16). `cancel`, `reschedule`, `get` and `list` (your live jobs, 10 a page, `after`).
- **Cancelling, rescheduling or replacing a job does not interrupt a handler that is already running for it.**
  `cancel`, `reschedule` and scheduling the same `key` again change the job's row at once (`cancelled`, a new due
  time, the new job), and the scheduler drops what the running handler then reports, but the handler runs on to its
  end, side effects included. So a handler whose work can be called off while it runs (a refresh after an
  unsubscribe, a reminder deleted while it is being delivered) **checks your module's own state again right before it
  commits or delivers** (the row it works for still there, still the same: `get` its row, compare a `rev` or a
  version field) and does nothing when it changed. Test that path too: let the job start (`advance` to its due time,
  with a handler that waits, as a fetch does), call it off through your module's own tool, `advance` to the end of the
  run, and see that nothing was written.

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
  data in the household. **No person, no personal write**: when a turn asks for something personal and has no person
  (a public screen, a shared device without a default person), ask whose and write nothing; never store it as the
  household's instead, and do not repeat the private text on that device (the reference module's `pinboard_pin`).
- **A confirmation is revealing too.** A public screen can have a default person: the write then has its owner, and
  the confirmation still must not repeat the personal text there. Ask `Privacy.mayReveal(owner, turn)` before you
  echo it, and say that it was saved without the text when it says no ("Pinned, only for you.").
- **Ask `Privacy.mayReveal` at the moment of revealing**, for that device (the reference module's read tool above). When
  it says no: on a known `shared` device, for a member, you may reduce it to what names no detail ("Sam has two things
  today") where your module's document says so; on a `public` or unknown device, or for an owner who is not a member,
  say nothing personal (at most an anonymous count: "2 personal notes are not read out here").
- **Never cache** the answer of `mayReveal`, of `settingsFor`, or a membership (`People.get`): a device's place, its
  default person and Members change while the module runs (a change of privacy or default person also ends that
  device's session). Look them up when acting.
- `People` (`host.service(People)`): `list`, `get`, `find(spoken)` (`found` / `ambiguous` / `none`: ask when ambiguous),
  diets (`dietOf`, `setDiet`). `Devices`: the known devices, their places and capabilities, the best other screen.
- There are no children, no trusted devices and no voice identification in this stack. Do not suggest protections
  that do not exist.

## 8. Secrets

A secret is a settings field of kind secret: `Setting.secret({ label, required? })`, never overridable by an assistant
and never on a page. Its value comes from the **key vault**, from the **environment** (the field's `env` variable,
which wins and is not protected by the vault), or, before a vault exists, from the old secrets file. The module
receives it in `settings` when its part starts. **A running module keeps the secrets it started with when the vault
locks**, and a restart with the same configuration reuses them: locking the vault is not a way to revoke a client a
module made with a key. While the vault is locked when the module starts, a vault secret is absent.

**Never put a secret, or anything derived from one, in a status line, an error, a log line, a tool result, a spoken
line, a stored row, an action's text, an option label or value, a description, an `info` value or a Health issue.** Say
what happened instead ("The key was refused"). The host's page boundary replaces exact occurrences of a secret on admin
pages with `[secret]`, but that is a safety net, not a licence (it cannot see an encoded or cut secret, and model
results never pass it). `checkModule` starts the module with recognisable secret values and fails (`secret`) when one
reaches what the module declares or what the admin page shows; what your tools return, speak and store, **your tests
assert** with the kit's `expectNoSecrets` (§17). Compare a secret with `timingSafeEqual`.

## 9. Settings forms

Field kinds (`Setting.*` from `@pva/core`): `text`, `secret`, `number`, `boolean`, `choice`, `multichoice`, `textList`,
`records` (a list of flat items), `combo` (a choice with suggestions the instance fills), `action` (a button: a "Test"
handler in `fieldActions`) and `info` (a read-only value the instance sets). A field may be `overridable` (an
assistant may own its value; never a secret, and modules do not mark addresses) and `visibleWhen` another field has one
of some values.

**Which value a field has.** A shared field: the environment, then the saved value, then a linked default (a Home
section value, where the field follows one), then the field's default. An `overridable` field: **the assistant's own
value over all of those**. `start` gets the result for its instance. `shared` gets no overridable field at all: read
one with `ctx.settingsFor(assistantId)` (the assistant's effective settings, or the shared ones for `undefined`) at the
moment it acts for that assistant.

- **`records` stay flat**: an item is text, number, boolean, choice, multichoice or text-list fields. **Nested
  configuration** (a routine's steps) is **JSON in a text field**, validated with a schema and explained on error.
  Nobody builds a nested editor in this stack.
- **Size budgets**: the described form at most 8 KiB as the wire encodes it (bytes; the module does not start
  otherwise: `checkModule`'s `form`); the complete form as sent, with values and tools, at most 48 KiB (bytes; a save
  over it is refused); a `records` or `textList` value at most 32,768 characters of its `JSON.stringify` text (string
  length, not bytes); a `combo` at most 200 options; `info` values cut to 1,000 characters, Test results to 500.
- **Buttons** (`action` fields): a press has 8 s. One button runs one press at a time: it stays busy until its press has
  really ended. A module runs at most 4 presses at once (a fifth is refused `busy`, and Health says so). A "Test" press
  runs to its result or its time limit whether or not the page that pressed it is still connected.

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

## 10. Typed actions

An action (`defineAction`) is a command with typed parameters that can run without the language model: the intent
agent matches it from its `examples` (give English and Dutch), and the model is offered it as the generated tool
`<moduleId>_<actionId>` (unless `offerAsTool: false`). Its identity is `<moduleId>.<actionId>`. An action id is 1 to 40
lower case letters, digits and `_`, starting with a letter (a module id: lower case letters, digits and `-`), and the
generated tool name must fit 64 characters (the host refuses the start otherwise). Parameters (`Param.*`): `choice` (a fixed list), `dynamic` (a list the module knows at run time,
read synchronously from its own cache), `number`, `duration`, `boolean`, `text`; `optional` with a `default`.

<!-- region: packages/module-contracts/test/kit/examples.test.ts#param-action -->
```ts
/** A typed action with parameters: a choice the module fixes, a dynamic choice from its own cache, a number. */
const rooms = (): ReadonlyArray<{ readonly value: string; readonly label: string; readonly aliases?: ReadonlyArray<string> }> => [
  { value: "kitchen", label: "Kitchen", aliases: ["keuken"] },
  { value: "living", label: "Living room", aliases: ["woonkamer", "lounge"] }
]
const fanTexts = defineTexts({ en: { set: "The {room} fan is on {speed} for {minutes} minutes." }, nl: { set: "De ventilator in {room} staat {minutes} minuten op {speed}." } })

export const fanModule = defineModule({
  apiVersion: 2,
  id: "fan",
  name: "Fan",
  description: "Turns a room's fan on for a while.",
  enabledByDefault: false,
  start: (ctx) =>
    Effect.succeed({
      actions: [defineAction({
        // Its id is `fan.run` (`<moduleId>.<actionId>`), and the model is offered it as the tool `fan_run`.
        id: "run",
        label: "Run the fan",
        description: "Run a room's fan at a speed for some minutes.",
        examples: ["run the kitchen fan on high for ten minutes", "zet de ventilator in de keuken tien minuten hoog"],
        params: {
          room: Param.dynamic({ label: "Room", options: rooms }),
          speed: Param.choice({ label: "Speed", options: [{ value: "low", label: "low" }, { value: "high", label: "high" }], default: "low", optional: true }),
          minutes: Param.number({ label: "Minutes", min: 1, max: 60, integer: true })
        },
        risk: "change",
        run: ({ room, speed, minutes }) =>
          Effect.succeed({ say: say(fanTexts, homeLanguage(ctx.host.view()), "set", { room: rooms().find((r) => r.value === room)?.label ?? room, speed: speed ?? "low", minutes }) })
      })]
    })
})
```

A routine step, and a test, runs one through **`host.actions.run({ moduleId, actionId, params })`**, with the values
in their tool input form (a dynamic choice by its value, a duration as a phrase), through the gateway and as the
calling turn:

<!-- region: packages/module-contracts/test/kit/examples.test.ts#param-action-test -->
```ts
const run = yield* kit.action("run", { room: "kitchen", speed: "high", minutes: 10 })
assert.deepStrictEqual(run, { ok: true, say: "The Kitchen fan is on high for 10 minutes." })
// The same through its generated tool, as the model calls it.
const tool = yield* kit.tool("fan_run", { room: "kitchen", minutes: 5 })
assert.strictEqual(tool.value, "The Kitchen fan is on low for 5 minutes.")
```

**An action's `run` has 5 s** (`ACTION_TIMEOUT_MS`), on every path; past that it is interrupted and fails. That is
shorter than `safeFetch`'s default of 6 s: a network call inside an action takes an explicit `timeoutMs` (3 s leaves time
to answer), and work that may take longer is scheduled (`inMs: 0`) or started in the module's shared part while the
action answers what it started. It returns `{ say }`, spoken as it is with no model (in the household's language, §16).

## 11. HTTP routes

**No module of wave A has a route**, and the test kit does not imitate the server's router. A `shared` part may return
`routes`, answered under `/api/modules/<moduleId>/<path>` (at most 32 routes, a path at most 200 characters) only while
that part is the published one. Each route declares **guards, every one of which must pass**: `admin` (the admin
session), `token` (a route token of this module with the route's `token` name, minted by the owner on the module's page,
kept in the key vault: while the vault is locked a token route cannot check its caller and answers 503), `lan` (a private or
loopback caller; refused for everyone when the server is behind a declared proxy). A route without guards must be
`public: true`, a GET with no body. Also: `body` (`json`, `bytes`, `none`), `bodyLimitBytes` (8 KB, at most 1 MB),
`rateLimit` (30 a minute per caller, 120 in all), `timeoutMs` (5 s, at most 30 s). A handler runs outside any turn and
any job (no principal: it cannot run actions as anyone), in a slot of the module (at most 16 at once), and is
interrupted when its part closes. While the module is stopped or being replaced its routes are withdrawn: **a new
request gets 404**; only a request already admitted when the module stops gets 503. Requests a browser marks as from
another site are refused before the guards **on routes that are not `public`**; a `public` route can be reached
from any site (another site's page can load it in a browser), so it returns only what is meant for anyone on the
network. The first module that has a route brings its route tests, in the app's
serve tests (`apps/assistant/test/moduleRoutes*.test.ts` show how).

## 12. The network

Outgoing HTTP is `@pva/net`; **a module never calls `fetch` itself** (nor `node:http`, nor a library that makes its own
requests). In this wave that is `GET` and `HEAD` to any URL, and a `POST` with a JSON body only to an address the owner
typed: a module whose first version needs another method (a `PUT`, a WebDAV verb), another body (a form, a file, a
stream), a WebSocket or a `POST` to a URL a model or a page chose is not in this wave.

- **`safeFetch(url, { accept, … })`** for public APIs and any URL a model chose: `accept` (the response types you take:
  `contentTypes.json`, `webPage`, `feed`, `image`, or your own) is required; only `http`/`https`, ports 80 and 443, no
  credentials in the URL, every non-public address refused (checked on the address it connects to, and on every
  redirect), limits on size (`maxBytes`, 2 MiB) and time (`timeoutMs`, 6 s; an action's call takes less, §10).
- **`fetchOwnerConfiguredLan(url, …)`** only for an address the owner typed into your settings (a LAN SearXNG, Home
  Assistant, Grocy): it also allows private addresses, local names and other ports. **Never pass it a URL a model chose.**
  - **`method: "POST", body: { json }`** when the API takes a JSON request (Home Assistant's `/api/services/…`,
    `/api/template`). The helper serialises `json`, sets `Content-Type: application/json` and the length (yours are
    refused) and refuses a body over `maxRequestBytes` (64 KiB; you may set up to 128 KiB, whose serialisation stops the
    main thread under 5 ms: a heartbeat's longest gap 4.5–5.0 ms for the worst shape) before connecting; a value
    `JSON.stringify` cannot write is `NetRefused` (`body`). The one `timeoutMs` includes serialising. **A POST is sent once,
    to one server**: every 3xx answer is refused (`post-redirect`), it is never retried, and it moves to the host's next address only after a refused or
    timed-out connect, when nothing was sent. So **a POST that failed may or may not have been carried out**: say so
    ("I could not confirm the kitchen light is on"), and do not repeat it by yourself. Every other rule (addresses, headers,
    the response type, `maxBytes`, the one `timeoutMs`, interruption) applies to the POST and its answer.
  - **`typedLoopback: true`** when the owner's server may run on the assistant's own machine (`http://localhost:8123`):
    loopback is then allowed only when the URL is text whose host, as written, is exactly `localhost` (ASCII, any case),
    `[::1]` or a plain dotted quad `127.a.b.c`. Every other spelling (`2130706433`, `0x7f000001`, `127.1`, `127.0.0.1.`,
    `localhost.`, `x.localhost`, `%6cocalhost`, `[::ffff:127.0.0.1]`, a `URL` object), a name that resolves to loopback and a
    redirect to loopback stay refused. Without the option, every loopback address is refused. The kit's offline network
    resolves `localhost` names to loopback, so your test passes only where serve mode would.
- **`makeCachedJson`** for JSON with a time to live, `ETag` and stale-if-error.
- **`userAgent(contact)`**: put the owner's contact (Home › API contact, `HOME_API_CONTACT`) in the User-Agent **only
  when the owner set one**.
- Declare `requires: [{ network: "internet", why }]` (or `"lan"`) and a `health`.
- Take the `resolver` and `connector` as dependencies, so tests pass the kit's network that has no network
  (`makeOfflineNet`): a host that no fixture names is refused, a literal address (`https://8.8.8.8/`) too and after a
  redirect, and only a named host's path without a fixture answers 404. That replaces exactly those two of `@pva/net`:
  it does not catch a library's own `fetch`, `node:http` or DNS lookups, which is one more reason a library that
  fetches by itself is not in this wave.

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

A POST in a module and in its test: the test reads the method and the body that was sent from `net.requests` (`body` is
the text as sent), and a fixture function sees the request with its `method` and `body`.

<!-- region: packages/module-contracts/test/kit/network.test.ts#net-post-module -->
```ts
/**
 * The owner's Home Assistant (its address from the module's settings, `http://localhost:8123` included): a POST with a JSON body.
 * Sent once: no redirect is followed and it is never retried, so a failure may or may not have switched the light.
 */
export const callService = (deps: NetDeps, baseUrl: string, token: string, domain: string, service: string, data: Readonly<Record<string, unknown>>) =>
  fetchOwnerConfiguredLan(`${baseUrl}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
    accept: contentTypes.json,
    method: "POST",
    body: { json: data },
    typedLoopback: true,
    timeoutMs: 3_000,
    headers: { authorization: `Bearer ${token}` },
    ...deps
  })
```

<!-- region: packages/module-contracts/test/kit/network.test.ts#net-post-test -->
```ts
it.effect("a POST to the owner's server: the test reads the method and the body that was sent", () =>
  Effect.gen(function*() {
    const net = makeOfflineNet(
      {
        "http://ha.lan:8123/api/services/light/turn_on": (request) =>
          request.method === "POST" ? { body: [{ entity_id: "light.kitchen" }] } : { status: 405, body: "POST only" }
      },
      { lan: { "ha.lan": "192.168.1.20" } }
    )
    const deps = { resolver: net.resolver, connector: net.connector }
    const answer = yield* callService(deps, "http://ha.lan:8123", "t0ken", "light", "turn_on", { entity_id: "light.kitchen", brightness_pct: 40 })
    assert.deepStrictEqual(JSON.parse(answer.text()), [{ entity_id: "light.kitchen" }])
    const [sent] = net.requests
    assert.strictEqual(sent?.method, "POST")
    assert.deepStrictEqual(JSON.parse(sent?.body ?? ""), { entity_id: "light.kitchen", brightness_pct: 40 })
    assert.strictEqual(sent?.headers["content-type"], "application/json")
    assert.strictEqual(sent?.headers["authorization"], "Bearer t0ken")
    // A GET to the same fixture: no body recorded, the fixture sees the method.
    const get = yield* fetchOwnerConfiguredLan("http://ha.lan:8123/api/services/light/turn_on", { accept: contentTypes.json, ...deps })
    assert.strictEqual(get.status, 405)
    assert.deepStrictEqual([net.requests[1]?.method, net.requests[1]?.body], ["GET", undefined])
  }))
```

Everything that comes back (a page, a feed, an invitation's text) is untrusted data: pass it to the model marked as such,
cut to a bound, never as instructions. Parsing it with a library is not done on the main thread: §15, "Parsing off the
main thread".

## 13. Services and contributions between modules

A module offers others a **service** (one provider per key: `services: [Key.of(impl)]` in `shared`) or a
**contribution** (any number: `contributions: [Key.of(value)]`). The shared keys and their interfaces are in
`@pva/module-contracts`; **each file's documentation is the contract**: what a provider must do and what a consumer may
rely on, with every bound and id.

| Key | Kind | Provided by | Used by | File |
|---|---|---|---|---|
| `Lists` | service: the household's shopping list | lists | kitchen | `lists.ts` |
| `Timers` | service: start a timer | timers (wave B) | routines; kitchen later | `timers.ts` |
| `HomeAssistant` | service (a transport) | home-assistant (smart-home) | music (wave B), presence | `homeAssistant.ts` |
| `Playback` | service: pause, volume | music (wave B) | the host's "stop" (P7; volume later) | `playback.ts` (defined in `@pva/core` since P7, re-exported) |
| `BriefingSections` | contribution | weather, bin-day, calendar, news; reminders later | briefing | `briefing.ts` |

The core's own are `People`, `Privacy`, `Devices`, and since P7 `SessionControl` (stop the reply, cancel what is pending,
repeat the last reply, a new conversation) and `DeviceControl` (the reply volume), in `@pva/core` ([PHRASES.md](PHRASES.md)
"Session and device control"); each call names the device it acts on (a tool passes its turn's `deviceId`). The
calendar module keeps its own provider interface (ICS) inside its package: no other module provides a calendar in
this wave.

- **Look a service up at each use** (`ctx.host.service(Key)`), never keep it: `undefined` means its module is off, and
  the consumer says so in one sentence. A call made while the provider stops may die with `ModuleStopped`.
  `useService(host, Key, use)` turns both into `ProviderOff`, which carries the service's id; `providerOffText(lang,
  name)` gives the sentence in both languages. A contract's errors carry a `reason`, which the consumer words in its
  own two-language texts, and a `detail` for the log:

<!-- region: packages/module-contracts/test/contracts.test.ts#consumer -->
```ts
/** The consumer's own sentences, in both languages; a contract's errors carry a reason, which it words itself. */
const consumerTexts = defineTexts({
  en: { added: "Rice is on the shopping list.", full: "The shopping list is full.", failed: "I couldn't reach the shopping list." },
  nl: { added: "Rijst staat op het boodschappenlijstje.", full: "Het boodschappenlijstje is vol.", failed: "Ik kon het boodschappenlijstje niet bereiken." }
})

/** A consumer: asks the lists module through useService, and says so in the household's language when it is off. */
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
        execute: () => {
          const lang = homeLanguage(ctx.host.view())
          return useService(ctx.host, Lists, (lists) => lists.addItem({ text: "Rice", dedupeKey: "consumer:rice" })).pipe(
            Effect.map(() => say(consumerTexts, lang, "added")),
            Effect.catchTag("ProviderOff", () => Effect.succeed(providerOffText(lang, "Lists"))),
            Effect.catchTag("ListsError", (e) => Effect.succeed(say(consumerTexts, lang, e.reason === "limit" ? "full" : "failed")))
          )
        }
      })]
    })
})
```

- **A service call runs on behalf of the call that made it**: the gateway admitted the consumer's tool or job, and the
  provider does not ask again. So a service offers only what any caller may do (reads and `change` on household
  data). The transport (`HomeAssistant`) is never offered to the model as a tool: the consumer classifies its own
  tools, and each call it makes must fit the call the gateway admitted; it targets entities by id only, and the
  provider refuses anything else.
- **Contributions** are read live: `host.contributions(Key)` (an Effect; inside a turn only those of modules the turn's
  assistant has on). Native code names the assistant: `host.contributionsFor(Key, assistantId)`.
- A module that **cannot run at all** without a provider names it in `uses`; one that works without it does not.
- Events (`ctx.events.publish("item.completed", …)`, published as `<moduleId>.item.completed`) may be listened to, but
  nothing may depend on an event for correctness: they are lost at a restart. Consume a subscription in the part's
  scope (`Effect.forkScoped` in `shared`).
- **Testing a consumer**: give it a **stub** of the contract through the kit's `provide`, which publishes it from a
  stand-in module of the provider's id, exactly as the real one would be found. A stub (`stubService`) has no behaviour
  of its own: it records its calls and answers what the test programs (a value, a function of the arguments, a typed
  failure with `fails`, the provider stopping with `stops`); program only answers the contract's documentation allows.
  A method called without an answer fails the test. Testing a provider: its own tests, against its contract's text.

<!-- region: packages/module-contracts/test/contracts.test.ts#consumer-test -->
```ts
// A stub answers what the test programs, and records what it was asked; it does nothing of its own.
const lists = stubService<ListsService>("lists", {
  addItem: (request) => Effect.succeed({ outcome: "added", item: { id: "item-1", text: request.text, status: "open", ...(request.dedupeKey !== undefined ? { dedupeKey: request.dedupeKey } : {}) } })
})
const on = yield* startTestModule(consumer, { provide: [provide("lists", { services: [Lists.of(lists.service)] })] })
assert.strictEqual((yield* on.tool("consumer_add", {})).value, "Rice is on the shopping list.")
assert.deepStrictEqual(lists.calls.addItem, [[{ text: "Rice", dedupeKey: "consumer:rice" }]])
// The answers the contract allows: full, and the provider stopping during the call.
lists.answer("addItem", fails(new ListsError({ reason: "limit", detail: "500 open items" })))
assert.strictEqual((yield* on.tool("consumer_add", {})).value, "The shopping list is full.")
lists.answer("addItem", stops())
assert.strictEqual((yield* on.tool("consumer_add", {})).value, "The Lists module is off.")
// No lists module at all, in a Dutch household.
const off = yield* startTestModule(consumer, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
assert.strictEqual((yield* off.tool("consumer_add", {})).value, "De module Lists staat uit.")
```

## 14. What a module survives, and what it must not do

Modules are compiled into the app and trusted. The host handles correctly an Effect of yours that fails, dies or takes
too long **and stops when it is interrupted**, and a plain function you hand it (a settings check, a decoder, a risk
function) that throws: what that does depends on where (the table in §2). It does **not** promise anything for code that
breaks the runtime's rules. So:

- **Stop when interrupted.** A turn is cut off by barge-in all the time; a stop gives your calls 10 s, then interrupts
  them. Never make long work uninterruptible; wait with `Effect.sleep`, never a busy loop; pass the `AbortSignal` on.
- **Never block the event loop.** It also frames audio for every browser. No unbounded synchronous work: parse and
  evaluate with bounds (an expression evaluator with limits on size and depth, or `offThread`, §15; a length limit
  alone does not bound a synchronous evaluator), keep transactions small, cut large inputs first.
- **Finite cleanup.** Finalizers finish in 5 s (past that the host abandons them and says so on the Health page).
- **Do not hand the host objects whose properties throw or change**, do not go around the gateway (sealed tools are not
  a security boundary, but going around them is a bug), and keep nothing of the host after your part closed.
- A request you make (`requestRestart`, a save, a schedule) is recorded whole or not at all; `requestRestart` is taken
  up at most once every 5 s and only from a live part.
- Event handlers are not calls in flight: they get no grace period and are interrupted when the part closes. Do what
  must not be cut short in one store transaction.

## 15. Latency

Nothing slow on the turn path; a claim about latency needs `TurnTrace` numbers, not reasoning.

- **A context provider has 50 ms** per turn, or contributes nothing that turn: answer from a cache or the store
  (bounded, indexed reads), never the network. Keep its line short; it is sent with every turn.
- Instructions are part of the cached prompt prefix: stable text only; changing them costs one cache miss.
- A read tool that is safe to run early is `speculative: true`: it may run before the turn is committed. A tool's
  `latency` says what to expect (`instant` < 50 ms, `quick` < 1 s, `slow` seconds).
- Store calls are synchronous: one `list` holds the main thread at most a few milliseconds (§5); a `schedule` from a
  tool is a fraction of a millisecond. A risk function has 2 ms; an action 5 s (§10).
- Slow work (a feed refresh, a calendar refresh) is a job or a fiber in `shared` that keeps a cache; the turn reads the
  cache.

### Parsing off the main thread: `offThread`

The main thread plays and listens to audio for every device: nothing may hold it for more than about 10 ms. Parsing
text from outside with a library is far slower and cannot be sliced (measured on the development machine: a web page
into text 50 to 200 ms, much longer for a deeply nested one; a 1 MB RSS feed 52 to 75 ms; an article extraction 59 to
91 ms; a spelling dictionary 400 ms). **Any parsing or computing on text from outside that could take more than a few
milliseconds** (pages, feeds, calendars, documents, dictionaries) runs through `offThread` from `@pva/core`: a pure
function in a fresh worker thread, started for the call and terminated after it.

It is made for **trusted code on untrusted input**: your task file and the library it imports are compiled in and do
not attack the helper; the input (a page, a feed, a calendar file) may be huge, deeply nested, or built to make a parser
loop or allocate. What a worker thread cannot guarantee is said below.

- **The task module** is a file of your own package (`src/<name>.task.ts`): an ES module, `.ts`, `.mts` or `.mjs`,
  that default-exports one function `(input) => output` or a promise of it, and imports what it needs (the libraries
  are your package's dependencies). A `.js`, `.cjs` or `.cts` task is refused (`load`) before a worker starts. A `.ts`
  or `.mts` task is loaded through tsx in the worker; an `.mjs` one is not, so it can import JavaScript only. Name it
  once with `offThreadTask`, with its type, so nothing of it is loaded on the main thread.
- **The input has one narrow shape**: a string, a `Uint8Array` (a `Buffer` too), or one plain object or array, one
  level deep with at most 32 entries, whose values are strings, `Uint8Array`s, finite numbers, booleans or `null`.
  Anything else (a nested object or array, `undefined`, a `Date`, a class instance, another typed array, bytes on
  shared memory) is refused with `input` before a worker starts. Its size (string code units × 2, plus bytes, plus 8
  per other value, keys included) is at most `maxInputBytes`: 4 MiB, the default and the most a call may ask for,
  checked before anything is copied. Bytes are copied onto a buffer of their own before they cross: the task never
  sees the bytes beside them in a pooled `Buffer`, and what it writes stays in the worker. Pass a fetched body as it
  is (cap the fetch first: `safeFetch`'s `maxBytes`), and the settings the task needs as a few plain fields: pass a
  small record of your own, never an object parsed from outside (counting the keys of a huge one costs the main
  thread before it is refused: 80 to 150 ms for 500,000 keys).
- **The answer: return text or a small structure; a big structure is refused.** The worker serialises the answer
  once, into one buffer that is checked, transferred, checked again and read on the main thread (the task's value
  itself never crosses). Reading text or bytes costs the main thread by the byte, reading a structure by the object.
  So `maxResultBytes` (default 128 KiB) may be raised to 4 MiB, but only an answer that is one string or one
  `Uint8Array` may use more than 128 KiB. A structured answer (an object, an array, anything else) over 128 KiB fails
  with `too-large` whatever the limit says, and its buffer is never read. No sparse arrays: an array with holes, or an
  answer of more than 131,072 values in all, is refused too (a hole costs nothing to send but is allocated whole when
  read). The longest stop of the main thread while
  receiving the largest allowed answers, and what larger structures cost (development machine, worst of 5 calls):

  | Answer | Allowed | Longest stop |
  |---|---|---|
  | a 4 MiB string | with `maxResultBytes` raised | 3.6 to 4.6 ms |
  | 4 MiB of bytes | with `maxResultBytes` raised | 3.1 to 8.0 ms |
  | 128 KiB of small objects (13,931 of them) | yes, the largest structure | 2.4 to 2.5 ms |
  | 1 MiB of small objects | no | 19 to 21 ms |
  | 4 MiB of small objects | no | 107 to 120 ms |

- **The call**: `offThread(task, input, { timeoutMs, maxMemoryMb, maxResultBytes, maxInputBytes })`. It is an Effect:
  call it from a tool, a job or a part's start; only from the main thread (a task that calls it is refused with
  `nested`: tasks do not nest).
  - `timeoutMs` is required (at most 60 s). It is one deadline, taken when the call begins: the time waiting for a
    slot counts, a call whose deadline has passed is never started, and an answer after it is a `timeout`. It is real
    time, so it holds under the test kit's clock too.
  - The time limit stops **pure JavaScript**: loops, regular expressions, `Atomics.wait`. A **synchronous native call**
    (`crypto.*Sync`, `fs.*Sync`, a native addon) cannot be stopped: it holds its slot until it returns, and the call
    with it. A task must not make one whose cost depends on the input.
  - Interrupting the call (barge-in, the module stopping) terminates the worker the same way.
  - **At most two workers run at once** in the process, and **at most 32 calls wait** for a slot, in the order made;
    one more fails at once with `busy` and keeps nothing. A module that fans out (a feed per source, a page per
    result) must expect `busy` and treat it like a failed fetch.
  - `maxMemoryMb` (default 128, 16 to 1,024) limits the worker's **JavaScript heap** as V8 enforces it (with it its
    young generation, an eighth of it from 8 to 32 MB, and a 4 MB stack; one very large string may still get through
    before the worker is stopped), not buffers outside the heap (an `ArrayBuffer`, a typed array). The real
    protection against a huge allocation is the input limit above and your task's own caps on what it builds (a limit
    on entries, on nodes, on characters).
- **Output**: in the worker, `console.*` and `process.stdout.write` / `process.stderr.write` write nowhere before the
  task is loaded (what a library prints could quote the input, and passing it on would cost the main thread). Writes
  to the raw descriptors (`fs.writeSync(2, …)`) are not caught; a task does not make them.
- **Each failure is an `OffThreadError`** with a `reason`, and a one-line `message` for the log that names the task and
  never quotes the input: of a thrown value only its name, when it is a built-in one (`Error`, `TypeError`,
  `RangeError`, `SyntaxError`, …), and its code, when it is one of a fixed list of Node's (`ERR_MODULE_NOT_FOUND`, …);
  anything else is `other error`.

  | `reason` | What happened | What the person hears |
  |---|---|---|
  | `timeout` | the time limit passed (waiting included); the worker was terminated | it took too long to read |
  | `memory` | the worker ran out of `maxMemoryMb` | it could not be read |
  | `too-large` | the answer was over `maxResultBytes`, is a structure over 128 KiB, holds an array with holes or more than 131,072 values | it could not be read (or: it is too long) |
  | `failed` | the task threw or rejected (a stack overflow too, and a throw from a timer or a rejection nobody handled), or its answer cannot be serialised | it could not be read |
  | `exited` | the worker ended without answering, or could not start | it could not be read |
  | `load` | the task module is missing, has no default function, or is not a `.ts`, `.mts` or `.mjs` file: a bug of the module | it could not be read |
  | `input` | the input is not of the shape above, or over `maxInputBytes`: a bug of the module (cap first) | it could not be read |
  | `busy` | 32 calls were already waiting | as for a failed fetch: try later |
  | `nested` | called from a worker thread (from a task): a bug of the module | it could not be read |

- **Not**: no state shared between calls (each call is a fresh thread: a global set in one call is gone in the next),
  no network and no store from the task (fetch first, store after, on the main thread), no secrets in the input
  unless the task needs them. Of the server's environment variables the worker gets only `NODE_ENV`, `TMPDIR`,
  `TMP`, `TEMP`, `TZ` and those whose names start with `TSX_`; every other one is left out. It is not a
  sandbox: the worker keeps the server's working directory and file access, because the task is trusted code. Never
  from a context provider or anywhere else on the turn path: the start-up cost below is more than a context
  provider's 50 ms.
- **The numbers** (`packages/core/test/OffThread.test.ts` prints them; development machine, two runs):
  - Start-up, paid on every call by design (median of 5 calls): the thread alone 26 ms; a TypeScript task without
    imports 110 ms (tsx's loader is started in each worker, so a `.ts` task loads the same under tsx, vitest and plain
    node); a task importing `linkedom` 229 to 230 ms; one importing `feedsmith` 215 to 224 ms. Add it to the tool's
    `latency` (a tool that parses a page is `slow`).
  - The main thread's own share, the longest stop of a 1 ms timer over 5 calls: 1 MiB in and 100 KiB out 1.8 ms; the
    largest legal input (4 MiB as counted) 3.6 to 4.0 ms as a string of two-byte characters, 1.8 to 1.9 ms as bytes,
    1.5 to 1.9 ms as an object of 30 strings; a task writing 80 MB to console and the streams 1.2 to 1.5 ms.
  - Refusals that never reach the main thread as data: a sparse answer of ten million entries (20 bytes serialised)
    holds it 1.6 ms, an uncaught 32 MiB failure (a thrown `Error` or object from a timer, an unhandled rejection) 1.2
    to 1.3 ms.
  - A task that loops forever ends 4 ms after its time limit; an interrupted one is gone 3 to 4 ms after the
    interruption.
  - A rare stop of 6 to 8 ms on the main thread is its own garbage collection, not the helper's work (a GC observer
    saw a major collection of about 7 ms, or a scavenge of 4 to 6 ms, during each such call).

<!-- region: packages/module-contracts/test/kit/pageText.task.ts#offthread-task -->
```ts
// pageText.task.ts: a page from outside read into text. One pure function, plain data in and out; nothing shared,
// no network, no store. It runs in a fresh worker thread for each call (offThread in the module).
import { parseHTML } from "linkedom"

export default (html: string): string => {
  const { document } = parseHTML(html)
  for (const node of document.querySelectorAll("script, style, noscript")) node.remove()
  return (document.body?.textContent ?? "").replace(/\s+/g, " ").trim()
}
```

<!-- region: packages/module-contracts/test/kit/offThread.test.ts#offthread-module -->
```ts
/** The task, named once: its file beside this one, and its default export's type (no import on the main thread). */
const pageText = offThreadTask<typeof import("./pageText.task.ts").default>(new URL("./pageText.task.ts", import.meta.url))

const pageTexts = defineTexts({
  en: { slow: "That page took too long to read.", unreadable: "I couldn't read that page." },
  nl: { slow: "Het lezen van die pagina duurde te lang.", unreadable: "Ik kon die pagina niet lezen." }
})

/** What the person hears when the parse failed: a page too slow to read, or one that cannot be read at all. */
const pageFailure = (lang: "en" | "nl", e: OffThreadError) => say(pageTexts, lang, e.reason === "timeout" ? "slow" : "unreadable")

export const readerModule = (deps: NetDeps) =>
  defineModule({
    apiVersion: 2,
    id: "reader",
    name: "Reader",
    description: "Reads a web page.",
    enabledByDefault: false,
    requires: [{ network: "internet", why: "fetches the page asked for" }],
    start: (ctx) =>
      Effect.succeed({
        tools: [makeTool({
          name: "reader_read_page",
          description: "Read the text of a web page.",
          parameters: Schema.Struct({ url: Schema.String }),
          risk: "read",
          latency: "slow",
          execute: ({ url }) => {
            const lang = homeLanguage(ctx.host.view())
            return safeFetch(url, { accept: contentTypes.webPage, maxBytes: 2 * 1024 * 1024, timeoutMs: 6_000, ...deps }).pipe(
              // The parse runs in a worker: the main thread only posts the page and receives the text.
              Effect.flatMap((response) => offThread(pageText, response.text(), { timeoutMs: 3_000, maxResultBytes: 128 * 1024 })),
              Effect.map((text) => `Untrusted page text: ${text}`),
              Effect.catchTag("OffThreadError", (e) => Effect.succeed(pageFailure(lang, e))),
              // The fetch's own failures (refused, too large, too slow, a bad status): the page could not be read.
              Effect.catch(() => Effect.succeed(say(pageTexts, lang, "unreadable")))
            )
          }
        })]
      })
  })
```

Its test starts real workers; `offThreadWorkers()` in `@pva/core/testing` says how many are running:

<!-- region: packages/module-contracts/test/kit/offThread.test.ts#offthread-test -->
```ts
const page = "<html><head><script>track()</script></head><body>\n<h1>Bins</h1>\n<p>Paper goes out on Tuesday.</p></body></html>"
const net = makeOfflineNet({
  "https://example.org/bins": { body: page, headers: { "content-type": "text/html" } },
  "https://example.org/huge": { body: `<html><body><p>${"word ".repeat(100_000)}</p></body></html>`, headers: { "content-type": "text/html" } }
})
const on = yield* startTestModule(readerModule({ resolver: net.resolver, connector: net.connector }))
// A real worker runs the task, in tests as in the app (its time limit is real time, not the kit's clock).
assert.strictEqual((yield* on.tool("reader_read_page", { url: "https://example.org/bins" })).value, "Untrusted page text: Bins Paper goes out on Tuesday.")
// Text over the result limit is a typed failure (`too-large`), which the module words itself.
assert.strictEqual((yield* on.tool("reader_read_page", { url: "https://example.org/huge" })).value, "I couldn't read that page.")
// Every worker has ended.
assert.strictEqual(offThreadWorkers().running, 0)
```

### Latency tests

A test file that asserts how long the main thread stops (the longest gap of a 1 ms heartbeat) or how long real work
takes imports `packages/store-sqlite/test/latencyBound.ts` and writes its bounds as `bound(ms)`, and **that import is
what makes it a latency test**: CI runs those files alone, one at a time after the rest (`vitest.latency.ts`), so other
tests' busy threads do not lengthen what they measure, while `pnpm test` still runs everything together. A latency
test that opens a SQLite file takes its directory from `latencyDir()` in the same file, which is on a real disk (never
tmpfs, where a sync costs nothing and a stop it causes would not show; docs/STORING-DATA.md "Latency").

## 16. Speaking

What a tool returns goes to the model, which words the reply. Return **a `spoken` line** (one or two sentences, ready to
say) or **a small result the model can word in a sentence or two**: the answer first, then at most a few items with "and
N more". Never markup, never a URL to read out, never a list of fifty things. Typed actions return `{ say }`, spoken as
it is with no model.

**Every sentence the module says itself is in English and Dutch**, failures, questions and refusals included, chosen
by the household's language (`homeLanguage(ctx.host.view())`, `HOME_LANGUAGE`; anything that is not Dutch is English),
British conventions ("half seven" is 7:30; Dutch "half acht" is 7:30). A `ToolError`'s and an `ActionError`'s message is
spoken too: take it from the table. Numbers, times, dates, durations, amounts and lists are worded by `@pva/language`
(`speakTime`, `speakDate`, `speakDuration`, `speakAmount`, `speakList`) so every module sounds the same. Keep the texts
in one table (`defineTexts`) with the same placeholder names in both languages (`checkModule(definition, { texts })`
compares them; `say` fills every occurrence of a name):

<!-- region: packages/module-contracts/test/kit/pinboard.ts#texts -->
```ts
/** Every sentence the module speaks, failures and questions included, in both languages with the same placeholders. */
export const texts = defineTexts({
  en: {
    pinned: "Pinned: {text}.",
    pinnedUntil: "Pinned for {hours} hours: {text}.",
    pinnedPrivately: "Pinned, only for you.",
    pinnedPrivatelyUntil: "Pinned for {hours} hours, only for you.",
    empty: "The pinboard is empty.",
    cleared: "Cleared {count} old notes.",
    clearedSome: "Cleared {count} old notes; there are more, so say it again.",
    withheld: "{count} personal notes are not read out here.",
    cut: "I read the newest {count} notes; there are more.",
    whose: "Who is the note for? I can't tell who is asking here.",
    unreadable: "The pinboard could not be read.",
    unsaved: "The note could not be pinned.",
    uncleared: "The pinboard could not be cleared."
  },
  nl: {
    pinned: "Vastgeprikt: {text}.",
    pinnedUntil: "Vastgeprikt voor {hours} uur: {text}.",
    pinnedPrivately: "Vastgeprikt, alleen voor jou.",
    pinnedPrivatelyUntil: "Vastgeprikt voor {hours} uur, alleen voor jou.",
    empty: "Het prikbord is leeg.",
    cleared: "{count} oude briefjes weggehaald.",
    clearedSome: "{count} oude briefjes weggehaald; er zijn er meer, zeg het nog eens.",
    withheld: "{count} persoonlijke briefjes lees ik hier niet voor.",
    cut: "Ik heb de nieuwste {count} briefjes gelezen; er zijn er meer.",
    whose: "Voor wie is het briefje? Ik weet hier niet wie het vraagt.",
    unreadable: "Het prikbord kon niet worden gelezen.",
    unsaved: "Het briefje kon niet worden vastgeprikt.",
    uncleared: "Het prikbord kon niet worden leeggemaakt."
  }
})
```

### Notifications and announcements (P9)

What the house says or shows that nobody on that device just asked for goes through the notification service, never a
module's own socket ([NOTIFICATIONS.md](NOTIFICATIONS.md) has the calls, the bounds and the delivery table):

- **`ctx.notify.send`**: a card on the device that asked (`target: "origin"`, the default) or everywhere, `normal`
  (silent) or `ring` (it rings until stopped), with an optional owner (personal content: the privacy rule decides per
  device, when it is delivered), dedupe `key`, expiry (on time), and up to two actions beside the host's
  `stop`. It is delivered **now**: for a notification at a later time, schedule a job of your own and send from its
  handler (below). One transaction and an enqueue: fine on a turn.
- **Action handlers are registered in `shared`** with `ctx.notify.handle(name, { run })`, like job handlers. While your
  module is down a press answers "I can't do that right now" and changes nothing; `stop` always works and wins. A press
  claims the notification first (one action at a time: a second gets "That is being handled already."). A handler runs
  as the press (its device is the origin of what it sends; a job it schedules needs `origin: { deviceId }`), answers
  `{ say?, keepOpen? }`, and **is idempotent by notification id**: after a store failure it may run again for the same
  notification.
- **`ctx.speech.say(target, text, { cue? })`**: one line on a device, a room's devices (`{ room, except? }`: all but one
  device) or everywhere, after whatever is being said there; an empty text with `cue: true` is the chime alone. Inside a turn, never wait for its `done` (it fails `in-turn`); return the spoken answer as the
  tool's result as before.
- `ctx.notify.dnd` reads and sets do not disturb for the house. Nothing may send above `ring`.

<!-- region: packages/module-contracts/test/kit/notifyExample.test.ts#notify-module -->
```ts
const kettleTexts = defineTexts({
  en: { done: "The kettle has boiled", snooze: "Snooze", snoozed: "I'll remind you in five minutes.", started: "I'll tell you when it has boiled.", failed: "I couldn't set that reminder." },
  nl: { done: "Het water kookt", snooze: "Later", snoozed: "Over vijf minuten zeg ik het nog eens.", started: "Ik zeg het als het water kookt.", failed: "Die herinnering kon ik niet zetten." }
})

export const kettleModule = defineModule({
  apiVersion: 2,
  id: "kettle",
  name: "Kettle",
  description: "Rings when the kettle has boiled.",
  enabledByDefault: false,
  shared: (ctx) =>
    Effect.gen(function*() {
      // The service sends now. A notification for later is a job of the module's own, which sends from its handler
      // (with the origin of the turn that scheduled it: it rings on the device that asked).
      yield* ctx.scheduler.handle("boiled", {
        payload: Schema.Struct({}),
        run: () => {
          const lang = homeLanguage(ctx.host.view())
          return Effect.asVoid(ctx.notify.send({
            title: say(kettleTexts, lang, "done"),
            priority: "ring",
            key: "kettle",
            actions: [{ id: "snooze", label: say(kettleTexts, lang, "snooze") }],
            handler: "kettle"
          }))
        }
      }).pipe(Effect.orDie)
      // An action handler is registered in `shared`, like a job handler: published and withdrawn with the module.
      // While the module is down, its actions answer "I can't do that right now"; `stop` always works. It runs as the
      // press (its device is the origin), after the press claimed the notification; it may run again for the same
      // notification after a store failure, so it does nothing twice (the job's key replaces an earlier one).
      yield* ctx.notify.handle("kettle", {
        run: (press) =>
          Effect.gen(function*() {
            const lang = homeLanguage(ctx.host.view())
            // A job takes a turn's or a job's origin by itself, not a press's: name the device it rings on again.
            yield* ctx.scheduler.schedule({ handler: "boiled", key: "kettle", inMs: 5 * 60_000, origin: { deviceId: press.deviceId } })
            return { say: say(kettleTexts, lang, "snoozed") }
          }).pipe(Effect.orElseSucceed(() => ({ say: say(kettleTexts, homeLanguage(ctx.host.view()), "failed"), keepOpen: true })))
      }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: (ctx) =>
    Effect.succeed({
      tools: [makeTool({
        name: "kettle_watch",
        description: "Ring on this device when the kettle has boiled (in about three minutes).",
        parameters: Schema.Struct({}),
        risk: "change",
        execute: () =>
          Effect.gen(function*() {
            const lang = homeLanguage(ctx.host.view())
            // The module's own job (one transaction): fine on a turn.
            yield* ctx.scheduler.schedule({ handler: "boiled", key: "kettle", inMs: 3 * 60_000 })
            // An announcement in the room, after whatever is being said there. Inside a turn, never wait for `done`.
            yield* ctx.speech.say({ room: "Kitchen" }, say(kettleTexts, lang, "started"), { cue: true })
            return { spoken: say(kettleTexts, lang, "started") }
          }).pipe(
            Effect.catchTag("SchedulerError", () => Effect.succeed({ spoken: say(kettleTexts, homeLanguage(ctx.host.view()), "failed") })),
            // No device in the kitchen, or none that may speak: the ring still comes.
            Effect.catchTag("SpeechError", () => Effect.succeed({ spoken: say(kettleTexts, homeLanguage(ctx.host.view()), "started") }))
          )
      })]
    })
})
```

Its test, through the kit's `notify` handles (what was sent, where it would go and why not, pressing, what was announced):

<!-- region: packages/module-contracts/test/kit/notifyExample.test.ts#notify-test -->
```ts
const kit = yield* startTestModule(kettleModule)
yield* kit.tool("kettle_watch", {}, { device: "kitchen-display" })
// The announcement went to the kitchen's device; nothing rings yet.
yield* kit.advance(2_000)
assert.deepStrictEqual(kit.notify.announced.map((a) => [a.deviceId, a.text]), [["kitchen-display", "I'll tell you when it has boiled."]])
assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
// Three minutes later it rings there, with stop and snooze.
yield* kit.advance(3 * 60_000)
const [ringing] = kit.notify.engine.ringingOn("kitchen-display")
assert.deepStrictEqual(ringing?.actions.map((a) => a.id), ["snooze"])
// Snooze, as a press on the card: the module's handler answers, and it rings again five minutes later.
assert.deepStrictEqual(yield* kit.notify.press(ringing!.id, "snooze", { device: "kitchen-display" }), { ok: true, say: "I'll remind you in five minutes." })
assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
yield* kit.advance(5 * 60_000)
assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
// Why it went where it went: every decision is recorded.
assert.isTrue(kit.notify.decisions.every((d) => d.deviceId === "kitchen-display" && d.decision.deliver))
```

### Presenting (P10)

What a module shows on a device's screen goes through the Presenter, never a module's own message
([PRESENTING.md](PRESENTING.md) has the kinds, their bounds, the decision and what is left out):

- **From a tool or an action**, return `{ forModel, present, show? }`: the model gets `forModel` with a note of what the
  server decided ("Showing on "Kitchen display".", or "Not showing it: … has no display. Say this instead: <your
  `spoken`>"), and the presentation goes to the device the call came from in one enqueue (nothing else on the turn's
  path); once accepted it is written, retried if the store refuses, until it is or no longer applies. An action returns
  `{ say, present }`. A presentation that is not valid or passes a bound is not accepted and the note says why.
- **Speculative tools** (R8): a tool that may run speculatively returns its presentation with its result and never calls
  `ctx.present.show` or dismisses in its run. Its result's presentation is held until the turn is committed (dropped if
  the turn is discarded); a `show` made from inside a turn that is not committed yet is refused `uncommitted`, and
  `update` and `dismiss` there change nothing (`undefined`, `false`).
- **From other code** (a job, a press handler), `ctx.present.show(target, presentation, options?)` answers a handle
  with `update` and `dismiss` (they die with `ModuleStopped` once the part has closed); `target` is `"origin"`, a
  `{ device }` or a `{ room }`.
- Five kinds: `card`, `list` (`bullets` or a `checklist`), `timer` (a countdown to an instant), `image` (an `https:`
  address the server fetches once, with a credit) and `weather`. Every one needs `spoken`: what the model says where
  nothing can be shown. `sensitivity: { personal: id }` is decided per device by the privacy rule.
- **Transient** (default; one at a time per device, 30 s) or **pinned** (a timer's default; up to 8 per device, back
  after a reconnect, until dismissed or its end). A `key` makes it one per module: showing the key again replaces it.
  A transient one goes when the part that made it stops; a pinned one is stored and stays.
- **Ticks and buttons reach a press handler registered in `shared`** with `ctx.present.handle(name, { run })`, like
  notification action handlers: claimed first (one press at a time), as the press (its device is the origin), within
  5 s; while your module is down they answer "I can't do that right now". A press is not a tool call, but the risk
  policy decides it (§4: the handler's `risk`, absent `change`; a refusal answers with the policy's sentence and the
  handler does not run; what the handler calls through the gateway is decided there too), and what the handler committed before
  a failure or its time limit stays. The handler shows the change; the press itself changes nothing. A handle acts only
  on its own show: after the same key is shown again, its `update` answers `undefined` and its `dismiss` `false`.

<!-- region: packages/module-contracts/test/kit/presentExample.test.ts#present-module -->
```ts
const errandTexts = defineTexts({
  en: { title: "Errands", spoken: "Your errands: {list}.", ticked: "Ticked off.", unticked: "Back on the list.", none: "nothing" },
  nl: { title: "Boodschappen", spoken: "Je boodschappen: {list}.", ticked: "Afgevinkt.", unticked: "Weer op de lijst.", none: "niets" }
})

const Errand = Schema.Struct({ id: Schema.String, text: Schema.String, done: Schema.Boolean })
const errands = defineCollection({ name: "errands", scope: "household", schema: Schema.Struct({ items: Schema.Array(Errand) }), maxChars: 4_000 })
const START = [{ id: "bread", text: "Bread", done: false }, { id: "stamps", text: "Stamps", done: false }]

export const errandsModule = defineModule({
  apiVersion: 2,
  id: "errands",
  name: "Errands",
  description: "Shows the household's errands as a checklist.",
  enabledByDefault: false,
  storage: { version: 1, collections: [errands] },
  shared: (ctx) =>
    Effect.gen(function*() {
      const list = ctx.store.collection(errands)
      // A press handler is registered in `shared`, like a job handler: published and withdrawn with the module. A tick
      // arrives as the press (which device, which item, ticked or not); the module changes its own data and shows the
      // list again by its key, which replaces it in place on every page that holds it.
      yield* ctx.present.handle("errands", {
        run: (press) =>
          Effect.gen(function*() {
            const lang = homeLanguage(ctx.host.view())
            const row = yield* list.get("list")
            const items = (row?.value.items ?? START).map((i) => (i.id === press.item ? { ...i, done: press.done === true } : i))
            yield* row === undefined ? list.insert({ items }, { id: "list" }) : list.update("list", () => ({ items }))
            yield* ctx.present.show({ device: press.deviceId }, errandList(lang, items), { lifetime: "pinned", key: "errands" })
            return { say: say(errandTexts, lang, press.done === true ? "ticked" : "unticked") }
          })
      }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: (ctx) =>
    Effect.succeed({
      tools: [makeTool({
        name: "errands_show",
        description: "Show the household's errands on this device's screen.",
        parameters: Schema.Struct({}),
        speculative: true,
        execute: () =>
          Effect.gen(function*() {
            const lang = homeLanguage(ctx.host.view())
            const row = yield* ctx.store.collection(errands).get("list").pipe(Effect.orElseSucceed(() => undefined))
            const items = row?.value.items ?? START
            // The model gets `forModel` and a note of what the server did; the list goes to the Presenter in one enqueue.
            return { forModel: { open: items.filter((i) => !i.done).map((i) => i.text) }, present: errandList(lang, items), show: { lifetime: "pinned" as const, key: "errands" } }
          })
      })]
    })
})

/** The checklist; `spoken` is what the model says where nothing can be shown. */
const errandList = (lang: "en" | "nl", items: ReadonlyArray<typeof Errand.Type>): Presentation => {
  const open = items.filter((i) => !i.done).map((i) => i.text)
  return {
    kind: "list",
    title: say(errandTexts, lang, "title"),
    style: "checklist",
    items,
    spoken: say(errandTexts, lang, "spoken", { list: open.length === 0 ? say(errandTexts, lang, "none") : open.join(", ") }),
    handler: "errands"
  }
}
```

Its test, through the kit's `present` handles (what each page holds, a press as a page's, every decision):

<!-- region: packages/module-contracts/test/kit/presentExample.test.ts#present-test -->
```ts
const kit = yield* startTestModule(errandsModule)
const shown = yield* kit.tool("errands_show", {}, { device: "kitchen-display" })
// The model gets what the tool returned for it, and the note of what the server did.
assert.strictEqual(shown.content, "{\"open\":[\"Bread\",\"Stamps\"]}\n[Screen: Showing on \"Kitchen display\".]")
yield* kit.present.settle
const [list] = kit.present.shown("kitchen-display")
assert.strictEqual(list?.content.kind, "list")
assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
// A tick, as the kitchen page's checkbox: the handler runs as the press and shows the list again by its key.
assert.deepStrictEqual(yield* kit.present.press(list!.id, "tick", { device: "kitchen-display", item: "bread", done: true }), { ok: true, say: "Ticked off." })
const [again] = kit.present.shown("kitchen-display")
assert.strictEqual(again?.id, list!.id)
assert.deepStrictEqual(again?.content.kind === "list" ? again.content.items.map((i) => i.done) : [], [true, false])
// From a page that does not hold it: refused, nothing changes.
assert.deepStrictEqual(yield* kit.present.press(list!.id, "tick", { device: "hall-screen", item: "stamps", done: true }), { ok: false, say: "I can't do that right now.", code: "unknown" })
// It is pinned: a page that goes and comes back gets it again.
yield* kit.notify.disconnect("kitchen-display")
yield* kit.notify.connect("kitchen-display")
assert.deepStrictEqual(kit.present.shown("kitchen-display").map((p) => p.id), [list!.id])
// Every decision is recorded: where it showed, and why not.
assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "kitchen-display" && d.decision.show))
```

**One line or stored text.** `StoredText(n)` bounds a stored text and keeps its JSON cost at 2 a character; it allows
tab, line feed, carriage return, backspace and form feed. Where a value must be **one line** (a name, a list item, a
route's field), check that separately: `isLine(text, n)` from `@pva/module-contracts`, the core's own one-line rule
(`NOT_ONE_LINE`: no control character, C0, DEL or C1, no line or paragraph separator, no bidirectional control) with a
bound and no lone surrogates, as a filter on the schema (the reference module's `pinboard_pin` text) or in code.

### Phrase commands (P7)

An action can be said **without the language model**: give it `phrases` per language, words and `{param}` slots
([PHRASES.md](PHRASES.md) has the rules, the bounds and what is left out). After the wake phrase (or in a follow-up
window, or on a device whose assistant answers without a phrase), an utterance that is one of the phrases of the
household's language runs the action through the gateway as a `phrase` turn of that device, and its `say` is spoken as
a canned reply: the utterance never becomes a turn and nothing of it enters the history. Words are matched exactly (case,
accents and punctuation aside); a slot is a number, a duration, a fixed choice (at most 32 options and 96 names of at most 40 characters) or text, read from the
characters said by its parameter's own parser, and one that does not read means no match (a parameter whose options
come from a callback cannot be a slot: take it as text and resolve it in `run`). A parameter the phrase leaves out gets
its default, as on every path. The longest phrase wins. The host's essential controls ("stop", "never mind", "repeat", "louder", "quieter", with their
variants, in both languages) are reserved: a phrase of yours that is one of them refuses your module's start, like any
phrase outside the bounds (8 a language, 8 words, 2 slots with a word between them, every required parameter a slot).
Two modules with the same phrase for one assistant are both left out for it and named on the Health page.

<!-- region: packages/module-contracts/test/kit/phraseExample.test.ts#phrase-module -->
```ts
const lampTexts = defineTexts({
  en: { on: "The {room} lamp is on.", off: "The {room} lamp is off." },
  nl: { on: "De lamp in de {room} is aan.", off: "De lamp in de {room} is uit." }
})
const rooms = [{ value: "kitchen", label: "kitchen", aliases: ["keuken"] }, { value: "hall", label: "hall", aliases: ["gang"] }]

export const lampModule = defineModule({
  apiVersion: 2,
  id: "lamp",
  name: "Lamp",
  description: "Switches a room's lamp.",
  enabledByDefault: false,
  start: (ctx) =>
    Effect.succeed({
      actions: [defineAction({
        id: "switch",
        label: "Switch a lamp",
        description: "Switch the lamp in a room on or off.",
        examples: ["kitchen lamp on", "lamp uit in de keuken"],
        params: {
          // A slot reads a fixed choice (at most 32 options, prepared when the set is built), a number, a duration or text;
          // never a list the module fills while it runs (take such a name as text and resolve it in `run`).
          room: Param.choice({ label: "Room", options: rooms }),
          to: Param.choice({ label: "On or off", options: [{ value: "on", label: "on", aliases: ["aan"] }, { value: "off", label: "off", aliases: ["uit"] }] })
        },
        // Said after the wake phrase (or in a follow-up window), these run the action with no model call. Words are
        // matched exactly; each slot is read by its parameter's parser (a room by value, name or alias, on/off by label).
        phrases: { en: ["{room} lamp {to}", "turn the {room} lamp {to}"], nl: ["lamp {to} in de {room}"] },
        risk: "change",
        run: ({ room, to }) =>
          Effect.succeed({ say: say(lampTexts, homeLanguage(ctx.host.view()), to, { room: rooms.find((r) => r.value === room)?.label ?? room }) })
      })]
    })
})
```

Its test, through the kit's `phrases` handle (the real decision, matcher and gateway):

<!-- region: packages/module-contracts/test/kit/phraseExample.test.ts#phrase-test -->
```ts
const kit = yield* startTestModule(lampModule)
// As the recogniser's final after "hey Jeff": the kit decides as serve mode does, and runs it through the gateway.
const said = yield* kit.phrases.say("Turn the kitchen lamp on.", { device: "kitchen-display" })
assert.isTrue(said.taken)
assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["The kitchen lamp is on."])
// Words that are not one of its phrases are not taken: they go on to the assistant as a turn.
assert.deepStrictEqual(yield* kit.phrases.say("is the kitchen lamp on?"), { taken: false })
// The host's controls are there for every assistant, whatever modules it has.
const louder = yield* kit.phrases.say("louder")
assert.isTrue(louder.taken && louder.by === "control")
```

- **Keep the answer short** (300 characters at most are spoken) and return within 5 s; start anything longer in `shared`.
- **Over a reply**: a phrase said while a reply plays cuts it off; after your answer the reply is said again, unless the
  action is declared `endsReply: true`.
- **Ringing**: while one of your notifications rings, its buttons' labels are accepted without the wake phrase (the
  ringing window): label a button with what people will say ("Snooze").
- **While your module is down** its phrases are in nobody's set: they go on to the assistant as before. Withdrawn
  between the decision and the run: "I can't do that right now.", and nothing ran.

## 17. Testing: the kit and checkModule

Tests never reach the network and leave nothing on disk. The kit is `@pva/core/testing`; run tests inside `it.effect`
(the test clock).

**`startTestModule(definition, options)`** starts your module in the **real** module host, as serve mode runs it: the
real execution gateway with serve mode's checks and risk policy, the real scheduler engine on the in-memory household
store, and the core's `Privacy` rule over a test household that is **fixed for the test**. The default household: Sam,
Robin and Alex; a shared kitchen display whose default person is Sam, Robin's private phone, a public hall screen
(Alex is nobody's default person); the assistant `jeff` on all three; English, Amsterdam; the clock at Wednesday 18
November 2026, 10:00 in Amsterdam. Settings linked to Home (Clock's zone and locale, Weather's place and units) get
their defaults from the household's Home values exactly as in serve mode (`linkedModuleDefaults`), under saved values
and an assistant's own. Options: `settings`, `secrets`, `provide` (stubs of other modules' services, and
contributions), `others` (real modules beside it), `household` (people with their diets as the server keeps them,
devices with their privacy and default person, assistants with their module choices, `offTools` and own values, Home
values), `startAt`, `started`. It returns handles:

| Handle | What it does |
|---|---|
| `tool(name, input, as?)` | a tool call as the model's tool loop makes it, through the assistant's registry and the gateway, as a turn (`{ device, assistant, person, source }` resolved against the household, or a whole `TurnContext`, checked as serve mode checks it); answers `{ ok, content, value }` as the model gets it. A tool the assistant switched off is called too, and the gateway refuses it |
| `action(id, params, as?)` | an action through `host.actions.run` (as a routine step runs it) |
| `asTurn(effect, as?)`, `turn(as?)` | run code as a turn (to call a service directly); the `CurrentTurn` the kit makes (with its device's connection) |
| `jobs`, `runJob(id)`, `advance(ms)`, `now` | every job of the module, live and finished (the whole list is read, however many jobs other modules have); move the test clock and let the scheduler run what came due, through the gateway with each job's origin |
| `service(Key)`, `contributions(Key, as?)` | what is published now, as a turn's assistant sees it |
| `stop`, `start`, `restart`, `configure(values, secrets?)` | switched off for every assistant, on again; one real restart of the module with its demand kept (the same host and store: not a restart of the server); a settings change as the owner saves it |
| `info()`, `issues()`, `checkHealth`, `toolNames(as?)` | the admin page's view of it, its Health issues (health run now), the tools the turn's model is sent: as serve mode offers them, without the tools and action tools the assistant switched off and those the risk policy refuses |
| `riskPolicy()`, `setRiskPolicy(p)`, `riskDecisions()` | P8: the household's risk policy now (start with `household.risk`), a save of another (through serve mode's decoder: `money` and `security` stay refused; it applies to the next call and list), every decision so far on every path (§4) |
| `expectNoSecrets(...values)` | fails when the value of a secret given to the kit is in any string of the `values` you pass (tool results, action outcomes, spoken lines, **the rows your test read**), decoded: every key and string, and a string that is JSON parsed and walked too, so an escaped secret is found; it also looks at every event and the admin page. It reads no collection itself: pass it the rows your module wrote |
| `phrases` | P7: `say(text, { device, assistant, wake?, interrupting?, interruptedBy?, cancelled? })` as the recogniser's final after the wake phrase (or without it, where only the ringing window can take it), `decide` / `run` (Effects: a test may change something between them), `spoken`, `answered`, `traces`, `replied`, `volume`, `volumeSends`, `commandsFor` (an Effect: the set once prepared), `sessionCalls`; the module also gets the kit's `SessionControl` and `DeviceControl` ([PHRASES.md](PHRASES.md) "Testing") |
| `notify` | P9: the real notification service: `all`, `messages` (what each page was sent), `decisions` (where it would go, and why not), `press(id, action, { device })`, `announced`, `replying(device, on)`, `connect` / `disconnect`, `dnd()`, `settle`, `engine` ([NOTIFICATIONS.md](NOTIFICATIONS.md) "Testing") |
| `moduleStore()`, `store`, `events`, `people`, `schedulerUses` | the module's store, the household store, every event on the bus, the household's core services, what the kit saw of the scheduler |

**Where the kit waits on your module's code** (the start, with every module of `others`; `stop`, `start`, `restart`,
`configure`, `checkHealth`; and stopping everything when the test's scope closes) **it drives the test clock** from one
pending timer to the next until the wait is over, so a cleanup that sleeps or a start that never answers runs into the
host's own limits as it would in serve mode. After `KIT_WAIT_CAP_MS` (10 minutes) of test-clock time it fails the test
naming what did not finish; it never hangs. Before each move it gives real work a few milliseconds of real time; a
start that waits longer on real work (a large dynamic `import`) can meet the host's 10 s limit in test-clock time, so
a test imports such a library once before it starts the kit. `advance(ms)` moves the clock by exactly `ms`.

**A stub called without a programmed answer fails the test**, whatever your module did with the error: the kit checks
after the start, after each `tool`, `action`, `asTurn`, `contributions`, `advance`, `runJob`, `stop`, `start`,
`restart`, `configure` and `checkHealth`, and when the test's scope closes (a call from a background fiber). A test that
calls a stub directly and expects the throw takes the record itself (`takeUnprogrammedStubCalls()`); a kit started while
such a record is left fails at once.

Also: `makeTestTurn` (a synthetic turn from its input alone: no person, room or device name unless given; use
`kit.turn()` for a turn of the household, and give each turn of a multi-turn test its own `turnId` and
`conversationId`), `makeTestPeople`, `testConnectionOf`, `dietProblem`, `provide(moduleId, { services, contributions
})`, `stubService(name, answers)` with `succeeds`, `fails`, `stops` and `returns`, `makeOfflineNet(fixtures, { lan })`
(§12; its `requests` record each request's method and a POST's body), `expectOffByDefault(catalog)`.

<!-- region: packages/module-contracts/test/kit/pinboard.test.ts#turns -->
```ts
it.effect("a personal note is read where the privacy rule allows it, and withheld elsewhere", () =>
  Effect.gen(function*() {
    const board = yield* startTestModule(pinboardModule)
    // Sam, at the shared kitchen display whose default person is Sam (the default test household).
    const pinned = yield* board.tool("pinboard_pin", { text: "Dentist at 3", forMe: true }, { device: "kitchen-display" })
    assert.deepStrictEqual(pinned.value, { spoken: "Pinned: Dentist at 3." })
    yield* board.advance(60_000)
    // Robin, on Robin's private phone.
    yield* board.tool("pinboard_pin", { text: "Call the vet", forMe: true }, { device: "robins-phone" })
    yield* board.advance(60_000)
    yield* board.tool("pinboard_pin", { text: "Bins out tonight" }, { device: "kitchen-display" })

    // The kitchen display is shared and Sam's: Sam's note, not Robin's.
    const kitchen = yield* board.tool("pinboard_read", {}, { device: "kitchen-display" })
    assert.deepStrictEqual(kitchen.value, { notes: ["Bins out tonight", "Dentist at 3"], more: 0, withheld: "1 personal notes are not read out here.", owner: "p-sam" })
    // A public hall screen: the household note only, and a sentence about what was left out.
    const hall = yield* board.tool("pinboard_read", {}, { device: "hall-screen" })
    assert.deepStrictEqual(hall.value, { notes: ["Bins out tonight"], more: 0, withheld: "2 personal notes are not read out here." })
    // Robin's private phone: a private device may be told any member's personal content.
    const phone = yield* board.tool("pinboard_read", {}, { device: "robins-phone" })
    assert.deepStrictEqual((phone.value as { notes: Array<string> }).notes, ["Bins out tonight", "Call the vet", "Dentist at 3"])
  }))
```

<!-- region: packages/module-contracts/test/kit/pinboard.test.ts#whose -->
```ts
it.effect("a note for 'me' when nobody known is asking: it asks whose, and writes nothing", () =>
  Effect.gen(function*() {
    const board = yield* startTestModule(pinboardModule)
    const asked = yield* board.tool("pinboard_pin", { text: "Private appointment", forMe: true }, { device: "hall-screen" })
    assert.deepStrictEqual(asked.value, { spoken: "Who is the note for? I can't tell who is asking here." })
    assert.notInclude(asked.content, "Private appointment")
    assert.deepStrictEqual(yield* board.moduleStore().collection(notes).list({}), [])
  }))
```

<!-- region: packages/module-contracts/test/kit/pinboard.test.ts#job -->
```ts
/** The module with what each of its job handlers sees as `CurrentJob` while it runs, recorded (a test's own wrapper). */
const recordingJobs = (seen: Array<JobOrigin | undefined>): typeof pinboardModule => ({
  ...pinboardModule,
  shared: (ctx) =>
    pinboardModule.shared!({
      ...ctx,
      scheduler: {
        ...ctx.scheduler,
        handle: (name, handler) =>
          ctx.scheduler.handle(name, { ...handler, run: (payload, due) => Effect.andThen(Effect.flatMap(CurrentJob, (job) => Effect.sync(() => void seen.push(job))), handler.run(payload, due)) })
      }
    })
})

it.effect("a note pinned for some hours: the note and its job in one transaction; the job runs with the turn's origin", () =>
  Effect.gen(function*() {
    const seen: Array<JobOrigin | undefined> = []
    const board = yield* startTestModule(recordingJobs(seen))
    const r = yield* board.tool("pinboard_pin", { text: "Oven is hot", forMe: true, hours: 2 }, { device: "kitchen-display" })
    assert.deepStrictEqual(r.value, { spoken: "Pinned for 2 hours: Oven is hot." })
    const [note] = yield* board.moduleStore().collection(notes).list({})
    const job = (yield* board.jobs).find((j) => j.handler === "unpin")!
    assert.deepStrictEqual(job.payload, { id: note!.id })
    // Its origin is the turn that scheduled it: the assistant, the device and the person.
    assert.strictEqual(job.origin.assistantId, "jeff")
    assert.strictEqual(job.origin.deviceId, "kitchen-display")
    assert.strictEqual(job.origin.person?.id, "p-sam")
    // It outlives a restart of the module, and then takes the note down as the job.
    yield* board.restart
    yield* board.runJob(job.id)
    assert.deepStrictEqual(yield* board.moduleStore().collection(notes).list({}), [])
    const removed = board.events.find((e) => e.type === "pinboard.notes.changed" && e.actor?.kind === "job")
    assert.deepStrictEqual(removed?.actor, { kind: "job", jobId: job.id })
    // What the handler saw as it ran, after the restart: the turn's assistant, device and person.
    const ran = seen.filter((j) => j?.jobId === job.id)
    assert.strictEqual(ran.length, 1)
    assert.strictEqual(ran[0]?.assistantId, "jeff")
    assert.strictEqual(ran[0]?.deviceId, "kitchen-display")
    assert.strictEqual(ran[0]?.person?.id, "p-sam")
  }))

it.effect("the daily job takes down notes older than the setting, at 04:00", () =>
  Effect.gen(function*() {
    const board = yield* startTestModule(pinboardModule, { settings: { keepDays: 1 } })
    const job = (yield* board.jobs).find((j) => j.handler === "expire")
    assert.strictEqual(job?.cron, "0 4 * * *")
    const store = board.moduleStore().collection(notes)
    const now = yield* board.now
    yield* store.insert({ text: "stale", whose: "household", pinnedAt: now - 2 * 86_400_000 })
    yield* store.insert({ text: "fresh", whose: "household", pinnedAt: now })
    yield* board.runJob(job!.id)
    assert.deepStrictEqual((yield* store.list({})).map((r) => r.value.text), ["fresh"])
  }))
```

<!-- region: packages/module-contracts/test/kit/pinboard.test.ts#secrets -->
```ts
it.effect("health says when there is no printer key, and no result, spoken line or stored row holds the key", () =>
  Effect.gen(function*() {
    const plain = yield* startTestModule(pinboardModule)
    assert.deepStrictEqual((yield* plain.checkHealth).map((i) => i.id), ["pinboard.no-printer-key"])
    const board = yield* startTestModule(pinboardModule, { secrets: { printerKey: "printer-k3y-for-tests" } })
    assert.deepStrictEqual(yield* board.checkHealth, [])
    const pinned = yield* board.tool("pinboard_pin", { text: "Keep me" })
    const read = yield* board.tool("pinboard_read", {})
    const cleared = yield* board.action("clear")
    // The kit reads no collection itself: the test passes the rows its module wrote.
    const rows = yield* board.moduleStore().collection(notes).list({})
    yield* board.expectNoSecrets(pinned, read, cleared, rows)
  }))
```

**`checkModule(definition, { settings?, secrets?, texts?, provide?, others?, household? })`**, which every module's test
calls, starts the module through the kit and fails with every rule it breaks, each named with its place. It checks the
definition, the start, and what the module declares and does **while it starts**, for every instance the household's
assistants make; it runs no tool, action or job:

| Rule | Fails when |
|---|---|
| `api-version` | the module does not declare `apiVersion: 2` |
| `off-by-default` | a new module is on before the owner chose (`enabledByDefault` not `false`) |
| `form` | its described settings form does not encode with the wire's schema, or exceeds 8 KiB |
| `start` | it does not start in the real host with the given settings and secrets (the host also refuses a tool name providers refuse, a name used twice, and an action whose generated tool name is over 64 characters) |
| `secret` | a secret's value is in a status line, an error, the form, a Health issue, a tool's name or description, an action's text, instructions or a context provider's name |
| `risk` | a tool or action that is not a plain read (`speculative: true`) declares no risk class |
| `risk-said` | one that can be `money` or `security` (which the risk policy refuses) does not say so in its description |
| `tool-name` | a tool's name, or an action's generated `<moduleId>_<actionId>`, is not 1–64 of `[A-Za-z0-9_-]`, or is used twice in one instance |
| `tool-description` | a tool's description, or an action's generated tool's (its label first), is empty or over 1,024 characters |
| `tool-parameters` | a tool's or an action's generated tool's parameters are not sent as an object schema, or a property name is outside 1–64 of `[A-Za-z0-9_.-]` |
| `action-examples` | an action declares no `examples` |
| `collection` | the store's own declaration check (`defineCollection`, and `prepare` on an empty store) refuses a collection it declares |
| `stored-value` | a collection's worst legal value is longer than its `maxChars`, or has no bound |
| `scheduler-shared` | a job handler is registered in `start` instead of `shared` |
| `scheduler-refused` | a `schedule`, `prepare` or `reschedule` it made while starting was refused by the real engine (a cron or its time zone, a payload, a limit), reported with the engine's reason |
| `health` | it requires the network and declares no `health`, or its `health()` fails or does not answer in time |
| `texts` | its texts differ between English and Dutch in keys or in the placeholder names they use, or one is empty or not one line |

<!-- region: packages/module-contracts/test/kit/pinboard.test.ts#check -->
```ts
it.effect("passes the conformance check, with its texts in both languages", () => checkModule(pinboardModule, { texts }))
```

**What your tests must cover**, because `checkModule` cannot see it: what each tool and action answers, in both
languages, and its failure paths; privacy on each kind of device (a private one, a shared one that is the owner's and
one that is not, a public one, a public one with a default person, a shared one without a default person); that a
personal request without a person asks whose and writes nothing; a row with **every indexed field at its largest**,
written and stored (the store judges indexed values only then); the jobs your tools schedule (the scheduler refuses a
payload that does not fit, so test the path), their origin as the handler sees it (`CurrentJob`, as the reference
module's job test records it), their late rule, and a job called off while it runs; a restart in the middle; a
provider that is off or stops; and that no tool result, spoken line or stored row holds a secret (`expectNoSecrets`,
given the results and the rows your test read). The secret scan of `checkModule` sees only what the module declares
(above) and secrets of four characters or more, exactly as given. Run your package's tests and `pnpm
check` behind the shared lock (`flock /workspace/build-cache/ian/pva-heavy.lock …`, `VITEST_MAX_WORKERS=4`).

## 18. What a module pull request may touch

- Its own package (§19) under `packages/module-<pkg>/` (source, tests, `package.json`).
- **Its own pages, `docs/modules/<id>.md`** (one per module id), filled in under the stub's headings: what it does, its
  tools, settings, what it stores, what it needs, and what was left out. Notifications and a module's speech exist
  since P9, phrase commands (`phrases` on an action), the host's controls and the ringing window since P7 (§16,
  [PHRASES.md](PHRASES.md)), and presentations since P10 (§16, [PRESENTING.md](PRESENTING.md)): build those parts of
  your row now, within their first version (a slot is a number, a duration, a fixed choice or text; a presentation is
  one of the five kinds). **"Left out" lists every part of your row that needs what is not there yet** (the list at the
  top of this page). This replaces the plan's "own section in `docs/MODULES.md`", so twenty pull
  requests never edit the same file.
- `pnpm-lock.yaml`, only when it adds a dependency the scaffold did not foresee; the description names it.
- **Nothing else.** The scaffold has created the package, registered it in the catalogue, added the dependencies of
  Appendix A and defined the contracts it shares. If the core lacks something the module needs, stop and report it
  instead of editing shared files.
- **The packages with more than one module**: one pull request owns each. `module-core-tools` holds `calculator`,
  `knowledge` and `system-status` (the core-tools PR); `module-timers` holds `timers` and `alarms` (wave B);
  `module-local-info` holds `bin-day` (the local-info PR).
- **Two pull requests reach into `packages/modules-builtin`**, and only into their own files: core-tools changes
  `src/clock.ts` and adds new files only under `src/clock/`, exported from `clock.ts`, with `docs/modules/clock.md`;
  local-info changes `src/weather.ts` and adds new files only under `src/weather/`, exported from `weather.ts`, with
  `docs/modules/weather.md`. `index.ts` and `package.json` are ready (`index.ts` re-exports all of `clock.ts` and
  `weather.ts`); nobody adds other shared files there. Smart-home owns all of `packages/module-home-assistant/`.
- **Libraries.** A provider SDK is imported only inside its adapter package, and a module's libraries only inside its
  own package. Import a large library (`pdfjs-dist`, `mathjs`, `linkedom`, `date-holidays`) where it is used, with
  `await import(…)` inside `shared` or a tool, not at the top of `src/index.ts`, so the app's start does not load it
  for a module that is off.

## 19. The modules

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
| Calendar (ICS) | `module-calendar` | A | [calendar](modules/calendar.md) |
| Memory and notes | `module-memory` | A | [memory](modules/memory.md) |
| Broadcast | `module-broadcast` | B | [broadcast](modules/broadcast.md) |
| Briefing | `module-briefing` | A | [briefing](modules/briefing.md) |
| Local info | `module-local-info`, `modules-builtin` (weather) | A | [bin-day](modules/bin-day.md), [weather](modules/weather.md) |
| Presence | `module-presence` | A | [presence](modules/presence.md) |
| News and feeds | `module-news` | A | [news](modules/news.md) |
| Routines | `module-routines` | B | [routines](modules/routines.md) |

Wave A is written on this scaffold now; wave B after the first versions of P7 to P10 (notifications, phrase commands,
presentation, the risk policy in admin), with the parts of wave A that needed them. Later, with their own plan: the
MCP client, Google, T3 Code, calls and intercom, and CalDAV in the calendar module.
