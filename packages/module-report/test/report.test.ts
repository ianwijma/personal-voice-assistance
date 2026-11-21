// The report module's behaviour (docs/modules/report.md): what it passes to the core's `Reports` (the kit's stand-in
// records it), what it says for each answer in English and Dutch, where there is no `Reports` service, the settings it
// hands over and takes back, and the risk class of sending at once.
import { assert, describe, it } from "@effect/vitest"
import { DEFAULT_TEST_HOUSEHOLD, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { reportModule } from "../src/index.ts"

const TOKEN = "github_pat_11AAAAAAA0behaviour_test_token_value"
const DUTCH = { home: { ...DEFAULT_TEST_HOUSEHOLD.home, HOME_LANGUAGE: "nl-NL" } }
const timer = {
  kind: "problem",
  title: "The kitchen timer did not ring",
  description: "I set a timer for the pasta and it never rang.",
  answers: [{ question: "What did you expect?", answer: "A ring after ten minutes." }]
}

describe("the report module", () => {
  it.effect("keeps a draft with what the person said and the turn, and says where the owner finds it", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(reportModule)
      const r = yield* kit.tool("report_file", timer, { device: "kitchen-display" })
      assert.isTrue(r.ok)
      assert.deepStrictEqual(r.value, { spoken: "I've kept that report. The owner can read it and send it from the admin panel, under Reports." })
      const [drafted] = kit.reports.drafted
      assert.strictEqual(drafted?.kind, "problem")
      assert.strictEqual(drafted?.title, timer.title)
      assert.strictEqual(drafted?.description, timer.description)
      assert.deepStrictEqual(drafted?.answers, timer.answers)
      // Asked within the turn (the host reads it there), and not to send: drafting is `change`.
      assert.strictEqual(drafted?.send, false)
      assert.strictEqual(kit.reports.turns[0]?.deviceId, "kitchen-display")
      assert.strictEqual(kit.reports.turns[0]?.assistantId, "jeff")
      assert.isString(kit.reports.turns[0]?.conversationId)
      assert.notProperty(drafted ?? {}, "turn")
      // A feature idea without questions.
      yield* kit.tool("report_file", { kind: "feature", title: "Read recipes aloud", description: "I'd like it to read a recipe step by step." })
      assert.strictEqual(kit.reports.drafted[1]?.kind, "feature")
      assert.isUndefined(kit.reports.drafted[1]?.answers)
    }))

  it.effect("speaks Dutch in a Dutch household", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(reportModule, { household: DUTCH })
      const r = yield* kit.tool("report_file", timer)
      assert.deepStrictEqual(r.value, { spoken: "Ik heb die melding bewaard. De eigenaar kan hem lezen en versturen in het beheerpaneel, onder Reports." })
    }))

  it.effect("says each of the host's answers: sent with its number, sent without one, kept but not sent", () =>
    Effect.gen(function*() {
      const answers = [
        { id: "r1", status: "sent" as const, issueNumber: 142 },
        { id: "r2", status: "sent" as const },
        { id: "r3", status: "failed" as const }
      ]
      for (const [household, expected] of [
        [undefined, ["I've sent that report. It's issue 142.", "I've sent that report.", "I've kept that report, but sending it didn't work. The owner can send it from the admin panel, under Reports."]],
        [DUTCH, ["Ik heb die melding verstuurd. Het is issue 142.", "Ik heb die melding verstuurd.", "Ik heb die melding bewaard, maar versturen lukte niet. De eigenaar kan hem versturen in het beheerpaneel, onder Reports."]]
      ] as const) {
        const kit = yield* startTestModule(reportModule, { reports: (_input, _settings, n) => answers[n - 1]!, ...(household !== undefined ? { household } : {}) })
        for (const line of expected) assert.deepStrictEqual((yield* kit.tool("report_file", timer)).value, { spoken: line })
      }
    }))

  it.effect("says it could not keep it when the host fails, and that reporting is not available without the service", () =>
    Effect.gen(function*() {
      const broken = yield* startTestModule(reportModule, {
        reports: () => {
          throw new Error("the store is busy")
        }
      })
      const failed = yield* broken.tool("report_file", timer)
      assert.deepStrictEqual(failed.value, { spoken: "I couldn't keep that report just now. Please try again in a moment." })
      assert.notInclude(failed.content, "busy")
      // The CLI modes have no `Reports`.
      const none = yield* startTestModule(reportModule, { reports: false })
      assert.deepStrictEqual((yield* none.tool("report_file", timer)).value, { spoken: "Reporting isn't available here." })
      const dutch = yield* startTestModule(reportModule, { reports: false, household: DUTCH })
      assert.deepStrictEqual((yield* dutch.tool("report_file", timer)).value, { spoken: "Meldingen maken kan hier niet." })
    }))

  it.effect("refuses what a developer could not use: no title, a title of two lines, more than four questions", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(reportModule)
      assert.isFalse((yield* kit.tool("report_file", { ...timer, title: "" })).ok)
      assert.isFalse((yield* kit.tool("report_file", { ...timer, title: "Two\nlines" })).ok)
      assert.isFalse((yield* kit.tool("report_file", { ...timer, answers: Array.from({ length: 5 }, () => ({ question: "q", answer: "a" })) })).ok)
      assert.isFalse((yield* kit.tool("report_file", { ...timer, kind: "complaint" })).ok)
      assert.lengthOf(kit.reports.drafted, 0)
    }))

  it.effect("hands the token and the switch to the host while it runs, and takes them back when it stops", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(reportModule, { secrets: { githubToken: TOKEN } })
      assert.deepStrictEqual(kit.reports.settings(), { sendImmediately: false, token: TOKEN })
      yield* kit.configure({ sendImmediately: true })
      assert.deepStrictEqual(kit.reports.settings(), { sendImmediately: true, token: TOKEN })
      yield* kit.stop
      assert.isUndefined(kit.reports.settings())
      // No token: none is handed over.
      const plain = yield* startTestModule(reportModule)
      assert.deepStrictEqual(plain.reports.settings(), { sendImmediately: false })
    }))

  it.effect("drafting is `change`; sending at once with a token is `message`, which the household's policy refuses until allowed", () =>
    Effect.gen(function*() {
      const drafts = yield* startTestModule(reportModule, { secrets: { githubToken: TOKEN } })
      assert.include(drafts.toolNames(), "report_file")
      yield* drafts.tool("report_file", timer)
      assert.strictEqual(drafts.riskDecisions().at(-1)?.by, "change")

      const sends = yield* startTestModule(reportModule, { secrets: { githubToken: TOKEN }, settings: { sendImmediately: true } })
      // The default policy refuses `message`: the tool is not offered, and a call is refused before the host is asked.
      assert.notInclude(sends.toolNames(), "report_file")
      const refused = yield* sends.tool("report_file", timer)
      assert.isFalse(refused.ok)
      assert.lengthOf(sends.reports.drafted, 0)
      // The owner allows it: offered, and the module asks the host to send (`send: true`, what it was declared as).
      sends.setRiskPolicy({ message: "allow" })
      assert.include(sends.toolNames(), "report_file")
      const sent = yield* sends.tool("report_file", timer)
      assert.deepStrictEqual(sent.value, { spoken: "I've kept that report. The owner can read it and send it from the admin panel, under Reports." })
      assert.strictEqual(sends.reports.drafted[0]?.send, true)
      assert.strictEqual(sends.riskDecisions().at(-1)?.by, "message")
      yield* sends.expectNoSecrets(sent, refused, sends.reports.drafted)

      // Sending at once without a token sends nothing: drafting, `change`.
      const noToken = yield* startTestModule(reportModule, { settings: { sendImmediately: true } })
      assert.include(noToken.toolNames(), "report_file")
      yield* noToken.tool("report_file", timer)
      assert.strictEqual(noToken.reports.drafted[0]?.send, false)
    }))

  it.effect("health says when there is no token, as a warning when it should send at once", () =>
    Effect.gen(function*() {
      const plain = yield* startTestModule(reportModule)
      assert.deepStrictEqual((yield* plain.checkHealth).map((i) => [i.id, i.severity]), [["report.no-token", "info"]])
      const sends = yield* startTestModule(reportModule, { settings: { sendImmediately: true } })
      assert.deepStrictEqual((yield* sends.checkHealth).map((i) => [i.id, i.severity]), [["report.no-token", "warning"]])
      const set = yield* startTestModule(reportModule, { secrets: { githubToken: TOKEN } })
      assert.deepStrictEqual(yield* set.checkHealth, [])
    }))
})
