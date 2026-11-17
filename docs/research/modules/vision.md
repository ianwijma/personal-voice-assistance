# Vision (the camera as an input)

Research write-up, 2026-11-18. Not an approved design. Outside facts carry inline links checked on this date. Claims
marked **[unverified]** or **[from memory]** were not confirmed in a primary source. Latency figures are estimates
to be measured with `TurnTrace`.

## 1. Summary

The module lets the assistant look through a device's camera when someone asks it to. It covers "what is this",
reading a label or a letter aloud, scanning a barcode or QR code, naming a plant or a product, show-and-tell for
homework, checking a fixed view ("is the oven off?"), and an accessibility mode that describes the scene. The rule
that shapes everything is that **the camera opens only when asked, for one frame or a short burst, and a light is
visibly on while it is open.** Nothing is captured in the background.

- **Boundary.** [images-and-photos](images-and-photos.md) *shows* pictures (Openverse, Immich, the photo frame).
  [smart-home](smart-home.md) owns Home Assistant cameras and the doorbell (`camera_snapshot`). This module owns
  frames from the **device the person is standing at**, plus fixed cameras used to *answer a question about the
  house*. For those fixed cameras it reuses smart-home's snapshot and adds no third snapshot tool.
  [kitchen](kitchen.md) owns the pantry. This module only turns a barcode into a code and a product lookup, and
  hands both to kitchen.
- **Priority: second wave.** It waits on the Presentation foundation (for the viewfinder and the result), the
  Device capabilities foundation (`camera`), and one core change: carrying an image to the model. The barcode slice
  could come earlier as part of kitchen.
- **Effort: M.** Capture in the browser, the consent indicator and `look` with the hosted model are S each on top
  of the core change. Barcode and QR are S. A local vision model, node cameras and fixed-view checks bring it to L.

## 2. What others do

