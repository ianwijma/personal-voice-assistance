import type { ToolRisk } from "./snapshot.ts"

/**
 * The household's risk policy (docs/MODULES-PLAN.md §2 rows 5 and 6, §4 P8 "First version"; docs/MODULES.md §4): what
 * the execution gateway does with a call of each risk class. One level only, the household's: no narrowing by
 * assistant or device in this version.
 *
 * - `allow` runs the call;
 * - `confirm` refuses it with its own sentence: it would need the owner's confirmation, which the assistant cannot
 *   ask for yet (confirmation is off in this stack, §2 row 6);
 * - `deny` refuses it with another sentence.
 *
 * `money` and `security` are fixed at `deny` everywhere: in the type, in the decoder of the saved value (a settings file
 * that says otherwise is read as `deny`), on the admin page (shown, not editable) and in `decideRisk` itself. A device
 * id is claimed by the page, not authenticated, so no device can be trusted with them yet.
 *
 * Everything here is pure: the server (the gateway, the settings section), the module test kit and the web mock use
 * these same functions, so they cannot disagree.
 */

/** Every risk class, in the order the admin page shows them. */
export const RISK_CLASSES = ["read", "change", "message", "money", "security"] as const satisfies ReadonlyArray<ToolRisk>

/** What the policy says for a class. */
export type RiskOutcome = "allow" | "confirm" | "deny"
export const RISK_OUTCOMES: ReadonlyArray<RiskOutcome> = ["allow", "confirm", "deny"]

/** The classes the owner may set. */
export const SETTABLE_RISK_CLASSES = ["read", "change", "message"] as const
export type SettableRiskClass = typeof SETTABLE_RISK_CLASSES[number]

/** The classes fixed at `deny` in this stack. */
export const FIXED_RISK_CLASSES = ["money", "security"] as const
export type FixedRiskClass = typeof FIXED_RISK_CLASSES[number]

/** The household's policy: one outcome per class; `money` and `security` can only be `deny`. */
export interface RiskPolicy {
  readonly read: RiskOutcome
  readonly change: RiskOutcome
  readonly message: RiskOutcome
  readonly money: "deny"
  readonly security: "deny"
}

/**
 * The default, which is the behaviour before the policy was a setting (P1): `read` and `change` run, `message` is
 * refused as needing confirmation, `money` and `security` are denied. An installation that never saves the setting
 * has exactly this.
 */
export const DEFAULT_RISK_POLICY: RiskPolicy = { read: "allow", change: "allow", message: "confirm", money: "deny", security: "deny" }

/** The flat settings keys of the policy (the `risk` section, stored by key like every household setting). */
export const RISK_POLICY_KEYS = {
  read: "RISK_READ",
  change: "RISK_CHANGE",
  message: "RISK_MESSAGE",
  money: "RISK_MONEY",
  security: "RISK_SECURITY"
} as const satisfies Readonly<Record<ToolRisk, string>>

const isOutcome = (u: unknown): u is RiskOutcome => u === "allow" || u === "confirm" || u === "deny"

/**
 * The policy from saved values (`value(key)`: the effective value of a flat key, or `undefined`). A settable class
 * whose value is not one of the three outcomes (missing, a typo in a hand-edited file) gets its default; `money` and
 * `security` are `deny` whatever the file says.
 */
export const decodeRiskPolicy = (value: (key: string) => unknown): RiskPolicy => {
  const pick = (cls: SettableRiskClass): RiskOutcome => {
    let v: unknown
    try {
      v = value(RISK_POLICY_KEYS[cls])
    } catch {
      v = undefined
    }
    return isOutcome(v) ? v : DEFAULT_RISK_POLICY[cls]
  }
  return { read: pick("read"), change: pick("change"), message: pick("message"), money: "deny", security: "deny" }
}

/** The policy from a partial object (the test kit's `household.risk`), through the same decoder. */
export const riskPolicyOf = (partial: Partial<Readonly<Record<ToolRisk, unknown>>> | undefined): RiskPolicy =>
  decodeRiskPolicy((key) => {
    if (partial === undefined) return undefined
    const cls = RISK_CLASSES.find((c) => RISK_POLICY_KEYS[c] === key)
    return cls === undefined ? undefined : partial[cls]
  })

