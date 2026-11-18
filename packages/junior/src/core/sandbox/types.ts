import type { ToolExecutionEnvironment } from "@/core/tool-execution-environment";

/**
 * Starts sandboxes and finds them again. Vercel Sandbox and Docker each
 * implement it. A sandbox lives longer than one step, so a step keeps only
 * the sandbox id and calls `resume` to get an environment for it.
 *
 * An environment from a provider never starts its sandbox again on its own:
 * when the sandbox stops, every call throws `SandboxUnavailableError`, and the
 * caller calls `resume` to get a new one.
 */
export type SandboxProvider = {
  create(
    input: CreateSandboxInput,
    signal: AbortSignal,
  ): Promise<ToolExecutionEnvironment>;
  /**
   * Returns an environment for the sandbox with this id, and starts it again
   * when it stopped. Returns `undefined` when the sandbox no longer exists, so
   * the caller creates a new one.
   */
  resume(
    id: string,
    signal: AbortSignal,
  ): Promise<ToolExecutionEnvironment | undefined>;
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

/** The sandbox behind an environment stopped. Call `resume`. */
export class SandboxUnavailableError extends Error {
  constructor(sandboxId: string, options?: ErrorOptions) {
    super(`Sandbox ${sandboxId} is no longer running`, options);
    this.name = "SandboxUnavailableError";
  }
}
