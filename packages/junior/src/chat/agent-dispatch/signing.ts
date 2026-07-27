import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const DISPATCH_HMAC_CONTEXT = "junior.agent_dispatch.v1";
const DISPATCH_SIGNATURE_VERSION = "v1";
const DISPATCH_MAX_SKEW_MS = 5 * 60 * 1000;
const DISPATCH_TIMESTAMP_HEADER = "x-junior-dispatch-timestamp";
const DISPATCH_SIGNATURE_HEADER = "x-junior-dispatch-signature";

const legacyDispatchCallbackSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    id: z.string().min(1),
  })
  .strict();
type LegacyDispatchCallback = z.infer<typeof legacyDispatchCallbackSchema>;

function getDispatchSecret(): string | undefined {
  return process.env.JUNIOR_SECRET?.trim() || undefined;
}

function buildSignedPayload(timestamp: string, body: string): string {
  return `${DISPATCH_HMAC_CONTEXT}:${timestamp}:${body}`;
}

function signBody(secret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", secret)
    .update(buildSignedPayload(timestamp, body))
    .digest("hex");
  return `${DISPATCH_SIGNATURE_VERSION}=${digest}`;
}

function timingSafeMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Verify callbacks emitted before dispatches moved to conversation work.
 *
 * TODO(v0.116.0): Remove the legacy callback route after v0.114.x callbacks
 * can no longer arrive.
 */
export async function verifyDispatchCallbackRequest(
  request: Request,
): Promise<LegacyDispatchCallback | undefined> {
  const timestamp =
    request.headers.get(DISPATCH_TIMESTAMP_HEADER)?.trim() ?? "";
  const signature =
    request.headers.get(DISPATCH_SIGNATURE_HEADER)?.trim() ?? "";
  const secret = getDispatchSecret();
  if (!timestamp || !signature || !secret) {
    return undefined;
  }

  const parsedTimestamp = Number.parseInt(timestamp, 10);
  if (
    !Number.isFinite(parsedTimestamp) ||
    Math.abs(Date.now() - parsedTimestamp) > DISPATCH_MAX_SKEW_MS
  ) {
    return undefined;
  }

  const body = await request.text();
  const expectedSignature = signBody(secret, timestamp, body);
  if (!timingSafeMatch(expectedSignature, signature)) {
    return undefined;
  }

  try {
    const parsed = legacyDispatchCallbackSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
