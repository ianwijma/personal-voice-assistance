import { defineTexts } from "@pva/module-contracts"

/** Every sentence the weather extension says itself, in English and Dutch with the same placeholders. */
export const texts = defineTexts({
  en: {
    noPlace: "I don't know where home is yet. The owner can set it under Home, or tell me a place.",
    unknownPlace: "I couldn't find a place called {place}.",
    unreachable: "I can't reach the weather service right now.",
    unreadable: "The weather service sent me something I couldn't read.",
    noRainData: "I can't get rain data for {place}.",
    rainNone: "No rain expected{where} for the next {span}.",
    rainNowStops: "{kind} now{where}, easing off around {time}.",
    rainNowStays: "{kind} now{where}, and it keeps on for the next {span}.",
    rainStarts: "Dry{where} until about {time}, then {kind}.",
    rainStartsFor: "Dry{where} until about {time}, then {kind} for about {span}.",
    kindLight: "light rain",
    kindModerate: "moderate rain",
    kindHeavy: "heavy rain",
    dayAsk: "Which day do you mean? I can give today, tomorrow or a day this week.",
    dayTooFar: "I can only look a week ahead.",
    forecast: "{day}{where}: {condition}, {min} to {max} {degrees}{rain}{wind}.",
    degrees: "degrees",
    degreesF: "degrees Fahrenheit",
    rainChance: ", {n} percent chance of rain",
    windUpTo: ", wind up to {n} {unit}",
    hours: " In the next {n} hours: {min} to {max} {degrees}, up to {p} percent chance of rain.",
    warnNone: "No weather warnings for {place}.",
    warnYes: "Code {level} for {what} in {place}{until}.",
    warnUntil: " until {when}",
    warnMore: " And {count} more.",
    warnUnavailable: "I can't check weather warnings at the moment.",
    levelYellow: "yellow",
    levelOrange: "orange",
    levelRed: "red",
    at: "{day} at {time}",
    typeWind: "wind", typeSnow: "snow and ice", typeThunder: "thunderstorms", typeFog: "fog", typeHeat: "high temperatures",
    typeCold: "low temperatures", typeCoast: "coastal conditions", typeFire: "forest fire risk", typeAvalanche: "avalanches",
    typeRain: "rain", typeFlood: "flooding", typeRainFlood: "rain and flooding", typeOther: "dangerous weather"
  },
  nl: {
    noPlace: "Ik weet nog niet waar thuis is. De eigenaar kan het instellen onder Thuis, of noem een plaats.",
    unknownPlace: "Ik kon geen plaats vinden die {place} heet.",
    unreachable: "Ik kan de weerdienst nu niet bereiken.",
    unreadable: "De weerdienst stuurde iets wat ik niet kon lezen.",
    noRainData: "Ik kan geen regengegevens krijgen voor {place}.",
    rainNone: "Geen regen verwacht{where} de komende {span}.",
    rainNowStops: "{kind} nu{where}, het wordt droog rond {time}.",
    rainNowStays: "{kind} nu{where}, en het blijft regenen de komende {span}.",
    rainStarts: "Droog{where} tot ongeveer {time}, daarna {kind}.",
    rainStartsFor: "Droog{where} tot ongeveer {time}, daarna {kind} gedurende ongeveer {span}.",
    kindLight: "lichte regen",
    kindModerate: "matige regen",
    kindHeavy: "zware regen",
    dayAsk: "Welke dag bedoel je? Ik kan vandaag, morgen of een dag deze week geven.",
    dayTooFar: "Ik kan maar een week vooruit kijken.",
    forecast: "{day}{where}: {condition}, {min} tot {max} {degrees}{rain}{wind}.",
    degrees: "graden",
    degreesF: "graden Fahrenheit",
    rainChance: ", {n} procent kans op regen",
    windUpTo: ", wind tot {n} {unit}",
    hours: " In de komende {n} uur: {min} tot {max} {degrees}, tot {p} procent kans op regen.",
    warnNone: "Geen weerwaarschuwingen voor {place}.",
    warnYes: "Code {level} voor {what} in {place}{until}.",
    warnUntil: " tot {when}",
    warnMore: " En nog {count}.",
    warnUnavailable: "Ik kan de weerwaarschuwingen op dit moment niet controleren.",
    levelYellow: "geel",
    levelOrange: "oranje",
    levelRed: "rood",
    at: "{day} om {time}",
    typeWind: "wind", typeSnow: "sneeuw en ijzel", typeThunder: "onweer", typeFog: "mist", typeHeat: "hoge temperaturen",
    typeCold: "lage temperaturen", typeCoast: "kustomstandigheden", typeFire: "kans op bosbrand", typeAvalanche: "lawines",
    typeRain: "regen", typeFlood: "overstroming", typeRainFlood: "regen en overstroming", typeOther: "gevaarlijk weer"
  }
})

/** WMO weather interpretation codes, as documented by Open-Meteo, in English. */
export const conditionsEn: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "heavy freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light rain showers", 81: "rain showers", 82: "violent rain showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail"
}
/** WMO weather codes, in Dutch (the English names are `describeCode` in `weather.ts`). */
export const conditionsNl: Record<number, string> = {
  0: "onbewolkt", 1: "overwegend helder", 2: "half bewolkt", 3: "bewolkt",
  45: "mist", 48: "rijpmist",
  51: "lichte motregen", 53: "motregen", 55: "zware motregen", 56: "ijzel door motregen", 57: "zware ijzel door motregen",
  61: "lichte regen", 63: "regen", 65: "zware regen", 66: "ijzel", 67: "zware ijzel",
  71: "lichte sneeuw", 73: "sneeuw", 75: "zware sneeuw", 77: "korrelsneeuw",
  80: "lichte buien", 81: "buien", 82: "zware buien", 85: "sneeuwbuien", 86: "zware sneeuwbuien",
  95: "onweer", 96: "onweer met hagel", 99: "onweer met zware hagel"
}

/** The names of MeteoAlarm's awareness types (1 to 13), as text keys. */
export const awarenessTypeKeys = {
  1: "typeWind", 2: "typeSnow", 3: "typeThunder", 4: "typeFog", 5: "typeHeat", 6: "typeCold", 7: "typeCoast", 8: "typeFire",
  9: "typeAvalanche", 10: "typeRain", 11: "typeFlood", 12: "typeRainFlood"
} as const satisfies Record<number, keyof typeof texts.en>
