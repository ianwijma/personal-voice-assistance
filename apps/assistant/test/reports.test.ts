// The host's reports (docs/REPORTS.md) on an in-memory household store and an offline network: drafting gathers the
// turn's context and keeps the report (its body in parts), the admin operations read and change it, sending files one
// issue (never retried, never twice at once), every GitHub failure is one line without the token, GitHub's answer is
// checked, sending at once, retention, and the reports read back by a new service on the same store.
import { makeTestTurn, makeMemoryHouseholdStore, makeOfflineNet, type OfflineConnector } from "@pva/core/testing"
import { CurrentTurn, type Message, type ReportInput, type ReportsService, StoreError, type TurnContext } from "@pva/core"
import { REPORT_LABEL } from "@pva/protocol"
import { it as effect } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import type { ReportSources } from "../src/serve/reports/context.ts"
import { makePreviousConversations } from "../src/serve/reports/previous.ts"
import { makeReports, MAX_KEPT_REPORTS, MAYBE_FILED, type ReportsOptions } from "../src/serve/reports/Reports.ts"
import { MAX_REPORT_BODY_JSON_BYTES, wellFormed } from "../src/serve/reports/render.ts"
import type { HouseholdStore } from "@pva/core"
import { reports as reportRows, reportsStorage } from "../src/serve/reports/store.ts"

const ISSUES = "https://api.github.com/repos/ianwijma/personal-voice-assistance/issues"
const TOKEN = "github_pat_11ABCDEFG0reports_service_test_token"
const VAULT_SECRET = "vault-held-secret-value-0042"
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

const history: ReadonlyArray<Message> = [
  { role: "user", content: `Set a pasta timer for ten minutes, my key is ${VAULT_SECRET}` },
  { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "timer_set", input: { minutes: 10 } }] },
  { role: "tool", results: [{ id: "t1", name: "timer_set", content: "{\"id\":\"tm-1\"}", isError: false }] },
  { role: "assistant", content: "Your pasta timer is set." }
]

const sources = (overrides: Partial<ReportSources> = {}): ReportSources => ({
  conversation: () => Effect.succeed({ conversationId: "conversation-1", history }),
  previous: () => undefined,
  traces: () => [],
  device: () => ({ name: "Kitchen display", facts: [["Name", "Kitchen display"]], shown: [] }),
  assistant: () => ({ name: "Jeff", facts: [["Name", "Jeff"]] }),
  server: () => [["Version", "0.0.0"]],
  health: () => [],
  warnings: () => [],
  ...overrides
})

const store = async () => {
  const s = makeMemoryHouseholdStore()
  await run(s.prepare([], [reportsStorage]))
  return s
}

const input = (overrides: Partial<ReportInput> = {}): ReportInput => ({
  kind: "problem",
  title: "The timer did not ring",
  description: "It never rang.",
  send: false,
  ...overrides
})

/** The turn the report is made in: the host reads it from `CurrentTurn`, as the gateway provides it around a tool call. */
const TURN = makeTestTurn({ device: "kitchen-display" })
const inTurn = (reports: { readonly service: ReportsService }, i: ReportInput, turn: TurnContext = TURN) => reports.service.draft(i).pipe(Effect.provideService(CurrentTurn, turn))

const created = (n: number) => ({ status: 201, body: { number: n, html_url: `https://github.com/ianwijma/personal-voice-assistance/issues/${n}`, title: "x", user: { login: "someone" } } })

const make = (s: Awaited<ReturnType<typeof store>>, options: Partial<ReportsOptions> = {}) =>
  run(makeReports({ store: s, sources: sources(), knownSecrets: () => [VAULT_SECRET], ...options }))


/** A store whose `core.reports` writes or reads fail while the test says so (the rest is the memory store's). */
const faulty = (inner: HouseholdStore, flags: { failWrites: number; failList: boolean }): HouseholdStore => {
  const broken = () => new StoreError({ reason: "failed", message: "the disk said no" })
  return {
    ...inner,
    forCore: (owner) => {
      const core = inner.forCore(owner)
      return {
        ...core,
        collection: (c) => {
          const h = core.collection(c)
          return {
            ...h,
            list: (q) => (flags.failList ? Effect.fail(broken()) : h.list(q)),
            update: (id, f, o) => Effect.suspend(() => (flags.failWrites > 0 ? (flags.failWrites--, Effect.fail(broken())) : h.update(id, f, o)))
          }
        },
        transaction: (f) => Effect.suspend(() => (flags.failWrites > 0 ? (flags.failWrites--, Effect.fail(broken())) : core.transaction(f)))
      }
    }
  }
}

