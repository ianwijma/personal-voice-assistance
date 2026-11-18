import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { CHOICE_KINDS, makeHomeAssistantClient, targetIndex } from "../src/index.ts"
import { readHouse } from "../src/inventory.ts"

/**
 * Opt-in test against a real Home Assistant. Skipped unless both are set:
 *
 *   HOME_ASSISTANT_URL=http://homeassistant.local:8123 HOME_ASSISTANT_TOKEN=... \
 *     pnpm --filter @pva/module-home-assistant exec vitest run test/live.test.ts --silent=false
 *
 * Read-only by default: it reads the house page by page with the module's template and prints the rooms and the names
 * of each kind's target, with the time the reads took. It switches something only when HOME_ASSISTANT_LIVE_TOGGLE names one
 * light entity (e.g. light.desk_lamp): that light is toggled and then put back. It runs the client and the decoder
 * directly (real time), not the test kit (whose clock is a test clock).
 */
const url = process.env.HOME_ASSISTANT_URL
const token = process.env.HOME_ASSISTANT_TOKEN
const toggle = process.env.HOME_ASSISTANT_LIVE_TOGGLE

describe.skipIf(url === undefined || url === "" || token === undefined || token === "")("home-assistant (live)", () => {
  it.live("reads the house with the module's template, and toggles only the named light", () =>
    Effect.gen(function*() {
      const client = makeHomeAssistantClient({ baseUrl: url!, token: token!, timeoutMs: 3000 })
      const t0 = performance.now()
      const config = yield* client.config()
      const t1 = performance.now()
      const { house } = yield* readHouse({ client, secrets: [token!], aliases: "", exposed: new Set(CHOICE_KINDS), limitMs: 10_000, now: Date.now(), temperatureUnit: config.temperatureUnit })
      const t2 = performance.now()
      console.log(`HA ${config.version} (${config.temperatureUnit ?? "unit not read"}): config ${(t1 - t0).toFixed(0)} ms, the house in pages ${(t2 - t1).toFixed(0)} ms`)
      console.log(`${house.areas.length} areas, ${house.entities.length} entities, ${house.leftOut} left out, incomplete: ${[...house.incomplete].join(", ") || "no"}`)
      for (const kind of ["light", "switch", "climate", "cover"] as const) {
        console.log(`${kind}:\n` + targetIndex(house, kind).options.map((t) => `  ${t.value}  "${t.label}"  ${(t.aliases ?? []).join(", ")}`).join("\n"))
      }
      if (toggle !== undefined && toggle !== "") {
        expect(toggle.startsWith("light.")).toBe(true)
        const before = house.byId.get(toggle)?.state
        expect(before).toBeDefined()
        const a0 = performance.now()
        yield* client.callService("light", before === "on" ? "turn_off" : "turn_on", { entity_id: [toggle] })
        const a1 = performance.now()
        yield* Effect.sleep("1500 millis")
        yield* client.callService("light", before === "on" ? "turn_on" : "turn_off", { entity_id: [toggle] })
        console.log(`toggled ${toggle} (was ${before}) in ${(a1 - a0).toFixed(0)} ms, and put it back`)
      }
    }), 30_000)
})
