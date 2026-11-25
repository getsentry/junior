// Serves the built dashboard with its mock reporting data, so the iOS app can
// run against real API shapes without Slack, a database, or a sign-in. It
// also serves a mock of the MCP server at `/api/mcp` and its OAuth endpoints,
// and the iOS app's session codes.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { MCP_SCOPES, createMockMcpTools } from "./mock-mcp-tools.mjs";

process.env["DATABASE_URL"] ??= "postgres://localhost/junior-ios-mock";
process.env["JUNIOR_ENCRYPTION_KEYS"] ??=
  "ios:Wywm9DZHe0QkHOXon30I5fklwG0gdqLAzMViptFlvtI";

const port = Number(process.env["PORT"] ?? 4317);
// The built dashboard: run `pnpm --filter "@sentry/junior-dashboard..." build`
// first.
const { createDashboardApp, resetMockDashboardState } =
  await import("../../../packages/junior-dashboard/dist/app.js");
const app = createDashboardApp({
  agentName: "Junior",
  allowedDomains: ["example.com"],
  auth: {
    async getSession() {
      return {
        user: {
          email: "dev@example.com",
          emailVerified: true,
          name: "Dashboard User",
        },
      };
    },
    async handler() {
      return Response.json({ ok: true });
    },
    async signInWithGoogle() {
      return Response.redirect("https://accounts.google.com", 302);
    },
  },
  mockConversations: true,
});

const baseURL = `http://127.0.0.1:${port}`;

const MCP_PATH = "/api/mcp";
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/api/mcp";
const AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";
const AUTHORIZE_PATH = "/api/mcp/oauth/authorize";
const TOKEN_PATH = "/api/mcp/oauth/token";
const urls = {
  authorize: `${baseURL}${AUTHORIZE_PATH}`,
  issuer: baseURL,
  resource: `${baseURL}${MCP_PATH}`,
  resourceMetadata: `${baseURL}${RESOURCE_METADATA_PATH}`,
  token: `${baseURL}${TOKEN_PATH}`,
};
const ALL_SCOPES = MCP_SCOPES.join(" ");

// Screenshot runs launch the app with this token. It has every scope.
const FIXED_ACCESS_TOKEN = "mock-access-token";
const CODE_TTL_MS = 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const GRANT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_REUSE_GRACE_MS = 60 * 1000;
const ACCESS_TOKEN_PREFIX = "jr_mcp_at_";
const REFRESH_TOKEN_PREFIX = "jr_mcp_rt_";
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE_MAX_LENGTH = 1_000;
const TOKEN_HEADERS = { "cache-control": "no-store", pragma: "no-cache" };

// OAuth state outlives `/__reset`, so a signed-in app stays signed in.
const codes = new Map();
const grants = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();

const config = await (
  await app.fetch(new Request(`${baseURL}/api/config`))
).json();
const serverVersion = config.version ?? "mock";
const agentName = "Junior";
const mcpTools = createMockMcpTools({ app, origin: baseURL });

// Versions that `initialize` agrees to. Others get the default.
const INITIALIZE_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
// Versions that the SDK transport accepts in `mcp-protocol-version`.
const HEADER_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

function protectedResourceMetadata() {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_SCOPES],
  };
}

