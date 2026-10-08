import { timingSafeEqual } from "node:crypto";

function getCronSecret(): string | undefined {
  return (
    process.env.JUNIOR_SCHEDULER_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim()
  );
}

/** Verify the bearer token that Vercel Cron or an external scheduler sends to internal cron routes. */
export function verifyCronRequest(request: Request): boolean {
  const secret = getCronSecret();
  if (!secret) {
    return false;
  }

  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const actual = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
