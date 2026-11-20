// The reference module (pinboard.ts) started through the test kit: every part run as a turn or a job, in the real host,
// gateway and scheduler, on the test clock, with no network. docs/MODULES.md walks through it.
import { assert, describe, it } from "@effect/vitest"
import { CurrentJob, type JobOrigin } from "@pva/core"
import { checkModule, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { type Note, notes, pinboardModule, SCAN_ROWS, texts } from "./pinboard.ts"

/** Notes as a test writes them straight into the store. */
const household = (text: string, pinnedAt: number): Note => ({ text, whose: "household", pinnedAt })
const personal = (text: string, owner: string, pinnedAt: number): Note => ({ text, owner, whose: "personal", pinnedAt })

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
      // Robin, on Robin's private phone.
      yield* board.tool("pinboard_pin", { text: "Call the vet", forMe: true }, { device: "robins-phone" })
      yield* board.advance(60_000)
      yield* board.tool("pinboard_pin", { text: "Bins out tonight" }, { device: "kitchen-display" })

      // The kitchen display is shared and Sam's: Sam's note, not Robin's.
      const kitchen = yield* board.tool("pinboard_read", {}, { device: "kitchen-display" })
      assert.deepStrictEqual(kitchen.value, { notes: ["Bins out tonight", "Dentist at 3"], more: 0, withheld: "1 personal notes are not read out here.", owner: "p-sam" })
      // A public hall screen: the household note only, and a sentence about what was left out.
      const hall = yield* board.tool("pinboard_read", {}, { device: "hall-screen" })
      assert.deepStrictEqual(hall.value, { notes: ["Bins out tonight"], more: 0, withheld: "2 personal notes are not read out here." })
      // Robin's private phone: a private device may be told any member's personal content.
      const phone = yield* board.tool("pinboard_read", {}, { device: "robins-phone" })
      assert.deepStrictEqual((phone.value as { notes: Array<string> }).notes, ["Bins out tonight", "Call the vet", "Dentist at 3"])
    }))
  // #endregion turns

  // #region whose
  it.effect("a note for 'me' when nobody known is asking: it asks whose, and writes nothing", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule)
      const asked = yield* board.tool("pinboard_pin", { text: "Private appointment", forMe: true }, { device: "hall-screen" })
      assert.deepStrictEqual(asked.value, { spoken: "Who is the note for? I can't tell who is asking here." })
      assert.notInclude(asked.content, "Private appointment")
      assert.deepStrictEqual(yield* board.moduleStore().collection(notes).list({}), [])
    }))
  // #endregion whose

  it.effect("a personal note pinned on a public screen whose default person is known: stored as theirs, never repeated there", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule, {
        household: { devices: [{ id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: "p-sam" }] }
      })
      const plain = yield* board.tool("pinboard_pin", { text: "Private appointment", forMe: true }, { device: "hall-screen" })
      assert.deepStrictEqual(plain.value, { spoken: "Pinned, only for you." })
      const timed = yield* board.tool("pinboard_pin", { text: "Private call", forMe: true, hours: 2 }, { device: "hall-screen" })
      assert.deepStrictEqual(timed.value, { spoken: "Pinned for 2 hours, only for you." })
      assert.notInclude(plain.content + timed.content, "Private ")
      const rows = yield* board.moduleStore().collection(notes).list({})
      assert.sameMembers(rows.map((r) => `${r.value.owner} ${r.value.text}`), ["p-sam Private appointment", "p-sam Private call"])
      // A household note is repeated on the same screen: it is no one's.
      assert.deepStrictEqual((yield* board.tool("pinboard_pin", { text: "Bins out" }, { device: "hall-screen" })).value, { spoken: "Pinned: Bins out." })
    }))

  it.effect("a note must be one line: a line break is refused before the module runs", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule)
      const refused = yield* board.tool("pinboard_pin", { text: "one\ntwo" })
      assert.isFalse(refused.ok)
      assert.deepStrictEqual(yield* board.moduleStore().collection(notes).list({}), [])
    }))

  it.effect("a row with every indexed field at its largest is stored (the store refuses an illegal indexed value when it is written)", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule)
      const largest: Note = { text: "\"".repeat(200), owner: "p-" + "a".repeat(38), whose: "household", pinnedAt: 8_640_000_000_000_000 }
      yield* board.moduleStore().collection(notes).insert(largest)
      assert.strictEqual((yield* board.moduleStore().collection(notes).list({})).length, 1)
    }))

  it.effect("a shared device with no default person shows nobody's personal notes; a member who is nobody's default is read only on a private device", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule, {
        household: {
          devices: [
            { id: "living-room-speaker", name: "Living room", privacy: "shared", defaultPerson: null },
            { id: "robins-phone", name: "Robin's phone", privacy: "private", defaultPerson: "p-robin" },
            { id: "kitchen-display", name: "Kitchen display", privacy: "shared", defaultPerson: "p-sam" }
          ]
        }
      })
      const store = board.moduleStore().collection(notes)
      const now = yield* board.now
      yield* store.insert(personal("Alex's dentist", "p-alex", now))
      yield* store.insert(personal("Sam's dentist", "p-sam", now - 1))
      const living = yield* board.tool("pinboard_read", {}, { device: "living-room-speaker" })
      assert.deepStrictEqual(living.value, { notes: [], more: 0, withheld: "2 personal notes are not read out here." })
      const kitchen = yield* board.tool("pinboard_read", {}, { device: "kitchen-display" })
      assert.deepStrictEqual((kitchen.value as { notes: Array<string> }).notes, ["Sam's dentist"])
      const phone = yield* board.tool("pinboard_read", {}, { device: "robins-phone" })
      assert.deepStrictEqual((phone.value as { notes: Array<string> }).notes, ["Alex's dentist", "Sam's dentist"])
    }))

  it.effect("speaks Dutch in a Dutch household, its questions and failures too", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      const pinned = yield* board.tool("pinboard_pin", { text: "Melk halen" })
      assert.deepStrictEqual(pinned.value, { spoken: "Vastgeprikt: Melk halen." })
      const asked = yield* board.tool("pinboard_pin", { text: "Tandarts", forMe: true }, { device: "hall-screen" })
      assert.deepStrictEqual(asked.value, { spoken: "Voor wie is het briefje? Ik weet hier niet wie het vraagt." })
      // A failure of its own: at the scheduler's 200 live jobs (the daily job is one), a timed note is not pinned.
      for (let i = 0; i < 199; i++) assert.isTrue((yield* board.tool("pinboard_pin", { text: `Briefje ${i}`, hours: 1 })).ok)
      const full = yield* board.tool("pinboard_pin", { text: "Nog een", hours: 1 })
      assert.isFalse(full.ok)
      assert.include(full.content, "Het briefje kon niet worden vastgeprikt.")
    }))

  it.effect("reads more notes than one list returns, page by page, and says so when its bounded scan is cut short", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule)
      const store = board.moduleStore().collection(notes)
      const now = yield* board.now
      for (let i = 0; i < 60; i++) yield* store.insert(household(`note ${i}`, now - i * 1000))
      const read = yield* board.tool("pinboard_read", {})
      assert.deepStrictEqual(read.value, { notes: Array.from({ length: 10 }, (_, i) => `note ${i}`), more: 50 })
      for (let i = 60; i < SCAN_ROWS + 2; i++) yield* store.insert(household(`note ${i}`, now - i * 1000))
      const cut = (yield* board.tool("pinboard_read", {})).value as { more: number; cut?: string }
      assert.strictEqual(cut.more, SCAN_ROWS - 10)
      assert.strictEqual(cut.cut, `I read the newest ${SCAN_ROWS} notes; there are more.`)
    }))

  it.effect("the gateway refuses a tool or an action the assistant switched off, and nothing is removed", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule, {
        household: { assistants: [{ id: "jeff", modules: { pinboard: { offTools: ["pinboard_pin", "pinboard_clear"] } } }] }
      })
      const refused = yield* board.tool("pinboard_pin", { text: "x" })
      assert.match(refused.content, /^Not run: pinboard_pin is switched off/)
      const store = board.moduleStore().collection(notes)
      const now = yield* board.now
      yield* store.insert(household("old", now - 3 * 86_400_000))
      const action = yield* board.action("clear")
      assert.isFalse(action.ok)
      const asTool = yield* board.tool("pinboard_clear", {})
      assert.isFalse(asTool.ok)
      assert.deepStrictEqual((yield* store.list({})).map((r) => r.value.text), ["old"])
    }))

  it.effect("the action makes progress behind personal notes it keeps, and saying it again finishes the job", () =>
    Effect.gen(function*() {
      // A long retention, so the daily job takes nothing down during the test.
      const board = yield* startTestModule(pinboardModule, { settings: { keepDays: 365 } })
      const store = board.moduleStore().collection(notes)
      const now = yield* board.now
      const old = now - 30 * 86_400_000
      // 500 personal notes, older than every household note: a scan of all notes would read only them.
      for (let i = 0; i < SCAN_ROWS; i++) yield* store.insert(personal(`Sam's ${i}`, "p-sam", old - 10_000 + i))
      yield* store.insert(household("behind them", old))
      assert.deepStrictEqual(yield* board.action("clear"), { ok: true, say: "Cleared 1 old notes." })
      // More old household notes than one scan reads: it says so, and the second clear takes the rest.
      for (let i = 0; i <= SCAN_ROWS; i++) yield* store.insert(household(`old ${i}`, old + i))
      yield* store.insert(household("new", now))
      assert.deepStrictEqual(yield* board.action("clear"), { ok: true, say: `Cleared ${SCAN_ROWS} old notes; there are more, so say it again.` })
      assert.deepStrictEqual(yield* board.action("clear"), { ok: true, say: "Cleared 1 old notes." })
      const left = yield* store.list({ where: { whose: "household" }, orderBy: { field: "pinnedAt" } })
      assert.deepStrictEqual(left.map((r) => r.value.text), ["new"])
    }))

  it.effect("the action clears old household notes and keeps personal ones", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule)
      const store = board.moduleStore().collection(notes)
      const now = yield* board.now
      yield* store.insert(household("old", now - 3 * 86_400_000))
      yield* store.insert(personal("old and Sam's", "p-sam", now - 3 * 86_400_000))
      yield* store.insert(household("new", now))
      assert.deepStrictEqual(yield* board.action("clear"), { ok: true, say: "Cleared 1 old notes." })
      assert.sameMembers((yield* store.list({})).map((r) => r.value.text), ["old and Sam's", "new"])
    }))

  // #region job
  /** The module with what each of its job handlers sees as `CurrentJob` while it runs, recorded (a test's own wrapper). */
  const recordingJobs = (seen: Array<JobOrigin | undefined>): typeof pinboardModule => ({
    ...pinboardModule,
    shared: (ctx) =>
      pinboardModule.shared!({
        ...ctx,
        scheduler: {
          ...ctx.scheduler,
          handle: (name, handler) =>
            ctx.scheduler.handle(name, { ...handler, run: (payload, due) => Effect.andThen(Effect.flatMap(CurrentJob, (job) => Effect.sync(() => void seen.push(job))), handler.run(payload, due)) })
        }
      })
  })

  it.effect("a note pinned for some hours: the note and its job in one transaction; the job runs with the turn's origin", () =>
    Effect.gen(function*() {
      const seen: Array<JobOrigin | undefined> = []
      const board = yield* startTestModule(recordingJobs(seen))
      const r = yield* board.tool("pinboard_pin", { text: "Oven is hot", forMe: true, hours: 2 }, { device: "kitchen-display" })
      assert.deepStrictEqual(r.value, { spoken: "Pinned for 2 hours: Oven is hot." })
      const [note] = yield* board.moduleStore().collection(notes).list({})
      const job = (yield* board.jobs).find((j) => j.handler === "unpin")!
      assert.deepStrictEqual(job.payload, { id: note!.id })
      // Its origin is the turn that scheduled it: the assistant, the device and the person.
      assert.strictEqual(job.origin.assistantId, "jeff")
      assert.strictEqual(job.origin.deviceId, "kitchen-display")
      assert.strictEqual(job.origin.person?.id, "p-sam")
      // It outlives a restart of the module, and then takes the note down as the job.
      yield* board.restart
      yield* board.runJob(job.id)
      assert.deepStrictEqual(yield* board.moduleStore().collection(notes).list({}), [])
      const removed = board.events.find((e) => e.type === "pinboard.notes.changed" && e.actor?.kind === "job")
      assert.deepStrictEqual(removed?.actor, { kind: "job", jobId: job.id })
      // What the handler saw as it ran, after the restart: the turn's assistant, device and person.
      const ran = seen.filter((j) => j?.jobId === job.id)
      assert.strictEqual(ran.length, 1)
      assert.strictEqual(ran[0]?.assistantId, "jeff")
      assert.strictEqual(ran[0]?.deviceId, "kitchen-display")
      assert.strictEqual(ran[0]?.person?.id, "p-sam")
    }))

  it.effect("the daily job takes down notes older than the setting, at 04:00", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule, { settings: { keepDays: 1 } })
      const job = (yield* board.jobs).find((j) => j.handler === "expire")
      assert.strictEqual(job?.cron, "0 4 * * *")
      const store = board.moduleStore().collection(notes)
      const now = yield* board.now
      yield* store.insert({ text: "stale", whose: "household", pinnedAt: now - 2 * 86_400_000 })
      yield* store.insert({ text: "fresh", whose: "household", pinnedAt: now })
      yield* board.runJob(job!.id)
      assert.deepStrictEqual((yield* store.list({})).map((r) => r.value.text), ["fresh"])
    }))
  // #endregion job

  // #region secrets
  it.effect("health says when there is no printer key, and no result, spoken line or stored row holds the key", () =>
    Effect.gen(function*() {
      const plain = yield* startTestModule(pinboardModule)
      assert.deepStrictEqual((yield* plain.checkHealth).map((i) => i.id), ["pinboard.no-printer-key"])
      const board = yield* startTestModule(pinboardModule, { secrets: { printerKey: "printer-k3y-for-tests" } })
      assert.deepStrictEqual(yield* board.checkHealth, [])
      const pinned = yield* board.tool("pinboard_pin", { text: "Keep me" })
      const read = yield* board.tool("pinboard_read", {})
      const cleared = yield* board.action("clear")
      // The kit reads no collection itself: the test passes the rows its module wrote.
      const rows = yield* board.moduleStore().collection(notes).list({})
      yield* board.expectNoSecrets(pinned, read, cleared, rows)
    }))
  // #endregion secrets

  it.effect("the notes outlive a stop and a start; the tools are gone while it is off", () =>
    Effect.gen(function*() {
      const board = yield* startTestModule(pinboardModule)
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
