import type { CredentialHeaderTransform } from "@/chat/credentials/broker";
import { getStateAdapter } from "@/chat/state/adapter";

const SANDBOX_EGRESS_SESSION_PREFIX = "sandbox-egress-session";
const SANDBOX_EGRESS_LEASE_PREFIX = "sandbox-egress-lease";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

export interface SandboxEgressSession {
  sandboxId: string;
  requesterId: string;
  providers: string[];
  expiresAtMs: number;
}

export interface SandboxEgressCredentialLease {
  provider: string;
  expiresAt: string;
  headerTransforms: CredentialHeaderTransform[];
}

function sessionKey(sandboxId: string): string {
  return `${SANDBOX_EGRESS_SESSION_PREFIX}:${sandboxId}`;
}

function leaseKey(
  sandboxId: string,
  provider: string,
  requesterId: string,
): string {
  return `${SANDBOX_EGRESS_LEASE_PREFIX}:${sandboxId}:${provider}:${requesterId}`;
}

function parseSession(value: unknown): SandboxEgressSession | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<SandboxEgressSession>;
  if (
    typeof record.sandboxId !== "string" ||
    typeof record.requesterId !== "string" ||
    !Array.isArray(record.providers) ||
    typeof record.expiresAtMs !== "number"
  ) {
    return undefined;
  }
  if (record.expiresAtMs <= Date.now()) {
    return undefined;
  }
  return {
    sandboxId: record.sandboxId,
    requesterId: record.requesterId,
    providers: record.providers.filter(
      (provider): provider is string => typeof provider === "string",
    ),
    expiresAtMs: record.expiresAtMs,
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
  if (Date.parse(record.expiresAt) <= Date.now()) {
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

/** Persist the turn-scoped authorization context for sandbox egress credential activation. */
export async function upsertSandboxEgressSession(input: {
  sandboxId: string;
  requesterId: string;
  providers: string[];
  ttlMs?: number;
}): Promise<SandboxEgressSession | undefined> {
  const state = getStateAdapter();
  await state.connect();
  const ttlMs = Math.max(1, input.ttlMs ?? DEFAULT_SESSION_TTL_MS);
  const now = Date.now();
  const providers = [...new Set(input.providers)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (providers.length === 0) {
    await state.delete(sessionKey(input.sandboxId));
    return undefined;
  }
  const session: SandboxEgressSession = {
    sandboxId: input.sandboxId,
    requesterId: input.requesterId,
    providers,
    expiresAtMs: now + ttlMs,
  };
  await state.set(sessionKey(input.sandboxId), session, ttlMs);
  return session;
}

/** Load the active egress authorization session for a sandbox. */
export async function getSandboxEgressSession(
  sandboxId: string,
): Promise<SandboxEgressSession | undefined> {
  const state = getStateAdapter();
  await state.connect();
  return parseSession(await state.get(sessionKey(sandboxId)));
}

/** Cache a short-lived credential lease for repeated proxied requests in one sandbox session. */
export async function setSandboxEgressCredentialLease(
  sandboxId: string,
  requesterId: string,
  lease: SandboxEgressCredentialLease,
  sessionExpiresAtMs: number,
): Promise<void> {
  const leaseExpiresAtMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= Date.now()) {
    return;
  }
  const ttlMs = Math.max(
    1,
    Math.min(leaseExpiresAtMs, sessionExpiresAtMs) - Date.now(),
  );
  const state = getStateAdapter();
  await state.connect();
  await state.set(
    leaseKey(sandboxId, lease.provider, requesterId),
    lease,
    ttlMs,
  );
}

/** Load a cached egress credential lease for a sandbox/provider pair. */
export async function getSandboxEgressCredentialLease(
  sandboxId: string,
  provider: string,
  requesterId: string,
): Promise<SandboxEgressCredentialLease | undefined> {
  const state = getStateAdapter();
  await state.connect();
  return parseLease(
    await state.get(leaseKey(sandboxId, provider, requesterId)),
  );
}
