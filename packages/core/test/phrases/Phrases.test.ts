// P7 (docs/PHRASES.md): the matcher by table. Both languages; case, punctuation and whitespace; slots of each `Param`
// kind that read and that do not; the longest phrase; duplicates; the host's reserved phrases; every bound. And the
// ringing window's phrases.
import { describe, expect, it } from "vitest"
import {
  type ActionPhrases,
  buildCommandSet,
  compileActionPhrases,
  defineAction,
  HOST_CONTROL_PHRASES,
  HOST_CONTROLS,
  type CommandSet,
  hostCommandSet,
  matchCommand,
  matchRinging,
  Param,
  PHRASE_LIMITS,
  PHRASE_TEXTS,
  phraseConflictIssues,
  phraseLanguageOf,
  phraseProblems,
  PREPARE_STEP_WORK,
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
    params: { room: Param.choice({ label: "Room", options: rooms }) },
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
    ["garage lights on", "a room that is not one of the choice"],
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

  it("a host control that is longer than a module phrase reading the same words wins (the reachable case)", () => {
    const tie = actionsOf("a", [{ id: "x", label: "X", description: "X.", params: { thing: Param.text({ label: "Thing", after: [] }) }, phrases: { en: ["{thing} up"] }, run: () => Effect.void }])
    const set = buildCommandSet("en", tie)
    // "turn it up" is the host's (3 literal words); "{thing} up" reads it too, with 1.
    expect(idOf(matchCommand(set, "turn it up"))).toBe("control:louder")
    expect(idOf(matchCommand(set, "the radio up"))).toBe("a.x")
  })

  it("a host control beats a module phrase of the same length (a set made by hand: a module start refuses such a phrase, so it is a defence)", () => {
    const [own] = actionsOf("a", [{ id: "x", label: "X", description: "X.", params: {}, phrases: { en: ["louder"] }, run: () => Effect.void }])
    const host = hostCommandSet("en")
    const forged: CommandSet = { ...host, phrases: [{ owner: { kind: "action", action: own! }, text: "turn it up", shape: "turn it up", parts: ["turn", "it", "up"], literals: 3, defaults: {} }, ...host.phrases] }
    expect(idOf(matchCommand(forged, "turn it up"))).toBe("control:louder")
  })

  it("two modules tied on an utterance match nothing; the same shape twice is a duplicate", () => {
    const a = actionsOf("a", [{ id: "x", label: "X", description: "X.", params: { room: Param.choice({ label: "Room", options: rooms }) }, phrases: { en: ["{room} please"] }, run: () => Effect.void }])
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
  const room = { room: Param.choice({ label: "Room", options: rooms }) }

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

  it(`at most ${PHRASE_LIMITS.slotReads} slot readings an utterance: a sentence that aligns everywhere is not taken once they are spent`, () => {
    // Every shape of 3 to 6 tokens over the words "x" and "and" with two number slots that are not side by side.
    const shapes: Array<string> = []
    for (let n = 3; n <= 6; n++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        for (let i = 0; i < n; i++) {
          for (let j = i + 2; j < n; j++) {
            shapes.push(Array.from({ length: n }, (_, k) => (k === i ? "{a}" : k === j ? "{b}" : (mask >> k) & 1 ? "and" : "x")).join(" "))
          }
        }
      }
    }
    const unique = [...new Set(shapes)].slice(0, 128)
    const numbers = { a: Param.number({ label: "A" }), b: Param.number({ label: "B" }) }
    const actions = Array.from({ length: 16 }, (_, m) => actionsOf(`m${m}`, [{ id: "x", label: "X", description: "X.", params: numbers, phrases: { en: unique.slice(m * 8, m * 8 + 8) }, run: () => Effect.void }])).flat()
    const set = buildCommandSet("en", actions)
    expect(set.conflicts).toEqual([])
    const stats = { words: 0, phrases: 0, reads: 0, exhausted: false }
    expect(matchCommand(set, "x and x and x and x and x", stats)).toBeUndefined()
    expect(stats).toMatchObject({ words: 9, reads: PHRASE_LIMITS.slotReads, exhausted: true })
    // An ordinary sentence costs two readings.
    const plain = buildCommandSet("en", actionsOf("p", [{ id: "x", label: "X", description: "X.", params: numbers, phrases: { en: ["{a} and {b}"] }, run: () => Effect.void }]))
    const two = { words: 0, phrases: 0, reads: 0, exhausted: false }
    expect(matchCommand(plain, "five and six", two)).toMatchObject({ values: { a: 5, b: 6 } })
    expect(two).toMatchObject({ reads: 2, exhausted: false })
  })

  it("a3: a search that spent its budget returns no provisional shorter match; the longest wins when it completes", () => {
    // The reviewer's case: a valid short phrase, then aligned candidates whose slots never read, then the longest phrase.
    const text = "please turn the kitchen and hall lights on now"
    const w = text.split(" ")
    const patterns: Array<string> = []
    for (let a = 0; a < w.length; a++) for (let b = a + 1; b <= w.length; b++) for (let c = b + 1; c < w.length; c++) for (let d = c + 1; d <= w.length; d++) {
      const p = [...w.slice(0, a), "{a}", ...w.slice(b, c), "{b}", ...w.slice(d)]
      if (b - a <= 8 && d - c <= 8 && p.length <= 8 && p.length > 2) patterns.push(p.join(" "))
    }
    const uniq = [...new Set(patterns)]
    const literals = (p: string) => p.split(" ").length - 2
    const low = uniq.filter((p) => literals(p) === 1).slice(0, 1)
    const fillers = uniq.filter((p) => literals(p) >= 2 && literals(p) <= 4).slice(0, 70)
    const longest = uniq.find((p) => literals(p) === 6)!
    const mk = (id: string, ps: ReadonlyArray<string>, good: boolean) =>
      actionsOf(id, [{
        id: "run",
        label: "Run",
        description: "Run.",
        params: { a: good ? Param.text({ label: "A", after: [] }) : Param.choice({ label: "A", options: [{ value: "impossible", label: "impossible" }] }), b: Param.text({ label: "B", after: [] }) },
        phrases: { en: ps },
        run: () => Effect.void
      }])
    const actions = [...mk("short", low, true), ...Array.from({ length: Math.ceil(fillers.length / 8) }, (_, i) => mk(`fill${i}`, fillers.slice(i * 8, i * 8 + 8), false)).flat(), ...mk("long", [longest], true)]
    const stats = { words: 0, phrases: 0, reads: 0, exhausted: false }
    expect(matchCommand(buildCommandSet("en", actions), text, stats)).toBeUndefined()
    expect(stats.exhausted).toBe(true)
    // The longest first: proved (the shorter ones are not even read), so it wins.
    expect(idOf(matchCommand(buildCommandSet("en", [...actions.slice(-1), ...actions.slice(0, -1)]), text))).toBe("long.run")
  })

  it("E1: a parameter whose options come from a callback cannot be a slot (refused, saying what to do); a choice has at most 32 options", () => {
    const dynamic = phraseProblems("mod", [{ id: "clean", params: { room: Param.dynamic({ label: "Room", options: () => rooms }) }, phrases: { en: ["clean the {room}"] } }])
    expect(dynamic.join()).toContain("make the parameter text (Param.text) and resolve the name in the action")
    const big = Array.from({ length: 33 }, (_, i) => ({ value: `o${i}`, label: `option ${i}` }))
    expect(phraseProblems("mod", [{ id: "pick", params: { o: Param.choice({ label: "O", options: big }) }, phrases: { en: ["pick {o}"] } }]).join()).toContain("33 options; a phrase reads at most 32")
    expect(phraseProblems("mod", [{ id: "pick", params: { o: Param.choice({ label: "O", options: big.slice(0, 32) }) }, phrases: { en: ["pick {o}"] } }])).toEqual([])
  })

  it("E1: a match calls no module code (a choice's names are read from what was prepared)", () => {
    const options = [{ value: "kitchen", label: "Kitchen", aliases: ["keuken"] }]
    const set = buildCommandSet("en", actionsOf("t", [{ id: "x", label: "X", description: "X.", params: { room: Param.choice({ label: "Room", options }) }, phrases: { en: ["clean the {room}"] }, run: () => Effect.void }]))
    // The declaration's list changing afterwards changes nothing: the set holds what it prepared.
    ;(options as Array<{ value: string; label: string; aliases?: Array<string> }>).push({ value: "hall", label: "Hall" })
    expect(matchCommand(set, "clean the hall")).toBeUndefined()
    expect(matchCommand(set, "clean the Keuken")).toMatchObject({ values: { room: "kitchen" } })
  })
})

