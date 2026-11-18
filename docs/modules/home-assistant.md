# Smart home (`home-assistant`)

Lights, switches, climate and covers through the owner's Home Assistant, and the `HomeAssistant` transport for other modules.

- Package: `packages/module-home-assistant` (existing; its pull request may change all of it)
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 9 (wave A)
- Research: [docs/research/modules/smart-home.md](../research/modules/smart-home.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

An existing module, rewritten by the smart-home pull request, which touches all of `packages/module-home-assistant/` and this page
(docs/MODULES.md, "What a module pull request may touch").

## What it does

The assistant sees and switches the house through the owner's Home Assistant: lights, switches (and fans and on/off
helpers), heating, and blinds and shades, by room, by name, everywhere, or **here** (the room of the device that is
asked, `CurrentTurn.room`, matched to a Home Assistant area by its name or the owner's other names). It reads the state
of everything it knows, locks, alarm panels and garage doors included; it never changes a lock, an alarm panel, a
garage door, a gate or a door. Scenes and scripts run only when the owner named them one by one.

It is off by default (module API v2). With it off, nothing contacts Home Assistant.

How it works:

- **One client and one cache for every assistant**, in the module's `shared` part. At the start it reads
  `GET /api/config` (the address and the token) and renders one template (`POST /api/template`, admin only) that
  returns the areas and the entities of the kinds below as JSON, at most 1 MiB. The cache is read again every minute
  in the background, off the turn path. Commands resolve their target from the cache; questions (`lights_status`,
  `climate_status`, `locks_status`, `home_state`) read the house again at once, at most 3 s.
- **A refused token or a user who is not an administrator** is a start error (only the owner can fix it). An
  **unreachable, slow or garbled** Home Assistant is not: the module runs, its status line says so, every command
  answers "I couldn't reach Home Assistant.", and the next background read picks it up again (a power cut restarts
  both at once).
- **What it offers follows the house**: an action is offered when the assistant uses its kind (`domains`) and the house
  has one of them; when the kinds in the house change (a first thermostat), the module starts again with the new set.
  Before the first successful read it offers every kind the assistant chose.
- **Every service call names its entities by id** (never an area), at most 50 per call, all in parallel, each within
  3 s, so an action keeps within its 5 s. A call that gets no answer says it may have happened.

## Tools

Every action is also a tool for the model (`home-assistant_<id>`), and runs without the model from its examples.
Targets are a room, a device's name, "all …", or nothing (here). Risk: `change` unless said otherwise.

| Action / tool | Parameters | Example | Says |
|---|---|---|---|
| `lights_on` | `target` | "turn on the kitchen lights", "licht aan" | "I've turned on the lights in Kitchen." |
| `lights_off` | `target` | "lights off", "doe het licht uit in de keuken" | "I've turned off the lights in Kitchen." |
| `set_brightness` | `target`, `level` 0–100 | "dim the living room to 30 percent" | "I've set the lights in Living room to 30 percent." |
| `lights_status` (read) | – | "which lights are on" | "Ceiling and Kitchen light are on." |
| `switches_on` / `switches_off` | `target` (switch, fan, `input_boolean`) | "turn on the coffee machine", "zet de ventilator uit" | "I've turned on Coffee machine." |
| `climate_set` | `target`, `temperature` 5–35 | "make it 21 degrees in here" | "I've set the heating in Living room to 21 degrees; it's 18.5 degrees now." |
| `climate_mode` | `target`, `mode` (heat, cool, automatic, off) | "turn the heating off" | "I've set the heating in Living room to off." / "… can't be set to cooling." |
| `climate_status` (read) | `room` (default here; the whole house when the device has no room) | "how warm is it in here" | "Kitchen temperature is 21.3 degrees." |
| `covers_open` / `covers_close` / `covers_stop` | `target` | "close the blinds", "doe de zonwering dicht" | "I'm closing the blinds in Living room." |
| `cover_position` | `target`, `position` 0–100 | "set the blinds to half" | "I'm setting Living room blinds to 30 percent open." |
| `scene_activate` | `scene` (the ones the owner named) | "movie time", "zet filmavond aan" | "I've started Movie time." |
| `locks_status` (read) | – | "is the front door locked" | "Alarm is disarmed, Garage door is closed and Front door is locked." |
| `home_state` (tool, read) | `area?` (a name or "here"), `kind?` | – | Rooms and their devices with their state, at most 60 lines and how many more |

**Garage doors, gates and doors are `security`.** The cover actions declare `change` and `security`: a target that is
a garage door, a gate or a door, or a room that holds one, is `security`, which the risk policy refuses on every path
("Not run: …"), so nothing reaches Home Assistant. "All blinds" are the blinds and shades only. "Here" in a room with
a garage door is refused by the module itself ("I don't open or close garage doors, gates or doors by voice."), and so
is any cover whose class changed since its name was chosen. **Locks and alarm panels have no action that changes
them**; `locks_status` and `home_state` read them (`read`, as the plan says).

Questions it asks instead of guessing: "Which room? I don't know which room this device is in." (here on a device
without a room); "I don't know a room called Attic in Home Assistant. Which room do you mean?" (a room that is no
area); "There are no lights in Hall that I may use."

Failures, each one sentence: unreachable, didn't answer in time (a command: "so I don't know whether it happened"),
the token refused, the user not an administrator, restarting (503), an error, an answer it cannot read. Every sentence
is in English and Dutch (`HOME_LANGUAGE`); names come from Home Assistant as the owner wrote them.

## Settings

The fields, their keys and their order are the ones an owner already has; saved values keep working.

| Key | Kind | Default | Notes |
|---|---|---|---|
| `baseUrl` | text, env `HOME_ASSISTANT_URL` | empty (start error) | http(s) only; an address with a user name, a password or a query is refused without repeating it |
| `token` | secret, env `HOME_ASSISTANT_TOKEN`, required | | a long-lived token of an administrator (the template API is admin only) |
| `domains` | multichoice, **overridable** | every kind | lights; switches, fans and helpers; heating; blinds (garage doors, gates and doors only read); media players (only read); temperature, humidity, door and window sensors (only read); locks and alarm panels (only read). An assistant may use fewer. An old saved value (`["light"]`) is still valid |
| `aliases` | text | empty | "Other names": one line per room, device, scene or script (`Living room: lounge, woonkamer`). A device's room is matched to an area by these too. **A scene or script is offered only when it has a line under its own id** (`scene.movie_time: movie time`): what a script does cannot be seen from outside it, so the owner chooses them one by one |
| `timeoutMs` | number, advanced | 2000 | 300–10,000 ms per request; a command waits at most 3 s, a start request at most 4 s |
| `server`, `lists` | info | | where it is connected; what it read, and the scenes and scripts named |
| `test` | button | | the same two requests as a start, with the address in the form (saved or not) |

## What it stores

Nothing in the household store: no collection, no job. The cache of the house is in memory and is read again at each
start. **Nothing personal is read or kept**: the template reads only the kinds above, no `person`, `device_tracker`,
`zone` or camera, and only sensors of a named class (temperature, humidity, light level, pressure, CO₂, fine dust,
doors, windows, leaks, smoke, CO, gas). A sensor without a class is never read, because Home Assistant's companion app
makes classless sensors that say where a phone is; the decoder drops them too if an answer carries them. So nothing it
says is about one person, and it calls no `Privacy.mayReveal`.

## What it needs

- `requires: [{ network: "lan" }]`: the owner's Home Assistant on the network, with an administrator's long-lived
  token.
- `health`: no address, no token, `GET /api/config` unreachable, the token refused, the user not an administrator
  (each with what to do). Nothing while it is not set up and off.
- `uses`: none. Provides: nothing yet (the `HomeAssistant` service is left out, below). Consumes: no service.

## What was left out

**Left out because something is missing below (reported in the pull request):**

- **The WebSocket entity cache, with Home Assistant's registries and its list of what is exposed to Assist.**
  `docs/MODULES.md` §12 allows outgoing HTTP only through `@pva/net`, `GET` and `HEAD` only, and `@pva/net` has no
  WebSocket; "a streamed request" is named as not in this wave. So the module keeps its existing transport (REST:
  `GET /api/config`, `POST /api/template`, `POST /api/services/…`, through `fetch`, with a time limit and a size limit
  on every call), polls every minute, and cannot read the exposure list, the area aliases or the entity aliases (they
  are WebSocket-only). Until then **every device of a chosen kind is used**: the owner narrows it with `domains` per
  assistant. Needs: a WebSocket to an owner-configured LAN address in `@pva/net` (with the same address rules as
  `fetchOwnerConfiguredLan`), allowed for this module by the guide, and a fixture for it in the test kit's offline
  network.
- **The `HomeAssistant` service** (`packages/module-contracts/src/homeAssistant.ts`), for presence and music. This
  package does not depend on `@pva/module-contracts`, so it cannot import the key, and a module pull request may not
  change the lockfile; and the contract promises the exposure list, which needs the WebSocket above. Needs:
  `"@pva/module-contracts": "workspace:*"` in this package's `package.json` (and the matching lockfile line), then the
  service over this cache with the contract's refusals. Until then `texts.ts` carries local copies of `homeLanguage`
  and `say`.
- **A connection instead of the module's secret fields**: connections are deferred (P8); the address and token fields
  stay.
- **Hiding single entities and choosing scenes from a list**: a new settings field would change the form the app's
  serve test pins (`apps/assistant/test/serveModules.test.ts`); scenes are chosen through "Other names" instead.

**Left out for wave B** (phrase commands, presentations, notifications and a module's own speech do not exist yet):
the short cue instead of words for a command in the device's own room; a `facts` card for climate and a `list` of what
is on in a room; doorbell, leak and smoke notifications.

**Left for later by the plan:** locking, unlocking, arming and disarming; watches ("tell me when the washing machine is
done"); cameras; energy; delayed commands; media player control (music's, over the `HomeAssistant` service); the MCP
long tail.
