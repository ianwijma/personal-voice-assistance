// The one delivery decision (docs/NOTIFICATIONS.md "The delivery table"), as a table: every combination of priority,
// do not disturb, a device that can and cannot speak and show, and the privacy rule allowing or not, for a
// notification and for an announcement. The expected column is written out by hand, not computed.
import { assert, describe, it } from "@effect/vitest"
import { decideDelivery, type Delivery, type DeliveryInput } from "../src/Notify.ts"

const DELIVER = (show: boolean, sound: boolean): Delivery => ({ deliver: true, show, sound })
const NOT = (why: Exclude<Delivery, { deliver: true }>["why"]): Delivery => ({ deliver: false, why })

/** `kind priority dnd speak show reveal` → the decision. `reveal`: "household" (no owner), "yes" or "no" (personal). */
const TABLE: ReadonlyArray<readonly [string, Delivery]> = [
  // A normal notification: a silent card wherever it can be shown; do not disturb changes nothing.
  ["notification normal off speak show household", DELIVER(true, false)],
  ["notification normal off speak noshow household", NOT("cannot-show")],
  ["notification normal off mute show household", DELIVER(true, false)],
  ["notification normal off mute noshow household", NOT("cannot-show")],
  ["notification normal on speak show household", DELIVER(true, false)],
  ["notification normal on speak noshow household", NOT("cannot-show")],
  ["notification normal on mute show household", DELIVER(true, false)],
  ["notification normal on mute noshow household", NOT("cannot-show")],
  ["notification normal off speak show yes", DELIVER(true, false)],
  ["notification normal off speak noshow yes", NOT("cannot-show")],
  ["notification normal off mute show yes", DELIVER(true, false)],
  ["notification normal off mute noshow yes", NOT("cannot-show")],
  ["notification normal on speak show yes", DELIVER(true, false)],
  ["notification normal on speak noshow yes", NOT("cannot-show")],
  ["notification normal on mute show yes", DELIVER(true, false)],
  ["notification normal on mute noshow yes", NOT("cannot-show")],
  ["notification normal off speak show no", NOT("private")],
  ["notification normal off speak noshow no", NOT("private")],
  ["notification normal off mute show no", NOT("private")],
  ["notification normal off mute noshow no", NOT("private")],
  ["notification normal on speak show no", NOT("private")],
  ["notification normal on speak noshow no", NOT("private")],
  ["notification normal on mute show no", NOT("private")],
  ["notification normal on mute noshow no", NOT("private")],
  // A ring: the card where it can be shown, the cue where it may make sound and do not disturb is off.
  ["notification ring off speak show household", DELIVER(true, true)],
  ["notification ring off speak noshow household", DELIVER(false, true)],
  ["notification ring off mute show household", DELIVER(true, false)],
  ["notification ring off mute noshow household", NOT("cannot-show")],
  ["notification ring on speak show household", DELIVER(true, false)],
  ["notification ring on speak noshow household", NOT("dnd")],
  ["notification ring on mute show household", DELIVER(true, false)],
  ["notification ring on mute noshow household", NOT("cannot-show")],
  ["notification ring off speak show yes", DELIVER(true, true)],
  ["notification ring off speak noshow yes", DELIVER(false, true)],
  ["notification ring off mute show yes", DELIVER(true, false)],
  ["notification ring off mute noshow yes", NOT("cannot-show")],
  ["notification ring on speak show yes", DELIVER(true, false)],
  ["notification ring on speak noshow yes", NOT("dnd")],
  ["notification ring on mute show yes", DELIVER(true, false)],
  ["notification ring on mute noshow yes", NOT("cannot-show")],
  ["notification ring off speak show no", NOT("private")],
  ["notification ring off speak noshow no", NOT("private")],
  ["notification ring off mute show no", NOT("private")],
  ["notification ring off mute noshow no", NOT("private")],
  ["notification ring on speak show no", NOT("private")],
  ["notification ring on speak noshow no", NOT("private")],
  ["notification ring on mute show no", NOT("private")],
  ["notification ring on mute noshow no", NOT("private")],
  // An announcement: spoken where the device may speak and do not disturb is off; a screen does not matter.
  ["announcement normal off speak show household", DELIVER(false, true)],
  ["announcement normal off speak noshow household", DELIVER(false, true)],
  ["announcement normal off mute show household", NOT("cannot-speak")],
  ["announcement normal off mute noshow household", NOT("cannot-speak")],
  ["announcement normal on speak show household", NOT("dnd")],
  ["announcement normal on speak noshow household", NOT("dnd")],
  ["announcement normal on mute show household", NOT("dnd")],
  ["announcement normal on mute noshow household", NOT("dnd")],
  ["announcement normal off speak show yes", DELIVER(false, true)],
  ["announcement normal off speak noshow yes", DELIVER(false, true)],
  ["announcement normal off mute show yes", NOT("cannot-speak")],
  ["announcement normal off mute noshow yes", NOT("cannot-speak")],
  ["announcement normal on speak show yes", NOT("dnd")],
  ["announcement normal on speak noshow yes", NOT("dnd")],
  ["announcement normal on mute show yes", NOT("dnd")],
  ["announcement normal on mute noshow yes", NOT("dnd")],
  ["announcement normal off speak show no", NOT("private")],
  ["announcement normal off speak noshow no", NOT("private")],
  ["announcement normal off mute show no", NOT("private")],
  ["announcement normal off mute noshow no", NOT("private")],
  ["announcement normal on speak show no", NOT("private")],
  ["announcement normal on speak noshow no", NOT("private")],
  ["announcement normal on mute show no", NOT("private")],
  ["announcement normal on mute noshow no", NOT("private")]
]

const inputOf = (row: string, connected = true): DeliveryInput => {
  const [kind, priority, dnd, speak, show, reveal] = row.split(" ")
  return {
    kind: kind as DeliveryInput["kind"],
    priority: priority as DeliveryInput["priority"],
    dnd: dnd === "on",
    personal: reveal !== "household",
    mayReveal: reveal !== "no",
    device: { connected, canSpeak: speak === "speak", canShow: show === "show" }
  }
}

describe("decideDelivery", () => {
  it("covers every combination exactly once", () => {
    const keys = new Set(TABLE.map(([k]) => k))
    assert.strictEqual(keys.size, TABLE.length)
    // notification: 2 priorities × 2 dnd × 2 speak × 2 show × 3 reveal; announcement: 1 × 2 × 2 × 2 × 3.
    assert.strictEqual(TABLE.length, 48 + 24)
  })
  for (const [row, expected] of TABLE) {
    it(row, () => assert.deepStrictEqual(decideDelivery(inputOf(row)), expected))
  }
  it("a device that is not connected gets nothing, whatever else is true", () => {
    for (const [row] of TABLE) assert.deepStrictEqual(decideDelivery(inputOf(row, false)), NOT("offline"))
  })
})
