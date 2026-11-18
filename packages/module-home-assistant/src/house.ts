import { normalizePhrase, NOT_ONE_LINE, type ParamOption, resolveOption } from "@pva/core"
import { HA_LIMITS } from "@pva/module-contracts"

/**
 * The house as Home Assistant describes it, read in **pages** of one rendered template (`POST /api/template` with
 * `variables`), so no answer is larger than `HOUSE_LIMITS.pageBytes` and decoding one never holds the main thread for
 * long (docs/MODULES.md §14, §15: the measured numbers are in docs/modules/home-assistant.md, "How large a house").
 * An entity's area is `area_id(entity)`: its own area, else its device's.
 *
 * What is read, and what is left out on purpose:
 *
 * - **Domains**: `DOMAINS` only. No script (this version runs none: what a script does cannot be seen from outside
 *   it), no `device_tracker`, `zone`, `camera`, `calendar`. A `person` is read with its id, name, state and last change
 *   and nothing else, for the `HomeAssistant` service only; the module's own tools never read or mention one.
 * - **Sensors**: only the device classes in `SENSOR_CLASSES`. A sensor without a class is never read (the companion
 *   app makes classless sensors that say where a phone is).
 * - **Covers**: every cover is read (a garage door's state is read), but only one of `BLIND_CLASSES` is ever moved.
 * - **Scenes**: only those the owner named under "Other names", each with the entities Home Assistant says it sets.
 * - **Bounds**: at most `HOUSE_LIMITS.supported` entities in all, read in this order: people, the kinds the service
 *   exposes (the shared `domains`), the module's other kinds; a house with more is **incomplete**, and the kinds whose
 *   read was cut say so. Ids that are not Home Assistant's form or are longer than `idChars` are left out (never cut);
 *   names are one line, cut to `nameChars`.
 * - **Secrets**: an entity or area any of whose texts holds the configured token or a secret part of the address is
 *   left out whole and counted (`secretDropped`); nothing is rewritten in place. Home Assistant cuts its texts at
 *   `keep` characters, which is the longest bound plus the longest secret, so a secret that starts inside the part
 *   the module keeps is always seen whole.
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

/**
 * The only covers this version moves: Home Assistant's blind-like classes. Every other cover (a garage door, a gate, a
 * door, a window, a damper, a class this module does not know, and a cover **without** a class) is read, never moved.
 */
export const BLIND_CLASSES: ReadonlyArray<string> = ["awning", "blind", "curtain", "shade", "shutter"]

/** The contract's bounds (`HA_LIMITS`), and the module's own. */
export const HOUSE_LIMITS = {
  /** The supported house: at most this many entities (people, devices, sensors) in all. */
  supported: 2_000,
  /** Rows one page asks for; a page whose answer is too large is asked again in eighths. */
  pageRows: 200,
  /** The largest answer of one page, so one `JSON.parse` stays within a few milliseconds. */
  pageBytes: 256 * 1024,
  areas: HA_LIMITS.areas,
  idChars: HA_LIMITS.idChars,
  nameChars: HA_LIMITS.nameChars,
  stateChars: HA_LIMITS.stateChars,
  aliases: HA_LIMITS.aliases,
  modes: 20,
  /** The most entities a scene may set for it to be checked (a longer list is not offered). */
  sceneMembers: 100,
  /** The most named scenes read. */
  scenes: 100
} as const

/** The kinds of the `domains` setting. */
export type ChoiceKind = "light" | "switch" | "climate" | "cover" | "media_player" | "sensor" | "lock"
export const CHOICE_KINDS: ReadonlyArray<ChoiceKind> = ["light", "switch", "climate", "cover", "media_player", "sensor", "lock"]

/** The kinds of things the module knows: the choices, scenes the owner named, and people (for the service only). */
export type Kind = ChoiceKind | "scene" | "person"

/** The Home Assistant domains of each kind. */
export const KIND_DOMAINS: Readonly<Record<Kind, ReadonlyArray<Domain>>> = {
  light: ["light"],
  switch: ["switch", "fan", "input_boolean"],
  climate: ["climate"],
  cover: ["cover"],
  media_player: ["media_player"],
  sensor: ["sensor", "binary_sensor"],
  lock: ["lock", "alarm_control_panel"],
  scene: ["scene"],
  person: ["person"]
}

