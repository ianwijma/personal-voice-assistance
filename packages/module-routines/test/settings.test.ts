// What the owner saves: refused with a sentence when a routine could not run as written (names, phrases the host would
// refuse or two routines share, steps that are not valid), and the bounds: 15 routines, 8 phrases per language each.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { MAX_ROUTINES, parseSteps, routinesModule, routinesOf, settings, texts } from "../src/index.ts"
import { stoppedSentence } from "../src/run.ts"

vi.setConfig({ testTimeout: 30_000 })

const routine = (name: string, steps: unknown, phrasesEn: ReadonlyArray<string> = [], phrasesNl: ReadonlyArray<string> = []) => ({
  name,
  phrasesEn: [...phrasesEn],
  phrasesNl: [...phrasesNl],
  steps: typeof steps === "string" ? steps : JSON.stringify(steps)
})
const SAY = [{ say: "Hello." }]

/** What a save of the routines field answers (the same decode serve mode runs on a save). */
const save = (value: unknown) => {
  const decoded = settings.routines.decode(value)
  return decoded.ok ? "ok" : decoded.error
}

describe("routines: the settings refuse what could not run", () => {
  it("a routine of its own is fine, with both languages", () => {
    assert.strictEqual(save([routine("Good night", [{ say: "Sleep well." }, { call: "lamp.switch", params: { to: "off" } }, { stop_if_failed: true }], ["good night"], ["goedenacht"])]), "ok")
  })

  it("names: empty and the same name twice (case and accents do not count)", () => {
    assert.strictEqual(save([routine("  ", SAY)]), "Routine 1, Name: One line of 1 to 40 characters")
    assert.strictEqual(save([routine("Café", SAY), routine("cafe!", SAY)]), "Two routines are called \"Café\"; give each its own name")
  })

  it("a phrase reserved for the host's own controls is named as the page names it", () => {
    assert.strictEqual(save([routine("Hush", SAY, ["be quiet"])]), "Routine \"Hush\", English phrase \"be quiet\": it is one of the assistant's own \"stop\" phrases, which no module may use")
    // The module's own command to cancel a routine is not a routine's phrase either.
    assert.strictEqual(save([routine("Halt", SAY, ["Cancel the routine!"])]), "Routine \"Halt\", English phrase \"Cancel the routine!\": it is the phrase that cancels a running routine")
    assert.strictEqual(save([routine("Halt", SAY, [], ["annuleer de routine"])]), "Routine \"Halt\", Dutch phrase \"annuleer de routine\": it is the phrase that cancels a running routine")
    assert.strictEqual(save([routine("Stil", SAY, [], ["Stil maar!"])]), "Routine \"Stil\", Dutch phrase \"Stil maar!\": it is one of the assistant's own \"stop\" phrases, which no module may use")
  })

  it("a phrase two routines share, or one routine has twice in another spelling, is refused", () => {
    assert.strictEqual(save([routine("A", SAY, ["movie time"]), routine("B", SAY, ["Movie time!"])]), "The English phrase \"Movie time!\" is in \"A\" and \"B\"; a phrase starts one routine")
    assert.strictEqual(save([routine("A", SAY, ["movie time", "Movie, time"])]), "Routine \"A\" has the English phrase \"Movie, time\" twice")
    // The same words in the other language are another phrase.
    assert.strictEqual(save([routine("A", SAY, ["film"]), routine("B", SAY, [], ["film"])]), "ok")
  })

  it("a phrase the host would refuse: a slot, too many words", () => {
    assert.match(save([routine("A", SAY, ["play {song}"])]), /^Routine "A", English phrase "play \{song\}": the slot \{song\} names no parameter of the action$/)
    assert.match(save([routine("A", SAY, ["one two three four five six seven eight nine"])]), /at most 8 words/)
  })

  it("more than 15 routines, more than 8 phrases: refused with the bound", () => {
    const many = Array.from({ length: MAX_ROUTINES + 1 }, (_, i) => routine(`Routine ${i + 1}`, SAY))
    assert.strictEqual(save(many), "At most 15 routines")
    assert.strictEqual(save(many.slice(0, MAX_ROUTINES)), "ok")
    assert.strictEqual(save([routine("A", SAY, Array.from({ length: 9 }, (_, i) => `phrase number ${i}`))]), "Routine 1, English phrases: At most 8 items")
  })

  it("steps: JSON, a list of 1 to 20 valid steps, explained without quoting the value", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      ["", "Write at least one step, such as [{ \"say\": \"Good night.\" }]"],
      ["[{say:", "Steps are JSON: a list such as [{ \"say\": \"Good night.\" }, { \"call\": \"lamp.switch\", \"params\": { \"to\": \"off\" } }]"],
      [[], "Steps are a list of 1 to 20 steps"],
      [Array.from({ length: 21 }, () => ({ say: "x" })), "At most 20 steps"],
      [[{ sya: "typo" }], "Step 1 has exactly one of \"say\", \"call\" or \"stop_if_failed\""],
      [[{ say: "a", call: "lamp.switch" }], "Step 1 has exactly one of \"say\", \"call\" or \"stop_if_failed\""],
      [[{ say: "a", params: {} }], "Step 1 has a key it does not use (only \"say\")"],
      [[{ say: "line\nbreak" }], "Step 1: \"say\" is one line of 1 to 300 characters"],
      [[{ say: "x".repeat(301) }], "Step 1: \"say\" is one line of 1 to 300 characters"],
      [[{ stop_if_failed: true }], "Step 1 cannot be \"stop_if_failed\": it stops after a step that did not work"],
      [[{ say: "a" }, { stop_if_failed: "yes" }], "Step 2: \"stop_if_failed\" is true"],
      [[{ call: "lamp" }], "Step 1: \"call\" is an action written module.action (such as lamp.switch), and \"params\" at most 8 values named with letters, digits or _, each one line of text up to 200 characters, a number, or true or false"],
      [[{ call: "lamp.switch", params: { to: { nested: true } } }], "Step 1: \"call\" is an action written module.action (such as lamp.switch), and \"params\" at most 8 values named with letters, digits or _, each one line of text up to 200 characters, a number, or true or false"],
      [[{ call: "lamp.switch", params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, i])) }], "Step 1: \"call\" is an action written module.action (such as lamp.switch), and \"params\" at most 8 values named with letters, digits or _, each one line of text up to 200 characters, a number, or true or false"],
      [[{ call: "routines.r_bedtime" }], "Step 1: a routine does not start other routines"]
    ]
    for (const [steps, sentence] of cases) {
      const text = typeof steps === "string" ? steps : JSON.stringify(steps)
      assert.strictEqual(parseSteps(text), sentence, text)
      // The records field says which routine and which field.
      assert.strictEqual(save([routine("A", text)]), `Routine 1, Steps (JSON): ${sentence}`)
    }
  })

  it.effect("an invalid save is refused and leaves the running module as it was", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(routinesModule, { settings: { routines: [routine("Hello", SAY, ["say hello"])] } })
      // As the admin page saves it: refused with the field's sentence, and nothing is written.
      const refused = yield* kit.configure({ routines: [routine("Hello", SAY, ["stop"])] })
      assert.isFalse(refused.ok)
      assert.include(JSON.stringify(refused), "Routine \\\"Hello\\\", English phrase \\\"stop\\\": it is one of the assistant's own \\\"stop\\\" phrases, which no module may use")
      assert.isTrue((yield* kit.phrases.say("say hello")).taken)
    }))
})

