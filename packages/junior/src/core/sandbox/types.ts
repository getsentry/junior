import type {
  ExecOptions,
  ExecResult,
} from "@/core/tool-execution-environment";

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
