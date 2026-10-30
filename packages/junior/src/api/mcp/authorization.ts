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
import { mcpStateKey, stateKeyHash, type McpState } from "./state";

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const STATE_MAX_LENGTH = 1_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
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

function authorizationKey(requestId: string): string {
  return mcpStateKey("authorization", requestId);
}

function consentKey(requestId: string): string {
  return `${authorizationKey(requestId)}:consent`;
}

function claimedKey(requestId: string): string {
  return `${authorizationKey(requestId)}:claimed`;
}

/**
 * Read one pending authorization and its consent binding. Malformed ids,
 * ended requests, and claimed requests read as missing.
 */
export async function readMcpAuthorization(
  state: McpState,
  requestId: string,
): Promise<
  { authorization: McpAuthorization; consent?: McpConsent } | undefined
> {
  if (!REQUEST_ID_PATTERN.test(requestId)) return undefined;
  const value = await state.get(authorizationKey(requestId));
  if (value === null || value === undefined) return undefined;
  const authorization = mcpAuthorizationSchema.parse(value);
  if (authorization.expiresAtMs <= Date.now()) return undefined;
  const claimed = await state.get(claimedKey(requestId));
  if (claimed !== null && claimed !== undefined) return undefined;
  const consent = await state.get(consentKey(requestId));
  return consent === null || consent === undefined
    ? { authorization }
    : { authorization, consent: mcpConsentSchema.parse(consent) };
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
  requestId: string;
  state: McpState;
  userId: string;
}): Promise<string | undefined> {
  const ttlMs = args.authorization.expiresAtMs - Date.now();
  if (ttlMs <= 0) return undefined;
  const csrfToken = randomBytes(32).toString("base64url");
  const consent = mcpConsentSchema.parse({
    csrfHash: stateKeyHash(csrfToken),
    userId: args.userId,
  });
  const key = consentKey(args.requestId);
  if (await args.state.setIfNotExists(key, consent, ttlMs)) return csrfToken;
  const stored = await args.state.get(key);
  // A racing claim deleted the binding, so the request has ended.
  if (stored === null || stored === undefined) return undefined;
  if (mcpConsentSchema.parse(stored).userId !== args.userId) return undefined;
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
  requestId: string,
): Promise<boolean> {
  const claimed = await state.setIfNotExists(
    claimedKey(requestId),
    true,
    AUTHORIZATION_TTL_MS,
  );
  if (claimed) {
    await state.delete(authorizationKey(requestId));
    await state.delete(consentKey(requestId));
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

  const requestId = randomBytes(32).toString("base64url");
  await args.state.set(
    authorizationKey(requestId),
    mcpAuthorizationSchema.parse({
      clientId: client.clientId,
      ...(client.name ? { clientName: client.name } : undefined),
      codeChallenge,
      expiresAtMs: Date.now() + AUTHORIZATION_TTL_MS,
      redirectUri,
      resource: args.urls.resource,
      scope: MCP_SCOPE,
      ...(oauthState === undefined ? undefined : { state: oauthState }),
    }),
    AUTHORIZATION_TTL_MS,
  );
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location: args.urls.consent(requestId),
    },
  });
}
