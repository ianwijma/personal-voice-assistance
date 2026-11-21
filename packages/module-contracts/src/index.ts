/**
 * `@pva/module-contracts`: the service and contribution keys modules share (docs/MODULES-PLAN.md §5.2), each with its
 * interface, and the two authoring helpers every module uses (spoken texts in two languages, stored text). Keys the
 * core provides (`People`, `Privacy`, `Devices`, later `SessionControl`, `DeviceControl`) are in `@pva/core`. A
 * consumer's tests give it a stub of a contract (`stubService` in `@pva/core/testing`), never an imitation of the
 * provider. docs/MODULES.md, "Services and contributions between modules", says how to use them.
 */
export * from "./briefing.ts"
export * from "./common.ts"
export * from "./homeAssistant.ts"
export * from "./lists.ts"
export * from "./playback.ts"
export * from "./texts.ts"
export * from "./timers.ts"
export * from "./webImages.ts"
export * from "./webVideos.ts"