export const kindOf = (domain: Domain): Kind => (Object.keys(KIND_DOMAINS) as Array<Kind>).find((k) => KIND_DOMAINS[k].includes(domain))!

/**
 * One page of the house (`variables`: `domains`, `after`, `size`, `with_areas`, `ids`, `keep`, `classes`,
 * `max_areas`, `max_members`): the entities of `domains` whose id sorts after `after`, at most `size` of them in id
 * order (or exactly the entities `ids` names), each text cut by Home Assistant at `keep` characters; with
 * `with_areas`, the areas too. `last` is the last id the page looked at and `more` whether there are more after it.
 */
export const PAGE_TEMPLATE = String.raw`{%- set out = namespace(rows=[], areas=[]) -%}
{%- if with_areas -%}{%- for a in areas()[:max_areas] -%}{%- set out.areas = out.areas + [{"id": a, "name": ((area_name(a) or "") | string)[:keep]}] -%}{%- endfor -%}{%- endif -%}
{%- if ids is not none -%}{%- set picked = states | selectattr("entity_id", "in", ids) | sort(attribute="entity_id") | list -%}
{%- else -%}{%- set picked = states | selectattr("domain", "in", domains) | selectattr("entity_id", "gt", after) | sort(attribute="entity_id") | list -%}{%- endif -%}
{%- set page = picked[:size] -%}
{%- for s in page -%}
{%- set a = s.attributes -%}
{%- if s.domain == "person" -%}
{%- set out.rows = out.rows + [{"id": s.entity_id, "name": (s.name | string)[:keep], "state": (s.state | string)[:keep], "changed": as_timestamp(s.last_changed, none)}] -%}
{%- elif s.domain not in ["sensor", "binary_sensor"] or (a.device_class | default("")) in classes -%}
{%- set m = namespace(items=none, count=none) -%}
{%- if s.domain == "scene" and a.entity_id is iterable and a.entity_id is not string -%}
{%- set m.count = a.entity_id | length -%}{%- set m.items = [] -%}
{%- for x in a.entity_id[:max_members] -%}{%- set m.items = m.items + [{"id": (x | string)[:keep], "class": state_attr(x, "device_class")}] -%}{%- endfor -%}
{%- endif -%}
{%- set out.rows = out.rows + [{"id": s.entity_id, "name": (s.name | string)[:keep], "state": (s.state | string)[:keep], "changed": as_timestamp(s.last_changed, none), "area": area_id(s.entity_id), "class": (a.device_class[:keep] if a.device_class is string else none), "brightness": a.brightness | default(none), "current": a.current_temperature | default(none), "target": a.temperature | default(none), "modes": ((a.hvac_modes | list)[:20] if a.hvac_modes is iterable and a.hvac_modes is not string else none), "position": a.current_position | default(none), "features": a.supported_features | default(none), "unit": (a.unit_of_measurement[:keep] if a.unit_of_measurement is string else none), "title": (a.media_title[:keep] if a.media_title is string else none), "artist": (a.media_artist[:keep] if a.media_artist is string else none), "volume": a.volume_level | default(none), "members": m.items, "member_count": m.count}] -%}
{%- endif -%}
{%- endfor -%}
{{ {"areas": (out.areas if with_areas else none), "entities": out.rows, "last": ((page | last).entity_id if page else none), "more": (picked | length) > size} | to_json }}`

/** The variables of one page. */
export interface PageVariables {
  readonly domains: ReadonlyArray<string>
  readonly after: string
  readonly size: number
  readonly with_areas: boolean
  readonly ids: ReadonlyArray<string> | null
  readonly keep: number
  readonly classes: ReadonlyArray<string>
  readonly max_areas: number
  readonly max_members: number
}

export interface Area {
  /** Home Assistant's area id: "living_room". */
  readonly id: string
  readonly name: string
  /** The owner's other names for it ("Other names"). */
  readonly aliases: ReadonlyArray<string>
}

