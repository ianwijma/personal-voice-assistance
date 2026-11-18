// P7 (docs/PHRASES.md): the matcher by table. Both languages; case, punctuation and whitespace; slots of each `Param`
// kind that read and that do not; the longest phrase; duplicates; the host's reserved phrases; every bound. And the
// ringing window's phrases.
import { describe, expect, it } from "vitest"
import {
  type ActionPhrases,
  buildCommandSet,
  defineAction,
  HOST_CONTROL_PHRASES,
  HOST_CONTROLS,
  hostCommandSet,
  matchCommand,
  matchRinging,
  Param,
  PHRASE_LIMITS,
  PHRASE_TEXTS,
  phraseConflictIssues,
  phraseLanguageOf,
  phraseProblems,
  registerActions,
  reservedFor
} from "../../src/index.ts"
import { Effect } from "effect"

const rooms = [{ value: "kitchen", label: "Kitchen", aliases: ["keuken"] }, { value: "living", label: "Living room", aliases: ["woonkamer"] }]

const actionsOf = (moduleId: string, list: ReadonlyArray<Parameters<typeof defineAction>[0]>) => registerActions(moduleId, list.map((a) => defineAction(a)))

const lights = actionsOf("lights", [
  {
    id: "on",
    label: "Lights on",
    description: "Lights on in a room.",
    params: { room: Param.dynamic({ label: "Room", options: () => rooms }) },
    phrases: { en: ["{room} lights on", "lights on in the {room}"], nl: ["licht aan in de {room}"] },
    run: () => Effect.succeed({ say: "On." })
  },
  {
    id: "all_on",
    label: "All lights on",
    description: "Every light on.",
    params: {},
    phrases: { en: ["all lights on", "lights on"] },
    run: () => Effect.succeed({ say: "All on." })
  },
  {
    id: "dim",
    label: "Dim",
    description: "Dim to a level.",
    params: { level: Param.number({ label: "Level", min: 0, max: 100, integer: true, unit: "percent" }) },
    phrases: { en: ["dim to {level}"], nl: ["dim naar {level}"] },
    run: () => Effect.succeed({ say: "Dimmed." })
  },
  {
    id: "speed",
    label: "Fan speed",
    description: "Fan speed.",
    params: { speed: Param.choice({ label: "Speed", options: [{ value: "low", label: "low" }, { value: "high", label: "high", aliases: ["hoog"] }] }) },
    phrases: { en: ["fan on {speed}"], nl: ["ventilator op {speed}"] },
    run: () => Effect.succeed({ say: "Fan." })
  },
  {
    id: "timer",
    label: "Timer",
    description: "A timer.",
    params: { length: Param.duration({ label: "Length", minMs: 1_000, maxMs: 3_600_000 }), name: Param.text({ label: "Name", after: [], optional: true, maxWords: 3 }) },
    phrases: { en: ["timer for {length}", "timer for {length} called {name}"], nl: ["timer van {length}"] },
    run: () => Effect.succeed({ say: "Timer." })
  }
])

const en = buildCommandSet("en", lights)
const nl = buildCommandSet("nl", lights)
const idOf = (m: ReturnType<typeof matchCommand>) => (m === undefined ? undefined : m.kind === "control" ? `control:${m.control}` : m.action.id)

