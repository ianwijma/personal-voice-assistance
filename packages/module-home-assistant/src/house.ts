import { NOT_ONE_LINE, normalizePhrase, type ParamOption } from "@pva/core"
import { HA_LIMITS, SECURITY_COVER_CLASSES } from "@pva/module-contracts"

/**
 * The house as Home Assistant describes it: areas, and the entities of the domains this module knows, read with ONE
 * rendered template (`POST /api/template`), so the whole list costs one request. An entity's area is `area_id(entity)`:
 * its own area, else its device's (https://www.home-assistant.io/template-functions/area_id/).
 *
 * What is read, and what is left out on purpose:
 *
 * - **Domains**: `DOMAINS` only. No `device_tracker`, `zone`, `camera`, `calendar`. A `person` is read with its id,
 *   name, state and last change and nothing else (no attributes: no coordinates, no device), for the `HomeAssistant`
 *   service only (presence); the module's own tools never read or mention one (`Kind` "person" is never offered).
 * - **Sensors**: only the device classes in `SENSOR_CLASSES` (temperatures, humidity, doors, windows, leaks, smoke). A
 *   sensor without a class is never read: Home Assistant's companion app makes classless sensors that say where a
 *   phone is ("geocoded location"), and Home Assistant's own list of what is exposed to Assist cannot be read without
 *   its WebSocket (docs/modules/home-assistant.md, "What was left out").
 * - **Bounds**: at most `HOUSE_LIMITS.entities` entities (by id order) and `HOUSE_LIMITS.areas` areas; ids that are
 *   not Home Assistant's form or are longer than `idChars` are left out (never cut); names are one line, cut to
 *   `nameChars`. The answer itself is at most `HOUSE_LIMITS.answerBytes`, so decoding it is bounded (one `JSON.parse`
 *   of at most 1 MiB, a few milliseconds, then one pass over at most 5,000 entities).
 *
 * Area aliases and entity aliases are not readable from templates (no template function exposes them), so spoken
 * names come from the names, a few generated forms, and the owner's "Other names" setting (`parseAliases`).
 */
export const DOMAINS = [
  "light",
  "switch",
  "fan",
  "input_boolean",
  "climate",
  "cover",
  "media_player",
  "sensor",
  "binary_sensor",
  "lock",
  "alarm_control_panel",
  "scene",
  "script",
  "person"
] as const
export type Domain = (typeof DOMAINS)[number]

/** Sensor and binary sensor device classes that are read; every other sensor is left out. */
export const SENSOR_CLASSES = [
  "temperature",
  "humidity",
  "illuminance",
  "pressure",
  "carbon_dioxide",
  "pm25",
  "door",
  "window",
  "opening",
  "garage_door",
  "moisture",
  "smoke",
  "carbon_monoxide",
  "gas"
] as const

/** The contract's bounds (`HA_LIMITS` of `@pva/module-contracts`), and the module's own for what only it reads. */
export const HOUSE_LIMITS = {
  entities: HA_LIMITS.entities,
  areas: HA_LIMITS.areas,
  idChars: HA_LIMITS.idChars,
  nameChars: HA_LIMITS.nameChars,
  stateChars: HA_LIMITS.stateChars,
  aliases: HA_LIMITS.aliases,
  modes: 20,
  answerBytes: 1024 * 1024
} as const

/**
 * The kinds of things the module offers, each a choice of the `domains` setting. `scene` is not a choice there: a
 * scene or script is offered only when the owner names it in "Other names" (`runnable`).
 */
export type Kind = "light" | "switch" | "climate" | "cover" | "media_player" | "sensor" | "lock" | "scene" | "person"

export const kindOf = (domain: Domain): Kind => {
  switch (domain) {
    case "light":
      return "light"
    case "switch":
    case "fan":
    case "input_boolean":
      return "switch"
    case "climate":
      return "climate"
    case "cover":
      return "cover"
    case "media_player":
      return "media_player"
    case "sensor":
    case "binary_sensor":
      return "sensor"
    case "lock":
    case "alarm_control_panel":
      return "lock"
    case "scene":
    case "script":
      return "scene"
    case "person":
      return "person"
  }
}

const list = (values: ReadonlyArray<string>) => values.map((v) => JSON.stringify(v)).join(", ")

