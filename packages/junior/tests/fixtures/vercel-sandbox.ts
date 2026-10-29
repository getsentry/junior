/**
 * Return whether a live test can reach the real Vercel Sandbox API.
 *
 * Live Vercel Sandbox tests skip when this returns false.
 */
export function vercelSandboxCredentialsReady(): boolean {
  if (process.env.VERCEL_OIDC_TOKEN?.trim()) return true;
  return Boolean(
    process.env.VERCEL_TOKEN?.trim() &&
    process.env.VERCEL_TEAM_ID?.trim() &&
    process.env.VERCEL_PROJECT_ID?.trim(),
  );
}
