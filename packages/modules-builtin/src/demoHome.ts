import { defineAction, defineModule, makeTool, Param, type ParamOption } from "@pva/core"
import { Effect, Schema } from "effect"

/**
 * An in-memory house to try the typed-intent path without any home-automation
 * system (docs/AGENTS-AND-INTENTS.md §3.9): rooms with a main light each, a few
 * named lamps, on/off and brightness. Nothing leaves the process; the state
 * resets when the module restarts.
 *
 * The house is a constant for now; the `rooms` and `lights` settings (`records`
 * fields) come with the settings widening (build plan piece G/H).
 */

export interface DemoRoom {
  readonly id: string
  readonly name: string
  readonly aliases: ReadonlyArray<string>
}

export interface DemoLamp {
  readonly id: string
  readonly name: string
  readonly room: string
  readonly aliases: ReadonlyArray<string>
}

export const defaultRooms: ReadonlyArray<DemoRoom> = [
  { id: "living_room", name: "Living room", aliases: ["lounge", "sitting room", "woonkamer"] },
  { id: "kitchen", name: "Kitchen", aliases: ["keuken"] },
  { id: "bedroom", name: "Bedroom", aliases: ["slaapkamer"] },
  { id: "office", name: "Office", aliases: ["study", "kantoor", "werkkamer"] }
]

export const defaultLamps: ReadonlyArray<DemoLamp> = [
  { id: "desk_lamp", name: "Desk lamp", room: "office", aliases: ["bureaulamp"] },
  { id: "reading_lamp", name: "Reading lamp", room: "living_room", aliases: ["leeslamp"] }
]

interface LightState {
  readonly id: string
  /** Display name: "Kitchen light", "Desk lamp". */
  readonly name: string
  readonly room: string
  on: boolean
  brightness: number
}

