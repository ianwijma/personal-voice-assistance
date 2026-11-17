# Looks and voices: per assistant, overridable per device

**Status: in progress (2026-11-17).** Requested by the owner after the assistants (docs/ASSISTANTS.md) and characters
(docs/CHARACTERS.md) work merged into main.

## 1. What the owner asked for

- The stage's character (its **look**: which character and its settings) is configured in the admin UI, as part of an
  **assistant**, so each assistant has its own look.
- A **device** can override the look, so a device always looks the same whatever assistant answers.
- A device can also override the **voice**, so a device sounds the same whatever assistant answers. (docs/VOICE-PROVIDERS.md
  retired the old per-device voice in favour of the assistant's; this brings a device voice back, as an override of the
  assistant's voice, in the new device-settings model.)
- Without a device override, the assistant's look and voice apply.

## 2. Data model

Schemas in `packages/protocol/src/looks.ts`, `assistants.ts`, `devices.ts`.

```ts
Look        = { character: String 1..64, version?: String ≤ 64, options?: Record(String 1..64, Finite | Boolean | String ≤ 256) ≤ 64 }
              // the stored form of docs/CHARACTERS.md §4.4 (the web client's CharacterChoice), host-level $you/$voice/$sensitivity included
DeviceLook  = { from: "assistant" } | { from: "device", look: Look }
DeviceVoice = { from: "assistant" } | { from: "device", voice: VoiceRef }

Assistant      += { look?: Look }                 // absent = the baseline character (sine-lines)
DeviceSettings += { look: DeviceLook, voice: DeviceVoice }   // two new section keys; built-in { from: "assistant" } for both
```

- They are two separate **section keys** of the device settings (§2.6 of docs/ASSISTANTS.md): each has its own
  "Own value · Reset" on a device, and a device type's defaults can set them for every device of the type. Resolution
  is unchanged: device own → type defaults → built-in.
- Tagged, not `null`: device sections resolve with `own ?? typeDefaults ?? builtIn`, and a device that follows the
  assistant while its type's defaults set a look must be able to say so as an own value.
- The server only bounds a look's shape. Which characters exist and what their options are is known only to the web
  client; the character host validates options on every load (CHARACTERS.md §4.4), and a look naming a character the
  client does not have shows the baseline, kept untouched.

## 3. Resolution

- **Voice** of assistant A on device D: `voiceFor(D.voice, A)`: the device's own voice, else A's voice. Applied by the
  server at the next turn start, as a change of the assistant's voice is today; the resource pool keys voices by
  `voiceKey`, so two devices with the same voice share one `Tts`. A device voice is validated on save the way an
  assistant voice is (a local voice that is not downloaded is refused; a hosted provider without a key warns).
- **Look** of assistant A on device D: `lookFor(D.look, A)`: the device's own look, else A's look, else the baseline.
  The server resolves it into `device.setup`: each listed assistant carries its resolved `look`, and the setup carries
  the device's own `look` when it has one (shown when no assistant is listed).
- **Which assistant's look the voice page shows:** the assistant that holds the turn (`State.holder`), else the
  assistant the top bar shows as answering. The stage therefore changes character when another assistant takes the
  turn, unless the device has its own look. The swap uses the host's existing in-place swap (no blank frame).
- **Trying a character from the address bar** (`?character=<id>&opt.<id>=<value>`) still works, for this page load only:
  it wins over the configured look and is no longer stored. The per-browser `Prefs.character` is no longer read (a
  stored value is ignored and dropped on the next prefs write).

## 4. Admin UI

- **Assistant → Look** (a tab beside Voice): a character picker (every character in the registry, each with a small live
  preview, name, summary, family), the selected character's options rendered from its manifest (number → slider, toggle →
  switch, choice → segmented control or select; help text; "Reset to default" per option and for all), the three host-level
  settings (your colour, assistant colour, sensitivity), and a large live preview that runs a scripted conversation through
  the five modes with buttons to pin one mode, in the page's theme.
- **Devices → a device, and a device type's defaults → Look and Voice**: two sections, each "Follows the assistant" or
  the device's own (the same picker and options as the assistant's Look tab, and the same voice picker as the
  assistant's Voice tab), with the usual "Own value · Reset".
- Overview / device lists show when a device has its own look or voice.

## 5. What was built

(Filled in as it lands.)