/** The one template: `{"areas": [...], "entities": [...]}` as JSON (`to_json`). */
export const INVENTORY_TEMPLATE = String.raw`{%- set ns = namespace(areas=[], entities=[]) -%}
{%- for a in areas() -%}
{%- set ns.areas = ns.areas + [{"id": a, "name": area_name(a)}] -%}
{%- endfor -%}
{%- for s in states if s.domain in [${list(DOMAINS)}] and (s.domain not in ["sensor", "binary_sensor"] or (s.attributes.device_class | default("")) in [${list(SENSOR_CLASSES)}]) -%}
{%- if s.domain == "person" -%}
{%- set ns.entities = ns.entities + [{"id": s.entity_id, "name": s.name, "state": s.state, "changed": as_timestamp(s.last_changed, none)}] -%}
{%- else -%}
{%- set ns.entities = ns.entities + [{"id": s.entity_id, "name": s.name, "state": s.state, "changed": as_timestamp(s.last_changed, none), "area": area_id(s.entity_id), "class": s.attributes.device_class | default(none), "brightness": s.attributes.brightness | default(none), "current": s.attributes.current_temperature | default(none), "target": s.attributes.temperature | default(none), "modes": s.attributes.hvac_modes | default(none), "position": s.attributes.current_position | default(none), "features": s.attributes.supported_features | default(none), "unit": s.attributes.unit_of_measurement | default(none), "title": s.attributes.media_title | default(none), "artist": s.attributes.media_artist | default(none), "volume": s.attributes.volume_level | default(none)}] -%}
{%- endif -%}
{%- endfor -%}
{{ {"areas": ns.areas, "entities": ns.entities} | to_json }}`

export interface Area {
  /** Home Assistant's area id: "living_room". */
  readonly id: string
  readonly name: string
  /** The owner's other names for it ("Other names"). */
  readonly aliases: ReadonlyArray<string>
}

export interface Entity {
  /** "light.desk_lamp". */
  readonly entityId: string
  readonly domain: Domain
  readonly kind: Kind
  readonly name: string
  /** The owner's other names for it. */
  readonly aliases: ReadonlyArray<string>
  /** Home Assistant's state text ("on", "heat", "locked"). */
  readonly state: string
  readonly areaId: string | undefined
  readonly deviceClass: string | undefined
  /** 0–100 for a light that is on and dimmable. */
  readonly brightnessPct: number | undefined
  readonly currentTemperature: number | undefined
  readonly targetTemperature: number | undefined
  readonly hvacModes: ReadonlyArray<string>
  /** A cover's position, 0 (closed) to 100 (open). */
  readonly position: number | undefined
  readonly supportedFeatures: number | undefined
  readonly unit: string | undefined
  readonly mediaTitle: string | undefined
  readonly mediaArtist: string | undefined
  /** A media player's volume, 0 to 1. */
  readonly volumeLevel: number | undefined
  /** Epoch ms of the last state change (0 when Home Assistant did not say). */
  readonly lastChanged: number
  /** A garage door, a gate or a door (`SECURITY_COVER_CLASSES`): read, never moved. */
  readonly security: boolean
  /** A scene or script the owner named in "Other names", so it may be run. */
  readonly runnable: boolean
}

export interface House {
  readonly areas: ReadonlyArray<Area>
  readonly entities: ReadonlyArray<Entity>
  readonly byId: ReadonlyMap<string, Entity>
  /** Entities and areas left out because the lists were longer than the bounds. */
  readonly leftOut: number
  readonly fetchedAt: number
}

