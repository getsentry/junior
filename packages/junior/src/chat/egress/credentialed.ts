import { logInfo, logWarn } from "@/chat/logging";
import { onPluginEgressResponse } from "@/chat/plugins/credential-hooks";
import { matchesSandboxEgressDomain } from "@/chat/sandbox/egress/policy";
import {
  hasSandboxEgressLeaseTransformForHost,
  sandboxEgressCredentialLease,
  SandboxEgressCredentialError,
  selectSandboxEgressGrant,
  type SandboxEgressGrantSelection,
} from "@/chat/sandbox/egress/credentials";
import {
  clearSandboxEgressCredentialLease,
  SANDBOX_EGRESS_PROXY_PATH,
  setSandboxEgressAuthRequiredSignal,
  setSandboxEgressPermissionDeniedSignal,
  type SandboxEgressCredentialContext,
  type SandboxEgressCredentialLease,
} from "@/chat/sandbox/egress/session";
import {
  shouldPropagateSandboxEgressTrace,
  type SandboxEgressTracePropagationConfig,
} from "@/chat/sandbox/egress/tracing";
import {
  EgressAuthRequired,
  EgressPolicyDenied,
} from "@sentry/junior-plugin-api";

// Module overview: own credentialed provider forwarding after a caller has
// authenticated the request source and resolved its provider.
//
// `proxy.ts` first proves that the request came from the expected Vercel
// Sandbox VM and reconstructs the upstream URL from Vercel forwarding headers.
// This module starts after that point: it chooses the provider grant, obtains
// credential header transforms, forwards the upstream request, and records the
// auth/permission signal that the sandbox command runner consumes afterward.
//
// Keep this file about the provider request itself. Source authentication and
// forwarded-header parsing belong to callers such as the sandbox proxy; lease
// persistence and auth/permission signal storage stay in their caller-specific
// adapters until a second host/plugin caller needs a different storage surface.

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
  "vercel-sandbox-oidc-token",
  "vercel-forwarded-host",
  "vercel-forwarded-scheme",
  "vercel-forwarded-port",
  "vercel-forwarded-path",
]);
const TRACE_PROPAGATION_HEADERS = new Set([
  "baggage",
  "sentry-trace",
  "traceparent",
]);
const DECODED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
]);
const UPSTREAM_TOKEN_REJECTION_STATUS = 401;
const UPSTREAM_PERMISSION_REJECTION_STATUS = 403;
const GRANT_SELECTION_BODY_TEXT_LIMIT_BYTES = 64 * 1024;
const RESPONSE_BODY_TEXT_LIMIT_BYTES = 64 * 1024;

/**
 * Intercepts the already-authenticated provider request before live forwarding.
 *
 * Tests use this to inspect the exact upstream request after grant selection
 * and credential header injection, without weakening the proxy verification
 * path that runs before this hook is reached.
 */
export type CredentialedEgressHttpInterceptor = (input: {
  provider: string;
  request: Request;
  upstreamUrl: URL;
}) => Promise<Response | undefined>;