describe("routines: at the bounds the module still starts", () => {
  it.effect("15 routines with 8 phrases in each language, beside the cancel command; the template is then left out", () =>
    Effect.gen(function*() {
      const routines = Array.from({ length: MAX_ROUTINES }, (_, i) =>
        routine(
          `R${i}`,
          SAY,
          Array.from({ length: 8 }, (_, j) => `do ${i} ${j}`),
          Array.from({ length: 8 }, (_, j) => `doe ${i} ${j}`)
        )
      )
      assert.strictEqual(save(routines), "ok")
      assert.strictEqual(routinesOf({ routines, goodMorning: true }).length, MAX_ROUTINES)
      const kit = yield* startTestModule(routinesModule, { settings: { routines, goodMorning: true } })
      assert.deepStrictEqual(((yield* kit.tool("routines_list", {})).value as { count: number }).count, MAX_ROUTINES)
      assert.isTrue((yield* kit.phrases.say("do 14 7")).taken)
      assert.isTrue((yield* kit.phrases.say("cancel the routine")).taken)
      assert.deepStrictEqual(yield* kit.phrases.say("good morning"), { taken: false })
    }))

  it("names that make the same action id still get their own", () => {
    const ids = routinesOf({ routines: [routine("Ünïcode", SAY), routine("日本", SAY), routine("中文", SAY), routine("Routine", SAY)], goodMorning: false }).map((r) => r.actionId)
    assert.deepStrictEqual(ids, ["r_unicode", "r_routine", "r_routine_2", "r_routine_3"])
    assert.strictEqual(new Set(ids).size, ids.length)
    for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]{0,39}$/)
  })
})

describe("routines: what it says fits where it is said", () => {
  it("every refusal, with the longest name, fits a phrase command's spoken answer in whole", () => {
    const name = "N".repeat(40)
    for (const lang of ["en", "nl"] as const) {
      for (const [key, text] of Object.entries(texts[lang])) {
        if (key === "stoppedAt" || key === "stoppedFailed") continue // composed: the test below fills them at their worst
        const filled = text.replaceAll("{name}", name).replaceAll("{step}", "20").replaceAll("{steps}", "steps 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 and 20").replaceAll("{list}", `${name}, ${name} or ${name}`)
        assert.isAtMost(filled.length, 300, `${lang}.${key}`)
      }
    }
  })

  it("what a run says when it stops fits an announcement whole at the worst: 20 steps, the longest name, every split of done and unconfirmed", () => {
    const name = "N".repeat(40)
    const steps = Array.from({ length: 19 }, (_, i) => i + 1)
    for (const lang of ["en", "nl"] as const) {
      for (const why of ["whyRefused", "whyValues", "failed"] as const) {
        for (const split of [0, 1, 2, 3]) {
          const done = steps.filter((n) => (split === 0 ? true : split === 1 ? false : n % split === 0))
          const unconfirmed = steps.filter((n) => !done.includes(n))
          const sentence = stoppedSentence(lang, name, 20, why, done, unconfirmed)
          assert.isAtMost(sentence.length, 300, `${lang} ${why} ${split}: ${sentence.length}`)
          assert.notInclude(sentence, "{")
        }
      }
    }
  })
})
