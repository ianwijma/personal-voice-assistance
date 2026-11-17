# Dashboard (the ambient home screen)

Research write-up, 2026-11-18. Not an approved design. Outside facts carry inline links checked on this date. Claims
marked **[unverified]** or **[from memory]** were not confirmed in a primary source.

## 1. Summary

What a screen shows when nobody is talking to it: a configurable layout of **widgets** fed by other modules. The
candidates are clock, weather, agenda, running timers, lists, now playing, cameras, energy, a photo frame, transit
departures, bin day and the inbox count. The character lives in the layout. When someone addresses it, it takes the
stage, and it gives the stage back when the conversation ends. The layout is per device and edited in the admin UI.
It adapts to how close people are (glanceable from across the room, detailed up close), and it has a night mode and
burn-in protection for always-on displays.

- **Boundary.** The Presentation foundation defines the kinds, the Ambient layout and pinned widgets
  ([presentation §4.4](../module-investigation/presentation-and-device-capabilities.md#44-pinned-widgets-and-the-ambient-stage)).
  This module is the **layout engine and widget contract** on top of that. It does not redesign them. Other
  documents keep their parts:
  - [images-and-photos](images-and-photos.md) keeps the photo-frame source; here it becomes a background;
  - [fun-and-ambient](fun-and-ambient.md) keeps idle character behaviour and `ambient.context`;
  - [briefing](briefing.md) keeps the morning cards; here they become a time-windowed page;
  - each data module (weather, calendar, timers, lists, music, smart-home, local-info) owns its widget's data.
- **Priority: second wave**, right after Presentation phase 3. It is what turns a tablet on the wall from "a page
  with a character" into a household device. A fixed first version can come with the Presentation pilot.
- **Effort: L.** The widget contract and the stage hand-over are M. Per-device layouts and the admin editor are M.
  Night mode, burn-in and presence switching are S each. The first version (a fixed layout of clock, weather, timers
  and agenda) is **M**.

## 2. What others do

| System | How the idle screen works | Copy | Avoid |
|---|---|---|---|
| Home Assistant dashboards | Cards in views (sections, masonry, panel); Tile, Picture, Markdown, the Webpage card for iframes ([cards](https://www.home-assistant.io/dashboards/cards/), [webpage card](https://www.home-assistant.io/dashboards/iframe/)). Wall tablets log in through `trusted_networks` with `allow_bypass_login` ([providers](https://www.home-assistant.io/docs/authentication/providers/)); View Assist adds Assist responses on tablets ([View Assist](https://dinki.github.io/View-Assist/docs/intro)) | Cards as data plus a renderer; per-device views | YAML and card mods as the normal path for a household member |
| MagicMirror² | An Electron or browser page with modules placed in named regions (`top_left`, `bottom_bar`…) in `config.js`. Default modules moved to `defaultmodules/` in 2026; v2.36.0 disabled the CORS proxy by default and requires Node ≥ 22.21.1 ([v2.36.0](https://newreleases.io/project/github/MagicMirrorOrg/MagicMirror/release/v2.36.0), [module docs](https://docs.magicmirror.builders/modules/introduction.html)); a forum post mentions v2.38.0 (October 2026) **[unverified: latest]** | Named regions instead of free pixel placement; a huge widget catalogue proves the widget idea | Third-party module code running in the page (exactly what our "no module code in the browser" rule forbids) |
| DAKboard | Hosted wall-display builder. Free tier is one predefined screen; Essential $6/month, Plus $10, Pro $35, with extra screens per month ([pricing](https://dakboard.com/pricing)) | Drag-and-drop layout per screen; a time-based schedule of screens (Pro) | Hosted: calendars and photos pass through a third party |
| Echo Show home content | Rotating cards (weather, news, suggestions) the owner can switch off per category **[from memory]**. Adaptive Content uses on-device vision to show less, larger content from far away and more detail up close; on by default ([Engadget](https://www.engadget.com/amazons-echo-show-8-offers-spatial-audio-and-a-dynamic-proximity-based-ui-151425369.html), [Amazon help](https://digprjsurvey.amazon.com/csad/help/node/TBmEUlW1U7xwcgPvdl)) | The two densities, near and far | Rotation as the main idea (nothing stays where you last saw it); suggestions and upsells |
| Google Nest Hub | Photo frame as the ambient screen, clock and weather overlay, ambient light dimming **[from memory]** | Photos as the background, a few facts on top | — |
| Apple StandBy | Clock, photos and widgets full screen on a charging phone; red-tinted night mode in the dark **[from memory]** | Night mode in red at low brightness | — |
| Fully Kiosk Browser (Android) | Kiosk browser with camera or microphone motion detection that wakes the screen (PLUS) and a REST API on port 2323 for screen on/off and settings ([features](https://www.fully-kiosk.com/docs/en/features/all), [REST](https://www.fully-kiosk.com/docs/en/api/rest)) | The usual way to run a wall tablet; its REST API controls the backlight | Camera-based motion by default (see §13) |

The lessons: data and layout kept apart, a small set of regions, two densities, a stable layout instead of a
carousel, and the device's backlight controlled from outside the page.

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | Nobody speaks. The kitchen tablet shows: a large clock, "8° rain from 15:00", the next two household events, the pasta timer at 4:12, the shopping list's first five items. The character dozes small in the top-left cell. | **yes** |
| 2 | "Hey Jev, add milk." → the dashboard dims and recedes, the character grows to the centre and listens. "Added milk." The list widget, visible behind it, gains "milk". 8 s after the reply the character returns to its cell. | yes |
| 3 | Someone walks up and touches the screen → the near layout: the agenda shows the whole day, the departures widget shows the next four trains with platforms. 60 s without touch → back to the far layout. | yes |
| 4 | "Show the energy page." → the dashboard switches to its "Energy" page: today's use as a `chart`, solar now, the cheapest hours. "Go back." → the default page. | yes |
| 5 | 23:00, quiet hours start → night mode: a dim red clock, the alarm for 06:45, nothing else. The backlight goes to 5 % through Fully Kiosk. | yes |
| 6 | "Hide the cameras for an hour." (guests are over) → the camera widget is removed from every shared-room dashboard until 21:30. "OK, cameras hidden until half past nine." | yes |
| 7 | Hallway speaker (no screen): "Show the dashboard." → "This speaker has no screen. The hallway tablet is showing it." | no |
| 8 | Failure: the transit service is down → the departures widget shows "No live data, 14:02", greyed out with the timetable times. Nothing is spoken. | yes |
| 9 | Ambiguous: "Show the calendar." on the kitchen tablet → a calendar *presentation* for this turn (calendar module), not a dashboard change. "Put the calendar on the dashboard" changes the layout, after "for this tablet, or every screen?" | yes |
| 10 | "Make the clock bigger." → a layout change on this device, if the assistant may edit dashboards (§13): "Done. I've made the clock the large tile here." | yes |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `dashboard_show` | `page?` (name), `where?` (device phrase, resolved by the server as in `show_on`), `for?: duration` | `{ device, page }` | W (device view state) | safe | < 100 ms | **yes** ("show the dashboard", "show the energy page") |
| `dashboard_mode` | `mode: auto \| far \| near \| night \| off`, `where?`, `until?` | the mode and its end | W | safe | < 100 ms | **yes** ("night mode", "screen off") |
| `dashboard_hide` | `widget` (name or kind), `where?: here \| room \| all`, `for?` | hidden widgets and until when | W | changes data | < 100 ms | yes |
| `dashboard_edit` | `change: add \| remove \| resize \| move`, `widget`, `size?: s \| m \| l`, `page?`, `where?` | the new layout, as a preview `card` | W | changes data (owner-level setting) | < 200 ms | no |
| `dashboard_describe` | `where?` | what the screen shows now, in one sentence per widget | R | safe | < 50 ms | no |

The dashboard needs no tool to *show* data. Widgets update from events. The tools exist for voice control of views,
and `dashboard_describe` answers "what's on the kitchen screen?" from a speaker.

## 5. Integrate or build

### 5.1 The widget contract (Proposal)

A widget is a **Module manifest** contribution, like tools: data on the server, rendered on the device by the
existing Presentation renderers. No module code runs in the browser.

```ts
// PROPOSAL — a new optional ModuleContributions field, apiVersion >= 2
interface WidgetDefinition {
  readonly id: string                                   // "weather.now", "timers.active", "local-info.departures"
  readonly label: string                                // shown in the admin palette
  readonly sizes: ReadonlyArray<"s" | "m" | "l">        // grid footprint: s = 1x1, m = 2x1, l = 2x2 cells
  readonly density: ReadonlyArray<"far" | "near">       // which densities it has a body for
  readonly sensitivity: "normal" | "personal"           // personal: not on shared/public places (presentation §6.1)
  readonly settings?: SettingsSpec                      // per placed instance: which list, which stop, which camera
  readonly body: (ctx: WidgetContext) => Effect<PresentationBody | "empty", WidgetError>
  readonly refresh: { readonly on?: ReadonlyArray<string>; readonly everyS?: number }   // Event bus topics, or a poll
}
// WidgetContext: { instance settings, deviceId, place, density, size, person? }
```

- **Bodies are Presentation kinds** (`weather`, `timer`, `list`, `media`, `facts`, `chart`, `image`, `table`,
  `text`). That gives every widget a far and a near rendering and the per-kind fallback. Two kinds are added: `clock`
  (rendered entirely on the device, from the device's own clock and the household time zone, so it ticks without
  the server) and `agenda` (already proposed in [calendar Q4](calendar.md#15-open-questions)).
- **Refresh by event, poll only while visible.** The dashboard service subscribes to the declared Event bus topics
  (`timers.*`, `lists.changed`, `music.playback.changed`) and recomputes only affected widgets. A polled widget
  (departures, every 60 s) is polled only while at least one connected, visible device shows it (`DeviceLiveState.visible`).
- **Delivery.** `dashboard.layout { pages, cells }` at connect and on change, and `widget.update { cellId, body }`.
  Both are new additive message types, which old clients ignore. The layout itself is a device setting (§10).

### 5.2 Widget catalogue

| Widget | From module | Kind | Far body | Near body | Updates |
|---|---|---|---|---|---|
| Clock and date | clock | `clock` | time, weekday | plus date, second time zone | device-local |
| Weather | weather / local-info | `weather` | now, rain warning | hourly and three days | every 15 min |
| Agenda | [calendar](calendar.md) | `agenda` | next two household events | the whole day, per person colour (personal filtered) | `calendar.changed` |
| Running timers and next alarm | [timers-and-alarms](timers-and-alarms.md) | `timer` | the ring with minutes | labels, pause and +1 min buttons | `timers.*` |
| A list | [lists](lists.md) | `list` (checklist) | top five, count | full, tap to tick (calls the tool directly, [investigation §11 d](../module-investigation/investigation.md#11-disagreements-between-documents)) | `lists.changed` |
| Now playing | [music](music.md) | `media` | art and title | controls, room | `music.playback.changed` |
| Camera | [smart-home](smart-home.md) | `image` via `/media/` | one still every 10 s while visible | larger, tap for live-ish refresh | poll while visible |
| Energy | smart-home `energy_today` | `chart` / `facts` | now in watts, today's kWh | per-hour chart, cheapest hours | every 5 min |
| Photo frame | [images-and-photos](images-and-photos.md) | background `image` | full-bleed, dimmed under widgets | the caption "Ghent, a year ago" | the frame's interval |
| Departures | [local-info](local-info.md) `departures` | `table` | next two for the favourite stop | next six with platforms and delays | 60 s while visible |
| Bin day | local-info | `facts` | only on the evening before and the morning | — | daily |
| Inbox | [notifications](notifications.md) | `facts` badge | count of unread | the three newest titles (personal filtered) | `notifications.*` |
| Morning cards | [briefing](briefing.md) | a page | — | the briefing's cards | `briefing.ready` |

### 5.3 Build our own widgets, or embed a Home Assistant dashboard?

| Option | For | Against |
|---|---|---|
| **D1. Own widgets from modules** (§5.1) | Uses the household data we hold (timers, lists, briefing) that HA does not have. The character and the widgets share one stage and one choreography. Personal filtering per place. Works without HA. | Each widget is our work. Fewer card types than HA's ecosystem. |
| D2. Embed one HA dashboard as the whole idle screen (iframe) | Zero widget work for an HA household; HA's card ecosystem | HA sends `X-Frame-Options: SAMEORIGIN` by default, and `http: use_x_frame_options: false` is needed to embed it from another origin. Some users report breakage after updates, and reverse proxies add their own header ([community](https://community.home-assistant.io/t/my-ha-site-will-no-longer-display-in-an-iframe/619987), [write-up](https://archy.net/home-assistant-haproxy-fixing-add-on-access-blocked-by-x-frame-options/)). Logging the iframe in needs `trusted_networks` with bypass, which only skips the login with exactly one selectable user and creates a new login on every refresh ([providers](https://www.home-assistant.io/docs/authentication/providers/)). HTTPS pages cannot embed HTTP HA ([webpage card](https://www.home-assistant.io/dashboards/iframe/)). The content is opaque: the character cannot present it, personal filtering cannot apply, our timers and lists are not in it. |
| D3. The reverse: our voice page inside an HA dashboard (Webpage card) | Households that already live in HA keep their dashboard | The iframe needs `allow="microphone"` for our page to hear. Whether HA's Webpage card sets it is **[unverified]**. The character is confined to one card. |

**Recommendation: D1, with an optional `ha.view` widget and page.** The owner can place one HA dashboard path as a
full page ("the House page") or an `l` cell for the card types we do not have. We document the
`use_x_frame_options` and `trusted_networks` steps, and the [smart-home](smart-home.md) Connection checks the header
and says why it will not load. D3 is documented as a workaround, not built.

## 6. Data

| What | Where | Scope | Shape |
|---|---|---|---|
| Layouts | a new device settings section `dashboard` (owner-edited, like `look`) with defaults per device type and display class | device (type defaults) | `{ pages: [{ id, name, when?: { from, to, days }, cells: [{ id, widget, instance, x, y, w, h, density? }] }], characterCell, background?, night: { from: "quietHours" \| time, widgets[] }, rotation?: none }` |
| View state | Module store | device | `{ page, mode, modeUntil?, hidden: [{ widget, until }] }` |
| Widget caches | each owning module | as that module | — |

Layouts are settings, not store rows, because the owner edits them in admin and they belong in backups with the
rest of the device configuration. Other modules read nothing from the dashboard except `dashboard_describe`'s
export, which says what a device is showing.

## 7. Long-running work and events

- **No Scheduler jobs for rendering.** Page windows (the morning page 06:00–10:00), night mode and page rotation are
  evaluated **on the device** from its clock and the household time zone. They keep working while the server
  restarts.
- **Server side:** one dashboard fiber subscribed to the Event bus, recomputing widget bodies and pushing
  `widget.update` to devices that show them. Polls run only while visible. A `dashboard_hide` with `for` and a
  `dashboard_mode` with `until` are short Scheduler `deferred` jobs, so they survive a restart.
- **Events listened to:** every widget's declared topics; `presence` and `occupancy` from smart-home (§8);
  `conversation.started` and `turn.end` for the stage hand-over.
- **Events emitted:** `dashboard.page.changed` and `dashboard.mode.changed`, for routines ("when night mode starts,
  dim the hall lights").
- **Restart:** devices reconnect, and `welcome` carries the layout and every visible widget's current body.

## 8. Presentation

- **Grid and regions.** A 4×3 grid of cells on `standard` landscape displays, 2×4 on portrait, 6×4 on `large`
  (TVs), and a single column on `compact`. Cells hold `s`, `m` or `l` widgets. Free pixel placement is not offered:
  regions, as in MagicMirror², keep layouts readable and portable between devices.
- **The character's place.** The layout reserves a **character cell**, a corner or a `m` cell, where the character
  sits small and `asleep` or `idle` ([fun-and-ambient §8](fun-and-ambient.md#8-presentation)). Presentation already
  allows the host to move and shrink the focus box, and every character follows it
  ([presentation §4](../module-investigation/presentation-and-device-capabilities.md#4-the-character-and-the-content-share-the-stage)),
  so no character changes.
- **Taking the stage.** On `listening` (a wake phrase, a tap on the character, or the follow-up window), the dashboard
  scales to 96 %, dims to 40 % and blurs slightly, and the character's box glides to the centre (320 ms, the same
  easing as presentations). Presentations from the conversation then use their normal layouts over the dimmed
  dashboard. Eight seconds after the last reply, and after transient presentations leave, the character glides back
  to its cell. Pinned presentations (a new timer) become dashboard cells in an "Orbit" strip until they end.
- **Far and near.** The far layout uses each widget's far body at about twice the type size: a clock readable at 4 m,
  at most four widgets. The near layout uses near bodies and every cell. Switching signals, in order of trust:
  1. a touch (`lastInteractionAt`);
  2. a voice turn on this device;
  3. a presence or mmWave occupancy sensor in the room through smart-home (an LD2410-class sensor **[from memory]**);
  4. Fully Kiosk's motion event, if the owner has set it up.
  The device returns to far 60 s after the last signal. The browser's camera is **never** used for proximity by
  default (§13, [vision](vision.md)).
- **Night mode.** From quiet hours or a set time: a black background, a dim red-tinted clock, the next alarm and any
  running timer, and nothing else. CSS cannot lower a backlight, so the backlight is set through the kiosk app's
  REST API (`screenOff` or brightness through Fully Kiosk **[unverified: command names]**) or HA's Fully Kiosk
  integration. Without either, the page goes black and says so in admin.
- **Burn-in and staying awake.** On OLED displays (some tablets, phones, TVs), static elements move by a few pixels
  every minute (pixel shift), the background is never static white, and the far layout swaps mirror positions
  hourly. LCD tablets are less at risk and get pixel shift only. A visible page keeps the screen awake with the
  Screen Wake Lock API (`navigator.wakeLock.request("screen")`, secure context only **[from memory]**) and re-requests
  it after visibility changes. Kiosk apps can do the same.
- **Without a screen:** nothing to show. `dashboard_describe` speaks what another screen shows (example 7).

## 9. Notifications and proactive behaviour

The dashboard never speaks. It is where `low` and `normal` notifications are *seen*: the inbox badge, and a banner
cell for 30 s for `normal` items on shared screens with `personal` items reduced to "1 new message for Ian". `high`
items belong to the Notification service and take the stage like a conversation. In quiet hours the dashboard is the
only output for anything below `high`, which fits [shared-state §8.2](../module-investigation/shared-state-jobs-and-notifications.md#82-priority-and-what-each-may-do).

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | widgets allowed on shared screens; widgets never on public screens (cameras, inbox, agenda details); night mode follows quiet hours | all except cameras and personal; cameras, inbox, personal; yes |
| Module | default layouts per display class; poll ceilings; burn-in protection (auto / on / off); backlight control (none / Fully Kiosk / HA entity) | presets below; 60 s minimum; auto; none |
| Assistant | may change dashboards by voice (`dashboard_edit`); may switch pages and modes | no; yes |
| Device (the `dashboard` section) | on/off; layout pages; character cell; background; far/near switching signals; night mode; OLED | on for `alwaysOn` devices, off otherwise; display-class preset; top-left; none; touch and voice; on; detected? no (owner sets) |
| Person | personal widgets on my private devices (my agenda, my inbox) | on |

**Admin editor.** Devices › a device › Dashboard shows a live preview at the device's own size and density (rendered
by the same components), a palette of widgets from running modules, drag to cells, per-instance settings (which list,
which stop), "copy from another device" and "reset to the preset". Presets: *Kitchen* (clock, weather, timers, list,
agenda), *Hallway* (clock, weather, departures, bin day, no personal), *Living room TV* (photo background, clock, now
playing), *Bedside* (clock, alarm, weather; night mode from 21:00).

First-run setup: mark the device `alwaysOn` in its place settings, pick a preset, optionally connect backlight
control.

## 11. Native tools and dependencies

| Need | Where | When missing |
|---|---|---|
| None on the server beyond the modules that feed widgets | — | a widget whose module is `unavailable` is shown greyed with the module's one-line reason; nothing is spoken |
| A kiosk browser (Fully Kiosk Browser, or Chromium in kiosk mode) | the display | the dashboard runs in a normal tab and may sleep with the screen |
| Backlight control: Fully Kiosk REST (PLUS licence for motion), or an HA entity | the display or HA | night mode is black pixels on a lit panel; admin says so |
| HTTPS | server | the Wake Lock API is unavailable, so the screen may sleep |
| Presence sensors (optional) | the room, through HA | far/near switches on touch and voice only |

## 12. Interaction with the rest of the system

- **Voice.** "Show the dashboard", "night mode", "screen off" and "show the energy page" are typed actions with
  examples (the fast path). Page names come from the layout and are matched as a `dynamic` param. A command meant
  for another screen ("show the energy page on the TV") resolves `where` with the `show_on` resolver.
- **The character.** Characters get no new input. Optionally, `ambient.context` from fun-and-ambient lets a character
  glow lower in night mode. The hand-over (§8) is host layout only.
- **Assistants.** No template. Every assistant sees one ambient-facts line about what its device shows ("Kitchen
  tablet shows: pasta timer 4:12, shopping list"), so "how long is left?" works without a tool.
- **Other modules.** Every module with a widget (§5.2). Briefing's pinned cards become a "Morning" page with a time
  window. Images' photo frame becomes a background. Music's StandBy-style art becomes the TV preset's main cell.
  Routines can switch pages.

## 13. Privacy and safety

- **Personal widgets** (`sensitivity: personal`: a person's agenda, inbox titles, messages, cameras) follow
  [presentation §6.1](../module-investigation/presentation-and-device-capabilities.md#61-degradation-rules-proposal-decided-by-the-presenter-per-presentation):
  never on `public` places, on `shared` only when the owner allowed that widget there, always on `private`.
- **Cameras on a dashboard** show other rooms to whoever stands in front of the screen. They are off by default on
  shared screens, never on public ones. "Hide the cameras" is a one-phrase action (example 6) open to anyone in the
  room, because hiding is always safe.
- **No camera for presence.** Proximity from the tablet's own camera (Echo's approach, or Fully Kiosk's motion
  detection) means a camera running all day. That contradicts [vision §13](vision.md#13-privacy-and-safety), so it is
  off and needs an explicit owner choice with the indicator rule.
- **Editing.** `dashboard_edit` is an owner-level change. By default no assistant has it, and guests and kids' devices
  never do.
- **Guests.** A guest mode (a device toggle) hides every personal widget and the inbox at once.

## 14. Foundations needed

- **Presentation** (kinds, renderers, the Ambient layout, `/media/`) and **Device capabilities** (display class,
  `place.privacy`, `alwaysOn`, `visible`). These are the hard ones.
- **Module manifest** (`widgets`), **Event bus** (updates), **Notification service** (badge, banner), **Scheduler**
  (timed hides), a new device settings section `dashboard` (a protocol bump, like `look`).
- **A first version without most of them:** a host-built home screen on `alwaysOn` devices with a fixed layout: a
  device-side clock, the weather module's current conditions over a small polling message, and the character in its
  corner. Timers and the agenda join when their modules exist. No editor; a preset per display class.

## 15. Open questions

1. **Which screens are dashboards?** Kitchen tablet, hallway, TV, bedside? That decides which presets to build first.
2. **Is there an HA dashboard the household already uses?** If so, is the `ha.view` page enough at first, with our
   widgets only for timers, lists and the character?
3. **Presence sensing:** are there mmWave or occupancy sensors in the rooms with screens, or is touch and voice
   enough? Is a camera for proximity ever acceptable?
4. **Backlight:** do the tablets run Fully Kiosk (with a PLUS licence), or another kiosk app?
5. **OLED** displays anywhere? That decides how aggressive burn-in protection must be.
6. **Stable or rotating:** this document proposes stable pages with time windows and no carousel. Is any rotation
   wanted (for example photos only)?
7. **Disagreement with [presentation §3.7](../module-investigation/presentation-and-device-capabilities.md#37-lifetime-and-dismissal)
   and [§4.4](../module-investigation/presentation-and-device-capabilities.md#44-pinned-widgets-and-the-ambient-stage).**
   Those sections make the ambient state "idle with pinned items". On `alwaysOn` devices this document makes the
   dashboard the ambient state, with pinned presentations as one strip in it. The Ambient layout then becomes the
   dashboard's far density.
8. **Disagreement with [briefing §8](briefing.md#8-presentation)** ("cards pinned until 10:00") and
   [images §8](images-and-photos.md#8-presentation) (the photo frame as its own Ambient mode). Both should be
   dashboard pages or backgrounds, so that one engine decides what an idle screen shows.
