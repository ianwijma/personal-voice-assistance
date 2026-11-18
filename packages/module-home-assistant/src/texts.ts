import type { HostView } from "@pva/core"

/**
 * Every sentence the module speaks, failures, questions and refusals included, in English and Dutch with the same
 * placeholders (docs/MODULES.md §16). Fragments (`whatArea`, `kindLights`, …) are filled into the sentences in the
 * household's language, so a sentence never mixes the two.
 *
 * **Local helpers.** `homeLanguage` and `say` below do what `@pva/module-contracts` exports under the same names. This
 * package does not depend on `@pva/module-contracts` (the scaffold did not add it, and a module pull request may not
 * change the lockfile), so they are written out here, four lines each. When the dependency is added they are replaced
 * by the imports, unchanged in behaviour (the texts table already has `defineTexts`'s shape).
 */
export const texts = {
  en: {
    unreachable: "I couldn't reach Home Assistant.",
    timeoutChange: "Home Assistant didn't answer in time, so I don't know whether it happened.",
    timeoutRead: "Home Assistant didn't answer in time.",
    unauthorized: "Home Assistant refused my access token; a new one can be set on the module's page.",
    forbidden: "Home Assistant refused: the token's user must be an administrator.",
    restarting: "Home Assistant is restarting. Try again in a minute.",
    failed: "Home Assistant reported an error.",
    invalid: "Home Assistant sent an answer I can't read.",
    notLoaded: "I haven't been able to read the house from Home Assistant yet.",
    whichRoom: "Which room? I don't know which room this device is in.",
    roomUnknown: "I don't know a room called {room} in Home Assistant. Which room do you mean?",
    nothingThere: "There are no {things} in {area} that I may use.",
    nothingAtAll: "Home Assistant has no {things} that I may use.",
    unknownTarget: "I don't know {name} in Home Assistant any more.",
    securityCover: "I don't open or close garage doors, gates or doors by voice.",
    turnedOn: "I've turned on {what}.",
    turnedOff: "I've turned off {what}.",
    brightness: "I've set {what} to {level} percent.",
    temperature: "I've set {what} to {temperature} degrees.",
    temperatureNow: "I've set {what} to {temperature} degrees; it's {current} degrees now.",
    mode: "I've set {what} to {mode}.",
    modeUnsupported: "{what} can't be set to {mode}.",
    opening: "I'm opening {what}.",
    closing: "I'm closing {what}.",
    stopping: "I've stopped {what}.",
    position: "I'm setting {what} to {position} percent open.",
    positionUnsupported: "{what} can't be set to a position; say open or close.",
    started: "I've started {name}.",
    lightsAllOff: "All the lights are off.",
    lightsAllOn: "All the lights are on.",
    lightsOneOn: "{names} is on.",
    lightsSomeOn: "{names} are on.",
    climateItem: "{name} is {current} degrees, set to {target}",
    climateItemCurrent: "{name} is {current} degrees",
    climateItemTarget: "{name} is set to {target} degrees",
    climateItemOff: "{name} is off, at {current} degrees",
    climateItemUnknown: "{name} has no temperature",
    statusLine: "{items}.",
    lockLocked: "{name} is locked",
    lockUnlocked: "{name} is unlocked",
    lockOther: "{name} is {state}",
    coverOpen: "{name} is open",
    coverClosed: "{name} is closed",
    alarmDisarmed: "{name} is disarmed",
    alarmArmed: "{name} is armed",
    more: "and {count} more",
    whatArea: "the {things} in {area}",
    whatAll: "all the {things}",
    kindLights: "lights",
    kindSwitches: "switches",
    kindClimate: "heating",
    kindCovers: "blinds",
    kindTemperature: "thermostats or temperature sensors",
    kindLocks: "locks, alarms or garage doors",
    modeHeat: "heating",
    modeCool: "cooling",
    modeAuto: "automatic",
    modeOff: "off",
    unknownName: "an unnamed device",
    roomless: "Without a room"
  },
  nl: {
    unreachable: "Ik kon Home Assistant niet bereiken.",
    timeoutChange: "Home Assistant antwoordde niet op tijd, dus ik weet niet of het gelukt is.",
    timeoutRead: "Home Assistant antwoordde niet op tijd.",
    unauthorized: "Home Assistant weigerde mijn toegangssleutel; op de pagina van de module kan een nieuwe worden ingesteld.",
    forbidden: "Home Assistant weigerde: de gebruiker van de sleutel moet beheerder zijn.",
    restarting: "Home Assistant start opnieuw op. Probeer het over een minuut nog eens.",
    failed: "Home Assistant meldde een fout.",
    invalid: "Home Assistant stuurde een antwoord dat ik niet kan lezen.",
    notLoaded: "Ik heb het huis nog niet uit Home Assistant kunnen lezen.",
    whichRoom: "Welke kamer? Ik weet niet in welke kamer dit apparaat staat.",
    roomUnknown: "Ik ken geen kamer {room} in Home Assistant. Welke kamer bedoel je?",
    nothingThere: "Er zijn geen {things} in {area} die ik mag gebruiken.",
    nothingAtAll: "Home Assistant heeft geen {things} die ik mag gebruiken.",
    unknownTarget: "Ik ken {name} niet meer in Home Assistant.",
    securityCover: "Garagedeuren, poorten en deuren doe ik niet open of dicht met spraak.",
    turnedOn: "Ik heb {what} aangezet.",
    turnedOff: "Ik heb {what} uitgezet.",
    brightness: "Ik heb {what} op {level} procent gezet.",
    temperature: "Ik heb {what} op {temperature} graden gezet.",
    temperatureNow: "Ik heb {what} op {temperature} graden gezet; het is nu {current} graden.",
    mode: "Ik heb {what} op {mode} gezet.",
    modeUnsupported: "{what} kan niet op {mode} worden gezet.",
    opening: "Ik doe {what} open.",
    closing: "Ik doe {what} dicht.",
    stopping: "Ik heb {what} stilgezet.",
    position: "Ik zet {what} op {position} procent open.",
    positionUnsupported: "{what} kan niet op een stand worden gezet; zeg open of dicht.",
    started: "Ik heb {name} gestart.",
    lightsAllOff: "Alle lampen zijn uit.",
    lightsAllOn: "Alle lampen zijn aan.",
    lightsOneOn: "{names} is aan.",
    lightsSomeOn: "{names} zijn aan.",
    climateItem: "{name} is {current} graden, ingesteld op {target}",
    climateItemCurrent: "{name} is {current} graden",
    climateItemTarget: "{name} staat op {target} graden",
    climateItemOff: "{name} staat uit, op {current} graden",
    climateItemUnknown: "{name} heeft geen temperatuur",
    statusLine: "{items}.",
    lockLocked: "{name} is op slot",
    lockUnlocked: "{name} is niet op slot",
    lockOther: "{name} is {state}",
    coverOpen: "{name} is open",
    coverClosed: "{name} is dicht",
    alarmDisarmed: "{name} is uitgeschakeld",
    alarmArmed: "{name} is ingeschakeld",
    more: "en nog {count}",
    whatArea: "de {things} in {area}",
    whatAll: "alle {things}",
    kindLights: "lampen",
    kindSwitches: "schakelaars",
    kindClimate: "verwarming",
    kindCovers: "zonwering",
    kindTemperature: "thermostaten of temperatuursensoren",
    kindLocks: "sloten, alarmen of garagedeuren",
    modeHeat: "verwarmen",
    modeCool: "koelen",
    modeAuto: "automatisch",
    modeOff: "uit",
    unknownName: "een apparaat zonder naam",
    roomless: "Zonder kamer"
  }
} as const

