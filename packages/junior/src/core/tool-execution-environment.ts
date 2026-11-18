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
   * Runs `argv[0]` with the rest of `argv` as its arguments, without a shell,
   * and waits for it to exit. To run a script, pass the shell yourself, for
   * example `["bash", "-c", script]`. A non-zero exit code is a result, not a
   * throw. A timeout or an abort throws.
   */
  exec(argv: readonly string[], options: ExecOptions): Promise<ExecResult>;
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
  /**
   * Gets each chunk of output when it arrives, in arrival order across stdout
   * and stderr. The environment does not keep the output, so the caller keeps
   * only what it needs. The command never waits for this callback.
   */
  onOutput(chunk: OutputChunk): void;
};

/** One piece of a command's output, decoded as UTF-8. */
export type OutputChunk = {
  stream: "stdout" | "stderr";
  text: string;
};

/** How a command exited. The output went to `onOutput`. */
export type ExecResult = {
  exitCode: number;
};
