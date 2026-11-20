// A task that never ends (a parser looping on hostile input): only its time limit stops it.
export default (_input: string): never => {
  for (;;) {
    // spin
  }
}
