import { timingSafeEqual } from "node:crypto";
import { readSchedulerSecret } from "@/chat/secrets";

/** Check the bearer secret that internal cron requests must send. */
export function verifySchedulerRequest(request: Request): boolean {
  const secret = readSchedulerSecret();
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