/** Runtime dependencies for the credentialed provider forwarding step. */
export interface CredentialedEgressDeps {
  clearCredentialLease?: (
    provider: string,
    grantName: string,
    credentialContext: SandboxEgressCredentialContext,
  ) => Promise<void>;
  fetch?: typeof fetch;
  issueCredentialLease?: (
    provider: string,
    selection: SandboxEgressGrantSelection,
    credentialContext: SandboxEgressCredentialContext,
  ) => Promise<SandboxEgressCredentialLease>;
  interceptHttp?: CredentialedEgressHttpInterceptor;
  recordAuthRequired?: (input: {
    authorization?: SandboxEgressCredentialLease["authorization"];
    credentialContext: SandboxEgressCredentialContext;
    grant: SandboxEgressCredentialLease["grant"];
    kind?: "auth_required" | "unavailable";
    message: string;
    provider: string;
  }) => Promise<void>;
  recordPermissionDenied?: (input: {
    credentialContext: SandboxEgressCredentialContext;
    lease: SandboxEgressCredentialLease;
    message: string;
    provider: string;
    upstream: Response;
    upstreamUrl: URL;
  }) => Promise<void>;
  tracePropagation?: SandboxEgressTracePropagationConfig;
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

function policyDeniedResponse(error: EgressPolicyDenied): Response {
  return Response.json(
    { error: error.message },
    {
      status: 403,
      headers: {
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

function isEgressAuthRequired(error: unknown): error is EgressAuthRequired {
  return (
    error instanceof EgressAuthRequired ||
    (error instanceof Error && error.name === "EgressAuthRequired")
  );
}

function isEgressPolicyDenied(error: unknown): error is EgressPolicyDenied {
  return (
    error instanceof EgressPolicyDenied ||
    (error instanceof Error && error.name === "EgressPolicyDenied")
  );
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

function isGrantSelectionBodyVisible(input: {
  provider: string;
  upstreamUrl: URL;
}): boolean {
  return (
    input.provider === "github" &&
    input.upstreamUrl.hostname.toLowerCase() === "api.github.com" &&
    input.upstreamUrl.pathname.toLowerCase().endsWith("/graphql")
  );
}

function grantSelectionBodyText(input: {
  body: ArrayBuffer | undefined;
  operation?: string;
  provider: string;
  request: Request;
  upstreamUrl: URL;
}): string | undefined {
  if (input.body === undefined) {
    return undefined;
  }
  if (input.body.byteLength > GRANT_SELECTION_BODY_TEXT_LIMIT_BYTES) {
    if (
      !input.operation &&
      input.provider === "github" &&
      input.request.method.toUpperCase() === "POST" &&
      input.upstreamUrl.hostname.toLowerCase() === "api.github.com" &&
      input.upstreamUrl.pathname.toLowerCase().endsWith("/graphql")
    ) {
      throw new EgressPolicyDenied(
        "GitHub GraphQL request body is too large for Junior to inspect before issuing credentials.",
      );
    }
    return undefined;
  }
  return new TextDecoder().decode(input.body);
}

function responseContentLength(upstream: Response): number | undefined {
  const raw = upstream.headers.get("content-length");
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function responseTextWithinLimit(
  upstream: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const limit = Math.min(
    Math.max(0, Math.floor(maxBytes)),
    RESPONSE_BODY_TEXT_LIMIT_BYTES,
  );
  if (limit <= 0) {
    return undefined;
  }
  const contentLength = responseContentLength(upstream);
  if (contentLength !== undefined && contentLength > limit) {
    return undefined;
  }
  let clone: Response;
  try {
    clone = upstream.clone();
  } catch {
    return undefined;
  }
  const body = clone.body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Build the upstream request headers.
 *
 * Sandbox/proxy-only headers are stripped so they cannot leak to providers, and
 * trace headers are preserved only for hosts opted into trace propagation.
 * Credential lease transforms win last because they are the host-issued
 * authority for provider auth headers.
 */
function requestHeaders(
  request: Request,
  lease: SandboxEgressCredentialLease,
  upstreamHost: string,
  tracePropagation: SandboxEgressTracePropagationConfig,
): Headers {
  const headers = new Headers();
  const mayPropagateTrace = shouldPropagateSandboxEgressTrace(
    upstreamHost,
    tracePropagation,
  );
  request.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      PROXY_ONLY_HEADERS.has(normalized)
    ) {
      return;
    }
    if (TRACE_PROPAGATION_HEADERS.has(normalized) && !mayPropagateTrace) {
      return;
    }
    headers.append(key, value);
  });

  for (const transform of lease.headerTransforms) {
    if (!matchesSandboxEgressDomain(upstreamHost, transform.domain)) {
      continue;
    }
    for (const [key, value] of Object.entries(transform.headers)) {
      if (
        TRACE_PROPAGATION_HEADERS.has(key.toLowerCase()) &&
        !mayPropagateTrace
      ) {
        continue;
      }
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

function leaseLogAttributes(input: {
  egressId: string;
  lease: SandboxEgressCredentialLease;
  provider: string;
  request: Request;
  status: number;
  upstream?: Response;
  upstreamUrl: URL;
}): Record<string, unknown> {
  return {
    ...egressAttributes({
      egressId: input.egressId,
      grantAccess: input.lease.grant.access,
      grantName: input.lease.grant.name,
      grantReason: input.lease.grant.reason,
      host: input.upstreamUrl.hostname,
      method: input.request.method,
      path: input.upstreamUrl.pathname,
      provider: input.provider,
      status: input.status,
    }),
    ...routingAttributes(input.request, input.upstreamUrl),
    ...(input.upstream
      ? upstreamPermissionAttributes(input.provider, input.upstream)
      : {}),
  };
}

async function recordSandboxAuthRequired(input: {
  authorization?: SandboxEgressCredentialLease["authorization"];
  credentialContext: SandboxEgressCredentialContext;
  grant: SandboxEgressCredentialLease["grant"];
  kind?: "auth_required" | "unavailable";
  message: string;
  provider: string;
}): Promise<void> {
  await setSandboxEgressAuthRequiredSignal(input.credentialContext, {
    provider: input.provider,
    grant: input.grant,
    kind: input.kind ?? "auth_required",
    ...(input.authorization ? { authorization: input.authorization } : {}),
    message: input.message,
  });
}

async function recordSandboxPermissionDenied(input: {
  credentialContext: SandboxEgressCredentialContext;
  lease: SandboxEgressCredentialLease;
  message: string;
  provider: string;
  upstream: Response;
  upstreamUrl: URL;
}): Promise<void> {
  await setSandboxEgressPermissionDeniedSignal(input.credentialContext, {
    provider: input.provider,
    grant: input.lease.grant,
    ...(input.lease.account ? { account: input.lease.account } : {}),
    message: input.message,
    source: "upstream",
    status: input.upstream.status,
    upstreamHost: input.upstreamUrl.hostname,
    upstreamPath: displayedUpstreamPath(input.upstreamUrl),
    ...(input.provider === "github"
      ? githubPermissionHeaders(input.upstream)
      : {}),
  });
}

/**
 * Forward one verified sandbox egress request with host-managed credentials.
 *
 * The caller must already have authenticated the sandbox VM, checked the signed
 * credential context, and resolved the provider for `upstreamUrl`. This function
 * then selects the read/write grant, issues or reuses a short-lived credential
 * lease, applies its header transforms, and maps provider auth failures into
 * command-level signals instead of throwing raw upstream details at the agent.
 */
export async function executeCredentialedEgressRequest(input: {
  activeEgressId: string;
  credentialContext: SandboxEgressCredentialContext;
  deps: CredentialedEgressDeps;
  operation?: string;
  provider: string;
  request: Request;
  upstreamUrl: URL;
}): Promise<Response> {
  const {
    activeEgressId,
    credentialContext,
    deps,
    operation,
    provider,
    request,
    upstreamUrl,
  } = input;
  const bodyForGrantSelection = isGrantSelectionBodyVisible({
    provider,
    upstreamUrl,
  })
    ? await requestBodyBytes(request)
    : undefined;
  let grantSelection: SandboxEgressGrantSelection;
  try {
    grantSelection = await selectSandboxEgressGrant({
      bodyText: grantSelectionBodyText({
        body: bodyForGrantSelection,
        ...(operation ? { operation } : {}),
        provider,
        request,
        upstreamUrl,
      }),
      ...(operation ? { operation } : {}),
      provider,
      method: request.method,
      upstreamUrl,
    });
  } catch (error) {
    if (isEgressPolicyDenied(error)) {
      logWarn(
        "sandbox_egress_policy_denied",
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
        error.message,
      );
      return policyDeniedResponse(error);
    }
    throw error;
  }
  const issueCredentialLease =
    deps.issueCredentialLease ?? sandboxEgressCredentialLease;
  const clearCredentialLease =
    deps.clearCredentialLease ?? clearSandboxEgressCredentialLease;
  const recordAuthRequired =
    deps.recordAuthRequired ?? recordSandboxAuthRequired;
  const recordPermissionDenied =
    deps.recordPermissionDenied ?? recordSandboxPermissionDenied;

  let lease: SandboxEgressCredentialLease;
  try {
    lease = await issueCredentialLease(
      provider,
      grantSelection,
      credentialContext,
    );
  } catch (error) {
    if (error instanceof SandboxEgressCredentialError) {
      await recordAuthRequired({
        credentialContext,
        provider: error.provider,
        grant: error.grant,
        kind: error.kind,
        authorization: error.authorization,
        message: error.message,
      });
      const isAuthRequired = error.kind === "auth_required";
      logWarn(
        isAuthRequired
          ? "sandbox_egress_credential_needed"
          : "sandbox_egress_credential_unavailable",
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
        isAuthRequired
          ? "Sandbox egress grant needs user authorization before issuing a credential lease"
          : "Sandbox egress credential lease is unavailable for selected grant",
      );
      return authRequiredResponse({
        provider: error.provider,
        grant: error.grant,
        message: error.message,
      });
    }
    throw error;
  }

  const attributes = (status: number, upstream?: Response) =>
    leaseLogAttributes({
      egressId: activeEgressId,
      lease,
      provider,
      request,
      status,
      ...(upstream ? { upstream } : {}),
      upstreamUrl,
    });

  if (!hasSandboxEgressLeaseTransformForHost(lease, upstreamUrl.hostname)) {
    logWarn(
      "sandbox_egress_transform_missing",
      {},
      {
        ...attributes(403),
        "app.sandbox.egress.transform_domains": lease.headerTransforms.map(
          (transform) => transform.domain,
        ),
      },
      "Sandbox egress credential lease does not cover forwarded host",
    );
    return Response.json(
      { error: "Credential lease does not cover forwarded host" },
      { status: 403 },
    );
  }

  const fetchImpl = deps.fetch ?? fetch;
  const headers = requestHeaders(
    request,
    lease,
    upstreamUrl.hostname,
    deps.tracePropagation ?? {},
  );
  const body = bodyForGrantSelection ?? (await requestBodyBytes(request));
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
  try {
    const effects = await onPluginEgressResponse({
      provider,
      grant: lease.grant,
      method: request.method,
      ...(operation ? { operation } : {}),
      upstreamUrl,
      response: {
        headers: new Headers(upstream.headers),
        readText: async (maxBytes) =>
          await responseTextWithinLimit(upstream, maxBytes),
        status: upstream.status,
      },
    });
    if (effects.permissionDenied) {
      await recordPermissionDenied({
        credentialContext,
        provider,
        lease,
        message: effects.permissionDenied.message,
        upstream,
        upstreamUrl,
      });
      logWarn(
        "sandbox_egress_upstream_permission_classified",
        {},
        {
          ...attributes(upstream.status, upstream),
        },
        "Sandbox egress plugin classified upstream response as permission denied",
      );
    }
  } catch (error) {
    if (!isEgressAuthRequired(error)) {
      throw error;
    }
    await clearCredentialLease(provider, lease.grant.name, credentialContext);
    await recordAuthRequired({
      credentialContext,
      provider,
      grant: lease.grant,
      authorization: error.authorization ?? lease.authorization,
      message: error.message,
    });
    logWarn(
      "sandbox_egress_upstream_auth_required_classified",
      {},
      {
        ...attributes(upstream.status, upstream),
      },
      "Sandbox egress plugin classified upstream response as auth required",
    );
    await upstream.body?.cancel().catch(() => undefined);
    return authRequiredResponse({
      provider,
      grant: lease.grant,
      message: error.message,
    });
  }
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
        ...attributes(upstream.status, upstream),
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
        ...attributes(upstream.status, upstream),
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
      await clearCredentialLease(provider, lease.grant.name, credentialContext);
      await recordAuthRequired({
        credentialContext,
        provider,
        grant: lease.grant,
        authorization: lease.authorization,
        message: `Provider rejected the injected ${provider} credential.`,
      });
      await upstream.body?.cancel().catch(() => undefined);
      return authRequiredResponse({
        provider,
        grant: lease.grant,
        message: `Provider rejected the injected ${provider} credential.\n`,
      });
    } else {
      await clearCredentialLease(provider, lease.grant.name, credentialContext);
      await recordPermissionDenied({
        credentialContext,
        provider,
        lease,
        message: permissionDeniedMessage(provider, lease.grant),
        upstream,
        upstreamUrl,
      });
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}
