# @pva/module-home-assistant

Lights, switches, heating and blinds by room through the owner's Home Assistant; locks, alarm panels, garage doors and
every cover that is not a blind only read; no scripts; the `HomeAssistant` service (polled) for presence and music. Module id `home-assistant`, module API v2,
**off by default**. Nothing happens on import; nothing contacts Home Assistant until an assistant has it on.

What it does, its actions and tools, settings, what it stores (nothing; people are read for the service only) and what was left out:
[docs/modules/home-assistant.md](../../docs/modules/home-assistant.md).

## Files

- `src/client.ts`: the REST client (`GET /api/config`, `POST /api/template`, `POST /api/services/<domain>/<service>`),
  through `@pva/net`'s `fetchOwnerConfiguredLan` only: no redirect, typed loopback, a byte and a time limit per call,
  every error sanitised (`src/redact.ts`, shared byte for byte with the other adapters).
- `src/house.ts`: the page template and its decoder (secrets dropped whole), the blind classes, scenes and their
  members, the names of every target over the whole house (indexed in steps), "here".
- `src/inventory.ts`: the house read in pages, people first, at most the supported size, incomplete beyond it.
- `src/module.ts`: the definition: the `shared` part (client, cache, background read), the instance (actions, the
  `home_state` tool, status line, form values), health, the Test button.
- `src/service.ts`: the `HomeAssistant` transport of `@pva/module-contracts` over the polled cache (state, the pulled
  change stream with its snapshots, `callService`), and the one checked path every service call takes, the module's own too.
- `src/texts.ts`: every spoken sentence in English and Dutch; numbers and lists by `@pva/language`.

## Tests

- `pnpm vitest run packages/module-home-assistant` (from the root, behind the shared lock): through the test kit's
  real host and gateway, against `test/fakeHa.ts`, a fake Home Assistant served by the kit's offline network
  (`makeOfflineNet`: no socket, no network; it records each request's method and body). `test/fakeHomeAssistant.ts`
  is an HTTP fake on 127.0.0.1 used by the app's serve tests.
- Live, opt-in, read-only unless a light is named:

  ```
  HOME_ASSISTANT_URL=http://homeassistant.local:8123 HOME_ASSISTANT_TOKEN=<long-lived token> \
    pnpm --filter @pva/module-home-assistant exec vitest run test/live.test.ts --silent=false
  # also toggle one light and put it back:
  HOME_ASSISTANT_LIVE_TOGGLE=light.desk_lamp HOME_ASSISTANT_URL=… HOME_ASSISTANT_TOKEN=… pnpm --filter @pva/module-home-assistant exec vitest run test/live.test.ts --silent=false
  ```

**Not verified against a real Home Assistant** (none was available): the page template on the owner's version (the
`variables` of `POST /api/template`, `selectattr` with `"gt"` and `"in"`, `area_id(entity)`, a scene's `entity_id`
attribute), and the latency of a command.

## Sources

- REST API: <https://developers.home-assistant.io/docs/api/rest/> (`Authorization: Bearer`, `GET /api/config`,
  `POST /api/services/<domain>/<service>`, `POST /api/template`, admin only).
- Template functions: `areas`, `area_name`, `area_id` (an entity's own area, else its device's), `state_attr`, `to_json`; the template API's `variables`:
  <https://www.home-assistant.io/template-functions/>.
- Services: `light.turn_on` (`brightness_pct`), `climate.set_temperature`, `climate.set_hvac_mode`,
  `cover.open_cover` / `close_cover` / `stop_cover` / `set_cover_position`, `scene.turn_on`:
  <https://www.home-assistant.io/actions/>.
- Area and entity aliases and the Assist exposure list are not readable from templates (WebSocket only).
- Cover device classes (`awning`, `blind`, `curtain`, `damper`, `door`, `garage`, `gate`, `shade`, `shutter`, `window`): <https://www.home-assistant.io/integrations/cover/>.
