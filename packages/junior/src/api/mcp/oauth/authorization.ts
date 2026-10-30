/**
 * Own the OAuth authorization endpoint and its pending requests.
 *
 * The endpoint checks the client and redirect URI first. When either one is
 * invalid, it shows an error page and never redirects, so an attacker cannot
 * use Junior as an open redirect. Other errors go back to the client as OAuth
 * error redirects. A valid request waits for consent on a dashboard page.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { redirectUriMatches, resolveMcpClient } from "./client-metadata";
import { MCP_SCOPE, type McpUrls } from "./metadata";
import { renderMcpPage } from "./page";
import { mcpStateKey, readRecord, sha256Hex, type McpState } from "./state";

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const STATE_MAX_LENGTH = 1_000;
const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const mcpAuthorizationSchema = z
  .object({
    clientId: z.string().min(1),
    clientName: z.string().min(1).optional(),
    codeChallenge: z.string().regex(CODE_CHALLENGE_PATTERN),
    /** Fixed end of the request. Opening the consent page does not move it. */
    expiresAtMs: z.number().int().positive(),
    redirectUri: z.string().min(1),
    resource: z.string().min(1),
    scope: z.literal(MCP_SCOPE),
    state: z.string().max(STATE_MAX_LENGTH).optional(),
  })
  .strict();

/** One authorization request that waits for consent. */
export type McpAuthorization = z.output<typeof mcpAuthorizationSchema>;

/** The user who owns one consent page, and the hash of its form token. */
const mcpConsentSchema = z
  .object({
    csrfHash: z.string().length(64),
    userId: z.string().min(1),
  })
  .strict();

type McpConsent = z.output<typeof mcpConsentSchema>;

function authorizationKey(authorizationId: string): string {
  return mcpStateKey("authorization", authorizationId);
}

function consentKey(authorizationId: string): string {
  return `${authorizationKey(authorizationId)}:consent`;
}

function claimedKey(authorizationId: string): string {
  return `${authorizationKey(authorizationId)}:claimed`;
}

/**
 * Read one pending authorization and its consent binding. Malformed ids,
 * ended requests, and claimed requests read as missing.
 */
export async function readMcpAuthorization(
  state: McpState,
  authorizationId: string,
): Promise<
  { authorization: McpAuthorization; consent?: McpConsent } | undefined
> {
  if (!AUTHORIZATION_ID_PATTERN.test(authorizationId)) return undefined;
  const authorization = await readRecord(
    state,
    authorizationKey(authorizationId),
    mcpAuthorizationSchema,
  );
  if (!authorization || authorization.expiresAtMs <= Date.now()) {
    return undefined;
  }
  if ((await state.get(claimedKey(authorizationId))) !== null) return undefined;
  const consent = await readRecord(
    state,
    consentKey(authorizationId),
    mcpConsentSchema,
  );
  return { authorization, consent };
}

/**
 * Bind a pending authorization to the first user who opens its consent page,
 * and return a new form token for that user. Return `undefined` when another
 * user owns it. Only the bound user can approve, so a page that an attacker
 * opened cannot be submitted for a victim. The binding never extends the
 * request, and a claimed request stays claimed.
 */
export async function bindMcpConsent(args: {
  authorization: McpAuthorization;
  authorizationId: string;
  state: McpState;
  userId: string;
}): Promise<string | undefined> {
  const ttlMs = args.authorization.expiresAtMs - Date.now();
  if (ttlMs <= 0) return undefined;
  const csrfToken = randomBytes(32).toString("base64url");
  const consent: McpConsent = {
    csrfHash: sha256Hex(csrfToken),
    userId: args.userId,
  };
  const key = consentKey(args.authorizationId);
  if (await args.state.setIfNotExists(key, consent, ttlMs)) return csrfToken;
  const owner = await readRecord(args.state, key, mcpConsentSchema);
  // A missing owner means that a racing claim ended the request.
  if (owner?.userId !== args.userId) return undefined;
  // The owner opened the page again. Only the newest form token works.
  await args.state.set(key, consent, ttlMs);
  return csrfToken;
}

/**
 * Claim a pending authorization for one consent decision. Only one caller
 * can claim it, so one consent cannot issue two codes.
 */
export async function claimMcpAuthorization(
  state: McpState,
  authorizationId: string,
): Promise<boolean> {
  const claimed = await state.setIfNotExists(
    claimedKey(authorizationId),
    true,
    AUTHORIZATION_TTL_MS,
  );
  if (claimed) {
    await state.delete(authorizationKey(authorizationId));
    await state.delete(consentKey(authorizationId));
  }
  return claimed;
}

/** Build the client redirect for an OAuth authorization response. */
export function authorizationRedirect(args: {
  issuer: string;
  params: Record<string, string>;
  redirectUri: string;
  state?: string;
}): Response {
  const url = new URL(args.redirectUri);
  for (const [name, value] of Object.entries(args.params)) {
    url.searchParams.set(name, value);
  }
  if (args.state !== undefined) url.searchParams.set("state", args.state);
  // RFC 9207 lets the client check which server sent the response.
  url.searchParams.set("iss", args.issuer);
  return new Response(null, {
    status: 303,
    headers: { "cache-control": "no-store", location: url.toString() },
  });
}

function invalidClientPage(message: string): Response {
  return renderMcpPage({
    message,
    status: 400,
    title: "This app cannot connect",
  });
}

/** Handle `GET /api/mcp/oauth/authorize` and hand off to the consent page. */
export async function handleMcpAuthorize(args: {
  request: Request;
  state: McpState;
  urls: McpUrls;
}): Promise<Response> {
  const params = new URL(args.request.url).searchParams;
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const client = await resolveMcpClient(args.state, clientId);
  if (!client) {
    return invalidClientPage(
      "The client ID is not a valid client metadata document URL.",
    );
  }
  if (!redirectUriMatches(client.redirectUris, redirectUri)) {
    return invalidClientPage(
      "The redirect URI is not registered by this client.",
    );
  }

  const oauthState = params.get("state") ?? undefined;
  const fail = (error: string, description: string) =>
    authorizationRedirect({
      issuer: args.urls.issuer,
      params: { error, error_description: description },
      redirectUri,
      state: oauthState,
    });
  if (params.get("response_type") !== "code") {
    return fail("unsupported_response_type", "Use response_type=code.");
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (
    params.get("code_challenge_method") !== "S256" ||
    !CODE_CHALLENGE_PATTERN.test(codeChallenge)
  ) {
    return fail("invalid_request", "PKCE with S256 is required.");
  }
  if (oauthState !== undefined && oauthState.length > STATE_MAX_LENGTH) {
    return fail("invalid_request", "The state parameter is too long.");
  }
  const scope = params.get("scope")?.trim();
  if (scope && scope !== MCP_SCOPE) {
    return fail("invalid_scope", `The only scope is ${MCP_SCOPE}.`);
  }
  if (params.get("resource") !== args.urls.resource) {
    return fail(
      "invalid_target",
      `The resource must be ${args.urls.resource}.`,
    );
  }

  const authorizationId = randomBytes(32).toString("base64url");
  const authorization: McpAuthorization = {
    clientId: client.clientId,
    clientName: client.name,
    codeChallenge,
    expiresAtMs: Date.now() + AUTHORIZATION_TTL_MS,
    redirectUri,
    resource: args.urls.resource,
    scope: MCP_SCOPE,
    state: oauthState,
  };
  await args.state.set(
    authorizationKey(authorizationId),
    authorization,
    AUTHORIZATION_TTL_MS,
  );
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location: args.urls.consent(authorizationId),
    },
  });
}
