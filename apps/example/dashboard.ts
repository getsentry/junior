function isVercelEnvironment(): boolean {
  if (process.env.VERCEL_ENV?.trim() === "development") {
    return false;
  }
  return Boolean(
    process.env.VERCEL?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim(),
  );
}

/** Return whether the example dashboard should require browser auth. */
export function exampleDashboardAuthRequired(): boolean {
  const authRequired = process.env.JUNIOR_DASHBOARD_AUTH_REQUIRED?.trim();
  if (authRequired === "true") {
    return true;
  }
  if (authRequired === "false" && !isVercelEnvironment()) {
    return false;
  }

  return process.env.NODE_ENV !== "development" || isVercelEnvironment();
}

/** Return whether the example dashboard should overlay visual-QA fixtures. */
export function exampleDashboardMockConversations(): boolean {
  return process.env.JUNIOR_DASHBOARD_MOCK_CONVERSATIONS === "true";
}
