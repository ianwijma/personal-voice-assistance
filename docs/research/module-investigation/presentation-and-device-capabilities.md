# Presentation and device capabilities

Research and design options, written 2026-11-17. Nothing here is built. It answers two questions from the owner:

- **A. Presentation.** "If I ask for an image of a kiwi, how do we present it? Other assistants use an information
  pane or a pop-up. I want it interactive and interesting."
- **B. Device capabilities.** "Some front ends have no display, so the agent should say 'I can't show images on this
  device'. A device should tell the agent what it has and what it lacks."

They are one design because they depend on each other. A tool's visual result is only useful if the server knows
where it can go, and a capability vocabulary is only useful if something reads it. Everything marked **Proposal** is
a sketch for discussion, not a contract. The contracts are the service interfaces in `docs/ARCHITECTURE.md` and the
character contract in `docs/CHARACTERS.md`. Any change to either follows the compatibility rules in those documents.

## 1. What exists today

| Area | What is there | Reference |
|---|---|---|
| Tool results | A `Tool.execute` returns `unknown`. The registry encodes the value to a string for the model, and nothing visual comes out of it. | `packages/core/src/Module.ts:6-16`, `packages/core/src/ToolRegistry.ts:38,67` |
| Tool events to the browser | `tool.start` carries the name, module and truncated input. `tool.end` carries ok, ms and the error. Neither carries a result. They are shown as chips in the chat panel. | `packages/protocol/src/server.ts:115,128`, `apps/web/src/components/ToolChip.tsx` |
| Claude subscription agent | Module tools reach Claude Code through an in-process MCP server. The result goes back as one text block. | `packages/agent-claude-code/src/sdk.ts:81-90` |
| Deferred design for cards | "A tool result may carry an optional `display` value from a small closed set of data kinds (`facts`, `list`, `image` URL), sent as an optional field on `tool.end` and rendered by one generic component per kind. Still no module code in the browser." | `docs/UI-AND-MODULES.md:452`, the data-only rule at `:183`, `displayRenderers` at `:1005` |
| Stage | The character draws on a canvas that covers the whole stage. That canvas is fixed and sits behind the page content with no pointer events. DOM overlays sit under the box. `focus` is the box's rectangle; it is re-read every frame and may move without a resize. | `docs/CHARACTERS.md:104-114,276`, `apps/web/src/characters/contract.ts:195,217`, `apps/web/src/ui/voiceRegistry.ts:30`, `apps/web/src/components/Stage.tsx:19` |
| Foreseen character inputs | Planned extensions: `turn.activity` (what the assistant is doing while thinking) and a model cue for "pointing at something on screen". Every extension is timed against played audio, never against arrival. | `docs/CHARACTERS.md:295,302,316` |
| Speculative turns | The publisher holds a speculative turn's messages until the turn is promoted, and drops them if it is discarded. | `docs/UI-AND-MODULES.md:1069` |
| Device identity | `hello.device` is `{ id, kind, name }`. There are no capabilities. | `packages/protocol/src/frontends.ts:245`, `packages/protocol/src/client.ts:49` |
| Device types | Only `web-voice`. `voice-node` exists on its unmerged branch. | `packages/protocol/src/devices.ts:183` |
| Device settings | A closed set of section keys (`DeviceSettingsKey`). Adding one bumps the protocol, as `look` and `voice` did when they took it to 8. `audio.speakAloud` ("Off = replies are shown, never spoken") is the only output-capability-like setting. | `packages/protocol/src/devices.ts:53,68,87`, `packages/protocol/src/constants.ts:66`, `docs/LOOKS-AND-VOICES.md:30` |
| What a device is told | `device.setup`: assistants, phrases, looks, interrupt mode, audio, captions. | `packages/protocol/src/devices.ts:567,597` |
| Voice nodes (branch `t3/voice-node-wp4`) | `hello.node.platform` (os, arch, hostname, model). `node.status` lists audio inputs and outputs. Nothing about a display. | `docs/VOICE-NODES.md` §4.2–4.3 on that branch |
| What the model is told | A stable `system` prompt, cached together with the tools, and a per-turn `context` placed after the cached prefix. The Home line (location, time zone, language) is part of the system prompt. Agents receive `context` too. | `docs/ARCHITECTURE.md:119,273`, `packages/protocol/src/assistants.ts:359`, `packages/agent-claude-code/src/agent.ts:422` |
| Modules with background triggers (timers, reminders) | Deferred. No timer module exists; the built-in modules are clock, weather and the Home Assistant demo. | `docs/UI-AND-MODULES.md:453`, `packages/modules-builtin/src/` |

In short, the browser has a stage, a contract for characters and a place for overlays. The server has nowhere to put
a visual result and no idea what a device can show.

## 2. Prior art: how others present results

