# Agents, trigger routing and typed intents

Design for the next stage: several interchangeable agents (Claude and Codex subscriptions through their harnesses,
OpenAI-compatible servers on the home network and OpenRouter, the existing Anthropic API), a spoken trigger phrase that
picks the agent ("hey Jev, …"), a typed-intent path that runs programmatic actions without a conversational model, and a
much more configurable settings screen. Written 2026-11-13. `docs/ARCHITECTURE.md` and `docs/UI-AND-MODULES.md` remain the
contract for what exists; this document adds to them. Facts come from `docs/research/agent-backends.md` and
`docs/research/typesafe-jev.md`; where something is unmeasured or unverified it says so (**[verify]**, *estimate*).

## Changes since the design

Recorded by the implementers while building; each entry says what changed and why. Other pieces build against these.

### Pieces A, C, D (agent core and routing, intent path, modules) — 2026-11-13

Interfaces other pieces use:

- **`AgentTurnInput.now?: () => number`** (new, optional): the trace clock, so agents measure tool and action durations on
  the same scale as the marks. Absent → use `Clock.currentTimeMillis`. Agent implementations need no change.
- **`AgentSet`** (in `ConversationEvents.ts`): `defaultAgent` is **required** (the fallback rule "default agent if
  conversational" needs it; `Router` does not expose its config). New optional `armedMs` (how long `ExpectReply` arms; the
  router's `armedMs`, default 10 000). `names`, `actions`, `deciders`, `maxToolRounds`, `promptFor` are optional with
  defaults (running agents' names, none, none, the conversation's `maxToolRounds`, the setup's `system`).
  `acknowledgement` was **dropped**: the router's `RouteDecision.acknowledge` already carries the text.
- **`Conversation`**: `layerWithAgents` / `makeAgentConversation` as designed; the service gains
  `routerState: Effect<RouterState>` (for `snapshot.routing`) and `textTurn(text, { agentId? })`. `textTurn` still fails
  with `LlmError` (an `AgentError` is mapped to it) so existing callers compile.
- **Single-model conversations are unchanged** (`layer`, `layerWithSetup`): they run one `model` agent with **no
  first-event timeout** (an `Llm` that thinks for more than 5 s keeps working), and their events and history carry **no**
  agent fields (`TurnStarted` without `agentId`…, assistant messages without `agentId`, no `RoutingChanged`, no
  `Trace.agent`). All 169 core tests that existed before pass unchanged.
- **Failure fallback** (§1.9): an `AgentError` (or first-event timeout) re-runs the turn on `fallbackFor(agent)` only when
  the agent said nothing **and started no tool or action** (a side effect may have happened). With no fallback agent the
  turn fails as before (no canned reply). A `Handoff` with no agent to take it speaks "I can't help with that right now.",
  recorded as that agent's reply. The fallback agent gets one try (no second fallback).
- **Notices and canned replies**: "X isn't available." is a clause of its own, spoken and shown (`TextDelta`) but not in
  history. `Say` starts a turn with `TurnStarted { source: "text", text: "", canned: true }`.
- **Events**: `IntentDecided` also carries `agentId`. `RoutingChanged` is emitted when a commit or an `ExpectReply` changes
  the state, and always on `SetActiveAgent`.
- **`TurnTrace`**: `traceMarks` in time order: `…, llmFirstToken, decisionSent, decisionReceived, firstClause,
  ttsFirstAudio, playbackStart, actionStarted, actionFinished`. `Trace.agent: TraceAgent` (`{ id, kind, routedBy,
  fallbackFrom? }`); `formatTrace` prints `agent=jev(trigger)` / `agent=main(trigger, instead of jev)`.
- **Modules**: `ModuleInstance extends ModuleContributions` (`ExtendedModuleInstance` kept as an alias);
  `ModuleDefinition.kind?` / `agentKind?`; `defineModule` accepts `kind`. `ModuleSnapshot` gains **required** `agents`,
  `actions`, `deciders` (only the host builds snapshots). Generated action tools are in `registry`, `toolModules` and
  `ModuleInfo.tools`; their names are clash-checked like module tools; duplicate action ids fail the start.
- **Generated Test button**: `ModuleHost.fieldAction(moduleId, key)` runs an instance's own `fieldActions[key]`, or, for
  `key: "test"`, the generated agent test ("Say hello in five words." → "First text after … ms, done after … ms: '…'") or
  decider test (fixed two-action request). It answers `FieldActionHostResult` with its own codes (`unknown_module`,
  `unknown_action`, `not_running`) because protocol v1 has no `unknown_action`; piece F/G maps them. The `action` field
  itself appears in forms with piece G. `testAgent` / `testDecider` are exported.
- **`Param.*` typing fix** (`Actions.ts`): the constructors now return `XParam<NoInfer<O>>`. Before, inside
  `defineAction({ params })` the contextual type made `O` infer as `boolean`, so `run` saw every value as `T | undefined`.
  Backwards compatible (code that handled `undefined` still compiles).
- **`actionTool`** (`Actions.ts`): returns the action's `say`, else its `announce` text, else "ok" (design: `say` or "ok"),
  so a conversational agent can confirm in its own words. A `confirm` action's tool description adds "Ask the owner to
  confirm before calling this." (not enforced: §7). Names are resolved with `resolveOption` (exported): value/label/alias
  ignoring case, punctuation and a leading article; then phonetic key; then one edit on phonetic keys of ≥ 4 letters
  when only one option is that close. Durations as tool input: `parseDuration` ("10 minutes"; a bare number = seconds).
- **`makeIntentAgent`** options: `deciders: string[]` (preference order, default `["jev-typesafe", "keywords"]`) instead of
  `decider: () => DecisionProvider | undefined`, because the running providers arrive with each turn
  (`input.deciders`); `onDeciderChange(provider, preferred)` drives the status line. `thresholds`, `parse` (default
  `parseValues`), `onNoMatch`, `noMatchText`, `speakBeforeDone`, `pendingMs`, `timeoutMs` as designed.
- **Intent agent behaviour**: a started action runs **detached** (not `uninterruptible`), so a barge-in does not wait up
  to 5 s for it, yet the action still finishes. On a fallback or decider error the pending question is dropped at once
  (not at commit): the `Handoff` ends the stream before promotion and waiting would delay the fallback agent. Each spoken
  sentence is followed by `"\n"` (immediate flush); a second sentence starts with a space so history reads naturally.
- **`ValueParser`** (signature unchanged): the parameter's `unit` is not passed, so candidates followed by *any* unit word
  (`%`, percent, procent, degrees, graden) rank first. "een" counts as 1 only before a unit word or written "één" (it is
  also the Dutch article); "a/an" count only in durations ("a minute").
- **Keyword decider** (`agent-intent/src/keywords.ts`), needed to make the demo sentences work: action scores weight each
  word by how few actions share it and are sharpened (4th power) before normalising (plain normalisation never reached
  the 0.7 threshold when actions share words like "lights"); description sentences starting with "Not" are ignored;
  words naming a parameter value ("kitchen", "woonkamer") are ignored when choosing the action (in the utterance and in
  examples) unless the action's own description uses them; "close to an example" = Jaccard ≥ 0.75 of content words;
  question words (what, which, hoe, …) count in the score but not toward `fits`; number candidates: the first gets 0.7
  when it carries a unit.
- **`jev`** settings as §3.6 plus env `JEV_DECIDER`; thresholds have no environment variables.
- **`demo-home`**: no settings yet (constant house: 4 rooms with a main light each, Desk lamp, Reading lamp); targets
  `area:<room>`, `light:<lamp>`, `all` (room main lights are reached through their room); status "4 rooms · N lights on";
  a short `instructions` line says the home is pretend. `clock.time_now` uses a constant places list (Amsterdam, London,
  New York, Tokyo) until the `records` setting exists; `weather.today` takes the place after in/for/at/voor/te and drops
  trailing "today/now/vandaag/…".
- `packages/agent-intent` has a dev dependency on `@pva/modules-builtin` (end-to-end test); the lockfile gained that one link.

### Review fixes (core, intent path, built-in modules) — 2026-11-14

Behaviour changed after an independent review; each line replaces what the entries above or the sections below say.

- **Stop cancels a speculative turn too** (was: "a pending speculative turn is left alone"). `Interrupt` discards a pending
  turn (outcome `discarded`), and the eager or final transcript of that same utterance then starts nothing; new speech
  (`SpeechStarted`), typed text, `Say` or a different transcript clears that. `docs/ARCHITECTURE.md` updated to match.
- **A manual agent choice wins over a waiting speculative turn.** `SetActiveAgent` made after a turn was planned keeps
  that turn's promotion from applying its routing outcome (`decision.next`) or its `ExpectReply` arming.
- **The pending question is dropped at promotion, not at once** (supersedes "on a fallback or decider error the pending
  question is dropped at once"). The `Handoff` still goes out immediately, so the fallback agent does not wait; the
  clearing waits for `promoted` on its own fiber (bounded by `pendingMs`) and clears only the question that turn saw, so
  a discarded speculative turn leaves it in place. With `onNoMatch: "say"` it is cleared at commit like any spoken turn.
- **A pending question or confirmation is used only with the same action registration.** If the turn's actions no
  longer contain the very `RegisteredAction` that asked (module disabled or reconfigured), or a dynamic value chosen
  before the question is no longer offered, the pending intent is dropped and the utterance is decided as a new request
  (`pendingStillValid`, exported from `Decision.ts`). A "yes" never carries over to a new instance.
- **Numbers: which one is meant is decided before its range is checked.** All numbers found are offered as candidates;
  one out of range is marked `invalid` and, if chosen (or if it is the only number), the value is asked for again with
  "I can't use <what was said>. <question>" — never replaced by another number of the sentence, and never by an
  optional parameter's default. An out-of-range answer to a pending question asks again (the action stays pending).
  `ParamPlan` `missing` gains `invalid?: string`.
- **Signs are part of numbers.** "-5", "−5", "minus five", "negative 5", "min vijf", "negatief tien" parse as negative
  (and signed decimals); a duration with a sign is negative, which no duration parameter accepts; `parseDuration`
  returns `undefined` for a negative value.
- **`Param.text` gains `notAfter`**: words that, right before a marker, mean it is not one. `weather.today` uses
  `notAfter: ["wat"]`, so "wat voor weer is het in Utrecht" takes "Utrecht" (it took "weer is het in").
- **Keyword decider: negation and confirmations.** A command with a negation (not, don't, never, no, can't, won't,
  niet, nooit, geen, nee, …) gets `fits` 0.1 and is handed to the conversational agent rather than acted on; a negated
  answer to a pending question ("not the kitchen") does not choose the option it names. A pending confirmation is
  confirmed only by a reply made entirely of yes words ("yes please", "ja, doe maar", "go ahead", "that's right"):
  "please", "do" or "right" inside a new command no longer confirm. A reply made of no words, or with a negation,
  cancels; a reply that is a command of its own is decided as a new request.
- **Module host: tool-name clashes are checked at publication**, synchronously against the modules running then, and
  the candidate snapshot is built before anything changes; on a clash the new instance's scope is closed and the start
  fails with `module_start_failed` (two modules starting at once with the same tool name no longer fail
  `startEnabled`). An interrupted start closes the half-started scope and restores the module's previous state; a
  `start` that throws before returning its effect is a start failure.
- **Module code that throws synchronously is contained**: a tool's `execute` (error result), an action's `run`
  (failed action), `announce` (no announcement; the action still runs), a `confirm` text function (the label is asked),
  a decider's `decide` (decision error → `Handoff`), a field action and the generated agent/decider tests (reported).
  Interruption is never turned into an error.

### Review fixes, second round (core, intent path) — 2026-11-14

A second review checked the first round's fixes. Each line replaces what the entries above or the sections below say.

- **Stop cancels an utterance, not a transcript** (replaces "the eager or final transcript of that same utterance then
  starts nothing"). After Stop discards a speculative turn, everything the recogniser sends for that utterance — revised
  eager transcripts, `TurnResumed`, the final `EndOfTurn` with whatever words — starts nothing. The utterance ends with its
  `EndOfTurn` (swallowed); `SpeechStarted`, typed text and `Say` begin something new. This relies on the boundary contract
  now stated with `SttEvent` in `docs/ARCHITECTURE.md` (both recogniser families keep it); a recogniser that breaks it
  cannot leave the conversation deaf: the cancellation lapses after `CANCELLED_UTTERANCE_MS` (20 s).
- **Promotion compares values** (`normalizeTranscript`): a sign or dash before a digit, a separator between digits and
  "%" count; other punctuation and case do not. "5" → "-5", "15" → "1.5", "35" → "3-5" discard the speculative turn and
  decide again from the final words (history records them).
- **Numbers are read whole** (`ValueParsing.ts`; extends §3.5): hundreds, thousands, millions in English ("one hundred
  and forty", "nineteen hundred", "a hundred") and Dutch, glued or spaced ("honderdveertig", "tweehonderd", "twee
  honderd", "tweeduizend driehonderd", "vijf en twintig"); "anderhalf", "tweeënhalf", "<n> and a half", "<n> point five",
  "<n> komma vijf". A compound number is one candidate, never several smaller ones ("one hundred forty percent" is 140,
  asked for again, never 40). "1,000" / "1.000" (three digits after the separator) is a thousands separator in one
  language and a decimal point in the other: one candidate with value NaN, which no parameter accepts, so it is asked
  for. A minus sign separated from its number by spaces is a sign ("- 5"), except between two numbers ("3 - 5"). An en
  dash is not read as a minus.
- **Choice questions always offer "none of these"** (option id `none`, 254 values at most), and a required parameter with
  a **single value is no longer filled without asking**: it gets the "does it say which …?" question; when the utterance
  names none, the single value is used; when it names one, the choice must pick it (`ParamPlan` choice gains
  `only?`). A value named but not offered is never replaced by the only value, a default or the best of a bad set: it is
  asked about ("turn on the bedroom lights" with only a kitchen light; "what time is it in Utrecht"). Keyword decider:
  `stated` is also 0.9 when the utterance has a content word nothing explains (not in the action's label, description
  or examples, not an offered value, a number, a question word or a negation). Known cost: a stray word ("turn on the
  lights quickly" with a single light) makes it ask.
- **A broken option list leaves out only its actions**: each list is read once per plan; an action whose list throws is
  not offered (`DecisionPlan.unavailable`, also in `warnings`, logged by the intent agent); if nothing is left and no
  question is pending, the intent agent hands off without a request (`Decision` outcome `fallback`, reason "no actions
  available"). A pending question whose list fails is dropped and the utterance decided as a new request.
- **A reply to a pending question that is a command of its own is planned afresh** (all its parameters), never taken
  as the answer. Core rule, whatever the provider: the reply is a new request when it gives a value already decided
  another value (the pending action's own parameter questions in the same request), or when the provider confidently
  picks a different action (fits ≥ `fitsAccept`, action ≥ `action`, not compound). Keyword decider: `answers` is 0.2 when
  words other than value words (option names, numbers, units) and the question's own words pick an action ("turn off the
  kitchen lights please" after "Which room or light?"); "the kitchen", "the kitchen lights", "40 percent", "veertig
  procent" still answer. Number words no longer count toward choosing an action (in the utterance or in examples).
- **Core safeguard, independent of the decision provider** (`interpretDecision`, word lists in
  `packages/core/src/IntentWords.ts`, English and Dutch, moved there from the keyword decider, which now uses them):
  a pending confirmation is accepted only on a bounded affirmative ("yes please", "ja, doe maar", "go ahead"); a reply
  the provider calls a yes that is not one is decided as a new request; a provider's no still cancels. A request that
  contains a negation ("don't", "not", "never", "niet", "nooit", "geen", …) for an action with side effects (not
  `speculative`) is not acted on, asked about or confirmed, also as the answer to a pending question: `Fallback` with the
  new reason `negated`, so the conversational agent answers. Read-only actions are not vetoed. No action needs a
  confirmation it did not declare. Extend the lists with `extendIntentWords` and `makeIntentAgent({ words })`;
  `interpretDecision` takes them as a fourth argument.
- **Nothing is placed after a `Handoff`**: `Conversation` stops reading an agent's stream there, so the intent agent sets
  up the dropping of a pending question before it emits `Handoff` in every branch (the "no decision provider" branch kept
  it after, so the stale question survived). Stated on `AgentEvent` `Handoff`.
- **A manual agent choice also wins over `ExpectReply` after promotion** (and in typed turns): an intent question
  planned before a `SetActiveAgent` no longer arms the intent agent once promoted.
- **Module host: a successful start is always published or closed.** The module's start is the only interruptible part;
  from its return until the instance is published (or its scope closed on a clash, and, for a reconfiguration, the old
  instance retired) nothing can interrupt, so an interruption right after a successful start no longer leaves an
  instance running unpublished (tested by interrupting after every scheduler step).

### Review fixes, third round (core, intent path, keyword decider) — 2026-11-14

A third review found seven more cases of the assistant acting on something other than what was said. Patching
examples had not converged, so this round changes the default. Each line replaces what the entries above or the sections
below say.

**The rule: act only on what is fully accounted for.** The intent path may run an action with side effects only when
every word of what was said is explained — by the trigger (already removed), the action, its parameter values, and a
closed set of filler words. Anything unexplained, unparsed or contradictory means: ask a short question, or hand the
sentence to the conversational agent. Recognisers of "safe to act" input are closed lists and grammars (allow-lists);
nothing is inferred from the absence of a known bad word. The closed lists are `IntentWords` in
`packages/core/src/IntentWords.ts` (`yes`, `yesFiller`, `filler`, `negation`, `prohibition`, `no`, `noFiller`; English
and Dutch; extend with `extendIntentWords` / `makeIntentAgent({ words })`); the number grammar is written out at the top
of `packages/core/src/ValueParsing.ts`; the accounting is `packages/core/src/Accounting.ts` and `unexplainedForRequest`
in `Decision.ts`.

- **Accounting of a request (core, any provider).** For an action that is not `speculative`, `interpretDecision` checks
  that every word is explained: the action's vocabulary (`actionVocabulary`: its label, the sentences of its description
  that do not start with "Not", its examples, its parameters' labels, units and text markers; number words and, in
  examples, names of its values are left out; negations never count), the values it is given (the option chosen, where it
  is named; the number span used; the text taken with its marker word; and for a question about to be asked, whatever
  names a value of the parameter asked about), and `filler`. Words inside a value — a number span, the name of an option —
  are explained only by being that value. Otherwise `Fallback` with the new reason **`unexplained`**. A value is one that
  was said: an option chosen for a choice parameter that the utterance does not name is a guess and is asked for (a
  single-valued parameter whose value is not named still takes it, as before). Read-only actions are not checked by core
  (as with the negation veto); the keyword decider checks them.
- **Numbers and durations: a span is one value or one invalid candidate** (replaces "Numbers are read whole" of round 2
  where it differs). A connected numeric expression — digits, number words, signs, separators, fractions,
  point/komma, "and a half", units, in any mix — is one span; either the whole span reads as exactly one value, or it is
  one candidate with value NaN (asked for again). The scanner never resumes inside a span and never offers part of one.
  "one hundred 40 percent", "one point twenty five percent", "1.234,5 percent", "forty 5", "five five", "3 and 5", "3-5",
  "3 - 5", "five minus three" are each one invalid span (round 2 read "five five", "3 and 5" and "3-5" as two numbers).
  A span with a duration unit is a duration, not a number (and the other way round). `ValueCandidate` gains optional
  `start`/`end` offsets; `numericSpans` is exported. `parseDuration` takes exactly one duration.
- **Replies to a pending question** (replaces round 2's "a reply … that is a command of its own is planned afresh" and its
  core rule). Core reads the reply from its text and the pending question alone (`ReplyReading`, in
  `DecisionPlan.pending.reading`): it is an answer only if it is nothing but the value (exactly one number span read by
  the parser, or the names of exactly one option, or text after a marker), optionally the question's own words (the
  parameter's label and unit, the spoken question, the action's vocabulary, the names of values already decided) and
  fillers. Any other word — an unknown place, another option, a different verb, another number — makes it `other`: it is
  then planned as a fresh request with no memory of the pending one (and is acted on only if that fresh request passes
  the accounting rule). The provider's "answers the question" (and, for a choice, its choice of option) can only confirm
  core's reading, never replace it. "the attic 40" after "What brightness?" for the kitchen is handed on; "the kitchen
  40", "set it to 40", "op veertig graag" still answer. The `answers` role carries core's `reading`, and the keyword
  decider confirms exactly what core accepts.
- **Confirmations: a closed phrase grammar** (replaces "a pending confirmation is accepted only on a bounded
  affirmative" and the word bag). `isConfirmation(text)`: `filler* affirmative (filler | affirmative)*` with phrases from
  `yes` ("yes", "sure", "ok", "ja", "prima", "go ahead", "do it", "doe maar", "ga je gang", …) and `yesFiller` ("please",
  "thank you", "alsjeblieft", …), nothing else, no negation, no question mark. Interrogative forms ("is that right", "is
  that okay", "do you", "shall I", "zal ik", "klopt dat") are not in the grammar, so they never confirm, with or without a
  question mark; a bare "right", "go" or "do" does not confirm either. A provider's no still cancels. `isAffirmative`
  applies the same grammar to words already split.
- **Negation and prohibition** (extends round 2's veto). `negation` now lists contractions with and without apostrophes
  (dont, doesnt, wouldnt, shouldnt, mustnt, cant, couldnt, wont, …), a contraction split by the recogniser ("don t"),
  "without", "except", "unless", and Dutch nergens, niemand, zonder, behalve; the new `prohibition` list (stop, quit,
  cease, cancel, abort, avoid, refrain, forget, skip, prevent; Dutch stoppen, hou/houd (op met), ophouden, annuleer,
  vermijd, vergeet, staak, voorkom, genoeg) vetoes a side effect the same way (`Fallback` `negated`), except a word that
  is in the action's own vocabulary ("stop the timer" for a "Stop the timer" action). Because of the accounting rule, a
  negation in no list ("nimmer", "ne'er") also fails, as an unexplained word.
- **Offline keyword decider: the same rule for a fresh request.** `fits` is 0.2 (below `fitsAccept`, so never acted on)
  when the best action leaves any word unexplained; core computes the unexplained words per action and passes them in the
  `fits` role (`unexplained`); Jev never sees roles. Expect more sentences handed to the conversational agent; that is
  the intended trade.
- **Promotion of an intent turn compares the words strictly** (replaces round 2's "Promotion compares values" for intent
  turns). A turn routed to an intent agent is promoted only if the final transcript equals the eager one after
  lowercasing, collapsing whitespace, and removing sentence-final punctuation and commas between words
  (`strictTranscript`); anything else ("five" → "-five", any change in a number, a word added or dropped) discards the
  speculative turn and plans the final transcript afresh. Conversational agents keep `normalizeTranscript`.
- **Stop cancels the open utterance, with or without a turn** (replaces round 2's "Stop cancels an utterance, not a
  transcript" where it differs). `Conversation` tracks the utterance being spoken apart from any reply fiber:
  `SpeechStarted` or an eager transcript opens it, `TurnResumed` keeps it open, its `EndOfTurn` closes it. Stop cancels
  it whether or not a turn exists — before the first eager transcript, or between speculative replies after
  `TurnResumed`. A `SpeechStarted` inside the cancelled utterance does not lift the cancellation; one after its
  `EndOfTurn` does, as do typed text and `Say`; the 20 s lapse stays.
- **Option lists are read once per plan, failures included.** The cache is keyed by the parameter's own identity (the
  pending answer is planned with an "as required" flag instead of a copy of the parameter), a list that throws is
  remembered as failed, the pending answer and reading are built once inside the protected block, the dynamic values a
  pending intent chose are checked there against the same snapshot (the intent agent no longer calls `pendingStillValid`
  before planning), and a pending intent whose action the plan left out as unavailable is dropped, never run.
- **History bound** (core): see "History bound" in `docs/ARCHITECTURE.md` (32 turns, evicted 8 at a time, 48 000
  characters, 8 000 per item; `ConversationOptions.history`). `AgentTurnInput.historyStart` (new, optional) is the number
  of messages evicted before `history[0]`; a harness agent's catch-up must keep its position in those absolute numbers.

Interfaces changed: `IntentWords` gains required `prohibition` and `filler` (code that builds the object literally must
add them; `extendIntentWords` is unaffected); `IntentOutcome` `Fallback` reason gains `unexplained`; `DecisionPlan`
gains `accounting` and `pending.reading`; `QuestionRole` `fits` gains `unexplained?`, `answers` gains `reading?`;
`buildDecisionPlan` takes `words?`; `ValueCandidate` gains `start?`/`end?`; new exports `isConfirmation`, `isProhibited`,
`strictTranscript`, `HistoryLimits`, `DEFAULT_HISTORY_LIMITS`, `numericSpans`, `unexplainedForRequest`, `ReplyReading`
and the `Accounting.ts` helpers.

Commands that used to work and are now refused or asked about (all handed to the conversational agent unless noted):
a stray word in a command ("turn on the kitchen lights quickly", "… for my mother"; fillers such as "please" or "now"
are fine); a
second number ("dim 3 lights in the kitchen to 40 percent", also "… 140 percent", which used to ask); a room the module
does not know ("turn on the bedroom lights" with only a kitchen: handed on, used to ask); two numbers next to each other
("rooms 3 and 5", "3-5": asked for again); a provider's room the sentence does not name ("turn on the bedroom lights"
when the provider says kitchen: asked); "right" alone, "go" or "do" as a confirmation; a reply that adds anything to the
value ("40 percent quickly", "the kitchen at 40 percent"); and a speculative intent turn whose final transcript differs in
anything but case, spacing, final punctuation and commas (decided again, about 250 ms later).

Cost, measured (`AccountedFor.test.ts`, `keywords.test.ts`, this machine): planning plus interpretation with core's
accounting ≈ 50 µs per sentence (5 actions); the keyword decision ≈ 130 µs (7 actions; memoised criteria, stems and
phonetic keys); no extra decision request.

### Review fixes, fourth round (core, intent path) — 2026-11-14

A fourth review scripted a decision provider to give the most harmful confident answers and found six ways through
round 3's rule, plus one small gap. They had one cause: the accounting checked that every *word* was covered by
*something*, not that each piece of the sentence is used for exactly one purpose, in a form that means what the action
needs. This round closes that. The rule of round 3 stands; these are its four parts now. Each line replaces what the
entries above or the sections below say.

- **Every character is accounted for, through one normalisation** (`packages/core/src/Utterance.ts`). The value
  parser, core's accounting, the confirmation grammar and the promotion of a speculative intent turn all read
  `canonicalUtterance(text)`: the original (NFC, case kept) with only the closed set of ignorable punctuation removed —
  `.` `!` `…` `;` `:` before a space or the end; `,` before a space or the end unless a neighbouring word is part of a
  number (`isNumericWord`, `NumberWords.ts`); quotation marks; a dash between two letters ("twenty-one") — and
  whitespace collapsed. Every other mark stays and must be accounted for: consumed by the number span it belongs to (a
  sign of any dash kind before a number; a decimal mark glued before a digit group, ".5", read as 0.5; "%" and "°" after
  it; a separator between digit groups), the final "?" of an asking request construction ("can you …?"), punctuation
  that is part of an option's own name, or a comma outside numbers (`IGNORABLE_OUTSIDE_NUMBERS`). Anything else — "?"
  after an imperative, "+40", "4:30", "#2", "&", a dash glued to a word — makes the request unaccounted. Signs: "-",
  "−", "﹣", "－" are a minus; any other dash before a number (U+2010–U+2015, U+FE58) makes the number unreadable (NaN,
  asked again). A trailing "." after a number followed by a space ("5. percent") is sentence punctuation, so 5; glued
  ("5.percent") it is in no span and the request is handed on. Promotion of an intent turn (`strictTranscript`, now
  `canonicalUtterance`) compares canonical texts exactly: "yes" and "yes?", "5" and "–5", "5" and ".5", a change of
  case, or a comma next to a number are different transcripts (the final one is decided afresh); "Yes." and "Yes" are
  the same. `isConfirmation` reads the canonical text and refuses any mark but a comma.
- **Each span has exactly one role** (`assignRoles`, `Accounting.ts`). Per offered action, the names of its options
  (all matches, `allOptionMentions`) and every number span are assigned roles longest first: a span inside a strictly
  longer one is consumed by it ("room two" names a room, so its "two" is no number; "two hundred percent" is a number,
  so a room called "Two" inside it is not named); the same option found twice over the same words is one candidate;
  any other overlap (two options, or a name and a number, over the same words; spans that cross) leaves every span
  involved ambiguous: no parameter may use it, and it is covered only when a parameter it could fill is being asked
  about, so the result is a question. Number and duration candidates are only those whose span keeps the number role
  (`DecisionPlan` plans each action's numbers against its own roles). In the interpretation, a parameter filled from
  words another parameter's value uses (one number for two parameters, text taken over an option's name), or two
  numbers that two parameters could each take either way ("set the colour to 40 at 60"), make those parameters
  missing: ask. One action per sentence: a request that another offered, non-read-only action of a different kind
  (other label stems) explains fully, with no more questions and at least as many of its own words, is handed on
  (`Fallback` `uncertain`: "turn the kitchen lights" — on or off?; "set the kitchen to 20" — brightness or heating?;
  "switch everything off" stays the confirmed `all_off`, whose own words explain more than `lights_off`'s value does).
  A fresh request must contain at least one of the action's own words (a room alone is no command).
- **A value carries its unit, and the unit must fit** (`unitFits`, `paramUnit`, `ValueParsing.ts`). The parser
  reads the unit said with a number (`ValueCandidate.unit`, `NumericSpan.unit`: "percent" for percent/procent/pct/%,
  "degree" for degree(s)/graad/graden/°); core reads it from its own spans too, whatever a parser reports. A number is
  a value of a parameter only with no unit said, or the parameter's declared unit by closed aliases (percent: "percent",
  "%", "procent", "pct", "percentage", "per cent"; degree: "degree(s)", "°", "graad", "graden", "celsius", "°c",
  "degrees celsius", "graden celsius"; any other declared unit as written). "40 degrees" is not a brightness in percent,
  and a number with a unit is not a value of a parameter that declares none; such a number is an unexplained span
  (handed on), also as the answer to "What brightness?". Durations are unchanged (a number unit in a duration span is
  NaN; a number span is no duration).
- **Fillers are positional, and a sentence must be a request** (`requestFrame` and `account`, `Accounting.ts`; lists in
  `IntentWords`). `filler` now holds only words neutral anywhere: articles, "my"/"our"/"mijn"/"onze", "please",
  "kindly", "just", "now", hesitations, "even"/"eens"/"nu"/"graag"/"alsjeblieft", and the prepositions that place a
  value (to, in, at, for, of, into, op, naar, voor, van, bij, te); a preposition, article or possessive must be followed
  by what it places ("… lights for my" was cut off). Positional, closed lists: `opening` (hey, hi, hello, ok, okay,
  well, so, oh, hoi, hallo, nou, zo, goed; only first), `askFrame` ("can/could/will/would you", "kun je", "kunt u",
  "kan je", "wil je", "wilt u", "zou je", "zoudt u", …; only at the start; accounts for one final "?"), `wantFrame`
  ("I want", "I want you to", "I'd like (you to)", "I would like (you to)", "let's", "ik wil (graag)", "ik zou (graag)
  willen", …; only at the start), `manner` (only first or last) and `closing` (only last), and `replyFiller` ("it",
  "make", "maak"; replies only). The body between them is the action's words and its values. Words that build
  sentences (conjunctions, pronouns, auxiliaries, modals, question words: `STRUCTURAL_WORDS`) are never part of a
  side-effect action's vocabulary, even when its description uses them ("… or every light"). The action's verbs (the
  first word of its label or an example, used nowhere later in them, naming no value: "turn", "switch", "dim", "set",
  "doe", "zet") must come before any other content word ("the kitchen lights turn on" is a statement). `stemWord` no
  longer strips -ing and -ed ("turning on …", "… turned on" are not the imperative). So statements ("I like the kitchen
  lights on"), questions about the world ("will the kitchen lights turn on", "did you turn on …"), reported speech ("he
  said turn on …") and conditionals ("if it gets dark …") are handed on; "can you turn on the kitchen lights?" acts.
  Read-only actions keep a lenient reading for a provider's `fits` role only (`mode: "question"`, round 3's word list
  `QUESTION_FILLER`): core never acts on it, and they do not compete with side effects.

Findings: (1) eager "yes", final "yes?" — promotion compares canonical texts, so the turn is decided afresh and "yes?"
is no confirmation (`ConversationRound4.test.ts`, end to end through `makeIntentAgent`); (2) ".5 percent", "–5
percent" — consumed by the span, 0.5 and NaN, asked again "I can't use … What brightness?"; (3) "dim room two" asks for
the brightness, and "room two" as the answer to "What brightness?" is no number; (4) "40 degrees" is no brightness;
(5) "I like the kitchen lights on" and "will the kitchen lights turn on" are handed on; (6) an `EndOfTurn` (or
`EagerEndOfTurn`) with empty or blank text closes the open utterance and any Stop attached to it, discards a
speculative turn and starts nothing — no agent request, no history entry, no canned reply — for every agent kind
(contract: an utterance for which `SpeechStarted` was sent always ends with an `EndOfTurn`, text "" when no words were
recognised; the recognisers are changed by others; `SttEvent` comment and `docs/ARCHITECTURE.md` updated). No sounder
defence than the 20 s lapse exists against a recogniser that never closes an utterance: `Conversation` sees events and
their times, not audio, so it cannot tell a `SpeechStarted` that begins a new utterance from one a recogniser repeats
inside the stopped one, nor long speech without events from silence; a rule that lifted the cancellation on a second
`SpeechStarted` or after a gap would let the rest of a stopped utterance act; (7) a pending question or confirmation is
kept only if its action is among the actions this plan offers (at most 255, lists readable), not merely enabled.

Usability, each by a closed list: a trailing politeness phrase (`closing`: "please", "thanks", "thank you (very
much)", "thanks a lot", "many thanks", "cheers", "for me", "alsjeblieft", "alstublieft", "graag", "dank je (wel)",
"dankjewel", "dank u (wel)", "dankuwel", "bedankt", "voor mij", "voor me") after a complete request; a leading or
trailing manner word (`manner`: "quickly", "now", "right now", "immediately", "right away", "snel", "nu", "even",
"meteen", "nu meteen", "direct"). Not: text after "please", a manner word inside the request ("turn on quickly the …",
"doe snel het licht aan"), politeness first.

Tests: `packages/core/test/AccountedRound4.test.ts` checks every row against every confident answer a provider could
give (each action, each option combination, "answers" yes and no): the seven findings, a table per rule (rule 1: every
dash and minus at each edge of a number, decimal marks at each edge, "?", "!" and "." on commands and confirmations,
eager and final; rule 2: option names with number words, fillers, a yes-word, a unit, crossing and equal spans, one
number for two parameters; rule 3: every number unit against brightness, heating, colour and timer parameters, in
requests and replies; rule 4: statements, questions about the world, reported speech and conditionals made only of
individually allowed words, and the request constructions), the usability lists, and a property: 400 sentences made
from five valid commands (English and Dutch) by 1–3 random insertions, deletions, substitutions and glued marks drawn
from all the closed lists, number words, units, option names, yes-words, negations and punctuation; for every
sentence and every confident answer, an outcome with a side effect occurs only if the sentence is a valid command —
after removing ignorable punctuation, free fillers, and the closed request construction at its edges, exactly one
room name, the action's particle and at most a verb (first) and a light word, or for brightness a verb, the room and
40 with an optional unit, as written out in the test — and then only with that command's action and values. Result:
62 of the 400 were valid, 54 were acted on, 0 violations (the first runs found that function words of descriptions
and dangling prepositions let truncated commands act; both are fixed above).

Interfaces changed: `IntentWords` gains required `opening`, `askFrame`, `wantFrame`, `manner`, `closing`,
`replyFiller` and `filler` shrinks to free words (`extendIntentWords` merges them all); `ValueCandidate` gains
`unit?`; `NumericSpan` gains `unit?`; `ParamPlan` `missing` gains `start?`/`end?`; `DecisionPlan` gains `text` (the
canonical text, which offsets refer to) and `explained`; `ActionAccounting` gains `text`, `marks`, `verbs`, `values`,
`ambiguous`, `reserved` (its `numbers` carry character offsets and units); `unexplainedForRequest` takes `asked?`;
`parseValues` reads the canonical text (candidate text and offsets refer to it: "twenty-one" is "twenty one"); new
exports from `Utterance.ts` (`canonicalUtterance`, `readUtterance`, `sameUtterance`, `DASH`, `MINUS`,
`IGNORABLE_OUTSIDE_NUMBERS`, `Mark`, `Utterance`), `Accounting.ts` (`allOptionMentions`, `assignRoles`, `NUMBER_ROLE`,
`actionWords`, `requestFrame`, `account`, `STRUCTURAL_WORDS`, `QUESTION_FILLER`, `mentionChars` and their types) and
`ValueParsing.ts` (`unitFits`, `paramUnit`, `NumberUnit`); `stemWord` keeps -ing and -ed.

Commands that used to work and are now refused or asked about (handed to the conversational agent unless noted): a
"?" after a command without an asking frame ("turn on the kitchen lights?", "I want … on?"); pronouns, modals and
discourse words outside the request construction ("turn it on", "make the kitchen 40 percent" — "make" is a reply
word now —, "also turn on …", "… too", "then …"); a fresh request with no action word ("the kitchen", "the bedroom 40"
after "What brightness?" for the kitchen); a request two actions explain alike ("turn the kitchen lights", "kitchen
lights", "lights"; "switch everything off" when the provider picks `lights_off`; "set the kitchen to 20" when a
heating action exists); a command ending in a preposition, article or possessive; -ing and -ed forms; a verb after
another content word ("in de keuken doe het licht aan"); a number with a unit for a parameter of another unit or of
none; "5.percent", "5,percent", "40,5" for an integer parameter (asked); one number for two parameters, or two
unit-less numbers for two parameters (asked); and a speculative intent turn whose final transcript differs in case,
in a mark the canonical text keeps, or in a comma next to a number (decided again, about 250 ms later).

Cost, measured on this machine (no extra decision request): plan plus interpretation ≈ 114 µs per sentence with 8
actions (`AccountedRound4.test.ts`) and ≈ 70 µs with 5 actions (`AccountedFor.test.ts`; round 3: ≈ 50 µs); the
keyword decision ≈ 142 µs (7 actions).

### Review fixes, fifth round (core, intent path, tools) — 2026-11-14

A fifth review found three more ways through the rule, plus gaps in round 4's property test (its oracle reused the
production word lists and frame stripping, so it accepted what the code accepted). Each line replaces what the entries
above or the sections below say.

- **Every promotion compares canonical texts** (replaces round 3's "Conversational agents keep `normalizeTranscript`").
  Whatever agent kind planned a speculative turn, it is promoted only if the final transcript is canonically the same
  as the eager one (`sameUtterance`); `normalizeTranscript` is removed. Before, a turn planned for a model agent used
  the looser comparison and could still reach an intent agent by `Handoff` or failure fallback: "hey jev switch
  everything off", then eager "yes" to `main`, `main` hands off, jev reads "yes" as the confirmation, final "yes?" —
  promoted, and everything was switched off (`ConversationRound5.test.ts`). Cost, measured over every eager/final pair
  that the core, agent-intent, modules-builtin and assistant test suites send (49 pairs): 38 promotions before, 27 now;
  the 11 lost were all model turns, and differed only in a sentence-final "?" added (7, four of them with a capital
  first letter as well) or a capital first letter alone (4, the final "." or "!" being ignorable either way; one also
  dropped an apostrophe, "what's"/"whats"). So the looser rule differed from the strict one not only on
  end-of-sentence punctuation but also on capitalisation. Recorded runs: the 105 live bench turns in `bench-out/`
  (stt-sherpa, 5 configurations) were all promoted, and stay so: sherpa's eager transcript is the very text its
  `EndOfTurn` carries when the user does not resume. stt-deepgram's eager and final transcripts may differ in case or
  punctuation; that is unmeasured (no recordings). A lost promotion costs one fresh decision on the final words
  (≈ 250 ms later), not a wrong action.
- **Characters belong to the span that won their words** (`Accounting.ts`, `Decision.ts`). Only a number span that
  kept the number role and is in use consumes its sign, decimal mark and unit; a number absorbed into an option's name
  gives them back, so "turn on room -two", "room –two", "room two%", "room two°", "the forty° degrees lamp" are not
  accounted for (they acted on "Room two" / "Forty degrees lamp"). The accounting now asserts a **partition**
  (`partitioned`, inside `account`): every character of the canonical text is owned by exactly one winning value span
  (its words and the marks it consumes), a word outside values (already given its role), or the closed ignorable set
  (a single space, a comma before a space outside every winning span, the final "?" of an asking frame). Two winning
  spans claiming one word or mark, or a character nobody owns, reports `NOT_PARTITIONED` and the sentence is not
  accounted for (tested directly in `AccountedRound5.test.ts`).
- **An unfinished request is never acted on.** `requestFrame` no longer strips a dependent filler (article,
  possessive, preposition: `DEPENDENT`) at either edge, so it stays in the body, where it must be followed by what it
  places: "turn on the kitchen lights for my", "… at", "… to", "… for", "… for my please", "… to now" are handed on. A
  dependent right before the verb places nothing either ("at set the kitchen …", "the dim the kitchen …").
- **A number after a time or condition word is no value** (`TIME_BEFORE_NUMBER`, `TIME_BEFORE_DURATION`): after "at",
  "by", "until", "till", "after", "before", "around", "since", "from", "past", "in", "within", "om", "tot", "na",
  "voor", "vanaf", "rond", "omstreeks", "sinds", "tegen", "uiterlijk", "over", "binnen" a number is no candidate for a
  number parameter; for a duration parameter the same words count except "in", "within", "over", "binnen", "voor". One
  exception: "at" with the parameter's own unit said is a value ("at 50 percent"; "by 10 percent" is a change, not a
  level). So "dim the kitchen at 7", "… at seven", "at 7" as the answer to "What brightness?" are not acted on.
- **An empty `EagerEndOfTurn` does not end the utterance** (corrects round 4's description, which said it did; the code
  already behaved so). It discards a speculative turn and starts nothing, but the utterance stays open and a Stop
  stays in force until its `EndOfTurn` (or the 20 s lapse): an eager event, outside the contract, must never lift a
  cancellation. Stated with `SttEvent` and in `docs/ARCHITECTURE.md`.
- **Holes the new property found, fixed:** a cut-off word named an option by stem ("turn on the kitch"; a said word
  shorter than the name's word no longer matches by stem); phonetic keys dropped every non-ASCII character ("room
  t٠wo" sounded like "room two"; phonetic keys only for plain letters); `normalizeWord` used compatibility
  decomposition, so "4²" read as 42 and "４０" as 40 (now NFD); a comma inside a name or glued to a word was ignorable
  ("dim the room, two to 40", ",dim …"); an article was skipped inside a name where the name has none ("forty the
  degrees lamp"); "seventy- five" / "seventy‑ five" read as 75 (a hyphen counts only glued on both sides); an action
  was chosen by its rival's range ("set the kitchen to 35" set the brightness because 35 is no temperature: an
  out-of-range number is no missing value in the one-action check); "-0" and "minus zero" were 0 (a signed zero is in
  no range); ",0" and ".0" were 0 (a leading decimal mark needs a non-zero digit); a quote inside a word split it
  ("a`t 82" became "a t 82", escaping the time rule; a quote between two letters or digits is a mark);
  `isConfirmation` accepted a glued comma (",nu correct yeah", "yes,ok"; it now refuses every mark the canonical text
  keeps); a broken longer name fell back to a shorter name inside it ("the lamp in in the hall" acted on "Hall", "the
  desk to lamp" on "Desk"; `shadowingOptions` makes such a mention ambiguous, so it is asked); "t" ('t) right before a
  number word ("for t eight seconds", cut from "thirty eight") is unexplained.
- **Confirmation is enforced for action tools** (supersedes "not enforced: §7" above). See §3.2: for an action declared
  `confirm: true`, the first call of its generated tool only records the request and tells the model to ask; the action
  runs on a later turn's call with the same values when that turn's words are a confirmation (`isConfirmation`) and the
  pending confirmation is still valid by the intent path's rules. One pending question or confirmation per conversation
  (`PendingIntents`, created by `Conversation`, `AgentTurnInput.pendingIntents`), shared by the intent agent and the
  tools; a committed turn whose words are not a confirmation ends a pending confirmation of an earlier turn, whichever
  agent answers it.

**The property** (`PropertyRound5.test.ts`, replacing round 4's): valid commands are built from templates in literal
data — opener, verb phrase, one target written as an option's name, a value with its unit, closer — with their meaning
recorded as they are built, for a house whose names contain number words, digits, fillers, a yes-word, a unit and
prefixes/suffixes of other names; nothing is imported from the production word lists. A sentence must act iff it is an
instance (looked up in the full set of instances, never parsed) and then with its recorded meaning, against every
confident provider answer, fresh, as the answer to "What brightness?" and to "Switch everything off?". Edits: insertion,
deletion, substitution, transposition and duplication of words; insertion of 76 literal symbols (every dash and minus,
decimal marks, `% ° ? ! & / @ # + =`, brackets, quotes, zero-width and non-breaking spaces, full-width, Arabic-Indic and
Devanagari digits) at every position of six probe sentences; character deletion, duplication and truncation; truncation
after every word and character; a second number, a unit swap, a sign flip; negations, prohibitions, times and
conditions. The design's tolerances (an article or value preposition before a value, a stutter, "lights"↔"light", the
verb left out, the unit word anywhere, a recogniser's doubled letter) are decided from the roles the tokens were built
with (`benignMeanings`); such a result may act with the base meaning but need not. Promotion: an eager instance and a
final one edit away are promoted (`sameUtterance`) only if they are the same instance. All quoted inputs of rounds
1–5 run as fixed regressions in all three contexts. 3 000 random edited sentences plus the exhaustive parts, seed
20261114 (printed on failure; `PROPERTY_SEED`, `PROPERTY_CASES` override), ≈ 18 s on this machine; 216 of the 3 000 edited sentences are instances, 281 act, 0 violations; 0 also for seeds 1–7
and 12. Confirmation questions asked on non-instances ("switch off", "lights" → "Switch everything off?") are counted, not
failed: asking runs nothing, and only a reply in the closed grammar confirms.

Interfaces changed: `AgentTurnInput.pendingIntents?` (new, optional); new `PendingIntents.ts` (`PendingIntents`,
`PendingEntry`, `makePendingIntents`, `confirmingTools`, `ConfirmingContext`, `PENDING_MS`); new exports
`confirmQuestion`, `actionValues`, `shadowingOptions`, `NOT_PARTITIONED`, `TIME_BEFORE_NUMBER`, `TIME_BEFORE_DURATION`;
`normalizeTranscript` removed; `normalizeWord` uses NFD; the generated tool description of a `confirm` action says the
first call does not run it.

Commands that used to work and are now refused or asked about (handed on unless noted): a speculative turn of any agent
whose final transcript differs in case or a final "?" (decided again from the final words); a number after a time or
condition word, without the parameter's unit after "at" ("dim the kitchen at 7", "set the kitchen colour to 40 at 60",
"room two at 40" as a reply); a unit-less number outside one rival's range ("set the kitchen to 35" with a heating
action); a request ending in an article, possessive or preposition, also before politeness or a manner word; an article
or preposition first or right before the verb; a name said cut off, with a glued comma or mark, with an article where it
has none, or broken by an inserted word when a shorter name lies inside it (asked); "-0", ".0", ",0" (asked); superscript
or full-width digits; "seventy- five" (asked); "'t" before a number; a confirmation with a glued comma; and an action
with `confirm: true` called by a conversational agent: it now takes a confirmation from the owner and a second call.

Cost, measured (this machine): plan plus interpretation ≈ 110 µs per sentence with 8 actions (`AccountedRound4.test.ts`)
and ≈ 65 µs with 5 actions (`AccountedFor.test.ts`); the keyword decision ≈ 126 µs (7 actions) — the same as round 4
within noise; no extra decision request. A confirming tool call adds a map lookup and one `isConfirmation`.

### Review fixes, sixth round (core, intent path, tools) — 2026-11-14

A sixth review (a different model) found the fifth round's tool confirmation unsound and three other problems. Each line
replaces what the entries above or the sections below say.

- **Confirmation is an interaction core conducts** (finding 1, 2; replaces round 5's "Confirmation is enforced for
  action tools"). The model is no longer in charge of asking or of calling again: see §3.2. Proposal → core's question →
  armed when presented → the next committed turn is offered to it before routing → one consumption operation
  (`consumeConfirmation`) immediately before execution. Round 5's second-call mechanism (`confirmingTools`,
  `PendingIntents.committed`) and its tests are removed. The reviewer's probes now fail to run anything: a proposal
  followed by a `Handoff` in the same turn ends the agent's stream at the proposal (no fallback runs, and the intent
  agent never acts on a `confirm: true` action anyway — it proposes); an eager "yes" at 14 s and its final at 16 s after
  arming is consumed at promotion with the clock read then, the window has closed, and the turn is answered as a fresh
  request; a "yes" can only answer the action's own question, because core asks it and nothing follows it.
- **One pending slot, newest wins.** The conversation's `PendingIntents` holds either the intent agent's parameter
  question or an armed confirmation. A confirmation armed after a question replaces it; a question stored after a
  confirmation replaces it (and any committed turn that does not answer a confirmation drops it). A new proposal while one
  is pending drops the older one when its turn commits, and its question is the one the owner hears. The intent agent
  ignores a confirmation in the slot.
- **Every route that can run an action's `run`:**

  | Call site | `confirm: true` action |
  |---|---|
  | Intent agent, act path (`IntentAgent.ts`) | never run: a `Confirm` outcome, or an `Act` of such an action, emits `ConfirmAction` (a proposal) |
  | Generated tool (`actionTool` execute, `Actions.ts`) | always refused (error result), whoever holds the registry |
  | `Conversation`'s tool wrapper (`proposingTools`, every model and harness agent's `AgentTurnInput.tools`, the single-model `Conversation.layer` too, via `ToolRegistry.actionFor`) | turned into a proposal, never run |
  | Core's confirmation answer (`runConfirmed`, `Conversation.ts`) | runs only after `consumeConfirmation` succeeds, at execution time |
  | `ModuleHost.fieldAction("test")` (`testAgent`, `testDecider`) | runs no module action (an agent with no tools; a decision over its own no-op fixtures) |
  | `apps/assistant`, other packages | no direct call of `run` or of a registry's `run` outside `Conversation` (searched) |

- **Possessives and meaning-bearing suffixes** (finding 3). `words()` marks a word said with a possessive suffix and its
  apostrophe (`Word.possessive`: "bedroom's", "kids'"; the norm still drops the apostrophe). An option's name word is
  named by the same word, the same sound, or a plural (-s, -es after a sibilant, -ies) — no longer by any stem: -en,
  -er, -ing, -ed, -je and cut-off forms name nothing ("wooden" is not "Wood", "listen" not "List", "lampje"/"lampen" not
  "Lamp"). A possessive, or a bare plural, as the last word of a mention is a DEPENDENT form (`WordSpan.possessive`): like
  an article it must be followed at once by a content word of the action that it possesses ("turn on the bedroom's
  lights" acts); at the end, or before a filler, preposition, closer or manner word ("turn on the bedroom's", "… the
  bedroom's please", "dim the bedroom's to 40 percent", "turn on the living room's") the request is not accounted for. A
  name with an apostrophe of its own ("Kids' room", "Mary's") still matches with or without it. A bare trailing
  "bedrooms" is treated as possibly "bedroom's" with the apostrophe dropped (recognisers drop it): handed on. It is also
  a plausible plural, but a plural of a single named room or lamp is rare in a command, so the cost is small and an
  unfinished sentence never acts.
- **A transcript with no utterance open is ignored** (finding 4). `EagerEndOfTurn`, `TurnResumed` or `EndOfTurn` with
  no `SpeechStarted` since the last `EndOfTurn` starts, promotes, discards and interrupts nothing (logged at most once per
  10 s). Stated with `SttEvent` and in `docs/ARCHITECTURE.md`. Typed text, `Say` and Stop are unaffected. stt-sherpa keeps
  the contract (it sends `SpeechStarted` before an eager or final transcript of a turn it had not opened). stt-deepgram
  does not in three places after a reconnect (see "Not held" below). The scripted fakes of `@pva/core/testing`
  (`scripted`, `makeScriptedStt`) insert the `SpeechStarted` a contract-keeping recogniser sends (`withSpeechStarted`;
  `scriptedRaw` sends events as written; `sttContractKeeper()` for fakes that emit in several calls).
- **The property** (finding 5). `benignMeanings` no longer allows a broken longer name to fall back to a shorter name
  inside it, nor a time or condition word right before the number ("dim the lamp in the to hall to 40 percent", "dim
  the kitchen in 40 percent"); the round 6 sentences are fixed regressions. New end-to-end property cases
  (`ConversationRound6.test.ts`) run the real `Conversation` with recogniser events: eager and final transcripts one
  mutation apart, direct, across a hand-off and a failure fallback, with and without an armed confirmation; an action
  runs only when the final transcript alone (run in a fresh conversation) runs it.
- **`PlaybackObserver.final`** (agreed with the audio fixer). When called, the clauses heard are recomputed from that
  count and may shrink, before history is committed; later `progress` is ignored; the confirmation question's arming
  uses it. A `ClausePlaying` already emitted for a clause found not heard is not recalled: the UI keeps showing that
  clause as played while history (and what agents see) leaves it out. **For the lead:** a protocol event
  ("clauses heard: n", or `ClausePlaying` with a lower index) would let the UI correct it; none was added.

Interfaces changed: new `AgentEvent` `ConfirmAction`; `PendingEntry` gains `armedAt?`, `agentId?`; `PendingIntents`
loses `committed`, gains `dropConfirmation`; `makePendingIntents()` takes no words; removed `confirmingTools`,
`ConfirmingContext`; new `proposingTools`, `ProposalContext`, `PROPOSED_RESULT`, `consumeConfirmation`,
`confirmationAnswer`, `isConfirmationEntry`, `needsConfirmation`, `CONFIRM_WINDOW_MS`, `checkedActionValues`,
`CONFIRM_CANCELLED_TEXT`, `PROTOCOL_LOG_MS`; `Tool.action?`, `ToolRegistry.actionFor?`; `Word.possessive?`,
`WordSpan.possessive?`; conversation options `confirmWindowMs?` and `intentWords?` (give the conversation the same lists
as `makeIntentAgent({ words })` when a household extends them: confirmations are core's now); `@pva/core/testing` gains
`scriptedRaw`, `withSpeechStarted`, `sttContractKeeper`, and `scripted`/`makeScriptedStt` insert `SpeechStarted`.

Commands that used to work and are now refused or asked about: a confirmation through a second tool call (calling the
tool makes core ask; the answer goes to core); a "yes" to a confirmation that reaches an agent (only core answers it); a
"yes" over the first clause of a two-clause question, after Stop, or after the window (now counted from the end of the
question, not from the proposal); the intent agent's `words` no longer decide confirmations (pass `intentWords` to the
conversation); a possessive or bare plural of a name at the end of a request or before a filler ("turn on the bedrooms");
a Dutch -en plural or other inflection of a name ("doe de lampen aan" for a lamp named "Lamp"); a final or eager
transcript without `SpeechStarted` (a recogniser outside the contract).

**Not held / needed outside these packages.** (1) `packages/stt-deepgram/src/FluxConnection.ts`: after a reconnect in
the middle of an utterance, the continuation can arrive as `EagerEndOfTurn` (its branch never checks `speechStarted`),
as `EndOfTurn` with text but `started` false (`if (final || started)`), or from `endOpenTurn` with `open && text` and no
`SpeechStarted`; each is now ignored. Change needed there: emit `SpeechStarted` (and set `speechStarted`) before an
`EagerEndOfTurn` or `EndOfTurn` whenever `speechStarted` is false. (2) `apps/assistant/test/support/serveHarness.ts`
`controlledStt().emit` sends finals without `SpeechStarted`; 11 tests of `serve.test.ts` now time out. Change needed:
`const keep = sttContractKeeper()` and `emit: (...events) => keep(events).forEach(...)`. (3) `apps/assistant` should pass
the same `intentWords` to the conversation as to `makeIntentAgent` if it extends the lists.

### Review fixes, seventh round (core, intent path, stt-deepgram) — 2026-11-14

A seventh review (a different model) found four high and four medium problems. Each line replaces what the entries
above or the sections below say; §3.2 now describes the confirmation mechanism as a whole.

- **An answer is eligible only if it began after the question had been played to its end** (finding 1; replaces round
  6's "armed … when the owner interrupted it after its final clause had started"). What an utterance may answer is fixed
  at its `SpeechStarted` (typed: at submission) and never improved by later playback reports or a `final` count. Arming
  needs the question's turn to complete with everything played. An earlier utterance interrupts and drops the question
  (barge-in) or cannot answer it (no barge-in); a yes from it is answered with `ConfirmTexts.tooEarly`, a no with
  "OK, I won't." When the proposing turn said anything before the question, the question is preceded by "To confirm:".
  Outcome by start of the answering utterance (two-clause question, played [0, 200) ms, armed at 200; tests in
  `ConfirmationRound7.test.ts`, each with barge-in on and off): before any audio — not run; during earlier speech of the
  turn — not run; during the lead-in — not run; during the first clause — not run; during the last clause — not run;
  exactly at the end (the speech event is handled before playback ends) — not run; after the end — run; after the window
  — not run ("too late"); typed during the question or at its end — not run, after it — run; a final count lower than
  the progress known when the utterance began — not armed; a higher one — not eligible; equal to the whole question —
  armed.
- **The question states every value that will be executed** (finding 2): `confirmationQuestion` (§3.2 step 2). A
  function that leaves a value out, names another option, throws or returns nothing refuses the proposal (nothing asked,
  the agent told why, `ConfirmTexts.refused` spoken); there is no fallback to a question without the values. A boolean
  parameter with a module's own text is refused (free text cannot be checked for it). Checked: the only built-in
  `confirm: true` action is demo-home `all_off` (no parameters, `confirm: true`: asks "Switch everything off?",
  unchanged); `packages/module-home-assistant/src` declares no `confirm` action, so nothing there is refused.
- **Validation, consumption and the start of the action are one step at promotion** (finding 3). `resolveAnswer` runs
  uninterruptibly when the answering turn is committed (started committed, or in the `EndOfTurn` handler before the
  promotion is released): checks against the present moment, removes the entry, forks the action detached. Only then is
  anything said: the announcement, then the result or "Done." only after success, a failure as a failure. Interrupted
  speech or an abandoned text stream does not cancel or lose the action; its real outcome reaches history (§3.2 step 8).
  The reviewer's probes: a module removed and the clock advanced while the first chunk is paused — the action had
  already run once, at consumption; a consumer that takes one chunk — the action runs and history records its outcome.
- **stt-deepgram: duplicates by turn index** (finding 4). Per connection, the highest Flux `turn_index` that ended is
  kept; any `StartOfTurn`, `Update`, `EagerEndOfTurn`, `TurnResumed` or `EndOfTurn` for that index or a lower one is a
  duplicate and dropped (logged at most once per 10 s, `DUPLICATE_LOG_MS`). A `SpeechStarted` is synthesised only for a
  turn not opened and not ended. A new connection starts afresh (indexes are assumed, not documented, to restart). A
  message without an index: a final or eager transcript right after a final, with no start or interim between, is
  dropped. Never by transcript text.
- **The single-model API consumes its own confirmations** (finding 5): `layer` / `layerWithSetup` offer the turn's
  registry's action tools (`ToolRegistry.actionFor`) as the turn's actions; a registry replaced between question and
  answer holds new registrations, so the answer is "no longer available".
- **Every answered confirmation is spoken and recorded** (finding 6): "Done." when the action supplies no words;
  outcome notes in history for ran/failed/cancelled/too early/window closed/no longer available/refused (§3.2 step 8,
  `docs/ARCHITECTURE.md`). A yes that comes too late or for a vanished action is no longer passed to the agent as a
  fresh request: core says why.
- **Action words: no -en stemming** (finding 7). `stemWord` strips only plural/third-person -s, -es after a sibilant
  and -ies ("listen" no longer matches "List", "lichten" no longer "licht", "zetten" never matched "zet"). Dutch forms
  an action needs belong in its label, description or examples. Every example of the built-in modules decides exactly
  as before (checked over every confident answer).
- **The final count decides history whatever the outcome** (finding 8): a completed turn whose final count is below
  what was handed over is recorded like an interrupted one, and never arms a question.

Interfaces changed: `confirmationQuestion`, `spokenValue`, `describeProposal` (Decision.ts; `confirmQuestion` now
returns "" for a refused proposal); `ProposalContext.propose` returns `boolean | string` (the refusal reason);
conversation option `confirmTexts?: Partial<ConfirmTexts>`, exports `ConfirmTexts`, `DEFAULT_CONFIRM_TEXTS`,
`DUTCH_CONFIRM_TEXTS` (`CONFIRM_CANCELLED_TEXT` kept); stt-deepgram exports `DUPLICATE_LOG_MS` from `FluxConnection.ts`.

Commands that used to work and are now refused or asked about: a "yes" spoken over the last clause of a confirmation
question (or at the same moment it ends) — now "the question hadn't finished … please say your request again"; a typed
"yes" sent while the question is still playing; any `confirm` function that does not name the values it confirms, or
throws (before: asked with the label) — now refused; a confirmed action with a boolean parameter and its own question
text — refused; action vocabulary reached only through -en stemming ("listen music" for "List music", "zet de lichten
aan" when the examples only say "licht"); a Flux transcript repeated for an ended turn.

### After the final review (core) — 2026-11-14

The final review (no further review is available) reproduced two ways for the wrong answer to authorise a confirmed
action, plus three smaller faults (listed under "Known limitations" at the start of §3.2). Instead of repairing the
mechanism again, the system now fails closed and the part that is unsound by construction is gone. Each line replaces
what the entries above or §3.2 say.

- **Confirmation-required actions are off unless enabled.** New conversation option `confirmActions: "off" | "on"`,
  default `"off"`, read once when the conversation is made (it cannot change during a conversation's life). While off, a
  proposal of a `confirm: true` action is refused where it would become THE proposal of the turn, before anything can be
  pending: no question, nothing run. A model or harness gets `CONFIRMATIONS_OFF_RESULT` as its tool result ("… requires
  confirmation by the owner, and confirmations are switched off in this assistant's settings, so it cannot be run …");
  the intent agent's `ConfirmAction` takes the existing refusal path. The owner hears `ConfirmTexts.switchedOff` ("I
  can't do that: it needs a confirmation step, and confirmations are switched off." / "Dat kan ik niet doen: daarvoor is
  een bevestiging nodig, en bevestigen staat uit."); history gets the usual refused-proposal note with reason
  `CONFIRMATIONS_OFF_REASON`. A later "yes" is an ordinary message. Actions without `confirm: true`, parameter
  questions, speculation, promotion, routing and history are unchanged. With `"on"` everything is as described in §3.2.
  The application passes no value, so confirmations are off; to switch them on it passes `confirmActions: "on"` to the
  conversation (`makeConversationWithSetup` in `apps/assistant/src/serve/Engine.ts`; `Conversation.layer` in
  `apps/assistant/src/main.ts` and `voice.ts`).

  | Call site | `confirm: true` action while `"off"` |
  |---|---|
  | Intent agent, act path (`IntentAgent.ts`) | unchanged: emits `ConfirmAction`, never runs it; `Conversation`'s `propose` refuses it |
  | Generated tool (`actionTool` execute, `Actions.ts`) | unchanged: always refused, whoever holds the registry |
  | `Conversation`'s tool wrapper (`proposingTools`) | `propose` refuses; the call is answered with `CONFIRMATIONS_OFF_RESULT` |
  | `Conversation`'s `propose` (both routes above end here) | first check: refused before `log.proposal` is set, so no question and no arming |
  | `armProposal` | no proposal to arm; guarded again (no pending entry while off) |
  | `resolveAnswer`, the only caller of `startConfirmed` (formerly `runConfirmed`) | second check, at execution, before `consumeConfirmation`: dropped, nothing run |
  | `ModuleHost.fieldAction("test")` | unchanged: runs no module action |

- **The confirmation question is always core's.** `confirmationQuestion` no longer calls a module's `confirm` function
  and no longer verifies free text: the question is the label, then each parameter's label and spoken value (a number
  with its unit: "Set the level: level 40 percent?"), or the label with "?" when there are no values. A `confirm`
  function still type-checks and is simply not called; the module host logs one warning per such action when the module
  starts. The round 7 refusals of a module's text (vague, wrong, throwing, empty, boolean) are gone with it.

Interfaces changed: conversation option `confirmActions?`; `ConfirmTexts.switchedOff`; new `CONFIRMATIONS_OFF_REASON`,
`CONFIRMATIONS_OFF_RESULT` (`PendingIntents.ts`). Commands that used to work and are now refused: every `confirm: true`
action (demo-home `all_off` among them) while `confirmActions` is not `"on"`.

**Who reads what**

| Reader | Sections |
|---|---|
| Everyone | [0. Decisions at a glance](#0-decisions-at-a-glance), [6. Build plan](#6-build-plan), [9. Changes to existing interfaces](#9-changes-to-existing-interfaces) |
| Agent core and routing (piece A) | [1. Agents](#1-agents), [2. Routing](#2-routing-by-trigger-phrase) |
| Intent path and modules (pieces C, D, K) | [3. Typed intents](#3-the-typed-intent-path) |
| Adapters (pieces E, F, I, J, L) | [1.6–1.9](#16-agents-are-modules), [3.7](#37-decision-providers) |
| Settings, protocol, UI (pieces G, H) | [4. Settings](#4-settings), [5. Protocol and UI](#5-protocol-and-ui-changes) |

**Already in the repository (written with this document; nothing uses it yet, nothing existing was changed)**

| File | What | Tests |
|---|---|---|
| `packages/core/src/Agent.ts` | `Agent`, `AgentTurnInput`, `AgentEvent`, `AgentError`, `IntentDecisionInfo` | (types) |
| `packages/core/src/Routing.ts` | `Router`, `RoutingConfig`, `RouterState`, `RouteDecision`, `makeTriggerRouter` (tolerant trigger matching, stickiness, arming, availability fallback), `armAgent`, `setActiveAgent`, `activeAgent` | `test/Routing.test.ts` (24) |
| `packages/core/src/TextMatching.ts` | words with offsets, normalisation, phonetic keys, edit distance, spelled-letter joining (finished from the interrupted attempt) | `test/TextMatching.test.ts` (19) |
| `packages/core/src/Actions.ts` | `defineAction`, `Param.*` (six parameter kinds), `ActionError`, `RegisteredAction`, `actionToolName` | via `Decision.test.ts` |
| `packages/core/src/Decision.ts` | `DecisionProvider`, request/response types, `buildDecisionPlan` (one request per utterance), `interpretDecision` (thresholds, ask, confirm, fallback), `makeScriptedDecider` | `test/Decision.test.ts` (14) |
| `packages/core/src/ModuleContributions.ts` | `ModuleContributions` (agents, actions, deciders, dynamic options, info, field actions), `defineAgent`, `defineDecider` | `test/AgentModules.test.ts` |
| `packages/core/src/SettingsExtra.ts` | the five new field types' constructors and validation (`textList`, `records`, `combo`, `action`, `info`) | `test/AgentModules.test.ts` (12 in total) |
| `packages/protocol/src/agents.ts` | every protocol addition as a schema: new field types, `SettingFieldV2`, new messages, optional fields for existing structs, `ErrorCodeV2`. **Not** in the unions; `PROTOCOL_VERSION` still 1 | `test/agents.test.ts` (10) |
| `packages/protocol/src/agentExamples.ts` | examples of the additions (`@pva/protocol/agent-examples`) | |

The only edits to existing files: export lines in `packages/core/src/index.ts` and `packages/protocol/src/index.ts`, and the
`./agent-examples` entry in `packages/protocol/package.json`.

---

## 0. Decisions at a glance

| Topic | Decision | Why (short) |
|---|---|---|
| Agent interface | One `Agent` with `turn(input) → Stream<AgentEvent, AgentError>`. Three kinds: `model` (assistant runs the tool loop), `harness` (own loop and session), `intent` (decide and act) | `Conversation` treats every kind alike: text deltas to TTS, rounds to history, interruption by fiber |
| Existing `Llm` | Unchanged contract for "one model call". The tool loop moves out of `Conversation` into `makeModelAgent(llm)`; every `Llm` adapter gains a 30-line agent file | No adapter rewrites; the Anthropic adapter becomes one agent among several |
| Where agents live | **Agents are modules** (kind `agent`), decision providers are modules (kind `decider`), actions are a module contribution. Same host, settings, persistence, form, enable switch | "One file plus one line" for every pluggable thing; live reconfiguration (no engine reload) for agents |
| History | One shared transcript owned by `Conversation`. Model agents read it every turn; harness agents keep their own session and are sent a compact catch-up of what other agents said since their last turn | Switching agents mid-conversation keeps context; harness sessions cannot be rewritten |
| Speculation | Model agents: as today. Intent agents: decide speculatively, act only after promotion (read-only actions may run early). Harness agents: **wait for promotion by default** (setting to speculate) | A harness cannot take back a sent message, and a discard wastes subscription quota; ≈ 270 ms is the price, switchable |
| Routing | A pure, synchronous `Router` (≈ 10–16 µs measured) at the start of every turn, speculative ones included. Rules are settings data. Trigger at the start of the utterance; tolerant matching (greeting words interchangeable, phonetic keys, one edit for longer names, spelled letters, fillers skipped) | Zero added latency; misrecognitions like "hey Jeff" handled without the owner listing every variant |
| Trigger scope | Per rule: `turn` (that utterance) or `conversation` (sticky until another trigger, "hey assistant", the UI, or 2 min idle). Defaults: Jev `turn`, conversational agents `conversation` | Commands are one-offs; a follow-up question to Claude should stay with Claude |
| Trigger only ("Hey Jev.") | Speak "Yes?" (no model call) and arm that agent for the next utterance (10 s) | The natural pause after a wake phrase must not lose the command |
| Unavailable agent | The default agent answers, preceded by "Codex isn't available." when the owner asked for that agent on purpose; an agent that fails before saying anything is retried once on the default | The owner always gets an answer and knows who gave it |
| Typed intents | Modules declare actions with typed parameters of six kinds; ONE decision request per utterance (action choice + "does any fit?" + "several at once?" + every choosable parameter of every action); numbers, durations and free text parsed locally | Jev only chooses among supplied options; one round trip keeps it ≈ 250 ms |
| Low confidence | Not a command or not surely one → the conversational agent takes the turn (silently). Clear action, unclear or missing value → ask a short question ("Which room?") and arm the agent for the answer. Several actions at once → conversational agent | The conversational agent handles ambiguity better than a second decision round; asking is only worth it when the action is clear |
| Actions vs tools | Every action is also a tool for conversational agents (unless `offerAsTool: false`); tools are not automatically actions | "Turn on the living room lights" works through Jev and through Claude; a tool's JSON input cannot be mapped to choice questions |
| Speaking actions | An action's `announce` text is synthesised while the turn is still speculative and plays at promotion, while the action runs | The intent path then plays ≈ 15 ms after end of turn (*estimate*), not after the action's round trip |
| Decision providers | `DecisionProvider` interface: Jev (TypeSafe API, also any `/v1/systemone` server such as Ollama + Nimble), and an offline keyword decider that works with no key | Swappable; the intent path can be tried and tested today |
| Settings | Audit of every setting (§4.1). Five new field types: `textList`, `records`, `combo`, `action`, `info`. New tabs: Agents, Modules, Speech, Voices, This device, About | Everything sensible editable; the UI still renders only what the server describes |
| Voices | Per-voice sections keyed by the existing `VOICE_<NAME>_*` variables (provider, preset, speed, pauses, Cartesia voice), with "Play a sample" | The prefix wrapper already exists: zero adapter change |
| Protocol | All additions defined now in `agents.ts`; merged in one change with `PROTOCOL_VERSION = 2` (new field types are a closed-set change) | Others are building against v1 right now |
| Home automation | A Home Assistant module (areas and lights from HA's template API, cached) and a dependency-free `demo-home` module; `clock` and `weather` gain one action each | The realistic source plus a way to try everything without one |

### 0.1 How the owner's request was read

| Request | Interpretation |
|---|---|
| "Use my Claude and Codex subscriptions … hook into those harnesses" | Two `harness` agents driving the official CLIs with the owner's own login (Claude Agent SDK; `codex app-server`). Off by default, behind an explicit opt-in switch that states the terms are unclear (research §2). The API-key agents stay the supported default |
| "A local AI agent somewhere in my home network, or OpenRouter" | One OpenAI-compatible adapter with per-server profiles, shipped as two catalog entries: `home-model` (Ollama / llama.cpp / LM Studio / vLLM, chosen by a setting) and `openrouter`. A third endpoint is one catalog line |
| "Hey Jev … uses the TypeSafe agent" | "Jev" is TypeSafe's decision model (dictated as "Jeff"). The `jev` agent is the typed-intent responder; its decision provider is Jev when a TypeSafe key is set, otherwise the offline keyword decider |
| "Detect the lights … also send out the location" | An action `lights_on` with one parameter `target` whose values are the rooms and lights the home module knows at run time ("Living room", "Desk lamp", "All lights") |
| "Recognising the actions and having a list of programmatic actions" | Actions are declared by modules next to their tools; the list sent to Jev is built from the enabled modules on every utterance |
| "Modularity is key" | Agents, decision providers, routers and actions are each one interface + one file + one catalog line; routing rules are data |
| "Model and agent choice … API keys, system prompt" | Per-agent settings: model (picked from the backend's own list), keys, an optional per-agent system prompt, speculation, test button; the default agent and the rules in a Routing card |
| "Speech recognition (model, language, wait time)" | Owned by the speech-recognition implementer; this design only places their sections in a Speech tab (§4.4) |
| "Voices (which voice, speed, pauses, per-voice settings)" | Per-voice sections (§4.4), reload to apply, "Play a sample" |
| "Audit everything and expose all sensible settings" | §4.1: every environment variable and constant the app reads, with a verdict |

---

## 1. Agents

### 1.1 Kinds, and what happens to `Llm`

| Kind | Examples | Who runs the tool loop | History | Speculative turn | Barge-in |
|---|---|---|---|---|---|
| `model` | `anthropic` (API key), `openrouter`, `home-model`, `offline` stand-in | The assistant (`makeModelAgent`), as today | Shared transcript sent every request | Runs fully; non-speculative tools wait for promotion (today's rule) | Abort the HTTP request (fiber interruption) |
| `harness` | `claude-subscription`, `codex-subscription` | The harness; our tools are handed to it | Its own session + catch-up preface | **Waits for promotion** unless the agent's `speculate` setting is on | `query.interrupt()` / `turn/interrupt`, session kept |
| `intent` | `jev` | None (no model conversation) | Reads nothing; its spoken text is recorded | Decides speculatively; acts only after promotion unless the action is `speculative` | Stops speech; an action already started finishes |

`Llm` (`stream(request) → Stream<LlmEvent>`) stays exactly as it is: it is the contract for "one model call" and the
easiest thing to implement for a new backend. The `llm-anthropic` adapter is unchanged; it gets an `agent.ts` that wraps
it. The new OpenAI-compatible adapter implements `Llm` too. `LLM_PROVIDER` keeps working: CLI `bench` still uses it, and
when `DEFAULT_AGENT` is unset it picks the default agent (`anthropic` → `anthropic`, `fake` → `offline`). Serve mode stops
building an LLM stage in the engine: agents are modules now, so changing a model or key restarts that agent (10 s grace for
a turn in flight) instead of reloading the engines.

### 1.2 The interface (real code: `packages/core/src/Agent.ts`)

```ts
interface Agent {
  readonly id: string                    // its module id
  readonly name: string
  readonly kind: "model" | "harness" | "intent"
  readonly speculate: boolean            // may run before the turn is committed
  readonly systemPrompt?: string         // replaces the global prompt for this agent (instructions + voice block still appended)
  readonly firstEventTimeoutMs: number   // model 5000, harness 8000, intent 1500
  turn(input: AgentTurnInput): Stream<AgentEvent, AgentError>
}

interface AgentTurnInput {
  turnId; text /* trigger removed */; utterance /* as heard */; source; spoken; routedBy
  history: ReadonlyArray<Message>        // shared, committed only
  system: string; context: string | undefined
  tools: ToolRegistry["Service"]         // module tools + generated action tools
  actions: ReadonlyArray<RegisteredAction>; deciders: ReadonlyMap<string, DecisionProvider>
  promoted: Effect<void>                 // await before any side effect
  speculative: boolean
  mark(mark: TraceMark): void; trace: Trace; maxToolRounds: number
}

type AgentEvent =
  | { _tag: "TextDelta"; text }                     // spoken as it streams; exactly "\n" = round separator (flush)
  | { _tag: "ToolStarted"; call } | { _tag: "ToolFinished"; result; ms }      // recorded in history as rounds
  | { _tag: "Decision"; decision: IntentDecisionInfo }                        // intent agents; UI + trace
  | { _tag: "ActionStarted"; callId; actionId; label; params } | { _tag: "ActionFinished"; callId; ok; ms; error? }
  | { _tag: "ExpectReply" }                         // arm this agent for the next utterance
  | { _tag: "Handoff"; reason }                     // before any text: the fallback agent takes this turn
// Completion = the stream ends. Failure = AgentError { reason: "unavailable" | "timeout" | "failed" }.
```

Contract details:

- **Text.** Deltas are forwarded to the clause chunker unchanged; voice markers work for every agent kind (the voice block is
  in `system`). An agent emits `"\n"` before its first tool call that follows text, so "Let me check," is spoken while the
  tool runs (this is today's behaviour, now the agent's job; `makeModelAgent` does exactly what `assistantText` does today).
- **Rounds.** `Conversation` rebuilds the turn log from events: text accumulates in the current round (the `"\n"` separator
  is not part of it); `ToolStarted` adds a call to the current round, or opens a new one if the current round's calls all
  have results; `ToolFinished` records the result; text after a closed round opens a new round. History is committed with
  today's `commit` (interrupted turns keep only played clauses).
- **Actions** are *not* recorded as tool calls: the history of an intent turn is the user message and what was spoken
  ("Living room lights on."). A conversational agent reading the history then knows what happened without seeing tool calls
  for tools it may not have.
- **Side effects** wait for `promoted`. `Conversation` interrupts the stream of a discarded speculative turn; the agent must
  release everything on interruption (abort the request, interrupt the harness turn).
- **First event.** If no event arrives within `firstEventTimeoutMs` of `turn` being called, `Conversation` interrupts the
  stream and treats it as `AgentError("timeout")` (§1.9).
- **`Handoff`** is legal only before the first `TextDelta`; after text it is ignored with a warning.

### 1.3 A turn's path through router and agent

```
SttEvent / TextInput ─▶ Conversation.start(text, speculative, source, explicitAgent?)
   │  setup = yield* options.setup            (snapshot: agents, router, actions, deciders, tools, prompts)
   │  decision = setup.router.route({ text, source, explicitAgent, state, now, isAvailable })   ≈ 10–16 µs
   │  emit TurnStarted { agentId, routedBy, fallbackFrom?, agentText }
   ▼
   ├─ decision.agentId undefined ─────────▶ canned turn: "No agent is available right now."
   ├─ decision.acknowledge (trigger only) ─▶ canned turn: "Yes?" (or "Codex isn't available.")   not recorded
   └─ agent = setup.agents.get(decision.agentId)
        │  unavailable && reason ≠ default ─▶ first clause "Codex isn't available." (spoken while the default agent thinks)
        │  agent.speculate == false && speculative ─▶ await promoted before calling turn
        ▼
      agent.turn(input) ── TextDelta ─▶ chunker ─▶ Tts ─▶ (buffered until promoted) ─▶ AudioOutput
            │                ToolStarted/Finished ─▶ rounds (history) + events
            │                Decision / Action* ─▶ events (UI, trace)
            │                ExpectReply ─▶ router.armAgent on commit
            └─ Handoff, or AgentError before any text ─▶ same turn on fallbackFor(agent) ─▶ emit TurnAgentChanged
   on promotion / normal start: routerState = decision.next (+ armed if ExpectReply)
   on discard: routerState unchanged
```

`fallbackFor(agent)` = the default agent if it is conversational (kind `model` or `harness`), available and not `agent`;
else `RoutingConfig.fallbackAgent` if available; else a canned "I can't help with that right now."

### 1.4 History shared between agents

**Decision: one shared transcript, owned by `Conversation`, is the truth.** Each assistant `Message` gains an optional
`agentId` (who said it), and the user message stores the text the agent received (trigger removed; the UI keeps the full
utterance in `turn.start.userText`).

- **Model agents** get `history` every turn, as today. Messages from other agents are ordinary assistant messages to them.
  Prompt caching still works: history is append-only.
- **Harness agents** keep their own session (it cannot be replaced from outside). Each harness agent remembers
  `syncedThrough = input.history.length` at the start of each of its turns. At its next turn it looks at
  `missed = input.history.slice(syncedThrough)`:
  1. Drop the leading block that is its own previous turn: the first user message and the non-user messages after it up
     to the next user message, when the first assistant message in that block has `agentId` equal to its own id. If that
     own reply was `interrupted`, keep one line `(You were interrupted; the owner heard only: "…")`.
  2. Nothing left (and no interruption line) → send `text` as is.
  3. Otherwise prepend a catch-up block of the rest, at most the last 20 messages, tool messages omitted, each line
     `User: …` / `<agent name>: …` (names from `agentId`):
     `"<earlier>\nUser: turn on the lights\nJev: Living room lights on.\n</earlier>\n\n<text>"`.
  4. A new session (first turn, restart, crash) is primed the same way with the last 20 messages of `input.history`.
- **Intent agents** read no history (the decision is about one utterance); their pending question state is their own (§3.6).

Interrupted replies: the harness's own session holds the full reply it generated, while the shared history holds only what
was heard; the "(You were interrupted …)" line in the next catch-up corrects that.

### 1.5 Speculation and interruption, per kind

| | Speculative turn (from `EagerEndOfTurn`) | Discarded (`TurnResumed`) | Barge-in on a committed turn |
|---|---|---|---|
| `model` | Model call runs; text synthesised and buffered; speculative tools run; others wait for promotion | Request aborted; paid tokens of the partial reply are lost (today's decision) | Request aborted; history keeps played clauses |
| `harness`, `speculate: false` (default) | `Conversation` waits for promotion before `turn`; nothing reaches the harness | Nothing to undo | `interrupt()`; the session continues; next catch-up notes what was heard |
| `harness`, `speculate: true` | Message sent at `EagerEndOfTurn` | `interrupt()`: the partial message **stays in the harness session** and one call of quota is used | Same as above |
| `intent` | Decision request runs; `announce` synthesised; `speculative` actions run; others wait | Decision discarded (Jev costs ≈ $0.00002 per request; no side effect) | Speech stops; an action that started runs to completion (cannot half-switch a light) |

Close call — harness default `speculate: false`: speculation would save ≈ 270 ms (eager at 372 ms vs end of turn at 641 ms
after speech, README table), but real speech pauses longer than 250 ms mid-sentence are common, each would leave a partial
message in the Claude or Codex session and spend quota, and resuming a Claude session after `interrupt()` was **not
tested** (research §2). The setting is per agent ("Start before I finish speaking"), so the owner can measure both.

### 1.6 Agents are modules

`defineAgent` (real code, `ModuleContributions.ts`) declares a module of kind `agent` whose instance contributes one
`Agent`. A decision provider is `defineDecider` (kind `decider`). Any module may add `actions`. Consequences:

- The module host already does lifecycle (start with 10 s limit, scope, grace period, status line), settings
  (environment > saved > default, secrets in `secrets.json`), persistence, generated forms and live reconfiguration.
  Nothing new is needed except the snapshot carrying agents, actions and deciders (§9).
- An agent package adds **one file** (`agent.ts` exporting `defineAgent({...})`) and the app adds **one line** to
  `agentCatalog` in `apps/assistant/src/agents.ts` (new file; the host's catalog is `[...agentCatalog, ...moduleCatalog]`).
- `enabledByDefault` is `false` for agents (they need keys, logins or opt-ins), except `offline` and `jev` (which works with
  the keyword decider) and the `keywords` decider.
- The host adds a **Test** button (`action` field, key `test`) to every agent's form. Pressing it runs
  `agent.turn` with `text: "Say hello in five words."`, empty history, no tools, already promoted, outside the conversation,
  and answers `result.detail`: `"First text after 640 ms, done after 910 ms: 'Hello there, nice to meet you.'"` (or the
  error). For deciders the test sends a fixed two-action request and reports the round trip and the answer.
- An agent may expose `settingOptions` (model list for its `combo` field, fetched at start and cached), `info` values
  ("Logged in with a Max plan") and extra `fieldActions` ("Refresh model list").

Catalog (initial; ids are module ids and are what routing rules name):

| id | Name | Kind | Package | Enabled by default |
|---|---|---|---|---|
| `anthropic` | Claude (API) | model | `llm-anthropic` (`agent.ts`) | no (needs a key; enabled automatically when `ANTHROPIC_API_KEY` is set and no saved intent exists) |
| `openrouter` | OpenRouter | model | `llm-openai-compatible` | no |
| `home-model` | Home model server | model | `llm-openai-compatible` | no |
| `offline` | Offline stand-in | model | `apps/assistant/src/agents/offline.ts` (wraps `FakeLlm`) | yes |
| `claude-subscription` | Claude subscription | harness | `agent-claude-code` | no (opt-in) |
| `codex-subscription` | Codex subscription | harness | `agent-codex` | no (opt-in) |
| `jev` | Jev | intent | `agent-intent` | yes |
| `jev-typesafe` | TypeSafe Jev | decider | `decide-typesafe` | no (needs a key; enabled automatically when `TYPESAFE_API_KEY` is set) |
| `keywords` | Offline keywords | decider | `agent-intent` | yes |

("Enabled automatically when the key is set" = the definition's `enabledByDefault` is computed from the environment when
the catalog is built; a saved intent always wins.)

### 1.7 Model agents

`makeModelAgent({ llm })` (new, `packages/core/src/ModelAgent.ts`, piece A) is today's `assistantText` loop moved out of
`Conversation`: request = `{ system: input.system, context: input.context, messages: [...history, user, ...rounds], tools:
input.tools.specs }`, `mark("llmRequestSent")` / `mark("llmFirstToken")`, tool calls run through `input.tools.run` after
awaiting `promoted` for non-speculative ones, `ToolStarted`/`ToolFinished` events, the `"\n"` flush, `maxToolRounds`.
`Conversation.layer` / `layerWithSetup` (which take an `Llm`) keep their signatures and build a one-agent set from it, so
every existing caller and test is unchanged.

Agent files (piece F for `anthropic` and `offline`, piece E for the OpenAI-compatible ones):

```ts
// packages/llm-anthropic/src/agent.ts
export const anthropicAgent = defineAgent({
  id: "anthropic", name: "Claude (API)", kind: "model",
  description: "Anthropic's API with your API key. Fast and the supported default.",
  settings: {
    apiKey: Setting.secret({ label: "API key", env: "ANTHROPIC_API_KEY", required: true }),
    model: Setting.combo({ label: "Model", env: "ANTHROPIC_MODEL", default: "claude-haiku-5-5" }),
    systemPrompt: Setting.text({ label: "System prompt for this agent", multiline: true, maxLength: 4000,
      description: "Empty: the global prompt (Agents → All agents)." }),
    maxTokens: Setting.number({ ..., env: "ANTHROPIC_MAX_TOKENS", default: 1024, advanced: true }),
    effort: Setting.choice({ ..., env: "ANTHROPIC_EFFORT", advanced: true }),
    thinking: Setting.choice({ ..., env: "ANTHROPIC_THINKING", advanced: true }),
    timeoutMs: Setting.number({ ..., env: "ANTHROPIC_TIMEOUT_MS", advanced: true }),
    warmUp: Setting.boolean({ ..., env: "ANTHROPIC_WARM_UP", advanced: true }),
    baseUrl: Setting.text({ ..., env: "ANTHROPIC_BASE_URL", advanced: true }),
  },
  start: ({ settings }) => Effect.gen(function*() {
    const llm = yield* AnthropicLlm.make({ ...settings, apiKey: Redacted.make(settings.apiKey!) })   // warm-up included
    const models = yield* listModels(settings).pipe(Effect.orElseSucceed(() => []))                   // GET /v1/models, 2 s
    return { systemPrompt: settings.systemPrompt, turn: makeModelAgent({ llm }).turn,
             settingOptions: () => ({ model: models }) }
  })
})
```

**OpenAI-compatible adapter** (`packages/llm-openai-compatible`, piece E): plain `fetch` + an SSE parser (no SDK), the
lowest common denominator of research §4: `POST {base}/chat/completions` with `stream: true`, `messages`, `tools`;
tool-call deltas accumulated by `index`; lines starting with `:` skipped; `reasoning` / `reasoning_content` deltas never
spoken; an `error` chunk inside a 200 stream fails the turn; `Authorization: Bearer <key or "none">`; `GET {base}/models`
for the model list. A `profile` object per server holds the quirks:

| Profile | Base URL default | Key | Extra body | Model list |
|---|---|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1` | required | `provider: { sort: "latency" }` (setting), `reasoning: { effort }` only if the model lists it | `/models`, filtered to models with tools support and not `reasoning.mandatory` |
| `ollama` | `http://<host>:11434/v1` | ignored | `reasoning_effort` when set | `/models` |
| `llamacpp` | `http://<host>:8080/v1` | optional | none | `/models` (the loaded model only) |
| `lmstudio` | `http://<host>:1234/v1` | optional | none | `/models` |
| `vllm` | `http://<host>:8000/v1` | optional | none | `/models` |
| `generic` | (setting) | optional | none | `/models` |

Catalog entries: `openAiCompatibleAgent({ id: "openrouter", name: "OpenRouter", fixedProfile: "openrouter", envPrefix:
"OPENROUTER_" })` and `openAiCompatibleAgent({ id: "home-model", name: "Home model server", envPrefix: "HOME_MODEL_" })`,
whose `server` setting chooses the profile. Settings: `server` (home-model only), `baseUrl`, `apiKey`, `model` (combo),
`systemPrompt`, `maxTokens` (default 512), `temperature` (advanced), `reasoningEffort` (advanced; `none` default where
supported), `timeoutMs` (first byte, default 5000), `sortByLatency` (OpenRouter), test. Start checks reachability with
`GET /models` (2 s) so a wrong address is a start error, not a failed turn.

### 1.8 Harness agents

**Claude subscription** (`packages/agent-claude-code`, piece J), from research §2 (all **[run]** unless marked):

- `@anthropic-ai/claude-agent-sdk` (pin the version the research ran, 0.3.323) in streaming-input mode: **one long-lived
  `query()` per session**, input fed from a queue, output read with manual `iterator.next()` (a `for await … break`
  closes the session). Options: `model`, `tools: []`, `settingSources: []`, `strictMcpConfig: true`,
  `env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" }`, `persistSession: false`, `thinking: { type:
  "disabled" }`, `includePartialMessages: true`, `systemPrompt: input.system`, and, when tools are on, `mcpServers: {
  assistant: createSdkMcpServer(...) }` with `allowedTools` listing them.
- **Opt-in.** Setting `optIn` ("I understand Anthropic's terms for using a subscription from other software are unclear,
  and I accept that", default off, env `CLAUDE_SUBSCRIPTION_OPT_IN`). With it off, `start` fails with that sentence, so the
  card shows why. The assistant never reads or stores Claude credentials; login happens in `claude` itself.
- **Start** spawns the session and waits for the SDK's `init` message (≤ 10 s, the host limit). `apiKeySource` must be
  `"none"` (subscription login); otherwise `ModuleStartError("Claude Code is not logged in with a subscription: run
  `claude` and log in.")`. `info.login` shows the plan from `claude auth status` (`subscriptionType`).
- **Warm-up:** the process is started at module start, so its startup (≈ 0.3–1.3 s of the cold numbers) is off the turn
  path. No warm-up *turn* (it would spend quota and put a message in the session). First turn measured 1172 ms to first
  text, later turns median 866 ms.
- **Turn:** apply the catch-up (§1.4), prepend `<context>…</context>` when `input.context` is set, push the user message,
  map `stream_event` `text_delta` → `TextDelta` (`mark("llmFirstToken")` on the first), MCP tool handler calls →
  `ToolStarted`/`ToolFinished` (the handler awaits `input.promoted` for non-speculative tools and runs
  `input.tools.run`), `result` → end of stream. Emit `"\n"` before a tool call that follows text.
- **Tools** (setting, default on): the MCP server is built from `input.tools` at session start; when the snapshot's tool
  list or `system` changes, the session is restarted at the next turn boundary (re-primed by catch-up). A tool round trip
  costs ≈ +1.7–2.2 s (measured), so latency-critical facts stay in `context` (the clock is a context provider already).
  First-turn tool visibility is flaky (one of three runs did not see the tool): set `alwaysLoad: true` **[verify]**.
- **Interruption:** on stream interruption call `query.interrupt()` and wait (≤ 1 s) for its `result`
  (`error_during_execution`). The next `turn` waits for that. If the session errors afterwards (resuming after interrupt is
  **[verify]**), restart it transparently with a catch-up of the last 20 messages.
- **Session lifetime:** restarted when settings change (module restart), when tools or `system` change, after a crash,
  and after `sessionIdleMinutes` (default 60) without a turn (bounds memory growth, which is untested). Limits: `maxTurns`
  per harness turn 4, a turn timeout of 30 s (`AgentError("timeout")`).
- **Settings:** `optIn`, `model` (combo with `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`; default Haiku),
  `systemPrompt`, `speculate` (default off), `tools` (default on), `sessionIdleMinutes`, `claudePath` (advanced; default:
  the SDK's bundled binary), test.

**Codex subscription** (`packages/agent-codex`, piece L, last). Nothing was measured: the CLI is not logged in. Design:

- `codex app-server` (JSON-RPC over stdio), one process and one thread per session: `initialize`, `account/read` at start
  (`account: null` → `ModuleStartError("Codex is not logged in: run `codex login` and choose Sign in with ChatGPT.")`,
  fails fast instead of the CLI's ~10 s of retries), `thread/start { model, ephemeral: true, sandbox: "read-only",
  approvalPolicy: "never", baseInstructions: input.system }`, per turn `turn/start { threadId, input: [{ type: "text",
  text }], effort }`, `item/agentMessage/delta` → `TextDelta`, `turn/completed` → end, barge-in `turn/interrupt`.
- Same opt-in switch, `speculate` default off, model combo from `model/list`, `effort` default `low`.
- **No tools in the first version**: how client-defined tools are registered was not found (`DynamicToolSpec` exists in
  the schema). The assistant's tools reach Codex only after that is verified.
- **[verify] before it can be finished:** `codex login` works headless (device code); `thread/start` / `turn/start`
  against a model; deltas arrive as documented; `turn/interrupt` leaves the thread usable; which model is fastest and its
  time to first text; whether the built-in shell tool is still offered under `read-only` (if so, add
  `developerInstructions` forbidding it and treat output as untrusted); dynamic or MCP tool registration.
- Its absence blocks nothing: it is one catalog entry, disabled by default.

### 1.9 Failure and fallback

| Situation | Behaviour | Spoken |
|---|---|---|
| Routed agent not running (disabled, starting, error) | Default agent answers (router; `unavailable` set) | If the owner chose it (trigger, armed, sticky, explicit): first clause "`<Name>` isn't available." then the answer |
| Default agent not running either | `RoutingConfig.fallbackAgent` if running | Same notice |
| No agent running at all | Canned turn, not recorded | "No agent is available right now. Check the agents in the options." |
| Agent fails before any text (`AgentError`, or no first event within `firstEventTimeoutMs`) | Same turn re-run once on `fallbackFor(agent)`; `turn.agent { reason: "failed" }` | "`<Name>` isn't available." then the answer |
| Agent fails after text | Turn fails, committed as interrupted (today's rule); `error turn_failed` | What was played |
| Intent agent: no match, uncertain, compound, decider error or timeout | `Handoff` → `fallbackFor(jev)`; `turn.agent { reason: "handoff" }`; `intent.decision` shows why | Nothing extra (the answer is the answer) |
| Harness session crashed between turns | Restarted at the next turn with catch-up; if the restart fails → `AgentError("unavailable")` → fallback row above | As above |

No automatic retry of the *same* agent: a retry on the voice path doubles latency for a rare gain.

### 1.10 Latency trace attribution

`Trace` gains `agent?: { id, kind, routedBy, fallbackFrom? }` and four marks for intent turns. Existing marks keep their
meaning for model agents and are reused, with the same meaning, by harness agents (`llmRequestSent` = message written to
the harness, `llmFirstToken` = first text delta), so the latency readout's columns stay comparable across kinds.

| Mark | model | harness | intent |
|---|---|---|---|
| `llmRequestSent` | each model request (first counts) | user message sent to the harness | — |
| `llmFirstToken` | first text delta | first text delta | — |
| `decisionSent` / `decisionReceived` | — | — | decision request out / answer in |
| `actionStarted` / `actionFinished` | — | — | action `run` |
| `firstClause`, `ttsFirstAudio`, `playbackStart` | unchanged | unchanged | unchanged |
| `trace.tools` | tool calls | tool calls reported by the harness | the action (name = its tool name) |

`formatTrace` prints `agent=jev(trigger)` and the new marks when present; `TraceInfo` carries them (`TraceAgentFields`,
`TraceMarkAdditions` in `agents.ts`). The routing cost is not a mark: 10–16 µs (measured, §2.3) is below the clock's noise.

### 1.11 Expected time from end of speech to first audio

Measured base (README, development machine, nemotron-3.5, 250/600 ms): `EagerEndOfTurn` at **372 ms** and `EndOfTurn` at
**641 ms** after the speech ends (medians); with a speculative turn already synthesised, playback starts ≈ 15 ms after
`EndOfTurn` in the browser (779 vs 765 ms CLI at the same model speed); first Piper audio 20–30 ms after a clause.

| Path | Time to first audio (median) | Basis |
|---|---|---|
| Conversational, simulated 300 ms model (today's benchmark) | **729 ms** CLI, 779 ms browser | measured |
| Conversational, Anthropic Haiku via API | ≈ 372 + TTFT + ≈ 60 ms; with TTFT 400–700 ms → **≈ 830–1130 ms** | *estimate*: Haiku API TTFT is unmeasured |
| Conversational, home GPU server (warm 7–8B) | bounded by end of turn: **≈ 660–750 ms** | *estimate* (research's unmeasured expectation of 0.1–0.3 s TTFT) |
| Conversational, OpenRouter small model | ≈ 372 + 300–800 + 60 → **≈ 730–1230 ms** | *estimate* |
| Claude subscription, `speculate: false` (default) | 641 + 866 (warm first text) + ≈ 80 (first clause) + 30 + 15 → **≈ 1.6 s** | measured parts (first text median 866 ms, first sentence 1110 ms) |
| Claude subscription, `speculate: true` | 372 + 866 + ≈ 125 → **≈ 1.35 s** | measured parts |
| Claude subscription, one tool call | **≈ 3.5 s** | measured (3567 / 3631 ms first text) |
| Codex subscription | unknown | not measured |
| **Intent (Jev), action with `announce`** | decision done at 372 + ≈ 250 = 622 ms < 641: announcement synthesised during speculation, plays at promotion → **≈ 660 ms**; with Jev's p95 (347 ms) ≈ 720 ms | Jev latency is a third party's measurement (median 247 ms), not from this machine |
| Intent, offline keyword decider | **≈ 660 ms** (bounded by end of turn) | *estimate*; decider is local and sub-millisecond |
| Intent, query action (`clock.time_now`, speculative) | **≈ 660 ms** | *estimate* |
| Intent, no speculation (end of turn came without an eager one) | 641 + 250 + 30 + 15 → **≈ 940 ms** | *estimate* |
| Routing, any path | **+0.01–0.02 ms** | measured: 8.7–16.2 µs per utterance with the default rules (`tsx`, this machine) |

So the intent path is bounded by turn detection and beats a 300 ms model by ≈ 70 ms, a realistic hosted model by
≈ 200–450 ms, and the Claude subscription by ≈ 1 s. Its remaining cost is the 600 ms silence wait; committing early when the
decision is confident is a possible later step (§7). Every number above becomes a `TurnTrace` measurement once the pieces
land; the build plan says which.

### 1.12 What changes in `Conversation` (piece A)

All additive; existing options, inputs and events keep their meaning.

- `makeAgentConversation(options: AgentConversationOptions)` / `Conversation.layerWithAgents(...)`: like
  `layerWithSetup` but `setup: Effect<AgentTurnSetup>` and no `Llm` requirement.
  `AgentTurnSetup = TurnSetup & { agents: AgentSet }`,
  `AgentSet = { router: Router; agents: ReadonlyMap<string, Agent>; names: ReadonlyMap<string, string> /* every catalog agent */; actions; deciders; maxToolRounds; promptFor(agent): string; fallbackAgent?: string; acknowledgement: string }`.
  `makeConversationWithSetup` becomes a wrapper that builds a one-agent set (`makeModelAgent` over its `Llm`, a router that
  always returns it): identical behaviour, so the 100 existing core tests pass unchanged.
- Setup is read once in `start` (before `TurnStarted`, it is a reference read), not inside the turn fiber; the context
  providers still run inside the fiber.
- Router state lives in the voice loop; `decision.next` (plus an `ExpectReply` arm) is applied when the turn is committed
  (non-speculative start, or promotion). A discarded turn changes nothing. `textTurn` (CLI text mode) routes too and
  commits at once.
- `ConversationInput` gains `TextInput.agentId?` and two inputs: `{ _tag: "SetActiveAgent"; agentId: string | null }`
  (from `routing.set`; applied at once) and `{ _tag: "Say"; text: string; voice?: string }` (a canned spoken turn that is
  not recorded: "Play a sample", trigger acknowledgements use the same path internally). `Say` interrupts like
  `TextInput`.
- `ConversationEvent` changes: `TurnStarted` gains `agentId?`, `routedBy?`, `fallbackFrom?`, `agentText?`, `canned?`;
  new `TurnAgentChanged { turnId, agentId, from, reason: "handoff" | "failed" }`, `IntentDecided { turnId, decision }`,
  `ActionStarted { turnId, callId, actionId, label, params }`, `ActionFinished { turnId, callId, ok, ms, error? }`,
  `RoutingChanged { state }` (after each commit that changed it, and on `SetActiveAgent`).
- `MAX_TOOL_ROUNDS` becomes live (read per turn from the setup) instead of an engine reload.

---

## 2. Routing by trigger phrase

Real code: `packages/core/src/Routing.ts` (pure; 24 tests). Integration into `Conversation`: piece A.

### 2.1 Rules are data

```ts
interface RoutingConfig {
  defaultAgent: string                 // DEFAULT_AGENT
  fallbackAgent?: string               // ROUTING_FALLBACK_AGENT: answers when the default cannot
  rules: Array<{ agent: string /* agent id or "@default" */; phrases: string[]; mode: "turn" | "conversation" }>
  greetings: string[]                  // interchangeable first words: hey, hi, hello, hay, ok, okay, oke, yo, he, hoi, hallo
  fillers: string[]                    // skipped at the start: um, uh, er, eh, euh, hmm, so, …
  requireGreeting: boolean             // default false
  stickyIdleMs: number                 // default 120 000
  armedMs: number                      // default 10 000
  acknowledgement: string              // default "Yes?"
}
```

All of it comes from the `routing` settings section (§4.4), live: the router is rebuilt when the section changes and each
turn's setup holds the current one. Default rules:

| Agent | Phrases | Mode |
|---|---|---|
| `jev` | "hey jev", "hey jeff" | turn |
| `claude-subscription` | "hey claude" | conversation |
| `codex-subscription` | "hey codex" | conversation |
| `openrouter` | "hey router", "hey open router" | conversation |
| `home-model` | "hey local", "hey home" | conversation |
| `@default` | "hey assistant", "back to normal" | conversation (selecting the default clears stickiness) |

A rule for an agent that is not running is harmless: the route falls back (§1.9). The settings screen warns next to a rule
whose agent is disabled.

### 2.2 How the agent for a turn is chosen

`route(input)` checks in this order (first match wins); the result carries `next`, the router state to keep if the turn is
committed.

| # | Condition | Agent | `reason` | State after commit |
|---|---|---|---|---|
| 1 | `explicitAgent` (chat composer) | that agent; a trigger in the text is still removed | `explicit` | sticky kept as is; armed cleared |
| 2 | trigger at the start | the rule's agent (`@default` → default) | `trigger` | `conversation` rule: sticky = that agent (cleared for the default); `turn` rule: sticky kept, not refreshed. Trigger only: also armed |
| 3 | an armed agent (`now < until`) | the armed agent | `armed` | armed cleared; sticky refreshed if it is the same agent |
| 4 | sticky and `now − lastUsedAt < stickyIdleMs` | the sticky agent | `sticky` | `lastUsedAt = now` |
| 5 | otherwise | default | `default` | empty |

Then availability: if the chosen agent is not running, the default answers (or `fallbackAgent`, or nobody), `unavailable`
names the missing agent, and `next` never sticks to or arms it. Getting back to the default: say a `@default` phrase
("hey assistant"), wait two minutes, press **Back to <default>** in the UI (`routing.set { agentId: null }`), or choose
"Auto" in the composer.

### 2.3 Tolerant matching

Only the first 160 characters are scanned; a trigger is recognised only at the start of the utterance.

1. Split into words with offsets (`TextMatching.words`: lower case, no diacritics, no apostrophes), join runs of
   single letters ("J. E. V." → `jev`), skip leading fillers.
2. A phrase whose first word is a greeting matches *any* greeting word there ("hey jev" also matches "hi Jev", "okay Jev",
   "hé Jev"). Greeting words also match by phonetic key.
3. Each other phrase word must match the next utterance word with a score:

   | Match | Score | Example |
   |---|---|---|
   | same normalised word | 1 | "Jev" |
   | same phonetic key (`phoneticWord`: ph/v → f, soft g → j, c/ck/q → k, vowel runs and doubled letters collapsed, final silent e dropped) | 0.9 | "Jeff", "Jef", "Jeph" → `jef` |
   | one edit apart, both words ≥ 4 letters | 0.8 | "Cluade" |
   | phonetic keys one edit apart, both keys ≥ 4 letters | 0.75 | "cloud" (`klod`) ≈ "claude" (`klad`) |
   | anything else | no match | "Jen", "rev" (3 letters: exact or phonetic only) |

4. Greeting missing ("Jev, lights off"): accepted when every name word scored ≥ 0.9, scored 0.85; refused when
   `requireGreeting` is on.
5. Best phrase: the one matching more utterance words ("hey open router" beats "hey open"), then the higher score, then
   rule order.
6. The agent receives the text after the matched words with leading punctuation removed and the first letter upper-cased:
   "Hey Jeff, turn on the lights." → "Turn on the lights."

The owner adds aliases for misrecognitions the rules do not cover (the phrases list is per rule). Misrecognitions seen so
far: "hey Jeff" (dictation). To check a phrase, type it in the chat with the composer on "Auto": the reply is labelled with
the agent it went to, and `turn.start.agentText` shows what was removed.

### 2.4 Trigger-only utterances, arming and stickiness

- **Only the trigger** ("Hey Jev."): no agent runs. `Conversation` speaks `acknowledgement` ("Yes?") as a canned turn, not
  recorded in history, and the agent is armed for 10 s. If the pause after "hey Jev" is longer than the eager silence but
  the owner continues, the speculative "Yes?" is discarded with the turn (`TurnResumed`) and the full sentence is routed
  normally. If the agent is not running, the canned turn says "Jev isn't available." instead and nothing is armed.
- **An agent asks** ("Which room?"): it emits `ExpectReply`; on commit the router arms it, so "the kitchen" goes back to it
  without a trigger.
- **Sticky** (`conversation` rules, or `routing.set`): lasts until another trigger, the default's phrase, `routing.set null`,
  or `stickyIdleMs` (2 min) with no turn for that agent. A `turn` trigger for another agent in between does not end it.

### 2.5 Typed messages

`text.send` gains `agentId?`. Absent ("Auto" in the composer) → routed exactly like speech, so typing "hey jev lights off"
works. Present → reason `explicit`. The composer shows an agent chip: "Auto · Claude (API)" (the active agent), and a menu
of running agents plus "Auto"; the choice is per device (`localStorage`). `agentId` naming an agent that is not running →
`result { ok: false, error: { code: "agent_unavailable" } }` and no turn.

### 2.6 Speculative end of turn

The route is computed from the eager transcript when the speculative turn starts (synchronously, before anything else), and
kept when the turn is promoted (promotion already requires the same text). A different final transcript starts a new turn,
routed anew. Router state changes only on commit, so a discarded speculative turn ("hey Claude" … resumed) never makes Claude
sticky. Cost: 8.7–16.2 µs per utterance (measured, default rules), so routing adds nothing measurable to either path.

### 2.7 Showing who answers

- `turn.start` carries `agent` (`{ id, name, kind }`), `routedBy`, `fallbackFrom`, and `agentText` (what the agent got).
  `turn.agent` reports a hand-off or a failure fallback mid-turn.
- `routing` messages (and `snapshot.routing`) carry the active agent and its expiry.
- UI (§5.3): the visualiser label reads `THINKING · JEV`, `SPEAKING · CLAUDE (API) · natural`; the chat labels each reply
  with its agent name instead of "ASSISTANT"; the top bar shows a chip when the active agent is not the default.

### 2.8 Replacing the router

`Router` is an interface (`route`, `matchTrigger`). Another implementation is one file returning the same shape, chosen in
`apps/assistant/src/agents.ts`. It must stay synchronous: anything that needs a model call (a semantic router) is an agent
(like `jev`, which hands off what it cannot do), not a router.

---

## 3. The typed-intent path

Real code: `Actions.ts`, `Decision.ts` (pure: request assembly and interpretation; 14 tests). Built in piece C: the intent
agent, the value parser, the keyword decider, the generated tools; piece D: the modules; piece I: the Jev provider.

### 3.1 Declaring actions

A module returns `actions` next to `tools` (`ModuleContributions.actions`):

```ts
defineAction({
  id: "lights_on",                                  // global id "demo-home.lights_on"
  label: "Turn lights on",
  description: "Switch on the lights in a room, one light, or every light. Not for dimming: that is set_brightness.",
  examples: ["turn on the kitchen lights", "doe het licht aan in de woonkamer"],
  params: { target: Param.dynamic({ label: "Room or light", options: () => home.targets() }) },
  speculative: false,                               // default: run waits for the end of the turn
  confirm: false,                                   // true / (params) => "Unlock the front door?"
  offerAsTool: true,                                // default
  announce: ({ target }) => `${home.labelOf(target)} on.`,
  run: ({ target }) => home.switch(target, true)    // Effect<ActionOutcome | void, ActionError>, ≤ 5 s
})
```

Parameter kinds (closed set; `Param.*`):

| Kind | Filled by | Value | Request | Example |
|---|---|---|---|---|
| `choice` | decision model | one of the fixed option values | choice over the options (label + aliases + description) | a scene, a mode |
| `dynamic` | decision model | one of the values the module supplies now (`options()`, synchronous, from its cache; ≤ 255) | choice over them | rooms and lights |
| `number` | local parser; model only to pick among several candidates | number in `[min, max]` | nothing, or a choice over the candidates + "none" | "40 percent" |
| `duration` | local parser; same | milliseconds | same | "ten minutes", "anderhalf uur" |
| `boolean` | decision model | `noul ≥ 0.5` | yes/no question (`question` required) | "dimmed rather than off?" |
| `text` | local code: words after the first of `after` (≤ `maxWords`) | string | nothing | "weather in **Paris**" |

Every parameter may be `optional` (with an optional `default`); an optional choice also gets a "does the utterance say
which …?" yes/no question so an unstated value is never guessed. `question` words the decision question (about meaning);
`ask` words the spoken follow-up ("Which room?").

### 3.2 Actions and tools

> **Known limitations — confirmation is switched off by default.** Actions declared `confirm: true` are refused unless
> the conversation's `confirmActions` is `"on"` (see "After the final review"). Before switching it on, know that the
> final review left these open:
>
> - An answer begun before the question can become eligible when the echo gate holds back the start of speech in
>   "confirm" interrupt mode (the conversation records the time of release, not the time speech began).
> - A quick one-word answer can be lost in the echo gate's tail in "confirm" and "manual" modes.
> - A module's announcement can assert completion before the action has succeeded.
> - A harness agent's catch-up can miss an outcome that was corrected after it last read history.
> - An option renamed between question and answer is recorded under its new name.

**Every action is offered to conversational agents as a tool** unless `offerAsTool: false` (piece C,
`actionTool(registered)`): name `actionToolName(moduleId, id)` (`demo-home_lights_on`), description = label + description,
input schema: `choice` → enum of values; `dynamic` → string ("one of the names the owner uses for a room or light"),
resolved at execution against the current options by label, value or alias with `TextMatching` (exact, then phonetic), an
unresolved name returning an error result that lists the valid names (so a changing room list never changes the cached tool
schema); `number` → number; `duration` → string parsed by the value parser; `boolean` → boolean; `text` → string. The
tool's `speculative` = the action's. The tool runs `run` and returns `say` (or "ok"). So "turn on the living room lights"
works through Jev and through any conversational agent, with one implementation.

**Confirmation is conducted by core** (review rounds 6 and 7; this paragraph is the whole mechanism as it now is). An
action declared `confirm: true` never runs because an agent asked for it.

1. *Proposal.* When any agent reaches the point of running it with complete, valid values — the intent agent after
   interpretation (it emits the `AgentEvent` `ConfirmAction`), a conversational or harness agent by calling the generated
   tool (core's wrapper `proposingTools`, `PendingIntents.ts`) — `Conversation` records THE proposal of the turn
   (registration, values, proposing agent) and stops reading the agent's stream as soon as no tool call waits for its
   result (text after that is neither spoken nor recorded; further tool calls are refused). A tool call is answered with
   `PROPOSED_RESULT` ("the assistant is now asking the owner; do not ask or say anything further; you will see the
   outcome").
2. *The question states the values* (`confirmationQuestion`, `Decision.ts`), always in core's words (after the final
   review; a module's `confirm` function is never called): with no values, the label with "?"; with values, the label
   followed by each parameter's label and spoken value, a number with its unit ("Reset the room: room Bedroom?"). A
   value that cannot be said REFUSES the proposal: nothing is asked, the tool result tells the agent why, and the owner
   hears `ConfirmTexts.refused` ("Sorry, I can't ask you to confirm that, so I didn't do it."). While `confirmActions`
   is not `"on"`, every proposal is refused before this step (`ConfirmTexts.switchedOff`).
3. *Asking.* Core speaks the question itself as the turn's last words, recorded as the proposing agent's message. When
   the turn already said anything before it, the question is preceded by `ConfirmTexts.leadIn` ("To confirm:" /
   "Ter bevestiging:"), so what the owner hears last is unmistakably the action's question.
4. *Arming.* The question is armed only once it has been played TO ITS END: its turn completed, its final clause was the
   turn's last and started playing, and the output's authoritative final count (if it gives one) covers everything
   handed over; in text mode, when its text was delivered and the turn completed. There is no barge-in shortcut. The
   response window (`confirmWindowMs`, default 15 000 ms) starts at arming. A question interrupted by speech or typed
   text is remembered unarmed; one that Stop stopped, whose playback failed, or of a discarded turn is forgotten.
5. *Who may answer.* Eligibility is a property of the answering utterance, fixed when it begins and never improved: a
   spoken utterance may answer only if, at its `SpeechStarted`, the question was already armed (played to its end
   according to what was known then — a later final count does not count); typed text only if submitted after arming.
   An utterance that began earlier (before any audio, during earlier speech of the turn, during the lead-in or any clause
   of the question, or at the same moment as its end) is not an answer: with barge-in it interrupts the question, which is
   then never armed; without barge-in the question arms but the utterance still cannot answer it.
6. *The answer.* The next committed user turn — spoken or typed, from any tab — is offered to the last question asked
   before routing (`asked`, kept until a later committed turn settles it). A yes or a no by closed grammar
   (`confirmationAnswer`: `isConfirmation` / `isRefusal`) is core's, with no agent; anything else drops the confirmation
   and is routed as a fresh request. The answer is settled when its turn is committed (started committed, or promoted from
   a speculative turn) in ONE uninterruptible step with nothing awaited (`resolveAnswer`): a no cancels; a yes from an
   ineligible utterance is dropped as too early; otherwise `consumeConfirmation` checks, against the clock read now, that
   the entry is current, armed, from an earlier turn, its window open, and its registration and dynamic values still
   offered (the setup read now; the single-model API offers its registry's action tools), removes it, and the action is
   started DETACHED, with the 5 s limit, so nothing that happens to the turn's speech can cancel it half-way.
7. *What is said.* After the start: the action's announcement (if it declares one), then — only once the action has
   ended — its `say`, or `ConfirmTexts.done` ("Done.") when it supplied no words at all, or "Sorry, <reason>" when it
   failed. A dropped answer says why: `cancelled` ("OK, I won't."), `tooEarly` ("I didn't do it: the question hadn't
   finished when you answered. Please say your request again."), `lapsed` ("… that answer came too late …"),
   `unavailable` ("… that can't be done any more."). All are recorded as the proposing agent's words. The fixed texts are
   `confirmTexts` (default `DEFAULT_CONFIRM_TEXTS`; `DUTCH_CONFIRM_TEXTS` exists).
8. *What is recorded.* The answering turn ends with an explicit outcome note (an assistant message, never spoken,
   attributed to the proposer): ran and succeeded, ran and failed with the reason, the owner said no, or not run and why
   (answered too early, window closed, no longer available); a refused proposal gets one too. If the turn is interrupted
   or its consumer goes away while the action runs, the action still completes and the note, committed as "outcome not
   known yet", is replaced in place by the real outcome. So the proposing call's tool result is never the last word: a
   model reads the note in its history, a harness in its catch-up (non-empty assistant messages are passed on).

The generated tool itself refuses to run a `confirm: true` action, so no registry can run one either; its description
says calling the tool makes the assistant ask the owner, and that the model must not ask itself.

Tools are **not** turned into actions automatically (a JSON-schema input cannot be mapped onto choice questions). A module
that wants both declares the action and lets the tool be generated, or keeps a hand-written tool and sets
`offerAsTool: false` on the action (weather does this: its `weather` tool exists).

The host checks generated tool names for clashes exactly as it checks tool names today (§1.4 of UI-AND-MODULES).

### 3.3 One request per utterance

`buildDecisionPlan({ utterance, actions, pending?, parse })` builds the request; Jev sees it as `state` + `questions`:

| Question name | Type | Content | Read when |
|---|---|---|---|
| `action` | choice | one option per action (≤ 255): `"<label>. <description> For example: "…"; "…"."` | always |
| `fits` | yes/no | "Does the utterance ask the assistant to do one of the available_actions?" (the companion question: a choice always picks something) | always |
| `compound` | yes/no | "Does the utterance ask for two or more different actions at once?" | always |
| `<action>/<param>` | choice | the parameter's options (`"Living room (also called: lounge, woonkamer)"`), or number candidates + `none` | for the chosen action only |
| `<action>/<param>?` | yes/no | "Does the utterance say which <label> it means?" (optional choices) | chosen action only |
| `<action>/<param>` | yes/no | a boolean parameter's question | chosen action only |
| `pending/answers`, `pending/answer`, `pending/yes` | yes/no, choice, yes/no | when a question or confirmation is pending (§3.4) | first |

`state` = `{ utterance, available_actions: { id: label }, question_asked? }`: the trigger-free utterance and action labels,
nothing else about the owner. Parameters with a single possible value, numbers with one candidate, and text are filled
locally and not asked. All parameters of all actions are asked in the same request (TypeSafe's "speculative fan-out": more
questions "usually" do not slow it; sequential requests would). Each question carries a machine-readable `role`, which the
Jev adapter strips and the keyword decider uses. Limits: 255 options per choice (excess actions or values dropped with a
warning on the agent's status line); 64k tokens per request (≈ 100 actions with short descriptions stay far below).

### 3.4 Decision flow and thresholds

Real code: `interpretDecision(plan, response, thresholds)`. Thresholds are settings of the `jev` agent; the defaults are
TypeSafe's suggested starting points and must be tuned on the owner's own utterances. The probability of the chosen option
is compared, never Jev's `confidence`.

```
pending question or confirmation?  ── pending/answers ≥ 0.5 ──▶ confirm: pending/yes ≥ 0.8 → ACT, else CANCELLED ("OK, I won't.")
        │                                                        param:  value found (p ≥ 0.6) → continue below with it
        │                                                                not found → FALLBACK uncertain
        no (or answers < 0.5: a new request; the pending one is dropped)
        ▼
no actions offered ─────────────────────────────▶ FALLBACK no_match
compound ≥ 0.5 ─────────────────────────────────▶ FALLBACK compound
fits < 0.3 ─────────────────────────────────────▶ FALLBACK no_match
fits < 0.7  or  p(chosen action) < 0.7 ─────────▶ FALLBACK uncertain
        ▼ action chosen
for each parameter: fixed → use · flag → noul ≥ 0.5 · optional and "says which?" < 0.5 → default
                    choice p ≥ 0.6 → use · else → missing
        ▼
missing required value? ──▶ ASK "<ask>" (pending; ExpectReply arms Jev for 10 s … pending kept 15 s)
action.confirm? ──────────▶ CONFIRM "<label>?" (pending)
        ▼
ACT  (probability = min of fits, action and every chosen value)
```

| Outcome | What the intent agent does | Spoken |
|---|---|---|
| ACT | emit `Decision`; speak `announce` (if any) at once; await `promoted` unless the action is `speculative`; `ActionStarted`; run (uninterruptible, 5 s limit); `ActionFinished`; speak `say` (if any) | "Living room lights on." / "It's 14:32." |
| ACT, action fails | as above, then the error | "Living room lights on. Sorry, Home Assistant did not answer." (with `speakBeforeDone` on) |
| ASK | emit `Decision`, speak the question, `ExpectReply`; keep the pending intent for `pendingSeconds` (15) | "Which room or light?" |
| CONFIRM | same as ASK | "Switch everything off?" |
| CANCELLED | | "OK, I won't." |
| FALLBACK | emit `Decision` (outcome `fallback`, reason), then `Handoff`; the conversational agent answers the same text | (its answer) |

Decided, with reasons:

- **Uncertain action → conversational agent**, not "Did you mean X or Y?": the conversational agent has the actions as
  tools, so it can do the action itself or ask a better question; a second decision round would add a turn for a gain the
  conversational agent already provides.
- **Clear action, unclear value → ask.** One short question is faster than a conversational round trip, and the answer goes
  back to Jev through arming.
- **Asked once.** A reply that still leaves the value unclear falls back (no loops).
- **No match → silent fallback** (setting `onNoMatch`: `fallback` default, or `say` = "I can't do that." for an owner who
  wants Jev to stay strict).
- **`speakBeforeDone`** (default on): `announce` plays while the action runs. Off: it is spoken after `run` succeeds (adds
  the action's time, ≈ 50–150 ms for Home Assistant on the LAN, *estimate*).

### 3.5 Local value parsing (piece C, `packages/core/src/ValueParsing.ts`)

`parseValues: ValueParser` returns candidates `{ text, value }` for `number` and `duration`, English and Dutch:

- numbers: digits ("40", "21.5", "21,5"), words 0–100 ("forty", "veertig", "eenentwintig"), "a/one/een", "half/halve",
  "a quarter/een kwart", percentages ("40%", "forty percent", "veertig procent");
- durations: `<number> <unit>` with second(s)/seconde(n), minute(s)/minuut/minuten, hour(s)/uur, "an hour and a half",
  "anderhalf uur", "een kwartier" (15 min), "half an hour/half uur", combinations ("one hour twenty minutes");
- a number followed by the parameter's `unit` word ranks first; candidates out of range are dropped by the plan.

Tested with a table of English and Dutch phrases. The free-text kind is `extractText` (real code in `Decision.ts`).

### 3.6 The intent agent (piece C, `packages/core/src/IntentAgent.ts` + `packages/agent-intent`)

`makeIntentAgent({ decider: () => DecisionProvider | undefined, thresholds, parse, onNoMatch, speakBeforeDone,
pendingMs, timeoutMs })` returns an `AgentImplementation` with `speculate: true`:

1. `pending` = its own stored pending intent if younger than `pendingMs` (else dropped).
2. `plan = buildDecisionPlan({ utterance: input.text, actions: input.actions, pending, parse })`. No actions and no pending →
   `Handoff("no actions")` at once (no request).
3. Decider: the configured one from `input.deciders` (`jev-typesafe` by default); if it is not running, `keywords`, with
   the status line "TypeSafe key not set: using offline keyword matching". `mark("decisionSent")`, `decide` with
   `timeoutMs` (default 1200 ms; no retries), `mark("decisionReceived")`. Error or timeout → `Decision { outcome: "error" }`
   + `Handoff`.
4. `interpretDecision` → outcome → as in the table above. Speech goes out as `TextDelta`s (one sentence each, so the chunker
   flushes them at once). The pending intent is stored only when the turn is committed (await `promoted` before storing).
5. Settings (the `jev` agent's form): `decider` (choice: TypeSafe Jev / Offline keywords), `fitsAccept`, `fitsReject`,
   `actionThreshold`, `paramThreshold`, `compoundThreshold` (advanced, 0–1 step 0.05), `onNoMatch`, `speakBeforeDone`,
   `timeoutMs`, `pendingSeconds`, test.

### 3.7 Decision providers

```ts
interface DecisionProvider {
  readonly id: string; readonly name: string; readonly location: "local" | "hosted"
  decide(request: DecisionRequest): Effect<DecisionResponse, DecisionError>   // DecisionError.reason: timeout | unavailable | rejected | invalid
}
```

- **TypeSafe Jev** (`packages/decide-typesafe`, piece I): plain `fetch` to `POST {baseUrl}/v1/systemone` (the SDK's 10 s
  timeout and two retries are wrong for voice; plain fetch keeps the dependency out), body `{ model, state, questions }`
  with `options` mapped to `criteria` and `role` removed, `Authorization: Bearer`, `AbortSignal` from the fiber, response
  validated with a `Schema` (`answers[name]` as `{ type: "choice", choice, probabilities }` or `{ type: "noul", noul }` →
  `value`). 401 → `ModuleStartError` at start (start sends one tiny request to check the key and measure the round trip),
  `unavailable` during a turn; 429/529/5xx → `unavailable`; 400/422 → `rejected` (logged with the body). Settings: `apiKey`
  (secret, env `TYPESAFE_API_KEY`, required), `model` (text, default `jev-1.14.0`, pinned: thresholds are
  version-specific), `baseUrl` (default `https://api.typesafe.ai`; any server speaking `/v1/systemone`, e.g. Ollama ≥ 0.35
  with the open Nimble model, works unchanged, English only and untested), `timeoutMs`, test. Status line: "Last decision
  241 ms". **Privacy:** only utterances routed to Jev leave the machine (TypeSafe documents no retention period); the card
  says so.
- **Offline keywords** (`packages/agent-intent/src/keywords.ts`, piece C): deterministic, local, no settings. Uses the
  question roles. `action`: score each action by the stemmed content words of the utterance found in its label,
  description and examples (stop words removed, English + Dutch list), probabilities = scores normalised; `fits` = 0.85 if
  the best action matched at least two content words or one example closely, 0.5 if one word, else 0.1; `compound` = 0.8 if
  the utterance contains "and/en/then" between two separately matching parts, else 0.05; `param` choices: an option whose
  label or alias appears in the utterance (phonetic match allowed) gets 0.9, else uniform; `stated`: 0.9 if some option
  appeared, else 0.1; `answers`: 0.9 if an option appears or the reply is short (≤ 4 words), else 0.2; `yes`: yes / ja /
  sure / doe maar / please → 0.95, no / nee / cancel → 0.05, else 0.5; `flag`: 0.5. Good enough to try the path and to
  test it; not a classifier.
- **Later, same interface**: a small local classifier (embeddings + nearest example), or a local language model with
  structured output. Each is one decider module.

### 3.8 The lights example, end to end

Where the rooms come from: the `demo-home` module's `rooms` setting (a `records` list: name + aliases, default Living room,
Kitchen, Bedroom, Office) and its lights; with Home Assistant, HA's areas and light entities (§3.9). Both expose
`target` options: one value per room (`area:<id>`), one per light (`light.<id>` / `light:<id>`), and `all`.

| ms after speech ends (*estimates* from §1.11) | What happens |
|---|---|
| 0 | Owner stops saying "Hey Jeff, turn on the lights in the living room." |
| 372 | `EagerEndOfTurn("Hey Jeff, turn on the lights in the living room.")` → speculative turn; router: phrase "hey jeff" (alias; also phonetic) → `jev`, text "Turn on the lights in the living room.", reason `trigger` |
| 372 | `jev.turn`: plan with `action` (all enabled actions), `fits`, `compound`, `demo-home.lights_on/target`, `…lights_off/target`, `…set_brightness/target`, `clock.time_now/zone(?)`; `decisionSent` |
| ≈ 620 | Jev answers: action `demo-home.lights_on` 0.96, fits 0.98, compound 0.03, target `area:living_room` 0.93 → ACT; `Decision` event (held by the publisher until promotion); `announce` → "Living room lights on." → chunker → Piper (≈ 30 ms) → buffered |
| 641 | `EndOfTurn` (same text) → promoted: `turn.start { agent: Jev, routedBy: trigger }`, `intent.decision`, playback starts (≈ 15 ms) |
| ≈ 656 | Owner hears "Living room lights on."; meanwhile `ActionStarted` → `home.switch("area:living_room", true)` (demo: in memory; HA: `POST /api/services/light/turn_on {"area_id":"living_room"}`, ≈ 50–150 ms) → `ActionFinished` |
| end | History: user "Turn on the lights in the living room." / assistant (`agentId: jev`) "Living room lights on." Trace: `agent=jev(trigger) decisionSent=-269 decisionReceived=-21 playbackStart=15 actionStarted=1 actionFinished=…` |

Without a room ("Hey Jev, lights on"): target probabilities flat → ASK "Which room or light?" → `ExpectReply` → "The kitchen"
(armed, no trigger needed) → `pending/answers` 0.95, `pending/answer` `area:kitchen` 0.95 → ACT. The same request typed to
Claude: Claude calls the generated tool `demo-home_lights_on { target: "living room" }`, resolved to `area:living_room`.

### 3.9 Modules (pieces D and K)

**`demo-home`** (`packages/modules-builtin/src/demoHome.ts`, no external dependency, enabled by default: it is how the path
is tried): an in-memory house. Settings: `rooms` (`records`: `name` text, `aliases` textList; defaults above), `lights`
(`records`: `name`, `room` text, `aliases`). Status line "4 rooms · 2 lights on". Actions: `lights_on`, `lights_off`
(`target`, dynamic), `set_brightness` (`target`, `level`: number 0–100, unit "percent"), `lights_status` (speculative,
no params: "The kitchen and the desk lamp are on."), `all_off` (`confirm: true`). Tool: `demo_home_state` (speculative).
State resets when the module restarts.

**`home-assistant`** (`packages/module-home-assistant`, piece K; the previous design's sketch, extended):

- Settings: `baseUrl` (env `HOME_ASSISTANT_URL`), `token` (secret, env `HOME_ASSISTANT_TOKEN`, required), `domains`
  (multichoice; this stage acts on `light` only), `timeoutMs` (2000).
- Start: `GET /api/config` (401 → "Home Assistant rejected the token …"), then the entity cache: one
  `POST /api/template` rendering a JSON list of areas with their light entities and friendly names
  (`{% for a in areas() %}…area_name(a)…area_entities(a)|select('match','light\\.')…{% endfor %}`, plus lights without an
  area), refreshed every 60 s and on a failed lookup. **[verify]** the template on the owner's HA version.
- Actions as in `demo-home` (`lights_on`, `lights_off`, `set_brightness`, `lights_status`), `target` options built from the
  cache (areas → `area:<area_id>`, lights → `light.<id>`, plus `all`), aliases from HA's area aliases where the template
  exposes them **[verify]**. `run` calls `light/turn_on` / `turn_off` with `area_id`, `entity_id` or `entity_id: "all"`;
  brightness via `brightness_pct`. Tool `home_state` (speculative) as sketched before.

**`clock`** gains `time_now` (speculative): optional `zone` (choice over the module's new `places` setting, a `records` list
of `{ name, zone }` with defaults Amsterdam → Europe/Amsterdam, London, New York, Tokyo); `run` says "It's 14:32." (or "In
Tokyo it's 22:32."). Tool generated (`clock_time_now`); the existing `current_time` tool stays.

**`weather`** gains `today` (speculative, `offerAsTool: false` because the `weather` tool exists): optional `place`
(`text`, after "in", "for", "at", "voor", max 4 words); `run` reuses the lookup and says "Amsterdam: light rain, 12
degrees; 9 to 14 today."

---

## 4. Settings

### 4.1 Audit

Every environment variable the app and its adapters read (grep of `Config.*`, `env:` and `process.env` on 2026-11-13), and
the fixed constants worth a decision. *Apply*: **live** = next turn or next form use; **module** = the module/agent restarts
(10 s grace for a turn in flight; no engine reload); **reload** = engine reload (≈ 2 s, interrupts a reply); **restart** =
process restart. Speech-recognition rows are the speech implementer's; the verdicts there are proposals.

| Setting | In the UI today | Should be | Where | Apply |
|---|---|---|---|---|
| `LLM_PROVIDER` | yes (Language model) | replaced by `DEFAULT_AGENT`; kept as a legacy alias and for `bench` | Agents → Routing | live |
| `DEFAULT_AGENT` (new) | — | yes | Agents → Routing | live |
| `ROUTING_RULES`, `ROUTING_GREETINGS`, `ROUTING_REQUIRE_GREETING`, `ROUTING_STICKY_IDLE_S`, `ROUTING_ARMED_S`, `ROUTING_ACKNOWLEDGEMENT`, `ROUTING_FALLBACK_AGENT` (new) | — | yes | Agents → Routing | live |
| `SYSTEM_PROMPT` | yes | yes | Agents → All agents | live |
| `MAX_TOOL_ROUNDS` | yes (reload) | yes, now live | Agents → All agents | live |
| `BARGE_IN` | no | no: serve always barges in and the per-device interrupt mode decides; CLI only | — | — |
| `ANTHROPIC_API_KEY` | yes (Language model) | yes | Agents → Claude (API) | module |
| `ANTHROPIC_MODEL` | yes (text) | yes, as a model picker | Agents → Claude (API) | module |
| `ANTHROPIC_MAX_TOKENS`, `ANTHROPIC_EFFORT`, `ANTHROPIC_THINKING`, `ANTHROPIC_TIMEOUT_MS`, `ANTHROPIC_WARM_UP`, `ANTHROPIC_BASE_URL` | no | yes, advanced | Agents → Claude (API) | module |
| `OPENROUTER_*`, `HOME_MODEL_*` (new: `BASE_URL`, `API_KEY`, `MODEL`, `SERVER`, `MAX_TOKENS`, `TIMEOUT_MS`) | — | yes | Agents → OpenRouter / Home model server | module |
| `CLAUDE_SUBSCRIPTION_OPT_IN`, `CLAUDE_SUBSCRIPTION_MODEL`, `CODEX_SUBSCRIPTION_OPT_IN`, `CODEX_SUBSCRIPTION_MODEL` (new) | — | yes | Agents → Claude / Codex subscription | module |
| `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `TYPESAFE_BASE_URL` (new) | — | yes | Agents → Decision providers → TypeSafe Jev | module |
| Jev thresholds, decider, `onNoMatch`, `speakBeforeDone`, timeouts (new) | — | yes (advanced for thresholds) | Agents → Jev | module |
| `BENCH_LLM_FIRST_TOKEN_MS`, `BENCH_LLM_TOKENS_PER_S` | no (env only) | yes, as the offline agent's "simulated speed" | Agents → Offline stand-in | module |
| other `BENCH_*`, `MOCK_*` | no | no (benchmark and mock tools) | — | — |
| `STT_PROVIDER` | yes (Speech engines) | yes | Speech | reload |
| `STT_SHERPA_MODEL`, `_EAGER_SILENCE_MS`, `_FINAL_SILENCE_MS`, `_VAD_THRESHOLD`, `_MIN_SPEECH_MS` | yes (Listening) | yes (speech implementer) | Speech → Listening | reload |
| `STT_SHERPA_LANGUAGE` | no | yes (owner asked for "language"; speech implementer) | Speech → Listening | reload |
| `STT_SHERPA_THREADS` | no | yes, advanced | Speech → Listening | reload |
| `STT_SHERPA_MODEL_DIR`, `TTS_SHERPA_MODEL_DIR` | no | no (paths on the server) | — | — |
| `DEEPGRAM_EOT_THRESHOLD`, `DEEPGRAM_EAGER_EOT_THRESHOLD` | yes (Listening, when Deepgram) | yes | Speech → Listening | reload |
| `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL` | no | yes (so Deepgram can be set up from the UI) | Speech → Hosted speech | reload |
| `DEEPGRAM_EOT_TIMEOUT_MS` | no | yes, advanced | Speech → Listening | reload |
| `DEEPGRAM_URL`, `CARTESIA_URL` | no | no (endpoints) | — | — |
| `TTS_PROVIDER` | yes (Speech engines) | yes, as the standard voice's provider (`VOICE_STANDARD_PROVIDER`; `TTS_PROVIDER` stays the fallback) | Voices → standard | reload |
| `VOICES` | yes | yes | Voices | reload |
| `DEFAULT_VOICE` | yes | yes | Voices | live (reload if not enabled) |
| `VOICE_<NAME>_PROVIDER` | no | yes | Voices → each voice | reload |
| `VOICE_<NAME>_TTS_SHERPA_PRESET`, `_SPEED`, `_TRIM_SILENCE`, `_CLAUSE_PAUSE_MS`, `_SENTENCE_PAUSE_MS` | no | yes | Voices → each local voice | reload |
| `VOICE_<NAME>_TTS_SHERPA_PAD_MS`, `_CHUNK_MS`, `_THREADS` | no | yes, advanced | Voices → each local voice | reload |
| `VOICE_<NAME>_CARTESIA_VOICE`, `_CARTESIA_MODEL`, `_CARTESIA_LANGUAGE` | no | yes | Voices → each Cartesia voice | reload |
| `VOICE_<NAME>_CARTESIA_MAX_BUFFER_DELAY_MS` | no | yes, advanced | Voices → each Cartesia voice | reload |
| `CARTESIA_SAMPLE_RATE` | no | no (the router plays at the default voice's rate and resamples; nothing to gain) | — | — |
| `CARTESIA_API_KEY` | no | yes | Voices → Hosted voice services | reload |
| `CLOCK_TIME_ZONE`, clock `locale`, clock `places` (new) | yes / yes / — | yes | Modules → Clock | module |
| `WEATHER_DEFAULT_PLACE`, `WEATHER_UNITS`, weather `timeoutMs` | yes | yes | Modules → Weather | module |
| `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN`, HA `domains`, `timeoutMs` (new) | — | yes | Modules → Home Assistant | module |
| demo-home `rooms`, `lights` (new) | — | yes | Modules → Demo home | module |
| `AUDIO_BACKEND`, `AUDIO_INPUT_FILE`, `AUDIO_INPUT_TRAILING_SILENCE_MS`, `AUDIO_OUTPUT_DIR`, `PIPEWIRE_*` | no | no (CLI modes only; serve uses the browser) | — | — |
| `SERVE_HOST`, `SERVE_PORT`, `SERVE_ALLOWED_ORIGINS`, `SERVE_TLS_CERT`, `SERVE_TLS_KEY` | no | no: process-level, and letting the page change its own exposure is a security risk | — | restart |
| `PVA_WEB_DIR`, `PVA_DATA_DIR`, `NEXT_PUBLIC_PVA_WS_URL`, `INIT_CWD`, `NODE_ENV` | no | no | — | — |
| Constants: module start limit 10 s, grace 10 s, context provider 50 ms, playback stall 2 s, echo-gate thresholds, Publisher limits | no | no: correctness limits with tests, not preferences | — | — |
| Per device (browser `localStorage`): interrupt mode, microphone (+ the speech implementer's per-device options), speaker, output path, prebuffer, captions, latency readout | yes | yes; add "Composer agent" (Auto or an agent) and "Show Jev's decisions in the chat" (default on) | This device / composer | live |

`.env.example` (piece H, after the speech implementer): new blocks for agents, routing, TypeSafe, Home Assistant, all
commented out (a value set there locks the UI field).

### 4.2 Screen structure

Tabs are data (`src/ui/registry.ts`). Which cards go where is decided from server data only: `ModuleInfo.kind` and
`SettingsSection.group` (both closed sets in the protocol); the UI never names an agent or module.

| Tab | Content, in order |
|---|---|
| **Agents** | (1) *Who answers*: the active agent from `routing` ("Claude subscription · sticky · 1:43 left" + **Back to default**), (2) sections of group `agents` in server order: **Routing** (default agent, fallback agent, rules, greetings, timings, acknowledgement) and **All agents** (system prompt, tool rounds), (3) cards of `kind: "agent"` modules in catalog order: switch, name, kind chip (`API` model / `SUBSCRIPTION` harness / `COMMANDS` intent / `LOCAL` when the agent says so in its status), `DEFAULT` / `ACTIVE` badges, status line; expanded: error, form (model picker, keys, own system prompt, speculation, Test with its result), (4) heading *Decision providers* and the `kind: "decider"` cards |
| **Modules** | cards of `kind: "capability"` (or absent) modules, as today, plus an **Actions** list in the expanded card: label, parameters (`Room or light: Living room, Kitchen, …`), chips `READ-ONLY` (speculative), `ASKS FIRST` (confirm), `ALSO A TOOL` with the tool name |
| **Speech** | sections of group `speech` in server order (Listening, Speech engines, Hosted speech: the speech implementer's fields; proposal: recognition model and language first, then turn timing, thresholds under Advanced) |
| **Voices** | the engines list (`EngineStatus.voices`, read-only), the **Voices** section (default voice, enabled voices), then one card per `voice-<name>` section with its fields and **Play a sample**, then **Hosted voice services** (Cartesia key) |
| **This device** | as today, plus the speech implementer's microphone options and "Show Jev's decisions in the chat" |
| **About** | as today |
| *General* | sections with group `general` or none; the tab is shown only when such a section exists |

Engine-reload fields keep the existing note and "Saved changes need an engine reload" bar (Speech and Voices tabs).

### 4.3 New field types (protocol `agents.ts`, core `SettingsExtra.ts`)

| Type | Value | Server (core) | Renderer (web) |
|---|---|---|---|
| `textList` | `string[]` | trimmed, empty and duplicate (case-insensitive) items dropped, `maxItems`, `itemMaxLength`; env: comma-separated | chips with × and an input that adds on Enter or comma; counter near `maxItems` |
| `records` | `RecordValue[]` | each item decoded with its `itemFields` (v1 non-secret types + `textList`), missing keys = defaults, unknown keys dropped, errors name the item ("Rule 2, Agent: …"), optional whole-list `check`; env: JSON | one row per item titled by `titleKey` (choice label) + a summary of the other values; expands into a small form using the same renderers; **Add <itemLabel>**, remove, move up/down when `orderable`; the whole list is the patch value |
| `combo` | `string` | non-empty, `maxLength`; must be a static option unless `allowCustom`; the form's `options` = static options + the running instance's `settingOptions()[key]` (deduplicated), `optionsNote` set by the host ("From the server's model list" / "Agent not running: type a name") | text input with a filtering dropdown of options (label, value in mono); free text allowed when `allowCustom` |
| `action` | none | never in `values`; never patchable; handler = instance `fieldActions[key]` (module) or the server's (section) | button `buttonLabel`; optional confirm dialog; disabled with "Save first" while dirty if `requiresSaved`; spinner, then `result.detail` text (tone colour) under it until the form closes |
| `info` | `string` | value from the instance's `info()[key]`, "" when not running; patching it is an error ("Read-only") | read-only text with a tone dot |

Rules kept: one renderer per type (`fieldRenderers: Record<SettingFieldTypeV2, …>`, so a missing renderer is a compile
error), the UI renders only what the server describes, secrets keep the previous handling (write-only, `SecretState`,
`secrets.json` 0600, environment wins and locks). Patches never contain `action` or `info` keys; `records` and `textList`
are compared deeply for dirtiness. Core changes at integration (piece G): `Setting<A>.type`/`describe` widen to v2,
`SettingExtra` joins `Setting`, `resolveSettings` skips `action` fields and leaves `info` to the host,
`applySettingsPatch` rejects both.

### 4.4 Sections and forms

**`routing`** (group `agents`, title "Routing", all live; new file `apps/assistant/src/serve/routingSection.ts`, piece H):
`DEFAULT_AGENT` (choice over catalog agents; default `anthropic` when `ANTHROPIC_API_KEY` is set, else `offline`; legacy
`LLM_PROVIDER` honoured when unset), `ROUTING_FALLBACK_AGENT` (choice: none or a conversational agent), `ROUTING_RULES`
(`records`: `agent` choice over catalog agents + "The default agent" (`@default`), `phrases` textList ≤ 10, `mode` choice
"That sentence" / "Following sentences too"; `orderable`; check: at least one phrase per rule), `ROUTING_GREETINGS`
(textList), `ROUTING_REQUIRE_GREETING` (boolean, advanced), `ROUTING_STICKY_IDLE_S` (number 10–3600 s, default 120),
`ROUTING_ARMED_S` (number 3–60 s, default 10, advanced), `ROUTING_ACKNOWLEDGEMENT` (text, default "Yes?").

**`conversation`** (group `agents`, title "All agents"): `SYSTEM_PROMPT`, `MAX_TOOL_ROUNDS` (now live).

**Agent forms** (module settings, §1.7–1.8, §3.6, §3.7). Every agent's form ends with the host-added `test` action and an
`info` "Last test" value.

**`voices`** (group `voices`): `DEFAULT_VOICE`, `VOICES` (as today).

**`voice-<name>`** (group `voices`, one per declared voice; new file `apps/assistant/src/serve/voiceSections.ts`, piece H).
Keys are the existing prefixed variables, so the providers read them through the existing `VOICE_<NAME>_` wrapper and the
section overlay with no adapter change; `env` on each field is the same name (an environment value locks it):

| Field (for voice `natural`) | Type | Shown when |
|---|---|---|
| `VOICE_NATURAL_PROVIDER` | choice (sherpa = on this machine, cartesia = hosted) | always |
| `VOICE_NATURAL_TTS_SHERPA_PRESET` | choice over the tts-sherpa presets | local |
| `VOICE_NATURAL_TTS_SHERPA_SPEED` | number 0.5–2.0, step 0.05 | local |
| `VOICE_NATURAL_TTS_SHERPA_TRIM_SILENCE` | boolean | local |
| `VOICE_NATURAL_TTS_SHERPA_CLAUSE_PAUSE_MS` / `_SENTENCE_PAUSE_MS` | number 0–1000 / 0–1500 ms | local |
| `VOICE_NATURAL_TTS_SHERPA_PAD_MS`, `_CHUNK_MS`, `_THREADS` | number, advanced | local |
| `VOICE_NATURAL_CARTESIA_VOICE`, `_CARTESIA_MODEL` (combo), `_CARTESIA_LANGUAGE` | text / combo / text | hosted |
| `VOICE_NATURAL_CARTESIA_MAX_BUFFER_DELAY_MS` | number, advanced | hosted |
| `PLAY_SAMPLE` | action "Play a sample" (`requiresSaved`) | always |

The fields shown depend on the saved provider (as `listening` depends on `STT_PROVIDER` today); changing the provider
announces the section again. All value fields are `reload` (the engines read them at start; making speed and pauses live
needs a tts-sherpa change, left out). **Play a sample** sends `Say { text: "[voice:<name>] This is the <name> voice. The
quick brown fox jumps over the lazy dog.", voice }` to the conversation: it is heard on the owner's device with the
running engines, so after changing a value the owner saves, reloads (the bar offers it), then plays. When the voice is not
enabled in the running engines the result says "Enable this voice and reload the engines first."

**`voice-services`** (group `voices`, "Hosted voice services"): `CARTESIA_API_KEY` (secret, reload).

**Speech** (group `speech`): the existing `listening` and `speech` sections, owned by the speech implementer, gain
`group: "speech"`; proposed additions for them: `STT_SHERPA_LANGUAGE`, `STT_SHERPA_THREADS` (advanced),
`DEEPGRAM_EOT_TIMEOUT_MS` (advanced), and a `speech-services` section with `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`. The
`language-model` section is removed (replaced by the Agents tab), which is one deletion in their file.

### 4.5 Secrets

Unchanged handling, applied to the new keys: OpenRouter, home server, TypeSafe, Home Assistant, Cartesia, Deepgram keys are
`secret` fields (write-only from the browser, environment wins). Since 2026-11-14 they are stored in the encrypted key
vault outside the project once the owner sets a password (before that, `secrets.json` at 0600), and agent modules and any
form with a secret are **protected**: only a page where the vault password was typed may change them
(docs/UI-AND-MODULES.md §1.6). Subscription agents hold no secrets at all: the CLIs keep their own logins, and the Claude
Code subprocess gets an allowlisted environment only.

---

## 5. Protocol and UI changes

### 5.1 Protocol additions (all defined in `packages/protocol/src/agents.ts`, examples in `agentExamples.ts`)

| Addition | Kind | Purpose |
|---|---|---|
| `TextListField`, `RecordsField` (+ `RecordItemField`), `ComboField`, `ActionField`, `InfoField`; `SettingFieldV2` | new field types (closed set) | §4.3 |
| `SettingValueV2` (adds `RecordValue[]`), `SettingsFormV2`, `SettingsPatchV2` | wider value union | records |
| `module.action { requestId, moduleId, key }`, `settings.action { requestId, sectionId, key }` | client → server | action buttons; answered with `result` + `detail` |
| `routing.set { requestId, agentId \| null }` | client → server | make an agent sticky / back to default |
| `routing { routing: RoutingInfo }` | server → all | active agent, reason, expiry; also `snapshot.routing` |
| `intent.decision { turnId, agentId, decider, outcome, action?, params, probability?, ms, reason? }` | server → all | Jev's decision in the chat |
| `turn.agent { turnId, agent, from, reason }` | server → all | hand-off / failure fallback mid-turn |
| `TextSend.agentId?` | optional field | composer choice |
| `TurnStart.agent?`, `routedBy?`, `fallbackFrom?`, `agentText?` | optional fields | who answers and why |
| `ToolStart.kind?` (`tool` / `action`), `label?` | optional fields | actions shown like tools |
| `ModuleInfo.kind?`, `agentKind?`, `actions?` (`ActionInfo[]`) | optional fields | tabs and action lists |
| `SettingsSection.group?` | optional field | tabs |
| `HistoryItem.agentId?` (assistant) | optional field | who answered, after a reload |
| `Result.detail?` | optional field | action results |
| `TraceInfo.agent?`, marks `decisionSent?`, `decisionReceived?`, `actionStarted?`, `actionFinished?` | optional fields | latency readout per agent |
| `ErrorCodeV2` adds `unknown_action`, `action_failed`, `agent_unavailable` | closed set | new failures |

**Versioning.** New field types and error codes are new members of closed literal sets, so this is protocol **2**. The
optional fields and new messages alone would not need a bump, but they ship together. The UI is served by the assistant,
so the bump means a stale tab sees "This page is older than the assistant · Reload". The merge is one change (piece G):
spread the field records into the existing structs (`TurnStart.mapFields((f) => ({ ...f, ...TurnStartAgentFields }))`, as
`test/agents.test.ts` does), add the messages to the unions, swap `SettingField`/`SettingValue`/`ErrorCode` for the V2
versions, move `agentExamples` into `examples.ts` (the "every message has an example" test then covers them), set
`PROTOCOL_VERSION = 2`, and update the web mock server.

### 5.2 Server mapping (piece F, `Publisher.ts` / `SessionHub.ts`)

| Conversation / host event | Message |
|---|---|
| `TurnStarted` (+ agent fields) | `turn.start` with `agent`, `routedBy`, `fallbackFrom`, `agentText` (buffered while speculative, as today) |
| `TurnAgentChanged` | `turn.agent` |
| `IntentDecided` | `intent.decision` |
| `ActionStarted` / `ActionFinished` | `tool.start { kind: "action", label, tool: <tool name>, moduleId }` / `tool.end` |
| `RoutingChanged`, `routing.set` handled | `routing` (to all) |
| `TurnStarted { canned: true }` | `turn.start` + `assistant.text` as usual (the chat shows "Yes?" like any reply); not in history |
| `module.action` | host → instance `fieldActions[key]` (or the generated `test`); `result { ok, detail }`; then `module.changed` if `info` changed |
| `settings.action` | section handler (`PLAY_SAMPLE` → `engine.send(Say)`); `result { ok, detail }` |
| `text.send { agentId }` | `TextInput { agentId }`; unknown or stopped agent → `result agent_unavailable` |

History projection: assistant items get `agentId`; the user item shows the stored (trigger-free) text.

### 5.3 UI (piece G, `apps/web`)

- **State** (`state.ts`): `TurnView` gains `agent?: AgentRef`, `routedBy?`, `fallbackFrom?`, `decision?: IntentDecision`,
  and tools with `kind`/`label`; `ClientState` gains `routing?: RoutingInfo`. The reducer handles `routing`,
  `intent.decision`, `turn.agent` (replace the turn's `agent`, keep `fallbackFrom`).
- **Chat**: the speaker label of a reply is the agent's name (`JEV`, `CLAUDE (API)`), in the same mono label style; a muted
  line above a fallback reply: "Codex isn't available · answered by Claude (API)" / "Jev passed this on · no matching
  action". An intent turn shows a decision chip: `Turn lights on · Room or light: Living room · 93 % · 241 ms`, the action
  as a tool chip with its label and ok/error state; `ask` shows the question as the reply; low probabilities (< 0.7) in
  `warn`. Per-device toggle hides the chips.
- **Stage**: the label shows the agent while thinking/speaking (`THINKING · JEV`, `SPEAKING · CLAUDE (API) · natural`).
  When the active agent is not the default, a chip under the top bar: "Claude subscription · 1:43" with × (`routing.set
  null`), counting down from `expiresInMs`.
- **Composer**: agent chip at the left: "Auto" (shows the active agent's name in muted text) or a chosen agent; menu of
  running agents + Auto; sends `text.send.agentId`.
- **Latency popover**: columns `agent` and `decision` (`decisionReceived − decisionSent`).
- **Options**: the tabs of §4.2; renderers for the five field types; `ModuleCard` gains the kind chip, badges, the Actions
  list and action-field results; a `VoicesTab` and `AgentsTab` composed from the existing `SettingsForm` and `ModuleCard`.
- **Mock server and tests**: scenarios `agents` (routing chip, a Jev turn with decision and action, a hand-off, a fallback
  notice) and `settings-v2` (every new field type, an action with a result). Playwright: the Agents tab, a routed typed
  message, records editing.

---

## 6. Build plan

Each piece is testable on its own without API keys, subscriptions or a home-automation system, keeps `pnpm check` and
`pnpm test` green, and owns the files listed (nobody else edits them while it runs). Pieces F, G and H touch `apps/assistant`
and `apps/web`, which the speech-recognition implementer is editing now: **they start when that work has landed**. All
others can start at once against the interfaces already in `core` and `protocol`.

| # | Piece | Owns | Depends on | Tested with (no keys) | Needs from the owner to verify for real |
|---|---|---|---|---|---|
| **A** | Agent core and routing integration: `ModelAgent.ts`; `Conversation` refactor (`makeAgentConversation`, routing at turn start, router state on commit, canned turns, availability notice, hand-off and failure fallback, `Say`, `SetActiveAgent`, new events); `ModuleDefinition`/`ModuleHost` (kind, contributions, snapshot `agents`/`actions`/`deciders`, generated action tools via `actionTool`, clash check, generated agent `test`); `TurnTrace` (agent, marks, `formatTrace`); `Domain` (`Message.agentId`); `testing.ts` (`makeScriptedAgent`) | `packages/core/src/{Conversation,ConversationEvents,ModelAgent,ModuleDefinition,ModuleHost,TurnTrace,Domain,Actions,testing}.ts` and their tests | — | the 100 existing core tests unchanged; new: routing per reason, trigger-only ack, arming via `ExpectReply`, sticky across turns, discarded speculative turn leaves state, harness `speculate: false` waits for promotion, hand-off, failure before/after text, unavailable notice, rounds from tool events, actions not in history, `MAX_TOOL_ROUNDS` live | nothing |
| **C** | Intent path: `IntentAgent.ts`, `ValueParsing.ts` (core); `packages/agent-intent` (`jev` agent definition, `keywords` decider) | those files | A's `Agent` (exists) | `makeScriptedDecider`; table tests for EN/NL numbers and durations; intent agent turns driven directly (act, ask → answer, confirm, cancel, no match → `Handoff`, decider timeout → `Handoff`, `announce` before `promoted`, read-only action before promotion) | TypeSafe key (via I) |
| **D** | Modules: `demo-home` (constant default house first; `records` settings after G), `clock.time_now`, `weather.today` | `packages/modules-builtin/src/*` | `ModuleContributions` (exists) | module tests as today (start in a scope, call actions, `weatherModule({ fetch })`) | nothing |
| **E** | OpenAI-compatible: `packages/llm-openai-compatible` (`Llm` adapter, profiles, model list) + `openrouter` / `home-model` agent definitions | that package | A's `makeModelAgent` for the agent files only | a local scripted SSE server (text deltas, tool-call fragments by index, `:` comments, reasoning deltas, mid-stream error chunk, abort) | OpenRouter key; or the home server's address and a loaded model |
| **F** | App wiring: `apps/assistant/src/agents.ts` (catalog), `agents/offline.ts`, `packages/llm-anthropic/src/agent.ts`; serve: engine without an LLM stage, setup with agents and router, Publisher/SessionHub mappings (§5.2), CLI modes on agents; ARCHITECTURE.md and README | `apps/assistant/src/{agents.ts,agents/,main.ts,text.ts,voice.ts,serve/Engine.ts,serve/serveMode.ts,serve/Publisher.ts,serve/SessionHub.ts}`, `packages/llm-anthropic/src/agent.ts`, docs | A; speech implementer done; G's protocol merge for the new messages (F can land core wiring first and the messages with G) | serve tests with the scripted client, scripted agents and `FakeLlm`: a Jev turn end to end with `demo-home` and the keyword decider, a hand-off, `routing.set`, `module.action` test | Anthropic API key (never tested yet) |
| **G** | Protocol v2 and web: merge `agents.ts` into the unions, `PROTOCOL_VERSION = 2`; core `Settings.ts` widening + `SettingExtra` in `Setting` + host form additions (combo options, info, kind, actions); web state, renderers, tabs, chat/stage/composer changes, mock server, e2e | `packages/protocol/src/*`, `packages/core/src/Settings.ts`, `apps/web/**` | speech implementer done; A (host) | reducer tests from examples; renderer tests per field type; Playwright against the mock | nothing |
| **H** | Settings sections: `routingSection.ts`, `voiceSections.ts`, `group` on all sections, speech-section proposals agreed with the speech implementer, `language-model` removed, `.env.example`; `demo-home`/clock to `records` | `apps/assistant/src/serve/{sections,routingSection,voiceSections}.ts`, `.env.example`, `packages/modules-builtin` settings | G | section tests (resolve, patch, env lock, provider-dependent voice fields), Play a sample through the scripted client | nothing |
| **I** | Jev decider: `packages/decide-typesafe` | that package | `defineDecider` (exists) | a local fake `/v1/systemone` server (answers, 401, 429, 422, slow → timeout) | **TypeSafe API key**: real latency from this machine, threshold tuning on ~30 owner utterances, Dutch |
| **J** | Claude subscription: `packages/agent-claude-code` | that package | `Agent` (exists); A for the integrated test | an injected fake `query()` (deltas, tool calls through the MCP handler, interrupt result, crash) | the **opt-in decision** (Claude is already logged in on this machine): warm/cold numbers through `TurnTrace`, resume after interrupt, `alwaysLoad` |
| **K** | Home Assistant: `packages/module-home-assistant` | that package | actions interface (exists) | a fake HA HTTP server (`/api/config`, `/api/template`, services, 401) | **Home Assistant address and long-lived token**: template on the real version, area aliases, action latency |
| **L** | Codex subscription: `packages/agent-codex` | that package | `Agent`; A | a scripted app-server transport | **`codex login`** on this machine, then the §1.8 verify list |

Order by value (what to finish first when people are scarce): **A → C + D → E → F → G + H → I → J → K → L**. After A, C, D
and F, the owner can say "hey Jev, turn on the living room lights" in the browser (offline keyword decider, demo home) and
see the decision in the chat once G lands.

**What the owner supplies, and what each unlocks**

| Supply | Unlocks |
|---|---|
| A TypeSafe API key (console.typesafe.ai/keys) and agreement that "hey Jev" sentences are sent to TypeSafe | Real Jev decisions, measured latency, threshold tuning, a Dutch check |
| An Anthropic API key | The supported default conversational agent, measured for the first time |
| An OpenRouter key, and/or the home model server's address, server type and a loaded model | `openrouter` / `home-model` agents with measured TTFT |
| The decision to opt in to using the Claude subscription (terms unclear) | `claude-subscription`, measured |
| `codex login` (Sign in with ChatGPT, device code on a headless machine) and the same opt-in | `codex-subscription` can be finished and measured |
| Home Assistant address and a long-lived access token (or the name of the system actually used) | Real lights and rooms |

---

## 7. Deliberately left out

- Creating agents from the UI (several instances of one kind at run time). Each instance is one catalog line.
- Several actions in one sentence ("lights on and blinds down"): detected and passed to the conversational agent.
- Timers, reminders and anything a module would have to say on its own later (modules still cannot speak by themselves).
- Confirmation before side-effecting *tools* of conversational agents (actions have `confirm`, enforced for their
  generated tools since review round 5; hand-written module tools still have none).
- Running the conversational agent in parallel with Jev "just in case" (wastes tokens on every command).
- Committing an intent turn before the final silence when the decision is confident (the obvious next latency step for
  commands; needs data from real use).
- Live voice speed and pauses (needs a tts-sherpa change), per-agent voices, editing voice descriptions.
- Clearing or persisting the conversation; agent-to-agent delegation; external MCP servers for harness agents; Codex tools
  until registration is verified.
- A local decision model (Nimble through Ollama works through the Jev provider's base URL, untested and English only).
- A wake word: trigger phrases work only while a tab owns the audio.

## 8. Open questions for the owner (with the default used)

1. **Which agent answers by default?** *Default: Claude (API) once `ANTHROPIC_API_KEY` is set; the offline stand-in until then.*
2. **Trigger phrases?** *Default: "hey Jev" (+ "hey Jeff"), "hey Claude", "hey Codex", "hey router", "hey local", and "hey assistant" / "back to normal" for the default.*
3. **Should "hey Claude" keep Claude for follow-up questions?** *Default: yes, until another trigger, "hey assistant", the × in the UI, or 2 minutes without a turn. Jev is one sentence only.*
4. **Use the Claude and Codex subscriptions despite unclear terms?** *Default: off; each has an explicit opt-in switch.*
5. **Is it acceptable that sentences starting with "hey Jev" go to TypeSafe** (retention period undocumented)? *Default: yes once you add the key; nothing else is sent; without a key the offline keyword matcher is used.*
6. **Which home-automation system?** *Default: Home Assistant (module built, off until you add the address and token); the demo home works without one.*
7. **Will you give commands in Dutch?** *Default: English action descriptions with Dutch aliases and examples; checked once the key is there.*
8. **Hear "Living room lights on." before the light has actually switched?** *Default: yes (≈ 50–150 ms sooner; a failure is said afterwards).*
9. **Let Claude/Codex start before you finish speaking?** *Default: no (saves ≈ 270 ms but can leave half sentences in their session and spends quota); per-agent switch.*
10. **Should Jev ever be the default agent** (every sentence tried as a command first)? *Default: no; allowed in the settings, and it adds ≈ 250 ms to every conversational answer.*

## 9. Changes to existing interfaces

All additive unless marked. Nothing here is done yet; the pieces do it.

| Interface | Change | Why | Piece |
|---|---|---|---|
| `Conversation` | new `makeAgentConversation` / `layerWithAgents`; `layer`/`layerWithSetup` become wrappers (same signatures and behaviour); tool loop moves to `ModelAgent.ts` | agents behind one interface | A |
| `ConversationInput` | `TextInput.agentId?`; new `SetActiveAgent`, `Say` | composer choice, `routing.set`, samples and acknowledgements | A |
| `ConversationEvent` | `TurnStarted` + `agentId?`, `routedBy?`, `fallbackFrom?`, `agentText?`, `canned?`; new `TurnAgentChanged`, `IntentDecided`, `ActionStarted`, `ActionFinished`, `RoutingChanged` | UI and trace | A |
| `TurnSetup` | extended by `AgentTurnSetup` (`agents: AgentSet`) | per-turn snapshot of agents and router | A |
| `Message` (assistant) | `agentId?` | who said it (catch-up, UI) | A |
| `Trace` / `traceMarks` | `agent?`; marks `decisionSent`, `decisionReceived`, `actionStarted`, `actionFinished` | attribution | A |
| `ModuleInstance` | absorbs `ModuleContributions` (`agents`, `actions`, `deciders`, `settingOptions`, `info`, `fieldActions`) | everything pluggable is a module | A |
| `ModuleDefinition` | `kind?`, `agentKind?` | tabs | A |
| `ModuleSnapshot` | `agents`, `actions`, `deciders`; generated action tools in `registry` and `toolModules` | per-turn use | A |
| `ModuleHost.modules()` (`ModuleInfo`) | `kind`, `agentKind`, `actions`, combo options, `info` values, generated `test` field | UI | G (needs protocol v2) |
| `Setting` / `resolveSettings` / `applySettingsPatch` | **widened** to v2 field types; skip `action`, host fills `info` | new field types | G |
| `@pva/protocol` | v2 (§5.1); `SettingField`, `SettingValue`, `ErrorCode` **replaced** by the V2 unions | closed sets grow | G |
| `Llm`, `Stt`, `Tts`, `AudioInput`, `AudioOutput`, `ToolRegistry`, `Tool`, `SttEvent` | unchanged | | |
| `llm-anthropic` | unchanged; new `agent.ts` | | F |
| `apps/assistant` engine | no LLM stage in serve; agents come from the module host; `language-model` section removed | agents are modules | F, H |
