// The Home Assistant transport as the tests program it: a stub of the contract (docs/MODULES.md §13), never an
// imitation of the provider. What its cache holds and how its connection stands are plain data the test changes; every
// `callService` is recorded and answered as the test says (by default: done, no response).
import { provide, stubService } from "@pva/core/testing"
import { type HaArea, type HaConnection, type HaEntity, type HaServiceCall, type HaServiceResult, HomeAssistant, type HomeAssistantError, type HomeAssistantService } from "@pva/module-contracts"
import { Effect } from "effect"

export const START = Date.parse("2026-11-18T09:00:00Z")

export const player = (entityId: string, over: Partial<HaEntity> = {}): HaEntity => ({
  entityId,
  domain: "media_player",
  name: entityId.slice("media_player.".length).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
  aliases: [],
  state: "idle",
  attributes: {},
  attributesCut: false,
  lastChanged: START - 3_600_000,
  ...over
})

export const area = (id: string, name: string, aliases: ReadonlyArray<string> = []): HaArea => ({ id, name, aliases })

/** Music Assistant's player entities carry these attributes (HA's music_assistant integration). */
export const MASS = { mass_player_type: "player" }

/**
 * The default house of the tests: the Kitchen speaker (Music Assistant, playing, at half volume), the Bedroom speaker
 * (paused), two plain players in the Hall (neither Music Assistant's), and a light in the Kitchen (not a player).
 */
export const house = () => ({
  areas: [area("kitchen", "Kitchen", ["keuken"]), area("bedroom", "Bedroom"), area("hall", "Hall"), area("garage", "Garage")],
  entities: [
    player("media_player.kitchen_speaker", {
      name: "Kitchen speaker",
      areaId: "kitchen",
      state: "playing",
      attributes: { ...MASS, media_title: "Feeling Good", media_artist: "Nina Simone", media_album_name: "I Put a Spell on You", volume_level: 0.5 }
    }),
    player("media_player.bedroom_speaker", { name: "Bedroom speaker", areaId: "bedroom", state: "paused", attributes: { ...MASS, media_title: "So What", volume_level: 0.2 } }),
    player("media_player.hall_tv", { name: "Hall TV", areaId: "hall", state: "idle" }),
    player("media_player.hall_cast", { name: "Hall Cast", areaId: "hall", state: "off" }),
    { ...player("light.kitchen", { name: "Kitchen light", areaId: "kitchen", state: "on" }), domain: "light" }
  ]
})

export type Answer = (call: HaServiceCall) => Effect.Effect<HaServiceResult, HomeAssistantError>

export const makeHa = (init: { readonly areas: ReadonlyArray<HaArea>; readonly entities: ReadonlyArray<HaEntity> } = house(), connection: HaConnection = "connected") => {
  const world = { connection, areas: [...init.areas], entities: new Map(init.entities.map((e) => [e.entityId, e])) }
  const calls: Array<HaServiceCall> = []
  let answer: Answer = () => Effect.succeed({})
  const stub = stubService<HomeAssistantService>("home-assistant", {
    connection: () => world.connection,
    entities: () => [...world.entities.values()],
    entity: (id: string) => world.entities.get(id),
    areas: () => world.areas,
    callService: (call) =>
      Effect.suspend(() => {
        calls.push(call)
        return answer(call)
      })
  })
  return {
    stub,
    world,
    calls,
    /** What each later call answers. */
    answer: (a: Answer) => void (answer = a),
    /** The provider's cache changes (a poll brought a new state). */
    set: (entityId: string, over: Partial<HaEntity>) => {
      const e = world.entities.get(entityId)!
      world.entities.set(entityId, { ...e, ...over, attributes: { ...e.attributes, ...(over.attributes ?? {}) } })
    },
    provided: provide("home-assistant", { services: [HomeAssistant.of(stub.service)] })
  }
}

/** The service and target of each call, as one string ("media_pause media_player.kitchen_speaker"). */
export const sent = (ha: { readonly calls: ReadonlyArray<HaServiceCall> }) => ha.calls.map((c) => `${c.domain}.${c.service} ${c.target.entityIds.join(",")}`)

export const KITCHEN = { device: "kitchen-display" } // shared, Sam's, room Kitchen
export const PHONE = { device: "robins-phone" } // private, room Bedroom
export const HALL = { device: "hall-screen" } // public, room Hall

let turns = 0
/** A turn of its own on `device` (a new turn id and conversation): each invocation in a test is a new one unless it says otherwise. */
export const at = (device: string) => {
  turns++
  return { device, turnId: turns, conversationId: `conversation-${turns}` }
}