/** One entity a scene sets, as Home Assistant's state of the scene lists it. */
export interface SceneMember {
  readonly entityId: string
  readonly domain: string
  readonly deviceClass: string | undefined
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
  /** In the installation's unit (`House.temperatureUnit`). */
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
  /** A cover of one of `BLIND_CLASSES`: the only covers that are moved. */
  readonly blind: boolean
  /** A scene: the entities it sets (`undefined`: Home Assistant listed none). */
  readonly members: ReadonlyArray<SceneMember> | undefined
  /** A scene the owner named whose every member is of a kind this module would change itself. */
  readonly runnable: boolean
  /** Why a named scene is not runnable (for its refusal). */
  readonly notRunnable: "noList" | "unsafe" | undefined
}

export type TemperatureUnit = "C" | "F"

export interface House {
  readonly areas: ReadonlyArray<Area>
  readonly entities: ReadonlyArray<Entity>
  readonly byId: ReadonlyMap<string, Entity>
  /** The kinds whose read was cut at the supported size: answers about them that need the whole list say so. */
  readonly incomplete: ReadonlySet<Kind>
  /** Entities and areas left out because they were not of Home Assistant's form or over a bound. */
  readonly leftOut: number
  /** Entities and areas left out because a text of theirs held a configured secret. */
  readonly secretDropped: number
  /** The installation's temperature unit (`GET /api/config`), `undefined` when it was not read. */
  readonly temperatureUnit: TemperatureUnit | undefined
  readonly fetchedAt: number
}

