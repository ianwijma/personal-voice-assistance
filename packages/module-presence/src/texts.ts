import { defineTexts } from "@pva/module-contracts"

/** Every sentence the module speaks itself, in both languages with the same placeholders. */
export const texts = defineTexts({
  en: {
    home: "{name} is home.",
    away: "{name} is out.",
    unknown: "I don't know where {name} is.",
    withheld: "Where {count} other people are is not said here.",
    stale: "I lost the connection to Home Assistant, so this is what I heard last.",
    moreHidden: "and {count} more",
    denied: "I don't say where people are from this device.",
    which: "Which one: {names}?",
    unknownPerson: "I don't know anyone called {name}.",
    notTracked: "I don't follow where {name} is. The owner can link {name} to a Home Assistant person in the module's settings.",
    notSet: "I don't know who is home yet: no one is linked to a Home Assistant person in the module's settings.",
    nobodyFound: "None of the linked people is known to Home Assistant right now.",
    noState: "I haven't heard from Home Assistant yet, so I don't know who is home.",
    noMembers: "There is nobody in the household's list of people yet.",
    membersLine: "The household: {names}.",
    unreadable: "I couldn't read who is home."
  },
  nl: {
    home: "{name} is thuis.",
    away: "{name} is weg.",
    unknown: "Ik weet niet waar {name} is.",
    withheld: "Waar {count} andere mensen zijn zeg ik hier niet.",
    stale: "Ik ben de verbinding met Home Assistant kwijt, dit is wat ik het laatst hoorde.",
    moreHidden: "en nog {count}",
    denied: "Via dit apparaat zeg ik niet waar mensen zijn.",
    which: "Welke bedoel je: {names}?",
    unknownPerson: "Ik ken niemand die {name} heet.",
    notTracked: "Ik volg niet waar {name} is. De eigenaar kan {name} in de instellingen van de module aan een Home Assistant-persoon koppelen.",
    notSet: "Ik weet nog niet wie er thuis is: niemand is in de instellingen van de module aan een Home Assistant-persoon gekoppeld.",
    nobodyFound: "Geen van de gekoppelde mensen is nu bekend bij Home Assistant.",
    noState: "Ik heb nog niets van Home Assistant gehoord, dus ik weet niet wie er thuis is.",
    noMembers: "Er staat nog niemand in de lijst met huisgenoten.",
    membersLine: "Het huishouden: {names}.",
    unreadable: "Ik kon niet lezen wie er thuis is."
  }
})
