export const DEFAULT_FUNCTION_MAX_DURATION_SECONDS = 300;

/** Resolve the numeric host duration shared by build and runtime defaults. */
export function resolveConfiguredFunctionMaxDurationSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw =
    env.FUNCTION_MAX_DURATION_SECONDS ??
    env.QUEUE_CALLBACK_MAX_DURATION_SECONDS;
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(value) || value <= 0
    ? DEFAULT_FUNCTION_MAX_DURATION_SECONDS
    : value;
}

/** Keep dispatch ownership beyond the host window used to execute its slice. */
export function dispatchSliceLeaseMs(
  functionMaxDurationSeconds: number,
  bufferSeconds: number,
): number {
  return (functionMaxDurationSeconds + bufferSeconds) * 1000;
}