const ENTITY_ID = /^([a-z0-9_]+)\.[a-z0-9_]+$/
const AREA_ID = /^[a-z0-9_]+$/

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** One line, cut to `max` (Home Assistant names are the owner's; they still reach prompts and speech). */
export const line = (u: unknown, max: number): string | undefined => {
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
 * Owner aliases, one line per room, device or scene: `Living room: lounge, woonkamer` (`=` works too). The left side
 * is matched against area names and ids, entity names and ids, or `all` / `all lights` (other names for every light).
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

/** The scene and script ids the owner named under their own id ("scene.movie_time: movie time"), as written. */
export const namedIds = (text: string): { readonly scenes: ReadonlyArray<string>; readonly scripts: ReadonlyArray<string> } => {
  const scenes = new Set<string>()
  const scripts = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const key = /^\s*([^:=#]+)[:=]/.exec(raw)?.[1]?.trim().toLowerCase()
    if (key === undefined || !ENTITY_ID.test(key) || key.length > HOUSE_LIMITS.idChars) continue
    if (key.startsWith("scene.")) scenes.add(key)
    if (key.startsWith("script.")) scripts.add(key)
  }
  return { scenes: [...scenes].sort().slice(0, HOUSE_LIMITS.scenes), scripts: [...scripts].sort() }
}

/** Whether a scene member is of a kind this module would change itself: a light, a blind, a thermostat, a media player. */
export const safeMember = (m: SceneMember): boolean =>
  m.domain === "light" || m.domain === "climate" || m.domain === "media_player" || (m.domain === "cover" && m.deviceClass !== undefined && BLIND_CLASSES.includes(m.deviceClass))

/** Whether any of `texts` holds one of `secrets` (each at least one character, exactly as configured). */
const holdsSecret = (secrets: ReadonlyArray<string>, texts: ReadonlyArray<unknown>): boolean => {
  if (secrets.length === 0) return false
  for (const t of texts) {
    if (typeof t === "string") {
      for (const s of secrets) if (s.length > 0 && t.includes(s)) return true
    } else if (Array.isArray(t)) {
      if (holdsSecret(secrets, t)) return true
    } else if (isRecord(t)) {
      if (holdsSecret(secrets, Object.keys(t)) || holdsSecret(secrets, Object.values(t))) return true
    }
  }
  return false
}

/** How long Home Assistant may leave a text so that a secret that starts inside what is kept is seen whole. */
export const keepChars = (secrets: ReadonlyArray<string>): number =>
  Math.max(HOUSE_LIMITS.nameChars, HOUSE_LIMITS.stateChars, HOUSE_LIMITS.idChars) + Math.max(0, ...secrets.map((s) => s.length)) + 1

/** One page, decoded: its raw rows checked one by one (the entity is built later, with the owner's names). */
export type DecodedPage =
  | {
    readonly ok: true
    readonly rows: ReadonlyArray<{ readonly id: string; readonly domain: Domain; readonly e: Record<string, unknown> }>
    readonly areas: ReadonlyArray<{ readonly id: string; readonly name: string }> | undefined
    readonly last: string | undefined
    readonly more: boolean
    readonly leftOut: number
    readonly secretDropped: number
  }
  | { readonly ok: false; readonly problem: string }

/** Decode one page's text: anything not of the expected shape is left out item by item; a text with a secret, whole. */
export const decodePage = (text: string, secrets: ReadonlyArray<string>): DecodedPage => {
  if (text.length > HOUSE_LIMITS.pageBytes) return { ok: false, problem: "the answer is too large" }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, problem: "the answer is not JSON" }
  }
  if (!isRecord(json) || !Array.isArray(json.entities) || (json.areas !== null && json.areas !== undefined && !Array.isArray(json.areas))) {
    return { ok: false, problem: "the answer is not the room list" }
  }
  let leftOut = 0
  let secretDropped = 0
  let areas: Array<{ id: string; name: string }> | undefined
  if (Array.isArray(json.areas)) {
    areas = []
    for (const a of json.areas) {
      if (!isRecord(a) || typeof a.id !== "string" || a.id.length > HOUSE_LIMITS.idChars || !AREA_ID.test(a.id)) {
        leftOut++
        continue
      }
      if (holdsSecret(secrets, [a.id, a.name])) {
        secretDropped++
        continue
      }
      areas.push({ id: a.id, name: line(a.name, HOUSE_LIMITS.nameChars) ?? prettyId(a.id) })
    }
  }
  const rows: Array<{ id: string; domain: Domain; e: Record<string, unknown> }> = []
  for (const e of json.entities) {
    const id = isRecord(e) ? e.id : undefined
    const match = typeof id === "string" && id.length <= HOUSE_LIMITS.idChars ? ENTITY_ID.exec(id) : null
    const domain = match?.[1] as Domain | undefined
    if (!isRecord(e) || match === null || domain === undefined || !(DOMAINS as ReadonlyArray<string>).includes(domain)) {
      leftOut++
      continue
    }
    // The template reads only these sensors; an answer that holds others (an older template, a proxy) loses them here.
    if ((domain === "sensor" || domain === "binary_sensor") && !(typeof e.class === "string" && (SENSOR_CLASSES as ReadonlyArray<string>).includes(e.class))) continue
    // Every text of the row, the person's included, before anything is cut: a secret anywhere drops the whole entity.
    if (holdsSecret(secrets, Object.values(e))) {
      secretDropped++
      continue
    }
    rows.push({ id: id as string, domain, e })
  }
  const last = typeof json.last === "string" ? json.last : undefined
  return { ok: true, rows, areas, last, more: json.more === true, leftOut, secretDropped }
}

/** Names without repeats (ignoring case and punctuation) and without `exclude`, each one line within the bounds, at most `HOUSE_LIMITS.aliases`. */
export const unique = (values: ReadonlyArray<string>, exclude: string): Array<string> => {
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

/** The owner's other names, looked up by the left side of their lines. */
export const ownerAliasesOf = (aliasText: string) => {
  const { aliases } = parseAliases(aliasText)
  return (...keys: ReadonlyArray<string>) => keys.flatMap((k) => aliases.get(normalizePhrase(k)) ?? [])
}

/** One decoded row as an entity, with the owner's other names; a person carries its name, state and last change only. */
export const toEntity = (row: { readonly id: string; readonly domain: Domain; readonly e: Record<string, unknown> }, owner: (...keys: ReadonlyArray<string>) => ReadonlyArray<string>, areaIds: ReadonlySet<string>, named: ReadonlySet<string>): Entity => {
  const { id, domain, e } = row
  const name = line(e.name, HOUSE_LIMITS.nameChars) ?? prettyId(id)
  const kind = kindOf(domain)
  const person = kind === "person"
  const area = !person && typeof e.area === "string" && areaIds.has(e.area) ? e.area : undefined
  const deviceClass = person ? undefined : line(e.class, HOUSE_LIMITS.idChars)
  const brightness = person ? undefined : finite(e.brightness)
  const position = person ? undefined : finite(e.position)
  const changed = finite(e.changed)
  const volume = person ? undefined : finite(e.volume)
  let members: Array<SceneMember> | undefined
  if (kind === "scene" && Array.isArray(e.members)) {
    members = []
    for (const m of e.members) {
      const mid = isRecord(m) && typeof m.id === "string" ? m.id : undefined
      const mm = mid !== undefined && mid.length <= HOUSE_LIMITS.idChars ? ENTITY_ID.exec(mid) : null
      members.push({ entityId: mid ?? "", domain: mm?.[1] ?? "", deviceClass: isRecord(m) && typeof m.class === "string" ? m.class : undefined })
    }
  }
  const memberCount = finite(e.member_count)
  const listed = members !== undefined && members.length > 0 && memberCount === members.length
  const isNamed = kind === "scene" && named.has(id)
  const safe = listed && members!.every(safeMember)
  return {
    entityId: id,
    domain,
    kind,
    name,
    aliases: person ? [] : unique(owner(id, name), name),
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
    blind: domain === "cover" && deviceClass !== undefined && BLIND_CLASSES.includes(deviceClass),
    members,
    runnable: isNamed && safe,
    notRunnable: !isNamed ? undefined : !listed ? "noList" : !safe ? "unsafe" : undefined
  }
}

/** Areas, sorted by id, bounded, with the owner's other names. */
export const toAreas = (rows: ReadonlyArray<{ readonly id: string; readonly name: string }>, owner: (...keys: ReadonlyArray<string>) => ReadonlyArray<string>): { readonly areas: Array<Area>; readonly leftOut: number } => {
  const sorted = [...rows].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  const seen = new Set<string>()
  const areas: Array<Area> = []
  for (const a of sorted) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    areas.push({ ...a, aliases: unique(owner(a.name, a.id), a.name) })
  }
  return { areas: areas.slice(0, HOUSE_LIMITS.areas), leftOut: Math.max(0, areas.length - HOUSE_LIMITS.areas) }
}

// ---------------------------------------------------------------------------------------------------------------------
// What the actions act on

/** The kinds a typed action changes. */
export type ChangeKind = "light" | "switch" | "climate" | "cover"

/** Whether an entity is one this kind's actions may act on: covers only of a blind class. */
export const actsOn = (kind: ChangeKind, e: Entity): boolean => e.kind === kind && (kind !== "cover" || e.blind)

/** Option values: `here`, `all`, `area:<id>`, an entity id, or `ask:<name>` for a name that is more than one thing. */
export const HERE = "here"
export const ALL = "all"
export const ASK = "ask:"

export const HERE_ALIASES = ["here", "in here", "this room", "the room", "hier", "deze kamer", "in deze kamer"]

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
 * The names one parameter takes, over the whole house: every option with names that point at one thing only. A name
 * (a label or an alias, ignoring case and punctuation) that two options share is taken from both and becomes one
 * `ask:` option, so it resolves to a question, never to whichever came first; a value (an id) always wins over a name
 * of another option. Exception: a name shared by an area and things that are all in that area is the area's (the
 * room means its lights).
 */
