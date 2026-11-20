/**
 * P10: a timer's countdown on the page (docs/PRESENTING.md "The voice page"). The server gives the instant it ends on
 * its own clock (`endsAt`) and its clock when it sent the message (`serverNow`); the page notes its monotonic clock when
 * the message arrived (`receivedMono`) and counts from there, so neither a page whose wall clock is off nor a jump of
 * that clock afterwards moves the countdown (review round 1, G10). It is taken again at every update.
 */

/** Milliseconds left now, on the server's clock as this page estimates it (never below 0). */
export const remainingMs = (endsAt: number, serverNow: number, receivedMono: number, monoNow: number): number =>
  Math.max(0, endsAt - (serverNow + Math.max(0, monoNow - receivedMono)))

/** "4:05", "1:02:03"; whole seconds rounded up, so it reads 0:00 only when it is over. */
export const formatRemaining = (ms: number): string => {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const two = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}
