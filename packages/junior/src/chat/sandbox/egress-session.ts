import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Lock } from "chat";
import type { CredentialContext } from "@/chat/credentials/context";
import {
  parseSandboxEgressAuthRequiredSignal,
  sandboxEgressCredentialContextSchema,
  sandboxEgressCredentialLeaseSchema,
  type SandboxEgressAuthRequiredSignal,
  type SandboxEgressCredentialContext,
  type SandboxEgressCredentialLease,
} from "@/chat/sandbox/egress-schemas";
import { getStateAdapter } from "@/chat/state/adapter";

export const SANDBOX_EGRESS_PROXY_PATH = "/api/internal/sandbox-egress";

const SANDBOX_EGRESS_TOKEN_VERSION = "v1";
const SANDBOX_EGRESS_HMAC_CONTEXT = "junior.sandbox_egress.v1";
const SANDBOX_EGRESS_AUTH_SIGNAL_PREFIX = "sandbox-egress-auth-required";
const SANDBOX_EGRESS_LEASE_PREFIX = "sandbox-egress-lease";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const AUTH_SIGNAL_LOCK_TTL_MS = 30_000;

export type {
  SandboxEgressAuthRequiredSignal,
  SandboxEgressCredentialContext,
  SandboxEgressCredentialLease,
};

function leaseKey(
  provider: string,
  grantName: string,
  context: SandboxEgressCredentialContext,
): string {
  const actor = context.credentials.actor;
  const actorKey =
    actor.type === "user" ? `user:${actor.userId}` : `system:${actor.id}`;
  return `${SANDBOX_EGRESS_LEASE_PREFIX}:${provider}:${grantName}:${actorKey}:${context.egressId}:${context.contextId}`;
}

function authSignalKey(egressId: string): string {
  return `${SANDBOX_EGRESS_AUTH_SIGNAL_PREFIX}:${egressId}`;
}

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signPayload(payload: string): string {
  return createHmac("sha256", getSandboxEgressSecret())
    .update(`${SANDBOX_EGRESS_HMAC_CONTEXT}:${payload}`)
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

function parseSandboxEgressContext(
  value: unknown,
): SandboxEgressCredentialContext | undefined {
  const result = sandboxEgressCredentialContextSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  if (result.data.expiresAtMs <= Date.now()) {
    return undefined;
  }
  return result.data;
}

function parseLease(value: unknown): SandboxEgressCredentialLease | undefined {
  const result = sandboxEgressCredentialLeaseSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  const expiresAtMs = Date.parse(result.data.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return undefined;
  }
  return result.data;
}

function authSignalLockKey(egressId: string): string {
  return `${authSignalKey(egressId)}:lock`;
}

async function withAuthSignalLock<T>(
  egressId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const state = getStateAdapter();
  await state.connect();
  const lock: Lock | null = await state.acquireLock(
    authSignalLockKey(egressId),
    AUTH_SIGNAL_LOCK_TTL_MS,
  );
  if (!lock) {
    throw new Error(
      `Could not acquire sandbox egress auth signal lock for ${egressId}`,
    );
  }

  try {
    return await callback();
  } finally {
    await state.releaseLock(lock);
  }
}

function parseAuthSignals(value: unknown): SandboxEgressAuthRequiredSignal[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid sandbox egress auth signal state");
  }
  return value.map((entry) => {
    const signal = parseSandboxEgressAuthRequiredSignal(entry);
    if (!signal) {
      throw new Error("Invalid sandbox egress auth signal state");
    }
    return signal;
  });
}

function sameGrant(
  left: SandboxEgressAuthRequiredSignal,
  right: SandboxEgressAuthRequiredSignal,
): boolean {
  return (
    left.provider === right.provider &&
    left.grant.name === right.grant.name &&
    left.grant.access === right.grant.access
  );
}

function mergeAuthSignal(
  existing: SandboxEgressAuthRequiredSignal[],
  next: SandboxEgressAuthRequiredSignal,
): SandboxEgressAuthRequiredSignal[] {
  return existing.some((signal) => sameGrant(signal, next))
    ? existing
    : [...existing, next];
}