/**
 * Why a value cannot be saved for a policy key, or `undefined`. `null` (back to the default) is always accepted. A
 * settable class takes one of the three outcomes; a fixed class takes only `deny` (and saving it changes nothing).
 * Not a policy key: `undefined` (not this function's business).
 */
export const riskPolicyValueProblem = (key: string, value: unknown): string | undefined => {
  if (value === null) return undefined
  const cls = RISK_CLASSES.find((c) => RISK_POLICY_KEYS[c] === key)
  if (cls === undefined) return undefined
  if (cls === "money" || cls === "security") return value === "deny" ? undefined : FIXED_REASON
  return isOutcome(value) ? undefined : "Choose one of the options."
}

/**
 * THE save check of the policy (review round 1, H5): every problem of a patch's values for the policy's keys, in the
 * patch's order, as `{ key, message }` (empty: nothing to refuse for the policy). The real section runs it before its
 * generic form checks, and the web mock runs it too, so both answer a patch the same way; a refused save writes nothing.
 */
export const riskPolicyPatchProblems = (values: Readonly<Record<string, unknown>>): ReadonlyArray<{ readonly key: string; readonly message: string }> =>
  Object.entries(values).flatMap(([key, value]) => {
    const problem = riskPolicyValueProblem(key, value)
    return problem === undefined ? [] : [{ key, message: problem }]
  })

/** Why `money` and `security` cannot be changed (the admin page shows it on their rows). */
export const FIXED_REASON = "Fixed at Refuse: devices are not authenticated yet (a page names its own device), so no device can be trusted to spend money or to work locks, alarms, doors or gates."

/** What the policy decided for one call, and by which class (`unjudged`: its risk function failed; `unknown`: not a class). */
export type RiskDecision =
  | { readonly outcome: "allow"; readonly by: ToolRisk }
  | { readonly outcome: "confirm"; readonly by: SettableRiskClass }
  | { readonly outcome: "deny"; readonly by: ToolRisk | "unjudged" | "unknown" }

const isClass = (u: unknown): u is ToolRisk => typeof u === "string" && (RISK_CLASSES as ReadonlyArray<string>).includes(u)

/**
 * THE decision (the only one): what the household's `policy` says for a call of a tool or action that declares
 * `declared` (every class it can be: one for a fixed class, the list of a risk function), when its risk for this
 * validated input is `risk` (`undefined`: the risk function threw, answered a class it does not declare or took too
 * long, so the call could not be judged).
 *
 * - not judged, or a class it did not declare: `deny` (`unjudged`);
 * - a string that is no class: `deny` (`unknown`);
 * - `money`, `security`: `deny`, whatever `policy` says (a policy object from JavaScript may say anything);
 * - otherwise the policy's outcome for the class (`deny` if the object holds something else).
 */
export const decideRisk = (policy: RiskPolicy, declared: ReadonlyArray<ToolRisk>, risk: ToolRisk | undefined): RiskDecision => {
  if (risk === undefined || !declared.includes(risk)) return { outcome: "deny", by: "unjudged" }
  if (!isClass(risk)) return { outcome: "deny", by: "unknown" }
  if (risk === "money" || risk === "security") return { outcome: "deny", by: risk }
  const outcome: unknown = policy[risk]
  if (outcome === "allow") return { outcome: "allow", by: risk }
  if (outcome === "confirm") return { outcome: "confirm", by: risk }
  return { outcome: "deny", by: risk }
}

/**
 * Whether a tool or action that declares `declared` is offered at all (a turn's tool list, the action catalogue): the
 * policy allows at least one of its classes, by `decideRisk`. One refused for every class is left out; its calls are
 * refused anyway.
 */
export const riskOffered = (policy: RiskPolicy, declared: ReadonlyArray<ToolRisk>): boolean =>
  declared.some((risk) => decideRisk(policy, declared, risk).outcome === "allow")

/** A short key that changes exactly when what the policy offers changes (a tool list made for one key fits it). */
export const riskPolicyKey = (policy: RiskPolicy): string =>
  (["read", "change", "message"] as const).map((c) => (decideRisk(policy, [c], c).outcome === "allow" ? "1" : "0")).join("")

// ---------------------------------------------------------------------------------------------------------------------
// Sentences: for the model, for speech, and the admin page's labels. English and Dutch, chosen by the household's
// language (`HOME_LANGUAGE`: Dutch for `nl-…`, English otherwise).

export type RiskLanguage = "en" | "nl"