describe("the matcher", () => {
  it.each([
    // [utterance, expected owner, values]
    ["Kitchen lights on", "lights.on", { room: "kitchen" }],
    ["kitchen LIGHTS on!", "lights.on", { room: "kitchen" }],
    ["  kitchen,   lights   on.  ", "lights.on", { room: "kitchen" }],
    ["lights on in the living room", "lights.on", { room: "living" }],
    ["lights on", "lights.all_on", {}],
    ["all lights on", "lights.all_on", {}],
    ["dim to forty", "lights.dim", { level: 40 }],
    ["dim to 40", "lights.dim", { level: 40 }],
    ["dim to 40 percent", "lights.dim", { level: 40 }],
    ["fan on high", "lights.speed", { speed: "high" }],
    ["timer for ten minutes", "lights.timer", { length: 600_000 }],
    ["timer for 5 minutes called pasta water", "lights.timer", { length: 300_000, name: "pasta water" }]
  ])("en: %j → %s", (said, owner, values) => {
    const m = matchCommand(en, said)
    expect(idOf(m)).toBe(owner)
    if (m?.kind === "command") expect(m.values).toEqual(values)
  })

  it.each([
    ["licht aan in de keuken", "lights.on", { room: "kitchen" }],
    ["Licht aan in de Woonkamer.", "lights.on", { room: "living" }],
    ["dim naar veertig", "lights.dim", { level: 40 }],
    ["ventilator op hoog", "lights.speed", { speed: "high" }],
    ["timer van tien minuten", "lights.timer", { length: 600_000 }]
  ])("nl: %j → %s", (said, owner, values) => {
    const m = matchCommand(nl, said)
    expect(idOf(m)).toBe(owner)
    if (m?.kind === "command") expect(m.values).toEqual(values)
  })

  it.each([
    ["garage lights on", "a dynamic room that is not one"],
    ["dim to a lot", "a number that does not read"],
    ["dim to 140", "a number above its maximum"],
    ["dim to 40 degrees", "a number with another unit"],
    ["dim to 4.5", "a whole number that is not"],
    ["dim to forty two hundred", "more than one number"],
    ["fan on medium", "a choice that is not one"],
    ["timer for soon", "a duration that does not read"],
    ["timer for two hours", "a duration above its maximum"],
    ["timer for 5 minutes called a very long name here", "a text slot over its words"],
    ["the kitchen lights on please", "words around the phrase: exact on words"],
    ["kitchen light on", "no stemming"],
    ["kitchn lights on now", "no fuzzy words"],
    ["licht aan in de keuken", "a Dutch phrase in the English set"],
    ["", "nothing said"]
  ])("does not match %j (%s)", (said) => {
    expect(matchCommand(en, said)).toBeUndefined()
  })

  it("the longest phrase wins: 'all lights on' (3 words) over a slot reading of '{room} lights on' (2)", () => {
    expect(idOf(matchCommand(en, "all lights on"))).toBe("lights.all_on")
  })

  it("the host's controls are in every set, before the modules', in both languages", () => {
    for (const lang of ["en", "nl"] as const) {
      for (const control of HOST_CONTROLS) {
        for (const phrase of HOST_CONTROL_PHRASES[lang][control]) {
          expect(idOf(matchCommand(lang === "en" ? en : nl, phrase))).toBe(`control:${control}`)
          expect(idOf(matchCommand(hostCommandSet(lang), `${phrase.toUpperCase()}!`))).toBe(`control:${control}`)
        }
      }
    }
    expect(idOf(matchCommand(hostCommandSet("nl"), "Hou op."))).toBe("control:stop")
    expect(idOf(matchCommand(hostCommandSet("en"), "Never mind"))).toBe("control:never-mind")
    expect(matchCommand(hostCommandSet("en"), "stop the music")).toBeUndefined()
  })

  it("a host control beats a module phrase of the same length; two modules tied match nothing", () => {
    const tie = actionsOf("a", [{ id: "x", label: "X", description: "X.", params: { thing: Param.text({ label: "Thing", after: [] }) }, phrases: { en: ["{thing} up"] }, run: () => Effect.void }])
    const set = buildCommandSet("en", tie)
    // "turn it up" is the host's (3 literal words) and "{thing} up" one literal word: the host's is longer anyway.
    expect(idOf(matchCommand(set, "turn it up"))).toBe("control:louder")
    const a = actionsOf("a", [{ id: "x", label: "X", description: "X.", params: { room: Param.dynamic({ label: "Room", options: () => rooms }) }, phrases: { en: ["{room} please"] }, run: () => Effect.void }])
    const b = actionsOf("b", [{ id: "y", label: "Y", description: "Y.", params: { thing: Param.text({ label: "Thing", after: [] }) }, phrases: { en: ["kitchen {thing}"] }, run: () => Effect.void }])
    const both = buildCommandSet("en", [...a, ...b])
    expect(both.conflicts).toEqual([])
    expect(idOf(matchCommand(both, "living room please"))).toBe("a.x")
    expect(idOf(matchCommand(both, "kitchen radio"))).toBe("b.y")
    // "kitchen please" reads as both, each with one literal word: a tie between two modules matches nothing.
    expect(matchCommand(both, "kitchen please")).toBeUndefined()
    // The same shape in two modules is a duplicate instead: both left out, named.
    const c = actionsOf("c", [{ id: "z", label: "Z", description: "Z.", params: { n: Param.number({ label: "N" }) }, phrases: { en: ["{n} please"] }, run: () => Effect.void }])
    const dup = buildCommandSet("en", [...a, ...c])
    expect(dup.conflicts).toEqual([{ kind: "duplicate", language: "en", shape: "{} please", actions: ["a.x", "c.z"] }])
    expect(matchCommand(dup, "kitchen please")).toBeUndefined()
  })
})

