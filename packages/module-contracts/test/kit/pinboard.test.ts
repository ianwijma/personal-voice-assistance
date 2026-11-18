// The reference module (pinboard.ts) started through the test kit: every part run as a turn, a job or an HTTP caller,
// in the real host and gateway, on the test clock, with no network. docs/MODULES.md walks through it.
import { assert, describe, it } from "@effect/vitest"
import { checkModule, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { notes, pinboardModule, texts } from "./pinboard.ts"

describe("the reference module (docs/MODULES.md)", () => {
  // #region check
  it.effect("passes the conformance check, with its texts in both languages", () => checkModule(pinboardModule, { texts }))
  // #endregion check

  // #region turns
  it.effect("a personal note is read where the privacy rule allows it, and withheld elsewhere", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule)
      // Sam, at the shared kitchen display whose default person is Sam (the default test household).
      const pinned = yield* board.tool("pinboard_pin", { text: "Dentist at 3", forMe: true }, { device: "kitchen-display" })
      assert.deepStrictEqual(pinned.value, { spoken: "Pinned: Dentist at 3." })
      yield* board.advance(60_000)
      yield* board.tool("pinboard_pin", { text: "Bins out tonight" }, { device: "kitchen-display" })

      const kitchen = yield* board.tool("pinboard_read", {}, { device: "kitchen-display" })
      assert.deepStrictEqual(kitchen.value, { notes: ["Bins out tonight", "Dentist at 3"], more: 0, owner: "p-sam" })
      // A public hall screen: the household note only, and a sentence about what was left out.
      const hall = yield* board.tool("pinboard_read", {}, { device: "hall-screen" })
      assert.deepStrictEqual(hall.value, { notes: ["Bins out tonight"], more: 0, withheld: "1 personal notes are not read out here." })
      // Robin's private phone: a private device may be told anyone's personal content.
      const phone = yield* board.tool("pinboard_read", {}, { device: "robins-phone" })
      assert.deepStrictEqual((phone.value as { notes: Array<string> }).notes, ["Bins out tonight", "Dentist at 3"])
    }))
  // #endregion turns

  it.effect("speaks Dutch in a Dutch household", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      const pinned = yield* board.tool("pinboard_pin", { text: "Melk halen" })
      assert.deepStrictEqual(pinned.value, { spoken: "Vastgeprikt: Melk halen." })
    }))

  it.effect("reads more notes than one list returns, page by page", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule)
      const store = board.moduleStore().collection(notes)
      const now = yield* board.now
      for (let i = 0; i < 60; i++) yield* store.insert({ text: `note ${i}`, pinnedAt: now - i * 1000 })
      const read = yield* board.tool("pinboard_read", {})
      assert.deepStrictEqual(read.value, { notes: Array.from({ length: 10 }, (_, i) => `note ${i}`), more: 50 })
    }))

  it.effect("the gateway refuses a tool the assistant switched off, and runs the action through the same checks", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule, { household: { assistants: [{ id: "jeff", modules: { pinboard: { offTools: ["pinboard_pin"] } } }] } })
      const refused = yield* board.tool("pinboard_pin", { text: "x" })
      assert.isFalse(refused.ok)
      assert.match(refused.content, /^Not run/)
      const store = board.moduleStore().collection(notes)
      const now = yield* board.now
      yield* store.insert({ text: "old", pinnedAt: now - 3 * 86_400_000 })
      yield* store.insert({ text: "new", pinnedAt: now })
      const cleared = yield* board.action("clear")
      assert.deepStrictEqual(cleared, { ok: true, say: "Cleared 1 old notes." })
    }))

  // #region job
  it.effect("the daily job takes down notes older than the setting, at 04:00, with the job's origin", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule, { settings: { keepDays: 1 } })
      const [job] = yield* board.jobs
      assert.strictEqual(job?.cron, "0 4 * * *")
      const store = board.moduleStore().collection(notes)
      const now = yield* board.now
      yield* store.insert({ text: "stale", pinnedAt: now - 2 * 86_400_000 })
      yield* store.insert({ text: "fresh", pinnedAt: now })
      yield* board.runJob(job!.id)
      const left = yield* store.list({})
      assert.deepStrictEqual(left.map((r) => r.value.text), ["fresh"])
    }))
  // #endregion job

  // #region route
  it.effect("the pin address needs a token of the module and a LAN caller, and the key when one is set", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule, { secrets: { signingKey: "k3y-for-tests" } })
      const { secret } = yield* board.mintRouteToken("pin", "Home Assistant")
      const body = { text: "Washing done" }
      assert.strictEqual((yield* board.route({ method: "POST", path: "pin", body })).status, 401)
      assert.strictEqual((yield* board.route({ method: "POST", path: "pin", body, as: { token: secret, address: "8.8.8.8" } })).status, 403)
      assert.strictEqual((yield* board.route({ method: "POST", path: "pin", body, as: { token: secret } })).status, 401)
      const ok = yield* board.route({ method: "POST", path: "pin", body, headers: { "X-Pinboard-Key": "k3y-for-tests" }, as: { token: secret } })
      assert.strictEqual(ok.status, 201)
      const read = yield* board.tool("pinboard_read", {})
      assert.deepStrictEqual((read.value as { notes: Array<string> }).notes, ["Washing done"])
    }))
  // #endregion route

  it.effect("health says when the pin address has no key, and the notes outlive a restart", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule)
      const issues = yield* board.checkHealth
      assert.deepStrictEqual(issues.map((i) => i.id), ["pinboard.no-key"])
      yield* board.tool("pinboard_pin", { text: "Keep me" })
      yield* board.stop
      assert.notInclude(board.toolNames(), "pinboard_read")
      const whileOff = yield* board.tool("pinboard_read", {})
      assert.isFalse(whileOff.ok)
      yield* board.start
      const read = yield* board.tool("pinboard_read", {})
      assert.deepStrictEqual((read.value as { notes: Array<string> }).notes, ["Keep me"])
    }))
})
