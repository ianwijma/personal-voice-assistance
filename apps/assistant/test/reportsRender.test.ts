// A report's issue body (docs/REPORTS.md "The issue body"): the marker line and the few sections in their fixed order,
// none of the gathered conversation, traces, Health issues or log lines, quoting that no content can break out of, the
// cut that keeps it under a limit, a context with parts missing, and the secret scrubber. Also the parts the store splits a body into,
// and GitHub's "new issue" address.
import { MAX_REPORT_BODY_CHARS, type TraceConfig, type TraceInfo } from "@pva/protocol"
import { describe, expect, it } from "vitest"
import { issueNumberOf, MAX_NEW_ISSUE_URL, newIssueUrl } from "../src/serve/reports/github.ts"
import { closeOpenFence, code, fenced, MAX_REPORT_BODY_JSON_BYTES, missing, type ReportFacts, renderReport } from "../src/serve/reports/render.ts"
import { makeScrubber } from "../src/serve/reports/scrub.ts"
import { PART_JSON_CHARS, splitBody } from "../src/serve/reports/store.ts"

const AT = Date.UTC(2026, 10, 18, 9, 0, 0)

const trace = (turnId: number, extra: Partial<TraceInfo> = {}): TraceInfo => ({
  turnId,
  mode: "voice",
  speculative: false,
  outcome: "completed",
  marks: { llmRequestSent: 12, llmFirstToken: 420.4, firstClause: 610, ttsFirstAudio: 700, playbackStart: 760 },
  totalMs: 2400,
  tools: [{ name: "timer_set", ms: 31 }],
  voices: ["sherpa:en_US-lessac-medium"],
  deviceId: "kitchen-display",
  assistant: { id: "jeff", name: "Jeff" },
  ...extra
})

const CONFIG: TraceConfig = {
  llm: { account: "anthropic", model: "claude-haiku-4-5", effort: "low", thinking: "off", maxTokens: 1024 },
  hearing: { hearer: "jeff", engine: "sherpa", model: "parakeet-v2" },
  voice: "elevenlabs:kitchen-voice",
  voiceFrom: "device",
  modules: 1,
  tools: 1,
  moduleList: [{ id: "timers", name: "Timers" }],
  toolList: [{ name: "timer_set", module: "timers" }],
  replyEarly: true,
  toolRounds: 5
}

export const sampleFacts = (overrides: Partial<ReportFacts> = {}): ReportFacts => ({
  id: "r0123456789abcdef",
  kind: "problem",
  title: "The kitchen timer did not ring",
  description: "I set a timer for the pasta and it never rang.",
  answers: [
    { question: "What did you expect to happen?", answer: "A ring after ten minutes." },
    { question: "What did you see or hear instead?", answer: "Nothing. The screen still showed the timer at zero." }
  ],
  createdAt: AT,
  turn: { turnId: 9, conversationId: "c-now", source: "voice" },
  deviceName: "Kitchen display",
  assistantName: "Jeff",
  conversation: { conversationId: "c-now", history: [], note: "The turn the report was made in was still running, so it is not in this transcript; its words are in the description." },
  previous: {
    conversationId: "c-before",
    endedAt: AT - 12 * 60_000,
    history: [
      { role: "user", content: "Set a pasta timer for ten minutes" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "timer_set", input: { minutes: 10, label: "pasta" } }] },
      { role: "tool", results: [{ id: "t1", name: "timer_set", content: "{\"id\":\"tm-4\",\"endsAt\":\"2026-11-18T08:58:00Z\"}", isError: false }] },
      { role: "assistant", content: "Your pasta timer is set for ten minutes." }
    ]
  },
  traces: [trace(7), trace(8, { tools: [], outcome: "interrupted" })],
  device: [["Name", "Kitchen display"], ["Kind", "web-voice"], ["Room", "Kitchen"], ["Has a screen", "yes"]],
  shown: [{ kind: "timer", module: "timers", lifetime: "pinned", shownAt: AT - 11 * 60_000 }],
  assistant: [["Name", "Jeff"], ["Language model", "anthropic claude-haiku-4-5"], ["Voice", "sherpa:en_US-lessac-medium"]],
  server: [["Version", "1.4.0"], ["Protocol", "12"], ["Node", "v22.20.0"]],
  health: [{ severity: "warning", id: "timers.ring-failed", title: "A timer could not ring", detail: "The kitchen display was not connected." }],
  warnings: [{ at: AT - 60_000, level: "warning", text: "Notification nt-3 could not be delivered: no connection" }],
  ...overrides
})

