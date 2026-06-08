import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { logInfo, logWarn } from "@/chat/logging";
import {
  matchesSandboxEgressDomain,
  resolveSandboxEgressProviderForHost,
} from "@/chat/sandbox/egress-policy";
import {
  authorizationForSandboxEgressGrant,
  hasSandboxEgressLeaseTransformForHost,
  sandboxEgressCredentialLease,
  SandboxEgressCredentialNeededError,
  selectSandboxEgressGrant,
} from "@/chat/sandbox/egress-credentials";
import { verifyVercelSandboxOidcToken } from "@/chat/sandbox/egress-oidc";
import {
  clearSandboxEgressCredentialLease,
  parseSandboxEgressCredentialToken,
  SANDBOX_EGRESS_PROXY_PATH,
  setSandboxEgressAuthRequiredSignal,
  setSandboxEgressPermissionDeniedSignal,
  type SandboxEgressCredentialLease,
} from "@/chat/sandbox/egress-session";
import type { JWTPayload } from "jose";

const OIDC_TOKEN_HEADER = "vercel-sandbox-oidc-token";
const FORWARDED_HOST_HEADER = "vercel-forwarded-host";
const FORWARDED_SCHEME_HEADER = "vercel-forwarded-scheme";
const FORWARDED_PORT_HEADER = "vercel-forwarded-port";
const FORWARDED_PATH_HEADER = "vercel-forwarded-path";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const PROXY_ONLY_HEADERS = new Set([
  OIDC_TOKEN_HEADER,
  FORWARDED_HOST_HEADER,
  FORWARDED_SCHEME_HEADER,
  FORWARDED_PORT_HEADER,
  FORWARDED_PATH_HEADER,
]);
const DECODED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
]);
const UPSTREAM_TOKEN_REJECTION_STATUS = 401;
const UPSTREAM_PERMISSION_REJECTION_STATUS = 403;

/** Intercepts a credential-injected sandbox HTTP request before live forwarding. */
export type SandboxEgressHttpInterceptor = (input: {
  provider: string;
  request: Request;
  upstreamUrl: URL;
}) => Promise<Response | undefined>;

interface ProxyDeps {
  fetch?: typeof fetch;
  interceptHttp?: SandboxEgressHttpInterceptor;
  verifyOidc?: (token: string) => Promise<JWTPayload>;
}

