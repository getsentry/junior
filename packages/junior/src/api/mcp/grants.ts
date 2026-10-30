/**
 * Own MCP OAuth grants: authorization codes, access tokens, and refresh
 * tokens. Every secret is random, opaque, and stored only as a SHA-256 hash
 * in shared state with a TTL.
 *
 * A grant ends `GRANT_MAX_AGE_MS` after consent. Refresh does not extend it.
 * Records store the user email, not a user snapshot, so each request resolves
 * the user again and checks the allowed domains.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { logWarn } from "@/chat/logging";
import { MCP_SCOPE } from "./metadata";
import { mcpStateKey, readRecord, sha256Hex, type McpState } from "./state";

const CODE_TTL_MS = 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
// Personal tokens last 90 days. A grant is shorter, because a third-party
// client holds its tokens and no page can revoke a grant yet.
const GRANT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Clients that run in many processes can refresh one token at the same time.
// A reuse in this window fails without revoking the grant.
const REFRESH_REUSE_GRACE_MS = 60 * 1000;
// Prefixes let secret scanners find leaked tokens. They carry no authority.
const ACCESS_TOKEN_PREFIX = "jr_mcp_at_";
const REFRESH_TOKEN_PREFIX = "jr_mcp_rt_";
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

const authorizationCodeSchema = z
  .object({
    clientId: z.string().min(1),
    codeChallenge: z.string().min(1),
    /** Verified email of the user who approved consent. */
    email: z.string().min(1),
    /** Grant that this code creates. Reuse of the code revokes it. */
    grantId: z.string().uuid(),
    redirectUri: z.string().min(1),
    resource: z.string().min(1),
    scope: z.literal(MCP_SCOPE),
  })
  .strict();

const grantSchema = z
  .object({
    clientId: z.string().min(1),
    email: z.string().min(1),
    /** Absolute end of the grant. Refresh never moves it. */
    expiresAtMs: z.number().int().positive(),
    resource: z.string().min(1),
    scope: z.literal(MCP_SCOPE),
  })
  .strict();

// An access or refresh token record. Its state TTL ends the token.
const tokenSchema = z.object({ grantId: z.string().uuid() }).strict();

type AuthorizationCode = z.output<typeof authorizationCodeSchema>;
type Grant = z.output<typeof grantSchema>;

type McpTokens = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  token_type: "Bearer";
};

/** Result of one token request, with a standard OAuth error code on failure. */
export type McpTokenResult =
  | { ok: true; tokens: McpTokens }
  | {
      description: string;
      error: "invalid_grant" | "invalid_scope";
      ok: false;
    };

function codeKey(code: string): string {
  return mcpStateKey("code", sha256Hex(code));
}

function grantKey(grantId: string): string {
  return mcpStateKey("grant", grantId);
}

function revokedGrantKey(grantId: string): string {
  return `${grantKey(grantId)}:revoked`;
}

function accessTokenKey(token: string): string {
  return mcpStateKey("access", sha256Hex(token));
}

function refreshTokenKey(token: string): string {
  return mcpStateKey("refresh", sha256Hex(token));
}

function invalidGrant(description: string): McpTokenResult {
  return { description, error: "invalid_grant", ok: false };
}

/** Issue a single-use authorization code for one approved consent. */
export async function issueAuthorizationCode(args: {
  clientId: string;
  codeChallenge: string;
  email: string;
  redirectUri: string;
  resource: string;
  state: McpState;
}): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const record: AuthorizationCode = {
    clientId: args.clientId,
    codeChallenge: args.codeChallenge,
    email: args.email,
    grantId: randomUUID(),
    redirectUri: args.redirectUri,
    resource: args.resource,
    scope: MCP_SCOPE,
  };
  await args.state.set(codeKey(code), record, CODE_TTL_MS);
  return code;
}

/**
 * Revoke a grant after a reused code or refresh token. The marker lives for
 * `GRANT_MAX_AGE_MS`, and no grant or token lives longer, so a racing request
 * that saves the grant again cannot bring it back.
 */
async function revokeGrant(args: {
  clientId: string;
  grantId: string;
  reason: "authorization_code_reused" | "refresh_token_reused";
  state: McpState;
}): Promise<void> {
  await args.state.set(revokedGrantKey(args.grantId), true, GRANT_MAX_AGE_MS);
  await args.state.delete(grantKey(args.grantId));
  logWarn("mcp.oauth.grant.revoked", {
    "app.mcp.client_id": args.clientId,
    "app.mcp.revoke_reason": args.reason,
  });
}

/** Read a grant that is not revoked and has not ended. */
async function readGrant(
  state: McpState,
  grantId: string,
): Promise<Grant | undefined> {
  if ((await state.get(revokedGrantKey(grantId))) !== null) return undefined;
  const grant = await readRecord(state, grantKey(grantId), grantSchema);
  return grant && grant.expiresAtMs > Date.now() ? grant : undefined;
}

