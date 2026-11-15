# Voice providers and the voice picker

Design written 2026-11-16 at the owner's request. It changes four things:

1. **Voice engines become voice providers.** A *provider* is where speech is made: **on this machine** (`sherpa`:
   Piper and Kokoro), **Cartesia** or **ElevenLabs**. The settings page that was "Voice engines" is now
   **Voice providers**; it is where a provider is configured (its API key). Everything a person reads says
   "voice provider", never "voice engine".
2. **A voice is one concrete voice of one provider.** `(provider, provider voice id)`, e.g. `sherpa` +
   `en_US-lessac-medium`, or `elevenlabs` + `EXAVITQu4vr4xnSDxMaL`. The three named voices (`standard`, `natural`,
   `expressive`) are gone as a concept.
3. **The model no longer picks a voice.** The assistant speaks every reply with one selected voice. The
   `[voice:NAME]` markers, the voice router, the voice block in the system prompt and the `VOICES` setting are
   removed. How the voice sounds is decided by the text sent to it, nothing else.
4. **A voice picker.** Every provider lists its voices; any voice can be previewed with a piece of text; local
   voices can be downloaded (with progress, cancellable); favourite voices are kept on the server.

The web UI is built from §5 (the HTTP contract) alone. §6 is the settings and migration; §7 the server internals;
the status of each part is at the end.

## 1. Decisions

| Topic | Decision |
|---|---|
| Provider ids | `sherpa` (label "On this machine"), `cartesia` ("Cartesia"), `elevenlabs` ("ElevenLabs"). They are the old `TTS_PROVIDER` values, so stored values and logs stay readable. A person never sees the id. |
| What a voice is | A **voice reference** `{ provider, voiceId }`, written as the string key `provider:voiceId` where one string is needed (a setting, a URL path, a favourite). `voiceId` is the provider's own id: a preset name for `sherpa`, a voice UUID for Cartesia, a voice id for ElevenLabs. It is `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. |
| Which voice is used | One selection today: **the assistant's voice**, setting `ASSISTANT_VOICE` (a voice key). The reference type and the selection are separate on purpose (§7.1): later each agent gets its own selection (`AGENT_<ID>_VOICE`, falling back to the assistant's) without changing the provider machinery. Agents are not wired into the app yet, so this design builds only the assistant's. |
| Applying a new voice | Changing the voice rebuilds the engines (an engine reload, as for any provider setting). The picker's save can ask for that reload at once (`reload: true`, §5.8). Running turns end interrupted; every device keeps its conversation. |
| Per-device voice | Retired. A device profile's `voice` field stays in the protocol for compatibility, but only `""` ("the assistant's voice") is effective; any other value falls back to `""` (it already did for a voice that was not enabled). The UI should stop offering a per-device voice. |
| Listing voices | Each provider implements `TtsVoices.list` (§7.2). Hosted providers call their voices API; the local provider lists the presets of `@pva/tts-sherpa`, each installed or not. |
| Search | **In the browser**, over the full lists from one `GET /api/voices` (§4). |
| Hosted list caching | In memory on the server, 6 hours per provider and key, refreshed on demand (§4.2). |
| Preview | `POST /api/voices/preview` with a voice and up to **300** characters; the answer is a WAV file. Hosted previews use the provider's one-shot HTTP synthesis, never the live WebSocket. Local previews are refused while any device is in a turn, and cancelled if one starts (§4.3). |
| Downloads | Local voices download through the existing jobs (`tool: "tts-models"`): the same job the Models page shows, the same `job` WebSocket message, cancellable. |
| Favourites | A file of the data directory, `data/voice-favourites.json`, the same for every device, at most 200. |
| Auth | Every endpoint of §5 is admin only: `Authorization: Bearer <admin token>` (the token from `admin.login`). |

## 2. What is removed

- `packages/core`: `VoiceRouter.ts` (`makeVoiceRouter`, `voicePrompt`, `Voice`, `VoiceSegmentStats`) and
  `VoiceMarkers.ts` (`[voice:NAME]` parsing and stripping). The clause chunker no longer knows about markers; the echo
  gate compares the clause text as sent. `Trace.voices` stays: it now holds the one voice that spoke the turn (its key),
  so the latency line still says `voices: sherpa:en_US-lessac-medium`. `makeResampler` stays (it is used elsewhere).
- `apps/assistant/src/voices.ts`: `voiceCatalog`, `VOICES`, `DEFAULT_VOICE`, `VOICE_<NAME>_*` lookup,
  `withVoicePrompt`, `voiceRouter`, `voiceStages`. Replaced by `voiceSelection.ts` (§6, §7.1).
- Serve mode: the per-session voice router and the voice block of every turn's system prompt.
- Settings: the fields `DEFAULT_VOICE`, `VOICES` and `TTS_PROVIDER` leave the settings screen. Their saved and `.env`
  values are still **read** once, to migrate (§6.2).
- `say --voice NAME` becomes `say --voice provider:voiceId`.

The text sent to a voice is the reply as the model wrote it. A model that still writes `[voice:...]` (an old
conversation, a custom system prompt) has that text spoken; the default system prompt never asked for markers, only
the removed voice block did.

## 3. Providers

| Provider | Where | Needs | Voices it lists | Preview through |
|---|---|---|---|---|
| `sherpa` | this machine | nothing (models are downloaded) | the presets of `@pva/tts-sherpa` (62 voices, §3.1), installed or not | a local engine (§4.3) |
| `cartesia` | hosted | `CARTESIA_API_KEY` | `GET https://api.cartesia.ai/voices` (header `Cartesia-Version: 2026-08-14`, `Authorization: Bearer <key>`; pages of 100 by `starting_after`) | `POST /tts/bytes`, raw `pcm_s16le` 24 kHz, model `CARTESIA_MODEL`, `language` as below |
| `elevenlabs` | hosted | `ELEVENLABS_API_KEY` | `GET https://api.elevenlabs.io/v2/voices` (header `xi-api-key`; pages of 100 by `next_page_token`): the account's voice library, premade voices included | `POST /v1/text-to-speech/{voice_id}?output_format=pcm_24000`, model `ELEVENLABS_MODEL` |

**Cartesia language.** Speech and previews are requested in the chosen voice's own language, not a fixed one. Precedence:
`CARTESIA_LANGUAGE` if set (used as written; an explicit override), else the voice's language from Cartesia
(`GET /voices/{id}`, converted to the bare code Cartesia's speech API takes: `en_US` / `en-GB` → `en`), else `en` (voice
unknown, Cartesia unreachable, no usable language: never an error). Live speech looks it up once when the engine is built
(bounded to 3 s), never during a turn; a preview looks it up when it is made. No latency effect has been measured.

