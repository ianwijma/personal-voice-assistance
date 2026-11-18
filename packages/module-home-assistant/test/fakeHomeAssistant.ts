import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { PAGE_TEMPLATE, type PageVariables } from "../src/house.ts"

/**
 * A fake Home Assistant HTTP server on 127.0.0.1 (random port), speaking the
 * three endpoints the module uses, with lights only. The app's serve tests use it
 * (`apps/assistant/test/serveModules.test.ts`); this package's own tests use the
 * in-process fake of `fakeHa.ts`, which opens no socket. It records every request, and its state
 * changes on service calls, so a test can switch a light and read it back.
 */
export interface FakeLight {
  name: string
  state: "on" | "off"
  brightness?: number | null
}

export interface FakeHomeAssistantOptions {
  readonly token?: string
  /** Areas: id → name and member entity ids. */
  readonly areas?: Record<string, { name: string; lights: Array<string> }>
  readonly lights?: Record<string, FakeLight>
  /** The token belongs to a non-admin user: /api/template answers 401. */
  readonly nonAdmin?: boolean
  /** Delay every answer (ms). */
  readonly delayMs?: number
}

export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly body: unknown
}

export const defaultAreas = () => ({
  living_room: { name: "Living room", lights: ["light.ceiling", "light.reading_lamp"] },
  kitchen: { name: "Kitchen", lights: ["light.kitchen"] },
  bedroom: { name: "Bedroom", lights: [] as Array<string> }
})

export const defaultLights = (): Record<string, FakeLight> => ({
  "light.ceiling": { name: "Ceiling", state: "on", brightness: 128 },
  "light.reading_lamp": { name: "Reading lamp", state: "off", brightness: null },
  "light.kitchen": { name: "Kitchen light", state: "off", brightness: null },
  "light.desk_lamp": { name: "Desk lamp", state: "on", brightness: 255 }
})

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = ""
    req.on("data", (c: Buffer) => (data += c.toString()))
    req.on("end", () => resolve(data))
  })

export const startFakeHomeAssistant = async (options: FakeHomeAssistantOptions = {}) => {
  const token = options.token ?? "good-token"
  const areas: Record<string, { name: string; lights: Array<string> }> = options.areas ?? defaultAreas()
  const lights = options.lights ?? defaultLights()
  const requests: Array<RecordedRequest> = []
  let delayMs = options.delayMs ?? 0
  let failNext: number | undefined

  // The house the module's page template reads: areas, and each light with its area.
  const areaOf = (id: string) => Object.entries(areas).find(([, a]) => a.lights.includes(id))?.[0] ?? null
  const render = () => ({
    areas: Object.entries(areas).map(([id, a]) => ({ id, name: a.name })),
    entities: Object.entries(lights).map(([id, l]) => ({ id, name: l.name, state: l.state, area: areaOf(id), brightness: l.brightness ?? null }))
  })

  const server: Server = createServer(async (req, res) => {
    const text = await readBody(req)
    const path = (req.url ?? "/").split("?")[0]!
    let body: unknown
    try {
      body = text === "" ? undefined : JSON.parse(text)
    } catch {
      body = text
    }
    requests.push({ method: req.method ?? "", path, authorization: req.headers.authorization, body })
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    const send = (status: number, payload: unknown, type = "application/json") => {
      if (res.destroyed) return
      res.writeHead(status, { "Content-Type": type })
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload))
    }
    if (failNext !== undefined) {
      const status = failNext
      failNext = undefined
      return send(status, { message: "boom" })
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, "401: Unauthorized", "text/plain")
    if (req.method === "GET" && path === "/api/config") {
      return send(200, { location_name: "Home", version: "2026.11.1", time_zone: "Europe/Amsterdam", state: "RUNNING", unit_system: { temperature: "°C" } })
    }
    if (req.method === "POST" && path === "/api/template") {
      if (options.nonAdmin === true) return send(401, "401: Unauthorized", "text/plain")
      // The module's page template (`PAGE_TEMPLATE`), rendered from its variables: the lights of the page's domains
      // after its cursor, at most its size, with the areas on the page that asks for them.
      const t = body as { template?: string; variables?: PageVariables } | undefined
      if (t?.template !== PAGE_TEMPLATE || t.variables === undefined) return send(400, { message: "unexpected template" })
      const v = t.variables
      const all = render()
      const ids = all.entities.map((e) => e.id).sort().filter((id) => (v.ids !== null ? v.ids.includes(id) : v.domains.includes(id.slice(0, id.indexOf("."))) && id > v.after))
      const shown = ids.slice(0, v.size)
      return send(200, JSON.stringify({
        areas: v.with_areas ? all.areas : null,
        entities: all.entities.filter((e) => shown.includes(e.id)).sort((x, y) => (x.id < y.id ? -1 : 1)),
        last: shown.at(-1) ?? null,
        more: ids.length > v.size
      }), "text/plain; charset=utf-8")
    }
    const service = /^\/api\/services\/light\/(turn_on|turn_off)$/.exec(path)
    if (req.method === "POST" && service !== null) {
      const data = body as { entity_id?: string | Array<string>; area_id?: string; brightness_pct?: number }
      const ids = data.area_id !== undefined
        ? (areas[data.area_id]?.lights ?? [])
        : Array.isArray(data.entity_id)
        ? data.entity_id
        : data.entity_id !== undefined
        ? [data.entity_id]
        : []
      for (const id of ids) {
        const light = lights[id]
        if (light === undefined) continue
        light.state = data.brightness_pct === 0 ? "off" : service[1] === "turn_on" ? "on" : "off"
        if (data.brightness_pct !== undefined) light.brightness = Math.round((data.brightness_pct / 100) * 255)
      }
      return send(200, [])
    }
    return send(404, { message: "Not found" })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    requests,
    lights,
    areas,
    setDelay: (ms: number) => (delayMs = ms),
    failNextWith: (status: number) => (failNext = status),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
