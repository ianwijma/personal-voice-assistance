import { assert, describe, expect, it } from "@effect/vitest"
import type { ActionDefinition, ExtendedModuleInstance } from "@pva/core"
import { Effect, Exit, Scope } from "effect"
import { homeAssistantModule } from "../src/index.ts"

/**
 * Opt-in test against a real Home Assistant. Skipped unless both are set:
 *
 *   HOME_ASSISTANT_URL=http://homeassistant.local:8123 HOME_ASSISTANT_TOKEN=... \
 *     pnpm --filter @pva/module-home-assistant test test/live.test.ts
 *
 * Read-only by default: it lists areas and lights and reads their state.
 * It switches something only when HOME_ASSISTANT_LIVE_TOGGLE names one light
 * entity (e.g. light.desk_lamp): that light is toggled and then put back.
 */
const url = process.env.HOME_ASSISTANT_URL
const token = process.env.HOME_ASSISTANT_TOKEN
const toggle = process.env.HOME_ASSISTANT_LIVE_TOGGLE

describe.skipIf(url === undefined || url === "" || token === undefined || token === "")("home-assistant (live)", () => {
  it.live("lists areas and lights, reads state, and toggles only the named light", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const statuses: Array<string> = []
      const t0 = performance.now()
      const instance: ExtendedModuleInstance = yield* homeAssistantModule().start({
        settings: { baseUrl: url!, token, domains: ["light"], aliases: "", timeoutMs: 3000 },
        setStatus: (s) => s !== undefined && statuses.push(s.text)
      }).pipe(Scope.provide(scope))
      const startMs = performance.now() - t0
      const find = (id: string): ActionDefinition<any> => instance.actions!.find((a) => a.id === id)!
      const targets = find("lights_on").params.target.options() as ReadonlyArray<{ value: string; label: string; aliases?: ReadonlyArray<string> }>
      console.log(`start ${startMs.toFixed(0)} ms; status: ${statuses.at(-1)}; ${JSON.stringify(instance.info?.())}`)
      console.log("targets:\n" + targets.map((t) => `  ${t.value}  "${t.label}"  ${(t.aliases ?? []).join(", ")}`).join("\n"))

      const s0 = performance.now()
      const status = yield* find("lights_status").run({})
      console.log(`lights_status ${(performance.now() - s0).toFixed(0)} ms: ${JSON.stringify(status)}`)

      if (toggle !== undefined && toggle !== "") {
        assert.isTrue(toggle.startsWith("light."), "HOME_ASSISTANT_LIVE_TOGGLE must be a light entity id")
        assert.isDefined(targets.find((t) => t.value === toggle), `${toggle} is not among the lights`)
        const readState = Effect.promise(async () => {
          const r = await fetch(`${url!.replace(/\/+$/, "")}/api/states/${toggle}`, { headers: { Authorization: `Bearer ${token}` } })
          return ((await r.json()) as { state: string }).state
        })
        const before = yield* readState
        const first = before === "on" ? "lights_off" : "lights_on"
        const second = before === "on" ? "lights_on" : "lights_off"
        const a0 = performance.now()
        yield* find(first).run({ target: toggle })
        const firstMs = performance.now() - a0
        yield* Effect.sleep("1500 millis")
        const middle = yield* readState
        const a1 = performance.now()
        yield* find(second).run({ target: toggle })
        const secondMs = performance.now() - a1
        console.log(`toggled ${toggle}: was ${before}, ${first} ${firstMs.toFixed(0)} ms -> ${middle}, ${second} ${secondMs.toFixed(0)} ms (put back)`)
        expect(middle).not.toBe(before)
      }
      expect(targets.at(-1)?.value).toBe("all")
      yield* Scope.close(scope, Exit.void)
    }), 30_000)
})
