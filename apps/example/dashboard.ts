function isVercelEnvironment(): boolean {
  return Boolean(
    process.env.VERCEL?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim(),
  );
}

/** Return whether the example dashboard should require browser auth. */
export function exampleDashboardAuthRequired(): boolean {
  return process.env.NODE_ENV !== "development" || isVercelEnvironment();
}
