# Dictation and transcription

Research write-up, 2026-11-18. Not an approved design. Outside facts carry inline links checked on this date. Claims
marked **[unverified]** or **[from memory]** were not confirmed in a primary source. Speed figures are estimates to
be measured with `TurnTrace` and the `bench` mode.

## 1. Summary

Speech as **text output**, not as a command:

- long-form dictation into a note, a document, or the focused window of a paired computer;
- voice memos kept with their audio;
- transcripts of a meeting or a conversation in the room, with speakers separated, summarised into minutes and
  action items that go to lists;
- live captions on the stage.

Everything runs on the speech models already in the repository, plus sherpa-onnx's speaker diarisation, which ships
in the same native addon. Recording other people is a consent question first and a technical one second, so the rules
in §13 shape the tools.

- **Boundary.** [memory-and-notes](memory-and-notes.md) owns short notes (≤ 4,000 characters, `note`) and the
  journal. This module hands a finished short dictation to memory's `note`. It keeps long documents, recordings and
  transcripts itself. [t3-code](t3-code.md) dictates prompts into its own threads. [assistant-controls](assistant-controls.md)
  owns "stop". The existing per-device `captions` setting (the user's interim words and the reply being spoken) stays
  as it is. Live captions of the *room* are new.
- **Priority: second wave** for dictation into notes and documents and for voice memos. **Later** for meetings and
  room captions, which need the consent design and a long-form audio path through the session.
- **Effort: M** for dictation, memos and typing into a paired computer. Meetings with diarisation, summaries and
  speaker naming add **L**. Room captions add S once long-form capture exists.

## 2. What others do

| Product | Behaviour | Copy | Avoid |
|---|---|---|---|
| T3 Code voice input ([docs](https://github.com/pingdotgg/t3code/blob/main/docs/user/voice-input.md), via [t3-code §2](t3-code.md#2-what-others-do)) | The transcript lands in a draft for review, and only sending it sends anything | Review before anything leaves the draft | — |
| Otter, Fireflies, Granola **[from memory]** | Meeting bots or local capture; speaker labels; summary with action items; Granola mixes your own notes with the transcript | Action items as a separate, checkable list | Bots that join calls and record people who never agreed |
| Google Recorder (Pixel), Apple Notes and Voice Memos transcription **[from memory]** | On-device transcription with speaker labels and search; the audio and the text kept together | Audio and text linked word by word; search across memos | — |
| Plaud, Limitless, Bee wearables **[from memory]** | Always-on or one-press recording of everything said around the wearer | — | **Always-on recording** of a household. This module never does that. |
| nerd-dictation, Talon, Handy **[from memory]** | Local dictation that types into the focused window (`xdotool`, `ydotool`) | Typing as the output path for a desktop | Voice coding grammars (the wrong level, as t3-code also notes) |
| Deepgram batch | `diarize=true` on `/listen` puts speaker labels in `results.utterances` ([docs](https://developers.deepgram.com/docs/diarization)). Whether Flux, the streaming model this repo uses, labels speakers is not confirmed in Deepgram's own documentation (only a third-party listing, [Inworld](https://docs.inworld.ai/stt/speaker-diarization.md)) | Optional hosted fallback for hard recordings | Assuming the existing Flux connection can do it |

## 3. Example conversations

| # | Exchange | Screen? |
|---|---|---|
| 1 | Study: "Hey Jev, take a note." → "Go ahead." → two minutes of speech with pauses, "new paragraph" and "scratch that" along the way → "End note." → "Saved: 'Ideas for the garden', 310 words. Want me to read the first line back?" | optional (live text) |
| 2 | "Dictate into my laptop." → "Typing into Ian's ThinkPad. Say 'stop typing' when you're done." Words appear in the focused editor clause by clause. "Stop typing." → "Done, 4 sentences." The Enter key is never pressed. | the laptop's own screen |
| 3 | "Record a voice memo for Sam." → "Recording." (red light) → … → "Done." → "Memo for Sam saved, 40 seconds. Shall I tell Sam it's there?" | no |
| 4 | Dining table: "Transcribe this meeting." → "I'll record and transcribe this conversation until someone says 'stop recording'. Everyone here can hear this." Captions run on the tablet. 50 minutes later: "Stop recording." → "Got 50 minutes. I'll have the summary in about five minutes." | yes |
| 5 | Later: "What were the action items from the meeting?" → "Three: Anna books the plumber, Ian sends the budget by Friday, and someone checks the gutter. Add them to the to-do list?" → "Yes, but not the gutter." | optional `list` |
| 6 | "Speaker two was Anna." → `transcript_name_speaker` → "Got it: Speaker 2 is Anna throughout." | yes |
| 7 | Captions for a guest who is hard of hearing: "Turn on live captions." → large captions of everything said in the room appear on the living-room screen, with nothing stored. "Turn off captions." | **yes** |
| 8 | Refusal: "Record what the kids say when I'm out." → "I only record when someone in the room asks and can hear that I'm recording. I can't record a room you're not in." | no |
| 9 | Ambiguous: "Write this down: …" → a note or a document? If a dictation target is open, the text is appended there. Otherwise it is a note, and the assistant says "Saved as a note." | no |
| 10 | Failure: the paired laptop is asleep → "Your laptop isn't connected. I'll keep this as a note; you can paste it later." | no |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency (estimate) | Fast path |
|---|---|---|---|---|---|---|
| `dictation_start` | `target: note \| document \| computer \| memo`, `title?`, `document?` (a doc name or id), `computer?` (a paired computer's name), `keepAudio?: boolean`, `language?` | `{ sessionId, target, device }`; the device enters long-form capture | W | changes data (computer: **outward-facing**, it types into another app) | < 200 ms | **yes** ("take a note", "start dictation", "dictate into my laptop") |
| `dictation_command` | `command: new_paragraph \| scratch_that \| undo \| read_back \| pause \| resume` | the updated draft tail | W | changes data | < 100 ms | **yes**; only while a dictation is open |
| `dictation_stop` | `save?: boolean` (default true), `discard?: boolean` | `{ id, words, seconds, savedTo }` | W | changes data | final decode of the last segment, < 1.5 s | **yes** ("end note", "stop typing") |
| `transcribe_start` | `kind: meeting \| conversation`, `title?`, `speakers?: 2–8`, `captions?: boolean`, `maxMinutes?: ≤ 180` | `{ recordingId }` plus the spoken announcement (§13) | W | **outward-facing** (records other people) | < 300 ms | **yes** ("transcribe this meeting") |
| `transcribe_stop` | `recordingId?` | `{ minutes, eta }`; processing starts as a Scheduler task | W | safe | < 200 ms | **yes** ("stop recording", said by anyone in the room) |
| `transcript_find` | `query?`, `kind?`, `from?`, `to?`, `who?` | matches with a time offset into the recording and the speaker | R | safe | < 50 ms (FTS5) | no |
| `transcript_summary` | `id`, `style: summary \| minutes \| action_items \| decisions` | text; action items as `{ text, owner?, due? }[]` | R | safe locally; hosted when the model is (the transcript text leaves the house) | model, 2–8 s for an hour of text **[estimate]** | no |
| `transcript_name_speaker` | `id`, `speaker: number`, `name` | the relabelled transcript | W | changes data | < 50 ms | no |
| `transcript_delete` | `id`, `what: audio \| all` | ok | W | changes data | < 50 ms | yes |
| `captions_room` | `on: boolean`, `device?` | the state | W | safe (nothing is stored) | < 200 ms | **yes** |

Action items go to lists only through `Lists.addItem`, after the spoken confirmation in example 5. That follows the
direct-call position in [investigation §11 row 17](../module-investigation/investigation.md#11-disagreements-between-documents).

## 5. Integrate or build

### 5.1 What the repository's speech models give us

From `packages/stt-sherpa/src/presets.ts`:

| Preset | What it is | Use here |
|---|---|---|
| `parakeet-v2` | Offline Parakeet TDT 0.6B, English, punctuated and capitalised **[from memory: punctuation]** | final text for English dictation |
| `parakeet-ultra` | Parakeet TDT 0.6B v3-based, English, Dutch and 23 more European languages, picks the language itself | **the default for this household**: final text for dictation and meetings |
| `whisper-turbo` | 99 languages, robust, slow | the fallback for poor audio or unusual languages; offline batch only |
| `nemotron-560` / `-320` | Streaming, live words, multilingual | live text during dictation and room captions |
| `hybrid-nemotron-parakeet` | Both in one worker | **the right shape for dictation**: live words from the streaming model, final text from Parakeet |

The constraint that matters: a Parakeet piece is decoded whole, and one piece is capped at 30 s, because "the
recogniser's memory grows with the longest" (`presets.ts:108`). Long-form audio is therefore cut by the VAD that
already ships with every preset (`download.ts:37`) into pieces of at most 25 s at pauses, each decoded on its own.
That is the same queue the turn pipeline uses, so no new model is needed. How fast an hour decodes on the server's CPU
is **[unmeasured]**. A `bench`-mode run on a recorded hour must be done before quoting "five minutes" (example 4).

### 5.2 Speaker separation

| Option | Facts | Verdict |
|---|---|---|
| **sherpa-onnx `OfflineSpeakerDiarization`** | In `sherpa-onnx-node`, already a dependency. It uses the pyannote segmentation 3.0 ONNX model, a 3D-Speaker ERes2Net embedding model and clustering. Set `numClusters` when the speaker count is known, or `-1` with a `threshold` (higher means fewer speakers). `process(samples)` returns `{ start, end, speaker }[]` at 16 kHz, offline only ([example](https://csukuangfj.github.io/sherpa/onnx/javascript-api/examples/speaker_diarization.html), [API](https://csukuangfj.github.io/sherpa/onnx/javascript-api/examples/api_speaker_diarization.html)) | **Recommended.** No new native dependency. Two small model downloads through the existing job system. Meetings only, after the recording. |
| pyannote `community-1` (pyannote.audio 4.0) | CC-BY-4.0 weights, gated on Hugging Face; pyannote's claim is that it clearly beats 3.1 ([pyannote](https://pyannote.ai/blog/community-1), [PyPI](https://pypi.org/project/pyannote.audio)). CPU speed is not published by pyannote. One competitor quotes a real-time factor of 0.86 on CPU **[unverified]** | Better quality, but Python and PyTorch on the server. Optional, through an owner-run container. |
| NVIDIA Streaming Sortformer 4spk | Streaming diarisation for up to four speakers; community ONNX exports exist ([HF](https://huggingface.co/soniqo/Sortformer-Diarization-4spk-ONNX)); NVIDIA says it is not robust to noise ([NeMo docs](https://docs.nvidia.com/nemo/labs-voice-agent/about/core-concepts/speech-pipeline/speaker-diarization)); no sherpa-onnx support found | The only route to *live* speaker colours in captions. Watch it; do not build on it now. |
| Deepgram batch `diarize=true` | Hosted; labels in `utterances` | Opt-in fallback; audio leaves the house |

Words get speakers by overlap: each Parakeet piece gets the diarisation speaker that covers most of its span. A piece
that spans a speaker change is split at the change, then decoded again. Sherpa-onnx's speaker embedding extractor could
also match a speaker cluster to enrolled household voices ("Speaker 2 sounds like Anna") **[from memory: API name]**.
Per [shared-state §4.6](../module-investigation/shared-state-jobs-and-notifications.md#46-identity-who-said-it), that is
a labelling hint the person confirms, never an identification.

### 5.3 Output targets

| Target | Mechanism | Notes |
|---|---|---|
| Note | memory-and-notes `note` for ≤ 4,000 characters; longer goes to this module's `documents` with a short note pointing at it | One place to find notes by voice |
| Document | Markdown file in a household folder (default), Google Docs `documents.batchUpdate` with `insertText` through the [google](google.md) Connection **[from memory: endpoint]**, or a Nextcloud/WebDAV file | Append-only; the module never rewrites the user's document |
| Focused window of a paired computer | A small **companion agent** on the computer, paired like a voice node (pairing code, node credential, `docs/VOICE-NODES.md` on its branch). It types with `wtype` (wlroots Wayland), `ydotool` (any Linux, needs `ydotoold` and `/dev/uinput`), `xdotool type` (X11), `SendInput` with `KEYEVENTF_UNICODE` (Windows) or `CGEventKeyboardSetUnicodeString` (macOS, needs the Accessibility permission) **[from memory: all]** | A browser page cannot type into other apps, so this needs a native agent. It types clause by clause after the final decode, never live words that may still change. It never sends Enter, Tab or shortcuts. |
| Memo | Audio file plus transcript, person-scoped | §6 |

### 5.4 Long-form capture in the session

The pipeline today is turn-based: the recogniser ends a turn at a pause, the route gate picks an assistant and a
conversation answers ([current-system §3.3, §4.3](../module-investigation/current-system.md#43-sessions-per-device-implemented)).
Dictation needs a **capture mode** on the voice session:

- While capture is on, recogniser events go to the module's sink instead of the dispatcher. Endpointing still cuts
  pieces, but no turn starts.
- Only a closed set of phrases is matched, without the model: "end note", "stop typing", "stop recording", "scratch
  that", "new paragraph", "pause". They are matched with and without the wake phrase, like the ringing window in
  [shared-state §8.4](../module-investigation/shared-state-jobs-and-notifications.md#84-acknowledging-and-snoozing-by-voice).
  Everything else is text.
- PCM frames (16 kHz mono, already arriving as binary frames) are written to disk when audio is kept. WAV is
  1.92 MB a minute, about 115 MB an hour. Opus at 24 kbit/s through `ffmpeg` (optional) is about 11 MB an hour.
- For a meeting, the device's `audio` settings switch noise suppression and AGC to the values chosen for far
  speakers while capture runs, and switch back afterwards **[to test: which values help Parakeet]**.

This is the one core change the module needs. It is also what [t3-code](t3-code.md) dictation would use for
prompts longer than one turn.

## 6. Data

| Collection | Scope | Shape | Kept (default) |
|---|---|---|---|
| `recordings` | person (the one who started it) | `{ id, kind: memo \| meeting \| dictation, title, deviceId, startedAt, seconds, audioPath?, announcedAt, participants?: string[] }` | audio **30 days**, then deleted; the row stays |
| `transcripts` | as the recording | `{ recordingId, segments: [{ start, end, speaker?, text }], language, model }` | until deleted |
| `transcripts_fts` | module SQL | FTS5 over segment text | — |
| `speaker_names` | per recording | `{ speaker: number, name, personId? }` | with the transcript |
| `summaries` | as the recording | `{ style, text, actionItems[], model, hosted: boolean }` | until deleted |
| `documents` | person or household | `{ id, title, target, path \| externalId, words }` | until deleted |
| `computers` | household | paired companion agents `{ id, name, owner, os, lastSeen }` | until removed |

All of it lives in the **Module store**, with audio files under `data/modules/dictation/` and included in backups only
when the owner opts in, because of their size. Other modules read summaries' action items through an export
(`transcripts.actionItems(id)`) and nothing else. Memory's `audioRef` should point here, not at `recordings/` (§15).

## 7. Long-running work and events

- **Post-processing** is a Scheduler `task` per recording: final decode of every piece, diarisation, alignment, FTS
  index, then the summary if asked for. The audio is on disk, so after a restart the task simply runs again from the
  start. It runs at `nice` priority and pauses while any voice turn is active, so live latency is not hurt **[to verify
  with `TurnTrace`]**.
- **Retention** is a daily job that deletes audio past its age and warns the owner a week before.
- **Events emitted:** `transcription.started` and `transcription.stopped` (with the device, for the indicator on every
  screen in the room), `transcript.ready`, `dictation.text` (live text to the device's screen).
- **Listens to:** `assistant-controls` "stop" (it pauses a dictation, it does not discard it), and presentation
  dismissals.

## 8. Presentation

- **Dictation.** A `text` presentation in the Companion layout, live words in muted ink turning solid when final. The
  character sits small at the corner in `listening`. "Read back" highlights the clause being spoken.
- **Recording.** A host-drawn red "Recording · 12:04" badge in Orbit layout on the device that records *and on every
  screen in the same room*. Like vision's camera indicator, no module can hide it.
- **Room captions.** The Ambient stage is replaced by two to four large lines of text (at least 40 px), newest at
  the bottom, with no speaker labels because streaming diarisation is not available. The character shrinks to a
  corner. The existing `Captions` component's style is kept: mint is "you" and amber is the assistant
  (`docs/UI-AND-MODULES.md:711`). Room speech gets a third, neutral ink.
- **Transcripts.** A `list` of segments with speaker names, tap to play that span (the audio is served from
  `/media/`). The summary is a `card` with action items as a `list` checklist.
- **Without a screen.** Everything works by voice. Read-back is spoken. The recording indicator on a node is its LED
  and a short tone every 10 minutes **[proposal]**.

## 9. Notifications and proactive behaviour

- `transcript.ready` → `normal` notification to the person who started it: "The meeting summary is ready." This is
  delivered on their device, or held in the inbox.
- Ten minutes before the maximum duration: "I'll stop recording in ten minutes" in the room.
- After 60 minutes, and every 30 minutes after that, a short "Still recording" in the room. That is the reminder that
  keeps everyone present aware.
- Audio about to be deleted: a `low` inbox item a week before.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | recording allowed at all; announcement text; maximum minutes; audio retention days; summaries may use a hosted model | yes; the §13 text; 120; 30; ask |
| Module | final-text preset (`parakeet-ultra`); live preset (`nemotron-560`); diarisation models; document folder; Opus via ffmpeg | as named; downloaded on first use; `data/documents/`; on if found |
| Assistant | may start recordings; may summarise | the general assistant yes |
| Device | recording allowed here; room captions allowed here; capture audio profile | shared rooms yes; yes; "far speakers" |
| Person | keep audio of my dictations and memos; my paired computers; default document target | off (memos on); —; note |

First-run setup: (1) download the two diarisation models from the admin (a new entry in the `stt-models` job tool);
(2) pick the retention period; (3) optionally pair a computer by running the companion agent with a pairing code; (4)
optionally connect Google or Nextcloud for documents.

## 11. Native tools and dependencies

| Need | Where | When missing, the assistant says |
|---|---|---|
| `sherpa-onnx-node` 2.0.1 and the presets (exists) | server | the STT stage error already shown today |
| pyannote segmentation 3.0 and 3D-Speaker embedding ONNX models (small; size **[unverified]**) | server, `models/` | "I can transcribe it, but I can't tell the speakers apart until the speaker models are downloaded." |
| Disk space: about 115 MB per hour of WAV | server | "There isn't enough space to record; I can do captions without saving." |
| `ffmpeg` (optional) | server | audio is kept as WAV |
| Companion agent and `wtype` / `ydotool` / `xdotool` | the paired computer | "Your laptop isn't connected…" (example 10) |
| A Google or Nextcloud Connection (optional) | vault | documents go to the local folder |

## 12. Interaction with the rest of the system

- **Voice.** Parakeet writes punctuation itself, so spoken punctuation ("comma", "full stop") is off by default and
  can be switched on per person. Names in dictation are fixed by the person after the fact ("Speaker 2 was Anna", or
  editing on the admin page). Numbers stay as the model wrote them.
- **Echo gate and barge-in.** During capture the assistant does not speak, except to announce, so the echo gate has
  nothing to remove. An announcement plays only between pieces.
- **Wake phrases.** During a meeting, "hey Jev, what's the time?" is *not* a turn: everything is transcript except the
  control phrases. People can still ask after "stop recording". This is deliberate, so the meeting is not
  interrupted. Whether a "pause recording, ask, resume" phrase is wanted is open (§15).
- **Character.** `listening` throughout. The proposed `turn.activity` would show "writing". Nothing reacts to what is
  said.
- **Assistants.** No new template is needed. A "Secretary" persona that summarises in the household's style is an
  optional template.
- **Other modules.** memory-and-notes (short notes), lists (action items), calendar (a decision with a date becomes a
  suggested event, never added unasked), google (Docs, Drive), notifications (ready), vision ("read this letter" then
  "save it as a note").

## 13. Privacy and safety

- **Consent is the design.** A recording starts only when a person in the room asks. It is announced aloud to the
  room: "I'm recording and transcribing this conversation. Say 'stop recording' at any time." It is shown on every
  screen in the room. Anyone may stop it by voice, and a stop is never refused.
- **Dutch law.** Recording a conversation you take part in falls outside art. 139a Sr. There is no requirement to ask
  or to announce. But someone who leaves recording equipment behind and is no longer a participant may commit the
  offence ([recordinglaw.com](https://www.recordinglaw.com/netherlands/recording-laws/recording-conversations/),
  secondary source, the 1985 Hoge Raad ruling not checked). Hence: no remote start ("record the kitchen" from
  another room is refused), a maximum duration, and the periodic "still recording". The AVG/GDPR applies alongside.
  The household exemption covers purely personal use **[from memory: art. 2(2)(c)]**, but a work meeting at home is
  not household use. Other countries (California's all-party rule, for example **[from memory]**) are stricter; the
  announcement satisfies the common cases. This is not legal advice.
- **Scope.** A recording belongs to the person who started it. Participants named as speakers can ask the owner to
  delete it, and `transcript_delete` is open to the owner and the starter.
- **Hosted processing.** Transcription and diarisation are local. A summary through a hosted model sends the
  transcript text out, so it follows the household setting (`ask` by default), and the summary records `hosted: true`.
- **Children.** Kids' devices cannot start meeting recordings. Memos are allowed.
- **Typing into a computer** is outward-facing: it can land in a chat window. The agent shows a small "PVA is typing"
  overlay on that computer **[proposal]** and never presses keys that send.
- **Prompt injection.** Transcribed speech is content. "Ignore your instructions" said in a meeting does not reach the
  summary as an instruction.

## 14. Foundations needed

- **Core capture mode** on the voice session (§5.4). This is the real prerequisite.
- **Module store** (rows, FTS5), **Scheduler** (post-processing, retention), **Tool context** (device, person),
  **Device capabilities** (room, to find "every screen in the room"), **Presentation** (`text`, `list`, `card`, the
  recording badge), **Notification service** (ready), **Requirements and health** (models, disk), **Connection**
  (Google, Nextcloud, the paired computer).
- **A first version without most of them:** "take a note" in capture mode with the hybrid preset, saved through
  memory's `note`, plus memos as WAV files with a JSON index. No diarisation, no computer, no summaries.

## 15. Open questions

1. **Meetings at all?** Are there in-person meetings or family discussions worth transcribing, or only dictation and
   memos?
2. **Wake phrases during a recording:** fully ignored (proposed), or a "pause, ask, resume" phrase?
3. **Retention:** 30 days of audio and transcripts until deleted, or shorter for meetings with guests?
4. **Hosted summaries:** allowed for meeting transcripts, or must summaries use the home model?
5. **Paired computers:** which OS and desktop (Wayland compositor?) decides `wtype` versus `ydotool` for the first
   agent.
6. **Voice enrolment** to suggest speaker names: wanted, given that voice is a hint and not identity?
7. **Disagreement with [memory-and-notes §6](memory-and-notes.md#6-data).** Its `audioRef` points at the opt-in
   `recordings/` folder ("save what the assistant hears", a debugging aid). Voice-note audio should live in this
   module's `recordings`, with its own retention and consent.
8. **Disagreement with [memory-and-notes Q6](memory-and-notes.md#15-open-questions).** "Keep the audio of voice
   notes" should be answered once, here, as a per-person setting, rather than twice.
