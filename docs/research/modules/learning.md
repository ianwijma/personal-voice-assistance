# Learning: tutor, flashcards, quizzes, homework help, progress

Research write-up, 2026-11-18. Not an approved design. It uses the foundation names in [README.md](README.md) and
builds on [current-system.md](../module-investigation/current-system.md). Outside facts were checked on 2026-11-18 where
a link is given; anything else is marked **[unverified]**. Latency figures are estimates to be measured with
`TurnTrace`.

## 1. Summary

A tutor that lives in the house:

- **language practice conversations** at the learner's level, with corrections the learner chose (inline, at the
  end, or off);
- **spaced-repetition flashcards by voice**, in our own store or in the owner's Anki through AnkiConnect;
- **quizzes generated from the owner's own material** (a note, a document, a web page, a textbook chapter);
- **homework help that explains** and asks questions back instead of giving the answer;
- **progress per person**: what was practised, what is due, what keeps going wrong;
- a **Tutor assistant template**, and honest **pronunciation feedback** within the limits in §5.4.

Boundaries: simple trivia and riddles stay in [fun-and-ambient](fun-and-ambient.md) (no tracking, no spacing); the
phrasebook and the translation engines are in [translation](translation.md); stored notes come from
[memory-and-notes](memory-and-notes.md); the child-facing rules for homework are in [kids](kids.md).

- **Priority: second wave.** It needs `Person` records (progress is per person) and the Module store, and the language
  part shares the per-language voice change with translation.
- **Effort: M** for flashcards with an own store, quizzes, homework instructions and the template. **L** with
  AnkiConnect sync, language practice in a second language, and pronunciation assessment.

## 2. What others do

