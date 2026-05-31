/**
 * Timeout resume callback signing.
 *
 * This module owns the internal HTTP handoff used when a turn times out but has
 * a safe Pi continuation boundary. It emits and verifies a small signed request
 * so only current deployment code can resume the parked turn.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";

const TURN_TIMEOUT_RESUME_PATH = "/api/internal/turn-resume";
const TURN_TIMEOUT_RESUME_HMAC_CONTEXT = "junior.turn_timeout_resume.v1";
const TURN_TIMEOUT_RESUME_SIGNATURE_VERSION = "v1";
const TURN_TIMEOUT_RESUME_MAX_SKEW_MS = 5 * 60 * 1000;
const TURN_TIMEOUT_RESUME_TIMESTAMP_HEADER = "x-junior-resume-timestamp";
const TURN_TIMEOUT_RESUME_SIGNATURE_HEADER = "x-junior-resume-signature";
const MAX_TURN_TIMEOUT_RESUME_SLICE_ID = 5;

export interface TurnContinuationRequest {
  conversationId: string;
  expectedVersion: number;
  sessionId: string;
}

/** Bound automatic timeout continuation so one bad turn cannot loop forever. */
export function canScheduleTurnTimeoutResume(
  nextSliceId: number | undefined,
): boolean {
  return (
    typeof nextSliceId === "number" &&
    nextSliceId > 1 &&
    nextSliceId <= MAX_TURN_TIMEOUT_RESUME_SLICE_ID
  );
}

/** Build the callback request for an awaiting automatic turn continuation. */
export async function getAwaitingTurnContinuationRequest(args: {
  conversationId: string;
  sessionId: string;
}): Promise<TurnContinuationRequest | undefined> {
  const sessionRecord = await getAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
  if (
    !sessionRecord ||
    sessionRecord.state !== "awaiting_resume" ||
    sessionRecord.resumeReason !== "timeout" ||
    !canScheduleTurnTimeoutResume(sessionRecord.sliceId)
  ) {
    return undefined;
  }

  return {
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    expectedVersion: sessionRecord.version,
  };
}

function getTurnTimeoutResumeSecret(): string | undefined {
  return process.env.JUNIOR_SECRET?.trim() || undefined;
}

function buildSignedPayload(timestamp: string, body: string): string {
  return `${TURN_TIMEOUT_RESUME_HMAC_CONTEXT}:${timestamp}:${body}`;
}

function signTurnTimeoutResumeBody(
  secret: string,
  timestamp: string,
  body: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(buildSignedPayload(timestamp, body))
    .digest("hex");
  return `${TURN_TIMEOUT_RESUME_SIGNATURE_VERSION}=${digest}`;
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
 * Parse the signed resume body, accepting the prior wire field for callbacks
 * that were already in flight during deployment rollover.
 */
function parseTurnTimeoutResumeRequest(
  value: unknown,
): TurnContinuationRequest | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const expectedVersion =
    typeof record.expectedVersion === "number"
      ? record.expectedVersion
      : record.expectedCheckpointVersion;
  if (
    typeof record.conversationId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof expectedVersion !== "number"
  ) {
    return undefined;
  }

  return {
    conversationId: record.conversationId,
    sessionId: record.sessionId,
    expectedVersion,
  };
}

/** Schedule an authenticated internal callback to resume a timed-out turn. */
export async function scheduleTurnTimeoutResume(
  request: TurnContinuationRequest,
): Promise<void> {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Cannot determine base URL for timeout resume callback (set JUNIOR_BASE_URL or deploy to Vercel)",
    );
  }

  const secret = getTurnTimeoutResumeSecret();
  if (!secret) {
    throw new Error(
      "Cannot determine timeout resume secret (set JUNIOR_SECRET)",
    );
  }

  const body = JSON.stringify(request);
  const timestamp = Date.now().toString();
  const response = await fetch(`${baseUrl}${TURN_TIMEOUT_RESUME_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TURN_TIMEOUT_RESUME_TIMESTAMP_HEADER]: timestamp,
      [TURN_TIMEOUT_RESUME_SIGNATURE_HEADER]: signTurnTimeoutResumeBody(
        secret,
        timestamp,
        body,
      ),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Timeout resume callback failed with status ${response.status}`,
    );
  }
}

/** Verify and parse an authenticated timeout resume callback request. */
export async function verifyTurnTimeoutResumeRequest(
  request: Request,
): Promise<TurnContinuationRequest | undefined> {
  const timestamp =
    request.headers.get(TURN_TIMEOUT_RESUME_TIMESTAMP_HEADER)?.trim() ?? "";
  const signature =
    request.headers.get(TURN_TIMEOUT_RESUME_SIGNATURE_HEADER)?.trim() ?? "";
  const secret = getTurnTimeoutResumeSecret();
  if (!timestamp || !signature || !secret) {
    return undefined;
  }

  const parsedTimestamp = Number.parseInt(timestamp, 10);
  if (
    !Number.isFinite(parsedTimestamp) ||
    Math.abs(Date.now() - parsedTimestamp) > TURN_TIMEOUT_RESUME_MAX_SKEW_MS
  ) {
    return undefined;
  }

  const body = await request.text();
  const expectedSignature = signTurnTimeoutResumeBody(secret, timestamp, body);
  if (!timingSafeMatch(expectedSignature, signature)) {
    return undefined;
  }

  try {
    return parseTurnTimeoutResumeRequest(JSON.parse(body));
  } catch {
    return undefined;
  }
}
