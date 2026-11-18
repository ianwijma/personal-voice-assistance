/**
 * An in-process fake of the three Home Assistant endpoints the module uses, as a `fetch` function: no socket, no
 * network. It records every request, keeps a small house whose state follows service calls, and can be told to be
 * down, to hang until the call is aborted, or to answer anything for one path.
 */
export type Fetch = typeof globalThis.fetch

export interface FakeEntity {
  name?: string | null
  state: string
  area?: string | null
  class?: string | null
  brightness?: number | null
  current?: number | null
  target?: number | null
  modes?: Array<string> | null
  position?: number | null
  features?: number | null
  unit?: string | null
  title?: string | null
  artist?: string | null
}

export interface FakeRequest {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly body: unknown
}

export const defaultAreas = (): Record<string, string> => ({
  kitchen: "Kitchen",
  living_room: "Living room",
  bedroom: "Bedroom",
  garage: "Garage",
  hall: "Hall"
})

export const defaultEntities = (): Record<string, FakeEntity> => ({
  "light.kitchen": { name: "Kitchen light", state: "off", area: "kitchen" },
  "light.ceiling": { name: "Ceiling", state: "on", area: "living_room", brightness: 128 },
  "light.reading_lamp": { name: "Reading lamp", state: "off", area: "living_room" },
  "light.bedside": { name: "Bedside lamp", state: "off", area: "bedroom" },
  "switch.coffee": { name: "Coffee machine", state: "off", area: "kitchen" },
  "fan.bedroom": { name: "Bedroom fan", state: "off", area: "bedroom" },
  "climate.living_room": { name: "Living room thermostat", state: "heat", area: "living_room", current: 18.5, target: 20, modes: ["off", "heat", "auto"] },
  "cover.living_room_blinds": { name: "Living room blinds", state: "open", area: "living_room", position: 100, features: 15 },
  "cover.bedroom_blinds": { name: "Bedroom blinds", state: "closed", area: "bedroom", features: 3 },
  "cover.garage_door": { name: "Garage door", state: "closed", area: "garage", class: "garage", features: 3 },
  "sensor.kitchen_temperature": { name: "Kitchen temperature", state: "21.3", area: "kitchen", class: "temperature", unit: "°C" },
  "binary_sensor.back_door": { name: "Back door", state: "off", area: "hall", class: "door" },
  // A sensor without a class (Home Assistant's companion app makes these): never read.
  "sensor.robins_phone_geocoded_location": { name: "Robin's phone location", state: "Dorpsstraat 1, Utrecht" },
  // A person: never read by this module.
  "person.robin": { name: "Robin", state: "not_home" },
  "lock.front_door": { name: "Front door", state: "locked", area: "hall" },
  "alarm_control_panel.home": { name: "Alarm", state: "disarmed" },
  "media_player.kitchen": { name: "Kitchen speaker", state: "playing", area: "kitchen", title: "So What", artist: "Miles Davis" },
  "scene.movie_time": { name: "Movie time", state: "2026-11-17T20:00:00+00:00", area: "living_room" },
  "script.goodnight": { name: "Goodnight", state: "off" }
})

export const TOKEN = "fake-ha-token-0123456789"
export const URL_BASE = "http://ha.test:8123"

type Route = "config" | "template" | "service"
type Behaviour = { readonly kind: "down" } | { readonly kind: "hang" } | { readonly kind: "answer"; readonly answer: (init?: RequestInit) => Response | Promise<Response> }

const routeOf = (path: string): Route => (path === "/api/config" ? "config" : path === "/api/template" ? "template" : "service")

const hang = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted === true) return reject(new DOMException("This operation was aborted", "AbortError"))
    signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")))
  })