function authorizationServerMetadata() {
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorize,
    token_endpoint: urls.token,
    scopes_supported: [...MCP_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

/** Known scopes in canonical order, or undefined for an unknown scope. */
function parseScopes(value) {
  const names = value.split(" ").filter(Boolean);
  if (names.length === 0) return undefined;
  if (!names.every((name) => MCP_SCOPES.includes(name))) return undefined;
  return MCP_SCOPES.filter((scope) => names.includes(scope));
}

// The iOS app's redirect, or a loopback one for other local clients.
function isAllowedRedirect(value) {
  if (value === "junior-ios://oauth/callback") return true;
  const url = URL.parse(value);
  return (
    url !== null &&
    !value.includes("#") &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  );
}

function invalidClientPage(message) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>This app cannot connect</title><h1>This app cannot connect</h1><p>${message}</p>`,
    {
      status: 400,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

function authorizationRedirect(redirectUri, params, state) {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  if (state !== undefined) url.searchParams.set("state", state);
  url.searchParams.set("iss", urls.issuer);
  return new Response(null, {
    status: 303,
    headers: { "cache-control": "no-store", location: url.toString() },
  });
}

// The real endpoint checks a CIMD client and then asks for Google sign-in
// and consent. The mock accepts any client and approves at once.
function handleAuthorize(request) {
  const params = new URL(request.url).searchParams;
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!clientId) {
    return invalidClientPage(
      "The client ID is not a valid client metadata document URL.",
    );
  }
  if (!isAllowedRedirect(redirectUri)) {
    return invalidClientPage(
      "The redirect URI is not registered by this client.",
    );
  }
  const state = params.get("state") ?? undefined;
  const fail = (error, description) =>
    authorizationRedirect(
      redirectUri,
      { error, error_description: description },
      state,
    );
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
  if (state !== undefined && state.length > STATE_MAX_LENGTH) {
    return fail("invalid_request", "The state parameter is too long.");
  }
  const scopes = parseScopes(params.get("scope")?.trim() || ALL_SCOPES);
  if (!scopes) {
    return fail("invalid_scope", `Use only these scopes: ${ALL_SCOPES}.`);
  }
  if (params.get("resource") !== urls.resource) {
    return fail("invalid_target", `The resource must be ${urls.resource}.`);
  }
  const code = randomBytes(32).toString("base64url");
  codes.set(code, {
    clientId,
    codeChallenge,
    expiresAtMs: Date.now() + CODE_TTL_MS,
    grantId: randomUUID(),
    redirectUri,
    resource: urls.resource,
    scope: scopes.join(" "),
    used: false,
  });
  // The iOS app also asks for a dashboard session code.
  const sessionChallenge = params.get("session_code_challenge");
  if (
    sessionChallenge !== null &&
    !CODE_CHALLENGE_PATTERN.test(sessionChallenge)
  ) {
    return fail("invalid_request", "The session code challenge is not valid.");
  }
  return authorizationRedirect(
    redirectUri,
    sessionChallenge
      ? { code, session_code: issueSessionCode(sessionChallenge) }
      : { code },
    state,
  );
}

function tokenError(error, description, status = 400) {
  return Response.json(
    { error, error_description: description },
    { status, headers: TOKEN_HEADERS },
  );
}

function readGrant(grantId) {
  const grant = grants.get(grantId);
  return grant && !grant.revoked && grant.expiresAtMs > Date.now()
    ? grant
    : undefined;
}

function issueTokens(grantId, grant) {
  const grantTtlMs = grant.expiresAtMs - Date.now();
  if (grantTtlMs <= 0) {
    return tokenError("invalid_grant", "The grant has expired.");
  }
  const accessTtlMs = Math.min(ACCESS_TOKEN_TTL_MS, grantTtlMs);
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  grants.set(grantId, grant);
  accessTokens.set(accessToken, {
    expiresAtMs: Date.now() + accessTtlMs,
    grantId,
  });
  refreshTokens.set(refreshToken, { grantId, usedAtMs: undefined });
  return Response.json(
    {
      access_token: accessToken,
      expires_in: Math.floor(accessTtlMs / 1000),
      refresh_token: refreshToken,
      scope: grant.scope,
      token_type: "Bearer",
    },
    { headers: TOKEN_HEADERS },
  );
}

function verifierMatches(verifier, challenge) {
  return (
    CODE_VERIFIER_PATTERN.test(verifier) &&
    createHash("sha256").update(verifier).digest("base64url") === challenge
  );
}

function revokeGrant(grantId) {
  const grant = grants.get(grantId);
  grants.set(grantId, { ...grant, revoked: true });
}

function exchangeCode(form, clientId) {
  const code = form.get("code");
  const codeVerifier = form.get("code_verifier");
  const redirectUri = form.get("redirect_uri");
  if (!code || !codeVerifier || !redirectUri) {
    return tokenError(
      "invalid_request",
      "The code, code_verifier, and redirect_uri are required.",
    );
  }
  const record = codes.get(code);
  const resource = form.get("resource");
  if (
    !record ||
    record.expiresAtMs <= Date.now() ||
    record.clientId !== clientId ||
    record.redirectUri !== redirectUri ||
    (resource !== null && resource !== record.resource) ||
    !verifierMatches(codeVerifier, record.codeChallenge)
  ) {
    return tokenError("invalid_grant", "The authorization code is not valid.");
  }
  // A second use of a code revokes the grant that the first use created.
  if (record.used) {
    revokeGrant(record.grantId);
    return tokenError(
      "invalid_grant",
      "The authorization code was already used.",
    );
  }
  record.used = true;
  return issueTokens(record.grantId, {
    clientId: record.clientId,
    expiresAtMs: Date.now() + GRANT_MAX_AGE_MS,
    resource: record.resource,
    revoked: false,
    scope: record.scope,
  });
}

// Each refresh token works once. A reuse in the grace window fails; a later
// reuse revokes the whole grant.
function refresh(form, clientId) {
  const refreshToken = form.get("refresh_token");
  if (!refreshToken) {
    return tokenError("invalid_request", "The refresh_token is required.");
  }
  const invalid = () =>
    tokenError("invalid_grant", "The refresh token is not valid.");
  if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return invalid();
  const token = refreshTokens.get(refreshToken);
  const grant = token ? readGrant(token.grantId) : undefined;
  const resource = form.get("resource");
  if (
    !token ||
    !grant ||
    grant.clientId !== clientId ||
    (resource !== null && resource !== grant.resource)
  ) {
    return invalid();
  }
  const scope = form.get("scope");
  if (scope !== null && parseScopes(scope)?.join(" ") !== grant.scope) {
    return tokenError(
      "invalid_scope",
      `Refresh keeps the granted scope: ${grant.scope}.`,
    );
  }
  if (token.usedAtMs !== undefined) {
    if (Date.now() - token.usedAtMs < REFRESH_REUSE_GRACE_MS) {
      return tokenError(
        "invalid_grant",
        "The refresh token was already rotated.",
      );
    }
    revokeGrant(token.grantId);
    return tokenError("invalid_grant", "The refresh token was already used.");
  }
  token.usedAtMs = Date.now();
  return issueTokens(token.grantId, grant);
}

async function handleToken(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return tokenError("invalid_request", "Send a form-encoded body.");
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > 8 * 1024) {
    return tokenError("invalid_request", "The request body is too large.", 413);
  }
  const form = new URLSearchParams(text);
  const clientId = form.get("client_id");
  if (!clientId) {
    return tokenError("invalid_request", "The client_id is required.");
  }
  switch (form.get("grant_type")) {
    case "authorization_code":
      return exchangeCode(form, clientId);
    case "refresh_token":
      return refresh(form, clientId);
    default:
      return tokenError(
        "unsupported_grant_type",
        "Use authorization_code or refresh_token.",
      );
  }
}

/** Return the scopes of a valid bearer token, or undefined. */
function authenticate(token) {
  if (token === FIXED_ACCESS_TOKEN) return [...MCP_SCOPES];
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return undefined;
  const record = accessTokens.get(token);
  if (!record || record.expiresAtMs <= Date.now()) return undefined;
  const grant = readGrant(record.grantId);
  if (!grant || grant.resource !== urls.resource) return undefined;
  return parseScopes(grant.scope);
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function quoteOptions(options) {
  return options.map((option) => `"${option}"`).join("|");
}

// Parse tool arguments with Zod-like messages, so errors read like the SDK's
// `Input validation error`. Unknown keys are dropped, as a Zod object does.
function argumentIssue(field, value) {
  if (field.enum) {
    return field.enum.includes(value)
      ? undefined
      : `Invalid option: expected one of ${quoteOptions(field.enum)}`;
  }
  const expected = field.type === "integer" ? "number" : field.type;
  if (typeof value !== expected) {
    return `Invalid input: expected ${expected}, received ${typeName(value)}`;
  }
  if (field.type === "integer") {
    if (!Number.isInteger(value)) {
      return "Invalid input: expected int, received number";
    }
    if (field.min !== undefined && value < field.min) {
      return `Too small: expected number to be >=${field.min}`;
    }
    if (field.max !== undefined && value > field.max) {
      return `Too big: expected number to be <=${field.max}`;
    }
  }
  if (field.type !== "string") return undefined;
  if (field.min !== undefined && value.length < field.min) {
    return `Too small: expected string to have >=${field.min} characters`;
  }
  if (field.max !== undefined && value.length > field.max) {
    return `Too big: expected string to have <=${field.max} characters`;
  }
  if (
    field.datetime &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(value)
  ) {
    return "Invalid ISO datetime";
  }
  if (field.pattern && !field.pattern.test(value)) return field.patternMessage;
  return undefined;
}

function parseArguments(fields, args) {
  const values = {};
  const issues = [];
  for (const [name, field] of Object.entries(fields)) {
    const raw = args[name];
    if (raw === undefined) {
      if (field.default !== undefined) values[name] = field.default;
      else if (!field.optional) {
        issues.push(
          field.enum
            ? `Invalid option: expected one of ${quoteOptions(field.enum)} at ${name}`
            : `Invalid input: expected ${field.type === "integer" ? "number" : field.type}, received undefined at ${name}`,
        );
      }
      continue;
    }
    const value = field.trim && typeof raw === "string" ? raw.trim() : raw;
    const issue = argumentIssue(field, value);
    if (issue) issues.push(`${issue} at ${name}`);
    else values[name] = value;
  }
  return { issues, values };
}

function inputJsonSchema(fields) {
  const properties = {};
  const required = [];
  for (const [name, field] of Object.entries(fields)) {
    const property = { type: field.enum ? "string" : field.type };
    if (field.enum) property.enum = field.enum;
    if (field.min !== undefined) {
      property[field.type === "string" ? "minLength" : "minimum"] = field.min;
    }
    if (field.max !== undefined) {
      property[field.type === "string" ? "maxLength" : "maximum"] = field.max;
    }
    if (field.datetime) property.format = "date-time";
    if (field.pattern) property.pattern = field.pattern.source;
    if (field.default !== undefined) property.default = field.default;
    if (field.description) property.description = field.description;
    properties[name] = property;
    if (!field.optional && field.default === undefined) required.push(name);
  }
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

function writeInstructions() {
  return `${agentName} is a Slack agent. These tools read and manage your ${agentName} conversations, and read your inbox items and automations. createConversation and sendMessage send a message as you, and ${agentName} works on it in the background. They return a \`cursor\`. Call getConversation with \`after\` set to the newest \`cursor\` to read the new messages. Repeat until \`status\` is not \`active\` and \`hasMore\` is not set. \`authorization\` means a turn waits for you to connect an account. To answer an inbox item, use the dashboard link in a result.`;
}

function readInstructions() {
  return `${agentName} is a Slack agent. These tools read and manage your ${agentName} conversations, and read your inbox items and automations. They cannot send a message or start agent work. To ask ${agentName} for work or to answer an inbox item, use the Slack or dashboard link in a result.`;
}

function rpcHttpError(status, code, message) {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status },
  );
}