describe("slots are read from the characters said (E2, a2)", () => {
  const set = buildCommandSet("en", actionsOf("s", [
    { id: "num", label: "N", description: "N.", params: { n: Param.number({ label: "N", min: -100, max: 100 }) }, phrases: { en: ["set {n}"] }, run: () => Effect.void },
    { id: "pct", label: "P", description: "P.", params: { p: Param.number({ label: "P", unit: "percent" }) }, phrases: { en: ["dim {p}"] }, run: () => Effect.void },
    { id: "wait", label: "W", description: "W.", params: { d: Param.duration({ label: "D" }) }, phrases: { en: ["wait {d}"] }, run: () => Effect.void },
    { id: "note", label: "T", description: "T.", params: { t: Param.text({ label: "T", after: [] }) }, phrases: { en: ["note {t}"] }, run: () => Effect.void }
  ]))
  it.each([
    ["set -5", { n: -5 }],
    ["set −5", { n: -5 }],
    ["set .5", { n: 0.5 }],
    ["set 5.", { n: 5 }],
    ["dim 40%", { p: 40 }],
    ["note #123", { t: "#123" }],
    ["note .NET", { t: ".NET" }],
    ["note C++", { t: "C++" }],
    ["note C++.", { t: "C++" }]
  ])("%j reads %j", (said, values) => {
    expect(matchCommand(set, said)).toMatchObject({ values })
  })
  it.each([
    ["set –5", "a dash that is no minus"],
    ["set 5%", "a percent sign on a number without a unit"],
    ["set 5°", "a degree sign on a number without a unit"],
    ["wait -5 minutes", "a negative duration"],
    ["wait minus five minutes", "a negative duration in words"]
  ])("%j does not match (%s)", (said) => {
    expect(matchCommand(set, said)).toBeUndefined()
  })
})

