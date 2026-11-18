// Two more pieces docs/MODULES.md quotes, compiled and run: a settings form with the extended fields and nested
// configuration as validated JSON text; and a spoken recurrence kept as an RRULE with one job for its next occurrence.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection, defineModule, makeTool, Setting, ToolError } from "@pva/core"
import { checkModule, startTestModule } from "@pva/core/testing"
import { nextOccurrence, parseRecurrence } from "@pva/language"
import { Clock, Effect, Exit, Schema } from "effect"
import { homeLanguage, StoredText } from "../../src/index.ts"

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
      yield* checkModule(nagModule)
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
})
