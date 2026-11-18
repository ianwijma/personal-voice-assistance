// Waits `input` ms, and says when it ran (wall clock, comparable across threads).
export default async (input: number): Promise<{ readonly start: number; readonly end: number }> => {
  const start = Date.now()
  await new Promise((resolve) => setTimeout(resolve, input))
  return { start, end: Date.now() }
}