describe("the host's reports", () => {
  it("keeps a draft with its context, lists it, and reads it back from a new service on the same store", async () => {
    const s = await store()
    const reports = await make(s)
    expect(reports.available()).toBe(true)
    expect(reports.settings()).toEqual({ hasToken: false, sendImmediately: false })
    const drafted = await run(inTurn(reports, input({ answers: [{ question: "What did you expect?", answer: "A ring." }] })))
    expect(drafted.status).toBe("draft")
    expect(drafted.id).toMatch(/^r[0-9a-f]{16}$/)
    const page = await run(reports.list({ limit: 20 }))
    expect(page.reports.map((r) => [r.id, r.kind, r.title, r.status, r.deviceName, r.assistantName])).toEqual([[drafted.id, "problem", "The timer did not ring", "draft", "Kitchen display", "Jeff"]])
    const detail = await run(reports.get(drafted.id))
    expect(detail.body.split("\n")[0]).toBe(`<!-- pva-report v1 kind=problem id=${drafted.id} -->`)
    expect(detail.body).toContain("Set a pasta timer for ten minutes")
    expect(detail.body).toContain("Q1: What did you expect?\nA1: A ring.")
    // The vault's secret was in the history: it is not in the body.
    expect(detail.body).not.toContain(VAULT_SECRET)
    expect(detail.body).toContain("[secret]")
    expect(detail.bodyFits).toBe(true)
    expect(detail.newIssueUrl.startsWith("https://github.com/ianwijma/personal-voice-assistance/issues/new?title=The%20timer%20did%20not%20ring&labels=bug%2Cvoice-report&body=")).toBe(true)
    // A new service on the same store (a restart of the server keeps the store) reads it back.
    const again = await make(s)
    expect((await run(again.get(drafted.id))).body).toBe(detail.body)
  })

  it("leaves out what is not there and says why", async () => {
    const s = await store()
    const reports = await make(s, {
      sources: sources({
        conversation: () => Effect.succeed(undefined),
        device: () => undefined,
        assistant: () => {
          throw new Error("broken")
        },
        warnings: () => undefined
      })
    })
    const drafted = await run(inTurn(reports, input()))
    const body = (await run(reports.get(drafted.id))).body
    expect(body).toContain("## Conversation\n\nNot available: the device has no voice session now")
    expect(body).toContain("## Device\n\nNot available: the device \"kitchen-display\" is not known (any more).")
    expect(body).toContain("## Assistant\n\nNot available: it could not be read.")
    expect(body).toContain("Not available: this mode keeps no log lines.")
  })

  it("adds the previous conversation of the device and assistant, and not the report's own", async () => {
    const previous = makePreviousConversations()
    previous.ended("kitchen-display", "jeff", "conversation-0", [{ role: "user", content: "Set a pasta timer" }, { role: "assistant", content: "Set." }])
    const s = await store()
    const reports = await make(s, { sources: sources({ conversation: () => Effect.succeed({ conversationId: "conversation-1", history: [] }), previous: (d, a) => previous.get(d, a) }) })
    const body = (await run(reports.get((await run(inTurn(reports, input()))).id))).body
    expect(body).toMatch(/## Previous conversation \(ended [0-9T:.-]+Z\)/)
    expect(body).toContain("Set a pasta timer")
    // Another boundary (the device's privacy changed since): not handed on.
    previous.ended("kitchen-display", "jeff", "conversation-0", [{ role: "user", content: "private words" }], "[\"private\",null]")
    expect(previous.get("kitchen-display", "jeff", "[\"public\",null]")).toBeUndefined()
    expect(previous.get("kitchen-display", "jeff", "[\"private\",null]")?.history).toHaveLength(1)
  })

  it("sends one issue with the token, labels and body, records it, and refuses to send it again", async () => {
    const net = makeOfflineNet({ [ISSUES]: created(142) })
    const s = await store()
    const reports = await make(s, { github: { resolver: net.resolver, connector: net.connector as unknown as OfflineConnector as never } })
    const drafted = await run(inTurn(reports, input()))
    // No token: refused before anything is sent.
    const noToken = await run(Effect.flip(reports.send(drafted.id)))
    expect([noToken.status, noToken.code]).toEqual([400, "no_token"])
    expect(net.requests).toHaveLength(0)
    await run(reports.service.configure({ token: TOKEN, sendImmediately: false }))
    expect(reports.settings()).toEqual({ hasToken: true, sendImmediately: false })
    const sent = await run(reports.send(drafted.id))
    expect(sent.status).toBe("sent")
    expect(sent.issue).toEqual({ number: 142, url: "https://github.com/ianwijma/personal-voice-assistance/issues/142" })
    expect(sent.sentAt).toBeTypeOf("number")
    expect(net.requests).toHaveLength(1)
    const [request] = net.requests
    expect(request?.method).toBe("POST")
    expect(request?.url).toBe(ISSUES)
    expect(request?.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(request?.headers["accept"]).toBe("application/vnd.github+json")
    expect(request?.headers["user-agent"]).toBe("personal-voice-assistance/1")
    const posted = JSON.parse(request?.body ?? "{}") as { title: string; body: string; labels: Array<string> }
    expect(posted.title).toBe("The timer did not ring")
    expect(posted.labels).toEqual(["bug", REPORT_LABEL])
    expect(posted.body).toBe((await run(reports.get(drafted.id))).body)
    expect(posted.body).not.toContain(TOKEN)
    // Sent: not again, and not changed.
    expect((await run(Effect.flip(reports.send(drafted.id)))).code).toBe("already_sent")
    expect((await run(Effect.flip(reports.update(drafted.id, { title: "Other" })))).code).toBe("already_sent")
    expect(net.requests).toHaveLength(1)
    // A feature is an enhancement.
    const feature = await run(inTurn(reports, input({ kind: "feature", title: "Recipes" })))
    await run(reports.send(feature.id))
    expect((JSON.parse(net.requests[1]?.body ?? "{}") as { labels: Array<string> }).labels).toEqual(["enhancement", REPORT_LABEL])
  })

  it("says in one line why GitHub refused, never with the token, and sends nothing again by itself", async () => {
    const cases: ReadonlyArray<readonly [unknown, RegExp]> = [
      [{ status: 401, body: { message: `Bad credentials ${TOKEN}` } }, /refused the token \(401\)/],
      [{ status: 403, body: { message: "Resource not accessible" } }, /\(403\).*Issues: read and write/],
      [{ status: 403, headers: { "x-ratelimit-remaining": "0" }, body: { message: "API rate limit exceeded" } }, /rate limit was reached \(403\)/],
      [{ status: 404, body: { message: "Not Found" } }, /404/],
      [{ status: 410, body: { message: "Issues are disabled for this repo" } }, /Issues are switched off.*\(410\)/],
      [{ status: 422, body: { message: "Validation Failed" } }, /not valid \(422\)/],
      [{ status: 429, body: {} }, /\(429\)/],
      [{ status: 502, body: "bad gateway" }, /\(502\).*may or may not have been filed/],
      // Answers that are not an issue of the repository: not believed.
      [{ status: 201, body: { number: 5, html_url: "https://github.com/someone/else/issues/5" } }, /not an issue of ianwijma\/personal-voice-assistance/],
      [{ status: 201, body: { number: 5, html_url: "https://github.com/ianwijma/personal-voice-assistance/issues/6" } }, /not an issue of/],
      [{ status: 201, body: { html_url: 3 } }, /not with an issue/]
    ]
    for (const [answer, expected] of cases) {
      const net = makeOfflineNet({ [ISSUES]: answer as never })
      const s = await store()
      const reports = await make(s, { github: { resolver: net.resolver, connector: net.connector as never } })
      await run(reports.service.configure({ token: TOKEN, sendImmediately: false }))
      const drafted = await run(inTurn(reports, input()))
      const failed = await run(reports.send(drafted.id))
      expect(failed.status).toBe("failed")
      expect(failed.lastError).toMatch(expected)
      expect(failed.lastError).not.toContain(TOKEN)
      expect(failed.lastError!.length).toBeLessThanOrEqual(300)
      expect(failed.lastError).not.toMatch(/\n/)
      expect(net.requests).toHaveLength(1)
      // Failed: it can be sent again, by the owner.
      expect((await run(reports.list({ limit: 1 }))).reports[0]?.status).toBe("failed")
    }
  })

  it("never sends one report twice at the same time", async () => {
    const net = makeOfflineNet({ [ISSUES]: created(5) })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow: OfflineConnector = async (request) => {
      await gate
      return (net.connector as OfflineConnector)(request)
    }
    const s = await store()
    const reports = await make(s, { github: { resolver: net.resolver, connector: slow as never } })
    await run(reports.service.configure({ token: TOKEN, sendImmediately: false }))
    const drafted = await run(inTurn(reports, input()))
    const first = Effect.runPromise(reports.send(drafted.id))
    await new Promise((r) => setTimeout(r, 20))
    const second = await run(Effect.flip(reports.send(drafted.id)))
    expect([second.status, second.code]).toEqual([409, "sending"])
    expect((await run(Effect.flip(reports.update(drafted.id, { title: "x" })))).code).toBe("sending")
    expect((await run(Effect.flip(reports.remove(drafted.id)))).code).toBe("sending")
    release()
    expect((await first).status).toBe("sent")
    expect(net.requests).toHaveLength(1)
  })


  it("reads the turn itself: outside a turn it refuses, and it attaches no conversation but the turn's own", async () => {
    const s = await store()
    const reports = await make(s)
    const outside = await Effect.runPromiseExit(reports.service.draft(input()))
    expect(outside._tag).toBe("Failure")
    expect((await run(reports.list({ limit: 20 }))).reports).toHaveLength(0)
    // The device's conversation is another one than the turn's: not attached.
    const other = await run(inTurn(reports, input(), makeTestTurn({ device: "kitchen-display", conversationId: "someone-elses" })))
    const body = (await run(reports.get(other.id))).body
    expect(body).toContain("## Conversation\n\nNot available: the device's conversation changed")
    expect(body).not.toContain("Set a pasta timer")
  })

  it("keeps an emoji cut in half by the history's bound readable: the body, the address and Send work", async () => {
    const net = makeOfflineNet({ [ISSUES]: created(9) })
    const half = "😀".slice(0, 1)
    const s = await store()
    const reports = await make(s, {
      github: { resolver: net.resolver, connector: net.connector as never },
      sources: sources({ conversation: () => Effect.succeed({ conversationId: TURN.conversationId, history: [{ role: "user", content: `cut here ${half}` }] }), warnings: () => [{ at: 0, level: "warning", text: `log ${half}` }] })
    })
    await run(reports.service.configure({ token: TOKEN, sendImmediately: false }))
    const drafted = await run(inTurn(reports, input({ title: `Title ${half}`, description: `desc ${half}` })))
    const detail = await run(reports.get(drafted.id))
    expect(detail.body).toContain("cut here \ufffd")
    expect(wellFormed(detail.body)).toBe(detail.body)
    expect(() => decodeURIComponent(detail.newIssueUrl)).not.toThrow()
    // An owner's edit with a lone half: saved well formed.
    const edited = await run(reports.update(drafted.id, { body: `edited ${"😀".slice(1)} end`, title: `T ${half}` }))
    expect(edited.body).toBe("edited \ufffd end")
    expect(edited.title).toBe("T \ufffd")
    expect((await run(reports.send(drafted.id))).status).toBe("sent")
  })

  it("keeps a body of four-byte characters within what can be posted, as rendered and as edited", async () => {
    const net = makeOfflineNet({ [ISSUES]: created(10) })
    const s = await store()
    const wide = "😀".repeat(14_000)
    const reports = await make(s, { github: { resolver: net.resolver, connector: net.connector as never }, sources: sources({ conversation: () => Effect.succeed({ conversationId: TURN.conversationId, history: [{ role: "user", content: wide }, { role: "assistant", content: wide }] }) }) })
    await run(reports.service.configure({ token: TOKEN, sendImmediately: false }))
    const drafted = await run(inTurn(reports, input({ description: "😀".repeat(3_000) })))
    const body = (await run(reports.get(drafted.id))).body
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(MAX_REPORT_BODY_JSON_BYTES)
    const edited = await run(reports.update(drafted.id, { body: "中文".repeat(29_000) }))
    expect(edited.body.length).toBeLessThan(58_000)
    expect(Buffer.byteLength(JSON.stringify(edited.body))).toBeLessThanOrEqual(MAX_REPORT_BODY_JSON_BYTES)
    expect(edited.body).toContain("Cut here to fit")
    expect((await run(reports.send(drafted.id))).status).toBe("sent")
  })

  it("GitHub filed it but the record failed: it counts as sent, a second Send posts nothing, and the record is written later", async () => {
    const flags = { failWrites: 0, failList: false }
    const inner = await store()
    const net = makeOfflineNet({
      [ISSUES]: () => {
        // The answer arrives; every write after it fails for a while.
        flags.failWrites = 100
        return created(21)
      }
    })
    const reports = await make(faulty(inner, flags), { github: { resolver: net.resolver, connector: net.connector as never } })
    await run(reports.service.configure({ token: TOKEN, sendImmediately: false }))
    const drafted = await run(inTurn(reports, input()))
    const sent = await run(reports.send(drafted.id))
    expect(sent).toMatchObject({ status: "sent", issue: { number: 21 } })
    const again = await run(Effect.flip(reports.send(drafted.id)))
    expect(again.code).toBe("already_sent")
    expect(net.requests).toHaveLength(1)
    // The store answers again: the record is written at the next use, and a new service reads it as sent.
    flags.failWrites = 0
    expect((await run(reports.list({ limit: 5 }))).reports[0]?.status).toBe("sent")
    const restarted = await make(inner)
    expect((await run(restarted.get(drafted.id))).issue?.number).toBe(21)
  })

  it("a send whose result was never recorded (the server stopped) shows as failed: it may have been filed", async () => {
    const s = await store()
    const reports = await make(s)
    const drafted = await run(inTurn(reports, input()))
    // The marker as a send writes it before the request leaves; then the process stops.
    await run(s.forCore("core.reports").collection(reportRows).update(drafted.id, (v) => ({ ...v, attemptedAt: 1 })))
    const restarted = await make(s)
    const shown = await run(restarted.get(drafted.id))
    expect(shown.status).toBe("failed")
    expect(shown.lastError).toBe(MAYBE_FILED)
    expect(MAYBE_FILED.length).toBeLessThanOrEqual(300)
  })

  it("a lost answer keeps the marker and says it may have been filed; a refusal clears it", async () => {
    const lost: OfflineConnector = (request) => {
      request.onConnect?.()
      return Promise.reject(new Error("socket hang up"))
    }
    const net = makeOfflineNet({ [ISSUES]: created(1) })
    const s = await store()
    const a = await make(s, { github: { resolver: net.resolver, connector: lost as never } })
    await run(a.service.configure({ token: TOKEN, sendImmediately: false }))
    const one = await run(a.send((await run(inTurn(a, input()))).id))
    expect(one.lastError).toMatch(/may or may not have been filed/)
    const refused = makeOfflineNet({ [ISSUES]: { status: 422, body: {} } })
    const b = await make(s, { github: { resolver: refused.resolver, connector: refused.connector as never } })
    await run(b.service.configure({ token: TOKEN, sendImmediately: false }))
    const two = await run(b.send((await run(inTurn(b, input()))).id))
    expect(two.lastError).toMatch(/\(422\)/)
    const stored = await run(s.forCore("core.reports").collection(reportRows).list({}))
    expect(stored.find((r) => r.id === one.id)?.value.attemptedAt).toBeTypeOf("number")
    expect(stored.find((r) => r.id === two.id)?.value.attemptedAt).toBeUndefined()
  })

  it("tells the host when the report module took its settings back", async () => {
    let stopped = 0
    const reports = await make(await store(), { onStopped: () => void stopped++ })
    expect(reports.active()).toBe(false)
    await run(reports.service.configure({ sendImmediately: false }))
    expect(reports.active()).toBe(true)
    await run(reports.service.configure(undefined))
    expect([reports.active(), stopped]).toEqual([false, 1])
  })

  it("reports that could not be read at start: none are kept or shown, and nothing is evicted", async () => {
    const flags = { failWrites: 0, failList: false }
    const inner = await store()
    const first = await make(inner)
    const kept = await run(inTurn(first, input()))
    flags.failList = true
    const reports = await make(faulty(inner, flags))
    expect(reports.available()).toBe(false)
    expect((await Effect.runPromiseExit(inTurn(reports, input())))._tag).toBe("Failure")
    expect((await run(Effect.flip(reports.get(kept.id)))).status).toBe(503)
    // The report is still in the store.
    expect((await run(inner.forCore("core.reports").collection(reportRows).list({}))).map((r) => r.id)).toEqual([kept.id])
  })

  it("says when GitHub cannot be reached, and when it did not answer in time", async () => {
    // Offline: the name does not resolve.
    const offline = makeOfflineNet({})
    const s = await store()
    const a = await make(s, { github: { resolver: offline.resolver, connector: offline.connector as never } })
    await run(a.service.configure({ token: TOKEN, sendImmediately: false }))
    const one = await run(a.send((await run(inTurn(a, input()))).id))
    expect(one.lastError).toBe("GitHub could not be reached (is the server offline?). Nothing was sent.")
    // A server that never answers: the time limit, and "may or may not".
    const net = makeOfflineNet({ [ISSUES]: created(1) })
    const hanging: OfflineConnector = (request) => {
      request.onConnect?.()
      return new Promise(() => undefined)
    }
    const b = await make(s, { github: { resolver: net.resolver, connector: hanging as never, timeoutMs: 100 } })
    await run(b.service.configure({ token: TOKEN, sendImmediately: false }))
    const two = await run(b.send((await run(inTurn(b, input()))).id))
    expect(two.status).toBe("failed")
    expect(two.lastError).toMatch(/did not answer within 0.1 s; the issue may or may not have been filed/)
  })

  it("sends at once when the module's settings say so, and keeps it as failed when that does not work", async () => {
    const net = makeOfflineNet({ [ISSUES]: created(7) })
    const s = await store()
    const reports = await make(s, { github: { resolver: net.resolver, connector: net.connector as never } })
    await run(reports.service.configure({ token: TOKEN, sendImmediately: true }))
    expect(reports.settings()).toEqual({ hasToken: true, sendImmediately: true })
    // The tool was not declared to send (`send: false`): kept, whatever the setting says.
    expect((await run(inTurn(reports, input()))).status).toBe("draft")
    expect(net.requests).toHaveLength(0)
    expect(await run(inTurn(reports, input({ send: true })))).toMatchObject({ status: "sent", issueNumber: 7 })
    // Without a token nothing is sent at once.
    await run(reports.service.configure({ sendImmediately: true }))
    expect((await run(inTurn(reports, input({ send: true })))).status).toBe("draft")
    const down = makeOfflineNet({ [ISSUES]: { status: 500, body: "" } })
    const other = await make(await store(), { github: { resolver: down.resolver, connector: down.connector as never } })
    await run(other.service.configure({ token: TOKEN, sendImmediately: true }))
    const failed = await run(inTurn(other, input({ send: true })))
    expect(failed.status).toBe("failed")
    expect((await run(other.get(failed.id))).lastError).toMatch(/\(500\)/)
    // The module stops: its token goes.
    await run(other.service.configure(undefined))
    expect(other.settings()).toEqual({ hasToken: false, sendImmediately: false })
  })

  it("changes the title and the body, records an issue filed by hand, and removes a report", async () => {
    const s = await store()
    const reports = await make(s)
    const drafted = await run(inTurn(reports, input()))
    const big = `${"A long body line.\n".repeat(3_000)}token=${TOKEN}`
    const changed = await run(reports.update(drafted.id, { title: "  Timer\nsilent  ", body: big }))
    expect(changed.title).toBe("Timer silent")
    expect(changed.body).toContain("A long body line.")
    expect(changed.body).not.toContain(TOKEN)
    expect(changed.bodyFits).toBe(false)
    expect((await run(reports.get(drafted.id))).body).toBe(changed.body)
    expect((await run(Effect.flip(reports.update(drafted.id, {})))).status).toBe(400)
    for (const bad of ["https://github.com/ianwijma/personal-voice-assistance/pull/3", "https://github.com/x/y/issues/3", "not a url"]) {
      expect((await run(Effect.flip(reports.update(drafted.id, { issueUrl: bad })))).status).toBe(400)
    }
    const filed = await run(reports.update(drafted.id, { issueUrl: "https://github.com/ianwijma/personal-voice-assistance/issues/99" }))
    expect(filed.status).toBe("sent")
    expect(filed.issue).toEqual({ number: 99, url: "https://github.com/ianwijma/personal-voice-assistance/issues/99" })
    await run(reports.remove(drafted.id))
    expect((await run(Effect.flip(reports.get(drafted.id)))).status).toBe(404)
    expect((await run(Effect.flip(reports.remove(drafted.id)))).status).toBe(404)
    // Its parts went with it.
    expect(await run(s.forCore("core.reports").collection(reportRows).list({}))).toEqual([])
  })

  effect.effect("pages newest first, and keeps at most the bound: a new report takes the place of the oldest sent one", () =>
    Effect.gen(function*() {
      const s = makeMemoryHouseholdStore()
      yield* s.prepare([], [reportsStorage])
      // A GitHub that holds the answer until the test lets it go.
      const net = makeOfflineNet({ [ISSUES]: created(11) })
      let release: () => void = () => undefined
      const held = new Promise<void>((r) => (release = r))
      const gate = { started: false, release: () => release() }
      const connector: OfflineConnector = async (request) => {
        gate.started = true
        await held
        return (net.connector as OfflineConnector)(request)
      }
      const reports = yield* makeReports({ store: s, sources: sources(), knownSecrets: () => [], github: { resolver: net.resolver, connector: connector as never } })
      const ids: Array<string> = []
      for (let i = 0; i < MAX_KEPT_REPORTS; i++) {
        // The test clock: each report a second after the one before.
        yield* TestClock.adjust(1_000)
        ids.push((yield* inTurn(reports, input({ title: `Report ${i}` }))).id)
      }
      // One sent by hand, the third oldest.
      yield* reports.update(ids[2]!, { issueUrl: "https://github.com/ianwijma/personal-voice-assistance/issues/3" })
      const first = yield* reports.list({ limit: 20 })
      expect(first.reports).toHaveLength(20)
      expect(first.reports[0]?.title).toBe(`Report ${MAX_KEPT_REPORTS - 1}`)
      const second = yield* reports.list({ limit: 20, cursor: first.next! })
      expect(second.reports[0]?.title).toBe(`Report ${MAX_KEPT_REPORTS - 21}`)
      expect((yield* Effect.flip(reports.list({ limit: 20, cursor: "nope" }))).status).toBe(400)
      yield* TestClock.adjust(1_000)
      yield* inTurn(reports, input({ title: "One more" }))
      let all: Array<string> = []
      let cursor: string | undefined
      for (;;) {
        const page = yield* reports.list({ limit: 20, ...(cursor !== undefined ? { cursor } : {}) })
        all = [...all, ...page.reports.map((r) => r.id)]
        if (page.next === undefined) break
        cursor = page.next
      }
      expect(all).toHaveLength(MAX_KEPT_REPORTS)
      // The sent one went, not the oldest draft.
      expect(all).not.toContain(ids[2])
      expect(all).toContain(ids[0])
      // A second one past the bound: now the oldest draft goes (no sent one is left).
      yield* TestClock.adjust(1_000)
      yield* inTurn(reports, input({ title: "And another" }))
      expect((yield* reports.get(ids[0]!).pipe(Effect.flip)).status).toBe(404)
      // The oldest left is being sent: it stays, and the next oldest goes.
      yield* reports.service.configure({ token: TOKEN, sendImmediately: false })
      const sending = yield* Effect.forkChild(reports.send(ids[1]!))
      for (let i = 0; i < 50 && gate.started === false; i++) yield* Effect.promise(() => new Promise((r) => setTimeout(r, 5)))
      expect(gate.started).toBe(true)
      yield* TestClock.adjust(1_000)
      yield* inTurn(reports, input({ title: "A third" }))
      expect((yield* reports.get(ids[3]!).pipe(Effect.flip)).status).toBe(404)
      gate.release()
      const done = yield* Fiber.join(sending)
      expect(done.status).toBe("sent")
      expect(yield* reports.get(ids[1]!)).toMatchObject({ status: "sent" })
    }), 60_000)
})
