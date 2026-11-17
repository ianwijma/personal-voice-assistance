# Looks and voices: per assistant, overridable per device

**Status: built (2026-11-17).** Requested by the owner after the assistants (docs/ASSISTANTS.md) and characters
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

- **Protocol 8.** `look` and `voice` are new members of the closed set `DeviceSettingsKey` and required in
  `DeviceSettings`, so `PROTOCOL_VERSION` went from 7 to 8: a version 7 page or server gets the version-mismatch
  close (`4400`, "Reload") instead of refusing devices it cannot read. Voice nodes (docs/VOICE-NODES.md, unmerged)
  take 9 (docs/ASSISTANTS.md §5.1).
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

### 5.0 Server (`apps/assistant`, 2026-11-17)

- **Old files.** A stored device-type entry is a complete `DeviceSettings`, so one written before `look` and `voice`
  existed would have failed to decode and been dropped; `SettingsStore` now fills the two keys from the type's built-in
  before decoding (`withNewKeys`). Device `own` and assistants have them optional and load unchanged.
- **Saves.** `assistant.create`/`save` carry `look` as any field (absent stays absent). `device.save` takes `look` and
  `voice` for a type and a device (`null` resets a device). A device voice of its own is checked by `voiceProblem`
  (serve mode): a local voice that is not downloaded (or unknown) is refused, a hosted provider without a key is a
  warning that `saveAnyway` overrides. The same check, through the same path and shapes, runs on `assistant.create` and
  `assistant.save` for the assistant's own voice (`assistant.create` takes an additive `saveAnyway`). A voice that is new
  or changed is checked as above. A voice the stored assistant already has is never refused (that would block every
  other edit of the assistant): if it became unavailable it only warns, and `saveAnyway` keeps it; a fine unchanged
  voice is not affected.
