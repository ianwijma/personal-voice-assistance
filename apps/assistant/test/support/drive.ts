/**
 * Drive a running `serve` with the scripted client: say hello, claim the audio,
 * speak each WAV (16 kHz mono) into it in real time followed by silence until
 * the reply has finished, and print the message timeline and each turn's trace.
 *
 *   pnpm --filter @pva/assistant exec tsx test/support/drive.ts [--url http://127.0.0.1:8787] [--mode instant] [--reload] file.wav...
 *
 * Protocol 5: settings and profiles are admin only. `--mode`, `--reload`, `--model` and `--record` need the admin
 * password (`--admin-password`, or `PVA_ADMIN_PASSWORD` in the environment); they use a second, admin connection.
 * `--mode` sets the interrupt mode as an override of this script's own device (not the kind defaults).
 * `--reload` first saves a listening setting and reloads the engines (prints how long that took).
 * `--model <preset>` first chooses that speech recognition model in the settings and reloads the engines.
 * `--record` first switches on "Save what the assistant hears".
 */
import { parseWav } from "@pva/audio-file"
import type { ServerMessage } from "@pva/protocol"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ScriptedClient } from "./scriptedClient.ts"

const args = process.argv.slice(2)
let url = "http://127.0.0.1:8787"
let mode: "instant" | "confirm" | "manual" | undefined
let adminPassword = process.env.PVA_ADMIN_PASSWORD
let reload = false
let model: string | undefined
let record = false
const files: Array<string> = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") url = args[++i]!
  else if (args[i] === "--mode") mode = args[++i] as typeof mode
  else if (args[i] === "--reload") reload = true
  else if (args[i] === "--model") model = args[++i]!
  else if (args[i] === "--record") record = true
  else if (args[i] === "--admin-password") adminPassword = args[++i]!
  else files.push(resolve(process.env.INIT_CWD ?? process.cwd(), args[i]!))
}
if (files.length === 0) {
  console.error("Usage: drive.ts [--url URL] [--mode instant|confirm|manual] file.wav...")
  process.exit(2)
}

const t0 = performance.now()
const at = () => `${String(Math.round(performance.now() - t0)).padStart(6)} ms`
const describe = (m: ServerMessage): string => {
  switch (m.type) {
    case "state":
      return `state ${m.state}${m.turnId !== undefined ? ` #${m.turnId}` : ""}`
    case "transcript":
      return `transcript "${m.text}"`
    case "turn.start":
      return `turn.start #${m.turnId} ${m.source} "${m.userText}" spoken=${m.spoken}`
    case "assistant.text":
      return `assistant.text #${m.turnId} clause=${m.clause} "${m.text}"${m.voice !== undefined ? ` (${m.voice})` : ""}`
    case "assistant.playing":
      return `assistant.playing #${m.turnId} clause=${m.clause}`
    case "reply.start":
      return `reply.start #${m.turnId} ${m.sampleRate} Hz`
    case "turn.end":
      return `turn.end #${m.turnId} ${m.outcome} trace=${JSON.stringify(m.trace)}`
    case "error":
      return `error ${m.error.code}: ${m.error.message}`
    case "engine":
      return `engine ${m.engine.state}${m.engine.problems.length > 0 ? ` ${JSON.stringify(m.engine.problems)}` : ""}`
    default:
      return m.type
  }
}

const client = await ScriptedClient.connect({ url })
const welcome = await client.hello()
console.log(`${at()}  welcome: engine ${welcome.snapshot.engine.ready ? "ready" : "not ready"}, device ${client.device.id}`)
const needsAdmin = mode !== undefined || reload || model !== undefined || record
if (needsAdmin && (adminPassword === undefined || adminPassword === "")) {
  console.error("--mode, --reload, --model and --record need --admin-password (or PVA_ADMIN_PASSWORD)")
  process.exit(2)
}
const admin = needsAdmin ? await ScriptedClient.connect({ url }) : client
if (needsAdmin) {
  const logged = await admin.admin(adminPassword!)
  console.log(`${at()}  admin: modules ${logged.snapshot.modules.map((m) => `${m.id}:${m.state}`).join(", ")}`)
}
let printed = client.messages.length
const flush = () => {
  for (; printed < client.messages.length; printed++) console.log(`${at()}  ${describe(client.messages[printed]!)}`)
}
const ticker = setInterval(flush, 20)