function isRpcMessage(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return false;
  }
  if (typeof message.method === "string") return true;
  return "id" in message && ("result" in message || "error" in message);
}

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function callTool(granted, params) {
  const tool = granted.find((candidate) => candidate.name === params.name);
  if (!tool) return toolError(`Tool ${params.name} not found`);
  const args = params.arguments ?? {};
  const { issues, values } =
    args && typeof args === "object" && !Array.isArray(args)
      ? parseArguments(tool.input, args)
      : {
          issues: [
            `Invalid input: expected object, received ${typeName(args)}`,
          ],
          values: {},
        };
  if (issues.length > 0) {
    return toolError(
      `Input validation error: Invalid arguments for tool ${tool.name}: ${issues.join("\n")}`,
    );
  }
  let structured;
  try {
    structured = await tool.run(values);
  } catch (error) {
    // The SDK turns a thrown tool failure into a tool error too.
    return toolError(error instanceof Error ? error.message : String(error));
  }
  // Undefined fields drop out, as the real tools spread them in only when set.
  const structuredContent = JSON.parse(JSON.stringify(structured));
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

async function answerRpc(message, scopes) {
  const granted = mcpTools.tools.filter((tool) => scopes.includes(tool.scope));
  const result = (value) => ({ jsonrpc: "2.0", id: message.id, result: value });
  const error = (code, text) => ({
    jsonrpc: "2.0",
    id: message.id,
    error: { code, message: text },
  });
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      if (typeof params.protocolVersion !== "string") {
        return error(-32602, "Invalid params: protocolVersion is required");
      }
      return result({
        protocolVersion: INITIALIZE_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "junior", version: serverVersion },
        instructions: scopes.includes("conversations:write")
          ? writeInstructions()
          : readInstructions(),
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({
        tools: granted.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: inputJsonSchema(tool.input),
          annotations: tool.annotations,
        })),
      });
    case "tools/call":
      if (typeof params.name !== "string") {
        return error(-32602, "Invalid params: name is required");
      }
      return result(await callTool(granted, params));
    default:
      return error(-32601, "Method not found");
  }
}

