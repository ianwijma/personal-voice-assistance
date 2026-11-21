import { defineTexts } from "@pva/module-contracts"

/** Every sentence the module speaks, in both languages with the same placeholders. */
export const texts = defineTexts({
  en: {
    kept: "I've kept that report. The owner can read it and send it from the admin panel, under Reports.",
    sent: "I've sent that report. It's issue {number}.",
    sentNoNumber: "I've sent that report.",
    sendFailed: "I've kept that report, but sending it didn't work. The owner can send it from the admin panel, under Reports.",
    unavailable: "Reporting isn't available here.",
    failed: "I couldn't keep that report just now. Please try again in a moment."
  },
  nl: {
    kept: "Ik heb die melding bewaard. De eigenaar kan hem lezen en versturen in het beheerpaneel, onder Reports.",
    sent: "Ik heb die melding verstuurd. Het is issue {number}.",
    sentNoNumber: "Ik heb die melding verstuurd.",
    sendFailed: "Ik heb die melding bewaard, maar versturen lukte niet. De eigenaar kan hem versturen in het beheerpaneel, onder Reports.",
    unavailable: "Meldingen maken kan hier niet.",
    failed: "Ik kon die melding nu niet bewaren. Probeer het zo nog eens."
  }
})
