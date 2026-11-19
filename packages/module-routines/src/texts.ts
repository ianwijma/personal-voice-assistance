import { defineTexts } from "@pva/module-contracts"

/**
 * Every sentence the module speaks, failures and refusals included, in both languages with the same placeholders. A
 * refusal names the routine (the owner's own name) and the step by its number in the owner's list; it never repeats
 * what another module answered or what someone said.
 */
export const texts = defineTexts({
  en: {
    noDevice: "I can only run a routine from a device.",
    notHere: "I can't run {name} here.",
    refusedMissing: "I can't run {name}: step {step} is something this assistant can't do here.",
    refusedConfirm: "I can't run {name}: step {step} needs a confirmation I can't ask for yet.",
    refusedUnchecked: "I can't run {name}: whether step {step} is allowed depends on its values, which I can't check before it runs.",
    refusedParams: "I can't run {name}: the values in step {step} don't fit that action.",
    already: "{name} is already running.",
    started: "Starting {name}.",
    unknown: "I don't know a routine by that name.",
    which: "Which one: {list}?",
    or: "or",
    none: "There are no routines yet.",
    doneQuiet: "{name} is done.",
    doneUnconfirmed: "{name} is done, but I couldn't confirm {steps}.",
    stepOne: "step {list}",
    stepsMany: "steps {list}",
    stoppedFailed: "{name} stopped: I couldn't confirm step {step}, so I left out the rest.",
    stoppedRefused: "{name} stopped at step {step}: that isn't allowed here any more, so I left out the rest.",
    withheldAnswer: "I don't read out the answer to step {step} in a routine: it may be personal.",
    cutShort: "{name} was cut short when the routines module restarted; it had finished {done} of its {total} steps.",
    cutShortCall: "{name} was cut short when the routines module restarted, during step {step}, which may or may not have been done."
  },
  nl: {
    noDevice: "Ik kan een routine alleen vanaf een apparaat uitvoeren.",
    notHere: "Ik kan {name} hier niet uitvoeren.",
    refusedMissing: "Ik kan {name} niet uitvoeren: stap {step} kan deze assistent hier niet doen.",
    refusedConfirm: "Ik kan {name} niet uitvoeren: stap {step} vraagt een bevestiging die ik nog niet kan vragen.",
    refusedUnchecked: "Ik kan {name} niet uitvoeren: of stap {step} mag, hangt af van de waarden, en dat kan ik niet vooraf nagaan.",
    refusedParams: "Ik kan {name} niet uitvoeren: de waarden in stap {step} passen niet bij die actie.",
    already: "{name} loopt al.",
    started: "Ik start {name}.",
    unknown: "Ik ken geen routine met die naam.",
    which: "Welke: {list}?",
    or: "of",
    none: "Er zijn nog geen routines.",
    doneQuiet: "{name} is klaar.",
    doneUnconfirmed: "{name} is klaar, maar {steps} kon ik niet bevestigen.",
    stepOne: "stap {list}",
    stepsMany: "stappen {list}",
    stoppedFailed: "{name} is gestopt: stap {step} kon ik niet bevestigen, dus de rest heb ik overgeslagen.",
    stoppedRefused: "{name} is gestopt bij stap {step}: dat mag hier niet meer, dus de rest heb ik overgeslagen.",
    withheldAnswer: "Het antwoord op stap {step} lees ik in een routine niet voor: het kan persoonlijk zijn.",
    cutShort: "{name} is afgebroken doordat de routinemodule opnieuw startte; {done} van de {total} stappen waren klaar.",
    cutShortCall: "{name} is afgebroken doordat de routinemodule opnieuw startte, tijdens stap {step}, die misschien wel en misschien niet is uitgevoerd."
  }
})

export type TextKey = keyof typeof texts.en