export interface NameIndex {
  /** Every option, in order: `here`, rooms, `all`, things, then the `ask:` options. */
  readonly options: ReadonlyArray<ParamOption>
  /** An `ask:` value → the labels of what it could mean. */
  readonly asks: ReadonlyMap<string, ReadonlyArray<string>>
}

interface Candidate {
  readonly value: string
  readonly label: string
  readonly names: ReadonlyArray<string>
  readonly description?: string
  /** The area id an area option stands for, or the area a thing is in. */
  readonly area?: string
  readonly isArea?: boolean
  readonly fixed?: boolean
}

/** Work done in steps: a generator that yields after every `STEP` items, run at once or with a real yield per step. */
export type Steps<A> = Generator<void, A, void>
const STEP = 100

/** Run steps to the end at once (small lists, tests, the Test button). */
export const runSteps = <A>(steps: Steps<A>): A => {
  for (;;) {
    const r = steps.next()
    if (r.done === true) return r.value
  }
}

function* indexSteps(candidates: ReadonlyArray<Candidate>): Steps<NameIndex> {
  // One normalisation per text: the same names are compared several times.
  const normal = new Map<string, string>()
  const norm = (t: string) => {
    let n = normal.get(t)
    if (n === undefined) {
      n = normalizePhrase(t)
      normal.set(t, n)
    }
    return n
  }
  // A value is a name of its own option, and wins over the same words as another option's name.
  const valueOwner = new Map<string, Candidate>()
  for (const [i, c] of candidates.entries()) {
    const v = norm(c.value)
    if (v !== "" && !valueOwner.has(v)) valueOwner.set(v, c)
    if (i % STEP === STEP - 1) yield
  }
  const holders = new Map<string, Array<Candidate>>()
  const shown = new Map<string, string>()
  for (const [i, c] of candidates.entries()) {
    for (const x of [c.label, ...c.names]) {
      const n = norm(x)
      if (n === "") continue
      const list = holders.get(n)
      if (list === undefined) holders.set(n, [c])
      else if (!list.includes(c)) list.push(c)
      if (!shown.has(n)) shown.set(n, x)
    }
    if (i % STEP === STEP - 1) yield
  }
  const taken = new Map<Candidate, Set<string>>()
  const asks = new Map<string, Array<Candidate>>()
  const askOrder: Array<string> = []
  const take = (c: Candidate, n: string) => {
    const t = taken.get(c) ?? new Set<string>()
    t.add(n)
    taken.set(c, t)
  }
  let i = 0
  for (const [n, list] of holders) {
    if (++i % STEP === 0) yield
    const owner = valueOwner.get(n)
    if (owner !== undefined) {
      for (const c of list) if (c !== owner) take(c, n)
      continue
    }
    if (list.length < 2) continue
    // The fixed options (here, all) keep their own names.
    const fixed = list.filter((c) => c.fixed === true)
    const rooms = list.filter((c) => c.isArea === true)
    const winner = fixed.length === 1
      ? fixed[0]
      : rooms.length === 1 && list.every((c) => c === rooms[0] || (c.isArea !== true && c.area === rooms[0]!.area))
      ? rooms[0]
      : undefined
    for (const c of list) if (c !== winner) take(c, n)
    if (winner === undefined) {
      asks.set(`${ASK}${n}`, list)
      askOrder.push(n)
    }
  }
  const options: Array<ParamOption> = []
  const finalLabel = new Map<Candidate, string>()
  for (const [j, c] of candidates.entries()) {
    const gone = taken.get(c)
    const keepLabel = gone === undefined || !gone.has(norm(c.label))
    // A label another option shares is shown with the id, so every option still has a name of its own.
    const label = keepLabel ? c.label : `${c.label} (${c.value.replace(/^area:/, "")})`
    finalLabel.set(c, label)
    const aliases = gone === undefined ? c.names : c.names.filter((x) => !gone.has(norm(x)))
    options.push({ value: c.value, label, aliases: unique(aliases, label), ...(c.description !== undefined ? { description: c.description } : {}) })
    if (j % STEP === STEP - 1) yield
  }
  // A question names each thing as its own option is labelled ("Shared (alpha)", "Shared (beta)").
  const askLabels = new Map<string, ReadonlyArray<string>>()
  for (const n of askOrder) {
    const labels = asks.get(`${ASK}${n}`)!.map((c) => finalLabel.get(c) ?? c.label)
    askLabels.set(`${ASK}${n}`, labels)
    options.push({ value: `${ASK}${n}`, label: shown.get(n) ?? n, description: `More than one: ${labels.slice(0, 5).join(", ")}` })
  }
  return { options, asks: askLabels }
}

