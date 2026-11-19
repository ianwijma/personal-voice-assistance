// The module started with its presentations recorded (what it asked to show, and for whom) beside what the kit's pages hold.
import { type ModulePresent, type Presentation, type PresentTarget } from "@pva/core"
import { makeOfflineNet, type OfflineFixtures, startTestModule, type TestHouseholdInput } from "@pva/core/testing"
import { Effect } from "effect"
import { calendarModuleWith } from "../src/index.ts"
import { advanceAndRefresh } from "./fixtures.ts"

/** What `start` is given: the host's part context of a version 2 module. */
export type Started = Parameters<NonNullable<ReturnType<typeof calendarModuleWith>["start"]>>[0] & { readonly present: ModulePresent }

export interface Asked {
  readonly target: PresentTarget
  readonly presentation: Presentation
}

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
    const recording = (present: ModulePresent): ModulePresent => ({
      ...present,
      show: (target, presentation, o) => {
        asked.push({ target, presentation })
        return present.show(target, presentation, o)
      }
    })
    const definition = { ...base, start: (ctx: Started) => base.start!({ ...ctx, present: recording(ctx.present) } as never) } as typeof base
    const kit = yield* startTestModule(definition, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      ...(options.household !== undefined ? { household: options.household } : {}),
      ...(options.startAt !== undefined ? { startAt: options.startAt } : {})
    })
    yield* advanceAndRefresh(kit, 0)
    return { kit, asked }
  })
