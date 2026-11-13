import {
  ActionError,
  type ActionDefinition,
  defineAction,
  defineModule,
  type ExtendedModuleInstance,
  makeTool,
  ModuleStartError,
  Param,
  Setting,
  ToolError
} from "@pva/core"
import { Duration, Effect, Schedule, Schema } from "effect"
import { checkAddressSetting, type HomeAssistantClient, type HomeAssistantError, makeHomeAssistantClient, normalizeBaseUrl } from "./client.ts"
import {
  buildHouse,
  checkAliases,
  decodeInventory,
  describeLights,
  type House,
  houseState,
  INVENTORY_TEMPLATE,
  labelOf,
  serviceTarget
} from "./home.ts"
import { addressSecrets, clip, fromUpstream, sanitize, type Secrets, secretList } from "./redact.ts"

export interface HomeAssistantDeps {
  /** Injected in tests. Default: the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  /** How often the area and light lists are refreshed. Default 60 s (design §3.9). */
  readonly refreshMs?: number | undefined
  /** Clock for the "fetched at" time. */
  readonly now?: () => number
}

const DEFAULT_REFRESH_MS = 60_000

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
    label: "Devices to control",
    description: "This version controls lights only.",
    default: ["light"],
    options: [{ value: "light", label: "Lights" }]
  }),
  aliases: Setting.text({
    label: "Other names",
    description: "One line per room or light: the name in Home Assistant, a colon, then other names you use, " +
      "separated by commas. Example: \"Living room: lounge, woonkamer\".",
    placeholder: "Living room: lounge, woonkamer\nDesk lamp: bureaulamp",
    multiline: true,
    maxLength: 4000,
    check: checkAliases
  }),
  timeoutMs: Setting.number({
    label: "Timeout",
    description: "Longest one request to Home Assistant may take; a spoken reply cannot wait much longer.",
    default: 2000,
    integer: true,
    min: 300,
    max: 10_000,
    step: 100,
    unit: "ms",
    advanced: true
  })
}

/** The only way a `ModuleStartError` is made once a token is known: message and cause sanitised (see `redact.ts`). */
const moduleStartError = (secrets: Secrets, fields: ConstructorParameters<typeof ModuleStartError>[0]): ModuleStartError =>
  new ModuleStartError(sanitize(secrets, fields))

const startError = (secrets: Secrets, e: HomeAssistantError, baseUrl: string): ModuleStartError =>
  moduleStartError(secrets, startErrorFields(e, baseUrl))