const headings = (body: string) => body.split("\n").filter((l) => /^## /.test(l)).map((l) => l.replace(/ \(ended .*\)$/, ""))

describe("the report body", () => {
  it("starts with the marker line and holds only the title, what the person said and where it was said", () => {
    const { body, cut } = renderReport(sampleFacts())
    expect(body.split("\n")[0]).toBe("<!-- pva-report v1 kind=problem id=r0123456789abcdef -->")
    expect(body).toContain("**Title:** `The kitchen timer did not ring`")
    expect(headings(body)).toEqual(["## What the person reported", "## Questions asked before filing", "## Where it was said"])
    expect(cut).toEqual([])
    expect(body).toContain("I set a timer for the pasta and it never rang.")
    expect(body).toContain("Q1: What did you expect to happen?\nA1: A ring after ten minutes.")
    expect(body).toContain([
      "| Field | Value |",
      "| --- | --- |",
      "| Device | `Kitchen display` |",
      "| Device kind | `web-voice` |",
      "| Assistant | `Jeff` |",
      "| Voice | `sherpa:en_US-lessac-medium` |",
      "| Conversation | `c-now` |",
      "| Turn | `9 (voice)` |",
      "| Version | `1.4.0` |"
    ].join("\n"))
    // Gathered, but not in the body: the conversations, traces, the device's and server's other facts, Health, logs.
    for (const absent of ["Set a pasta timer", "timer_set", "tm-4", "c-before", "Room", "Has a screen", "v22.20.0", "timers.ring-failed", "nt-3", "claude-haiku"]) {
      expect(body).not.toContain(absent)
    }
    expect(body.length).toBeLessThanOrEqual(MAX_REPORT_BODY_CHARS)
  })

  it("names the voice the turn spoke with: the newest traced turn's, a device's own included", () => {
    const { body } = renderReport(sampleFacts({ traces: [trace(7, { config: CONFIG }), trace(8)] }))
    expect(body).toContain("| Voice | `elevenlabs:kitchen-voice (the device's)` |")
    expect(body).not.toContain("parakeet")
    expect(body).not.toContain("moduleList")
  })

  it("quotes content so that it cannot end its block, mention anyone, or break a table", () => {
    const evil = "done\n```\n## Injected heading\n@ianwijma ![x](https://evil.example/x.png)\n````\nstill inside"
    const { body } = renderReport(sampleFacts({ description: evil, deviceName: "Kitchen | `display`\n## Not a heading" }))
    // The quoted copy sits in a fence longer than its longest run of backticks (four here: a fence of five).
    expect(body).toContain("`````text\ndone\n```\n## Injected heading")
    expect(body.split("\n").filter((l) => l === "## Injected heading")).toHaveLength(1)
    // Outside the fences, no line is a heading the content made, and no mention is outside code.
    const outside: Array<string> = []
    let open: string | undefined
    for (const line of body.split("\n")) {
      if (open === undefined) {
        const m = /^(`{3,})/.exec(line)
        if (m !== null) open = m[1]
        else outside.push(line)
      } else if (line === open) open = undefined
    }
    expect(open).toBeUndefined()
    expect(outside.filter((l) => l.includes("Injected") || l.includes("Not a heading") && l.startsWith("##"))).toEqual([])
    expect(outside.join("\n")).not.toMatch(/(^|[^`])@ianwijma/)
    // A name in inline code: no backticks, no line break, the table's bar escaped.
    expect(code("Kitchen | `display`\n## x")).toBe("`Kitchen \\| 'display' ## x`")
    expect(body).toContain("| Device | `Kitchen \\| 'display' ## Not a heading` |")
  })

  it("leaves out a fact that is not there, and says when no questions were asked", () => {
    const { body } = renderReport(sampleFacts({
      answers: [],
      traces: missing("the report was not made on a device."),
      device: missing("the report was not made on a device."),
      shown: missing("the report was not made on a device."),
      assistant: missing("the turn names no assistant."),
      server: [],
      deviceName: undefined as never,
      assistantName: undefined as never
    }))
    expect(body).toContain("## Questions asked before filing\n\nNone: the report was filed as it was said.")
    expect(body).toContain("## Where it was said\n\n| Field | Value |\n| --- | --- |\n| Conversation | `c-now` |\n| Turn | `9 (voice)` |\n")
  })

  it("cuts at a line boundary, closing its block, when it does not fit", () => {
    const { body, cut } = renderReport(sampleFacts({ description: "d\n".repeat(3_500) }), { maxChars: 3_000 })
    expect(body.length).toBeLessThanOrEqual(3_000)
    expect(cut).toEqual(["The end of the body, cut at a line boundary to fit."])
    expect(closeOpenFence(body)).toBe(body)
    expect(body).toContain("Cut here to fit")
  })

  it("makes every text well formed: a lone half of an emoji, cut elsewhere, becomes U+FFFD", () => {
    const half = "😀".slice(0, 1)
    const { body } = renderReport(sampleFacts({ description: `cut ${half}`, title: `t ${half}`, deviceName: `d ${"😀".slice(1)}` }))
    expect(body).toContain("cut \ufffd")
    expect(body).toContain("d \ufffd")
    expect(() => encodeURIComponent(body)).not.toThrow()
    expect(() => newIssueUrl(`t ${half}`, `b ${half}`, "problem")).not.toThrow()
  })

  it("stays within what can be posted: four-byte characters are cut to the bytes", () => {
    const { body, cut } = renderReport(sampleFacts({ description: "😀".repeat(4_000) }), { maxBytes: 10_000 })
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(10_000)
    expect(cut.length).toBe(1)
    expect(closeOpenFence(body)).toBe(body)
    expect(Buffer.byteLength(JSON.stringify(renderReport(sampleFacts({ description: "😀".repeat(4_000) })).body))).toBeLessThanOrEqual(MAX_REPORT_BODY_JSON_BYTES)
  })

  it("replaces known secrets and well-known token formats everywhere, before anything is cut", () => {
    const known = "vault-secret-value-1234"
    const scrubber = makeScrubber([known, "short"])
    const leaks = [
      `the key is ${known}`,
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "{\"api_key\": \"0123456789abcdef0123456789abcdef\"}",
      "PASSWORD=correct-horse-battery-staple"
    ]
    const { body } = renderReport(sampleFacts({ description: leaks.join("\n"), deviceName: `Kitchen ${known}` }), { scrub: scrubber.scrub })
    expect(body).not.toContain(known)
    expect(body).not.toMatch(/abcdefghijklmnopqrstuvwxyz/)
    expect(body).not.toContain("correct-horse")
    expect(body).toContain("Bearer [secret]")
    expect(body).toContain("\"api_key\": \"[secret]\"")
    // Ordinary words and short values stay.
    expect(scrubber.scrub("a small token count of 12, maxTokens: 1024, shorter")).toBe("a small token count of 12, maxTokens: 1024, shorter")
    // The short known value "short" is replaced as a word.
    expect(scrubber.scrub("in short")).toBe("in [secret]")
  })
})

describe("the scrubber", () => {
  it("replaces a short known value as a whole word only", () => {
    const { scrub } = makeScrubber(["1234", "pw9"])
    expect(scrub("the code is 1234, the vault pw9.")).toBe("the code is [secret], the vault [secret].")
    expect(scrub("12345 and x1234 and pw99")).toBe("12345 and x1234 and pw99")
    // One or two characters are never looked for.
    expect(makeScrubber(["7"]).scrub("7 days")).toBe("7 days")
  })

  it("replaces credentials in an address, key-like query values and Google keys", () => {
    const { scrub } = makeScrubber([])
    expect(scrub("fetch https://sam:hunter2@cal.example.org/feed.ics now")).toBe("fetch https://sam:[secret]@cal.example.org/feed.ics now")
    expect(scrub("https://api.openweathermap.org/data?q=Utrecht&appid=0123abcd&units=metric")).toBe("https://api.openweathermap.org/data?q=Utrecht&appid=[secret]&units=metric")
    for (const name of ["key", "api_key", "token", "access_token", "apikey"]) {
      expect(scrub(`https://x.example/?${name}=s3cr3tvalue&a=1`)).toBe(`https://x.example/?${name}=[secret]&a=1`)
    }
    expect(scrub("maps key AIzaSyA1234567890abcdefghijklmnopqrstu")).toBe("maps key [secret]")
    // Ordinary addresses stay.
    expect(scrub("https://example.org/page?q=pasta&page=2")).toBe("https://example.org/page?q=pasta&page=2")
  })
})

describe("the pieces", () => {
  it("a fence is longer than any run of backticks, at most 21", () => {
    expect(fenced("a ``` b")).toBe("````text\na ``` b\n````")
    expect(fenced("plain")).toBe("```text\nplain\n```")
    const long = fenced("`".repeat(500))
    expect(long.startsWith("`".repeat(21) + "text\n")).toBe(true)
    expect(long).toContain("(480 more backticks)")
  })

  it("splits a body into parts whose JSON fits a row, never inside a surrogate pair, and joins back to the body", () => {
    const body = `${"\"\\\n".repeat(4_000)}${"😀".repeat(9_000)}${"\u0001".repeat(3_000)}${"plain ".repeat(3_000)}`
    const parts = splitBody(body)
    expect(parts.join("")).toBe(body)
    for (const p of parts) {
      expect(JSON.stringify({ text: p }).length).toBeLessThanOrEqual(PART_JSON_CHARS + 20)
      const last = p.charCodeAt(p.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
    expect(splitBody("")).toEqual([])
  })

  it("the new-issue address carries the whole body when it fits, and a cut at a line boundary with a note when not", () => {
    const small = newIssueUrl("Timer", "line one\nline two", "problem")
    expect(small.fits).toBe(true)
    expect(small.url).toBe("https://github.com/ianwijma/personal-voice-assistance/issues/new?title=Timer&labels=bug%2Cvoice-report&body=line%20one%0Aline%20two")
    const body = Array.from({ length: 2_000 }, (_, i) => `line ${i} ${"é".repeat(20)}`).join("\n")
    const big = newIssueUrl("A feature", body, "feature")
    expect(big.fits).toBe(false)
    expect(big.url.length).toBeLessThanOrEqual(MAX_NEW_ISSUE_URL)
    expect(big.url).toContain("labels=enhancement%2Cvoice-report")
    const sent = decodeURIComponent(big.url.slice(big.url.indexOf("&body=") + 6))
    expect(sent).toMatch(/^line 0 /)
    expect(sent).toContain("Cut to fit an address")
    // Whole lines only.
    const kept = sent.split("\n\n_(Cut")[0]!.split("\n")
    expect(kept.every((l) => /^line \d+ é{20}$/.test(l))).toBe(true)
  })

  it("an issue address of the repository, exactly", () => {
    expect(issueNumberOf("https://github.com/ianwijma/personal-voice-assistance/issues/142")).toBe(142)
    for (const bad of [
      "https://github.com/ianwijma/personal-voice-assistance/issues/142/",
      "https://github.com/ianwijma/personal-voice-assistance/pull/142",
      "https://github.com/someone/personal-voice-assistance/issues/142",
      "http://github.com/ianwijma/personal-voice-assistance/issues/142",
      "https://github.com/ianwijma/personal-voice-assistance/issues/0",
      "https://github.com/ianwijma/personal-voice-assistance/issues/142?x=1",
      "https://github.com.evil.example/ianwijma/personal-voice-assistance/issues/1"
    ]) expect(issueNumberOf(bad)).toBeUndefined()
  })
})
