/**
 * Starts sandboxes and finds them again. A sandbox lives longer than one
 * step, so a step keeps only the sandbox id and calls `resume` to get a
 * handle. Vercel Sandbox and Docker each implement it.
 */
export type SandboxProvider = {
  create(input: CreateSandboxInput, signal: AbortSignal): Promise<Sandbox>;
  /**
   * Returns a handle to the sandbox with this id, and starts it again when it
   * stopped. Returns `undefined` when the sandbox no longer exists, so the
   * caller creates a new one.
   */
  resume(id: string, signal: AbortSignal): Promise<Sandbox | undefined>;
};

/** Input for one new sandbox. */
export type CreateSandboxInput = {
  /**
   * Chosen by the caller, so it can save the id before the sandbox exists
   * and retry the same create.
   */
  id: string;
  /** Time after which the provider stops the sandbox. */
  timeoutMs: number;
  /** Start from this snapshot instead of an empty image. */
  snapshotId?: string;
};

/**
 * A handle to one running sandbox. A handle never starts the sandbox again on
 * its own: when the sandbox stops, every call throws `SandboxUnavailableError`,
 * and the caller calls `resume` to get a new handle.
 */
export type Sandbox = {
  readonly id: string;
  /** Absolute directory where commands start and relative paths resolve. */
  readonly cwd: string;
  /**
   * Runs `argv[0]` with the rest of `argv` as its arguments, without a shell,
   * and waits for it to exit. A non-zero exit code is a result, not a throw.
   * A timeout or an abort throws.
   */
  exec(argv: readonly string[], options: ExecOptions): Promise<ExecResult>;
  /** Returns the bytes of a file as a stream, or `undefined` when it is missing. */
  readFile(
    path: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | undefined>;
  /** Creates or replaces a file, and creates its missing parent directories. */
  writeFile(
    path: string,
    content: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
};

/** The running sandbox behind a handle is gone. Call `resume`. */
export class SandboxUnavailableError extends Error {
  constructor(sandboxId: string, options?: ErrorOptions) {
    super(`Sandbox ${sandboxId} is no longer running`, options);
    this.name = "SandboxUnavailableError";
  }
}

/** Options for one `exec` call. */
export type ExecOptions = {
  signal: AbortSignal;
  /** Directory to start in. Defaults to `cwd`. */
  cwd?: string;
  /**
   * Variables to add to the command's environment. Never put credentials or
   * other secrets here: every process in the sandbox, including code the
   * model writes, can read them, and they can end up in output and traces.
   * Credentialed requests go through the host egress proxy instead.
   */
  env?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Gets each chunk of output when it arrives, in arrival order across stdout
   * and stderr. The sandbox does not keep the output, so the caller keeps
   * only what it needs. The command never waits for this callback.
   */
  onOutputChunk(chunk: OutputChunk): void;
};

/**
 * One piece of a command's output as text. Each stream is decoded as UTF-8 on
 * its own, so a character split across chunks is kept. Vercel Sandbox sends
 * output only as text, so a command whose output is binary writes it to a
 * file, and the caller reads the file.
 */
export type OutputChunk = {
  stream: "stdout" | "stderr";
  text: string;
};

/** How a command exited. The output went to `onOutputChunk`. */
export type ExecResult = {
  exitCode: number;
};