function selectAuthSignal(
  signals: SandboxEgressAuthRequiredSignal[],
): SandboxEgressAuthRequiredSignal | undefined {
  return (
    signals.find((signal) => signal.grant.access === "write") ?? signals[0]
  );
}

function getSandboxEgressSecret(): string {
  const secret = process.env.JUNIOR_SECRET?.trim();
  if (secret) {
    return secret;
  }
  throw new Error("Cannot determine sandbox egress secret (set JUNIOR_SECRET)");
}

/** Create a signed actor/sandbox context token for lazy sandbox egress auth. */
export function createSandboxEgressCredentialToken(input: {
  credentials: CredentialContext;
  egressId: string;
  ttlMs?: number;
}): string {
  const ttlMs = Math.max(1, input.ttlMs ?? DEFAULT_SESSION_TTL_MS);
  const now = Date.now();
  const context: SandboxEgressCredentialContext = {
    credentials: input.credentials,
    egressId: input.egressId,
    expiresAtMs: now + ttlMs,
    contextId: randomUUID(),
  };
  const payload = `${SANDBOX_EGRESS_TOKEN_VERSION}.${base64Url(
    JSON.stringify(context),
  )}`;
  return `${payload}.${signPayload(payload)}`;
}

/** Verify a signed actor/sandbox context token from the proxy URL. */
export function parseSandboxEgressCredentialToken(
  token: string | undefined,
): SandboxEgressCredentialContext | undefined {
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
    return parseSandboxEgressContext(JSON.parse(fromBase64Url(encodedSession)));
  } catch {
    return undefined;
  }
}

/** Cache a short-lived credential lease for repeated forwarded requests for one actor/sandbox context. */
export async function setSandboxEgressCredentialLease(
  context: SandboxEgressCredentialContext,
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
  await state.set(
    leaseKey(lease.provider, lease.grant.name, context),
    lease,
    ttlMs,
  );
}

/** Load a cached egress credential lease for an actor/sandbox context/provider pair. */
export async function getSandboxEgressCredentialLease(
  provider: string,
  grantName: string,
  context: SandboxEgressCredentialContext,
): Promise<SandboxEgressCredentialLease | undefined> {
  const state = getStateAdapter();
  await state.connect();
  return parseLease(await state.get(leaseKey(provider, grantName, context)));
}

/** Clear a cached egress credential lease after the provider rejects its headers. */
export async function clearSandboxEgressCredentialLease(
  provider: string,
  grantName: string,
  context: SandboxEgressCredentialContext,
): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  await state.delete(leaseKey(provider, grantName, context));
}

/** Record that host-side sandbox egress returned an auth-required response. */
export async function setSandboxEgressAuthRequiredSignal(
  context: SandboxEgressCredentialContext,
  signal: Omit<SandboxEgressAuthRequiredSignal, "createdAtMs">,
): Promise<void> {
  const ttlMs = Math.max(1, context.expiresAtMs - Date.now());
  await withAuthSignalLock(context.egressId, async () => {
    const state = getStateAdapter();
    const next = {
      ...signal,
      createdAtMs: Date.now(),
    };
    const existing = parseAuthSignals(
      await state.get(authSignalKey(context.egressId)),
    );
    await state.set(
      authSignalKey(context.egressId),
      mergeAuthSignal(existing, next),
      ttlMs,
    );
  });
}

/** Remove any pending host-side sandbox egress auth signal for a command. */
export async function clearSandboxEgressAuthRequiredSignal(
  egressId: string | undefined,
): Promise<void> {
  if (!egressId) {
    return;
  }
  await withAuthSignalLock(egressId, async () => {
    await getStateAdapter().delete(authSignalKey(egressId));
  });
}

/** Consume the host-side sandbox egress auth signal produced during a command. */
export async function consumeSandboxEgressAuthRequiredSignal(
  egressId: string | undefined,
): Promise<SandboxEgressAuthRequiredSignal | undefined> {
  if (!egressId) {
    return undefined;
  }
  return await withAuthSignalLock(egressId, async () => {
    const state = getStateAdapter();
    const key = authSignalKey(egressId);
    const signal = selectAuthSignal(parseAuthSignals(await state.get(key)));
    await state.delete(key);
    return signal;
  });
}
