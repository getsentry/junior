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
} from "@/chat/sandbox/egress/schemas";
import { getStateAdapter } from "@/chat/state/adapter";

// Module overview: store the short-lived state that connects a sandbox command
// to host egress.
//
// The sandbox gets a signed context token in its network policy URL; the proxy
// verifies that token on every forwarded request. Only shared installation
// grants keep remembered auth headers on the host. Auth-required and
// permission-denied signals are written here so the sandbox command runner can
// translate host egress failures into the same user-facing auth flow as direct
// tool calls.

export const SANDBOX_EGRESS_PROXY_PATH = "/api/internal/sandbox-egress";

const SANDBOX_EGRESS_TOKEN_VERSION = "v1";
const SANDBOX_EGRESS_HMAC_CONTEXT = "junior.sandbox_egress.v1";
const SANDBOX_EGRESS_AUTH_SIGNAL_PREFIX = "sandbox-egress-auth-required";
const SANDBOX_EGRESS_PERMISSION_SIGNAL_PREFIX =
  "sandbox-egress-permission-denied";
const SANDBOX_EGRESS_LEASE_PREFIX = "sandbox-egress-lease";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
/** Treat a cached lease as expired this long before its provider expiry. */
const LEASE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type {
  SandboxEgressAuthRequiredSignal,
  SandboxEgressCredentialContext,
  SandboxEgressCredentialLease,
  SandboxEgressPermissionDeniedSignal,
};

/** True when this grant may keep shared auth headers on the host. */
function isSharedInstallationGrant(
  grant: Pick<SandboxEgressCredentialLease["grant"], "name">,
): boolean {
  return grant.name.startsWith("installation-");
}

/**
 * Build the host key for a shared installation grant.
 *
 * Only installation grants are remembered. User and other grants issue live
 * headers each time, so they never write a host key. Keys stay scoped to the
 * Slack workspace that owns the installation token.
 */
function installationWorkspaceScope(workspaceId?: string): string {
  const scoped = workspaceId?.trim();
  return scoped && scoped.length > 0 ? scoped : "local";
}

function leaseKey(
  provider: string,
  grant: SandboxEgressCredentialLease["grant"],
  workspaceId?: string,
): string {
  return `${SANDBOX_EGRESS_LEASE_PREFIX}:${provider}:${grant.name}:${installationWorkspaceScope(workspaceId)}`;
}

/**
 * Build the command signal key for credential issuance failures by access level.
 */
function authSignalKey(
  egressId: string,
  access: SandboxEgressAuthRequiredSignal["grant"]["access"],
): string {
  return `${SANDBOX_EGRESS_AUTH_SIGNAL_PREFIX}:${egressId}:${access}`;
}

/**
 * Build the command signal key for upstream permission denials by access level.
 */
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

/**
 * Sign a versioned context payload in the sandbox egress HMAC domain.
 *
 * `JUNIOR_SECRET` is the shared secret so proxy URLs cannot be forged by code
 * running inside the sandbox.
 */
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
  // Refresh before hard expiry so a hop near the edge does not send a token
  // that dies between cache read and upstream use.
  if (
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() + LEASE_REFRESH_BUFFER_MS
  ) {
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

/**
 * Create the signed Junior credential context embedded in the proxy URL.
 *
 * The token binds actor credentials to a specific sandbox egress id and a
 * short expiry. Vercel OIDC proves which VM sent a request; this token proves
 * which Junior actor and credential context that VM is allowed to use.
 */
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

/**
 * Verify the signed Junior credential context from the proxy URL.
 *
 * Returning `undefined` means the token is missing, expired, malformed, or not
 * signed with the current `JUNIOR_SECRET`.
 */
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

/**
 * Remember auth headers for a shared installation grant.
 *
 * User and other grants are ignored here. TTL follows the provider expiry.
 * Sandbox context expiry still decides whether a request may use the headers;
 * it does not shorten a shared installation grant for other sandboxes.
 */
export async function setSandboxEgressCredentialLease(
  context: SandboxEgressCredentialContext,
  lease: SandboxEgressCredentialLease,
): Promise<void> {
  if (!isSharedInstallationGrant(lease.grant)) {
    return;
  }
  const leaseExpiresAtMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= Date.now()) {
    return;
  }
  const ttlMs = Math.max(1, leaseExpiresAtMs - Date.now());
  const state = getStateAdapter();
  await state.connect();
  await state.set(
    leaseKey(lease.provider, lease.grant, context.credentials.workspaceId),
    lease,
    ttlMs,
  );
}

/** Load remembered auth headers for a shared installation grant. */
export async function getSandboxEgressCredentialLease(
  provider: string,
  grant: SandboxEgressCredentialLease["grant"],
  context: SandboxEgressCredentialContext,
): Promise<SandboxEgressCredentialLease | undefined> {
  if (!isSharedInstallationGrant(grant)) {
    return undefined;
  }
  const state = getStateAdapter();
  await state.connect();
  return parseLease(
    await state.get(
      leaseKey(provider, grant, context.credentials.workspaceId),
    ),
  );
}

/** Drop remembered installation headers after the upstream rejects them. */
export async function clearSandboxEgressCredentialLease(
  provider: string,
  grant: SandboxEgressCredentialLease["grant"],
  context: SandboxEgressCredentialContext,
): Promise<void> {
  if (!isSharedInstallationGrant(grant)) {
    return;
  }
  const state = getStateAdapter();
  await state.connect();
  await state.delete(
    leaseKey(provider, grant, context.credentials.workspaceId),
  );
}

/**
 * Record that credential issuance needs user authorization for this command.
 *
 * The command runner consumes this after the sandbox tool finishes so the agent
 * can present a normal authorization-required response instead of a raw proxy
 * failure.
 */
export async function setSandboxEgressAuthRequiredSignal(
  context: SandboxEgressCredentialContext,
  signal: Omit<SandboxEgressAuthRequiredSignal, "createdAtMs" | "kind"> & {
    kind?: SandboxEgressAuthRequiredSignal["kind"];
  },
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

/**
 * Record that the provider rejected an issued credential with permission denial.
 */
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

/** Remove pending auth/permission signals before or after a sandbox command. */
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

/**
 * Consume the auth signal produced during a sandbox command, preferring writes.
 */
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

/**
 * Consume the permission signal produced during a sandbox command, preferring writes.
 */
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
