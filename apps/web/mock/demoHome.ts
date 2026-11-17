import type { FieldActionResult, ModuleInfo, ModuleRoutesResponse, RecordValue, RouteTokenInfo, SettingValue } from "@pva/protocol"
import { randomBytes } from "node:crypto"

/**
 * The demo home in the mock server (protocol 10, docs/MODULES-PLAN.md §4 P3): the real module's `rooms` and `lights`
 * records, a combo with the running module's suggestions, an info value and two buttons, plus two module routes, their
 * recent calls and route tokens for the admin view (`/api/module-routes`).
 */

const rooms: ReadonlyArray<RecordValue> = [
  { name: "Living room", aliases: ["lounge", "sitting room", "woonkamer"] },
  { name: "Kitchen", aliases: ["keuken"] },
  { name: "Bedroom", aliases: ["slaapkamer"] },
  { name: "Office", aliases: ["study", "kantoor", "werkkamer"] }
]
const lights: ReadonlyArray<RecordValue> = [
  { name: "Desk lamp", room: "Office", aliases: ["bureaulamp"] },
  { name: "Reading lamp", room: "Living room", aliases: ["leeslamp"] }
]

export const demoHomeModule = (): ModuleInfo => ({
  id: "demo-home",
  name: "Demo home",
  description: "A pretend house with rooms and lights, to try commands like \"hey Jev, turn on the living room lights\". Nothing real is switched.",
  enabled: true,
  state: "running",
  status: { text: "4 rooms · 0 lights on", tone: "neutral" },
  tools: [{ name: "home_state", description: "Rooms and lights of the demo home.", speculative: true }],
  settings: {
    fields: [
      {
        type: "records",
        key: "rooms",
        label: "Rooms",
        description: "Each room has a main light. Other names are what you may call it (\"lounge\").",
        apply: "live",
        default: rooms,
        itemFields: [
          { type: "text", key: "name", label: "Name", default: "", maxLength: 40 },
          { type: "textList", key: "aliases", label: "Other names", default: [], maxItems: 10, itemMaxLength: 40 }
        ],
        itemLabel: "room",
        titleKey: "name",
        maxItems: 20,
        orderable: false,
        source: "default"
      },
      {
        type: "records",
        key: "lights",
        label: "Lamps",
        description: "Lamps besides the main lights, each in one of the rooms.",
        apply: "live",
        default: lights,
        itemFields: [
          { type: "text", key: "name", label: "Name", default: "", maxLength: 40 },
          { type: "text", key: "room", label: "Room", default: "", maxLength: 40, placeholder: "Living room" },
          { type: "textList", key: "aliases", label: "Other names", default: [], maxItems: 10, itemMaxLength: 40 }
        ],
        itemLabel: "lamp",
        titleKey: "name",
        maxItems: 20,
        orderable: true,
        source: "default"
      },
      {
        type: "textList",
        key: "greetings",
        label: "Greeting words",
        description: "Said first, they are ignored (\"please\", \"hey\").",
        apply: "live",
        default: ["please"],
        maxItems: 8,
        itemMaxLength: 20,
        source: "default"
      },
      {
        type: "combo",
        key: "scene",
        label: "Evening scene",
        description: "Picked from the scenes the running module knows, or typed.",
        apply: "live",
        default: "Cosy",
        options: [{ value: "Cosy", label: "Cosy" }, { value: "Bright", label: "Bright" }, { value: "Film night", label: "Film night" }],
        allowCustom: true,
        optionsNote: "3 suggestions from Demo home",
        source: "default"
      },
      { type: "info", key: "state", label: "Now", apply: "live", tone: "ok", source: "default" },
      {
        type: "action",
        key: "check",
        label: "Check the house",
        description: "Checks the rooms and lamps above, also before they are saved.",
        apply: "live",
        buttonLabel: "Check",
        requiresSaved: false,
        source: "default"
      },
      {
        type: "action",
        key: "allOff",
        label: "Every light",
        apply: "live",
        buttonLabel: "Switch everything off",
        requiresSaved: true,
        source: "default"
      }
    ],
    values: { rooms, lights, greetings: ["please"], scene: "Cosy", state: "All lights are off." },
    secrets: {},
    errors: []
  },
  revision: 1,
  // No `kind`: the mock's assistants do not switch it (it keeps running, so its routes show).
  group: "modules",
  apiVersion: 2,
  routes: [
    {
      method: "POST",
      path: "/api/modules/demo-home/hook/:name",
      guards: ["token", "lan"],
      public: false,
      token: "hook",
      bodyLimitBytes: 8192,
      ratePerMinute: { perAddress: 30, total: 120 },
      description: "Switch a light from an automation"
    },
    {
      method: "GET",
      path: "/api/modules/demo-home/state",
      guards: ["admin"],
      public: false,
      bodyLimitBytes: 0,
      ratePerMinute: { perAddress: 30, total: 120 },
      description: "The demo home's lights as JSON"
    }
  ]
})