/** The house and its operations, without the module wrapper (tests use it directly). */
export const makeDemoHouse = (rooms: ReadonlyArray<DemoRoom> = defaultRooms, lamps: ReadonlyArray<DemoLamp> = defaultLamps) => {
  const lights: Array<LightState> = [
    ...rooms.map((r) => ({ id: `${r.id}_main`, name: `${r.name} light`, room: r.id, on: false, brightness: 100 })),
    ...lamps.map((l) => ({ id: l.id, name: l.name, room: l.room, on: false, brightness: 100 }))
  ]
  const roomName = (id: string) => rooms.find((r) => r.id === id)?.name ?? id

  /** Targets for actions: one per room, one per named lamp, and every light. */
  const targets: ReadonlyArray<ParamOption> = [
    ...rooms.map((r) => ({ value: `area:${r.id}`, label: r.name, aliases: r.aliases })),
    ...lamps.map((l) => ({ value: `light:${l.id}`, label: l.name, aliases: l.aliases })),
    { value: "all", label: "All lights", aliases: ["every light", "everything", "alle lampen", "alles"] }
  ]

  const lightsOf = (target: string): ReadonlyArray<LightState> =>
    target === "all" ? lights
    : target.startsWith("area:") ? lights.filter((l) => l.room === target.slice(5))
    : target.startsWith("light:") ? lights.filter((l) => l.id === target.slice(6))
    : []

  /** How a target is said: "Living room lights", "Desk lamp", "All lights". */
  const spoken = (target: string): string =>
    target === "all" ? "All lights"
    : target.startsWith("area:") ? `${roomName(target.slice(5))} lights`
    : target.startsWith("light:") ? (lamps.find((l) => l.id === target.slice(6))?.name ?? target)
    : target

  const switchTo = (target: string, on: boolean) => {
    for (const light of lightsOf(target)) light.on = on
  }
  const dim = (target: string, level: number) => {
    for (const light of lightsOf(target)) {
      light.brightness = level
      light.on = level > 0
    }
  }

  /** "The kitchen and the desk lamp are on." Rooms whose lights are all on are named as rooms. */
  const describe = (): string => {
    const parts: Array<string> = []
    for (const r of rooms) {
      const inRoom = lights.filter((l) => l.room === r.id)
      if (inRoom.length > 0 && inRoom.every((l) => l.on)) parts.push(`the ${r.name.toLowerCase()}`)
      else for (const l of inRoom) if (l.on) parts.push(`the ${l.name.toLowerCase()}`)
    }
    if (parts.length === 0) return "All lights are off."
    if (lights.every((l) => l.on)) return "All lights are on."
    const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`
    const sentence = `${list} ${parts.length === 1 ? "is" : "are"} on.`
    return sentence[0]!.toUpperCase() + sentence.slice(1)
  }

  const state = () => ({
    rooms: rooms.map((r) => ({
      name: r.name,
      lights: lights.filter((l) => l.room === r.id).map((l) => ({ name: l.name, on: l.on, brightness: l.brightness }))
    }))
  })

  const onCount = () => lights.filter((l) => l.on).length

  return { rooms, lamps, lights: lights as ReadonlyArray<Readonly<LightState>>, targets, lightsOf, spoken, switchTo, dim, describe, state, onCount }
}

export type DemoHouse = ReturnType<typeof makeDemoHouse>

/** The actions and tool of a house; `changed` is called after every change (status line). */
export const demoHomeContributions = (house: DemoHouse, changed: () => void = () => {}) => {
  const target = Param.dynamic({ label: "Room or light", options: () => house.targets })
  const lightsOn = defineAction({
    id: "lights_on",
    label: "Turn lights on",
    description: "Switch on the lights in a room, one lamp, or every light. Not for dimming: that is set_brightness.",
    examples: ["turn on the kitchen lights", "lights on in the bedroom", "switch on the desk lamp", "doe het licht aan in de woonkamer"],
    params: { target },
    announce: ({ target }) => `${house.spoken(target)} on.`,
    run: ({ target }) => Effect.sync(() => {
      house.switchTo(target, true)
      changed()
    })
  })
  const lightsOff = defineAction({
    id: "lights_off",
    label: "Turn lights off",
    description: "Switch off the lights in a room, one lamp, or every light.",
    examples: ["turn off the kitchen lights", "lights off in the bedroom", "switch off the desk lamp", "doe het licht uit in de keuken"],
    params: { target },
    announce: ({ target }) => `${house.spoken(target)} off.`,
    run: ({ target }) => Effect.sync(() => {
      house.switchTo(target, false)
      changed()
    })
  })
  const setBrightness = defineAction({
    id: "set_brightness",
    label: "Set brightness",
    description: "Dim or brighten the lights in a room or one lamp to a level in percent.",
    examples: ["dim the living room to 40 percent", "set the desk lamp to 70%", "zet de woonkamer op veertig procent"],
    params: { target, level: Param.number({ label: "Brightness", min: 0, max: 100, integer: true, unit: "percent" }) },
    announce: ({ level, target }) => `${house.spoken(target)} at ${level} percent.`,
    run: ({ level, target }) => Effect.sync(() => {
      house.dim(target, level)
      changed()
    })
  })
  const lightsStatus = defineAction({
    id: "lights_status",
    label: "Say which lights are on",
    description: "Tell which lights in the house are on right now. A question; changes nothing.",
    examples: ["which lights are on", "are any lights on", "welke lampen staan aan"],
    params: {},
    speculative: true,
    run: () => Effect.sync(() => ({ say: house.describe() }))
  })
  const allOff = defineAction({
    id: "all_off",
    label: "Switch everything off",
    description: "Switch off every light in the house at once, for leaving or going to bed.",
    examples: ["switch everything off", "all off", "alles uit"],
    params: {},
    confirm: true,
    announce: () => "Everything off.",
    run: () => Effect.sync(() => {
      house.switchTo("all", false)
      changed()
    })
  })
  const stateTool = makeTool({
    name: "demo_home_state",
    description: "Which lights of the (demonstration) home are on, per room, with brightness in percent.",
    parameters: Schema.Struct({}),
    speculative: true,
    execute: () => Effect.sync(() => house.state())
  })
  return { actions: [lightsOn, lightsOff, setBrightness, lightsStatus, allOff], tools: [stateTool] }
}

/** The demonstration home as a module (enabled by default: it is how the intent path is tried without a real home). */
export const demoHomeModule = defineModule({
  id: "demo-home",
  name: "Demo home",
  description: "A pretend house with rooms and lights, to try commands like \"hey Jev, turn on the living room lights\". Nothing real is switched.",
  start: ({ setStatus }) =>
    Effect.sync(() => {
      const house = makeDemoHouse()
      const status = () => setStatus({ text: `${house.rooms.length} rooms · ${house.onCount()} lights on`, tone: "neutral" })
      status()
      return {
        ...demoHomeContributions(house, status),
        instructions: "The demo home is pretend: its lights exist only inside the assistant."
      }
    })
})
