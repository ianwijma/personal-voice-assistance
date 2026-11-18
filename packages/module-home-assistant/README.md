# @pva/module-home-assistant

Lights, switches, heating and blinds by room through the owner's Home Assistant; locks, alarm panels and garage doors
only read. Module id `home-assistant`, module API v2, **off by default**. Nothing happens on import; nothing contacts
Home Assistant until an assistant has it on.

What it does, its actions and tools, settings, what it stores (nothing) and what was left out:
[docs/modules/home-assistant.md](../../docs/modules/home-assistant.md).

## Files

- `src/client.ts`: the REST client (`GET /api/config`, `POST /api/template`, `POST /api/services/<domain>/<service>`),
  each call with a time limit and a size limit, every error sanitised (`src/redact.ts`, shared byte for byte with the
  other adapters).
- `src/house.ts`: the one inventory template, its bounded decoder, the targets of each kind, "here", the security
  covers.
- `src/module.ts`: the definition: the `shared` part (client, cache, background read), the instance (actions, the
  `home_state` tool, status line, form values), health, the Test button.
- `src/texts.ts`: every spoken sentence in English and Dutch.

## Tests

- `pnpm vitest run packages/module-home-assistant` (from the root, behind the shared lock): through the test kit's
  real host and gateway, against the in-process fake of `test/fakeHa.ts` (a `fetch` function: no socket, no network).
  `test/fakeHomeAssistant.ts` is an HTTP fake on 127.0.0.1 used by the app's serve tests.
- Live, opt-in, read-only unless a light is named:

  ```
  HOME_ASSISTANT_URL=http://homeassistant.local:8123 HOME_ASSISTANT_TOKEN=<long-lived token> \
    pnpm --filter @pva/module-home-assistant exec vitest run test/live.test.ts --silent=false
  # also toggle one light and put it back:
  HOME_ASSISTANT_LIVE_TOGGLE=light.desk_lamp HOME_ASSISTANT_URL=… HOME_ASSISTANT_TOKEN=… pnpm --filter @pva/module-home-assistant exec vitest run test/live.test.ts --silent=false
  ```

**Not verified against a real Home Assistant** (none was available): the inventory template on the owner's version
(`for … if` loop filtering, `area_id(entity)`, the attribute names), and the latency of a command.

## Sources

- REST API: <https://developers.home-assistant.io/docs/api/rest/> (`Authorization: Bearer`, `GET /api/config`,
  `POST /api/services/<domain>/<service>`, `POST /api/template`, admin only).
- Template functions: `areas`, `area_name`, `area_id` (an entity's own area, else its device's), `to_json`:
  <https://www.home-assistant.io/template-functions/>.
- Services: `light.turn_on` (`brightness_pct`), `climate.set_temperature`, `climate.set_hvac_mode`,
  `cover.open_cover` / `close_cover` / `stop_cover` / `set_cover_position`, `scene.turn_on`, `script.turn_on`:
  <https://www.home-assistant.io/actions/>.
- Area and entity aliases and the Assist exposure list are not readable from templates (WebSocket only).
