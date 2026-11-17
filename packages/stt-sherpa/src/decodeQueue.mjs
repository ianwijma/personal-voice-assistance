// Whole-turn decodes, one at a time, with the audio waiting for them bounded (recognizerCore.mjs).
// Plain JavaScript, pure: the decode itself is the job's `run`.
//
// - Jobs run in order, one at a time (the recogniser holds one model; decodes would only compete for its threads).
// - Before a job starts it is asked whether it is still wanted (`stale()`); a stale job never reaches the native
//   decoder: its `skip()` runs instead (so a waiting caller still gets an answer).
// - The audio of queued jobs (not the running one) is bounded: `add` refuses a job that would take it past
//   `maxQueuedSamples`, and the caller decides what to drop. A decode that never returns therefore holds its own
//   audio and at most `maxQueuedSamples` more, however long the speech goes on. The bound is per session (each
//   voice session's queued audio on its own), so one session's backlog never refuses another's decode.

export class DecodeQueue {
  /**
   * @param {{ maxQueuedSamples: number, onError: (session: number, error: unknown) => void }} options
   */
  constructor(options) {
    this.maxQueuedSamples = options.maxQueuedSamples
    this.onError = options.onError
    /** @type {Array<any>} */
    this.jobs = []
    this.queuedSamples = 0
    /** Queued audio per session. @type {Map<number, number>} */
    this.bySession = new Map()
    this.running = false
    /** @type {Array<() => void>} */
    this.waiters = []
  }

  /** Jobs queued or running. */
  get pending() {
    return this.jobs.length + (this.running ? 1 : 0)
  }

  /** Audio waiting (not the running job), in ms at `rate`. */
  queuedMs(rate) {
    return (this.queuedSamples / rate) * 1000
  }

  /**
   * @param {{ samples: number, stale: () => boolean, run: () => Promise<void>, skip: () => void, session: number }} job
   * @returns {boolean} false (and nothing queued) if its audio would exceed the bound
   */
  add(job) {
    const mine = this.bySession.get(job.session) ?? 0
    if (mine + job.samples > this.maxQueuedSamples) return false
    this.jobs.push(job)
    this.count(job, 1)
    if (!this.running) void this.drain()
    return true
  }

  /**
   * Removes the queued jobs matching `predicate` without running or skipping them: the caller answers for them
   * (it gets them back), so a job someone waits for is never lost silently.
   * @returns {{ count: number, ms: number, jobs: Array<any> }}
   */
  dropWhere(predicate) {
    let samples = 0
    const kept = []
    const dropped = []
    for (const job of this.jobs) {
      if (predicate(job)) {
        samples += job.samples
        dropped.push(job)
        this.count(job, -1)
      } else kept.push(job)
    }
    this.jobs = kept
    return { count: dropped.length, ms: (samples / 16000) * 1000, jobs: dropped }
  }

  /** Queued audio of one session. */
  queuedFor(session) {
    return this.bySession.get(session) ?? 0
  }

  count(job, sign) {
    this.queuedSamples += sign * job.samples
    const left = (this.bySession.get(job.session) ?? 0) + sign * job.samples
    if (left > 0) this.bySession.set(job.session, left)
    else this.bySession.delete(job.session)
  }

  /** Resolves once nothing is running (queued jobs are not waited for: drop them first). */
  idle() {
    if (!this.running) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  async drain() {
    this.running = true
    while (this.jobs.length > 0) {
      const job = this.jobs.shift()
      this.count(job, -1)
      if (job.stale()) {
        try {
          job.skip()
        } catch (error) {
          this.onError(job.session, error)
        }
        continue
      }
      try {
        await job.run()
      } catch (error) {
        this.onError(job.session, error)
      }
    }
    this.running = false
    for (const resolve of this.waiters.splice(0)) resolve()
  }
}
