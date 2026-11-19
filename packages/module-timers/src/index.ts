import type { ModuleDefinition } from "@pva/core"
import { alarmsModule } from "./alarms.ts"
import { timersModule } from "./timers.ts"

/**
 * Timers and alarms (docs/modules/timers.md, docs/modules/alarms.md): two modules in one package, so an assistant can
 * have one without the other. Both keep household data in their own collection, ring through the notification service
 * with one scheduler job per timer or alarm, and say every sentence in English and Dutch.
 */
export { ALARM_BAND, type Alarm, alarms, alarmsModule, type AlarmsOps, DELIVER_WITHIN_MS, MAX_ALARMS, RETRY_RING_MS as ALARM_RETRY_RING_MS } from "./alarms.ts"
export { RETRY_CLEANUP_MS, RETRY_RING_MS, type Timer, timers, timersModule, type TimersOps } from "./timers.ts"
export { alarmTexts, timerTexts } from "./texts.ts"

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [timersModule, alarmsModule]
