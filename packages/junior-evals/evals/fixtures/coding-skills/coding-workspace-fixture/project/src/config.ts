export const runtimeConfig = {
  defaultRetryCount: 2,
  emergencyMode: false,
  serviceName: "fixture-worker",
};

export function retryWindowMs(
  retryCount = runtimeConfig.defaultRetryCount,
): number {
  return retryCount * 250;
}
