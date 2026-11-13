import type { ParamOption } from "@pva/core"
import { normalizePhrase } from "@pva/core"
import { Schema } from "effect"

/**
 * The house as Home Assistant describes it: areas and light entities, read
 * with ONE rendered template (`POST /api/template`), so the list costs one
 * request instead of a registry walk. Area membership comes from
 * `area_entities`, which "includes both entities assigned directly to the area
 * and entities inherited from devices in that area"
 * (https://www.home-assistant.io/template-functions/area_entities/).
 *
 * Area aliases are not readable from templates (no template function exposes
 * them), so spoken names come from the area and light names, a few generated
 * forms, and the owner's alias setting.
 */
export const INVENTORY_TEMPLATE = String.raw`{%- set ns = namespace(areas=[], lights=[]) -%}
{%- for a in areas() -%}
{%- set ns.areas = ns.areas + [{"id": a, "name": area_name(a), "lights": area_entities(a) | select("match", "light\\.") | list}] -%}
{%- endfor -%}
{%- for s in states.light -%}
{%- set ns.lights = ns.lights + [{"id": s.entity_id, "name": s.name, "state": s.state, "brightness": s.attributes.brightness | default(none)}] -%}
{%- endfor -%}
{{ {"areas": ns.areas, "lights": ns.lights} | to_json }}`

const Inventory = Schema.Struct({
  areas: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.NullOr(Schema.String),
    lights: Schema.Array(Schema.String)
  })),
  lights: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.NullOr(Schema.String),
    state: Schema.String,
    brightness: Schema.optional(Schema.NullOr(Schema.Number))
  }))
})
export type Inventory = typeof Inventory.Type

export const decodeInventory = (text: string): Inventory | undefined => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  const result = Schema.decodeUnknownExit(Inventory)(json)
  return result._tag === "Success" ? result.value : undefined
}

export interface Light {
  /** "light.desk_lamp". */
  readonly entityId: string
  readonly name: string
  readonly state: string
  /** 0–100, when on and dimmable. */
  readonly brightnessPct: number | undefined
  readonly areaId: string | undefined
}

export interface Area {
  readonly id: string
  readonly name: string
  readonly lights: ReadonlyArray<string>
}

export interface House {
  readonly areas: ReadonlyArray<Area>
  readonly lights: ReadonlyArray<Light>
  /** `target` values: `area:<id>`, `light.<id>`, `all`. */
  readonly targets: ReadonlyArray<ParamOption>
  readonly fetchedAt: number
}

/**
 * Owner aliases, one line per room or light: `Living room: lounge, woonkamer`
 * (`=` works too). The left side is matched against area names and ids, light
 * names and entity ids, or `all`, ignoring case.
 */
export const parseAliases = (text: string): { readonly aliases: ReadonlyMap<string, ReadonlyArray<string>>; readonly problems: ReadonlyArray<string> } => {
  const aliases = new Map<string, Array<string>>()
  const problems: Array<string> = []
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const match = /^([^:=]+)[:=](.*)$/.exec(line)
    if (match === null) {
      problems.push(`Line ${index + 1}: write "Name: alias, alias"`)
      continue
    }
    const key = normalizePhrase(match[1]!)
    const names = match[2]!.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    if (key === "" || names.length === 0) {
      problems.push(`Line ${index + 1}: write "Name: alias, alias"`)
      continue
    }
    aliases.set(key, [...(aliases.get(key) ?? []), ...names])
  }
  return { aliases, problems }
}

/** Settings check for the alias text. */
export const checkAliases = (text: string): string | undefined => parseAliases(text).problems[0]

const ALL_ALIASES = ["all lights", "every light", "everything", "the whole house", "alle lampen", "alle lichten", "overal"]

