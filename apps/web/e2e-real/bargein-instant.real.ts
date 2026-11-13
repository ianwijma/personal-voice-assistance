// §6.3 step 3, instant mode: SpeechStarted interrupts ~0.3 s into the new sentence, during the first clause ("You said:").
import { bargeIn } from "./bargein.ts"

bargeIn("instant", 900, 8792)