describe("one assistant's set", () => {
  it("a duplicate between two modules leaves both out and is named; the rest stays", () => {
    const other = actionsOf("hue", [{ id: "on", label: "On", description: "On.", params: {}, phrases: { en: ["lights on", "hue on"] }, run: () => Effect.void }])
    const set = buildCommandSet("en", [...lights, ...other])
    expect(matchCommand(set, "lights on")).toBeUndefined()
    expect(idOf(matchCommand(set, "hue on"))).toBe("hue.on")
    expect(idOf(matchCommand(set, "all lights on"))).toBe("lights.all_on")
    expect(set.conflicts).toEqual([{ kind: "duplicate", language: "en", shape: "lights on", actions: ["lights.all_on", "hue.on"] }])
    const issues = phraseConflictIssues({ id: "jeff", name: "Jeff" }, set)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ id: "phrases.jeff.duplicate.en.lights on", module: "lights", severity: "warning" })
    expect(issues[0]!.title).toContain("lights.all_on and hue.on")
  })

  it(`past ${PHRASE_LIMITS.phrasesPerAssistant} module phrases a language, further modules are left out whole and named`, () => {
    const modules = Array.from({ length: 40 }, (_, m) =>
      actionsOf(`m${m}`, [{ id: "a", label: "A", description: "A.", params: {}, phrases: { en: Array.from({ length: 8 }, (_, i) => `word${m} number${i}`) }, run: () => Effect.void }]))
    const set = buildCommandSet("en", modules.flat())
    const kept = set.phrases.filter((p) => p.owner.kind === "action").length
    expect(kept).toBe(PHRASE_LIMITS.phrasesPerAssistant)
    expect(set.conflicts).toEqual([{ kind: "over-bound", language: "en", modules: Array.from({ length: 8 }, (_, i) => `m${32 + i}`) }])
    expect(matchCommand(set, "word31 number7")).toBeDefined()
    expect(matchCommand(set, "word32 number0")).toBeUndefined()
    expect(phraseConflictIssues({ id: "jeff", name: "Jeff" }, set)[0]!.detail).toContain("m32, m33")
  })
})