type UpstreamUrlResult = { ok: true; url: URL } | { ok: false; error: string };
type UpstreamPathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function authRequiredResponse(input: {
  grant: Pick<SandboxEgressCredentialLease["grant"], "access" | "name">;
  message: string;
  provider: string;
}): Response {
  return new Response(
    `junior-auth-required provider=${input.provider} grant=${input.grant.name} access=${input.grant.access} 401 unauthorized\n${input.message}`,
    {
      status: 401,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function shouldLogSandboxEgressInfo(): boolean {
  const environment = (
    process.env.SENTRY_ENVIRONMENT ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    ""
  )
    .trim()
    .toLowerCase();
  return environment !== "production";
}

function egressAttributes(input: {
  egressId?: string;
  grantAccess?: "read" | "write";
  grantName?: string;
  grantReason?: string;
  host?: string;
  method?: string;
  path?: string;
  provider?: string;
  status?: number;
}): Record<string, unknown> {
  return {
    ...(input.egressId ? { "app.sandbox.egress_id": input.egressId } : {}),
    ...(input.provider ? { "app.provider.name": input.provider } : {}),
    ...(input.grantName ? { "app.grant.name": input.grantName } : {}),
    ...(input.grantAccess ? { "app.grant.access": input.grantAccess } : {}),
    ...(input.grantReason ? { "app.grant.reason": input.grantReason } : {}),
    ...(input.host ? { "server.address": input.host } : {}),
    ...(input.method ? { "http.request.method": input.method } : {}),
    ...(input.path ? { "url.path": input.path } : {}),
    ...(input.status ? { "http.response.status_code": input.status } : {}),
  };
}

function credentialTokenFromRequest(request: Request): string | undefined {
  const pathname = new URL(request.url).pathname;
  const prefix = `${SANDBOX_EGRESS_PROXY_PATH}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const token = pathname.slice(prefix.length).split("/")[0];
  if (!token) {
    return undefined;
  }
  try {
    return decodeURIComponent(token);
  } catch {
    return undefined;
  }
}

function redactedProxyPath(pathname: string): string {
  if (pathname.startsWith(`${SANDBOX_EGRESS_PROXY_PATH}/`)) {
    return `${SANDBOX_EGRESS_PROXY_PATH}/<token>`;
  }
  return pathname;
}

function routingAttributes(
  request: Request,
  upstreamUrl?: URL,
): Record<string, unknown> {
  const proxyUrl = new URL(request.url);
  const attributes: Record<string, unknown> = {
    "app.sandbox.egress.proxy_path": redactedProxyPath(proxyUrl.pathname),
  };
  if (upstreamUrl) {
    attributes["app.sandbox.egress.upstream_path"] = upstreamUrl.pathname;
    const gitService = upstreamUrl.searchParams.get("service");
    if (
      upstreamUrl.hostname.toLowerCase() === "github.com" &&
      (gitService === "git-upload-pack" || gitService === "git-receive-pack")
    ) {
      attributes["app.sandbox.egress.git_service"] = gitService;
    }
  }
  return attributes;
}

function displayedUpstreamPath(upstreamUrl: URL): string {
  const gitService = upstreamUrl.searchParams.get("service");
  if (
    upstreamUrl.hostname.toLowerCase() === "github.com" &&
    (gitService === "git-upload-pack" || gitService === "git-receive-pack")
  ) {
    return `${upstreamUrl.pathname}?service=${gitService}`;
  }
  return upstreamUrl.pathname;
}

function upstreamPermissionAttributes(
  provider: string,
  upstream: Response,
): Record<string, unknown> {
  if (provider !== "github") {
    return {};
  }
  return {
    "app.github.accepted_permissions":
      upstream.headers.get("x-accepted-github-permissions") ?? undefined,
    "app.github.sso": upstream.headers.get("x-github-sso") ?? undefined,
  };
}

function githubPermissionHeaders(upstream: Response): {
  acceptedPermissions?: string;
  sso?: string;
} {
  const acceptedPermissions = upstream.headers.get(
    "x-accepted-github-permissions",
  );
  const sso = upstream.headers.get("x-github-sso");
  return {
    ...(acceptedPermissions ? { acceptedPermissions } : {}),
    ...(sso ? { sso } : {}),
  };
}

function permissionDeniedMessage(
  provider: string,
  grant: SandboxEgressCredentialLease["grant"],
): string {
  return `${provider} returned HTTP 403 after Junior injected the ${grant.name} grant. Junior forwarded the request; this is not a local runtime block.`;
}

function logSandboxEgressUpstreamRequest(input: {
  egressId: string;
  grantAccess?: "read" | "write";
  grantName: string;
  grantReason?: string;
  provider: string;
  request: Request;
  upstream: Response;
  upstreamUrl: URL;
}): void {
  if (!shouldLogSandboxEgressInfo()) {
    return;
  }

  logInfo(
    "sandbox_egress_upstream_request",
    {},
    {
      ...egressAttributes({
        egressId: input.egressId,
        grantAccess: input.grantAccess,
        grantName: input.grantName,
        grantReason: input.grantReason,
        host: input.upstreamUrl.hostname,
        method: input.request.method,
        path: input.upstreamUrl.pathname,
        provider: input.provider,
        status: input.upstream.status,
      }),
      ...routingAttributes(input.request, input.upstreamUrl),
      "app.sandbox.egress.upstream_ok": input.upstream.ok,
    },
    `Sandbox egress ${input.request.method} ${input.upstreamUrl.hostname}${displayedUpstreamPath(input.upstreamUrl)} -> ${input.upstream.status}`,
  );
}

function normalizeHost(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes(":")
  ) {
    return undefined;
  }
  return trimmed.replace(/\.$/, "");
}

function normalizeScheme(value: string): "https" | undefined {
  return value.trim().toLowerCase() === "https" ? "https" : undefined;
}

function normalizePort(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) {
    return undefined;
  }
  const port = Number.parseInt(trimmed, 10);
  return port >= 1 && port <= 65_535 ? trimmed : undefined;
}

function sandboxIdFromPayload(payload: JWTPayload): string | undefined {
  return typeof payload.sandbox_id === "string"
    ? payload.sandbox_id
    : undefined;
}

function normalizedForwardedPath(path: string): UpstreamPathResult {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("#") ||
    /[\r\n]/.test(path)
  ) {
    return { ok: false, error: "Invalid forwarded path" };
  }
  try {
    const url = new URL(path, "https://sandbox-forwarded.local");
    return { ok: true, path: `${url.pathname}${url.search}` };
  } catch {
    return { ok: false, error: "Invalid forwarded path" };
  }
}

function upstreamPath(request: Request): UpstreamPathResult {
  const forwardedPath = request.headers.get(FORWARDED_PATH_HEADER);
  if (!forwardedPath?.trim()) {
    return { ok: false, error: "Missing forwarded path" };
  }

  // Vercel may normalize request.url; this header carries the original target.
  return normalizedForwardedPath(forwardedPath.trim());
}

function buildUpstreamUrl(request: Request): UpstreamUrlResult {
  const forwardedHost = request.headers.get(FORWARDED_HOST_HEADER);
  if (!forwardedHost?.trim()) {
    return { ok: false, error: "Missing forwarded host" };
  }
  const host = normalizeHost(forwardedHost);
  if (!host) {
    return { ok: false, error: "Invalid forwarded host" };
  }
  const forwardedScheme = request.headers.get(FORWARDED_SCHEME_HEADER);
  if (!forwardedScheme?.trim()) {
    return { ok: false, error: "Missing forwarded scheme" };
  }
  const scheme = normalizeScheme(forwardedScheme);
  if (!scheme) {
    return { ok: false, error: "Forwarded scheme must be https" };
  }
  const forwardedPort = request.headers.get(FORWARDED_PORT_HEADER);
  const port = normalizePort(forwardedPort);
  if (forwardedPort && !port) {
    return { ok: false, error: "Invalid forwarded port" };
  }
  const path = upstreamPath(request);
  if (!path.ok) {
    return { ok: false, error: path.error };
  }
  try {
    const url = new URL(
      `${scheme}://${host}${port ? `:${port}` : ""}${path.path}`,
    );
    return { ok: true, url };
  } catch {
    return { ok: false, error: "Invalid forwarded URL" };
  }
}

async function requestBodyBytes(
  request: Request,
): Promise<ArrayBuffer | undefined> {
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.body === null
  ) {
    return undefined;
  }
  return await request.arrayBuffer();
}

