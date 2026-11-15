/**
 * Parent side of one engine instance: a child process running `engine-host.mjs`.
 *
 * Why a process and not a worker thread: Piper needs sherpa-onnx-node 1.13.8 and
 * Kokoro needs 2.x, two copies of the same native library (and the STT adapter
 * loads 2.x in a worker of the main process). Separate processes never share a
 * native address space, a native crash only kills the child, and a stuck
 * synthesis can be killed safely (terminating a worker mid-synthesis crashed
 * the whole process in the spike).
 *
 * Scheduling: the child gets one clause at a time; the queue lives here. So a
 * cancelled job that is still queued costs nothing, and a new turn waits behind
 * at most the one clause already in flight (whose audio is then discarded).
 */
import { type ChildProcess, fork } from "node:child_process"

export interface EngineInit {
  readonly type: "init"
  /** Module the host `require`s: "sherpa-onnx-node-v1" or "sherpa-onnx-node". Anything for a stand-in host. */
  readonly module: string
  readonly config: unknown
  readonly speaker: number
  readonly speed: number
}

export interface EngineOptions {
  /** Path of the host script (the real one, or a stand-in in tests). */
  readonly hostScript: string
  readonly init: EngineInit
  /** Model load limit. Default 60 s. */
  readonly startTimeoutMs?: number
  /** Synthesis limit for one clause; the child is killed and restarted after it. Default 5 s + 40 ms per character. */
  readonly jobTimeoutMs?: (text: string) => number
}

export interface Job {
  readonly text: string
  /** Another speaker of the loaded model for this clause (a preview of another Kokoro voice). Default: init's. */
  readonly speaker?: number
  /** Called once with the clause's samples, unless the job was cancelled. */
  readonly onAudio: (samples: Float32Array) => void
  /** Called once if the clause could not be synthesised (engine failure, crash, timeout, shutdown). */
  readonly onError: (message: string) => void
}

interface HostMessage {
  readonly type: "ready" | "error" | "audio" | "failed"
  readonly id?: number
  readonly sampleRate?: number
  readonly samples?: Float32Array
  readonly message?: string
}

const defaultJobTimeout = (text: string) => 5000 + 40 * text.length

export class Engine {
  sampleRate = 0
  private child: ChildProcess | undefined
  private starting: Promise<number> | undefined
  private queue: Array<Job> = []
  private current: { readonly job: Job; readonly id: number; cancelled: boolean; timer: NodeJS.Timeout } | undefined
  private nextId = 0
  private closed = false
  private stderr = ""

  private readonly options: EngineOptions

  constructor(options: EngineOptions) {
    this.options = options
  }