| Product | Behaviour | Copy | Avoid |
|---|---|---|---|
| Duolingo Max ("Video Call", "Explain My Answer") | LLM conversation practice with a character at the learner's level, explanations after mistakes **[unverified: current features]** | Level-bound conversation; explanation on request | Streak pressure and notification nagging |
| ChatGPT and Gemini voice modes | Free conversation in any language; correct on request | Correction style as a user choice | Corrections that break the flow of every sentence |
| Khanmigo (Khan Academy) | Socratic tutor that does not give answers; teacher and parent views **[unverified: details]** | "Explain, don't answer"; a parent view | — |
| [Anki](https://apps.ankiweb.net/) + [AnkiConnect](https://git.foosoft.net/alex/anki-connect) | The standard flashcard tool, FSRS scheduling; AnkiConnect exposes a local HTTP API on port 8765 | Reuse the owner's decks; FSRS | Building a second Anki UI |
| Alexa "Flashcards" skills, Google "quiz me" | Simple card decks by voice **[unverified: availability]** | Short spoken cards | No spacing, no grading |
| Speechling, ELSA Speak | Pronunciation feedback per sound **[unverified]** | Scores per sound, minimal pairs | Claims of precision the audio cannot support |

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | "Hey Tutor, let's practise Spanish, ten minutes, about my weekend." → in Spanish, slowly: "¡Hola! ¿Qué hiciste el fin de semana?" → "Yo fui a la playa con mi hermana." → "¡Qué bien! ¿Hizo buen tiempo?" At the end: "Two things to remember: *el fin de semana pasado*, and *fui* was right. Want them as cards?" | optional: corrections as a `list` |
| 2 | Inline correction chosen: "Ayer yo voy al mercado." → "*Fui* al mercado: ayer is past. ¿Qué compraste?" | no |
| 3 | "Quiz me on my Spanish cards." → `cards_due` → "Twelve due. First: 'the umbrella'." → "El paraguas." → "Right. Next: 'to borrow'." → "Prestar?" → "Close: *pedir prestado* is to borrow, *prestar* is to lend. Again in a minute." | optional: the card |
| 4 | "Make a quiz from my biology notes on cells, five questions." → `quiz_make` over the note → five questions, the answers checked against the note, with the line it came from. | optional |
| 5 | Child: "What's 3/4 plus 1/8? It's for homework." → "Let's do it together. What would you need to make the bottoms the same?" → "Eight?" → "Yes. So three quarters is how many eighths?" The final answer is given only after the child tries, or on a parent's setting. | optional: the working as `steps` |
| 6 | "How am I doing with Spanish?" → `progress` → "This week: 3 conversations, 84 cards, 91 % right. Past tense of *ir* keeps tripping you up." | optional: `chart` |
| 7 | "How's my pronunciation of *perro*?" → "I understood *pero*, 'but'. Roll the double r longer: *perrrro*. Try again?" (§5.4: intelligibility, not a phoneme score) | no |
| 8 | Ambiguous: "Add 'gezellig' to my cards." → which deck and which side? → "To your Dutch-for-Anna deck, as 'gezellig' → 'cosy, convivial'?" | no |
| 9 | Failure: "Review my Anki cards." with Anki not running on the desktop → "Anki isn't open on your computer, so I can't reach your decks. I can quiz you from the cards I have here instead." | no |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `practice_start` | `language`, `level?: "A1".."C2"`, `topic?`, `minutes?`, `correction?: "inline" \| "end" \| "off"` | the session as set; switches the reply language and voice | W (conversation) | safe | < 50 ms | no |
| `practice_end` | none | corrections collected, new words, suggested cards | W | safe | < 50 ms + model summary | no |
| `cards_due` | `deck?`, `limit?` | due cards (id, front, back hidden) and counts | R | safe | own store < 20 ms; Anki 50–200 ms on LAN **[unverified]** | yes ("quiz me on my cards") |
| `card_answer` | `cardId`, `rating?: 1..4`, `said?` | the correct answer, the rating used, the next due time | W | changes data | < 30 ms | partly (rating words "again/hard/good/easy") |
| `card_add` | `front`, `back`, `deck?`, `tags?` | `{ id, deck }` | W | changes data | < 30 ms | no |
| `quiz_make` | `source: { note? , url?, document?, topic? }`, `count?`, `kind?: "open" \| "choice" \| "true-false"` | questions with answers and source lines (kept server-side) | W (conversation) | safe; outward when a URL is fetched | 2–6 s (a model call over the material) | no |
| `quiz_answer` | `answer` | correct or not, explanation, source line, score | W | safe | < 50 ms (+ model when judged) | no |
| `progress` | `person?`, `subject?`, `period?` | counts, accuracy, weak items, streak of days | R | safe | < 30 ms | yes |

`quiz_make` is a background-friendly tool: the assistant says "Give me a few seconds to read your notes" first.
Homework help needs no tool: it is an instruction in the Tutor template plus `calculate` from
[core-tools](core-tools.md) to check arithmetic.

## 5. Integrate or build

### 5.1 Flashcards

| Option | For | Against |
|---|---|---|
| **Own store with [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs)** (FSRS v6, TypeScript, Node ≥ 20) | Works on the server without a desktop; same algorithm family as Anki; per-person decks in the Module store | A second place for cards if the owner already uses Anki |
| **AnkiConnect** on the owner's desktop Anki | Real decks and history; `deckNames`, `findCards` (`deck:Spanish is:due`), `cardsInfo`, `answerCards` (`answers: [{ cardId, ease }]`, ease 1–4, [commit](https://git.foosoft.net/alex/anki-connect/commit/3892481cea8ed10a0782c2925923499e97ce5b04)), `addNote` | Anki must be running on a machine the server can reach; AnkiConnect listens on `127.0.0.1:8765` by default and needs `webBindAddress` and `webCorsOriginList` changed for LAN access **[unverified: key names]**; exact parameter shapes to check against the current README |
| Headless Anki (the `anki` Python package as a sidecar) | No desktop needed | Python service; collection locking with a desktop copy; sync through AnkiWeb has no public API **[unverified]** |

Recommendation: own store first, with an "import deck" from an `.apkg` or CSV export **[unverified: parsing
library]**; AnkiConnect as an optional provider behind the same tools for an owner who keeps Anki open.

Grading spoken answers: normalise (case, accents, articles), accept one edit as "right, but check the spelling", and
let the model judge synonyms. The rating is derived: wrong → 1, right after a hint → 2, right → 3, right fast → 4;
the learner can say "that was easy" to override.

### 5.2 Language practice

The conversation is the model's work with a fixed instruction per level (CEFR descriptors in short form, sentence
length, vocabulary limit, speech rate). What the system must add:

