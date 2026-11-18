import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { decodeHouse, INVENTORY_TEMPLATE, makeHomeAssistantClient, targetOptions } from "../src/index.ts"

/**
 * Opt-in test against a real Home Assistant. Skipped unless both are set:
 *
 *   HOME_ASSISTANT_URL=http://homeassistant.local:8123 HOME_ASSISTANT_TOKEN=... \
 *     pnpm --filter @pva/module-home-assistant exec vitest run test/live.test.ts --silent=false
 *
 * Read-only by default: it renders the module's inventory template, decodes it and prints the rooms and the targets of
 * each kind, with the time each request took. It switches something only when HOME_ASSISTANT_LIVE_TOGGLE names one
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
      const text = yield* client.renderTemplate(INVENTORY_TEMPLATE, { maxBytes: 1024 * 1024 })
      const t2 = performance.now()
      const decoded = decodeHouse(text, "", Date.now())
      const t3 = performance.now()
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) return
      const house = decoded.house
      console.log(`HA ${config.version}: config ${(t1 - t0).toFixed(0)} ms, template ${(t2 - t1).toFixed(0)} ms (${text.length} chars), decode ${(t3 - t2).toFixed(1)} ms`)
      console.log(`${house.areas.length} areas, ${house.entities.length} entities, ${house.leftOut} left out`)
      for (const kind of ["light", "switch", "climate", "cover"] as const) {
        console.log(`${kind}:\n` + targetOptions(house, kind).map((t) => `  ${t.value}  "${t.label}"  ${(t.aliases ?? []).join(", ")}`).join("\n"))
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
