# @pva/module-home-assistant

Lights and rooms from a Home Assistant server (build plan piece K, `docs/AGENTS-AND-INTENTS.md` §3.9). Module id
`home-assistant`, **off by default**. Nothing happens on import; nothing contacts Home Assistant until the module is
enabled.

## What it does

- **Start** (≤ 2 × `timeoutMs`): `GET /api/config` checks the address and the token, then one `POST /api/template`
  renders the areas and light entities as JSON (`INVENTORY_TEMPLATE` in `src/home.ts`). Errors are settings errors with
  one sentence saying what to fix: wrong address / no answer, rejected token, token user not an administrator (the
  template API is admin only), unreadable answer.
- **Lists** are cached and refreshed every 60 s in the module's scope, and soon after a lookup of an unknown value; a
  turn never waits for them. A failed refresh keeps the old list and turns the status line into a warning.
- **Actions** (typed intents, each also a tool for conversational agents): `lights_on`, `lights_off`, `set_brightness`
  (`brightness_pct`), `lights_status` (speculative, live read). `target` options: `area:<area_id>` per area, `light.<id>`
  per light, `all` (sent as the explicit list of known light entities).
- **Tool** `home_state` (speculative): rooms and lights with state and brightness, read live.
- Failures are speakable `ActionError`s: "I couldn't reach Home Assistant.", "Home Assistant didn't answer in time.",
  "Home Assistant rejected the access token.", "Home Assistant reported an error.".
- Status line: `3 areas · 7 lights · HA 2026.11.1`.

## Spoken names

Home Assistant's area aliases cannot be read from a template (no template function exposes them), so names come from:
the area or light name; generated forms (`<area> lights`, `<area> light`; for `all`: "all lights", "everything",
"alle lampen", …); and the **Other names** setting, one line per room or light:

```
Living room: lounge, woonkamer
light.desk_lamp: bureaulamp
all: alles
```

The left side matches an area name or id, a light name or entity id, or `all`. Leading articles ("the living room") and
phonetic matching are the intent path's job (`TextMatching`).

## Settings

| Key | Env | Default |
|---|---|---|
| `baseUrl` | `HOME_ASSISTANT_URL` | (empty: start error) |
| `token` (secret, required) | `HOME_ASSISTANT_TOKEN` | |
| `domains` | | `light` (only lights in this version) |
| `aliases` | | empty |
| `timeoutMs` (advanced) | | 2000 |

## Tests

- `pnpm --filter @pva/module-home-assistant test`: unit tests against a fake HA HTTP server on 127.0.0.1
  (`test/fakeHomeAssistant.ts`): start, status, actions and their request bodies, live status, `home_state`, timeouts,
  500, unreachable server, wrong token, non-admin token, background refresh and its failure, scope close stops refresh.
- Live, opt-in (read-only unless a light is named):

  ```
  HOME_ASSISTANT_URL=http://homeassistant.local:8123 HOME_ASSISTANT_TOKEN=<long-lived token> \
    pnpm --filter @pva/module-home-assistant exec vitest run test/live.test.ts --silent=false
  # also toggle one light and put it back:
  HOME_ASSISTANT_LIVE_TOGGLE=light.desk_lamp HOME_ASSISTANT_URL=… HOME_ASSISTANT_TOKEN=… pnpm --filter @pva/module-home-assistant exec vitest run test/live.test.ts --silent=false
  ```

**Not verified against a real Home Assistant** (none was available): the inventory template on the owner's version,
`area_entities` membership for device-assigned lights, action latency.

## Sources (fetched 2026-11-13)

- REST API: <https://developers.home-assistant.io/docs/api/rest/> (now served at
  <https://contributors.home-assistant.io/core/internals/rest-api/>): `Authorization: Bearer`, `GET /api/config`,
  `POST /api/services/<domain>/<service>`, `POST /api/template` ("Admin only", returns plain text), status codes.
- Template functions: <https://www.home-assistant.io/template-functions/>, `areas`
  (<https://www.home-assistant.io/template-functions/areas/>), `area_name`
  (<https://www.home-assistant.io/template-functions/area_name/>), `area_entities` ("Includes both entities assigned
  directly to the area and entities inherited from devices in that area",
  <https://www.home-assistant.io/template-functions/area_entities/>), `to_json`
  (<https://www.home-assistant.io/template-functions/to_json/>).
- `light.turn_on` (`area_id` / `entity_id` targets, `brightness_pct` 0–100):
  <https://www.home-assistant.io/actions/light.turn_on/>.
- Area aliases (no template access): <https://home-assistant.io/voice_control/aliases>,
  <https://community.home-assistant.io/t/how-to-access-an-area-alias/771566>.