  /** Starts the child and loads the model; resolves with the sample rate. Cleans up after itself on failure. */
  start(): Promise<number> {
    if (this.starting !== undefined) return this.starting
    const starting = new Promise<number>((resolve, reject) => {
      this.stderr = ""
      const child = fork(this.options.hostScript, [], {
        execArgv: [], // never inherit tsx/vitest loaders: the host is plain JavaScript
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      })
      this.child = child
      child.stderr?.on("data", (data: Buffer) => {
        this.stderr = (this.stderr + data.toString()).slice(-2000)
      })
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error(`model load timed out after ${this.options.startTimeoutMs ?? 60_000} ms`))
      }, this.options.startTimeoutMs ?? 60_000)
      const done = () => {
        clearTimeout(timer)
        child.off("message", onStartup)
        child.off("exit", onStartupExit)
      }
      const onStartup = (msg: HostMessage) => {
        if (msg.type === "ready") {
          done()
          this.stderr = "" // drop the model-load log; keep only what a crash prints
          this.sampleRate = msg.sampleRate ?? 0
          child.on("message", (m: HostMessage) => this.onMessage(child, m))
          child.on("exit", (code, signal) => this.onExit(child, code, signal))
          resolve(this.sampleRate)
          this.pump()
        } else if (msg.type === "error") {
          done()
          child.kill("SIGKILL")
          reject(new Error(msg.message ?? "engine failed to load"))
        }
      }
      const onStartupExit = (code: number | null, signal: NodeJS.Signals | null) => {
        done()
        reject(new Error(`engine process exited while loading (${this.describeExit(code, signal)})`))
      }
      child.on("message", onStartup)
      child.on("exit", onStartupExit)
      child.on("error", () => {}) // spawn/IPC errors surface as `exit`
      child.send(this.options.init)
    })
    this.starting = starting
    starting.catch((error: Error) => {
      if (this.starting === starting) this.starting = undefined
      if (this.child !== undefined && this.child.exitCode === null) this.child.kill("SIGKILL")
      this.child = undefined
      this.failAll(`engine failed to start: ${error.message}`)
    })
    return starting
  }

  submit(job: Job): void {
    if (this.closed) return job.onError("engine is shut down")
    this.queue.push(job)
    if (this.starting === undefined) void this.start().catch(() => {}) // a restart failed earlier: try again
    else this.pump()
  }

  /** Drops a queued job, or discards the audio of the one in flight. Never blocks. */
  cancel(job: Job): void {
    if (this.current?.job === job) this.current.cancelled = true
    else this.queue = this.queue.filter((j) => j !== job)
  }

  /** Asks the child to exit, then kills it if it does not within `graceMs`. */
  close(graceMs = 1000): Promise<void> {
    this.closed = true
    this.failAll("engine is shut down")
    const child = this.child
    this.child = undefined
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), graceMs)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      if (child.connected) child.send({ type: "exit" })
      else child.kill("SIGKILL")
    })
  }

  /** Pid of the running child, for measurements. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  private ready(): boolean {
    return this.child !== undefined && this.sampleRate > 0 && this.child.connected
  }

  private pump(): void {
    if (this.current !== undefined || !this.ready()) return
    const job = this.queue.shift()
    if (job === undefined) return
    const id = ++this.nextId
    const child = this.child!
    const timeoutMs = (this.options.jobTimeoutMs ?? defaultJobTimeout)(job.text)
    const timer = setTimeout(() => {
      this.stderr += `\nsynthesis took longer than ${timeoutMs} ms`
      child.kill("SIGKILL") // handled by onExit like any crash
    }, timeoutMs)
    this.current = { job, id, cancelled: false, timer }
    child.send({ type: "speak", id, text: job.text, ...(job.speaker !== undefined ? { sid: job.speaker } : {}) })
  }

  private onMessage(child: ChildProcess, msg: HostMessage): void {
    const current = this.current
    if (child !== this.child || current === undefined || msg.id !== current.id) return
    clearTimeout(current.timer)
    this.current = undefined
    if (!current.cancelled) {
      if (msg.type === "audio" && msg.samples !== undefined) current.job.onAudio(msg.samples)
      else current.job.onError(`synthesis failed: ${msg.message ?? "unknown error"}`)
    }
    this.pump()
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return
    this.child = undefined
    this.starting = undefined
    this.sampleRate = 0
    if (this.closed) return
    // A crash fails everything submitted so far (it belongs to the running turn(s)),
    // and a fresh process starts loading at once so the next turn does not pay for it.
    this.failAll(`engine process died (${this.describeExit(code, signal)})`)
    void this.start().catch(() => {})
  }

  private failAll(message: string): void {
    // Take everything first: callbacks may re-enter (a failed turn's caller can start the next turn synchronously).
    const current = this.current
    const queue = this.queue
    this.current = undefined
    this.queue = []
    if (current !== undefined) {
      clearTimeout(current.timer)
      if (!current.cancelled) current.job.onError(message)
    }
    for (const job of queue) job.onError(message)
  }

  private describeExit(code: number | null, signal: NodeJS.Signals | null): string {
    const how = signal !== null ? `signal ${signal}` : `exit code ${code}`
    const tail = this.stderr.trim().split("\n").slice(-3).join(" | ")
    return tail.length > 0 ? `${how}: ${tail}` : how
  }
}