- **Hearing the learner's language.** One recogniser per device ([translation §5.2](translation.md#52-hearing-two-languages-on-one-device)):
  `parakeet-ultra` handles 25 European languages including Spanish; `whisper-turbo` with the language pinned is the
  more robust choice for accented speech but replies 1–3 s later. A recogniser's language model **corrects** errors
  toward fluent text: a learner's "yo voy ayer" may arrive as "yo fui ayer" **[unverified: frequency; measure]**, so
  grammar correction from transcripts under-reports mistakes.
- **Speaking the learner's language.** Piper voices exist for es, fr, de, it, pt and nl; the assistant needs the
  per-language voice map proposed in [translation §12](translation.md#12-interaction-with-the-rest-of-the-system),
  and a slower rate for A1–A2 **[unverified: rate control in our Piper path]**.

### 5.3 Quizzes from the owner's material

Sources: notes and journal through [memory-and-notes](memory-and-notes.md) `recall`/`read_notes`; a URL through
[web-search](web-search.md) `read_page`; Google Drive documents through [google](google.md); a PDF uploaded in admin
(text via pdfjs, as web-search proposes). The model writes questions **with the source sentence for each answer**,
stored server-side so the answer is checked against the source, not against the model's memory. Open questions
judged by the model; choice questions graded exactly.

### 5.4 Pronunciation, and its limits

| Method | What it tells | Limit |
|---|---|---|
| **Intelligibility check** (local, free): ask for a word or sentence, compare the transcript with the target | "I understood *pero*, not *perro*" | The recogniser guesses toward real words; it cannot say *which* sound was off |
| [Azure Pronunciation Assessment](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment) | Accuracy, fluency, completeness per word and phoneme; prosody (one page says en-US only) | Hosted, billed at the speech-to-text rate; a new adapter and key; sends the learner's voice out |
| Local phoneme recogniser (wav2vec2 phoneme models) plus goodness-of-pronunciation scoring | Phoneme-level, offline | Research-grade, no ready Node path, model size and accuracy **[unverified]** |
| The language model listening to audio | Natural-language feedback | Our LLM path sends text, not audio; not available today |

Recommendation: ship the intelligibility check and say what it is ("I understood…"); offer Azure as an optional
provider for a learner who wants scores. Never invent a score from a transcript.

## 6. Data

| Collection | Scope | Schema |
|---|---|---|
| `decks` | person (or household for a shared deck) | `{ name, language?, provider: "local" \| "anki", ankiDeck? }` |
| `cards` | person | `{ deckId, front, back, tags, fsrs: { due, stability, difficulty, reps, lapses, state }, source? }` |
| `reviews` | person | `{ cardId, rating, said, at, ms }` (append-only; FSRS can be re-fitted from it) |
| `practiceSessions` | person | `{ language, level, topic, minutes, corrections: [{ said, better, rule }], newWords }` |
| `quizzes` | conversation, kept as a summary per person | `{ source, questions[{ q, answer, sourceLine }], score }` |
| `learnerProfile` | person | `{ languages: [{ code, level }], correctionStyle, homeworkMode }` |

Other modules may read `learnerProfile.languages` (translation uses it for subtitles) and the weekly summary (kids'
parental review).

## 7. Long-running work and events

- A daily [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md) job counts due cards per person
  for the briefing line and the optional reminder (§9).
- `quiz_make` over a long document may exceed a turn: run it as a background job, then "Your quiz is ready" (needs the
  long-running tool support named in current-system §9 item 17).
- Events: `learning.review.done`, `learning.session.ended`. Listens to `memory.saved` only when the owner turns on
  "offer cards for notes tagged study".
- Restart: an in-flight practice conversation is lost with the conversation; reviews are written per answer.

## 8. Presentation

- Flashcards: a `card` with the front; the back revealed after the answer; tap ratings "again / hard / good / easy".
- Practice: corrections as a `list` at the end ("said → better → why"); the character keeps its normal modes, plus a
  small nod on a right answer once `reply.expression` exists ([CHARACTERS.md](../../CHARACTERS.md) §5.2).
- Homework: the working as `steps`, one revealed at a time.
- Progress: `facts` plus a `chart` of reviews per day.
- Without a screen: everything works by voice; ratings by the words "again, hard, good, easy".

## 9. Notifications and proactive behaviour

Opt-in per person only: one `low` inbox item or briefing line a day, "Twenty Spanish cards are due", on the person's
devices. No streak warnings, no "you'll lose your streak", never during quiet hours.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | which hosted services may hear learners' voices (Azure) | none |
| Module | flashcard provider (local, Anki); AnkiConnect URL and key (vault); pronunciation provider; daily due-card line | local; —; intelligibility; off |
| Assistant | Tutor template: persona, correction style default, modules `learning`, `core-tools`, `memory-and-notes` (read) | — |
| Device | practice allowed; reply rate for practice | on; normal |
| Person | languages and levels; correction style; homework mode (`explain` / `explain-then-answer`); reminder on/off | —; end; explain; off |

First run: create the Tutor assistant from the template, add a person's languages and level, optionally import a deck
or point at AnkiConnect.

## 11. Native tools and dependencies

| Dependency | Where | When missing |
|---|---|---|
| `ts-fsrs` (npm) | server | bundled |
| Anki desktop with AnkiConnect | the owner's computer | "Anki isn't open on your computer…" (example 9); local cards still work |
| A recogniser for the practice language | server | "This device only understands English and Dutch, so I can't practise Japanese here." |
| A voice for the practice language | server or hosted | The assistant speaks it in its own voice and says the accent will be off |
| Azure Speech key | vault | Intelligibility check only |

## 12. Interaction with the rest of the system

- **Recognition quirks.** Mixed-language turns ("how do you say *paraguas* again?") confuse a recogniser pinned to one
  language: practice uses `auto` on Parakeet Ultra. Single-word answers are short and VAD may drop them: lower
  `minSpeechMs` to about 100 ms during card review **[proposal; measure]**.
- **Numbers and spelling** in answers: "how do you spell it?" letter by letter, via the speakable helper proposed in
  [core-tools §12](core-tools.md#12-interaction-with-the-rest-of-the-system).
- **Fillers.** `quiz_make` says a filler; card review must feel instant (local store).
- **Template.** "Tutor": patient, short turns, asks before correcting, never does homework for the learner; wake phrase
  suggestion "hey tutor". The kids' assistant gets homework help with the child's settings ([kids](kids.md)).
- **Fast path.** "Quiz me on my cards", "again / good / easy", "how many cards are due" are typed actions for Jev.
- **Other modules.** translation's phrasebook feeds cards; memory-and-notes supplies material; briefing reads due counts.

## 13. Privacy and safety

- Progress and mistakes are personal: person-scoped, not spoken on a shared device to someone else ("How is Anna
  doing?" from another person → only on the parent's own device, for children per [kids](kids.md)).
- Hosted pronunciation sends voice recordings out; off by default and named in the admin page.
- Homework help for children follows the explain-first rule by default; a parent may turn on "answer after trying".
- Quizzes from documents send the text to the model provider, as any prompt does.

## 14. Foundations needed

- **Needed first:** [Module store](../module-investigation/shared-state-jobs-and-notifications.md) (cards, reviews),
  People and rooms (progress per person), [Tool context](../module-investigation/shared-state-jobs-and-notifications.md)
  (who is reviewing).
- **Later:** [Presentation](../module-investigation/presentation-and-device-capabilities.md) (`card`, `steps`,
  `chart`), [Connection](../module-investigation/module-definition-config-and-dependencies.md) (AnkiConnect, Azure),
  [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md) (due counts), assistant templates.
- **First version without them:** a Tutor assistant made by hand (prompt only) already does practice conversations
  and Socratic homework help today; flashcards need at least a JSON file per person.

## 15. Open questions

1. **Anki or own store?** Does the owner (or anyone in the house) already keep Anki decks worth reaching by voice?
2. **Which languages are being learned**, and is a 1–3 s slower Whisper recogniser acceptable for practice?
3. **Pronunciation scores**: is the honest "I understood X" enough, or is a hosted service (voice leaves the house)
   wanted?
4. **Homework mode default for children**: explain only, or explain then answer?
5. **Correction style default**: at the end (recommended) or inline?
6. **Disagreement with [fun-and-ambient §5](fun-and-ambient.md#5-integrate-or-build)**: it has the model host trivia
   with an API answer key. For quizzes from the owner's material there is no answer key; the source sentence stored
   with each question plays that role.