/** Answer one POST like the SDK's stateless JSON Streamable HTTP transport. */
async function handleMcpRpc(request, scopes) {
  const accept = request.headers.get("accept") ?? "";
  if (
    !accept.includes("application/json") ||
    !accept.includes("text/event-stream")
  ) {
    return rpcHttpError(
      406,
      -32000,
      "Not Acceptable: Client must accept both application/json and text/event-stream",
    );
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
    return rpcHttpError(
      415,
      -32000,
      "Unsupported Media Type: Content-Type must be application/json",
    );
  }
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return rpcHttpError(400, -32700, "Parse error: Invalid JSON");
  }
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.every(isRpcMessage)) {
    return rpcHttpError(400, -32700, "Parse error: Invalid JSON-RPC message");
  }
  const initializing = messages.some(
    (message) => message.method === "initialize",
  );
  if (initializing && messages.length > 1) {
    return rpcHttpError(
      400,
      -32600,
      "Invalid Request: Only one initialization request is allowed",
    );
  }
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (
    !initializing &&
    headerVersion !== null &&
    !HEADER_VERSIONS.includes(headerVersion)
  ) {
    return rpcHttpError(
      400,
      -32000,
      `Bad Request: Unsupported protocol version: ${headerVersion} (supported versions: ${HEADER_VERSIONS.join(", ")})`,
    );
  }
  const requests = messages.filter(
    (message) => typeof message.method === "string" && "id" in message,
  );
  // Notifications and responses get no body.
  if (requests.length === 0) return new Response(null, { status: 202 });
  const responses = [];
  for (const message of requests) {
    responses.push(await answerRpc(message, scopes));
  }
  return Response.json(responses.length === 1 ? responses[0] : responses);
}

