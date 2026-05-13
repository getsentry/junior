import type { CredentialHeaderTransform } from "@/chat/credentials/broker";
import { getStateAdapter } from "@/chat/state/adapter";

const SANDBOX_EGRESS_SESSION_PREFIX = "sandbox-egress-session";
const SANDBOX_EGRESS_LEASE_PREFIX = "sandbox-egress-lease";
const SANDBOX_EGRESS_REPLAY_PREFIX = "sandbox-egress-replay";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const REPLAY_WINDOW_MS = 10_000;

export interface SandboxEgressSession {
  sandboxId: string;
  requesterId: string;
  providers: string[];
  createdAtMs: number;
  expiresAtMs: number;
  conversationId?: string;
  sessionId?: string;
  sliceId?: number;
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

function replayKey(fingerprint: string): string {
  return `${SANDBOX_EGRESS_REPLAY_PREFIX}:${fingerprint}`;
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
    typeof record.createdAtMs !== "number" ||
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
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    ...(typeof record.conversationId === "string"
      ? { conversationId: record.conversationId }
      : {}),
    ...(typeof record.sessionId === "string"
      ? { sessionId: record.sessionId }
      : {}),
    ...(typeof record.sliceId === "number" ? { sliceId: record.sliceId } : {}),
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

function sameTurnScope(
  session: SandboxEgressSession,
  input: {
    conversationId?: string;
    requesterId?: string;
    sessionId?: string;
    sliceId?: number;
  },
): boolean {
  return (
    session.requesterId === input.requesterId &&
    session.conversationId === input.conversationId &&
    session.sessionId === input.sessionId &&
    session.sliceId === input.sliceId
  );
}

/** Persist the turn-scoped authorization context for sandbox egress credential activation. */
export async function upsertSandboxEgressSession(input: {
  sandboxId: string;
  requesterId?: string;
  providers: string[];
  conversationId?: string;
  sessionId?: string;
  sliceId?: number;
  ttlMs?: number;
}): Promise<SandboxEgressSession | undefined> {
  const state = getStateAdapter();
  await state.connect();
  if (!input.requesterId) {
    await state.delete(sessionKey(input.sandboxId));
    return undefined;
  }
  const ttlMs = Math.max(1, input.ttlMs ?? DEFAULT_SESSION_TTL_MS);
  const now = Date.now();
  const providers = [...new Set(input.providers)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (providers.length === 0) {
    const existing = parseSession(await state.get(sessionKey(input.sandboxId)));
    if (existing && sameTurnScope(existing, input)) {
      const refreshed = {
        ...existing,
        expiresAtMs: now + ttlMs,
      };
      await state.set(sessionKey(input.sandboxId), refreshed, ttlMs);
      return refreshed;
    }
    await state.delete(sessionKey(input.sandboxId));
    return undefined;
  }
  const session: SandboxEgressSession = {
    sandboxId: input.sandboxId,
    requesterId: input.requesterId,
    providers,
    createdAtMs: now,
    expiresAtMs: now + ttlMs,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(typeof input.sliceId === "number" ? { sliceId: input.sliceId } : {}),
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

/** Claim a short-lived request fingerprint so exact proxy request replays are rejected. */
export async function claimSandboxEgressReplayFingerprint(
  fingerprint: string,
): Promise<boolean> {
  const state = getStateAdapter();
  await state.connect();
  return await state.setIfNotExists(
    replayKey(fingerprint),
    { claimedAtMs: Date.now() },
    REPLAY_WINDOW_MS,
  );
}