const ENTITY_ID = /^([a-z0-9_]+)\.[a-z0-9_]+$/
const AREA_ID = /^[a-z0-9_]+$/

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** One line, cut to `max` (Home Assistant names are the owner's; they still reach prompts and speech). */
const line = (u: unknown, max: number): string | undefined => {
  if (typeof u !== "string") return undefined
  const text = u.replace(new RegExp(NOT_ONE_LINE.source, "gu"), " ").replace(/\s+/g, " ").trim()
  if (text === "") return undefined
  // Cut on a code point, never inside a surrogate pair.
  return text.length <= max ? text : text.slice(0, max).replace(/[\ud800-\udbff]$/, "")
}

const finite = (u: unknown): number | undefined => (typeof u === "number" && Number.isFinite(u) ? u : undefined)

const prettyId = (id: string) => {
  const s = id.replace(/^[a-z0-9_]+\./, "").replace(/_/g, " ").trim()
  return s.length === 0 ? id : s[0]!.toUpperCase() + s.slice(1)
}

/**
 * Owner aliases, one line per room, device, scene or script: `Living room: lounge, woonkamer` (`=` works too). The
 * left side is matched against area names and ids, entity names and ids, or `all`, ignoring case.
 */
export const parseAliases = (text: string): { readonly aliases: ReadonlyMap<string, ReadonlyArray<string>>; readonly problems: ReadonlyArray<string> } => {
  const aliases = new Map<string, Array<string>>()
  const problems: Array<string> = []
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const entry = raw.trim()
    if (entry === "" || entry.startsWith("#")) continue
    const match = /^([^:=]+)[:=](.*)$/.exec(entry)
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

/** The decoded answer, or why it could not be read (a short English line for the status, never upstream text). */
export type Decoded = { readonly ok: true; readonly house: House } | { readonly ok: false; readonly problem: string }

/**
 * Build the house from the rendered template's text. Pure and bounded (see the top of the file): anything that is not
 * the expected shape is left out item by item; only an answer that is not JSON or has no lists at all is refused.
 */
export const decodeHouse = (text: string, aliasText: string, fetchedAt: number): Decoded => {
  if (text.length > HOUSE_LIMITS.answerBytes) return { ok: false, problem: "the answer is too large" }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, problem: "the answer is not JSON" }
  }
  if (!isRecord(json) || !Array.isArray(json.areas) || !Array.isArray(json.entities)) return { ok: false, problem: "the answer is not the room list" }
  const { aliases } = parseAliases(aliasText)
  const ownerAliases = (...keys: ReadonlyArray<string>) => keys.flatMap((k) => aliases.get(normalizePhrase(k)) ?? [])
  let leftOut = 0

  const areaRows = json.areas.filter(isRecord).flatMap((a) => {
    const id = a.id
    if (typeof id !== "string" || id.length > HOUSE_LIMITS.idChars || !AREA_ID.test(id)) {
      leftOut++
      return []
    }
    return [{ id, name: line(a.name, HOUSE_LIMITS.nameChars) ?? prettyId(id) }]
  }).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  leftOut += Math.max(0, areaRows.length - HOUSE_LIMITS.areas)
  const areas: Array<Area> = areaRows.slice(0, HOUSE_LIMITS.areas).map((a) => ({ ...a, aliases: unique(ownerAliases(a.name, a.id), a.name) }))
  const areaIds = new Set(areas.map((a) => a.id))

  const rows = json.entities.filter(isRecord).flatMap((e) => {
    const id = e.id
    const match = typeof id === "string" && id.length <= HOUSE_LIMITS.idChars ? ENTITY_ID.exec(id) : null
    const domain = match?.[1] as Domain | undefined
    if (match === null || domain === undefined || !(DOMAINS as ReadonlyArray<string>).includes(domain)) {
      leftOut++
      return []
    }
    // The template reads only these sensors; an answer that holds others (an older template, a proxy) loses them here.
    if ((domain === "sensor" || domain === "binary_sensor") && !(typeof e.class === "string" && (SENSOR_CLASSES as ReadonlyArray<string>).includes(e.class))) return []
    return [{ id: id as string, domain, e }]
  }).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  leftOut += Math.max(0, rows.length - HOUSE_LIMITS.entities)

  const entities: Array<Entity> = []
  const seen = new Set<string>()
  for (const { id, domain, e } of rows.slice(0, HOUSE_LIMITS.entities)) {
    if (seen.has(id)) continue
    seen.add(id)
    const name = line(e.name, HOUSE_LIMITS.nameChars) ?? prettyId(id)
    const kind = kindOf(domain)
    // A person carries its name, state and last change only: whatever else an answer holds for one is not kept.
    const person = kind === "person"
    const area = !person && typeof e.area === "string" && areaIds.has(e.area) ? e.area : undefined
    const deviceClass = person ? undefined : line(e.class, HOUSE_LIMITS.idChars)
    const brightness = person ? undefined : finite(e.brightness)
    const position = person ? undefined : finite(e.position)
    const ownNames = person ? [] : ownerAliases(id, name)
    const changed = finite(e.changed)
    const volume = person ? undefined : finite(e.volume)
    entities.push({
      entityId: id,
      domain,
      kind,
      name,
      aliases: unique(ownNames, name),
      state: line(e.state, HOUSE_LIMITS.stateChars) ?? "unknown",
      areaId: area,
      deviceClass,
      brightnessPct: brightness === undefined ? undefined : Math.max(0, Math.min(100, Math.round((brightness / 255) * 100))),
      currentTemperature: person ? undefined : finite(e.current),
      targetTemperature: person ? undefined : finite(e.target),
      hvacModes: !person && Array.isArray(e.modes) ? e.modes.flatMap((m) => (typeof m === "string" && m.length <= 40 ? [m] : [])).slice(0, HOUSE_LIMITS.modes) : [],
      position: position === undefined ? undefined : Math.max(0, Math.min(100, Math.round(position))),
      supportedFeatures: person ? undefined : finite(e.features),
      unit: person ? undefined : line(e.unit, 20),
      mediaTitle: person ? undefined : line(e.title, HOUSE_LIMITS.nameChars),
      mediaArtist: person ? undefined : line(e.artist, HOUSE_LIMITS.nameChars),
      volumeLevel: volume === undefined ? undefined : Math.max(0, Math.min(1, volume)),
      // Home Assistant gives seconds; a value that is not a plausible time is "not said".
      lastChanged: changed !== undefined && changed > 0 && changed < 8_640_000_000_000 ? Math.round(changed * 1000) : 0,
      security: domain === "cover" && deviceClass !== undefined && SECURITY_COVER_CLASSES.includes(deviceClass),
      // Ticked one by one: only a line whose left side is this scene's or script's own entity id.
      runnable: kind === "scene" && aliases.has(normalizePhrase(id))
    })
  }
  return { ok: true, house: { areas, entities, byId: new Map(entities.map((e) => [e.entityId, e])), leftOut, fetchedAt } }
}

