// Throws an error whose message quotes its input (as a parser's might).
export default (input: string): string => {
  throw new SyntaxError(`unexpected token in ${input}`)
}
