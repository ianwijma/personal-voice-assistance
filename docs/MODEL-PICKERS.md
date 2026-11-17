# Model pickers: language models and speech recognition models

Design written 2026-11-16 at the owner's request; the server half and the web half are built (status at the end).

The voice picker (docs/VOICE-PROVIDERS.md §8) becomes the way to choose the other two models of an assistant:

1. **Language model** (assistant › Language model tab, also the creation wizard): one picker whose providers are the
   accounts (Anthropic API, Claude subscription, OpenRouter, Home model, Offline stand-in) and whose rows are their
   models. Choosing a row sets `llm.account` and `llm.model` together. An account that is not set up shows a link to
   Shared settings › Language model accounts instead of a list. Effort, thinking, limits and the subscription block
   stay below the picker, as today.
2. **Speech recognition model** (assistant › Hearing tab): one picker with the providers "On this machine" (the
   stt-sherpa presets: languages, measured memory, download with progress in the row) and Deepgram (needs its key →
   link). No preview.

Nothing in the assistant's data model changes (docs/ASSISTANTS.md §2.2): the pickers only write `llm.account`,
`llm.model`, `hearing.engine` and `hearing.model`, through `assistant.save` as the fields do now. Nothing here runs on a
turn's path: lists are fetched when an admin opens a picker.

## 1. Decisions