const asRecords = (v: SettingValue | undefined): ReadonlyArray<RecordValue> =>
  Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null) ? (v as ReadonlyArray<RecordValue>) : []

/** What the demo home's buttons answer: `check` judges the given (draft or saved) values. */
export const demoHomeAction = (key: string, values: Readonly<Record<string, SettingValue>>): FieldActionResult | undefined => {
  if (key === "allOff") return { ok: true, text: "Every light was already off.", tone: "ok" }
  if (key !== "check") return undefined
  const r = asRecords(values.rooms)
  const l = asRecords(values.lights)
  const names = [...r, ...l].map((x) => String(x.name ?? "").trim())
  if (names.some((n) => n === "")) return { ok: false, text: "Every room and lamp needs a name", tone: "error" }
  const lost = l.find((x) => !r.some((room) => String(room.name).toLowerCase() === String(x.room ?? "").trim().toLowerCase()))
  if (lost !== undefined) return { ok: false, text: `${String(lost.name)} is in "${String(lost.room)}", which is not one of the rooms`, tone: "error" }
  return { ok: true, text: `${r.length} rooms and ${l.length} ${l.length === 1 ? "lamp" : "lamps"}; every lamp is in one of the rooms.`, tone: "ok" }
}

/** The admin view of module routes: the demo home's two routes with a few recent calls, and its tokens. */
export const createModuleRoutesMock = () => {
  const started = Date.now()
  let tokens: Array<RouteTokenInfo> = [
    { id: "a1b2c3d4e5f6", moduleId: "demo-home", name: "hook", label: "Home Assistant automations", createdAt: started - 86_400_000, lastUsedAt: started - 120_000 }
  ]
  const calls = [
    { at: started - 120_000, address: "192.168.1.20", status: 202, ms: 4, token: "Home Assistant automations" },
    { at: started - 600_000, address: "203.0.113.9", status: 403, ms: 0, note: "Only callers on the home network" },
    { at: started - 900_000, address: "192.168.1.20", status: 401, ms: 0, note: "The token is not valid (it may have been revoked)" }
  ]
  return {
    view: (modules: ReadonlyArray<ModuleInfo>): ModuleRoutesResponse => ({
      // As the server: a module with routes or tokens (a stopped one's tokens are listed, to be revoked).
      modules: modules.flatMap((m) =>
        m.routes === undefined && !tokens.some((t) => t.moduleId === m.id)
          ? []
          : [{
            moduleId: m.id,
            running: m.state === "running",
            routes: (m.routes ?? []).map((r, i) => ({ ...r, calls: i === 0 ? calls : [] })),
            tokens: tokens.filter((t) => t.moduleId === m.id)
          }]
      ),
      tokensLocked: false,
      behindProxy: process.env.MOCK_BEHIND_PROXY === "1"
    }),
    mint: (moduleId: string, name: string, label: string) => {
      const token: RouteTokenInfo = { id: randomBytes(6).toString("hex"), moduleId, name, label, createdAt: Date.now() }
      tokens = [...tokens, token]
      return { token, secret: randomBytes(32).toString("base64url") }
    },
    revoke: (moduleId: string, id: string) => {
      const before = tokens.length
      tokens = tokens.filter((t) => !(t.moduleId === moduleId && t.id === id))
      return tokens.length !== before
    }
  }
}
