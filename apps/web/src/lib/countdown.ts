/**
 * P10: a timer's countdown on the page (docs/PRESENTING.md "The voice page"). The server gives the instant it ends on
 * its own clock (`endsAt`) and its clock when it sent the message (`serverNow`); the page keeps the difference between
 * that and its own clock when the message arrived (`clockOffset`), so a page whose clock is off by minutes still counts
 * down to the server's instant.
 */

/** Milliseconds left now, on the server's clock as this page estimates it (never below 0). */
export const remainingMs = (endsAt: number, clockOffset: number, pageNow: number): number => Math.max(0, endsAt - (pageNow + clockOffset))

/** "4:05", "1:02:03"; whole seconds rounded up, so it reads 0:00 only when it is over. */
export const formatRemaining = (ms: number): string => {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const two = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}
