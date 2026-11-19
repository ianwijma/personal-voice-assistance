// The module started with what its tools and actions return to be shown recorded (the structured result: the
// presentation, with `spoken` and its sensitivity), beside what the kit's pages hold.
import { isPresentResult, type Presentation } from "@pva/core"
import { makeOfflineNet, type OfflineFixtures, startTestModule, type TestHouseholdInput } from "@pva/core/testing"
import { Effect } from "effect"
import { calendarModuleWith } from "../src/index.ts"
import { advanceAndRefresh } from "./fixtures.ts"

export interface Asked {
  readonly presentation: Presentation
  /** What the tool returned for the model, or what the action said. */
  readonly answer: unknown
}

type Definition = ReturnType<typeof calendarModuleWith>
export type Started = Parameters<NonNullable<Definition["start"]>>[0]

export const startShown = (
  fixtures: OfflineFixtures,
  options: {
    readonly settings?: Readonly<Record<string, unknown>>
    readonly household?: TestHouseholdInput
    readonly startAt?: number
  } = {}
) =>
  Effect.gen(function*() {
    const net = makeOfflineNet(fixtures)
    const base = calendarModuleWith({ resolver: net.resolver, connector: net.connector })
    const asked: Array<Asked> = []
    let started: { readonly tools: ReadonlyArray<{ readonly name: string; readonly speculative?: boolean }>; readonly actions: ReadonlyArray<{ readonly id: string; readonly speculative?: boolean }> } = { tools: [], actions: [] }
    const record = (value: unknown, answer: (v: unknown) => unknown) => {
      if (isPresentResult(value)) asked.push({ presentation: value.present, answer: answer(value) })
      else if (typeof value === "object" && value !== null && "present" in value) asked.push({ presentation: (value as { present: Presentation }).present, answer: (value as { say?: unknown }).say })
    }
    const definition = {
      ...base,
      start: (ctx: Started) =>
        Effect.map(base.start!(ctx), (s) => {
          started = { tools: s.tools ?? [], actions: s.actions ?? [] }
          return s
        }).pipe(Effect.map((started) => ({
          ...started,
          tools: (started.tools ?? []).map((t) => ({ ...t, execute: (input: never) => Effect.tap(t.execute(input), (v) => Effect.sync(() => record(v, (r) => (r as { forModel: unknown }).forModel))) })),
          actions: (started.actions ?? []).map((a) => ({ ...a, run: (values: never) => Effect.tap(a.run(values), (v) => Effect.sync(() => record(v, () => undefined))) }))
        })))
    } as unknown as Definition
    const kit = yield* startTestModule(definition, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      ...(options.household !== undefined ? { household: options.household } : {}),
      ...(options.startAt !== undefined ? { startAt: options.startAt } : {})
    })
    yield* advanceAndRefresh(kit, 0)
    return { kit, asked, started: () => started }
  })
