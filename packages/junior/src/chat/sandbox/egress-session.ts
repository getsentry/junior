import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { CredentialContext } from "@/chat/credentials/context";
import {
  parseSandboxEgressAuthRequiredSignal,
  parseSandboxEgressPermissionDeniedSignal,
  sandboxEgressCredentialContextSchema,
  sandboxEgressCredentialLeaseSchema,
  type SandboxEgressAuthRequiredSignal,
  type SandboxEgressCredentialContext,
  type SandboxEgressCredentialLease,
  type SandboxEgressPermissionDeniedSignal,
} from "@/chat/sandbox/egress-schemas";
import { getStateAdapter } from "@/chat/state/adapter";

export const SANDBOX_EGRESS_PROXY_PATH = "/api/internal/sandbox-egress";

const SANDBOX_EGRESS_TOKEN_VERSION = "v1";
const SANDBOX_EGRESS_HMAC_CONTEXT = "junior.sandbox_egress.v1";
const SANDBOX_EGRESS_AUTH_SIGNAL_PREFIX = "sandbox-egress-auth-required";
const SANDBOX_EGRESS_PERMISSION_SIGNAL_PREFIX =
  "sandbox-egress-permission-denied";
const SANDBOX_EGRESS_LEASE_PREFIX = "sandbox-egress-lease";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

export type {
  SandboxEgressAuthRequiredSignal,
  SandboxEgressCredentialContext,
  SandboxEgressCredentialLease,
  SandboxEgressPermissionDeniedSignal,
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

function authSignalKey(
  egressId: string,
  access: SandboxEgressAuthRequiredSignal["grant"]["access"],
): string {
  return `${SANDBOX_EGRESS_AUTH_SIGNAL_PREFIX}:${egressId}:${access}`;
}

function permissionSignalKey(
  egressId: string,
  access: SandboxEgressPermissionDeniedSignal["grant"]["access"],
): string {
  return `${SANDBOX_EGRESS_PERMISSION_SIGNAL_PREFIX}:${egressId}:${access}`;
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

/** Cache a short-lived credential lease for one actor/sandbox context and grant. */
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

/** Load a cached egress credential lease for one actor/sandbox context and grant. */
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
  const state = getStateAdapter();
  await state.connect();
  await state.set(
    authSignalKey(context.egressId, signal.grant.access),
    {
      ...signal,
      createdAtMs: Date.now(),
    },
    ttlMs,
  );
}

/** Record that host-side sandbox egress saw an upstream permission denial. */
export async function setSandboxEgressPermissionDeniedSignal(
  context: SandboxEgressCredentialContext,
  signal: Omit<SandboxEgressPermissionDeniedSignal, "createdAtMs">,
): Promise<void> {
  const ttlMs = Math.max(1, context.expiresAtMs - Date.now());
  const state = getStateAdapter();
  await state.connect();
  await state.set(
    permissionSignalKey(context.egressId, signal.grant.access),
    {
      ...signal,
      createdAtMs: Date.now(),
    },
    ttlMs,
  );
}

/** Remove any pending host-side sandbox egress signals for a command. */
export async function clearSandboxEgressSignals(
  egressId: string | undefined,
): Promise<void> {
  if (!egressId) {
    return;
  }
  const state = getStateAdapter();
  await state.connect();
  await Promise.all([
    state.delete(authSignalKey(egressId, "read")),
    state.delete(authSignalKey(egressId, "write")),
    state.delete(permissionSignalKey(egressId, "read")),
    state.delete(permissionSignalKey(egressId, "write")),
  ]);
}

/** Consume the host-side sandbox egress auth signal produced during a command. */
export async function consumeSandboxEgressAuthRequiredSignal(
  egressId: string | undefined,
): Promise<SandboxEgressAuthRequiredSignal | undefined> {
  if (!egressId) {
    return undefined;
  }
  const state = getStateAdapter();
  await state.connect();
  const [writeSignal, readSignal] = await Promise.all([
    state.get(authSignalKey(egressId, "write")),
    state.get(authSignalKey(egressId, "read")),
  ]);
  const signal =
    parseSandboxEgressAuthRequiredSignal(writeSignal) ??
    parseSandboxEgressAuthRequiredSignal(readSignal);
  await Promise.all([
    state.delete(authSignalKey(egressId, "read")),
    state.delete(authSignalKey(egressId, "write")),
  ]);
  return signal;
}

/** Consume the host-side sandbox egress permission signal produced during a command. */
export async function consumeSandboxEgressPermissionDeniedSignal(
  egressId: string | undefined,
): Promise<SandboxEgressPermissionDeniedSignal | undefined> {
  if (!egressId) {
    return undefined;
  }
  const state = getStateAdapter();
  await state.connect();
  const [writeSignal, readSignal] = await Promise.all([
    state.get(permissionSignalKey(egressId, "write")),
    state.get(permissionSignalKey(egressId, "read")),
  ]);
  const signal =
    parseSandboxEgressPermissionDeniedSignal(writeSignal) ??
    parseSandboxEgressPermissionDeniedSignal(readSignal);
  await Promise.all([
    state.delete(permissionSignalKey(egressId, "read")),
    state.delete(permissionSignalKey(egressId, "write")),
  ]);
  return signal;
}
