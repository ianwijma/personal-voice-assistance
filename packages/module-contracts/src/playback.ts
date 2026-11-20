/**
 * `Playback` is defined in `@pva/core` since P7 (the host's essential "stop" uses it: docs/PHRASES.md) and re-exported
 * here unchanged, so a module imports it from either package and gets the same key (`playback`) and interface. Its
 * contract is documented in `packages/core/src/Playback.ts`.
 */
export { Playback, PLAYBACK_LIMITS, PlaybackError, type PlaybackService } from "@pva/core"