| Topic | Decision |
|---|---|
| One contract for three pickers | `/api/models/{kind}` with `kind` = `llm` or `stt` mirrors `/api/voices` field for field where the meaning is the same (§4.7), so one generic picker component serves all three. Voices keep their own endpoints (they are built and used). |
| What a model is | A **model reference** `{ provider, modelId }`, key `provider:modelId` split at the **first** `:` (model ids contain `:` and `/`: `openrouter:openai/gpt-oss-20b:free`, `home-model:llama3.1:8b`). `provider` is `[a-z][a-z0-9-]{0,31}`; `modelId` is 1–100 characters (the bound of `llm.model`), no control characters, no white space at either end. |
| Providers | `llm`: `anthropic`, `claude-subscription`, `openrouter`, `home-model`, `offline` (the `LlmAccountId`s, in the order of today's cards). `stt`: `sherpa` ("On this machine"), `deepgram` (the `hearing.engine` values). |
| What choosing sets | Every row carries `apply`: the part of the assistant it sets (`{ llm: { account, model } }` or `{ hearing: { engine, model? } }`). The page writes exactly that into its draft. The offline row sets `model: ""`; the Deepgram row sets the engine only (Deepgram's model is the shared `DEEPGRAM_MODEL`, §3). |
| Where lists come from | Through the adapter packages only (§3). Provider HTTP and SDK calls stay in `llm-anthropic`, `llm-openai-compatible`, `agent-claude-code`. |
| Caching | In memory, per provider and per hash of key + address: Anthropic 6 h, OpenRouter 1 h, Home model 5 min; `?refresh=1` refetches; a failed fetch is not repeated for 30 s unless refreshed. Recogniser lists, the subscription's and the offline row are computed per request (no network). |
| Time limit | 10 s per provider list (`LIST_TIMEOUT_MS`); providers are fetched in parallel, so one slow or failing provider never holds up or breaks the others. |
| Typed models | A provider whose ids are open (`anthropic`, `claude-subscription`, `openrouter`, `home-model`) says `customModel` (placeholder, help): the picker offers a "Use a model by name" row. It is the only way when a list cannot be fetched (a home server without `/v1/models`, any account while offline). |
| Favourites | Per kind, on the server: `data/model-favourites-llm.json`, `data/model-favourites-stt.json`, the same rules as voice favourites (at most 200, atomic, 0600, kept when the model disappears). |
| Downloads | Recogniser presets download through the existing jobs (`tool: "stt-models"`), the same job the Models page shows; progress through the `job` WebSocket message or `GET /api/jobs/{id}`. |
| Auth | Admin only, as `/api/voices`: `Authorization: Bearer <admin token>`. |

## 2. States

**Provider** (`ModelProviderInfo.status`):

| Status | When | Models listed |
|---|---|---|
| `ready` | usable | its list |
| `needs_key` | Anthropic, OpenRouter or Deepgram without a key (`reason: "missing"`), or with the vault locked (`reason: "vault_locked"`) | none: the picker shows `message` and a link to `settingsPath` |
| `needs_address` | the home model without a server address | none (link) |
| `needs_setup` | the Claude subscription while its module does not run (off, not opted in, not logged in, starting) | none (link) |
| `error` | set up, but its list could not be fetched (refused key, unreachable, time limit, no `/v1/models`, a refused address) | the older list (`stale: true`), else for Anthropic the models the code knows (`listSource: "known"`), else none; plus the typed model |

"Not installed" is a **row** state, not a provider state: `local.state` is `installed`, `not_installed` or
`downloading` (with the running `job`), exactly as `VoiceEntry.local`. "On this machine" and the offline stand-in are
always `ready`.

**Row extras** besides the voice entry's fields: `badges` (short facts shown under the name and searched: context
size, price, languages, memory, download size, "Deprecated", "Recommended", "Not recommended", "Not in the list"),
`apply`, `selectable` (false only for a local preset that is not downloaded: an assistant save refuses it), `listed`
(false for a model an assistant uses that the provider's list lacks: typed earlier, or gone; such rows are added at
the end of their provider so the picker's button can name the current model and the owner sees it is unusual).

## 3. Where each list comes from

| Provider | Source (adapter) | Fallback | Cache | Typed model |
|---|---|---|---|---|
| `anthropic` | `GET /v1/models` through the SDK (`client.models.list`, pages of 100, at most 1000; `llm-anthropic` `listModels`, `modelSource`). Kept: `id`, `display_name`, `max_input_tokens`, `max_tokens`, `lifecycle` (retired dropped, deprecated marked), `created_at`. No price (the API has none). | `knownModels`: the three models the code already names (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`), only when the call failed and nothing is cached. No key: `needs_key` (the owner's rule: link, not list). | 6 h | yes |
| `claude-subscription` | The running module's `settingOptions().model`: the models Claude Code reports at start (`initializationResult().models`: `value`, `displayName`, `description`), now read through the new `ModuleHost.settingOptions(id)`. | `MODELS` of `agent-claude-code` (the same three names) when the running module gives none. Not running: `needs_setup`. | none (in memory in the module) | yes ("Any model name Claude Code accepts") |
| `openrouter` | `GET {OPENROUTER_BASE_URL or https://openrouter.ai/api/v1}/models` through `llm-openai-compatible` `accountModelSource` → `listModels`, filtered by the profile as before (only models that take tools and whose reasoning can be turned down). Kept now as well: `context_length`, `pricing.prompt` / `pricing.completion` (dollars per token → per million), `description` (300 characters). | none (older list if any) | 1 h | yes |
| `home-model` | `GET {HOME_MODEL_BASE_URL}/v1/models` (the `/v1` added as for the account), same adapter, with the optional key. | none: a server without `/v1/models` (404) is `error` and the typed model is the way | 5 min | yes |
| `offline` | one fixed row, `offline:stand-in` | — | — | no |
| `sherpa` | the stt-sherpa preset table (label, description, measured `ramMb` and `loadMs`, sizes) with the Models page's install state (`models.list()`) and running jobs | — | per request (no network) | no |
| `deepgram` | one row: the shared `DEEPGRAM_MODEL` (default `flux-general-en`). Deepgram's model is a shared setting, not an assistant's, so there is nothing else to choose. | — | per request | no |

Languages of the presets (badge and `stt.languages`) come from the presets' own descriptions (and, for Nemotron, the
English and Dutch tests of `SherpaStt.test.ts`); they are a table in `ModelCatalog.ts` (`PRESET_LANGUAGES`), with a test
that every preset has an entry.

Keys never leave the server: the cache is keyed by a SHA-256 prefix of account, address and key; every message comes
from the adapters' redacted errors (`redact.ts`); a refused key gets fixed text.

## 4. HTTP contract

Base path `/api/`. The common rules are docs/VOICE-PROVIDERS.md §5.0 unchanged: admin token, host check, same origin
or one of `SERVE_ALLOWED_ORIGINS` (CORS for it), JSON bodies of at most 4 KB, `405` with the allowed methods, `404
not_found` for an unknown path, `Cache-Control: no-store`, the error body `{ error: { code, message, retryAfterMs?,
fieldErrors? } }`. New codes: `404 unknown_kind` (a kind other than `llm`, `stt`), `404 unknown_model` (a recogniser
preset that does not exist). Effect Schemas of every shape are exported from `@pva/protocol`
(`packages/protocol/src/modelPickers.ts`), with `modelKey` and `parseModelKey`.

### 4.1 Shapes

```ts
type PickerKind = "llm" | "stt"
interface ModelRef { provider: string; modelId: string }        // key: `${provider}:${modelId}`

interface ModelProviderInfo {
  id: string; label: string; location: "local" | "hosted"
  status: "ready" | "needs_key" | "needs_address" | "needs_setup" | "error"
  reason?: "missing" | "vault_locked"                           // with needs_key
  message?: string                                              // every status but ready: one sentence
  keyField?: string                                             // "OPENROUTER_API_KEY"
  settingsPath: string                                          // "shared/accounts" | "shared/speech"
  settingsLabel: string                                         // "Shared settings › Language model accounts"
  implication?: string                                          // "What you say is sent to OpenRouter and the model's provider."
  modelCount?: number
  listSource?: "provider" | "known" | "built-in"
  customModel?: { placeholder: string; help: string }           // a model may be typed
  inUse: boolean                                                // an assistant uses this provider
}
interface ModelBadge { kind: "context" | "price" | "languages" | "memory" | "size" | "tag"; label: string; title?: string }
interface ModelEntry {
  model: ModelRef; key: string; name: string; description?: string
  badges: ModelBadge[]
  tags: string[]                                                // more search words (the id, language codes)
  apply: { llm: { account: LlmAccountId; model: string } } | { hearing: { engine: "sherpa" | "deepgram"; model?: string } }
  llm?: { contextTokens?: number; maxOutputTokens?: number; pricing?: { inputPerMTok: number; outputPerMTok: number }; deprecated?: boolean; releasedAt?: number }
  stt?: { languages: string[]; languagesLabel: string; takesLanguage: boolean; liveWords: boolean; recommended: boolean }
  local?: { state: "installed" | "not_installed" | "downloading"; sizeMb: number; diskMb: number; ramMb?: number; loadMs?: number; job?: JobInfo }
  listed: boolean; selectable: boolean
  usedBy: string[]                                              // assistant ids
  favourite: boolean
}
interface ProviderModels {
  provider: ModelProviderInfo
  models: ModelEntry[]
  fetchedAt?: number; stale: boolean; truncated: boolean
  error?: { code: "unauthorized" | "timeout" | "provider_error"; message: string }   // the last fetch failed
}
interface ModelFavourite { model: ModelRef; key: string; name: string; addedAt: number }
```

### 4.2 `GET /api/models/{kind}[?provider=<id>][&refresh=1]`

Every provider of the kind (or one), each with its models. A provider that is not set up or failed never makes the
call fail. `200 { kind, providers: ProviderModels[] }`. Errors: 401, 404 `unknown_kind`, `unknown_provider`.

```json
{ "kind": "llm", "providers": [
  { "provider": { "id": "openrouter", "label": "OpenRouter", "location": "hosted", "status": "ready", "keyField": "OPENROUTER_API_KEY", "settingsPath": "shared/accounts", "settingsLabel": "Shared settings › Language model accounts", "implication": "What you say is sent to OpenRouter and the model's provider.", "modelCount": 2, "listSource": "provider", "customModel": { "placeholder": "provider/model", "help": "An OpenRouter model id, such as those on openrouter.ai/models. Only models that take tools are listed." }, "inUse": false },
    "fetchedAt": 1794931100000, "stale": false, "truncated": false,
    "models": [
      { "model": { "provider": "openrouter", "modelId": "openai/gpt-oss-20b" }, "key": "openrouter:openai/gpt-oss-20b", "name": "OpenAI: gpt-oss-20b", "description": "An open-weight model.", "badges": [ { "kind": "context", "label": "131k context", "title": "131,072 tokens of context" }, { "kind": "price", "label": "$0.04 / $0.15 per M", "title": "US$ per million tokens: 0.04 in, 0.15 out" } ], "tags": ["openai/gpt-oss-20b", "reasoning"], "apply": { "llm": { "account": "openrouter", "model": "openai/gpt-oss-20b" } }, "llm": { "contextTokens": 131072, "pricing": { "inputPerMTok": 0.04, "outputPerMTok": 0.15 } }, "listed": true, "selectable": true, "usedBy": [], "favourite": true }
    ] },
  { "provider": { "id": "home-model", "label": "Home model", "location": "local", "status": "error", "message": "Home model at http://192.168.1.20:11434/v1 answered 404 to the model list: not found", "keyField": "HOME_MODEL_API_KEY", "settingsPath": "shared/accounts", "settingsLabel": "Shared settings › Language model accounts", "customModel": { "placeholder": "llama3.1:8b", "help": "The model's name as your server knows it (Ollama: ollama list)." }, "inUse": true },
    "stale": false, "truncated": false, "error": { "code": "provider_error", "message": "Home model at http://192.168.1.20:11434/v1 answered 404 to the model list: not found" },
    "models": [ { "model": { "provider": "home-model", "modelId": "qwen3-14b" }, "key": "home-model:qwen3-14b", "name": "qwen3-14b", "badges": [ { "kind": "tag", "label": "Not in the list" } ], "tags": ["qwen3-14b"], "apply": { "llm": { "account": "home-model", "model": "qwen3-14b" } }, "llm": {}, "listed": false, "selectable": true, "usedBy": ["keuken"], "favourite": false } ] }
] }
```

A recogniser row (shortened):

```json
{ "model": { "provider": "sherpa", "modelId": "whisper-turbo" }, "key": "sherpa:whisper-turbo", "name": "Whisper turbo", "description": "Most robust for Dutch in noise …", "badges": [ { "kind": "languages", "label": "99 languages" }, { "kind": "memory", "label": "1.6 GB memory" }, { "kind": "size", "label": "565 MB download" } ], "apply": { "hearing": { "engine": "sherpa", "model": "whisper-turbo" } }, "stt": { "languages": ["en", "nl", "de", "fr", "es", "it", "pt"], "languagesLabel": "99 languages", "takesLanguage": true, "liveWords": false, "recommended": false }, "local": { "state": "downloading", "sizeMb": 565, "diskMb": 1039, "ramMb": 1640, "loadMs": 2621, "job": { "id": "job-3", "tool": "stt-models", "target": "whisper-turbo", "state": "running", "progress": { "done": 41000000, "total": 565000000, "unit": "bytes" } } }, "listed": true, "selectable": false, "usedBy": [], "favourite": false }
```

Lists are not paged: the largest is OpenRouter's (a few hundred models that take tools); at most 1000 per provider
(`truncated`). Search is in the browser, as for voices.

### 4.3 `GET /api/models/{kind}/providers`

The providers alone, for a status dot or a summary. **Never fetches** (the status of a list comes from the last fetch).
`200 { kind, providers: ModelProviderInfo[] }`.

### 4.4 Favourites

`GET /api/models/{kind}/favourites` → `{ favourites: ModelFavourite[] }`.
`PUT /api/models/{kind}/favourites/{key}` (`{key}` = `encodeURIComponent(modelKey)`; the `/` of an id must be encoded),
optional body `{ name?: string }` (1–100) → `{ favourite, favourites }`; idempotent, a name renames; without one the
name is taken from the list (fetched once if there is none), else the id. `DELETE …/{key}` → `{ favourites }`.
Errors: 400 (malformed key or name), 401, 404 `unknown_provider` (of that kind), `not_found` (DELETE of a non-favourite),
409 `limit_reached` (200). A favourite of a provider without a key can be added. Files and rules: §1.

### 4.5 Downloads (recogniser models only)

`POST /api/models/stt/download` `{ model: ModelRef }` → `202 { job }`; `POST /api/models/stt/download/cancel`
`{ model }` → `200 { cancelled: true, job }`. The provider must be `sherpa` (else 400); an unknown preset is 404
`unknown_model`; 409 `already_installed`, `busy` (already downloading, or two jobs running). The job is the Models
page's (`tool: "stt-models"`, `target` = the preset), so either page shows it. `GET /api/jobs/{id}` as for voices.
On `llm` these paths answer 404.

### 4.6 Errors of a provider list

A provider list's failure is never an HTTP error: the call answers 200 and that provider has `status: "error"`,
`message` and `error.code`: `unauthorized` (key refused: fixed text, never the upstream body), `timeout`, or
`provider_error` (unreachable, an HTTP error, not JSON, an unknown shape, a refused address).

### 4.7 Voices and models side by side

| Voices (`/api/voices…`) | Models (`/api/models/{kind}…`) |
|---|---|
| `GET voice-providers` → `{ providers: ProviderInfo[] }` | `GET models/{kind}/providers` → `{ kind, providers: ModelProviderInfo[] }` |
| `GET voices?provider&refresh` → `{ providers: ProviderVoices[], selected }` | `GET models/{kind}?provider&refresh` → `{ kind, providers: ProviderModels[] }` (no `selected`: the page holds the value) |
| `ProviderVoices.voices: VoiceEntry[]` | `ProviderModels.models: ModelEntry[]` |
| `VoiceEntry.voice` / `voiceId` | `ModelEntry.model` / `modelId` |
| `language`, `gender`, `tags` | `badges`, `tags` |
| `previewable` | — (no preview) |
| — | `apply`, `selectable`, `listed`, `llm`, `stt`, provider `customModel`, `settingsLabel`, `listSource` |
| `status: ready / needs_key / error` | adds `needs_address`, `needs_setup` |
| `voices/download`, `/cancel` `{ voice }` | `models/stt/download`, `/cancel` `{ model }` |
| `voices/favourites[/{key}]` | `models/{kind}/favourites[/{key}]` |

## 5. Server internals

- `packages/llm-anthropic/src/models.ts`: `listModels`, `modelSource` (from `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`),
  `knownModels`, `AnthropicModelListError` (redacted).
- `packages/llm-openai-compatible/src/account.ts`: `accountModelSource(account)` (the shared settings only, no model
  needed); `profiles.ts`: `ModelInfo` gains `contextTokens`, `pricing`, `description` (OpenRouter).
- `packages/agent-claude-code/src/session.ts`: the login's models keep Claude Code's `description`.
- `packages/core/src/ModuleHost.ts`: `settingOptions(id)`, the running main instance's `settingOptions()` (`undefined`
  when it does not run, has none, or throws).
- `apps/assistant/src/serve/ModelCatalog.ts`: the catalog of both kinds, states, cache, time limit, entries.
- `apps/assistant/src/serve/ModelFavourites.ts`: the per-kind favourites files.
- `apps/assistant/src/serve/api.ts`: the routes (`/api/models/…`), mounted with the voice routes.
- `serveMode.ts`: wiring (`ServeOptions.modelListTimeoutMs`, `modelCatalogNow` for tests).

## 6. For the web half (design; built, see the end)

### 6.1 What in `VoicePicker` is voice-specific

Everything else in `components/voices/VoicePicker.tsx` is generic and should move into a shared component: the trigger
button (mark + name + "default" + lock/chevron), the popover placement and the phone bottom sheet, the rail
(Favourites, then a mark per provider with a dot for trouble), the search (fold, every word, across providers, results
under provider headers), the favourites list, rows with a star, the download button / progress bar / Cancel for local
rows, the "not set up" panel with the settings link, the error message above older rows, and the keyboard model.

Voice-specific, to stay in a voice adapter:

- the **preview**: the third column `PreviewSide` (preview text, Reset, status line, the phone's folded "Preview
  text"), `DEFAULT_PREVIEW_TEXT`, the row's speaker / stop button and `data-preview`, `catalog.preview`,
  `catalog.stopPreview` on close, `previewable`, the `busy` / `superseded` handling, "previews wait until it works
  again";
- `voiceMeta` (language and gender words under a voice) and `matchesVoice` (which fields are searched);
- the speaker icon of an empty trigger, the "Choose a voice" label, `useVoiceCatalog` / `lib/voiceCatalog.ts` (the
  data), `voiceProviderMarks.ts` (marks: add `anthropic`, `claude-subscription`, `openrouter`, `home-model`,
  `offline`, `deepgram`; `sherpa` exists).

New for models: the typed-model row (§6.3), `badges` as the words under a row, a provider in `needs_address` /
`needs_setup` shown like `needs_key` (its `message` and `settingsLabel` link to `settingsPath`), `listed: false` rows
("Not in the list"), `selectable: false` rows that download instead of selecting (as a voice that is not downloaded).

### 6.2 Proposed props

```ts
/** One picker over any catalog: voices, language models, recogniser models. */
interface CatalogPickerProps {
  readonly source: PickerSource                 // the data adapter (below); one instance per kind per client
  readonly value: string                        // the chosen key ("provider:id"); "" = fallbackKey
  /** The chosen row's key and what it sets (models: `entry.apply`; voices: the VoiceRef). */
  readonly onChange: (key: string, choice: PickerChoice) => void
  readonly disabled?: boolean
  readonly locked?: boolean
  readonly fallbackKey?: string
  readonly id?: string
  readonly describedBy?: string
  readonly label?: string                       // "Choose a language model", "Choose a speech model", "Choose a voice"
}
type PickerChoice = { readonly apply: ModelApply } | { readonly voice: VoiceRefJson }

/** What the component needs from a catalog; `voiceSource`, `modelSource("llm")`, `modelSource("stt")` implement it. */
interface PickerSource {
  readonly id: "voices" | "llm" | "stt"
  readonly useState: () => { lists: ReadonlyArray<GenericProvider>; favourites: ReadonlyArray<GenericFavourite>; loading: boolean; notice?: CatalogNotice }
  readonly ensure: () => void                   // first load (lists + favourites)
  readonly refresh: (provider?: string) => void // ?refresh=1
  readonly toggleFavourite: (key: string, name: string) => void
  readonly download?: (key: string) => void     // local rows only
  readonly cancelDownload?: (key: string) => void
  /** Voices only: the row's extra action (preview) and the third column (preview text). */
  readonly rowAction?: (row: GenericRow) => ReactNode
  readonly side?: ReactNode
  readonly onClose?: () => void                 // voices: stop the preview
}
/** The row the component draws: a VoiceEntry or a ModelEntry mapped by its source. */
interface GenericRow {
  key: string; providerId: string; name: string; description?: string
  meta: ReadonlyArray<string>                   // the words under the name (badges' labels; voices: voiceMeta)
  search: ReadonlyArray<string>                 // extra searched words (tags)
  local?: { state: "installed" | "not_installed" | "downloading"; sizeMb: number; job?: JobInfo }
  selectable: boolean; listed: boolean; favourite: boolean; usedBy: ReadonlyArray<string>
  choice: PickerChoice
}
```

The Language model tab then keeps its options below: `onChange(_, { apply })` writes `apply.llm.account` and
`apply.llm.model` into the draft (the account-specific blocks follow the new account); the Hearing tab writes
`apply.hearing` (for Deepgram only the engine). Data: one catalog per kind and client, as `lib/voiceCatalog.ts`: it
follows `job` messages for `stt-models` (progress in the row) and re-reads `models/stt?provider=sherpa` when such a job
starts or ends or a `models` message arrives; it re-reads `models/llm` after a vault change or a change of the
`llm-openai-accounts`, `language-model` or the subscription module's section. Each such change invalidates the lists it
affects at once: an answer asked for before it is never shown as current (also during the first load), and a new load
starts. Among current answers the one asked for last wins.

### 6.3 The typed model

For a provider with `customModel`: the last row of its list is "Use a model by name…" (a text field with
`customModel.placeholder`, `customModel.help` under it; Enter chooses `{ llm: { account: provider, model: typed } }`).
While searching, when the text is not exactly a listed id, each such provider gets a row "Use “<text>” on <label>".
The typed id is checked with `ModelIdString` before it is offered. Nothing is sent to the server until the page saves
the assistant (its own validation applies: 0–100 characters).

## 7. Not verified, and open questions

Not verified against the real services (no keys on this machine; only local stand-in servers were called):

- **Anthropic** `GET /v1/models`: the fields and paging are those of `@anthropic-ai/sdk` 1.8's type definitions
  (`resources/models.d.ts`: `data`, `has_more`, `last_id`, `after_id`; `display_name`, `max_input_tokens`,
  `max_tokens`, `lifecycle`). The SDK sends the key as `Authorization: Bearer` (seen on the stand-in).
- **OpenRouter**: `context_length`, `pricing.prompt` / `pricing.completion` (US dollars per token, as strings) and
  `description` are taken from OpenRouter's public model-list documentation, as `supported_parameters` and
  `reasoning` were before; a price of `-1` (a router's variable price) is not shown.
- **Home model**: the OpenAI-compatible `{ data: [{ id }] }` (Ollama's documented `/v1/models`) and `{ models: [...] }`
  (llama.cpp) shapes, as `parseModelList` already read them. No real home server was asked.
- **Claude subscription**: the list is what Claude Code answers in `initialize` (`ModelInfo.value`, `displayName`,
  `description`); only the fake SDK of the tests gave one. Whether every `value` (e.g. an alias such as `default`)
  is accepted by `setModel` was not tried.
- Nothing about latency is claimed: the lists are not on a turn's path, so there is no `TurnTrace` number.

Open questions for the owner:

1. **Anthropic without a key.** The brief asked for the known models "when there is no key or the call fails"; the
   owner's rule is "an account that is not set up shows the link instead of a list". Built: no key → `needs_key`, no
   rows; the known models only when the call fails. Changing it is one line in `ModelCatalog.ts`.
2. **Deepgram's model** is shared (`DEEPGRAM_MODEL`), so its provider has one row and choosing it sets only the
   engine. A per-assistant Deepgram model would change the data model.
3. **"Not installed"** is a row state (as for voices); no provider is "not installed" today (stt-sherpa is always
   there).
4. Voice favourites stay in `data/voice-favourites.json` under `/api/voices/favourites`; moving voices onto
   `/api/models/tts` was not done.
5. The assistant save does not check a language model against the list (a typed model stays valid, as today).

## Status

| Part | State |
|---|---|
| This design | Written 2026-11-16. |
| Adapters (`llm-anthropic` `listModels` / `modelSource` / `knownModels`; `llm-openai-compatible` `accountModelSource` and the OpenRouter fields; Claude Code's descriptions; `ModuleHost.settingOptions`) | Done 2026-11-16, tests against local servers: `packages/llm-anthropic/test/models.test.ts`, `packages/llm-openai-compatible/test/modelSource.test.ts`, `packages/core/test/ModuleHost.test.ts`. |
| Server (catalog, favourites, routes) | Done 2026-11-16: `apps/assistant/test/modelCatalog.test.ts` (states, cache, refresh, new key, failure pause, time limit, a failing provider next to working ones, known models, unlisted models, presets), `apps/assistant/test/serveModelPickers.test.ts` (admin only, both catalogs over HTTP, refresh, time limit, favourites persist and per kind, the limit, downloads and cancel). |
| Web mock (`apps/web/mock/modelPickers.ts`) | Done 2026-11-16: every state (Anthropic ready; subscription `needs_setup` until its module runs; OpenRouter `needs_key` until its key is set; the home model's list failed with the typed model and the models in use; Deepgram `needs_key`; Whisper turbo not installed, its download progresses as the Models page's job). `POST /mock/models/state {"provider", "state"}` forces `auto`, `ready`, `failed`, `slow`, `needs_key`, `needs_address`. |
| Web UI (generic picker, Language model and Hearing tabs) | Built 2026-11-16, see "Built (web half)" below. |

## Built (web half, 2026-11-16)

The web UI follows §6; this lists where it differs, and what is left out.

- **Files.** `apps/web/src/components/pickers/CatalogPicker.tsx` (generic picker), `modelSources.ts` (the model
  adapters) and `ModelPickers.tsx` (`LlmModelPicker`, `SttModelPicker`); `apps/web/src/lib/catalogPicker.ts` (pure
  logic, tested in `test/catalogPicker.test.ts`) and `lib/modelCatalog.ts` (one catalog per kind and client: lists,
  favourites, downloads). `VoicePicker` is `CatalogPicker` over a voice source (`components/voices/VoicePicker.tsx`):
  the preview column, the speaker, `voiceMeta` and the voice catalog stay there. `voicePicker.ts` and `voiceCatalog.ts`
  are unchanged apart from `jobOf` taking the job's tool (default `tts-models`).
- **Props differ from §6.2** where the code needed it: `PickerSource` also has `noun` (`"voice"` | `"model"`: the test
  ids `voice-picker`, `model-popup`, … and the row attribute `data-voice` / `data-model`, so the voice specs run
  unchanged), `words` (the texts), `useDownload(key, row)` and `useRowPhase(key)` (hooks that give the download and
  the voice's preview phase to a row), `retry` / `retryProvider` (a failed list's Retry exists for models only) and
  `typed` (the choice a typed model makes). `rowAction` is `RowAction`, a component, and `side` is `Side` (gets
  `phone`). `GenericRow` has `title` (tooltip) and a `GenericProvider` carries its `notice`, `problem` and `linkText`
  (the voices say "Open Voice providers", the models the catalog's `settingsLabel`). `CatalogPicker` takes `fallbackName`
  for a chosen key in no list (Deepgram without a key shows "Deepgram").
- **The typed model** is always visible as the last row of a provider's list (a labelled text field and "Use"; Enter
  chooses), not behind a click. Search offers "Use “text” on <provider>" only for one word (ids have no spaces), so a
  query of several words that matches nothing still says "No models match".
- **Popup width** is 660 px for models too (the voices' with its preview column), so a row's facts have room; on a
  phone the facts of a row are cut with an ellipsis as the voices' are (the row's tooltip has them whole).
- **Language model tab**: one field "Language model" replaces the account cards and the model field; its dirty mark and
  errors cover `llm.account` and `llm.model` (`AField` `alsoPaths`). **Hearing tab**: one field "Speech recognition
  model" replaces the engine cards and the model list; the Language setting still follows the chosen model through
  the speech section's own condition. A draft whose account or model is in no list shows the model's id (or, for
  Deepgram, "Deepgram").
- **Marks elsewhere**: the summary strip (assistants list, an assistant's page, the wizard's copy cards) has the
  provider's mark before the model, hearing and voice lines (`summaryMarks`).
- **Not built**: marks in the latency popover and its open rows (their facts are plain text pairs shared with tests),
  "Used on" (it lists devices, not models); a per-provider "Retry" for the voice picker (not asked for); the typed
  model's text is not checked against the provider (the assistant save is the check, §7 question 5).
- **Mock**: unchanged. Verified against it (`e2e/modelPicker.spec.ts`, `e2e/assistants.spec.ts`, `e2e/wizard.spec.ts`,
  screenshots `admin-desktop-68…76`, `admin-desktop-light-20…21`, `admin-phone-26…28`); not against the real server
  or real providers.
