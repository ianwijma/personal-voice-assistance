import {
  ActionError,
  type ActionDefinition,
  CurrentTurn,
  defineAction,
  defineModule,
  type FieldActionResult,
  type Issue,
  makeTool,
  type ModuleInstance,
  ModuleStartError,
  Param,
  type ParamOption,
  resolveOption,
  Setting,
  type SettingsOf,
  type SharedContext,
  ToolError
} from "@pva/core"
import { Clock, Effect, Schema } from "effect"
import { checkAddressSetting, type HomeAssistantClient, HomeAssistantError, makeHomeAssistantClient, normalizeBaseUrl } from "./client.ts"
import {
  ALL,
  areaOfRoom,
  callsByDomain,
  type ChangeKind,
  checkAliases,
  COVER_SET_POSITION,
  decodeHouse,
  type Entity,
  HERE,
  type House,
  HOUSE_LIMITS,
  INVENTORY_TEMPLATE,
  type Kind,
  type Resolved,
  resolveTarget,
  SECURE,
  sceneOptions,
  targetOptions
} from "./house.ts"
import { addressSecrets, clip, fromUpstream, sanitize, type Secrets, secretList } from "./redact.ts"
import { homeLanguage, joinList, type Language, say, sentence, spokenNumber, type TextKey } from "./texts.ts"

export interface HomeAssistantDeps {
  /** Injected in tests (an in-process fake: no test reaches the network). Default: the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  /** How often the house is read again in the background. Default 60 s. */
  readonly refreshMs?: number | undefined
}

const DEFAULT_REFRESH_MS = 60_000
/** A call made for a turn: an action has 5 s in all (docs/MODULES.md §10), so one call has at most 3 s. */
const TURN_CALL_MS = 3_000
/** Each of the two requests of the start (and of the health check): together within the host's 10 s. */
const START_CALL_MS = 4_000

/** The kinds of the `domains` setting (scenes and scripts are offered when the owner names them, see "Other names"). */
const DOMAIN_CHOICES = [
  { value: "light", label: "Lights" },
  { value: "switch", label: "Switches, fans and on/off helpers" },
  { value: "climate", label: "Heating and cooling" },
  { value: "cover", label: "Blinds and shades (garage doors, gates and doors are only read)" },
  { value: "media_player", label: "Media players (only read)" },
  { value: "sensor", label: "Temperature, humidity, door and window sensors (only read)" },
  { value: "lock", label: "Locks and alarm panels (only read)" }
] as const

const settings = {
  baseUrl: Setting.text({
    label: "Address",
    description: "Where Home Assistant runs, for example http://homeassistant.local:8123.",
    placeholder: "http://homeassistant.local:8123",
    env: "HOME_ASSISTANT_URL",
    maxLength: 300,
    check: (v) => checkAddressSetting(v)
  }),
  token: Setting.secret({
    label: "Long-lived access token",
    description: "Create one in Home Assistant under your profile → Security → Long-lived access tokens. " +
      "The user must be an administrator (the room list is read through the template API, which is admin only).",
    env: "HOME_ASSISTANT_TOKEN",
    required: true
  }),
  domains: Setting.multichoice({
    label: "Devices to use",
    description: "What the assistant may see and switch. Locks, alarm panels, garage doors, gates and doors are only ever read: " +
      "changing them is refused. Every device of a chosen kind is used, so leave out a kind you do not want an assistant to touch.",
    default: DOMAIN_CHOICES.map((c) => c.value),
    options: DOMAIN_CHOICES,
    // An assistant may use fewer kinds of devices than the others (docs/ASSISTANTS.md §4.1).
    overridable: true
  }),
  aliases: Setting.text({
    label: "Other names",
    description: "One line per room, device, scene or script: the name or id in Home Assistant, a colon, then other names " +
      "you use, separated by commas. A device's room is matched to a Home Assistant area by these names too. " +
      "A scene or script can be started only when it has a line here under its own id (scene.movie_time: movie time): " +
      "what a script does cannot be seen from outside it, so you choose them one by one.",
    placeholder: "Living room: lounge, woonkamer\nDesk lamp: bureaulamp\nscene.movie_time: movie time, filmavond",
    multiline: true,
    maxLength: 4000,
    check: checkAliases
  }),
  timeoutMs: Setting.number({
    label: "Timeout",
    description: "Longest one request to Home Assistant may take; a spoken reply cannot wait much longer (a command waits at most 3 seconds).",
    default: 2000,
    integer: true,
    min: 300,
    max: 10_000,
    step: 100,
    unit: "ms",
    advanced: true
  }),
  // What the running module sees, and a Test button that also works before the address is saved.
  server: Setting.info({ label: "Connected to" }),
  lists: Setting.info({ label: "Rooms and devices" }),
  test: Setting.action({
    label: "Test the connection",
    description: "Connects with the address above (saved or not) and the saved token, and reads the room list.",
    buttonLabel: "Test",
    requiresSaved: false
  })
}

type HomeAssistantSettings = SettingsOf<typeof settings>

// ---------------------------------------------------------------------------------------------------------------------
// Errors in words

/** What a failure of Home Assistant is called, in the household's language. A change that timed out may have happened. */
const failureText = (lang: Language, e: HomeAssistantError, change: boolean): string => {
  switch (e.kind) {
    case "unreachable":
      return say(lang, "unreachable")
    case "timeout":
      return say(lang, change ? "timeoutChange" : "timeoutRead")
    case "unauthorized":
      return say(lang, "unauthorized")
    case "forbidden":
      return say(lang, "forbidden")
    case "http":
      return say(lang, e.status === 503 ? "restarting" : "failed")
    case "invalid":
      return say(lang, "invalid")
  }
}

/** The only way a `ModuleStartError` is made once a token is known: message and cause sanitised (see `redact.ts`). */
const moduleStartError = (secrets: Secrets, fields: ConstructorParameters<typeof ModuleStartError>[0]): ModuleStartError =>
  new ModuleStartError(sanitize(secrets, fields))

