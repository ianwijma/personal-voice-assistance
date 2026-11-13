# Browser audio for the voice assistant web client

Research date: 2026-11-13. Scope: a Next.js page that is the microphone and speaker for the server assistant, over one WebSocket.

## What was and was not verified (read this first)

- **Nothing in this file was executed or type-checked.** The sandbox's temp volume hit its disk quota (`EDQUOT`) before any command ran, so Bash was unusable for the whole session. There is no scratch spike directory and no headless-browser test. Every code block is hand-written and unrun. Treat the DSP code (resampler, ring/queue, fade) as needing the unit tests listed in "Next steps".
- Web research was done with search and page fetches. The MDN pages fetched were summarised by a small model and **did not include the per-browser compatibility tables**, so per-browser version claims are mostly *not* confirmed from a table. Items are tagged:
  - **[src]** stated by a fetched source (URL in the section).
  - **[mem]** from my background knowledge, not re-confirmed today.
  - **[unverified]** a guess or something I could not find a source for. Measure before relying on it.
- Most echo-cancellation sources are 2018–2023 (Chromium 687574 era). I found no 2025–2026 source stating the current Chrome behaviour for Web Audio output, so section 3 is a test plan plus a defensive design, not a settled answer.

## Recommended design (summary)

1. **One long-lived `AudioContext` at the device's native rate** (`new AudioContext({ latencyHint: "interactive" })`, no `sampleRate`), created and resumed inside the "Start" click. Read `ctx.sampleRate` afterwards; do not assume 48000 (Bluetooth headsets, RFP in Firefox, 44.1 kHz devices).
2. **Capture:** `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })` → `MediaStreamAudioSourceNode` → capture `AudioWorkletNode` that **resamples to 16 kHz in the worklet** (windowed-sinc, ~1 ms delay), frames 320 samples (20 ms), converts to s16le, and **transfers** each frame's `ArrayBuffer` to the main thread, which calls `ws.send(buf)` unchanged. Do not create the context at 16 kHz (Firefox cannot connect a mic stream at a different rate; iOS had a 16 kHz sample-shortfall bug).
3. **Playback:** one `AudioWorkletNode` per page that keeps a queue of Float32 chunks at context rate. The server announces `{type:"reply.start", id, rate}`; the worklet resamples each arriving chunk from `rate` to the context rate on arrival (per-reply resampler state), starts after a 60 ms prebuffer, re-buffers on underrun, and posts `started` / `drained` / `flushed` (with played-sample counts) back. Flush = one `postMessage`, a 4 ms fade, drop everything; stale chunks are rejected by reply `id`.
4. **Stop latency** is dominated by what the OS device buffer already holds (`outputLatency`, typically tens of ms) plus ≤ 1 render quantum (2.7 ms at 48 kHz) plus main-thread message delay. Do not expect better than `outputLatency + ~5 ms`. **[unverified numbers, measure with `outputLatency`]**
5. **Echo:** default to the browser AEC (`echoCancellation: true`) and make the output path switchable (`direct` to `ctx.destination`, or `mediastream` via `MediaStreamAudioDestinationNode` → `<audio>`). The evidence that Chrome's AEC sees Web Audio output is old and mixed, so ship an A/B switch and a server-side safety net (barge-in off or gated while the assistant speaks, mic ducking, "headphones recommended"). WebKit has an open bug where AEC + playback crackles on iOS 27.
6. **Secure context:** `getUserMedia` needs `https` or `localhost`. For a LAN server the practical path is a real-domain certificate (DNS-01) or Tailscale HTTPS, with `wss://` on the same origin. Plain `http://192.168.x.x` will not expose `navigator.mediaDevices`.
7. **Visualiser:** compute mic RMS/waveform on the main thread from the 20 ms PCM frames you already receive; tap the playback node with an `AnalyserNode`. Keep levels in a plain mutable object, draw on `requestAnimationFrame`, no React state in the loop.
8. **WebSocket:** `binaryType = "arraybuffer"`, text frames = JSON control, binary frames = raw PCM (direction implies type; ordering is guaranteed on one socket), check `bufferedAmount` before each mic send.
9. **Mobile:** iOS locks/suspends audio on screen lock and app switch; the silent switch can mute Web Audio unless the audio session is "playback"/"play-and-record"; Bluetooth HFP can force very low sample rates. Use the Wake Lock API and re-acquire on `visibilitychange`.
10. **WebRTC** is not materially better for latency on a LAN; its real advantage is that browsers treat WebRTC remote audio as the echo-cancellation reference. Keep it as the escape hatch if Web Audio AEC proves unreliable.

## Per-browser caveats