function unauthorized(sentToken) {
  const error = sentToken ? 'error="invalid_token", ' : "";
  return new Response(null, {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": `Bearer ${error}resource_metadata="${urls.resourceMetadata}", scope="${ALL_SCOPES}"`,
    },
  });
}

async function handleMcp(request) {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const scopes = token ? authenticate(token) : undefined;
  if (!scopes) return unauthorized(token !== undefined);
  // The stateless transport has no session to stream or delete.
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  return await handleMcpRpc(request, scopes);
}

// Session codes that the mock consent issued for `session_code_challenge`.
const sessionCodes = new Map();

function issueSessionCode(challenge) {
  const code = randomBytes(32).toString("base64url");
  sessionCodes.set(code, { challenge, expiresAtMs: Date.now() + CODE_TTL_MS });
  return code;
}

async function handleIosSignInToken(request) {
  const form = new URLSearchParams(await request.text());
  const record = sessionCodes.get(form.get("code") ?? "");
  sessionCodes.delete(form.get("code") ?? "");
  const verifier = form.get("code_verifier") ?? "";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  if (
    !record ||
    record.expiresAtMs <= Date.now() ||
    record.challenge !== challenge
  ) {
    return Response.json(
      { error: "invalid_grant", error_description: "The code is not valid." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  // The mock dashboard accepts every request, so any token works.
  return Response.json(
    {
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      token: `jr_ses_${randomBytes(32).toString("base64url")}`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// The paths that the mock answers itself, and their methods. The built
// dashboard app answers every other path.
const MOCK_ROUTES = {
  [RESOURCE_METADATA_PATH]: {
    methods: ["GET"],
    handle: () => Response.json(protectedResourceMetadata()),
  },
  [AUTHORIZATION_SERVER_METADATA_PATH]: {
    methods: ["GET"],
    handle: () => Response.json(authorizationServerMetadata()),
  },
  [AUTHORIZE_PATH]: { methods: ["GET"], handle: handleAuthorize },
  [TOKEN_PATH]: { methods: ["POST"], handle: handleToken },
  [MCP_PATH]: { methods: ["GET", "POST", "DELETE"], handle: handleMcp },
  "/api/ios/sign-in/token": { methods: ["POST"], handle: handleIosSignInToken },
  "/api/ios/sign-out": {
    methods: ["POST"],
    handle: () => new Response(null, { status: 204 }),
  },
};

/** Answer an MCP, OAuth, or iOS session path, or return undefined for the dashboard. */
function routeMcp(request) {
  const { pathname } = new URL(request.url);
  if (!Object.hasOwn(MOCK_ROUTES, pathname)) return undefined;
  const route = MOCK_ROUTES[pathname];
  return route.methods.includes(request.method)
    ? route.handle(request)
    : new Response("404 Not Found", { status: 404 });
}

createServer((req, res) => {
  // UI tests call this before each journey so earlier writes do not leak.
  if (req.method === "POST" && req.url === "/__reset") {
    resetMockDashboardState();
    mcpTools.reset();
    res.statusCode = 204;
    res.end();
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(new URL(req.url ?? "/", baseURL), {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
  void Promise.resolve(routeMcp(request) ?? app.fetch(request))
    .then(async (response) => {
      res.statusCode = response.status;
      for (const [name, value] of response.headers) res.setHeader(name, value);
      res.end(Buffer.from(await response.arrayBuffer()));
    })
    .catch((error) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.stack : String(error));
    });
}).listen(port, "127.0.0.1", () => {
  console.log(`Junior mock dashboard and MCP server on ${baseURL}`);
});