describe("declarations (refused when the module starts)", () => {
  const check = (phrases: ActionPhrases, params: Parameters<typeof defineAction>[0]["params"] = {}) => phraseProblems("mod", [{ id: "act", params, phrases }])
  const room = { room: Param.dynamic({ label: "Room", options: () => rooms }) }

  it("accepts phrases within every bound", () => {
    expect(check({ en: ["a b c d e f g {room}"], nl: Array.from({ length: 8 }, (_, i) => `zin ${i} {room}`) }, room)).toEqual([])
  })

  it.each([
    [{ en: Array.from({ length: 9 }, (_, i) => `phrase ${i}`) }, {}, "at most 8"],
    [{ en: ["one two three four five six seven eight nine"] }, {}, "at most 8 words"],
    [{ en: ["x".repeat(81)] }, {}, "at most 80 characters"],
    [{ en: ["{room} and {room}"] }, room, "a slot appears twice"],
    [{ en: ["{room}"] }, room, "at least one word"],
    [{ en: ["{a} x {b} y {c}"] }, { a: Param.text({ label: "A", after: [] }), b: Param.text({ label: "B", after: [] }), c: Param.text({ label: "C", after: [] }) }, "at most 2 slots"],
    [{ en: ["go {a} {b}"] }, { a: Param.text({ label: "A", after: [] }), b: Param.text({ label: "B", after: [] }) }, "two slots need a word between"],
    [{ en: ["lights on in the {place}"] }, room, "names no parameter"],
    [{ en: ["lights on"] }, room, "the required parameter room has no slot"],
    [{ en: ["dim {yes}"] }, { yes: Param.boolean({ label: "Yes", question: "Yes?" }) }, "yes/no parameter"],
    [{ en: ["set{room}"] }, room, "a slot is a whole word"],
    [{ en: [""] }, {}, "empty"],
    [{ en: ["line\nbreak"] }, {}, "one line"],
    [{ en: ["stop"] }, {}, "no module may use"],
    [{ en: ["Never mind!"] }, {}, "no module may use"],
    [{ nl: ["Laat maar"] }, {}, "no module may use"],
    [{ en: ["a phrase", "A phrase."] }, {}, "given twice"],
    [{ de: ["hallo"] } as never, {}, "only en and nl"],
    [{ en: "not a list" } as never, {}, "are a list"]
  ])("refuses %j (%s)", (phrases, params, why) => {
    const problems = check(phrases as ActionPhrases, params as never)
    expect(problems.join("\n")).toContain(why)
  })

  it("a Dutch reserved phrase is free in English and the other way round", () => {
    expect(reservedFor("nl", "harder")).toBe("louder")
    expect(reservedFor("en", "harder")).toBeUndefined()
    expect(check({ en: ["harder"] })).toEqual([])
    expect(check({ nl: ["harder"] }).join()).toContain("no module may use")
  })

  it(`more than ${PHRASE_LIMITS.actionsPerModule} actions with phrases in one instance is refused`, () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ id: `a${i}`, params: {}, phrases: { en: [`do ${i}`] } }))
    expect(phraseProblems("mod", many).join()).toContain("17 actions have phrases; at most 16")
  })
})

