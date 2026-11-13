// §6.3 step 3, confirm mode: the echo gate waits for two recognised words that are not the reply's own (~0.6 s in).
import { bargeIn } from "./bargein.ts"

bargeIn("confirm", 700, 8793)