/** Return true when the RFC 7636 S256 verifier matches the challenge. */
function verifierMatches(verifier: string, challenge: string): boolean {
  return (
    CODE_VERIFIER_PATTERN.test(verifier) &&
    createHash("sha256").update(verifier).digest("base64url") === challenge
  );
}

/**
 * Save a grant and issue a new access and refresh token pair for it. No
 * record outlives the grant.
 */
async function issueTokens(
  state: McpState,
  grantId: string,
  grant: Grant,
): Promise<McpTokenResult> {
  const grantTtlMs = grant.expiresAtMs - Date.now();
  if (grantTtlMs <= 0) return invalidGrant("The grant has expired.");
  const accessTtlMs = Math.min(ACCESS_TOKEN_TTL_MS, grantTtlMs);
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await state.set(grantKey(grantId), grant, grantTtlMs);
  await state.set(accessTokenKey(accessToken), { grantId }, accessTtlMs);
  await state.set(refreshTokenKey(refreshToken), { grantId }, grantTtlMs);
  return {
    ok: true,
    tokens: {
      access_token: accessToken,
      expires_in: Math.floor(accessTtlMs / 1000),
      refresh_token: refreshToken,
      scope: grant.scope,
      token_type: "Bearer",
    },
  };
}

/**
 * Exchange one authorization code for tokens. The code stays stored until it
 * expires. A second valid use of the code revokes the grant that the first
 * use created (RFC 6749 section 4.1.2).
 */
export async function exchangeAuthorizationCode(args: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string;
  state: McpState;
}): Promise<McpTokenResult> {
  const key = codeKey(args.code);
  const code = await readRecord(args.state, key, authorizationCodeSchema);
  if (
    !code ||
    code.clientId !== args.clientId ||
    code.redirectUri !== args.redirectUri ||
    (args.resource !== undefined && args.resource !== code.resource) ||
    !verifierMatches(args.codeVerifier, code.codeChallenge)
  ) {
    return invalidGrant("The authorization code is not valid.");
  }
  if (!(await args.state.setIfNotExists(`${key}:used`, true, CODE_TTL_MS))) {
    await revokeGrant({
      clientId: code.clientId,
      grantId: code.grantId,
      reason: "authorization_code_reused",
      state: args.state,
    });
    return invalidGrant("The authorization code was already used.");
  }
  return await issueTokens(args.state, code.grantId, {
    clientId: code.clientId,
    email: code.email,
    expiresAtMs: Date.now() + GRANT_MAX_AGE_MS,
    resource: code.resource,
    scope: code.scope,
  });
}

/**
 * Rotate a refresh token. Each refresh token works once. A second use of a
 * rotated token within `REFRESH_REUSE_GRACE_MS` fails. A later second use
 * revokes the whole grant, so a stolen token stops working for both the
 * thief and the client.
 */
export async function refreshGrant(args: {
  clientId: string;
  refreshToken: string;
  resource?: string;
  scope?: string;
  state: McpState;
}): Promise<McpTokenResult> {
  if (!args.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) {
    return invalidGrant("The refresh token is not valid.");
  }
  const key = refreshTokenKey(args.refreshToken);
  const token = await readRecord(args.state, key, tokenSchema);
  const grant = token ? await readGrant(args.state, token.grantId) : undefined;
  if (
    !token ||
    !grant ||
    grant.clientId !== args.clientId ||
    (args.resource !== undefined && args.resource !== grant.resource)
  ) {
    return invalidGrant("The refresh token is not valid.");
  }
  if (args.scope !== undefined && args.scope !== grant.scope) {
    return {
      description: `The only scope is ${MCP_SCOPE}.`,
      error: "invalid_scope",
      ok: false,
    };
  }
  const usedKey = `${key}:used`;
  if (
    !(await args.state.setIfNotExists(
      usedKey,
      Date.now(),
      grant.expiresAtMs - Date.now(),
    ))
  ) {
    const usedAtMs = await readRecord(args.state, usedKey, z.number());
    if (
      usedAtMs !== undefined &&
      Date.now() - usedAtMs < REFRESH_REUSE_GRACE_MS
    ) {
      return invalidGrant("The refresh token was already rotated.");
    }
    await revokeGrant({
      clientId: grant.clientId,
      grantId: token.grantId,
      reason: "refresh_token_reused",
      state: args.state,
    });
    return invalidGrant("The refresh token was already used.");
  }
  return await issueTokens(args.state, token.grantId, grant);
}

/**
 * Return the user email of one MCP access token for one resource. Personal
 * tokens and other bearer values never match, because only this module
 * stores MCP access tokens. The caller resolves the user and checks the
 * allowed domains.
 */
export async function authenticateMcpAccessToken(args: {
  resource: string;
  state: McpState;
  token: string;
}): Promise<string | undefined> {
  if (!args.token.startsWith(ACCESS_TOKEN_PREFIX)) return undefined;
  const token = await readRecord(
    args.state,
    accessTokenKey(args.token),
    tokenSchema,
  );
  if (!token) return undefined;
  const grant = await readGrant(args.state, token.grantId);
  if (!grant || grant.resource !== args.resource) return undefined;
  return grant.email;
}