| System | How a result becomes visual | What to take from it |
|---|---|---|
| Alexa APL | `Alexa.Presentation.APL.RenderDocument` with a `token`, a `document` and separate `datasources`; later `ExecuteCommands` address the token ([APL interface](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-interface.html)). Responsive templates (Detail, Image List, Headline…) adapt to viewport profiles such as `hubRoundSmall` and `tvLandscapeXLarge` ([templates](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/responsive-templates.html), [profiles](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-alexa-viewport-profiles-package.html)). APLA mixes speech and sound ([APLA](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apla-document.html)). | Layout and data kept apart; a few size classes, not pixels. |
| Alexa cards | `Display.RenderTemplate` is deprecated. A skill without screen support has its card shown on screen devices ([cards](https://developer.amazon.com/en-US/docs/alexa/custom-skills/best-practices-for-skill-card-design.html)). Home cards rotate on the Echo Show's idle screen ([home cards](https://developer.amazon.com/en-IN/docs/alexa/custom-skills/add-content-home-screen.html)). | Always have a plain fallback; the idle screen is real estate. |
| Google Assistant | Fixed rich responses: basic card, table, carousel, list ([rich responses](https://developers.google.com/assistant/conversational/df-asdk/rich-responses)). Interactive Canvas ran a web app on the Nest Hub; text to speech waited on the page's `onUpdate` promise ([reference](https://developers.google.com/assistant/interactivecanvas/reference)). Both shut down with Conversational Actions on 2023-06-13 ([sunset](https://developers.google.com/assistant/ca-sunset)). | Speech and visual can be synchronised by the host; an open canvas was the costliest part to keep alive. |
| Siri (iOS 26) | An App Intent returns an interactive snippet (`SnippetIntent`, `ShowsSnippetView`) whose buttons run further intents ([Apple](https://developer.apple.com/documentation/appintents/snippetintent); detail from [a third-party write-up](https://superwall.com/blog/app-intents-interactive-snippets-in-ios-26)). | Buttons on a result are actions back into the assistant. |
| Adaptive Cards | JSON card plus a `HostConfig` of the host's style and limits (`supportsInteractivity`, `actions.maxActions`) ([host config](https://learn.microsoft.com/en-us/adaptive-cards/rendering-cards/host-config)). An element the host cannot render uses its `fallback`, or `"drop"` ([Action.Execute](https://learn.microsoft.com/en-us/adaptive-cards/schema-explorer/action-execute)). | Per-element fallback; the host states its limits. |
| A2UI (1.0, 2026-11-11) | Agents stream declarative component JSON (`createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`), a flat list joined by ids, limited to a *catalog* the client trusts ([spec 1.0](https://a2ui.org/specification/v1.0-a2ui/), [launch](https://developers.googleblog.com/en/introducing-a2ui-an-open-project-for-agent-driven-interfaces/), [1.0](https://developers.googleblog.com/en/a2ui-10-build-delightful-fast-reliable-agentic-experiences/)). The client lists its catalogs in order of preference (`supportedCatalogIds`, [v0.9.1](https://a2ui.org/specification/v0.9.1-a2ui-extension-specification/)). | "Data, not code, from a trusted catalog": the shape the data-only rule already points to. |
| MCP Apps (SEP-1865, stable 2026-01-26) | A tool points to a `ui://` resource (`text/html;profile=mcp-app`) rendered in a cross-origin sandboxed iframe with a declared CSP, talking over postMessage JSON-RPC (`ui/notifications/tool-result`, `ui/message`, `ui/request-display-mode`); modes `inline`, `fullscreen`, `pip`. Hosts advertise `io.modelcontextprotocol/ui` ([spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)). The ChatGPT Apps SDK now runs on this bridge ([docs](https://developers.openai.com/apps-sdk/build/chatgpt-ui)). | The ecosystem route for arbitrary UIs; heavy, and opaque to the host. |
| Gemini generative UI | "Dynamic view" writes a custom UI as code per answer and "can sometimes take a minute or more" ([Google Research](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)). | Far outside an 800 ms voice budget. |
| Vercel AI SDK | Each tool call is a typed message part (`tool-${name}`) whose output becomes a React component's props; the app ships the components ([generative UI](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)). RSC `streamUI` is experimental ([RSC](https://ai-sdk.dev/docs/ai-sdk-rsc/overview)). | Tool output → app component, with no model-written UI. |
| Home Assistant | Dashboards of cards (Tile, Picture, Markdown…) ([cards](https://www.home-assistant.io/dashboards/cards/)). The community View Assist adds visual responses to Assist on wall tablets ([View Assist](https://dinki.github.io/View-Assist/docs/intro)). | Wall tablets are the household's real screens. |
| Apple StandBy, Live Activities | Long-running state (a timer, a delivery) at a glance, from a small payload (under 4 KB) the system renders ([ActivityKit](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)). | Pinned, glanceable, system-rendered widgets. |
| Characters | The Office Assistant was drawn without a window frame, over the document ([history](https://en.wikipedia.org/wiki/Office_Assistant)); it was hated for interrupting, not for being a character. Zelda's "item get": Link holds the new thing over his head with a jingle ([trope](https://tvtropes.org/pmwiki/pmwiki.php/Main/ItemGet)). Anki Vector's face screen could be taken over by an image ([SDK](https://codaris.github.io/Anki.Vector.SDK/api/Anki.Vector.ScreenComponent.html)). | A character can *present* an object instead of a pane appearing beside it. |

What follows:

1. Every lasting system uses a declarative payload, a host that renders it, and a fallback per element.
2. The free-form web canvases either died (Interactive Canvas) or are sandboxed and heavy (MCP Apps).
3. Nobody makes the assistant's own presence part of the presentation. That is the gap the owner is pointing at.

## 3. Presentation: what a tool returns

### 3.1 Decision: how a presentation is declared

| Option | For | Against |
|---|---|---|
| **P1. Closed catalogue of typed kinds, schema-validated, rendered by our components** (the §1.9 path, A2UI-style) | Fits the data-only rule (`UI-AND-MODULES.md:183`). No module code runs in the page. Validated with Effect Schema like every other message. The character and the layout engine understand every kind, so they can choreograph it. Works on any future host (a node with a small screen, an LED matrix) because the kind is semantic. Cheap to render. | A new kind needs a front-end change. Third-party modules cannot invent visuals. |
| P2. Composable component tree (A2UI's Row, Column, Text, Image) | One generic renderer, and modules can compose new layouts. | The layout engine and the character cannot tell what the content *is* (a timer or a picture). The model or tool designs layouts, so results look inconsistent. A small device cannot adapt a tree it does not understand. |
| P3. Sandboxed iframe (MCP Apps `ui://`) | Unlimited, and reuses an ecosystem: MCP servers that ship apps would just work. | A cross-origin sandbox, CSP and a postMessage bridge to build and secure. Each iframe costs memory on a cheap tablet. No good on non-browser hosts. The character cannot interact with opaque content. Breaks "no module code in the browser". |
| P4. Model writes HTML or markup | Maximum flexibility. | Output tokens cost seconds of latency. Unsafe. Ugly in practice (Gemini's dynamic view takes up to a minute). |

**Recommendation: P1, with one escape hatch.** Provide a catalogue of about 15 semantic kinds (§3.2), versioned per
kind. Every payload carries a `fallback`: a simpler kind or plain text, as in Adaptive Cards. Later, P3 can become one
kind, `app`, shown only on devices that declare `present.kinds.app`, for MCP servers that ship MCP Apps. It would get
its own sandboxed origin and never be the default. Composition (P2) is not needed if the kinds are chosen well.

Tools, not the model, produce presentations in the normal case. A presentation is data the tool already has, so it
costs no model tokens. There is also one built-in `show` tool (§3.5) for content the model composes itself, such as
a short list or a comparison.

### 3.2 Catalogue of primitives (Proposal)

| Kind | Use | Interaction | Speaks well without a screen? |
|---|---|---|---|
| `image` | One picture (the kiwi), with caption and credit | Tap to enlarge, pinch, swipe away | No. Describe it in one sentence. |
| `gallery` | 2 to 12 images, or a choice between meanings ("kiwi" the bird or the fruit) | Swipe, tap to pick ("this one") | No |
| `card` | Title, subtitle, short body, optional image and facts (a person, a place, an article) | Tap for more, actions | Partly |
| `facts` | Label and value pairs (opening hours, a package's status) | None | Yes, if 5 or fewer |
| `list` | Bullets, numbered items or a checklist (shopping list, search results) | Tap an item to select it, tick a box | Top 3 plus "and 7 more" |
| `table` | At most 6 columns by 20 rows (train times) | Scroll | Badly. Summarise. |
| `timer` | A countdown with label, end time and state | Pause, add a minute, cancel | Yes ("4 minutes left") |
| `progress` | A long task (a download, a print, a dishwasher via HA) | Cancel | Yes |
| `weather` | Now, hourly and daily, from the weather module | Swipe between hours and days | Yes |
| `steps` | A recipe or instructions, one step at a time, each step optionally with its own timer | Next and back, by voice or touch | Yes, step by step |
| `map` | A place or route, rendered by the server as a static image with markers (no tile server on the device) | Tap for "send to phone" | No |
| `chart` | A line or bar series (energy use, temperatures) | None | Summarise the trend |
| `media` | Now playing: art, title, position | Play, pause, skip | Yes |
| `confirm` | A question with two buttons, tied to core's confirmation flow (`docs/AGENTS-AND-INTENTS.md` §3.2) | Yes or no by touch or voice | Yes (that is the spoken question) |
| `handoff` | A QR code and short link to open on a phone (a recipe page, a map route, a long article) | Scan | No (offer to send a notification instead) |
| `text` | A short paragraph with light formatting, the universal fallback | None | Yes |

Images never load directly from third parties on the device. The server fetches each image once and checks its type
and size. It serves the image from `/media/<hash>` with dimensions and a blur placeholder, and evicts it after a day.
This keeps the page CSP at `img-src 'self'`, keeps each device's IP away from image hosts, and lets every screen in the
house show the same picture instantly. For "show me a kiwi" the source would be a lookup tool over a public, keyless
image index:

- [Openverse](https://api.openverse.org/v1/images/?q=kiwi) searches openly licensed images and returns licence and
  attribution (not verified beyond its public listing).
- Wikimedia Commons is the alternative.

Both are local-first friendly, since no key or account is needed.

### 3.3 Payload sketch (Proposal)

```ts
// PROPOSAL — packages/protocol/src/presentation.ts. Every kind is versioned; unknown fields are stripped as usual.
type PresentationId = string                         // server-made, unique per server run
type Presentation = {
  readonly id: PresentationId
  readonly body: PresentationBody
  readonly fallback?: PresentationBody               // what to show where `body.kind`@`body.v` is not rendered
  readonly spoken: string                            // one or two sentences: alt text, what a headless device says,
                                                     // and what the model is told was shown
  readonly lifetime: Lifetime
  readonly sensitivity: "normal" | "personal"        // personal: not on shared or public displays (§6.4)
  readonly origin: { readonly moduleId: string | null; readonly tool?: string; readonly turnId?: number; readonly assistantId?: string }
  readonly actions?: ReadonlyArray<PresentationAction>   // at most 4, like Adaptive Cards' maxActions
}
type PresentationBody =
  | { kind: "image"; v: 1; image: ImageRef; caption?: string; credit?: string }
  | { kind: "gallery"; v: 1; images: ReadonlyArray<ImageRef & { id: string; caption?: string }>; pick?: boolean }
  | { kind: "card"; v: 1; title: string; subtitle?: string; body?: string; image?: ImageRef; facts?: ReadonlyArray<Fact> }
  | { kind: "facts"; v: 1; facts: ReadonlyArray<Fact> }
  | { kind: "list"; v: 1; style: "bullets" | "numbered" | "checklist"; items: ReadonlyArray<ListItem>; pick?: boolean }
  | { kind: "table"; v: 1; columns: ReadonlyArray<string>; rows: ReadonlyArray<ReadonlyArray<string>> }
  | { kind: "timer"; v: 1; label: string; endsAt: number; state: "running" | "paused" | "done"; remainingMs?: number }
  | { kind: "progress"; v: 1; label: string; value: number | null }          // null = indeterminate
  | { kind: "weather"; v: 1; place: string; now: WeatherNow; hours?: ReadonlyArray<WeatherHour>; days?: ReadonlyArray<WeatherDay> }
  | { kind: "steps"; v: 1; title: string; steps: ReadonlyArray<{ text: string; image?: ImageRef; timerSeconds?: number }>; current: number }
  | { kind: "map"; v: 1; image: ImageRef; label: string; link?: string }      // rendered server-side
  | { kind: "chart"; v: 1; type: "line" | "bar"; unit: string; series: ReadonlyArray<{ name: string; points: ReadonlyArray<[number, number]> }> }
  | { kind: "media"; v: 1; title: string; artist?: string; art?: ImageRef; state: "playing" | "paused"; positionMs?: number; durationMs?: number }
  | { kind: "confirm"; v: 1; question: string; yes: string; no: string }      // answered through core's confirmation
  | { kind: "handoff"; v: 1; url: string; label: string }                     // the device draws the QR code itself
  | { kind: "text"; v: 1; text: string }                                      // **bold**, lists, links: nothing more
type ImageRef = { src: `/media/${string}`; width: number; height: number; alt: string; placeholder?: string }
type Fact = { label: string; value: string }
type ListItem = { id: string; text: string; secondary?: string; image?: ImageRef; checked?: boolean }
type Lifetime =
  | { class: "moment" }                // the length of the reply plus a few seconds (a fun fact image)
  | { class: "glance"; ms?: number }   // until the next turn, or 60 s after the reply (default for most kinds)
  | { class: "task"; until?: number }  // while the conversation stays on it: recipe steps, a list being edited
  | { class: "pinned" }                // until done or dismissed: timers, progress, media
type PresentationAction =
  | { id: string; label: string; do: "say"; text: string }                 // becomes a typed turn, as if spoken
  | { id: string; label: string; do: "tool"; tool: string; input: unknown } // goes through core's confirmation rule
  | { id: string; label: string; do: "dismiss" | "pin" | "send-to-phone" }

// A tool returns this to present something; anything else is a plain result, as today.
type ToolOutput<A> = { readonly forModel: A; readonly present?: PresentationInput }   // PresentationInput: no id, no origin
```

New protocol messages (all additive optional types, so no protocol bump, because unknown types are ignored,
`UI-AND-MODULES.md` §2.3):

- Server to device: `present.show { presentation, reveal? }`, `present.update { id, body }` (a timer's state, a
  ticked item, the current step) and `present.dismiss { id, reason }`.
- Device to server: `present.action { id, actionId?, itemId? }`, `present.dismissed { id, by: "touch" | "voice" |
  "expired" }` and `present.status { id, shown: boolean, reason? }`. A failed image load counts as not shown.
- `reveal` is `{ turnId, clause }`: the device reveals the presentation when that clause starts playing (§3.6).

One deliberate split from the §1.9 sketch: the payload does not ride on `tool.end`. Presentations also come from
places that are not a tool call ending: a timer firing, "send it to the kitchen", the model's `show` tool. They have
their own life after the turn (updates, dismissal), so they get an id and messages of their own. The §1.9 principles
stay: a closed set of data kinds, one generic renderer per kind, no module code in the browser.

### 3.4 Where the payload travels on the server

1. `Tool.execute` returns `ToolOutput`. A registry wrapper (`ToolRegistry.ts:67`) splits it. `forModel` is encoded
   for the model as today, with a note appended: `[shown on Kitchen iPad: image of a kiwi]` or `[not shown: no
   display; described instead]`. The `present` part goes to a new per-session **Presenter** next to the Publisher.
   The same split works for the Claude Code bridge (`sdk.ts:88`), because the tool runs in our process: the bridge
   handler receives the split result and only `content` goes back over MCP.
2. Tool execution needs to know which device the turn is for, so the Presenter and the `show` tool can decide. Core
   already provides `CurrentTurnTrace` around play and synthesis (`docs/ARCHITECTURE.md:187`). A
   `CurrentTurnDevice` service provided around tool execution would follow the same pattern. Tools stay unaware of
   devices; only the Presenter reads it.
3. A speculative turn's presentation is held with its other messages and dropped if the turn is discarded. The
   publisher already does this for speculative turns (`UI-AND-MODULES.md:1069`). Read-only lookups such as weather
   and images are speculative-safe, so a promoted turn's image can be loaded before the first clause plays.
4. The Presenter decides delivery from the target device's effective capabilities (§5): show, use the fallback,
   describe only, or offer another target. It records the decision for the model note above. The model is told what
   happened, not asked to decide whether a screen exists.

### 3.5 The `show` tool, for things the model composes

`show({ kind: "list" | "card" | "facts" | "table" | "text", ... , target?: string })` is a built-in tool with a small
schema, so the model can put on screen something it wrote: "the three options", "a comparison". It costs output tokens
(a list of five short items is about 60 tokens, roughly 0.3 to 0.5 s at typical hosted output speeds, to be measured
with `TurnTrace` before relying on it). So the system prompt should say: use it only when the user asks to see
something or the content is clearly visual. On a device without a display the tool stays in the list. It answers
"not shown: this device has no display; Kitchen iPad can show it". Section 5.4 explains why tools are not filtered
per device.

### 3.6 Speech and visuals together

Rules (Proposal):

1. **Reveal at the right clause, never on arrival.** Text before a tool call is already spoken while the tool runs
   ("let me find one…", `ARCHITECTURE.md:206`). A presentation from round *n* is revealed when the first clause of
   round *n+1* starts playing (`assistant.playing`). The server knows that clause's index when it queues it after the
   tool round, and sends it as `reveal`. The image appears as the assistant says "here's a kiwi", which follows
   `CHARACTERS.md:302` ("time it against played audio"). Text turns, and devices that are not speaking, reveal at
   once. The image preloads from `tool.end` onwards, so the reveal never waits for the network. If it is not loaded by
   the reveal clause, it appears when it is ready.
2. **When it is shown, say less.** The model's note says it was shown, so the reply can be "Here's a kiwi, a
   flightless bird from New Zealand." It does not describe the picture. One instruction line in the system prompt
   covers this.
3. **When it cannot be shown, do not apologise for what speaks well.** Weather, facts, timers, steps and short lists
   are simply spoken. "I can't show that here" is said only when the request was explicitly visual ("show me", "a
   picture of", "a map") or the kind is inherently visual (image, gallery, map, chart). Then the reply has three
   parts:
   - the refusal, in one short clause;
   - a one-sentence description (the `spoken` field);
   - one concrete offer, naming the best other device (§6.2): "I can't show pictures on this speaker. A kiwi is a
     small brown flightless bird with a long beak. Want me to put it on the kitchen screen?"

   "Yes" in the follow-up window is an ordinary turn, and the model calls `show_on` (§6.3).
4. **Highlight what is being spoken.** For `list`, `steps` and `gallery`, the server can tag clauses with the item
   they talk about. The model writes items in order, so a numbered clause maps to an item. The device then highlights
   that item as its clause plays, and the character looks at it (§4.3). This is optional (v2) and the plain version
   works without it.
5. **Barge-in and Stop do not remove what is on screen.** Stopping the voice is not dismissing the content. "Stop" or
   "close that" said while nothing is speaking dismisses the top presentation.

### 3.7 Lifetime and dismissal

- `moment` and `glance` go away on their own: at most one transient presentation is shown at a time, a new one
  replaces it, and the next turn replaces it unless it is `task`.
- `task` stays while the conversation is about it. It ends at the next new conversation (`ConversationStarted`), on an
  explicit dismissal, or when the model calls `show` with something else.
- `pinned` stays until done or dismissed, survives new conversations, and is restored on reconnect.
  `welcome.snapshot` gains `presentations` for the device, as history is restored today.
- Dismissal means swiping it off, tapping outside it, saying "close that" or "never mind", or the lifetime running
  out. Every dismissal is reported (`present.dismissed`), so the next turn's context can say "the kiwi picture was
  closed", or nothing at all, which is the default.
- Idle: after 2 minutes with no turn, transient presentations leave and only pinned ones stay, which is the ambient
  state (§4.4).

## 4. The character and the content share the stage

This is where the project can do better than a pane or a pop-up. The existing contract already makes it cheap:
`focus` is re-read every frame and may move without a resize (`CHARACTERS.md:106`). Every stage character must
already follow it (`:113`), and every box character lives in a box the host can move. **So the host can move and
shrink the character's box with plain CSS layout, and every character ever shipped follows, unchanged.** Characters
that want more read an optional extension.

### 4.1 Layouts (host-level, every character)

The presentation layer is DOM. It sits above the character canvas, which is fixed with no pointer events, and below
the top bar, the dock and the captions. Content is real DOM because of text, accessibility, images and touch. When a
presentation is shown, the stage takes one of a few layouts, picked by kind and display class:

| Layout | Character | Content | Used for |
|---|---|---|---|
| **Presenter** | Moves to the side (left third on landscape, top on portrait) at about 60 % size | The main area beside it | `image`, `card`, `weather`, `list`, `table`, `chart` |
| **Hold-up** | Stays centred, shrinks a little and moves down; the content sits *above it*, as if held up | A medium card over the character | Single `image`, the first moment of `card` (the "item get"), then it settles into Presenter |
| **Companion** | Perches on the content's top-left corner, at about 35 % | Nearly full screen | `steps` (recipe), `gallery` browsing, `map` |
| **Orbit** | Centred, unchanged | Small badges circling or docked beside the box | Pinned `timer`, `progress`, `media` |
| **Ambient** | Small, dozing, in a corner | Pinned widgets large and glanceable (StandBy-style) | Idle with something pinned |

Choreography:

- **Entry.** The card grows out of the character's `focus` rectangle (transform origin at the focus centre) while the
  box glides to its new place, over 320 ms with the existing `--ease-out`. Content never appears from nowhere: it
  comes *from* the assistant. For an abstract character (sine lines, a flame), the light seems to become the card.
  Under reduced motion it is a crossfade with no movement (`CHARACTERS.md` §2.4).
- **Exit.** The card shrinks back into the character, which gives a small "taken back" moment, and the box returns.
  Swiping a card away sends it off the edge instead, so "I dismissed it" and "it went back" look different.
- **Replace.** A second image is swapped in place: the old one tilts back into the character and the new one comes
  out. A gallery fans out from the character like held cards.
- **Captions.** Captions keep their place under the box and move with it, so the spoken words stay attached to the
  speaker, not to the content.

The host measures the cost, as it already does for characters (`__pvaStage.debug()`). DOM transitions run on the
compositor, and the character's per-frame budget (`CHARACTERS.md` §2.4) is unaffected.

### 4.2 Extension `stage.content` (Proposal, for characters that want more)

An optional extension under the rules of `CHARACTERS.md` §4.2 and §5.2. It is produced only when the selected
character lists it in `uses`, and every character must work without it.

```ts
// PROPOSAL — frame.ext["stage.content"]
{ v: 1
  items: ReadonlyArray<{
    rect: Focus                        // the content's rectangle on this canvas, CSS px, per frame like `focus`
    kind: string                       // "image", "timer", … (ignore what you do not know)
    phase: "entering" | "shown" | "leaving" | "dismissed"
    age: number                        // seconds in this phase
    pinned: boolean
    attention?: { x: number; y: number }   // the point being talked about (a highlighted item), canvas px
    alert?: boolean                    // a timer just finished
  }>
  touch?: { x: number; y: number; age: number }   // the last touch on content, for a glance
}
```

What characters could do with it, per family (`CHARACTERS.md` §2.6 table):

- **Figures** (robot eyes, blob buddy, line face):
  - glance at the content as it enters, then back at the person;
  - follow `attention` as list items are spoken;
  - lean towards the card while presenting;
  - do a small "ta-da" lift at the reveal;
  - look at the timer when it rings, then at the person;
  - wince slightly at a swipe-away.
- **Light characters** (flame, light ring, cloud orb): lean or stretch towards the content, and let glow spill onto the
  card's edge nearest the character, which visibly connects the two. Brighten at the reveal and pulse with a finishing
  timer.
- **Line-like** (sine lines): the lines' ends can reach towards the card's edge, so the line seems to be holding it.
- **Edge glow**: light the screen edge nearest the content.

Reactions stay inside §2.3's rules: attention, effort and presenting, no invented emotion. Whether the reveal
deserves delight is the model's call through `reply.expression`, not the character's.

### 4.3 Touch

- **Tap an item** in a `list` or `gallery` with `pick`: `present.action { itemId }`. The server turns it into a typed
  turn ("the second one: the kiwi fruit"), so the model sees the choice in ordinary words, through the same path as
  `text.send` with `speak`. This is how "kiwi, the bird or the fruit?" gets answered by touch.
- **Tap the character.** Today it does nothing (the canvas has no pointer events). Proposal: a tap on the focus area
  while something is shown dismisses the top transient presentation. The content goes back into the character, which
  is a satisfying, discoverable gesture. A tap while speaking is Stop.
- **Drag content onto the character** to ask about it: a typed turn "tell me more about this <kind>: <title>". It is
  playful and costs nothing to build once drop targets exist. It is a later experiment, not v1.
- **Long press** gives "Send to my phone" and "Pin".
- Buttons (`actions`) are at least 56 px on touch displays, matching the dock (`UI-AND-MODULES.md` §3.10).

### 4.4 Pinned widgets and the ambient stage

- A running timer is a small ring docked beside the box, in Orbit layout, with the remaining minutes in mono type. It
  stays through other turns: when an image arrives, the timer moves to the top edge and the image takes the main
  area.
- When it finishes, the timer comes back to the centre and the character holds it up (Hold-up). It rings with a cue
  generated on the device, like the wake cue, and the label reads "Pasta, done". Touch or "OK" dismisses it.
- On idle with pinned items, the stage goes Ambient: widgets grow to a glanceable size and the character dozes small in
  a corner. A voice node with a small display could later show only this, like Live Activities in StandBy.
- Timers need the deferred background-trigger capability for modules (`UI-AND-MODULES.md:453`). That capability is a
  prerequisite; this design only gives the timer a face.

## 5. Device capabilities

### 5.1 Prior art for capability negotiation

| System | What it does | Take |
|---|---|---|
| Alexa | Each request carries `context.System.device.supportedInterfaces` (e.g. `Alexa.Presentation.APL` with `runtime.maxVersion`) and a `Viewport` (shape, size, dpi, `touch`, `keyboard`, video codecs): "Always check `supportedInterfaces` before returning the `Alexa.Presentation.APL` directives" ([reference](https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html), [viewport](https://alexa-skills-kit-python-sdk.readthedocs.io/en/latest/models/ask_sdk_model.interfaces.viewport.html)). | Interfaces with renderer versions, plus a viewport. |
| Google Actions | Surface capabilities `SCREEN_OUTPUT`, `AUDIO_OUTPUT`, `MEDIA_RESPONSE_AUDIO`, `WEB_BROWSER`, `INTERACTIVE_CANVAS`; `conv.available.surfaces` listed the user's *other* surfaces and `NewSurface` moved the conversation to a phone with a notification ([surface capabilities](https://developers.google.com/assistant/df-asdk/surface-capabilities)). | The closest prior art for "send it to the kitchen screen". |
| Google Cast | Receivers report booleans such as `DISPLAY_SUPPORTED` (false on Google Home) and `TOUCH_INPUT_SUPPORTED` ([DeviceCapabilities](https://developers.google.com/cast/docs/reference/web_receiver/cast.framework.system)). | Plain booleans are enough for most decisions. |
| Matter | Endpoints with device types and clusters (Descriptor cluster), and per cluster a `FeatureMap` of optional features ([data model](https://handbook.buildwithmatter.com/how-it-works/data-model/)). | Two levels: what it is, and which optional parts it has. |
| LSP, MCP | LSP 3.17: "A missing property should be interpreted as an absence of the capability" ([LSP](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)). MCP negotiated at `initialize` ([2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)); its 2026-07-28 revision sends client capabilities in every request's `_meta` ([versioning](https://modelcontextprotocol.io/specification/versioning)). | Absence means no; capabilities may change mid-session. |
| ESPHome, Home Assistant | Satellites send feature flags `SPEAKER`, `API_AUDIO`, `TIMERS`, `ANNOUNCE`, `START_CONVERSATION` ([aioesphomeapi](https://github.com/esphome/aioesphomeapi/blob/main/aioesphomeapi/model.py)); HA's timer intent raises `TimersNotSupportedError` when the device registered no timer handler ([timers.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/intent/timers.py)). | Exactly "I can't show images on this device", decided by the server from a declared feature, not by the model's guess. |
| Browsers | Client hints (`Sec-CH-Viewport-Width`, `Sec-CH-DPR`, `Sec-CH-Prefers-Reduced-Motion`) via `Accept-CH` ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Client_hints)); `navigator.permissions.query` gives `granted`, `prompt` or `denied` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Permissions/query)). | Our page can measure itself (`matchMedia`, the viewport, `setSinkId`, Wake Lock); hints are unnecessary. |

Takeaways: capabilities are declared by the device, with absence meaning no; renderers declare versions; static
capabilities are kept apart from live state; the server enforces instead of trusting the agent; and other surfaces
are listed so the assistant can hand off.

### 5.2 Vocabulary (Proposal)

Three layers, because they come from three places and change at different speeds:

```ts
// PROPOSAL — packages/protocol/src/capabilities.ts
/** What the hardware and front end can do. Declared by the device at hello; absent = cannot (LSP's rule). */
type DeviceCapabilities = {
  readonly v: 1
  readonly display?: {
    readonly class: "glance" | "compact" | "standard" | "large"   // ≤ 480 px, phone, tablet/hub, TV/desktop
    readonly widthPx: number; readonly heightPx: number; readonly dpr: number
    readonly shape: "rect" | "round"
    readonly touch: "none" | "coarse" | "fine"
    readonly colour: boolean                    // false: e-ink or LED matrix
  }
  readonly present?: { readonly kinds: Readonly<Record<string, number>> }   // kind → highest version rendered
  readonly speaker?: { readonly media: ReadonlyArray<"speech" | "audio" | "video"> }  // speech = TTS replies
  readonly microphone?: { readonly farField: boolean }
  readonly camera?: boolean                     // has one (never used without its own consent design)
  readonly openUrl?: boolean                    // can open a link in a browser (a phone tab)
  readonly notify?: { readonly via: ReadonlyArray<"web-push" | "ha-mobile-app" | "ntfy"> }   // reachable while closed
  readonly characters?: { readonly renderers: ReadonlyArray<"2d" | "webgl2" | "matrix"> }   // CHARACTERS.md §5.4
}

/** Where and for whom it is. Never detected: set in admin. */
type DevicePlace = {
  readonly room?: string                        // "Kitchen"; matched to Home Assistant areas when present
  readonly privacy: "private" | "shared" | "public"   // a bedroom phone, the kitchen, the hallway by the front door
  readonly owner?: string                       // a person's name, for "my phone" (one owner today)
  readonly alwaysOn: boolean                    // a wall tablet in kiosk mode vs a tab opened now and then
  readonly acceptsFromOthers: boolean           // other devices may send presentations here
}

/** What is true right now. Sent on change, at most once a second. */
type DeviceLiveState = {
  readonly connected: boolean                   // server-side: a voice connection is open
  readonly visible: boolean                     // Page Visibility; false = the tab is in the background
  readonly screenOn?: boolean                   // nodes with a display that sleeps
  readonly lastInteractionAt?: number           // touch or voice: a cheap presence signal
}
```

How each device type fills it in:

- **Browsers** detect it in the page: `matchMedia('(pointer: coarse|fine)')`, `window.innerWidth/Height`,
  `devicePixelRatio`, WebGL2 availability, `'setSinkId' in AudioContext.prototype`, a mobile user agent for `openUrl`,
  and the Notification and Push permission state. `present.kinds` is compiled into the bundle, one entry per renderer
  in the registry, like `displayRenderers` (`UI-AND-MODULES.md:1005`).
- **Voice nodes** declare `{ v: 1, speaker: { media: ["speech"] }, microphone: { farField: … } }` from their
  configuration and `node.status`, with no display. A future node with a screen adds `display` and a smaller
  `present.kinds`.

### 5.3 Declaring at connect and overriding in admin

| Option | For | Against |
|---|---|---|
| C1. Device declares in `hello.device.capabilities`, updates with `device.caps` | Accurate. Follows rotation, resize and a hidden tab. Optional field, so no protocol bump. | A browser cannot know its room or whether a person treats it as a wall display. |
| C2. Admin sets everything per device type and device | Simple and predictable. | Wrong as soon as a tab is resized, or a phone is used for once. |
| **C3. Both: declared hardware, admin-set place, and admin overrides that can only remove** | Detection is right about hardware, the owner is right about rooms and privacy. "Can only remove" means a kiosk can be told "don't show personal things" or "treat as no display" (a phone used as a speaker), but cannot claim a display it lacks. | One more settings section: a new `DeviceSettingsKey`, so a protocol bump (`LOOKS-AND-VOICES.md:30`). |

**Recommendation: C3.**

- Two new device settings sections, `place` (`DevicePlace`) and `capabilities` (overrides such as `{ display: "off" }`
  and `{ present: { exclude: ["media"] } }`). Both resolve as own value, then type defaults, then built-in, like every
  section.
- The built-in defaults per device type:
  - `web-voice`: `privacy: "shared"`, `alwaysOn: false`, `acceptsFromOthers: true`.
  - `voice-node`: the same with `alwaysOn: true`.
- The admin page Devices › a device gets a "What it can do" section. It shows the last declared values with a
  "Detected" mark and the time they were last seen, one switch per removable capability, and the place fields.
- The server keeps the last declaration per device in the device record. This lets the Presenter reason about a
  device that is offline ("the kitchen tablet has a screen but is off right now").

### 5.4 How the capabilities reach the agent

| Option | For | Against |
|---|---|---|
| G1. Facts in the system prompt | The model knows from the first token. | The system prompt is the cached prefix (`ARCHITECTURE.md:119,273`), and devices with different capabilities would each need their own cached prefix. Live state (tab hidden, kitchen screen off) would invalidate the cache whenever it changed. |
| **G2. A line in the per-turn `context`** | Placed after the cached prefix, so the cache is untouched. Always current. Agents (Claude Code) already get `context` (`agent.ts:422`). About 40 tokens. | The model can still ignore it, so it is not enough on its own. |
| G3. Filter tools per device (no `show` on a headless device) | The model cannot misuse what it does not have. | The tool list is part of the cached prefix, so filtering splits the cache per device. Worse, the model can no longer *offer* the kitchen screen. HA keeps the timer intent and refuses at run time for the same reason. |
| **G4. Tools always present; the server decides and the result says what happened** | Robust whatever the model believes. It is the HA timer pattern, and it gives the model the words for an honest reply. | Without G2 the model learns the device's limits one refused call later. |

**Recommendation: G2 + G4, and G3 only for tools no device in the house could use** (no `show` at all when there is
not a single display-capable device). Example context line:

```
Device: Kitchen speaker (voice only, no screen; room Kitchen; shared). Screens: Kitchen iPad (on), Living room TV (off). Ian's phone (notifications).
```

The system prompt gains three stable instructions:

1. Use `show` only for content that should be seen.
2. When something is shown, keep the spoken reply short and do not describe it.
3. When the device cannot show and the user asked to see, say so in a few words, describe it in one sentence, and offer
   the best screen.

## 6. Degradation and cross-device targeting

### 6.1 Degradation rules (Proposal), decided by the Presenter per presentation

1. The target device renders `body.kind` at `body.v`: show it.
2. Otherwise, if it renders the `fallback`: show that.
3. No display, or display removed in admin, or the tab is hidden:
   - the kind speaks well (weather, facts, timer, steps, short list): nothing is shown and the model note says
     "spoken only". No apology (§3.6.3).
   - the kind is visual and the request was visual: "not shown" plus the best alternative from §6.2. The model offers
     it.
   - a long list or table: "not shown, 12 items". The model reads the top 3 and offers to send the rest to the phone.
4. `personal` content on a `shared` or `public` device: not shown. The note says "not shown: personal, shared room",
   and the model offers the owner's phone. Whether it should also not be *spoken* there is open question 5.
5. Target offline: queue it. A `pinned` presentation, or one the user explicitly sent, waits up to 10 minutes and is
   shown when the device next connects. Anything else is dropped. The note says "Kitchen iPad is off; it will show
   when it's back".

### 6.2 Choosing "the best other screen"

Rank display-capable devices that accept presentations from others:

1. same room and connected and visible;
2. same room and `alwaysOn`;
3. the owner's phone, if reachable (`openUrl` or `notify`);
4. any other connected display in a shared room.

Ties go to the most recent interaction. The ranking is the server's, so the model only names the first one. Presence
sensing (HA occupancy, last touch) can refine step 1 later, without changing the contract.

### 6.3 "Send it to the kitchen screen"

- **Tool.** `show_on({ target: string, what?: "last" | string })`. `target` is a free phrase: "kitchen screen",
  "living room", "my phone", "all screens". The server resolves it, not the model, against device names, rooms, the
  owner, and "all".
  - A unique match shows the presentation there.
  - An ambiguous match answers with the candidates, and the model asks.
  - No match answers with the list of screens.
- **`what`.** `"last"` means the session's most recent presentation, including one that was "not shown" here. The
  Presenter keeps the last few per session for exactly this. A headless speaker that described a kiwi can therefore
  send the same picture to the kitchen without searching again.
- **Delivery.** `present.show` is sent to the target device's connections even if that device has no voice session.
  Sessions are created only at the first claim or typed message (`ARCHITECTURE.md:297`), so this needs a delivery
  path by device, not by session, in SessionHub.
  - The presentation's `origin` names the sending device ("from Kitchen speaker"), shown in small print.
  - The target device's character makes a small "something arrived" glance, without speaking. Speech stays with the
    device that was spoken to.
- **Phone.**
  - With the page open on the phone: deliver it like any device.
  - Closed: a notification through what the device declared (`notify.via`). Web Push needs HTTPS and a service worker
    (none today, `UI-AND-MODULES.md:1160`). The HA companion app's notify service works through
    `module-home-assistant`. ntfy is a self-hostable option.
  - The notification links to `/p/<id>`, a short-lived read-only page with the presentation. That page needs a
    capability token in the URL, because the voice front end has no login.
  - The cheapest first step is a `handoff` QR code on whichever screen is near.
- **Several devices showing the same thing** ("all screens", or a timer started in the kitchen and also wanted in the
  living room).
  - Each device gets its own copy of the same id. Interaction state (gallery index, current step) is per device by
    default. Simpler, and nobody's swipe moves someone else's screen.
  - Server-owned state (a timer's end, a checklist's ticks, the current recipe step) is updated on every copy with
    `present.update`, because it lives on the server.
  - Dismissing one copy dismisses only that one. Pinned items done on one ("cancel the timer") end everywhere, because
    the underlying thing ended.

## 7. Recommendations, in one place

1. **Declaration:** a closed catalogue of about 15 semantic, versioned kinds with a per-payload `fallback`, validated
   by protocol schemas and rendered by our own components. No HTML from modules. An `app` kind for MCP Apps in a
   sandboxed iframe can come later, opt-in per device.
2. **Origin:** tools return `{ forModel, present }`. The registry splits them and the model gets a one-line note on
   what was shown. A small `show` tool covers model-composed content. Images are fetched once and served from
   `/media/` by the server.
3. **Stage:** the character presents the content. The host moves and shrinks the existing focus box (Presenter,
   Hold-up, Companion, Orbit, Ambient), so every existing character works unchanged. The card grows out of the
   character and returns into it. An optional `stage.content` extension lets characters glance, lean, spill light and
   follow the item being spoken.
4. **Timing:** reveal at the first clause after the tool round (`reveal { turnId, clause }`). Preload before that.
   Barge-in does not dismiss.
5. **Lifetime:** four classes (moment, glance, task, pinned), at most one transient at a time, pinned restored on
   reconnect.
6. **Capabilities:** three layers. Hardware is declared in `hello` and updated live. Place (room, privacy, always-on,
   accepts from others) is set in admin. Overrides can only remove. Two new device settings sections, which means a
   protocol bump.
7. **Agent:** a capability line in the per-turn `context`, tools always present, the Presenter enforcing and reporting.
   Tools are filtered only when no device at all could use them.
8. **Degradation:** speak what speaks well without apology. Say "can't show" only for explicitly visual requests, and
   always with a description and one concrete offer of the best other screen.
9. **Cross-device:** `show_on(target)` resolved by the server. Delivery by device, not session. A short queue for
   offline targets. Per-device interaction state and shared server state.
10. **Build order (suggestion):**
    1. capabilities in `hello` and the context line (small; HA-style refusals become possible at once);
    2. `image`, `card`, `list` and `text` with the Presenter layout and the reveal rule;
    3. `show_on` and the `/media/` proxy;
    4. `stage.content` and one figure that uses it;
    5. timers, after background triggers exist.

## 8. Open questions for the owner

1. **Image source for "a picture of a kiwi".** Openverse or Wikimedia Commons (keyless, licensed, public), image
   *generation* (hosted, slow, costs money), or your own photos (Immich or HA media)? Default: Openverse, with
   Wikimedia as the fallback.
2. **How playful should the stage be by default?** The "item get" Hold-up for every image, or only the first in a
   conversation, with plain Presenter after that? Default: Hold-up for the first image of a turn, a calmer entry for
   the rest (calm by default, `CHARACTERS.md` §2.1).
3. **Should a tap on the character dismiss content**, or should the character never be a control? Default: it
   dismisses, and Stop while speaking.
4. **Should other devices accept presentations by default** ("send it to the kitchen" from any speaker)? Default:
   yes for everything in the house; per-device off switch.
5. **Privacy per room.** Should `personal` content (calendar details, messages) be refused only on screens in shared
   rooms, or also not *spoken* on shared speakers? Who marks content personal: the module, or the owner per module?
   Default: the module marks it; shared screens do not show it; speech unchanged.
6. **Phone handoff.** Is the HA companion app on your phone (then notifications work today through
   `module-home-assistant`), or should we add Web Push, which needs HTTPS and a service worker, or ntfy?
7. **"All screens" and per-device state.** Is a recipe on two screens expected to move in step (synced current step),
   or independently? Default: server-owned state synced, browsing state per device.
8. **MCP Apps.** Do you want third-party MCP servers' own UIs at all (the `app` kind in a sandboxed iframe), or is our
   catalogue enough? Default: not now.
9. **Voice nodes with small displays.** Is a node with a round or LED display planned? It decides whether the `glance`
   display class and a `matrix` renderer are worth designing now.
10. **Timers.** Timers are the most valuable pinned widget, but they depend on the deferred background-trigger
    capability for modules. Should that come before or after the first presentation kinds?