const unique = (values: ReadonlyArray<string>, exclude: string): Array<string> => {
  const seen = new Set([normalizePhrase(exclude)])
  const out: Array<string> = []
  for (const v of values) {
    const k = normalizePhrase(v)
    if (k === "" || seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

const prettyId = (id: string) => {
  const s = id.replace(/^light\./, "").replace(/_/g, " ")
  return s.length === 0 ? id : s[0]!.toUpperCase() + s.slice(1)
}

/** Build the house and its target options from the rendered inventory. Pure. */
export const buildHouse = (inventory: Inventory, aliasText: string, fetchedAt: number): House => {
  const { aliases } = parseAliases(aliasText)
  const ownerAliases = (...keys: ReadonlyArray<string>) => keys.flatMap((k) => aliases.get(normalizePhrase(k)) ?? [])

  const areaOf = new Map<string, string>()
  const areas: Array<Area> = inventory.areas.map((a) => {
    for (const l of a.lights) if (!areaOf.has(l)) areaOf.set(l, a.id)
    return { id: a.id, name: a.name ?? prettyId(a.id), lights: a.lights }
  })
  const lights: Array<Light> = inventory.lights.map((l) => ({
    entityId: l.id,
    name: l.name ?? prettyId(l.id),
    state: l.state,
    brightnessPct: l.brightness === undefined || l.brightness === null ? undefined : Math.round((l.brightness / 255) * 100),
    areaId: areaOf.get(l.id)
  }))

  const targets: Array<ParamOption> = []
  for (const a of areas) {
    targets.push({
      value: `area:${a.id}`,
      label: a.name,
      aliases: unique([...ownerAliases(a.name, a.id), `${a.name} lights`, `${a.name} light`], a.name),
      description: `Every light in the ${a.name} area`
    })
  }
  for (const l of lights) {
    const area = l.areaId === undefined ? undefined : areas.find((a) => a.id === l.areaId)
    targets.push({
      value: l.entityId,
      label: l.name,
      aliases: unique(ownerAliases(l.name, l.entityId), l.name),
      description: area === undefined ? "One light" : `One light, in the ${area.name}`
    })
  }
  targets.push({ value: "all", label: "All lights", aliases: unique([...ALL_ALIASES, ...ownerAliases("all", "all lights")], "All lights"), description: "Every light in the house" })
  return { areas, lights, targets, fetchedAt }
}

/** The service-call target for a `target` value, or undefined when the value is not known. */
export const serviceTarget = (house: House, value: string): Readonly<Record<string, unknown>> | undefined => {
  if (value === "all") return { entity_id: house.lights.map((l) => l.entityId) }
  if (value.startsWith("area:")) {
    const id = value.slice(5)
    return house.areas.some((a) => a.id === id) ? { area_id: id } : undefined
  }
  return house.lights.some((l) => l.entityId === value) ? { entity_id: value } : undefined
}

/** Spoken name of a target: "Living room", "Desk lamp", "All lights". */
export const labelOf = (house: House, value: string): string => house.targets.find((t) => t.value === value)?.label ?? value

const joinNames = (names: ReadonlyArray<string>): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`

/** "The kitchen light and the desk lamp are on." / "All lights are off." Spoken. */
export const describeLights = (house: House): string => {
  const on = house.lights.filter((l) => l.state === "on")
  if (house.lights.length === 0) return "Home Assistant has no lights."
  if (on.length === 0) return "All lights are off."
  if (on.length === house.lights.length) return house.lights.length === 1 ? `${on[0]!.name} is on.` : "All lights are on."
  const names = on.slice(0, 6).map((l) => l.name)
  const more = on.length > 6 ? ` and ${on.length - 6} more` : ""
  return `${joinNames(names)}${more} ${on.length === 1 ? "is" : "are"} on.`
}

/** Compact state for the `home_state` tool (JSON for a conversational model). */
export const houseState = (house: House) => ({
  areas: house.areas.map((a) => ({
    name: a.name,
    lights: a.lights.map((id) => house.lights.find((l) => l.entityId === id)).filter((l): l is Light => l !== undefined).map((l) => ({
      name: l.name,
      state: l.state,
      ...(l.brightnessPct !== undefined && l.state === "on" ? { brightnessPct: l.brightnessPct } : {})
    }))
  })),
  lightsWithoutArea: house.lights.filter((l) => l.areaId === undefined).map((l) => ({ name: l.name, state: l.state }))
})