export const indexNames = (candidates: ReadonlyArray<Candidate>): NameIndex => runSteps(indexSteps(candidates))

/** The names of a target parameter of one kind, over the whole house, in steps. `allAliases`: the owner's other names for every light. */
export function* targetIndexSteps(house: House, kind: ChangeKind, allAliases: ReadonlyArray<string> = []): Steps<NameIndex> {
  const things = house.entities.filter((e) => actsOn(kind, e))
  // A generated room name ("Bedroom blinds") never shadows a device of that very name: the device is meant.
  const thingNames = new Set<string>()
  for (const [i, e] of things.entries()) {
    thingNames.add(normalizePhrase(e.name))
    for (const a of e.aliases) thingNames.add(normalizePhrase(a))
    if (i % STEP === STEP - 1) yield
  }
  const areaById = new Map(house.areas.map((a) => [a.id, a]))
  const withThings = new Set(things.flatMap((e) => (e.areaId === undefined ? [] : [e.areaId])))
  const candidates: Array<Candidate> = [{ value: HERE, label: "Here", names: HERE_ALIASES, description: "The room of the device that is asked", fixed: true }]
  for (const a of house.areas) {
    if (!withThings.has(a.id)) continue
    candidates.push({
      value: `area:${a.id}`,
      label: a.name,
      names: [...a.aliases, a.id.replace(/_/g, " "), ...NOUN[kind].map((n) => `${a.name} ${n}`).filter((n) => !thingNames.has(normalizePhrase(n)))],
      description: `Every one in the ${a.name} area`,
      area: a.id,
      isArea: true
    })
  }
  yield
  if (things.length > 0) {
    candidates.push({ value: ALL, label: ALL_LABEL[kind], names: [...ALL_ALIASES[kind], ...allAliases], description: kind === "cover" ? "Every blind, curtain, shade, shutter and awning in the house" : "Every one in the house", fixed: true })
  }
  for (const e of things) {
    const area = e.areaId === undefined ? undefined : areaById.get(e.areaId)
    candidates.push({ value: e.entityId, label: e.name, names: e.aliases, description: area === undefined ? "One device" : `One device, in the ${area.name}`, ...(e.areaId !== undefined ? { area: e.areaId } : {}) })
  }
  return yield* indexSteps(candidates)
}

