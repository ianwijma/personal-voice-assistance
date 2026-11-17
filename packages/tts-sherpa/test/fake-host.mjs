// Stand-in engine host speaking the same protocol as src/engine-host.mjs, with no model.
// init.config: { sampleRate, delayMs, loadMs, failLoad }
// A clause's audio: 60 ms silence, 10 ms of 440 Hz tone per character, 150 ms silence. Speaker n (the speak
// message's sid, else init's speaker) makes the tone n + 1 times as long, so tests can tell speakers apart.
// Directives in the text: "crash" exits the process, "hang" never answers, "fail" answers with an error,
// "sleep:<ms>" overrides the synthesis delay.
let config
let speaker = 0

process.on("disconnect", () => process.exit(0))

const fakeSamples = (text, sampleRate, sid) => {
  const lead = Math.round(sampleRate * 0.06)
  const tone = Math.round(sampleRate * 0.01 * text.length * (sid + 1))
  const trail = Math.round(sampleRate * 0.15)
  const samples = new Float32Array(lead + tone + trail)
  for (let i = 0; i < tone; i++) samples[lead + i] = 0.5 * Math.cos((2 * Math.PI * 440 * i) / sampleRate)
  return samples
}

process.on("message", (msg) => {
  if (msg.type === "init") {
    config = msg.config
    speaker = msg.speaker ?? 0
    if (config.failLoad) return process.send({ type: "error", message: "model file is corrupt" })
    setTimeout(() => process.send({ type: "ready", sampleRate: config.sampleRate }), config.loadMs ?? 0)
  } else if (msg.type === "speak") {
    if (msg.text.includes("crash")) process.exit(3)
    if (msg.text.includes("hang")) return
    if (msg.text.includes("fail")) return process.send({ type: "failed", id: msg.id, message: "bad text" })
    const sleep = /sleep:(\d+)/.exec(msg.text)
    setTimeout(() => {
      process.send({ type: "audio", id: msg.id, samples: fakeSamples(msg.text, config.sampleRate, msg.sid ?? speaker) })
    }, sleep ? Number(sleep[1]) : config.delayMs)
  } else if (msg.type === "exit") {
    process.exit(0)
  }
})