const startErrorFields = (e: HomeAssistantError, baseUrl: string): ConstructorParameters<typeof ModuleStartError>[0] => {
  switch (e.kind) {
    case "unreachable":
      return { message: `Could not reach Home Assistant at ${baseUrl} (${e.detail}). Check the address.`, cause: e }
    case "unauthorized":
      return {
        message: "Home Assistant rejected the token. Create a long-lived access token in your Home Assistant profile (Security) and enter it here.",
        cause: e
      }
    case "forbidden":
      return {
        message: "Home Assistant accepted the token but refused to list rooms: the token's user must be an administrator.",
        cause: e
      }
    case "invalid":
      return { message: `Home Assistant at ${baseUrl} sent an answer this module cannot read (${e.detail}).`, cause: e }
    case "http":
      return { message: `Home Assistant at ${baseUrl} answered with an error (${e.detail}).`, cause: e }
  }
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

/**
 * Lights and rooms from Home Assistant (docs/AGENTS-AND-INTENTS.md §3.9).
 *
 * At start: `GET /api/config` (address and token), then one template render
 * for the area and light lists. The lists are cached and refreshed every
 * minute in the background (and soon after a lookup of an unknown value),
 * never while a turn waits. Actions call `light.turn_on` / `light.turn_off`.
 */
export const homeAssistantModule = (deps: HomeAssistantDeps = {}) =>
  defineModule({
    id: "home-assistant",
    name: "Home Assistant",
    description: "Turn lights on and off by room through your Home Assistant server.",
    enabledByDefault: false,
    settings,
    start: ({ setStatus: setUnsafeStatus, settings }) => {
      // The token and every credential part of the address, known before anything can fail.
      let secrets: Secrets = []
      return Effect.gen(function*() {
        secrets = secretList(settings.token, addressSecrets(settings.baseUrl))
        const now = deps.now ?? Date.now
        const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS
        const problem = checkAddressSetting(settings.baseUrl)
        if (problem !== undefined) return yield* new ModuleStartError({ message: `The Home Assistant address: ${problem}.` })
        const baseUrl = normalizeBaseUrl(settings.baseUrl)
        if (baseUrl === undefined) {
          return yield* new ModuleStartError({ message: "Enter the address of your Home Assistant server (for example http://homeassistant.local:8123)." })
        }
        if (settings.token === undefined) {
          return yield* new ModuleStartError({ message: "Enter a long-lived access token from your Home Assistant profile." })
        }
        // Status lines carry upstream text (location name, version, error messages): redacted, then shortened.
        const setStatus: typeof setUnsafeStatus = (status) =>
          setUnsafeStatus(status === undefined ? undefined : { ...status, text: clip(status.text, secrets, 120) })
        const client: HomeAssistantClient = makeHomeAssistantClient({
          baseUrl,
          token: settings.token,
          timeoutMs: settings.timeoutMs,
          fetch: deps.fetch
        })

        const loadHouse = client.renderTemplate(INVENTORY_TEMPLATE).pipe(
          Effect.flatMap((text) => {
            const inventory = decodeInventory(text)
            return inventory === undefined
              ? Effect.fail({ kind: "invalid" as const, detail: `template answer is not the expected JSON: ${clip(text, secrets, 120)}` })
              : Effect.succeed(buildHouse(inventory, settings.aliases, now()))
          })
        )

        const config = yield* client.config.pipe(Effect.mapError((e) => startError(secrets, e, baseUrl)))
        let house: House = yield* loadHouse.pipe(
          Effect.mapError((e) =>
            "_tag" in e
              ? startError(secrets, e, baseUrl)
              : moduleStartError(secrets, { message: `Home Assistant at ${baseUrl} sent a room list this module cannot read (${e.detail}).` })
          )
        )

        const statusFor = (h: House) => ({
          text: `${h.areas.length} ${h.areas.length === 1 ? "area" : "areas"} · ${h.lights.length} ${h.lights.length === 1 ? "light" : "lights"}${
            config.version !== undefined ? ` · HA ${config.version}` : ""
          }`,
          tone: "ok" as const
        })
        setStatus(statusFor(house))

        const refresh = loadHouse.pipe(
          Effect.tap((h) =>
            Effect.sync(() => {
              house = h
              setStatus(statusFor(h))
            })
          ),
          Effect.catch((e) =>
            Effect.sync(() =>
              setStatus({
                text: `Couldn't refresh from Home Assistant (${"_tag" in e ? e.message : "unreadable answer"}); list from ${clock(house.fetchedAt)}`,
                tone: "warning"
              })
            )
          )
        )
        // Background refresh, every minute, in the module's scope (stops when it is disabled or restarted).
        yield* refresh.pipe(Effect.delay(Duration.millis(refreshMs)), Effect.repeat(Schedule.forever), Effect.forkScoped)
        let refreshing = false
        const refreshSoon = () => {
          if (refreshing) return
          refreshing = true
          Effect.runFork(refresh.pipe(Effect.ensuring(Effect.sync(() => (refreshing = false)))))
        }

        const toActionError = (e: HomeAssistantError) => new ActionError(sanitize(secrets, { message: e.message, cause: e }))

        const switchLights = (value: string, on: boolean, brightnessPct?: number) =>
          Effect.gen(function*() {
            const target = serviceTarget(house, value)
            if (target === undefined) {
              refreshSoon()
              return yield* new ActionError({ message: `I don't know a room or light called ${value}.` })
            }
            yield* client.callService("light", on ? "turn_on" : "turn_off", {
              ...target,
              ...(brightnessPct !== undefined ? { brightness_pct: brightnessPct } : {})
            }).pipe(Effect.mapError(toActionError))
          })

        /** Current light states: a live read (status questions want now, not a minute ago). */
        const liveHouse = loadHouse.pipe(
          Effect.tap((h) => Effect.sync(() => (house = h))),
          Effect.mapError((e) => new ActionError(sanitize(secrets, { message: "_tag" in e ? e.message : "Home Assistant sent an unexpected answer." })))
        )

        const target = Param.dynamic({
          label: "Room or light",
          question: "Which room or light does the utterance refer to?",
          ask: "Which room or light?",
          options: () => house.targets
        })

        const actions: ReadonlyArray<ActionDefinition<any>> = [
          defineAction({
            id: "lights_on",
            label: "Turn lights on",
            description: "Switch on the lights in a room, one light, or every light. Not for dimming to a level: that is set_brightness.",
            examples: ["turn on the kitchen lights", "living room lights on", "doe het licht aan in de woonkamer"],
            params: { target },
            announce: ({ target: t }) => (t === "all" ? "All lights on." : `${labelOf(house, t)} on.`),
            run: ({ target: t }) => switchLights(t, true)
          }),
          defineAction({
            id: "lights_off",
            label: "Turn lights off",
            description: "Switch off the lights in a room, one light, or every light.",
            examples: ["turn off the bedroom light", "lights off in the office", "doe het licht uit in de keuken"],
            params: { target },
            announce: ({ target: t }) => (t === "all" ? "All lights off." : `${labelOf(house, t)} off.`),
            run: ({ target: t }) => switchLights(t, false)
          }),
          defineAction({
            id: "set_brightness",
            label: "Set brightness",
            description: "Dim or brighten the lights in a room or one light to a percentage.",
            examples: ["dim the living room to 30 percent", "set the desk lamp to half", "zet de woonkamer op veertig procent"],
            params: {
              target,
              level: Param.number({ label: "Brightness", optional: false, min: 0, max: 100, unit: "percent", ask: "How bright?" })
            },
            announce: ({ target: t, level }) => `${t === "all" ? "All lights" : labelOf(house, t)} at ${Math.round(level)} percent.`,
            run: ({ target: t, level }) => switchLights(t, true, Math.round(level))
          }),
          defineAction({
            id: "lights_status",
            label: "Which lights are on",
            description: "Say which lights are on right now. A question, not a command.",
            examples: ["which lights are on", "is the kitchen light on", "welke lampen zijn aan"],
            params: {},
            speculative: true,
            run: () => Effect.map(liveHouse, (h) => ({ say: describeLights(h) }))
          })
        ]

        const homeState = makeTool({
          name: "home_state",
          description: "Rooms (Home Assistant areas) and their lights with on/off state and brightness. " +
            "Use it before answering questions about the home; use the light actions to change anything.",
          parameters: Schema.Struct({}),
          speculative: true,
          execute: () => liveHouse.pipe(Effect.map(houseState), Effect.mapError((e) => new ToolError(sanitize(secrets, { message: e.message }))))
        })

        const instance: ExtendedModuleInstance = {
          tools: [homeState],
          actions,
          instructions: "The owner's lights are controlled through Home Assistant: use home_state to see them and the light actions to switch them.",
          info: () => ({
            // A display boundary (the settings card), like the status line: upstream text, redacted here.
            server: fromUpstream(`${config.locationName ?? "Home Assistant"}${config.version !== undefined ? ` ${config.version}` : ""} at ${baseUrl}`, secrets),
            lists: `${house.areas.length} areas, ${house.lights.length} lights, fetched ${clock(house.fetchedAt)}`
          })
        }
        return instance
      }).pipe(
        // The last resort: anything unexpected leaves as a sanitised start error.
        Effect.catchDefect((defect) =>
          Effect.fail(moduleStartError(secrets, { message: `Home Assistant could not start: ${fromUpstream(defect, secrets)}`, cause: defect }))
        ),
        Effect.mapError((e) => moduleStartError(secrets, { message: e.message, cause: e.cause }))
      )
    }
  })

/** The module as registered in the app's catalog (real `fetch`, 60 s refresh). */
export const homeAssistant = homeAssistantModule()