export const targetIndex = (house: House, kind: ChangeKind, allAliases: ReadonlyArray<string> = []): NameIndex => runSteps(targetIndexSteps(house, kind, allAliases))

/** The names of a room parameter: `here` and every area, in steps. */
export const roomIndexSteps = (house: House): Steps<NameIndex> =>
  indexSteps([
    { value: HERE, label: "Here", names: HERE_ALIASES, fixed: true },
    ...house.areas.map((a): Candidate => ({ value: `area:${a.id}`, label: a.name, names: [...a.aliases, a.id.replace(/_/g, " ")], area: a.id, isArea: true }))
  ])
export const roomIndex = (house: House): NameIndex => runSteps(roomIndexSteps(house))

/**
 * The names of the scene parameter: the scenes the owner named (only those are read). One that may not run is a name
 * too, so asking for it is refused with the reason rather than "unknown".
 */
export const sceneIndexSteps = (house: House): Steps<NameIndex> =>
  indexSteps(house.entities.filter((e) => e.kind === "scene").map((e): Candidate => ({
    value: e.entityId,
    label: e.name,
    names: e.aliases,
    description: e.runnable ? "A scene" : "A scene that is not started by voice (it sets something this module does not change)"
  })))
export const sceneIndex = (house: House): NameIndex => runSteps(sceneIndexSteps(house))

/**
 * What a spoken or written name stands for, over the whole index (never only the options a choice list could carry):
 * an exact value or id first, then the core's matching (case, punctuation, a leading article, then sound-alike).
 */
export const resolveName = (index: NameIndex, name: string): string | undefined => {
  const raw = name.trim()
  if (raw === "") return undefined
  const exact = index.options.find((o) => o.value === raw || o.value === `area:${raw}`)
  if (exact !== undefined) return exact.value
  return resolveOption(index.options, raw)?.value
}

/**
 * What a whole request names, for a parameter that takes free text (a house too large for a choice list: the intent
 * agent then passes the request itself). The name alone first (`resolveName`); else the longest option name the words
 * contain, when one option has it (two: the name is a question); else, when every word is one of the action's own
 * (`vocabulary`: its verbs, nouns and fillers), the request names nothing and means `here`; anything else is not known.
 */
export const resolveInSentence = (index: NameIndex, text: string, vocabulary: ReadonlySet<string>): string | undefined => {
  const direct = resolveName(index, text)
  if (direct !== undefined) return direct
  const words = normalizePhrase(text).split(" ").filter((w) => w !== "")
  if (words.length === 0) return undefined
  const padded = ` ${words.join(" ")} `
  let best: { readonly length: number; readonly values: Set<string> } | undefined
  for (const o of index.options) {
    for (const n of [o.label, ...(o.aliases ?? [])]) {
      const k = normalizePhrase(n)
      if (k === "" || !padded.includes(` ${k} `)) continue
      const length = k.split(" ").length
      if (best === undefined || length > best.length) best = { length, values: new Set([o.value]) }
      else if (length === best.length) best.values.add(o.value)
    }
  }
  if (best !== undefined) {
    if (best.values.size === 1) return [...best.values][0]
    const ask = index.options.find((o) => o.value.startsWith(ASK) && [...best!.values].some((v) => v === o.value))
    return ask?.value
  }
  return words.every((w) => vocabulary.has(w) || /^\d+([.,]\d+)?$/.test(w)) ? HERE : undefined
}

