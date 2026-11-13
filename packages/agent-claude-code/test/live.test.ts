import { describe, expect, it } from "@effect/vitest"
import { type AgentEvent, type AgentTurnInput, makeTool, makeToolRegistry, type Message, type Trace, type TraceMark } from "@pva/core"
import { appendFileSync, existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Schema, Stream } from "effect"
import { makeClaudeAgent, SESSION_CWD } from "../src/index.ts"

/**
 * Opt-in test against the real Claude Code with the owner's subscription.
 * Makes 7 short model calls. Skipped unless CLAUDE_SUBSCRIPTION_LIVE=1:
 *
 *   CLAUDE_SUBSCRIPTION_LIVE=1 pnpm --filter @pva/agent-claude-code test test/live.test.ts
 *
 * Checks that the adapter streams, keeps one session warm across turns,
 * interrupts and resumes on the same session, can call an assistant tool, and
 * writes no session file. Prints time to first text per turn.
 */
const live = process.env.CLAUDE_SUBSCRIPTION_LIVE === "1"
/** Also append the printed lines to this file (vitest may hide console output of passing tests). */
const out = process.env.CLAUDE_SUBSCRIPTION_LIVE_OUT
const log = (line: string) => {
  console.log(line)
  if (out !== undefined && out !== "") appendFileSync(out, `${line}\n`)
}

const clockTool = makeTool({
  name: "current_time",
  description: "The current local time. Call it whenever the user asks what time it is.",
  parameters: Schema.Struct({}),
  speculative: true,
  execute: () => Effect.succeed("It is 14:32 on Friday.")
})

const SYSTEM = "You are a voice assistant. Reply in one or two short plain spoken sentences. No markdown, no lists."

describe.skipIf(!live)("claude-subscription (live)", () => {
  it.live("streams, stays warm, interrupts and resumes, calls a tool", () =>
    Effect.gen(function*() {
      const projects = join(homedir(), ".claude", "projects")
      const sessionDir = join(projects, SESSION_CWD.replace(/[^a-zA-Z0-9]/g, "-"))
      const dirBefore = existsSync(sessionDir) ? readdirSync(sessionDir).length : -1

      const t0 = performance.now()
      const agent = yield* Effect.promise(() =>
        makeClaudeAgent({ model: "claude-haiku-5-5", tools: true, speculate: false, sessionIdleMinutes: 60 })
      )
      log(`start (spawn + initialize): ${(performance.now() - t0).toFixed(0)} ms; login: ${agent.info?.().login}`)
      const tools = makeToolRegistry([{ name: "clock", tools: [clockTool] }])
      const history: Array<Message> = []
      const sessions = new Set<number>()
      const rows: Array<string> = []

      const turn = (text: string, opts: { take?: number; label: string }) =>
        Effect.gen(function*() {
          const marks: Partial<Record<TraceMark, number>> = {}
          const trace: Trace = { id: 1, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] }
          const start = performance.now()
          const input: AgentTurnInput = {
            turnId: rows.length + 1,
            text,
            utterance: text,
            source: "voice",
            spoken: true,
            routedBy: "trigger",
            history: [...history],
            system: SYSTEM,
            context: undefined,
            tools,
            actions: [],
            deciders: new Map(),
            promoted: Effect.void,
            speculative: false,
            mark: (m) => (marks[m] ??= performance.now() - start),
            trace,
            maxToolRounds: 3
          }
          let stream: Stream.Stream<AgentEvent, unknown> = agent.turn(input)
          if (opts.take !== undefined) stream = stream.pipe(Stream.take(opts.take))
          const events = Array.from(yield* Stream.runCollect(stream))
          const total = performance.now() - start
          const reply = events.filter((e) => e._tag === "TextDelta").map((e) => (e as { text: string }).text).join("")
          const toolNames = events.filter((e) => e._tag === "ToolStarted").map((e) => (e as { call: { name: string } }).call.name)
          sessions.add(agent.session()!.id)
          const row = `${opts.label}: session ${agent.session()!.id}, sent ${marks.llmRequestSent?.toFixed(0)} ms, first text ${
            marks.llmFirstToken?.toFixed(0)
          } ms, done ${total.toFixed(0)} ms${toolNames.length > 0 ? `, tools ${toolNames.join(",")} ${trace.tools.map((t) => `${t.ms} ms`).join(",")}` : ""}: ${JSON.stringify(reply)}`
          rows.push(row)
          log(row)
          history.push({ role: "user", content: text })
          history.push({ role: "assistant", content: reply, ...(opts.take !== undefined ? { interrupted: true } : {}), agentId: "claude-subscription" } as Message)
          return { reply, toolNames, marks }
        })

      const t1 = yield* turn("What's a good name for a goldfish? One sentence.", { label: "turn 1 (warm process, first message)" })
      const t2 = yield* turn("And one for a cat? One sentence.", { label: "turn 2 (warm)" })
      const t3 = yield* turn("And for a dog? One sentence.", { label: "turn 3 (warm)" })

      // Barge-in: take the first three deltas, then the stream is closed → interrupt().
      const sessionBefore = agent.session()!.id
      const i0 = performance.now()
      yield* turn("Tell me a long story about a lighthouse keeper, at least ten sentences.", { take: 3, label: "turn 4 (interrupted after 3 deltas)" })
      const draining = agent.session()?.draining
      if (draining !== undefined) yield* Effect.promise(() => draining)
      log(`interrupt acknowledged ${(performance.now() - i0).toFixed(0)} ms after the turn started; session dead: ${agent.session()?.dead ?? "no"}`)

      const t5 = yield* turn("Sorry, what were you telling me about? One sentence.", { label: "turn 5 (after interrupt)" })
      const sameAfterInterrupt = agent.session()!.id === sessionBefore
      log(`resumed on the same session after interrupt: ${sameAfterInterrupt}`)

      const t6 = yield* turn("What time is it?", { label: "turn 6 (tool)" })
      const t7 = yield* turn("Thanks. Say goodbye in five words.", { label: "turn 7 (warm, after tool)" })

      agent.shutdown()
      yield* Effect.sleep("500 millis")
      const dirAfter = existsSync(sessionDir) ? readdirSync(sessionDir).length : -1
      log(`sessions used: ${[...sessions].join(", ")}; session files in ${sessionDir}: before ${dirBefore}, after ${dirAfter} (-1 = folder absent)`)

      for (const t of [t1, t2, t3, t5, t7]) expect(t.reply.length).toBeGreaterThan(0)
      expect(t5.reply.toLowerCase()).toMatch(/lighthouse|keeper|story/)
      expect(sameAfterInterrupt).toBe(true)
      expect(t6.toolNames).toEqual(["current_time"])
      expect(t6.reply).toMatch(/14:32|2:32/)
      expect(dirAfter).toBe(dirBefore)
    }), 180_000)
})
