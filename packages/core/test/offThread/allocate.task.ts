// Allocates on the heap until the worker's memory limit ends it.
export default (_input: null): number => {
  const kept: Array<Array<string>> = []
  for (;;) kept.push(Array.from({ length: 10_000 }, (_, i) => `${i}-${kept.length}`))
}
