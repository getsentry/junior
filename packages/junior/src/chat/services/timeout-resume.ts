/**
 * Timeout resume continuation scheduling.
 *
 * This module owns the durable queue handoff used when a turn times out but has
 * a safe Pi continuation boundary. The signed request verifier remains for
 * callbacks that were already in flight during a deployment rollover.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { parseDestination } from "@/chat/destination";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  markConversationWorkEnqueued,
  requestConversationWork,
} from "@/chat/task-execution/store";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

const TURN_TIMEOUT_RESUME_HMAC_CONTEXT = "junior.turn_timeout_resume.v1";
const TURN_TIMEOUT_RESUME_SIGNATURE_VERSION = "v1";
const TURN_TIMEOUT_RESUME_MAX_SKEW_MS = 5 * 60 * 1000;
const TURN_TIMEOUT_RESUME_TIMESTAMP_HEADER = "x-junior-resume-timestamp";
const TURN_TIMEOUT_RESUME_SIGNATURE_HEADER = "x-junior-resume-signature";

export interface TurnContinuationRequest {
  conversationId: string;
  destination: Destination;
  expectedVersion: number;
  sessionId: string;
}

export interface ScheduleTurnTimeoutResumeOptions {
  nowMs?: number;
  queue?: ConversationWorkQueue;
  state?: StateAdapter;
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
    (sessionRecord.resumeReason !== "timeout" &&
      sessionRecord.resumeReason !== "yield") ||
    (sessionRecord.resumeReason === "timeout" && sessionRecord.sliceId < 2)
  ) {
    return undefined;
  }
  if (!sessionRecord.destination) {
    return undefined;
  }

  return {
    conversationId: args.conversationId,
    destination: sessionRecord.destination,
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
 * Parse the signed resume body used by the durable conversation queue.
 */
function parseTurnTimeoutResumeRequest(
  value: unknown,
): TurnContinuationRequest | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const destination = parseDestination(record.destination);
  let expectedVersion = record.expectedVersion;
  if (typeof expectedVersion !== "number") {
    // Accept callbacks signed before the queue-resume destination cutover.
    expectedVersion = record.expectedCheckpointVersion;
  }
  if (
    typeof record.conversationId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof expectedVersion !== "number" ||
    !destination
  ) {
    return undefined;
  }

  return {
    conversationId: record.conversationId,
    destination,
    sessionId: record.sessionId,
    expectedVersion,
  };
}

/** Schedule durable conversation work to resume a timed-out turn. */
export async function scheduleTurnTimeoutResume(
  request: TurnContinuationRequest,
  options: ScheduleTurnTimeoutResumeOptions = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  await requestConversationWork({
    conversationId: request.conversationId,
    destination: request.destination,
    nowMs,
    state: options.state,
  });
  const queue = options.queue ?? getVercelConversationWorkQueue();
  await queue.send(
    {
      conversationId: request.conversationId,
      destination: request.destination,
    },
    {
      idempotencyKey: [
        "timeout",
        request.conversationId,
        request.sessionId,
        request.expectedVersion,
      ].join(":"),
    },
  );
  await markConversationWorkEnqueued({
    conversationId: request.conversationId,
    nowMs,
    state: options.state,
  });
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
