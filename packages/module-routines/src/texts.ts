import { defineTexts } from "@pva/module-contracts"

/**
 * Every sentence the module speaks, failures and refusals included, in both languages with the same placeholders. A
 * refusal names the routine (the owner's own name) and the step by its number in the owner's list; it never repeats
 * what another module answered or what someone said. `{why}`, `{before}` and `{steps}` are filled with texts of this
 * table in the same language.
 */
export const texts = defineTexts({
  en: {
    noDevice: "I can only run a routine from a device.",
    notHere: "I can't run {name} here.",
    refusedMissing: "I can't run {name}: step {step} is something this assistant can't do here.",
    refusedConfirm: "I can't run {name}: step {step} needs a confirmation I can't ask for yet.",
    refusedParams: "I can't run {name}: the values in step {step} don't fit that action.",
    already: "{name} is already running.",
    busyHere: "{other} is still running here.",
    started: "Starting {name}.",
    unknown: "I don't know a routine by that name.",
    which: "Which one: {list}?",
    whichMore: "Which one: {list}, or {count} more? Please give a more specific name.",
    or: "or",
    none: "There are no routines yet.",
    doneQuiet: "{name} is done.",
    doneUnconfirmed: "{name} is done, but I couldn't confirm {steps}.",
    stepOne: "step {list}",
    stepsMany: "steps {list}",
    stoppedAt: "{name} stopped at step {step}: {why}. {before}",
    whyRefused: "I'm not allowed to do that",
    whyValues: "its values don't fit that action",
    stoppedFailed: "{name} stopped: I couldn't confirm step {step}, so I left out the rest. {before}",
    beforeNone: "Nothing before it was done.",
    beforeOne: "Step {list} is done.",
    beforeMany: "Steps {list} are done.",
    alsoUnconfirmed: "I couldn't confirm {steps}.",
    cutShort: "{name} was cut short when the routines module stopped; it had finished {done} of its {total} steps.",
    cutShortCall: "{name} was cut short when the routines module stopped, during step {step}, which may or may not have been done.",
    nothingRunning: "No routine is running here.",
    cancelled: "I stopped {name}; it had finished {done} of its {total} steps.",
    cancelledCall: "I stopped {name} during step {step}; that step may still complete.",
    noLine: "That line belongs to no routine running here."
  },
  nl: {
    noDevice: "Ik kan een routine alleen vanaf een apparaat uitvoeren.",
    notHere: "Ik kan {name} hier niet uitvoeren.",
    refusedMissing: "Ik kan {name} niet uitvoeren: stap {step} kan deze assistent hier niet doen.",
    refusedConfirm: "Ik kan {name} niet uitvoeren: stap {step} vraagt een bevestiging die ik nog niet kan vragen.",
    refusedParams: "Ik kan {name} niet uitvoeren: de waarden in stap {step} passen niet bij die actie.",
    already: "{name} loopt al.",
    busyHere: "{other} loopt hier nog.",
    started: "Ik start {name}.",
    unknown: "Ik ken geen routine met die naam.",
    which: "Welke: {list}?",
    whichMore: "Welke: {list}, of nog {count}? Noem een specifiekere naam.",
    or: "of",
    none: "Er zijn nog geen routines.",
    doneQuiet: "{name} is klaar.",
    doneUnconfirmed: "{name} is klaar, maar {steps} kon ik niet bevestigen.",
    stepOne: "stap {list}",
    stepsMany: "stappen {list}",
    stoppedAt: "{name} is gestopt bij stap {step}: {why}. {before}",
    whyRefused: "dat mag ik niet doen",
    whyValues: "de waarden passen niet bij die actie",
    stoppedFailed: "{name} is gestopt: stap {step} kon ik niet bevestigen, dus de rest heb ik overgeslagen. {before}",
    beforeNone: "Daarvoor is niets gedaan.",
    beforeOne: "Stap {list} is gedaan.",
    beforeMany: "Stappen {list} zijn gedaan.",
    alsoUnconfirmed: "Niet bevestigd: {steps}.",
    cutShort: "{name} is afgebroken doordat de routinemodule stopte; {done} van de {total} stappen waren klaar.",
    cutShortCall: "{name} is afgebroken doordat de routinemodule stopte, tijdens stap {step}, die misschien wel en misschien niet is uitgevoerd.",
    nothingRunning: "Hier loopt geen routine.",
    cancelled: "Ik heb {name} gestopt; {done} van de {total} stappen waren klaar.",
    cancelledCall: "Ik heb {name} gestopt tijdens stap {step}; die stap kan nog worden afgemaakt.",
    noLine: "Die zin hoort bij geen routine die hier loopt."
  }
})

export type TextKey = keyof typeof texts.en
