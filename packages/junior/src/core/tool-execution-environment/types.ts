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
    content: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
};

/** Options for one `exec` call. */
export type ExecOptions = {
  signal: AbortSignal;
  /** Directory to start in. Defaults to `cwd`. */
  cwd?: string;
  /**
   * Variables to add to the command's environment. Never put credentials or
   * other secrets here: every process in the environment, including code the
   * model writes, can read them, and they can end up in output and traces.
   * Credentialed requests go through the host egress proxy instead.
   */
  env?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Gets each chunk of output when it arrives, in arrival order across stdout
   * and stderr. The environment does not keep the output, so the caller keeps
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
