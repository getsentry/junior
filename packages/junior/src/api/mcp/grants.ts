/**
 * Own MCP OAuth grants: authorization codes, access tokens, and refresh
 * tokens. Every secret is random, opaque, and stored only as a SHA-256 hash
 * in shared state with a TTL.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { userSchema, type User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { MCP_SCOPE } from "./metadata";
import { mcpStateKey, stateKeyHash, type McpState } from "./state";

const CODE_TTL_MS = 60 * 1000;

const authorizationCodeSchema = z
  .object({
    clientId: z.string().min(1),
    codeChallenge: z.string().min(1),
    /** Grant that this code creates. Reuse of the code revokes it. */
    grantId: z.string().uuid(),
    redirectUri: z.string().min(1),
    resource: z.string().min(1),
    scope: z.literal(MCP_SCOPE),
    user: userSchema,
  })
  .strict();

function codeKey(code: string): string {
  return mcpStateKey("code", stateKeyHash(code));
}

/** Issue a single-use authorization code for one approved consent. */
export async function issueAuthorizationCode(args: {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  state: McpState;
  user: User;
}): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await args.state.set(
    codeKey(code),
    authorizationCodeSchema.parse({
      clientId: args.clientId,
      codeChallenge: args.codeChallenge,
      grantId: randomUUID(),
      redirectUri: args.redirectUri,
      resource: args.resource,
      scope: MCP_SCOPE,
      user: args.user,
    }),
    CODE_TTL_MS,
  );
  return code;
}

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Prefixes let secret scanners find leaked tokens. They carry no authority.
const ACCESS_TOKEN_PREFIX = "jr_mcp_at_";
const REFRESH_TOKEN_PREFIX = "jr_mcp_rt_";
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

const grantSchema = z
  .object({
    clientId: z.string().min(1),
    resource: z.string().min(1),
    scope: z.literal(MCP_SCOPE),
    /** The user who approved consent, as the dashboard verified them. */
    user: userSchema,
  })
  .strict();

const accessTokenSchema = z
  .object({
    expiresAtMs: z.number().int().positive(),
    grantId: z.string().uuid(),
  })
  .strict();

const refreshTokenSchema = z.object({ grantId: z.string().uuid() }).strict();

type Grant = z.output<typeof grantSchema>;

/** Successful OAuth token response body. */
export type McpTokens = {
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

function grantKey(grantId: string): string {
  return mcpStateKey("grant", grantId);
}

function revokedGrantKey(grantId: string): string {
  return `${grantKey(grantId)}:revoked`;
}

/**
 * Revoke a grant. The marker outlives every token of the grant, so a racing
 * request that saves the grant again cannot bring it back.
 */
async function revokeGrant(state: McpState, grantId: string): Promise<void> {
  await state.set(revokedGrantKey(grantId), true, REFRESH_TOKEN_TTL_MS);
  await state.delete(grantKey(grantId));
}

/** Read a grant that is not revoked. */
async function readGrant(
  state: McpState,
  grantId: string,
): Promise<Grant | undefined> {
  const revoked = await state.get(revokedGrantKey(grantId));
  if (revoked !== null && revoked !== undefined) return undefined;
  return await readRecord(state, grantKey(grantId), grantSchema);
}

function accessTokenKey(token: string): string {
  return mcpStateKey("access", stateKeyHash(token));
}

function refreshTokenKey(token: string): string {
  return mcpStateKey("refresh", stateKeyHash(token));
}

function invalidGrant(description: string): McpTokenResult {
  return { description, error: "invalid_grant", ok: false };
}

async function readRecord<T>(
  state: McpState,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const value = await state.get(key);
  return value === null || value === undefined
    ? undefined
    : schema.parse(value);
}

/** Return true when the RFC 7636 S256 verifier matches the challenge. */
function verifierMatches(verifier: string, challenge: string): boolean {
  return (
    CODE_VERIFIER_PATTERN.test(verifier) &&
    createHash("sha256").update(verifier).digest("base64url") === challenge
  );
}

/** Save a grant and issue a new access and refresh token pair for it. */
async function issueTokens(
  state: McpState,
  grantId: string,
  grant: Grant,
): Promise<McpTokenResult> {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await state.set(
    grantKey(grantId),
    grantSchema.parse(grant),
    REFRESH_TOKEN_TTL_MS,
  );
  await state.set(
    accessTokenKey(accessToken),
    accessTokenSchema.parse({
      expiresAtMs: Date.now() + ACCESS_TOKEN_TTL_MS,
      grantId,
    }),
    ACCESS_TOKEN_TTL_MS,
  );
  await state.set(
    refreshTokenKey(refreshToken),
    refreshTokenSchema.parse({ grantId }),
    REFRESH_TOKEN_TTL_MS,
  );
  return {
    ok: true,
    tokens: {
      access_token: accessToken,
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
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
    await revokeGrant(args.state, code.grantId);
    return invalidGrant("The authorization code was already used.");
  }
  return await issueTokens(args.state, code.grantId, {
    clientId: code.clientId,
    resource: code.resource,
    scope: code.scope,
    user: code.user,
  });
}

/**
 * Rotate a refresh token. Each refresh token works once. A second use of a
 * rotated token revokes the whole grant, so a stolen token stops working for
 * both the thief and the client.
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
  const token = await readRecord(args.state, key, refreshTokenSchema);
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
  if (
    !(await args.state.setIfNotExists(
      `${key}:used`,
      true,
      REFRESH_TOKEN_TTL_MS,
    ))
  ) {
    await revokeGrant(args.state, token.grantId);
    return invalidGrant("The refresh token was already used.");
  }
  return await issueTokens(args.state, token.grantId, grant);
}

/**
 * Resolve the user of one MCP access token for one resource. Personal tokens
 * and other bearer values never match, because only this module stores MCP
 * access tokens.
 */
export async function authenticateMcpAccessToken(args: {
  resource: string;
  state: McpState;
  token: string;
}): Promise<User | undefined> {
  if (!args.token.startsWith(ACCESS_TOKEN_PREFIX)) return undefined;
  const token = await readRecord(
    args.state,
    accessTokenKey(args.token),
    accessTokenSchema,
  );
  if (!token || token.expiresAtMs <= Date.now()) return undefined;
  const grant = await readGrant(args.state, token.grantId);
  if (!grant || grant.resource !== args.resource) return undefined;
  return grant.user;
}
