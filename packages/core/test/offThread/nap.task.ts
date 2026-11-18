// Waits `ms`, and says which call it was and when it ran (epoch ms with sub-millisecond precision, comparable across
// threads).
export default async (input: { readonly ms: number; readonly id: number }): Promise<{ readonly id: number; readonly start: number; readonly end: number }> => {
  const now = () => performance.timeOrigin + performance.now()
  const start = now()
  await new Promise((resolve) => setTimeout(resolve, input.ms))
  return { id: input.id, start, end: now() }
}
