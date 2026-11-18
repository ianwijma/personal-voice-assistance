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
    dayMissing: "I don't have the forecast for that day.",
    hours: " In the next {span}: {min} to {max} {degrees}, up to {p} percent chance of rain.",
    hoursUnknownRain: " In the next {span}: {min} to {max} {degrees}; the chance of rain is not known.",
    hoursNone: " I don't have the forecast for the coming hours.",
    onlyUntil: " I only know until {time}.",
    rainOnlyUntil: "I only know until {time}."
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
    dayMissing: "Ik heb de verwachting voor die dag niet.",
    hours: " In de komende {span}: {min} tot {max} {degrees}, tot {p} procent kans op regen.",
    hoursUnknownRain: " In de komende {span}: {min} tot {max} {degrees}; de kans op regen is niet bekend.",
    hoursNone: " Ik heb de verwachting voor de komende uren niet.",
    onlyUntil: " Ik weet het maar tot {time}.",
    rainOnlyUntil: "Ik weet het maar tot {time}."
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