describe("review round 2, a1: a leading decimal comma is the number's; a number covers every mark of its slot", () => {
  const actions = actionsOf("r", [
    { id: "num", label: "N", description: "N.", params: { n: Param.number({ label: "N" }) }, phrases: { en: ["set {n}", "set {n} now"], nl: ["zet {n}", "zet {n} nu"] }, run: () => Effect.void },
    { id: "pct", label: "P", description: "P.", params: { p: Param.number({ label: "P", unit: "percent" }) }, phrases: { en: ["dim {p}", "dim {p} now"] }, run: () => Effect.void },
    { id: "wait", label: "W", description: "W.", params: { d: Param.duration({ label: "D" }) }, phrases: { en: ["wait {d}", "wait {d} now"], nl: ["wacht {d}"] }, run: () => Effect.void },
    { id: "note", label: "T", description: "T.", params: { t: Param.text({ label: "T", after: [] }) }, phrases: { en: ["note {t}", "note {t} now"] }, run: () => Effect.void }
  ])
  const en = buildCommandSet("en", actions)
  const nl = buildCommandSet("nl", actions)
  it.each([
    [en, "set ,5", { n: 0.5 }],
    [en, "set ,5.", { n: 0.5 }],
    [en, "set ,5 now", { n: 0.5 }],
    [en, "set, ,5 now", { n: 0.5 }],
    [en, "set ,25 now", { n: 0.25 }],
    [en, "dim ,5% now", { p: 0.5 }],
    [nl, "zet ,5", { n: 0.5 }],
    [nl, "zet ,5 nu", { n: 0.5 }],
    [en, "set, 5", { n: 5 }],
    [en, "set 5, now", { n: 5 }],
    [en, "set -5 now", { n: -5 }],
    [en, "dim 40% now", { p: 40 }],
    [en, "note ,5 now", { t: ",5" }],
    [en, "note #5", { t: "#5" }]
  ])("%#: %j reads %j", (set, said, values) => {
    expect(matchCommand(set, said)).toMatchObject({ values })
  })
  it.each([
    [en, "wait ,5 minutes", "a decimal comma before a duration"],
    [en, "wait ,5 minutes now", "a decimal comma before a duration, between literal words"],
    [nl, "wacht ,5 minuten", "a decimal comma before a duration (Dutch)"],
    [en, "set #5", "a number sign"],
    [en, "set $5", "a currency sign"],
    [en, "set €5 now", "a currency sign, between literal words"],
    [en, "set 5+", "a plus after it"],
    [en, "set +5", "a plus before it (no sign the value parser reads)"],
    [en, "set 5/", "a slash after it"],
    [en, "set 5/ now", "a slash after it, between literal words"],
    [en, "set (5)", "brackets"],
    [en, "set 5 % % now", "a second percent sign"],
    [en, "wait 5 minutes+", "a plus after a duration"],
    [nl, "zet #5 nu", "a number sign (Dutch)"]
  ])("%#: %j does not match (%s)", (set, said) => {
    expect(matchCommand(set, said)).toBeUndefined()
  })
})

