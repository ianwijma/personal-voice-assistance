import { describe, expect, it } from "@effect/vitest"
import { type Agent, type AgentEvent, type AgentTurnInput, makeToolRegistry, type Message, type Trace, type TraceMark } from "@pva/core"
import { appendFileSync } from "node:fs"
import { Effect, Stream } from "effect"
import { type ClaudeConversationOptions, makeClaudeAgent, withConversationOptions } from "../src/index.ts"

/**
 * Opt-in test against the real Claude Code with the owner's subscription (WP-13a, docs/ASSISTANTS.md). Skipped unless
 * CLAUDE_SUBSCRIPTION_LIVE=1:
 *
 *   CLAUDE_SUBSCRIPTION_LIVE=1 CLAUDE_SUBSCRIPTION_LIVE_OUT=/path/to/out.txt \
 *     pnpm --filter @pva/agent-claude-code exec vitest run test/liveAssistants.test.ts
 *
 * 1. A model change on a running session (`setModel` / the effort flag setting): the next reply reports the new model.
 * 2. `llmFirstToken` (the turn's trace mark) of the first turn after a quiet spell, with the fresh-session time on
 *    (the idle check closes the session and starts a warm spare, which the turn takes and primes from the history)
 *    and off (the same session answers). The quiet spell is simulated by moving the agent's clock past the
 *    fresh-session time; the real gap is only the wait for the idle check and the spare (30 s), so Claude's
 *    prompt cache is still warm for the "off" case, which a real quiet spell of an hour would not leave.
 *    `ROUNDS` rounds (default 5), alternating on and off; 2 short messages per round and mode.
 */
const live = process.env.CLAUDE_SUBSCRIPTION_LIVE === "1"
const out = process.env.CLAUDE_SUBSCRIPTION_LIVE_OUT
const ROUNDS = Number(process.env.ROUNDS ?? 5)
const log = (line: string) => {
  console.log(line)
  if (out !== undefined && out !== "") appendFileSync(out, `${line}\n`)
}

const SYSTEM = "You are a voice assistant. Reply in one short plain spoken sentence. No markdown."

const turnOf = (agent: Agent, conversationId: string, text: string, history: ReadonlyArray<Message>) =>
  Effect.gen(function*() {
    const marks: Partial<Record<TraceMark, number>> = {}
    const trace: Trace = { id: 1, mode: "text", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] }
    const start = performance.now()
    const input: AgentTurnInput = {
      turnId: 1,
      conversationId,
      text,
      utterance: text,
      source: "text",
      spoken: true,
      routedBy: "default",
      history: [...history],
      system: SYSTEM,
      context: undefined,
      tools: makeToolRegistry([]),
      actions: [],
      deciders: new Map(),
      promoted: Effect.void,
      speculative: false,
      mark: (m) => (marks[m] ??= performance.now() - start),
      trace,
      maxToolRounds: 1
    }
    const events: Array<AgentEvent> = Array.from(yield* Stream.runCollect(agent.turn(input)))
    const reply = events.filter((e) => e._tag === "TextDelta").map((e) => (e as { text: string }).text).join("")
    return { reply, firstToken: marks.llmFirstToken }
  })

const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

describe.skipIf(!live)("claude-subscription per assistant (live)", () => {
  it.live("a model change on a running session; first token after a quiet spell with the fresh-session time on and off", () =>
    Effect.gen(function*() {
      let skew = 0
      const handle = yield* Effect.promise(() =>
        makeClaudeAgent({ model: "claude-haiku-5-5", tools: false, speculate: false, sessionIdleMinutes: 60, now: () => Date.now() + skew })
      )
      log(`login: ${handle.info?.().login}`)
      const agent: Agent = { id: "claude-subscription", name: "Claude subscription", kind: "harness", speculate: false, firstEventTimeoutMs: 8000, turn: handle.turn, endConversation: handle.endConversation }
      const base: ClaudeConversationOptions = { model: "claude-haiku-5-5", effort: "low", thinking: "off", tools: false, sessionIdleMinutes: 1 }

      // 1. Retune.
      const a = withConversationOptions(agent, base)
      const one = yield* turnOf(a, "retune", "Name a colour.", [])
      const session = handle.session("retune")!
      log(`retune: before ${session.answeredWith} (${one.firstToken?.toFixed(0)} ms): ${JSON.stringify(one.reply)}`)
      const two = yield* turnOf(withConversationOptions(agent, { ...base, model: "claude-sonnet-5-5" }), "retune", "Name another colour.", [
        { role: "user", content: "Name a colour." },
        { role: "assistant", content: one.reply, agentId: "claude-subscription" } as Message
      ])
      log(`retune: after ${session.answeredWith} (${two.firstToken?.toFixed(0)} ms), same session ${handle.session("retune") === session}: ${JSON.stringify(two.reply)}`)
      expect(handle.session("retune")).toBe(session)
      expect(session.answeredWith ?? "").toContain("sonnet")
      yield* handle.endConversation("retune")

      // 2. Fresh session on (1 min) vs off (0), alternating.
      const firsts: Record<"on" | "off", Array<number>> = { on: [], off: [] }
      for (let round = 0; round < ROUNDS; round++) {
        for (const mode of ["on", "off"] as const) {
          const id = `${mode}-${round}`
          const c = withConversationOptions(agent, { ...base, sessionIdleMinutes: mode === "on" ? 1 : 0 })
          const first = yield* turnOf(c, id, "Say hello in three words.", [])
          const before = handle.session(id)!
          skew += 2 * 60_000 // past the fresh-session time
          yield* Effect.sleep("30 seconds") // the idle check (every 15 s) and the warm spare it starts
          const next = yield* turnOf(c, id, "Now say goodbye in three words.", [
            { role: "user", content: "Say hello in three words." },
            { role: "assistant", content: first.reply, agentId: "claude-subscription" } as Message
          ])
          const fresh = handle.session(id) !== before
          firsts[mode].push(next.firstToken ?? Number.NaN)
          log(`${mode} round ${round + 1}: first turn ${first.firstToken?.toFixed(0)} ms; after the quiet spell ${next.firstToken?.toFixed(0)} ms, fresh session ${fresh}: ${JSON.stringify(next.reply)}`)
          expect(fresh).toBe(mode === "on")
          yield* handle.endConversation(id)
          yield* Effect.sleep("3 seconds") // the replacement spare
        }
      }
      log(`llmFirstToken after a quiet spell: on median ${median(firsts.on).toFixed(0)} ms [${firsts.on.map((x) => x.toFixed(0)).join(", ")}], off median ${median(firsts.off).toFixed(0)} ms [${firsts.off.map((x) => x.toFixed(0)).join(", ")}]`)
      handle.shutdown()
    }), 900_000)
})
