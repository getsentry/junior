/**
 * The machine where a tool runs commands and reads and writes files. A Vercel
 * Sandbox, a Docker container, and the local machine each implement it. Tools
 * that do not use commands or files do not get one.
 *
 * It has files and commands together because every implementation has both.
 * Files are methods, not commands, so that binary content and paths do not
 * go through shell quoting.
 */
export type ToolExecutionEnvironment = {
  /** Absolute directory where commands start and relative paths resolve. */
  readonly cwd: string;
  /**
   * Runs `command` through the shell and waits for it to exit. A non-zero
   * exit code is a result, not a throw. A timeout or an abort throws.
   */
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  /**
   * Returns the bytes of a file as a stream, or `undefined` when the file does
   * not exist. A caller that needs only part of the file cancels the stream
   * when it has enough, so a large file is never read in full.
   */
  readFile(
    path: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | undefined>;
  /** Creates or replaces a file, and creates its missing parent directories. */
  writeFile(
    path: string,
    content: string | Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
};

/** Options for one `exec` call. */
export type ExecOptions = {
  signal: AbortSignal;
  /** Directory to start in. Defaults to `cwd`. */
  cwd?: string;
  /** Variables to add to the command's environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
};

/** Output of a command that exited. */
export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