| System | Behaviour | Copy | Avoid |
|---|---|---|---|
| Alexa Show and Tell (2019) | On an Echo Show, "Alexa, what am I holding?" identifies pantry items, and spoken and audio cues guide the item into view ([Amazon](https://www.aboutamazon.com/news/devices/alexa-what-am-i-holding), [BOIA](https://www.boia.org/blog/amazon-alexas-show-and-tell-can-identify-groceries-for-people-who-are-blind-have-low-vision)) | Guidance cues ("move it left", "closer") for people who cannot see the screen | Packaged goods only; current availability unknown **[unverified]** |
| Echo Show Adaptive Content | On-device computer vision tells how far away a person is and changes the layout; "images are processed locally"; turned on by default, turned off by the shutter ([Engadget](https://www.engadget.com/amazons-echo-show-8-offers-spatial-audio-and-a-dynamic-proximity-based-ui-151425369.html), [Amazon help](https://digprjsurvey.amazon.com/csad/help/node/TBmEUlW1U7xwcgPvdl)) | Local processing, a physical shutter | On by default; the camera always running (see [dashboard](dashboard.md)) |
| Be My AI, Seeing AI, Gemini Live camera sharing | A photo or live video goes to a hosted model, which describes it and answers follow-up questions **[from memory: not checked this round]** | Follow-up questions on the same frame ("what's the expiry date?") | Continuous video to a third party as the default |
| Google Lens, iOS Visual Look Up | Plant, product and text recognition on the phone **[from memory]** | One frame, one answer | — |
| Home Assistant LLM Vision (community) | Sends camera snapshots to a vision model from automations **[from memory]** | Fixed-camera questions as a snapshot plus a prompt | Describing every motion event to a hosted model |
| Pl@ntNet | A plant identification API: 500 free identifications a day, 10 at a time ([pricing](https://my.plantnet.org/pricing), [terms](https://my.plantnet.org/terms_of_use)) | A specialist for plants that beats a general model on species | — |

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | Kitchen tablet: "Hey Jev, what is this?" → the camera light and a viewfinder appear: "Hold it up to the camera." One frame later: "A tin of Heinz baked beans, 415 grams." The camera closes. | **yes** (viewfinder); the answer is spoken |
| 2 | "Read me this letter." → frame, then OCR: "It's from the gemeente, dated 3 November: your parking permit renews on 1 January; the fee is 84 euros." "What's the reference number?" → answered from the same frame, with no new capture. | yes |
| 3 | "Scan this." (a jar of peanut butter) → barcode 8710400… → Open Food Facts → "Calvé peanut butter, 350 grams. Add it to the pantry?" → "Yes." → `kitchen` books it. | yes |
| 4 | "What plant is this?" → Pl@ntNet top result 0.82: "Probably a Monstera deliciosa, a Swiss cheese plant. Water it when the top few centimetres are dry." | yes |
| 5 | Child at the study laptop: "Look at my homework, is question 3 right?" → "You wrote 7 × 8 = 54. Check that one again; count up from 7 × 7." (the homework assistant is told to hint, not to give answers) | yes |
| 6 | Hallway speaker: "Is the oven off?" → the fixed kitchen camera via smart-home → "The oven display is dark and the knobs point to zero, so it looks off." With an HA oven entity, the entity is trusted first and the camera is not used. | no |
| 7 | Accessibility mode (owner-enabled on one device): "Describe the room." → "You're facing the dining table. There's a blue mug near the edge to your right and a set of keys in the middle." | camera only |
| 8 | Failure: "What is this?" on a tab served over plain HTTP → "I can't use the camera on this screen because the page isn't on a secure connection. The owner can fix that in settings." | yes |
| 9 | Failure: the camera permission was denied → "This screen hasn't allowed me to use the camera. Tap the camera icon in the address bar to allow it." | yes |
| 10 | Ambiguous: "What's this?" on the kitchen *speaker* (no camera) while the kitchen tablet has one → "This speaker has no camera. Shall I look with the kitchen tablet?" → "Yes." → the tablet's viewfinder and light come on. Speech stays on the speaker. | no, then yes |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `look` | `question?: string`, `mode?: auto \| describe \| read \| identify \| count`, `device?` (default: the asking device), `frames?: 1–3`, `hold?: seconds ≤ 10` | `{ answer, frameId, confidence?, source: "local" \| "hosted" }`; the frame goes to the model as an image | R | outward-facing when hosted (the image leaves the house) | capture 0.5–2 s (permission, focus, the "hold it up" wait); hosted model 1.5–4 s; local 2–15 s on CPU **[unverified]** | the capture is; the answer is not |
| `look_again` | `question` | an answer from the last frame of this conversation, without capturing again | R | as `look` | model only | no |
| `scan_code` | `formats?: ean_13 \| upc_a \| qr_code \| …`, `device?`, `timeoutS?: ≤ 20` | `{ format, raw, product?: { name, brand, quantity, offId } }` or `{ url }` for a QR code | R | safe (the code stays local; product lookup is a public GET) | detection 0.1–2 s after the item is in view; Open Food Facts 0.3–1 s **[unverified]** | **yes** ("scan this") |
| `read_text` | `device?`, `language?`, `layout?: page \| label \| screen` | `{ text, lines[], language }`; local OCR first | R | safe locally | 1–3 s (Tesseract.js on a tablet **[unverified]**) | yes ("read this") |
| `identify_plant` | `organ?: leaf \| flower \| fruit \| bark`, `device?` | `{ candidates: [{ species, common, score }] }` | R | outward-facing (Pl@ntNet) | 1–3 s | no |
| `check_view` | `view` (a named fixed view, e.g. "oven", "back door"), `question?` | `{ answer, at, camera }`; the snapshot comes from smart-home `camera_snapshot` | R | outward-facing when hosted; `security` class under B.5 | 0.3–0.8 s snapshot plus the model | no |
| `camera_stop` | `device?` | ok | W | safe | < 100 ms | **yes** ("stop looking", "close the camera") |

`look`, `scan_code` and `read_text` are not `speculative`: capture is an action the person must have asked for, so
it never starts on an unpromoted turn. `look_again` is speculative, because it only reads a frame that already
exists. The QR result is never opened automatically. A URL is read out by its domain only and offered as a
`handoff`.

## 5. Integrate or build

### 5.1 Capture in the browser

- **API.** `navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } } })`,
  then one frame from the `<video>` element drawn onto an `OffscreenCanvas` (or `ImageCapture.grabFrame()` where it
  exists **[unverified: support]**), encoded as JPEG at quality 0.85 and shrunk on the device to a long edge of at
  most 1568 px. The stream's tracks are stopped as soon as the frame is taken, which turns the camera light off.
- **Secure context.** `getUserMedia` works only over HTTPS, `localhost` or `file://`. Over plain HTTP,
  `navigator.mediaDevices` is `undefined` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)).
  The microphone has the same rule, so a device that can hear already has a secure context (`SERVE_TLS_CERT`,
  [current-system §8](../module-investigation/current-system.md#8-deployment)). Chrome's
  `--unsafely-treat-insecure-origin-as-secure` flag is a developer workaround and should not be a setup step
  **[from memory]**.
- **Permission.** The browser asks once per origin. A wall tablet in kiosk mode needs the permission granted ahead of
  time: Fully Kiosk has a setting for web camera access **[from memory]**, and Chrome's policies can grant it per
  origin (`VideoCaptureAllowedUrls`) **[from memory]**. `navigator.permissions.query({ name: "camera" })` tells the page
  `granted`, `prompt` or `denied`, so the device can declare whether a capture will work before anyone asks.
- **Front or back.** Tablets on a wall face the room (`user`). A phone held up faces the item (`environment`).
  Laptops have only `user`. The device declares which cameras it has (§12), and `look` picks one.

### 5.2 Barcodes and QR codes

`BarcodeDetector` is secure-context only, experimental and not Baseline
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector)). Chromium on Android and macOS has it.
Firefox, Safari and desktop Linux Chrome do not, as far as reports go **[unverified: per-platform table]**. So use the
`barcode-detector` polyfill (ZXing compiled to WebAssembly; kitchen cites 3.2.4), which uses the native detector when
present. Detection runs on the device on frames from a live stream for at most `timeoutS`. Only the decoded string
goes to the server, never the frames. A USB or Bluetooth HID scanner stays the first choice for the pantry, as
[kitchen §11](kitchen.md#11-native-tools-and-dependencies) says. The camera path is for devices without one.

Product lookup: Open Food Facts `GET https://world.openfoodfacts.org/api/v2/product/{code}?fields=product_name,brands,quantity`
(keyless, with a descriptive `User-Agent`; read limits of about 100 a minute **[from memory]**). If Grocy is
connected, try its own `GET /stock/products/by-barcode/{barcode}` first
([kitchen §5](kitchen.md#5-integrate-or-build)).

### 5.3 Who looks at the frame

| Option | Facts | Verdict |
|---|---|---|
| **The assistant's own model (hosted)** | Anthropic accepts JPEG, PNG, GIF and WebP image blocks. The maximum is 8000×8000 px, with a stricter limit above 20 images in one request, and images inside `tool_result` content count ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)). A 2000×1500 photo is resized to 1269×952, about 1,564 tokens (same page). | **Default for `look`.** The best answers, and follow-up questions work because the image stays in the conversation. Opt-in per device, because the frame leaves the house. |
| **Local VLM through llama.cpp `llama-server`** | Vision runs through `libmtmd`: a model GGUF plus an `--mmproj` projector, served on the OpenAI-compatible `/chat/completions` endpoint. SmolVLM (256M–2.2B) and Qwen3-VL (added 2025-10-30) are supported ([multimodal.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)). | **The local-first option**, reached through the existing `home-model` account. Good for "what is this", rough on dense text. Speed on the server CPU must be measured. |
| **Local OCR** (Tesseract.js in the browser, or PaddleOCR on the server **[unverified: Node binding]**) | Plain text with no understanding of it | `read_text` runs it first and lets the model only summarise the text. That is cheaper and keeps the letter's image at home. |
| **Specialists** | Pl@ntNet for plants (500 a day free); Open Food Facts for products | Called only by their own tools |

**Recommendation.** Make the source a household setting: `local` (llama.cpp VLM plus OCR), `hosted` (the assistant's
model), or `ask` (the default). With `ask`, the first look on a device says "That sends a photo to Anthropic; is that
OK on this screen?", and the answer is remembered for that device.

### 5.4 How the current adapters would carry an image

Today nothing can: `ToolResult.content` is a `string` (`packages/core/src/Domain.ts:38`), and every adapter maps it to
text. The core change, named as a gap in [images §14](images-and-photos.md#14-foundations-needed):

- `ToolResult.content` becomes `string | ReadonlyArray<{ type: "text"; text } | { type: "image"; mediaType; data | mediaRef }>`.
  The string form stays valid, so old modules keep working.
- **`llm-anthropic`** maps image parts to `{ type: "image", source: { type: "base64", media_type, data } }` *inside*
  the `tool_result` block (`toMessages`, `packages/llm-anthropic/src/index.ts:96`). This is supported as-is.
- **`llm-openai-compatible`**: a `tool` message accepts text parts only, and images must go in a `user` message
  ([OpenAI SDK reference](https://javadoc.io/static/com.openai/openai-java/0.26.1/com/openai/models/ChatCompletionToolMessageParam.Content.html),
  [openai-agents issue](https://github.com/openai/openai-agents-python/pull/2214)). The adapter therefore sends the
  tool's text, then a synthetic user message `[image from tool look]` with an `image_url` data URL. llama-server and
  OpenRouter vision models accept that.
- **`agent-claude-code`**: the in-process MCP bridge returns `content: [{ type: "text", … }]` (`sdk.ts:88`). MCP
  tool results also allow `{ type: "image", data, mimeType }`. Whether Claude Code passes such a result to the
  model unchanged is **[unverified]** and must be tested before claiming vision on the subscription path.
- **History.** One frame is about 1.5k tokens. It stays in history only for the follow-up window, and is then
  replaced by the text `[image: tin of baked beans, removed]`, so later turns do not pay for it.

### 5.5 Cameras without a browser

- **Voice nodes** have no screen. Capturing on them is a node capability: `rpicam-still -o - --width 1536` on a
  Raspberry Pi camera, or `ffmpeg -f v4l2 -frames:v 1` on a USB webcam **[from memory: flags]**. The node needs an
  indicator it can control (an LED on a GPIO pin, or the webcam's own light). Without one, the node does not offer
  `look` at all.
- **Fixed cameras** (the kitchen ceiling camera for "is the oven off") go through smart-home's `camera_snapshot` with
  `GET /api/camera_proxy/<entity>`. This module adds named *views*: a camera, an optional crop rectangle and a
  standard question. Frigate snapshots are a second source **[unverified: API]**.

## 6. Data

| What | Scope | Shape | Kept |
|---|---|---|---|
| Frames | conversation | `{ frameId, deviceId, at, mediaType, bytes }` in memory, never in the Module store | until the follow-up window ends, at most 10 minutes; never written to disk unless "save it" |
| Saved frames | person | a file under `data/modules/vision/` plus a row `{ frameId, caption, savedBy }` | until deleted |
| Per-device consent | device | `{ hostedAllowed: boolean, askedAt, by }` | until changed |
| Named views | household | `{ name, camera, crop?, question, aliases[] }` (a `records` field) | until changed |
| Scan log | household | `{ code, format, product?, at, deviceId }`; the last 50, for "what did I just scan" | 7 days |

Other modules read only the scan log export (`vision.lastScan`), which kitchen uses.

## 7. Long-running work and events

- No Scheduler jobs. A capture is part of a turn and never outlives it. A camera left open more than `hold` seconds,
  or 30 s at most, is closed by the device itself, even if the server is gone.
- Events emitted: `vision.camera.opened` and `vision.camera.closed` with the device, for the admin "camera activity"
  log and for the dashboard to show the indicator; `vision.code.scanned` for kitchen.
- On a restart, frames in memory are lost. That is the intent.

## 8. Presentation

- **Viewfinder.** While the camera is open, a live preview appears in the **Companion** layout: the character perches
  on the preview's corner and looks at it. Framing guides are drawn on top (a rectangle for a label, a line for a
  barcode). Under the preview a red dot and "Camera on" stay visible whatever else happens. That indicator is drawn
  by the host, not by a module, and nothing can hide it.
- **Result.** The captured frame shrinks into the character, and the answer is spoken. A `card` with the product, or
  a `text` with the read letter, appears only when it helps ("read me this letter" shows the text, so the person can
  check the reference number). Lifetime `glance`.
- **Guidance cues.** For accessibility mode and example 1, the device computes a sharpness value and the barcode
  position locally, and the assistant says "closer", "a bit left" or "hold still", like Show and Tell.
- **Without a screen.** The node with a camera speaks a short cue ("Looking.") and plays an earcon when the frame is
  taken. A speaker without a camera offers the nearest device that has one (example 10), using
  [presentation §6.2](../module-investigation/presentation-and-device-capabilities.md#62-choosing-the-best-other-screen)
  ranking.

## 9. Notifications and proactive behaviour

None. The module never opens a camera on its own, never as part of a routine without the owner having written that
routine, and never to "check" anything on a schedule. A routine that asks "is the oven off?" at 23:00 uses
`check_view`, which reads a fixed camera the owner already set up in Home Assistant, and only if the owner enabled
"views in routines".

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | where frames go: `local` / `hosted` / `ask`; plant identification allowed; accessibility mode allowed | `ask`; on; off |
| Module | local VLM endpoint (a `home-model` account) and model; OCR languages (`eng+nld`); Pl@ntNet API key; named views (records) | none; `eng+nld`; none |
| Assistant | may use `look`; homework style (hint, do not solve); describe people (off) | general assistant yes; homework assistant hint |
| Device | camera use allowed here; preferred camera (`user` / `environment`); hosted frames allowed here; accessibility mode here | **off**; detected; ask; off |
| Person | accessibility mode follows me (when `Person` records exist) | off |

First-run setup: (1) switch the camera on for one device in Devices › What it can do; (2) the device asks for the
browser permission there and then, while the owner is standing at it; (3) choose local, hosted or ask; (4)
optionally add a Pl@ntNet key and named views.

## 11. Native tools and dependencies

| Need | Where | When missing, the assistant says |
|---|---|---|
| HTTPS (`SERVE_TLS_CERT`/`KEY`) | server | "I can't use the camera on this screen because the page isn't on a secure connection." |
| Camera permission | the device | "This screen hasn't allowed me to use the camera…" (example 9) |
| `barcode-detector` polyfill (bundled, ZXing WASM) | the device | — (always bundled) |
| `tesseract.js` and language data (eng, nld; about 10–20 MB per language, cached **[unverified]**) | the device | falls back to the model reading the image |
| A vision-capable model: the assistant's hosted model, or `llama-server` with an `--mmproj` | server or LAN | "I can see it, but this assistant's model can't look at pictures." |
| `rpicam-still` or `ffmpeg` plus an indicator LED | voice node | the node does not offer `look` |
| Pl@ntNet key | vault | "Plant identification isn't set up; I'll do my best." The general model then guesses, with that caveat. |
| `sharp` (shared with images) | server | frames are passed through without resizing |

## 12. Interaction with the rest of the system

- **Device capabilities.** The proposed `camera?: boolean`
  ([presentation §5.2](../module-investigation/presentation-and-device-capabilities.md#52-vocabulary-proposal)) is not
  enough. Proposal: `camera?: { facing: ReadonlyArray<"user" | "environment">; permission: "granted" | "prompt" |
  "denied"; barcode: "native" | "polyfill"; indicator: "browser" | "led" | "none" }`. `DeviceLiveState` gains
  `cameraOpen: boolean`. A device with `indicator: "none"` is never offered `look`.
- **Voice.** "What is this", "what am I holding", "read this", "scan this" and "stop looking" are typed actions
  with `examples`, so capture starts without waiting for the model. The filler is "Hold it up to the camera." Barge-in
  closes the camera. Recognisers mishear "scan this" as "skin this" **[unverified]**; the action's `close` matching
  handles that.
- **Character.** In Companion layout the character looks at the viewfinder. With `stage.content` it looks at the
  barcode's position. It never "reacts" to a person's face.
- **Assistants.** The general assistant gets `look`, `scan_code` and `read_text`. A homework assistant template
  (persona: Socratic, gives hints, never full answers) gets `look` and `look_again`. A kids' device has `look` off
  unless the owner enables it.
- **Other modules.** kitchen (scan → product → pantry); lists ("add this to the shopping list" after a scan);
  smart-home (fixed views); memory-and-notes ("remember where I put this" saves the caption, not the frame);
  dictation-and-transcription (reading a letter aloud and saving it as a note).

## 13. Privacy and safety

- **Never without being asked.** Capture starts only from a promoted turn whose text asked to look (an action match
  or an explicit tool call). A "what is this" carried over from the follow-up window counts. Nothing else does.
- **Always visible.** The red indicator and the browser's own indicator are on for the whole time. A capture lasts
  at most 10 s (`hold`) and the device closes the stream itself.
- **People in the frame.** The system prompt tells the model to describe objects and text, not to identify or
  appraise people. "Who is this?" gets "I don't identify people." Accessibility mode may say "a person is standing
  by the door", nothing more.
- **Children.** Homework show-and-tell sends a child's handwriting, and possibly their face, to a hosted model when
  hosted is on. Proposed default: kids' devices use `local` only.
- **Dutch law.** Covert camera recording falls under art. 139f Sr, which has no participant exception
  ([recordinglaw.com summary](https://www.recordinglaw.com/netherlands/recording-laws/), secondary source). A visible,
  on-request, unstored capture is far from that, but it is one more reason for the indicator rule.
- **QR codes** can carry hostile URLs: never opened, only read out by domain and offered as a hand-off.
- **Frames as prompt injection.** Text in an image ("ignore your instructions") is content, not instruction. The tool
  note marks it `[text seen in the image]`.

## 14. Foundations needed

- **Core: images in tool results** (§5.4). This is the one hard prerequisite for `look`.
- **Device capabilities** (camera, indicator, permission; the live `cameraOpen`); **Tool context** (which device
  asked); **Presentation** (viewfinder, Companion, cards); **Requirements and health** (HTTPS, VLM endpoint).
- **A first version without most of them:** `scan_code` and `read_text` entirely on the device (polyfill plus
  Tesseract.js), returning text over a small message. That needs no image support in core and feeds kitchen today.

## 15. Open questions

1. **Frames to a hosted model:** allowed at all, per device, or local only? Default proposed: ask once per device.
2. **Is a local VLM worth running** on the server (CPU speed to measure), or is OCR plus the hosted model enough?
3. **Accessibility mode:** is anyone in the household blind or low-vision? If not, skip it.
4. **Homework help:** wanted, and must it stay local because it involves children?
5. **Node cameras:** are any planned? A node needs an indicator LED before it may have `look`.
6. **Named fixed views** ("is the oven off"): is there a camera that sees the oven, or does an HA power sensor answer
   better? The sensor should always win when it exists.
7. **Disagreement with [images-and-photos §4](images-and-photos.md#4-tools) and [smart-home §4](smart-home.md#4-tools).**
   Both define `camera_snapshot`. This document proposes that smart-home owns it, that images only presents its
   output, and that vision calls it for views. One tool, one owner.
8. **Disagreement with [presentation §5.2](../module-investigation/presentation-and-device-capabilities.md#52-vocabulary-proposal).**
   `camera?: boolean` should become the structured capability in §12, including the indicator.
9. **Agreement with [images Q7](images-and-photos.md#15-open-questions)**, answered: image results to the model should
   come with this module, not wait for cameras.
