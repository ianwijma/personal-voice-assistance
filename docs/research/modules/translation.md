# Translation: interpreter mode, camera text, subtitles, phrasebook

Research write-up, 2026-11-18. Not an approved design. It uses the foundation names in [README.md](README.md) and
builds on [current-system.md](../module-investigation/current-system.md) (hearing per device, one voice per assistant)
and [core-tools §5.6](core-tools.md#56-translation). Outside facts were checked on 2026-11-18 where a link is given;
anything else is marked **[unverified]**. Latency figures are estimates to be measured with `TurnTrace`.

## 1. Summary

A one-off "how do you say 'where is the station' in Spanish" stays what [core-tools §5.6](core-tools.md#56-translation)
says it is: the language model answers, no tool. This module covers what that cannot do:

- **interpreter mode**: two people at one device who share no language, each speaking their own, the device speaking
  each utterance back in the other language, with subtitles of both on the screen;
- **camera text**: a menu, a letter or a sign held up to a device camera, translated on the screen;
- **subtitles**: the translation of what is said shown as captions, for a guest who reads better than they listen;
- a **phrasebook**: saved phrases per person, said slowly, practised later through [learning.md](learning.md).

- **Priority: second wave.** The interpreter is the most visible part, and it needs two core changes first: a voice
  per language and the recogniser's detected language (§12). Phrasebook and camera text can come earlier.
- **Effort: L overall.** Interpreter mode is L (core changes in hearing and voice, a screen layout, latency work).
  Phrasebook S. Camera text M (camera consent design, images to the model). A local translation engine is M.

Boundary: core-tools keeps the one-off; [learning.md](learning.md) owns practice and correction; this module owns
modes in which every utterance is translated, and the translation engines.

## 2. What others do

| Product | Behaviour | Copy | Avoid |
|---|---|---|---|
| Google Translate conversation mode | Two language buttons plus an automatic mode that detects which of two languages is spoken; split screen, the other half upside down for the person opposite **[unverified: current layout]** | Two fixed languages, not "any language"; a button per side as the reliable fallback | Detection across many languages at once |
| Google Assistant interpreter mode ("Hey Google, be my Spanish interpreter") on Nest Hub | Hands-free alternating translation with on-screen text **[unverified: still offered]** | The spoken start phrase and the screen layout | Requiring the wake phrase per utterance |
| Apple Translate, Live Translation on AirPods | Face-to-face view; translation spoken into the earbuds **[unverified]** | Subtitles for the reader, speech for the listener | — |
| DeepL Voice | Meeting and face-to-face translation as a paid product **[unverified: plans]** | Text-quality engine behind speech | Paid seat for a household |
| Google Lens, Apple Live Text | Camera text translated over the image | Overlay or side list of translated lines | Live video translation on a weak tablet |
| Alexa Live Translation | Launched 2020 for six language pairs on Echo devices **[unverified: still available]** | Pairs, not "auto" | — |

Lesson: every product that works restricts the conversation to **two named languages** and gives a manual fallback.
Free language detection across 99 languages on short utterances is where they fail.

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | Owner: "Hey Jev, be our interpreter, Dutch and Spanish." → "Interpreter on: Dutch and Spanish. Speak one at a time; say 'stop interpreting' when you're done." The stage splits into two halves. | best with |
| 2 | Guest: "¿Dónde puedo dejar mi abrigo?" → in a Dutch voice: "Waar kan ik mijn jas laten?" Owner: "Aan de kapstok bij de deur." → in a Spanish voice: "En el perchero junto a la puerta." No wake phrase in between. | best with |
| 3 | Kitchen tablet, menu held to the camera: "What does this say?" → a list of the menu lines with translations beside each; spoken: "It's a lunch menu: soup of the day, a toastie with cheese, and three salads." | yes |
| 4 | "How do you say 'I'm allergic to nuts' in Japanese? Save it." → "Watashi wa nattsu arerugī desu. Saved to your phrasebook." (spoken by the assistant's own voice: no local Japanese voice, §11) | no |
| 5 | Later: "Read my Japan phrases slowly." → each phrase, then the Japanese at 0.8 speed, with a pause to repeat. | no |
| 6 | Subtitles: a device with "translate captions to English" on; grandma speaks Dutch to the assistant, the captions show the English line for the visiting cousin. | yes |
| 7 | Ambiguous: in interpreter mode someone says "OK" (both languages). → the recogniser cannot tell; the module repeats it in neither and shows "OK" under both halves. | yes |
| 8 | Failure: "Be my interpreter, Dutch and Korean." with a Parakeet recogniser → "This device's speech model doesn't understand Korean. With the Whisper model it would, but replies get a second or two slower. Switch for this conversation?" | no |
| 9 | Failure: camera on a voice node → "This speaker has no camera. Hold it up to the kitchen tablet." | no |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `interpreter_start` | `languages: [lang, lang]` (BCP 47), `names?: [string, string]`, `detect?: "auto" \| "buttons"`, `subtitles?: boolean` | the mode as set, plus what this device cannot do (no voice for a language, recogniser lacks one) | W (conversation) | safe | < 50 ms (+ a recogniser switch of 1–3 s if needed) | yes ("be our interpreter, Dutch and Spanish") |
| `interpreter_stop` | none | summary: utterances, duration | W | safe | < 20 ms | yes |
| `translate` | `text`, `to`, `from?`, `formality?: "formal" \| "informal"`, `engine?` | `{ text, from, engine, alternatives? }` | R | safe; outward when the engine is hosted | model 0.5–1.5 s; DeepL 150–400 ms; local 50–300 ms per sentence **[unverified]** | no |
| `camera_text` | `to?`, `device?` | the recognised lines with translations, as a `list` presentation | R | safe; uses the camera (§13) | capture 0.3 s + vision model 2–5 s | no |
| `phrase_save` | `text`, `translation`, `language`, `topic?` | `{ id }` | W | changes data | < 20 ms | no |
| `phrase_list` | `language?`, `topic?`, `slow?: boolean` | phrases, and a playback of them when `slow` | R | safe | < 20 ms | yes ("my Japan phrases") |

In interpreter mode the turns themselves are not tool calls: the module switches the conversation into a mode where
each utterance goes through the translation path in §5.3, not through the assistant's prompt and tool loop.
`translate` is only offered when the engine is not the model itself; with the model as engine it is noise in the
tool list.

## 5. Integrate or build

### 5.1 Translation engines

| Engine | Quality and languages | Cost and terms | Fit |
|---|---|---|---|
| The assistant's language model (Claude, OpenRouter models) | Very good for European pairs; handles register, idiom and "say it politely" | Already paid for; 0.5–1.5 s to first token on the API path, more on the subscription path ([agent-backends](../agent-backends.md)) | Default |
| [DeepL API](https://support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-Free) | Strong for European languages; formality and glossaries | Free tier 500,000 characters a month; paid tiers' prices vary by source **[unverified]** | Option for interpreter speed; key in the vault |
| Google Cloud Translation, Azure Translator | Wide coverage | Free monthly allowances **[unverified: amounts]** | Not recommended: another cloud account for little gain |
| [TranslateGemma](https://blog.google/innovation-and-ai/technology/developers-tools/translategemma/) 4B / 12B (January 2026) | 55 languages; Google reports the 12B beating Gemma 3 27B on WMT24++ | Gemma Terms of Use, not OSI open | Local option through the existing `home-model` account (`llm-openai-compatible`), so no new adapter |
| Mozilla [Firefox Translations models](https://github.com/mozilla/firefox-translations-models) on the Bergamot (Marian) engine | Small CPU models per pair, Dutch↔English included | Engine MPL-2.0; model files' licence **[unverified]**; WebAssembly build, no Node package found | Offline fast path for nl↔en, later |
| Opus-MT (Helsinki-NLP) via `@huggingface/transformers` or CTranslate2 | Per pair, uneven | CC-BY-4.0 **[unverified]** | Fallback for a weak local model |
| LibreTranslate (Argos Translate) | Medium | AGPL sidecar | As in [core-tools §5.6](core-tools.md#56-translation); not preferred |
| NLLB-200 distilled 600M | 200 languages | [CC-BY-NC 4.0](https://huggingface.co/facebook/nllb-200-distilled-600M/blob/main/README.md), "not released for production" | Skip |

Recommendation: the model by default; DeepL as the optional "fast interpreter" engine; TranslateGemma on the home
model server as the local route. Measure all three with `TurnTrace` on the same twenty utterances before choosing a
default for interpreter mode.

### 5.2 Hearing two languages on one device

One recogniser runs per device, with the Hearing settings of the device's hearer
([ASSISTANTS.md](../../ASSISTANTS.md) "Recogniser", current-system §3.1). What the repo's models can do today
(`packages/stt-sherpa/src/presets.ts`, measured figures from the preset table):

| Recogniser | Languages | Reports which language? | Interpreter fit |
|---|---|---|---|
| `parakeet-v2` (default) | English only | n/a | No |
| `parakeet-ultra` | English, Dutch and 23 more European languages; "picks the language itself" | Not exposed by our adapter; whether the model returns it is **[unverified]** | Good for European pairs, 0.1–0.5 s; needs language ID (below) |
| `whisper-turbo` | 99 languages, fixed or `auto` | Whisper detects a language per decode; exposing it is a small adapter change **[unverified: sherpa result field]** | Widest; reply starts 1–3 s after the pause; 28 s turn cap |
| `nemotron-560` / `-320` | Multilingual, `auto` | **[unverified]** | Live words, but 31–34 % word errors on phone-like audio: too many for translation |
| Deepgram (`stt-deepgram`) | Default model `flux-general-en`, English | — | [Flux Multilingual](https://deepgram.com/blog/introducing-flux-multilingual) (GA April 2026) covers 10 languages including Dutch, with hints and mid-conversation switching; model name to check (`flux-general-multi` per one source) |

`HearingLanguage` is a closed set (`auto, en, nl, de, fr, es, it, pt`, `packages/protocol/src/assistants.ts:76`), so
Japanese or Polish cannot be pinned today, only reached through `auto`.

Language identification, cheapest first: (1) the **two buttons** on screen, which set the language before speaking
and need no detection; (2) text-level identification of the transcript restricted to the two languages (a small
library such as `franc-min` or `eld` **[unverified: accuracy on 3-word utterances]**); (3) sherpa-onnx
[`SpokenLanguageIdentification`](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/spoken_language_identification.html)
with a Whisper encoder on the audio, which returns a code such as `en`, at the cost of another model in memory.
Recommendation: buttons on screen devices, transcript ID restricted to the pair everywhere, audio ID only if the
measurement shows transcript ID failing.

### 5.3 The interpreter turn

`utterance → language of it (A or B) → translate to the other → speak in the other language's voice → show both`.
No tools, no history beyond the last three exchanges (for pronouns and context), a fixed instruction ("translate
only; never answer; keep names; keep register"). With the model engine this is one short completion; on the Claude
subscription path it pays the harness's turn cost, so a plain API or home-model account is recommended for the
interpreter assistant.

### 5.4 Camera text

The browser takes one still frame with `getUserMedia` (https only, which serve mode needs for the mic anyway), on a
tap, never as a stream. The server sends it to a vision-capable model with "list the lines of text, then translate
them". Local OCR (`tesseract.js`, PaddleOCR) is an alternative for printed text; menus and handwriting go better
through the model **[unverified: comparison]**. This needs the core gap named in
[images-and-photos §15](images-and-photos.md#15-open-questions): image input to the model.

## 6. Data

| Collection | Scope | Schema |
|---|---|---|
| `phrases` | person (household when no person) | `{ text, translation, language, topic?, romanised?, createdAt, practisedAt? }` |
| `interpreterSessions` | conversation | `{ languages, names, utterances: [{ lang, said, translated, ms }] }`, deleted at conversation end unless the owner keeps it |
| `glossary` | household | `{ term, language, fixed }` (names that must not be translated: "Jev", the dog's name) |

In the [Module store](../module-investigation/shared-state-jobs-and-notifications.md). [learning.md](learning.md)
reads `phrases` to build flashcards.

## 7. Long-running work and events

No scheduled jobs. The interpreter is a conversation-scoped mode: it ends on "stop interpreting", on New
conversation, after the assistant's `newConversationAfter` quiet spell, or at a restart (conversations are in memory,
current-system §4.3). Emits `translation.mode.changed { deviceId, on, languages }` on the
[Event bus](../module-investigation/shared-state-jobs-and-notifications.md) so the screen layout and the route gate
follow it.

## 8. Presentation

- **Interpreter** on a screen: a split stage (a new layout proposal next to those in
  [presentation §4.1](../module-investigation/presentation-and-device-capabilities.md#41-layouts-host-level-every-character)):
  each half shows its language's name, a big tap-to-speak button, and the last two lines in that language. The top
  half can be rotated 180° for a tablet lying flat between two people. The character sits small on the dividing line;
  its `listening` mode shows which side it is hearing (a direction hint would be a new extension; old characters
  ignore it, [CHARACTERS.md](../../CHARACTERS.md) §5.2).
- **Subtitles**: today's per-device `captions` setting gains an optional `translateTo`; the caption line shows the
  original small and the translation large.
- **Camera text**: a `list` of `original → translation` lines beside the captured `image`.
- **Phrasebook**: a `list` with a play button per phrase.
- **Without a screen**: interpreter mode works by voice alone with transcript language ID; every translation is
  prefixed by nothing (a short earcon per direction is better than "she says").

## 9. Notifications and proactive behaviour

None. The interpreter never speaks unprompted; it speaks only translations of what it heard.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | languages the household speaks (`HOME_LANGUAGE` plus extra); the glossary | `HOME_LANGUAGE` |
| Module | engine (`model`, `deepl`, `home-model`); DeepL key (vault); language ID method; keep interpreter transcripts | model; transcript ID; off |
| Assistant | an "Interpreter" assistant from the template; its voice map per language (core change, §12) | — |
| Device | interpreter allowed; tablet-flat layout; `captions.translateTo`; camera text allowed | on; off; off; off |
| Person | own languages and level ("Anna reads English, speaks little") | — |

First run: create the Interpreter assistant from the template, pick a voice per language from the voice catalogue,
choose a multilingual recogniser for the device where it will be used, optionally paste a DeepL key.

## 11. Native tools and dependencies

| Dependency | Where | When missing |
|---|---|---|
| A multilingual recogniser (`parakeet-ultra`, `whisper-turbo` or Deepgram Flux Multilingual) | server | "This device only understands English. Switch it to the multilingual speech model in Settings?" |
| A voice per language | server (Piper/Kokoro) or hosted (Cartesia, ElevenLabs) | Local voices exist for en, nl, de, fr, es, it, pt (Piper) and zh (Kokoro). For any other language: "I don't have a Japanese voice here, so I'll show it and spell it out." |
| DeepL key | vault | Falls back to the model, silently |
| TranslateGemma on the home model server | LAN | Falls back to the model |
| Camera and https | screen device | "This device has no camera" / "The camera needs the secure address." |

## 12. Interaction with the rest of the system

- **Two core changes.** (a) *A voice per language*: the assistant's `voice` is one `provider:voiceId`; a reply needs a
  language tag (set by the interpreter path, or by the model for mixed replies) and the assistant a
  `voices: Record<lang, VoiceRef>` with `voice` as the default. The same change serves [learning](learning.md) and the
  game master's character voices in [tabletop-and-games](tabletop-and-games.md). (b) *The detected language* reported
  by the recogniser with each final transcript.
- **Turn detection per language.** Hearing timing (`finalSilenceMs`) is per hearer, not per language. A learner of the
  other language pauses longer mid-sentence; interpreter mode should raise `finalSilenceMs` by about 300 ms for its
  duration **[proposal; measure]**.
- **Route gate.** While the mode is on, the device's `withoutPhrase` is the Interpreter assistant and the follow-up
  window is open; "stop interpreting" and the controls of [assistant-controls](assistant-controls.md) still win.
- **Interruption.** The other person starting to talk during playback is normal here: barge-in stops the playback and
  the new utterance is translated. The echo gate must not drop speech in the language being played.
- **Names.** The glossary and `names` keep "Jev" and people's names untranslated.
- **Template.** "Interpreter": no modules, the fixed instruction, a voice map, wake phrase "be our interpreter".

## 13. Privacy and safety

- Interpreter transcripts contain a guest's words: not kept by default, never in the inbox or memory.
- Hosted engines (DeepL, the API model) receive every utterance; the admin page says so per engine. DeepL's free tier
  may keep text for improvement **[unverified: current terms]**.
- The camera is used only on a tap, one frame, never stored beyond the turn unless saved; the `camera` capability
  stays off until the owner allows it per device ([presentation §5.2](../module-investigation/presentation-and-device-capabilities.md#52-vocabulary-proposal)).
- Translation is not certified: for medicine, police or contracts the assistant says it may be wrong.

## 14. Foundations needed

- [Tool context](../module-investigation/shared-state-jobs-and-notifications.md) (which device), [Presentation](../module-investigation/presentation-and-device-capabilities.md)
  (split layout, `list`, `image`), [Device capabilities](../module-investigation/presentation-and-device-capabilities.md)
  (camera, display), [Module store](../module-investigation/shared-state-jobs-and-notifications.md) (phrasebook),
  assistant templates in the [Module manifest](../module-investigation/module-definition-config-and-dependencies.md).
- **First version without them:** an "Interpreter" assistant with a fixed prompt and `parakeet-ultra` already works
  for a Dutch–English pair in one voice that speaks both badly. Adding the voice map is the first real step.

## 15. Open questions

1. **Which pairs matter?** Dutch–English only (local engines suffice), or also languages of visitors outside the
   recogniser's 25 European ones (Whisper's latency or Deepgram's cloud)?
2. **Interpreter engine**: model, DeepL, or TranslateGemma on the home model server? Decide after a `TurnTrace`
   comparison.
3. **Voice per language in core**: accept the `voices` map on assistants (also wanted by learning and tabletop)?
4. **Disagreement with [core-tools §5.6](core-tools.md#56-translation)**: it treats translation as "no tool, model
   only". That holds for one-offs; interpreter mode, subtitles and camera text need a module and core changes.
5. **Camera at all?** Is a device camera acceptable in the house, even tap-only?
6. **Keep interpreter transcripts** for the owner to read later, or always discard?