const startErrorFields = (e: HomeAssistantError, baseUrl: string): ConstructorParameters<typeof ModuleStartError>[0] => {
  switch (e.kind) {
    case "unreachable":
    case "timeout":
      return { message: `Could not reach Home Assistant at ${baseUrl} (${e.detail}). Check the address.`, cause: e }
    case "unauthorized":
      return {
        message: "Home Assistant rejected the token. Create a long-lived access token in your Home Assistant profile (Security) and enter it here.",
        cause: e
      }
    case "forbidden":
      return { message: "Home Assistant accepted the token but refused to list rooms: the token's user must be an administrator.", cause: e }
    case "invalid":
      return { message: `Home Assistant at ${baseUrl} sent an answer this module cannot read (${e.detail}).`, cause: e }
    case "http":
      return { message: `Home Assistant at ${baseUrl} answered with an error (${e.detail}).`, cause: e }
  }
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

// ---------------------------------------------------------------------------------------------------------------------
// The shared part: one client and one cache of the house for every assistant

/** What every instance gets as `ctx.shared`. */
export interface HomeAssistantShared {
  /** The house as Home Assistant said last, or `undefined` before the first answer. */
  readonly house: () => House | undefined
  /** Why the last read failed, or `undefined` when it succeeded. */
  readonly problem: () => HomeAssistantError | undefined
  readonly config: () => { readonly version: string | undefined; readonly locationName: string | undefined } | undefined
  /** Read the house now (one request, at most `timeoutMs`); the cache follows unless a newer answer is already kept. */
  readonly load: (timeoutMs: number) => Effect.Effect<House, HomeAssistantError>
  readonly call: (domain: string, service: string, data: Readonly<Record<string, unknown>>, timeoutMs: number) => Effect.Effect<void, HomeAssistantError>
  /** The kinds the house had when this run started (`undefined`: not read yet): the instances offer actions for these. */
  readonly kindsAtStart: ReadonlySet<Kind> | undefined
  /** Read the house again soon, off the turn (a name was not found). */
  readonly refreshSoon: Effect.Effect<void>
  /** Called after every read; returns the unsubscribe. */
  readonly onChange: (listener: () => void) => () => void
  readonly baseUrl: string
  readonly secrets: Secrets
  readonly timeoutMs: number
}

/** The kinds a house has: each kind with at least one entity; scenes only those the owner named. */
export const kindsOf = (house: House): ReadonlySet<Kind> => {
  const kinds = new Set<Kind>()
  for (const e of house.entities) if (e.kind !== "scene" || e.runnable) kinds.add(e.kind)
  return kinds
}

const sameKinds = (a: ReadonlySet<Kind> | undefined, b: ReadonlySet<Kind>) => a !== undefined && a.size === b.size && [...a].every((k) => b.has(k))

/** The address and token, checked: a start error says what to fix, never repeating the address's credentials. */
const checkedConnection = (s: Partial<HomeAssistantSettings>): Effect.Effect<{ readonly baseUrl: string; readonly token: string }, ModuleStartError> =>
  Effect.gen(function*() {
    const problem = checkAddressSetting(s.baseUrl ?? "")
    if (problem !== undefined) return yield* new ModuleStartError({ message: `The Home Assistant address: ${problem}.` })
    const baseUrl = normalizeBaseUrl(s.baseUrl ?? "")
    if (baseUrl === undefined) return yield* new ModuleStartError({ message: "Enter the address of your Home Assistant server (for example http://homeassistant.local:8123)." })
    if (s.token === undefined) return yield* new ModuleStartError({ message: "Enter a long-lived access token from your Home Assistant profile." })
    return { baseUrl, token: s.token }
  })

const makeShared = (deps: HomeAssistantDeps, ctx: SharedContext<HomeAssistantSettings>) => {
  let secrets: Secrets = []
  return Effect.gen(function*() {
    const s = ctx.settings
    secrets = secretList(s.token, addressSecrets(s.baseUrl))
    const { baseUrl, token } = yield* checkedConnection(s)
    const timeoutMs = s.timeoutMs ?? 2000
    const aliases = s.aliases ?? ""
    const client: HomeAssistantClient = makeHomeAssistantClient({ baseUrl, token, timeoutMs, fetch: deps.fetch })
    const scope = yield* Effect.scope
    const listeners = new Set<() => void>()
    let house: House | undefined
    let problem: HomeAssistantError | undefined
    let config: { readonly version: string | undefined; readonly locationName: string | undefined } | undefined
    let kindsAtStart: ReadonlySet<Kind> | undefined
    let started = false

    const notify = () => {
      for (const l of listeners) l()
    }

    const read = (limitMs: number): Effect.Effect<House, HomeAssistantError> =>
      Effect.gen(function*() {
        const text = yield* client.renderTemplate(INVENTORY_TEMPLATE, { timeoutMs: limitMs, maxBytes: HOUSE_LIMITS.answerBytes })
        const decoded = decodeHouse(text, aliases, yield* Clock.currentTimeMillis)
        if (!decoded.ok) {
          return yield* new HomeAssistantError(sanitize(secrets, { message: "Home Assistant sent a room list this module cannot read.", kind: "invalid", detail: `POST /api/template: ${decoded.problem}` }))
        }
        return decoded.house
      })

    /**
     * One read, its outcome kept (the cache keeps the last good house when a read fails). Reads do not wait for each
     * other (a turn's read never queues behind a slow background one); each is numbered, and an answer older than one
     * already kept is dropped. Only the background read asks for the version (`/api/config`) again, so a turn's read is
     * one request.
     */
    let issued = 0
    let kept = 0
    const load = (limitMs: number, background = false): Effect.Effect<House, HomeAssistantError> =>
      Effect.gen(function*() {
        const n = ++issued
        if (background && config === undefined) {
          const c = yield* Effect.result(client.config({ timeoutMs: limitMs }))
          if (c._tag === "Success") config = c.success
        }
        const got = yield* Effect.result(read(limitMs))
        if (n < kept) return got._tag === "Success" ? got.success : yield* got.failure
        kept = n
        if (got._tag === "Failure") {
          problem = got.failure
          notify()
          return yield* got.failure
        }
        house = got.success
        problem = undefined
        notify()
        // The actions offered follow the kinds of devices: when they change, the module starts again with the new set.
        if (started && !sameKinds(kindsAtStart, kindsOf(house))) yield* ctx.host.requestRestart("the kinds of devices in Home Assistant changed")
        return house
      })

    // The start: the token and the room list, each within START_CALL_MS. A refused token or a user who is not an
    // administrator is a start error (only the owner can fix it); an unreachable, slow or garbled Home Assistant is
    // not: the module runs, says so, and keeps trying every minute (a power cut restarts both at once).
    const first = yield* Effect.result(client.config({ timeoutMs: Math.min(timeoutMs, START_CALL_MS) }))
    if (first._tag === "Failure") {
      if (first.failure.kind === "unauthorized" || first.failure.kind === "forbidden") return yield* moduleStartError(secrets, startErrorFields(first.failure, baseUrl))
      problem = first.failure
    } else {
      config = first.success
      const loaded = yield* Effect.result(read(Math.min(timeoutMs, START_CALL_MS)))
      if (loaded._tag === "Failure") {
        if (loaded.failure.kind === "unauthorized" || loaded.failure.kind === "forbidden") return yield* moduleStartError(secrets, startErrorFields(loaded.failure, baseUrl))
        problem = loaded.failure
      } else {
        house = loaded.success
        kindsAtStart = kindsOf(house)
      }
    }
    started = true

    const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS
    // The background read, in the shared part's scope (it stops when the module stops): never on a turn.
    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(refreshMs), Effect.ignore(load(timeoutMs, true)))))
    let soon = false
    const refreshSoon = Effect.suspend(() => {
      if (soon) return Effect.void
      soon = true
      return Effect.asVoid(Effect.forkIn(Effect.ensuring(Effect.ignore(load(timeoutMs, true)), Effect.sync(() => (soon = false))), scope))
    })

    const value: HomeAssistantShared = {
      house: () => house,
      problem: () => problem,
      config: () => config,
      load: (limitMs) => load(limitMs),
      call: (domain, service, data, limitMs) => client.callService(domain, service, data, { timeoutMs: limitMs }),
      kindsAtStart,
      refreshSoon,
      onChange: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      baseUrl,
      secrets,
      timeoutMs
    }
    return { value }
  }).pipe(
    // The last resort: anything unexpected leaves as a sanitised start error.
    Effect.catchDefect((defect) => Effect.fail(moduleStartError(secrets, { message: `Home Assistant could not start: ${fromUpstream(defect, secrets)}`, cause: defect }))),
    Effect.mapError((e) => moduleStartError(secrets, { message: e.message, cause: e.cause }))
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Words for what an action acts on

const KIND_NOUN: Readonly<Record<ChangeKind, TextKey>> = { light: "kindLights", switch: "kindSwitches", climate: "kindClimate", cover: "kindCovers" }

/** "the lights in Kitchen", "all the blinds", "Desk lamp". */
const whatOf = (lang: Language, kind: ChangeKind, r: Extract<Resolved, { _tag: "things" }>): string => {
  const things = say(lang, KIND_NOUN[kind])
  switch (r.scope._tag) {
    case "area":
      return say(lang, "whatArea", { things, area: r.scope.area.name })
    case "all":
      return say(lang, "whatAll", { things })
    case "one":
      return r.scope.entity.name
  }
}

/** What a target that does not resolve to anything says: a question, or why not. */
const unresolvedText = (lang: Language, kind: ChangeKind, r: Exclude<Resolved, { _tag: "things" }>): { readonly ask: string } | { readonly error: string } => {
  switch (r._tag) {
    case "noRoom":
      return { ask: say(lang, "whichRoom") }
    case "roomUnknown":
      return { ask: say(lang, "roomUnknown", { room: r.room }) }
    case "empty":
      return r.area === undefined ? { ask: say(lang, "nothingAtAll", { things: say(lang, KIND_NOUN[kind]) }) } : { ask: say(lang, "nothingThere", { things: say(lang, KIND_NOUN[kind]), area: r.area.name }) }
    case "unknown":
      return { error: say(lang, "unknownTarget", { name: r.value.replace(/^area:/, "").replace(/^[a-z0-9_]+\./, "").replace(/_/g, " ") }) }
  }
}

const brightnessOf = (e: Entity) => (e.state === "on" && e.brightnessPct !== undefined ? `, ${e.brightnessPct}%` : "")

/** One entity as one short line for the model ("Ceiling light: on, 50%"). Home Assistant's own state words. */
const describeEntity = (e: Entity): string => {
  switch (e.kind) {
    case "light":
      return `${e.name}: ${e.state}${brightnessOf(e)}`
    case "climate":
      return `${e.name}: ${e.state}${e.currentTemperature !== undefined ? `, ${e.currentTemperature}° now` : ""}${e.targetTemperature !== undefined ? `, set to ${e.targetTemperature}°` : ""}`
    case "cover":
      return `${e.name}: ${e.state}${e.position !== undefined ? `, ${e.position}% open` : ""}${e.security ? " (only read)" : ""}`
    case "sensor":
      return `${e.name}: ${e.state}${e.unit !== undefined ? ` ${e.unit}` : ""}`
    case "media_player":
      return `${e.name}: ${e.state}${e.mediaTitle !== undefined ? `, ${e.mediaArtist !== undefined ? `${e.mediaArtist} – ` : ""}${e.mediaTitle}` : ""}`
    case "lock":
      return `${e.name}: ${e.state} (only read)`
    case "scene":
      return `${e.name}: ${e.domain}`
    case "switch":
      return `${e.name}: ${e.state}`
  }
}

/** The most lines `home_state` returns; the rest is counted as `more`. */
export const HOME_STATE_LINES = 60

// ---------------------------------------------------------------------------------------------------------------------
// The Test button

/**
 * The Test button (a field action of the definition: it runs whether or not the module is running): the same two
 * requests as a start, with the given settings, timed. Every text that may carry upstream words is redacted.
 */
const testConnection = (deps: HomeAssistantDeps, settings: HomeAssistantSettings): Effect.Effect<FieldActionResult> =>
  Effect.gen(function*() {
    const secrets = secretList(settings.token, addressSecrets(settings.baseUrl))
    const problem = checkAddressSetting(settings.baseUrl)
    if (problem !== undefined) return { ok: false, text: clip(`The address: ${problem}.`, secrets, 300), tone: "error" as const }
    const baseUrl = normalizeBaseUrl(settings.baseUrl)
    if (baseUrl === undefined) return { ok: false, text: "Enter the address of your Home Assistant server first.", tone: "error" as const }
    if (settings.token === undefined) return { ok: false, text: "Enter and save a long-lived access token first.", tone: "error" as const }
    const client = makeHomeAssistantClient({ baseUrl, token: settings.token, timeoutMs: Math.min(settings.timeoutMs, START_CALL_MS), fetch: deps.fetch })
    const started = yield* Clock.currentTimeMillis
    const failed = (e: HomeAssistantError) => ({ ok: false, text: clip(startErrorFields(e, baseUrl).message, secrets, 400), tone: "error" as const })
    const config = yield* Effect.result(client.config())
    if (config._tag === "Failure") return failed(config.failure)
    const text = yield* Effect.result(client.renderTemplate(INVENTORY_TEMPLATE, { maxBytes: HOUSE_LIMITS.answerBytes }))
    if (text._tag === "Failure") return failed(text.failure)
    const decoded = decodeHouse(text.success, settings.aliases, started)
    if (!decoded.ok) return { ok: false, text: "Home Assistant answered, but its room list could not be read.", tone: "error" as const }
    const where = fromUpstream(`${config.success.locationName ?? "Home Assistant"}${config.success.version !== undefined ? ` (HA ${config.success.version})` : ""}`, secrets)
    const took = (yield* Clock.currentTimeMillis) - started
    return {
      ok: true,
      text: clip(`Connected to ${where} in ${took} ms: ${decoded.house.areas.length} areas, ${decoded.house.entities.length} devices.`, secrets, 400),
      tone: "ok" as const
    }
  })

// ---------------------------------------------------------------------------------------------------------------------
// Health

/** A cheap check (at start, on "Check again", by `doctor`; never on a turn): the address, the token, one `GET /api/config`. */
const checkHealth = (deps: HomeAssistantDeps, settings: HomeAssistantSettings | undefined, running: boolean): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.gen(function*() {
    if (settings === undefined) return []
    const secrets = secretList(settings.token, addressSecrets(settings.baseUrl))
    const baseUrl = settings.baseUrl.trim() === "" ? undefined : normalizeBaseUrl(settings.baseUrl)
    // Not set up and not in use: nothing to say (the module is off by default).
    if (baseUrl === undefined && settings.token === undefined && !running) return []
    if (baseUrl === undefined) {
      return [{ id: "home-assistant.no-address", severity: "error" as const, title: "No Home Assistant address", detail: "Enter the address of your Home Assistant server on the module's page." }]
    }
    if (settings.token === undefined) {
      return [{ id: "home-assistant.no-token", severity: "error" as const, title: "No Home Assistant token", detail: "Enter a long-lived access token from your Home Assistant profile on the module's page." }]
    }
    const client = makeHomeAssistantClient({ baseUrl, token: settings.token, timeoutMs: Math.min(settings.timeoutMs, START_CALL_MS), fetch: deps.fetch })
    const got = yield* Effect.result(client.config())
    if (got._tag === "Success") return []
    const e = got.failure
    const severity = running ? ("error" as const) : ("warning" as const)
    const issue = (id: string, title: string, detail: string): Issue => ({ id: `home-assistant.${id}`, severity, title, detail: clip(detail, secrets, 600) })
    switch (e.kind) {
      case "unauthorized":
        return [issue("token-refused", "Home Assistant refused the token", "Create a new long-lived access token in your Home Assistant profile (Security) and enter it on the module's page.")]
      case "forbidden":
        return [issue("not-admin", "Home Assistant refused the token's user", "The token's user must be an administrator.")]
      default:
        return [issue("unreachable", "Home Assistant cannot be reached", `${e.message} (${e.detail}). Check the address and that Home Assistant runs.`)]
    }
  })

// ---------------------------------------------------------------------------------------------------------------------
// The module

/** The definition; `homeAssistantModule(deps)` below is its public form. */
const defineHomeAssistant = (deps: HomeAssistantDeps) =>
  defineModule({
    apiVersion: 2,
    id: "home-assistant",
    name: "Home Assistant",
    description: "Lights, switches, heating and blinds by room through your Home Assistant server; locks, alarms and garage doors only read.",
    enabledByDefault: false,
    settings,
    requires: [{ network: "lan", why: "Talks to your Home Assistant server" }],
    health: ({ settings, running }) => checkHealth(deps, settings, running),
    fieldActions: { test: ({ settings }) => testConnection(deps, settings) },
    shared: (ctx) => makeShared(deps, ctx),
    start: (ctx) =>
      Effect.gen(function*() {
        const shared: HomeAssistantShared = ctx.shared
        const secrets = shared.secrets
        const chosen = new Set<string>(ctx.settings.domains)
        const present = shared.kindsAtStart
        // A kind is offered when the assistant uses it and the house has it (all chosen kinds before the first read).
        const offers = (kind: Kind) => (kind === "scene" ? present?.has("scene") === true : chosen.has(kind) && (present === undefined || present.has(kind)))
        const lang = () => homeLanguage(ctx.host.view())
        const visible = (e: Entity) => (e.kind === "scene" ? e.runnable : chosen.has(e.kind))

        // Status lines and the form's values carry upstream text (location name, version, error details): redacted, then shortened.
        const statusNow = () => {
          const house = shared.house()
          const problem = shared.problem()
          const version = shared.config()?.version
          if (house === undefined) {
            return { text: clip(`Can't read Home Assistant yet (${problem?.message ?? "no answer"}); trying again every minute`, secrets, 120), tone: "warning" as const }
          }
          const lights = house.entities.filter((e) => e.kind === "light").length
          const others = house.entities.filter((e) => e.kind !== "light" && visible(e)).length
          const text = `${house.areas.length} ${house.areas.length === 1 ? "area" : "areas"} · ${lights} ${lights === 1 ? "light" : "lights"} · ${others} other${others === 1 ? "" : "s"}${version !== undefined ? ` · HA ${version}` : ""}`
          return problem === undefined
            ? { text: clip(text, secrets, 120), tone: "ok" as const }
            : { text: clip(`Couldn't refresh from Home Assistant (${problem.message}); list from ${clock(house.fetchedAt)}`, secrets, 120), tone: "warning" as const }
        }
        ctx.setStatus(statusNow())
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            shared.onChange(() => {
              ctx.setStatus(statusNow())
              ctx.refreshForm()
            })
          ),
          (off) => Effect.sync(off)
        )

        /** The house for a command: the cache (the background read keeps it), or why there is none. */
        const cached = Effect.suspend((): Effect.Effect<House, ActionError> => {
          const house = shared.house()
          if (house !== undefined) return Effect.succeed(house)
          const problem = shared.problem()
          return Effect.fail(new ActionError({ message: problem === undefined ? say(lang(), "notLoaded") : failureText(lang(), problem, false) }))
        })
        /** The house now, for a question (one request, at most 3 s). */
        const live = Effect.suspend(() => shared.load(Math.min(shared.timeoutMs, TURN_CALL_MS))).pipe(Effect.mapError((e) => new ActionError(sanitize(secrets, { message: failureText(lang(), e, false) }))))

        /** Run the service calls of one command, in parallel, each within 3 s; the first failure is what is said. */
        const callAll = (calls: ReadonlyArray<{ readonly domain: string; readonly service: string; readonly data: Readonly<Record<string, unknown>> }>) =>
          Effect.all(calls.map((c) => shared.call(c.domain, c.service, c.data, Math.min(shared.timeoutMs, TURN_CALL_MS))), { concurrency: "unbounded", discard: true }).pipe(
            Effect.mapError((e) => new ActionError(sanitize(secrets, { message: failureText(lang(), e, true) })))
          )

        /**
         * A command on one kind: resolve the target (with the device's room for "here"), refuse a garage door, a gate or
         * a door whatever the target was, make the calls, say what was done.
         */
        const command = (
          kind: ChangeKind,
          value: string,
          calls: (things: ReadonlyArray<Entity>) => ReadonlyArray<{ readonly domain: string; readonly service: string; readonly data: Readonly<Record<string, unknown>> }> | { readonly say: string },
          done: (what: string, things: ReadonlyArray<Entity>) => string
        ) =>
          Effect.gen(function*() {
            const l = lang()
            const turn = yield* CurrentTurn
            const house = yield* cached
            const r = resolveTarget(house, kind, value, turn?.room)
            if (r._tag !== "things") {
              const said = unresolvedText(l, kind, r)
              if ("ask" in said) return { say: said.ask }
              yield* shared.refreshSoon
              return yield* new ActionError({ message: said.error })
            }
            // The second guard (the first is the risk class of a `secure:` target): "here" in the garage, or a cover
            // whose class changed since the option was chosen.
            if (r.things.some((e) => e.security)) return yield* new ActionError({ message: say(l, "securityCover") })
            const planned = calls(r.things)
            if ("say" in planned) return { say: planned.say }
            yield* callAll(planned)
            return { say: done(whatOf(l, kind, r), r.things) }
          })

        const target = (kind: ChangeKind, label: string) =>
          Param.dynamic({
            label,
            question: `Which ${label.toLowerCase()} does the utterance refer to? "Here" when it names none.`,
            ask: `Which ${label.toLowerCase()}?`,
            optional: true,
            default: HERE,
            options: () => {
              const house = shared.house()
              return house === undefined ? [] : targetOptions(house, kind)
            }
          })
        const turnCalls = (service: string, data: Readonly<Record<string, unknown>> = {}) => (things: ReadonlyArray<Entity>) =>
          callsByDomain(things).map((c) => ({ domain: c.domain, service, data: { ...data, entity_id: c.ids } }))

        const lightTarget = target("light", "Room or light")
        const switchTarget = target("switch", "Room or switch")
        const climateTarget = target("climate", "Room or thermostat")
        const coverTarget = target("cover", "Room or blind")
        /** A cover target is `security` when it names a garage door, a gate or a door (or a room with one). */
        const coverRisk = { classes: ["change", "security"] as const, of: (v: { readonly target?: string | undefined }) => (v.target?.startsWith(SECURE) === true ? "security" as const : "change" as const) }

        const lightActions: ReadonlyArray<ActionDefinition<any>> = [
          defineAction({
            id: "lights_on",
            label: "Turn lights on",
            description: "Switch on the lights here (the asking device's room), in a room, one light, or every light. Not for dimming to a level: that is set_brightness.",
            examples: ["turn on the kitchen lights", "lights on", "living room lights on", "doe het licht aan in de woonkamer", "licht aan"],
            params: { target: lightTarget },
            risk: "change",
            run: ({ target: t }) => command("light", t ?? HERE, turnCalls("turn_on"), (what) => sentence(lang(), "turnedOn", { what }))
          }),
          defineAction({
            id: "lights_off",
            label: "Turn lights off",
            description: "Switch off the lights here, in a room, one light, or every light.",
            examples: ["turn off the bedroom light", "lights off", "lights off in the office", "doe het licht uit in de keuken", "licht uit"],
            params: { target: lightTarget },
            risk: "change",
            run: ({ target: t }) => command("light", t ?? HERE, turnCalls("turn_off"), (what) => sentence(lang(), "turnedOff", { what }))
          }),
          defineAction({
            id: "set_brightness",
            label: "Set brightness",
            description: "Dim or brighten the lights here, in a room or one light to a percentage.",
            examples: ["dim the living room to 30 percent", "set the desk lamp to half", "zet de woonkamer op veertig procent"],
            params: {
              target: lightTarget,
              level: Param.number({ label: "Brightness", min: 0, max: 100, unit: "percent", ask: "How bright?" })
            },
            risk: "change",
            run: ({ target: t, level }) =>
              command("light", t ?? HERE, turnCalls("turn_on", { brightness_pct: Math.round(level) }), (what) => sentence(lang(), "brightness", { what, level: Math.round(level) }))
          }),
          defineAction({
            id: "lights_status",
            label: "Which lights are on",
            description: "Say which lights are on right now. A question, not a command.",
            examples: ["which lights are on", "is the kitchen light on", "welke lampen zijn aan"],
            params: {},
            speculative: true,
            run: () =>
              Effect.map(live, (house) => {
                const l = lang()
                const lights = house.entities.filter((e) => e.kind === "light")
                if (lights.length === 0) return { say: say(l, "nothingAtAll", { things: say(l, "kindLights") }) }
                const on = lights.filter((e) => e.state === "on")
                if (on.length === 0) return { say: say(l, "lightsAllOff") }
                if (on.length === lights.length && lights.length > 1) return { say: say(l, "lightsAllOn") }
                return { say: say(l, on.length === 1 ? "lightsOneOn" : "lightsSomeOn", { names: joinList(l, on.map((e) => e.name)) }) }
              })
          })
        ]

        const switchActions: ReadonlyArray<ActionDefinition<any>> = [
          defineAction({
            id: "switches_on",
            label: "Turn switches on",
            description: "Switch on a switch, a fan or an on/off helper, or every one of them here or in a room. Lights are lights_on.",
            examples: ["turn on the coffee machine", "switch on the fan", "zet de ventilator aan"],
            params: { target: switchTarget },
            risk: "change",
            run: ({ target: t }) => command("switch", t ?? HERE, turnCalls("turn_on"), (what) => sentence(lang(), "turnedOn", { what }))
          }),
          defineAction({
            id: "switches_off",
            label: "Turn switches off",
            description: "Switch off a switch, a fan or an on/off helper, or every one of them here or in a room.",
            examples: ["turn off the coffee machine", "switch the fan off", "zet de ventilator uit"],
            params: { target: switchTarget },
            risk: "change",
            run: ({ target: t }) => command("switch", t ?? HERE, turnCalls("turn_off"), (what) => sentence(lang(), "turnedOff", { what }))
          })
        ]

        const MODES = [
          { value: "heat", label: "heat", aliases: ["heating", "warm", "verwarmen"] },
          { value: "cool", label: "cool", aliases: ["cooling", "koelen"] },
          { value: "auto", label: "automatic", aliases: ["auto", "automatisch"] },
          { value: "off", label: "off", aliases: ["uit"] }
        ] as const
        const MODE_TEXT: Readonly<Record<(typeof MODES)[number]["value"], TextKey>> = { heat: "modeHeat", cool: "modeCool", auto: "modeAuto", off: "modeOff" }
        /** The Home Assistant mode a spoken mode is for one thermostat: "auto" is `auto`, else `heat_cool`; `undefined` when it has neither. */
        const hvacModeOf = (e: Entity, mode: (typeof MODES)[number]["value"]): string | undefined => {
          if (e.hvacModes.length === 0) return mode === "auto" ? "auto" : mode
          if (mode === "auto") return e.hvacModes.includes("auto") ? "auto" : e.hvacModes.includes("heat_cool") ? "heat_cool" : undefined
          return e.hvacModes.includes(mode) ? mode : undefined
        }

        /** Temperatures here (or in a room); the whole house when the device has no room that is an area. */
        const roomTarget = Param.dynamic({
          label: "Room",
          question: "Which room does the question refer to? \"Here\" when it names none.",
          optional: true,
          default: HERE,
          options: () => {
            const house = shared.house()
            return [{ value: HERE, label: "Here", aliases: ["here", "in here", "this room", "hier", "deze kamer"] }, ...(house?.areas ?? []).map((a): ParamOption => ({ value: `area:${a.id}`, label: a.name, aliases: a.aliases }))]
          }
        })

        const climateActions: ReadonlyArray<ActionDefinition<any>> = [
          defineAction({
            id: "climate_set",
            label: "Set the temperature",
            description: "Set the thermostat here, in a room, or every thermostat to a temperature in degrees Celsius.",
            examples: ["make it 21 degrees in here", "set the living room to twenty", "zet de verwarming op 20 graden"],
            params: { target: climateTarget, temperature: Param.number({ label: "Temperature", min: 5, max: 35, unit: "degrees", ask: "Which temperature?" }) },
            risk: "change",
            run: ({ target: t, temperature }) =>
              command(
                "climate",
                t ?? HERE,
                turnCalls("set_temperature", { temperature }),
                (what, things) => {
                  const current = things.length === 1 ? things[0]!.currentTemperature : undefined
                  const values = { what, temperature: spokenNumber(lang(), temperature) }
                  return current === undefined ? sentence(lang(), "temperature", values) : sentence(lang(), "temperatureNow", { ...values, current: spokenNumber(lang(), current) })
                }
              )
          }),
          defineAction({
            id: "climate_mode",
            label: "Set the heating mode",
            description: "Switch the thermostat here, in a room, or every thermostat to heat, cool, automatic or off.",
            examples: ["turn the heating off", "set the bedroom to heat", "zet de verwarming uit"],
            params: { target: climateTarget, mode: Param.choice({ label: "Mode", options: MODES, ask: "Heat, cool, automatic or off?" }) },
            risk: "change",
            run: ({ target: t, mode }) =>
              command(
                "climate",
                t ?? HERE,
                (things) => {
                  const able = things.flatMap((e) => {
                    const m = hvacModeOf(e, mode)
                    return m === undefined ? [] : [{ e, m }]
                  })
                  if (able.length === 0) {
                    const l = lang()
                    const what = things.length === 1 ? things[0]!.name : say(l, "whatAll", { things: say(l, "kindClimate") })
                    return { say: sentence(l, "modeUnsupported", { what, mode: say(l, MODE_TEXT[mode]) }) }
                  }
                  const byMode = new Map<string, Array<Entity>>()
                  for (const { e, m } of able) byMode.set(m, [...(byMode.get(m) ?? []), e])
                  return [...byMode].flatMap(([m, es]) => callsByDomain(es).map((c) => ({ domain: c.domain, service: "set_hvac_mode", data: { hvac_mode: m, entity_id: c.ids } })))
                },
                (what) => sentence(lang(), "mode", { what, mode: say(lang(), MODE_TEXT[mode]) })
              )
          })
        ]

        const climateStatus = defineAction({
          id: "climate_status",
          label: "How warm is it",
          description: "Say the temperature here or in a room, and what the heating is set to. A question, not a command.",
          examples: ["how warm is it in here", "what's the temperature in the living room", "hoe warm is het hier"],
          params: { room: roomTarget },
          speculative: true,
          run: ({ room }) =>
            Effect.gen(function*() {
              const l = lang()
              const turn = yield* CurrentTurn
              const house = yield* live
              const isTemp = (e: Entity) => (e.kind === "climate" && chosen.has("climate")) || (e.kind === "sensor" && chosen.has("sensor") && e.deviceClass === "temperature")
              const value = room ?? HERE
              const area = value === HERE ? areaOfRoom(house, turn?.room) : house.areas.find((a) => `area:${a.id}` === value)
              const inScope = house.entities.filter((e) => isTemp(e) && (area === undefined || e.areaId === area.id))
              const things = inScope.length > 0 || area === undefined ? inScope : house.entities.filter(isTemp)
              if (things.length === 0) return { say: say(l, "nothingAtAll", { things: say(l, "kindTemperature") }) }
              const items = things.map((e) => {
                const name = e.name
                const current = e.kind === "climate" ? e.currentTemperature : Number.isFinite(Number(e.state)) ? Number(e.state) : undefined
                if (e.kind === "climate" && e.state === "off" && current !== undefined) return say(l, "climateItemOff", { name, current: spokenNumber(l, current) })
                if (current !== undefined && e.targetTemperature !== undefined) return say(l, "climateItem", { name, current: spokenNumber(l, current), target: spokenNumber(l, e.targetTemperature) })
                if (current !== undefined) return say(l, "climateItemCurrent", { name, current: spokenNumber(l, current) })
                if (e.targetTemperature !== undefined) return say(l, "climateItemTarget", { name, target: spokenNumber(l, e.targetTemperature) })
                return say(l, "climateItemUnknown", { name })
              })
              return { say: say(l, "statusLine", { items: joinList(l, items, 4) }) }
            })
        })

        const coverActions: ReadonlyArray<ActionDefinition<any>> = [
          defineAction({
            id: "covers_open",
            label: "Open the blinds",
            description: "Open a blind or shade, or every one here or in a room. A garage door, a gate or a door is never moved: that is refused (security).",
            examples: ["open the blinds", "open the living room curtains", "doe de rolluiken open"],
            params: { target: coverTarget },
            risk: coverRisk,
            run: ({ target: t }) => command("cover", t ?? HERE, turnCalls("open_cover"), (what) => sentence(lang(), "opening", { what }))
          }),
          defineAction({
            id: "covers_close",
            label: "Close the blinds",
            description: "Close a blind or shade, or every one here or in a room. A garage door, a gate or a door is never moved: that is refused (security).",
            examples: ["close the blinds", "close the bedroom shades", "doe de zonwering dicht"],
            params: { target: coverTarget },
            risk: coverRisk,
            run: ({ target: t }) => command("cover", t ?? HERE, turnCalls("close_cover"), (what) => sentence(lang(), "closing", { what }))
          }),
          defineAction({
            id: "covers_stop",
            label: "Stop the blinds",
            description: "Stop a blind or shade that is moving. A garage door, a gate or a door is never moved: that is refused (security).",
            examples: ["stop the blinds", "stop de rolluiken"],
            params: { target: coverTarget },
            risk: coverRisk,
            run: ({ target: t }) => command("cover", t ?? HERE, turnCalls("stop_cover"), (what) => sentence(lang(), "stopping", { what }))
          }),
          defineAction({
            id: "cover_position",
            label: "Set the blinds to a position",
            description: "Set a blind or shade, or every one here or in a room, to a percentage open (0 closed, 100 open). A garage door, a gate or a door is never moved: that is refused (security).",
            examples: ["set the blinds to half", "open the kitchen blinds to 30 percent", "zet de rolluiken op de helft"],
            params: { target: coverTarget, position: Param.number({ label: "Position", min: 0, max: 100, unit: "percent", ask: "How far open?" }) },
            risk: coverRisk,
            run: ({ target: t, position }) =>
              command(
                "cover",
                t ?? HERE,
                (things) => {
                  const able = things.filter((e) => e.supportedFeatures === undefined || (e.supportedFeatures & COVER_SET_POSITION) !== 0)
                  if (able.length === 0) {
                    const l = lang()
                    return { say: sentence(l, "positionUnsupported", { what: things.length === 1 ? things[0]!.name : say(l, "whatAll", { things: say(l, "kindCovers") }) }) }
                  }
                  return turnCalls("set_cover_position", { position: Math.round(position) })(able)
                },
                (what) => sentence(lang(), "position", { what, position: Math.round(position) })
              )
          })
        ]

        const sceneAction = defineAction({
          id: "scene_activate",
          label: "Start a scene or script",
          description: "Start one of the scenes or scripts the owner chose by name (\"movie time\", \"goodnight\").",
          examples: ["movie time", "start the goodnight scene", "zet filmavond aan"],
          params: {
            scene: Param.dynamic({
              label: "Scene or script",
              ask: "Which scene?",
              options: () => {
                const house = shared.house()
                return house === undefined ? [] : sceneOptions(house)
              }
            })
          },
          risk: "change",
          run: ({ scene }) =>
            Effect.gen(function*() {
              const l = lang()
              const house = yield* cached
              const e = house.byId.get(scene)
              if (e === undefined || !e.runnable) {
                yield* shared.refreshSoon
                return yield* new ActionError({ message: say(l, "unknownTarget", { name: scene.replace(/^[a-z0-9_]+\./, "").replace(/_/g, " ") }) })
              }
              yield* callAll([{ domain: e.domain, service: "turn_on", data: { entity_id: [e.entityId] } }])
              return { say: say(l, "started", { name: e.name }) }
            })
        })

        const locksStatus = defineAction({
          id: "locks_status",
          label: "Are the doors locked",
          description: "Say whether the locks are locked, how the alarm is set, and whether a garage door or gate is open. Only reads: locking, unlocking, arming and disarming are not done by voice.",
          examples: ["is the front door locked", "is the garage door closed", "is de voordeur op slot"],
          params: {},
          speculative: true,
          run: () =>
            Effect.map(live, (house) => {
              const l = lang()
              const things = house.entities.filter((e) => (e.kind === "lock" && chosen.has("lock")) || (e.security && chosen.has("cover")))
              if (things.length === 0) return { say: say(l, "nothingAtAll", { things: say(l, "kindLocks") }) }
              const items = things.map((e) => {
                const name = e.name
                if (e.domain === "lock") return say(l, e.state === "locked" ? "lockLocked" : e.state === "unlocked" ? "lockUnlocked" : "lockOther", { name, state: e.state })
                if (e.domain === "alarm_control_panel") return e.state === "disarmed" ? say(l, "alarmDisarmed", { name }) : e.state.startsWith("armed") ? say(l, "alarmArmed", { name }) : say(l, "lockOther", { name, state: e.state })
                return say(l, e.state === "open" ? "coverOpen" : e.state === "closed" ? "coverClosed" : "lockOther", { name, state: e.state })
              })
              return { say: say(l, "statusLine", { items: joinList(l, items, 6) }) }
            })
        })

        const KINDS = ["light", "switch", "climate", "cover", "media_player", "sensor", "lock", "scene"] as const
        const homeState = makeTool({
          name: "home_state",
          description: "Rooms (Home Assistant areas) and their lights, switches, heating, blinds, media players, sensors, locks and the scenes you may start, with their state now. " +
            "Use it before answering questions about the home; use the home-assistant actions to change anything. Locks, alarms, garage doors, gates and doors are only read.",
          parameters: Schema.Struct({
            area: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100)).annotate({ description: "Only this room (a name, or \"here\")" })),
            kind: Schema.optionalKey(Schema.Literals(KINDS).annotate({ description: "Only this kind of device" }))
          }),
          speculative: true,
          execute: ({ area, kind }) =>
            Effect.gen(function*() {
              const l = lang()
              const turn = yield* CurrentTurn
              const house = yield* shared.load(Math.min(shared.timeoutMs, TURN_CALL_MS)).pipe(Effect.mapError((e) => new ToolError(sanitize(secrets, { message: failureText(l, e, false) }))))
              let only: string | undefined
              if (area !== undefined && area.trim() !== "") {
                const options: Array<ParamOption> = house.areas.map((a) => ({ value: a.id, label: a.name, aliases: a.aliases }))
                const named = ["here", "in here", "this room", "hier"].includes(area.trim().toLowerCase()) ? areaOfRoom(house, turn?.room)?.id : resolveOption(options, area)?.value
                if (named === undefined) return { spoken: say(l, turn?.room === undefined && area.trim().toLowerCase() === "here" ? "whichRoom" : "roomUnknown", { room: area }) }
                only = named
              }
              const shown = house.entities.filter((e) => visible(e) && (kind === undefined || e.kind === kind) && (only === undefined || e.areaId === only))
              const rooms: Array<{ readonly room: string; readonly things: Array<string> }> = []
              let lines = 0
              let more = 0
              for (const a of [...house.areas.map((a) => ({ id: a.id as string | undefined, name: a.name })), { id: undefined, name: say(l, "roomless") }]) {
                const here = shown.filter((e) => e.areaId === a.id)
                if (here.length === 0) continue
                const things: Array<string> = []
                for (const e of here) {
                  if (lines >= HOME_STATE_LINES) {
                    more++
                    continue
                  }
                  things.push(describeEntity(e))
                  lines++
                }
                if (things.length > 0) rooms.push({ room: a.name, things })
              }
              return { rooms, ...(more > 0 ? { more } : {}) }
            })
        })

        const actions: Array<ActionDefinition<any>> = []
        if (offers("light")) actions.push(...lightActions)
        if (offers("switch")) actions.push(...switchActions)
        if (offers("climate")) actions.push(...climateActions)
        if (offers("climate") || offers("sensor")) actions.push(climateStatus)
        if (offers("cover")) actions.push(...coverActions)
        if (offers("scene")) actions.push(sceneAction)
        if (offers("lock")) actions.push(locksStatus)

        const instance: ModuleInstance = {
          tools: chosen.size > 0 || offers("scene") ? [homeState] : [],
          actions,
          ...(actions.length > 0
            ? { instructions: "The owner's home is controlled through Home Assistant: use home_state to see it and the home-assistant actions to change it. Locks, alarms, garage doors, gates and doors are only read; never offer to change them." }
            : {}),
          info: () => {
            const house = shared.house()
            const config = shared.config()
            const names = house?.entities.filter((e) => e.runnable).map((e) => e.name) ?? []
            const count = (k: Kind) => house?.entities.filter((e) => e.kind === k).length ?? 0
            return {
              // A display boundary (the settings card), like the status line: upstream text, redacted here.
              server: clip(fromUpstream(`${config?.locationName ?? "Home Assistant"}${config?.version !== undefined ? ` ${config.version}` : ""} at ${shared.baseUrl}`, secrets), secrets, 300),
              lists: house === undefined
                ? clip(`Not read yet: ${shared.problem()?.message ?? "no answer"}`, secrets, 300)
                : clip(
                  `${house.areas.length} areas; ${count("light")} lights, ${count("switch")} switches, ${count("climate")} thermostats, ${count("cover")} covers, ${count("media_player")} media players, ${count("sensor")} sensors, ${count("lock")} locks and alarms` +
                    `; fetched ${clock(house.fetchedAt)}` +
                    (names.length > 0 ? `; scenes and scripts you named: ${names.slice(0, 20).join(", ")}` : "; no scenes or scripts named under Other names") +
                    (house.leftOut > 0 ? `; ${house.leftOut} left out (over the limits)` : ""),
                  secrets,
                  1000
                )
            }
          }
        }
        return instance
      })
  })

/** Lights, switches, heating and blinds through Home Assistant (docs/modules/home-assistant.md). */
export const homeAssistantModule = (deps: HomeAssistantDeps = {}) => defineHomeAssistant(deps)

/** The module as registered in the app's catalogue (real `fetch`, 60 s refresh). */
export const homeAssistant = homeAssistantModule()