describe("bounds of an utterance", () => {
  it(`an utterance over ${PHRASE_LIMITS.utteranceWords} words or ${PHRASE_LIMITS.utteranceChars} characters matches nothing`, () => {
    const set = buildCommandSet("en", actionsOf("t", [{ id: "x", label: "X", description: "X.", params: { t: Param.text({ label: "T", after: [], maxWords: 8 }) }, phrases: { en: ["note {t}"] }, run: () => Effect.void }]))
    expect(matchCommand(set, `note ${"w ".repeat(PHRASE_LIMITS.utteranceWords - 1)}`.trim())).toBeUndefined() // a slot of 23 words
    expect(matchCommand(set, "note one two three")).toBeDefined()
    expect(matchCommand(set, `note ${"a".repeat(PHRASE_LIMITS.utteranceChars)}`)).toBeUndefined()
    expect(matchCommand(hostCommandSet("en"), `${"stop ".repeat(25)}`)).toBeUndefined()
  })

  it(`at most ${PHRASE_LIMITS.slotReads} slot readings an utterance: a sentence that aligns everywhere stops matching once they are spent`, () => {
    let reads = 0
    const counted = () => (reads++, rooms)
    // Every shape of 3 to 6 tokens over the words "x" and "and" with two slots that are not side by side.
    const shapes: Array<string> = []
    for (let n = 3; n <= 6; n++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        for (let i = 0; i < n; i++) {
          for (let j = i + 2; j < n; j++) {
            const tokens = Array.from({ length: n }, (_, k) => (k === i ? "{a}" : k === j ? "{b}" : (mask >> k) & 1 ? "and" : "x"))
            shapes.push(tokens.join(" "))
          }
        }
      }
    }
    const unique = [...new Set(shapes)].slice(0, 128)
    const actions = Array.from({ length: 16 }, (_, m) =>
      actionsOf(`m${m}`, [{
        id: "x",
        label: "X",
        description: "X.",
        params: { a: Param.dynamic({ label: "A", options: counted }), b: Param.dynamic({ label: "B", options: counted }) },
        phrases: { en: unique.slice(m * 8, m * 8 + 8) },
        run: () => Effect.void
      }])).flat()
    const set = buildCommandSet("en", actions)
    expect(set.conflicts).toEqual([])
    // "x and x and …": almost every shape aligns, in several ways; no slot reads (no room is called "x and x").
    expect(matchCommand(set, "x and x and x and x and x")).toBeUndefined()
    expect(reads).toBe(PHRASE_LIMITS.slotReads)
    // An ordinary sentence costs two readings.
    const plain = buildCommandSet("en", actionsOf("p", [{ id: "x", label: "X", description: "X.", params: { a: Param.dynamic({ label: "A", options: counted }), b: Param.dynamic({ label: "B", options: counted }) }, phrases: { en: ["{a} and {b}"] }, run: () => Effect.void }]))
    reads = 0
    expect(matchCommand(plain, "kitchen and living room")).toMatchObject({ values: { a: "kitchen", b: "living" } })
    expect(reads).toBe(2)
  })

  it("a dynamic list that throws matches nothing (module code on the turn path is contained)", () => {
    const set = buildCommandSet("en", actionsOf("t", [{ id: "x", label: "X", description: "X.", params: { room: Param.dynamic({ label: "Room", options: () => { throw new Error("broken cache") } }) }, phrases: { en: ["clean {room}"] }, run: () => Effect.void }]))
    expect(matchCommand(set, "clean kitchen")).toBeUndefined()
  })
})

describe("the ringing window's phrases", () => {
  const ringing = [
    { id: "n-old", actions: [{ id: "snooze", label: "Snooze" }] },
    { id: "n-new", actions: [{ id: "snooze", label: "Snooze" }, { id: "extend", label: "Five more minutes" }] }
  ]
  it.each([
    ["Stop!", { kind: "stop", phrase: "stop" }],
    ["please stop", { kind: "stop", phrase: "please stop" }],
    ["snooze", { kind: "action", notificationId: "n-new", actionId: "snooze", label: "Snooze" }],
    ["Five more minutes.", { kind: "action", notificationId: "n-new", actionId: "extend", label: "Five more minutes" }]
  ])("en: %j", (said, expected) => {
    expect(matchRinging("en", said, ringing)).toEqual(expected)
  })
  it("nothing rings, other words, a label that is a stop phrase (the host's wins), Dutch", () => {
    expect(matchRinging("en", "stop", [])).toBeUndefined()
    expect(matchRinging("en", "snooze it", ringing)).toBeUndefined()
    expect(matchRinging("en", "stop", [{ id: "n", actions: [{ id: "halt", label: "Stop" }] }])).toEqual({ kind: "stop", phrase: "stop" })
    expect(matchRinging("nl", "hou op", ringing)).toEqual({ kind: "stop", phrase: "hou op" })
    expect(matchRinging("nl", "stop", ringing)).toEqual({ kind: "stop", phrase: "stop" })
  })
})

describe("languages", () => {
  it("HOME_LANGUAGE: nl… is Dutch, anything else English; the host's texts have the same keys in both", () => {
    expect([phraseLanguageOf("nl-NL"), phraseLanguageOf("NL"), phraseLanguageOf("en-GB"), phraseLanguageOf(undefined), phraseLanguageOf("de")]).toEqual(["nl", "nl", "en", "en", "en"])
    expect(Object.keys(PHRASE_TEXTS.nl).sort()).toEqual(Object.keys(PHRASE_TEXTS.en).sort())
    expect(Object.keys(HOST_CONTROL_PHRASES.nl).sort()).toEqual(Object.keys(HOST_CONTROL_PHRASES.en).sort())
  })
})
