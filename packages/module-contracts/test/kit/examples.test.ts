// Two more pieces docs/MODULES.md quotes, compiled and run: a settings form with the extended fields and nested
// configuration as validated JSON text; and a spoken recurrence kept as an RRULE with one job for its next occurrence.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection, defineModule, makeTool, MAX_LIVE_JOBS, type PreparedJob, type Row, type SchedulerError, Setting, ToolError } from "@pva/core"
import { checkModule, startTestModule } from "@pva/core/testing"
import { nextOccurrence, parseRecurrence } from "@pva/language"
import { Clock, Effect, Exit, Option, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { defineTexts, homeLanguage, say, StoredText } from "../../src/index.ts"

// #region settings-form
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
// #endregion settings-form

const formModule = defineModule({
  apiVersion: 2,
  id: "form-example",
  name: "Form example",
  description: "A form with every kind of field.",
  enabledByDefault: false,
  settings: formSettings,
  fieldActions: { test: ({ settings }) => Effect.succeed({ ok: settings.baseUrl !== "", text: settings.baseUrl === "" ? "Set an address first." : "Reachable." }) },
  start: () => Effect.succeed({})
})

// #region recurrence
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
// #endregion recurrence

describe("examples of docs/MODULES.md", () => {
  it.effect("the form: every field kind, a JSON text field explained on error, a Test button", () =>
    Effect.gen(function*() {
      yield* checkModule(formModule)
      assert.strictEqual(explainSteps("[{\"say\":\"Good morning\"},{\"action\":\"lights.on\"}]"), undefined)
      assert.match(explainSteps("{\"say\": 1}") ?? "", /JSON list/)
      const kit = yield* startTestModule(formModule, { settings: { baseUrl: "http://searx.lan:8080" } })
      assert.deepStrictEqual(yield* kit.host.fieldAction("form-example", "test"), { ok: true, result: { ok: true, text: "Reachable." } })
    }))

  it.effect("a spoken recurrence: the RRULE in the module's row, one job for the next occurrence, planned again by its handler", () =>
    Effect.gen(function*() {
      yield* checkModule(nagModule, { texts: nagTexts })
      const kit = yield* startTestModule(nagModule)
      // Wednesday 18 November 2026, 10:00 in Amsterdam.
      const r = yield* kit.tool("nag_every", { text: "Bins out", when: "every Tuesday at half seven" })
      const first = (r.value as { first: number }).first
      assert.strictEqual(new Date(first).toISOString(), "2026-11-24T06:30:00.000Z") // 07:30 in Amsterdam
      const [job] = yield* kit.jobs
      assert.strictEqual(job?.dueAt, first)
      yield* kit.runJob(job!.id)
      const [next] = (yield* kit.jobs).filter((j) => j.state === "scheduled")
      assert.strictEqual(new Date(next!.dueAt).toISOString(), "2026-12-01T06:30:00.000Z")
    }))

  it.effect("an outage over an occurrence: the handler still runs when the module is back, and plans the next one", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(nagModule)
      const r = yield* kit.tool("nag_every", { text: "Bins out", when: "every Tuesday at half seven" })
      const first = (r.value as { first: number }).first
      yield* kit.stop
      yield* kit.advance(first + 16 * 60_000 - (yield* kit.now))
      yield* kit.start
      yield* kit.advance(0)
      const live = (yield* kit.jobs).filter((j) => j.state === "scheduled")
      assert.deepStrictEqual(live.map((j) => new Date(j.dueAt).toISOString()), ["2026-12-01T06:30:00.000Z"])
    }))

  it.effect("the rule and its first job are written together: at the job limit neither is", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(nagModule)
      for (let i = 0; i < MAX_LIVE_JOBS; i++) assert.isTrue((yield* kit.tool("nag_every", { text: `Line ${i}`, when: "every Tuesday at half seven" })).ok)
      const refused = yield* kit.tool("nag_every", { text: "One too many", when: "every Tuesday at half seven" })
      assert.isFalse(refused.ok)
      assert.strictEqual(refused.content, "I couldn't save that.")
      // Every stored rule has its job: 200 of each, none for the refused one.
      let count = 0
      let after: Row<typeof Rule.Type> | undefined
      for (;;) {
        const page = yield* kit.moduleStore().collection(rules).list({ limit: 20, ...(after !== undefined ? { after } : {}) })
        count += page.length
        assert.isFalse(page.some((r) => r.value.text === "One too many"))
        if (page.length < 20) break
        after = page.at(-1)
      }
      assert.strictEqual((yield* kit.jobs).filter((j) => j.state === "scheduled").length, MAX_LIVE_JOBS)
      assert.strictEqual(count, MAX_LIVE_JOBS)
    }))

  it.effect("the Home section's default zone (empty: this machine's) is understood; a Dutch household is answered in Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(nagModule, { household: { home: { HOME_TIME_ZONE: "" } } })
      assert.strictEqual(((yield* kit.tool("nag_every", { text: "Bins out", when: "every Tuesday at half seven" })).value as { spoken: string }).spoken, "Every time: Bins out.")
      const dutch = yield* startTestModule(nagModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual((yield* dutch.tool("nag_every", { text: "Vuilnis", when: "zo nu en dan" })).value, { spoken: "Wanneer precies? Ik begreep niet wanneer." })
      assert.strictEqual(((yield* dutch.tool("nag_every", { text: "Vuilnis", when: "elke dinsdag om half acht" })).value as { spoken: string }).spoken, "Elke keer: Vuilnis.")
    }))
})