export const makeFakeHa = (options: { readonly token?: string; readonly areas?: Record<string, string>; readonly entities?: Record<string, FakeEntity>; readonly nonAdmin?: boolean } = {}) => {
  const token = options.token ?? TOKEN
  const areas = options.areas ?? defaultAreas()
  const entities = options.entities ?? defaultEntities()
  const requests: Array<FakeRequest> = []
  const behaviour = new Map<Route, Behaviour>()

  const render = () => ({
    areas: Object.entries(areas).map(([id, name]) => ({ id, name })),
    entities: Object.entries(entities).map(([id, e]) => ({
      id,
      name: e.name ?? null,
      state: e.state,
      area: e.area ?? null,
      class: e.class ?? null,
      brightness: e.brightness ?? null,
      current: e.current ?? null,
      target: e.target ?? null,
      modes: e.modes ?? null,
      position: e.position ?? null,
      features: e.features ?? null,
      unit: e.unit ?? null,
      title: e.title ?? null,
      artist: e.artist ?? null
    }))
  })

  const json = (status: number, payload: unknown, type = "application/json") =>
    new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status, headers: { "content-type": type } })

  const service = (domain: string, name: string, data: Record<string, unknown>): Response => {
    const ids = Array.isArray(data.entity_id) ? (data.entity_id as Array<string>) : typeof data.entity_id === "string" ? [data.entity_id] : []
    for (const id of ids) {
      const e = entities[id]
      if (e === undefined || !id.startsWith(`${domain}.`)) return json(400, { message: `Entity ${id} not found for ${domain}` })
      if (name === "turn_on") e.state = domain === "scene" ? "2026-11-18T09:00:00+00:00" : "on"
      if (name === "turn_off") e.state = "off"
      if (typeof data.brightness_pct === "number") {
        e.brightness = Math.round((data.brightness_pct / 100) * 255)
        if (data.brightness_pct === 0) e.state = "off"
      }
      if (name === "set_temperature") e.target = data.temperature as number
      if (name === "set_hvac_mode") e.state = data.hvac_mode as string
      if (name === "open_cover") (e.state = "open"), (e.position = 100)
      if (name === "close_cover") (e.state = "closed"), (e.position = 0)
      if (name === "set_cover_position") e.position = data.position as number
    }
    return json(200, [])
  }

  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input))
    const path = url.pathname
    const text = typeof init?.body === "string" ? init.body : ""
    let body: unknown
    try {
      body = text === "" ? undefined : JSON.parse(text)
    } catch {
      body = text
    }
    const headers = new Headers(init?.headers)
    requests.push({ method: init?.method ?? "GET", path, authorization: headers.get("authorization") ?? undefined, body })
    const route = routeOf(path)
    const b = behaviour.get(route)
    if (b?.kind === "down") throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) })
    if (b?.kind === "hang") return hang(init)
    if (b?.kind === "answer") return b.answer(init)
    if (headers.get("authorization") !== `Bearer ${token}`) return json(401, "401: Unauthorized", "text/plain")
    if (init?.method === "GET" && path === "/api/config") return json(200, { location_name: "Home", version: "2026.11.1" })
    if (init?.method === "POST" && path === "/api/template") {
      if (options.nonAdmin === true) return json(401, "401: Unauthorized", "text/plain")
      const template = (body as { template?: string } | undefined)?.template ?? ""
      if (!template.includes("areas()") || !template.includes("area_id(")) return json(400, { message: "unexpected template" })
      return json(200, JSON.stringify(render()), "text/plain; charset=utf-8")
    }
    const match = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(path)
    if (init?.method === "POST" && match !== null) return service(match[1]!, match[2]!, (body ?? {}) as Record<string, unknown>)
    return json(404, { message: "Not found" })
  }

  return {
    fetch,
    token,
    requests,
    areas,
    entities,
    /** The service calls made, as `domain.service` with their body. */
    calls: () => requests.filter((r) => r.path.startsWith("/api/services/")).map((r) => ({ service: r.path.slice("/api/services/".length).replace("/", "."), body: r.body })),
    /** Make one route (or all) unreachable, hang, or answer as given; `ok()` undoes it. */
    down: (route?: Route) => void (route === undefined ? ["config", "template", "service"] : [route]).forEach((r) => behaviour.set(r as Route, { kind: "down" })),
    hang: (route?: Route) => void (route === undefined ? ["config", "template", "service"] : [route]).forEach((r) => behaviour.set(r as Route, { kind: "hang" })),
    answer: (route: Route, answer: (init?: RequestInit) => Response | Promise<Response>) => void behaviour.set(route, { kind: "answer", answer }),
    ok: () => behaviour.clear()
  }
}

export type FakeHa = ReturnType<typeof makeFakeHa>

/** The settings and secrets a test starts the module with. */
export const configured = (extra: Readonly<Record<string, unknown>> = {}) => ({
  settings: { baseUrl: URL_BASE, ...extra },
  secrets: { token: TOKEN }
})