/** The language of the sentences for a `HOME_LANGUAGE` value. */
export const riskLanguageOf = (homeLanguage: unknown): RiskLanguage => (typeof homeLanguage === "string" && homeLanguage.toLowerCase().startsWith("nl") ? "nl" : "en")

/** The key of a refusal's sentence: its outcome and class. */
export type RiskRefusalKey =
  | "read.confirm"
  | "read.deny"
  | "change.confirm"
  | "change.deny"
  | "message.confirm"
  | "message.deny"
  | "money.deny"
  | "security.deny"
  | "unknown.deny"
  | "unjudged.deny"

/**
 * Why a call was not run, for the model (after "Not run: " / "Niet uitgevoerd: "). The English sentences of the default
 * policy's refusals (`message`, `money`, `security`, an unknown class, an unjudged call) are the ones the gateway gave
 * before the policy was a setting, word for word.
 */
const MODEL: Readonly<Record<RiskLanguage, Readonly<Record<RiskRefusalKey, string>>>> = {
  en: {
    "read.confirm": "it would look something up, which this household has set to need the owner's confirmation, and this assistant cannot ask for it yet.",
    "read.deny": "it would look something up, which this household does not allow.",
    "change.confirm": "it would change something in the house, which this household has set to need the owner's confirmation, and this assistant cannot ask for it yet.",
    "change.deny": "it would change something in the house, which this household does not allow.",
    "message.confirm": "it would send a message in the owner's name, which needs the owner's confirmation, and this assistant cannot ask for it yet.",
    "message.deny": "it would send a message in the owner's name, which this household does not allow.",
    "money.deny": "it would spend money, which this assistant never does.",
    "security.deny": "it would act on a lock, an alarm, a door or a gate, which this assistant never does.",
    "unknown.deny": "what it would do is not a risk class this assistant knows.",
    "unjudged.deny": "what it would do could not be judged."
  },
  nl: {
    "read.confirm": "het zou iets opzoeken, en dit huishouden heeft ingesteld dat daar eerst bevestiging van de eigenaar voor nodig is, waar deze assistent nog niet om kan vragen.",
    "read.deny": "het zou iets opzoeken, en dat staat dit huishouden niet toe.",
    "change.confirm": "het zou iets in huis veranderen, en dit huishouden heeft ingesteld dat daar eerst bevestiging van de eigenaar voor nodig is, waar deze assistent nog niet om kan vragen.",
    "change.deny": "het zou iets in huis veranderen, en dat staat dit huishouden niet toe.",
    "message.confirm": "het zou een bericht sturen namens de eigenaar, en daar is bevestiging van de eigenaar voor nodig, waar deze assistent nog niet om kan vragen.",
    "message.deny": "het zou een bericht sturen namens de eigenaar, en dat staat dit huishouden niet toe.",
    "money.deny": "het zou geld uitgeven, en dat doet deze assistent nooit.",
    "security.deny": "het zou iets doen met een slot, een alarm, een deur of een hek, en dat doet deze assistent nooit.",
    "unknown.deny": "wat het zou doen is geen risicoklasse die deze assistent kent.",
    "unjudged.deny": "wat het zou doen kon niet worden beoordeeld."
  }
}

/** What the person hears (a typed action said aloud, a press answered on the page). */
const SPOKEN: Readonly<Record<RiskLanguage, Readonly<Record<RiskRefusalKey, string>>>> = {
  en: {
    "read.confirm": "I can't look that up: this household wants the owner to confirm it first, and I can't ask for that yet.",
    "read.deny": "I can't look that up: this household doesn't allow it.",
    "change.confirm": "I can't do that: this household wants the owner to confirm changes first, and I can't ask for that yet.",
    "change.deny": "I can't do that: this household doesn't allow me to change things in the house.",
    "message.confirm": "I can't send that: messages need the owner's confirmation, and I can't ask for that yet.",
    "message.deny": "I can't send that: this household doesn't allow me to send messages.",
    "money.deny": "I can't do that: I never spend money.",
    "security.deny": "I can't do that: I never work locks, alarms, doors or gates.",
    "unknown.deny": "I can't do that.",
    "unjudged.deny": "I can't do that right now."
  },
  nl: {
    "read.confirm": "Dat kan ik niet opzoeken: dit huishouden wil dat de eigenaar het eerst bevestigt, en daar kan ik nog niet om vragen.",
    "read.deny": "Dat kan ik niet opzoeken: dat staat dit huishouden niet toe.",
    "change.confirm": "Dat kan ik niet doen: dit huishouden wil dat de eigenaar wijzigingen eerst bevestigt, en daar kan ik nog niet om vragen.",
    "change.deny": "Dat kan ik niet doen: dit huishouden staat niet toe dat ik iets in huis verander.",
    "message.confirm": "Dat kan ik niet versturen: berichten moet de eigenaar eerst bevestigen, en daar kan ik nog niet om vragen.",
    "message.deny": "Dat kan ik niet versturen: dit huishouden staat niet toe dat ik berichten stuur.",
    "money.deny": "Dat kan ik niet doen: ik geef nooit geld uit.",
    "security.deny": "Dat kan ik niet doen: ik bedien nooit sloten, alarmen, deuren of hekken.",
    "unknown.deny": "Dat kan ik niet doen.",
    "unjudged.deny": "Dat kan ik nu niet doen."
  }
}

