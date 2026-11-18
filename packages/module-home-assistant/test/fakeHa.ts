/**
 * A fake of the three Home Assistant endpoints the module uses, served by the test kit's offline network
 * (`makeOfflineNet` of `@pva/core/testing`, which records the method and body of every request): no socket, no
 * network. It keeps a small house whose state follows service calls, renders the module's page template from its
 * `variables` as Home Assistant would (`PAGE_TEMPLATE` in `src/house.ts`: the domains, the cursor, the page size, the
 * cut at `keep` characters, a scene's members), and can be told to be down (a refused connect: nothing sent), to hang
 * until the request is given up (after it was sent), or to answer anything for one path.
 */
import { makeOfflineNet, type OfflineConnectRequest, type OfflineResponse } from "@pva/core/testing"
import type { Connector } from "@pva/net"
import { PAGE_TEMPLATE, type PageVariables } from "../src/house.ts"

/** What an `answer` gets: the request as a `fetch` would have seen it (its body as text). */
export interface FakeInit {
  readonly method: string
  readonly body: string
  readonly signal: AbortSignal
  readonly headers: Readonly<Record<string, string>>
}
/** What an `answer` gives: a `Response` (converted), or the offline network's own answer. */
type Answer = (init?: FakeInit) => Response | OfflineResponse | Promise<Response | OfflineResponse>

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
  volume?: number | null
  /** A light's `supported_color_modes` (default `["brightness"]`; `["onoff"]` is a relay that cannot be dimmed). */
  colorModes?: Array<string> | null
  /** A scene's `entity_id` attribute: the entities it sets (absent: Home Assistant lists none). */
  members?: Array<string> | null
  /** Home Assistant's `last_changed`, epoch seconds (default: a fixed time). */
  changed?: number | null
  /** Anything else Home Assistant's answer carries for it (a proxy's extras, a person's area): the decoder drops it. */
  extra?: Record<string, unknown>
}

/** The default `last_changed` of the fake's entities: 2026-11-18 08:00 UTC, in seconds. */
export const CHANGED_AT = Date.UTC(2026, 10, 18, 8, 0, 0) / 1000

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
  "cover.living_room_blinds": { name: "Living room blinds", state: "open", area: "living_room", class: "blind", position: 100, features: 15 },
  "cover.bedroom_blinds": { name: "Bedroom blinds", state: "closed", area: "bedroom", class: "shade", features: 3 },
  "cover.garage_door": { name: "Garage door", state: "closed", area: "garage", class: "garage", features: 3 },
  "sensor.kitchen_temperature": { name: "Kitchen temperature", state: "21.3", area: "kitchen", class: "temperature", unit: "°C" },
  "binary_sensor.back_door": { name: "Back door", state: "off", area: "hall", class: "door" },
  // A sensor without a class (Home Assistant's companion app makes these): never read.
  "sensor.robins_phone_geocoded_location": { name: "Robin's phone location", state: "Dorpsstraat 1, Utrecht" },
  // A person: read for the HomeAssistant service only.
  "person.robin": { name: "Robin", state: "not_home" },
  "lock.front_door": { name: "Front door", state: "locked", area: "hall" },
  "alarm_control_panel.home": { name: "Alarm", state: "disarmed" },
  "media_player.kitchen": { name: "Kitchen speaker", state: "playing", area: "kitchen", title: "So What", artist: "Miles Davis" },
  "scene.movie_time": { name: "Movie time", state: "2026-11-17T20:00:00+00:00", area: "living_room", members: ["light.ceiling", "cover.living_room_blinds", "media_player.kitchen"] },
  "script.goodnight": { name: "Goodnight", state: "off" }
})

export const TOKEN = "fake-ha-token-0123456789"
export const URL_BASE = "http://ha.test:8123"

type Route = "config" | "template" | "service"
type Behaviour = { readonly kind: "down" } | { readonly kind: "hang" } | { readonly kind: "answer"; readonly answer: Answer }

const routeOf = (path: string): Route => (path === "/api/config" ? "config" : path === "/api/template" ? "template" : "service")