if (!welcome.snapshot.engine.ready) await client.waitFor("engine.summary", (m) => m.engine.ready, { timeoutMs: 60_000, from: 0 })
if (mode !== undefined) {
  // The device record is saved right after hello; retry while it is not there yet.
  for (let attempt = 0; attempt < 20; attempt++) {
    admin.send({ type: "device.admin.update", requestId: `mode${attempt}`, id: client.device.id, patch: { interruptMode: mode } })
    const r = await admin.waitFor("result", (m) => m.requestId === `mode${attempt}`, { from: 0 })
    if (r.ok || r.error?.code !== "unknown_device") {
      console.log(`${at()}  >>> mode ${mode}: ${JSON.stringify(r)}`)
      break
    }
    await new Promise((done) => setTimeout(done, 100))
  }
}
if (record) {
  admin.send({ type: "settings.update", requestId: "rec", sectionId: "listening", patch: { values: { RECORD_HEARD_AUDIO: true }, secrets: {} } })
  console.log(`${at()}  >>> record: ${JSON.stringify(await admin.waitFor("result", (m) => m.requestId === "rec", { from: 0 }))}`)
}
if (reload || model !== undefined) {
  const values = model !== undefined ? { STT_SHERPA_MODEL: model } : { STT_SHERPA_FINAL_SILENCE_MS: 550 }
  admin.send({ type: "settings.update", requestId: "s1", sectionId: "listening", patch: { values, secrets: {} } })
  const saved = await admin.waitFor("result", (m) => m.requestId === "s1", { from: 0 })
  console.log(`${at()}  >>> settings.update: ${JSON.stringify(saved)}`)
  const started = performance.now()
  admin.send({ type: "engine.reload", requestId: "r1" })
  const reloaded = await admin.waitFor("result", (m) => m.requestId === "r1", { from: 0, timeoutMs: 60_000 })
  console.log(`${at()}  >>> engine.reload: ${JSON.stringify(reloaded)} after ${(performance.now() - started).toFixed(0)} ms`)
  const engine = [...admin.messages].reverse().find((m) => m.type === "engine")
  if (engine?.type === "engine") console.log(`${at()}  >>> engines: ${engine.engine.engines.map((e) => `${e.stage}=${e.provider} ${e.detail}`).join(", ")}`)
}
await client.claim()
await client.silence(1_000)
for (const file of files) {
  const wav = parseWav(readFileSync(file))
  if (wav.sampleRate !== 16_000 || wav.channels !== 1) throw new Error(`${file}: need 16 kHz mono, got ${wav.sampleRate} Hz × ${wav.channels}`)
  console.log(`${at()}  >>> speaking ${file} (${(wav.data.length / 32_000).toFixed(2)} s)`)
  const from = client.messages.length
  await client.streamPcm(wav.data)
  const speechEnd = performance.now()
  console.log(`${at()}  >>> end of speech`)
  // Keep the microphone running (quiet) until the reply has finished.
  let done = false
  const ended = client.waitFor("turn.end", () => true, { from, timeoutMs: 30_000 }).finally(() => {
    done = true
  })
  while (!done) await client.silence(100)
  const end = await ended
  const sent = client.messages.slice(from).find((m) => m.type === "reply.start")
  console.log(`${at()}  >>> turn #${end.turnId} ${end.outcome}; playbackStart ${end.trace.marks.playbackStart?.toFixed(0)} ms after end of turn; ` +
    `first reply audio ${sent === undefined ? "-" : "received"}; total since end of speech ${(performance.now() - speechEnd).toFixed(0)} ms; ` +
    `reply samples ${client.replySamples.get(end.turnId) ?? 0}`)
  await client.silence(500)
}
flush()
clearInterval(ticker)
if (admin !== client) admin.close()
client.close()
await client.closed
