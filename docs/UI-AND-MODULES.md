# Web UI, modules and the browser protocol

Design for the next stage: a browser UI that is also the microphone and speaker, a module system that can be changed while the assistant runs, and the protocol between them. Written 2026-11-13. `docs/ARCHITECTURE.md` remains the contract for everything that already exists; this document adds to it.

## Changes since the design

Recorded by the server implementation (2026-11-13). **`PROTOCOL_VERSION` is still 1.** One message gained an optional field since (`playback.stopped.exact`, 2026-11-14, last row; no bump under §2.8); otherwise no message shape changed. These are behaviour details a client may notice:

| What | Why |
|---|---|
| **Playback reports from a tab that is not the owner are never answered with an error** (no `not_owner`). They are used only from the tab the reply was playing to (after a takeover, the previous owner's answer to its `reply.stop`); from any other tab they are ignored. Other owner-only messages (`mic.state`, `audio.release`, `audio.config`) from an observer still get one `not_owner` error per connection. | After a takeover the previous owner answers the `reply.stop` it was sent with `playback.stopped`; an error for that would be noise in the UI. (Second review, 2026-11-14: that count used to be ignored, so history could miss a clause that had been heard.) |
| **Takeover order**: the previous owner receives `reply.stop`, then `session {observer, taken_over}`. No more reply audio goes to it, but the reply ends only after its `playback.stopped` (at most 300 ms, as for an interruption), and that count goes to history. The interrupted turn's `turn.end` (outcome `interrupted` or `failed`) may reach the new owner before or after its own `session {owner, claimed}`. | The turn ends on its own fiber. |
| **State order**: on a promoted speculative turn the order is `turn.start`, `state thinking`, then the turn's buffered `assistant.text` messages. When playback starts: `state speaking`, then `assistant.playing {clause: 0}` straight away (not at the next progress report). After `playback.finished` **or `playback.stopped`** the state stays `speaking` until `turn.end`, then `listening` (or `hearing` after a barge-in); after a failed playback it drops to `thinking` at once. | Matches §2.5 and avoids a flicker to `thinking` for the few ms between the end of playback and the end of the turn (the `stopped` case was added during integration, where the real page showed `speaking → thinking → listening` on Stop). |
| `error` with code `mic_gap` is sent to the owner only, not to every tab. | Only the owner can do anything about it. |
| The WebSocket origin check accepts an upgrade with **no** `Origin` header. | Browsers always send `Origin`, so other web pages are still refused (HTTP 403); scripts and the scripted test client send none. |
| `ModuleInfo.status` is present only while the module is `running`. | A stopped module has no live status. |
| `DEFAULT_VOICE` (voices section) offers every declared voice. Choosing one that is enabled in the running engines applies from the next reply; choosing one that is not sets `engine.reloadPending` and applies after **Reload engines**. | The engines cannot start a voice live; the field stays one control. |
| The playback stall timer (2 s, `playback_timeout`) runs only while the server is waiting for the browser: after `reply.end`, or after the browser reported `playback.stopped` on its own (Stop pressed) and before the interruption arrives. | While audio is still being sent the browser may not have started yet. |
| `text.send` is answered `engine_failed` whenever the engine state is not `ready` (also while `starting` or `reloading`). It is answered after the engine took the input: at most 4 typed messages may wait for the conversation; more are answered `busy`. **Stop** (`interrupt`, or a takeover) drops typed messages still waiting, and repeated presses count as one. (Second review, 2026-11-14.) | There is no conversation to take the turn. Typed input used to be acknowledged and queued without limit while a turn's interruption waited for the browser, and then ran as stale turns. |
| Static files: `/x` serves `x`, `x.html` or `x/index.html`; an unknown path serves the export's `404.html` (status 404) when it has one. | Next's static export writes `x.html` and `404.html`. |
| **Host check** (`SERVE_ALLOWED_HOSTS`, §2.1): requests whose `Host` is a name other than `localhost`, a host of `SERVE_ALLOWED_ORIGINS` or a listed name get HTTP 403. IP addresses always work. (Review fixes, 2026-11-14.) | Without it a page on a rebound DNS name could open the socket in the plain-HTTP loopback setup (with HTTPS the certificate does not match the attacker's name, so the browser refuses first). |
| **Request limits**: at most 4 `module.*` / `settings.update` / `engine.reload` requests per connection, 16 in all, may be in progress; more are answered `result {ok:false, error:{code:"busy"}}`. A request that dies is answered `internal`. | One tab sending changes faster than they can be saved queued unbounded work and disk writes. |
| A connection refused at the limit (`4429`) is cut 1 s after its close frame if the peer has not answered it. Since the second review (2026-11-14) this holds for **every** WebSocket close (no hello, too slow, shutdown, or a close the peer started), and a refused upgrade (403 Host/Origin, 404 path) is cut as soon as its answer is written, at most 1 s later. At most 128 TCP connections are open at once (more are dropped on arrival); an HTTP request must send its headers within 10 s and complete within 30 s. | It used to wait for the peer up to 30 s; a refused upgrade whose peer kept its side open held its socket for ever (not counted by the hub, not reached by the heartbeat), and those sockets also blocked shutdown. |
| A reply whose audio fails upstream (synthesis error) is stopped like an interrupted one: `reply.stop`, up to 300 ms for `playback.stopped`, and that count goes to history; the turn is still `failed`. | The browser kept playing buffered audio after the turn had ended. |
| A failed settings save changes nothing (memory and files); a retry writes every file that differs from what is on disk. A save that changes both files first writes `data/transaction.json` (0600: it holds secrets) with the state before and after; a restart that finds it keeps the new state if both files hold it, and otherwise restores the state before. Temporary files are created fresh with their final mode. (Second review, 2026-11-14.) | A failed save used to leave the new values live, and the retry of a secret could skip writing `secrets.json`. If the settings write and the rollback of `secrets.json` both failed, a restart loaded the new secrets with the old settings. |
| The browser's microphone queue on the server holds at most 150 frames **and** 3 s of audio (96 000 bytes); the oldest are dropped beyond that, and a single frame larger than 96 000 bytes keeps only its newest 96 000 bytes (third review, 2026-11-14: such a frame used to be admitted whole, ~8 s). | Frames of any even length are accepted (up to 256 KiB), so the frame count alone allowed ~37 MiB and minutes of backlog. |
| Local speech recognition (`stt-sherpa`): a recogniser that does not shut down within 15 s (a native decode that does not end) is left running and logged; while it runs, no new local recogniser is loaded (the engine build fails with a message saying so), so at most one is ever left behind. A streaming recogniser asked to finalise a turn through a frame it has already passed (input that arrived in a burst, or a worker behind) cuts the segment at that frame and starts the next segment from the frames after it. Since the third review (2026-11-14) this holds for segments of any length: a segment is checkpointed at a 200 ms pause once it is 5 s long (at 8 s regardless), and a cut re-decodes only the piece it falls in (worst case measured 0.3–1.3 s of worker time, was 1.2–5.1 s); frames are kept for the last 30 s, and a boundary in audio no longer kept is logged as a warning, never applied silently. While a reload is refused because a recogniser is still left behind, the running engines are kept (the reload's preflight checks it); when the build fails because the old recogniser of this reload did not shut down, the engine builds again by itself once it has (the status says so). | Each reload could leave another model (up to ~1 GB) behind. The streaming worker used to finalise everything it had been fed, putting the start of the next sentence into the previous turn, and after 30 s it finalised the whole segment. After a reload that found the old recogniser stuck, the assistant had no engines until a restart. |
| Local voices (`tts-sherpa`): the pause between two clauses is reported as the end of the clause before it, not the start of the next one. | Interrupting during the pause put the whole next clause into history. |
| **One writer per data directory** (third review, 2026-11-14; **mechanism replaced in the fourth review**): `serve` takes the lock before it reads or recovers the settings and keeps it until it stops; a second server on the same directory exits with a message naming the first (process id, host, start) and what to do. The command-line modes only read and never take it. **Fourth review:** the lock is an advisory `flock(2)` on `data/writer.lock`, taken atomically by the kernel (`LOCK_EX\|LOCK_NB`, through the util-linux `flock` program on the server's own close-on-exec descriptor) and released by the kernel when the server exits or dies, SIGKILL included; the file is created once and never removed or replaced, and there is no stale-lock judgement and no takeover. `data/writer.holder` (pid, host, kernel boot id, start) is written by the holder after it has the lock, for messages only; a dead holder's file is overwritten. A holder file from another machine (other host name and other kernel) stops the start until it is deleted (a file system that does not pass locks between machines could hide that machine's lock). Without the `flock` program the start fails, saying so (no weaker fallback). If `writer.lock` is deleted while held, the holder stops writing. | A second server held its own copy of the settings and could save it over the first one's changes (bringing back a removed key), and could "recover" a save the first was still making. The third review's lock file (link, judge stale by pid and start time, rename aside) let 2–3 processes hold it at once in 19 of 30 runs of "holder killed, 7 start together"; the `flock` lock had exactly one winner in 50 + 30 such rounds [`dataDirLock.test.ts`]. |
| **Read-only loads see one save** (fourth review, 2026-11-14): every save writes both `settings.json` and `secrets.json` (journalled), each with the save's `revision` (a new number per save; files from before have none). A read-only load (the CLI modes, no lock, no writes) reads journal, settings, secrets, journal; it reads again when the journal appeared, disappeared or changed, or when (with no journal) the two revisions differ; with the same journal both times it takes the state the journal says is committed. At most 20 attempts (~1 s); then it fails ("come from two different saves" if the files stayed so, else "kept changing"), never returning a mix. A save that changes nothing writes nothing. | A reader that found no journal read the old settings, a whole save then completed, and it read the new secrets: old settings with new keys, no warning. |
| **Settings that may come from two saves start nothing** (fourth review, 2026-11-14): when the journal is damaged and the revisions do not prove the two files are one save (or a set-aside journal is still there and nothing was saved since, or the two files carry different revisions), the server starts with the engines **not built and no module started**. Every page sees why where it already looks for engine trouble: the engine status is `failed` with one problem, stage `settings`, saying the settings and keys may come from two saves and what to do; the web app shows it in the bar at the top of the page ("The assistant can't listen right now: settings: …", with Open options) and in Options → Assistant. "Try again" (`engine.reload`) is answered `engine_failed` with the same text. The next successful save (any section or module, even unchanged) clears it and starts the engines and the enabled modules. No message shape changed. | The startup log was the only place the warning appeared; modules and engines ran on a possibly mixed configuration. |
| **Local recognition closes every utterance** (fourth review, 2026-11-14, `stt-sherpa`): every utterance that got `SpeechStarted` ends with one `EndOfTurn`, whose `text` is empty when no words were recognised (noise, a turn dropped because decoding fell behind, input that ended first); noise too short for `SpeechStarted` produces nothing, and `EagerEndOfTurn` is never empty. A whole-turn finalise that was already queued when its turn was dropped (a stalled decode) is answered at once with no text, and the stalled decode's text is not added to the dropped turn afterwards. | An utterance without words ended with no event, so the conversation could not tell it was over; and the queued finalise was removed unanswered, so the turn detector waited for ever: later utterances never finished and a finite input never ended. |
| **Streaming checkpoints keep the words at the cut** (fourth review, 2026-11-14, `stt-sherpa`): the 8 s checkpoint forced in the middle of speech starts the next stream 2 s before the cut and joins the two texts where their words match; checkpoints at a 200 ms pause are unchanged. Measured with the four streaming models (`scripts/checkpoint-quality.ts`, 428 words): word error rate with the overlap equal to decoding the whole segment for both Nemotrons and within ±0.25 points for Zipformer and FastConformer; the plain cut cost +0.24 to +1.64 points. Cost: 2 s decoded twice per forced cut; a boundary cut still replays at most one 8 s piece. | The plain cut split or dropped the word it fell in. |
| **Recordings stop with the server** (fourth review, 2026-11-14): "what the assistant hears" is closed before the data-directory lock is released: no new recording, a save not yet begun never begins, a save in progress stops before its next file operation; shutdown waits for the operation already running at most 5 s. Each write and each removal by rotation is also skipped once the lock is no longer held. | A recording blocked on the disk at shutdown could resume after another server took the directory and rotate away recordings that server meant to keep. |
| Settings journal (third review): a journal from a newer version stops the start (with what to do); a damaged one, or one whose contents are not valid settings files, is set aside (`transaction.json.corrupt-<time>`, 0600) and never written back, and the startup log says the settings and keys may come from two saves (fourth review: unless their revisions prove they are one save; otherwise nothing starts, see above). A recovery whose write fails stops the start, says to check that the directory is writable and has space, and keeps the journal. Leftovers that may hold keys are made 0600 and counted in a startup warning; temporary files are removed at startup, set-aside journals after the next successful save. | A damaged journal used to be set aside silently; one with invalid contents could be written back over the files; a failing recovery gave a bare I/O error. |
| A typed message taken by the conversation just before **Stop** still starts its turn, which is stopped at once: its user message stays in history with no reply (as for any turn stopped before its reply), and the next request carries it before the next message (the language-model adapters merge consecutive user messages). | The owner did send it; dropping it would hide that. (Front end, not changed here: `historyToTurns` in `apps/web/src/lib/state.ts` leaves such an item without an outcome; it should show as stopped.) |
| HTTPS: a TLS handshake must complete within 10 s (Node's default is 120 s). Static files: a download the client abandons closes its file at once. | Each pending handshake holds one of the 128 connection slots; an abandoned download left its file stream paused and its descriptor open for good. |
| **The page's final count** (third review, 2026-11-14; fourth review, 2026-11-14): the player worklet publishes its live count after every render quantum: in shared memory where the page is cross-origin isolated (switches on by itself once the server sends COOP `same-origin` and COEP `require-corp`; nothing in the page loads from another origin), else as a small `count` message per quantum while audio plays. A stop the worklet has not answered after **50 ms** (`STOP_ANSWER_MS`, was 200 ms: it leaves 250 ms of the server's 300 ms for the round trip and the page's scheduling) is answered with the page's best count; if the worklet's exact count comes later and differs, the page sends a **second `playback.stopped` for the same turn** (since 2026-11-14 the first says `exact: false` and the server waits for the second, last row). **On the message route the best count is a lower bound**: a browser gives no way to read a worklet's queued messages synchronously, so on `pagehide` (and when a stop's wait runs out) the page reports the last count it read, which is short by the count messages still in flight (never above what played; since the final review the context's clock is not used: "After the final review" row). A stop asked for while rendering is finished at once when the context stops rendering, so its fade never plays after the page answered. Whether a final is exact is sent as `playback.stopped.exact` (`client.ts`, `playbackReport`; last row). On End and on a fatal microphone error the page sends `playback.stopped` (when a reply plays) **before** `audio.release`, and the release is skipped when a newer Start or a takeover came meanwhile (fourth review: it used to release the newer session); on takeover it answers the `reply.stop` before closing its audio (capture is released at once); on `pagehide` it sends `playback.stopped` with its best count. | Front end (`apps/web`, `playback.ts`, `client.ts`) | The count is the server's only source for what was heard; it used to be lost when a takeover closed the player during the fade, a suspended stop could report 0 after 200 ms of audio, and a page whose main thread was busy at `pagehide` reported a count ten quanta old (8 320 of 9 598 samples). |
| **Provisional final counts and cross-origin isolation** (2026-11-14). `playback.stopped` has an optional `exact` (absent = exact). The page sends `exact: false` on its best count (the worklet did not answer within `STOP_ANSWER_MS`, or `pagehide`) and `exact: true` on the worklet's own count, which follows as a second `playback.stopped` when it differs. The server keeps a first `exact: false` count as provisional and waits, within the same 300 ms that started when it asked the browser to stop (not extended), for one exact report from the same link and reply; that count is final (lower or higher). If none comes, the provisional count is final, never the older progress count; also when the reply ends otherwise first (the socket closes after `pagehide`, a stall). A second provisional count is ignored; an exact first report ends the wait at once, as before. When the page's best count already equals the worklet's (it included the fade), no second message goes and the server commits the provisional count at the deadline. Static responses (page, scripts, worklets, 404 and "UI not built" pages, 405) carry `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` unless `SERVE_CROSS_ORIGIN_ISOLATION=false`; with them the page is `crossOriginIsolated` and its player shares its count in memory. | `packages/protocol`, `packages/audio-web` (`WebAudio.ts`), `apps/web` (`client.ts`), `apps/assistant` (`http.ts`) | The page sometimes had to answer before it knew the exact count, and the server took that first answer; on page close the message route could be stale. The isolation switch exists because the iPhone is the real target and Safari's shared memory inside an AudioWorklet has not been checked. |
| **The shared counter is confirmed, else messages** (fifth review, 2026-11-14). The player worklet says at construction whether it received a shared counter (`ready`) and keeps sending `count` messages until the page has seen the counter hold at least what a message said for the reply it plays; then the page tells it (`route`, `shared: true`) and the messages stop. Every failure ends on the message route, working: a node that cannot be built with the buffer (`DataCloneError` or any other throw) is built again without it; a processor that fails with it (`processorerror`) is replaced by one without it (the old one's open reply is answered with its best count); a worklet that reports no buffer, sends no `ready` within 1 s, or whose counter falls behind its own count messages (8 in a row) or behind a progress report is told `route`, `shared: false`, and sends messages again. An unconfirmed counter is still read for the best count (it can only raise it); a failed one is not. Options → This device → Audio diagnostics shows one line, *Playback count*: the route and why (also in Copy report). The worklet URL is `?v=4`. The echo test is the client's (`client.echoTest`): End, a takeover, a failure, a new Start, or a change of output path cancels it (it plays nothing more, saves nothing, says it was interrupted), and only the test that runs owns the microphone gate and the local playback listener. | Front end (`apps/web`: `worklets/player.js`, `playback.ts`, `VoiceAudio.ts`, `client.ts`, `echoTest.ts`) | Every isolated page took the shared route, which has not been checked on iOS Safari; a failure there used to disable audio (a throw) or report a count of zero (a counter nobody wrote). The old echo test could play its chirp through a session started after End. |
| **The data-directory lock waits for writes in flight** (fifth review, 2026-11-14, `apps/assistant`: `DataDirLock.ts`, `SettingsStore.ts`, `HeardAudio.ts`): every operation that can write into the data directory registers with the lock before its first file operation and ends its registration when its last one has settled, however it ends (also when the fiber that started it was interrupted and its promise ran on): settings and secrets saves with their journal, temporary files and the removal of set-aside journals; the startup's clean-up (temporary files, a damaged journal or a corrupt file set aside) and recovery; recordings and their rotation. The release first refuses new operations, then waits for the registered ones, at most 10 s, and only then releases the lock. If they have not settled by then, shutdown goes on without releasing it: the log names the operations still running, and the lock is released when the last of them settles, or by the kernel when the process exits. An interrupted startup stops before its next file operation (the journal is removed last, so the next start resolves it again). `writer.holder` is written and removed synchronously by the acquire and the release. | An interrupted start released the lock while its recovery kept writing: a second server could take the directory and the old recovery then replaced `secrets.json` and removed `transaction.json` under it. The recorder's 5 s wait let an operation still running finish after the release [`releaseGate.test.ts`]. |
| **Unblocking starts every enabled module** (fifth review, 2026-11-14, `serveMode.ts`): after the save that clears "settings may come from two saves", the server starts every module that is enabled and not running once the host is idle for it: a module still busy with the save's own operation (`module.configure` of that module, settings or a key) is started when that operation has finished (`busy` is retried every 25 ms, for at most 30 s, then logged), and any other failure is logged. The engines' start is retried on `busy` the same way. At startup, a module that `startEnabled` skipped because another operation held it is started the same way afterwards. | Saving a module's settings to unblock started the engines but left that module `{enabled: true, state: "disabled"}`: the unblocking ran inside the save, the module's own operation still held it, and the `busy` answer was dropped [`serve.test.ts`, "unblocking through every kind of save"]. |
| **Playback counts are bounded by the audio sent** (fifth review, 2026-11-14, `packages/audio-web`): the server counts the samples it sent to the link a reply plays to (at the rate announced in `reply.start`, the page's unit; the voice router resamples every voice to that rate). Every count in `playback.progress`, `playback.finished` and `playback.stopped` (provisional or exact) is rounded down and clamped to it; a negative or non-finite count is ignored; a progress count lower than the last one is ignored (not applied); `playback.started` before any audio was sent is ignored. A provisional count is still replaced by an exact one, lower or higher, within that bound. Reports that fail these checks are logged (rate-limited: at most one line per 10 s, with the number since the last). Once a chunk of a reply was not sent (another tab took the audio), nothing more of that reply is sent, so the audio sent is always a prefix of what the conversation pulled and a count up to it never reaches a clause that was not sent. | A page reporting more than it was sent (100 samples sent, 1 000 000 reported) put clauses into history that were never transmitted, including audio pulled after a takeover but not sent. |
| **Streaming joins without matching words, and interim text** (fifth review, 2026-11-14, `stt-sherpa`): where the two streams of a forced checkpoint heard the 2 s overlap differently (no words match), the second piece's words that began in the overlap are dropped (by the model's token times, or by the overlap's share of the piece's audio where it gives none) instead of being repeated. The interim text never shrinks within an utterance: a partial with fewer words than the one shown (a later partial that establishes a match, or a revision) is held back until the text has grown past it; the turn's final text is not affected. (Narrowed in the sixth review to the first 640 ms after a join, two rows down.) | An unmatched join concatenated the texts, repeating the overlap's words (worse than a plain cut), and the interim text could shrink when a later partial found the match [`recognizerCore.test.ts`]. |
| **The final count decides what was heard, also downwards** (sixth review, 2026-11-14, `packages/audio-web`, `PlaybackObserver.final` in `packages/core`): `progress` stays non-decreasing, and when a reply ends (finished, stopped, provisional count made final, takeover, upstream failure, stall, owner lost) `WebAudio` calls the observer's optional `final(count)` once with the count it committed (validated, clamped to the audio sent), which may be lower than an earlier progress; the conversation then decides the heard clauses from it. A `playback.finished` that arrives before the server sent `reply.end` is ignored and logged (rate-limited): the page only finishes after `reply.end`, so it comes from a faulty page or an underrun taken for the end, and the reply stays open for the audio still to come (`sent` is set before `reply.end` goes out, so a finish however soon after it is accepted). | With 100 samples sent, progress 80 then an exact stop at 60 left history holding a clause that began between 60 and 80; and a premature `finished` closed the reply's accounting, so audio produced after it was never counted [`WebAudio.test.ts`, "sixth review"]. |
| **Interim text: shorter corrections are no longer held back, except just after a join** (sixth review, 2026-11-14, `stt-sherpa`; replaces the fifth review's "never shrinks"): the recogniser's partials are posted as they are, revisions to fewer words included. Only for the first `joinHoldMs` (640 ms) of audio after a forced checkpoint, while the overlapped piece's words settle, is a text with fewer words than the last partial held back; after that the current text is posted whatever its length. 640 ms is two 320 ms decode chunks of the streaming Zipformer, enough for the overlap (fed at once at the cut) to settle, and it bounds how long a correction can be withheld from "confirm" mode. Whole-turn recognisers (interim re-decodes, the hybrid's live stream) never had the rule and post revisions unchanged. | An eight-word first guess revised to "please stop now" showed only the guess until the end of the utterance; if the guess matched the assistant's speech, "confirm" rejected it as echo and never saw the correction [`recognizerCore.test.ts`, "sixth review"]. |
| **Unblock and reload overlapping** (sixth review, checked, no change, `serveMode.ts`): the engine start after an unblock cannot rebuild an engine a reload has just brought up. The unblock's first `start` takes the engine guard synchronously inside the save, and a reload while the settings are still blocked releases it synchronously, so the `busy` retry does not run in these interleavings: a reload sent during the unblock's build is answered `busy`, and a reload sent with the unblocking save never causes a second build (5 rounds; 30 more with the scheduler yielding after every operation, not kept as a test). | The sixth review suspected a second rebuild [`serve.test.ts`, "sixth review"]. |
| **Only the player that rendered a reply answers for it; real replies win over the echo test** (sixth review, 2026-11-14, `apps/web`: `playback.ts`, `VoiceAudio.ts`, `client.ts`, `echoTest.ts`). When the shared-counter player fails (`processorerror`) and is replaced, the replies it knew stay with the page's record of them: one that was playing is answered at once with the failed player's best count, `exact: false`, and its remaining audio is dropped (not played by the new player); the server's `reply.stop` or `reply.end` for it is answered from that record, again provisional (exact only if the old player had answered exactly), and never passed to the new player. A player's answer for a reply its link has no record of (a fresh worklet answers a stop for an unknown id with 0) is never sent. So the server keeps the provisional count and commits it at the end of its stop wait, or, if it never stops the reply, when its 2 s stall watchdog does (`playback_timeout`); the owner hears the reply stop where the player failed. The echo test is cancelled when a real reply starts, in any phase (before its chirp, so the chirp never plays, or during it, which the reply replaces); it cannot be started while a reply plays; a result is saved only when the chirp finished and the measurement window completed. The played-count oracle (`test/worklets/playedOracle.test.ts`) now replays every reply through the real server (`makeWebAudio` with `TestClock`, `test/serverRule.ts`) instead of a hand-copied rule. Also (`agent-claude-code`): an inherited proxy URL with credentials is no longer passed to Claude Code; the start fails saying so, and such a proxy is supplied with the agent's secret setting **Proxy for Claude Code**; locale and XDG variables are passed by their standard names only. | A replacement player used to answer the server's stop for its predecessor's reply with an exact 0, which the server took over the count that had played. A real reply could stop the chirp, and the stopped chirp was saved as a passing test. |
| **A count never above what rendered; every player's failure handled, three in a minute end audio; reply instance tokens** (seventh review, 2026-11-14, `apps/web`: `playback.ts`, `VoiceAudio.ts`, `lifecycle.ts`, `worklets/player.js` `?v=5`). Every count the page reports is what the worklet published (its final, else its highest reported or shared-counter count); this review still added the context's clock at the stop deadline and on unload under conditions, which the final review removed ("After the final review" row). A failed player (`processorerror`) answers with what it published, `exact: false`, with no clock and no assumed fade, and an exact count it already gave is kept. Every player has the failure handler, a replacement and one without shared memory too: it is replaced at most twice within 60 s, and the next failure in that window ends audio as a fatal error ("The speaker stopped working…"): the open reply's count goes out, the audio is given back (`audio.release`), the context closes, and the owner presses Start. Every page↔worklet message about a reply carries an instance token the page makes at `reply.start`, and the shared counter holds it next to the reply id: an older instance's queued `finished`/`stopped`/counts, or its counter value, are dropped when an id repeats (turn ids restart at 1 when the server restarts; the echo test reuses one id). No protocol change. Also (`agent-claude-code`): every error, cause and status line is redacted with the **Proxy for Claude Code** value and its user-info, user name and password (`src/redact.ts`, the shared copy). | After a processor failure the page counted, from the clock, audio that the dead player never rendered (8,640 committed where 3,840 played). A replacement player that failed again was never replaced, so later replies went to a dead node. An old reply's late `finished` could close a new reply with the same id. A proxy URL in an SDK error outside its stderr tail was shown as it was. |
| **After the final review** (2026-11-14, `apps/web`: `playback.ts`, `VoiceAudio.ts`; `agent-claude-code`: `agent.ts`). (1) **No extrapolation**: every provisional count (stop deadline, page unload, a failed player's retirement) is the count the worklet published and nothing else; the context's clock is never added. On the message route a count can be short by the count messages still in flight (one per render quantum while audio plays): the accepted cost. (2) A failed player whose replacement cannot be built, connected or wired takes the fatal path ("The speaker stopped working… could not be restarted. Press Start…"). (3) A capture processor that fails (`processorerror` on the capture node) takes the fatal path ("The microphone stopped working… Press Start…"); no automatic recovery. (4) A tool's error result (`isError`) is redacted with the proxy secret before it reaches the Claude Agent SDK or the `ToolFinished` event; successful results are untouched. | (1) The page cannot know in time that the player rendered what the clock says: a processor that died while the context runs on for the microphone reported 8,640 where 3,840 rendered, and a clock that advanced after a suspension without rendering did the same. (2) The exception escaped the event handler and the page stayed "running" with no player. (3) Capture stopped producing frames while the page showed it was listening. (4) A failing tool's error text carried the proxy URL and password unredacted. |
| Not done: the `llm-anthropic` **[verify]** item of §4.3 (tool history when no tools are enabled). | Outside the server packages, and it cannot be confirmed without an API key. Until it is checked, disabling every tool-providing module after a tool was used may make Anthropic reject the next request. |

**What can make the server hold resources, and what bounds it** (third review, 2026-11-14). A client is anyone who can reach the port (no login); a stalled dependency is a native call, child process, tool, disk or browser that stops answering. Each bound has a test that fails without it (named in brackets).

| Who | Resource that could grow | Bound now |
|---|---|---|
| Client | TCP connections (HTTP, WebSocket, refused, closing) | 128 open at once, more dropped on arrival; headers within 10 s, request within 30 s; every close cut after 1 s [`http.test.ts` socket limits, refused upgrades] |
| Client | TLS handshakes (with `SERVE_TLS_CERT`) | 10 s each, inside the 128 [`http: TLS handshakes`] |
| Client | Static-file descriptors | One per download in progress, closed when the client goes away (`pipeline`), so at most one per open connection [`http: static downloads never hold a file`] |
| Client | Hub connections, per-connection send buffer | 8 tabs; send buffer bounded, slow tab dropped (§2.1) |
| Client | Requests in progress (`module.*`, `settings.update`, `engine.reload`) | 4 per connection, 16 in all, more answered `busy` |
| Client | Typed messages waiting for the conversation | 4, more answered `busy`; Stop drops them |
| Client | Microphone queue | 150 frames and 96 000 bytes (3 s); an oversized frame keeps its newest 96 000 bytes [`WebAudio.test.ts` bounds] |
| Client | Settings writes | Serialised; bounded by the request limit above |
| Stalled browser | Reply audio waiting for playback reports | 2 s without a report while waiting: the reply is stopped (`playback_timeout`); 300 ms for `playback.stopped` after an interruption |
| Stalled native decode (whole-turn) | Queued decode audio in the worker | The running decode's audio plus at most two longest pieces (2 × 35 s, ~4.5 MB) waiting; past that the turn is dropped (no text), logged once, and nothing more of it is queued; queued decodes of an ended turn or session never reach the decoder [`recognizerCore.test.ts`] |
| Stalled native decode (whole-turn) | Pending `finalize` answers | One per detector (it waits for each); a dropped turn is answered at once without decoding, **also a finalise already queued when the turn is dropped** (fourth review: it used to be removed unanswered, and the detector waited for ever) [`recognizerCore.test.ts`, `SherpaSttFake.test.ts`] |
| Stalled native decode (streaming) | Retained segment frames | 30 s of frames; checkpoints at 5 s (pause) / 8 s (with 2 s overlap) [`recognizerCore.test.ts`] |
| Stalled native decode | Worker thread and its model at shutdown/reload | One left behind at most (15 s wait); no second model loads beside it; preflight refuses a reload meanwhile; auto-rebuild when it goes [`SherpaSttFake.test.ts`, `engine.test.ts`] |
| Worker behind | Audio posted to the worker | 1 s of unprocessed audio, then dropped and logged (`maxBacklogMs`) |
| Stalled synthesis (`tts-sherpa`) | Child process, its queued clauses | A clause has 5 s + 40 ms per character, then the child is killed and restarted and the turn's clauses fail; model load 60 s; stderr kept to 2 000 characters |
| Stalled player (`audio-pipewire`, CLI `voice` mode) | Reply and turn held by a player that stops reading or never exits | 10 s per write and after the end of input, then the player is killed and playback fails; what is written ahead is bounded by the pipe (~200 KiB) [`PipeWire.test.ts`] |
| Stalled consumer (`audio-pipewire` capture) | Captured frames | 150 frames (3 s), oldest dropped [`PipeWire.test.ts`] |
| Blocking disk | "What the assistant hears" recordings | Written asynchronously, one at a time; a recording finishing while one is still being written is skipped and counted; each recording at most 30 s; at shutdown at most 5 s of waiting; an operation still running then keeps the lock held until it settles (fifth review) [`heardAudio.test.ts`, `releaseGate.test.ts`] |
| Blocking disk | Settings saves | One at a time under a lock, each waits for its write; requests beyond the request limit are answered `busy` (a write that never returns holds its request slot) |
| Second process | Settings files | The data-directory lock (`flock`), not released while a write is in flight (at most 10 s of waiting at shutdown, then released when the write settles or the process exits) [`dataDirLock.test.ts`, `releaseGate.test.ts`] |
| Faulty or hostile page | Playback counts | Clamped to the samples sent to that page for that reply; malformed reports ignored and logged at most once per 10 s [`WebAudio.test.ts`] |
| Reader beside a writer (CLI) | A read-only load | 20 attempts (~1 s), then an error, never a mix [`settingsStore.test.ts`] |

**Integration (2026-11-13)**: the real UI was run against the real server (`pnpm e2e:real`, `apps/web/e2e-real/`). Still **no message shape changed and `PROTOCOL_VERSION` is still 1**. What changed:

| What | Side | Why |
|---|---|---|
| A reconnect with `resumeOwner: true` also gets the audio back when **nobody has owned it since the server started** (not only when its `clientId` was the last owner). | Server (`SessionHub`) | After a restart the server has no last owner, so a page that owned the audio stayed an observer and needed a new Start; §6.3 step 5 expects ownership to resume, and "no other tab has claimed the audio since" holds. |
| A module in `stopping` (disabled, in its 10 s grace) is shown as **off**: no "Stopping" badge, no busy switch. | Front end (`ModuleCard`) | The module left the snapshot at once (§1.4); a spinner for 10 s said it was still on. §3.7 lists only the `STARTING` and `ERROR` badges. |
| State stays `speaking` after `playback.stopped` until `turn.end` (see the state-order row above). | Server (`StateTracker`) | Flicker seen in the real page. |
| The fake language model honours `BENCH_LLM_FIRST_TOKEN_MS` / `BENCH_LLM_TOKENS_PER_S` in every mode when set (it did only in `bench --live`). | Server (`providers.ts`) | To measure serve mode as §6.3 step 6 asks. |
| The voice list names the engine of a local voice ("Piper", "Kokoro") instead of "Piper/Kokoro". | Server (`Engine.ts`) | Misleading in the real options drawer. |
| `pnpm serve` (build the UI, then serve it) and `pnpm dev` (UI with hot reload + `@pva/assistant`'s new `dev` script). | Scripts | §6.3 and the README. |

Checked and found consistent, no change: the headless player sends `playback.started`, `progress` every ~250 ms and `finished`; on takeover the new owner's reducer copes with `turn.end` before its own `session`; after a reconnect the page sends `audio.config` and `mic.state` before frames; on Stop the page sends `interrupt` then `playback.stopped` (about 20 ms later in headless Chromium, whose device renders 10.7 ms blocks) and the turn ends within ~25 ms, far inside the server's 300 ms wait, with no stall error; when the server's `reply.stop` reaches the worklet during its fade, the single `playback.stopped` covers both (the server takes the first count either way); in `manual` mode the page holds frames back without advancing the sequence number (no `mic_gap`) while the server feeds its noise floor, and speech over the reply is ignored while the next question after it is heard. Not changed (noted): conversation history items carry no latency or "typed" marker, so the chat loses both for turns from before a reload.

**Who reads what**

| Reader | Sections |
|---|---|
| Everyone | [0. Decisions at a glance](#0-decisions-at-a-glance), [2. Protocol](#2-protocol), [6. Build plan](#6-build-plan) |
| Server implementer | [1. Modules](#1-the-module-system), [4. Server side](#4-server-side), [5. Echo and barge-in](#5-echo-and-barge-in) |
| Front-end implementer | [3. UI](#3-the-ui), [5. Echo and barge-in](#5-echo-and-barge-in) (client part) |

**Already in the repository (written with this document)**

- `packages/protocol`: every message as an Effect `Schema`, the binary frame encoder/decoder, `PROTOCOL_VERSION`, text-frame `encode*`/`decode*` helpers, and `@pva/protocol/examples` (one valid example of every message, for mocks and tests). Browser-safe: `pnpm check` compiles it with no Node types and no DOM. 59 tests.
- `packages/core/src/Settings.ts`: the `Setting` field constructors, `resolveSettings` and `applySettingsPatch` (pure). `packages/core/src/ModuleDefinition.ts`: `defineModule`, `ModuleContext`, `ModuleInstance`, `ModuleStartError`, `fromAssistantModule`. `packages/core/src/ConversationEvents.ts`: the types the core changes in §4.3 will use (`ConversationEvent`, `ConversationInput`, `PlaybackObserver`, `TurnSetup`). 11 tests. Nothing uses them yet; the existing modules, `Conversation` and the app are unchanged.

Where this design relies on the browser-audio research, which was **never run**, it says so and says how to check it (marked **[verify]**).

---

## 0. Decisions at a glance

| Topic | Decision | Why (short) |
|---|---|---|
| Process | `pnpm start serve`: one Node process, one port (default `127.0.0.1:8787`): static UI + WebSocket at `/ws` | One thing to run; the UI ships with the server, so versions always match |
| Transport | One WebSocket. Text frames = JSON messages (Effect Schema). Binary frames = PCM with an 8-byte header | Ordered, simple, no copy on the audio path |
| Browser audio | The browser is an `AudioInput`/`AudioOutput` backend (`packages/audio-web`). `Conversation` gains playback reports so history records what was heard | Keeps the pipeline unchanged; browser playback is not pull-paced |
| Several tabs | Any number may connect (max 8). Exactly one is the **audio owner** (mic + speaker); others are **observers** that see everything and play nothing. Ownership is claimed by pressing Start; the last claim wins | Personal assistant; moving from laptop to phone must be one tap |
| Module | `defineModule({ id, name, description, settings, start })`: contributes tools, context providers, prompt instructions and a status line. One file + one line in the catalog | Same "one file plus one line" rule, now with settings and lifecycle |
| Settings | Declared with a closed set of field types (`text`, `secret`, `number`, `boolean`, `choice`, `multichoice`); the UI renders forms from the descriptions | No front-end change to add a module or a setting |
| UI contributions from modules | **Data only**: a one-line status. No module code or markup in the browser | Keeps modules server-only; cards are deferred (see §1.9) |
| Lifecycle | Enable/disable/reconfigure live. Each turn uses a snapshot taken at its start; old instances are closed 10 s after being replaced | A turn never sees a half-applied change; in-flight tool calls finish |
| Persistence | `data/settings.json` (values and enabled state) and `data/secrets.json` (mode 0600, write-only from the UI). Environment variables win and lock the field | Readable, diffable; secrets never reach the browser |
| Voices, engines, turn detection | Same settings mechanism as modules ("assistant settings sections"), keyed by the existing environment variable names. Each field is `live` or `reload`; reload rebuilds the engines in-process in about 2 s, keeping the conversation | One form generator, one store; adapters unchanged |
| Echo | Browser echo cancellation on, plus a server-side **echo gate** and a per-device interrupt mode: `instant` (headphones), `confirm` (speakers, default), `manual` | The research could not confirm that browsers cancel Web Audio output |
| Front end | `apps/web`: Next.js static export, Tailwind 4, React; Effect for the connection fiber, decoding and retries; a hand-written store read with `useSyncExternalStore` | As the research verified |

---

## 1. The module system

### 1.1 What a module is

A module is a named capability that the owner can switch on and off and configure. While running, it contributes:

| Contribution | What it is | Where it goes | Cost |
|---|---|---|---|
| `tools` | Things the model can call (`Tool`, unchanged from today) | Tool list of the next turn's request | Part of the cached prefix: changing the set re-caches once |
| `context` | Short per-turn facts (`ContextProvider`, unchanged) | `LlmRequest.context` | Not cached; must answer within 50 ms (enforced) |
| `instructions` | Stable prompt text ("When the user asks about their home, use `home_state`.") | Appended to the system prompt | Part of the cached prefix: keep it constant |
| status line | One line plus a tone (`ok`, `warning`, `error`, `neutral`), published with `setStatus` | Shown next to the module in Options | Free |

**UI contributions are data only.** A module may publish a status line; it cannot ship components, markup or scripts to the browser. Reason: the browser bundle stays independent of the module list (a new module needs no front-end build), nothing from a module runs in the page, and a single generic renderer covers it. Richer elements (a weather card shown when the weather tool runs) are deferred; the path for them is §1.9.

A module cannot depend on the assistant's services (it cannot speak, listen or call the model). It gets its settings and a `setStatus` function, and runs in its own `Scope`. That keeps every module testable on its own, which is how `weather` is tested today.

### 1.2 Declaring a module (real code: `packages/core/src/ModuleDefinition.ts`, `Settings.ts`)

```ts
export const defineModule: <const S extends SettingsSpec = {}>(definition: {
  readonly id: string                // persistence key and protocol id: /^[a-z][a-z0-9-]{0,39}$/
  readonly name: string              // "Home Assistant"
  readonly description: string       // one sentence for the UI
  readonly settings?: S              // record of Setting.*(...) fields
  readonly enabledByDefault?: boolean // first run only; default true
  readonly start: (context: ModuleContext<SettingsOf<S>>) =>
    Effect.Effect<ModuleInstance, ModuleStartError, Scope.Scope>
}) => ModuleDefinition<S>

interface ModuleContext<A> {
  readonly settings: A                                            // validated; secrets resolved
  readonly setStatus: (status: StatusLine | undefined) => void    // sync, cheap, coalesced by the host
}
interface ModuleInstance {
  readonly tools?: ReadonlyArray<Tool>
  readonly context?: ReadonlyArray<ContextProvider>
  readonly instructions?: string
}
class ModuleStartError extends Schema.TaggedError<ModuleStartError>()("ModuleStartError", { message, cause? }) {}
```

`start` runs inside a scope the host owns. Acquire anything that must be released (intervals, sockets, caches with timers) with `Effect.acquireRelease` or `Effect.addFinalizer`. Check credentials in `start` so a bad token shows up as a start error on the module, not as a failing tool in the middle of a conversation.

Settings fields (`Setting.*` in `Settings.ts`; each maps to exactly one protocol `SettingField` type and one widget):

| Constructor | Module receives | Options (besides `label`, `description`, `advanced`, `apply`, `env`) | Widget |
|---|---|---|---|
| `Setting.text` | `string` | `default` (""), `placeholder`, `maxLength` (500), `multiline`, `check(value) => message?` | input / textarea |
| `Setting.secret` | `string \| undefined` | `required` | "Set / Not set" + Replace / Remove |
| `Setting.number` | `number` | `default`, `integer`, `min`, `max`, `step`, `unit` | number input with unit |
| `Setting.boolean` | `boolean` | `default` | switch |
| `Setting.choice` | union of the option values | `options: [{ value, label, description? }]`, `default` | segmented control (≤ 4 options) or select |
| `Setting.multichoice` | `ReadonlyArray<value>` | `options`, `default` | checkbox list |

`env: "NAME"` on any field means: when that environment variable (or `.env` entry) is set and non-empty, it provides the value and the field is shown read-only in the UI with "Set by NAME in the environment". This is how today's `.env` configuration keeps working after the migration (`WEATHER_DEFAULT_PLACE`, `WEATHER_UNITS`).

Precedence, per field: **environment > saved value > default**; for secrets: **environment > saved secret > not set**. `resolveSettings(spec, { stored, secrets, env })` computes the module's settings and the UI form (`SettingsForm`: fields, effective values, secret states, errors). `applySettingsPatch(spec, sources, patch)` validates a patch from the UI and returns the new saved values, all or nothing. Both are pure and tested.

### 1.3 The existing modules under the new design, and a new one

These are sketches for the implementer (the migration is their work); they use the real constructors above.

**clock** (`packages/modules-builtin/src/clock.ts`):

```ts
export const clockModule = defineModule({
  id: "clock",
  name: "Clock",
  description: "Tells the model the local date and time, and the time anywhere else.",
  settings: {
    timeZone: Setting.text({
      label: "Time zone",
      description: "IANA name, e.g. Europe/Amsterdam. Empty: this machine's zone.",
      env: "CLOCK_TIME_ZONE",
      check: (zone) => zone === "" || Option.isSome(DateTime.zoneMakeNamed(zone)) ? undefined : "Unknown time zone"
    }),
    locale: Setting.choice({
      label: "Date format",
      options: [{ value: "en-GB", label: "13 November 2026" }, { value: "en-US", label: "November 13, 2026" }, { value: "nl-NL", label: "13 november 2026" }],
      default: "en-GB"
    })
  },
  start: ({ settings }) => Effect.succeed(makeClock(settings))   // today's body: one context provider + current_time tool
})
```

**weather** (`packages/modules-builtin/src/weather.ts`):

```ts
export const weatherModule = (deps: { readonly fetch?: typeof globalThis.fetch } = {}) => defineModule({
  id: "weather",
  name: "Weather",
  description: "Current weather and today's forecast from Open-Meteo (no account needed).",
  settings: {
    defaultPlace: Setting.text({ label: "Home location", placeholder: "Amsterdam, Netherlands", env: "WEATHER_DEFAULT_PLACE",
      description: "Used when you don't name a place." }),
    units: Setting.choice({ label: "Units", env: "WEATHER_UNITS", default: "celsius",
      options: [{ value: "celsius", label: "Celsius, km/h" }, { value: "fahrenheit", label: "Fahrenheit, mph" }] }),
    timeoutMs: Setting.number({ label: "Timeout", default: 3000, integer: true, min: 500, max: 10_000, step: 100, unit: "ms", advanced: true })
  },
  start: ({ settings, setStatus }) => Effect.sync(() => {
    if (settings.defaultPlace !== "") setStatus({ text: `Home: ${settings.defaultPlace}`, tone: "neutral" })
    return { tools: [makeWeatherTool({ ...settings, fetch: deps.fetch ?? globalThis.fetch })] }   // today's tool
  })
})
```

The geocode cache lives inside `start`, so changing settings starts with a fresh cache. Tests keep injecting `fetch` through `weatherModule({ fetch })`.

**home-assistant** (new; proves secrets, a start-time check, a status line and instructions):

```ts
export const homeAssistantModule = defineModule({
  id: "home-assistant",
  name: "Home Assistant",
  description: "Reads the state of lights, sensors and climate from your Home Assistant.",
  enabledByDefault: false,
  settings: {
    baseUrl: Setting.text({ label: "Address", default: "http://homeassistant.local:8123", env: "HOME_ASSISTANT_URL",
      check: (u) => /^https?:\/\//.test(u) ? undefined : "Must start with http:// or https://" }),
    token: Setting.secret({ label: "Access token", env: "HOME_ASSISTANT_TOKEN", required: true,
      description: "A long-lived access token (your Home Assistant profile → Security)." }),
    domains: Setting.multichoice({ label: "Devices it may read", default: ["light", "sensor", "climate"],
      options: [{ value: "light", label: "Lights" }, { value: "sensor", label: "Sensors" },
                { value: "climate", label: "Climate" }, { value: "lock", label: "Locks" }] })
  },
  start: ({ settings, setStatus }) => Effect.gen(function*() {
    const api = makeHaClient(settings.baseUrl, settings.token!, { timeoutMs: 2000 })     // fetch-based
    const info = yield* api.get("/api/config").pipe(                                      // fails fast on a bad token
      Effect.mapError((e) => new ModuleStartError({ message: e.status === 401
        ? "Home Assistant rejected the token (HTTP 401). Create a new long-lived token and paste it here."
        : `Cannot reach Home Assistant at ${settings.baseUrl}: ${e.message}` })))
    // Entity list cached and refreshed every 60 s: the tool answers from memory, so it is fast and speculative-safe.
    const entities = yield* makeEntityCache(api, settings.domains, "60 seconds")          // acquireRelease'd refresh fiber
    setStatus({ text: `Connected to ${info.location_name} · ${entities.size} devices`, tone: "ok" })
    return {
      instructions: "For questions about the user's home (lights, temperature, sensors), use home_state.",
      tools: [makeTool({
        name: "home_state",
        description: "Current state of devices, by area (\"living room\") or by name (\"thermostat\").",
        parameters: Schema.Struct({ query: Schema.String }),
        speculative: true,                     // read-only
        execute: ({ query }) => entities.lookup(query)   // fresh state for the matches: one GET, 2 s timeout
      })]
    }
  })
})
```

A later "control" tool (turning a light on) would be a second tool with `speculative: false`, so it only runs once the turn is committed. That is the existing rule; nothing new is needed.

### 1.4 Lifecycle

The **module host** (`packages/core/src/ModuleHost.ts`, new, Node-free; persistence is injected) owns every module. It holds, per module: the definition, the owner's intent (`enabled`), the runtime state, the running instance and its scope, and the settings sources. It publishes an immutable **snapshot** (tool registry + instructions) that each turn reads once at its start.

| State | Meaning | Entered on | Next |
|---|---|---|---|
| `disabled` | Not running; intent off | startup with intent off; disable completed | `starting` on enable |
| `starting` | `start` is running (10 s limit) | enable; startup with intent on; retry | `running`, `error` |
| `running` | Instance is in the snapshot | `start` succeeded | `stopping` on disable; stays `running` on reconfigure |
| `stopping` | Removed from the snapshot; scope closes after a 10 s grace | disable | `disabled` |
| `error` | Intent on, not running. `error` says why | start failed or timed out; saved settings invalid; tool name clash | `starting` on enable (retry) or reconfigure; `disabled` on disable |

Rules:

- **One operation per module at a time.** A second request for the same module while one runs gets `result` with `busy`. Operations on different modules run concurrently.
- **Enable**: resolve settings. Invalid → `error` (form errors), intent saved as on, `result` with `invalid_settings`. Tool names clash with another running module → `error` ("Tool name `weather` is already used by module X"), `result` with `module_start_failed`. Otherwise `starting` → `start` → `running` (a new snapshot is published) or `error` (`result` with `module_start_failed` and the start error's message). Intent is saved as on in every case, so a module that failed because a key was missing comes up by itself after the key is fixed and the assistant restarts. Enabling a module in `error` is the retry.
- **Disable**: intent saved as off; the module leaves the snapshot immediately (`stopping`); its scope is closed 10 s later (or at shutdown), so a tool call already running finishes normally. Tools must time out well under 10 s anyway (weather: 3 s).
- **Reconfigure** (`module.configure`): `applySettingsPatch`; invalid → `result` with `invalid_settings` and `fieldErrors`, nothing changes. Then, by state:
  - `running`: start a new instance with the new settings while the old one keeps serving. Success → swap it into a new snapshot, retire the old one (10 s grace), save the settings. Failure → keep the old instance, **do not save**, `result` with `module_start_failed`. Saved settings always match what runs.
  - `disabled`: save; nothing starts.
  - `error`: save (the old settings did not work either), then start → `running` or `error`.
- **A turn in flight** keeps the snapshot it took at its start, including a pending speculative turn that is later promoted. Changes apply from the next turn. If the model calls a tool of a module disabled during the turn, the tool still runs (its scope is in its grace period).
- **System prompt and cache.** The system prompt of a turn is `base prompt + instructions of running modules (catalog order) + voice block`, built when the snapshot changes. A module change that alters the tool list or the instructions changes the cached prefix (tools → system → messages), so the next request writes a new cache entry: expect a slower first token on that one turn, visible in its trace. Context providers do not affect the cache.
- **Context providers** are wrapped by the host with a 50 ms timeout; a slow provider contributes nothing to that turn and logs a warning (it must not add latency to every turn).
- **Runtime trouble after start** (the Home Assistant server goes away): tools return `ToolError` as today; the module may set an `error`-tone status. The host does not restart modules automatically.
- **Startup**: modules with intent on start concurrently with the engine build; neither waits for the other. A module still starting when the first turn begins is simply not in that turn's snapshot.
- **Shutdown**: every module scope is closed (no grace).

### 1.5 Validation and error reporting

| Problem | Where it shows |
|---|---|
| Saved value invalid (e.g. the module's settings changed in an update) | Module goes to `error`; the form shows the default next to a field error "The saved value is not valid (…); save a new one" |
| Environment value invalid (`WEATHER_UNITS=kelvin`) | Module `error`; field error "WEATHER_UNITS=kelvin is not valid: Must be one of: celsius, fahrenheit"; field locked |
| Required secret missing | Module `error`; field error "Not set (enter it here or set HOME_ASSISTANT_TOKEN)" |
| Patch invalid | `result` `{ ok: false, error: { code: "invalid_settings", fieldErrors } }`; nothing saved |
| Patch touches a locked field | Same, field error "Set by X in the environment; change it there" |
| `start` fails / times out | Module `error` with the start error's message (or "Did not start within 10 s"); `result` `module_start_failed` for the request that caused it |
| Settings file unreadable or corrupt | Renamed to `settings.json.corrupt-<timestamp>`, everything starts from defaults, an `error` message (`internal`) tells the UI and the log |

All messages are written for the owner: what is wrong and how to fix it, in one sentence, as the CLI startup errors are today.

### 1.6 Persistence

Directory: `PVA_DATA_DIR`, default `<repo>/data/` (git-ignored; add it to `.gitignore`). The app already lives in its checkout (`models/`, `.env`), so the data does too.

`data/settings.json` (written only when the owner changes something):

```json
{
  "version": 1,
  "modules": {
    "weather": { "enabled": true, "settings": { "defaultPlace": "Amsterdam, Netherlands" } },
    "home-assistant": { "enabled": false, "settings": { "baseUrl": "http://192.168.1.20:8123" } }
  },
  "sections": {
    "voices": { "DEFAULT_VOICE": "natural" },
    "listening": { "STT_SHERPA_FINAL_SILENCE_MS": 500 }
  }
}
```

`data/secrets.json` (mode `0600`, same shape, secrets only):

```json
{ "version": 1, "modules": { "home-assistant": { "token": "eyJ..." } }, "sections": { "language-model": { "ANTHROPIC_API_KEY": "sk-ant-..." } } }
```

- Only values the owner set are stored; everything else comes from defaults, so a changed default in code takes effect for unset fields. `null` in a patch removes the key.
- A module missing from the file uses `enabledByDefault` and defaults. Entries for modules no longer in the catalog are kept untouched (a module removed for a while keeps its settings).
- Writes are atomic (write `*.tmp`, then rename) and serialised. Both files are read once at startup; the server is their only writer.
- **Secrets**: the browser can set or remove a secret but never read it back; the form shows only `{ set, source }`. They live in their own file so `settings.json` can be shared or committed elsewhere without leaking them. This is no weaker than `.env`, which already holds the language-model key in plain text on the same machine. Encrypting at rest is not useful here (the key to decrypt would sit next to it).
- **Environment wins** over both files, everywhere. Consequence for `.env.example`: it currently sets many defaults uncommented (`STT_SHERPA_FINAL_SILENCE_MS=600`, `VOICES=standard`, …); copied as is, they would lock those fields in the UI. The server work must comment out every line whose value equals the default, keeping the explanations.

### 1.7 Voices, engines and turn detection: assistant settings sections

**Decision: the same mechanism as modules.** Assistant settings are presented as **sections** (`SettingsSection` in the protocol): an id, a title, and a `SettingsForm`, built with the same `Setting` constructors and resolved with the same functions. The difference from a module: no enable switch, no tools, and each field is keyed by its **existing environment variable name** with `env` set to that same name.

The saved section values are fed to the providers through an Effect `ConfigProvider` placed *under* the environment (`ConfigProvider.orElse(env, fromRecord(savedSectionValues ∪ savedSectionSecrets))`). Provider adapters read their settings exactly as today; the `VOICE_<NAME>_` prefix wrapper in `voices.ts` wraps this combined provider. No adapter changes.

The server builds the sections for the providers in use (e.g. `listening` shows sherpa thresholds when `STT_PROVIDER=sherpa`, Deepgram's when `deepgram`), so the UI never shows settings that do nothing.

| Section | Field (env name) | Type | Apply | Notes |
|---|---|---|---|---|
| `conversation` | `SYSTEM_PROMPT` | text, multiline | live | Next turn; re-caches once |
| | `MAX_TOOL_ROUNDS` | number | reload | A `Conversation` option |
| `voices` | `DEFAULT_VOICE` | choice (enabled voices) | **live** | Needs the router's fixed output rate (§4.3) |
| | `VOICES` | multichoice (catalog) | reload | Starts or stops engine processes |
| `listening` (sherpa) | `STT_SHERPA_MODEL` | choice | reload | |
| | `STT_SHERPA_EAGER_SILENCE_MS`, `STT_SHERPA_FINAL_SILENCE_MS` | number, ms | reload | `Stt` has no reconfigure call today |
| | `STT_SHERPA_VAD_THRESHOLD`, `STT_SHERPA_MIN_SPEECH_MS` | number, advanced | reload | |
| `listening` (deepgram) | `DEEPGRAM_EOT_THRESHOLD`, `DEEPGRAM_EAGER_EOT_THRESHOLD` | number | reload | |
| `language-model` | `LLM_PROVIDER` | choice | reload | |
| | `ANTHROPIC_MODEL` | text | reload | |
| | `ANTHROPIC_API_KEY` | secret | reload | So a fresh install can be set up from the UI |
| `speech` | `STT_PROVIDER`, `TTS_PROVIDER` | choice | reload | |
| not in the UI (v1) | `VOICE_<NAME>_*`, thread counts, URLs, timeouts | | | Environment only |
| **per device, in the browser** | interrupt mode, microphone, speaker, output path, prebuffer, captions, latency readout | | live | `localStorage`; not server settings, because they depend on the device (headphones on the laptop, speakers on the phone) |

**Reload** (`engine.reload`): interrupt the running turn (committed as interrupted, as with barge-in), stop the voice loop, close the engine scope (engine processes, STT worker, sockets), rebuild providers with the saved settings, start a new `Conversation` with the previous history (`initialHistory`, §4.3) and a new voice loop. The HTTP server, the sockets, the module host and the audio owner are untouched. About 2 s with local models. The old engines are closed **before** the new ones are built (two STT models would not fit comfortably in memory). If the build fails, the engine state is `failed` with the same per-stage problem lines as the CLI startup error; the UI shows them and settings stay editable, so the owner can fix the key and reload again. After saving a `reload` field, `EngineStatus.reloadPending` is true until a reload succeeds.

Making turn-detection thresholds live is a later, small change (the sherpa `TurnDetector` runs on the main thread): deferred.

### 1.8 Authoring a module: still one file plus one line

1. Write `packages/modules-builtin/src/<name>.ts` (or a new package if it needs a dependency) exporting `defineModule({...})`.
2. Add it to the catalog in `apps/assistant/src/modules.ts`: `export const moduleCatalog = [clockModule, weatherModule(), homeAssistantModule]`. Order = display order = order of instructions in the prompt.
3. Test it without the host: `resolveSettings(module.settings, { stored, secrets: {}, env: {} })`, then `Effect.scoped(module.start({ settings, setStatus }))`, then call its tools (see `packages/core/test/Settings.test.ts`, "starts a module in a scope with typed settings"). Inject network functions as today (`weatherModule({ fetch })`).

The UI, persistence, enable switch, settings form and status line come for free. The CLI modes (`text`, `voice`, `bench`) use the same catalog through the module host (load the saved settings, start the enabled modules, no live changes), so behaviour is the same everywhere.

### 1.9 Deferred (modules)

- **Cards and other rich module output.** Path when needed: a tool result may carry an optional `display` value from a small closed set of data kinds (`facts`: label/value pairs; `list`; `image` URL), sent as an optional field on `tool.end` and rendered by one generic component per kind. Still no module code in the browser.
- Modules that use assistant services (speak a notification, schedule a turn), modules with their own background triggers ("remind me at 5").
- Per-module permissions beyond the existing speculative flag; confirmation before side-effecting tools.
- Hot-loading module code from disk (the catalog is compiled in).
- Automatic restart of a module after runtime failures.

---

## 2. Protocol

Source of truth: `packages/protocol/src/*.ts`. This section explains the behaviour; the schemas define the shapes. `@pva/protocol/examples` has a valid example of every message.

### 2.1 Connection

- **Endpoint**: `ws(s)://<host>/ws` (`WS_PATH`), same origin as the UI in production. In development the page (port 3000) connects to `ws://localhost:8787/ws` (`NEXT_PUBLIC_PVA_WS_URL`).
- **Origin check** (prevents another web page in the owner's browser from opening the socket): the server accepts the upgrade only if `Origin` equals the server's own origin or is listed in `SERVE_ALLOWED_ORIGINS` (default `http://localhost:3000,http://127.0.0.1:3000`). Otherwise HTTP 403.
- **Host check** (DNS rebinding: a page on an attacker's host name that resolves to the assistant would otherwise pass the origin check, since its origin and the `Host` it sends are the same name): every request and upgrade whose `Host` is not an IP address, `localhost`, a host of `SERVE_ALLOWED_ORIGINS` or a name in `SERVE_ALLOWED_HOSTS` is refused with HTTP 403.
- **Handshake**: the client's first message is `hello { protocol, clientId, resumeOwner }`. Nothing else (text or binary) is accepted before it; no `hello` within 5 s → close `4401`. If `protocol !== PROTOCOL_VERSION`, the server sends `error` (`bad_message`, "This page is out of date; reload it") and closes with `4400`; the client stops reconnecting and shows "Reload". Otherwise the server answers `welcome { protocol, server, connectionId, snapshot }`.
- `clientId`: random, created per page load and kept in `sessionStorage` (survives reloads of that tab, not shared between tabs).
- **Roles**: every connection starts as `observer` (it receives every message except reply audio, and its microphone frames are ignored), except a reconnect with `resumeOwner: true` from the `clientId` that was the last owner, when no other tab has claimed the audio since; that connection becomes `owner` again (`session` reason `resumed`).
- **Claim** (`audio.claim`, sent after the Start gesture succeeded): the sender becomes the owner. A previous owner gets `reply.stop` for any reply it is playing, then `session { role: "observer", reason: "taken_over" }`, and its turn in flight is interrupted (§2.5). Every tab gets `session` with `ownerPresent: true`.
- **Release** (`audio.release`) or owner disconnect: no owner; every tab gets `session { ownerPresent: false }` (`released` / `owner_disconnected`).
- **Second tab, in short**: it connects as an observer and shows "Audio is on another tab or device · Use this tab". Pressing it claims the audio.
- **Limits**: 8 connections (the 9th is closed with `4429`). A connection whose send buffer exceeds 1 MiB (observers) or 8 MiB (owner) is closed with `4408` and will reconnect for a fresh snapshot.
- **Liveness**: the server sends a WebSocket ping every 15 s and terminates a connection with no pong for 30 s (browsers answer pings themselves, unaffected by background-tab timer throttling). The client sends `ping { id }` every 5 s and treats the socket as dead if no `pong` arrives within 10 s (close and reconnect).
- **Close codes**: `CloseCode` in `constants.ts`.

### 2.2 Binary frames

Every binary frame has an 8-byte header followed by PCM (`frames.ts`):

| Offset | Size | Field |
|---|---|---|
| 0 | u8 | kind: `1` microphone audio (browser → server), `2` reply audio (server → browser) |
| 1 | u8 | reserved: senders write 0, receivers ignore |
| 2 | u16 | reserved: senders write 0, receivers ignore |
| 4 | u32 LE | kind 1: frame sequence number. Kind 2: the reply's turn id (≥ 1) |
| 8 | … | PCM signed 16-bit little-endian, mono, non-empty, even length, ≤ 262 144 bytes. Kind 1: 16 kHz. Kind 2: the rate from that turn's `reply.start` |

- **Microphone**: normally 320 samples (20 ms, `MIC_FRAME_SAMPLES`) per frame, 648 bytes in total. The sequence number restarts at 0 after `audio.claim`, after `mic.state { live: true }`, and on the first frame after a resumed connection; it increases by one per frame (wrapping at 2^32). The server detects lost frames with `micSequenceGap` and reports them (`error` code `mic_gap`, at most once per 10 s); it does not insert silence for them.
- **Reply**: one frame per TTS chunk (about 40 ms for Piper), sent as soon as the chunk exists, not paced to real time.
- **No copies**: the capture worklet allocates `8 + 640` bytes and writes PCM after the header; the main thread fills in the header with `writeFrameHeader` and calls `ws.send(buffer)`. On receive, the browser transfers the whole `ArrayBuffer` to the player worklet, which reads `new Int16Array(buffer, 8)`. On the server, `decodeMicFrame` returns a view (`pcmSamples` copies only if a pooled Node buffer is misaligned).
- **Why a header at all** (close call; the research advised against one): the reply id on every chunk lets the player drop audio of a reply it has already stopped without any timing assumption, the microphone sequence number makes lost audio visible, and the kind byte leaves room for other binary streams. It costs 8 bytes per 20 ms (1.2 %).
- Frames of the wrong direction, unknown kind, odd length or before `hello` are dropped; the server answers `error` `bad_message` once per connection, and closes with `4402` only for binary data before `hello`.

### 2.3 Messages

Text frames are JSON objects with a `type`. Decoding (`decodeClientMessage`, `decodeServerMessage`) returns `Ok`, `Unknown` (a `type` this build does not know: ignore it) or `Invalid` (not JSON, too big, or a known type with bad fields: the server answers `error` `bad_message`; the client logs it). Unknown fields are stripped, so an older peer accepts newer optional fields.

**Browser → assistant**

| Message | Who may send | Server action |
|---|---|---|
| `hello` | first message only | `welcome`, or close (§2.1) |
| `audio.claim { interruptMode, audio }` | any | Becomes owner; microphone is live; sequence restarts |
| `audio.release` | owner | No owner |
| `audio.config { interruptMode, audio }` | owner | Updates interrupt mode and audio info |
| `mic.state { live }` | owner | `false`: feed the STT a noise floor instead of the microphone; `true`: use frames again |
| `playback.started { turnId, outputLatencyMs, startDelayMs }` | owner | `PlaybackObserver.started`; records `trace.client` |
| `playback.progress { turnId, playedSamples, underruns }` | owner, every 250 ms while a reply is between `reply.start` and its end | `PlaybackObserver.progress`; resets the stall timer |
| `playback.finished { turnId, playedSamples }` | owner | Final progress; `play` returns |
| `playback.stopped { turnId, playedSamples, exact? }` | owner (or the tab the reply was playing to, §2.1) | Final progress after a stop; `play`'s interruption completes. `exact: false`: the page's best count, provisional: the server waits (within its 300 ms) for an exact one and uses it instead (§2.6). Absent (older pages) or `true`: exact |
| `interrupt { turnId? }` | any | Interrupts the running committed turn (ignored if `turnId` names another turn) |
| `text.send { requestId, text, speak }` | any | `result` (accepted or not), then a turn. Spoken only if the sender is the owner and `speak` |
| `module.enable` / `module.disable { requestId, moduleId }` | any | §1.4; `result` to the sender, `module.changed` to all |
| `module.configure { requestId, moduleId, patch }` | any | §1.4 |
| `settings.update { requestId, sectionId, patch }` | any | Validate, save; `live` fields apply from the next turn; `result`, `section.changed`, `engine` (for `reloadPending`) |
| `engine.reload { requestId }` | any | §1.7; `engine` messages while reloading; `result` when done |
| `ping { id }` | any | `pong { id }` |

Messages the role does not allow (playback reports from an observer, `mic.state` from an observer) are ignored with one `error` `not_owner`. Requests (`requestId`) are answered with exactly one `result` to the sender; the resulting change is broadcast to every tab (`module.changed`, `section.changed`, `engine`), the sender included, so every tab, including the one that made the change, updates from the broadcast. Each `ModuleInfo` and `SettingsSection` carries a `revision`; a client keeps the highest it has seen.

**Assistant → browser** (to every tab unless marked *owner* or *sender*)

| Message | When |
|---|---|
| `welcome` (*new connection*) | After `hello` |
| `session` (*each tab, with its own role*) | Ownership changed |
| `state { state, turnId? }` | The assistant state changed (§2.4) |
| `transcript { text }` | Interim speech recognition result (replaces the previous one); `""` clears it |
| `turn.start { turnId, source, userText, spoken }` | A turn was committed (speculative turns stay invisible until promoted) |
| `assistant.text { turnId, clause, text, voice? }` | Spoken turns: one per clause as it goes to TTS, markers removed, `voice` = voice speaking it. Unspoken turns: raw deltas with `clause: null` |
| `assistant.playing { turnId, clause }` | Clauses up to `clause` started playing in the owner's browser |
| `tool.start` / `tool.end` | Tool calls of committed turns (input truncated to about 2 KB of JSON) |
| `turn.end { turnId, outcome, trace }` | The turn ended; `trace` is its latency trace |
| `reply.start { turnId, sampleRate }` (*owner*) | Reply audio for `turnId` follows |
| binary kind 2 (*owner*) | Reply audio |
| `reply.end { turnId }` (*owner*) | All reply audio has been sent |
| `reply.stop { turnId }` (*owner*) | Stop playing now and answer `playback.stopped` |
| `module.changed`, `section.changed`, `engine` | A module, section or the engines changed |
| `result` (*sender*) | Answer to a request |
| `error` | A problem not tied to a request (`turn_failed`, `mic_gap`, `playback_timeout`, …) |
| `pong` (*sender*) | Answer to `ping` |

**History on connect**: `welcome.snapshot.history` holds the last 200 items as the user saw them (one `user` and at most one `assistant` item per turn: the turn's assistant text with markers removed, the heard part only if it was interrupted, and its tool names with success). `snapshot.traces` holds the last 20 traces. A tab that connects in the middle of a turn receives that turn's later events; the client creates the turn view on the first event it sees for an unknown `turnId`.

### 2.4 Assistant state

Computed on the server (one source of truth), broadcast with `state`. First matching row wins:

| State | Condition |
|---|---|
| `speaking` | The owner reported `playback.started` for the current committed turn, and not yet `playback.finished` / `playback.stopped` |
| `thinking` | A committed turn is running (from `turn.start` to `turn.end`): model, tools, synthesis before the first sound, and unspoken text turns |
| `hearing` | Owner present, microphone live, and an utterance is open: a forwarded `SpeechStarted` / `Interim` / `EagerEndOfTurn` / `TurnResumed` within the last 2 s and no turn committed since. A pending speculative turn counts as `hearing` |
| `listening` | Owner present and microphone live |
| `idle` | Otherwise (no owner, or the owner's microphone is off) |

The browser adds client-only states on top (§3.3): not started, muted, disconnected, error, and observer.

### 2.5 Sequences

**Start and a voice turn** (owner tab; `→` browser to server):

```
→ hello {protocol:1, clientId, resumeOwner:false}
← welcome {snapshot: {state:"idle", role:"observer", ownerPresent:false, ...}}
   (user presses Start: AudioContext created and resumed, getUserMedia, worklets loaded)
→ audio.claim {interruptMode:"confirm", audio:{contextSampleRate:48000, outputPath:"direct", ...}}
← session {role:"owner", ownerPresent:true, reason:"claimed"}      ← state {state:"listening"}
→ [mic frame seq 0] [seq 1] ...                                    (every 20 ms from now on)
← state {state:"hearing"}   ← transcript {text:"what's the"}   ← transcript {text:"what's the weather in Paris"}
   (server: EagerEndOfTurn → speculative turn, invisible; EndOfTurn → promoted)
← transcript {text:""}   ← turn.start {turnId:12, source:"voice", userText:"What's the weather in Paris?", spoken:true}
← state {state:"thinking", turnId:12}
← tool.start {...weather...}   ← tool.end {ok:true, ms:241}
← assistant.text {turnId:12, clause:0, text:"It's sunny in Paris,", voice:"standard"}
← reply.start {turnId:12, sampleRate:22050}   ← [reply frame 12] [reply frame 12] ...
→ playback.started {turnId:12, outputLatencyMs:21, startDelayMs:0}
← state {state:"speaking", turnId:12}   ← assistant.playing {turnId:12, clause:0}
← assistant.text {clause:1, ...}  ... ← reply.end {turnId:12}
→ playback.progress {turnId:12, playedSamples:5512, underruns:0}   (every 250 ms)
→ playback.finished {turnId:12, playedSamples:52920}
← turn.end {turnId:12, outcome:"completed", trace:{...}}   ← state {state:"listening"}
```

**Barge-in** (the user speaks over the reply; interrupt mode decides when the server acts, §5):

```
← (speaking turn 12)          server: SpeechStarted (+ confirmation in "confirm" mode) → interrupt turn 12
← reply.stop {turnId:12}                      browser: 4 ms fade, drop the queue
→ playback.stopped {turnId:12, playedSamples:17640}   server: history keeps clauses that started before sample 17640
← turn.end {turnId:12, outcome:"interrupted"}   ← state {state:"hearing"}
```

The server waits up to 300 ms for `playback.stopped`; without it, it uses the last `playback.progress` value. A first `playback.stopped {exact:false}` does not end the wait: an exact one arriving within the same 300 ms replaces it, and otherwise the provisional count is used. Sound stops as soon as the browser handles `reply.stop` (§2.6 has the numbers).

**Stop button** (any tab): the owner's browser fades out and flushes its player itself first, then sends `interrupt {turnId}` and, once the worklet confirms, `playback.stopped`. The server interrupts the turn; its own `reply.stop` arrives at a player that is already idle and is answered with `playback.stopped` again (idempotent: the server uses the first exact one). From an observer tab, `interrupt` takes the normal `reply.stop` route.

**Typed message**: `→ text.send {requestId:"r1", text, speak:true}` → `← result {requestId:"r1", ok:true}` → `turn.start {source:"text", spoken: <owner && speak>}` → as above (spoken), or `assistant.text {clause:null}` deltas and `turn.end` (unspoken). Typing while the assistant speaks interrupts the reply, like speaking does. If the engine is not ready: `result {ok:false, error:{code:"engine_failed"}}`.

**Module change from tab A while tab B is open**: `A→ module.configure {requestId, moduleId:"weather", patch}` → `←A result {ok:true}`, `←A,B module.changed {module: {..., revision: 4}}`.

### 2.6 Reply playback lifecycle

**Server side** (`WebAudioOutput.play`, one call per committed spoken turn):

| Step | Action |
|---|---|
| Call | No owner → fail at once (`AudioError` "no audio client"). Otherwise send `reply.start { turnId, sampleRate }` |
| Each chunk pulled | Send it as a reply frame at once (split if over the payload limit). Count samples sent |
| Stream ends | Send `reply.end`; wait for `playback.finished`. A `playback.finished` before `reply.end` was sent is ignored (logged, rate-limited): the reply stays open (sixth review) |
| Reports | `started` → observer `started()`, trace `client`. `progress` / `finished` / `stopped` → observer `progress(playedSamples)` (non-decreasing). When the reply ends, however it ends: observer `final(count)` once, with the committed final count (lower than the last progress if the page says so), else the last progress (sixth review) |
| Stall | No report for 2 s while waiting → send `reply.stop`, fail with `playback_timeout` (an `error` message tells the UI) |
| Owner lost (disconnect or takeover) | Fail ("audio client disconnected"); final progress = last reported. History keeps what was reported played |
| Interrupted (barge-in, Stop, reload), takeover, audio failed upstream | Send `reply.stop` (a takeover sends it to the previous owner); wait ≤ 300 ms from then for `playback.stopped` from that link; report final progress; complete (or fail) |
| `playback.stopped {exact:false}` (first) | Provisional: kept, not reported, the wait goes on to the same deadline. A later exact report (`exact` true or absent) from the same link and reply ends the wait and is the final count (lower or higher). A second provisional report is ignored |
| Deadline passes | Final count = the provisional one if there is one, else the last progress. Also when the reply ends without the wait (owner disconnected, stall) after a provisional report |

A failed `play` makes the turn `failed`; core commits a failed turn like an interrupted one (only clauses that played), so history stays correct.

**Browser side** (player worklet; extends the research's `PlayerProcessor`, **[verify]** with the tests in §6):

| State | On | Next |
|---|---|---|
| `idle` | `reply.start` | `buffering` (new id, new resampler from `sampleRate` to the context rate) |
| `buffering` | queued ≥ prebuffer (60 ms default) or `reply.end` | `playing` (post `started` once per reply, with `startDelayMs` = time since the first frame arrived) |
| `playing` | queue empty, reply not ended | `buffering` (underrun, 40 ms refill; counted in `underruns`) |
| `playing` | queue empty after `reply.end` | `idle`, post `finished { playedSamples }` |
| any | `reply.stop`, user Stop, socket closed | 4 ms fade → `idle`, post `stopped { playedSamples }` (no message to the server if the socket is closed); the page sends it with `exact: true` |
| any | frame whose id ≠ current reply | Dropped |
| `idle` | `reply.stop` for the reply that just ended or was stopped | Answer `stopped` again with the same final count (the worklet keeps the last reply's id and count) |

The server ignores playback reports for a turn that is not the one currently playing, or from a link it is not playing to, and takes the first **exact** final count it receives (`playback.finished`, or `playback.stopped` without `exact: false`), or the first provisional one when no exact one comes in time. Every count is clamped to the samples the server sent to that link for that reply (fifth review, "Changes since the design"). The page marks a stop answered from its own best count (the worklet had not answered `STOP_ANSWER_MS` after the stop, or the page is closing) with `exact: false`, and sends the worklet's count, when it differs, as a second `playback.stopped` with `exact: true`.

- `playedSamples` counts samples of the reply (at its source rate) **handed to the audio device**, not heard. Samples already in the device buffer will still be heard after a stop (they cannot be recalled), so this is the right number for history.
- The worklet posts `progress` every 250 ms of render time; the main thread forwards it. Driving it from the audio thread keeps it regular in background tabs, where timers are throttled.
- Stop latency (from `reply.stop` arriving to silence): message hop + ≤ 1 render quantum (2.7 ms at 48 kHz) + 4 ms fade + the device's `outputLatency` (typically tens of ms; Bluetooth more). The server's network send adds about 1 ms on a LAN. **[verify]**: measure `outputLatency` per device and record it in the trace.

### 2.7 Stalls, drops and reconnection

| Situation | Server | Browser |
|---|---|---|
| Socket closes mid-reply | Owner lost: turn fails, history = last reported progress | Flushes the player at once (never plays audio the server will not count), stops sending microphone frames, keeps the `AudioContext` and microphone open, reconnects |
| Socket stalls mid-reply (no close) | 2 s without reports → `reply.stop` + `playback_timeout`; dead TCP is cleaned up by the ping timeout | Player underruns, keeps re-buffering; ping timeout (10 s) → close and reconnect |
| Microphone send buffer > 16 000 bytes (500 ms) | Sees a sequence gap → `mic_gap` error, turn detection continues on what arrives | Drops microphone frames instead of queuing them (a growing queue is latency) |
| Owner disconnects while the user is mid-sentence | Feeds the STT the noise floor, so the open utterance resolves; the reply to it has no owner and fails at once (history: the user message, no assistant text) | — |
| Reconnect | Same as a new connection; ownership resumes if `resumeOwner` and nobody claimed since | Exponential backoff 250 ms doubling to 5 s, reset after a `welcome`; the store is replaced by the new snapshot; stops retrying after close `4400` |

### 2.8 Versioning

`PROTOCOL_VERSION` (an integer, now 1) is checked once, at `hello`. Bump it for anything an older peer could misread: removed or renamed messages or fields, changed meaning, a new required field, a new member of a closed literal set (states, outcomes, error codes, field types), or a framing change. New optional fields and new message types do not need a bump (unknown types are ignored, unknown fields stripped). Example: `playback.stopped.exact` (optional, absent = exact) — an older server strips it and takes the first count as before; a newer server reads an older page's reports as exact, which is what they were treated as; nothing an older peer reads changes meaning. In production the UI is served by the assistant itself, so a mismatch means a stale tab or `next dev` against an older server; the UI then asks for a reload.

---

## 3. The UI

### 3.1 Layout

One screen. The stage (visualiser) is the page; everything else is a quiet frame around it or a panel over it.

```
Desktop (≥ 1024 px)
┌────────────────────────────────────────────────────────────────────────────────┐
│ ● PVA   listening          End                              ↯ 642 ms    ⚙      │ top bar, 56 px
│                                                                                │
│                                                                                │
│              ∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿                 │ visualiser, 240 px tall,
│                               SPEAKING · natural                               │ ≤ 720 px wide
│                 It's sunny in Paris, eighteen degrees, light wind.             │ captions
│                                                                                │
│                                                         ┌────────────────────┐ │
│                                                         │ CONVERSATION     ✕ │ │ chat popover,
│                                                         │ YOU                │ │ 400 × min(640, 100dvh−120),
│                                                         │ What's the weather │ │ 24 px from the corner
│                                                         │ ASSISTANT   642 ms │ │
│                       (🎙)   (■)   (💬)                  │ It's sunny in …    │ │
│                    mic   stop   chat                    │ [Type a message] ↵ │ │ dock, centred, 24 px from bottom
└────────────────────────────────────────────────────────────────────────────────┘

Phone (< 640 px)                         Options: right drawer 420 px (≥ 640), full-screen sheet (< 640)
┌──────────────────────────┐             Chat: popover (≥ 1024), right sheet 400 px (640–1023),
│ ● listening   ↯ 642  ⚙   │             bottom sheet 85dvh with a drag handle (< 640)
│                          │
│  ∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿  │  visualiser 160 px tall, full width − 32 px
│        SPEAKING          │
│   It's sunny in Paris…   │
│                          │
│     (🎙)  (■)  (💬)      │  56 px touch targets
└──────────────────────────┘
```

When the chat popover is open on a screen narrower than 1440 px, the stage content shifts left by half the popover width (320 ms, `--ease-out`) so the line is not covered.

### 3.2 Visual direction

**Idea: a quiet instrument.** A warm near-black field, one luminous line, small monospaced labels like the legend on a piece of lab equipment. Two colours carry meaning and are used for nothing else: **amber is the assistant's voice, mint is yours.** They appear in the visualiser, the caption, the chat speaker labels (a 2 px rule beside each message), the mic button's level ring and the Stop button. Everything else is ink on charcoal. No gradients on surfaces, no glass blur, no illustrations; restraint is the look.

- **Type**: IBM Plex Sans (400, 500, 600) for text and IBM Plex Mono (400, 500) for labels, numbers and the latency readout, self-hosted with `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` (no network at build or run time). Labels: mono, 11–12 px, upper case, `tracking-[0.08em]`. Body 15 px / 1.5. Captions 20 px (16 px on phones). Scale: 11 / 12 / 14 / 15 / 20 / 28.
- **Motion**: only the visualiser moves continuously. UI transitions are short and functional: 120 ms for controls, 240 ms for state changes (colour crossfades), 320 ms for panels, all `--ease-out`. Nothing bounces.
- **Theme**: dark by default; a light theme follows `prefers-color-scheme: light` by overriding the same CSS variables. No manual toggle in v1. (The research verified `@theme` tokens and `var()` overrides compile; the light rendering itself is **[verify]** visually.)

Tokens (`apps/web/src/app/globals.css`):

```css
@import "tailwindcss";
@import "@fontsource/ibm-plex-sans/400.css";
@import "@fontsource/ibm-plex-sans/500.css";
@import "@fontsource/ibm-plex-sans/600.css";
@import "@fontsource/ibm-plex-mono/400.css";
@import "@fontsource/ibm-plex-mono/500.css";

@theme {
  --color-bg: oklch(0.165 0.006 110);         /* warm near-black page */
  --color-surface: oklch(0.205 0.007 110);    /* panels, popovers */
  --color-surface-2: oklch(0.245 0.008 110);  /* inputs, hover */
  --color-line: oklch(0.32 0.008 110);        /* hairlines, borders */
  --color-ink: oklch(0.93 0.015 95);          /* main text */
  --color-ink-muted: oklch(0.70 0.014 95);    /* secondary text, unplayed clauses */
  --color-ink-faint: oklch(0.52 0.010 95);    /* idle line, disabled */
  --color-voice: oklch(0.80 0.140 75);        /* the assistant: amber */
  --color-voice-soft: oklch(0.80 0.140 75 / 0.16);
  --color-you: oklch(0.83 0.090 180);         /* the user: mint */
  --color-you-soft: oklch(0.83 0.090 180 / 0.16);
  --color-ok: oklch(0.78 0.110 150);
  --color-warn: oklch(0.80 0.120 55);
  --color-danger: oklch(0.70 0.170 28);

  --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", monospace;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --shadow-panel: 0 16px 48px -16px oklch(0 0 0 / 0.65);
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
}

@media (prefers-color-scheme: light) {
  :root {
    --color-bg: oklch(0.970 0.008 95);  --color-surface: oklch(0.995 0.004 95);  --color-surface-2: oklch(0.940 0.008 95);
    --color-line: oklch(0.870 0.010 95); --color-ink: oklch(0.220 0.010 110);    --color-ink-muted: oklch(0.450 0.012 110);
    --color-ink-faint: oklch(0.620 0.010 110);
    --color-voice: oklch(0.620 0.150 60); --color-voice-soft: oklch(0.620 0.150 60 / 0.14);
    --color-you: oklch(0.550 0.090 195);  --color-you-soft: oklch(0.550 0.090 195 / 0.14);
    --color-danger: oklch(0.550 0.190 28);
  }
}

body { background: var(--color-bg); color: var(--color-ink); font-family: var(--font-sans); }
```

The visualiser reads the colours from these variables once at start and on `prefers-color-scheme` change (`getComputedStyle(document.documentElement)`).

Components: buttons are 40 px (56 px round dock buttons on phones, 48 px on desktop), 1 px `line` border, `surface` fill; primary actions (Start) are a pill with a 1 px `voice` border and `voice` text. Focus ring: 2 px `--color-you`, 2 px offset, on every focusable element.

### 3.3 The visualiser

A `<canvas>` drawn on `requestAnimationFrame`, outside React. It reads a plain mutable object (`levels`, below) and the current visual state; React never re-renders per frame.

**Shape.** Three superimposed lines across the canvas width `W`, centred at `y0 = H/2`, sampled every 2 CSS px:

```
u = x / W                                   (0..1)
e(u) = sin(π·u)²                            (pins both ends to the centre line)
y_i(u, t) = y0 + A · a_i · e(u) · sin(2π·k_i·u + φ_i + ω_i·t)
k = [1.5, 2.5, 4.0]      φ = [0, 2.1, 4.2]
stroke width = [2, 1.5, 1] px    opacity = [1, 0.45, 0.25]
A = A_min + level · (0.38·H − A_min)
level: smoothed toward its target each frame: α = 1 − exp(−dt/τ), τ = 40 ms rising, 180 ms falling
```

Drawn with the device pixel ratio for crisp lines; per-frame work under 2 ms (one `Path2D` per line, preallocated arrays).

**States.** First matching row wins. *Owner* = this tab owns the audio.

| Visual state | Condition | Colour | Level (target) | `A_min` | `ω` (rad/s) | Weights `a` | Extra |
|---|---|---|---|---|---|---|---|
| disconnected | socket not open | `ink-faint` 50 % | 0 | 0 | 0 | — | Dashed (4 on, 6 off). Label "RECONNECTING · 3" |
| error | fatal client error (microphone failed, page out of date) | `danger` | 0 | 0 | 0 | — | Flat. Error card below (§3.8) |
| not started | not owner, no owner present | `ink-faint` 40 % | 0 | 0 | 0 | — | Start button below |
| speaking | owner: its player is playing. Observer: server state `speaking` | `voice` | owner: `sqrt(outRms · 5)`; observer: 0.35 + 0.15·noise(t) | 3 px | [2.0, 2.8, 3.9] | from output bands (below) | Glow: shadow blur 12 px, `voice` 40 % |
| thinking | server state `thinking` | `voice` 70 % | 0.08 | 4 px | [1.2, 1.6, 2.1] | [1, 0.5, 0.3] | Sweep: a highlight (linear gradient stroke, transparent → `voice` → transparent, σ = 8 % of width) travels left to right every 1.4 s |
| muted | owner, microphone off | `ink-faint` | 0 | 0 | 0 | — | Flat with a 48 px gap in the middle holding a mic-off icon (DOM overlay); label "MIC OFF" |
| hearing | server state `hearing` | `you` | owner: `sqrt(micRms · 9)`; observer: 0.3 + 0.15·noise(t) | 3 px | [2.4, 3.1, 4.2] | [1, 0.7, 0.5] | Glow 8 px, `you` 35 % |
| listening | server state `listening` | `you` 85 % | owner: `micRms · 4` | 2 px | [0.6, 0.9, 1.3] | [1, 0.6, 0.35] | Breathing: global opacity 0.75 ↔ 1 over 4 s |
| idle | otherwise (observer, nobody owns the audio) | `ink-faint` | 0 | 1 px | [0.3, 0.4, 0.5] | [1, 0.5, 0.3] | — |

- **Drivers**: microphone level comes from the 20 ms PCM frames the capture worklet already produces (RMS of each frame, on the main thread), so the line reacts to your voice with no network delay; in `listening` it already moves a little, in `hearing` fully. Output level and bands come from an `AnalyserNode` (fftSize 1024) on the player node, read once per frame: `outRms` from the time-domain data, band energies low 80–300 Hz, mid 300–1500 Hz, high 1500–4000 Hz, normalised to their sum and smoothed (τ 120 ms) into weights `a = [0.5 + 0.5·low, 0.3 + 0.7·mid, 0.2 + 0.8·high]`.
- **Transitions**: colour crossfades over 240 ms (draw the old and new colour with complementary alpha). On an interruption (`turn.end` interrupted, or local Stop), the falling time constant drops to 60 ms so the amber line collapses quickly, then mint takes over.
- **Label** under the line: mono 12 px upper case: `LISTENING`, `HEARING YOU`, `THINKING`, `SPEAKING · <voice>` (voice name shown when more than one voice is enabled), `MIC OFF`, `RECONNECTING · n`, `NOT CONNECTED`. It is an `aria-live="polite"` region (the only announcement of state changes).
- **Captions** (on by default; per-device toggle): under the label, centred, at most two lines. In `hearing`: the interim transcript in `you`. In `speaking`: the clause that is playing in `ink`, the next one in `ink-muted`. They fade out 2 s after the state ends.
- **Reduced motion** (`prefers-reduced-motion: reduce`): `ω = 0`, no breathing, no sweep, no glow; the amplitude still follows the level but is quantised to 4 steps and smoothed with τ = 150 ms, and colour changes are instant. The label carries the state.

### 3.4 Starting

The browser needs a user gesture for audio and asks permission for the microphone. The page loads, connects, and shows:

```
                ─────────────────────────────────────────── (flat line)
                                 NOT STARTED
                          ( START TALKING )                ← pill, voice-coloured border
      Uses your microphone. Speech is recognised on the assistant's machine; only text goes to the language model.
                               or type instead              ← opens the chat
```

Pressing Start runs, **synchronously in the click handler before any `await`**: `new AudioContext({ latencyHint: "interactive" })`, `ctx.resume()`; then awaits `getUserMedia` (microphone constraints from the research: mono, `echoCancellation`, `noiseSuppression`, `autoGainControl` all on), loads the two worklets, builds the graph, and sends `audio.claim`. The button shows "Allow the microphone…" meanwhile. On success the visual goes to `listening` and a one-time hint says "Speak any time. M mutes, Esc stops a reply." Errors (denied, no microphone, busy) show the research's `describeMicError` text in an error card with "Try again"; a denial is never retried automatically.

If another tab owns the audio, the same place shows "Audio is on another tab or device" and **Use this tab** (also a gesture, same steps).

Secure context: the microphone only works on `https://` or `http://localhost`. Since the assistant's machine has no sound card, the browser will normally run on another device, so the page must reach it over HTTPS or through an SSH tunnel (§4.6, open question 1). The UI checks `window.isSecureContext` and, if false, replaces the Start button with an explanation instead of failing at `getUserMedia`.

### 3.5 Controls and keyboard

Dock (centred at the bottom; visible once the tab owns the audio, chat button always):

| Control | Behaviour | Key |
|---|---|---|
| Microphone (toggle, `aria-pressed`) | Mute / unmute (`mic.state`). While live, a mint ring around it follows the microphone level | `M` |
| Stop (■) | Enabled while `thinking` or `speaking`: flush the local player, send `interrupt`. Otherwise shown disabled | `Esc` |
| Chat (💬) | Open / close the chat; a dot when there are unread replies | `C` |
| End (top bar, text button) | Release the audio (`audio.release`), stop the microphone, close the `AudioContext`; back to "not started" | — |
| Options (⚙, top bar) | Open the options drawer | `O` |
| — | Focus the chat input (opens the chat) | `/` |
| — | Show keyboard shortcuts | `?` |

Single-key shortcuts are ignored while focus is in a text field. `Esc` first closes the topmost open panel if focus is inside it; otherwise it stops the reply.

### 3.6 Chat panel

- **Header**: "CONVERSATION" label and a close button.
- **Messages**, oldest first, as a transcript rather than bubbles:
  - *User*: label `YOU` (mono, `you`) and the text; a small keyboard glyph marks typed messages. 2 px `you` rule on the left.
  - *Assistant*: label `ASSISTANT` (plus `· <voice>` when it is not the default voice), and on the right the turn's latency (`642 ms`, mono, `ink-muted`; click shows the trace, §3.9). 2 px `voice` rule. The text is rendered clause by clause: a clause is `ink-muted` until it starts playing (`assistant.playing`), then `ink`, so the text fills in as it is spoken. Unspoken turns stream deltas in `ink`.
  - *Interrupted reply*: clauses that never played stay `ink-muted` at 60 % opacity, followed by an `INTERRUPTED` tag. The history the model keeps has only the played part; the UI shows both so the owner sees what was cut.
  - *Tool activity*, above the text it belongs to: a chip `⟳ weather · Paris` while running, then `✓ weather · 241 ms` or `✕ weather · Weather service did not answer within 3000 ms` (`danger`). Clicking a chip shows the input JSON.
  - *Live transcript*: the last row, italic, `you`, replaced on every `transcript`; removed on `turn.start` or `transcript ""`.
  - *Turn errors* (`error` with a `turnId`): one `danger` line under that turn.
- **Scrolling**: sticks to the bottom unless the user has scrolled up; then a "Jump to latest" pill appears.
- **Composer**: auto-growing textarea (1–6 lines), Enter sends, Shift+Enter is a new line, placeholder "Type a message". A speaker toggle "Speak replies" (owner only; remembered per device; default on). Disabled with an explanation while disconnected or while the engine is not ready.
- **Unread**: replies that arrive while the chat is closed set the dot on the chat button.

### 3.7 Options

A drawer with four tabs. Everything in the first two is rendered from server data.

1. **Modules**: one card per `ModuleInfo`, in catalog order. Collapsed: switch (intent; sends `module.enable` / `module.disable`, shows a spinner until the `result`), name, one-line description, and either the status line (tone dot + text) or a state badge (`STARTING`, `ERROR`). Expanded: the error (danger box, with **Retry** = enable), the generated settings form, and the module's tools (name, description, a `READ-ONLY` chip for speculative tools).
2. **Assistant**: the engines in use (read-only list from `EngineStatus.engines` and voices: provider, model, local/hosted), then one form per `SettingsSection`. Fields with `apply: "reload"` carry the note "Applies after reloading the engines (about 2 s; interrupts a reply)". While `reloadPending`, a bar at the top says "Saved changes need an engine reload" with **Reload now** (`engine.reload`). Engine problems (`EngineStatus.problems`) are listed here too.
3. **This device** (stored in `localStorage`, not on the server): microphone (`enumerateDevices` after permission; "Default"), speaker (only if `AudioContext.setSinkId` exists), **Interrupting** as a three-way segmented control: *Headphones: instant* / *Speakers: say a few words* (default) / *Tap Stop to interrupt* (sends `audio.config`), the echo test (§5), and under "Advanced": output path (*Direct* / *Through a media element*), prebuffer (20–200 ms, default 60), captions, latency readout.
4. **About**: protocol and server version, connection id, keyboard shortcuts.

**Generated forms** (`SettingsForm` → one renderer per field type):

| Field type | Renderer |
|---|---|
| `text` | Input (textarea if `multiline`), `placeholder`, character counter near `maxLength` |
| `secret` | "Set (saved here)" / "Set by `ENV` in the environment" / "Not set"; **Replace** opens a password input; **Remove** sends `null`. Never pre-filled |
| `number` | Number input with `min`/`max`/`step` (step 1 if `integer`) and the `unit` after it |
| `boolean` | Switch |
| `choice` | Segmented control for ≤ 4 options, select otherwise; the selected option's description below |
| `multichoice` | Checkbox list with descriptions |
| any, `locked` | Value shown read-only with a lock icon and the reason |
| any, `advanced` | Inside an "Advanced" disclosure |

Errors from `form.errors` and from a failed `result` (`fieldErrors`) show under their fields (`key: null` at the top of the form). **Save** is enabled when the form is dirty and sends a patch with only the changed fields; **Cancel** reverts. When a `module.changed` / `section.changed` with a higher revision arrives while the form is dirty, local edits are kept and a line says "Changed in another tab · Load latest"; if not dirty, the form updates silently.

### 3.8 Connection and error states

| State | Shown |
|---|---|
| Connecting (first time) | Dashed line, "CONNECTING". After 3 s: "Is the assistant running? Start it with `pnpm start serve`." |
| Reconnecting | Top-bar status "Reconnecting (3)…", dashed line; dock and composer disabled; chat content kept; the player has been flushed, the microphone stays open but nothing is sent |
| Page out of date (close 4400) | Full-stage message "This page is older than the assistant." + **Reload**; no more retries |
| Engine failed or reloading | A bar at the top of the stage: "The assistant can't listen right now: speech-to-text (STT_PROVIDER): DEEPGRAM_API_KEY is not set" + **Open options**. While reloading: "Reloading engines…" |
| Microphone error | Error card on the stage with the message and **Try again** |
| `AudioContext` suspended (phone locked, background) | "Tap to resume audio" button over the stage; also tries `resume()` on `visibilitychange` |
| Not a secure context | Start replaced by: "The microphone needs HTTPS or localhost. Open this page through an SSH tunnel or an HTTPS address." |
| Transient `error` messages | Toast above the dock, 6 s, at most 3 stacked; ones with a `turnId` also appear in the chat |

### 3.9 Latency readout

Top right, mono: `↯ 642 ms`. The number is the last spoken turn's **first sound**: `trace.marks.playbackStart + trace.client.outputLatencyMs` (end of turn → audible; for text turns, `llmFirstToken`, labelled `first token`). Colour `ink-muted`; `warn` at ≥ 800 ms (the project's target); `danger` at ≥ 1500 ms. Clicking opens a popover with the last 10 traces as a small table (turn, speculative, first token, TTS first audio, playback start, audible, tools, voice, outcome) and the median of those 10. Hidden by a per-device toggle.

The trace starts at end of turn, as in the CLI. Not included: the browser's capture latency and the 20 ms framing before the audio reaches the server, and the time the STT waits for silence. The readout says "from the moment the assistant decided you had finished".

### 3.10 Accessibility and responsiveness

- Every control is a `<button>` with a text label (`aria-label` for icon buttons) and visible focus. Panels are dialogs (`role="dialog"`, labelled, focus moved in and trapped, restored on close).
- Announcements: the state label (polite), and the final text of each assistant turn through a visually hidden polite region (not every clause).
- Contrast: body text ≥ 7:1 on `bg`; `ink-muted` ≥ 4.5:1; amber and mint lines are not the only state cue (the label always says it).
- Reduced motion: §3.3; panels appear without sliding.
- Breakpoints: < 640 phone layout (bottom-sheet chat, full-screen options, 56 px controls, 160 px visualiser); 640–1023 tablet (right sheets); ≥ 1024 desktop. Use `dvh` units; no horizontal scrolling at 320 px wide. Ask for a screen wake lock while the tab owns the audio (re-request on `visibilitychange`).

### 3.11 Front-end structure

```
apps/web/
  next.config.ts            output: "export", transpilePackages: ["@pva/protocol"], turbopack Tailwind rule
  worklets/                 sources: resampler.js, capture.js, player.js (ES modules, unit-tested)
  scripts/build-worklets.mjs  concatenates them into public/worklets/{capture,player}.js (predev/prebuild)
  public/worklets/          generated, plain JS, loaded with audioWorklet.addModule("/worklets/…")
  src/app/                  layout.tsx, page.tsx (server component rendering <App/>), globals.css
  src/lib/
    store.ts                createStore, useStoreSelector(selector, isEqual)
    state.ts                ClientState, initial state, reducer(state, ServerMessage | LocalAction): pure, tested
    connection.ts           the Effect connection program (below); send(), request()
    audio/VoiceAudio.ts     AudioContext, capture and player graphs, devices, analysers (from the research)
    audio/levels.ts         the mutable levels object written by audio, read by the visualiser
    prefs.ts                per-device preferences (localStorage)
  src/components/           App, TopBar, LatencyReadout, Stage, Visualiser, StateLabel, Captions, StartPrompt,
                            ObserverBanner, EngineBanner, ControlDock, ChatPanel, MessageList, AssistantMessage,
                            ToolChip, Composer, OptionsDrawer, ModulesTab, ModuleCard, AssistantTab, DeviceTab,
                            AboutTab, SettingsForm, fields/{Text,Secret,Number,Boolean,Choice,MultiChoice}Field,
                            StatusLine, Toasts, ShortcutsDialog
  src/ui/registry.ts        option tabs, stage overlays, field renderers (see §3.12)
  mock/server.ts            scripted mock assistant (§6)
  e2e/                      Playwright tests
```

**Client state** (one store; selectors keep re-renders local):

```ts
interface ClientState {
  readonly connection: { status: "connecting" | "open" | "reconnecting" | "outdated"; attempt: number; connectionId?: string }
  readonly session: { role: "owner" | "observer"; ownerPresent: boolean; serverState: AssistantState; stateTurnId?: number }
  readonly audio: { phase: "off" | "starting" | "running" | "suspended" | "error"; micLive: boolean; error?: string
                    playing?: { turnId: number } }                              // from the local player
  readonly engine: EngineStatus
  readonly modules: { readonly order: ReadonlyArray<string>; readonly byId: Readonly<Record<string, ModuleInfo>> }
  readonly sections: ReadonlyArray<SettingsSection>
  readonly turns: ReadonlyArray<TurnView>        // history items converted to TurnViews, then live turns; capped at 300
  readonly liveTranscript: string
  readonly traces: ReadonlyArray<TraceInfo>      // last 50
  readonly pending: Readonly<Record<string, { readonly kind: string; readonly target?: string }>>   // by requestId
  readonly toasts: ReadonlyArray<{ id: number; message: string; tone: "error" | "info" }>
  readonly ui: { chatOpen: boolean; optionsOpen: boolean; optionsTab: string; unread: number }
}
interface TurnView {
  readonly key: string                           // `t${turnId}` or `h${index}` for history
  readonly turnId?: number; readonly source: "voice" | "text"; readonly userText: string; readonly spoken: boolean
  readonly clauses: ReadonlyArray<{ readonly text: string; readonly voice?: string }>  // spoken turns
  readonly text: string                          // unspoken turns (and history)
  readonly playedClause: number                  // -1 = nothing played yet
  readonly tools: ReadonlyArray<{ callId: string; tool: string; input: unknown; status: "running" | "ok" | "error"; ms?: number; error?: string }>
  readonly outcome?: "completed" | "interrupted" | "failed"; readonly trace?: TraceInfo; readonly error?: string
}
```

The reducer is pure and covers every `ServerMessage` type (TypeScript exhaustiveness over `ServerMessage["type"]`); `welcome` replaces everything except `ui`. Reply audio never goes through the store.

**Connection layer** (`connection.ts`, Effect, framework-free; it only sees `dispatch` and the audio engine):

- Wrap the **native `WebSocket`** in `Effect.acquireRelease` (`binaryType = "arraybuffer"`). Not `effect/socket`: it does not expose `bufferedAmount`, which the microphone path needs, and the raw socket keeps binary sends zero-copy.
- One attempt: open → send `hello` → wait for `welcome` (5 s) → `dispatch` → run concurrently: the reader (a `Queue` fed by `onmessage`: text → `decodeServerMessage` → `Ok`: `dispatch`, plus `reply.*` to the audio engine; `Unknown`: count; `Invalid`: `console.warn`; binary → `decodeReplyFrame` → transfer the buffer to the player), the writer (a `Queue<ClientMessage>` → `encodeClientMessage` → `send`), the pinger (5 s, dead after 10 s without `pong`). The attempt fails when the socket closes.
- Around it: `Effect.retry` with `Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("5 seconds")])` (verified in the research), not retrying after close code 4400. A reconnecting page never sends `audio.claim` by itself; it sets `resumeOwner: true` in `hello` if it owned the audio and its graph is still running. If the `welcome` makes it the owner again, it immediately sends `audio.config` and `mic.state` with its current values (the server assumes a live microphone on resume).
- `request(message)`: assigns a `requestId`, resolves when the matching `result` arrives (10 s timeout → a local error). `send(message)`: fire and forget.
- Microphone frames bypass the queue: the capture callback calls `sendMic(buffer)`, which writes the header and sends only if this tab is the owner, the socket is open, the microphone is live, and `bufferedAmount < 16 000`; otherwise the frame is dropped.
- Started with `Effect.runFork` from a `useEffect` in `App`; interrupted on unmount (StrictMode-safe, as verified in the research).

### 3.12 Front-end modularity

- **Server data drives the UI**: modules, settings, voices, engines, sections and status lines are rendered generically. A new module, setting, section or voice on the server appears with no front-end change.
- **Field renderers** are a `Record<SettingFieldType, Component>`; the type makes a missing renderer a compile error when the protocol gains a field type.
- **Option tabs and stage overlays** are arrays in `src/ui/registry.ts` (`{ id, title, component, when?: (state) => boolean }`). A new panel = one component file + one line there.
- **Module-contributed elements** are data with a generic renderer (`StatusLine`). The deferred cards (§1.9) would add one renderer per data kind to a `displayRenderers` record.

---

## 4. Server side

### 4.1 Structure of `serve` mode

```
apps/assistant/src/serve/
  serveMode.ts      entry: load settings, start HTTP, module host, engine; wire everything; shutdown
  http.ts           node:http(s) server: static files from apps/web/out, upgrade on /ws (ws library), origin check
  SessionHub.ts     connections, hello/welcome, roles and ownership, request routing, broadcast, send limits
  Publisher.ts      ConversationEvent → ServerMessage; speculative buffering; voice per clause; history and trace mapping
  StateTracker.ts   the assistant state (§2.4)
  Engine.ts         reloadable scope: providers (voices → router), Conversation, voice loop; engine status
  SettingsStore.ts  data/settings.json + data/secrets.json; ConfigProvider overlay for sections
  sections.ts       the assistant settings sections for the providers in use
packages/audio-web/   WebAudioInput / WebAudioOutput over an abstract link (no ws dependency; unit-testable)
packages/core/        additive changes (§4.3) + ModuleHost.ts + EchoGate.ts
```

`pnpm start serve` runs it; settings: `SERVE_HOST` (default `127.0.0.1`), `SERVE_PORT` (8787), `SERVE_ALLOWED_ORIGINS`, `SERVE_ALLOWED_HOSTS`, `SERVE_TLS_CERT` + `SERVE_TLS_KEY` (PEM paths; when both are set the server speaks HTTPS/WSS on the same port), `PVA_WEB_DIR` (default `<repo>/apps/web/out`), `PVA_DATA_DIR`.

Startup order: HTTP first (so the UI loads and shows "starting"), then in parallel the module host and the engine build. The engine runs the voice loop over `AudioInput` from the web backend; when nobody owns the audio, that input is the noise floor.

### 4.2 The web audio backend (`packages/audio-web`)

**`WebAudioInput.stream`**: a continuous, real-time 16 kHz stream, so every STT adapter sees exactly what it sees with a real microphone today:
- owner present, microphone live (and not inside a `manual`-mode audible window, §5): the owner's microphone frames (header stripped, a view).
- otherwise: generated noise at −75 dBFS in 20 ms chunks on a timer (the file backend's noise floor; reuse it). The switch happens on `audio.claim`, `mic.state`, owner loss and the audible window edges. When microphone frames stop without a state change (a stall), the stream simply waits; the server does not invent audio.

**`WebAudioOutput`**: implements `play(audio, sampleRate, observer)` as in §2.6, and declares `reportsPlayback: true`. It reads the turn id from `CurrentTurnTrace` (which `Conversation` now provides around `play`). It never paces: chunks go out as fast as TTS produces them.

### 4.3 Changes to existing interfaces (all additive)

| Where | Change | Why |
|---|---|---|
| `AudioOutput` (`Services.ts`) | Optional `reportsPlayback?: boolean`; `play(audio, sampleRate, observer?: PlaybackObserver)` | Browser playback is not pull-paced, so "chunk pulled" ≠ "heard". Existing backends are unaffected (optional members) |
| `Conversation` | With `reportsPlayback`, record each clause's start offset in samples as chunks are pulled; on `observer.progress(n)` count clauses with start offset < n as played; mark `playbackStart` on `observer.started()` instead of on the first pull | History must record what the user heard (the requirement); `playbackStart` becomes the real start |
| `Conversation` | Provide `CurrentTurnTrace` around `output.play` (today only around `synthesize`) | The web output needs the turn id (reply id) and records `trace.client` |
| `ConversationOptions` | `onEvent?: (event: ConversationEvent) => void` | The UI needs turns, clauses, playback, tools and outcomes as they happen; a synchronous callback adds no Effect per event on the hot path |
| `ConversationOptions` | `setup?: Effect<TurnSetup>`, evaluated once at the start of each turn (voice and text), replacing `systemPrompt` + the construction-time `ToolRegistry` when present | Live module and prompt changes with a per-turn snapshot |
| `ConversationOptions` | `initialHistory?: ReadonlyArray<Message>` | Engine reload keeps the conversation |
| `Conversation.voice` | Accept `Stream<ConversationInput, E>` (`SttEvent` plus `TextInput` and `Interrupt`) | Typed messages and the Stop button go through the same turn logic, one turn at a time, with barge-in and history unchanged |
| `Trace` (`TurnTrace.ts`) | Optional `client?: { outputLatencyMs: number; startDelayMs: number }`; `formatTrace` prints `audible=+N ms` when present | Browser numbers in the trace and the UI |
| `VoiceRouterOptions` | Optional `sampleRate?: number` (default: the default voice's rate) | `DEFAULT_VOICE` can change live without changing the output rate mid-session |
| `core` (new) | `ModuleHost.ts`, `EchoGate.ts` | §1.4, §5 |
| `apps/assistant` | `modules.ts` becomes `moduleCatalog: ReadonlyArray<ModuleDefinition>`; all modes start modules through the host; `main.ts` gains `serve` | One catalog for every mode |
| `modules-builtin` | `clock` and `weather` rewritten with `defineModule` (§1.3) | |
| `llm-anthropic` | **[verify]** If the request has no tools but the history contains tool calls (every module disabled after a tool was used), the API is believed to reject it ("requests which include tool_use or tool_result blocks must define tools"). If confirmed, convert past tool calls and results to plain text in that case | Disabling modules must never break the conversation |
| Root | `tsconfig.json` excludes `apps/web`; `check` also runs the web check; `vitest.config.ts` uses projects (node + `apps/web` with jsdom); `dev` script runs both processes | From the web-stack research |
| `.env.example` | Comment out lines that only restate defaults (§1.6) | Otherwise they lock UI fields |

Unchanged: `Stt`, `Tts`, `Llm`, `AudioInput`, `ToolRegistry`'s interface (the host builds snapshots with the existing `makeToolRegistry`), `Message`, `SttEvent`.

Serve mode always runs `Conversation` with `bargeIn: true`; the interrupt modes are implemented by the echo gate (§5).

### 4.4 Publishing events without slowing the audio path

- `Conversation.onEvent` calls `Publisher.onEvent` synchronously. The publisher maps the event, serialises it once (`encodeServerMessage`) and calls `ws.send` on each connection (Node buffers it; a few microseconds). No queue hop, no Effect per event. It never throws (wrapped).
- Reply audio does not go through the publisher: `WebAudioOutput` writes frames straight to the owner's socket.
- A slow connection cannot slow the conversation: its send buffer is bounded (§2.1) and it is dropped when over.
- **Speculative turns**: the publisher buffers a pending turn's events, emits `turn.start` plus the buffer on `TurnPromoted`, and drops the buffer if the turn ends `discarded`. A speculative turn never appears in any UI.
- **Voice per clause**: the publisher strips the marker from each clause with `parseVoiceMarker` and tracks the voice (a marker switches, unknown names fall back to the default voice, every turn starts in the default voice), as the router does.
- **History projection** (`welcome`): one `user` item per user message; one `assistant` item per turn joining its assistant texts (markers stripped), with `interrupted` if any part was interrupted, and its tool calls with `ok = !isError`.
- **Trace mapping**: marks relative to `endOfTurn` (`formatTrace`'s convention), `totalMs = endedAt − endOfTurn`, `client` copied.
- **Transcript and state**: the gated STT stream is tapped (`Interim` → `transcript`; `EndOfTurn` or echo drop → `transcript ""`) and fed to the `StateTracker` together with conversation events, ownership, microphone state and playback reports. The tracker emits `state` only when the state changes.

### 4.5 Module host and engine

- The **module host** lives for the whole process (outside the engine scope) and exposes `setup: Effect<TurnSetup>` (reads the current snapshot: a reference read, no work per turn) and `modules: ReadonlyArray<ModuleInfo>` plus a change callback for the publisher. The snapshot's `system` is rebuilt when modules, `SYSTEM_PROMPT`, `DEFAULT_VOICE` or the enabled voices change.
- The **engine** is a scope built from the saved settings (through the `ConfigProvider` overlay) with `buildProviders` as today, so missing keys produce the same per-stage problems; in serve mode a failure becomes `EngineStatus.state = "failed"` instead of exiting.
- `DEFAULT_VOICE` live: the engine holds a `Tts` façade whose `sampleRate` is fixed at build time and whose `synthesize` delegates to the current router (rebuilt, cheaply, when the default voice changes; engines are not touched).

### 4.6 HTTP, static files, security

- GET/HEAD only. `/` → `index.html`; `/x` → `x.html` if it exists; files under `PVA_WEB_DIR` with a path-traversal guard. `/_next/static/*`: `Cache-Control: public, max-age=31536000, immutable`; everything else `no-cache`. Content types for html, js, css, json, svg, png, ico, woff2, txt. If the directory is missing: HTTP 503 with a one-line page "UI not built: run `pnpm --filter @pva/web build`".
- Cross-origin isolation (`SERVE_CROSS_ORIGIN_ISOLATION`, default on): every static response, error pages included, carries `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`. Only the document's own COOP and COEP are required for `crossOriginIsolated`; same-origin subresources need no header under `require-corp`, and worklets take the document's policy. Sending them everywhere covers every path the page can be loaded at and any future dedicated worker (which needs its own COEP).
- Binds to `127.0.0.1` by default. Binding elsewhere prints a warning: there is no login in v1, and anyone who can reach the port can use the assistant and change its settings.
- **Reaching it from another device** (needed: the assistant's machine has no sound card): the microphone needs a secure context. Supported routes, simplest first: (1) an SSH tunnel from the laptop (`ssh -L 8787:localhost:8787 <host>`, then `http://localhost:8787`: a secure context, no certificate); (2) `SERVE_TLS_CERT`/`SERVE_TLS_KEY` with a certificate the device trusts (own CA, or a real hostname with a DNS-01 certificate); (3) a reverse proxy (Caddy, Tailscale serve) in front of the default loopback binding. A phone needs (2) or (3).

---

## 5. Echo and barge-in

**What is known.** The research found that Chrome's echo canceller historically used only WebRTC peer-connection audio as its reference, not Web Audio output; it found no current source either way, and nothing was tested. On iOS 27, echo cancellation crackles with any playback. So the design must work whether or not the browser cancels the assistant's voice.

**Recommended approach: three layers.**

1. **Browser echo cancellation on**: `echoCancellation`, `noiseSuppression`, `autoGainControl` all requested. If the browser does cancel, everything else is a no-op. The output path is switchable per device: *direct* (`AudioContext.destination`, default) or *through a media element* (`MediaStreamAudioDestinationNode` → `<audio>`), the older workaround reported to make Chrome cancel Web Audio output. **[verify]** both on the owner's real device with the echo test.
2. **Server echo gate** (`packages/core/src/EchoGate.ts`, pure, between the STT stream and `Conversation`). It knows the *audible window* (from `playback.started` to `playback.finished`/`stopped`, plus a 300 ms tail for room reverb) and the words of the clauses that played in the last 5 s (from `ClausePlaying` events). Per interrupt mode of the current owner:

   | Mode | During the audible window |
   |---|---|
   | `instant` | Pass everything through (today's barge-in: `SpeechStarted` interrupts) |
   | `confirm` (default) | Hold `SpeechStarted`. On `Interim`: take its last ≤ 6 words; if they are ≥ 2 words and fewer than 60 % of them occur in the recently played words, it is the user: release the held `SpeechStarted` (the turn is interrupted), then the `Interim`. Otherwise it is echo: drop it. `EagerEndOfTurn` / `EndOfTurn` whose text is echo by the same test are dropped (and `transcript ""` clears the UI); non-echo ones pass. When the window closes, a still-held `SpeechStarted` is dropped |
   | `manual` | Drop all STT events, and the web input feeds the noise floor instead of the microphone (nothing can be heard while the assistant speaks); only Stop interrupts |

   Outside the window every mode passes everything through. The thresholds are named constants with tests (echo of a played clause is dropped; a different sentence interrupts; one-word "stop" does not interrupt in `confirm`, which is the known cost).
3. **Per-device choice and a test.** Options → This device → Interrupting (§3.7). The **echo test** plays a 3 s synthetic speech-like signal (a chirp train with a speech envelope, generated in the browser) through the normal player and compares the microphone RMS during playback with 1 s of silence before it. Residual within 6 dB of the silence level: "Echo is cancelled: you can use *Headphones: instant* even on speakers." Otherwise: "Echo is not cancelled: keep *Speakers*, or try *Through a media element* and test again." The result is stored per device and shown next to the control.

Barge-in in `confirm` mode costs time: the interruption happens when the recogniser has two words, typically 400–700 ms after you start speaking, instead of at `SpeechStarted`. Once decided, sound stops within the stop latency of §2.6. With headphones, `instant` gives today's behaviour.

If echo cancellation proves unusable on the owner's devices even with the media-element path, the escape hatch from the research is WebRTC for reply audio (browsers use WebRTC remote audio as the echo reference): out of scope for v1.

---

## 6. Build plan

Two packages of work in parallel, against `packages/protocol` (done) and `@pva/protocol/examples`. Neither needs the other until integration. Each must keep `pnpm check` and `pnpm test` green.

### 6.1 Server (S)

Deliver:
1. Core changes of §4.3, each with tests in `Conversation.test.ts` style (fakes + `TestClock`): played clauses from observer progress (including an interruption between two clauses and a failure after a disconnect), `playbackStart` from `started`, events in order for a voice turn, a tool turn, a speculative promote and a discard, `TextInput` spoken and unspoken, `Interrupt`, per-turn `setup` snapshot (a change mid-turn does not affect it), `initialHistory`, router `sampleRate`.
2. `ModuleHost` with tests for every row of §1.4 (fake persistence, fake modules: slow start, failing start, tool name clash, reconfigure while a tool runs, grace period, context timeout).
3. `EchoGate` with tests (§5).
4. Migrated `clock` and `weather` (§1.3); the existing weather tests keep passing.
5. `packages/audio-web` with tests: frame routing, noise floor switching, `play` per §2.6 (finished, stopped, stall → timeout, owner lost, chunk splitting).
6. `serve` mode (§4): settings store (atomic writes, 0600 secrets, corrupt file handling), sections, publisher, state tracker, session hub, HTTP/static, engine reload.
7. `.env.example`, README (serve mode, reaching it from another device), `docs/ARCHITECTURE.md` updated for the interface changes.

Test without the front end: a **scripted client** (`apps/assistant/test/support/scriptedClient.ts`, Node, `ws` + `@pva/protocol`): connects, sends `hello`, claims, streams 16 kHz PCM (from a WAV, in real time or as fast as allowed), simulates a player (counts received reply samples, reports `started` / `progress` every 250 ms by wall clock / `finished`), can press Stop, drop the socket mid-reply, open a second connection and take over, and records every message. Server tests build serve mode with injected layers: scripted `Stt` from `@pva/core/testing` for deterministic turns, `FakeLlm`, a tone `Tts`, a temp `PVA_DATA_DIR`. Cover: handshake and version mismatch, a voice turn's message sequence (compare to §2.5), barge-in and history, Stop from an observer, typed messages, module enable/configure/disable broadcast to two clients, takeover, reconnect with `resumeOwner`, playback stall, origin rejection. One live test with the local sherpa models (skipped when absent), like `localEndToEnd.test.ts`.

### 6.2 Front end (F)

Deliver:
1. `apps/web` set up as verified in `docs/research/web-stack.md` (versions, `next.config.ts`, `tsconfig.json`, Tailwind 4 tokens of §3.2, vitest projects, root `tsconfig` exclude, root `check`/`test` include the web app). `output: "export"`.
2. Store, reducer and connection layer (§3.11), with reducer tests driven by `@pva/protocol/examples` and scripted message sequences (a voice turn, an interrupted turn, a tab joining mid-turn, a module change with a dirty form, reconnect).
3. Worklets from sources in `apps/web/worklets/` with **unit tests** (Node, a minimal `AudioWorkletProcessor`/`registerProcessor` shim): resampler (1 kHz sine through 48→16 kHz, 22.05→48 kHz and 24→48 kHz: amplitude within 1 dB, no discontinuity at chunk boundaries, output count within ±1 of `n·ratio`), capture framing (exactly 320 samples per frame, sequence of frames for a 128-sample quantum input), player (`started` once, `finished` after `end`, `stopped` with the right played count, stale ids dropped, underrun re-buffering, progress every 250 ms).
4. All components of §3, generated forms for every field type, keyboard, reduced motion, responsive layouts.
5. The **mock assistant** `apps/web/mock/server.ts` (tsx, `ws` on 8787 `/ws`): speaks the protocol from `@pva/protocol/examples`, runs scenarios chosen by `MOCK_SCENARIO` or `POST /mock/scenario`: `voice` (after a claim: listening → hearing with interim transcripts → turn with a tool and three clauses → reply audio as an amplitude-modulated tone at 22 050 Hz with correct framing, honouring playback reports and `reply.stop`), `typed`, `modules` (every field type; `invalid_settings` for a chosen value; a module that fails to start), `engine-failed`, `drop-mid-reply`, `takeover`, `outdated` (close 4400). `pnpm --filter @pva/web dev:mock` runs Next plus the mock.
6. Playwright tests against the mock in headless Chromium with the fake microphone flags (verified to work on this machine): start flow, visual states via a `data-visual-state` attribute on the stage, chat rendering of a spoken and an interrupted reply, Stop, options forms, reconnect banner, outdated page, keyboard shortcuts, phone viewport.

### 6.3 Integration on the development machine (no sound card)

1. `pnpm --filter @pva/web build`, then `LLM_PROVIDER=fake pnpm start serve` (local STT and Piper).
2. Playwright, headless Chromium, `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>` with a 48 kHz WAV made from a `bench-audio` question followed by 10 s of silence: open `http://localhost:8787`, Start, assert `listening → hearing → thinking → speaking → listening`, the transcript, the clauses in the chat, `turn.end` `completed` with `playbackStart` in the trace, and the latency readout. **[verify]** that headless Chromium renders the player worklet without a sound card (the research saw the capture graph pulled through the destination, not playback): assert `playback.started` and `playback.finished` arrive.
3. Barge-in, `instant` mode: a WAV with a question, 1.6 s of silence (the reply is playing by then), a second sentence, then silence: assert `turn.end` `interrupted`, history holding only played clauses, and the second turn answered. Repeat in `confirm` mode.
4. Two pages: the second is an observer; "Use this tab" moves the audio; the first shows the observer banner.
5. Kill the server mid-reply: the page shows reconnecting, flushes playback; restart: ownership resumes.
6. Latency: 10 turns with `BENCH_LLM_FIRST_TOKEN_MS=300`, collect `turn.end` traces, report median and worst of `playbackStart` and audible, and compare with the CLI figure (729 ms median) in the README. Expected extra: the browser prebuffer (normally 0, the first clause arrives whole), the network (~1 ms) and `outputLatency`.
7. On the owner's real device (manual): the echo test on speakers with both output paths, barge-in in each mode, a phone over HTTPS. Record the results in the README's "What has been verified".

---

## 7. Deliberately left out of this version

- Login, multiple users, access from the internet. (Loopback by default; LAN access through a tunnel or TLS.)
- Starting a new conversation from the UI ("clear history"), editing or deleting messages, conversation persistence across restarts.
- Module cards and other rich module output (§1.9), module-contributed UI code, hot-loading modules.
- Live turn-detection thresholds; per-voice provider settings in the UI; a manual light/dark toggle.
- WebRTC audio, Opus compression, wake word, push-to-talk on a held key.
- A service worker / offline support; installable PWA.
- Firefox and Safari testing beyond "it should work": only Chromium is tested automatically.

## 8. Open questions for the owner (with the default used if unanswered)

1. **Which device and browser will be the microphone and speaker?** The assistant's machine has no sound card, so it is another device, which needs HTTPS or an SSH tunnel. *Default: a laptop on the same network through an SSH tunnel; TLS options are built in for a phone later.*
2. **Headphones or open speakers?** *Default: speakers, interrupt mode `confirm`; switch to `instant` per device if the echo test passes or with headphones.*
3. **Should anyone else on the network be able to use it?** *Default: no; loopback binding, no login.*
4. **Is storing API keys entered in the UI in `data/secrets.json` (0600) acceptable?** *Default: yes; environment variables still win.*
5. **Should the third module actually be built (Home Assistant), or another source?** *Default: not built in this stage; it stays a sketch proving the design.*
6. **Fonts**: IBM Plex Sans/Mono, self-hosted. *Default: yes.*