/** The area a device's room names (`CurrentTurn.room`): one area by name, id or other name; more than one is a question. */
export const areaOfRoom = (house: House, room: string | undefined): { readonly _tag: "area"; readonly area: Area } | { readonly _tag: "none" } | { readonly _tag: "ambiguous"; readonly labels: ReadonlyArray<string> } => {
  if (room === undefined) return { _tag: "none" }
  const key = normalizePhrase(room)
  if (key === "") return { _tag: "none" }
  const byId = house.areas.find((a) => a.id === room.trim())
  if (byId !== undefined) return { _tag: "area", area: byId }
  const found = house.areas.filter((a) => [a.name, a.id.replace(/_/g, " "), ...a.aliases].some((n) => normalizePhrase(n) === key))
  if (found.length === 1) return { _tag: "area", area: found[0]! }
  if (found.length > 1) return { _tag: "ambiguous", labels: found.map((a) => `${a.name} (${a.id})`) }
  return { _tag: "none" }
}

/** What a target value stands for now. */
export type Resolved =
  | { readonly _tag: "things"; readonly things: ReadonlyArray<Entity>; readonly scope: { readonly _tag: "area"; readonly area: Area } | { readonly _tag: "all" } | { readonly _tag: "one"; readonly entity: Entity } }
  /** `here` on a device without a room. */
  | { readonly _tag: "noRoom" }
  /** `here` in a room that is no area. */
  | { readonly _tag: "roomUnknown"; readonly room: string }
  /** A name (or the device's room) that is more than one thing. */
  | { readonly _tag: "ambiguous"; readonly name: string; readonly labels: ReadonlyArray<string> }
  /** An area without any of these things, or a house without any. */
  | { readonly _tag: "empty"; readonly area: Area | undefined }
  /** `all` in a house read only in part: the rest cannot be reached, so it asks for a room. */
  | { readonly _tag: "incomplete" }
  /** A value that is not in the house (renamed or removed since it was chosen, or never there). */
  | { readonly _tag: "unknown"; readonly value: string }

/** Resolve a target (an option's value, or a name) for a kind, with the asking device's room for `here`. */
export const resolveTarget = (
  house: House,
  kind: ChangeKind,
  index: NameIndex,
  input: string,
  room: string | undefined,
  resolve: (index: NameIndex, text: string) => string | undefined = resolveName
): Resolved => {
  const value = resolve(index, input)
  if (value === undefined) return { _tag: "unknown", value: input }
  if (value.startsWith(ASK)) return { _tag: "ambiguous", name: index.options.find((o) => o.value === value)?.label ?? input, labels: index.asks.get(value) ?? [] }
  const things = house.entities.filter((e) => actsOn(kind, e))
  const inArea = (area: Area): Resolved => {
    const found = things.filter((e) => e.areaId === area.id)
    return found.length === 0 ? { _tag: "empty", area } : { _tag: "things", things: found, scope: { _tag: "area", area } }
  }
  if (value === HERE) {
    if (room === undefined || room.trim() === "") return { _tag: "noRoom" }
    const a = areaOfRoom(house, room)
    if (a._tag === "ambiguous") return { _tag: "ambiguous", name: room, labels: a.labels }
    return a._tag === "none" ? { _tag: "roomUnknown", room } : inArea(a.area)
  }
  if (value === ALL) {
    if (house.incomplete.has(kind)) return { _tag: "incomplete" }
    return things.length === 0 ? { _tag: "empty", area: undefined } : { _tag: "things", things, scope: { _tag: "all" } }
  }
  if (value.startsWith("area:")) {
    const area = house.areas.find((a) => a.id === value.slice(5))
    return area === undefined ? { _tag: "unknown", value: input } : inArea(area)
  }
  const entity = house.byId.get(value)
  return entity === undefined || !actsOn(kind, entity) ? { _tag: "unknown", value: input } : { _tag: "things", things: [entity], scope: { _tag: "one", entity } }
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