function requestHeaders(
  request: Request,
  lease: SandboxEgressCredentialLease,
  upstreamHost: string,
): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      PROXY_ONLY_HEADERS.has(normalized)
    ) {
      return;
    }
    headers.append(key, value);
  });

  for (const transform of lease.headerTransforms) {
    if (!matchesSandboxEgressDomain(upstreamHost, transform.domain)) {
      continue;
    }
    for (const [key, value] of Object.entries(transform.headers)) {
      headers.set(key, value);
    }
  }
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(normalized) &&
      !DECODED_RESPONSE_HEADERS.has(normalized)
    ) {
      headers.append(key, value);
    }
  });
  return headers;
}

/** Return whether a request appears to be from the Vercel Sandbox egress proxy. */
export function isSandboxEgressForwardedRequest(request: Request): boolean {
  return Boolean(
    request.headers.get(OIDC_TOKEN_HEADER)?.trim() &&
    request.headers.get(FORWARDED_HOST_HEADER)?.trim() &&
    request.headers.get(FORWARDED_SCHEME_HEADER)?.trim(),
  );
}

/** Proxy one Vercel Sandbox firewall egress request through lazy credential headers. */
export async function proxySandboxEgressRequest(
  request: Request,
  deps: ProxyDeps = {},
): Promise<Response> {
  const oidcToken = request.headers.get(OIDC_TOKEN_HEADER)?.trim();
  if (!oidcToken) {
    return jsonError("Missing Vercel Sandbox OIDC token", 401);
  }

  let oidcPayload: JWTPayload;
  try {
    oidcPayload = await (deps.verifyOidc ?? verifyVercelSandboxOidcToken)(
      oidcToken,
    );
  } catch (error) {
    logWarn(
      "sandbox_egress_oidc_verification_failed",
      {},
      {
        "app.sandbox.oidc_error":
          error instanceof Error ? error.message : String(error),
      },
      "Sandbox egress OIDC verification failed",
    );
    return jsonError("Invalid Vercel Sandbox OIDC token", 401);
  }

  const activeEgressId = sandboxIdFromPayload(oidcPayload);
  if (!activeEgressId) {
    logWarn(
      "sandbox_egress_oidc_session_missing",
      {},
      {
        "http.request.method": request.method,
        "url.path": redactedProxyPath(new URL(request.url).pathname),
      },
      "Sandbox egress OIDC payload did not include a VM session id",
    );
    return jsonError(
      "Vercel Sandbox OIDC token did not include sandbox_id",
      401,
    );
  }

  const upstreamResult = buildUpstreamUrl(request);
  if (!upstreamResult.ok) {
    logWarn(
      "sandbox_egress_upstream_url_invalid",
      {},
      {
        ...egressAttributes({
          egressId: activeEgressId,
          method: request.method,
          path: redactedProxyPath(new URL(request.url).pathname),
          status: 400,
        }),
        ...routingAttributes(request),
      },
      "Sandbox egress forwarded request had invalid upstream routing headers",
    );
    return jsonError(upstreamResult.error, 400);
  }
  const upstreamUrl = upstreamResult.url;

  const provider = resolveSandboxEgressProviderForHost(upstreamUrl.hostname);
  if (!provider) {
    logWarn(
      "sandbox_egress_provider_unresolved",
      {},
      {
        ...egressAttributes({
          egressId: activeEgressId,
          host: upstreamUrl.hostname,
          method: request.method,
          path: upstreamUrl.pathname,
          status: 403,
        }),
        ...routingAttributes(request, upstreamUrl),
      },
      "Sandbox egress forwarded host is not owned by any credential provider",
    );
    return jsonError("No provider owns forwarded host", 403);
  }

  // Vercel OIDC authenticates the forwarded VM session; Junior's signed
  // credential context identifies which provider credentials may be issued
  // lazily for that session.
  const credentialContext = parseSandboxEgressCredentialToken(
    credentialTokenFromRequest(request),
  );
  if (!credentialContext || credentialContext.egressId !== activeEgressId) {
    logWarn(
      "sandbox_egress_credential_context_unauthorized",
      {},
      {
        ...egressAttributes({
          egressId: activeEgressId,
          host: upstreamUrl.hostname,
          method: request.method,
          path: upstreamUrl.pathname,
          provider,
          status: 403,
        }),
        ...routingAttributes(request, upstreamUrl),
      },
      "Sandbox egress request did not include a valid credential context for the VM session",
    );
    return jsonError(
      "Sandbox egress credential context is not authorized",
      403,
    );
  }

  const grantSelection = await selectSandboxEgressGrant({
    provider,
    method: request.method,
    upstreamUrl,
  });

  let lease: SandboxEgressCredentialLease;
  try {
    lease = await sandboxEgressCredentialLease(
      provider,
      grantSelection,
      credentialContext,
    );
  } catch (error) {
    if (error instanceof SandboxEgressCredentialNeededError) {
      await setSandboxEgressAuthRequiredSignal(credentialContext, {
        provider: error.provider,
        grant: error.grant,
        ...(error.authorization ? { authorization: error.authorization } : {}),
        message: error.message,
      });
      logWarn(
        "sandbox_egress_credential_needed",
        {},
        {
          ...egressAttributes({
            egressId: activeEgressId,
            grantAccess: error.grant.access,
            grantName: error.grant.name,
            grantReason: error.grant.reason,
            host: upstreamUrl.hostname,
            method: request.method,
            path: upstreamUrl.pathname,
            provider: error.provider,
            status: 401,
          }),
          ...routingAttributes(request, upstreamUrl),
        },
        "Sandbox egress grant needs user authorization before issuing a credential lease",
      );
      return authRequiredResponse({
        provider: error.provider,
        grant: error.grant,
        message: error.message,
      });
    }
    if (error instanceof CredentialUnavailableError) {
      const failedGrant = grantSelection.grant;
      const authorization = authorizationForSandboxEgressGrant(
        error.provider,
        grantSelection,
      );
      await setSandboxEgressAuthRequiredSignal(credentialContext, {
        provider: error.provider,
        grant: failedGrant,
        ...(authorization ? { authorization } : {}),
        message: error.message,
      });
      logWarn(
        "sandbox_egress_credential_unavailable",
        {},
        {
          ...egressAttributes({
            egressId: activeEgressId,
            grantAccess: failedGrant.access,
            grantName: failedGrant.name,
            grantReason: failedGrant.reason,
            host: upstreamUrl.hostname,
            method: request.method,
            path: upstreamUrl.pathname,
            provider,
            status: 401,
          }),
          ...routingAttributes(request, upstreamUrl),
        },
        "Sandbox egress credential lease is unavailable for selected grant",
      );
      return authRequiredResponse({
        provider: error.provider,
        grant: failedGrant,
        message: error.message,
      });
    }
    throw error;
  }

  if (!hasSandboxEgressLeaseTransformForHost(lease, upstreamUrl.hostname)) {
    logWarn(
      "sandbox_egress_transform_missing",
      {},
      {
        ...egressAttributes({
          egressId: activeEgressId,
          grantAccess: lease.grant.access,
          grantName: lease.grant.name,
          grantReason: lease.grant.reason,
          host: upstreamUrl.hostname,
          method: request.method,
          path: upstreamUrl.pathname,
          provider,
          status: 403,
        }),
        "app.sandbox.egress.transform_domains": lease.headerTransforms.map(
          (transform) => transform.domain,
        ),
        ...routingAttributes(request, upstreamUrl),
      },
      "Sandbox egress credential lease does not cover forwarded host",
    );
    return jsonError("Credential lease does not cover forwarded host", 403);
  }

  const fetchImpl = deps.fetch ?? fetch;
  const headers = requestHeaders(request, lease, upstreamUrl.hostname);
  const body = await requestBodyBytes(request);
  const intercepted = await deps.interceptHttp?.({
    provider,
    request: new Request(upstreamUrl, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    }),
    upstreamUrl,
  });
  if (intercepted) {
    return intercepted;
  }

  const upstream = await fetchImpl(upstreamUrl, {
    method: request.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    redirect: "manual",
  });
  logSandboxEgressUpstreamRequest({
    egressId: activeEgressId,
    grantAccess: lease.grant.access,
    grantName: lease.grant.name,
    grantReason: lease.grant.reason,
    provider,
    request,
    upstream,
    upstreamUrl,
  });
  if (upstream.status >= 400) {
    logWarn(
      "sandbox_egress_upstream_error_response",
      {},
      {
        ...egressAttributes({
          egressId: activeEgressId,
          grantAccess: lease.grant.access,
          grantName: lease.grant.name,
          grantReason: lease.grant.reason,
          host: upstreamUrl.hostname,
          method: request.method,
          path: upstreamUrl.pathname,
          provider,
          status: upstream.status,
        }),
        ...routingAttributes(request, upstreamUrl),
        ...upstreamPermissionAttributes(provider, upstream),
        "error.type": `http_${upstream.status}`,
      },
      `Sandbox egress upstream returned HTTP ${upstream.status}`,
    );
  }
  if (
    upstream.status === UPSTREAM_TOKEN_REJECTION_STATUS ||
    upstream.status === UPSTREAM_PERMISSION_REJECTION_STATUS
  ) {
    logWarn(
      "sandbox_egress_upstream_auth_rejected",
      {},
      {
        ...egressAttributes({
          egressId: activeEgressId,
          grantAccess: lease.grant.access,
          grantName: lease.grant.name,
          grantReason: lease.grant.reason,
          host: upstreamUrl.hostname,
          method: request.method,
          path: upstreamUrl.pathname,
          provider,
          status: upstream.status,
        }),
        ...routingAttributes(request, upstreamUrl),
        ...upstreamPermissionAttributes(provider, upstream),
        ...(upstream.status === UPSTREAM_TOKEN_REJECTION_STATUS
          ? {
              "app.sandbox.egress.www_authenticate":
                upstream.headers.get("www-authenticate") ?? undefined,
            }
          : {}),
      },
      upstream.status === UPSTREAM_TOKEN_REJECTION_STATUS
        ? "Sandbox egress upstream auth rejected injected credential"
        : "Sandbox egress upstream permission denied",
    );
    if (upstream.status === UPSTREAM_TOKEN_REJECTION_STATUS) {
      await clearSandboxEgressCredentialLease(
        provider,
        lease.grant.name,
        credentialContext,
      );
      await setSandboxEgressAuthRequiredSignal(credentialContext, {
        provider,
        grant: lease.grant,
        ...(lease.authorization ? { authorization: lease.authorization } : {}),
        message: `Provider rejected the injected ${provider} credential.`,
      });
      await upstream.body?.cancel().catch(() => undefined);
      return authRequiredResponse({
        provider,
        grant: lease.grant,
        message: `Provider rejected the injected ${provider} credential.\n`,
      });
    } else {
      await clearSandboxEgressCredentialLease(
        provider,
        lease.grant.name,
        credentialContext,
      );
      await setSandboxEgressPermissionDeniedSignal(credentialContext, {
        provider,
        grant: lease.grant,
        ...(lease.account ? { account: lease.account } : {}),
        message: permissionDeniedMessage(provider, lease.grant),
        source: "upstream",
        status: UPSTREAM_PERMISSION_REJECTION_STATUS,
        upstreamHost: upstreamUrl.hostname,
        upstreamPath: displayedUpstreamPath(upstreamUrl),
        ...(provider === "github" ? githubPermissionHeaders(upstream) : {}),
      });
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}
