import { defineTexts } from "@pva/module-contracts"

/** Every sentence the briefing module speaks itself (the sections' own sentences are theirs), in both languages. */
export const texts = defineTexts({
  en: {
    morning: "Good morning.",
    evening: "Good evening.",
    noSources: "I have no briefing sources yet: switch on weather, calendar or news for me.",
    nothing: "There is nothing to tell you right now.",
    failed: "I couldn't get the {titles}.",
    withheld: "Some personal items are not read out here.",
    whose: "Whose preference is that? I can't tell who is asking here.",
    prefNone: "Tell me how long your briefing should be, or which section to leave out or bring back.",
    prefLength: "Okay, your briefing will be {length}.",
    prefSkip: "Okay, I'll leave out {sections}.",
    prefUnskip: "Okay, {sections} is back in your briefing.",
    prefBadSection: "I don't know a section called that. Use its name, like weather or news.",
    prefFull: "I can leave out at most {count} sections.",
    prefUnsaved: "I couldn't save that preference. Try again in a moment.",
    short: "short",
    normal: "normal",
    long: "long"
  },
  nl: {
    morning: "Goedemorgen.",
    evening: "Goedenavond.",
    noSources: "Ik heb nog geen bronnen voor een briefing: zet het weer, de agenda of het nieuws voor me aan.",
    nothing: "Er is nu niets te vertellen.",
    failed: "Ik kon {titles} niet ophalen.",
    withheld: "Sommige persoonlijke items lees ik hier niet voor.",
    whose: "Van wie is die voorkeur? Ik weet hier niet wie het vraagt.",
    prefNone: "Zeg hoe lang je briefing moet zijn, of welk onderdeel ik weg moet laten of terug moet zetten.",
    prefLength: "Oké, je briefing wordt {length}.",
    prefSkip: "Oké, ik laat {sections} weg uit je briefing.",
    prefUnskip: "Oké, {sections} staat weer in je briefing.",
    prefBadSection: "Dat onderdeel ken ik niet. Gebruik de naam, zoals weer of nieuws.",
    prefFull: "Ik kan hooguit {count} onderdelen weglaten.",
    prefUnsaved: "Ik kon die voorkeur niet bewaren. Probeer het zo nog eens.",
    short: "kort",
    normal: "gewoon",
    long: "uitgebreid"
  }
})
