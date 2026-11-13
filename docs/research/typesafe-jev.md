# TypeSafe Jev as the "hey Jev" action recogniser (implementer's reference)

Research date: 2026-11-13. Sources are TypeSafe's own docs (`https://docs.typesafe.ai`, every page also served as `.md`; index
`https://docs.typesafe.ai/llms.txt`), its OpenAPI file (`https://api.typesafe.ai/openapi.json`, v0.2.0), the npm registry and the SDK docs.
Secondary sources (LangChain page, press) were used only to find these.

**Evidence tags.** **[doc]** = read in TypeSafe's official docs, not exercised. **[run]** = done on this machine.
**[sec]** = secondary/third-party source, not official. **[unverified]** = could not confirm.

**No authenticated request was made to the Jev API.** The key in `SKILL_LIBRARY_TYPESAFE_API_KEY` was issued for a different TypeSafe product
and the docs never say a key works across products ("Get an API key from the TypeSafe console", `introduction/quickstart.md`; limits are "per
organization", `models.md`). Per the brief, I did not try it. The only requests were doc downloads and one *unauthenticated* `GET /v1/models`
(HTTP 403) to check the host is reachable. Hence **every request/response shape below is [doc]; there are no measured latencies.** The SDK snippet
in section 4 was installed and type-checked under strict TS on Node 22.22.1 **[run]**, but never sent.

---

## 0. Recommended integration pattern

**Jev does not extract slots.** It evaluates typed *questions* (Choice, Score, Noul, Box) against a `state` and returns a choice or probability per
question. It does not generate text (`model-jaggedness.md`: "Jev is not trained to generate text"). A "slot" is therefore a *further question whose
options you enumerate*; an open-ended value must come from your own code (regex/lexicon) with Jev optionally picking among candidates.

**Flow per "hey Jev …" utterance** (one HTTP call, speculative fan-out, `patterns/fan-out.md`, `demos/smart-home.md`):

1. Strip the trigger locally. `state` = the remaining text (a string, or an object such as `{ utterance, available_actions }`).
2. Build the question set from the live module registry (inline per request; nothing to register, so enabling/disabling a module just changes the next request):
   - `action`: **Choice**, `criteria` = `{ actionId: "when this applies…" }` (max 255 options; ids are what you get back).
   - `any_fits`: **companion Noul** ("Does the utterance ask for one of the available actions?"). A Choice always picks something; docs say a `none`/`other`
     option "may not work well" and recommend this Noul instead (`primitives/choice.md`, `patterns/companion-noul.md`).
   - `compound`: optional Noul "does it ask for more than one distinct action?" (smart-home demo uses an LLM to split these).
   - For each action's closed-set slot: `"<action>.<slot>"` **Choice** over the allowed values (rooms, devices, on/off, levels), described in meaning not words.
     For each *optional* slot add `"<action>.<slot>?"` **Noul** ("does the speaker say which room at all?") so a missing value falls back to a default instead of a guess
     (function-calling cookbook's `stated` question).
   - Ask all of them every time; read only the chosen action's slot answers (speculative fan-out; "adding more questions usually has little effect on response time").
3. Decide in code (thresholds are risk-scaled and **must be tuned on your own utterances**; docs give starting points only):
   - `any_fits.noul < 0.3` → not an action: fall back to the conversational LLM. `0.3–0.7` → treat as its own outcome (ask / fall back). `> 0.7` and
     `probabilities[choice] > ~0.7` → act. Cheap/reversible actions can use a lower bar, destructive ones a higher bar or a spoken confirmation
     (`confidence.md`, "Thresholds scale with risk"). Threshold the **probability of the chosen option**, not `confidence` (`confidence.md`).
   - Slot Choices: act only if the slot's own probability is high; otherwise ask a short follow-up or use the default.
4. Open-ended values (timer duration, note text, times): **do it in code**, optionally Jev-assisted:
   - Duration/number/time: regex or a small English+Dutch lexicon produces candidate spans; if more than one, a Choice over the candidates (plus a `none`)
     picks which one answers the question (`cookbooks/pre_parsed_value_extraction_cookbook.md`). Dates: Jev reads the *parts* (month, day, relative) as enumerated
     Choices and code does the calendar maths (`cookbooks/date_extraction_cookbook.md`, `model-jaggedness.md`). Do not use Score to recover exact numbers.
   - Free-text note ("remind me to call mum"): not a Jev job. Take the residual transcript span in code (my recommendation; the docs only say "if you really need
     to generate text… there are other models for that").
5. Run the action function, speak the confirmation from a template.

**Latency and failure handling.** Docs claim "about 100 ms" typical and "about 150ms" for real-time apps **[doc, unmeasured]**. Set a short client timeout and
no or one retry (SDK default is 10 s per attempt and 2 retries, which is wrong for a voice path) and fall back to the conversational LLM on timeout, 429, 5xx or low `any_fits`.
Keep `jev-1.14.0` pinned rather than `jev-latest`: the alias moves and thresholds are version-specific (`models.md`).

**Keep it flat, not hierarchical.** Sequential calls (category, then device, then action) are explicitly called "much slower and more expensive" than one fan-out request (`demos/smart-home.md`).
Watch the budget: 32k tokens per question and 64k per request (see 2.6), so many modules with many long descriptions can eventually need trimming.

---

## 1. What Jev is and what it returns

- "Jev is TypeSafe's flagship model and the first System One model" (`models.md`). "Jev evaluates typed *questions* against a *state* and returns structured results directly… Every question is evaluated in parallel and in isolation against the same state in one go." (`https://docs.typesafe.ai/`). It "returns typed decisions and probabilities rather than generated text" (`concepts/system-one.md`).
- Four primitives (`introduction/quickstart.md`, `primitives.md`):

| Type | Question | Answer fields |
|---|---|---|
| `choice` | pick one of up to 255 named options (`criteria`: name → description or `null`) | `choice`, `probabilities` (all options, sum ≈ 1), `confidence` |
| `score` | rate on 1–10 ordered levels (`criteria` array) | `score` (probability-weighted mean), `probabilities`, `confidence`, `legend` |
| `noul` | yes/no statement | `noul` 0–1 (no confidence field) |
| `box` | locate in an image (Jev 1.14, experimental) | `box{top,bottom,left,right}`, `confidence` (may be `null`) |

- **Multi-label:** no dedicated type. Docs: "Ask one Noul question per product instead [of a Choice]… read each one on its own" (`patterns/companion-noul.md`). I.e. multi-label = one Noul per label.
- **Typed structured output (enums, numbers, booleans, free text, nested objects, lists):** **not supported as outputs.** Outputs are only the four answer types above. Structure is accepted on the *input* side (`state`, `instructions`, `criteria` values may be strings, objects or arrays; `primitives/advanced.md`).
- **Slot/detail extraction: not supported natively.** Official guidance:
  - Closed sets (rooms, devices, levels, booleans): one Choice per argument over the enumerated values, one Noul per boolean flag, a "stated?" Noul for optional args, a "none of these" via companion Noul; many questions in one request (`cookbooks/function_calling.md`, `demos/smart-home.md`). Cookbook example: 10 functions → 54 questions per command, one request; `confidence` of the whole call is the *minimum* of the per-argument probabilities. Unlisted arguments (ints, free text, dates) get "no question, and the function's default stands".
  - Open-ended values: "For data extraction, it is better to extract possible options using regex or a generative model and let Jev pick the correct extraction… when the answer space is bounded, turn extraction into a Choice" (`model-jaggedness.md`, section "Generation"). "Jev is not trained to generate text. While you can force it to by chaining choices, this will not work well and will be very slow."
  - Numbers/dates: "Jev reads dates as text, not as ordered quantities… Extraction is a judgment, so give it to the model. Arithmetic is not, so keep it in code" (`model-jaggedness.md`). Score "levels are weak in numerical calibration" and must not be interpolated.
  - Consequence for you: **timer duration** = regex/lexicon in code (Jev at most disambiguates candidates); **free-text note** = residual transcript text, no Jev involvement.
- Other limits worth knowing: choice option order can bias ("Jev leans toward the option that comes first", reorder to check); instructions with double negatives or multi-hop reasoning are less reliable; adversarial text in `state` can steer answers (all `model-jaggedness.md`).

## 2. The API

### 2.1 Endpoints and auth (`api/system-one.md`, OpenAPI)
- Base URL `https://api.typesafe.ai`. Endpoints (the only two in the OpenAPI file): `POST /v1/systemone`, `GET /v1/models`.
- Auth: `Authorization: Bearer <API_KEY>` (OpenAPI `HTTPBearer`). Keys from `https://console.typesafe.ai/keys`. Env var by convention `TYPESAFE_API_KEY` (SDK reads it, plus `TYPESAFE_BASE_URL`).
- Optional headers: `TypeSafe-Danger-Zone-Images: true` (images/box), `TypeSafe-Danger-Zone-Long-Context: true` (262k context). Not needed for text-only use.
- Content-Type `application/json` (or `multipart/form-data` for images). Gzip or zstd request bodies accepted (`Content-Encoding`, one layer, window ≤ 8 MiB).

### 2.2 Request (`SystemOneRequest`)
```json
{
  "model": "jev-1.14.0",
  "state": { "utterance": "turn on the lights in the living room",
             "available_actions": { "lights_on": "Turn lights on", "lights_off": "Turn lights off" } },
  "questions": {
    "action":   { "type": "choice", "instructions": "Which available action does the utterance ask for?",
                  "criteria": { "lights_on": "Turn lights on", "lights_off": "Turn lights off" } },
    "any_fits": { "type": "noul", "instructions": "Does the utterance ask for one of the available_actions?" },
    "lights_on.room": { "type": "choice", "instructions": "Which room?",
                        "criteria": { "living_room": "the living room", "kitchen": null } }
  }
}
```
Required: `model`, `state` (string | object | array), `questions` (≥1, names are yours; the model never sees the question id, per `primitives/choice.md`). The shape is my composition from the documented schema; **not sent**.

### 2.3 Response (`SystemOneResponse`; example values from the official OpenAPI examples)
```json
{ "model": "jev-1.14.0",
  "answers": {
    "action": { "type": "choice", "choice": "lights_on", "confidence": 0.94,
                "probabilities": { "lights_on": 0.97, "lights_off": 0.03 } },
    "any_fits": { "type": "noul", "noul": 0.98 } },
  "usage": { "input_tokens": 120, "output_tokens": 12 } }
```
`model` is the versioned id that answered (may differ from the alias). Answers are keyed by your question names and discriminated by `type`.

### 2.4 Definition style: inline, no registration
Options/schema are defined inline per request; the docs and OpenAPI describe no stored/registered decision objects and no "id" reference. Model customisation is also per request: "Jev is not fine-tuned or LoRA-adapted with customer data… the same weights serve every account" (`models.md`).

### 2.5 Confidence, abstention, thresholds (`confidence.md`, `patterns/companion-noul.md`)
- Choice `confidence = (p_max − 1/n)/(1 − 1/n)`. Docs recommend thresholding the **probability of the option you will act on**, not `confidence` (the same 0.5 confidence is top probability 0.75 with 2 options, 0.55 with 10).
- Noul: use the value; "Good starting thresholds are 0.7 and 0.3… Give the band between 0.3 and 0.7 its own outcome". Three bands: act / confirm / fall back. Example Choice floor `confidence < 0.5` = "don't guess".
- Abstention = companion Noul (preferred) or a `none` option (works less well per docs). "The correct threshold values depend on your domain… Start with conservative thresholds, test with your own data."
- Calibration is claimed ("calibrated probabilities", RLCD training) but **no calibration numbers for intent routing are published that I found [unverified]**.

### 2.6 Limits (`models.md`, `api/errors.md`, OpenAPI)
- Choice options: **max 255**, min 1. Score levels: 1–10. No limit on number of questions.
- Context: **64k tokens per request** (state + all questions) and **32k per question** (state + one question); with `TypeSafe-Danger-Zone-Long-Context: true`, 262k/262k (slower and less accurate).
- No separate input-length limit beyond tokens; body ≤ 32 MiB, UTF-8 JSON, nesting ≤ 64, finite numbers only.

### 2.7 Batch / streaming
No streaming endpoint and no batch endpoint exist in the OpenAPI/docs. Batching = many questions in one request. A single request is a plain JSON round trip.

### 2.8 Errors (`api/errors.md`)
JSON body with standard codes: 400 (rule violation, or `max_tokens_exceeded`), 401, 413, 415, 422 (OpenAPI: `detail: [{loc, msg, type, input?, ctx?}]`), 429, 529 (overloaded). 400 body: `{ "detail": string | object }`. Retry 429/529 with exponential backoff.

### 2.9 Rate limits
Per organisation, tokens/second and requests/second; limits shown in console `https://console.typesafe.ai/rate-limits`; higher on custom/enterprise plans. Numbers not in the public docs **[unverified]**. 429 carries a `retry-after` header when relevant (`models.md`).

### 2.10 Regions
**Not documented** (no region selection, no data-residency statement found; DPA names none) **[unverified]**. Expect a single global endpoint; network RTT from your host will dominate. Measure it.

### 2.11 Latency
- Official: "Most calls complete in about 100 ms" (`concepts/how-to-build-with-system-one.md`); "Frontier intelligence in about 150ms, fast enough for live UIs, voice assistants, and games" (`concepts/use-case-map.md`); smart-home demo: "Jev's initial response is so fast compared to the LLM response that it adds negligible latency". **[doc, not measured here]**
- Independent: Bespoke Labs' own benchmark table for their open model reports Jev 1.13.0 via the TypeSafe API at **median 246.7 ms, mean 267.0, p95 347.4** on 324 single-question examples (their client/network, not this machine) **[sec]**: `https://raw.githubusercontent.com/bespokelabsai/nimble/main/README.md`, "Observed inference latency". Plan on ~250 ms plus your own network, not 100 ms, until measured.

### 2.12 Pricing (`models.md`)
Jev 1.14 and 1.13: **$0.042 per million input tokens** ($42 per billion); **output tokens are free**. A 500-token request ≈ $0.00002. Long context costs the same per token.

### 2.13 Data retention (`legal.md`, `models.md`, DPA at `https://typesafe.ai/legal/data-processing`)
"Jev is not trained on customer requests or responses." DPA Schedule I §8: personal data "retained for as long as necessary taking into account the purpose of the Processing" (no concrete period, as read via a summarising fetch; verify the text yourself). Zero data retention is offered to enterprise customers only (`legal.md`). Practical consequence: transcripts leave the machine, so this conflicts with the project's local-first stance unless the user accepts it; the `state` should contain only the utterance.

## 3. SDKs and LangChain

- **Official JS/TS SDK:** `@typesafe-ai/sdk`, **0.7.0** (2026-10-14), **MIT**, `engines.node >=22`, `"type": "module"` with ESM (`dist/index.mjs`) and CJS exports plus types. Pre-1.0 and its changelog shows breaking changes in 0.6.0 and 0.7.0 → pin exactly. Repo `https://github.com/typesafe-ai/typesafe-sdk-js`. npm registry metadata **[run]**; docs `https://docs.typesafe.ai/sdk/javascript.md`. Also a Python SDK (`typesafe_sdk`), and a Rust crate `typesafe-jev` exists per `docs.rs` **[sec]**.
- SDK behaviour [doc]: `new TypeSafeClient({apiKey?, baseURL?, timeout (default 10000 ms per attempt), retry: {maxRetries (default 2), backoffInitialMs 500, backoffMaxMs 5000, httpStatuses: 408/429/5xx}, defaultModel (default "jev-latest"), compression (zstd for bodies ≥ 1 KiB on Node ≥ 22.15), fetch, logger, defaultHeaders})`. `client.systemOne({model?, state, questions})`; helpers `choice(instr, criteria)`, `noul(instr, criteria?)`, `score`, `box`. Answer types are inferred from the questions. Errors: `TypeSafeError`, `APIError`, `AuthenticationError`, `RateLimitError`, `BadRequestError`, `UnprocessableEntityError`, `InternalServerError`, `APITimeoutError`, `APIConnectionError`, etc. The SDK has `fetch` injection, which makes it testable with a fake transport.
- **Effect fit:** wrap `client.systemOne(...)` in `Effect.tryPromise` with an `AbortSignal` (see `RequestOptions`), map SDK errors to a tagged error. A provider SDK may only be imported in its adapter package (project rule).
- **LangChain:** `@langchain/typesafe` **0.1.0**, MIT, node ≥ 20 **[run npm]**. Exposes `TypeSafeClassifier` (`invoke({state, questions})` returning `nouls`/`choices`/`scores`), env `TYPESAFE_API_KEY`/`TYPESAFE_BASE_URL`, default model `jev-latest`, timeout 30000 ms and maxRetries 2 (`https://docs.langchain.com/oss/javascript/integrations/providers/typesafe`) **[sec]**. Useless for us: it adds a LangChain dependency for a one-call API and bakes in a 30 s timeout.
- **Plain `fetch`:** straightforward: one POST, JSON, bearer header; Node 22 global `fetch`. The SDK adds typing, retry/backoff and zstd. For a latency-critical path plain `fetch` + your own schema validation is reasonable; zstd/gzip is optional (a sub-1 KiB body is sent uncompressed by the SDK anyway).

## 4. Minimal TypeScript

SDK (type-checked, strict, Node 22.22.1, SDK 0.7.0 **[run]**; not executed, no key):
```ts
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ timeout: 2000, retry: { maxRetries: 0 } }); // reads TYPESAFE_API_KEY

const response = await client.systemOne({
  model: "jev-1.14.0",
  state: { utterance: "turn on the lights in the living room",
           available_actions: { lights_on: "Turn lights on", lights_off: "Turn lights off" } },
  questions: {
    action: choice("Which available action does the utterance ask for?", {
      lights_on: "Turn lights on", lights_off: "Turn lights off" }),
    any_fits: noul("Does the utterance ask for one of the available_actions?"),
    "lights_on.room": choice("Which room?", { living_room: "the living room", kitchen: null }),
  },
});
const a = response.answers.action;
const top = a.probabilities[a.choice] ?? 0;          // act on this, not on confidence
const fits = response.answers.any_fits.noul;         // < 0.3 abstain, > 0.7 accept
const room = response.answers["lights_on.room"].choice;
```

Plain `fetch` (shape from OpenAPI [doc]; **not run**):
```ts
type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; legend: Record<string, unknown>; probabilities: Record<string, number> };
type Reply = { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } };

export async function decide(apiKey: string, body: object, signal: AbortSignal): Promise<Reply> {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,                                           // e.g. AbortSignal.timeout(1500)
  });
  if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 300)}`); // 429/529: caller decides on retry
  return (await res.json()) as Reply;                 // validate with a Schema in real code
}
```

## 5. Language support

- Official statements are thin: Jev 1.14 changelog (2026-10-14) lists "Better multilingual support" (`changelog.md`). **No supported-language list, no Dutch-specific statement, no multilingual benchmark** in the docs **[unverified for Dutch]**. Docs say "the match is on meaning, not the words" (`cookbooks/function_calling.md`), which suggests cross-lingual intent matching works, but that is inference.
- Guidance for writing options (official): write each option as an easy-to-read description of *when it applies*; separate confusable options with "what it covers / what belongs to a neighbour / examples" (`primitives/choice.md` structured criteria); write questions about the idea not the parameter name ("Which resolution?" is useless); instructions and criteria must agree (a Noul where `true` means no performs worse); avoid double negatives; name relevant `state` keys; reorder options to check for first-option bias (`model-jaggedness.md`, `function_calling.md`). Option names are seen by the model (`desk_pro` carries meaning).
- For English+Dutch: write option descriptions in English, include a few Dutch example phrases in structured descriptions, and **measure** with a fixed bilingual utterance set before trusting thresholds. All of this is my recommendation, not documented.

## 6. Voice-assistant / intent-routing guidance in the docs

- `concepts/use-case-map.md` (Real-time apps → Voice agents): "Handle simple intents fast, such as a weather request"; judge end-of-turn "alongside your speech-to-text model's end-of-turn signals"; route customer-service calls with Jev making judgments and code picking the final route.
- `demos/smart-home.md` "Smart home assistant demo": the closest match to our use. Questions: request category, domain/area, device type, action, all asked in one speculative fan-out request; a Noul detects compound requests (then an LLM splits them and Jev handles each); general-knowledge/conversation falls back to a conversational LLM. Source "will be available on GitHub at release" (not seen).
- `cookbooks/function_calling.md`: spec → one `__tool__` Choice over function descriptions + per-argument Choices + "stated?" Noul; `confidence` = least certain judgement. Python only; `cookbooks/skill_suggestion.md` is a related Choice-routing example.

## 7. Self-hosted / local options (short; secondary sources unless noted)

- **Jev itself:** hosted API only; no self-host documented (only enterprise ZDR; `legal.md`). The SDK's `baseURL` can be overridden, so any server that speaks the `/v1/systemone` shape can stand in.
- **Nimble (Bespoke Labs):** open-weight Jev-style decision model, Qwen3.5-9B + LoRA, max prompt 8,192 tokens, up to 255 choices; repo `https://github.com/bespokelabsai/nimble` (README fetched **[run]**). Licence: HF model card for `bespokelabs/Bespoke-Nimble-9B` says Apache-2.0 **[run: HF API]**; a third-party index reports a non-commercial CC BY-NC variant (v3) **[sec]**, so check the specific checkpoint. Ollama ≥ 0.35 (2026-09-29) serves it at `/v1/systemone` (Jev-compatible shape; Ollama blog page text **[run]**). Documented hardware: Apple Silicon (MLX) or NVIDIA CUDA; its own table shows 444 ms median on an M5 Pro and 106 ms on an H100. **CPU-only: not documented; a 9B model on CPU is unlikely to meet a latency budget [unverified, my judgement].** English-only by its HF tags (`en`) **[run]**: bad fit for Dutch.
- **Jeff (Firelex):** independent open project (not affiliated with TypeSafe), small fine-tunes (Qwen3.5-0.8B/2B, Gemma 4 E2B) of the same idea, code MIT (README Licence section **[run]**), weights' licence per HF card (coverage says Apache-2.0 **[sec]**); claims ~22–28 ms on a GPU/M4 Max **[sec]**. It uses its own API (`api.jeffhub.ai/v1/decide`, "decision functions" and adapters), not the System One shape; local mode documented for Apple Silicon or Linux with NVIDIA GPU. CPU-only support not documented **[unverified]**; Dutch not documented.
- Verdict: no documented CPU-only drop-in. A realistic local fallback behind the same interface is a small embedding/NLU intent matcher or a tiny on-box LLM, outside this document. Keep `ActionRecogniser` as a service interface so either backend fits.

## 8. Open questions and pitfalls

Not verified (no authenticated request; some not in docs):
1. Every real response shape and error body; behaviour of `jev-1.14.0` on Dutch and mixed Dutch/English input; accuracy of Choice-over-actions plus companion Noul on our own utterances.
2. Real latency from this machine and from the target device; documented 100–150 ms vs 247 ms independent median; effect of 50+ questions in one request on latency (docs: "usually little").
3. Whether the key `SKILL_LIBRARY_TYPESAFE_API_KEY` is accepted (not tried; docs do not say keys are account-wide). Likely need a key from `console.typesafe.ai/keys`.
4. Rate-limit numbers, regions/data residency, concrete retention period, subprocessors (`trust.typesafe.ai/subprocessors`, not read).
5. Whether TypeSafe applies prompt/prefix caching so a stable action list is cheaper or faster (not documented; do not assume).
6. Token cost of the action list per call: 255 options max, 32k per question; large module sets may need a two-stage narrowing, which the docs warn costs latency.
7. Whether 1.14's "better multilingual support" covers Dutch; no list of languages.

Pitfalls:
- A Choice always answers: gate it with the companion Noul, and do not read slot answers of non-chosen actions.
- Threshold probabilities, not `confidence`; pin the model version because thresholds are version-specific and `jev-latest` moves.
- Do not ask Jev for durations, times or free text; extract them in code. Dutch number words ("een kwartier", "twee minuten") need your own lexicon.
- Option order bias; ambiguous or overlapping action descriptions; adversarial transcript text can steer decisions, so keep Jev's output to *selecting* among registered actions, never executing arbitrary content.
- SDK defaults (10 s timeout, 2 retries) are wrong for a spoken path; SDK is 0.x with breaking changes between minors; `box`/images need "danger zone" headers, so leave them off.
- Sending the utterance to a third party (hosting location undocumented) contradicts the local-first posture; make the Jev path an explicit, optional provider with the conversational LLM as the fallback.
