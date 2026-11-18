// Takes a large string, answers a slice of it of `keep` characters.
export default (input: { readonly text: string; readonly keep: number }): string => input.text.slice(0, input.keep)