export type TextKey = keyof typeof texts.en
export type Language = "en" | "nl"

/** The household's language from the Home section (`HOME_LANGUAGE`: `nl-…` is Dutch, anything else English). */
export const homeLanguage = (view: Pick<HostView, "home">): Language => {
  const value = view.home.HOME_LANGUAGE
  return typeof value === "string" && value.toLowerCase().startsWith("nl") ? "nl" : "en"
}

/** One text in `language`, its placeholders filled; a placeholder without a value stays as written. */
export const say = (language: Language, key: TextKey, values: Readonly<Record<string, string | number>> = {}): string =>
  texts[language][key].replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole))

/** The same with its first letter in upper case: a sentence that starts with a filled-in fragment ("the lights in …"). */
export const sentence = (language: Language, key: TextKey, values: Readonly<Record<string, string | number>> = {}): string => {
  const text = say(language, key, values)
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1)
}

/** "A, B and C" / "A, B en C"; at most `max` items, then "and 3 more" / "en nog 3". */
export const joinList = (language: Language, items: ReadonlyArray<string>, max = 6): string => {
  const shown = items.slice(0, max)
  const rest = items.length - shown.length
  const parts = rest > 0 ? [...shown, say(language, "more", { count: rest })] : shown
  const and = language === "nl" ? " en " : " and "
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")}${and}${parts[parts.length - 1]}`
}

/** A temperature or a level as it is said: at most one decimal, with the language's decimal sign ("18.5", "18,5"). */
export const spokenNumber = (language: Language, n: number): string => {
  const rounded = Math.round(n * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return language === "nl" ? text.replace(".", ",") : text
}