describe("review round 2, a2: a choice's name budget, its keys made once, and none made by the check", () => {
  const name = (s: string, n: number = PHRASE_LIMITS.choiceNameChars) => `${s} ${"x".repeat(n)}`.slice(0, n)
  /** 32 options, a value and a label each, and `aliases` aliases spread over them; names of `chars` characters. */
  const choice = (aliases: number, chars: number = PHRASE_LIMITS.choiceNameChars) =>
    Param.choice({
      label: "C",
      options: Array.from({ length: 32 }, (_, i) => ({ value: name(`v${i}`, chars), label: name(`label ${i}`, chars), aliases: i < aliases ? [name(`alias ${i}`, chars)] : [] }))
    })
  const declared = (param: ReturnType<typeof choice>, id = "go") => ({ id, label: "Go", description: "Go.", params: { c: param }, phrases: { en: Array.from({ length: 8 }, (_, v) => `go variant${v} to {c}`) }, run: () => Effect.void })

  it("96 names of 40 characters are read; a 97th name, or a name of 41 characters, refuses the start with a sentence that says so", () => {
    expect(phraseProblems("m", [defineAction(declared(choice(32)))])).toEqual([])
    const full = choice(32)
    const one = Param.choice({ label: "C", options: [...full.options.slice(0, 31), { ...full.options[31]!, aliases: [name("one"), name("two")] }] })
    const over = phraseProblems("m", [defineAction(declared(one))])
    expect(over).toHaveLength(8)
    expect(over[0]).toContain("is a choice of 97 names (values, labels and aliases counted); a phrase reads at most 96")
    const long = phraseProblems("m", [defineAction(declared(choice(0, 41)))])
    expect(long[0]).toContain("of more than 40 characters")
    expect(long).toHaveLength(8)
  })

  it("a choice's keys are made once, when a set is compiled, and reused by every phrase and action that reads it; the check makes none", () => {
    const shared = choice(32)
    const defs = [defineAction(declared(shared, "one")), defineAction(declared(shared, "two"))]
    expect(phraseProblems("m", defs)).toEqual([])
    const [one, two] = registerActions("m", defs)
    const work = { units: 0 }
    expect(compileActionPhrases("en", one!, work)).toHaveLength(8)
    // 8 phrases, and the choice's 96 names once (the check before made none).
    expect(work.units).toBe(8 + PHRASE_LIMITS.choiceNames)
    work.units = 0
    expect(compileActionPhrases("en", two!, work)).toHaveLength(8)
    expect(work.units).toBe(8)
    expect(PREPARE_STEP_WORK).toBeLessThan(PHRASE_LIMITS.choiceNames * 4)
  })
})

describe("a4: a parameter the phrase leaves out gets what every path gives it", () => {
  it("its declared default, false for a yes/no parameter, undefined otherwise", () => {
    const set = buildCommandSet("en", actionsOf("f", [{
      id: "fan",
      label: "Fan",
      description: "Fan.",
      params: {
        speed: Param.choice({ label: "Speed", options: [{ value: "low", label: "low" }, { value: "high", label: "high" }], default: "low", optional: true }),
        yes: Param.boolean({ label: "Yes", question: "Yes?" }),
        minutes: Param.number({ label: "Minutes", optional: true })
      },
      phrases: { en: ["fan on", "fan on {speed}"] },
      run: () => Effect.void
    }]))
    expect(matchCommand(set, "fan on")).toMatchObject({ values: { speed: "low", yes: false, minutes: undefined } })
    expect(matchCommand(set, "fan on high")).toMatchObject({ values: { speed: "high", yes: false } })
  })
})

describe("a13: canonically equivalent input gives the same words", () => {
  const set = (lang: "en" | "nl") => buildCommandSet(lang, actionsOf("k", [
    { id: "dessert", label: "D", description: "D.", params: {}, phrases: { en: ["make crème brûlée"] }, run: () => Effect.void },
    { id: "timer", label: "T", description: "T.", params: { n: Param.text({ label: "N", after: [] }) }, phrases: { nl: ["zet één timer {n}"] }, run: () => Effect.void }
  ]))
  it("English and Dutch, composed and decomposed, in the phrase and the utterance; a slot keeps the original characters", () => {
    expect(idOf(matchCommand(set("en"), "make crème brûlée".normalize("NFC")))).toBe("k.dessert")
    expect(idOf(matchCommand(set("en"), "make crème brûlée".normalize("NFD")))).toBe("k.dessert")
    const nfd = "zet één timer café".normalize("NFD")
    expect(matchCommand(set("nl"), nfd)).toMatchObject({ values: { n: "café".normalize("NFD") } })
    expect(idOf(matchCommand(set("nl"), "zet één timer koffie".normalize("NFC")))).toBe("k.timer")
    // A ringing label too.
    expect(matchRinging("nl", "Één keer".normalize("NFD"), [{ id: "n", actions: [{ id: "once", label: "één keer".normalize("NFC") }] }])).toMatchObject({ kind: "action", actionId: "once" })
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
