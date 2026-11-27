import { vi } from "vitest";

/**
 * Undo every `vi.stubEnv`, then stub `env`. Tests change `process.env` only
 * through `vi.stubEnv`: assigning a new object to `process.env` breaks the
 * env proxy that Vitest restores, so the change leaks into later files.
 */
export function resetTestEnv(
  env: Record<string, string | undefined> = {},
): void {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}