/** Names without repeats (ignoring case and punctuation) and without `exclude`, each one line within the bounds, at most `HOUSE_LIMITS.aliases`. */
const unique = (values: ReadonlyArray<string>, exclude: string): Array<string> => {
  const seen = new Set([normalizePhrase(exclude)])
  const out: Array<string> = []
  for (const raw of values) {
    const v = line(raw, HOUSE_LIMITS.nameChars)
    if (v === undefined) continue
    const k = normalizePhrase(v)
    if (k === "" || seen.has(k)) continue
    seen.add(k)
    out.push(v)
    if (out.length === HOUSE_LIMITS.aliases) break
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// What the actions act on

/** The kinds a typed action changes. */
export type ChangeKind = "light" | "switch" | "climate" | "cover"

/** Whether an entity is one this kind's actions may act on (a cover's security class is judged separately). */
const actsOn = (kind: ChangeKind | "scene", e: Entity): boolean => e.kind === kind && (kind !== "scene" || e.runnable)

/** Option values: `here`, `all`, `area:<id>`, an entity id; a target that holds a security cover starts with `secure:`. */
export const SECURE = "secure:"
export const HERE = "here"
export const ALL = "all"

const HERE_ALIASES = ["here", "in here", "this room", "the room", "hier", "deze kamer", "in deze kamer"]

const ALL_ALIASES: Readonly<Record<ChangeKind, ReadonlyArray<string>>> = {
  light: ["all lights", "every light", "all the lights", "everything", "the whole house", "alle lampen", "alle lichten", "overal"],
  switch: ["all switches", "every switch", "all the switches", "alle schakelaars"],
  climate: ["all the heating", "every thermostat", "everywhere", "de hele verwarming", "alle verwarming", "overal"],
  cover: ["all blinds", "every blind", "all the blinds", "all the shades", "alle zonwering", "alle rolluiken", "alle gordijnen"]
}
const ALL_LABEL: Readonly<Record<ChangeKind, string>> = { light: "All lights", switch: "All switches", climate: "All heating", cover: "All blinds" }
const NOUN: Readonly<Record<ChangeKind, ReadonlyArray<string>>> = {
  light: ["lights", "light"],
  switch: ["switches", "switch"],
  climate: ["heating", "thermostat"],
  cover: ["blinds", "blind", "shades"]
}

/**
 * The options of a target parameter for one kind, in this order: `here` (the asking device's room), each area that has
 * one of these things, every one of them (`all`), then each thing by name. Choice parameters are capped at 255 options
 * (`MAX_CHOICE_OPTIONS`), so areas come first. For covers, an area that holds a garage door, a gate or a door and each
 * such cover have a `secure:` value, which the cover actions' risk function classes `security`; `all` covers are the
 * blinds and shades only.
 */
export const targetOptions = (house: House, kind: ChangeKind, allAliases: ReadonlyArray<string> = []): Array<ParamOption> => {
  const things = house.entities.filter((e) => actsOn(kind, e))
  // A generated room name ("Bedroom blinds") never shadows a device of that very name: the device is meant.
  const thingNames = new Set(things.flatMap((e) => [e.name, ...e.aliases].map(normalizePhrase)))
  const options: Array<ParamOption> = [{ value: HERE, label: "Here", aliases: HERE_ALIASES, description: "The room of the device that is asked" }]
  for (const a of house.areas) {
    const inArea = things.filter((e) => e.areaId === a.id)
    if (inArea.length === 0) continue
    const secure = kind === "cover" && inArea.some((e) => e.security)
    options.push({
      value: `${secure ? SECURE : ""}area:${a.id}`,
      label: a.name,
      aliases: unique([...a.aliases, ...NOUN[kind].map((n) => `${a.name} ${n}`).filter((n) => !thingNames.has(normalizePhrase(n)))], a.name),
      description: `Every one in the ${a.name} area`
    })
  }
  if (things.some((e) => !e.security)) {
    options.push({ value: ALL, label: ALL_LABEL[kind], aliases: unique([...ALL_ALIASES[kind], ...allAliases], ALL_LABEL[kind]), description: kind === "cover" ? "Every blind and shade in the house (never a garage door, gate or door)" : "Every one in the house" })
  }
  for (const e of things) {
    const area = e.areaId === undefined ? undefined : house.areas.find((a) => a.id === e.areaId)
    options.push({
      value: `${e.security ? SECURE : ""}${e.entityId}`,
      label: e.name,
      aliases: e.aliases,
      description: area === undefined ? "One device" : `One device, in the ${area.name}`
    })
  }
  return options
}

/** The scenes and scripts the owner named, as options. */
export const sceneOptions = (house: House): Array<ParamOption> =>
  house.entities.filter((e) => actsOn("scene", e)).map((e) => ({ value: e.entityId, label: e.name, aliases: e.aliases, description: e.domain === "scene" ? "A scene" : "A script" }))

/** The area a device's room names (`CurrentTurn.room`): by area name, id or the owner's other names, ignoring case. */
export const areaOfRoom = (house: House, room: string | undefined): Area | undefined => {
  if (room === undefined) return undefined
  const key = normalizePhrase(room)
  if (key === "") return undefined
  return house.areas.find((a) => [a.name, a.id, ...a.aliases].some((n) => normalizePhrase(n) === key))
}

/** What a target value stands for now. */
export type Resolved =
  | { readonly _tag: "things"; readonly things: ReadonlyArray<Entity>; readonly scope: { readonly _tag: "area"; readonly area: Area } | { readonly _tag: "all" } | { readonly _tag: "one"; readonly entity: Entity } }
  /** `here` on a device without a room. */
  | { readonly _tag: "noRoom" }
  /** `here` in a room that is no area. */
  | { readonly _tag: "roomUnknown"; readonly room: string }
  /** An area without any of these things. */
  | { readonly _tag: "empty"; readonly area: Area | undefined }
  /** A value that is no longer in the house (renamed or removed since it was chosen). */
  | { readonly _tag: "unknown"; readonly value: string }

/** Resolve a target value (an option's value) for a kind, with the asking device's room for `here`. */
export const resolveTarget = (house: House, kind: ChangeKind, value: string, room: string | undefined): Resolved => {
  const plain = value.startsWith(SECURE) ? value.slice(SECURE.length) : value
  const things = house.entities.filter((e) => actsOn(kind, e))
  const inArea = (area: Area): Resolved => {
    const found = things.filter((e) => e.areaId === area.id)
    return found.length === 0 ? { _tag: "empty", area } : { _tag: "things", things: found, scope: { _tag: "area", area } }
  }
  if (plain === HERE) {
    if (room === undefined || room.trim() === "") return { _tag: "noRoom" }
    const area = areaOfRoom(house, room)
    return area === undefined ? { _tag: "roomUnknown", room } : inArea(area)
  }
  if (plain === ALL) {
    const all = things.filter((e) => !e.security)
    return all.length === 0 ? { _tag: "empty", area: undefined } : { _tag: "things", things: all, scope: { _tag: "all" } }
  }
  if (plain.startsWith("area:")) {
    const area = house.areas.find((a) => a.id === plain.slice(5))
    return area === undefined ? { _tag: "unknown", value: plain } : inArea(area)
  }
  const entity = house.byId.get(plain)
  return entity === undefined || !actsOn(kind, entity) ? { _tag: "unknown", value: plain } : { _tag: "things", things: [entity], scope: { _tag: "one", entity } }
}

/** Entity ids grouped by domain, in chunks of at most `size` (one service call each). */
export const callsByDomain = (things: ReadonlyArray<Entity>, size = 50): Array<{ readonly domain: Domain; readonly ids: ReadonlyArray<string> }> => {
  const byDomain = new Map<Domain, Array<string>>()
  for (const e of things) byDomain.set(e.domain, [...(byDomain.get(e.domain) ?? []), e.entityId])
  const out: Array<{ domain: Domain; ids: Array<string> }> = []
  for (const [domain, ids] of byDomain) for (let i = 0; i < ids.length; i += size) out.push({ domain, ids: ids.slice(i, i + size) })
  return out
}

/** Cover features (Home Assistant's `CoverEntityFeature`): `SET_POSITION` is 4. */
export const COVER_SET_POSITION = 4