const hang = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("This operation was aborted", "AbortError"))
    signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")))
  })

/** A `Response` as the offline network's answer. */
const offline = async (r: Response | OfflineResponse): Promise<OfflineResponse> =>
  r instanceof Response ? { status: r.status, headers: Object.fromEntries(r.headers), body: new Uint8Array(await r.arrayBuffer()) } : r

const SENSOR_DOMAINS = ["sensor", "binary_sensor"]
const domainOf = (id: string) => id.slice(0, id.indexOf("."))
/** Python's `s[:n]` on a string, as the template does it (code units are close enough for the fake's texts). */
const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null)

export interface FakeHaOptions {
  readonly token?: string
  readonly areas?: Record<string, string>
  readonly entities?: Record<string, FakeEntity>
  readonly nonAdmin?: boolean
  /** The address it answers at (default `URL_BASE`); `http://localhost:8123` is reached as the owner typed it. */
  readonly base?: string
  /** `unit_system.temperature` of `/api/config` (default "°C"). */
  readonly unit?: string
  readonly locationName?: string
}

export const makeFakeHa = (options: FakeHaOptions = {}) => {
  const token = options.token ?? TOKEN
  const areas = options.areas ?? defaultAreas()
  const entities = options.entities ?? defaultEntities()
  const requests: Array<FakeRequest> = []
  const behaviour = new Map<Route, Behaviour>()
  const config = { location_name: options.locationName ?? "Home", version: "2026.11.1", unit_system: { temperature: options.unit ?? "°C" } }

  /** The page template rendered as Home Assistant would, from its variables. */
  /** As the template's `regex_replace(ctl, " ")`: control characters become spaces. */
  const plain = (v: unknown) => (typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ") : v)
  /** As the template's `[:n]` after `regex_replace`: Python cuts on code points. */
  const cutText = (v: unknown, n: number) => (typeof v === "string" ? [...(plain(v) as string)].slice(0, n).join("") : null)
  const num = (v: unknown) => (typeof v === "number" && Math.abs(v) < 1e15 ? v : null)
  const short = (v: unknown, n: number) => (typeof v === "string" && [...v].length <= n ? plain(v) : null)
  const colorModesOf = (id: string, e: FakeEntity) => (e.colorModes !== undefined ? e.colorModes : domainOf(id) === "light" ? ["brightness"] : null)

  /** The page template rendered as Home Assistant would, from its variables (`PAGE_TEMPLATE`). */
  const page = (v: PageVariables) => {
    if (v.mode === "areas") {
      const picked = Object.keys(areas).sort().filter((id) => id > v.after)
      const shown = picked.slice(0, v.size)
      return { rows: shown.map((id) => ({ id, name: cutText(areas[id] ?? "", v.keep) })), last: shown.at(-1) ?? null, more: picked.length > v.size }
    }
    const ids = Object.keys(entities).sort()
    const picked = v.ids !== null ? ids.filter((id) => v.ids!.includes(id) && id > v.after) : ids.filter((id) => v.domains.includes(domainOf(id)) && id > v.after)
    const shown = picked.slice(0, v.size)
    const rows: Array<unknown> = []
    for (const id of shown) {
      const e = entities[id]!
      const d = domainOf(id)
      if (d === "person") {
        rows.push({ id, name: cutText(e.name ?? id, v.keep), state: cutText(e.state, 256), changed: e.changed === undefined ? CHANGED_AT : e.changed, ...e.extra })
        continue
      }
      if (SENSOR_DOMAINS.includes(d) && !v.classes.includes(e.class ?? "")) continue
      const members = d === "scene" && Array.isArray(e.members)
        ? e.members.slice(0, v.max_members).map((m) => ({ id: cutText(m, 256), class: short(entities[m]?.class ?? null, 32) }))
        : null
      const modes = colorModesOf(id, e)
      rows.push({
        id,
        name: cutText(e.name ?? id, v.keep),
        state: cutText(e.state, 256),
        changed: e.changed === undefined ? CHANGED_AT : e.changed,
        area: e.area ?? null,
        class: short(e.class, 32),
        brightness: num(e.brightness),
        current: num(e.current),
        target: num(e.target),
        modes: Array.isArray(e.modes) ? [...new Set(e.modes.filter((m) => v.hvac.includes(m)))] : null,
        dim: Array.isArray(modes) ? modes.some((m) => v.dim_modes.includes(m)) : null,
        position: num(e.position),
        features: num(e.features),
        unit: short(e.unit, 16),
        title: cutText(e.title, v.keep),
        artist: cutText(e.artist, v.keep),
        volume: num(e.volume),
        members,
        member_count: d === "scene" && Array.isArray(e.members) ? e.members.length : null,
        ...e.extra
      })
    }
    return { rows, last: shown.at(-1) ?? null, more: picked.length > v.size }
  }

  /** Home Assistant's own limit on a rendered template (`MAX_TEMPLATE_OUTPUT`), in characters (code points). */
  const TEMPLATE_LIMIT = 262_144
  /** The page as Home Assistant answers it: the rendered text, or its HTTP 400 when the text is over the limit. */
  const rendered = (v: PageVariables): OfflineResponse => {
    const text = JSON.stringify(page(v))
    let chars = 0
    for (const _ of text) chars++
    if (chars > TEMPLATE_LIMIT) return json(400, { message: `Error rendering template: Template output exceeded maximum size of ${TEMPLATE_LIMIT} characters` })
    return json(200, text, "text/plain; charset=utf-8")
  }

  const json = (status: number, payload: unknown, type = "application/json"): OfflineResponse =>
    ({ status, headers: { "content-type": type }, body: typeof payload === "string" ? payload : JSON.stringify(payload) })

  /** What a service answers with `?return_response` (its `service_response`). */
  let serviceResponse: unknown = { ok: true }
  const service = (domain: string, name: string, data: Record<string, unknown>, returnResponse: boolean): OfflineResponse => {
    const ids = Array.isArray(data.entity_id) ? (data.entity_id as Array<string>) : typeof data.entity_id === "string" ? [data.entity_id] : []
    for (const id of ids) {
      const e = entities[id]
      if (e === undefined) return json(400, { message: `Entity ${id} not found for ${domain}` })
      // A service of another domain on it (music_assistant on a media player) changes nothing here.
      if (!id.startsWith(`${domain}.`)) continue
      if (name === "turn_on") e.state = domain === "scene" ? "2026-11-18T09:00:00+00:00" : "on"
      if (name === "turn_off") e.state = "off"
      // Home Assistant's light filter: a brightness for a light without one is dropped, and the light turns on fully.
      const dims = colorModesOf(id, e)?.some((m) => m !== "onoff" && m !== "unknown") === true
      if (typeof data.brightness_pct === "number" && domain === "light" && !dims) {
        if (name === "turn_on") e.brightness = null
      } else if (typeof data.brightness_pct === "number") {
        e.brightness = Math.round((data.brightness_pct / 100) * 255)
        if (data.brightness_pct === 0) e.state = "off"
      }
      if (name === "set_temperature") e.target = data.temperature as number
      if (name === "set_hvac_mode") e.state = data.hvac_mode as string
      if (name === "open_cover") (e.state = "open"), (e.position = 100)
      if (name === "close_cover") (e.state = "closed"), (e.position = 0)
      if (name === "set_cover_position") e.position = data.position as number
      e.changed = Date.now() / 1000
    }
    return returnResponse ? json(200, { changed_states: [], service_response: serviceResponse }) : json(200, [])
  }

  /** What Home Assistant answers a request, when no behaviour is set. */
  const handle = (method: string, url: URL, authorization: string | undefined, body: unknown): OfflineResponse => {
    const path = url.pathname
    if (authorization !== `Bearer ${token}`) return json(401, "401: Unauthorized", "text/plain")
    if (method === "GET" && path === "/api/config") return json(200, config)
    if (method === "POST" && path === "/api/template") {
      if (options.nonAdmin === true) return json(401, "401: Unauthorized", "text/plain")
      const t = body as { template?: string; variables?: PageVariables } | undefined
      if (t?.template !== PAGE_TEMPLATE || t.variables === undefined) return json(400, { message: "unexpected template" })
      return rendered(t.variables)
    }
    const match = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(path)
    if (method === "POST" && match !== null) return service(match[1]!, match[2]!, (body ?? {}) as Record<string, unknown>, url.searchParams.has("return_response"))
    return json(404, { message: "Not found" })
  }

  /** The answer the offline network gives next (set by the connector below for one request). */
  let next: OfflineResponse | undefined
  const host = new URL(options.base ?? URL_BASE)
  const own = (key: PropertyKey) => typeof key === "string" && key.startsWith(host.origin)
  // Every path of the fake's host is a fixture (the offline network asks for one by URL): the fake answers each.
  const fixtures = new Proxy({} as Record<string, (request: OfflineConnectRequest) => OfflineResponse>, {
    ownKeys: () => [`${host.origin}/`],
    getOwnPropertyDescriptor: (_t, key) => (own(key) ? { enumerable: true, configurable: true, value: () => next! } : undefined),
    get: (_t, key) => (own(key) ? () => next! : undefined)
  })
  const net = makeOfflineNet(fixtures, { lan: { [host.hostname]: host.hostname === "localhost" ? "127.0.0.1" : "192.168.1.20" } })

  const connector: Connector = async (request) => {
    const text = request.body === undefined ? "" : new TextDecoder().decode(request.body)
    let body: unknown
    try {
      body = text === "" ? undefined : JSON.parse(text)
    } catch {
      body = text
    }
    const path = request.url.pathname
    requests.push({ method: request.method, path, authorization: request.headers.authorization, body })
    const b = behaviour.get(routeOf(path))
    // Refused before anything was written: certain that nothing was sent.
    if (b?.kind === "down") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", notSent: true })
    request.onConnect?.()
    if (b?.kind === "hang") return hang(request.signal)
    next = b?.kind === "answer"
      ? await offline(await b.answer({ method: request.method, body: text, signal: request.signal, headers: request.headers }))
      : handle(request.method, request.url, request.headers.authorization, body)
    return net.connector(request)
  }

  return {
    /** For the module: the offline network's resolver, and its connector behind the fake's behaviours. */
    net: { resolver: net.resolver, connector },
    /** What the kit's offline network recorded: each request's URL, method, headers and body as sent. */
    sent: net.requests,
    token,
    requests,
    areas,
    entities,
    config,
    /** The template pages asked for. */
    pages: () => requests.filter((r) => r.path === "/api/template").map((r) => (r.body as { variables: PageVariables }).variables),
    /** The service calls made, as `domain.service` with their body. */
    calls: () => requests.filter((r) => r.path.startsWith("/api/services/")).map((r) => ({ service: r.path.slice("/api/services/".length).replace("/", "."), body: r.body })),
    /** Make one route (or all) unreachable, hang, or answer as given; `ok()` undoes it. */
    down: (route?: Route) => void (route === undefined ? ["config", "template", "service"] : [route]).forEach((r) => behaviour.set(r as Route, { kind: "down" })),
    hang: (route?: Route) => void (route === undefined ? ["config", "template", "service"] : [route]).forEach((r) => behaviour.set(r as Route, { kind: "hang" })),
    answer: (route: Route, answer: Answer) => void behaviour.set(route, { kind: "answer", answer }),
    /** The page Home Assistant would render for a request (for an answer that wraps it). */
    render: (init?: FakeInit) => page((JSON.parse(String(init?.body)) as { variables: PageVariables }).variables),
    /** What a service call with `returnResponse` answers. */
    respondWith: (response: unknown) => void (serviceResponse = response),
    ok: () => behaviour.clear()
  }
}

export type FakeHa = ReturnType<typeof makeFakeHa>

/** The settings and secrets a test starts the module with. */
export const configured = (extra: Readonly<Record<string, unknown>> = {}) => ({
  settings: { baseUrl: URL_BASE, ...extra },
  secrets: { token: TOKEN }
})
