import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { CredentialHeaderTransform } from "@/chat/credentials/broker";
import { getStateAdapter } from "@/chat/state/adapter";

export const SANDBOX_EGRESS_PROXY_PATH = "/api/internal/sandbox-egress";

const SANDBOX_EGRESS_TOKEN_VERSION = "v1";
const SANDBOX_EGRESS_LEASE_PREFIX = "sandbox-egress-lease";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

export interface SandboxEgressRequesterContext {
  requesterId: string;
  egressId: string;
  expiresAtMs: number;
  contextId: string;
}

export interface SandboxEgressCredentialLease {
  provider: string;
  expiresAt: string;
  headerTransforms: CredentialHeaderTransform[];
}

function leaseKey(
  provider: string,
  context: SandboxEgressRequesterContext,
): string {
  return `${SANDBOX_EGRESS_LEASE_PREFIX}:${provider}:${context.requesterId}:${context.egressId}:${context.contextId}`;
}

function getSandboxEgressSecret(): string {
  const explicit = process.env.JUNIOR_SANDBOX_EGRESS_SECRET?.trim();
  if (explicit) {
    return explicit;
  }
  const sharedInternal = process.env.JUNIOR_INTERNAL_RESUME_SECRET?.trim();
  if (sharedInternal) {
    return sharedInternal;
  }
  throw new Error(
    "Cannot determine sandbox egress secret (set JUNIOR_SANDBOX_EGRESS_SECRET or JUNIOR_INTERNAL_RESUME_SECRET)",
  );
}

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signPayload(payload: string): string {
  return createHmac("sha256", getSandboxEgressSecret())
    .update(payload)
    .digest("base64url");
}

function timingSafeMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function parseRequesterContext(
  value: unknown,
): SandboxEgressRequesterContext | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<SandboxEgressRequesterContext>;
  if (
    typeof record.requesterId !== "string" ||
    !record.requesterId ||
    typeof record.egressId !== "string" ||
    !record.egressId ||
    typeof record.expiresAtMs !== "number" ||
    !Number.isFinite(record.expiresAtMs) ||
    typeof record.contextId !== "string" ||
    !record.contextId
  ) {
    return undefined;
  }
  if (record.expiresAtMs <= Date.now()) {
    return undefined;
  }
  return {
    requesterId: record.requesterId,
    egressId: record.egressId,
    expiresAtMs: record.expiresAtMs,
    contextId: record.contextId,
  };
}

function parseLease(value: unknown): SandboxEgressCredentialLease | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<SandboxEgressCredentialLease>;
  if (
    typeof record.provider !== "string" ||
    typeof record.expiresAt !== "string" ||
    !Array.isArray(record.headerTransforms)
  ) {
    return undefined;
  }
  const expiresAtMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return undefined;
  }
  const headerTransforms = record.headerTransforms.filter(
    (transform): transform is CredentialHeaderTransform =>
      Boolean(
        transform &&
        typeof transform.domain === "string" &&
        transform.headers &&
        typeof transform.headers === "object",
      ),
  );
  if (headerTransforms.length === 0) {
    return undefined;
  }
  return {
    provider: record.provider,
    expiresAt: record.expiresAt,
    headerTransforms,
  };
}

/** Create a signed requester/sandbox context token for lazy sandbox egress auth. */
export function createSandboxEgressRequesterToken(input: {
  requesterId: string;
  egressId: string;
  ttlMs?: number;
}): string {
  const ttlMs = Math.max(1, input.ttlMs ?? DEFAULT_SESSION_TTL_MS);
  const now = Date.now();
  const context: SandboxEgressRequesterContext = {
    requesterId: input.requesterId,
    egressId: input.egressId,
    expiresAtMs: now + ttlMs,
    contextId: randomUUID(),
  };
  const payload = `${SANDBOX_EGRESS_TOKEN_VERSION}.${base64Url(
    JSON.stringify(context),
  )}`;
  return `${payload}.${signPayload(payload)}`;
}

/** Verify a signed requester/sandbox context token from the proxy URL. */
export function parseSandboxEgressRequesterToken(
  token: string | undefined,
): SandboxEgressRequesterContext | undefined {
  if (!token) {
    return undefined;
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SANDBOX_EGRESS_TOKEN_VERSION) {
    return undefined;
  }
  const encodedSession = parts[1];
  const signature = parts[2];
  if (!encodedSession || !signature) {
    return undefined;
  }
  const payload = `${parts[0]}.${encodedSession}`;
  if (!timingSafeMatch(signPayload(payload), signature)) {
    return undefined;
  }
  try {
    return parseRequesterContext(JSON.parse(fromBase64Url(encodedSession)));
  } catch {
    return undefined;
  }
}

/** Cache a short-lived credential lease for repeated forwarded requests for one requester/sandbox context. */
export async function setSandboxEgressCredentialLease(
  context: SandboxEgressRequesterContext,
  lease: SandboxEgressCredentialLease,
): Promise<void> {
  const leaseExpiresAtMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= Date.now()) {
    return;
  }
  const ttlMs = Math.max(
    1,
    Math.min(leaseExpiresAtMs, context.expiresAtMs) - Date.now(),
  );
  const state = getStateAdapter();
  await state.connect();
  await state.set(leaseKey(lease.provider, context), lease, ttlMs);
}

/** Load a cached egress credential lease for a requester/sandbox context/provider pair. */
export async function getSandboxEgressCredentialLease(
  provider: string,
  context: SandboxEgressRequesterContext,
): Promise<SandboxEgressCredentialLease | undefined> {
  const state = getStateAdapter();
  await state.connect();
  return parseLease(await state.get(leaseKey(provider, context)));
}

/** Clear a cached egress credential lease after the provider rejects its headers. */
export async function clearSandboxEgressCredentialLease(
  provider: string,
  context: SandboxEgressRequesterContext,
): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  await state.delete(leaseKey(provider, context));
}