The REST base address follows the provider's WebSocket address setting (`CARTESIA_URL`, `ELEVENLABS_URL`: `wss://` →
`https://`, `ws://` → `http://`), so a gateway or a test server serves both. Provider-specific HTTP lives only in the
adapter package (`packages/tts-cartesia`, `packages/tts-elevenlabs`).

### 3.1 Voices on this machine

Added 2026-11-16. The local provider lists **62 voices**: 26 Piper voices, each its own download, and 36 Kokoro voices
that share one download. The voice keys of earlier versions (`sherpa:en_US-lessac-medium`, `sherpa:nl_NL-pim-medium`,
`sherpa:kokoro-af_heart`) are unchanged, so a saved `ASSISTANT_VOICE` or favourite still works. The table is
`packages/tts-sherpa/src/Presets.ts`.

**Kokoro** (`kokoro-multi-lang-v1_0`, 350 MB download, 403 MB on disk): the 28 American and British English speakers
and the 8 Mandarin Chinese speakers of the archive, as `kokoro-<speaker>` (`kokoro-af_bella`, `kokoro-bm_george`, …). Their speaker ids come from the
`speaker2id` metadata of this archive's `model.onnx`, read from the copy downloaded on this machine on 2026-11-13
(the release asset was last updated 2026-10-26, before that, and is 349886476 bytes). The upstream README of the archive says ids 0–52 are
stable. Gender comes from the speaker name (`af`/`bf` female, `am`/`bm` male, as in upstream Kokoro's VOICES.md), and
the description shows upstream's quality grade (Heart A, Bella A-, Nicole and Emma B-, down to Adam F+). British
speakers use the archive's British lexicon (`lexicon-gb-en.txt`), American ones the American lexicon.

**Chinese** (`kokoro-zf_xiaobei`, `zf_xiaoni`, `zf_xiaoxiao`, `zf_xiaoyi` female; `zm_yunjian`, `zm_yunxi`,
`zm_yunxia`, `zm_yunyang` male; ids 45–52; language `zh-CN`; upstream grade D for all eight). Their own engine set-up
(`engineConfig`): the lexicons `lexicon-us-en.txt,lexicon-zh.txt` (English first, as in sherpa-onnx's documentation) and
the rule FSTs `date-zh.fst,phone-zh.fst,number-zh.fst`. They need no other file: every Kokoro preset lists all three
lexicons and the three FSTs, so the install state stays shared. Gender is upstream's; measured median pitch agrees for
seven (female 235–316 Hz, male 127–183 Hz), and Yunxia (male upstream) measured 316 Hz: its upstream counterpart is a
young voice, so it is kept as male, as upstream says.

Checked on the real model, 2026-11-16 (each line one synthesis; "OOV" = the engine's "OOV word skipped" lines):

- `今天北京的天气很好，有一点微风。` with each of the 8 speakers: 3.0–4.2 s of audio, 0 OOV, none silent.
- Chinese with digits and Latin words, `我明天下午3点在Starbucks见你，带上你的iPhone 15，电话是13812345678，日期2026年11月16日。`
  (Xiaoxiao, Yunxi): 8–9 s, 2 OOV: `Starbucks` and `iPhone` are skipped (not in the English lexicon). Digits, the phone
  number and the date are read (by the rule FSTs, in Chinese). Without the FSTs the same sentence lost all 6 numbers
  (8 OOV), which is why the Chinese set-up has them.
- Common English words in Chinese, `我们下午开个meeting，然后一起去coffee shop。` and `请打开 Wi-Fi 和 Bluetooth，然后用 Google 搜索 OK。`:
  0 OOV; the English words are read through the English lexicon.
- An English sentence to a Chinese voice (the language model may answer in English): `The weather in Amsterdam is mild
  today, with a light breeze.` gave 3.6 s, 0 OOV (Xiaoxiao, Yunxi), about the length Heart gives (3.5 s). So it is
  read, by a Chinese speaker's voice; how natural that accent sounds was not judged (no one listened). An English
  sentence with digits (`… at 3 pm on November 16, call 555 1234.`) also gave 0 OOV on a Chinese voice: the numbers go
  through the Chinese FSTs, so they are most likely read as Chinese numbers. Not confirmed by listening.
- For comparison (not changed here): an English voice (Heart) skips digits (`3`, `16`, `555`, `1234`: 4 OOV) and the
  same brand names. That holds for every English Kokoro voice, Heart included, since before this change.

Left out: the archive's Spanish, French, Hindi, Italian, Japanese and Brazilian Portuguese speakers (ids 28–44, 53).
Kokoro runs on sherpa-onnx 2.x, which no longer uses espeak-ng (`dataDir` and `lang` are ignored) and only speaks
words that are in the lexicons it is given. Tried on this machine: for Spanish, French, Italian, Portuguese, Hindi and
Japanese text the engine logs "OOV word skipped" for nearly every word, and the result is wrong or silence.

**Piper** (each 68 MB download, 83 MB on disk, unless noted; 22050 Hz, or 16000 Hz for a "low" voice):

| Language | Voices (key) |
|---|---|
| English (US) | Lessac `en_US-lessac-medium` (f), Amy `en_US-amy-medium` (f), Kristin `en_US-kristin-medium` (f), Ryan `en_US-ryan-medium` (m), John `en_US-john-medium` (m), Joe `en_US-joe-medium` (m) |
| English (GB) | Alba `en_GB-alba-medium` (f), Cori `en_GB-cori-medium` (f), Jenny `en_GB-jenny_dioco-medium` (f), Alan `en_GB-alan-medium` (m), Northern English `en_GB-northern_english_male-medium` (m) |
| Dutch | Pim `nl_NL-pim-medium` (m), Ronnie `nl_NL-ronnie-medium` (m), Alex `nl_NL-alex-medium` (m), Nathalie `nl_BE-nathalie-medium` (Flemish), Rdh `nl_BE-rdh-medium` (Flemish, m) |
| German | Thorsten `de_DE-thorsten-medium` (m), Kerstin `de_DE-kerstin-low` (16 kHz) |
| French | Siwis `fr_FR-siwis-medium` (f), Gilles `fr_FR-gilles-low` (m, 16 kHz) |
| Spanish | Davefx `es_ES-davefx-medium` (m), Daniela `es_AR-daniela-high` (116 MB, 134 MB on disk) |
| Italian | Paola `it_IT-paola-medium` (f) |
| Portuguese | Cadu `pt_BR-cadu-medium` (m), Faber `pt_BR-faber-medium`, Tugão `pt_PT-tugao-medium` |

How they were chosen: single-speaker voices of the sherpa-onnx `tts-models` release (multi-speaker models such as
`vctk` and `libritts` are left out: only speaker 0 would be reachable). Medium quality where there is one, a few per
language, more for English and Dutch, and both voices where a language had a female and a male one. Each was
downloaded from its release URL and run through the Piper engine of this project (sherpa-onnx-node 1.13.8) with a
sentence in its own language: all load, speak at the sample rate in the table, and give a plausible duration. Sizes
are the release's `Content-Length` and the unpacked folder. Piper voices phonemise with the `espeak-ng-data` in their
own archive, with the language from the model's config, so non-English Piper voices are spoken in their own language.

Gender is given only where it is known: from the model card or dataset (Kristin, John, Cori, Alba, Siwis, Ryan's
RyanSpeech, Thorsten), or else from the measured median pitch of the sample when it is clear (below 140 Hz male,
above 185 Hz female). Nathalie, Kerstin, Daniela, Faber and Tugão are between those values and nothing documents their
gender, so their entries have none (`gender` is optional). Nobody has listened to them: the machine has no sound card.
Left out after trying them: `fr_FR-tom-medium` (44.1 kHz, very quiet output), `es_MX-ald-medium`,
`it_IT-riccardo-x_low` and `pt_BR-jeff-medium` (no documented gender and an ambiguous pitch, with a better voice of the
language already listed).

Licences vary per voice (each preset's `license`, shown on the Models page): several datasets are CC0 or public
domain, `ryan` and `lessac` allow non-commercial use only, others are CC BY or CC BY-SA.

**Cost of a longer list.** The list is metadata: listing reads no model and starts no engine. Only the voice the
assistant speaks with is loaded (one engine, as before), and a preview starts at most one extra engine (§4.3).
Measured with the 54 presets against the real model folder: listing takes 0.4 ms (median of 200; worst 2.6 ms), and
importing the package plus listing started no child process. With 62 (the Chinese voices; every Kokoro preset now
checks 11 files): 0.8 ms median, 9.3 ms worst of 200, on a machine with a load average above 20. This was not a turn, so there is no TurnTrace number:
the list is not on a turn's path.

**Status of a provider** (`ProviderInfo.status`):

- `ready`: usable. For a hosted provider: the key is set and the last voice list succeeded (or none was tried yet).
- `needs_key`: a hosted provider without a key. `reason: "missing"`, or `reason: "vault_locked"` when the key vault is
  locked (the key may be in it). Never an error, and never breaks the other providers.
- `error`: the key is set but the provider refused it or could not be reached; `message` says why in one sentence
  (never the key, never a raw upstream body).

The local provider is always `ready`.

## 4. Behaviour

### 4.1 Voice entries

One entry per voice, from whichever provider:

- `voice` (the reference), `key` (`provider:voiceId`), `name`; `description` when the provider gives one.
- `language` (BCP 47 as the provider gives it: `en`, `en-US`, `nl-NL`), `gender` (`female` | `male` | `neutral`),
  `tags` (strings: ElevenLabs labels such as accent, age, use case, its category; Cartesia `pro`, `yours`; local
  `fast`, `natural`, `slow-start`). Absent when the provider does not say.
- Local voices only: `local: { state: "installed" | "not_installed" | "downloading", sizeMb, diskMb, job? }`; while
  downloading, `job` is the running download (`JobInfo`, `packages/protocol/src/jobs.ts`).
- `previewable`: false for a local voice that is not installed, and for every voice of a provider that is not `ready`.
- `selected` (it is the assistant's voice) and `favourite`.

Several local presets share one archive: the 36 Kokoro voices (§3.1). They are installed together (they need the same
files), they download as one job (§4.4), and while it runs every one of their entries is `downloading` with that same
`job`, so every Kokoro row of the picker shows the progress. Deleting the archive (Models page) removes all of them; it
is refused while any of them is the assistant's voice. Their `sizeMb` is the archive's (350), the same on every entry.

### 4.2 Lists, search and staleness

`GET /api/voices` returns every provider's list in one answer. The UI searches **client-side** over it:

- The lists are small: 62 local voices, an ElevenLabs library of a few dozen to a few hundred voices, Cartesia's
  library of some hundreds. The server keeps at most **1000** voices per provider (`truncated: true` beyond that). A
  substring match over a few thousand short records takes well under a frame in a browser, so typing needs no round
  trip, and the search works across providers whose APIs search differently (Cartesia `q`, ElevenLabs `search`) or
  not at all (local).
- A server query would cost one provider call per keystroke per provider and make the result depend on two different
  search engines. Not done.
- Suggested matching (UI's choice): case- and accent-insensitive substring over `name`, `description`, `language`,
  `tags` and the provider label, all words must match.

Caching: a hosted list is fetched on first need and kept in memory for **6 hours**, keyed by provider and a hash of
its key (a new key is a new cache entry; the key itself is never stored there). Every list carries `fetchedAt` and
`stale` (older than 6 hours). Rules:

- A list older than 6 hours is refetched on the next request; the request waits for it (up to 15 s per provider; the
  providers are fetched in parallel).
- `?refresh=1` refetches now (the picker's "Refresh" button), whatever the age.
- A refetch that fails keeps the previous list: it is returned with `stale: true` and `error`, and the provider's
  status is `error`. Without a previous list the provider's `voices` is empty.
- A voice added at the provider meanwhile appears after a refresh or after 6 hours. A voice deleted there stays listed
  until then; previewing or selecting it then fails with `unknown_voice` (404).
- The local list is computed on every request (a disk check of the 62 presets: 0.8 ms measured, §3.1).

The cache is dropped when the server restarts. Opening the picker for the first time after a start therefore waits for
the hosted calls; nothing is prefetched at start (no network call is made for a provider nobody looks at).

### 4.3 Preview

`POST /api/voices/preview` with `{ voice, text }` answers `audio/wav` (PCM, 16-bit, mono, the voice's own rate:
Piper 22050 Hz, Kokoro and hosted 24000 Hz), playable directly by `new Audio(URL.createObjectURL(blob))`.

Limits: `text` is trimmed and must be 1–**300** characters (`MAX_PREVIEW_CHARS`); the audio is cut at **30 s**; a
preview gives up after **20 s** (`preview_timeout`). One preview runs at a time on the server: a new preview request
cancels the running one, which is answered `409 superseded` (the UI ignores that answer; it asked for something
newer). The last **20** previews are cached in memory by voice and text, so playing the same sample again is free
(a hosted preview costs characters of the owner's plan).

Hosted previews use the provider's one-shot HTTP synthesis (§3): they never touch the live WebSocket that devices
speak through, so they cannot delay or break a live turn.

Local previews and live sessions share the CPU: there is a real tension. The safe choices:

1. **Refused while any device is in a turn** (its state is `hearing`, `thinking` or `speaking`): `409 busy`, with
   `retryAfterMs: 1000`. The UI says "The assistant is talking; try again in a moment".
2. **Cancelled when a turn starts** during a preview (the server checks every 50 ms): the request is answered
   `409 busy` and the preview engine stops what it does.
3. **No second copy of a loaded model**: previewing the voice the assistant speaks with uses the running engine.
   That engine works one clause at a time, so a turn that starts during such a preview waits for at most the one
   preview clause in synthesis (the preview is cut into clauses by the clause chunker for this reason). This delay
   was not measured; it is bounded by one clause's synthesis time.
4. Previewing any other local voice starts a **separate engine process** for it (the only way to hear a voice that
   is not loaded). It is kept for 60 s for further previews of the same voice, then closed; previewing another voice
   replaces it, so at most one extra engine exists. Cancelling kills that process at once. A Kokoro preview engine
   takes about 400 MB of memory while it lives and a few seconds to start (its model loads first).
   The kept engine also speaks the other Kokoro voices **of its engine set-up** (the same lexicon: American, British
   or Chinese) with their own speaker id, per clause (`SherpaTts.makeShared`; the engine host takes an optional `sid`
   on each `speak`). So moving the preview from Heart to Bella, Michael, … loads nothing; moving it to a British or
   Chinese voice, or to a Piper voice, replaces the engine as before. The assistant's running engine is never given
   another speaker: live turns send no `sid` and are synthesised as before; a Kokoro voice other than the assistant's
   one still gets the kept preview engine (one model load the first time).
   Measured 2026-11-16 by a script through the adapter (not a turn, so no TurnTrace), 5 runs each, interleaved, while
   the machine's load average was 22–35 on 16 cores (absolute numbers inflated): from asking to the first audio of a
   two-sentence preview, a new engine for the voice took 1913–2022 ms (median 1933), the loaded engine with the
   voice's speaker id 203–442 ms (median 311); the whole preview through the loaded engine 768–1202 ms (median 914).
   Checked on the real model that the speaker id is applied and does not stick: Michael through Heart's engine
   measured 114 Hz median pitch, Heart right after it 211 Hz (Heart before it: 207 Hz); Yunjian through Xiaoxiao's
   engine 114 Hz.

A local voice that is not installed cannot be previewed (`409 not_installed`); download it first.

### 4.4 Downloads

`POST /api/voices/download` starts a download job for a local voice (`tool: "tts-models"`, `target` = the preset
name; for a voice of a shared archive, the archive's **owner**, the first of its presets in the table: every Kokoro
voice downloads as `target: "kokoro-af_heart"`, label "Kokoro v1.0 (36 voices)"). Downloading or cancelling through any
Kokoro voice acts on that one job; starting a second Kokoro voice while it runs is `409 busy` ("… is already being
downloaded"). It is the same mechanism as the Models page: disk check, `.part` file, unpack, cancel removes partial files, one
job per target, at most two jobs at once. Progress is observed either way:

- the WebSocket the admin page already holds receives `job` messages (throttled to 4 per second), or
- `GET /api/jobs/{id}` (poll at most once a second).

When the job succeeds, the voice's `local.state` becomes `installed` on the next list (the page refetches
`/api/voices?provider=sherpa`, or updates the entry itself from the `job` message), and `models` / `section.changed`
messages go out as for any model download.

### 4.5 Favourites

Server-side, the same on every device and every admin page. Stored as `data/voice-favourites.json` (written atomically,
mode 0600, only by the serving process, which holds the data directory's writer lock):

```json
{ "version": 1, "favourites": [ { "voice": { "provider": "sherpa", "voiceId": "kokoro-af_heart" }, "name": "Heart", "addedAt": 1794931200000 } ] }
```

`name` is the name when it was added, so a favourite of a provider that is unreachable (or has no key) can still be
shown. Order is the order added. At most **200**. A favourite whose voice disappeared at the provider is kept (the UI
shows it as unavailable); removing it is the owner's choice. A file that cannot be read is logged, moved aside as
`voice-favourites.json.bad-<time>` and replaced by an empty list at the next change. Other open pages learn about a
change when they next load favourites (no push message).

## 5. HTTP contract

Base path `/api/`, on the same origin and port as the UI. JSON in and out (`Content-Type: application/json`), except
the preview's audio answer.

### 5.0 Common rules

- **Auth**: every endpoint needs `Authorization: Bearer <token>`, the admin session token from `admin.login` (the one
  the page keeps in `sessionStorage`). Each accepted request counts as an admin action (restarts the 30 min idle
  limit). Missing, invalid or expired token: `401 admin_required`. Admin disabled (`PVA_ADMIN_PASSWORD` unset):
  `401 admin_required` with a message saying so.
- **Host check**: as for every request (`SERVE_ALLOWED_HOSTS`): another host name gets `403` plain text.
- **Origin**: a request carrying an `Origin` that is not the server's own (or one of `SERVE_ALLOWED_ORIGINS`) is
  refused `403 forbidden_origin`. A request from one of `SERVE_ALLOWED_ORIGINS` (the UI on `next dev`, port 3000, which
  also opens the socket from there) gets CORS headers for that origin alone (`Access-Control-Allow-Origin: <origin>`,
  `Vary: Origin`, `Access-Control-Expose-Headers: X-Voice-Sample-Rate, X-Preview-Cache`), and its preflight
  (`OPTIONS`, before the token is checked) is answered `204` with the methods `GET, POST, PUT, DELETE` and the headers
  `Authorization, Content-Type`. The page's own origin gets no CORS headers. (Added 2026-11-16 with the web UI: without
  it the picker could not reach the API under `pnpm dev`.)
- **Bodies**: at most 4 KB; another content type than JSON on `POST`/`PUT`: `415 unsupported_media_type`; malformed
  JSON or a body that does not match: `400 invalid_request` with `fieldErrors` where a field is to blame.
- **Method**: a known path with another method: `405 method_not_allowed` (the message names the methods).
- **Unknown path** under `/api/`: `404 not_found`.
- Responses carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. API keys are never in any answer or
  log; upstream messages are redacted by the adapters before they reach an answer.

**Error body** (every non-2xx JSON answer):

```json
{ "error": { "code": "needs_key", "message": "There is no ElevenLabs key: add it on the Voice providers page.", "retryAfterMs": 1000, "fieldErrors": [ { "key": "text", "message": "At most 300 characters" } ] } }
```

`retryAfterMs` and `fieldErrors` are present only where noted. Codes:

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | malformed JSON, wrong shape, a voice key or id that is not well formed, text empty or too long (`fieldErrors`) |
| 401 | `admin_required` | no valid admin token |
| 403 | `forbidden_origin` | foreign `Origin` |
| 404 | `not_found` | unknown path, unknown job, unknown favourite |
| 404 | `unknown_provider` | a provider id that does not exist |
| 404 | `unknown_voice` | the provider does not have that voice (local: not a known preset; hosted: not in its list, or the provider said so) |
| 405 | `method_not_allowed` | |
| 409 | `needs_key` | the voice's provider has no key (or the vault is locked: message says so) |
| 409 | `not_installed` | a local voice that is not downloaded (preview, select) |
| 409 | `already_installed` | download of an installed voice |
| 409 | `busy` | a local preview while a device is in a turn (`retryAfterMs`); a download that is already running, or two jobs already running |
| 409 | `superseded` | a newer preview replaced this one |
| 409 | `locked` | the default voice is set in the environment (`.env` / process): it cannot be changed here |
| 409 | `limit_reached` | 200 favourites already |
| 413 | `too_large` | body over 4 KB |
| 415 | `unsupported_media_type` | |
| 502 | `provider_error` | the provider refused (bad key: message says so) or answered nonsense; `retryAfterMs` when it rate-limited us |
| 504 | `preview_timeout` | no audio within 20 s |
| 500 | `internal` | anything else (logged on the server) |

Shapes are given as TypeScript; Effect Schemas of the same shapes are exported from `@pva/protocol`
(`packages/protocol/src/voices.ts`), so the UI can decode answers.

```ts
type ProviderId = "sherpa" | "cartesia" | "elevenlabs"   // ProviderInfo.id; new providers may be added
interface VoiceRef { provider: string; voiceId: string }
type VoiceKey = string                                      // `${provider}:${voiceId}`
```

### 5.1 `GET /api/voice-providers`

The providers and their status, for the Voice providers page and the picker's provider filter. Hosted statuses use the
cached voice lists (§4.2); this call fetches a list only when none was fetched for the current key yet.

```ts
interface ProviderInfo {
  id: string
  label: string                         // "On this machine", "Cartesia", "ElevenLabs"
  location: "local" | "hosted"
  status: "ready" | "needs_key" | "error"
  reason?: "missing" | "vault_locked"   // with needs_key
  message?: string                      // with needs_key and error: one sentence for people
  keyField?: string                     // the settings field of its key: "CARTESIA_API_KEY"
  settingsPath: string                  // the settings page that configures it: "voices/providers"
  implication?: string                  // "Replies are sent to ElevenLabs to be spoken."
  voiceCount?: number                   // when a list is known
  inUse: boolean                        // the assistant's voice is one of its voices
}
// 200
{ providers: ProviderInfo[] }
```

Example:

```json
{ "providers": [
  { "id": "sherpa", "label": "On this machine", "location": "local", "status": "ready", "settingsPath": "voices/providers", "voiceCount": 3, "inUse": true },
  { "id": "cartesia", "label": "Cartesia", "location": "hosted", "status": "needs_key", "reason": "missing", "message": "Add a Cartesia API key to use its voices.", "keyField": "CARTESIA_API_KEY", "settingsPath": "voices/providers", "implication": "Replies are sent to Cartesia to be spoken.", "inUse": false },
  { "id": "elevenlabs", "label": "ElevenLabs", "location": "hosted", "status": "error", "message": "ElevenLabs refused the API key (401): check it on the Voice providers page.", "keyField": "ELEVENLABS_API_KEY", "settingsPath": "voices/providers", "implication": "Replies are sent to ElevenLabs to be spoken.", "inUse": false }
] }
```

Errors: 401.

### 5.2 `GET /api/voices[?provider=<id>][&refresh=1]`

Every provider's voices (or one provider's), for the picker.

```ts
interface VoiceEntry {
  voice: VoiceRef
  key: VoiceKey
  name: string
  description?: string
  language?: string
  gender?: "female" | "male" | "neutral"
  tags: string[]
  local?: {
    state: "installed" | "not_installed" | "downloading"
    sizeMb: number                    // download size, MB (10^6 bytes)
    diskMb: number                    // unpacked
    job?: JobInfo                     // while downloading
  }
  previewable: boolean
  selected: boolean
  favourite: boolean
}
interface ProviderVoices {
  provider: ProviderInfo
  voices: VoiceEntry[]                // empty when not ready and nothing cached
  fetchedAt?: number                  // epoch ms of the list (hosted)
  stale: boolean
  truncated: boolean
  error?: { code: string; message: string }   // the last fetch failed (the voices, if any, are older)
}
// 200
{ providers: ProviderVoices[]; selected: VoiceKey }
```

A provider that needs a key is listed with `voices: []` and its status; it never makes the whole call fail. While a
hosted provider's last fetch failed (`error` set), its older voices are still listed, with `previewable: false`.

Example (shortened):

```json
{ "selected": "sherpa:en_US-lessac-medium",
  "providers": [
    { "provider": { "id": "sherpa", "label": "On this machine", "location": "local", "status": "ready", "settingsPath": "voices/providers", "voiceCount": 3, "inUse": true },
      "stale": false, "truncated": false,
      "voices": [
        { "voice": { "provider": "sherpa", "voiceId": "en_US-lessac-medium" }, "key": "sherpa:en_US-lessac-medium", "name": "Lessac", "description": "Piper: fast, clear American English.", "language": "en-US", "gender": "female", "tags": ["fast"], "local": { "state": "installed", "sizeMb": 68, "diskMb": 83 }, "previewable": true, "selected": true, "favourite": false },
        { "voice": { "provider": "sherpa", "voiceId": "kokoro-af_heart" }, "key": "sherpa:kokoro-af_heart", "name": "Heart", "description": "Kokoro: warm and natural; its first audio comes later.", "language": "en-US", "gender": "female", "tags": ["natural", "slow-start"], "local": { "state": "downloading", "sizeMb": 350, "diskMb": 403, "job": { "id": "job-3", "tool": "tts-models", "action": "download", "target": "kokoro-af_heart", "label": "Kokoro kokoro-af_heart", "state": "running", "phase": "download", "progress": { "done": 41000000, "total": 350000000, "unit": "bytes" }, "log": [], "startedAt": 1794931200000 } }, "previewable": false, "selected": false, "favourite": true }
      ] },
    { "provider": { "id": "elevenlabs", "label": "ElevenLabs", "location": "hosted", "status": "ready", "keyField": "ELEVENLABS_API_KEY", "settingsPath": "voices/providers", "voiceCount": 1, "inUse": false },
      "fetchedAt": 1794931100000, "stale": false, "truncated": false,
      "voices": [
        { "voice": { "provider": "elevenlabs", "voiceId": "EXAVITQu4vr4xnSDxMaL" }, "key": "elevenlabs:EXAVITQu4vr4xnSDxMaL", "name": "Sarah", "description": "Young adult woman with a confident and warm, mature quality.", "language": "en", "gender": "female", "tags": ["american", "young", "premade"], "previewable": true, "selected": false, "favourite": false }
      ] }
  ] }
```

Errors: 401; 404 `unknown_provider` for `?provider=` with an unknown id.

### 5.3 `POST /api/voices/preview`

```ts
// request
{ voice: VoiceRef; text: string }     // text: 1–300 characters after trimming
// 200: body is audio/wav. Headers:
//   Content-Type: audio/wav
//   X-Voice-Sample-Rate: 24000
//   X-Preview-Cache: hit | miss
```

Example request: `{ "voice": { "provider": "cartesia", "voiceId": "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" }, "text": "Good morning. It is eight degrees and dry." }`

Errors: 400 (`fieldErrors` on `text` or `voice`), 401, 404 `unknown_provider` / `unknown_voice`, 409 `needs_key`,
`not_installed`, `busy` (`retryAfterMs`), `superseded`; 502 `provider_error` (`retryAfterMs` on a rate limit); 504
`preview_timeout`.

### 5.4 `POST /api/voices/download`

```ts
// request
{ voice: VoiceRef }                   // provider must be "sherpa"
// 202
{ job: JobInfo }
```

Errors: 400 (a hosted voice: "Only voices on this machine are downloaded"), 401, 404 `unknown_voice`, 409
`already_installed`, `busy` (already downloading: the body's message says so; two jobs already running).

### 5.5 `POST /api/voices/download/cancel`

```ts
// request
{ voice: VoiceRef }
// 200
{ cancelled: true; job: JobInfo }      // the job as it is now (its final `cancelled` state follows on `job` / GET)
```

Errors: 400, 401, 404 `not_found` (no download of that voice is running).

### 5.6 `GET /api/jobs/{id}`

```ts
// 200
{ job: JobInfo }
```

Errors: 401, 404 `not_found` (unknown id; finished jobs are kept for the last 10).

### 5.7 Favourites

`GET /api/voices/favourites`

```ts
interface Favourite { voice: VoiceRef; key: VoiceKey; name: string; addedAt: number }
// 200
{ favourites: Favourite[] }
```

`PUT /api/voices/favourites/{key}` — add (idempotent: an existing favourite is answered as is, its name updated when
given). `{key}` is the voice key, URL-encoded (`sherpa%3Akokoro-af_heart`).

```ts
// request (optional body; without it the name is taken from the provider's list, else the voice id)
{ name?: string }                      // 1–100 characters
// 200
{ favourite: Favourite; favourites: Favourite[] }
```

`DELETE /api/voices/favourites/{key}`

```ts
// 200
{ favourites: Favourite[] }
```

Errors: 400 (malformed key or name), 401, 404 `unknown_provider`; on `DELETE` 404 `not_found` when it was not a
favourite; on `PUT` 409 `limit_reached`. Adding does not check that the voice exists (a favourite of a provider
without a key can be added from its old entry).

### 5.8 The assistant's voice

`GET /api/voices/default`

```ts
interface DefaultVoice {
  voice: VoiceRef
  key: VoiceKey
  name?: string                       // from the provider's list when known
  source: "saved" | "environment" | "migrated" | "default"
  locked: boolean                     // set in the environment: cannot be changed here
  running?: VoiceKey                  // the voice the running engines speak with (absent while they are not running)
  reloadPending: boolean              // saved differs from running: a reload applies it
  notes: string[]                     // migration notes (§6.2), for the owner
}
// 200
{ default: DefaultVoice }
```

`PUT /api/voices/default`

```ts
// request
{ voice: VoiceRef; reload?: boolean }   // reload: rebuild the engines now (default false)
// 200
{ default: DefaultVoice; reload?: { ok: true } | { ok: false; code: string; message: string } }
```

The voice is checked first: the provider exists; a local voice is a known preset and installed; a hosted provider has
a key and, when its list is known, the voice is in it. It is then saved as `ASSISTANT_VOICE` through the settings
store (a new revision; `section.changed` for the Voices section goes to admin pages, `engine` shows the reload
pending). With `reload: true` the engines are rebuilt before the answer; a reload that fails is reported in `reload`
and the voice stays saved (the engine status says why).

Errors: 400, 401, 404 `unknown_provider` / `unknown_voice`, 409 `needs_key`, `not_installed`, `locked`; 502
`provider_error` (a hosted list that could not be fetched to check the voice).

## 6. Settings

### 6.1 Pages

- **Voices › Voices** (section `voices`, page `voices/overview`): one field, `ASSISTANT_VOICE` ("Assistant voice", a
  text field holding a voice key, `apply: reload`). The UI replaces this field with the picker (it may keep the
  generic text field for a locked or unusual value). Checks: a hosted voice whose provider has no key is a warning
  ("… speaks through ElevenLabs, but there is no ElevenLabs key: add it on the Voice providers page."); a local voice
  that is not downloaded refuses the save (as a recogniser model does).
- **Voices › Voice providers** (section `voice-providers`, page `voices/providers`, protected; was `voice-engines`,
  `voices/engines`): `CARTESIA_API_KEY`, `ELEVENLABS_API_KEY` (secrets, `apply: reload`). `TTS_PROVIDER` is no longer
  a field: the provider follows from the voice.
- **Voices › Models** lists one item per archive: each Piper voice, and one "Kokoro v1.0 (36 voices)" item (target
  `kokoro-af_heart`) for all Kokoro voices; it is in use while any Kokoro voice is the assistant's. Downloads started
  from either page are the same job.

### 6.2 Migration (existing installs)

The assistant's voice is resolved at every engine build, from the effective settings (environment > saved):

1. `ASSISTANT_VOICE` set: that voice (`source: "saved"` or `"environment"`). A value that is not a well-formed key, or
   names an unknown provider, fails the voice stage with a message naming `ASSISTANT_VOICE` (the setting is validated
   on save, so this only happens from `.env`).
2. Otherwise the old settings decide (`source: "migrated"`), exactly as they chose the old default voice:
   - The old default voice name: `DEFAULT_VOICE` (lower case), else `standard`. A name that is not `standard`,
     `natural` or `expressive` becomes `standard`, with a note.
   - Its provider: `VOICE_<NAME>_PROVIDER`, else the old voice's own provider (`natural` → `sherpa`,
     `expressive` → `cartesia`), else `TTS_PROVIDER`, else `sherpa`.
   - Its voice id, for that provider:
     - `sherpa`: `VOICE_<NAME>_TTS_SHERPA_PRESET`, else the old voice's own preset (`natural` → `kokoro-af_heart`),
       else `TTS_SHERPA_PRESET`, else `en_US-lessac-medium`;
     - `cartesia`: `VOICE_<NAME>_CARTESIA_VOICE`, else `CARTESIA_VOICE`, else the adapter's default (Skylar,
       `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4`);
     - `elevenlabs`: `VOICE_<NAME>_ELEVENLABS_VOICE`, else `ELEVENLABS_VOICE`, else the adapter's default (Sarah,
       `EXAVITQu4vr4xnSDxMaL`).
3. Nothing set at all: `sherpa:en_US-lessac-medium` (`source: "default"`).

Also:

- `VOICES` is ignored; when it names more than the default voice, a note says the other voices are no longer used.
- Other `VOICE_<NAME>_*` overrides (a per-voice model or speed) are no longer read: provider-wide settings
  (`CARTESIA_MODEL`, `ELEVENLABS_SPEED`, `TTS_SHERPA_SPEED`, …) apply to every voice of that provider. A note lists the
  ones found.
- The old keys stay where they are (in `.env` or `settings.json`) and are never rewritten; once `ASSISTANT_VOICE` is
  saved they are ignored. Notes are logged once per build and returned in `GET /api/voices/default`.
- A migrated hosted voice whose key is missing fails the voice stage at start, as the old voice did ("CARTESIA_API_KEY
  is not set"); the settings stay editable and choosing another voice fixes it.
- With `ASSISTANT_VOICE` set, the provider's own voice setting (`TTS_SHERPA_PRESET`, `CARTESIA_VOICE`,
  `ELEVENLABS_VOICE`) is overridden for the voice being built.
- Device profiles with a voice name keep it stored; it falls back to the assistant's voice (§1).

The CLI modes (`voice`, `text`, `say`, `bench --live`) resolve the voice the same way.

## 7. Server internals

### 7.1 Voice reference and selection (`packages/core/src/VoiceRef.ts`, `apps/assistant/src/voiceSelection.ts`)

```ts
// core: a small reusable value type
interface VoiceRef { readonly provider: string; readonly voiceId: string }
voiceKey(ref): string                    // "provider:voiceId"
parseVoiceKey(key): VoiceRef | undefined // split at the first ":", both parts well formed
sameVoice(a, b): boolean
```

Selection is a separate concern: `voiceSelection.ts` answers "which voice does X use" (`resolveAssistantVoice`, the
migration of §6.2) and builds a `Tts` for a reference (`ttsLayerFor(ref)`: the provider's layer from `ttsProviders`
with the provider's voice setting set to `voiceId`). A per-agent voice later is one more resolver
(`AGENT_<ID>_VOICE`, else the assistant's) and one more `Tts` per distinct voice in the engine build; providers,
previews and the picker do not change.

### 7.2 `TtsVoices` (core) and the adapters

```ts
// packages/core/src/Services.ts
TtsVoices: {
  readonly list: Effect<VoiceList, VoiceCatalogError>            // the provider's voices
  readonly preview: (voiceId: string, text: string) => Effect<PreviewAudio, VoiceCatalogError>
}
VoiceList    = { voices: ReadonlyArray<VoiceDescription>; truncated: boolean }
VoiceDescription = { id; name; description?; language?; gender?: "female" | "male" | "neutral"; tags: ReadonlyArray<string>;
                     local?: { installed: boolean; sizeMb: number; diskMb: number } }
PreviewAudio = { sampleRate: number; pcm: Uint8Array }           // s16le mono
VoiceCatalogError: { reason: "unauthorized" | "rate_limited" | "unknown_voice" | "not_installed" | "unavailable" | "invalid"; message; retryAfterMs? }
```

Interrupting either effect cancels the work (the HTTP request is aborted; a local preview engine is stopped). Errors
are built through each adapter's `redact.ts`, so no key or raw upstream body is in a message.

- `@pva/tts-cartesia`: `makeVoices(options)` / `voicesConfig` (REST, `fetch`).
- `@pva/tts-elevenlabs`: `makeVoices(options)` / `voicesConfig` (REST, `fetch`).
- `@pva/tts-sherpa`: `makeVoices({ modelDir, engineFor? })`: lists the presets with their install state; `preview`
  synthesises through `engineFor(preset)` (default: a temporary engine for the call). Serve mode passes its own
  `engineFor` (the running engine for the live voice, else the one kept preview engine; §4.3).

`apps/assistant/src/providers.ts` lists the providers once (`ttsProviderInfo`: label, location, key field, voice
setting, implication) next to `ttsProviders`. Adding a provider = an adapter with `layerConfig` and `makeVoices`, and
one entry in each map.

### 7.3 Serve mode (`apps/assistant/src/serve/`)

- `VoiceCatalog.ts`: the providers' `TtsVoices`, the list cache (§4.2), statuses, entries, the preview slot (one at a
  time, supersede, cache, busy rule, the kept preview engine).
- `AssistantVoice.ts`: reads (`GET /api/voices/default`) and saves (`PUT`) the assistant's voice through the settings
  store.
- `Favourites.ts`: the favourites file.
- `api.ts`: the routes of §5, mounted by `http.ts` under `/api/` before the static files (`HttpOptions.api`).
- `Engine.ts`: one `Tts` per build, for the assistant's voice (`EngineProviders.tts`, `.voice`); `EngineStatus.voices`
  has that one voice (`name` = its key, `description` = its name).
- `SessionConversation.ts`: speaks with the build's `Tts`; no router. The system prompt has no voice block.

## 8. The web UI

Built 2026-11-16 from §5 (`apps/web`). What changed there:

- **The voice picker** (`src/components/voices/VoicePicker.tsx`): a compact button (the provider's mark and the
  voice's name) that opens a popover anchored to it (closes on Esc with focus back on the button, on a press outside
  and when focus leaves; placed under the button, above it when there is more room there, always on screen). Three
  columns: a rail (Favourites, then one mark per provider, a dot on a provider that needs a key or has a problem), a
  search over a list of voices, and the preview text (editable, Reset). Searching looks across every provider at once
  (results under provider headers, every word must match, case and accents aside, over name, description, language,
  gender, tags and provider label); Favourites is one flat list, voices of a provider together. A row selects; its
  speaker previews the preview text without selecting (a stop button while it plays; another preview replaces it;
  closing the popup stops it); its star adds or removes a favourite (shown on hover or focus, always when on, and
  always on touch screens); a voice on this machine that is not downloaded shows a download button instead of the
  speaker (the row downloads too), then a progress bar with the percentage and Cancel. A provider that needs a key, or
  whose keys are locked, shows an explanation and a link to its settings page instead of its list; one whose key was
  refused shows the message above its older voices. Keyboard: the rail is one Tab stop (arrows move and choose), ↓
  from the search goes into the list, ↑/↓/Home/End move between rows, only the active row's speaker and star are in
  the Tab order, Enter selects.
- **Phone width** (below 640 px): the popover becomes a bottom sheet (full width, at most 85 % of the height, a Close
  button); the rail becomes a horizontal row of tabs over the search; the preview text folds away under the list
  ("Preview text", closed by default) with the status line always shown; rows and buttons are 40–44 px.
- **Provider marks** are letter marks drawn for this UI (`src/ui/voiceProviderMarks.ts`: `PC`, `Ca`, `EL`, colours
  from the theme tokens). A real icon can be given per provider there (`icon`); a provider without an entry gets the
  first two letters of its label.
- **Data** (`src/lib/voiceCatalog.ts`): one catalog per client, so every picker on a page shares one copy of the lists,
  the favourites and the one preview. It calls the API on the socket's server (`ws://host:port/ws` →
  `http://host:port/api/`) with the admin token from `sessionStorage`, follows download progress through the `job`
  messages the admin socket already gets, re-reads the local list when a voice-model job ends or the models change,
  and everything when the vault or a Voices section changes. It also re-reads the local list when a voice-model job
  starts, so all the voices of a shared archive (Kokoro) show the progress at once, not only the row that was pressed. `409 superseded` is ignored; `409 busy` says "The
  assistant is talking; try again in a moment". The pure parts (search, favourites order, the words under a voice) are
  in `src/lib/voicePicker.ts`.
- **Where it is used**: Voices › Voices, in place of the `ASSISTANT_VOICE` text field (a field renderer by key,
  `fieldRenderersByKey` in `src/ui/fieldRenderers.ts`). A choice is a draft like any field: the page's Save sends
  `settings.update` (the server's warnings and "Save anyway" apply), and the reload bar applies it; nothing reloads by
  itself, so `PUT /api/voices/default` is not used by the page. An empty value is shown as the voice it resolves to
  (`GET /api/voices/default`) with "default"; migration notes are listed under it. A value set by the environment keeps
  the generic locked row; a value that is not a voice key keeps the text field. The component takes only a voice key,
  `onChange`, `disabled` and `locked`, so a per-agent voice can use it as it is.
- **Removed**: the voice choice of the voice sheet and of admin's device form (the `voice` profile field is left out of
  the forms, `RETIRED_PROFILE_FIELDS`; a stored value is kept and not counted as an own setting); the voice name next
  to a reply in the chat (the model no longer picks one); `speakingVoice` / `defaultVoiceOf`. The Overview lists the
  one running voice by its name, the checklist says it too. Voice engines → Voice providers in the mock, deep links and
  tests.
- **Mock** (`apps/web/mock/server.ts`, `mock/voices.ts`): the API of §5 with CORS for the page's origin: three providers
  (On this machine: Lessac and Heart downloaded, Alba and Pim not; Cartesia without a key; ElevenLabs with one),
  favourites that include a Cartesia voice, downloads as the Models page's jobs, previews as WAV tones (one at a time,
  `superseded`, `busy` during a turn), `ASSISTANT_VOICE` with the server's checks. `POST /mock/voices/fail
  {"provider"}` makes a provider's key refused, `/mock/voices/hold {"ms"}` delays previews.

## Status

| Part | State |
|---|---|
| This design | Written 2026-11-16. |
| Core (`VoiceRef`, `TtsVoices`, removal of router and markers) | Done 2026-11-16. |
| Adapters (`makeVoices` in tts-sherpa, tts-cartesia, tts-elevenlabs; tests against local mock servers) | Done 2026-11-16. |
| Selection and migration (`voiceSelection.ts`, CLI modes, engine build) | Done 2026-11-16. |
| HTTP API, catalog, favourites, settings pages | Done 2026-11-16. |
| Web UI (picker, Voice providers page, favourites, preview player) | Done 2026-11-16 (§8): `pnpm check`, `pnpm test` and the web Playwright suite against the mock pass; screenshots `apps/web/screenshots/admin-*-voice-picker-*.png`. Not tried against the real server in a browser, nor on real phones. |
| Chinese Kokoro voices (§3.1) and preview engine reuse across Kokoro voices of one set-up (§4.3 item 4) | Done 2026-11-16: tests in `packages/tts-sherpa/test/presets.test.ts`, `SherpaTts.test.ts`, `models.test.ts` (real model, Chinese set-up included; run once here against the real models), `apps/assistant/test/serveVoices.test.ts`. |
| More local voices (§3.1: 26 Piper, 28 Kokoro sharing one archive) | Done 2026-11-16: table, shared-archive download and install state, Models page item, web re-read on job start, tests in `packages/tts-sherpa/test/presets.test.ts`, `apps/assistant/test/serveVoices.test.ts`, `serveModels.test.ts`, `apps/web/test/voicePicker.test.ts`. The mock still lists four local voices (the e2e tests pin them). |

Measurements (2026-11-16, `pnpm start bench`, offline: scripted turns through the real `Conversation` with simulated
provider delays, `BENCH_ROUNDS=5`, 20 turns per scenario, one run before this change at 1b4b4b3 and one after). End of
turn → playback start, median / worst:

| Scenario | Before (with the voice router) | After (one voice, no router) |
|---|---|---|
| orchestration overhead (all delays 0) | 1.2 / 6.6 ms | 0.7 / 1.6 ms |
| realistic, eager end-of-turn off | 509 / 736 ms | 508 / 735 ms |
| realistic, eager end-of-turn on | 306 / 537 ms | 307 / 535 ms |
| realistic, eager off, wake phrase | 509 / 736 ms | 508 / 737 ms |
| realistic, eager on, wake phrase | 307 / 535 ms | 307 / 535 ms |

So with simulated providers the change is within a millisecond of the old numbers; the overhead row is one run each and
its worst case is noise-prone. The real engines (`bench --live`) were not measured, and neither was the delay a local
preview of the assistant's own voice can add to a turn that starts during it (§4.3, item 3).