const PREFIX: Readonly<Record<RiskLanguage, string>> = { en: "Not run: ", nl: "Niet uitgevoerd: " }

/** The key of a refusal's sentences; `undefined` for an allowed call. */
export const riskRefusalKey = (decision: RiskDecision): RiskRefusalKey | undefined =>
  decision.outcome === "allow" ? undefined : (`${decision.by}.${decision.outcome}` as RiskRefusalKey)

/** The reason a refused call was not run, for the model (without the prefix); `undefined` for an allowed call. */
export const riskReason = (language: RiskLanguage, decision: RiskDecision): string | undefined => {
  const key = riskRefusalKey(decision)
  return key === undefined ? undefined : MODEL[language][key]
}

/** The prefix of a refusal for the model ("Not run: "). */
export const riskRefusalPrefix = (language: RiskLanguage): string => PREFIX[language]

/** What the person hears for a refused call; `undefined` for an allowed call. */
export const riskSpoken = (language: RiskLanguage, decision: RiskDecision): string | undefined => {
  const key = riskRefusalKey(decision)
  return key === undefined ? undefined : SPOKEN[language][key]
}

/**
 * What the model gets instead of a `personal` result the asking device may not reveal (`Privacy.mayReveal`): a fixed
 * sentence, never a part of the content.
 */
const WITHHELD: Readonly<Record<RiskLanguage, string>> = {
  en: "Withheld: the result is personal to someone, and this device may not reveal it. Say that it cannot be shared here.",
  nl: "Achtergehouden: het resultaat is persoonlijk, en dit apparaat mag het niet laten zien of uitspreken. Zeg dat het hier niet gedeeld kan worden."
}

export const riskWithheld = (language: RiskLanguage): string => WITHHELD[language]

/** The admin page's words for each outcome and class, and its explanation of the sentences (English and Dutch). */
const PAGE: Readonly<Record<RiskLanguage, {
  readonly outcomes: Readonly<Record<RiskOutcome, string>>
  readonly classes: Readonly<Record<ToolRisk, string>>
  readonly heading: string
  readonly intro: string
}>> = {
  en: {
    outcomes: { allow: "Run it", confirm: "Refuse: needs confirmation", deny: "Refuse" },
    classes: { read: "Look things up", change: "Change things in the house", message: "Send messages", money: "Spend money", security: "Locks, alarms, doors and gates" },
    heading: "What the assistant says when it refuses",
    intro: "In the household's language. A refusal says which kind of thing it would have done; the model hears a sentence like it and words its reply."
  },
  nl: {
    outcomes: { allow: "Uitvoeren", confirm: "Weigeren: bevestiging nodig", deny: "Weigeren" },
    classes: { read: "Dingen opzoeken", change: "Iets in huis veranderen", message: "Berichten sturen", money: "Geld uitgeven", security: "Sloten, alarmen, deuren en hekken" },
    heading: "Wat de assistent zegt als hij weigert",
    intro: "In de taal van het huishouden. Een weigering zegt wat voor iets het zou hebben gedaan; het model krijgt een vergelijkbare zin en verwoordt zelf het antwoord."
  }
}

export const riskPageTexts = (language: RiskLanguage) => PAGE[language]

/** Every table, for the test that compares their keys across languages. */
export const RISK_TEXTS = { model: MODEL, spoken: SPOKEN, withheld: WITHHELD, page: PAGE, prefix: PREFIX } as const