| Topic | Chrome / Edge (desktop) | Firefox | Safari macOS | Safari iOS | Chrome Android |
|---|---|---|---|---|---|
| `AudioContext({sampleRate: 16000})` | Works [mem]; browser resamples mic and output | Mic stream and context rates must match, else `createMediaStreamSource` throws `NotSupportedError` (Bugzilla 1388586, 1674892 open) [src] | Works [mem]; poor resample quality reported (WebKit 154538) [src, old] | Shortfall bug at 16 kHz on iOS 15.6–16.2 (WebKit 251350) [src, old]; current status [unverified] | [unverified] |
| Context default rate | Device rate, often 48000 [mem] | Device rate; RFP forces 44100 (Bugzilla 2036218, Firefox 151 report) [src] | 44100/48000 [mem] | 48000 typical; low rates on Bluetooth HFP [unverified] | 48000 typical [mem] |
| `getUserMedia` `sampleRate`, `latency` constraints | Soft hints; check `track.getSettings()` [mem, unverified] | Same [unverified] | Same [unverified] | Same [unverified] | Same [unverified] |
| `echoCancellation`/`noiseSuppression`/`autoGainControl` | Honoured, default on [mem] | Honoured [mem] | Honoured [mem] | Honoured; AEC uses voice-processing I/O [mem] | Honoured [mem] |
| `echoCancellation` string values `"all"`/`"remote-only"` | Defined in spec [src: MDN]; browser support [unverified] | [unverified] | [unverified] | [unverified] | [unverified] |
| AEC sees Web Audio `destination` output | Historically **no** (Chromium 687574, Twilio #323, Deepgram demo #5) [src, 2018–2025]; a "Chrome-wide echo cancellation" mode that references all Chrome output is referenced in Chromium 40871060 and w3c/mediacapture-extensions#31 but I could not read current status or platforms [unverified] | Gecko picks "the important output" heuristically per padenot in w3c#31 [src] | [unverified] | AEC on, but crackle bug with playback (WebKit 326286, iOS 27.0.1; clean on iOS 18.7 and 26.2) [src] | [unverified] |
| `outputLatency` | Supported [mem] | Baseline 2025 "newly available" per MDN [src]; exact version [unverified] | Same MDN note; exact version [unverified] | [unverified] | [unverified] |
| `AudioWorklet` | Yes | Yes | Yes (iOS first-worklet quirks in WebKit 251091) [src, old] | Yes | Yes |
| Autoplay | Context starts `suspended` until a user gesture [mem] | Same [mem] | Same; strict about gesture synchronicity [mem] | Same; can enter non-standard `"interrupted"` state [mem] | Same [mem] |
| Screen lock / background | Capture continues in background tabs [mem] | Same [mem] | Same [mem] | Capture and context stop on lock or app switch [mem] | Mic may be cut after a time in background [unverified] |

---

## 1. Microphone capture

### 1.1 getUserMedia constraints

```ts
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,                 // ideal, not exact: some devices are stereo-only
  echoCancellation: true,          // keep ON; see section 3
  noiseSuppression: true,          // test with the sherpa recogniser; turn off if words get clipped
  autoGainControl: true,           // consider false if levels pump; test
  // sampleRate and latency are only hints. Do not rely on them:
  sampleRate: { ideal: 16000 },
  latency: { ideal: 0.01 },
};

export async function openMic(deviceId?: string): Promise<MediaStream> {
  const supported = navigator.mediaDevices.getSupportedConstraints();
  const audio: MediaTrackConstraints = { ...MIC_CONSTRAINTS };
  if (!supported.sampleRate) delete audio.sampleRate;
  if (!supported.latency) delete audio.latency;
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio, video: false });
}
// After opening: stream.getAudioTracks()[0].getSettings() tells you what you actually got
// (channelCount, sampleRate, echoCancellation, ...). Log it; do not assume.
```

What each browser honours: MDN states `echoCancellation` is a soft preference unless given as `{ exact }`, and that browsers ignore constraints they do not support. MDN's `getSupportedConstraints` page lists `latency`, `sampleRate`, `channelCount` as constraints that exist; **whether each browser acts on `sampleRate` and `latency` is [unverified]**. Design so it does not matter: the worklet reads the real `ctx.sampleRate`.

Sources: https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation , https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSupportedConstraints

### 1.2 16 kHz output: context at 16 kHz vs resampling in the worklet

| | Context at 16 kHz | Native-rate context + worklet resampler (recommended) |
|---|---|---|
| Chrome | Works [mem] | Works |
| Firefox | Throws if mic stream rate differs (Bugzilla 1388586; 1674892 open with WIP patch) [src] | Works: context default rate equals the default mic rate in the common case [unverified] |
| Safari | Works, resample quality complaints; iOS 15.6–16.2 sample shortfall (WebKit 251350) [src, old] | Works |
| Playback | Whole graph at 16 kHz: reply audio is down-sampled, bad for 24 kHz TTS | Playback keeps full quality |
| Latency | Browser resampler delay unknown [unverified] | ~0.8 ms (kernel half-width 40 input samples at 48→16 kHz) |
| Quality | Browser-dependent | Windowed-sinc, Blackman, about −58 dB stopband; fine for ASR |

Decision: native rate + worklet resampler. If the context rate is already 16000 the worklet bypasses the filter.

Sources: https://bugzilla.mozilla.org/show_bug.cgi?id=1388586 , https://bugzilla.mozilla.org/show_bug.cgi?id=1674892 , https://onbugs.webkit.org/show_bug.cgi?id=251350 , https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/AudioContext

### 1.3 Shared streaming resampler (used by both worklets)

Worklet modules loaded with `addModule` cannot be bundled with your app code reliably by Next.js [unverified], so ship worklets as plain JS in `public/worklets/` and inline this class in both files (or concatenate at build time).

```js
// StreamResampler: windowed-sinc, arbitrary ratio, state carried across calls.
// process(input: Float32Array, out: Float32Array) -> number of output samples written.
// `out` must hold at least ceil(input.length / step) + 2 samples.
class StreamResampler {
  constructor(inRate, outRate, maxIn = 8192, taps = 12) {
    this.step = inRate / outRate;                       // input samples per output sample
    const cutoff = Math.min(1, outRate / inRate) * 0.94; // relative to input Nyquist
    this.W = taps / cutoff;                              // kernel half width, input samples
    this.OS = 128;                                       // table oversampling
    const n = Math.ceil(this.W * this.OS) + 2;
    this.tab = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / this.OS;
      if (x >= this.W) { this.tab[i] = 0; continue; }
      const px = Math.PI * cutoff * x;
      const sinc = x === 0 ? 1 : Math.sin(px) / px;
      const a = Math.PI * x / this.W;                    // Blackman window
      const win = 0.42 + 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
      this.tab[i] = cutoff * sinc * win;
    }
    this.maxIn = maxIn;
    this.buf = new Float32Array(Math.ceil(this.W) * 2 + maxIn + 8);
    this.len = Math.ceil(this.W);                        // leading zeros (history)
    this.t = this.len;                                   // position of next output centre
  }
  process(input, out) {
    let produced = 0;
    for (let off = 0; off < input.length; off += this.maxIn) {
      const n = Math.min(this.maxIn, input.length - off);
      this.buf.set(input.subarray(off, off + n), this.len);
      this.len += n;
      const { W, OS, tab, buf } = this;
      while (this.t + W < this.len) {
        const t = this.t;
        const lo = Math.ceil(t - W), hi = Math.floor(t + W);
        let acc = 0;
        for (let k = lo; k <= hi; k++) {
          const x = Math.abs(k - t) * OS;
          const i = x | 0, f = x - i;
          acc += buf[k] * (tab[i] + (tab[i + 1] - tab[i]) * f);
        }
        out[produced++] = acc;
        this.t += this.step;
      }
      const keep = Math.max(0, Math.ceil(this.t - W));
      this.buf.copyWithin(0, keep, this.len);
      this.len -= keep;
      this.t -= keep;
    }
    return produced;
  }
}
```

### 1.4 Capture worklet (`public/worklets/capture.worklet.js`)

```js
// ... paste StreamResampler here ...
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetRate = 16000, chunkMs = 20 } = options.processorOptions || {};
    this.chunk = Math.round(targetRate * chunkMs / 1000);          // 320
    this.bypass = sampleRate === targetRate;
    this.rs = this.bypass ? null : new StreamResampler(sampleRate, targetRate, 128);
    this.tmp = new Float32Array(this.bypass ? 128 : Math.ceil(128 / this.rs.step) + 4);
    this.mono = new Float32Array(128);
    this.acc = new Int16Array(this.chunk);
    this.n = 0;
    this.muted = false;
    this.port.onmessage = (e) => { if (e.data && e.data.type === "mute") this.muted = !!e.data.value; };
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // Mix down to mono (normally one channel already).
    let ch = input[0];
    if (input.length > 1) {
      for (let i = 0; i < ch.length; i++) {
        let s = 0;
        for (let c = 0; c < input.length; c++) s += input[c][i];
        this.mono[i] = s / input.length;
      }
      ch = this.mono;
    }
    let m;
    if (this.bypass) { this.tmp.set(ch); m = ch.length; }
    else m = this.rs.process(ch, this.tmp);
    for (let i = 0; i < m; i++) {
      let s = this.muted ? 0 : this.tmp[i];
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      this.acc[this.n++] = Math.round(s < 0 ? s * 32768 : s * 32767);
      if (this.n === this.chunk) {
        const buf = this.acc.buffer;
        this.port.postMessage(buf, [buf]);                       // transfer: no copy
        this.acc = new Int16Array(this.chunk);                   // one 640-byte alloc per 20 ms
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture", CaptureProcessor);
```

Notes: `Int16Array` here is little-endian on every browser platform in practice [mem]. The first frames carry ~1 ms of resampler warm-up (leading zeros); harmless. A node with no downstream connection may not be pulled in some browsers, so main-thread code connects it to a zero-gain node into `destination` [mem; common practice, not re-verified].

### 1.5 Main thread: start, capture, send (TypeScript)

```ts
// audio-client.ts  (framework-agnostic; React only calls start()/stop())
export type ClientEvents = {
  onMicFrame?: (pcm: Int16Array) => void;            // 20 ms, 320 samples
  onPlayback?: (e: PlaybackEvent) => void;
  onState?: (s: "starting" | "running" | "suspended" | "stopped" | "error", detail?: string) => void;
};

export type PlaybackEvent =
  | { type: "started"; id: number; ctxTime: number; outputLatency: number }
  | { type: "drained"; id: number; playedSamples: number; sourceRate: number }
  | { type: "flushed"; id: number; playedSamples: number; sourceRate: number }
  | { type: "underrun"; id: number };

export class VoiceAudio {
  ctx!: AudioContext;
  mic?: MediaStream;
  capture!: AudioWorkletNode;
  player!: AudioWorkletNode;
  outAnalyser!: AudioNode & { fftSize: number };     // AnalyserNode
  micAnalyser!: AnalyserNode;
  private sink?: HTMLAudioElement;

  constructor(private ws: WebSocket, private ev: ClientEvents = {}, private outputMode: "direct" | "mediastream" = "direct") {}

  /** MUST be called synchronously from a click/tap handler (see section 4). */
  async start(): Promise<void> {
    this.ev.onState?.("starting");
    // 1. Create and resume the context inside the gesture, before any await.
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    const resumed = this.ctx.resume();
    if (this.outputMode === "mediastream") {
      this.sink = new Audio();
      this.sink.autoplay = true;
      void this.sink.play().catch(() => {});             // unlock the element in the same gesture
    }
    // 2. Mic permission prompt (also needs the gesture on Safari).
    this.mic = await openMic();
    await resumed;
    await Promise.all([
      this.ctx.audioWorklet.addModule("/worklets/capture.worklet.js"),
      this.ctx.audioWorklet.addModule("/worklets/player.worklet.js"),
    ]);

    // 3. Capture graph.
    const src = this.ctx.createMediaStreamSource(this.mic);
    this.capture = new AudioWorkletNode(this.ctx, "capture", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { targetRate: 16000, chunkMs: 20 },
    });
    const zero = this.ctx.createGain(); zero.gain.value = 0;
    this.micAnalyser = this.ctx.createAnalyser(); this.micAnalyser.fftSize = 1024;
    src.connect(this.capture); src.connect(this.micAnalyser);
    this.capture.connect(zero).connect(this.ctx.destination);
    this.capture.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.onMicBuffer(e.data);

    // 4. Playback graph.
    this.player = new AudioWorkletNode(this.ctx, "player", {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
    });
    this.outAnalyser = this.ctx.createAnalyser(); (this.outAnalyser as AnalyserNode).fftSize = 1024;
    this.player.connect(this.outAnalyser as AnalyserNode);            // tap (output unconnected is allowed)
    if (this.outputMode === "direct") {
      this.player.connect(this.ctx.destination);
    } else {
      const dest = this.ctx.createMediaStreamDestination();
      this.player.connect(dest);
      this.sink!.srcObject = dest.stream;
    }
    this.player.port.onmessage = (e) => this.onPlayerMessage(e.data);

    this.ctx.onstatechange = () => this.ev.onState?.(this.ctx.state === "running" ? "running" : "suspended");
    this.mic.getAudioTracks()[0].addEventListener("ended", () => this.ev.onState?.("error", "microphone track ended"));
    navigator.mediaDevices.addEventListener("devicechange", () => void this.reopenMic());
    this.ev.onState?.(this.ctx.state === "running" ? "running" : "suspended");
  }

  // ---- mic -> socket ----
  private micDropped = 0;
  private onMicBuffer(buf: ArrayBuffer) {
    const pcm = new Int16Array(buf);
    this.ev.onMicFrame?.(pcm);                                   // visualiser, no copy
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // Backpressure: 16 kHz s16 = 32 000 B/s. More than 500 ms queued = network stall.
    if (this.ws.bufferedAmount > 16_000) { this.micDropped += pcm.length; return; }
    if (this.micDropped > 0) {                                   // tell the server about the hole, once
      this.ws.send(JSON.stringify({ type: "mic.gap", samples: this.micDropped }));
      this.micDropped = 0;
    }
    this.ws.send(buf);                                           // ArrayBuffer is sent without another copy
  }

  async reopenMic(deviceId?: string) {
    try {
      this.mic?.getTracks().forEach((t) => t.stop());
      this.mic = await openMic(deviceId);
      const src = this.ctx.createMediaStreamSource(this.mic);
      src.connect(this.capture); src.connect(this.micAnalyser);
    } catch (e) { this.ev.onState?.("error", String(e)); }
  }

  setMicMuted(v: boolean) { this.capture.port.postMessage({ type: "mute", value: v }); }

  // ---- playback API (section 2) ----
  replyStart(id: number, sourceRate: number, prebufferMs = 60) {
    this.player.port.postMessage({ type: "start", id, rate: sourceRate, prebufferMs });
  }
  replyChunk(id: number, buf: ArrayBuffer) {
    this.player.port.postMessage({ type: "pcm", id, buf }, [buf]);   // transfer, zero copy
  }
  replyEnd(id: number) { this.player.port.postMessage({ type: "end", id }); }
  flush() { this.player.port.postMessage({ type: "flush" }); }
  private onPlayerMessage(m: any) {
    const ol = "outputLatency" in this.ctx ? (this.ctx as AudioContext).outputLatency : 0;
    switch (m.type) {
      case "started": this.ev.onPlayback?.({ type: "started", id: m.id, ctxTime: m.time + ol, outputLatency: ol }); break;
      case "drained": case "flushed": this.ev.onPlayback?.({ type: m.type, id: m.id, playedSamples: m.playedSrc, sourceRate: m.srcRate }); break;
      case "underrun": this.ev.onPlayback?.({ type: "underrun", id: m.id }); break;
    }
  }

  async stop() {
    this.mic?.getTracks().forEach((t) => t.stop());
    await this.ctx.close();
    this.ev.onState?.("stopped");
  }
}
```

Copies: worklet → main is a transfer (0 copies); main → socket is `ws.send(ArrayBuffer)` (the browser copies into its send queue once, unavoidable). Delay added: up to one 20 ms frame of framing plus ≤ 1 render quantum (2.7 ms); message hop is sub-millisecond in the normal case [unverified, measure].

Sources: https://developer.chrome.com/blog/audio-worklet-design-pattern (128-frame quantum; MessagePort is "suboptimal" for heavy traffic, shared memory preferred; 50 messages/s of 640 bytes is far below that concern). SharedArrayBuffer rings need cross-origin isolation (COOP/COEP) so are not used here [mem].

---

## 2. Playback of streamed PCM

### 2.1 Handling 22.05 / 24 kHz input on a 48 kHz context

| Option | Latency | Glitch risk | Stop behaviour | Verdict |
|---|---|---|---|---|
| **Resample in worklet** (queue at context rate) | Prebuffer you choose (60 ms) + ~0.6 ms filter | Low: you control underrun handling; filter state carried across chunks so no seams | One message; worklet fades 4 ms and clears; exact played-sample count | **Recommended** |
| Context per reply at the reply's rate | Context creation cost (tens to hundreds of ms [unverified]) per reply; browser still resamples to the device | Low once running | Close the context: instant but the next reply pays the creation cost; context-count limits on iOS [unverified] | Reject |
| `AudioBufferSourceNode` per chunk, scheduled by `start(when)` | Schedule-ahead you choose | Seams: float scheduling error, one click per boundary in some browsers [mem, unverified today]; per-buffer resampling by the engine | Keep a list of live sources and call `stop()` on each: works, but chunks already scheduled need individual stops and exact played count is only inferable from `currentTime` | Fallback if worklets are unavailable |

### 2.2 Playback worklet (`public/worklets/player.worklet.js`)

Design choices: a **queue of Float32 chunks** rather than a fixed ring. Replies arrive faster than real time and can be long, so a fixed ring would overflow or need a size cap; a queue has no overflow and the per-chunk allocation happens on message arrival, not per render quantum. Everything is drained by reference (no per-sample copy beyond `set`).

```js
// ... paste StreamResampler here ...
class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.qOff = 0; this.queued = 0;      // chunks at context rate; frames queued
    this.state = "idle";                              // idle | buffering | playing
    this.id = 0; this.srcRate = 0; this.rs = null; this.bypass = false;
    this.ended = false; this.startedSent = false;
    this.playedOut = 0;                               // output frames emitted for this reply
    this.threshold = 0;                               // frames needed to (re)start playing
    this.refill = Math.round(0.04 * sampleRate);      // after an underrun
    this.fade = 0; this.fadeLen = Math.round(0.004 * sampleRate); // flush ramp
    this.gain = 1;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }
  playedSrc() { return Math.round(this.playedOut * this.srcRate / sampleRate); }
  reset() { this.q = []; this.qOff = 0; this.queued = 0; this.ended = false; this.startedSent = false;
            this.playedOut = 0; this.gain = 1; this.fade = 0; }
  onMessage(m) {
    switch (m.type) {
      case "start": {
        this.reset();
        this.id = m.id; this.srcRate = m.rate;
        this.bypass = m.rate === sampleRate;
        this.rs = this.bypass ? null : new StreamResampler(m.rate, sampleRate, 16384);
        this.threshold = Math.round((m.prebufferMs ?? 60) / 1000 * sampleRate);
        this.state = "buffering";
        break;
      }
      case "pcm": {
        if (m.id !== this.id) return;                 // stale chunk after flush/new reply: drop
        const s16 = new Int16Array(m.buf, 0, m.buf.byteLength >> 1);
        const f = new Float32Array(s16.length);
        for (let i = 0; i < s16.length; i++) f[i] = s16[i] / 32768;
        let out = f;
        if (!this.bypass) {
          const tmp = new Float32Array(Math.ceil(f.length / this.rs.step) + 4);
          out = tmp.subarray(0, this.rs.process(f, tmp));
        }
        if (out.length) { this.q.push(out); this.queued += out.length; }
        if (this.state === "buffering" && this.queued >= this.threshold) this.state = "playing";
        break;
      }
      case "end": {
        if (m.id !== this.id) return;
        this.ended = true;
        if (this.state === "buffering") this.state = "playing"; // play whatever is short of the prebuffer
        break;
      }
      case "flush": {
        const id = this.id;
        if (this.state === "idle" || this.queued === 0) {
          const p = this.playedSrc();
          this.reset(); this.id = 0; this.state = "idle";
          this.port.postMessage({ type: "flushed", id, playedSrc: p, srcRate: this.srcRate });
        } else {
          this.fade = this.fadeLen;                   // ramp down in process(), then clear
          this.id = 0;                                // reject in-flight chunks immediately
          this.flushId = id;
        }
        break;
      }
    }
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    let i = 0;
    if (this.state === "playing") {
      while (i < n && this.queued > 0) {
        const c = this.q[0];
        const take = Math.min(c.length - this.qOff, n - i);
        out.set(c.subarray(this.qOff, this.qOff + take), i);
        this.qOff += take; this.queued -= take; i += take;
        if (this.qOff === c.length) { this.q.shift(); this.qOff = 0; }
      }
      if (i > 0 && !this.startedSent) {
        this.startedSent = true;
        // currentTime is the start of this quantum; the first sample is at i0 = 0 here
        // because we only start on a fresh quantum. Audible time = time + outputLatency.
        this.port.postMessage({ type: "started", id: this.id || this.flushId, time: currentTime });
      }
      this.playedOut += i;
    }
    if (i < n) out.fill(0, i);

    if (this.fade > 0) {                               // flush ramp
      for (let k = 0; k < n; k++) {
        const g = this.fade > 0 ? this.fade / this.fadeLen : 0;
        out[k] *= g; if (this.fade > 0) this.fade--;
      }
      if (this.fade === 0) {
        const p = this.playedSrc(), id = this.flushId;
        this.reset(); this.state = "idle";
        this.port.postMessage({ type: "flushed", id, playedSrc: p, srcRate: this.srcRate });
      }
      return true;
    }

    if (this.state === "playing" && i < n) {
      if (this.ended) {                                // ran dry because the reply is over
        const id = this.id, p = this.playedSrc();
        this.state = "idle"; this.reset();
        this.port.postMessage({ type: "drained", id, playedSrc: p, srcRate: this.srcRate });
      } else {                                         // real underrun: re-buffer
        this.state = "buffering"; this.threshold = this.refill;
        this.port.postMessage({ type: "underrun", id: this.id });
      }
    }
    return true;
  }
}
registerProcessor("player", PlayerProcessor);
```

Known gaps to test: (a) `drained` after `end` when the queue was already empty on arrival of `end` (handled: next quantum has `i === 0`, state `playing`, `ended`); (b) `end` for a reply with zero audio posts `drained` with `playedSrc: 0` and no `started`; (c) `this.id = 0` on flush means an `end` for the old reply is ignored, which is intended; (d) `playedSrc` ignores the resampler's ~0.6 ms of look-ahead.

"Actually producing sound": the `started` message carries the context time of the first quantum that contained samples. Audible time is that plus `outputLatency` (main thread adds it, see `VoiceAudio.onPlayerMessage`). Send this timestamp and `performance.now()` to the server for `TurnTrace`; map them with `ctx.getOutputTimestamp()` ([mem], not exercised).

### 2.3 Protocol glue for one socket (TypeScript)

```ts
// Server -> client JSON: {type:"reply.start", id, rate} | {type:"reply.end", id} | {type:"interrupt"}
// Server -> client binary: raw s16le mono PCM for the current reply (always belongs to the latest reply.start)
// Client -> server JSON: {type:"playback.started"|"playback.finished"|"playback.interrupted", id, playedSamples, sourceRate, ...}
// Client -> server binary: 16 kHz s16le mono, 640 B per frame

export function wire(ws: WebSocket, audio: VoiceAudio) {
  ws.binaryType = "arraybuffer";
  let current = 0;
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.type === "reply.start") { current = m.id; audio.replyStart(m.id, m.rate); }
      else if (m.type === "reply.end") audio.replyEnd(m.id);
      else if (m.type === "interrupt") audio.flush();       // drop everything immediately
    } else {
      audio.replyChunk(current, e.data as ArrayBuffer);     // transferred, not copied
    }
  };
}
// In ClientEvents.onPlayback: translate to JSON for the server:
//  started   -> {type:"playback.started", id}
//  drained   -> {type:"playback.finished", id, playedSamples, sourceRate}
//  flushed   -> {type:"playback.interrupted", id, playedSamples, sourceRate}
```

`playedSamples` is at the **source** rate (so the server can map it to clause audio durations and to interrupted history). It counts samples handed to the output, not heard; subtract `outputLatency * sourceRate` for "heard" if you need that.

### 2.4 Output latency and how to read it

- `ctx.baseLatency`: seconds of processing latency inside the context, per MDN "check `baseLatency` after creating the context" because the browser may not honour `latencyHint`. [src: MDN AudioContext constructor]
- `ctx.outputLatency`: estimate of the time from handing a buffer to the host audio system until the first sample reaches the output device. MDN lists it as Baseline 2025 "newly available"; exact Safari and Firefox versions [unverified]. [src: MDN]
- Guard every read: `"outputLatency" in ctx ? ctx.outputLatency : 0`. Values vary by platform and device; Bluetooth output adds 100–250 ms [mem, unverified]; Chrome desktop `baseLatency` ~10 ms [mem].
- Achievable total (prebuffer 60 ms is the main knob): `prebuffer + baseLatency + outputLatency`, e.g. 60 + 10 + 30 ≈ 100 ms from first chunk arrival to sound. Lower the prebuffer to 20–40 ms on LAN if underruns stay at zero in the trace. **[estimates, not measured]**
- Stop latency: message hop + ≤ 2.7 ms quantum + 4 ms fade + the device buffer already queued (`outputLatency`). It is physically not possible to recall audio already in the OS buffer.

Sources: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency , https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/AudioContext

---

## 3. Echo cancellation

**What the sources say**
- Chrome's AEC historically only used WebRTC peer-connection audio as the reference. Audio produced through Web Audio and played via `AudioContext.destination` was not cancelled (Chromium 687574; Twilio #323; discuss-webrtc threads; Deepgram agent demo #5, still open: "echo cancellation only works for audio that is coming from a peer connection"). [src, 2018–2025]
- Workaround reported in the older write-ups: route Web Audio into `createMediaStreamDestination()` and play that stream through an `<audio>` element; Chromium then applied AEC. A Chromium engineer said a fix for the Web Audio path was feasible. **Whether that works in current Chrome is [unverified]; I found no source from 2025–2026.** [src: focused.io, discuss-webrtc]
- Chromium later added a "Chrome-wide echo cancellation" mode that uses all browser output as the reference, which caused the opposite complaint (page audio being filtered from captures). Platforms and current default [unverified]. [src: w3c/mediacapture-extensions#31, Chromium 40871060 (page not readable by my fetcher)]
- The standard does not define which output is the AEC reference; Gecko uses a heuristic ("the important output"). [src: w3c#31]
- WebKit bug 326286: on iOS 27.0.1, any playback crackles while a `getUserMedia` stream with `echoCancellation: true` is open (Web Audio, `<audio>`, WebRTC alike); clean on iOS 18.7 and 26.2; with AEC off output is clean but goes to the earpiece at low volume. Status NEW. [src]
- Safari 26.1 release notes mention `getUserMedia` fixes (spurious `devicechange` on iOS). Nothing about Web Audio AEC. [src]

**Recommendation**
1. Always request `echoCancellation: true` (and keep the other two on) so that if the browser *does* see the output, it is cancelled.
2. Build the output path switchable: `direct` (`ctx.destination`) or `mediastream` (`MediaStreamAudioDestinationNode` → `<audio>`). Provide a "Test echo" page that plays the assistant voice, records the mic for 5 s, and reports the mic RMS during playback vs silence. Choose the default per browser from that measurement, not from this document. Expect `mediastream` to cost extra latency [unverified]; compare with `TurnTrace`.
3. Server-side safety net (works regardless of browser): the ARCHITECTURE already supports "barge-in disabled ignores events as probably the assistant's own voice". Add: (a) the client sends `playback.started/finished` so the server knows when the assistant is audible; (b) while audible, raise the VAD threshold or require N consecutive speech frames before barge-in; (c) optional **half-duplex mode**: `setMicMuted(true)` while playing and use a tap-to-interrupt button.
4. **Headphones:** no acoustic path, so no echo; barge-in works fully. Detect with `enumerateDevices()` labels only as a hint [unverified]; better to offer a "I'm using headphones" toggle that disables the safety net.
5. **Speakers, AEC unreliable (unverified Chrome Web Audio, iOS 27 crackle):** use half-duplex or gated barge-in; consider the WebRTC route (section 6) if you need full-duplex on speakers.
6. On iOS 27 with the crackle bug, offer the AEC-off fallback with headphones only.

Sources: https://github.com/twilio/twilio-video.js/issues/323 , https://groups.google.com/g/discuss-webrtc/c/NQ0f8MwwegQ , https://focused.io/lab/echo-cancellation-with-web-audio-api-and-chromium , https://github.com/deepgram-devs/deepgram-ai-agent-demo/issues/5 , https://github.com/w3c/mediacapture-extensions/issues/31 , https://issues.chromium.org/issues/40871060 , https://bugs.webkit.org/show_bug.cgi?id=326286 , https://developer.apple.com/documentation/safari-release-notes/safari-26_1-release-notes

---

## 4. Autoplay, permissions, devices, secure context

- **Gesture:** an `AudioContext` created before a user gesture starts `suspended`; `resume()` must be called from a gesture handler (Safari is stricter about the gesture being on the same synchronous turn). `getUserMedia` shows its prompt anywhere in secure contexts but Safari may require the gesture too [mem]. Structure: one "Start" button whose handler synchronously does `new AudioContext()`, `ctx.resume()`, optionally `audioEl.play()`, then awaits `getUserMedia`. `VoiceAudio.start()` above does exactly that; call it directly in `onClick`, not after an `await`.
- **Suspended later:** listen to `ctx.onstatechange`; if not `running` (iOS: may report `"interrupted"` [mem]) show a "Tap to resume" button that calls `ctx.resume()`; also resume on `visibilitychange` → visible.
- **Permission denial:** handle `NotAllowedError` (denied or dismissed; tell the user how to re-enable in site settings), `NotFoundError` (no mic), `NotReadableError` (device busy or OS blocked), `OverconstrainedError` (only with `exact` constraints). Never loop-retry on `NotAllowedError`.

```ts
export function describeMicError(e: unknown): string {
  const name = (e as DOMException)?.name;
  switch (name) {
    case "NotAllowedError": return "Microphone permission was denied. Allow it in the browser's site settings and press Start again.";
    case "NotFoundError": return "No microphone found.";
    case "NotReadableError": return "The microphone is in use by another app or blocked by the system.";
    case "OverconstrainedError": return "The selected microphone does not support the requested settings.";
    default: return `Could not open the microphone (${name ?? "unknown error"}).`;
  }
}
```

- **Device changes:** `navigator.mediaDevices.addEventListener("devicechange", ...)` and `track.onended`; reopen the mic (see `reopenMic`). Output device: `AudioContext.setSinkId()` and the `sinkchange` event exist in Chromium [mem; Safari/Firefox [unverified]]. Do not reopen on every `devicechange` on iOS without checking the default input actually changed (Safari 26.1 fixed spurious events). [src: Safari 26.1 notes]
- **Secure context:** `navigator.mediaDevices` is `undefined` on plain `http://` origins other than `localhost`/`127.0.0.1`. Also `ws://` from an `https` page is blocked as mixed content (localhost exempt). So the page and the socket must both be TLS when served to other devices.

Practical options for a LAN server (best first for a household):
1. **Real hostname + DNS-01 certificate** (e.g. `assistant.home.example.com` → private IP, Let's Encrypt via DNS challenge, Caddy/Traefik): trusted everywhere, no per-device setup. Serve the page and the WebSocket (`/ws`) from the same origin through the reverse proxy.
2. **Tailscale HTTPS** (`tailscale serve`/certs for `*.ts.net`): trusted certs, but every client needs Tailscale. [mem]
3. **mkcert / own CA:** install the root on each device (iOS needs the profile installed and enabled under certificate trust settings). Works, per-device chore. `next dev --experimental-https` can generate a local cert for dev [mem].
4. **Chrome flag** `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with the origin listed: desktop Chrome only, per device, dev use. [mem]
5. Same-machine only: `http://localhost:3000` works without TLS.

Sources: https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSupportedConstraints (secure-context note), https://developer.mozilla.org/en-US/docs/Web/API/AudioSession ; secure-context list and flag names are [mem], not re-fetched.

---

## 5. Visualiser data

- **Mic:** you already receive 320-sample frames every 20 ms (50 Hz). Compute RMS/peak and keep a rolling waveform on the main thread (320 samples per frame is trivial work). No `AnalyserNode` needed unless you want a spectrum, in which case `micAnalyser` (created above) gives `getFloatFrequencyData` pulled on rAF at no worklet cost.
- **Playback:** the `outAnalyser` tap on the player node gives time-domain and frequency data at the *playing* position (correct even with prebuffering, since it reads what the worklet outputs). Alternative: compute RMS inside the player worklet and post at 30 Hz; the AnalyserNode is simpler and offers spectrum.
- **Update rates:** read analysers once per rAF frame (60 Hz); smooth with attack/release so frames between 50 Hz mic updates do not look stepped.
- **No React re-renders:** the audio client lives outside React; levels live in a mutable object; a single rAF loop draws to canvas. React renders the Start button and status only.
- **Audio glitches:** the audio thread is independent of rAF, so drawing cannot underrun the worklet directly. What can hurt is a long main-thread task delaying `postMessage` delivery to the player (chunks arrive late → underrun) and the mic socket sends. Keep per-frame draw work under ~4 ms, preallocate arrays, and consider `OffscreenCanvas` in a worker for WebGL if it grows [unverified for your scene].

```ts
// levels.ts
export const levels = {
  mic: { rms: 0, peak: 0, wave: new Float32Array(1024), widx: 0 },
  out: { rms: 0 },
};

export function pushMicFrame(pcm: Int16Array) {          // ClientEvents.onMicFrame
  let sum = 0, peak = 0;
  const w = levels.mic.wave;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] / 32768; sum += s * s;
    const a = s < 0 ? -s : s; if (a > peak) peak = a;
    w[levels.mic.widx] = s; levels.mic.widx = (levels.mic.widx + 1) & 1023;
  }
  levels.mic.rms = Math.sqrt(sum / pcm.length);
  levels.mic.peak = peak;
}

// visualiser.ts
export function startVisualiser(canvas: HTMLCanvasElement, audio: VoiceAudio, isAssistantSpeaking: () => boolean) {
  const g = canvas.getContext("2d")!;
  const timeBuf = new Float32Array(1024);
  const freqBuf = new Uint8Array((audio.outAnalyser as AnalyserNode).frequencyBinCount);
  let level = 0, raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    let target = 0;
    if (isAssistantSpeaking()) {
      const a = audio.outAnalyser as AnalyserNode;
      a.getFloatTimeDomainData(timeBuf); a.getByteFrequencyData(freqBuf);
      let s = 0; for (let i = 0; i < timeBuf.length; i++) s += timeBuf[i] * timeBuf[i];
      target = Math.min(1, Math.sqrt(s / timeBuf.length) * 4);
    } else {
      target = Math.min(1, levels.mic.rms * 6);
    }
    level += (target - level) * (target > level ? 0.5 : 0.12);   // fast attack, slow release
    const { width: w, height: h } = canvas;
    g.clearRect(0, 0, w, h);
    g.beginPath(); g.arc(w / 2, h / 2, 40 + level * 80, 0, Math.PI * 2); g.fill();
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

// React: one effect, no state in the loop
// useEffect(() => startVisualiser(canvasRef.current!, audioRef.current!, () => speakingRef.current), []);
```

Background tabs pause rAF; nothing about audio depends on it. Sources: https://developer.chrome.com/blog/audio-worklet-design-pattern ; `AnalyserNode` behaviour with an unconnected output is [mem] from the Web Audio spec (https://webaudio.github.io/web-audio-api/), not re-fetched.

---

## 6. WebSocket transport

- `ws.binaryType = "arraybuffer"` (default is `"blob"`, which makes reads asynchronous and copies). Set before the first message.
- **Framing:** text frame = JSON control, binary frame = PCM. Direction fixes the meaning of binary: client→server is always 16 kHz mic; server→client is always the current reply, whose rate came from the last `reply.start`. One socket orders both, so `reply.start` always precedes its chunks and `interrupt` always precedes stale ones. Include a reply `id` in every control message and let the player drop chunks whose id does not match (done above). Do not prefix binary frames with a header; it forces a copy on the client.
- **`bufferedAmount` (client→server):** at 32 000 B/s, 16 000 B is 500 ms. Above that the network is stalled; stop queuing (a growing queue becomes latency), report a gap with `mic.gap`, and let the server decide (typically end the turn). Reconnect with backoff if `readyState` leaves OPEN. Never block the mic worklet.
- **Server→client stalls:** the browser exposes no backpressure on receive; replies arrive faster than real time, so a stall shows up as the player's `underrun`. Use `reply.end` plus `drained`; on a long stall the server's own timeout should end the reply.
- Compression: disable `permessage-deflate` for PCM server-side (CPU and delay for ~no gain) [mem]. Do not assume Nagle is disabled in browsers [unverified].
- **WebRTC vs WebSocket on a LAN:** WebSocket over TCP adds no meaningful head-of-line delay on a clean LAN, and 20 ms frames add 20 ms regardless. WebRTC would add signalling/ICE complexity, a jitter buffer (tens of ms) and an Opus codec stage. Its one real benefit here is that browsers treat WebRTC remote audio as the AEC reference (section 3), which could make speaker use robust. Keep the WebSocket plan; revisit WebRTC only if the echo test fails on the browsers you care about. [argument, not measured]

---

## 7. Mobile

| Topic | iOS Safari | Android Chrome |
|---|---|---|
| Sample rate | Read `ctx.sampleRate`; 44.1/48 kHz typical, lower rates possible on Bluetooth hands-free [unverified] | 48 kHz typical [mem] |
| Audio session | `navigator.audioSession.type = "play-and-record"` declares simultaneous capture/playback and can influence routing (earpiece vs speaker) and interruptions; MDN marks it experimental/limited availability. [src: MDN] Set before `getUserMedia`. | Not applicable |
| AEC | Open mic with AEC routes output to the loudspeaker at normal volume; with AEC off, output goes to the earpiece quietly; iOS 27.0.1 crackle bug with AEC on [src: WebKit 326286] | [unverified] |
| Silent switch | Web Audio is commonly muted by the ringer switch unless the session is "playback" or "play-and-record"; an open mic generally puts the session in play-and-record [mem, unverified today]. Test with the switch on. | Not applicable |
| Screen lock / background | Capture and context stop or get interrupted; show a resume button; hold a **Screen Wake Lock** (`navigator.wakeLock.request("screen")`, re-request on `visibilitychange`) while in a conversation [mem] | Mic may stop after being backgrounded; wake lock helps [unverified] |
| Output latency | Unmeasured [unverified] | Often higher than desktop (tens of ms more) [mem, unverified] |
| Safari 26 notes | `getUserMedia` `devicechange` fix in 26.1; 27.2 beta fixed a permanent `NotAllowedError` after audio-service reset [src: Safari release notes via search snippets, not read in full] | — |

Sources: https://developer.mozilla.org/en-US/docs/Web/API/AudioSession , https://bugs.webkit.org/show_bug.cgi?id=326286 , https://developer.apple.com/documentation/safari-release-notes/safari-26_1-release-notes

---

## Next steps (to turn this from a reference into verified code)

1. Create the worklets and client in the web app; type-check `audio-client.ts` (it was not type-checked).
2. Node unit tests for `StreamResampler` (sine at 1 kHz through 48→16, 22.05→48, 24→48; check amplitude, continuity across chunk boundaries, sample count within ±1 of `n·ratio`).
3. Headless Chromium test with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture`: run the capture worklet from the fake mic, assert 640-byte frames at 50 Hz; run the player worklet with synthetic chunks, assert `started` / `drained` / `flushed` messages and played counts.
4. Real-device matrix: echo test (section 3) and silent-switch test on iOS, desktop Safari, Firefox, Chrome; record `baseLatency` and `outputLatency` into `TurnTrace`.

## Source index

- MDN AudioContext constructor: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/AudioContext
- MDN outputLatency: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency
- MDN AudioSession: https://developer.mozilla.org/en-US/docs/Web/API/AudioSession
- MDN echoCancellation: https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation
- MDN supported constraints: https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSupportedConstraints
- Chrome AudioWorklet design patterns: https://developer.chrome.com/blog/audio-worklet-design-pattern
- Chromium 687574 via Twilio: https://github.com/twilio/twilio-video.js/issues/323
- discuss-webrtc: https://groups.google.com/g/discuss-webrtc/c/NQ0f8MwwegQ
- Focused: https://focused.io/lab/echo-cancellation-with-web-audio-api-and-chromium
- Deepgram demo: https://github.com/deepgram-devs/deepgram-ai-agent-demo/issues/5
- W3C reference-signal issue: https://github.com/w3c/mediacapture-extensions/issues/31
- Chromium Chrome-wide AEC request (unreadable by my fetcher): https://issues.chromium.org/issues/40871060
- Firefox: https://bugzilla.mozilla.org/show_bug.cgi?id=1388586 , https://bugzilla.mozilla.org/show_bug.cgi?id=1674892 , https://bugzilla.mozilla.org/show_bug.cgi?id=2036218
- WebKit: https://onbugs.webkit.org/show_bug.cgi?id=251350 , https://bugs.webkit.org/show_bug.cgi?id=251091 , https://bugs.webkit.org/show_bug.cgi?id=154538 , https://bugs.webkit.org/show_bug.cgi?id=326286
- Safari 26.1 release notes: https://developer.apple.com/documentation/safari-release-notes/safari-26_1-release-notes
- Web Audio spec (not fetched): https://webaudio.github.io/web-audio-api/
