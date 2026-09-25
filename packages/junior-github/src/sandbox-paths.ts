/** Sandbox root directories reserved for Junior runtime material. */
export const RESERVED_SANDBOX_DIRECTORIES = new Set([
  ".junior",
  "data",
  "skills",
]);

/** True when a checkout path collides with a reserved sandbox root (case-insensitive). */
export function isReservedSandboxDirectory(path: string): boolean {
  return RESERVED_SANDBOX_DIRECTORIES.has(path.toLowerCase());
}
