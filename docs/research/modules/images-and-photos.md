# Images and photos

Research write-up, 2026-11-17. Not an approved design. Outside facts carry inline links checked on this date. Results
marked "checked live" were queried on this date. Claims marked **[unverified]** come from memory or a secondary
source. Latency figures are estimates to be measured with `TurnTrace`.

## 1. Summary

The owner's test case is "if I ask for an image of a kiwi, how are we going to present this image". This module
answers it end to end. It finds a picture of a thing (public, licensed sources) or makes one (image generation). It
shows the household's own photos (Immich) and a camera or doorbell snapshot (Home Assistant). It presents them on the
stage with the character, and says something sensible on a device without a screen. An ambient photo-frame mode
fills idle screens.

- **Priority: first wave**, as the pilot for the Presentation foundation. The kiwi is the smallest real use of
  `image`, `gallery`, the `/media/` proxy, the reveal rule and the no-screen degradation.
- **Effort: M** for search, Immich and camera snapshots on top of Presentation. Generation adds S per provider. The
  photo frame adds S.
- The Presentation foundation itself ([presentation-and-device-capabilities.md](../module-investigation/presentation-and-device-capabilities.md))
  is the larger piece and is not counted here.

## 2. What others do

| System | Behaviour | Copy | Avoid |
|---|---|---|---|
| Google Nest Hub | "Show me pictures of …" gives an image carousel. Google Photos is the ambient frame, with "live albums" by person ([landscape](../module-investigation/landscape-voice-assistants.md) §2c) | Ambient photo frame as the idle screen | — |
| Echo Show | Amazon Photos frame; camera feeds on request ("show the front door"); Visual ID ([landscape](../module-investigation/landscape-voice-assistants.md) §1c) | "Show the front door" as a one-phrase camera view | — |
| Alexa cards | A plain card fallback for every visual answer ([presentation](../module-investigation/presentation-and-device-capabilities.md) §2) | Always a fallback | — |
| ChatGPT, Gemini | Inline generated images with long waits (10–30 s) **[unverified: current times]** | — | Silent waiting: say something and show progress |
| Home Assistant View Assist | Visual responses on wall tablets, including camera views ([presentation](../module-investigation/presentation-and-device-capabilities.md) §2) | Cameras on wall tablets | — |
| Zelda "item get", Anki Vector | The character holds up the object ([presentation](../module-investigation/presentation-and-device-capabilities.md) §2) | **Hold-up**: the picture comes *from* the assistant | — |

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | Kitchen tablet: "Hey Jev, show me a kiwi." → a `gallery` with `pick` fans out of the character: bird, fruit. "The bird or the fruit?" → tap the bird → Hold-up: "Here's a kiwi, a flightless bird from New Zealand." | **yes** |
| 2 | Kitchen speaker: "Show me a kiwi." → "I can't show pictures on this speaker. A kiwi is a small brown flightless bird with a long beak and hair-like feathers. Want me to put it on the kitchen tablet?" → "Yes." → it appears there, with a small glance from that tablet's character. | no, then yes |
| 3 | "Make me a picture of a kiwi wearing a tiny raincoat." → "Drawing it now; that takes a few seconds." A `progress` card shows; about 8 s later the image is revealed. | yes |
| 4 | "Show me photos of Mila at the beach." → an Immich `gallery` of 12; "Twelve from Scheveningen last July." | yes; a `personal` Presentation |
| 5 | "Who's at the door?" → Home Assistant snapshot: "Here's the front door now: a delivery driver with a parcel." (the model saw the image) | yes; without a screen, the description only |
| 6 | "What did we do a year ago today?" → Immich memories: "You were in Ghent: eight photos." | yes |
| 7 | Failure: "Show me a kiwi." with Openverse throttled → Wikipedia's lead image is used instead, unnoticed. If every source fails: "I couldn't get a picture right now. Shall I describe one?" | yes |
| 8 | Refusal: a child's device, "show me a scary zombie picture" → safe search strict and no generation on that device: "Let's pick something else. How about a picture of a dinosaur?" | yes |
| 9 | Ambiguous: "Show me that again." → the session's last Presentation (Presentation §6.3 `what: "last"`), even one made on another device | yes |
| 10 | Ambient: the hallway tablet idles → "Photos: Family favourites" frame, a photo every 30 s, the character small and dozing | yes |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `image_find` | `query`, `count? 1–12`, `kind?: photo \| illustration`, `licence?: any \| commercial \| modify`, `source?` | images with credit and licence, or a disambiguation; an `image` or `gallery` Presentation | R | safe | 300–900 ms plus image fetch | no |
| `image_generate` | `prompt`, `style?: photo \| illustration \| cartoon \| sketch`, `aspect?: square \| landscape \| portrait`, `provider?` | one image, the prompt actually used; `image` Presentation | W (creates a file) | **costly** (money per image) | 4–30 s (provider) | no |
| `photos_find` | `query?` (CLIP text), `person?`, `place?`, `from?`, `to?`, `album?`, `count? ≤ 24` | Immich assets; `gallery` Presentation, `personal` | R | safe | 300 ms–1.5 s (smart search) | no |
| `photos_memories` | `date?` (default today) | memories "on this day"; `gallery` | R | safe | 200–600 ms | yes ("what happened a year ago") |
| `photo_frame` | `action: start \| stop`, `album? \| person?`, `where?`, `intervalS?` | the frame's state | W | changes | < 100 ms | **yes** ("start the photo frame") |
| `camera_snapshot` | `camera` (name or room), `describe?: boolean` | an image; the model receives it as an image when `describe` is set | R | safe, `security`-class device policy (§13) | 0.5–2 s | yes ("show the front door") |
| `show_on` | from Presentation §6.3 | — | — | — | — | — |

