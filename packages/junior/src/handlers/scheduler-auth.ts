import { timingSafeEqual } from "node:crypto";

function getSchedulerSecret(): string | undefined {
  return (
    process.env.JUNIOR_SCHEDULER_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim()
  );
}

/** Check the bearer secret that internal cron requests must send. */
export function verifySchedulerRequest(request: Request): boolean {
  const secret = getSchedulerSecret();
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