- **Run time.** The resource pool binds voices per *user*: `assistant@place` for each place (a device, or the type's
  defaults) that lists the assistant, whether that place's `voice` section is its own or follows the assistant, plus
  the assistant itself while some place follows its voice (the fallback of a session whose place does not list it). A
  turn reads its place's binding at its start (`conversationSetup(assistant, deviceId)`, `voiceOf`), so a change
  applies at the next turn and the old instance goes after the grace period; typed turns and `speakTyped` use the same
  setup. Places with the same voice share one `Tts` (the pool keys instances by voice). Because the user of a place
  never changes, a place whose voice changes or flips source (own <-> the assistant's) keeps its own old voice until
  the new one has loaded, per place: two devices reset while the assistant's voice loads each keep their own old voice
  (PR #84 review; this replaced `ReconcileOptions.voiceInherit`, under which both took over the one shared
  `assistant` binding and the second device spoke with the first one's old voice).
- **Trace.** `TraceInfo.config.voice` is the key of the voice the turn used; the new optional `config.voiceFrom` says
  `"device"` or `"assistant"` (protocol, additive).
- **Pushes.** `device.setup` is compared as a whole before sending, so a change of an assistant's look, the type's or
  the device's own look sends it again, and a change the device does not show (an assistant's look hidden by the
  device's own) sends nothing. The admin lists carry both keys through the schema.
- **Who uses a voice.** `usedBy` stays the assistants. Beside it the voice catalogue entry (`VoiceEntry`) and the
  resource status (`ResourceInfo`, `tts`) carry an additive, optional `usedByDevices: Array<{ target: DeviceTarget, name }>`
  (`DeviceUser`, `packages/protocol/src/deviceUsers.ts`): every device, and every type's defaults ("Every browser"),
  whose *effective* `voice` section is its own, computed from the settings when asked (a device's own value, else its
  type's), so it is always current. A device that follows a type's own voice is listed beside the type; Reset or
  "Follows the assistant" removes it. An assistant whose voice every device hides is still listed in `usedBy` (its voice
  is still its configuration). On resource status the pool's users `assistant@place` count as the assistant in `usedBy`;
  no raw key leaves the server. Model pickers keep their `usedBy` (devices cannot override those).
- **Latency.** Not measured: the change only picks a different pool key at the start of a turn.
- Tests: `apps/assistant/test/serveLooksAndVoices.test.ts`.

### 5.1 Web (`apps/web`, 2026-11-17)

The web half uses the schemas of §2, plus the additive `usedByDevices` of §5.0. **Used by** (`components/pickers/UsedBy.tsx`):
a voice's row in the picker shows a second line "Used by Jeff, T3 · Kitchen iPad, Every browser", each name linking to
its page (an assistant's Voice tab, a device, or the type's defaults); nothing when it has no users. The web has no page
that lists the resource status's users yet, so `ResourceInfo.usedByDevices` is carried by the protocol and the server only.

**Assistant › Look** (`components/settings/pages/assistants/LookTab.tsx`, the editor in `components/looks/`). A tab
between Voice and Modules, on the assistant's one draft: dirty mark, "Unsaved", Save and Cancel as on every tab; the look
goes out with `assistant.save`. The tab says whose look it is ("How Jeff looks on the voice page while it answers") and
lists the devices where it is not shown because they have their own look, with links to them. The editor, top to bottom:

- **The large preview** ("Jeff's look: Flame"): the real character host (`startCharacterHost`), the same code as the
  voice page, driven by a scripted conversation through the five core modes (`characters/preview.ts`, 14 s round) with the
  host's stand-in voices instead of a microphone, in the page's theme. Buttons: Conversation, or one mode pinned. It runs
  only while in view, pauses with the tab, starts pinned to Speaking under reduced motion, swaps characters in place, and
  says so when a character falls back to the baseline (as the stage would).
- **The character picker**: a card per registry character (19), each with a small live preview, name, family and
  summary. A card loads its chunk only when it first scrolls into view (`characters/catalog.ts`, checked with the host's
  manifest checks); all previews share one animation loop, 30 frames a second at most, stepping only the cards in view,
  nothing while the tab is hidden, and under reduced motion a still Speaking pose drawn four times a second. A radio
  group (arrow keys, Home, End). The cards show this look's colours and sensitivity; the selected card shows all of it.
- **"<Character> settings"**, from the manifest: number → slider with its value and unit, toggle → switch, choice →
  segmented control (up to four short labels) or select, colour → a theme colour or a custom one (the `color` kind,
  used by four characters, is not in §4's list). Grouped by the options' `group`, help text under each, a Reset beside
  every value that differs from its default, and "Reset all (n)" for the character's own.
- **Colours and sensitivity** (`$you`, `$voice`, `$sensitivity`), each with its Reset; they stay when another character
  is picked, and so do the reserved ids (`size`, `speed`, `glow`, …) the new character offers with the same kind
  (docs/CHARACTERS.md §4.4).

**Stored form** (`lib/looks.ts`). Every edit is validated with `options.ts` (`validateValue`) and stored canonically:
`{ character, version, options }` with the character's manifest version and only the values that differ from their
defaults (missing ids take the default on load, so the look is the same), `options` left out when none differ. So an
edit back to the saved value leaves nothing to save. On an assistant, the baseline with every default is stored as
**no look** (absent = the baseline, so the two never differ); a device's own look is always stored, the baseline
included. A look naming a character this version does not have is shown as such and kept untouched until another is
picked.

**Devices › a device, and "Every browser"** (`components/settings/pages/devices/LookVoiceSections.tsx`). Two sections
after "On the voice page", each with the usual marks ("Own value · Reset" / "Follows Every browser"). Inside, a choice of
two cards: "Each assistant's own look" (the assistants here are listed with their look and a "Change on Jeff › Look"
link) or "One look on this browser" (the same editor, titled "Kitchen iPad's own look: …"). Voice likewise: "Each
assistant's own voice" (listed, with links to their Voice tab) or "One voice on this browser" (the voice picker of the
Voice tab, with the same "sent to" line). The two levels stay apart: the marks say device vs. type defaults, the cards
say assistant vs. device. Choosing "One voice" starts from the first assistant's voice; going back and forth keeps
the device's own value until the page is left. Saved with `device.save` as `{ from: "device", … }`, an own
`{ from: "assistant" }` when a device follows the assistants although its type's defaults fix one, and `null` on Reset.

**Lists.** Devices › All devices and the Overview's "Who answers where" show "Own look: Robot eyes" and "Own voice: Pim"
on a device that has them ("(defaults)" when it follows its type's for it, plain "Look:" on the defaults row); the
device list's "n own settings" counts the two sections.

**Voice page** (`components/Visualiser.tsx`, `lib/voiceSetup.ts`). The stage shows `stageLookOf(state)`: the look the
setup gives the assistant holding the turn, else the one the top bar names (`shownAssistantId`, which the top bar's name
now uses too), else the setup's own look, else the baseline. A change (another assistant takes the turn, an admin saves)
goes to the host's `setChoice`, which swaps in place. `Prefs.character` is no longer read; a stored one is dropped on
the next write. `?character=<id>&opt.<id>=<value>` is a try-out for the page load (`tryoutFromSearch`, `withTryout` in
`characters/choice.ts`): it wins over the configured look, `opt.*` alone tunes the configured look, nothing is stored,
the parameters leave the address bar, a reload shows the configured look.

**Mock** (`apps/web/mock`). It already took and sent the new fields through the protocol's schemas (`assistant.save`
with `look`, `device.save` with `look`/`voice`, `device.setup` resolved by `deviceSetupFrom`); a trace's `config.voice`
now follows the device's voice (`voiceFor`). It does not refuse a device voice that is not downloaded (the real
server's check, §3). Like the real server, its `assistant.create` warns on a hosted voice without its key
until `saveAnyway` (its `assistant.save` does not check the voice).

**Creating with a voice that warns** (PR #84 review). `assistant.create` answers a hosted voice without its key (a copy
of an assistant that has one, say) with a warning, like `assistant.save`. The wizard's Check step then shows the warning
in its footer with "Create anyway" and "Go back" (any other step drops it), and Duplicate (`NameDialog`) shows it with
"Duplicate anyway" and "Go back" (a rename drops it); "anyway" sends `saveAnyway` (`client.createAssistant`). Tests:
`test/wizardCreate.test.tsx`, `test/duplicateDialog.test.tsx`, `test/assistantClient.test.ts`, `e2e/wizard.spec.ts`,
`e2e/assistants.spec.ts`.

**Differences from §4.**

- The large preview is above the picker, not after it, and stays in view (sticky, from tablet width) while the picker and
  the settings scroll, so a pick or a slider is seen at once.
- On a device page the picker is folded under "Choose another character": there the look is one section of many, and a
  19-card grid made the page very long.
- "Reset all" resets the character's own settings; the three host-level settings keep their own Reset each (they are
  shared by every character, so a reset of one character's settings should not recolour the look).
- The colour kind of option is rendered too (§4 lists number, toggle and choice).

**Tests.** `test/looks.test.tsx` (canonical form, validation, resets, switching, the options form in jsdom),
`test/stageLook.test.ts` (which look the stage shows, the try-out), `test/devices.test.ts` (the two sections: own,
Reset, the patch, a type's defaults), `test/prefs.test.ts` and `test/characters/choice.test.ts` (the old preference
ignored and dropped), `e2e/looks.spec.ts` (pick a character, change options and save, the voice page shows it and the
try-out; a device's own look and voice set and reset).

**Screenshots** (`docs/looks-evidence/`, made by `apps/web/e2e/looksEvidence.ts` against dev:mock, dark and light,
desktop 1280 wide and phone 390 wide): `assistant-look-*` (the Look tab), `assistant-look-full-*` (the whole tab),
`device-look-*` and `device-look-voice-full-*` (the Kitchen iPad with its own look and voice), `device-list-*`, and
`voice-page-*` (the voice page showing Jeff's look, Flame, while speaking).