`show_on` belongs to the Presentation foundation, not to this module, but the kiwi flow depends on it.

## 5. Integrate or build

### 5.1 Finding a picture of a thing

| Source | Facts | Verdict |
|---|---|---|
| **Wikipedia page image** | `GET https://en.wikipedia.org/api/rest_v1/page/summary/Kiwi_(bird)` returns `thumbnail` and `originalimage` (994×1325, a Commons file), checked live. A title that is a disambiguation page tells us "kiwi" is ambiguous. Keyless. Wikimedia asks for a descriptive `User-Agent` **[from memory: User-Agent policy]**. | **First choice for a named thing.** It is the canonical picture, comes with a one-line description for the spoken reply, and gives a free ambiguity signal. |
| **Wikimedia Commons** | `action=query&generator=search&gsrnamespace=6&prop=imageinfo&iiprop=url\|extmetadata&iiurlwidth=800` returns a thumbnail URL and `LicenseShortName`, `Artist` and `AttributionRequired`. A kiwi query gave "Public domain" (checked live). Thumbnails come in standard widths: 800 requested, 960 returned. There is no safe-search filter. | Second choice; **off on kids' devices** |
| **Openverse** | `GET https://api.openverse.org/v1/images/?q=kiwi%20bird&license_type=commercial` returned 240 results, each with `license`, `license_version`, `creator`, `source`, `attribution` text and a `mature` flag (checked live). Anonymous limits from the response headers: **20 a minute, 200 a day** (`x-ratelimit-limit-anon_burst`, `anon_sustained`). Registered clients get more **[unverified: amounts]**. | **Generic queries** ("a cosy cabin in snow"), with registration for the household |
| **Unsplash** | "All API uses must use the hotlinked image URLs returned by the API". Attribution to the photographer and Unsplash, with UTM links. Download tracking via `download_location`. "You cannot replicate the core user experience of Unsplash" ([guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines)). | **Skip.** Hotlinking contradicts the `/media/` proxy and `img-src 'self'` |
| **Pexels** | 200 requests an hour, 20,000 a month. A "prominent link to Pexels" and photographer credit; `GET /v1/search?query=&orientation=&size=&per_page ≤ 80` ([docs](https://www.pexels.com/api/documentation/)). No hotlink rule found. | Optional source for mood or stock photos (photo frame themes) |
| **Brave Image Search** | One key covers `/res/v1/images/search`. Search costs $5 per 1,000 requests, with $5 of free credit a month. Storing results needs "a custom plan" ([Brave](https://brave.com/search/api/)). Results are arbitrary web images with **unknown rights**. | Optional "web images" source, labelled "rights unknown, for viewing". The day-long `/media/` cache may exceed the standard plan's rights **[unverified]**. |
| **Bing Image Search API** | Retired by Microsoft in August 2025 **[from memory]** | Not available |

**Recommendation:** a provider chain per query type. A named entity goes to Wikipedia, then Commons, then Openverse.
A descriptive scene goes to Openverse, then Pexels. "Web images" go to Brave, only if the owner adds a key. The model
does not choose sources; `image_find` does, from the query shape. Ambiguity (a disambiguation page, or results
splitting into clusters) becomes a `gallery` with `pick` and a short spoken question.

### 5.2 Making a picture

The language model behind most assistants (Claude) does not generate images, so generation is a separate provider.

| Option | Facts | Verdict |
|---|---|---|
| **OpenRouter Images API** | `POST /api/v1/images` with a model and prompt; the result is base64 bytes with `media_type`, and `usage` gives cost. Listed models include `openai/gpt-image-1`, `openai/gpt-image-2`, `black-forest-labs/flux.2-pro`, `google/gemini-2.5-flash-image` and `bytedance-seed/seedream-4.5` ([OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)) | **First choice.** OpenRouter is already an LLM account type here, so there is no new connection. |
| OpenAI or Google direct | The same models with their own keys and moderation **[prices unverified; check before enabling]** | Only if the owner prefers |
| **Local**: FLUX.1 [schnell] (Apache 2.0) or SD-Turbo via `stable-diffusion.cpp` or ComfyUI | Seconds on a GPU with 12 GB or more. On CPU, about 10–60 s for 512 px with a turbo model **[unverified: measure]**. SD-Turbo and SDXL-Turbo are under Stability's non-commercial community licence **[from memory]**. | The principled option: the project's rule is "everything local except the language model", so hosted generation is an opt-in exception. Practical once the server has a GPU. |

Generation is **costly** (risk class). The assistant says what it is drawing before it starts. The prompt the
provider got is stored with the image, so "make it blue" is an edit of the stored prompt.

### 5.3 The household's photos

- **Immich: integrate.** From the OpenAPI spec on `main` (3.4.0-rc.0, read 2026-11-17):
  - `POST /api/search/smart` (permission `asset.read`): `query` (CLIP text), `personIds`, `city`, `country`,
    `takenAfter`, `takenBefore`, `albumIds`, `isFavorite`, `rating`, `type`, `size`, `language`.
  - `POST /api/search/random` (`asset.read`) for the photo frame.
  - `GET /api/memories` (`memory.read`) for "on this day".
  - `GET /api/search/person?name=` (`person.read`) to turn "Mila" into a person id.
  - `GET /api/assets/{id}/thumbnail?size=thumbnail|preview|fullsize` (`asset.view`).
  - Auth with an API key header (`x-api-key`) **[from memory: header name]**. A key restricted to these five
    permissions is the Connection.
- **Google Photos: no.** Since 2025-03-31 the Library API "can only list, search, and retrieve albums and media items
  that were created by your app". The full read scopes are removed. The Picker API lets a person pick items by hand
  each time ([updates](https://developers.google.com/photos/support/updates)). That rules out search and a living
  frame. Owners on Google Photos can export with Takeout into Immich.
- **A local folder or HA media source**: the simplest frame source. The server reads JPEG/HEIC from a folder; HEIC
  needs `sharp` with libheif **[unverified: prebuilt support]**.

### 5.4 Cameras

Home Assistant: `GET /api/camera_proxy/camera.front_door` with the HA token returns a JPEG **[from memory]**. That
runs through the existing `module-home-assistant` Connection. Doorbell *events* ("someone rang") need an inbound HA
WebSocket subscription. Today the module polls REST every 60 s, and an Event bus input is needed. For "who's at the
door", the snapshot goes to the model as an image input. Today `ToolResult.content` is a string only
([current-system.md](../module-investigation/current-system.md) §2.2), so image results to the model are a new core
capability (gap, §14).

## 6. Data

| What | Where (Module store or files) | Scope | Kept |
|---|---|---|---|
| Fetched images | `/media/<hash>` cache owned by Presentation, with `{ source, licence, credit, sourceUrl }` | household | 24 h (Presentation §3.2) |
| Generated images | `data/modules/images/generated/<id>.png` + row `{ prompt, provider, model, costUsd?, createdBy, createdAt }` | person (the requester) or household | 30 days, or until deleted; "save it" keeps it |
| Search cache | `{ query, chain, results[] }` | household | 24 h |
| Frame playlists | `{ name, source: immich-album \| person \| folder, ids[], intervalS, devices[] }` | household | until changed |
| Last presentations | owned by Presentation (`what: "last"`) | conversation | session |

Other modules may read `generated` through `exports`: a "send it to my phone" notification needs the file.

## 7. Long-running work and events

- Generation over about 5 s runs as a Scheduler `task` tied to the turn. The turn ends with "drawing it now", and the
  image arrives as a Presentation with a `result` notification when it is done. That way a 30 s provider never holds
  the voice turn. A restart loses the task: "the drawing was interrupted".
- The photo frame is a device-scoped job: `recurring` every `intervalS`, only while the device is idle and visible.
  It pre-fetches the next image.
- Events: `images.generated`, `photos.frame.changed`. Consumes `ha.doorbell.pressed` (once the HA module emits it) to
  offer a snapshot on screens in shared rooms.

## 8. Presentation

From the Presentation foundation ([§3–4](../module-investigation/presentation-and-device-capabilities.md)): kinds
`image`, `gallery` (with `pick`), `progress`, `handoff`; layouts Hold-up, Presenter, Companion and Ambient.

The kiwi, step by step:

1. `image_find` runs in round *n*; it is speculative, so it may start before the turn is promoted. The server fetches
   the image once into `/media/<hash>` and sends `tool.end`, and the device preloads.
2. The model's round *n+1* begins "Here's a kiwi". That clause carries `reveal`.
3. As it plays, the picture grows out of the character's focus rectangle into **Hold-up**: the character holds it up,
   "item get". It then settles into Presenter, with the character beside it.
4. The credit ("Photo: denisbin, CC BY-ND 2.0, Flickr via Openverse") sits in small print under the image. It is
   never spoken.
5. The model's note is `[shown on Kitchen tablet: image of a kiwi (bird)]`, so the reply does not describe the
   picture.

Further rules:

- **Gallery**: fans out like held cards; swipe, and tap to pick. With `stage.content`, a figure looks at the item
  being spoken.
- **Generated image**: a `progress` card in Orbit while drawing. On arrival it gets the same Hold-up, with the label
  "Made by gpt-image-1" (always shown: people must know it is not a photo).
- **Personal photos** (`sensitivity: personal`) are shown only on devices whose place is `private`, or on shared
  devices where the owner allowed the album (§13).
- **Camera snapshot**: `image` with a live-ish refresh (`present.update` every 2 s for 30 s while shown) **[option;
  costs HA load]**.
- **Photo frame**: the Ambient layout. Full-bleed photo with a slow cross-fade; the character small and dozing in a
  corner; pinned widgets (timers, now playing) on top. Any touch or wake phrase wakes the character, and the photo
  dims to 40 %.
- **Without a screen**: the Presentation §3.6 rule 3 three-part reply (refusal, one-sentence description from the
  `spoken` field, one offer). For your own photos the description is from metadata, not vision: "Twelve photos from
  Scheveningen, July last year." For a camera with `describe`, the model's description of the snapshot is the
  answer.

## 9. Notifications and proactive behaviour

- `result` (normal): "Your kiwi drawing is ready", on the origin device when it is idle.
- Doorbell (high, from the HA event, owned by the Home Assistant module): the snapshot goes to every display in a
  `shared` room as an `image` with lifetime `glance`.
- Frame "memories": at most once a day, on idle screens only, never spoken: "A year ago today" as a caption on the
  frame.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | safe-search level; image sources allowed (`wikipedia`, `commons`, `openverse`, `pexels`, `brave`); generation allowed; generation budget per month | strict on kids' devices, moderate elsewhere; first three; off; $5 |
| Module | Openverse client credentials; Pexels key; Brave key; Immich URL and API key; generation provider and model; photo-folder path | — |
| Assistant | may generate; style hint for generation (persona) | no |
| Device | photo frame on/off, album, interval; show personal photos (only on `private` devices by default); show camera snapshots | off; — ; 30 s |
| Person | own Immich user key (Immich is multi-user); faces they may see | — |

First-run setup:

1. Nothing for the kiwi: Wikipedia and Commons need no key.
2. For your own photos: paste an Immich API key limited to `asset.read`, `asset.view`, `memory.read` and
   `person.read`, then pick frame albums.
3. For generation: switch it on and set the monthly budget.

## 11. Native tools and dependencies

| Need | Where | Missing → spoken |
|---|---|---|
| `sharp` (npm, prebuilt libvips) for resizing, blur placeholder and type check | server | the Presentation `/media/` proxy cannot work; images are not shown: "I can't show pictures right now." |
| Immich server | LAN | "I can't reach the photo library." |
| Generation provider key (OpenRouter account) | vault | "Drawing pictures isn't set up." |
| Local generation runtime (later) | server with GPU | — |
| A display | the device | the three-part reply (§8) |

## 12. Interaction with the rest of the system

- **Voice.**
  - Speech recognition turns "kiwi" into "Kiwi", "Kiwi's" or "key we". The query goes through the model, which
    normalises it.
  - The fast path is only "start the photo frame" or "stop the photo frame", and "show the front door" (actions with
    examples).
  - Filler: "Let me find one" (`image_find`), "Drawing it now" (`image_generate`).
  - Interruption does not dismiss what is shown (Presentation §3.6 rule 5).
- **The character.**
  - Hold-up is the signature moment. The character presents the image, it does not react to its content. Whether a
    reveal deserves delight is the model's `reply.expression` cue ([CHARACTERS.md](../../CHARACTERS.md) §5.3).
  - In frame mode the character is `asleep` (falls back to `idle`), small.
- **Assistants.** Every general assistant gets `image_find`. Only assistants the owner chooses get `image_generate`
  (cost). A kids' assistant gets `image_find` with the kids' source chain, and no generation by default.
- **Other modules.**
  - Home Assistant (cameras, doorbell events).
  - Music (album art uses the same `/media/` path).
  - Recipes and knowledge modules call `image_find` for a dish or a landmark.
  - Notifications ("send it to my phone" via `handoff` or push).

## 13. Privacy and safety

- **Children.**
  - On a device marked for kids: Commons off (no safety filter), Openverse with `mature` results dropped, Pexels on,
    Brave with `safesearch=strict` **[unverified: parameter values for images]**, and generation off.
  - Generated images use the provider's moderation, plus our own refusal of prompts naming real people.
  - No source is perfectly safe, so a kids' device may show at most one result at a time, after a 0.5 s server-side
    check of the `mature` and source flags.
- **Family photos are personal.**
  - Shown on `private` devices, and on `shared` devices only for albums the owner marked "OK for shared screens".
  - Never on `public` devices (the hallway by the front door).
  - Faces of children never go to a hosted vision model unless the owner turns on "describe photos".
- **Cameras** are `security` class: snapshots only on devices the owner trusts (`allowRisky`), never on a public
  device, never kept beyond the `/media/` day.
- **Licences**: credit is always shown; the `/media/` cache is the only copy; CC BY-ND images are never edited or
  cropped beyond fitting.
- **Generated images** are labelled as generated and are never placed in the photo frame by default.

## 14. Foundations needed

- **Presentation** (all of it: kinds, `/media/` proxy, reveal, Hold-up, `show_on`) and **Device capabilities**
  (display, place and privacy). These are the real cost.
- **Tool context** (which device, for degradation and kids' policy), **Module store**, **Connection** (Immich,
  providers), **Scheduler** (generation tasks, frame), and **Notification service** (`result`).
- **A core gap** from this module: tool results that carry an image *to the model* (for `camera_snapshot` with
  `describe`).
- **A first version without most of them:** `image_find` over Wikipedia and Commons, with the `image` kind and the
  three-part spoken fallback. That is exactly build-order steps 1–3 of the Presentation document, and nothing else.

## 15. Open questions

1. **Default image source chain**: Wikipedia, then Commons, then Openverse for things, as recommended, or Openverse
   first as the Presentation document defaults? (Small disagreement: Wikipedia gives the canonical picture and the
   ambiguity signal for free.)
2. **Generation at all**, and with which budget and which assistants? Is OpenRouter acceptable, or must images be
   generated locally (needs a GPU)?
3. **Web images (Brave)**: allowed with "rights unknown, for viewing", or licensed sources only?
4. **Personal photos on shared screens**: per album allowlist, as proposed, or never?
5. **Photo frame**: Immich only, or also a plain folder? Which albums, and on which screens?
6. **Camera snapshots to a hosted model** ("who's at the door?"): acceptable for the front door, given that visitors
   are recorded and described by a third party?
7. **Image results to the model** (vision on tool output): worth adding to core now, or only after cameras matter?
