import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import type { DispatchCallback } from "./types";

const DISPATCH_CALLBACK_PATH = "/api/internal/agent-dispatch";
const DISPATCH_HMAC_CONTEXT = "junior.agent_dispatch.v1";
const DISPATCH_SIGNATURE_VERSION = "v1";
const DISPATCH_MAX_SKEW_MS = 5 * 60 * 1000;
const DISPATCH_CALLBACK_TIMEOUT_MS = 10_000;
const DISPATCH_TIMESTAMP_HEADER = "x-junior-dispatch-timestamp";
const DISPATCH_SIGNATURE_HEADER = "x-junior-dispatch-signature";

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

function parseDispatchCallback(value: unknown): DispatchCallback | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.expectedVersion !== "number"
  ) {
    return undefined;
  }
  return {
    id: record.id,
    expectedVersion: record.expectedVersion,
  };
}

/** Schedule an authenticated internal callback to run a dispatched agent slice. */
export async function scheduleDispatchCallback(
  callback: DispatchCallback,
): Promise<void> {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Cannot determine base URL for agent dispatch callback (set JUNIOR_BASE_URL or deploy to Vercel)",
    );
  }

  const secret = getDispatchSecret();
  if (!secret) {
    throw new Error(
      "Cannot determine agent dispatch secret (set JUNIOR_SECRET)",
    );
  }

  const body = JSON.stringify(callback);
  const timestamp = Date.now().toString();
  const response = await fetch(`${baseUrl}${DISPATCH_CALLBACK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [DISPATCH_TIMESTAMP_HEADER]: timestamp,
      [DISPATCH_SIGNATURE_HEADER]: signBody(secret, timestamp, body),
    },
    signal: AbortSignal.timeout(DISPATCH_CALLBACK_TIMEOUT_MS),
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Agent dispatch callback failed with status ${response.status}`,
    );
  }
}

/** Verify and parse an authenticated agent dispatch callback request. */
export async function verifyDispatchCallbackRequest(
  request: Request,
): Promise<DispatchCallback | undefined> {
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
    return parseDispatchCallback(JSON.parse(body));
  } catch {
    return undefined;
  }
}
